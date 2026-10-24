import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { VisualQualityScanner } from '../../src/main/qa/scanners/visual-quality-scanner';

function findRoot(): string {
  for (let dir = __dirname; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-electron.cjs'))) return dir;
    if (path.dirname(dir) === dir) return process.cwd();
  }
}
const root = findRoot();
const thresholds = { minTextPx: 12, minTapHitPx: 24 };

test('scan script embeds the supplied thresholds and omits them otherwise', () => {
  const withThresholds = VisualQualityScanner.getBrowserScanScript({ thresholds });
  assert.ok(withThresholds.includes('"minTextPx":12'), 'thresholds must reach the in-page script');
  assert.ok(VisualQualityScanner.getBrowserScanScript().includes('"thresholds":null'), 'no thresholds means the registry rules do not run');
  assert.doesNotThrow(() => new Function(withThresholds), 'scan script must compile');
});

test('scan script rejects a thresholds object with a missing or non-positive value', () => {
  assert.throws(() => VisualQualityScanner.getBrowserScanScript({ thresholds: { ...thresholds, minTapHitPx: 0 } }), /minTapHitPx/);
  assert.throws(() => VisualQualityScanner.getBrowserScanScript({ thresholds: { minTextPx: 12 } as never }), /minTapHitPx/);
});

test('normalize keeps the rule coverage lists and defaults them for a result without them', () => {
  const withLists = VisualQualityScanner.normalize({
    measured: true,
    viewport: { width: 375, height: 667 },
    mobile: true,
    findings: [],
    stats: { measuredRules: ['contrast-low'], unmeasuredRules: ['font-below-min'] },
  });
  assert.deepEqual(withLists.stats.measuredRules, ['contrast-low']);
  assert.deepEqual(withLists.stats.unmeasuredRules, ['font-below-min']);
  const bare = VisualQualityScanner.normalize({ measured: true, viewport: { width: 1, height: 1 }, mobile: false, findings: [], stats: {} });
  assert.deepEqual(bare.stats.measuredRules, []);
  assert.deepEqual(bare.stats.unmeasuredRules, []);
});

type JsdomCtor = new (html: string, options?: Record<string, unknown>) => {
  window: Window & typeof globalThis & { eval: (src: string) => unknown };
};

function loadJsdom(): JsdomCtor {
  const req = createRequire(__filename);
  const searchPaths = process.env.ANTIFAN_JSDOM ? [process.env.ANTIFAN_JSDOM, __dirname] : [__dirname];
  // jsdom ships no bundled types; the module is asserted to its documented export shape.
  return (req(req.resolve('jsdom', { paths: searchPaths })) as { JSDOM: JsdomCtor }).JSDOM;
}

// The build-strict responsive sweep pastes the skipFloating script into a synchronous
// expression, so a scan that never scrolls must hand back its reading, not a Promise.
test('a scan that never scrolls returns its reading synchronously', () => {
  const JSDOM = loadJsdom();
  const dom = new JSDOM('<!doctype html><html lang="vi"><body><main><a href="/a">Liên hệ</a></main></body></html>', { runScripts: 'outside-only' });
  for (const options of [{ thresholds, skipFloating: true }, { thresholds, skipPageEnd: true }]) {
    const reading = dom.window.eval(VisualQualityScanner.getBrowserScanScript(options)) as { then?: unknown };
    assert.notEqual(typeof reading.then, 'function', `${JSON.stringify(Object.keys(options))} must not return a thenable`);
    assert.equal(VisualQualityScanner.normalize(reading).measured, true);
  }
});

// Real browser pass over the kit pages: a 16px swatch whose ::before reaches 24px passes, a 16px
// target without a hit area does not.
test('tap target hit area: pseudo-element hit area counts (Electron probe)', (t) => {
  const run = spawnSync(process.execPath, ['scripts/run-electron.cjs', 'test/e2e/visual-quality-fixtures-probe.cjs', '--only=tap-target-hit-area'], {
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
  assert.match(output, /SUMMARY fixtures=2 pass=2 fail=0/);
});
