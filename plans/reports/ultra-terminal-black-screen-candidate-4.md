# AntiFan Terminal Split View Black Screen Diagnosis (Candidate 4)
**Focus:** Terminal Geometry, Resizing Races, DOM Layout Timing, and xterm.js Rendering States in `src/renderer/standalone.js`  
**Target Codebase:** `src/renderer/standalone.js`, `src/main/browser/terminal-manager.ts`  
**Evidence Base:** `plans/reports/terminal-black-screen-evidence-packet.md`, Desktop Capture Telemetry (PID 24484), Windows 11 winpty / Electron 43.4.0  
**Standard of Rigor:** RFC 2119 (`MUST`, `MUST NOT`, `REQUIRED`, `SHALL`, `SHOULD`, `RECOMMENDED`). Factual claims cited to exact line numbers; deductions marked `[INFERENCE]`.

---

## 1. Executive Summary & Core Mechanical Thesis

In Image #1 of the evidence packet, the user observed a completely blank, solid black screen (`#070b11`) in `Terminal (Split)` (`#terminal-split-host`) with a solitary hollow rectangular cursor `[]` rendered at `(row 0, col 0)` and no scrollbar. Meanwhile, the backend PTY (`winpty-agent.exe` PID 21856 -> `powershell.exe` PID 17600 -> `node.exe theme dev` PID 108) was healthy and had already produced 1,529 bytes of output. Minutes later, when `assets/main.js.liquid` was saved, `hrv theme dev` produced 5 new log lines and the split terminal suddenly "woke up", displaying all previous output alongside the new lines.

Candidate 4 demonstrates that this symptom is caused by the deadly intersection of **two distinct defects**:
1. **The DOM Layout / Geometry Race Condition (`src/renderer/standalone.js:1524-1565`):**
   `splitTerm` is constructed without column/row parameters, defaulting in xterm.js to `80x24`. In `mountSplit`, `applySplitRatio(...)` defers terminal measurement and resizing to `requestAnimationFrame` (`standalone.js:1407`). Immediately and synchronously on the following line, `atomicHydrateSplitPane(...)` is invoked (`standalone.js:1562`). Consequently, hydration executes against an un-fitted `80x24` terminal instead of the physical DOM container (`~1568px × ~132px`, corresponding to `265 cols × 13 rows`).
2. **The Hydration Guard Skipping Defect (`src/renderer/standalone.js:922-931`):**
   `atomicHydrateSplitPane` guards full buffer retrieval with `if (snapshot === undefined || snapshotSeq === undefined)`. When returning to a tab or creating a split, `targetSession.splitBuffer` defaults to `""` (empty string) and `snapshotSeq` defaults to `0`. Because `"" !== undefined` and `0 !== undefined`, the condition evaluates to `false`. `api.getFullBuffer(...)` is never called. `splitTerm.reset()` wipes the terminal, nothing is written, and `splitSessionState.lastRenderedSeq` remains stranded at `0`.
3. **The Subsequent "Wake Up" via Sequence Gap Recovery (`src/renderer/standalone.js:684-692, 725-789`):**
   Because `splitSessionState.lastRenderedSeq` was stranded at `0`, the first subsequent PTY chunk (`seq = N + 1`) triggered a sequence gap in `processIncomingChunk` (`chunk.seq > viewState.lastRenderedSeq + 1`). This forced `handleSequenceGap` to invoke `api.getTerminalDelta(splitId, 0, 1)`, retrieving all historical chunks (1 through N) from the backend delivery journal and replaying them into `splitTerm`, which by then had finally been resized to 265x13.

---

## 2. Deep Dive: Core Questions & Exact Code Grounding

### Question 1: Geometry of `splitTerm` in `mountSplit` (lines 1524-1565)

