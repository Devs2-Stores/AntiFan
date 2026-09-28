/**
 * Two Project Windows, One IPC Registration — real Electron probe.
 *
 * Proves the phase-02 routing gate: a second project window in the same process
 * registers no duplicate chrome channel, every message is dispatched to the host
 * that owns the sending surface, a foreign renderer (a tab page) is refused, and
 * the wrong chrome surface of the right window is refused too.
 *
 * Run: node scripts/run-electron.cjs scripts/probe-two-shell-ipc.cjs
 * Evidence is written to plans/260927-0315-project-windows/reports/.
 */
const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const compiled = (name) => path.join(__dirname, '..', '.compiled', 'src', 'main', name);
const { ProjectWindowShell } = require(compiled(path.join('browser', 'project-window-shell.js')));
const { NativeTabHost } = require(compiled(path.join('browser', 'native-tab-host.js')));
const { WorkspaceCapsuleManager } = require(compiled(path.join('project', 'workspace-capsule.js')));
const router = require(compiled(path.join('browser', 'ipc-router.js')));
const { TabAuthorityDirectory } = require(compiled(path.join('browser', 'tab-authority-directory.js')));

const reportsDir = path.join(__dirname, '..', 'plans', '260927-0315-project-windows', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'two-shell-ipc-probe.log');
const logStream = fs.createWriteStream(logFile, { flags: 'w' });
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { logStream.write(`${args.join(' ')}\n`); } catch {}
};

const tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-two-shell-'));
app.setPath('userData', tempUserData);

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    checks.push({ name, ok: false, error: String(err && err.message ? err.message : err) });
    console.log(`  FAIL  ${name}: ${err && err.message ? err.message : err}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForChromeSurfaces(shells, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const ready = () => shells.every((shell) => {
    const surfaces = [shell.toolbarView, shell.frameBackdropView, shell.sidebarView];
    const loaded = surfaces.filter(Boolean);
    return loaded.length > 0 && loaded.every((view) => shell.chromeSurfaceFor(view.webContents.id) !== undefined);
  });
  while (Date.now() < deadline) {
    if (ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function run() {
  console.log('[probe] Starting two-shell chrome IPC probe...');
  const shells = [];
  const hosts = [];
  let sharedCapsules;
  try {
    const ownerA = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-0000000000a1' };
    const ownerB = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-0000000000b2' };
    const buildShell = (owner, title) => {
      const shell = new ProjectWindowShell({
        owner,
        title,
        bounds: { width: 1100, height: 780 },
        show: false,
      });
      shells.push(shell);
      return shell;
    };

    sharedCapsules = new WorkspaceCapsuleManager({ filePath: path.join(tempUserData, 'workspace-capsules.json') });
    const shellA = buildShell(ownerA, 'Probe A');
    const shellB = buildShell(ownerB, 'Probe B');

    const directory = new TabAuthorityDirectory();
    const hostA = new NativeTabHost(shellA, sharedCapsules);
    hosts.push(hostA);
    directory.register(shellA, hostA);
    const channelsAfterFirst = router.listRegisteredChromeChannels().length;

    // The construction below is the actual gate: a second host used to throw
    // "Attempted to register a second handler for ..." from its constructor.
    const hostB = new NativeTabHost(shellB, sharedCapsules);
    hosts.push(hostB);
    directory.register(shellB, hostB);
    const channelsAfterSecond = router.listRegisteredChromeChannels().length;

    router.setChromeSenderResolver((webContents) => directory.resolveSender(webContents.id));

    // Sender resolution matches a chrome view by the page it actually loaded, so it
    // cannot answer until the view's loadFile has committed. Without this wait the
    // resolution checks below read the pre-load URL and report a routing failure that
    // is really a race.
    const surfacesReady = await waitForChromeSurfaces(shells);
    check('every chrome surface has loaded its page before routing is judged', () => {
      expect(surfacesReady, 'the chrome views did not finish loading within the timeout');
    });

    console.log(`[probe] chrome channels after window A: ${channelsAfterFirst}, after window B: ${channelsAfterSecond}`);
    check('second project window registers no additional chrome channel', () => {
      expect(channelsAfterFirst > 0, 'the first window registered no chrome channels at all');
      expect(channelsAfterSecond === channelsAfterFirst, `channel count grew from ${channelsAfterFirst} to ${channelsAfterSecond} on the second window`);
    });

    const routes = NativeTabHost.CHROME_ROUTES;
    check('route table is exposed for dispatch', () => {
      expect(Array.isArray(routes) && routes.length > 0, 'NativeTabHost.CHROME_ROUTES is missing or empty');
    });

    check('toolbar of each window resolves to its own host', () => {
      const targetA = directory.resolveSender(shellA.toolbarView.webContents.id);
      const targetB = directory.resolveSender(shellB.toolbarView.webContents.id);
      expect(targetA && targetA.host === hostA && targetA.surface === 'toolbar', `window A toolbar resolved to ${JSON.stringify(targetA && targetA.surface)}`);
      expect(targetB && targetB.host === hostB && targetB.surface === 'toolbar', `window B toolbar resolved to ${JSON.stringify(targetB && targetB.surface)}`);
    });

    check('sidebar resolves as the sidebar surface, not the toolbar', () => {
      const target = directory.resolveSender(shellA.sidebarView.webContents.id);
      expect(target && target.host === hostA && target.surface === 'sidebar', `sidebar resolved to ${JSON.stringify(target && target.surface)}`);
    });

    if (Array.isArray(routes) && routes.length > 0) {
      check('a toolbar action in window B changes only window B', () => {
        const beforeA = shellA.isSidebarOpen;
        const beforeB = shellB.isSidebarOpen;
        router.dispatchChromeRoute(routes, 'antifan:toolbar:toggle-sidebar', shellB.toolbarView.webContents, []);
        expect(shellB.isSidebarOpen === !beforeB, `window B sidebar stayed ${String(beforeB)}`);
        expect(shellA.isSidebarOpen === beforeA, `window A sidebar changed from ${String(beforeA)} to ${String(shellA.isSidebarOpen)}`);
      });

      check('a toolbar-only channel is refused from the sidebar, while the sidebar keeps the channels its preload declares', () => {
        // The standalone preload's `togglePanel` really does invoke toggle-sidebar
        // (src/preload/standalone-preload.ts), so that route declares toolbar, sidebar and
        // terminalPopout. A toolbar-only channel from the same sidebar must still be
        // refused, or the surface gate would be decorative rather than authoritative.
        let toolbarOnlyCode;
        try {
          router.dispatchChromeRoute(routes, 'antifan:toolbar:set-device-preset', shellB.sidebarView.webContents, [{ presetId: 'responsive' }]);
        } catch (err) {
          toolbarOnlyCode = err && err.code;
        }
        expect(toolbarOnlyCode === 'CHROME_SURFACE_MISMATCH', `a toolbar-only channel was not refused from the sidebar (code: ${String(toolbarOnlyCode)})`);

        const beforeA = shellA.isSidebarOpen;
        const beforeB = shellB.isSidebarOpen;
        router.dispatchChromeRoute(routes, 'antifan:toolbar:toggle-sidebar', shellB.sidebarView.webContents, []);
        expect(shellB.isSidebarOpen === !beforeB, `window B sidebar stayed ${String(beforeB)} after the sidebar invoked the declared channel`);
        expect(shellA.isSidebarOpen === beforeA, `window A sidebar changed from ${String(beforeA)} to ${String(shellA.isSidebarOpen)}`);
      });

      check('a tab page is not a chrome surface and is refused', () => {
        const tabId = hostA.createTab('about:blank', false);
        const pageContents = hostA.getTabWebContents(tabId, 'desktop');
        expect(pageContents, 'could not obtain the tab page webContents');
        let code;
        try {
          router.dispatchChromeRoute(routes, 'antifan:toolbar:toggle-sidebar', pageContents, []);
        } catch (err) {
          code = err && err.code;
        }
        expect(code === 'UNKNOWN_CHROME_SENDER', `tab page dispatch refused with ${String(code)} instead of UNKNOWN_CHROME_SENDER`);
      });
    } else {
      console.log('  SKIP  route-dependent checks (route table unavailable)');
    }
  } catch (err) {
    check('probe completed without an unexpected throw', () => {
      throw err;
    });
  } finally {
    for (const host of hosts) {
      try { host.dispose(); } catch {}
    }
    for (const shell of shells) {
      try {
        if (!shell.window.isDestroyed()) {
          shell.window.removeAllListeners();
          shell.window.destroy();
        }
      } catch {}
    }
    try { fs.rmSync(tempUserData, { recursive: true, force: true }); } catch {}
  }

  const failed = checks.filter((entry) => !entry.ok);
  const result = { probe: 'two-shell-ipc', passed: checks.length - failed.length, failed: failed.length, checks, at: new Date().toISOString() };
  fs.writeFileSync(path.join(reportsDir, 'two-shell-ipc-probe.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(`[probe] ${result.passed}/${checks.length} checks passed; evidence ${path.join(reportsDir, 'two-shell-ipc-probe.json')}`);
  logStream.end();
  app.exit(failed.length === 0 ? 0 : 1);
}

app.whenReady().then(run).catch((err) => {
  console.error('[probe] probe crashed before completing:', err);
  app.exit(1);
});
