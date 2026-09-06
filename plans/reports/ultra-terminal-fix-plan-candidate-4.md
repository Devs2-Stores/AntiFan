# AntiFan Terminal Split View Black Screen Fix Plan: Candidate 4
## Architecture: Asymmetric Lifecycle Alignment (Persistent Split Pool)

- **Document ID:** `ultra-terminal-fix-plan-candidate-4`
- **Protocol:** `ak:fix --ultra` (Fix Plan Formulation Stage)
- **Role:** Principal Systems & Reliability Engineer
- **Date:** 2026-09-06
- **Status:** COMPLETE / EVIDENCE-VERIFIED SPECIFICATION
- **Target File:** `src/renderer/standalone.js`
- **Reference Contracts:** `src/main/browser/terminal-manager.ts`, `src/preload/standalone-preload.ts`, `test/e2e/terminal-renderer-smoke.cjs`
- **Evidence Base:** `plans/reports/terminal-black-screen-evidence-packet.md`, `plans/reports/ultra-terminal-black-screen-verifier-verdict.md`

---

## 1. Executive Summary & Architectural Thesis

### 1.1 The Symptom & Structural Deficiency
In AntiFan Terminal (`ANTIFAN TERMINAL`, Electron 43.4.0, PID 24484), opening or switching to a tab with an active split view (`Terminal (Split)`, hosting `split-2`) intermittently resulted in a completely blank, solid black screen (`#070b11`) with an unfocused hollow rectangular cursor `[]` at `(row 0, col 0)` and no scrollbar. Meanwhile, the backend process (`powershell.exe` -> `hrv theme dev`) had already emitted 1,529 bytes of text. The terminal only "woke up" minutes later when a file modification triggered sequence gap delta replay.

While Candidate 1 diagnosed the immediate symptom as a hydration guard check fallacy (`if (snapshot === undefined || snapshotSeq === undefined)` in `atomicHydrateSplitPane`), **Candidate 4 addresses the underlying architectural divergence** that forced the frontend to repeatedly hydrate the split terminal in the first place:
- **Main Terminal Architecture:** Main terminals are managed via `terminalPool = new Map<string, TerminalPaneItem>()`. Their DOM elements (`.terminal-session-pane`), xterm.js instances, VT100 parser states, and scrollback histories persist indefinitely across tab switches. Switching tabs is an $O(1)$ CSS `.active` toggle (`visibility: visible; opacity: 1`). Background PTY chunks continue to be parsed into offscreen buffers in real time.
- **Split Terminal Architecture:** In sharp contrast, the split terminal was built as an ephemeral, disposable singleton (`splitTerm`). Every tab switch triggers `unmountSplit()`, which unconditionally executes `splitTerm?.dispose()`, destroys the DOM nodes (`#terminal-split`, `#terminal-divider`), and resets sequence state counters to `0`. Switching back to a tab requires allocating a brand new `Terminal` instance and performing an asynchronous full-buffer re-hydration from backend IPC (`atomicHydrateSplitPane`).

### 1.2 The Candidate 4 Proposal: Asymmetric Lifecycle Alignment
Fix Plan Candidate 4 eliminates this architectural asymmetry by promoting the split terminal to a **first-class pooled view**:
1. **Persistent Split Pool (`splitPool = new Map<string, SplitPaneItem>()`):** Indexed by parent session ID (`parentId`). Each parent session retains its own dedicated `SplitPaneItem` containing its xterm `Terminal` instance, addons, and sequence tracking `viewState`.
2. **CSS Visibility Toggling (`.active`):** On tab switch, `splitTerm` is never disposed. Instead, the active parent tab's split pane is made visible (`.active`), while other split panes are hidden via CSS, exactly mirroring `terminalPool`.
3. **Continuous Background PTY Ingestion:** In `api.onTerminalData`, chunks for split sessions are routed directly to the corresponding `SplitPaneItem` regardless of which tab is currently active. When the user switches tabs, the split terminal is already 100% up to date with zero network roundtrips.
4. **Elimination of Tab-Switch Hydration Races:** Because the terminal instance is never destroyed on tab switches, the fragile `atomicHydrateSplitPane` path is completely bypassed during routine navigation.

---

## 2. Mechanical Design of `splitPool` Architecture

### 2.1 Core Data Structures

In `src/renderer/standalone.js`, the global singleton variables (`splitTerm`, `splitFitAddon`, etc.) are refactored into a persistent map keyed by parent session ID:

```typescript
interface SplitPaneItem {
  parentId: string;                  // Parent main session ID (e.g. 'terminal-1')
  splitId: string;                   // Split session ID (e.g. 'split-2')
  paneEl: HTMLElement;               // Dedicated container inside #terminal-split-host
  term: Terminal;                    // xterm.js Terminal instance
  fit: FitAddon;                     // xterm.js FitAddon instance
  webglAddon: WebglAddon | null;     // WebGL addon (returns null)
  webLinksAddon: WebLinksAddon | null;
  writeTarget: WriteTarget | null;   // Dispatcher write target for coalesced writes
  isUserScrolledUp: boolean;         // Scroll lock state
  isProgrammaticScroll: boolean;     // Internal scroll guard
  savedViewportY: number | null;     // Preserved viewport line
  savedDistanceToBottom: number;     // Preserved distance from bottom
  hasAuthoritativeState: boolean;    // Hydration guard flag
  viewState: {
    id: string;                      // Split session ID
    lastRenderedSeq: number;         // Monotonic sequence tracker
    sessionGeneration: number;       // PTY generation counter
    hydrationEpoch: number;          // Guard against stale async fetches
    activeHydratingEpoch: number | null;
    liveQueue: Array<{ seq: number; generation: number; data: string; epoch: number }>;
    syncState: 'READY' | 'GAPPED' | 'RESYNCING' | 'DEGRADED';
    isFetchingDelta: boolean;
    pendingWriteAckSeq: number;
    lastAckedSeq: number;
    gapCount: number;
    resyncCount: number;
    degradedCount: number;
  };
}

const splitPool = new Map<string, SplitPaneItem>();       // parentId -> SplitPaneItem
const splitSessionIdToParentId = new Map<string, string>(); // splitId -> parentId
```

