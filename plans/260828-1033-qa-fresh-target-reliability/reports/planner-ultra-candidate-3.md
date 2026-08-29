# AntiFan QA Fresh-Target Reliability — Candidate 3 Plan
**Lens**: Regression-Test Sharpness & Real Reload Lifecycle Modeling  
**Target Path**: `E:\Work\apps\antifan-browser-desktop\plans\260828-1033-qa-fresh-target-reliability\reports\planner-ultra-candidate-3.md`  
**Status**: Ready for Synthesis  
**Scope Baseline**: HEAD `ae6b4358`, extending completed plan `260827-2211`

---

## 1. Executive Summary & Goals

In AntiFan Browser Desktop, `ThemeQaWorkflow.validate()` (`src/main/qa/theme-qa-workflow.ts:83-353`) performs an automated QA verification of storefront themes. However, a critical target-tracking defect (**P0-1**) causes every live QA validation round to execute against stale data or trigger silent scanner fallbacks:
1. `inspect()` (`theme-qa-workflow.ts:119`) captures DOM and screenshots **before** reload.
2. `ports.reload(input.target)` (`theme-qa-workflow.ts:120`) triggers navigation, bumping `documentGeneration` from $N \to N+1$ in `NativeTabHost`.
3. The workflow **ignores `reload.target`** and continues passing `input.target` (stale generation $N$) to `browser.eval`, `dom`, `screenshot`, and `listTabs`.
4. At runtime, `NativeTabHost.isCurrentTarget(input.target)` evaluates `target.documentGeneration !== currentGen` (`src/main/browser/native-tab-host.ts:4390-4392`) and rejects the call with `TARGET_STALE`.
5. Scanners catch the error and silently fall back to pre-reload `rawHtml` or empty objects, blinding QA to user edits.

Existing unit/integration tests in `test/integration/theme-qa-vertical-slice.test.ts` failed to catch this defect because they used a stateless mock host that lacked `isCurrentTarget` checks and did not simulate the navigation generation bump.

**Candidate 3 Plan** delivers the surgical fix for P0-1, reorders artifact capture, hardens internal check configuration (**P1-4**), and implements a high-fidelity regression test suite in `test/integration/theme-qa-reload-lifecycle.test.ts` that models the **real reload lifecycle** (generation bump at `did-start-navigation`, diagnostics buffer clearance, and fresh post-load evaluation).

### Goals Table

| Goal ID | Priority | Description | Target Surface | Success Measure |
| :--- | :--- | :--- | :--- | :--- |
| **G-01** | **P0 (MUST)** | Propagate `reload.target` across all post-reload browser calls & reorder evidence capture | `src/main/qa/theme-qa-workflow.ts` | 100% of post-reload calls use `freshTarget` ($N+1$); zero `TARGET_STALE` scanner fallbacks |
| **G-02** | **P0 (MUST)** | Implement stateful real-lifecycle regression test suite | `test/integration/theme-qa-reload-lifecycle.test.ts` | Test fails deterministically if `input.target` is used; validates generation bump, buffer clear, and DOM freshness |
| **G-03** | **P1 (Conditional)** | Internal `enabledChecks` hardening | `src/main/qa/theme-qa-workflow.ts:277-283` | Checklist override converted to internal check filtering; public MCP schemas untouched |
| **G-04** | **P2 (Deferred)** | Release confidence gate (Full-chain Test A & CI) | `test/e2e/`, CI workflows | Documented promotion triggers for CI pipeline and end-to-end integration |

---

## 2. Real Reload Lifecycle & Regression Test Architecture (Candidate 3 Core Lens)

### 2.1 The Real AntiFan Reload Lifecycle Contract
In production (`src/main/browser/native-tab-host.ts:1725-1745`, `2502-2565`):
1. **`reloadAndWait(tabId)`**: Initiates reload and hooks `did-start-navigation`.
2. **`did-start-navigation` (Synchronous)**:
   - `documentGenerations.set(tabId, gen + 1)` (Generation bumps $N \to N+1$).
   - `diagnosticsManager.clear(tabId)` (Console logs and network failure buffers cleared synchronously).
   - `themeQaState` reset to `idle`.
3. **`did-finish-load` (Load Completion)**:
   - Fresh DOM is rendered for generation $N+1$.
   - Fresh console messages and first-party asset network failures accumulate in `diagnosticsManager` for generation $N+1$.
