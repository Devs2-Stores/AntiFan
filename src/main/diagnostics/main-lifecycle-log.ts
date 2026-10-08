/**
 * AntiFan Browser Desktop — Main-Process Lifecycle Journal
 *
 * Why this file exists
 * --------------------
 * The main process keeps no durable record of its own life. `src/main/index.ts`
 * reports every fatal signal (`uncaughtException`, `unhandledRejection`,
 * `render-process-gone`, `child-process-gone`) through `console.*`, and a launch
 * from Explorer or a shortcut has no attached console, so those lines are
 * discarded. When the process disappears, nothing on disk says which path exited,
 * when, or with which code — `.antifan-data/runtime/logs/` held only the
 * native-messaging journal.
 *
 * The consequence is measurable, not theoretical: an in-flight invocation frame
 * was left un-terminalized, and the next boot's replay could only invent a cause
 * for it (`EXECUTION_UNKNOWN: ...due to process termination after dispatch
 * started` — `session/invocation-ledger.ts:193-210`). The app narrated a death it
 * never witnessed. This journal gives the exit an author.
 *
 * Design constraints
 * ------------------
 *  - SYNCHRONOUS appends. The most valuable line is the one written in the few
 *    milliseconds before `process.exit()`, where an async append would still be
 *    queued and lost. The native-messaging journal (`native-messaging/host-runner.ts`)
 *    uses async appends because it must never block a handshake; a lifecycle
 *    journal has the opposite priority.
 *  - Never fatal. A diagnostic write that throws would itself end the process.
 *  - Same sink and rotation idiom as the native-host journal: `<runtime>/logs`,
 *    2 MB, rename to `.1`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { StorageLocations } from '../config/storage-locations';

export const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB, matching the native-host journal
const LOG_FILENAME = 'main.log';

export interface LifecycleRecord {
  /** ISO-8601 instant, for humans reading the file. */
  iso: string;
  /** Absolute epoch milliseconds — the field the NEXT boot correlates against. */
  ts: number;
  pid: number;
  uptimeMs: number;
  event: string;
  [key: string]: unknown;
}

export interface ExitInterceptable {
  exit: (code?: number) => void;
  quit: () => void;
  relaunch?: (options?: { args?: string[]; execPath?: string }) => void;
}

let logFile: string | null = null;
let logFileOld: string | null = null;
let currentBytes = 0;
let initialized = false;
let interceptorInstalled = false;

function initLogFile(): void {
  if (initialized) return;
  initialized = true;
  try {
    const runtimeDir = process.env.ANTIFAN_RUNTIME_DIR || StorageLocations.getRuntimeDir();
    const logDir = path.join(runtimeDir, 'logs');
    if (!fs.existsSync(logDir)) {
      try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
    }
    logFile = path.join(logDir, LOG_FILENAME);
    logFileOld = path.join(logDir, `${LOG_FILENAME}.1`);
    if (fs.existsSync(logFile)) currentBytes = fs.statSync(logFile).size;
  } catch {
    logFile = null;
    logFileOld = null;
  }
}

function getMaxLogBytes(): number {
  const envVal = process.env.ANTIFAN_LIFECYCLE_LOG_MAX_BYTES;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return MAX_LOG_BYTES;
}

function rotateLogFiles(): void {
  if (!logFile || !logFileOld) return;
  try {
    if (fs.existsSync(logFileOld)) {
      try { fs.unlinkSync(logFileOld); } catch {}
    }
    if (fs.existsSync(logFile)) {
      fs.renameSync(logFile, logFileOld);
    }
    currentBytes = 0;
  } catch {
    try {
      if (fs.existsSync(logFile)) {
        currentBytes = fs.statSync(logFile).size;
      }
    } catch {}
  }
}

interface LogChunk {
  rotateBefore: boolean;
  content: string;
  bytes: number;
}

function partitionLines(lines: string[], startingBytes: number, maxBytes: number): LogChunk[] {
  const chunks: LogChunk[] = [];
  let activeLines: string[] = [];
  let activeBytes = 0;
  let simBytes = startingBytes;
  let activeRotateBefore = false;

  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8');
    if (simBytes + lineBytes > maxBytes && simBytes > 0) {
      if (activeLines.length > 0) {
        chunks.push({
          rotateBefore: activeRotateBefore,
          content: activeLines.join(''),
          bytes: activeBytes,
        });
        activeLines = [];
        activeBytes = 0;
      }
      activeRotateBefore = true;
      activeLines.push(line);
      activeBytes = lineBytes;
      simBytes = lineBytes;
    } else {
      activeLines.push(line);
      activeBytes += lineBytes;
      simBytes += lineBytes;
    }
  }

  if (activeLines.length > 0) {
    chunks.push({
      rotateBefore: activeRotateBefore,
      content: activeLines.join(''),
      bytes: activeBytes,
    });
  }

  return chunks;
}

