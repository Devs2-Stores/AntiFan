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
 * `kill(-pid)` SIGTERM then SIGKILL on POSIX. The group signal only reaches the
 * runner's children when the runner leads a process group — i.e. its launcher
 * spawned it `detached: true` (the test harness does). A runner that is not a
 * group leader gets the leader-only fallback and its children may survive.
 *
 * A pid is not an identity: Windows and POSIX both recycle pids, so before any
 * kill the supervisor re-proves the live process is the one the records meant —
 * by its OS-reported start value (scripts/lib/process-identity.mjs), never by
 * existence alone.
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
import { readProcessIdentity } from '../lib/process-identity.mjs';

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
    // Negative pid signals the process group led by `pid`, so the runner's
    // Electron/CDP children die too — but only when the runner actually leads a
    // group (spawned `detached: true` on POSIX, or a shell job-control leader).
    // Otherwise -pid is ESRCH and the fallback signals the leader alone; nothing
    // here can retroactively group a runner its launcher did not detach.
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
 * issued. Callers must have already proven the pid still names the process they
 * mean — this function signals whatever currently holds it.
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
 * `{ outcome: 'killed'|'done'|'gone'|'no-runner', reason, pid }`. A kill is only
 * attempted after the live process is re-proven to be the runner; a pid that was
 * recycled onto an unrelated process ends supervision as 'gone', not 'killed'.
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
  // Identity of the process `pid` was attributed to, captured once at adoption:
  // `{ startToken, startTokenFormat }` from readProcessIdentity, or null when it
  // could not be read. `runnerEvidenceMs` is the newest timestamp that proves
  // the runner was alive as `pid` — a heartbeat or lock-lease write naming it.
  let attributedIdentity = null;
  let identityCaptureTried = false;
  let runnerEvidenceMs = null;

  const finish = (verdict) => {
    const record = { ...verdict, pid: pid ?? null, at: new Date().toISOString() };
    writeRecordAtomic(supervisorVerdictPath(dir), record);
    return record;
  };

  const captureIdentity = async () => {
    if (identityCaptureTried) return;
    identityCaptureTried = true;
    const observed = await readProcessIdentity(pid);
    if (observed.alive && observed.startToken) {
      attributedIdentity = { startToken: observed.startToken, startTokenFormat: observed.startTokenFormat };
    }
  };

  // How far the observed start may sit past the newest evidence and still be
  // the same process. This absorbs measurement noise — clock jitter between the
  // runner's Date.now() and the adapter's start value, and adapters with only
  // second precision (ps lstart) — not the recycling window: a recycled pid's
  // start is later than the last heartbeat by however long the runner has been
  // dead, which is what the staleness check already proved exceeds staleMs.
  const START_TIME_TOLERANCE_MS = 1_000;

  /**
   * Re-prove that the process now holding `pid` is the runner before signalling
   * it. Two proofs, either sufficient to confirm, either sufficient to refuse:
   *
   *  - start time: a process that began after the newest runner evidence cannot
   *    be the process that wrote it — the pid was recycled. This is the sound
   *    check on Windows (CreationDate is precise) and procfs (jiffy precision);
   *    under the second-precision `ps` fallback a recycle inside the same second
   *    as the last heartbeat can pass the bound, which the token then catches.
   *  - start token: the value captured when the pid was adopted must still match.
   *    It is the only proof available when no timestamped evidence names the pid
   *    (an explicit --pid whose runner never wrote a heartbeat). A token
   *    captured from an already-recycled pid is not proof on its own, which is
   *    why the start-time bound is checked first whenever evidence exists.
   *
   * Returns 'confirmed' | 'gone' | 'recycled' | 'unverified'. 'unverified'
   * refuses the kill: an unverifiable process is treated as live, the same fail-
   * closed direction process-identity.mjs documents for lock reclaim.
   */
  const confirmRunnerProcess = async () => {
    const observed = await readProcessIdentity(pid);
    if (!observed.alive) return { status: 'gone', observed };
    const proofs = [];
    if (runnerEvidenceMs !== null) {
      const startMs = observed.startedAt ? Date.parse(observed.startedAt) : NaN;
      if (Number.isNaN(startMs)) proofs.push('unavailable');
      else proofs.push(startMs > runnerEvidenceMs + START_TIME_TOLERANCE_MS ? 'recycled' : 'confirmed');
    }
    if (attributedIdentity?.startToken && observed.startToken && observed.startTokenFormat === attributedIdentity.startTokenFormat) {
      proofs.push(observed.startToken === attributedIdentity.startToken ? 'confirmed' : 'recycled');
    }
    if (proofs.includes('recycled')) return { status: 'recycled', observed };
    if (proofs.includes('confirmed')) return { status: 'confirmed', observed };
    return { status: 'unverified', observed };
  };

  const killAttributed = async (trigger) => {
    const check = await confirmRunnerProcess();
    if (check.status === 'gone') return finish({ outcome: 'gone', reason: 'RUNNER_EXITED', trigger });
    if (check.status === 'recycled') return finish({ outcome: 'gone', reason: 'RUNNER_PID_RECYCLED', trigger });
    if (check.status === 'unverified') return finish({ outcome: 'gone', reason: 'RUNNER_IDENTITY_UNVERIFIED', trigger });
    const result = await killProcessTree(pid, { graceMs });
    return finish({ outcome: 'killed', reason: trigger, ...result });
  };

  const belongsToRun = (record) => {
    if (!record) return false;
    if (explicitPid) return true;
    return expectedRunId !== null && typeof record.runId === 'string' && record.runId === expectedRunId;
  };

  for (;;) {
    const rawHb = readRecord(hbPath);
    const lock = readRecord(mutexPath(dir));
    const now = Date.now();

    if (!explicitPid && expectedRunId === null) expectedRunId = runId ?? lock?.runId ?? null;
    // A heartbeat that cannot be attributed to this run is not this run's evidence.
    const hb = belongsToRun(rawHb) ? rawHb : null;

    if (hb && firstHeartbeatMs === null) {
      firstHeartbeatMs = typeof hb.atMs === 'number' ? Math.min(hb.atMs, now) : now;
    }
    if (!pid && hb && typeof hb.pid === 'number') pid = hb.pid;
    if (!pid && lock && typeof lock.pid === 'number' && belongsToRun(lock)) pid = lock.pid;

    // The newest moment the runner proved it was alive as `pid`: a heartbeat or
    // a lock-lease refresh that names it. A heartbeat naming a different pid is
    // evidence about that process, not this one.
    if (hb && hb.pid === pid && typeof hb.atMs === 'number') {
      runnerEvidenceMs = Math.max(runnerEvidenceMs ?? hb.atMs, hb.atMs);
    }
    if (lock && lock.pid === pid && typeof lock.atMs === 'number') {
      runnerEvidenceMs = Math.max(runnerEvidenceMs ?? lock.atMs, lock.atMs);
    }
    if (pid) await captureIdentity();

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
      return killAttributed('HEARTBEAT_STALE');
    }

    if (!armed && now - bootstrapStartMs > bootstrapCeilingMs) {
      if (!pid) {
        return finish({ outcome: 'no-runner', reason: 'BOOTSTRAP_CEILING' });
      }
      return killAttributed('BOOTSTRAP_CEILING');
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
