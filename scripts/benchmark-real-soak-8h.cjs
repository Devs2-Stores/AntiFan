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

const TOTAL_MINUTES = parseInt(process.env.SOAK_DURATION_MINUTES || '480', 10);
const WARMUP_MINUTES = parseInt(process.env.SOAK_WARMUP_MINUTES || '30', 10);
const RECOVERY_MINUTES = parseInt(process.env.SOAK_RECOVERY_MINUTES || '30', 10);
const WORKLOAD_MINUTES = Math.max(1, TOTAL_MINUTES - WARMUP_MINUTES - RECOVERY_MINUTES);

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

function calculateSlope(samples, key) {
  if (samples.length < 2) return 0;
  const t0 = samples[0].at;
  const xs = samples.map((s) => (s.at - t0) / 60000);
  const ys = samples.map((s) => s[key]);
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
  try {
    const raw = await execFilePromise('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', cmd], {
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 15000,
    });
    const parsed = JSON.parse(raw.trim() || '[]');
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    console.warn('[soak] Failed to query process table:', err.message);
    return [];
  }
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

async function sampleMetrics(rootPid, label) {
  const all = await getWindowsProcessTable();
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
  return {
    at: Date.now(),
    label,
    totalWorkingSetMB: Number(totalMB.toFixed(2)),
    processCount: tree.length,
    byType,
    pids: tree.map((r) => Number(r.ProcessId)),
  };
}

