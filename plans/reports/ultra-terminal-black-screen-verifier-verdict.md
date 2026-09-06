# Ultra Verifier Stage: Authoritative Diagnostic Evaluation & Winner Selection
## Defect: AntiFan Terminal Split View Black Screen ("Terminal đen ko thấy gì")

- **Document ID:** `ultra-terminal-black-screen-verifier-verdict`
- **Role:** Ultra Verifier (Principal Systems & Reliability Engineer)
- **Date:** 2026-09-06
- **Status:** APPROVED & AUTHORITATIVE VERDICT
- **Evaluation Target:** 5 Independent Diagnostic Candidates (`candidate-1` through `candidate-5`)
- **Primary Source Codebases:** `src/renderer/standalone.js`, `src/main/browser/terminal-manager.ts`, `src/main/browser/native-tab-host.ts`
- **Telemetry Evidence:** `plans/reports/terminal-black-screen-evidence-packet.md`, Desktop Capture Telemetry (Electron PID 24484), Windows 11 winpty / Electron 43.4.0

---

## 1. Executive Summary & Authoritative Winner Declaration

An exhaustive, evidence-grounded review was conducted across five independent diagnostic candidates evaluating the root cause of the AntiFan Terminal Split View Black Screen defect. The symptom—where the lower pane (`Terminal (Split)`) rendered a blank black `#070b11` screen with a solitary unfocused hollow cursor `[]` at `(row 0, col 0)` despite an active background process (`powershell.exe` -> `hrv theme dev`) holding 1,529 bytes of output, followed by an instantaneous full-screen recovery when `assets/main.js.liquid` was saved at 12:24:25—was rigorously audited against live code telemetry, Chromium rendering mechanics, and node-pty transport contracts.

### Winner Declaration: **Candidate E** (`plans/reports/ultra-terminal-black-screen-candidate-5.md`)
**Candidate E is declared the authoritative, undisputed WINNER with an overall score of 9.80 / 10.0.**

Candidate E outperforms all rival candidates by delivering the only **complete, four-part causal synthesis** that accounts for every physical and temporal phenomenon:
1. **The Hydration Guard Fallacy (`standalone.js:922`):** Strict equality check `snapshot === undefined || snapshotSeq === undefined` failing when `mountSplit` passes `snapshot = ''` and `snapshotSeq = 0`, permanently bypassing `api.getFullBuffer(splitSessionId)`.
2. **Lifecycle Asymmetry:** The architectural disparity between the persistent, CSS-toggled `terminalPool` (`Map<string, TerminalPaneItem>`) and the ephemeral, disposable singleton `splitTerm` (`splitTerm.dispose()` on every tab switch).
3. **The Asynchronous IPC Void & Misrouting (`standalone.js:1597-1601` vs `2289-2305`):** Initial startup chunks arriving during `await api.splitTerminal()` and being misrouted to an orphaned dummy pane in `terminalPool`.
4. **Idle Process Starvation & Delayed Delta Healing:** Explaining why the terminal remained frozen (because `hrv theme dev` entered an idle `chokidar`/`fs.watch` loop emitting 0 bytes) and why it woke up at 12:24:25 (the subsequent file change produced chunk seq 15, triggering `handleSequenceGap()`, which queried `api.getTerminalDelta()` and replayed all historical chunks from `SessionDeliveryJournal`).

Furthermore, Candidate E provides the most **surgical, regression-free implementation plan**—requiring four focused edits strictly within `src/renderer/standalone.js` without touching backend IPC contracts—and establishes full architectural parity between the split pane and the primary terminal.

---

## 2. Comprehensive Evaluation Matrix & Comparative Scoring

The five candidates are mapped to their anonymized designations and scored across the four weighted criteria (25% each, scale 1.0 – 10.0):

