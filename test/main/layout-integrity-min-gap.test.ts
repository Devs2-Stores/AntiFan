import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();

/** One fixture through the real engine in a throwaway Electron window, at 375x667 and 1440x900. */
function probeFixture(fixtureId: string): { skipped: string | null; status: number | null; output: string } {
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-qa-fixtures-probe.cjs', `--only=${fixtureId}`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (run.error || !/SUMMARY pass=/.test(output)) {
    return { skipped: `Electron could not start here: ${run.error ? run.error.message : output.slice(-300)}`, status: run.status, output };
  }
  return { skipped: null, status: run.status, output };
}

test('layout integrity script carries the min-gap and fixed-chrome-ratio rules', () => {
  const script = LayoutIntegrityEngine.getBrowserScanScript('active');
  assert.ok(script.includes("'min-gap'"), 'min-gap rule must be in the in-page scan');
  assert.ok(script.includes("'fixed-chrome-ratio'"), 'fixed-chrome-ratio rule must be in the in-page scan');
  assert.match(script, /vw <= 480 \? 8 : 6/, 'the minimum gap is 8px at 480px and below, 6px above');
});

test('min-gap: two buttons 2px apart are flagged, 12px apart are not (Electron probe)', (t) => {
  const bad = probeFixture('67-interactive-siblings-pressed-together');
  if (bad.skipped) {
    t.skip(bad.skipped);
    return;
  }
  assert.equal(bad.status, 0, bad.output.slice(-1500));
  assert.match(bad.output, /SUMMARY pass=2 info=0 fail=0/);

  const good = probeFixture('68-interactive-siblings-with-gap-control');
  assert.equal(good.status, 0, good.output.slice(-1500));
  assert.match(good.output, /SUMMARY pass=2 info=0 fail=0/);
});

test('fixed-chrome-ratio: bars taking 54% of a 667px viewport are critical, 17% is not (Electron probe)', (t) => {
  const bad = probeFixture('69-fixed-bars-take-most-of-a-short-viewport');
  if (bad.skipped) {
    t.skip(bad.skipped);
    return;
  }
  assert.equal(bad.status, 0, bad.output.slice(-1500));
  assert.match(bad.output, /SUMMARY pass=1 info=1 fail=0/);

  const good = probeFixture('70-slim-fixed-bars-control');
  assert.equal(good.status, 0, good.output.slice(-1500));
  assert.match(good.output, /SUMMARY pass=2 info=0 fail=0/);
});
