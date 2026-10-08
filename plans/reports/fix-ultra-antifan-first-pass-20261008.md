# Fix Plan (ultra): AntiFan first-pass bundle

Date: 2026-10-08 · HEAD f2e84390 · Mode: ak:fix --ultra (5 plans, 1 verifier). Winner unchanged below; verifier corrections appended and applied during execution.

---

# AntiFan Fix Ultra Plan: Grounded 4-Commit Bundle

This execution plan provides a verified, concrete roadmap for the 4-commit refactoring bundle (D-01, D-02+D-10, D-04, D-07) in `E:\Work\apps\AntiFan` (HEAD `f2e84390`). Every code anchor, invariant, and diagnostic path has been spot-verified against live source code at HEAD.

---

## Commit 1 (D-01)

### Files
- `scripts/antifan-omp-mcp.cjs` (anchors: lines 339–371)

### Changes
1. **Decouple Failover Candidate Discovery from Terminal Context:**
   In `scripts/antifan-omp-mcp.cjs:354-371`, modify `resolveFailoverCandidates()` to unconditionally invoke `discoverLocalCandidates()` rather than gating discovery behind `hasTerminalInstanceContext()`:
   ```javascript
   // [scripts/antifan-omp-mcp.cjs:354-371]
   function resolveFailoverCandidates() {
     const pinnedCandidates = resolveBridgeCandidates().map((c) => ({ ...c, pinned: true, provenance: 'env' }));
     const seen = new Set(pinnedCandidates.map((c) => `${c.host}:${c.port}`));
     // Unconditionally discover local bridge candidates registered on disk;
     // do not gate behind terminal instance context.
     const localCandidates = discoverLocalCandidates();
     const discovered = localCandidates
       .filter((c) => !seen.has(`${c.host}:${c.port}`))
       .filter((c) => {
         // Liveness probe: skip candidate if PID is definitively dead
         if (typeof c.pid === 'number' && c.pid > 0) {
           try { return process.kill(c.pid, 0) || true; } catch { return false; }
         }
         return true;
       });

     const boot = getBootstrap();
     if (boot && boot.port && (boot.secret || boot.token)) {
       const key = `127.0.0.1:${boot.port}`;
       if (!seen.has(key)) {
         pinnedCandidates.push({ host: '127.0.0.1', port: boot.port, token: boot.token || boot.secret, pinned: true, provenance: 'bootstrap' });
       }
     }
     return [...pinnedCandidates, ...discovered].sort(compareBridgeCandidates);
   }
   ```
2. **Update Lead Comments and Invariant Annotations:**
   Update `scripts/antifan-omp-mcp.cjs:339-342` to clarify that candidate discovery is delegated to `./antifan-agent.cjs` for all OMP proxy spawns (including hand-invoked CLI and VS Code instances) while remaining fail-closed by rejecting unauthenticated endpoints.

### Invariants
- **Delegated Discovery Invariant:** The proxy must never inspect `bridge-dev.json`, `bridge.json`, or `.antifan` files directly. Candidate enumeration stays strictly delegated to `discoverLocalCandidates` (`resolveBridgeCandidates` in `./antifan-agent.cjs:39-42`). This preserves the structural test assertion in `test/main/omp-mcp-adapter.test.ts:44-58` (`assert.strictEqual(content.includes('bridge-dev.json'), false)`).
- **Fail-Closed Security Invariant:** Candidates remain restricted to localhost (`127.0.0.1`); authentication tokens are verified via the bridge challenge handshake before dispatch.

### Risks
- Stale bridge files containing dead PIDs could cause brief connection timeout delays during proxy bootstrap. Mitigated by the synchronous `process.kill(c.pid, 0)` probe which instantly prunes dead process records.

### Tests
- Update `test/unit/omp-mcp-autoheal-binding.test.mjs` (or add a dedicated unit test suite in `test/unit/omp-mcp-discovery.test.mjs`) to verify that `resolveFailoverCandidates()` yields valid local candidates when all `ANTIFAN_TERMINAL_*` and `ANTIFAN_BRIDGE_PID` environment variables are undefined.
- Verify `test/main/omp-mcp-adapter.test.ts` to ensure AST/string assertions on `scripts/antifan-omp-mcp.cjs` remain green.

### Verify
```bash
npm run compile
node --test test/unit/omp-mcp-autoheal-binding.test.mjs
node --test .compiled/test/main/omp-mcp-adapter.test.js
```

---

## Commit 2 (D-02 + D-10)

### Files
- `scripts/antifan-omp-mcp.cjs` (anchors: lines 79–80, 66–67, 2460–2467, 2607–2614, 2746–2755)

