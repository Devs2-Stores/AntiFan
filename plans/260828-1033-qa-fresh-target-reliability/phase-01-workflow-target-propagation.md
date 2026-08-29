---
phase: 1
title: "Workflow Execution Flow, Target Propagation & Load-Stable Settle Seal"
status: pending
priority: P1
effort: "4-5h"
dependencies: []
---

# Phase 1: Workflow Execution Flow, Target Propagation & Load-Stable Settle

## Overview

Repair `ThemeQaWorkflow.validate()` so a QA round inspects and evaluates the state produced by the latest edit: reload runs first, **load stability is settled with a bounded timeout** (the MUST seam — see Finding R1), `reload.target` (fresh `documentGeneration`, re-stamped after settle) becomes `activeTarget`, all post-reload browser calls use it, the target is confined to the automation tab, and silent `TARGET_STALE`/script-crash catch-masking is removed.

This phase is atomic on the settle seam: post-reload capture/eval must NEVER be scheduled without passing through the settled lifecycle state. The seam is built here (not Phase 2) because `NativeTabHost.reloadAndWait()` resolves at `did-start-navigation` — a post-reload `inspect()`/`eval` before `did-finish-load` reads mid-navigation DOM and throws "Script failed to execute" or returns empty markup.

## Requirements

- Functional: `validate()` reorders reload before evidence capture; settles load stability (bounded timeout); propagates the fresh target to every port call; confines `tabId`; fails fast (no fallback) on stale/missing reload.
- Functional: reload/settle timeout is distinct from target staleness (Finding R5); a navigation in flight on timeout is cancelled (Finding R5/R9).
- Non-functional: `BrowserHostPort.reload` signature stays stable; settle is additive (Finding R12); public capability schemas unchanged; no behavior change to scanners' static-analysis fallbacks except stale-target and script-crash cases.
- Security (Finding R2): `validate()`/`resolveTargetTab()` must not reload an arbitrary caller-supplied `tabId` (confused-deputy); confine to the automation tab / bound storefront.

## Architecture

```
input.target (gen N) ──► assert ownership + TAB CONFINEMENT (R2: target.tabId === automation tab)
        │
        ▼
  ports.reload(input.target)          // BrowserControlPort.reload → host.reloadAndWait
        │  { reloaded, target }       // resolves at did-start-navigation (NOT did-finish-load)
        ▼
  LOAD-STABLE SETTLE  (new seam, built here — R1)
        │  wait did-finish-load / generation-settle re-read; bounded timeout
        │  splitMode: await BOTH panes (R7)
        │  timeout ─► stopLoading(tabId) + CapabilityError('LOAD_SETTLE_TIMEOUT', {phase:'load_settle', timeoutMs}) (R5/R9)
        │  stale/epoch mismatch ─► CapabilityError('TARGET_STALE')
        ▼
  activeTarget = settle(reload.target)   // generation RE-STAMPED from host AFTER settle (R4)
        │
        ├─ inspect(dom/screenshot) AFTER settle          (evidence = gen N+1)
        ├─ browser.eval(Liquid/Overflow/Assets/HsRules)  (activeTarget)
        ├─ listTabs({target: activeTarget})              (contextUrl)
        ├─ responsiveCheck(activeTarget) — assertCurrent BEFORE host call (R6)
        └─ reportDataRaw / ThemeQaReport.target = activeTarget
```

Contract facts (verified): `BrowserControlPort.reload(target)` at `browser-control-port.ts:50-56` already returns `Promise<{ reloaded: boolean; target: BrowserTarget }>`; `BrowserHostPort.reload(tabId)` returns `Promise<boolean> | boolean` (`browser-control-port.ts:11`); `NativeTabHost.reloadAndWait(tabId)` (`native-tab-host.ts:2502-2563`) resolves on `did-start-navigation` via `createNavigationStartWaiter` (3s timeout), and `getDom`/`evalJs` execute `wc.executeJavaScript` on the active view (`native-tab-host.ts:3606-3630`). `NativeTabHost.isCurrentTarget` (`native-tab-host.ts:4387-4402`) validates 6 fields: tabId, documentGeneration, browserEpoch, projectId, workspaceId, runtimeId.

## Related Code Files

- Modify: `src/main/qa/theme-qa-workflow.ts` (`validate()` ~83-353; ownership/tab confinement ~355-358; catch blocks 140-152, 163-170, 207-241, 251-263)
- Modify (additive seam only): `src/main/tools/browser-control-port.ts` (settle surface ~50-65; responsiveCheck target assertion ~108-111), `src/main/browser/native-tab-host.ts` (settle option on reloadAndWait OR `settleTab(tabId, timeoutMs?)`; stopLoading already exists at ~2565-2573)
- Wire: `src/main/index.ts:182`, split-view tab host, `src/main/control-plane/control-plane-runtime.ts:99`

## Implementation Steps

