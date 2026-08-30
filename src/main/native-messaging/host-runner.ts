import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { NativeMessageDecoder, encodeNativeMessage } from './framing';
import { LocalIpcClient } from './local-ipc-client';

function setupDiagnosticLogging(): (msg: string) => void {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const logDir = path.join(localAppData, 'AntiFan', 'logs');
  if (!fs.existsSync(logDir)) {
    try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  }
  const logFile = path.join(logDir, 'native-host.log');

  return (msg: string) => {
    try {
      const line = `[${new Date().toISOString()}] ${msg}\n`;
      fs.appendFileSync(logFile, line, 'utf8');
    } catch {}
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

  decoder.on('data', async (message: any) => {
    log(`Received message from Chromium: ${JSON.stringify(message)}`);

    try {
      // Forward framed message to AntiFan Desktop via Local IPC
      const response = await ipcClient.send(message);
      log(`Received response from Desktop IPC: ${JSON.stringify(response)}`);
      const outBuf = encodeNativeMessage(response);
      process.stdout.write(outBuf);
    } catch (err) {
      log(`IPC forwarding error: ${(err as Error).message}`);
      const errBuf = encodeNativeMessage({
        status: 'ERROR',
        error: 'IPC_FORWARDING_FAILED',
        message: (err as Error).message,
      });
      process.stdout.write(errBuf);
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
