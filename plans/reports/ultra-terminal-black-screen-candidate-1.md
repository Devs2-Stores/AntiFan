# Deep-Dive Root Cause Analysis: AntiFan Terminal Split-Pane Black Screen ("Terminal đen ko thấy gì")

**Candidate:** 1  
**Author Role:** Principal Systems & Reliability Engineer  
**Date:** 2026-09-06  
**Target:** Hydration Guard, Buffer Invalidation, and Stale State in `src/renderer/standalone.js` and `src/main/browser/terminal-manager.ts`  
**Artifact Path:** `plans/reports/ultra-terminal-black-screen-candidate-1.md`  

---

## 1. Executive Summary & Verdict

### The Symptom
In AntiFan Terminal (`ANTIFAN TERMINAL`, PID 24484), opening or switching to the tab `Shop` (`terminal-1` in `E:\Work\customizes\Apshop`) displayed an active, richly highlighted interactive OMP session in the main terminal pane (top), but the bottom split pane (`Terminal (Split)`, hosting `split-2`) appeared **solid black (`#070b11`) with zero rendered characters and a solitary hollow cursor `[]` stranded at row 0, column 0**. 

At the exact same moment, the backend Windows process tree (`winpty-agent.exe` PID 21856 -> `powershell.exe` PID 17600 -> `node.exe` PID 108 running `hrv theme dev`) was fully alive and had already output **1,529 bytes** of text (PowerShell header, prompt, theme links, and file watcher banner). Yet none of it was rendered in the split pane.

Later at 12:24:25, when a developer saved `assets/main.js.liquid`, `hrv theme dev` produced 5 new log lines (`12:24:25 Synced >> update assets/main.js.liquid ...`). **The split terminal suddenly woke up and displayed the entire 1,529-byte backlog alongside the new output.**

### The Core Root Cause (Verdict)
The black screen was caused by an **unhappy triad of asymmetric IPC streaming, a flawed hydration guard condition, and a disposable split-terminal lifecycle**:

1. **Hydration Guard Bypass (`standalone.js:922`):** In `atomicHydrateSplitPane`, the guard protecting the fallback fetch from backend is:
   ```javascript
   if (snapshot === undefined || snapshotSeq === undefined) {
     const res = await api.getFullBuffer(splitSessionId);
     ...
   }
   ```
   When `mountSplit` is called (either from tab switching in `renderTabs` or default arguments), it passes `snapshot = ""` (empty string) and `snapshotSeq = 0`. Because `"" !== undefined` and `0 !== undefined`, **this condition evaluates to `false`**. The call to `api.getFullBuffer(splitSessionId)` is completely bypassed. `splitTerm.reset()` wipes the terminal, `writeTermAsync` is skipped because `snapshot.length === 0`, and `splitSessionState.lastRenderedSeq` is set to `0`.
2. **Stale Renderer Buffer in `sessions` (`terminal-manager.ts:677-687`):** While the PTY is running and emitting output, `appendData(s, data)` appends data to `s.buffer` and streams chunks to subscribers via `emit('data')`, but **never emits `emitSession()`** (to avoid IPC flood). Therefore, the renderer's cached `sessions` array retains the initial stale `splitBuffer: ""` that was captured when the split session was first spawned. When returning to the tab, `mountSplit` reads `targetSession.splitBuffer` (`""`), feeding the bypassed hydration guard.
3. **Delayed Hydration via Sequence Gap Detection (`standalone.js:692`):** When `hrv theme dev` finally emitted new output at 12:24:25, the chunk arrived with sequence number `seq: N` (where $N \ge 2$). Because `splitSessionState.lastRenderedSeq` was stranded at `0`, the renderer detected a sequence gap (`chunkSeq > lastRenderedSeq + 1`). It immediately queried `api.getTerminalDelta(splitId, gen, fromSeq = 1)`. The backend's `SessionDeliveryJournal` returned all 1,529 historical bytes (`seq: 1` through `N - 1`), which were replayed sequentially into `splitTerm`, followed by chunk $N$. The terminal magically "woke up".

---

