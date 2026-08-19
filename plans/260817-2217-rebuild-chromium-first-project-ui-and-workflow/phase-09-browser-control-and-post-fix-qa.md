---
phase: 9
title: "Browser Control And Post Fix QA"
status: done
priority: P1
effort: "8d"
dependencies: [4, 6, 7, 8]
---

# Phase 9: Browser Control And Post Fix QA

## Overview

Port the existing browser-control and visual-regression capabilities into the
Project UI, then harden them with exact targets and evidence-backed post-fix QA.
Users can see when Harness controls Chromium, stop it, inspect every action, and
compare the fixed page against an explicit baseline.

## Existing Capability Migration Contract

- Existing: Playwright/browser capability engine, capture/baseline flow,
  console/network observers, device handling, accessibility probes, QA runner,
  and post-fix QA tests.
- Reuse: probe engines, observer services, baseline storage, device definitions,
  working artifacts, and verified browser actions.
- Required delta: visible control state, exact before/after binding checks,
  `DevServerBinding`, mutation lineage, durable progress, and integrated results UI.
- Legacy removal condition: existing automation/QA coverage passes through the
  Project path plus stale-target and wrong-Workspace denial tests.

## Requirements

- Browser control names Project, Workspace, run, tab, runtime instance, document
  generation, and current action; no hidden active-tab fallback.
- User navigation/close/crash revokes queued actions and surfaces stale/unknown state.
- Every action performs pre-dispatch and post-result binding checks.
- Control can be stopped from Browser toolbar, Binding Rail, or run timeline.
- Post-fix QA requires `DevServerBinding` for local flows and proves process,
  port, cwd, Workspace revision/build marker, origin, and target tab lineage.
- QA flow: baseline -> mutation receipt -> process readiness -> reload/rebind ->
  stability barrier -> screenshot/DOM/console/network/a11y probes -> comparison.
- Multi-tab QA requires explicit target list and per-tab scenario/viewport/device.
- Missing/mismatched baseline is a failure, never zero diff.
- Visual regression, console/network, accessibility, and artifact results render
  in the Harness dock with open-in-browser and rerun actions.

## Architecture

`BrowserControlBanner` projects current broker/automation state. `QaRunView`
projects a Main-owned `QaRun` and target results. Renderer initiates/cancels QA
but does not execute probes or compare pixels.

QA target creation binds the accepted Workspace mutation receipt, exact
DevServerBinding, baseline identity, and explicit browser targets. Main performs
readiness and stability checks before capture.

## User Flows And States

