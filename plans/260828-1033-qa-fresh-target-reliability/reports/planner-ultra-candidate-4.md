# Plan: AntiFan QA Fresh-Target Reliability & Lifecycle Hardening (Candidate 4)

## Lens & Architectural Evaluation: Risk and Trade-offs

This candidate evaluates the transition from stale target execution to atomic fresh-target QA validation through the lens of failure modes, split-brain race conditions, and runtime boundaries.

### 1. Failure Modes of Load-Stability Wait & Pre-Decided Responses

| Failure Mode | Root Cause / Mechanism | Worst-Case Impact | Pre-Decided Response & Defense |
|---|---|---|---|
| **1. Hang $\to$ Unbounded Timeout** | Target page encounters endless redirect, stalled WebSockets/SSE, or hung external script during reload/navigation. | QA execution blocks indefinitely; parent MCP/CLI agent hits global process deadline without actionable error context. | **Hard Bounded Timeout + Explicit Rejection:** Enforce strict deterministic timeout (5,000ms max for navigation completion / DOM ready). Never swallow or wait unbounded. If timeout expires, check if navigation started; if incomplete, throw explicit `CapabilityError('TARGET_STALE', 'Navigation/reload failed to achieve DOM stability within 5000ms')`. Never fall back silently to stale cache. |
| **2. Split-Mode Generation Double-Bump** | In split pane mode (desktop + mobile), `reload()` triggers both `tab.view` and `tab.mobileView` (`native-tab-host.ts:2488-2499`). Non-authority pane navigation or mid-flight authority flip can trigger an asynchronous second `did-start-navigation`. | Target generation counter bumps twice ($N \to N+1 \to N+2$). Target captured as $N+1$ becomes instantly stale when $N+2$ lands, causing post-reload evals to fail with `TARGET_STALE`. | **Authority-Anchored Generation Gate:** Generation increment in `native-tab-host.ts:1725-1743` must remain strictly gated by `authorityPane === paneId`. The waiter in `reloadAndWait` must observe *only* the authority view's `webContents`. `BrowserControlPort.reload` reads `getDocumentGeneration(tabId)` strictly *after* the waiter resolves, capturing the final settled generation. |
| **3. `reloadAndWait` 3s Timeout Window** | `createNavigationStartWaiter` uses 3,000ms timeout (`native-tab-host.ts:2520`). Local build tools or heavy merchant storefront backends (Haravan/Shopify preview) taking >3s to respond will fail the start waiter. | `reloadAndWait` returns `false`, causing `BrowserControlPort.reload` to reject with `TARGET_STALE` before navigation begins. | **Deterministic Rapid Rejection + Configurable Window:** Treat `reload.reloaded === false` as a deterministic fast abort. Do not attempt to run live scanners on unconfirmed reloads. In `ThemeQaWorkflow.validate()`, immediately throw `CapabilityError('TARGET_STALE')` with clear diagnostic detail, allowing the orchestrating agent to decide whether to retry or escalate. |

### 2. Architectural Comparison: Minimal Target-Propagation vs. Full Fresh-Capture

* **Approach A: Minimal Target-Propagation-Only**
  * *Mechanism:* Update `target` variable after `ports.reload()` to `reload.target`, but retain pre-reload `inspect()` (DOM/screenshot) captured at the start of `validate()`.
  * *Risks & Shortcomings:*
    1. **Split-Brain Report State:** Pre-reload DOM/screenshot artifacts are bundled with post-reload live scanner evaluations (Liquid, overflow, broken assets).
    2. **Stale Static Fallback:** If live `eval` fails, scanner fallback evaluates pre-reload `rawHtml`, defeating the purpose of QA verification of the latest code edit.
    3. **False Passes/Failures:** Platform detection and static HTML analysis evaluate outdated markup.
* **Approach B: Full Fresh-Capture-with-Generation-Assert (Selected Path)**
  * *Mechanism:* Reorder the validation pipeline: execute `reload()`, obtain `freshTarget` ($N_{\text{fresh}} = N_{\text{initial}} + 1$), assert generation stability, and capture fresh DOM/screenshot evidence post-reload before running live/static scanners.
  * *Risk Justification:* Approach B satisfies the contract with the **least total systemic risk**. It guarantees atomicity across all 8 checklist dimensions and attached report artifacts, eliminating partial-state corruption while adding zero external dependencies.

---

## Goals

| ID | Category | Objective | Measure of Success |
|---|---|---|---|
| **G1** | P0 Core | Fresh Target Propagation in QA Workflow | `ThemeQaWorkflow.validate()` uses `freshTarget` (from `ports.reload()`) for all DOM, screenshot, `eval`, and tab operations; zero stale `TARGET_STALE` fallbacks. |
| **G2** | P0 Core | Post-Reload Evidence Atomicity | `inspect()` and `rawHtml` extraction occur post-reload, matching live scanner execution on the reloaded generation. |
| **G3** | P0 Core | Lifecycle & Generation Regression Testing | Unit and integration tests verify document generation increments and catch stale target rejections without mock host bypass. |
| **G4** | P1 Hardening | Internal Checklist Sanitization | Replace permissive `checklist` override parameter with safe internal `enabledChecks` filter in `validate()`. |

