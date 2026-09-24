#!/usr/bin/env node
'use strict';
/**
 * AntiFan renderer allocation-site probe (read-only).
 *
 * The retention probe (`probe-renderer-retention-class.cjs`) settles *which class* of memory
 * grows (DOM nodes, event listeners, V8 heap, or OS-private only). It cannot say which code
 * allocates it. This probe answers that with V8's sampling heap profiler: it records the
 * allocation stacks of each app-UI document for a short window and prints the sites that
 * allocated the most bytes, so a candidate owner can be read out of the source.
 *
 * Sampling never walks the heap: the overhead is a per-allocation hook (~1-3 % CPU, no
 * multi-second pause, no snapshot-sized memory spike), which is why this can run while a
 * soak is measuring. A full `HeapProfiler.takeHeapSnapshot` diff names *retained* objects
 * more precisely but costs a pause and a heap-sized spike — run that on a reproduction, not
 * on a measured run.
 *
 * Reported per site: bytes allocated at that call frame, the share of everything sampled,
 * and the frames *below* it (selfSize of descendants) so a wrapper that only forwards into
 * a hot allocator is not mistaken for the allocator.
 *
 * Usage:
 *   node scripts/probe-renderer-allocation-sites.cjs --seconds 120
 *   node scripts/probe-renderer-allocation-sites.cjs --seconds 120 --top 25 --json out.json
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const DEFAULT_PROFILE = process.env.ANTIFAN_SOAK_PROFILE || 'E:/Work/.antifan-soak-8h/Profile';
const REPORT_DIR = path.join(__dirname, '..', 'plans', 'reports', 'runtime-verification');
// The three documents the standalone app UI renders into one process. All three are sampled:
// they share a process, so a counter cannot say which document owns the growth, and the only
// honest way to attribute it is to profile each isolate.
const UI_DOCUMENTS = ['standalone.html', 'toolbar.html', 'frame-backdrop.html'];

function parseArgs(argv) {
  const args = { seconds: 120, top: 20, intervalBytes: 16384, json: null };
  // Both `--flag=value` and `--flag value` are accepted: the probe is run by hand during a
  // measurement window, and a rejected form costs one of the few minutes that window has.
  const value = (raw, name) => (raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : argv[argv.indexOf(raw) + 1]);
  for (const raw of argv) {
    if (raw.startsWith('--profile')) args.profile = value(raw, '--profile');
    else if (raw.startsWith('--port')) args.port = Number(value(raw, '--port'));
    else if (raw.startsWith('--seconds')) args.seconds = Math.max(10, Number(value(raw, '--seconds')));
    else if (raw.startsWith('--top')) args.top = Math.max(5, Number(value(raw, '--top')));
    else if (raw.startsWith('--interval-bytes')) args.intervalBytes = Math.max(1024, Number(value(raw, '--interval-bytes')));
    else if (raw.startsWith('--json')) args.json = value(raw, '--json');
    else if (raw === '--include-all-targets') args.includeAll = true;
    else if (!/^\d+$/.test(raw) && !argv[argv.indexOf(raw) - 1]?.startsWith('--')) throw new Error(`unknown argument: ${raw}`);
  }
  return args;
}

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

function connect(url, openTimeoutMs = 5000) {
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
  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
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
    close: () => {
      try {
        socket.terminate();
      } catch {
        try {
          socket.close();
        } catch {
          /* already gone */
        }
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

