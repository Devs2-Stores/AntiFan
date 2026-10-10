# Phase 02 — Fixture corpus + real-Chromium lane

## Task 2.1 — Fixture module

- Command: `node -e "const f=require('./test/fixtures/visual-qa/fixtures.cjs');const bad=f.filter(x=>[x.expect&&x.expect.kinds,x.expect&&x.expect.control,x.expect&&x.expect.documentOverflow].filter(Boolean).length!==1);console.log(f.length,bad.map(x=>x.id).join(',')||'OK')"`
- Exit code: 0
- Verbatim output: `20 OK`

## Task 2.2 — Chromium harness false-positive baseline

- Command: `node scripts/run-electron.cjs test/e2e/visual-qa-fixtures-probe.cjs --only=12`
- Exit code: 1 (expected; current engine false positive)
- Verbatim result lines:
  - `mobile 12-line-clamp-intended FAIL crit=7 warn=0 ms=- wall=12 restored=true`
  - `desktop 12-line-clamp-intended FAIL crit=1 warn=0 ms=- wall=13 restored=true`
  - `SUMMARY pass=0 fail=2 failed=mobile:12-line-clamp-intended,desktop:12-line-clamp-intended out=C:\Users\Admin\AppData\Local\Temp\antifan-visual-qa-Ij6f65`

## Task 2.3 — npm script

- Command: `npm run test:visual-qa -- --only=01`
- Exit code: 0
- Verbatim result lines:
  - `mobile 01-overflow-plain PASS crit=0 warn=0 ms=- wall=9 restored=true`
  - `desktop 01-overflow-plain PASS crit=0 warn=0 ms=- wall=14 restored=true`
  - `SUMMARY pass=2 fail=0 failed= out=C:\Users\Admin\AppData\Local\Temp\antifan-visual-qa-MVHoa1`

## Task 2.4 — Baseline comparison

### Current engine

- Command: `npm run test:visual-qa`
- Exit code: 1 (expected red baseline)
- Required failure evidence:
  - `mobile 04-text-on-text-deep FAIL crit=0 warn=0 ms=- wall=11 restored=true`
  - `mobile 12-line-clamp-intended FAIL crit=7 warn=0 ms=- wall=12 restored=true`
  - `SUMMARY pass=23 fail=17 failed=mobile:02-overflow-masked-body,mobile:03-overflow-masked-wrapper,mobile:04-text-on-text-deep,mobile:05-text-on-text-shallow,mobile:06-partial-overlap-30pct,mobile:07-text-spill-collision,mobile:08-text-cut-by-ancestor,mobile:10-cta-occluded-below-fold,mobile:11-fixed-header-covers-hero-text,mobile:12-line-clamp-intended,mobile:13b-footer-overlap-large-dom,mobile:14-cls-shift,mobile:15-image-over-text-deep,mobile:17-readmore-collapsed,mobile:19-hero-crossfade,desktop:12-line-clamp-intended,desktop:19-hero-crossfade out=C:\Users\Admin\AppData\Local\Temp\antifan-visual-qa-YUsfzV`

### Frozen reference scan

- Command: `npm run test:visual-qa -- --scan-file=plans/261009-1609-visual-qa-geometry-upgrade/research/visual-qa-probe/scan-v2.js`
- Exit code: 0
- Verbatim result lines:
  - `mobile 13b-footer-overlap-large-dom PASS crit=3 warn=1 ms=263 wall=270 restored=true`
  - `desktop 13b-footer-overlap-large-dom info crit=3 warn=1 ms=743 wall=751 restored=true`
  - `SUMMARY pass=40 fail=0 failed= out=C:\Users\Admin\AppData\Local\Temp\antifan-visual-qa-AOxzEO`

The Electron runner emitted per-row output for all 40 viewport/fixture combinations. Full machine-readable scan payloads were written by each invocation to the `results.json` in its displayed temporary `out` directory.

## Phase exit

- Command: `node -e "const f=require('./test/fixtures/visual-qa/fixtures.cjs');console.log(f.length)"`
- Exit code: 0
- Verbatim output: `20`
- Phase 2.4 acceptance holds: current engine is red on both required fixtures; reference scan is green across all 40 rows.