## 2. Core Question 1: Why Did `atomicHydrateSplitPane` Skip Calling `api.getFullBuffer`?

### Exact Code Walkthrough

In `src/renderer/standalone.js` (lines 911–946):
```javascript
async function atomicHydrateSplitPane(splitSessionId, providedSnapshot, providedSeq) {
  if (!splitTerm || !splitSessionId) return;
  splitSessionState.id = splitSessionId;
  splitSessionState.hydrationEpoch += 1;
  const currentEpoch = splitSessionState.hydrationEpoch;
  splitSessionState.activeHydratingEpoch = currentEpoch;

  try {
    let snapshot = providedSnapshot;
    let snapshotSeq = providedSeq;

    if (snapshot === undefined || snapshotSeq === undefined) { // <-- Line 922: THE FLAWED GUARD
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

    splitTerm.reset();                                        // <-- Line 941: Resets xterm
    if (snapshot && snapshot.length > 0) {                    // <-- Line 942: Fails for ""
      await writeTermAsync(splitTerm, snapshot);
    }
    splitSessionState.lastRenderedSeq = snapshotSeq || 0;     // <-- Line 945: Set to 0!
```

### Call Site Analysis

There are three paths into `mountSplit` and subsequently `atomicHydrateSplitPane`:

#### Path A: Tab Switch / Selection in `renderTabs` (`standalone.js:2163-2166`)
```javascript
const targetSession = sessions.find((item) => item.id === s.id) || s;
if (targetSession.splitSessionId) {
  mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq || 0);
} else {
  unmountSplit();
}
```
- `targetSession.splitSessionId` is `"split-2"`.
- `targetSession.splitBuffer` in renderer's memory is `""` (empty string) because `appendData` never called `emitSession()` [see Section 3].
- `targetSession.splitSnapshotThroughSeq || 0` evaluates to `0`.
- Values passed to `mountSplit`: `mountSplit("split-2", "", 0)`.

#### Path B: Default Parameters in `mountSplit` Declaration (`standalone.js:1492`)
```javascript
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
```
- When called from `splitButton.onclick` (`standalone.js:1601`):
  ```javascript
  const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
  if (newSplitId) mountSplit(newSplitId);
  ```
  `snapshot` defaults to `''` and `snapshotSeq` defaults to `0`.
- At line 1562, `mountSplit` delegates:
  ```javascript
  atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
  ```
  Values passed: `atomicHydrateSplitPane("split-2", "", 0)`.

#### Path C: Session Event Listener `api.onTerminalSession` (`standalone.js:2264-2266`)
```javascript
const activeSession = sessions.find((s) => s.id === activeId);
if (activeSession?.splitSessionId) {
  mountSplit(activeSession.splitSessionId, activeSession.splitBuffer, activeSession.splitSnapshotThroughSeq || 0);
}
```
Again, `activeSession.splitBuffer` is `""` and `activeSession.splitSnapshotThroughSeq || 0` is `0`.

### Truth Table of the Hydration Guard (Line 922)

| Input `snapshot` | Input `snapshotSeq` | `snapshot === undefined` | `snapshotSeq === undefined` | Condition Result (`||`) | Did it call `getFullBuffer`? |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `undefined` | `undefined` | `true` | `true` | **`true`** | **YES** |
| `undefined` | `0` | `true` | `false` | **`true`** | **YES** |
| `""` (empty string) | `0` (number) | `false` | `false` | **`false`** | **NO (SKIPPED!)** |
| `""` (empty string) | `undefined` | `false` | `true` | **`true`** | **YES** |

Because `snapshot` was `""` (type `string`) and `snapshotSeq` was `0` (type `number`), **both operands were strictly not equal to `undefined`**. 

