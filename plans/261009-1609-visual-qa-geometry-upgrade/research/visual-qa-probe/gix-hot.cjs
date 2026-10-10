// Throwaway: screenshot every scan-v2 critical on gixjewel home AFTER a materialization walk (TP vs FP).
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out-v2-verify');
fs.mkdirSync(OUT, { recursive: true });
const V2 = fs.readFileSync(path.join(__dirname, 'scan-v2.js'), 'utf8');
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-hot-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

const MATERIALIZE = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const body = document.body;
  const bodyScrolls = getComputedStyle(body).overflowY !== 'visible' && body.scrollHeight > body.clientHeight + 1;
  const H = () => (bodyScrolls ? body.scrollHeight : Math.max(document.documentElement.scrollHeight, body.scrollHeight));
  const to = (y) => (bodyScrolls ? body.scrollTo(0, y) : window.scrollTo(0, y));
  for (let y = 0; y <= H(); y += Math.floor(innerHeight * 0.8)) { to(y); await sleep(120); }
  const t0 = Date.now();
  while (Array.from(document.images).some((i) => !i.complete) && Date.now() - t0 < 8000) await sleep(200);
  to(0);
  return true;
})()`;

// Scroll the finding's owner (matched by text needle or selector) to the viewport middle; report its stack.
const FOCUS = (needle, sel) => `(() => {
  let el = null;
  if (${JSON.stringify(needle)}) {
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) if (w.currentNode.nodeValue.replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(needle)})) { el = w.currentNode.parentElement; break; }
  }
  if (!el) { try { el = document.querySelectorAll(${JSON.stringify(sel)})[0]; } catch {} }
  if (!el) return { missing: true };
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const name = (e) => e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '');
  const chain = [];
  for (let e = el; e && e !== document.body; e = e.parentElement) {
    const s = getComputedStyle(e);
    if (s.position !== 'static' || s.overflowY !== 'visible' || s.height.endsWith('px') && e.style.height) chain.push(name(e) + '{pos:' + s.position + ',ov:' + s.overflowX + '/' + s.overflowY + ',h:' + Math.round(e.getBoundingClientRect().height) + ',sh:' + e.scrollHeight + ',op:' + s.opacity + ',tr:' + s.transitionProperty + '}');
    if (chain.length > 7) break;
  }
  return { rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], stack: document.elementsFromPoint(cx, cy).slice(0, 5).map(name), chain };
})()`;

app.whenReady().then(async () => {
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
  try { await win.loadURL('https://gixjewel.com/'); } catch (e) { console.log('load error', e.message); }
  await sleep(5000);
  await win.webContents.executeJavaScript(MATERIALIZE);
  await sleep(1000);
  const res = await win.webContents.executeJavaScript(V2.replace('__VIEWPORT_NAME__', 'mobile'));
  const crit = res.findings.filter((f) => f.severity === 'critical');
  for (let i = 0; i < crit.length; i++) {
    const f = crit[i];
    const m = /^Text "(.+?)(?:\.\.\.)?"/.exec(f.details);
    const ctl = /^(?:Control|Actionable controls stacked:) (.+?) (?:is covered|covers)/.exec(f.details);
    const info = await win.webContents.executeJavaScript(FOCUS(m ? m[1] : '', ctl ? ctl[1] : f.selector));
    await sleep(800);
    console.log(`\n[${i}] ${f.kind}: ${f.details.slice(0, 170)}\n ${JSON.stringify(info)}`);
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `gix-hot-${i}.png`), Buffer.from(shot.data, 'base64'));
  }
  dbg.detach();
  win.destroy();
  app.quit();
});
