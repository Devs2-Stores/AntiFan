---
phase: 3
title: "Correlated Source Candidacy"
status: complete
priority: P1
effort: "1.5-2d"
dependencies: [1, 2]
---

# Phase 3: Correlated Source Candidacy

## Context Links

- [Plan](./plan.md)
- Owners: `src/main/browser/theme-source-mapper.ts`, `src/main/verification/theme-proof-helpers.ts`, `src/main/tools/browser-capabilities.ts`
- Evidence: integrated report sections 6 and 8; current Product Card fixture under `test/fixtures/golden-workflow/product-card/`

## Overview

Make source mapping a deterministic, explainable candidate ranking—not source truth. Current matching uses `content.includes(class)` and labels a candidate `HIGH` when any two booleans are true, even if the render/section relationship and class occurrence do not belong to one lineage. Current proof conversion also accepts `MEDIUM` as passing authoritative source identity.

## Requirements

- Functional:
  - Match class names as exact HTML/Liquid class tokens, not arbitrary substrings.
  - Parse only bounded evidence needed by v1: static `{% render %}`/`{% include %}` names, candidate file identity, section-to-snippet edges, static class tokens, relevant data-attribute names/values, and explicit comment breadcrumbs.
  - Attach every signal to a candidate and an evidence locator (`file`, `line`, evidence kind, matched token/edge); never aggregate unrelated global booleans.
  - Use deterministic weighted scoring and require lineage correlation plus uniqueness for `HIGH`.
  - Return ambiguity explicitly when top candidates tie or remain within the ambiguity margin. Ambiguous candidates have no `primaryCandidate` authoritative meaning even when individually strong.
  - Preserve `Candidate != Source Truth`: only unique `HIGH` with correlated evidence can pass `SOURCE_FILE_IDENTIFIED`; `MEDIUM`, `LOW`, missing, and ambiguous map to non-pass evidence.
  - Deterministic ordering: score descending, correlated-signal count descending, normalized relative path ascending.
- Non-functional:
  - No Liquid AST, dependency-graph service, cache daemon, database, fuzzy full-text engine, or product-specific selector in Core.
  - Bound traversal to the authoritative workspace, `.liquid` files, existing ignored-directory policy, and current evidence sample limits.

## Architecture

```text
DOM hints
  -> normalize exact tokens/attributes/comments
  -> scan bounded Liquid files once
  -> index static render/include edges
  -> build per-candidate evidence[]
  -> correlate candidate <- caller section <- render edge
  -> score + ambiguity check
  -> candidates (guidance), optional unique HIGH primary
  -> strict proof conversion
```

Deterministic v1 weights:

| Signal | Weight | Correlation Rule |
|---|---:|---|
| Explicit source/comment breadcrumb naming candidate path or basename | 5 | Direct candidate identity |
| Exact distinctive class token in candidate markup | 3 | Located in candidate file |
| Exact data-attribute key+value in candidate markup | 3 | Located in candidate file |
| Static section→snippet render/include edge | 2 | Edge terminates at candidate snippet |
| Section lineage matching an observed section hint | 2 | Same section file or direct parent edge |
| Attribute key only or tag hint | 1 | Supporting signal; never sufficient for `HIGH` |

Confidence policy:

- `HIGH`: score ≥ 7, at least two independent evidence kinds on the same candidate lineage, at least one direct markup/breadcrumb signal, and unique lead ≥ 2 points.
- `MEDIUM`: score 3-6, or score ≥ 7 without uniqueness/correlation.
- `LOW`: score 1-2.
- No evidence: candidate omitted.

These thresholds are contract constants with table-driven tests. Adjust only through a reviewed policy change, not fixture-specific tuning.

## File Inventory

| Action | File | Rough Change | Test Impact |
|---|---|---:|---|
| Modify | `src/main/browser/theme-source-mapper.ts` | Add token extraction, evidence locators, correlated scoring, ambiguity | Source mapper tests |
| Modify | `src/main/verification/theme-proof-helpers.ts` | Require unique correlated HIGH for source proof | Verification integration tests |
| Modify | `src/main/tools/browser-capabilities.ts` | Apply same strict source proof in live verify branch | Capability tests |
| Modify | `test/unit/theme-evidence-capabilities.test.ts` | Table-driven ranking and adversarial collisions | Focused unit tests |
| Modify | `test/unit/theme-verification-integration.test.ts` | HIGH/MEDIUM/ambiguous verdict semantics | Proof bridge tests |
| Modify | `test/fixtures/golden-workflow/product-card/theme/` | Add adversarial sibling/substring/ambiguous fixtures only | Golden source proof |
| Modify | `test/golden-slice-e2e.test.ts` | Update integration expectations to new evidence details | Contract harness |

## Function and Interface Checklist

