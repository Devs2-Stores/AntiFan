#!/usr/bin/env node
'use strict';
/**
 * Samples the machine load that lives *outside* the soak's own process tree, so the run's
 * verdict can state what else was competing for the machine instead of asserting it was idle.
 *
 * Why this exists: the harness payload has no machine-level field (grep for freeMem/loadPct in
 * benchmark-real-soak-8h.cjs is empty), and the app's own `processSamples` come from Electron's
 * `app.getAppMetrics()` inside the measured app, so they describe that app and nothing else. A
 * second AntiFan instance that happens to be alive is therefore invisible in the payload and
 * visible only as competition - exactly the kind of thing a verdict must quantify rather than
 * assume. This sampler records it as a JSONL series and exits on its own.
 *
 * Usage:
 *   node scripts/sample-external-load.cjs --minutes 250 --harness-pid 21752 --out <file.jsonl>
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const MINUTES = Number(argOf('--minutes', '250'));
const INTERVAL_MS = Number(argOf('--interval-ms', String(5 * 60 * 1000)));
const HARNESS_PID = Number(argOf('--harness-pid', '0'));
const LAUNCH_EPOCH = Number(argOf('--launch-epoch', '0'));
const OUT = argOf('--out', path.resolve(__dirname, '../plans/reports/runtime-verification/external-load.jsonl'));
const COMPILED_DIR = path.resolve(__dirname, '../.compiled');

/**
 * Compiled files rewritten after the run launched. This is the drift flag the harness only
 * settles at the end (`config.bundle.changedDuringRun`), sampled while it can still change the
 * reading: a renderer reload inside a leg loads whatever is on disk at that moment, so a rewrite
 * at minute 90 makes the leg after it a different bundle under the same run identity.
 */
function countCompiledRewrittenSince(epoch) {
  if (!epoch) return null;
  let count = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      try {
        if (fs.statSync(full).mtimeMs > epoch) count += 1;
      } catch {
        /* a file that vanished mid-walk cannot have been rewritten for the run */
      }
    }
  };
  walk(COMPILED_DIR);
  return count;
}

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process
$harness = ${Number.isFinite(HARNESS_PID) ? HARNESS_PID : 0}
$mine = New-Object System.Collections.Generic.HashSet[int]
if ($harness -gt 0) { [void]$mine.Add($harness) }
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    if ($mine.Contains([int]$p.ParentProcessId) -and -not $mine.Contains([int]$p.ProcessId)) {
      [void]$mine.Add([int]$p.ProcessId); $changed = $true
    }
  }
}
$rows = @()
foreach ($p in $all) {
  if ($p.Name -notmatch 'electron|winpty') { continue }
  $owner = if ($mine.Contains([int]$p.ProcessId)) { 'run' } else { 'external' }
  $rows += [pscustomobject]@{ pid = $p.ProcessId; owner = $owner; rssMB = [math]::Round($p.WorkingSetSize / 1MB, 1) }
}
$cpu = @{}
foreach ($c in Get-Process -ErrorAction SilentlyContinue) { $cpu[[int]$c.Id] = [double]$c.CPU }
$rows | ForEach-Object { $_ | Add-Member -NotePropertyName cpuSec -NotePropertyValue ($cpu[[int]$_.pid]) -Force }
$os = Get-CimInstance Win32_OperatingSystem
$mem = [pscustomobject]@{ freeMB = [math]::Round($os.FreePhysicalMemory / 1KB, 0); totalMB = [math]::Round($os.TotalVisibleMemorySize / 1KB, 0) }
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
[pscustomobject]@{ rows = $rows; mem = $mem; loadPct = [math]::Round([double]$load, 1) } | ConvertTo-Json -Depth 5 -Compress
`;

function sample() {
  let raw;
  try {
    raw = execFileSync('powershell.exe', ['-NoProfile', '-Command', PS_SCRIPT], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    });
  } catch (err) {
    return { at: new Date().toISOString(), error: `powershell failed: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch (err) {
    return { at: new Date().toISOString(), error: `unparsable payload: ${err.message}` };
  }
  const rows = Array.isArray(parsed.rows) ? parsed.rows : parsed.rows ? [parsed.rows] : [];
  const sum = (owner) => {
    const subset = rows.filter((r) => r.owner === owner);
    return {
      procs: subset.length,
      rssMB: Number(subset.reduce((acc, r) => acc + (r.rssMB || 0), 0).toFixed(1)),
      cpuSec: Number(subset.reduce((acc, r) => acc + (r.cpuSec || 0), 0).toFixed(1)),
    };
  };
  return {
    at: new Date().toISOString(),
    run: sum('run'),
    external: sum('external'),
    machineFreeMB: parsed.mem?.freeMB ?? null,
    machineTotalMB: parsed.mem?.totalMB ?? null,
    loadPct: parsed.loadPct ?? null,
    compiledRewritten: countCompiledRewrittenSince(LAUNCH_EPOCH),
    externalPids: rows.filter((r) => r.owner === 'external').map((r) => r.pid),
  };
}

(async () => {
  const deadline = Date.now() + MINUTES * 60 * 1000;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  // Append-safe: a restart must not erase the samples the earlier incarnation earned, which is
  // the same defect (a payload that loses its own prefix) this run exists to stop repeating.
  if (!fs.existsSync(OUT)) {
    fs.writeFileSync(
      OUT,
      `${JSON.stringify({
        at: new Date().toISOString(),
        note: 'external = winpty/electron processes outside the soak harness tree; run = inside it; compiledRewritten = .compiled files newer than the run launch',
        harnessPid: HARNESS_PID,
        launchEpoch: LAUNCH_EPOCH || null,
      })}\n`,
      'utf8',
    );
  } else {
    fs.appendFileSync(OUT, `${JSON.stringify({ at: new Date().toISOString(), note: 'sampler restarted' })}\n`, 'utf8');
  }
  while (Date.now() < deadline) {
    const row = sample();
    fs.appendFileSync(OUT, `${JSON.stringify(row)}\n`, 'utf8');
    console.log(`[external-load] ${row.at} run=${row.run?.procs ?? '?'}p/${row.run?.rssMB ?? '?'}MB external=${row.external?.procs ?? '?'}p/${row.external?.rssMB ?? '?'}MB free=${row.machineFreeMB ?? '?'}MB load=${row.loadPct ?? '?'}% drift=${row.compiledRewritten ?? '?'}`);
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  console.log(`[external-load] done, ${MINUTES} minutes sampled -> ${OUT}`);
})();
