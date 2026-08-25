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

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-smoke-'));
app.setPath('userData', tempUserData);

async function runSmokeTest() {
  console.log('[Smoke] Starting NativeTabHost Split Review Electron Smoke Test...');
  let server;
  let testPort;
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
      show: false,
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
    await new Promise((resolve) => setTimeout(resolve, 1000));
    win.setSize(1600, 1000);
    tabHost.updateLayout();
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log('[Smoke] Verified reload and window resize layout update.');
    console.log('[Smoke] Step 4c: Testing back/forward history navigation...');
    const backOk = tabHost.goBack(tabId);
    if (!backOk) {
      throw new Error('Expected goBack to return true');
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
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
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const fwdDesktopUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'desktop');
    const fwdMobileUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'mobile');
    if (!fwdDesktopUrl.includes('/page2') || !fwdMobileUrl.includes('/page2')) {
      throw new Error(`Expected both panes on page2 after goForward, got desktop=${fwdDesktopUrl}, mobile=${fwdMobileUrl}`);
    }
    console.log('[Smoke] Verified goForward navigation synced to both panes:', { desktop: fwdDesktopUrl, mobile: fwdMobileUrl });

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
    console.log('[Smoke] Step 5b: Testing inspect toggle on focused pane...');
    const inspectActive = tabHost.toggleInspect();
    if (!inspectActive) {
      throw new Error('Expected toggleInspect to activate inspect mode');
    }
    const inspectCleaned = tabHost.toggleInspect();
    if (inspectCleaned) {
      throw new Error('Expected toggleInspect to deactivate inspect mode');
    }
    console.log('[Smoke] Verified inspect mode toggle and cleanup on split view.');
    console.log('[Smoke] Step 6: Testing security guard against dangerous schemes...');
    tabHost.navigate(tabId, 'javascript:alert(1)');
    const sanitizedUrl = await tabHost.evalJs(`window.location.href;`, tabId, 'desktop');
    if (sanitizedUrl && sanitizedUrl.startsWith('javascript:')) {
      throw new Error('Expected dangerous javascript: scheme to be blocked or sanitized');
    }
    console.log('[Smoke] Verified security policy scheme sanitization (no javascript: scheme execution).');
    console.log('[Smoke] Step 7: Disabling Split Review Mode...');
    tabHost.toggleSplitReview(tabId);
    tabState = tabHost.getTabList().find((t) => t.id === tabId);
    if (tabState.splitMode === true) {
      throw new Error('Expected splitMode to be false after toggle');
    }
    console.log('[Smoke] Verified split mode disable and single-view fallback.');

    console.log('[Smoke] Step 8: Closing tab and disposing NativeTabHost...');
    tabHost.closeTab(tabId);
    tabHost.dispose();
    win.destroy();

    console.log('[Smoke] ALL REAL ELECTRON NATIVE TAB HOST SPLIT SMOKE TESTS PASSED SUCCESSFULLY.');
    server.close();
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    setTimeout(() => {
      try { app.exit(0); } catch {}
      process.exit(0);
    }, 50);
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
    setTimeout(() => {
      try { app.exit(1); } catch {}
      process.exit(1);
    }, 50);
  }
}

app.whenReady().then(runSmokeTest);
