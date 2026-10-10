// Throwaway: does observe({buffered:true}) + takeRecords() return buffered layout-shift entries synchronously?
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const fx = require('./fixtures.cjs').find((f) => f.id === '14-cls-shift');

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-cls2-')));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, x: -4000, y: 0, useContentSize: true, width: 375, height: 667, skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false } });
  win.showInactive();
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Page.enable');
  dbg.on('message', (_e, method, params) => {
    if (method === 'Page.screencastFrame') dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  const file = path.join(__dirname, 'out', 'cls2.html');
  fs.writeFileSync(file, fx.html);
  await win.loadFile(file);
  await sleep(2000);
  const facts = await win.webContents.executeJavaScript(`(() => {
    let viaTakeRecords = 0, count = 0;
    const o = new PerformanceObserver(() => {});
    o.observe({ type: 'layout-shift', buffered: true });
    for (const e of o.takeRecords()) { count++; if (!e.hadRecentInput) viaTakeRecords += e.value; }
    o.disconnect();
    return { groundTruthCls: window.__truth.cls, viaTakeRecords, count };
  })()`);
  console.log(JSON.stringify(facts));
  await dbg.sendCommand('Page.stopScreencast').catch(() => {});
  win.destroy();
  app.quit();
});
