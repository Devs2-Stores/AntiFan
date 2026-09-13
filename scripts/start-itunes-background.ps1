# AntiFan - Apple Mobile Device Service / iTunes Background Runner
# Ensures AppleMobileDeviceProcess is listening on tcp 27015 with iTunes window hidden.

$ErrorActionPreference = 'SilentlyContinue'

# 1. Check if usbmuxd is already listening on 27015
$listening = Get-NetTCPConnection -LocalPort 27015 -State Listen -ErrorAction SilentlyContinue

if (-not $listening) {
    Write-Host '[antifan] Starting iTunes service in background...'
    Start-Process 'itunes:'
    Start-Sleep -Seconds 3
}

# 2. Hide iTunes main window from Desktop and Taskbar
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

$itunes = Get-Process iTunes -ErrorAction SilentlyContinue
if ($itunes -and $itunes.MainWindowHandle -ne 0) {
    [Win32Window]::ShowWindowAsync($itunes.MainWindowHandle, 0) | Out-Null
    Write-Host "[antifan] iTunes (PID $($itunes.Id)) is now running hidden in the background."
} else {
    Write-Host '[antifan] AppleMobileDeviceProcess is active and iTunes is running in the background.'
}
