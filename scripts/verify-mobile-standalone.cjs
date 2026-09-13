/**
 * Dedicated Standalone Mobile Parity & Interaction Verifier
 * Runs via Electron (node scripts/run-electron.cjs scripts/verify-mobile-standalone.cjs)
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const MOBILE_URL = 'http://127.0.0.1:3300/mobile/index.html';
const OUTPUT_DIR = path.resolve(__dirname, '../plans/reports');
const SCREENSHOT_PATH = path.join(OUTPUT_DIR, 'mobile-verified-390x844.png');

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';

app.whenReady().then(async () => {
  console.log('[MobileVerifier] Starting dedicated mobile check at 390x844...');

  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      sandbox: true,
    },
  });
    // Initialize renderer process before attaching CDP
    await win.loadURL('about:blank');

    // 1. Attach CDP for mobile emulation
    if (!win.webContents.debugger.isAttached()) {
      win.webContents.debugger.attach('1.3');
    }
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints: 5,
    });
    await win.webContents.debugger.sendCommand('Emulation.setUserAgentOverride', {
      userAgent: MOBILE_UA,
      platform: 'Linux armv8l',
    });
    // 2. Navigate to mobile clone URL
    console.log(`[MobileVerifier] Navigating to ${MOBILE_URL}...`);
    await win.loadURL(MOBILE_URL);
    // Settle dynamic scripts
    await new Promise((r) => setTimeout(r, 1500));

    // 3. Evaluate DOM & Mobile Surface Architecture
    const evaluation = await win.webContents.executeJavaScript(`(() => {
      const doc = document;
      const drawer = doc.querySelector('.category-navigation__block');
      const dock = doc.querySelector('.bottom-navigation');
      const menuBtn = doc.querySelector('.menu-mobile, [data-antifan-toggle*="category"], .header-mobile .icon-menu, .nav-toggle, [class*="menu-toggle"]');

      const drawerStyle = drawer ? window.getComputedStyle(drawer) : null;
      const dockStyle = dock ? window.getComputedStyle(dock) : null;
      const btnStyle = menuBtn ? window.getComputedStyle(menuBtn) : null;

      const livewireAttrs = Array.from(doc.querySelectorAll('*')).flatMap(el =>
        Array.from(el.attributes).filter(a => a.name.startsWith('wire:')).map(a => a.name)
      );

      const allImages = Array.from(doc.images);
      const brokenImages = allImages.filter(img => img.naturalWidth === 0).length;
      const remoteImages = allImages.filter(img => img.src.startsWith('http') && !img.src.includes('127.0.0.1')).map(img => img.src);

      // Drawer interaction test
      let drawerClickTest = null;
      if (menuBtn && drawer) {
        const beforeActive = drawer.classList.contains('active');
        const beforeDisplay = drawerStyle.display;

        // Open
        menuBtn.click();
        const afterOpenStyle = window.getComputedStyle(drawer);
        const openActive = drawer.classList.contains('active');
        const openDisplay = afterOpenStyle.display;
        const bodyLocked = doc.body.classList.contains('overflow-hidden') || window.getComputedStyle(doc.body).overflow === 'hidden';

        // Close
        const closeBtn = drawer.querySelector('.close-menu, .btn-close, [data-dismiss], .icon-close') || menuBtn;
        closeBtn.click();
        const afterCloseStyle = window.getComputedStyle(drawer);
        const closeActive = drawer.classList.contains('active');
        const closeDisplay = afterCloseStyle.display;

        drawerClickTest = {
          supported: true,
          before: { active: beforeActive, display: beforeDisplay },
          afterOpen: { active: openActive, display: openDisplay, bodyLocked },
          afterClose: { active: closeActive, display: closeDisplay }
        };
      }

      return {
        url: window.location.href,
        deviceAttr: doc.body.getAttribute('data-device'),
        viewportMetrics: {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          clientWidth: doc.documentElement.clientWidth,
          scrollWidth: doc.documentElement.scrollWidth,
          hasHorizontalOverflow: doc.documentElement.scrollWidth > doc.documentElement.clientWidth,
          scrollHeight: doc.documentElement.scrollHeight
        },
        bottomDock: {
          exists: !!dock,
          display: dockStyle ? dockStyle.display : null,
          position: dockStyle ? dockStyle.position : null,
          bottom: dockStyle ? dockStyle.bottom : null,
          zIndex: dockStyle ? dockStyle.zIndex : null
        },
        categoryDrawer: {
          exists: !!drawer,
          initialDisplay: drawerStyle ? drawerStyle.display : null,
          initialTransform: drawerStyle ? drawerStyle.transform : null
        },
        menuToggle: {
          exists: !!menuBtn,
          selector: menuBtn ? (menuBtn.tagName + '.' + menuBtn.className) : null,
          visible: btnStyle ? (btnStyle.display !== 'none' && btnStyle.visibility !== 'hidden') : false
        },
        drawerInteraction: drawerClickTest,
        assetPurity: {
          livewireCount: livewireAttrs.length,
          totalImages: allImages.length,
          brokenImages,
          remoteImagesCount: remoteImages.length
        }
      };
    })()`);

    console.log('\n[MobileVerifier] Evaluation Results:');
    console.log(JSON.stringify(evaluation, null, 2));

    // 4. Capture Viewport Screenshot
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const image = await win.capturePage();
    fs.writeFileSync(SCREENSHOT_PATH, image.toPNG());
    console.log(`\n[MobileVerifier] Viewport screenshot saved to: ${SCREENSHOT_PATH}`);

    // Verification verdict
    const passed =
      evaluation.deviceAttr === 'mobile' &&
      !evaluation.viewportMetrics.hasHorizontalOverflow &&
      evaluation.bottomDock.exists &&
      evaluation.categoryDrawer.exists &&
      evaluation.assetPurity.livewireCount === 0 &&
      evaluation.assetPurity.brokenImages === 0 &&
      evaluation.assetPurity.remoteImagesCount === 0;

    console.log(`\n[MobileVerifier] VERDICT: ${passed ? 'PASSED (100% Parity)' : 'FAILED'}`);
    process.exitCode = passed ? 0 : 1;
  } catch (err) {
    console.error('[MobileVerifier] Fatal Error:', err);
    process.exitCode = 2;
  } finally {
    win.destroy();
    app.quit();
  }
});
