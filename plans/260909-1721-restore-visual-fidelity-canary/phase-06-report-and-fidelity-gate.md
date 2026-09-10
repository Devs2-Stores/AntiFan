---
title: "Phase 6: Report and Fidelity Gate"
status: done
---

# Phase 6: Report and Fidelity Gate

## Outcome

Publish `.canary/run3/REPORT.md` using only persisted evidence and emit exactly one final verdict: `PASS`, `FAIL`, or `INCONCLUSIVE`.

## Files

- `.canary/tools/build-report.mjs`
- `.canary/run3/REPORT.md`

## Required Report Structure

Use the user's exact high-level structure:

1. `Environment`
2. `Pipeline Tested`
3. `Reference Capture`
4. `Asset Discovery`
5. `Asset Localization`
6. `Independent HTML`
7. `Live Chromium Results`
8. `Structural Findings`
9. `Visual Findings`
10. `Mask Audit`
11. `Remote Dependency Audit`
12. `Run #1 vs Run #2`
13. `Remaining Failures`
14. `Final Fidelity Gate`
15. `What Is Actually Proven`
16. `Next Action`

Section 12 must retain the historical run1/run2 comparison and add a separately labeled recovery-run/run3 comparison. Never rewrite prior raw evidence.

## Gate Policy

Evaluate evidence availability and typed status first. Any missing authoritative atomic pair, failed settlement, stale identity, quarantine without recovery, or compare status `INCONCLUSIVE` fixes the viewport verdict to `INCONCLUSIVE`; placeholder numeric fields such as `mismatchPercentage: 100` MUST NOT override that precedence into `FAIL`.

`PASS` only when every exact viewport has all of the following:

- complete settlement and coherent target identity;
- valid full-page capture lineage for the authoritative atomic pair, complete PNG bytes, and compatible geometry;
- authoritative pixel mismatch at or below `2%`;
- no cardinality, grid, navigation, hero, section-order, or responsive structural failure;
- acceptable page/section heights and major component geometry;
- zero reference-origin visual requests from the clone runtime;
- zero broken rendered assets and no unresolved visual localization failure;
- no broad or implicit masking, with recorded mask ratio;
- no unexplained horizontal overflow or viewport clipping regression.

Use `FAIL` when complete deterministic evidence proves mismatch beyond policy, including structure, assets, height, responsiveness, or overflow even when pixel mismatch is low.

Use `INCONCLUSIVE` when required evidence is missing or incompatible: settlement failure, stale/unstable target, capture timeout, invalid/truncated PNG, unresolved mask state, excessive reference self-drift, missing viewport, or absent full-page lineage. Reference drift is diagnostic only; never subtract it from candidate mismatch or relax the `2%` target.

## Failure Classification

Every confirmed remaining failure must use one of the requested categories and include:

- `WHAT`
- `WHERE`
- `EXPECTED`
- `ACTUAL`
- `DELTA`
- `LIKELY SCOPE`
- `EVIDENCE`

Do not include speculative failures. Distinguish `ASSET_MISMATCH`, `ASSET_RENDER_MISMATCH`, `LAYOUT_MISMATCH`, `STRUCTURAL_HEIGHT_MISMATCH`, `CARDINALITY_MISMATCH`, `GRID_MISMATCH`, `TYPOGRAPHY_MISMATCH`, `RESPONSIVE_MISMATCH`, `OVERFLOW_MISMATCH`, `NAVIGATION_MISMATCH`, `HERO_MISMATCH`, `SETTLEMENT_FAILURE`, `REMOTE_VISUAL_DEPENDENCY`, `MASKING_TOO_BROAD`, `TARGET_STALE`, and `OTHER`.

## Proof Boundaries

Explicitly separate:

- `UNIT-TEST PROOF`
- `LIVE RUNTIME PROOF`
- `VISUAL PROOF`
- `STRUCTURAL PROOF`
- `ASSET PROOF`

`IMPLEMENTATION EXISTS`, `UNIT TESTS PASS`, and `LIVE CHROMIUM TEST PASS` are different claims. Only exercised live evidence can support the last claim.

The report must label standalone capture artifacts as independent continuity evidence and atomic compare artifacts as the only authoritative pixel inputs. It must never merge, substitute, or silently choose between the two lineages.

## Cross-Plan Sync

- [x] If recovery succeeds, unblock and update Phase 4 of `plans/260908-1223-independent-html-clone-and-fidelity-pipeline/` with the new evidence path; do not mark that whole plan complete unless its own remaining criteria are satisfied. (Phase 4 updated with .canary/run3/REPORT.md; whole plan kept pending).
- [x] Update plan status and all phase checkboxes from actual evidence only.
- [x] Recommend exactly the next implementation action demonstrated by remaining failures; do not invent architecture.
- [x] Generate the report deterministically from persisted evidence through `.canary/tools/build-report.mjs`; missing referenced artifacts or contradictory receipts fail generation rather than producing a verdict.

## Post-Completion Corrections

`.canary/run3/` carries two bundles: the desktop bundle at `clone/` (served to the 1440 and 1024 viewports) and the mobile bundle at `clone/mobile/` (served to 390). Two defects in `build-report.mjs` prevented truthful regeneration once that second bundle existed:

- **Per-document bundle resolution.** Every document's asset references were verified against one run-level bundle directory. The desktop telemetry document was therefore checked against `clone/mobile/assets`, and generation failed closed with `referenced artifact missing: .canary/run3/evidence.assetIntegrity[11] … bien-ap-giga.png` — a real fail-closed abort, not a missing asset (the file exists in the desktop bundle and the mobile bundle legitimately never references it). Each document now resolves against the bundle it names: a viewport document through its own `cloneDir`, a telemetry document through its own `bundle.entryHtmlPath`, with the run-level bundle only as fallback.
- **Deterministic primary telemetry.** The document describing the pipeline came from the first telemetry document in `readdir` order, which made `build-telemetry-mobile.json` the report's primary, so §2–§6 described the mobile bundle (115 assets) while §7–§9 reported viewports served from the desktop bundle. Selection now ranks candidates by how many viewports were served from their bundle directory (desktop 2, mobile 1), then by the canonical `build-telemetry.json` name, then alphabetically. A membership test against the viewport bundle directories is not sufficient — both bundles appear there, which leaves directory order in control; measured: with membership-only selection the report still identified `clone/mobile/index.html` and 115 assets, with the ranking it identifies `clone/index.html` and 118 assets / 36,671,943 bytes.

Proof, all measured on the final desktop-primary configuration (offline, no live tabs). Before either correction, `build-report.mjs .canary/run3` aborts with the missing-artifact error. After both, `node .canary/tools/build-report.mjs .canary/run3` exits `0` with `artifactsVerified: 268` and `failures: []`; the report identifies `Clone bundle: .canary/run3/clone/index.html` with `118 files / 36,671,943 bytes`; all 11 rows of its persisted-evidence inventory re-hash against the current evidence files (0 stale rows); and it carries exactly one `FINAL VERDICT: INCONCLUSIVE`. Two consecutive regenerations produced byte-identical reports (sha256 `a009ab036cfad71e…`), so the selection rule is deterministic rather than order-dependent.

Order independence is covered by `test/unit/build-report-bundle-ordering.test.mjs`, which replays both bundle orderings through the real CLI against a fixture built from the persisted run3 evidence: `node --test test/unit/build-report-bundle-ordering.test.mjs` → 2 tests, 2 pass, 0 fail.

## Done When

The report contains all sixteen sections, all three viewport rows, evidence-linked failure classifications, the historical/recovery comparison, and one defensible final verdict without unsupported claims.