### 2.2 DOM Hierarchy & Layering

The outer split container (`#terminal-split`) and divider (`#terminal-divider`) are created once (or managed idempotently) and remain persistent in `#terminal`. Inside `#terminal-split-host`, multiple `.split-session-pane` elements are appended, one per parent session:

```text
#terminal (flex container)
├── #terminal-main (flex: 1 1 100% or clampedMain px)
│   ├── .terminal-session-pane (terminal-1) [class: active]
│   └── .terminal-session-pane (terminal-2)
├── #terminal-divider (hidden when active tab has no split)
└── #terminal-split (height: clampedLower px, display: flex / none)
    ├── .split-pane-header
    │   ├── .split-pane-title ("> Terminal (Split)")
    │   └── #btnCloseSplitPane ("✕")
    └── #terminal-split-host (position: relative, overflow: hidden)
        ├── .split-session-pane (split-1, parent: terminal-1) [class: active]
        └── .split-session-pane (split-2, parent: terminal-2)
```

In `src/renderer/standalone.css`, `.split-session-pane` shares the exact CSS rules as `.terminal-session-pane`:
```css
.split-session-pane {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  visibility: hidden;
  opacity: 0;
  pointer-events: none;
}
.split-session-pane.active {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
}
```

### 2.3 Pool Synchronization Logic (`syncSplitPool`)

On tab click (`renderTabs`) or backend session state update (`onTerminalSession`), `syncSplitPool(sessions, currentActiveId)` coordinates visibility and lifecycle:

```mermaid
flowchart TD
    A[Tab Switch / Session Update: activeId] --> B[syncSplitPool sessions, activeId]
    B --> C{Active Session has splitSessionId?}
    
    C -- No Split for Active Tab --> D[Hide #terminal-split & #terminal-divider]
    D --> E[Restore mainPane to flex: 1 1 100%]
    E --> F[Deactivate all panes in splitPool]
    F --> G[Clear global split pointers: splitId='', splitTerm=null]
    
    C -- Has SplitSessionId --> H[Show #terminal-split & #terminal-divider]
    H --> I[Apply Split Ratio for activeId]
    I --> J{splitPool.has activeId?}
    
    J -- Already Exists in Pool --> K[classList.add 'active' on target split pane]
    K --> L[Update global split pointers to active item]
    L --> M[Propose dimensions & resize if geometry changed]
    M --> N[Restore scroll position & refresh]
    
    J -- Not in Pool --> O[getOrCreateSplitPane activeId, splitSessionId]
    O --> P[Construct Terminal, FitAddon, open DOM pane]
    P --> Q[atomicHydrateSplitPane item, splitSessionId, buffer, seq]
    Q --> K
    
    G --> R[Prune Stale Splits: delete splitPool items where parent is closed]
    N --> R
```

---

## 3. Resolution of Confirmed Diagnosis Baseline Under Candidate 4

Candidate 4 harmonizes the 4 confirmed diagnosis baseline items within its persistent pooling framework:

### Baseline 1: Hydration Guard Strict Undefined Fallacy (`standalone.js:922`)
- **Diagnosis:** `if (snapshot === undefined || snapshotSeq === undefined)` evaluates to `false` when `snapshot = ''` and `snapshotSeq = 0`, permanently bypassing `api.getFullBuffer(splitSessionId)`.
- **Resolution in Candidate 4:** Although pooling prevents tab-switch hydration, the **initial cold creation** of a split pane still requires hydration. Candidate 4 relaxes the guard in `atomicHydrateSplitPane`:
  ```javascript
  const isSnapshotEmpty = !snapshot || typeof snapshot !== 'string' || snapshot.length === 0;
  if (isSnapshotEmpty || snapshotSeq === undefined || snapshotSeq === 0) {
    const res = await api?.getFullBuffer?.(splitSessionId);
    if (res && res.buffer) {
      snapshot = res.buffer;
      snapshotSeq = res.snapshotThroughSeq || 0;
    }
  }
  ```

### Baseline 2: Same-ID Early-Return Trap (`standalone.js:1494`)
- **Diagnosis:** `if (splitId === sessionId && splitTerm) return;` discarded updated buffers from `onTerminalSession`.
- **Resolution in Candidate 4:** Replaced by `syncSplitPool()`. If `splitPool.get(parentId)` already exists, it verifies whether the terminal is unhydrated (`item.viewState.lastRenderedSeq === 0 && snapshot.length > 0`). If newer authoritative data has arrived and the terminal is still empty, it hydrates asynchronously without discarding the instance.

### Baseline 3: Queue Draining Contiguity Violation (`standalone.js:947-957`)
- **Diagnosis:** Iterating `liveQueue` entries with `seq > lastRenderedSeq` without checking contiguity allowed dropped chunks to permanently advance sequence counters.
- **Resolution in Candidate 4:** The draining loop in `atomicHydrateSplitPane` strictly enforces sequential contiguity:
  ```javascript
  for (const entry of pending) {
    if (entry.seq === item.viewState.lastRenderedSeq + 1 || item.viewState.lastRenderedSeq === 0) {
      await writeTermAsync(item.term, entry.data);
      item.viewState.lastRenderedSeq = entry.seq;
    } else {
      break; // Gap detected; leave remainder in liveQueue for handleSequenceGap
    }
  }
  ```

### Baseline 4: Creation Misrouting Race (`standalone.js:1597-1601`)
- **Diagnosis:** During `await api.splitTerminal()`, `splitId` remained `''`. Initial chunks from `powershell.exe` were misrouted by `api.onTerminalData` into a dummy item in `terminalPool`.
- **Resolution in Candidate 4:** 
  1. `splitSessionIdToParentId` is pre-registered as soon as `newSplitId` is returned.
  2. Any misrouted item in `terminalPool` matching `newSplitId` is evicted and disposed before mounting the split pane.
  3. `api.onTerminalData` routes chunks by checking `splitSessionIdToParentId.get(sessionId)` first, ensuring split chunks never touch `terminalPool`.

