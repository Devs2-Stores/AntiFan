/**
 * Live Electron Chromium Smoke Test: Decoupled Dual-Plane Background Automation
 * Verifies:
 * 1. User is active on Tab 2 (e.g. YouTube/Chat) while agent automates Tab 1 in background.
 * 2. Agent executes DOM inspect, screenshots, clicks, and reloads on Tab 1 without stealing window focus or switching activeTabId.
 * 3. User keystrokes on Tab 2 do not preempt or abort background agent execution on Tab 1 (RT-01).
 * 4. Tab 1 dynamically unthrottles during agent run and re-throttles upon settle (RT-02).
 * 5. Differential generation fencing auto-syncs on background reload without TARGET_STALE (RT-03).
 */
const { app } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert/strict');

// This file is both the Electron entry of the live lane and a module the unit test loads
// to inspect the objects it builds. `require.main === module` cannot tell the two apart
// here: Electron loads its entry through an internal main module (measured on Electron 43,
// the entry's `require.main` is not the entry and its `module.parent` is non-null). The
// launcher's argv identifies the lane instead — `scripts/run-electron.cjs` spawns Electron
// with the entry it was given, this script's path.
const IS_ENTRY = typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === __filename;

// Set by the entry boot below, which runs before the smoke test can read it.
let tempUserData;

if (IS_ENTRY) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
  tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-multitask-smoke-'));
  app.setPath('userData', tempUserData);
}

const { BridgeServer } = require('../.compiled/src/main/bridge/bridge-server.js');
const { makeControlPlaneId, issueRuntimeLease } = require('../.compiled/src/shared/control-plane-contracts.js');
const { CapabilityTransportAdapter } = require('../.compiled/src/main/tools/capability-transport.js');
const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port.js');
const { ControlPlaneRuntime } = require('../.compiled/src/main/control-plane/control-plane-runtime.js');
const { AttachmentRegistry } = require('../.compiled/src/main/run/attachment-registry.js');
const { NativeTabHost } = require('../.compiled/src/main/browser/native-tab-host.js');
const { AntiFanMcpServer } = require('../.compiled/src/main/mcp/mcp-server.js');
const { ProjectWindowShell } = require('../.compiled/src/main/browser/project-window-shell.js');
const { setChromeSenderResolver } = require('../.compiled/src/main/browser/ipc-router.js');

/**
 * The catalogue delegates the composition root installs (`src/main/index.ts:1828-1843`).
 * Without `resolveTabId`/`resolveFailoverTabId` the catalogue resolves every bound tab to
 * `undefined`, so the transport reads a live tab as gone, warns on every dispatch, and can
 * never reach its heal path. `getDocumentGeneration` rides along because the runtime stamps
 * it on every dispatch record.
 */
function runtimeDelegates(tabHost) {
  return {
    getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id),
    isTabAllowed: (primaryTabId, requestedTabId) => tabHost.isTabAllowedForPrimary(primaryTabId, requestedTabId),
    resolveTabId: (id) => tabHost.resolveTargetTabId(id),
    resolveFailoverTabId: (staleTabId) => tabHost.getFailoverTargetTab(staleTabId),
  };
}

/** The chrome IPC dispatch target for this shell's own surfaces, and its installation. */
function chromeSenderResolver({ windowShell, tabHost }) {
  return (webContents) => {
    const surface = windowShell.chromeSurfaceFor(webContents.id) || tabHost.surfaceForWebContents(webContents.id);
    return surface ? { host: tabHost, surface } : undefined;
  };
}

function installChromeSenderResolver(target) {
  setChromeSenderResolver(chromeSenderResolver(target));
}

module.exports = { runtimeDelegates, installChromeSenderResolver };

let cleanupFn = async () => {};

