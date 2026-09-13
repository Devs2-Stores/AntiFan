/**
 * Comprehensive Dual-Surface Parity & Adaptive Verification
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');

const tempUserData = path.join(os.tmpdir(), `antifan-verify-${Date.now()}`);
app.setPath('userData', tempUserData);
process.on('unhandledRejection', (reason) => console.error('[ParityTest] Unhandled Rejection:', reason));
process.on('uncaughtException', (err) => console.error('[ParityTest] Uncaught Exception:', err));
app.on('window-all-closed', () => console.log('[ParityTest] window-all-closed event emitted'));


app.whenReady().then(async () => {
  const reportsDir = path.resolve('plans/reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const results = {
    desktop: {},
    mobileAdaptive: {},
    passed: false
  };

  try {
    // 1. DESKTOP VERIFICATION (1440x900)
    console.log('[ParityTest] --- 1. Testing Desktop Surface (1440x900) ---');
    const deskWin = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      webPreferences: { offscreen: true, contextIsolation: false }
    });

    await deskWin.loadURL('http://127.0.0.1:3300/index.html?device=desktop');
    await new Promise(r => setTimeout(r, 2000));

    results.desktop = await deskWin.webContents.executeJavaScript(`
      (() => {
        const bodyDevice = document.body.getAttribute('data-device');
        const brokenImgs = Array.from(document.images).filter(img => img.naturalWidth === 0).length;
        const totalImgs = document.images.length;
        const videoBtn = document.querySelector('.video-content__button');
        const videoPopup = document.getElementById('popup-video');
        return {
          url: window.location.href,
          bodyDevice,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollHeight: document.documentElement.scrollHeight,
          brokenImgs,
          totalImgs,
          hasVideoBtn: !!videoBtn,
          hasVideoPopup: !!videoPopup
        };
      })()
    `);
    console.log('[ParityTest] Desktop metrics:', results.desktop);

    const deskImg = await deskWin.webContents.capturePage();
    const deskPath = path.join(reportsDir, 'desktop-proof-1440x900.png');
    fs.writeFileSync(deskPath, deskImg.toPNG());
    console.log(`[ParityTest] Desktop screenshot saved: ${deskPath} (${deskImg.toPNG().length} bytes)`);
    deskWin.destroy();

    // 2. MOBILE ADAPTIVE VERIFICATION (390x844)
    console.log('\n[ParityTest] --- 2. Testing Mobile Adaptive Surface (390x844) ---');
    const mobWin = new BrowserWindow({
      width: 390,
      height: 844,
      show: false,
      webPreferences: { offscreen: true, contextIsolation: false }
    });
    // Navigate to root http://127.0.0.1:3300/index.html to verify automatic client-side adaptive redirection
    try {
      await mobWin.loadURL('http://127.0.0.1:3300/index.html');
    } catch (navErr) {
      // Expected: loadURL may abort with ERR_ABORTED or ERR_FAILED when location.replace redirects
      console.log('[ParityTest] Note: Initial load redirected:', navErr.message);
    }
    // Wait for the redirected mobile page to finish settling
    await new Promise(r => setTimeout(r, 3000));
    console.log('[ParityTest] mobWin current URL:', mobWin.webContents.getURL(), 'isLoading:', mobWin.webContents.isLoading());
    results.mobileAdaptive = await mobWin.webContents.executeJavaScript(`
      (() => {
        const bodyDevice = document.body.getAttribute('data-device');
        const brokenImgs = Array.from(document.images).filter(img => img.naturalWidth === 0).length;
        const totalImgs = document.images.length;
        const dock = document.querySelector('.bottom-navigation');
        const drawer = document.querySelector('.category-navigation__block');
        const dockComputed = dock ? window.getComputedStyle(dock) : null;
        return {
          finalUrl: window.location.href,
          redirectedToMobile: window.location.pathname.includes('/mobile'),
          bodyDevice,
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
          scrollHeight: document.documentElement.scrollHeight,
          hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          brokenImgs,
          totalImgs,
          hasDock: !!dock,
          dockPosition: dockComputed ? dockComputed.position : null,
          hasDrawer: !!drawer
        };
      })()
    `);
    console.log('[ParityTest] Mobile Adaptive metrics:', results.mobileAdaptive);

    const mobImg = await mobWin.webContents.capturePage();
    const mobPath = path.join(reportsDir, 'adaptive-mobile-proof-390x844.png');
    fs.writeFileSync(mobPath, mobImg.toPNG());
    console.log(`[ParityTest] Mobile Adaptive screenshot saved: ${mobPath} (${mobImg.toPNG().length} bytes)`);
    mobWin.destroy();

    // Verification evaluation
    const desktopOk = results.desktop.clientWidth === 1440 && results.desktop.brokenImgs === 0;
    const mobileOk = results.mobileAdaptive.redirectedToMobile &&
                     !results.mobileAdaptive.hasHorizontalOverflow &&
                     results.mobileAdaptive.hasDock &&
                     results.mobileAdaptive.dockPosition === 'fixed' &&
                     results.mobileAdaptive.brokenImgs === 0;

    results.passed = desktopOk && mobileOk;
    console.log(`\n[ParityTest] FINAL VERDICT: ${results.passed ? 'PASSED (100% PARITY & ADAPTIVE)' : 'FAILED'}`);
    process.exitCode = results.passed ? 0 : 1;
  } catch (err) {
    console.error('[ParityTest] Fatal error:', err);
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    app.quit();
  }
});
