// Throwaway: why did the oracle see the gixjewel price colliding with a clamped title line?
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE = `(() => {
  const rectsOf = (n) => { const rg = document.createRange(); rg.selectNodeContents(n); return [...rg.getClientRects()].filter((r) => r.width >= 1 && r.height >= 1); };
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let price = null;
  while (w.nextNode()) { const n = w.currentNode; if (n.nodeValue.trim().startsWith('3,325,000') && rectsOf(n).length) { price = n; break; } }
  if (!price) return { error: 'price not found' };
  price.parentElement.scrollIntoView({ block: 'center' });
  const mine = rectsOf(price);
  const out = { price: mine.map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]), colliders: [] };
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (w2.nextNode()) {
    const m = w2.currentNode;
    if (m === price || !m.nodeValue.trim()) continue;
    const rs = rectsOf(m);
    const hit = rs.some((a) => mine.some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
    if (!hit) continue;
    const chain = [];
    for (let e = m.parentElement; e && chain.length < 5; e = e.parentElement) {
      const s = getComputedStyle(e); const b = e.getBoundingClientRect();
      chain.push({ el: e.tagName.toLowerCase() + '.' + String(e.className).trim().split(/\\s+/).join('.'), display: s.display, clamp: s.webkitLineClamp, ovx: s.overflowX, ovy: s.overflowY, lh: s.lineHeight, pad: s.padding, box: [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)], client: [e.clientWidth, e.clientHeight] });
    }
    out.colliders.push({ text: m.nodeValue.trim().slice(0, 60), lines: rs.map((r) => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]), chain });
    if (out.colliders.length >= 2) break;
  }
  return out;
})()`;
app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-gix-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exit(9); });
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: VP.width, height: VP.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', VP);
  try { await win.loadURL('https://gixjewel.com/'); } catch (e) { console.log('load error', e.message); }
  await sleep(5000);
  console.log(JSON.stringify(await win.webContents.executeJavaScript(PROBE), null, 1));
  dbg.detach();
  win.destroy();
  app.quit();
});
