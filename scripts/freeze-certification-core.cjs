'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const CERTIFICATION_DURATION_MINUTES = 45;
const SAMPLE_INTERVAL_MS = 500;
const CERTIFICATION_DURATION_MS = CERTIFICATION_DURATION_MINUTES * 60 * 1000;
const RESOURCE_SAMPLE_INTERVAL_MS = 5000;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_INVOCATION_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_CERTIFICATION_INVOCATION_FRAME_BYTES = 1024 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const INVOCATION_FRAMES_PER_CAPABILITY = 3;
const PROCESS_CLASSES = ['browser', 'tab', 'gpu', 'utility', 'other'];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  const input = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return crypto.createHash('sha256').update(input).digest('hex');
}

function checksumObject(value, checksumField) {
  const copy = { ...value };
  delete copy[checksumField];
  return sha256(canonicalJson(copy));
}

function assertFiniteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a finite non-negative number`);
}

function calculateSlope(samples, valueSelector) {
  if (!Array.isArray(samples) || samples.length < 3) {
    throw new Error('At least three samples are required to certify a slope');
  }
  const firstTimestamp = samples[0]?.timestamp;
  if (!Number.isFinite(firstTimestamp)) throw new Error('Slope samples require finite timestamps');
  const points = samples.map((sample, index) => {
    if (!Number.isFinite(sample?.timestamp)) throw new Error(`Slope sample ${index} has an invalid timestamp`);
    const value = valueSelector(sample);
    if (!Number.isFinite(value)) throw new Error(`Slope sample ${index} has an invalid value`);
    return { minutes: (sample.timestamp - firstTimestamp) / 60000, value };
  });
  const meanTime = points.reduce((sum, point) => sum + point.minutes, 0) / points.length;
  const meanValue = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const deltaTime = point.minutes - meanTime;
    covariance += deltaTime * (point.value - meanValue);
    variance += deltaTime * deltaTime;
  }
  if (!Number.isFinite(variance) || variance <= 0) {
    throw new Error('Slope samples have zero timestamp variance');
  }
  return covariance / variance;
}

function normalizeProcessClass(type) {
  const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (normalized === 'browser') return 'browser';
  if (normalized === 'tab' || normalized === 'renderer') return 'tab';
  if (normalized === 'gpu' || normalized === 'gpu process') return 'gpu';
  if (normalized === 'utility' || normalized.startsWith('utility')) return 'utility';
  return 'other';
}

function emptyProcessClassSample() {
  return { processCount: 0, workingSetBytes: 0, cpuPercent: 0 };
}

function classifyAppMetrics(metrics) {
  const classes = Object.fromEntries(PROCESS_CLASSES.map((name) => [name, emptyProcessClassSample()]));
  let totalWorkingSetBytes = 0;
  let processCount = 0;
  for (const metric of Array.isArray(metrics) ? metrics : []) {
    const className = normalizeProcessClass(metric?.type);
    const workingSetKb = Number.isFinite(metric?.memory?.workingSetSize) ? Math.max(0, metric.memory.workingSetSize) : 0;
    const cpuPercent = Number.isFinite(metric?.cpu?.percentCPUUsage) ? Math.max(0, metric.cpu.percentCPUUsage) : 0;
    const target = classes[className];
    target.processCount += 1;
    target.workingSetBytes += workingSetKb * 1024;
    target.cpuPercent += cpuPercent;
    totalWorkingSetBytes += workingSetKb * 1024;
    processCount += 1;
  }
  return { totalWorkingSetBytes, processCount, classes };
}

function buildThresholdManifest(input) {
  const workload = input?.workload;
  if (!input || typeof input.buildIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(input.buildIdentity)) {
    throw new Error('A SHA-256 build identity is required');
  }
  const requiredCounts = ['capabilityInvocations', 'artifactWrites', 'receiptWrites'];
  for (const key of requiredCounts) assertFiniteNonNegative(workload?.[key], `workload.${key}`);
  if (!Number.isInteger(workload.capabilityInvocations) || !Number.isInteger(workload.artifactWrites) || !Number.isInteger(workload.receiptWrites)) {
    throw new Error('Workload counts must be integers');
  }
  const maxLedgerFrameGrowth = workload.capabilityInvocations * INVOCATION_FRAMES_PER_CAPABILITY;
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    type: 'antifan-core-freeze-thresholds',
    buildIdentity: input.buildIdentity,
    certificationDurationMinutes: CERTIFICATION_DURATION_MINUTES,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    resourceSampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
    workload: { ...workload },
    gates: {
      settledTotalRssGrowthMb: 30,
      overallTotalRssSlopeMbPerMin: 1.0,
      rendererRssSlopeMbPerMin: 0.8,
      ownedOrphanProcessCount: 0,
      activeResourceCountAfterTeardown: 0,
      staleContextAcceptedCount: 0,
      falseClaimVerifiedCount: 0,
      unhandledErrorCount: 0,
      artifactCountGrowth: workload.artifactWrites,
      artifactBytesGrowth: workload.artifactWrites * MAX_ARTIFACT_BYTES,
      receiptCountGrowth: workload.receiptWrites,
      receiptBytesGrowth: workload.receiptWrites * MAX_RECEIPT_BYTES,
      ledgerFrameGrowth: maxLedgerFrameGrowth,
      ledgerBytesGrowth: maxLedgerFrameGrowth * MAX_CERTIFICATION_INVOCATION_FRAME_BYTES,
    },
    bounds: {
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      maxInvocationFrameBytes: MAX_INVOCATION_FRAME_BYTES,
      maxCertificationInvocationFrameBytes: MAX_CERTIFICATION_INVOCATION_FRAME_BYTES,
      maxReceiptBytes: MAX_RECEIPT_BYTES,
      invocationFramesPerCapability: INVOCATION_FRAMES_PER_CAPABILITY,
    },
  };
  return { ...manifest, thresholdChecksum: checksumObject(manifest, 'thresholdChecksum') };
}

function validateThresholdManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== SCHEMA_VERSION || manifest.type !== 'antifan-core-freeze-thresholds') {
    throw new Error('Invalid freeze threshold schema');
  }
  if (manifest.certificationDurationMinutes !== CERTIFICATION_DURATION_MINUTES) {
    throw new Error('Certification duration must remain exactly 45 minutes');
  }
  if (manifest.bounds?.maxArtifactBytes !== MAX_ARTIFACT_BYTES ||
      manifest.bounds?.maxInvocationFrameBytes !== MAX_INVOCATION_FRAME_BYTES ||
      manifest.bounds?.maxCertificationInvocationFrameBytes !== MAX_CERTIFICATION_INVOCATION_FRAME_BYTES ||
      manifest.bounds?.maxReceiptBytes !== MAX_RECEIPT_BYTES ||
      manifest.bounds?.invocationFramesPerCapability !== INVOCATION_FRAMES_PER_CAPABILITY) {
    throw new Error('Threshold owner and certification bounds do not match the implementation contract');
  }
  for (const [key, value] of Object.entries(manifest.gates || {})) assertFiniteNonNegative(value, `gates.${key}`);
  const expected = checksumObject(manifest, 'thresholdChecksum');
  if (manifest.thresholdChecksum !== expected) throw new Error('Freeze threshold checksum mismatch');
  return manifest;
}

function activeResourceCount(stats) {
  if (!stats || typeof stats !== 'object') return Number.POSITIVE_INFINITY;
  const values = [
    stats.tabCount,
    stats.attachedTabViewCount,
    stats.terminalWindowCount,
    stats.terminalWindowMetadataCount,
    stats.previewWatcherCount,
    stats.previewSubscriptionCount,
    stats.targetOperationQueueCount,
    stats.agentWorkingTimerCount,
    stats.agentWorkingRefCount,
    stats.network?.attachedTargetCount,
    stats.network?.listenerCount,
    stats.network?.inflightRequestCount,
    stats.devTools?.attachedWebContentsCount,
    stats.devTools?.hostOwnedAttachmentCount,
    stats.devTools?.listenerTargetCount,
    stats.devTools?.queuedTargetCount,
    stats.terminal?.sessionCount,
    stats.terminal?.runningPtyCount,
    stats.controlPlane?.terminal?.sessionCount ?? 0,
    stats.controlPlane?.terminal?.runningPtyCount ?? 0,
    stats.controlPlane?.invocations?.inFlightCount ?? 0,
    stats.controlPlane?.invocations?.queuedIoCount ?? 0,
  ];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return Number.POSITIVE_INFINITY;
  return values.reduce((sum, value) => sum + value, 0);
}

function mean(samples, selector) {
  if (!Array.isArray(samples) || samples.length < 3) throw new Error('At least three samples are required to certify a mean');
  const values = samples.map((sample, index) => {
    const value = selector(sample);
    if (!Number.isFinite(value)) throw new Error(`Mean sample ${index} has an invalid value`);
    return value;
  });
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function nonNegativeDelta(finalValue, baselineValue, label) {
  assertFiniteNonNegative(finalValue, `${label}.final`);
  assertFiniteNonNegative(baselineValue, `${label}.baseline`);
  return Math.max(0, finalValue - baselineValue);
}
function steadySlopeSamples(report) {
  const samples = report?.samples;
  if (!Array.isArray(samples) || samples.length < 3) return samples || [];
  const firstTimestamp = samples[0]?.timestamp;
  const lastTimestamp = samples[samples.length - 1]?.timestamp;
  if (!Number.isFinite(firstTimestamp) || !Number.isFinite(lastTimestamp)) return samples;
  const totalDurationMs = lastTimestamp - firstTimestamp;
  if (totalDurationMs >= 15 * 60 * 1000) {
    const warmupCutoff = firstTimestamp + 5 * 60 * 1000;
    const steady = samples.filter((s) => s.timestamp >= warmupCutoff);
    if (steady.length >= 3) return steady;
  }
  return samples;
}


function evaluateRunReport(report, thresholdManifest) {
  validateThresholdManifest(thresholdManifest);
  if (!Array.isArray(report?.samples) || !Array.isArray(report?.baselineSamples) || !Array.isArray(report?.steadyStateSamples)) {
    throw new Error('Freeze run raw sample windows are required');
  }
  const slopeSamples = steadySlopeSamples(report);
  const totalSlope = calculateSlope(slopeSamples, (sample) => sample.totalWorkingSetBytes / (1024 * 1024));
  const rendererSlope = calculateSlope(slopeSamples, (sample) => sample.classes?.tab?.workingSetBytes / (1024 * 1024));
  const baselineRssMb = mean(report.baselineSamples, (sample) => sample.totalWorkingSetBytes / (1024 * 1024));
  const settledRssMb = mean(report.steadyStateSamples, (sample) => sample.totalWorkingSetBytes / (1024 * 1024));
  const settledGrowthMb = settledRssMb - baselineRssMb;
  const baseline = report.storageBaseline;
  const final = report.storageFinal;
  if (!baseline || !final) throw new Error('Freeze run storage owner snapshots are required');
  const storageGrowth = {
    artifactCount: nonNegativeDelta(final.artifacts?.artifactCount, baseline.artifacts?.artifactCount, 'artifactCount'),
    artifactBytes: nonNegativeDelta(final.artifacts?.storedBytes, baseline.artifacts?.storedBytes, 'artifactBytes'),
    receiptCount: nonNegativeDelta(final.receipts?.receiptCount, baseline.receipts?.receiptCount, 'receiptCount'),
    receiptBytes: nonNegativeDelta(final.receipts?.persistedBytes, baseline.receipts?.persistedBytes, 'receiptBytes'),
    ledgerFrames: nonNegativeDelta(final.invocations?.frameCount, baseline.invocations?.frameCount, 'ledgerFrames'),
    ledgerBytes: nonNegativeDelta(final.invocations?.persistedBytes, baseline.invocations?.persistedBytes, 'ledgerBytes'),
  };
  const limits = thresholdManifest.gates;
  const gate = (actual, limit) => ({ actual, limit, passed: Number.isFinite(actual) && actual <= limit });
  const gates = {
    settledTotalRssGrowthMb: gate(settledGrowthMb, limits.settledTotalRssGrowthMb),
    overallTotalRssSlopeMbPerMin: gate(totalSlope, limits.overallTotalRssSlopeMbPerMin),
    rendererRssSlopeMbPerMin: gate(rendererSlope, limits.rendererRssSlopeMbPerMin),
    ownedOrphanProcessCount: gate(report.teardown?.ownedOrphanProcessCount, limits.ownedOrphanProcessCount),
    activeResourceCountAfterTeardown: gate(activeResourceCount(report.teardown?.resources), limits.activeResourceCountAfterTeardown),
    staleContextAcceptedCount: gate(report.canaries?.staleContextAcceptedCount, limits.staleContextAcceptedCount),
    falseClaimVerifiedCount: gate(report.canaries?.falseClaimVerifiedCount, limits.falseClaimVerifiedCount),
    unhandledErrorCount: gate(report.unhandledErrorCount, limits.unhandledErrorCount),
    incompleteStageCount: gate(report.incompleteStageCount, 0),
    artifactCountGrowth: gate(storageGrowth.artifactCount, limits.artifactCountGrowth),
    artifactBytesGrowth: gate(storageGrowth.artifactBytes, limits.artifactBytesGrowth),
    receiptCountGrowth: gate(storageGrowth.receiptCount, limits.receiptCountGrowth),
    receiptBytesGrowth: gate(storageGrowth.receiptBytes, limits.receiptBytesGrowth),
    ledgerFrameGrowth: gate(storageGrowth.ledgerFrames, limits.ledgerFrameGrowth),
    ledgerBytesGrowth: gate(storageGrowth.ledgerBytes, limits.ledgerBytesGrowth),
  };
  const workloadMatches = report.workloadCounters?.capabilityInvocations === thresholdManifest.workload.capabilityInvocations &&
    report.workloadCounters?.artifactWrites === thresholdManifest.workload.artifactWrites &&
    report.workloadCounters?.receiptWrites === thresholdManifest.workload.receiptWrites;
  gates.workloadContract = { actual: workloadMatches ? 0 : 1, limit: 0, passed: workloadMatches };
  return {
    metrics: {
      baselineRssMb,
      settledRssMb,
      settledGrowthMb,
      overallTotalRssSlopeMbPerMin: totalSlope,
      rendererRssSlopeMbPerMin: rendererSlope,
      storageGrowth,
    },
    gates,
    passed: Object.values(gates).every((item) => item.passed),
  };
}

function validateRunReport(report, thresholdManifest) {
  validateThresholdManifest(thresholdManifest);
  if (!report || report.schemaVersion !== SCHEMA_VERSION || report.type !== 'antifan-core-freeze-run') {
    throw new Error('Invalid freeze run schema');
  }
  if (report.mode !== 'certification' || report.durationMinutes !== CERTIFICATION_DURATION_MINUTES) {
    throw new Error('Only an exact 45-minute certification report can pass');
  }
  if (!Number.isInteger(report.runNumber) || report.runNumber < 1 || report.runNumber > 3) throw new Error('Invalid run number');
  if (typeof report.processStartId !== 'string' || report.processStartId.length < 16) throw new Error('Missing process start identity');
  if (!Number.isInteger(report.processPid) || report.processPid <= 0) throw new Error('Missing process PID');
  if (report.buildIdentity !== thresholdManifest.buildIdentity) throw new Error('Run build identity mismatch');
  if (report.thresholdChecksum !== thresholdManifest.thresholdChecksum) throw new Error('Run threshold checksum mismatch');
  if (!Array.isArray(report.samples) || report.samples.length < 3) throw new Error('Run has insufficient raw samples');
  if (!Array.isArray(report.baselineSamples) || report.baselineSamples.length < 3) throw new Error('Run has insufficient baseline samples');
  if (!Array.isArray(report.steadyStateSamples) || report.steadyStateSamples.length < 3) throw new Error('Run has insufficient steady-state samples');
  const startedAtMs = Date.parse(report.startedAt);
  const completedAtMs = Date.parse(report.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs - startedAtMs < CERTIFICATION_DURATION_MS) {
    throw new Error('Certification report elapsed time is shorter than 45 minutes');
  }
  let previousSampleTimestamp = -Infinity;
  for (const [index, sample] of report.samples.entries()) {
    if (!Number.isFinite(sample?.timestamp) || sample.timestamp <= previousSampleTimestamp) {
      throw new Error(`Certification sample ${index} has a non-monotonic timestamp`);
    }
    previousSampleTimestamp = sample.timestamp;
  }
  if (report.samples.at(-1).timestamp - report.samples[0].timestamp < CERTIFICATION_DURATION_MS) {
    throw new Error('Certification raw sample span is shorter than 45 minutes');
  }
  const evaluated = evaluateRunReport(report, thresholdManifest);
  if (canonicalJson(report.metrics) !== canonicalJson(evaluated.metrics)) throw new Error('Freeze run metrics do not match raw evidence');
  if (canonicalJson(report.gates) !== canonicalJson(evaluated.gates)) throw new Error('Freeze run gates do not match raw evidence');
  if (report.verdict !== 'PASSED' || report.passed !== true || !evaluated.passed) throw new Error('Freeze run did not pass');
  const expectedChecksum = checksumObject(report, 'reportChecksum');
  if (report.reportChecksum !== expectedChecksum) throw new Error('Freeze run report checksum mismatch');
  if (activeResourceCount(report.teardown?.resources) !== 0) throw new Error('Freeze run retained active resources after teardown');
  if (report.teardown?.ownedOrphanProcessCount !== 0) throw new Error('Freeze run retained an owned process');
  if (report.canaries?.staleContextAcceptedCount !== 0 || report.canaries?.falseClaimVerifiedCount !== 0) {
    throw new Error('Freeze correctness canary was falsely accepted');
  }
  if (report.unhandledErrorCount !== 0 || report.incompleteStageCount !== 0) throw new Error('Freeze run was incomplete');
  return report;
}

function aggregateCertification(reports, thresholdManifest) {
  validateThresholdManifest(thresholdManifest);
  if (!Array.isArray(reports) || reports.length !== 3) throw new Error('Exactly three freeze reports are required');
  const validated = reports.map((report) => validateRunReport(report, thresholdManifest));
  const runNumbers = new Set(validated.map((report) => report.runNumber));
  const processStarts = new Set(validated.map((report) => report.processStartId));
  const pids = new Set(validated.map((report) => report.processPid));
  if (runNumbers.size !== 3 || ![1, 2, 3].every((run) => runNumbers.has(run))) throw new Error('Runs 1, 2, and 3 are all required');
  if (processStarts.size !== 3) throw new Error('Certification runs must have distinct process starts');
  if (pids.size < 1) throw new Error('Certification run process identities are invalid');
  const certificate = {
    schemaVersion: SCHEMA_VERSION,
    type: 'antifan-core-freeze-certificate',
    verdict: 'PASSED',
    buildIdentity: thresholdManifest.buildIdentity,
    thresholdChecksum: thresholdManifest.thresholdChecksum,
    issuedAt: new Date().toISOString(),
    runs: validated
      .map((report) => ({
        runNumber: report.runNumber,
        processStartId: report.processStartId,
        processPid: report.processPid,
        reportChecksum: report.reportChecksum,
      }))
      .sort((a, b) => a.runNumber - b.runNumber),
  };
  return { ...certificate, certificateChecksum: checksumObject(certificate, 'certificateChecksum') };
}

module.exports = {
  SCHEMA_VERSION,
  CERTIFICATION_DURATION_MINUTES,
  SAMPLE_INTERVAL_MS,
  RESOURCE_SAMPLE_INTERVAL_MS,
  MAX_ARTIFACT_BYTES,
  MAX_INVOCATION_FRAME_BYTES,
  MAX_CERTIFICATION_INVOCATION_FRAME_BYTES,
  MAX_RECEIPT_BYTES,
  steadySlopeSamples,
  INVOCATION_FRAMES_PER_CAPABILITY,
  PROCESS_CLASSES,
  canonicalJson,
  sha256,
  checksumObject,
  calculateSlope,
  normalizeProcessClass,
  classifyAppMetrics,
  buildThresholdManifest,
  validateThresholdManifest,
  activeResourceCount,
  evaluateRunReport,
  validateRunReport,
  aggregateCertification,
};