1. **Target confinement (R2):** in `validate()` ownership validation and in `BrowserControlPort.resolveTargetTab()`, assert `target.tabId === host.getAutomationTabId()` (or explicit storefront-scoped bind); reject non-automation `tabId` (`CapabilityError('TARGET_REQUIRED' or 'TARGET_STALE')`) before any reload/eval. A caller-supplied `tabId` that differs from the bound automation tab is refused, never silently retargeted.
2. **Reload first:** `const reload = await this.ports.reload(input.target);` (after ownership validation). Guard: `if (!reload.reloaded || !reload.target) throw CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded')` — plus timeout-cancellation per step 3.
3. **Load-stable settle seam (R1, R5, R7, R9):** add to `BrowserHostPort` an additive `settleTab?(tabId, timeoutMs?) => Promise<boolean>` (or `reloadAndWait(tabId, { waitForLoad?: true })` with default back-compat — do NOT change the existing `reload` signatures, `browser-control-port.ts:11` + mock hosts in `test/main/` must keep compiling). The settle waits for load completion (`did-finish-load`) and re-reads `host.getDocumentGeneration(tabId)`; when `splitMode` is active it awaits BOTH `view` and `mobileView` webContents (`native-tab-host.ts:2488-2495` reloads both; the current waiter binds only the authority view — R7). On timeout: invoke `stopLoading(tabId)` (`native-tab-host.ts:2565-2573`) then throw `CapabilityError('LOAD_SETTLE_TIMEOUT', ..., { phase: 'load_settle', timeoutMs })` — NOT `TARGET_STALE` (R5: `TARGET_STALE` in `control-plane-contracts.ts:262-276` means the target is invalid/re-bind needed; a slow storefront is transient). Only `isCurrentTarget` failure (generation/epoch mismatch) yields `TARGET_STALE`.
4. **Re-stamp target after settle (R4):** `const settled = await settle(reload.target);` then `const activeTarget: BrowserTarget = { ...settled, documentGeneration: host.getDocumentGeneration(tabId) }` — generation is sampled AFTER settle so intermediate redirects (301/meta-refresh/client-side) that bumped the generation during settlement do not produce a false `TARGET_STALE` (`native-tab-host.ts:1724-1738` increments on every main-frame navigation).
5. **Post-settle evidence capture:** `const evidence = await this.inspect({ ...input, target: activeTarget });` then derive `rawHtml` from fresh `evidence.dom`.
6. **Propagate `activeTarget`:** replace every post-reload `input.target` use: `browser.eval` (LiquidErrorScanner, LayoutOverflowEngine('active'), BrokenAssetScanner, HsGateRules), `browser.listTabs({ target: activeTarget })`, `browser.responsiveCheck(activeTarget)` — update `BrowserControlPort.responsiveCheck` to accept a `BrowserTarget` and run `resolveTargetTab`/`assertCurrent` before the host call (R6; currently `responsiveCheck(tabId)` at `browser-control-port.ts:108-111` bypasses `assertCurrent`, so a navigation mid-sweep would evaluate a stale WebContents at `native-tab-host.ts:4205-4260`).
7. **Catch-block policy (R3-adjacent/R8):**
   - `CapabilityError` `TARGET_STALE`/`TARGET_REQUIRED` → rethrow (never fall back).
   - Eval script execution failures (CSP violation, script crash, DOM clobbering) → record an explicit diagnostic issue or fail the check — **never** synthesize a clean pass. This applies to `LayoutOverflowEngine` (`theme-qa-workflow.ts:167-172` currently returns `{ hasOverflow: false, deltaX: 0, culprits: [] }`) and `BrokenAssetScanner` (`theme-qa-workflow.ts:212-214` currently returns `{ hasBrokenAssets: false, brokenAssets: [] }`).
   - Genuine static-analysis fallback (e.g. `LiquidErrorScanner.scanHtmlString(rawHtml)`, `HsGateRules.evaluateHtml(rawHtml)`) is retained only for those scanners that have one.
8. **Report integrity:** `reportDataRaw` and returned `ThemeQaReport.target` carry `activeTarget` (generation = post-settle).

## Success Criteria

- [ ] All post-reload browser calls receive a target whose `documentGeneration` equals the host's current generation (no `TARGET_STALE` during a normal run) and whose 6 lease fields survive (`native-tab-host.ts:4387-4402`).
- [ ] `inspect()` DOM/screenshot captured strictly after settle; a pre-settle call is impossible by construction (settle awaited first).
- [ ] Reload timeout → `LOAD_SETTLE_TIMEOUT` with `{ phase: 'load_settle', timeoutMs }` + `stopLoading` called; generation/epoch mismatch → `TARGET_STALE`; neither is swallowed.
- [ ] Caller-supplied `tabId` that is not the automation tab is rejected before reload/eval.
- [ ] `responsiveCheck` asserts target currency before executing the sweep.
- [ ] No scanner masks `TARGET_STALE` or a script-crash into a synthetic pass.
- [ ] `src/main/tools/browser-capabilities.ts` `theme.qa_validate` schema untouched; `BrowserHostPort.reload` signature untouched.

## Risk Assessment

- **Risk (R1 inverted ordering):** settle seam lands in Phase 2 → Phase 1 capture on mid-navigation DOM. *Signal:* phase file ordering shows reload→inspect without settle. *Response:* seam is IN this phase; Phase 2 depends on [1].
- **Risk:** settle timeout on legitimately slow storefronts. *Signal:* `reload.reloaded === false` or `settleTab` timeout. *Response:* distinct `LOAD_SETTLE_TIMEOUT` (details) + `stopLoading`; orchestrator retries/escalates — the tab is NOT treated as destroyed.
- **Risk:** live-scanner evals now surface errors where they previously fell back, breaking tests that relied on clean-pass defaults. *Signal:* test failures in `theme-qa-vertical-slice.test.ts`. *Response:* Phase 3 redesigns the mock; the fallback behavior is the bug, not the tests.
- **Risk:** additive seam misnames the contract (`BrowserControlPort.reload` already returns `{reloaded, target}`; `BrowserHostPort.reload` returns boolean — R12). *Signal:* type errors/mock churn. *Response:* settle is a NEW additive method/option; existing signatures untouched.