# Test Suite Audit (ultra): pending bundle on HEAD f2e84390

Date: 2026-10-08 · Mode: ak:test audit --ultra (5 independent read-only auditors, 1 verifier, union finalizer)
Scope: 10 touched test files + 7 touched source files of the Fix-ultra bundle (D-01, D-02/D-10, D-04, D-07), plus the 3 baseline-red e2e lanes and scripts/run-test-pipeline.mjs.
Inputs: plans/reports/code-review-ultra-antifan-first-pass-20261008.md (VF-01..VF-15), plans/reports/fix-ultra-antifan-first-pass-20261008.md.
Controller spot-checks: TA-01/VF-03 (browser-capabilities.ts:1758-1768 never copies report.execution into receiptExecution) and TA-08 (both stale .test.js files are git-tracked) confirmed against live tree.

Read-only audit: no test files were modified. Repairs are proposed, not applied.

---

# Independent Test Suite Audit Verification Report: AntiFan Pending Bundle (D-01 to D-10)

**Verifier:** Kongming (`TaVerifier` — Single Verifier for `ak:test audit --ultra`)  
**Target Repository:** `E:\Work\apps\AntiFan` (HEAD `f2e84390` + pending 4-commit working tree: D-01, D-02/D-10, D-04, D-07)  
**Verification Policy:** Strict Read-Only Empirical Verification (zero mutations, zero builds, zero test executions, zero MCP driver calls). Every citation was cross-checked directly against live repository files.

---

## 1. Candidate Scoring & Performance Evaluation

Each candidate audit was evaluated on a 1–20 scale across four orthogonal dimensions:
1. **Coverage of Scoped Suites:** Rigorous inspection of the 10 touched test files and 7 touched source files.
2. **Evidence Quality:** Grounded, live `file:line` citations verified against disk state.
3. **Signal Density:** High-value defect identification with concrete mutations, free of generic padding.
4. **Honesty About Gaps:** Transparent boundaries regarding unverified runtime behavior and platform constraints.

| Candidate | Scored Focus Area | Coverage (1–5) | Evidence (1–5) | Signal (1–5) | Honesty (1–5) | Total Score (1–20) | One-Line Rationale |
|:---|:---|:---:|:---:|:---:|:---:|:---:|:---|
| **Candidate A** *(Auditor 4)* | Discovery hermeticity, log drain ordering, temp leaks, VF confirmations | 4.5 | 4.5 | 4.5 | 4.5 | **18 / 20** | Excellent discovery and log drain analysis; uncovered cumulative log reading deception in `presented-view.test.ts`. |
| **Candidate B** *(Auditor 3)* | Settle gate, three-valued receipts, consumer gate hook, auto-rebind | 4.5 | 4.5 | 4.5 | 4.5 | **18 / 20** | Outstanding domain depth on Theme QA settle gate invariants and precedence inversion (`hasObservedFailure` vs `hasMissingEvidence`). |
| **Candidate C** *(Auditor 1)* | OMP adapter, proxy rotation, autoheal, affirmative rebind omission | 4.0 | 4.5 | 4.5 | 4.0 | **17 / 20** | Sharp detection of brittle string/regex checks in `omp-mcp-adapter.test.ts` and missing affirmative auto-rebind path. |
| **Candidate D** *(Auditor 5)* | Cross-cutting, redundant/outdated tests, baseline-red E2E root causes, CI pipeline selection | 5.0 | 5.0 | 5.0 | 5.0 | **20 / 20** | Exceptional, comprehensive audit: uncovered stale compiled CommonJS residue, CI runner credential leaks, and attributed all 3 baseline-red E2E suites. |
| **Candidate E** *(Auditor 2)* | Async main-thread I/O (`main-lifecycle-log.ts`, `native-tab-host.ts`), file locking, log inversion | 4.5 | 5.0 | 5.0 | 4.5 | **19 / 20** | Deepest technical analysis of async I/O persistence; proved simulated race in `project-window-persistence.test.ts` pre-dates disk I/O. |

### Spot-Verification Proof of Candidate Citations (≥ 3 verified per candidate)
- **Candidate A:**
  1. `test/main/theme-mcp-capabilities.test.ts:168-176`: Confirmed asserts `verdict`, `passed`, `criticalCount`, but completely omits `receipt.execution`.
  2. `test/main/mcp-proxy-bound-tab-rotation.test.ts:388-397`: Confirmed test asserts retry count and tab ID but omits `idempotencyKey` rotation.
  3. `test/unit/native-tab-host-presented-view.test.ts:28, 203, 637`: Confirmed `RUNTIME_DIR` is initialized at module scope and `main.log` is cumulatively read across tests without truncation.
  4. `scripts/antifan-agent.cjs:64-77`: Confirmed candidate search directories fall back to live workstation paths (`E:\Work\.antifan-data\config`) when `ANTIFAN_DATA_ROOT` is unpinned.
- **Candidate B:**
  1. `src/main/qa/theme-qa-workflow.ts:611-624`: Confirmed soft settle degrade branch requires `layoutStable !== false && gates?.fonts === true`, recording evidence gaps for network/images/dom.
  2. `src/main/qa/theme-qa-workflow.ts:1259-1265`: Confirmed `hasObservedFailure` strictly precedes `hasMissingEvidence` in determining summary verdict.
  3. `src/omp-hooks/theme-qa-gate.ts:722-743`: Confirmed `reconcileReceipts()` keeps gate armed on `QA_FAILED` / `QA_UNREADABLE`, but disarms on `QA_INCONCLUSIVE`.
  4. `test/main/mcp-proxy-bound-tab-rotation.test.ts:380`: Confirmed test sets `CALLER_TAB_ID !== BOOTSTRAP_TAB_ID`, never exercising `explicitRequestedTabId === currentBoot.tabId`.