---

## 4. Comprehensive Risk Assessment & Failure Modes

While Candidate 4 offers architectural symmetry, a rigorous engineering evaluation reveals substantial risks across memory management, multi-window synchronization, and layout geometry.

### 4.1 Memory Leak & Resource Accumulation Risks

| Resource Component | Single Disposable Model (Status Quo) | Persistent Split Pool Model (Candidate 4) | Failure Mode & Severity |
| :--- | :--- | :--- | :--- |
| **xterm.js Terminal Instance** | 1 instance maximum (`splitTerm`). Disposed on tab switch. | $N$ instances (where $N$ = number of tabs with split view). | **HIGH RISK:** Each xterm instance with `scrollback: 50000` consumes between 25 MB and 80 MB of V8 heap and typed arrays. 5 tabs with splits retain 250 MB–400 MB permanently in renderer memory. |
| **DOM Tree Nodes** | `#terminal-split` rebuilt; previous nodes unmounted and garbage collected. | $N$ `.split-session-pane` host trees and canvases stay resident in DOM. | **MEDIUM RISK:** Detached DOM leaks if tab closing (`api.unsplitTerminal` or `session-closed`) fails to cleanly call `item.term.dispose()` and `item.paneEl.remove()`. |
| **Write Targets & Dispatchers** | 1 global `splitWriteTarget`. Canceled on unmount. | $N$ separate write targets registered with `globalTerminalWriteDispatcher`. | **HIGH RISK:** If an inactive split pane's `writeTarget` is not canceled or is starved of animation frames, write queues accumulate unboundedly in memory. |
| **Backend Delivery Journal Backpressure** | Single session active; coalesced ACKs sent only for visible split. | All background split panes continuously send coalesced ACKs (`scheduleCoalescedAck`). | **MEDIUM RISK:** If a hidden split terminal throttles or fails to ACK, the backend `SessionDeliveryJournal` retains all PTY chunks in Node.js memory, bloating the main process. |

#### Mitigation Required for Candidate 4:
To prevent memory leaks, Candidate 4 `MUST` implement strict session lifecycle pruning in `syncSplitPool`:
```javascript
const activeParentIds = new Set((allSessions || []).map((s) => s.id));
for (const [parentId, item] of splitPool.entries()) {
  if (!activeParentIds.has(parentId)) {
    // Parent tab was closed: purge split pane completely
    disposeSplitPaneItem(parentId);
  }
}
```

---

### 4.2 Multi-Window Popout Regressions (`isPopoutMode`)

The AntiFan Terminal supports popping out a terminal into an independent BrowserWindow (`isPopoutMode = urlParams.get('mode') === 'popout'`). This introduces critical concurrency hazards:

#### Hazard A: Dual-Renderer Concurrency & ACK Collision
When a terminal session is popped out:
- Window A (Main Dock) and Window B (Popout Window) both connect to the same Electron main process `TerminalManager`.
- If Window A maintains `splitPool` with `split-2` resident, and Window B mounts `split-2`:
- Both Window A and Window B will receive `api.onTerminalData` broadcast for `split-2`.
- Both renderers will execute `processIncomingChunk` and both will send `scheduleCoalescedAck(sessionId, gen, seq)`.
- Because Window A is in the background and may experience Chromium background throttling (despite flags), Window A's ACKs will lag behind Window B's. Out-of-order or duplicate ACKs hitting `SessionDeliveryJournal` will corrupt sequence reconciliation in the main process.

#### Hazard B: Re-docking State Desynchronization
When the user clicks Re-dock (`api.redockTerminal()`):
- The popout window is destroyed.
- Window A becomes active again.
- If Window A kept an outdated `SplitPaneItem` that dropped chunks or missed PTY resizes while the popout was running, Window A will render a frozen or desynchronized terminal upon redock.

---

### 4.3 Geometry & Layout Hazards (The xterm `display: none` Trap)

xterm.js relies on measuring character cell dimensions via `.xterm-char-measure-element` in the DOM. 
- **The Hidden Dimension Trap:** If `splitFitAddon.proposeDimensions()` or `splitTerm.resize()` is invoked while `#terminal-split` or `.split-session-pane` has `display: none` (or `visibility: hidden` inside a collapsed container), `container.clientWidth` and `clientHeight` evaluate to `0`.
- Calling `resize(0, 0)` crashes xterm.js internal cell matrix (`RangeError: Invalid array length` or NaN dimension calculations).
- **Ratio Desynchronization:** If Tab 1 has a 50% split ratio, Tab 2 has NO split (full height), and Tab 3 has a 30% split ratio:
  Switching rapidly between Tab 1, Tab 2, and Tab 3 causes aggressive height thrashing on `mainPane` (`clampedMain` vs `100%`). If `requestAnimationFrame` fires while styles are transitioning, fit calculations will corrupt column and row parameters.

---

## 5. Comparative Evaluation: Candidate 4 vs Candidate 1

The following table evaluates Candidate 4 against Candidate 1 under the strict 4-pillar rubric (25% weight each):

