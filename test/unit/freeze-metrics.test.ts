import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';

const freeze = require(path.resolve(process.cwd(), 'scripts', 'freeze-certification-core.cjs')) as {
  canonicalJson: (value: unknown) => string;
  checksumObject: (value: Record<string, unknown>, field: string) => string;
  calculateSlope: (samples: Array<Record<string, unknown>>, selector: (sample: any) => number) => number;
  classifyAppMetrics: (metrics: unknown[]) => any;
  buildThresholdManifest: (input: Record<string, unknown>) => any;
  validateThresholdManifest: (manifest: any) => any;
  activeResourceCount: (stats: any) => number;
  evaluateRunReport: (report: any, threshold: any) => any;
    validateRunReport: (report: any, threshold: any) => any;
    aggregateCertification: (reports: any[], threshold: any) => any;
    steadySlopeSamples: (report: any) => any[];
  };

function zeroResources() {
  return {
    disposed: true,
    tabCount: 0,
    attachedTabViewCount: 0,
    terminalWindowCount: 0,
    terminalWindowMetadataCount: 0,
    previewWatcherCount: 0,
    previewSubscriptionCount: 0,
    targetOperationQueueCount: 0,
    agentWorkingTimerCount: 0,
    agentWorkingRefCount: 0,
    network: { attachedTargetCount: 0, listenerCount: 0, inflightRequestCount: 0 },
    devTools: { attachedWebContentsCount: 0, hostOwnedAttachmentCount: 0, listenerTargetCount: 0, queuedTargetCount: 0 },
    terminal: { sessionCount: 0, runningPtyCount: 0 },
  };
}

function sample(timestamp: number, totalMb: number, tabMb: number) {
  return {
    timestamp,
    totalWorkingSetBytes: totalMb * 1024 * 1024,
    processCount: 3,
    classes: {
      browser: { processCount: 1, workingSetBytes: (totalMb - tabMb) * 1024 * 1024, cpuPercent: 1 },
      tab: { processCount: 2, workingSetBytes: tabMb * 1024 * 1024, cpuPercent: 2 },
      gpu: { processCount: 0, workingSetBytes: 0, cpuPercent: 0 },
      utility: { processCount: 0, workingSetBytes: 0, cpuPercent: 0 },
      other: { processCount: 0, workingSetBytes: 0, cpuPercent: 0 },
    },
    mainHeap: { heapUsed: 1024, heapTotal: 2048, external: 0, arrayBuffers: 0 },
  };
}

function threshold() {
  return freeze.buildThresholdManifest({
    buildIdentity: 'a'.repeat(64),
    workload: { capabilityInvocations: 24, artifactWrites: 2, receiptWrites: 4 },
  });
}

function passingReport(runNumber: number, processStartId = `process-start-${runNumber}-abcdef`) {
  const policy = threshold();
  const samples = [sample(0, 100, 40), sample(1_350_000, 100.1, 40.05), sample(2_700_000, 100.2, 40.1)];
  const baselineSamples = [sample(0, 100, 40), sample(500, 100, 40), sample(1000, 100, 40)];
  const steadyStateSamples = [sample(2_701_000, 101, 40.1), sample(2_701_500, 101, 40.1), sample(2_702_000, 101, 40.1)];
  const report: any = {
    schemaVersion: 1,
    type: 'antifan-core-freeze-run',
    mode: 'certification',
    durationMinutes: 45,
    runNumber,
    processStartId,
    processPid: 1000 + runNumber,
    startedAt: '2026-09-04T00:00:00.000Z',
    completedAt: '2026-09-04T00:45:00.000Z',
    buildIdentity: policy.buildIdentity,
    thresholdChecksum: policy.thresholdChecksum,
    samples,
    baselineSamples,
    steadyStateSamples,
    workloadCounters: { capabilityInvocations: 24, artifactWrites: 2, receiptWrites: 4 },
    storageBaseline: {
      artifacts: { artifactCount: 0, storedBytes: 0 },
      receipts: { receiptCount: 0, persistedBytes: 0 },
      invocations: { frameCount: 0, persistedBytes: 0 },
    },
    storageFinal: {
      artifacts: { artifactCount: 2, storedBytes: 4096 },
      receipts: { receiptCount: 4, persistedBytes: 8192 },
      invocations: { frameCount: 72, persistedBytes: 65536 },
    },
    teardown: { ownedOrphanProcessCount: 0, resources: zeroResources() },
    canaries: { staleContextAcceptedCount: 0, falseClaimVerifiedCount: 0 },
    unhandledErrorCount: 0,
    incompleteStageCount: 0,
  };
  const evaluated = freeze.evaluateRunReport(report, policy);
  report.metrics = evaluated.metrics;
  report.gates = evaluated.gates;
  report.passed = evaluated.passed;
  report.verdict = evaluated.passed ? 'PASSED' : 'FAILED';
  report.reportChecksum = freeze.checksumObject(report, 'reportChecksum');
  return { report, policy };
}

