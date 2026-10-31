// Empirical probe: what a minimized host window does to a tab's render surface, and whether
// NativeTabHost.restoreHostWindowUnfocused brings it back without taking focus.
// Run: node scripts/run-electron.cjs test/e2e/host-window-minimize-probe.cjs
// Bundles src/main/verification/visual-capture.ts and src/main/browser/native-tab-host.ts with
// esbuild (no .compiled needed), opens a real BrowserWindow with a throwaway userData directory, and
// drives the real host methods on a partially constructed host (Object.create + the fields they
// read). It checks, in order:
//   1. visible window: presentation says not hidden, the render-surface probe measures > 0x0
//   2. minimized window: presentation says hidden + minimized, the probe reading is recorded and the
//      remedy for it points at tabs.activate {restoreWindow:true}, never at set_viewport
//   3. restoreHostWindowUnfocused: restored:true, window no longer minimized, window NOT focused
//   4. after restore the probe measures > 0x0 again
//   5. a second restore is a no-op (no window call)
// Exit code 0 only when every check passes; 1 on a failed check; 2 on a harness fault.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '../..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-host-window-minimize-'));
app.setPath('userData', path.join(workDir, 'userdata'));
app.commandLine.appendSwitch('no-sandbox');
app.on('window-all-closed', () => {});

let exitCode = 2;
function fail(error) {
  console.error(error && error.stack ? error.stack : error);
  app.exit(2);
}
process.on('unhandledRejection', fail);
process.on('uncaughtException', fail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function bundle(entry, name) {
  esbuild.buildSync({
    entryPoints: { [name]: path.join(root, entry) },
    bundle: true, format: 'cjs', platform: 'node', outdir: path.join(workDir, 'bundle'), logLevel: 'error',
    packages: 'external', external: ['electron'],
  });
  return require(path.join(workDir, 'bundle', `${name}.js`));
}

async function run() {
  // The bundles leave node_modules imports external; resolve them from the repo, not the temp dir.
  process.env.NODE_PATH = [path.join(root, 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter);
  Module._initPaths();
  const capture = bundle('src/main/verification/visual-capture.ts', 'vc');
  // pty-worker-host resolves its worker with require.resolve('./pty-worker') at load, which esbuild
  // leaves as is; build the real worker beside the bundle, as the daemon host stager does.
  esbuild.buildSync({
    entryPoints: { 'pty-worker': path.join(root, 'src/main/browser/pty-worker.ts') },
    bundle: true, format: 'cjs', platform: 'node', outdir: path.join(workDir, 'bundle'), logLevel: 'error',
    packages: 'external', external: ['electron'],
  });
  const { NativeTabHost } = bundle('src/main/browser/native-tab-host.ts', 'nth');

  const win = new BrowserWindow({
    show: false, x: 80, y: 80, width: 900, height: 600, useContentSize: true, skipTaskbar: true,
    webPreferences: { backgroundThrottling: false },
  });
  win.showInactive();
  await win.loadURL('data:text/html,<body style="margin:0"><p>probe</p></body>');

  const host = Object.create(NativeTabHost.prototype);
  host.tabs = new Map([['tab-1', { state: { id: 'tab-1' } }]]);
  host.activeTabId = 'tab-1';
  host.shell = { window: win };
  host.unfocusedWindowPresenter = null;

  const calls = [];
  for (const method of ['restore', 'showInactive', 'show', 'focus', 'maximize']) {
    const original = win[method].bind(win);
    win[method] = (...args) => { calls.push(method); return original(...args); };
  }

  const probe = async () => {
    const value = await win.webContents.executeJavaScript(capture.RENDER_SURFACE_PROBE_EXPRESSION);
    return value && typeof value === 'object' ? value : null;
  };
  const results = [];
  const check = (id, ok, detail) => {
    const passed = Boolean(ok);
    results.push(passed);
    console.log(`${passed ? 'PASS' : 'FAIL'} ${id}${detail ? ` ${detail}` : ''}`);
  };

  // 1. Visible window.
  await sleep(250);
  const visiblePresentation = host.getHostWindowPresentation('tab-1');
  const visibleSurface = await probe();
  check('visible.presentation', visiblePresentation && visiblePresentation.hostWindowHidden === false, JSON.stringify(visiblePresentation));
  check('visible.surface-measured', visibleSurface && visibleSurface.vw > 0 && visibleSurface.vh > 0, JSON.stringify(visibleSurface));

  // 2. Minimized window.
  console.log(`OBSERVED focus before minimize isFocused=${win.isFocused()}`);
  win.minimize();
  await waitFor(() => win.isMinimized(), 'the window to minimize');
  await sleep(300);
  const hiddenPresentation = host.getHostWindowPresentation('tab-1');
  check('minimized.presentation', hiddenPresentation && hiddenPresentation.hostWindowHidden === true && hiddenPresentation.minimized === true, JSON.stringify(hiddenPresentation));
  let hiddenSurface = null;
  try {
    hiddenSurface = await Promise.race([probe(), sleep(3000).then(() => 'timeout')]);
  } catch (error) {
    hiddenSurface = `threw: ${error && error.message}`;
  }
  // Observation, not a verdict: whether Chromium keeps laying a minimized page out differs by
  // version; the remedy must be correct either way, so only it is asserted.
  console.log(`OBSERVED minimized surface ${JSON.stringify(hiddenSurface)} cause=${typeof hiddenSurface === 'object' && hiddenSurface ? capture.classifyRenderSurfaceCause(hiddenSurface) : 'unmeasurable'}`);
  const remedy = capture.renderSurfaceRemedy({ cause: 'window-not-presented', hostWindowHidden: hiddenPresentation.hostWindowHidden });
  check('minimized.remedy', remedy.hostWindowHidden === true && /restoreWindow:true/.test(remedy.text) && !/Call anti\.browser\.set_viewport/.test(remedy.text), remedy.steps.join(' > '));

  // 3. Restore without focus.
  calls.length = 0;
  const restored = host.restoreHostWindowUnfocused('tab-1');
  await waitFor(() => !win.isMinimized(), 'the window to leave the minimized state');
  await sleep(300);
  check('restore.restored', restored.restored === true && restored.presentation && restored.presentation.hostWindowHidden === false, JSON.stringify(restored));
  check('restore.calls', calls.includes('showInactive') && !calls.includes('focus') && !calls.includes('show'), calls.join(','));
  check('restore.focus-not-stolen', win.isFocused() === false, `isFocused=${win.isFocused()}`);

  // 4. Surface is back.
  const restoredSurface = await probe();
  check('restore.surface-measured', restoredSurface && restoredSurface.vw > 0 && restoredSurface.vh > 0, JSON.stringify(restoredSurface));

  // 5. Idempotent.
  calls.length = 0;
  const again = host.restoreHostWindowUnfocused('tab-1');
  check('restore.idempotent', again.restored === false && calls.length === 0, `restored=${again.restored} calls=${calls.join(',')}`);

  win.destroy();
  const failed = results.filter((ok) => !ok).length;
  console.log(`SUMMARY checks=${results.length} pass=${results.length - failed} fail=${failed} workDir=${workDir}`);
  exitCode = failed ? 1 : 0;
}

app.whenReady().then(run).then(() => app.exit(exitCode), fail);
