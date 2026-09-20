#!/usr/bin/env node
/**
 * Recompute a saved soak payload's derived metrics from the counters that payload already
 * stores, using the current `buildReportPayload`.
 *
 * Why this exists: a payload is a *reading*, and a reader can be wrong in a way that is
 * indistinguishable from a measurement. On the 2026-09-20 4 h legs run the CPU block was
 * computed from a series that carried no counters, so every window printed
 * `cpuSecondsTotal: 0, perProcess: []` — a cost of nothing, asserted by a run that had in
 * fact spent 131.5 s in the app tree over 19 minutes. The run's own per-minute rows do carry
 * `cpuByPid`, so the numbers are recoverable; this script recovers them without pretending
 * the original payload said something it did not.
 *
 * The output is a sidecar, never an overwrite: the saved payload stays byte-identical as the
 * record of what the run reported, and the sidecar carries the corrected blocks beside the
 * stale ones. A round-trip check runs first — the recomputed *memory* metrics must equal the
 * original's, since those never depended on the reader being wrong — so a sidecar built from
 * mis-mapped inputs fails loudly instead of publishing plausible numbers.
 *
 * Usage:
 *   node scripts/recompute-soak-metrics.cjs <payload.json> [--stdout <harness-log>] [--out <file>]
 *
 * `--stdout` recovers the app's `history` metric rows for runs whose payload was written
 * before those rows were ingested; without it the history block is reported as absent rather
 * than as zero flushes.
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { payload: null, stdout: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--stdout') args.stdout = argv[++i];
    else if (token === '--out') args.out = argv[++i];
    else if (!token.startsWith('--') && args.payload === null) args.payload = token;
    else throw new Error(`Unrecognised argument: ${token}`);
  }
  if (!args.payload) throw new Error('Usage: recompute-soak-metrics.cjs <payload.json> [--stdout <harness-log>] [--out <file>]');
  return args;
}

// The legs a run scheduled are a payload field, but `buildReportPayload` reads them from the
// module's env-parsed `LEGS`. Replaying the run's own leg schedule through that same parser is
// what keeps the per-leg denominators identical; a hand-built array would be a second source
// of truth for the very thing the bisect is read from.
function legsEnvFromConfig(config) {
  const legs = Array.isArray(config?.legs) ? config.legs : [];
  return legs
    .map((leg) => [leg.name, leg.minutes, leg.burstLines, leg.burstIntervalMs].join(':'))
    .join(',');
}

// The payload stores each leg's observed window, which is what the recompute needs; the
// scheduled window is kept too so a row can be recognised as leg 1 of 3 rather than a name.
function legsFromPayload(payload) {
  const rows = Array.isArray(payload?.legSlopes) ? payload.legSlopes : [];
  return rows.map((leg) => ({
    name: leg.name,
    ordinal: leg.ordinal ?? null,
    burstLines: leg.burstLines,
    burstIntervalMs: leg.burstIntervalMs,
    startAt: leg.startAt,
    endAt: leg.endAt,
    observedFrom: leg.observedFrom ?? leg.startAt,
    observedTo: leg.observedTo ?? leg.endAt,
    bursts: leg.bursts ?? null,
  }));
}

function ingestHistoryFromLog(text, cap = 20000) {
  const prefix = '[antifan-benchmark] ';
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith(prefix) || rows.length >= cap) continue;
    let metric;
    try {
      metric = JSON.parse(line.slice(prefix.length));
    } catch {
      continue;
    }
    if (metric?.surface !== 'history') continue;
    const at = Date.parse(metric.ts);
    if (!Number.isFinite(at)) continue;
    rows.push({
      at,
      name: String(metric.name || ''),
      value: Number(metric.value),
      extra: metric.extra && typeof metric.extra === 'object' ? metric.extra : {},
    });
  }
  return rows;
}

function metaFromPayload(payload, stdoutText) {
  const stats = payload?.stats || {};
  const config = payload?.config || {};
  return {
    startedAt: payload?.startedAt ?? null,
    finishedAt: payload?.finishedAt ?? null,
    rootPid: payload?.rootPid ?? null,
    fixturePort: payload?.fixturePort ?? null,
    requestCount: stats.requestCount ?? 0,
    tabIds: [],
    switches: stats.switches ?? 0,
    bursts: stats.bursts ?? 0,
    burstsByPhase: stats.burstsByPhase ?? null,
    reloads: stats.reloads ?? 0,
    terminalEventCount: stats.terminalEventsCount ?? 0,
    samples: Array.isArray(payload?.samples) ? payload.samples : [],
    switchLatencies: (Array.isArray(payload?.switchSamples) ? payload.switchSamples : []).map((s) => s.ms),
    switchSamples: Array.isArray(payload?.switchSamples) ? payload.switchSamples : [],
    switchLatencyByTab: new Map(Object.entries(payload?.metrics?.switchLatencyByTab || {})),
    tabUrlById: new Map(),
    processSamples: Array.isArray(payload?.processSeries) ? payload.processSeries : [],
    historySamples: ingestHistoryFromLog(stdoutText),
    orphanPids: [],
    stdout: String(stdoutText || ''),
    stderr: '',
    status: payload?.status ?? 'recomputed',
    teardownTelemetry: stats.teardownTelemetry || { teardownDegraded: false },
    legs: legsFromPayload(payload),
    processQuerySuccess: true,
    executionError: null,
    childExitedPrematurely: false,
  };
}

// The memory metrics are the control: they were produced by the stable path, so a recompute
// that disagrees with them was built from different inputs and its CPU numbers mean nothing.
function compareMemory(original, recomputed) {
  const keys = [
    'activeWorkingSetMB',
    'activeRendererWorkingSetMB',
    'overallActiveSlopeMBPerMin',
    'rendererActiveSlopeMBPerMin',
    'finalActiveMB',
    'postWarmupMB',
    'switchLatencyMaxMs',
  ];
  const diffs = {};
  for (const key of keys) {
    const a = original?.metrics?.[key];
    const b = recomputed?.metrics?.[key];
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs[key] = { original: a, recomputed: b };
  }
  return diffs;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payloadPath = path.resolve(args.payload);
  const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
  const stdoutText = args.stdout ? fs.readFileSync(path.resolve(args.stdout), 'utf8') : '';

  // Set before requiring: the module parses its schedule at import time.
  const legsEnv = legsEnvFromConfig(payload.config);
  if (legsEnv) process.env.SOAK_LEGS = legsEnv;
  process.env.SOAK_REPORT_TAG = process.env.SOAK_REPORT_TAG || payload?.config?.reportTag || 'recompute';
  const { buildReportPayload } = require('./benchmark-real-soak-8h.cjs');

  const meta = metaFromPayload(payload, stdoutText);
  const recomputed = buildReportPayload(meta);
  const memoryDiffs = compareMemory(payload, recomputed);
  const memoryAgrees = Object.keys(memoryDiffs).length === 0;

  const sidecar = {
    source: path.basename(payloadPath),
    sourceStartedAt: payload?.startedAt ?? null,
    sourceFinishedAt: payload?.finishedAt ?? null,
    recomputedAt: new Date().toISOString(),
    harnessLegsEnv: legsEnv || null,
    historyRowsRecovered: meta.historySamples.length,
    stdoutProvided: Boolean(args.stdout),
    memoryAgrees,
    memoryDiffs,
    stale: {
      cpu: payload?.metrics?.cpu ?? null,
      cpuByPhase: payload?.metrics?.cpuByPhase ?? null,
      legCpu: (payload?.legSlopes || []).map((leg) => ({ name: leg.name, ordinal: leg.ordinal ?? null, cpu: leg.cpu ?? null })),
      historyPersist: payload?.metrics?.historyPersist ?? null,
    },
    recomputed: {
      cpu: recomputed.metrics.cpu,
      cpuByPhase: recomputed.metrics.cpuByPhase,
      // `legSlopes` is a top-level payload field, not a member of `metrics` — reading it from
      // `metrics` yields an empty list that reads as "no legs ran".
      legCpu: (recomputed.legSlopes || []).map((leg) => ({
        name: leg.name,
        ordinal: leg.ordinal ?? null,
        cpu: leg.cpu,
        bursts: leg.bursts,
        burstLinesObserved: leg.burstLinesObserved,
        switchCount: leg.switchCount,
      })),
      historyPersist: recomputed.metrics.historyPersist ?? null,
      legBurstCounterSuspect: recomputed.metrics.legBurstCounterSuspect ?? null,
      verdict: recomputed.metrics.verdict ?? null,
    },
  };

  const outPath = args.out ? path.resolve(args.out) : payloadPath.replace(/\.json$/, '-recomputed.json');
  fs.writeFileSync(outPath, `${JSON.stringify(sidecar, null, 2)}\n`, 'utf8');

  const fmt = (cpu) => (cpu ? `${cpu.cpuSecondsTotal} s over ${cpu.windowMinutes} min = ${cpu.cpuSecondsPerMinute} s/min (${(cpu.perProcess || []).length} pids)` : 'null');
  console.log(`[recompute] ${path.basename(payloadPath)}`);
  console.log(`[recompute] memory round-trip: ${memoryAgrees ? 'AGREES' : `DIFFERS (${JSON.stringify(memoryDiffs)})`}`);
  console.log(`[recompute] stale  cpu: ${fmt(sidecar.stale.cpu)}`);
  console.log(`[recompute] recomputed cpu: ${fmt(sidecar.recomputed.cpu)}`);
  for (const leg of sidecar.recomputed.legCpu) {
    console.log(`[recompute]   leg ${leg.ordinal ?? '?'} ${leg.name}: ${fmt(leg.cpu)} | bursts ${leg.bursts} | switches ${leg.switchCount}`);
  }
  console.log(`[recompute] history rows recovered: ${meta.historySamples.length}${args.stdout ? '' : ' (no --stdout given)'}`);
  console.log(`[recompute] wrote ${outPath}`);
  if (!memoryAgrees) {
    console.error('[recompute] REFUSED: the window inputs do not reproduce the run\'s own memory metrics, so the CPU numbers above are not the run\'s.');
    process.exitCode = 2;
  }
}

main();
