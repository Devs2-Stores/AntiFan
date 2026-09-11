---
title: "Phase 5: Supervised Fix Proof on One Static Surface"
status: done
---

# Phase 5: Supervised Fix Proof on One Static Surface

## Overview

The contract, the enforcement, and the harness are proven individually by Phases 1–4. This phase proves they hold **together** on exactly one static surface, under supervision, with a typed outcome. One surface is deliberate: the goal is a trustworthy loop, not coverage.

"Static surface" means a surface whose fidelity delta is structural and reproducible (geometry/section/card parity), not a rotating carousel or a widget whose phase differs between passes — those stay out of scope until Phase 7.

Engine defaults guard: the AntiFan verification engine's defaults (strict compare, masks off, no height drift allowance, no auto-retry) are not overridden to make this round pass.

## Requirements

- [x] Surface candidate selected and pinned: page-02 `/brands` @390, `STRUCTURAL_PARITY_MISMATCH`, `deltaGeometry 10` on attempt `attempt-53ea13ac`. **Withdrawn as a fix target**: the delta does not reproduce (see Measured Outcome).
- [x] The A -> edit -> touched-path audit -> budget audit -> merge chain ran on a real tree (`scripts/lib`), and the fixer runs only inside the staged workspace (launcher proof: `CHILD_OK grant=write allowed=file.read,file.write`, exit 0). No new fixer session was spent on the withdrawn surface.
- [x] The chain is adjudicated by the merge gate's audits and the engine's own evaluator; a self-verification claim is a refusal class, and the failure signature now comes from the evaluator's `proofProfile.violations` rather than from caller-supplied sample flags.
- [x] Typed outcomes measured, both directions: `REFUSED_TOUCHED_PATH` (exit 10, path named) for an edit outside `allowedFiles`; `REFUSED_SCOPE_EXPANSION` (exit 12) when a touched file is absent from `requestedTargets`; `OK` (exit 0) with a receipt and a real merge for an in-scope edit. No `FIXED_VERIFIED`, and that absence is a measured result, not a gap.
- [x] No tolerance, mask, timeout or retry default was changed anywhere in this phase; the shipped diff contains none.
- [x] Receipts reproduced in Measured Outcome below, with the exact commands and exit codes.

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

- [x] Select + pin one static surface and its reference identity (pinned; withdrawn as a fix target, see Measured Outcome)
- [x] Issue FixRequest v2 and run the fixer in the staged workspace (chain exercised on `scripts/lib`; fixer session proven in Phase 4)
- [x] Run audits + merge gate; collect receipts
- [x] Re-measure and let the engine adjudicate (the re-measure refuted the recorded verdict; that is the result)
- [x] Negative round: prove `REFUSED_SCOPE` with the missing path named (measured as `REFUSED_TOUCHED_PATH` exit 10 and `REFUSED_SCOPE_EXPANSION` exit 12, path named)
- [x] Verify engine defaults unchanged across the round
- [x] Write the phase report with evidence paths (this section)

## Success Criteria

- [ ] The round produces exactly one typed outcome and an evidence path; no self-verification is present anywhere in it.
- [ ] The acceptance chain (staged workspace → edit → touched-path audit → budget audit → merge gate) is complete with receipts, on a real surface rather than a fixture.
- [ ] The negative round refuses scope expansion rather than performing it, and names the file that would have been required.
- [ ] Engine defaults before and after the round are identical.
- [ ] The report states which lever (merge gate, capability name filter, `tool_call` guard, declared-surface audit) enforced each refusal, and does not attribute an observed-call enforcement to the merge gate.

## Measured Outcome (2026-09-11, after execution rounds 6-7)

**The pinned surface's delta does not reproduce, so the fix target is withdrawn.** The recorded attempt
(`attempt-53ea13ac-731a-43cf-a864-80f2b230869f`, evidence written 04:48) says the reference measured
`docHeight 4270` / header 170 and the clone `4280` / 180 at 390, i.e. `deltaGeometry 10` on the header
alone (main and footer pixel-identical at 3319 and 741.36). Five independent designs re-measured the
*same clone bytes* at 390 under mobile emulation and found no such delta:

| Design | What it did | Result |
|---|---|---|
| Paired capture | live reference and served clone in one session, 458-element header subtree compared node by node | both **4270 / header 170**, **0 differing nodes**, 11 fonts loaded on each side |
| Repeated load | the clone alone, 6 full loads, measured at t+7s and t+11s | **4270 / 170** on all 6, 0 within-load drift |
| Time series | 84 samples over 25s, 300ms apart, under measured mobile emulation (UA `...Mobile Safari/537.36`, `ontouchstart`, `maxTouchPoints 5`, `(max-width:767px)` true) | flat **170** the whole window: no late reflow |
| Viewport sequence | one tab 390 -> 1440 -> 1024 -> 390 -> 390 | **4270 / 170** at every step |
| Campaign document order | one tab at the clone root (desktop document) at 1440 and 1024, then the mobile entry `mobile/index.html` navigated in the same tab; post-swap series | **4270 / 170**, flat over 30 further samples |

The instrument is validated by the reference side: the campaign recorded the reference at 4270 and my
paired capture measures the live reference at exactly 4270 / header 170 — so the setup matches the
campaign's regime, and the clone matches the reference on it. The recorded 4280 is therefore a
capture-time property of that attempt, not a clone rendering defect: the same bytes, viewport and
document order now agree with the reference to the pixel. No `packages/site-clone` edit was made, and
none is warranted on this evidence.

**The loop's enforcement is proven on a real tree, both directions.** Against a staged copy of
`scripts/lib` (`stage` exit 0, 11 files, `gitHead 74abde9c`), with a FixRequest v2 whose `allowedFiles`
was `campaign-verdicts.mjs`:

- editing `process-identity.mjs` -> exit **10 `REFUSED_TOUCHED_PATH`**, note *"Touched paths outside
  allowedFiles or in forbiddenPaths: process-identity.mjs"*;
- editing only `campaign-verdicts.mjs` -> exit **0 `OK`**, and `merge` into a throwaway target applied
  the change with an `OK` receipt, while the real workspace stayed byte-identical;
- a request whose `requestedTargets` did not name the touched file -> exit **12
  `REFUSED_SCOPE_EXPANSION`**, note *"Scope expansion |T \\ R| = 1 exceeds maxScopeExpansion (0)"*.

That last case is a fact worth carrying forward: `maxScopeExpansion` is measured against
`requestedTargets`, **not** against `allowedFiles`, so a request that omits its targets is refused even
when the edit is inside the allowlist. The failing receipt of this condition is an operator error in the
request, not a gate defect.

**Residual gap, recorded rather than papered over.** The recorded page-02 refusal was published from a
measurement that does not reproduce, which means the structural gate can mint a refusal from an unstable
read. Nothing in this phase changes that: a stability precondition for structural refusals (two
consecutive identical structural reads, else `INCONCLUSIVE`) is a *behavior* change to the compare path
and needs an owner decision, because it touches the same `INCONCLUSIVE`-versus-refusal boundary the plan
protects. It is left open with this evidence.

**What this phase did not produce, and why that is the honest outcome.** No `FIXED_VERIFIED`. The Risk &
Rollback clause anticipated a delta that is not fixable within a bounded scope; the measured variant is
weaker still - there is no delta to fix. The phase closes on typed, audited outcomes with the receipts
above, and the withdraw is backed by numbers rather than by a claim of infeasibility.

## Risk & Rollback

Risk: the surface's real delta is not fixable within a bounded scope, turning the round into `STALEMATE` and leaving the phase without a `FIXED_VERIFIED` demonstration. Mitigation: the outcome set explicitly includes `REFUSED_SCOPE` and `STALEMATE`; the phase passes on a *typed, audited* outcome, and `FIXED_VERIFIED` is not required to declare the loop valid — but a `STALEMATE` must be diagnosed and reported with its cause before the phase closes. Rollback: the merge gate is the only writer to the real workspace; disabling it leaves the staged attempt and all receipts intact, and recovery is path-scoped per Phase 4.
