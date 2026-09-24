#!/usr/bin/env node
'use strict';
/**
 * AntiFan UI-renderer DOM-diff probe (read-only): *which* node appears and stops appearing.
 *
 * The retention probe (`probe-renderer-retention-class.cjs`) classifies the growth — `nodes`
 * climbing 1/min with flat listeners and a flat JS heap — and the heap diff names retained V8
 * constructors. Neither names the element. A count cannot: "3756 -> 3759" says a node was
 * appended and nothing about which one, and the code has ~95 append sites across the three
 * app-UI documents. This probe takes two `DOMSnapshot` samples of the app-UI renderer, `gap`
 * seconds apart, and diffs them as multisets keyed by tag + id + classes + attributes, so what
 * it reports is the *added element* rather than a changed count. Each reported key carries one
 * live instance's ancestor chain, which is what a reader greps the source for.
 *
 * Multiset, not positional, on purpose: an insert near the top of a list shifts every following
 * sibling's index, so a positional diff reports the whole tail as changed and the one real
 * addition disappears inside it. Counting signatures per key is invariant to reordering, and a
 * reorder therefore correctly reports nothing.
 *
 * `DOMSnapshot.captureSnapshot` rather than `DOM.getDocument({depth:-1, pierce:true})`: it
 * returns flat index arrays instead of a nested JSON tree, and it lists each frame as its own
 * `documents[]` entry, so an addition is attributed to the terminal, toolbar or backdrop
 * document instead of to the process that hosts all three.
 *
 * Two report shapes, because they fail differently. Signature rows name the element. The
 * tag-level *net* table survives attribute churn: a class that flips every minute shows net 0
 * there while a genuinely appended element shows +1/min, so a leak cannot hide inside a
 * signature whose other attributes change.
 *
 * Usage:
 *   node scripts/probe-renderer-dom-diff.cjs --gap 180 --top 20
 *   node scripts/probe-renderer-dom-diff.cjs --port=9222 --gap 60 --json dom-diff.json
 *   node scripts/probe-renderer-dom-diff.cjs --self-test
 *
 * The app must be running with `--remote-debugging-port=0` (the soak harness passes
 * `SOAK_APP_ARGS` through for exactly this), so the profile holds a `DevToolsActivePort` file.
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const DEFAULT_PROFILE = process.env.ANTIFAN_SOAK_PROFILE || 'E:/Work/.antifan-soak-8h/Profile';
// One target addresses the whole UI isolate: the three documents share an origin and a process.
const UI_DOCUMENTS = ['standalone.html', 'toolbar.html', 'frame-backdrop.html'];
// Attributes that make a node's identity, in the order a reader wants them. `style` is included
// because an injected overlay is often only distinguishable by it.
const IDENTITY_ATTRIBUTES = ['id', 'class', 'role', 'aria-label', 'data-testid', 'style'];

function parseArgs(argv) {
  const args = { gap: 180, samples: 3, json: null, selfTest: false };
  const value = (raw) => (raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : argv[argv.indexOf(raw) + 1]);
  for (const raw of argv) {
    if (raw.startsWith('--profile')) args.profile = value(raw);
    else if (raw.startsWith('--port')) args.port = Number(value(raw));
    else if (raw.startsWith('--gap')) args.gap = Math.max(5, Number(value(raw)));
    else if (raw.startsWith('--samples')) args.samples = Math.max(2, Number(value(raw)));
    else if (raw.startsWith('--json')) args.json = value(raw);
    else if (raw === '--self-test') args.selfTest = true;
    else if (raw === '--include-all-targets') args.includeAll = true;
    else if (!/^\d+$/.test(raw) && !argv[argv.indexOf(raw) - 1]?.startsWith('--')) throw new Error(`unknown argument: ${raw}`);
  }
  return args;
}

function resolvePort(args) {
  if (Number.isFinite(args.port)) return Promise.resolve(args.port);
  const profile = args.profile || DEFAULT_PROFILE;
  const file = path.join(profile, 'DevToolsActivePort');
  if (!fs.existsSync(file)) {
    return Promise.reject(
      new Error(
        `no DevToolsActivePort in ${profile}. The app must be launched with --remote-debugging-port=0 ` +
          `(SOAK_APP_ARGS='--remote-debugging-port=0'), or pass --port.`
      )
    );
  }
  return Promise.resolve(Number(fs.readFileSync(file, 'utf8').split('\n')[0].trim()));
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function pickUiTargets(port, includeAll) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  const ui = pages.filter((t) => UI_DOCUMENTS.some((doc) => (t.url || '').includes(doc)));
  if (ui.length) return ui;
  if (includeAll && pages.length) return pages;
  throw new Error(`no app-UI target among ${pages.length} page targets (${pages.map((t) => t.url).join(', ')})`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = null;
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
        else resolve(msg.result);
      }
    });
    // A probe that waits forever on a renderer that reloaded mid-snapshot reads exactly like a
    // document with nothing wrong with it, so the socket closing has to fail the call in flight.
    const fail = (reason) => {
      this.closed = reason;
      for (const [, { reject, timer }] of this.pending) {
        clearTimeout(timer);
        reject(new Error(reason));
      }
      this.pending.clear();
    };
    ws.on('close', () => fail('devtools socket closed'));
    ws.on('error', (err) => fail(`devtools socket error: ${err.message}`));
  }

  static async attach(webSocketDebuggerUrl) {
    const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('devtools socket did not open within 15s')), 15000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error(this.closed));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} did not answer within ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// --- snapshot flattening & diffing ---------------------------------------------------------

/**
 * Flatten a `DOMSnapshot.captureSnapshot` result into node records.
 *
 * Text nodes are included, and that is the point: the process-level `nodes` counter climbs
 * ~1/min while the *element* set stays flat, so whatever is appended is either a text node or a
 * new container around one. Their value is part of the key, which makes a rewritten text node
 * (the app rewrites tab titles at 5 Hz) appear as one addition *and* one removal — and the
 * per-parent table below is what cancels that churn back to zero while a node that is appended
 * and never removed still counts.
 */
