#!/usr/bin/env node
/**
 * Aggregate test pipeline: every lane runs, one exit code reports every failure.
 *
 * `npm test` chained its lanes with `&&`, so the first red lane hid all the later ones — a red
 * canary lane meant test:fast, test:site-clone, test:integration, test:main and test:e2e never
 * executed, and nothing reported that they had been skipped. This runner executes each lane,
 * prints one summary, and exits non-zero when any lane failed.
 *
 * `compile` is a prerequisite, not a peer: when it fails, lanes that consume `.compiled` would
 * run against a stale build, so they are reported as skipped instead.
 *
 * Usage:
 *   node scripts/run-test-pipeline.mjs [lane ...] [--json]
 *   node scripts/run-test-pipeline.mjs --verify
 *
 * With no lane named, the default test set runs. `--verify` prepends the static gates.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const STATIC_LANES = ['audit', 'plans:check'];
const TEST_LANES = ['compile', 'test:canary', 'test:fast', 'test:site-clone', 'test:integration', 'test:main', 'test:e2e'];
const KNOWN_LANES = new Set([...STATIC_LANES, ...TEST_LANES, 'test:unit']);
const COMPILE_DEPENDENT = new Set(TEST_LANES.filter((lane) => lane !== 'compile'));

function parseArgs(argv) {
  const options = { lanes: [], json: false, verify: false };
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown argument '${arg}'`);
    else if (!KNOWN_LANES.has(arg)) throw new Error(`Unknown lane '${arg}' (known: ${[...KNOWN_LANES].sort().join(', ')})`);
    else options.lanes.push(arg);
  }
  if (options.lanes.length === 0) options.lanes = [...(options.verify ? STATIC_LANES : []), ...TEST_LANES];
  return options;
}

function runLane(lane) {
  const startedAt = Date.now();
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', lane], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return {
    lane,
    status: result.status === null ? 1 : result.status,
    signal: result.signal ?? null,
    ms: Date.now() - startedAt,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const results = [];
  let compileFailed = false;

  for (const lane of options.lanes) {
    if (compileFailed && COMPILE_DEPENDENT.has(lane)) {
      results.push({ lane, status: null, skipped: true, ms: 0 });
      continue;
    }
    if (!options.json) process.stdout.write(`\n===== ${lane} =====\n`);
    const result = runLane(lane);
    results.push(result);
    if (lane === 'compile' && result.status !== 0) compileFailed = true;
  }

  const failed = results.filter((entry) => !entry.skipped && entry.status !== 0);
  const summary = {
    lanes: results.map((entry) => ({
      lane: entry.lane,
      status: entry.skipped ? 'skipped' : entry.status === 0 ? 'passed' : 'failed',
      ms: entry.ms,
      ...(entry.signal ? { signal: entry.signal } : {}),
    })),
    failed: failed.map((entry) => entry.lane),
    skipped: results.filter((entry) => entry.skipped).map((entry) => entry.lane),
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    const width = Math.max(...summary.lanes.map((entry) => entry.lane.length), 4);
    process.stdout.write('\n===== pipeline summary =====\n');
    for (const entry of summary.lanes) {
      process.stdout.write(`${entry.lane.padEnd(width)}  ${entry.status.padEnd(7)}  ${(entry.ms / 1000).toFixed(1)}s\n`);
    }
    process.stdout.write(
      failed.length === 0 && summary.skipped.length === 0
        ? 'all lanes passed\n'
        : `${failed.length} lane(s) failed${summary.skipped.length > 0 ? `, ${summary.skipped.length} skipped` : ''}: ${[...failed.map((e) => e.lane), ...summary.skipped].join(', ')}\n`
    );
  }

  return failed.length === 0 ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`run-test-pipeline: ${error.message}\n`);
  process.exitCode = 2;
}
