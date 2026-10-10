// Throwaway: DOM shape + current engines + oracle on real Haravan storefront pages.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LayoutIntegrityEngine } = require('./engines/integrity.js');
const { LayoutOverflowEngine } = require('./engines/overflow.js');

const OUT = path.join(__dirname, 'out-real');
fs.mkdirSync(OUT, { recursive: true });
const ORACLE = fs.readFileSync(path.join(__dirname, 'oracle.js'), 'utf8');
const URLS = [
  ['phukienmaymoc', 'https://phukienmaymoc.com/'],
  ['gixjewel', 'https://gixjewel.com/'],
  ['hapas', 'https://hapas.vn/'],
  ['unitedvision', 'https://www.unitedvision.com.vn/'],
];
const STATS = `(() => {
  const all = Array.from(document.querySelectorAll('*'));
  const depth = (el) => { let d = 0; for (let e = el; e && e !== document.body; e = e.parentElement) d++; return d; };
  let maxDepth = 0, textEls = 0, textDeep = 0;
  for (const el of all) {
    const d = depth(el); if (d > maxDepth) maxDepth = d;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim())) { textEls++; if (d > 6) textDeep++; }
  }
  const footer = document.querySelector('footer, .footer, #footer, [class*="footer"]');
  return { nodes: all.length, maxDepth, textEls, textDeepPct: Math.round(100 * textDeep / Math.max(1, textEls)), footerIndex: footer ? all.indexOf(footer) : -1, scrollHeight: document.documentElement.scrollHeight };
})()`;
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-real-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(9); });
app.whenReady().then(async () => {
  const rows = [];
  for (const [id, url] of URLS) {
    const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: VP.width, height: VP.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
    win.showInactive();
    await win.loadURL('data:text/html,<p>boot</p>');
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', VP);
    try { await win.loadURL(url); } catch (e) { console.log(id, 'load error', e.message); }
    await sleep(5000);
    const wc = win.webContents;
    const stats = await wc.executeJavaScript(STATS);
    const overflow = await wc.executeJavaScript(LayoutOverflowEngine.getBrowserScanScript('probe'));
    const integrity = await wc.executeJavaScript(LayoutIntegrityEngine.getBrowserScanScript('probe'));
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${id}-top.png`), Buffer.from(shot.data, 'base64'));
    const t0 = Date.now();
    const oracle = await wc.executeJavaScript(ORACLE);
    const oracleMs = Date.now() - t0;
    rows.push({ id, url: wc.getURL(), title: wc.getTitle(), stats, overflow: { hasOverflow: overflow.hasOverflow, deltaX: overflow.deltaX, culprits: overflow.culprits.map((c) => c.selector).slice(0, 5) }, integrity: integrity.findings.map((f) => `${f.severity[0].toUpperCase()} ${f.kind}: ${f.details}`), oracleMs, oracle });
    dbg.detach();
    win.destroy();
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(rows, null, 2));
  for (const r of rows) {
    console.log(`## ${r.id} ${r.title} | ${r.url}`);
    console.log('  stats', JSON.stringify(r.stats));
    console.log('  overflow', JSON.stringify(r.overflow));
    console.log(`  integrity ${r.integrity.length}:`); r.integrity.slice(0, 12).forEach((s) => console.log('   ', s));
    console.log(`  oracle (${r.oracleMs}ms):`);
    for (const k of ['textCollision', 'coveredText', 'clippedText', 'flowOverlap']) { console.log(`   ${k} ${r.oracle[k].length}`); r.oracle[k].slice(0, 6).forEach((s) => console.log('     ', s)); }
  }
  app.quit();
});
