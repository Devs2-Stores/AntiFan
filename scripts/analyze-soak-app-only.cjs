#!/usr/bin/env node
/**
 * App-only soak analyzer.
 *
 * The soak report carries two memory views that disagree, because they are built two
 * different ways:
 *   1. `samples[].byType` / `totalWorkingSetMB` - a parent-pid tree walk by the harness,
 *      which also swallows processes that are not the app's (Windows reuses the pid of a
 *      dead parent, so an unrelated Electron app can end up inside the tree).
 *   2. `processSeries[].processes[]` - the app's own telemetry rows, one per process per
 *      minute, carrying type/role/url. App-owned only.
 * The gates read view 1. This reads view 2 and prints both, labelled, so a verdict is
 * never computed from a series whose contents are unknown.
 *
 * It also prints working set next to private (committed) bytes. Working set moves with
 * shared pages and OS trimming, so on a short window it can read as growth while private
 * bytes are flat; committed growth is what a retention defect looks like.
 *
 * Usage: node scripts/analyze-soak-app-only.cjs [report.json] [--last-min=60]
 * Default report: plans/reports/runtime-verification/real-soak-8h-soak4h-checkpoint.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_REPORT = path.join(
  ROOT,
  'plans',
  'reports',
  'runtime-verification',
  'real-soak-8h-soak4h-checkpoint.json',
);

const argv = process.argv.slice(2);
const reportArg = argv.find((a) => !a.startsWith('--'));
const lastMinArg = argv.find((a) => a.startsWith('--last-min='));
const LAST_MIN = lastMinArg ? Number(lastMinArg.split('=')[1]) : 0;

const report = JSON.parse(fs.readFileSync(reportArg ? path.resolve(reportArg) : DEFAULT_REPORT, 'utf8'));
const frames = Array.isArray(report.processSeries) ? report.processSeries : [];
const samples = Array.isArray(report.samples) ? report.samples : [];
const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const mb = (v) => (Number.isFinite(v) ? v.toFixed(2) : 'n/a');

/** Least-squares slope of ys against minutes, robust to a non-uniform x grid. */
function lsq(ys, minutes) {
  const n = ys.length;
  if (n < 3 || !Number.isFinite(minutes) || minutes <= 0) return NaN;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    const x = i * (minutes / (n - 1));
    sx += x;
    sy += ys[i];
    sxy += x * ys[i];
    sxx += x * x;
  }
  const den = n * sxx - sx * sx;
  return den === 0 ? NaN : (n * sxy - sx * sy) / den;
}

function stats(ys) {
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sd = Math.sqrt(ys.reduce((a, b) => a + (b - mean) ** 2, 0) / ys.length);
  return { mean, sd, range: Math.max(...ys) - Math.min(...ys) };
}

function inWindow(label) {
  const scoped = samples.filter((s) => s.label === label);
  if (scoped.length === 0) return null;
  let [from, to] = [scoped[0].at, scoped[scoped.length - 1].at];
  if (LAST_MIN > 0) {
    const cut = to - LAST_MIN * 60_000;
    if (cut > from) from = cut;
  }
  return { from, to, samples: scoped, frames: frames.filter((f) => f.at >= from && f.at <= to) };
}

function pidTable(win) {
  const ids = new Map();
  for (const f of win.frames) {
    for (const p of f.processes) {
      if (!ids.has(p.pid)) ids.set(p.pid, { pid: p.pid, type: p.type, role: p.role, url: p.url, ws: [], pv: [] });
      const row = ids.get(p.pid);
      row.ws.push(p.workingSetMB);
      row.pv.push(p.privateBytesMB);
    }
  }
  const minutes = (win.frames[win.frames.length - 1].at - win.frames[0].at) / 60_000;
  return { rows: [...ids.values()], minutes };
}

function printWindow(label) {
  const win = inWindow(label);
  if (!win || win.frames.length < 3) {
    console.log(`\n### ${label}: not enough frames (${win ? win.frames.length : 0})`);
    return null;
  }
  const { rows, minutes } = pidTable(win);
  console.log(`\n### ${label} window ${clock(win.from)} -> ${clock(win.to)}  (${minutes.toFixed(1)} min, ${win.frames.length} frames)`);
  console.log(
    '  ' +
      'pid'.padEnd(7) +
      'type'.padEnd(9) +
      'WS first->last'.padEnd(20) +
      'WS slope'.padEnd(11) +
      'PV first->last'.padEnd(20) +
      'PV slope'.padEnd(11) +
      'PV sd'.padEnd(8) +
      'role',
  );
  const ranked = [];
  for (const r of rows) {
    const ws = lsq(r.ws, minutes);
    const pv = lsq(r.pv, minutes);
    const st = stats(r.pv);
    ranked.push({ ...r, ws, pv, pvSd: st.sd, wsSd: stats(r.ws).sd });
    console.log(
      '  ' +
        String(r.pid).padEnd(7) +
        String(r.type).padEnd(9) +
        `${mb(r.ws[0])} -> ${mb(r.ws[r.ws.length - 1])}`.padEnd(20) +
        `${mb(ws)} MB/m`.padEnd(11) +
        `${mb(r.pv[0])} -> ${mb(r.pv[r.pv.length - 1])}`.padEnd(20) +
        `${mb(pv)} MB/m`.padEnd(11) +
        `${mb(st.sd)} MB`.padEnd(8) +
        String(r.role || '') + (r.url ? `  ${r.url}` : ''),
    );
  }
  const tabs = ranked.filter((r) => r.type === 'Tab');
  const sumSeries = (key) =>
    win.frames.map((f) => f.processes.filter((p) => tabs.some((t) => t.pid === p.pid)).reduce((a, p) => a + p[key], 0));
  for (const key of ['workingSetMB', 'privateBytesMB']) {
    const ys = sumSeries(key);
    const st = stats(ys);
    console.log(
      `  app Tab sum ${key.padEnd(15)} ${mb(ys[0])} -> ${mb(ys[ys.length - 1])}  LSQ ${mb(lsq(ys, minutes))} MB/min  sd ${mb(st.sd)}  range ${mb(st.range)}`,
    );
  }
  ranked.sort((a, b) => (b.pv || -1e9) - (a.pv || -1e9));
  console.log('  committed-growth ranking (private slope): ' + ranked.slice(0, 4).map((r) => `${r.pid}:${mb(r.pv)} MB/m`).join('  '));
  return { win, ranked };
}

