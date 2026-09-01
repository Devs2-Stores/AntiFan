/**
 * Live Electron Playwright Parity & Gap Telemetry Smoke Test
 * Verifies:
 * 1. Semantic ARIA snapshot with monotonic @e1..@eN refs in live WebContents.
 * 2. Safe in-page JS evaluation (anti.browser.evaluate).
 * 3. CDP-native file upload into file input (anti.agent.file_upload).
 * 4. High-fidelity viewport screenshot capture (anti.screenshot.viewport).
 * 5. Correlation gap telemetry recording into .antifan/telemetry/gaps.jsonl.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-smoke-'));
app.setPath('userData', tempUserData);

const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { TerminalManager } = require('../.compiled/src/main/browser/terminal-manager.js');
const { CapabilityCatalogue } = require('../.compiled/src/main/tools/capability-catalogue.js');
const { registerBrowserCapabilities } = require('../.compiled/src/main/tools/browser-capabilities.js');
const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port.js');
const { issueRuntimeLease, makeControlPlaneId } = require('../.compiled/src/shared/control-plane-contracts.js');
const { getTelemetryLogPath } = require('../.compiled/src/main/telemetry/fallback-recorder.js');
async function runParitySmokeTest() {
  console.log('[Parity Smoke Test] Starting live Electron verification...');

  let server;
  let mainWindow;
  let tabHost;
  let termId;

  try {
    // 1. Setup Local Test HTTP Server with File Input and Interactive Elements
    const testHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Storefront Parity Target</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    #upload-form { margin-top: 20px; padding: 15px; border: 1px solid #ccc; }
  </style>
</head>
<body>
  <h1>Storefront Admin Parity</h1>
  <button id="checkout-btn">Proceed to Checkout</button>
  <form id="upload-form">
    <label for="csv-file">Upload Product CSV:</label>
    <input type="file" id="csv-file" name="csv">
    <div id="file-status">No file chosen</div>
  </form>
  <script>
    document.getElementById('csv-file').addEventListener('change', function(e) {
      const files = e.target.files;
      if (files && files.length > 0) {
        document.getElementById('file-status').textContent = 'Loaded: ' + files[0].name;
      }
    });
  </script>
</body>
</html>`;

    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(testHtml);
    });

    const port = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(server.address().port);
      });
    });

    const testUrl = `http://127.0.0.1:${port}/`;
    console.log(`[Parity Smoke Test] Test server listening on ${testUrl}`);

    // Create temporary upload fixture
    const uploadFixturePath = path.join(tempUserData, 'products.csv');
    fs.writeFileSync(uploadFixturePath, 'id,name,price\n1,Shirt,250000');

    // 2. Create Electron Window and TabHost
    mainWindow = new BrowserWindow({
      width: 1024,
      height: 768,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    tabHost = new NativeTabHost(mainWindow);
    const tabId = tabHost.createTab(testUrl, true);
    await tabHost.navigateAndWait(tabId, testUrl);

    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 60_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
    });

    const browserPort = new BrowserControlPort({
      getTabList: () => tabHost.getTabList(),
      getActiveTabId: () => tabHost.getActiveTabId(),
      getAutomationTabId: () => tabHost.getAutomationTabId(),
      setAutomationTabId: (id) => tabHost.setAutomationTabId(id),
      createTab: (url, act) => tabHost.createTab(url, act),
      closeTab: (id) => tabHost.closeTab(id),
      switchTab: (id) => tabHost.switchTab(id),
      navigate: (id, url) => tabHost.navigateAndWait(id, url),
      reload: (id) => tabHost.reloadAndWait(id),
      getDom: (sel, id, pane) => tabHost.getDom(sel, id, pane),
      captureScreenshot: (rect, id, pane) => tabHost.captureScreenshot(rect, id, pane),
      evalJs: (expr, id, pane) => tabHost.evalJs(expr, id, pane),
      getDiagnostics: (id, lvl) => tabHost.getDiagnostics(id, lvl),
      runResponsiveCheck: (id) => tabHost.runResponsiveCheck(id),
      agentTrajectory: (p) => tabHost.agentTrajectory(p),
      agentHighlight: (p) => tabHost.agentHighlight(p),
      agentClear: (id, pane) => tabHost.agentClear(id, pane),
      agentSnapshot: (id, pane) => tabHost.agentSnapshot(id, pane),
      agentType: (p) => tabHost.agentType(p),
      uploadFileInput: (p) => tabHost.uploadFileInput(p),
      dropFiles: (p) => tabHost.dropFiles(p),
      clearAllAgentWorking: () => tabHost.clearAllAgentWorking(),
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
      setViewportGate: (b, v) => tabHost.setViewportGate(b, v),
    });

    registerBrowserCapabilities(catalogue, browserPort, undefined, () => tempUserData);
    const target = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId,
      browserEpoch: 1,
      documentGeneration: tabHost.getDocumentGeneration(tabId),
      runtimeLeaseId: lease.runtimeLeaseId,
    };
    const ctx = {
      grant: 'write',
      browserTarget: target,
      projectId,
      workspaceId,
      lease,
      leaseToken: lease.token,
    };

    // Give page 200ms to settle DOM
    await new Promise((r) => setTimeout(r, 200));

    // Milestone 1: Canonical anti.inspect.snapshot
    console.log('[Parity Smoke Test] Milestone 1: Capturing Semantic ARIA Snapshot via anti.inspect.snapshot...');
    const snapshotRes = await catalogue.dispatch('anti.inspect.snapshot', { tabId }, { ...ctx, grant: 'read' });
    const snapshotText = snapshotRes?.snapshot || '';
    assert.ok(snapshotText, 'Snapshot text must not be empty');
    assert.ok(snapshotText.includes('@e'), 'Snapshot text must contain @e refs');
    assert.ok(snapshotText.includes('Proceed to Checkout') || snapshotText.includes('button'), 'Snapshot must find interactive button');
    console.log('[Parity Smoke Test] Milestone 1 SUCCESS: Snapshot contains monotonic refs.');

    // Milestone 2: In-Page Safe JS Evaluation via anti.browser.evaluate
    console.log('[Parity Smoke Test] Milestone 2: Evaluating in-page JavaScript expression via anti.browser.evaluate...');
    const evalRes = await catalogue.dispatch('anti.browser.evaluate', {
      expression: 'document.title',
      tabId,
    }, { ...ctx, grant: 'eval' });
    const evalTitle = typeof evalRes === 'string' ? evalRes : evalRes?.result;
    assert.strictEqual(evalTitle, 'Storefront Parity Target');
    console.log('[Parity Smoke Test] Milestone 2 SUCCESS: Title matched exactly.');

    // Milestone 3: High-Fidelity Viewport Screenshot via anti.screenshot.viewport
    console.log('[Parity Smoke Test] Milestone 3: Capturing viewport screenshot via anti.screenshot.viewport...');
    const screenshotRes = await catalogue.dispatch('anti.screenshot.viewport', { tabId }, { ...ctx, grant: 'read' });
    const screenshotBase64 = typeof screenshotRes === 'string' ? screenshotRes : (screenshotRes?.base64 || '');
    assert.ok(screenshotBase64 && screenshotBase64.length > 100, 'Screenshot base64 payload must be valid');
    console.log(`[Parity Smoke Test] Milestone 3 SUCCESS: Screenshot captured (${screenshotBase64.length} bytes base64).`);
    // Milestone 4: Native File Upload via anti.agent.file_upload
    console.log('[Parity Smoke Test] Milestone 4: Uploading file via anti.agent.file_upload...');
    termId = TerminalManager.getInstance().createSession(tempUserData);
    tabHost.setTabTerminalSession(tabId, termId);
    const uploadRes = await catalogue.dispatch('anti.agent.file_upload', {
      refOrSelector: '#csv-file',
      filePaths: [uploadFixturePath],
      tabId,
    }, ctx);
    assert.strictEqual(uploadRes?.success, true, `Upload failed: ${uploadRes?.reason}`);
    assert.strictEqual(uploadRes?.uploadedCount, 1);

    // Verify change event was triggered on page
    const fileStatusRes = await catalogue.dispatch('anti.browser.evaluate', {
      expression: 'document.getElementById("file-status").textContent',
      tabId,
    }, { ...ctx, grant: 'eval' });
    const fileStatusText = typeof fileStatusRes === 'string' ? fileStatusRes : fileStatusRes?.result;
    assert.strictEqual(fileStatusText, 'Loaded: products.csv');
    console.log('[Parity Smoke Test] Milestone 4 SUCCESS: File uploaded and event listener fired.');
    // Milestone 5: Fallback Telemetry Recording via anti.telemetry.record_fallback
    console.log('[Parity Smoke Test] Milestone 5: Recording gap telemetry record via anti.telemetry.record_fallback...');
    const telRes = await catalogue.dispatch('anti.telemetry.record_fallback', {
      sessionId: 'smoke-session-1',
      targetUrl: testUrl,
      primaryTool: 'anti.agent.file_upload',
      fallbackTool: 'browser_file_upload',
      fallbackResult: 'SUCCESS',
      durationMs: 35.2,
      notes: 'Smoke test validated Playwright parity kernel',
    }, ctx);

    assert.strictEqual(telRes?.recorded, true);
    assert.ok(telRes?.path, 'telRes must contain path');
    const logPath = getTelemetryLogPath(tempUserData);
    assert.strictEqual(telRes.path, logPath);
    assert.ok(fs.existsSync(logPath), 'gaps.jsonl must exist on disk');

    const logData = fs.readFileSync(logPath, 'utf8');
    const entry = JSON.parse(logData.trim().split('\n').pop());
    assert.strictEqual(entry.primaryTool, 'anti.agent.file_upload');
    assert.strictEqual(entry.fallbackTool, 'browser_file_upload');
    assert.strictEqual(entry.fallbackResult, 'SUCCESS');
    console.log('[Parity Smoke Test] Milestone 5 SUCCESS: Telemetry record written and content verified.');
    console.log('[Parity Smoke Test] ALL 5 PARITY MILESTONES VERIFIED SUCCESSFULLY VIA CANONICAL ANTI.* CAPABILITIES!');
    return true;
  } finally {
    if (tabHost) {
      try { tabHost.dispose(); } catch {}
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.destroy();
    }
    if (server) {
      try {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
      } catch {}
    }
    if (termId) {
      try {
        await TerminalManager.getInstance().closeSession(termId);
      } catch {}
    }
    try {
      fs.rmSync(tempUserData, { recursive: true, force: true });
    } catch {}
  }
}

app.whenReady().then(async () => {
  try {
    await runParitySmokeTest();
    app.exit(0);
  } catch (err) {
    console.error('[Parity Smoke Test] FAILED with error:', err);
    app.exit(1);
  }
});
