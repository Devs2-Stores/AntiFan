---
title: "Visual QA geometry upgrade: text-run layout defects with a precision shield"
description: "Make theme.qa_validate FAIL on real text overlap, clipped text, covered text/CTA, horizontal overflow (and warn on CLS) without false FAILs on healthy themes."
status: done
priority: P1
effort: "2-3d"
tags: ["qa", "layout-integrity", "visual-qa", "theme-qa-workflow"]
created: 2026-10-09
---

# Visual QA geometry upgrade

## Overview

Brainstorm (2026-10-09, `ak:brainstorm --advice`) measured the layout scanners in real Chromium
(Electron 43) on 20 synthetic pages (15 defects, 5 healthy controls) at 375×667 and 1440×900, and
on 24 live pages (4 public Haravan stores × home / product / collection × 375 / 1440).

| Scanner | Defect fixtures caught at 375 | Controls with a critical | Live pages with a critical | Slowest scan |
|---|---|---|---|---|
| Current `LayoutIntegrityEngine` (working copy) | 2 / 14 (09, 13a) | 3 / 5 (12: 7, 17: 1, 19: 1) | 13 / 24 (306 criticals: zero-size 171, offscreen 100, clipping 35; every hand-checked one a false positive) | — |
| Reference prototype `research/visual-qa-probe/scan-v2.js` | 14 / 14 (06 and 14 as warnings by design) | 0 / 5 at both widths | 0 / 24 | 785 ms (2510 elements), 675 ms live (7268 elements), never truncated |

Fixture 01 (plain document overflow) belongs to `LayoutOverflowEngine`, which already catches it.
Ablation (`run-v2.cjs --no-exempt`) removes the read-more, x-scroller and running-animation
exemptions and turns controls 17, 18 and 19 into false FAILs, so each exemption is load-bearing.
Live recall is unknown: none of the 24 pages has a hand-confirmed real defect.

Root causes, cited against the working copy (HEAD `920dd0fc` plus an uncommitted 55-line edit to
`src/main/qa/scanners/layout-integrity-engine.ts`; file is that engine unless stated):

| # | Cause | Location | Fixed in |
|---|-------|----------|----------|
| 1 | Overlap detector skips elements deeper than 6 levels and stops at 200 candidates; compares element boxes, not text lines | `:285`, `:288`, `:323-328` | Phase 3 |
| 2 | Only the first 2000 elements are scanned, no truncation flag | `:174` | Phase 3 |
| 3 | Clipping = `scrollWidth > clientWidth + 2` on the element itself, no line-clamp / ellipsis exemption | `:253-254` | Phase 3 |
| 4 | Offscreen / zero-size flags closed drawers and carousel slides as critical | `:176-231` | Phase 3 |
| 5 | CTA occlusion tests only the CTA center inside the first viewport | `:355-405` | Phase 3 |
| 6 | CLS observer is disconnected before buffered entries are delivered (always 0) | `:505-534` | Phase 3 |
| 7 | Per-width map looks breakpoints up by `"320"` keys while the host returns `mobile-small` keys → always `documentOverflow:false` | `src/main/qa/theme-qa-workflow.ts:893-905` vs `src/main/browser/native-tab-host.ts:15061-15067` | Phase 1 |
| 8 | `checklist.layout` ignores integrity criticals that already FAIL the verdict | `src/main/qa/theme-qa-workflow.ts:1190` | Phase 1 |
| 9 | Unit tests pin script source text; no test renders a real page | `test/unit/layout-integrity-engine.test.mjs:53-124`, `:184-223` | Phases 2, 3 |

Research evidence (durable copies inside this plan):
- `research/evidence-digest.md` — measurements of the current scanners and the first oracle.
- `research/kongming-counsel.md` — supervisor counsel from the brainstorm.
- `research/visual-qa-probe/scan-v2.js` — the reference scan Phase 3 ports (742 lines).
- `research/visual-qa-probe/fixtures.cjs` (20 pages) and `run-v2.cjs` (fixture + `--live` runner,
  `--no-exempt` ablation) — the prototype harness Phases 2 and 4 turn into permanent tools.
- Other files in `research/visual-qa-probe/` are one-off probes (CLS, live-site classifiers);
  their results are in `research/evidence-digest.md`.

## Contract

