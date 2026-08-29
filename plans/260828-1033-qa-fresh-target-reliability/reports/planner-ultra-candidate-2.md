# Plan: AntiFan QA Fresh-Target Reliability (Candidate 2)

## Executive Summary

Resolves the **stale-target propagation defect (P0-1)** in `ThemeQaWorkflow.validate()` where reload results are discarded, causing post-reload operations (`eval`, `inspect`, `responsiveCheck`) to execute with an obsolete `documentGeneration`. When `BrowserControlPort.assertCurrent()` detects the generation mismatch, `TARGET_STALE` is thrown and silently swallowed in scanner catch blocks, evaluating stale pre-reload HTML or empty fallbacks.

The plan delivers:
1. Full propagation of `reload.target` (fresh `documentGeneration`) across all post-reload inspections and scanners.
2. Reordering DOM snapshot, screenshot, and diagnostics capture to execute strictly *after* reload.
3. Propagating `TARGET_STALE` errors rather than silently falling back to obsolete state.
4. Lifecycle regression test suite modeling generation bumps and stale-target rejection.
5. Conditional internal hardening of `enabledChecks` (P1-4) without altering public capability schemas.

---

## 1. Goals & Success Matrix

| ID | Category | Objective | Verification Metric | Status |
|---|---|---|---|---|
| **G-01** | **Core Fix (P0-1)** | Propagate `reload.target` across all post-reload scanners | All `browser.eval`, `dom`, `screenshot`, `responsiveCheck` calls receive fresh `documentGeneration`. | **MUST** |
| **G-02** | **Lifecycle Order (P0-1)** | Reorder `inspect()` and diagnostics capture post-reload | DOM/Screenshot and CDP diagnostics snapshot reflect freshly reloaded page state. | **MUST** |
| **G-03** | **Failure Integrity (P0-1)** | Eliminate silent fallback on stale target or generation mismatch | `TARGET_STALE` errors abort the QA run with an actionable error rather than evaluating obsolete HTML. | **MUST** |
| **G-04** | **Regression Gate (P0-1)** | Lifecycle regression test modeling generation bumps | Test suite with simulated `documentGeneration` bump and `isCurrentTarget` assertion catches stale target usage. | **MUST** |
| **G-05** | **Hardening (P1-4)** | Internal checklist override sanitization (`enabledChecks`) | Checklist filter cannot artificially flip engine-computed verdicts; public schema unchanged. | **Conditional** |

---

## 2. Implementation Phases

```
┌────────────────────────────────────────────────────────────────────────┐
│ Phase 1: Workflow Lifecycle Reordering & Fresh Target Propagation      │
│ (src/main/qa/theme-qa-workflow.ts)                                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Phase 2: Post-Reload Diagnostic Capture & Settle Synchronization       │
│ (src/main/qa/theme-qa-workflow.ts, browser-control-port.ts)            │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Phase 3: Defensive Exception Handling (Remove Silent Stale Fallbacks)  │
│ (src/main/qa/theme-qa-workflow.ts)                                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Phase 4: Conditional Hardening of Internal Checklist Overrides (P1-4)  │
│ (src/main/qa/theme-qa-workflow.ts)                                     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
┌───────────────────────────────────▼────────────────────────────────────┐
│ Phase 5: Vertical Slice & Lifecycle Regression Test Suite              │
│ (test/integration/theme-qa-vertical-slice.test.ts, test/main/...)      │
└────────────────────────────────────────────────────────────────────────┘
```

### Phase 1: Workflow Lifecycle Reordering & Fresh Target Propagation

- **Target Files**: `src/main/qa/theme-qa-workflow.ts` (lines 83–155, 314–353)
- **Problem & Root Cause**:
  - `theme-qa-workflow.ts:119-121`: `inspect()` runs before `ports.reload(input.target)`.
  - `const reload = await this.ports.reload(input.target)` returns fresh `reload.target` with bumped `documentGeneration` (e.g. gen 2), but downstream calls (`browser.eval` lines 142, 164, 208, 253; `responsiveCheck` line 173; report serialization lines 319, 346) continue using stale `input.target` (gen 1).
