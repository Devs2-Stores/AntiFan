// Live probe: re-measures public Haravan storefronts (home, first product, first collection, at
// 375x667 and 1440x900) with the shipped layout integrity scan, bundled from src/.
// Usage: node scripts/run-electron.cjs scripts/probe-visual-qa-live-sites.cjs [--only=<site>] [--out=<dir>]
// Exit 0 when every expected page is measured, scroll-restored and free of criticals; 1 otherwise;
// 2 on a harness error.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const requestedOut = (process.argv.find((arg) => arg.startsWith('--out=')) || '').slice(6);
const outDir = requestedOut ? path.resolve(requestedOut) : fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-live-'));
const SITES = [
  ['phukienmaymoc', 'https://phukienmaymoc.com/'],
  ['gixjewel', 'https://gixjewel.com/'],
  ['hapas', 'https://hapas.vn/'],
  ['unitedvision', 'https://www.unitedvision.com.vn/'],
];
const PAGES = ['home', 'product', 'collection'];
const viewports = [
  { name: 'mobile', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
];
const SETTLE_MS = 5000;
const LOAD_TIMEOUT_MS = 60000;
// First same-host /products/<handle> and /collections/<handle> link on the page.
const DISCOVER = `(() => {
  const pick = (re) => { const a = Array.from(document.querySelectorAll('a[href]')).find((x) => re.test(new URL(x.href, location.href).pathname) && new URL(x.href, location.href).host === location.host); return a ? a.href : null; };
  return { product: pick(/^\\/products\\/[^/]+\\/?$/), collection: pick(/^\\/collections\\/[^/]+\\/?$/) };
})()`;
let exitCode = 2;

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-live-userdata-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);

