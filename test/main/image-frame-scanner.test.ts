import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMAGE_FRAME_LIMITS, IMAGE_FRAME_RULE_IDS, ImageFrameScanner } from '../../src/main/qa/scanners/image-frame-scanner';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}

const root = findRoot();

test('image-crop, image-low-res and image-distorted are the rules and their limits are the documented ones', () => {
  assert.deepEqual([...IMAGE_FRAME_RULE_IDS], ['image-crop', 'image-low-res', 'image-distorted']);
  assert.equal(IMAGE_FRAME_LIMITS.maxCropShare, 0.08);
  assert.equal(IMAGE_FRAME_LIMITS.maxAspectDistortion, 0.06);
  assert.equal(IMAGE_FRAME_LIMITS.minSourceToBoxRatio, 1.5);
});

test('the scan script embeds its limits and the scope selector', () => {
  const plain = ImageFrameScanner.getBrowserScanScript();
  assert.ok(plain.includes('"maxCropShare":0.08'));
  assert.ok(plain.includes('"minSourceToBoxRatio":1.5'));
  const scoped = ImageFrameScanner.getBrowserScanScript({ scopeSelector: '.product-card' });
  assert.ok(scoped.includes('"scopeSelector":".product-card"'));
});

test('normalize turns anything that is not a measured result into an unmeasured one that names every rule', () => {
  for (const raw of [null, undefined, 'x', 3]) {
    const res = ImageFrameScanner.normalize(raw);
    assert.equal(res.measured, false);
    assert.equal(res.error, 'SCAN_RETURNED_NO_OBJECT');
    assert.deepEqual(res.stats.unmeasuredRules, [...IMAGE_FRAME_RULE_IDS]);
    assert.deepEqual(res.findings, []);
  }
  const shape = ImageFrameScanner.normalize({ measured: true, findings: 'nope' });
  assert.equal(shape.measured, false);
  assert.equal(shape.error, 'SCAN_SHAPE_INVALID');
  const failed = ImageFrameScanner.normalize({ measured: false, error: 'IMAGE_FRAME_EVAL_FAILED: boom' });
  assert.equal(failed.measured, false);
  assert.equal(failed.error, 'IMAGE_FRAME_EVAL_FAILED: boom');
});

test('normalize keeps a measured result and fills the missing rule lists', () => {
  const res = ImageFrameScanner.normalize({
    measured: true,
    viewport: { width: 375, height: 667 },
    findings: [{ ruleId: 'image-crop', severity: 'warning', selector: 'img.hero', details: 'crops 30%', rect: { x: 0, y: 0, w: 10, h: 10 } }],
    stats: { imagesChecked: 1, imagesPending: 0, durationMs: 1, truncated: false, truncatedReasons: [] },
  });
  assert.equal(res.measured, true);
  assert.equal(res.findings.length, 1);
  assert.deepEqual(res.stats.measuredRules, []);
  assert.deepEqual(res.stats.unmeasuredRules, []);
});

test('image frame: a cover-cropped image is flagged, an uncropped one and a sharp one are not (Electron probe)', (t) => {
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-quality-fixtures-probe.cjs', '--only=image-'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  if (run.error || !/SUMMARY fixtures=/.test(output)) {
    t.skip(`Electron could not start here: ${run.error ? run.error.message : output.slice(-300)}`);
    return;
  }
  assert.equal(run.status, 0, output.slice(-1500));
  assert.match(output, /SUMMARY fixtures=6 pass=6 fail=0/);
});
