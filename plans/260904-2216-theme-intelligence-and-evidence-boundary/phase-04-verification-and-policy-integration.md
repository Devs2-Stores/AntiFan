---
phase: 4
title: "Verification Integration & Policy Ordering"
status: completed
priority: P1
effort: "6h"
dependencies: ["phase-01-start.md", "phase-02-context-and-proving-harness.md", "phase-03-theme-evidence-capabilities.md"]
---

# Phase 4: Verification Integration & Policy Ordering

## Overview
Bridge the new Theme Intelligence capabilities with AntiFan's authoritative verification engine and establish clear capability ordering for OMP:
1. Integrate Theme Evidence into the existing `VerificationEvaluator` (`src/main/verification/verification-evaluator.ts`) by modeling theme requirements as standard `ProofObligation` items with fail-closed mechanics.
2. Establish the **Preferred Capability Ordering** policy in the OMP Theme Skill configuration to enforce atomic inspection over raw script execution.

## Requirements
- **Functional Requirements:**
  1. **Verification Integration (Fail-Closed):**
     - Map theme inspection results into `VerificationClaim` and `ProofObligation` objects in `src/main/verification/verification-contract.ts`.
     - Model essential assertions as `critical: true`:
       - `theme.source_mapping.file_identified` (critical)
       - `theme.responsive.no_target_overflow` (critical)
       - `theme.css.active_rule_matched` (critical)
     - Model advisory assertions as `critical: false`:
       - `theme.css.strong_pass_resolved` (advisory)
     - Respect the existing 5-verdict state machine in `VerificationEvaluator`:
       - `INCONCLUSIVE`: When completeness is `EMPTY` (telemetry unavailable).
       - `REJECTED`: When any critical obligation fails or is missing from evidence.
       - `PARTIAL`: When non-critical obligations fail or completeness is `PARTIAL`.
       - `VERIFIED`: When 100% of obligations pass with zero violations.
       - `UNVERIFIED`: Retained strictly as the initial registered state in `issue-register.ts`.
     - Invariant: Do not create any new or duplicate verdict engines.
  2. **Preferred Capability Ordering:**
     - Configure the OMP Theme Skill guidance with the canonical invocation priority:
       $$\text{Layout} \to \text{Font} \to \text{Matched Styles} \to \text{Source Mapping} \to \text{Responsive Matrix} \to \text{Fallback Evaluate}$$
     - Restrict raw `browser.evaluate` to a true escape hatch rather than default exploration.
- **Non-Functional Requirements:**
  - Full auditability: Every verification claim evaluation must store a verifiable receipt in `ReceiptStore`.

## Architecture
```text
OMP Theme Skill Action
        v
Theme Evidence Envelope (Phase 3)
        v
VerificationClaim with ProofObligations
  [critical: true]  theme.source_mapping.file_identified
  [critical: true]  theme.css.active_rule_matched
  [critical: true]  theme.responsive.no_target_overflow
  [critical: false] theme.css.strong_pass_resolved
  [critical: false] theme.responsive.no_doc_overflow
        v
VerificationEvaluator.evaluate()
        v
Verdict: VERIFIED | PARTIAL | REJECTED | INCONCLUSIVE
        v
ReceiptStore (Immutable Audit Log)
```

- Create: `src/main/verification/theme-proof-helpers.ts` (bridge between `ThemeEvidenceEnvelope<T>` and `MetricSample[]`)
- Modify: `src/main/tools/browser-capabilities.ts` (wire verification registration to theme tools)
- Create: `test/theme-verification-integration.test.ts` (fail-closed verification tests)

## Implementation Steps
1. **Define Theme Proof Obligations in `verification-contract.ts`:**
   - Add standard canonical metric names:
     - `'theme.source_mapping.file_identified'`
     - `'theme.css.active_rule_matched'`
     - `'theme.css.strong_pass_resolved'`
     - `'theme.responsive.no_target_overflow'`
     - `'theme.responsive.no_doc_overflow'`
2. **Implement `ThemeProofHelpers`:**
   - Write converter `themeEnvelopeToMetricSamples(envelope: ThemeEvidenceEnvelope<unknown>): MetricSample[]`.
   - Ensure missing samples correctly produce `actual: 'missing'` so `VerificationEvaluator` flags critical failures.
3. **Write Fail-Closed Unit Tests:**
   - Test Case 1: Missing responsive telemetry $\to$ Evaluator returns `INCONCLUSIVE`.
   - Test Case 2: Target overflow detected on $375\text{px}$ $\to$ Critical violation $\to$ Evaluator returns `REJECTED`.
   - Test Case 3: CSS stylesheet URL unresolved (advisory) $\to$ Evaluator returns `PARTIAL`.
   - Test Case 4: Complete valid evidence $\to$ Evaluator returns `VERIFIED`.
4. **Document and Verify Preferred Capability Ordering:**
   - Add documentation and integration test checking OMP interaction trace matches the linear tool sequence.

## Success Criteria
- [x] Theme proof obligations correctly evaluate across all 4 engine verdicts (`INCONCLUSIVE`, `REJECTED`, `PARTIAL`, `VERIFIED`).
- [x] Any missing critical theme obligation immediately yields `REJECTED` or `INCONCLUSIVE` (zero false `VERIFIED`).
- [x] Integration trace test demonstrates linear execution: layout $\to$ font $\to$ matched styles $\to$ source mapping $\to$ responsive matrix $\to$ verify.

## Risk Assessment
- *Risk:* Overly strict critical obligations cause false `REJECTED` on third-party scripts.
  *Mitigation:* Scope obligations specifically to target element selectors rather than global document state.
