# Ultra Terminal Diagnosis Report (Candidate 3)
**Subject:** IPC Race Conditions, Initial Prompt Misrouting, and Asynchronous Split Creation in AntiFan Terminal  
**Target Files:** `src/renderer/standalone.js`, `src/main/browser/terminal-manager.ts`, `src/main/browser/native-tab-host.ts`  
**Evidence Baseline:** `plans/reports/terminal-black-screen-evidence-packet.md`  
**Status:** COMPLETE (Fact-based, Root-Cause Grounded)

---

## Executive Summary

When a user triggers a split terminal pane in AntiFan Browser Desktop (e.g. by clicking `#btnSplitTerminal`), the newly created lower split pane (`Terminal (Split)`) displays a completely blank/black screen with a single unfocused hollow rectangular cursor `[]` at position `(row 0, col 0)`. The underlying process (`powershell.exe` -> `hrv theme dev`) is fully functional and running in the background, having written over 1,500 bytes of output into the backend PTY. However, no text is rendered until a brand-new, unrelated PTY event occurs later (such as a file save triggering `hrv theme dev` to log changes), at which point the split pane suddenly "wakes up" and renders all historical output in a flash.

This diagnosis uncovers a multi-stage race condition and architectural mismatch between the Electron Main process and the Standalone Renderer:
1. **The Asynchronous IPC Void:** `api.splitTerminal` is an asynchronous IPC invocation (`ipcRenderer.invoke`). While the main process spawns the Windows PTY and immediately begins streaming startup chunks (PowerShell banner, prompt) over the `'antifan:terminal:data'` channel, the renderer is awaiting the IPC response. During this interval, `splitId` in the renderer is still empty (`''`) and `splitTerm` is `null`.
2. **Initial Chunk Misrouting to Phantom Panes:** In `src/renderer/standalone.js:2284-2305`, `api.onTerminalData` intercepts these early chunks for `split-2`. Because `sessionId !== splitId`, it attempts to find the session in `sessions` (where splits are excluded by design). It falls back to calling `getOrCreateTerminalPane('split-2', '', 0, false)`, creating a hidden, unmounted "dummy" terminal pane inside `terminalPool`, where the initial prompt is rendered invisibly and subsequently garbage collected during the next `syncTerminalPool`.
3. **The Hydration Guard Bug:** When `mountSplit(newSplitId)` finally executes, it invokes `atomicHydrateSplitPane('split-2', snapshot = '', snapshotSeq = 0)`. Line 922 contains the strict check `if (snapshot === undefined || snapshotSeq === undefined)`. Because `"" !== undefined` and `0 !== undefined`, this check evaluates to `false`. The renderer **never calls `api.getFullBuffer()`**, resets the terminal, renders nothing, and leaves the screen completely black.
4. **The Sudden Recovery via Sequence Gap Self-Healing:** When the user later edits a file, `hrv theme dev` emits chunk sequence `seq: 6`. The renderer receives this chunk, notes that `lastRenderedSeq` is `0`, triggers `handleSequenceGap()`, requests historical delta chunks `seq: 1..5` from `SessionDeliveryJournal`, writes them to `splitTerm`, and the terminal instantaneously renders all missing content.

---

## 1. Asynchronous Split Creation & Main Process Mechanics

### 1.1 The Trigger in Renderer
When the user clicks the Split button in the standalone UI, the handler in `src/renderer/standalone.js:1586-1607` executes:

```javascript
// src/renderer/standalone.js:1597-1601
const mainItem = terminalPool.get(activeId);
const targetCols = (mainItem && mainItem.term && mainItem.term.cols) || 120;
const targetRows = getInitialSplitRows(mainItem?.term);
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) mountSplit(newSplitId);
```

At this moment:
- `api.splitTerminal` dispatches an IPC invoke message `antifan:terminal:split-session` (`src/preload/standalone-preload.ts:17-19`).
- In JavaScript, `await` yields execution back to the microtask/event loop in the renderer thread.
- **Renderer State during `await`:**
  - `splitId` remains `''` (lines 494, 1475).
  - `splitTerm` remains `null` (lines 495, 1474).
  - `splitEnabled` remains `false` (lines 493, 1476).

