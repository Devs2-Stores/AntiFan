$all = Get-CimInstance Win32_Process
$byPid = @{}; foreach ($p in $all) { $byPid[[int]$p.ProcessId] = $p }
$cur = $byPid[[int]$PID]
while ($cur) { Write-Output ("{0} {1} {2}" -f $cur.ProcessId, $cur.Name, ([string]$cur.CommandLine).Substring(0, [Math]::Min(160, ([string]$cur.CommandLine).Length))); $cur = $byPid[[int]$cur.ParentProcessId] }
Write-Output '--- electron/node/antifan ---'
$all | Where-Object { $_.Name -match 'electron|node|antifan' } | ForEach-Object { Write-Output ("{0} ppid={1} {2} exe={3} :: {4}" -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.ExecutablePath, ([string]$_.CommandLine).Substring(0, [Math]::Min(200, ([string]$_.CommandLine).Length))) }
