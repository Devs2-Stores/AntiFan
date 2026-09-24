#!/usr/bin/env node
'use strict';
/**
 * Retention-probe log analyzer.
 *
 * `scripts/probe-renderer-retention-class.cjs` prints one line per sample carrying the three
 * counters that decide its classification (DOM nodes, JS event listeners, JS heap) and writes
 * a JSON report that carries **only** its own summary — the per-sample series is not in the
 * artifact, so a reader cannot re-slice it after the fact. The probe's stdout is the series;
 * this reads it back.
 *
 * Why a second instrument: the probe's classifier compares the first and last counter of a
 * window. On the soak that is too weak in one specific way — a process's node count steps by
 * thousands when the app injects or removes UI (measured: an app document read 5617 nodes at
 * 01:44 and 4084 at 01:47, while the fixture renderer went 1470 -> 3918 in the same minutes),
 * so first-vs-last on a single sample at either end reports a structural step as a trend. This
 * fits every sample in the window instead: raw least-squares slope, the rolling-minimum floor,
 * and the monotone fraction, per phase and per named group.
 *
 * Usage:
 *   node scripts/analyze-retention-probe-log.cjs <output.log> [--start=HH:MM:SS]
 *        [--schedule=30,60,60,60,30] [--floor=10] [--json]
 */
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const logArg = argv.find((a) => !a.startsWith('--'));
const startArg = (argv.find((a) => a.startsWith('--start=')) || '').split('=')[1] || '01:41:29';
const scheduleArg = (argv.find((a) => a.startsWith('--schedule=')) || '').split('=')[1] || '30,60,60,60,30';
const floorArg = Number((argv.find((a) => a.startsWith('--floor=')) || '').split('=')[1] || 10);
const asJson = argv.includes('--json');

if (!logArg) {
  console.error('usage: node scripts/analyze-retention-probe-log.cjs <output.log> [--start=HH:MM:SS] [--schedule=30,60,60,60,30] [--floor=10] [--json]');
  process.exit(2);
}

const LINE_RE = /^\[retention-class\] (\d{2}:\d{2}:\d{2}) n=(\d+) (.*)$/;
const ROW_RE = /^(.*?): nodes=(-|\d+) listeners=(-|\d+) heap=(-|\d+(?:\.\d+)?)MB?$/;
// Group key: the fixture page's title embeds a tick counter (`Fixture [529] /store-home`), so the
// counter is stripped and the path kept — otherwise every sample would open a new group.
const groupKey = (title) => title.replace(/^Fixture \[\d+\] /, 'Fixture ');

const schedule = scheduleArg.split(',').map(Number);
const phaseNames = ['warmup', ...schedule.slice(1, -1).map((m, i) => `leg${i + 1}:${m}m`), 'recovery'];
const phaseEdges = [];
{
  const [hh, mm, ss] = startArg.split(':').map(Number);
  let cursor = new Date();
  cursor.setHours(hh, mm, ss, 0);
  for (let i = 0; i < schedule.length; i++) {
    phaseEdges.push({ name: phaseNames[i] ?? `phase${i + 1}`, from: cursor.getTime(), to: cursor.getTime() + schedule[i] * 60000 });
    cursor = new Date(cursor.getTime() + schedule[i] * 60000);
  }
}
const phaseOf = (at) => (phaseEdges.find((p) => at >= p.from && at < p.to) || { name: 'after' }).name;

/** The daemon captures the probe's stdout through a 120-column terminal, so a sample line
 *  longer than the line width is broken with `\r\n ESC[<row>;120H`, and the character that
 *  occupied column 120 is re-emitted after the escape (`heap=\r\n ESC[39;120H=11.43MB`).
 *  Dropping exactly one character after each cursor-position escape reconstructs the line;
 *  a bare newline before a continuation has no re-emission and is simply joined. */
function unwrapCapture(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\r') continue;
    if (c === '\u001b') {
      const esc = /^\u001b\[[0-9;]*[A-Za-z]/.exec(raw.slice(i));
      if (esc) {
        i += esc[0].length - 1;
        if (esc[0].endsWith('H')) i += 1; // the re-emitted column-120 character
        continue;
      }
    }
    if (c === '\n' && !raw.startsWith('[retention-class]', i + 1)) continue; // wrapped continuation
    out += c;
  }
  return out;
}
const lines = unwrapCapture(fs.readFileSync(path.resolve(logArg), 'utf8')).split('\n');
const samples = [];
const shortSamples = [];
for (const line of lines) {
  const m = LINE_RE.exec(line);
  if (!m) continue;
  const [, stamp, count, body] = m;
  const [hh, mm, ss] = stamp.split(':').map(Number);
  const at = new Date();
  at.setHours(hh, mm, ss, 0);
  const rows = [];
  for (const chunk of body.split(' | ')) {
    const r = ROW_RE.exec(chunk.trim());
    if (!r) continue;
    const [, rawTitle, nodes, listeners, heap] = r;
    rows.push({
      group: groupKey(rawTitle.trim()),
      nodes: nodes === '-' ? null : Number(nodes),
      listeners: listeners === '-' ? null : Number(listeners),
      heapMB: heap === '-' ? null : Number(heap),
    });
  }
  if (rows.length !== Number(count)) shortSamples.push(`${stamp} ${rows.length}/${count}`);
  samples.push({ at: at.getTime(), stamp, declared: Number(count), rows });
}

