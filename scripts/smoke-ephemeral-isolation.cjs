#!/usr/bin/env node
/**
 * AntiFan Browser Desktop - Real Chromium E2E Isolation Certification
 * Phase 1 Execution Probe:
 * Boots live Electron without GPU, opens 2 ephemeral tabs and 1 persistent tab,
 * asserts strict cookie separation across live Chromium sessions, and validates cleanup.
 */

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');

function wait(ms) {
  const { promise, resolve } = Promise.withResolvers();
  setTimeout(resolve, ms);
  return promise;
}

function startFixtureServer() {
  const { promise, resolve } = Promise.withResolvers();
  const server = http.createServer((req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': 'server_session=server-base-token; Path=/',
    });
    res.end(`<!DOCTYPE html>
<html>
<head><title>Isolation Fixture</title></head>
<body>
  <h1>Chromium Session Isolation Fixture</h1>
  <div id="content">Ready</div>
</body>
</html>`);
  });

  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    resolve({ server, port, baseUrl: `http://127.0.0.1:${port}` });
  });

  return promise;
}

async function runIsolationCertification() {
  console.log('[E2E Certification] Starting real Chromium isolation certification...');
  const { server, port, baseUrl } = await startFixtureServer();
  console.log(`[E2E Certification] Local fixture server listening on ${baseUrl}`);

  const win = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const tabHost = new NativeTabHost(win);

  try {
    // 1. Open Ephemeral Tab A
    console.log('[E2E Certification] Opening Ephemeral Tab A...');
    const tabAId = tabHost.createTab(`${baseUrl}/tab-a`, false, { ephemeral: true });
    assert.ok(tabAId, 'Ephemeral Tab A ID must exist');
    await wait(800);

    // 2. Open Ephemeral Tab B
    console.log('[E2E Certification] Opening Ephemeral Tab B...');
    const tabBId = tabHost.createTab(`${baseUrl}/tab-b`, false, { ephemeral: true });
    assert.ok(tabBId, 'Ephemeral Tab B ID must exist');
    await wait(800);

    // 3. Open Persistent Tab
    console.log('[E2E Certification] Opening Persistent Tab...');
    const tabPersistId = tabHost.createTab(`${baseUrl}/tab-persist`, false);
    assert.ok(tabPersistId, 'Persistent Tab ID must exist');
    await wait(800);

    // 4. Set unique cookie in Tab A
    console.log('[E2E Certification] Injecting unique token in Ephemeral Tab A...');
    const setRes = await tabHost.evalJs(
      `document.cookie = "anti_isolation_token=token-A-unique; path=/"; document.cookie;`,
      tabAId
    );
    console.log(`[E2E Certification] Tab A cookies: ${setRes}`);
    assert.match(String(setRes), /anti_isolation_token=token-A-unique/, 'Tab A must have anti_isolation_token');

    // 5. Assert Tab B does NOT have Tab A's cookie
    console.log('[E2E Certification] Verifying Ephemeral Tab B isolation...');
    const tabBCookies = await tabHost.evalJs(`document.cookie;`, tabBId);
    console.log(`[E2E Certification] Tab B cookies: ${tabBCookies}`);
    assert.strictEqual(
      String(tabBCookies).includes('anti_isolation_token=token-A-unique'),
      false,
      'Ephemeral Tab B MUST NOT contain Tab A session cookie'
    );

    // 6. Assert Persistent Tab does NOT have Tab A's cookie
    console.log('[E2E Certification] Verifying Persistent Tab isolation...');
    const persistCookies = await tabHost.evalJs(`document.cookie;`, tabPersistId);
    console.log(`[E2E Certification] Persistent Tab cookies: ${persistCookies}`);
    assert.strictEqual(
      String(persistCookies).includes('anti_isolation_token=token-A-unique'),
      false,
      'Persistent Tab MUST NOT contain Ephemeral Tab A session cookie'
    );

    // 7. Verify tab closure and cleanup
    console.log('[E2E Certification] Closing Ephemeral Tabs...');
    const closeA = tabHost.closeTab(tabAId);
    const closeB = tabHost.closeTab(tabBId);
    const closeP = tabHost.closeTab(tabPersistId);
    assert.strictEqual(closeA, true, 'Tab A closed');
    assert.strictEqual(closeB, true, 'Tab B closed');
    assert.strictEqual(closeP, true, 'Tab Persist closed');

    const memUsage = process.memoryUsage();
    console.log(`[E2E Certification] Memory RSS: ${(memUsage.rss / 1024 / 1024).toFixed(2)} MB`);

    const report = {
      timestamp: new Date().toISOString(),
      platform: process.platform,
      arch: process.arch,
      electronVersion: process.versions.electron,
      chromeVersion: process.versions.chrome,
      verified: true,
      cookieIsolation: {
        ephemeralA_containsTokenA: true,
        ephemeralB_leakedTokenA: false,
        persistent_leakedTokenA: false,
      },
      lifecycle: {
        tabsCreated: 3,
        tabsClosed: 3,
        memoryRssMb: Math.round(memUsage.rss / 1024 / 1024),
      },
    };

    const reportDir = path.join(__dirname, '..', 'plans', 'reports', 'runtime-verification');
    fs.mkdirSync(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, 'real-chromium-isolation-certification.json');
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[E2E Certification] Written certification report to ${reportPath}`);

    console.log('[E2E Certification] CERTIFICATION SUCCESSFUL: 100% Isolation Verified.');
    server.close();
    win.destroy();
    app.quit();
    process.exit(0);
  } catch (err) {
    console.error('[E2E Certification] FAILED:', err);
    try { server.close(); } catch {}
    try { win.destroy(); } catch {}
    app.quit();
    process.exit(1);
  }
}

app.whenReady().then(runIsolationCertification).catch((err) => {
  console.error('[E2E Certification] Unhandled Error:', err);
  app.quit();
  process.exit(1);
});
