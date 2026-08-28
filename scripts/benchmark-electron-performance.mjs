#!/usr/bin/env node
/**
 * AntiFan Electron Performance Benchmark Harness (Phase 1 — baseline).
 *
 * Launches the real Electron app in benchmark mode (ANTIFAN_BENCHMARK=1,
 * isolated user data) and drives scenarios through the product surface
 * (Bridge WebSocket RPC) plus one in-process ArtifactStore micro-benchmark.
 * Emits a machine-readable JSON report and a compact console summary.
 *
 * No fabricated values are ever emitted: a scenario that cannot run is
 * reported as `unmeasured` with the exact prerequisite, never substituted.
 *
 * Usage:
 *   node scripts/benchmark-electron-performance.mjs [--scenario all|cold-start|tabs|terminal|artifact|package] [--runs N] [--reports-dir <dir>]
 *
 * Scenarios:
 *   cold-start  Boot production app with isolated user data to first visible window.
 *   tabs        Open/switch/close tabs via Bridge RPC; record switch latency + attached views.
 *   terminal    Create a PTY session, burst output, measure chunk/byte/ordering.
 *   artifact    In-process ArtifactStore staging at small/max sizes (text, DOM, PNG).
 *   package     npm run compile + scripts/package-windows.mjs; inventory the unpacked output.
 *   packaged    Launch the packaged exe (run --scenario package first); first paint + node-pty smoke.
 *   all         Runs cold-start, tabs, terminal, artifact, package (not 'packaged').
 */
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BENCHMARK_PREFIX = '[antifan-benchmark]';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const idx = args.indexOf(name);
  return idx === -1 ? fallback : args[idx + 1];
}
const SCENARIO = argValue('--scenario', 'all');
const RUNS = Math.max(1, Number.parseInt(argValue('--runs', '1'), 10) || 1);
const REPORTS_DIR = argValue('--reports-dir', path.join(ROOT, 'plans', '260828-1400-measured-performance-optimization', 'reports'));
const LAUNCH_TIMEOUT_MS = 60000;

const electronBin = require('electron');
const isWindows = process.platform === 'win32';

class AppDriver {
  constructor({ label, exe = null }) {
    this.exe = exe; // packaged executable path; null => dev build via node_modules/electron
    this.label = label;
    this.child = null;
    this.lines = [];
    this.metrics = [];
    this.wallStartMs = 0;
    this.userDataDir = null;
    this.configDir = null;
  }

