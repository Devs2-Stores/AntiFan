import * as fs from 'fs';
import * as path from 'path';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { LocalIpcClient } from './local-ipc-client';
import { StorageLocations } from '../config/storage-locations';

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Resolve the runtime directory that holds `bridge-auth.json`.
 *
 * StorageLocations.getRuntimeDir() is the authoritative resolver for this
 * process tree: the Desktop side hands the very same value to
 * LocalIpcServer.start() (src/main/index.ts), so server and host agree by
 * construction. ANTIFAN_RUNTIME_DIR stays first because dev/smoke/test harnesses
 * pin an isolated directory through it (see
 * test/main/native-messaging-e2e-pipeline.test.ts).
 *
 * Splitting this resolution was the actual defect behind the spawn storm: the
 * diagnostic logger already used `ANTIFAN_RUNTIME_DIR || getRuntimeDir()` and
 * therefore wrote to Drive E, while the IPC client read `process.env` alone and
 * silently fell back to the legacy `%LOCALAPPDATA%\AntiFan\runtime` directory —
 * a launch nonce file frozen on 2026-08-30 whose named pipe no longer exists.
 * Every handshake therefore died with ENOENT against a dead pipe, which the
 * extension saw as a failed port and answered by spawning yet another host.
 */
function resolveRuntimeDir(): string {
  if (process.env.ANTIFAN_RUNTIME_DIR) return process.env.ANTIFAN_RUNTIME_DIR;
  return StorageLocations.getRuntimeDir();
}

/** resolveRuntimeDir() can throw on a malformed ANTIFAN_DATA_ROOT; the IPC path must stay non-fatal. */
function resolveRuntimeDirSafe(): string | undefined {
  try {
    return resolveRuntimeDir();
  } catch {
    return process.env.ANTIFAN_RUNTIME_DIR;
  }
}

/**
 * Diagnostic logger.
 *
 * Every line is written with a synchronous `fs.writeSync` against a handle that
 * stays open for the process lifetime. The previous implementation queued
 * `fs.appendFile(...)` and returned immediately, and every exit path in this file
 * ends in `process.exit()`, which tears the process down before libuv's threadpool
 * can flush that queued write. Consequence: `Chromium closed stdin stream. Exiting
 * native host.` and `IPC forwarding error: ...` were dropped for all 10,296 hosts
 * in E:\Work\.antifan-data\runtime\logs\native-host.log, so the log looked like a
 * clean 10,150-line startup list and actively hid this very bug from diagnosis.
 *
 * With a kept-open handle nothing can be in flight at `process.exit()` time, so a
 * line cannot be lost. It is also cheaper, not slower: measured 0.0057 ms/line
 * versus 1.46 ms/line for the awaited async append, because neither a threadpool
 * round trip nor a per-line open/close is needed.
 */
