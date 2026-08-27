/**
 * Packaged Theme Developer Workflow Smoke Test
 * Directly drives the packaged Windows x64 executable via authenticated Bridge RPC:
 * plans/260827-1345-production-cutover-release-hardening/reports/artifacts/AntiFan-Browser-Desktop-win32-x64/antifan-browser-desktop.exe
 */
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert');
const { WebSocket } = require('ws');

const ROOT = path.resolve(__dirname, '..');
const reportsDir = path.join(ROOT, 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'smoke');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'packaged-theme-developer-smoke.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  logStream.write(line + '\n');
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

async function runThemeDeveloperSmoke() {
  log('Starting Packaged Theme Developer Smoke Test against:', exePath);
  const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pkg-theme-userdata-'));
  const tempConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pkg-theme-config-'));
  const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pkg-theme-ws-'));
  log('Temp user-data dir:', tempUserData);
  log('Temp config dir:', tempConfigDir);
  log('Temp workspace dir:', tempWorkspace);

  let fixtureServer = null;
  let fixturePort = 0;
  let appChild = null;
  let wsClient = null;

  try {
    // 1. Start Local Theme Preview HTTP Fixture
    log('Step 1: Starting local theme preview fixture server...');
    const fixtureHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Haravan Aqua Theme Preview</title>
  <style>
    body { font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 20px; }
    .product-card { border: 1px solid #334155; padding: 16px; border-radius: 8px; max-width: 400px; }
    h1 { color: #38bdf8; font-size: 20px; }
    #theme-product-title { font-weight: bold; color: #a855f7; }
    #theme-price { color: #22c55e; font-size: 18px; margin: 8px 0; }
    #theme-btn { background: #3b82f6; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <h1>Theme Developer Workbench Preview</h1>
  <div class="product-card">
    <div id="theme-product-title">Haravan Aqua Denim Jacket</div>
    <div id="theme-price">750,000 VND</div>
    <button id="theme-btn" onclick="this.innerText='Added to Cart!'">Add to Cart</button>
  </div>
</body>
</html>`;

    fixtureServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fixtureHtml);
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture server start timeout')), 5000);
      fixtureServer.listen(0, '127.0.0.1', () => {
        clearTimeout(timer);
        fixturePort = fixtureServer.address().port;
        resolve();
      });
    });

    const previewUrl = `http://127.0.0.1:${fixturePort}/`;
    log(`Local theme preview fixture listening on: ${previewUrl}`);

    // 2. Launch Packaged Electron App in Production Mode
    log('Step 2: Launching packaged Electron executable in production mode...');
    appChild = spawn(exePath, ['--production', '--no-sandbox'], {
      env: {
        ...process.env,
        ANTIFAN_USER_DATA: tempUserData,
        ANTIFAN_CONFIG_DIR: tempConfigDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    appChild.stdout.on('data', (d) => logStream.write(`[EXE:stdout] ${d.toString('utf8')}`));
    appChild.stderr.on('data', (d) => logStream.write(`[EXE:stderr] ${d.toString('utf8')}`));

    log(`Packaged app launched (PID ${appChild.pid}). Waiting for bridge.json in ${tempConfigDir}...`);

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

    assert.ok(bridgeInfo, `Expected bridge.json to be created by running packaged app in ${tempConfigDir}`);
    log(`Step 2 Passed: Discovered Bridge Server at 127.0.0.1:${bridgeInfo.port} with auth token.`);

    // 3. Connect to Packaged App's Bridge Server via WebSocket
    log('Step 3: Connecting to packaged Bridge WebSocket RPC...');
    const wsUrl = `ws://127.0.0.1:${bridgeInfo.port}?token=${encodeURIComponent(bridgeInfo.token)}`;
    wsClient = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), 5000);
      wsClient.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      wsClient.once('error', reject);
    });

    log('Connected to packaged app WebSocket Bridge Server.');

    // Helper for sending Bridge requests
    let msgId = 1;
    function sendBridgeRequest(method, params = {}, timeoutMs = 20000) {
      return new Promise((resolve, reject) => {
        const id = `req-${msgId++}`;
        const timer = setTimeout(() => reject(new Error(`Bridge request ${method} (${id}) timed out`)), timeoutMs);
        const onMessage = (data) => {
          try {
            const msg = JSON.parse(data.toString('utf8'));
            if (msg.id === id || msg.requestId === id) {
              clearTimeout(timer);
              wsClient.removeListener('message', onMessage);
              if (msg.success === false || msg.ok === false) {
                reject(new Error(msg.error || `Bridge request ${method} failed`));
              } else {
                resolve(msg.data !== undefined ? msg.data : (msg.payload !== undefined ? msg.payload : msg));
              }
            }
          } catch {}
        };

        wsClient.on('message', onMessage);
        wsClient.send(JSON.stringify({ id, method, params }));
      });
    }

    // 4. Start an Authoritative Session
    log('Step 4: Creating authoritative CLI session in packaged control plane...');
    const sessionRes = await sendBridgeRequest('antifan.cli.startSession', {
      backendId: 'theme-smoke',
      grant: 'write',
      ttlMs: 60000,
    });

    assert.ok(sessionRes.attachmentId, 'Session must return an attachmentId');
    assert.ok(sessionRes.secret, 'Session must return an attachment secret');
    function redactId(id) {
      if (typeof id !== 'string') return '[REDACTED]';
      const prefix = id.split('-')[0] || 'id';
      return `${prefix}-***${id.slice(-4)}`;
    }
    log(`Session created: runId=${redactId(sessionRes.runId)}, attemptId=${redactId(sessionRes.attemptId)}, attachmentId=${redactId(sessionRes.attachmentId)}`);
    function makeClaims(overrides = {}) {
      return {
        attachmentId: sessionRes.attachmentId,
        attachmentSecret: sessionRes.secret,
        projectId: sessionRes.projectId,
        workspaceId: sessionRes.workspaceId,
        runId: sessionRes.runId,
        attemptId: sessionRes.attemptId,
        invocationId: `inv-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        ...overrides,
      };
    }

    // 5. Open Tab and Navigate to Local Theme Preview in Packaged Chromium
    log('Step 5: Opening tab and navigating to preview URL in packaged Chromium...');
    const openTabRes = await sendBridgeRequest('antifan.capability.dispatch', {
      name: 'browser.open-tab',
      params: { url: previewUrl, activate: true },
      attachmentClaims: makeClaims(),
    });
    log('Tab created in packaged Chromium:', openTabRes);
    const tabId = openTabRes?.tabId;
    assert.ok(tabId, 'Tab creation must return tabId');

    // Wait for navigation load
    await new Promise((r) => setTimeout(r, 1500));

    // 6. Inspect Live DOM in Packaged Chromium
    log('Step 6: Inspecting live DOM in packaged Chromium...');
    const inspectRes = await sendBridgeRequest('antifan.capability.dispatch', {
      name: 'browser.dom',
      params: { tabId, selector: '#theme-product-title' },
      attachmentClaims: makeClaims(),
    });
    assert.match(
      typeof inspectRes === 'string' ? inspectRes : JSON.stringify(inspectRes),
      /Haravan Aqua Denim Jacket/,
      'DOM inspection must contain the fixture product title'
    );
    log('Step 6 Passed: Verified theme product title matches expected fixture.');

    // Wait for first paint
    await new Promise((r) => setTimeout(r, 1000));

    // 7. Capture Viewport Screenshot from Packaged Chromium
    log('Step 7: Capturing live screenshot from packaged Chromium...');
    const screenshotRes = await sendBridgeRequest('antifan.capability.dispatch', {
      name: 'browser.screenshot',
      params: { tabId },
      attachmentClaims: makeClaims(),
    });

    let pngBuffer = null;
    let byteCount = 0;
    if (typeof screenshotRes === 'string') {
      pngBuffer = Buffer.from(screenshotRes, 'base64');
      byteCount = pngBuffer.length;
    } else if (screenshotRes && typeof screenshotRes.data === 'string') {
      pngBuffer = Buffer.from(screenshotRes.data, 'base64');
      byteCount = pngBuffer.length;
    } else if (screenshotRes && screenshotRes.path && fs.existsSync(screenshotRes.path)) {
      pngBuffer = fs.readFileSync(screenshotRes.path);
      byteCount = pngBuffer.length;
    } else if (screenshotRes && typeof screenshotRes.byteLength === 'number') {
      byteCount = screenshotRes.byteLength;
    }

    assert.ok(byteCount > 100, `Screenshot payload must be non-trivial PNG data (got ${byteCount} bytes)`);
    if (pngBuffer && pngBuffer.length >= 8) {
      const isPng = pngBuffer[0] === 0x89 && pngBuffer[1] === 0x50 && pngBuffer[2] === 0x4e && pngBuffer[3] === 0x47;
      assert.ok(isPng, 'Screenshot buffer must start with standard PNG header (0x89504E47)');
      log(`Step 7 Passed: Captured live screenshot (${byteCount} bytes, valid PNG header verified).`);
    } else {
      log(`Step 7 Passed: Captured live screenshot artifact (${byteCount} bytes recorded).`);
    }

    // 8. End Authoritative Session
    log('Step 8: Ending authoritative session...');
    const endRes = await sendBridgeRequest('antifan.cli.endSession', {
      runId: sessionRes.runId,
      attemptId: sessionRes.attemptId,
      attachmentId: sessionRes.attachmentId,
      secret: sessionRes.secret,
      outcome: 'completed',
    });
    log('Session ended successfully:', endRes);

    // 9. Verify Security: Unauthenticated dispatch fails closed
    log('Step 9: Verifying security policy rejection on tampered secret...');
    await assert.rejects(
      () => sendBridgeRequest('antifan.capability.dispatch', {
        name: 'browser.navigate',
        params: { tabId, url: 'https://example.com' },
        attachmentClaims: makeClaims({ attachmentSecret: 'TAMPERED_SECRET_XYZ' }),
      }),
      /UNAUTHENTICATED|Unauthorized|ATTACHMENT_INVALID/i,
      'Tampered attachment credentials must fail closed'
    );

    // 10. Clean Teardown
    log('Step 10: Clean teardown of packaged app process...');
    wsClient.close();
    if (appChild && !appChild.killed) {
      try { execSync(`taskkill /PID ${appChild.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
    await new Promise((r) => setTimeout(r, 1000));
    log(`Packaged app (PID ${appChild.pid}) terminated cleanly.`);

    log('ALL PACKAGED THEME DEVELOPER END-TO-END SMOKE TESTS PASSED SUCCESSFULLY.');
    logStream.end();
    if (fixtureServer) fixtureServer.close();
    await new Promise((r) => setTimeout(r, 200));
    process.exit(0);
  } catch (err) {
    log('Packaged Theme Developer Smoke Test FAILED:', err.stack || err.message);
    if (wsClient) { try { wsClient.close(); } catch {} }
    if (appChild && !appChild.killed) {
      try { execSync(`taskkill /PID ${appChild.pid} /T /F`, { stdio: 'ignore' }); } catch {}
    }
    if (fixtureServer) fixtureServer.close();
    logStream.end();
    await new Promise((r) => setTimeout(r, 200));
    process.exit(1);
  } finally {
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempConfigDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempWorkspace, { recursive: true, force: true }); } catch {}
  }
}

runThemeDeveloperSmoke();