- **Candidate C:**
  1. `test/main/omp-mcp-adapter.test.ts:50-70`: Confirmed brittle string assertions checking `content.includes('readBridge') === false` and `require('node:fs')` regex count.
  2. `test/unit/omp-mcp-autoheal-binding.test.mjs:1-466`: Confirmed zero occurrences of `evaluate` across the entire file (spec-mandated effectful recovery test omitted).
  3. `test/main/capability-catalogue.test.ts:1121-1168`: Confirmed tests only exercise `operation: 'apply'` and `'clear'`, omitting `'remove'` and `'revert'`.
- **Candidate D:**
  1. `test/main/native-tab-host-agent-tab-reap.test.ts:168-184`: Confirmed extensive monkeypatching of `host.shell` and `host.closeTab` hiding unhandled tab closure errors.
  2. `test/unit/native-tab-host-presented-view.test.js:195`: Confirmed stale pre-compiled file checked into source tree lacks `await lifecycleLogDrained()`.
  3. `scripts/smoke-theme-golden-live.cjs:648-665`: Confirmed Mutation B replaces text and fails on subpixel rendered glyph metrics (`deltaGeometry === 0`).
  4. `test/e2e/terminal-capsule-assign.test.ts:269, 884`: Confirmed `thrown instanceof UnknownChromeSenderError` fails across dual-evaluated module instances in Electron.
  5. `src/main/terminal-daemon/daemon-spawner.ts:210-234`: Confirmed `spawnViaWmi` executes `powershell.exe` with a 15-second timeout, bottlenecking under CI concurrency.
  6. `scripts/run-test-pipeline.mjs:174-185`: Confirmed `buildLaneEnv` spreads `parentEnv` without scrubbing `ANTIFAN_BRIDGE_TOKEN` or `ANTIFAN_BRIDGE_PORT`.
- **Candidate E:**
  1. `test/main/project-window-persistence.test.ts:683-690`: Confirmed `hostB.persistSync()` is executed synchronously inside `normalizeSavedTabsFileForMerge`, before `writeSavedTabsDocumentAsync` is entered.
  2. `src/main/diagnostics/main-lifecycle-log.ts:87, 131`: Confirmed synchronous `rotateIfNeeded` renames open file while libuv thread pool may have active append in flight.
  3. `src/main/browser/native-tab-host.ts:652-655`: Confirmed `await fs.promises.rm(tempPath)` throwing during version mismatch escapes without an inner catch block.
  4. `src/main/browser/native-tab-host.ts:14407-14438`: Confirmed `do { ... } while (this.hasPendingPersist && !this.isDisposed)` has no iteration bound.
  5. `test/main/native-tab-host-close-disposal.test.ts:472`: Confirmed inline comment admitting earlier tests polluted `main.log` with `tab-1` records.

---

## 2. Deduplicated Union of Test Audit Findings (TA-01 to TA-18)

### TA-01: Ineffective Verification of Receipt Execution Status in Theme MCP Capabilities (Masks VF-03)
- **Severity:** Critical (P1)
- **Target File:Line:** `test/main/theme-mcp-capabilities.test.ts:170-174` vs `src/main/tools/browser-capabilities.ts:1682, 1758, 1899`
- **Contract:** When `theme.qa_validate` completes with soft settle gaps (`layoutStable: true`, `fonts: true`, but `network: false` or `images: false`), the workflow returns `report.execution = 'DEGRADED'`, and the persisted receipt MUST record `execution: 'DEGRADED'`.
- **Concrete Mutation Missed:** In `src/main/tools/browser-capabilities.ts:1682`, `receiptExecution` remains initialized to `'COMPLETED'` and is never updated from `report.execution` at line 1758. The receipt written to disk records `execution: 'COMPLETED'`. The test asserts `receipt.verdict === 'QA_INCONCLUSIVE'`, `receipt.passed === false`, and `receipt.criticalCount === 0`, but never asserts `receipt.execution`. The test passes green with this bug present in live code.
- **Proposed Repair:** In `test/main/theme-mcp-capabilities.test.ts:174`, update mock workflow to return `execution: 'DEGRADED'` and add:
  ```typescript
  assert.strictEqual(receipt.execution, 'DEGRADED', 'Receipt must mirror workflow execution status');
  ```
- **Remaining Protection:** Verdict axis is tested; execution telemetry axis is completely unprotected.
- **Repair Risk:** Low (requires applying VF-03 fix concurrently).
- **Discovered By:** Candidates A (FINDING-INEFF-01), B (T-01), C (C3-1), D (T-INEFF-01), E (D-3).

---

### TA-02: Missing Coverage for Soft Settle Gaps Coexisting with Real Storefront Defects (Defect Softening Mask)
- **Severity:** Critical (P1)
- **Target File:Line:** `test/unit/theme-qa-fail-closed-adjudication.test.ts:179-210` vs `src/main/qa/theme-qa-workflow.ts:1259-1265`
- **Contract:** Observed critical storefront failures (`hasObservedFailure`: Liquid syntax errors, broken assets, server crashes) MUST take strict precedence over evidence gaps (`hasMissingEvidence`), yielding `verdict: 'FAIL'` and `criticalCount > 0`.
- **Concrete Mutation Missed:** In `src/main/qa/theme-qa-workflow.ts:1259-1263`, invert the verdict precedence:
  ```typescript
  if (hasMissingEvidence) {
    summaryVerdict = 'INCONCLUSIVE';
  } else if (hasObservedFailure) {
    summaryVerdict = 'FAIL';
  }
  ```
  Every existing test in `theme-qa-fail-closed-adjudication.test.ts` continues to pass green because Test 3b tests settle gaps on a clean page, while Test 1/Test 4 test defects on fully settled pages. If a storefront has a broken Liquid tag and an un-idle tracker, this mutation improperly softens the failure into `INCONCLUSIVE`, bypassing CI verification gates.
