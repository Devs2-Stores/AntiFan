// Throwaway probe: run AntiFan's CURRENT QA scanner scripts (bundled from src/)
// against fixtures with known layout defects, in real Chromium (Electron 43).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LayoutIntegrityEngine } = require('./engines/integrity.js');
const { LayoutOverflowEngine } = require('./engines/overflow.js');
const fixtures = require('./fixtures.cjs');

const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const ORACLE = fs.readFileSync(path.join(__dirname, 'oracle.js'), 'utf8');

// Verbatim copy of the per-breakpoint document check in NativeTabHost.runResponsiveCheck.
const SWEEP = `(() => {
  const docEl = document.documentElement; const body = document.body;
  const scrollW = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0);
  const clientW = docEl ? docEl.clientWidth : window.innerWidth;
  return { scrollWidth: scrollW, clientWidth: clientW, hasHorizontalOverflow: scrollW > clientW + 1 };
})()`;

const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-probe-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('uncaughtException', (e) => { console.error('UNCAUGHT', e); process.exit(9); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(9); });
console.log('probe start');
app.whenReady().then(async () => {
  console.log('ready');
  const rows = [];
  for (const fx of fixtures) {
    console.log('fixture', fx.id);
    const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: VP.width, height: VP.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
    win.showInactive();
    await win.loadURL('data:text/html,<p>boot</p>');
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', VP);
    const file = path.join(OUT, `${fx.id}.html`);
    fs.writeFileSync(file, fx.html);
    await win.loadFile(file);
    await sleep(fx.settleMs || 600);
    const wc = win.webContents;
    const overflow = await wc.executeJavaScript(LayoutOverflowEngine.getBrowserScanScript('probe'));
    const sweep = await wc.executeJavaScript(SWEEP);
    const integrity = await wc.executeJavaScript(LayoutIntegrityEngine.getBrowserScanScript('probe'));
    const oracle = await wc.executeJavaScript(ORACLE);
    const truth = await wc.executeJavaScript("window.__truth ? Object.assign(window.__truth, { timelineEntries: performance.getEntriesByType('layout-shift').length, observerSupported: PerformanceObserver.supportedEntryTypes.includes('layout-shift') }) : null");
    try {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${fx.id}.png`), Buffer.from(shot.data, 'base64'));
    } catch (e) {
      console.log('  screenshot failed:', e.message);
    }
    const crit = integrity.findings.filter((f) => f.severity === 'critical');
    const warn = integrity.findings.filter((f) => f.severity !== 'critical');
    rows.push({
      id: fx.id,
      defect: fx.defect,
      domElements: await wc.executeJavaScript('document.querySelectorAll("*").length'),
      overflowEngine: { hasOverflow: overflow.hasOverflow, deltaX: overflow.deltaX, culprits: overflow.culprits.map((c) => c.selector) },
      sweep,
      integrity: {
        measured: integrity.measured,
        critical: crit.map((f) => `${f.kind}: ${f.details}`),
        warning: warn.map((f) => `${f.kind}: ${f.details}`),
      },
      workflowVerdictImpact: overflow.hasOverflow || sweep.hasHorizontalOverflow || crit.length > 0 ? 'FAIL' : warn.length > 0 ? 'PASS + visualAmbiguities' : 'PASS',
      oracle,
      truth,
    });
    dbg.detach();
    win.destroy();
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  for (const r of rows) {
    const o = r.oracle;
    const oracleHits = ['textCollision', 'coveredText', 'clippedText', 'flowOverlap'].filter((k) => o[k].length).map((k) => `${k}(${o[k].length})`).join(',') || '-';
    console.log(`${r.id.padEnd(34)} verdict=${r.workflowVerdictImpact.padEnd(24)} crit=${r.integrity.critical.length} warn=${r.integrity.warning.length} ovf=${r.overflowEngine.hasOverflow}/${r.sweep.hasHorizontalOverflow} oracle=${oracleHits}${r.truth ? ' truth=' + JSON.stringify(r.truth) : ''}`);
  }
  app.quit();
});
