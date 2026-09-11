---
phase: 3
title: "Campaign Re-Run & Verdicts"
status: complete
priority: P0
effort: "3h"
dependencies: ["phase-01-evidence-provenance-and-freshness-gate", "phase-02-capture-side-blockers"]
---

# Phase 3: Campaign Re-Run & Verdicts

## Overview

Re-produce every render case against the bundle that invocation builds, with the build-time identity carried into every verdict and the capture-side blockers resolved, so the campaign finally reports what it measured instead of what the harness failed to measure. The runner already rebuilds both sides unconditionally (`dump-ref.mjs` + `build-clone.mjs` at stages 6/9), so a full run refreshes the bundles and the evidence together — and Phase 1 makes that pairing provable by minting the identity over the immutable attempt directory the run then serves, under the run lock.

## Requirements

- All 15 pages × 3 viewports carry a canonical verdict from Phase 1's index; any case that cannot be produced carries a typed, declared reason (never a placeholder number).
- Every case carries the identity minted at that page's build, copied — never re-derived — into the viewport document, the run document and the index.
- Tab economy is respected and observable, in two separate scopes:
  - **session scope:** two tabs per page (reference + clone), created sequentially, closed in the page's `finally`; at most three live at once; no `--keep-tabs`; after the run the session owns only its primary tab.
  - **instance plane:** the orphan IDs and count after the run equal the recorded baseline exactly. Pre-existing orphans (ten were measured on 2026-09-10) are expected and permitted; tabs this run created and closed leave no trace, so a delta of any kind — still open or newly orphaned — is a defect to fix before continuing.
- The run is resumable per page: `node .canary/tools/fifteen-pages-run.mjs --pages <n>` or `--pages <a>-<b>`; the canonical index is updated after each page.
- Bundle rebuilds write only inside the page's own attempt directory (`.canary/15-pages/<page>/attempts/<attemptId>/clone/` and `…/clone/mobile/`), the one Phase 1 served and minted over; the legacy `<page>/clone/` and `<page>/evidence/` are read-only history, and `.canary/run1/`, `.canary/run2/` and `.canary/run3/` are never touched. The mobile bundle producer is Phase 2's B2; until it exists, a 390 case is refused with the typed `MOBILE_BUNDLE_ABSENT` and the run exits non-zero as an incomplete batch.
- Wall-time expectation is measured, not guessed: ~95 s mean per page (page-01 322 s outlier, pages 12–15 174–219 s), 30–45 min for the full set, plus live refetches.
- No capture-side INCONCLUSIVE survives: any case still blocked is blocked by the reference content, the clone content, or a declared impossibility — each with a cause code.
- The process exits non-zero only for runner error, an incomplete set of requested cases, or an evidence/provenance refusal. An adjudicable fidelity FAIL is published and the process exits `0`.

## Prerequisites

- The application code under test is current: `.compiled` corresponds to the working tree, with `npm run compile` run beforehand otherwise (the recorded instance environment lists compile as the first restart step) — a fresh run against stale application code cannot validate the capture pipeline.
- Isolated instance started from the recorded environment (`.canary/state/instance-env.json`, an operator-supplied template — what was actually used is recorded by the launcher in the instance record): `node scripts/run-electron.cjs . --allow-eval` with `ANTIFAN_BRIDGE_PORT=20131`, `ANTIFAN_USER_DATA=E:/Work/.antifan-canary`, project/workspace ids as recorded; ready on port 20131.
- The instance record is authoritative: `.canary/state/canary-instance.json` was written by the launcher for this instance, its `instancePid` owns port 20131, and the session was minted from it (Phase 1 owns both the protocol and the staleness refusal).
- Fresh session minted after that start, and one cheap RPC exercised before the run (`anti.browser.tabs.list`) to prove the transport, lease and tab plane are live. Persisted session and bootstrap files are runtime state, not prerequisites: no geometry, quota or provenance conclusion may be drawn from a session file whose port has no listener.
- The instance-plane tab census baseline (IDs and count) is recorded after the mint. Ten orphans from dead sessions were measured on 2026-09-10 and survive a restart; they do not block a run, so clearing them is an owner action for tab economy (Open Decision 6), not a gate — the run must add none of its own.
- `ANTIFAN_BRIDGE_PID` pinned to the isolated instance (the `instancePid` recorded by `scripts/run-electron.cjs` and validated by the session mint) so a dropped socket cannot heal onto the user's instance on 20130.
- The run lock is free: a live holder of `.canary/15-pages/.campaign.lock` refuses the run with `RUN_IN_PROGRESS` instead of sharing the index, a stale file left by a hard kill is reclaimed when its recorded holder is dead, and the run releases its own lock on controlled exits.
- Ports 7861–7875 free; `node` on PATH.

## Implementation Steps

