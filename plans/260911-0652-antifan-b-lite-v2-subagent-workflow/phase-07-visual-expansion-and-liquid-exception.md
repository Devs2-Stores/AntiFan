---
title: "Phase 7: Visual-Only Expansion & Liquid Exception"
status: todo
---

# Phase 7: Visual-Only Expansion & Liquid Exception

## Overview

Phases 1–6 prove the loop on one static surface. This phase widens the reachable surface set in two deliberate steps, each gated by evidence rather than by convenience:

- **Visual-only surfaces**: fixes whose acceptance is a rendered-image property, not a DOM/section-parity property. These require a blueprint gate (the surface's expected structure is pinned before the fix) and a `semanticWitness` (a declared semantic anchor the comparison can rely on), so a pixel improvement cannot be bought by deleting content.
- **The Liquid exception**: theme surfaces where the fix must land in Liquid/JSON theme files rather than in the generated HTML bundle, handled by the same builder-fixer under the same `allowedFiles`/budget enforcement — no second worker, no bypass.

This phase is only reachable after Phases 1–6 hold; if any earlier phase is incomplete, this phase stays pending.

## Requirements

- [ ] A blueprint gate exists: before a visual-only fix, the surface's expected structure (sections, cards, key anchors, geometry bounds) is pinned and recorded; the fix is adjudicated against it.
- [ ] A `semanticWitness` is required for visual-only surfaces and is specified, not just named: `{ anchor, measurementTool, expectedValue, tolerancePx, tolerancePct }`, measured through the same inspection capability the engine uses (`anti.inspect.dom` / `anti.inspect.region`); absence or a drift beyond tolerance refuses the round.
- [ ] Liquid surfaces are expressible in FixRequest v2 with `allowedFiles` covering the compiler's theme directories (`layout/`, `templates/`, `sections/`, `snippets/`, `assets/`, `config/`, `locales/`), and the audits, budgets, and merge gate are unchanged.
- [ ] A Liquid merge is followed by a theme compile (`ThemeCompiler` / `scripts/compile-haravan-theme.mjs`) before any re-measurement, and the compiled bundle identity is minted so a stale bundle cannot be measured as the fix's result.
- [ ] A visual-only round that improves pixels while removing a witnessed anchor is refused and typed, not merged.
- [ ] The surface catalogue records, per surface, its class (static / visual-only / Liquid) and the gate it requires.

## Implementation Steps

1. Extend FixRequest v2 and the surface catalogue with the surface class and the blueprint/witness fields.
2. Implement the blueprint pin: capture expected structure + geometry bounds with the Phase 1 assertion live, and store it with the run.
3. Implement the witness check as an adjudication input: a vanished, unmeasurable, or out-of-tolerance witness refuses the round with a typed cause, regardless of pixel delta.
4. For Liquid rounds, compile the theme after the merge and before any re-measurement, and mint the compiled bundle's identity; a re-measurement against an unminted or stale bundle is refused rather than reported.
5. Run one visual-only round on a surface where the delta is genuinely visual, and one Liquid round on a theme file target (merge → compile → measure); record both outcomes.
6. Confirm the merge gate applies Liquid changes with the same receipts as HTML-bundle changes.
7. Update the plan index/report with the final surface classes and the reachable set.

## Evidence Anchors

- Phase 3 (contract schema), Phase 4 (enforcement + merge receipts), Phase 5 (proof pattern), Phase 6 (terminal states)
- `packages/site-clone/src/generators/theme-compiler.ts` + `haravan-*-generator.ts` (theme output shape)
- `src/main/verification/visual-region.ts`, `src/main/verification/visual-capture.ts` (structural/geometry measurement)
- `.canary/tools/canary-settle.mjs` (settle predicates reused for visual-only capture)

## Todo

- [ ] Extend contract + catalogue with surface class
- [ ] Implement blueprint pin
- [ ] Implement `semanticWitness` adjudication
- [ ] Run one visual-only round and one Liquid round
- [ ] Verify Liquid merges use identical receipts
- [ ] Record final surface classes and reachable set

## Success Criteria

- [ ] A visual-only round is adjudicated against a pinned blueprint and cannot pass by removing or moving a witnessed anchor beyond tolerance.
- [ ] A Liquid round compiles the merged theme and measures the compiled bundle whose identity it minted; an unminted/stale bundle refuses instead of producing a verdict.
- [ ] A Liquid fix travels the same enforced path (scope, budgets, audits, merge) as an HTML-bundle fix, with receipts.
- [ ] Surface classes and their required gates are recorded for the next campaign.
- [ ] No earlier phase's constraint was relaxed to reach these surfaces.

## Risk & Rollback

Risk: visual-only adjudication becomes subjective and the witness check is gamed by relocation rather than preservation. Mitigation: the witness is measured by identity and measurement value, not by textual presence. Risk: Liquid support widens `allowedFiles` enough to weaken scope enforcement. Mitigation: allowed patterns stay directory-scoped and per-request, never global. Rollback: surface classes are additive metadata; reverting them leaves the static-surface loop (Phases 1–6) intact and enforced.