function flattenSnapshot(snapshot) {
  const strings = snapshot.strings || [];
  const records = [];
  (snapshot.documents || []).forEach((doc, docIndex) => {
    const nodes = doc.nodes || {};
    const parentIndex = nodes.parentIndex || [];
    const nodeType = nodes.nodeType || [];
    const nodeName = nodes.nodeName || [];
    const nodeValue = nodes.nodeValue || [];
    const attributes = nodes.attributes || [];
    const docUrl = doc.documentURL || `document#${docIndex}`;
    const docLabel = String(docUrl).split('/').pop() || docUrl;
    const paths = new Array(parentIndex.length);
    const siblingCounter = new Map();
    for (let i = 0; i < parentIndex.length; i++) {
      const parent = parentIndex[i];
      const isElement = nodeType[i] === 1;
      const isText = nodeType[i] === 3;
      if (!isElement && !isText) continue;
      const tag = isElement ? String(strings[nodeName[i]] || '').toLowerCase() : '#text';
      const ordinal = siblingCounter.get(parent) || 0;
      siblingCounter.set(parent, ordinal + 1);
      const parentPath = parent === -1 || parent === undefined ? docLabel : paths[parent] || docLabel;
      paths[i] = `${parentPath}/${tag}[${ordinal}]`;
      if (isText) {
        const value = String(strings[nodeValue[i]] ?? '').slice(0, 48);
        if (!value) continue;
        records.push({ key: `#text@${parentPath}=${value}`, tag: '#text', document: docLabel, path: paths[i], parentPath, attrs: {} });
        continue;
      }
      const attrs = {};
      const raw = attributes[i] || [];
      for (let a = 0; a + 1 < raw.length; a += 2) {
        const name = strings[raw[a]];
        if (IDENTITY_ATTRIBUTES.includes(name)) attrs[name] = strings[raw[a + 1]] ?? '';
      }
      records.push({
        key: [tag, ...IDENTITY_ATTRIBUTES.map((a) => `${a}=${attrs[a] ?? ''}`)].join('|'),
        tag,
        document: docLabel,
        path: paths[i],
        parentPath,
        attrs,
      });
    }
  });
  return records;
}