- **Proposed Repair:** Add Test 3d to `theme-qa-fail-closed-adjudication.test.ts` configuring `settleCapture` with `gates: { network: false, fonts: true, images: false, dom: true }` AND injecting a Liquid syntax error. Assert `report.summary.verdict === 'FAIL'`, `report.summary.criticalCount > 0`, and `report.execution === 'DEGRADED'`.
- **Remaining Protection:** Clean settle defect detection is covered; degraded-run defect detection is unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidate B (T-02) *(Single-Candidate Discovery)*.

---

### TA-03: Deceptive Concurrency Interleaving in Saved Tabs Async Persistence Test
- **Severity:** Critical (P1)
- **Target File:Line:** `test/main/project-window-persistence.test.ts:683-690` vs `src/main/browser/native-tab-host.ts:651, 14421-14429`
- **Contract:** `persistTabsAsync()` must write serialized tab projections off-thread (`await fs.promises.writeFile`), detect if a synchronous writer landed a newer document while that off-thread I/O was in-flight, discard the stale projection, and re-merge without data loss.
- **Concrete Mutation Missed:** In `test/main/project-window-persistence.test.ts:688`, `hostB.persistSync()` is executed synchronously *inside* `normalizeSavedTabsFileForMerge`, before `writeSavedTabsDocumentAsync` is even invoked. Consequently, `savedTabsWriteVersion !== expectedVersion` evaluates to true before any asynchronous disk I/O occurs. If `writeSavedTabsDocumentAsync` is mutated to replace `await fs.promises.writeFile` with blocking `fs.writeFileSync`, this test **continues to pass 100% green**, completely failing to detect regressions that re-block the main thread.
- **Proposed Repair:** In `project-window-persistence.test.ts`, hook `fs.promises.writeFile` with a deferred promise, trigger `hostB.persistSync()` while `writeFile` is genuinely pending on the libuv thread pool, resolve the promise, and assert that `hostA` re-merges.
- **Remaining Protection:** Stale projection detection before write is tested; true in-flight I/O collision is unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidate E (D-1) *(Single-Candidate Discovery)*.

---

### TA-04: Read-Safe Mock Masking `everTransmitted` Taint and Spec Omission of Effectful Recovery (VF-07 / VF-08)
- **Severity:** Critical (P1)
- **Target File:Line:** `test/main/mcp-proxy-bound-tab-rotation.test.ts:371-401` & `test/unit/omp-mcp-autoheal-binding.test.mjs:1` vs `scripts/antifan-omp-mcp.cjs:2640, 2731, 2777`
- **Contract:** When an explicit tab ID receives `TARGET_MISMATCH` on Attempt 0, auto-rebind via `anti.browser.rebind_target` must recover both read-safe and effectful capabilities (`anti.browser.evaluate`, `anti.agent.cursor.click`) on Attempt 1 without throwing `EXECUTION_UNCERTAIN`.
- **Concrete Mutation Missed:** In `scripts/antifan-omp-mcp.cjs:2731`, Attempt 0 sets `everTransmitted = true`. Auto-rebind rotates `boot.attachmentId`. On Attempt 1, line 2640 checks:
  ```javascript
  if (everTransmitted && boot.attachmentId !== lastTransmittedAttachmentId && !READ_SAFE_CAPABILITIES[method]) {
    throw transportError('EXECUTION_UNCERTAIN', ...);
  }
  ```
  Because `everTransmitted` was not reset upon rebind, any effectful tool throws `EXECUTION_UNCERTAIN`. Test 6 in `rotation.test.ts` only dispatches `anti.inspect.dom` (which is in `READ_SAFE_CAPABILITIES`) and only tests double failure. `test/unit/omp-mcp-autoheal-binding.test.mjs` was left untouched in the commit bundle. The test suite passes green while effectful auto-rebind crashes in production.
- **Proposed Repair:** Reset `everTransmitted = false; lastTransmittedAttachmentId = null;` upon rebind in `scripts/antifan-omp-mcp.cjs:2780`. Add an integration test in `test/unit/omp-mcp-autoheal-binding.test.mjs` verifying that `anti.browser.evaluate` recovers and executes on Attempt 1 after `TARGET_MISMATCH`.
- **Remaining Protection:** Read-safe failure retries are tested; effectful tool recovery is completely unprotected.
- **Repair Risk:** Low.
- **Discovered By:** Candidates A (FINDING-SPEC-01), B (T-03, T-12), C (C2-1), D (T-INEFF-03), E (D-2, U-1).

---

### TA-05: Auto-Rebind Retry Fails to Assert `idempotencyKey` Rotation (Masks VF-15)
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/mcp-proxy-bound-tab-rotation.test.ts:388-397` vs `scripts/antifan-omp-mcp.cjs:2782`
- **Contract:** When the proxy re-issues a dispatch after auto-rebind, it must mint a fresh `idempotencyKey` to prevent the bridge server's deduplication cache from returning the cached `TARGET_MISMATCH` refusal.
- **Concrete Mutation Missed:** In `scripts/antifan-omp-mcp.cjs:2782`, delete `identity = resolveInvocationIdentity(undefined, {});`. Attempt 1 re-uses the identical `idempotencyKey` from Attempt 0. Lines 392-397 in `mcp-proxy-bound-tab-rotation.test.ts` assert `attempts.length === 2` and `params.tabId === CALLER_TAB_ID`, but never assert `attempts[0].params.idempotencyKey !== attempts[1].params.idempotencyKey`. The test passes green.
- **Proposed Repair:** Add assertion in `test/main/mcp-proxy-bound-tab-rotation.test.ts:397`:
  ```typescript
  assert.notStrictEqual(
    attempts[0]!.params.idempotencyKey,
    attempts[1]!.params.idempotencyKey,
    'idempotencyKey must rotate between attempts after rebind'
  );
  ```
- **Remaining Protection:** Verifies attempt count and tab ID; invocation deduplication safety is untested.
- **Repair Risk:** Zero.
- **Discovered By:** Candidates A (FINDING-INEFF-02), B (T-04), C (C3-2), D (T-INEFF-02), E (U-2).

---

### TA-06: Complete Absence of Log Rotation and libuv Race Coverage in Lifecycle Journal Writes (Masks VF-05 / VF-06)
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/main-lifecycle-log-writes.test.ts:1-72` vs `src/main/diagnostics/main-lifecycle-log.ts:87, 131`
- **Contract:** The lifecycle logger must rotate `main.log` to `main.log.1` when size exceeds `MAX_LOG_BYTES` (2 MB) without corrupting file streams, losing queued pre-rotation entries, or throwing Windows `EBUSY` when an asynchronous background append is in-flight.
- **Concrete Mutation Missed:** 
  1. Synchronous `rotateIfNeeded` calling `fs.renameSync` while `drainAsync` has an active `fs.promises.appendFile` in libuv throws Windows `EBUSY`, catching and resetting `currentBytes = 0` without rotating (VF-05).
  2. `admitLine` renames `logFile` to `logFileOld` before `pendingLines` drain, writing pre-rotation lines into the brand new log file (Log Inversion, VF-06).
  `test/main/main-lifecycle-log-writes.test.ts` writes only ~150 bytes across 3 tests, completely ignoring rotation. Both bugs escape CI.
