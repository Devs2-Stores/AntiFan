# Technical Journal: Fix AntiFan Terminal Split View Black Screen ("Terminal đen ko thấy gì")

**Date:** 2026-09-06  
**Author:** Principal Systems & Reliability Engineer  
**Status:** VERIFIED_COMPLETE  
**Implementation Files:** `src/renderer/standalone.js`, `package.json`, `test/e2e/terminal-split-hydration-probe.cjs`  
**Reports & Evidence Artifacts:** `plans/reports/terminal-black-screen-evidence-packet.md`, `plans/reports/terminal-split-probe-telemetry.json` (`CONFIRMED_ALL_FIXES_VERIFIED`)

---

## 1. Problem Context & Symptoms

Users reported: *"vẫn còn hiện trạng Terminal đen ko thấy gì"* in AntiFan Terminal's split view. In `Shop` (`customizes\Apshop`), the top pane (main terminal) was actively running an interactive OMP session, while the bottom pane (`Terminal (Split)`) rendered a completely black screen (`#070b11`) with zero text characters and a solitary unfocused hollow rectangular cursor `[]` at position `(row 0, col 0)`.

At the same time, the backend Windows process tree (`winpty-agent.exe` PID 21856 -> `powershell.exe` PID 17600 -> `node.exe` PID 108 running `hrv theme dev`) was alive and had already written 1,529 bytes of output. When a file was subsequently saved (`assets/main.js.liquid`) at 12:24:25, the split terminal suddenly woke up and displayed the entire backlog alongside the new sync output (`[INFERENCE]` deduced from the 5 sync log lines appearing simultaneously upon file save).

---

## 2. Root Cause Breakdown (Empirically Proven)

1. **Hydration Guard Strict Undefined Fallacy (`standalone.js:922`):**
   `atomicHydrateSplitPane` used `if (snapshot === undefined || snapshotSeq === undefined)` before falling back to `api.getFullBuffer(splitSessionId)`. Because `mountSplit` declared default parameters `snapshot = '', snapshotSeq = 0` (`standalone.js:1492`), JavaScript default argument coercion replaced any omitted or `undefined` snapshot with `''` and `0`. Consequently, the check `=== undefined` evaluated to `false`, completely bypassing `getFullBuffer`. `splitTerm.reset()` cleared the terminal canvas, zero bytes were written, and `splitSessionState.lastRenderedSeq` was forced to `0`.
2. **Stale Renderer Buffer Cache (`terminal-manager.ts:677-687`):**
   PTY streaming appends data to `s.buffer` and emits raw chunks via `emit('data')`, but intentionally omits `emitSession()` during live streaming to avoid IPC chatter. Thus, the renderer's cached `sessions` array only held the initial empty `splitBuffer: ""` from session creation. When switching tabs, `renderTabs` passed this stale empty buffer into `mountSplit`.
3. **Same-ID Early Return Trap (`standalone.js:1494`):**
   When `mountSplit` was mounted empty, a subsequent `onTerminalSession` broadcast with updated buffer was immediately rejected by `if (splitId === sessionId && splitTerm) return;`, permanently stranding the split view in a blank state.
4. **Creation Race & Phantom Pane (`standalone.js:1597-1601` vs `2289-2305`):**
   During `await api.splitTerminal()`, `splitId` was empty while backend PTY emitted initial chunks, misrouting them to a dummy pane in `terminalPool`.
5. **Idle Process Starvation & Delayed Delta Recovery [INFERENCE]:**
   `hrv theme dev` is a file watcher. After printing its startup banner, it emitted zero stdout bytes while watching files. The subsequent file modification produced new output. The renderer (stranded at `lastRenderedSeq = 0`) detected a sequence gap, invoked `handleSequenceGap()`, which queried `api.getTerminalDelta('split-2', 1, 1)` and replayed the historical backlog from `SessionDeliveryJournal` (`[INFERENCE]`: recovery mechanism verified in probe Check 1 & Check 2, exact live sequence 15 deduced from file-save timestamp and log appearance).

---

## 3. Surgical Implementation (`src/renderer/standalone.js`)

1. **Hydration Guard Relaxation (`standalone.js:922`):**
   ```javascript
   if (snapshot === undefined || snapshotSeq === undefined || (!snapshot && (!snapshotSeq || snapshotSeq === 0))) {
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
2. **Parameter Signature Hygiene (`standalone.js:1492`):**
   Changed default parameters from `snapshot = '', snapshotSeq = 0` to `snapshot = undefined, snapshotSeq = undefined`.
3. **Same-ID Newer Snapshot Self-Healing (`standalone.js:1494`):**
   ```javascript
   if (splitId === sessionId && splitTerm) {
     if (typeof snapshotSeq === 'number' && snapshotSeq > splitSessionState.lastRenderedSeq) {
       atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
     }
     return;
   }
   ```
4. **Contiguous Queue Draining (`standalone.js:945-958`):**
   Preserved serialized queue draining without prematurely clearing `activeHydratingEpoch` before loop execution, keeping hydration locked until `finally`.
5. **Unified Split Mount Cleanup (`standalone.js:1590-1602`):**
   Created `mountSplitClean(newSplitId)` helper to detect and dispose any phantom pane created in `terminalPool` during `api.splitTerminal`, called from both toolbar and context menu split triggers.

---

## 4. Verification & Prevention

1. **Deterministic Chromium E2E Probe (`test/e2e/terminal-split-hydration-probe.cjs`):**
   - Check 1 (Empty-call backend hydration): `mountSplit('split-probe-1', '', 0)` authoritatively invokes `getFullBuffer`, hydrates buffer, sets sequence to 3, and renders text.
   - Check 2 (Same-ID newer snapshot acceptance): `mountSplit('split-probe-2', 'LATER-SESSION-BUFFER\r\n', 2)` on an initial `seq: 1` split triggers in-place re-hydration and proves clean replacement (`INITIAL-OLD-PROBE-2-DATA` completely absent).
   - Check 3 (Creation race): Emits real IPC data chunk during split button await, asserts phantom is observed in-flight and cleaned up by `mountSplitClean`, rendering initial banner cleanly.
   - **Verdict:** `CONFIRMED_ALL_FIXES_VERIFIED`, exit code 0.
2. **Test Harness Integration (`package.json:51`):**
   Appended `terminal-split-hydration-probe.cjs` to `smoke:terminal`.
3. **Full Suite Execution:**
   - `npm run smoke:terminal`: 3/3 suites passed (Recovery Smoke, Renderer Smoke, Split Hydration Probe).
   - `npm run test:fast`: 203/203 unit and integration tests passed with 0 failures.
