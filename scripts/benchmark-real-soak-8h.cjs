#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — 8-Hour Real Multi-Process Runtime Soak Benchmark
 * 
 * Phases:
 * 1. Warm-up (30m): 6 tabs opened, terminal spawned, caches warmed.
 * 2. Active Workload (420m / 7h): Continuous tab switching, page reloads, terminal streaming bursts, split reviews.
 * 3. Recovery (30m): Tabs closed, terminal closed, idle recovery measurement.
 * 
 * Persists live checkpoints every 10 minutes to prevent data loss.
 */

const { createRequire } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');
const { performance } = require('node:perf_hooks');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const req = createRequire(path.join(PROJECT_ROOT, 'package.json'));
const electronBin = req('electron');
const WebSocket = req('ws');

const TOTAL_MINUTES = parseFloat(process.env.SOAK_DURATION_MINUTES || '480');
const WARMUP_MINUTES = parseFloat(process.env.SOAK_WARMUP_MINUTES || '30');
const RECOVERY_MINUTES = parseFloat(process.env.SOAK_RECOVERY_MINUTES || '30');
const WORKLOAD_MINUTES = Math.max(0.1, TOTAL_MINUTES - WARMUP_MINUTES - RECOVERY_MINUTES);
const SAMPLE_INTERVAL_SECONDS = parseFloat(process.env.SOAK_SAMPLE_INTERVAL_SECONDS || '60');
const SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_SECONDS * 1000;
function spawnKeepAwakeProcess() {
  if (process.platform !== 'win32') return null;
  const psScript = `
    $code = @'
    using System;
    using System.Runtime.InteropServices;
    public class KeepAwake {
        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern int SetThreadExecutionState(int esFlags);
    }
'@
    Add-Type -TypeDefinition $code
    $ES_CONTINUOUS = [int]0x80000000
    $ES_SYSTEM_REQUIRED = 0x00000001
    $ES_AWAYMODE_REQUIRED = 0x00000040
    $flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED
    $res = [KeepAwake]::SetThreadExecutionState($flags)
    Write-Output "KEEP_AWAKE_ACTIVE:$res"
    while ($true) {
        Start-Sleep -Seconds 30
        [KeepAwake]::SetThreadExecutionState($flags)
    }
  `;
  try {
    const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', psScript], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout.on('data', (d) => {
      if (d.toString().includes('KEEP_AWAKE_ACTIVE')) {
        console.log(`[soak] Windows keep-awake active (PID: ${p.pid}, SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED)`);
      }
    });
    p.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.warn(`[soak] Windows keep-awake process exited with code ${code}`);
      }
    });
    return p;
  } catch (err) {
    console.warn('[soak] Failed to spawn keep-awake process:', err.message);
    return null;
  }
}
const FREEZE_SLO = {
  overallSlopeMBPerMin: 0.35,
  rendererSlopeMBPerMin: 0.15,
  peakTotalWorkingSetMB: 1600, // <= 1.6 GB
  switchLatencyP50Ms: 12,
  switchLatencyP95Ms: 18,
  switchLatencyMaxMs: 35,
  maxOrphans: 0,
};

const REPORTS_DIR = path.join(PROJECT_ROOT, 'plans', 'reports', 'runtime-verification');
fs.mkdirSync(REPORTS_DIR, { recursive: true });
const CHECKPOINT_PATH = path.join(REPORTS_DIR, 'real-soak-8h-checkpoint.json');
const FINAL_REPORT_PATH = path.join(REPORTS_DIR, 'real-soak-8h.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function quantiles(values) {
  if (!values.length) return { min: null, p50: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    min: sorted[0],
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
    max: sorted[sorted.length - 1],
  };
}

