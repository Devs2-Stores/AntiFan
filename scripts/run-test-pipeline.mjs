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
 *   node scripts/run-test-pipeline.mjs [lane ...] [--json] [--no-compile]
 *   node scripts/run-test-pipeline.mjs --verify
 *
 * With no lane named, the default test set runs (including static gates audit and plans:check).
 */
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

const STATIC_LANES = ['audit', 'plans:check'];
const TEST_LANES = [
  ...STATIC_LANES,
  'compile',
  'test:canary',
  'test:fast',
  'test:site-clone',
  'test:super-core',
  'test:integration',
  'test:main',
  // The e2e lane runs without --test-force-exit: with the suite's watchdogs and teardown paths
  // verified (this lane passed 6/6 with no forced exit), the truth lane is the gate. The
  // force-exit variant stays available as `test:e2e` for local iteration.
  'test:e2e:strict',
  'smoke:terminal',
  'smoke:site-mute',
  'smoke:media-freeze',
  'test:terminal-transport',
  'test:terminal-rename',
  'test:mcp-dispatch-hub',
  'test:toolbar-qa-hub',
];
// 'test:probes' stays opt-in: it stages a daemon bundle and spawns detached hosts, which is heavier
// than every other lane. Its wrapper pins a throwaway data root, so the lane no longer depends on
// whatever happens to be staged on the machine.
const KNOWN_LANES = new Set([
  ...STATIC_LANES,
  ...TEST_LANES,
  // 'test:unit' is a developer convenience subset — test:fast runs the same unit globs
  // plus renderer/benchmark/src suites, so running both in the pipeline would duplicate work.
  'test:unit',
  'test:e2e',
  'test:probes',
]);
const NON_COMPILE_LANES = new Set(['compile', 'test:canary', ...STATIC_LANES]);
const COMPILE_DEPENDENT = new Set(
  [...KNOWN_LANES].filter((lane) => !NON_COMPILE_LANES.has(lane))
);

// Every lane is bounded: `spawnSync` without a timeout let a lane that leaks a handle (an Electron
// smoke, or `test:e2e:strict`, which runs without `--test-force-exit`) block the whole pipeline
// forever, and the caller had no way to tell a hung lane from a slow one. Budgets leave ~4x headroom
// over the slowest measured lane (02:11 report: test:main 104.4 s, test:fast 65.5 s).
const DEFAULT_LANE_TIMEOUT_MS = 8 * 60_000;
const LANE_TIMEOUT_MS = new Map([
  ['smoke:terminal', 15 * 60_000],
  ['test:e2e:strict', 10 * 60_000],
  ['test:probes', 20 * 60_000],
]);

// Windows spawns `cmd.exe` as the direct child (shell: true), so killing only that pid orphans
// npm/node/vitest underneath it - exactly the leaked processes that would poison the next lane.
function killTree(pid) {
  if (typeof pid !== 'number') return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // The lane already exited between the timeout firing and the kill - nothing left to reap.
    }
  }
}
function parseArgs(argv) {
  const options = { lanes: [], json: false, verify: false, noCompile: false, help: false, laneTimeoutMs: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--verify') options.verify = true;
    else if (arg === '--no-compile') options.noCompile = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--lane-timeout-ms') {
      const raw = argv[++i];
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`--lane-timeout-ms needs a positive integer, got '${raw}'`);
      }
      options.laneTimeoutMs = parsed;
    }
    else if (arg.startsWith('--')) throw new Error(`Unknown argument '${arg}'`);
    else if (!KNOWN_LANES.has(arg)) throw new Error(`Unknown lane '${arg}' (known: ${[...KNOWN_LANES].sort().join(', ')})`);
    else options.lanes.push(arg);
  }
  if (options.help) return options;
  if (options.lanes.length === 0) {
    // Bare invocation (including `npm run verify`) runs the full TEST_LANES set, which
    // already starts with the STATIC_LANES gates — `--verify` only changes behavior
    // when lanes are named explicitly, by prepending those gates to the selection.
    options.lanes = [...TEST_LANES];
  }
  if (options.verify) {
    for (const staticLane of [...STATIC_LANES].reverse()) {
      if (!options.lanes.includes(staticLane)) {
        options.lanes.unshift(staticLane);
      }
    }
  }

  if (options.noCompile) {
    options.lanes = options.lanes.filter((lane) => lane !== 'compile');
  } else if (!options.lanes.includes('compile') && options.lanes.some((lane) => COMPILE_DEPENDENT.has(lane))) {
    const firstDepIdx = options.lanes.findIndex((lane) => COMPILE_DEPENDENT.has(lane));
    options.lanes.splice(firstDepIdx, 0, 'compile');
  }

  return options;
}

function runLane(lane, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', lane], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      // A POSIX process group lets the timeout kill the whole lane, not just its first process.
      detached: process.platform !== 'win32',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const finish = (status, signal) => {
      clearTimeout(timer);
      resolve({
        lane,
        // A timed-out lane must never report green: if the child races its own exit to 0
        // while the kill tree lands, the timeout verdict still wins.
        status: timedOut ? 1 : (status === null ? 1 : status),
        signal: signal ?? null,
        timedOut,
        ms: Date.now() - startedAt,
      });
    };
    child.on('close', (code, signal) => finish(code, signal));
    child.on('error', () => finish(1, null));
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`Usage:
  node scripts/run-test-pipeline.mjs [lane ...] [--json] [--no-compile] [--lane-timeout-ms <n>]
  node scripts/run-test-pipeline.mjs --verify

Lanes that read the build get the 'compile' lane prepended. Calling a lane directly through
npm run <lane> skips that step and tests whatever .compiled currently holds.

Every lane is bounded (default ${DEFAULT_LANE_TIMEOUT_MS / 60_000} min; ${
      [...LANE_TIMEOUT_MS].map(([lane, ms]) => `${lane} ${ms / 60_000} min`).join(', ')
    }) and a timed-out lane has its
process tree killed, so a hung lane reports red instead of blocking the run. --lane-timeout-ms
overrides the budget for every lane (use it to prove the bound, or to buy room for a slow machine).

Known lanes:
  ${[...KNOWN_LANES].sort().join(', ')}
`);
    return 0;
  }
  const results = [];
  let compileFailed = false;

  for (const lane of options.lanes) {
    if (compileFailed && COMPILE_DEPENDENT.has(lane)) {
      results.push({ lane, status: null, skipped: true, ms: 0 });
      continue;
    }
    const timeoutMs = options.laneTimeoutMs ?? LANE_TIMEOUT_MS.get(lane) ?? DEFAULT_LANE_TIMEOUT_MS;
    if (!options.json) process.stdout.write(`\n===== ${lane} =====\n`);
    const result = await runLane(lane, timeoutMs);
    results.push(result);
    if (lane === 'compile' && result.status !== 0) compileFailed = true;
  }

  const failed = results.filter((entry) => !entry.skipped && (entry.status !== 0 || entry.timedOut));
  const summary = {
    lanes: results.map((entry) => ({
      lane: entry.lane,
      status: entry.skipped ? 'skipped' : entry.status === 0 ? 'passed' : 'failed',
      ms: entry.ms,
      ...(entry.signal ? { signal: entry.signal } : {}),
      ...(entry.timedOut ? { timeout: true } : {}),
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
      const note = entry.timeout ? '  killed process tree (lane-timeout)' : '';
      process.stdout.write(`${entry.lane.padEnd(width)}  ${entry.status.padEnd(7)}  ${(entry.ms / 1000).toFixed(1)}s${note}\n`);
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
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`run-test-pipeline: ${error.message}\n`);
  process.exitCode = 2;
}
