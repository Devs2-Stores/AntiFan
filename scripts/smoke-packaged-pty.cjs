const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const assert = require('node:assert');
const WebSocket = require('ws');

async function run() {
  const exePath = path.resolve(__dirname, '..', 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'artifacts', 'AntiFan-Browser-Desktop-win32-x64', 'antifan-browser-desktop.exe');
  assert.ok(fs.existsSync(exePath), `Packaged executable not found at: ${exePath}`);

  const logDir = path.resolve(__dirname, '..', 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'smoke');
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, 'packaged-pty-smoke.log');
  const logFd = fs.openSync(logFile, 'w');

  function log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    process.stdout.write(line);
    fs.writeSync(logFd, line);
  }

  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pty-userdata-'));
  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pty-config-'));

  let appChild = null;
  let ws = null;

  try {
    log('Starting Packaged Node-PTY Execution Smoke Test...');
    log(`Executable target: ${exePath}`);

    appChild = spawn(exePath, ['--production'], {
      env: {
        ...process.env,
        ANTIFAN_USER_DATA: tempUserData,
        ANTIFAN_CONFIG_DIR: tempConfigDir,
        NODE_ENV: 'production',
        ELECTRON_NO_ATTACH_CONSOLE: '1',
      },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });

    log(`Packaged app launched (PID ${appChild.pid}). Waiting for bridge.json...`);

    const bridgeJsonPath = path.join(tempConfigDir, 'bridge.json');
    let bridgeInfo = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (fs.existsSync(bridgeJsonPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(bridgeJsonPath, 'utf8'));
          if (raw.port && raw.token) {
            bridgeInfo = raw;
            break;
          }
        } catch {}
      }
    }

    assert.ok(bridgeInfo, 'Expected bridge.json to be created by packaged app');
    log(`Bridge discovered on port ${bridgeInfo.port}`);

    ws = new WebSocket(`ws://127.0.0.1:${bridgeInfo.port}?token=${encodeURIComponent(bridgeInfo.token)}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once('error', reject);
    });

    log('Connected to Bridge WebSocket. Step 1: Creating live terminal session via node-pty...');
    let msgId = 1;
    function sendRpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = `req-${msgId++}`;
        const timer = setTimeout(() => reject(new Error(`RPC ${method} timed out`)), 10000);
        const handler = (data) => {
          try {
            const msg = JSON.parse(data.toString('utf8'));
            if (msg.id === id) {
              clearTimeout(timer);
              ws.off('message', handler);
              if (msg.success === false) {
                reject(new Error(msg.error || `RPC ${method} failed`));
              } else {
                resolve(msg.data);
              }
            }
          } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const sessionRes = await sendRpc('antifan.terminalNewSession', { cwd: process.cwd() });
    const sessionId = sessionRes.sessionId;
    assert.ok(sessionId, 'Expected sessionId from terminalNewSession');
    log(`Created PTY session: ${sessionId}`);

    // Step 2: Set up listener for live terminal output
    const uniqueMarker = `PTY_LIVE_VERIFY_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let outputBuffer = '';
    const markerFoundPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timed out waiting for terminal output containing marker "${uniqueMarker}". Received buffer: ${JSON.stringify(outputBuffer)}`));
      }, 25000);

      const onData = (raw) => {
        try {
          const msg = JSON.parse(raw.toString('utf8'));
          if (msg.event === 'antifan:terminal:data' && msg.data) {
            const chunk = typeof msg.data === 'string' ? msg.data : msg.data.data;
            if (typeof chunk === 'string') {
              outputBuffer += chunk;
              if (outputBuffer.includes(uniqueMarker)) {
                clearTimeout(timer);
                ws.off('message', onData);
                resolve();
              }
            }
          }
        } catch {}
      };
      ws.on('message', onData);
    });

    // Step 3: Send command to terminal PTY with marker
    log(`Step 2: Sending command to terminal PTY with marker: ${uniqueMarker}...`);
    await new Promise((r) => setTimeout(r, 500));
    await sendRpc('antifan.terminalInput', {
      sessionId,
      text: `echo ${uniqueMarker}\r\n`,
    });

    // Step 4: Await the streaming output from the live PTY process
    await markerFoundPromise;
    log(`Step 3 Passed: Verified live terminal PTY stream received marker "${uniqueMarker}".`);
    log('Step 4: Closing PTY session...');
    const closeRes = await sendRpc('antifan.terminalCloseSession', { sessionId });
    assert.ok(closeRes !== undefined, 'Expected close confirmation');
    log('PTY session closed.');

    // Step 6: Graceful quit
    log('Step 5: Quitting packaged application via Bridge RPC...');
    await sendRpc('antifan.quit', {});
    ws.close();
    ws = null;

    const exitResult = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged app did not exit within timeout')), 10000);
      appChild.once('exit', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });

    log(`Packaged app exited: code=${exitResult.code}, signal=${exitResult.signal}`);
    assert.strictEqual(exitResult.code, 0, `Expected exit code 0, got ${exitResult.code}`);
    assert.strictEqual(exitResult.signal, null, `Expected null signal, got ${exitResult.signal}`);

    // Verify durable log contents
    try { fs.closeSync(logFd); } catch {}
    const logContent = fs.readFileSync(logFile, 'utf8');
    assert.ok(!logContent.includes('AttachConsole failed'), 'Log must not contain "AttachConsole failed"');
    assert.ok(!logContent.includes('[antifan uncaughtException]'), 'Log must not contain uncaught exceptions');
    assert.ok(!logContent.includes('TypeError: Object has been destroyed'), 'Log must not contain "TypeError: Object has been destroyed"');
    console.log('==========================================');
    console.log('ALL PACKAGED NODE-PTY TESTS PASSED (100%)!');
    console.log('==========================================');
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.close(); } catch {}
    }
    if (appChild && !appChild.killed) {
      try { appChild.kill(); } catch {}
    }
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempConfigDir, { recursive: true, force: true }); } catch {}
  }
}

run().catch((err) => {
  console.error('[PTY Smoke] FAILED:', err);
  process.exit(1);
});
