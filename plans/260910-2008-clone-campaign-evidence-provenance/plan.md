---
title: "Clone Campaign Evidence Provenance & Fidelity Gate"
description: "Make the clone canary able to measure: provenance-bound verdicts, a settle contract that reports which predicate failed instead of dying on cosmetic DOM churn, then a re-run of the 15-page campaign against the bundle it produces and one defensible verdict."
status: pending
priority: P0
effort: "18h"
tags: [visual-fidelity, canary, evidence-integrity, site-clone, critical]
created: 2026-09-10
blockedBy: []
blocks: []
---

# Clone Campaign Evidence Provenance & Fidelity Gate

## Outcome Contract

The 15-page clone campaign (`.canary/15-pages/`, 15 pages × 3 viewports = 45 render cases) produces, for every case, a verdict that is adjudicable — `PASS`, or `FAIL` with a deterministic cause — bound to the bundle and the browser instance that produced it. A harness-side settle or capture defect can never again be reported as a fidelity outcome, and when the harness does refuse, its own evidence names the predicate that failed. The campaign publishes exactly one cumulative verdict, and the downstream phase that owns the acceptance gets the evidence path plus the measured policy findings it was missing.

This plan does not promise `PASS`. It promises that a reported number is a measurement, and that a refusal says why. Cases whose document exceeds the CDP capture ceiling are typed platform refusals, not expected comparison cases.

## Why This Plan Exists (measured, not assumed)

