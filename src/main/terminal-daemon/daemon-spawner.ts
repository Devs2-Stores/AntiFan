/**
 * Terminal Host spawner — owns the L1→L2→L3 start/survive chain and re-attach.
 *
 * The daemon is a detached headless Electron process (run as Node via ELECTRON_RUN_AS_NODE=1) that
 * owns every PTY, so a GUI restart cannot kill live terminal sessions. This module decides HOW the
 * host comes up and whether it can outlive the GUI at all:
 *
 *   L0  re-attach — a host is already running and healthy; reuse it (the common restart path).
 *   L1  spawn(execPath, [entry], {detached:true, stdio:'ignore'}) + unref() — fast path, used only
 *       when the GUI is not inside a job object.
 *   L2  WMI Win32_Process.Create — the created process is parented to wmiprvse.exe, outside the
 *       GUI's job, so it survives even when JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE is set. This is the
 *       only mechanism here that actually escapes a job; `powershell Start-Process` does NOT (the
 *       child still inherits the caller's job), so it is deliberately not used.
 *   L3  STRICT_JOB_OBJECT_ENFORCED — the GUI is in a kill-on-close job AND the WMI escape failed.
 *       Nothing the GUI spawns can outlive it, so the caller degrades to in-process PTYs (today's
 *       working behaviour) instead of pretending.
 *
 * Job membership is detected, not inferred from spawn failure: an L1 child can report healthy yet
 * still be job-bound, which only shows up when the GUI exits — too late. IsProcessInJob is queried
 * up front so the chain picks the surviving mechanism on the first try.
 */
import { spawn, execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import WebSocket from 'ws';

const HOST = '127.0.0.1';
const HANDSHAKE_TIMEOUT_MS = 15000;
const HEALTH_TIMEOUT_MS = 5000;
const POLL_MS = 250;

export type SpawnMode = 'attached' | 'detached' | 'wmi' | 'in-process';

export interface DaemonHandle {
  mode: Exclude<SpawnMode, 'in-process'>;
  pid: number;
  port: number;
  token: string;
  version: string;
}

export interface DaemonSpawnResult {
  mode: SpawnMode;
  handle?: DaemonHandle;
  /** Set when mode === 'in-process': why no daemon could be started/attached. */
  reason?: string;
}

interface StagedPointer {
  version: string;
  dir: string;
  entry: string;
}

interface LiveRecord {
  pid: number;
  port: number;
  token: string;
  version: string;
  handshakePath: string;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function dataRoot(): string {
  return process.env.ANTIFAN_DATA_ROOT || path.join(process.env.LOCALAPPDATA || process.cwd(), 'antifan-data');
}

function hostRoot(): string {
  return path.join(dataRoot(), 'daemon-host');
}

function liveRecordPath(): string {
  return path.join(hostRoot(), 'daemon.json');
}

/** Read the staged-version pointer published by stage-daemon-host.mjs. */
export function resolveStagedEntry(): StagedPointer | null {
  const pointerPath = path.join(hostRoot(), 'current.json');
  try {
    const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8')) as StagedPointer;
    if (!pointer.entry || !fs.existsSync(pointer.entry)) return null;
    return pointer;
  } catch {
    return null;
  }
}

function readLiveRecord(): LiveRecord | null {
  try {
    const rec = JSON.parse(fs.readFileSync(liveRecordPath(), 'utf8')) as LiveRecord;
    if (!rec.pid || !rec.port || !rec.token) return null;
    return rec;
  } catch {
    return null;
  }
}

function writeLiveRecord(rec: LiveRecord): void {
  const file = liveRecordPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2));
  fs.renameSync(tmp, file);
}

function clearLiveRecord(): void {
  try { fs.rmSync(liveRecordPath(), { force: true }); } catch { /* best effort */ }
}

/**
 * Is the GUI process inside a job object? When it is, a plain detached child inherits that job and
 * dies with the GUI under KILL_ON_JOB_CLOSE — so L1 is skipped and the chain goes straight to the
 * WMI escape. Returns 'in-job' | 'free' | 'unknown' (unknown is treated as free: L1 is tried, and
 * the post-spawn survival check still catches a hidden job).
 */
