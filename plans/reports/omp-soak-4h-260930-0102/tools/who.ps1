param([string]$Ids)
$all = Get-CimInstance Win32_Process
$byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
foreach ($s in ($Ids -split ',')) {
  $id = [int]$s
  Write-Output "== $id"
  $cur = $byPid[$id]
  if (-not $cur) { Write-Output '  (gone)'; continue }
  while ($cur) { $c = [string]$cur.CommandLine; Write-Output ("  {0} {1} {2} :: {3}" -f $cur.ProcessId, $cur.Name, $cur.CreationDate, $c.Substring(0, [Math]::Min(180, $c.Length))); $cur = $byPid[[int]$cur.ParentProcessId] }
}
