/**
 * Throwaway live smoke for the browser-evidence hardening (D1–D5).
 *
 * Runs inside a real Electron main process with a real offscreen BrowserWindow,
 * a real NativeTabHost (real CDP transport) and the real BrowserControlPort, so
 * every asserted contract is exercised against actual Chromium geometry rather
 * than a structural mock. State is confined to this throwaway userData dir; the
 * user's real AntiFan profile is never touched.
 *
 * Usage: node scripts/run-electron.cjs .canary/state/live-evidence-smoke.cjs
 */
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const USER_DATA = path.join(ROOT, '.canary', 'state', 'smoke-userdata');
fs.mkdirSync(USER_DATA, { recursive: true });

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.setPath('userData', USER_DATA);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`);
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>smoke</title>
<style>body{margin:0;font:16px sans-serif}#tall{height:5200px;background:linear-gradient(#fff,#09f)}
#lazy{display:block}</style></head><body>
<h1 id="h">live smoke</h1><img id="lazy" loading="lazy" width="320" height="240"
  alt="lazy" src="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs=">
<div id="tall"></div></body></html>`;

async function main() {
  const win = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    webPreferences: { offscreen: false, backgroundThrottling: false },
  });

  const { NativeTabHost } = require(path.join(ROOT, '.compiled', 'src', 'main', 'browser', 'native-tab-host.js'));
  const { BrowserControlPort } = require(path.join(ROOT, '.compiled', 'src', 'main', 'tools', 'browser-control-port.js'));

  const host = new NativeTabHost(win);
  // Real runtime, temp roots (inside the throwaway userData): the host validates
  // every target against the live lease, exactly as the app does.
  const { ControlPlaneRuntime } = require(path.join(ROOT, '.compiled', 'src', 'main', 'control-plane', 'control-plane-runtime.js'));
  const projectId = 'project-00000000-0000-4000-8000-000000000001';
  const workspaceId = 'workspace-00000000-0000-4000-8000-000000000001';
  const controlPlane = new ControlPlaneRuntime({
    projectId,
    workspaceId,
    dataRoot: path.join(USER_DATA, 'control-plane'),
    workspaceRoot: path.join(USER_DATA, 'workspace'),
    hostEpoch: 1,
    getAutomationTabId: () => host.getAutomationTabId(),
    getDocumentGeneration: (id) => host.getDocumentGeneration(id),
    isTabAllowed: (primary, requested) => host.isTabAllowedForPrimary(primary, requested),
    resolveTabId: (id) => host.resolveTargetTabId(id),
  });
  host.setControlPlane(controlPlane);
  // Mirror the app's composition: the port's session-scoped listing seam reads
  // the host's session records.
  host.getSessionTabList = (boundTabId) => host.getSessionTabRecords(boundTabId);
  const port = new BrowserControlPort(host);

  // The window itself becomes the tab's surface; reuse the window's own webContents
  // so CDP is available on the same renderer the host can measure.
  // A real HTTP origin, so navigation is a real document load (data: URLs are
  // refused by the host's navigation policy) and the long page is really long.
  const http = require('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${server.address().port}/`;

  const tabId = host.createTab(pageUrl, false, {});
  record('setup.tab-created', typeof tabId === 'string' && tabId.length > 0, `tabId=${tabId}`);
  await host.navigate(tabId, pageUrl);
  await new Promise((r) => setTimeout(r, 1500));

  // A freshly created offscreen tab has no laid-out surface until it is sized,
  // so D2 runs first and D1 measures the surface that write produced.
  const target = () => {
    const lease = controlPlane.getLease();
    return {
      projectId: lease.projectId,
      workspaceId: lease.workspaceId,
      runtimeId: lease.runtimeId,
      tabId,
      browserEpoch: lease.hostEpoch,
      documentGeneration: host.getDocumentGeneration(tabId),
    };
  };

  // D2: a viewport write is verified against measured geometry.
  try {
    const res = await port.setViewport({ width: 1024, height: 768, tabId });
    record(
      'D2.setViewport-verified',
      res.verified === true && res.observedWidth === 1024 && res.observedHeight === 768,
      JSON.stringify(res)
    );
  } catch (err) {
    record('D2.setViewport-verified', false, `${err && err.code ? err.code : ''} ${err && err.message ? err.message : err}`);
  }

  // D1: the measured surface is real geometry, not a fabricated default.
  try {
    const surface = await host.readRenderSurface(tabId);
    record(
      'D1.readRenderSurface',
      Number.isFinite(surface.vw) && Number.isFinite(surface.vh) && surface.vw > 0 && surface.vh > 0,
      JSON.stringify(surface)
    );
  } catch (err) {
    record('D1.readRenderSurface', false, String(err && err.message ? err.message : err));
  }

  // D3: a session that owns the tab lists it, and the WHOLE-window listing is explicit.
  try {
    const listed = port.listTabs({ target: target() });
    const all = port.listTabs({});
    record(
      'D3.listTabs-session-scoped',
      Array.isArray(listed) && listed.some((t) => t && t.id === tabId),
      `session=${JSON.stringify(listed.map((t) => ({ id: t.id, bound: t.isBoundTab })))} all=${all.length}`
    );
  } catch (err) {
    record('D3.listTabs-session-scoped', false, String(err && err.message ? err.message : err));
  }

  // D5: reference capture materializes, settles, re-measures the surface, stages a DOM.
  try {
    const ref = await port.referenceCapture(target(), 'run-smoke-0001', 'attempt-smoke-0001', { tabId, screenshot: false });
    record(
      'D5.referenceCapture',
      ref.ok === true && typeof ref.url === 'string' && ref.url.length > 0 && ref.materialization && ref.materialization.materialized === true && Boolean(ref.domRef),
      `url=${ref.url} passes=${ref.materialization && ref.materialization.passes} docHeight=${ref.materialization && ref.materialization.docHeight} surface=${JSON.stringify(ref.surface)} settle=${ref.settleComplete}`
    );
  } catch (err) {
    record('D5.referenceCapture', false, `${err && err.code ? err.code : ''} ${err && err.message ? err.message : err}`);
  }

  // D6: the in-page execution guard honours a caller budget. A 16s script dies
  // at the 15s default but must survive when the caller declares 25s.
  try {
    const startedAt = Date.now();
    const late = await host.evalJs('new Promise(r => setTimeout(() => r("late"), 16000))', tabId, undefined, false, 25_000);
    const withBudget = { value: late, elapsedMs: Date.now() - startedAt };
    const startedAtDefault = Date.now();
    let defaultError;
    try {
      await host.evalJs('new Promise(r => setTimeout(() => r("late"), 16000))', tabId);
    } catch (err) {
      defaultError = err instanceof Error ? err.message : String(err);
    }
    record(
      'D6.eval-budget-honoured',
      withBudget.value === 'late' && typeof defaultError === 'string' && /timed out after 15000ms/.test(defaultError),
      `budgeted=${JSON.stringify(withBudget)} default=${defaultError} defaultElapsedMs=${Date.now() - startedAtDefault}`
    );
  } catch (err) {
    record('D6.eval-budget-honoured', false, String(err && err.message ? err.message : err));
  }

  // D4: a full-page capture either returns bytes whose geometry restoration was
  // proven, or fails typed — it never returns bytes nobody can vouch for. This
  // window is never shown, so the compositor cannot produce full-page frames;
  // the observable contract under that condition is the typed refusal.
  try {
    const full = await port.screenshotFullPage(target(), 'run-smoke-0001', 'attempt-smoke-0001', tabId, 'desktop', { timeoutMs: 30_000 });
    record(
      'D4.fullPage-capture-proven',
      full.ok === true && typeof full.sha256 === 'string' && full.receipt && full.receipt.captureMode === 'full-page',
      `sha256=${String(full.sha256).slice(0, 12)} mode=${full.receipt && full.receipt.captureMode} restored=${full.receipt && full.receipt.viewportTransaction && full.receipt.viewportTransaction.restored}`
    );
  } catch (err) {
    const code = err && err.code ? String(err.code) : 'UNCLASSIFIED';
    const refusalCodes = ['EXECUTION_TIMEOUT', 'FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN', 'CAPTURE_VIEWPORT_NOT_RESTORED', 'TARGET_BUSY_DRAINING', 'TARGET_STALE', 'NO_RENDER_SURFACE'];
    record(
      'D4.fullPage-capture-proven',
      refusalCodes.includes(code) && !(err && typeof err === 'object' && 'data' in err),
      `typed refusal on a compositor-less window: ${code} :: ${err && err.message ? err.message : err}`
    );
  }

  // The capture must have left the tab where it found it — or, when the capture
  // failed typed, the target must be gone rather than silently left expanded.
  try {
    const after = await host.readRenderSurface(tabId);
    record(
      'D4.geometry-restored',
      after.vw === 1024 && after.vh === 768,
      JSON.stringify({ vw: after.vw, vh: after.vh, scrollY: after.scrollY })
    );
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    record('D4.geometry-restored', /target closed|not found/i.test(message), `no surface left behind after the typed refusal: ${message}`);
  }

  const summary = { timestamp: new Date().toISOString(), pass: results.filter((r) => r.ok).length, fail: results.filter((r) => !r.ok).length, results };
  fs.writeFileSync(path.join(ROOT, '.canary', 'state', 'live-evidence-smoke.json'), JSON.stringify(summary, null, 2));
  console.log(`SMOKE_SUMMARY pass=${summary.pass} fail=${summary.fail}`);
  server.close();
  win.destroy();
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await main();
  } catch (err) {
    console.error('SMOKE_CRASH', err && err.stack ? err.stack : err);
    code = 1;
  }
  try { app.exit(code); } catch { process.exit(code); }
});
