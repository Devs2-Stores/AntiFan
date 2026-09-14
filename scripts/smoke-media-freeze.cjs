const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { InjectedScriptStore } = require('../.compiled/src/main/browser/scripts/injected-script-store.js');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html,' + encodeURIComponent('<style>@keyframes moving { to { opacity: .2 } } .box { animation: moving 10s infinite; width: 100px; height: 100px; background: red }</style><div id="unrelated"><div class="slick-track" style="transform: translateX(20px)"><div class="box"></div></div></div>'));
    const store = new InjectedScriptStore({ overrideDir: null });
    await win.webContents.executeJavaScript(`window.hoverEvents = 0; document.getElementById('unrelated').addEventListener('mouseenter', () => window.hoverEvents++); window.originalRAF = requestAnimationFrame; window.originalCancel = cancelAnimationFrame; void 0;`);
    await win.webContents.executeJavaScript(store.getScript('media.freeze', { freeze: true, normalizeSliders: true }));
    const frozen = await win.webContents.executeJavaScript(`new Promise(resolve => { let cancelled = false; const id = requestAnimationFrame(() => { cancelled = true; }); cancelAnimationFrame(id); requestAnimationFrame(() => resolve({ cancelled, hoverEvents, nativeRAF: originalRAF === requestAnimationFrame && originalCancel === cancelAnimationFrame, animation: getComputedStyle(document.querySelector('.box')).animationPlayState, transform: document.querySelector('.slick-track').style.transform })); })`);
    assert.equal(frozen.nativeRAF, true);
    assert.equal(frozen.cancelled, false);
    assert.equal(frozen.hoverEvents, 0);
    assert.equal(frozen.animation, 'paused');
    await win.webContents.executeJavaScript(store.getScript('media.freeze', { freeze: false }));
    const restored = await win.webContents.executeJavaScript(`({ transform: document.querySelector('.slick-track').style.transform, animation: getComputedStyle(document.querySelector('.box')).animationPlayState, hoverEvents })`);
    assert.equal(restored.transform, 'translateX(20px)');
    assert.equal(restored.animation, 'running');
    assert.equal(restored.hoverEvents, 0);
    console.log(JSON.stringify({ verdict: 'PASS', frozen, restored }));
    win.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    win.destroy();
    app.exit(1);
  }
});
