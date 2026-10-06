# Ultra Verdict — Visual QA Upgrade Contract (ak:brainstorm --ultra)

## Receipt

```
ultra: picked=1/5 margin=low unanimous=no rejected_all=no
```

Winner: **Cand1ViewportSweep** (per-viewport integrity sweep), materialized
unchanged at `contract.md`. Score 97/100, margin over runner-up (94) = 3 points.

## Ranking (second, clean verifier run)

| Rank | Label | Candidate | Total | R1 | R2 | R3 | R4 | R5 |
|------|-------|-----------|-------|----|----|----|----|----|
| 1 | D | Cand1ViewportSweep (per-viewport integrity sweep) | 97 | 20 | 20 | 19 | 18 | 20 |
| 2 | C | Cand3Stateful (stateful/interaction-state coverage) | 94 | 19 | 19 | 19 | 18 | 19 |
| 3 | E | Cand4SemanticChecks (semantic/style-level checks) | 92 | 17 | 19 | 18 | 19 | 19 |
| 4 | A | Cand5EvidenceArch (evidence architecture) | 91 | 17 | 18 | 18 | 19 | 19 |
| 5 | B | Cand2PixelDiff (pixel-diff baseline matrix) | 89 | 17 | 18 | 18 | 18 | 18 |

Verdict: `rejected_all=false`, confidence `high`. All candidates passed hard
constraints (no fabricated APIs/specs; repo spot-checks clean).

## Winner rationale (verifier)

Candidate D/Cand1 performs pinpoint empirical diagnosis verified against the
committed code:
1. `theme-qa-workflow.ts:803-838` — `LayoutIntegrityEngine` restricted to the
   active viewport.
2. `theme-qa-workflow.ts:849-862` vs `native-tab-host.ts:15047` —
   `runResponsiveCheck` keys `results[bp.id]` ('mobile-small', 'tablet-portrait',
   'desktop-laptop'…) while the workflow consumer indexes by `String(w)`
   ('320','375',…) → every non-active-width entry reads `undefined` and falsely
   reports zero critical findings. **Confirmed live defect in shipped code.**
3. `theme-qa-workflow.ts:1146-1148` — checklist keys `layout`, `responsive`,
   `overflow` all collapse to `!overflowResult.hasOverflow`, discarding measured
   overlap/occlusion findings.

Winner's fix: index by `bp.width`, run overflow culprits + 6 integrity detectors
across 5 canonical breakpoints (≤800ms budget), sanitize off-canvas menus,
restore viewport in `finally`. C (stateful probes) and E (semantic detectors)
are natural Phase 2/3 follow-ups per the winner's own trade-off analysis.

## First verifier run — voided

The first kongming run was voided on controller audit:
- **Anonymization leak**: contract bodies self-identified ("Candidate N/5"
  headers); re-run sanitized all identity markers.
- **Rubric overreach**: it penalized C/D/E 9/20 on R4 for lacking a dedicated
  "Unknowns" *section* — never required by the dispatch prompt; C/D/E covered
  unknowns substantively in prose. Verdict flipped A(97)→D(97) after correction.
- First-run receipt preserved for audit only: `picked=A, margin=low` — invalid.

## De-anonymization map (private during verification)

A=Cand5EvidenceArch, B=Cand2PixelDiff, C=Cand3Stateful, D=Cand1ViewportSweep,
E=Cand4SemanticChecks.

## Caveats recorded (not resolved)

- **Winner contract internal budget conflict**: Constraints §C3 states the
  5-viewport sweep MUST stay ≤850ms (~120-150ms/breakpoint); AC-7 requires
  ≤800ms. Left as-authored — the downstream `/ak:fix` or plan phase must pick
  one number (recommend the stricter 800ms; both are aspirational budgets, not
  measured data).
- **Defect impact, precisely stated**: the `bp.id` vs `String(w)` key mismatch
  zeroes **per-width attribution inside `responsiveMap`**
  (`theme-qa-workflow.ts:849-862`): every non-active-width entry reports
  `documentOverflow=false, critical*=0`. Overflow culprits ARE still collected
  for failing widths earlier (`:760-795`, which iterates breakpoint values
  regardless of keys) and a failing breakpoint is still recorded — so the
  shipped sweep is degraded (per-width report lies at zero), not wholly blind.
  Integrity detectors (overlap/clipping/occlusion/offscreen) remain active-
  viewport-only by design (`:834-838`). Severity unlabelled (not P0) pending
  report-consumer/test evidence.
- **Corrective rescore disclosed**: the second verdict is a post-hoc rescore
  under clarified R4 wording plus sanitized identity cues — not a pristine
  blind pass. First-run verdict preserved above as voided; do not cite either
  run as uncontaminated.
