// Throwaway: screenshot + style chain for every scan-v2 critical on the flagged live pages (TP vs FP).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out-v2-verify');
fs.mkdirSync(OUT, { recursive: true });
const V2 = fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8');
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const PAGES = [
  ['gix-home', 'https://gixjewel.com/'],
  ['gix-coll', 'https://gixjewel.com/collections/nhan-cuoi'],
  ['hapas-prod', 'https://hapas.vn/products/tui-xach-tay-aury?variant=1175444286'],
  ['uv-home', 'https://www.unitedvision.com.vn/'],
];
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-v2v-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

// Style chain of the element matched by the finding's text (or selector), up to 8 ancestors.
const CHAIN = (needle, sel) => `(() => {
  const pick = () => {
    if (${JSON.stringify(needle)}) {
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) if (w.currentNode.nodeValue.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(needle)})) return w.currentNode.parentElement;
    }
    try { return document.querySelector(${JSON.stringify(sel)}); } catch { return null; }
  };
  const el = pick();
  if (!el) return { missing: true };
  const out = [];
  for (let e = el, d = 0; e && e !== document.documentElement && d < 9; e = e.parentElement, d++) {
    const s = getComputedStyle(e);
    const r = e.getBoundingClientRect();
    out.push({ el: e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 3).join('.') : ''),
      pos: s.position, disp: s.display, ov: s.overflowX + '/' + s.overflowY, op: s.opacity, vis: s.visibility, tf: s.transform === 'none' ? '' : s.transform.slice(0, 40),
      tr: s.transitionProperty === 'all' && s.transitionDuration === '0s' ? '' : (s.transitionProperty + ' ' + s.transitionDuration).slice(0, 40), anim: e.getAnimations ? e.getAnimations().length : -1, z: s.zIndex,
      box: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], sw: e.scrollWidth, cw: e.clientWidth });
  }
  return { chain: out, doc: { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, htmlOv: getComputedStyle(document.documentElement).overflowX, bodyOv: getComputedStyle(document.body).overflowX } };
})()`;

app.whenReady().then(async () => {
  for (const [id, url] of PAGES) {
    if (ONLY && id !== ONLY) continue;
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
    try { await win.loadURL(url); } catch (e) { console.log(id, 'load error', e.message); }
    await sleep(5000);
    const res = await win.webContents.executeJavaScript(V2.replace('__VIEWPORT_NAME__', 'mobile'));
    const crit = res.findings.filter((f) => f.severity === 'critical');
    console.log(`\n## ${id} ${url} crit=${crit.length}`);
    for (let i = 0; i < crit.length; i++) {
      const f = crit[i];
      const m = /^Text "(.+?)(?:\.\.\.)?"/.exec(f.details) || /^Control (.+?) is covered/.exec(f.details);
      const needle = m && f.details.startsWith('Text') ? m[1] : '';
      const info = await win.webContents.executeJavaScript(CHAIN(needle, f.selector));
      console.log(`\n[${i}] ${f.kind}: ${f.details}\n rect=${JSON.stringify(f.rect)}`);
      console.log(JSON.stringify(info, null, 0).replace(/},{/g, '},\n  {'));
      const r = f.rect;
      const pad = 60;
      const clip = { x: 0, y: Math.max(0, r.y - pad), width: VP.width, height: Math.min(500, r.h + pad * 2), scale: 1 };
      try {
        const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true });
        fs.writeFileSync(path.join(OUT, `${id}-${i}.png`), Buffer.from(shot.data, 'base64'));
      } catch (e) {
        console.log(' shot failed', e.message);
      }
    }
    dbg.detach();
    win.destroy();
  }
  app.quit();
});