function writeLinesSync(lines: string[]): void {
  if (!logFile || lines.length === 0) return;
  const maxBytes = getMaxLogBytes();
  const chunks = partitionLines(lines, currentBytes, maxBytes);
  for (const chunk of chunks) {
    if (chunk.rotateBefore) {
      rotateLogFiles();
    }
    fs.appendFileSync(logFile, chunk.content, 'utf8');
    currentBytes += chunk.bytes;
  }
}

async function writeLinesAsync(lines: string[]): Promise<void> {
  if (!logFile || lines.length === 0) return;
  const maxBytes = getMaxLogBytes();
  const chunks = partitionLines(lines, currentBytes, maxBytes);
  for (const chunk of chunks) {
    if (chunk.rotateBefore) {
      rotateLogFiles();
    }
    await fs.promises.appendFile(logFile, chunk.content, 'utf8');
    currentBytes += chunk.bytes;
  }
}

/**
 * Pure formatter: one journal line per lifecycle event. Exported so the contract
 * (absolute epoch ms + pid + event) is unit-testable without Electron or disk.
 */
export function formatLifecycleRecord(
  event: string,
  fields: Record<string, unknown> | undefined,
  now: number,
  pid: number,
  uptimeMs: number
): LifecycleRecord {
  return {
    iso: new Date(now).toISOString(),
    ts: now,
    pid,
    uptimeMs,
    event,
    ...(fields || {}),
  };
}

/** Lines accepted but not yet handed to the filesystem, in arrival order. */
let pendingLines: string[] = [];
let drainScheduled = false;
let drainChain: Promise<void> = Promise.resolve();

/**
 * Format one event into a newline-delimited JSON string. Byte accounting and rotation
 * are handled during serialized draining (or synchronous flush) so no rename overlaps
 * an in-flight append.
 */
function admitLine(event: string, fields: Record<string, unknown> | undefined): string | null {
  initLogFile();
  if (!logFile) return null;
  const record = formatLifecycleRecord(event, fields, Date.now(), process.pid, Math.round(process.uptime() * 1000));
  return `${JSON.stringify(record)}\n`;
}

/** Hand every queued line to disk on the main thread. Used only on exit paths. */
function flushPendingSync(): void {
  if (!logFile || pendingLines.length === 0) return;
  const lines = pendingLines;
  pendingLines = [];
  writeLinesSync(lines);
}

/** Move the queue into serialized appends on the FIFO chain. */
function drainAsync(): Promise<void> {
  const target = logFile;
  if (!target || pendingLines.length === 0) return drainChain;
  const lines = pendingLines;
  pendingLines = [];
  drainChain = drainChain
    .then(() => writeLinesAsync(lines))
    .catch(() => {
      // A diagnostic write must never break the app.
    });
  return drainChain;
}

function scheduleDrain(): void {
  if (drainScheduled) return;
  drainScheduled = true;
  // Coalesce every line admitted in this tick into one append; the chain keeps
  // batches strictly FIFO even when a drain is still in flight.
  setImmediate(() => {
    drainScheduled = false;
    drainAsync();
  }).unref?.();
}

/**
 * Append one lifecycle event to `<runtime>/logs/main.log`. Bounded and swallowed
 * on failure: recording must never be the reason the app dies.
 *
 * Runtime events (including the 5-second heartbeat) are queued and written off
 * the main thread in arrival order. `sync: true` is for exit paths only: it
 * flushes the queue and the event itself with blocking writes, because nothing
 * asynchronous is guaranteed to run once the process is on its way out. A batch
 * already in flight on the thread pool may land after a sync write or not at
 * all; every record carries its own `ts`, so readers order by that, not by line.
 */
export function recordLifecycleEvent(event: string, fields?: Record<string, unknown>, options?: { sync?: boolean }): void {
  try {
    const line = admitLine(event, fields);
    if (line === null || !logFile) return;
    pendingLines.push(line);
    if (options?.sync) {
      flushPendingSync();
      return;
    }
    scheduleDrain();
  } catch {
    // A diagnostic write must never break the app.
  }
}

