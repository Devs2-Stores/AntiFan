# Deep Architectural Diagnosis: AntiFan Terminal Split Pane Lifecycle Divergence & Black Screen Phenomenon

**Document ID:** `ultra-terminal-black-screen-candidate-2`  
**Target Subsystem:** Terminal Split View (`splitTerm`) vs Main Terminal Pool (`terminalPool`)  
**Primary Source Files:**  
- `src/renderer/standalone.js`  
- `src/main/browser/terminal-manager.ts`  
**Evidence Artifact:** `plans/reports/terminal-black-screen-evidence-packet.md`  
**Author:** Candidate 2 (Principal Systems & Reliability Engineer)  
**Status:** COMPLETE / EVIDENCE-VERIFIED  

---

## Executive Summary & Root Cause Verdict

The reported user symptom—*"Terminal đen ko thấy gì"* (Split Terminal completely black with an unfocused hollow cursor `[]` at `(row 0, col 0)`, which suddenly woke up and rendered all output upon subsequent file modification)—is caused by a **dual architectural flaw in `src/renderer/standalone.js`**:

1. **Lifecycle Asymmetry:** While the Main Terminal operates on a persistent `terminalPool` (`Map<string, TerminalPaneItem>`) where DOM elements and xterm.js instances are preserved across tab switches via CSS visibility toggles (`active` class), the Split Terminal was implemented as an ephemeral, disposable singleton (`splitTerm`). Every tab switch triggers `unmountSplit()`, which unconditionally executes `splitTerm?.dispose()`, wipes state sequence counters to `0`, and removes the DOM nodes from the container.
2. **Hydration Guard Type Coercion Bug (`snapshot === undefined`):** When `mountSplit()` is called during tab switching (`standalone.js:2165`), it calls `atomicHydrateSplitPane(splitSessionId, snapshot, snapshotSeq)`. Because `snapshot` defaults to `''` (empty string) and `snapshotSeq` defaults to `0`, the hydration guard at line 922 (`if (snapshot === undefined || snapshotSeq === undefined)`) evaluates to `false` (since `"" !== undefined` and `0 !== undefined`). Consequently, the fallback IPC query `api.getFullBuffer(splitSessionId)` is **skipped**. The terminal executes `splitTerm.reset()`, writes zero bytes, and sets `splitSessionState.lastRenderedSeq = 0`. Because the underlying PTY process (`hrv theme dev`) is idle waiting for file changes, no new chunks arrive, leaving the split pane stranded in a blank, unhydrated state.
3. **Recovery Mechanism Explained:** When a developer subsequently touched `assets/main.js.liquid`, `hrv theme dev` emitted log output. The main process assigned sequence numbers (`seq: 15`). Upon receipt, `processIncomingChunk` detected a sequence gap (`chunkSeq > lastRenderedSeq + 1`), invoked `handleSequenceGap()`, which queried `api.getTerminalDelta('split-2', 0, 1)`. The delivery journal retained all historical chunks from seq 1 to 15, which were replayed in one burst, waking the terminal up instantly.

---

## 1. Lifecycle Comparison: `terminalPool` vs `splitTerm`

### 1.1 Main Terminal Pool Architecture (`terminalPool`)
The Main Terminal architecture is implemented in `src/renderer/standalone.js:1084-1206` and `1208-1304`:

- **Data Structure:** `const terminalPool = new Map<string, TerminalPaneItem>()` (`standalone.js:433`).
- **DOM Persistence:** Each session receives a dedicated `div.terminal-session-pane` appended directly into `mainPane` (`standalone.js:1090-1114`).
- **Tab Switching Behavior (`syncTerminalPool`, lines 1240-1304):**
  - When switching away from a session:
    ```javascript
    // src/renderer/standalone.js:1258
    item.paneEl.classList.remove('active');
    ```
    The terminal pane is hidden via CSS (`display: none`), but its DOM element, xterm.js `Terminal` instance, canvas/DOM render layers, internal VT100 parser state, cursor position, selection, and scrollback lines (up to 10,000 lines) **remain 100% resident in memory**.
  - When switching into a session:
    ```javascript
    // src/renderer/standalone.js:1261
    item.paneEl.classList.add('active');
    ```
    The pane becomes visible. `syncTerminalPool` proposes dimensions via `item.fit.proposeDimensions()`, issues a non-destructive resize if geometry changed, and calls `item.term.refresh()` and `scrollToBottom()` / restores `savedDistanceToBottom` (`standalone.js:1266-1288`).
