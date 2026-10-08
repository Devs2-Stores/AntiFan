# Code Review (ultra): pending working tree on HEAD f2e84390

Date: 2026-10-08 · Mode: ak:code-review --pending --ultra (5 independent read-only reviewers, 1 verifier, union finalizer)
Scope: 17 modified + 1 new file under scripts/, src/, test/ (fix-ultra bundle D-01, D-02+D-10, D-04, D-07). Runner-rewritten telemetry JSON excluded.
Spec: plans/reports/fix-ultra-antifan-first-pass-20261008.md

## Controller spot-check (independent of verifier)
- VF-02 `scripts/antifan-omp-mcp.cjs:2775` — confirmed: guard compares against the proxy's own `recordBoundTab` cache, which equals the explicit tabId after first use, so server-side TARGET_MISMATCH never triggers the rebind.
- VF-03 `src/main/tools/browser-capabilities.ts:1682,1758,1869-1871` — confirmed: `receiptExecution` is only assigned in the catch branch; `report.execution === 'DEGRADED'` on the success path is dropped.
- VF-01 `src/main/browser/native-tab-host.ts:656` — confirmed as spec omission (plan "Residual Unknown 4" mandated EBUSY/EPERM backoff); note the sync rename is deliberate (version check atomicity), so the retry must stay on the same tick or re-check the version after each sleep.
- BF-01 `src/omp-hooks/theme-qa-gate.ts:740` — confirmed baseline: hook file is untouched by this diff; `QA_INCONCLUSIVE` falls into the clear branch. Pre-existing before D-04 but D-04 makes INCONCLUSIVE receipts more frequent, so it should be fixed in the same bundle.

---

# Independent Ultra Code Review & Union Finalization Report

**Repository:** `E:\Work\apps\AntiFan`  
**Base Commit:** `f2e84390` (HEAD) + Pending Working Tree (11 files, 63,738 chars diff)  
**Specification:** `plans/reports/fix-ultra-antifan-first-pass-20261008.md` (Commits D-01, D-02+D-10, D-04, D-07)  
**Role:** Single Verifier (`ak:code-review --pending --ultra`, union finalizer)  
**Mode:** Strictly Read-Only (no mutations, builds, or test invocations)

---

## 1. Candidate Scores and Evaluation (1–20)

| Candidate | Score | Signal Density | Coverage | Honesty | Spot-Check Verdict | One-Line Rationale |
|---|:---:|:---:|:---:|:---:|:---:|---|
| **Candidate A** | 14/20 | High | Narrow | Good | 3/4 confirmed (1 baseline, 1 rejected) | Exceptional focus on `native-tab-host.ts` and Windows atomic rename hazards, but completely omitted proxy and Theme QA changes, and mischaracterized `unhandledRejection` as fatal. |
| **Candidate B** | 17/20 | Very High | Broad | High | 4/4 confirmed (1 rejected on semantic grounds) | First-class discovery of the auto-rebind local cache trap and `everTransmitted` taint with airtight RPC trace evidence; slightly marred by an ungrounded edge case on empty-string env vars. |
| **Candidate C** | 16/20 | High | Medium | High | 4/4 confirmed (2 baseline) | Masterclass concurrency audit of `main-lifecycle-log.ts` queue mechanics and log inversion across rotation, but missed the proxy cache desynchronization bug and the `receiptExecution` defect. |
| **Candidate D** | 18/20 | Exceptional | Comprehensive | High | 4/4 confirmed (1 baseline) | Caught the critical `receiptExecution` telemetry omission and conducted an unparalleled deep-dive into Theme QA gate disarming, paired with strong test resource leak findings. |
| **Candidate E** | 18/20 | Exceptional | Exhaustive | Very High | 4/4 confirmed (all in-diff) | Most balanced end-to-end review across proxy, core, and test integrity; uncovered the missing spec test for successful auto-rebind and sanitized env key omissions with zero rejected findings. |

---

## 2. Spot-Verification Log (≥ 3 Citations per Candidate)

All spot-checks performed against the live files in the working tree at the cited line numbers:

