<#
  AntiFan wait-alert - Windows attention raiser for "OMP is blocked on you".

  Invoked by .omp/extensions/wait-alert/index.ts the moment the harness starts
  waiting on the user (ask prompt, tool approval), and again from that extension's
  bounded repeat timer (with -NoPanel, so panels never stack).

  Channels, none of which steal keyboard focus:
    1. system sound (or a custom .wav) - the only channel that reaches the user
       away from the screen, and it survives Focus Assist
    2. taskbar flash of the Orca window, repeating until Orca reaches the
       foreground, so the signal stops exactly when the user looks at Orca
    3. an always-on-top status panel carrying the pending question. It is shown
       with WS_EX_NOACTIVATE so it appears over fullscreen apps (where toasts and
       the taskbar are suppressed) without taking the keyboard away from what the
       user is typing in. The caller kills the process once the wait resolves;
       -LifetimeMs is the backstop.

  This file is deliberately pure ASCII: Windows PowerShell 5.1 decodes a BOM-less
  .ps1 as ANSI, so callers pass every displayed string as an argument.
#>
[CmdletBinding()]
param(
  [string]$Title = 'AntiFan - OMP is waiting for you',
  [string]$Body = '',
  [ValidateSet('system', 'off')][string]$Sound = 'system',
  [string]$SoundFile = '',
  [int]$LifetimeMs = 60000,
  [int]$FlashCount = 0,
  [string]$ErrorLog = '',
  [switch]$NoFlash,
  [switch]$NoPanel
)

$ErrorActionPreference = 'Stop'

function Write-AlertDiagnostic {
  param([string]$Message)
  if (-not $ErrorLog) { return }
  try {
    Add-Content -LiteralPath $ErrorLog -Value ("{0} {1}" -f (Get-Date).ToString('o'), $Message) -Encoding UTF8
  } catch { }
}

function Invoke-AlertSound {
  if ($Sound -eq 'off') { return }
  try {
    if ($SoundFile -and (Test-Path -LiteralPath $SoundFile)) {
      (New-Object System.Media.SoundPlayer $SoundFile).Play()
    } else {
      [System.Media.SystemSounds]::Exclamation.Play()
    }
  } catch {
    # A missing or muted audio endpoint must not stop the visible channels.
    Write-AlertDiagnostic "sound-failed: $($_.Exception.Message)"
  }
}

function Add-Win32Interop {
  if (([System.Management.Automation.PSTypeName]'AntiFanWin32').Type) { return }
  Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class AntiFanWin32
{
    private const int GWL_EXSTYLE = -20;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    [StructLayout(LayoutKind.Sequential)]
    private struct FLASHWINFO
    {
        public uint cbSize;
        public IntPtr hwnd;
        public uint dwFlags;
        public uint uCount;
        public uint dwTimeout;
    }

    [DllImport("user32.dll")]
    private static extern bool FlashWindowEx(ref FLASHWINFO pwfi);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
    private static extern int GetWindowLong(IntPtr hwnd, int index);

    [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
    private static extern int SetWindowLong(IntPtr hwnd, int index, int value);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    public static bool Flash(IntPtr hwnd, uint flags, uint count, uint timeoutMs)
    {
        FLASHWINFO info = new FLASHWINFO();
        info.cbSize = (uint)Marshal.SizeOf(typeof(FLASHWINFO));
        info.hwnd = hwnd;
        info.dwFlags = flags;
        info.uCount = count;
        info.dwTimeout = timeoutMs;
        return FlashWindowEx(ref info);
    }

    // WS_EX_NOACTIVATE applied before the first Show(): the window paints on top
    // without ever becoming the foreground window.
    public static bool SuppressActivation(IntPtr hwnd)
    {
        int style = GetWindowLong(hwnd, GWL_EXSTYLE);
        int updated = style | WS_EX_NOACTIVATE;
        return SetWindowLong(hwnd, GWL_EXSTYLE, updated) != 0 || updated == style;
    }

    // HWND_TOPMOST | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW:
    // forces the panel above every non-topmost window without activating it.
    public static bool ShowTopMostNoActivate(IntPtr hwnd)
    {
        return SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040);
    }
}
'@
}

