#!/usr/bin/env node
'use strict';
/**
 * AntiFan UI-renderer frame-callback ledger (read-only): *who* schedules animation frames that
 * never run.
 *
 * The heap diff names the retained V8 shapes on the chrome renderer and they are a frame
 * callback per broadcast: `native V8FrameCallback` and `native V8FrameRequestCallback` each
 * gained ~725 instances per 3 minutes (~4/s), and every one of them rode in with the same tab
 * record — `capsule-<uuid>`, `persist:profile-default`, `responsive`, `storefront`, the favicon
 * URL — plus `array` +1448. A `requestAnimationFrame` callback is retained by the document until
 * it runs, so a document whose frames do not run accumulates one closure *and its whole captured
 * object graph* per schedule. That is the shape of the measured retention, and the missing fact
 * is the caller.
 *
 * This probe installs a ledger inside each app-UI document that wraps `requestAnimationFrame`,
 * counts schedules, completions and cancels, and captures the scheduling stack — grouped by
 * frame, so the report is a rate per *call site*, not per document. It takes no heap snapshot
 * and forces no collection, so it can run inside a measured soak: the wrapper is ~1 µs per
 * schedule and preserves the original semantics (the callback still runs, on the same frame,
 * through the original scheduler).
 *
 * The control is built in: the visible document's ledger should read `pending ≈ 0` while a
 * document whose frames never run reads `pending` climbing at the schedule rate. The two numbers
 * come from one instrument, in one process, in one window.
 *
 * Usage:
 *   node scripts/probe-renderer-raf-ledger.cjs --seconds 60
 *   node scripts/probe-renderer-raf-ledger.cjs --seconds 120 --json raf-ledger.json
 *   node scripts/probe-renderer-raf-ledger.cjs --uninstall
 *   node scripts/probe-renderer-raf-ledger.cjs --self-test
 *
 * `--uninstall` removes the wrapper without reading a window (use it if a prior run was killed
 * with the ledger still installed). The app must run with `--remote-debugging-port=0`, which the
 * soak harness passes through `SOAK_APP_ARGS`.
 */
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');

const DEFAULT_PROFILE = process.env.ANTIFAN_SOAK_PROFILE || 'E:/Work/.antifan-soak-8h/Profile';
const UI_DOCUMENTS = ['standalone.html', 'toolbar.html', 'frame-backdrop.html'];
// Frames of the stack that are worth grouping on: the first two are the wrapper and the
// scheduling helper, the next four are the caller chain that names the site.
const STACK_FRAMES = 6;

