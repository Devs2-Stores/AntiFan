/**
 * Soak analyzer — the CPU reading, graded through the real script.
 *
 * The analyzer is the read side of the soak: the harness reports gates, and this prints what
 * those gates are actually computed from, recomputed independently. Two failures are worth a
 * test, because both print a number that reads like a measurement:
 *
 *  - a run that predates the counter instrument must read "NOT MEASURED", never 0 s of CPU
 *    (a legacy artifact has no `cpuByPid`, and a 0 there is a fabricated measurement);
 *  - the per-line cost is a quotient, so a window with almost no output must print n/a rather
 *    than a large number produced by a near-zero denominator.
 *
 * The fixtures are built by the harness's own `buildReportPayload`, so the test cannot drift
 * from the payload contract it is reading, and the analyzer is spawned as a process because
 * that is how it is used — its output is the deliverable.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// The harness reads its leg schedule at module load, and the payload's per-line cost and fault
// flag are both leg-mode branches: the fixture must therefore be built in the same mode the
// bisect run uses, or the test would grade the single-regime path and never the one that broke.
process.env.SOAK_LEGS = 'baseline:1:40:30000,burst4x:1:40:30000';
const { buildReportPayload } = require('../../scripts/benchmark-real-soak-8h.cjs');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ANALYZER = path.join(ROOT, 'scripts', 'analyze-soak-app-only.cjs');

const T0 = Date.parse('2026-09-20T00:00:00.000Z');
const at = (minutes) => T0 + minutes * 60_000;

const baseMeta = {
  startedAt: new Date(T0).toISOString(),
  finishedAt: new Date(at(60)).toISOString(),
  rootPid: 1234,
  fixturePort: 4000,
  requestCount: 0,
  tabIds: ['a'],
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

/**
 * The payload keeps two per-process views apart, and the analyzer joins them: `samples` carries
 * the harness's own per-minute rows (the tree walk's totals plus the cumulative CPU counters),
 * while `processSeries` carries the app's telemetry rows (a role per pid, committed bytes). The
 * fixture reproduces that split, not a merged shape the real payload never has.
 */
function memFrame() {
  return {
    processes: [
      { pid: 101, type: 'Tab', role: 'chrome:standalone+chrome:toolbar', url: 'file:///a.html', workingSetMB: 100, privateBytesMB: 80 },
      { pid: 202, type: 'GPU', role: '', url: '', workingSetMB: 60, privateBytesMB: 50 },
    ],
  };
}

const phaseSample = (minutes, label) => ({
  at: at(minutes),
  activeAt: at(minutes),
  label,
  totalWorkingSetMB: 160,
  byType: { renderer: { count: 1, workingSetMB: 100 } },
  cpuByPid: { 101: 10 + minutes * 0.5, 202: 5 + minutes * 0.1 },
});