4. **Control Plane Assertion**:
   - `BrowserControlPort.assertCurrent(target)` queries `host.isCurrentTarget(target)`.
   - Any operation using generation $N$ throws `CapabilityError('TARGET_STALE')`.

```
[NativeTabHost / BrowserHostPort]
  │
  ├─ 1. reload(tabId) ───────────────► did-start-navigation
  │                                      ├─ documentGeneration: N -> N+1
  │                                      └─ diagnosticsManager.clear()
  │
  ├─ 2. page parse & load ───────────► did-finish-load
  │                                      ├─ Fresh DOM rendered (gen N+1)
  │                                      └─ Fresh diagnostics recorded (gen N+1)
  │
  └─ 3. isCurrentTarget(target) ─────► TRUE only if target.gen === N+1
```

### 2.2 Regression Test Design (`test/integration/theme-qa-reload-lifecycle.test.ts`)
To permanently prevent regression, the new integration test suite constructs a `StatefulLifecycleHost` that accurately enforces these contracts without requiring full Electron runtime binaries:

```typescript
// test/integration/theme-qa-reload-lifecycle.test.ts
class StatefulLifecycleHost implements BrowserHostPort {
  private generation = 1;
  private diagnostics = { console: [] as any[], failures: [] as any[] };
  private domStates: Record<number, string> = {
    1: '<div class="broken">Pre-reload Liquid error: missing snippet</div>',
    2: '<div class="clean">Fresh Theme Content Loaded</div>'
  };

  getDocumentGeneration(tabId?: string): number { return this.generation; }

  isCurrentTarget(target: BrowserTarget): boolean {
    return target.documentGeneration === this.generation;
  }

  async reload(tabId: string): Promise<boolean> {
    // 1. Simulate did-start-navigation (Synchronous generation bump & buffer clear)
    this.generation += 1;
    this.diagnostics.console = [];
    this.diagnostics.failures = [];
    
    // 2. Simulate did-finish-load (Populate fresh diagnostics for gen 2)
    this.diagnostics.console.push({
      message: 'Theme initialized successfully',
      level: 1,
      isFirstParty: true,
      timestamp: Date.now()
    });
    return true;
  }

  async getDom(selector?: string, tabId?: string): Promise<string> {
    return this.domStates[this.generation] || '';
  }

  async evalJs(expression: string, tabId?: string): Promise<unknown> {
    if (expression.includes('LiquidErrorScanner')) {
      return {
        hasErrors: this.generation === 1,
        errors: this.generation === 1 ? [{ type: 'missing_snippet', message: 'missing snippet' }] : [],
        scannedElementsCount: 1
      };
    }
    return null;
  }

  getDiagnostics(tabId?: string) { return this.diagnostics; }
  getTabList() { return [{ id: 'tab-1' }]; }
  async captureScreenshot() { return Buffer.from('fake-png').toString('base64'); }
  navigate() { return true; }
}
```

### 2.3 Four Mandatory Regression Assertions

1. **Stale Target Rejection (The Core Trap)**:
   - If `ThemeQaWorkflow` passes `input.target` (gen 1) to `evalJs` or `dom` post-reload, `BrowserControlPort.assertCurrent()` queries `host.isCurrentTarget(input.target)`, which returns `false` and throws `TARGET_STALE`.
   - The test asserts `validate()` succeeds cleanly and produces a generation 2 report without encountering `TARGET_STALE`.
2. **Artifact Order & Content Freshness**:
   - `report.artifacts` MUST contain the DOM artifact staged from generation 2 (`Fresh Theme Content Loaded`), NOT generation 1.
3. **Diagnostics Buffer Clearance & Refresh**:
   - Pre-reload diagnostics from generation 1 are proven wiped; post-reload diagnostics from generation 2 are captured and reflected in `report.findings.diagnosticIssues`.
4. **Report Target Contract Alignment**:
   - `report.target.documentGeneration` MUST equal `2`, matching the active generation of the browser tab.

---

