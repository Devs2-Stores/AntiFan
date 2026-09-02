#!/usr/bin/env node
/**
 * AntiFan Browser Desktop — Standalone Recovery & Reclamation Benchmark (Phase 05 Conforming)
 * 
 * Invariants:
 * 1. Tracks startedAt from exact launch time.
 * 2. Fail-closed process querying: throws on failed process table queries rather than masking.
 * 3. Immediately registers child.pid into observedPids upon spawn.
 * 4. Collects the strict UNION of all PIDs observed across loaded baseline and every recovery sample.
 * 5. Enforces full try/finally lifecycle teardown (WebSocket, Fixture HTTP Server, Process Tree Taskkill).
 * 6. Always emits an atomic structured JSON report even on unexpected failure/abort (status: 'failed' / 'passed').
 * 7. Primary Phase 05 SLO: Zero Orphan Processes post teardown.
 */

const { createRequire } = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFile } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const req = createRequire(path.join(PROJECT_ROOT, 'package.json'));
const electronBin = req('electron');
const WebSocket = req('ws');

const RECOVERY_DURATION_MINUTES = parseInt(process.env.RECOVERY_DURATION_MINUTES || '30', 10);
const REPORTS_DIR = path.join(PROJECT_ROOT, 'plans', 'reports', 'runtime-verification');
fs.mkdirSync(REPORTS_DIR, { recursive: true });
const FINAL_REPORT_PATH = path.join(REPORTS_DIR, 'standalone-recovery-30m.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const raw = await execFilePromise('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', cmd], {
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15000,
  });
  const parsed = JSON.parse(raw.trim() || '[]');
  const list = Array.isArray(parsed) ? parsed : [parsed];
  if (!list.length) {
    throw new Error('Process table query returned empty result unexpectedly.');
  }
  return list;
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
  if (!tree.length) {
    throw new Error(`Process tree for root PID ${rootPid} was empty or not found.`);
  }
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