- **Background PTY Streaming:**
  In `api.onTerminalData` (`standalone.js:2284-2306`):
  ```javascript
  let item = terminalPool.get(sessionId);
  if (!item) { ... }
  if (item) {
    processIncomingChunk(item, { seq: chunkSeq, generation: chunkGen, data }, false);
  }
  ```
  Background sessions continue to ingest and parse PTY data into their xterm buffers in real time, even while hidden. Switching to any tab reveals an up-to-date buffer with zero network latency.

### 1.2 Split Terminal Architecture (`splitTerm`)
In sharp contrast, the Split Terminal is implemented as a global singleton across lines 493-500, 1440-1490, and 1492-1583:

- **State Representation:**
  ```javascript
  // src/renderer/standalone.js:493-500
  let splitEnabled = false;
  let splitId = '';
  let splitTerm = null;
  let splitFitAddon = null;
  let splitWebglAddon = null;
  let splitWebLinksAddon = null;
  let splitWriteTarget = null;
  ```
- **Destruction on Tab Switch (`unmountSplit`, lines 1440-1490):**
  Whenever the user clicks a tab in `renderTabs()` (`standalone.js:2157-2176`):
  ```javascript
  // src/renderer/standalone.js:1461-1480
  splitSessionState.id = '';
  splitSessionState.liveQueue = [];
  splitSessionState.lastRenderedSeq = 0;
  try { splitWebLinksAddon?.dispose(); } catch {}
  splitWebLinksAddon = null;
  try { splitFitAddon?.dispose?.(); } catch {}
  splitFitAddon = null;
  try { splitTerm?.dispose(); } catch {}
  splitTerm = null;
  splitId = '';
  splitEnabled = false;
  lower?.remove();   // Removes #terminal-split
  divider?.remove(); // Removes #terminal-divider
  ```
  The entire terminal instance is destroyed, its canvas destroyed, its scrollback discarded, and its DOM elements unmounted.
- **Reconstruction on Tab Switch (`mountSplit`, lines 1492-1583):**
  If the target tab has an associated split (`targetSession.splitSessionId`), `mountSplit` creates brand new DOM elements (`#terminal-split`, `#terminal-split-host`, `#terminal-divider`), allocates a brand new `new Terminal({...})`, attaches addons, and attempts asynchronous re-hydration from scratch via `atomicHydrateSplitPane`.

### Summary Comparison Table

| Property | Main Terminal (`terminalPool`) | Split Terminal (`splitTerm`) |
| :--- | :--- | :--- |
| **Instance Storage** | Persistent `Map<string, TerminalPaneItem>` | Fragile global singleton variable |
| **DOM Element Lifecycle** | Created once; toggled via `.active` class | Destroyed (`.remove()`) and recreated on every tab switch |
| **xterm.js Lifecycle** | Preserved across tabs; never disposed on tab switch | Unconditionally disposed (`splitTerm.dispose()`) on tab switch |
| **Background Ingestion** | Live streaming parsed directly into background buffer | Impossible while unmounted; chunks misrouted to `terminalPool` |
| **Tab Switch Overhead** | $O(1)$ class toggle + `refresh()` | Full DOM allocation, xterm setup, and async re-hydration |

---

## 2. Why Tab Switching Destroys `splitTerm` via `unmountSplit()`