#### Analysis of Execution Sequence
In `src/renderer/standalone.js:1524-1565`:
```javascript
1524:  splitTerm = new Terminal({
1525:    cursorBlink: true,
1526:    convertEol: false,
1527:    fontFamily: 'Cascadia Mono, Consolas, monospace',
1528:    fontSize: 12,
1529:    scrollback: 50000,
1530:    scrollOnUserInput: true,
1531:    smoothScrollDuration: 0,
1532:    theme: { background: '#070b11', foreground: '#dbe7f5', cursor: '#63b3ff' },
1533:  });
1534:  splitFitAddon = new FitAddon.FitAddon();
1535:  splitTerm.loadAddon(splitFitAddon);
1536:  splitTerm.open(splitHost);
...
1561:  applySplitRatio(sessionSplitRatios.get(activeId) ?? DEFAULT_MAIN_SPLIT_RATIO);
1562:  atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
```

1. **Initial Constructor Dimensions:**
   When `new Terminal(...)` is invoked without explicit `cols` or `rows` options (`standalone.js:1524-1533`), xterm.js initializes its internal state to the POSIX VT standard:
   $$\text{cols} = 80, \quad \text{rows} = 24$$
2. **`splitTerm.open(splitHost)` (`standalone.js:1536`):**
   `term.open()` creates the internal DOM structure (`.xterm`, `.xterm-screen`, `.xterm-viewport`, `.xterm-helper-textarea`) and measures character cell dimensions via `CharMeasure`. It does **not** query or fit the host container dimensions. `splitTerm.cols` remains `80` and `splitTerm.rows` remains `24`.
3. **`applySplitRatio` Deferral (`standalone.js:1381-1437`):**
   Inside `applySplitRatio`:
   ```javascript
   1397:    lower.style.flex = `0 0 ${clampedLower}px`;
   1398:    lower.style.height = `${clampedLower}px`;
   ...
   1407:  requestAnimationFrame(() => {
   ...
   1423:    if (splitFitAddon && splitTerm) {
   1424:      try {
   1425:        const splitPropose = splitFitAddon.proposeDimensions();
   1426:        if (splitPropose && splitPropose.cols >= MIN_TERMINAL_COLS && splitPropose.rows >= MIN_SPLIT_TERMINAL_ROWS) {
   1427:          if (splitTerm.cols !== splitPropose.cols || splitTerm.rows !== splitPropose.rows) {
   1428:            splitTerm.resize(splitPropose.cols, splitPropose.rows);
   1429:            if (resizePty && splitId) {
   1430:              api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
   1431:            }
   1432:          }
   1433:        }
   1434:        splitTerm.refresh(0, splitTerm.rows - 1);
   1435:      } catch {}
   1436:    }
   1437:  });
   ```
   Setting `lower.style.height` (lines 1397-1398) updates the inline style declaration, but the browser has not performed layout or style recalculation. The dimension proposal (`splitFitAddon.proposeDimensions()`) and terminal resize (`splitTerm.resize(...)`) are scheduled inside a `requestAnimationFrame` callback (line 1407).
4. **Immediate Synchronous Hydration (`standalone.js:1562`):**
   On line 1562, `atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq)` is invoked synchronously. JavaScript runs to completion on the call stack before any queued microtask or `requestAnimationFrame` callback can fire.
5. **Verdict:**
   When `atomicHydrateSplitPane` writes to `splitTerm` (lines 941-944), the geometry of `splitTerm` is **strictly `80x24`**, **not** the real DOM container size (`265x13`).

---

### Question 2: Why the Cursor Rendered as a Hollow Rectangle `[]` at `(0, 0)`

#### 1. What a Hollow Rectangle Means in xterm.js
In xterm.js (`CursorRenderModel` and `CursorLayer`), the cursor rendering state is strictly tied to terminal focus:
- **Focused State (`_isFocused === true`):** When the terminal's helper textarea (`.xterm-helper-textarea`) has browser focus, xterm.js renders a solid filled block:
  $$\text{Render Mode: } \text{fillRect}(x \times \text{cellWidth}, y \times \text{cellHeight}, \text{cellWidth}, \text{cellHeight})$$
