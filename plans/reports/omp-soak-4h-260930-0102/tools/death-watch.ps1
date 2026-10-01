param([int]$WatchPid = 0, [string]$OutFile = 'E:\Work\apps\AntiFan\plans\reports\omp-soak-4h-260930-0102\death-watch.jsonl', [int]$MaxMinutes = 200)
$ErrorActionPreference = 'SilentlyContinue'
$deadline = (Get-Date).AddMinutes($MaxMinutes)
$rootPid = $null
$rootPid = $WatchPid
while ((Get-Date) -lt $deadline -and -not $dead) {
  if ($null -eq $rootPid) {
    $rootPid = (Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*AntiFan*' } | Sort-Object StartTime | Select-Object -First 1).Id
  }
  if ($rootPid) {
    $alive = Get-Process -Id $rootPid -ErrorAction SilentlyContinue
    if (-not $alive) {
      $dead = $true
      $now = Get-Date
      $rec = [ordered]@{ ts = $now.ToString('o'); event = 'root-died'; rootPid = $rootPid }
      # Recent system+application events in the prior 90s
      $events = @()
      foreach ($log in @('System','Application','Microsoft-Windows-Security-Mitigations/KernelMode','Microsoft-Windows-Windows Defender/Operational')) {
        try {
          $events += Get-WinEvent -FilterHashtable @{LogName=$log; StartTime=$now.AddSeconds(-120)} -ErrorAction SilentlyContinue | ForEach-Object { @{log=$log;time=$_.TimeCreated.ToString('o');id=$_.Id;provider=$_.ProviderName;msg=([string]$_.Message).Substring(0,[Math]::Min(300,[string]$_.Message.Length))} }
        } catch {}
      }
      $rec.events = $events
      # Process starts in prior 120s
      $procs = Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -gt $now.AddSeconds(-120) } | ForEach-Object { @{pid=$_.ProcessId;ppid=$_.ParentProcessId;name=$_.Name;cmd=([string]$_.CommandLine).Substring(0,[Math]::Min(300,[string]$_.CommandLine.Length))} }
      $rec.newProcs = $procs
      ($rec | ConvertTo-Json -Depth 6 -Compress) | Out-File -FilePath $OutFile -Append -Encoding utf8
    }
  }
  Start-Sleep -Seconds 20
}
