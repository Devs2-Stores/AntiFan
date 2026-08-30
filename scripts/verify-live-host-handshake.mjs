import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const { LocalIpcServer } = await import(pathToFileURL(path.join(rootDir, '.compiled', 'src', 'main', 'native-messaging', 'local-ipc-server.js')).href);
const { encodeNativeMessage, NativeMessageDecoder } = await import(pathToFileURL(path.join(rootDir, '.compiled', 'src', 'main', 'native-messaging', 'framing.js')).href);

const devHostExe = path.join(rootDir, 'bin', 'antifan-bridge-host.exe');
const packagedHostExe = path.join(rootDir, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'artifacts', 'AntiFan-Browser-Desktop-win32-x64', 'antifan-bridge-host.exe');

const targetHostExe = fs.existsSync(packagedHostExe) ? packagedHostExe : devHostExe;

if (!fs.existsSync(targetHostExe)) {
  console.error(`[VERIFY-FAIL] Native host executable not found at: ${targetHostExe}`);
  process.exit(1);
}

console.log(`[VERIFY] Testing live native host binary: ${targetHostExe}`);

async function runStage1_LiveHandshake(hostBinary) {
  console.log('\n=== STAGE 1: Live LocalIpcServer Handshake Probe (Isolated Temp Directory) ===');
  const isolatedRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-verify-runtime-stage1-'));
  const server = new LocalIpcServer();
  const testPort = 20138;
  const testToken = 'live-probe-token-' + Date.now();

  try {
    await server.start(testPort, () => ({
      token: testToken,
      port: testPort,
      activeCapsuleId: 'capsule-live-verify',
      activePartition: 'persist:capsule-live-verify'
    }), isolatedRuntimeDir);

    console.log(`[STAGE 1] LocalIpcServer listening on socket: ${server.getSocketPath()} in isolated dir: ${isolatedRuntimeDir}`);

    const response = await new Promise((resolve, reject) => {
      const child = spawn(hostBinary, [], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ANTIFAN_RUNTIME_DIR: isolatedRuntimeDir
        }
      });

      const decoder = new NativeMessageDecoder((err) => {
        reject(new Error(`NativeMessageDecoder error: ${err.message}`));
      });
      child.stdout.pipe(decoder);

      decoder.on('data', (msg) => {
        resolve({ msg, child });
      });

      child.on('error', (err) => {
        reject(new Error(`ChildProcess error: ${err.message}`));
      });

      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('Timed out waiting for Native Host handshake response'));
      }, 5000);

      child.on('exit', () => {
        clearTimeout(timeout);
      });

      child.stdin.write(encodeNativeMessage({ action: 'HANDSHAKE' }));
    });

    console.log('[STAGE 1] Decoded response from Native Host:', response.msg);

    if (response.msg?.status !== 'SUCCESS') {
      console.error(`[STAGE 1 FAIL] Expected status SUCCESS, got: ${response.msg?.status}`, response.msg);
      try { response.child.kill(); } catch {}
      process.exit(1);
    }

    if (response.msg?.token !== testToken) {
      console.error(`[STAGE 1 FAIL] Token mismatch: expected ${testToken}, got: ${response.msg?.token}`);
      try { response.child.kill(); } catch {}
      process.exit(1);
    }

    if (response.msg?.port !== testPort) {
      console.error(`[STAGE 1 FAIL] Port mismatch: expected ${testPort}, got: ${response.msg?.port}`);
      try { response.child.kill(); } catch {}
      process.exit(1);
    }

    console.log('[STAGE 1 PASS] Live handshake strictly validated with status SUCCESS, token, and port.');
    try { response.child.kill(); } catch {}
  } finally {
    server.close();
    try { fs.rmSync(isolatedRuntimeDir, { recursive: true, force: true }); } catch {}
  }
}

async function runStage2_StaleAuthAutoHeal(hostBinary) {
  const isolatedRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-verify-runtime-stage2-'));
  const authFile = path.join(isolatedRuntimeDir, 'bridge-auth.json');
  const lockFile = path.join(isolatedRuntimeDir, 'bridge-auth.lock');

  // Plant dead PID state in isolated directory
  fs.writeFileSync(authFile, JSON.stringify({
    instanceUuid: 'dead-instance-uuid-9999',
    launchNonce: 'stale-nonce',
    socketPath: '\\\\.\\pipe\\antifan-bridge-ipc-dead-instance-uuid-9999',
    port: 9999,
    pid: 99999999,
    createdAt: Date.now() - 100000
  }, null, 2), 'utf8');

  fs.writeFileSync(lockFile, JSON.stringify({
    instanceUuid: 'dead-instance-uuid-9999',
    pid: 99999999,
    createdAt: Date.now() - 100000
  }, null, 2), 'utf8');

  console.log('[STAGE 2] Seeded stale auth and lock with non-existent PID 99999999 in isolated dir.');

  const freshServer = new LocalIpcServer();
  const freshPort = 20139;
  const freshToken = 'healed-token-' + Date.now();

  try {
    await freshServer.start(freshPort, () => ({
      token: freshToken,
      port: freshPort,
      activeCapsuleId: 'capsule-healed',
      activePartition: 'persist:capsule-healed'
    }), isolatedRuntimeDir);

    console.log(`[STAGE 2] Fresh LocalIpcServer listening on socket: ${freshServer.getSocketPath()}`);

    const response = await new Promise((resolve, reject) => {
      const child = spawn(hostBinary, [], {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          ANTIFAN_RUNTIME_DIR: isolatedRuntimeDir
        }
      });

      const decoder = new NativeMessageDecoder((err) => {
        reject(new Error(`NativeMessageDecoder error: ${err.message}`));
      });
      child.stdout.pipe(decoder);

      decoder.on('data', (msg) => {
        resolve({ msg, child });
      });

      const timeout = setTimeout(() => {
        try { child.kill(); } catch {}
        reject(new Error('Timed out waiting for Native Host response during stale auth recovery'));
      }, 5000);

      child.stdin.write(encodeNativeMessage({ action: 'HANDSHAKE' }));
    });

    console.log('[STAGE 2] Decoded response during recovery test:', response.msg);

    if (response.msg?.status !== 'SUCCESS' || response.msg?.token !== freshToken) {
      console.error('[STAGE 2 FAIL] Fresh server failed to heal and serve handshake:', response.msg);
      try { response.child.kill(); } catch {}
      process.exit(1);
    }

    console.log('[STAGE 2 PASS] Stale auth was successfully auto-healed and fresh handshake succeeded.');
    try { response.child.kill(); } catch {}
  } finally {
    freshServer.close();
    try { fs.rmSync(isolatedRuntimeDir, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  try {
    await runStage1_LiveHandshake(targetHostExe);
    await runStage2_StaleAuthAutoHeal(targetHostExe);
    console.log('\n[VERIFIED_COMPLETE] All isolated native host probes passed successfully with zero errors.');
    process.exit(0);
  } catch (err) {
    console.error('\n[VERIFY-FATAL]', err);
    process.exit(1);
  }
}

main();
