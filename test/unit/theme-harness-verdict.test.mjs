/**
 * Theme harness verdict contract: every layer emits the same observable shape
 * and every verdict carries the evidence tier it was measured under, so an
 * offline scan can never read as a live measurement. Also covers binding
 * resolution (env over the gitignored .haravan-cli_local.json) and themeid
 * route pinning.
 *
 * Run with:
 *   node --test --test-force-exit test/unit/theme-harness-verdict.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EVIDENCE_TIERS,
  LAYERS,
  VERDICTS,
  blockedVerdict,
  makeVerdict,
  overallVerdict,
} from '../../scripts/theme-harness/verdict.mjs';
import {
  pinnedRouteUrl,
  readBindingFile,
  resolveThemeBinding,
} from '../../scripts/theme-harness/binding.mjs';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'theme-harness-test-'));
}

test('makeVerdict emits the contract shape with tier and measuredAt', () => {
  const verdict = makeVerdict({ layer: LAYERS.L0, tier: 'OFFLINE_STATIC', verdict: 'PASS' });
  assert.equal(verdict.layer, 'L0-offline-static');
  assert.equal(verdict.tier, 'OFFLINE_STATIC');
  assert.equal(verdict.verdict, 'PASS');
  assert.ok(Number.isFinite(Date.parse(verdict.measuredAt)));
  assert.deepEqual(verdict.blockedReasons, []);
  assert.deepEqual(verdict.limits, []);
  assert.deepEqual(verdict.checks, {});
});

test('makeVerdict refuses unknown layers, tiers and verdicts', () => {
  assert.throws(() => makeVerdict({ layer: 'L9', tier: 'OFFLINE_STATIC', verdict: 'PASS' }), /unknown harness layer/);
  assert.throws(() => makeVerdict({ layer: LAYERS.L0, tier: 'LIVE', verdict: 'PASS' }), /unknown evidence tier/);
  assert.throws(() => makeVerdict({ layer: LAYERS.L0, tier: 'OFFLINE_STATIC', verdict: 'GREEN' }), /unknown verdict/);
});

test('a BLOCKED verdict must name its reasons', () => {
  assert.throws(
    () => makeVerdict({ layer: LAYERS.L2, tier: 'BLOCKED', verdict: 'BLOCKED' }),
    /blockedReasons/,
  );
  const verdict = blockedVerdict(LAYERS.L2, 'BLOCKED', ['user-approval: missing']);
  assert.equal(verdict.verdict, 'BLOCKED');
  assert.deepEqual(verdict.blockedReasons, ['user-approval: missing']);
});

test('overallVerdict folds FAIL over everything and never inflates gated layers', () => {
  const pass = makeVerdict({ layer: LAYERS.L0, tier: 'OFFLINE_STATIC', verdict: 'PASS' });
  const fail = makeVerdict({ layer: LAYERS.L1, tier: 'LIVE_PUBLISHED', verdict: 'FAIL' });
  const blocked = blockedVerdict(LAYERS.L2, 'BLOCKED', ['prereq']);
  const inconclusive = makeVerdict({ layer: LAYERS.L1, tier: 'LIVE_PUBLISHED', verdict: 'INCONCLUSIVE' });

  assert.equal(overallVerdict([pass, pass]), 'PASS');
  assert.equal(overallVerdict([pass, fail, blocked]), 'FAIL');
  assert.equal(overallVerdict([blocked, blocked]), 'BLOCKED');
  // The gated-L2 case: proven layers pass, working tree unproven -> INCONCLUSIVE.
  assert.equal(overallVerdict([pass, pass, blocked]), 'INCONCLUSIVE');
  assert.equal(overallVerdict([pass, inconclusive]), 'INCONCLUSIVE');
});

test('EVIDENCE_TIERS and VERDICTS are the published vocabulary', () => {
  assert.deepEqual([...EVIDENCE_TIERS], ['OFFLINE_STATIC', 'LIVE_PUBLISHED', 'WORKING_TREE', 'BLOCKED']);
  assert.deepEqual([...VERDICTS], ['PASS', 'FAIL', 'INCONCLUSIVE', 'BLOCKED']);
});

test('readBindingFile reads org/theme ids and reports absence without throwing', () => {
  const dir = tmpDir();
  const missing = readBindingFile(dir);
  assert.equal(missing.present, false);
  assert.equal(missing.themeId, null);

  fs.writeFileSync(path.join(dir, '.haravan-cli_local.json'), JSON.stringify({
    org_id: '1000405253',
    theme_id: '1001357480',
    theme_name: 'Hrv Glasses',
  }));
  const bound = readBindingFile(dir);
  assert.equal(bound.present, true);
  assert.equal(bound.orgId, '1000405253');
  assert.equal(bound.themeId, '1001357480');
  assert.equal(bound.themeName, 'Hrv Glasses');

  fs.writeFileSync(path.join(dir, '.haravan-cli_local.json'), '{not json');
  const corrupt = readBindingFile(dir);
  assert.equal(corrupt.present, true);
  assert.match(corrupt.error, /unreadable/);
});

test('resolveThemeBinding lets env override the binding file and names what is missing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.haravan-cli_local.json'), JSON.stringify({
    org_id: '111', theme_id: '222', theme_name: 'x',
  }));

  const fromFile = resolveThemeBinding({ themeDir: dir, env: {} });
  assert.equal(fromFile.themeId, '222');
  assert.equal(fromFile.orgId, '111');
  assert.equal(fromFile.source, 'binding-file');
  assert.deepEqual(fromFile.missing, []);

  const fromEnv = resolveThemeBinding({
    themeDir: dir,
    env: { HARAVAN_THEME_ID: '999', HARAVAN_ORG_ID: '888' },
  });
  assert.equal(fromEnv.themeId, '999');
  assert.equal(fromEnv.orgId, '888');
  assert.equal(fromEnv.source, 'env');

  const bare = resolveThemeBinding({ themeDir: tmpDir(), env: {} });
  assert.equal(bare.themeId, null);
  assert.deepEqual(bare.missing.sort(), ['org-id', 'theme-id']);
});

test('pinnedRouteUrl sets themeid without clobbering the route query', () => {
  assert.equal(
    pinnedRouteUrl('https://shop.example', '/search?q=a&view=smart', '1001357480'),
    'https://shop.example/search?q=a&view=smart&themeid=1001357480',
  );
  assert.equal(
    pinnedRouteUrl('https://shop.example', '/', '1001357480'),
    'https://shop.example/?themeid=1001357480',
  );
  // An existing themeid is replaced, never duplicated.
  assert.equal(
    pinnedRouteUrl('https://shop.example', '/?themeid=1', '2'),
    'https://shop.example/?themeid=2',
  );
});
