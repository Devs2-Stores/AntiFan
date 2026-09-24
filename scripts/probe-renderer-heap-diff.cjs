#!/usr/bin/env node
'use strict';
/**
 * AntiFan UI-renderer retained-growth probe: which constructor grows, and by how much.
 *
 * The retention probe (`probe-renderer-retention-class.cjs`) proves a slope exists and
 * which process holds it, but not *what* is held. The allocation sampler names who
 * allocates, which is a different question: transient allocation dominates it, and a
 * leak is what survives a collection. This probe takes two heap snapshots of the app-UI
 * isolate, forcibly collects before each, and diffs node counts and self sizes by
 * constructor name. The delta is therefore *retained* growth in the same currency as the
 * floor slope (MB/min), which is what a fix has to remove.
 *
 * Usage:
 *   node scripts/probe-renderer-heap-diff.cjs --gap 180 --top 24
 *   node scripts/probe-renderer-heap-diff.cjs --gap 180 --json heap-diff-leg3.json
 *
 * The three app-UI documents (standalone.html, toolbar.html, frame-backdrop.html) share
 * one renderer isolate: toolbar and backdrop are iframes of standalone, so any one of
 * them addresses the whole UI heap. The probe profiles exactly one target for that
 * reason - sampling three was three overlapping sessions on the same isolate.
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const rootDir = path.resolve(__dirname, '..');
const DefaultProfile = process.env.ANTIFAN_SOAK_PROFILE || 'E:/Work/.antifan-soak-8h/Profile';
const UI_DOCUMENTS = ['standalone.html', 'toolbar.html', 'frame-backdrop.html'];

function parseArgs(argv) {
  const args = { gap: 180, top: 24, json: null };
  const value = (raw) => (raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : argv[argv.indexOf(raw) + 1]);
  for (const raw of argv) {
    if (raw.startsWith('--profile')) args.profile = value(raw);
    else if (raw.startsWith('--port')) args.port = Number(value(raw));
    else if (raw.startsWith('--gap')) args.gap = Math.max(5, Number(value(raw)));
    else if (raw.startsWith('--top')) args.top = Math.max(1, Number(value(raw)));
    else if (raw.startsWith('--json')) args.json = value(raw);
    else if (raw === '--include-all-targets') args.includeAll = true;
    else if (!/^\d+$/.test(raw) && !argv[argv.indexOf(raw) - 1]?.startsWith('--')) throw new Error(`unknown argument: ${raw}`);
  }
  return args;
}

function resolvePort(args) {
  if (Number.isFinite(args.port)) return Promise.resolve(args.port);
  // Same default and same env override as the other renderer probes, so one profile
  // path never means "works for the allocation sampler, fails for the heap diff".
  const profile = args.profile || DefaultProfile;
  const file = path.join(profile, 'DevToolsActivePort');
  if (!fs.existsSync(file)) {
    return Promise.reject(
      new Error(
        `no DevToolsActivePort in ${profile}. The app must be launched with --remote-debugging-port=0 ` +
          '(soak harness: SOAK_APP_ARGS="--remote-debugging-port=0").',
      ),
    );
  }
  const port = Number(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0]);
  if (!Number.isFinite(port) || port <= 0) return Promise.reject(new Error(`${file} does not name a port`));
  return Promise.resolve(port);
}

function connect(url, openTimeoutMs = 5000) {
  const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
  const pending = new Map();
  const listeners = new Map();
  let nextId = 1;
  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id === undefined) {
      const cb = listeners.get(msg.method);
      if (cb) cb(msg.params);
      return;
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(msg.error.message || 'cdp error'));
    else entry.resolve(msg.result);
  });
  const send = (method, params = {}, timeoutMs = 60000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ws open timed out after ${openTimeoutMs} ms`)), openTimeoutMs);
    timer.unref?.();
    socket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return {
    send,
    opened,
    on: (method, cb) => listeners.set(method, cb),
    close: () => {
      try {
        socket.terminate();
      } catch {
        /* already gone */
      }
    },
  };
}