function Get-OrcaWindowHandle {
  # The agent terminal lives inside Orca, so Orca's taskbar button is the target:
  # flashing it marks the exact window the user has to look at.
  try {
    $orca = Get-Process -Name 'orca', 'antifan', 'electron' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
      Select-Object -First 1
    if ($orca) { return $orca.MainWindowHandle }
  } catch { }
  return [IntPtr]::Zero
}

function Invoke-TaskbarFlash {
  if ($NoFlash) { return }
  $handle = Get-OrcaWindowHandle
  if ($handle -eq [IntPtr]::Zero) { return }
  try {
    Add-Win32Interop
    # FLASHW_ALL | FLASHW_TIMERNOFG: flash caption and taskbar until the window
    # reaches the foreground.
    $flags = [uint32](0x00000003 -bor 0x0000000C)
    [void][AntiFanWin32]::Flash($handle, $flags, [uint32]$FlashCount, [uint32]0)
  } catch {
    # Taskbar flashing is best-effort: sound and the panel still carry the alert.
    Write-AlertDiagnostic "flash-failed: $($_.Exception.Message)"
  }
}

function New-QuestionBadgeBitmap {
  param([int]$Size = 56)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $bgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, 245, 158, 11))
  $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(245, 158, 11), 2.0)
  $qBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(251, 191, 36))
  [float]$fontSize = [Math]::Max(14.0, [float]($Size * 0.48))
  $qFont = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center

  try {
    $rect = New-Object System.Drawing.RectangleF(3, 3, $Size - 6, $Size - 6)
    $g.FillEllipse($bgBrush, $rect)
    $g.DrawEllipse($borderPen, $rect)
    $g.DrawString('?', $qFont, $qBrush, $rect, $sf)
  } finally {
    $bgBrush.Dispose()
    $borderPen.Dispose()
    $qBrush.Dispose()
    $qFont.Dispose()
    $sf.Dispose()
    $g.Dispose()
  }

  return $bmp
}

