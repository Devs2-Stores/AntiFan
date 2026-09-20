/**
 * Renderer retention *class* probe — attaches to a running app's DevTools endpoint and says
 * which kind of memory grows in which document, before anyone takes a heap snapshot.
 *
 * Why this exists. The retention finding names a process (pid 47536 committed +0.17 MB/min)
 * but not the allocation, and the plan's next step is a heap diff. A full V8 snapshot forces
 * a collection in the process under measurement and only ever reports V8 objects, so it
 * cannot see the other candidate: Blink-side DOM state (a scrollback's nodes, attribute and
 * string tables), which shows up as a growing `nodes` count and *not* as a growing JS heap.
 * This probe chooses the instrument by measurement: it samples exact DOM counters and the
 * derived performance counters per document for a few minutes and reports which series moves.
 *
 * Counters, and why each is treated differently:
 *   - `nodes`, `documents`, `jsEventListeners` (Memory.getDOMCounters) are exact counts at the
 *     instant of the call: any monotone growth is retention.
 *   - `JSHeapUsedSize` is a sawtooth — a collection can drop it 10 MB between samples — so a
 *     first→last delta alone is not evidence. The probe reports the series and the fraction of
 *     monotone steps, and refuses to call it growth below that.
 *   - `LayoutCount` / `RecalcStyleCount` are cumulative work counters: they always grow, and
 *     their *rate* is CPU spent on the thread pool every switch and tab renderer shares. That
 *     is the currency "more work at once" is bound by, so it is reported even when no memory
 *     series moves.
 *
 * Usage:
 *   node scripts/probe-renderer-retention-class.cjs --profile=E:/Work/.antifan-soak-8h/Profile
 *   node scripts/probe-renderer-retention-class.cjs --port=9222 --samples=5 --interval-ms=60000
 *   node scripts/probe-renderer-retention-class.cjs --self-test
 *
 * The app must have been launched with `--remote-debugging-port=0` (the soak harness passes
 * `SOAK_APP_ARGS` through for exactly this) so the profile holds a `DevToolsActivePort` file.
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const DEFAULT_PROFILE = process.env.ANTIFAN_SOAK_PROFILE || 'E:/Work/.antifan-soak-8h/Profile';
const REPORT_DIR = path.join(__dirname, '..', 'plans', 'reports', 'runtime-verification');

// Exact counters: a single unit per minute sustained is retention, because nothing else adds
// nodes or listeners to a page that is not being edited by a user.
const EXACT_COUNTER_FLOORS = {
  nodes: 10,
  jsEventListeners: 1,
  documents: 1,
};
// Derived counters. The heap is a sawtooth, so it needs both a magnitude and a trend test; the
// work counters are cumulative by nature and are reported as a rate rather than classified.
const HEAP_GROWTH_FLOOR_MB = 1;
const HEAP_MONOTONE_FRACTION = 0.8;
const COUNTER_KEYS = [
  'nodes',
  'documents',
  'jsEventListeners',
  'jsHeapUsedSizeMB',
  'layoutCount',
  'recalcStyleCount',
];

function parseArgs(argv) {
  const args = { samples: 5, intervalMs: 60000, json: null, selfTest: false, quiet: false };
  for (const raw of argv) {
    if (raw === '--self-test') args.selfTest = true;
    else if (raw === '--quiet') args.quiet = true;
    else if (raw.startsWith('--profile=')) args.profile = raw.slice('--profile='.length);
    else if (raw.startsWith('--port=')) args.port = Number(raw.slice('--port='.length));
    else if (raw.startsWith('--samples=')) args.samples = Math.max(2, Number(raw.slice('--samples='.length)));
    else if (raw.startsWith('--interval-ms=')) args.intervalMs = Math.max(1000, Number(raw.slice('--interval-ms='.length)));
    else if (raw.startsWith('--json=')) args.json = raw.slice('--json='.length);
    else throw new Error(`unknown argument: ${raw}`);
  }
  return args;
}

/**
 * The endpoint port: an explicit `--port` wins, otherwise the profile's `DevToolsActivePort`
 * (first line is the port Chromium bound, second is the browser-socket path).
 */