| # | Measured fact | Evidence |
|---|---|---|
| 1 | **The campaign cannot produce a single render case today.** A bounded run (`--pages 2`) reported `RENDER CASES RUN 0 / 45`, `FINAL DECISION: CLONE_PIPELINE_BLOCKED`, with the page aborting at the pre-dump settle. | `.canary/state/report-after-probe-20260910.md` (regenerated 2026-09-10T13:11:32Z); `.canary/15-pages/page-02-brands/evidence/summary.json` |
| 2 | **The failing predicate is `domSettled`, and the error never says so.** A direct reproduction measured `mediaFrozen: true, fontsSettled: true, imagesSettled: true, visualStable: true, domSettled: false, structuralMutations: 18`, while the geometry signature was stable and the metrics were byte-identical across four passes (`sections=3, cards=0, docHeight=3975`) — the same values the 04:57Z run recorded when all five flags were `true`. | `.canary/state/settle-diag.mjs` (scratch reproduction — Phase 2 step 1 replaces it with the canonical inline invocation); last-good flags in `page-02-brands/evidence/1440.json.stages.reference.settle` |
| 3 | The settle predicate is a raw `childList` node-count proxy: it requires a continuous 1500 ms window with zero added/removed nodes inside a 9 s budget, so any widget that re-parents a node every ~1 s defeats it forever — even when layout, images, fonts and geometry are provably stable. | `SETTLE_DOM_EXPR`, `.canary/tools/canary-settle.mjs:57-69`; composite AND at `:241`; throw at `:253` |
| 4 | On failure the per-flag diagnostics are discarded: page-12's evidence persists `"stages": {}` — the failing flag was never recorded. | `.canary/15-pages/page-12-gioi-thieu/evidence/1440.json` |
| 5 | No verdict names its bundle, and every saved verdict predates it: bundles were rebuilt at 08:24Z (pages 01–11) and 09:26Z (pages 12–15) while evidence was written 04:57Z–08:22Z. `runId`, `evidenceRunId` and `cloneDir` are `null` in every campaign viewport document. | `clone/manifest.json.generatedAt`; `evidence/summary.json.cloneGeneration.bytes = 670578` vs bundle 670548; provenance env exported by `canary-run.mjs` but not by `fifteen-pages-run.mjs` |
| 6 | The saved cause of the dominant INCONCLUSIVE cannot be produced by the current comparator: `checkCaptureStateCompatibility` compares `cssCaptureSize.h` only when `target.captureMode !== 'full-page'`, so full-page pairs (the campaign's only mode) are exempt. The persisted `CSS capture size mismatch: target 1440x5422 vs baseline 1440x5418` reasons therefore come from an older revision. Below the drift gate, unequal-height pairs do have a real diff path (union denominator, non-overlap counted as diff). | `src/main/verification/visual-capture.ts:1094-1166`; drift gate `src/main/tools/browser-control-port.ts:5075-5130`; diff at `:5803-5903` |
| 7 | The 390 tier has no bundle producer in the campaign: `canary-run.mjs:359` builds `clone/mobile/index.html` from `reference/reference-mobile.html` for run3, and the campaign neither dumps a mobile reference nor builds a mobile bundle — no `clone/mobile/**` exists for any of the 15 pages. One saved 390 case measured the clone at `660x1429` while the reference measured `390x844`. | `.canary/tools/fifteen-pages-run.mjs:475-479` (desktop dump only), `:500-520` (floor probe only); `.canary/tools/viewport-run.mjs:274-277` |
| 8 | Documents beyond the CDP ceiling cannot be captured at all: page-13 at 1024 measured `1200x30492` CSS px, page-15 `1200x32226`. | `CAPTURE_MAX_DIMENSION = 16384`, `src/main/verification/visual-capture.ts:700`; refusal `src/main/browser/tab-devtools-host.ts:1515-1519` |
| 9 | The window is always composited — there is no offscreen or no-activate launch flag anywhere, and `showMainWindow()` is unconditional. The campaign's compositor story does not apply; the tall-page drains at 1440 are document mass, not a missing compositor. | `src/main/index.ts:256`; no such flag in `.canary/state/instance-env.json` |
| 10 | **A stale session attachment** can refuse a run's first tab create: `POLICY_DENIED … (session tab quota reached)` against the previous run's bound tab while the session-scoped census was `[]`. A restart plus a fresh mint cleared it — verified: the next tab create on the same instance succeeded. | observed; producer `src/main/tools/browser-control-port.ts:2076` |
| 11 | The runner exits `0` on a page that produced nothing, and its aggregate report is last-batch-only: the current root report says `PAGES EXECUTED 4 / 15`, `11 pages UNTESTED`, contradicting the evidence on disk for those pages. | `.canary/tools/fifteen-pages-run.mjs` (report write ~`:765`, decision enum ~`:818`, `PAGES EXECUTED` ~`:850`) |
| 12 | The genuine fidelity differences are few and already named: 5 pages FAIL at 1440 on `STRUCTURAL_PARITY_MISMATCH deltaGeometry=15px` (page-02 2.3%, 03 5.11%, 04 15.44%, 08 3.57%, 10 18.95%) — recorded against superseded bundles. | `evidence/1440.json`; `src/main/tools/browser-control-port.ts:5213-5228`; tolerance `maxGeometryDeltaPx` 2 px, `src/main/verification/visual-region.ts:158` |
| 13 | **Ten orphaned tabs** from dead sessions sit in the isolated instance — eight pointing at dead local clone ports (`http://127.0.0.1:7871/...`), one at the live storefront. They survive a stop/start, are invisible to a session-scoped census (`browser.list-tabs` → 0, `anti.browser.tabs.list` → 10) and cannot be closed by any live session (`TARGET_MISMATCH`). They did **not** block a new session's tab create after the restart/mint, so they are a tab-economy and hygiene defect, not a run blocker. | measured on instance pid 19312; scoping rule `src/main/tools/browser-control-port.ts:2175-2181` |
| 14 | The two settle predicates disagree: `settleAndMeasure` computes `settled` **without** `fontsSettled` and derives `timedOut` from it, while `requireDoubleSettledMetrics` requires fonts as well — so a font failure reports `settled: true, timedOut: false` while the gate that throws blames the composite, and the throw prints only counts. | `.canary/tools/canary-settle.mjs:184` vs `:241`; history line `:246` |

Facts 1–4 and 14 are the live blocker (a predicate that cannot be satisfied and cannot say why); facts 5–7 and 10–13 are trust and hygiene defects; only fact 12 is a fidelity difference, and it is stale. The campaign has been failing to measure, not failing to match.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | The settle contract can settle a live storefront, states which predicate failed when it cannot, and never again reports a harness refusal as a page verdict | P0 |
| 2 | Every verdict carries the bundle identity **minted at that page's build** and the instance (pid, run, attempt) that produced it; a verdict against an unidentified or drifted target cannot be written, and process exit status reflects runner success only — an adjudicable FAIL is valid output | P0 |
| 3 | All render cases are re-produced against the bundle that invocation builds, with one canonical verdict and cause per case | P0 |
| 4 | One cumulative report publishes exactly one final verdict, and the downstream acceptance owner receives the evidence path plus the measured mask/drift findings | P1 |

## Constraints

- Reference remains the live storefront at capture time; no synthetic substitute, no screenshot editing.
- Do not increase timeouts, weaken fidelity assertions, add auto-drain+retry, or reduce the `2%` target to manufacture a verdict. A capture that cannot settle is reported as such.
- The settle change may only replace a proxy predicate with a direct measurement of the same invariant (the compared state must be stable across passes); it must not relax the two-consecutive-pass requirement or accept an unstable state.
- Full-page evidence never falls back to viewport-only capture; no truncated or corrupt PNG bytes; a document taller than the 16384 px ceiling is refused, never silently cropped.
- Header, navigation, hero, grids, article content, footer and whole-page geometry stay unmasked and structurally measurable.
- `readRenderSurface` remains the only source of capture geometry; a capture must never fabricate geometry.
- `.canary/run1/` and `.canary/run2/` stay byte-for-byte untouched. The campaign rebuilds bundles only under `.canary/15-pages/<page>/clone/`.
- Tab economy: two tabs per page (reference + clone), created sequentially and closed in the page's `finally`; no `--keep-tabs`; no per-viewport reference tabs; the run leaves the instance as it found it.
- Every mutating bridge call runs against the pinned isolated instance, never the user's instance on 20130. Instance ownership is single-writer: the launcher owns `.canary/state/canary-instance.json`, the mint validates it before use, and a stale or unverifiable record fails closed rather than guessing an owner.
- Do not touch state outside this repository on the user's machine.

## Non-Goals

- Do not re-architect the clone generator, the asset localizer, or the compare transport. Narrow, testable transformations only.
- Do not "fix" the persisted `CSS capture size mismatch` cause: the current comparator cannot produce it (fact 6). Re-measure first; chase only what reproduces.
- Do not chase the 5 known 1440 structural deltas until the measurement path yields real numbers against the bundle that invocation builds.
- Do not adopt banded/sectional crops as a substitute for full-page proof (Open Decision 3).
- Do not claim the downstream plan's acceptance. Its masks-active, homepage-scoped criteria remain its own (see "Relationship to existing plans").

## Phases

| # | Phase | Status | Effort |
|---|-------|--------|--------|
| 1 | [Evidence Provenance & Freshness Gate](./phase-01-evidence-provenance-and-freshness-gate.md) | Pending | 3h |
| 2 | [Capture-Side Blockers](./phase-02-capture-side-blockers.md) | Pending | 8h |
| 3 | [Campaign Re-Run & Verdicts](./phase-03-campaign-re-run-and-verdicts.md) | Pending | 3h |
| 4 | [Gate Reconciliation & Delivery](./phase-04-gate-reconciliation-and-delivery.md) | Pending | 4h |

## Relationship to existing plans (proposal, not yet wired)

`plans/260908-1223-independent-html-clone-and-fidelity-pipeline/phase-04` owns the acceptance this work produces evidence for: `<2.0%` at 1440 **with default storefront masks active**, its mobile alternative `375px / 390px`, and `allowHeightDrift` / `heightTolerance` handling. This plan's binding policy is masks **off**, its campaign is 15 pages rather than the homepage, and it explicitly does not promise a `PASS` — so it cannot by itself satisfy that acceptance, and it does not claim to. What it produces for that phase is: a trustworthy evidence path, a masks-on sensitivity table, and measured height-drift behaviour.

Their frontmatter is deliberately **not** mutated by this plan: an unapproved plan must not become a dependency of an approved one. When this plan is accepted, the intended relation is `260908-1223… blockedBy 260910-2008…`, and Phase 4 of this plan updates that phase's success criteria instead of claiming completion on its behalf.

`plans/260909-1721-restore-visual-fidelity-canary` owns the homepage canary whose sixteen-section report contract and gate precedence this plan reuses.

## Success Criteria

- [ ] A reference tab on the live storefront reaches two consecutive matching settled passes, or the failure records the exact predicate and its measurement.
- [ ] Every case carries verdict, cause code, the build-time-minted bundle identity, instance pid, run/attempt ids, and both sides' measured capture geometry.
- [ ] A served entry that differs from the minted identity is refused; a post-build on-disk change is reported as drift and does not rewrite the recorded identity.
- [ ] Every case is adjudicable (`PASS`, or `FAIL` with a deterministic cause), except cases whose document exceeds the 16384 px CDP ceiling: those are counted and reported as typed platform refusals, excluded from the comparison set explicitly rather than quietly.
- [ ] No case is INCONCLUSIVE because of a harness-side settle or capture defect.
- [ ] The runner exits non-zero only for runner error, incomplete requested cases, or an evidence/provenance refusal; adjudicable FAILs are published while the process exits `0`.
- [ ] The 390 tier runs from a real mobile bundle, or its absence is a typed refusal that cannot read as a page failure.
- [ ] `.canary/15-pages/` publishes one cumulative report with exactly one final verdict, generated deterministically from persisted evidence.
- [ ] `plans/260908-1223-.../phase-04` cites the new evidence path, and the mask, height-drift and viewport policies are stated with measurements — without marking that phase complete.

## Open Decisions (need a ruling before Phase 2 completes)

1. **Settle predicate and dynamic content.** The live storefront mutates nodes every ~1 s while its geometry is stable. Two things must be ruled together, because one alone is unsound. (a) The gate: `domQuiet` (raw churn) becomes recorded evidence, and `renderStateStable` becomes the deciding gate — equality across consecutive passes of a **content-sensitive fingerprint** (section and card counts, document height, image count and pending/broken counts, the image set with identity and rendered rect, and a visible-text fingerprint). Counts and rectangles alone are insufficient: `SETTLE_VISUAL_EXPR` is rectangle-only, `requireDoubleSettledMetrics` compares only section and card counts, and the rasterization gate compares only capture heights, so an equal-geometry image/text/carousel swap passes all three. (b) The dynamic content: `anti.media.freeze` is called with `normalizeSliders:false`, so auto-rotating widgets keep changing content. Recommended: extend the freeze so rotating widgets are frozen before capture, and refuse any page where content cannot be shown stable with a typed `DYNAMIC_CONTENT_UNCONTROLLED` instead of admitting it on a rectangle-only comparison. Two consecutive passes remain mandatory, every component is persisted, and the current predicate inconsistency (`settleAndMeasure:184` omits `fontsSettled`, which `requireDoubleSettledMetrics:241` requires) is fixed first.
2. **Mask policy.** The canary runs `useDefaultWidgetMasks:false` and FAILs on implicit masks; the downstream plan requires default masks active. Recommended: keep masks-off binding and add a masks-ON sensitivity pass reported side by side, so a mask can never hide a difference.
3. **Documents beyond the CDP ceiling.** Pages 13 and 15 exceed 16384 px. Recommended: typed refusal plus a separately labelled banded evidence mode that is never claimed as full-page proof.
4. **The 1024 viewport.** Not required by the downstream acceptance. Recommended: keep it (this is where the ceiling and geometry defects surface first).
5. **Mobile bundle ownership.** Nothing produces `clone/mobile/index.html` for the campaign. Recommended: the campaign dumps `reference/reference-mobile.html` at 390 and builds the mobile bundle, as `canary-run.mjs` already does for run3.
6. **Clearing the ten orphaned tabs.** They do not block runs (fact 13), so clearance is a tab-economy action, not a prerequisite gate. Nine of the ten point at campaign or reference URLs (`http://127.0.0.1:7871/...`); the tenth is `http://127.0.0.1:48922/`, which is not attributable to this campaign — an isolated profile is not proof of ownership, so that tab is inspected before anything is closed. Recommended: the owner closes the attributable tabs in the isolated instance's window; deleting that instance's persisted state is an alternative that needs explicit approval because it lies outside this repository. There is no privileged close parameter, and probing for one stops here; an automated cleanup would be a product change, and session scoping must not be weakened to make it convenient.

## Risks

| Risk | Mitigation |
|---|---|
| The campaign's 30–45 min full run exceeds a session | Phase 3 is resumable per page via `--pages`; the canonical index is written per page, not only at the end |
| A settle change is mistaken for tolerance loosening | The invariant is stated in Constraints and re-asserted by tests: churn is admitted only while the structural metrics are equal across consecutive passes, and the double-pass rule is untouched |
| A "fix" relaxes policy to force PASS | Timeout inflation, tolerance reduction and auto-retry stay forbidden; the `2%` target and `INCONCLUSIVE`-precedence rules stay untouched |
| The isolated instance contaminates the user's runtime | Dedicated `ANTIFAN_USER_DATA`, bridge 20131, a pinned instance pid, no writes outside the repo |
| Ten orphaned tabs hold the instance's tab count and cannot be closed by a session (observed) | Phase 1 records both tab censuses per run; clearance is an owner action, and session scoping is never weakened to clear them |