- **Implementation Steps**:
  1. Trigger reload at the start of `validate()` and capture `freshTarget`:
     ```ts
     const reload = await this.ports.reload(input.target);
     if (!reload.reloaded || !reload.target) {
       throw new CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded');
     }
     const freshTarget = reload.target;
     ```
  2. Reorder `inspect()` to run immediately after reload using `freshTarget`:
     ```ts
     const evidence = await this.inspect({ ...input, target: freshTarget });
     ```
  3. Propagate `freshTarget` to all subsequent port calls:
     - `this.ports.browser.eval(freshTarget, LiquidErrorScanner.getBrowserScanScript())`
     - `this.ports.browser.eval(freshTarget, LayoutOverflowEngine.getBrowserScanScript('active'))`
     - `this.ports.browser.responsiveCheck(freshTarget.tabId)`
     - `this.ports.browser.eval(freshTarget, BrokenAssetScanner.getBrowserScanScript())`
     - `this.ports.browser.eval(freshTarget, HsGateRules.getBrowserEvaluationScript(detectedPlatform))`
  4. Ensure report serialization and output return `target: freshTarget`.
- **Success Criteria**:
  - All downstream scanner calls receive `freshTarget` matching active `documentGeneration`.
  - Report JSON metadata outputs the verified fresh target.
- **Risks & Signals**:
  - *Risk*: Callers expecting pre-reload screenshot. *Signal*: QA contract specifies evaluating post-edit storefront state.

---

### Phase 2: Post-Reload Diagnostic Capture & Settle Synchronization

- **Target Files**:
  - `src/main/qa/theme-qa-workflow.ts` (lines 93–116, 213–249)
  - `src/main/tools/browser-control-port.ts` (lines 59–65)
  - `src/main/browser/native-tab-host.ts` (lines 1725–1743, 2502–2518)
- **Problem & Root Cause**:
  - `theme-qa-workflow.ts:97-106` snapshots diagnostics before reload to avoid a race with navigation buffer clearing (`native-tab-host.ts:1737`).
  - This reads errors from the *previous* lifecycle. Since `did-start-navigation` clears the buffer while `did-finish-load` preserves parse/runtime errors, diagnostics read *after* reload reflect the fresh page.
- **Implementation Steps**:
  1. Move `contextUrl` resolution and `diagnosticsSnapshot` capture to execute after `ports.reload()` settles.
  2. Use `freshTarget` for context query:
     ```ts
     const tabs = this.ports.browser.listTabs({ target: freshTarget });
     ```
  3. Query `this.ports.browser.diagnostics(freshTarget.tabId)` after reload.
  4. Ensure `BrowserControlPort.reload()` accurately reads `this.host.getDocumentGeneration(tabId)`.
- **Success Criteria**:
  - Diagnostics evaluated in Step 5.5 (`classifyDiagnostics`) reflect the fresh page reload.
  - Pre-reload errors do not contaminate the new report.
- **Risks & Signals**:
  - *Risk*: Async console logs arriving mid-scan. *Signal*: Navigation waiter guarantees document load completion.

---

### Phase 3: Defensive Exception Handling (Remove Silent Stale Fallbacks)

- **Target Files**:
  - `src/main/qa/theme-qa-workflow.ts` (lines 141–152, 163–170, 207–241, 252–263)
  - `src/main/tools/browser-control-port.ts` (lines 294–296)
- **Problem & Root Cause**:
  - Catch blocks in `validate()` catch all errors uniformly.
  - When `BrowserControlPort.assertCurrent()` throws `CapabilityError('TARGET_STALE')`, the error is swallowed and the scanner falls back to `rawHtml` or empty results, masking underlying failures.