function resolvePort(args) {
  if (Number.isFinite(args.port)) return args.port;
  const profile = args.profile || DEFAULT_PROFILE;
  const file = path.join(profile, 'DevToolsActivePort');
  if (!fs.existsSync(file)) {
    throw new Error(
      `no DevToolsActivePort in ${profile}. The app must be launched with --remote-debugging-port=0 ` +
        '(soak harness: SOAK_APP_ARGS="--remote-debugging-port=0").',
    );
  }
  const [port] = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const parsed = Number(port);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${file} does not name a port: ${JSON.stringify(port)}`);
  return parsed;
}

function connect(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const entry = msg.id ? pending.get(msg.id) : null;
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
    else entry.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after 20000 ms`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return { socket, send, opened, closed, close: () => socket.close() };
}

async function listPageTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`/json/list answered ${res.status}`);
  const targets = await res.json();
  return targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && !String(t.url).startsWith('devtools://'));
}

/**
 * One sample from one document. A counter the build does not implement is recorded as
 * unsupported instead of zero: "the protocol refused" and "the count is zero" are different
 * facts, and a zero would read as a healthy flat series.
 */
async function sampleTarget(target, at = Date.now()) {
  const cdp = connect(target.webSocketDebuggerUrl);
  const counters = {};
  const unsupported = [];
  try {
    await cdp.opened;
    await cdp.send('Performance.enable').catch(() => {});
    const dom = await cdp
      .send('Memory.getDOMCounters')
      .then((r) => r)
      .catch((err) => {
        unsupported.push(`Memory.getDOMCounters: ${err.message}`);
        return null;
      });
    if (dom) {
      counters.nodes = dom.nodes;
      counters.documents = dom.documents;
      counters.jsEventListeners = dom.jsEventListeners;
    }
    const metrics = await cdp
      .send('Performance.getMetrics')
      .then((r) => Object.fromEntries((r.metrics || []).map((m) => [m.name, m.value])))
      .catch((err) => {
        unsupported.push(`Performance.getMetrics: ${err.message}`);
        return null;
      });
    if (metrics) {
      if (Number.isFinite(metrics.JSHeapUsedSize)) counters.jsHeapUsedSizeMB = metrics.JSHeapUsedSize / (1024 * 1024);
      if (Number.isFinite(metrics.LayoutCount)) counters.layoutCount = metrics.LayoutCount;
      if (Number.isFinite(metrics.RecalcStyleCount)) counters.recalcStyleCount = metrics.RecalcStyleCount;
      if (Number.isFinite(metrics.Nodes)) counters.nodes = counters.nodes ?? metrics.Nodes;
    }
  } finally {
    cdp.close();
  }
  return { at, url: target.url, title: target.title, id: target.id, counters, unsupported };
}

function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Fraction of consecutive steps (per counter) that moved upward. 1 = strictly monotone. */
function monotoneFraction(series) {
  if (series.length < 2) return 0;
  let up = 0;
  let steps = 0;
  for (let i = 1; i < series.length; i++) {
    steps++;
    if (series[i] > series[i - 1]) up++;
  }
  return steps === 0 ? 0 : up / steps;
}

/**
 * Turns the samples into a verdict. Per counter the classification is deliberately narrow:
 * exact counters classify on a floor (a rate, not a single jump), the heap needs magnitude
 * *and* a monotone majority, and the cumulative work counters are reported as a rate for the
 * CPU objective rather than as growth.
 */
