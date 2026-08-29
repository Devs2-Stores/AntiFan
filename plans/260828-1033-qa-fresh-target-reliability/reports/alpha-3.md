# Implementation Plan: AntiFan Theme QA Fresh-Target Reliability (Candidate 1)

## Executive Summary
This plan addresses the critical reliability defect (**P0-1**) in `ThemeQaWorkflow.validate()` where browser state evaluations operate on stale targets (`documentGeneration`) after tab reload, causing silent fallback to pre-reload HTML/defaults. It also incorporates conditional engine hardening (**P1-4**) and specifies a lifecycle-grounded regression test suite.

---

## 1. Goals & Non-Goals

| Goal ID | Priority | Description | Target Surface |
| :--- | :--- | :--- | :--- |
| **G-01** | **MUST** (P0-1) | Propagate `reload.target` (fresh `documentGeneration`) to all post-reload operations (`inspect`, `eval`, `listTabs`, `report`). | `src/main/qa/theme-qa-workflow.ts` |
| **G-02** | **MUST** (P0-1) | Reorder evidence capture (`inspect`) to execute **after** reload so DOM/screenshots reflect post-edit state. | `src/main/qa/theme-qa-workflow.ts` |
| **G-03** | **MUST** (P0-1) | Ensure load stability across reload and prevent silent catch-masking of `TARGET_STALE` errors. | `src/main/qa/theme-qa-workflow.ts`, `src/main/tools/browser-control-port.ts` |
| **G-04** | **CONDITIONAL** (P1-4) | Replace permissive internal caller overrides (`checklist?: Partial<ThemeQaChecklist>`) with `enabledChecks?: Array<keyof ThemeQaChecklist>`. | `src/main/qa/theme-qa-workflow.ts` |
| **G-05** | **MUST** (Test) | Implement lifecycle-aware regression tests verifying generation bump and rejection of stale targets. | `test/integration/theme-qa-vertical-slice.test.ts`, `test/main/theme-qa-fresh-target.test.ts` |

### Non-Goals (Out of Scope / Dropped)
- **Do NOT re-implement plan `260827-2211` deliverables**: Diagnostics buffer clearing on navigation, origin filter module, and annotation prompt are complete.
- **P1-6 (Terminal Capsule)**: Architectural policy ("tabs never disappear"); no code changes.
- **P1-5 (2-Round QA Loop)**: Stateless single-shot validator; multi-turn looping belongs in agent/prompt layer.
- **P1-3 (openTab retarget)**: Deferred; alias contract compatibility required.

---

## 2. Technical Root Cause Analysis

In `ThemeQaWorkflow.validate()` (`src/main/qa/theme-qa-workflow.ts:83-163`):
1. **Stale Target Propagation**: `const reload = await this.ports.reload(input.target);` produces `{ reloaded: true, target: BrowserTarget }` with incremented `documentGeneration`. However, subsequent calls (`eval`, `listTabs`, report generation) continue using `input.target`.
2. **Inverted Evidence Capture**: `this.inspect({ ...input })` is executed at line 119 **before** `this.ports.reload()` at line 120, freezing pre-reload DOM and screenshot as the official evidence.
3. **Silent Error Fallback**: When `ports.browser.eval(input.target, ...)` runs, `BrowserControlPort.resolveTargetTab()` calls `assertCurrent(currentTarget)` (`browser-control-port.ts:290-295`), which checks `host.isCurrentTarget(target)` (`native-tab-host.ts:4390-4392`). Because `target.documentGeneration !== currentGen`, it throws `CapabilityError('TARGET_STALE')`. Scanners (`LiquidErrorScanner`, `LayoutOverflowEngine`, `BrokenAssetScanner`, `HsGateRules`) catch this exception and silently fall back to pre-reload `rawHtml` or clean default results.
4. **Diagnostics Timing**: Initial diagnostics snapshot is captured at line 99 before navigation start clears the buffer (`native-tab-host.ts:1737`). A fresh capture after reload is required to capture parse/runtime errors of the newly loaded document.

---