function runAnalyzer(report) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-analyzer-'));
  const file = path.join(dir, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  const out = execFileSync(process.execPath, [ANALYZER, file], { encoding: 'utf8', cwd: ROOT });
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

describe('soak analyzer — CPU reading', () => {
  /** 3 warmup frames, 5 workload frames (4 minutes), 3 recovery frames; +0.5 s/frame on the tab. */
  function instrumentedReport(legBursts = [8, 32]) {
    const minutesOf = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const labels = ['warmup', 'warmup', 'warmup', 'workload', 'workload', 'workload', 'workload', 'workload', 'recovery', 'recovery', 'recovery'];
    const processSamples = minutesOf.map((m) => ({ at: at(m), ...memFrame() }));
    const legs = [
      { name: 'baseline', ordinal: 1, burstLines: 40, burstIntervalMs: 30_000, startAt: at(3), endAt: at(5), observedFrom: at(3), observedTo: at(5), bursts: legBursts[0] },
      { name: 'burst4x', ordinal: 2, burstLines: 40, burstIntervalMs: 30_000, startAt: at(5), endAt: at(8), observedFrom: at(5), observedTo: at(8), bursts: legBursts[1] },
    ];
    return buildReportPayload({
      ...baseMeta,
      samples: minutesOf.map((m, i) => phaseSample(m, labels[i])),
      processSamples,
      legs,
      switchSamples: [
        { at: at(3.5), ms: 9, tabId: 'a', phase: 'workload', leg: 'baseline#1' },
        { at: at(3.7), ms: 9, tabId: 'a', phase: 'workload', leg: 'baseline#1' },
      ],
      switches: 2,
      bursts: 40,
      burstsByPhase: { warmup: 3, workload: 30, recovery: 0 },
    });
  }

  it('reads CPU per phase, prices it per line and per switch, and agrees with the harness', () => {
    const out = runAnalyzer(instrumentedReport());
    // The workload window is frames 3..7 (4 minutes): the tab adds 0.5 s/frame and the GPU
    // 0.1, so the window costs 4 frames x 0.6 s = 2.4 s.
    assert.match(out, /workload\s+4\.0\s+2\.400\s+0\.600/, 'workload CPU total and rate');
    assert.match(out, /agrees with the recompute above/, 'the two independent computations must agree');
    // 2.4 s over the legs' observed volume (8x40 + 32x40 = 1600 lines) -> 1500 ms per 1000 lines.
    assert.match(out, /1500\.000 ms per 1000 burst lines \(30 observed bursts, 1600 lines, the legs' observed volume, not the base knob\)/, 'cost per line');
  });

  it('names the process that spent the CPU, from the app stream, not from the tree walk', () => {
    const out = runAnalyzer(instrumentedReport());
    assert.match(out, /chrome:standalone\+chrome:toolbar pid=101/, 'top consumer identity');
  });

  it('prices each leg and prints n/a where the denominator makes the quotient meaningless', () => {
    const out = runAnalyzer(instrumentedReport());
    // leg 2: 32 bursts x 40 lines = 1280 lines over frames 5..8 (3 minutes, 1.8 s) = 1406.25 ms.
    assert.match(out, /burst4x[\s\S]*?1406\.250 ms \/ 1000 lines/, 'leg with enough lines is priced');
    // leg 1: 8 bursts x 40 lines = 320 lines, below the 1000-line floor.
    assert.match(out, /baseline[\s\S]*?per-line n\/a/, 'leg below the line floor is not priced');
  });

  it('reports a run that predates the instrument as not measured, never as zero', () => {
    const noCounters = (minutes, label) => ({ at: at(minutes), activeAt: at(minutes), label, totalWorkingSetMB: 160, byType: {} });
    const legacy = buildReportPayload({
      ...baseMeta,
      samples: [noCounters(0, 'warmup'), noCounters(1, 'warmup')],
      processSamples: [{ at: at(0), processes: [] }, { at: at(1), processes: [] }],
    });
    const out = runAnalyzer(legacy);
    assert.match(out, /CPU is NOT MEASURED/);
    assert.doesNotMatch(out, /workload\s+[\d.]+\s+0\.000/, 'a legacy run must not print 0 s as a measurement');
  });

  it('refuses to price a mid-flight leg run against a partial leg volume', () => {
    // A checkpoint carries legSlopes only for the legs it has exited, so a 3-leg workload read
    // after leg 1 holds one leg's volume. Dividing the whole phase's CPU by that would report a
    // cost several times the truth and call it a measurement.
    const full = instrumentedReport();
    const partial = { ...full, legSlopes: full.legSlopes.slice(0, 1) };
    const out = runAnalyzer(partial);
    assert.match(out, /1 of 2 leg\(s\) observed in this artifact/, 'the partial read must say which legs it holds');
    assert.doesNotMatch(out, /workload: [\d.]+ ms per 1000 burst lines/, 'a partial leg volume is not a denominator');
    // The leg rows themselves stay readable: the first leg is priced on its own window.
    assert.match(out, /leg baseline \| 40 lines \/ 30000ms/);
  });

  it('distinguishes a run with no leg schedule from one whose leg tags are one group', () => {
    // Both cases print one group, and the earlier wording called the second "no leg schedule in
    // this run" — a claim the config contradicts on a warmup read of a leg run.
    const late = runAnalyzer(instrumentedReport());
    assert.match(late, /every tagged switch ran in baseline#1/, 'a tagged single group is named');
    assert.doesNotMatch(late, /no leg schedule in this run/, 'the config carries a schedule, so that claim must not print');
  });

  it('prices the run from the rows that carry counters, not from the memory-only stream', () => {
    // The regression: the payload's CPU block was built from `processSeries` (the app's telemetry
    // stream), which carries memory and roles but no counters — so every window differenced two
    // empty maps and the run was priced at 0 s total, i.e. `0 ms per 1000 lines` once the leg
    // burst counter made the denominator known. A cost of nothing, asserted by an instrument.
    const report = instrumentedReport();
    assert.ok(report.metrics.cpu.cpuSecondsTotal > 0, 'a measured window must not report 0 s');
    assert.ok(report.metrics.cpu.msPer1000BurstLines > 0, 'a known volume with a measured numerator is a cost');
    assert.match(report.metrics.cpu.source, /samples\.cpuByPid/, 'the payload must name the series it read');
    const leg = report.legSlopes.find((l) => l.name === 'burst4x');
    assert.ok(leg.cpu.msPer1000BurstLines > 0, 'each leg is priced from the same counters');
    // And the reciprocal: rows that carry no counters read as not measured, never as 0.
    const noCounters = (minutes, label) => ({ at: at(minutes), activeAt: at(minutes), label, totalWorkingSetMB: 160, byType: {} });
    const blank = buildReportPayload({
      ...baseMeta,
      samples: [noCounters(0, 'warmup'), noCounters(1, 'warmup'), noCounters(2, 'workload'), noCounters(3, 'workload')],
      processSamples: [{ at: at(0), processes: [] }, { at: at(1), processes: [] }],
      burstsByPhase: { warmup: 1, workload: 1, recovery: 0 },
    });
    assert.equal(blank.metrics.cpu, null, 'no counters must read as null, not as a 0 total');
  });

  it('names a dead leg burst counter instead of printing the per-line costs as n/a', () => {
    // The regression this pins: `activeLeg.bursts++` used to increment a spread copy of the
    // schedule, so every leg recorded 0 bursts while the workload phase wrote 30 — which made
    // every per-line quotient null, indistinguishable from "the write path costs nothing".
    const report = instrumentedReport([0, 0]);
    assert.equal(report.metrics.legBurstCounterSuspect, true, 'the payload must derive the fault itself');
    assert.equal(report.metrics.cpu.msPer1000BurstLines, null, 'no lines observed to divide by');
    const out = runAnalyzer(report);
    assert.match(out, /LEG BURST COUNTER FAULT: ~\d+ bursts scheduled, 0 recorded/);
    // A healthy run must not carry the flag, or the warning becomes noise.
    assert.ok(!instrumentedReport().metrics.legBurstCounterSuspect);
  });

  it('identifies the root pid as browser (main) instead of unattributed when top consumer has no role', () => {
    // When the top-CPU process has no recorded role, if its pid equals report.rootPid,
    // the analyzer identifies it as the browser main process rather than calling it unattributed.
    const minutesOf = [0, 1, 2, 3];
    const labels = ['workload', 'workload', 'workload', 'workload'];
    const report = buildReportPayload({
      ...baseMeta,
      rootPid: 9999,
      samples: minutesOf.map((m, i) => ({
        at: at(m),
        activeAt: at(m),
        label: labels[i],
        totalWorkingSetMB: 160,
        byType: {},
        cpuByPid: { 9999: 10 + m * 5.0, 101: 10 + m * 0.5 },
      })),
      processSamples: minutesOf.map((m) => ({
        at: at(m),
        processes: [
          { pid: 9999, type: 'Browser', role: '', url: '', workingSetMB: 100, privateBytesMB: 80 },
          { pid: 101, type: 'Tab', role: 'chrome:toolbar', url: '', workingSetMB: 50, privateBytesMB: 40 },
        ],
      })),
    });
    const out = runAnalyzer(report);
    assert.match(out, /browser \(main\) pid=9999/, 'root process must be identified as browser (main)');
    assert.doesNotMatch(out, /unattributed pid=9999/, 'root process must not be called unattributed');
  });

  it('prints each leg\'s per-pid CPU split across all contributing processes', () => {
    // Each leg window reports the per-pid CPU split across all contributing processes, not only the single top line.
    const out = runAnalyzer(instrumentedReport());
    assert.match(out, /per-pid CPU:.*chrome:standalone\+chrome:toolbar pid=101 1\.000s/, 'leg baseline per-pid CPU includes pid 101');
    assert.match(out, /per-pid CPU:.*unattributed pid=202 0\.200s/, 'leg baseline per-pid CPU includes pid 202');
    assert.match(out, /per-pid CPU:.*chrome:standalone\+chrome:toolbar pid=101 1\.500s/, 'leg burst4x per-pid CPU includes pid 101');
    assert.match(out, /per-pid CPU:.*unattributed pid=202 0\.300s/, 'leg burst4x per-pid CPU includes pid 202');
  });

  it('reports history persistence as not collected when the payload carries no history samples', () => {
    // A run without history persist samples reports not collected rather than fabricating a 0 ms flush measurement.
    const out = runAnalyzer(instrumentedReport());
    assert.match(out, /### history persist flushes/, 'history section exists');
    assert.match(out, /history: not collected in this report/, 'honestly reports not collected');
    assert.doesNotMatch(out, /count 0 flushes.*total 0\.000 ms/, 'must not fabricate a 0 ms flush measurement');
  });

  it('reads historySamples, reports count, p50/p95/max, total, and prices against leg volume and switches', () => {
    // Evaluates flush latency distribution and prices per 1000 burst lines and per tab switch against observed leg volume.
    const base = instrumentedReport();
    const historySamples = [
      { at: at(3.5), surface: 'history', name: 'persist', value: 10.0 },
      { at: at(4.0), surface: 'history', name: 'persist', value: 20.0 },
      { at: at(6.0), surface: 'history', name: 'persist', value: 30.0 },
    ];
    const report = { ...base, historySamples };
    const out = runAnalyzer(report);
    assert.match(out, /count 3 flushes/, 'flush count');
    assert.match(out, /p50 20\.000 ms/, 'median flush latency');
    assert.match(out, /max 30\.000 ms/, 'maximum flush latency');
    assert.match(out, /total 60\.000 ms/, 'total flush latency');
    assert.match(out, /37\.500 ms per 1000 lines/, 'priced per 1000 lines');
    assert.match(out, /30\.000 ms \/ switch/, 'priced per switch');
  });

  it('anchors derived legs to the first observed workload sample and prints the anchor used', () => {
    // The provisional leg schedule anchors to the first observed workload sample in the payload when present,
    // falling back to scheduled only when no workload sample exists.
    const base = instrumentedReport();
    const provisional = {
      ...base,
      legSlopes: [],
      config: {
        ...base.config,
        warmupMinutes: 1,
        legs: [
          { name: 'baseline', minutes: 2, burstLines: 40, burstIntervalMs: 30000 },
          { name: 'burst4x', minutes: 3, burstLines: 40, burstIntervalMs: 30000 },
        ],
      },
    };
    const out = runAnalyzer(provisional);
    assert.match(out, /derived leg windows anchored to observed first workload sample \(00:03:00\)/);
    assert.match(out, /window 00:03:00 -> 00:05:00/);

    const warmupOnly = {
      ...provisional,
      samples: base.samples.filter((s) => s.label === 'warmup'),
    };
    const outFallback = runAnalyzer(warmupOnly);
    assert.match(outFallback, /derived leg windows anchored to scheduled \(startedAt \+ warmupMinutes = 00:01:00\)/);
    assert.match(outFallback, /window 00:01:00 -> 00:03:00/);
  });

  it('reports per-process max beside sum for private floor and flags when sum masks breach', () => {
    // The deciding reading for the app-owned floor is the per-process maximum in private bytes beside the sum,
    // flagging when flat renderers mask a breach.
    const minutesOf = Array.from({ length: 15 }, (_, i) => i);
    const report = buildReportPayload({
      ...baseMeta,
      samples: minutesOf.map((m) => phaseSample(m, 'workload')),
      processSamples: minutesOf.map((m) => ({
        at: at(m),
        processes: [
          { pid: 101, type: 'Tab', role: 'chrome:toolbar', url: '', workingSetMB: 100, privateBytesMB: 50 + m * 0.20 },
          { pid: 102, type: 'Tab', role: 'tab:idle', url: '', workingSetMB: 80, privateBytesMB: 50 - m * 0.10 },
        ],
      })),
    });
    const out = runAnalyzer(report);
    assert.match(out, /deciding reading: per-process max = 0\.20 MB\/min.*\[bound 0\.15 MB\/min: BREACH\] \| sum = 0\.10 MB\/min \[bound 0\.15 MB\/min: OK\]/);
    assert.match(out, /SUM MASKS BREACH/);
  });
});
