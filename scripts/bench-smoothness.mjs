#!/usr/bin/env node
/**
 * AntiFan smoothness benchmark (read-only, works against the LIVE app).
 *
 * "The app feels stuck with many projects open" has two measurable halves, and this prints both:
 *
 *  1. Where the CPU goes. Every AntiFan and agent (omp.exe) process is sampled twice over a window;
 *     the delta in CPU time is reported by role (GUI main, renderer, GPU, utility, terminal daemon)
 *     and by the heaviest individual process. A renderer pinned near 100% (one full core) or a GPU
 *     process near 50-60% while the user is idle is a tab that never throttles.
 *  2. How long the GUI's main thread was blocked. The lifecycle heartbeat is a 5 s timer in the main
 *     process; each beat records `beatLagMs` (its overshoot) and the gap between beats is also
 *     derived from `ts`, so a stall shows up as a large gap with no events inside it. Gaps over 30 s
 *     are reported separately: those are machine suspend/resume, not app jank.
 *
 * Usage: node scripts/bench-smoothness.mjs [--seconds 12] [--json out.json]
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const WINDOW_SECONDS = Number(argOf('--seconds', '12'));
const JSON_OUT = argOf('--json', '');
const DATA_ROOT = process.env.ANTIFAN_DATA_ROOT || 'E:/Work/.antifan-data';
const SUSPEND_GAP_MS = 30_000;
/** Must match `LIFECYCLE_HEARTBEAT_MS` in src/main/index.ts. */
const HEARTBEAT_MS = 5000;

const PS = `
$rows = @()
foreach ($p in Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='AntiFan.exe' OR Name='omp.exe'") {
  $cpu = 0.0
  try { $cpu = [double]$p.UserModeTime + [double]$p.KernelModeTime } catch {}
  $cmd = [string]$p.CommandLine
  $role = 'gui'
  if ($cmd -match '--type=renderer') { $role = 'renderer' }
  elseif ($cmd -match '--type=gpu-process') { $role = 'gpu' }
  elseif ($cmd -match '--type=utility') { $role = 'utility' }
  elseif ($cmd -match 'daemon-entry') { $role = 'daemon' }
  $app = 'other'
  if ([string]$p.ExecutablePath -like '*apps\\AntiFan\\node_modules\\electron*' -or $p.Name -eq 'AntiFan.exe') { $app = 'AntiFan' }
  elseif ($p.Name -eq 'omp.exe') { $app = 'OMP' }
  $rows += [pscustomobject]@{ pid = [int]$p.ProcessId; app = $app; role = $role; cpu = $cpu; priv = [int64]$p.PrivatePageCount; ws = [int64]$p.WorkingSetSize }
}
$rows | ConvertTo-Json -Compress
`;

function sample() {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 << 20,
  });
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function heartbeatSeries() {
  const log = path.join(DATA_ROOT, 'runtime', 'logs', 'main.log');
  if (!fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).slice(-4000);
  const beats = [];
  for (const line of lines) {
    if (!line.includes('"event":"heartbeat"')) continue;
    try {
      const j = JSON.parse(line);
      beats.push({ ts: j.ts, lag: typeof j.beatLagMs === 'number' ? j.beatLagMs : null, tabs: j.tabCount, wc: j.webContentsCount });
    } catch { /* a torn last line is not a sample */ }
  }
  return beats.length ? beats : null;
}

const pct = (n) => `${Number(n).toFixed(1)}%`;
const gb = (bytes) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
const mb = (bytes) => `${Math.round(bytes / 1024 ** 2)} MB`;

const start = sample();
await new Promise((r) => setTimeout(r, WINDOW_SECONDS * 1000));
const end = sample();

const endByPid = new Map(end.map((p) => [p.pid, p]));
const perProcess = [];
for (const s of start) {
  const e = endByPid.get(s.pid);
  if (!e) continue;
  perProcess.push({
    pid: s.pid,
    app: s.app,
    role: s.role,
    cpuPct: ((e.cpu - s.cpu) / 1e7 / WINDOW_SECONDS) * 100,
    privBytes: e.priv,
    wsDeltaBytes: e.ws - s.ws,
  });
}