### The Execution Chain Following the Skipped Guard
1. `api.getFullBuffer(splitSessionId)` was **never executed**.
2. `splitTerm.reset()` was called at line 941, wiping any terminal buffer to pristine empty state.
3. At line 942: `if (snapshot && snapshot.length > 0)` evaluated to `false` because `"".length === 0`.
4. `writeTermAsync(splitTerm, snapshot)` was never called.
5. At line 945: `splitSessionState.lastRenderedSeq = snapshotSeq || 0;` set `lastRenderedSeq = 0`.
6. Lines 947–958: `while (splitSessionState.liveQueue.length > 0)` found an empty queue.
7. `splitTerm` was attached to `#terminal-split-host` in the DOM with a 0-character buffer.
8. xterm.js rendered its default background (`#070b11`) and a single unfocused hollow cursor `[]` at `(row 0, col 0)`.

---

## 3. Core Question 2: Why Was `targetSession.splitBuffer` Empty or Stale in the Renderer?

### Mechanics of `appendData` vs `emitSession` in `terminal-manager.ts`

In `src/main/browser/terminal-manager.ts`:

#### How Data Streaming Actually Works (Lines 677–687)
```typescript
private appendData(s: Session, data: string): void {
  if (s.disposed) return;
  s.lastSeq = (s.lastSeq || 0) + 1;
  s.deliveryJournal.append(s.sessionGeneration, s.lastSeq, data);
  s.buffer += data;
  if (s.buffer.length > MAX_TRANSCRIPT_BYTES + 65536) {
    s.buffer = safeSliceTail(s.buffer, MAX_TRANSCRIPT_BYTES);
  }
  this.schedulePersist();
  this.emit('data', { sessionId: s.id, data, seq: s.lastSeq, generation: s.sessionGeneration });
}
```
Notice:
- `s.buffer += data` appends incoming chunks in the backend process memory (growing to 1,529 bytes).
- `s.lastSeq` increments for each chunk ($1, 2, 3, \dots, N$).
- `s.deliveryJournal.append(...)` records the chunk in the 2 MiB ring buffer.
- `this.emit('data', ...)` broadcasts the raw chunk to IPC subscribers (`api.onTerminalData`).
- `this.schedulePersist()` schedules a debounced write of `s.buffer` to `terminal-sessions.json` on disk.
- **CRITICAL:** `appendData` **DOES NOT CALL `this.emitSession()`**.

#### Why `appendData` Does Not Call `emitSession()`
Calling `this.emitSession()` on every PTY write would serialize all sessions, compute UTF-8 budgets across all panes, and push large JSON payloads across IPC at 60–120 Hz during fast command execution. To protect CPU and IPC bandwidth, `emitSession()` is intentionally reserved for macro lifecycle events.

#### When Is `emitSession()` Actually Called?
In `terminal-manager.ts`, `this.emitSession()` is called exclusively upon:
1. `spawn()` / `startTerminal()` (lines 581, 724, 730)
2. `exitSub` (child process termination, line 669)
3. `restartSession()` (line 889)
4. `newTerminal()` (line 899)
5. `splitTerminal()` (line 918)
6. `unsplitTerminal()` (line 936)
7. `closeTerminal()` (line 1159)
8. `switchTerminal()` (line 1172)
9. `renameTerminal()` (line 1188)
10. `reorderTerminals()` (line 1208)

#### The Lifecycle Timeline of `split-2`

```
Backend (TerminalManager)                                Renderer (standalone.js)
─────────────────────────────────────────────────────────────────────────────────────────────
splitTerminal("terminal-1")
  s = spawn("split-2", ...) [buffer = ""]
  emitSession() ───────────────────────────────────────> api.onTerminalSession(state)
                                                           sessions[0].splitBuffer = ""
                                                           sessions[0].splitSnapshotThroughSeq = 0
  PTY starts (PowerShell.exe)
  child.onData("Windows PowerShell...")
    appendData("split-2", chunk1) -> s.buffer (200B)
    emit('data', seq: 1) ──────────────────────────────> (Misrouted or consumed before mount)
    (NO emitSession!)
  child.onData("hrv theme dev...")
    appendData("split-2", chunk2..8) -> s.buffer (1529B)
    emit('data', seq: 2..8) ───────────────────────────> (Misrouted or unrendered)
    (NO emitSession!)

User switches to "terminal-3"
  unmountSplit() ──────────────────────────────────────> splitTerm disposed! splitTerm = null!

User switches back to "terminal-1"
  renderTabs()
    targetSession = sessions.find("terminal-1")
    targetSession.splitBuffer is STILL ""!
    targetSession.splitSnapshotThroughSeq is STILL 0!
    mountSplit("split-2", "", 0)
      atomicHydrateSplitPane("split-2", "", 0)
        Guard checks ("" === undefined || 0 === undefined) -> FALSE!
        api.getFullBuffer is SKIPPED!
        splitTerm.reset()
        Terminal is BLACK with [] cursor at (0, 0)!
```