- Harness clicks/types/navigates while user watches.
- User stops control before dispatch or during a safe boundary.
- Target becomes stale after manual navigation or tab crash.
- Run fix, wait for dev server, reload, run single-tab QA.
- Compare baseline/current/diff and open console/network/a11y details.
- Run multi-tab desktop/mobile scenarios.
- Missing baseline, wrong origin, stale Workspace build, unstable page, probe timeout.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/harness-contract.ts` | Browser control and DevServerBinding linkage | Schema/unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/browser/playwright-engine.ts` | Pre/post binding checks and revocation | Automation tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/capabilities/browser-capability-adapter.ts` | Explicit target action/status/cancel | Capability tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/qa/qa-runner.ts` | Dev-server proof, multi-target QA, durable progress | QA tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/qa/stability-barrier.ts` | DOM/network/render readiness diagnostics | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/qa/visual-baseline-store.ts` | Exact baseline identity and mismatch errors | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/qa/accessibility-probe.ts` | Bounded a11y result summaries | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Browser-control/QA operations and events | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/browser/browser-control-banner.tsx` | Visible control target and stop | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/qa/qa-run-view.tsx` | QA progress/results container | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/qa/visual-comparison.tsx` | Baseline/current/diff viewer | Renderer/visual |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/qa/probe-results.tsx` | Console/network/a11y/stability details | Renderer |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/browser-automation.test.ts` | Revocation/pre-post target cases | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/qa-runner.test.ts` | Dev-server/baseline/multi-tab cases | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/post-fix-qa.cjs` | Full new QA UI | Electron E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/multi-project-browser.cjs` | Cross-Project automation denial | Electron E2E |

## Implementation Steps

1. Define UI-safe browser-control and QA progress/result summaries.
2. Enforce pre-dispatch/post-result exact-target checks and queued-action revocation.
3. Emit control state to Browser toolbar, Binding Rail, and run timeline.
4. Require/verify DevServerBinding and accepted Workspace mutation lineage.
5. Build QA target selector, progress pipeline, visual comparison, and probe details.
6. Add single/multi-tab scenario, viewport/device, baseline capture/select, rerun,
   cancel, and open-artifact actions.
7. Integrate component/annotation evidence links into QA reports.
8. Test manual navigation, crash, stop, stale build, wrong port/origin, missing
   baseline, unstable page, multi-tab, cross-Project denial, and replay.

## Function And Interface Checklist

- [x] `BrowserControlState` exposes exact immutable target and safe stop capability (`BrowserControlService.latest/ledgerFor`, `browser/control-state` + `project:browser:control` events; Stop revokes queued/in-flight work).
- [x] Each action records before/after binding and accepted/terminal receipt (`ControlCommand.bindingBefore/bindingAfter/status/latencyMs`; navigate must advance generation, interactions must hold it).
- [x] `QaTarget` includes baseline, scenario, viewport/device, browser and DevServer bindings (evidence-contract `QaTargetKey`/`QaTarget`; baseline identity = key + baselineVersion).
- [x] `QaRunView` renders committed progress events and artifact refs only (metadata-refs-only probes; diff metrics from Main).
- [x] Missing/mismatched baseline has a dedicated failure state (`missing-baseline:<scenario>` / `baseline-mismatch:<scenario>:<cause>`; never zero-diff success).
- [x] Cross-Project or stale Workspace/tab targets cannot be selected or submitted (`project-unbound`, `wrong-tab-target`, `stale-generation` pre-checks; `qa-project-mismatch` on IPC).

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | User navigates after action queued | Action revoked/stale; no wrong-page effect |
| Critical | Dev server serves another Workspace/build | QA refuses before reload/capture |
| Critical | Baseline identity mismatch | Explicit failure; no zero-diff success |
| High | Stop during accepted mutation | Receipt becomes terminal/unknown correctly; UI does not claim rollback |
| High | Multi-tab QA | Each tab keeps independent binding/scenario/results |
| Medium | Console/network/a11y output large | Bounded summaries plus artifacts; UI remains responsive |

## Dependency Map

`Exact browser binding + DevServerBinding + evidence -> automation state -> QA pipeline -> visual/probe UI -> release E2E`

## Success Criteria

- [x] Browser control is always visible, exact-targeted, auditable, and stoppable (`BrowserControlBanner` above the Binding Rail; per-tab ledger; `browser/stop` revokes).
- [x] Wrong/stale Project/Workspace/tab/document actions fail closed (exact generation + runtime instance; post-result revalidation revokes on any binding change).
- [x] Post-fix QA proves the edited Workspace/dev server/browser lineage (QaExecutor pre-flight `devServerMatches` over process id/birth token/canonicalPath/port/origin/Workspace revision + mutation receipt gate).
- [x] Single/multi-tab visual, console, network, and accessibility results are durable and reviewable (per-target probes + diff metrics persisted in `qa_runs`; QA dock renders per-target rows).
- [x] Missing baseline, instability, and unknown mutation states are never hidden (`missing-baseline:`/`stability-unsettled:`/`dev-server-unverified`/`qa-cancelled` hard failures + `QaRunCard` failure chips).

## Verification Evidence

- Unit: `test/main/qa-executor.test.ts` (8) + browser-automation control cases (6 new) + qa-runner (12) all green; full suite 475/475, compile=0.
- E2E: `post-fix-qa.cjs` drives the full QaExecutor through a real view — baseline seed, mutation, run to 'completed', missing-baseline hard fail, dev-server identity change refused before reload — 20/20 checks x2 consecutive PASS.
- E2E: `multi-project-browser.cjs` cross-project control denial + per-runtime ledgers — PASS.
- Found and fixed during gate: `execute()` never cleared `activeRunId` on success (blocked subsequent runs); webRequest detach `removeListener` missing on the real Electron surface (unhandled rejection killed the run); compare verdict was never persisted (`t.diff` null); `setTargetProbes` clobbered probe refs with the signals-only output; success-path debug cleanup.


## Risk Assessment

QA can produce false confidence if process readiness or stability is inferred from
an open port alone. Require process identity, origin, healthcheck, Workspace
revision/build evidence, and explicit stability diagnostics. If any proof is
unavailable, mark QA inconclusive/failed and require user action. Rollback keeps
QA UI test-only without changing stored baselines.
