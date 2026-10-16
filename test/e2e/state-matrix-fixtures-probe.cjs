// Fixture lane for src/main/qa/state-matrix.ts.
// Run: node scripts/run-electron.cjs test/e2e/state-matrix-fixtures-probe.cjs [--only=<id-prefix>]
// Bundles the module from src/ with esbuild and drives it with trusted CDP input (mouse and key
// events dispatched through Input.*, never element.click()), the same input class the live tab
// host uses. Each fixture runs at 1280x800 and 390x844 in an offscreen window with a throwaway
// userData directory, so a developer's running AntiFan instance is never touched.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const only = (process.argv.find((arg) => arg.startsWith('--only=')) || '').slice(7);
const viewports = [
  { name: 'desktop', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  { name: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
];
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-state-matrix-'));
app.setPath('userData', path.join(workDir, 'userdata'));
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.on('window-all-closed', () => {});

let exitCode = 2;
function fail(error) {
  console.error(error && error.stack ? error.stack : error);
  app.exit(2);
}
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function openAt(vp) {
  const win = new BrowserWindow({
    show: false, x: -4000, y: 0, useContentSize: true, width: vp.width, height: vp.height,
    skipTaskbar: true, focusable: false, webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();
  // The debugger must attach to a navigated contents.
  await win.loadURL('data:text/html,<p>boot</p>');
  const dbg = win.webContents.debugger;
  dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setDeviceMetricsOverride', vp);
  return { win, dbg };
}

function makeDeps(win, dbg) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const mouse = async (type, x, y, extra = {}) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
  const centerOf = (selector) => js(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, error: 'SELECTOR_NOT_FOUND' };
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return { ok: false, error: 'ZERO_BOX' };
    const x = Math.round(r.left + r.width / 2); const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    // Same actionability rule as the live host: the centre must hit the element itself.
    if (!hit || (hit !== el && !el.contains(hit))) return { ok: false, error: 'OCCLUDED by ' + (hit ? hit.tagName + '.' + hit.className : 'nothing') };
    return { ok: true, x, y };
  })()`);
  const clickAt = async (x, y) => {
    await mouse('mouseMoved', x, y, { button: 'none' });
    await mouse('mousePressed', x, y, { clickCount: 1 });
    await mouse('mouseReleased', x, y, { clickCount: 1 });
    return { ok: true };
  };
  return {
    evalJs: (script) => js(script),
    click: async (selector) => {
      const c = await centerOf(selector);
      if (!c.ok) return c;
      return clickAt(c.x, c.y);
    },
    clickAt,
    hover: async (selector) => {
      const c = await centerOf(selector);
      if (!c.ok) return c;
      await mouse('mouseMoved', c.x, c.y, { button: 'none' });
      return { ok: true };
    },
    hoverAt: async (x, y) => {
      await mouse('mouseMoved', x, y, { button: 'none' });
      return { ok: true };
    },
    pressKey: async (key) => {
      const def = key === 'Escape'
        ? { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }
        : { key, code: key, windowsVirtualKeyCode: 0 };
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def });
      await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...def });
      return { ok: true };
    },
    wait: (ms) => sleep(ms),
  };
}

function judge(fixture, res) {
  const e = fixture.expect || {};
  const failures = [];
  if (typeof e.triggers === 'number' && res.triggers.length !== e.triggers) failures.push(`triggers ${res.triggers.length} != ${e.triggers}`);
  if (typeof e.measured === 'boolean' && res.measured !== e.measured) failures.push(`measured ${res.measured} != ${e.measured}`);
  for (const reason of e.skipped || []) {
    if (!res.skippedTriggers.some((s) => s.reason === reason)) failures.push(`skipped reason ${reason} missing (${JSON.stringify(res.skippedTriggers)})`);
  }
  for (const [idx, status] of Object.entries(e.status || {})) {
    const t = res.triggers[Number(idx)];
    if (!t) { failures.push(`trigger ${idx} missing`); continue; }
    if (t.status !== status) failures.push(`trigger ${idx} status ${t.status} != ${status} (${t.failures.map((f) => f.code).join(',') || 'no failures'})`);
  }
  for (const [idx, codes] of Object.entries(e.codes || {})) {
    const t = res.triggers[Number(idx)];
    for (const code of codes) if (!t || !t.failures.some((f) => f.code === code)) failures.push(`trigger ${idx} missing ${code}`);
  }
  for (const [idx, fragment] of Object.entries(e.panelMatches || {})) {
    const t = res.triggers[Number(idx)];
    if (!t || !String(t.panel || '').includes(fragment)) failures.push(`trigger ${idx} measured panel "${t && t.panel}" instead of one matching "${fragment}"`);
  }
  for (const [idx, methods] of Object.entries(e.closeClosed || {})) {
    const t = res.triggers[Number(idx)];
    for (const method of methods) {
      const attempt = t && t.closes.find((c) => c.method === method);
      if (!attempt || !attempt.closed) failures.push(`trigger ${idx} did not close by ${method} (${JSON.stringify(attempt)})`);
    }
  }
  for (const [idx, byMethod] of Object.entries(e.closeSkipped || {})) {
    const t = res.triggers[Number(idx)];
    for (const [method, prefix] of Object.entries(byMethod)) {
      const attempt = t && t.closes.find((c) => c.method === method);
      if (!attempt || !String(attempt.skipped || '').startsWith(prefix)) failures.push(`trigger ${idx} ${method} attempt not skipped with ${prefix} (${JSON.stringify(attempt)})`);
    }
  }
  for (const [idx, codes] of Object.entries(e.noCodes || {})) {
    const t = res.triggers[Number(idx)];
    for (const code of codes) if (t && t.failures.some((f) => f.code === code)) failures.push(`trigger ${idx} unexpected ${code}: ${t.failures.find((f) => f.code === code).message}`);
  }
  return failures;
}

async function run() {
  const bundleDir = path.join(workDir, 'bundle');
  esbuild.buildSync({
    entryPoints: { sm: path.join(root, 'src/main/qa/state-matrix.ts') },
    bundle: true, format: 'cjs', platform: 'node', outdir: bundleDir, logLevel: 'error',
  });
  const { runStateMatrix } = require(path.join(bundleDir, 'sm.js'));
  const corpus = require(path.join(root, 'test/fixtures/state-matrix/fixtures.cjs')).filter((f) => !only || f.id.startsWith(only));
  if (!corpus.length) throw new Error(`No fixture matches --only=${only}`);
  let failed = 0;
  for (const vp of viewports) {
    const { win, dbg } = await openAt(vp);
    for (const fixture of corpus) {
      const htmlPath = path.join(workDir, `${vp.name}-${fixture.id}.html`);
      fs.writeFileSync(htmlPath, fixture.html, 'utf8');
      await win.webContents.loadFile(htmlPath);
      await sleep(150);
      const startedUrl = win.webContents.getURL();
      const res = await runStateMatrix(makeDeps(win, dbg), { settleMs: 250 });
      const failures = judge(fixture, res);
      if (win.webContents.getURL() !== startedUrl) failures.push(`navigated away: ${win.webContents.getURL()}`);
      const leftovers = await win.webContents.executeJavaScript('document.querySelectorAll("[data-antifan-sm-trigger],[data-antifan-sm-panel],[data-antifan-sm-close],[data-antifan-sm-box]").length + (window.__antifanStateMatrixGuard ? 100 : 0)');
      if (leftovers) failures.push(`cleanup left ${leftovers} marker(s)`);
      if (fixture.expect && fixture.expect.bodyUntouched) {
        const touched = await win.webContents.executeJavaScript(`document.body.dataset[${JSON.stringify(fixture.expect.bodyUntouched)}] || ''`);
        if (touched) failures.push(`a store-mutating control was clicked (body.dataset.${fixture.expect.bodyUntouched}=${touched})`);
      }
      if (failures.length) failed++;
      const brief = res.triggers.map((t) => `${t.index}:${t.kind}:${t.status}[${t.failures.map((f) => f.code).join(',')}]{${t.closes.map((c) => `${c.method}=${c.closed ? 'closed' : c.skipped || 'open'}`).join(' ')}}`).join(' ');
      console.log(`${failures.length ? 'FAIL' : 'PASS'} ${vp.name} ${fixture.id} ${brief || '(no triggers)'} ${res.durationMs}ms${failures.length ? `\n    ${failures.join('\n    ')}` : ''}`);
    }
    win.destroy();
  }
  const total = corpus.length * viewports.length;
  console.log(`SUMMARY runs=${total} pass=${total - failed} fail=${failed} workDir=${workDir}`);
  exitCode = failed ? 1 : 0;
}

app.whenReady().then(run).then(() => app.exit(exitCode), fail);