- **Proposed Repair:** Add a test in `test/main/main-lifecycle-log-writes.test.ts` appending records exceeding 2 MB during active asynchronous draining, asserting that `main.log.1` contains pre-rotation entries, `main.log` contains post-rotation entries, and no `EBUSY` errors occur.
- **Remaining Protection:** FIFO write order and sync exit flushing are tested; rotation integrity is unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidates A (FINDING-EDGE-01), B (T-08), C (C4-2), D (T-EDGE-01), E (I-1).

---

### TA-07: Deceptive Cumulative Log Assertions & Inter-Test Telemetry Contamination
- **Severity:** Important (P2)
- **Target File:Line:** `test/unit/native-tab-host-presented-view.test.ts:28, 203, 637, 659` & `test/main/native-tab-host-close-disposal.test.ts:472`
- **Contract:** Every test case verifying diagnostic lifecycle events MUST verify only the events emitted during that specific test case's execution.
- **Concrete Mutation Missed:** In `native-tab-host-presented-view.test.ts`, `RUNTIME_DIR` is created once at module level and never reset. Tests read `main.log` via `fs.readFileSync(...)` and check `journal.includes(...)` or regex matches. If Test N emits an event, Test N+1 can have its event emission completely broken or commented out (e.g. `src/main/browser/native-tab-host.ts:9835`); Test N+1 still passes because it matches the stale record from Test N. In `native-tab-host-close-disposal.test.ts:472`, tests compensate by minting synthetic IDs (`'tele-attempt'`, `'tele-dispose-1'`).
- **Proposed Repair:** Slice log reading by tracking file offset/line count before each test, or truncate `main.log` in a `beforeEach` hook after awaiting `lifecycleLogDrained()`.
- **Remaining Protection:** Tests verify that an event occurred somewhere in the test suite run, but cannot detect regression in specific transitions.
- **Repair Risk:** Low.
- **Discovered By:** Candidates A (FINDING-DECEPT-01), E (I-3, C-2).

---

### TA-08: Stale Pre-Compiled CommonJS Test Residue in Working Tree
- **Severity:** Important (P2)
- **Target File:Line:** `test/unit/native-tab-host-presented-view.test.js:195` & `test/unit/browser/tab-hibernation.test.js`
- **Contract:** Unit tests in the repository must be authored in TypeScript or pure ESM `.mjs`, compiled to `.compiled/`, and executed against `.compiled/`. Stale `.test.js` files must not exist in source trees.
- **Concrete Mutation Missed:** Live inspection confirms `test/unit/native-tab-host-presented-view.test.js` exists directly in `test/unit/`. Line 195 reveals that it is an older compiled artifact that **lacks `await lifecycleLogDrained()`**. Executing `node --test test/unit/*.test.js` runs this stale file, triggering race conditions against asynchronous disk I/O.
- **Proposed Repair:** Delete `test/unit/native-tab-host-presented-view.test.js` and `test/unit/browser/tab-hibernation.test.js`. Add `test/**/*.test.js` to `.gitignore`.
- **Remaining Protection:** None; stale files cause ghost failures and developer confusion.
- **Repair Risk:** Zero.
- **Discovered By:** Candidate D (T-OUT-01) *(Single-Candidate Discovery)*.

---

