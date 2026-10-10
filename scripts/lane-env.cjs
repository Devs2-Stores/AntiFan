'use strict';
// CommonJS so the per-file roots preload can load it with `node --require`: an `--import`
// preload moves the test file's main onto the ESM loader, which delays the process's startup
// warnings into the first test, where suites that capture console.error record them.
const { join } = require('node:path');

/**
 * Build an isolated environment for one test lane. The profile, data, config,
 * and register paths all live under laneDir, never under a developer's roots.
 */
function buildLaneEnv(laneDir, parentEnv = process.env) {
  const dataDir = join(laneDir, 'data');
  const env = { ...parentEnv };
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTIFAN_')) {
      delete env[key];
    }
  }
  return {
    ...env,
    ANTIFAN_DATA_ROOT: dataDir,
    ANTIFAN_CONFIG_DIR: join(dataDir, 'config'),
    ANTIFAN_USER_DATA: join(laneDir, 'profile'),
    ANTIFAN_USER_DATA_DIR: join(laneDir, 'profile'),
    ANTIFAN_ISSUE_REGISTER_DIR: laneDir,
    ANTIFAN_VERIFICATION_REGISTER_DIR: laneDir,
    ANTIFAN_FAIL_ON_LOCK_CONTENTION: '1',
    // Lets a lane's test processes carve per-file roots out of the lane (scripts/test-file-roots.cjs).
    ANTIFAN_TEST_LANE_DIR: laneDir,
  };
}

module.exports = { buildLaneEnv };
