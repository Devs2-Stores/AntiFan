import * as fs from 'fs';
import * as path from 'path';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { LocalIpcClient } from './local-ipc-client';
import { StorageLocations } from '../config/storage-locations';

const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB

function setupDiagnosticLogging(): (msg: string) => void {
  let logFile: string | null = null;
  let logFileOld: string | null = null;
  let currentBytes = 0;
  let initialized = false;

  function initLogFile(): void {
    if (initialized) return;
    initialized = true;
    try {
      const runtimeDir = process.env.ANTIFAN_RUNTIME_DIR || StorageLocations.getRuntimeDir();
      const logDir = path.join(runtimeDir, 'logs');
      if (!fs.existsSync(logDir)) {
        try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
      }
      logFile = path.join(logDir, 'native-host.log');
      logFileOld = path.join(logDir, 'native-host.log.1');
      if (fs.existsSync(logFile)) {
        currentBytes = fs.statSync(logFile).size;
      }
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
      if (fs.existsSync(logFile)) {
        fs.renameSync(logFile, logFileOld);
      }
      currentBytes = 0;
    } catch {
      currentBytes = 0;
    }
  }

  return (msg: string) => {
    try {
      initLogFile();
      if (!logFile) return;

      const line = `[${new Date().toISOString()}] ${msg}\n`;
      const lineBytes = Buffer.byteLength(line, 'utf8');

      rotateIfNeeded(lineBytes);

      fs.appendFile(logFile, line, 'utf8', () => {
        // Non-fatal async callback
      });
      currentBytes += lineBytes;
    } catch {
      // Diagnostic logging failure must never break messaging handshake
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
  const ipcClient = new LocalIpcClient(process.env.ANTIFAN_RUNTIME_DIR);
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
    log('Chromium closed stdin stream. Exiting native host.');
    ipcClient.disconnect();
    process.exit(0);
  });
}

if (require.main === module) {
  main();
}
