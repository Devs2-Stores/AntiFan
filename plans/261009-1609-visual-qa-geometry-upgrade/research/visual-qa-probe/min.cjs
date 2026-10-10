const { app, BrowserWindow } = require('electron');
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  console.log('ready');
  try {
    const win = new BrowserWindow({ show: false, width: 375, height: 667 });
    console.log('window created');
    win.webContents.debugger.attach('1.3');
    console.log('attached');
    await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width: 375, height: 667, deviceScaleFactor: 2, mobile: true });
    console.log('emulated');
    await win.loadURL('data:text/html,<p>hi</p>');
    console.log('loaded', await win.webContents.executeJavaScript('document.body.innerText'));
    win.destroy();
  } catch (e) {
    console.log('ERR', e && e.stack);
  }
  app.quit();
});
