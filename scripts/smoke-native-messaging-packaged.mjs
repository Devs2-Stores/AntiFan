import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LocalIpcServer } from '../.compiled/src/main/native-messaging/local-ipc-server.js';
import { NativeMessageDecoder, encodeNativeMessage } from '../.compiled/src/main/native-messaging/framing.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

async function runPackagedSmoke() {
  console.log('[smoke-native-messaging] Starting packaged native host smoke test...');

  // Strictly test the packaged executable from npm run package
  const packagedExe = path.join(
    rootDir,
    'plans',
    '260827-1345-production-cutover-release-hardening',
    'reports',
    'artifacts',
    'AntiFan-Browser-Desktop-win32-x64',
    'antifan-bridge-host.exe'
  );

  if (!fs.existsSync(packagedExe)) {
    throw new Error(`[smoke-native-messaging] Packaged host binary not found at: ${packagedExe}. You must run npm run package before running this smoke test.`);
  }

  console.log(`[smoke-native-messaging] Testing packaged host binary at: ${packagedExe}`);
  const exePath = packagedExe;
  const tmpRuntimeDir = path.join(os.tmpdir(), `antifan-smoke-ipc-${crypto.randomUUID()}`);
  const mockToken = `smoke-bridge-token-${crypto.randomUUID()}`;
  const bridgePort = 20138;
  const activeCapsuleId = 'capsule-haravan-smoke-1';
  const activePartition = 'persist:capsule-haravan-smoke-1';

  // 1. Start Local IPC Server
  const server = new LocalIpcServer();
  await server.start(
    bridgePort,
    () => ({
      token: mockToken,
      port: bridgePort,
      activeCapsuleId,
      activePartition,
    }),
    tmpRuntimeDir
  );

  console.log(`[smoke-native-messaging] Local IPC Server listening at: ${server.getSocketPath()}`);

  // 2. Spawn packaged host executable with stdio pipes
  const child = spawn(exePath, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ANTIFAN_RUNTIME_DIR: tmpRuntimeDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  const decoder = new NativeMessageDecoder();
  child.stdout.pipe(decoder);

  const responses = [];
  decoder.on('data', (msg) => {
    responses.push(msg);
  });

  child.stderr.on('data', (data) => {
    console.warn(`[smoke-native-messaging] host stderr: ${data.toString('utf8')}`);
  });

  try {
    // 3. Send Framed HANDSHAKE
    console.log('[smoke-native-messaging] Sending HANDSHAKE frame via stdio...');
    const handshakeBuf = encodeNativeMessage({ action: 'HANDSHAKE' });
    child.stdin.write(handshakeBuf);

    // Wait for handshake response frame
    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (responses.length > 0) return resolve();
        if (Date.now() - start > 6000) return reject(new Error('Timed out waiting for Native Host handshake frame'));
        setTimeout(check, 50);
      };
      check();
    });

    const handshakeRes = responses[0];
    console.log('[smoke-native-messaging] Handshake response received:', handshakeRes);
    if (handshakeRes.status !== 'SUCCESS' || handshakeRes.token !== mockToken) {
      throw new Error(`Invalid handshake response: ${JSON.stringify(handshakeRes)}`);
    }

    // 4. Send Framed PING
    console.log('[smoke-native-messaging] Sending PING frame via stdio...');
    const pingBuf = encodeNativeMessage({ action: 'PING' });
    child.stdin.write(pingBuf);

    await new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (responses.length > 1) return resolve();
        if (Date.now() - start > 4000) return reject(new Error('Timed out waiting for Native Host ping frame'));
        setTimeout(check, 50);
      };
      check();
    });

    const pingRes = responses[1];
    console.log('[smoke-native-messaging] Ping response received:', pingRes);
    if (pingRes.status !== 'PONG') {
      throw new Error(`Invalid ping response: ${JSON.stringify(pingRes)}`);
    }

    console.log('[smoke-native-messaging] All packaged stdio framing tests PASSED successfully.');
  } finally {
    child.stdin.end();
    await new Promise((resolve) => {
      child.on('exit', () => resolve());
      setTimeout(() => {
        try { child.kill(); } catch {}
        resolve();
      }, 1500);
    });

    server.close();
    try { fs.rmSync(tmpRuntimeDir, { recursive: true, force: true }); } catch {}
  }
}

runPackagedSmoke().catch((err) => {
  console.error('[smoke-native-messaging] FAILED:', err);
  process.exit(1);
});
