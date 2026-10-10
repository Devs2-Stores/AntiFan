# Phase 5 Report: suite audit fixes + 20-iteration engine optimisation loop

**Status: done with one measured miss and two threshold limits (listed under "Known gaps").**
All work ran in a git worktree (`E:/Work/scratch/vqa-loop/wt`) whose first commit `a23a96ae`
snapshots the uncommitted main working tree. Results were copied back into the main working tree
after its 47 dirty files were confirmed byte-identical to the pre-loop fingerprint. The running
AntiFan instance was never restarted, refreshed or recompiled; every Electron run was a separate
instance through `node scripts/run-electron.cjs`.

## Pre-loop fixes (suite audit `plans/reports/261010-visual-qa-suite-audit-ultra.md`)

Commits `25f83b2b`, `f1e7fb7a` in the worktree:

| Finding | Change |
|---|---|
| F1, F2, F7, F10 | `test/unit/theme-qa-fail-closed-adjudication.test.ts`: unmeasured scan or eval throw → gap + `INCONCLUSIVE`; critical with a truncated scan → `FAIL`; an integrity critical appears in every report field; warnings only → `checklist.layout === true`, `PASS`. |
| F3, F8 | `test/e2e/visual-qa-fixtures-probe.cjs`: a defect is asserted only on `expect.viewports` (default mobile), other viewports print `info` and are not counted as passes; a control is asserted on both viewports for 0 criticals and 0 warnings unless `allowWarning`. |
| F4, F5, F6, F9 | `test/fixtures/visual-qa/fixtures.cjs`: fixture 11 tightened to `sticky-obstruction`; new 25 (icon controls stacked), 26 (zero-size CTA), 27 (peek carousel control). |
| F11 | Probe reaps its userData/esbuild temp dirs after Electron exits; the unit test removes its bundle dir. |
| F12 | `test/main/layout-overflow-engine.test.ts`: a measured clean page reports `hasOverflow === false`; the probe also fails a control with document overflow unless `allowOverflow`. |
| holdout h09 | Control overflowed on mobile because a flex item lacked `min-width:0`; markup fixed. |

## Loop protocol

- Metric: defect rows caught over ground-truth-labelled rows on the dev corpora (`fixtures`,
  `holdout`, `holdout-2`; plus `holdout-4` from iteration 9r). Ground truth for desktop rows was
  labelled by a subagent that never read the engine.
- Guard: every control row 0 criticals / 0 warnings, 0 evidence gaps, no lane crash, and the
  24-page live probe at 0 criticals. An iteration is kept only when the metric does not drop and the
  guard passes.
- `holdout-3` (12 defects, 8 controls, authored blind before the loop) stayed untouched until the
  loop closed.
- Each new exemption was pinned by a control fixture that is red without the exemption and green
  with it.

## Iterations

| Iter | Commit | Metric | Kept | Change |
|---|---|---|---|---|
| 0 | `f1e7fb7a` | 50/60 | baseline | holdout-3 mobile 6/12, controls 8/8 clean |
| 1 | `e5ffa80b` | 51 | no | end-of-page bottom-bar rule; 24 live FP (show/hide-on-scroll bar) |
| 2 | `00b9dc3e` | 51 | yes | iter 1 + skip bars that transition visibility/opacity/position; control 28 |
| 3 | `a83c7f5a` | 52 | yes | own absolute offset parks a control only past the left/top edge |
| 4 | `3c996db0` | 52 | no | control-over-control cover relabelled overlap: no gain, reverted |
| 5 | `bbcb801e` | 53 | yes | control clipped past the trailing edge of a box → offscreen; control 29 |
| 6 | `3deef9cc` | 55 | no | stacked-control threshold 0.5 → 0.25; guard FAIL (control 17, 4 live crit) |
| 7 | `f1ec23a2` | 55 | yes | iter 6 + visible-fragment geometry + pending-image skip; control 31 |
| 8 | `7671eb0e` | 56/59 | yes | bar-covered bands (top bar at load, bottom bar at end); control 32; h04 desktop relabelled by geometry |
| 9 | `fcacf098` | 57/59 | yes | single-shift jump ≥ 25% of viewport → warning |
| 9r | `fcacf098` | 71/82 | rebase | blind holdout-4 (16 defects, 10 controls) added to the dev set |
| 10 | `75f047a0` | 72/82 | yes | burst travel: net move across entries < 1 s apart |
| 11 | `51cf1df5` | 73/82 | yes | `hadRecentInput` excused only after a `first-input` entry |
| 12 | `de1cc745` | 75/82 | yes | absolute control inside a field is designed only while off the painted value; control 33 |
| 13 | `a94a368b` | 77/82 | yes | field value joins text-over-text as a run; control 34 |
| 14 | `047741bb` | 78/82 | yes | trailing-edge rule widened to "less than half in view", ellipsis exempt; control 35 |
| 15 | `3333e7b7` | 79/82 | yes | text in one fixed layer painted over by another fixed layer; control 36 |
| 16 | `72ae0476` | 79/82 | no | box too short for its lines; guard FAIL (y03/y05 flooded by fixed-height titles) |
| 17 | `eec007cb` | 81/82 | yes | iter 16 minus title boxes; control 38 |
| 18 | `213d4a2a` | 82/82 | yes | opaque viewport-spanning fixed layer with no way out → one occlusion; controls 39, 40 |
| 19 | `c7e8cf52` | 82/82 | yes | gate answers (age check, consent) count as a way out; controls 41, 42 |
| 20 | `2ffa51cf` | 84/84 | yes | title-clamp exemption limited to repeated titles; fixture 43 (PDP h1 cut) |