/** Count each signature key, so reordering is invisible and a real addition stands out. */
function countKeys(records) {
  const counts = new Map();
  for (const r of records) counts.set(r.key, (counts.get(r.key) || 0) + 1);
  return counts;
}

function countTags(records) {
  const counts = new Map();
  for (const r of records) counts.set(r.tag, (counts.get(r.tag) || 0) + 1);
  return counts;
}

function diffCounts(beforeCounts, afterCounts) {
  const added = [];
  const removed = [];
  for (const [key, count] of afterCounts) {
    const delta = count - (beforeCounts.get(key) || 0);
    if (delta > 0) added.push({ key, count: delta });
  }
  for (const [key, count] of beforeCounts) {
    const delta = count - (afterCounts.get(key) || 0);
    if (delta > 0) removed.push({ key, count: delta });
  }
  const byCount = (a, b) => b.count - a.count;
  return { added: added.sort(byCount), removed: removed.sort(byCount) };
}

function diffSnapshots(before, after) {
  const signatures = diffCounts(countKeys(before.records), countKeys(after.records));
  const tags = diffCounts(countTags(before.records), countTags(after.records));
  return {
    totals: {
      nodesBefore: before.records.length,
      nodesAfter: after.records.length,
      delta: after.records.length - before.records.length,
    },
    bySignature: signatures,
    // Net per tag: attribute churn cancels here, an appended element does not.
    byTag: tags.added.map((entry) => {
      const removed = tags.removed.find((r) => r.key === entry.key);
      return { tag: entry.key, added: entry.count, removed: removed ? removed.count : 0, net: entry.count - (removed ? removed.count : 0) };
    }).filter((entry) => entry.net !== 0).sort((a, b) => b.net - a.net),
  };
}

/** One live instance of an added key, with the ancestor chain a reader can grep for. */
function instancesOf(records, key) {
  return records.filter((r) => r.key === key);
}

function ancestorChain(record) {
  // Path segments are already `tag[ordinal]`; the chain is what the reader searches the source for.
  return record.path.split('/').filter(Boolean).join(' > ');
}

/**
 * `Memory.getDOMCounters` is process-wide — all three UI documents share one renderer process,
 * so the counters are identical whichever document target they are read through and cannot
 * attribute growth to a document. `DOMSnapshot` walks one target's whole frame tree instead, so
 * the element diff below is the half that localizes an addition, while the counters are the
 * half that is independent of our own sampling.
 */
async function snapshot(cdp, at = Date.now()) {
  const snap = await cdp.send(
    'DOMSnapshot.captureSnapshot',
    { computedStyles: [], includePaintOrder: false, includeDOMRects: false, includeBlendedBackgroundColors: false, includeTextColorOpacities: false },
    60000
  );
  const records = flattenSnapshot(snap);
  const counters = await cdp.send('Memory.getDOMCounters', {}, 20000);
  const documents = new Map();
  for (const record of records) documents.set(record.document, (documents.get(record.document) || 0) + 1);
  return { records, counters, documents, at };
}

/**
 * One diff can show an addition; only a signature that appears in *consecutive* intervals is an
 * appender. Each interval's net is accumulated per signature and per tag, so an attribute that
 * toggles cancels to zero while a steady +1 element/min piles up where a reader can see it.
 */