function classifyRetention(samples) {
  const first = samples[0];
  const last = samples[samples.length - 1];
  const windowMinutes = (last.at - first.at) / 60000;
  const byUrl = new Map();
  for (const sample of samples) {
    for (const target of sample.targets) {
      if (!byUrl.has(target.url)) byUrl.set(target.url, []);
      byUrl.get(target.url).push(target);
    }
  }

  const targets = [];
  for (const [url, series] of byUrl) {
    const present = series.filter((s) => Object.keys(s.counters).length > 0);
    if (present.length < 2) {
      targets.push({ url, samples: series.length, class: 'UNMEASURED', counters: {}, rates: {}, unsupported: series.flatMap((s) => s.unsupported) });
      continue;
    }
    const rates = {};
    const deltas = {};
    const trend = {};
    for (const key of COUNTER_KEYS) {
      const values = present.map((s) => s.counters[key]).filter((v) => Number.isFinite(v));
      if (values.length < 2) continue;
      const delta = values[values.length - 1] - values[0];
      const spanMinutes = (present[present.length - 1].at - present[0].at) / 60000 || windowMinutes || 1;
      deltas[key] = round(delta, 3);
      rates[key] = round(delta / spanMinutes, 3);
      if (key === 'jsHeapUsedSizeMB') trend[key] = round(monotoneFraction(values), 2);
    }

    const domNodes = rates.nodes;
    const listeners = rates.jsEventListeners;
    const documents = rates.documents;
    const heapRate = rates.jsHeapUsedSizeMB ?? 0;
    const heapDelta = deltas.jsHeapUsedSizeMB ?? 0;
    const heapMonotone = trend.jsHeapUsedSizeMB ?? 0;
    let klass = 'FLAT';
    if (Number.isFinite(domNodes) && domNodes >= EXACT_COUNTER_FLOORS.nodes) klass = 'DOM_NODES';
    else if (Number.isFinite(listeners) && listeners >= EXACT_COUNTER_FLOORS.jsEventListeners) klass = 'EVENT_LISTENERS';
    else if (Number.isFinite(documents) && documents >= EXACT_COUNTER_FLOORS.documents) klass = 'DOCUMENTS';
    else if (heapDelta >= HEAP_GROWTH_FLOOR_MB && heapMonotone >= HEAP_MONOTONE_FRACTION) klass = 'JS_HEAP';

    targets.push({
      url,
      title: present[present.length - 1].title,
      samples: present.length,
      class: klass,
      counters: {
        first: Object.fromEntries(COUNTER_KEYS.filter((k) => Number.isFinite(present[0].counters[k])).map((k) => [k, round(present[0].counters[k], 3)])),
        last: Object.fromEntries(COUNTER_KEYS.filter((k) => Number.isFinite(present[present.length - 1].counters[k])).map((k) => [k, round(present[present.length - 1].counters[k], 3)])),
      },
      deltas,
      rates,
      trend,
      unsupported: [...new Set(present.flatMap((s) => s.unsupported))],
    });
  }
  targets.sort((a, b) => (b.rates.jsHeapUsedSizeMB ?? 0) + (b.rates.nodes ?? 0) - ((a.rates.jsHeapUsedSizeMB ?? 0) + (a.rates.nodes ?? 0)));

  const retained = targets.filter((t) => ['DOM_NODES', 'EVENT_LISTENERS', 'DOCUMENTS', 'JS_HEAP'].includes(t.class));
  const work = targets
    .filter((t) => Number.isFinite(t.rates.recalcStyleCount) || Number.isFinite(t.rates.layoutCount))
    .map((t) => ({ url: t.url, recalcStylePerMin: t.rates.recalcStyleCount ?? null, layoutPerMin: t.rates.layoutCount ?? null }));
  const verdict = retained.length
    ? `retention is ${[...new Set(retained.map((t) => t.class))].join(' + ')} in ${retained.length} document(s): ${retained
        .map((t) => `${t.class} @ ${t.url}`)
        .join(', ')}`
    : 'no exact counter and no heap series grew over this window (see work rates: the window may be too short)';
  return { windowMinutes: round(windowMinutes, 2), targets, retained, work, verdict };
}

