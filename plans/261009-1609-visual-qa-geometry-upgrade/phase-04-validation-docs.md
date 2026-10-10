---
title: "Phase 4: Held-out corpus, live probe, pipeline lane, docs"
status: done
---

# Phase 4: Held-out corpus, live probe, pipeline lane, docs

## Goal

Prove the ported scan on pages it was never tuned on (acceptance criteria 2, 3 and 4), make the
fixture lane part of the default test pipeline, and document the new QA semantics.

## Context

- After Phase 3, `npm run test:visual-qa` runs `test/fixtures/visual-qa/fixtures.cjs` through the
  engine and exits 0. The 20 fixtures were written by the same session that wrote `scan-v2.js`,
  so they cannot measure overfitting; the held-out corpus can, only if its author never sees the
  scan, the fixtures or any scan output before the corpus is frozen.
- `research/visual-qa-probe/run-v2.cjs` holds the prototype live runner: `SITES` (`:35-40`,
  4 public Haravan stores), Electron switches and `openAt` (`:43-65`; the screencast at `:58-63`
  is what makes an offscreen window paint, so the CLS witness sees entries), `clipShots`
  (`:80-93`), `DISCOVER` (`:130-133`, first same-host `/products/<handle>` and
  `/collections/<handle>` link on the mobile home page) and `runLive` (`:135-164`,
  home → product → collection at 375 and 1440 = 24 pages, 5 s settle).
- Pipeline lanes (`scripts/run-test-pipeline.mjs`): `TEST_LANES` (`:34-54`) is the default set;
  `NON_COMPILE_LANES` (`:74`) are lanes that do not need `compile`; every other known lane is
  `COMPILE_DEPENDENT` (`:75-77`), and naming one inserts the `compile` lane before it (`:175-178`).
  The fixture lane bundles from `src/` and never needs `compile`, and `compile` must not run in
  this plan, so the lane goes into `NON_COMPILE_LANES`. `SPAWN_HEAVY_LANES` (`:97-107`) are
  serialized; the lane spawns Electron, so it belongs there. A lane name maps to
  `npm run <lane>` unless `LANE_COMMANDS` (`:113-118`) overrides it; no override is needed.
- `docs/operations.md:138` says the default pipeline runs "nineteen lanes" and lists them;
  `:120-134` is the Verification Commands block; `:144-146` describe `theme.qa_validate`.
- `CHANGELOG.md` entries sit under `## [v1.3.6] - Unreleased` (`:7`), headed
  `### Sửa — <area>: <summary>`, in Vietnamese with full diacritics.
