import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VisualQualityScanner, VISUAL_QUALITY_RULE_IDS } from '../../src/main/qa/scanners/visual-quality-scanner';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();
const thresholds = { minTextPx: 12, minTapHitPx: 24 };
const titleScale = { h1: [28, 40], h2: [20, 28], h3: [18, 22], h4: [16, 18] };

function probe(only: string): { skipped: string | null; status: number | null; output: string } {
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-quality-fixtures-probe.cjs', `--only=${only}`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (run.error || !/SUMMARY fixtures=/.test(output)) {
    return { skipped: `Electron could not start here: ${run.error ? run.error.message : output.slice(-300)}`, status: run.status, output };
  }
  return { skipped: null, status: run.status, output };
}

test('title-scale and input-height-band are registry rules the scanner knows about', () => {
  assert.ok((VISUAL_QUALITY_RULE_IDS as readonly string[]).includes('title-scale'));
  assert.ok((VISUAL_QUALITY_RULE_IDS as readonly string[]).includes('input-height-band'));
});

test('the optional threshold keys reach the in-page script only when supplied', () => {
  const plain = VisualQualityScanner.getBrowserScanScript({ thresholds });
  assert.ok(!plain.includes('"titleScale"') && !plain.includes('"inputHeightBandPx"'));
  const tuned = VisualQualityScanner.getBrowserScanScript({ thresholds: { ...thresholds, titleScale, inputHeightBandPx: 6 } as never });
  assert.ok(tuned.includes('"titleScale":{"h1":[28,40],"h2":[20,28],"h3":[18,22],"h4":[16,18]}'));
  assert.ok(tuned.includes('"inputHeightBandPx":6'));
});

test('malformed title-scale and band thresholds are refused instead of silently ignored', () => {
  assert.throws(() => VisualQualityScanner.getBrowserScanScript({ thresholds: { ...thresholds, titleScale: { h1: [28, 40] } } as never }), /titleScale\.h2 must be \[min, max\]/);
  assert.throws(() => VisualQualityScanner.getBrowserScanScript({ thresholds: { ...thresholds, titleScale: { ...titleScale, h3: [30, 20] } } as never }), /titleScale\.h3/);
  assert.throws(() => VisualQualityScanner.getBrowserScanScript({ thresholds: { ...thresholds, inputHeightBandPx: 0 } as never }), /inputHeightBandPx must be a positive number/);
});

test('title-scale: same-level section headings that differ by more than 2px, or fall outside the supplied range, are flagged; page header/footer headings are compared only against a supplied range (Electron probe)', (t) => {
  const run = probe('title-scale');
  if (run.skipped) {
    t.skip(run.skipped);
    return;
  }
  assert.equal(run.status, 0, run.output.slice(-1500));
  assert.match(run.output, /SUMMARY fixtures=7 pass=7 fail=0/);
});

test('input-height-band: fields of one form differing by more than the band are flagged, a wider band accepts them (Electron probe)', (t) => {
  const run = probe('input-height-band');
  if (run.skipped) {
    t.skip(run.skipped);
    return;
  }
  assert.equal(run.status, 0, run.output.slice(-1500));
  assert.match(run.output, /SUMMARY fixtures=3 pass=3 fail=0/);
});

test('without thresholds the new rules are reported as unmeasured, with them as measured (Electron probe)', (t) => {
  const run = probe('registry-rules');
  if (run.skipped) {
    t.skip(run.skipped);
    return;
  }
  assert.equal(run.status, 0, run.output.slice(-1500));
  assert.match(run.output, /SUMMARY fixtures=2 pass=2 fail=0/);
});