| Candidate Identifier | Candidate File & Focus | C1: Evidence Grounding (25%) | C2: Rival Elimination (25%) | C3: Specificity of Cause (25%) | C4: Actionable Plan (25%) | Overall Score (/10) | Final Rank |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Candidate E** | `candidate-5.md`<br>*(Holistic Causal Synthesis & Surgical Cutover)* | **9.8** | **9.7** | **9.9** | **9.8** | **9.80** | **RANK 1 (WINNER)** |
| **Candidate D** | `candidate-1.md`<br>*(Hydration Guard Strict Equality & Stale Cache)* | **9.5** | **9.5** | **9.6** | **9.4** | **9.50** | **RANK 2** |
| **Candidate C** | `candidate-3.md`<br>*(IPC Races & Initial Chunk Misrouting)* | **9.3** | **9.0** | **9.4** | **8.8** | **9.13** | **RANK 3** |
| **Candidate B** | `candidate-2.md`<br>*(Lifecycle Asymmetry: Singleton vs Pool)* | **9.2** | **9.0** | **8.8** | **8.2** | **8.80** | **RANK 4** |
| **Candidate A** | `candidate-4.md`<br>*(Geometry, Resizing Races & xterm States)* | **8.8** | **9.0** | **7.5** | **7.8** | **8.28** | **RANK 5** |

$$\text{Overall Weighted Score} = \frac{\text{C1} + \text{C2} + \text{C3} + \text{C4}}{4}$$

---

## 3. In-Depth Critical Evaluation per Candidate

### Candidate A (`plans/reports/ultra-terminal-black-screen-candidate-4.md`)
- **Core Thesis:** Terminal Geometry, Resizing Races, DOM Layout Timing, and xterm.js Rendering States.
- **Strengths:** 
  - Outstanding low-level breakdown of xterm.js internal rendering mechanics. It mechanically proves why the cursor in Image #1 rendered as a hollow rectangle `[]` (unfocused state where xterm uses `strokeRect` instead of `fillRect`) and why there was no scrollbar thumb (active buffer `baseY === 0`, `lines.length === rows`, and `scrollHeight <= clientHeight`).
  - Correctly details the VT standard `80x24` constructor initialization in xterm.js and the deferred `requestAnimationFrame` resize loop in `applySplitRatio()`.
- **Flaws & Weaknesses:**
  - **Over-attribution to Geometry:** Candidate A claims the geometry race condition is a co-equal primary cause of the black screen. In reality, if `atomicHydrateSplitPane` had successfully retrieved and written the 1,529-byte buffer, the text would have rendered immediately (albeit wrapped to 80 columns until rAF refitted it), rather than rendering a solid black screen. Geometry mismatch caused wrapping anomalies, not 0-byte buffer starvation.
  - **Omission of Backend Caching Mechanics:** Fails to analyze `src/main/browser/terminal-manager.ts:677-687` (`appendData` vs `emitSession`), leaving unexplained why the renderer's `sessions` array contained an empty buffer.
  - **Weak Verification:** The verification section lacks automated smoke commands or executable test scripts.
- **Criterion Scores:** C1: 8.8 | C2: 9.0 | C3: 7.5 | C4: 7.8 $\to$ **Total: 8.28** (Rank 5)

---

### Candidate B (`plans/reports/ultra-terminal-black-screen-candidate-2.md`)
- **Core Thesis:** Lifecycle Divergence between Main Terminal Pool (`terminalPool`) and Disposable Singleton (`splitTerm`).
- **Strengths:**
  - Provides a brilliant architectural comparison between `terminalPool` (persistent `Map`, CSS `.active` toggling, zero DOM deallocation, continuous background stream ingestion) and `splitTerm` (disposable global singleton, destroyed via `unmountSplit()` and recreated from scratch on every tab switch).
  - Traces `src/main/browser/terminal-manager.ts:677-687` to explain that `appendData()` streams data chunks but omits `emitSession()` to avoid IPC flooding, resulting in stale cached `splitBuffer: ""` in the renderer.
  - Identifies the early-return trap in `mountSplit` (`standalone.js:1494: if (splitId === sessionId && splitTerm) return;`) which prevents self-healing when session metadata updates arrive.
