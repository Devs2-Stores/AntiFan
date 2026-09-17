#!/usr/bin/env node
/**
 * Wall-clock metric harness for the e2e optimization loop.
 *
 * Prints one number to stdout: seconds spent inside `npm run test:e2e`.
 * The compile step runs first (the lane executes emitted JS) but is excluded
 * from the number, so the metric stays attributable to the test lane itself.
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
  const result = spawnSync('npm', ['run', script], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  });
  return result.status === null ? 1 : result.status;
}

const compileStatus = run('compile');
if (compileStatus !== 0) {
  console.error(`loop-e2e-metric: compile failed (exit ${compileStatus})`);
  process.exit(compileStatus);
}

const startedAt = Date.now();
const laneStatus = run('test:e2e');
const seconds = (Date.now() - startedAt) / 1000;

process.stdout.write(`${seconds.toFixed(1)}\n`);
process.exit(laneStatus);