- **Outcome:** `theme.qa_validate` FAILs on text overlapping text, stacked controls, clipped text,
  covered text / covered CTA (anywhere on the page, not only the first viewport), and horizontal
  overflow on real theme markup; reports CLS > 0.1 as a warning; reports a truncated scan or a
  failed detector as an evidence gap (verdict INCONCLUSIVE, never PASS); and does not FAIL healthy
  pages that use line-clamp, ellipsis, carousels, crossfading sliders, closed drawers, read-more
  boxes, horizontal tab scrollers, marquees, 3D flip widgets, SVG icons or badges.
- **Constraints:**
  - Deterministic and offline: no vision model, no network in the verdict path.
  - Reuse `ThemeQaWorkflow` and `src/main/qa/scanners/*`; one synchronous in-page scan script;
    no new MCP server or capability.
  - Mutation/write paths stay HARD_BLOCK fail-closed (untouched).
  - Exemptions are decided by computed style and geometry. The only selector lists are the two
    the engine already has (`CAROUSEL_SLIDE`, `PLATFORM_PREVIEW_CHROME`, carried over verbatim in
    `scan-v2.js:26-27`); no others are added.
  - **The running AntiFan instance is off-limits (user directive, 2026-10-10).** No phase restarts
    or refreshes it: no GUI or daemon restart, no `refresh-host.ps1`, no `npm run compile`
    (it rewrites the `.compiled/` tree the running app loads from and stages a daemon version),
    no bare `npm test` / `npm run verify` (both run the `compile` lane). Every runtime check runs
    as a separate instance: a standalone Electron process (`node scripts/run-electron.cjs <script>`)
    with a temp `userData`, an off-screen non-focusable window, and the engines bundled from
    `src/` by esbuild into `os.tmpdir()`. Unit tests run from source with `npx tsx --test`.