- **Flaws & Weaknesses:**
  - **Superficial Treatment of Async Split Creation:** Under-analyzes the race condition during initial split creation (`await api.splitTerminal`), omitting how initial chunks are misrouted to dummy panes.
  - **Overly Broad Remediation:** Proposes rewriting split terminals into a fully pooled architecture (`splitTerminalPool`) as part of the fix. While architecturally elegant as a long-term aspiration, it introduces high regression risk for a tactical bugfix and fails to provide a minimal surgical diff.
  - **Lacks Automated Verification:** Proposes manual tab-switching steps without automated test suite execution.
- **Criterion Scores:** C1: 9.2 | C2: 9.0 | C3: 8.8 | C4: 8.2 $\to$ **Total: 8.80** (Rank 4)

---

### Candidate C (`plans/reports/ultra-terminal-black-screen-candidate-3.md`)
- **Core Thesis:** IPC Race Conditions, Initial Prompt Misrouting, and Asynchronous Split Creation.
- **Strengths:**
  - Deepest and most accurate analysis of the asynchronous IPC void during `api.splitTerminal(activeId)`.
  - Meticulously traces `src/renderer/standalone.js:2284-2306` to prove that because `splitId` is empty while `await api.splitTerminal` is pending, initial chunks for `split-2` are routed into `getOrCreateTerminalPane('split-2', '', 0, false)`, creating a hidden phantom pane inside `terminalPool` that is subsequently purged and destroyed by `syncTerminalPool`.
  - Excellent disproof matrix for rival hypotheses.
- **Flaws & Weaknesses:**
  - **Over-indexes on Creation Race:** Centers the defect almost entirely around the initial split creation race. It downplays the tab-switching scenario, where the user switches away from an existing split tab and returns to find it black.
  - **Brittle Fix Strategy:** Proposes pre-registering string prefixes (`sessionId.startsWith('split-')`) and manual queue pushing in `onTerminalData`, which introduces state-tracking complexity and potential memory leaks if the split fails to mount.
  - **Missing Regression Test Commands:** Does not cite the existing `node test/e2e/terminal-renderer-smoke.cjs` suite.
- **Criterion Scores:** C1: 9.3 | C2: 9.0 | C3: 9.4 | C4: 8.8 $\to$ **Total: 9.13** (Rank 3)

---

### Candidate D (`plans/reports/ultra-terminal-black-screen-candidate-1.md`)
- **Core Thesis:** Hydration Guard Strict Equality, Buffer Invalidation, and Stale State in `standalone.js` and `terminal-manager.ts`.
- **Strengths:**
  - Exceptional evidence grounding with exhaustive citation of line numbers in both frontend and backend files.
  - Formulates a definitive JavaScript type-coercion truth table for line 922 (`if (snapshot === undefined || snapshotSeq === undefined)`), demonstrating why `"" !== undefined` and `0 !== undefined` mathematically forced the renderer to skip `api.getFullBuffer()`.
  - Unpacks the full causal chain: guard bypass, `appendData` omitting `emitSession()`, initial chunk misrouting, and idle process starvation.
  - Incorporates concrete automated verification commands (`node test/e2e/terminal-renderer-smoke.cjs`).
- **Flaws & Weaknesses:**
  - **Fix Incompleteness in Part 2:** Proposes changing `mountSplit`'s signature to `snapshot = undefined`. While helpful for calls relying on default arguments, it does not protect against calls from `renderTabs` (`standalone.js:2165`), which explicitly pass `targetSession.splitBuffer` (which is already `""` in memory).
  - Slightly less unified architectural synthesis than Candidate E, treating the failure modes as three disconnected bugs rather than an integrated structural symptom.
- **Criterion Scores:** C1: 9.5 | C2: 9.5 | C3: 9.6 | C4: 9.4 $\to$ **Total: 9.50** (Rank 2)

---