1. Verify and record the prerequisites (compiled tree, instance pid, session lease, port census, tab baseline) in the run provenance.
2. Run the campaign page by page, starting with one page to confirm the pipeline end to end, then the full range.
3. After each page: read `evidence/summary.json`, update `_verdicts.json`, and compare both tab scopes against the baseline. A new tab in the instance plane, or an extra session-owned tab, is a defect to fix before continuing; a session cannot close a tab it does not manage (`TARGET_MISMATCH`), so the run must never create one it cannot close, and pre-existing orphans are counted and reported rather than chased mid-run.
4. When a case fails for a harness reason, stop and fix the harness; never continue past a capture-side INCONCLUSIVE. The point of this plan is to stop reporting those as fidelity results.
5. For each page taller than the CDP ceiling, record the typed refusal and the declared alternative from Open Decision 3 — never a crop.
6. Publish, then finish: write the run's aggregate under `.canary/15-pages/reports/<runId>/`, then re-point `.canary/15-pages/current-report.json` at it (temp-file → `fsync` → `rename`) and regenerate the root `15-PAGE-HOPLONGTECH-CLONE-CANARY.md` from that run-scoped directory, so the tracked report is a copy of a retained artifact rather than an in-place overwrite. Finish with the tab-baseline assertion, the per-page wall times, and the index/provenance consistency check.

## Todo

- [ ] Verify and record prerequisites (compile, instance, session, pin, ports, tab baseline)
- [ ] Re-run one page end to end and audit its evidence and provenance
- [ ] Re-run the full 15-page × 3-viewport campaign
- [ ] Update `_verdicts.json` per page and assert both tab scopes against the baseline
- [ ] Record every remaining INCONCLUSIVE with a typed, non-harness cause
- [ ] Record the wall-time and tab-budget observations

## Verification

- `node .canary/tools/fifteen-pages-run.mjs --pages 1-15` completes and prints per-page verdicts.
- `.canary/15-pages/_verdicts.json` holds one entry per page × viewport, each with `verdict`, `causeCode`, `bundle.entrySha256`, `instance.pid`, and measured geometry for both sides.
- Every `bundle.entrySha256` in the index is the identity minted at that page's build (carried, not re-derived); an on-disk change after the build is reported as `BUNDLE_DRIFT_AFTER_BUILD` and does not rewrite the recorded identity.
- Instance-plane tab IDs and count after the run equal the recorded baseline; the session owns only its primary tab.
- The published report is reproducible: `.canary/15-pages/current-report.json` names a run whose directory under `.canary/15-pages/reports/<runId>/` holds the aggregate, and regenerating the root `15-PAGE-HOPLONGTECH-CLONE-CANARY.md` from that directory reproduces it byte-for-byte.
- A batch that produced fewer cases than requested exits non-zero; a run whose only failures are adjudicable fidelity FAILs exits `0` and reports them.

## Success Criteria

- [ ] 45/45 cases adjudicable, or a typed declared reason for each exception — cases whose document exceeds the 16384 px CDP ceiling counted and reported as typed platform refusals, explicitly excluded from the comparison set rather than silently.
- [ ] Zero cases whose INCONCLUSIVE cause is a harness-side capture defect.
- [ ] Instance-plane orphans after the run equal the recorded baseline IDs and count; the run adds no tab it cannot close, and the session owns only its primary tab at the end.
- [ ] Every verdict carries the bundle identity minted at build time, and no verdict was written after a `BUNDLE_IDENTITY_MISMATCH` or drift refusal.

## Rollback