- **Implementation Steps**:
  1. Differentiate `CapabilityError` from ordinary script errors in catch blocks:
     ```ts
     catch (err) {
       if (err instanceof CapabilityError && (err.code === 'TARGET_STALE' || err.code === 'TARGET_REQUIRED')) {
         throw err;
       }
       if (rawHtml) {
         liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
       }
     }
     ```
  2. Apply selective catch policy to Liquid scanner, Layout Overflow scanner, Broken Asset scanner, and HS Rules.
- **Success Criteria**:
  - Target invalidation immediately aborts validation with `TARGET_STALE`.
  - Harmless page-script errors still degrade gracefully to static analysis fallbacks.
- **Risks & Signals**:
  - *Risk*: Aborting on non-critical script failures. *Signal*: Only `CapabilityError` with `TARGET_STALE` / `TARGET_REQUIRED` rethrows.

---

### Phase 4: Conditional Hardening of Internal Checklist Overrides (P1-4)

- **Target Files**:
  - `src/main/qa/theme-qa-workflow.ts` (lines 88, 265–284)
  - `src/shared/browser-capabilities.ts` (lines 166–176)
- **Context & Boundary**:
  - Public capability schema `theme.qa_validate` (`browser-capabilities.ts:170`) accepts `{ tabId, workspaceRoot, multiBreakpoint }` with no checklist overrides.
  - `theme-qa-workflow.ts:88` accepts `checklist?: Partial<ThemeQaChecklist>` internally and overrides computed statuses (lines 277–283), allowing callers to force `summary.passed`.
- **Implementation Steps**:
  1. Refactor internal parameter from status override `checklist?: Partial<ThemeQaChecklist>` to `enabledChecks?: Partial<Record<keyof ThemeQaChecklist, boolean>>`.
  2. When `enabledChecks` is provided, exclude disabled checks from verdict calculation rather than forcing a pass on failures:
     ```ts
     const activeChecks = Object.entries(checklist).filter(([key]) => {
       if (!input.enabledChecks) return true;
       return input.enabledChecks[key as keyof ThemeQaChecklist] !== false;
     });
     summary.passed = activeChecks.every(([, passed]) => passed);
     ```
  3. Keep `browser-capabilities.ts:166-176` unchanged.
- **Success Criteria**:
  - Callers cannot artificially force a failing check to pass.
  - Public capability schema remains stable.
- **Risks & Signals**:
  - *Risk*: Test helper regressions. *Signal*: Grep all `validate(` call sites across tests.

---

### Phase 5: Vertical Slice & Lifecycle Regression Test Suite

- **Target Files**:
  - `test/integration/theme-qa-vertical-slice.test.ts`
  - `test/main/theme-qa-fresh-target.test.ts` (new test suite)
- **Problem & Gap**:
  - Existing `test/integration/theme-qa-vertical-slice.test.ts` uses a static mock `BrowserHostPort` without `isCurrentTarget` checks (`reload: () => true`), missing the generation mismatch bug.
- **Implementation Steps**:
  1. Author `test/main/theme-qa-fresh-target.test.ts` with a stateful mock host:
     - Maintains `documentGeneration` counter incremented on `reload()`.
     - Implements `isCurrentTarget(target)` asserting `target.documentGeneration === this.currentGen`.
     - Implements `evalJs(expr, tabId)` checking target freshness before running.
  2. Test Cases:
     - Full validation run completes using post-reload generation.
     - Stale target input or failed generation bump throws `TARGET_STALE`.
     - Output report contains updated `target.documentGeneration`.
  3. Update `test/integration/theme-qa-vertical-slice.test.ts` mock host to validate generation tracking.
- **Success Criteria**:
  - `npm test` runs suite to 100% pass rate.
  - Stale target regressions are mechanically caught.
- **Risks & Signals**:
  - *Risk*: Mock divergence from `NativeTabHost`. *Signal*: Strict typing via `BrowserHostPort`.

---

## 3. Acceptance Criteria

