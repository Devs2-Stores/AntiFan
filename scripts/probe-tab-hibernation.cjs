/**
 * Chrome Tab Hibernation — real Electron probe.
 *
 * Boots the shipping main process in this Electron instance and drives the
 * hibernation machinery against REAL WebContentsViews on a real window:
 *
 *   a. three tabs on distinct sites (localhost vs 127.0.0.1 → separate renderers);
 *   b. a never-activated tab carries a fresh `lastActiveAt` (advisor check: the
 *      epoch-idle read cannot sleep it inside the 15-minute window);
 *   c. `beginTabHibernation` force-sleeps an idle background tab — the record
 *      survives, the WebContents is destroyed and its process leaves
 *      `app.getAppMetrics()`;
 *   d. wake-on-click: `switchTab` on a sleeping tab rebuilds its view and reloads
 *      the saved URL;
 *   e. a capability call (`getTabWebContents`) wakes a sleeping tab on demand;
 *   f. a page with a `beforeunload` handler vetoes the sleep — the tab is never
 *      hibernated and the sweep skips it afterwards.
 *
 * Run: node scripts/run-electron.cjs scripts/probe-tab-hibernation.cjs
 * Evidence: plans/260928-1654-smooth-multi-project-terminal/reports/tab-hibernation-probe.{json,log}
 */
const { app, webContents } = require('electron');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const ROOT = path.resolve(__dirname, '..');
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(ROOT, '.compiled');
const compiledModule = (relative) => path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));

const reportsDir = path.join(ROOT, 'plans', '260928-1654-smooth-multi-project-terminal', 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
const logFile = path.join(reportsDir, 'tab-hibernation-probe.log');
fs.writeFileSync(logFile, '', 'utf8');
const origLog = console.log;
console.log = (...args) => {
  origLog(...args);
  try { fs.appendFileSync(logFile, `${args.join(' ')}\n`, 'utf8'); } catch {}
};

// Throwaway world: a temp data root (config, control plane, runtime) and a temp
// Chromium profile, both seeded before the main process is required.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-hibernate-probe-'));
const wsDir = path.join(tempRoot, 'workspace');
fs.mkdirSync(wsDir, { recursive: true });
const ALPHA = {
  projectId: 'project-00000000-0000-4000-8000-0000000000a9',
  workspaceId: 'workspace-00000000-0000-4000-8000-0000000000a9',
};

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
process.env.ANTIFAN_BRIDGE_PORT = '20988';

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'config', 'workspace-capsules.json'),
  JSON.stringify({
    active: 'capsule-a',
    capsules: [
      { id: 'capsule-a', name: 'Probe Workspace', workspacePath: wsDir, sidebarOpen: false, sidebarWidth: 380 },
    ],
  }, null, 2),
  'utf8',
);

// A loopback fixture server: /plain is a clean page, /dirty carries a
// beforeunload handler that vetoes any unload — the dirty-form contract.
const server = http.createServer((req, res) => {
  const url = req.url || '/';
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.startsWith('/dirty')) {
    res.end(`<!doctype html><title>dirty</title><body>dirty form
      <script>window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; return ''; };</script></body>`);
    return;
  }
  res.end(`<!doctype html><title>hib-probe</title><body>hibernation probe: ${url}</body>`);
});

const mainProcess = require(compiledModule('index.js'));

const checks = [];
const observations = {};
const messageOf = (err) => String(err && err.message ? err.message : err);