### 1.2 Execution in Main Process
In `src/main/browser/native-tab-host.ts:1288-1294`, the IPC handler delegates to `TerminalManager.getInstance().createSplitSession(parentId, cwd, cols, rows)`:

```typescript
// src/main/browser/terminal-manager.ts:904-921
public createSplitSession(parentId: string, cwd?: string, initialCols?: number, initialRows?: number): string {
  const parent = this.sessions.get(parentId);
  if (!parent || parent.disposed || parent.splitOf) return '';
  const existing = [...this.sessions.values()].find(x => x.splitOf === parentId);
  if (existing) return existing.id;
  let n = 1;
  while (this.sessions.has(`split-${n}`)) n++;
  const id = `split-${n}`;
  const targetCols = Math.max(40, initialCols || this.lastCols || 120);
  const targetRows = Math.max(MIN_SPLIT_TERMINAL_ROWS, initialRows || this.getInitialSplitRows(parent.pty?.rows));
  const splitSession = this.spawn(id, cwd || parent.cwd, '', targetCols, targetRows, MIN_SPLIT_TERMINAL_ROWS, parentId, parent.sessionGeneration);
  splitSession.splitOf = parentId;
  splitSession.capsuleId = parent.capsuleId || this.currentCapsuleId;
  this.persist();
  this.emitSession();
  this.emit('session-created', { id, parentId, generation: splitSession.sessionGeneration });
  return id;
}
```

### 1.3 Immediate PTY Spawning and Data Generation
Inside `TerminalManager.spawn` (`src/main/browser/terminal-manager.ts:584-675`), `node-pty.spawn` synchronously creates the child process (`winpty-agent.exe` wrapping `powershell.exe` on Windows).
Immediately, `child.onData` is hooked:

```typescript
// src/main/browser/terminal-manager.ts:643-651
const dataSub = child.onData(data => {
  if (s.disposed) return;
  this.appendData(s, data);
});
```

Within 5 to 50 milliseconds of spawning, Windows PowerShell starts up and writes its standard greeting:
```text
Windows PowerShell
Copyright (C) Microsoft Corporation. All rights reserved.
...
PS E:\Work\customizes\Apshop> 
```

`this.appendData(s, data)` executes (`src/main/browser/terminal-manager.ts:677-687`):
1. Sets `s.lastSeq = 1` (and subsequently 2, 3...).
2. Stores the chunk in `s.deliveryJournal.append(s.sessionGeneration, s.lastSeq, data)`.
3. Appends data to `s.buffer`.
4. Emits `'data'` on `TerminalManager`:
   ```typescript
   this.emit('data', { sessionId: s.id, data, seq: s.lastSeq, generation: s.sessionGeneration });
   ```

In `src/main/browser/native-tab-host.ts:1163-1174`, the `'data'` listener immediately forwards this chunk to the renderer via IPC:
```typescript
safeSendWebContents(win.webContents, 'antifan:terminal:data', payload);
```

**Critical Timing Finding:**
Because Windows process creation and winpty pipe reads happen on operating system threads and Node.js libuv worker threads, PTY data chunks arrive at the renderer's IPC queue **before** `api.splitTerminal` promise resolution completes its roundtrip and executes `mountSplit` in `standalone.js`.

---

## 2. IPC Race Window & Initial Prompt Misrouting

### 2.1 The Routing Logic in `api.onTerminalData`
In `src/renderer/standalone.js:2284-2306`:

```javascript
api?.onTerminalData(({ sessionId, data, seq, generation }) => {
  notifySessionActivity(sessionId, data);
  const chunkSeq = typeof seq === 'number' ? seq : 0;
  const chunkGen = typeof generation === 'number' ? generation : 0;

  // Check 1: Is this data for the currently mounted split pane?
  if (sessionId === splitId && splitTerm) {
    processIncomingChunk(splitSessionState, { seq: chunkSeq, generation: chunkGen, data }, true);
    return;
  }

  // Check 2: Route to main terminal pool
  let item = terminalPool.get(sessionId);
  if (!item) {
    const s = sessions.find((x) => x.id === sessionId);
    if (s) {
      item = getOrCreateTerminalPane(sessionId, s.buffer ?? '', 0, true);
    } else {
      item = getOrCreateTerminalPane(sessionId, '', 0, false);
    }
  }
  if (item) {
    processIncomingChunk(item, { seq: chunkSeq, generation: chunkGen, data }, false);
  }
});
```

