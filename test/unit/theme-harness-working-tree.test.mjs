// L2 is the one layer that can mutate a remote theme, so its gate is the
// harness's safety boundary: it must refuse unless every prerequisite is
// individually satisfied, and it must never accept the live theme as a push
// target. These tests pin that behaviour, not the gate's internal shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ENV_DEV_THEME_ID,
  ENV_PUSH_APPROVED,
  WATCH_STATE_FILE,
  evaluateWorkingTreeGate,
} from '../../scripts/theme-harness/working-tree.mjs';

const LIVE_THEME_ID = '1001357480';

function makeThemeDir({ withWatcher = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-harness-wt-'));
  if (withWatcher) fs.writeFileSync(path.join(dir, WATCH_STATE_FILE), '{"bound":true}');
  return dir;
}

function gate(themeDir, env) {
  return evaluateWorkingTreeGate({ themeDir, liveThemeId: LIVE_THEME_ID, env });
}

test('L2 refuses to open with no prerequisites set', () => {
  const result = gate(makeThemeDir(), {});
  assert.equal(result.open, false);
  assert.equal(result.devThemeId, null);
  const unsatisfied = result.prerequisites.filter((p) => !p.satisfied).map((p) => p.id);
  assert.deepEqual(unsatisfied, ['unpublished-theme-id', 'user-approval', 'watcher-active']);
});

test('L2 refuses a push target that is the live theme, even when approved', () => {
  const themeDir = makeThemeDir({ withWatcher: true });
  const result = gate(themeDir, {
    [ENV_DEV_THEME_ID]: LIVE_THEME_ID,
    [ENV_PUSH_APPROVED]: '1',
  });
  assert.equal(result.open, false);
  assert.equal(result.devThemeId, null);
  const themeId = result.prerequisites.find((p) => p.id === 'unpublished-theme-id');
  assert.equal(themeId.satisfied, false);
  assert.match(themeId.detail, /never push|main is refused|live theme/i);
});

test('L2 refuses approval alone without an unpublished theme id', () => {
  const result = gate(makeThemeDir({ withWatcher: true }), { [ENV_PUSH_APPROVED]: '1' });
  assert.equal(result.open, false);
  assert.equal(result.devThemeId, null);
});

test('L2 refuses a destructive push until approval is explicitly recorded', () => {
  const themeDir = makeThemeDir({ withWatcher: true });
  const result = gate(themeDir, { [ENV_DEV_THEME_ID]: '1001357481' });
  assert.equal(result.open, false);
  const approval = result.prerequisites.find((p) => p.id === 'user-approval');
  assert.equal(approval.satisfied, false);
  assert.match(approval.detail, /approval/i);
});

test('L2 refuses a stale watcher: an unpublished id plus approval is not enough', () => {
  const result = gate(makeThemeDir(), {
    [ENV_DEV_THEME_ID]: '1001357481',
    [ENV_PUSH_APPROVED]: '1',
  });
  assert.equal(result.open, false);
  const watcher = result.prerequisites.find((p) => p.id === 'watcher-active');
  assert.equal(watcher.satisfied, false);
});

test('L2 opens only when all three prerequisites hold, and names the dev target', () => {
  const result = gate(makeThemeDir({ withWatcher: true }), {
    [ENV_DEV_THEME_ID]: '1001357481',
    [ENV_PUSH_APPROVED]: '1',
  });
  assert.equal(result.open, true);
  assert.equal(result.devThemeId, '1001357481');
  assert.ok(result.prerequisites.every((p) => p.satisfied));
});

test('L2 treats a non-numeric or empty dev id as absent', () => {
  for (const bad of ['', '  ', 'abc', '1001357481x']) {
    const result = gate(makeThemeDir({ withWatcher: true }), {
      [ENV_DEV_THEME_ID]: bad,
      [ENV_PUSH_APPROVED]: '1',
    });
    assert.equal(result.open, false, `expected refusal for dev id ${JSON.stringify(bad)}`);
  }
});