/** Settles once every line admitted so far has been handed to the filesystem. */
export function lifecycleLogDrained(): Promise<void> {
  return drainAsync();
}

/**
 * Wrap the exit paths once, at bootstrap, so that EVERY exit announces itself with
 * its call site. Hand-editing each `app.exit(...)` site would leave the next one
 * added unlogged; one interceptor covers them all, including `app.exit`, which
 * fires no `before-quit`/`will-quit` event and is therefore invisible to every
 * lifecycle listener in `index.ts`.
 */
export function installExitInterceptor(target: ExitInterceptable, proc: { exit: (code?: number) => void }): void {
  if (interceptorInstalled) return;
  interceptorInstalled = true;

  const stackOf = (): string => {
    const stack = new Error().stack || '';
    // Drop this frame and the wrapper frame; keep the caller for attribution.
    return stack.split('\n').slice(2, 6).map((l) => l.trim()).join(' <- ');
  };

  const originalExit = target.exit.bind(target);
  target.exit = (code?: number) => {
    recordLifecycleEvent('app.exit', { code: code ?? 0, stack: stackOf() }, { sync: true });
    return originalExit(code);
  };

  const originalQuit = target.quit.bind(target);
  target.quit = () => {
    recordLifecycleEvent('app.quit', { stack: stackOf() }, { sync: true });
    return originalQuit();
  };

  if (typeof target.relaunch === 'function') {
    const originalRelaunch = target.relaunch.bind(target);
    target.relaunch = (options?: { args?: string[]; execPath?: string }) => {
      recordLifecycleEvent('app.relaunch', { stack: stackOf() }, { sync: true });
      return originalRelaunch(options);
    };
  }

  const originalProcessExit = proc.exit.bind(proc);
  proc.exit = (code?: number) => {
    recordLifecycleEvent('process.exit', { code: code ?? 0, stack: stackOf() }, { sync: true });
    return originalProcessExit(code);
  };
}

/**
 * The last writer available to a dying process: Node runs `exit` handlers
 * synchronously on the way out, including after an explicit `process.exit(code)`.
 */
export function installExitRecorder(proc: { on: (event: 'exit', listener: (code: number) => void) => unknown }): void {
  try {
    proc.on('exit', (code: number) => {
      recordLifecycleEvent('process.exit.event', { code }, { sync: true });
    });
  } catch {}
}

export type ShutdownStepOutcome = 'done' | 'failed' | 'timeout';

/**
 * Run one named teardown step with a bounded wait, journaling its outcome.
 *
 * The committed shutdown is awaited by a quit before `app.quit()` — and by the shutdown
 * path generally — so a step that never settles (a native flush that hangs) would mean the
 * application never quits at all and the user has to kill the process. The journal already
 * names every step, so this adds the one thing it was missing: a deadline. A step that
 * exceeds it is recorded as `timeout` and skipped, the remaining steps still run, and the
 * quit completes. Cleanup failure is never reported as success — the reason is in the
 * journal for the next boot to read, exactly as a step failure is.
 *
 * The step's own rejection is journaled as `failed` here (with its message) and returned
 * rather than rethrown: a teardown sequence runs every step and reports outcomes, it does
 * not abort on the first one. The timer is unref'd, so it can never be the reason the
 * process stays alive.
 */
export async function runBoundedShutdownStep(
  name: string,
  deadlineMs: number,
  run: () => unknown,
  journal: (event: string, fields?: Record<string, unknown>) => void
): Promise<ShutdownStepOutcome> {
  journal('shutdown.step.begin', { step: name });
  let timer: NodeJS.Timeout | null = null;
  const expired = new Promise<'timeout'>((resolve) => {
    const handle = setTimeout(() => resolve('timeout'), Math.max(1, deadlineMs));
    handle.unref?.();
    timer = handle;
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve()
        .then(run)
        .then(
          () => 'done' as const,
          (error: unknown) => {
            journal('shutdown.step.failed', { step: name, detail: String(error) });
            return 'failed' as const;
          }
        ),
      expired,
    ]);
    if (outcome === 'timeout') {
      journal('shutdown.step.timeout', { step: name, deadlineMs });
    } else if (outcome === 'done') {
      journal('shutdown.step.done', { step: name });
    }
    return outcome;
  } finally {
    clearTimeout(timer ?? undefined);
  }
}

/** Absolute path of the journal, for boot records and diagnostics. */
export function getLifecycleLogPath(): string | null {
  initLogFile();
  return logFile;
}
