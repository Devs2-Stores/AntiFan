# Review: pending Visual QA geometry upgrade (`ak:code-review --pending --ultra`, 2026-10-10)

Scope: uncommitted working tree on HEAD `920dd0f`. Includes `src/main/qa/scanners/layout-integrity-engine.ts`, `src/main/qa/theme-qa-workflow.ts`, `test/unit/layout-integrity-engine.test.mjs`, `test/unit/theme-qa-fail-closed-adjudication.test.ts`, `package.json`, `scripts/run-test-pipeline.mjs`, `docs/operations.md`, `CHANGELOG.md`, and the new `test/e2e/visual-qa-fixtures-probe.cjs`, `test/fixtures/visual-qa/*`, `scripts/probe-visual-qa-live-sites.cjs`.
Plan: `plans/261009-1609-visual-qa-geometry-upgrade/plan.md`.

**Verdict: APPROVE_WITH_FIXES.** One HIGH false-negative in the full-page occlusion sweep and one LOW telemetry defect. No false-positive path was found.

## Stage 1: spec compliance

The plan outcome and constraints are met as written, with one gap: the Outcome clause "covered text / covered CTA (anywhere on the page, not only the first viewport)" does not hold for content inside a `position: sticky` subtree below the first viewport. That gap is finding 1 below. The verdict gating (`checkParticipates('layout')`, `:1273`) and the evidence-gap axes match the plan.

## Findings

### 1. HIGH: sticky content below the first viewport is never checked for occlusion (introduced)

- `src/main/qa/scanners/layout-integrity-engine.ts:173-177`: `layerOf` returns the nearest `fixed` **or** `sticky` ancestor.
- `:656` (text) and `:661` (controls) set `fixed: true` for any target with a layer, so sticky targets get it too.
- `:699-703`: at step 0, a target below the viewport is skipped.
- `:698`: at step 1 and later, `if (tg.fixed && s > 0) { done.add(t); continue; }` retires the target without ever sampling it.
- Reproduction (real Chromium, current `src/` bundled by the harness): `npm run test:visual-qa -- --corpus=E:/Work/scratch/visual-qa-probe/sticky-corpus.cjs`. Every placement uses the same CTA, covered by an opaque sibling:
  ```
  mobile s1-sticky-below-fold FAIL crit=0 warn=0     (position:sticky, after a 1200px spacer)
  mobile s2-relative-below-fold PASS crit=1 warn=0   (position:relative, same place)
  mobile s3-sticky-first-screen PASS crit=1 warn=0   (position:sticky, top of page)
  SUMMARY pass=5 fail=1   EXIT=1
  ```
- Coverage: no fixture in `fixtures.cjs`, `holdout.cjs` or `holdout-2.cjs` places a sticky subtree below the first viewport. Fixture 10 is in-flow, fixture 11 and holdout-2 h03 are `fixed`, and holdout h12 is a sticky header at the top. All three corpora were blind to this case.
- Fix direction: set `fixed` from `fixedLayerOf` only, so sticky targets scroll with the flow and get sampled at the first step that brings them fully into view. Caveat: a sticky box is at its natural position only until it reaches its `top`/`bottom` threshold. A target sampled while stuck uses stale coordinates, so the sampled rect must be re-read, or the target sampled where its natural position is in view. Regression: add the `s1` page to `test/fixtures/visual-qa/fixtures.cjs` with `expect: { kinds: ['occlusion'] }`. It is red now and turns green after the fix. Fixture 11 and holdout h12 must stay green.

### 2. LOW: the per-width responsive map drops `sticky-obstruction`, and one term is dead

- `src/main/qa/theme-qa-workflow.ts:920`: `criticalOcclusion` counts only `'occlusion'`. Critical `sticky-obstruction` findings (engine `:746-747`) are counted in no bucket. This predates the change (HEAD `:903`).
- `:921`: `+ countKind('zero-size')` is always 0, because the engine now emits `zero-size` only as `warning` (`:337`). HEAD emitted it as `critical`. The downgrade came with this change, so the dead term was introduced by it.
- Impact: telemetry only. Nothing in `src`, `test`, `docs` or `scripts` reads `responsive[*].critical*`. `summary.criticalCount` (`:1293`) and `checklist.layout` (`:1207`) read `integrityCriticals`, which includes sticky-obstruction.
- Fix direction: drop the dead term. Either count `sticky-obstruction` in `criticalOcclusion`, or document that the map leaves it out.

## Rejected or adjudicated before this run

The adjudication in `local://cr-ultra-packet.md` stands. F1 (`measured:false` nested under the findings-array check) and F3 (a viewport width outside the five standard widths reports `null` counts) were already kept by design in `reports/phase-04-report.md` of the plan.

## Verification run by this review

- Sticky reproduction above: exit 1 on the current engine, and the cause is isolated by the two controls.
- Source citations re-read in the working tree. Provenance checked against HEAD copies of both files.

## Ultra appendix

- Candidates: 5/5 usable, so no re-dispatch was needed. 3 returned no findings. 2 raised finding 1 independently, and 1 of those 2 also raised finding 2.
- Finalizer: a kongming verifier evidence-validated the union and kept both findings (finding 1 HIGH, finding 2 LOW). The controller then re-verified finding 1 by reproduction and finding 2 against source.
- Protocol deviation: the verifier packet named the reviewers and carried their self-rated confidence, where the protocol calls for anonymized candidates. The finalizer here validates findings instead of ranking candidates, so the effect on the outcome is judged minimal. Recorded for honesty.

ultra: union=2/2 single_candidate_only=1
