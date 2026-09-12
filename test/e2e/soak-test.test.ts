/**
 * AntiFan Browser Desktop — In-Memory Slope Math & Telemetry Schema Unit Test
 *
 * NOTE: This test file verifies the mathematical linear regression slope formula
 * and SoakBenchmarkReport schema in memory (< 100ms). It simulates load; it does not
 * observe a real soak, and it derives every reported field from the samples it measured
 * instead of declaring a verdict.
 *
 * AUTHORITATIVE OS RELEASE GATES:
 * - Standalone Recovery (30m): `scripts/benchmark-standalone-recovery.cjs`
 * - Production Soak (8h): `scripts/benchmark-real-soak-8h.cjs`
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface MemorySample {
  timestamp: number; // Unix ms
  rssBytes: number;
  heapUsedBytes?: number;
}
/** The simulated run must record at least this many samples to describe a trend. */
const REQUIRED_SAMPLES = 10;
/** Slope ceiling (MB/min) above which the simulated run reports itself as failed. */
const SOAK_SLOPE_LIMIT_MB_PER_MIN = 5;

export interface SoakBenchmarkReport {
  timestamp: number;
  durationMs: number;
  samplesCount: number;
  baselineRssMB: number;
  peakRssMB: number;
  finalRssMB: number;
  memorySlopeMBPerMin: number;
  stageResults: {
    stage1Idle: { durationMs: number; baselineRssMB: number };
    stage2Streaming: { durationMs: number; ptyBytesSent: number; chunkCount: number };
    stage3MixedThrash: { durationMs: number; tabSwitches: number; qaRuns: number };
    stage4Endurance: { durationMs: number; reloads: number; picks: number; qaValidations: number };
  };
  orphanProcessesCount: number;
  passed: boolean;
}

/**
 * Computes linear regression slope Beta = Cov(t, RAM) / Var(t) in MB / min
 */
export function calculateMemorySlope(samples: MemorySample[]): number {
  const n = samples.length;
  if (n < 2) return 0;

  const firstT = samples[0]!.timestamp;
  const tMinutes = samples.map((s) => (s.timestamp - firstT) / 60000);
  const rMB = samples.map((s) => s.rssBytes / (1024 * 1024));

  const meanT = tMinutes.reduce((acc, t) => acc + t, 0) / n;
  const meanM = rMB.reduce((acc, m) => acc + m, 0) / n;

  let num = 0;
  let den = 0;

  for (let i = 0; i < n; i++) {
    const dt = tMinutes[i]! - meanT;
    const dm = rMB[i]! - meanM;
    num += dt * dm;
    den += dt * dt;
  }

  return den === 0 ? 0 : num / den;
}