async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list answered ${res.status}`);
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'));
}

/** One heap snapshot, collected first so the comparison is of retained bytes. */
async function snapshot(cdp, label) {
  await cdp.send('HeapProfiler.collectGarbage', {}, 60000).catch(() => {});
  const chunks = [];
  let bytes = 0;
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (params) => {
    if (params && typeof params.chunk === 'string') {
      chunks.push(params.chunk);
      bytes += params.chunk.length;
    }
  });
  const started = Date.now();
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, treatGlobalObjectsAsRoots: false }, 240000);
  const text = chunks.join('');
  if (!text) throw new Error(`${label}: snapshot produced no chunks`);
  const parsed = JSON.parse(text);
  return { parsed, elapsedMs: Date.now() - started, chunkBytes: bytes };
}

/** Count and self size per constructor name. No edge walk: the question is what grew. */
function aggregateByName(snapshotJson, limit) {
  const meta = snapshotJson.snapshot.meta;
  const nodeFields = meta.node_fields;
  const stride = nodeFields.length;
  const iType = nodeFields.indexOf('type');
  const iName = nodeFields.indexOf('name');
  const iSelf = nodeFields.indexOf('self_size');
  const nodes = snapshotJson.nodes;
  const strings = snapshotJson.strings;
  const nodeCount = snapshotJson.snapshot.node_count;
  const types = meta.node_types[iType];
  const byName = new Map();
  let totalBytes = 0;
  for (let i = 0; i < nodeCount; i++) {
    const base = i * stride;
    const type = types[nodes[base + iType]];
    const name = strings[nodes[base + iName]];
    const self = nodes[base + iSelf] || 0;
    totalBytes += self;
    const key = `${type} ${name}`.trim();
    const row = byName.get(key) || { name: key, count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += self;
    byName.set(key, row);
  }
  const rows = [...byName.values()].sort((a, b) => b.bytes - a.bytes).slice(0, limit);
  return { rows, totalBytes, nodeCount };
}

function diffByName(before, after, top) {
  const b = new Map(before.map((r) => [r.name, r]));
  const a = new Map(after.map((r) => [r.name, r]));
  const names = new Set([...b.keys(), ...a.keys()]);
  const rows = [];
  for (const name of names) {
    const x = b.get(name) || { count: 0, bytes: 0 };
    const y = a.get(name) || { count: 0, bytes: 0 };
    const dBytes = y.bytes - x.bytes;
    const dCount = y.count - x.count;
    if (dBytes === 0 && dCount === 0) continue;
    rows.push({ name, dBytes, dCount, beforeBytes: x.bytes, afterBytes: y.bytes, beforeCount: x.count, afterCount: y.count });
  }
  const byBytes = [...rows].sort((p, q) => q.dBytes - p.dBytes).slice(0, top);
  const byCount = [...rows].sort((p, q) => q.dCount - p.dCount).slice(0, top);
  return { byBytes, byCount, growthBytes: rows.reduce((s, r) => s + Math.max(0, r.dBytes), 0) };
}

const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = await resolvePort(args);
  const targets = await listTargets(port);
  const selected = args.includeAll ? targets : targets.filter((t) => UI_DOCUMENTS.some((doc) => String(t.url).includes(doc)));
  if (selected.length === 0) throw new Error(`no app-UI document target on port ${port}; saw: ${targets.map((t) => t.url).join(', ')}`);
  const target = selected[0];
  console.log(`# heap diff — port ${port}, ${target.url}, gap ${args.gap}s`);

  const cdp = connect(target.webSocketDebuggerUrl);
  const report = { port, url: target.url, gapSeconds: args.gap, at: new Date().toISOString() };
  try {
    await cdp.opened;
    await cdp.send('HeapProfiler.enable').catch(() => {});
    const first = await snapshot(cdp, 'baseline');
    const baseline = aggregateByName(first.parsed, args.top);
    first.parsed = null;
    console.log(`   baseline: ${kb(baseline.totalBytes)} KB over ${baseline.nodeCount} nodes (snapshot in ${Math.round(first.elapsedMs / 1000)}s)`);
    console.log(`   waiting ${args.gap}s...`);
    await new Promise((resolve) => setTimeout(resolve, args.gap * 1000));

    const second = await snapshot(cdp, 'after');
    const afterAgg = aggregateByName(second.parsed, args.top);
    second.parsed = null;
    const diff = diffByName(baseline.rows, afterAgg.rows, args.top);

    console.log(`   after:    ${kb(afterAgg.totalBytes)} KB over ${afterAgg.nodeCount} nodes (snapshot in ${Math.round(second.elapsedMs / 1000)}s)`);
    const retainedPerMin = Math.round(((afterAgg.totalBytes - baseline.totalBytes) / (1024 * 1024) / args.gap) * 60 * 1000) / 1000;
    console.log(`   retained delta: ${kb(afterAgg.totalBytes - baseline.totalBytes)} KB over ${args.gap}s = ${retainedPerMin} MB/min`);
    console.log(`\n## grew by bytes`);
    for (const row of diff.byBytes) {
      console.log(`   ${String(kb(row.dBytes)).padStart(9)} KB  ${String(row.dCount).padStart(7)} obj  ${row.name}`);
    }
    console.log(`\n## grew by object count`);
    for (const row of diff.byCount) {
      console.log(`   ${String(kb(row.dBytes)).padStart(9)} KB  ${String(row.dCount).padStart(7)} obj  ${row.name}`);
    }
    report.retainedDeltaBytes = afterAgg.totalBytes - baseline.totalBytes;
    report.retainedPerMin = retainedPerMin;
    report.baseline = { totalBytes: baseline.totalBytes, nodeCount: baseline.nodeCount, top: baseline.rows };
    report.after = { totalBytes: afterAgg.totalBytes, nodeCount: afterAgg.nodeCount, top: afterAgg.rows };
    report.grewByBytes = diff.byBytes;
    report.grewByCount = diff.byCount;
  } finally {
    cdp.close();
  }
  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
    console.log(`\n   json: ${args.json}`);
  }
}

