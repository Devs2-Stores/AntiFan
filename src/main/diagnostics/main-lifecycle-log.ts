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

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB, matching the native-host journal
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

function rotateIfNeeded(addedBytes: number): void {
  if (!logFile || !logFileOld) return;
  if (currentBytes + addedBytes <= MAX_LOG_BYTES) return;
  try {
    if (fs.existsSync(logFileOld)) {
      try { fs.unlinkSync(logFileOld); } catch {}
    }
    if (fs.existsSync(logFile)) fs.renameSync(logFile, logFileOld);
    currentBytes = 0;
  } catch {
    currentBytes = 0;
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

/**
 * Append one lifecycle event to `<runtime>/logs/main.log`. Synchronous, bounded,
 * and swallowed on failure: recording must never be the reason the app dies.
 */
export function recordLifecycleEvent(event: string, fields?: Record<string, unknown>): void {
  try {
    initLogFile();
    if (!logFile) return;
    const record = formatLifecycleRecord(event, fields, Date.now(), process.pid, Math.round(process.uptime() * 1000));
    const line = `${JSON.stringify(record)}\n`;
    const lineBytes = Buffer.byteLength(line, 'utf8');
    rotateIfNeeded(lineBytes);
    if (!logFile) return;
    fs.appendFileSync(logFile, line, 'utf8');
    currentBytes += lineBytes;
  } catch {
    // A diagnostic write must never break the app.
  }
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
    recordLifecycleEvent('app.exit', { code: code ?? 0, stack: stackOf() });
    return originalExit(code);
  };

  const originalQuit = target.quit.bind(target);
  target.quit = () => {
    recordLifecycleEvent('app.quit', { stack: stackOf() });
    return originalQuit();
  };

  if (typeof target.relaunch === 'function') {
    const originalRelaunch = target.relaunch.bind(target);
    target.relaunch = (options?: { args?: string[]; execPath?: string }) => {
      recordLifecycleEvent('app.relaunch', { stack: stackOf() });
      return originalRelaunch(options);
    };
  }

  const originalProcessExit = proc.exit.bind(proc);
  proc.exit = (code?: number) => {
    recordLifecycleEvent('process.exit', { code: code ?? 0, stack: stackOf() });
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
      recordLifecycleEvent('process.exit.event', { code });
    });
  } catch {}
}

/** Absolute path of the journal, for boot records and diagnostics. */
export function getLifecycleLogPath(): string | null {
  initLogFile();
  return logFile;
}