## 3. Implementation Phases

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Workflow Fix & Evidence Reordering                 │
│ (src/main/qa/theme-qa-workflow.ts)                          │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Real Reload Lifecycle Integration Test Suite       │
│ (test/integration/theme-qa-reload-lifecycle.test.ts)        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3: Control Plane & Runtime Alignment Verification     │
│ (src/main/control-plane/control-plane-runtime.ts)           │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Workflow Fix — Target Propagation & Lifecycle Reordering
- **File Inventory**:
  - `src/main/qa/theme-qa-workflow.ts` (Modify `validate()`, lines 83–353)
- **Implementation Steps**:
  1. **Reorder Execution Sequence**:
     - Step 1: Execute `this.ports.reload(input.target)` at the beginning of `validate()`.
     - Step 2: Validate `reload.reloaded`. Extract `const freshTarget: BrowserTarget = reload.target;` (which holds updated `documentGeneration`).
     - Step 3: Capture post-reload diagnostics via `this.ports.browser.diagnostics(freshTarget.tabId)`.
     - Step 4: Capture fresh post-reload DOM & screenshot evidence: `const evidence = await this.inspect({ ...input, target: freshTarget });`.
     - Step 5: Execute all evaluators (`LiquidErrorScanner`, `LayoutOverflowEngine`, `BrokenAssetScanner`, `HsGateRules`) using `freshTarget`.
     - Step 6: Query tab context via `this.ports.browser.listTabs({ target: freshTarget })`.
     - Step 7: Construct final report with `target: freshTarget`.
  2. **Eliminate Silent `TARGET_STALE` Swallowing**:
     - Ensure scanner catch blocks do not silently fall back to stale pre-reload strings if `TARGET_STALE` is thrown.
  3. **P1-4 Conditional Hardening (`enabledChecks`)**:
     - While touching `theme-qa-workflow.ts`, replace mutable `checklist` overrides (`theme-qa-workflow.ts:277-283`) with an internal `enabledChecks?: ThemeQaChecklistKey[]` filter. The engine retains sole ownership of verdict calculation (`summary.passed`).
- **Success Criteria**:
  - `validate()` operates completely on `freshTarget`.
  - All scanners and artifacts evaluate the post-reload document state.
- **Risks & Signals**:
  - *Risk*: Legacy tests with static mocks failing due to unexpected `documentGeneration` checks.
  - *Signal*: Unit test failures in `test/integration/theme-qa-vertical-slice.test.ts` resolved by aligning mock returns.

### Phase 2: Real Reload Lifecycle Integration Test Suite
- **File Inventory**:
  - `test/integration/theme-qa-reload-lifecycle.test.ts` (Create new test file)
  - `test/integration/theme-qa-vertical-slice.test.ts` (Update existing mock assertions)
- **Implementation Steps**:
  1. Implement `StatefulLifecycleHost` with generation tracking, synchronous buffer clearance on reload, and strict `isCurrentTarget` enforcement.
  2. Author Test Case 1: *Stale-target regression barrier* — verifies that passing generation 1 post-reload triggers `TARGET_STALE`, and verifies the fix propagates generation 2 successfully.
  3. Author Test Case 2: *Evidence freshness and order* — edits theme CSS/Liquid, triggers QA, and asserts DOM/screenshot artifacts reflect post-reload mutations.
  4. Author Test Case 3: *Diagnostics clearance verification* — verifies pre-reload errors do not leak into post-reload reports.
  5. Author Test Case 4: *Reload failure handling* — verifies `reload.reloaded === false` cleanly raises `TARGET_STALE` without executing downstream scanners.
- **Success Criteria**:
  - `node --test .compiled/test/integration/*.test.js` passes 100%.
  - Reverting `freshTarget` back to `input.target` causes immediate, deterministic test failure.
- **Risks & Signals**:
  - *Risk*: Async timing race in simulated reload waiter.
  - *Signal*: Handled deterministically by synchronous state transition inside `MockLifecycleHost.reload()`.

### Phase 3: Control Plane & Runtime Alignment Verification
- **File Inventory**:
  - `src/main/tools/browser-control-port.ts:59-65` (Inspect `reload()`)
  - `src/main/control-plane/control-plane-runtime.ts:98-111` (Inspect `registerBrowser()`)
  - `src/main/index.ts:181-185` (Inspect production wiring)