const groupBy = (key) => {
  const groups = new Map();
  for (const p of perProcess) {
    const agg = groups.get(p[key]) ?? { key: p[key], procs: 0, cpuPct: 0, privBytes: 0 };
    agg.procs += 1;
    agg.cpuPct += p.cpuPct;
    agg.privBytes += p.privBytes;
    groups.set(p[key], agg);
  }
  return [...groups.values()].sort((a, b) => b.cpuPct - a.cpuPct);
};

const beats = heartbeatSeries();
let jank = null;
if (beats) {
  const gaps = [];
  for (let i = 1; i < beats.length; i++) {
    const gap = beats[i].ts - beats[i - 1].ts;
    if (gap > SUSPEND_GAP_MS) continue; // suspend/resume, not app work
    gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  const at = (q) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * q))] : null);
  const recorded = beats.map((b) => b.lag).filter((v) => typeof v === 'number');
  jank = {
    beats: beats.length,
    gapP50: at(0.5),
    gapP95: at(0.95),
    gapP99: at(0.99),
    gapMax: gaps.length ? gaps[gaps.length - 1] : null,
    lateBeatsOver300Ms: gaps.filter((g) => g > HEARTBEAT_MS + 300).length,
    beatLagP95: recorded.length ? recorded.slice().sort((a, b) => a - b)[Math.floor(recorded.length * 0.95)] : null,
    lagSamples: recorded.length,
    tabs: beats[beats.length - 1].tabs,
    webContents: beats[beats.length - 1].wc,
  };
}

const totalCpu = perProcess.reduce((sum, p) => sum + p.cpuPct, 0);
const byApp = groupBy('app');
const byRole = groupBy('role');
const top = [...perProcess].sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 8);

console.log(`AntiFan smoothness — ${WINDOW_SECONDS}s window, ${perProcess.length} processes`);
console.log(`total CPU ${pct(totalCpu)} (100% = one core)\n`);
console.log('by app:');
for (const row of byApp) console.log(`  ${row.key.padEnd(8)} ${String(row.procs).padStart(3)} procs  ${pct(row.cpuPct).padStart(7)}  ${mb(row.privBytes)}`);
console.log('\nby role:');
for (const row of byRole) console.log(`  ${row.key.padEnd(9)} ${String(row.procs).padStart(3)} procs  ${pct(row.cpuPct).padStart(7)}  ${mb(row.privBytes)}`);
console.log('\nhottest processes:');
for (const row of top) {
  const delta = (row.wsDeltaBytes / 1024 ** 2).toFixed(0);
  console.log(`  pid ${String(row.pid).padEnd(6)} ${row.app.padEnd(8)} ${row.role.padEnd(9)} ${pct(row.cpuPct).padStart(7)}  ${mb(row.privBytes).padStart(8)}  ws ${delta > 0 ? '+' : ''}${delta} MB`);
}
if (jank) {
  console.log(`\nmain-thread heartbeat (${jank.beats} beats, ${jank.tabs ?? '?'} tabs, ${jank.webContents ?? '?'} webContents):`);
  console.log(`  gap p50 ${jank.gapP50} ms  p95 ${jank.gapP95} ms  p99 ${jank.gapP99} ms  max ${jank.gapMax} ms`);
  console.log(`  beats late >300 ms: ${jank.lateBeatsOver300Ms}` + (jank.lagSamples ? `  (recorded beatLagMs p95 ${jank.beatLagP95} ms)` : '  (this build predates beatLagMs)'));
} else {
  console.log('\nmain-thread heartbeat: no lifecycle log found');
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({
    windowSeconds: WINDOW_SECONDS,
    totalCpuPct: totalCpu,
    byApp,
    byRole,
    top,
    jank,
  }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
