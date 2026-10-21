// inherited-profile-guard.test.mjs — the launcher refuses a product launch whose environment
// moves the data root away from the installation default, unless the caller isolated on purpose.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkInheritedProfile } = require('../../scripts/lib/inherited-profile-guard.cjs');

const DEFAULT_ROOT = 'E:\\Work\\.antifan-data';
const SCRATCH_ROOT = 'E:\\Work\\scratch\\ab-tmp-261020\\data';

function check(env, overrides = {}) {
  return checkInheritedProfile({
    env,
    defaultDataRoot: DEFAULT_ROOT,
    platform: 'win32',
    productLaunch: true,
    ...overrides,
  });
}

test('a clean environment on a product launch is allowed', () => {
  assert.deepEqual(check({}), { ok: true });
});

test('a scratch ANTIFAN_DATA_ROOT on a product launch is refused and the message names the variable', () => {
  const verdict = check({ ANTIFAN_DATA_ROOT: SCRATCH_ROOT });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.variable, 'ANTIFAN_DATA_ROOT');
  assert.equal(verdict.value, SCRATCH_ROOT);
  assert.equal(verdict.defaultDataRoot, DEFAULT_ROOT);
  assert.match(verdict.message, /ANTIFAN_DATA_ROOT/);
  assert.match(verdict.message, /ab-tmp-261020/);
  assert.match(verdict.message, /unset ANTIFAN_DATA_ROOT/);
  assert.match(verdict.message, /ANTIFAN_ALLOW_ALT_DATA_ROOT=1/);
});

test('a scratch user-data override is refused for both variable spellings', () => {
  for (const variable of ['ANTIFAN_USER_DATA', 'ANTIFAN_USER_DATA_DIR']) {
    const verdict = check({ [variable]: `${SCRATCH_ROOT}\\profile` });
    assert.equal(verdict.ok, false, variable);
    assert.equal(verdict.variable, variable);
  }
});

test('the lane isolation marker allows the same environment', () => {
  const verdict = check({ ANTIFAN_DATA_ROOT: SCRATCH_ROOT, ANTIFAN_FAIL_ON_LOCK_CONTENTION: '1' });
  assert.deepEqual(verdict, { ok: true });
});

test('the explicit alternate-root marker allows the same environment', () => {
  const verdict = check({ ANTIFAN_DATA_ROOT: SCRATCH_ROOT, ANTIFAN_ALLOW_ALT_DATA_ROOT: '1' });
  assert.deepEqual(verdict, { ok: true });
});

test('a marker that is not exactly "1" does not count as isolation', () => {
  const verdict = check({ ANTIFAN_DATA_ROOT: SCRATCH_ROOT, ANTIFAN_ALLOW_ALT_DATA_ROOT: '0' });
  assert.equal(verdict.ok, false);
});

test('a script launch that is not the app itself is never checked', () => {
  const verdict = check({ ANTIFAN_DATA_ROOT: SCRATCH_ROOT }, { productLaunch: false });
  assert.deepEqual(verdict, { ok: true });
});

test('an ANTIFAN_DATA_ROOT equal to the default differing only by case on win32 is allowed', () => {
  const verdict = check({ ANTIFAN_DATA_ROOT: 'e:\\work\\.ANTIFAN-data\\' });
  assert.deepEqual(verdict, { ok: true });
});

test('the same case difference is a different root on a case-sensitive platform', () => {
  const verdict = checkInheritedProfile({
    env: { ANTIFAN_DATA_ROOT: '/data/ANTIFAN' },
    defaultDataRoot: '/data/antifan',
    platform: 'linux',
    productLaunch: true,
  });
  assert.equal(verdict.ok, false);
});

test('a user-data override equal to the default Profile directory is allowed', () => {
  const verdict = check({ ANTIFAN_USER_DATA: `${DEFAULT_ROOT}\\Profile` });
  assert.deepEqual(verdict, { ok: true });
});

test('the default data root is only resolved when a variable needs comparing', () => {
  let resolved = 0;
  const defaultDataRoot = () => { resolved += 1; return DEFAULT_ROOT; };
  checkInheritedProfile({ env: {}, defaultDataRoot, platform: 'win32', productLaunch: true });
  checkInheritedProfile({
    env: { ANTIFAN_DATA_ROOT: SCRATCH_ROOT, ANTIFAN_FAIL_ON_LOCK_CONTENTION: '1' },
    defaultDataRoot,
    platform: 'win32',
    productLaunch: true,
  });
  assert.equal(resolved, 0);
  const verdict = checkInheritedProfile({
    env: { ANTIFAN_DATA_ROOT: SCRATCH_ROOT },
    defaultDataRoot,
    platform: 'win32',
    productLaunch: true,
  });
  assert.equal(verdict.ok, false);
  assert.equal(resolved, 1);
});

test('blank variable values are ignored', () => {
  assert.deepEqual(check({ ANTIFAN_DATA_ROOT: '  ' }), { ok: true });
});
