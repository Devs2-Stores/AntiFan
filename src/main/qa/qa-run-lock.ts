import { CapabilityError } from '../../shared/control-plane-contracts';

/**
 * One QA run per physical tab at a time.
 *
 * A QA run reloads the page, emulates device sizes and scrolls the tab, so two runs on the same tab
 * corrupt each other's measurements. The key is the tab id alone: the emulation being protected
 * belongs to the tab, whichever workspace or attachment started the run.
 *
 * A lease bounds how long a crashed or hung run can hold the tab. The holder releases in a
 * `finally`, after the run has actually stopped: an aborted request does not release the lock,
 * because the run it protects may still be measuring the tab. An expired lease is taken over, and
 * the previous holder's late `release()` then does nothing because it no longer owns the entry.
 */

/** Default lease: the longest QA policy timeout plus the 30 s the capability allows for teardown. */
export const DEFAULT_QA_RUN_LEASE_MS = 330_000;
const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 15_000;

export interface QaRunLockOptions {
  leaseMs?: number;
  now?: () => number;
}

export interface QaRunLockHandle {
  release(): void;
}

interface LockEntry {
  expiresAt: number;
  startedAt: number;
}

const held = new Map<string, LockEntry>();

export function acquireQaRunLock(tabId: string, opts?: QaRunLockOptions): QaRunLockHandle {
  if (typeof tabId !== 'string' || tabId.length === 0) {
    throw new CapabilityError('INVALID_ARGUMENT', 'A QA run lock needs a tab id');
  }
  const now = opts?.now ?? Date.now;
  const nowMs = now();
  const existing = held.get(tabId);
  if (existing && existing.expiresAt > nowMs) {
    const remaining = existing.expiresAt - nowMs;
    const retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, remaining));
    throw new CapabilityError('QA_BUSY', `A QA run is already in progress on tab ${tabId} (started ${Math.round((nowMs - existing.startedAt) / 1000)}s ago); wait for it to finish and retry`, {
      tabId,
      retryable: true,
      retryAfterMs,
    });
  }
  const leaseMs = opts?.leaseMs !== undefined && Number.isFinite(opts.leaseMs) && opts.leaseMs > 0 ? opts.leaseMs : DEFAULT_QA_RUN_LEASE_MS;
  const entry: LockEntry = { startedAt: nowMs, expiresAt: nowMs + leaseMs };
  held.set(tabId, entry);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    if (held.get(tabId) === entry) held.delete(tabId);
  };
  return { release };
}

/** Test seam: forget every held lock. */
export function resetQaRunLocksForTests(): void {
  held.clear();
}
