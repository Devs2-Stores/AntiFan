// Throwaway: does the integrity engine's layout-shift witness ever see a real shift?
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { LayoutIntegrityEngine } = require('./engines/integrity.js');
const fx = require('./fixtures.cjs').find((f) => f.id === '14-cls-shift');

app.setPath('userData', fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vqa-cls-')));
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
  // A screencast makes the compositor produce frames for a window nobody sees.
  let frames = 0;
  dbg.on('message', (_e, method, params) => {
    if (method === 'Page.screencastFrame') { frames++; dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {}); }
  });
  await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 });
  const file = path.join(__dirname, 'out', 'cls.html');
  fs.writeFileSync(file, fx.html);
  await win.loadFile(file);
  await sleep(2000);
  const wc = win.webContents;
  const integrity = await wc.executeJavaScript(LayoutIntegrityEngine.getBrowserScanScript('cls'));
  const facts = await wc.executeJavaScript(`(() => {
    // Same synchronous observe()+disconnect() pattern as the engine, on an entry type that needs no frames.
    performance.mark('probe-mark');
    let syncDelivered = 0;
    const o = new PerformanceObserver((l) => { syncDelivered += l.getEntries().length; });
    o.observe({ type: 'mark', buffered: true });
    o.disconnect();
    return {
      groundTruthCls: window.__truth.cls,
      timelineLayoutShiftEntries: performance.getEntriesByType('layout-shift').length,
      timelineMarkEntries: performance.getEntriesByType('mark').length,
      syncObserveThenDisconnectDelivered: syncDelivered,
    };
  })()`);
  console.log(JSON.stringify({ frames, facts, engineLayoutShiftFindings: integrity.findings.filter((f) => f.kind === 'layout-shift') }, null, 2));
  await dbg.sendCommand('Page.stopScreencast').catch(() => {});
  win.destroy();
  app.quit();
});