function aggregateSeries(samples) {
  const totalMinutes = Math.max((samples[samples.length - 1].at - samples[0].at) / 60000, 1e-6);
  const signatures = new Map();
  const tags = new Map();
  const documents = new Map();
  const parents = new Map();
  const bump = (map, key, net) => {
    const entry = map.get(key) || { key, net: 0, intervals: 0 };
    entry.net += net;
    if (net !== 0) entry.intervals += 1;
    map.set(key, entry);
  };
  // Which container a signature belongs to: the first instance in the sample, which for a
  // repeated append is the container that keeps gaining one.
  const parentOf = (sample) => {
    if (!sample.parentIndex) {
      const index = new Map();
      for (const record of sample.records) if (!index.has(record.key)) index.set(record.key, record.parentPath);
      sample.parentIndex = index;
    }
    return sample.parentIndex;
  };
  for (let i = 1; i < samples.length; i++) {
    const before = samples[i - 1];
    const after = samples[i];
    const minutes = Math.max((after.at - before.at) / 60000, 1e-6);
    const diff = diffSnapshots(before, after);
    const parentsAfter = parentOf(after);
    const parentsBefore = parentOf(before);
    for (const entry of diff.bySignature.added) {
      bump(signatures, entry.key, entry.count);
      bump(parents, parentsAfter.get(entry.key) || '(unattributed)', entry.count);
    }
    for (const entry of diff.bySignature.removed) {
      bump(signatures, entry.key, -entry.count);
      bump(parents, parentsBefore.get(entry.key) || '(unattributed)', -entry.count);
    }
    for (const entry of diff.byTag) bump(tags, entry.tag, entry.net);
    for (const [label, count] of after.documents) {
      const beforeCount = before.documents.get(label) || 0;
      // Cumulative, not per-interval: a document's net is what the reader compares against its
      // starting count, and the interval count says how many intervals actually moved it.
      const entry = documents.get(label) || { label, first: beforeCount, last: beforeCount, net: 0, intervals: 0 };
      if (count !== beforeCount) entry.intervals += 1;
      entry.last = count;
      entry.net = entry.last - entry.first;
      documents.set(label, entry);
    }
  }
  const last = samples[samples.length - 1];
  const first = samples[0];
  const shape = (entry, withExample) => {
    const instance = withExample ? instancesOf(last.records, entry.key)[0] : null;
    return {
      key: entry.key,
      net: entry.net,
      intervals: entry.intervals,
      perMinute: Number((entry.net / totalMinutes).toFixed(3)),
      repeated: entry.intervals >= 2,
      example: instance ? { document: instance.document, chain: ancestorChain(instance), attributes: instance.attrs } : null,
    };
  };
  const counts = (sample) => {
    let elements = 0;
    for (const record of sample.records) if (record.tag !== '#text') elements += 1;
    return { elements, nodes: sample.records.length };
  };
  const countsFirst = counts(first);
  const countsLast = counts(last);
  const sortNet = (a, b) => b.net - a.net;
  return {
    totalMinutes: Number(totalMinutes.toFixed(2)),
    counters: {
      first: first.counters,
      last: last.counters,
      nodesPerMinute: Number(((last.counters.nodes - first.counters.nodes) / totalMinutes).toFixed(2)),
      listenersPerMinute: Number(((last.counters.jsEventListeners - first.counters.jsEventListeners) / totalMinutes).toFixed(2)),
    },
    elements: {
      first: countsFirst.elements,
      last: countsLast.elements,
      delta: countsLast.elements - countsFirst.elements,
      perMinute: Number(((countsLast.elements - countsFirst.elements) / totalMinutes).toFixed(3)),
    },
    nodes: {
      first: countsFirst.nodes,
      last: countsLast.nodes,
      delta: countsLast.nodes - countsFirst.nodes,
      perMinute: Number(((countsLast.nodes - countsFirst.nodes) / totalMinutes).toFixed(3)),
    },
    documents: [...documents.values()].sort(sortNet),
    appenders: [...signatures.values()].filter((entry) => entry.net > 0).map((entry) => shape(entry, true)).sort(sortNet),
    shrunk: [...signatures.values()].filter((entry) => entry.net < 0).map((entry) => shape(entry, false)).sort(sortNet),
    byTag: [...tags.values()].filter((entry) => entry.net !== 0).map((entry) => shape(entry, false)).sort(sortNet),
    byParent: [...parents.values()].filter((entry) => entry.net !== 0).map((entry) => shape(entry, false)).sort(sortNet),
  };
}