async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    checks.push({ name, ok: false, error: messageOf(err) });
    console.log(`  FAIL  ${name}: ${messageOf(err)}`);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, description, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${description} (last observed: ${JSON.stringify(last)})`);
}

/** A tab's own page finished loading: the state broadcast the toolbar reads. */
const tabLoaded = (host, tabId) =>
  (host.getTabList().find((t) => t.id === tabId)?.isLoading === false &&
    Boolean(host.getTabWebContents(tabId)) &&
    !host.getTabWebContents(tabId).isDestroyed());

const tabProcessMetrics = (pid) => app.getAppMetrics().find((m) => m.pid === pid);
const allWebContentsHas = (wcId) => webContents.getAllWebContents().some((wc) => wc.id === wcId);

async function run() {
  const authority = mainProcess.projectWindowAuthority;
  await app.whenReady();
  // Host-omitted listen binds the unspecified address so both `localhost` and
  // `127.0.0.1` reach the fixture — the two sites must hit different renderers.
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const urlA = `http://127.0.0.1:${port}/plain-a`;
  const urlB = `http://localhost:${port}/plain-b`;
  const urlC = `http://localhost:${port}/dirty`;
  const urlD = `http://127.0.0.1:${port}/plain-d`;
  observations.urls = { urlA, urlB, urlC, urlD };

  const bootstrapEntry = await waitFor(
    () => (authority.snapshot().length === 1 ? authority.snapshot()[0] : false),
    'the startup project window',
  );
  const host = authority.hostForOwner(bootstrapEntry.ownerKey);
  expect(host && typeof host.createTab === 'function', 'the startup window exposes its tab host');
  host.setHibernationIdleMsForTesting(1);

  // ---- (a) three tabs, two never activated -----------------------------------
  const tabA = host.createTab(urlA, true);
  const tabB = host.createTab(urlB, false);
  const tabD = host.createTab(urlD, false);
  await waitFor(() => tabLoaded(host, tabA), 'tab A loaded');
  await waitFor(() => tabLoaded(host, tabB), 'tab B loaded');
  await waitFor(() => tabLoaded(host, tabD), 'tab D loaded');
  observations.tabs = { tabA, tabB, tabD };

  const recordOf = (id) => host['tabs'].get(id);
  await check('a never-activated tab carries a fresh lastActiveAt, not epoch', () => {
    const rec = recordOf(tabB);
    expect(rec && typeof rec.lastActiveAt === 'number' && rec.lastActiveAt > 0, `lastActiveAt was ${rec && rec.lastActiveAt}`);
    expect(Date.now() - rec.lastActiveAt < 60 * 1000, `a just-created tab measured ${Date.now() - rec.lastActiveAt}ms idle`);
  });

  // ---- (c) force-hibernate an idle background tab ----------------------------
  const wcB = host.getTabWebContents(tabB);
  const pidB = wcB.getOSProcessId();
  const wcIdB = wcB.id;
  observations.beforeSleep = { pidB, wcIdB, metric: tabProcessMetrics(pidB) };

  // Which exclusion would the sweep cite? Record the live context sets so a
  // refusal names its reason instead of guessing.
  observations.hibernationCtx = {
    boundTabIds: [...(host.hibernationBoundTabIds?.() || [])],
    cdpBoundTabIds: [...(host.hibernationCdpBoundTabIds?.() || [])],
    automationTabId: host.getAutomationTabId?.() ?? null,
    activeTabId: host.getActiveTabId?.() ?? host['activeTabId'],
    stateB: recordOf(tabB)?.state,
  };
  await check('beginTabHibernation destroys the view; record, URL and id survive', async () => {
    expect(await host.beginTabHibernation(tabB) === true, 'the seam refused an eligible background tab');
    expect(host.isTabHibernated(tabB) === true, 'isTabHibernated reported awake after the sleep');
    expect(recordOf(tabB)?.state.url === urlB, `the record kept url ${recordOf(tabB)?.state.url}`);
    expect(wcB.isDestroyed() === true, 'the old webContents still reported live');
    expect(!allWebContentsHas(wcIdB), 'the dead webContents is still registered globally');
    expect(recordOf(tabB)?.view === undefined, 'the record still held the destroyed view');
    const stripRow = host.getTabList().find((t) => t.id === tabB);
    expect(stripRow && stripRow.hibernated === true, 'the strip projection lost the sleeping mark');
  });

  await check('the hibernated renderer leaves app.getAppMetrics()', async () => {
    await waitFor(
      () => !tabProcessMetrics(pidB),
      `pid ${pidB} to leave app.getAppMetrics()`,
      5000,
    );
    observations.metricAfterSleep = tabProcessMetrics(pidB) || null;
  });

  // ---- (d) wake-on-click ------------------------------------------------------
  await check('activating a sleeping tab rebuilds its view and reloads the saved URL', async () => {
    expect(host.switchTab(tabB) === true, 'switchTab refused the sleeping tab');
    expect(host.isTabHibernated(tabB) === false, 'the tab stayed marked asleep after activation');
    const woken = host.getTabWebContents(tabB);
    expect(woken && !woken.isDestroyed(), 'the wake produced no live webContents');
    expect(woken.id !== wcIdB, 'the wake reused the destroyed webContents');
    await waitFor(async () => {
      const wc = host.getTabWebContents(tabB);
      return wc && !wc.isDestroyed() && wc.getURL() === urlB ? true : false;
    }, 'the woken tab to finish reloading its saved URL');
  });

  // ---- (e) a capability call wakes a sleeping tab -----------------------------
  await check('getTabWebContents on a sleeping tab wakes it before answering', async () => {
    expect(await host.beginTabHibernation(tabD) === true, 'the seam refused the second idle tab');
    expect(host.isTabHibernated(tabD) === true, 'tab D did not sleep');
    const wc = host.getTabWebContents(tabD);
    expect(wc && !wc.isDestroyed(), 'the capability funnel answered with dead contents');
    expect(host.isTabHibernated(tabD) === false, 'the capability call left the tab asleep');
  });

  // ---- (f) a beforeunload veto refuses the sleep ------------------------------
  const tabC = host.createTab(urlC, false);
  await waitFor(() => tabLoaded(host, tabC), 'the dirty tab loaded');
  const wcC = host.getTabWebContents(tabC);
  await wcC.executeJavaScript(
    "window.onbeforeunload = (e) => { e.preventDefault(); e.returnValue = ''; return ''; }; true",
    true,
  );
  // beforeunload requires user engagement before it may veto: a synthetic click
  // grants sticky activation the way a real click on the page would.
  wcC.sendInputEvent({ type: 'mouseDown', x: 10, y: 10, button: 'left', clickCount: 1 });
  wcC.sendInputEvent({ type: 'mouseUp', x: 10, y: 10, button: 'left', clickCount: 1 });
  await sleep(100);

  await check('a dirty-form tab is never hibernated', async () => {
    const slept = await host.beginTabHibernation(tabC);
    expect(slept === false, 'the sleep probe ignored the beforeunload veto');
    expect(host.isTabHibernated(tabC) === false, 'the vetoed tab was still marked asleep');
    expect(wcC.isDestroyed() === false, 'the vetoed page was destroyed anyway');
    const vetoed = host['unloadVetoedTabIds'];
    expect(vetoed && vetoed.has(tabC), 'the veto was not recorded for the sweep');
  });

  await check('the sweep skips the vetoed tab and never re-probes it', async () => {
    await host.runHibernationSweep();
    expect(host.isTabHibernated(tabC) === false, 'the sweep slept a vetoed tab');
    expect(wcC.isDestroyed() === false, 'the sweep destroyed a vetoed page');
  });

  // Let the probe's own cleanup close the window politely: the dirty page's
  // veto was evidence, not a permanent fixture.
  try {
    await wcC.executeJavaScript('window.onbeforeunload = null; true', true);
  } catch {}
}