### Changes
1. **Transparent Same-Project Auto-Rebind in Proxy Dispatch:**
   In `scripts/antifan-omp-mcp.cjs:2460-2467` and lines 2746–2755, implement proxy-level Attempt 0 rebind for caller-supplied target IDs:
   - Ground truth check: In `capability-catalogue.ts:741-744`, effectful tools throw `CapabilityError('TARGET_MISMATCH', message)` with **no details object**. Therefore, the proxy cannot read `err.details.requestedTabId`.
   - Instead, track the explicit `targetTabId` requested by the caller from `effectiveParams[ambientTargetField]` in `invoke`:
   ```javascript
   // In invoke() before sendDispatch loop (around line 2614):
   const requestedExplicitTabId = ambientTargetSuppliedByCaller && typeof effectiveParams[ambientTargetField] === 'string'
     ? effectiveParams[ambientTargetField].trim()
     : null;
   ```
   - In the catch block of `invoke()` (lines 2746–2755):
   ```javascript
   // [scripts/antifan-omp-mcp.cjs:2746-2755]
   if (err && (err.code === 'TARGET_MISMATCH' || String(err.message).includes('Tab ID mismatch')) && requestedExplicitTabId && !retargetedOnce && attempt < 2) {
     retargetedOnce = true;
     // Attempt proactive in-project rebind via internal RPC call
     try {
       const rebindResult = await sendInternalDispatch(currentBoot, 'anti.browser.rebind_target', { tabId: requestedExplicitTabId });
       if (rebindResult && rebindResult.tabId === requestedExplicitTabId) {
         recordBoundTab(requestedExplicitTabId);
         boundTabId = requestedExplicitTabId;
         identity = resolveInvocationIdentity(undefined, {});
         continue; // Retry dispatch on attempt 0 with new authoritative binding
       }
     } catch (rebindErr) {
       // If rebind fails (e.g. cross-project isolation violation), bubble original error honestly
     }
   }
   ```
2. **Schema Ergonomics for `anti.theme.style_override`:**
   In `scripts/antifan-omp-mcp.cjs:79-80`, expand the `operation` enum from `['apply', 'clear']` to `['apply', 'clear', 'remove', 'revert']`. In `invoke()`, normalize `'remove'` and `'revert'` to `'clear'` before parameter validation and dispatch.
3. **Expose Missing Tool Aliases:**
   In `scripts/antifan-omp-mcp.cjs:66-68`, add tool definition rows for `anti.theme.qa_validate` and `anti.theme.debug_bundle` mirroring `theme.qa_validate` and `theme.debug_bundle`, guaranteeing discovery across both namespaced prefixes.

### Invariants
- **Fail-Closed Desktop Authority Invariant:** Do NOT modify `src/main/tools/capability-catalogue.ts` or `src/main/tools/browser-control-port.ts`. `browser-control-port.ts:4222-4234` already permits same-project adoption. Any attempt to rebind across project boundaries is strictly rejected by the desktop control port with `TARGET_MISMATCH`.
- **Idempotency and Replay Guard:** Rebind retargeting is strictly bounded to at most one retry attempt (`!retargetedOnce && attempt < 2`).

### Risks
- If a caller supplies an invalid tabId that is repeatedly retargeted, it could consume one extra internal RPC hop. Mitigated by `retargetedOnce = true`.

### Tests
- Add a test case in `test/unit/omp-mcp-autoheal-binding.test.mjs` verifying that an effectful dispatch (`anti.browser.evaluate`) with an explicit un-bound tab ID in the same project automatically triggers `anti.browser.rebind_target` and recovers without throwing `TARGET_MISMATCH`.
- Test `anti.theme.style_override` with `operation: 'remove'` to verify schema acceptance and argument normalization.

### Verify
```bash
node --test test/unit/omp-mcp-autoheal-binding.test.mjs
```

---

## Commit 3 (D-04)

### Files
- `src/main/qa/theme-qa-workflow.ts` (anchors: lines 599–635)
- `src/main/tools/browser-capabilities.ts` (anchors: lines 1845–1885)

### Changes
1. **Settle Softness Degradation in Verification Engine:**
   In `src/main/qa/theme-qa-workflow.ts:601-624`, soften the settle gate condition:
   ```typescript
   // [src/main/qa/theme-qa-workflow.ts:601-624]
   if (!receipt || !receipt.settleComplete) {
     const gates = receipt?.gates;
     const layoutIsStable = receipt != null && receipt.layoutStable !== false;

     if (layoutIsStable) {
       // When layout is stable, treat unquiesced network (tracking scripts/pixels)
       // and unsettled images (srcless data-src / lazysizes) as soft evidence gaps.
       receipt.settleComplete = false;
       receipt.evidenceGaps = Array.isArray(receipt.evidenceGaps) ? receipt.evidenceGaps : [];

       if (gates?.dom === false) {
         receipt.domUnstable = true;
         receipt.evidenceGaps.push('DOM mutations remained active during settle window (domUnstable)');
       }
       if (gates?.network === false) {
         receipt.evidenceGaps.push('Network quiescence unverified: background telemetry or third-party traffic active');
       }
       if (gates?.images === false) {
         receipt.evidenceGaps.push('Srcless data-src images present during visual settle (materializeDataSrc: false)');
       }
     } else {
       // Layout shifts or fatal capture failures remain hard errors
       throw new CapabilityError(
         'SETTLE_INCOMPLETE',
         `Theme QA settle gate incomplete: layout unstable or capture failed (network=${receipt?.gates?.network}, fonts=${receipt?.gates?.fonts}, images=${receipt?.gates?.images}, dom=${receipt?.gates?.dom})${this.describeInflight(activeTarget, receipt)}`
       );
     }
   }
   ```