function evaluateFreezeVerdict(meta, metrics, orphanPidsCount) {
  const overallSlope = metrics.overallActiveSlopeMBPerMin;
  const rendererSlope = metrics.rendererActiveSlopeMBPerMin;
  const hasValidSlope = overallSlope !== null && rendererSlope !== null;
  const maxActive = metrics.activeWorkingSetMB?.max || 0;
  const switchP50 = metrics.switchLatencyMs?.p50 || 0;
  const switchP95 = metrics.switchLatencyMs?.p95 || 0;
  const switchMax = metrics.switchLatencyMs?.max || 0;

  const slopeOk = hasValidSlope && overallSlope <= FREEZE_SLO.overallSlopeMBPerMin && rendererSlope <= FREEZE_SLO.rendererSlopeMBPerMin;
  const memoryOk = maxActive <= FREEZE_SLO.peakTotalWorkingSetMB;
  const latencyOk = switchP50 <= FREEZE_SLO.switchLatencyP50Ms && switchP95 <= FREEZE_SLO.switchLatencyP95Ms && switchMax <= FREEZE_SLO.switchLatencyMaxMs;
  const processOk = meta.processQuerySuccess === true && (orphanPidsCount || 0) <= FREEZE_SLO.maxOrphans;
  const executionOk = !meta.executionError && !meta.childExitedPrematurely;

  const isPassed = slopeOk && memoryOk && latencyOk && processOk && executionOk;
  return {
    isPassed,
    slopeOk,
    memoryOk,
    latencyOk,
    processOk,
    executionOk,
    verdict: isPassed ? 'PASSED' : 'FAILED',
  };
}
function calculateSlope(samples, key, timeKey = 'activeAt') {
  if (!samples || samples.length < 2) return null;
  const t0 = samples[0][timeKey] ?? samples[0].at;
  const xs = samples.map((s) => ((s[timeKey] ?? s.at) - t0) / 60000);
  const ys = samples.map((s) => Number(s[key] || 0));
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

function execFilePromise(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(err, { stdout, stderr }));
      resolve(stdout);
    });
  });
}

async function getWindowsProcessTable() {
  const cmd = "$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,CommandLine; $p | ConvertTo-Json -Compress";
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const raw = await execFilePromise('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', cmd], {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        timeout: 30000,
      });
      const parsed = JSON.parse(raw.trim() || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      return { ok: true, rows };
    } catch (err) {
      lastError = err;
      console.warn(`[soak] Process table query attempt ${attempt}/3 failed: ${err.message}`);
      if (attempt < 3) await sleep(2000);
    }
  }
  return { ok: false, rows: [], error: lastError?.message || 'Unknown error' };
}

function collectProcessTree(allProcesses, rootPid) {
  const byParent = new Map();
  for (const p of allProcesses) {
    const parentId = Number(p.ParentProcessId);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(p);
  }
  const tree = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = allProcesses.find((p) => Number(p.ProcessId) === pid);
    if (row) tree.push(row);
    for (const child of byParent.get(pid) || []) {
      stack.push(Number(child.ProcessId));
    }
  }
  return tree;
}

function classifyProcess(row, rootPid) {
  const pid = Number(row.ProcessId);
  const cmd = String(row.CommandLine || '').toLowerCase();
  if (pid === rootPid) return 'browser';
  if (cmd.includes('--type=renderer')) return 'renderer';
  if (cmd.includes('--type=gpu-process')) return 'gpu';
  if (cmd.includes('--type=utility')) return 'utility';
  return 'other';
}

async function sampleMetrics(rootPid, label, totalSuspendedMs = 0) {
  const procResult = await getWindowsProcessTable();
  if (!procResult.ok) {
    return { ok: false, error: `Process table query failed during sample (${label}): ${procResult.error}` };
  }
  const all = procResult.rows;
  const tree = collectProcessTree(all, rootPid);
  const byType = {};
  let totalMB = 0;
  for (const r of tree) {
    const mb = Number(r.WorkingSetSize || 0) / (1024 * 1024);
    totalMB += mb;
    const t = classifyProcess(r, rootPid);
    if (!byType[t]) byType[t] = { count: 0, workingSetMB: 0 };
    byType[t].count++;
    byType[t].workingSetMB += mb;
  }
  for (const k of Object.keys(byType)) {
    byType[k].workingSetMB = Number(byType[k].workingSetMB.toFixed(2));
  }
  const now = Date.now();
  return {
    ok: true,
    sample: {
      at: now,
      activeAt: now - totalSuspendedMs,
      label,
      totalWorkingSetMB: Number(totalMB.toFixed(2)),
      processCount: tree.length,
      byType,
      pids: tree.map((r) => Number(r.ProcessId)),
    },
  };
}

