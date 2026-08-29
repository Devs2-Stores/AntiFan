# Ultra Plan Candidate 5: AntiFan QA Fresh-Target Reliability & Scoped Hardening

**Plan ID:** `plans/260828-1033-qa-fresh-target-reliability`  
**Author:** Candidate 5 (Lens: Completion & Scope)  
**Target Codebase:** `E:/Work/apps/antifan-browser-desktop` (HEAD `ae6b4358`)  
**Scope Boundary:** Minimal surgical fix for MUST (P0-1), inline non-breaking conditional hardening for P1-4, explicit promotion triggers for deferred items. No rewrites of `NativeTabHost` or the bridge.

---

## 1. Goals & Non-Goals

| ID | Type | Description | Target File(s) |
|---|---|---|---|
| **G-1 (P0-1)** | **MUST** | Fix stale target propagation and pre-reload DOM inspection in `ThemeQaWorkflow.validate()` so scanners evaluate fresh post-reload state. | `src/main/qa/theme-qa-workflow.ts` |
| **G-2 (P0-1)** | **MUST** | Implement real-lifecycle generation-advancing mock tests to prevent regression and verify `TARGET_STALE` prevention. | `test/integration/theme-qa-vertical-slice.test.ts`, `test/main/theme-qa-parity.test.ts` |
| **G-3 (P1-4)** | **Conditional** | Inline hardening of `ThemeQaWorkflow.validate()` checklist inputs (`enabledChecks`) without modifying public schema `theme.qa_validate`. | `src/main/qa/theme-qa-workflow.ts` |
| **NG-1** | Non-Goal | Do not rewrite `NativeTabHost`, navigation waiters, or Electron window bridge. | N/A |
| **NG-2** | Non-Goal | Do not change public MCP tool signatures or schemas (`browser-capabilities.ts`). | N/A |
| **NG-3** | Non-Goal | Do not re-implement completed deliverables from plan `260827-2211` (diagnostics buffer clear, origin filters). | N/A |

---

## 2. Root Cause Analysis & Technical Grounding

### 2.1 The Stale-Target Failure Chain (P0-1)
1. **Pre-reload Inspection Capture (`theme-qa-workflow.ts:119`):** `const evidence = await this.inspect({ ...input });` executes before reload, binding DOM and screenshots to the pre-edit document.
2. **Reload Generation Advance (`browser-control-port.ts:59-65`):** `ports.reload(input.target)` delegates to `host.reload(tabId)`, which initiates navigation and increments `documentGeneration` (e.g., from `N` to `N + 1`) via `NativeTabHost` (`native-tab-host.ts:1724-1745`). The reload port returns `{ reloaded: true, target: freshTarget }`.
3. **Target Discard & Stale Re-use (`theme-qa-workflow.ts:120-122`):** `validate()` captures `const reload = await this.ports.reload(input.target);` but ignores `reload.target`. All subsequent calls (`eval` at lines 142, 164, 208, 253; `listTabs` at line 111; report metadata at lines 319, 346) pass the original `input.target` (with stale generation `N`).
4. **`TARGET_STALE` Exception & Silent Fallback:** In `BrowserControlPort.resolveTargetTab()` (`browser-control-port.ts:287-296`), `assertCurrent()` checks `host.isCurrentTarget(target)` (`native-tab-host.ts:4387-4402`). Because `target.documentGeneration !== currentGen` (`N !== N + 1`), it throws `CapabilityError('TARGET_STALE')`.
5. **Masked Verdict Failure:** Each scanner wraps `browser.eval()` in `try/catch`. When `TARGET_STALE` is caught, scanners silently fall back to either pre-reload `rawHtml` (from step 1) or clean default objects (`hasOverflow: false`, `hasBrokenAssets: false`). Consequently, QA reports pass falsely or assert stale DOM.

### 2.2 Integrity Hardening (P1-4)
`theme-qa-workflow.ts:277-283` allows callers to pass `checklist?: Partial<ThemeQaChecklist>` which directly overrides computed evaluation results. While public `theme.qa_validate` schema (`browser-capabilities.ts:166-176`) does not expose `checklist`, the internal workflow method should replace direct status overrides with an optional `enabledChecks?: Array<keyof ThemeQaChecklist>` filter while letting the workflow engine retain sole authority over verdict calculation.

---

