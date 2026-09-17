/**
 * Throwaway diagnostic probe: does CDP Page.captureScreenshot settle on a
 * WebContents that is NOT attached to any window (a background tab the tab host
 * has not presented), and does anything wake it?
 *
 * Cases: detached viewport / detached beyondViewport / detached capturePage /
 * detached after invalidate() / detached after a temporary attach-and-detach /
 * plus the attached-view control.
 */
'use strict';
const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-detached-probe-'));
app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('no-sandbox');

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><style>html,body{margin:0}body{height:4000px;background:linear-gradient(#123,#abc)}
h1{font:700 64px sans-serif;color:#fff}</style></head>
<body><h1>DETACHED PROBE</h1></body></html>`)}`;

const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), ms); }),
  ]);
};

const cdpShot = async (wc, label, params, boundMs = 6000) => {
  const t0 = Date.now();
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
    const res = await withTimeout(wc.debugger.sendCommand('Page.captureScreenshot', params), boundMs);
    if (res && res.__timeout) return { label, ok: false, ms: Date.now() - t0, err: `TIMEOUT(${boundMs}ms)` };
    const bytes = Buffer.from(res.data, 'base64');
    return { label, ok: true, ms: Date.now() - t0, bytes: bytes.length };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - t0, err: String(error.message).slice(0, 120) };
  }
};

const nativeShot = async (wc, label, boundMs = 6000) => {
  const t0 = Date.now();
  try {
    const image = await withTimeout(wc.capturePage(), boundMs);
    if (!image || image.__timeout) return { label, ok: false, ms: Date.now() - t0, err: `TIMEOUT(${boundMs}ms)` };
    const size = image.getSize();
    return { label, ok: !image.isEmpty(), ms: Date.now() - t0, size: `${size.width}x${size.height}` };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - t0, err: String(error.message).slice(0, 120) };
  }
};

app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ width: 600, height: 400, show: true, skipTaskbar: true, backgroundColor: '#000' });
  const attached = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  const detached = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  const throttled = new WebContentsView({ webPreferences: { backgroundThrottling: true } });

  win.contentView.addChildView(attached);
  attached.setBounds({ x: 0, y: 0, width: 600, height: 400 });
  detached.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  throttled.setBounds({ x: 0, y: 0, width: 1440, height: 900 });

  await attached.webContents.loadURL(PAGE);
  await detached.webContents.loadURL(PAGE);
  await throttled.webContents.loadURL(PAGE);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  results.push(await cdpShot(attached.webContents, 'A attached viewport (control)', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await cdpShot(detached.webContents, 'B detached viewport', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await cdpShot(detached.webContents, 'C detached beyondViewport', { format: 'png', fromSurface: true, captureBeyondViewport: true }));
  results.push(await nativeShot(detached.webContents, 'D detached capturePage()'));
  detached.webContents.invalidate();
  await new Promise((resolve) => setTimeout(resolve, 300));
  results.push(await cdpShot(detached.webContents, 'E detached viewport after invalidate()', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await nativeShot(detached.webContents, 'F detached capturePage() after invalidate()'));

  // Temporarily attach, capture, detach — the tab-host contract for a background tab.
  win.contentView.addChildView(detached);
  detached.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  results.push(await cdpShot(detached.webContents, 'G attached-then viewport', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await cdpShot(detached.webContents, 'H attached-then beyondViewport', { format: 'png', fromSurface: true, captureBeyondViewport: true }));
  win.contentView.removeChildView(detached);
  await new Promise((resolve) => setTimeout(resolve, 300));
  results.push(await cdpShot(detached.webContents, 'I re-detached viewport', { format: 'png', fromSurface: true, captureBeyondViewport: false }));

  // Background-throttled but attached view: does throttling alone break the raster?
  win.contentView.addChildView(throttled);
  throttled.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  results.push(await cdpShot(throttled.webContents, 'J throttled+attached viewport', { format: 'png', fromSurface: true, captureBeyondViewport: false }));

  console.log('=== DETACHED PROBE RESULTS ===');
  console.log(JSON.stringify(results, null, 1));
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((error) => {
  console.error('probe failed', error);
  app.exit(1);
});
