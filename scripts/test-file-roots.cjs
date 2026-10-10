'use strict';
/**
 * Per-file persistent roots for a parallel node:test lane (loaded with `node --require` in the
 * runner, so every test process it spawns loads it too).
 *
 * node:test runs each file in its own child process, and at --test-concurrency > 1 several run at
 * once, all inheriting one lane environment. Files that persist terminal-sessions.json, append the
 * issue register or write visual baselines would then read rows another file wrote. Each test
 * process rebinds the lane's roots to a fresh directory under the lane before any test module
 * loads; processes a test spawns inherit the rebound roots, so a test and its children still share
 * one root. The lane deletes its directory, and these with it, when it ends.
 */
const { mkdtempSync } = require('node:fs');
const { join } = require('node:path');
const { buildLaneEnv } = require('./lane-env.cjs');

const laneDir = process.env.ANTIFAN_TEST_LANE_DIR;
// NODE_TEST_CONTEXT marks a process the runner spawned for a test file (the runner itself has
// none); a data root that is no longer the lane's own means an ancestor already rebound it.
if (laneDir && process.env.NODE_TEST_CONTEXT && process.env.ANTIFAN_DATA_ROOT === join(laneDir, 'data')) {
  Object.assign(process.env, buildLaneEnv(mkdtempSync(join(laneDir, 'file-')), {}), {
    ANTIFAN_TEST_LANE_DIR: laneDir,
  });
}