/** What the gates actually read: the harness walk, foreign processes included. */
function printContaminated(label) {
  const win = inWindow(label);
  if (!win) return;
  const scoped = win.samples;
  const first = scoped[0];
  const last = scoped[scoped.length - 1];
  const mins = (last.at - first.at) / 60_000;
  console.log(`\n### ${label}: harness tree walk (what the gates read; foreign processes included)`);
  console.log(`  totalWorkingSetMB ${mb(first.totalWorkingSetMB)} -> ${mb(last.totalWorkingSetMB)}  = ${mb((last.totalWorkingSetMB - first.totalWorkingSetMB) / mins)} MB/min`);
  const types = Object.keys(first.byType || {});
  for (const ty of types) {
    const a = first.byType[ty];
    const b = last.byType[ty];
    console.log(`  ${ty.padEnd(9)} count ${a.count} -> ${b.count} | ${mb(a.workingSetMB)} -> ${mb(b.workingSetMB)} = ${mb((b.workingSetMB - a.workingSetMB) / mins)} MB/min`);
  }
  const appPids = new Set();
  for (const f of win.frames) for (const p of f.processes) appPids.add(p.pid);
  const residual = scoped.map((s) => {
    let best = null;
    let bestDelta = Infinity;
    for (const f of win.frames) {
      const d = Math.abs(f.at - s.at);
      if (d < bestDelta) {
        bestDelta = d;
        best = f;
      }
    }
    const app = best.processes.reduce((a, p) => a + p.workingSetMB, 0);
    return s.totalWorkingSetMB - app;
  });
  console.log(`  residual (walk minus the ${appPids.size} app pids, i.e. foreign + pty): ${mb(residual[0])} -> ${mb(residual[residual.length - 1])} MB  = ${mb(lsq(residual, mins))} MB/min`);
}

/**
 * A sawtoothing series cannot be judged by its raw slope: on the 2 h run the renderer
 * working set swung 19 MB around a 10 MB/hour drift, so a 30-minute cut reported anywhere
 * between 0.2 and 0.4 MB/min depending only on where the cut fell. What a retention defect
 * moves is the *floor* - the value the series returns to after each collection - so this
 * prints the rolling-minimum envelope next to the raw series, plus the amplitude/drift
 * ratio that says whether the trend is even measurable in the window.
 */
function printEnvelope(label) {
  const win = inWindow(label);
  if (!win || win.frames.length < 6) {
    console.log(`\n### ${label}: envelope needs 6+ frames (${win ? win.frames.length : 0})`);
    return;
  }
  const tabs = new Set();
  for (const f of win.frames) for (const p of f.processes) if (p.type === 'Tab') tabs.add(p.pid);
  const minutes = (win.frames[win.frames.length - 1].at - win.frames[0].at) / 60_000;
  const k = Math.max(3, Math.min(10, Math.floor(win.frames.length / 3)));
  console.log(`\n### ${label}: post-GC floor (rolling min over ${k} frames) vs raw series`);
  for (const key of ['workingSetMB', 'privateBytesMB']) {
    const ys = win.frames.map((f) => f.processes.filter((p) => tabs.has(p.pid)).reduce((a, p) => a + p[key], 0));
    const floors = [];
    const floorAt = [];
    for (let i = 0; i + k <= ys.length; i++) {
      floors.push(Math.min(...ys.slice(i, i + k)));
      floorAt.push(win.frames[i].at);
    }
    const amp = Math.max(...ys) - Math.min(...ys);
    const drift = ys[ys.length - 1] - ys[0];
    const floorMinutes = (floorAt[floorAt.length - 1] - floorAt[0]) / 60_000;
    console.log(`  ${key}`);
    console.log(`    raw    first ${mb(ys[0])} last ${mb(ys[ys.length - 1])} drift ${mb(drift)} MB amplitude ${mb(amp)} MB | LSQ ${mb(lsq(ys, minutes))} MB/min`);
    console.log(`    floor  ${floors.map((v) => v.toFixed(0)).join(' ')}`);
    console.log(`    floor  first ${mb(floors[0])} last ${mb(floors[floors.length - 1])} | LSQ ${mb(lsq(floors, floorMinutes))} MB/min  | amplitude/drift = ${(Math.abs(drift) < 0.01 ? 'n/a (no drift)' : (amp / Math.abs(drift)).toFixed(1) + 'x')}`);
  }
}

/** Rolling-minimum floor of a series over k frames: the value a series returns to after each collection. */
function floorSeries(ys, k) {
  const out = [];
  for (let i = 0; i + k <= ys.length; i++) out.push(Math.min(...ys.slice(i, i + k)));
  return out;
}

/**
 * Per-pid committed-memory floor, with a first-half/second-half slope split.
 *
 * The aggregate floor can hide a staircase: a series that rises, pauses 40 minutes and
 * rises again reads as a decelerating trend while no individual process ever decelerated.
 * Splitting the floor's own slope in half is what separates a high-water curve (second
 * half flattens) from retention at a constant rate (both halves agree) - the test that
 * decided the 4 h finding, kept here so the verdict is reproducible from one command
 * instead of an ad-hoc snippet.
 */