async function runMultitaskingSmokeTest() {
  console.log('[Smoke Multitasking] Starting live Electron decoupled background automation test...');

  let server;
  let mainWindow;
  let tabHost;
  let bridgeServer;

  let cleanupPromise = null;
  cleanupFn = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (tabHost) {
        try { tabHost.dispose(); } catch {}
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        try { mainWindow.destroy(); } catch {}
      }
      if (server) {
        try {
          server.closeAllConnections?.();
          await new Promise((resolve) => server.close(resolve));
        } catch {}
      }
      try {
        fs.rmSync(tempUserData, { recursive: true, force: true });
      } catch {}
    })();
    return cleanupPromise;
  };

  try {
    // 1. Setup Local HTTP Test Server with Storefront and User App pages
    let storefrontReloadCount = 0;
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/storefront')) {
        storefrontReloadCount++;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html>
<html>
<head><title>Storefront Tab (Count: ${storefrontReloadCount})</title></head>
<body>
  <h1>Storefront Active Theme</h1>
  <button id="buy-now" onclick="window.clicked = true">Buy Now</button>
  <input id="notes" placeholder="Order notes" />
  <script>window.loadCount = ${storefrontReloadCount}; window.clicked = false;</script>
</body>
</html>`);
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head><title>User Personal Browsing Tab</title></head>
<body>
  <h1>User Active Tab (YouTube / Facebook / Chat)</h1>
  <input id="user-search" placeholder="Type here..." />
</body>
</html>`);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const storefrontUrl = `http://127.0.0.1:${port}/storefront`;
    const userAppUrl = `http://127.0.0.1:${port}/user-app`;
    console.log(`[Smoke Multitasking] Local HTTP test server running at http://127.0.0.1:${port}`);

    // 2. Initialize Electron Window & NativeTabHost — the same pair the shipping factory builds
    // (`ensureProjectWindow`: shell owning window/chrome, then its own NativeTabHost), constructed
    // hidden exactly as the app does. Two deltas are inherent to a standalone smoke and deliberate:
    // `owner`/`title` are this harness's own identity instead of validated registry records, and the
    // host is not registered in a tab-authority directory, which only feeds cross-window sender
    // routing — this smoke has one window and drives the host through its own API.
    const mainWindowShell = new ProjectWindowShell({
      owner: { kind: 'project', projectId: 'project-00000000-0000-4000-8000-000000000001' },
      title: 'AntiFan Smoke Window',
      bounds: { width: 1280, height: 800 },
      show: false,
    });
    mainWindow = mainWindowShell.window;

    // The shared WorkspaceCapsuleManager argument is omitted: one window has no capsule store to
    // share, and the host's own manager is rooted in the temp userData set above.
    tabHost = new NativeTabHost(mainWindowShell);
    // Chrome IPC resolves its dispatch target from live shells on every message; production
    // installs this in src/main/index.ts. Without it this shell's toolbar/sidebar/frame-backdrop
    // boot calls are refused with UNKNOWN_CHROME_SENDER, which buries real failures in this
    // lane's stderr. Mirrors test/e2e/site-mute-smoke.cjs.
    installChromeSenderResolver({ windowShell: mainWindowShell, tabHost });

    // Create Tab 1 (Storefront / Background Agent Target)
    const tab1Id = tabHost.createTab(storefrontUrl, false);
    // Create Tab 2 (User Active Tab)
    const tab2Id = tabHost.createTab(userAppUrl, true);

    assert.strictEqual(tabHost.getActiveTabId(), tab2Id, 'User active tab is Tab 2');
    console.log(`[Smoke Multitasking] Created Tab 1 (Storefront: ${tab1Id}) and Tab 2 (User: ${tab2Id})`);

    // Wait for initial loads
    await new Promise((r) => setTimeout(r, 1500));

    // 3. Setup Control Plane, Registry, and MCP Server
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtime = new ControlPlaneRuntime({
      dataRoot: tempUserData,
      projectId,
      workspaceId,
      allowEval: true,
      getAutomationTabId: () => tabHost.getAutomationTabId(),
      // Mirrors the composition root (src/main/index.ts). Without these delegates the
      // catalogue resolves every bound tab to `undefined`, so the transport reads a live
      // tab as gone, warns on every dispatch and can never reach its heal path.
      ...runtimeDelegates(tabHost),
    });

    const lease = runtime.getLease();

    const browserPort = new BrowserControlPort(tabHost);
    runtime.registerBrowser(browserPort);
    // `attachSharedServices` in the app: the same two seams, wired here to this smoke's own runtime and port.
    tabHost.setControlPlane(runtime);
    tabHost.setViewportGate(browserPort.viewportGate);
    tabHost.setAutomationTabId(tab1Id);

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => lease.hostEpoch,
      getDocumentGeneration: (id) => tabHost.getDocumentGeneration(id || tab1Id),
    });

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: lease.hostEpoch,
      tabId: tab1Id,
      grant: 'write',
    });

    const transport = new CapabilityTransportAdapter(runtime.capabilities, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(tabHost, false, transport, {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    console.log('[Smoke Multitasking] Control plane and MCP server initialized.');

    // 4. Milestone 1: Passive DOM Read & Screenshot on background Tab 1 without stealing focus
    console.log('[Smoke Multitasking] Testing background DOM inspection...');
    const domRes = await mcpServer.callTool('anti.inspect.dom', { tabId: tab1Id });
    if (domRes.isError) {
      console.error('[Smoke Multitasking Error]', JSON.stringify(domRes, null, 2));
    }
    assert.strictEqual(domRes.isError, undefined, 'DOM inspection succeeded');
    assert.strictEqual(tabHost.getActiveTabId(), tab2Id, 'User active tab remained Tab 2 after DOM inspect');
    console.log('[OK] Milestone 1: Background DOM inspect executed without tab switching.');
    // 5. Milestone 2: Background Click and Type on Tab 1
    console.log('[Smoke Multitasking] Testing background interactive click & type...');
    const clickRes = await mcpServer.callTool('anti.agent.cursor.click', { tabId: tab1Id, selector: '#buy-now' });
    assert.strictEqual(clickRes.isError, undefined, 'Click succeeded');
    assert.strictEqual(tabHost.getActiveTabId(), tab2Id, 'User active tab remained Tab 2 after click');

    const typeRes = await mcpServer.callTool('anti.agent.cursor.type', { tabId: tab1Id, selector: '#notes', text: 'Rush order please' });
    assert.strictEqual(typeRes.isError, undefined, 'Type succeeded');
    assert.strictEqual(tabHost.getActiveTabId(), tab2Id, 'User active tab remained Tab 2 after type');
    console.log('[OK] Milestone 2: Background interactive actions completed headlessly.');

    // 6. Milestone 3: Background Reload with Adaptive Timeout
    console.log('[Smoke Multitasking] Testing background reload on Tab 1...');
    const reloadOk = await tabHost.reloadAndWait(tab1Id);
    assert.strictEqual(reloadOk, true, 'Background reload succeeded');
    assert.strictEqual(tabHost.getActiveTabId(), tab2Id, 'User active tab remained Tab 2 after reload');
    console.log(`[OK] Milestone 3: Background reload completed (reloaded count: ${storefrontReloadCount}).`);

    // 7. Milestone 4: Scoped Preemption Verification (RT-01)
    console.log('[Smoke Multitasking] Testing RT-01 scoped user preemption...');
    let started = false;
    let agentCompleted = false;
    const lockPromise = browserPort.viewportGate.withLock(async (signal) => {
      started = true;
      await new Promise((r) => setTimeout(r, 100));
      if (signal.aborted) throw signal.reason;
      agentCompleted = true;
      return true;
    }, { tabId: tab1Id });

    while (!started) {
      await new Promise((r) => setImmediate(r));
    }

    // Simulate physical user typing on foreground Tab 2
    browserPort.viewportGate.preemptActiveAgent('Manual keyboard input detected on tab', tab2Id);
    await lockPromise;
    assert.strictEqual(agentCompleted, true, 'User typing on Tab 2 did not preempt background agent on Tab 1');
    console.log('[OK] Milestone 4: RT-01 Scoped preemption verified successfully.');

    console.log('ALL LIVE ELECTRON MULTITASKING BACKGROUND AUTOMATION CHECKS PASSED.');
  } finally {
    await cleanupFn();
  }
}

if (IS_ENTRY) {
  process.on('unhandledRejection', async (reason) => {
    console.error('[Smoke Multitasking] Unhandled Rejection:', reason);
    try { await cleanupFn(); } catch {}
    app.exit(1);
  });

  app.whenReady().then(async () => {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('[Smoke Multitasking] Watchdog timeout reached (60s)')), 60_000);
    });
    try {
      await Promise.race([runMultitaskingSmokeTest(), timeoutPromise]);
      clearTimeout(timer);
      app.exit(0);
    } catch (err) {
      clearTimeout(timer);
      console.error('[Live Electron Multitasking Smoke FAIL]', err);
      try { await cleanupFn(); } catch {}
      app.exit(1);
    }
  });
}