  async launch() {
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-benchmark-data-'));
    this.configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-benchmark-config-'));
    const env = {
      ...process.env,
      ANTIFAN_BENCHMARK: '1',
      ANTIFAN_USER_DATA: this.userDataDir,
      ANTIFAN_CONFIG_DIR: this.configDir,
      NODE_ENV: 'production',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const argv = this.exe ? ['--production'] : [path.join(ROOT, '.'), '--production'];
    this.wallStartMs = performance.now();
    // POSIX only: detached makes the child a process-group leader so kill(-pid) can reap the tree.
    this.child = spawn(this.exe || electronBin, argv, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: !isWindows });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.collectChunk(chunk));
    this.child.stderr.on('data', () => {});
    this.child.on('exit', () => { this.exited = true; });
    return this;
  }

  collectChunk(chunk) {
    this.lines.push(...chunk.split(/\r?\n/));
    if (this.lines.length > 50000) this.lines.splice(0, this.lines.length - 50000);
  }

  parseLines() {
    for (const line of this.lines) {
      if (!line.startsWith(BENCHMARK_PREFIX)) continue;
      const json = line.slice(BENCHMARK_PREFIX.length + 1);
      try {
        const m = JSON.parse(json);
        if (m && typeof m.surface === 'string' && typeof m.name === 'string') this.metrics.push(m);
      } catch {}
    }
  }

  readBridgeInfo() {
    const file = path.join(this.configDir, 'bridge.json');
    const devFile = path.join(this.configDir, 'bridge-dev.json');
    const chosen = fs.existsSync(file) ? file : (fs.existsSync(devFile) ? devFile : null);
    if (!chosen) return null;
    try { return JSON.parse(fs.readFileSync(chosen, 'utf8')); } catch { return null; }
  }

  async waitForMetric(surface, name, timeoutMs = LAUNCH_TIMEOUT_MS) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      this.parseLines();
      const hit = this.metrics.find((m) => m.surface === surface && m.name === name);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  async kill() {
    if (!this.child) return;
    if (this.child.exitCode === null) {
      try {
        if (isWindows) {
          execFileSync('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { process.kill(-this.child.pid, 'SIGKILL'); } catch {}
        }
      } catch {}
      if (this.child.exitCode === null) {
        try { this.child.kill(); } catch {}
      }
    }
    this.child = null;
    const dirs = [this.userDataDir, this.configDir];
    this.userDataDir = null;
    this.configDir = null;
    for (const dir of dirs) {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
  }
}

function percentiles(sorted, ps) {
  const out = {};
  for (const p of ps) {
    if (sorted.length === 0) { out[`p${p}`] = null; continue; }
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    out[`p${p}`] = sorted[idx];
  }
  return out;
}

function errToString(err) {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

function observationRows(rows) {
  const values = (rows || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return { count: 0, values: [], p50: null, p95: null, min: null, max: null };
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    count: sorted.length,
    values: sorted,
    ...percentiles(sorted, [50, 95]),
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

function reportRow(scenario, name, observations, extra = {}) {
  const row = { scenario, name, baselineStatus: observations.count > 0 ? 'measured' : 'unmeasured', sampleCount: observations.count, ...extra };
  if (observations.count > 0) {
    row.p50 = observations.p50;
    row.p95 = observations.p95;
    row.min = observations.min;
    row.max = observations.max;
    row.values = observations.values;
  }
  return row;
}

async function scenarioColdStart(report) {
  const rows = [];
  for (let i = 0; i < RUNS; i++) {
    const driver = new AppDriver({ label: `cold-start-run-${i}` });
    await driver.launch();
    const firstVisible = await driver.waitForMetric('startup', 'firstVisible', LAUNCH_TIMEOUT_MS);
    const bootstrap = driver.metrics.find((m) => m.surface === 'startup' && m.name === 'bootstrap');
    const ready = driver.metrics.find((m) => m.surface === 'startup' && m.name === 'ready');
    const windowCreated = driver.metrics.find((m) => m.surface === 'startup' && m.name === 'windowCreated');
    const processMetric = driver.metrics.find((m) => m.surface === 'process' && m.name === 'afterFirstVisible');
    const reportRun = {
      run: i,
      wallMs: firstVisible ? Math.round(performance.now() - driver.wallStartMs) : null,
      appBootstrapToVisibleMs: (firstVisible && bootstrap) ? Math.round(firstVisible.nowMs - bootstrap.nowMs) : null,
      bootstrapToReadyMs: (bootstrap && ready) ? Math.round(ready.nowMs - bootstrap.nowMs) : null,
      readyToWindowMs: (ready && windowCreated) ? Math.round(windowCreated.nowMs - ready.nowMs) : null,
      windowToVisibleMs: (windowCreated && firstVisible) ? Math.round(firstVisible.nowMs - windowCreated.nowMs) : null,
      firstVisibleNowMs: firstVisible?.nowMs ?? null,
      process: processMetric?.extra?.breakdown ?? null,
      mainRssKB: processMetric?.extra?.mainRssKB ?? null,
    };
    if (reportRun.appBootstrapToVisibleMs !== null) rows.push(reportRun.appBootstrapToVisibleMs);
    report.runs.push(reportRun);
    await driver.kill();
  }
  const obs = observationRows(rows);
  report.rows.push(reportRow('cold-start', 'bootstrapToFirstVisibleMs', obs));
  report.rows.push(reportRow('cold-start', 'bootstrapToReadyMs', observationRows(report.runs.map((r) => r.bootstrapToReadyMs))));
  report.rows.push(reportRow('cold-start', 'readyToWindowMs', observationRows(report.runs.map((r) => r.readyToWindowMs))));
  report.rows.push(reportRow('cold-start', 'windowToFirstVisibleMs', observationRows(report.runs.map((r) => r.windowToVisibleMs))));
  report.summary.push(`cold-start: ${obs.count === 0 ? 'unmeasured (firstVisible not observed; check Electron GUI availability)' : `p50=${obs.p50}ms p95=${obs.p95}ms over ${obs.count} runs`}`);
}

async function scenarioTabs(report) {
  const driver = new AppDriver({ label: 'tabs' });
  await driver.launch();
  const init = await driver.waitForMetric('startup', 'firstVisible', LAUNCH_TIMEOUT_MS);
  if (!init) {
    report.rows.push(reportRow('tabs', 'tabSwitchMs', observationRows([]), { error: 'app never became visible' }));
    report.summary.push('tabs: unmeasured (app not visible)');
    await driver.kill();
    return;
  }
  const info = driver.readBridgeInfo();
  if (!info || !info.token || !info.port) {
    report.rows.push(reportRow('tabs', 'tabSwitchMs', observationRows([]), { error: 'bridge info unreadable (requires token)' }));
    report.summary.push('tabs: unmeasured (bridge info unreadable)');
    await driver.kill();
    return;
  }
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { authorization: `Bearer ${info.token}` } });
  const pending = new Map();
  let counter = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `bench-${counter++}`;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, 15000);
    pending.set(id, (err, data) => { clearTimeout(timeout); err ? reject(err) : resolve(data); });
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const cb = pending.get(msg.id); pending.delete(msg.id);
      msg.success === false ? cb(new Error(msg.error || 'RPC error'), undefined) : cb(null, msg.data);
    }
  });
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await ready;

  const switchDurations = [];
  const attachedAtSwitch = [];
  try {
    const t1 = await rpc('antifan.openTab', { url: 'about:blank' });
    const t2 = await rpc('antifan.openTab', { url: 'about:blank' });
    const t3 = await rpc('antifan.openTab', { url: 'about:blank' });
    const ids = [t1?.tabId, t2?.tabId, t3?.tabId].filter(Boolean);
    for (const id of [...ids].reverse()) {
      const start = performance.now();
      const res = await rpc('antifan.switchTab', { tabId: id });
      const dur = performance.now() - start;
      if (res?.switched) switchDurations.push(dur);
    }
    driver.parseLines();
    attachedAtSwitch.push(...driver.metrics.filter((m) => m.surface === 'tabs' && m.name === 'switched').map((m) => m.extra?.attachedViews ?? null));
    for (const id of ids) { try { await rpc('antifan.closeTab', { tabId: id }); } catch {} }
  } catch (err) {
    report.rows.push(reportRow('tabs', 'tabSwitchMs', observationRows([]), { error: errToString(err) }));
  } finally {
    try { ws.close(); } catch {}
    await driver.kill();
  }
  const obs = observationRows(switchDurations);
  report.rows.push(reportRow('tabs', 'tabSwitchMs', obs, { attachedViewSamples: attachedAtSwitch }));
  report.summary.push(`tabs: ${obs.count === 0 ? 'unmeasured' : `switch p50=${obs.p50.toFixed(1)}ms p95=${obs.p95.toFixed(1)}ms over ${obs.count} samples`}`);
}