function printPerPidFloor(label, key = 'privateBytesMB') {
  const win = inWindow(label);
  if (!win || win.frames.length < 10) {
    console.log(`\n### ${label}: per-pid floor needs 10+ frames (${win ? win.frames.length : 0})`);
    return null;
  }
  const { rows, minutes } = pidTable(win);
  const perFrameMin = minutes / (win.frames.length - 1);
  const k = Math.max(3, Math.min(10, Math.floor(win.frames.length / 3)));
  const series = (r) => (key === 'workingSetMB' ? r.ws : r.pv);
  const ranked = [];
  for (const r of rows) {
    const ys = series(r);
    if (ys.length < k + 3) continue;
    const fl = floorSeries(ys, k);
    const n = fl.length;
    const half = Math.floor(n / 2);
    ranked.push({
      pid: r.pid,
      type: r.type,
      role: r.role || '',
      url: r.url || '',
      floorFirst: fl[0],
      floorLast: fl[n - 1],
      floorSlope: lsq(fl, (n - 1) * perFrameMin),
      firstHalf: lsq(fl.slice(0, half), (half - 1) * perFrameMin),
      secondHalf: lsq(fl.slice(half), (n - half - 1) * perFrameMin),
      rawSlope: lsq(ys, minutes),
    });
  }
  ranked.sort((a, b) => (b.floorSlope || -1e9) - (a.floorSlope || -1e9));
  console.log(`\n### ${label}: per-pid ${key} floor (rolling min over ${k} frames, ${win.frames.length} frames, ${minutes.toFixed(1)} min)`);
  console.log(
    '  ' +
      'pid'.padEnd(7) +
      'type'.padEnd(9) +
      'floor first->last'.padEnd(21) +
      'floor slope'.padEnd(13) +
      '1st half'.padEnd(10) +
      '2nd half'.padEnd(10) +
      'raw slope'.padEnd(11) +
      'role',
  );
  for (const r of ranked) {
    console.log(
      '  ' +
        String(r.pid).padEnd(7) +
        String(r.type).padEnd(9) +
        `${mb(r.floorFirst)} -> ${mb(r.floorLast)}`.padEnd(21) +
        `${mb(r.floorSlope)} MB/m`.padEnd(13) +
        mb(r.firstHalf).padEnd(10) +
        mb(r.secondHalf).padEnd(10) +
        `${mb(r.rawSlope)} MB/m`.padEnd(11) +
        (r.role || r.url || ''),
    );
  }
  const top = ranked[0];
  if (top) {
    const ratio = top.firstHalf > 0 ? top.secondHalf / top.firstHalf : NaN;
    const shape = !Number.isFinite(ratio)
      ? 'n/a'
      : ratio > 0.6
        ? `linear at a constant rate (2nd half is ${(ratio * 100).toFixed(0)}% of the 1st) - retention, not high-water`
        : `decelerating (2nd half is ${(ratio * 100).toFixed(0)}% of the 1st) - a high-water curve, not a constant leak`;
    console.log(`  top riser: pid ${top.pid} ${top.role || top.url || ''} at ${mb(top.floorSlope)} MB/min ${key} -> ${shape}`);
  }
  // The gate's own series is the parent-pid walk, which catches every renderer the tree
  // reaches - including a foreign Electron app. An app-owned leak is diluted by whatever
  // else the walk sweeps up, so the same quantity is computed app-only here; without this
  // pair a gate that passes can be reported while the app's own renderer is over threshold.
  const tabs = new Set(ranked.filter((r) => r.type === 'Tab').map((r) => r.pid));
  const sum = win.frames.map((f) =>
    f.processes
      .filter((p) => tabs.has(p.pid))
      .reduce((a, p) => a + (key === 'workingSetMB' ? p.workingSetMB : p.privateBytesMB), 0),
  );
  const sumFloor = floorSeries(sum, k);
  const appSum = lsq(sumFloor, (sumFloor.length - 1) * perFrameMin);
  console.log(`  app-only Tab sum: ${mb(sumFloor[0])} -> ${mb(sumFloor[sumFloor.length - 1])} floor = ${mb(appSum)} MB/min across ${tabs.size} app Tab processes`);
  const gate = report.metrics ? report.metrics.rendererActiveSlopeMBPerMin : undefined;
  if (key === 'workingSetMB' && Number.isFinite(gate)) {
    const diluted = appSum - gate;
    console.log(
      `  vs the reported renderer gate ${mb(gate)} MB/min (a walk that also catches foreign renderers): ` +
        (appSum > 0 && gate > 0 && diluted > 0.01
          ? `the gate reads ${mb(diluted)} MB/min BELOW the app's own renderers`
          : appSum <= 0 && gate <= 0
            ? 'both agree the app renderers are not growing in this currency'
            : `the gate and the app-only floor disagree in sign (gate ${mb(gate)}, app ${mb(appSum)}): working set is not the currency this growth appears in`),
    );
  }
  return ranked;
}

/** Linear-interpolated quantile of an ascending series. */
function quantile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * The switch tail, read from the whole series instead of its ten slowest samples.
 *
 * The gate grades percentiles and reports the maximum, which leaves open the question the
 * 4 h verdict could not answer: *what* produces the tail. Two candidates that a top-ten
 * list cannot separate are separated here by counts, because one of them is a rate in the
 * run's own driver — a stall that collides with the terminal write path must be more
 * frequent in the leg that writes four times as many lines, while a stall indifferent to
 * that path must not be. The harness's own 60 s process scrape is tested the same way,
 * against each stall's position inside the sampling interval, with every switch printed
 * beside it so a cluster that is really that cadence is visible as one.
 *
 * 35 ms is kept as the stall reference because it is the bound every prior verdict was
 * written against; the run's own p99 is printed next to it so a shifted distribution is
 * not read as a growing tail.
 */