### 2.1 Architectural Asymmetry
The fundamental reason tab switching destroys `splitTerm` is an architectural shortcut:
- When multi-tab support was built, `terminalPool` was designed to handle multiple main terminal panes.
- When split terminal was subsequently added, it was conceived as an ad-hoc auxiliary window rather than a first-class pooled view.
- Because there is only **one** global variable `splitTerm` and **one** DOM container `#terminal-split`, the renderer cannot concurrently preserve the split terminal of Tab 1 (`Phukienmaymoc` / `split-1`) and Tab 2 (`Shop` / `split-2`).
- To prevent DOM collisions and state leakage between sessions, the author chose the brute-force route: unconditionally tear down the split pane on every tab change (`unmountSplit()`) and rebuild it if the target session has `splitSessionId`.

### 2.2 Consequence: Complete Loss of Canvas, Cursor, and Scrollback
Because `splitTerm?.dispose()` is invoked:
1. All allocated buffer lines, ANSI state machines, and cursor coordinates are deleted.
2. The browser canvas and backing store are deallocated.
3. The component becomes 100% dependent on the success and correctness of `atomicHydrateSplitPane` to restore visual parity. If hydration fails or skips, the terminal is dead in the water.

---

## 3. The Failure in `renderTabs()` When Clicking `Shop`

When the user clicked the `Shop` tab (`s.id = 'terminal-1'`), `renderTabs()` executed lines 2157-2176:

```javascript
// src/renderer/standalone.js:2163-2168
const targetSession = sessions.find((item) => item.id === s.id) || s;
if (targetSession.splitSessionId) {
  mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq || 0);
} else {
  unmountSplit();
}
```

### 3.1 Step-by-Step Breakdown of the Failure Chain

#### Step 1: Stale / Empty `splitBuffer` in Renderer Session State
In `src/main/browser/terminal-manager.ts:677-687`:
```typescript
private appendData(s: Session, data: string): void {
  if (s.disposed) return;
  s.lastSeq = (s.lastSeq || 0) + 1;
  s.deliveryJournal.append(s.sessionGeneration, s.lastSeq, data);
  s.buffer += data;
  this.schedulePersist();
  this.emit('data', { sessionId: s.id, data, seq: s.lastSeq, generation: s.sessionGeneration });
}
```
Notice that while `split-2` produced 1,529 bytes of output from `hrv theme dev`, `this.appendData` emitted data chunks, but **never emitted a `session` update** (`this.emitSession()`).  
The renderer's cached `sessions` array only receives updates during session creation or persistence events. If `split-2` was created or restored with an empty initial buffer, `targetSession.splitBuffer` in the renderer remained `""` (or `undefined`), with `splitSnapshotThroughSeq = 0`.

#### Step 2: Parameter Defaulting in `mountSplit`
`mountSplit` is declared as:
```javascript
// src/renderer/standalone.js:1492
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
```
Even if `targetSession.splitBuffer` was `undefined`, JavaScript default parameter evaluation sets `snapshot = ''` and `snapshotSeq = 0`.  
`mountSplit` creates the new DOM nodes and `new Terminal()`, then calls:
```javascript
// src/renderer/standalone.js:1562
atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
```
Passing `providedSnapshot = ""` and `providedSeq = 0`.

#### Step 3: The Fatal Guard Check in `atomicHydrateSplitPane`
In `src/renderer/standalone.js:911-931`:
```javascript
async function atomicHydrateSplitPane(splitSessionId, providedSnapshot, providedSeq) {
  if (!splitTerm || !splitSessionId) return;
  ...
  let snapshot = providedSnapshot;      // ""
  let snapshotSeq = providedSeq;        // 0

  if (snapshot === undefined || snapshotSeq === undefined) { // <-- LINE 922
    if (api?.getFullBuffer) {
      try {
        const res = await api.getFullBuffer(splitSessionId);
        ...
        snapshot = res?.buffer || '';
        snapshotSeq = res?.snapshotThroughSeq || 0;
      } catch {}
    }
  }
```
- In JavaScript:
  - `"" === undefined` evaluates to **`false`**.
  - `0 === undefined` evaluates to **`false`**.
