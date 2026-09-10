import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { HARNESS_RESIDUE_MARKERS, detectHarnessResidue, detectLostLayoutSwitch } from '../../scripts/lib/bundle-integrity.mjs';

function withFixtures(files, run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'antifan-bundle-integrity-'));
  try {
    const written = {};
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(dir, name);
      writeFileSync(file, content);
      written[name] = file;
    }
    return run(written);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('detectHarnessResidue reports every harness marker it finds', () => {
  withFixtures({
    'bundle.html': '<html><body><div data-antifan-pinned="motion" style="left:0!important"></div><form data-antifan-pw-hooked="1"></form></body></html>',
  }, ({ 'bundle.html': bundle }) => {
    assert.deepStrictEqual(detectHarnessResidue(bundle), ['data-antifan-pinned', 'data-antifan-pw-hooked']);
  });
});

test('detectHarnessResidue accepts the clone runtime attributes as content', () => {
  withFixtures({
    'bundle.html': '<html><body><div data-antifan-hover data-antifan-dropdown-panel data-antifan-modal data-antifan-src="https://example.com/x.png"></div></body></html>',
  }, ({ 'bundle.html': bundle }) => {
    assert.deepStrictEqual(detectHarnessResidue(bundle), []);
  });
});

test('detectHarnessResidue reports an unreadable entry instead of assuming it is clean', () => {
  const missing = path.join(os.tmpdir(), 'antifan-bundle-integrity-absent', 'nope.html');
  const result = detectHarnessResidue(missing);
  assert.strictEqual(result.length, 1);
  assert.match(result[0], /^entry-unreadable:/);
});

test('detectLostLayoutSwitch names the body attribute the bundle dropped', () => {
  withFixtures({
    'dump.html': '<html lang="vi"><body data-device="mobile" class="device-phone">x</body></html>',
    'lost.html': '<html lang="vi"><body class="device-phone">x</body></html>',
    'kept.html': '<html lang="vi"><body data-device="mobile" class="device-phone">x</body></html>',
    'inert-marker.html': '<html lang="vi"><body data-device="mobile" data-antifan-pw-hooked="1">x</body></html>',
  }, (files) => {
    assert.deepStrictEqual(detectLostLayoutSwitch(files['dump.html'], files['lost.html']), ['data-device']);
    assert.deepStrictEqual(detectLostLayoutSwitch(files['dump.html'], files['kept.html']), []);
    assert.deepStrictEqual(detectLostLayoutSwitch(files['dump.html'], files['inert-marker.html']), [],
      'a harness attribute in the bundle is not a missing layout switch');
  });
});

test('detectLostLayoutSwitch requires no attribute the source never declared', () => {
  withFixtures({
    'dump.html': '<html><body data-device="web" data-antifan-pinned="layout">x</body></html>',
    'bare.html': '<html><body>x</body></html>',
    'no-body.html': '<html><head></head></html>',
  }, (files) => {
    assert.deepStrictEqual(detectLostLayoutSwitch(files['dump.html'], files['bare.html']), ['data-device'],
      'harness markers on the source body are not part of the expectation');
    assert.deepStrictEqual(detectLostLayoutSwitch(files['no-body.html'], files['bare.html']), []);
  });
});

test('HARNESS_RESIDUE_MARKERS stays a curated list, not a prefix rule', () => {
  assert.ok(HARNESS_RESIDUE_MARKERS.includes('data-antifan-pinned'));
  assert.ok(!HARNESS_RESIDUE_MARKERS.some((marker) => marker === 'data-antifan-'));
});