/**
 * Parser self-check: the whole diagnosis reads constructor names out of a packed int
 * array by field index, so a wrong offset would produce confident nonsense (names from
 * the string table's wrong slot, byte totals off by the record stride). This runs the
 * aggregation and the diff over a synthetic snapshot with known totals - no app, no CDP.
 */
function runSelfCheck() {
  const meta = {
    node_fields: ['type', 'name', 'id', 'self_size', 'edge_count'],
    node_types: [['hidden', 'object', 'string'], ['', 'A', 'B'], ['', '', '']],
    edge_fields: [],
    edge_types: [[], []],
  };
  const mk = (rows) => ({ snapshot: { meta, node_count: rows.length }, nodes: rows.flat(), edges: [], strings: ['', 'Foo', 'Bar'] });
  const before = mk([
    [1, 1, 1, 100, 0],
    [1, 2, 2, 200, 0],
    [2, 1, 3, 50, 0],
  ]);
  const after = mk([
    [1, 1, 1, 100, 0],
    [1, 2, 2, 200, 0],
    [2, 1, 3, 50, 0],
    [1, 1, 4, 300, 0],
    [1, 1, 5, 300, 0],
  ]);
  const a = aggregateByName(before, 10);
  const b = aggregateByName(after, 10);
  const diff = diffByName(a.rows, b.rows, 10);
  const top = diff.byBytes[0] || {};
  const ok =
    a.totalBytes === 350 && a.nodeCount === 3 && b.totalBytes === 950 && b.nodeCount === 5 && top.name === 'object Foo' && top.dBytes === 600 && top.dCount === 2;
  console.log(
    `selfcheck: ${ok ? 'PASS' : 'FAIL'} (before ${a.totalBytes}B/${a.nodeCount}n, after ${b.totalBytes}B/${b.nodeCount}n, top "${top.name}" +${top.dBytes}B +${top.dCount} obj)`,
  );
  if (!ok) process.exit(1);
}

if (process.argv.includes('--selfcheck')) {
  runSelfCheck();
  process.exit(0);
}

main().catch((err) => {
  console.error(`[heap-diff] ${err.message}`);
  process.exit(1);
});
