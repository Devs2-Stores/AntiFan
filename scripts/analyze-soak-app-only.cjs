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
  })}`);
}

for (const label of ['warmup', 'workload', 'recovery']) printWindow(label);
for (const label of ['warmup', 'workload', 'recovery']) printEnvelope(label);
for (const label of ['workload']) printPerPidFloor(label, 'privateBytesMB');
for (const label of ['workload']) printPerPidFloor(label, 'workingSetMB');
printRecoveryRelease();
for (const label of ['workload', 'recovery']) printContaminated(label);
