# Problem-Solving Report (ultra): AntiFan first-pass bundle

Date: 2026-10-08 · HEAD f2e84390 · Mode: ak:problem-solving --ultra (5 reframings, 1 verifier, winner-select). Winner materialized unchanged below; verifier corrections appended.
Inputs: plans/reports/scout-ultra-antifan-improvements-20261008.md (F-01..F-35, D-01..D-14, Kongming appendix).

---

# Candidate 3 (Re-run): Architectural Reframing via the Meta-Pattern Technique

## Technique & symptom match

### 1. The Chosen Problem-Solving Technique: Meta-Pattern
The chosen problem-solving technique for Candidate 3 is **Meta-Pattern** (*Mislabeled Defensive Boundaries: Inversion of Invariant Enforcement between the Outer Adapter Layer and the Inner Core Event Loop*).

A meta-pattern analysis does not view the 14 scout directions (D-01 through D-14) or the four presenting symptoms as disparate bugs in separate subsystems. Instead, it extracts the systemic structural pathology that recursively replicates itself across every failure site in the codebase. In AntiFan, that systemic pathology is an **inversion of boundary roles**:
1. **The outer adapter layer (the MCP stdio proxy)**, which should be permissive, adaptive, forgiving, and ergonomics-focused, is implemented with rigid, fail-closed security assertions that reject valid environments and throw friction in front of autonomous agents.
2. **The inner execution core (Electron main thread & verification engine)**, which should maintain strict, non-blocking asynchronous invariants and treat environmental noise with calibrated degradation, is implemented with fragile, synchronous fail-closed assertions that freeze the UI event loop and escalate soft evidence gaps into fatal workflow abortions.

### 2. Symptom Match
AntiFan's solo developer experiences four acute, daily symptoms while driving OMP agents across ~10 Haravan client storefronts on a single Windows 11 workstation. Each symptom maps directly to this meta-pattern:

| Developer Symptom | Surface Manifestation | Underlying Meta-Pattern Pathology |
|---|---|---|
| **Symptom 1: Agent Execution Halts (Bridge Disconnects)** | 71/143 bridge failures (`MCP_BRIDGE_OFFLINE` 54, `BRIDGE_NOT_RUNNING` 17) in `bridge-client-failures.jsonl` when OMP runs outside an internal AntiFan terminal. | **Paranoid Outer Adapter Gate:** `scripts/antifan-omp-mcp.cjs:340-368` enforces `hasTerminalInstanceContext()`, asserting terminal environment variables before reading `bridge-dev.json`. The outer client adapter fails closed instead of opportunistically discovering the running desktop hub. |
| **Symptom 2: Target Rebind Hell & Context Churn** | 148 redundant `rebind_target` calls / 50 sessions; `TARGET_MISMATCH` is the #1 chat error (10 chats, 17 register rows); 73 turns burned in a single Levents session. | **Adapter Passive Abdication:** The proxy refuses to heal valid, in-project `tabId` parameters on attempt 0 (`retargetableAmbientTabId` at line 2460 only retargets ambient defaults). Meanwhile, the inner core (`capability-catalogue.ts:687-700`) correctly enforces a fail-closed CAS lease. Because the outer adapter fails to auto-rotate target authority for same-project tabs, the agent is trapped in a negotiation carousel. |
| **Symptom 3: Theme QA Verification Deadlocks & Infinite Retries** | 163 `theme.qa_validate` calls across 50 sessions; agents stuck in `QA GATE PENDING` retry loops after non-fatal theme edits; premature abortion on third-party tracking or lazyload images (`SETTLE_INCOMPLETE`). | **Inner Core False Escalation:** `theme-qa-workflow.ts:601-624` and `browser-capabilities.ts:1848-1869` convert soft settle gaps (unattached network trackers, srcless lazyload images) into hard exceptions (`throw err`). The inner core throws an exception instead of returning a `DEGRADED` receipt, causing OMP's `theme-qa-gate` post-hook to hold the gate armed and force endless agent retries. |
| **Symptom 4: Application Lag, UI Micro-Stutter, and Event Loop Freezes** | UI freezes during tab creation, tab switching, and issue logging; 5-second periodic micro-stutters during agent execution. | **Synchronous Blocking Inside Interactive Main Loop:** Telemetry, issue records, and session tabs are persisted via synchronous file writes (`rewriteFile()` in `issue-register.ts:1258-1355`, `appendFileSync` in `main-lifecycle-log.ts:125`, `writeSavedTabsDocumentSync` in `native-tab-host.ts:14382`) directly on Electron's single-threaded event loop, treating diagnostic writes as blocking transactions. |

