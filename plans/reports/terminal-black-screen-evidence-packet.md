# AntiFan Terminal Black Screen (Split View) — Immutable Evidence Packet

**Issue:** User reported: "vẫn còn hiện trạng Terminal đen ko thấy gì" with a live screenshot showing `ANTIFAN TERMINAL` where the top pane (main terminal) is active and running `OMP` in `Shop` (`E:\Work\customizes\Apshop`), while the bottom pane (`Terminal (Split)`) is completely blank/black with a single hollow cursor `[]` at position (0, 0).
**Timestamp:** 2026-09-06
**Platform:** Windows 11 Pro, Electron 43.4.0, node-pty (winpty)

---

## 1. Symptom & Visual Evidence from Screenshot (Image #1)

- **Window:** Standalone Terminal window (`ANTIFAN TERMINAL`, PID 24484).
- **Active Tab:** `Shop` (`terminal-1`), located in `E:\Work\customizes\Apshop`.
- **Top Pane (Main Terminal):**
  - Actively running an interactive OMP (Oh My Pi / Gemini 3.8 Flash) session with rich color syntax highlighting (`assets/main.js.liquid`, `TODO Investigation...`).
  - Terminal size: 265 columns × 48 rows.
- **Bottom Pane (`Terminal (Split)`):**
  - Pane Header: `> Terminal (Split)` with `✕` close button (`#btnCloseSplitPane`).
  - Pane Body (`#terminal-split-host`): Solid background `#070b11`, height ~132px, width ~1568px.
  - Text Content: **Zero characters rendered**. Completely black.
  - Cursor: Single hollow rectangular cursor `[]` at top-left corner `(row 0, col 0)`. In xterm.js, a hollow rectangle indicates an unfocused terminal at its initial coordinate with no text printed.
  - Scrollbar: **No scrollbar** visible on the right (xterm.js has not allocated scrollback lines).

---

## 2. Live Workstation State & Process Telemetry (Ground Truth)

Inspection of the running Electron instance (PID 24484) and disk configuration (`E:/Work/.antifan-data/config/terminal-sessions.json`):

1. **Config File (`terminal-sessions.json`):**
   ```json
   {
     "activeSessionId": "terminal-1",
     "sessions": [
       { "id": "terminal-3", "name": "Phukienmaymoc", "cwd": "E:\\Work\\customizes\\Phukienmaymoc" },
       { "id": "split-1", "name": "Terminal split-1", "cwd": "E:\\Work\\customizes\\Phukienmaymoc", "splitOf": "terminal-3" },
       { "id": "terminal-1", "name": "Shop", "cwd": "E:\\Work\\customizes\\Apshop", "bufferLength": 262055 },
       { "id": "split-2", "name": "Terminal split-2", "cwd": "E:\\Work\\customizes\\Apshop", "splitOf": "terminal-1", "bufferLength": 1529 }
     ]
   }
   ```
2. **Underlying Windows Process Tree under Electron (PID 24484):**
   - `winpty-agent.exe` (PID 21856): 265 cols × 13 rows.
     └── `powershell.exe` (PID 17600)
         └── `node.exe` (PID 108): `C:\Users\Admin\AppData\Roaming\npm/node_modules/@local/haravan-theme-ops-cli/dist/index.js theme dev`
3. **PTY Buffer Content of `split-2` (1,529 bytes):**
   The backend PTY had already produced:
   ```text
   Windows PowerShell
   Copyright (C) Microsoft Corporation. All rights reserved.
   Install the latest PowerShell for new features and improvements! https://aka.ms/PSWindows
   PS E:\Work\customizes\Apshop> hrv theme dev
    Links:
      Theme:      New Customize ApShop - T8/2026 [ No Delete ] (ID: 1001505870)
      Admin:      https://apshop.vn/admin
      Thiết lập:  https://apshop.vn/admin/sale_channels/online_store/themes/1001505870/setting
      Preview:    https://apshop.vn?themeid=1001505870

   Watching E:\Work\customizes\Apshop — pushing when content changes. Press Ctrl+C to stop.
   ```
   **Observation:** The backend process was alive, healthy, and had already written 1,529 bytes of output, but none of it was rendered in `Terminal (Split)`.

4. **Fresh Screenshot Evidence (at 12:26):**
   A second frame was captured via native desktop inspection (`omp-computer-157498ed7332d6fb.png`):
   When a developer saved `assets/main.js.liquid` at 12:24:25, `hrv theme dev` produced 5 new log lines (`12:24:25 Synced >> update assets/main.js.liquid ...`).
   **The bottom split pane suddenly woke up and displayed the full text.**
   This proves that the xterm instance, DOM container, styles, and IPC transport were functional, but was stranded in an unhydrated black state while the backend was idle.

---

## 3. Scouted Code Paths & Mechanical Breakdown

### A. Lifecycle Divergence: Persistent Map vs Disposable Singleton
- **Main Terminal (`terminalPool`):**
  - Kept in `terminalPool = new Map<string, TerminalPaneItem>()`.
  - On tab switch, `terminalPool` items are NOT disposed; their DOM nodes are merely toggled via `item.paneEl.classList.toggle('active', isActive)` (`src/renderer/standalone.js:2169`).
  - Terminal state machine (cursor, lines, scrollback, VT modes) remains 100% intact.