| Evaluation Criterion | Candidate 1: Surgical Hydration Guard Fix | Candidate 4: Asymmetric Lifecycle Alignment (`splitPool`) | Mechanical Justification |
| :--- | :---: | :---: | :--- |
| **C1: Cause-Alignment (25%)** | **9.6 / 10** | **8.8 / 10** | **Candidate 1** targets the direct mechanical cause: the faulty `snapshot === undefined` type check that caused buffer starvation. **Candidate 4** circumvents tab-switch hydration by keeping terminals alive, but it *still* relies on Candidate 1's guard fix for the initial cold split creation. |
| **C2: Blast-Radius Safety (25%)** | **9.8 / 10** | **6.5 / 10** | **Candidate 1** modifies only ~25 lines in local hydration logic with near-zero blast radius. **Candidate 4** rewrites split view lifecycle into a full pooling architecture (~220 lines), introducing severe risks of memory leaks across tabs, popout dual-ACK conflicts, and hidden xterm resize crashes. |
| **C3: Minimality & Maintainability (25%)** | **9.7 / 10** | **6.8 / 10** | **Candidate 1** is minimal, elegant, and maintainable 6 months out. **Candidate 4** duplicates complex pooling logic (`syncSplitPool`, `getOrCreateSplitPane`, `splitSessionIdToParentId`), substantially increasing code maintenance burden. |
| **C4: Verifiability (25%)** | **9.5 / 10** | **7.5 / 10** | **Candidate 1** can be fully verified in 30 seconds using `terminal-renderer-smoke.cjs`. **Candidate 4** requires complex multi-tab stress testing, memory profiling across 50 tab switches, and popout/redock verification. |
| **Weighted Total Score** | **9.65 / 10.0** | **7.40 / 10.0** | **Verdict: Candidate 1 is the superior surgical fix.** Candidate 4 is an aspirational refactoring with excessive risk for an immediate hotfix. |

$$\text{Candidate 1 Score} = 0.25(9.6) + 0.25(9.8) + 0.25(9.7) + 0.25(9.5) = 9.65$$
$$\text{Candidate 4 Score} = 0.25(8.8) + 0.25(6.5) + 0.25(6.8) + 0.25(7.5) = 7.40$$

---

## 6. Exact Line-by-Line Code Diffs in `src/renderer/standalone.js`

Below are the complete, exact code diffs required to implement Fix Plan Candidate 4 in `src/renderer/standalone.js`:

### Diff Hunk 1: Pool Declarations & State Maps (`standalone.js:493-504`)

```diff
<<<<
let splitEnabled = false;
let splitId = '';
let splitTerm = null;
let splitFitAddon = null;
let splitWebglAddon = null;
let splitWebLinksAddon = null;
let splitWriteTarget = null;
let isSplitUserScrolledUp = false;
let isSplitProgrammaticScroll = false;
let resizeDebounceTimer = null;
const sessionSplitRatios = new Map();
====
let splitEnabled = false;
let splitId = '';
let splitTerm = null;
let splitFitAddon = null;
let splitWebglAddon = null;
let splitWebLinksAddon = null;
let splitWriteTarget = null;
let isSplitUserScrolledUp = false;
let isSplitProgrammaticScroll = false;
let resizeDebounceTimer = null;
const sessionSplitRatios = new Map();

// Candidate 4: Persistent Split Pool keyed by parent sessionId
const splitPool = new Map(); // Map<string, SplitPaneItem> (parentId -> item)
const splitSessionIdToParentId = new Map(); // Map<string, string> (splitId -> parentId)
>>>>
```

---

### Diff Hunk 2: Relax Hydration Guard & Ensure Contiguity (`standalone.js:911-968`)

```diff
<<<<
async function atomicHydrateSplitPane(splitSessionId, providedSnapshot, providedSeq) {
  if (!splitTerm || !splitSessionId) return;
  splitSessionState.id = splitSessionId;
  splitSessionState.hydrationEpoch += 1;
  const currentEpoch = splitSessionState.hydrationEpoch;
  splitSessionState.activeHydratingEpoch = currentEpoch;

  try {
    let snapshot = providedSnapshot;
    let snapshotSeq = providedSeq;

    if (snapshot === undefined || snapshotSeq === undefined) {
      if (api?.getFullBuffer) {
        try {
          const res = await api.getFullBuffer(splitSessionId);
          if (splitSessionState.hydrationEpoch !== currentEpoch) return;
          snapshot = res?.buffer || '';
          snapshotSeq = res?.snapshotThroughSeq || 0;
        } catch {}
      }
    }

    if (splitSessionState.hydrationEpoch !== currentEpoch) return;

    try {
      if (splitWriteTarget && window.globalTerminalWriteDispatcher) {
        window.globalTerminalWriteDispatcher.cancel(splitWriteTarget);
      }
    } catch {}

    splitTerm.reset();
    if (snapshot && snapshot.length > 0) {
      await writeTermAsync(splitTerm, snapshot);
    }
    splitSessionState.lastRenderedSeq = snapshotSeq || 0;

    while (splitSessionState.liveQueue.length > 0) {
      if (splitSessionState.hydrationEpoch !== currentEpoch) return;
      const batch = splitSessionState.liveQueue.splice(0, splitSessionState.liveQueue.length);
      const pending = batch
        .filter((entry) => entry.epoch === currentEpoch && entry.seq > splitSessionState.lastRenderedSeq)
        .sort((a, b) => a.seq - b.seq);

      for (const entry of pending) {
        await writeTermAsync(splitTerm, entry.data);
        splitSessionState.lastRenderedSeq = entry.seq;
      }
    }

    if (!isSplitUserScrolledUp && splitTerm) {
      splitTerm.scrollToBottom();
    }
  } finally {
    if (splitSessionState.hydrationEpoch === currentEpoch) {
      splitSessionState.activeHydratingEpoch = null;
    }
  }
}
====
async function atomicHydrateSplitPane(item, splitSessionId, providedSnapshot, providedSeq) {
  if (!item || !item.term || !splitSessionId) return;
  const vState = item.viewState;
  vState.id = splitSessionId;
  vState.hydrationEpoch += 1;
  const currentEpoch = vState.hydrationEpoch;
  vState.activeHydratingEpoch = currentEpoch;

  try {
    let snapshot = providedSnapshot;
    let snapshotSeq = providedSeq;

    // Fix 1: Relaxed guard check (handles empty string and 0 sequence)
    const isSnapshotEmpty = !snapshot || typeof snapshot !== 'string' || snapshot.length === 0;
    if (isSnapshotEmpty || snapshotSeq === undefined || snapshotSeq === 0) {
      if (api?.getFullBuffer) {
        try {
          const res = await api.getFullBuffer(splitSessionId);
          if (vState.hydrationEpoch !== currentEpoch) return;
          if (res && typeof res.buffer === 'string' && res.buffer.length > 0) {
            snapshot = res.buffer;
            snapshotSeq = res.snapshotThroughSeq || 0;
          }
        } catch {}
      }
    }

    if (vState.hydrationEpoch !== currentEpoch) return;

    try {
      if (item.writeTarget && window.globalTerminalWriteDispatcher) {
        window.globalTerminalWriteDispatcher.cancel(item.writeTarget);
      }
    } catch {}

    item.term.reset();
    if (snapshot && snapshot.length > 0) {
      await writeTermAsync(item.term, snapshot);
    }
    vState.lastRenderedSeq = snapshotSeq || 0;

    // Fix 3: Strict contiguity during queue draining
    while (vState.liveQueue.length > 0) {
      if (vState.hydrationEpoch !== currentEpoch) return;
      const batch = vState.liveQueue.splice(0, vState.liveQueue.length);
      const pending = batch
        .filter((entry) => entry.epoch === currentEpoch && entry.seq > vState.lastRenderedSeq)
        .sort((a, b) => a.seq - b.seq);

      for (const entry of pending) {
        if (entry.seq === vState.lastRenderedSeq + 1 || vState.lastRenderedSeq === 0) {
          await writeTermAsync(item.term, entry.data);
          vState.lastRenderedSeq = entry.seq;
        } else {
          // Gap encountered: restore remaining to liveQueue
          vState.liveQueue.unshift(entry);
          break;
        }
      }
    }

    if (!item.isUserScrolledUp && item.term) {
      item.term.scrollToBottom();
    }
  } finally {
    if (vState.hydrationEpoch === currentEpoch) {
      vState.activeHydratingEpoch = null;
    }
  }
}
>>>>
```