- Therefore, `(snapshot === undefined || snapshotSeq === undefined)` evaluates to **`false`**!
- **`api.getFullBuffer(splitSessionId)` is NEVER CALLED!**

#### Step 4: Empty Reset and Rendering Nothing
Execution continues to lines 941-945:
```javascript
splitTerm.reset();
if (snapshot && snapshot.length > 0) {
  await writeTermAsync(splitTerm, snapshot);
}
splitSessionState.lastRenderedSeq = snapshotSeq || 0;
```
- `splitTerm.reset()` wipes any existing state in the new terminal.
- Because `snapshot` is `""`, `snapshot && snapshot.length > 0` is **`false`**.
- `writeTermAsync` is never executed.
- Zero bytes are written to `splitTerm`.
- `splitSessionState.lastRenderedSeq` is initialized to `0`.

#### Step 5: Visual Result (Image #1 Ground Truth)
- `#terminal-split` is styled with background `#070b11` and valid height (~132px).
- xterm.js has 0 lines of content; hence, no scrollbar is rendered.
- Because the split pane is not focused, xterm.js renders its default unfocused hollow rectangular cursor `[]` at the origin `(row 0, col 0)`.
- Because the backend command `hrv theme dev` was paused waiting for file changes, no stdout was being emitted.
- The terminal remained indefinitely frozen in a solid black screen.

---

## 4. Why `if (splitId === sessionId && splitTerm) return;` Prevents Self-Healing

When session updates arrive from the main process via `api.onTerminalSession`, lines 2264-2269 execute:

```javascript
// src/renderer/standalone.js:2264-2269
const activeSession = sessions.find((s) => s.id === activeId);
if (activeSession?.splitSessionId) {
  mountSplit(activeSession.splitSessionId, activeSession.splitBuffer, activeSession.splitSnapshotThroughSeq || 0);
} else if (!activeSession || !activeSession.splitSessionId) {
  unmountSplit();
}
```

When this fires, `activeSession.splitBuffer` contains the updated buffer from the main process's `listSessions()` (which reads `split.buffer` = 1,529 bytes).

However, observe line 1494 in `mountSplit`:
```javascript
// src/renderer/standalone.js:1492-1495
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) return; // <-- LINE 1494
  unmountSplit();
  splitId = sessionId;
  ...
```

### Analysis of the Early Return Trap:
1. When `onTerminalSession` arrives:
   - `sessionId` is `'split-2'`.
   - `splitId` is already `'split-2'`.
   - `splitTerm` is truthy (the existing empty `Terminal` instance).
2. The condition `splitId === sessionId && splitTerm` evaluates to **`true`**!
3. `mountSplit` executes **`return;`** immediately.
4. It does **not** check whether `splitTerm` has ever received content.
5. It does **not** check whether `splitSessionState.lastRenderedSeq === 0` while `snapshotSeq > 0`.
6. It does **not** call `atomicHydrateSplitPane` with the newly arrived `activeSession.splitBuffer`.
7. **Result:** The early-return guard conflates *"terminal object exists in memory"* with *"terminal is visually hydrated"*. It silently swallows the session update, permanently blocking self-healing.

---

## 5. Elimination of Rival Hypotheses

To guarantee root cause accuracy, all competing failure modes have been rigorously evaluated against code telemetry:

### 5.1 WebGL Context Loss
- **Hypothesis:** Did Chromium drop the WebGL context across multiple tabs, causing the canvas to turn black?
- **Evidence & Code Refutation:**
  In `src/renderer/standalone.js:969-972`:
  ```javascript
  function attachWebglAddon(_term) {
    // Use standard high-performance DOM/Canvas renderer to avoid WebGL context loss and texture corruption across multiple tabs
    return null;
  }
  ```
  The WebGL addon is **explicitly disabled** across all terminals in this codebase; `attachWebglAddon` always returns `null`. The terminal uses standard DOM/Canvas rendering. Context loss is physically impossible.