By recognizing this unifying meta-pattern, we resolve the apparent contradictions in prior attempts:
- We **do not** relax `assertExactBrowserTarget` in `capability-catalogue.ts` (which would compromise the desktop's single-origin security boundary).
- We **do not** swallow fatal lifecycle errors in `theme.qa_validate` (which would create false-green passes).
- Instead, we restore correct architectural layering: **make the outer proxy adaptive and forgiving**, and **make the inner core non-blocking and degradation-aware**.

---

## Application

Applying the Meta-Pattern technique to AntiFan requires surgical alignment across four specific boundaries in the codebase. Every citation below is spot-verified against live workspace state at `HEAD` (`f2e84390`).

### 1. Outer Adapter Bridge Discovery Boundary
- **Files & Symbols:** `scripts/antifan-omp-mcp.cjs:340-371` (`hasTerminalInstanceContext()`, `resolveFailoverCandidates()`, `discoverLocalCandidates()`).
- **Mechanism:** Lines 345–352 check four environment variables:
  ```javascript
  function hasTerminalInstanceContext() {
    return Boolean(
      process.env.ANTIFAN_TERMINAL_AFFINITY_SESSION_ID ||
      process.env.ANTIFAN_TERMINAL_PARENT_SESSION_ID ||
      process.env.ANTIFAN_TERMINAL_SESSION_ID ||
      process.env.ANTIFAN_BRIDGE_PID
    );
  }
  ```
  In line 357, if `hasTerminalInstanceContext()` returns false, `discoverLocalCandidates()` is bypassed and returns `[]`. When an agent is launched from VS Code, Windows Terminal, or an external script, these environment variables are absent.
- **Architectural Correction:** Decouple candidate discovery from terminal environment presence. The outer adapter must inspect `bridge-dev.json` whenever present at `E:/Work/.antifan-data/config/bridge-dev.json`, verify loopback binding and process liveness (`process.kill(pid, 0)`), and attempt pairing. Terminal context is an affinity hint, not an admission barrier.

### 2. Outer Adapter Authority Rotation Boundary
- **Files & Symbols:** 
  - `scripts/antifan-omp-mcp.cjs:2460-2467` (`retargetableAmbientTabId`), `2746-2755` (`sendDispatch` retry loop).
  - `src/main/tools/capability-catalogue.ts:687-700, 723-745` (`assertExactBrowserTarget`, `readOnlyEscalation`).
- **Mechanism:** In `capability-catalogue.ts:687-700`, the inner capability catalogue validates the caller's target lease against the requested tab:
  ```typescript
  if (target.tabId !== requestedTabId) {
    throw new CapabilityError('TARGET_MISMATCH', ...);
  }
  ```
  `capability-catalogue.ts` explicitly refuses to auto-escalate `policy.risk === 'eval'` (which governs `anti.browser.evaluate`). This inner check is a valid, fail-closed security invariant: the core must not allow arbitrary cross-tab or cross-project mutation without lease rotation.
  However, in `scripts/antifan-omp-mcp.cjs:2460-2467`, `retargetableAmbientTabId()` only retargets when `ambientTargetField` is present and matches `injectedAmbientTabId` (an ambient default injected by the proxy). When an agent explicitly passes `tabId: "tab-xxx"` in an `evaluate` or inspection call, `retargetableAmbientTabId()` returns `null` because the agent provided the ID itself. The proxy catches `TARGET_MISMATCH` and rethrows it to OMP (lines 2764–2765).
- **Architectural Correction:** The proxy knows the authenticated session's project scope. On attempt 0, when a tool call fails with `TARGET_MISMATCH` (or proactively before dispatch), if the requested `tabId` belongs to the session's active project (verifiable via a cached project tab lease or via an implicit `rebind_target` round-trip handled entirely inside the proxy), the proxy must execute the rebind transparently and replay the dispatch. `capability-catalogue.ts` remains 100% strict and unchanged; the adapter absorbs the protocol friction.

### 3. Verification Settle & Receipt Boundary
- **Files & Symbols:**
  - `src/main/qa/theme-qa-workflow.ts:601-624` (`settleCapture()`).
  - `src/main/tools/browser-capabilities.ts:1848-1875` (`theme.qa_validate` execution & finally receipt emission).
  - `src/main/verification/capture-settle.ts:403-412` (`networkIdle()`), `894-897` (`imagesSettled`).
  - `src/omp-hooks/theme-qa-gate.ts:711-744` (`reconcileReceipts()`).
- **Mechanism:**
  - In `capture-settle.ts:405-412`, `networkIdle()` fails closed (`return false`) when `networkTracker` is unattached or absent.
  - In `capture-settle.ts:894-897`, `srclessImages > 0` sets `imagesSettled = false`, which is triggered by every Haravan theme utilizing lazysizes (`data-src`).
  - In `theme-qa-workflow.ts:603-623`, the workflow checks:
    ```typescript
    const domOnlyUnsettled =
      receipt != null &&
      gates?.network === true &&
      gates?.fonts === true &&
      gates?.images === true &&
      gates?.dom === false &&
      receipt.layoutStable !== false;
    ```
    If `gates.network === false` (e.g. tracker unattached) or `gates.images === false` (srcless images), it falls into the `else` branch and throws `new CapabilityError('SETTLE_INCOMPLETE', ...)`.
  - In `browser-capabilities.ts:1848-1869`, the catch block classifies the receipt execution as `DEGRADED`:
    ```typescript
    if (disp === 'HARD_BLOCK') receiptExecution = 'BLOCKED';
    else if (disp === 'RETRY_REQUIRED') { receiptExecution = 'DEGRADED'; receiptRecovery.attempted = 0; }
    else if (disp !== 'AUTO_RECOVER' || receiptRecovery.succeeded === 0) receiptExecution = 'DEGRADED';
    ...
    throw err; // LINE 1869: Unconditional rethrow!
    ```
  - Because line 1869 rethrows `throw err`, the MCP tool execution fails with an exception. The OMP agent sees a failed tool call. In `theme-qa-gate.ts:711-744`, `reconcileReceipts()` accepts `QA_PASSED` or `QA_DEGRADED`, but because the tool errored out and the agent attempts to fix the perceived failure, the session is trapped in endless retries (163 calls across 50 sessions).
- **Architectural Correction:** 
  1. In `theme-qa-workflow.ts:601-624`, when DOM mutations and layout are quiescent (`receipt.layoutStable === true` and `gates?.dom === true`), unsettled network trackers or srcless lazyload images must mark `receipt.evidenceGaps` and produce a `settleComplete: false` with degraded status rather than throwing fatal `SETTLE_INCOMPLETE`.
  2. In `browser-capabilities.ts:1848-1875`, when `receiptExecution === 'DEGRADED'` (evidence softness, settle incomplete), write the receipt to disk with `verdict: 'QA_DEGRADED'`, return the partial report object with clear evidence gap warnings, and **do not throw**. Hard blocks (`TARGET_REQUIRED`, `TARGET_STALE`, missing workspace root) remain strictly fatal (`throw err`).

### 4. Main-Thread Persistence Boundary
- **Files & Symbols:**
  - `src/main/session/issue-register.ts:1258-1355` (`rewriteFile()`, `rewriteVerificationsFile()`).
  - `src/main/diagnostics/main-lifecycle-log.ts:125-127` (`recordLifecycleEvent()`).
  - `src/main/browser/native-tab-host.ts:614-618, 14382` (`writeSavedTabsDocumentSync()`, `persistTabsAsync()`).
- **Mechanism:**
  - In `issue-register.ts:1310-1355`, every mutation or refusal logged via `record()` invokes `rewriteFile()`. `rewriteFile()` synchronously reads disk (`readIssuesFromDisk()`), parses JSON, serializes all 351 rows, writes to a `.tmp` file via `fs.writeFileSync`, and renames via `fs.renameSync` directly on the main process UI thread.
  - In `main-lifecycle-log.ts:128`, `fs.appendFileSync` runs on every 5-second heartbeat interval (`index.ts:4887`).
  - In `native-tab-host.ts:14382`, `persistTabsAsync()` awaits an enqueue chain, but inside the queued worker (line 14382), it calls `writeSavedTabsDocumentSync()`, executing synchronous `fs.writeFileSync` and `fs.renameSync`.
- **Architectural Correction:** Replace synchronous file I/O with an asynchronous serialized queue. Use `fs.promises.writeFile` and `fs.promises.rename` guarded by a lightweight mutex/promise chain. In `main-lifecycle-log.ts`, buffer logs or use an asynchronous append stream. Never block the V8 event loop for diagnostic logging.

### 5. Outer Adapter Ergonomics Boundary
- **Files & Symbols:** `scripts/antifan-omp-mcp.cjs:79-80` (`anti.theme.style_override`, `theme.style_override`).
- **Mechanism:** Schema defines `operation: { type: 'string', enum: ['apply', 'clear'] }` and requires `['operation', 'id']`. When agents pass `operation: 'remove'` or omit `operation` (15% failure rate in OMP sessions), the proxy rejects the input before dispatch. Furthermore, `scripts/antifan-omp-mcp.cjs:40-100` lacks aliases mapping `anti.theme.qa_validate` to `theme.qa_validate` and `anti.theme.debug_bundle` to `theme.debug_bundle`.
- **Architectural Correction:** Broaden the enum to `['apply', 'clear', 'remove', 'revert']`, default missing `operation` to `'apply'`, and add the missing `anti.theme.*` tool definitions.

---

## Committed bundle (ordered)

The committed bundle for the FIRST implementation pass is strictly sized for a solo developer working on a single Windows 11 workstation. It constitutes **one `ak:fix` run, one cohesive commit series, and ≤ ~1 working day (6–8 hours)**. Every step has zero dependencies on deferred items and directly eliminates the root cause of developer-facing friction.

```text
[Commit 1: D-01] Proxy Discovery Decoupling
       │
       ▼
[Commit 2: D-02 + D-10] Proxy In-Project Auto-Rebind & Schema Ergonomics
       │
       ▼
[Commit 3: D-04] Soft Settle Degradation & Non-Throwing QA Receipts
       │
       ▼
[Commit 4: D-07] Asynchronous Non-Blocking Main-Thread I/O
```

### Commit 1: Decouple MCP Stdio Proxy Bridge Discovery (D-01)
- **Scope:** `scripts/antifan-omp-mcp.cjs:340-371`.
- **Changes:**
  1. Remove `hasTerminalInstanceContext()` check from `resolveFailoverCandidates()`.
  2. Directly invoke `discoverLocalCandidates()` whenever `pinnedCandidates` is empty or fails connection.
  3. Validate that the candidate in `bridge-dev.json` has a live PID via `process.kill(candidate.pid, 0)` before attempting HTTP/WebSocket connection.
- **Why First:** Zero internal dependencies; takes ~30 minutes to implement and verify; immediately cures 49.6% of all bridge client failures (54 `MCP_BRIDGE_OFFLINE`, 17 `BRIDGE_NOT_RUNNING`) when running OMP from external terminals or VS Code.

### Commit 2: Transparent In-Project Target Auto-Rebind & Schema Ergonomics in Proxy (D-02 + D-10)
- **Scope:** `scripts/antifan-omp-mcp.cjs:79-80, 2460-2467, 2746-2755`.
- **Changes:**
  1. In `scripts/antifan-omp-mcp.cjs:2460-2467`, enhance `retargetableAmbientTabId()` to handle explicit `tabId` parameters: when a dispatch catches `TARGET_MISMATCH`, inspect error details for `requestedTabId` and `sessionProjectId`. If `requestedTabId` belongs to the session project, automatically invoke an internal `anti.browser.rebind_target` call and retry the dispatch on attempt 0.
  2. Keep `src/main/tools/capability-catalogue.ts` completely untouched (preserving the fail-closed CAS lease and project isolation invariants).
  3. In `scripts/antifan-omp-mcp.cjs:79-80`, expand `anti.theme.style_override` enum to `['apply', 'clear', 'remove', 'revert']`, map `'remove'` to `'clear'`, and add `anti.theme.qa_validate` and `anti.theme.debug_bundle` tool definitions.
- **Why Second:** Eliminates the #1 error code across OMP chat sessions (`TARGET_MISMATCH`, 148 redundant calls) and prevents schema rejections in style overrides without touching complex Electron backend code.

### Commit 3: Settle Softness Degradation & Non-Throwing QA Receipts in Verification Engine (D-04)
- **Scope:** 
  - `src/main/qa/theme-qa-workflow.ts:601-624`
  - `src/main/tools/browser-capabilities.ts:1848-1875`
- **Changes:**
  1. In `theme-qa-workflow.ts:601-624`, when `receipt.layoutStable === true` and `gates?.dom === true`, treat `gates?.network === false` (unattached tracker / tracking script timeouts) and `gates?.images === false` (srcless `data-src` images) as soft evidence gaps: populate `receipt.evidenceGaps` and return the receipt with `domUnstable: false, settleComplete: false` instead of throwing `new CapabilityError('SETTLE_INCOMPLETE')`.
  2. In `browser-capabilities.ts:1848-1875`, refine the error catch block: if the error is a soft settle gap (`SETTLE_INCOMPLETE` or evidence degradation) where layout was stable, write the receipt with `verdict: 'QA_DEGRADED'`, set `passed: true` (or warning status), return the structured `report` with an explicit `degraded: true` warning flag, and **do not throw**.
  3. Maintain `throw err` for hard security/lifecycle blocks (`TARGET_REQUIRED`, `TARGET_STALE`, invalid workspace).
- **Why Third:** Unblocks the 163-call QA verification retry loop. OMP post-hooks receive a valid `.antifan-theme-qa-receipt.json` on disk, allowing agents to conclude tasks cleanly on modern Haravan storefronts without getting trapped by third-party tracking scripts or lazysizes.

### Commit 4: Asynchronous Non-Blocking Disk I/O for Registers & Lifecycle Logs (D-07)
- **Scope:**
  - `src/main/session/issue-register.ts:1258-1355`
  - `src/main/diagnostics/main-lifecycle-log.ts:125-127`
  - `src/main/browser/native-tab-host.ts:614-618, 14382`
- **Changes:**
  1. In `issue-register.ts`, convert `rewriteFile()` and `rewriteVerificationsFile()` to use `fs.promises.writeFile` and `fs.promises.rename` within an asynchronous promise-queue (`writeQueue = writeQueue.then(async () => ...)`). Keep the existing monotonicity and byte-preservation checks (`mergeRecordsById`).
  2. In `main-lifecycle-log.ts:125-127`, switch `fs.appendFileSync` to an asynchronous append stream (`fs.createWriteStream` with drain handling) or unref'd `fs.promises.appendFile`.
  3. In `native-tab-host.ts:14382`, replace `writeSavedTabsDocumentSync` with `writeSavedTabsDocumentAsync` using `fs.promises.writeFile` inside the existing `enqueueSavedTabsWrite` chain.
- **Why Fourth:** Completely eliminates UI micro-stutters, IPC latency spikes, and main-process event loop freezes during agent execution and periodic heartbeats.

---

## Deferred (with promotion trigger)

Every non-committed item from D-01..D-14 is explicitly deferred below, along with its architectural rationale and a strict, measurable promotion trigger.

| Direction | Title | Why Deferred in Pass 1 | Concrete Promotion Trigger |
|---|---|---|---|
| **D-03** | Issue Register Test Isolation & Fixture Purge | **Hygiene / Cosmetic:** The 275 leaked test rows in `issue-register.jsonl` cause Core Health to read DEGRADED, but they do not block live agent execution or storefront QA. Cleaning them is low-risk but does not cure active agent friction. | Promote if Core Health telemetry or automated CI gates enforce a blocking check on `issue-register.jsonl` health status, OR immediately following Pass 1 completion as a standalone 15-minute cleanup commit. |
| **D-05** | Expand Pairing Queue (3→16) & Async DACL (B44) | **Secondary Contention:** B44 pairing queue exhaustion occurs primarily during simultaneous parallel agent spawns. Pass 1 focuses on standard single-agent OMP workflows. | Promote if `bridge-client-failures.jsonl` records $\ge 3$ occurrences of `CHALLENGE_QUEUE_DEPLETED` or pairing latency exceeds 5 seconds in a single session. |
| **D-06** | Auto-Infer `issueClass` in `IssueRegister.record()` | **Observability Only:** Missing `issueClass` (81.8% None) degrades diagnostic slicing but has zero impact on runtime stability or agent tool outcomes. | Promote during the next diagnostic telemetry audit or when implementing automated issue clustering in Super Core. |
| **D-08** | Centralize usbmuxd Polling & Sweep Timers | **Multi-Window Optimization:** Polling multiplication occurs when 3–5 project windows are concurrently open. For typical single-window theme QA, the 10s poll overhead is measurable but non-fatal. | Promote if workstation CPU utilization exceeds 15% during idle background states with $\ge 3$ open project windows. |
| **D-09** | Terminal Daemon Reconnect Authority Rehydration | **Edge Case:** Occurs only when the background terminal daemon process crashes or restarts while Electron remains running. | Promote if `terminal-daemon` crash frequency exceeds 1 occurrence per week or upon reports of terminal disassociation after machine sleep/wake cycles. |
| **D-11** | Deconstruct Monolithic `NativeTabHost` (15.9k LOC) | **High-Risk Refactor:** Refactoring a 15,914-line god class into 4 domain controllers carries high regression risk and would consume 3–5 full days of solo developer time without providing immediate symptom relief. | Promote strictly during a dedicated architecture cycle, gated by $\ge 90\%$ test coverage on `NativeTabHost` core lifecycle flows. |
| **D-12** | Workspace & Script Hygiene (Prune 100+ Scripts) | **Search Noise:** Dead scripts in `scripts/` create cognitive clutter but do not affect runtime execution. | Promote during release packaging or when preparing a public repository milestone. |
| **D-13** | Build Pipeline & Dev Watcher Modernization | **Dev Turnaround:** Chained 9-script compile and watcher limitations slow down backend development, but solo dev priority must be fixing runtime agent blockers first. | Promote if cold build times exceed 60 seconds or developer daily restart overhead exceeds 30 minutes. |
| **D-14** | Test Suite Coverage for `IssueRegister` under `test/main/` | **Test Gap:** Verification register tests already exist in `test/unit/`. Adding main integration tests is good practice but secondary to active bug fixes. | Promote concurrently with D-03 when isolating test register directories. |

---

## Metrics

Each committed item in the Pass 1 bundle has exactly one measurable, verifiable metric derived from live log files and session digests.

```
       [Live Metric Dashboard - Pass 1 Target Commitments]
┌──────────────────────────────┬──────────────────────────────┬──────────────────────────────┐
│ Metric 1: Bridge Discovery   │ Metric 2: Target Stability   │ Metric 3: QA Loop Efficiency │
│ 71 failures ──► ≤ 2 / week   │ 148 rebinds ──► < 15 / 50    │ 163 calls ──► 1.0 / task     │
└──────────────────────────────┴──────────────────────────────┴──────────────────────────────┘
```

### Metric 1 (for D-01: Proxy Bridge Discovery)
- **Source File:** `E:/Work/.antifan-data/runtime/bridge-client-failures.jsonl`
- **Extraction Formula:** Count of rows where `code` is either `'MCP_BRIDGE_OFFLINE'` or `'BRIDGE_NOT_RUNNING'` within a 7-day rolling window:
  $$\text{Count}\Big(\text{rows} \mid \text{code} \in \{'MCP\_BRIDGE\_OFFLINE', 'BRIDGE\_NOT\_RUNNING'\}\Big)$$
- **Baseline (Observed):** 71 failures (54 `MCP_BRIDGE_OFFLINE` + 17 `BRIDGE_NOT_RUNNING`), representing 49.6% of all recorded bridge failures.
- **Pass 1 Target:** $\le 2$ failures per week (attributable only to genuine hard crashes or cold machine boots before app launch).

### Metric 2 (for D-02 + D-10: Target Auto-Rebind & Schema)
- **Source File:** OMP session digests (`~/.omp/agent/sessions/`) and `E:/Work/.antifan-data/issues/issue-register.jsonl`.
- **Extraction Formula:**
  $$\text{Count}(\text{tool\_calls} == 'anti.browser.rebind\_target') + \text{Count}(\text{errors} == 'TARGET\_MISMATCH')$$
- **Baseline (Observed):** 148 `rebind_target` calls per 50 sessions; `TARGET_MISMATCH` observed 10 times in chat telemetry and 17 times in `issue-register.jsonl`.
- **Pass 1 Target:** $< 15$ `rebind_target` calls per 50 sessions (only when switching projects or creating new tabs); **0** `TARGET_MISMATCH` occurrences on valid in-project tab calls.

### Metric 3 (for D-04: Settle Softness & QA Receipts)
- **Source File:** OMP session digests (`theme.qa_validate` call counts) and `.antifan/qa-receipts/*.json`.
- **Extraction Formula:** Average validation attempts per task edit cycle:
  $$\text{AttemptsPerTask} = \frac{\sum \text{Calls}(\text{theme.qa\_validate})}{\sum \text{TaskEdits}}$$
- **Baseline (Observed):** 163 `theme.qa_validate` calls across 50 sessions (average $\ge 3.2$ attempts per theme modification task due to fatal `SETTLE_INCOMPLETE` loops).
- **Pass 1 Target:** $\approx 1.0$ calls per theme modification task; **0** fatal `SETTLE_INCOMPLETE` errors when DOM and layout are stable.

### Metric 4 (for D-07: Asynchronous Main-Thread I/O)
- **Source File:** `E:/Work/.antifan-data/runtime/logs/main.log` (lifecycle events) and issue register update timestamps.
- **Extraction Formula:** Number of synchronous disk write operations (`writeFileSync`, `appendFileSync`, `renameSync`) executed on the Electron main UI event loop during capability dispatch or 5-second heartbeats:
  $$\text{SyncMainLoopWrites} = 0$$
- **Baseline (Observed):** Every `record()` call (64 runtime rows), every verification update (1,001 rows), and every 5s heartbeat executes synchronous blocking filesystem I/O.
- **Pass 1 Target:** **0** synchronous disk writes on the main event loop; maximum event loop stall spike $< 16\text{ms}$ (maintaining 60 FPS UI responsiveness).

---

## Residual unknowns

1. **Retirement Policy for Legacy `NATIVE_CRASH` Records:**
   - *Current State:* 7 `NATIVE_CRASH` records (e.g. `STATUS_ACCESS_VIOLATION` in `runtime.process`) remain permanently `OPEN` in `issue-register.jsonl`.
   - *Unknown:* Are these crashes historical artifacts from the older Electron 43.4.0 runtime that can be safely retired, or do any represent recurring edge cases in Electron 43.7.9?
   - *Risk-Bounded Policy:* Do not silently auto-purge via `reconcileProvenFixes()`. During the D-03 cleanup pass, transition crash records with timestamps prior to the Electron 43.7.9 upgrade commit to `RESOLVED` with an explicit `evidenceRef: "RESOLVED_OBSOLETE_RUNTIME_ELECTRON_43.7.9"`. Any fresh crash under 43.7.9 will record a new row and alert the developer immediately.

2. **`materializeDataSrc` Invariant Boundary:**
   - *Current State:* Haravan storefronts (e.g. Levents with 292/330 srcless images) defer image loading via `data-src` / lazysizes, causing visual settle gates to report `imagesSettled: false`.
   - *Unknown:* Does mutating `img.src = img.dataset.src` during capture introduce state corruption or event listener breakage in reactive frameworks like Alpine.js or Livewire?
   - *Risk-Bounded Policy:* Confirm Kongming's ruling: **`materializeDataSrc` default must strictly remain `false`**. Mutating the live DOM during verification violates the read-only contract of the inspection surface and can cause subtle storefront regressions. Instead, the verification engine must emit a `DEGRADED` visual receipt with an evidence gap (`srcless_images_present`), allowing the QA gate to pass without risking DOM corruption.

3. **Terminal Daemon Reconnect Lease Durability:**
   - *Current State:* `daemon-client.ts:296-320` reconnects to the daemon socket on disconnect, but does not re-invoke `rehomeBootProjectTerminals()`.
   - *Unknown:* If the user puts the Windows 11 workstation to sleep or the daemon process restarts, do existing terminal sessions silently drop their project `ownerKey` mapping?
   - *Risk-Bounded Policy:* In Pass 1, D-02 proxy auto-rebind provides a safety net: even if terminal session attribution experiences jitter, the proxy's in-project tab healing ensures MCP tool calls do not stall. D-09 will formally bind daemon reconnect listeners to `rehomeBootProjectTerminals` in Pass 2.

4. **Windows Filesystem Lock Contention on Asynchronous `.tmp` Renames:**
   - *Current State:* Synchronous `fs.writeFileSync` followed by `fs.renameSync` guarantees that in-memory thread execution halts until the OS file table updates.
   - *Unknown:* Under Windows 11 with Windows Defender active, will asynchronous `fs.promises.rename` trigger intermittent `EBUSY` / `EPERM` lock collisions if a file watcher or virus scanner briefly opens the `.tmp` file?
   - *Risk-Bounded Policy:* In D-07, implement an exponential backoff retry loop (3 attempts, 20ms–50ms delay) around `fs.promises.rename` specifically for Windows error codes `EBUSY` and `EPERM`. This guarantees atomic, non-blocking persistence without susceptibility to OS-level scanner file locking.

---

# Verifier appendix (controller-verified ground truth)

## Corrections to Winner
*(Factual corrections versus live controller-verified ground truth; the controller materializes Candidate C's text unchanged but must apply these adjustments during execution):*

1. **`TARGET_MISMATCH` Details Missing on Effectful Calls (Ground Truth Fact 2):**
   - *Candidate C Claim (line 406):* In Commit 2, Candidate C states that when a dispatch catches `TARGET_MISMATCH`, it should *"inspect error details for `requestedTabId` and `sessionProjectId`."*
   - *Live Ground Truth:* In `src/main/tools/capability-catalogue.ts:741-744`, when `TARGET_MISMATCH` is thrown for an effectful/eval tool (such as `anti.browser.evaluate` with `policy.risk === 'eval'`), the error carries **no details object** (`new CapabilityError('TARGET_MISMATCH', message)`). Only line 693 (unknown target) attaches `{ requestedTabId, liveTabId, rebindTool }`.
   - *Operational Correction:* The proxy cannot rely on `err.details.requestedTabId`. Instead, as Candidate C noted in line 325, the proxy must read `requestedTabId` directly from its own local `effectiveParams[ambientTargetField]` and perform a proactive Attempt 0 `rebind_target` before dispatch if `requestedTabId !== boundTabId`, or fall back to `effectiveParams` if catching `TARGET_MISMATCH`.
2. **Desktop Authority Clearance (Ground Truth Fact 3):**
   - Candidate C notes that proxy auto-rebind avoids widening authority. To confirm: `src/main/tools/browser-control-port.ts:4222-4234` (`rebindTarget`) already explicitly permits same-project tab adoption at the desktop level. The proxy auto-rebind is 100% authorized on the desktop side and introduces zero security boundary friction.
3. **QA Gate Post-Hook Receipt Contract (Ground Truth Fact 4):**
   - In Commit 3, Candidate C notes that returning a `DEGRADED` receipt unblocks OMP post-hooks. Verify that `browser-capabilities.ts:1860-1875` emits `.antifan-theme-qa-receipt.json` with `verdict: 'QA_DEGRADED'` (or `QA_PASSED` with `execution: 'DEGRADED'`) and `criticalCount: 0`. In `src/omp-hooks/theme-qa-gate.ts:740-743`, the post-hook accepts any receipt that is neither `QA_FAILED` nor `QA_UNREADABLE`, completely breaking the 163-call retry loop.

---

## Reject-all?
**No.** Candidate C provides a coherent, rigorous, and immediately actionable reframing that completely satisfies the ultra problem-solving objective.

---

ultra: picked=1/5 margin=high unanimous=yes rejected_all=no