### Candidate A
1. **`src/main/browser/native-tab-host.ts:14408-14410` (R3-01):** Verified. `persistTabsAsync` calls `const data = this.buildPersistData();` without checking `this.parkedPersistData`, whereas line 14497 in `persistSync()` enforces `this.parkedPersistData ?? this.buildPersistData()`. Classified as **CONFIRMED-BASELINE** (line was untouched in diff).
2. **`src/main/browser/native-tab-host.ts:656` (R3-02):** Verified. Line 656 in `writeSavedTabsDocumentAsync` calls `fs.renameSync(tempPath, filePath)` unconditionally once inside a `try/catch` block that immediately rethrows without retries or direct write fallback. Classified as **CONFIRMED** (in-diff).
3. **`src/main/diagnostics/main-lifecycle-log.ts:87, 131` (R3-03):** Verified. `admitLine` synchronously calls `rotateIfNeeded` at line 131, which executes `fs.renameSync(logFile, logFileOld)` at line 87 while `drainAsync` may hold an open handle via `fs.promises.appendFile`. Catch block at lines 89–91 swallows the error and zeroes `currentBytes`. Classified as **CONFIRMED** (in-diff).
4. **`src/main/browser/native-tab-host.ts:652-655` (R3-06):** Verified. If version mismatch occurs, `await fs.promises.rm(tempPath, { force: true })` runs inside the main `try` block. If `rm` throws on Windows, it jumps to line 659 and rethrows, rejecting `enqueueSavedTabsWrite` and halting persistence. Classified as **CONFIRMED** (in-diff).

### Candidate B
1. **`scripts/antifan-omp-mcp.cjs:2772-2776` (F-01):** Verified. Guard `explicitRequestedTabId !== resolveBoundTabId(currentBoot.tabId)` checks the proxy's local cache. If the local cache already matches the requested ID but the desktop server attachment drifted and threw `TARGET_MISMATCH`, auto-rebind is skipped and the error is rethrown. Classified as **CONFIRMED** (in-diff).
2. **`scripts/antifan-omp-mcp.cjs:2640, 2731` (F-02):** Verified. Line 2731 sets `everTransmitted = true`. Lines 2772–2783 execute auto-rebind and `continue` to attempt 1 without resetting `everTransmitted` or `lastTransmittedAttachmentId`. If authority reconnected during rebind, line 2640 throws `EXECUTION_UNCERTAIN`. Classified as **CONFIRMED** (in-diff).
3. **`scripts/antifan-agent.cjs:80-83` (F-05):** Verified. Code uses `process.env.ANTIFAN_DATA_ROOT ? path.join(...) : null`. An empty string `""` evaluates to falsy, causing `pinnedDirs` to evaluate to `[]` and falling back to the broad scan. Classified as **REJECTED** (by design; `""` represents unpinned in standard env semantics).
4. **`scripts/antifan-omp-mcp.cjs:81-82` (F-06):** Verified. Schema definitions lines 81–82 were updated with `['apply', 'clear', 'remove', 'revert']`, but grep confirms `invoke()` contains zero parameter normalization rewriting `'remove'` or `'revert'` to `'clear'`. Classified as **CONFIRMED** (in-diff).

### Candidate C
1. **`src/main/diagnostics/main-lifecycle-log.ts:85-92` (F-01):** Verified. `rotateIfNeeded` synchronously renames `logFile` to `logFileOld`. On Windows, concurrent async append causes `fs.renameSync` to throw `EBUSY`, which is swallowed, and `currentBytes` is reset to 0 without rotation. Classified as **CONFIRMED** (in-diff).
2. **`src/main/diagnostics/main-lifecycle-log.ts:148-154` (F-02):** Verified. `drainAsync` clears `pendingLines = []` before the returned promise resolves. However, code doc-comment lines 177–179 explicitly acknowledges this trade-off: *"A batch already in flight on the thread pool may land after a sync write or not at all; every record carries its own ts"*. Classified as **CONFIRMED-BASELINE** (documented design compromise).
3. **`src/main/diagnostics/main-lifecycle-log.ts:96-136` (F-04):** Verified. Pre-rotation lines sitting in `pendingLines` are not flushed before `rotateIfNeeded` renames the file on disk. When `drainAsync` subsequently runs, it writes those pre-rotation lines into the newly created post-rotation `logFile`. Classified as **CONFIRMED** (in-diff).
4. **`src/main/index.ts:5053-5057` (F-05):** Verified. `shutdown().finally(() => { recordLifecycleEvent('shutdown.complete', { code: 0 }); process.exit(0); });` does not call `lifecycleLogDrained()`. However, `process.exit` is intercepted by `installExitInterceptor` which flushes pending lines synchronously, and lines 5053–5057 were untouched in diff. Classified as **CONFIRMED-BASELINE**.

