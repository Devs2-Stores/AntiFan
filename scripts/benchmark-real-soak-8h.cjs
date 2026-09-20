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
const SAMPLE_INTERVAL_SECONDS = parseFloat(process.env.SOAK_SAMPLE_INTERVAL_SECONDS || '60');
const SAMPLE_INTERVAL_MS = SAMPLE_INTERVAL_SECONDS * 1000;
// Workload intensity is the independent variable of a throughput claim: two runs
// are only comparable when the driver rate is known, so every knob is overridable
// and every value is echoed into the report. Defaults are unchanged, which keeps
// historical runs comparable.
const SWITCH_INTERVAL_MS = Math.max(50, parseInt(process.env.SOAK_SWITCH_INTERVAL_MS || '3000', 10));
const BURST_INTERVAL_MS = Math.max(500, parseInt(process.env.SOAK_BURST_INTERVAL_MS || '30000', 10));
const BURST_LINES = Math.max(1, parseInt(process.env.SOAK_BURST_LINES || '300', 10));
// A slope over a whole workload can only say *that* a process grew, never which driver
// grew it: host load, page set and the app's own background work all vary between runs.
// Legs split the workload into consecutive segments that differ in one driver, so the
// answer is the same process's slope changing when — and only when — that driver's knob
// changes, inside one run. Parsed from
// SOAK_LEGS="name:minutes:burstLines:burstIntervalMs,..."; unset means a single leg
// carrying the base knobs, which keeps every historical run comparable.
const LEGS = parseWorkloadLegs(process.env.SOAK_LEGS);
const EXTRA_APP_ARGS = parseExtraAppArgs(process.env.SOAK_APP_ARGS);
const WORKLOAD_MINUTES = LEGS.length
  ? LEGS.reduce((total, leg) => total + leg.minutes, 0)
  : Math.max(0.1, TOTAL_MINUTES - WARMUP_MINUTES - RECOVERY_MINUTES);
// Legs define the workload length, so the run length follows them instead of
// SOAK_DURATION_MINUTES: asking for 90 minutes while scheduling 75 minutes of legs would
// otherwise append an unattributed coda that the last leg's slope would absorb.
const RUN_MINUTES = WARMUP_MINUTES + WORKLOAD_MINUTES + RECOVERY_MINUTES;
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
  maxOrphans: 0,
};

// The switch tail is ~0.2 % of thousands of switches, so the ten slowest say that it
// happened and nothing about what produces it. The whole series is kept in the payload
// instead — 4 h at a 3 s cadence is ~4 800 rows — and the cap is a guard against a run
// configured far denser than any here, with the number dropped recorded beside it so a
// truncated series is never read as a complete one.
const SWITCH_SAMPLE_CAP = 20000;

