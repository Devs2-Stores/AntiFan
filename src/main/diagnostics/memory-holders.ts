import * as cp from 'node:child_process';

/**
 * Which terminals hold the most memory, for the commit-pressure warning. Asking the user to "close
 * some agents" names no one; with a dozen agent terminals open, the one worth closing is the one
 * whose process tree (shell, `omp.exe`, the jobs it started) owns the most private memory - the
 * charge Windows counts against its commit limit.
 */

export interface MemoryProcessRow {
  pid: number;
  ppid: number;
  name: string;
  /** Private bytes (Win32_Process.PrivatePageCount, in bytes): what the process charges to commit. */
  privateBytes: number;
}

/** A running terminal as the ranking sees it: the shell its tree starts from. */
export interface TerminalRoot {
  id: string;
  name: string;
  shellPid: number;
}

export interface TerminalMemoryHolder {
  id: string;
  name: string;
  privateBytes: number;
  /** `omp.exe` processes in the tree: an agent session and any agent it started in its shell. */
  agents: number;
  processes: number;
}

/**
 * The terminals whose process trees hold the most private memory, largest first. A process table
 * can hold a parent cycle after pid reuse, so a walk never revisits a pid, and a pid already
 * credited to one terminal is never credited to another.
 */
export function rankTerminalHolders(
  rows: readonly MemoryProcessRow[],
  terminals: readonly TerminalRoot[],
  limit: number,
): TerminalMemoryHolder[] {
  const byPid = new Map<number, MemoryProcessRow>();
  const children = new Map<number, MemoryProcessRow[]>();
  for (const row of rows) {
    byPid.set(row.pid, row);
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const credited = new Set<number>();
  const holders: TerminalMemoryHolder[] = [];
  for (const terminal of terminals) {
    const root = byPid.get(terminal.shellPid);
    if (!root || credited.has(root.pid)) continue;
    const holder: TerminalMemoryHolder = { id: terminal.id, name: terminal.name, privateBytes: 0, agents: 0, processes: 0 };
    let frontier = [root];
    credited.add(root.pid);
    while (frontier.length > 0) {
      const next: MemoryProcessRow[] = [];
      for (const row of frontier) {
        holder.privateBytes += row.privateBytes;
        holder.processes += 1;
        if (row.name.toLowerCase() === 'omp.exe') holder.agents += 1;
        for (const child of children.get(row.pid) ?? []) {
          if (credited.has(child.pid)) continue;
          credited.add(child.pid);
          next.push(child);
        }
      }
      frontier = next;
    }
    holders.push(holder);
  }
  return holders.sort((a, b) => b.privateBytes - a.privateBytes).slice(0, Math.max(0, limit));
}

/**
 * `wmic process get Name,ParentProcessId,PrivatePageCount,ProcessId /format:csv` prints
 * `Node,Name,ParentProcessId,PrivatePageCount,ProcessId`. The three numbers are read from the right
 * so a comma inside a name cannot shift them.
 */
export function parseMemoryWmicCsv(output: string): MemoryProcessRow[] {
  const rows: MemoryProcessRow[] = [];
  for (const line of output.split(/\r*\n/)) {
    const match = /^[^,]*,(.*),(\d+),(\d+),(\d+)\s*$/.exec(line);
    if (!match) continue;
    rows.push({ name: (match[1] ?? '').trim(), ppid: Number(match[2]), privateBytes: Number(match[3]), pid: Number(match[4]) });
  }
  return rows;
}

/** `pid|ppid|privateBytes|name` lines from the PowerShell fallback; anything else is dropped. */
export function parseMemoryProcessLines(output: string): MemoryProcessRow[] {
  const rows: MemoryProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\|(\d+)\|(\d+)\|(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), privateBytes: Number(match[3]), name: (match[4] ?? '').trim() });
  }
  return rows;
}

const POWERSHELL_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.PrivatePageCount, $_.Name }";

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  let child: cp.ChildProcess;
  try {
    child = cp.spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
  } catch {
    resolve(null);
    return promise;
  }
  let out = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { out += chunk; });
  child.once('error', () => resolve(null));
  child.once('close', (code) => resolve(code === 0 ? out : null));
  return promise;
}

/**
 * The process table with private bytes, or null when it could not be read. Windows only: this
 * feeds the commit warning, which exists only there. `wmic` answers in ~2 s; PowerShell is the
 * fallback where `wmic` is gone.
 */
export async function snapshotProcessMemory(timeoutMs = 20_000): Promise<MemoryProcessRow[] | null> {
  if (process.platform !== 'win32') return null;
  let rows: MemoryProcessRow[] = [];
  const wmic = await run('wmic.exe', ['process', 'get', 'Name,ParentProcessId,PrivatePageCount,ProcessId', '/format:csv'], timeoutMs);
  if (wmic !== null) rows = parseMemoryWmicCsv(wmic);
  if (rows.length === 0) {
    const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], timeoutMs);
    if (ps !== null) rows = parseMemoryProcessLines(ps);
  }
  return rows.length > 0 ? rows : null;
}