function calculateRollingSlopes(samples, windowMinutes = 60) {
  const windowMs = windowMinutes * 60 * 1000;
  const slopes = [];
  if (samples.length < 10) return slopes;
  const startT = samples[0].activeAt ?? samples[0].at;
  const endT = samples[samples.length - 1].activeAt ?? samples[samples.length - 1].at;
  for (let t = startT + windowMs; t <= endT; t += 10 * 60 * 1000) {
    const windowSamples = samples.filter((s) => {
      const sat = s.activeAt ?? s.at;
      return sat >= t - windowMs && sat <= t;
    });
    if (windowSamples.length >= 5) {
      slopes.push({
        at: new Date(t).toISOString(),
        slopeMBPerMin: Number(calculateSlope(windowSamples, 'totalWorkingSetMB', 'activeAt').toFixed(4)),
        sampleCount: windowSamples.length,
      });
    }
  }
  return slopes;
}


function buildReportPayload(meta) {
  const {
    startedAt,
    finishedAt,
    rootPid,
    fixturePort,
    requestCount,
    tabIds,
    switches,
    bursts,
    reloads,
    terminalEvents,
    samples,
    switchLatencies,
    orphanPids,
    stdout,
    stderr,
    status,
  } = meta;

  const warmupSamples = samples.filter((s) => s.label === 'warmup');
  const activeSamples = samples.filter((s) => s.label === 'workload');
  const recoverySamples = samples.filter((s) => s.label === 'recovery');

  const totals = activeSamples.map((s) => s.totalWorkingSetMB);
  const rendererTotals = activeSamples.map((s) => s.byType?.renderer?.workingSetMB || 0);

  return {
    status: status || 'completed',
    startedAt,
    finishedAt: finishedAt || new Date().toISOString(),
    config: {
      totalMinutes: TOTAL_MINUTES,
      warmupMinutes: WARMUP_MINUTES,
      workloadMinutes: WORKLOAD_MINUTES,
      recoveryMinutes: RECOVERY_MINUTES,
    },
    rootPid,
    fixturePort,
    stats: {
      requestCount,
      openedTabs: tabIds.length,
      switches,
      bursts,
      reloads,
      terminalEventsCount: terminalEvents.length,
      totalSamples: samples.length,
      totalSuspendedMinutes: meta.totalSuspendedMinutes || 0,
      activeWorkloadMinutes: meta.activeWorkloadMinutes || 0,
    },
    metrics: (() => {
      const rawMetrics = {
        switchLatencyMs: quantiles(switchLatencies.map((v) => Number(v.toFixed(3)))),
        activeWorkingSetMB: quantiles(totals),
        activeRendererWorkingSetMB: quantiles(rendererTotals),
        overallActiveSlopeMBPerMin: calculateSlope(activeSamples, 'totalWorkingSetMB', 'activeAt') !== null ? Number(calculateSlope(activeSamples, 'totalWorkingSetMB', 'activeAt').toFixed(6)) : null,
        overallActiveSlopeMBPerHour: calculateSlope(activeSamples, 'totalWorkingSetMB', 'activeAt') !== null ? Number((calculateSlope(activeSamples, 'totalWorkingSetMB', 'activeAt') * 60).toFixed(4)) : null,
        rendererActiveSlopeMBPerMin: calculateSlope(activeSamples.map((s) => ({ activeAt: s.activeAt ?? s.at, rMB: s.byType?.renderer?.workingSetMB || 0 })), 'rMB', 'activeAt') !== null
          ? Number(calculateSlope(activeSamples.map((s) => ({ activeAt: s.activeAt ?? s.at, rMB: s.byType?.renderer?.workingSetMB || 0 })), 'rMB', 'activeAt').toFixed(6))
          : null,
        rendererActiveSlopeMBPerHour: calculateSlope(activeSamples.map((s) => ({ activeAt: s.activeAt ?? s.at, rMB: s.byType?.renderer?.workingSetMB || 0 })), 'rMB', 'activeAt') !== null
          ? Number((calculateSlope(activeSamples.map((s) => ({ activeAt: s.activeAt ?? s.at, rMB: s.byType?.renderer?.workingSetMB || 0 })), 'rMB', 'activeAt') * 60).toFixed(4))
          : null,
        rolling60MinSlopes: calculateRollingSlopes(activeSamples, 60),
        initialLoadedMB: samples[0]?.totalWorkingSetMB || null,
        postWarmupMB: warmupSamples[warmupSamples.length - 1]?.totalWorkingSetMB || null,
        finalActiveMB: activeSamples[activeSamples.length - 1]?.totalWorkingSetMB || null,
        recoveredMB: recoverySamples[recoverySamples.length - 1]?.totalWorkingSetMB || null,
      };
      const evaluation = evaluateFreezeVerdict(meta, rawMetrics, (orphanPids || []).length);
      return {
        ...rawMetrics,
        slopeSloSatisfied: evaluation.slopeOk,
        memorySloSatisfied: evaluation.memoryOk,
        latencySloSatisfied: evaluation.latencyOk,
        orphanSloSatisfied: evaluation.processOk,
        executionSloSatisfied: evaluation.executionOk,
        verdict: evaluation.verdict,
      };
    })(),
    samples,
    stderrTail: (stderr || '').split(/\r?\n/).filter(Boolean).slice(-40),
    stdoutBenchmarkTail: (stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('[antifan-benchmark]'))
      .slice(-40),
  };
}