### Candidate E (`plans/reports/ultra-terminal-black-screen-candidate-5.md`) — THE WINNER
- **Core Thesis:** End-to-End Holistic Causal Synthesis & Surgical Cutover Plan.
- **Strengths:**
  - **Flawless Mechanical Synthesis:** Seamlessly unifies all four failure modes (Hydration Guard Fallacy, Disposable Singleton Lifecycle, Async Creation Race, and Idle PTY Starvation) into a single cohesive, deterministic timeline with an illuminating Mermaid flowchart.
  - **Minute-by-Minute Telemetry Grounding:** Traces the exact second-by-second execution of the 12:24:25 file change on `assets/main.js.liquid`, showing how `node.exe` (PID 108) woke up, winpty streamed chunk seq 15, `processIncomingChunk` caught the gap ($15 > 0 + 1$), `handleSequenceGap` called `api.getTerminalDelta('split-2', 1, 1)`, `SessionDeliveryJournal` returned chunks 1..15, and xterm replayed the entire 1,529-byte backlog in a single frame.
  - **Ironclad Rival Elimination:** Systematically refutes WebGL context loss (cites `attachWebglAddon` returning `null`), CSS collapse (cites computed dimensions and cursor DOM attachment), process crash (cites full OS process tree under PID 24484), and ANSI corruption (cites inspection of raw transcript).
  - **Architectural Parity Insight:** Discovers that while main panes execute `syncPaneWithBackend` upon attachment (`standalone.js:1204`), `mountSplit` completely omitted backend view reconciliation (`syncSplitPaneWithBackend`).
  - **Surgical, Zero-Regression Fix:** Delivers four self-contained, high-taste code modifications strictly in `src/renderer/standalone.js` that solve the root causes without requiring any changes to backend transport or risking regressions in main terminal panes.
  - **Multi-Gate Verification Matrix:** Provides five distinct verification gates (Cold Split Creation, Idle Watcher Survival, Tab Switching Persistence, Delta Re-sync on Activity, Close/Unsplit Cleanup) with explicit observable invariants.
- **Flaws & Minor Deductions:**
  - Minor: Could have explicitly paired its 5 live verification gates with the automated runner command `node test/e2e/terminal-renderer-smoke.cjs` (as Candidate D did).
- **Criterion Scores:** C1: 9.8 | C2: 9.7 | C3: 9.9 | C4: 9.8 $\to$ **Total: 9.80** (Rank 1 - WINNER)

---

## 4. Deep Comparative Analysis Against Rubric

### Rubric 1: Evidence Grounding (25%)
- **Image #1 Grounding:** Candidates A, D, and E excel at explaining why Image #1 showed a hollow cursor `[]` at `(row 0, col 0)` and no scrollbar. Candidate E provides the most comprehensive physical-to-code correlation table, matching DOM element IDs (`#terminal-split`, `#terminal-split-host`), computed CSS dimensions (~1568px × ~132px), and xterm cursor layer state (`CursorLayer.strokeRect` due to blurred focus).
- **12:26 Sudden Recovery Grounding:** Candidates B, C, D, and E all correctly identify the sequence gap recovery mechanism (`handleSequenceGap` -> `getTerminalDelta` -> `SessionDeliveryJournal`). However, Candidate E's timeline trace is the most mathematically and mechanically precise, tracing sequence numbers ($0 \to 15$), timestamps (12:24:25), process PIDs (108), and journal chunk arrays.

### Rubric 2: Rival Hypothesis Elimination (25%)
All five candidates correctly identified that WebGL context loss was impossible because `attachWebglAddon` is explicitly hardcoded to return `null` in `standalone.js:969-972`. However, Candidates D and E went further by providing verifiable empirical proofs for all four rival hypotheses:
1. **WebGL Context Loss:** Refuted by code (`attachWebglAddon` returns `null`), live top pane rendering, and recovery without GPU re-initialization.
2. **CSS Layout / Sizing Collapse:** Refuted by container geometry (~1568px × ~132px), visible header, and xterm cursor rendering (which strictly requires `clientWidth > 0` and `clientHeight > 0`).
3. **Process Crash / Zombie PTY:** Refuted by live process hierarchy telemetry (`winpty-agent.exe` PID 21856 -> `powershell.exe` PID 17600 -> `node.exe` PID 108) and `terminal-sessions.json` recording `state: "running"`.
4. **ANSI / Encoding Corruption:** Refuted by inspection of the raw 1,529-byte transcript and clean, uncorrupted rendering upon delta replay.

