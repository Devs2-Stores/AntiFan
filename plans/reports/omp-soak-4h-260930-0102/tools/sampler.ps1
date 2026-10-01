param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [string]$StopFile,
  [int]$IntervalSec = 60,
  [int]$MaxMinutes = 300
)
# One JSON line per interval: machine CPU/RAM/commit, per-PID soak electron/node stats,
# GPU engine utilization (max instance per engine type, instance name + LUID kept, never summed).
$ErrorActionPreference = 'SilentlyContinue'
$repo = 'E:\Work\apps\AntiFan\'
$cores = [Environment]::ProcessorCount
$prevCpu = @{}
$prevT = $null
$deadline = (Get-Date).AddMinutes($MaxMinutes)

function Get-SoakProcs($all, $byPid) {
  $res = @()
  foreach ($p in $all) {
    $name = [string]$p.Name; $exe = [string]$p.ExecutablePath; $cmd = [string]$p.CommandLine
    $isA = ($name -ieq 'electron.exe' -and ($exe.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase) -or $exe.IndexOf('.soak-iso', [StringComparison]::OrdinalIgnoreCase) -ge 0))
    $isB = ($name -ieq 'node.exe' -and ($cmd.IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $cmd.IndexOf('.soak-iso', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $cmd.IndexOf('run-omp-soak', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $cmd.IndexOf('benchmark-real-soak-8h', [StringComparison]::OrdinalIgnoreCase) -ge 0))
    if (-not ($isA -or $isB)) { continue }
    $c = $p; $g = 0; $underOmp = $false
    while ($c -and $g -lt 40) { $c = $byPid[[int]$c.ParentProcessId]; if ($c -and ([string]$c.Name -match '^(omp|orca)')) { $underOmp = $true; break }; $g++ }
    # the soak runner is launched from the omp shell; keep it and its descendants (they carry run-omp-soak / smoke-omp-closed-loop / antifan-omp-mcp under the soak)
    $isSoakTree = $false
    $c = $p; $g = 0
    while ($c -and $g -lt 40) { if ([string]$c.CommandLine -match 'run-omp-soak|smoke-omp-closed-loop|benchmark-real-soak-8h') { $isSoakTree = $true; break }; $c = $byPid[[int]$c.ParentProcessId]; $g++ }
    if ($underOmp -and -not $isSoakTree) { continue }
    $res += $p
  }
  return $res
}

while ((Get-Date) -lt $deadline) {
  if ($StopFile -and (Test-Path $StopFile)) { break }
  $t0 = Get-Date
  $rec = [ordered]@{ ts = $t0.ToString('o'); epochMs = [int64](($t0.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds) }
  try {
    $ctr = Get-Counter -Counter @('\Processor(_Total)\% Processor Time', '\Memory\Available MBytes', '\Memory\Committed Bytes', '\Memory\Commit Limit') -SampleInterval 1 -MaxSamples 1
    foreach ($s in $ctr.CounterSamples) {
      $pth = $s.Path.ToLower()
      if ($pth -like '*% processor time') { $rec.cpuTotalPct = [math]::Round($s.CookedValue, 1) }
      elseif ($pth -like '*available mbytes') { $rec.ramAvailableMb = [math]::Round($s.CookedValue, 0) }
      elseif ($pth -like '*committed bytes') { $rec.commitMb = [math]::Round($s.CookedValue / 1MB, 0) }
      elseif ($pth -like '*commit limit') { $rec.commitLimitMb = [math]::Round($s.CookedValue / 1MB, 0) }
    }
  } catch { $rec.counterError = [string]$_ }
  if ($null -eq $rec.cpuTotalPct) { $rec.cpuTotalPct = $null; $rec.cpuTotalNote = 'counter unreadable' }

  # GPU engines
  $gpu = [ordered]@{}
  $gpuByPid = @{}
  try {
    $g = Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -MaxSamples 1
    foreach ($s in $g.CounterSamples) {
      $inst = [string]$s.InstanceName
      $v = [double]$s.CookedValue
      $m = [regex]::Match($inst, 'engtype_(.+)$')
      $etype = if ($m.Success) { $m.Groups[1].Value } else { 'unknown' }
      if (-not $gpu.Contains($etype) -or $v -gt $gpu[$etype].pct) { $gpu[$etype] = [ordered]@{ pct = [math]::Round($v, 2); instance = $inst } }
      $pm = [regex]::Match($inst, '^pid_(\d+)_')
      if ($pm.Success) {
        $gp = [int]$pm.Groups[1].Value
        if (-not $gpuByPid.ContainsKey($gp) -or $v -gt $gpuByPid[$gp].pct) { $gpuByPid[$gp] = @{ pct = [math]::Round($v, 2); instance = $inst } }
      }
    }
    $rec.gpuMaxByEngine = $gpu
  } catch { $rec.gpuMaxByEngine = $null; $rec.gpuError = [string]$_ }

  # Per process
  $all = Get-CimInstance Win32_Process
  $byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
  $now = Get-Date
  $procs = @()
  $curCpu = @{}
  foreach ($p in (Get-SoakProcs $all $byPid)) {
    $id = [int]$p.ProcessId
    $cpu100ns = [double]$p.KernelModeTime + [double]$p.UserModeTime
    $curCpu[$id] = $cpu100ns
    $pct = $null
    if ($prevT -and $prevCpu.ContainsKey($id)) {
      $dt = ($now - $prevT).TotalSeconds
      if ($dt -gt 0) { $pct = [math]::Round((($cpu100ns - $prevCpu[$id]) / 1e7) / ($dt * $cores) * 100, 2) }
    }
    $cmd = [string]$p.CommandLine
    $role = 'other'
    if ($cmd -match '--type=([a-z-]+)') { $role = $Matches[1] }
    elseif ($cmd -match 'run-omp-soak') { $role = 'soak-runner' }
    elseif ($cmd -match 'antifan-omp-mcp') { $role = 'mcp-proxy' }
    elseif ($cmd -match 'smoke-omp-closed-loop' -and $p.Name -ieq 'electron.exe') { $role = 'electron-main' }
    elseif ($cmd -match 'run-electron') { $role = 'run-electron' }
    elseif ($cmd -match 'daemon-entry') { $role = 'terminal-daemon' }
    $procs += [ordered]@{
      pid = $id; ppid = [int]$p.ParentProcessId; name = [string]$p.Name; role = $role
      cpuPct = $pct; cpuSec = [math]::Round($cpu100ns / 1e7, 2)
      workingSetMb = [math]::Round([double]$p.WorkingSetSize / 1MB, 1)
      privateMb = [math]::Round([double]$p.PrivatePageCount / 1MB, 1)
      handles = [int]$p.HandleCount; threads = [int]$p.ThreadCount
      gpuMaxPct = $(if ($gpuByPid.ContainsKey($id)) { $gpuByPid[$id].pct } else { $null })
    }
  }
  $prevCpu = $curCpu; $prevT = $now
  $rec.cores = $cores
  $rec.procCount = $procs.Count
  $rec.procs = $procs
  ($rec | ConvertTo-Json -Depth 6 -Compress) | Add-Content -Path $OutFile -Encoding utf8
  $elapsed = ((Get-Date) - $t0).TotalSeconds
  $sleep = [math]::Max(1, $IntervalSec - $elapsed)
  $slept = 0
  while ($slept -lt $sleep) {
    if ($StopFile -and (Test-Path $StopFile)) { break }
    Start-Sleep -Seconds 1; $slept++
  }
}
