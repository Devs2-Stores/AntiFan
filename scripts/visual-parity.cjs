#!/usr/bin/env node
/**
 * AntiFan visual parity gate.
 *
 * Renders a reference URL and a clone URL in twin offscreen surfaces, walks both
 * documents in viewport bands, and reports the share of differing pixels plus the
 * document height delta. Occluded browser-window tabs produce no compositor frame,
 * so parity measurement needs surfaces of its own instead of the visible tab strip.
 *
 * Usage:
 *   electron scripts/visual-parity.cjs --live <url> --clone <url> \
 *     [--viewports 1440x900,1024x768,390x844] [--mobile 390x844] \
 *     [--threshold 0.02] [--channel-tolerance 16] [--bands N] [--out <dir>]
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const BOOT_LOG = 'E:/tmp-parity-boot.log';
const boot = (msg) => {
  try {
    fs.appendFileSync(BOOT_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
process.on('uncaughtException', (error) => {
  boot(`UNCAUGHT ${error && error.stack}`);
  console.error('[parity] uncaught:', error);
});
process.on('unhandledRejection', (error) => {
  boot(`UNHANDLED ${error && (error.stack || String(error))}`);
  console.error('[parity] unhandled:', error);
});
boot('requires-loaded');

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

function parseArgs(argv) {
  const out = { viewports: '1440x900,1024x768,390x844', mobile: '390x844', threshold: '0.02', 'channel-tolerance': '16', out: 'plans/reports/visual-parity' };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const env = (key) => {
  const value = process.env[`PARITY_${key.toUpperCase().replace(/-/g, '_')}`];
  return value === undefined || value === '' ? undefined : value;
};
const config = {
  live: env('live') || args.live,
  clone: env('clone') || args.clone,
  viewports: env('viewports') || args.viewports,
  mobile: env('mobile') || args.mobile,
  threshold: env('threshold') || args.threshold,
  channelTolerance: env('channel-tolerance') || args['channel-tolerance'],
  bands: env('bands') || args.bands,
  out: env('out') || args.out,
};
boot(`config=${JSON.stringify(config)}`);
const LIVE_URL = config.live;
const CLONE_URL = config.clone;
if (!LIVE_URL || !CLONE_URL) {
  console.error('usage: electron scripts/visual-parity.cjs --live <url> --clone <url> [--viewports 1440x900,...] [--mobile 390x844] [--threshold 0.02] [--bands N] [--out dir]');
  console.error('   or: PARITY_LIVE=<url> PARITY_CLONE=<url> [PARITY_VIEWPORTS=...] [PARITY_OUT=...] electron scripts/visual-parity.cjs');
  process.exit(2);
}
const THRESHOLD = Number(config.threshold);
const CHANNEL_TOLERANCE = Number(config.channelTolerance);
const MAX_BANDS = config.bands ? Number(config.bands) : 0;
const OUT_DIR = path.resolve(config.out);
const MOBILE_SPEC = config.mobile;
const VIEWPORTS = String(config.viewports)
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [w, h] = entry.split('x').map(Number);
    return { width: w, height: h, mobile: `${w}x${h}` === MOBILE_SPEC };
  });

const surfaces = [];
const openWindows = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openSurface(url, viewport, label) {
  const win = new BrowserWindow({
    width: viewport.width,
    height: viewport.height,
    show: false,
    webPreferences: {
      offscreen: true,
      sandbox: false,
      contextIsolation: false,
      backgroundThrottling: false,
      images: true,
      webSecurity: false,
    },
  });
  openWindows.add(win);
  win.webContents.setUserAgent(viewport.mobile ? MOBILE_UA : DESKTOP_UA);
  const wc = win.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const loaded = new Promise((resolve) => {
    const done = () => resolve();
    wc.once('did-finish-load', done);
    wc.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) console.error(`[surface] ${label} main frame load failed: ${code} ${desc}`);
      if (isMainFrame) resolve();
    });
  });
  wc.loadURL(url).catch((error) => console.error(`[surface] ${label} load error:`, error.message));
  await Promise.race([loaded, sleep(60000)]);
  await sleep(1500);
  boot(`surface-loaded ${label}`);
  return { label, url, viewport, win, wc };
}

// A debugger left attached across an aborted navigation keeps a dead target, so every
// command re-attaches once before failing.
async function withRetry(surface, work, what) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      if (!surface.wc.debugger.isAttached()) surface.wc.debugger.attach('1.3');
      return await work();
    } catch (error) {
      lastError = error;
      boot(`retry ${what} ${surface.label} attempt=${attempt} error=${error.message}`);
      try { surface.wc.debugger.detach(); } catch {}
      await sleep(500);
    }
  }
  throw new Error(`${what} failed for ${surface.label}: ${lastError && lastError.message}`);
}

async function evaluate(surface, expression) {
  const result = await withRetry(surface, () => surface.wc.debugger.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }), 'evaluate');
  if (result && result.exceptionDetails) {
    throw new Error(`${surface.label} evaluate failed: ${result.exceptionDetails.text}`);
  }
  return result ? result.result.value : undefined;
}

const FREEZE_SCRIPT = `(() => {
  const id = '__antifan_parity_freeze';
  if (!document.getElementById(id)) {
    const style = document.createElement('style');
    style.id = id;
    style.textContent = '*,*::before,*::after{animation-play-state:paused !important;animation-delay:0s !important;transition:none !important;caret-color:transparent !important}html,body{scroll-behavior:auto !important}html{scrollbar-width:none !important}video,iframe,embed,object{visibility:hidden !important;}::-webkit-scrollbar{width:0 !important;height:0 !important;display:none !important}';
    (document.head || document.documentElement).appendChild(style);
  }
  document.querySelectorAll('video,audio').forEach((media) => {
    try { media.pause(); media.currentTime = 0; media.autoplay = false; } catch {}
  });
  // Auto-opened interstitials (promo modals, exit popups) cover one surface only, so they
  // are normalized away on both sides instead of being scored as layout difference.
  const viewportArea = window.innerWidth * window.innerHeight;
  let overlayIndex = 0;
  document.querySelectorAll('body *').forEach((node) => {
    const style = getComputedStyle(node);
    if (style.position !== 'fixed' && style.position !== 'sticky') return;
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) return;
    const zIndex = Number(style.zIndex);
    if (!Number.isFinite(zIndex) || zIndex < 50) return;
    const rect = node.getBoundingClientRect();
    const covered = Math.max(0, rect.width) * Math.max(0, rect.height);
    if (covered < viewportArea * 0.2) return;
    overlayIndex += 1;
    node.setAttribute('data-antifan-parity-overlay', String(overlayIndex));
    node.style.setProperty('display', 'none', 'important');
  });
  return { overlays: overlayIndex };
})()`;

async function materialize(surface) {
  await evaluate(surface, FREEZE_SCRIPT);
  boot(`materialize-start ${surface.label}`);
  const height = await evaluate(surface, `(() => {
    const doc = document.documentElement;
    const body = document.body;
    return Math.max(doc ? doc.scrollHeight : 0, body ? body.scrollHeight : 0, window.innerHeight);
  })()`);
  const resolved = Number(height) || surface.viewport.height;
  boot(`materialize-done ${surface.label} height=${resolved}`);
  return resolved;
}

async function scrollTo(surface, y) {
  const target = Math.round(y);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const landed = await evaluate(surface, `(() => {
      document.documentElement.style.setProperty('scroll-behavior', 'auto', 'important');
      document.body.style.setProperty('scroll-behavior', 'auto', 'important');
      window.scrollTo({ top: ${target}, left: 0, behavior: 'instant' });
      return Math.round(window.scrollY);
    })()`);
    if (Math.abs(Number(landed) - target) <= 1) {
      await sleep(150);
      return Number(landed);
    }
    await sleep(200);
  }
  throw new Error(`scroll did not settle for ${surface.label} target=${target}`);
}

async function capture(surface) {
  const shot = await withRetry(surface, () => surface.wc.debugger.sendCommand('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  }), 'capture');
  return Buffer.from(shot.data || '', 'base64');
}

const DIFF_PAGE = `<!doctype html><html><body><script>
window.__diff = async (aUrl, bUrl, tolerance) => {
  const load = (src) => new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed: ' + src));
    img.src = src;
  });
  const [a, b] = await Promise.all([load(aUrl), load(bUrl)]);
  const w = Math.min(a.naturalWidth, b.naturalWidth);
  const h = Math.min(a.naturalHeight, b.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(a, 0, 0, w, h);
  const pa = ctx.getImageData(0, 0, w, h).data;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(b, 0, 0, w, h);
  const pb = ctx.getImageData(0, 0, w, h).data;

  // Sub-pixel scroll alignment: two surfaces rarely sit on the identical device pixel, and
  // an unaligned edge reads as a total mismatch. The scan finds the best shift first.
  const scan = (dx, dy) => {
    let count = 0;
    let total = 0;
    let sum = 0;
    const yStart = Math.max(0, dy);
    const yEnd = Math.min(h, h + dy);
    const xStart = Math.max(0, dx);
    const xEnd = Math.min(w, w + dx);
    for (let y = yStart; y < yEnd; y += 1) {
      const rowA = y * w;
      const rowB = (y - dy) * w;
      for (let x = xStart; x < xEnd; x += 1) {
        const ia = (rowA + x) * 4;
        const ib = (rowB + x - dx) * 4;
        const aOpaque = pa[ia + 3] > 8;
        const bOpaque = pb[ib + 3] > 8;
        total += 1;
        if (aOpaque !== bOpaque) { count += 1; sum += 255; continue; }
        if (!aOpaque) continue;
        const delta = Math.max(Math.abs(pa[ia] - pb[ib]), Math.abs(pa[ia + 1] - pb[ib + 1]), Math.abs(pa[ia + 2] - pb[ib + 2]));
        sum += delta;
        if (delta > tolerance) count += 1;
      }
    }
    return { count, total, mean: total ? sum / total : 0 };
  };

  let bestShift = { dx: 0, dy: 0, ratio: Infinity, mean: 0 };
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const probe = scan(dx, dy);
      const ratio = probe.total ? probe.count / probe.total : 1;
      if (ratio < bestShift.ratio) bestShift = { dx, dy, ratio, mean: probe.mean };
    }
  }

  const best = scan(bestShift.dx, bestShift.dy);
  const levels = [16, 24, 32, 48, 64, 96];
  const sweep = {};
  levels.forEach((level) => { sweep[level] = 0; });
  {
    const dy = bestShift.dy;
    const dx = bestShift.dx;
    const yStart = Math.max(0, dy);
    const yEnd = Math.min(h, h + dy);
    const xStart = Math.max(0, dx);
    const xEnd = Math.min(w, w + dx);
    for (let y = yStart; y < yEnd; y += 1) {
      const rowA = y * w;
      const rowB = (y - dy) * w;
      for (let x = xStart; x < xEnd; x += 1) {
        const ia = (rowA + x) * 4;
        const ib = (rowB + x - dx) * 4;
        const aOpaque = pa[ia + 3] > 8;
        const bOpaque = pb[ib + 3] > 8;
        let delta = 255;
        if (aOpaque === bOpaque && aOpaque) {
          delta = Math.max(Math.abs(pa[ia] - pb[ib]), Math.abs(pa[ia + 1] - pb[ib + 1]), Math.abs(pa[ia + 2] - pb[ib + 2]));
        } else if (aOpaque === bOpaque && !aOpaque) {
          delta = 0;
        }
        levels.forEach((level) => { if (delta > level) sweep[level] += 1; });
      }
    }
  }
  const mask = document.createElement('canvas');
  mask.width = w;
  mask.height = h;
  const mctx = mask.getContext('2d');
  const image = mctx.createImageData(w, h);
  {
    const dy = bestShift.dy;
    const dx = bestShift.dx;
    const yStart = Math.max(0, dy);
    const yEnd = Math.min(h, h + dy);
    const xStart = Math.max(0, dx);
    const xEnd = Math.min(w, w + dx);
    for (let y = yStart; y < yEnd; y += 1) {
      const rowA = y * w;
      const rowB = (y - dy) * w;
      for (let x = xStart; x < xEnd; x += 1) {
        const ia = (rowA + x) * 4;
        const ib = (rowB + x - dx) * 4;
        const aOpaque = pa[ia + 3] > 8;
        const bOpaque = pb[ib + 3] > 8;
        let delta = 255;
        if (aOpaque === bOpaque && aOpaque) {
          delta = Math.max(Math.abs(pa[ia] - pb[ib]), Math.abs(pa[ia + 1] - pb[ib + 1]), Math.abs(pa[ia + 2] - pb[ib + 2]));
        } else if (aOpaque === bOpaque && !aOpaque) {
          delta = 0;
        }
        const mi = (y * w + x) * 4;
        if (delta > tolerance) {
          image.data[mi] = 255;
          image.data[mi + 1] = 0;
          image.data[mi + 2] = 0;
          image.data[mi + 3] = 255;
        } else {
          image.data[mi] = 255;
          image.data[mi + 1] = 255;
          image.data[mi + 2] = 255;
          image.data[mi + 3] = 40;
        }
      }
    }
  }
  mctx.putImageData(image, 0, 0);
  const maskDataUrl = mask.toDataURL('image/png');

  return {
    maskDataUrl,
    width: Math.min(w, w + bestShift.dx) - Math.max(0, bestShift.dx),
    height: Math.min(h, h + bestShift.dy) - Math.max(0, bestShift.dy),
    total: best.total,
    diff: best.count,
    meanDelta: best.mean,
    sweep,
    shift: { dx: bestShift.dx, dy: bestShift.dy },
    zeroShiftRatio: 0,
    aSize: [a.naturalWidth, a.naturalHeight],
    bSize: [b.naturalWidth, b.naturalHeight],
  };
};
<\/script></body></html>`;

async function openDiffer() {
  const win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: false, webSecurity: false, backgroundThrottling: false },
  });
  openWindows.add(win);
  const wc = win.webContents;
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  const differPath = path.join(OUT_DIR, "__visual-diff.html");
  fs.writeFileSync(differPath, DIFF_PAGE);
  await Promise.race([wc.loadFile(differPath), sleep(10000)]);
  await sleep(300);
  boot('differ-ready');
  return { win, wc };
}

async function diffImages(differ, aPath, bPath) {
  const aUrl = pathToFileURL(aPath).href;
  const bUrl = pathToFileURL(bPath).href;
  const result = await differ.wc.debugger.sendCommand('Runtime.evaluate', {
    expression: `window.__diff(${JSON.stringify(aUrl)}, ${JSON.stringify(bUrl)}, ${CHANNEL_TOLERANCE})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result && result.exceptionDetails) {
    const detail = result.exceptionDetails;
    const why = (detail.exception && (detail.exception.description || detail.exception.value)) || detail.text || "unknown";
    throw new Error(`diff failed: ${why}`);
  }
  return result.result.value;
}

async function runViewport(viewport, differ) {
  const slug = `${viewport.width}x${viewport.height}${viewport.mobile ? '-mobile' : ''}`;
  console.log(`\n[parity] viewport ${slug}`);
  const live = await openSurface(LIVE_URL, viewport, `live:${slug}`);
  const clone = await openSurface(CLONE_URL, viewport, `clone:${slug}`);
  const liveHeight = await materialize(live);
  const cloneHeight = await materialize(clone);
  const comparedHeight = Math.min(liveHeight, cloneHeight);
  let bandCount = Math.max(1, Math.ceil(comparedHeight / viewport.height));
  if (MAX_BANDS > 0) bandCount = Math.min(bandCount, MAX_BANDS);
  console.log(`[parity]   heights live=${liveHeight} clone=${cloneHeight} bands=${bandCount}`);
  let totalPixels = 0;
  let totalDiff = 0;
  const bandDir = path.join(OUT_DIR, slug);
  fs.mkdirSync(bandDir, { recursive: true });
  for (let band = 0; band < bandCount; band += 1) {
    const y = Math.min(band * viewport.height, Math.max(0, comparedHeight - viewport.height));
    await scrollTo(live, y);
    await scrollTo(clone, y);
    const livePng = await capture(live);
    const clonePng = await capture(clone);
    const livePath = path.join(bandDir, `band-${String(band).padStart(2, '0')}-live.png`);
    const clonePath = path.join(bandDir, `band-${String(band).padStart(2, '0')}-clone.png`);
    fs.writeFileSync(livePath, livePng);
    fs.writeFileSync(clonePath, clonePng);
    const stat = await diffImages(differ, livePath, clonePath);
    if (stat && stat.maskDataUrl) {
      const maskPath = path.join(bandDir, `band-${String(band).padStart(2, '0')}-mask.png`);
      fs.writeFileSync(maskPath, Buffer.from(String(stat.maskDataUrl).split(',')[1] || '', 'base64'));
      delete stat.maskDataUrl;
    }
    boot(`band-captured ${band}`);
    totalPixels += stat.total;
    totalDiff += stat.diff;
    const pct = stat.total ? (stat.diff / stat.total) * 100 : 0;
    const sweepText = Object.entries(stat.sweep || {}).map(([k, v]) => `>${k}:${((v / stat.total) * 100).toFixed(1)}%`).join(' ');
    console.log(`[parity]   band ${band + 1}/${bandCount} y=${y} diff=${pct.toFixed(2)}% meanDelta=${(stat.meanDelta || 0).toFixed(2)} shift=${JSON.stringify(stat.shift)} sweep ${sweepText}`);
  }
  const ratio = totalPixels ? totalDiff / totalPixels : 1;
  const record = {
    viewport: slug,
    width: viewport.width,
    height: viewport.height,
    mobile: Boolean(viewport.mobile),
    liveHeight,
    cloneHeight,
    heightDeltaRatio: liveHeight ? Math.abs(liveHeight - cloneHeight) / liveHeight : 1,
    bands: bandCount,
    totalPixels,
    diffPixels: totalDiff,
    mismatchPercentage: ratio * 100,
    thresholdPercentage: THRESHOLD * 100,
    pass: ratio <= THRESHOLD,
  };
  for (const surface of [live, clone]) {
    try {
      if (surface.wc.debugger.isAttached()) surface.wc.debugger.detach();
    } catch {}
    try {
      if (!surface.win.isDestroyed()) surface.win.destroy();
    } catch {}
    openWindows.delete(surface.win);
  }
  return record;
}

app.whenReady().then(async () => {
  session.defaultSession.setUserAgent(DESKTOP_UA);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const differ = await openDiffer();
  boot('ready');
  const records = [];
  for (const viewport of VIEWPORTS) {
    try {
      records.push(await runViewport(viewport, differ));
    } catch (error) {
      console.error(`[parity] viewport ${viewport.width}x${viewport.height} failed: ${error.message}`);
      records.push({
        viewport: `${viewport.width}x${viewport.height}${viewport.mobile ? '-mobile' : ''}`,
        width: viewport.width,
        height: viewport.height,
        mobile: Boolean(viewport.mobile),
        error: error.message,
        pass: false,
      });
    }
  }
  const summary = {
    live: LIVE_URL,
    clone: CLONE_URL,
    thresholdPercentage: THRESHOLD * 100,
    channelTolerance: CHANNEL_TOLERANCE,
    generatedAt: new Date().toISOString(),
    viewports: records,
    pass: records.every((entry) => entry.pass === true),
  };
  const summaryPath = path.join(OUT_DIR, 'visual-parity-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log('\n[parity] ===== summary =====');
  for (const entry of records) {
    const line = entry.error
      ? `${entry.viewport}: ERROR ${entry.error}`
      : `${entry.viewport}: mismatch ${entry.mismatchPercentage.toFixed(3)}% (threshold ${summary.thresholdPercentage}%) height ${entry.liveHeight} vs ${entry.cloneHeight} bands ${entry.bands} => ${entry.pass ? 'PASS' : 'FAIL'}`;
    console.log(`[parity] ${line}`);
  }
  console.log(`[parity] summary: ${summaryPath}`);
  console.log(`[parity] VERDICT: ${summary.pass ? 'PASS' : 'FAIL'}`);
  for (const win of openWindows) {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {}
  }
  app.exit(summary.pass ? 0 : 1);
}).catch((error) => {
  console.error('[parity] fatal:', error);
  app.exit(2);
});