### Rubric 3: Specificity of Root Cause (25%)
Candidate E achieves the highest score (9.9) by synthesizing all four interdependent mechanical facets:
- **Why `api.getFullBuffer` was skipped:** The strict guard `if (snapshot === undefined || snapshotSeq === undefined)` evaluated to `false` because `snapshot` was `""` (empty string) and `snapshotSeq` was `0`. Both operands are strictly not `undefined`.
- **Why `sessions` cache was stale:** In `terminal-manager.ts:677-687`, `appendData()` deliberately omits `this.emitSession()` during regular streaming to prevent IPC saturation at 60Hz. The renderer's cached `sessions` array only receives updates on coarse lifecycle events.
- **Why initial chunks were misrouted:** `api.splitTerminal` is asynchronous. While the renderer was awaiting the IPC promise, winpty output the PowerShell greeting. Because `splitId` was still `''`, `api.onTerminalData` misrouted those chunks to an orphaned dummy pane in `terminalPool`.
- **Why the terminal stayed black:** The command running was `hrv theme dev`—a quiescent file watcher. After its initial startup, it emitted zero bytes of stdout. Because no new chunks arrived, sequence gap detection was never triggered, leaving the terminal starved in an unhydrated 0-sequence state.

### Rubric 4: Actionable Fix & Verification Plan (25%)
Candidate E is superior because its remediation strategy is **strictly localized, high-taste, and regression-free**:
- Candidate B proposed an expansive rewrite of the split pane into a persistent pool, which carries substantial architectural risk and UI regression potential.
- Candidate C proposed string prefix matching in `onTerminalData`, which is fragile.
- Candidate D missed the `mountSplit` early return trap.
- **Candidate E's 4-step plan** resolves all issues cleanly within `src/renderer/standalone.js`:
  1. Relax the guard in `atomicHydrateSplitPane` to fetch whenever `!snapshot || snapshot.length === 0 || snapshotSeq === 0`.
  2. Modify `mountSplit` to allow re-hydration if the mounted terminal is unhydrated (`lastRenderedSeq === 0`) or receives newer data.
  3. Introduce `syncSplitPaneWithBackend` for architectural parity with `syncPaneWithBackend`.
  4. Clean up any misrouted dummy item in `terminalPool` upon `api.splitTerminal` resolution.

---

## 5. Authoritative Implementation & Verification Roadmap

Based on the winning diagnosis of Candidate E, the following four surgical edits and verification gates are approved for immediate execution:

### 5.1 Surgical Code Modifications (`src/renderer/standalone.js`)

#### Step 1: Relax Hydration Guard in `atomicHydrateSplitPane`
**File:** `src/renderer/standalone.js:922`
```javascript
// BEFORE:
if (snapshot === undefined || snapshotSeq === undefined) {

// AFTER:
if (!snapshot || snapshot.length === 0 || snapshotSeq === undefined || snapshotSeq === 0) {
  if (api?.getFullBuffer) {
    try {
      const res = await api.getFullBuffer(splitSessionId);
      if (splitSessionState.hydrationEpoch !== currentEpoch) return;
      if (res && typeof res.buffer === 'string' && res.buffer.length > 0) {
        snapshot = res.buffer;
        snapshotSeq = res.snapshotThroughSeq || 0;
      }
    } catch {}
  }
}
```