- The QA workflow is imported only by main-process modules (`control-plane-runtime.ts:32`,
  `theme-qa-repair-coordinator.ts:3`, `browser-capabilities.ts:12`), not by the terminal daemon,
  so shipping it needs `npm run compile` plus a GUI restart, no daemon refresh [INFERENCE from
  the importer list; that step is the user's, outside this plan].

## Constraints

- Same separate-instance rules as Phases 2 and 3: no `npm run compile`, no bare `npm test` /
  `npm run verify`, no app or daemon restart; every Electron run goes through
  `node scripts/run-electron.cjs <script>` with a temp `userData` and off-screen, non-focusable
  windows; outputs go to `os.tmpdir()` or `--out=<dir>`.
- **Held-out integrity.** The engine and the fixtures are frozen for this phase. Do not change
  `src/main/qa/scanners/layout-integrity-engine.ts` or `test/fixtures/visual-qa/fixtures.cjs`
  after Task 4.2 starts. Do not edit `holdout.cjs` after its first scan (Task 4.3), except to fix
  an entry that makes the harness exit 2, and then only by the author agent, given only the error
  text. Any engine change made after seeing held-out results spends the corpus: a new one would be
  needed, which is a user decision.
- The live probe reads public storefronts only (no login, no form submission, no cart action).

## Files

- Modify `test/e2e/visual-qa-fixtures-probe.cjs` (`--corpus=<path>`).
- Create `test/fixtures/visual-qa/holdout.cjs`.
- Create `scripts/probe-visual-qa-live-sites.cjs`.
- Modify `package.json` (`scripts`, after `"test:visual-qa"`).
- Modify `scripts/run-test-pipeline.mjs` (`:53`, `:74`, `:106`).
- Modify `docs/operations.md` (`:120-134`, `:138`, after `:146`).
- Modify `CHANGELOG.md` (after `:7`).

## Tasks

### Task 4.1 — Harness reads any corpus
- Goal: the fixture harness can run the held-out corpus without a second harness.
- Target: `test/e2e/visual-qa-fixtures-probe.cjs`.
- Steps:
  1. Add `--corpus=<path>` (resolved against `process.cwd()`, default
     `test/fixtures/visual-qa/fixtures.cjs`); load it with `require` instead of the fixed path.
  2. Before scanning, apply the Task 2.1 contract check to every entry (exactly one of
     `expect.kinds`, `expect.control`, `expect.documentOverflow`; non-empty `id` and `html`);
     a violation is a harness error (exit 2) naming the entry id.
- Success criteria: default behavior unchanged; a malformed corpus exits 2.
- Verify:
  1. `npm run test:visual-qa` exits 0 with `SUMMARY pass=40 fail=0`.
  2. Write a temp module exporting `[{ id: 'x', html: '<p>x</p>', expect: {} }]` under
     `os.tmpdir()`, run `npm run test:visual-qa -- --corpus=<that file>`: exits 2 and prints `x`.

### Task 4.2 — Blind held-out corpus
- Goal: 12 pages (8 defects, 4 healthy controls) written by an agent that has never seen the
  scan, the fixtures or any scan output.
- Target: `test/fixtures/visual-qa/holdout.cjs` (new), written by a spawned subagent.
- Steps:
  1. Spawn one `task` subagent with exactly this brief (and nothing from this plan beyond it):
     - Write `test/fixtures/visual-qa/holdout.cjs`: CommonJS, `module.exports = [ ... ]`, each
       entry `{ id, defect, html, settleMs?, expect }`. `html` is a complete standalone document
       (inline CSS/JS only, no network). `defect` is one Vietnamese sentence saying what a shopper
       sees at 375×667. `id` is `h01`…`h12` plus a short slug.
     - 8 defects, each a layout bug a shopper would notice on a phone (375×667). `expect` is
       `{ kinds: [...], allowWarning: false }`, listing every kind a fair reviewer could name it:
       `overlap` (text painted over other text, or controls stacked on each other), `clipping`
       (text cut off by its own box or an ancestor with hidden overflow), `occlusion` (text or a
       button covered by another element, anywhere on the page, including below the first
       screen), `sticky-obstruction` (covered by a fixed or sticky bar), `offscreen` (a button laid
       out where it cannot be reached). Use `{ documentOverflow: true }` instead for a page that
       scrolls horizontally. Cover at least 5 of these 6 categories; at least 3 defects must sit
       below the first screen or inside markup nested 8+ levels deep.
     - 4 healthy controls (`expect: { control: true }`): pages with no visible defect that use
       techniques which legitimately hide, clip, overlap or move content. Pick 4 different ones
       from: text ellipsis, multi-line clamp, closed off-canvas menu or cart drawer, carousel with
       off-screen slides, auto-advancing slider, marquee/ticker, 3D flip card, SVG icon buttons,
       sale badge over a product image, sticky header over plain page padding, collapsed
       accordion, horizontally scrolling chip/tab row.
     - Markup should look like a real Haravan/Shopify theme: section → container → row → col →
       card wrappers, Vietnamese product copy with diacritics, prices in `₫`.
     - Do not read or search `plans/261009-1609-visual-qa-geometry-upgrade/`,
       `test/fixtures/visual-qa/fixtures.cjs`, `test/e2e/visual-qa-fixtures-probe.cjs`,
       `src/main/qa/`, `test/unit/*layout-integrity*`, or `E:/Work/scratch/visual-qa-probe/`.
       Do not run any scanner or test. You may render your own pages to PNG with a standalone
       Electron script (`node scripts/run-electron.cjs <script>`, `show: false`, `x: -4000`,
       temp `userData`, output under `os.tmpdir()`) to confirm each defect is visible.
     - End with the list of files you read.
  2. Record the subagent's read list in the phase report; if it names any forbidden path, delete
     `holdout.cjs` and STOP (the corpus is spent; report to the user).
- Success criteria: 12 entries, 8 defects, 4 controls; forbidden paths never read.
- Verify: `node -e "const f=require('./test/fixtures/visual-qa/holdout.cjs');const one=(x)=>[x.expect&&x.expect.kinds,x.expect&&x.expect.control,x.expect&&x.expect.documentOverflow].filter(Boolean).length===1;console.log(f.length,f.filter(x=>x.expect&&x.expect.control).length,f.filter(x=>!one(x)).map(x=>x.id).join(',')||'OK')"`
  prints `12 4 OK`.

### Task 4.3 — Held-out measurement (acceptance criterion 2)
- Goal: the frozen engine holds on pages it was not tuned on.
- Steps:
  1. `npm run test:visual-qa -- --corpus=test/fixtures/visual-qa/holdout.cjs --out=<fresh temp dir>`;
     save the full output in the phase report.
  2. `node -e "const h=require('./test/fixtures/visual-qa/holdout.cjs');const r=require(process.argv[1]+'/results.json');const ctl=new Set(h.filter(x=>x.expect.control).map(x=>x.id));const bad=r.filter(x=>x.status==='FAIL');console.log('controlsFailed='+bad.filter(x=>ctl.has(x.id)).length,'defectsMissed='+bad.filter(x=>!ctl.has(x.id)&&x.vp==='mobile').length,'otherFailed='+bad.filter(x=>!ctl.has(x.id)&&x.vp!=='mobile').length)" <dir>`
- Success criteria: step 1 exits 0 or 1 (never 2); step 2 prints `controlsFailed=0`,
  `defectsMissed` ≤ 2, `otherFailed=0`.
- Verify: both outputs quoted in the phase report, plus the `defect` text of every missed defect.
  A miss within budget is a documented known gap, not a reason to tune (see Constraints).

### Task 4.4 — Live probe (acceptance criteria 3 and 4)
- Goal: a permanent command re-measures the 24 live pages with the shipped engine.
- Target: `scripts/probe-visual-qa-live-sites.cjs` (new), `package.json`.
- Steps:
  1. Port from `research/visual-qa-probe/run-v2.cjs`: `SITES`, switches and `openAt`
     (`:35-65`), `clipShots` (`:80-93`), `DISCOVER` (`:130-133`), `runLive` (`:135-164`). Replace
     the reference-scan text with `LayoutIntegrityEngine.getBrowserScanScript(vp.name)` bundled from
     `src/` exactly as the fixture harness does (Task 2.2 step 2); drop the v1 comparison and the
     fixture mode. Arguments: `--only=<site>`, `--out=<dir>` (default
     `fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-live-'))`).
  2. A page is `unmeasured` when its load throws, the payload is not `measured: true`, or
     discovery found no product/collection link (that page id is then listed, never silently
     skipped). Print one line per page:
     `<id> crit=<n> warn=<n> ms=<stats.durationMs> wall=<n> restored=<bool> <url>`, finding lines
     for pages with criticals, then
     `SUMMARY pages=<measured>/<expected> unmeasured=<ids> withCritical=<ids> unrestored=<n> maxMs=<n> out=<dir>`;
     write `results.json` (`{ id, url, measured, stats, wallMs, restored, findings }` per page).
  3. Exit 0 when every expected page is measured, restored and critical-free; 1 otherwise;
     2 on a harness error.
  4. In `package.json`, after `"test:visual-qa"`, add
     `"probe:visual-qa-live": "node scripts/run-electron.cjs scripts/probe-visual-qa-live-sites.cjs"`.
  5. Run `npm run probe:visual-qa-live`; save the full output in the phase report.
- Success criteria: `pages=24/24`, empty `unmeasured=`, `unrestored=0`, `maxMs` ≤ 1200, and
  either empty `withCritical=` or every listed page's clip PNGs shown to the user, who classifies
  each critical as a real defect. Also, fixture `maxMs` from Phase 3 Task 3.6 ≤ 1200
  (criterion 4 covers both).
- Verify: the `SUMMARY` line quoted in the phase report; for criticals, the user's classification
  quoted per finding. An unmeasured page (site down, theme changed) or a critical the user calls a
  false positive does not meet the pass condition.

### Task 4.5 — Fixture lane in the default pipeline
- Goal: `npm run verify` runs the fixture lane; naming the lane alone never compiles.
- Target: `scripts/run-test-pipeline.mjs`.
- Steps:
  1. Add `'test:visual-qa'` after `'test:toolbar-qa-hub'` in `TEST_LANES` (`:53`) and in
     `SPAWN_HEAVY_LANES` (`:106`).
  2. Add `'test:visual-qa'` to `NON_COMPILE_LANES` (`:74`) with a one-line comment: the lane
     bundles the scanners from `src/` and needs no compiled tree.
- Success criteria: the lane runs alone without a `compile` lane and passes.
- Verify: `node scripts/run-test-pipeline.mjs test:visual-qa` exits 0; its output contains
  `===== test:visual-qa =====` and does not contain `===== compile =====`.

### Task 4.6 — Docs and changelog
- Goal: operators and agents know what `theme.qa_validate` now checks and how to run the lanes.
- Target: `docs/operations.md`, `CHANGELOG.md`.
- Steps:
  1. In the Verification Commands block (`docs/operations.md:122-134`) add:
     ```bash
     # Layout integrity scan against 20 known pages in a separate Electron instance
     npm run test:visual-qa

     # Re-measure 24 public Haravan pages (network; prints clip screenshots for criticals)
     npm run probe:visual-qa-live
     ```
  2. In `:138` change `nineteen lanes` to `twenty lanes` and append `` `test:visual-qa` `` to the
     live smoke/probe list after `` `test:toolbar-qa-hub` ``.
  3. After `:146` add one bullet (Vietnamese, full diacritics) stating: the layout integrity scan
     runs once, synchronously, on the active viewport; critical kinds (text over text, stacked
     controls, clipped text, text/CTA covered anywhere on the page, offscreen control,
     fixed/sticky obstruction); warning kinds (CLS > 0.1, zero-size control, in-flow sibling
     boxes overlapping); healthy patterns exempted by computed style and geometry, not class
     names (the Outcome list in `plan.md`); a truncated scan or failed detector is an evidence gap
     (verdict `INCONCLUSIVE`, never PASS); `findings.responsive[width]` takes `documentOverflow`
     from the host's five-width sweep and integrity counts are `null` for widths the scan did not
     measure; `checklist.layout` is `false` when integrity criticals exist. Check every clause
     against the shipped script and workflow before writing it.
  4. In `CHANGELOG.md`, directly under `## [v1.3.6] - Unreleased`, add
     `### Sửa — Theme QA: phát hiện chữ đè chữ, chữ bị cắt, CTA bị che mà không báo lỗi giả trên theme lành`
     with bullets: cause (the 9 root causes in `plan.md`, one line each, file:line), fix (ported
     scan, report wiring, evidence gaps), and measured evidence quoted from the phase reports
     (fixtures 14/14 and 0/5 controls, held-out counts from Task 4.3, live `SUMMARY` from Task 4.4,
     slowest scan). State that the running app picks it up after `npm run compile` and an AntiFan
     restart.
- Success criteria: every number in the changelog appears in a phase report.
- Verify: `node scripts/check-plans.mjs` exits 0 and `npm run typecheck` exits 0.

## Phase exit

- Verify: Tasks 4.3, 4.4 and 4.5 pass conditions quoted in the phase report;
  `npm run test:visual-qa` exits 0; `npm run typecheck` exits 0; `node scripts/check-plans.mjs`
  exits 0. Confirm in the report that no step restarted, refreshed or recompiled the running
  AntiFan instance.

## Failure Protocol
If any Verify step does not meet its stated pass condition, STOP this phase.
Do not improvise a fix, retry blindly, or reason around the failure.
Spawn the `kongming` subagent for next-step counsel and pass:
- the phase and task id,
- what you attempted (the steps you ran),
- the exact command and its full output,
- the pass condition it failed to meet.
Apply kongming's guidance, then re-run the Verify step.
If `kongming` cannot be spawned in this environment, STOP and report the same
failure evidence to the user. Never continue by self-reasoning.