function printSwitchTail() {
  const sw = Array.isArray(report.switchSamples) ? report.switchSamples : [];
  if (sw.length === 0) {
    const legacy = Array.isArray(report.slowSwitchSamples) ? report.slowSwitchSamples : [];
    console.log(`\n### switch tail: this report has no switchSamples (${legacy.length} slowest only)`);
    if (legacy.length > 0) {
      console.log(
        '  the full series is what separates a stall that tracks the terminal write volume from one that does not;' +
          '\n  a top-ten list can only say the tail exists. Re-run with the current harness to read the tail.',
      );
    }
    return;
  }
  const STALL_MS = 35;
  const sorter = (a, b) => a - b;
  const all = sw.map((s) => Number(s.ms)).sort(sorter);
  const workload = sw.filter((s) => s.phase === 'workload').map((s) => Number(s.ms)).sort(sorter);
  const stalls = sw.filter((s) => Number(s.ms) >= STALL_MS);
  console.log(`\n### switch tail (full series, ${sw.length} switches${report.switchSamplesDropped ? `, ${report.switchSamplesDropped} dropped at the cap` : ''})`);
  console.log(
    `  all ${sw.length}: p50 ${mb(quantile(all, 0.5))} p95 ${mb(quantile(all, 0.95))} p99 ${mb(quantile(all, 0.99))} max ${mb(quantile(all, 1))} | ` +
      `workload ${workload.length}: p50 ${mb(quantile(workload, 0.5))} p95 ${mb(quantile(workload, 0.95))} max ${mb(quantile(workload, 1))}`,
  );
  const reported = report.metrics && report.metrics.switchLatencyMs;
  if (reported && Number.isFinite(reported.p50) && Number.isFinite(reported.p95)) {
    // An independent recompute that agrees with the gate is what makes the gate's window
    // trustworthy; one that disagrees means the gate graded a different set of switches
    // than this payload holds, so the disagreement is stated, not left to be subtracted.
    const dP50 = Math.abs(reported.p50 - quantile(workload, 0.5));
    const dP95 = Math.abs(reported.p95 - quantile(workload, 0.95));
    console.log(
      `  vs the reported workload gate: p50 ${mb(reported.p50)} p95 ${mb(reported.p95)} -> ` +
        (dP50 <= 0.01 && dP95 <= 0.01
          ? 'agrees with the recompute above (the gate graded this series)'
          : `DISAGREES with the recompute above by ${mb(dP50)} / ${mb(dP95)} ms - the gate did not grade this series`),
    );
  }
  console.log(`  stalls >= ${STALL_MS} ms: ${stalls.length} of ${sw.length} = ${((stalls.length / sw.length) * 100).toFixed(3)} %`);
  const group = (keyOf) => {
    const map = new Map();
    for (const s of sw) {
      const k = keyOf(s) || '(none)';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(Number(s.ms));
    }
    return map;
  };
  const table = (title, map, note) => {
    console.log(`\n  ${title}`);
    console.log('    ' + 'group'.padEnd(16) + 'n'.padEnd(7) + `>=${STALL_MS}ms`.padEnd(10) + 'per 1000'.padEnd(10) + 'p50'.padEnd(9) + 'p95'.padEnd(9) + 'max');
    for (const [k, values] of map) {
      const sorted = values.slice().sort(sorter);
      const hit = sorted.filter((v) => v >= STALL_MS).length;
      console.log(
        '    ' +
          String(k).padEnd(16) +
          String(sorted.length).padEnd(7) +
          String(hit).padEnd(10) +
          ((hit / sorted.length) * 1000).toFixed(2).padEnd(10) +
          mb(quantile(sorted, 0.5)).padEnd(9) +
          mb(quantile(sorted, 0.95)).padEnd(9) +
          mb(quantile(sorted, 1)),
      );
    }
    if (note) console.log(`    ${note}`);
  };
  table('per phase:', group((s) => s.phase));
  // The leg A/B: same pages, same host, same switch cadence — only the terminal write
  // volume moves, so a stall rate that tracks the leg is a collision with the write path.
  const legMap = group((s) => s.leg);
  if (legMap.size > 1) {
    table('per leg (only the terminal write volume moves between them):', legMap);
  } else if (legMap.size === 1) {
    // One group is two different facts, and the old wording asserted the wrong one on a run that
    // has a leg schedule but no sample inside a leg yet (warmup): "no leg schedule in this run".
    const only = [...legMap.keys()][0];
    const scheduled = Array.isArray(report.config && report.config.legs) && report.config.legs.length > 0;
    console.log(
      only === '(none)'
        ? `\n  per leg: no switch in this payload carries a leg tag (${scheduled ? `${report.config.legs.length} leg(s) scheduled, and none of its samples landed inside one yet — a warmup read, or the workload has not started` : 'this run has no leg schedule'})`
        : `\n  per leg: every tagged switch ran in ${only}, so the leg A/B needs another leg's samples to compare`,
    );
  }
  const intervalMs = Math.max(1000, Number((report.config && report.config.sampleIntervalSeconds) || 60) * 1000);
  const BINS = 12;
  const binOf = (at) => Math.min(BINS - 1, Math.floor(((at % intervalMs) + intervalMs) % intervalMs / (intervalMs / BINS)));
  const stallBins = new Array(BINS).fill(0);
  for (const s of stalls) stallBins[binOf(Number(s.at))]++;
  const allBins = new Array(BINS).fill(0);
  for (const s of sw) allBins[binOf(Number(s.at))]++;
  const width = intervalMs / BINS / 1000;
  console.log(`\n  position inside the harness's own ${intervalMs / 1000}s sampling interval (a scrape collision would pile up in one bin):`);
  console.log('    ' + 'bin(s)'.padEnd(10) + Array.from({ length: BINS }, (_, i) => `${(i * width).toFixed(0)}-${((i + 1) * width).toFixed(0)}`.padEnd(8)).join(''));
  console.log('    ' + `>=${STALL_MS}ms`.padEnd(10) + stallBins.map((v) => String(v).padEnd(8)).join(''));
  console.log('    ' + 'all'.padEnd(10) + allBins.map((v) => String(v).padEnd(8)).join(''));
  console.log(
    '\n  reading: a stall rate that rises with the leg\'s burst volume is a collision with the terminal write path;' +
      '\n           a rate that holds while the burst volume quadruples is indifferent to it and belongs to the UI thread itself;' +
      '\n           a pile-up in one sample-bin is the harness\'s own scrape and not the app.',
  );
}

/**
 * Does closing the views release the retained memory? The recovery phase closes tabs and
 * the terminal while the window (and therefore the shared `file://` renderer) survives, so
 * a pid that is still alive in recovery and drops has memory bound to the closed work; a
 * pid that stays at its workload level has memory bound to the window itself, which scales
 * with how long the app has been open rather than with what it was doing.
 */
function printRecoveryRelease() {
  const w = inWindow('workload');
  const r = inWindow('recovery');
  if (!w || !r || w.frames.length < 3 || r.frames.length < 3) {
    console.log('\n### recovery release: needs 3+ frames in both workload and recovery');
    return;
  }
  const wLast = w.frames[w.frames.length - 1];
  const recoveryIds = new Set();
  for (const f of r.frames) for (const p of f.processes) recoveryIds.add(p.pid);
  console.log(`\n### recovery release (workload last ${clock(wLast.at)} -> recovery ${clock(r.frames[0].at)}..${clock(r.frames[r.frames.length - 1].at)})`);
  console.log('  ' + 'pid'.padEnd(7) + 'type'.padEnd(9) + 'workload end'.padEnd(15) + 'recovery min'.padEnd(15) + 'recovery end'.padEnd(15) + 'released'.padEnd(11) + 'role');
  for (const p of wLast.processes) {
    const pv = r.frames.map((f) => f.processes.find((q) => q.pid === p.pid)?.privateBytesMB).filter(Number.isFinite);
    if (pv.length < 3) {
      console.log('  ' + String(p.pid).padEnd(7) + String(p.type).padEnd(9) + mb(p.privateBytesMB).padEnd(15) + '(gone)'.padEnd(15) + '(gone)'.padEnd(15) + '(gone)'.padEnd(11) + (p.role || p.url || ''));
      continue;
    }
    const min = Math.min(...pv);
    console.log(
      '  ' +
        String(p.pid).padEnd(7) +
        String(p.type).padEnd(9) +
        mb(p.privateBytesMB).padEnd(15) +
        mb(min).padEnd(15) +
        mb(pv[pv.length - 1]).padEnd(15) +
        mb(p.privateBytesMB - min).padEnd(11) +
        (p.role || p.url || ''),
    );
  }
  const survivors = wLast.processes.filter((p) => recoveryIds.has(p.pid));
  const gone = wLast.processes.filter((p) => !recoveryIds.has(p.pid));
  console.log(`  ${survivors.length} pids survived into recovery, ${gone.length} closed with their view (a closed pid releases everything, which is expected and says nothing about retention)`);
}

