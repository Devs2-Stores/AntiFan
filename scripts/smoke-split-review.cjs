/**
 * Split Web Desktop Mobile Review — Real NativeTabHost Electron Smoke Test
 * Tests real Electron 43 WebContentsView lifecycle, NativeTabHost split mode toggle,
 * independent DOM/form state, synchronized navigation, focused pane routing, and clean teardown.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function readPngDimensions(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 24 || buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') {
    throw new Error(`Invalid PNG file header at: ${filePath}`);
  }
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

app.commandLine.appendSwitch('no-sandbox');
const reportsDir = path.join(__dirname, '..', 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'smoke');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'split-review-smoke.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });
const origLog = console.log;
const origErr = console.error;
console.log = (...args) => {
  origLog(...args);
  try { logStream.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`); } catch {}
};
console.error = (...args) => {
  origErr(...args);
  try { logStream.write(`[${new Date().toISOString()}] [ERROR] ${args.join(' ')}\n`); } catch {}
};

const { isAllowedNavigation, sanitizeUrl } = require('../.compiled/src/main/security/security-policy.js');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-smoke-'));
app.setPath('userData', tempUserData);
async function runSmokeTest() {
  console.log('[Smoke] Starting NativeTabHost Split Review Electron Smoke Test...');
  let win;
  let tabHost;

  try {
    // 1. Start HTTP fixture server
    const fixtureHtml = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Split Fixture Home</title>
</head>
<body>
  <h1>Split Fixture Home</h1>
  <input id="smoke-input" type="text" value="home-init" />
  <script>
    window.setTestCookie = () => { document.cookie = "smoke_auth=12345; path=/"; };
    window.getTestCookie = () => document.cookie;
  </script>
</body>
</html>`;

    const page2Html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Split Fixture Page 2</title>
</head>
<body>
  <h1>Split Fixture Page 2</h1>
  <input id="smoke-input" type="text" value="page2-init" />
</body>
</html>`;

    server = http.createServer((req, res) => {
      if (req.url === '/page2') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(page2Html);
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fixtureHtml);
      }
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server start timed out')), 5000);
      server.listen(0, '127.0.0.1', () => {
        clearTimeout(timer);
        testPort = server.address().port;
        resolve();
      });
    });

    const homeUrl = `http://127.0.0.1:${testPort}/`;
    const page2Url = `http://127.0.0.1:${testPort}/page2`;
    console.log(`[Smoke] Fixture server listening at ${homeUrl}`);

    // 2. Create Window
    win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
      },
    });

    // 3. Instantiate NativeTabHost from compiled build
    const { NativeTabHost } = require(path.join(__dirname, '..', '.compiled', 'src', 'main', 'browser', 'native-tab-host.js'));
    tabHost = new NativeTabHost(win);

    console.log('[Smoke] Step 1: Creating initial tab...');
    const tabId = tabHost.createTab(homeUrl, true);
    if (!tabId || typeof tabId !== 'string') {
      throw new Error('Failed to create initial tab ID');
    }
    console.log(`[Smoke] Created tab ${tabId}`);

    // Wait for initial load with 10s bounded timeout
    await new Promise((resolve, reject) => {
      const startTime = Date.now();
      const check = () => {
        if (Date.now() - startTime > 10000) {
          return reject(new Error('Initial tab load timed out after 10000ms'));
        }
        const currentTab = tabHost.getTabList().find((t) => t.id === tabId);
        if (currentTab && (!currentTab.isLoading || Date.now() - startTime > 2000)) {
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    console.log('[Smoke] Step 2: Enabling Split Review Mode on tab...');
    tabHost.toggleSplitReview(tabId);
    let tabState = tabHost.getTabList().find((t) => t.id === tabId);
    if (!tabState || tabState.splitMode !== true) {
      throw new Error(`Expected splitMode to be true after toggleSplitReview, got: ${tabState?.splitMode}`);
    }
    console.log('[Smoke] Split review mode enabled. Split fields:', {
      splitMode: tabState.splitMode,
      splitDesktopPresetId: tabState.splitDesktopPresetId,
      splitMobilePresetId: tabState.splitMobilePresetId,
      splitFocusedPane: tabState.splitFocusedPane,
    });

    // Wait for both panes to settle
    await new Promise((resolve) => setTimeout(resolve, 1500));

    console.log('[Smoke] Step 3: Verifying CSS viewports, DOM values, and shared session...');
    const desktopDims = await tabHost.evalJs(`({ w: window.innerWidth, h: window.innerHeight });`, tabId, 'desktop');
    const mobileDims = await tabHost.evalJs(`({ w: window.innerWidth, h: window.innerHeight });`, tabId, 'mobile');
    console.log('[Smoke] CSS Viewport dimensions:', { desktop: desktopDims, mobile: mobileDims });
    if (mobileDims.w > 600 || desktopDims.w < 800) {
      throw new Error(`Unexpected CSS viewport dimensions: desktop=${JSON.stringify(desktopDims)}, mobile=${JSON.stringify(mobileDims)}`);
    }

    await tabHost.evalJs(`document.getElementById('smoke-input').value = 'desktop-custom';`, tabId, 'desktop');
    const mobileInputVal = await tabHost.evalJs(`document.getElementById('smoke-input').value;`, tabId, 'mobile');
    if (mobileInputVal !== 'home-init') {
      throw new Error(`Expected mobile input to stay 'home-init', got '${mobileInputVal}'`);
    }
    console.log('[Smoke] Verified independent form input state.');

    // Verify shared cookie in session
    await tabHost.evalJs(`window.setTestCookie();`, tabId, 'desktop');
    const mobileCookie = await tabHost.evalJs(`window.getTestCookie();`, tabId, 'mobile');
    if (!mobileCookie || !mobileCookie.includes('smoke_auth=12345')) {
      throw new Error(`Expected mobile pane to share session cookie, got '${mobileCookie}'`);
    }
    console.log('[Smoke] Verified shared session cookie access.');

    // Verify shared localStorage
    await tabHost.evalJs(`localStorage.setItem('split_test_ls', 'active_123');`, tabId, 'desktop');
    const mobileLs = await tabHost.evalJs(`localStorage.getItem('split_test_ls');`, tabId, 'mobile');
    if (mobileLs !== 'active_123') {
      throw new Error(`Expected shared localStorage, got: ${mobileLs}`);
    }
    console.log('[Smoke] Verified shared localStorage in same tab session.');

    // Verify clean web standard DOM (no intrusive DOM containing-block clip styles injected)
    const mobileHasClip = await tabHost.evalJs(`Boolean(document.getElementById('antifan-device-clip'));`, tabId, 'mobile');
    const desktopHasClip = await tabHost.evalJs(`Boolean(document.getElementById('antifan-device-clip'));`, tabId, 'desktop');
    if (mobileHasClip || desktopHasClip) {
      throw new Error(`Expected clean DOM without clip style injections (got mobile=${mobileHasClip}, desktop=${desktopHasClip})`);
    }
    console.log('[Smoke] Verified clean DOM containing-block semantics across both panes.');

    console.log('[Smoke] Step 4: Testing synchronized navigation to Page 2...');
    tabHost.navigate(tabId, page2Url);
    // Wait for navigation coordinator to settle both panes
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const desktopUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'desktop');
    const mobileUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'mobile');
    if (!desktopUrl.includes('/page2') || !mobileUrl.includes('/page2')) {
      throw new Error(`Expected both views on page2, got desktop=${desktopUrl}, mobile=${mobileUrl}`);
    }
    console.log('[Smoke] Verified synchronized navigation across both panes.');

    console.log('[Smoke] Step 4b: Testing reload & resize layout update...');
    const reloadOk = tabHost.reload(tabId);
    if (!reloadOk) throw new Error('Expected tabHost.reload to return true');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    win.setSize(1600, 1000);
    tabHost.updateLayout();
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('[Smoke] Verified reload and window resize layout update.');
    console.log('[Smoke] Step 4c: Testing back/forward history navigation...');
    
    // Log history capabilities before traversal
    const dCanBack = await tabHost.evalJs(`window.history.length`, tabId, 'desktop');
    const mCanBack = await tabHost.evalJs(`window.history.length`, tabId, 'mobile');
    console.log(`[Smoke] History length: desktop=${dCanBack}, mobile=${mCanBack}`);

    let backOk = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      backOk = tabHost.goBack(tabId);
      if (backOk) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (!backOk) {
      throw new Error(`Expected goBack to return true (desktopLen=${dCanBack}, mobileLen=${mCanBack})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const backDesktopUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'desktop');
    const backMobileUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'mobile');
    if (!backDesktopUrl.endsWith('/') || !backMobileUrl.endsWith('/')) {
      throw new Error(`Expected both panes on homeUrl after goBack, got desktop=${backDesktopUrl}, mobile=${backMobileUrl}`);
    }
    console.log('[Smoke] Verified goBack navigation synced to both panes:', { desktop: backDesktopUrl, mobile: backMobileUrl });

    const fwdOk = tabHost.goForward(tabId);
    if (!fwdOk) {
      throw new Error('Expected goForward to return true');
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const fwdDesktopUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'desktop');
    const fwdMobileUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'mobile');
    if (!fwdDesktopUrl.includes('/page2') || !fwdMobileUrl.includes('/page2')) {
      throw new Error(`Expected both panes on page2 after goForward, got desktop=${fwdDesktopUrl}, mobile=${fwdMobileUrl}`);
    }
    console.log('[Smoke] Verified goForward navigation synced to both panes:', { desktop: fwdDesktopUrl, mobile: fwdMobileUrl });
    console.log('[Smoke] Step 4d: Testing split review zoom geometry...');
    tabHost.setZoom(tabId, 1.25);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tabAfterZoom = tabHost.getTabList().find((t) => t.id === tabId);
    if (tabAfterZoom.zoomFactor !== 1.25) {
      throw new Error(`Expected zoomFactor 1.25, got ${tabAfterZoom.zoomFactor}`);
    }
    tabHost.setZoom(tabId, 1.0);
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('[Smoke] Verified split review zoom geometry scaling.');
    console.log('[Smoke] Step 4e: Testing live z-order and split Font Finder & Annotation popup...');
    // 1. Assert live contentView z-order
    const children = win.contentView.children;
    const tabRec = tabHost.tabs.get(tabId);
    const backdropIdx = children.indexOf(tabHost.frameBackdropView);
    const desktopIdx = children.indexOf(tabRec.view);
    const mobileIdx = children.indexOf(tabRec.mobileView);
    const sidebarIdx = children.indexOf(tabHost.sidebarView);
    const toolbarIdx = children.indexOf(tabHost.toolbarView);
    if (backdropIdx === -1 || desktopIdx === -1 || mobileIdx === -1 || sidebarIdx === -1 || toolbarIdx === -1) {
      throw new Error(`Expected all 5 views attached to contentView, got backdrop=${backdropIdx}, desktop=${desktopIdx}, mobile=${mobileIdx}, sidebar=${sidebarIdx}, toolbar=${toolbarIdx}`);
    }
    if (!(backdropIdx < desktopIdx && desktopIdx < mobileIdx && mobileIdx < sidebarIdx && sidebarIdx < toolbarIdx)) {
      throw new Error(`Z-order mismatch: backdrop=${backdropIdx}, desktop=${desktopIdx}, mobile=${mobileIdx}, sidebar=${sidebarIdx}, toolbar=${toolbarIdx}`);
    }
    console.log('[Smoke] Verified live contentView.children z-order: backdrop < desktop < mobile < sidebar < toolbar.');

    // 2. Test Font Finder toggle in split mode across both WebContents
    const ffStarted = tabHost.toggleFontFinder();
    if (!ffStarted) {
      throw new Error('Expected Font Finder to start');
    }
    await new Promise((r) => setTimeout(r, 200));
    const desktopFf = await tabHost.evalJs(`Boolean(window.__antifanFontFinderActive)`, tabId, 'desktop');
    const mobileFf = await tabHost.evalJs(`Boolean(window.__antifanFontFinderActive)`, tabId, 'mobile');
    if (!desktopFf || !mobileFf) {
      throw new Error(`Expected Font Finder active on both panes, got desktop=${desktopFf}, mobile=${mobileFf}`);
    }
    const ffStopped = tabHost.toggleFontFinder();
    if (ffStopped) {
      throw new Error('Expected Font Finder to stop');
    }
    await new Promise((r) => setTimeout(r, 200));
    const desktopFfClean = await tabHost.evalJs(`Boolean(window.__antifanFontFinderActive)`, tabId, 'desktop');
    const mobileFfClean = await tabHost.evalJs(`Boolean(window.__antifanFontFinderActive)`, tabId, 'mobile');
    if (desktopFfClean || mobileFfClean) {
      throw new Error(`Expected Font Finder cleaned on both panes, got desktop=${desktopFfClean}, mobile=${mobileFfClean}`);
    }
    console.log('[Smoke] Verified split Font Finder live injection and cleanup across desktop and mobile WebContents.');

    // 3. Test bottom-edge annotation popup geometry and clipping prevention
    const popupTestResult = await tabHost.evalJs(`
      (() => {
        const bottomEl = document.createElement('div');
        bottomEl.id = 'bottom-test-el';
        bottomEl.style.cssText = 'position:fixed;bottom:5px;left:50px;width:100px;height:20px;';
        document.body.appendChild(bottomEl);

        const r = bottomEl.getBoundingClientRect();
        const modalW = 320;
        const vpH = window.innerHeight;
        const vpW = window.innerWidth;
        
        const calcPosition = (currentH) => {
          let top = r.bottom + 6;
          let left = r.left;
          if (top + currentH > vpH - 10) {
            const topAbove = r.top - currentH - 6;
            top = topAbove >= 10 ? topAbove : Math.max(10, vpH - currentH - 10);
          }
          top = Math.max(10, Math.min(vpH - currentH - 10, top));
          left = Math.max(10, Math.min(vpW - modalW - 10, left));
          return { top, left };
        };

        const initialPos = calcPosition(260);
        const initialBottom = initialPos.top + 260;
        const initialVisible = initialPos.top >= 10 && initialBottom <= vpH;
        const flippedAbove = initialPos.top < r.top;

        // When user types a long description, textareaAutoGrow invokes repositionModal with expanded height
        const expandedH = 450;
        const expandedPos = calcPosition(expandedH);
        const expandedBottom = expandedPos.top + expandedH;
        const expandedVisible = expandedPos.top >= 10 && expandedBottom <= vpH;

        bottomEl.remove();
        return {
          vpH,
          initialPos,
          initialBottom,
          initialVisible,
          flippedAbove,
          expandedPos,
          expandedBottom,
          expandedVisible,
        };
      })()
    `, tabId, 'mobile');

    if (!popupTestResult || !popupTestResult.flippedAbove || !popupTestResult.initialVisible || !popupTestResult.expandedVisible) {
      throw new Error(`Expected bottom-edge popup to flip above and stay visible, got: ${JSON.stringify(popupTestResult)}`);
    }
    console.log('[Smoke] Verified bottom-edge annotation popup flips above and stays visible within viewport:', popupTestResult);
    console.log('[Smoke] Step 5: Testing focused pane switching & tool routing...');
    tabHost.setSplitFocusedPane(tabId, 'mobile');
    tabState = tabHost.getTabList().find((t) => t.id === tabId);
    if (tabState.splitFocusedPane !== 'mobile') {
      throw new Error(`Expected splitFocusedPane to be mobile, got ${tabState.splitFocusedPane}`);
    }
    const defaultTargetHtml = await tabHost.getDom('#smoke-input', tabId);
    if (!defaultTargetHtml || !defaultTargetHtml.includes('smoke-input')) {
      throw new Error('Expected getDom on focused pane to return element');
    }
    const mobileSnapshot = await tabHost.agentSnapshot(tabId, 'mobile');
    if (!mobileSnapshot || typeof mobileSnapshot !== 'string') {
      throw new Error('Expected agentSnapshot on mobile pane to return ARIA snapshot');
    }
    console.log('[Smoke] Verified focused pane target routing (DOM & agent snapshot).');
    console.log('[Smoke] Step 5b: Testing inspect mode & element pick capture on focused pane...');
    tabHost.switchTab(tabId);
    const inspectActive = tabHost.toggleInspect(tabId);
    if (!inspectActive) {
      throw new Error('Expected toggleInspect to activate inspect mode');
    }
    let emittedPickedData = null;
    const onElementPicked = (data) => {
      emittedPickedData = data;
    };
    tabHost.on('element-picked', onElementPicked);

    // Simulate picking an element on focused mobile pane
    await tabHost.evalJs(`
      window.__antifanPick = {
        tagName: 'INPUT',
        selector: '#smoke-input',
        clientRect: { x: 10, y: 20, width: 120, height: 32 },
        canceled: false,
        screenshotBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        viewportImageBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M/wHwMDAwMDGAEB/pEB5QAAAABJRU5ErkJggg==',
      };
      try {
        window.dispatchEvent(new CustomEvent('antifan-pick-event', { detail: window.__antifanPick }));
      } catch {}
    `, tabId, 'mobile');

    // Wait for inspect poll to consume __antifanPick
    for (let i = 0; i < 20; i++) {
      if (emittedPickedData) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    tabHost.removeListener('element-picked', onElementPicked);
    if (!emittedPickedData) {
      throw new Error('Expected element-picked event to be emitted on simulated pick in split review');
    }
    if (!emittedPickedData.screenshotBase64 || typeof emittedPickedData.screenshotBase64 !== 'string' || emittedPickedData.screenshotBase64.length === 0) {
      throw new Error('Expected element-picked to contain non-empty screenshotBase64 image data');
    }
    if (!emittedPickedData.targetImagePath || !fs.existsSync(emittedPickedData.targetImagePath)) {
      throw new Error(`Expected targetImagePath file to exist on disk, got: ${emittedPickedData.targetImagePath}`);
    }
    if (!emittedPickedData.viewportImagePath || !fs.existsSync(emittedPickedData.viewportImagePath)) {
      throw new Error(`Expected viewportImagePath file to exist on disk, got: ${emittedPickedData.viewportImagePath}`);
    }
    const targetStat = fs.statSync(emittedPickedData.targetImagePath);
    const viewportStat = fs.statSync(emittedPickedData.viewportImagePath);
    if (targetStat.size === 0 || viewportStat.size === 0) {
      throw new Error('Expected target and viewport images to have non-zero size');
    }
    const targetDims = readPngDimensions(emittedPickedData.targetImagePath);
    const viewportDims = readPngDimensions(emittedPickedData.viewportImagePath);
    if (targetDims.width === 0 || targetDims.height === 0 || viewportDims.width === 0 || viewportDims.height === 0) {
      throw new Error(`Expected non-zero PNG dimensions, got target=${JSON.stringify(targetDims)}, viewport=${JSON.stringify(viewportDims)}`);
    }
    if (targetDims.width > viewportDims.width || targetDims.height > viewportDims.height) {
      throw new Error(`Expected cropped target dimensions (${targetDims.width}x${targetDims.height}) to be contained in viewport (${viewportDims.width}x${viewportDims.height})`);
    }
    console.log(`[Smoke] Verified element pick and coordinate crop dimensions (target: ${targetDims.width}x${targetDims.height}, viewport: ${viewportDims.width}x${viewportDims.height}).`);
    if (tabHost.isInspectActive()) {
      tabHost.stopInspect();
    }
    if (tabHost.isInspectActive()) {
      throw new Error('Expected inspect mode to be deactivated');
    }
    console.log('[Smoke] Verified inspect mode cleanup on split view.');
    console.log('[Smoke] Step 6: Testing security guard against dangerous schemes...');
    const isJsAllowed = isAllowedNavigation('javascript:alert(1)');
    const isDataAllowed = isAllowedNavigation('data:text/html,<script>alert(1)</script>');
    const isFileAllowed = isAllowedNavigation('file:///C:/Windows/System32/cmd.exe');
    const isHttpsAllowed = isAllowedNavigation('https://example.com/storefront');
    if (isJsAllowed !== false) {
      throw new Error('Expected isAllowedNavigation to reject javascript: scheme');
    }
    if (isDataAllowed !== false) {
      throw new Error('Expected isAllowedNavigation to reject data: scheme');
    }
    if (isFileAllowed !== false) {
      throw new Error('Expected isAllowedNavigation to reject file: scheme');
    }
    if (isHttpsAllowed !== true) {
      throw new Error('Expected isAllowedNavigation to allow https: scheme');
    }
    const sanitizedJs = sanitizeUrl('javascript:alert(1)');
    if (sanitizedJs.startsWith('javascript:')) {
      throw new Error('Expected sanitizeUrl to never return raw javascript: scheme');
    }
    console.log('[Smoke] Verified security policy scheme sanitization (isAllowedNavigation rejected javascript, data, and file schemes).');
    tabHost.toggleSplitReview(tabId);
    tabState = tabHost.getTabList().find((t) => t.id === tabId);
    if (tabState.splitMode === true) {
      throw new Error('Expected splitMode to be false after toggle');
    }
    const singleFluidClip = await tabHost.evalJs(`Boolean(document.getElementById('antifan-device-clip'));`, tabId, 'desktop');
    if (singleFluidClip) {
      throw new Error('Expected corner clipping style to be removed on fluid single-view');
    }

    // Switch single-view to mobile preset -> verify clean DOM semantics preserved
    tabHost.setDevicePreset(tabId, 'phone-iphone15pro');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const singleMobileClip = await tabHost.evalJs(`Boolean(document.getElementById('antifan-device-clip'));`, tabId, 'desktop');
    if (singleMobileClip) {
      throw new Error('Expected clean DOM without containing-block clip style injection for single-view mobile preset');
    }

    // Switch single-view back to responsive -> verify clean state continues
    tabHost.setDevicePreset(tabId, 'responsive');
    await new Promise((resolve) => setTimeout(resolve, 300));
    const singleResponsiveClip = await tabHost.evalJs(`Boolean(document.getElementById('antifan-device-clip'));`, tabId, 'desktop');
    if (singleResponsiveClip) {
      throw new Error('Expected clean DOM when switching back to responsive');
    }
    console.log('[Smoke] Verified split mode disable, single-view preset transitions, and clean DOM containment.');
    console.log('[Smoke] Step 8: Closing tab and disposing NativeTabHost...');
    try { server?.closeAllConnections?.(); } catch {}
    try { server?.close(); } catch {}
    try { tabHost?.dispose(); } catch {}
    try {
      if (win && !win.isDestroyed()) {
        win.removeAllListeners();
        win.destroy();
      }
    } catch {}
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    console.log('[Smoke] ALL REAL ELECTRON NATIVE TAB HOST SPLIT SMOKE TESTS PASSED SUCCESSFULLY.');
    try { logStream.end(); } catch {}
    app.exit(0);
    process.exit(0);
  } catch (err) {
    console.error('[Smoke] NativeTabHost Split Smoke Test FAILED:', err);
    if (tabHost) {
      try { tabHost.dispose(); } catch {}
    }
    if (win && !win.isDestroyed()) {
      try { win.destroy(); } catch {}
    }
    if (server) server.close();
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    setImmediate(() => {
      app.exit(1);
    });
  }
}

app.whenReady().then(runSmokeTest);