/** Least-squares slope in units/minute over rows that carry the counter. */
function fit(points, key) {
  const pts = points.filter((p) => Number.isFinite(p[key]));
  if (pts.length < 2) return { n: pts.length, slope: null, first: null, last: null, delta: null, floor: null, floorSlope: null, monotone: null, min: null, max: null };
  const t0 = pts[0].at;
  const xs = pts.map((p) => (p.at - t0) / 60000);
  const ys = pts.map((p) => p[key]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  // Rolling-minimum floor: the value the series returns to after each collection. A retention
  // defect moves the floor; allocation churn under a fixed high-water does not.
  const window = Math.min(floorArg, Math.max(2, Math.floor(pts.length / 3)));
  const floored = pts.map((p, i) => ({ at: p.at, floor: Math.min(...pts.slice(Math.max(0, i - window + 1), i + 1).map((q) => q[key])) }));
  const floorFit = fitRaw(floored, 'floor');
  let ups = 0;
  for (let i = 1; i < ys.length; i++) if (ys[i] >= ys[i - 1]) ups++;
  return {
    n: pts.length,
    slope: round(slope),
    first: round(ys[0]),
    last: round(ys[ys.length - 1]),
    delta: round(ys[ys.length - 1] - ys[0]),
    min: round(Math.min(...ys)),
    max: round(Math.max(...ys)),
    floor: round(floored[floored.length - 1].floor),
    floorSlope: round(floorFit),
    monotone: round(ups / (ys.length - 1)),
  };
}
function fitRaw(pts, key) {
  if (pts.length < 2) return null;
  const t0 = pts[0].at;
  const xs = pts.map((p) => (p.at - t0) / 60000);
  const ys = pts.map((p) => p[key]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return den === 0 ? 0 : num / den;
}
const round = (v) => (v === null || !Number.isFinite(v) ? null : Number(v.toFixed(3)));

const groups = [...new Set(samples.flatMap((s) => s.rows.map((r) => r.group)))].sort();
const perPhase = new Map();
for (const s of samples) {
  const phase = phaseOf(s.at);
  for (const r of s.rows) {
    if (!perPhase.has(phase)) perPhase.set(phase, new Map());
    const byGroup = perPhase.get(phase);
    if (!byGroup.has(r.group)) byGroup.set(r.group, []);
    byGroup.get(r.group).push({ at: s.at, nodes: r.nodes, listeners: r.listeners, heapMB: r.heapMB });
  }
}

const report = { log: path.resolve(logArg), start: startArg, schedule, sampleCount: samples.length, first: samples[0]?.stamp ?? null, last: samples[samples.length - 1]?.stamp ?? null, groups: {} };
for (const group of groups) {
  const all = samples.flatMap((s) => s.rows.filter((r) => r.group === group).map((r) => ({ at: s.at, nodes: r.nodes, listeners: r.listeners, heapMB: r.heapMB })));
  const entry = {
    overall: { nodes: fit(all, 'nodes'), listeners: fit(all, 'listeners'), heapMB: fit(all, 'heapMB') },
    byPhase: {},
  };
  for (const [phase, byGroup] of perPhase) {
    const rows = byGroup.get(group);
    if (!rows) continue;
    entry.byPhase[phase] = { nodes: fit(rows, 'nodes'), listeners: fit(rows, 'listeners'), heapMB: fit(rows, 'heapMB') };
  }
  report.groups[group] = entry;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`# retention probe log — ${report.sampleCount} samples, ${report.first} .. ${report.last}`);
  if (shortSamples.length) console.log(`# WARNING: ${shortSamples.length} sample(s) parsed fewer rows than declared: ${shortSamples.join(', ')}`);
  console.log(`# phase edges: ${phaseEdges.map((p) => `${p.name} ${new Date(p.from).toTimeString().slice(0, 5)}`).join(' | ')}`);
  for (const [group, entry] of Object.entries(report.groups)) {
    console.log(`\n## ${group}`);
    console.log(`   overall  nodes ${entry.overall.nodes.first}->${entry.overall.nodes.last} (${entry.overall.nodes.slope}/min, floor ${entry.overall.nodes.floor} ${entry.overall.nodes.floorSlope}/min, mono ${entry.overall.nodes.monotone})  listeners ${entry.overall.listeners.first}->${entry.overall.listeners.last} (${entry.overall.listeners.slope}/min, floor ${entry.overall.listeners.floorSlope}/min)  heap ${entry.overall.heapMB.first}->${entry.overall.heapMB.last} MB (${entry.overall.heapMB.slope}/min, floor ${entry.overall.heapMB.floor} ${entry.overall.heapMB.floorSlope}/min, mono ${entry.overall.heapMB.monotone})`);
    for (const [phase, p] of Object.entries(entry.byPhase)) {
      console.log(`   ${phase.padEnd(8)} n=${String(p.heapMB.n).padEnd(3)} heap ${p.heapMB.first}->${p.heapMB.last} (${p.heapMB.slope}/min, floor ${p.heapMB.floorSlope}/min, mono ${p.heapMB.monotone})  nodes ${p.nodes.first}->${p.nodes.last} (${p.nodes.slope}/min, floor ${p.nodes.floorSlope}/min)  listeners ${p.listeners.first}->${p.listeners.last} (${p.listeners.slope}/min)`);
    }
  }
}
