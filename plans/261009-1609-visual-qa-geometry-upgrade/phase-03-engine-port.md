---
title: "Phase 3: Port the reference scan + fail-closed scan stats"
status: done
---

# Phase 3: Port the reference scan + fail-closed scan stats

## Goal

`LayoutIntegrityEngine.getBrowserScanScript()` returns the reference scan
(`research/visual-qa-probe/scan-v2.js`), so the Phase 2 lane turns green. The scan reports
which detectors threw, and the workflow turns a truncated scan or a failed detector into an
evidence gap, so such a run can never PASS.

## Context

- `scan-v2.js` is the measured reference: 14/14 defect fixtures caught, 0/5 controls with a
  critical at 375 and 1440, 0/24 live pages with a critical, slowest scan 785 ms
  (plan.md Overview). Lines 1-3 are a comment; the script itself is lines 4-742 and contains
  no backtick, no `${` and no backslash-escape that a tagged template would cook
  (grep for `` ` ``, `${`, `\u`, `\x`, `\<digit>`: 0 hits). It can therefore be embedded as a
  `String.raw` template with every character kept as written.
- The viewport name is a placeholder: `scan-v2.js:5` is `const VIEWPORT_NAME = '__VIEWPORT_NAME__';`.
  Phase 2's harness substitutes it for `--scan-file`; the engine must substitute it the same way.
  `String.prototype.replace` with a string replacement expands `$&`, `$'` and `` $` ``, so the
  replacement must be a function.
- Detector failures are reported only as findings: `scan-v2.js:76`
  `const detectorFailed = (kind, err) => push({ kind, severity: 'warning', ... })`, and `push`
  drops warnings past `WARNING_CAP_PER_KIND` (`:24`, `:68-75`). A failed `overlap` detector after
  10 overlap warnings is therefore invisible. The stats object (`:30`) has `truncated` and
  `truncatedReasons` but no detector record.
- The workflow reads the payload at `src/main/qa/theme-qa-workflow.ts:852-871`: it keeps
  `integrityResult` only when `findings` is an array and adds an evidence gap only for
  `measured === false`. Truncation and detector failures are ignored today.
- Any evidence gap makes the verdict non-PASS: `hasMissingEvidence` includes
  `evidenceGaps.length > 0` (`theme-qa-workflow.ts:1256`); with criticals the verdict is FAIL
  (`:1258-1260`), otherwise INCONCLUSIVE (`:1261-1262`).
- The default mock in `test/unit/theme-qa-fail-closed-adjudication.test.ts:44-61` routes scripts
  by substring. `scan-v2.js` contains `haravan` (`:27`, `#haravan-notification`), so the default
  mock answers the integrity scan with the HS payload, which has no `findings` array: the
  integrity scan stays unmeasured in every existing test, exactly as today.
- `test/unit/layout-integrity-engine.test.mjs:27-31` loads `.compiled/.../layout-integrity-engine.js`
  whenever it exists. `.compiled/` belongs to the running app and is not rebuilt during this plan,
  so that test would keep testing the old engine.
- Ten tests in that file (`:53-124`) assert substrings of the script source
  (`'el.scrollWidth > el.clientWidth + 2'`, `'intersectionArea'`, `'findings.length > 50'` ...),
  and `:184-223` runs the script against a hand-built fake DOM. Both pin implementation, not
  behavior; the Phase 2 lane is the behavior test.
- **Uncommitted edit.** The working copy of `src/main/qa/scanners/layout-integrity-engine.ts`
  carries a 55-line uncommitted edit on top of `920dd0fc` (skip-link and preview-chrome
  exemptions, fixed-layer and parked-control helpers, actionable-overlap rules). It is saved
  verbatim at `research/engine-working-copy-261010.diff`. Every hunk sits inside
  `getBrowserScanScript` (`:41-588`), which this phase replaces. Its intent is covered by
  `scan-v2.js`: preview chrome `:27`, `:295`; fixed/sticky layers `layerOf`; parked controls
  `:304-325`; clipped/sr-only paint `:116-121`; absolute overlays over controls `:518-560`.

## Constraints

- Do not touch the running AntiFan instance: no `npm run compile`, no `npm test`,
  no `npm run verify`, no app or daemon restart. Unit tests run from source
  (`npx tsx --test`, or `node --test` on an esbuild bundle in `os.tmpdir()`); runtime checks run
  through the Phase 2 lane (separate Electron instance).
- The ported script keeps the two selector lists verbatim (`CAROUSEL_SLIDE`,
  `PLATFORM_PREVIEW_CHROME`, `scan-v2.js:26-27`) and adds no new selector list.
- Do not tune detectors in this phase. The only script changes allowed are the two stats edits in
  Task 3.3. If the lane is not green with the verbatim port, the Failure Protocol applies.

## Files

- Modify `src/main/qa/scanners/layout-integrity-engine.ts` (types `:1-18`, class doc `:30-40`,
  `getBrowserScanScript` `:41-588`).
- Modify `src/main/qa/theme-qa-workflow.ts` (integrity block `:852-871`).
- Modify `test/unit/theme-qa-fail-closed-adjudication.test.ts` (two tests after `10b`).
- Modify `test/unit/layout-integrity-engine.test.mjs` (loader `:20-39`, delete `:53-124`,
  `:184-223`).

## Tasks

### Task 3.1 — Pre-flight: the uncommitted engine edit is the recorded one
- Goal: the port overwrites only the edit already preserved in the plan, never newer work.
- Steps:
  1. In Git Bash run
     `git diff -- src/main/qa/scanners/layout-integrity-engine.ts > "$TEMP/engine-now.diff" && cmp plans/261009-1609-visual-qa-geometry-upgrade/research/engine-working-copy-261010.diff "$TEMP/engine-now.diff" && echo IDENTICAL`.
     (Dry run on 2026-10-10 printed `IDENTICAL`.)
- Success criteria: the command prints `IDENTICAL`.
- Verify: the command prints `IDENTICAL` and exits 0. Any difference means someone edited the
  engine after 2026-10-10: STOP and ask the user before Task 3.3 (this is a user decision, not a
  Failure Protocol case).

### Task 3.2 — Red: truncation and detector failure must not PASS
- Goal: two tests prove the workflow ignores scan stats today.
- Target: `test/unit/theme-qa-fail-closed-adjudication.test.ts`, directly after test `10b`
  (added in Phase 1).
- Steps:
  1. Add:
     ```ts
     it('10c. Truncated integrity scan is an evidence gap, never PASS', async () => {
       const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
       const base = createMockPorts();
       const ports = createMockPorts({
         eval: async (target, script) => script === integrityScript
           ? { measured: true, viewport: { name: 'active', width: 1440, height: 900 }, findings: [],
               stats: { elements: 16000, textRuns: 0, controls: 0, sweepSteps: 0, truncated: true,
                 truncatedReasons: ['elements 16000 > 15000'], failedDetectors: [], durationMs: 900 } }
           : base.browser.eval(target, script),
       });
       const report = await new ThemeQaWorkflow(ports).validate({
         runId: 'run-integrity-truncated',
         attemptId: 'att-integrity-truncated',
         workspaceRoot: 'E:/Work/test-theme',
         target: makeTarget(1),
         viewports: {
           desktop: { mismatchPercent: 0.5, passed: true },
           tablet: { mismatchPercent: 1.0, passed: true },
           mobile: { mismatchPercent: 1.5, passed: true },
         },
       });
       assert.ok(report.findings?.evidenceGaps?.some((g) => g.includes('Layout integrity scan truncated: elements 16000 > 15000')),
         `expected truncation gap, got ${JSON.stringify(report.findings?.evidenceGaps)}`);
       assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
     });

     it('10d. Failed integrity detector is an evidence gap, never PASS', async () => {
       const integrityScript = LayoutIntegrityEngine.getBrowserScanScript('active');
       const base = createMockPorts();
       const ports = createMockPorts({
         eval: async (target, script) => script === integrityScript
           ? { measured: true, viewport: { name: 'active', width: 1440, height: 900 }, findings: [],
               stats: { elements: 900, textRuns: 120, controls: 30, sweepSteps: 4, truncated: false,
                 truncatedReasons: [], failedDetectors: ['clipping', 'clipping', 'occlusion'], durationMs: 300 } }
           : base.browser.eval(target, script),
       });
       const report = await new ThemeQaWorkflow(ports).validate({
         runId: 'run-integrity-detector-failed',
         attemptId: 'att-integrity-detector-failed',
         workspaceRoot: 'E:/Work/test-theme',
         target: makeTarget(1),
         viewports: {
           desktop: { mismatchPercent: 0.5, passed: true },
           tablet: { mismatchPercent: 1.0, passed: true },
           mobile: { mismatchPercent: 1.5, passed: true },
         },
       });
       assert.ok(report.findings?.evidenceGaps?.some((g) => g.includes('Layout integrity detectors failed: clipping, occlusion')),
         `expected detector gap, got ${JSON.stringify(report.findings?.evidenceGaps)}`);
       assert.strictEqual(report.summary.verdict, 'INCONCLUSIVE');
     });
     ```
- Success criteria: both tests fail on their first assertion; every other test passes.
- Verify: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` exits non-zero and
  its output contains `expected truncation gap` and `expected detector gap`. A passing run here
  is a failure of this task.

### Task 3.3 — Port the scan into the engine
- Goal: the engine returns the reference scan, plus a detector-failure record.
- Target: `src/main/qa/scanners/layout-integrity-engine.ts`.
- Steps:
  1. Above `export class LayoutIntegrityEngine`, add a module constant holding
     `research/visual-qa-probe/scan-v2.js` lines 4-742 verbatim inside a `String.raw` template:
     ```ts
     // In-page scan, synchronous. String.raw keeps every character as written: the script must
     // never contain a backtick or a dollar-brace. '__VIEWPORT_NAME__' is substituted per call.
     const LAYOUT_INTEGRITY_SCAN = String.raw`(() => {
     ...lines 5-742 of scan-v2.js, unchanged except steps 2 and 3...`;
     ```
  2. In the copied stats line (`scan-v2.js:30`) add `failedDetectors: []` after
     `truncatedReasons: []`.
  3. Replace the copied `detectorFailed` line (`scan-v2.js:76`) with:
     ```js
     const detectorFailed = (kind, err) => {
       stats.failedDetectors.push(kind);
       push({ kind: kind, severity: 'warning', selector: 'document', details: 'Detector ' + kind + ' threw: ' + (err && err.message ? err.message : String(err)) });
     };
     ```
  4. Replace the whole body of `getBrowserScanScript` (`:41-588`) with:
     ```ts
     public static getBrowserScanScript(viewportName: string = 'active'): string {
       return LAYOUT_INTEGRITY_SCAN.replace("'__VIEWPORT_NAME__'", () => JSON.stringify(viewportName));
     }
     ```
  5. Add the stats type and attach it to the result (`:9-18`):
     ```ts
     export interface LayoutIntegrityStats {
       elements: number;
       textRuns: number;
       controls: number;
       sweepSteps: number;
       truncated: boolean;
       truncatedReasons: string[];
       failedDetectors: string[];
       durationMs: number;
       cls?: number;
       phaseMs?: Record<string, number>;
     }
     ```
     and `stats?: LayoutIntegrityStats; // absent when measured === false` on
     `LayoutIntegrityResult`.
  6. Rewrite the class doc comment (`:30-40`) to list the eight detectors by the section headers
     of the copied script (controls zero-size/offscreen; text runs; clipped text; text over text;
     stacked controls; in-flow sibling boxes (warning); covered text/controls swept over the full
     page; layout-shift witness) and to state that a truncated scan or a failed detector is
     reported in `stats`.
- Success criteria: the engine compiles; the lane result equals the reference scan's result.
- Verify:
  1. `npm run typecheck` exits 0.
  2. `npm run test:visual-qa` exits 0 and prints `SUMMARY pass=40 fail=0`.
  3. `npm run test:visual-qa -- --scan-file=plans/261009-1609-visual-qa-geometry-upgrade/research/visual-qa-probe/scan-v2.js`
     exits 0 with `fail=0` (the reference still agrees with the port).

### Task 3.4 — Workflow: scan stats become evidence gaps
- Goal: `10c` and `10d` pass.
- Target: `src/main/qa/theme-qa-workflow.ts`, inside `if (rec && Array.isArray(rec.findings)) {`
  (`:857`), directly after the `if (integrityResult.measured === false) { ... }` block
  (`:860-863`).
- Steps:
  1. Insert:
     ```ts
     const stats = integrityResult.stats;
     if (stats?.truncated === true) {
       const reasons = Array.isArray(stats.truncatedReasons) ? stats.truncatedReasons.join('; ') : '';
       evidenceGaps.push(`Layout integrity scan truncated: ${reasons || 'no reason reported'}`);
     }
     if (stats && Array.isArray(stats.failedDetectors) && stats.failedDetectors.length > 0) {
       evidenceGaps.push(`Layout integrity detectors failed: ${[...new Set(stats.failedDetectors)].join(', ')}`);
     }
     ```
  2. Update the comment at `:847-849` to say that a truncated scan or a failed detector is an
     evidence gap (non-PASS), while findings themselves never abort the run.
- Success criteria: `10c`, `10d` pass; all other tests in the file still pass.
- Verify: `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts` exits 0 with
  `# fail 0`, and `npm run typecheck` exits 0.

### Task 3.5 — Engine unit tests: test the source, drop source-text pins
- Goal: the engine unit test runs against `src/`, and only behavior tests remain.
- Target: `test/unit/layout-integrity-engine.test.mjs`.
- Steps:
  1. Replace the loader (`:14-39`) so it always bundles the source into a temp dir:
     ```js
     import os from 'node:os';
     // Always bundle src/: .compiled/ belongs to the running app and may be stale.
     const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-integrity-test-'));
     const outFile = path.join(outDir, 'layout-integrity-engine.mjs');
     esbuild.buildSync({ entryPoints: [SOURCE_PATH], bundle: true, format: 'esm', platform: 'node', outfile: outFile, logLevel: 'error' });
     const { LayoutIntegrityEngine } = await import(pathToFileURL(outFile).href);
     ```
     Delete `COMPILED_PATH`, `TMP_PATH` and the `let LayoutIntegrityEngine` declaration; keep
     `SOURCE_PATH`.
  2. Delete the tests at `:53-124` (script-source substring checks and the `new Function`
     syntax smoke) and the fake-DOM test `:184-223`.
  3. In the remaining `returns measured:false when documentElement.clientWidth is 0` test, build
     the script with `getBrowserScanScript("a'$&b")` instead of `'active'` and add
     `assert.strictEqual(result.viewport.name, "a'$&b");` (proves the name is injected as a JSON
     literal, with no `$&` expansion and no quote breakage).
  4. Update the header comment (`:1-10`) to say the in-page detectors are verified in real
     Chromium by `npm run test:visual-qa`; this file covers the reader contract, the
     unmeasured marker and viewport-name injection.
- Success criteria: the file passes against the new engine.
- Verify: `node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs` exits 0 with
  `# fail 0`.

### Task 3.6 — Speed and stats on the fixture corpus
- Goal: acceptance criterion 4 holds on the fixtures, and no fixture scan is truncated or loses a
  detector.
- Steps:
  1. Run `npm run test:visual-qa -- --out=<dir>` with a fresh temp dir.
  2. Run `node -e "const r=require('<dir>/results.json');const s=r.map(x=>x.integrity.stats);console.log('maxMs='+Math.max(...s.map(x=>x.durationMs)),'truncated='+s.filter(x=>x.truncated).length,'failed='+s.filter(x=>x.failedDetectors.length).length)"`
     (row shape fixed by Phase 2 Task 2.2 step 5: `integrity` is the raw scan payload).
- Success criteria: `maxMs` ≤ 1200, `truncated=0`, `failed=0`.
- Verify: the printed line, quoted in the phase report.

## Phase exit

- Verify, all exit 0: `npm run test:visual-qa` (`SUMMARY pass=40 fail=0`);
  `npx tsx --test test/unit/theme-qa-fail-closed-adjudication.test.ts`;
  `node --test --test-force-exit test/unit/layout-integrity-engine.test.mjs`;
  `npm run typecheck`. Task 3.6 line quoted in the phase report.

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
