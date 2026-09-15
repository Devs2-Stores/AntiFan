/**
 * Keep the host awake for the duration of an unattended run.
 *
 * Extracted from `scripts/benchmark-real-soak-8h.cjs:41-106` — the same
 * SetThreadExecutionState P/Invoke (ES_CONTINUOUS | ES_SYSTEM_REQUIRED |
 * ES_AWAYMODE_REQUIRED) held by a powershell child that re-asserts it every 30s,
 * because the flag is per-thread and lapses if it is not refreshed. The child
 * auto-respawns on exit so a killed powershell does not silently drop the
 * keep-awake guarantee mid-run.
 *
 * `startKeepAwake()` returns a stop function. On non-Windows hosts there is no
 * SetThreadExecutionState; the stop function is a no-op so callers never branch
 * on platform.
 */
import { spawn } from 'node:child_process';

const KEEP_AWAKE_PS = `
  $code = @'
  using System;
  using System.Runtime.InteropServices;
  public class KeepAwake {
      [DllImport("kernel32.dll", SetLastError = true)]
      public static extern int SetThreadExecutionState(int esFlags);
  }
'@
  Add-Type -TypeDefinition $code
  $ES_CONTINUOUS = [int]0x80000000
  $ES_SYSTEM_REQUIRED = 0x00000001
  $ES_AWAYMODE_REQUIRED = 0x00000040
  $flags = $ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED -bor $ES_AWAYMODE_REQUIRED
  $res = [KeepAwake]::SetThreadExecutionState($flags)
  Write-Output "KEEP_AWAKE_ACTIVE:$res"
  while ($true) {
      Start-Sleep -Seconds 30
      [KeepAwake]::SetThreadExecutionState($flags)
  }
`;

/**
 * Start the keep-awake child. `onEvent` receives `{type:'active'|'respawn'|'error', ...}`
 * so the runner can log without this module owning a logger. Returns `stop()`.
 */
export function startKeepAwake({ respawnDelayMs = 2_000, onEvent } = {}) {
  if (process.platform !== 'win32') {
    return () => {};
  }
  let keepAlive = true;
  let currentProcess = null;
  let respawnTimer = null;

  function launch() {
    if (!keepAlive) return;
    try {
      const p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', KEEP_AWAKE_PS], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      currentProcess = p;
      p.stdout.on('data', (d) => {
        if (d.toString().includes('KEEP_AWAKE_ACTIVE')) {
          onEvent?.({ type: 'active', pid: p.pid });
        }
      });
      p.on('exit', (code) => {
        currentProcess = null;
        if (keepAlive) {
          onEvent?.({ type: 'respawn', code });
          respawnTimer = setTimeout(launch, respawnDelayMs);
          respawnTimer.unref?.();
        }
      });
    } catch (err) {
      onEvent?.({ type: 'error', error: String(err && err.message) });
    }
  }

  launch();

  return function stopKeepAwake() {
    keepAlive = false;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
    }
    if (currentProcess) {
      try {
        currentProcess.kill();
      } catch {}
      currentProcess = null;
    }
  };
}
