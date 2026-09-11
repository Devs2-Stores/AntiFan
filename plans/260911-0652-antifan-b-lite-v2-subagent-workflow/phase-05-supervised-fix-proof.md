---
title: "Phase 5: Supervised Fix Proof on One Static Surface"
status: todo
---

# Phase 5: Supervised Fix Proof on One Static Surface

## Overview

The contract, the enforcement, and the harness are proven individually by Phases 1–4. This phase proves they hold **together** on exactly one static surface, under supervision, with a typed outcome. One surface is deliberate: the goal is a trustworthy loop, not coverage.

"Static surface" means a surface whose fidelity delta is structural and reproducible (geometry/section/card parity), not a rotating carousel or a widget whose phase differs between passes — those stay out of scope until Phase 7.

Engine defaults guard: the AntiFan verification engine's defaults (strict compare, masks off, no height drift allowance, no auto-retry) are not overridden to make this round pass.

## Requirements

- [ ] One static surface is selected and pinned with: requested route, viewport set, reference identity (route assertion from Phase 1), and the verdict cause code the round targets.
- [ ] Main issues a FixRequest v2 built from the Phase 3 schema; the fixer runs only inside the Phase 4 staged workspace.
- [ ] The round is adjudicated **only** by AntiFan's engine — no fixer claim is accepted as evidence.
- [ ] The round ends with exactly one typed outcome: `FIXED_VERIFIED`, `REFUSED_SCOPE`, or `STALEMATE`, plus an evidence path.
- [ ] Engine defaults are recorded before and after the round to prove none were weakened.
- [ ] The round's receipts (stage, audits, merge, verdict) are collected in one place and referenced from the phase report.

## Implementation Steps

1. Select the surface and capture a baseline reference with the Phase 1 assertion live; record the reference identity and the observed verdict cause.
2. Assemble the FixRequest v2: staged root, `allowedFiles` limited to the compiler's output directories, `diffBudget` and `maxScopeExpansion` sized for a single structural fix, evidence refs, and the target cause code.
3. Run the fixer; capture its return. Reject any return containing a self-verification claim as malformed rather than as a result.
4. Run the audits and merge gate; record each receipt.
5. Re-measure the surface against the pinned reference and let the engine adjudicate; record the verdict, cause code, and evidence path.
6. Run the deliberate negative: a second FixRequest whose scope is intentionally too narrow (or whose fix requires a file outside `allowedFiles`) and confirm the loop returns `REFUSED_SCOPE` with the missing path named instead of expanding scope on its own.
7. Write the phase report: what the loop did, what it refused, which lever enforced the refusal (merge gate for file-effect refusals; capability name filter or `tool_call` guard for an observed tool call; the merge gate's static `auditToolSurface` only for a *declared* surface), and the evidence paths.

## Evidence Anchors

- Phase 1 assertion + refusal code; Phase 3 FixRequest v2 schema; Phase 4 audit/merge receipts
- `.canary/tools/viewport-run.mjs` (per-viewport compare + evidence write), `.canary/tools/canary-settle.mjs` (settle predicates)
- `src/main/verification/verification-contract.ts`, `src/main/verification/visual-capture.ts` (engine defaults + capture honesty)
- `plans/260911-0133-haravan-customize-theme-fidelity/plan.md` (compare parameters that must not be relaxed)

## Todo

- [ ] Select + pin one static surface and its reference identity
- [ ] Issue FixRequest v2 and run the fixer in the staged workspace
- [ ] Run audits + merge gate; collect receipts
- [ ] Re-measure and let the engine adjudicate
- [ ] Negative round: prove `REFUSED_SCOPE` with the missing path named
- [ ] Verify engine defaults unchanged across the round
- [ ] Write the phase report with evidence paths

## Success Criteria

- [ ] The round produces exactly one typed outcome and an evidence path; no self-verification is present anywhere in it.
- [ ] The acceptance chain (staged workspace → edit → touched-path audit → budget audit → merge gate) is complete with receipts, on a real surface rather than a fixture.
- [ ] The negative round refuses scope expansion rather than performing it, and names the file that would have been required.
- [ ] Engine defaults before and after the round are identical.
- [ ] The report states which lever (merge gate, capability name filter, `tool_call` guard, declared-surface audit) enforced each refusal, and does not attribute an observed-call enforcement to the merge gate.

## Risk & Rollback

Risk: the surface's real delta is not fixable within a bounded scope, turning the round into `STALEMATE` and leaving the phase without a `FIXED_VERIFIED` demonstration. Mitigation: the outcome set explicitly includes `REFUSED_SCOPE` and `STALEMATE`; the phase passes on a *typed, audited* outcome, and `FIXED_VERIFIED` is not required to declare the loop valid — but a `STALEMATE` must be diagnosed and reported with its cause before the phase closes. Rollback: the merge gate is the only writer to the real workspace; disabling it leaves the staged attempt and all receipts intact, and recovery is path-scoped per Phase 4.
