/**
 * Detached Capture Surface Probe — live Electron proof of the zero-bounds fix.
 *
 * A background tab's WebContentsView has never been presented, so nothing ever sized it:
 * its document lays out at 0x0 and every reading taken through the capture helper's
 * temporary attach — render-surface probe, evaluate, capture raster — measures nothing on
 * a tab that can do the work. This probe creates exactly such a tab with the real host
 * (`createTab(url, false)` never attaches a view), drives the real
 * `NativeTabHost.runWithAttachedTabView` against it, and measures INSIDE the action, the
 * only moment the presented surfaces exist:
 *   - view.getBounds()               width/height > 0  (pre-fix: 0x0, never laid out)
 *   - documentElement.clientWidth    > 0               (pre-fix: 0 — 0x0 layout)
 *   - body.scrollHeight              > 0               (pre-fix: 0 — 0x0 layout)
 *
 * It must run under Electron and not plain node: it needs `app`, a real GUI BrowserWindow,
 * real Chromium WebContentsViews and the composed NativeTabHost; a stubbed renderer cannot
 * produce the 0x0 layout this fix addresses, and `app` is undefined under plain node.
 *
 * Run: node scripts/run-electron.cjs scripts/probe-detached-capture-surface.cjs
 *      add --keep-open to leave the laid-out background view on screen for inspection
 *
 * Exit 0 only when all three readings are non-degenerate; a degenerate reading set exits 1
 * with those values still printed as the PROBE_RESULT line, and a probe that cannot take
 * the reading at all exits 1 with the error instead.
 */
'use strict';

const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');
app.disableHardwareAcceleration();

const KEEP_OPEN = process.argv.includes('--keep-open');
const LOG = '[Detached Capture Surface Probe]';

// Throwaway profile: a live one would let saved tabs and workspace capsules decide the
// window's geometry before the probe measures the window's own layout.
const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-detached-surface-'));
app.setPath('userData', tempUserData);

// 2000px of content so scrollHeight is content-driven rather than just the viewport.
const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0"><div id="probe-surface" style="height:2000px;background:linear-gradient(#123,#abc)"></div></body></html>`;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  let exitCode = 0;
  let win = null;
  let server = null;
  let host = null;
  let view = null;
  let fixtureUrl = '';

  try {
    const { NativeTabHost } = require(path.join(__dirname, '..', '.compiled', 'src', 'main', 'browser', 'native-tab-host.js'));

    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE_HTML);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

    win = new BrowserWindow({ width: 1440, height: 900, show: true, backgroundColor: '#080c14' });
    host = new NativeTabHost(win);

    const presentedTabId = host.createTab(fixtureUrl, true);
    const backgroundTabId = host.createTab(fixtureUrl, false);
    if (!presentedTabId || !backgroundTabId) {
      throw new Error(`createTab refused the fixture url ${fixtureUrl}`);
    }
    // The host publishes no view accessor; the view is what the capture helper takes.
    const backgroundTab = host.tabs.get(backgroundTabId);
    if (!backgroundTab?.view) {
      throw new Error(`background tab ${backgroundTabId} has no view to probe`);
    }
    view = backgroundTab.view;

    // A never-attached view still loads and runs its document — only its layout is missing.
    for (let i = 0; i < 200; i++) {
      const ready = await view.webContents
        .executeJavaScript("Boolean(document.getElementById('probe-surface'))")
        .catch(() => false);
      if (ready) break;
      await delay(100);
    }

    if (host.isTabViewAttached(view)) {
      throw new Error('probe invariant broken: the background view is already attached, so it cannot exhibit the zero-bounds defect');
    }
    const boundsBefore = view.getBounds();

    const measured = await host.runWithAttachedTabView(view, async () => {
      const bounds = view.getBounds();
      const attached = host.isTabViewAttached(view);
      const readings = await view.webContents.executeJavaScript(`({
        href: location.href,
        marker: Boolean(document.getElementById('probe-surface')),
        clientWidth: document.documentElement.clientWidth,
        scrollHeight: document.body.scrollHeight,
      })`);
      return { bounds, attached, ...readings };
    });

    if (!measured.attached) {
      throw new Error('the capture helper did not attach the background view for the action');
    }
    if (!measured.marker || measured.href !== fixtureUrl) {
      throw new Error(`probe measured the wrong document (${measured.href}); the fixture page never loaded`);
    }

    const ok = measured.bounds.width > 0 && measured.bounds.height > 0
      && measured.clientWidth > 0 && measured.scrollHeight > 0;
    console.log(
      `${LOG} before=${JSON.stringify(boundsBefore)} inside=${JSON.stringify(measured.bounds)}`
      + ` paneBox=${JSON.stringify(host.getTabContentBounds(backgroundTabId))}`
      + ` clientWidth=${measured.clientWidth} scrollHeight=${measured.scrollHeight}`
    );
    console.log(`PROBE_RESULT ${JSON.stringify({
      bounds: measured.bounds,
      clientWidth: measured.clientWidth,
      scrollHeight: measured.scrollHeight,
      ok,
    })}`);
    exitCode = ok ? 0 : 1;
  } catch (err) {
    console.error(`${LOG} ERROR / MEASUREMENT FAILURE:`, err);
    exitCode = 1;
  }

  if (KEEP_OPEN) {
    console.log(`${LOG} --keep-open: window left up at exit code ${exitCode}; close it or Ctrl+C to exit`);
    if (host && view) {
      // Never settles, so the helper's finally never detaches: the laid-out background
      // view stays on screen next to the presented tab.
      host.runWithAttachedTabView(view, () => new Promise(() => {})).catch(() => {});
    }
    return;
  }

  try { server?.close(); } catch {}
  try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  if (win && !win.isDestroyed()) {
    win.destroy();
  }
  app.exit(exitCode);
}).catch((err) => {
  console.error(`${LOG} PROBE FAILED:`, err);
  app.exit(1);
});
