// Throwaway: is the unitedvision desktop hero a stacked slide deck or a crossfade caught mid-transition?
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, 'out-v2-verify');
fs.mkdirSync(OUT, { recursive: true });
const VP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-uv-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.on('window-all-closed', () => {});
process.on('unhandledRejection', (e) => { console.log('UNHANDLED', e && e.stack ? e.stack : e); process.exit(9); });
process.on('uncaughtException', (e) => { console.log('UNCAUGHT', e && e.stack ? e.stack : e); process.exit(9); });
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const DECK = `(() => {
  const slides = Array.from(document.querySelectorAll('.hero-slider > .slide'));
  const anims = document.getAnimations().map((a) => ({ type: a.constructor.name, prop: a.transitionProperty || a.animationName || '', target: a.effect && a.effect.target ? (a.effect.target.className || a.effect.target.tagName) : null, state: a.playState }));
  return {
    t: Math.round(performance.now()),
    slides: slides.map((s) => {
      const cs = getComputedStyle(s);
      const r = s.getBoundingClientRect();
      const ov = s.querySelector('.hero-overlay');
      const ovs = ov ? getComputedStyle(ov) : null;
      return { cls: s.className, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], pos: cs.position, op: cs.opacity, vis: cs.visibility, z: cs.zIndex, tr: cs.transition.slice(0, 80), bg: cs.backgroundImage.slice(0, 40), overlay: ovs ? { bg: ovs.backgroundColor, op: ovs.opacity, pos: ovs.position } : null, checkVis: s.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) };
    }),
    anims: anims.slice(0, 12),
  };
})()`;

const LOG = path.join(__dirname, 'uv-deck.out');
fs.writeFileSync(LOG, '');
const log = (s) => fs.appendFileSync(LOG, s + '\n');
app.on('will-quit', () => log('will-quit'));
process.on('exit', (c) => log('exit ' + c));
app.whenReady().then(async () => {
  log('ready');
  const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: VP.width, height: VP.height, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.webContents.on('render-process-gone', (_e, d) => log('render gone ' + JSON.stringify(d)));
  win.showInactive();
  log('shown');
  // Attaching the debugger before the first navigation kills Electron 43 (exit 3, no JS error).
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', VP);
  await dbg.sendCommand('Page.enable');
  dbg.on('message', (_e, method, params) => {
    if (method === 'Page.screencastFrame') dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  try { await win.loadURL('https://www.unitedvision.com.vn/'); } catch (e) { log('load error ' + e.message); }
  log('loaded');
  await sleep(5000);
  for (let i = 0; i < 6; i++) {
    log(JSON.stringify(await win.webContents.executeJavaScript(DECK)));
    if (i === 0 || i === 3) {
      const shot = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 900, scale: 0.5 } });
      fs.writeFileSync(path.join(OUT, `uv-deck-${i}.png`), Buffer.from(shot.data, 'base64'));
    }
    await sleep(700);
  }
  dbg.detach();
  win.destroy();
  app.quit();
});