/**
 * CPU of the app-owned tree, as an exact difference of the cumulative per-process counters
 * the process table carries (100 ns ticks, monotonic per process).
 *
 * Memory decides how many tabs can stay open; CPU is what decides how much work can be
 * pushed through them, because the terminal write path, the state broadcast and the tab
 * renderers draw on the same threads. It is recomputed here from the run's own per-minute
 * frames rather than only printed from `metrics.cpu`: an independent recompute that agrees
 * with the reported block is what makes that block trustworthy, and one that disagrees says
 * the report graded a different window than this payload holds.
 *
 * Three shapes cannot be differenced from a window's two endpoints, and each is counted
 * instead of guessed: a pid present at one end only (started or exited inside the window), a
 * pid whose counters are unreadable at one end, and a pid whose counter went backwards (pid
 * reuse, or a reset). Their cost is missing from the total, so the total is a LOWER BOUND and
 * the counts say over how much of the tree it is one.
 */
function cpuDelta(rows) {
  if (rows.length < 2) return null;
  const start = rows[0].cpuByPid || {};
  const end = rows[rows.length - 1].cpuByPid || {};
  const per = new Map();
  const notAttributable = [];
  const unreadable = [];
  const reset = [];
  for (const key of new Set([...Object.keys(start), ...Object.keys(end)])) {
    const pid = Number(key);
    const inStart = Object.prototype.hasOwnProperty.call(start, key);
    const inEnd = Object.prototype.hasOwnProperty.call(end, key);
    if (!inStart || !inEnd) {
      notAttributable.push(pid);
      continue;
    }
    const a = start[key];
    const b = end[key];
    if (typeof a !== 'number' || typeof b !== 'number') {
      unreadable.push(pid);
      continue;
    }
    if (b - a < 0) {
      reset.push(pid);
      continue;
    }
    per.set(pid, Number((b - a).toFixed(3)));
  }
  const total = Number([...per.values()].reduce((a, b) => a + b, 0).toFixed(3));
  const minutes = (rows[rows.length - 1].at - rows[0].at) / 60_000;
  return {
    from: rows[0].at,
    to: rows[rows.length - 1].at,
    minutes,
    frames: rows.length,
    total,
    perMinute: minutes > 0 ? Number((total / minutes).toFixed(3)) : null,
    per: [...per.entries()].sort((a, b) => b[1] - a[1]),
    notAttributable,
    unreadable,
    reset,
  };
}

/** Samples that carry per-process CPU counters, within a window. */
function cpuFrames(from, to) {
  return samples.filter(
    (s) =>
      s.cpuByPid &&
      typeof s.cpuByPid === 'object' &&
      // A row whose map is present but empty carries no counters; differencing two of those
      // yields a 0 total, which would print as a cost rather than as an absent measurement.
      Object.keys(s.cpuByPid).length > 0 &&
      s.at >= from &&
      s.at <= to,
  );
}

/** Role per pid, from the app's own telemetry rows (never from the harness walk). */
function roleByPid() {
  const map = new Map();
  for (const f of frames) for (const p of f.processes) if (p.role) map.set(String(p.pid), p.role);
  return map;
}

const s3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'n/a');

/**
 * CPU per phase and, when the run carries a leg schedule, per leg — the work-rate reading.
 *
 * Cost is printed per unit of work beside the total, because that is what "more work at once"
 * is a question about: a regime that writes four times the lines for four times the CPU is not
 * cheaper to scale, while one whose CPU does not move with the volume is paying per minute
 * instead of per line. A per-line cost over fewer than 1000 observed lines is printed as n/a,
 * since the quotient there is noise with a large magnitude that reads like a measurement.
 */