Full notes per iteration: `research/loop/loop-results.tsv`.

## Close-out measurements (final engine `2ffa51cf`)

- Dev corpora: 84/84 defect rows caught, 0 control criticals, 0 gaps, slowest scan 377 ms.
- Main working tree, `npm run test:visual-qa` lanes:
  - `fixtures.cjs` → `SUMMARY pass=67 info=21 fail=0`
  - `holdout.cjs` → `SUMMARY pass=16 info=8 fail=0`
  - `holdout-2.cjs` → `SUMMARY pass=16 info=8 fail=0`
- Live probe: 24/24 measured, 0 criticals, 0 truncated, 0 failed detectors, 0 unrestored scroll,
  slowest 362 ms, largest page 7160 elements; warnings `zero-size` 31, `layout-shift` 7.
- Reserved holdout-3, mobile: 6/12 at iteration 0 → 9/12 (gained x03, x04 clipping, x09 offscreen);
  0 criticals on its 8 controls at both viewports. Rows: `research/loop/holdout-3-iter20-rows.json`.
- `npx tsc -p ./ --noEmit` exit 0; `node --test test/unit/layout-integrity-engine.test.mjs` 6/6;
  `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts test/main/layout-overflow-engine.test.ts` 42/42.

Mutant run (`research/loop/close-mutants.cjs`, lanes fixtures/holdout/holdout-2):

| Mutant | Lane exits | Result |
|---|---|---|
| identity | 0/0/0 | clean |
| overlap silenced | 1/1/1 | killed (9 rows) |
| clipping silenced | 1/1/1 | killed (8) |
| occlusion silenced | 1/1/0 | killed (4) |
| offscreen silenced | 1/1/1 | killed (4) |
| zero-size silenced | 1/0/0 | killed (1) |
| sticky-obstruction silenced | 1/1/1 | killed (3) |
| layout-shift silenced | 1/0/0 | killed (1) |
| every critical downgraded to warning | 1/1/1 | killed (30) |

## Known gaps

Holdout-3 misses, checked against rendered geometry (`h3-diag-scan*.js` dumps):

- x05 (coupon modal over the buy button): modal top y=447, button bottom y=387 at 375×667. The
  labelled defect does not render.
- x08 (bottom bar over the footer): bar top y=595, footer bottom y=403 on a 419 px page. The
  labelled defect does not render.
- x06 (chat bubble over the checkout button): genuine miss. The fixed Zalo bubble covers the right
  54 px (16%) of a fixed checkout button without touching its label.

Threshold limits by design: a fixed bar covering less than a third of a line height is not reported;
a repeated title (same tag and class painted ≥ 2 times) cut to a fixed height is always treated as a
designed clamp.

## Evidence copied into this plan

`research/loop/`: `loop-results.tsv`, `loop-verify.mjs`, `loop-iter.mjs`, `close-mutants.cjs`,
`close-mutants-summary.json`, `holdout-3.cjs`, `holdout-3-MANIFEST.md`,
`holdout-3-iter20-rows.json`, `holdout-4.cjs`, `holdout-4-ground-truth.json`,
`dev-ground-truth.json`. The scripts reference `E:/Work/scratch/vqa-loop` paths and are kept as a
record, not as runnable tools.