### 2.2 Tracing the Misrouting of Initial Chunks for `split-2`

1. **Failure of Split Check:**
   When the early chunk for `sessionId = 'split-2'` arrives:
   - `splitId` is still `''`.
   - `splitTerm` is still `null`.
   - `sessionId === splitId && splitTerm` evaluates to **`false`**.

2. **Lookup in `terminalPool`:**
   - `terminalPool.get('split-2')` is `undefined`.

3. **Lookup in `sessions` array:**
   - In `src/main/browser/terminal-manager.ts:940-942`:
     ```typescript
     public listSessions(paged = true): SessionSummary[] {
       const baseSessions = [...this.sessions.values()].filter(s => !s.splitOf);
     ```
   - Split sessions have `splitOf: 'terminal-1'`. Therefore, `split-2` is **filtered out** of the base sessions list. It only exists as nested metadata (`s.splitSessionId: 'split-2'`) on `terminal-1`.
   - In the renderer, `sessions.find(x => x.id === 'split-2')` is **`undefined`**.

4. **Creation of the Phantom Terminal Pane:**
   The fallback branch is reached:
   ```javascript
   item = getOrCreateTerminalPane('split-2', '', 0, false);
   ```
   Inspect `getOrCreateTerminalPane` (`src/renderer/standalone.js:1084-1135`):
   - It instantiates a brand new `div.terminal-session-pane` with attribute `data-session-id="split-2"`.
   - It instantiates a brand new `Terminal` instance `sTerm`.
   - It calls `mainPane.appendChild(paneEl)`. It attaches this orphaned pane into `#terminal-main-pane` (behind the active tab).
   - It calls `terminalPool.set('split-2', item)`.
   - It returns this `item`.

5. **Data Consumed by Phantom Terminal:**
   Line 2304 calls:
   ```javascript
   processIncomingChunk(item, { seq: 1, generation: 1, data }, false);
   ```
   The PowerShell banner and prompt are written into the phantom terminal pane `item.term` inside `terminalPool`.
   **Result:** The initial PTY data is completely consumed and stored in a hidden terminal instance that will never be shown to the user.

6. **Destruction of the Phantom Terminal:**
   A moment later, `TerminalManager.emitSession()` arrives at `api.onTerminalSession` (`src/renderer/standalone.js:2250-2272`).
   It calls `syncTerminalPool(sessions, activeId, ...)`:
   ```javascript
   // src/renderer/standalone.js:1209-1224
   const activeSessionIds = new Set((allSessions || []).map((s) => s.id));
   for (const [id, item] of terminalPool.entries()) {
     if (!activeSessionIds.has(id)) {
       item.paneEl.remove();
       terminalPool.delete(id);
     }
   }
   ```
   Because `allSessions` only contains base sessions, `activeSessionIds.has('split-2')` is `false`.
   The phantom pane is removed from the DOM and deleted from `terminalPool`.
   The initial data that was misrouted is destroyed.

---

## 3. The Hydration Guard Bug & The Black Screen State

### 3.1 Invocation of `mountSplit`
Now, `await api.splitTerminal(...)` in `src/renderer/standalone.js:1600` finally resolves with `newSplitId = 'split-2'`.
Line 1601 runs:
```javascript
if (newSplitId) mountSplit(newSplitId);
```

Let us look at the function declaration of `mountSplit` in `src/renderer/standalone.js:1492`:
```javascript
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) return;
  unmountSplit();
  splitId = sessionId;
  splitEnabled = true;
...
```