### TA-09: Workflow Decoupling in Theme MCP Receipt Tests
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/theme-mcp-capabilities.test.ts:165, 183` vs `src/main/qa/theme-qa-workflow.ts`
- **Contract:** Receipt generation in `theme.qa_validate` must accurately serialize real `ThemeQaWorkflow` execution reports to disk.
- **Concrete Mutation Missed:** In `theme-mcp-capabilities.test.ts:165`, the test provides a synthetic stub:
  ```typescript
  const workflow = { validate: async () => ({ summary: { passed: false, criticalCount: 0, verdict: 'INCONCLUSIVE' } }) } as any;
  ```
  This stub completely omits `execution`, `findings`, `checklist`, and `settingsRatchet`. It creates the deceptive appearance of full end-to-end receipt testing, while completely bypassing `ThemeQaWorkflow` and report serialization logic.
- **Proposed Repair:** Wire `ThemeQaWorkflow` (configured with `createMockPorts`) into `registerBrowserCapabilities` and assert the complete on-disk receipt structure.
- **Remaining Protection:** Tests basic switch statement on `summary.verdict`; full report serialization is unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidate B (T-05) *(Single-Candidate Discovery)*.

---

### TA-10: Missing Edge Case for Active DOM Mutations with Quiescent Layout (`domUnstable`)
- **Severity:** Important (P2)
- **Target File:Line:** `test/unit/theme-qa-fail-closed-adjudication.test.ts:178-245` vs `src/main/qa/theme-qa-workflow.ts:611-623`
- **Contract:** When layout is quiescent and fonts are loaded, but active DOM mutations persist (`gates: { dom: false, layoutStable: true, fonts: true }`), the workflow must degrade gracefully to `INCONCLUSIVE`, flag `receipt.domUnstable = true`, and append the evidence gap.
- **Concrete Mutation Missed:** In `src/main/qa/theme-qa-workflow.ts:611`, if `layoutQuiescent` is mutated to require `gates?.dom === true`, or if line 621 (`receipt.domUnstable = true`) is deleted, no existing test fails. Test 3b tests `dom: true` (degrade), and Test 3c tests `dom: false` with `layoutStable: false` (hard throw). Live themes with carousels or Livewire reactivity would trigger false `SETTLE_INCOMPLETE` hard errors.
- **Proposed Repair:** Add a unit test in `theme-qa-fail-closed-adjudication.test.ts` configuring `gates: { network: true, fonts: true, images: true, dom: false }` and `layoutStable: true`, asserting that it returns `verdict: 'INCONCLUSIVE'` and `domUnstable: true`.
- **Remaining Protection:** Network and image gates are tested; DOM mutation gate behavior is untested.
- **Repair Risk:** Low.
- **Discovered By:** Candidates A (FINDING-EDGE-03), B (T-06), D (T-EDGE-03), E (M-4).

---

### TA-11: Missing Auto-Rebind Coverage for Re-Pairing Cache-Desync Trap (Masks VF-02)
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/mcp-proxy-bound-tab-rotation.test.ts:380` vs `scripts/antifan-omp-mcp.cjs:2775`
- **Contract:** When the server returns `TARGET_MISMATCH`, the proxy must trust the server and trigger `rebind_target`, even if the proxy's local cached tab ID matches the caller's requested tab ID.
- **Concrete Mutation Missed:** In `scripts/antifan-omp-mcp.cjs:2775`, line contains `&& explicitRequestedTabId !== resolveBoundTabId(currentBoot.tabId)`. If desktop rotates or restarts, server rejects with `TARGET_MISMATCH`. If proxy cache still holds that ID, auto-rebind is skipped and the error is rethrown to the caller. Test 6 sets `CALLER_TAB_ID = 'tab-explicit-caller'` which differs from `BOOTSTRAP_TAB_ID = 'tab-1-boot'`. No test exercises `CALLER_TAB_ID === BOOTSTRAP_TAB_ID`. The bug is unexercised.
- **Proposed Repair:** Add a test case in `mcp-proxy-bound-tab-rotation.test.ts` where `CALLER_TAB_ID === BOOTSTRAP_TAB_ID`, the server returns `TARGET_MISMATCH`, and verify that `rebind_target` is dispatched.
- **Remaining Protection:** Explicit cross-tab retargeting is tested; re-pairing desync recovery is untested.
- **Repair Risk:** Zero.
- **Discovered By:** Candidates B (T-07), E (M-3).

---

### TA-12: Missing File Lock Resilience, Version Conflict Cleanup, and Bounded Loops in Saved Tabs Async Persist (VF-01, VF-09, VF-10)
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/project-window-persistence.test.ts:670-705` vs `src/main/browser/native-tab-host.ts:652-656, 14407-14438`
- **Contract:** Asynchronous tab persistence must retry with exponential backoff upon Windows `EBUSY`/`EPERM` locks during atomic swap, survive temporary file cleanup errors during version conflict, and terminate after a bounded number of version conflicts.
- **Concrete Mutation Missed:**
  1. `fs.renameSync` in `writeSavedTabsDocumentAsync:656` has no backoff retry; Windows Defender file locks throw `EBUSY`, permanently dropping the save.
  2. If `fs.promises.rm(tempPath)` throws during version conflict (line 653), the error escapes and rejects `persistTabsAsync`.
  3. `do ... while (this.hasPendingPersist && !this.isDisposed)` loops indefinitely under continuous version conflicts.
  `project-window-persistence.test.ts` tests only a single clean conflict and has zero tests for OS locking, cleanup errors, or retry bounds.
- **Proposed Repair:** Add tests in `project-window-persistence.test.ts` stubbing `fs.renameSync` to throw `EBUSY` (asserting 3-attempt backoff), stubbing `fs.promises.rm` to reject (asserting retry succeeds), and asserting bounded termination after 5 version conflicts.
- **Remaining Protection:** Single clean version conflict is tested; OS lock resilience and error recovery are unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidates A (FINDING-EDGE-02), C (C4-1), D (T-EDGE-02), E (I-2, M-1, M-2).

---

### TA-13: Incomplete Discovery Environment Scrubbing Leaking Credentials and Live Desktop Autohealing (VF-12 Extended)
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/dispatch-socket-teardown.test.ts:54-68`, `test/main/mcp-proxy-bound-tab-rotation.test.ts:51-65`, `test/main/omp-mcp-adapter.test.ts:1355-1367`, and `scripts/run-test-pipeline.mjs:174-185` vs `scripts/antifan-agent.cjs:49`
- **Contract:** Test harnesses and pipeline test runners MUST scrub all authentication tokens and connection environment variables so spawned proxy processes cannot authenticate against or leak data to a running developer desktop.
- **Concrete Mutation Missed:** `DISCOVERY_ENV_KEYS` in test suites and `buildLaneEnv` in `scripts/run-test-pipeline.mjs` scrub `PORT` and `PID`, but **omit `ANTIFAN_BRIDGE_TOKEN`** (which is read by `antifan-agent.cjs:49`). If a developer or CI shell has `ANTIFAN_BRIDGE_TOKEN` set, test child processes inherit the token and can auto-connect to live bridge instances.
- **Proposed Repair:** Unify environment scrubbing around the robust regex in `omp-mcp-autoheal-binding.test.mjs:47-51` (`delete env[key]` for all `^ANTIFAN_...`), and scrub bridge tokens in `buildLaneEnv`.
- **Remaining Protection:** Port and PID are scrubbed; token isolation is incomplete.
- **Repair Risk:** Zero.
- **Discovered By:** Candidates A (FINDING-SEC-01), B (T-11), C (C7-1), D (T-SEC-01, T-BLIND-01), E (S-1).