async function main() {
  console.log(`========================================================================`);
  console.log(`  AntiFan Browser Desktop — Real Multi-Process Soak Benchmark (${TOTAL_MINUTES}m)`);
  console.log(`  Warmup: ${WARMUP_MINUTES}m | Workload: ${WORKLOAD_MINUTES}m | Recovery: ${RECOVERY_MINUTES}m`);
  console.log(`========================================================================`);

  const startedAt = new Date().toISOString();
  const soakDataDir = fs.existsSync('E:/Work')
    ? 'E:/Work/.antifan-soak-8h'
    : path.join(os.tmpdir(), 'antifan-soak-8h');

  try { fs.rmSync(soakDataDir, { recursive: true, force: true }); } catch {}
  const configDir = path.join(soakDataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  const keepAwakeProcess = spawnKeepAwakeProcess();
  // 1. Start Local Fixture Server
  let requestCount = 0;
  let fixturePort = null;
  let fixtureServer = null;
  let child = null;
  let ws = null;
  let tabIds = [];
  let sessionId = null;
  let isIntentionalTeardown = false;
  let childExitedPrematurely = false;
  let childExitCode = null;
  let executionError = null;
  let interruptedSignal = null;
  let stdout = '';
  let stderr = '';
  const samples = [];
  const switchLatencies = [];
  const terminalEvents = [];
  let switches = 0;
  let bursts = 0;
  let reloads = 0;
  let seq = 0;
  const pending = new Map();

  let recoveryTeardownDone = false;
  let totalSuspendedMs = 0;
  const onSignal = (sig) => {
    if (!interruptedSignal) {
      interruptedSignal = sig;
      console.log(`[soak] Received ${sig}, initiating graceful abort through teardown lifecycle...`);
    }
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const stateMeta = {
    startedAt,
    rootPid: null,
    fixturePort: null,
    tabIds,
    terminalEvents,
    samples,
    switchLatencies,
    requestCount: 0,
    switches: 0,
    bursts: 0,
    reloads: 0,
    totalSuspendedMinutes: 0,
    activeWorkloadMinutes: 0,
    stdout: '',
    stderr: '',
  };

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error('WebSocket is not open'));
    }
    const id = `soak-${seq++}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout for ${method}`));
    }, 30000);
    pending.set(id, {
      resolve: (data) => { clearTimeout(timer); resolve(data); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    try {
      ws.send(JSON.stringify({ id, method, params }));
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(err);
    }
  });

  fixtureServer = http.createServer((req_, res) => {
    requestCount++;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(`
      <!doctype html>
      <meta charset="utf-8">
      <title>AntiFan Storefront Soak Fixture</title>
      <style>
        body { font-family: system-ui, sans-serif; margin: 20px; background: #0f172a; color: #f8fafc; }
        .hero { padding: 24px; background: #1e293b; border-radius: 8px; border: 1px solid #334155; }
        .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 16px; }
        .card { padding: 12px; background: #1e293b; border-radius: 6px; border: 1px solid #334155; }
      </style>
      <div class="hero">
        <h1>Storefront Simulation</h1>
        <p>Continuous DOM mutation active.</p>
        <div id="ticker">0</div>
      </div>
      <div class="grid">
        <div class="card">Item 1</div>
        <div class="card">Item 2</div>
        <div class="card">Item 3</div>
        <div class="card">Item 4</div>
      </div>
      <script>
        let count = 0;
        setInterval(() => {
          count++;
          document.title = 'Fixture [' + count + '] ' + location.pathname;
          const el = document.getElementById('ticker');
          if (el) el.textContent = 'Tick: ' + count + ' | ' + new Date().toISOString();
        }, 200);
      </script>
    `);
  });

  await new Promise((resolve, reject) => {
    fixtureServer.once('error', reject);
    fixtureServer.listen(0, '127.0.0.1', resolve);
  });
  fixturePort = fixtureServer.address().port;
  stateMeta.fixturePort = fixturePort;
  console.log(`[soak] Fixture server running at http://127.0.0.1:${fixturePort}`);

  try {
    // 2. Launch Production Electron Runtime
    const env = {
      ...process.env,
      ANTIFAN_BENCHMARK: '1',
      ANTIFAN_DATA_ROOT: soakDataDir,
      ANTIFAN_USER_DATA: path.join(soakDataDir, 'Profile'),
      ANTIFAN_CONFIG_DIR: configDir,
      NODE_ENV: 'production',
    };
    delete env.ELECTRON_RUN_AS_NODE;

    console.log('[soak] Launching Electron app...');
    child = spawn(electronBin, [PROJECT_ROOT, '--production'], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stateMeta.rootPid = child.pid;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-300000); });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-300000); });
    child.on('exit', (code, signal) => {
      if (!isIntentionalTeardown) {
        childExitedPrematurely = true;
        childExitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
        console.error(`[soak] Electron child process exited unexpectedly with code ${code}, signal ${signal}`);
      }
    });
    child.on('error', (err) => {
      if (!isIntentionalTeardown) {
        childExitedPrematurely = true;
        console.error('[soak] Electron child process error:', err.message);
      }
    });
    const bridgePath = path.join(configDir, 'bridge.json');
    let bridge = null;
    for (let i = 0; i < 240; i++) {
      if (interruptedSignal) throw new Error(`Interrupted by ${interruptedSignal}`);
      if (fs.existsSync(bridgePath)) {
        try {
          bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
          if (bridge.port && bridge.token) break;
        } catch {}
      }
      await sleep(250);
    }
    if (interruptedSignal) throw new Error(`Interrupted by ${interruptedSignal}`);
    if (!bridge) throw new Error('Bridge server failed to initialize.');
    console.log(`[soak] Bridge server connected on port ${bridge.port}`);
    ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.event === 'antifan:terminal:data') terminalEvents.push(msg.data);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.success === false) {
          p.reject(new Error(msg.error || 'RPC failed'));
        } else {
          p.resolve(msg.data);
        }
      }
    });

    // 4. Setup tabs and terminal
    const tabUrls = [
      `http://127.0.0.1:${fixturePort}/store-home`,
      `http://127.0.0.1:${fixturePort}/collection-featured`,
      `http://127.0.0.1:${fixturePort}/product-test-1`,
      `http://127.0.0.1:${fixturePort}/product-test-2`,
      'https://example.com',
      'https://www.wikipedia.org',
    ];
    console.log(`[soak] Opening ${tabUrls.length} tabs...`);
    for (const url of tabUrls) {
      try {
        const res = await rpc('antifan.openTab', { url });
        if (res && res.tabId) tabIds.push(res.tabId);
      } catch (err) {
        console.warn(`[soak] Failed to open tab ${url}:`, err.message);
      }
      await sleep(200);
    }

    console.log('[soak] Spawning terminal session...');
    const termRes = await rpc('antifan.terminalNewSession', {});
    sessionId = termRes?.sessionId;
    if (!sessionId) throw new Error('Failed to create terminal session.');

  const saveCheckpoint = () => {
    stateMeta.requestCount = requestCount;
    stateMeta.switches = switches;
    stateMeta.bursts = bursts;
    stateMeta.reloads = reloads;
    stateMeta.stdout = stdout;
    stateMeta.stderr = stderr;
    const payload = buildReportPayload({ ...stateMeta, status: 'in-progress' });
    try {
      fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(payload, null, 2), 'utf8');
      console.log(`[soak-checkpoint] Saved ${samples.length} samples to ${path.basename(CHECKPOINT_PATH)} | RAM: ${samples[samples.length - 1]?.totalWorkingSetMB}MB`);
    } catch (err) {
      console.warn('[soak] Failed to write checkpoint:', err.message);
    }
  };

  const initialRes = await sampleMetrics(child.pid, 'warmup');
  if (initialRes.ok && initialRes.sample) {
    samples.push(initialRes.sample);
  } else {
    console.warn('[soak] Initial sample warning:', initialRes.error);
  }

  const startTime = Date.now();
  let warmupEndTime = startTime + WARMUP_MINUTES * 60 * 1000;
  let workloadEndTime = warmupEndTime + WORKLOAD_MINUTES * 60 * 1000;
  let totalEndTime = workloadEndTime + RECOVERY_MINUTES * 60 * 1000;
  totalSuspendedMs = 0;
  let consecutiveSampleErrors = 0;

  console.log(`[soak] Phase 1: Warmup started (until ${new Date(warmupEndTime).toLocaleTimeString()})`);

  let nextSampleTime = startTime;
  let nextSwitchTime = startTime;
  let nextBurstTime = startTime;
  let nextReloadTime = startTime;
  let lastCheckpointTime = startTime;
  while (Date.now() < totalEndTime) {
    if (interruptedSignal) {
      throw new Error(`Interrupted by ${interruptedSignal}`);
    }
    if (childExitedPrematurely) {
      console.error(`[soak] Aborting soak loop early due to child process exit (code: ${childExitCode})`);
      stateMeta.finishedAt = new Date().toISOString();
      stateMeta.status = 'failed';
      stateMeta.error = `Child process exited unexpectedly with code ${childExitCode}`;
      saveCheckpoint();
      throw new Error(`Child process exited unexpectedly with code ${childExitCode}`);
    }
    const now = Date.now();
    stateMeta.activeWorkloadMinutes = Number(((now - startTime - totalSuspendedMs) / 60000).toFixed(2));
    const currentPhase = now < warmupEndTime ? 'warmup' : now < workloadEndTime ? 'workload' : 'recovery';
    if (currentPhase === 'recovery' && !recoveryTeardownDone) {
      recoveryTeardownDone = true;
      console.log('[soak] Phase 3: Recovery started. Closing tabs and terminal session to measure clean idle recovery...');
      if (ws && tabIds.length > 0) {
        for (const id of tabIds) {
          try { await rpc('antifan.closeTab', { tabId: id }); } catch {}
        }
      }
      if (ws && sessionId) {
        try { await rpc('antifan.terminalCloseSession', { sessionId }); } catch {}
      }
    }
    if (currentPhase !== 'recovery' && now >= nextSwitchTime && tabIds.length > 0) {
      const tabId = tabIds[switches % tabIds.length];
      const t0 = performance.now();
      try {
        const sw = await rpc('antifan.switchTab', { tabId });
        if (sw && sw.switched) {
          switchLatencies.push(performance.now() - t0);
          switches++;
        }
      } catch {}
      nextSwitchTime = now + 3000; // Switch tab every 3s
    }
    // 2. Terminal Bursts (every 30s in warmup & workload)
    if (currentPhase !== 'recovery' && now >= nextBurstTime) {
      try {
        const marker = 100000 + bursts;
        await rpc('antifan.terminalInput', {
          sessionId,
          text: `1..300 | ForEach-Object { $_ }; Write-Output ('AF_8H_SOAK_' + (${marker} + 1))\r`,
        });
        bursts++;
      } catch {}
      nextBurstTime = now + 30000;
    }

    // 3. Periodic Page Reload (every 90s in workload phase)
    if (currentPhase === 'workload' && now >= nextReloadTime && tabIds.length > 0) {
      const tabId = tabIds[reloads % tabIds.length];
      try {
        await rpc('antifan.reload', { tabId });
        reloads++;
      } catch {}
      nextReloadTime = now + 90000;
    }

    // 4. Sample Metrics (every SAMPLE_INTERVAL_MS, default 60s)
    if (now >= nextSampleTime) {
      try {
        const res = await sampleMetrics(child.pid, currentPhase, totalSuspendedMs);
        if (res.ok && res.sample) {
          samples.push(res.sample);
          consecutiveSampleErrors = 0;
        } else {
          consecutiveSampleErrors++;
          console.warn(`[soak] Metric sample failure (${consecutiveSampleErrors} consecutive): ${res.error}`);
          if (consecutiveSampleErrors >= 5) {
            throw new Error(`Critical: Exceeded maximum consecutive sample failures (5): ${res.error}`);
          }
        }
      } catch (err) {
        if (consecutiveSampleErrors >= 5) {
          throw err;
        }
      }
      nextSampleTime = now + SAMPLE_INTERVAL_MS;
    }

    // 5. Periodic Checkpoint (every 10 minutes)
    if (now - lastCheckpointTime >= 10 * 60 * 1000) {
      saveCheckpoint();
      lastCheckpointTime = now;
    }

    const preSleep = Date.now();
    await sleep(100);
    const postSleep = Date.now();
    const sleepDelta = postSleep - preSleep;
    if (sleepDelta > 5000) {
      const suspendedMs = sleepDelta - 100;
      totalSuspendedMs += suspendedMs;
      warmupEndTime += suspendedMs;
      workloadEndTime += suspendedMs;
      totalEndTime += suspendedMs;
      stateMeta.totalSuspendedMinutes = Number((totalSuspendedMs / 60000).toFixed(2));
      console.warn(`[soak] Machine sleep/suspension detected! Sleep delta ${sleepDelta}ms (gap: ${(suspendedMs / 60000).toFixed(2)} min). Adjusted deadlines to guarantee full 8h active workload.`);
    }
  }
  } catch (err) {
    executionError = err;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    console.log('[soak] Soak workload phase concluded. Running guaranteed resource teardown...');
    if (keepAwakeProcess && keepAwakeProcess.pid) {
      try { process.kill(keepAwakeProcess.pid); } catch {}
    }
    isIntentionalTeardown = true;

    if (ws && tabIds.length > 0) {
      for (const id of tabIds) {
        try { await rpc('antifan.closeTab', { tabId: id }); } catch {}
      }
    }
    if (ws && sessionId) {
      try { await rpc('antifan.terminalCloseSession', { sessionId }); } catch {}
    }

    if (child && child.pid && !executionError) {
      try {
        console.log('[soak] Measuring final recovery state...');
        await sleep(10000);
        const recRes = await sampleMetrics(child.pid, 'recovery', totalSuspendedMs);
        if (recRes.ok && recRes.sample) {
          samples.push(recRes.sample);
        } else {
          console.warn('[soak] Recovery state sampling warning:', recRes.error);
        }
      } catch (recErr) {
        console.error('[soak] Recovery state sampling failed:', recErr.message);
      }
    }
    const pidsBeforeKill = [...new Set(samples.flatMap((s) => s.pids))];
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (child && child.pid) {
      try {
        await execFilePromise('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 10000,
        });
      } catch {}
    }

    if (fixtureServer) {
      try { fixtureServer.close(); } catch {}
    }

    await sleep(3000);
    const postShutdownResult = await getWindowsProcessTable();
    const processQuerySuccess = postShutdownResult.ok;
    const afterProcesses = postShutdownResult.rows;
    const alivePidSet = new Set(afterProcesses.map((p) => Number(p.ProcessId)));
    const orphanPids = pidsBeforeKill.filter((pid) => alivePidSet.has(pid));

    // Save final report
    stateMeta.finishedAt = new Date().toISOString();
    stateMeta.orphanPids = orphanPids;
    stateMeta.processQuerySuccess = processQuerySuccess;
    stateMeta.requestCount = requestCount;
    stateMeta.switches = switches;
    stateMeta.bursts = bursts;
    stateMeta.reloads = reloads;
    stateMeta.stdout = stdout;
    stateMeta.stderr = stderr;
    if (executionError) {
      stateMeta.error = executionError.message;
    }

    const finalPayload = buildReportPayload({
      ...stateMeta,
      status: executionError ? 'failed' : (childExitedPrematurely ? 'failed' : 'completed'),
      executionError: executionError ? executionError.message : (childExitedPrematurely ? 'child_exited_prematurely' : undefined),
    });
    const isPassed = finalPayload.metrics.verdict === 'PASSED';
    finalPayload.status = isPassed ? 'completed' : 'failed';
    fs.writeFileSync(FINAL_REPORT_PATH, JSON.stringify(finalPayload, null, 2), 'utf8');
    console.log(`[soak] Final report saved to ${FINAL_REPORT_PATH}`);

    console.log('========================================================================');
    console.log(`  AntiFan 8-Hour Soak Verdict: ${isPassed ? 'PASSED' : 'FAILED'}`);
    if (executionError) {
      console.error(`  Execution Error: ${executionError.message}`);
    }
    console.log(`  Initial Loaded: ${finalPayload.metrics.initialLoadedMB} MB`);
    console.log(`  Post-Warmup: ${finalPayload.metrics.postWarmupMB} MB`);
    console.log(`  Final Active p50: ${finalPayload.metrics.activeWorkingSetMB.p50} MB (Peak Max: ${finalPayload.metrics.activeWorkingSetMB.max} MB, SLO <= ${FREEZE_SLO.peakTotalWorkingSetMB} MB)`);
    console.log(`  Recovered: ${finalPayload.metrics.recoveredMB} MB`);
    console.log(`  Overall Slope: ${finalPayload.metrics.overallActiveSlopeMBPerMin !== null ? finalPayload.metrics.overallActiveSlopeMBPerMin + ' MB/min' : 'N/A'} (SLO <= ${FREEZE_SLO.overallSlopeMBPerMin} MB/min)`);
    console.log(`  Renderer Slope: ${finalPayload.metrics.rendererActiveSlopeMBPerMin !== null ? finalPayload.metrics.rendererActiveSlopeMBPerMin + ' MB/min' : 'N/A'} (SLO <= ${FREEZE_SLO.rendererSlopeMBPerMin} MB/min)`);
    console.log(`  Tab Switch Latency: p50=${finalPayload.metrics.switchLatencyMs.p50}ms (SLO <= ${FREEZE_SLO.switchLatencyP50Ms}ms), p95=${finalPayload.metrics.switchLatencyMs.p95}ms (SLO <= ${FREEZE_SLO.switchLatencyP95Ms}ms), max=${finalPayload.metrics.switchLatencyMs.max}ms (SLO <= ${FREEZE_SLO.switchLatencyMaxMs}ms)`);
    console.log(`  Orphan Processes: ${orphanPids.length} (Query OK: ${processQuerySuccess}, SLO = ${FREEZE_SLO.maxOrphans})`);
    console.log('========================================================================');

    if (!isPassed) {
      console.error(`[soak] FAILED: SLO violations or execution failure detected (slopeOk: ${finalPayload.metrics.slopeSloSatisfied}, memoryOk: ${finalPayload.metrics.memorySloSatisfied}, latencyOk: ${finalPayload.metrics.latencySloSatisfied}, processOk: ${finalPayload.metrics.orphanSloSatisfied}, executionOk: ${finalPayload.metrics.executionSloSatisfied})`);
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('[soak] Fatal error:', err);
  process.exitCode = 1;
});
