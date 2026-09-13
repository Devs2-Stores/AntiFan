# AntiFan - Apple Mobile Device Service / iTunes Background Runner
#
# Keeps AppleMobileDeviceProcess listening on tcp 27015 (the usbmuxd endpoint the phone adapter
# enumerates through) without leaving an iTunes window in the user's face.
#
# Contract:
#   * Idempotent  - exits immediately when the port is already served.
#   * Bounded     - waits at most 20s for the port, then at most 20s for a window to hide.
#   * Scoped      - hides ONLY the window of the iTunes process this script started. iTunes is
#                   single-instance: if the user already had it open, `Start-Process` would activate
#                   their window rather than create a process, so no window is touched at all.
#   * Honest exit - 0 when tcp:27015 is served, 1 when iTunes never came up. Nothing is reported as
#                   successful on a timeout.

$Port = 27015
$WaitTimeoutSeconds = 20
$PollMilliseconds = 500

function Test-UsbmuxPort {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

# Only ever returns a process that started after this script ran, so a pre-existing iTunes instance
# (which would be the user's) can never be claimed and hidden.
function Get-ITunesStartedSince([datetime]$Since) {
    return Get-Process iTunes -ErrorAction SilentlyContinue |
        Where-Object { $_.StartTime -ge $Since } |
        Sort-Object StartTime -Descending |
        Select-Object -First 1
}

if (Test-UsbmuxPort) {
    Write-Host "[antifan] usbmuxd is already listening on tcp:$Port - nothing to do."
    exit 0
}

# --- Launch ---------------------------------------------------------------------------------------
$startedAt = Get-Date
$launched = $null
$existing = Get-Process iTunes -ErrorAction SilentlyContinue

if ($existing) {
    Write-Host "[antifan] iTunes is already running (PID $($existing.Id -join ',')); leaving its windows untouched."
} else {
    Write-Host '[antifan] Starting iTunes so AppleMobileDeviceProcess can bind tcp:27015...'
    $launched = Start-Process 'itunes:' -PassThru -ErrorAction SilentlyContinue
    if (-not $launched) {
        # Some shells do not hand back a process handle for a protocol launch; pick it up on the next
        # pass instead of guessing here.
        Write-Host '[antifan] iTunes was launched through its protocol handler; resolving the process once it is up...'
    }
}

# --- Wait for the usbmuxd endpoint ----------------------------------------------------------------
# The port is the real readiness signal: AppleMobileDeviceProcess is started by iTunes, so once it
# listens, the process this script launched definitely exists. Resolving it here (instead of only
# right after the launch call) is what makes the window step work on a cold start, where iTunes takes
# several seconds to appear.
$deadline = (Get-Date).AddSeconds($WaitTimeoutSeconds)
while (-not (Test-UsbmuxPort) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds $PollMilliseconds
}

if (-not (Test-UsbmuxPort)) {
    Write-Warning "[antifan] usbmuxd did not open tcp:$Port within ${WaitTimeoutSeconds}s; the phone adapter will report the transport as unavailable."
    exit 1
}

if (-not $launched -and -not $existing) {
    $launched = Get-ITunesStartedSince $startedAt
}

# --- Hide the window, but only for the process this script started -------------------------------
if ($launched) {
    $definition = @'
using System;
using System.Runtime.InteropServices;
public class Win32Window {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@
    if (-not ([System.Management.Automation.PSTypeName]'Win32Window').Type) {
        Add-Type -TypeDefinition $definition
    }

    # The window appears a moment after the process, so poll that one PID and only for a bounded time.
    $windowDeadline = (Get-Date).AddSeconds($WaitTimeoutSeconds)
    $hidden = $false
    while (-not $hidden -and (Get-Date) -lt $windowDeadline) {
        $proc = Get-Process -Id $launched.Id -ErrorAction SilentlyContinue
        if (-not $proc) { break }
        if ($proc.MainWindowHandle -ne 0) {
            [Win32Window]::ShowWindowAsync($proc.MainWindowHandle, 0) | Out-Null
            $hidden = $true
            Write-Host "[antifan] iTunes (PID $($proc.Id)) is running hidden; usbmuxd listening on tcp:$Port."
        } else {
            Start-Sleep -Milliseconds $PollMilliseconds
        }
    }

    if (-not $hidden) {
        Write-Warning "[antifan] iTunes did not expose a window within ${WaitTimeoutSeconds}s; tcp:$Port is up but a window may appear."
    }
} elseif (-not $existing) {
    Write-Warning '[antifan] usbmuxd is up but no iTunes process could be identified to hide.'
}

exit 0
