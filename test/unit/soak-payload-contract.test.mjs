/**
 * Soak payload — the switch series and the measured workload span, graded against the real
 * `buildReportPayload`.
 *
 * The 4 h run kept only its ten slowest switches, which is enough to say a tail exists and
 * not enough to say what produces it: a stall caused by a collision with the terminal write
 * path and a stall indifferent to it produce the same top ten. Carrying the whole series is
 * what makes the tail attributable, and the same payload mislabelled a second quantity — a
 * field named `activeWorkloadMinutes` held elapsed-since-start. The silent failures both
 * contracts defend:
 *
 *  - the series being dropped from the payload again (the field is what the analyzer reads);
 *  - a truncated series being read as a complete one, which is why `switchSamplesDropped`
 *    must accompany the cap rather than the cap silently shortening the series;
 *  - a phase span being reported as the workload's own span (or as 0 when it never ran).
 *
 * The builder is required from `scripts/benchmark-real-soak-8h.cjs` rather than
 * re-implemented here: a copy of a payload rule certifies nothing about production.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildReportPayload, EXTRA_APP_ARGS, calculateCpuDeltas, costPerUnit, readProcessCpuSeconds } = require('../../scripts/benchmark-real-soak-8h.cjs');

const baseMeta = {
  startedAt: '2026-09-20T00:00:00.000Z',
  finishedAt: '2026-09-20T04:00:00.000Z',
  rootPid: 1234,
  fixturePort: 4000,
  requestCount: 0,
  tabIds: [],
  switches: 0,
  bursts: 0,
  reloads: 0,
  terminalEventCount: 0,
  samples: [],
  switchLatencies: [],
  switchLatencyByTab: new Map(),
  tabUrlById: new Map(),
  processSamples: [],
  orphanPids: [],
  stdout: '',
  stderr: '',
  teardownTelemetry: { teardownDegraded: false },
  processQuerySuccess: true,
  executionError: null,
  childExitedPrematurely: false,
  legs: [],
};

function sample(i, ms, phase, leg) {
  return { at: 1789000000000 + i * 3000, ms, tabId: `tab-${i % 3}`, phase, leg };
}

describe('soak payload — switch series', () => {
  it('carries every switch, not only the slowest ten', () => {
    const rows = Array.from({ length: 120 }, (_, i) => sample(i, 8 + (i % 5), 'workload', 'baseline#1'));
    const payload = buildReportPayload({ ...baseMeta, switchSamples: rows, switches: rows.length });
    assert.strictEqual(payload.switchSamples.length, 120);
    assert.strictEqual(payload.switchSamplesDropped, 0);
    assert.strictEqual(payload.slowSwitchSamples.length, 10);
    // The leg a switch ran in is what makes the tail attributable per regime.
    assert.strictEqual(payload.switchSamples[7].leg, 'baseline#1');
    assert.strictEqual(payload.switchSamples[7].phase, 'workload');
  });

  it('caps the series and reports how many rows were dropped', () => {
    const rows = Array.from({ length: 25000 }, (_, i) => sample(i, 9, 'workload', 'burst4x#2'));
    const payload = buildReportPayload({ ...baseMeta, switchSamples: rows, switches: rows.length });
    assert.strictEqual(payload.switchSamples.length, 20000);
    assert.strictEqual(payload.switchSamplesDropped, 5000);
  });

  it('ranks the slowest ten by latency, not by arrival order', () => {
    const rows = [
      sample(0, 9, 'workload', 'baseline#1'),
      sample(1, 50.976, 'workload', 'baseline#1'),
      sample(2, 12, 'workload', 'baseline#1'),
    ];
    const payload = buildReportPayload({ ...baseMeta, switchSamples: rows, switches: rows.length });
    assert.strictEqual(payload.slowSwitchSamples[0].ms, 50.976);
    assert.strictEqual(payload.slowSwitchSamples[1].ms, 12);
  });

  it('reports an empty series rather than omitting the field', () => {
    const payload = buildReportPayload({ ...baseMeta, switchSamples: [], switches: 0 });
    assert.deepStrictEqual(payload.switchSamples, []);
    assert.strictEqual(payload.switchSamplesDropped, 0);
  });

  it('survives a meta object with no switch series at all', () => {
    const { switchSamples, ...withoutSeries } = baseMeta;
    const payload = buildReportPayload({ ...withoutSeries, switches: 0 });
    assert.deepStrictEqual(payload.switchSamples, []);
    assert.strictEqual(payload.switchSamplesDropped, 0);
  });
});

describe('soak payload — run identity', () => {
  it('records the app switches the run was launched with', () => {
    // A diagnosis run opens a DevTools endpoint; if the payload did not carry the argv, its
    // numbers would be read as a clean baseline later. The empty array is the measurement case.
    const payload = buildReportPayload({ ...baseMeta });
    assert.deepStrictEqual(payload.config.appArgs, EXTRA_APP_ARGS);
    assert.ok(Array.isArray(payload.config.appArgs));
  });
});

describe('soak payload — measured workload span', () => {
  const sampleAt = (label, at, activeAt) => ({ at, activeAt, label, totalWorkingSetMB: 100, byType: {} });

  it('reports the workload phase span, not elapsed-since-start', () => {
    const samples = [
      sampleAt('warmup', 1_000_000, 1_000_000),
      sampleAt('workload', 2_000_000, 1_500_000),
      sampleAt('workload', 5_600_000, 5_100_000),
      sampleAt('recovery', 6_000_000, 5_900_000),
    ];
    // elapsed-since-start at that point is 4.9 min; the phase's own sleep-adjusted span is 60.
    const payload = buildReportPayload({ ...baseMeta, samples, activeMinutesSinceStart: 4.9 });
    assert.strictEqual(payload.stats.activeWorkloadMinutes, 60);
    assert.strictEqual(payload.stats.activeMinutesSinceStart, 4.9);
  });

  it('excludes suspended time, because the span comes from the sleep-adjusted stamps', () => {
    const samples = [sampleAt('workload', 2_000_000, 2_000_000), sampleAt('workload', 4_000_000, 2_600_000)];
    const payload = buildReportPayload({ ...baseMeta, samples });
    assert.strictEqual(payload.stats.activeWorkloadMinutes, 10);
  });

  it('reports a phase that never ran as not measured, not as zero minutes', () => {
    const payload = buildReportPayload({ ...baseMeta, samples: [sampleAt('warmup', 1_000_000, 1_000_000)] });
    assert.strictEqual(payload.stats.activeWorkloadMinutes, null);
  });
});

describe('soak payload — CPU accounting', () => {
  const procSample = (at, cpuByPid, processes = []) => ({ at, cpuByPid, processes });

  it('differences the window endpoints instead of sampling a rate', () => {
    // The workload bursts every 30 s, so a rate read once a minute can land between two
    // bursts: the same window read as a rate would report the app idle.
    const rows = [procSample(0, { 101: 4.0 }), procSample(60_000, { 101: 4.25 }), procSample(120_000, { 101: 6.5 })];
    const cpu = calculateCpuDeltas(rows, 0, 120_000);
    assert.strictEqual(cpu.cpuSecondsTotal, 2.5);
    assert.strictEqual(cpu.windowMinutes, 2);
    assert.strictEqual(cpu.cpuSecondsPerMinute, 1.25);
    assert.deepStrictEqual(cpu.perProcess, [{ pid: 101, seconds: 2.5, share: 1 }]);
  });

  it('counts what it could not difference, because the total is a lower bound', () => {
    const rows = [
      procSample(0, { 1: 10, 2: 5, 3: 8, 4: 'unreadable' }),
      procSample(60_000, { 1: 12, 2: 4, 4: 2, 5: 3.5 }),
    ];
    const cpu = calculateCpuDeltas(rows, 0, 60_000);
    // pid 1 is the only differenceable row: 2 went backwards, 3 existed at one end only,
    // 4 was unreadable, 5 was born inside the window.
    assert.strictEqual(cpu.cpuSecondsTotal, 2);
    assert.deepStrictEqual(cpu.counterResetPids, [2]);
    assert.deepStrictEqual(cpu.notAttributablePids, [3, 5]);
    assert.deepStrictEqual(cpu.unreadablePids, [4]);
  });

  it('reports a window it could not measure as null, never as zero', () => {
    assert.strictEqual(calculateCpuDeltas([procSample(0, { 1: 1 })], 0, 60_000), null);
    assert.strictEqual(calculateCpuDeltas([procSample(0, { 1: 1 })], NaN, NaN), null);
  });

  it('prices CPU against the volume of its own window, and refuses a zero denominator', () => {
    assert.strictEqual(costPerUnit(0.5, 0.2), 2500);
    assert.strictEqual(costPerUnit(0.5, 0), null);
    assert.strictEqual(costPerUnit(null, 10), null);
  });

  it('reads cumulative counters, and reports an unreadable one as unknown', () => {
    assert.strictEqual(readProcessCpuSeconds({ UserModeTime: 468750, KernelModeTime: 782390 }), 0.125114);
    assert.strictEqual(readProcessCpuSeconds({ UserModeTime: 'n/a' }), null);
    assert.strictEqual(readProcessCpuSeconds({}), null);
  });

  it('attributes the workload window to named processes and prices it per line and per switch', () => {
    // The counters ride on the harness's own tree-walk rows (`samples`); the app's telemetry rows
    // (`processSamples`) carry memory and roles only. A fixture that put counters on the telemetry
    // rows certified a source the harness never had — and the harness, reading that source, priced
    // every real window at 0 s. Counters here are where production puts them.
    const samples = [
      { at: 1_000_000, activeAt: 1_000_000, label: 'workload', totalWorkingSetMB: 100, byType: {}, cpuByPid: { 101: 1.0, 202: 30.0 } },
      { at: 1_600_000, activeAt: 1_600_000, label: 'workload', totalWorkingSetMB: 100, byType: {}, cpuByPid: { 101: 1.5, 202: 30.0, 303: 0.2 } },
    ];
    const roles = (pid, type, role) => ({ pid, type, role, url: '', workingSetMB: 1, privateBytesMB: 1 });
    const processSamples = [
      { at: 1_000_000, processes: [roles(101, 'Tab', 'tab:fixture'), roles(202, 'GPU', 'gpu')] },
      { at: 1_600_000, processes: [roles(101, 'Tab', 'tab:fixture'), roles(202, 'GPU', 'gpu')] },
    ];
    const switchSamples = Array.from({ length: 10 }, (_, i) => sample(i, 9, 'workload', 'baseline#1'));
    const payload = buildReportPayload({
      ...baseMeta,
      samples,
      processSamples,
      switchSamples,
      switches: 10,
      burstsByPhase: { warmup: 2, workload: 5, recovery: 0 },
    });
    const cpu = payload.metrics.cpu;
    assert.strictEqual(cpu.cpuSecondsTotal, 0.5);
    // The window's volume is its own phase's bursts, not the global counter's.
    assert.strictEqual(cpu.bursts, 5);
    assert.strictEqual(cpu.burstLines, 5 * payload.config.burstLines);
    assert.strictEqual(cpu.msPer1000BurstLines, Number(((0.5 * 1000) / ((5 * payload.config.burstLines) / 1000)).toFixed(4)));
    assert.strictEqual(cpu.msPerSwitch, 50);
    // The role comes from the app's own stream; a pid it never named keeps an empty one
    // rather than a guessed label.
    assert.strictEqual(cpu.perProcess[0].role, 'tab:fixture');
    assert.strictEqual(cpu.perProcess[0].type, 'Tab');
    assert.deepStrictEqual(cpu.notAttributablePids, [303]);
    assert.strictEqual(payload.metrics.cpuByPhase.workload.cpuSecondsTotal, 0.5);
    assert.strictEqual(payload.stats.burstsByPhase.workload, 5);
  });

  it('does not price a run whose CPU it never measured', () => {
    const payload = buildReportPayload({ ...baseMeta });
    assert.strictEqual(payload.metrics.cpu, null);
    assert.strictEqual(payload.metrics.cpuByPhase.workload, null);
    assert.strictEqual(payload.metrics.cpuByPhase.recovery, null);
  });
});

describe('soak payload — history flush cost', () => {
  const workloadSample = (at, activeAt) => ({ at, activeAt, label: 'workload', totalWorkingSetMB: 100, byType: {} });
  const flush = (at, ms, extra = {}) => ({ at, name: 'persist', value: ms, extra: { items: 20000, bytes: 3700000, ...extra } });
  const leg = (name, ordinal, from, to) => ({
    name,
    ordinal,
    burstLines: 200,
    burstIntervalMs: 1000,
    startAt: from,
    endAt: to,
    observedFrom: from,
    observedTo: to,
    bursts: 2,
  });

  it('reports a run that never measured a flush as not measured, not as zero', () => {
    const payload = buildReportPayload({ ...baseMeta });
    assert.ok('historyPersist' in payload.metrics, 'the field must exist so its absence is readable');
    assert.strictEqual(payload.metrics.historyPersist, null);
  });

  it('splits the flush cost into the workload window and the whole run', () => {
    // 60 min of workload; one flush inside it and one in warmup. The rate divides by the
    // workload span only, so mixing them in would overstate cost per minute of work.
    const samples = [workloadSample(2_000_000, 2_000_000), workloadSample(5_600_000, 5_600_000)];
    const historySamples = [flush(1_000_000, 12, { superseded: true }), flush(3_000_000, 21.5), flush(4_000_000, 18.25)];
    const payload = buildReportPayload({ ...baseMeta, samples, historySamples });
    const history = payload.metrics.historyPersist;
    assert.deepStrictEqual(history.run, { flushes: 3, totalMs: 51.75, maxMs: 21.5, supersededFlushes: 1 });
    assert.strictEqual(history.workload.flushes, 2);
    assert.strictEqual(history.workload.totalMs, 39.75);
    // The phase span is 60 min, so the workload rows cost 0.663 ms/min.
    assert.strictEqual(history.workload.msPerMinute, Number((39.75 / 60).toFixed(3)));
    assert.deepStrictEqual(history.last, { at: 4_000_000, items: 20000, bytes: 3700000 });
  });

  it('prices each leg against its own window, and a leg that never churned as zero flushes', () => {
    const samples = [workloadSample(1_000_000, 1_000_000), workloadSample(7_000_000, 7_000_000)];
    const legs = [leg('baseline', 1, 1_000_000, 4_000_000), leg('burst4x', 2, 4_000_001, 7_000_000)];
    const historySamples = [
      flush(2_000_000, 20, { items: 19900 }),
      flush(2_600_000, 22),
      flush(5_000_000, 9, { items: 19902 }),
    ];
    const payload = buildReportPayload({ ...baseMeta, samples, legs, historySamples });
    const byLeg = payload.metrics.historyPersist.byLeg;
    assert.strictEqual(byLeg.length, 2);
    // A bisect that returns to a regime it already ran keeps its own ordinal, so two legs of
    // the same name are two rows and neither swallows the other's flushes. `lastItems` is the
    // newest flush inside the leg's own window (2_600_000), not the oldest.
    assert.deepStrictEqual(
      byLeg.map((l) => [l.name, l.ordinal, l.flushes, l.totalMs, l.lastItems]),
      [
        ['baseline', 1, 2, 42, 20000],
        ['burst4x', 2, 1, 9, 19902],
      ],
    );
    // A leg with no churn of its own must read as zero flushes rather than inherit the run's.
    const quiet = buildReportPayload({ ...baseMeta, samples, legs, historySamples: [flush(2_000_000, 20)] });
    assert.deepStrictEqual(
      quiet.metrics.historyPersist.byLeg.map((l) => [l.name, l.flushes, l.lastItems]),
      [
        ['baseline', 1, 20000],
        ['burst4x', 0, null],
      ],
    );
  });
});

describe('soak payload — leg slopes and open legs', () => {
  const procSample = (at, pid, privateBytesMB = 50) => ({
    at,
    processes: [{ pid, type: 'Browser', role: '', workingSetMB: 100, privateBytesMB }],
  });
  const openLeg = (name, ordinal, startAt, endAt, observedFrom = startAt) => ({
    name,
    ordinal,
    burstLines: 300,
    burstIntervalMs: 30000,
    startAt,
    endAt,
    observedFrom,
    observedTo: null,
    bursts: 5,
  });

  it('marks an in-flight leg as open and computes observedMinutes from actual fit frames, never scheduled end', () => {
    // An in-flight leg at a mid-run checkpoint must report the duration actually observed so
    // far (10 minutes here), not the scheduled span (60 minutes).
    const leg = openLeg('baseline', 1, 0, 3_600_000, 0);
    const processSamples = [procSample(0, 100, 50), procSample(300_000, 100, 51), procSample(600_000, 100, 52)];
    const payload = buildReportPayload({ ...baseMeta, processSamples, legs: [leg] });

    assert.strictEqual(payload.legSlopes.length, 1);
    const slopeRow = payload.legSlopes[0];
    assert.strictEqual(slopeRow.open, true);
    assert.strictEqual(slopeRow.observedTo, null);
    assert.strictEqual(slopeRow.observedMinutes, 10);
  });

  it('marks a completed leg as closed with observedMinutes matching its observed window', () => {
    const leg = {
      ...openLeg('baseline', 1, 0, 3_600_000, 0),
      observedTo: 3_600_000,
    };
    const processSamples = [procSample(0, 100, 50), procSample(1_800_000, 100, 51), procSample(3_600_000, 100, 52)];
    const payload = buildReportPayload({ ...baseMeta, processSamples, legs: [leg] });

    const slopeRow = payload.legSlopes[0];
    assert.strictEqual(slopeRow.open, false);
    assert.strictEqual(slopeRow.observedTo, 3_600_000);
    assert.strictEqual(slopeRow.observedMinutes, 60);
  });

  it('reports zero observedMinutes for an open leg that has not yet observed any samples in its window', () => {
    const leg = openLeg('burst4x', 2, 3_600_000, 7_200_000, 3_600_000);
    const payload = buildReportPayload({ ...baseMeta, processSamples: [], legs: [leg] });

    const slopeRow = payload.legSlopes[0];
    assert.strictEqual(slopeRow.open, true);
    assert.strictEqual(slopeRow.observedMinutes, 0);
  });
});

describe('soak payload — non-WebContents process role attribution', () => {
  it('carries process type when no WebContents role is known, so role is never empty', () => {
    const samples = [
      { at: 1_000_000, activeAt: 1_000_000, label: 'workload', totalWorkingSetMB: 100, byType: {}, cpuByPid: { 100: 1.0, 200: 2.0 } },
      { at: 1_600_000, activeAt: 1_600_000, label: 'workload', totalWorkingSetMB: 105, byType: {}, cpuByPid: { 100: 2.5, 200: 2.0 } },
    ];
    const processSamples = [
      { at: 1_000_000, processes: [
        { pid: 100, type: 'Browser', role: '', workingSetMB: 100, privateBytesMB: 50 },
        { pid: 200, type: 'GPU', role: '', workingSetMB: 80, privateBytesMB: 40 },
        { pid: 300, type: 'Tab', role: 'tab:storefront', workingSetMB: 60, privateBytesMB: 30 },
      ]},
      { at: 1_300_000, processes: [
        { pid: 100, type: 'Browser', role: '', workingSetMB: 102, privateBytesMB: 55 },
        { pid: 200, type: 'GPU', role: '', workingSetMB: 80, privateBytesMB: 40 },
        { pid: 300, type: 'Tab', role: 'tab:storefront', workingSetMB: 61, privateBytesMB: 30 },
      ]},
      { at: 1_600_000, processes: [
        { pid: 100, type: 'Browser', role: '', workingSetMB: 105, privateBytesMB: 60 },
        { pid: 200, type: 'GPU', role: '', workingSetMB: 80, privateBytesMB: 40 },
        { pid: 300, type: 'Tab', role: 'tab:storefront', workingSetMB: 62, privateBytesMB: 30 },
      ]},
    ];
    const payload = buildReportPayload({ ...baseMeta, samples, processSamples });

    const browserSlope = payload.metrics.perProcessSlopes.find((p) => p.pid === 100);
    const gpuSlope = payload.metrics.perProcessSlopes.find((p) => p.pid === 200);
    const tabSlope = payload.metrics.perProcessSlopes.find((p) => p.pid === 300);

    assert.ok(browserSlope);
    assert.strictEqual(browserSlope.role, 'Browser');
    assert.ok(gpuSlope);
    assert.strictEqual(gpuSlope.role, 'GPU');
    assert.ok(tabSlope);
    assert.strictEqual(tabSlope.role, 'tab:storefront');

    assert.strictEqual(payload.metrics.appPrivateMaxRole, 'Browser');
    assert.strictEqual(payload.metrics.appPrivateMaxPid, 100);

    const cpuBrowser = payload.metrics.cpu.perProcess.find((p) => p.pid === 100);
    assert.ok(cpuBrowser);
    assert.strictEqual(cpuBrowser.role, 'Browser');
    assert.strictEqual(cpuBrowser.type, 'Browser');

    assert.strictEqual(payload.metrics.processSlopeWindowStart, 1_000_000);
    assert.strictEqual(payload.metrics.processSlopeWindowEnd, 1_600_000);
  });

  it('exposes historySamples directly on the payload root', () => {
    const historySamples = [{ at: 1000, name: 'persist', value: 15, extra: { items: 10 } }];
    const payload = buildReportPayload({ ...baseMeta, historySamples });
    assert.ok(Array.isArray(payload.historySamples));
    assert.strictEqual(payload.historySamples.length, 1);
    assert.strictEqual(payload.historySamples[0].value, 15);
  });
});
