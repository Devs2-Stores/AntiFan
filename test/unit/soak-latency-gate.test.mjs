/**
 * Soak switch-latency gate — the real `evaluateFreezeVerdict` from the soak harness.
 *
 * Contract under test, as decided on the 4 h run's evidence: the workload latency gate
 * grades percentiles (p50 <= 12 ms, p95 <= 18 ms) and reports the maximum without
 * grading it, because the measured tail was a global stall hitting every destination at
 * ~0.2 % of switches. Two silent failures are what this file defends:
 *
 *  - a re-added `max <= 35` term would fail runs on an event the gate cannot attribute;
 *  - a missing latency series must not pass, which is why the gate reads `switchCount`
 *    instead of treating an absent series as a satisfied bound.
 *
 * The verdict function is required from `scripts/benchmark-real-soak-8h.cjs` rather than
 * re-implemented here: a copy of a threshold certifies nothing about production.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FREEZE_SLO, evaluateFreezeVerdict } = require('../../scripts/benchmark-real-soak-8h.cjs');

const passingMeta = {
  processQuerySuccess: true,
  executionError: null,
  childExitedPrematurely: false,
  teardownTelemetry: { teardownDegraded: false },
};

function metricsWithLatency(quantiles, workloadCount) {
  return {
    overallActiveSlopeMBPerMin: 0.1,
    rendererActiveSlopeMBPerMin: 0.05,
    appPrivateMaxSlopeMBPerMin: 0.05,
    activeWorkingSetMB: { max: 1000 },
    switchLatencyWorkloadCount: workloadCount,
    switchLatencyMs: quantiles,
  };
}

describe('soak switch-latency gate (production evaluateFreezeVerdict)', () => {
  it('passes when only the maximum breaches the old 35 ms bound', () => {
    const metrics = metricsWithLatency({ min: 4, p50: 10.3, p95: 15.5, max: 50.976 }, 4090);
    const verdict = evaluateFreezeVerdict(passingMeta, metrics, 0);
    assert.strictEqual(verdict.latencyOk, true);
  });

  it('reports the maximum even though it does not grade it', () => {
    const metrics = metricsWithLatency({ min: 4, p50: 10.3, p95: 15.5, max: 50.976 }, 4090);
    const verdict = evaluateFreezeVerdict(passingMeta, metrics, 0);
    assert.strictEqual(verdict.switchMaxMs, 50.976);
    assert.strictEqual(verdict.latencyMaxGated, false);
  });

  it('fails when p95 clears the bound', () => {
    const metrics = metricsWithLatency({ min: 4, p50: 10.3, p95: FREEZE_SLO.switchLatencyP95Ms + 1, max: 20 }, 4090);
    const verdict = evaluateFreezeVerdict(passingMeta, metrics, 0);
    assert.strictEqual(verdict.latencyOk, false);
  });

  it('fails when p50 clears the bound', () => {
    const metrics = metricsWithLatency({ min: 4, p50: FREEZE_SLO.switchLatencyP50Ms + 1, p95: 15, max: 20 }, 4090);
    const verdict = evaluateFreezeVerdict(passingMeta, metrics, 0);
    assert.strictEqual(verdict.latencyOk, false);
  });

  it('treats the bounds as inclusive', () => {
    const metrics = metricsWithLatency(
      { min: 4, p50: FREEZE_SLO.switchLatencyP50Ms, p95: FREEZE_SLO.switchLatencyP95Ms, max: 900 },
      4090
    );
    const verdict = evaluateFreezeVerdict(passingMeta, metrics, 0);
    assert.strictEqual(verdict.latencyOk, true);
  });

  it('does not pass a run with no measured switches', () => {
    const metrics = metricsWithLatency({ min: null, p50: null, p95: null, max: null }, 0);
    const verdict = evaluateFreezeVerdict(passingMeta, metrics, 0);
    assert.strictEqual(verdict.latencyOk, false);
  });
});
