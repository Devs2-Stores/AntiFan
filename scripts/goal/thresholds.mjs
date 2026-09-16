/**
 * The thresholds a run is measured against, frozen before it starts.
 *
 * The 8h wall-clock stop was removed from the goal, so these bounds are what replaces
 * it. They are declared here and nowhere else: a bound that lives at its call site can
 * be loosened while a run is in flight, and a loosened bound is indistinguishable from
 * a passing run. `THRESHOLD_DIGEST` is written into every checkpoint and into the run
 * summary so a later reader can prove which bounds produced the verdicts.
 *
 * Every value is either a resource ceiling (RSS, heap, disk) or a count of observable
 * events (consecutive verify failures). None of them is a deadline: the run has no
 * deadline, and a bound expressed in elapsed time would smuggle the clock back in.
 */
import crypto from 'node:crypto';

/** Units in GB, because the platform reports disk in bytes and operators think in GB. */
const GB = 1024 * 1024 * 1024;

export const THRESHOLDS = Object.freeze({
  /**
   * Heartbeat cadence and the staleness that means "this process is not coming back".
   * The gap is deliberately 3x the cadence: one missed write is a slow disk, three in a
   * row is a stall. A tighter gap turns a full-page capture into a false abort.
   */
  heartbeatIntervalMs: 60_000,
  heartbeatStaleMs: 180_000,

  /**
   * The one time-shaped bound in the file, and it is confined to bootstrap on purpose.
   * Before the watchdog is armed nothing inside the runner can rescue it: a deadlock
   * during module load or the first browser attach leaves no heartbeat to be stale.
   * The external supervisor applies this ceiling only until the runner reports
   * `watchdogArmedAt`, and never again afterwards.
   */
  bootstrapCeilingMs: 15 * 60_000,

  /**
   * Supervised-process grace before the supervisor escalates from SIGTERM to a hard
   * kill. Long enough for a clean checkpoint write, short enough that a hung Electron
   * tree does not hold the machine.
   */
  supervisorTermGraceMs: 20_000,
  supervisorPollIntervalMs: 5_000,

  /**
   * How long a runner's mutex lease is trusted without a refresh.
   *
   * Liveness of the recorded PID is not enough to prove ownership: a crashed
   * runner whose PID was recycled by an unrelated process looks alive forever,
   * and the lock then refuses every future run. The holder refreshes this lease
   * on each heartbeat, so an unrefreshed lock is reclaimable regardless of what
   * now owns the pid.
   */
  mutexLeaseMs: 180_000,

  /** Resource ceilings. RSS drift is per hour so a slow leak is caught, not just a spike. */
  rssDriftMbPerHour: 512,
  heapCeilingMb: 4096,

  /**
   * Consecutive verify failures before abort. Three: one failure is a flake, two a
   * pattern, three means the thing under test is not working and continuing spends the
   * machine's time on a known-broken path.
   */
  consecutiveVerifyFailures: 3,

  /**
   * Disk headroom, checked before every phase gate. A multi-day run emits full-page PNGs
   * and DOM dumps, and B20 records pages above 16384px being composited from tiles, which
   * are larger still. Both a floor and a fraction are required: a fraction alone would
   * pass on a large-enough volume that is still nearly full in absolute terms.
   */
  diskHeadroomMinBytes: 20 * GB,
  diskHeadroomMinFraction: 0.1,
});

/**
 * Bounds a run may not change while it is running, and which therefore decide the
 * digest written into every checkpoint. Kept explicit so a field added to THRESHOLDS
 * without being listed here fails at import rather than escaping the freeze: every
 * timing bound is a bound, not just the long ones, because loosening the heartbeat or
 * the supervisor poll changes how a run behaves exactly as much as loosening a ceiling.
 */
export const FROZEN_KEYS = Object.freeze([
  'heartbeatIntervalMs',
  'heartbeatStaleMs',
  'supervisorPollIntervalMs',
  'supervisorTermGraceMs',
  'mutexLeaseMs',
  'bootstrapCeilingMs',
  'rssDriftMbPerHour',
  'heapCeilingMb',
  'consecutiveVerifyFailures',
  'diskHeadroomMinBytes',
  'diskHeadroomMinFraction',
]);

export function thresholdDigest(thresholds = THRESHOLDS) {
  const canonical = FROZEN_KEYS.map((k) => `${k}=${thresholds[k]}`).join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export const THRESHOLD_DIGEST = thresholdDigest();

/**
 * Assert the freeze covers the whole bound set, in both directions: every entry in
 * `thresholds` must be frozen, and every frozen key must hold a finite number. Called
 * at module load, so an unfrozen bound fails the run at import instead of quietly
 * changing behaviour without changing the digest a resumed run compares against.
 */
export function assertThresholdsComplete(thresholds = THRESHOLDS) {
  const unfrozen = Object.keys(thresholds).filter((k) => !FROZEN_KEYS.includes(k));
  if (unfrozen.length) {
    throw new Error(`thresholds outside the freeze: ${unfrozen.join(', ')} — add them to FROZEN_KEYS so the digest covers them`);
  }
  const missing = FROZEN_KEYS.filter((k) => typeof thresholds[k] !== 'number' || !Number.isFinite(thresholds[k]));
  if (missing.length) {
    throw new Error(`threshold set is incomplete: ${missing.join(', ')}`);
  }
  return true;
}

assertThresholdsComplete();

/**
 * Disk headroom is a two-part bound, so the decision lives here rather than at a call
 * site that might remember only one half.
 *
 * Returns `{ ok, reason, freeBytes, freeFraction }`. `ok: false` is an abort, not a
 * warning: the run stops before the gate instead of discovering a full volume mid-write.
 */
export function checkDiskHeadroom({ freeBytes, totalBytes }, thresholds = THRESHOLDS) {
  const freeFraction = totalBytes > 0 ? freeBytes / totalBytes : 0;
  if (freeBytes < thresholds.diskHeadroomMinBytes) {
    return {
      ok: false,
      reason: 'DISK_HEADROOM_BYTES',
      freeBytes,
      freeFraction,
      detail: `${(freeBytes / GB).toFixed(1)}G free is below the ${(thresholds.diskHeadroomMinBytes / GB).toFixed(0)}G floor`,
    };
  }
  if (freeFraction < thresholds.diskHeadroomMinFraction) {
    return {
      ok: false,
      reason: 'DISK_HEADROOM_FRACTION',
      freeBytes,
      freeFraction,
      detail: `${(freeFraction * 100).toFixed(1)}% free is below the ${(thresholds.diskHeadroomMinFraction * 100).toFixed(0)}% floor`,
    };
  }
  return { ok: true, reason: null, freeBytes, freeFraction, detail: null };
}