- **Unfocused State (`_isFocused === false`):** When the terminal loses focus or has never received focus, xterm.js switches to an unfocused outline / hollow box:
  $$\text{Render Mode: } \text{strokeRect}(x \times \text{cellWidth} + 0.5, y \times \text{cellHeight} + 0.5, \text{cellWidth} - 1, \text{cellHeight} - 1)$$
The hollow rectangle `[]` in Image #1 proves definitively that `splitTerm` was in an **unfocused / blurred state**.

#### 2. Why the Cursor was at Coordinate `(0, 0)`
1. **Instantiation and Reset:**
   A new xterm instance begins at `cursorX = 0, cursorY = 0`. Furthermore, in `src/renderer/standalone.js:941`:
   ```javascript
   941:    splitTerm.reset();
   ```
   `splitTerm.reset()` clears all lines and explicitly resets the cursor to top-left home position `(0, 0)`.
2. **Zero Bytes Written:**
   Because `snapshot` was `""` (due to the `snapshot === undefined` check on line 922 evaluating to `false`), line 942 evaluated to `false`:
   ```javascript
   942:    if (snapshot && snapshot.length > 0) {
   943:      await writeTermAsync(splitTerm, snapshot);
   944:    }
   ```
   Not a single character or ANSI sequence was written into `splitTerm`. The cursor was never incremented or relocated.

#### 3. Why `splitTerm` was Unfocused
In `src/renderer/standalone.js:2157-2176` (tab click handler):
```javascript
2157:      b.onclick = () => {
2158:        if (s.id !== activeId) {
...
2164:          if (targetSession.splitSessionId) {
2165:            mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq || 0);
2166:          } else {
2167:            unmountSplit();
2168:          }
2169:          syncTerminalPool(sessions, activeId);
2170:          if (!isPopoutMode) {
2171:            api?.switchTerminal(s.id);
2172:          }
2173:          fitCurrentTerminal();
2174:        }
2175:        focusMainPane();
2176:      };
```
Even though `mountSplit` queued `focusSplitPane()` inside `requestAnimationFrame` (`standalone.js:1571`), `b.onclick` immediately executes `focusMainPane()` on line 2175.
`focusMainPane()` (`standalone.js:513-521`) calls `activeItem.term.focus()`, giving DOM focus to the main terminal. This blurs `splitTerm`, setting `splitTerm._core._isFocused = false`.
Thus, xterm.js rendered a hollow outline cursor `[]` at position `(0, 0)`.

---

### Question 3: Why There is No Scrollbar on the Right of `#terminal-split-host` in Image #1

#### xterm.js Viewport & Scrollbar Mechanics
The outer container `#terminal-split-host` has CSS `overflow: hidden`.
Scrollbar rendering is managed internally by xterm.js via `.xterm-viewport` (which has CSS `overflow-y: scroll`) and an inner spacer element `.xterm-scroll-area`:
$$\text{scrollHeight} = \text{buffer.active.lines.length} \times \text{actualCellHeight}$$
$$\text{clientHeight} = \text{term.rows} \times \text{actualCellHeight}$$

#### Evidence Analysis
1. When `splitTerm` was instantiated and wiped by `splitTerm.reset()` (`standalone.js:941`), the active buffer contained only the base screen rows (`rows = 24`, later resized to `rows = 13`).
2. Scrollback allocation only occurs when text rows are pushed off the top of the screen:
   $$\text{baseY} > 0 \iff \text{lines.length} > \text{rows}$$
3. Because zero bytes were written to `splitTerm`:
   $$\text{buffer.active.baseY} = 0, \quad \text{lines.length} = \text{term.rows}$$
   $$\implies \text{scrollHeight} = \text{clientHeight}$$
