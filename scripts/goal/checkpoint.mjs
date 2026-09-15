/**
 * Atomic checkpoints and resume.
 *
 * The invariant this exists for: if checkpoint/resume actually works, a crash loses at
 * most one unit of work. That is the thing that replaces the removed 8h clock — not a
 * promise, a mechanism.
 *
 * A checkpoint is written with `writeRecordAtomic` (temp file, fsync, rename — atomic on
 * NTFS and POSIX), so a reader sees either the previous checkpoint or the new one, never
 * a truncated one. The checkpoint carries the threshold digest so a resume can prove the
 * bounds are the same ones the run started under.
 */
import path from 'node:path';
import { writeRecordAtomic, readRecord } from '../lib/atomic-record.mjs';
import { THRESHOLD_DIGEST } from './thresholds.mjs';

export const CHECKPOINT_VERSION = 1;

export function checkpointPath(dir) {
  return path.join(dir, 'goal-checkpoint.json');
}

/**
 * The unit of work the ladder is made of. `verdict` is the four-valued vocabulary the
 * contract fixes: PASS | FAIL | NOT_IMPLEMENTED | BLOCKED. `null` means not yet judged.
 *
 * `attempt` counts how many times this unit has been attempted, so resume can prove it
 * did not silently redo finished work.
 */
export function ladderUnit({ phaseId, itemId, label }) {
  return {
    phaseId,
    itemId,
    label: label ?? null,
    verdict: null,
    attempt: 0,
    lastReceipt: null,
    updatedAt: null,
  };
}

export function emptyCheckpoint({ runId, gitSha }) {
  return {
    version: CHECKPOINT_VERSION,
    runId,
    gitSha,
    thresholdDigest: THRESHOLD_DIGEST,
    phaseId: null,
    ladder: [],
    startedAt: new Date().toISOString(),
    updatedAt: null,
  };
}

/**
 * Write a checkpoint atomically. `checkpoint` is the full state; the caller owns the
 * ladder contents. The digest is re-stamped on every write so a checkpoint written under
 * different bounds is detectable on resume.
 */
export function writeCheckpoint(dir, checkpoint) {
  const record = {
    ...checkpoint,
    thresholdDigest: THRESHOLD_DIGEST,
    updatedAt: new Date().toISOString(),
  };
  writeRecordAtomic(checkpointPath(dir), record);
  return record;
}

/**
 * Read a checkpoint for resume. Returns null when none exists or when it is unreadable —
 * a missing checkpoint is a fresh start, not an error.
 *
 * Throws when the checkpoint exists but was written under different bounds: resuming
 * under changed thresholds would silently weaken the run, which is the criteria-drift
 * failure mode the contract forbids.
 */
export function readCheckpoint(dir) {
  const record = readRecord(checkpointPath(dir));
  if (!record) return null;
  if (record.version !== CHECKPOINT_VERSION) {
    throw new Error(`checkpoint version ${record.version} is not ${CHECKPOINT_VERSION}`);
  }
  if (record.thresholdDigest !== THRESHOLD_DIGEST) {
    throw new Error(
      `checkpoint was written under different bounds (digest ${record.thresholdDigest} != ${THRESHOLD_DIGEST}); refusing to resume under changed thresholds`
    );
  }
  return record;
}

/**
 * The next unit of work after a resume: the first unit not yet judged PASS. A unit that
 * is FAIL, NOT_IMPLEMENTED, or BLOCKED is still "done" for resume purposes — it was
 * judged, and re-running it would redo finished work. Only a null verdict means the unit
 * was never reached.
 */
export function nextUnit(checkpoint) {
  if (!checkpoint || !Array.isArray(checkpoint.ladder)) return null;
  return checkpoint.ladder.find((u) => u.verdict === null) ?? null;
}

/**
 * Record a unit's verdict and bump its attempt count. Returns the updated checkpoint
 * (not yet written — the caller writes it at the gate boundary).
 */
export function recordUnitVerdict(checkpoint, { phaseId, itemId, verdict, receipt }) {
  const unit = checkpoint.ladder.find((u) => u.phaseId === phaseId && u.itemId === itemId);
  if (!unit) {
    throw new Error(`no ladder unit for ${phaseId}/${itemId}`);
  }
  unit.verdict = verdict;
  unit.attempt += 1;
  unit.lastReceipt = receipt ?? null;
  unit.updatedAt = new Date().toISOString();
  return checkpoint;
}
