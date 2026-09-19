#!/usr/bin/env node
// The child app accepts an injected master token only when ANTIFAN_BENCHMARK=1, so this harness mints
// the token and passes it to the isolated instance it owns; nothing is read from or written to disk.

const { randomUUID } = require('node:crypto');

function redactCreds(val) {
  const str = typeof val === 'string' ? val : (val instanceof Error ? (val.stack || val.message) : String(val ?? ''));
  return str
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.~+/=]+/gi, '$1[REDACTED]')
    .replace(/((?:token|secret|code)=)[^&\s]*/gi, '$1[REDACTED]')
    .replace(/(["']?(?:token|secret|code)["']?\s*[:=]\s*["'])[^"']+(["'])/gi, '$1[REDACTED]$2');
}
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
// Filled in by `main()` once the run's data root is known. The process-tree walk uses
// these to tell this run's processes from another application's.
const appTreeMarkers = { projectRoot: PROJECT_ROOT, userDataDir: '' };
const electronBin = req('electron');
const WebSocket = req('ws');

const TOTAL_MINUTES = parseFloat(process.env.SOAK_DURATION_MINUTES || '480');
const WARMUP_MINUTES = parseFloat(process.env.SOAK_WARMUP_MINUTES || '30');
const RECOVERY_MINUTES = parseFloat(process.env.SOAK_RECOVERY_MINUTES || '30');
const WORKLOAD_MINUTES = Math.max(0.1, TOTAL_MINUTES - WARMUP_MINUTES - RECOVERY_MINUTES);
const SAMPLE_INTERVAL_SECONDS = parseFloat(process.env.SOAK_SAMPLE_INTERVAL_SECONDS || '60');
const SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_SECONDS * 1000;
// Workload intensity is the independent variable of a throughput claim: two runs
// are only comparable when the driver rate is known, so every knob is overridable
// and every value is echoed into the report. Defaults are unchanged, which keeps
// historical runs comparable.
const SWITCH_INTERVAL_MS = Math.max(50, parseInt(process.env.SOAK_SWITCH_INTERVAL_MS || '3000', 10));
const BURST_INTERVAL_MS = Math.max(500, parseInt(process.env.SOAK_BURST_INTERVAL_MS || '30000', 10));
const BURST_LINES = Math.max(1, parseInt(process.env.SOAK_BURST_LINES || '300', 10));
const TAB_ROUNDS = Math.max(1, parseInt(process.env.SOAK_TAB_ROUNDS || '1', 10));
// The fixture pages mutate their title and a text node on a timer, which is the
// workload's only high-frequency page event: the title storm drives the app's
// state broadcast. Exposing the tick makes that rate an experiment variable
// instead of a constant nobody can isolate.
const FIXTURE_TICK_MS = Math.max(20, parseInt(process.env.SOAK_FIXTURE_TICK_MS || '200', 10));
// A run tag suffixes both artifacts: an 8h soak, a 20m diagnostic and a re-run on a
// fixed bundle must not overwrite each other's evidence.
const REPORT_TAG = String(process.env.SOAK_REPORT_TAG || '').replace(/[^a-z0-9-]/gi, '').slice(0, 32);
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
  let keepAlive = true;
  let currentProcess = null;

  function launch() {
    if (!keepAlive) return;
    try {
      const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', psScript], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      currentProcess = p;
      p.stdout.on('data', (d) => {
        if (d.toString().includes('KEEP_AWAKE_ACTIVE')) {
          console.log(`[soak] Windows keep-awake active (PID: ${p.pid}, SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED|ES_AWAYMODE_REQUIRED)`);
        }
      });
      p.on('exit', (code) => {
        if (keepAlive) {
          console.warn(`[soak] Windows keep-awake process exited with code ${code}, auto-respawning in 2s...`);
          setTimeout(launch, 2000);
        }
      });
    } catch (err) {
      console.warn('[soak] Failed to spawn keep-awake process:', err.message);
    }
  }

  launch();

  return {
    get pid() {
      return currentProcess?.pid;
    },
    kill() {
      keepAlive = false;
      if (currentProcess) {
        try {
          currentProcess.kill();
        } catch (_) {}
      }
    },
  };
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
const REPORT_SUFFIX = REPORT_TAG ? `-${REPORT_TAG}` : '';
const CHECKPOINT_PATH = path.join(REPORTS_DIR, `real-soak-8h${REPORT_SUFFIX}-checkpoint.json`);
const FINAL_REPORT_PATH = path.join(REPORTS_DIR, `real-soak-8h${REPORT_SUFFIX}.json`);

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
  // The latency gate reads the workload phase — `switchLatencyMs` is that series now.
  // An absent series must not pass: `quantiles([])` returns nulls, and falling back to
  // 0 would read every bound as satisfied.
  const switchCount = metrics.switchLatencyWorkloadCount || 0;
  const switchP50 = metrics.switchLatencyMs?.p50 ?? Infinity;
  const switchP95 = metrics.switchLatencyMs?.p95 ?? Infinity;
  const switchMax = metrics.switchLatencyMs?.max ?? Infinity;

  // Criterion 2 is the app-owned per-process maximum in committed private bytes, which
  // is strictly tighter than the working-set walk it supplements rather than a
  // replacement for it: on the 4 h run the walk summed five app renderers (plus Zalo's
  // three) to −0.056 MB/min while the one growing process inside them read +0.17, and
  // the app Tab *sum* read +0.14 — a sum is satisfiable by adding a flat process. Both
  // conditions must hold, and the private series must exist.
  const appPrivateSlope = metrics.appPrivateMaxSlopeMBPerMin;
  const privateSlopeMeasured = typeof appPrivateSlope === 'number';
  const privateSlopeOk = privateSlopeMeasured && appPrivateSlope <= FREEZE_SLO.rendererSlopeMBPerMin;
  const slopeOk = hasValidSlope
    && overallSlope <= FREEZE_SLO.overallSlopeMBPerMin
    && rendererSlope <= FREEZE_SLO.rendererSlopeMBPerMin
    && privateSlopeOk;
  const memoryOk = maxActive <= FREEZE_SLO.peakTotalWorkingSetMB;
  const latencyOk = switchCount > 0 && switchP50 <= FREEZE_SLO.switchLatencyP50Ms && switchP95 <= FREEZE_SLO.switchLatencyP95Ms && switchMax <= FREEZE_SLO.switchLatencyMaxMs;
  const processOk = meta.processQuerySuccess === true && (orphanPidsCount || 0) <= FREEZE_SLO.maxOrphans;
  const executionOk = !meta.executionError && !meta.childExitedPrematurely;
  const teardownOk = !meta.teardownTelemetry?.teardownDegraded;

  const isPassed = slopeOk && memoryOk && latencyOk && processOk && executionOk && teardownOk;
  const isDegraded = slopeOk && memoryOk && latencyOk && processOk && executionOk && !teardownOk;
  const verdict = isPassed ? 'PASSED' : (isDegraded ? 'TEARDOWN_DEGRADED' : 'FAILED');

  return {
    isPassed,
    isDegraded,
    slopeOk,
    privateSlopeOk,
    privateSlopeMeasured,
    switchCount,
    memoryOk,
    latencyOk,
    processOk,
    executionOk,
    teardownOk,
    verdict,
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

// Windows recycles pids, so a walk by parent pid can adopt a process whose real parent
// is long gone: Zalo.exe's 11 processes (526.4 MB) hung off this app's own crashpad
// handler on the 4 h run, and every gate built from the walk then measured someone
// else's memory. An edge is therefore accepted only for a process this app can own —
// its command line names this run's app tree or profile, or it is one of the PTY
// executables the terminal spawns. A refusal is recorded, never silently dropped, so a
// wrong refusal is visible in the report instead of being a quiet smaller footprint.
const APP_PTY_EXECUTABLES = new Set([
  'winpty.exe', 'winpty-agent.exe', 'conhost.exe', 'openconsole.exe', 'powershell.exe', 'pwsh.exe',
]);

function normalizeForMatch(value) {
  return String(value || '').toLowerCase().replace(/\\/g, '/');
}

// A plain substring test would also accept a sibling instance launched from another
// worktree (`.../AntiFan-wt-mobile-plane-gates`), so the marker must end a path segment.
function commandNamesPath(cmd, target) {
  const c = normalizeForMatch(cmd);
  const t = normalizeForMatch(target).replace(/\/+$/, '');
  if (!t) return false;
  return c.includes(`${t}/`) || c.includes(`${t} `) || c.endsWith(t);
}

function isAppOwnedProcess(row, markers) {
  const cmd = String(row.CommandLine || '');
  if (commandNamesPath(cmd, markers.userDataDir)) return true;
  if (commandNamesPath(cmd, markers.projectRoot)) return true;
  return APP_PTY_EXECUTABLES.has(String(row.Name || '').toLowerCase());
}

function collectProcessTree(allProcesses, rootPid, markers = {}) {
  const byParent = new Map();
  for (const p of allProcesses) {
    const parentId = Number(p.ParentProcessId);
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(p);
  }
  const tree = [];
  const refused = [];
  const stack = [rootPid];
  const seen = new Set();
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = allProcesses.find((p) => Number(p.ProcessId) === pid);
    if (row) tree.push(row);
    for (const child of byParent.get(pid) || []) {
      const childPid = Number(child.ProcessId);
      if (!isAppOwnedProcess(child, markers)) {
        refused.push({
          pid: childPid,
          name: String(child.Name || ''),
          workingSetMB: Number((Number(child.WorkingSetSize || 0) / (1024 * 1024)).toFixed(2)),
        });
        continue;
      }
      stack.push(childPid);
    }
  }
  return { tree, refused };
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
  const { tree, refused } = collectProcessTree(all, rootPid, appTreeMarkers);
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
      // What the app-scoped walk refused, so the reader can see that the series is
      // named after its owner rather than assume a smaller footprint is a better one.
      refusedProcessCount: refused.length,
      refusedProcessWorkingSetMB: Number(refused.reduce((a, r) => a + r.workingSetMB, 0).toFixed(2)),
      refusedProcessNames: Array.from(new Set(refused.map((r) => r.name))).sort(),
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
      const totalSlope = calculateSlope(windowSamples, 'totalWorkingSetMB', 'activeAt');
      const rendererSlope = calculateSlope(
        windowSamples.map((s) => ({ activeAt: s.activeAt ?? s.at, rMB: s.byType?.renderer?.workingSetMB || 0 })),
        'rMB',
        'activeAt'
      );
      slopes.push({
        at: new Date(t).toISOString(),
        totalSlopeMBPerMin: totalSlope !== null ? Number(totalSlope.toFixed(4)) : null,
        rendererSlopeMBPerMin: rendererSlope !== null ? Number(rendererSlope.toFixed(4)) : null,
        slopeMBPerMin: totalSlope !== null ? Number(totalSlope.toFixed(4)) : null,
        sampleCount: windowSamples.length,
      });
    }
  }
  return slopes;
}