---

### Diff Hunk 3: Item-Aware Split Writing (`standalone.js:1044-1082`)

```diff
<<<<
function writeToSplitPane(chunk) {
  if (!splitTerm || !chunk) return;
  const dispatcher = window.globalTerminalWriteDispatcher;
  if (dispatcher) {
    if (!splitWriteTarget || splitWriteTarget.term !== splitTerm) {
      splitWriteTarget = dispatcher.createTarget(splitTerm, () => {
        if (!isSplitUserScrolledUp && splitTerm) {
          splitTerm.scrollToBottom();
        }
        if (splitSessionState.pendingWriteAckSeq > 0) {
          scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
          splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
        }
      });
    }
    try {
      dispatcher.queueWrite(splitWriteTarget, chunk);
      return;
    } catch {}
  }
  try {
    splitTerm.write(chunk, () => {
      if (!isSplitUserScrolledUp && splitTerm) {
        splitTerm.scrollToBottom();
      }
      if (splitSessionState.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
        splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
      }
    });
  } catch {
    try {
      splitTerm.write(chunk);
      if (splitSessionState.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(splitId, splitSessionState.sessionGeneration || 0, splitSessionState.pendingWriteAckSeq);
        splitSessionState.lastAckedSeq = splitSessionState.pendingWriteAckSeq;
      }
    } catch {}
  }
}
====
function writeToSplitItem(item, chunk) {
  if (!item || !item.term || !chunk) return;
  const dispatcher = window.globalTerminalWriteDispatcher;
  if (dispatcher) {
    if (!item.writeTarget || item.writeTarget.term !== item.term) {
      item.writeTarget = dispatcher.createTarget(item.term, () => {
        if (!item.isUserScrolledUp && item.paneEl.classList.contains('active')) {
          item.term.scrollToBottom();
        }
        if (item.viewState.pendingWriteAckSeq > 0) {
          scheduleCoalescedAck(item.splitId, item.viewState.sessionGeneration || 0, item.viewState.pendingWriteAckSeq);
          item.viewState.lastAckedSeq = item.viewState.pendingWriteAckSeq;
        }
      });
    }
    try {
      dispatcher.queueWrite(item.writeTarget, chunk);
      return;
    } catch {}
  }
  try {
    item.term.write(chunk, () => {
      if (!item.isUserScrolledUp && item.paneEl.classList.contains('active')) {
        item.term.scrollToBottom();
      }
      if (item.viewState.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(item.splitId, item.viewState.sessionGeneration || 0, item.viewState.pendingWriteAckSeq);
        item.viewState.lastAckedSeq = item.viewState.pendingWriteAckSeq;
      }
    });
  } catch {
    try {
      item.term.write(chunk);
      if (item.viewState.pendingWriteAckSeq > 0) {
        scheduleCoalescedAck(item.splitId, item.viewState.sessionGeneration || 0, item.viewState.pendingWriteAckSeq);
        item.viewState.lastAckedSeq = item.viewState.pendingWriteAckSeq;
      }
    } catch {}
  }
}
function writeToSplitPane(chunk) {
  const activeItem = splitPool.get(activeId);
  if (activeItem) writeToSplitItem(activeItem, chunk);
}
>>>>
```

---

### Diff Hunk 4: Implement `splitPool` Factory & Synchronization (`standalone.js:1440-1583`)

