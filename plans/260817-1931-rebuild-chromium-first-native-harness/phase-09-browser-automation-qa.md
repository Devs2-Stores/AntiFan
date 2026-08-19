---
title: "Phase 9: Project Browser Automation And Post-fix QA"
status: done
---

# Phase 9: Project Browser Automation And Post-fix QA

## Overview

Give the Project Harness reliable control of every Project-owned tab and add a
mandatory evidence-backed QA workflow after code fixes. Rebuild the misleading
injected-script Playwright layer as an explicit Electron/CDP browser adapter that
never launches a second Chromium.

## Requirements

- Harness can list/read all tabs in its Project and no tabs outside it.
- A run has an immutable initial primary tab; every tab-sensitive operation uses
  an explicit target or an explicit recorded rebind.
- User navigation and Harness navigation are distinct events.
- Harness navigation returns an accepted receipt and a binding transition with
  the new browser/document generation after commit.
- Browser actions revalidate Project, browser epoch, tab runtime instance, and
  document generation before dispatch and after observed completion.
- Browser action completion uses observed DOM/navigation/render conditions, not
  fixed sleeps alone.
- QA can target one or several tabs in the same Project with independent target
  identities and evidence.
- Baselines use stable scenario identity, URL/state, viewport/device/scale, and
  Workspace revision; runtime tab IDs are not persistent keys.
- Missing/mismatched baselines are hard failures.
- Internal QA capture never writes to clipboard or user Downloads.
- Local post-fix QA requires a verified DevServerBinding to the exact Workspace
  revision/build being tested.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Replace/rename | `src/main/browser/playwright-engine.ts` | Project browser automation adapter using existing Chromium/Electron/CDP |
| Modify | `src/main/capabilities/browser-capability-adapter.ts` | All-tab Project scope, explicit targets, transitions, receipts |
| Modify | `src/main/native-tab-host.ts` | Explicit-target navigation/action/capture/console/network APIs |
| Modify | `src/main/browser/navigation-policy.ts` | User versus Harness navigation origin and policy |
| Modify | `src/main/browser/device-manager.ts` | Stable viewport/device/scale QA identity |
| Modify | `src/main/browser/console-observer.ts` | QA window, severity, source, redaction, artifact output |
| Modify | `src/main/browser/network-observer.ts` | QA request failures, timing, redaction, body exclusion |
| Add | `src/main/qa/qa-runner.ts` | Baseline/mutation/reload/stability/probe/compare/report state machine |
| Add | `src/main/qa/stability-barrier.ts` | DOM ready, network quiet, animation/render settle, optional selector/app hook |
| Add | `src/main/qa/visual-baseline-store.ts` | Stable baseline identity and Project artifact references |
| Add | `src/main/qa/accessibility-probe.ts` | Bounded Chromium accessibility tree/issues artifact |
| Modify | `src/renderer/app.ts` | QA targets, progress, evidence, mismatch, and stale-state UI |
| Add | `test/main/browser-automation.test.ts` | explicit target, navigation, click/input, stale and completion tests |
| Add | `test/main/qa-runner.test.ts` | state machine and baseline identity matrix |
| Add | `test/e2e/post-fix-qa.cjs` | workspace fix through multi-signal QA report |
| Modify | `test/e2e/browser-core-runner.cjs` | Project-scoped all-tab control and race cases |

## Implementation Steps

1. Define browser operations for tab list/bind/rebind, DOM/accessibility snapshot,
   click/input/scroll, navigation/reload, screenshot, console, and network using
   explicit Project tab bindings.
2. Replace active-tab resolution and fixed-delay success with observed completion,
   per-operation deadlines, abort signals, and durable receipts.
3. Use existing Electron WebContents/CDP facilities against the Project's running
   Chromium. Do not start a Playwright-owned or MCP-owned hidden browser.
4. Add `DevServerBinding` for local post-fix QA containing Project, Workspace,
   Workspace revision, process identity/start time, cwd, port, origin, healthcheck,
   and served build marker. Verify process/port ownership and refuse stale or
   cross-Workspace tabs. Non-local targets use an explicit external scenario
   binding instead.
5. Define stable `QaTargetKey` from Project, Workspace scenario, normalized URL,
   viewport/device/scale, state marker, and baseline version.
6. Implement QA state machine:

   ```text
   baseline -> workspace mutation receipt -> process readiness -> explicit reload
   -> binding transition -> stability barrier -> capture/DOM/console/network/a11y
   -> compare -> evidence-backed report
   ```
7. Serialize browser mutation per tab and Workspace mutation per Workspace. For a
   multi-tab QA run, execute or coordinate targets without shared active-tab state.
8. Persist QaRun, QaTarget, probe results, diff metrics, failures, and artifacts;
   require explicit user review for baseline updates.

## Stability Barrier

The barrier combines bounded signals rather than one sleep:

- top-level navigation commit and expected URL;
- DOM ready state;
- network quiet window with ignored long-lived request classes;
- two stable render/layout samples or a configured app-ready hook;
- optional selector/assertion for the scenario;
- deadline with evidence explaining which signal did not settle.

## QA Matrix

| Scenario | Required result |
|----------|-----------------|
| Missing baseline | Hard failure with setup action |
| URL/viewport/device/state mismatch | Baseline rejected |
| User navigation during Harness QA | Target stale; run pauses/fails safely |
| Harness reload/navigation | Explicit binding transition to new generation |
| Console error/network failure | Captured and attributed to target window |
| Visual mismatch | Diff artifact and threshold evidence |
| No visual mismatch but DOM/a11y regression | QA still fails |
| Browser restart | Old tab IDs/bindings not reused |
| Several Project tabs | Independent evidence and no active-tab leakage |
| Dev server from another Workspace/revision | QA refuses to run |
| Process restarted or port ownership changed | DevServerBinding stale and rejected |

## Validation

- Browser controls interact with the Project's materialized Chromium, including
  explicit background-active mode, never a second hidden browser.
- Same-origin login/session state remains intact inside Project partition.
- Run focus changes and other Project windows cannot redirect operations.
- QA report can be reconstructed from durable artifacts after renderer reload.
- Local QA proves the bound process serves the mutated Workspace revision/build
  before it reloads or evaluates the target tab.
- Capture/DOM/network budgets and secret redaction pass security tests.

## Success Criteria

After a code mutation, Harness can reliably reload and verify the intended
Project tabs, report visual/DOM/console/network/accessibility evidence, and never
claim success from a missing baseline or wrong active tab.

## Risks And Rollback

CDP attachment and remote-page behavior can vary. Keep browser commands behind
one adapter and capability contract so implementation details can change without
changing Project/run semantics. Browser authority must remain NativeTabHost.