- **Non-goals:** pixel/baseline diffs (`anti.visual.compare`); interaction states (hover, open
  menus); mapping findings to Liquid files; running the integrity scan at all five widths (this
  plan fixes only the width-map lookup and the unmeasured marker; a multi-width integrity sweep
  needs its own decision once this plan's precision gate holds); shipping the new engine into the
  running app (`npm run compile` + restart is the user's step after Phase 4).
- **Acceptance criteria:**
  1. `npm run test:visual-qa` exits 0: at 375 every defect fixture yields its expected kind
     (critical; warning for 06 and 14) and fixture 01 yields overflow-engine `hasOverflow: true`;
     at 375 and 1440 every control fixture (12, 16, 17, 18, 19) yields 0 criticals; every scan
     restores the scroll position; every scan finishes in ≤ 3000 ms wall time.
  2. Held-out corpus authored in Phase 4, after the port, by an agent that has not read
     `scan-v2.js` or the fixtures: 0 criticals on its 4 controls and ≥ 6 of its 8 defects caught.
  3. `npm run probe:visual-qa-live` on the 24 live pages: 0 criticals, or every remaining critical
     classified by a human as a real defect with a screenshot.
  4. Slowest `stats.durationMs` across fixtures and live pages ≤ 1200 ms.
  5. `report.findings.responsive[width].documentOverflow` matches the host sweep for every width;
     integrity counts are `null` for widths the integrity scan did not measure;
     `checklist.layout` is `false` whenever integrity criticals exist; a truncated scan or a
     failed detector adds an evidence gap and the verdict is not PASS.

## Trade-offs (recorded at brainstorm)

| Approach | Load-bearing assumption | Fails first when |
|---|---|---|
| A. Patch box detectors only | Element boxes reflect where text paints | Text spills out of its box (fixtures 04, 07) |
| B. Text-run geometry only | Line rects equal what the user sees | Live sites without exemptions: fixed layers, clamped ghost lines, 3D, SVG, carousels |
| C. Vision model verdict | Model localizes the defect | Not reproducible, needs network, no selector |
| **D. Precision shield + text-run geometry in one scan (chosen)** | Exemptions are expressible as style + geometry | A JS-driven widget with no geometric signal |

Better approaches: none beyond D — chosen over the brainstorm supervisor's class-name exemption
list because 4 live sites already produced 4 distinct naming schemes (`uv-mobile-drawer`,
`soon-flip-*`, `custom-slider`, `swiper`). The prototype is one scan rather than a shield phase
followed by a geometry phase: the exemptions are predicates inside each detector, so splitting
them would ship a detector set that is either blind or noisy in between.

## Phases

| # | Phase | Status | Depends on |
|---|-------|--------|------------|
| 1 | [Report wiring: width map, checklist](./phase-01-report-wiring.md) | Done | — |
| 2 | [Fixture corpus + real-Chromium lane (red baseline)](./phase-02-fixture-lane.md) | Done | — |
| 3 | [Port the reference scan + fail-closed scan stats](./phase-03-engine-port.md) | Done | 1, 2 |
| 4 | [Held-out corpus, live probe, pipeline lane, docs](./phase-04-validation-docs.md) | Done (2 known gaps) | 3 |
| 5 | Suite audit fixes + 20-iteration engine loop ([report](./reports/phase-05-loop-report.md)) | Done (1 miss, 2 threshold limits) | 4 |

Every phase file carries its own Failure Protocol. Stopping on a failed Verify is intended
behavior, not a stall.

## Decision log

- **2026-10-10, after Task 4.3 failed (4/8 defects caught, 0/4 controls failed;
  [phase-04-report.md](./reports/phase-04-report.md)).** User chose: fix h05 only, then measure on a
  new blind corpus. h05's cause is a detector bug: the offscreen branch treated any scroll axis on a
  clipping ancestor as reachable, and `overflow-x:hidden` computes `overflow-y:auto`, so a control
  past the right edge was skipped. The fix requires a scroll axis on the axis the control is outside
  on; fixtures `20`, `21` (defects) and `22` (control) pin it, `23` records that a body-only
  `overflow-x:hidden` still overflows on mobile (owned by `LayoutOverflowEngine`). h02 (clamp-like
  clipping), h04 (partial cover by a fixed bar) and h07 (absolute controls stacked) stay documented
  known gaps with no engine change. `holdout.cjs` is spent; `holdout-2.cjs` is authored by a fresh
  agent under the Task 4.2 brief and judged by the same rule (≥ 6/8 defects, 0/4 controls).
- **2026-10-10, holdout-2 measured on the frozen engine.** 6/8 defects caught, 0/4 controls
  failed: Task 4.3 pass condition met. Misses h03 (fixed bottom bar covering the last control at
  every scroll offset) and h06 (absolutely positioned control placed outside the viewport) are
  documented known gaps with no engine change; supervisor verdict `CLOSE_WITH_GAPS`.
- **2026-10-10, phase 5.** Suite audit `plans/reports/261010-visual-qa-suite-audit-ultra.md`
  findings F1-F12 fixed in tests and harness, then a 20-iteration optimisation loop ran in a
  separate git worktree under `kongming` checkpoints. Keep rule: metric does not drop, every
  control stays at 0 criticals, 0 evidence gaps, 24 live pages at 0 criticals. Dev metric 50/60 →
  84/84; reserved blind holdout-3 mobile 6/12 → 9/12 with 0 control criticals. All five phase-4
  known gaps are caught now (holdout h02, h04, h07; holdout-2 h03, h06: both lanes `fail=0`).
  Remaining miss x06 and two threshold limits are listed in
  [phase-05-loop-report.md](./reports/phase-05-loop-report.md) and `docs/operations.md`.

## Files touched (whole plan)

| File | Phases |
|---|---|
| `src/main/qa/theme-qa-workflow.ts` | 1, 3 |
| `src/main/qa/scanners/layout-integrity-engine.ts` | 3, 5 |
| `test/unit/theme-qa-fail-closed-adjudication.test.ts` | 1, 3, 5 |
| `test/unit/layout-integrity-engine.test.mjs` | 3, 5 |
| `test/main/layout-overflow-engine.test.ts` | 5 |
| `test/fixtures/visual-qa/fixtures.cjs` (new) | 2, 5 |
| `test/fixtures/visual-qa/holdout.cjs` (new) | 4, 5 |
| `test/fixtures/visual-qa/holdout-2.cjs` (new) | 4 |
| `test/e2e/visual-qa-fixtures-probe.cjs` (new) | 2, 4, 5 |
| `scripts/probe-visual-qa-live-sites.cjs` (new) | 4 |
| `package.json` | 2, 4 |
| `scripts/run-test-pipeline.mjs` | 4 |
| `docs/operations.md`, `CHANGELOG.md` | 4, 5 |

## Success Criteria

- [x] Acceptance criteria 1-5 above hold, each with command output attached in the phase report
  (criterion 2 on `holdout-2.cjs` after the decision above).
- [x] `npm run typecheck` exits 0.
- [x] `node scripts/check-plans.mjs` exits 0.
- [x] The running AntiFan instance was never restarted, refreshed or recompiled by this plan.

<!-- slug: visual-qa-geometry-upgrade -->