## 3. Implementation Phases

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Workflow Execution Flow & Target Propagation  │
│          (Reorder reload/inspect, propagate target)    │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ Phase 2: Diagnostics Refresh & Conditional Hardening   │
│          (Post-reload diagnostics, enabledChecks)      │
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│ Phase 3: Lifecycle-Aware Test Harness & Verification   │
│          (Generation bump simulation, parity tests)    │
└────────────────────────────────────────────────────────┘
```

### Phase 1: Workflow Execution Flow & Target Propagation
**Primary Target**: `src/main/qa/theme-qa-workflow.ts`
**Supporting Target**: `src/main/tools/browser-control-port.ts`

#### File Inventory
- `src/main/qa/theme-qa-workflow.ts` (lines 83–353)
- `src/main/tools/browser-control-port.ts` (lines 58–70)

#### Implementation Steps
1. **Reorder Execution Sequence**:
   - In `ThemeQaWorkflow.validate()`, invoke `this.ports.reload(input.target)` immediately after target ownership validation (`assertOwnership`).
   - Validate reload outcome: `if (!reload.reloaded || !reload.target) throw new CapabilityError('TARGET_STALE', 'Failed to reload target browser tab');`.
   - Define `activeTarget: BrowserTarget = reload.target;`.
2. **Post-Reload Evidence Capture**:
   - Execute `const evidence = await this.inspect({ ...input, target: activeTarget });` **after** reload.
   - Extract `rawHtml` from fresh `evidence.dom`.
3. **Propagate `activeTarget` to All Port Operations**:
   - Update `this.ports.browser.listTabs({ target: activeTarget })` for tab context URL resolution.
   - Update all `this.ports.browser.eval(activeTarget, ...)` invocations for:
     - Liquid error scanner (`LiquidErrorScanner.getBrowserScanScript()`)
     - Layout overflow engine (`LayoutOverflowEngine.getBrowserScanScript('active')`)
     - Broken asset scanner (`BrokenAssetScanner.getBrowserScanScript()`)
     - Platform-scoped HS gate rules (`HsGateRules.getBrowserEvaluationScript(detectedPlatform)`)
   - Update `this.ports.browser.responsiveCheck(activeTarget.tabId)`.
4. **Hardened Error Handling**:
   - Distinguish between runtime scan evaluation errors and fatal `TARGET_STALE` errors. If `this.ports.browser.eval()` throws `TARGET_STALE` (or target mismatch), propagate or record target invalidation rather than falling back to fake clean passes.
5. **Report Target Integrity**:
   - Populate `target: activeTarget` in the final sanitized `ThemeQaReport` and report artifacts (replacing `input.target`).

#### Success Criteria
- [ ] `validate()` executes all browser queries with `activeTarget.documentGeneration === freshGen`.
- [ ] `inspect()` produces DOM and screenshots strictly from the reloaded document state.
- [ ] No scanner catches and masks `TARGET_STALE` to return a synthetic pass.

#### Risks & Signals
- **Risk**: Target reload timeout on slow network/storefront.
- **Signal**: `ports.reload()` throws `TARGET_STALE` after 3000ms timeout (`native-tab-host.ts:2548`).
- **Mitigation**: Preserve explicit error propagation so caller receives actionable retry signal instead of poisoned report.

---

### Phase 2: Diagnostics Refresh & Conditional Engine Hardening
**Primary Target**: `src/main/qa/theme-qa-workflow.ts`
**Supporting Target**: `src/main/tools/browser-capabilities.ts`

#### File Inventory
- `src/main/qa/theme-qa-workflow.ts` (lines 83–116, 265–285)
- `src/main/tools/browser-capabilities.ts` (lines 165–178)

#### Implementation Steps
1. **Fresh Diagnostics Snapshot**:
   - Since `native-tab-host.ts:1737` clears diagnostics at `did-start-navigation`, snapshot diagnostics **after** reload completion to capture compilation, Liquid, and console errors from the fresh document load.
   - Update `contextUrl` derivation using `activeTarget`.
2. **Conditional Hardening (P1-4: `enabledChecks`)**:
   - Refactor `ThemeQaWorkflow.validate` input options:
     ```typescript
     // From: checklist?: Partial<ThemeQaChecklist>;
     // To:
     enabledChecks?: Array<keyof ThemeQaChecklist>;
     ```
   - In Step 7 of `validate()`, compute full checklist statuses based purely on engine rules (`layout`, `responsive`, `overflow`, `interactions`, `diagnostics`, `liquidClean`, `assetsValid`, `hsCompliant`).
   - If `enabledChecks` is provided, compute `summary.passed` over only the subset of enabled checks (`enabledChecks.every((k) => checklist[k])`), preventing external callers from forging arbitrary boolean status overrides on individual checks.
   - Maintain public schema stability: `src/main/tools/browser-capabilities.ts:170` inputSchema remains `{ tabId, workspaceRoot, multiBreakpoint }` (public callers cannot bypass checks).

#### Success Criteria
- [ ] Diagnostics filter correlates network failures and console issues from the newly reloaded page generation.
- [ ] Internal engine retains authoritative ownership of checklist evaluation without arbitrary override vulnerabilities.

#### Risks & Signals
- **Risk**: Diagnostics recorded during initial page setup prior to validate could be lost if not captured.
- **Signal**: Diagnostics empty if reload is clean.
- **Mitigation**: Intentional design per `260827-2211`—diagnostics buffer clears on navigation start, preserving errors that occur during the fresh parse.

---

### Phase 3: Lifecycle-Aware Test Harness & Verification
**Primary Target**: `test/integration/theme-qa-vertical-slice.test.ts`
**Supporting Target**: `test/main/theme-qa-fresh-target.test.ts`

#### File Inventory
- `test/integration/theme-qa-vertical-slice.test.ts`
- `test/main/theme-qa-fresh-target.test.ts` (new test file)
- `test/main/theme-qa-parity.test.ts`

#### Implementation Steps
1. **Mock Lifecycle Host with Generation Tracking**:
   - Create test harness where `reload()` increments internal `documentGeneration` from 1 to 2.
   - Configure `isCurrentTarget(target)` to strictly validate `target.documentGeneration === currentGen`.
   - Configure `evalJs`, `getDom`, and `captureScreenshot` to return distinct content for generation 1 (stale/broken) vs generation 2 (fixed/clean).
2. **Vertical Slice Regression Tests**:
   - **Test 1: Target Propagation**: Assert that all calls to `evalJs`, `getDom`, and `screenshot` receive `target.documentGeneration === 2`.
   - **Test 2: Rejection of Stale Caller Target**: Assert that passing target with generation 1 to post-reload operations triggers `TARGET_STALE` if not updated by workflow.
   - **Test 3: Evidence Grounding**: Verify that `report.artifacts` and `report.target` contain generation 2 metadata and post-reload HTML.
   - **Test 4: Parity Check**: Run `test/main/theme-qa-parity.test.ts` to confirm parity between full workflow and fallback execution paths.

#### Success Criteria
- [ ] `node --test test/main/theme-qa-fresh-target.test.ts` passes 100%.
- [ ] `node --test test/integration/theme-qa-vertical-slice.test.ts` passes 100%.
- [ ] `node --test test/main/theme-qa-parity.test.ts` passes 100%.

#### Risks & Signals
- **Risk**: Mock divergence from Electron `NativeTabHost` event lifecycle.
- **Signal**: Mocks pass but live Electron runtime behaves differently.
- **Mitigation**: Unit mock enforces the exact contract implemented in `native-tab-host.ts:4387-4401` (`isCurrentTarget`).

---

## 4. Acceptance Criteria

- [ ] **AC-1 (Target Propagation)**: `ThemeQaWorkflow.validate()` uses `reload.target` (with updated `documentGeneration`) for all subsequent port interactions (`dom`, `screenshot`, `eval`, `listTabs`).
- [ ] **AC-2 (Evidence Freshness)**: `evidence.dom` and `evidence.screenshot` are captured **after** reload.
- [ ] **AC-3 (Fail-Fast on Stale Target)**: Target mismatch or reload failure throws `CapabilityError('TARGET_STALE')` without falling back to pre-reload HTML.
- [ ] **AC-4 (P1-4 Hardening)**: Caller overrides cannot arbitrarily force checklist pass states; `enabledChecks` limits evaluation scope while engine computes truth.
- [ ] **AC-5 (Sanitized Report Output)**: Final `ThemeQaReport.target.documentGeneration` equals the post-reload generation.
- [ ] **AC-6 (Test Coverage)**: Comprehensive automated test suite validates generation bump and fails if `input.target` is reused.

---

## 5. Deferred Items & Promotion Triggers

| Item ID | Description | Reason for Deferral | Promotion Trigger |
| :--- | :--- | :--- | :--- |
| **DEF-01** | Full-chain CLI→MCP→Browser→QA integration test (Test A) | Requires running Electron binary and live CDP connection in headless test environment. | CI runner infrastructure with display server / XVFB is configured. |
| **DEF-02** | Automated CI Workflow (.github / .gitlab-ci) | Repository currently lacks CI workflow configuration files. | User designates target CI hosting provider. |
| **DEF-03** | `openTab` retarget alias migration (P1-3) | Current bridge attachment dispatch tests assert `antifan_open_tab` retargets automation tab. | Deprecation and migration of legacy bridge alias contracts. |
| **DEF-04** | Surface audits (stdio proxy, eval_js, plugin-sdk, artifacts) | Read-only hygiene and audit scope, not blocking functional correctness. | General codebase security audit cycle. |

---

## 6. Risk Assessment & Mitigation

| Risk | Severity | Impact | Mitigation Strategy |
| :--- | :--- | :--- | :--- |
| Reload timeout on heavy storefront | Medium | Validate fails before running checks | Propagate `TARGET_STALE` with clear diagnostic error message. |
| Diagnostic race during reload | Low | Logs emitted between start and finish | Diagnostics buffer is cleared synchronously at `did-start-navigation` and captures all load events up to evaluation. |
| Breakpoint sweep target staleness | Medium | Responsive checks query old generation | Pass `activeTarget.tabId` and ensure target validity in `responsiveCheck`. |

---

## 7. Open Questions

1. **Wait State Granularity**: Does `reloadAndWait` in `native-tab-host.ts:2502` need to wait for `did-finish-load` or `dom-ready` in addition to `did-start-navigation` for slow network pages? *(Current recommendation: Navigation start waiter is sufficient for generation bump; DOM queries handle ready state via script eval).*
2. **Artifact Retention Policy**: Should pre-reload artifacts be retained in artifact store for differential debugging? *(Current recommendation: No, discard pre-reload evidence to prevent storage bloat and ensure reports contain only verified post-edit state).*

---
*Report generated for candidate evaluation: `plans/260828-1033-qa-fresh-target-reliability/reports/planner-ultra-candidate-1.md`*