async function main() {
  const startedAt = new Date().toISOString();
  console.log('========================================================================');
  console.log(`  AntiFan Browser Desktop — Standalone Recovery Benchmark (${RECOVERY_DURATION_MINUTES}m)`);
  console.log('========================================================================');

  const recoveryDataDir = path.join(os.tmpdir(), `antifan-recovery-${Date.now()}`);
  const configDir = path.join(recoveryDataDir, 'config');
  fs.mkdirSync(configDir, { recursive: true });

  let fixtureServer = null;
  let child = null;
  let ws = null;
  const observedPids = new Set();
  const samples = [];
  let loadedSample = null;
  let finalRecoverySample = null;
  let childExited = false;
  let childExitCode = null;
  let executionError = null;

  try {
    // 1. Fixture Server
    fixtureServer = http.createServer((req_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body><h1>Recovery Benchmark Fixture</h1><p>${req_.url}</p></body></html>`);
    });

    await new Promise((resolve, reject) => {
      fixtureServer.once('error', reject);
      fixtureServer.listen(0, '127.0.0.1', resolve);
    });
    const fixturePort = fixtureServer.address().port;
    console.log(`[recovery] Fixture server running at http://127.0.0.1:${fixturePort}`);

    const env = {
      ...process.env,
      ANTIFAN_BENCHMARK: '1',
      ANTIFAN_DATA_ROOT: recoveryDataDir,
      ANTIFAN_USER_DATA: path.join(recoveryDataDir, 'Profile'),
      ANTIFAN_CONFIG_DIR: configDir,
      NODE_ENV: 'production',
    };
    delete env.ELECTRON_RUN_AS_NODE;

    // 2. Launch Electron
    console.log('[recovery] Launching Electron app...');
    child = spawn(electronBin, [PROJECT_ROOT, '--production'], {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    if (child.pid) {
      observedPids.add(child.pid);
    }

    child.on('exit', (code, signal) => {
      childExited = true;
      childExitCode = typeof code === 'number' ? code : (signal ? 1 : 0);
    });
    child.on('error', (err) => {
      childExited = true;
      console.error('[recovery] Electron child error:', err.message);
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

    console.log(`[recovery] Bridge server connected on port ${bridge.port}`);
    ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
      headers: { authorization: `Bearer ${bridge.token}` },
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    let seq = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
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
      const id = `rec-${seq++}`;
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

    // Induced failure support for test verification
    if (process.env.INDUCED_FAILURE === '1') {
      throw new Error('Induced test failure during setup');
    }

    // 3. Setup tabs and terminal
    const tabUrls = [
      `http://127.0.0.1:${fixturePort}/store-home`,
      `http://127.0.0.1:${fixturePort}/collections/all`,
      `http://127.0.0.1:${fixturePort}/products/t-shirt`,
      `http://127.0.0.1:${fixturePort}/cart`,
      `http://127.0.0.1:${fixturePort}/pages/about`,
      `http://127.0.0.1:${fixturePort}/blogs/news`,
    ];
    const tabIds = [];
    console.log(`[recovery] Opening ${tabUrls.length} tabs...`);
    for (const url of tabUrls) {
      const res = await rpc('antifan.openTab', { url });
      if (res?.tabId) {
        tabIds.push(res.tabId);
      } else {
        throw new Error(`Failed to receive tabId for ${url}`);
      }
      await sleep(250);
    }

    console.log(`[recovery] Successfully opened 6 tabs: [${tabIds.join(', ')}]`);

    console.log('[recovery] Spawning terminal session...');
    const termRes = await rpc('antifan.terminalNewSession', {});
    const sessionId = termRes?.sessionId;
    if (!sessionId) throw new Error('Failed to create terminal session.');
    console.log(`[recovery] Terminal session active: ${sessionId}`);

    await sleep(5000);
    loadedSample = await sampleMetrics(child.pid, 'loaded');
    samples.push(loadedSample);
    loadedSample.pids.forEach((p) => observedPids.add(p));
    console.log(`[recovery] Baseline Loaded RAM: ${loadedSample.totalWorkingSetMB} MB (${loadedSample.processCount} processes)`);

    // 4. Close all resources to initiate recovery
    console.log('[recovery] Closing tabs and terminal to start recovery phase...');
    for (const id of tabIds) {
      await rpc('antifan.closeTab', { tabId: id });
    }
    await rpc('antifan.terminalCloseSession', { sessionId });
    console.log('[recovery] All 6 tabs and terminal session closed successfully.');

    // 5. Monitor recovery over RECOVERY_DURATION_MINUTES
    const recoveryEndTime = Date.now() + RECOVERY_DURATION_MINUTES * 60 * 1000;
    console.log(`[recovery] Monitoring recovery for ${RECOVERY_DURATION_MINUTES} minutes (until ${new Date(recoveryEndTime).toLocaleTimeString()})...`);

    while (Date.now() < recoveryEndTime) {
      if (childExited) {
        throw new Error(`Child process exited unexpectedly during recovery (code: ${childExitCode})`);
      }
      await sleep(10000);
      const s = await sampleMetrics(child.pid, 'recovering');
      samples.push(s);
      s.pids.forEach((p) => observedPids.add(p));
    }

    finalRecoverySample = samples[samples.length - 1];
    console.log(`[recovery] Final Recovered RAM: ${finalRecoverySample.totalWorkingSetMB} MB (${finalRecoverySample.processCount} processes)`);
  } catch (err) {
    executionError = err;
    console.error('[recovery] Execution error encountered:', err.message);
  } finally {
    // Guaranteed Teardown
    console.log('[recovery] Performing guaranteed cleanup of Electron, WebSocket, and Fixture...');
    if (ws) {
      try { ws.close(); } catch {}
    }
    if (fixtureServer) {
      try { fixtureServer.close(); } catch {}
    }
    if (child && child.pid) {
      try {
        await execFilePromise('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch {}
    }
  }

  // 6. Post-shutdown verification across strict union of all observed PIDs
  await sleep(3000);
  let orphanPids = [];
  let postShutdownQueryError = null;
  try {
    const postShutdownProcs = await getWindowsProcessTable();
    orphanPids = Array.from(observedPids).filter((p) => postShutdownProcs.some((row) => Number(row.ProcessId) === p));
  } catch (err) {
    postShutdownQueryError = err;
    console.error('[recovery] Post-shutdown process table query failed:', err.message);
  }

  const loadedMB = loadedSample ? loadedSample.totalWorkingSetMB : null;
  const recoveredMB = finalRecoverySample ? finalRecoverySample.totalWorkingSetMB : null;
  const reclaimedMB = loadedMB && recoveredMB ? Number((loadedMB - recoveredMB).toFixed(2)) : null;
  const reclaimPct = loadedMB && reclaimedMB ? Number(((reclaimedMB / loadedMB) * 100).toFixed(2)) : null;
  
  // Phase 05 Release SLO: zero orphan processes post teardown, zero query errors, zero fatal execution errors
  const passSLO = executionError === null && postShutdownQueryError === null && orphanPids.length === 0;

  const report = {
    test: 'Standalone Recovery & Reclamation Benchmark (Phase 05 Conforming)',
    status: passSLO ? 'passed' : 'failed',
    error: (executionError || postShutdownQueryError) ? (executionError?.message || postShutdownQueryError?.message) : null,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMinutes: RECOVERY_DURATION_MINUTES,
    totalObservedPids: Array.from(observedPids),
    loadedWorkingSetMB: loadedMB,
    finalRecoveredWorkingSetMB: recoveredMB,
    reclaimedMB,
    reclaimPercentage: reclaimPct,
    orphanProcessCount: orphanPids.length,
    orphanPids,
    sampleCount: samples.length,
    samples,
  };

  fs.writeFileSync(FINAL_REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
  console.log(`[recovery] Final report saved to: ${FINAL_REPORT_PATH}`);
  console.log(`========================================================================`);
  console.log(`  Recovery Benchmark Verdict: ${passSLO ? 'PASSED (Zero Orphans)' : 'FAILED (' + (executionError?.message || 'Orphans Detected') + ')'}`);
  console.log(`  Loaded Baseline: ${loadedMB ?? 'N/A'} MB`);
  console.log(`  Final Recovered: ${recoveredMB ?? 'N/A'} MB`);
  console.log(`  Reclaimed: ${reclaimedMB ?? 'N/A'} MB (${reclaimPct ?? 'N/A'}%)`);
  console.log(`  Total Observed PIDs: ${observedPids.size}`);
  console.log(`  Orphan Processes: ${orphanPids.length}`);
  console.log(`========================================================================`);

  if (!passSLO) {
    process.exitCode = 1;
  }
}

main();
