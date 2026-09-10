/**
 * The campaign run lock.
 *
 * One lock per campaign directory serialises invocations, because `_verdicts.json`,
 * the per-page evidence root and the published report are shared writers even when
 * every attempt directory is immutable. It is acquired **before the run's first
 * mutation** and held through the final index and report write.
 *
 *   exclusive create (wx) -> holder holds it -> top-level finally releases it
 *   abrupt death          -> file remains  -> next run reclaims it, but only after
 *                                            proving the recorded holder dead
 *
 * "Proven dead" means the process-identity helper shows that pid gone, or shows
 * that pid now carrying a different start token (pid reuse). File age, an
 * unreadable record or an adapter that cannot produce a token are *not* proof:
 * those refuse, because reclaiming a live holder's lock corrupts the run it
 * protects.
 *
 * Reclamation never unlinks the lock path after an earlier read — that is a
 * TOCTOU window in which two contenders both prove the same holder dead, and the
 * slower one deletes the winner's live lock. Instead the stale record is moved
 * aside with `rename` to a unique quarantine name and then **verified**: a
 * quarantined record that does not match the dead record we judged means we
 * captured a live lock, so it is put back with `linkSync` (atomic create-if-absent)
 * and the attempt fails loudly instead of continuing. The winner then creates the
 * lock with `wx`, which can only succeed while the path is free; a loser's `wx`
 * fails and it re-reads the current lock.
 *
 * Because a holder can, in principle, lose its lock to a mistaken reclaim, every
 * mutation re-verifies ownership first and callers must treat `LOCK_LOST` as
 * fatal rather than continuing to write shared artifacts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { captureProcessIdentity, proveHolderDead } from './process-identity.mjs';
import { readRecord, removeRecordIf, writeRecordAtomic } from './atomic-record.mjs';

export const CAMPAIGN_LOCK_PATH = '.canary/15-pages/.campaign.lock';

export const LOCK_CODES = {
  ACQUIRED: 'ACQUIRED',
  RECLAIMED: 'RECLAIMED',
  RUN_IN_PROGRESS: 'RUN_IN_PROGRESS',
  HELD_UNVERIFIABLE: 'HELD_UNVERIFIABLE',
  WRITE_FAILED: 'WRITE_FAILED',
  QUARANTINE_VERIFY_FAILED: 'QUARANTINE_VERIFY_FAILED',
  LOCK_LOST: 'LOCK_LOST',
};

/** Identity of a record, used to confirm the file we moved is the one we judged. */
const fingerprint = (record) => (record
  ? `${record.pid}|${record.processStartToken}|${record.runId ?? ''}|${record.startedAt ?? ''}`
  : null);

async function ownsLock(lockPath) {
  const current = readRecord(lockPath);
  const own = await captureProcessIdentity(process.pid);
  if (current === null) return { owned: false, reason: 'ABSENT', current };
  const owned = current.pid === own.pid && current.processStartToken === own.processStartToken;
  return { owned, reason: owned ? 'OWNER' : 'NOT_OWNER', current, own };
}

/**
 * Try to take the lock as this process. Returns a handle on success; on refusal
 * returns the holder so the caller can name who is running.
 */