/**
 * The app's benchmark stream carries a per-process memory row once a minute, each
 * tagged with the role of the WebContents in that process. It is consumed as it
 * arrives rather than from the retained stdout buffer: that buffer is tail-capped,
 * so on a multi-hour run the earliest samples — the ones a growth series is
 * measured from — would be the first to disappear.
 */
function createBenchmarkStreamIngest() {
  let pending = '';
  const samples = [];
  return {
    samples,
    push(chunk) {
      pending += chunk;
      // A line that never terminates must not grow without bound; benchmark lines
      // are small and newline-terminated, so anything larger is a partial write.
      if (pending.length > 1024 * 1024) pending = pending.slice(-1024 * 1024);
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('[antifan-benchmark] ')) continue;
        let metric;
        try {
          metric = JSON.parse(line.slice('[antifan-benchmark] '.length));
        } catch {
          continue;
        }
        if (metric?.surface !== 'process' || !Array.isArray(metric?.extra?.processes)) continue;
        const at = Date.parse(metric.ts);
        if (!Number.isFinite(at)) continue;
        samples.push({
          at,
          name: String(metric.name || ''),
          processes: metric.extra.processes.map((p) => ({
            pid: Number(p.pid),
            type: String(p.type || ''),
            role: String(p.role || ''),
            url: String(p.url || ''),
            workingSetMB: Number((Number(p.workingSetKB || 0) / 1024).toFixed(2)),
            privateBytesMB: Number((Number(p.privateBytesKB || 0) / 1024).toFixed(2)),
          })),
        });
      }
    },
  };
}

