<#
.SYNOPSIS
  Restart the live AntiFan desktop app through a clean quit.

.DESCRIPTION
  1. Refuses a stale build: when any src\**\*.ts is newer than .compiled\src\main\index.js the
     script prints BUILD_STALE and stops, unless -AllowStale is passed.
  2. Finds the one running main process (the owner of the bridge listener).
  3. Asks it to quit by launching the Electron executable with --antifan-quit-request. The
     running instance receives that flag through the single-instance handoff and runs its
     normal shutdown (quit.requested -> shutdown.clean in main.log), so no credential is needed.
  4. Waits for the old main PID to exit. A process that does not exit in time is left alone
     unless -Force is passed: a refused quit usually means work the user must decide on, so the
     script prints the quit.outcome row (haltedBy, shell counts) and the close-refusal.presented
     row (refusal codes) that this request wrote to main.log. After a -Force stop it follows the
     process for up to -ForceExitWaitSeconds (default 20) and reports MAIN_STILL_ALIVE if it stays.
  5. Starts the app the same way run-antifan.vbs does and waits for the bridge listener.

  Build first (npm run compile). The app loads .compiled, which npm run compile builds from the
  whole working tree, so the build the app runs is HEAD plus any uncommitted work.
#>
param(
  [switch]$DryRun,
  [switch]$AllowStale,
  [switch]$Force,
  [int]$BridgePort = 20130,
  [int]$QuitTimeoutSeconds = 45,
  [int]$StartTimeoutSeconds = 90,
  [int]$ForceExitWaitSeconds = 20
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$electronExe = Join-Path $repo 'node_modules\electron\dist\electron.exe'
$launcher = Join-Path $repo 'run-antifan.vbs'
$quitFlag = '--antifan-quit-request'

# 0. The build the app will load must not be older than the source it was built from.
$idx = Join-Path $repo '.compiled\src\main\index.js'
if (-not (Test-Path $idx)) { Write-Output 'BUILD_MISSING: run npm run compile'; exit 1 }
$builtAt = (Get-Item $idx).LastWriteTimeUtc
$newest = Get-ChildItem -Path (Join-Path $repo 'src') -Recurse -File -Filter '*.ts' |
  Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
Write-Output ("compiled index.js: {0:yyyy-MM-dd HH:mm:ss}Z" -f $builtAt)
Write-Output ("newest source:     {0:yyyy-MM-dd HH:mm:ss}Z ({1})" -f $newest.LastWriteTimeUtc, $newest.FullName.Substring($repo.Length + 1))
if ($newest.LastWriteTimeUtc -gt $builtAt) {
  if (-not $AllowStale) { Write-Output 'BUILD_STALE: run npm run compile, or pass -AllowStale'; exit 1 }
  Write-Output 'BUILD_STALE (continuing: -AllowStale)'
}

# 1. Locate the main process: the candidate that owns the bridge listener.
$all = Get-CimInstance Win32_Process -Filter "Name='electron.exe'"
$cands = @($all | Where-Object { $_.CommandLine -match [regex]::Escape($repo) -and $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch 'daemon-entry' -and $_.CommandLine -notmatch 'native-messaging' })
$listen = @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue)
$owner = if ($listen.Count -gt 0) { $listen[0].OwningProcess } else { $null }
$main = @($cands | Where-Object { $_.ProcessId -eq $owner })
Write-Output ("candidates: " + (($cands | ForEach-Object { $_.ProcessId }) -join ',') + " | listener owner: $owner")
if ($main.Count -ne 1) { Write-Output 'MAIN_NOT_UNIQUE'; exit 1 }
if ($cands.Count -gt 1) { Write-Output ("OTHER_INSTANCE_RUNNING: " + (($cands | Where-Object { $_.ProcessId -ne $owner } | ForEach-Object { $_.ProcessId }) -join ',')); exit 1 }
$mainPid = $main[0].ProcessId
$mainProc = Get-Process -Id $mainPid
Write-Output "main $mainPid started $($mainProc.StartTime.ToString('yyyy-MM-dd HH:mm:ss'))"

# This script must not run under the main app it is about to end.
$p = $PID
for ($i = 0; $i -lt 16 -and $p; $i++) {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$p"
  if (-not $proc) { break }
  if ($proc.ProcessId -eq $mainPid) { Write-Output 'MAIN_IS_ANCESTOR: run this from a shell outside the app'; exit 1 }
  $p = $proc.ParentProcessId
}

# The lifecycle journal the running instance writes (one JSON object per line). A refused quit
# leaves its reasons only there, so the script reads back the rows THIS request produced: same
# process, written after the request was sent.
$logPath = if ($env:ANTIFAN_DATA_ROOT) { Join-Path $env:ANTIFAN_DATA_ROOT 'runtime\logs\main.log' } elseif (Test-Path 'E:\Work\.antifan-data\runtime\logs\main.log') { 'E:\Work\.antifan-data\runtime\logs\main.log' } else { Join-Path $env:APPDATA 'AntiFan\data\runtime\logs\main.log' }

