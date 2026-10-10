# Phase 3 Report: Port the reference scan + fail-closed scan stats

## Task 3.1 - Pre-flight

- Command: `git diff -- src/main/qa/scanners/layout-integrity-engine.ts > "$TEMP/engine-now.diff" && cmp plans/261009-1609-visual-qa-geometry-upgrade/research/engine-working-copy-261010.diff "$TEMP/engine-now.diff" && echo IDENTICAL`
- Output: `IDENTICAL`

## Task 3.2 - Red: truncation and detector failure must not PASS

- Added `10c. Truncated integrity scan is an evidence gap, never PASS` and
  `10d. Failed integrity detector is an evidence gap, never PASS` to
  `test/unit/theme-qa-fail-closed-adjudication.test.ts`.
- Command: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`
- Exit code: 1 (expected red)
- Verbatim:
  ```text
  [FAIL] 10c. Truncated integrity scan is an evidence gap, never PASS (157.2839ms)
  [FAIL] 10d. Failed integrity detector is an evidence gap, never PASS (167.7168ms)
  AssertionError [ERR_ASSERTION]: expected truncation gap, got undefined
  AssertionError [ERR_ASSERTION]: expected detector gap, got undefined
  ```

## Task 3.3 - Port the scan into the engine

- `src/main/qa/scanners/layout-integrity-engine.ts`: module constant `LAYOUT_INTEGRITY_SCAN`
  (`String.raw`) holds `scan-v2.js` lines 4-742; `getBrowserScanScript(name)` substitutes
  `'__VIEWPORT_NAME__'` with `JSON.stringify(name)` through a replacer function; new
  `LayoutIntegrityStats` type, `LayoutIntegrityResult.stats?`.
- Verbatim check (throwaway `E:/Work/scratch/visual-qa-probe/port-check.cjs`: bundles the engine
  from `src/`, diffs `getBrowserScanScript("a'$&b")` line by line against `scan-v2.js:4-742`):
  ```text
  gotLines 742 refLines 739
  {"line":2,"got":"  const VIEWPORT_NAME = \"a'$&b\";","ref":"  const VIEWPORT_NAME = '__VIEWPORT_NAME__';"}
  {"line":27,"got":"  const stats = { ..., truncatedReasons: [], failedDetectors: [], durationMs: 0 };", ...}
  {"line":73,"got":"  const detectorFailed = (kind, err) => {", ...}
  {"block":["  const detectorFailed = (kind, err) => {","    stats.failedDetectors.push(kind);","    push({ kind: kind, severity: 'warning', ... });","  };"]}
  PARSE_OK breakpoints=3 reader=function
  ```
  The only differences are the placeholder substitution and the two planned stats edits.
- `npm run typecheck`: exit 0.
- `npm run test:visual-qa -- --scan-file=plans/261009-1609-visual-qa-geometry-upgrade/research/visual-qa-probe/scan-v2.js`:
  exit 0, `SUMMARY pass=40 fail=0 failed= out=C:\Users\Admin\AppData\Local\Temp\antifan-visual-qa-Hb2bbf`

## Task 3.4 - Workflow: scan stats become evidence gaps

- `src/main/qa/theme-qa-workflow.ts`: after the `measured === false` block, a truncated scan pushes
  `Layout integrity scan truncated: <reasons>` and failed detectors push
  `Layout integrity detectors failed: <kinds>`; the step comment says both are non-PASS gaps.
- Command: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`
- Exit code: 0
- Verbatim: `ℹ tests 31` / `ℹ pass 31` / `ℹ fail 0`
  (`✔ 10c. ... (174.2119ms)`, `✔ 10d. ... (177.384ms)`)

## Task 3.5 - Engine unit tests

- `test/unit/layout-integrity-engine.test.mjs`: always bundles `src/` into a temp dir; removed the
  script-source substring tests, the `new Function` smoke and the fake-DOM `measured:true` test;
  the `measured:false` sandbox test now injects `"a'$&b"` and asserts `result.viewport.name`.
- Command: `node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs`
- Exit code: 0
- Verbatim: `ℹ tests 6` / `ℹ pass 6` / `ℹ fail 0`

## Task 3.6 - Speed and stats on the fixture corpus

- Command: `npm run test:visual-qa -- --out=C:/Users/Admin/AppData/Local/Temp/tmp.LxfDEepeJh`
- Exit code: 0
- Verbatim: `SUMMARY pass=40 fail=0 failed= out=C:\Users\Admin\AppData\Local\Temp\tmp.LxfDEepeJh`
- Stats command: `node -e "const r=require('<dir>/results.json');const s=r.map(x=>x.integrity.stats);console.log('maxMs='+Math.max(...s.map(x=>x.durationMs)),'truncated='+s.filter(x=>x.truncated).length,'failed='+s.filter(x=>x.failedDetectors.length).length)"`
- Verbatim: `maxMs=880 truncated=0 failed=0` (slowest: `desktop 13b-footer-overlap-large-dom ms=880 wall=888`)

## Phase exit

| Command | Exit | Result |
|---|---|---|
| `npm run test:visual-qa` | 0 | `SUMMARY pass=40 fail=0` |
| `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` | 0 | 31/31 |
| `node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs` | 0 | 6/6 |
| `npm run typecheck` | 0 | - |

No step ran `npm run compile`, `npm test`, `npm run verify`, or restarted the running AntiFan
instance; every Electron run was a separate instance through `node scripts/run-electron.cjs`.
