// Throwaway: is the gixjewel mobile banner-button occlusion real, or a pre-lazy-load state?
// gixjewel scrolls <body> (html visible, body overflow-y auto), so page-coordinate clips miss; scroll the
// target into view and capture the viewport instead.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out-v2-verify');
fs.mkdirSync(OUT, { recursive: true });
const VP = { width: 375, height: 667, deviceScaleFactor: 2, mobile: true };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-gixb-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

const STATE = (sel, i) => `(() => {
  const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}];
  if (!el) return { missing: true };
  const lab = (e) => e ? e.tagName.toLowerCase() + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') : null;
  const r = el.getBoundingClientRect();
  const box = el.closest('.block-banner-category');
  const br = box ? box.getBoundingClientRect() : null;
  const img = box ? box.querySelector('img') : null;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const stack = cy >= 0 && cy < innerHeight ? document.elementsFromPoint(cx, cy).slice(0, 4).map(lab) : 'offscreen';
  return {
    text: el.textContent.trim().slice(0, 30),
    btn: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
    box: br && [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)],
    boxPadBottom: box && getComputedStyle(box).paddingBottom,
    img: img && { src: (img.currentSrc || img.src || '').slice(-50), dataSrc: (img.getAttribute('data-src') || '').slice(-50), complete: img.complete, nh: img.naturalHeight, h: Math.round(img.getBoundingClientRect().height), cls: img.className },
    stack,
  };
})()`;

const SCROLL = (sel, i) => `(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' }); return !!el; })()`;

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
  const wc = win.webContents;
  const SEL = '.caption_banner a.button';
  const n = await wc.executeJavaScript(`document.querySelectorAll(${JSON.stringify(SEL)}).length`);
  console.log('buttons', n);
  for (let i = 0; i < n; i++) {
    console.log(`\n[${i}] before scroll`, JSON.stringify(await wc.executeJavaScript(STATE(SEL, i))));
    await wc.executeJavaScript(SCROLL(SEL, i));
    console.log(`[${i}] right after scroll`, JSON.stringify(await wc.executeJavaScript(STATE(SEL, i))));
    await sleep(2500);
    await wc.executeJavaScript(SCROLL(SEL, i));
    await sleep(500);
    console.log(`[${i}] after 3s in view`, JSON.stringify(await wc.executeJavaScript(STATE(SEL, i))));
    const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, `gix-banner-${i}.png`), Buffer.from(shot.data, 'base64'));
  }
  // The horizontally scrolling tab strip from the clipping finding.
  await wc.executeJavaScript(`(() => { const el = document.querySelector('#collection-navtabs-title'); if (el) el.scrollIntoView({ block: 'center', behavior: 'instant' }); })()`);
  await sleep(1500);
  const tabs = await wc.executeJavaScript(`(() => { const el = document.querySelector('#collection-navtabs-title'); if (!el) return null; const s = getComputedStyle(el); return { ovx: s.overflowX, sw: el.scrollWidth, cw: el.clientWidth, scrollbarHidden: s.scrollbarWidth }; })()`);
  console.log('\ntabs', JSON.stringify(tabs));
  const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, 'gix-tabs.png'), Buffer.from(shot.data, 'base64'));
  dbg.detach();
  win.destroy();
  app.quit();
});
