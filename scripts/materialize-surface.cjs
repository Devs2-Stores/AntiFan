/**
 * AntiFan Core Dual-Surface Headless Materializer
 * 
 * Generic, platform-agnostic headless browser automation that:
 * 1. Emulates desktop (1440x900) or mobile (390x844) with appropriate user-agent and client hints via CDP.
 * 2. Navigates in an isolated, hidden, non-throttled window with isolated userData.
 * 3. Executes a multi-pass, thorough scroll walk with dwell times to trigger all
 *    IntersectionObservers, lazy image decodes, and reactive AJAX (Livewire/SSR) component hydration.
 * 4. Verifies complete replacement of skeleton placeholders before dumping the settled DOM.
 * 5. Generates capture receipt (<outputPath>.capture.json) with sha256, settlement, and telemetry metrics.
 * 6. Fails closed on unsettled capture with no success writes.
 * 
 * Usage:
 *   node scripts/run-electron.cjs scripts/materialize-surface.cjs <url> <outputPath> <device>
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { HTML_AUTOCLOSE_NORMALIZER_SOURCE } = require('../packages/site-clone/dist/index.js');

app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
const targetUrl = process.env.MATERIALIZE_TARGET_URL || process.argv[2] || 'https://hoplongtech.com/';
const outputPath = process.env.MATERIALIZE_OUTPUT_PATH || process.argv[3] || path.resolve(__dirname, '../clone/hoplongtech/raw-desktop.html');
const device = (process.env.MATERIALIZE_DEVICE || process.argv[4] || 'desktop').toLowerCase();
const minExpectedHeight = parseInt(process.env.MATERIALIZE_MIN_HEIGHT || '100', 10);
const minExpectedBytes = parseInt(process.env.MATERIALIZE_MIN_BYTES || '200', 10);

const isMobile = device === 'mobile';
const viewportWidth = isMobile ? 390 : 1440;
const viewportHeight = isMobile ? 844 : 900;
const scaleFactor = isMobile ? 3 : 1;

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Mobile; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.114 Mobile Safari/537.36';
const userAgent = isMobile ? MOBILE_UA : DESKTOP_UA;
const extraHeaders = isMobile ? 'sec-ch-ua-mobile: ?1\n' : 'sec-ch-ua-mobile: ?0\n';

// Isolated userData directory
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), `antifan-materialize-${device}-${Date.now()}-`));
app.setPath('userData', tempUserData);

app.whenReady().then(async () => {
  console.log(`\n[Core Dual-Surface Materializer] Initializing worker: device=${device} (${viewportWidth}x${viewportHeight}) for ${targetUrl}...`);

  const win = new BrowserWindow({
    width: viewportWidth,
    height: viewportHeight,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      backgroundThrottling: false,
    }
  });

  win.webContents.setBackgroundThrottling(false);
  win.webContents.setUserAgent(userAgent);
  if (typeof win.webContents.setZoomFactor === 'function') {
    win.webContents.setZoomFactor(1);
  }

  const startTime = Date.now();

  try {
    // Configure the actual device before source scripts choose their layout.
    // setDeviceMetricsOverride requires a committed renderer: applying it to a
    // target that never loaded a document kills the Chromium process outright
    // (observed as an abrupt non-zero worker exit), so commit a blank document
    // first and apply the override before the real navigation begins.
    try {
      if (!win.webContents.debugger.isAttached()) {
        win.webContents.debugger.attach('1.3');
      }
      await win.loadURL('about:blank');
      await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: viewportWidth,
        height: viewportHeight,
        deviceScaleFactor: scaleFactor,
        mobile: isMobile,
      });
      if (isMobile) {
        await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 5,
        });
      }
    } catch (cdpErr) {
      throw new Error(`Device emulation failed: ${cdpErr.message}`);
    }
    console.log(`[Core Dual-Surface Materializer] Loading ${targetUrl} [device: ${device}]...`);
    await win.loadURL(targetUrl, {
      userAgent,
      extraHeaders
    });

    console.log('[Core Dual-Surface Materializer] Page loaded. Initiating thorough multi-pass materialization walk...');

    // Allow initial client scripts and hydration hooks to initialize
    await new Promise(r => setTimeout(r, 2500));

    const result = await win.webContents.executeJavaScript(`(async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const step = 250;
      const dwell = 140;

      // Track mutations to verify content hydration activity
      let mutationCount = 0;
      let lastMutationTime = Date.now();
      const observer = new MutationObserver((mutations) => {
        mutationCount += mutations.length;
        lastMutationTime = Date.now();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });

      // Eagerize any lazy images encountered
      document.querySelectorAll('img[loading="lazy"]').forEach(img => {
        try { img.loading = 'eager'; } catch {}
      });

      // Pass 1: Comprehensive top-to-bottom scroll walk
      let passesCount = 1;
      let height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      for (let y = 0; y <= height; y += step) {
        window.scrollTo(0, y);
        await sleep(dwell);
        height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      }

      // Dwell at bottom to allow deep-layer AJAX / Livewire component hydration
      window.scrollTo(0, height);
      await sleep(2500);

      // Pass 2: Secondary pass to capture any sections appended during bottom dwell
      const newHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      if (newHeight > height) {
        passesCount++;
        for (let y = height; y <= newHeight; y += step) {
          window.scrollTo(0, y);
          await sleep(dwell);
        }
        window.scrollTo(0, newHeight);
        await sleep(2500);
      }

      // Pass 3: Return to top with step dwell to hydrate sticky & top sections
      passesCount++;
      const returnStep = 500;
      const currentScrollY = window.scrollY || window.pageYOffset || 0;
      for (let y = currentScrollY; y >= 0; y -= returnStep) {
        window.scrollTo(0, y);
        await sleep(80);
      }
      window.scrollTo(0, 0);
      await sleep(800);

      // Trigger image decode for all images currently in DOM
      const images = Array.from(document.querySelectorAll('img'));
      const imageDecodePromises = images.map(async (img) => {
        if (!img.src && (img.dataset.src || img.getAttribute('data-src'))) {
          img.src = img.dataset.src || img.getAttribute('data-src');
        }
        if (img.complete) {
          if (typeof img.decode === 'function') {
            try { await img.decode(); } catch {}
          }
          return img.naturalWidth > 0;
        }
        return new Promise((resolve) => {
          const timeout = setTimeout(() => resolve(false), 3000);
          const finish = async () => {
            clearTimeout(timeout);
            if (typeof img.decode === 'function') {
              try { await img.decode(); } catch {}
            }
            resolve(img.naturalWidth > 0);
          };
          img.addEventListener('load', finish, { once: true });
          img.addEventListener('error', () => { clearTimeout(timeout); resolve(false); }, { once: true });
        });
      });
      const decodedStatuses = await Promise.all(imageDecodePromises);
      const imagesLoaded = decodedStatuses.filter(Boolean).length;

      // Bounded stability convergence check (height & content stability)
      let stableRounds = 0;
      let lastHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      let lastHtmlLength = document.documentElement.outerHTML.length;
      const maxStabilityRounds = 8;
      for (let r = 0; r < maxStabilityRounds; r++) {
        await sleep(350);
        const curHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
        const curHtmlLength = document.documentElement.outerHTML.length;
        const quietDuration = Date.now() - lastMutationTime;

        if (curHeight === lastHeight && Math.abs(curHtmlLength - lastHtmlLength) < 100 && quietDuration >= 350) {
          stableRounds++;
          if (stableRounds >= 2) break;
        } else {
          stableRounds = 0;
        }
        lastHeight = curHeight;
        lastHtmlLength = curHtmlLength;
      }

      observer.disconnect();

      // Detect actual loading placeholders (NOT arbitrary SVG dimensions)
      const placeholderSelectors = [
        '.skeleton',
        '.skeleton-loading',
        '.loading-skeleton',
        '.card-skeleton',
        '.product-skeleton',
        '.shimmer',
        '.placeholder-loading',
        '.loading-placeholder',
        '.lazy-placeholder',
        '[data-placeholder="true"]',
        '[data-skeleton="true"]',
        'svg.loading',
        'svg.skeleton',
        'svg[class*="skeleton"]',
        'svg[class*="loading"]',
        '[aria-busy="true"]'
      ];

      const activeSkeletons = [];
      for (const sel of placeholderSelectors) {
        try {
          document.querySelectorAll(sel).forEach(el => {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                activeSkeletons.push({
                  selector: sel,
                  tag: el.tagName,
                  className: el.className
                });
              }
            }
          });
        } catch {}
      }

      // Also check wire:loading / wire:placeholder via attribute check without selector colon issues
      try {
        document.querySelectorAll('*').forEach(el => {
          if (el.hasAttribute('wire:loading') || el.hasAttribute('wire:placeholder')) {
            const style = window.getComputedStyle(el);
            if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
              const rect = el.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                activeSkeletons.push({
                  selector: 'wire:loading/placeholder',
                  tag: el.tagName,
                  className: el.className
                });
              }
            }
          }
        });
      } catch {}

      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const productCards = document.querySelectorAll('.product-list__item, .product-item, .card-item, .product-card');

      // The markup is re-parsed by every downstream consumer, so the serialized tree
      // must survive the HTML tree builder's auto-closing rules (see Core
      // html-parse-fidelity). Runs immediately before serialization.
      ${HTML_AUTOCLOSE_NORMALIZER_SOURCE}
      const autocloseRewrites = normalizeHtmlAutoclose(document.documentElement);

      // Slider libraries (Swiper, Slick, Splide) write the geometry they measured for
      // this viewport into inline styles on the track and its slides. The sanitizer
      // must drop those numbers -- they freeze one viewport -- and can only re-express
      // them relative to the track if it knows the captured ratio. Layout exists only
      // here, so measure it now: per-view slot count plus the design gap between slots.
      let slidersAnnotated = 0;
      try {
        const TRACK_CLASS_TOKENS = ['swiper-wrapper', 'slick-track', 'splide__list', 's-content'];
        // Token match without regex: this block is an escaped template literal, where
        // \s inside a pattern literal is silently collapsed to s.
        const hasTrackToken = (value) => TRACK_CLASS_TOKENS.some((token) => (' ' + value + ' ').includes(' ' + token + ' '));
        for (const track of document.querySelectorAll('*')) {
          const className = typeof track.className === 'string' ? track.className : '';
          if (!className || !hasTrackToken(className)) continue;
          const slides = Array.from(track.children).filter((child) => child.offsetWidth > 0);
          if (slides.length < 2) continue;
          const slideWidth = slides[0].offsetWidth;
          const gap = Math.max(0, slides[1].offsetLeft - slides[0].offsetLeft - slideWidth);
          const trackWidth = track.clientWidth || track.offsetWidth;
          if (!slideWidth || !trackWidth) continue;
          const ratio = (trackWidth + gap) / (slideWidth + gap);
          track.setAttribute('data-antifan-slider', JSON.stringify({
            perView: Math.max(1, Math.round(ratio)),
            fractional: Math.abs(ratio - Math.round(ratio)) > 0.15,
            gap: Math.round(gap),
            slide: slideWidth,
            track: trackWidth,
          }));
          slidersAnnotated++;
        }
      } catch {}

      const html = document.documentElement.outerHTML;
      const htmlBytes = (new TextEncoder().encode(html)).length;

      // Settlement evaluation
      let passed = true;
      let reason = 'Settled with height stability, image decodes, and 0 active placeholders';

      if (totalHeight < ${minExpectedHeight}) {
        passed = false;
        reason = 'Unsettled: total height ' + totalHeight + 'px is below minimum expected threshold (${minExpectedHeight}px)';
      } else if (htmlBytes < ${minExpectedBytes}) {
        passed = false;
        reason = 'Unsettled: html bytes ' + htmlBytes + ' is below minimum expected document size (${minExpectedBytes} bytes)';
      } else if (stableRounds < 2) {
        passed = false;
        reason = 'Unsettled: document did not converge within the stability window';
      } else if (images.some((img, index) => !decodedStatuses[index] && img.getClientRects().length > 0 && (img.currentSrc || img.getAttribute('src')))) {
        passed = false;
        reason = 'Unsettled: visible image resources failed to load or decode';
      } else if (activeSkeletons.length > 0) {
        passed = false;
        reason = 'Unsettled: ' + activeSkeletons.length + ' active skeleton placeholder(s) still present';
      }

      return {
        observedWidth: window.innerWidth,
        observedHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio || 1,
        totalHeight,
        skeletonsRemaining: activeSkeletons.length,
        productCardsCount: productCards.length,
        imagesCount: images.length,
        imagesLoaded,
        htmlBytes,
        mutationsCount: mutationCount,
        passesCount,
        autocloseRewrites,
        slidersAnnotated,
        settlement: {
          passed,
          reason
        },
        html
      };
    })()`);

    console.log('[Core Dual-Surface Materializer] Materialization telemetry:', {
      device,
      observedViewport: `${result.observedWidth}x${result.observedHeight}`,
      totalHeight: result.totalHeight,
      skeletonsRemaining: result.skeletonsRemaining,
      productCardsCount: result.productCardsCount,
      imagesCount: result.imagesCount,
      imagesLoaded: result.imagesLoaded,
      htmlBytes: result.htmlBytes,
      mutationsCount: result.mutationsCount,
      autocloseRewrites: result.autocloseRewrites,
      slidersAnnotated: result.slidersAnnotated,
      settlement: result.settlement
    });

    if (!result.settlement.passed) {
      console.error(`[Core Dual-Surface Materializer] Capture failed settlement: ${result.settlement.reason}`);
      process.exitCode = 1;
      return;
    }

    const sha256 = crypto.createHash('sha256').update(result.html, 'utf8').digest('hex');
    if (result.observedWidth !== viewportWidth || result.observedHeight !== viewportHeight) {
      throw new Error(`Capture viewport mismatch: ${result.observedWidth}x${result.observedHeight}`);
    }
    const captureReceipt = {
      schemaVersion: 1,
      url: targetUrl,
      observedUrl: win.webContents.getURL(),
      userAgent,
      requestHeaders: { 'sec-ch-ua-mobile': isMobile ? '?1' : '?0' },
      devicePixelRatio: result.devicePixelRatio,
      device,
      width: result.observedWidth,
      height: result.observedHeight,
      capturedAt: new Date().toISOString(),
      sha256,
      settlement: {
        passed: true,
        reason: result.settlement.reason
      },
      metrics: {
        totalHeight: result.totalHeight,
        skeletonsRemaining: result.skeletonsRemaining,
        productCardsCount: result.productCardsCount,
        imagesCount: result.imagesCount,
        imagesLoaded: result.imagesLoaded,
        htmlBytes: result.htmlBytes,
        mutationsCount: result.mutationsCount,
        passesCount: result.passesCount,
        slidersAnnotated: result.slidersAnnotated,
        durationMs: Date.now() - startTime
      }
    };

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, result.html, 'utf8');
    const receiptPath = `${outputPath}.capture.json`;
    fs.writeFileSync(receiptPath, JSON.stringify(captureReceipt, null, 2), 'utf8');

    console.log(`[Core Dual-Surface Materializer] Successfully exported materialized DOM to ${outputPath} (receipt: ${receiptPath}, sha256: ${sha256})`);
    process.exitCode = 0;

  } catch (err) {
    console.error('[Core Dual-Surface Materializer] Error:', err);
    process.exitCode = 1;
  } finally {
    try {
      if (win.webContents.debugger.isAttached()) {
        win.webContents.debugger.detach();
      }
    } catch {}
    try { win.destroy(); } catch {}
    try {
      if (fs.existsSync(tempUserData)) {
        fs.rmSync(tempUserData, { recursive: true, force: true });
      }
    } catch {}
    app.quit();
    setTimeout(() => {
      process.exit(process.exitCode !== undefined ? process.exitCode : 1);
    }, 500);
  }
});