function Get-QuitJournalRow([string]$EventName, [long]$SinceMs, [int]$OwnerPid, [string]$Kind) {
  if (-not (Test-Path $logPath)) { return $null }
  $rows = @(Select-String -Path $logPath -SimpleMatch ('"event":"' + $EventName + '"') -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Line | ConvertFrom-Json } catch { $null } })
  return $rows | Where-Object { $_ -and $_.pid -eq $OwnerPid -and $_.ts -ge $SinceMs -and ((-not $Kind) -or $_.kind -eq $Kind) } | Select-Object -Last 1
}

function Write-QuitDiagnostics([int]$OwnerPid, [long]$SinceMs) {
  $outcome = Get-QuitJournalRow 'quit.outcome' $SinceMs $OwnerPid ''
  if ($outcome) {
    $halted = if ($null -eq $outcome.haltedBy) { 'none' } else { $outcome.haltedBy }
    Write-Output ("quit.outcome: shutdown={0} phase={1} haltedBy={2} closedShells={3} survivingShells={4} auxiliaries={5} coalescedRequests={6}" -f $outcome.shutdown, $outcome.phase, $halted, $outcome.closedShells, $outcome.survivingShells, $outcome.auxiliaries, $outcome.coalescedRequests)
  } else {
    Write-Output "quit.outcome: no row from main $OwnerPid after this request in $logPath (not answered yet, or the log rotated)"
  }
  $refusal = Get-QuitJournalRow 'close-refusal.presented' $SinceMs $OwnerPid 'quit'
  if ($refusal) {
    Write-Output ("close-refusal.presented: surface={0} reasons={1} reasonCount={2}" -f $refusal.surface, (@($refusal.reasons) -join ','), $refusal.reasonCount)
  }
}

if ($DryRun) { Write-Output 'DRY_RUN: nothing sent, nothing stopped'; exit 0 }

# 2. Ask the running instance to quit; the second process hands the flag over and exits.
$env_backup = @{}
Get-ChildItem Env: | Where-Object { $_.Name -like 'ANTIFAN_*' -or $_.Name -like 'ELECTRON_*' } | ForEach-Object {
  $env_backup[$_.Name] = $_.Value
  Remove-Item "Env:$($_.Name)"
}
$stopAt = Get-Date
$sinceMs = [DateTimeOffset]::new($stopAt.ToUniversalTime()).ToUnixTimeMilliseconds()
Write-Output "sending $quitFlag to main $mainPid at $($stopAt.ToUniversalTime().ToString('HH:mm:ss.fff'))Z"
Start-Process -FilePath $electronExe -ArgumentList @("`"$repo`"", '--allow-eval', $quitFlag) -WorkingDirectory $repo -WindowStyle Hidden | Out-Null

# 3. Wait for the old main PID and its listener to go.
$deadline = (Get-Date).AddSeconds($QuitTimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  $alive = Get-Process -Id $mainPid -ErrorAction SilentlyContinue
  $still = @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue)
  if (-not $alive -and $still.Count -eq 0) { break }
  Start-Sleep -Milliseconds 500
}
if (Get-Process -Id $mainPid -ErrorAction SilentlyContinue) {
  Write-QuitDiagnostics -OwnerPid $mainPid -SinceMs $sinceMs
  if (-not $Force) {
    Write-Output "QUIT_NOT_COMPLETED: main $mainPid is still alive after ${QuitTimeoutSeconds}s (a refused quit keeps the process). Not forcing; re-run with -Force to stop it."
    exit 1
  }
  Write-Output "QUIT_TIMEOUT: stopping main $mainPid (-Force); shutdown.clean will not be written for this stop"
  Stop-Process -Id $mainPid -Force
  # A killed Electron main can take well over two seconds to leave the process table while its
  # children are reaped, so follow it for a bounded window instead of judging after a fixed sleep.
  $exitDeadline = (Get-Date).AddSeconds($ForceExitWaitSeconds)
  while ((Get-Process -Id $mainPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $exitDeadline) {
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id $mainPid -ErrorAction SilentlyContinue) { Write-Output "MAIN_STILL_ALIVE: main $mainPid did not exit within ${ForceExitWaitSeconds}s of the forced stop"; exit 1 }
} else {
  Write-Output "main $mainPid exited after $([int]((Get-Date) - $stopAt).TotalSeconds)s (clean quit: check main.log for quit.requested then shutdown.clean)"
}

# 4. Relaunch as Explorer would (no inherited ANTIFAN_* / ELECTRON_* variables) and wait for the bridge.
Start-Process wscript.exe "`"$launcher`"" -WorkingDirectory $repo
$deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)
$newOwner = $null
while ((Get-Date) -lt $deadline) {
  $l = @(Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue)
  if ($l.Count -gt 0) { $newOwner = $l[0].OwningProcess; break }
  Start-Sleep -Milliseconds 500
}
foreach ($name in $env_backup.Keys) { Set-Item "Env:$name" $env_backup[$name] }
if (-not $newOwner) { Write-Output "NO_LISTENER_AFTER_${StartTimeoutSeconds}S"; exit 1 }
$np = Get-Process -Id $newOwner
Write-Output "relaunched: main $newOwner started $($np.StartTime.ToString('yyyy-MM-dd HH:mm:ss')) after $([int]((Get-Date) - $stopAt).TotalSeconds)s"