- **Implementation Steps**:
  1. Verify `BrowserControlPort.reload` accurately computes `target.documentGeneration = host.getDocumentGeneration(tabId)` (line 63).
  2. Verify `ControlPlaneRuntime.registerBrowser` passes `reload: (target) => browser.reload(target)`.
  3. Confirm `NativeTabHost.reloadAndWait` (`src/main/browser/native-tab-host.ts:2502-2518`) resolves properly on `did-start-navigation` in production.
- **Success Criteria**:
  - End-to-end typecheck (`npm run typecheck`) passes without errors.
  - Production wiring passes fresh targets from `tabHost` -> `browserControlPort` -> `themeQaWorkflow`.

---

## 4. Observable Acceptance Criteria

1. **AC-1 (Target Propagation)**: `ThemeQaWorkflow.validate()` executes all post-reload browser actions (`dom`, `screenshot`, `eval`, `diagnostics`, `listTabs`) using `reload.target` carrying the incremented `documentGeneration`.
2. **AC-2 (Zero Stale-Target Scanner Fallbacks)**: Under host target validation (`isCurrentTarget`), no scanner catches a `TARGET_STALE` error during a standard validation run.
3. **AC-3 (Artifact Freshness Guarantee)**: The DOM artifact stored in `report.artifacts` contains the exact HTML rendered after reload, verified by content assertions.
4. **AC-4 (Diagnostics Lifecycle Correctness)**: Errors emitted prior to reload are wiped by navigation clear; only errors occurring during or after reload appear in `report.findings.diagnosticIssues`.
5. **AC-5 (Deterministic Test Defense)**: `test/integration/theme-qa-reload-lifecycle.test.ts` passes and fails deterministically when `freshTarget` propagation is disabled.
6. **AC-6 (Engine-Owned Checklist Verdict)**: `summary.passed` is computed solely by the internal evaluation engine; optional `enabledChecks` allows disabling categories without external boolean tampering.

---

## 5. Deferred Items & Promotion Triggers

| Deferred Item | Classification | Rationale | Promotion Trigger |
| :--- | :--- | :--- | :--- |
| **Full-Chain Test A** | Release Gate | Requires multi-process coordination (CLI $\to$ MCP $\to$ Electron $\to$ QA); Tests B, C, D already pass | Automated headless Electron test runner integrated into project test script |
| **Continuous Integration (CI)** | Release Gate | No existing repository CI configuration (`.github/`, `.gitlab-ci.yml`); needs hosting decision | User/team selection of CI provider and OS runner matrix |
| **P1-3 `openTab` Retargeting** | Non-blocking | `antifan_open_tab` alias contract depends on automation tab retargeting (`browser-control-port.ts:85-92`) | Deprecation and migration of legacy alias consumers |
| **Unanchored Surfaces Audit** | Code Hygiene | `antifan-omp-mcp.cjs`, `antifan_eval_js`, artifact bundle cleanup are audit/packaging tasks | Dedicated repository maintenance / security audit milestone |

---

## 6. Risks, Signal Monitoring, and Rollback

- **Risk 1: Navigation Timeout on Unresponsive Storefronts**:
  - *Manifestation*: `NativeTabHost.reloadAndWait` exceeds 3000ms waiter timeout on slow network.
  - *Monitoring Signal*: `validate()` rejects with `CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded')`.
  - *Mitigation*: Surface actionable error to the client indicating navigation timeout rather than masking as QA pass.
- **Risk 2: Multi-pane Split-mode Generation Desynchronization**:
  - *Manifestation*: Reloading a tab with desktop and mobile views could bump generations unevenly if authority pane is misidentified.
  - *Monitoring Signal*: `native-tab-host.ts:1728` checks `authorityPane === paneId`.
  - *Mitigation*: Rely on `NativeTabHost.reloadAndWait` authority pane resolution (`native-tab-host.ts:2505-2508`).

---

## 7. Open Questions & Assumptions

- **Assumption 1**: `did-start-navigation` remains the authoritative event for generation increment and diagnostics buffer clearance in `NativeTabHost` (`native-tab-host.ts:1725-1743`).
- **Assumption 2**: P1-4 is applied as internal hardening (`enabledChecks`) without modifying the public MCP tool schema in `src/main/tools/browser-capabilities.ts`.
- **Assumption 3**: No secrets, tokens, or environment values are required or exposed.

---
*Report generated by ultra-plan Candidate 3 for plan `260828-1033-qa-fresh-target-reliability`.*