function printCpu() {
  const withCpu = samples.filter(
    (s) => s.cpuByPid && typeof s.cpuByPid === 'object' && Object.keys(s.cpuByPid).length > 0,
  );
  console.log('\n### app CPU (exact difference of cumulative per-process counters, app-owned tree only)');
  if (withCpu.length < 2) {
    console.log(
      `  this report carries ${withCpu.length} sample(s) with per-process CPU counters, so CPU is NOT MEASURED` +
        ' here — the run predates the instrument. Not measured is printed rather than 0, because 0 reads as a measurement.',
    );
    return;
  }
  const roles = roleByPid();
  const cfg = report.config || {};
  const burstsByPhase = (report.stats && report.stats.burstsByPhase) || null;
  console.log(
    `  ${withCpu.length} of ${samples.length} samples carry counters | configured burst ${cfg.burstLines ?? 'n/a'} lines / ${cfg.burstIntervalMs ?? 'n/a'}ms`,
  );
  if (report.metrics && report.metrics.legBurstCounterSuspect) {
    console.log(
      '  FLAG: metrics.legBurstCounterSuspect is set — this run wrote bursts but no leg recorded any, so every per-line' +
        '\n        cost in this report is null for an instrument reason, not because the work was free. The s/min column' +
        '\n        is still readable and answers the same question at leg granularity.',
    );
  }
  console.log(
    '  ' + 'phase'.padEnd(10) + 'minutes'.padEnd(9) + 'cpu s'.padEnd(10) + 's/min'.padEnd(9) + 'frames'.padEnd(8) + 'excluded (one-end / unreadable / reset)'.padEnd(40) + 'top consumer',
  );
  const totals = {};
  for (const label of ['warmup', 'workload', 'recovery']) {
    const scoped = withCpu.filter((s) => s.label === label);
    const d = cpuDelta(scoped);
    if (!d) {
      console.log(`  ${label.padEnd(10)}not measured (${scoped.length} counter frame(s))`);
      continue;
    }
    totals[label] = d;
    const top = d.per[0];
    const bursts = burstsByPhase && Number.isFinite(burstsByPhase[label]) ? burstsByPhase[label] : null;
    // Which knob the lines came from depends on the run: a leg run wrote its legs' volumes, so
    // pricing its workload against the base knob (`config.burstLines`) would divide one regime's
    // CPU by another regime's line count. Warmup and recovery always run the base knob.
    const legSchedule = Array.isArray(cfg.legs) ? cfg.legs : [];
    const legRows = Array.isArray(report.legSlopes) ? report.legSlopes : [];
    const legObservedTotal = legRows.reduce(
      (a, l) => a + (Number.isFinite(l.bursts) ? l.bursts * l.burstLines : 0),
      0,
    );
    // Three different readings, and conflating them is how a fault hides in an "n/a":
    //   - every scheduled leg observed: the phase ran exactly those legs, so price it against
    //     their volume (the base knob is not this run's volume);
    //   - a leg run read mid-flight: only some legs exist, so the phase's line volume is not in
    //     this artifact at all — it is neither zero nor the base knob, and the per-leg rows are
    //     where the cost lives;
    //   - every leg observed, all of them at 0 bursts while the phase wrote: a counter fault.
    const legRunComplete = label === 'workload' && legSchedule.length > 0 && legRows.length >= legSchedule.length;
    const legRunPartial = label === 'workload' && legSchedule.length > 0 && !legRunComplete;
    const legLines = legRunComplete ? legObservedTotal : null;
    // No denominator at all on a partial leg run: falling back to the base knob would price a
    // deliberately different regime's CPU against the wrong volume and print it as a measurement.
    const lines = legLines !== null
      ? legLines
      : legRunPartial || bursts === null
        ? null
        : bursts * Number(cfg.burstLines || 0);
    const per1000 = lines !== null && lines >= 1000 ? (d.total * 1000) / (lines / 1000) : null;
    console.log(
      '  ' +
        label.padEnd(10) +
        d.minutes.toFixed(1).padEnd(9) +
        s3(d.total).padEnd(10) +
        s3(d.perMinute).padEnd(9) +
        String(d.frames).padEnd(8) +
        `${d.notAttributable.length} / ${d.unreadable.length} / ${d.reset.length}`.padEnd(40) +
        (top ? `${roles.get(String(top[0])) || 'unattributed'} pid=${top[0]} ${s3(top[1])}s` : 'none'),
    );
    if (per1000 !== null) {
      console.log(
        `    ${label}: ${s3(per1000)} ms per 1000 burst lines (${bursts} observed bursts, ${lines} lines` +
          `${legLines !== null ? ', the legs\' observed volume, not the base knob' : ''})`,
      );
    } else if (legRunPartial) {
      console.log(
        `    ${label}: ${legRows.length} of ${legSchedule.length} leg(s) observed in this artifact, so the phase's line volume` +
          ' is not available yet — the per-leg rows carry the cost, and pricing this phase against the base knob would' +
          ' divide one regime\'s CPU by another regime\'s work',
      );
    } else if (bursts === 0) {
      console.log(`    ${label}: no bursts observed in this phase, so no per-line cost exists to print`);
    } else if (legLines === 0) {
      console.log(`    ${label}: leg schedule present but no leg recorded bursts, so there are no lines to divide by (counter fault)`);
    }
  }
  const reported = report.metrics && report.metrics.cpu;
  if (reported && Number.isFinite(reported.cpuSecondsTotal) && totals.workload) {
    const dTotal = Math.abs(reported.cpuSecondsTotal - totals.workload.total);
    const dWin = Math.abs((reported.windowMinutes || 0) - totals.workload.minutes);
    console.log(
      `  vs the reported metrics.cpu: ${s3(reported.cpuSecondsTotal)}s over ${s3(reported.windowMinutes)} min -> ` +
        (dTotal <= 0.01 && dWin <= 0.1
          ? 'agrees with the recompute above (the report graded this series)'
          : `DISAGREES with the recompute above by ${s3(dTotal)}s / ${s3(dWin)} min — the report graded a different window than this payload holds`),
    );
  } else if (!reported) {
    console.log('  vs the reported metrics.cpu: this report carries no cpu block (the harness predates it)');
  }
  const stalled = totals.recovery;
  if (stalled && totals.workload && totals.workload.perMinute > 0) {
    const share = stalled.perMinute / totals.workload.perMinute;
    console.log(
      `  idle floor: recovery runs at ${s3(stalled.perMinute)} s/min = ${(share * 100).toFixed(0)}% of the workload's rate` +
        (share > 0.5
          ? ' — the app keeps spending most of its workload CPU while the workload is over, so the cost is not driven by the work'
          : ' — the app spends proportionally less while idle, so the cost tracks the work'),
    );
  }
}

/** LSQ with a standard error over an explicit (x, y) grid; x in minutes. */
function lsqFull(points) {
  const n = points.length;
  if (n < 3) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (const p of points) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ssres = 0;
  for (const p of points) ssres += (p.y - (intercept + slope * p.x)) ** 2;
  const sd = Math.sqrt(ssres / (n - 2));
  return { slope, se: sd / Math.sqrt(sxx), sd, n, first: points[0].y, last: points[n - 1].y, minutes: points[n - 1].x - points[0].x };
}

/**
 * The bisect's answer: per-leg slopes over the windows the run actually observed.
 *
 * A slope fitted across legs that ran deliberately different burst volumes is a blend of
 * regimes, which is why the harness reports `slopeSloSatisfied: null` for a leg run. Each
 * leg is therefore fitted to its own window here, per process, in committed private bytes,
 * with the floor (rolling min) beside the raw series - and the cross-leg table tracks the
 * same two identities (the leg-1 top riser and every `chrome*` role) so a slope that moves
 * with the leg's knobs while process identity, page set and switch rate stay fixed is read
 * as the driver instead of being averaged away.
 *
 * Leg windows derived from the run's own schedule, for reading a run that is still in
 * flight: a checkpoint carries no `legSlopes` until the harness finishes, so a leg that
 * has already completed cannot be read from it otherwise — which is what makes the
 * bisect's answer available at the end of leg 2 instead of four hours in. These
 * boundaries are *scheduled*, not observed: a machine sleep or a delayed phase shifts
 * them. Every derived leg is therefore labelled provisional, and the final report's
 * `legSlopes` (built from boundaries the run actually printed) supersedes this read.
 */