- [ ] **AC-1 (Target Propagation)**: `reload.target` is propagated to all post-reload browser calls (`inspect`, `eval`, `responsiveCheck`, `diagnostics`, `listTabs`).
- [ ] **AC-2 (Evidence Freshness)**: `this.inspect()` runs *after* `ports.reload()` completes, capturing post-reload DOM and screenshot.
- [ ] **AC-3 (Diagnostics Alignment)**: Diagnostics snapshotting in `validate()` occurs post-reload, capturing errors from the fresh page load.
- [ ] **AC-4 (Stale Target Error)**: `TARGET_STALE` errors from `BrowserControlPort.assertCurrent()` abort the validation run instead of being swallowed.
- [ ] **AC-5 (Report Fidelity)**: Returned `ThemeQaReport` and staged JSON report contain `target` with the updated `documentGeneration`.
- [ ] **AC-6 (Test Coverage)**: Automated unit/integration tests verify:
  - Generation increment during reload.
  - `browser.eval` execution with fresh target.
  - Rejection of stale target inputs with `TARGET_STALE`.
- [ ] **AC-7 (Public Schema Stability)**: Public schema in `src/main/tools/browser-capabilities.ts:166-176` remains unchanged.

---

## 4. Scope Boundaries & Deferred Items

| Item | Classification | Rationale | Trigger for Promotion |
|---|---|---|---|
| **P0-1 Target Propagation** | **IN SCOPE (MUST)** | Core bug causing invalid QA verdicts on reloaded pages. | N/A (Immediate) |
| **P1-4 Checklist Hardening** | **IN SCOPE (Conditional)** | Internal integrity fix while refactoring `theme-qa-workflow.ts`. | N/A (In-phase) |
| **Full-chain Test A in npm test** | **DEFERRED** | Requires orchestrating MCP proxy + Electron in CI; tests B, C, D pass (14/14). | User defines `Final` acceptance as requiring end-to-end CLI→MCP→Browser test. |
| **CI Configuration** | **DEFERRED** | No `.github/` or CI runner currently exists in repository. | Infrastructure selection / CI provider setup. |
| **P1-3 openTab Retarget** | **DEFERRED** | `browser-control-port.ts:85-92` alias behavior is pinned by `bridge-attachment-dispatch.test.js`. | Dedicated bridge alias cleanup refactor. |
| **P1-6 Terminal Capsule** | **DROPPED** | Intentional UX migration policy ("tabs never disappear"). | None. |
| **P1-5 2-Round QA Loop** | **DROPPED** | Engine is single-shot validator; retry loop belongs in prompt layer. | None. |
| **Unanchored Surface Audit** | **DEFERRED** | `scripts/antifan-omp-mcp.cjs` and artifact directory size hygiene. | Dedicated security/hygiene sprint. |

---

## 5. Architectural Risks & Mitigations

| Risk | Impact | Mitigation Strategy |
|---|---|---|
| **Navigation Timeout during Reload** | High | `NativeTabHost.reloadAndWait()` uses a 3s waiter on `did-start-navigation`. On timeout, `reload.reloaded` is `false`, safely throwing `TARGET_STALE`. |
| **Race Condition on Console Logs** | Medium | Diagnostics buffer clears synchronously at `did-start-navigation` (`native-tab-host.ts:1737`). Parse errors are kept during load and captured post-settle. |
| **Split View Dual-Pane Reload** | Low | `native-tab-host.ts:2488-2495` reloads both panes; `reloadAndWait` tracks the authoritative focused pane. |

---

## 6. Open Questions & Assumptions

1. **Target Invalidation Behavior**: Assumed that closing a tab or navigating externally during QA validation should immediately abort with `TARGET_STALE` rather than returning a fallback report.
2. **Multi-Breakpoint Execution**: `responsiveCheck(freshTarget.tabId)` operates on active tab ID and does not alter `documentGeneration`.

---
*Report generated for candidate selection under plan `260828-1033-qa-fresh-target-reliability`.*