function detectJobMembership(): 'in-job' | 'free' | 'unknown' {
  if (process.platform !== 'win32') return 'free';
  const script = [
    '$sig = "[DllImport(\\"kernel32.dll\\")] public static extern bool IsProcessInJob(System.IntPtr h, System.IntPtr j, out bool r);"',
    '$t = Add-Type -MemberDefinition $sig -Name J -Namespace W -PassThru',
    '$r = $false',
    '$null = $t::IsProcessInJob((Get-Process -Id ' + process.pid + ').Handle, [System.IntPtr]::Zero, [ref]$r)',
    'if ($r) { "in-job" } else { "free" }',
  ].join('; ');
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'in-job' ? 'in-job' : out === 'free' ? 'free' : 'unknown';
  } catch {
    return 'unknown';
  }
}

function daemonEnv(token: string, version: string, extra: Record<string, string>): Record<string, string> {
  return {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    ANTIFAN_TERMINAL_HOST_TOKEN: token,
    ANTIFAN_TERMINAL_HOST_VERSION: version,
    ...extra,
  } as Record<string, string>;
}

/** L1: detached spawn. The child still inherits the GUI's job (if any) — only used when free. */
function spawnDetached(entry: string, handshake: string, logFile: string, cwd: string, env: Record<string, string>): number {
  // The host token is kept out of the child's environment block: any same-user process can read
  // that block, and this path owns the child's stdin, so the token travels over the pipe instead.
  // L2 has no pipe and keeps the env var.
  const { ANTIFAN_TERMINAL_HOST_TOKEN: token, ...childEnv } = env;
  const child = spawn(process.execPath, [entry, '--handshake', handshake, '--log', logFile, '--cwd', cwd, '--port', '0'], {
    cwd,
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    env: childEnv,
  });
  if (child.stdin) {
    child.stdin.write(`${token}\n`);
    child.stdin.end();
  }
  child.unref();
  return child.pid ?? 0;
}

/**
 * L2: WMI Win32_Process.Create. The new process is parented to the WMI provider host, outside the
 * GUI's job object, so it survives KILL_ON_JOB_CLOSE. WMI passes only a command line (no env block),
 * so the daemon's env vars are set through a `cmd /c` wrapper; the token on that command line is
 * visible to same-user processes, which is the same exposure as the user-private state file.
 */
function spawnViaWmi(entry: string, handshake: string, logFile: string, cwd: string, env: Record<string, string>): number {
  const sets = [
    `ELECTRON_RUN_AS_NODE=${env.ELECTRON_RUN_AS_NODE}`,
    `ANTIFAN_TERMINAL_HOST_TOKEN=${env.ANTIFAN_TERMINAL_HOST_TOKEN}`,
    `ANTIFAN_TERMINAL_HOST_VERSION=${env.ANTIFAN_TERMINAL_HOST_VERSION}`,
    `ANTIFAN_DATA_ROOT=${env.ANTIFAN_DATA_ROOT || dataRoot()}`,
  ].map((kv) => `set "${kv}"`).join('&& ');
  const cmdLine = `cmd.exe /c "${sets}&& ""${process.execPath}"" ""${entry}"" --handshake ""${handshake}"" --log ""${logFile}"" --cwd ""${cwd}"" --port 0"`;
  const ps = [
    `$p = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine.replace(/'/g, "''")}' ; CurrentDirectory = '${cwd.replace(/'/g, "''")}' }`,
    'if ($p.ReturnValue -eq 0) { $p.ProcessId } else { "ERR:$($p.ReturnValue)" }',
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const pid = Number(out);
  return Number.isFinite(pid) && pid > 0 ? pid : 0;
}

/** Wait for the host to publish its handshake file (pid + port + token). */
async function waitForHandshake(handshakePath: string, spawnedPid: number): Promise<LiveRecord | null> {
  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(handshakePath)) {
      try {
        const info = JSON.parse(fs.readFileSync(handshakePath, 'utf8')) as LiveRecord;
        if (info.pid && info.port && info.token) return { ...info, handshakePath };
      } catch { /* partial write; keep polling */ }
    }
    if (spawnedPid && !alive(spawnedPid)) return null;
    await delay(POLL_MS);
  }
  return null;
}