2. **Non-Throwing QA Receipt Emission:**
   In `src/main/tools/browser-capabilities.ts:1848-1875`:
   - When `theme-qa-workflow.ts` returns cleanly with `settleComplete: false` and `evidenceGaps`, `browser-capabilities.ts` returns the structured `ThemeQaReport` directly.
   - In `finally` (:1876-1913), the written receipt receives:
     - `verdict: 'QA_PASSED'` (or `'QA_DEGRADED'`)
     - `execution: 'DEGRADED'`
     - `criticalCount: 0`
     - `passed: true`
   - In `src/omp-hooks/theme-qa-gate.ts:740-743`, `reconcileReceipts()` treats any verdict other than `QA_FAILED` or `QA_UNREADABLE` as clearing the gate (`clearPending(root)`), eliminating the 163-call retry loop.
   - Hard lifecycle refusals (`TARGET_REQUIRED`, `TARGET_STALE`, `POLICY_DENIED`) retain `throw err;` and fail closed.

### Invariants
- **Read-Only Inspection Surface Invariant:** `materializeDataSrc` default remains strictly `false`. Do NOT mutate `img.src = img.dataset.src` on the live DOM, avoiding Alpine.js and Livewire hydration breakage.
- **Fail-Closed Gate Invariant:** Actual Liquid/code errors, settings regressions (`settingsRatchet.ok === false`), and unreadable receipts continue to emit `QA_FAILED` or `QA_UNREADABLE` and hold the gate armed.

### Risks
- Genuine layout shifts could be masked if `layoutStable` classification were inaccurate. Mitigated by strictly verifying `receipt.layoutStable !== false` before permitting soft degradation.

### Tests
- Update `test/main/theme-qa-workflow-differential-and-rollback.test.ts` to assert that simulated unquiesced network or srcless image gates return a valid `ThemeQaReport` with `evidenceGaps` rather than throwing `SETTLE_INCOMPLETE`.
- Run `test/main/qa-state.test.ts` and `test/unit/theme-qa-gate-hook.test.mjs`.

### Verify
```bash
npm run compile
node --test .compiled/test/main/qa-state.test.js
node --test .compiled/test/main/theme-qa-workflow-differential-and-rollback.test.js
node --test test/unit/theme-qa-gate-hook.test.mjs
```

---

## Commit 4 (D-07)

### Files
- `src/main/diagnostics/main-lifecycle-log.ts` (anchors: lines 119–133, 142–155)
- `src/main/browser/native-tab-host.ts` (anchors: lines 565–624, 14371–14385, 14435–14456)
- `src/main/session/issue-register.ts` (anchors: lines 1257–1355)

### Changes
1. **Asynchronous Buffered Lifecycle Event Logging:**
   In `src/main/diagnostics/main-lifecycle-log.ts:119-133`:
   - Replace blocking `fs.appendFileSync` with an asynchronous write-stream or unref'd `fs.promises.appendFile` for runtime events (including the 5-second heartbeat).
   - In `installExitInterceptor` (:142-155), maintain a synchronous fallback/flush (`fs.appendFileSync`) to ensure the final exit record is flushed to disk before the Node/Electron process terminates.
2. **Atomic Saved-Tabs Asynchronous Persistence:**
   In `src/main/browser/native-tab-host.ts:571-575, 14371-14383`:
   - Maintain the per-file serialization queue (`enqueueSavedTabsWrite`).
   - Keep the read-merge-write sequence atomic against concurrent window disposal (`persistSync`).
   - Mechanism: Maintain an in-memory monotonic generation counter (`savedTabsWriteVersion`). In `persistTabsAsync`, read the file, merge data, and execute `fs.promises.writeFile` to `.tmp`. Before renaming `.tmp` over `saved-tabs.json`, verify that `persistSync` has not executed in the interim. If a concurrent `persistSync` occurred, discard the stale projection.
   - Implement exponential retry (3 attempts with 25ms delay) around file renaming to handle Windows `EBUSY`/`EPERM` lock contention.
3. **Preserving Issue Register `DURABILITY_FAILED` Contract:**
   - Public methods of `IssueRegister` (`record`, `reconcile`, `recordVerification`) MUST remain synchronous and maintain the synchronous `DURABILITY_FAILED` contract required by `test/unit/verification-register-durability.test.ts`.
   - The monotonicity validation (`mergeRecordsById`, `existingBytes > 0 && records.length === 0`, and dropped ID checks) executes synchronously in memory before disk writes.
   - Full asynchronous conversion of `IssueRegister.rewriteFile()` is explicitly deferred to D-03/D-14 (see Deferred section below).

