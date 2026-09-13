/**
 * Standalone Mobile Renderer & Visual Proof Capturer
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-mobile-proof-'));
app.setPath('userData', tempUserData);

const MOBILE_URL = 'http://127.0.0.1:3300/mobile/index.html';
const OUTPUT_IMAGE = path.resolve(__dirname, '../plans/reports/mobile-proof-390x844.png');

const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';

app.whenReady().then(async () => {
  console.log('[MobileProof] Creating 390x844 window...');
  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      backgroundThrottling: false,
    }
  });

  win.webContents.setUserAgent(MOBILE_UA);

  try {
    console.log(`[MobileProof] Loading ${MOBILE_URL}...`);
    await win.loadURL(MOBILE_URL, {
      userAgent: MOBILE_UA,
      extraHeaders: 'sec-ch-ua-mobile: ?1\n'
    });

    // Wait 2s for layout and dynamic components to settle
    await new Promise(r => setTimeout(r, 2000));

    // Inspect layout
    const info = await win.webContents.executeJavaScript(`(() => {
      const doc = document;
      return {
        title: doc.title,
        deviceAttr: doc.body.getAttribute('data-device'),
        scrollWidth: doc.documentElement.scrollWidth,
        clientWidth: doc.documentElement.clientWidth,
        scrollHeight: doc.documentElement.scrollHeight,
        hasMobileHeader: !!doc.querySelector('.header-mobile'),
        hasDrawer: !!doc.querySelector('.category-navigation__block'),
        hasDock: !!doc.querySelector('.bottom-navigation'),
        dockStyle: doc.querySelector('.bottom-navigation') ? {
          position: getComputedStyle(doc.querySelector('.bottom-navigation')).position,
          bottom: getComputedStyle(doc.querySelector('.bottom-navigation')).bottom,
          display: getComputedStyle(doc.querySelector('.bottom-navigation')).display,
        } : null,
        brokenImages: Array.from(doc.images).filter(i => i.naturalWidth === 0).length,
        totalImages: doc.images.length
      };
    })()`);
    console.log('[MobileProof] Mobile Surface DOM Info:', JSON.stringify(info, null, 2));

    // Capture screenshot
    fs.mkdirSync(path.dirname(OUTPUT_IMAGE), { recursive: true });
    const image = await win.capturePage();
    fs.writeFileSync(OUTPUT_IMAGE, image.toPNG());
    console.log(`[MobileProof] Screenshot captured successfully: ${OUTPUT_IMAGE} (${image.toPNG().length} bytes)`);

  } catch (err) {
    console.error('[MobileProof] Error:', err);
    process.exitCode = 1;
  } finally {
    win.destroy();
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
    app.quit();
  }
});