### The Initial Creation Race Condition (`standalone.js:1597-1601`)
A secondary flaw reinforces the bug during the initial creation of the split pane:
```javascript
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) mountSplit(newSplitId);
```
1. `api.splitTerminal` spawns `winpty-agent.exe` on the main process.
2. Winpty immediately outputs the PowerShell banner (`seq: 1`).
3. In `standalone.js:2284`, `api.onTerminalData` receives the chunk:
   ```javascript
   if (sessionId === splitId && splitTerm) {
     processIncomingChunk(splitSessionState, ...);
     return;
   }
   let item = terminalPool.get(sessionId);
   if (!item) {
     item = getOrCreateTerminalPane(sessionId, '', 0, false);
   }
   processIncomingChunk(item, ...);
   ```
4. While `await api.splitTerminal` is pending, `splitId` in the renderer is still empty string `""`.
5. Because `sessionId !== splitId`, the initial prompt chunks are misrouted into `getOrCreateTerminalPane("split-2", ...)`, creating a phantom pane inside `terminalPool`.
6. When `mountSplit(newSplitId)` finally runs, it creates a new `splitTerm`. Because `atomicHydrateSplitPane` skips `getFullBuffer`, `splitTerm` never gets the initial chunks.

---

## 4. Core Question 3: Why Did the Terminal Suddenly Wake Up at 12:24:25?

### The Sequence Gap Recovery Mechanism

When the developer saved `assets/main.js.liquid`, `hrv theme dev` detected the file modification and printed 5 log lines:
```text
12:24:25 Synced >> update assets/main.js.liquid ...
```

Here is the exact step-by-step mechanical trace of what happened:

```
                  ┌──────────────────────────────────────────────┐
                  │ 1. hrv theme dev emits output at 12:24:25   │
                  │    Backend appendData: seq = 9, gen = 1      │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼ IPC 'terminal:data'
                  ┌──────────────────────────────────────────────┐
                  │ 2. standalone.js:2289 api.onTerminalData     │
                  │    sessionId === splitId ("split-2")         │
                  │    Calls processIncomingChunk(               │
                  │      splitSessionState, { seq: 9 }, true)    │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 3. processIncomingChunk (standalone.js:684)  │
                  │    viewState.lastRenderedSeq = 0             │
                  │    chunkSeq = 9                              │
                  │    Condition: 9 === 0 + 1 (false)            │
                  │    Condition: 0 === 0 && 9 === 1 (false)     │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 4. Sequence Gap Detected! (standalone.js:692)│
                  │    chunkSeq (9) > lastRenderedSeq (0) + 1    │
                  │    Calls handleSequenceGap(...)              │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 5. handleSequenceGap (standalone.js:722-725) │
                  │    fromSeq = lastRenderedSeq + 1 = 1         │
                  │    Calls api.getTerminalDelta("split-2",1,1) │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼ IPC 'terminal:delta'
                  ┌──────────────────────────────────────────────┐
                  │ 6. terminal-manager.ts:1093                  │
                  │    deliveryJournal.getDelta(gen=1, fromSeq=1)│
                  │    Returns chunks 1..8 (1,529 bytes total)   │
                  │    status: 'OK', throughSeq: 8               │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼ IPC response
                  ┌──────────────────────────────────────────────┐
                  │ 7. handleSequenceGap (standalone.js:757-789) │
                  │    status === 'OK'                           │
                  │    Replays chunks 1..8 -> writeToSplitPane   │
                  │    lastRenderedSeq advances 0 -> 8           │
                  │    Drains liveQueue (chunk 9)                │
                  │    lastRenderedSeq advances 8 -> 9           │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                  ┌──────────────────────────────────────────────┐
                  │ 8. VISUAL RESULT:                            │
                  │    Entire backlog (1,529 bytes) + new logs   │
                  │    rendered instantly into splitTerm!        │
                  └──────────────────────────────────────────────┘
```