// --- self-test -----------------------------------------------------------------------------
// The differ is the instrument's whole value, and a differ that silently reports nothing on a
// real addition reads exactly like "no leak". These fixtures pin both directions plus the three
// ways a node-set diff lies: reordering must report nothing, a duplicate must report a count of
// one rather than being collapsed by a set comparison, and a toggled attribute must cancel in
// the tag-level net table instead of reading as an appended element.
function runSelfTest() {
  // Minimal DOMSnapshot shape: strings are shared, node arrays are parallel and index into them.
  const build = (tree) => {
    const strings = [];
    const si = (value) => {
      const existing = strings.indexOf(value);
      if (existing !== -1) return existing;
      strings.push(value);
      return strings.length - 1;
    };
    const nodes = { parentIndex: [], nodeType: [], nodeName: [], nodeValue: [], attributes: [] };
    const walk = (node, parent) => {
      const index = nodes.parentIndex.length;
      if (typeof node === 'string') {
        nodes.parentIndex.push(parent);
        nodes.nodeType.push(3);
        nodes.nodeName.push(si('#text'));
        nodes.nodeValue.push(si(node));
        nodes.attributes.push([]);
        return index;
      }
      nodes.parentIndex.push(parent);
      nodes.nodeType.push(1);
      nodes.nodeName.push(si(node.tag));
      nodes.nodeValue.push(si(''));
      const flat = [];
      for (const [name, value] of Object.entries(node.attrs || {})) flat.push(si(name), si(value));
      nodes.attributes.push(flat);
      for (const child of node.children || []) walk(child, index);
      return index;
    };
    for (const child of tree) walk(child, -1);
    return { strings, documents: [{ documentURL: 'file:///E:/x/standalone.html', nodes }] };
  };
  const recs = (tree) => ({ records: flattenSnapshot(build(tree)) });
  const el = (tag, attrs = {}, children = []) => ({ tag, attrs, children });

  const base = [el('div', { id: 'a' }), el('span', { class: 'x' }), el('span', { class: 'x' })];
  const before = recs(base);
  const afterAdd = recs([...base, el('i', { id: 'leak' })]);
  const afterReorder = recs([base[1], base[2], base[0]]);
  const afterDuplicate = recs([...base, el('span', { class: 'x' })]);
  const afterRemove = recs([base[0]]);
  const afterAttrFlip = recs([el('div', { id: 'a', class: 'on' }), base[1], base[2]]);

  const checks = [];
  const addDiff = diffSnapshots(before, afterAdd);
  checks.push(['detects an added element', addDiff.bySignature.added.length === 1 && addDiff.bySignature.added[0].key.startsWith('i|')]);
  checks.push(['reports the added count', addDiff.bySignature.added[0]?.count === 1]);
  checks.push(['nets the added element per tag', addDiff.byTag.some((t) => t.tag === 'i' && t.net === 1)]);
  const reorderDiff = diffSnapshots(before, afterReorder);
  checks.push(['ignores reordering', reorderDiff.bySignature.added.length === 0 && reorderDiff.bySignature.removed.length === 0]);
  const dupDiff = diffSnapshots(before, afterDuplicate);
  checks.push(['counts a duplicate rather than collapsing it', dupDiff.bySignature.added.length === 1 && dupDiff.bySignature.added[0].count === 1 && dupDiff.bySignature.added[0].key.includes('span')]);
  const removeDiff = diffSnapshots(before, afterRemove);
  // One signature, two nodes: the list carries signature deltas, not individual nodes.
  checks.push(['detects a removal', removeDiff.bySignature.removed.length === 1 && removeDiff.bySignature.removed[0].count === 2]);
  checks.push(['reports the node delta', addDiff.totals.delta === 1]);
  const flipDiff = diffSnapshots(before, afterAttrFlip);
  checks.push(['cancels a toggled attribute in the net table', flipDiff.bySignature.added.length === 1 && flipDiff.byTag.length === 0]);
  checks.push(['keeps the ancestor path', instancesOf(afterAdd.records, 'i|id=leak|class=|role=|aria-label=|data-testid=|style=')[0]?.path.includes('standalone.html/')]);
  checks.push(['names the owning document', afterAdd.records[0].document === 'standalone.html']);

  // The series is where the leak is actually decided: one diff reports an addition, an appender
  // is an addition that keeps happening, and only a per-interval net can tell a toggling
  // attribute (cancels in the tag table) from a growing one.
  const t0 = Date.parse('2026-09-21T06:00:00Z');
  const asSample = (tree, at, nodes) => {
    const records = flattenSnapshot(build(tree));
    const documents = new Map();
    for (const record of records) documents.set(record.document, (documents.get(record.document) || 0) + 1);
    return { records, counters: { nodes, jsEventListeners: 10, documents: 1 }, documents, at };
  };
  const leaky = el('i', { id: 'leak' });
  const s0 = asSample(base, t0, 100);
  const s1 = asSample([...base, leaky], t0 + 60000, 150);
  const s2 = asSample([...base, leaky, el('i', { id: 'leak' })], t0 + 120000, 200);
  const series = aggregateSeries([s0, s1, s2]);
  const onceOnly = aggregateSeries([s0, s1, s1]);
  checks.push([
    'aggregates an appender across intervals',
    series.appenders.length === 1 && series.appenders[0].net === 2 && series.appenders[0].repeated === true && series.appenders[0].perMinute === 1,
  ]);
  checks.push(['keeps a one-off addition out of the steady set', onceOnly.appenders.length === 1 && onceOnly.appenders[0].net === 1 && onceOnly.appenders[0].repeated === false]);
  checks.push(['aggregates the tag net', series.byTag.some((entry) => entry.key === 'i' && entry.net === 2)]);
  checks.push(['reports the process counter rate', series.counters.nodesPerMinute === 50]);
  checks.push(['reports per-document counts', series.documents.length === 1 && series.documents[0].label === 'standalone.html' && series.documents[0].net === 2 && series.documents[0].intervals === 2]);
  checks.push(['reports the element rate', series.elements.perMinute === 1 && series.elements.delta === 2]);

  // The counter that actually climbs in the soak is the *node* count while the element set is
  // flat, so the instrument has to see text nodes and still cancel the app's 5 Hz text rewrites.
  const textBase = [el('div', { id: 't' }, ['a'])];
  const textSeries = aggregateSeries([
    asSample(textBase, t0, 10),
    asSample([el('div', { id: 't' }, ['a', 'b'])], t0 + 60000, 10),
    asSample([el('div', { id: 't' }, ['a', 'b', 'c'])], t0 + 120000, 10),
  ]);
  const churnSeries = aggregateSeries([
    asSample([el('div', { id: 't' }, ['a'])], t0, 10),
    asSample([el('div', { id: 't' }, ['b'])], t0 + 60000, 10),
    asSample([el('div', { id: 't' }, ['c'])], t0 + 120000, 10),
  ]);
  checks.push(['attributes a text append to its container', textSeries.byParent.some((entry) => entry.key.endsWith('div[0]') && entry.net === 2 && entry.repeated === true)]);
  checks.push(['cancels rewritten text in the container table', !churnSeries.byParent.some((entry) => entry.key.endsWith('div[0]'))]);
  checks.push(['separates text nodes from elements', textSeries.elements.delta === 0 && textSeries.nodes.delta === 2]);

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed++;
  }
  console.log(`[dom-diff] self-test ${checks.length - failed}/${checks.length} passed`);
  return failed === 0 ? 0 : 1;
}