---

### TA-14: Oversimplified Monkeypatching in Agent Tab Reap Sweep Test Hiding Unhandled Destruction Errors
- **Severity:** Important (P2)
- **Target File:Line:** `test/main/native-tab-host-agent-tab-reap.test.ts:168-184` vs `src/main/browser/native-tab-host.ts:10280-10310`
- **Contract:** `runAgentTabReapSweep()` must evaluate active leases, verify reservations, safely invoke `closeTab()`, and survive exceptions on individual tab closures without aborting the background sweep loop.
- **Concrete Mutation Missed:** The test replaces `host.shell` and `host.automationHost` with trivial synthetic stubs. If `closeTab` throws an exception during WebContents destruction, the sweep loop aborts, abandoning all remaining tabs. The test cannot catch this failure mode because the stubbed shell never throws.
- **Proposed Repair:** Add a test verifying that when `closeTab` throws on tab 1 of 2, tab 2 is still evaluated and reaped, and the error is logged without crashing the timer.
- **Remaining Protection:** Happy path of agent reap telemetry is tested; destruction exception resilience is unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidate D (T-DEC-01) *(Single-Candidate Discovery)*.

---

### TA-15: Brittle Static Source String and Regex Matching in OMP MCP Adapter Test
- **Severity:** Minor (P3)
- **Target File:Line:** `test/main/omp-mcp-adapter.test.ts:50-70`
- **Contract:** The stdio proxy must delegate bridge discovery to `antifan-agent.cjs` and avoid inspecting arbitrary filesystem paths for bridge credentials.
- **Concrete Mutation Missed:** The test performs literal string matching (`content.includes('readBridge') === false`, `content.includes('bridge-dev.json') === false`, and regex counts on `require('node:fs')`). If an engineer adds an explanatory comment mentioning `"bridge-dev.json"`, or requires a secondary diagnostic module, this test fails without any behavioral regression. Conversely, dynamic path construction (`path.join('.anti' + 'fan')`) bypasses the test.
- **Proposed Repair:** Replace raw source-text pattern matching with an import spy asserting that `fs.readFileSync` is never invoked for config directories during proxy startup.
- **Remaining Protection:** Prevents naive static reintroduction of `readBridge()`.
- **Repair Risk:** Low.
- **Discovered By:** Candidate C (C1-1) *(Single-Candidate Discovery)*.

---

### TA-16: Missing Tests for `theme.style_override` Operation Synonyms (`remove` and `revert`) (Masks VF-04)
- **Severity:** Minor (P3)
- **Target File:Line:** `test/main/capability-catalogue.test.ts:1121-1168` & `test/main/theme-mcp-capabilities.test.ts` vs `scripts/antifan-omp-mcp.cjs:81-82, 2616`
- **Contract:** `theme.style_override` must accept `remove` and `revert` as valid synonyms for `clear`, normalizing them at the proxy before sending to the backend.
- **Concrete Mutation Missed:** The schema advertises `remove` and `revert`, but `antifan-omp-mcp.cjs:invoke()` never normalizes them to `clear`. Connecting to an older or un-restarted bridge causes schema validation failure. Existing tests only dispatch `'apply'` and `'clear'`, never exercising `'remove'` or `'revert'`.
- **Proposed Repair:** Add test dispatches for `operation: 'remove'` and `'revert'` in `test/main/capability-catalogue.test.ts`.
- **Remaining Protection:** `apply` and `clear` operations are tested.
- **Repair Risk:** Zero.
- **Discovered By:** Candidates B (T-09), C (C4-3), D (T-INEFF-04).

---

### TA-17: Systematic Scratch Directory Leakage Across 9 Test Suites (VF-11 Extended)
- **Severity:** Minor (P3)
- **Target File:Line:** 9 test files across `test/main/` and `test/unit/`
- **Contract:** Test suites allocating temporary scratch directories via `fs.mkdtempSync` MUST clean them up in `after()` or `dispose()` hooks.
- **Evidence:** Confirmed across 9 test suites:
  1. `test/main/dispatch-socket-teardown.test.ts:215` (`antifan-teardown-root-`)
  2. `test/main/mcp-proxy-bound-tab-rotation.test.ts:184` (`antifan-rotation-root-`)
  3. `test/main/main-lifecycle-log-writes.test.ts:18` (`antifan-lifecycle-log-`)
  4. `test/main/omp-mcp-adapter.test.ts:128, 184` (`antifan-no-bridge-` leaks on timeout)
  5. `test/main/native-tab-host-agent-tab-reap.test.ts:12` (`antifan-reap-runtime-`)
  6. `test/unit/native-tab-host-presented-view.test.ts:24` (`antifan-tabhost-runtime-`)
  7. `test/main/native-tab-host-close-disposal.test.ts:27` (`antifan-closedisposal-runtime-`)
  8. `test/unit/native-tab-host-tab-closed-telemetry.test.ts:24` (`antifan-tabclosed-runtime-`)
  9. `test/main/project-window-persistence.test.ts:46` (`tmp-project-window-persistence`)
- **Impact:** Leaves dozens of orphaned directories containing lock files and logs in `os.tmpdir()`, causing inode exhaustion and disk bloat.
- **Proposed Repair:** Add `fs.rmSync(dir, { recursive: true, force: true })` inside teardown hooks across all 9 suites.
- **Remaining Protection:** OS temp directory cleanup on reboot.
- **Repair Risk:** Zero.
- **Discovered By:** Candidates A (FINDING-LEAK-01), B (T-10), C (C8-1), D (T-SEC-02), E (C-1).

---

