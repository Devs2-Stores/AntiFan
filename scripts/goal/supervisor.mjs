/**
 * External supervisor — a separate process that watches the runner's heartbeat
 * file and kills the runner's process tree when the heartbeat proves the runner
 * is not coming back.
 *
 * This exists because a runner cannot guard its own bootstrap: a deadlock before
 * the watchdog is armed leaves no heartbeat to go stale inside the process, and a
 * hung Electron tree on Windows can hold the machine. So the guard lives here, in
 * a process the runner does not control.
 *
 * Kill conditions, evaluated every poll:
 *  - heartbeat stale (> heartbeatStaleMs) — armed or not, a stale heartbeat means
 *    the writer stopped writing;
 *  - bootstrap ceiling — the runner has not reported `watchdogArmedAt` within
 *    `bootstrapCeilingMs` of the earliest observed start. This bound applies ONLY
 *    until the armed timestamp appears; afterwards staleness alone governs.
 *
 * Exit conditions that are not kills:
 *  - heartbeat reports `done: true` — the runner finished or aborted cleanly;
 *  - the runner PID is gone — nothing left to supervise;
 *  - no runner ever appeared within the bootstrap ceiling — nothing to kill.
 *
 * Tree kill: `taskkill /PID <pid> /T` then `/F` after the grace window on Windows;
 * `kill(-pid)` SIGTERM then SIGKILL on POSIX (the runner must be a process-group
 * leader for the group signal to reach its children).
 *
 * CLI: `node scripts/goal/supervisor.mjs <dir> [--pid <pid>] [--poll-ms N]
 *       [--bootstrap-ms N] [--stale-ms N] [--grace-ms N]`
 * The flag overrides exist for tests; production runs use the frozen THRESHOLDS.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readRecord, writeRecordAtomic } from '../lib/atomic-record.mjs';
import { THRESHOLDS } from './thresholds.mjs';
import { heartbeatPath, mutexPath } from './watchdog.mjs';

export function supervisorVerdictPath(dir) {
  return path.join(dir, 'goal-supervisor.json');
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taskkill(pid, force) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  try {
    execFileSync('taskkill', args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function signalTree(pid, signal) {
  if (process.platform === 'win32') {
    return taskkill(pid, signal === 'SIGKILL');
  }
  try {
    // Negative pid: the whole process group, so Electron/CDP children die too.
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Kill the runner's process tree: graceful first, forced after `graceMs` if the
 * leader is still alive. Returns when the leader is dead or the force kill was
 * issued.
 */
export async function killProcessTree(pid, { graceMs = THRESHOLDS.supervisorTermGraceMs } = {}) {
  if (typeof pid !== 'number' || pid <= 0) {
    // kill(0, sig) on POSIX signals the caller's own process group — never allow
    // a missing pid to fall through to that.
    return { killed: false, forced: false, error: 'NO_PID' };
  }
  signalTree(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return { killed: true, forced: false };
    await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
  }
  signalTree(pid, 'SIGKILL');
  // Give the OS a moment to reap before the caller checks.
  const reapDeadline = Date.now() + 5_000;
  while (Date.now() < reapDeadline && isProcessAlive(pid)) {
    await sleep(100);
  }
  return { killed: !isProcessAlive(pid), forced: true };
}

/**
 * Run the supervisor loop until the runner exits, reports done, or is killed.
 * Writes the verdict record to `goal-supervisor.json` in `dir` and returns it:
 * `{ outcome: 'killed'|'done'|'gone'|'no-runner', reason, pid }`.
 */
