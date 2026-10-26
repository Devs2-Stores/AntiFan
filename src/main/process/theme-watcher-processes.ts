import * as cp from 'node:child_process';

/**
 * Which terminals already run a theme watcher, judged by the operating system's own process
 * table rather than by the role the app gave a terminal: a watcher typed by hand into a plain
 * shell pushes to the same remote as one the app minted, and the app cannot see it any other way.
 */

export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The full command line; empty for rows the snapshot did not need to describe. */
  command: string;
}

/** A theme watcher this module recognised, or `unknown` when the command does not name its CLI. */
export type WatcherPlatform = 'haravan' | 'sapo' | 'shopify' | 'unknown';

const WATCHER_COMMAND = /\btheme\s+(?:dev|watch)\b/i;

/**
 * The platform a process command line runs a watcher for, or null when it is not a watcher. The
 * platform comes from the CLI's own install path (`.../haravan-theme-ops-cli/dist/index.js theme
 * dev`, `.../@shopify/cli/...`); a command naming none of them is `unknown`.
 */
export function watcherPlatformOfCommand(command: string): WatcherPlatform | null {
  if (!WATCHER_COMMAND.test(command)) return null;
  if (/haravan|\bhrv\b/i.test(command)) return 'haravan';
  if (/sapo|bizweb/i.test(command)) return 'sapo';
  if (/shopify/i.test(command)) return 'shopify';
  return 'unknown';
}

/** Parses `pid|ppid|command` lines; anything that does not match is dropped, never guessed at. */
export function parseProcessLines(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\|(\d+)\|(.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: (match[3] ?? '').trim() });
  }
  return rows;
}

/**
 * `wmic process get ... /format:csv` prints `Node,CommandLine,ParentProcessId,ProcessId`. A command
 * line may itself contain commas, so the two numeric columns are read from the right and the
 * command is whatever sits between the node name and them. As in the PowerShell script, only a
 * command that could be a watcher keeps its text.
 */
export function parseWmicCsv(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r*\n/)) {
    const match = /^[^,]*,(.*),(\d+),(\d+)\s*$/.exec(line);
    if (!match) continue;
    const command = (match[1] ?? '').trim();
    rows.push({ pid: Number(match[3]), ppid: Number(match[2]), command: WATCHER_COMMAND.test(command) ? command : '' });
  }
  return rows;
}

/**
 * The watchers running anywhere beneath `rootPid` (the shell a terminal spawned), nearest first.
 * A process table can hold a parent cycle after pid reuse, so the walk never revisits a pid.
 */
export function watchersUnder(rows: readonly ProcessRow[], rootPid: number): WatcherPlatform[] {
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings) siblings.push(row);
    else children.set(row.ppid, [row]);
  }
  const found: WatcherPlatform[] = [];
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const pid of frontier) {
      for (const child of children.get(pid) ?? []) {
        if (seen.has(child.pid)) continue;
        seen.add(child.pid);
        const platform = watcherPlatformOfCommand(child.command);
        if (platform) found.push(platform);
        next.push(child.pid);
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Describes only the processes that could be a watcher: every other row keeps its pid and parent
 * (the walk needs the tree) but no command text, which keeps the output small.
 */
const WINDOWS_SNAPSHOT_SCRIPT =
  "Get-CimInstance Win32_Process | ForEach-Object { $c = ''; if ($_.CommandLine -match 'theme\\s+(dev|watch)') { $c = $_.CommandLine -replace '[\\r\\n]+', ' ' }; '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $c }";

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: cp.ChildProcess;
    try {
      child = cp.spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: timeoutMs });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { out += chunk; });
    child.once('error', () => resolve(null));
    child.once('close', (code) => resolve(code === 0 ? out : null));
  });
}

/**
 * One snapshot of the process table, or null when it could not be taken (a missing tool, a
 * timeout). Null is an answer the caller must handle: "nothing is running" is not the same as
 * "could not look". On Windows `wmic` answers in ~2 s (deprecated, absent on the newest builds);
 * PowerShell is the fallback and takes 1-6 s depending on load.
 */
export async function snapshotProcesses(timeoutMs = 15000): Promise<ProcessRow[] | null> {
  let rows: ProcessRow[] = [];
  if (process.platform === 'win32') {
    const wmic = await run('wmic.exe', ['process', 'get', 'ProcessId,ParentProcessId,CommandLine', '/format:csv'], timeoutMs);
    if (wmic !== null) rows = parseWmicCsv(wmic);
    if (rows.length === 0) {
      const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_SNAPSHOT_SCRIPT], timeoutMs);
      if (ps !== null) rows = parseProcessLines(ps);
    }
  } else {
    const ps = await run('ps', ['-eo', 'pid=,ppid=,args='], timeoutMs);
    if (ps !== null) {
      rows = parseProcessLines(
        ps
          .split('\n')
          .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
          .map((m) => (m ? `${m[1]}|${m[2]}|${m[3]}` : ''))
          .join('\n'),
      );
    }
  }
  return rows.length > 0 ? rows : null;
}

let cachedSnapshot: { at: number; rows: ProcessRow[] } | null = null;

/**
 * A snapshot no older than `maxAgeMs`. Several windows restoring together each need the answer, and
 * a watcher typed by hand does not appear within seconds, so one probe serves the whole burst.
 * A failed probe is never cached.
 */
export async function snapshotProcessesCached(maxAgeMs: number, timeoutMs?: number): Promise<ProcessRow[] | null> {
  if (cachedSnapshot && Date.now() - cachedSnapshot.at <= maxAgeMs) return cachedSnapshot.rows;
  const rows = await snapshotProcesses(timeoutMs);
  cachedSnapshot = rows ? { at: Date.now(), rows } : null;
  return rows;
}