### Candidate D
1. **`src/main/tools/browser-capabilities.ts:251-253, 1860` & `src/omp-hooks/theme-qa-gate.ts:740` (R4-01):** Verified. `classifyTerminalVerdict` returns `'QA_INCONCLUSIVE'`. In `src/omp-hooks/theme-qa-gate.ts:740`, `reconcileReceipts()` clears `pendingEdits` for any verdict other than `QA_FAILED` or `QA_UNREADABLE`. When `theme.qa_validate` throws an exception, the receipt writes `verdict: 'QA_INCONCLUSIVE'`, clearing the gate. Classified as **CONFIRMED-BASELINE** (pre-existed at HEAD; guarded by existing test on line 196).
2. **`src/main/tools/browser-capabilities.ts:1682, 1758` (R4-03):** Verified. Line 1682 initializes `receiptExecution = 'COMPLETED'`. Line 1758 extracts `summary` from `report`, but never assigns `receiptExecution = report.execution`. When soft settle gaps occur, `report.execution` is `'DEGRADED'`, but line 1899 writes `execution: 'COMPLETED'` to disk. Classified as **CONFIRMED** (in-diff).
3. **`src/main/qa/theme-qa-workflow.ts:724-726, 750-752` (R4-02):** Verified. In-page scanner evaluation catch blocks append to `evidenceGaps` and do not increment `criticalCount`. When combined with the diff's new three-valued receipt mapping in line 1768, `verdict: 'INCONCLUSIVE'` with `criticalCount: 0` writes `QA_INCONCLUSIVE` and clears the gate. Classified as **CONFIRMED-BASELINE** (scanner logic pre-existed; gate impact stems from diff's three-valued receipt).
4. **`test/main/dispatch-socket-teardown.test.ts:215, 347-353` (R4-07):** Verified. `startHarness` calls `fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-teardown-root-'))` on line 215. `dispose()` on lines 347–354 kills processes and sockets but does not track or delete the directory, leaking scratch folders in `%TEMP%`. Classified as **CONFIRMED** (in-diff).

### Candidate E
1. **`scripts/antifan-omp-mcp.cjs:2775` (F-02):** Verified. Confirms Candidate B Finding F-01. `explicitRequestedTabId !== resolveBoundTabId(currentBoot.tabId)` prevents auto-rebind on server target drift. Classified as **CONFIRMED** (in-diff).
2. **`test/unit/omp-mcp-autoheal-binding.test.mjs:1` vs `test/main/mcp-proxy-bound-tab-rotation.test.ts:371-396` (F-03):** Verified. Commit 2 specification (`plans/reports/fix-ultra-antifan-first-pass-20261008.md:120`) explicitly mandated adding an effectful recovery test in `omp-mcp-autoheal-binding.test.mjs`. That file was never touched in the working tree, and the test in `mcp-proxy-bound-tab-rotation.test.ts` only sets up an unconditional mock failure for `browser.dom`, testing the failure-after-rebind double-refusal path. Zero tests exist asserting auto-rebind success. Classified as **CONFIRMED** (in-diff spec omission / test gap).
3. **`src/main/index.ts:158` (F-07):** Verified. Lead comment states *"See diagnostics/main-lifecycle-log.ts for why the appends are synchronous"*, but Commit 4 converted routine logging and child crashes to asynchronous queuing. Classified as **CONFIRMED** (in-diff).
4. **`test/main/dispatch-socket-teardown.test.ts:58` (F-08):** Verified. `DISCOVERY_ENV_KEYS` on lines 53–67 was updated in the diff to scrub `ANTIFAN_BRIDGE_PORT` and `ANTIFAN_BRIDGE_HOST`, but omits `ANTIFAN_BRIDGE_TOKEN` (which is read by `antifan-agent.cjs:49`). Classified as **CONFIRMED** (in-diff).