### Detailed Code Verification

1. **Chunk Arrival (`standalone.js:2284-2292`):**
   ```javascript
   api?.onTerminalData(({ sessionId, data, seq, generation }) => {
     notifySessionActivity(sessionId, data);
     const chunkSeq = typeof seq === 'number' ? seq : 0;
     const chunkGen = typeof generation === 'number' ? generation : 0;

     if (sessionId === splitId && splitTerm) {
       processIncomingChunk(splitSessionState, { seq: chunkSeq, generation: chunkGen, data }, true);
       return;
     }
   ```
   `splitId` was `"split-2"` and `splitTerm` existed. `processIncomingChunk` was invoked with `chunkSeq = 9` (or next seq).

2. **Sequence Check in `processIncomingChunk` (`standalone.js:684-693`):**
   ```javascript
   if (chunkSeq === viewState.lastRenderedSeq + 1 || (viewState.lastRenderedSeq === 0 && chunkSeq === 1)) {
     viewState.lastRenderedSeq = chunkSeq;
     viewState.pendingWriteAckSeq = chunkSeq;
     writeChunk(viewState, chunkData, isSplit);
     return;
   }

   // Sequence gap detected: chunkSeq > viewState.lastRenderedSeq + 1
   await handleSequenceGap(viewState, chunk, isSplit);
   ```
   - `viewState.lastRenderedSeq` was `0` (set by the aborted hydration in `atomicHydrateSplitPane`).
   - `chunkSeq` was `9`.
   - `9 === 0 + 1` was `false`.
   - `viewState.lastRenderedSeq === 0 && chunkSeq === 1` was `false` (because `9 !== 1`).
   - The sequence gap branch executed!

3. **Delta Fetch in `handleSequenceGap` (`standalone.js:718-725`):**
   ```javascript
   viewState.isFetchingDelta = true;
   viewState.syncState = 'GAPPED';

   const targetSessionId = viewState.id || (isSplit ? splitId : activeId);
   const fromSeq = viewState.lastRenderedSeq + 1; // 0 + 1 = 1

   try {
     const deltaResult = await api?.getTerminalDelta?.(targetSessionId, viewState.sessionGeneration || 0, fromSeq);
   ```
   The renderer requested all chunks from sequence 1 onwards.

4. **Backend Journal Lookup (`terminal-manager.ts:1093-1102`):**
   ```typescript
   public getTerminalDelta(sessionId: string, generation: number, fromSeq: number): TerminalDeltaResult {
     const s = this.sessions.get(sessionId);
     if (!s || s.state === 'closed') {
       return { status: 'SESSION_CLOSED', finalSeq: s?.lastSeq || 0 };
     }
     if (generation > 0 && s.sessionGeneration !== generation) {
       return { status: 'GENERATION_MISMATCH', currentGeneration: s.sessionGeneration };
     }
     return s.deliveryJournal.getDelta(generation || s.sessionGeneration, fromSeq);
   }
   ```
   `s.deliveryJournal` (`SessionDeliveryJournal`, line 76) holds up to 2 MiB of recent chunks in memory. Since `split-2` had only written 1,529 bytes in total, all entries from `seq: 1` through `seq: 8` were intact. The journal returned:
   ```json
   {
     "status": "OK",
     "fromSeq": 1,
     "throughSeq": 8,
     "chunks": [ /* chunks 1 through 8 containing all 1,529 bytes */ ]
   }
   ```