async function scenarioTerminal(report) {
  const driver = new AppDriver({ label: 'terminal' });
  await driver.launch();
  const init = await driver.waitForMetric('startup', 'firstVisible', LAUNCH_TIMEOUT_MS);
  if (!init) {
    report.rows.push(reportRow('terminal', 'burst', observationRows([]), { error: 'app never became visible' }));
    report.summary.push('terminal: unmeasured (app not visible)');
    await driver.kill();
    return;
  }
  const info = driver.readBridgeInfo();
  if (!info || !info.token || !info.port) {
    report.rows.push(reportRow('terminal', 'burst', observationRows([]), { error: 'bridge info unreadable' }));
    report.summary.push('terminal: unmeasured (bridge info unreadable)');
    await driver.kill();
    return;
  }
  const { default: WebSocket } = await import('ws');
  const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { authorization: `Bearer ${info.token}` } });
  const pending = new Map();
  const terminalEvents = [];
  let counter = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `bench-t${counter++}`;
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 20000);
    pending.set(id, (err, data) => { clearTimeout(t); err ? reject(err) : resolve(data); });
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  });
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.event === 'antifan:terminal:data') terminalEvents.push(msg.data);
    if (msg.id && pending.has(msg.id)) {
      const cb = pending.get(msg.id); pending.delete(msg.id);
      msg.success === false ? cb(new Error(msg.error || 'RPC error'), undefined) : cb(null, msg.data);
    }
  });
  const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await ready;
  try {
    const created = await rpc('antifan.terminalNewSession', {});
    const sessionId = created?.sessionId;
    if (!sessionId) throw new Error('no session created');
    // Wait for the shell to finish initializing (output idle, non-empty), then flush.
    const shellReadyDeadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let lastObservedLength = 0;
    let lastGrowAt = 0;
    let sawShellData = false;
    while (Date.now() < shellReadyDeadline) {
      if (terminalEvents.length !== lastObservedLength) {
        lastObservedLength = terminalEvents.length;
        lastGrowAt = Date.now();
        sawShellData = true;
      }
      if (sawShellData && Date.now() - lastGrowAt > 400) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    if (!sawShellData) throw new Error('shell produced no data before ready deadline');
    terminalEvents.length = 0;
    // Echo probe: marker is assembled by the shell (sum of two literals), so the raw
    // submitted command never contains the detected text contiguously (input echo cannot fake it).
    const ECHO_A = 20001;
    const ECHO_B = 1;
    const echoSentinel = `bench-echo-${ECHO_A + ECHO_B}`;
    const echoCommand = isWindows
      ? `Write-Output ('bench-echo-' + (${ECHO_A} + ${ECHO_B}))\r`
      : `printf '%s%s\\n' bench-echo- "$((${ECHO_A} + ${ECHO_B}))"\n`;
    const echoStart = performance.now();
    await rpc('antifan.terminalInput', { sessionId, text: echoCommand });
    let echoLatency = null;
    let echoAllText = '';
    const echoDeadline = Date.now() + 8000;
    while (Date.now() < echoDeadline) {
      echoAllText = terminalEvents.map((d) => String(d?.data ?? '')).join('');
      if (echoAllText.includes(echoSentinel)) {
        echoLatency = performance.now() - echoStart;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    const echoChunkCount = terminalEvents.length;
    const echoBytes = terminalEvents.reduce((sum, d) => sum + Buffer.byteLength(String(d?.data ?? ''), 'utf8'), 0);
    terminalEvents.length = 0;
    // Burst: same shell-assembled marker gates completion; everything received is counted.
    const BURST_A = 30001;
    const BURST_B = 1;
    const burstSentinel = `bench-burst-${BURST_A + BURST_B}`;
    const burstCommand = isWindows
      ? `1..1500 | ForEach-Object { $_ }; Write-Output ('bench-burst-' + (${BURST_A} + ${BURST_B}))\r`
      : `seq 1 1500; printf '%s%s\\n' bench-burst- "$((${BURST_A} + ${BURST_B}))"\n`;
    const burstStart = performance.now();
    await rpc('antifan.terminalInput', { sessionId, text: burstCommand });
    let burstAllText = '';
    const burstDeadline = Date.now() + 30000;
    while (Date.now() < burstDeadline) {
      burstAllText = terminalEvents.map((d) => String(d?.data ?? '')).join('');
      if (burstAllText.includes(burstSentinel)) break;
      await new Promise((r) => setTimeout(r, 40));
    }
    const burstMs = performance.now() - burstStart;
    const burstChunkCount = terminalEvents.length;
    const burstBytesTotal = terminalEvents.reduce((s, d) => s + Buffer.byteLength(String(d?.data ?? ''), 'utf8'), 0);
    const burstCompleted = burstAllText.includes(burstSentinel);
    driver.parseLines();
    const echoChunkObs = observationRows(echoLatency === null ? [] : [echoLatency]);
    report.rows.push(reportRow('terminal', 'interactiveEchoLatencyMs', echoChunkObs, { chunkCount: echoChunkCount, bytes: echoBytes, sessionId, nonceMatched: echoLatency !== null }));
    report.rows.push(reportRow('terminal', 'interactiveEchoChunks', observationRows([echoChunkCount]), { bytes: echoBytes }));
    const ptyTotal = driver.metrics.filter((m) => m.surface === 'terminal' && m.name === 'ptyData');
    report.rows.push(reportRow('terminal', 'ptyDataChunks', observationRows([ptyTotal.length]), { bytes: ptyTotal.reduce((s, m) => s + (m.value ?? 0), 0) }));
    if (burstCompleted) {
      report.rows.push(reportRow('terminal', 'burstChunks', observationRows([burstChunkCount]), { bytes: burstBytesTotal, shellMarker: burstSentinel }));
      report.rows.push(reportRow('terminal', 'burstBytes', observationRows([burstBytesTotal]), { inputEchoIncluded: true, burstMs: Math.round(burstMs) }));
      report.summary.push(`terminal: echoLatency=${echoLatency === null ? 'unmeasured' : `${Math.round(echoLatency)}ms`} burst=${burstChunkCount} chunks / ${burstBytesTotal} bytes in ${Math.round(burstMs)}ms`);
    } else {
      report.rows.push(reportRow('terminal', 'burst', observationRows([]), { error: `burst marker ${burstSentinel} not seen in ${Math.round(burstMs)}ms; shell output incomplete` }));
      report.summary.push('terminal: burst unmeasured (shell marker timeout)');
    }
    try { await rpc('antifan.terminalCloseSession', { sessionId }); } catch {}
  } catch (err) {
    report.rows.push(reportRow('terminal', 'burst', observationRows([]), { error: errToString(err) }));
    report.summary.push('terminal: unmeasured ' + errToString(err));
  } finally {
    try { ws.close(); } catch {}
    await driver.kill();
  }
}

async function scenarioArtifact(report) {
  const compiled = path.join(ROOT, '.compiled', 'src', 'main', 'tools', 'artifact-store.js');
  if (!fs.existsSync(compiled)) {
    report.rows.push(reportRow('artifact', 'stage', observationRows([]), { error: `.compiled module missing: ${compiled}` }));
    report.summary.push('artifact: unmeasured (run npm run compile first)');
    return;
  }
  const { ArtifactStore } = require(compiled);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-benchmark-artifacts-'));
  const store = new ArtifactStore({ root, maxArtifactBytes: 8 * 1024 * 1024, maxRunBytes: 32 * 1024 * 1024 });
  const runId = `run-${Date.now()}`;
  const attemptId = 'attempt-1';
  const caseDefs = [
    { name: 'text-small', kind: 'text', mime: 'text/plain', bytes: 1024, binary: false, secret: true },
    { name: 'dom-medium', kind: 'dom', mime: 'text/html', bytes: 256 * 1024, binary: false, secret: false },
    { name: 'png-small', kind: 'screenshot', mime: 'image/png', bytes: 128 * 1024, binary: true, secret: false },
    { name: 'png-max', kind: 'screenshot', mime: 'image/png', bytes: 4 * 1024 * 1024, binary: true, secret: false },
  ];
  for (const c of caseDefs) {
    const durations = [];
    const equality = [];
    const redactedDecisions = [];
    for (let i = 0; i < Math.max(1, RUNS); i++) {
      let payload;
      if (c.binary) payload = deterministicBuffer(c.bytes, i + 1);
      else {
        const base = 'The quick brown fox jumps over the lazy dog 0123456789\n'.repeat(Math.ceil(c.bytes / 54));
        const secret = c.secret ? '\ntoken = sk-abcdef1234567890abcdef1234567890\n' : '';
        payload = (base + secret).slice(0, c.bytes);
      }
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
      const start = performance.now();
      let ref;
      try {
        ref = store.stage({ kind: c.kind, mime: c.mime, data: buf, runId, attemptId, maxBytes: c.bytes });
      } catch (err) {
        report.rows.push(reportRow('artifact', `stage-${c.name}`, observationRows([]), { error: String(err) }));
        continue;
      }
      durations.push(performance.now() - start);
      redactedDecisions.push(ref.redacted);
      if (c.binary) {
        try {
          const out = store.readBytesById(ref.id);
          equality.push(out.data.equals(buf.subarray(0, Math.min(c.bytes, buf.byteLength))));
        } catch { equality.push(false); }
      }
    }
    const obs = observationRows(durations);
    report.rows.push(reportRow('artifact', `stage-${c.name}Ms`, obs, {
      bytes: c.bytes,
      redactedDecisions,
      binaryByteEqual: c.binary ? equality : undefined,
    }));
    report.summary.push(`artifact: ${c.name} stage p50=${obs.p50 === null ? 'unmeasured' : `${obs.p50.toFixed(2)}ms`} bytes=${c.bytes} binaryEqual=${c.binary ? equality.join(',') : 'n/a'}`);
  }
}

function deterministicBuffer(byteLength, seed) {
  const buf = Buffer.alloc(byteLength);
  for (let i = 0; i < byteLength; i++) {
    buf[i] = (i * 31 + 17 * seed) % 256;
  }
  return buf;
}

async function scenarioPackage(report) {
  const manifestPath = path.join(ROOT, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'artifacts', 'windows-x64-manifest.json');
  let manifestMtimeMs = 0;
  try { manifestMtimeMs = fs.statSync(manifestPath).mtimeMs; } catch {}
  try {
    if (isWindows) {
      execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run compile'], { cwd: ROOT, stdio: 'ignore', timeout: 180000 });
    } else {
      execFileSync('npm', ['run', 'compile'], { cwd: ROOT, stdio: 'ignore', timeout: 180000 });
    }
  } catch (err) {
    report.rows.push(reportRow('package', 'build', observationRows([]), { error: `compile failed: ${errToString(err)}` }));
    report.summary.push('package: unmeasured (compile failed)');
    return;
  }
  try {
    execFileSync('node', [path.join(ROOT, 'scripts', 'package-windows.mjs')], { cwd: ROOT, stdio: 'ignore', timeout: 600000 });
  } catch (err) {
    report.rows.push(reportRow('package', 'inventory', observationRows([]), { error: `package-windows.mjs failed: ${String(err)}` }));
    report.summary.push('package: unmeasured (package-windows.mjs failed)');
    return;
  }
  try {
    const fresh = fs.statSync(manifestPath).mtimeMs;
    if (manifestMtimeMs > 0 && fresh <= manifestMtimeMs) {
      report.rows.push(reportRow('package', 'inventory', observationRows([]), { error: 'manifest not refreshed by this run (stale artifact inventory)' }));
      report.summary.push('package: unmeasured (stale manifest)');
      return;
    }
  } catch (err) {
    report.rows.push(reportRow('package', 'inventory', observationRows([]), { error: `manifest unreadable after packaging: ${String(err)}` }));
    report.summary.push('package: unmeasured (manifest unreadable)');
    return;
  }
  let outDir = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    outDir = manifest.outDir;
  } catch {}
  if (!outDir || !fs.existsSync(outDir)) {
    report.rows.push(reportRow('package', 'inventory', observationRows([]), { error: `package output missing: ${outDir || manifestPath}` }));
    report.summary.push('package: unmeasured (output dir missing)');
    return;
  }
  const inventory = { files: 0, totalBytes: 0, exeBytes: 0, exePresent: false, nodePtyDllPresent: false };
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const stat = fs.statSync(full);
        inventory.files += 1;
        inventory.totalBytes += stat.size;
        if (entry.name === 'antifan-browser-desktop.exe') { inventory.exeBytes = stat.size; inventory.exePresent = true; }
        if (entry.name === 'pty.node') inventory.nodePtyDllPresent = true;
      }
    }
  };
  try { walk(outDir); } catch (err) {
    report.rows.push(reportRow('package', 'inventory', observationRows([]), { error: String(err) }));
    report.summary.push('package: unmeasured (inventory walk failed)');
    return;
  }
  report.rows.push(reportRow('package', 'outputDir', observationRows([]), { outDir, ...inventory }));
  report.summary.push(`package: files=${inventory.files} totalBytes=${Math.round(inventory.totalBytes / 1024 / 1024)}MB exePresent=${inventory.exePresent} nodePty=${inventory.nodePtyDllPresent}`);
}