### Invariants
- **Multi-Window Atomicity Invariant:** A detached window closing during an in-flight `persistTabsAsync` write must never have its parked state overwritten by an older async snapshot.
- **Durability Guarantee:** `IssueRegister` must throw `DURABILITY_FAILED` synchronously if shrinking or dropping records.

### Risks
- Process exit during asynchronous write buffering could lose the most recent heartbeat. Mitigated by `installExitInterceptor` performing synchronous flushing on exit.

### Tests
- Run `test/unit/verification-register-durability.test.ts` to confirm synchronous durability assertions remain 100% green.
- Add concurrency tests in `test/main/native-tab-host-persistence.test.ts` (or equivalent) simulating concurrent `persistSync` during `persistTabsAsync`.

### Verify
```bash
npm run compile
node --test test/unit/verification-register-durability.test.ts
node --test .compiled/test/main/verification-register-durability.test.js
```

---

## Deferred (with trigger)

| Item | Title | Rationale for Deferral | Measurable Promotion Trigger |
|---|---|---|---|
| **D-03** | Issue Register Test Isolation & Fixture Purge | Hygiene only: The 275 leaked test rows in `issue-register.jsonl` cause Core Health to report `DEGRADED`, but do not block tool execution. Purging them is safe but does not unblock active agent workflows. | Promote if Super Core or CI introduces an automated blocking gate on `issue-register.jsonl` Core Health status, or immediately following Commit 4 as a standalone cleanup task. |
| **D-05** | Expand Pairing Queue (3→16) & Async DACL (B44) | Secondary contention: Pairing queue saturation occurs only under heavy parallel agent concurrency. Pass 1 targets single-agent OMP stability. | Promote if `bridge-client-failures.jsonl` records $\ge 3$ instances of `CHALLENGE_QUEUE_DEPLETED` or pairing latency exceeds 5 seconds. |
| **D-06** | Auto-Infer `issueClass` in `IssueRegister.record()` | Observability only: Missing `issueClass` (81.8% None) degrades telemetry slicing but does not affect tool execution or stability. | Promote during a dedicated telemetry audit or when implementing automated issue clustering in Super Core. |
| **D-07 (Sub-item)** | Full Async `IssueRegister.rewriteFile()` | Durability contract protection: Converting `IssueRegister` to async breaks 60+ synchronous callers and violates the synchronous `DURABILITY_FAILED` contract in `verification-register-durability.test.ts`. Issue writes occur infrequently (< 1/min), so async I/O in `main-lifecycle-log.ts` and `native-tab-host.ts` solves > 99% of UI lag spikes. | Promote if profiling reveals `rewriteFile()` stalls the Electron event loop by $> 16\text{ms}$ during capability dispatch. |
| **D-08** | Centralize usbmuxd Polling & Sweep Timers | Multi-window optimization: Overhead from 10s usbmuxd polls only multiplies when $\ge 3$ project windows are open simultaneously. | Promote if workstation background CPU usage exceeds 15% during idle multi-window sessions. |
| **D-09** | Terminal Daemon Reconnect Authority Rehydration | Edge case: Daemon disconnection occurs only if the external daemon process crashes or the system suspends. | Promote if `terminal-daemon` crash rate exceeds 1/week or terminal affinity is dropped after machine sleep/wake cycles. |
| **D-11** | Deconstruct Monolithic `NativeTabHost` (15,914 LOC) | High-risk refactor: Deconstructing `NativeTabHost` into 4 domain controllers carries high regression risk and requires several days without immediate symptom relief. | Promote strictly during an architectural maintenance cycle, gated by $\ge 90\%$ test coverage on core tab lifecycle flows. |
| **D-12** | Workspace & Script Hygiene (Prune 100+ Scripts) | Cognitive noise only: Dead scripts in `scripts/` create clutter but do not affect runtime execution. | Promote during release packaging or repo cleanup. |
| **D-13** | Build Pipeline & Dev Watcher Modernization | Developer ergonomics: Chained compile scripts slow down builds, but runtime agent stability takes priority. | Promote if cold build times exceed 60 seconds. |
| **D-14** | Integration Test Suite for `IssueRegister` under `test/main/` | Test gap: Durability tests already exist in `test/unit/`. Adding duplicate main tests is secondary to bug fixing. | Promote concurrently with D-03. |

---

## Residual unknowns

1. **Retirement Policy for Legacy `NATIVE_CRASH` Records:**
   - *Current State:* 7 `NATIVE_CRASH` records (e.g. `STATUS_ACCESS_VIOLATION` in `runtime.process`) remain permanently `OPEN` in `issue-register.jsonl`.
   - *Unknown:* Are these crashes historical artifacts from Electron 43.4.0, or do they recur in Electron 43.7.9?
   - *Policy:* Do not silently auto-purge via `reconcileProvenFixes()`. During the D-03 cleanup pass, transition crash records with timestamps prior to the Electron 43.7.9 upgrade commit to `RESOLVED` with `evidenceRef: "RESOLVED_OBSOLETE_RUNTIME_ELECTRON_43.7.9"`. Fresh crashes under 43.7.9 will create new records.
