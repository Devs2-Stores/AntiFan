/**
 * Process identity: is this pid still the process a record meant?
 *
 * A bare pid cannot answer that — Windows and POSIX both recycle pids, so a
 * record that stores only `{pid, startedAt}` will happily revive onto an
 * unrelated process. The authoritative predicate is pid **plus** the process
 * start value the OS reports, captured once when the record is written:
 *
 *   live  <=>  pid exists  AND  observed start token === recorded start token
 *   dead  <=>  pid absent  OR   observed start token !== recorded start token
 *
 * Both sides of that comparison must come from the same adapter, so the token
 * carries the format that produced it (`win32:CreationDate`,
 * `procfs:starttime:<clk_tck>:<btime>`, `ps:lstart`). A record written by a
 * different adapter, or a host where no adapter works, is UNVERIFIABLE, and an
 * unverifiable holder is treated as live: refusing is the safe direction, since
 * reclaiming a live holder's lock corrupts the run it protects.
 *
 * Raw OS value is preserved next to the derived ISO timestamp so the equality
 * test never depends on re-parsing a locale-formatted date.
 */
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FORMAT_WIN32 = 'win32:CreationDate';
export const FORMAT_PROCPS = 'procfs:starttime';
export const FORMAT_PS = 'ps:lstart';
export const FORMAT_UNAVAILABLE = 'unavailable';

/** Existence only — never sufficient on its own to claim a specific process. */
function pidExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return err && err.code === 'EPERM';
  }
}

async function readWin32Identity(pid) {
  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `
    + `if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') } else { '' }`;
  const { stdout } = await execFileAsync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024 }
  );
  const raw = String(stdout || '').trim();
  if (!raw) return { alive: pidExists(pid), startToken: null, startTokenFormat: FORMAT_UNAVAILABLE, startedAt: null };
  const parsed = Date.parse(raw);
  return {
    alive: true,
    startToken: raw,
    startTokenFormat: FORMAT_WIN32,
    startedAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
  };
}

function procfsClockTicks() {
  try {
    const raw = fs.readFileSync('/proc/stat', 'utf8');
    const btimeMatch = raw.match(/^btime\s+(\d+)/m);
    const btime = btimeMatch ? Number(btimeMatch[1]) : null;
    let hz = 100;
    try {
      const stdout = execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' });
      const parsed = Number(String(stdout).trim());
      if (Number.isFinite(parsed) && parsed > 0) hz = parsed;
    } catch {}
    return { btime, hz };
  } catch {
    return { btime: null, hz: 100 };
  }
}

function readProcfsIdentity(pid) {
  let stat;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return null;
  }
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  const starttime = fields[19]; // field 22 of /proc/<pid>/stat (1-based, comm excluded)
  if (!starttime) return null;
  const { btime, hz } = procfsClockTicks();
  const startToken = `${starttime}`;
  const startedAt = btime === null ? null : new Date((btime + Number(starttime) / hz) * 1000).toISOString();
  return {
    alive: true,
    startToken,
    startTokenFormat: `${FORMAT_PROCPS}:${hz}:${btime ?? 'unknown'}`,
    startedAt,
  };
}

async function readPsIdentity(pid) {
  try {
    const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 8000, maxBuffer: 64 * 1024 });
    const raw = String(stdout || '').trim();
    if (!raw) return { alive: pidExists(pid), startToken: null, startTokenFormat: FORMAT_UNAVAILABLE, startedAt: null };
    const parsed = Date.parse(raw);
    return {
      alive: true,
      startToken: raw,
      startTokenFormat: FORMAT_PS,
      startedAt: Number.isNaN(parsed) ? null : new Date(parsed).toISOString(),
    };
  } catch {
    return { alive: pidExists(pid), startToken: null, startTokenFormat: FORMAT_UNAVAILABLE, startedAt: null };
  }
}

/**
 * Observe a pid through the platform adapter. `startToken === null` means the
 * process exists (or does not) but its start value could not be read.
 */
export async function readProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { pid, alive: false, startToken: null, startTokenFormat: FORMAT_UNAVAILABLE, startedAt: null };
  }
  if (process.platform === 'win32') {
    let observed;
    try {
      observed = await readWin32Identity(pid);
    } catch {
      observed = { alive: pidExists(pid), startToken: null, startTokenFormat: FORMAT_UNAVAILABLE, startedAt: null };
    }
    return { pid, ...observed };
  }
  const procfs = readProcfsIdentity(pid);
  if (procfs) return { pid, ...procfs };
  return { pid, ...(await readPsIdentity(pid)) };
}

/** The token pair a writer stores, taken from one read so both fields agree. */
export async function captureProcessIdentity(pid) {
  const observed = await readProcessIdentity(pid);
  return {
    pid: observed.pid,
    startedAt: observed.startedAt,
    processStartToken: observed.startToken,
    processStartTokenFormat: observed.startTokenFormat,
  };
}

/**
 * Decide whether a recorded holder is dead. Only `dead: true` may authorise a
 * reclaim; every other outcome keeps the record authoritative.
 */
export async function proveHolderDead(record) {
  const pid = Number(record?.pid ?? record?.instancePid ?? record?.supervisorPid);
  const token = record?.processStartToken ?? record?.instanceProcessStartToken ?? null;
  const format = record?.processStartTokenFormat ?? null;
  if (!Number.isInteger(pid) || pid <= 0) {
    return { dead: true, reason: 'PID_INVALID', observed: null };
  }
  const observed = await readProcessIdentity(pid);
  if (!observed.alive) {
    return { dead: true, reason: 'PID_ABSENT', observed };
  }
  if (!token || !observed.startToken) {
    return { dead: false, reason: 'UNVERIFIABLE', observed };
  }
  if (format && observed.startTokenFormat !== format && observed.startTokenFormat !== FORMAT_UNAVAILABLE) {
    return { dead: false, reason: 'FORMAT_MISMATCH', observed, recordedFormat: format };
  }
  if (observed.startToken !== token) {
    return { dead: true, reason: 'START_TOKEN_MISMATCH', observed, recordedToken: token };
  }
  return { dead: false, reason: 'ALIVE', observed };
}

/** True when a record names exactly the process now running as `pid`. */
export async function namesLiveProcess(record) {
  const verdict = await proveHolderDead(record);
  return verdict.dead === false && verdict.reason === 'ALIVE';
}

/**
 * Which pid owns the listening socket on `port`. Used as corroboration only:
 * port ownership proves *a* process serves that port, never that it is the
 * recorded one — the start token does that.
 */
export async function findPortOwnerPid(port) {
  const wanted = Number(port);
  if (!Number.isInteger(wanted) || wanted <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'tcp'], { timeout: 10000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!/LISTENING/i.test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const local = cols[1] || '';
        if (!local.endsWith(`:${wanted}`)) continue;
        const pid = Number(cols[cols.length - 1]);
        if (Number.isInteger(pid)) return pid;
      }
      return null;
    }
    try {
      const { stdout } = await execFileAsync('lsof', ['-nP', `-iTCP:${wanted}`, '-sTCP:LISTEN', '-t'], { timeout: 10000 });
      const pid = Number(String(stdout).trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    } catch {}
    const { stdout } = await execFileAsync('ss', ['-ltnp'], { timeout: 10000 });
    for (const line of String(stdout).split(/\n/)) {
      if (!line.includes(`:${wanted}`)) continue;
      const match = line.match(/pid=(\d+)/);
      if (match) return Number(match[1]);
    }
    return null;
  } catch {
    return null;
  }
}
