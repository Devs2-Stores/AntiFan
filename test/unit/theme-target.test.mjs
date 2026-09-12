import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveThemeId, DEFAULT_THEME_ID, PROTECTED_THEME_IDS } from '../../scripts/lib/theme-target.mjs';

test('resolveThemeId falls back to the theme under work when the environment is silent', () => {
  assert.equal(resolveThemeId({}), DEFAULT_THEME_ID);
  assert.equal(resolveThemeId({ HARAVAN_THEME_ID: '   ' }), DEFAULT_THEME_ID);
});

test('resolveThemeId honours an explicit staging theme', () => {
  assert.equal(resolveThemeId({ HARAVAN_THEME_ID: '1001514194' }), '1001514194');
  assert.equal(resolveThemeId({ HARAVAN_THEME_ID: ' 987654 ' }), '987654');
});

test('resolveThemeId refuses the protected live theme', () => {
  for (const id of PROTECTED_THEME_IDS) {
    assert.throws(() => resolveThemeId({ HARAVAN_THEME_ID: id }), /protected live theme/);
    assert.notEqual(id, DEFAULT_THEME_ID, 'the default must never be the protected theme');
  }
});

test('resolveThemeId refuses values that are not numeric theme ids', () => {
  for (const value of ['abc', '1001514194;rm', '-1', '1.5', '0x10']) {
    assert.throws(() => resolveThemeId({ HARAVAN_THEME_ID: value }), /numeric theme id/);
  }
});
