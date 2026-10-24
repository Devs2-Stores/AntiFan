import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { DEFAULT_SWEEP_BREAKPOINTS } from '../../src/main/browser/sweep-viewports';
import { QA_RESPONSIVE_WIDTHS } from '../../src/main/qa/theme-qa-workflow';
import { LayoutOverflowEngine } from '../../src/main/qa/scanners/layout-overflow-engine';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();

/** One fixture through the real engine in a throwaway Electron window, at 375, 1440 and 1920 wide. */
function probeFixture(fixtureId: string): { skipped: string | null; status: number | null; output: string } {
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-qa-fixtures-probe.cjs', `--only=${fixtureId}`], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (run.error && (run.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT') {
    return { skipped: `Electron could not start here: ${run.error.message}`, status: run.status, output };
  }
  if (/\[run-electron\] (spawn failed|refusing to start)/.test(output)) {
    return { skipped: `Electron could not start here: ${output.slice(-300)}`, status: run.status, output };
  }
  assert.match(output, /SUMMARY pass=/, `probe died before its SUMMARY (status ${run.status}); output tail:\n${output.slice(-1500)}`);
  return { skipped: null, status: run.status, output };
}

test('the standard sweep covers the wide desktop widths in every width list', () => {
  const widths = DEFAULT_SWEEP_BREAKPOINTS.map((b) => b.width);
  assert.ok(widths.includes(1920) && widths.includes(2560), `sweep widths: ${widths.join(',')}`);
  assert.deepEqual([...QA_RESPONSIVE_WIDTHS], widths, 'the per-width map follows the sweep, not a second list');
  assert.deepEqual(LayoutOverflowEngine.BREAKPOINTS.map((b) => b.width).sort((a, b) => a - b), [...widths].sort((a, b) => a - b));
});

test('layout integrity script carries the content-drift rule and its tolerance', () => {
  const script = LayoutIntegrityEngine.getBrowserScanScript('active');
  assert.ok(script.includes("'content-drift'"), 'content-drift rule must be in the in-page scan');
  assert.match(script, /Math\.max\(24, vw \* 0\.02\)/, 'tolerance is max(24px, 2% of the viewport)');
  assert.match(script, /DRIFT_MIN_INSET = 48/, 'a container under 48px from the edge is not graded');
});

test('content-drift: hero padded at x=64 beside a centred 1540px container is flagged at 1920; bleed media and contained sections are not (Electron probe)', (t) => {
  const bad = probeFixture('73-wide-hero-padded-instead-of-container');
  if (bad.skipped) {
    t.skip(bad.skipped);
    return;
  }
  assert.equal(bad.status, 0, bad.output.slice(-1500));
  assert.match(bad.output, /wide 73-wide-hero-padded-instead-of-container PASS crit=0 warn=1/);
  assert.match(bad.output, /SUMMARY pass=1 info=2 fail=0/);

  const good = probeFixture('74-wide-bleed-media-and-contained-sections-control');
  assert.equal(good.status, 0, good.output.slice(-1500));
  assert.match(good.output, /wide 74-wide-bleed-media-and-contained-sections-control PASS crit=0 warn=0/);
  assert.match(good.output, /SUMMARY pass=3 info=0 fail=0/);
});

test('content-drift: header and footer in the 1540px container beside narrower section wrappers are not flagged at 1440 or 1920 (Electron probe)', (t) => {
  const control = probeFixture('75-wide-narrow-section-wrappers-beside-shell-control');
  if (control.skipped) {
    t.skip(control.skipped);
    return;
  }
  assert.equal(control.status, 0, control.output.slice(-1500));
  assert.match(control.output, /desktop 75-wide-narrow-section-wrappers-beside-shell-control PASS crit=0 warn=0/);
  assert.match(control.output, /wide 75-wide-narrow-section-wrappers-beside-shell-control PASS crit=0 warn=0/);
  assert.match(control.output, /SUMMARY pass=3 info=0 fail=0/);
});