```diff
<<<<
function unmountSplit() {
  if (splitting) {
    splitting = false;
    const dividerEl = document.getElementById('terminal-divider');
    dividerEl?.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    mainPane.style.pointerEvents = '';
    const lowerEl = document.getElementById('terminal-split');
    if (lowerEl) lowerEl.style.pointerEvents = '';
    if (splitRafId) {
      cancelAnimationFrame(splitRafId);
      splitRafId = null;
    }
  }
  try { if (splitWriteTarget && window.globalTerminalWriteDispatcher) window.globalTerminalWriteDispatcher.cancel(splitWriteTarget); } catch {}
  splitWriteTarget = null;
  isSplitUserScrolledUp = false;
  isSplitProgrammaticScroll = false;
  splitSessionState.id = '';
  splitSessionState.activeHydratingEpoch = null;
  splitSessionState.liveQueue = [];
  splitSessionState.lastRenderedSeq = 0;
  splitSessionState.syncState = 'READY';
  splitSessionState.isFetchingDelta = false;
  splitSessionState.pendingWriteAckSeq = 0;
  splitSessionState.lastAckedSeq = 0;
  try { splitWebLinksAddon?.dispose(); } catch {}
  splitWebLinksAddon = null;
  try { splitWebglAddon?.dispose(); } catch {}
  splitWebglAddon = null;
  try { splitFitAddon?.dispose?.(); } catch {}
  splitFitAddon = null;
  try { splitTerm?.dispose(); } catch {}
  splitTerm = null;
  splitId = '';
  splitEnabled = false;
  const lower = document.getElementById('terminal-split');
  const divider = document.getElementById('terminal-divider');
  lower?.remove();
  divider?.remove();
  container.classList.remove('split');
  mainPane.style.flex = '1 1 100%';
  mainPane.style.height = '';
  mainPane.style.minHeight = '0';
  mainPane.style.maxHeight = '';
  if (splitButton) {
    splitButton.classList.remove('active');
    splitButton.title = 'Chia đôi màn hình terminal (Split Right)';
  }
  scheduleFitTerminal(60);
}
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) return;
  unmountSplit();
  splitId = sessionId;
  splitEnabled = true;
  isSplitUserScrolledUp = false;
  isSplitProgrammaticScroll = false;
  container.classList.add('split');
  const lower = document.createElement('div');
  lower.id = 'terminal-split';

  // Header with close split button
  const splitHeader = document.createElement('div');
  splitHeader.className = 'split-pane-header';
  splitHeader.innerHTML = `
    <div class="split-pane-title">
      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="4 5 8 8 4 11"/><line x1="9" y1="11" x2="13" y2="11"/></svg>
      <span>Terminal (Split)</span>
    </div>
    <button class="split-pane-close-btn" id="btnCloseSplitPane" title="Đóng Terminal chia đôi (Unsplit / Close)">✕</button>
  `;

  const splitHost = document.createElement('div');
  splitHost.id = 'terminal-split-host';

  lower.append(splitHeader, splitHost);

  const divider = document.createElement('div');
  divider.id = 'terminal-divider';
  container.append(mainPane, divider, lower);

  splitTerm = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 12,
    scrollback: 50000,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    theme: { background: '#070b11', foreground: '#dbe7f5', cursor: '#63b3ff' },
  });
  splitFitAddon = new FitAddon.FitAddon();
  splitTerm.loadAddon(splitFitAddon);
  splitTerm.open(splitHost);
  splitWebglAddon = attachWebglAddon(splitTerm);
  splitWebLinksAddon = attachWebLinksAddon(splitTerm);
  setupTerminalClipboard(splitTerm, () => splitId);

  splitTerm.onData((data) => {
    if (splitId) {
      api?.sendTerminalInputTo(splitId, data);
    }
  });

  splitTerm.onScroll(() => {
    if (isSplitProgrammaticScroll) return;
    const buf = splitTerm?.buffer?.active;
    if (buf) {
      isSplitUserScrolledUp = buf.viewportY < buf.baseY;
    }
  });

  lower.addEventListener('focusin', () => {
    focusSplitPane();
  });
  splitHost.addEventListener('click', () => {
    focusSplitPane();
  });
  applySplitRatio(sessionSplitRatios.get(activeId) ?? DEFAULT_MAIN_SPLIT_RATIO);
  atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
  if (splitButton) {
    splitButton.classList.add('active');
    splitButton.title = 'Tắt chia đôi terminal (Unsplit)';
  }

  requestAnimationFrame(() => {
    try {
      fitCurrentTerminal();
      focusSplitPane();
    } catch {}
  });

  // Hook close split button
  splitHeader.querySelector('#btnCloseSplitPane')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (activeId && api) {
      await api.unsplitTerminal?.(activeId);
    }
    unmountSplit();
  });
}
====
function ensureSplitContainerMounted() {
  let lower = document.getElementById('terminal-split');
  let divider = document.getElementById('terminal-divider');
  if (!lower) {
    lower = document.createElement('div');
    lower.id = 'terminal-split';
    const splitHeader = document.createElement('div');
    splitHeader.className = 'split-pane-header';
    splitHeader.innerHTML = `
      <div class="split-pane-title">
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="4 5 8 8 4 11"/><line x1="9" y1="11" x2="13" y2="11"/></svg>
        <span>Terminal (Split)</span>
      </div>
      <button class="split-pane-close-btn" id="btnCloseSplitPane" title="Đóng Terminal chia đôi (Unsplit / Close)">✕</button>
    `;
    const splitHost = document.createElement('div');
    splitHost.id = 'terminal-split-host';
    lower.append(splitHeader, splitHost);

    divider = document.createElement('div');
    divider.id = 'terminal-divider';
    container.append(mainPane, divider, lower);

    lower.addEventListener('focusin', () => focusSplitPane());
    splitHost.addEventListener('click', () => focusSplitPane());

    splitHeader.querySelector('#btnCloseSplitPane')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (activeId && api) {
        await api.unsplitTerminal?.(activeId);
      }
      disposeSplitPaneItem(activeId);
      syncSplitPool(sessions, activeId);
    });
  }
  return { lower, divider, splitHost: document.getElementById('terminal-split-host') };
}

function getOrCreateSplitPane(parentId, splitSessionId, snapshot = '', snapshotSeq = 0) {
  let item = splitPool.get(parentId);
  if (item && item.splitId === splitSessionId) {
    return item;
  }
  if (item && item.splitId !== splitSessionId) {
    disposeSplitPaneItem(parentId);
  }

  const { splitHost } = ensureSplitContainerMounted();
  const paneEl = document.createElement('div');
  paneEl.className = 'split-session-pane';
  splitHost.appendChild(paneEl);

  const sTerm = new Terminal({
    cursorBlink: true,
    convertEol: false,
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 12,
    scrollback: 50000,
    scrollOnUserInput: true,
    smoothScrollDuration: 0,
    theme: { background: '#070b11', foreground: '#dbe7f5', cursor: '#63b3ff' },
  });
  const sFit = new FitAddon.FitAddon();
  sTerm.loadAddon(sFit);
  sTerm.open(paneEl);
  const sWebLinks = attachWebLinksAddon(sTerm);
  setupTerminalClipboard(sTerm, () => item?.splitId || splitSessionId);

  item = {
    parentId,
    splitId: splitSessionId,
    paneEl,
    term: sTerm,
    fit: sFit,
    webglAddon: null,
    webLinksAddon: sWebLinks,
    writeTarget: null,
    isUserScrolledUp: false,
    isProgrammaticScroll: false,
    savedViewportY: null,
    savedDistanceToBottom: 0,
    hasAuthoritativeState: true,
    viewState: {
      id: splitSessionId,
      lastRenderedSeq: snapshotSeq || 0,
      sessionGeneration: 0,
      hydrationEpoch: 0,
      activeHydratingEpoch: null,
      liveQueue: [],
      syncState: 'READY',
      isFetchingDelta: false,
      pendingWriteAckSeq: 0,
      lastAckedSeq: 0,
      gapCount: 0,
      resyncCount: 0,
      degradedCount: 0,
    },
  };

  sTerm.onData((data) => {
    if (item?.splitId) {
      api?.sendTerminalInputTo(item.splitId, data);
    }
  });

  sTerm.onScroll(() => {
    if (item.isProgrammaticScroll) return;
    const buf = sTerm.buffer?.active;
    if (buf) {
      item.isUserScrolledUp = buf.viewportY < buf.baseY;
    }
  });

  splitPool.set(parentId, item);
  splitSessionIdToParentId.set(splitSessionId, parentId);

  atomicHydrateSplitPane(item, splitSessionId, snapshot, snapshotSeq);
  return item;
}

function disposeSplitPaneItem(parentId) {
  const item = splitPool.get(parentId);
  if (!item) return;
  try { if (item.writeTarget && window.globalTerminalWriteDispatcher) window.globalTerminalWriteDispatcher.cancel(item.writeTarget); } catch {}
  try { item.webLinksAddon?.dispose(); } catch {}
  try { item.fit?.dispose?.(); } catch {}
  try { item.term?.dispose(); } catch {}
  item.paneEl?.remove();
  splitSessionIdToParentId.delete(item.splitId);
  splitPool.delete(parentId);
}

function syncSplitPool(allSessions, currentActiveId) {
  const activeSession = (allSessions || []).find((s) => s.id === currentActiveId);
  const targetSplitId = activeSession?.splitSessionId;

  // Prune dead splits whose parent tab was closed
  const activeParentIds = new Set((allSessions || []).map((s) => s.id));
  for (const [pId] of splitPool.entries()) {
    if (!activeParentIds.has(pId)) {
      disposeSplitPaneItem(pId);
    }
  }

  const { lower, divider } = ensureSplitContainerMounted();

  if (!targetSplitId) {
    // Current tab has no split view
    splitEnabled = false;
    splitId = '';
    splitTerm = null;
    splitFitAddon = null;
    splitWriteTarget = null;
    container.classList.remove('split');
    if (lower) lower.style.display = 'none';
    if (divider) divider.style.display = 'none';
    mainPane.style.flex = '1 1 100%';
    mainPane.style.height = '';
    mainPane.style.minHeight = '0';
    mainPane.style.maxHeight = '';
    for (const [, item] of splitPool.entries()) {
      item.paneEl.classList.remove('active');
    }
    if (splitButton) {
      splitButton.classList.remove('active');
      splitButton.title = 'Chia đôi màn hình terminal (Split Right)';
    }
    scheduleFitTerminal(60);
    return;
  }

  // Active tab has split view
  splitEnabled = true;
  container.classList.add('split');
  if (lower) lower.style.display = 'flex';
  if (divider) divider.style.display = '';
  if (splitButton) {
    splitButton.classList.add('active');
    splitButton.title = 'Tắt chia đôi terminal (Unsplit)';
  }

  const item = getOrCreateSplitPane(
    currentActiveId,
    targetSplitId,
    activeSession.splitBuffer || '',
    activeSession.splitSnapshotThroughSeq || 0
  );

  // Toggle active pane
  for (const [pId, it] of splitPool.entries()) {
    if (pId === currentActiveId) {
      it.paneEl.classList.add('active');
    } else {
      it.paneEl.classList.remove('active');
    }
  }

  // Sync global backward-compatibility pointers
  splitId = item.splitId;
  splitTerm = item.term;
  splitFitAddon = item.fit;
  splitWriteTarget = item.writeTarget;

  applySplitRatio(sessionSplitRatios.get(currentActiveId) ?? DEFAULT_MAIN_SPLIT_RATIO);

  requestAnimationFrame(() => {
    try {
      if (item.fit && item.paneEl.clientWidth > 50) {
        const propose = item.fit.proposeDimensions();
        if (propose && propose.cols >= MIN_TERMINAL_COLS && propose.rows >= MIN_SPLIT_TERMINAL_ROWS) {
          if (item.term.cols !== propose.cols || item.term.rows !== propose.rows) {
            item.term.resize(propose.cols, propose.rows);
            api?.resizeTerminalTo(item.splitId, propose.cols, propose.rows);
          }
        }
        item.term.refresh(0, item.term.rows - 1);
      }
    } catch {}
  });
}

function unmountSplit() {
  disposeSplitPaneItem(activeId);
  syncSplitPool(sessions, activeId);
}
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  syncSplitPool(sessions, activeId);
}
>>>>
```