5. **Replay and Catch-Up (`standalone.js:757-784`):**
   ```javascript
   if (deltaResult.status === 'OK') {
     viewState.syncState = 'RESYNCING';
     if (Array.isArray(deltaResult.chunks)) {
       for (const deltaChunk of deltaResult.chunks) {
         if (deltaChunk.seq === viewState.lastRenderedSeq + 1) {
           viewState.lastRenderedSeq = deltaChunk.seq;
           viewState.pendingWriteAckSeq = deltaChunk.seq;
           writeChunk(viewState, deltaChunk.data, isSplit);
         }
       }
     }

     // Drain buffered liveQueue
     viewState.liveQueue.sort((a, b) => a.seq - b.seq);
     while (viewState.liveQueue.length > 0) {
       const next = viewState.liveQueue[0];
       if (next.seq <= viewState.lastRenderedSeq) {
         viewState.liveQueue.shift();
       } else if (next.seq === viewState.lastRenderedSeq + 1) {
         viewState.liveQueue.shift();
         viewState.lastRenderedSeq = next.seq;
         viewState.pendingWriteAckSeq = next.seq;
         writeChunk(viewState, next.data, isSplit);
       } else {
         break;
       }
     }
   ```
   - Chunks 1 through 8 were written sequentially via `writeChunk(viewState, deltaChunk.data, true)` -> `writeToSplitPane`.
   - `lastRenderedSeq` stepped $1 \to 2 \to \dots \to 8$.
   - The live queue (which held chunk 9) was drained and written.
   - `lastRenderedSeq` became 9.
   - `syncState` returned to `'READY'`.

**Conclusion:** The sequence gap handler served as an accidental, asynchronous "healing" hydration mechanism. However, it was only triggered when the backend produced new output. As long as the PTY process remained idle, the split terminal was stranded in the black screen state indefinitely.

---

## 5. Systematic Elimination of Rival Hypotheses

| Rival Hypothesis | Proposed Failure Mode | Empirical Ground Truth Refutation | Verdict |
| :--- | :--- | :--- | :--- |
| **H1: WebGL Context Loss** | WebGL addon crashed, lost GPU context, or failed canvas swap across multiple tabs. | In `standalone.js:969-972`, `attachWebglAddon` is an explicit no-op: `function attachWebglAddon(_term) { return null; }`. The app uses the standard DOM/Canvas renderer specifically to avoid WebGL context loss. | **REFUTED (100% Impossible)** |
| **H2: CSS Sizing / Zero Layout (`height: 0` / `display: none`)** | The split container `#terminal-split` or `#terminal-split-host` had 0px height, flex collapse, or was hidden. | In Image #1, `#terminal-split` is clearly visible with height ~132px, width ~1568px, and a hollow cursor `[]` rendered at `(0, 0)`. xterm cannot render a cursor without layout. Furthermore, text rendered into the exact same container at 12:24:25 with zero layout shifts. | **REFUTED** |
| **H3: Backend Process Crash / Zombie PTY** | The underlying shell or `hrv theme dev` died, exited with an error, or winpty hung. | Telemetry verified `winpty-agent.exe` (PID 21856), `powershell.exe` (PID 17600), and `node.exe` (PID 108) running throughout. At 12:24:25, the same process emitted file sync logs. | **REFUTED** |
| **H4: ANSI Escape Corruption / UTF-8 Encoding Failure** | Corrupted escape sequences or invalid UTF-8 bytes caused xterm.js parser to enter an infinite loop or hide text. | When replayed through `handleSequenceGap`, all ANSI colors, UTF-8 Vietnamese accents ("Thiết lập", "Đóng"), and box borders rendered crisply without errors. | **REFUTED** |
| **H5: IPC Channel Disconnection** | The Electron IPC channel between main and renderer was broken. | Top pane was actively streaming OMP tokens; `api.onTerminalData` received the 12:24:25 chunk immediately. | **REFUTED** |

---

## 6. Architectural Analysis: Disposable Singleton vs. Persistent Pool

The root cause highlights a fundamental architectural asymmetry between the main terminal and the split terminal:

```
Main Terminal Architecture:
┌──────────────────────────────────────────────────────────────┐
│ terminalPool = Map<sessionId, TerminalPaneItem>              │
│ - Retains live Terminal instance in memory across tab switch │
│ - Tab switch only toggles: item.paneEl.classList.toggle(...) │
│ - Cursor, scrollback buffer, VT parser state 100% PRESERVED  │
│ - NO disposal, NO re-creation, NO hydration required         │
└──────────────────────────────────────────────────────────────┘

Split Terminal Architecture (The Anti-Pattern):
┌──────────────────────────────────────────────────────────────┐
│ Global Singletons: splitTerm, splitId, splitSessionState     │
│ - Tab switch calls unmountSplit():                           │
│     splitTerm?.dispose(); splitTerm = null; splitId = '';    │
│     splitSessionState.lastRenderedSeq = 0;                   │
│ - Tab return calls mountSplit():                             │
│     new Terminal() from scratch                              │
│     Forced to re-hydrate from stale renderer snapshot!       │
└──────────────────────────────────────────────────────────────┘
```

Because the main terminal panes are persistent DOM nodes toggled with `.active`, they never suffer from hydration failures on tab switches. The split pane, being implemented as a disposable singleton, is forced to undergo full re-hydration on every tab change. When that hydration is sabotaged by the `snapshot === undefined` guard, it renders black.

---

## 7. Minimal High-Taste Fix & Verification Plan

### The Surgical Fix (3 Parts)

#### Part 1: Fix Hydration Guard in `src/renderer/standalone.js`
In `atomicHydrateSplitPane` (lines 922–930) and `atomicHydratePane` (lines 863–871):
Do not treat an empty string `""` at `seq: 0` as an authoritative snapshot! If the snapshot is missing, empty, or has sequence 0, ALWAYS query `api.getFullBuffer(splitSessionId)`.

```javascript
// BEFORE (Buggy):
if (snapshot === undefined || snapshotSeq === undefined) {

// AFTER (Hardened):
const isSnapshotEmptyOrUnset = !snapshot || snapshot.length === 0;
const isSeqUnset = snapshotSeq === undefined || snapshotSeq === null || snapshotSeq === 0;
if (isSnapshotEmptyOrUnset && isSeqUnset) {
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

#### Part 2: Fix Default Parameters in `mountSplit` (`standalone.js:1492`)
Do not default snapshot to empty string `''` and sequence to `0`:
```javascript
// BEFORE:
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {

// AFTER:
function mountSplit(sessionId, snapshot = undefined, snapshotSeq = undefined) {
```

#### Part 3: Pre-Register `splitId` to Eliminate Split-Creation Race (`standalone.js:1597-1601`)
In `splitButton.onclick`:
```javascript
// BEFORE:
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) mountSplit(newSplitId);

// AFTER:
// Immediately mount split UI and register splitId or await getFullBuffer
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) {
  // Always mount with undefined so atomicHydrateSplitPane fetches fresh full buffer
  mountSplit(newSplitId, undefined, undefined);
}
```

#### Part 4: Add Backend Resync to `mountSplit` (`standalone.js:1562`)
Just as `getOrCreateTerminalPane` calls `syncPaneWithBackend(item, sessionId)` at line 1204, `mountSplit` should trigger resync to catch any micro-deltas between snapshot and live state.

---

## 8. Verification Protocol

To verify the diagnosis and fix without regression:

1. **Reproduction Test (Idle Split on Tab Switch):**
   - Open Tab A, split it, start `powershell.exe`. Wait for prompt `PS> `. Do NOT type anything (PTY is idle).
   - Switch to Tab B.
   - Switch back to Tab A.
   - **Check:** Split pane must immediately display `Windows PowerShell ... PS> ` instead of a black screen with hollow cursor `[]`.
2. **Creation Race Test:**
   - On a wide terminal, click the split button (`#btnSplit`).
   - Winpty emits initial banner immediately.
   - **Check:** Split pane renders the initial shell banner without waiting for a second command or keystroke.
3. **Sequence Gap Stress Test:**
   - In DevTools console, run `splitSessionState.lastRenderedSeq = 0`.
   - Type a command in split pane.
   - **Check:** Sequence gap handler cleanly requests delta and replays buffer without duplicate lines or `DEGRADED` banner.
4. **Automated Smoke Run:**
   - Run `node test/e2e/terminal-renderer-smoke.cjs` to confirm IPC ack, sequence journal, and pool synchronization contracts pass.