### TA-18: Discovered Bridge Test Exercises Only Negative Transport Path
- **Severity:** Minor (P3)
- **Target File:Line:** `test/main/omp-mcp-adapter.test.ts:1539-1580`
- **Contract:** When disk discovery finds a valid `bridge-dev.json`, the proxy must verify that the process is alive before attempting connection, and successfully connect if alive.
- **Concrete Mutation Missed:** The test writes an unused port (41998) to `bridge-dev.json` and asserts `CONNECT_FAILED`. It tests the negative transport rejection path, but never verifies: (1) connecting to a *live* discovered mock bridge without environment variables, or (2) filtering out dead PIDs to avoid 5-second connection timeouts on stale files.
- **Proposed Repair:** Add a test case with a live mock WebSocket server discovered via `bridge-dev.json`, and a test case verifying that a record with a dead PID is discarded immediately.
- **Remaining Protection:** Negative transport rejection is tested; affirmative discovery and dead PID pruning are unverified.
- **Repair Risk:** Low.
- **Discovered By:** Candidate C (Section 5.2) *(Single-Candidate Discovery)*.

---

## 3. Prior Code Review Findings (VF-01 to VF-15) Verification Status

The prior code review identified 15 findings. Below is their verification status and mapping to test suite findings:

| Prior ID | Severity | File:Line | Title | Verification Status | Test Suite Impact & Grounding |
|:---:|:---:|:---|:---|:---:|:---|
| **VF-01** | P1 | `src/main/browser/native-tab-host.ts:656` | Missing backoff retry on Windows `EBUSY`/`EPERM` during async atomic swap | **CONFIRMED** | Untested in `project-window-persistence.test.ts` (captured in **TA-12**). |
| **VF-02** | P1 | `scripts/antifan-omp-mcp.cjs:2775` | Cache-desync trap: auto-rebind skipped when proxy cached tab ID matches requested ID | **CONFIRMED** | Untested in `mcp-proxy-bound-tab-rotation.test.ts` (captured in **TA-11**). |
| **VF-03** | P1 | `src/main/tools/browser-capabilities.ts:1682, 1758` | `receiptExecution` never updated from `report.execution`, emitting `'COMPLETED'` on degraded runs | **CONFIRMED** | Test `theme-mcp-capabilities.test.ts:170` completely omits asserting `receipt.execution` (captured in **TA-01**). |
| **VF-04** | P2 | `scripts/antifan-omp-mcp.cjs:81-82, 2616` | Missing proxy-head normalization of `'remove'` and `'revert'` to `'clear'` for `theme.style_override` | **CONFIRMED** | Untested in `capability-catalogue.test.ts` (captured in **TA-16**). |
| **VF-05** | P2 | `src/main/diagnostics/main-lifecycle-log.ts:87, 131` | Synchronous `rotateIfNeeded` in `admitLine` races in-flight async appends on Windows, causing `EBUSY` | **CONFIRMED** | Untested in `main-lifecycle-log-writes.test.ts` (captured in **TA-06**). |
| **VF-06** | P2 | `src/main/diagnostics/main-lifecycle-log.ts:96-136` | Log inversion: pre-rotation lines queued in `pendingLines` land in post-rotation log file | **CONFIRMED** | Untested in `main-lifecycle-log-writes.test.ts` (captured in **TA-06**). |
| **VF-07** | P2 | `scripts/antifan-omp-mcp.cjs:2640, 2731, 2777` | `everTransmitted` taint across auto-rebind triggers false-positive `EXECUTION_UNCERTAIN` | **CONFIRMED** | Masked by read-safe mock in `rotation.test.ts` (captured in **TA-04**). |
| **VF-08** | P2 | `test/unit/omp-mcp-autoheal-binding.test.mjs:1` | Missing test for successful auto-rebind and effectful recovery (Spec Violation) | **CONFIRMED** | File was completely untouched in commit bundle (captured in **TA-04**). |
| **VF-09** | P3 | `src/main/browser/native-tab-host.ts:14404-14440` | `persistTabsAsync` `do...while` loop lacks an upper iteration bound | **CONFIRMED** | Untested in `project-window-persistence.test.ts` (captured in **TA-12**). |
| **VF-10** | P3 | `src/main/browser/native-tab-host.ts:652-655` | Unhandled error in temporary file cleanup during async version conflict rejects task | **CONFIRMED** | Untested in `project-window-persistence.test.ts` (captured in **TA-12**). |
| **VF-11** | P3 | Multiple test suites | Scratch directory leakage in test harnesses without teardown cleanup | **CONFIRMED & EXTENDED** | Extended from 4 suites to 9 suites across `test/main/` and `test/unit/` (captured in **TA-17**). |
| **VF-12** | P3 | `test/main/dispatch-socket-teardown.test.ts:58` | Incomplete `DISCOVERY_ENV_KEYS` array omits `ANTIFAN_BRIDGE_TOKEN` | **CONFIRMED & EXTENDED** | Extended to `buildLaneEnv` in `scripts/run-test-pipeline.mjs` (captured in **TA-13**). |
| **VF-13** | P3 | `src/main/index.ts:155-158` | Stale comment documenting synchronous lifecycle logging invariants | **CONFIRMED** | Minor documentation mismatch; code comment states all crashes append synchronously, but runtime crashes queue asynchronously. |
| **VF-14** | P3 | `src/main/qa/theme-qa-workflow.ts:605` | Inaccurate inline comment: "srcless placeholders" vs "srcless data-src" | **CONFIRMED** | Minor cosmetic wording imprecision in code comment. |
| **VF-15** | P3 | `test/main/mcp-proxy-bound-tab-rotation.test.ts:388-397` | Auto-rebind test does not assert `idempotencyKey` rotation | **CONFIRMED** | Verified: test only asserts attempt counts and tab ID (captured in **TA-05**). |

---

## 4. Root Cause Attribution of the 3 Baseline-Red E2E Suites

Candidate D (with corroboration from Candidates A and C) successfully attributed the root causes of the three baseline-red E2E suites:

