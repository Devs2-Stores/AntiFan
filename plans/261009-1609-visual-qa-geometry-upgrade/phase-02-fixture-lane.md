---
title: "Phase 2: Fixture corpus + real-Chromium lane (red baseline)"
status: done
---

# Phase 2: Fixture corpus + real-Chromium lane (red baseline)

## Goal

A permanent command renders 20 known pages in real Chromium, runs the integrity and overflow
scans on each, and exits non-zero unless every defect is caught and every healthy control stays
clean. Before Phase 3 it must be red against the current engine and green against the reference
scan, which proves the harness itself is correct before any engine code changes.

## Context

- `research/visual-qa-probe/fixtures.cjs` holds the 20 pages; `research/visual-qa-probe/run-v2.cjs`
  is the prototype runner. Both are frozen evidence; this phase creates permanent copies.
- Expectations from `run-v2.cjs:25-33` (kinds that count as caught; `[]` = healthy control):
  `02,03,08: clipping` · `04,05,06,07,13a,13b: overlap|occlusion` · `09,10: occlusion` ·
  `11: sticky-obstruction|occlusion` · `14: layout-shift` · `15: occlusion|overlap` ·
  controls `12,16,17,18,19`. Fixtures `06` and `14` pass on a warning (their defect hides no text
  or control). Fixture `01` is plain document overflow: it is judged by `LayoutOverflowEngine`
  (`hasOverflow === true`), not by the integrity scan.
- Defects are judged at 375×667 only; controls are judged at 375×667 and 1440×900
  (`run-v2.cjs:21-24` viewports, same `Emulation.setDeviceMetricsOverride` parameters).
- Measured behavior to rely on (Electron 43.7.9, this host):
  - `esbuild.buildSync` works inside the Electron main process (probe
    `E:/Work/scratch/visual-qa-probe/esbuild-in-electron.cjs`: `ESBUILD_IN_ELECTRON_OK 43.7.9 352ms`),
    so the harness bundles both scanners from `src/` itself and never reads `.compiled/`.
  - Attaching `webContents.debugger` before the first navigation exits Electron with code 3 and no
    JS error; load `data:text/html,<p>boot</p>` first (`run-v2.cjs:56-57`).
  - A hidden off-screen window paints no frames, so no layout-shift entries exist;
    `Page.startScreencast` with per-frame ack forces frames (`run-v2.cjs:60-65`).
  - Fixture `14` needs `settleMs: 2000`: mobile emulation registers an input ~235 ms after load
    and shifts within 500 ms of input are `hadRecentInput` (excluded from CLS).
- Recorded scores (`E:/Work/scratch/visual-qa-probe/out-v2/results.json`): current engine has a
  critical on controls `12` (7 at 375, 1 at 1440), `17` (375), `19` (375 and 1440) and misses
  defect `04` at 375 (0 criticals); reference scan passes every row, slowest 785 ms
  (`13b` at 1440, 2510 elements).

## Constraints

- Separate instance only. The harness is a standalone Electron script launched by
  `node scripts/run-electron.cjs <script>` without `--state-record`, so the launcher publishes no
  instance record and does not probe the bridge port. The script must:
  - call `app.setPath('userData', fs.mkdtempSync(...))` before `app.whenReady()`;
  - create only `show: false, x: -4000, skipTaskbar: true, focusable: false` windows and call
    `win.showInactive()` (never steals focus);
  - require nothing from the app except the two scanner sources it bundles
    (`src/main/qa/scanners/layout-integrity-engine.ts`, `layout-overflow-engine.ts`);
  - write HTML and results under `os.tmpdir()` (or `--out=<dir>`), never into the repo or
    `ANTIFAN_DATA_ROOT`.
- No `npm run compile`, no bare `npm test` / `npm run verify`, no app or daemon restart.

## Files

- Create `test/fixtures/visual-qa/fixtures.cjs`.
- Create `test/e2e/visual-qa-fixtures-probe.cjs`.
- Modify `package.json` (`scripts`, next to `"test:toolbar-qa-hub"`).

## Tasks

### Task 2.1 — Fixture module with embedded expectations
- Goal: each fixture carries its own verdict rule, so the harness has no side table.
- Target: `test/fixtures/visual-qa/fixtures.cjs` (new).
- Steps:
  1. Copy `research/visual-qa-probe/fixtures.cjs` verbatim (all 20 entries, helpers
     `page`, `deep`, `card`, constants). Keep the Vietnamese copy: the fixtures exercise
     diacritics in real line boxes.
  2. Add an `expect` field to every entry, derived from the Context list:
     - defect: `expect: { kinds: [...], allowWarning: false }` (`allowWarning: true` for `06`, `14`);
     - control (`12`, `16`, `17`, `18`, `19`): `expect: { control: true }`;
     - `01`: `expect: { documentOverflow: true }`.
  3. Replace the header comment with one line stating the module contract: each entry is
     `{ id, defect, html, settleMs?, expect }` and `expect` is the verdict rule above.
- Success criteria: 20 entries; every entry has exactly one of `kinds`, `control`,
  `documentOverflow`.