// History flushes are coalesced, so their metric is emitted at most once per quiet period
// (production: 3 s) rather than per mutation — a 4 h run cannot approach this. The cap is a
// guard, and a hit merely truncates the tail of an append-only cost series.
const HISTORY_SAMPLE_CAP = 20000;

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
  // A leg run's workload is deliberately heterogeneous: one slope fitted across legs
  // that ran different burst volumes is a blend of regimes and grades nothing, so the
  // memory gates report null (not-applicable) instead of a number a reader would take
  // as a verdict. Per-leg slopes in `legSlopes` are the measurement for such a run.
  const legRun = LEGS.length > 1;
  const privateSlopeOk = legRun
    ? null
    : privateSlopeMeasured && appPrivateSlope <= FREEZE_SLO.rendererSlopeMBPerMin;
  const slopeOk = legRun
    ? null
    : hasValidSlope
      && overallSlope <= FREEZE_SLO.overallSlopeMBPerMin
      && rendererSlope <= FREEZE_SLO.rendererSlopeMBPerMin
      && privateSlopeOk;
  const memoryOk = maxActive <= FREEZE_SLO.peakTotalWorkingSetMB;
  // The latency gate reads the workload phase and grades percentiles, not the maximum.
  // User decision (2026-09-20), on the 4 h run's evidence: the tail is a global stall that
  // hits all six destinations equally (every destination 38-51 ms, every p50 10.1-10.9) at
  // ~0.2 % of 4090 switches, with 8 of the 10 slowest inside the steady-state workload
  // phase - not a per-destination cost and not a startup artifact. Grading `max` therefore
  // fails a run on an event it cannot attribute, while the distribution it does describe
  // (p50 <= 12, p95 <= 18) stays graded; `switchLatencyMaxMs` is reported in the artifact
  // and printed beside them so the tail is visible without deciding the verdict.
  const latencyOk = switchCount > 0 && switchP50 <= FREEZE_SLO.switchLatencyP50Ms && switchP95 <= FREEZE_SLO.switchLatencyP95Ms;
  const processOk = meta.processQuerySuccess === true && (orphanPidsCount || 0) <= FREEZE_SLO.maxOrphans;
  const executionOk = !meta.executionError && !meta.childExitedPrematurely;
  const teardownOk = !meta.teardownTelemetry?.teardownDegraded;

  const isPassed = slopeOk !== false && memoryOk && latencyOk && processOk && executionOk && teardownOk;
  const isDegraded = slopeOk !== false && memoryOk && latencyOk && processOk && executionOk && !teardownOk;
  const verdict = isPassed ? (legRun ? 'PASSED_SLOPE_NOT_GRADED' : 'PASSED') : (isDegraded ? 'TEARDOWN_DEGRADED' : 'FAILED');

  return {
    isPassed,
    isDegraded,
    slopeOk,
    privateSlopeOk,
    privateSlopeMeasured,
    slopeGateApplicable: !legRun,
    switchCount,
    // Reported, not graded (see the latency gate above): the reader must be able to tell
    // a threshold that was dropped from the verdict from one that passed it.
    switchMaxMs: Number.isFinite(switchMax) ? switchMax : null,
    latencyMaxGated: false,
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
  // `UserModeTime`/`KernelModeTime` are cumulative 100-ns counters, so a window's CPU cost
  // is an exact difference between two samples rather than a rate sampled once a minute —
  // which matters because the workload is a burst (a write every 30 s) that a 60 s rate
  // sample can miss entirely. They ride in the same query as the memory columns on purpose:
  // two queries would read two different process tables, and a difference taken across them
  // would mix windows.
  const cmd = "$p=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize,UserModeTime,KernelModeTime,CommandLine; $p | ConvertTo-Json -Compress";
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

/**
 * CPU seconds a process has consumed since it started, from the two cumulative counters the
 * process table carries. They are 100-ns ticks, and they are monotonic per process, so a
 * window's cost is `last - first` — no sampling error, no interpolation.
 *
 * A counter that cannot be read returns `null`, never 0: an unreadable process (protected, or
 * a provider that omits the property) has unknown cost, and 0 would read as a measurement
 * that it is free.
 */
const CPU_TICKS_PER_SECOND = 1e7;

function readProcessCpuSeconds(row) {
  const user = Number(row?.UserModeTime);
  const kernel = Number(row?.KernelModeTime);
  if (!Number.isFinite(user) || !Number.isFinite(kernel)) return null;
  return Number(((user + kernel) / CPU_TICKS_PER_SECOND).toFixed(6));
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
  // CPU rides beside memory in the same rows: the terminal write path and the state broadcast
  // are both consumers of a shared thread pool, and "more work at once" is bound by CPU per
  // unit of work rather than by bytes. Kept per pid so a window's cost can be attributed to
  // the same process identity the memory series names.
  const cpuByPid = {};
  let treeCpuSeconds = 0;
  let cpuUnreadableProcessCount = 0;
  for (const r of tree) {
    const pid = Number(r.ProcessId);
    const seconds = readProcessCpuSeconds(r);
    cpuByPid[pid] = seconds;
    if (seconds === null) cpuUnreadableProcessCount++;
    else treeCpuSeconds += seconds;
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
      // CPU of the same app-owned tree, as cumulative seconds per pid (null = unreadable).
      treeCpuSeconds: Number(treeCpuSeconds.toFixed(3)),
      cpuUnreadableProcessCount,
      cpuByPid,
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
  const history = [];
  return {
    samples,
    history,
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
        // The history store's write cost, sampled by the app itself on every flush. This is
        // the only handle on how much main-process work the browsing history costs per
        // minute, which is what "more work at once" is bounded by; the counters are small
        // and the cadence is the flush cadence, so the array is capped defensively.
        if (metric?.surface === 'history' && history.length < HISTORY_SAMPLE_CAP) {
          const at = Date.parse(metric.ts);
          if (Number.isFinite(at)) {
            history.push({
              at,
              name: String(metric.name || ''),
              value: Number(metric.value),
              extra: metric.extra && typeof metric.extra === 'object' ? metric.extra : {},
            });
          }
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

// Extra Electron/Chromium switches for an *attached diagnosis* run, e.g.
// SOAK_APP_ARGS="--remote-debugging-port=0" so scripts/probe-renderer-retention-class.cjs can
// read this profile's DevToolsActivePort and sample DOM counters from outside the app.
// Opt-in on purpose: a measured run must not carry a debugger endpoint, so the parsed argv is
// logged and recorded in the payload — a diagnosis run stays distinguishable from a
// measurement. Split on whitespace only: a value containing spaces is not supported here and
// is refused loudly rather than split into tokens that would silently change the argv.
function parseExtraAppArgs(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (/["']/.test(text)) {
    console.warn(`[soak] SOAK_APP_ARGS contains a quote (${text}); it is split on whitespace, so a quoted value with spaces cannot be passed here`);
  }
  return text.split(/\s+/).filter(Boolean);
}

// Legs are parsed before the workload length is known, so the shape is validated here
// and the length is derived from the parsed minutes: an unparseable segment is dropped
// rather than silently defaulted, because a dropped leg would relabel another leg's
// samples and invert the attribution it exists to produce.
function parseWorkloadLegs(raw) {
  const legs = [];
  for (const segment of String(raw || '').split(',')) {
    const text = segment.trim();
    if (!text) continue;
    const [name, minutes, lines, interval] = text.split(':');
    const legMinutes = parseFloat(minutes);
    if (!name || !Number.isFinite(legMinutes) || legMinutes <= 0) {
      console.warn(`[soak] Ignoring malformed leg "${text}" (expected name:minutes[:burstLines[:burstIntervalMs]])`);
      continue;
    }
    const parsedLines = parseInt(lines ?? '', 10);
    const parsedInterval = parseInt(interval ?? '', 10);
    legs.push({
      name,
      minutes: legMinutes,
      burstLines: Number.isFinite(parsedLines) && parsedLines > 0 ? Math.max(1, parsedLines) : BURST_LINES,
      burstIntervalMs: Number.isFinite(parsedInterval) && parsedInterval > 0 ? Math.max(500, parsedInterval) : BURST_INTERVAL_MS,
    });
  }
  return legs;
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

/**
 * CPU consumed inside one wall-clock window, from the app-owned tree's cumulative per-process
 * counters (see `readProcessCpuSeconds`).
 *
 * Differencing the window's endpoints is what makes this exact instead of sampled: the
 * workload bursts every 30 s, so a rate read once a minute can land entirely between two
 * bursts and report the app as idle.
 *
 * Three shapes cannot be differenced from those endpoints, and each is **counted** rather
 * than guessed, because the alternative — dropping them silently — would make a tree that
 * restarted a worker or recycled a pid read as *cheaper* than one that did not:
 *
 *  - a pid present at one end and not the other (started or exited inside the window);
 *  - a pid whose counters are unreadable at one end;
 *  - a pid whose counter went backwards (pid reuse, or a counter reset), where the
 *    difference is meaningless and negative.
 *
 * Their cost is missing from the total, so the total is a **lower bound** and the counts say
 * how much of the tree it is a lower bound over. `null` is returned when the window holds
 * fewer than two samples: "not measured" is not "measured zero".
 */
function calculateCpuDeltas(samples, windowStart, windowEnd) {
  if (!Number.isFinite(windowStart) || !Number.isFinite(windowEnd)) return null;
  const rows = (Array.isArray(samples) ? samples : []).filter(
    (s) => Number.isFinite(s.at) && s.at >= windowStart && s.at <= windowEnd
  );
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows[rows.length - 1];
  const startMap = first.cpuByPid || {};
  const endMap = last.cpuByPid || {};
  // Rows that carry no counters at all are "not measured", not "measured zero": an empty map at
  // both ends differences to a 0 total, and a 0 total divided by a known volume prints as
  // `0 ms per 1000 lines` — a cost of nothing, asserted by a series that never held a counter.
  // The window's rows existing is what separates this from the too-few-rows case above.
  if (Object.keys(startMap).length === 0 && Object.keys(endMap).length === 0) return null;
  const perProcess = [];
  const notAttributablePids = [];
  const unreadablePids = [];
  const counterResetPids = [];
  for (const key of new Set([...Object.keys(startMap), ...Object.keys(endMap)])) {
    const pid = Number(key);
    const inStart = Object.prototype.hasOwnProperty.call(startMap, key);
    const inEnd = Object.prototype.hasOwnProperty.call(endMap, key);
    if (!inStart || !inEnd) {
      // Born or died inside the window: its counter has no baseline at one end.
      if (inStart || inEnd) notAttributablePids.push(pid);
      continue;
    }
    const a = startMap[key];
    const b = endMap[key];
    if (typeof a !== 'number' || typeof b !== 'number') {
      unreadablePids.push(pid);
      continue;
    }
    const delta = b - a;
    if (delta < 0) {
      counterResetPids.push(pid);
      continue;
    }
    perProcess.push({ pid, seconds: Number(delta.toFixed(3)) });
  }
  perProcess.sort((x, y) => y.seconds - x.seconds);
  const cpuSecondsTotal = Number(perProcess.reduce((a, r) => a + r.seconds, 0).toFixed(3));
  const windowMinutes = Number(((last.at - first.at) / 60000).toFixed(2));
  return {
    from: new Date(first.at).toISOString(),
    to: new Date(last.at).toISOString(),
    windowMinutes,
    samples: rows.length,
    cpuSecondsTotal,
    cpuSecondsPerMinute: windowMinutes > 0 ? Number((cpuSecondsTotal / windowMinutes).toFixed(3)) : null,
    perProcess: perProcess.map((r) => ({
      ...r,
      share: cpuSecondsTotal > 0 ? Number((r.seconds / cpuSecondsTotal).toFixed(4)) : null,
    })),
    // Named, not only counted: the pids are how a reader joins these to the memory series.
    notAttributablePids,
    unreadablePids,
    counterResetPids,
  };
}

/**
 * Cost per unit of work, which is the currency "more work at once" is a question about: a
 * regime that writes 4× the lines for 4× the CPU is not cheaper to scale, while one whose CPU
 * does not move with the volume is paying per minute instead of per line. `null` when the unit
 * count is unknown or zero — a leg with no observed bursts has no per-line cost, and printing
 * one there would be a number invented from a zero denominator.
 */
function costPerUnit(cpuSeconds, units) {
  if (typeof cpuSeconds !== 'number' || !Number.isFinite(units) || units <= 0) return null;
  return Number(((cpuSeconds * 1000) / units).toFixed(4));
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
    burstsByPhase,
    reloads,
    terminalEventCount,
    samples,
    switchLatencies,
    switchSamples,
    switchLatencyByTab,
    tabUrlById,
    processSamples,
    historySamples,
    orphanPids,
    stdout,
    stderr,
    status,
    teardownTelemetry,
    legs,
  } = meta;
  const warmupSamples = samples.filter((s) => s.label === 'warmup');
  const activeSamples = samples.filter((s) => s.label === 'workload');
  const recoverySamples = samples.filter((s) => s.label === 'recovery');
  // Sleep-adjusted span of the workload phase's own samples. Mid-run this is the span
  // measured so far, which is the honest reading then; a phase that never ran yields null
  // rather than 0, because "not measured" and "measured zero minutes" are different facts.
  const activeWorkloadMinutes =
    activeSamples.length >= 2
      ? Number((((activeSamples[activeSamples.length - 1].activeAt ?? activeSamples[activeSamples.length - 1].at) -
          (activeSamples[0].activeAt ?? activeSamples[0].at)) /
          60000).toFixed(2))
      : null;

  const totals = activeSamples.map((s) => s.totalWorkingSetMB);
  const rendererTotals = activeSamples.map((s) => s.byType?.renderer?.workingSetMB || 0);

  // The process series is wall-clock (`at`), so the window boundaries come from the
  // wall-clock stamps of the workload samples rather than from their sleep-adjusted
  // `activeAt`.
  const processSeries = Array.isArray(processSamples) ? processSamples : [];
  // pid → role/type, taken from the app's own telemetry stream, which is what names the
  // WebContents a process hosts. A pid the stream never named (a pty child such as
  // powershell.exe) keeps an empty role rather than a guessed one, so "unattributed" is
  // visible as its own fact instead of a plausible label.
  const processRoles = new Map();
  for (const s of processSeries) {
    for (const p of s.processes || []) {
      if (p.role) processRoles.set(p.pid, { role: p.role, type: p.type });
    }
  }
  const attachCpuRoles = (cpu) =>
    cpu === null
      ? null
      : {
          ...cpu,
          perProcess: cpu.perProcess.map((row) => ({ ...row, role: processRoles.get(row.pid)?.role || '', type: processRoles.get(row.pid)?.type || '' })),
        };
  // The CPU counters ride on the harness's own per-minute tree-walk rows (`samples`, via
  // `sampleMetrics().cpuByPid`), and NOT on the app's telemetry rows (`processSeries`), which carry
  // memory and roles only. Differencing the telemetry series therefore differenced two empty maps
  // and returned `cpuSecondsTotal: 0` for every window on a real run — which, once the leg burst
  // counter was fixed so the denominator is known, printed `0 ms per 1000 burst lines`. That reads
  // as "the write path costs nothing", the exact confusion the counters exist to prevent, so the
  // series is chosen for the field it carries and the choice is recorded in the payload.
  // A row that carries an *empty* map is dropped for the same reason `calculateCpuDeltas` refuses
  // to difference empty maps: a scrape that lands while the app is starting (or after a crash)
  // yields `{}`, and if that row opens a window it becomes the start map, every end pid turns
  // "not attributable" and the window's total reads 0. The analyzer's own reader already skips
  // these rows, so keeping them would let the two readers disagree on the same run.
  const cpuSeries = (Array.isArray(samples) ? samples : []).filter(
    (s) => s.cpuByPid && typeof s.cpuByPid === 'object' && Object.keys(s.cpuByPid).length > 0
  );
  const cpuSource = `samples.cpuByPid (${cpuSeries.length} of ${samples.length} row(s) carry counters)`;
  const withCpuSource = (cpu) => (cpu === null ? null : { ...cpu, source: cpuSource });
  const perProcessSlopes = calculatePerProcessSlopes(
    processSeries,
    activeSamples.length > 0 ? activeSamples[0].at : NaN,
    activeSamples.length > 0 ? activeSamples[activeSamples.length - 1].at : NaN
  );
  const slowSwitchSamples = (Array.isArray(switchSamples) ? switchSamples : [])
    .slice()
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 10);
  // The full series, not only its slowest ten: a stall that is indifferent to what the
  // run was doing (idle or 40 lines/s of PTY output) and a stall caused by a collision
  // with that output produce the same top-ten list. Only the per-leg and per-phase counts
  // separate them, and only the whole series carries them. `at` is kept as the raw
  // wall-clock stamp so a later reader can test a cadence (the harness's own 60 s scrape,
  // the fixture tick) against the tail instead of guessing at one.
  const switchSeries = (Array.isArray(switchSamples) ? switchSamples : []).slice(0, SWITCH_SAMPLE_CAP);
  const switchSamplesDropped = (Array.isArray(switchSamples) ? switchSamples.length : 0) - switchSeries.length;
  // The bisect's answer. Each leg is fitted to its own observed window, and the rows are
  // the same processes, so a slope that moves with a leg's knobs while process identity,
  // page set and host load stay fixed is the driver; a slope that stays put across legs
  // is not. Observable bursts are carried beside the requested volume, because a leg
  // whose writes silently failed would otherwise read as "this driver costs nothing".
  const legSlopes = [];
  for (const leg of Array.isArray(legs) ? legs : []) {
    const from = leg.observedFrom ?? leg.startAt;
    const to = leg.observedTo ?? leg.endAt;
    const rows = calculatePerProcessSlopes(processSeries, from, to).filter(
      (row) => typeof row.slopePrivateMBPerMin === 'number'
    );
    rows.sort((a, b) => b.slopePrivateMBPerMin - a.slopePrivateMBPerMin);
    // The leg's CPU, costed against its own observed volume and switch count. A leg whose
    // writes failed has `bursts: 0` and therefore no per-line cost rather than an infinite
    // one: the harness's own counters say the work did not happen, and that is the finding.
    const legCpu = withCpuSource(attachCpuRoles(calculateCpuDeltas(cpuSeries, from, to)));
    const legBurstLines = Number.isFinite(leg.bursts) ? leg.bursts * leg.burstLines : null;
    const legSwitchCount = switchSeries.filter((s) => s.leg === `${leg.name}#${leg.ordinal}`).length;
    legSlopes.push({
      name: leg.name,
      // Carried so a reader can join this row back to the switch series, whose rows are
      // tagged `name#ordinal` — without it the join has to be guessed from the name.
      ordinal: leg.ordinal ?? null,
      burstLines: leg.burstLines,
      burstIntervalMs: leg.burstIntervalMs,
      startAt: leg.startAt,
      endAt: leg.endAt,
      observedFrom: leg.observedFrom ?? null,
      observedTo: leg.observedTo ?? null,
      observedMinutes: Number(((to - from) / 60000).toFixed(2)),
      bursts: leg.bursts ?? null,
      switchCount: legSwitchCount,
      burstLinesObserved: legBurstLines,
      cpu: legCpu === null ? null : {
        ...legCpu,
        burstLines: legBurstLines,
        msPer1000BurstLines: costPerUnit(legCpu.cpuSecondsTotal, legBurstLines === null ? null : legBurstLines / 1000),
        msPerSwitch: costPerUnit(legCpu.cpuSecondsTotal, legSwitchCount),
      },
      // The full ranking, not only the top six: the bisect asks whether the *same*
      // process moves with the leg's knobs, and a role that outranks the suspect in one
      // leg would otherwise drop out of the table it is read from. `topSlopes` stays for
      // the terminal verdict, which names one process per leg.
      slopes: rows,
      topSlopes: rows.slice(0, 6),
    });
  }

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

  // CPU of the run, phase by phase, from the app tree's own cumulative counters. This is the
  // currency "more work at once" is actually bound by: memory decides how many tabs survive,
  // while CPU per unit of work decides how much can be pushed through them, and the write
  // path and the state broadcast draw on the same threads.
  const workloadCpu = withCpuSource(attachCpuRoles(calculateCpuDeltas(cpuSeries, activeSamples[0]?.at, activeSamples[activeSamples.length - 1]?.at)));
  const cpuByPhase = {
    warmup: withCpuSource(attachCpuRoles(calculateCpuDeltas(cpuSeries, warmupSamples[0]?.at, warmupSamples[warmupSamples.length - 1]?.at))),
    workload: workloadCpu,
    recovery: withCpuSource(attachCpuRoles(calculateCpuDeltas(cpuSeries, recoverySamples[0]?.at, recoverySamples[recoverySamples.length - 1]?.at))),
  };
  // Burst volume of the workload phase only. The global `bursts` counter also carries warmup,
  // so pricing this window's CPU against it would put another regime's lines in the
  // denominator; on a bisect run the legs are the only rows that observed their own volume,
  // which is why their total is used instead.
  const workloadBursts = burstsByPhase && Number.isFinite(burstsByPhase.workload) ? burstsByPhase.workload : null;
  const legBurstsObserved = legSlopes.reduce((a, l) => a + (Number.isFinite(l.bursts) ? l.bursts : 0), 0);
  // A leg that recorded no bursts while the workload phase did write is a counter fault, not a
  // measurement: it makes every per-line cost null, and a null is indistinguishable from a
  // legitimately empty one. The reading is flagged so the verdict says "instrument broken"
  // instead of "the write path costs nothing".
  const legBurstCounterSuspect =
    LEGS.length > 0 && legSlopes.length > 0 && legBurstsObserved === 0 && (workloadBursts ?? 0) > 0;
  const legBurstLinesTotal = legSlopes.reduce((a, l) => a + (Number.isFinite(l.bursts) ? l.bursts * l.burstLines : 0), 0);

  // The browsing history store's write cost, as the app itself measured it. Before the flush
  // was coalesced, the store was rewritten synchronously from the main thread once per title
  // change (3.7 MB, ~20 ms each) and nothing in the run recorded it: the cost was visible only
  // as unexplained main-process CPU. The rows are the app's own `history` metrics, so this
  // block is attribution rather than inference, and the per-leg split is what lets a bisect
  // price the write against the leg's own churn.
  //
  // The workload-window figure is separate from the run-wide one because `msPerMinute` divides
  // by the workload phase's span: reporting a run-wide total over a workload-only denominator
  // would inflate the rate by whatever warmup and recovery wrote, which is the same
  // mislabelling the CPU block avoids by carrying `cpuByPhase`.
  const historyRows = (Array.isArray(historySamples) ? historySamples : []).filter(
    (row) => Number.isFinite(row?.value)
  );
  const summarizeHistory = (rows) => {
    if (!rows.length) return null;
    return {
      flushes: rows.length,
      totalMs: Number(rows.reduce((a, r) => a + r.value, 0).toFixed(3)),
      maxMs: Number(Math.max(...rows.map((r) => r.value)).toFixed(3)),
      supersededFlushes: rows.filter((r) => r.extra?.superseded === true).length,
    };
  };
  const historyPersist = (() => {
    if (!historyRows.length) return null;
    const last = historyRows[historyRows.length - 1];
    const workloadFrom = activeSamples[0]?.at ?? null;
    const workloadTo = activeSamples[activeSamples.length - 1]?.at ?? null;
    const inWorkload = workloadFrom === null ? [] : historyRows.filter((r) => r.at >= workloadFrom && r.at <= workloadTo);
    const workload = summarizeHistory(inWorkload);
    return {
      run: summarizeHistory(historyRows),
      workload:
        workload === null
          ? null
          : {
              ...workload,
              msPerMinute:
                activeWorkloadMinutes > 0 ? Number((workload.totalMs / activeWorkloadMinutes).toFixed(3)) : null,
            },
      // The cap and staleness the app itself observed on the newest flush: a store that grew
      // tenfold and one that was superseded mid-write both read as "n flushes, m ms" without it.
      last: { at: last.at, items: last.extra?.items ?? null, bytes: last.extra?.bytes ?? null },
      byLeg: legSlopes.map((leg) => {
        const from = leg.observedFrom ?? leg.startAt;
        const to = leg.observedTo ?? leg.endAt;
        const rows = historyRows.filter((r) => r.at >= from && r.at <= to);
        return {
          name: leg.name,
          ordinal: leg.ordinal ?? null,
          ...(summarizeHistory(rows) || {
            flushes: 0,
            totalMs: 0,
            maxMs: 0,
            supersededFlushes: 0,
          }),
          lastItems: rows.at(-1)?.extra?.items ?? null,
        };
      }),
    };
  })();
  const workloadBurstLines = LEGS.length > 0 ? legBurstLinesTotal : workloadBursts === null ? null : workloadBursts * BURST_LINES;
  const cpuBlock = workloadCpu === null ? null : {
    ...workloadCpu,
    bursts: workloadBursts,
    burstLines: workloadBurstLines,
    msPer1000BurstLines: costPerUnit(workloadCpu.cpuSecondsTotal, workloadBurstLines === null ? null : workloadBurstLines / 1000),
    switches: workloadSwitches.length,
    msPerSwitch: costPerUnit(workloadCpu.cpuSecondsTotal, workloadSwitches.length),
  };

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
      totalMinutes: RUN_MINUTES,
      requestedTotalMinutes: TOTAL_MINUTES,
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
      // Switches the app was launched with beyond the app path and `--production`. Empty on
      // every measurement run; non-empty means an attached diagnostic (e.g. an open DevTools
      // endpoint) was part of the environment, which changes how the run must be read.
      appArgs: EXTRA_APP_ARGS,
      // Base knobs above are what a run with no legs ran; `legs` below is what the
      // workload actually ran, so a reader never has to infer the schedule.
      legs: LEGS,
    },
    rootPid,
    fixturePort,
    stats: {
      requestCount,
      openedTabs: tabIds.length,
      switches,
      bursts,
      // Per-phase burst counts: the global counter cannot answer which regime the lines
      // belonged to, and the workload's CPU cost is priced per line.
      burstsByPhase: burstsByPhase || null,
      reloads,
      terminalEventsCount: terminalEventCount,
      totalSamples: samples.length,
      totalSuspendedMinutes: meta.totalSuspendedMinutes || 0,
      // The span the workload *phase* actually covered, measured from the sleep-adjusted
      // stamps of its own samples: this is the value the name promises, and it is what a
      // slope fitted over the workload window is comparable across runs.
      activeWorkloadMinutes,
      // What the field above used to hold: elapsed time since launch minus suspends, which
      // on the 4 h run read `10` ten minutes into a 30-minute warmup. Kept under the name
      // that says what it measures, so a reader comparing runs can pick either.
      activeMinutesSinceStart: meta.activeWorkloadMinutes || 0,
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
        // CPU of the app-owned tree, as an exact difference of the cumulative per-process
        // counters, attributed to the roles the app's own stream named, and priced per unit
        // of work (per 1000 burst lines, per tab switch). Deliberately NOT a gate: a rate
        // bound needs a machine baseline this harness does not own, and the comparison that
        // matters is between bundles and legs on the same host. `null` means the window held
        // no samples, which is why it is never coerced to 0.
        cpu: cpuBlock,
        // True when a leg run wrote bursts but no leg recorded any: every per-line cost above is
        // then null for an instrument reason, not because the work was free.
        legBurstCounterSuspect,
        cpuByPhase,
        historyPersist,
      };
      const evaluation = evaluateFreezeVerdict(meta, rawMetrics, (orphanPids || []).length);
      return {
        ...rawMetrics,
        slopeSloSatisfied: evaluation.slopeOk,
        slopeGateApplicable: evaluation.slopeGateApplicable,
        privateSlopeSloSatisfied: evaluation.privateSlopeOk,
        privateSlopeMeasured: evaluation.privateSlopeMeasured,
        switchLatencyWorkloadSamples: evaluation.switchCount,
        switchLatencyMaxMs: evaluation.switchMaxMs,
        latencyMaxGated: evaluation.latencyMaxGated,
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
    legSlopes,
    slowSwitchSamples,
    switchSamples: switchSeries,
    switchSamplesDropped,
    stderrTail: (stderr || '').split(/\r?\n/).filter(Boolean).slice(-40),
    stdoutBenchmarkTail: (stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.startsWith('[antifan-benchmark]'))
      .slice(-40),
  };
}

async function main() {
  console.log(`========================================================================`);
  console.log(`  AntiFan Browser Desktop — Real Multi-Process Soak Benchmark (${RUN_MINUTES}m)`);
  console.log(`  Warmup: ${WARMUP_MINUTES}m | Workload: ${WORKLOAD_MINUTES}m | Recovery: ${RECOVERY_MINUTES}m`);
  if (LEGS.length) {
    for (const [index, leg] of LEGS.entries()) {
      console.log(`    Leg ${index + 1}: ${leg.name} | ${leg.minutes}m | bursts ${leg.burstLines} lines / ${leg.burstIntervalMs}ms`);
    }
  }
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
  // Per phase, because a per-line cost has to divide by the lines of *its own* window: the
  // global counter also carries warmup, and the recovery phase writes nothing at all.
  const burstsByPhase = { warmup: 0, workload: 0, recovery: 0 };
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
    historySamples: benchmarkIngest.history,
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
    if (EXTRA_APP_ARGS.length) console.log(`[soak] Extra app args (diagnosis run): ${EXTRA_APP_ARGS.join(' ')}`);
    child = spawn(electronBin, [PROJECT_ROOT, '--production', ...EXTRA_APP_ARGS], {
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
    stateMeta.burstsByPhase = { ...burstsByPhase };
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
  // Legs cover the workload phase only: warmup and recovery run different work, so
  // folding either into a leg would attribute its slope to the leg's knobs.
  const legTimeline = [];
  const legAt = (at) => {
    let cursor = warmupEndTime;
    for (const leg of LEGS) {
      const end = cursor + leg.minutes * 60 * 1000;
      if (at < end) return { ...leg, startAt: cursor, endAt: end };
      cursor = end;
    }
    return null;
  };
  let activeLegName = null;
  let activeLegLabel = null;
  // The counter must target the timeline entry, not the scheduling object: `legAt` returns a
  // spread copy of a `LEGS` entry, so `activeLeg.bursts++` incremented a throwaway and every
  // leg reported 0 observed bursts — which then priced the whole run's CPU per line against a
  // zero denominator (null), silently, on every bisect run.
  let activeLegEntry = null;
  const enterLeg = (leg, at) => {
    const open = legTimeline[legTimeline.length - 1];
    if (open && open.observedTo === null) open.observedTo = at;
    // Ordinal, because a bisect may return to a regime it already ran
    // (`baseline,burst4x,baseline`) and a name alone would merge legs 1 and 3 in every
    // table keyed by leg.
    const ordinal = legTimeline.length + 1;
    const entry = {
      name: leg.name,
      ordinal,
      burstLines: leg.burstLines,
      burstIntervalMs: leg.burstIntervalMs,
      startAt: leg.startAt,
      endAt: leg.endAt,
      observedFrom: at,
      observedTo: null,
      bursts: 0,
    };
    legTimeline.push(entry);
    activeLegEntry = entry;
    console.log(`[soak] Leg ${ordinal}: ${leg.name} | bursts ${leg.burstLines} lines / ${leg.burstIntervalMs}ms | until ${new Date(leg.endAt).toLocaleTimeString()}`);
    return `${leg.name}#${ordinal}`;
  };
  // Assigned by reference so a checkpoint mid-run already carries the leg boundaries
  // that make its partial series attributable.
  stateMeta.legs = legTimeline;
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
    const activeLeg = currentPhase === 'workload' ? legAt(now) : null;
    // Keyed by name *and* window: a bisect that returns to a previous regime
    // (baseline, burst4x, baseline) must read as three legs, not one that swallowed the
    // leg between them.
    const activeLegKey = activeLeg ? `${activeLeg.name}@${activeLeg.endAt}` : null;
    if (activeLegKey !== activeLegName) {
      activeLegName = activeLegKey;
      activeLegEntry = null;
      activeLegLabel = activeLeg ? enterLeg(activeLeg, now) : null;
    }
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
          // The tail is ~0.2 % of thousands of switches, and a top-ten list says only that
          // it exists: on the 4 h run the scrape-collision reading was refuted by the data
          // (1 of the 10 slowest sat within 3 s of a scrape and it was the smallest). Each
          // row therefore carries what separates the candidates — its phase, and the leg it
          // ran in — and the whole series is kept in the payload, so the attribution is
          // computed from counts instead of argued from ten samples.
          switchSamples.push({ at: Date.now(), ms: Number(latency.toFixed(3)), tabId, phase: currentPhase, leg: activeLegLabel });
          const perTabLatencies = switchLatencyByTab.get(tabId);
          if (perTabLatencies) perTabLatencies.push(latency);
          else switchLatencyByTab.set(tabId, [latency]);
          switches++;
        }
      } catch {}
      nextSwitchTime = now + SWITCH_INTERVAL_MS; // default 3s
    }
    // 2. Terminal Bursts (default every 30s in warmup & workload). The active leg owns
    // the volume, which is what makes the terminal path a variable instead of a
    // constant: a per-line cost shows up as a slope that tracks the leg.
    if (currentPhase !== 'recovery' && now >= nextBurstTime) {
      const burstLines = activeLeg ? activeLeg.burstLines : BURST_LINES;
      const burstIntervalMs = activeLeg ? activeLeg.burstIntervalMs : BURST_INTERVAL_MS;
      try {
        const marker = 100000 + bursts;
        await rpc('antifan.terminalInput', {
          sessionId,
          text: `1..${burstLines} | ForEach-Object { $_ }; Write-Output ('AF_8H_SOAK_' + (${marker} + 1))\r`,
        });
        bursts++;
        burstsByPhase[currentPhase]++;
        if (activeLegEntry) activeLegEntry.bursts++;
      } catch {}
      nextBurstTime = now + burstIntervalMs;
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
    stateMeta.burstsByPhase = { ...burstsByPhase };
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
    const isPassed = finalPayload.metrics.verdict === 'PASSED' || finalPayload.metrics.verdict === 'PASSED_SLOPE_NOT_GRADED';
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
    if (!finalPayload.metrics.slopeGateApplicable) {
      console.log('  Slope gate: not graded (leg run — the workload spans deliberately different burst volumes)');
    }
    if (Array.isArray(finalPayload.legSlopes) && finalPayload.legSlopes.length > 0) {
      console.log('  Leg slopes (fastest-growing process by committed private bytes):');
      for (const leg of finalPayload.legSlopes) {
        const top = leg.topSlopes[0];
        const detail = top
          ? `${top.role || top.type} pid=${top.pid} ${top.slopePrivateMBPerMin} MB/min (${top.deltaPrivateMB} MB / ${leg.observedMinutes}m)`
          : 'no samples in window';
        const legCpu = leg.cpu
          ? ` | CPU ${leg.cpu.cpuSecondsTotal}s (${leg.cpu.msPer1000BurstLines !== null ? leg.cpu.msPer1000BurstLines + ' ms/1000 lines' : 'per-line n/a'}, ${leg.cpu.msPerSwitch !== null ? leg.cpu.msPerSwitch + ' ms/switch' : 'per-switch n/a'})`
          : '';
        console.log(`  ${leg.name} | bursts ${leg.burstLines}/${leg.burstIntervalMs}ms x${leg.bursts ?? 0} | ${detail}${legCpu}`);
      }
    }
    const wlQ = finalPayload.metrics.switchLatencyMs || {};
    const wuQ = finalPayload.metrics.switchLatencyWarmupMs || {};
    const allQ = finalPayload.metrics.switchLatencyAllPhasesMs || {};
    console.log(`  Tab Switch Latency (workload, n=${finalPayload.metrics.switchLatencyWorkloadCount ?? 0}): p50=${wlQ.p50}ms (SLO <= ${FREEZE_SLO.switchLatencyP50Ms}ms), p95=${wlQ.p95}ms (SLO <= ${FREEZE_SLO.switchLatencyP95Ms}ms), max=${wlQ.max}ms (reported, not graded)`);
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
    const cpu = finalPayload.metrics.cpu;
    if (finalPayload.metrics.legBurstCounterSuspect) {
      console.error('  LEG BURST COUNTER FAULT: legs observed 0 bursts while the workload wrote some, so every per-line cost above is null for an instrument reason.');
    }
    if (cpu) {
      const perLine = cpu.msPer1000BurstLines !== null ? `${cpu.msPer1000BurstLines} ms / 1000 burst lines (${cpu.burstLines ?? 0} lines)` : 'per-line N/A (no observed workload bursts)';
      const perSwitch = cpu.msPerSwitch !== null ? `${cpu.msPerSwitch} ms / switch (${cpu.switches} switches)` : 'per-switch N/A';
      console.log(`  App CPU (workload, ${cpu.windowMinutes}m): ${cpu.cpuSecondsTotal}s total, ${cpu.cpuSecondsPerMinute}s/min | ${perLine} | ${perSwitch}`);
      const topCpu = cpu.perProcess[0];
      if (topCpu) {
        console.log(`  Top CPU Consumer: ${topCpu.role || topCpu.type || 'unattributed'} pid=${topCpu.pid} ${topCpu.seconds}s (${topCpu.share !== null ? (topCpu.share * 100).toFixed(1) + '%' : 'share N/A'})`);
      }
      if (cpu.notAttributablePids.length || cpu.unreadablePids.length || cpu.counterResetPids.length) {
        console.log(`  CPU Is a Lower Bound: ${cpu.notAttributablePids.length} pid(s) not present at both ends, ${cpu.unreadablePids.length} unreadable, ${cpu.counterResetPids.length} counter reset`);
      }
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

if (require.main === module) {
  main().catch((err) => {
    console.error('[soak] Fatal error:', redactCreds(err));
    process.exitCode = 1;
  });
}

// Exported so `test/unit/soak-latency-gate.test.mjs` and
// `test/unit/soak-switch-series.test.mjs` grade the real gate and the real payload
// contract instead of a copy of them — a re-implemented threshold or a re-implemented
// truncation rule in a test passes while production fails.
// Requiring this module does not start a run: the entry point is guarded above.
module.exports = { FREEZE_SLO, evaluateFreezeVerdict, buildReportPayload, parseExtraAppArgs, EXTRA_APP_ARGS, parseWorkloadLegs, calculateCpuDeltas, costPerUnit, readProcessCpuSeconds };