async function scenarioPackaged(report) {
  // Smoke the packaged win32-x64 build: launch the exe, wait for first paint, then
  // create a terminal session over the bridge to prove the node-pty native module
  // loads from the asar (terminalNewSession fails if pty.node cannot be required).
  const manifestPath = path.join(ROOT, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'artifacts', 'windows-x64-manifest.json');
  let exePath = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    exePath = manifest.exePath;
  } catch {}
  if (!exePath || !fs.existsSync(exePath)) {
    report.rows.push(reportRow('packaged', 'launch', observationRows([]), { error: `packaged exe missing (run --scenario package first): ${exePath || manifestPath}` }));
    report.summary.push('packaged: unmeasured (exe missing; package first)');
    return;
  }

  const driver = new AppDriver({ label: 'packaged', exe: exePath });
  await driver.launch();
  const firstVisible = await driver.waitForMetric('startup', 'firstVisible', LAUNCH_TIMEOUT_MS);
  if (!firstVisible) {
    report.rows.push(reportRow('packaged', 'firstVisibleMs', observationRows([]), { error: 'packaged app never became visible' }));
    report.summary.push('packaged: unmeasured (app not visible)');
    await driver.kill();
    return;
  }
  const info = driver.readBridgeInfo();
  if (!info || !info.token || !info.port) {
    report.rows.push(reportRow('packaged', 'firstVisibleMs', observationRows([Math.round(firstVisible.nowMs)]), { error: 'bridge info unreadable; pty smoke skipped' }));
    report.summary.push(`packaged: firstVisible=${Math.round(firstVisible.nowMs)}ms bridge unreadable`);
    await driver.kill();
    return;
  }

  let ptyRow = null;
  try {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}`, { headers: { authorization: `Bearer ${info.token}` } });
    const pending = new Map();
    let counter = 0;
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = `bench-pkg-${counter++}`;
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}`)); }, 20000);
      pending.set(id, (err, data) => { clearTimeout(t); err ? reject(err) : resolve(data); });
      ws.send(JSON.stringify({ id, method, params: params ?? {} }));
    });
    ws.on('message', (raw) => {
      let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const cb = pending.get(msg.id); pending.delete(msg.id);
        msg.success === false ? cb(new Error(msg.error || 'RPC error'), undefined) : cb(null, msg.data);
      }
    });
    const ready = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    await ready;
    const created = await rpc('antifan.terminalNewSession', {});
    const sessionId = created?.sessionId;
    const sessions = await rpc('antifan.terminalListSessions', {});
    const listed = Array.isArray(sessions?.sessions) ? sessions.sessions.some((s) => s && s.id === sessionId) : false;
    if (!sessionId || !listed) throw new Error('terminal session not created/listed in packaged app');
    try { await rpc('antifan.terminalCloseSession', { sessionId }); } catch {}
    ptyRow = reportRow('packaged', 'ptyLoad', observationRows([1]), { sessionId, nativeModule: 'node-pty' });
    try { ws.close(); } catch {}
  } catch (err) {
    ptyRow = reportRow('packaged', 'ptyLoad', observationRows([]), { error: `pty smoke failed: ${errToString(err)}` });
  }
  report.rows.push(reportRow('packaged', 'firstVisibleMs', observationRows([Math.round(firstVisible.nowMs)])));
  if (ptyRow) report.rows.push(ptyRow);
  report.summary.push(`packaged: firstVisible=${Math.round(firstVisible.nowMs)}ms ptyLoad=${ptyRow && ptyRow.sampleCount > 0 ? 'ok' : 'FAILED'}`);
  await driver.kill();
}

