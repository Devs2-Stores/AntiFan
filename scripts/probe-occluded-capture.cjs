/**
 * Throwaway diagnostic probe: does CDP Page.captureScreenshot settle on a
 * WebContentsView that is attached BEHIND another full-size view (occluded)?
 * Matrix: viewport/beyondViewport, invalidate() wake kick, capturePage(),
 * on-top re-stack, offscreen WebContents.
 */
'use strict';
const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-occlusion-probe-'));
app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('no-sandbox');

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><style>
  body { margin:0; font: 16px sans-serif; background:#123; color:#fff }
  .spin { width:120px;height:120px;background:#e33; animation: spin 2s linear infinite; }
  @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
</style></head><body><h1>OCCLUSION PROBE</h1><div class="spin"></div></body></html>`)}`;

function withTimeout(p, ms, fallback) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

async function shot(wc, label, params) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
  } catch (e) {
    return { label, ok: false, ms: 0, err: `attach/enable: ${e.message}` };
  }
  const t0 = Date.now();
  try {
    const res = await withTimeout(wc.debugger.sendCommand('Page.captureScreenshot', params), 8000, null);
    const ms = Date.now() - t0;
    if (!res) return { label, ok: false, ms, err: 'TIMEOUT(8000ms)' };
    return { label, ok: true, ms, bytes: res.data ? res.data.length : 0 };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 120) };
  }
}

async function capturePageShot(wc, label) {
  const t0 = Date.now();
  try {
    const img = await withTimeout(wc.capturePage(), 8000, null);
    const ms = Date.now() - t0;
    if (!img) return { label, ok: false, ms, err: 'TIMEOUT(8000ms)' };
    const size = img.getSize();
    return { label, ok: !img.isEmpty(), ms, bytes: img.toPNG().length, size: `${size.width}x${size.height}` };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 120) };
  }
}

app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ width: 1440, height: 900, show: true, backgroundColor: '#000' });

  const coveredView = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  const topView = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  const offscreenView = new WebContentsView({ webPreferences: { offscreen: true, backgroundThrottling: false } });

  win.contentView.addChildView(coveredView, 0);
  win.contentView.addChildView(topView, 1);
  coveredView.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
  topView.setBounds({ x: 0, y: 0, width: 1440, height: 900 });

  await coveredView.webContents.loadURL(PAGE);
  await topView.webContents.loadURL(PAGE);
  await offscreenView.webContents.loadURL(PAGE);
  await new Promise((r) => setTimeout(r, 1200));

  results.push(await shot(topView.webContents, 'A top-view viewport fromSurface', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await shot(coveredView.webContents, 'B covered-view viewport fromSurface', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await shot(coveredView.webContents, 'C covered-view beyondViewport', { format: 'png', fromSurface: true, captureBeyondViewport: true }));
  coveredView.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 250));
  results.push(await shot(coveredView.webContents, 'D covered-view viewport after invalidate()', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await capturePageShot(coveredView.webContents, 'E covered-view capturePage()'));
  results.push(await capturePageShot(topView.webContents, 'F top-view capturePage()'));

  // Re-stack: covered view becomes the top child (diagnostic only; proves occlusion causality)
  win.contentView.addChildView(coveredView);
  await new Promise((r) => setTimeout(r, 250));
  results.push(await shot(coveredView.webContents, 'G covered-view viewport AFTER re-stack on top', { format: 'png', fromSurface: true, captureBeyondViewport: false }));

  // Offscreen target
  results.push(await shot(offscreenView.webContents, 'H offscreen-view viewport fromSurface', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await capturePageShot(offscreenView.webContents, 'I offscreen-view capturePage()'));

  // Window hidden: the beyond-viewport refusal is documented; confirm viewport behaviour too
  win.hide();
  await new Promise((r) => setTimeout(r, 400));
  results.push(await shot(topView.webContents, 'J top-view viewport while window hidden', { format: 'png', fromSurface: true, captureBeyondViewport: false }));
  results.push(await capturePageShot(topView.webContents, 'K top-view capturePage() while window hidden'));

  win.show();
  console.log('=== PROBE RESULTS ===');
  console.log(JSON.stringify(results, null, 1));
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((err) => {
  console.error('PROBE FAILED:', err);
  app.exit(1);
});