function deriveScheduledLegs() {
  const cfg = report.config || {};
  const planned = Array.isArray(cfg.legs) ? cfg.legs : [];
  const startedAt = Date.parse(report.startedAt);
  const warmup = Number(cfg.warmupMinutes);
  if (planned.length < 2 || !Number.isFinite(startedAt) || !Number.isFinite(warmup)) return [];
  let cursor = startedAt + warmup * 60_000;
  const out = [];
  for (const leg of planned) {
    const minutes = Number(leg.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return [];
    out.push({
      name: leg.name,
      burstLines: leg.burstLines,
      burstIntervalMs: leg.burstIntervalMs,
      observedFrom: cursor,
      observedTo: cursor + minutes * 60_000,
      bursts: null,
      provisional: true,
    });
    cursor += minutes * 60_000;
  }
  return out;
}

function printLegs() {
  let legs = Array.isArray(report.legSlopes) ? report.legSlopes : [];
  const provisional = legs.length === 0;
  if (provisional) legs = deriveScheduledLegs();
  if (legs.length === 0) {
    console.log('\n### legs: this report has no legSlopes (single-regime run)');
    return;
  }
  const windows = [];
  for (const leg of legs) {
    const from = Number.isFinite(leg.observedFrom) ? leg.observedFrom : leg.startAt;
    const to = Number.isFinite(leg.observedTo) ? leg.observedTo : leg.endAt;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      windows.push({ leg, win: null });
      continue;
    }
    windows.push({
      leg,
      win: { from, to, samples: samples.filter((s) => s.at >= from && s.at <= to), frames: frames.filter((f) => f.at >= from && f.at <= to) },
    });
  }

  const byPid = new Map();
  const legCpu = [];
  console.log('\n### leg bisect (per leg, committed private bytes, observed windows)');
  if (provisional) {
    console.log(
      '  NOTE: no leg has closed its window in this artifact (only a finished run writes legSlopes, and a' +
        '\n        checkpoint carries them only for the legs it has exited), so the windows below are DERIVED from' +
        '\n        config.legs + startedAt, not observed. A machine sleep or a delayed phase shifts them, and the' +
        '\n        observed burst count is unknown, so the per-line column reads n/a. The final report supersedes this.',
    );
  }
  for (const { leg, win } of windows) {
    const requested = `${leg.burstLines} lines / ${leg.burstIntervalMs}ms`;
    if (!win || win.frames.length < 3) {
      console.log(`\n  leg ${leg.name} | ${requested} | no usable window (${win ? win.frames.length : 0} frames)`);
      continue;
    }
    const minutes = (win.to - win.from) / 60_000;
    // CPU of the same leg, so the bisect's memory answer and the throughput question are read
    // from one window: leg 2 (4× the burst volume) is also the concurrency test, and its cost
    // per line is what says whether more output per second is cheaper or simply bigger.
    const legCpuDelta = cpuDelta(cpuFrames(win.from, win.to));
    const perLegPid = new Map();
    for (const f of win.frames) {
      for (const p of f.processes) {
        if (!perLegPid.has(p.pid)) perLegPid.set(p.pid, { pid: p.pid, type: p.type, role: p.role || p.url || '', pts: [] });
        perLegPid.get(p.pid).pts.push({ x: (f.at - win.from) / 60_000, y: Number(p.privateBytesMB || 0) });
      }
    }
    const rows = [];
    for (const r of perLegPid.values()) {
      const fit = lsqFull(r.pts);
      if (!fit) continue;
      const k = Math.max(3, Math.min(10, Math.floor(r.pts.length / 3)));
      const fl = floorSeries(r.pts.map((p) => p.y), k);
      const floorFit = lsqFull(fl.map((y, i) => ({ x: (i * minutes) / Math.max(1, fl.length - 1), y })));
      rows.push({ ...r, fit, floorFit });
      if (!byPid.has(r.pid)) byPid.set(r.pid, { pid: r.pid, type: r.type, role: r.role, legs: {} });
      byPid.get(r.pid).legs[leg.name] = { fit, floorFit, bursts: leg.bursts ?? null, burstLines: leg.burstLines };
    }
    rows.sort((a, b) => b.fit.slope - a.fit.slope);
    const burstLines = Number(leg.bursts || 0) * Number(leg.burstLines || 0);
    // A leg that recorded no bursts while its own schedule expected dozens is a counter fault:
    // the zero then flows into every per-line quotient and nulls them, which reads exactly like
    // a leg that had no work. Named here so the two cannot be confused.
    const legScheduledBursts = Number(leg.burstIntervalMs) > 0 ? Math.floor(((win.to - win.from) / Number(leg.burstIntervalMs))) : null;
    const counterFault = !leg.provisional && Number(leg.bursts) === 0 && legScheduledBursts !== null && legScheduledBursts >= 3;
    // A per-line cost needs lines to divide by: over a burst-off leg the quotient is noise
    // with a large magnitude, which reads like a measurement. Below 1000 observed lines the
    // column is not printed as a number.
    const perLineUsable = burstLines >= 1000;
    const legPer1000 = legCpuDelta && perLineUsable ? (legCpuDelta.total * 1000) / (burstLines / 1000) : null;
    const legSwitches = (Array.isArray(report.switchSamples) ? report.switchSamples : []).filter(
      (s) => s.phase === 'workload' && Number(s.at) >= win.from && Number(s.at) <= win.to,
    ).length;
    const legMsPerSwitch = legCpuDelta && legSwitches > 0 ? (legCpuDelta.total * 1000) / legSwitches : null;
    console.log(
      `\n  leg ${leg.name} | ${requested} | window ${clock(win.from)} -> ${clock(win.to)} (${minutes.toFixed(1)} min, ${win.frames.length} frames)` +
        ` | bursts observed ${leg.bursts ?? 'n/a'} (${burstLines || 'n/a'} lines)` +
        (leg.provisional ? ' | PROVISIONAL (scheduled window, not observed)' : '') +
        (counterFault ? ` | LEG BURST COUNTER FAULT: ~${legScheduledBursts} bursts scheduled, 0 recorded -> per-line n/a` : '') +
        (perLineUsable ? '' : ' | per-line column n/a: fewer than 1000 observed lines'),
    );
    // The throughput reading of the same window: cost per unit of work, which is what a
    // concurrency claim is about. A per-line cost over a leg with almost no lines is not a
    // number, so it prints n/a there.
    console.log(
      '    CPU ' +
        (legCpuDelta
          ? `${s3(legCpuDelta.total)}s over ${legCpuDelta.minutes.toFixed(1)} min (${s3(legCpuDelta.perMinute)} s/min), ${legCpuDelta.per.length} pids`
          : 'not measured in this report (no counter frames)') +
        ` | ${legPer1000 !== null ? `${s3(legPer1000)} ms / 1000 lines` : 'per-line n/a'}` +
        ` | ${legMsPerSwitch !== null ? `${s3(legMsPerSwitch)} ms / switch (${legSwitches} switches)` : `per-switch n/a (${legSwitches} switches)`}` +
        (legCpuDelta && legCpuDelta.notAttributable.length + legCpuDelta.unreadable.length + legCpuDelta.reset.length > 0
          ? ` | lower bound: ${legCpuDelta.notAttributable.length} one-end, ${legCpuDelta.unreadable.length} unreadable, ${legCpuDelta.reset.length} reset`
          : ''),
    );
    legCpu.push({ name: leg.name, minutes, cpu: legCpuDelta, per1000: legPer1000, perSwitch: legMsPerSwitch, switches: legSwitches, bursts: leg.bursts ?? null, provisional: !!leg.provisional, counterFault });
    console.log('    ' + 'pid'.padEnd(7) + 'type'.padEnd(7) + 'pv first->last'.padEnd(20) + 'pv slope'.padEnd(17) + 'floor slope'.padEnd(14) + 'B/1000 lines'.padEnd(13) + 'role');
    for (const r of rows.slice(0, 6)) {
      const per1000 = perLineUsable ? ((r.fit.last - r.fit.first) * 1024 * 1024) / (burstLines / 1000) : NaN;
      console.log(
        '    ' +
          String(r.pid).padEnd(7) +
          String(r.type).padEnd(8) +
          `${mb(r.fit.first)} -> ${mb(r.fit.last)}`.padEnd(20) +
          `${mb(r.fit.slope)}±${mb(r.fit.se)}`.padEnd(17) +
          mb(r.floorFit ? r.floorFit.slope : NaN).padEnd(14) +
          (Number.isFinite(per1000) ? Math.round(per1000) : 'n/a').toString().padEnd(13) +
          r.role,
      );
    }
  }

  const firstLeg = windows.find((w) => w.win && w.win.frames.length >= 3);
  const firstRows = [];
  if (firstLeg) {
    const ids = new Set();
    for (const f of firstLeg.win.frames) for (const p of f.processes) ids.add(p.pid);
    for (const pid of ids) {
      const e = byPid.get(pid);
      if (e && e.legs[firstLeg.leg.name]) firstRows.push({ pid, ...e.legs[firstLeg.leg.name] });
    }
  }
  firstRows.sort((a, b) => b.fit.slope - a.fit.slope);
  const tracked = [];
  if (firstRows[0]) tracked.push({ label: 'leg-1 top riser', pid: firstRows[0].pid });
  for (const [pid, e] of byPid) if (/chrome/i.test(e.role || '') && !tracked.some((t) => t.pid === pid)) tracked.push({ label: 'app chrome', pid });

  if (tracked.length > 0) {
    console.log('\n  cross-leg matrix (same identity, one knob moved):');
    console.log('    ' + 'tracked'.padEnd(18) + 'pid'.padEnd(7) + windows.map((w) => (w.leg.name || '?').padEnd(24)).join(''));
    for (const t of tracked) {
      const e = byPid.get(t.pid);
      if (!e) continue;
      const cells = windows.map((w) => {
        const cell = e.legs[w.leg.name];
        if (!cell || !cell.fit) return 'n/a'.padEnd(24);
        return `${mb(cell.fit.slope)}±${mb(cell.fit.se)} MB/m`.padEnd(24);
      });
      console.log('    ' + String(t.label).padEnd(18) + String(t.pid).padEnd(7) + cells.join(''));
      const drops = windows.map((w) => {
        const cell = e.legs[w.leg.name];
        return cell && cell.fit ? `${mb(cell.fit.last - cell.fit.first)} MB` : 'n/a';
      });
      console.log('    ' + ''.padEnd(25) + windows.map((w, i) => `${w.leg.name}: Δ ${drops[i]}`.padEnd(24)).join(''));
    }
    console.log(
      '\n    reading: a slope that scales with the leg\'s burst volume is a per-line cost (leg 2 ≈ 4x leg 1, leg 3 ≈ 0);' +
        '\n             a slope that holds across leg 1 and leg 2 and collapses only with the workload is per-minute;' +
        '\n             a slope that holds across all three legs is neither and points outside the terminal write path.',
    );
  }

  if (legCpu.some((l) => l.cpu)) {
    console.log('\n  cross-leg CPU (the same knob, read as a work rate rather than as a slope):');
    console.log(
      '    ' + 'leg'.padEnd(14) + 'minutes'.padEnd(9) + 'cpu s'.padEnd(10) + 's/min'.padEnd(9) + 'bursts'.padEnd(9) + 'ms/1000 lines'.padEnd(15) + 'ms/switch'.padEnd(11) + 'note',
    );
    for (const l of legCpu) {
      const ramp = l.cpu ? l.cpu.perMinute : NaN;
      const base = legCpu[0] && legCpu[0].cpu ? legCpu[0].cpu.perMinute : NaN;
      console.log(
        '    ' +
          String(l.name).padEnd(14) +
          l.minutes.toFixed(1).padEnd(9) +
          s3(l.cpu ? l.cpu.total : NaN).padEnd(10) +
          s3(ramp).padEnd(9) +
          String(l.bursts ?? 'n/a').padEnd(9) +
          (l.per1000 !== null ? s3(l.per1000) : 'n/a').padEnd(15) +
          (l.perSwitch !== null ? s3(l.perSwitch) : 'n/a').padEnd(11) +
          (l.provisional ? 'PROVISIONAL window; observed bursts unknown, so per-line n/a' : '') +
          (l.counterFault ? 'counter fault: 0 bursts recorded, per-line n/a' : ''),
      );
      if (Number.isFinite(ramp) && Number.isFinite(base) && base > 0 && l !== legCpu[0]) {
        console.log(`      ${l.name}: ${s3(ramp)} s/min = ${(ramp / base).toFixed(2)}x leg 1's CPU rate`);
      }
    }
    console.log(
      '    reading: CPU that tracks the burst volume is a per-line cost (leg 2 ≈ 4x leg 1); CPU that holds while' +
        '\n             the volume quadruples is a per-minute cost, and the concurrency lever is then not the terminal path.',
    );
  }
}