// --- main ----------------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) {
    process.exitCode = runSelfTest();
    return;
  }

  const port = await resolvePort(args);
  const targets = await pickUiTargets(port, args.includeAll);
  const samples = Math.max(2, args.samples);
  const intervalMs = Math.max(5000, Math.round((args.gap * 1000) / (samples - 1)));
  const windowMinutes = ((samples - 1) * intervalMs) / 60000;
  console.log(`[dom-diff] port ${port}, ${targets.length} UI target(s), ${samples} samples ${(intervalMs / 1000).toFixed(0)}s apart (window ${windowMinutes.toFixed(1)} min)`);
  for (const target of targets) console.log(`[dom-diff] target: ${target.url}`);

  const sessions = [];
  for (const target of targets) sessions.push({ target, cdp: await Cdp.attach(target.webSocketDebuggerUrl), series: [] });
  try {
    for (let index = 0; index < samples; index++) {
      for (const session of sessions) session.series.push(await snapshot(session.cdp));
      const at = sessions[0].series[sessions[0].series.length - 1].at;
      const isLast = index === samples - 1;
      console.log(`[dom-diff] sample ${index + 1}/${samples} at ${new Date(at).toISOString()}${isLast ? '' : ` — next in ${(intervalMs / 1000).toFixed(0)}s`}`);
      if (!isLast) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    const report = { port, intervalSeconds: intervalMs / 1000, samples, windowMinutes: Number(windowMinutes.toFixed(2)), targets: [] };
    for (const session of sessions) report.targets.push({ url: session.target.url, ...aggregateSeries(session.series) });

    const steady = [];
    const steadyParents = [];
    for (const target of report.targets) {
      const label = String(target.url).split('/').pop();
      console.log(`[dom-diff] === ${label}`);
      console.log(
        `[dom-diff]   elements ${target.elements.first} -> ${target.elements.last} (delta ${target.elements.delta}, ${target.elements.perMinute}/min), all nodes ${target.nodes.first} -> ${target.nodes.last} (delta ${target.nodes.delta}, ${target.nodes.perMinute}/min)`
      );
      console.log(
        `[dom-diff]   DOM counters nodes ${target.counters.first.nodes} -> ${target.counters.last.nodes} (${target.counters.nodesPerMinute}/min), listeners ${target.counters.first.jsEventListeners} -> ${target.counters.last.jsEventListeners} (${target.counters.listenersPerMinute}/min)`
      );
      for (const entry of target.documents) console.log(`[dom-diff]   document ${entry.label}: net ${entry.net > 0 ? '+' : ''}${entry.net} (in ${entry.intervals} interval(s))`);
      for (const entry of target.appenders) {
        const example = entry.example ? ` | ${entry.example.document} | ${entry.example.chain}` : '';
        console.log(`[dom-diff]   ${entry.repeated ? 'STEADY' : 'once  '} +${entry.net} (${entry.intervals} interval(s), ${entry.perMinute}/min) ${entry.key}${example}`);
        if (entry.repeated) steady.push({ target: label, ...entry });
      }
      for (const entry of target.shrunk) console.log(`[dom-diff]   shrunk ${entry.net} (${entry.intervals} interval(s)) ${entry.key}`);
      for (const entry of target.byTag) console.log(`[dom-diff]   tag ${entry.key}: net ${entry.net > 0 ? '+' : ''}${entry.net} (${entry.intervals} interval(s))`);
      for (const entry of target.byParent.slice(0, 10)) {
        console.log(`[dom-diff]   parent ${entry.net > 0 ? '+' : ''}${entry.net} (${entry.intervals} interval(s), ${entry.perMinute}/min) ${entry.key}`);
        if (entry.repeated && entry.net > 0) steadyParents.push({ target: label, ...entry });
      }
    }

    if (steady.length) {
      console.log('[dom-diff] STEADY APPENDERS (signature net added in two or more intervals — the leak candidates):');
      for (const entry of steady) console.log(`  ${entry.target} | ${entry.key} | +${entry.net} | ${entry.perMinute}/min | ${entry.example?.document ?? '?'} | ${entry.example?.chain ?? ''}`);
    } else {
      console.log('[dom-diff] No signature was added in two or more intervals: the element set is flat at this resolution.');
    }
    if (steadyParents.length) {
      console.log('[dom-diff] GROWING CONTAINERS (net added in two or more intervals, text churn cancelled):');
      for (const entry of steadyParents) console.log(`  ${entry.target} | ${entry.key} | +${entry.net} | ${entry.perMinute}/min`);
    }

    if (args.json) {
      fs.writeFileSync(path.isAbsolute(args.json) ? args.json : path.join(process.cwd(), args.json), JSON.stringify(report, null, 2), 'utf8');
      console.log(`[dom-diff] wrote ${args.json}`);
    }
  } finally {
    for (const session of sessions) session.cdp.close();
  }
}

main().catch((err) => {
  console.error(`[dom-diff] FAILED: ${err.message}`);
  process.exitCode = 1;
});