#### Step 2: Prevent Early Return in `mountSplit` When Unhydrated
**File:** `src/renderer/standalone.js:1494-1496`
```javascript
// BEFORE:
if (splitId === sessionId && splitTerm) return;

// AFTER:
if (splitId === sessionId && splitTerm) {
  // If splitTerm exists but has never rendered content or incoming snapshot has newer data, hydrate it!
  if ((splitSessionState.lastRenderedSeq === 0 || snapshotSeq > splitSessionState.lastRenderedSeq) && snapshot && snapshot.length > 0) {
    atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
  }
  return;
}
```

#### Step 3: Implement `syncSplitPaneWithBackend` & Call on Mount
**File:** `src/renderer/standalone.js:804` & `1562`
```javascript
// Add helper function:
async function syncSplitPaneWithBackend(splitSessionId) {
  if (!splitTerm || !splitSessionId) return;
  try {
    const res = await api?.syncTerminalView?.({
      sessionId: splitSessionId,
      knownGeneration: splitSessionState.sessionGeneration || 0,
      lastAppliedSeq: splitSessionState.lastRenderedSeq || 0,
    });
    if (!res) return;
    if (res.status === 'UP_TO_DATE') {
      splitSessionState.syncState = 'READY';
    } else if (res.status === 'DELTA' && Array.isArray(res.chunks)) {
      splitSessionState.syncState = 'RESYNCING';
      for (const c of res.chunks) {
        if (c.seq === splitSessionState.lastRenderedSeq + 1) {
          splitSessionState.lastRenderedSeq = c.seq;
          splitSessionState.pendingWriteAckSeq = c.seq;
          writeToSplitPane(c.data);
        }
      }
      splitSessionState.syncState = 'READY';
    }
  } catch {}
}

// In mountSplit (around line 1563):
atomicHydrateSplitPane(sessionId, snapshot, snapshotSeq);
syncSplitPaneWithBackend(sessionId);
```

#### Step 4: Clean Up Misrouted `terminalPool` Items in `splitTerminal`
**File:** `src/renderer/standalone.js:1597-1602`
```javascript
const newSplitId = await api.splitTerminal(activeId, { cols: targetCols, rows: targetRows });
if (newSplitId) {
  // Clean up any dummy pane created in terminalPool while splitTerminal was awaiting
  const misroutedItem = terminalPool.get(newSplitId);
  if (misroutedItem) {
    try { misroutedItem.term?.dispose(); } catch {}
    misroutedItem.paneEl?.remove();
    terminalPool.delete(newSplitId);
  }
  mountSplit(newSplitId);
}
```

---

### 5.2 Verification Protocol

Execution must pass all 5 live verification gates and the automated regression suite:
1. **Automated Smoke Suite:**
   - Execute `node test/e2e/terminal-renderer-smoke.cjs` to confirm IPC ack, sequence journal, and pool synchronization contracts pass with 0 errors.
2. **Cold Split Creation Gate:**
   - Click `#btnSplitTerminal` on an active tab. Shell prompt must render immediately (< 100ms) without solid black screen or frozen cursor at `(0, 0)`.
3. **Idle Watcher Tab-Switch Gate:**
   - Launch `hrv theme dev` in the split pane. Allow it to enter the idle watching state. Switch to another tab, wait 5 seconds, and switch back. The complete 1,529-byte transcript must appear instantly without touching any files.
4. **Delta Gap Recovery Gate:**
   - Modify a theme file (`assets/main.js.liquid`). Sync log lines must append smoothly to the bottom without screen flicker, buffer resets, or duplicate text.
5. **Clean Unsplit Teardown Gate:**
   - Click `✕` (`#btnCloseSplitPane`). Split pane and divider must unmount cleanly, main terminal must refit to 100% height, and no zombie winpty processes or unhandled rejection warnings must appear in DevTools console.

---

## 6. Final Verdict

| Final Decision | Selected Candidate | Final Quality Score | Implementation Path |
| :---: | :---: | :---: | :---: |
| **APPROVED** | **Candidate E** (`candidate-5.md`) | **9.80 / 10.0** | Execute 4-step surgical fix in `src/renderer/standalone.js` and verify via `terminal-renderer-smoke.cjs` |

*Report certified by Ultra Verifier.*