function Show-AlertPanel {
  if ($NoPanel) { return }
  Write-AlertDiagnostic "panel-enter body=[$Body] title=[$Title]"
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    Add-Win32Interop

    $panelWidth = 380
    $panelHeight = 100

    $form = New-Object System.Windows.Forms.Form
    $form.Text = $Title
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
    $form.TopMost = $true
    $form.ShowInTaskbar = $false
    $form.Width = $panelWidth
    $form.Height = $panelHeight
    $form.BackColor = [System.Drawing.Color]::FromArgb(20, 20, 24)
    $form.ForeColor = [System.Drawing.Color]::FromArgb(245, 245, 245)

    # Rounded border region
    $r = 16
    $w = $panelWidth
    $h = $panelHeight
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc(0, 0, $r, $r, 180, 90)
    $path.AddArc($w - $r, 0, $r, $r, 270, 90)
    $path.AddArc($w - $r, $h - $r, $r, $r, 0, 90)
    $path.AddArc(0, $h - $r, $r, $r, 90, 90)
    $path.CloseFigure()
    $form.Region = New-Object System.Drawing.Region($path)
    $path.Dispose()

    # Paint border
    $form.Add_Paint({
      param($sender, $e)
      $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(234, 179, 8), 1.5)
      $e.Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $bw = $sender.Width - 1
      $bh = $sender.Height - 1
      $br = 16
      $bp = New-Object System.Drawing.Drawing2D.GraphicsPath
      $bp.AddArc(0, 0, $br, $br, 180, 90)
      $bp.AddArc($bw - $br, 0, $br, $br, 270, 90)
      $bp.AddArc($bw - $br, $bh - $br, $br, $br, 0, 90)
      $bp.AddArc(0, $bh - $br, $br, $br, 90, 90)
      $bp.CloseFigure()
      $e.Graphics.DrawPath($borderPen, $bp)
      $borderPen.Dispose()
      $bp.Dispose()
    })

    $area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $form.Left = $area.Right - $panelWidth - 20
    $form.Top = $area.Bottom - $panelHeight - 20

    # Question Badge Icon
    $avatarBmp = New-QuestionBadgeBitmap -Size 60
    $picAvatar = New-Object System.Windows.Forms.PictureBox
    $picAvatar.Size = New-Object System.Drawing.Size(60, 60)
    $picAvatar.Location = New-Object System.Drawing.Point(14, 20)
    $picAvatar.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::CenterImage
    $picAvatar.Image = $avatarBmp
    $picAvatar.BackColor = [System.Drawing.Color]::Transparent
    $form.Controls.Add($picAvatar)

    # Heading (Amber Gold)
    $heading = New-Object System.Windows.Forms.Label
    $heading.Text = 'DOI CAU TRA LOI CUA BAN'
    $heading.Location = New-Object System.Drawing.Point(82, 12)
    $heading.Size = New-Object System.Drawing.Size(284, 18)
    $heading.Font = New-Object System.Drawing.Font('Segoe UI', 9.5, [System.Drawing.FontStyle]::Bold)
    $heading.ForeColor = [System.Drawing.Color]::FromArgb(245, 158, 11)
    $heading.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
    $form.Controls.Add($heading)

    # Message Body
    $message = New-Object System.Windows.Forms.Label
    $message.Text = $Body
    $message.Location = New-Object System.Drawing.Point(82, 32)
    $message.Size = New-Object System.Drawing.Size(284, 46)
    $message.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
    $message.ForeColor = [System.Drawing.Color]::FromArgb(244, 244, 245)
    $message.TextAlign = [System.Drawing.ContentAlignment]::TopLeft
    $message.AutoEllipsis = $true
    $form.Controls.Add($message)

    # Hint
    $hint = New-Object System.Windows.Forms.Label
    $hint.Text = 'Bam de mo OMP (tu dong dong khi tra loi)'
    $hint.Location = New-Object System.Drawing.Point(82, 80)
    $hint.Size = New-Object System.Drawing.Size(284, 14)
    $hint.Font = New-Object System.Drawing.Font('Segoe UI', 7.5)
    $hint.ForeColor = [System.Drawing.Color]::FromArgb(161, 161, 170)
    $form.Controls.Add($hint)

    $onClick = {
      try {
        $targetHwnd = Get-OrcaWindowHandle
        if ($targetHwnd -ne [IntPtr]::Zero) {
          [void][AntiFanWin32]::SetForegroundWindow($targetHwnd)
        }
      } catch { }
      $form.Close()
    }

    $form.Add_Click($onClick)
    $picAvatar.Add_Click($onClick)
    $heading.Add_Click($onClick)
    $message.Add_Click($onClick)
    $hint.Add_Click($onClick)

    # Materialize handle before Show
    [void]$form.Handle
    [void][AntiFanWin32]::SuppressActivation($form.Handle)
    $form.Show()

    [void][AntiFanWin32]::ShowWindow($form.Handle, 5)  # SW_SHOW
    [void][AntiFanWin32]::ShowTopMostNoActivate($form.Handle)

    $deadline = (Get-Date).AddMilliseconds([Math]::Max(1000, $LifetimeMs))
    while ($form.Visible -and (Get-Date) -lt $deadline) {
      [System.Windows.Forms.Application]::DoEvents()
      Start-Sleep -Milliseconds 50
    }

    $avatarBmp.Dispose()
    $form.Close()
    $form.Dispose()
  } catch {
    Write-AlertDiagnostic "panel-failed: $($_.Exception.Message) | $($_.InvocationInfo.PositionMessage)"
  }
}

Invoke-AlertSound
Invoke-TaskbarFlash
Show-AlertPanel