function parseArgs(argv) {
  const args = { seconds: 60, json: null, selfTest: false, uninstall: false, interval: 0 };
  const value = (raw) => (raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : argv[argv.indexOf(raw) + 1]);
  for (const raw of argv) {
    if (raw.startsWith('--profile')) args.profile = value(raw);
    else if (raw.startsWith('--port')) args.port = Number(value(raw));
    else if (raw.startsWith('--seconds')) args.seconds = Math.max(5, Number(value(raw)));
    // A backlog only exists *while* a document is hidden, and one sample at the end of a window
    // can only see the moment it lands on. `--interval` turns the window into a series, which is
    // what shows a queue growing under a hidden document and draining when it is shown again.
    else if (raw.startsWith('--interval')) args.interval = Math.max(5, Number(value(raw)));
    else if (raw.startsWith('--json')) args.json = value(raw);
    else if (raw === '--uninstall') args.uninstall = true;
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
    // A document that reloaded mid-window reads exactly like a document with nothing wrong with
    // it, so a closed socket has to fail the call in flight instead of waiting out the timer.
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
    const ws = new WebSocket(webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024 });
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

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: false });
    if (result.exceptionDetails) {
      throw new Error(`evaluate threw: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

/**
 * The in-page installer, kept as one expression so the probe's own file has no build step. It is
 * idempotent: a second install returns the existing ledger rather than double-wrapping.
 */
function installExpression() {
  return `(() => {
  if (window.__rafLedger) {
    return { installed: false, reason: 'already installed', visibility: document.visibilityState };
  }
  const originalRaf = window.requestAnimationFrame.bind(window);
  const originalCancel = window.cancelAnimationFrame.bind(window);
  const ours = new Set();
  const stacks = new Map();
  const live = new Map();
  const state = { scheduled: 0, fired: 0, cancelled: 0, startedAt: Date.now() };
  const stackOf = () => {
    try {
      const frames = String(new Error().stack || '').split('\\n').slice(2, ${2 + STACK_FRAMES});
      return frames.map((line) => line.trim().replace(/^at\\s+/, '')).join(' <- ');
    } catch (err) {
      return '(stack unavailable)';
    }
  };
  window.requestAnimationFrame = function (callback) {
    if (typeof callback !== 'function') return originalRaf(callback);
    const stack = stackOf();
    stacks.set(stack, (stacks.get(stack) || 0) + 1);
    state.scheduled += 1;
    let done = false;
    const wrapped = function (...args) {
      if (!done) {
        done = true;
        wrapped.__rafFired = true;
        state.fired += 1;
      }
      return callback.apply(this, args);
    };
    const id = originalRaf.call(window, wrapped);
    ours.add(id);
    live.set(id, wrapped);
    return id;
  };
  window.cancelAnimationFrame = function (id) {
    if (ours.has(id)) {
      if (live.has(id)) {
        // A cancel only counts as a completion if the callback had not run: cancelling an
        // already-fired id is a no-op in the platform, and counting it would hide a leak.
        const wrapped = live.get(id);
        if (wrapped && wrapped.__rafFired !== true) state.cancelled += 1;
        live.delete(id);
      }
    }
    return originalCancel.call(window, id);
  };
  window.__rafLedger = {
    snapshot: () => ({
      visibility: document.visibilityState,
      hidden: document.hidden,
      startedAt: state.startedAt,
      elapsedMs: Date.now() - state.startedAt,
      scheduled: state.scheduled,
      fired: state.fired,
      cancelled: state.cancelled,
      pending: state.scheduled - state.fired - state.cancelled,
      unaccounted: live.size,
      stacks: [...stacks.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([stack, count]) => ({ count, stack })),
    }),
    uninstall: () => {
      window.requestAnimationFrame = originalRaf;
      window.cancelAnimationFrame = originalCancel;
      delete window.__rafLedger;
      return true;
    },
  };
  return { installed: true, visibility: document.visibilityState, hidden: document.hidden };
})()`;
}

/**
 * Pure report shaping, so the arithmetic a reader trusts is testable without a browser: rates per
 * document, and the call sites ranked by how much of the unresolved backlog they own.
 */
function buildRows(ledgers) {
  return ledgers.map((entry) => {
    const ledger = entry.ledger || {};
    const minutes = Math.max((ledger.elapsedMs || 0) / 60000, 1e-9);
    return {
      label: entry.label,
      url: entry.url,
      visibility: ledger.visibility ?? entry.visibility ?? null,
      scheduled: ledger.scheduled ?? 0,
      fired: ledger.fired ?? 0,
      cancelled: ledger.cancelled ?? 0,
      pending: ledger.pending ?? 0,
      scheduledPerMin: Number(((ledger.scheduled ?? 0) / minutes).toFixed(1)),
      pendingPerMin: Number(((ledger.pending ?? 0) / minutes).toFixed(1)),
      unresolved: (ledger.stacks || []).map((row) => ({
        count: row.count,
        perMin: Number((row.count / minutes).toFixed(1)),
        stack: row.stack,
      })),
    };
  });
}

/**
 * The window's story per document: which visibility states it was sampled in, and the largest
 * unresolved-frame-callback count seen. A document that holds a backlog while hidden — and
 * drains it when shown — is the shape that retains frame callbacks for as long as the hidden
 * window lasts; a document sampled only visible, or draining to zero every sample, is not.
 */
function summarizeSeries(series) {
  const byLabel = new Map();
  for (const row of series) {
    for (const [label, sample] of Object.entries(row.samples || {})) {
      if (!sample) continue;
      const acc =
        byLabel.get(label) ||
        { label, visibility: new Set(), samples: 0, maxPending: 0, firstPending: null, lastPending: null, hiddenSamples: 0, hiddenMaxPending: 0 };
      const pending = sample.pending ?? 0;
      const visibility = sample.visibility ?? '?';
      acc.visibility.add(visibility);
      acc.samples += 1;
      acc.maxPending = Math.max(acc.maxPending, pending);
      if (visibility === 'hidden') {
        acc.hiddenSamples += 1;
        acc.hiddenMaxPending = Math.max(acc.hiddenMaxPending, pending);
      }
      if (acc.firstPending === null) acc.firstPending = pending;
      acc.lastPending = pending;
      byLabel.set(label, acc);
    }
  }
  return [...byLabel.values()].map((acc) => ({
    label: acc.label,
    visibility: [...acc.visibility].sort().join('+'),
    samples: acc.samples,
    hiddenSamples: acc.hiddenSamples,
    maxPending: acc.maxPending,
    hiddenMaxPending: acc.hiddenMaxPending,
    pendingGrowth: (acc.lastPending ?? 0) - (acc.firstPending ?? 0),
    hiddenWithBacklog: acc.hiddenMaxPending > 0,
  }));
}

function runSelfTest() {
  const checks = [];
  const rows = buildRows([
    {
      label: 'terminal',
      url: 'file:///app/standalone.html',
      ledger: {
        visibility: 'hidden',
        elapsedMs: 60000,
        scheduled: 300,
        fired: 0,
        cancelled: 0,
        pending: 300,
        stacks: [
          { count: 300, stack: 'scheduleFit <- onStateUpdated <- dispatch' },
          { count: 0, stack: 'never scheduled' },
        ],
      },
    },
    {
      label: 'toolbar',
      url: 'file:///app/toolbar.html',
      ledger: { visibility: 'visible', elapsedMs: 120000, scheduled: 600, fired: 598, cancelled: 2, pending: 0, stacks: [{ count: 600, stack: 'render' }] },
    },
  ]);
  checks.push(['reads the schedule rate per minute', rows[0].scheduledPerMin === 300]);
  checks.push(['reports the unresolved backlog', rows[0].pending === 300]);
  checks.push(['names the owning call site at its own rate', rows[0].unresolved[0].perMin === 300 && rows[0].unresolved[0].stack.includes('onStateUpdated')]);
  checks.push(['a balanced document reads zero pending', rows[1].pending === 0 && rows[1].scheduledPerMin === 300]);
  checks.push(['carries the document visibility', rows[0].visibility === 'hidden' && rows[1].visibility === 'visible']);
  const series = summarizeSeries([
    { tSec: 10, samples: { toolbar: { visibility: 'visible', pending: 0 }, backdrop: { visibility: 'hidden', pending: 0 } } },
    { tSec: 20, samples: { toolbar: { visibility: 'hidden', pending: 120 }, backdrop: { visibility: 'hidden', pending: 0 } } },
    { tSec: 30, samples: { toolbar: { visibility: 'visible', pending: 0 }, backdrop: { visibility: 'hidden', pending: 0 } } },
  ]);
  const toolbar = series.find((r) => r.label === 'toolbar');
  const backdrop = series.find((r) => r.label === 'backdrop');
  checks.push(['the series separates a hidden backlog from a drained document', toolbar.hiddenWithBacklog === true && toolbar.hiddenMaxPending === 120 && backdrop.hiddenWithBacklog === false]);
  checks.push(['the series reports the states each document was seen in', toolbar.visibility === 'hidden+visible' && toolbar.samples === 3 && toolbar.pendingGrowth === 0]);
  checks.push(['rejects an unknown argument', (() => {
    try {
      parseArgs(['--nope']);
      return false;
    } catch {
      return true;
    }
  })()]);

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) failed += 1;
  }
  console.log(`[raf-ledger] self-test ${checks.length - failed}/${checks.length} passed`);
  return failed === 0 ? 0 : 1;
}

async function readLedgers(targets, args) {
  const ledgers = [];
  for (const target of targets) {
    const label = String(target.url || '').split('/').pop() || target.title || target.id;
    const cdp = await Cdp.attach(target.webSocketDebuggerUrl);
    try {
      if (args.uninstall) {
        const removed = await cdp.evaluate('typeof window.__rafLedger === "object" ? window.__rafLedger.uninstall() : false');
        ledgers.push({ label, url: target.url, removed });
        continue;
      }
      const installed = await cdp.evaluate(installExpression());
      if (installed && installed.installed === false) {
        console.log(`[raf-ledger] ${label}: ${installed.reason} — reading the existing ledger`);
      }
      ledgers.push({ label, url: target.url, cdp, installed });
    } catch (err) {
      ledgers.push({ label, url: target.url, error: err.message });
      cdp.close();
    }
  }
  return ledgers;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) process.exit(runSelfTest());

  const port = await resolvePort(args);
  const targets = await pickUiTargets(port, args.includeAll);
  console.log(`[raf-ledger] port ${port} | ${targets.length} app-UI target(s)`);

  const ledgers = await readLedgers(targets, args);

  const series = [];
  if (!args.uninstall) {
    const interval = args.interval >= 5 ? args.interval : args.seconds;
    const rounds = Math.max(1, Math.floor(args.seconds / interval));
    console.log(`[raf-ledger] installed; sampling ${rounds}x every ${interval}s (no heap snapshot, no forced GC)`);
    const started = Date.now();
    for (let round = 0; round < rounds; round++) {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
      const samples = {};
      for (const entry of ledgers) {
        if (!entry.cdp) continue;
        try {
          const snap = await entry.cdp.evaluate('window.__rafLedger ? window.__rafLedger.snapshot() : null');
          if (snap) samples[entry.label] = snap;
        } catch {
          // A document that reloads inside the window ends its own ledger; the remaining
          // documents keep reporting rather than the series aborting.
        }
      }
      if (!Object.keys(samples).length) break;
      series.push({ tSec: Math.round((Date.now() - started) / 1000), samples });
      const line = Object.entries(samples)
        .map(([label, s]) => `${label} ${s.visibility ?? '?'}/pending ${s.pending ?? 0}`)
        .join(' | ');
      console.log(`[raf-ledger]   t+${series[series.length - 1].tSec}s  ${line}`);
    }
  }

  for (const entry of ledgers) {
    if (!entry.cdp) {
      console.log(`[raf-ledger] ${entry.label}: ${entry.error ? `FAILED — ${entry.error}` : 'uninstalled'}`);
      continue;
    }
    try {
      if (args.uninstall) continue;
      entry.ledger = await entry.cdp.evaluate('window.__rafLedger ? window.__rafLedger.snapshot() : null');
      if (!entry.ledger) {
        console.log(`[raf-ledger] ${entry.label}: ledger gone — the document reloaded inside the window`);
        continue;
      }
      await entry.cdp.evaluate('window.__rafLedger ? window.__rafLedger.uninstall() : false');
      entry.ledger.removed = true;
    } catch (err) {
      entry.ledger = null;
      console.log(`[raf-ledger] ${entry.label}: FAILED — ${err.message}`);
    } finally {
      entry.cdp.close();
    }
  }

  const rows = buildRows(ledgers.filter((entry) => entry.ledger || entry.error || entry.removed));
  console.log('[raf-ledger] === per document');
  for (const row of rows) {
    console.log(
      `[raf-ledger]   ${row.label.padEnd(20)} ${String(row.visibility ?? '?').padEnd(9)} scheduled ${row.scheduled} (${row.scheduledPerMin}/min) fired ${row.fired} cancelled ${row.cancelled} PENDING ${row.pending} (${row.pendingPerMin}/min)`
    );
    for (const site of row.unresolved.slice(0, 5)) {
      console.log(`[raf-ledger]       ${site.count} (${site.perMin}/min) ${site.stack}`);
    }
  }

  const growing = rows.filter((row) => row.pending > 0);
  console.log(
    growing.length
      ? `[raf-ledger] ${growing.length} document(s) hold unresolved frame callbacks; the call sites above are where they are scheduled.`
      : '[raf-ledger] no document held an unresolved frame callback in this window — frames run everywhere.'
  );

  const summary = summarizeSeries(series);
  for (const row of summary) {
    console.log(
      `[raf-ledger]   series ${row.label.padEnd(20)} seen ${row.visibility.padEnd(15)} samples ${row.samples} (hidden ${row.hiddenSamples}) max pending ${row.maxPending} hidden-max ${row.hiddenMaxPending} growth ${row.pendingGrowth >= 0 ? '+' : ''}${row.pendingGrowth}`
    );
  }
  const hiddenBacklog = summary.filter((row) => row.hiddenWithBacklog);
  if (summary.length) {
    console.log(
      hiddenBacklog.length
        ? `[raf-ledger] ${hiddenBacklog.map((r) => r.label).join(', ')} held frame callbacks while hidden — that backlog is what a heap snapshot counts as retained.`
        : '[raf-ledger] nothing held frame callbacks while hidden in this window.'
    );
  }

  if (args.json) {
    fs.writeFileSync(args.json, JSON.stringify({ port, at: new Date().toISOString(), seconds: args.seconds, interval: args.interval, rows, series, summary }, null, 2));
    console.log(`[raf-ledger] wrote ${args.json}`);
  }
}

main().catch((err) => {
  console.error(`[raf-ledger] ${err.message}`);
  process.exit(1);
});
