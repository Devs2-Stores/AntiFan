/**
 * Throwaway diagnostic probe (phase-04 D1): does a plain VISIBLE but UNFOCUSED
 * BrowserWindow keep producing frames for a presented WebContentsView?
 *
 * Mirrors ensureFramesForRaster's gate signal (tab-devtools-host.ts
 * FRAME_LIVENESS_PROBE_EXPRESSION: rAF fires within 300ms in-page, 800ms eval
 * bound) followed by CDP Page.captureScreenshot {fromSurface:true}.
 * No app boot, no detach plumbing — Electron-level verdict only.
 * Run: node scripts/run-electron.cjs scripts/probe-unfocused-visible-capture.cjs
 */
'use strict';
const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-unfocused-probe-'));
app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('no-sandbox');

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`
<!doctype html><html><head><style>
  body { margin:0; font:16px sans-serif; background:#123; color:#fff }
  .spin { width:120px;height:120px;background:#e33; animation: spin 2s linear infinite; }
  @keyframes spin { from { transform: rotate(0) } to { transform: rotate(360deg) } }
</style></head><body><h1>UNFOCUSED-VISIBLE PROBE</h1><div class="spin"></div></body></html>`)}`;

// Same in-page expression as FRAME_LIVENESS_PROBE_EXPRESSION (300ms bound).
const RAF_PROBE = `(() => {
  const { promise, resolve } = Promise.withResolvers();
  const timer = setTimeout(() => resolve(false), 300);
  try {
    requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
  } catch { resolve(false); }
  return promise;
})()`;

function withTimeout(p, ms, fallback) {
  let timer;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

async function rafProbe(wc, label) {
  const t0 = Date.now();
  try {
    const res = await withTimeout(wc.executeJavaScript(RAF_PROBE), 800, null);
    return { label, raf: res === true ? true : res === false ? false : 'EVAL_TIMEOUT', ms: Date.now() - t0 };
  } catch (e) {
    return { label, raf: 'ERR', ms: Date.now() - t0, err: String(e.message).slice(0, 120) };
  }
}

async function shot(wc, label) {
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    await wc.debugger.sendCommand('Page.enable');
  } catch (e) {
    return { label, ok: false, ms: 0, err: `attach/enable: ${e.message}` };
  }
  const t0 = Date.now();
  try {
    const res = await withTimeout(
      wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      8000,
      null
    );
    const ms = Date.now() - t0;
    if (!res) return { label, ok: false, ms, err: 'TIMEOUT(8000ms)' };
    return { label, ok: true, ms, bytes: res.data ? res.data.length : 0 };
  } catch (e) {
    return { label, ok: false, ms: Date.now() - t0, err: String(e.message).slice(0, 120) };
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const windowState = (win) => ({
  focused: win.isFocused(), visible: win.isVisible(), minimized: win.isMinimized(),
});

app.whenReady().then(async () => {
  const results = [];
  const win = new BrowserWindow({ width: 1280, height: 800, show: true, backgroundColor: '#000' });
  const view = new WebContentsView({ webPreferences: { backgroundThrottling: false } });
  win.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  const wc = view.webContents;
  await wc.loadURL(PAGE);
  await sleep(1200);

  // A second window exists to TAKE focus: on Windows blur() alone leaves the
  // window focused when nothing else accepts it. win2 also mirrors the detached
  // topology (the focused window is a different surface than the probed one).
  const win2 = new BrowserWindow({ width: 400, height: 300, x: 20, y: 560, show: true, backgroundColor: '#030' });

  results.push({ phase: 'A focused-visible (baseline)', ...windowState(win), ...(await rafProbe(wc, 'raf')) });
  results.push({ phase: 'A focused-visible (baseline)', ...windowState(win), ...(await shot(wc, 'shot')) });

  win.setPosition(520, 40);
  win2.focus();
  await sleep(600);
  results.push({ phase: 'B unfocused-visible', ...windowState(win), ...(await rafProbe(wc, 'raf-1')) });
  results.push({ phase: 'B unfocused-visible', ...windowState(win), ...(await rafProbe(wc, 'raf-2')) });
  results.push({ phase: 'B unfocused-visible', ...windowState(win), ...(await shot(wc, 'shot')) });

  win.focus();
  await sleep(400);
  results.push({ phase: 'C refocused (recovery)', ...windowState(win), ...(await rafProbe(wc, 'raf')) });
  results.push({ phase: 'C refocused (recovery)', ...windowState(win), ...(await shot(wc, 'shot')) });

  win.minimize();
  await sleep(600);
  results.push({ phase: 'D minimized (contrast)', ...windowState(win), ...(await rafProbe(wc, 'raf')) });
  results.push({ phase: 'D minimized (contrast)', ...windowState(win), ...(await shot(wc, 'shot')) });
  win.restore();
  win2.destroy();

  const vis = await withTimeout(wc.executeJavaScript('document.visibilityState'), 800, 'EVAL_TIMEOUT');
  console.log('=== UNFOCUSED-VISIBLE PROBE RESULTS ===');
  console.log('final document.visibilityState:', vis);
  console.log(JSON.stringify(results, null, 1));
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  app.exit(0);
}).catch((err) => {
  console.error('PROBE FATAL:', err && err.message ? err.message : err);
  app.exit(1);
});