---

## 3. Validated Findings Table

| ID | Assigned Severity | File:Line | Title | Impact | Concrete Fix | Candidates | In-Diff vs Baseline |
|---|:---:|---|---|---|---|:---:|:---:|
| **VF-01** | **P1** | `src/main/browser/native-tab-host.ts:656` | Missing backoff retry on Windows `EBUSY`/`EPERM` during async atomic swap | Windows Defender / Search Indexer file locks cause `fs.renameSync` to throw. Async persist drops tab mutations without retrying. Violates Commit 4 spec (Residual Unknown 4). | Wrap `fs.renameSync` in a 3-attempt exponential backoff retry loop (25ms–50ms) catching Windows `EBUSY` and `EPERM`. | A (R3-02), B (F-03), C (F-03), D (R4-05), E (F-01) | **CONFIRMED** (in-diff) |
| **VF-02** | **P1** | `scripts/antifan-omp-mcp.cjs:2775` | Cache-desync trap: auto-rebind skipped when proxy cached tab ID matches requested ID | If desktop rotates active tab or connection re-pairs, server throws `TARGET_MISMATCH`. Proxy checks local cache, skips rebind, and rethrows error to caller. Defeats Commit 2 auto-rebind. | In `scripts/antifan-omp-mcp.cjs:2775`, delete `&& explicitRequestedTabId !== resolveBoundTabId(currentBoot.tabId)`. Trust server `TARGET_MISMATCH`. | B (F-01), E (F-02) | **CONFIRMED** (in-diff) |
| **VF-03** | **P1** | `src/main/tools/browser-capabilities.ts:1682, 1758` | `receiptExecution` never updated from `report.execution`, emitting `'COMPLETED'` on degraded runs | When soft settle gaps occur, `report.execution` is `'DEGRADED'`, but `receiptExecution` remains initialized to `'COMPLETED'`, persisting false completion telemetry. Violates Commit 3 spec. | In `browser-capabilities.ts:1758`, add `if (report.execution) receiptExecution = report.execution;`. | D (R4-03) | **CONFIRMED** (in-diff) |
| **VF-04** | **P2** | `scripts/antifan-omp-mcp.cjs:81-82, 2616-2625` | Missing proxy-head normalization of `'remove'` and `'revert'` to `'clear'` for `theme.style_override` | Calling `theme.style_override` with `'remove'` or `'revert'` against an un-restarted or older desktop bridge process fails server-side schema validation. Violates Commit 2 spec. | In `scripts/antifan-omp-mcp.cjs:invoke()`, normalize `effectiveParams.operation` to `'clear'` when it equals `'remove'` or `'revert'`. | B (F-06), C (F-07), D (R4-04), E (F-05) | **CONFIRMED** (in-diff) |
| **VF-05** | **P2** | `src/main/diagnostics/main-lifecycle-log.ts:87, 131` | Synchronous `rotateIfNeeded` in `admitLine` races in-flight async appends on Windows, causing `EBUSY` | If `rotateIfNeeded` calls `fs.renameSync` while `drainAsync` has an active `fs.promises.appendFile` in libuv, Windows throws `EBUSY`. Error is caught and `currentBytes` reset to 0, breaking file size limits. | Move log rotation check and execution into `drainAsync` on the serialized `drainChain` promise queue. | A (R3-03), B (F-04), C (F-01), D (R4-06), E (F-06) | **CONFIRMED** (in-diff) |
| **VF-06** | **P2** | `src/main/diagnostics/main-lifecycle-log.ts:96-136` | Log inversion: pre-rotation lines queued in `pendingLines` land in post-rotation log file | `admitLine` renames `logFile` to `logFileOld` before `pendingLines` are drained. When `drainAsync` runs, pre-rotation events are written to the brand new log file. | Serializing rotation inside `drainAsync` on `drainChain` (same as VF-05) ensures all queued lines are appended before rotation. | C (F-04) | **CONFIRMED** (in-diff) |
| **VF-07** | **P2** | `scripts/antifan-omp-mcp.cjs:2640, 2731, 2777` | `everTransmitted` taint across auto-rebind triggers false-positive `EXECUTION_UNCERTAIN` | When Attempt 0 is rejected with `TARGET_MISMATCH`, `everTransmitted` remains true. If auto-rebind reconnects under a new `attachmentId`, non-read-safe tools throw `EXECUTION_UNCERTAIN`. | Reset `everTransmitted = false` and `lastTransmittedAttachmentId = null` inside the auto-rebind recovery block before `continue`. | B (F-02) | **CONFIRMED** (in-diff) |
| **VF-08** | **P2** | `test/unit/omp-mcp-autoheal-binding.test.mjs:1` | Missing test for successful auto-rebind and effectful recovery (Spec Violation) | The spec required verifying effectful recovery (`anti.browser.evaluate`) in `omp-mcp-autoheal-binding.test.mjs`. That file was untouched, and `rotation.test.ts` only tests double refusal. | Add a test in `test/unit/omp-mcp-autoheal-binding.test.mjs` verifying that an effectful dispatch recovers and delivers results on attempt 1. | E (F-03) | **CONFIRMED** (in-diff spec omission) |
| **VF-09** | **P3** | `src/main/browser/native-tab-host.ts:14404-14440` | `persistTabsAsync` `do...while` loop lacks an upper iteration bound | If concurrent sync writes repeatedly bump `savedTabsWriteVersion`, `persistTabsAsync` continuously re-merges without backoff or an attempt limit. | Add a bounded retry counter (e.g. max 5 iterations) before yielding to `this.schedulePersist()`. | A (R3-05) | **CONFIRMED** (in-diff) |
| **VF-10** | **P3** | `src/main/browser/native-tab-host.ts:652-655` | Unhandled error in temporary file cleanup during async version conflict rejects task | In `writeSavedTabsDocumentAsync`, if `fs.promises.rm(tempPath)` throws during version conflict, the error rethrows and aborts `persistTabsAsync` instead of retrying. | Wrap `fs.promises.rm` in a non-throwing catch block. | A (R3-06) | **CONFIRMED** (in-diff) |
| **VF-11** | **P3** | `test/main/dispatch-socket-teardown.test.ts:215`<br>`test/main/mcp-proxy-bound-tab-rotation.test.ts:184`<br>`test/main/main-lifecycle-log-writes.test.ts:18`<br>`test/main/omp-mcp-adapter.test.ts:128, 184` | Scratch directory leakage in test harnesses without teardown cleanup | Multiple test suites allocate `fs.mkdtempSync` directories for `ANTIFAN_DATA_ROOT` / `ANTIFAN_RUNTIME_DIR` without cleaning them up in `dispose()`, `finally`, or `after()` hooks. | Record temporary directories in harness state and delete them via `fs.rmSync(path, { recursive: true, force: true })` in teardown hooks. | D (R4-07, R4-08), E (F-04) | **CONFIRMED** (in-diff) |
| **VF-12** | **P3** | `test/main/dispatch-socket-teardown.test.ts:58` | Incomplete `DISCOVERY_ENV_KEYS` array omits `ANTIFAN_BRIDGE_TOKEN` | Test harness scrubs discovery environment variables but omits `ANTIFAN_BRIDGE_TOKEN` (which is read by `antifan-agent.cjs:49`), leaving credential state partially un-scrubbed. | Add `'ANTIFAN_BRIDGE_TOKEN'` to `DISCOVERY_ENV_KEYS`. | E (F-08) | **CONFIRMED** (in-diff) |
| **VF-13** | **P3** | `src/main/index.ts:155-158` | Stale comment documenting synchronous lifecycle logging invariants | Lead comment states all fatal and rejection events append synchronously; in reality runtime and child crashes now queue asynchronously. | Update comment to clarify that only fatal errors and exit interceptors append synchronously. | E (F-07) | **CONFIRMED** (in-diff) |
| **VF-14** | **P3** | `src/main/qa/theme-qa-workflow.ts:467` | Inaccurate inline comment: "srcless placeholders" vs "srcless data-src" | Minor wording imprecision in code comment added in diff. | Update inline comment to "srcless data-src / lazysizes". | B (F-08) | **CONFIRMED** (in-diff) |
| **VF-15** | **P3** | `test/main/mcp-proxy-bound-tab-rotation.test.ts:388-397` | Auto-rebind test does not assert `idempotencyKey` rotation | Test verifies retry count and tab ID but does not assert that `idempotencyKey` changed between attempts. | Add assertion: `assert.notStrictEqual(attempts[0].params.idempotencyKey, attempts[1].params.idempotencyKey)`. | B (F-07) | **CONFIRMED** (in-diff) |

