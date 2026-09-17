#!/usr/bin/env node
/**
 * Wall-clock metric harness for the e2e optimization loop.
 *
 * Prints one number to stdout: seconds spent inside `npm run test:e2e`.
 * The compile step runs first (the lane executes emitted JS) but is excluded
 * from the number, so the metric stays attributable to the test lane itself.
 * Receipts the run rewrites are restored afterwards (see
 * `restoreReceiptsWrittenByLane`), so a verify leaves the tree as it found it.
 *
 * Exit 0 only when compile and the lane both succeed. A failing lane exits
 * non-zero without printing a number, so the loop records a failed iteration
 * rather than a misleadingly fast one.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function run(script) {
  // Children inherit stderr, and their stdout is routed there too: stdout stays
  // a single machine-readable number so `RESULT=$(node scripts/loop-e2e-metric.cjs)`
  // yields the metric instead of the lane's log.
  const result = spawnSync('npm', ['run', script], {
    cwd: ROOT,
    stdio: ['inherit', 2, 2],
    shell: true,
  });
  return result.status === null ? 1 : result.status;
}

/**
 * Tracked files with worktree-vs-index changes. Null when git is unavailable,
 * which disables receipt restoration rather than guessing at repository state.
 */
function trackedDirtyPaths() {
  const result = spawnSync('git', ['diff', '--name-only'], { cwd: ROOT, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return new Set(
    (result.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * The lane rewrites tracked receipts (the benchmark artifact and the live theme
 * proof) as a side effect of running. Left alone, every verify would dirty the
 * tree, and an iteration commit would either fold machine output into a change
 * that is supposed to be attributable, or trip the loop's clean-tree check. The
 * restore is narrow: only paths that were clean before this run and dirty after
 * it, so files someone was already editing - and untracked files the run
 * created - are never touched.
 */
function restoreReceiptsWrittenByLane(dirtyBefore) {
  const dirtyAfter = trackedDirtyPaths();
  if (!dirtyBefore || !dirtyAfter) return;
  const written = [...dirtyAfter].filter((file) => !dirtyBefore.has(file));
  if (written.length === 0) return;
  const restored = spawnSync('git', ['checkout', '--', ...written], { cwd: ROOT, stdio: 'inherit' });
  console.error(
    restored.status === 0
      ? `loop-e2e-metric: restored ${written.length} receipt(s) this run rewrote: ${written.join(', ')}`
      : `loop-e2e-metric: could not restore receipts this run rewrote: ${written.join(', ')}`,
  );
}

const compileStatus = run('compile');
if (compileStatus !== 0) {
  console.error(`loop-e2e-metric: compile failed (exit ${compileStatus})`);
  process.exit(compileStatus);
}

const dirtyBeforeLane = trackedDirtyPaths();
const startedAt = Date.now();
const laneStatus = run('test:e2e');
const seconds = (Date.now() - startedAt) / 1000;
restoreReceiptsWrittenByLane(dirtyBeforeLane);

if (laneStatus !== 0) {
  // A red lane is still fast: printing its wall clock would let a caller that
  // ignores the exit status - or pipes the output through another command -
  // record a regression as an improvement.
  console.error(`loop-e2e-metric: e2e lane failed (exit ${laneStatus})`);
  process.exit(laneStatus);
}

process.stdout.write(`${seconds.toFixed(1)}\n`);
process.exit(0);