function calculateRollingSlopes(samples, windowMinutes = 60) {
  const windowMs = windowMinutes * 60 * 1000;
  const slopes = [];
  if (samples.length < 10) return slopes;
  const startT = samples[0].at;
  const endT = samples[samples.length - 1].at;
  for (let t = startT + windowMs; t <= endT; t += 10 * 60 * 1000) {
    const windowSamples = samples.filter((s) => s.at >= t - windowMs && s.at <= t);
    if (windowSamples.length >= 5) {
      slopes.push({
        at: new Date(t).toISOString(),
        slopeMBPerMin: Number(calculateSlope(windowSamples, 'totalWorkingSetMB').toFixed(4)),
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
    },
    metrics: {
      switchLatencyMs: quantiles(switchLatencies.map((v) => Number(v.toFixed(3)))),
      activeWorkingSetMB: quantiles(totals),
      activeRendererWorkingSetMB: quantiles(rendererTotals),
      overallActiveSlopeMBPerMin: Number(calculateSlope(activeSamples, 'totalWorkingSetMB').toFixed(4)),
      rendererActiveSlopeMBPerMin: Number(
        calculateSlope(
          activeSamples.map((s) => ({ at: s.at, rMB: s.byType?.renderer?.workingSetMB || 0 })),
          'rMB'
        ).toFixed(4)
      ),
      rolling60MinSlopes: calculateRollingSlopes(activeSamples, 60),
      initialLoadedMB: samples[0]?.totalWorkingSetMB || null,
      postWarmupMB: warmupSamples[warmupSamples.length - 1]?.totalWorkingSetMB || null,
      finalActiveMB: activeSamples[activeSamples.length - 1]?.totalWorkingSetMB || null,
      recoveredMB: recoverySamples[recoverySamples.length - 1]?.totalWorkingSetMB || null,
    },
    orphanPids: orphanPids || [],
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

  // 1. Start Local Fixture Server
  let requestCount = 0;
  const fixtureServer = http.createServer((req_, res) => {
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
  const fixturePort = fixtureServer.address().port;
  console.log(`[soak] Fixture server running at http://127.0.0.1:${fixturePort}`);

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
  const child = spawn(electronBin, [PROJECT_ROOT, '--production'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let childExited = false;
  let childExitCode = null;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => { stdout = (stdout + d).slice(-300000); });
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-300000); });
  child.on('exit', (code, signal) => {
    childExited = true;
    childExitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
    console.error(`[soak] Electron child process exited unexpectedly with code ${code}, signal ${signal}`);
  });
  child.on('error', (err) => {
    childExited = true;
    console.error('[soak] Electron child process error:', err.message);
  });
  const bridgePath = path.join(configDir, 'bridge.json');
  let bridge = null;
  for (let i = 0; i < 240; i++) {
    if (fs.existsSync(bridgePath)) {
      try {
        bridge = JSON.parse(fs.readFileSync(bridgePath, 'utf8'));
        if (bridge.port && bridge.token) break;
      } catch {}
    }
    await sleep(250);
  }
  if (!bridge) throw new Error('Bridge server failed to initialize.');

  console.log(`[soak] Bridge server connected on port ${bridge.port}`);
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  let seq = 0;
  const pending = new Map();
  const terminalEvents = [];

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

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
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

  // 4. Setup tabs and terminal
  const tabUrls = [
    `http://127.0.0.1:${fixturePort}/store-home`,
    `http://127.0.0.1:${fixturePort}/collection-featured`,
    `http://127.0.0.1:${fixturePort}/product-test-1`,
    `http://127.0.0.1:${fixturePort}/product-test-2`,
    'https://example.com',
    'https://www.wikipedia.org',
  ];
  const tabIds = [];
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
  const sessionId = termRes?.sessionId;
  if (!sessionId) throw new Error('Failed to create terminal session.');

  const samples = [];
  const switchLatencies = [];
  let switches = 0;
  let bursts = 0;
  let reloads = 0;

  const stateMeta = {
    startedAt,
    rootPid: child.pid,
    fixturePort,
    tabIds,
    terminalEvents,
    samples,
    switchLatencies,
    requestCount: 0,
    switches: 0,
    bursts: 0,
    reloads: 0,
    stdout: '',
    stderr: '',
  };

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

  // Safe handler for unexpected termination
  const handleExit = async () => {
    console.log('[soak] Graceful shutdown triggered...');
    stateMeta.finishedAt = new Date().toISOString();
    saveCheckpoint();
  };
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);

  // Initial sample
  samples.push(await sampleMetrics(child.pid, 'warmup'));

  const startTime = Date.now();
  const warmupEndTime = startTime + WARMUP_MINUTES * 60 * 1000;
  const workloadEndTime = warmupEndTime + WORKLOAD_MINUTES * 60 * 1000;
  const totalEndTime = workloadEndTime + RECOVERY_MINUTES * 60 * 1000;

  console.log(`[soak] Phase 1: Warmup started (until ${new Date(warmupEndTime).toLocaleTimeString()})`);

  let nextSampleTime = startTime;
  let nextSwitchTime = startTime;
  let nextBurstTime = startTime;
  let nextReloadTime = startTime;
  let lastCheckpointTime = startTime;

  while (Date.now() < totalEndTime) {
    if (childExited) {
      console.error(`[soak] Aborting soak loop early due to child process exit (code: ${childExitCode})`);
      stateMeta.finishedAt = new Date().toISOString();
      stateMeta.status = 'failed';
      stateMeta.error = `Child process exited unexpectedly with code ${childExitCode}`;
      saveCheckpoint();
      throw new Error(`Child process exited unexpectedly with code ${childExitCode}`);
    }
    const now = Date.now();
    const currentPhase = now < warmupEndTime ? 'warmup' : now < workloadEndTime ? 'workload' : 'recovery';

    // 1. Tab Switching (Active in warmup & workload)
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

    // 4. Sample Metrics (every 10 seconds)
    if (now >= nextSampleTime) {
      try {
        const s = await sampleMetrics(child.pid, currentPhase);
        samples.push(s);
      } catch (err) {
        console.warn('[soak] Sample failed:', err.message);
      }
      nextSampleTime = now + 10000;
    }

    // 5. Periodic Checkpoint (every 10 minutes)
    if (now - lastCheckpointTime >= 10 * 60 * 1000) {
      saveCheckpoint();
      lastCheckpointTime = now;
    }

    await sleep(100);
  }

  console.log('[soak] Soak duration complete. Cleaning up resources...');

  // Close tabs and terminal
  for (const id of tabIds) {
    try { await rpc('antifan.closeTab', { tabId: id }); } catch {}
  }
  try { await rpc('antifan.terminalCloseSession', { sessionId }); } catch {}

  console.log('[soak] Measuring final recovery state...');
  await sleep(15000);
  samples.push(await sampleMetrics(child.pid, 'recovery'));

  const pidsBeforeKill = [...new Set(samples.flatMap((s) => s.pids))];
  try { ws.close(); } catch {}
  try {
    await execFilePromise('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      timeout: 10000,
    });
  } catch {}

  await sleep(3000);
  const afterProcesses = await getWindowsProcessTable();
  const alivePidSet = new Set(afterProcesses.map((p) => Number(p.ProcessId)));
  const orphanPids = pidsBeforeKill.filter((pid) => alivePidSet.has(pid));

  fixtureServer.close();

  // Save final report
  stateMeta.finishedAt = new Date().toISOString();
  stateMeta.orphanPids = orphanPids;
  stateMeta.requestCount = requestCount;
  stateMeta.switches = switches;
  stateMeta.bursts = bursts;
  stateMeta.reloads = reloads;
  stateMeta.stdout = stdout;
  stateMeta.stderr = stderr;

  const finalPayload = buildReportPayload({ ...stateMeta, status: 'completed' });
  fs.writeFileSync(FINAL_REPORT_PATH, JSON.stringify(finalPayload, null, 2), 'utf8');
  console.log(`[soak] Final report saved to ${FINAL_REPORT_PATH}`);

  console.log('========================================================================');
  console.log('  AntiFan 8-Hour Soak Completed Successfully');
  console.log(`  Initial Loaded: ${finalPayload.metrics.initialLoadedMB} MB`);
  console.log(`  Post-Warmup: ${finalPayload.metrics.postWarmupMB} MB`);
  console.log(`  Final Active p50: ${finalPayload.metrics.activeWorkingSetMB.p50} MB`);
  console.log(`  Recovered: ${finalPayload.metrics.recoveredMB} MB`);
  console.log(`  Overall Slope: ${finalPayload.metrics.overallActiveSlopeMBPerMin} MB/min`);
  console.log(`  Renderer Slope: ${finalPayload.metrics.rendererActiveSlopeMBPerMin} MB/min`);
  console.log(`  Orphan Processes: ${orphanPids.length}`);
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('[soak] Fatal error:', err);
  process.exit(1);
});