---

## 4. Baseline Follow-Ups (Real Findings Pre-Existing at HEAD)

These findings represent genuine architectural defects or gaps verified in the live repository, but because they pre-existed at HEAD `f2e84390` and were not introduced or modified by the pending diff, they are non-blocking for this commit bundle and tracked as follow-up items:

| ID | Severity | File:Line | Title & Architectural Context | Recommended Follow-Up Action | Raised By |
|---|:---:|---|---|---|:---:|
| **BF-01** | **P1** | `src/main/tools/browser-capabilities.ts:251-253, 1860`<br>`src/omp-hooks/theme-qa-gate.ts:740` | **Terminal capability exceptions emit `QA_INCONCLUSIVE` receipts that disarm `theme-qa-gate`**<br>`classifyTerminalVerdict(_err)` returns `'QA_INCONCLUSIVE'`. In `theme-qa-gate.ts:740`, `reconcileReceipts()` treats any verdict other than `QA_FAILED` or `QA_UNREADABLE` as clearing `pendingEdits`. When `theme.qa_validate` throws an exception (e.g. `CAPTURE_TIMEOUT`), the receipt has `verdict: 'QA_INCONCLUSIVE'` with `passed: null`, which disarms the gate and allows broken code to be committed. | Update `src/omp-hooks/theme-qa-gate.ts:740` to require `receipt.passed !== null && receipt.execution !== 'BLOCKED' && !receipt.errorCode` before clearing `pendingEdits`. | D (R4-01) |
| **BF-02** | **P2** | `src/main/qa/theme-qa-workflow.ts:724-752, 1240-1270` | **Total scanner evaluation failure degrades to `QA_INCONCLUSIVE` (0 criticals)**<br>If in-page browser evaluation fails for all scanners (e.g. CSP blocks script or DOM empty), missing scans are pushed to `evidenceGaps` and `criticalCount` is 0, yielding `verdict = 'INCONCLUSIVE'`. | In `theme-qa-workflow.ts`, if core scanners cannot run and no HTML source is available, treat as an unmeasured defect (`criticalCount = 1`, `verdict = 'FAIL'`). | D (R4-02) |
| **BF-03** | **P2** | `src/main/browser/native-tab-host.ts:14408-14410` | **`persistTabsAsync` ignores `parkedPersistData`**<br>`persistTabsAsync` calls `this.buildPersistData()` unconditionally, whereas `persistSync` at line 14497 calls `this.parkedPersistData ?? this.buildPersistData()`. If an async persist runs during detached shell close after tabs are cleared, it writes an empty tab list. | Update line 14410 to `const data = this.parkedPersistData ?? this.buildPersistData();`. | A (R3-01) |
| **BF-04** | **P2** | `src/main/index.ts:4910-4954, 5053-5057` | **Production shutdown sequence never awaits `lifecycleLogDrained()`**<br>`shutdown()` clean-up terminates without awaiting `lifecycleLogDrained()`. While `installExitInterceptor` synchronously flushes `pendingLines`, an in-flight async append on the threadpool could be truncated. | In `handleSignal` / `shutdown()`, add `await lifecycleLogDrained().catch(() => {});` prior to final exit. | C (F-05) |
| **BF-05** | **P3** | `src/main/index.ts:5039` | **Forced exit watchdog emits `shutdown.forceExit` without `{ sync: true }`**<br>`armForceExitWatchdog` emits `shutdown.forceExit` asynchronously before `process.exit(1)`. Although `installExitInterceptor` catches it, explicit synchronous logging on fatal watchdog exit is safer. | Pass `{ sync: true }` to `recordLifecycleEvent('shutdown.forceExit', ..., { sync: true })`. | C (F-06) |
| **BF-06** | **P3** | `src/main/diagnostics/main-lifecycle-log.ts:148-154` | **In-flight async batch dropped on immediate process exit**<br>When `drainAsync` passes lines to libuv, `pendingLines` is cleared. An immediate hard process exit could abort the background OS write. Documented trade-off in lines 177–179. | Informational; keep documented trade-off or add sync exit barrier. | C (F-02) |