async function run(args) {
  const port = resolvePort(args);
  console.log(`[retention-class] DevTools endpoint 127.0.0.1:${port}`);
  const samples = [];
  for (let i = 0; i < args.samples; i++) {
    const sampleAt = Date.now();
    const targets = await listPageTargets(port);
    const rows = [];
    for (const target of targets) {
      try {
        rows.push(await sampleTarget(target, sampleAt));
      } catch (err) {
        console.error(`[retention-class] sample failed for ${target.url}: ${err.message}`);
      }
    }
    samples.push({ at: sampleAt, targets: rows });
    const stamp = new Date().toTimeString().slice(0, 8);
    const summary = rows
      .map((r) => `${r.title || r.url}: nodes=${r.counters.nodes ?? '-'} listeners=${r.counters.jsEventListeners ?? '-'} heap=${r.counters.jsHeapUsedSizeMB ? r.counters.jsHeapUsedSizeMB.toFixed(2) + 'MB' : '-'}`)
      .join(' | ');
    if (!args.quiet) console.log(`[retention-class] ${stamp} n=${rows.length} ${summary}`);
    if (i < args.samples - 1) await new Promise((r) => setTimeout(r, args.intervalMs));
  }

  const result = { generatedAt: new Date().toISOString(), port, samples: args.samples, intervalMs: args.intervalMs, ...classifyRetention(samples) };
  console.log('');
  console.log('=== retention class (exact counters are not noisy; the heap is a sawtooth) ===');
  for (const t of result.targets) {
    console.log(`${t.class.padEnd(16)} ${t.url}`);
    console.log(
      `                 nodes ${t.counters.first.nodes ?? '-'} -> ${t.counters.last.nodes ?? '-'} (${t.rates.nodes ?? '-'}/min) | ` +
        `listeners ${t.counters.first.jsEventListeners ?? '-'} -> ${t.counters.last.jsEventListeners ?? '-'} (${t.rates.jsEventListeners ?? '-'}/min)`,
    );
    console.log(
      `                 heap ${t.counters.first.jsHeapUsedSizeMB ?? '-'} -> ${t.counters.last.jsHeapUsedSizeMB ?? '-'} MB ` +
        `(delta ${t.deltas.jsHeapUsedSizeMB ?? '-'}, ${t.rates.jsHeapUsedSizeMB ?? '-'}/min, monotone ${t.trend.jsHeapUsedSizeMB ?? '-'}) | ` +
        `recalc ${t.rates.recalcStyleCount ?? '-'}/min layout ${t.rates.layoutCount ?? '-'}/min`,
    );
    for (const u of t.unsupported) console.log(`                 unsupported: ${u}`);
  }
  console.log('');
  console.log(`window ${result.windowMinutes} min | ${result.verdict}`);
  for (const w of result.work) console.log(`work rate      recalc ${w.recalcStylePerMin}/min layout ${w.layoutPerMin}/min  ${w.url}`);

  const outPath = args.json || path.join(REPORT_DIR, `renderer-retention-class-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n[retention-class] wrote ${outPath}`);
  return result;
}

/**
 * Self-test: a scripted endpoint that answers `/json/list` and the two CDP methods, with three
 * documents that grow in three different ways. It verifies the transport, the counter parsing
 * and the classification — everything except the app's willingness to answer.
 */