export async function runSupervisor({
  dir,
  runnerPid = null,
  runId = null,
  pollIntervalMs = THRESHOLDS.supervisorPollIntervalMs,
  bootstrapCeilingMs = THRESHOLDS.bootstrapCeilingMs,
  staleMs = THRESHOLDS.heartbeatStaleMs,
  graceMs = THRESHOLDS.supervisorTermGraceMs,
  onEvent,
} = {}) {
  const hbPath = heartbeatPath(dir);
  const startedAtMs = Date.now();
  let firstHeartbeatMs = null;
  // An explicit pid is the operator naming the process to watch, so its records
  // are trusted as-is. A DISCOVERED identity has to be attributed: the heartbeat
  // and lock files outlive the run, so a leftover `done:true` from a previous
  // run would end supervision instantly, and a leftover pid may since have been
  // recycled onto an unrelated process that the stale-kill path would then kill.
  const explicitPid = typeof runnerPid === 'number' && runnerPid > 0;
  let pid = explicitPid ? runnerPid : null;
  let expectedRunId = runId;

  const finish = (verdict) => {
    const record = { ...verdict, pid: pid ?? null, at: new Date().toISOString() };
    writeRecordAtomic(supervisorVerdictPath(dir), record);
    return record;
  };

  const belongsToRun = (record) => {
    if (!record) return false;
    if (explicitPid) return true;
    return expectedRunId !== null && typeof record.runId === 'string' && record.runId === expectedRunId;
  };

  for (;;) {
    const rawHb = readRecord(hbPath);
    const now = Date.now();

    if (!explicitPid && expectedRunId === null) expectedRunId = runId ?? readRecord(mutexPath(dir))?.runId ?? null;
    // A heartbeat that cannot be attributed to this run is not this run's evidence.
    const hb = belongsToRun(rawHb) ? rawHb : null;

    if (hb && firstHeartbeatMs === null) {
      firstHeartbeatMs = typeof hb.atMs === 'number' ? Math.min(hb.atMs, now) : now;
    }
    if (!pid && hb && typeof hb.pid === 'number') pid = hb.pid;
    if (!pid) {
      const lock = readRecord(mutexPath(dir));
      if (lock && typeof lock.pid === 'number' && belongsToRun(lock)) pid = lock.pid;
    }

    // The bootstrap clock starts at the earliest evidence the runner exists —
    // its first heartbeat timestamp or this supervisor's own start — so a runner
    // that began before its supervisor cannot borrow extra time.
    const bootstrapStartMs = Math.min(startedAtMs, firstHeartbeatMs ?? startedAtMs);
    const armed = Boolean(hb && hb.watchdogArmedAt);

    if (hb && hb.done) {
      return finish({ outcome: 'done', reason: hb.abortReason ?? 'RUNNER_DONE' });
    }

    if (pid && !isProcessAlive(pid)) {
      return finish({ outcome: 'gone', reason: 'RUNNER_EXITED' });
    }

    if (hb && typeof hb.atMs === 'number' && now - hb.atMs > staleMs) {
      // A stale heartbeat with no attributable pid has nothing to kill; the run
      // still stops, but the receipt must not claim a kill that never happened.
      if (!pid) return finish({ outcome: 'no-runner', reason: 'HEARTBEAT_STALE' });
      const result = await killProcessTree(pid, { graceMs });
      return finish({ outcome: 'killed', reason: 'HEARTBEAT_STALE', ...result });
    }

    if (!armed && now - bootstrapStartMs > bootstrapCeilingMs) {
      if (!pid) {
        return finish({ outcome: 'no-runner', reason: 'BOOTSTRAP_CEILING' });
      }
      const result = await killProcessTree(pid, { graceMs });
      return finish({ outcome: 'killed', reason: 'BOOTSTRAP_CEILING', ...result });
    }

    onEvent?.({ type: 'poll', pid: pid ?? null, armed });
    await sleep(pollIntervalMs);
  }
}

function parseArgs(argv) {
  const args = { dir: null, runnerPid: null };
  const rest = [...argv];
  args.dir = rest.shift() ?? null;
  while (rest.length) {
    const flag = rest.shift();
    const value = rest.shift();
    if (flag === '--pid') args.runnerPid = Number(value);
    else if (flag === '--poll-ms') args.pollIntervalMs = Number(value);
    else if (flag === '--bootstrap-ms') args.bootstrapCeilingMs = Number(value);
    else if (flag === '--stale-ms') args.staleMs = Number(value);
    else if (flag === '--grace-ms') args.graceMs = Number(value);
  }
  return args;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir) {
    console.error('usage: node scripts/goal/supervisor.mjs <dir> [--pid <pid>] [--poll-ms N] [--bootstrap-ms N] [--stale-ms N] [--grace-ms N]');
    process.exit(2);
  }
  const verdict = await runSupervisor({
    ...args,
    onEvent: (e) => console.log(`[supervisor] poll pid=${e.pid ?? 'unknown'} armed=${e.armed}`),
  });
  console.log(`[supervisor] ${verdict.outcome}: ${verdict.reason} (pid ${verdict.pid ?? 'none'})`);
}