Notice the parameters passed:
- `sessionId` = `'split-2'`
- `snapshot` = `''` (assigned by default parameter)
- `snapshotSeq` = `0` (assigned by default parameter)

Inside `mountSplit`:
- Creates `#terminal-split` and `#terminal-split-host`.
- Instantiates a new `splitTerm = new Terminal(...)`.
- Mounts `splitTerm.open(splitHost)`.
- Calls line 1562:
  ```javascript
  atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
  ```

### 3.2 The Flawed Undefined Guard in `atomicHydrateSplitPane`
Inspect `atomicHydrateSplitPane` (`src/renderer/standalone.js:911-946`):

```javascript
// src/renderer/standalone.js:919-931
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
```

**The Mechanical Failure:**
1. `providedSnapshot` is `""` (empty string, type `string`).
2. `providedSeq` is `0` (type `number`).
3. The guard is: `if (snapshot === undefined || snapshotSeq === undefined)`.
4. In JavaScript:
   - `"" === undefined` is **`false`**.
   - `0 === undefined` is **`false`**.
   - `false || false` is **`false`**!
5. **`api.getFullBuffer(splitSessionId)` IS NEVER CALLED.**
6. `splitTerm.reset()` is invoked.
7. `if (snapshot && snapshot.length > 0)` evaluates to `false` because `snapshot.length === 0`.
8. `splitSessionState.lastRenderedSeq` is set to `0`.
9. `splitSessionState.liveQueue` is `[]` (empty) because the initial chunks were already diverted to the dummy pool.

### 3.3 Visual Result: The Hollow Cursor `[]` at (0, 0)
Because nothing was written to `splitTerm`:
- xterm.js has zero text in its line buffer (`lines.length === 0`).
- The scrollback buffer is completely empty (`baseY === 0`, no scrollbar allocated).
- The terminal cursor sits at `(row 0, col 0)`.
- Because focus is initialized or switched before input, xterm renders an **unfocused hollow rectangle** `[]` at `(0, 0)`.
- The background `#070b11` fills the container (`132px × 1568px`).
- **The screen is 100% black.**

### 3.4 Why Subsequent `onTerminalSession` Does Not Recover
One might ask: when `api.onTerminalSession` is broadcast by the main process, why doesn't `activeSession.splitBuffer` fix the display?
Look at `src/renderer/standalone.js:2264-2267`:
```javascript
const activeSession = sessions.find((s) => s.id === activeId);
if (activeSession?.splitSessionId) {
  mountSplit(activeSession.splitSessionId, activeSession.splitBuffer, activeSession.splitSnapshotThroughSeq || 0);
}
```
Now look at line 1494 inside `mountSplit`:
```javascript
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) return; // EARLY RETURN!
```
Because `splitId === 'split-2'` and `splitTerm` is already an instantiated object, **`mountSplit` returns immediately!**
It does not re-hydrate `splitTerm`. The updated `splitBuffer` is completely ignored!

---

## 4. Mechanics of the "Sudden Recovery" (Screenshot #2 at 12:26)

In the evidence packet (`plans/reports/terminal-black-screen-evidence-packet.md:62-66`), a developer saved `assets/main.js.liquid` at 12:24:25.
The terminal suddenly woke up and displayed the entire log history.
Here is the exact mechanical trace of why that happened:

```
[Main Process PTY: hrv theme dev]
       │
       ▼ (12:24:25 file change detected)
Writes: "12:24:25 Synced >> update assets/main.js.liquid ...\r\n"
       │
       ▼
appendData(s, data)  --> s.lastSeq increments to 6.
       │                 s.deliveryJournal stores chunk 6.
       │
       ▼ IPC Event
antifan:terminal:data { sessionId: 'split-2', data: '...', seq: 6, generation: 1 }
       │
       ▼
[Renderer: standalone.js:2284 api.onTerminalData]
sessionId ('split-2') === splitId ('split-2') && splitTerm (exists!)
       │
       ▼
processIncomingChunk(splitSessionState, { seq: 6, generation: 1, data }, true)
       │
       ▼ Line 684:
viewState.lastRenderedSeq is 0.
chunkSeq is 6.
chunkSeq === viewState.lastRenderedSeq + 1 (6 === 1) is FALSE!
       │
       ▼ Line 692:
Sequence Gap Detected! --> handleSequenceGap(splitSessionState, chunk, true)
       │
       ▼ Line 725:
api.getTerminalDelta('split-2', generation=1, fromSeq = 0 + 1 = 1)
       │
       ▼ IPC Invoke: antifan:terminal:get-delta
[Main Process: terminal-manager.ts:1093 getTerminalDelta]
s.deliveryJournal.getDelta(1, fromSeq = 1)
Returns { status: 'OK', chunks: [chunk1, chunk2, chunk3, chunk4, chunk5] }
       │
       ▼
[Renderer: standalone.js:757-767]
for (const deltaChunk of deltaResult.chunks) {
  writeChunk(viewState, deltaChunk.data, isSplit); // Writes chunks 1, 2, 3, 4, 5!
}
writeChunk(viewState, incomingChunk.data, isSplit); // Writes chunk 6!
       │
       ▼
splitTerm.write() renders:
1. Windows PowerShell banner
2. Command prompt
3. "hrv theme dev" startup links & banner
4. "12:24:25 Synced >> update assets/main.js.liquid"
```

**Conclusion on Sudden Recovery:**
The terminal woke up not because of a display refresh or focus change, but because the transport layer's **Sequence Gap Recovery Protocol** (`handleSequenceGap`) was inadvertently triggered by the arrival of a high sequence number (`seq: 6`) against an unhydrated sequence counter (`lastRenderedSeq: 0`), forcing a retroactive backfill of chunks 1 through 5 from `SessionDeliveryJournal`.

---

## 5. Rival Hypothesis Disproof Matrix

| Candidate Hypothesis | Proposed Mechanism | Empirical Ground Truth / Source Telemetry | Verdict |
| :--- | :--- | :--- | :--- |
| **WebGL Context Loss** | xterm.js WebGL canvas lost context due to multi-tab GPU allocation. | `src/renderer/standalone.js:969-972`: `attachWebglAddon` explicitly returns `null` ("Use standard high-performance DOM/Canvas renderer to avoid WebGL context loss"). WebGL addon is not even loaded. Furthermore, the terminal rendered cleanly upon receiving chunk 6 without any GPU context recreation. | **DISPROVED** |
| **CSS Hidden / Zero Dimensions** | Container had `height: 0`, `display: none`, or `visibility: hidden`. | Evidence packet section 1 & DOM inspection: `#terminal-split-host` has explicit computed height ~132px, width ~1568px, background `#070b11`. The hollow cursor `[]` at (0, 0) was visibly rendered by xterm's canvas. | **DISPROVED** |
| **Process Crash / Zombie PTY** | Child shell exited immediately upon spawn. | Windows process table confirms PID 24484 (Electron) -> PID 21856 (`winpty-agent.exe`) -> PID 17600 (`powershell.exe`) -> PID 108 (`node.exe` running `hrv theme dev`). PTY buffer held 1,529 bytes. `hrv theme dev` actively responded to file edits at 12:24:25. | **DISPROVED** |
| **ANSI Sequence / Encoding Corruption** | An escape code hid the cursor or cleared the screen continuously. | The PTY buffer inspection showed standard UTF-8 text with common SGR color codes. The cursor was at `(0, 0)` with no scrollback, indicating nothing had ever reached `splitTerm.write()`. When chunks 1-5 were rendered via gap recovery, all colors and layout displayed without error. | **DISPROVED** |

---

## 6. Comprehensive IPC Transport Diagnosis & Recommended Fixes

### 6.1 Diagnosis Summary
The black screen is caused by three compounding defects:
1. **Unprotected Async Window:** Between `api.splitTerminal` invocation and resolution, incoming PTY chunks have no registered recipient and are misrouted into a phantom `terminalPool` entry.
2. **Strict Guard Logic Bug:** `atomicHydrateSplitPane` checks `snapshot === undefined || snapshotSeq === undefined`. Default argument `snapshot = ''` bypasses this check, leaving `splitTerm` empty and preventing `api.getFullBuffer()` from fetching the PTY output.
3. **Early Return Guard Lockout:** Once `splitTerm` is mounted, `mountSplit` refuses to re-hydrate on subsequent `onTerminalSession` broadcasts (`if (splitId === sessionId && splitTerm) return;`).