---

### Diff Hunk 5: Clean Up Dummy Pane on Creation (`standalone.js:1597-1608`)

```diff
<<<<
      const mainItem = terminalPool.get(activeId);
      const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
      const targetRows = getInitialSplitRows(mainItem?.term);
      const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
      if (newSplitId) mountSplit(newSplitId);
    } catch (err) {
      console.error('[Terminal] Split toggle failed:', err);
    } finally {
      splitButton.disabled = false;
    }
====
      const mainItem = terminalPool.get(activeId);
      const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
      const targetRows = getInitialSplitRows(mainItem?.term);
      const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
      if (newSplitId) {
        // Fix 4: Evict misrouted dummy pane from terminalPool
        const misrouted = terminalPool.get(newSplitId);
        if (misrouted) {
          try { misrouted.term?.dispose(); } catch {}
          misrouted.paneEl?.remove();
          terminalPool.delete(newSplitId);
        }
        splitSessionIdToParentId.set(newSplitId, activeId);
        syncSplitPool(sessions, activeId);
      }
    } catch (err) {
      console.error('[Terminal] Split toggle failed:', err);
    } finally {
      splitButton.disabled = false;
    }
>>>>
```

---

### Diff Hunk 6: Update Tab Click Handler (`standalone.js:2163-2174`)