### 1. `test/e2e/theme-golden-live.test.ts` (Mutation B Geometry Drift at HEAD)
- **Failure Mechanism:** The test drives live Chromium and executes `scripts/smoke-theme-golden-live.cjs:648-662`. Mutation B replaces card title link text `'Minimalist Chrono Watch'` with `'Classic Watch'`, asserting `structB.geometryWithinTolerance === true` and `structB.deltaGeometry === 0`.
- **Root Cause:** In live Chromium on Windows, replacing characters changes glyph advance widths and bounding box subpixel fractions. A subpixel rounding difference shifts `deltaGeometry` by 1 pixel, causing strict equality to fail. This is a fragile rendered-pixel assertion rather than an AntiFan capability defect.
- **CI Blind Spot:** Known flaky baseline E2E fixture constraint across different OS typography engines.

### 2. `test/e2e/terminal-capsule-assign.test.ts` (`UnknownChromeSenderError` at HEAD)
- **Failure Mechanism:** Router refuses unknown caller window, but `terminal-capsule-assign.test.ts:884` fails:
  ```typescript
  expect(thrown instanceof UnknownChromeSenderError, 'the router did not refuse an unknown sender with its own error class...');
  ```
- **Root Cause:** Dual module evaluation in Electron. In `terminal-capsule-assign.test.ts:269`, `UnknownChromeSenderError` is imported via `require(compiledMain('browser/ipc-router.js'))`. Inside `NativeTabHost`, `ipc-router.js` is resolved through the main process module cache. In JavaScript, `instanceof` checks constructor prototype reference identity; across two separate evaluations, `instanceof` evaluates to `false`. Thrown error actually has `thrown.name === 'UnknownChromeSenderError'` and `thrown.code === 'UNKNOWN_CHROME_SENDER'`.
- **CI Blind Spot:** Test harness module-identity defect, not a security routing failure.

### 3. `test/e2e/terminal-daemon-batching.test.ts` (Passes Isolated, Fails Under Concurrency)
- **Failure Mechanism:** Verifies daemon PTY output coalescing. Passes when run alone (`node --test .compiled/test/e2e/terminal-daemon-batching.test.js`), but fails or times out in aggregate pipeline runs.
- **Root Cause:** In `src/main/terminal-daemon/daemon-spawner.ts:210-245`, Windows daemon spawning executes PowerShell and WMI (`powershell.exe -Command ... New-CimInstance ... Invoke-CimMethod`). Under concurrent CI loads, PowerShell process cold-start and WMI process creation contend, frequently exceeding the 15-second timeout (`timeout: 15000`) or delaying handshake publication past `READY_TIMEOUT_MS`.
- **CI Blind Spot:** Concurrency-sensitive process execution bottleneck on Windows.

---

## 5. Dropped (Unvalidated / Non-Actionable) Findings

The following proposed candidate items were rejected from the final findings union:

1. **Candidate C Finding C5-1 (Redundant Target Refusal Checks in `rotation.test.ts:328-341`):**  
   - *Reason:* **DROPPED.** Candidate C claimed Test 4 is redundant with Test 2 and Test 3. However, Test 4 explicitly tests that closing an unrelated, non-default tab leaves the default bound tab override untouched. In authority state machines, asserting negative non-interference when other resources close is an essential orthogonal safety property, not dead redundancy.
2. **Candidate D Finding T-DIS-01 (Platform-Gated Test Skips):**  
   - *Reason:* **DROPPED.** Platform checks in `windows-acl-timeout-guard.test.ts` (`process.platform === 'win32'`) and monorepo package boundary checks in `core-health-service.test.ts` are legitimate conditional guards, not disabled broken tests.
3. **Candidate D Finding T-SEC-03 (Fixture Secret Audit):**  
   - *Reason:* **DROPPED.** Audited and verified safe: all searched tokens (`'discover-test-token'`, `'active-lease-token'`) are synthetic mocks, not live credentials.
4. **Candidate D Finding T-RED-01 (`test:unit` vs `test:fast` Redundancy in `package.json`):**  
   - *Reason:* **DROPPED.** `test:unit` is a dedicated developer convenience shortcut and is already excluded from `run-test-pipeline.mjs`.
5. **Candidate A Finding FINDING-SEC-02 (Broad Unpinned Disk Discovery in `antifan-agent.cjs:64-77`):**  
   - *Reason:* **DROPPED as a production code defect.** Allowing hand-invoked proxies outside terminals to discover running bridge instances is an intentional requirement of Commit D-01. The testing defect is the failure of test harnesses to pin an isolated `ANTIFAN_DATA_ROOT`, which is captured under **TA-13**.
6. **Pure Restatements of Prior Code Review Findings (VF-01, VF-02, VF-04, VF-05, VF-06, VF-07, VF-09, VF-10, VF-13, VF-14):**  
   - *Reason:* Preserved as "Confirms VF-xx" one-liners in Section 3 to avoid duplicative inflation of test audit findings.

---

## 6. Unresolved Questions

1. **Windows Defender File Locking Latencies:** Under active Windows Defender real-time scanning and Search Indexing, is a 3-attempt exponential backoff (25ms–50ms) sufficient to guarantee zero dropped tab mutations during `persistTabsAsync()`, or is a non-blocking queue requeue required?
2. **Theme MCP Receipt Test Architecture:** Should `test/main/theme-mcp-capabilities.test.ts` replace the synthetic in-memory workflow mock with a real `ThemeQaWorkflow` instance backed by port doubles, or should a dedicated integration test suite be created?
3. **Pipeline Environment Scrubbing:** Should `buildLaneEnv` in `scripts/run-test-pipeline.mjs` adopt the comprehensive regex scrubbing pattern from `omp-mcp-autoheal-binding.test.mjs` to protect all child lanes from ambient developer credentials?
4. **Baseline E2E Repair Strategy:** Should `terminal-capsule-assign.test.ts:884` replace `thrown instanceof UnknownChromeSenderError` with structural duck-typing (`thrown?.name === 'UnknownChromeSenderError' && thrown?.code === 'UNKNOWN_CHROME_SENDER'`) to eliminate the dual-module evaluation failure in CI?

---

ultra: union=18/25 single_candidate_only=7