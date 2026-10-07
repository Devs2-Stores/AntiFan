import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buildLaneEnv } from '../../scripts/run-test-pipeline.mjs';

test('pipeline lane environment isolates every persistent root from inherited paths', () => {
  const laneDir = mkdtempSync(join(tmpdir(), 'antifan-lane-env-test-'));
  const live = {
    ANTIFAN_DATA_ROOT: 'C:/developer/live-data',
    ANTIFAN_CONFIG_DIR: 'C:/developer/live-config',
    ANTIFAN_USER_DATA: 'C:/developer/live-profile',
    ANTIFAN_USER_DATA_DIR: 'C:/developer/live-profile-legacy',
    ANTIFAN_ISSUE_REGISTER_DIR: 'C:/developer/live-issues',
    ANTIFAN_VERIFICATION_REGISTER_DIR: 'C:/developer/live-verifications',
    PATH: process.env.PATH,
  };
  try {
    const env = buildLaneEnv(laneDir, live);
    const roots = [
      env.ANTIFAN_DATA_ROOT,
      env.ANTIFAN_CONFIG_DIR,
      env.ANTIFAN_USER_DATA,
      env.ANTIFAN_USER_DATA_DIR,
      env.ANTIFAN_ISSUE_REGISTER_DIR,
      env.ANTIFAN_VERIFICATION_REGISTER_DIR,
    ];
    for (const root of roots) {
      assert.ok(root, 'each persistent path must be defined');
      const rel = relative(laneDir, root);
      assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`), `${root} must stay under lane scratch`);
      assert.ok(!Object.values(live).includes(root), `${root} must not inherit a developer path`);
    }
    assert.equal(env.ANTIFAN_FAIL_ON_LOCK_CONTENTION, '1');
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    rmSync(laneDir, { recursive: true, force: true });
  }
});