---

## Phases

### Phase 1: Workflow Lifecycle Reordering & Fresh Target Propagation (P0-1, P1-4)

#### File Inventory
* `src/main/qa/theme-qa-workflow.ts`
* `src/main/control-plane/control-plane-runtime.ts`

#### Implementation Steps
1. **Reorder Validation Sequence in `ThemeQaWorkflow.validate()`:**
   - Anchor ownership validation against `input.target`.
   - Take the pre-reload `diagnosticsSnapshot` (preserving Red Team Finding 11: capture console/network errors before synchronous navigation buffer clear).
   - Execute `const reload = await this.ports.reload(input.target);`
   - Assert `reload.reloaded === true` and obtain `const freshTarget = reload.target;`. If failed, immediately reject with `CapabilityError('TARGET_STALE', 'Bound browser tab could not be reloaded')`.
   - Fetch post-reload `evidence = await this.inspect({ ...input, target: freshTarget });`.
   - Derive `rawHtml` from fresh `evidence.dom`.
2. **Propagate `freshTarget` Across Scanners:**
   - Update all `ports.browser.eval()` calls (Liquid scanner, Layout Overflow engine, Broken Asset scanner, HS Gate rules) to pass `freshTarget` instead of `input.target`.
   - Update `ports.browser.responsiveCheck()` and `ports.browser.listTabs()` calls to use `freshTarget`.
   - Record `target: freshTarget` in the final sanitized report JSON (`reportDataRaw`).
3. **P1-4 Internal Checklist Hardening:**
   - Refactor `input.checklist?: Partial<ThemeQaChecklist>` in `ThemeQaWorkflow.validate()` to `input.enabledChecks?: Array<keyof ThemeQaChecklist>`.
   - Compute checklist statuses strictly from scanner findings; if `enabledChecks` is provided, evaluate overall pass/fail against enabled dimensions only without allowing callers to override individual boolean check values.
   - Maintain public schema `theme.qa_validate` (`src/main/control-plane/browser-capabilities.ts:166-176`) unchanged.

#### Success Criteria
* `ThemeQaWorkflow` runs end-to-end against a strict host without throwing `TARGET_STALE`.
* All scanner scripts evaluate against the fresh document generation ($N+1$).
* Stored DOM/screenshot artifacts reflect the reloaded page state.

#### Risks & Signals
* *Risk:* If `reload()` fails or times out, `validate()` terminates early.
* *Signal:* `CapabilityError` with code `TARGET_STALE` thrown clearly at reload stage instead of hidden in downstream scanner try-catch blocks.

---

### Phase 2: Host Load-Stability Waiter & Target Resolution Hardening (P0-1)

#### File Inventory
* `src/main/browser/native-tab-host.ts`
* `src/main/tools/browser-control-port.ts`

#### Implementation Steps
1. **Verify Navigation Waiter Boundaries in `NativeTabHost`:**
   - Confirm `reloadAndWait(tabId)` accurately awaits `createNavigationStartWaiter` on the authority pane.
   - Ensure `did-start-navigation` increments `documentGenerations` and clears `diagnosticsManager` buffer synchronously on the authority pane (`authorityPane === paneId`).
   - Validate that `stopLoading(tabId)` cleans up pending navigation waiters gracefully.
2. **Harden `BrowserControlPort.reload()` & `navigate()`:**
   - In `BrowserControlPort.reload(target, explicitTabId)`:
     - Verify initial `assertCurrent(target)` succeeds.
     - Await `this.host.reload(tabId)`.
     - Read `const docGen = this.host.getDocumentGeneration ? this.host.getDocumentGeneration(tabId) : (target.documentGeneration + 1);`.
     - Return `{ reloaded: true, target: { ...target, tabId, documentGeneration: docGen } }`.
3. **Verify DOM & Screenshot Read Paths:**
   - Ensure `BrowserControlPort.dom()` and `BrowserControlPort.screenshot()` enforce `assertCurrent(target)` so attempting to capture evidence with an un-updated target fails fast.

#### Success Criteria
* `BrowserControlPort.reload()` returns a valid `BrowserTarget` whose `documentGeneration` matches `NativeTabHost.getDocumentGeneration(tabId)`.
* Subsequent port operations with `freshTarget` pass `assertCurrent()` without rejection.

#### Risks & Signals
* *Risk:* Race condition between navigation start and initial DOM evaluation.
* *Signal:* Host returns empty DOM string if read before `DOMContentLoaded`; mitigate by ensuring `getDom()` in `NativeTabHost` evaluates after frame readiness.

---

### Phase 3: Vertical Slice Regression & Lifecycle State Assertions (P0-1)