async function main() {
  const report = {
    generatedAt: new Date().toISOString(),
    appVersion: '1.3.0',
    runtimeVersion: process.versions.node,
    electronVersion: (() => { try { return require('electron/package.json').version; } catch { return 'unknown'; } })(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    scenario: SCENARIO,
    runCount: RUNS,
    warmCold: 'cold',
    rows: [],
    runs: [],
    summary: [],
  };
  const scenarios = SCENARIO === 'all' ? ['cold-start', 'tabs', 'terminal', 'artifact', 'package'] : [SCENARIO];
  for (const name of scenarios) {
    const t0 = performance.now();
    switch (name) {
      case 'cold-start': await scenarioColdStart(report); break;
      case 'tabs': await scenarioTabs(report); break;
      case 'terminal': await scenarioTerminal(report); break;
      case 'artifact': await scenarioArtifact(report); break;
      case 'package': await scenarioPackage(report); break;
      case 'packaged': await scenarioPackaged(report); break;
      default: report.rows.push(reportRow(name, 'unknown', observationRows([]), { error: `unknown scenario: ${name}` }));
    }
    report.summary.push(`${name} took ${Math.round(performance.now() - t0)}ms`);
  }

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportFile = path.join(REPORTS_DIR, `phase-1-baseline-${stamp}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
  console.log('='.repeat(72));
  console.log(' AntiFan Electron Performance Baseline (Phase 1)');
  console.log(` Report: ${reportFile}`);
  console.log('='.repeat(72));
  for (const s of report.summary) console.log(` - ${s}`);
  console.log('='.repeat(72));
  console.log(' Raw JSON rows:');
  console.log(JSON.stringify(report.rows, null, 2));
}

main().catch((err) => {
  console.error('[antifan-benchmark] fatal:', err);
  process.exit(1);
});