- Verify: `node -e "const f=require('./test/fixtures/visual-qa/fixtures.cjs');const bad=f.filter(x=>[x.expect&&x.expect.kinds,x.expect&&x.expect.control,x.expect&&x.expect.documentOverflow].filter(Boolean).length!==1);console.log(f.length,bad.map(x=>x.id).join(',')||'OK')"`
  prints `20 OK`.

### Task 2.2 — Real-Chromium harness
- Goal: `test/e2e/visual-qa-fixtures-probe.cjs` judges every fixture and sets the exit code.
- Target: `test/e2e/visual-qa-fixtures-probe.cjs` (new). Port the window/debugger setup and
  `scan()` from `research/visual-qa-probe/run-v2.cjs:41-79`; drop the prototype's v1/v2
  side-by-side, `--live`, `--no-exempt`, `clipShots` and CLS ground-truth logging.
- Steps:
  1. Arguments: `--only=<id prefix>`; `--out=<dir>` (default
     `fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-'))`); `--scan-file=<path>`
     (evaluate that file's text, with `'__VIEWPORT_NAME__'` replaced by the JSON-quoted viewport
     name, instead of `LayoutIntegrityEngine.getBrowserScanScript(name)`; used to validate the
     harness against the reference scan and to compare candidate scans).
  2. Bundle both scanners with `esbuild.buildSync({ entryPoints: { integrity, overflow },
     bundle: true, format: 'cjs', platform: 'node', outdir: <mkdtemp>, logLevel: 'error' })` and
     `require` the outputs.
  3. For each viewport (375 mobile, 1440 desktop) × fixture (filtered by `--only`): open a fresh
     window (`openAt`), write the HTML into the out dir, `loadFile`, wait `settleMs || 600`,
     read `[scrollX, scrollY]`, evaluate the integrity scan and time it (wall ms), read scroll
     again, evaluate `LayoutOverflowEngine.getBrowserScanScript(vp.name)`, detach, destroy.
  4. Judge each row; collect failure reasons:
     - always: integrity payload `measured === true`; scroll restored (x equal, |Δy| ≤ 1);
       wall ≤ 3000 ms;
     - `expect.kinds` at 375: some finding with `kinds.includes(kind)` and
       (`severity === 'critical'` or `allowWarning`); at 1440 the kind rule is not judged, the row
       prints `info`, and it fails only on the "always" checks above;
     - `expect.control` at both widths: zero criticals;
     - `expect.documentOverflow` at 375: overflow payload `hasOverflow === true`.
  5. Print one line per row: `<vp> <id> <PASS|FAIL|info> crit=<n> warn=<n> ms=<stats.durationMs ?? '-'> wall=<n> restored=<bool>`,
     followed by indented failure reasons and finding lines (`C|W kind: details`) for FAIL rows.
     Then print `SUMMARY pass=<n> fail=<n> failed=<vp:id,...> out=<dir>` (an `info` row counts as
     a pass) and write `results.json` to the out dir: an array with one object per row,
     `{ vp, id, status, wallMs, restored, reasons, integrity, overflow }`, where `integrity` and
     `overflow` are the raw scan payloads (Phases 3 and 4 read `integrity.stats` from it).
  6. Exit with `app.exit(code)`: 0 when no row failed, 1 when any row failed, 2 on any harness
     error (`unhandledRejection` / `uncaughtException` / a scan that throws or returns a
     non-object), printing the error first.
- Success criteria: deterministic exit code; no file written outside the out dir and the
  esbuild temp dir.
- Verify: `node scripts/run-electron.cjs test/e2e/visual-qa-fixtures-probe.cjs --only=12`
  exits 1, and its output contains `mobile 12-line-clamp-intended FAIL` (current engine false
  positive).

### Task 2.3 — npm script
- Goal: one command runs the lane.
- Target: `package.json` `scripts`.
- Steps:
  1. After `"test:toolbar-qa-hub"`, add
     `"test:visual-qa": "node scripts/run-electron.cjs test/e2e/visual-qa-fixtures-probe.cjs"`.
- Success criteria: `npm run test:visual-qa -- --only=01` runs the harness.
- Verify: `npm run test:visual-qa -- --only=01` exits 0 and prints
  `SUMMARY pass=2 fail=0` (fixture `01` at 375 by the overflow engine and at 1440 as `info` with
  measured/restored/time checks passing).

### Task 2.4 — Baseline proof: red on the current engine, green on the reference scan
- Goal: prove the harness discriminates before Phase 3 touches the engine.
- Steps:
  1. Run `npm run test:visual-qa` and save the full output in the phase report.
  2. Run `npm run test:visual-qa -- --scan-file=plans/261009-1609-visual-qa-geometry-upgrade/research/visual-qa-probe/scan-v2.js`
     and save the full output in the phase report.
- Success criteria: step 1 exits 1 and its `failed=` list contains `mobile:12-line-clamp-intended`
  and `mobile:04-text-on-text-deep`; step 2 exits 0 with `fail=0`.
- Verify: both exit codes and the quoted `SUMMARY` lines appear in the phase report.

## Phase exit

- Verify: Task 2.4 holds, and
  `node -e "const f=require('./test/fixtures/visual-qa/fixtures.cjs');console.log(f.length)"` prints `20`.

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