function fail(error) {
  console.error(error && error.stack ? error.stack : error);
  exitCode = 2;
  app.exit(exitCode);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openAt(vp) {
  const win = new BrowserWindow({
    show: false, x: -4000, y: 0, useContentSize: true,
    width: vp.width, height: vp.height, skipTaskbar: true, focusable: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', vp);
  // A hidden offscreen window paints no frames, so no layout-shift entries exist; a screencast forces frames.
  await dbg.sendCommand('Page.enable');
  dbg.on('message', (_event, method, params) => {
    if (method === 'Page.screencastFrame') {
      dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  return { win, dbg };
}

async function clipShots(dbg, id, findings) {
  const files = [];
  const crit = findings.filter((finding) => finding.severity === 'critical' && finding.rect).slice(0, 4);
  for (let i = 0; i < crit.length; i++) {
    const r = crit[i].rect;
    const pad = 40;
    const clip = {
      x: Math.max(0, r.x - pad), y: Math.max(0, r.y - pad),
      width: Math.max(40, r.w + pad * 2), height: Math.max(40, Math.min(600, r.h + pad * 2)), scale: 1,
    };
    try {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
      const file = path.join(outDir, `${id}-crit${i}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      files.push(file);
    } catch (error) {
      console.log(`    clip ${i} failed: ${error.message}`);
    }
  }
  return files;
}

// Loads one page, optionally discovers the product/collection links, and runs the scan once.
async function measurePage(engine, id, url, vp, discover) {
  const row = { id, url, measured: false, stats: null, wallMs: null, restored: null, findings: [], unmeasuredReason: '' };
  const { win, dbg } = await openAt(vp);
  const wc = win.webContents;
  let found = null;
  try {
    try {
      await withTimeout(wc.loadURL(url), LOAD_TIMEOUT_MS, `load timed out after ${LOAD_TIMEOUT_MS}ms`);
    } catch (error) {
      row.unmeasuredReason = `load failed: ${error.message}`;
      return { row, found };
    }
    await sleep(SETTLE_MS);
    row.url = wc.getURL() || url;
    if (discover) found = await wc.executeJavaScript(DISCOVER);
    let payload;
    const before = await wc.executeJavaScript('[window.scrollX, window.scrollY]');
    const started = Date.now();
    try {
      payload = await wc.executeJavaScript(engine.getBrowserScanScript(vp.name));
    } catch (error) {
      row.unmeasuredReason = `scan failed: ${error.message}`;
      return { row, found };
    }
    row.wallMs = Date.now() - started;
    const after = await wc.executeJavaScript('[window.scrollX, window.scrollY]');
    row.restored = before[0] === after[0] && Math.abs(before[1] - after[1]) <= 1;
    if (!payload || typeof payload !== 'object' || payload.measured !== true) {
      row.unmeasuredReason = `scan payload not measured: ${(payload && payload.unmeasuredReason) || 'no measured:true payload'}`;
      return { row, found };
    }
    row.stats = payload.stats || null;
    row.findings = Array.isArray(payload.findings) ? payload.findings : [];
    // A truncated scan or a detector that threw is an evidence gap: the page is not measured.
    const stats = row.stats || {};
    if (stats.truncated === true) {
      row.unmeasuredReason = `scan truncated: ${(stats.truncatedReasons || []).join('; ') || 'no reason reported'}`;
      return { row, found };
    }
    if (Array.isArray(stats.failedDetectors) && stats.failedDetectors.length) {
      row.unmeasuredReason = `detectors failed: ${[...new Set(stats.failedDetectors)].join(', ')}`;
      return { row, found };
    }
    row.measured = true;
    const crit = row.findings.filter((finding) => finding.severity === 'critical');
    const warn = row.findings.length - crit.length;
    console.log(`${id} crit=${crit.length} warn=${warn} ms=${row.stats ? row.stats.durationMs : '-'} wall=${row.wallMs} restored=${row.restored} ${row.url}`);
    if (crit.length) {
      for (const finding of row.findings) {
        console.log(`    ${finding.severity[0].toUpperCase()} ${finding.kind}: ${finding.details}`);
      }
      for (const file of await clipShots(dbg, id, crit)) console.log(`    clip ${file}`);
    }
    return { row, found };
  } finally {
    try { dbg.detach(); } catch {}
    win.destroy();
  }
}

async function run() {
  fs.mkdirSync(outDir, { recursive: true });
  const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-visual-qa-esbuild-'));
  esbuild.buildSync({
    entryPoints: { integrity: path.join(root, 'src/main/qa/scanners/layout-integrity-engine.ts') },
    bundle: true, format: 'cjs', platform: 'node', outdir: bundleDir, logLevel: 'error',
  });
  const { LayoutIntegrityEngine } = require(path.join(bundleDir, 'integrity.js'));
  const sites = SITES.filter(([site]) => !only || site === only);
  if (!sites.length) throw new Error(`No site matches --only=${only} (known: ${SITES.map(([site]) => site).join(', ')})`);
  const rows = [];
  for (const [site, home] of sites) {
    const urls = { home };
    for (const vp of viewports) {
      for (const page of PAGES) {
        const id = `${site}-${page}-${vp.name}`;
        let row;
        if (!urls[page]) {
          row = { id, url: null, measured: false, stats: null, wallMs: null, restored: null, findings: [], unmeasuredReason: `discovery found no ${page} link on the mobile home page` };
        } else {
          const discover = page === 'home' && vp.name === 'mobile';
          const result = await measurePage(LayoutIntegrityEngine, id, urls[page], vp, discover);
          row = result.row;
          if (discover && result.found) {
            if (result.found.product) urls.product = result.found.product;
            if (result.found.collection) urls.collection = result.found.collection;
          }
        }
        if (!row.measured) console.log(`${id} unmeasured ${row.unmeasuredReason} ${row.url || '-'}`);
        rows.push(row);
      }
    }
  }
  const expected = sites.length * PAGES.length * viewports.length;
  const measured = rows.filter((row) => row.measured);
  const unmeasured = rows.filter((row) => !row.measured).map((row) => row.id);
  const withCritical = measured.filter((row) => row.findings.some((finding) => finding.severity === 'critical')).map((row) => row.id);
  const unrestored = measured.filter((row) => row.restored !== true).length;
  const maxMs = Math.max(0, ...measured.map((row) => (row.stats && row.stats.durationMs) || 0));
  fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log(`SUMMARY pages=${measured.length}/${expected} unmeasured=${unmeasured.join(',')} withCritical=${withCritical.join(',')} unrestored=${unrestored} maxMs=${maxMs} out=${outDir}`);
  exitCode = measured.length === expected && unrestored === 0 && withCritical.length === 0 ? 0 : 1;
}

app.whenReady().then(() => run()).then(() => app.exit(exitCode)).catch(fail);