async function cleanup() {
  try {
    for (const entry of mainProcess.projectWindowAuthority.snapshot()) {
      mainProcess.projectWindowAuthority.requestClose(entry.ownerKey);
    }
    const deadline = Date.now() + 8000;
    while (mainProcess.projectWindowAuthority.browserShellCount() > 0 && Date.now() < deadline) {
      await sleep(100);
    }
  } catch {}
  try { server.close(); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
}

let exitCode = 1;
app.whenReady()
  .then(run)
  .catch((err) => {
    check('probe completed without an unexpected throw', () => {
      throw err;
    });
  })
  .finally(async () => {
    await cleanup();
    const failed = checks.filter((entry) => !entry.ok);
    const result = {
      probe: 'tab-hibernation',
      passed: checks.length - failed.length,
      failed: failed.length,
      checks,
      observations,
      at: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(path.join(reportsDir, 'tab-hibernation-probe.json'), JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      origLog(`[probe] failed to write evidence: ${messageOf(err)}`);
      exitCode = 1;
      process.exit(exitCode);
    }
    console.log(`[probe] ${result.passed} passed, ${result.failed} failed — evidence: ${path.join(reportsDir, 'tab-hibernation-probe.json')}`);
    exitCode = failed.length === 0 ? 0 : 1;
    process.exit(exitCode);
  });
