---
phase: 5
title: "E2E Slice & Architecture Gate"
status: completed
priority: P1
effort: "6h"
dependencies: ["phase-01-start.md", "phase-02-context-and-proving-harness.md", "phase-03-theme-evidence-capabilities.md", "phase-04-verification-and-policy-integration.md"]
---

# Phase 5: E2E Slice & Architecture Gate

## Overview
Execute the complete end-to-end Theme Intelligence workflow against the isolated **Product Card Proving Harness** (`test/fixtures/golden-workflow/product-card/`) and certify the implementation against the **5 Architecture Gate Criteria**. Passing this gate formally completes P0 and establishes the authoritative baseline before any broader P1 initiatives (Header Mega Menu, Settings Schema, Performance CWV) are scheduled.

## Requirements
- **Functional Requirements:**
  - Execute automated end-to-end golden verification script (`test/golden-slice-e2e.test.ts`):
    1. **Context Initialization:** Initialize `ThemeTaskContext` with `taskId`, local fixture URL, and fixture workspace path.
    2. **Element Inspection:** Query card element via `anti.inspect.styles` and `anti.inspect.matched_styles`.
    3. **Source Mapping:** Resolve element via `anti.theme.resolve_element` and verify it identifies `snippets/card-product.liquid` with `HIGH` confidence.
    4. **Simulated Mutation:** Simulate fixing a card layout regression in fixture workspace.
    5. **Responsive Matrix Verification:** Execute `anti.inspect.responsive_matrix` across all 5 breakpoints ($320, 375, 768, 1024, 1440$) and verify zero horizontal overflow.
    6. **Authoritative Verdict:** Submit claim to `VerificationEvaluator` via `anti.verification.verify_claim` and verify receipt issuance with verdict `VERIFIED`.
  - Perform **5 Architecture Gate Evaluations**:
    1. *Source Mapping Accuracy:* Candidate Liquid file identified with $\ge 2$ independent signals before editing.
    2. *CSS Causality:* Matched CSS rules achieve at least `PASS` DoD (selector + declaration + `styleSheetId`).
    3. *Responsive Matrix:* 5 standard breakpoints evaluated with explicit disambiguation between `documentOverflowX` and `targetOverflowX`.
    4. *Verification Receipt:* Live verification receipt stored in `ReceiptStore` with zero synthetic or mock claims.
    5. *Tool Cost Invariance:* Fixed, deterministic tool call count with zero unbounded workspace grep operations.
- **Non-Functional Requirements:**
  - **Core Purity Audit:** Automated static check confirming zero occurrences of Product Card selectors (`.product-card`, `.card__price`, etc.) inside `src/main/`.
  - **Architecture Invariants Verification:** Confirm no external agent frameworks (Swarm, AutoGen) or second browser runtimes (Playwright MCP) were introduced.

## Architecture
```text
Golden Slice Runner (test/golden-slice-e2e.test.ts)
                    v
[P0.1 Context]  ThemeTaskContext(Product Card Fixture)
                    v
[P0.4 CSS]      anti.inspect.matched_styles -> Active/Overridden Rules
                    v
[P0.3 Source]   anti.theme.resolve_element -> snippets/card-product.liquid (HIGH)
                    v
[Mutation]      Theme Workspace Update
                    v
[P0.5 Matrix]   anti.inspect.responsive_matrix -> 5 Breakpoints Clean
                    v
[P0.6 Verdict]  VerificationEvaluator -> VERIFIED + Receipt
                    v
        5 Architecture Gate Criteria Audit (PASS)
```

## Related Code Files
- Create: `test/golden-slice-e2e.test.ts` (complete end-to-end integration test)
- Create: `scripts/audit-core-purity.ts` (verifies zero fixture or product bleed in `src/main/`)
- Test: `test/fixtures/golden-workflow/product-card/` (proving fixture)

## Implementation Steps
1. **Develop Golden Slice Integration Test:**
   - Wire together all capabilities implemented in Phases 1–4 into a cohesive test script.
   - Serve the static storefront fixture using a local test server.
   - Run the sequence: inspect $\to$ resolve source $\to$ mutate $\to$ responsive check $\to$ verify claim.
2. **Execute Architecture Gate Criteria Checks:**
   - Check Criterion 1: Verify `resolve_element` returned candidate `snippets/card-product.liquid` with confidence `HIGH`.
   - Check Criterion 2: Verify `matched_styles` identified `.product-card` as active and `.card` as overridden.
   - Check Criterion 3: Verify `responsive_matrix` checked 320, 375, 768, 1024, and 1440px with distinct overflow booleans.
   - Check Criterion 4: Verify receipt was written to `ReceiptStore` and evaluator returned `VERIFIED`.
   - Check Criterion 5: Verify total capability calls $\le 6$ round-trips.
3. **Run Core Purity Audit:**
   - Execute `audit-core-purity.ts` scanning `src/main/` for fixture class names. Ensure zero matches.
4. **Issue Formal P0 Completion Certification:**
   - Generate summary report confirming readiness to unlock P1 scope.

## Success Criteria
- [x] `test/golden-slice-e2e.test.ts` passes with $100\%$ green assertions.
- [x] All 5 Architecture Gate criteria are satisfied and documented.
- [x] `audit-core-purity.ts` exits with code 0 (zero fixture bleed into Core).
- [x] OMP theme engineering control plane contract is fully verified.

## Risk Assessment
- *Risk:* Flakiness during multi-viewport emulation in headless CI environments.
  *Mitigation:* Use explicit lifecycle wait loops for emulation transition before reading geometry in responsive checks.