export async function acquireCampaignLock({ lockPath = CAMPAIGN_LOCK_PATH, runId, attemptId, pages } = {}) {
  const target = path.resolve(lockPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const own = await captureProcessIdentity(process.pid);
  const holder = {
    runId: runId ?? null,
    attemptId: attemptId ?? null,
    pid: process.pid,
    startedAt: own.startedAt,
    processStartToken: own.processStartToken,
    processStartTokenFormat: own.processStartTokenFormat,
    pages: Array.isArray(pages) ? pages : null,
    host: process.env.ANTIFAN_BRIDGE_PORT ? `bridge:${process.env.ANTIFAN_BRIDGE_PORT}` : null,
    acquiredAt: new Date().toISOString(),
  };

  let reclaimedFrom = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(target, 'wx');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(holder, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return {
        ok: true,
        code: reclaimedFrom ? LOCK_CODES.RECLAIMED : LOCK_CODES.ACQUIRED,
        lockPath: target,
        holder,
        reclaimedFrom,
      };
    } catch (err) {
      if (err && err.code !== 'EEXIST') {
        return { ok: false, code: LOCK_CODES.WRITE_FAILED, lockPath: target, error: String(err.message), holder };
      }
    }

    const existing = readRecord(target);
    if (existing === null) {
      // Either the holder's first write is still in flight, or it died mid-write.
      // Both are indistinguishable from here, so refuse and let the operator look.
      return { ok: false, code: LOCK_CODES.HELD_UNVERIFIABLE, lockPath: target, holder: null, reason: 'UNREADABLE_LOCK_RECORD' };
    }
    const verdict = await proveHolderDead(existing);
    if (!verdict.dead) {
      return {
        ok: false,
        code: verdict.reason === 'ALIVE' ? LOCK_CODES.RUN_IN_PROGRESS : LOCK_CODES.HELD_UNVERIFIABLE,
        lockPath: target,
        holder: existing,
        proof: verdict,
      };
    }

    // Move the stale record aside, then confirm we moved the one we judged dead.
    const quarantine = `${target}.quarantine-${crypto.randomUUID().slice(0, 8)}`;
    try {
      fs.renameSync(target, quarantine);
    } catch (renameErr) {
      if (renameErr && renameErr.code === 'ENOENT') continue; // another contender already took it
      return { ok: false, code: LOCK_CODES.WRITE_FAILED, lockPath: target, error: String(renameErr.message), holder: existing };
    }

    const captured = readRecord(quarantine);
    if (fingerprint(captured) !== fingerprint(existing)) {
      // We moved a lock that is not the dead one we judged: a concurrent holder
      // won the path between our read and our rename. Put it back atomically and
      // stop — never continue, and never claim to hold it.
      let restored = false;
      try {
        fs.linkSync(quarantine, target);
        restored = true;
      } catch (linkErr) {
        restored = linkErr && linkErr.code === 'EEXIST';
      }
      try { fs.unlinkSync(quarantine); } catch {}
      return {
        ok: false,
        code: LOCK_CODES.QUARANTINE_VERIFY_FAILED,
        lockPath: target,
        holder: captured,
        judgedDead: existing,
        restored,
        proof: verdict,
      };
    }

    try { fs.unlinkSync(quarantine); } catch {}
    reclaimedFrom = { holder: existing, proof: verdict };
    // Loop: the next `openSync(target, 'wx')` is the actual acquisition, and it can
    // only succeed while the path is free.
  }
  return { ok: false, code: LOCK_CODES.RUN_IN_PROGRESS, lockPath: target, holder: null, reason: 'LOCK_CONTENDED_AFTER_RECLAIM' };
}

/**
 * Release on a controlled exit, and only while the lock still names this
 * process's own identity — never a successor's.
 */
export async function releaseCampaignLock(lock) {
  if (!lock || !lock.ok) return { released: false, reason: 'NO_LOCK' };
  const own = await captureProcessIdentity(process.pid);
  const result = removeRecordIf(lock.lockPath, (current) => (
    current.pid === own.pid && current.processStartToken === own.processStartToken
  ));
  return { ...result, lockPath: lock.lockPath };
}

/** Rewrite the lock to record progress without releasing it. */
export async function updateCampaignLock(lock, patch) {
  if (!lock || !lock.ok) return { updated: false, reason: 'NO_LOCK' };
  const ownership = await ownsLock(lock.lockPath);
  if (!ownership.owned) {
    return { updated: false, reason: ownership.reason === 'ABSENT' ? LOCK_CODES.LOCK_LOST : LOCK_CODES.LOCK_LOST, current: ownership.current };
  }
  const next = { ...ownership.current, ...patch, updatedAt: new Date().toISOString() };
  writeRecordAtomic(lock.lockPath, next);
  lock.holder = next;
  return { updated: true, holder: next };
}

/** Confirm the lock still names this process; callers gate every shared write on it. */
export async function assertCampaignLockHeld(lock) {
  if (!lock || !lock.ok) return { held: false, reason: 'NO_LOCK' };
  const ownership = await ownsLock(lock.lockPath);
  return { held: ownership.owned, reason: ownership.owned ? 'HELD' : LOCK_CODES.LOCK_LOST, current: ownership.current };
}