describe('freeze certification contracts', () => {
  it('rejects insufficient and zero-variance slope samples', () => {
    assert.throws(() => freeze.calculateSlope([sample(0, 1, 1), sample(1, 2, 2)], (item) => item.totalWorkingSetBytes));
    assert.throws(() => freeze.calculateSlope([sample(0, 1, 1), sample(0, 2, 2), sample(0, 3, 3)], (item) => item.totalWorkingSetBytes));
  });

  it('classifies unknown Electron process types as other while preserving totals', () => {
    const result = freeze.classifyAppMetrics([
      { type: 'Browser', memory: { workingSetSize: 10 }, cpu: { percentCPUUsage: 1 } },
      { type: 'Tab', memory: { workingSetSize: 20 }, cpu: { percentCPUUsage: 2 } },
      { type: 'FutureProcess', memory: { workingSetSize: 30 }, cpu: { percentCPUUsage: 3 } },
    ]);
    assert.strictEqual(result.processCount, 3);
    assert.strictEqual(result.totalWorkingSetBytes, 60 * 1024);
    assert.strictEqual(result.classes.other.processCount, 1);
    assert.strictEqual(result.classes.other.workingSetBytes, 30 * 1024);
  });

  it('freezes deterministic storage bounds and detects manifest tampering', () => {
    const policy = threshold();
    assert.strictEqual(policy.gates.artifactBytesGrowth, 2 * 8 * 1024 * 1024);
    assert.strictEqual(policy.gates.receiptBytesGrowth, 4 * 64 * 1024);
    assert.strictEqual(policy.gates.ledgerFrameGrowth, 24 * 3);
    assert.strictEqual(policy.gates.ledgerBytesGrowth, 24 * 3 * 1024 * 1024);
    assert.strictEqual(policy.bounds.maxInvocationFrameBytes, 64 * 1024 * 1024);
    assert.strictEqual(policy.bounds.maxCertificationInvocationFrameBytes, 1024 * 1024);
    freeze.validateThresholdManifest(policy);
    const tampered = { ...policy, gates: { ...policy.gates, rendererRssSlopeMbPerMin: 0.2 } };
    assert.throws(() => freeze.validateThresholdManifest(tampered), /checksum mismatch/);
  });

  it('fails ledger byte growth above the certification workload budget', () => {
    const { report, policy } = passingReport(1);
    report.storageFinal.invocations.persistedBytes = policy.gates.ledgerBytesGrowth + 1;
    const evaluated = freeze.evaluateRunReport(report, policy);
    assert.strictEqual(evaluated.gates.ledgerBytesGrowth.passed, false);
  });

  it('recomputes raw evidence and rejects a forged all-pass report', () => {
    const { report, policy } = passingReport(1);
    freeze.validateRunReport(report, policy);
    const forged = {
      ...report,
      metrics: { ...report.metrics, rendererRssSlopeMbPerMin: 0 },
      reportChecksum: undefined,
    };
    forged.reportChecksum = freeze.checksumObject(forged, 'reportChecksum');
    assert.throws(() => freeze.validateRunReport(forged, policy), /metrics do not match/);
  });

  it('rejects declared 45-minute reports without matching elapsed time and raw sample coverage', () => {
    const { report, policy } = passingReport(1);
    const shortElapsed = { ...report, completedAt: '2026-09-04T00:02:00.000Z', reportChecksum: undefined };
    shortElapsed.reportChecksum = freeze.checksumObject(shortElapsed, 'reportChecksum');
    assert.throws(() => freeze.validateRunReport(shortElapsed, policy), /elapsed time is shorter than 45 minutes/);

    const shortSamples = {
      ...report,
      samples: [sample(0, 100, 40), sample(60_000, 100.1, 40.05), sample(120_000, 100.2, 40.1)],
      reportChecksum: undefined,
    };
    const evaluated = freeze.evaluateRunReport(shortSamples, policy);
    shortSamples.metrics = evaluated.metrics;
    shortSamples.gates = evaluated.gates;
    shortSamples.passed = evaluated.passed;
    shortSamples.verdict = evaluated.passed ? 'PASSED' : 'FAILED';
    shortSamples.reportChecksum = freeze.checksumObject(shortSamples, 'reportChecksum');
    assert.throws(() => freeze.validateRunReport(shortSamples, policy), /raw sample span is shorter than 45 minutes/);
  });

  it('fails exact renderer and total-growth boundaries above the ratified gates', () => {
    const { report, policy } = passingReport(1);
    report.samples = [sample(0, 100, 40), sample(60_000, 100.2, 40.85), sample(120_000, 100.4, 41.7)];
    report.steadyStateSamples = [sample(121_000, 130.01, 40.3), sample(121_500, 130.01, 40.3), sample(122_000, 130.01, 40.3)];
    const evaluated = freeze.evaluateRunReport(report, policy);
    assert.strictEqual(evaluated.gates.rendererRssSlopeMbPerMin.passed, false);
    assert.strictEqual(evaluated.gates.settledTotalRssGrowthMb.passed, false);
  });

  it('isolates post-warmup steady slope window for runs >= 15 minutes', () => {
    const shortRun = { samples: [sample(0, 100, 40), sample(60_000, 101, 40.5), sample(120_000, 102, 41)] };
    assert.strictEqual(freeze.steadySlopeSamples(shortRun).length, 3);
    const longRun = {
      samples: [
        sample(0, 100, 40),
        sample(60_000, 95, 38),
        sample(120_000, 90, 36),
        sample(360_000, 91, 36.5),
        sample(1_200_000, 93, 37.5),
        sample(2_700_000, 95, 38.5),
      ],
    };
    const steady = freeze.steadySlopeSamples(longRun);
    assert.strictEqual(steady.length, 3);
    assert.strictEqual(steady[0].timestamp, 360_000);
  });

  it('counts retained owner resources and fails missing/tampered/duplicate run sets', () => {
    const { report: run1, policy } = passingReport(1);
    const { report: run2 } = passingReport(2);
    const { report: run3 } = passingReport(3);
    assert.strictEqual(freeze.activeResourceCount(zeroResources()), 0);
    assert.strictEqual(freeze.aggregateCertification([run1, run2, run3], policy).verdict, 'PASSED');
    assert.throws(() => freeze.aggregateCertification([run1, run2], policy), /Exactly three/);
    assert.throws(() => freeze.aggregateCertification([run1, run2, { ...run3, processStartId: run2.processStartId }], policy), /checksum|distinct process starts/);
    const tampered = { ...run3, canaries: { ...run3.canaries, falseClaimVerifiedCount: 1 } };
    tampered.reportChecksum = freeze.checksumObject(tampered, 'reportChecksum');
    assert.throws(() => freeze.aggregateCertification([run1, run2, tampered], policy), /gates do not match|did not pass/);
  });
});