Per-page artifacts are preserved by construction: each page's bundle, evidence and index entry live inside that attempt directory, they are never rewritten, and the page keeps the current plus the previous attempt — so the previous measurement of a page remains restorable, and because the published view is a manifest pointer (`<page>/current-attempt.json`) rewritten by temp-file → `rename`, an attempt that crashes mid-write leaves the previous pointer, and therefore the previous published evidence, intact. The run-scoped aggregate is written under `.canary/15-pages/reports/<runId>/` and published through `.canary/15-pages/current-report.json`, so an earlier run's report is re-published by pointing at it again rather than regenerating it. Two artifacts predate this guarantee and were overwritten by the bounded probe of 2026-09-10: the root aggregate `15-PAGE-HOPLONGTECH-CLONE-CANARY.md`, restored byte-identically from `.canary/state/report-backup-before-probe.md` (the probe's own report remains at `.canary/state/report-after-probe-20260910.md`), and `page-02-brands/evidence/summary.json`, replaced by the blocked result with **no backup** — no rerun can reproduce the superseded summary deterministically, and its prior per-viewport verdicts survive only in the untouched `run-*.json` files (mtime 11:57).

## Outcome (2026-09-11)

15 of 15 pages and 45 of 45 render cases are published, assembled from each page's own attempt pointer
by `fifteen-pages-run.mjs --aggregate-only`. Aggregate report
`.canary/15-pages/reports/aggregate-2ff9410db21aa06d/15-PAGE-HOPLONGTECH-CLONE-CANARY.md`, verdict
`FAIL`, `PASS: 8 | FAIL: 17 | INCONCLUSIVE: 20`; regeneration over unchanged evidence is byte-identical.
Journal: `plans/journals/2026-09-11-campaign-phase-4-aggregate-and-drift.md`.

The two blockers this phase inherited were resolved before the dataset was produced: the clone's
1425px page area at 1440 (`LAYOUT_WIDTH_ASYMMETRY` is now a typed refusal, and both tabs get the same
scrollbar regime before measurement) and the carousel phase manipulation that was a mask in disguise
(phase is detected, disagreement withholds as `WIDGET_PHASE_MISMATCH`). Measured after that: page 3 at
1440 went from 4.59% to 0.08%, page 1 at 1024 from 8.65% to 0.04%.

Open mechanism this phase cannot close: at 390 the reference declares a web layout while the clone
serves a mobile one, and the clone's own mobile document truncates (4543–4545px against the 9843px dump
it was built from, `news` section absent, five `block-category` sections at h=341 against the
reference's h=1401). The strict reference-identity verdict for those legs stands.

Attribution closed the same day: the three retained page-3 clone bundles are byte-different only in the
site's own Livewire instance ids (26 lines of 1,772), while b2 and b3 have *identical* geometry and b1b
differs by +15px at 1024 and +10px at 390. Only the 1024 delta is a gutter: `attempt-d206677e` records
the reference at `clientWidth` 1024 and the clone at 1009 — 15px narrower and 15px taller (2766 → 2781).
At 390 the widths are symmetric (390 on both sides) and the clone differs by a second `widgetNodes`
entry, so that delta is a clone-side rendering difference, not attributed. So the PASS/FAIL flips tracked
the per-side gutter and the pin era, not run noise or the bundle; after the regime was made symmetric and
the pin reverted, page 3 returns PASS 0.08%, reproducing batch 1b. Table and categories in
`plans/journals/2026-09-11-campaign-phase-3-gates-and-attribution.md`.

## Disclosed methodology limit: the symmetric scrollbar regime is `none` on both sides

The published dataset was captured with `SCROLLBAR_REGIME_CSS = html{scrollbar-width:none}
html::-webkit-scrollbar{display:none}` applied to both tabs, and that is a methodology choice
that has to be read with the evidence, not as neutral.

Measured on the retained page-3 bundle: the clone's own stylesheets carry scrollbar rules only for
inner elements — `.category-navigation__list ul::-webkit-scrollbar`, `.search-popular::-webkit-scrollbar`,
`.filter-list__button ...`, `.view-list .list .column-scroll::-webkit-scrollbar{display:none}` — and
**none for `html` or `body`**. So the clone's 15px root gutter (`clientWidth 1425` against
`innerWidth 1440`) was the browser's default, i.e. what a real user sees, while the reference measured
`clientWidth == innerWidth == 1440` with a still-scrollable document — the signature of a root that is
overflow-hidden or scroll-locked at measure time, which is the anomaly.

Consequences, stated plainly:

- Forcing `none` on both sides removes a reference-side artifact, so no FAIL is fabricated by it: the
  differences it removed were the reference's own state, not a clone defect.
- But it compares under a gutter regime no real user gets, and it **neutralizes the detection it was
  meant to complement**: `applyScrollbarRegime` runs before the identity is captured
  (`viewport-run.mjs:734-735`, `evidence.tabIdentity` at `:764`), so `LAYOUT_WIDTH_ASYMMETRY` at `:800`
  compares two post-regime widths and cannot fire while the regime is on. The refusal count dropping
  from four to zero in the authoritative run is therefore the detector being blinded, **not** evidence
  that the asymmetry was resolved. Correction to an earlier draft of this section, which said the
  per-case width readings let a reader see the choice: they do not. The published cases record
  `clientWidth == innerWidth` on both sides by construction (page-01 1440: 1440/1440; 1024: 1024/1024),
  and `evidence.scrollbarRegime` carries only the injected `css`. The as-found state survives only in
  pre-regime attempts: 15 asymmetric pairs across 8 pages (2, 3, 4, 9, 10, 11, 13, 14), always the
  reference at 1440/1024 with no gutter and the clone at 1425/1009 with one, and never on page 1 — which
  is why page 1 passed while its neighbours refused, i.e. it is a per-page reference state (a scroll-locked
  or overlay-covered root), not a run-wide browser setting.
- The faithful normalization is `html{overflow-y:scroll;scrollbar-gutter:stable}` on both, applied
  before either side is materialized and measured, with the identity floor re-measured afterwards.
  That is a change to the child, i.e. a methodology change, so it requires all 15 pages re-run on one
  code version — it cannot be folded into the delivered set without invalidating the single-version
  property the cumulative aggregate depends on.
