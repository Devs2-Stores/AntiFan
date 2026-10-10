// Throwaway: classify the remaining scan-v2 live criticals (TP vs FP) with targeted geometry.
//  - gix-coll / hapas-prod / gix-home tabs: is the "cut by the viewport edge" text inside a scroll container?
//  - uv-home: are the hero slides a stacked deck (identical rects, one on top)?
//  - gix-home: do the banner-button occlusions survive a lazy-media materialization walk?
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const V2 = fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8');
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-cls-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

// Ancestors of the text node whose value starts with needle that clip or scroll on either axis.
const SCROLLERS = (needle) => `(() => {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let el = null;
  while (w.nextNode()) if (w.currentNode.nodeValue.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(needle)})) { el = w.currentNode.parentElement; break; }
  if (!el) return { missing: true };
  const out = [];
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.overflowX === 'visible' && s.overflowY === 'visible' && e.scrollWidth <= e.clientWidth + 1) continue;
    out.push({ el: e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : ''),
      ov: s.overflowX + '/' + s.overflowY, sw: e.scrollWidth, cw: e.clientWidth, ws: s.whiteSpace, to: s.textOverflow });
  }
  return { owner: el.tagName.toLowerCase(), chain: out, doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth } };
})()`;

const SLIDES = `(() => {
  const s = Array.from(document.querySelectorAll('.hero-slider > *')).map((e) => {
    const c = getComputedStyle(e); const r = e.getBoundingClientRect();
    return { cls: e.className, pos: c.position, op: c.opacity, vis: c.visibility, z: c.zIndex, tr: c.transitionProperty + ' ' + c.transitionDuration,
      rect: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], bg: c.backgroundImage !== 'none' };
  });
  const ov = document.querySelector('.hero-overlay'); const oc = ov && getComputedStyle(ov);
  return { slides: s, overlay: oc && { bg: oc.backgroundColor, pos: oc.position } };
})()`;

// Bounded materialization walk (same shape as buildReferenceMaterializationScript, without data-src swaps).
const MATERIALIZE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const body = document.body;
  const bodyScrolls = getComputedStyle(body).overflowY !== 'visible' && body.scrollHeight > body.clientHeight + 1;
  const H = () => (bodyScrolls ? body.scrollHeight : Math.max(document.documentElement.scrollHeight, body.scrollHeight));
  const to = (y) => (bodyScrolls ? body.scrollTo(0, y) : window.scrollTo(0, y));
  for (let y = 0; y <= H(); y += Math.floor(innerHeight * 0.8)) { to(y); await sleep(120); }
  const t0 = Date.now();
  const pending = () => Array.from(document.images).filter((i) => i.loading !== 'lazy' || i.getBoundingClientRect().height > 0).filter((i) => !i.complete).length;
  while (pending() > 0 && Date.now() - t0 < 8000) await sleep(200);
  to(0);
  return { height: H(), pendingAfter: pending(), waitedMs: Date.now() - t0 };
})()`;

async function open(url) {
  const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: VP.width, height: VP.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', VP);
  await dbg.sendCommand('Page.enable');
  dbg.on('message', (_e, method, params) => {
    if (method === 'Page.screencastFrame') dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  try { await win.loadURL(url); } catch (e) { console.log('load error', e.message); }
  await sleep(5000);
  return { win, dbg, wc: win.webContents };
}
const crits = (res) => res.findings.filter((f) => f.severity === 'critical').map((f) => f.kind + ': ' + f.details.slice(0, 150));

app.whenReady().then(async () => {
  for (const [id, url, needles] of [
    ['gix-coll', 'https://gixjewel.com/collections/nhan-cuoi', ['Giá nhẫn cưới tham khảo']],
    ['hapas-prod', 'https://hapas.vn/products/tui-xach-tay-aury?variant=1175444286', ['Túi Xách Tay Aury Size 19']],
    ['gix-home', 'https://gixjewel.com/', ['NHẪN CẦU HÔN GIẢM NGAY 5%']],
  ]) {
    const { win, dbg, wc } = await open(url);
    for (const n of needles) console.log(`## ${id} scrollers "${n}"`, JSON.stringify(await wc.executeJavaScript(SCROLLERS(n))));
    if (id === 'gix-home') {
      console.log('## gix-home before materialize', JSON.stringify(crits(await wc.executeJavaScript(V2.replace('__VIEWPORT_NAME__', 'mobile'))), null, 1));
      console.log('## gix-home materialize', JSON.stringify(await wc.executeJavaScript(MATERIALIZE)));
      await sleep(1000);
      console.log('## gix-home after materialize', JSON.stringify(crits(await wc.executeJavaScript(V2.replace('__VIEWPORT_NAME__', 'mobile'))), null, 1));
    }
    dbg.detach();
    win.destroy();
  }
  {
    const { win, dbg, wc } = await open('https://www.unitedvision.com.vn/');
    console.log('## uv-home slides', JSON.stringify(await wc.executeJavaScript(SLIDES), null, 1));
    dbg.detach();
    win.destroy();
  }
  app.quit();
});