console.log(`report: ${reportArg ? path.resolve(reportArg) : DEFAULT_REPORT}`);
console.log(`status: ${report.status} | started ${report.startedAt} | frames ${frames.length} | samples ${samples.length}`);
if (report.config) console.log(`config: ${JSON.stringify(report.config)}`);
if (report.metrics) {
  console.log(`reported gates: ${JSON.stringify({
    switchLatencyMs: report.metrics.switchLatencyMs,
    rendererActiveSlopeMBPerMin: report.metrics.rendererActiveSlopeMBPerMin,
    overallActiveSlopeMBPerMin: report.metrics.overallActiveSlopeMBPerMin,
    worstProcessSlopeMBPerMin: report.metrics.worstProcessSlopeMBPerMin,
    worstProcessPid: report.metrics.worstProcessPid,
    worstProcessRole: report.metrics.worstProcessRole,
    rolling60MinSlopes: report.metrics.rolling60MinSlopes,
    cpu: report.metrics.cpu
      ? {
          cpuSecondsTotal: report.metrics.cpu.cpuSecondsTotal,
          cpuSecondsPerMinute: report.metrics.cpu.cpuSecondsPerMinute,
          msPer1000BurstLines: report.metrics.cpu.msPer1000BurstLines,
          msPerSwitch: report.metrics.cpu.msPerSwitch,
        }
      : null,
  })}`);
}

for (const label of ['warmup', 'workload', 'recovery']) printWindow(label);
for (const label of ['warmup', 'workload', 'recovery']) printEnvelope(label);
for (const label of ['workload']) printPerPidFloor(label, 'privateBytesMB');
for (const label of ['workload']) printPerPidFloor(label, 'workingSetMB');
printRecoveryRelease();
printCpu();
printLegs();
printSwitchTail();
for (const label of ['workload', 'recovery']) printContaminated(label);