/** Bytes allocated per call site. `selfSize` is what this exact frame allocated. */
function aggregate(profile, top) {
  const bySite = new Map();
  let total = 0;
  const walk = (node) => {
    if (!node) return 0;
    const frame = node.callFrame || {};
    const self = Number(node.selfSize || 0);
    let subtree = self;
    for (const child of node.children || []) subtree += walk(child);
    if (self > 0) {
      const file = String(frame.url || '').replace(/^file:\/\/\/.*\/(src|\.compiled\/src)\//, '$1/');
      const key = `${frame.functionName || '(anonymous)'} @ ${file || '(native)'}:${(frame.lineNumber ?? -1) + 1}`;
      const row = bySite.get(key) || { site: key, selfBytes: 0, subtreeBytes: 0, samples: 0 };
      row.selfBytes += self;
      row.subtreeBytes += subtree;
      row.samples += 1;
      bySite.set(key, row);
    }
    total += self;
    return subtree;
  };
  walk(profile && profile.head);
  const rows = [...bySite.values()].sort((a, b) => b.selfBytes - a.selfBytes).slice(0, top);
  return { totalBytes: total, rows };
}

const mb = (bytes) => Math.round((bytes / (1024 * 1024)) * 100) / 100;

async function profileTarget(target, args) {
  const cdp = connect(target.webSocketDebuggerUrl);
  const result = { url: target.url, title: target.title, id: target.id, ok: false };
  try {
    await cdp.opened;
    await cdp.send('HeapProfiler.enable').catch(() => {});
    const before = await cdp.send('Runtime.getHeapUsage').catch(() => null);
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: args.intervalBytes });
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, args.seconds * 1000));
    const stopped = await cdp.send('HeapProfiler.stopSampling', {}, 120000);
    const elapsedMs = Date.now() - startedAt;
    const after = await cdp.send('Runtime.getHeapUsage').catch(() => null);
    const { totalBytes, rows } = aggregate(stopped && stopped.profile, args.top);
    result.ok = true;
    result.elapsedMs = elapsedMs;
    result.sampledBytes = totalBytes;
    result.sampledBytesPerMin = Math.round((totalBytes / elapsedMs) * 60000);
    result.heapBeforeMB = before ? mb(before.usedSize) : null;
    result.heapAfterMB = after ? mb(after.usedSize) : null;
    result.heapDeltaMBPerMin =
      before && after ? Math.round(((after.usedSize - before.usedSize) / (1024 * 1024) / elapsedMs) * 60000 * 1000) / 1000 : null;
    result.rows = rows;
  } catch (err) {
    result.error = err.message;
  } finally {
    cdp.close();
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const port = resolvePort(args);
  const targets = await listTargets(port);
  const selected = args.includeAll
    ? targets
    : targets.filter((t) => UI_DOCUMENTS.some((doc) => String(t.url).includes(doc)));
  if (selected.length === 0) {
    throw new Error(`no app-UI document target on port ${port}; saw: ${targets.map((t) => t.url).join(', ')}`);
  }
  console.log(`# allocation-site probe — port ${port}, ${selected.length} UI document(s), ${args.seconds}s each, sampling interval ${args.intervalBytes} B`);
  const report = { port, seconds: args.seconds, intervalBytes: args.intervalBytes, at: new Date().toISOString(), targets: [] };
  for (const target of selected) {
    const result = await profileTarget(target, args);
    report.targets.push(result);
    const name = UI_DOCUMENTS.find((doc) => String(result.url).includes(doc)) || result.url;
    console.log(`\n## ${name}`);
    if (!result.ok) {
      console.log(`   FAILED: ${result.error}`);
      continue;
    }
    console.log(
      `   heap ${result.heapBeforeMB} -> ${result.heapAfterMB} MB (${result.heapDeltaMBPerMin}/min over ${Math.round(result.elapsedMs / 1000)}s)  ` +
        `sampled ${mb(result.sampledBytes)} MB (${mb(result.sampledBytesPerMin)} MB/min of allocation)`,
    );
    for (const row of result.rows) {
      const share = result.sampledBytes > 0 ? ((row.selfBytes / result.sampledBytes) * 100).toFixed(1) : '0.0';
      console.log(`   ${(mb(row.selfBytes) + ' MB').padStart(9)} ${(share + '%').padStart(6)}  ${row.site}  [subtree ${mb(row.subtreeBytes)} MB]`);
    }
  }
  if (args.json) {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const out = path.isAbsolute(args.json) ? args.json : path.join(REPORT_DIR, args.json);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`\n# wrote ${out}`);
  }
}

main().catch((err) => {
  console.error(`[allocation-sites] ${err.message}`);
  process.exit(1);
});