describe('Automated 4-Stage Soak Test Suite (Phase 4)', () => {
  it('accurately calculates linear memory regression slope (Beta)', () => {
    const now = Date.now();
    const mockFlatSamples: MemorySample[] = [
      { timestamp: now, rssBytes: 100 * 1024 * 1024 },
      { timestamp: now + 60000, rssBytes: 100 * 1024 * 1024 },
      { timestamp: now + 120000, rssBytes: 100 * 1024 * 1024 },
      { timestamp: now + 180000, rssBytes: 100 * 1024 * 1024 },
    ];
    const flatSlope = calculateMemorySlope(mockFlatSamples);
    assert.strictEqual(Math.abs(flatSlope) < 0.001, true, 'Flat memory must have slope near 0 MB/min');

    // Simulate 2 MB increase per minute
    const mockRisingSamples: MemorySample[] = [
      { timestamp: now, rssBytes: 100 * 1024 * 1024 },
      { timestamp: now + 60000, rssBytes: 102 * 1024 * 1024 },
      { timestamp: now + 120000, rssBytes: 104 * 1024 * 1024 },
      { timestamp: now + 180000, rssBytes: 106 * 1024 * 1024 },
    ];
    const risingSlope = calculateMemorySlope(mockRisingSamples);
    assert.strictEqual(Math.abs(risingSlope - 2.0) < 0.01, true, 'Rising memory slope must equal 2 MB/min');
  });

  it('derives the soak report fields from the samples it measured', async () => {
    const samples: MemorySample[] = [];
    const startTime = Date.now();
    // This simulation spawns no child process, so it can report the child count it actually
    // owns instead of a literal zero.
    const spawnedChildProcesses = 0;

    // Sample initial baseline
    samples.push({
      timestamp: Date.now(),
      rssBytes: process.memoryUsage().rss,
      heapUsedBytes: process.memoryUsage().heapUsed,
    });

    // Stage 1: Idle Baseline Simulation (5 fast ticks)
    const stage1Start = Date.now();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
    }
    const stage1Duration = Date.now() - stage1Start;

    // Stage 2: Streaming Stress Simulation (high volume burst)
    const stage2Start = Date.now();
    let ptyBytesSent = 0;
    let chunkCount = 0;
    const streamBuffer = Buffer.alloc(10 * 1024, 'x'); // 10KB chunks
    for (let i = 0; i < 10; i++) {
      ptyBytesSent += streamBuffer.byteLength;
      chunkCount++;
      await new Promise((r) => setTimeout(r, 5));
    }
    samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
    const stage2Duration = Date.now() - stage2Start;

    // Stage 3: Mixed Thrash Simulation (concurrent operations)
    const stage3Start = Date.now();
    let tabSwitches = 0;
    let qaRuns = 0;
    for (let i = 0; i < 5; i++) {
      tabSwitches += 2;
      qaRuns += 1;
      await new Promise((r) => setTimeout(r, 10));
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
    }
    const stage3Duration = Date.now() - stage3Start;

    // Stage 4: Endurance Soak Simulation (repeated reloads & picks)
    const stage4Start = Date.now();
    let reloads = 0;
    let picks = 0;
    let qaValidations = 0;
    for (let i = 0; i < 10; i++) {
      reloads += 2;
      picks += 5;
      qaValidations += 1;
      await new Promise((r) => setTimeout(r, 5));
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
    }
    const stage4Duration = Date.now() - stage4Start;

    const slope = calculateMemorySlope(samples);
    const durationMs = Date.now() - startTime;
    const baselineRssMB = samples[0]!.rssBytes / (1024 * 1024);
    const peakRssMB = Math.max(...samples.map((s) => s.rssBytes)) / (1024 * 1024);
    const finalRssMB = samples[samples.length - 1]!.rssBytes / (1024 * 1024);

    const report: SoakBenchmarkReport = {
      timestamp: startTime,
      durationMs,
      samplesCount: samples.length,
      baselineRssMB,
      peakRssMB,
      finalRssMB,
      memorySlopeMBPerMin: slope,
      stageResults: {
        stage1Idle: { durationMs: stage1Duration, baselineRssMB },
        stage2Streaming: { durationMs: stage2Duration, ptyBytesSent, chunkCount },
        stage3MixedThrash: { durationMs: stage3Duration, tabSwitches, qaRuns },
        stage4Endurance: { durationMs: stage4Duration, reloads, picks, qaValidations },
      },
      orphanProcessesCount: spawnedChildProcesses,
      passed: Math.abs(slope) <= SOAK_SLOPE_LIMIT_MB_PER_MIN && samples.length >= REQUIRED_SAMPLES,
    };

    // Every assertion below re-derives its expectation from the recorded samples, so a report
    // that carried a declared value instead of a measured one fails here.
    assert.strictEqual(report.samplesCount, samples.length, 'sample count must come from the recorded samples');
    assert.ok(report.samplesCount >= REQUIRED_SAMPLES, `Must record at least ${REQUIRED_SAMPLES} telemetry samples`);
    assert.ok(
      samples.every((s, i) => i === 0 || s.timestamp >= samples[i - 1]!.timestamp),
      'sample timestamps must be monotonic',
    );
    assert.ok(report.peakRssMB >= report.baselineRssMB, 'peak RSS cannot be below the baseline');
    assert.ok(report.peakRssMB >= report.finalRssMB, 'peak RSS cannot be below the final sample');
    assert.strictEqual(report.memorySlopeMBPerMin, slope, 'reported slope must be the slope of the measured samples');
    assert.strictEqual(
      report.stageResults.stage2Streaming.ptyBytesSent,
      report.stageResults.stage2Streaming.chunkCount * 10 * 1024,
      'bytes sent must equal chunk count × chunk size',
    );
    assert.strictEqual(report.stageResults.stage3MixedThrash.tabSwitches, 5 * 2, 'stage 3 switches must be the ticks × 2');
    assert.strictEqual(report.stageResults.stage4Endurance.qaValidations, 10, 'stage 4 validations must be the tick count');
    assert.strictEqual(
      report.orphanProcessesCount,
      spawnedChildProcesses,
      'the report may only count children this simulation actually spawned',
    );
  });
});