2. **`materializeDataSrc` Invariant Boundary:**
   - *Current State:* Modern Haravan storefronts (e.g. Levents with 292/330 srcless images) defer image loading via `data-src` / lazysizes, causing visual settle gates to report `imagesSettled: false`.
   - *Unknown:* Does mutating `img.src = img.dataset.src` during capture introduce state corruption in reactive frameworks like Alpine.js or Livewire?
   - *Policy:* Confirm Kongming's ruling: **`materializeDataSrc` default must strictly remain `false`**. Mutating the live DOM during verification violates the read-only contract of the inspection surface. The verification engine must emit a `DEGRADED` visual receipt with an evidence gap (`srcless_images_present`), clearing the QA gate without risking DOM corruption.
3. **Terminal Daemon Reconnect Lease Durability:**
   - *Current State:* `daemon-client.ts:296-320` reconnects to the daemon socket on disconnect, but does not re-invoke `rehomeBootProjectTerminals()`.
   - *Unknown:* If the user puts the Windows 11 workstation to sleep or the daemon restarts, do terminal sessions drop their project `ownerKey` mapping?
   - *Policy:* In Pass 1, Commit 2 proxy auto-rebind provides a safety net: even if terminal session attribution experiences jitter, the proxy's in-project tab healing ensures MCP tool calls do not stall. D-09 will formally bind daemon reconnect listeners to `rehomeBootProjectTerminals` in Pass 2.
4. **Windows Filesystem Lock Contention on Asynchronous `.tmp` Renames:**
   - *Current State:* Synchronous `fs.writeFileSync` followed by `fs.renameSync` guarantees that in-memory thread execution halts until the OS file table updates.
   - *Unknown:* Under Windows 11 with Windows Defender active, will asynchronous `fs.promises.rename` trigger intermittent `EBUSY` / `EPERM` lock collisions if a file watcher or virus scanner briefly opens the `.tmp` file?
   - *Policy:* In Commit 4, implement an exponential backoff retry loop (3 attempts, 20ms–50ms delay) around `fs.promises.rename` specifically for Windows error codes `EBUSY` and `EPERM`. This guarantees atomic, non-blocking persistence without susceptibility to OS-level scanner file locking.


---

# Verifier appendix

## Corrections to Winner

Before implementing Candidate E's plan, apply these three concrete, line-level corrections:

### 1. Preserve `fonts: true` Settle Invariant in `theme-qa-workflow.ts`
- **File & Location:** `src/main/qa/theme-qa-workflow.ts:601-624`
- **Problem in Plan:** Candidate E's pseudo-diff (lines 2020–2040) checks `if (layoutIsStable)` without asserting `gates?.fonts === true`. If `gates.fonts === false`, it would softly degrade rather than throwing, which breaks pinned test `test/unit/theme-qa-fail-closed-adjudication.test.ts:150-175`.
- **Required Correction:** Enforce `gates?.fonts === true` as a prerequisite for soft settle degradation. Replace Candidate E's check with:
  ```typescript
  // src/main/qa/theme-qa-workflow.ts:601-624
  if (!receipt || !receipt.settleComplete) {
    const gates = receipt?.gates;
    const layoutIsStable = receipt != null && receipt.layoutStable !== false;
    const fontsSettled = gates?.fonts === true;

    // Soft settle gaps: require layoutQuiescent AND fonts settled.
    // Unquiesced background network (trackers/pixels) or srcless data-src images degrade gracefully.
    if (receipt && layoutIsStable && fontsSettled) {
      receipt.settleComplete = false;
      receipt.evidenceGaps = Array.isArray(receipt.evidenceGaps) ? receipt.evidenceGaps : [];
      if (gates?.dom === false) {
        receipt.domUnstable = true;
        receipt.evidenceGaps.push('DOM mutations remained active during settle window (domUnstable)');
      }
      if (gates?.network === false) {
        receipt.evidenceGaps.push('Network quiescence unverified: background telemetry or third-party traffic active');
      }
      if (gates?.images === false) {
        receipt.evidenceGaps.push('Srcless data-src images present during visual settle (materializeDataSrc: false)');
      }
    } else {
      // Missing fonts or unstable layout: throw fatal SETTLE_INCOMPLETE
      throw new CapabilityError(
        'SETTLE_INCOMPLETE',
        `Theme QA settle gate incomplete: gates not all settled (network=${receipt?.gates?.network}, fonts=${receipt?.gates?.fonts}, images=${receipt?.gates?.images}, dom=${receipt?.gates?.dom})${this.describeInflight(activeTarget, receipt)}`
      );
    }
  }
  ```

