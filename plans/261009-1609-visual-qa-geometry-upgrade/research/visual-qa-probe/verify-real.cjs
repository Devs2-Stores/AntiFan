// Throwaway: screenshot + geometry for specific findings on real storefronts (TP vs FP check).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LayoutIntegrityEngine } = require('./engines/integrity.js');

const OUT = path.join(__dirname, 'out-real');
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Scroll the element whose own text starts with `needle` to viewport middle; return rects of it and its colliders.
const focusText = (needle) => `(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const rectsOf = (n) => { const rg = document.createRange(); rg.selectNodeContents(n); return [...rg.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1); };
  while (w.nextNode()) {
    const n = w.currentNode;
    if (!n.nodeValue.trim().startsWith(${JSON.stringify(needle)})) continue;
    if (rectsOf(n).length === 0) continue;
    const p = n.parentElement;
    p.scrollIntoView({ block: 'center' });
    const r = p.getBoundingClientRect();
    const mine = rectsOf(n);
    const colliders = [];
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w2.nextNode()) {
      const m = w2.currentNode;
      if (m === n || !m.nodeValue.trim()) continue;
      for (const a of rectsOf(m)) for (const b of mine) {
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left), iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (ix > 1 && iy > 1 && colliders.length < 4) colliders.push({ text: m.nodeValue.trim().slice(0, 40), tag: m.parentElement.tagName.toLowerCase() + '.' + String(m.parentElement.className).trim().split(/\\s+/)[0], overlapPx: Math.round(ix) + 'x' + Math.round(iy), visible: m.parentElement.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) });
      }
    }
    const chain = []; for (let e = p; e && chain.length < 6; e = e.parentElement) { const s = getComputedStyle(e); chain.push(e.tagName.toLowerCase() + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' [pos=' + s.position + ' ov=' + s.overflow + ' h=' + Math.round(e.getBoundingClientRect().height) + ' op=' + s.opacity + ']'); }
    return { text: n.nodeValue.trim().slice(0, 60), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }, colliders, chain };
  }
  return null;
})()`;
const offscreenOwners = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('a[href], button')) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.left >= innerWidth && r.top < innerHeight && out.length < 4) {
      let owner = null;
      for (let e = el.parentElement; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.transform !== 'none' || s.position === 'fixed' || /hidden|clip/.test(s.overflowX)) { owner = e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).slice(0, 3).join('.') + ' [pos=' + s.position + ' tf=' + s.transform.slice(0, 30) + ' ovx=' + s.overflowX + ' vis=' + s.visibility + ']'; break; } }
      out.push({ text: el.textContent.trim().slice(0, 30), x: Math.round(r.left), owner });
    }
  }
  return out;
})()`;
const CASES = [
  { id: 'phukienmaymoc-copyright', url: 'https://phukienmaymoc.com/', focus: 'Copyright' },
  { id: 'gixjewel-price', url: 'https://gixjewel.com/', focus: '3,325,000' },
];

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-verify-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(9); });
app.whenReady().then(async () => {
  for (const c of CASES) {
    const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: VP.width, height: VP.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
    win.showInactive();
    await win.loadURL('data:text/html,<p>boot</p>');
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setDeviceMetricsOverride', VP);
    try { await win.loadURL(c.url); } catch (e) { console.log(c.id, 'load error', e.message); }
    await sleep(5000);
    const wc = win.webContents;
    let info;
    if (c.focus) {
      info = await wc.executeJavaScript(focusText(c.focus));
      await sleep(1200);
    } else {
      info = { offscreen: await wc.executeJavaScript(offscreenOwners) };
      const integ = await wc.executeJavaScript(LayoutIntegrityEngine.getBrowserScanScript('probe'));
      info.criticalSelectors = integ.findings.filter((f) => f.severity === 'critical').slice(0, 4).map((f) => `${f.kind} ${f.selector}`);
    }
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `${c.id}.png`), Buffer.from(shot.data, 'base64'));
    console.log(`## ${c.id}`);
    console.log(JSON.stringify(info, null, 1));
    dbg.detach();
    win.destroy();
  }
  app.quit();
});