/**
 * Per-process slopes inside one wall-clock window. The aggregate renderer slope
 * sums five processes, so it can only say *that* renderer memory grew; this is
 * what says *which* process grew and what it was hosting.
 */
function calculatePerProcessSlopes(processSamples, windowStart, windowEnd) {
  // A non-finite bound means the caller has no workload samples yet, and an empty
  // series is the honest answer: the two finite-checks below would skip their bounds
  // and hand back a whole-run slope in a field that reads as windowed, which is how
  // an early checkpoint printed 8 populated slopes beside an empty `activeWorkingSetMB`.
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return [];
  const byPid = new Map();
  for (const sample of processSamples) {
    if (Number.isFinite(windowStart) && sample.at < windowStart) continue;
    if (Number.isFinite(windowEnd) && sample.at > windowEnd) continue;
    for (const proc of sample.processes) {
      if (!Number.isInteger(proc.pid) || proc.pid <= 0) continue;
      let record = byPid.get(proc.pid);
      if (!record) {
        record = { pid: proc.pid, type: proc.type, role: proc.role, url: proc.url, points: [] };
        byPid.set(proc.pid, record);
      }
      if (proc.role) record.role = proc.role;
      if (proc.url) record.url = proc.url;
      record.points.push({ at: sample.at, mb: proc.workingSetMB, privateMb: proc.privateBytesMB });
    }
  }
  const slopes = [];
  for (const record of byPid.values()) {
    if (record.points.length < 3) continue;
    const slope = calculateSlope(record.points, 'mb', 'at');
    const privateSlope = calculateSlope(record.points, 'privateMb', 'at');
    if (slope === null) continue;
    const first = record.points[0];
    const last = record.points[record.points.length - 1];
    slopes.push({
      pid: record.pid,
      type: record.type,
      role: record.role,
      url: record.url,
      samples: record.points.length,
      firstWorkingSetMB: first.mb,
      lastWorkingSetMB: last.mb,
      deltaWorkingSetMB: Number((last.mb - first.mb).toFixed(2)),
      firstPrivateMB: first.privateMb,
      lastPrivateMB: last.privateMb,
      deltaPrivateMB: Number((last.privateMb - first.privateMb).toFixed(2)),
      slopeMBPerMin: Number(slope.toFixed(4)),
      // Committed private bytes are the currency a retention gate may use; working set
      // moves with shared pages and OS trimming, so the same process read +1.0874 MB/min
      // in working set and −0.1775 in private bytes across one 8-minute window.
      slopePrivateMBPerMin: privateSlope === null ? null : Number(privateSlope.toFixed(4)),
      // Carried per row so a slope is never ambiguous about the window it was fitted to.
      windowStart,
      windowEnd,
    });
  }
  slopes.sort((a, b) => b.slopeMBPerMin - a.slopeMBPerMin);
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
    terminalEventCount,
    samples,
    switchLatencies,
    switchSamples,
    switchLatencyByTab,
    tabUrlById,
    processSamples,
    orphanPids,
    stdout,
    stderr,
    status,
    teardownTelemetry,
  } = meta;
  const warmupSamples = samples.filter((s) => s.label === 'warmup');
  const activeSamples = samples.filter((s) => s.label === 'workload');
  const recoverySamples = samples.filter((s) => s.label === 'recovery');

  const totals = activeSamples.map((s) => s.totalWorkingSetMB);
  const rendererTotals = activeSamples.map((s) => s.byType?.renderer?.workingSetMB || 0);

  // The process series is wall-clock (`at`), so the window boundaries come from the
  // wall-clock stamps of the workload samples rather than from their sleep-adjusted
  // `activeAt`.
  const processSeries = Array.isArray(processSamples) ? processSamples : [];
  const perProcessSlopes = calculatePerProcessSlopes(
    processSeries,
    activeSamples.length > 0 ? activeSamples[0].at : NaN,
    activeSamples.length > 0 ? activeSamples[activeSamples.length - 1].at : NaN
  );
  const slowSwitchSamples = (Array.isArray(switchSamples) ? switchSamples : [])
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);

  // Per-process slopes ranked twice: working set and committed private bytes disagree,
  // so one ranking cannot answer "which process grew" without first saying which memory
  // it means.
  const privateRanked = perProcessSlopes
    .filter((row) => typeof row.slopePrivateMBPerMin === 'number')
    .sort((a, b) => b.slopePrivateMBPerMin - a.slopePrivateMBPerMin);
  // Switch latency by phase. Warmup accumulates a startup distribution the steady state
  // never sees, so the gate reads the workload series and the other two are reported
  // beside it; the split is what showed the 35 ms breach is not a startup artifact.
  const switchRows = Array.isArray(switchSamples) ? switchSamples : [];
  const latencyQuantiles = (rows) => quantiles(rows.map((s) => Number(Number(s.ms).toFixed(3))));
  const workloadSwitches = switchRows.filter((s) => s.phase === 'workload');
  const warmupSwitches = switchRows.filter((s) => s.phase === 'warmup');

  // Same distribution, split by destination. `switchLatencyMs.max` is decided by one
  // sample, and the slowest samples in the diagnostic run all landed on the same two
  // heavy pages: a per-tab summary is what turns that from a suspicion into a table.
  const switchLatencyByTabReport = [];
  if (switchLatencyByTab instanceof Map) {
    for (const [tabId, latencies] of switchLatencyByTab.entries()) {
      if (!Array.isArray(latencies) || latencies.length === 0) continue;
      const q = quantiles(latencies.map((v) => Number(v.toFixed(3))));
      switchLatencyByTabReport.push({
        tabId,
        url: (tabUrlById instanceof Map ? tabUrlById.get(tabId) : '') || '',
        count: latencies.length,
        p50: q.p50,
        p95: q.p95,
        max: q.max,
      });
    }
    switchLatencyByTabReport.sort((a, b) => (b.max || 0) - (a.max || 0));
  }

  return {
    status: status || 'completed',
    startedAt,
    finishedAt: finishedAt || new Date().toISOString(),
    config: {
      totalMinutes: TOTAL_MINUTES,
      warmupMinutes: WARMUP_MINUTES,
      workloadMinutes: WORKLOAD_MINUTES,
      recoveryMinutes: RECOVERY_MINUTES,
      // The driver rate decides how much work the run put through the app, so a
      // verdict that omits it cannot be compared with any other verdict.
      switchIntervalMs: SWITCH_INTERVAL_MS,
      burstIntervalMs: BURST_INTERVAL_MS,
      burstLines: BURST_LINES,
      tabRounds: TAB_ROUNDS,
      fixtureTickMs: FIXTURE_TICK_MS,
      sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
      reportTag: REPORT_TAG,
    },
    rootPid,
    fixturePort,
    stats: {
      requestCount,
      openedTabs: tabIds.length,
      switches,
      bursts,
      reloads,
      terminalEventsCount: terminalEventCount,
      totalSamples: samples.length,
      totalSuspendedMinutes: meta.totalSuspendedMinutes || 0,
      activeWorkloadMinutes: meta.activeWorkloadMinutes || 0,
      teardownTelemetry: teardownTelemetry || {
        tabsClosedRequested: 0,
        tabsClosedSuccess: 0,
        tabsClosedFailed: 0,
        terminalClosedRequested: 0,
        terminalClosedSuccess: 0,
        terminalClosedFailed: 0,
      },
    },
    metrics: (() => {
      const rawMetrics = {
        switchLatencyMs: latencyQuantiles(workloadSwitches),
        switchLatencyWorkloadCount: workloadSwitches.length,
        switchLatencyWarmupMs: latencyQuantiles(warmupSwitches),
        switchLatencyWarmupCount: warmupSwitches.length,
        // What the gate read before it was phase-scoped, kept so both readings can be
        // compared on one artifact instead of across runs.
        switchLatencyAllPhasesMs: quantiles(switchLatencies.map((v) => Number(v.toFixed(3)))),
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
        // Attribution, deliberately NOT a gate: the acceptance bounds stay on the
        // aggregate series, because a per-process bound would be a new criterion
        // rather than a better name for the existing one. These fields are what let
        // a failing aggregate slope name the process that caused it.
        processSeriesSampleCount: processSeries.length,
        perProcessSlopes: perProcessSlopes.slice(0, 12),
        // Working-set ranking, kept for continuity with earlier artifacts.
        worstProcessSlopeMBPerMin: perProcessSlopes[0]?.slopeMBPerMin ?? null,
        worstProcessRole: perProcessSlopes[0]?.role ?? '',
        worstProcessUrl: perProcessSlopes[0]?.url ?? '',
        worstProcessPid: perProcessSlopes[0]?.pid ?? null,
        // Committed-private ranking: the per-process MAXIMUM criterion 2 gates on.
        appPrivateMaxSlopeMBPerMin: privateRanked[0]?.slopePrivateMBPerMin ?? null,
        appPrivateMaxRole: privateRanked[0]?.role ?? '',
        appPrivateMaxUrl: privateRanked[0]?.url ?? '',
        appPrivateMaxPid: privateRanked[0]?.pid ?? null,
        // A slope is only readable with the window it was fitted to, and an empty series
        // here means no workload samples existed — not a flat run.
        processSlopeWindowStart: perProcessSlopes[0]?.windowStart ?? null,
        processSlopeWindowEnd: perProcessSlopes[0]?.windowEnd ?? null,
        // What the app-scoped walk refused, so a smaller footprint is auditable rather
        // than assumed to be a better one.
        refusedProcessCount: samples[samples.length - 1]?.refusedProcessCount ?? 0,
        refusedProcessWorkingSetMB: samples[samples.length - 1]?.refusedProcessWorkingSetMB ?? 0,
        refusedProcessNames: samples[samples.length - 1]?.refusedProcessNames ?? [],
        slowSwitchSamples,
        switchLatencyByTab: switchLatencyByTabReport,
      };
      const evaluation = evaluateFreezeVerdict(meta, rawMetrics, (orphanPids || []).length);
      return {
        ...rawMetrics,
        slopeSloSatisfied: evaluation.slopeOk,
        privateSlopeSloSatisfied: evaluation.privateSlopeOk,
        privateSlopeMeasured: evaluation.privateSlopeMeasured,
        switchLatencyWorkloadSamples: evaluation.switchCount,
        memorySloSatisfied: evaluation.memoryOk,
        latencySloSatisfied: evaluation.latencyOk,
        orphanSloSatisfied: evaluation.processOk,
        executionSloSatisfied: evaluation.executionOk,
        teardownSloSatisfied: evaluation.teardownOk,
        verdict: evaluation.verdict,
      };
    })(),
    samples,
    processSeries,
    slowSwitchSamples,
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
  appTreeMarkers.userDataDir = soakDataDir;

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
  const switchSamples = [];
  // Switch cost is not one distribution: the run's slowest switches were all
  // transitions to the same heavy page, so a single `max` names a UI that stutters
  // without naming the tab that stalls. Kept per tab so the report can.
  const switchLatencyByTab = new Map();
  const tabUrlById = new Map();
  // Counted, not retained: the soak process has no use for the payloads, and an
  // unbounded array of every chunk would put harness-side growth next to the app
  // growth this run is measuring.
  let terminalEventCount = 0;
  const benchmarkIngest = createBenchmarkStreamIngest();
  let switches = 0;
  let bursts = 0;
  let reloads = 0;
  let seq = 0;
  const pending = new Map();

  let recoveryTeardownDone = false;
  let totalSuspendedMs = 0;
  const teardownTelemetry = {
    tabsToClose: 0,
    tabsClosedSuccess: 0,
    tabsClosedFailed: 0,
    terminalClosedSuccess: false,
    terminalClosedFailed: false,
    teardownDegraded: false,
  };

  const performRecoveryTeardown = async (phaseLabel) => {
    if (recoveryTeardownDone) return;
    recoveryTeardownDone = true;
    console.log(`[soak] ${phaseLabel}: Running recovery teardown (closing tabs & terminal session)...`);
    if (ws && tabIds.length > 0) {
      teardownTelemetry.tabsToClose = tabIds.length;
      for (const id of tabIds) {
        try {
          const res = await rpc('antifan.closeTab', { tabId: id });
          if (res && res.closed !== false) {
            teardownTelemetry.tabsClosedSuccess++;
          } else {
            teardownTelemetry.tabsClosedFailed++;
          }
        } catch (err) {
          teardownTelemetry.tabsClosedFailed++;
          console.warn(`[soak] Failed to close tab ${id}:`, err.message);
        }
      }
    }
    if (ws && sessionId) {
      try {
        const res = await rpc('antifan.terminalCloseSession', { sessionId });
        if (res && res.closed !== false) {
          teardownTelemetry.terminalClosedSuccess = true;
        } else {
          teardownTelemetry.terminalClosedFailed = true;
        }
      } catch (err) {
        teardownTelemetry.terminalClosedFailed = true;
        console.warn(`[soak] Failed to close terminal session ${sessionId}:`, err.message);
      }
    }
    if (teardownTelemetry.tabsClosedFailed > 0 || teardownTelemetry.terminalClosedFailed) {
      teardownTelemetry.teardownDegraded = true;
      console.warn(`[soak] Teardown degraded: tabsFailed=${teardownTelemetry.tabsClosedFailed}, terminalFailed=${teardownTelemetry.terminalClosedFailed}`);
    }
  };
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
    terminalEventCount,
    samples,
    switchLatencies,
    switchSamples,
    switchLatencyByTab,
    tabUrlById,
    processSamples: benchmarkIngest.samples,
    requestCount: 0,
    switches: 0,
    bursts: 0,
    reloads: 0,
    totalSuspendedMinutes: 0,
    activeWorkloadMinutes: 0,
    stdout: '',
    stderr: '',
    teardownTelemetry,
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
        }, ${FIXTURE_TICK_MS});
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
    const soakBridgeToken = process.env.ANTIFAN_BRIDGE_TOKEN || randomUUID();
    const env = {
      ...process.env,
      ANTIFAN_BENCHMARK: '1',
      ANTIFAN_BRIDGE_TOKEN: soakBridgeToken,
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
    child.stdout.on('data', (d) => {
      stdout = (stdout + d).slice(-300000);
      benchmarkIngest.push(d);
    });
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
          if (bridge.port) {
            bridge.token = soakBridgeToken;
            break;
          }
        } catch {}
      }
      await sleep(250);
    }
    if (interruptedSignal) throw new Error(`Interrupted by ${interruptedSignal}`);
    if (!bridge) throw new Error('Bridge server failed to initialize.');
    console.log(`[soak] Bridge server connected on port ${bridge.port}`);
    const wsHeaders = {};
    if (bridge.token) {
      wsHeaders.authorization = `Bearer ${bridge.token}`;
    }
    ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, {
      headers: wsHeaders,
    });
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.event === 'antifan:terminal:data') terminalEventCount++;
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
    const tabUrls = [];
    const baseUrls = [
      `http://127.0.0.1:${fixturePort}/store-home`,
      `http://127.0.0.1:${fixturePort}/collection-featured`,
      `http://127.0.0.1:${fixturePort}/product-test-1`,
      `http://127.0.0.1:${fixturePort}/product-test-2`,
      'https://example.com',
      'https://www.wikipedia.org',
    ];
    // Tab count is the other half of "more work at once": extra rounds repeat the
    // set with distinct fixture paths so each round is its own navigation, not a
    // reload of a tab that is already open.
    for (let round = 0; round < TAB_ROUNDS; round++) {
      for (const url of baseUrls) {
        if (!url.includes('127.0.0.1') || round === 0) {
          tabUrls.push(url);
        } else {
          tabUrls.push(`${url}-r${round + 1}`);
        }
      }
    }
    console.log(`[soak] Opening ${tabUrls.length} tabs...`);
    for (const url of tabUrls) {
      try {
        const res = await rpc('antifan.openTab', { url });
        if (res && res.tabId) {
          tabIds.push(res.tabId);
          tabUrlById.set(res.tabId, url);
        }
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
    stateMeta.terminalEventCount = terminalEventCount;
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
    if (currentPhase === 'recovery') {
      await performRecoveryTeardown('Phase 3 Recovery');
    }
    if (currentPhase !== 'recovery' && now >= nextSwitchTime && tabIds.length > 0) {
      const tabId = tabIds[switches % tabIds.length];
      const t0 = performance.now();
      try {
        const sw = await rpc('antifan.switchTab', { tabId });
        if (sw && sw.switched) {
          const latency = performance.now() - t0;
          switchLatencies.push(latency);
          // The SLO on `max` is decided by a single outlier out of thousands, so the
          // sample that produced it must stay identifiable by time and target — a
          // quantile alone cannot say whether it was a GC pause, a slow payload, or
          // the process-table scrape the harness itself runs every minute.
          switchSamples.push({ at: Date.now(), ms: Number(latency.toFixed(3)), tabId, phase: currentPhase });
          const perTabLatencies = switchLatencyByTab.get(tabId);
          if (perTabLatencies) perTabLatencies.push(latency);
          else switchLatencyByTab.set(tabId, [latency]);
          switches++;
        }
      } catch {}
      nextSwitchTime = now + SWITCH_INTERVAL_MS; // default 3s
    }
    // 2. Terminal Bursts (default every 30s in warmup & workload)
    if (currentPhase !== 'recovery' && now >= nextBurstTime) {
      try {
        const marker = 100000 + bursts;
        await rpc('antifan.terminalInput', {
          sessionId,
          text: `1..${BURST_LINES} | ForEach-Object { $_ }; Write-Output ('AF_8H_SOAK_' + (${marker} + 1))\r`,
        });
        bursts++;
      } catch {}
      nextBurstTime = now + BURST_INTERVAL_MS;
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
    if (keepAwakeProcess) {
      try {
        if (typeof keepAwakeProcess.kill === 'function') {
          keepAwakeProcess.kill();
        } else if (keepAwakeProcess.pid) {
          process.kill(keepAwakeProcess.pid);
        }
      } catch {}
    }
    isIntentionalTeardown = true;

    await performRecoveryTeardown('Final Guaranteed Teardown');

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
    stateMeta.terminalEventCount = terminalEventCount;
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
    const isDegraded = finalPayload.metrics.verdict === 'TEARDOWN_DEGRADED';
    finalPayload.status = isPassed ? 'completed' : (isDegraded ? 'degraded' : 'failed');
    fs.writeFileSync(FINAL_REPORT_PATH, JSON.stringify(finalPayload, null, 2), 'utf8');
    console.log(`[soak] Final report saved to ${FINAL_REPORT_PATH}`);

    console.log('========================================================================');
    console.log(`  AntiFan 8-Hour Soak Verdict: ${finalPayload.metrics.verdict}`);
    if (executionError) {
      console.error(`  Execution Error: ${executionError.message}`);
    }
    console.log(`  Initial Loaded: ${finalPayload.metrics.initialLoadedMB} MB`);
    console.log(`  Post-Warmup: ${finalPayload.metrics.postWarmupMB} MB`);
    console.log(`  Final Active p50: ${finalPayload.metrics.activeWorkingSetMB.p50} MB (Peak Max: ${finalPayload.metrics.activeWorkingSetMB.max} MB, SLO <= ${FREEZE_SLO.peakTotalWorkingSetMB} MB)`);
    console.log(`  Recovered: ${finalPayload.metrics.recoveredMB} MB`);
    console.log(`  Overall Slope: ${finalPayload.metrics.overallActiveSlopeMBPerMin !== null ? finalPayload.metrics.overallActiveSlopeMBPerMin + ' MB/min' : 'N/A'} (SLO <= ${FREEZE_SLO.overallSlopeMBPerMin} MB/min)`);
    console.log(`  Renderer Slope: ${finalPayload.metrics.rendererActiveSlopeMBPerMin !== null ? finalPayload.metrics.rendererActiveSlopeMBPerMin + ' MB/min' : 'N/A'} (SLO <= ${FREEZE_SLO.rendererSlopeMBPerMin} MB/min)`);
    const wlQ = finalPayload.metrics.switchLatencyMs || {};
    const wuQ = finalPayload.metrics.switchLatencyWarmupMs || {};
    const allQ = finalPayload.metrics.switchLatencyAllPhasesMs || {};
    console.log(`  Tab Switch Latency (workload, n=${finalPayload.metrics.switchLatencyWorkloadCount ?? 0}): p50=${wlQ.p50}ms (SLO <= ${FREEZE_SLO.switchLatencyP50Ms}ms), p95=${wlQ.p95}ms (SLO <= ${FREEZE_SLO.switchLatencyP95Ms}ms), max=${wlQ.max}ms (SLO <= ${FREEZE_SLO.switchLatencyMaxMs}ms)`);
    console.log(`  Tab Switch Latency (warmup, n=${finalPayload.metrics.switchLatencyWarmupCount ?? 0}): p50=${wuQ.p50}ms, p95=${wuQ.p95}ms, max=${wuQ.max}ms | all phases: p50=${allQ.p50}ms, p95=${allQ.p95}ms, max=${allQ.max}ms`);
    const appPrivate = finalPayload.metrics;
    console.log(`  App-Owned Private Max: ${appPrivate.appPrivateMaxSlopeMBPerMin !== null ? appPrivate.appPrivateMaxSlopeMBPerMin + ' MB/min' : 'N/A (no workload samples)'} at pid=${appPrivate.appPrivateMaxPid ?? '-'} ${appPrivate.appPrivateMaxRole || ''} (SLO <= ${FREEZE_SLO.rendererSlopeMBPerMin} MB/min, per-process max)`);
    console.log(`  Orphan Processes: ${orphanPids.length} (Query OK: ${processQuerySuccess}, SLO = ${FREEZE_SLO.maxOrphans})`);
    if (finalPayload.metrics.refusedProcessCount > 0) {
      console.log(`  Walk Refused (not app-owned, excluded from every gate): ${finalPayload.metrics.refusedProcessCount} process(es), ${finalPayload.metrics.refusedProcessWorkingSetMB} MB [${(finalPayload.metrics.refusedProcessNames || []).join(', ')}]`);
    }
    const worstTab = (finalPayload.metrics.switchLatencyByTab || [])[0];
    if (worstTab) {
      console.log(`  Slowest Switch Destination: ${worstTab.url || worstTab.tabId} (max ${worstTab.max}ms, p95 ${worstTab.p95}ms over ${worstTab.count} switches)`);
    }
    if (finalPayload.metrics.worstProcessRole) {
      console.log(`  Fastest-Growing Process (working set): ${finalPayload.metrics.worstProcessRole} pid=${finalPayload.metrics.worstProcessPid} (${finalPayload.metrics.worstProcessSlopeMBPerMin} MB/min)`);
    }
    console.log('========================================================================');
    if (!isPassed) {
      if (isDegraded) {
        const tFailed = finalPayload.stats.teardownTelemetry?.tabsClosedFailed ?? 0;
        const termFailed = finalPayload.stats.teardownTelemetry?.terminalClosedFailed ?? 0;
        console.error(`[soak] FAILED (TEARDOWN_DEGRADED): Required tab/terminal cleanup failed during teardown (tabsFailed: ${tFailed}, terminalFailed: ${termFailed}).`);
      } else {
        console.error(`[soak] FAILED: SLO violations or execution failure detected (slopeOk: ${finalPayload.metrics.slopeSloSatisfied}, privateSlopeOk: ${finalPayload.metrics.privateSlopeSloSatisfied} [measured: ${finalPayload.metrics.privateSlopeMeasured}], memoryOk: ${finalPayload.metrics.memorySloSatisfied}, latencyOk: ${finalPayload.metrics.latencySloSatisfied}, processOk: ${finalPayload.metrics.orphanSloSatisfied}, executionOk: ${finalPayload.metrics.executionSloSatisfied}, teardownOk: ${finalPayload.metrics.teardownSloSatisfied})`);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error('[soak] Fatal error:', redactCreds(err));
  process.exitCode = 1;
});