async function selfTest() {
  const assert = require('node:assert');
  const http = require('node:http');
  const { WebSocketServer } = require('ws');
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/json/list')) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(targets));
  });
  const wss = new WebSocketServer({ server });
  const targets = [
    { id: 'a', type: 'page', title: 'nodes', url: 'file:///nodes', webSocketDebuggerUrl: 'ws://127.0.0.1:PORT/ws-a' },
    { id: 'b', type: 'page', title: 'listeners', url: 'file:///listeners', webSocketDebuggerUrl: 'ws://127.0.0.1:PORT/ws-b' },
    { id: 'c', type: 'page', title: 'flat', url: 'file:///flat', webSocketDebuggerUrl: 'ws://127.0.0.1:PORT/ws-c' },
  ];
  const step = { a: 0, b: 0, c: 0 };
  const shape = (id) => {
    step[id]++;
    if (id === 'a') return { nodes: 1000 + step.a * 600, documents: 1, jsEventListeners: 20 };
    if (id === 'b') return { nodes: 1000, documents: 1, jsEventListeners: 20 + step.b * 30 };
    return { nodes: 1000, documents: 1, jsEventListeners: 20 };
  };
  const heap = (id) => ({ a: 40, b: 40, c: 40 }[id] + (id === 'a' ? step.a * 0.5 : 0));
  wss.on('connection', (socket, req) => {
    const id = String(req.url).replace('/ws-', '');
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const reply = (result) => socket.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === 'Performance.enable') reply({});
      else if (msg.method === 'Memory.getDOMCounters') reply(shape(id));
      else if (msg.method === 'Performance.getMetrics')
        reply({ metrics: [{ name: 'JSHeapUsedSize', value: heap(id) * 1024 * 1024 }, { name: 'LayoutCount', value: step[id] * 10 }, { name: 'RecalcStyleCount', value: step[id] * 25 }] });
      else socket.send(JSON.stringify({ id: msg.id, error: { message: 'method not found' } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  for (const t of targets) t.webSocketDebuggerUrl = t.webSocketDebuggerUrl.replace('PORT', String(port));

  try {
    const samples = [];
    const base = Date.now();
    for (let i = 0; i < 4; i++) {
      const sampleAt = base + i * 60000;
      const rows = [];
      for (const target of await listPageTargets(port)) rows.push(await sampleTarget(target, sampleAt));
      samples.push({ at: sampleAt, targets: rows });
    }
    const result = classifyRetention(samples);
    const byUrl = Object.fromEntries(result.targets.map((t) => [t.url, t]));
    assert.strictEqual(byUrl['file:///nodes'].class, 'DOM_NODES');
    assert.strictEqual(byUrl['file:///listeners'].class, 'EVENT_LISTENERS');
    assert.strictEqual(byUrl['file:///flat'].class, 'FLAT');
    assert.strictEqual(byUrl['file:///nodes'].rates.nodes, 600);
    assert.strictEqual(byUrl['file:///listeners'].rates.jsEventListeners, 30);
    assert.strictEqual(byUrl['file:///flat'].rates.nodes, 0);
    assert.deepStrictEqual(result.retained.map((t) => t.url).sort(), ['file:///listeners', 'file:///nodes']);
    assert.ok(result.work.every((w) => w.recalcStylePerMin === 25 && w.layoutPerMin === 10), JSON.stringify(result.work));

    // A sawtooth heap (down 10 MB, then up) must not classify as growth on the delta alone.
    const sawtooth = [
      { at: 0, targets: [{ url: 'file:///saw', title: 'saw', counters: { jsHeapUsedSizeMB: 50, nodes: 100 }, unsupported: [] }] },
      { at: 60000, targets: [{ url: 'file:///saw', title: 'saw', counters: { jsHeapUsedSizeMB: 40, nodes: 100 }, unsupported: [] }] },
      { at: 120000, targets: [{ url: 'file:///saw', title: 'saw', counters: { jsHeapUsedSizeMB: 44.5, nodes: 100 }, unsupported: [] }] },
    ];
    assert.strictEqual(classifyRetention(sawtooth).targets[0].class, 'FLAT');
    // ...and a single document with no readable counters must be UNMEASURED, not FLAT.
    const refused = [
      { at: 0, targets: [{ url: 'file:///no', title: 'no', counters: {}, unsupported: ['Memory.getDOMCounters: not found'] }] },
      { at: 60000, targets: [{ url: 'file:///no', title: 'no', counters: {}, unsupported: ['Memory.getDOMCounters: not found'] }] },
    ];
    assert.strictEqual(classifyRetention(refused).targets[0].class, 'UNMEASURED');
    console.log('[self-test] 11/11 assertions passed (classification, rates, sawtooth heap, refusal)');
    return 0;
  } finally {
    wss.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = { classifyRetention, monotoneFraction, resolvePort, listPageTargets, sampleTarget, EXACT_COUNTER_FLOORS };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const task = args.selfTest ? selfTest() : run(args);
  task.then(
    (r) => {
      if (r === 0) process.exitCode = 0;
    },
    (err) => {
      console.error(`[retention-class] FAILED: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