---

## 5. Rejected Findings

| Proposed Finding | Cited Location | Raised By | Concrete Reason for Rejection |
|---|---|:---:|---|
| `unhandledRejection` recorded asynchronously instead of synchronously on fatal crash path | `src/main/index.ts:165` | Candidate A (R3-04) | **Contradicted by Node.js runtime behavior.** Attaching an `unhandledRejection` listener (`process.on('unhandledRejection', ...)`) prevents Node.js from terminating the process. Because `unhandledRejection` does not exit or terminate the process in AntiFan, recording it asynchronously avoids blocking the Electron main thread. Only fatal crash paths like `uncaughtException` require synchronous disk writes. |
| Falsy `ANTIFAN_DATA_ROOT=""` bypasses pinned directory confinement | `scripts/antifan-agent.cjs:78-87` | Candidate B (F-05) | **Contradicted by repository conventions and filesystem semantics.** In Node.js environment variables, an empty string `""` represents an empty or unset value. A pinned directory requires an actual directory path (e.g. `fs.mkdtempSync(...)`). If `ANTIFAN_DATA_ROOT=""` were treated as a pinned directory, `path.join("", "config")` would resolve to `"config"` relative to the current working directory, which would erroneously probe the project root. The falsy check `process.env.ANTIFAN_DATA_ROOT ? ... : null` correctly treats `""` as unpinned. |