function setupDiagnosticLogging(): (msg: string) => void {
  let logFile: string | null = null;
  let logFileOld: string | null = null;
  let logFd: number | null = null;
  let currentBytes = 0;
  let initialized = false;

  function openLogFd(): void {
    if (logFd !== null || !logFile) return;
    try {
      logFd = fs.openSync(logFile, 'a');
    } catch {
      logFd = null;
    }
  }

  function closeLogFd(): void {
    if (logFd === null) return;
    try { fs.closeSync(logFd); } catch {}
    logFd = null;
  }

  function initLogFile(): void {
    if (initialized) return;
    initialized = true;
    try {
      const logDir = path.join(resolveRuntimeDir(), 'logs');
      if (!fs.existsSync(logDir)) {
        try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
      }
      logFile = path.join(logDir, 'native-host.log');
      logFileOld = path.join(logDir, 'native-host.log.1');
      if (fs.existsSync(logFile)) {
        currentBytes = fs.statSync(logFile).size;
      }
      openLogFd();
    } catch {
      logFile = null;
      logFileOld = null;
    }
  }

  function rotateIfNeeded(addedBytes: number): void {
    if (!logFile || !logFileOld) return;
    if (currentBytes + addedBytes <= MAX_LOG_BYTES) return;

    // Windows refuses to rename a file that still has an open handle, so the
    // handle is released first and re-opened on the fresh file afterwards.
    closeLogFd();
    try {
      if (fs.existsSync(logFileOld)) {
        try { fs.unlinkSync(logFileOld); } catch {}
      }
      if (fs.existsSync(logFile)) {
        fs.renameSync(logFile, logFileOld);
      }
      currentBytes = 0;
    } catch {
      currentBytes = 0;
    }
    openLogFd();
  }

  // Release the handle at teardown. Nothing is pending by then (every line is
  // already on disk), this is pure hygiene to avoid leaking a descriptor.
  process.once('exit', closeLogFd);

  return (msg: string) => {
    try {
      initLogFile();
      if (!logFile) return;

      const line = `[${new Date().toISOString()}] ${msg}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');

      rotateIfNeeded(lineBytes);
      if (logFd === null) openLogFd();
      const fd = logFd;
      if (fd === null) return;

      fs.writeSync(fd, line);
      currentBytes += lineBytes;
    } catch {
      // Diagnostic logging failure must never break messaging handshake
      closeLogFd();
    }
  };
}

const log = setupDiagnosticLogging();

export async function main(): Promise<void> {
  log('Starting AntiFan Native Messaging Host runner...');

  process.on('uncaughtException', (err) => {
    log(`Uncaught Exception: ${err.stack || err.message}`);
    // Do not write unformatted text to stdout; write framed error
    try {
      const errBuf = encodeNativeMessage({
        status: 'ERROR',
        error: 'UNCAUGHT_EXCEPTION',
        message: err.message,
      });
      process.stdout.write(errBuf);
    } catch {}
  });

  const decoder = new NativeMessageDecoder();
  // Reads bridge-auth.json from the same directory the Desktop IPC server wrote
  // it to, so the zero-trust launch nonce is looked up in the live location even
  // though Chromium launches this host with no ANTIFAN_RUNTIME_DIR in its
  // environment. Nonce verification itself is untouched and still fail-closed.
  const ipcClient = new LocalIpcClient(resolveRuntimeDirSafe());
  let isExiting = false;

  decoder.on('data', async (message: any) => {
    log(`Received message from Chromium: ${JSON.stringify(message)}`);

    try {
      // Forward framed message to AntiFan Desktop via Local IPC
      const response = await ipcClient.send(message);
      log(`Received response from Desktop IPC: ${JSON.stringify(response)}`);
      const outBuf = encodeNativeMessage(response);
      process.stdout.write(outBuf);
    } catch (err) {
      if (isExiting) return;
      isExiting = true;
      log(`IPC forwarding error: ${(err as Error).message}`);
      let errBuf: Buffer | null = null;
      try {
        errBuf = encodeNativeMessage({
          status: 'ERROR',
          error: 'IPC_FORWARDING_FAILED',
          message: (err as Error).message,
        });
      } catch {}
      ipcClient.disconnect();
      if (errBuf) {
        let exitFinished = false;
        let fallbackTimer: NodeJS.Timeout | undefined;
        const finish = () => {
          if (exitFinished) return;
          exitFinished = true;
          clearTimeout(fallbackTimer);
          process.exit(1);
        };
        fallbackTimer = setTimeout(finish, 1000);
        process.stdout.write(errBuf, () => finish());
      } else {
        process.exit(1);
      }
    }
  });

  decoder.on('error', (err) => {
    log(`Framing decoder error: ${err.message}`);
    try {
      const errBuf = encodeNativeMessage({
        status: 'ERROR',
        error: 'FRAMING_DECODE_ERROR',
        message: err.message,
      });
      process.stdout.write(errBuf);
    } catch {}
  });

  process.stdin.pipe(decoder);

  process.stdin.on('end', () => {
    // Logged synchronously: this line used to be lost to the async append that
    // process.exit(0) below never let flush, erasing every clean host teardown
    // from the diagnostic record.
    log('Chromium closed stdin stream. Exiting native host.');
    ipcClient.disconnect();
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}
