/**
 * Live Chromium Mutation QA Smoke Runner under Electron Runtime
 * Exercises MutationQAHarness via BrowserControlPort & CapabilityCatalogue across Desktop, Tablet, and Mobile viewports
 */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { BrowserControlPort } = require('../.compiled/src/main/tools/browser-control-port');
const { registerBrowserCapabilities } = require('../.compiled/src/main/tools/browser-capabilities');
const { CapabilityCatalogue } = require('../.compiled/src/main/tools/capability-catalogue');
const { ArtifactStore } = require('../.compiled/src/main/tools/artifact-store');
const { MutationQAHarness } = require('../packages/site-clone/dist/qa/mutation-qa-harness.js');
const { CleanTabProtocol } = require('../packages/site-clone/dist/qa/clean-tab-protocol.js');

// Prevent premature Electron quit when disposable preview tabs are closed
app.on('window-all-closed', (e) => {
  e.preventDefault();
});

// Realistic mock storefront HTML template with responsive grid and navigation controls
const STOREFRONT_HTML = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock Storefront - Mutation Stress Test</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; overflow-x: hidden; }
    .site-header { display: flex; align-items: center; justify-content: space-between; padding: 16px 24px; background: #ffffff; border-bottom: 1px solid #e2e8f0; }
    .site-header .logo { height: 36px; }
    .site-header .header-title { font-size: 20px; font-weight: 700; overflow-wrap: break-word; word-break: break-word; }
    .main-nav ul { display: flex; gap: 20px; list-style: none; }
    .main-nav a { text-decoration: none; color: #334155; font-weight: 500; }
    .container { max-width: 1280px; margin: 0 auto; padding: 32px 16px; position: relative; }
    .product-grid { display: flex; flex-wrap: wrap; gap: 20px; }
    .product-card {
      flex: 1 1 calc(25% - 20px);
      min-width: 220px;
      max-width: 320px;
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .product-card img {
      width: 100%;
      height: 220px;
      object-fit: cover;
      border-radius: 6px;
      background: #f1f5f9;
    }
    .product-card .title {
      font-size: 16px;
      font-weight: 600;
      margin: 12px 0 8px;
      line-height: 1.4;
      overflow-wrap: break-word;
      word-break: break-word;
    }
    .product-card .price-row {
      margin-top: auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-top: 8px;
    }
    .product-card .price {
      font-size: 16px;
      font-weight: 700;
      color: #e11d48;
    }
    .slider-nav { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }
    .swiper-button-prev, .swiper-button-next {
      padding: 6px 12px;
      background: #e2e8f0;
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }
    /* Graceful navigation hide and max-width clamping for single card */
    .has-single-card .slider-nav { display: none !important; }
    .has-single-card .product-card { max-width: 380px !important; }
    @media (max-width: 1024px) {
      .product-card { flex: 1 1 calc(50% - 20px); }
    }
    @media (max-width: 640px) {
      .product-card { flex: 1 1 100%; max-width: 100%; }
    }
  </style>
</head>
<body>
  <header class="site-header">
    <img class="logo" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='36'><rect width='100%' height='100%' fill='%230284c7'/><text x='50%' y='50%' fill='white' dominant-baseline='middle' text-anchor='middle'>LOGO</text></svg>" alt="Logo" />
    <h1 class="header-title">Cửa Hàng Trực Tuyến Chính Hãng</h1>
    <nav class="main-nav">
      <ul>
        <li class="nav-item"><a href="/">Trang chủ</a></li>
        <li class="nav-item"><a href="/products">Sản phẩm</a></li>
      </ul>
    </nav>
  </header>
  <main class="container">
    <div class="product-grid">
      <div class="product-card" data-antifan-product="1">
        <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300' width='300' height='300'><rect width='100%' height='100%' fill='%23cbd5e1'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'>Sản phẩm 1</text></svg>" alt="Sản phẩm 1" />
        <h3 class="title">Áo sơ mi nam công sở cao cấp</h3>
        <div class="price-row">
          <span class="price">450.000₫</span>
          <button class="buy-btn">Mua ngay</button>
        </div>
      </div>
      <div class="product-card" data-antifan-product="2">
        <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300' width='300' height='300'><rect width='100%' height='100%' fill='%23cbd5e1'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'>Sản phẩm 2</text></svg>" alt="Sản phẩm 2" />
        <h3 class="title">Quần tây nam phong cách Hàn Quốc</h3>
        <div class="price-row">
          <span class="price">550.000₫</span>
          <button class="buy-btn">Mua ngay</button>
        </div>
      </div>
      <div class="product-card" data-antifan-product="3">
        <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300' width='300' height='300'><rect width='100%' height='100%' fill='%23cbd5e1'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'>Sản phẩm 3</text></svg>" alt="Sản phẩm 3" />
        <h3 class="title">Áo khoác gió thể thao chống nước</h3>
        <div class="price-row">
          <span class="price">390.000₫</span>
          <button class="buy-btn">Mua ngay</button>
        </div>
      </div>
      <div class="product-card" data-antifan-product="4">
        <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 300 300' width='300' height='300'><rect width='100%' height='100%' fill='%23cbd5e1'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle'>Sản phẩm 4</text></svg>" alt="Sản phẩm 4" />
        <h3 class="title">Giày da oxford thủ công</h3>
        <div class="price-row">
          <span class="price">1.250.000₫</span>
          <button class="buy-btn">Mua ngay</button>
        </div>
      </div>
    </div>
    <div class="slider-nav">
      <button class="swiper-button-prev">←</button>
      <button class="swiper-button-next">→</button>
    </div>
  </main>
</body>
</html>`;

const VIEWPORTS = [
  { name: 'Desktop', width: 1440, height: 900 },
  { name: 'Tablet', width: 768, height: 1024 },
  { name: 'Mobile', width: 390, height: 844 },
];

const SCENARIOS = [
  'text_stretch',
  'cardinality_1',
  'cardinality_11',
  'image_ratio_tall',
  'image_ratio_wide',
];

app.whenReady().then(async () => {
  let server;
  let activeHtml = STOREFRONT_HTML;
  const liveWindows = new Map(); // tabId -> BrowserWindow
  let nextTabId = 1;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mutation-smoke-'));

  const cleanup = () => {
    try {
      for (const [id, win] of liveWindows.entries()) {
        try {
          if (!win.isDestroyed()) win.destroy();
        } catch (_) {}
      }
      liveWindows.clear();
      if (server) {
        server.close();
      }
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (_) {}
  };

  try {
    console.log('[Smoke Mutation QA] Starting Live Chromium Evaluation Suite...');

    // 1. Setup local HTTP fixture server
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(activeHtml);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/`;

    // 2. Initialize BrowserControlPort and CapabilityCatalogue
    const artifactStore = new ArtifactStore({ root: tmpDir });
    let activeTabId = null;

    const browserHost = {
      getTabList: () => Array.from(liveWindows.keys()).map((id) => ({ id })),
      getActiveTabId: () => activeTabId,
      createTab: (url, activate = true) => {
        const id = `tab-${nextTabId++}`;
        const win = new BrowserWindow({
          width: 1440,
          height: 900,
          useContentSize: true,
          show: false,
          webPreferences: { nodeIntegration: false, contextIsolation: true },
        });
        liveWindows.set(id, win);
        if (activate) activeTabId = id;
        return id;
      },
      closeTab: (tabId) => {
        const win = liveWindows.get(tabId);
        if (win) {
          if (!win.isDestroyed()) win.destroy();
          liveWindows.delete(tabId);
          if (activeTabId === tabId) {
            activeTabId = liveWindows.keys().next().value || null;
          }
          return true;
        }
        return false;
      },
      switchTab: (tabId) => {
        if (liveWindows.has(tabId)) {
          activeTabId = tabId;
          return true;
        }
        return false;
      },
      navigate: async (tabId, url) => {
        const win = liveWindows.get(tabId || activeTabId);
        if (!win) return false;
        await win.loadURL(url);
        return true;
      },
      evalJs: async (expr, tabId) => {
        const win = liveWindows.get(tabId || activeTabId);
        if (!win) throw new Error(`Tab not found: ${tabId || activeTabId}`);
        return win.webContents.executeJavaScript(expr);
      },
      setViewportSize: ({ width, height, tabId }) => {
        const win = liveWindows.get(tabId || activeTabId);
        if (!win) return false;
        win.setContentSize(width, height);
        return true;
      },
      isCurrentTarget: () => true,
      getDocumentGeneration: () => 1,
    };

    const controlPort = new BrowserControlPort(browserHost, artifactStore);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: 'p1',
      workspaceId: 'w1',
      runtimeId: 'r1',
      allowEval: true,
    });
    registerBrowserCapabilities(catalogue, controlPort);

    const makeInvocationContext = (tabId, grant = 'eval') => ({
      attachmentId: `att-${Date.now()}`,
      runId: 'run-mut-smoke',
      attemptId: 'att-mut-smoke',
      projectId: 'p1',
      workspaceId: 'w1',
      backendId: 'b1',
      hostEpoch: 1,
      invocationId: `inv-${Date.now()}`,
      lease: {
        runtimeId: 'r1',
        projectId: 'p1',
        workspaceId: 'w1',
        token: 'tok',
        protocolVersion: 1,
        hostEpoch: 1,
        ownerPid: process.pid,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
      leaseToken: 'tok',
      browserTarget: {
        projectId: 'p1',
        workspaceId: 'w1',
        runtimeId: 'r1',
        tabId,
        browserEpoch: 1,
        documentGeneration: 1,
      },
      grant,
    });

    // 3. CleanTabProtocol restoration failure injection
    console.log('[Smoke Mutation QA] 1. Testing CleanTabProtocol restoration failure injection...');
    const dummyTabId = browserHost.createTab(baseUrl, false, { ephemeral: true });
    activeHtml = STOREFRONT_HTML;
    await catalogue.dispatch('browser.navigate', { url: baseUrl }, makeInvocationContext(dummyTabId));

    let actionCompleted = false;
    const failureInjectionEvaluator = async (expr) => {
      if (actionCompleted && expr.includes('window.scrollTo')) {
        throw new Error('Injected Simulated Restoration Crash');
      }
      return catalogue.dispatch('browser.eval', { expression: expr }, makeInvocationContext(dummyTabId));
    };

    const reversibleResult = await CleanTabProtocol.withReversibleState(
      failureInjectionEvaluator,
      async () => {
        actionCompleted = true;
        return 'executed_probe_action';
      }
    );

    assert.strictEqual(reversibleResult.success, true, 'Probe action itself must succeed');
    assert.strictEqual(reversibleResult.restored, false, 'Restored must truthfully report false upon restoration failure');
    assert.ok(reversibleResult.error?.includes('Injected Simulated Restoration Crash'), 'Must capture restoration error details');
    browserHost.closeTab(dummyTabId);
    console.log('[Smoke Mutation QA] -> CleanTabProtocol truthfully caught restoration failure: PASS');

    // 4. Iterate Viewports and Mutation Scenarios via CapabilityCatalogue
    for (const vp of VIEWPORTS) {
      console.log(`\n[Smoke Mutation QA] Testing Viewport: ${vp.name} (${vp.width}x${vp.height})...`);

      // Create base tab for viewport
      const baseTabId = browserHost.createTab(baseUrl);
      browserHost.setViewportSize({ width: vp.width, height: vp.height, tabId: baseTabId });
      activeHtml = STOREFRONT_HTML;
      await catalogue.dispatch('browser.navigate', { url: baseUrl }, makeInvocationContext(baseTabId));

      // Measure baseline
      const baseScript = MutationQAHarness.buildChromiumEvaluationScript('text_stretch');
      const baselineMeasurement = await catalogue.dispatch(
        'browser.eval',
        { expression: baseScript },
        makeInvocationContext(baseTabId)
      );

      assert.strictEqual(baselineMeasurement.targetFound, true, 'Baseline must find product cards');
      assert.strictEqual(baselineMeasurement.imageFound, true, 'Baseline must find valid image');
      assert.strictEqual(baselineMeasurement.imageLoaded, true, 'Baseline image must be loaded');
      assert.strictEqual(baselineMeasurement.priceFound, true, 'Baseline must find price element');
      assert.strictEqual(baselineMeasurement.priceValid, true, 'Baseline price must be valid');
      assert.ok(baselineMeasurement.cardHeight > 0, 'Baseline card height must be > 0');
      assert.ok(
        baselineMeasurement.overflowDeltaX <= 2,
        `Baseline ${vp.name} must have 0 horizontal overflow (got ${baselineMeasurement.overflowDeltaX}px)`
      );

      console.log(
        `  [Baseline] Cards: ${baselineMeasurement.cardCount}, Card height: ${baselineMeasurement.cardHeight}px, Overflow: ${baselineMeasurement.overflowDeltaX}px`
      );

      // Execute all 5 Mutation Scenarios
      for (const scenario of SCENARIOS) {
        let mutantHtml = MutationQAHarness.generateMutantHtml(STOREFRONT_HTML, scenario);

        // For cardinality_1, add helper class so CSS hides slider arrows gracefully and clamps width
        if (scenario === 'cardinality_1') {
          mutantHtml = mutantHtml.replace('class="container"', 'class="container has-single-card"');
        }

        // Dedicated disposable preview tab guarantees zero DOM pollution across scenarios
        const mutantTabId = browserHost.createTab(baseUrl, false, { ephemeral: true });
        browserHost.setViewportSize({ width: vp.width, height: vp.height, tabId: mutantTabId });

        try {
          activeHtml = mutantHtml;
          await catalogue.dispatch('browser.navigate', { url: baseUrl }, makeInvocationContext(mutantTabId));

          const evalScript = MutationQAHarness.buildChromiumEvaluationScript(scenario);
          const mutantMeasurement = await catalogue.dispatch(
            'browser.eval',
            { expression: evalScript },
            makeInvocationContext(mutantTabId)
          );

          // Evaluate measurement against scenario contracts & baseline
          const result = MutationQAHarness.evaluateMeasurement(scenario, mutantMeasurement, baselineMeasurement);

          if (!result.passed) {
            console.error(`  FAIL [${scenario}]:`, result.failureReasons);
          }

          assert.strictEqual(
            result.passed,
            true,
            `Scenario ${scenario} on ${vp.name} failed: ${result.failureReasons.join('; ')}`
          );
          assert.strictEqual(
            result.hardBlockerTriggered,
            false,
            `Scenario ${scenario} on ${vp.name} triggered hard blocker: ${result.failureReasons.join('; ')}`
          );
          assert.ok(
            mutantMeasurement.overflowDeltaX <= 2,
            `Scenario ${scenario} on ${vp.name} leaked horizontal overflow: ${mutantMeasurement.overflowDeltaX}px`
          );

          console.log(
            `  PASS [${scenario}] - deltaX: ${mutantMeasurement.overflowDeltaX}px, cards: ${mutantMeasurement.cardCount}`
          );
        } finally {
          // Guaranteed tab closure immediately after scenario run
          browserHost.closeTab(mutantTabId);
        }
      }

      // Close base tab for viewport
      browserHost.closeTab(baseTabId);
    }

    // 5. Post-mutation fresh baseline verification (assert zero persistent DOM pollution)
    console.log('\n[Smoke Mutation QA] 5. Verifying fresh post-mutation baseline...');
    const freshTabId = browserHost.createTab(baseUrl);
    activeHtml = STOREFRONT_HTML;
    await catalogue.dispatch('browser.navigate', { url: baseUrl }, makeInvocationContext(freshTabId));

    const postBaseScript = MutationQAHarness.buildChromiumEvaluationScript('text_stretch');
    const freshMeasurement = await catalogue.dispatch(
      'browser.eval',
      { expression: postBaseScript },
      makeInvocationContext(freshTabId)
    );

    assert.strictEqual(freshMeasurement.targetFound, true, 'Fresh baseline must find product cards');
    assert.ok(freshMeasurement.cardHeight > 0, 'Fresh baseline card height must be > 0');
    assert.ok(
      freshMeasurement.overflowDeltaX <= 2,
      `Fresh baseline must have zero overflow leak (got ${freshMeasurement.overflowDeltaX}px)`
    );
    browserHost.closeTab(freshTabId);
    console.log('[Smoke Mutation QA] -> Fresh baseline check: PASS (zero DOM pollution across runs)');

    console.log('\n=========================================================');
    console.log('[Smoke Mutation QA] ALL LIVE CHROMIUM TESTS PASSED (0 leaks, 0 blockers)!');
    console.log('=========================================================');

    cleanup();
    app.exit(0);
  } catch (err) {
    console.error('[Smoke Mutation QA Error]', err);
    cleanup();
    app.exit(1);
  }
});