- **Split Terminal (`splitTerm`):**
  - Implemented as global singleton variables: `splitTerm`, `splitId`, `splitFitAddon`, `splitSessionState` (`src/renderer/standalone.js:493-500`).
  - On every tab switch away from a session or between sessions:
    `unmountSplit()` is called (`src/renderer/standalone.js:1440-1490`):
    - `splitTerm?.dispose()`
    - `splitTerm = null`
    - `splitId = ''`
    - `splitSessionState.lastRenderedSeq = 0`
    - `#terminal-split` and `#terminal-divider` are removed from the DOM.
  - When returning to the tab:
    `mountSplit(targetSession.splitSessionId, targetSession.splitBuffer, targetSession.splitSnapshotThroughSeq)` creates a brand new `Terminal` from scratch (`src/renderer/standalone.js:1492-1540`).

### B. The Hydration Guard Bug: `snapshot === undefined` vs Empty String `""`
In `src/renderer/standalone.js:911-931`:
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

    splitTerm.reset();
    if (snapshot && snapshot.length > 0) {
      await writeTermAsync(splitTerm, snapshot);
    }
    splitSessionState.lastRenderedSeq = snapshotSeq || 0;
```

**The Defect:**
1. In `mountSplit(sessionId, snapshot = '', snapshotSeq = 0)`:
   - When called from `splitButton.onclick` (`standalone.js:1601`), `snapshot` defaults to `''` and `snapshotSeq` defaults to `0`.
   - When called from `renderTabs.onclick` (`standalone.js:2165`), `targetSession.splitBuffer` is passed.
2. In `terminal-manager.ts`:
   - `appendData(s, data)` streams PTY chunks and appends to `s.buffer`, but **never emits a session update** (`emitSession()`) during ongoing streaming to avoid IPC chatter.
   - Therefore, the renderer's cached `sessions` array only has the `splitBuffer` from when the session was created or last saved to disk.
   - If the split was spawned recently, `targetSession.splitBuffer` in the renderer is `""` and `targetSession.splitSnapshotThroughSeq` is `0`.
3. In `atomicHydrateSplitPane`:
   - `snapshot` is `""` (empty string) and `snapshotSeq` is `0`.
   - The guard `if (snapshot === undefined || snapshotSeq === undefined)` checks strictly for `undefined`.
   - Since `"" !== undefined` and `0 !== undefined`, **THE GUARD EVALUATES TO FALSE**.
   - `api.getFullBuffer(splitSessionId)` is **NEVER CALLED**.
   - `splitTerm.reset()` runs.
   - `if (snapshot && snapshot.length > 0)` is FALSE.
   - Nothing is written to `splitTerm`.
   - `splitSessionState.lastRenderedSeq = 0`.

### C. The Early-Return Guard in `mountSplit`
In `src/renderer/standalone.js:1492-1495`:
```javascript
function mountSplit(sessionId, snapshot = '', snapshotSeq = 0) {
  if (!sessionId) return;
  if (splitId === sessionId && splitTerm) return;
  unmountSplit();
  splitId = sessionId;
```
If `api.onTerminalSession` arrives later with an updated session object from the backend:
`splitId === sessionId && splitTerm` is **TRUE**!
`mountSplit` returns immediately without re-hydrating. The blank screen persists.

### D. Race Condition during `api.splitTerminal`
When creating a new split via `splitButton.onclick` (`standalone.js:1597-1601`):
```javascript
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) mountSplit(newSplitId);
```
1. Main process spawns the split PTY and sends initial chunks (`seq: 1, 2, 3` with PowerShell banner/prompt).
2. During `await api.splitTerminal`, `splitId` in renderer is still `''` or old.
3. In `api.onTerminalData` (`standalone.js:2284`):
   ```javascript
   if (sessionId === splitId && splitTerm) {
     processIncomingChunk(splitSessionState, ...);
     return;
   }
   let item = terminalPool.get(sessionId);
   if (!item) item = getOrCreateTerminalPane(sessionId, '', 0, false);
   processIncomingChunk(item, ...);
   ```
4. Because `sessionId !== splitId`, the initial prompt chunks are misrouted to a dummy pane in `terminalPool` and dropped from `splitTerm`.
5. When `mountSplit(newSplitId)` finally runs, it starts with an empty snapshot, misses the initial chunks, and has no pending chunks in queue.
6. The terminal sits black until a future external event produces a new chunk.

---

## 4. Evaluation Rubric for Diagnoses

1. **Evidence Grounding:** Does the diagnosis trace directly to the code lines in `src/renderer/standalone.js` and `src/main/browser/terminal-manager.ts` and explain both Image #1 (black screen with `[]` cursor) and the fresh screenshot (sudden recovery after new chunk)?
2. **Rival Hypothesis Elimination:** Does it specifically evaluate and eliminate rival explanations:
   - WebGL context loss?
   - CSS sizing/visibility issue (`height: 0` / `display: none`)?
   - Process crash/zombie PTY?
   - Encoding/ANSI corruption?
3. **Specificity of Root Cause:** Does it pinpoint the exact mechanical failure (e.g. `snapshot === undefined` guard skipping `getFullBuffer`, disposable singleton lifecycle losing state, misrouted initial chunks)?
4. **Actionable Fix & Verification Plan:** Does it propose a minimal, high-taste fix without breaking the main terminal architecture, and provide a clear verification plan?