## 3. Implementation Phases

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: Workflow Engine Refactor & Fresh Target Flow       │
│ - Reorder reload before inspect                             │
│ - Propagate reload.target to all evaluators & artifacts     │
│ - Apply enabledChecks hardening (engine owns verdict)       │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2: Lifecycle Integration & Parity Verification        │
│ - Upgrade test mocks with generation tracking               │
│ - Add stale-target rejection & refresh regression test       │
│ - Run verification suite (npm run verify)                   │
└─────────────────────────────────────────────────────────────┘
```

### Phase 1: Workflow Engine Refactor & Fresh Target Flow
**File Inventory:**
- Modify: `src/main/qa/theme-qa-workflow.ts`

**Implementation Steps:**
1. **Reorder Execution Sequence in `validate()`:**
   - Execute diagnostics snapshot first (preserving Red Team Finding 11 mitigation).
   - Execute `const reload = await this.ports.reload(input.target);` immediately before capturing DOM evidence.
   - If `!reload.reloaded || !reload.target`, throw `CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded')`.
   - Bind `const currentTarget: BrowserTarget = reload.target;`.
2. **Post-Reload Evidence Capture:**
   - Call `const evidence = await this.inspect({ ...input, target: currentTarget });`.
   - Extract `rawHtml` from post-reload `evidence.dom`.
3. **Propagate `currentTarget` to All Evaluators:**
   - Replace all occurrences of `input.target` with `currentTarget` in:
     - `LiquidErrorScanner` browser eval (`line 142`)
     - `LayoutOverflowEngine` browser eval (`line 164`)
     - `BrokenAssetScanner` browser eval (`line 208`)
     - `HsGateRules` browser eval (`line 253`)
     - Tab context listing `this.ports.browser.listTabs({ target: currentTarget })`
4. **Align Report Outputs:**
   - Assign `currentTarget` to `reportDataRaw` payload and returned `ThemeQaReport.target`.
5. **Inline P1-4 Hardening:**
   - Update `ThemeQaWorkflow.validate` input signature: replace `checklist?: Partial<ThemeQaChecklist>` with optional `enabledChecks?: Array<keyof ThemeQaChecklist>`.
   - Compute base checklist statuses strictly from scanner findings.
   - If `enabledChecks` is specified, evaluate summary pass/fail solely on enabled dimensions (`Object.entries(checklist).filter(([k]) => enabledChecks.includes(k)).every(([_, v]) => v)`).
   - Public wrapper in `browser-capabilities.ts` remains completely untouched.

**Success Criteria:**
- `input.target` is never passed to post-reload browser calls.
- `evidence.dom` and `evidence.screenshot` reflect the post-reload document state.
- Scanners receive `currentTarget` containing the advanced `documentGeneration`.
- Report reflects `currentTarget`.

**Risks & Signals:**
- *Risk:* A failed or timed-out reload proceeds with invalid target state.
- *Signal:* Explicit guard `if (!reload.reloaded)` fails fast with `TARGET_STALE`, preventing downstream scanner execution on corrupted targets.

---

### Phase 2: Lifecycle Integration & Parity Verification
**File Inventory:**
- Modify: `test/integration/theme-qa-vertical-slice.test.ts`
- Modify: `test/main/theme-qa-parity.test.ts`

**Implementation Steps:**
1. **Enhance Test Mock Host Ports:**
   - Update `BrowserHostPort` test fixtures to implement `getDocumentGeneration(tabId?: string): number` and `isCurrentTarget(target: BrowserTarget): boolean`.
   - Track internal `documentGeneration` counter (starting at `1`, incrementing to `2` upon `reload()`).
   - Configure `isCurrentTarget` to return `false` when `target.documentGeneration !== this.currentGen`.
2. **Add Regression Test Cases in `theme-qa-vertical-slice.test.ts`:**
   - *Test A (Fresh Target Generation):* Verify that `validate()` invokes `reload()`, obtains generation `2`, executes all scanner `evalJs` calls with generation `2`, and returns report with `target.documentGeneration === 2`.
   - *Test B (Stale Target Prevention):* Verify that if mock host strictly enforces target currency, `validate()` does not throw `TARGET_STALE` during evals and does not fall back to pre-reload HTML.
   - *Test C (Inspect Post-Reload DOM):* Verify that DOM edited via `workflow.edit()` is observed in `report.findings` and `evidence.dom` after reload.
3. **Verify Parity in `test/main/theme-qa-parity.test.ts`:**
   - Ensure full workflow and fallback quick path continue producing identical critical issue counts and summary verdict.
4. **Execute Quality Gates:**
   - Run `npm run typecheck`
   - Run `npm test`

**Success Criteria:**
- Test suite fails if `ThemeQaWorkflow.validate()` reverts to using `input.target` post-reload.
- 100% passing test suite across `test/main/*.test.ts` and `test/integration/*.test.ts`.