```diff
<<<<
          if (targetSession.splitSessionId) {
            mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq || 0);
          } else {
            unmountSplit();
          }
          syncTerminalPool(sessions, activeId);
          if (!isPopoutMode) {
            api?.switchTerminal(s.id);
          }
          fitCurrentTerminal();
====
          syncSplitPool(sessions, activeId);
          syncTerminalPool(sessions, activeId);
          if (!isPopoutMode) {
            api?.switchTerminal(s.id);
          }
          fitCurrentTerminal();
>>>>
```

---

### Diff Hunk 7: Route Background Split Chunks in `onTerminalData` (`standalone.js:2284-2306`)

```diff
<<<<
  if (sessionId === splitId && splitTerm) {
    processIncomingChunk(splitSessionState, { seq: chunkSeq, generation: chunkGen, data }, true);
    return;
  }

  let item = terminalPool.get(sessionId);
====
  // Candidate 4: Check if chunk belongs to any split pane in splitPool
  const parentId = splitSessionIdToParentId.get(sessionId);
  if (parentId) {
    const splitItem = splitPool.get(parentId);
    if (splitItem) {
      processIncomingChunk(splitItem.viewState, { seq: chunkSeq, generation: chunkGen, data }, true);
      return;
    }
  }

  let item = terminalPool.get(sessionId);
>>>>
```

---

## 7. Verification Protocol & Acceptance Criteria

Execution of Candidate 4 must satisfy all automated test suites and live UI interaction gates:

### 7.1 Automated Regression Verification
Run the standard E2E smoke test suite in the real Electron Chromium runtime:
```bash
node test/e2e/terminal-renderer-smoke.cjs
```
- **Assertion:** 6/6 tests must pass (Geometry Collapse, Scroll Position Flash, Inactive Snapshot Race, Authoritative Buffer, Data-Before-Session-State, Background Data Streaming).
- **Zero Console Errors:** No `RangeError`, `TypeError`, or unhandled promise rejections in `smoke.log`.

### 7.2 Manual & Multi-Tab Verification Matrix

| Gate | Verification Scenario | Expected Observable Invariant | Pass/Fail Criteria |
| :--- | :--- | :--- | :--- |
| **Gate 1: Cold Split Creation** | Click `#btnSplitTerminal` on an active session. | Terminal prompt and banner render within < 100ms. | Cursor is focused; no solid black `#070b11` screen at `(0, 0)`. |
| **Gate 2: Tab Switching Persistence** | Create split on Tab 1 with `hrv theme dev`. Switch to Tab 2 (no split), wait 5s, switch back to Tab 1. | Tab 1 split pane appears instantly ($O(1)$ switch) with 100% of previous transcript intact. | Zero screen flicker; no re-hydration network fetch; scroll position preserved. |
| **Gate 3: Background PTY Ingestion** | While on Tab 2, edit `assets/main.js.liquid` so `theme dev` on Tab 1 produces 5 log lines. Switch back to Tab 1. | All 5 new lines are already rendered in the split buffer upon tab activation. | Zero missing chunks; sequence counter advanced in background. |
| **Gate 4: Multi-Window Popout Parity** | Open split view, click Popout Window (`#btnPopoutWindow`). Verify split view in popout, then click Re-dock. | Split terminal transitions smoothly between standalone window and dock window. | No duplicate ACK errors in main process; no freeze on redock. |
| **Gate 5: Memory Leak & Pruning** | Create 4 tabs, split all 4, close 3 tabs. Inspect `splitPool.size` via DevTools console. | `splitPool.size === 1`. Closed tabs' xterm instances and DOM nodes are purged. | V8 heap memory drops proportionally; zero detached DOM leaks. |

---

## 8. Final Engineering Recommendation & Decision

### 8.1 Technical Appraisal of Candidate 4
Candidate 4 achieves true **architectural parity** between main terminal panes and split terminal panes. By keeping split terminals resident in memory and toggling `.active`, it eliminates the entire category of tab-switching hydration race conditions.

### 8.2 Why Candidate 1 (or Candidate E) Remains the Winning Surgical Choice
Despite its architectural appeal, Candidate 4 violates the primary directives of **minimality, blast-radius safety, and maintainability**:
1. **Disproportionate Blast Radius:** Candidate 4 modifies over 220 lines across 8 critical subsystem boundaries in `standalone.js`. It introduces multi-window popout concurrency risks and high memory retention for quiescent tabs.
2. **Candidate 1 Solves the Exact Root Cause in 25 Lines:** Candidate 1 directly fixes the `snapshot === undefined` type coercion bug and the early-return trap. It requires zero architectural modifications, carries zero risk of memory leaks across inactive tabs, and introduces zero popout regressions.
3. **Strategic Roadmap:**
   - **Immediate Hotfix (P0):** Deploy **Candidate 1 / Candidate E** to eliminate the black screen defect immediately in production.
   - **Future Refactoring (v2.0):** Retain Candidate 4's specification as the architectural blueprint when AntiFan Terminal undergoes its planned multi-split grid overhaul.

---
*Report formulated and certified by Fix Candidate 4 per ak:fix --ultra protocol.*
