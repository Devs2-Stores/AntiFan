/**
 * Spike (phase-03-offscreen-render-surface): a detached WebContentsView minted with
 * webPreferences.offscreen:true — NEVER attached to any window — is sized purely by
 * Emulation.setDeviceMetricsOverride on its own debugger channel, and produces a
 * non-empty raster via capturePage() and Page.captureScreenshot({fromSurface:true}).
 *
 * This is the gate for minting OSR agent tabs with a render surface without attach:
 * if the detached override does not yield layout + raster, the fallback is a
 * fixed-size hidden capture-host window and phase 3 must pivot.
 *
 * Measurements taken after did-finish-load (a pre-commit override dereferences a
 * missing widget — the host defers via pendingEmulationDeferrals, mirrored here):
 *   - document.documentElement.clientWidth/innerWidth resolve to the emulated size
 *   - a rAF liveness probe settles (OSR BeginFrame source ticking)
 *   - wc.capturePage() returns a non-empty image
 *   - Page.captureScreenshot({fromSurface:true}) returns a non-empty payload
 *   - the same capture while the owning (hidden) window is minimized — OSR surface
 *     must be independent of window presentation
 *
 * Run: node scripts/run-electron.cjs scripts/probe-osr-detached-emulation.cjs
 *      (optionally --software to force SwiftShader)
 *
 * Exit 0 only when every measurement is non-degenerate.
 */
'use strict';

const { app, BrowserWindow, WebContentsView } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EMULATED = { width: 1440, height: 900, dsf: 1 };
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-osr-detached-'));
app.setPath('userData', tempUserData);
app.commandLine.appendSwitch('no-sandbox');
if (process.argv.includes('--software')) app.disableHardwareAcceleration();

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#123;color:#fff;font:16px sans-serif}
  #bar{width:100vw;height:4px;background:#e33}
</style></head><body><div id="bar"></div><h1>OSR DETACHED SPIKE</h1></body></html>`)}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function bounded(promise, ms, tag) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      (v) => ({ outcome: 'ok', value: v }),
      (e) => ({ outcome: 'error', error: String((e && e.message) || e).slice(0, 200) })
    ).finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ outcome: 'timeout', error: `TIMEOUT(${ms}ms) ${tag}` }), ms); }),
  ]);
}

app.whenReady().then(async () => {
  const results = { cases: [] };
  let exitCode = 0;
  let win = null;
  let view = null;
  try {
    // A real BrowserWindow must exist (the app's window), but the probed view is
    // never added to it — window visibility is varied to prove surface independence.
    win = new BrowserWindow({ width: 1280, height: 800, show: false, backgroundColor: '#000' });
    view = new WebContentsView({
      webPreferences: {
        // production prefs: security-policy.ts getSecureWebPreferences(partition, {offscreen:true})
        contextIsolation: true, sandbox: true, nodeIntegration: false,
        webSecurity: true, allowRunningInsecureContent: false,
        navigateOnDragDrop: false, spellcheck: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        plugins: true, webgl: true,
        offscreen: true,
        paintWhenInitiallyHidden: false,
      },
    });
    try { view.setBackgroundColor('#ffffff'); } catch {}
    const wc = view.webContents;

    // What applyTabDeviceEmulation does to the detached OSR view at mint: bounds +
    // metrics override. setBounds on a detached view is a no-op for layout (measured
    // in-repo) but mirrors production; the override is the surface-sizing mechanism.
    view.setBounds({ x: 0, y: 0, width: EMULATED.width, height: EMULATED.height });

    await bounded(wc.loadURL(PAGE), 15000, 'loadURL');

    // Mirror pendingEmulationDeferrals: only emulate once a document committed.
    await bounded(new Promise((resolve) => {
      if (wc.getURL && wc.getURL().length > 0 && !wc.isLoading()) return resolve();
      wc.once('did-finish-load', resolve);
      setTimeout(resolve, 15000);
    }), 16000, 'did-finish-load');

    try {
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    } catch (e) {
      results.cases.push({ label: 'debugger-attach', ok: false, err: String(e && e.message || e) });
    }
    const emu = await bounded(wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: EMULATED.width,
      height: EMULATED.height,
      deviceScaleFactor: EMULATED.dsf,
      mobile: false,
      screenWidth: EMULATED.width,
      screenHeight: EMULATED.height,
      scale: 1,
    }), 8000, 'setDeviceMetricsOverride');
    if (emu.outcome !== 'ok') throw new Error(`metrics override failed: ${emu.error}`);
    try { wc.invalidate(); } catch {}
    await delay(300);

    const metrics = await wc.executeJavaScript(`({
      innerWidth: window.innerWidth, innerHeight: window.innerHeight,
      clientWidth: document.documentElement.clientWidth,
      clientHeight: document.documentElement.clientHeight,
      dpr: window.devicePixelRatio,
    })`);
    results.viewport = metrics;

    const t0 = Date.now();
    const raf = await bounded(wc.executeJavaScript(
      `new Promise(r => { const t = setTimeout(() => r(false), 200); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r(true); })); })`
    ), 2000, 'raf');
    results.raf = { alive: raf.outcome === 'ok' && raf.value === true, ms: Date.now() - t0 };

    const cap = await bounded(wc.capturePage(), 8000, 'capturePage');
    if (cap.outcome === 'ok' && cap.value) {
      const size = cap.value.getSize();
      results.capturePage = { ok: !cap.value.isEmpty(), size: `${size.width}x${size.height}`, pngBytes: cap.value.toPNG().length };
    } else {
      results.capturePage = { ok: false, err: cap.error || 'no image' };
    }

    await wc.debugger.sendCommand('Page.enable').catch(() => {});
    const cdpShot = await bounded(wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    }), 8000, 'Page.captureScreenshot');
    results.cdpFromSurface = cdpShot.outcome === 'ok' && cdpShot.value && typeof cdpShot.value.data === 'string' && cdpShot.value.data.length > 0
      ? { ok: true, bytes: cdpShot.value.data.length }
      : { ok: false, err: cdpShot.error || 'empty data' };

    // Window presentation must not matter for the OSR raster.
    win.hide();
    await delay(300);
    const hiddenShot = await bounded(wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png', fromSurface: true, captureBeyondViewport: false,
    }), 8000, 'Page.captureScreenshot hidden');
    results.hiddenWindowCdp = hiddenShot.outcome === 'ok' && hiddenShot.value && hiddenShot.value.data.length > 0
      ? { ok: true, bytes: hiddenShot.value.data.length }
      : { ok: false, err: hiddenShot.error || 'empty data' };

    const neverAttached = !win.contentView.children.includes(view);
    results.neverAttached = neverAttached;

    const ok = neverAttached
      && metrics && metrics.innerWidth === EMULATED.width && metrics.clientWidth === EMULATED.width
      && metrics.innerHeight === EMULATED.height
      && results.raf.alive
      && results.capturePage.ok
      && results.cdpFromSurface.ok
      && results.hiddenWindowCdp.ok;
    exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error('[OSR detached spike] ERROR:', err);
    exitCode = 1;
  }
  console.log('PROBE_RESULT ' + JSON.stringify(results));
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(exitCode);
}).catch((err) => {
  console.error('[OSR detached spike] PROBE FAILED:', err);
  app.exit(1);
});