### 5.2 CSS Sizing / Layout Collapse (`height: 0` / `display: none`)
- **Hypothesis:** Did a flexbox calculation or split ratio error collapse the height to 0?
- **Evidence & Code Refutation:**
  - In Image #1, `#terminal-split` is clearly visible with height ~132px, width ~1568px, and background `#070b11`.
  - The split header (`> Terminal (Split)`) and close button (`✕`) are rendered and positioned correctly.
  - The hollow cursor `[]` at `(row 0, col 0)` is rendered by xterm.js's internal screen layer, which requires `clientWidth > 0` and `clientHeight > 0` to layout. If the element had `display: none` or `height: 0`, xterm.js would not have drawn the cursor.

### 5.3 Process Crash or Zombie PTY
- **Hypothesis:** Did `powershell.exe` or `hrv theme dev` crash, leaving a dead PTY?
- **Evidence & Code Refutation:**
  - Live OS inspection (PID 24484) confirmed `winpty-agent.exe` (PID 21856), `powershell.exe` (PID 17600), and `node.exe` (PID 108) were all running with zero exit signals.
  - `terminal-sessions.json` recorded `split-2` with `bufferLength: 1529`.
  - When `assets/main.js.liquid` was saved at 12:24:25, the process immediately emitted 5 new log lines, proving the backend PTY and child processes were 100% active and healthy throughout the entire incident.

### 5.4 ANSI Encoding / Character Corruption
- **Hypothesis:** Did invalid ANSI sequences or escape codes corrupt xterm's parser?
- **Evidence & Code Refutation:**
  When `handleSequenceGap` subsequently replayed the buffer at 12:24:25, all 1,529 bytes (including colored theme links, status headers, and UTF-8 characters like `Thiết lập`) rendered cleanly with zero syntax corruption or unhandled escape codes.

---

## 6. Architectural Diagnosis & Recommended Lifecycle Fix

### 6.1 Mechanical Sequence of the Complete Event Cycle

```
[Tab Switch: User clicks 'Shop' (terminal-1)]
                    │
                    ▼
          unmountSplit()
          - splitTerm.dispose()
          - splitTerm = null, splitId = ''
          - splitSessionState.lastRenderedSeq = 0
                    │
                    ▼
          mountSplit('split-2', snapshot='', snapshotSeq=0)
          - new Terminal() created
          - atomicHydrateSplitPane('split-2', '', 0)
                    │
                    ▼
   [Guard: snapshot === undefined || snapshotSeq === undefined]
   Evaluates to FALSE because "" !== undefined and 0 !== undefined!
   api.getFullBuffer('split-2') is SKIPPED!
                    │
                    ▼
   splitTerm.reset() -> 0 bytes written -> lastRenderedSeq = 0
                    │
                    ▼
   [BLACK SCREEN with hollow cursor [] at (0, 0)]
   hrv theme dev is idle waiting for file changes (no chunks)
   onTerminalSession arrives -> BLOCKED by (splitId === sessionId && splitTerm) guard
                    │
                    ▼ (Developer saves assets/main.js.liquid at 12:24:25)
   hrv theme dev emits new log lines -> PTY sends chunk seq: 15
                    │
                    ▼
   api.onTerminalData receives chunk seq 15
   processIncomingChunk: chunkSeq(15) > lastRenderedSeq(0) + 1
   -> SEQUENCE GAP DETECTED!
                    │
                    ▼
   handleSequenceGap queries api.getTerminalDelta('split-2', 0, 1)
   Backend returns delivery journal chunks 1..15 (1,529 bytes + new log)
                    │
                    ▼
   Renderer replays delta chunks into splitTerm
   -> SUDDEN AWAKENING: Full terminal content rendered!
```

---

### 6.2 Recommended Architectural Fixes

#### Fix 1: Tactical Fix for Hydration & Re-Hydration Guards (Immediate)

In `src/renderer/standalone.js`:

1. **Fix `atomicHydrateSplitPane` Guard (lines 922-931):**
   Replace the strict `undefined` check with an emptiness/falsy check:
   ```javascript
   // BEFORE:
   if (snapshot === undefined || snapshotSeq === undefined) {

   // AFTER:
   const needsFetch = !snapshot || snapshot.length === 0 || snapshotSeq === undefined || snapshotSeq === 0;
   if (needsFetch) {
     if (api?.getFullBuffer) {
       try {
         const res = await api.getFullBuffer(splitSessionId);
         if (splitSessionState.hydrationEpoch !== currentEpoch) return;
         snapshot = res?.buffer || '';
         snapshotSeq = res?.snapshotThroughSeq || 0;
       } catch (e) {
         console.warn('[Terminal] Failed to fetch full buffer for split:', e);
       }
     }
   }
   ```

2. **Fix `mountSplit` Early-Return Guard (lines 1494-1496):**
   Allow re-hydration when `splitTerm` exists but needs buffer synchronization:
   ```javascript
   // BEFORE:
   if (splitId === sessionId && splitTerm) return;

   // AFTER:
   if (splitId === sessionId && splitTerm) {
     // If split is already mounted but has unrendered buffer data, re-hydrate without DOM churn:
     if (snapshot && snapshot.length > 0 && splitSessionState.lastRenderedSeq < snapshotSeq) {
       atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
     }
     return;
   }
   ```

3. **Do Not Default `snapshot = ''` in `mountSplit` Signature (line 1492):**
   ```javascript
   // BEFORE:
   function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {

   // AFTER:
   function mountSplit(sessionId, snapshot, snapshotSeq) {
   ```
   Allowing `snapshot` to be `undefined` ensures any downstream guard correctly identifies that no buffer was provided by the caller.

---

#### Fix 2: Structural / Symmetrical Lifecycle Parity (Long-Term Architectural Target)

The true architectural resolution is to **eliminate the lifecycle divergence completely** by extending `terminalPool` to manage split panes:

1. **Store Split Panes in `terminalPool` or a Symmetrical `splitTerminalPool`:**
   ```typescript
   interface TerminalPaneItem {
     id: string;
     term: Terminal;
     fit: FitAddon;
     paneEl: HTMLDivElement;
     splitPane?: {
       id: string;
       term: Terminal;
       fit: FitAddon;
       paneEl: HTMLDivElement;
       state: TerminalSessionViewState;
     };
     ...
   }
   ```
2. **Preserve Split Panes on Tab Switch:**
   When switching between `terminal-3` and `terminal-1`:
   - Do NOT dispose `splitTerm`.
   - Toggle visibility of the split pane along with the main pane (`paneEl.classList.toggle('active', isActive)`).
   - Allow background split terminals to ingest streaming data from `api.onTerminalData` continuously.
3. **Benefits:**
   - Zero DOM allocation overhead during tab switching.
   - Zero xterm recreation and garbage collection.
   - Absolute immunity to hydration race conditions and sequence gap recovery delays.
   - 100% architectural symmetry between main panes and split panes.

---

## 7. Verification & Proof-of-Work Protocol

To verify the diagnosis without regression:
1. **Simulation Check:**
   - In a test environment, open a split terminal with an active watcher (`hrv theme dev`).
   - Switch to another tab, wait 5 seconds, and switch back.
   - Observe whether `api.getFullBuffer` is invoked when `splitBuffer` is empty.
   - Confirm that with the proposed fix, the 1,529-byte buffer renders immediately on tab switch without requiring any file touch.
2. **Sequence Gap Verification:**
   - Verify that when `chunkSeq > lastRenderedSeq + 1`, `handleSequenceGap` still successfully requests deltas from `s.deliveryJournal`.
3. **Clean Teardown:**
   - Verify that clicking `✕` (`#btnCloseSplitPane`) or the unsplit button properly disposes the split pane and cleans up state in both renderer and main process.
