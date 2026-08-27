/**
 * Packaged Recovery & Profile Persistence Smoke Test
 * 
 * Verifies end-to-end profile persistence and restart recovery on the packaged executable:
 * 1. Launches packaged app (Run 1) with isolated user-data and config directories
 * 2. Connects to Bridge RPC and seeds 2 custom tabs (Alpha and Beta)
 * 3. Queries Run 1 active tabs to verify creation
 * 4. Installs exit listener BEFORE calling antifan.persistTabs and antifan.quit
 * 5. Asserts process exits gracefully ({ forced: false }) and saved-tabs.json is written to disk with exact URLs
 * 6. Launches packaged app (Run 2) using the SAME user-data directory
 * 7. Connects to Bridge RPC in Run 2 and queries antifan.getTabs
 * 8. Asserts both seeded tabs are restored with exact URLs (0 data loss)
 * 9. Gracefully shuts down Run 2 ({ forced: false })
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const reportsDir = path.join(ROOT, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'smoke');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'packaged-recovery-smoke.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  try { logStream.write(line + '\n'); } catch {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const exePath = path.join(
  ROOT,
  'plans',
  '260827-1345-production-cutover-release-hardening',
  'reports',
  'artifacts',
  'AntiFan-Browser-Desktop-win32-x64',
  'antifan-browser-desktop.exe'
);

if (!fs.existsSync(exePath)) {
  console.error('Packaged executable not found at:', exePath);
  process.exit(1);
}

async function waitForBridgeJson(configDir, timeoutMs = 15000) {
  const bridgeFile = path.join(configDir, 'bridge.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(bridgeFile)) {
      try {
        const raw = fs.readFileSync(bridgeFile, 'utf8');
        const data = JSON.parse(raw);
        if (data.port && data.token) return data;
      } catch {}
    }
    await sleep(200);
  }
  throw new Error(`bridge.json not generated within ${timeoutMs}ms at ${bridgeFile}`);
}

function connectBridge(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${token}`);
    let reqId = 1;
    const pending = new Map();

    ws.on('open', () => {
      resolve({
        ws,
        request(method, params = {}) {
          return new Promise((res, rej) => {
            const id = `rec-req-${reqId++}`;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`Bridge request ${method} timed out`));
            }, 10000);

            pending.set(id, { res, rej, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          try { ws.close(); } catch {}
        },
      });
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        const handler = pending.get(msg.id || msg.requestId);
        if (handler) {
          clearTimeout(handler.timer);
          pending.delete(msg.id || msg.requestId);
          if (msg.success === false || msg.ok === false) {
            handler.rej(new Error(msg.error || 'Bridge request failed'));
          } else {
            handler.res(msg.data !== undefined ? msg.data : (msg.payload !== undefined ? msg.payload : msg));
          }
        }
      } catch {}
    });

    ws.on('error', reject);
  });
}

function monitorChildExit(child, pid) {
  let exitCode = null;
  let exitSignal = null;
  let hasExited = false;
  let forced = false;

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      hasExited = true;
      exitCode = code;
      exitSignal = signal;
      resolve({ code, signal, forced });
    });
  });

  return {
    async awaitGracefulExit(timeoutMs = 8000) {
      if (hasExited) return { code: exitCode, signal: exitSignal, forced: false };

      const timer = sleep(timeoutMs).then(() => {
        if (!hasExited) {
          forced = true;
          try {
            if (process.platform === 'win32') {
              spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
            } else {
              child.kill('SIGKILL');
            }
          } catch {}
        }
      });

      await Promise.race([exitPromise, timer]);
      return { code: exitCode, signal: exitSignal, forced };
    },
    async forceKill() {
      if (hasExited) return;
      forced = true;
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          child.kill('SIGKILL');
        }
      } catch {}
      await exitPromise;
    },
  };
}

async function runRecoverySmoke() {
  log('Starting Packaged Recovery & Profile Persistence Smoke Test against:', exePath);
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pkg-recovery-userdata-'));
  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pkg-recovery-config-'));
  log('Temp user-data dir:', tempUserData);
  log('Temp config dir:', tempConfigDir);

  const testUrlAlpha = 'https://example.com/recovered-tab-alpha';
  const testUrlBeta = 'https://example.com/recovered-tab-beta';

  let childRun1 = null;
  let childRun2 = null;
  let monitor1 = null;
  let monitor2 = null;

  try {
    // ─── RUN 1: Launch and Seed State ───
    log('Step 1: Launching packaged app (Run 1)...');
    childRun1 = spawn(exePath, ['--production'], {
      env: {
        ...process.env,
        ANTIFAN_USER_DATA: tempUserData,
        ANTIFAN_CONFIG_DIR: tempConfigDir,
        NODE_ENV: 'production',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
      },
      stdio: 'ignore',
      windowsHide: true,
    });

    const pid1 = childRun1.pid;
    monitor1 = monitorChildExit(childRun1, pid1);
    log(`Run 1 launched (PID ${pid1}). Waiting for bridge.json...`);
    const bridge1 = await waitForBridgeJson(tempConfigDir);
    log(`Run 1 Bridge Server ready at 127.0.0.1:${bridge1.port}`);

    // Connect to Bridge and seed tabs
    const client1 = await connectBridge(bridge1.port, bridge1.token);
    log('Connected to Run 1 Bridge. Seeding test tabs Alpha and Beta...');

    const tabAlphaRes = await client1.request('antifan.openTab', { url: testUrlAlpha });
    log('Opened Tab Alpha with ID:', tabAlphaRes.tabId);
    const tabBetaRes = await client1.request('antifan.openTab', { url: testUrlBeta });
    log('Opened Tab Beta with ID:', tabBetaRes.tabId);

    // Verify tabs in active state
    const tabsRun1 = await client1.request('antifan.getTabs');
    const tabUrlsRun1 = (tabsRun1.tabs || []).map((t) => t.url);
    log('Active tabs in Run 1:', tabUrlsRun1.join(', '));
    assert.ok(tabUrlsRun1.includes(testUrlAlpha), 'Tab Alpha must be present in Run 1');
    assert.ok(tabUrlsRun1.includes(testUrlBeta), 'Tab Beta must be present in Run 1');

    // Explicitly flush tabs to disk and request graceful quit
    log('Flushing tabs to disk via Bridge RPC (antifan.persistTabs)...');
    const persistRes = await client1.request('antifan.persistTabs');
    assert.strictEqual(persistRes.persisted, true, 'persistTabs must return { persisted: true }');

    log('Requesting graceful app quit via Bridge RPC (antifan.quit)...');
    const quitRes = await client1.request('antifan.quit');
    assert.strictEqual(quitRes.quitting, true, 'quit must return { quitting: true }');
    client1.close();

    // Await graceful process exit
    const exit1 = await monitor1.awaitGracefulExit(8000);
    log(`Run 1 exit observed: code=${exit1.code}, signal=${exit1.signal}, forced=${exit1.forced}`);
    assert.strictEqual(exit1.forced, false, 'Run 1 must terminate gracefully without forced taskkill');
    log('Step 2 Passed: Run 1 terminated gracefully.');

    // Assert saved-tabs.json exists on disk
    const savedTabsPath = path.join(tempUserData, 'saved-tabs.json');
    assert.ok(fs.existsSync(savedTabsPath), `saved-tabs.json must exist at ${savedTabsPath}`);
    const rawSaved = fs.readFileSync(savedTabsPath, 'utf8');
    const parsedSaved = JSON.parse(rawSaved);
    const savedUrls = (parsedSaved.tabs || []).map((t) => t.url);
    log('On-disk saved-tabs.json URLs:', savedUrls.join(', '));
    assert.ok(savedUrls.includes(testUrlAlpha), 'saved-tabs.json must contain Tab Alpha');
    assert.ok(savedUrls.includes(testUrlBeta), 'saved-tabs.json must contain Tab Beta');

    // Remove old bridge.json to avoid race condition in Run 2
    try { fs.unlinkSync(path.join(tempConfigDir, 'bridge.json')); } catch {}

    // ─── RUN 2: Recovery Verification ───
    log('Step 3: Launching packaged app (Run 2 - Profile Persistence Recovery)...');
    childRun2 = spawn(exePath, ['--production'], {
      env: {
        ...process.env,
        ANTIFAN_USER_DATA: tempUserData,
        ANTIFAN_CONFIG_DIR: tempConfigDir,
        NODE_ENV: 'production',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
      },
      stdio: 'ignore',
      windowsHide: true,
    });

    const pid2 = childRun2.pid;
    monitor2 = monitorChildExit(childRun2, pid2);
    log(`Run 2 launched (PID ${pid2}). Waiting for fresh bridge.json...`);
    const bridge2 = await waitForBridgeJson(tempConfigDir);
    log(`Run 2 Bridge Server ready at 127.0.0.1:${bridge2.port}`);

    // Connect to Bridge in Run 2 and verify restored tabs
    const client2 = await connectBridge(bridge2.port, bridge2.token);
    log('Connected to Run 2 Bridge. Querying recovered tabs...');

    const tabsRun2 = await client2.request('antifan.getTabs');
    const tabUrlsRun2 = (tabsRun2.tabs || []).map((t) => t.url);
    log('Recovered tabs in Run 2:', tabUrlsRun2.join(', '));

    assert.ok(tabUrlsRun2.includes(testUrlAlpha), 'Tab Alpha must be recovered in Run 2');
    assert.ok(tabUrlsRun2.includes(testUrlBeta), 'Tab Beta must be recovered in Run 2');
    log('Step 3 Passed: Verified 100% of seeded tabs restored intact (0 data loss).');

    // Gracefully quit Run 2
    log('Requesting graceful app quit for Run 2...');
    await client2.request('antifan.quit');
    client2.close();

    const exit2 = await monitor2.awaitGracefulExit(8000);
    log(`Run 2 exit observed: code=${exit2.code}, signal=${exit2.signal}, forced=${exit2.forced}`);
    assert.strictEqual(exit2.forced, false, 'Run 2 must terminate gracefully without forced taskkill');
    log('Step 4 Passed: Clean graceful teardown of Run 2.');

    log('ALL PACKAGED RECOVERY & PROFILE PERSISTENCE SMOKE TESTS PASSED SUCCESSFULLY.');
  } catch (err) {
    log('Packaged Recovery Smoke Test FAILED:', err.stack || err.message);
    if (monitor1) await monitor1.forceKill();
    if (monitor2) await monitor2.forceKill();
    process.exit(1);
  } finally {
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempConfigDir, { recursive: true, force: true }); } catch {}
  }
}

runRecoverySmoke();