### 6.2 Recommended Architectural & Code Fixes

#### Fix 1: Surgical Fix to `atomicHydrateSplitPane` (Renderer)
In `src/renderer/standalone.js:922`:
Currently:
```javascript
if (snapshot === undefined || snapshotSeq === undefined) {
```
Change to:
```javascript
// If snapshot is undefined, null, or empty string, fallback to getFullBuffer
if (!snapshot || snapshot === undefined || snapshotSeq === undefined) {
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
*Effect:* Even if `mountSplit` passes `snapshot = ''`, `atomicHydrateSplitPane` will immediately query `api.getFullBuffer(splitSessionId)` and retrieve the 1,529 bytes from the backend PTY.

#### Fix 2: Pre-registration of Expected Split Session in Renderer
In `src/renderer/standalone.js:1586-1608`:
Rather than leaving `splitId` blank while awaiting `api.splitTerminal`:
```javascript
// Pre-register pending split intent or hold incoming split data
splitEnabled = true;
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) {
  mountSplit(newSplitId);
}
```
And in `api.onTerminalData` (`standalone.js:2284`):
```javascript
// Prevent misrouting any split session to terminalPool
if (sessionId.startsWith('split-')) {
  if (splitTerm && (sessionId === splitId || !splitId)) {
    splitId = sessionId;
    processIncomingChunk(splitSessionState, { seq: chunkSeq, generation: chunkGen, data }, true);
    return;
  }
  // If splitTerm is not yet mounted, queue the chunks into splitSessionState.liveQueue
  splitSessionState.liveQueue.push({
    seq: chunkSeq,
    generation: chunkGen,
    data,
    epoch: splitSessionState.hydrationEpoch
  });
  return;
}
```
*Effect:* Early PTY chunks will never spawn a dummy terminal in `terminalPool`. They will either be routed directly to `splitSessionState` or safely queued in `splitSessionState.liveQueue` until `mountSplit` consumes them.

#### Fix 3: Allow Re-Hydration in `mountSplit` if Empty
In `src/renderer/standalone.js:1494`:
```javascript
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) {
    // If the split terminal is already mounted but has rendered 0 sequences and has a non-empty snapshot, hydrate it
    if (splitSessionState.lastRenderedSeq === 0 && snapshot && snapshot.length > 0) {
      atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
    }
    return;
  }
  unmountSplit();
```
*Effect:* When the subsequent `api.onTerminalSession` arrives with the updated `activeSession.splitBuffer`, `mountSplit` will not prematurely return; it will re-hydrate the unhydrated split terminal.

---

## 7. Verification & Test Plan

1. **Unit / Component Test (Renderer Hydration Guard):**
   - Execute `atomicHydrateSplitPane('test-session', '', 0)` with a mock `api.getFullBuffer` returning `"hello world"`.
   - Assert `api.getFullBuffer` is called.
   - Assert `splitTerm.write` receives `"hello world"`.
   - Assert `splitSessionState.lastRenderedSeq` equals mock sequence number.

2. **Integration Test (Early Chunk Routing):**
   - Simulate `onTerminalData` with `sessionId = 'split-1'` before `mountSplit('split-1')` is called.
   - Assert that no element is added to `terminalPool` with key `'split-1'`.
   - Call `mountSplit('split-1')` and assert that early queued chunks are drained and rendered in `splitTerm`.

3. **End-to-End Visual Verification (Manual or Automated via Playwright / AntiFan Test Suite):**
   - Launch Standalone Terminal window.
   - Click `#btnSplitTerminal`.
   - **Acceptance Criterion:** The split pane immediately displays the shell banner and command prompt within 200ms. The terminal pane MUST NOT be black, and text content MUST be visible without requiring keyboard interaction or external file saves.