4. Under Chromium's viewport scrollbar rendering engine, when $\text{scrollHeight} \le \text{clientHeight}$, the scrollbar track has no thumb. The entire vertical strip remains completely flat and black.
5. **Deduction [INFERENCE]:** The absence of a scrollbar thumb in Image #1 is irrefutable optical proof that `splitTerm.buffer.active.baseY === 0` and no scrollback existed. If the 1,529 bytes from `split-2` (which contained over 13 lines of PowerShell banner and `hrv theme dev` logs) had been written to a 13-row pane, `baseY` would have been $\ge 1$, and a vertical scrollbar thumb would have been visibly drawn on the right edge.

---

### Question 4: Interaction of `splitFitAddon.fit()`, `splitTerm.reset()`, and Async Writes

#### 1. Method Invocation Discrepancy
`splitFitAddon.fit()` is **never** directly invoked in `standalone.js`. Instead, the codebase calls `splitFitAddon.proposeDimensions()` followed by `splitTerm.resize()` in two locations:
- `applySplitRatio` (`standalone.js:1425`) inside `requestAnimationFrame`.
- `fitCurrentTerminal` (`standalone.js:2365`) synchronously or debounced.

#### 2. The Asynchronous Timeline & Collision
Consider the timeline when `mountSplit` runs:

| Time | Action | State of `splitTerm` |
|---|---|---|
| $T_0$ | `splitTerm = new Terminal(...)` | Geometry: `80x24`. Buffer: empty. |
| $T_1$ | `splitTerm.open(splitHost)` | DOM attached to `#terminal-split-host`. Geometry remains `80x24`. |
| $T_2$ | `applySplitRatio(...)` | Styles `#terminal-split` to `clampedLower` px height. Schedules rAF callback. |
| $T_3$ | `atomicHydrateSplitPane(...)` (sync) | `splitTerm.reset()` clears buffer at **`80x24`**. Cursor at `(0, 0)`. |
| $T_4$ | `writeTermAsync(splitTerm, snapshot)` | Invokes `splitTerm.write(snapshot, cb)`. Parsing starts against **`80x24`**. |
| $T_5$ | Browser Animation Frame fires | rAF runs `proposeDimensions()` ($\to 265\times13$) and calls `splitTerm.resize(265, 13)`. |

#### 3. Collision Failure Modes
- **Row Contraction Buffer Eviction ($24 \to 13$ rows):**
  When `splitTerm.resize(265, 13)` is called at $T_5$, `term.rows` shrinks from 24 to 13. Any content parsed during $T_4$ that occupied lines 13 through 23 is immediately pushed into scrollback history (`baseY` increments). Full-screen TUI layouts or headers rendered at the bottom of the 24-row buffer vanish from the viewport.
- **Linewrap / Reflow Corruption ($80 \to 265$ cols):**
  If `snapshot` contains text formatted for 265 columns, parsing it at $T_4$ against an 80-column terminal forces xterm.js to wrap lines at column 80. When `splitTerm.resize(265, 13)` occurs at $T_5$, xterm.js attempts line reflow. However, Windows winpty/ConPTY frequently injects hard `\r\n` sequences at column boundaries. These hard breaks cannot be unwrapped, producing staggered, broken text formatting.
- **Race with Async Parser:**
  `writeTermAsync` uses `term.write(data, resolve)`. If the snapshot is large, the write takes multiple ticks. If `splitTerm.resize()` executes midway through parser consumption, the first half of the stream is parsed at 80 cols and the second half at 265 cols, creating split-brain buffer corruption.
