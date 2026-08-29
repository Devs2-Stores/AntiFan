---
phase: 3
title: "Lifecycle-Aware Test Harness & Verification"
status: pending
priority: P1
effort: "4-5h"
dependencies: [1, 2]
---

# Phase 3: Lifecycle-Aware Test Harness & Verification

## Overview

Regression-proof the P0-1 fix with a stateful mock host that models the real reload lifecycle (generation bump, synchronous buffer clear, load settle with explicit in-flight state, strict `isCurrentTarget` with ALL lease fields), so the suite fails deterministically if anyone reuses `input.target`, skips the settle, bypasses confinement, or lets script-crashes fall through to clean passes.

## Requirements

- Functional: `StatefulLifecycleHost` mirrors `NativeTabHost.isCurrentTarget` exactly (Finding R10): 6 fields — `tabId`, `documentGeneration === currentGen`, `browserEpoch === lease.hostEpoch`, `projectId === lease.projectId`, `workspaceId === lease.workspaceId`, `runtimeId === lease.runtimeId` (`native-tab-host.ts:4387-4402`), plus an explicit `isSettled` state (Finding R7/F7) where `getDom`/`evalJs` THROW if invoked pre-settle.
- Functional: tests assert target propagation, evidence freshness, stale-target rejection, load-settle timeout → `LOAD_SETTLE_TIMEOUT` (not `TARGET_STALE`), tab confinement, `enabledChecks` parity (full + fallback), script-crash → explicit finding (not clean pass), and diagnostics ordering (pre vs post, verdict isolation).
- Non-functional: runs inside `npm test` (node --test), no Electron binary; deterministic.

## Architecture

```
StatefulLifecycleHost implements BrowserHostPort (+ settleTab, + lease fixture)
  generation: number (1→2 on reload); isSettled: boolean (false until settle completes)
  isCurrentTarget(t) === t.tabId===tabId && t.documentGeneration===gen && t.browserEpoch===lease.hostEpoch
                         && t.projectId===lease.projectId && t.workspaceId===lease.workspaceId && t.runtimeId===lease.runtimeId
  reload()          : generation++; clear diagnostics; isSettled=false; simulate settle (or simulateTimeout)
  settleTab()       : populate gen-2 diagnostics; isSettled=true
  getDom()/evalJs() : if (!isSettled) throw 'not-settled'; return domStates[generation] / per-gen scanner payloads
  stopLoading()     : no-op recorder (assert called on timeout)

validate() ──► reload (gen 2, unsettled) ──► settleTab ──► inspect/eval (gen 2 only) ──► report.target.gen === 2
```

The existing `test/integration/theme-qa-vertical-slice.test.ts` uses a static mock (inline object at `theme-qa-vertical-slice.test.ts:22-34`: `reload: () => true`, no `isCurrentTarget`, and `BrowserControlPort.assertCurrent` is a no-op when `isCurrentTarget` is undefined — `browser-control-port.ts:311`) — structurally incapable of catching the stale-target bug; it is upgraded to the stateful host.

## Related Code Files

- Create: `test/main/theme-qa-fresh-target.test.ts` (stateful-lifecycle unit suite)
- Modify: `test/integration/theme-qa-vertical-slice.test.ts` (adopt stateful host + generation/lease/settle assertions)
- Modify: `test/main/theme-qa-parity.test.ts` (parity full-vs-fallback, incl. `enabledChecks` subset — Finding R11)

## Implementation Steps

1. Implement `StatefulLifecycleHost` per the diagram with a lease fixture (`browserEpoch`, `projectId`, `workspaceId`, `runtimeId`); the contract surface identical to `BrowserHostPort` + additive `settleTab`; synchronous state transitions only (no real waits) so the suite is deterministic.
2. Tests (each a named case):
   - **Target propagation:** every `evalJs`/`getDom`/screenshot call during a successful `validate()` receives `documentGeneration === 2` AND intact 6 lease fields; assert via recorded call args.
   - **Stale rejection:** construct a workflow that passes `input.target` (gen 1) as the only active target; assert `validate()` throws `TARGET_STALE` (before fix: it "passes" with fallback data — the regression barrier).
   - **Pre-settle guard:** invoke `getDom`/`evalJs` while `isSettled === false` → host throws; assert `validate()` never reaches post-reload capture before `settleTab` resolves (Finding R7).
   - **Settle timeout:** `settleTab` configured to time out → `validate()` rejects with `LOAD_SETTLE_TIMEOUT` (NOT `TARGET_STALE`), `stopLoading` was invoked, and zero post-reload evals ran (Finding R5).
   - **Redirect re-stamp:** simulate a second generation bump during settle (gen 2→3); assert `activeTarget` re-stamped to gen 3 (Finding R4) — no false `TARGET_STALE`.
   - **Target confinement:** caller-supplied `tabId` ≠ automation tab → `validate()` rejects before any reload/eval (Finding R2).
   - **Script-crash fail-closed:** `evalJs` throws a non-`CapabilityError` (simulated CSP/crash) inside LayoutOverflow check → report records an explicit diagnostic issue / check fails — NOT `{ hasOverflow: false }` clean pass (Finding R3/R8).
   - **Diagnostics ordering:** seed gen-1 console errors before reload; after reload, gen-2 errors present; assert the report's fresh diagnostics contain gen-2 entries, `preReloadDiagnostics` holds gen-1 entries, and `summary.passed`/`checklist.diagnostics` reflect ONLY gen-2 (Finding R3).
   - **enabledChecks integrity + parity:** exclude a failing check via `enabledChecks` → `summary.passed` computed over enabled subset; attempt to pass a `checklist` override → type error; same subset yields the same verdict through `buildFallbackThemeQaResult` (Finding R11).
3. Update `theme-qa-vertical-slice.test.ts` mock to enforce generation tracking + lease + settle; keep its existing assertions where behavior is unchanged (platform detection on gen-2 DOM).
4. Parity: `theme-qa-parity.test.ts` still passes (full path vs fallback) using the fresh target and `enabledChecks` subsets.
5. **Regression gate:** revert `activeTarget` to `input.target` in the workflow → the suite fails; restore → green. Also temporarily drop the settle await → pre-settle guard test fails.

## Success Criteria

- [ ] `npm run typecheck` and `npm test` pass (compile + `.compiled/test/main/*.test.js` + `.compiled/test/integration/*.test.js`).
- [ ] The stale-target test fails when the fix is reverted; the pre-settle test fails when the settle await is dropped (verified by temporary reverts).
- [ ] No Electron/live-CDP dependency in the new tests; lease fixture covers all 6 `isCurrentTarget` fields.

## Risk Assessment

- **Risk (R10):** mock diverges from `NativeTabHost` (strips lease fields or lacks `isSettled`). *Signal:* tests pass but live runs reject on `browserEpoch`/`runtimeId`. *Response:* mirror `native-tab-host.ts:4387-4402` exactly; strict typing via `BrowserHostPort`.
- **Risk:** timing flakiness in settle simulation. *Response:* synchronous state transitions; timeouts simulated as booleans; no real waits.
- **Risk:** parity tests drift because fallback path lacks fresh targets/settle. *Signal:* `theme-qa-parity.test.ts` failures. *Response:* parity compares verdicts over the same gen-2 DOM with the same `enabledChecks`; adjust assertions to the fresh generation, not thresholds.