---

## 6. Review Verdict

### **Verdict: REQUEST_CHANGES**

**Reasoning:**  
The pending diff implements the overarching architectural goals of Commits D-01, D-02+D-10, D-04, and D-07, and all Stage 1 Verifier Appendix corrections were incorporated. However, **three P1 (Must-Fix)** defects and **four high-signal P2 defects** directly in the pending diff prevent clean approval:

1. **`src/main/browser/native-tab-host.ts:656` (VF-01, P1):** Omission of the spec-mandated 3-attempt exponential backoff retry loop on Windows `fs.renameSync` exposes saved-tabs persistence to transient `EBUSY`/`EPERM` lock collisions from Windows Defender / Search Indexer.
2. **`scripts/antifan-omp-mcp.cjs:2775` (VF-02, P1):** The local cache check `&& explicitRequestedTabId !== resolveBoundTabId(currentBoot.tabId)` skips auto-rebind when the proxy's local cache matches the requested tab, completely breaking Attempt-0 auto-rebind on server target drift.
3. **`src/main/tools/browser-capabilities.ts:1682, 1758` (VF-03, P1):** `receiptExecution` is initialized to `'COMPLETED'` and never updated from `report.execution`, writing `execution: 'COMPLETED'` on degraded runs and violating the Commit 3 specification.
4. **`scripts/antifan-omp-mcp.cjs:invoke()` (VF-04, P2):** Missing client-side parameter normalization rewriting `'remove'` and `'revert'` to `'clear'` for `theme.style_override`, causing schema rejections on un-restarted desktop instances.
5. **`src/main/diagnostics/main-lifecycle-log.ts:87` (VF-05, P2):** Synchronous `rotateIfNeeded` in `admitLine` races in-flight asynchronous appends on Windows, causing `fs.renameSync` `EBUSY` collisions that silently reset `currentBytes` without rotating.
6. **`scripts/antifan-omp-mcp.cjs:2777` (VF-07, P2):** `everTransmitted` taint across auto-rebind causes false-positive `EXECUTION_UNCERTAIN` errors if authority re-pairs during rebind.
7. **`test/unit/omp-mcp-autoheal-binding.test.mjs` (VF-08, P2):** Complete omission of the spec-mandated unit test verifying successful auto-rebind and effectful recovery.

Applying the concrete remediations specified for **VF-01 through VF-08** will make this 4-commit bundle completely airtight, robust, and production-ready.

---

ultra: union=21/23 single_candidate_only=16