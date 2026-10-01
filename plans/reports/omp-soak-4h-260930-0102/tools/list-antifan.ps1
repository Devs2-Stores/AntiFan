param([string]$OutFile = "")
# Lists AntiFan processes in scope (a) electron under repo, (b) node with repo in cmdline.
# Marks processes that descend from the omp/Orca ancestor chain of this shell as PROTECTED.
$ErrorActionPreference = 'SilentlyContinue'
$repo = 'E:\Work\apps\AntiFan\'
$all = Get-CimInstance Win32_Process
$byPid = @{}
foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }

# ancestor chain of this powershell
$chain = @()
$cur = $byPid[[int]$PID]
$guard = 0
while ($cur -and $guard -lt 40) {
  $chain += [int]$cur.ProcessId
  $cur = $byPid[[int]$cur.ParentProcessId]
  $guard++
}
# protected roots: omp and anything named orca in chain
$protectedRoots = @()
foreach ($id in $chain) {
  $p = $byPid[$id]
  if ($p.Name -match '^(omp|orca)' -or ($p.CommandLine -match '\bomp\b')) { $protectedRoots += $id }
}

function Get-Ancestors([int]$id) {
  $res = @(); $c = $byPid[$id]; $g = 0
  while ($c -and $g -lt 40) { $c = $byPid[[int]$c.ParentProcessId]; if ($c) { $res += [int]$c.ProcessId }; $g++ }
  return $res
}

$rows = @()
foreach ($p in $all) {
  $exe = [string]$p.ExecutablePath
  $cmd = [string]$p.CommandLine
  $scope = $null
  if ($p.Name -ieq 'electron.exe' -and $exe.StartsWith($repo, [StringComparison]::OrdinalIgnoreCase)) { $scope = 'a' }
  elseif ($p.Name -ieq 'node.exe' -and $cmd.IndexOf($repo, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $scope = 'b' }
  elseif ($p.Name -ieq 'node.exe' -and $cmd.IndexOf('E:/Work/apps/AntiFan/', [StringComparison]::OrdinalIgnoreCase) -ge 0) { $scope = 'b' }
  if (-not $scope) { continue }
  $anc = Get-Ancestors ([int]$p.ProcessId)
  $protected = $false
  foreach ($r in $protectedRoots) { if ($anc -contains $r) { $protected = $true } }
  if ($chain -contains [int]$p.ProcessId) { $protected = $true }
  $rows += [pscustomobject]@{
    pid = [int]$p.ProcessId; ppid = [int]$p.ParentProcessId; name = $p.Name; scope = $scope;
    protected = $protected; created = [string]$p.CreationDate; cmd = $cmd
  }
}
$json = $rows | ConvertTo-Json -Depth 3
if ($OutFile) { $json | Out-File -FilePath $OutFile -Encoding utf8 }
Write-Output ("chain=" + ($chain -join ',') + " protectedRoots=" + ($protectedRoots -join ','))
Write-Output $json
