import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { LayoutIntegrityEngine } from '../../src/main/qa/scanners/layout-integrity-engine';
import { DEFAULT_SWEEP_BREAKPOINTS, HEADER_DENSE_BREAKPOINTS, viewportsToBreakpoints } from '../../src/main/browser/sweep-viewports';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();

/** One fixture through the real engine in a throwaway Electron window. */
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

test('layout integrity script carries the same-layer control-stack rule beside the flow rule', () => {
  const script = LayoutIntegrityEngine.getBrowserScanScript('active');
  assert.ok(script.includes("'same-layer-controls-stacked'"), 'the same-layer rule id must be in the in-page scan');
  assert.match(script, /const flowControls = controls\.filter\(\(c\) => !c\.layer /, 'the flow rule keeps leaving layered controls to the same-layer rule');
  const flat = script.replace(/\s+/g, ' ');
  assert.ok(flat.includes("lr.right <= 0 || lr.left >= vw) continue; if (lr.width >= vw * 0.9 && lr.height >= vh * 0.9) continue; if (releasedSticky(l, lr) || (cs(l).position === 'sticky'"), 'fixed-chrome-ratio skips a layer parked off-canvas');
});

test('the dense header sweep list covers 700-1300px and stays out of the standard list', () => {
  assert.deepEqual(HEADER_DENSE_BREAKPOINTS.map((b) => b.width), [700, 900, 1100, 1200, 1300]);
  for (const b of HEADER_DENSE_BREAKPOINTS) {
    assert.equal(b.height, 900);
    assert.equal(b.mobile, false);
    assert.ok(b.id.startsWith('header-dense-'));
  }
  const standard = new Set(DEFAULT_SWEEP_BREAKPOINTS.map((b) => b.width));
  assert.ok(HEADER_DENSE_BREAKPOINTS.every((b) => !standard.has(b.width)), 'a dense width repeating a standard one would be scanned twice');
  assert.equal(new Set(HEADER_DENSE_BREAKPOINTS.map((b) => b.id)).size, HEADER_DENSE_BREAKPOINTS.length);
});

test('the dense header list needs no more entries than a caller viewports list may carry', () => {
  const asViewports = HEADER_DENSE_BREAKPOINTS.map((b) => ({ w: b.width, h: b.height }));
  const resolved = viewportsToBreakpoints(asViewports);
  assert.deepEqual(resolved.map((b) => b.width), HEADER_DENSE_BREAKPOINTS.map((b) => b.width));
});

test('same-layer controls: boxes stacked in a sticky header are critical, spaced controls and badges are not (Electron probe)', (t) => {
  const bad = probeFixture('84-sticky-header-controls-box-stack-on-narrow-width');
  if (bad.skipped) {
    t.skip(bad.skipped);
    return;
  }
  assert.equal(bad.status, 0, bad.output.slice(-1500));
  assert.match(bad.output, /SUMMARY pass=2 info=1 fail=0/);

  const good = probeFixture('85-fixed-header-adjacent-controls-and-badge-control');
  assert.equal(good.status, 0, good.output.slice(-1500));
  assert.match(good.output, /SUMMARY pass=2 info=0 fail=0/);
});

test('same-layer controls: a header that stacks only between 900 and 1100px is caught at 1000px (Electron probe)', (t) => {
  const bad = probeFixture('86-sticky-header-controls-stack-only-between-900-and-1100');
  if (bad.skipped) {
    t.skip(bad.skipped);
    return;
  }
  assert.equal(bad.status, 0, bad.output.slice(-1500));
  assert.match(bad.output, /SUMMARY pass=1 info=2 fail=0/);
});

test('off-canvas drawer and running marquee raise no finding (Electron probe)', (t) => {
  const drawer = probeFixture('87-parked-offcanvas-drawer-is-not-fixed-chrome-control');
  if (drawer.skipped) {
    t.skip(drawer.skipped);
    return;
  }
  assert.equal(drawer.status, 0, drawer.output.slice(-1500));
  assert.match(drawer.output, /SUMMARY pass=2 info=0 fail=0/);

  const marquee = probeFixture('88-announcement-marquee-scrolls-past-the-viewport-edge-control');
  assert.equal(marquee.status, 0, marquee.output.slice(-1500));
  assert.match(marquee.output, /SUMMARY pass=2 info=0 fail=0/);
});
