param([string]$Ids, [string]$Reason = 'cleanup')
# Kill by PID only (no tree kill), after re-verifying each PID via CIM.
# Refuses anything whose ancestor chain contains omp/Orca (protects this OMP session's MCP children).
$out = Split-Path -Parent $PSScriptRoot
$log = Join-Path $out 'killed.log'
$pidsFile = Join-Path $out 'pids.txt'
$repo = 'E:\Work\apps\AntiFan\'
$goalPids = @()
if (Test-Path $pidsFile) { $goalPids = Get-Content $pidsFile | ForEach-Object { ($_ -split '\s+')[0] } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ } }
$all = Get-CimInstance Win32_Process
$byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
function Test-UnderOmp([int]$id) {
  $c = $byPid[$id]; $g = 0
  while ($c -and $g -lt 40) {
    $c = $byPid[[int]$c.ParentProcessId]
    if ($c -and ([string]$c.Name -match '^(omp|orca)')) { return $true }
    $g++
  }
  return $false
}
$targets = @()
foreach ($s in ($Ids -split ',')) {
  if (-not $s) { continue }
  $id = [int]$s
  $p = $byPid[$id]
  if (-not $p) { Add-Content $log ("{0} SKIP pid={1} gone" -f (Get-Date -Format o), $id); continue }
  $exe = [string]$p.ExecutablePath; $cmd = [string]$p.CommandLine; $name = [string]$p.Name
  $ok = $false
  if ($name -ieq 'electron.exe' -and $exe.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { $ok = $true }
  if ($name -ieq 'node.exe' -and $cmd.IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $ok = $true }
  if ($goalPids -contains $id) { $ok = $true }
  if ($name -match '^(orca|omp|zalo|dwm|explorer|conhost|powershell|pwsh|cmd)') { $ok = $false }
  if (Test-UnderOmp $id) {
    # Under omp: only goal-created PIDs may be killed, never the session's own MCP children.
    if (-not ($goalPids -contains $id) -or $cmd -match 'antifan-agent\.cjs|antifan-omp-mcp\.cjs') { $ok = $false }
  }
  if (-not $ok) { Add-Content $log ("{0} REFUSE pid={1} name={2} cmd={3}" -f (Get-Date -Format o), $id, $name, $cmd); continue }
  Add-Content $log ("{0} KILL reason={1} pid={2} ppid={3} name={4} cmd={5}" -f (Get-Date -Format o), $Reason, $id, $p.ParentProcessId, $name, $cmd)
  $targets += $id
}
foreach ($id in $targets) { & taskkill.exe /PID $id 2>&1 | Out-Null }
if ($targets.Count -gt 0) { Start-Sleep -Seconds 10 }
foreach ($id in $targets) {
  $still = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($still) {
    Add-Content $log ("{0} FORCE pid={1}" -f (Get-Date -Format o), $id)
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
  } else { Add-Content $log ("{0} EXITED pid={1}" -f (Get-Date -Format o), $id) }
}
Get-Content $log -Tail 30
