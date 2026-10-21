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
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { buildLaneEnv } = require('./lane-env.cjs');

// A bare `npm run test:*` has no pipeline around it, so no lane: its test processes would resolve
// the developer's own data root and append to the live app's main.log and registers. The runner
// process (no NODE_TEST_CONTEXT) opens a lane of its own and removes it when it exits; the
// pipeline already sets ANTIFAN_TEST_LANE_DIR, so its lanes are left as they are.
if (!process.env.ANTIFAN_TEST_LANE_DIR && !process.env.NODE_TEST_CONTEXT) {
  const ownLane = mkdtempSync(join(tmpdir(), 'antifan-lane-bare-'));
  Object.assign(process.env, buildLaneEnv(ownLane, {}));
  process.on('exit', () => {
    try { rmSync(ownLane, { recursive: true, force: true }); } catch {}
  });
}

const laneDir = process.env.ANTIFAN_TEST_LANE_DIR;
// NODE_TEST_CONTEXT marks a process the runner spawned for a test file (the runner itself has
// none); a data root that is no longer the lane's own means an ancestor already rebound it.
if (laneDir && process.env.NODE_TEST_CONTEXT && process.env.ANTIFAN_DATA_ROOT === join(laneDir, 'data')) {
  Object.assign(process.env, buildLaneEnv(mkdtempSync(join(laneDir, 'file-')), {}), {
    ANTIFAN_TEST_LANE_DIR: laneDir,
  });
}
