/**
 * Watchdog: a heartbeat file, a staleness check, and a single-runner mutex.
 *
 * The heartbeat is a file, not a log line, because the external supervisor must read it
 * without trusting the process that wrote it. A stale heartbeat means the runner is not
 * coming back; the supervisor kills the process tree rather than waiting forever.
 *
 * The mutex is a PID file so two runners cannot overlap. A second runner that finds a
 * live PID refuses; a stale PID (process gone, file left behind) is reclaimed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeRecordAtomic, readRecord } from '../lib/atomic-record.mjs';
import { THRESHOLDS } from './thresholds.mjs';

export function heartbeatPath(dir) {
  return path.join(dir, 'goal-heartbeat.json');
}

export function mutexPath(dir) {
  return path.join(dir, 'goal-runner.lock');
}

function isProcessAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    // signal 0 tests existence without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we cannot signal it — still alive.
    return err.code === 'EPERM';
  }
}

/**
 * Write a heartbeat. `state` is whatever the runner wants the supervisor to see —
 * current phase, armed flag, last gate verdict. Written atomically so a partial write
 * is never read as a heartbeat.
 */
export function writeHeartbeat(dir, state = {}) {
  writeRecordAtomic(heartbeatPath(dir), {
    pid: process.pid,
    at: new Date().toISOString(),
    atMs: Date.now(),
    ...state,
  });
}

/**
 * Start the heartbeat interval. Returns a stop function.
 *
 * Each tick also refreshes the mutex lease: the same signal that proves the
 * runner is alive proves it still owns the lock, so a lock that stops being
 * refreshed means the holder is gone even when its pid was recycled onto an
 * unrelated live process.
 *
 * A refresh that fails means the lock now names a different process — see
 * `acquireRunnerMutex`. That is reported through `onLost` so the run can abort
 * instead of continuing unguarded; it is not swallowed.
 */
export function startHeartbeat(dir, state = {}, intervalMs = THRESHOLDS.heartbeatIntervalMs, onLost = null) {
  const pulse = () => {
    writeHeartbeat(dir, state);
    if (refreshRunnerMutex(dir) === false && onLost) onLost();
  };
  pulse();
  const timer = setInterval(pulse, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Is the heartbeat stale? `now` is injectable for tests. Returns the age in ms, or
 * `null` when there is no heartbeat to judge (absence is not staleness — a process that
 * never started is the supervisor's bootstrap problem, not the watchdog's).
 */
export function heartbeatAgeMs(dir, now = Date.now()) {
  const hb = readRecord(heartbeatPath(dir));
  if (!hb || typeof hb.atMs !== 'number') return null;
  return now - hb.atMs;
}

export function isHeartbeatStale(dir, now = Date.now(), staleMs = THRESHOLDS.heartbeatStaleMs) {
  const age = heartbeatAgeMs(dir, now);
  return age !== null && age > staleMs;
}

/**
 * Acquire the single-runner mutex.
 *
 * The claim is created with `wx`, so two runners starting together cannot both
 * read "no holder" and both win: exactly one create succeeds and the other sees
 * EEXIST. Reclaiming is lease-based rather than PID-based, because a crashed
 * holder whose PID was recycled looks alive forever and would wedge every later
 * run behind a refusal that appears correct.
 *
 * Returns `{ acquired: true, path }` or `{ acquired: false, holderPid }`.
 */
export function acquireRunnerMutex(dir) {
  const file = mutexPath(dir);
  const claim = () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ pid: process.pid, runId: null, at: new Date().toISOString(), atMs: Date.now() }),
      { flag: 'wx' },
    );
  };
  // A successful create is not proof of ownership: the reclaim path removes a
  // lock it judged stale, so a holder that created its lock in between would be
  // silently evicted. Read back and confirm the file still names this process.
  const ownedByUs = () => {
    const mine = readRecord(file);
    return mine?.pid === process.pid
      ? { acquired: true, path: file }
      : { acquired: false, holderPid: mine?.pid ?? null };
  };
  const claimVerified = () => {
    try {
      claim();
    } catch {
      return { acquired: false, holderPid: readRecord(file)?.pid ?? null };
    }
    return ownedByUs();
  };

  try {
    claim();
    return ownedByUs();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  const existing = readRecord(file);
  if (!existing) return claimVerified(); // holder released between our create and this read
  if (isProcessAlive(existing.pid) && !isMutexLeaseExpired(existing)) {
    return { acquired: false, holderPid: existing.pid };
  }
  // Dead holder, or a live PID that stopped refreshing the lease (recycled PID).
  // Reclaim by rename, not unlink: rename is atomic and succeeds for exactly one
  // process, so a lock created after the staleness decision cannot be deleted.
  const stash = `${file}.stale.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(file, stash);
  } catch {
    return { acquired: false, holderPid: null }; // another runner reclaimed it first
  }
  const moved = readRecord(stash);
  if (JSON.stringify(moved) !== JSON.stringify(existing)) {
    // The file changed after the staleness decision, so it belonged to a live
    // holder. Restore it and stand down rather than evict a running run.
    try {
      if (!fs.existsSync(file)) fs.renameSync(stash, file);
      else fs.rmSync(stash, { force: true });
    } catch {
      /* the holder will detect the loss on its next lease refresh */
    }
    return { acquired: false, holderPid: moved?.pid ?? null };
  }
  fs.rmSync(stash, { force: true });
  return claimVerified();
}

function isMutexLeaseExpired(record, now = Date.now()) {
  if (typeof record?.atMs !== 'number') return true;
  return now - record.atMs > THRESHOLDS.mutexLeaseMs;
}

/** Read the current lock record, or null. */
export function readRunnerMutex(dir) {
  return readRecord(mutexPath(dir));
}

/**
 * Bind the lock to the run it protects, so a supervisor can tell this run's
 * heartbeat from a leftover written by a previous one.
 */
export function stampRunnerMutexRunId(dir, runId) {
  const file = mutexPath(dir);
  const existing = readRecord(file);
  if (!existing || existing.pid !== process.pid) return false;
  writeRecordAtomic(file, { ...existing, runId, at: new Date().toISOString(), atMs: Date.now() });
  return true;
}

/** Refresh the lease so the mutex stays claimed while the holder is alive. */
export function refreshRunnerMutex(dir) {
  const file = mutexPath(dir);
  const existing = readRecord(file);
  if (!existing || existing.pid !== process.pid) return false;
  writeRecordAtomic(file, { ...existing, at: new Date().toISOString(), atMs: Date.now() });
  return true;
}

export function releaseRunnerMutex(dir) {
  const file = mutexPath(dir);
  const existing = readRecord(file);
  // Only the holder may release; a stale lock is already free.
  if (existing && existing.pid === process.pid) {
    try {
      fs.unlinkSync(file);
    } catch {}
  }
}