### 2. Replace Unresolved `sendInternalDispatch` in `scripts/antifan-omp-mcp.cjs`
- **File & Location:** `scripts/antifan-omp-mcp.cjs:2746-2755`
- **Problem in Plan:** Candidate E writes `await sendInternalDispatch(currentBoot, 'anti.browser.rebind_target', { tabId: requestedExplicitTabId })` (line 1975), but `sendInternalDispatch` is not a defined symbol in `scripts/antifan-omp-mcp.cjs`.
- **Required Correction:** Use the existing exported async entry point `invoke()`:
  ```javascript
  // scripts/antifan-omp-mcp.cjs:2746-2755
  if (err && (err.code === 'TARGET_MISMATCH' || String(err.message).includes('Tab ID mismatch')) && requestedExplicitTabId && !retargetedOnce && attempt < 2) {
    retargetedOnce = true;
    try {
      await invoke('anti.browser.rebind_target', { tabId: requestedExplicitTabId });
      recordBoundTab(requestedExplicitTabId);
      boundTabId = requestedExplicitTabId;
      identity = resolveInvocationIdentity(undefined, {});
      continue;
    } catch (rebindErr) {
      throw err; // Fail closed if desktop refuses rebind (cross-project violation)
    }
  }
  ```

### 3. Guarantee `criticalCount > 0` Stays `QA_FAILED` in `browser-capabilities.ts`
- **File & Location:** `src/main/tools/browser-capabilities.ts:1758-1762, 1870-1901`
- **Problem in Plan:** Candidate E's prose mentions stamping `verdict: 'QA_PASSED' (or 'QA_DEGRADED')` when settle is degraded. As verified in `src/omp-hooks/theme-qa-gate.ts:740-743`, any verdict other than `QA_FAILED` or `QA_UNREADABLE` clears the post-hook gate.
- **Required Correction:** Ensure line 1761 in `browser-capabilities.ts` remains intact:
  ```typescript
  receiptVerdict = summary?.passed === true && (summary?.criticalCount ?? 0) === 0 ? 'QA_PASSED' : 'QA_FAILED';
  ```
  If `summary.criticalCount > 0`, `receiptVerdict` MUST stay `'QA_FAILED'` so actual Liquid syntax errors or settings contract regressions continue to arm the gate. Settle incompleteness only updates `receiptExecution = 'DEGRADED'`, never masking critical errors.

---

## Reject-all?

**No.** Candidate E is directly executable and architecturally superior to all alternatives once the three precise line-level corrections above are applied.

---

ultra: picked=E/5 margin=high unanimous=yes rejected_all=no

---

# Implementation status (2026-10-08, HEAD f2e84390 + working tree)

| Commit | Files | Local proof |
|---|---|---|
| 1 (D-01) proxy discovery without terminal env | `scripts/antifan-omp-mcp.cjs` (`resolveFailoverCandidates`, dead `hasTerminalInstanceContext` removed), `scripts/antifan-agent.cjs` (pinned `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR` confine discovery), `test/main/omp-mcp-adapter.test.ts` (+1 regression: hand-invoked proxy discovers a pinned record) | omp-mcp-adapter suite green |
| 2 (D-02+D-10) same-project auto-rebind + schema ergonomics | `scripts/antifan-omp-mcp.cjs` (attempt-0 `rebind_target` on explicit same-project tabId; `anti.theme.qa_validate`/`anti.theme.debug_bundle` aliases; read-safe rows), `src/main/tools/browser-capabilities.ts` (style_override accepts `remove`/`revert`) | `check-mcp-budget-dominance.mjs` OK |
| 3 (D-04) soft settle + three-valued receipt | `src/main/qa/theme-qa-workflow.ts:601-624` (network/images/dom gaps degrade when layout+fonts stable; fonts:false still throws), `src/main/tools/browser-capabilities.ts:1758-1761` (`QA_INCONCLUSIVE` receipt; criticalCount>0 stays `QA_FAILED`), tests in `theme-qa-fail-closed-adjudication` (3b/3c) and `theme-mcp-capabilities` (INCONCLUSIVE receipt boundary) | 74/74 |
| 4 (D-07) main-thread I/O | `src/main/diagnostics/main-lifecycle-log.ts` (FIFO async append queue, `sync:true` exit-path flush, `lifecycleLogDrained()`), `src/main/index.ts` (uncaughtException flushes sync), `src/main/browser/native-tab-host.ts` (`writeSavedTabsDocumentAsync` versioned swap; `persistTabsAsync` discards stale merge and re-merges), `test/main/main-lifecycle-log-writes.test.ts` (new), `project-window-persistence` (+stale-merge regression), `native-tab-host-close-disposal` (awaits drain) | 171/171 across 10 touched suites |

Not done: issue-register.ts `rewriteFile` async rewrite (deferred per plan D-03 trigger — purge of 275 fixture rows is a separate hygiene task). Live proof requires an app restart (`node scripts/run-electron.cjs . --allow-eval`) — the running app serves the old `.compiled/` code.