- **The Empty-Snapshot Case (Image #1):**
  When `snapshot` was `""`:
  - `splitTerm.reset()` ran at 80x24.
  - Nothing was written.
  - rAF resized the empty buffer to 265x13.
  - Terminal stayed blank at 265x13 with cursor at `(0, 0)`.
  - `splitSessionState.lastRenderedSeq` was stranded at `0`.

---

### Question 5: Rendering/Geometry Diagnosis and Recommended Fix

#### Complete Causality Flowchart

```mermaid
flowchart TD
    A[Tab Switch / Split Mount] --> B[mountSplit sessionId, snapshot='', snapshotSeq=0]
    B --> C[splitTerm = new Terminal: Geometry defaults to 80x24]
    B --> D[applySplitRatio: lower.style.height set, rAF queued for resize]
    B --> E[atomicHydrateSplitPane sessionId, '', 0 executed synchronously]
    
    E --> F{snapshot === undefined?}
    F -- No: '' !== undefined --> G[SKIP api.getFullBuffer]
    
    G --> H[splitTerm.reset: Buffer cleared at 80x24, cursor at 0,0]
    H --> I{snapshot.length > 0?}
    I -- No: '' has length 0 --> J[Nothing written to splitTerm]
    J --> K[splitSessionState.lastRenderedSeq = 0]
    
    D -.-> L[rAF fires: splitTerm.resize 265, 13]
    L --> M[Empty buffer resized to 265x13; cursor remains at 0,0]
    
    M --> N[Image #1: Solid Black Screen, Hollow Cursor [], No Scrollbar]
    
    N --> O[User saves assets/main.js.liquid at 12:24:25]
    O --> P[Backend hrv theme dev outputs 5 log lines: appendData seq=N+1]
    P --> Q[Renderer api.onTerminalData: seq=N+1, lastRenderedSeq=0]
    Q --> R{chunk.seq > lastRenderedSeq + 1?}
    R -- Yes: N+1 > 1 --> S[handleSequenceGap detects gap fromSeq=1]
    S --> T[api.getTerminalDelta splitId, gen, 1 fetches chunks 1..N]
    T --> U[All delta chunks 1..N written to splitTerm]
    U --> V[Split Terminal suddenly WAKES UP and renders full text]
```

---

## 3. Rival Hypotheses Evaluation & Elimination

| Hypothesis | Evaluated Condition | Verdict | Mechanical Proof of Elimination |
|---|---|---|---|
| **1. WebGL Context Loss** | Did WebGL crash or lose context, causing a black canvas? | **DISPROVED** | `standalone.js:969-972` explicitly states: `attachWebglAddon(_term) { return null; }` ("Use standard high-performance DOM/Canvas renderer to avoid WebGL context loss"). The WebGL addon is completely disabled; xterm.js runs on standard DOM/Canvas rendering. |
| **2. CSS Zero Sizing (`height: 0` / `display: none`)** | Was `#terminal-split-host` collapsed by CSS? | **DISPROVED** | In Image #1, `#terminal-split` is clearly visible with height ~132px, header `> Terminal (Split)` is rendered, `#btnCloseSplitPane` is visible, and the hollow cursor `[]` is rendered inside `#terminal-split-host`. |
| **3. Process Crash / Zombie PTY** | Did the backend PTY crash or exit immediately? | **DISPROVED** | Live telemetry from PID 24484 confirmed `winpty-agent.exe` (PID 21856), `powershell.exe` (PID 17600), and `node.exe` (PID 108) were all alive and actively running `hrv theme dev`. |
| **4. Character Encoding / ANSI Corruption** | Did invalid ANSI sequences hide the text? | **DISPROVED** | When `handleSequenceGap` recovered the chunks upon file change at 12:24:25, the entire buffer rendered cleanly with full ANSI color formatting and proper line wrapping. |
| **5. Missing `ResizeObserver` on Split Pane** | Does `ResizeObserver` track `#terminal-split`? | **CONTRIBUTING FLAW** | `standalone.js:2383-2384` observes `container` and `mainPane`, but `globalResizeObserver` **never** observes `#terminal-split` or `#terminal-split-host`. Split resize depends entirely on manual rAF and `window.resize`. |

---

## 4. Recommended Architectural & Mechanical Fixes

To permanently eliminate the black screen and geometry desynchronization in `Terminal (Split)`, the following changes `MUST` be implemented:

### Fix 1: Correct the Hydration Guard in `atomicHydrateSplitPane`
**File:** `src/renderer/standalone.js:922-931`  
**Current Code:**
```javascript
if (snapshot === undefined || snapshotSeq === undefined) {
  if (api?.getFullBuffer) { ... }
}
```
**Required Fix:**
Check for empty or non-string snapshot as well as undefined sequence:
```javascript
const isSnapshotEmpty = !snapshot || typeof snapshot !== 'string' || snapshot.length === 0;
if (isSnapshotEmpty || snapshotSeq === undefined || snapshotSeq === 0) {
  if (api?.getFullBuffer) {
    try {
      const res = await api.getFullBuffer(splitSessionId);
      if (splitSessionState.hydrationEpoch !== currentEpoch) return;
      snapshot = res?.buffer || '';
      snapshotSeq = res?.snapshotThroughSeq || 0;
    } catch {}
  }
}
```

### Fix 2: Enforce Geometry Sizing Before Hydration in `mountSplit`
**File:** `src/renderer/standalone.js:1561-1563`  
**Current Code:**
```javascript
applySplitRatio(sessionSplitRatios.get(activeId) ?? DEFAULT_MAIN_SPLIT_RATIO);
atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
```
**Required Fix:**
Calculate split container layout immediately, fit the terminal synchronously to real dimensions, and only then hydrate:
```javascript
applySplitRatio(sessionSplitRatios.get(activeId) ?? DEFAULT_MAIN_SPLIT_RATIO, false);

// Measure and resize splitTerm to actual DOM dimensions BEFORE hydration
if (splitFitAddon && splitTerm) {
  try {
    const splitPropose = splitFitAddon.proposeDimensions();
    if (splitPropose && splitPropose.cols >= MIN_TERMINAL_COLS && splitPropose.rows >= MIN_SPLIT_TERMINAL_ROWS) {
      splitTerm.resize(splitPropose.cols, splitPropose.rows);
      if (splitId) {
        api?.resizeTerminalTo(splitId, splitPropose.cols, splitPropose.rows);
      }
    }
  } catch {}
}

// Hydrate into correctly dimensioned terminal
atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
```

### Fix 3: Observe `#terminal-split` in `ResizeObserver`
**File:** `src/renderer/standalone.js:1501-1523, 1477-1480`  
When `#terminal-split` is created in `mountSplit`:
```javascript
if (globalResizeObserver) {
  globalResizeObserver.observe(lower);
}
```
And in `unmountSplit`:
```javascript
const lower = document.getElementById('terminal-split');
if (lower && globalResizeObserver) {
  globalResizeObserver.unobserve(lower);
}
```

### Fix 4: Prevent Misrouting of Initial Chunks During Split Creation
**File:** `src/renderer/standalone.js:1597-1601`  
When `api.splitTerminal` is initiated, record `pendingSplitSessionId = true` so that early chunks arriving before `mountSplit` completes are buffered in `splitSessionState.liveQueue` rather than being dropped or misrouted to a dummy pane in `terminalPool`.

---

## 5. Summary Table of RFC 2119 Violations & Resolutions

| Defect | RFC 2119 Invariant Violated | Resolution |
|---|---|---|
| **Geometry Inversion** | Terminal `MUST NOT` be hydrated before its viewport dimensions match the DOM container. | Synchronously propose dimensions and resize `splitTerm` prior to calling `atomicHydrateSplitPane`. |
| **Hydration Guard** | Hydrator `MUST` fetch full buffer from backend if provided snapshot is empty (`""`). | Update condition to fetch full buffer whenever snapshot is empty or sequence is 0. |
| **Lifecycle Asymmetry** | Split terminals `SHOULD NOT` be destroyed and recreated on normal tab switches. | Transition split terminals to persistent view pool matching main terminal architecture. |
| **Observer Blindspot** | Layout observer `MUST` observe all active terminal host elements. | Register `#terminal-split` with `globalResizeObserver`. |