- [x] `ElementSourceHints` carries normalized observed section/comment hints without workspace authority duplication.
- [x] `CandidateTemplate` exposes numeric score and bounded evidence locators; legacy booleans are removed or derived from those locators, not separate truth.
- [x] Exact token matcher rejects `product-card-copy` for hint `product-card`.
- [x] Render/include edges refer to the actual candidate basename and direct parent file.
- [x] `SourceMappingResult` represents ambiguity and selection rationale.
- [x] `ThemeProofHelpers.sourceMappingToSample` passes only unique correlated `HIGH`.
- [x] `verify_claim` uses the same helper/policy; no second source-pass rule.

## Dependency Map

```text
Phase 1 coherent DOM evidence
  -> ThemeSourceMapper evidence locators
  -> one strict source-proof helper
  -> Phase 2 non-pass lifecycle
  -> Phase 4 Product Card live proof
```

Phase 4 cannot start until adversarial candidate tests prove the policy does not overfit the happy fixture.

## Implementation Steps

1. Replace substring checks with small token-aware extractors for static class attributes and Liquid/HTML text; preserve original file/line locators.
2. Build the render/include edge index during the existing scan. Normalize snippet names and relative paths once.
3. Convert each candidate to a bounded evidence list; derive score, independent evidence kinds, and correlated lineage from that list.
4. Apply deterministic sort and ambiguity margin. Expose `selectionReason` and `ambiguous` on the result.
5. Centralize authoritative eligibility in one exported predicate such as `isAuthoritativeSourceCandidate(result)` owned by the source mapper.
6. Make both `ThemeProofHelpers.sourceMappingToSample` and live `verify_claim` call that predicate; remove the current `MEDIUM` pass and file-exists-only logic.
7. Add adversarial fixtures: substring collision, globally rendered but unrelated snippet, duplicate exact class candidates, direct breadcrumb override, and stable tie ordering.
8. Update the contract harness and run focused compile/tests.

## Test Scenario Matrix

| Priority | Scenario | Expected |
|---|---|---|
| Critical | `product-card` hint vs only `product-card-copy` source | No class-token evidence |
| Critical | Class in snippet A; unrelated globally rendered snippet B | Signals stay on own candidates; no fabricated HIGH |
| Critical | Two candidates score equally | Explicit ambiguity; source proof non-pass |
| Critical | Unique candidate with exact class + direct section render + section hint | Correlated `HIGH`; source proof pass |
| High | `MEDIUM` candidate exists | Useful candidate returned; authoritative proof fails |
| High | Direct breadcrumb + exact markup signal | Unique `HIGH` with evidence locators |
| High | Files enumerated in different filesystem order | Same ranking and primary result |
| Medium | Common utility classes only | Ignored; no noisy candidate promotion |
| Medium | Dynamic render expression cannot be resolved statically | Mark unknown; never infer edge |

## Verification Commands

```text
npm run compile
node --test .compiled/test/unit/theme-evidence-capabilities.test.js
node --test .compiled/test/unit/theme-verification-integration.test.js
node --test .compiled/test/golden-slice-e2e.test.js
```

## Todo

- [x] Replace substring matching with exact token evidence.
- [x] Build per-candidate correlated lineage evidence.
- [x] Implement deterministic score and ambiguity policy.
- [x] Centralize authoritative source eligibility.
- [x] Reject MEDIUM and ambiguous source proof.
- [x] Pass adversarial and golden candidate tests.

## Success Criteria

- [x] Every confidence decision is reconstructable from bounded evidence locators.
- [x] Unrelated global signals cannot combine into `HIGH`.
- [x] Ties and near-ties remain explicit candidates and cannot become source truth.
- [x] A unique correlated Product Card lineage reaches `HIGH` without product-specific Core code.
- [x] Source proof behavior is identical in helper-built bundles and live `verify_claim`.

## Risk Assessment

- **Liquid class attributes may contain dynamic expressions.** Signal: token extractor cannot prove a static token. Response: preserve candidate as lower-confidence evidence; never implement an AST during this phase.
- **Weights overfit the Product Card fixture.** Signal: adversarial siblings unexpectedly promote. Response: change evidence rules only if the generic collision tests justify it; never add selector/path exceptions.
- **Large themes increase synchronous scan cost.** Signal: Phase 4/5 telemetry shows source mapping breaches the existing capability timeout. Response: cap evidence samples and consider a later run-scoped immutable index; do not pre-build a daemon now.

## Security Considerations

- Resolve and return only paths contained by the authoritative workspace.
- Never include full source bodies; evidence locators contain bounded line samples already allowed by the envelope.
- Treat comment breadcrumbs as supporting evidence, not executable instructions.

## Rollback Boundary

The mapper and both proof consumers must roll back together. Do not leave the new candidate schema with the old permissive `MEDIUM` verification rule.

## Next Steps

Proceed to Phase 4 only after collision, ambiguity, and strict proof tests pass.