/** Health probe: connect with the token and answer terminalHostPing. */
async function probeHealth(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean, ws?: WebSocket) => {
      if (settled) return;
      settled = true;
      try { ws?.close(); } catch { /* ignore */ }
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), HEALTH_TIMEOUT_MS);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${HOST}:${port}/`, { headers: { 'x-antifan-token': token } });
    } catch {
      clearTimeout(timer);
      return done(false);
    }
    const finish = (ok: boolean) => { clearTimeout(timer); done(ok, ws); };
    ws.once('open', () => {
      const id = 'health-1';
      const onMsg = (raw: WebSocket.RawData) => {
        try {
          const frame = JSON.parse(String(raw));
          if (frame.id === id) { ws.off('message', onMsg); finish(Boolean(frame.success)); }
        } catch { /* ignore */ }
      };
      ws.on('message', onMsg);
      ws.send(JSON.stringify({ id, method: 'terminalHostPing', params: {} }));
    });
    ws.once('error', () => finish(false));
    ws.once('unexpected-response', () => finish(false));
  });
}

/**
 * Bring up (or re-attach to) the terminal host.
 *
 * Order: re-attach → pick L1 or L2 by job membership → L3 degrade. A second spawn mechanism is only
 * attempted when the first fails to produce a healthy host, not merely when it was the "wrong" kind.
 */
export async function ensureDaemon(opts: { cwd?: string } = {}): Promise<DaemonSpawnResult> {
  const cwd = opts.cwd || process.cwd();

  /* ---- L0: re-attach to a live host ---- */
  const existing = readLiveRecord();
  if (existing && alive(existing.pid) && (await probeHealth(existing.port, existing.token))) {
    return { mode: 'attached', handle: { mode: 'attached', pid: existing.pid, port: existing.port, token: existing.token, version: existing.version } };
  }
  if (existing) clearLiveRecord(); // stale record from a dead host

  const staged = resolveStagedEntry();
  if (!staged) {
    return { mode: 'in-process', reason: 'no staged daemon bundle (run scripts/stage-daemon-host.mjs)' };
  }

  const job = detectJobMembership();
  const token = crypto.randomBytes(24).toString('hex');
  const handshakePath = path.join(hostRoot(), 'daemon-handshake.json');
  const logFile = path.join(hostRoot(), 'daemon.log');
  fs.mkdirSync(hostRoot(), { recursive: true });
  try { fs.rmSync(handshakePath, { force: true }); } catch { /* stale handshake */ }

  const env = daemonEnv(token, staged.version, { ANTIFAN_DATA_ROOT: dataRoot() });

  // In a job, L1's child inherits it and dies with the GUI — go straight to the WMI escape.
  const mechanisms: Array<{ mode: 'detached' | 'wmi'; run: () => number }> =
    job === 'in-job'
      ? [{ mode: 'wmi', run: () => spawnViaWmi(staged.entry, handshakePath, logFile, cwd, env) }]
      : [
          { mode: 'detached', run: () => spawnDetached(staged.entry, handshakePath, logFile, cwd, env) },
          { mode: 'wmi', run: () => spawnViaWmi(staged.entry, handshakePath, logFile, cwd, env) },
        ];

  for (const mech of mechanisms) {
    let spawnedPid = 0;
    try {
      spawnedPid = mech.run();
    } catch {
      spawnedPid = 0;
    }
    if (!spawnedPid) continue;

    const rec = await waitForHandshake(handshakePath, spawnedPid);
    if (!rec) continue; // host died or never published; try next mechanism
    if (!(await probeHealth(rec.port, rec.token))) continue;

    writeLiveRecord({ pid: rec.pid, port: rec.port, token: rec.token, version: rec.version, handshakePath });
    return { mode: mech.mode, handle: { mode: mech.mode, pid: rec.pid, port: rec.port, token: rec.token, version: rec.version } };
  }

  return {
    mode: 'in-process',
    reason:
      job === 'in-job'
        ? 'STRICT_JOB_OBJECT_ENFORCED: GUI is in a kill-on-close job and the WMI escape failed; degrading to in-process PTYs'
        : 'daemon failed to start via detached spawn and WMI; degrading to in-process PTYs',
  };
}