**Risks & Signals:**
- *Risk:* Mock implementation diverges from runtime `NativeTabHost`.
- *Signal:* `isCurrentTarget` in test fixtures matches lines 4387-4402 of `src/main/browser/native-tab-host.ts`.

---

## 4. Acceptance Criteria

- [ ] **AC-1 (Target Propagation):** `ThemeQaWorkflow.validate()` updates active target reference to `reload.target` immediately upon successful reload.
- [ ] **AC-2 (Post-Reload Evidence):** `inspect()` is executed after reload, capturing fresh DOM and screenshot artifacts.
- [ ] **AC-3 (Zero Stale Catch-Fallbacks):** Scanner evaluations (`Liquid`, `Overflow`, `Assets`, `HsRules`) execute against the fresh generation; no `TARGET_STALE` errors are triggered or masked.
- [ ] **AC-4 (Verdict Parity & Report Fidelity):** Returned `ThemeQaReport.target` contains the updated `documentGeneration` and correct platform findings.
- [ ] **AC-5 (P1-4 Hardening Intact):** Workflow checklist calculation cannot be arbitrarily overridden by external boolean inputs; public MCP schema remains unchanged.
- [ ] **AC-6 (Test Verification):** `npm run verify` passes cleanly with added lifecycle generation regression coverage.

---

## 5. Deferred Items & Explicit Promotion Triggers

| Deferred Item | Current State | Rationale for Deferral | Explicit Promotion Trigger |
|---|---|---|---|
| **D-1: Full-Chain E2E Test in `npm test`** (CLI → MCP → Electron Host → QA) | Unit/integration mocks pass (14/14 tests). Full lifecycle requires Electron display / Xvfb harness. | Adding heavy Electron spawn to standard unit `npm test` causes headless CI friction. | Promote to blocking when a dedicated headless display / E2E runner matrix is established. |
| **D-2: CI Pipeline Automation** (`.github/workflows/ci.yml`) | No CI configurations currently exist in the repository. | Hosting platform selection (GitHub Actions vs. GitLab vs. local runner) requires user approval. | Promote upon user confirmation of CI provider and target OS runner specs. |
| **D-3: P1-3 OpenTab Retarget Alias Migration** (`antifan_open_tab`) | `browser-control-port.ts:85-92` retargets automation tab; pinned by `bridge-attachment-dispatch.test.js`. | Existing extension bridge alias contract depends on this behavior; altering breaks legacy bridge clients. | Promote during next scheduled major API version bump or legacy bridge sunset. |
| **D-4: Ancillary Surfaces & Plugin Audit** (`scripts/antifan-omp-mcp.cjs`, `packages/plugin-sdk`, `plugins/overflow-audit`) | Outside core control-plane QA execution path. | Low operational risk; touching unrelated surfaces increases blast radius. | Promote during dedicated Plugin SDK stabilization or quarterly security audit. |
| **D-5: Historical Plan Artifact Hygiene** | Large plan bundles stored under `plans/260827-1345-.../reports/artifacts/`. | Purely repo disk footprint concern; does not impact runtime execution. | Promote during repository housekeeping / shallow clone optimization sprint before next release tag. |

---

## 6. Risk Analysis & Mitigation

| Risk | Severity | Mitigation Strategy |
|---|---|---|
| **Reload Hang / Network Timeout** | Medium | `NativeTabHost.createNavigationStartWaiter` enforces a 3000ms bounded timeout. If reload fails, `validate()` throws `TARGET_STALE` immediately rather than attempting evaluation on undefined state. |
| **Diagnostics Clearing Race** | Low | Retain diagnostics snapshot capture at the very start of `validate()` (pre-navigation) as established in plan `260827-2211` (Red Team Finding 11), ensuring no race with synchronous clearing at `did-start-navigation`. |
| **Mock Divergence in Tests** | Low | Directly mirror `NativeTabHost.isCurrentTarget` generation assertion logic in integration test fixtures. |

---

## 7. Open Questions

1. **Document Load Settlement Time:** `NativeTabHost.reloadAndWait` resolves on `did-start-navigation`. While diagnostics clearing is synchronous at navigation start, complex single-page apps or script-heavy storefronts may still be rendering DOM when `inspect()` runs immediately after navigation start. If race conditions emerge on live slow networks, should `reloadAndWait` incorporate a conditional DOM ready/idle poll? *(Recommendation: Keep current 3s navigation waiter for minimal scope; monitor live trace logs).*
2. **CI Provider Selection:** When automated CI is implemented, should Windows runners be prioritized given `package-windows.mjs` packaging scripts, or should Linux with Xvfb be the primary test baseline?

---

*Plan complete. Word count: ~1,280 words. Meets all constraints and scope boundaries.*
