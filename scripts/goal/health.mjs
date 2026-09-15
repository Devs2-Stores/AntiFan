/**
 * Health probes and the abort gate.
 *
 * Every bound here is a measured resource or a count of observed events — never a
 * deadline. The run has no clock; these probes are what replaces it. `checkHealth`
 * is the single gate the runner consults at each unit boundary: it returns
 * `{ abort: bool, reason, detail }` and a `true` verdict is final — the runner
 * checkpoints and exits, it does not retry.
 *
 * Probes:
 *  - disk headroom before each gate, via `checkDiskHeadroom` (two-part bound lives
 *    in thresholds.mjs so a call site cannot remember only one half);
 *  - heap ceiling from `process.memoryUsage().heapUsed`;
 *  - RSS drift per hour, measured against the first sample, gated behind a minimum
 *    observation window so a short run cannot trip the rate on noise;
 *  - consecutive verify failures, fed by `recordVerify` at each gate verdict;
 *  - criteria drift, passed in by the caller from `drift.mjs` — an abort trigger,
 *    not a retry trigger.
 */
import fs from 'node:fs';
import { THRESHOLDS, checkDiskHeadroom } from './thresholds.mjs';

const MB = 1024 * 1024;

/**
 * Minimum observation window before the RSS drift rate is judged. A rate computed
 * over seconds amplifies allocator noise into a false leak verdict; five minutes is
 * long enough that real growth dominates. This is an estimator parameter, not a
 * safety bound — the bound itself (`rssDriftMbPerHour`) stays frozen in THRESHOLDS.
 */
export const RSS_RATE_WINDOW_MS = 5 * 60_000;

function defaultStatfs(dir) {
  const s = fs.statfsSync(dir);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}

/**
 * Create a health monitor for one run.
 *
 * Injectable seams (`memoryUsage`, `statfs`, `now`) exist so tests can drive the
 * probes without leaking real memory or filling a real disk; production callers
 * pass none of them.
 */
export function createHealthMonitor({
  dir,
  thresholds = THRESHOLDS,
  memoryUsage = () => process.memoryUsage(),
  statfs = defaultStatfs,
  now = () => Date.now(),
  rateWindowMs = RSS_RATE_WINDOW_MS,
} = {}) {
  let baseline = null;
  let consecutiveVerifyFailures = 0;

  function sample() {
    const mem = memoryUsage();
    const t = now();
    if (!baseline) baseline = { rss: mem.rss, atMs: t };
    return { rss: mem.rss, heapUsed: mem.heapUsed, atMs: t };
  }

  /** Feed a unit verdict into the consecutive-failure counter. */
  function recordVerify(verdict) {
    if (verdict === 'FAIL') {
      consecutiveVerifyFailures += 1;
    } else if (verdict === 'PASS') {
      consecutiveVerifyFailures = 0;
    }
    // NOT_IMPLEMENTED and BLOCKED are judgements, not verify failures: they
    // neither advance nor reset the streak.
    return consecutiveVerifyFailures;
  }

  /**
   * The abort gate. `drift` is the result of `detectDrift` when the caller holds a
   * criteria baseline; omit it when no baseline exists yet.
   */
  function checkHealth({ drift } = {}) {
    if (drift && drift.drift) {
      return { abort: true, reason: 'CRITERIA_DRIFT', detail: drift.detail ?? null };
    }

    let disk;
    try {
      disk = checkDiskHeadroom(statfs(dir), thresholds);
    } catch (err) {
      // A disk we cannot measure is not a disk we may trust for a multi-day run.
      return { abort: true, reason: 'DISK_HEADROOM_UNKNOWN', detail: String(err && err.message) };
    }
    if (!disk.ok) {
      return { abort: true, reason: disk.reason, detail: disk.detail };
    }

    const s = sample();
    const heapMb = s.heapUsed / MB;
    if (heapMb > thresholds.heapCeilingMb) {
      return {
        abort: true,
        reason: 'HEAP_CEILING',
        detail: `heapUsed ${heapMb.toFixed(0)}MB exceeds ${thresholds.heapCeilingMb}MB`,
      };
    }

    const elapsedMs = s.atMs - baseline.atMs;
    if (elapsedMs >= rateWindowMs && elapsedMs > 0) {
      const driftMbPerHour = ((s.rss - baseline.rss) / MB) / (elapsedMs / 3_600_000);
      if (driftMbPerHour > thresholds.rssDriftMbPerHour) {
        return {
          abort: true,
          reason: 'RSS_DRIFT',
          detail: `RSS grew ${driftMbPerHour.toFixed(0)}MB/h over ${(elapsedMs / 60_000).toFixed(1)}min (bound ${thresholds.rssDriftMbPerHour}MB/h)`,
        };
      }
    }

    if (consecutiveVerifyFailures >= thresholds.consecutiveVerifyFailures) {
      return {
        abort: true,
        reason: 'CONSECUTIVE_VERIFY_FAILURES',
        detail: `${consecutiveVerifyFailures} consecutive FAIL verdicts (bound ${thresholds.consecutiveVerifyFailures})`,
      };
    }

    return { abort: false, reason: null, detail: null };
  }

  return { checkHealth, recordVerify, sample };
}
