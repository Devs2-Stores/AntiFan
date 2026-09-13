/**
 * AntiFan Core Mobile Surface Materializer
 * 
 * Generic, headless browser automation that:
 * 1. Emulates a real mobile client (viewport 390x844, Android Mobile UA, sec-ch-ua-mobile: ?1).
 * 2. Navigates to any target URL in a completely hidden offscreen window (show: false, 0 tab-steal).
 * 3. Performs a step-by-step scroll walk to trigger all IntersectionObservers and lazy AJAX hydration.
 * 4. Waits for asynchronous network requests (Livewire/SSR/REST) to replace skeleton placeholders with authentic DOM nodes.
 * 5. Dumps the fully materialized, unhydrated-free DOM directly to a target workspace file.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');

const targetUrl = process.argv[2] || 'https://hoplongtech.com/';
const outputPath = process.argv[3] || path.resolve(__dirname, '../clone/hoplongtech/raw-mobile.html');

app.whenReady().then(async () => {
  console.log(`[Core Mobile Materializer] Initializing headless mobile worker for ${targetUrl}...`);
  
  const win = new BrowserWindow({
    width: 390,
    height: 844,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false
    }
  });

  const mobileUA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';
  win.webContents.setUserAgent(mobileUA);

  try {
    console.log('[Core Mobile Materializer] Loading target URL with mobile client hints...');
    await win.loadURL(targetUrl, {
      userAgent: mobileUA,
      extraHeaders: 'sec-ch-ua-mobile: ?1\n'
    });

    console.log('[Core Mobile Materializer] Page loaded. Executing materialization scroll walk...');
    
    // Allow initial DOM scripts to execute
    await new Promise(r => setTimeout(r, 2000));

    const result = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const step = 250;
      const dwell = 120;

      // Eagerize lazy images
      document.querySelectorAll('img[loading="lazy"]').forEach(img => {
        try { img.loading = 'eager'; } catch {}
      });
      // Multi-pass progressive scroll walk to trigger all IntersectionObservers
      let height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = 0; y <= height; y += step) {
        window.scrollTo(0, y);
        await sleep(dwell);
        height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      }
      window.scrollTo(0, height);
      await sleep(2500);

      // Pass 2: ensure any newly appended bottom sections are also scrolled into view
      const newHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      if (newHeight > height) {
        for (let y = height; y <= newHeight; y += step) {
          window.scrollTo(0, y);
          await sleep(dwell);
        }
        window.scrollTo(0, newHeight);
        await sleep(2500);
      }

      // Return to top smoothly
      window.scrollTo(0, 0);
      await sleep(500);
      const skeletons = document.querySelectorAll('svg[viewBox*="428"], svg.loading');
      const productCards = document.querySelectorAll('.product-list__item, .product-item, .card-item');

      return {
        finalHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        skeletonsRemaining: skeletons.length,
        productCardsCount: productCards.length,
        html: document.documentElement.outerHTML
      };
    })()`);

    console.log('[Core Mobile Materializer] Materialization telemetry:', {
      finalHeight: result.finalHeight,
      skeletonsRemaining: result.skeletonsRemaining,
      productCardsCount: result.productCardsCount,
      htmlBytes: result.html.length
    });

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, result.html, 'utf8');
    console.log(`[Core Mobile Materializer] Successfully exported materialized mobile DOM to ${outputPath}`);

  } catch (err) {
    console.error('[Core Mobile Materializer] Failed:', err);
    process.exitCode = 1;
  } finally {
    try { win.destroy(); } catch {}
    app.quit();
  }
});