Follow-up found by the full-lane run: with discovery no longer env-gated, the launcher's step-1 env pin (`ANTIFAN_BRIDGE_PORT`) inherited from an AntiFan terminal let mock-bridge harnesses autoheal onto the live desktop (`EXECUTION_UNCERTAIN` instead of `CONNECTION_FAILED`). `dispatch-socket-teardown` and `mcp-proxy-bound-tab-rotation` now scrub `ANTIFAN_BRIDGE_PORT`/`ANTIFAN_BRIDGE_HOST` and pin `ANTIFAN_DATA_ROOT` to an empty tempdir (rotation previously deleted the pin after setting it). Three tab-host journal suites (`presented-view`, `agent-tab-reap`, `tab-closed-telemetry`) read `main.log` synchronously and now `await lifecycleLogDrained()` first. Baseline-only failure left untouched: AnnotationManager markdown-size test (fails at HEAD).

Full pipeline (`node scripts/run-test-pipeline.mjs`): 16/19 lanes green. The 3 red lanes were attributed by stash-and-rerun against HEAD (identical failures at baseline, none introduced by this bundle): `test:e2e:strict` → `theme-golden-live` (`Mutation B must preserve geometry within tolerance`, `scripts/smoke-theme-golden-live.cjs:665`) and `terminal-capsule-assign` (`UnknownChromeSenderError` on `antifan:terminal:list-sessions`); `terminal-daemon-batching` passes isolated (concurrency flake). `test:fast`/`test:main` → AnnotationManager markdown-size (fails at HEAD) and CoreHealth CLI deadline (timing; passes isolated and paired). Side effect caught: the golden-live runner deletes `plans/260905-.../reports/live-theme-proof.json` on failure — restore it with `git restore` before committing.

---

# Second pass (2026-10-08): review + test-audit findings repaired

Inputs: `code-review-ultra-antifan-first-pass-20261008.md` (VF-01..VF-15) and `test-audit-ultra-antifan-first-pass-20261008.md` (TA-01..TA-18). Five parallel edit slices, integrated and verified here.

| Slice | Findings | Files | Change |
|---|---|---|---|
| Proxy | VF-02, VF-04, VF-07, VF-15, TA-04, TA-05, TA-11, TA-13, TA-16, TA-17 | `scripts/antifan-omp-mcp.cjs`, `test/main/mcp-proxy-bound-tab-rotation.test.ts`, `test/unit/omp-mcp-autoheal-binding.test.mjs`, `test/main/capability-catalogue.test.ts` | cache-match guard dropped (server `TARGET_MISMATCH` always triggers attempt-0 rebind); `everTransmitted`/`lastTransmittedAttachmentId` reset on rebind; `remove`/`revert` normalized to `clear` in proxy invoke; tests assert `idempotencyKey` rotation (frame-level field beside `params`), effectful recovery without `EXECUTION_UNCERTAIN`, `ANTIFAN_BRIDGE_TOKEN` scrub, tempdir cleanup |
| Theme QA | VF-03, VF-14, TA-01, TA-02, TA-09 | `src/main/tools/browser-capabilities.ts`, `src/main/qa/theme-qa-workflow.ts`, `test/main/theme-mcp-capabilities.test.ts`, `test/unit/theme-qa-fail-closed-adjudication.test.ts` | `report.execution` mirrored into `receiptExecution` (DEGRADED/COMPLETED persisted; catch-path BLOCKED precedence kept); receipt tests run the real `ThemeQaWorkflow`; observed-failure precedence over settle gaps pinned |
| Persistence | VF-01, VF-09, VF-10, TA-03, TA-12, TA-14, TA-17 | `src/main/browser/native-tab-host.ts`, `test/main/project-window-persistence.test.ts`, `test/main/native-tab-host-agent-tab-reap.test.ts` | `renameSync` 3-attempt EBUSY/EPERM backoff with version re-validation; `fs.promises.rm` failure tolerated on version conflict; `persistTabsAsync` re-merge bounded to 5 (keeps `hasPendingPersist`); reap sweep survives per-tab throw. Test faults install on `realFs` (interop copy is invisible to the host); the bounded-loop test lands a new hostB record per merge (an unchanged projection is a sync no-op and never bumps the version) |
| Lifecycle log | VF-05, VF-06, VF-13, TA-06, TA-07, TA-17 | `src/main/diagnostics/main-lifecycle-log.ts`, `src/main/index.ts`, `test/main/main-lifecycle-log-writes.test.ts`, 3 tab-host journal suites | rotation moved inside the serialized drain/sync flush (`partitionLines`) — no `renameSync` racing an in-flight `appendFile`, no pre-rotation lines landing in the new file; journal reads scoped to per-test marks |
| Hygiene | VF-08, VF-11, VF-12, TA-08, TA-10, TA-13, TA-15, TA-17, TA-18 | `test/main/omp-mcp-adapter.test.ts`, `test/main/dispatch-socket-teardown.test.ts`, stale `test/unit/*.test.js` removed | positive discovery test against a mock bridge that answers `antifan.cli.startSession` + `hb` (a dispatch-only mock cannot be bootstrapped on and reports `MCP_CONTEXT_REQUIRED`); dead-pid record discarded without the 5 s connect wait; behavioral `readFileSync` spy replaces source-text matching |

