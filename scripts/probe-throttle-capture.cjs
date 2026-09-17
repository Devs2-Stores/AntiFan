/**
 * Throwaway diagnostic probe #2: does a background (covered, throttled)
 * WebContentsView settle CDP Page.captureScreenshot, and does lifting
 * background throttling make it settle? Mirrors the app's tab webPreferences
 * (backgroundThrottling default) and background-tab device emulation.
 */
'use strict';
const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-throttle-probe-'));
app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('no-sandbox');

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><style>
  body { margin:0; font: 16px sans-serif; background:#123; color:#fff }
  .spin { width:120px;height:120px;background:#e33; animation: spin 2s linear infinite; }
  @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
  .tall { height: 3000px }
</style></head><body><h1>THROTTLE PROBE</h1><div class="spin"></div><div class="tall"></div></body></html>`)}`;

function withTimeout(p, ms) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]);
}

async function cdpShot(wc, label, bound = 8000) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
  } catch (e) {
    return { label, ok: false, ms: 0, err: `attach: ${e.message}` };
  }
  const t0 = Date.now();
  const res = await withTimeout(
    wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }).catch((e) => ({ __err: e.message })),
    bound
  );
  const ms = Date.now() - t0;
  if (res === null) return { label, ok: false, ms, err: `TIMEOUT(${bound}ms)` };
  if (res.__err) return { label, ok: false, ms, err: String(res.__err).slice(0, 100) };
  return { label, ok: true, ms, bytes: res.data ? res.data.length : 0 };
}

async function pageShot(wc, label, bound = 8000) {
  const t0 = Date.now();
  const img = await withTimeout(wc.capturePage().catch(() => null), bound);
  const ms = Date.now() - t0;
  if (!img) return { label, ok: false, ms, err: `TIMEOUT(${bound}ms)` };
  const size = img.getSize();
  return { label, ok: !img.isEmpty(), ms, bytes: img.toPNG().length, size: `${size.width}x${size.height}` };
}

app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, backgroundColor: '#000' });

  // Throttled background view: backgroundThrottling left at the Electron default,
  // exactly like a user-opened tab in the app.
  const throttled = new WebContentsView();
  const top = new WebContentsView();
  win.contentView.addChildView(throttled, 0);
  win.contentView.addChildView(top, 1);
  throttled.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  top.setBounds({ x: 0, y: 0, width: 1440, height: 900 });

  await throttled.webContents.loadURL(PAGE);
  await top.webContents.loadURL(PAGE);
  await new Promise((r) => setTimeout(r, 1500));

  results.push(await cdpShot(throttled.webContents, 'P1 throttled covered-view CDP capture'));
  results.push(await pageShot(throttled.webContents, 'P2 throttled covered-view capturePage'));

  // Device emulation, mirroring a background tab's requested viewport.
  try {
    throttled.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width: 1440, height: 900 },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: 1,
      viewSize: { width: 1440, height: 900 },
    });
    results.push({ label: 'P3 enableDeviceEmulation applied', ok: true });
  } catch (e) {
    results.push({ label: 'P3 enableDeviceEmulation applied', ok: false, err: String(e.message).slice(0, 100) });
  }
  try {
    if (!throttled.webContents.debugger.isAttached()) throttled.webContents.debugger.attach('1.3');
    await throttled.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    results.push({ label: 'P4 setDeviceMetricsOverride applied', ok: true });
  } catch (e) {
    results.push({ label: 'P4 setDeviceMetricsOverride applied', ok: false, err: String(e.message).slice(0, 100) });
  }
  await new Promise((r) => setTimeout(r, 500));
  results.push(await cdpShot(throttled.webContents, 'P5 emulated throttled CDP capture'));

  // Lift throttling, then retry
  throttled.webContents.setBackgroundThrottling(false);
  await new Promise((r) => setTimeout(r, 500));
  results.push(await cdpShot(throttled.webContents, 'P6 emulated UNTHROTTLED CDP capture'));
  results.push(await pageShot(throttled.webContents, 'P7 emulated UNTHROTTLED capturePage'));
  throttled.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 200));
  results.push(await cdpShot(throttled.webContents, 'P8 emulated UNTHROTTLED after invalidate()'));

  // Window minimized: does a covered view still produce a rasterizable frame?
  win.minimize();
  await new Promise((r) => setTimeout(r, 700));
  results.push(await cdpShot(throttled.webContents, 'M1 emulated covered-view CDP capture while window MINIMISED', 6000));
  results.push(await pageShot(throttled.webContents, 'M2 emulated covered-view capturePage while window MINIMISED', 6000));
  results.push(await cdpShot(top.webContents, 'M3 emulated TOP-view CDP capture while window MINIMISED', 6000));
  win.restore();
  await new Promise((r) => setTimeout(r, 700));
  results.push(await cdpShot(throttled.webContents, 'M4 emulated covered-view CDP capture after restore'));

  // Restore throttling and confirm it regresses (causality check)
  throttled.webContents.setBackgroundThrottling(true);
  await new Promise((r) => setTimeout(r, 500));
  results.push(await cdpShot(throttled.webContents, 'P9 emulated re-THROTTLED CDP capture', 6000));

  console.log('=== THROTTLE PROBE RESULTS ===');
  console.log(JSON.stringify(results, null, 1));
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((err) => {
  console.error('PROBE FAILED:', err);
  app.exit(1);
});