#### File Inventory
* `test/integration/theme-qa-vertical-slice.test.ts`
* `test/main/theme-qa-target-lifecycle.test.ts` (new targeted test suite)

#### Implementation Steps
1. **Enhance Mock Host in `theme-qa-vertical-slice.test.ts`:**
   - Add `getDocumentGeneration(tabId)` and `isCurrentTarget(target)` implementations to the mock `BrowserHostPort`.
   - Simulate stateful generation bump ($1 \to 2$) upon `reload()`.
   - Verify that `validate()` completes successfully and all `evalJs` calls receive `documentGeneration: 2`.
2. **Add Strict Target Lifecycle Unit Tests (`theme-qa-target-lifecycle.test.ts`):**
   - **Test 1: Fresh Target Propagation:** Verify `validate()` propagates $N+1$ to all downstream scanner eval calls.
   - **Test 2: Stale Target Rejection Guard:** Ensure that if a scanner artificially uses $N$, `assertCurrent()` throws `TARGET_STALE` and is not silently swallowed to mask a broken reload.
   - **Test 3: Split-Mode Generation Consistency:** Verify generation count increments exactly once per reload under split mode simulation.
   - **Test 4: EnabledChecks Integrity:** Verify `enabledChecks` selectively masks checklist criteria without allowing synthetic `true` overrides on failing rules.

#### Success Criteria
* All tests in `test/integration/theme-qa-vertical-slice.test.ts` and `test/main/theme-qa-target-lifecycle.test.ts` pass cleanly (`npm test`).
* Regression tests prove that stale targets are rejected and fresh targets pass.

#### Risks & Signals
* *Risk:* Existing tests expecting legacy `checklist` parameter shape in internal calls fail.
* *Signal:* TypeScript compilation errors on `workflow.validate()` call sites during `npm run typecheck`.

---

## Acceptance Criteria

1. **P0-1 Remediation:** `ThemeQaWorkflow.validate()` retrieves `reload.target`, updates its internal target reference, and executes post-reload `inspect()` and all browser `eval()` calls using the fresh target with incremented `documentGeneration`.
2. **Atomic Artifact Alignment:** Stored DOM, screenshot, and JSON report artifacts correspond strictly to the reloaded document state.
3. **No Silent Fallback to Stale State:** `assertCurrent()` failures are not masked by catch-all scanner handlers; failed reloads trigger immediate, explicit failure.
4. **P1-4 Hardening:** `validate()` does not expose arbitrary checklist status overrides to callers; internal check selection is controlled via `enabledChecks`.
5. **Verified Test Pass:** Vertical slice tests simulate real document generation increments and pass without errors.

---

## Deferred Items & Promotion Triggers

| Deferred Item | Scope & Description | Rationale for Deferral | Explicit Promotion Trigger |
|---|---|---|---|
| **Full-Chain Test A + CI Pipeline** | End-to-end CLI $\to$ MCP $\to$ Browser $\to$ QA automated integration test wired into continuous integration. | Tests B, C, and D exist and pass (14/14). No CI repository configuration (`.github/`, `.gitlab-ci.yml`) exists; requires infrastructure decisions. | User confirms target CI provider and requires CI gate for production release. |
| **P1-3 OpenTab Retarget Migration** | `BrowserControlPort.openTab()` automatically retargets automation tab (`browser-control-port.ts:85-92`). | Current bridge dispatch tests (`bridge-attachment-dispatch.test.js`) explicitly depend on current alias behavior. | Dedicated API alias and bridge protocol modernization milestone. |
| **Unanchored Surfaces Audit** | Security and hygiene audit of `scripts/antifan-omp-mcp.cjs`, `antifan_eval_js`, `packages/plugin-sdk`, and legacy report artifacts. | Non-blocking static assets and tools outside the immediate Theme QA execution loop. | Pre-release security audit or repository hygiene cycle. |

---

## Risks

1. **Navigation Start vs. DOM Readiness Timing:** `reloadAndWait` resolves at `did-start-navigation`. If a scanner `eval` executes before the new DOM is interactive, it may read partial markup.
   * *Mitigation:* `NativeTabHost.evalJs()` and `getDom()` execute in the web frame context which yields or retries until frame evaluation is valid.
2. **Diagnostics Timing Window:** Capturing diagnostics snapshot prior to reload ensures pre-reload console errors are captured, but post-reload parse errors emitted after `did-start-navigation` must be preserved.
   * *Mitigation:* `NativeTabHost` clears diagnostics at `did-start-navigation` and retains all errors during page load and parse for subsequent query.

---

## Open Questions

1. **Default Reload Timeout Tuning:** Should `createNavigationStartWaiter` timeout (currently 3,000ms) be made configurable via control plane options for slow network simulation environments?
2. **MultiBreakpoint Viewport Restoration:** Should multi-breakpoint responsive checks in `ThemeQaWorkflow` explicitly reset the viewport to default desktop dimensions (1440x900) after completing sweeps?