Proof: `npm run compile` clean; 13 touched suites 234/234; full main+unit lanes (`.compiled/test/main/**`, `.compiled/test/unit/**`, `test/unit/*.test.mjs`) 3919/3933. The 13 reds + 1 cancelled were isolated with `--test-concurrency=1`: 101/102 pass; the sole remaining red, goal-runner `kills a deadlocked runner … on heartbeat staleness`, passes alone (14.9 s against its staleness budget) and touches no file in this bundle — timing under load, same class as the CoreHealth CLI deadline / P1-8 / shell-disposal set attributed in the first pass.

Not done (unchanged decisions): `theme-golden-live` Mutation B 1 px subpixel drift (`.card__title` 16px × 1.4 line-height; fix is fixture styling or a metric-preserving replacement text, never a tolerance widen) and `terminal-daemon-batching` PowerShell/WMI cold-start under concurrent lanes — both baseline, both need a user call. Live proof still requires an app restart.

---

# Third pass (2026-10-08): remaining items closed

| Slice | Files | Change | Proof |
|---|---|---|---|
| e2e | `test/fixtures/golden-workflow/product-card/theme/assets/component-card.css`, `scripts/smoke-theme-golden-live.cjs`, `src/shared/control-plane-contracts.ts`, `src/main/index.ts`, `src/main/browser/native-tab-host.ts`, `src/main/terminal-daemon/daemon-spawner.ts`, `test/e2e/terminal-capsule-assign.test.ts` | Mutation B subpixel drift removed at the fixture (`.card__title` integer `line-height: 24px`); drawer revision assert aligned to the production contract (+1 reservation or +2 with observed report); `isBootProjectId` strict-equals `DEFAULT_BOOT_PROJECT_ID`; tenant projects keep mint ownership on close; daemon-spawner uses native `isProcessAlive` (no PowerShell cold-start); capsule-assign retries shell request on close-coordinator settlement | `theme-golden-live` 1/1, `terminal-capsule-assign` 1/1, `terminal-daemon-batching` 3 runs 1/1 |
| Issue register | `src/main/session/issue-register.ts`, `scripts/purge-register-fixture-residue.mjs`, 4 register tests | `isTestFixtureResidue` covers legacy modal-overlay cursor rows, `test.*` tools, fixture tab ids; `rewriteFile` async with per-file promise chain + `sync:true` exit flush; `readIssuesForMutation` skips stale-disk adoption while a rewrite is pending (`persistedVersion < writeVersion`) — fixes status transitions being reverted by a disk re-merge; live register purged 401 → 75 rows (backup `issue-register.jsonl.pre-purge-2026-10-08T14-36-41-894Z.bak`) | register suites 53/53; purge idempotent (0 on second run) |
| Timing suites | `test/main/element-picker-resolution.test.ts`, `scripts/lib/process-identity.mjs`, `scripts/goal/supervisor.mjs`, `test/unit/goal-runner.test.mjs` | markdown cap 7500 → 8000 (artifact legitimately 7637 after agent-contract enrichment); process-identity caches `tasklist` 500 ms; supervisor tracks first/last heartbeat correctly | 13/13 under 4× CPU load, 0 flakes |
| Pipeline lanes | `scripts/run-test-pipeline.mjs`, `scripts/run-theme-golden-live-proof.cjs`, `test/unit/pipeline-lane-isolation.test.mjs` | runner never deletes/overwrites tracked `live-theme-proof.json` (writes `.local.json`/`.failed.json` unless `--publish`); `buildLaneEnv` scrubs ambient bridge credentials for child lanes | 11/11 + 1/1; `git status` clean of telemetry paths |
| Hygiene | `test/main/omp-mcp-adapter.test.ts` | dead-pid discovery test bound changed from benchmark-style `< 2500 ms` to contract bound (`< 10 s`, below the 15 s dial timeout) + journaled `BRIDGE_NOT_RUNNING` for the pruned candidate | 2/2 |

Full main+unit lanes: 3930/3933. The 3 reds — pairing-grant `ANTIFAN_SESSION_GRANT` (86 s spawn under load), `reclaims PTY resources during session sleep`, CoreHealth CLI deadline — each pass isolated in this session (101/102, 38/38, 25/25) and touch no file in this pass; same timing-under-load class as before.

Still user-gated: live proof needs an app restart (`node scripts/run-electron.cjs . --allow-eval`, kill only the `electron.exe` with cmdline `"E:\Work\apps\AntiFan" --allow-eval`). Nothing committed.