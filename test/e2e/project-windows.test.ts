/**
 * Live E2E: independent project windows, certified through the shipping app.
 *
 * The individual smokes each prove one window-level behaviour (split review, background
 * multitasking, profile persistence, terminal survival). This suite is the one that boots the
 * real Electron process with several project windows open at once and watches what a user
 * would see: one window per project, its own tabs and active tab, its own split layout, a
 * cross-window search that presents a foreign tab without moving execution authority, closing
 * one window leaving its siblings and their tabs alone, and the surviving window's toolbar and
 * accelerator paths still working afterwards.
 *
 * How it runs: the scenario is a real Electron main-process script, generated into a throwaway
 * directory from `PROJECT_WINDOWS_DRIVER_SOURCE` below and launched through the repository's own
 * `scripts/run-electron.cjs`. The driver boots the shipping `src/main/index.ts` inside the
 * process (never a copy of it), drives the chrome surfaces the way their renderers do, and
 * reports per-row results plus observations as JSON. Keeping the scenario beside the assertions
 * is what stops the two from drifting: a row that is not in `EXPECTED_ROWS` fails the suite, and
 * a row the driver stops reporting fails it too.
 *
 * Isolation: throwaway `ANTIFAN_DATA_ROOT`, `ANTIFAN_CONFIG_DIR`, `ANTIFAN_USER_DATA` and a
 * bridge port this test picks free before the launch. The developer's profile, data root and
 * capsules are never read or written, and every process this suite starts is its own.
 *
 * Coverage split (see `plans/260927-0315-project-windows/phase-05-certification.md`):
 *
 *   Automated here (a scripted harness observes them):
 *     - one window per project, duplicate open joins the open window, unknown project refused
 *     - per-window tabs and per-window active tab independence
 *     - per-window split layout independence (presets, focused pane, pane geometry)
 *     - a native `window.open` popup inherits its own window's verified capsule and partition,
 *       and never another window's
 *     - minimize/restore keeps a window's authenticated target and refuses a foreign one
 *     - two agent sessions in the SAME project cannot cross-invoke each other's tabs
 *     - a background window's page stays laid out and capturable while another window is focused
 *     - cross-window search inventory, exact foreign activation, stale refusal, no authority
 *       rotation (agent automation target stays put)
 *     - five projects / twenty visible tabs with per-window owner labels
 *     - an agent-intent window is created without a single presentation call
 *     - closing one window preserves its siblings, their tabs and their layout
 *     - the surviving window's toolbar path and application-menu accelerator path still work
 *
 *   Deferred, NOT faked here (they need hardware, a human, or a native dialog this harness
 *   cannot present honestly — see `DEFERRED_ROWS`):
 *     - two surfaces simultaneously visible on separate physical monitors
 *     - real OS focus/typing stability while a child opens in another window
 *     - physical display disconnect and DPI change recovery
 *     - visual and physical-keyboard reachability at the 960x640 minimum
 *     - native beforeunload veto, close/binding races and the coordinated-Quit guard
 *       (owned by `scripts/probe-quit-coordination.cjs` and the main-lane lifecycle suites)
 *     - detached terminal-daemon survival across GUI close (daemon disabled in this isolated run;
 *       owned by the terminal smoke lane)
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

/** Every row the driver must report, and the only ones it may report. */
const EXPECTED_ROWS: readonly string[] = [
  'window.startup-single-project-shell',
  'window.second-project-opens-with-own-authority',
  'window.duplicate-open-joins-existing-window',
  'window.unknown-project-refused',
  'window.independent-tabs-and-active-tab',
  'window.split-layout-independent',
  'window.native-popup-inherits-window-affiliation',
  'window.minimize-restore-keeps-target-authority',
  'window.same-project-sessions-cannot-cross-invoke',
  'window.background-surface-and-capture-ready',
  'window.search-lists-every-window',
  'window.search-activates-foreign-tab-without-authority-rotation',
  'window.search-stale-refusal-no-fallback',
  'window.five-projects-twenty-tabs',
  'window.agent-intent-window-stays-unpresented',
  'window.close-keeps-sibling-and-tabs',
  'window.survivor-toolbar-and-accelerator-after-sibling-close',
  'window.cleanup-closes-every-shell',
];

/**
 * Rows this lane reports as unverified instead of simulating them. A screenshot of a fabricated
 * display layout, a synthetic unload dialog or a frozen clock would each be a claim about
 * hardware or a user's answer that nobody observed.
 */
const DEFERRED_ROWS: readonly string[] = [
  'physical.two-monitor-surfaces',
  'physical.typing-under-real-os-focus',
  'physical.display-disconnect-and-dpi-change',
  'physical.minimum-window-visual-and-keyboard',
  'native.unload-veto-and-close-races',
  'daemon.detached-session-survival',
];

const RUN_TIMEOUT_MS = 300_000;
const EVIDENCE_PATH = path.join(
  'plans',
  '260927-0315-project-windows',
  'reports',
  'project-windows-e2e.json',
);

interface DriverCheckRow {
  name: string;
  ok: boolean;
  error?: string;
}

/** The observation fields the suite asserts on, declared here so the assertions stay typed. */
interface DriverObservations {
  startup: { shellCount: number };
  duplicateOpen: { status: string };
  volume: { shellCount: number; tabCount: number; inventoryRows: number };
  teardown: { shellCount: number };
  backgroundSurface: { mode: string; workArea: { width: number; height: number } };
  backgroundCapture: { bytes: number; rasterSize: { width: number; height: number } } | null;
  staleActivation: { closedTab: { reasonCode: string } };
  close: { shellCount: number };
  survivorPaths: { toolbarTab: string; acceleratorTab: string };
  nativePopup?: {
    capsuleId: string;
    parentCapsuleId: string;
    windowCapsule: string;
    partition: string;
    userAgentMode: string;
    parentUserAgentMode: string;
  };
  minimizeRestore?: {
    minimized: { alphaTarget: string | null; betaTarget: string | null };
    restored: { alphaTarget: string | null; betaTarget: string | null };
    foreignTarget: { requested: string; adopted: string | null };
  };
  sameProjectSessions?: {
    tabOne: string;
    tabTwo: string;
    crossRefused: boolean;
    crossText: string;
    domReadsBeforeSibling: string[];
    domReads: string[];
    siblingReadFailed: string | null;
  };
  [key: string]: unknown;
}

interface DriverEvidence {
  scenario: string;
  passed: number;
  failed: number;
  checks: DriverCheckRow[];
  observations: DriverObservations;
  deferred: string[];
  at: string;
}

function killProcessTree(proc: ChildProcess): void {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    proc.kill('SIGKILL');
  } catch {}
}

/**
 * A port nothing is listening on, asked of the OS. Two Electron runs on this machine must not
 * collide on the bridge port, and a hard-coded port would either refuse to boot or, worse,
 * attach to whatever already owns it.
 */
async function pickFreePort(): Promise<number> {
  const assigned = Promise.withResolvers<number>();
  const server = net.createServer();
  server.on('error', assigned.reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    server.close(() => {
      if (port > 0) assigned.resolve(port);
      else assigned.reject(new Error('the OS assigned no port'));
    });
  });
  return assigned.promise;
}

/** The scenario that runs inside the real Electron main process. */
const PROJECT_WINDOWS_DRIVER_SOURCE = `
'use strict';
const { app, BrowserWindow, Menu, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const REPO_ROOT = process.env.ANTIFAN_DRIVER_REPO_ROOT || path.resolve(__dirname, '..');
const EVIDENCE_FILE = process.env.ANTIFAN_DRIVER_EVIDENCE || path.join(REPO_ROOT, 'project-windows-e2e.json');
const BRIDGE_PORT = process.env.ANTIFAN_DRIVER_BRIDGE_PORT || '';
// The minimum a project shell accepts, as src/main/index.ts creates it. Two of them side by
// side is what the display has to hold before this run measures a window that another window
// does not cover.
const SHELL_MIN_WIDTH = 700;
const SHELL_MIN_HEIGHT = 500;
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(REPO_ROOT, '.compiled');
const compiledModule = function (relative) {
  return path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));
};

// Throwaway world: a temp data root (config, control plane, runtime), a temp Chromium profile,
// and one real directory per project for its capsule to point at. Nothing here can read or write
// the developer's data root, profile or capsules.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pw-e2e-'));
const makeProject = function (suffix, name) {
  const dir = path.join(tempRoot, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return {
    projectId: 'project-00000000-0000-4000-8000-0000000000' + suffix,
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000' + suffix,
    capsuleId: 'capsule-pw-' + suffix,
    name: name,
    path: dir,
  };
};
const ALPHA = makeProject('a1', 'Window Alpha');
const BETA = makeProject('b2', 'Window Beta');
const GAMMA = makeProject('c3', 'Window Gamma');
const DELTA = makeProject('d4', 'Window Delta');
const EPSILON = makeProject('e5', 'Window Epsilon');
const PROJECTS = [ALPHA, BETA, GAMMA, DELTA, EPSILON];
// No capsule describes this owner: the agent-intent window, and the honest-label fallback.
const UNRECORDED = { projectId: 'project-00000000-0000-4000-8000-0000000000f6' };

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_PROJECT_ID = ALPHA.projectId;
process.env.ANTIFAN_WORKSPACE_ID = ALPHA.workspaceId;
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
if (BRIDGE_PORT) process.env.ANTIFAN_BRIDGE_PORT = BRIDGE_PORT;

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.writeFileSync(
  path.join(tempRoot, 'config', 'workspace-capsules.json'),
  JSON.stringify({
    version: 1,
    activeCapsuleId: ALPHA.capsuleId,
    capsules: PROJECTS.map(function (entry) {
      return {
        id: entry.capsuleId,
        name: entry.name,
        workspacePath: entry.path,
        state: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
        projectId: entry.projectId,
        workspaceId: entry.workspaceId,
        migrationMarker: 'explicit',
      };
    }),
  }, null, 2),
  'utf8',
);

// The shipping main process, booted inside this same Electron instance: its boot guards run at
// import, so the throwaway environment above is already in place.
const mainProcess = require(compiledModule('index.js'));
// The same classes the shipping composition wires for an agent session, driven here against the
// live host so a session row measures the real capability path and not a re-implementation.
const { NativeTabHost } = require(compiledModule('browser/native-tab-host.js'));
const { AntiFanMcpServer } = require(compiledModule('mcp/mcp-server.js'));
const { CapabilityTransportAdapter } = require(compiledModule('tools/capability-transport.js'));

const checks = [];
const observations = {};
const DEFERRED = [
  'physical.two-monitor-surfaces',
  'physical.typing-under-real-os-focus',
  'physical.display-disconnect-and-dpi-change',
  'physical.minimum-window-visual-and-keyboard',
  'native.unload-veto-and-close-races',
  'daemon.detached-session-survival',
];

const messageOf = function (err) { return err && err.message ? String(err.message) : String(err); };
const expect = function (condition, message) { if (!condition) throw new Error(message); };
// Poll interval only: every wait below waits for the state under test to exist (or to change),
// never for a guessed duration to elapse.
const sleep = require('node:timers/promises').setTimeout;
const samePath = function (left, right) {
  return path.normalize(String(left || '')) === path.normalize(String(right || ''));
};

async function waitFor(predicate, description, timeoutMs) {
  const timeout = timeoutMs || 30000;
  const deadline = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await predicate();
    if (last) return last;
    if (Date.now() > deadline) {
      throw new Error('timed out after ' + timeout + 'ms waiting for ' + description + ' (last observed: ' + JSON.stringify(last) + ')');
    }
    await sleep(50);
  }
}

async function waitForApi(webContents, expression, timeoutMs) {
  await waitFor(
    async function () {
      if (!webContents || webContents.isDestroyed()) return false;
      try {
        return (await webContents.executeJavaScript(expression, true)) === true;
      } catch (err) {
        return false;
      }
    },
    'chrome surface API: ' + expression,
    timeoutMs || 20000,
  );
}

// Real wall-clock time is deliberate here, and deterministic time control is impossible: the
// driver runs inside the Electron main process, not under a test framework, so there is no
// clock to advance — and a row that never returns is exactly what this bound must report.
// A row that stalls must not abort the receipt: the run's own watchdog would otherwise kill
// the process and every later row would be recorded as never observed, hiding the rows that
// were fine. A stalled row is one honest FAIL and the run continues.
const ROW_TIMEOUT_MS = 90000;

async function check(name, fn, cleanup) {
  const rowTimeout = Promise.withResolvers();
  const rowTimer = setTimeout(function () {
    rowTimeout.reject(new Error('the row did not finish within ' + ROW_TIMEOUT_MS + 'ms'));
  }, ROW_TIMEOUT_MS);
  try {
    await Promise.race([fn(), rowTimeout.promise]);
    checks.push({ name: name, ok: true });
    console.log('  PASS  ' + name);
  } catch (err) {
    checks.push({ name: name, ok: false, error: messageOf(err) });
    console.log('  FAIL  ' + name + ': ' + messageOf(err));
  } finally {
    clearTimeout(rowTimer);
    // A row that fails must still leave the scenario as it found it. An aborted row used to
    // hand every later row its own leftovers (an extra open and still-active tab), which
    // turned one honest failure into a cascade of unrelated ones — the receipt then blames
    // rows that were never the cause. Cleanup is best-effort and never decides a row.
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        console.log('  NOTE  row cleanup failed: ' + messageOf(err));
      }
    }
  }
}

let authority = null;

const surfaceOf = function (shell, surface) {
  const view = surface === 'sidebar' ? shell && shell.sidebarView : shell && shell.toolbarView;
  return view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null;
};
const entryOf = function (snapshot, ownerKeyValue) {
  return snapshot.find(function (entry) { return entry.ownerKey === ownerKeyValue; }) || null;
};
const hostOf = function (ownerKeyValue) { return authority.hostForOwner(ownerKeyValue); };
const tabStateOf = function (host, tabId) {
  const tab = host.getTabList().find(function (candidate) { return candidate.id === tabId; });
  return tab || null;
};
const allTabIds = function () {
  const ids = [];
  for (const entry of authority.snapshot()) {
    for (const tabId of entry.tabIds) ids.push(tabId);
  }
  return ids;
};
const findMenuItem = function (menu, label) {
  if (!menu || !Array.isArray(menu.items)) return null;
  for (const item of menu.items) {
    if (item.label === label) return item;
    const nested = findMenuItem(item.submenu, label);
    if (nested) return nested;
  }
  return null;
};

/** Open one project the way its own opening surface does, and wait for its window. */
async function openProjectFromSidebar(sidebarSurface, project) {
  const result = await sidebarSurface.executeJavaScript(
    'window.antifanStandalone.openProject(' + JSON.stringify(project.projectId) + ')',
    true,
  );
  const entry = await waitFor(
    function () {
      return authority.snapshot().find(function (candidate) {
        return candidate.owner.kind === 'project' && candidate.owner.projectId === project.projectId;
      }) || false;
    },
    'the project window for ' + project.name,
  );
  return { result: result, entry: entry };
}

async function run() {
  authority = mainProcess.projectWindowAuthority;
  await app.whenReady();

  // ---------------------------------------------------------------- (1) the startup window
  const startup = await waitFor(
    function () {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the startup project window',
  );
  const alphaKey = startup.ownerKey;
  observations.startup = {
    ownerKey: alphaKey,
    windowId: startup.windowId,
    title: startup.title,
    shellCount: authority.browserShellCount(),
  };

  let toolbarA = null;
  let sidebarA = null;

  await check('window.startup-single-project-shell', async function () {
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount());
    expect(startup.owner.kind === 'project', 'the startup owner kind was ' + String(startup.owner.kind));
    expect(startup.owner.projectId === ALPHA.projectId, 'the startup owner project was ' + String(startup.owner.projectId));
    expect(startup.title.indexOf(ALPHA.name) === 0, 'the startup title was ' + String(startup.title));
    expect(samePath(startup.identity.pathLabel, ALPHA.path), 'the startup path label was ' + String(startup.identity.pathLabel));
    const window = authority.windowFor(alphaKey);
    expect(window && !window.isDestroyed(), 'the startup window has no live native window');
    const shell = authority.shellFor(alphaKey);
    expect(shell, 'the startup window has no shell');
    toolbarA = surfaceOf(shell, 'toolbar');
    sidebarA = surfaceOf(shell, 'sidebar');
    expect(toolbarA, 'the startup window has no toolbar surface');
    expect(sidebarA, 'the startup window has no sidebar surface');
    await waitForApi(toolbarA, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
    await waitForApi(sidebarA, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");
  });

  // ------------------------------------------- (2) a second project window, from the sidebar
  let betaEntry = null;
  let toolbarB = null;
  let secondOpenResult = null;

  await check('window.second-project-opens-with-own-authority', async function () {
    const opened = await openProjectFromSidebar(sidebarA, BETA);
    secondOpenResult = opened.result;
    betaEntry = opened.entry;
    observations.secondWindow = betaEntry;
    expect(secondOpenResult && secondOpenResult.status === 'OPENED', 'the second open returned ' + JSON.stringify(secondOpenResult));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount());
    expect(betaEntry.windowId !== startup.windowId, 'both windows reported window id ' + String(betaEntry.windowId));
    expect(betaEntry.title.indexOf(BETA.name) === 0, 'the second window title was ' + String(betaEntry.title));
    expect(samePath(betaEntry.identity.pathLabel, BETA.path), 'the second window path label was ' + String(betaEntry.identity.pathLabel));
    expect(betaEntry.hostOwnerKey === betaEntry.ownerKey, 'the second window host key was ' + String(betaEntry.hostOwnerKey));
    const shell = authority.shellFor(betaEntry.ownerKey);
    expect(shell, 'the second window has no shell');
    toolbarB = surfaceOf(shell, 'toolbar');
    expect(toolbarB, 'the second window has no toolbar surface');
    await waitForApi(toolbarB, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
  });

  // ------------------------------------------------------- (3) duplicate open joins, no third
  await check('window.duplicate-open-joins-existing-window', async function () {
    const again = await sidebarA.executeJavaScript(
      'window.antifanStandalone.openProject(' + JSON.stringify(BETA.projectId) + ')',
      true,
    );
    observations.duplicateOpen = again;
    expect(again && again.status === 'FOCUSED', 'the duplicate open returned ' + JSON.stringify(again));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount() + ' after the duplicate open');
    const after = authority.snapshot().find(function (entry) {
      return entry.owner.kind === 'project' && entry.owner.projectId === BETA.projectId;
    });
    expect(after && after.windowId === betaEntry.windowId, 'the second window changed identity across the duplicate open');
    const foreign = authority.snapshot().find(function (entry) {
      return entry.owner.kind === 'project' && entry.owner.projectId !== ALPHA.projectId && entry.owner.projectId !== BETA.projectId;
    });
    expect(!foreign, 'a third project window appeared: ' + JSON.stringify(foreign && foreign.owner));
  });

  // ------------------------------------------------------------- (4) unknown project refused
  await check('window.unknown-project-refused', async function () {
    const refused = await sidebarA.executeJavaScript(
      "window.antifanStandalone.openProject('project-00000000-0000-4000-8000-0000000000ff')",
      true,
    );
    observations.unknownProject = refused;
    expect(refused && refused.status === 'FAILED', 'an unknown project returned ' + JSON.stringify(refused));
    expect(refused.reason === 'UNKNOWN_PROJECT', 'an unknown project reported ' + String(refused.reason));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount() + ' after a refused open');
  });

  // --------------------------------------- (5) per-window tabs and per-window active tab
  let tabA1 = null;
  let tabA2 = null;
  let tabB1 = null;
  let tabB2 = null;

  await check('window.independent-tabs-and-active-tab', async function () {
    // The tabs carry a real page rather than about:blank. A blank tab is constructed without a
    // load, so its WebContents has no renderer document and the first evaluate against it waits
    // out the whole eval ceiling instead of answering - the shipping host states that boundary
    // itself when it materializes about:blank for offscreen agent tabs. Every later row here
    // reads, opens a popup from or captures these tabs, so they are given documents.
    tabA1 = await toolbarA.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    tabA2 = await toolbarA.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    tabB1 = await toolbarB.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    tabB2 = await toolbarB.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    expect(typeof tabA1 === 'string' && tabA1.length > 0, 'window A created no first tab: ' + JSON.stringify(tabA1));
    expect(typeof tabA2 === 'string' && tabA2.length > 0, 'window A created no second tab: ' + JSON.stringify(tabA2));
    expect(typeof tabB1 === 'string' && tabB1.length > 0, 'window B created no first tab: ' + JSON.stringify(tabB1));
    expect(typeof tabB2 === 'string' && tabB2.length > 0, 'window B created no second tab: ' + JSON.stringify(tabB2));

    const snapshot = await waitFor(
      function () {
        const current = authority.snapshot();
        const alphaEntry = entryOf(current, alphaKey);
        const betaEntryCurrent = entryOf(current, betaEntry.ownerKey);
        if (!alphaEntry || !betaEntryCurrent) return false;
        const listed = [alphaEntry.tabIds, betaEntryCurrent.tabIds].join('|');
        return listed.indexOf(tabA1) !== -1 && listed.indexOf(tabA2) !== -1 && listed.indexOf(tabB1) !== -1 && listed.indexOf(tabB2) !== -1
          ? current
          : false;
      },
      'both windows to list their own tabs',
    );
    const alpha = entryOf(snapshot, alphaKey);
    const beta = entryOf(snapshot, betaEntry.ownerKey);
    observations.tabs = { alpha: alpha.tabIds, beta: beta.tabIds };
    expect(alpha.tabIds.indexOf(tabA1) !== -1 && alpha.tabIds.indexOf(tabA2) !== -1, 'window A does not list both its tabs: ' + JSON.stringify(alpha.tabIds));
    expect(beta.tabIds.indexOf(tabB1) !== -1 && beta.tabIds.indexOf(tabB2) !== -1, 'window B does not list both its tabs: ' + JSON.stringify(beta.tabIds));
    expect(alpha.tabIds.indexOf(tabB1) === -1 && alpha.tabIds.indexOf(tabB2) === -1, 'window A lists window B tabs: ' + JSON.stringify(alpha.tabIds));
    expect(beta.tabIds.indexOf(tabA1) === -1 && beta.tabIds.indexOf(tabA2) === -1, 'window B lists window A tabs: ' + JSON.stringify(beta.tabIds));

    // Each window selects its own active tab: A returns to its first, B stays on its second.
    expect(await toolbarA.executeJavaScript('window.antifanToolbar.switchTab(' + JSON.stringify(tabA1) + ')', true) === true, 'window A refused to select its own tab ' + tabA1);
    expect(await toolbarB.executeJavaScript('window.antifanToolbar.switchTab(' + JSON.stringify(tabB2) + ')', true) === true, 'window B refused to select its own tab ' + tabB2);
    const selected = authority.snapshot();
    const alphaSelected = entryOf(selected, alphaKey);
    const betaSelected = entryOf(selected, betaEntry.ownerKey);
    observations.activeTabs = { alpha: alphaSelected.activeTabId, beta: betaSelected.activeTabId };
    expect(alphaSelected.activeTabId === tabA1, 'window A active tab was ' + alphaSelected.activeTabId + ', expected ' + tabA1);
    expect(betaSelected.activeTabId === tabB2, 'window B active tab was ' + betaSelected.activeTabId + ', expected ' + tabB2);

    // A second switch in window A must not move window B's active tab.
    expect(await toolbarA.executeJavaScript('window.antifanToolbar.switchTab(' + JSON.stringify(tabA2) + ')', true) === true, 'window A refused its second selection');
    const afterSecondSwitch = authority.snapshot();
    const betaAfterSwitch = entryOf(afterSecondSwitch, betaEntry.ownerKey);
    const alphaAfterSwitch = entryOf(afterSecondSwitch, alphaKey);
    expect(alphaAfterSwitch.activeTabId === tabA2, 'window A active tab was ' + alphaAfterSwitch.activeTabId + ', expected ' + tabA2);
    expect(betaAfterSwitch.activeTabId === tabB2, 'window A moving its own selection moved window B to ' + betaAfterSwitch.activeTabId);
  });

  // ------------------------------------------------------------- (6) split layout isolation
  let splitGeometry = null;

  await check('window.split-layout-independent', async function () {
    const alphaHost = hostOf(alphaKey);
    const betaHost = hostOf(betaEntry.ownerKey);
    expect(alphaHost && betaHost, 'a window lost its tab host');

    expect(await toolbarA.executeJavaScript('window.antifanToolbar.toggleSplitReview()', true) === true, 'window A refused to enable split review');
    expect(await toolbarA.executeJavaScript("window.antifanToolbar.setSplitPreset('mobile', 'ipad-mini')", true) === true, 'window A refused its mobile preset');
    expect(await toolbarA.executeJavaScript("window.antifanToolbar.setSplitPreset('desktop', 'laptop-macbook13')", true) === true, 'window A refused its desktop preset');
    expect(await toolbarA.executeJavaScript("window.antifanToolbar.setSplitFocusedPane('desktop')", true) === true, 'window A refused its focused pane');
    expect(await toolbarB.executeJavaScript('window.antifanToolbar.toggleSplitReview()', true) === true, 'window B refused to enable split review');
    expect(await toolbarB.executeJavaScript("window.antifanToolbar.setSplitPreset('mobile', 'mobile-small')", true) === true, 'window B refused its mobile preset');
    expect(await toolbarB.executeJavaScript("window.antifanToolbar.setSplitFocusedPane('mobile')", true) === true, 'window B refused its focused pane');

    const alphaTab = await waitFor(
      function () {
        const tab = tabStateOf(alphaHost, tabA2);
        return tab && tab.splitMode === true ? tab : false;
      },
      "window A's split state",
    );
    const betaTab = await waitFor(
      function () {
        const tab = tabStateOf(betaHost, tabB2);
        return tab && tab.splitMode === true ? tab : false;
      },
      "window B's split state",
    );
    observations.splitState = {
      alpha: { tabId: tabA2, mobile: alphaTab.splitMobilePresetId, desktop: alphaTab.splitDesktopPresetId, focused: alphaTab.splitFocusedPane },
      beta: { tabId: tabB2, mobile: betaTab.splitMobilePresetId, desktop: betaTab.splitDesktopPresetId, focused: betaTab.splitFocusedPane },
    };
    expect(alphaTab.splitMobilePresetId === 'ipad-mini', "window A's mobile preset was " + String(alphaTab.splitMobilePresetId));
    expect(alphaTab.splitDesktopPresetId === 'laptop-macbook13', "window A's desktop preset was " + String(alphaTab.splitDesktopPresetId));
    expect(alphaTab.splitFocusedPane === 'desktop', "window A's focused pane was " + String(alphaTab.splitFocusedPane));
    expect(betaTab.splitMobilePresetId === 'mobile-small', "window B's mobile preset was " + String(betaTab.splitMobilePresetId));
    expect(betaTab.splitFocusedPane === 'mobile', "window B's focused pane was " + String(betaTab.splitFocusedPane));
    // The tabs that were not split in each window stay whole: the layout is per tab, not per app.
    expect(tabStateOf(alphaHost, tabA1).splitMode !== true, "window A's other tab reports split mode");
    expect(tabStateOf(betaHost, tabB1).splitMode !== true, "window B's other tab reports split mode");

    const alphaMobile = alphaHost.getTabContentBounds(tabA2, 'mobile');
    const betaMobileBefore = betaHost.getTabContentBounds(tabB2, 'mobile');
    expect(alphaMobile && alphaMobile.width > 0 && alphaMobile.height > 0, "window A's mobile pane has no geometry: " + JSON.stringify(alphaMobile));
    expect(betaMobileBefore && betaMobileBefore.width > 0, "window B's mobile pane has no geometry: " + JSON.stringify(betaMobileBefore));

    // A preset change in B is a change in B alone: B's own geometry responds, A's does not move.
    expect(await toolbarB.executeJavaScript("window.antifanToolbar.setSplitPreset('mobile', 'ipad-mini')", true) === true, 'window B refused the second mobile preset');
    const betaMobileAfter = await waitFor(
      function () {
        const bounds = betaHost.getTabContentBounds(tabB2, 'mobile');
        return bounds && bounds.width > 0 && bounds.width !== betaMobileBefore.width ? bounds : false;
      },
      "window B's mobile pane to follow its own new preset",
      8000,
    );
    const alphaMobileAfter = alphaHost.getTabContentBounds(tabA2, 'mobile');
    splitGeometry = {
      alphaMobile: alphaMobile.width,
      betaMobileBefore: betaMobileBefore.width,
      betaMobileAfter: betaMobileAfter.width,
      alphaMobileAfter: alphaMobileAfter && alphaMobileAfter.width,
    };
    observations.splitGeometry = splitGeometry;
    expect(alphaMobileAfter && alphaMobileAfter.width === alphaMobile.width, "window A's pane moved to " + JSON.stringify(alphaMobileAfter) + " when window B changed its preset");

    // Turning A's split off leaves B's split, its preset and its geometry exactly where they were.
    expect(await toolbarA.executeJavaScript('window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabA2) + ', false)', true) === false, 'window A reported split mode still on after disabling it');
    const alphaTabAfter = tabStateOf(alphaHost, tabA2);
    const betaTabAfter = tabStateOf(betaHost, tabB2);
    expect(alphaTabAfter.splitMode !== true, "window A's tab is still in split mode");
    expect(betaTabAfter.splitMode === true, "disabling window A's split disturbed window B's split");
    expect(betaTabAfter.splitMobilePresetId === 'ipad-mini', "window B's preset changed to " + String(betaTabAfter.splitMobilePresetId));
    const betaMobileUnchanged = betaHost.getTabContentBounds(tabB2, 'mobile');
    expect(betaMobileUnchanged && betaMobileUnchanged.width === betaMobileAfter.width, "window B's pane moved to " + JSON.stringify(betaMobileUnchanged) + " when window A left split mode");
  });

  // ------------------------- (7a) a native window.open popup belongs to its own window
  let popupChildId = null;
  // Row state, not callback state: this row rotates the active capsule and its cleanup is a
  // sibling callback, so a declaration inside the row body is not in the cleanup's scope.
  let activeCapsuleBeforePopup = null;
  await check('window.native-popup-inherits-window-affiliation', async function () {
    const alphaHost = hostOf(alphaKey);
    const betaHost = hostOf(betaEntry.ownerKey);

    // Diagnostic, never an assertion, and run before this row's own popup so it records even
    // when that one fails: the same page call from the tab row 6 had just toggled in and out
    // of split review - the opener the three runs before this one used, where no popup tab
    // appeared and the page's open call never settled. This bisects that: first a handler of
    // this scenario's own, whose only job is to record whether Chromium dispatched the request
    // out of this tab at all, then the product's own composition put back and asked the same
    // question, so the record says which side of the popup path stopped. Bounded, and any tab
    // either attempt creates is closed again.
    const splitOpenerContents = alphaHost.getTabWebContents(tabA2, 'desktop');
    if (splitOpenerContents && !splitOpenerContents.isDestroyed()) {
      const popupManager = require(compiledModule('browser/oauth-popup-manager.js')).OAuthPopupManager.getInstance();
      const alphaWindow = authority.windowFor(alphaKey);
      const productWindowOpenHandler = function (details) {
        return popupManager.handleWindowOpen(splitOpenerContents, alphaWindow, details, {
          onNewTabRequested: function (url) {
            const adoptedId = alphaHost.createTab(url, true);
            if (adoptedId) alphaHost.adoptChildTab(tabA2, adoptedId, undefined, 'native_window_open', tabA2);
          },
        });
      };
      const fireFromSplitOpener = async function (url, label) {
        const before = alphaHost.getTabList().map(function (tab) { return tab.id; });
        let settled = false;
        splitOpenerContents
          .executeJavaScript("String(window.open('" + url + "', '_blank'))", true)
          .then(function () { settled = true; })
          .catch(function () { settled = true; });
        let created = [];
        try {
          created = await waitFor(
            function () {
              const fresh = alphaHost.getTabList().filter(function (tab) { return before.indexOf(tab.id) === -1; });
              return fresh.length ? fresh.map(function (tab) { return tab.id; }) : false;
            },
            label,
            8000,
          );
        } catch (err) {
          created = [];
        }
        const record = { createdTabIds: created, callSettledAtCheck: settled };
        for (const createdId of created) {
          try {
            await toolbarA.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(createdId) + ')', true);
            await waitFor(
              function () { return alphaHost.hasExactTab(createdId) === false; },
              'the diagnostic popup tab to close',
              5000,
            );
          } catch (err) {
            console.log('  NOTE  the diagnostic popup tab could not be closed: ' + messageOf(err));
          }
        }
        return record;
      };

      // The control for everything below: does this tab's renderer run script at all while the
      // tab is in the background? A bounded evaluate is fired before anything else touches the
      // tab, then the tab is presented and a second evaluate is fired, and the first one is
      // checked again afterwards - if it runs only once the tab is presented, then a queued
      // evaluate is what the popup and DOM-read failures have been waiting on.
      const probeScript = async function (wc, expression, boundMs) {
        const probe = { expression: expression, settled: false, value: null, error: null };
        const started = Date.now();
        wc.executeJavaScript(expression, true)
          .then(function (value) { probe.settled = true; probe.value = String(value); probe.settledAfterMs = Date.now() - started; })
          .catch(function (err) { probe.settled = true; probe.error = messageOf(err); probe.settledAfterMs = Date.now() - started; });
        const deadline = Date.now() + boundMs;
        while (!probe.settled && Date.now() < deadline) await sleep(50);
        probe.settledWithinBound = probe.settled;
        return probe;
      };
      const backgroundScriptProbe = await probeScript(splitOpenerContents, '1 + 1', 8000);
      alphaHost.switchTab(tabA2);
      await waitFor(
        function () { return alphaHost.getActiveTabId() === tabA2; },
        'window A to present the tab with split history',
        8000,
      );
      const presentedScriptProbe = await probeScript(splitOpenerContents, '2 + 2', 8000);
      backgroundScriptProbe.settledOncePresented = backgroundScriptProbe.settled;

      let dispatched = null;
      splitOpenerContents.setWindowOpenHandler(function (details) {
        dispatched = { url: details.url, disposition: details.disposition };
        return { action: 'deny' };
      });
      const probePath = await fireFromSplitOpener('https://example.com/native-popup-probe', 'the scenario probe popup to be adopted');
      probePath.dispatchedToJs = dispatched;
      const splitOpenerRecord = {
        callerTabId: tabA2,
        backgroundScriptProbe: backgroundScriptProbe,
        presentedScriptProbe: presentedScriptProbe,
        probePath: probePath,
        productPath: null,
      };
      observations.splitOpenerPopup = splitOpenerRecord;

      // The probe answered whether Chromium hands the request to a handler for this tab at
      // all. When it does, the product's handler is put back and asked the same question,
      // which separates a handler that stops working here from a request Chromium never
      // delivers. Either way the product's handler is the one left installed.
      if (dispatched) {
        splitOpenerRecord.productPath = await fireFromSplitOpener('https://example.com/native-popup-product', 'the product popup to be adopted');
      } else {
        splitOpenerRecord.productPath = 'NOT_EXERCISED: Chromium never dispatched the probe request out of this tab';
      }
      splitOpenerContents.setWindowOpenHandler(productWindowOpenHandler);
    }

    // The opener is this window's first tab - a tab that has never entered split review. The
    // requirement is about the window a popup lands in, not about which tab asked for it, and
    // the tab row 6 toggled in and out of split review is exercised separately, as a bounded
    // diagnostic recorded below rather than as the opener this row is decided on.
    const parentTabId = tabA1;
    // The opener is presented first. A background tab's renderer does not run script in this
    // build - a bounded probe below measures exactly that - so opening the popup from an
    // unpresented tab would decide this row on the tab's rendering state instead of on where
    // the popup lands.
    alphaHost.switchTab(parentTabId);
    await waitFor(
      function () { return alphaHost.getActiveTabId() === parentTabId; },
      'window A to present the tab the popup is opened from',
    );
    const parentTab = tabStateOf(alphaHost, parentTabId);
    expect(parentTab, 'window A lost its parent tab ' + parentTabId);
    const parentContents = alphaHost.getTabWebContents(parentTabId, 'desktop');
    expect(parentContents && !parentContents.isDestroyed(), 'the parent tab has no page to open a popup from');
    const alphaTabsBefore = alphaHost.getTabList().map(function (tab) { return tab.id; });
    const betaTabsBefore = betaHost.getTabList().map(function (tab) { return tab.id; });
    // What this window's own record resolved for it: the capsule the popup has to inherit.
    const windowCapsule = alphaHost.resolveTerminalCreationTarget().capsuleId;
    expect(windowCapsule === ALPHA.capsuleId, "window A's own capsule was " + String(windowCapsule));
    expect(windowCapsule !== BETA.capsuleId, 'window A resolved window B capsule ' + BETA.capsuleId);

    // Make this row discriminating, not just passing. Window A is also the process-wide active
    // capsule in this scenario, so a child that merely took "the active capsule" would satisfy
    // the equality asserted above without reading its window at all. The active capsule is
    // therefore rotated to window B's for the duration of the popup and restored in cleanup:
    // a child that consults global state lands in B's workspace and fails the assertions below,
    // while one that reads its own window keeps A's capsule. The rotation is the same
    // manager-level switch the product performs when a workspace is reselected; it changes no
    // window's verified affiliation, which is exactly the point.
    const capsuleManager = alphaHost.capsuleManager;
    activeCapsuleBeforePopup = capsuleManager && capsuleManager.getActive() ? capsuleManager.getActive().id : null;
    if (capsuleManager) capsuleManager.switchTo(BETA.capsuleId);
    expect(
      capsuleManager && capsuleManager.getActive() && capsuleManager.getActive().id === BETA.capsuleId,
      'the active capsule could not be rotated to ' + BETA.capsuleId + ' for this row',
    );

    // The page asks for a real popup. Chromium hands the request to this tab's window-open
    // handler, which is where the child's affiliation is decided — before its page exists.
    // The handler denies the native window on purpose and opens the popup as a tab of this
    // window instead, which is why window.open answers null here instead of a WindowProxy.
    const popupUrl = 'https://example.com/native-popup';
    // The page's window.open result is recorded, never awaited. The product denies the native
    // window and opens the popup as a tab, so the page sees null either way — and this
    // Chromium build sometimes never settles the evaluate promise for exactly that denied
    // call (observed live: the popup tab was already open and attributed while the promise
    // stayed pending, stalling the row until its own bound). Awaiting it would decide the row
    // on Chromium's promise rather than on the popup this row is about.
    // Recorded before the call can settle, so the receipt always carries the fact that the
    // page asked: an absent observation would read as "no popup was requested", and the
    // promise's own outcome is written over this if it arrives.
    observations.nativePopupOpen = { parentTabId: parentTabId, windowOpenResult: 'UNSETTLED' };
    parentContents
      .executeJavaScript("String(window.open('" + popupUrl + "', '_blank'))", true)
      .then(function (value) {
        observations.nativePopupOpen = { parentTabId: parentTabId, windowOpenResult: value };
      })
      .catch(function (err) {
        observations.nativePopupOpen = { parentTabId: parentTabId, windowOpenError: messageOf(err) };
      });

    // Discovery reads the tab-list delta this row already measured, filtered by the URL the
    // page asked for. The product records a lineage only for a child adopted into a terminal
    // session's pool, and this row's parent is a plain user tab with no session, so a lineage
    // gate would wait for a record this scenario never creates — the popup is attributed here
    // by the window it landed in and the capsule/partition it carries, which is this row's
    // requirement. The lineage, when the product has one, is recorded as an observation.
    const child = await waitFor(
      function () {
        for (const tab of alphaHost.getTabList()) {
          if (alphaTabsBefore.indexOf(tab.id) !== -1) continue;
          if (tab.url !== popupUrl) continue;
          return { tab: tab, lineage: alphaHost.getTabLineage(tab.id) };
        }
        return false;
      },
      'the native popup to be adopted as a tab of window A',
    );
    popupChildId = child.tab.id;
    observations.nativePopup = {
      childTabId: child.tab.id,
      lineage: child.lineage,
      capsuleId: child.tab.capsuleId,
      partition: child.tab.partition,
      userAgentMode: child.tab.userAgentMode,
      parentCapsuleId: parentTab.capsuleId,
      parentPartition: parentTab.partition,
      parentUserAgentMode: parentTab.userAgentMode,
      windowCapsule: windowCapsule,
      activeCapsuleDuringPopup: capsuleManager && capsuleManager.getActive() ? capsuleManager.getActive().id : null,
      activeCapsuleBeforePopup: activeCapsuleBeforePopup,
    };
    // The product names a parent for a child it adopted into a terminal session's pool.
    // This row's parent is a plain user tab with no session, so an absent lineage is the
    // honest state here and is recorded rather than asserted; when the product does report
    // one, it must name this row's parent.
    if (child.lineage) {
      expect(child.lineage.parentTabId === parentTabId, 'the popup lineage named parent ' + String(child.lineage.parentTabId));
    } else {
      console.log('  NOTE  the popup carried no lineage record: its parent has no terminal session pool');
    }
    expect(alphaHost.hasTab(child.tab.id), 'the popup tab is not owned by window A');
    expect(betaHost.hasTab(child.tab.id) === false, 'the popup tab landed in window B');
    expect(
      betaHost.getTabList().map(function (tab) { return tab.id; }).join('|') === betaTabsBefore.join('|'),
      'window B tabs changed while a popup opened in window A',
    );
    expect(authority.hostForTab(child.tab.id) === alphaHost, 'the popup tab does not route to window A');
    // Inheritance: the child carries the window's own verified capsule — never another
    // window's capsule, and never an unassigned jar.
    expect(
      child.tab.capsuleId === parentTab.capsuleId,
      'the popup capsule was ' + String(child.tab.capsuleId) + ' while its parent carried ' + String(parentTab.capsuleId),
    );
    expect(child.tab.capsuleId === windowCapsule, 'the popup capsule was ' + String(child.tab.capsuleId) + ', this window is ' + String(windowCapsule));
    expect(child.tab.capsuleId !== BETA.capsuleId, 'the popup inherited window B capsule ' + BETA.capsuleId);
    expect(
      child.tab.partition === parentTab.partition,
      'the popup partition was ' + String(child.tab.partition) + ' while its parent ran in ' + String(parentTab.partition),
    );
    expect(
      typeof child.tab.partition === 'string' && child.tab.partition.indexOf('persist:') === 0,
      'the popup ran in an unassigned partition: ' + String(child.tab.partition),
    );
    expect(
      child.tab.userAgentMode === parentTab.userAgentMode,
      'the popup user agent mode was ' + String(child.tab.userAgentMode) + ' while its parent was ' + String(parentTab.userAgentMode),
    );

    // Leave the run as this row found it: the popup is opened and accounted for, then closed
    // through the window's own toolbar, and the active tab the earlier rows established is
    // restored. The tab-count rows later in this scenario count four per window.
    const closed = await toolbarA.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(child.tab.id) + ')', true);
    expect(closed === true, 'window A refused to close its own popup tab ' + child.tab.id);
    await waitFor(
      function () { return alphaHost.hasExactTab(child.tab.id) === false; },
      'window A to drop the closed popup tab',
    );
    alphaHost.switchTab(tabA2);
    expect(alphaHost.getActiveTabId() === tabA2, 'window A did not return to its own active tab ' + tabA2);
    expect(alphaHost.getTabList().length === alphaTabsBefore.length, 'window A kept ' + alphaHost.getTabList().length + ' tabs instead of ' + alphaTabsBefore.length);

    // The rotation is this row's own setup, so putting it back is this row's own claim: the
    // cleanup below repeats it on the failure path, but the receipt has to carry the
    // restoration as an observed fact rather than as a cleanup that might not have run.
    if (capsuleManager && activeCapsuleBeforePopup) {
      capsuleManager.switchTo(activeCapsuleBeforePopup);
      expect(
        capsuleManager.getActive() && capsuleManager.getActive().id === activeCapsuleBeforePopup,
        'the active capsule was not restored after the popup row: ' + String(capsuleManager.getActive() ? capsuleManager.getActive().id : null),
      );
      observations.nativePopupCapsuleRestored = { restoredTo: capsuleManager.getActive().id };
    }

  }, async function () {
    // Whatever happened above, this window does not hand the next row a popup tab it opened
    // and left active: the rows after this one address this window's own tab A2 and count its
    // tabs, and one aborted row must not turn into their failures.
    const host = hostOf(alphaKey);
    // The active capsule this row rotated to window B's is put back before any later row reads
    // terminal context, on the failure path as much as on the success path.
    if (host && host.capsuleManager && activeCapsuleBeforePopup) {
      try {
        host.capsuleManager.switchTo(activeCapsuleBeforePopup);
      } catch (err) {
        console.log('  NOTE  the active capsule could not be restored during cleanup: ' + messageOf(err));
      }
    }
    if (host && popupChildId !== null) {
      try {
        await toolbarA.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(popupChildId) + ')', true);
        await waitFor(
          function () { return host.hasExactTab(popupChildId) === false; },
          'the popup tab to be gone from window A',
          5000,
        );
      } catch (err) {
        console.log('  NOTE  the popup tab could not be closed during cleanup: ' + messageOf(err));
      }
    }
    if (host && tabA2) host.switchTab(tabA2);
  });

  // --------- (7b) minimize/restore keeps this window's target and refuses a foreign one
  await check('window.minimize-restore-keeps-target-authority', async function () {
    const alphaHost = hostOf(alphaKey);
    const betaHost = hostOf(betaEntry.ownerKey);
    const alphaWindow = authority.windowFor(alphaKey);
    expect(alphaWindow && !alphaWindow.isDestroyed(), 'window A has no native window');
    expect(betaHost.hasTab(tabB1), 'window B lost the tab this row compares against');
    alphaHost.setAutomationTabId(tabA2);
    betaHost.setAutomationTabId(tabB1);
    expect(alphaHost.getAutomationTabId() === tabA2, 'window A refused its own tab ' + tabA2 + ' as its target');

    alphaWindow.minimize();
    await waitFor(
      function () { return alphaWindow.isMinimized() === true; },
      'window A to minimize',
    );
    const minimized = {
      alphaTarget: alphaHost.getAutomationTabId(),
      betaTarget: betaHost.getAutomationTabId(),
      betaVisible: entryOf(authority.snapshot(), betaEntry.ownerKey).visible,
    };
    expect(minimized.alphaTarget === tabA2, 'minimizing window A moved its target to ' + String(minimized.alphaTarget));
    expect(minimized.betaTarget === tabB1, 'minimizing window A moved window B target to ' + String(minimized.betaTarget));

    alphaWindow.restore();
    await waitFor(
      function () { return alphaWindow.isMinimized() === false && alphaWindow.isVisible() === true; },
      'window A to restore',
    );
    const restored = {
      alphaTarget: alphaHost.getAutomationTabId(),
      betaTarget: betaHost.getAutomationTabId(),
      visible: entryOf(authority.snapshot(), alphaKey).visible,
    };
    expect(restored.alphaTarget === tabA2, 'restoring window A rotated its target to ' + String(restored.alphaTarget));
    expect(restored.betaTarget === tabB1, 'restoring window A rotated window B target to ' + String(restored.betaTarget));

    // A foreign window's tab can never become this window's target: the host clears rather
    // than adopting, so no silent authority rotation is possible.
    alphaHost.setAutomationTabId(tabB1);
    const afterForeign = alphaHost.getAutomationTabId();
    observations.minimizeRestore = {
      minimized: minimized,
      restored: restored,
      foreignTarget: { requested: tabB1, adopted: afterForeign },
    };
    expect(afterForeign !== tabB1, "window A adopted window B's tab " + tabB1 + ' as its target');
    expect(afterForeign === null, 'a refused foreign target left ' + String(afterForeign) + ' instead of clearing');
    alphaHost.setAutomationTabId(tabA2);
    expect(alphaHost.getAutomationTabId() === tabA2, 'window A could not take its own tab back as target');
  });

  // ------- (7c) two sessions in one project cannot cross-invoke each other's tabs
  await check('window.same-project-sessions-cannot-cross-invoke', async function () {
    const alphaHost = hostOf(alphaKey);
    const controlPlane = authority.controlPlane();
    expect(controlPlane, 'the process exposes no control plane');
    const tabOne = tabA1;
    const tabTwo = tabA2;
    expect(alphaHost.hasTab(tabOne) && alphaHost.hasTab(tabTwo), 'window A lost a tab this row needs');

    // Both sessions belong to the SAME project and the SAME window: the boundary under test is
    // the session, not the window.
    const sessionOne = await controlPlane.createCliSession({
      projectId: ALPHA.projectId,
      workspaceId: ALPHA.workspaceId,
      backendId: 'mcp',
      tabId: tabOne,
      grant: 'write',
    });
    const sessionTwo = await controlPlane.createCliSession({
      projectId: ALPHA.projectId,
      workspaceId: ALPHA.workspaceId,
      backendId: 'mcp',
      tabId: tabTwo,
      grant: 'write',
    });
    expect(sessionOne && sessionOne.launch && sessionTwo && sessionTwo.launch, 'a second session in the same project did not launch');

    const transport = new CapabilityTransportAdapter(controlPlane.capabilities, controlPlane.runs.attachments);
    const serverOne = new AntiFanMcpServer(alphaHost, false, transport, {
      attachmentId: sessionOne.launch.attachmentId,
      attachmentSecret: sessionOne.launch.secret,
      authorityRevision: sessionOne.launch.authorityRevision,
    });
    const serverTwo = new AntiFanMcpServer(alphaHost, false, transport, {
      attachmentId: sessionTwo.launch.attachmentId,
      attachmentSecret: sessionTwo.launch.secret,
      authorityRevision: sessionTwo.launch.authorityRevision,
    });

    // Every DOM read the shipping path performs is recorded, so a refusal that quietly fell
    // back to another tab would show up as a read of that tab.
    const domReads = [];
    const originalGetDom = NativeTabHost.prototype.getDom;
    try {
      NativeTabHost.prototype.getDom = async function patchedGetDom(selector, tabId, paneId) {
        domReads.push(String(tabId));
        return originalGetDom.call(this, selector, tabId, paneId);
      };
      const textOf = function (result) {
        return result && result.content && result.content[0] ? String(result.content[0].text) : '';
      };
      // The tabs these sessions are bound to are background tabs of their window, so the first
      // read measures what a bound session gets with the page never presented. That state is
      // recorded, not asserted: this row's requirement is the session boundary, and a tab whose
      // page has never been laid out is a separate question. The reads that decide the row run
      // with the tab presented - the binding is to the tab, not to its rendering.
      const backgroundOwnRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabOne });
      alphaHost.switchTab(tabOne);
      await waitFor(
        function () { return alphaHost.getActiveTabId() === tabOne; },
        'window A to present the tab session one is bound to',
      );
      const ownRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabOne });
      const crossRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabTwo });
      const readAfterCross = domReads.slice();
      alphaHost.switchTab(tabTwo);
      await waitFor(
        function () { return alphaHost.getActiveTabId() === tabTwo; },
        'window A to present the tab session two is bound to',
      );
      const siblingRead = await serverTwo.callTool('anti.inspect.dom', { tabId: tabTwo });
      observations.sameProjectSessions = {
        tabOne: tabOne,
        tabTwo: tabTwo,
        ownReadFailed: ownRead.isError === true ? textOf(ownRead) : null,
        crossRefused: crossRead.isError === true,
        crossText: textOf(crossRead),
        domReadsBeforeSibling: readAfterCross,
        siblingReadFailed: siblingRead.isError === true ? textOf(siblingRead) : null,
        domReads: domReads.slice(),
      };
      expect(ownRead.isError !== true, 'session one could not read its own tab: ' + textOf(ownRead));
      expect(crossRead.isError === true, 'session one read the sibling session tab: ' + textOf(crossRead));
      expect(textOf(crossRead).indexOf('TARGET_MISMATCH') !== -1, 'the refusal did not name the mismatch: ' + textOf(crossRead));
      expect(
        textOf(crossRead).indexOf(tabOne) !== -1 && textOf(crossRead).indexOf(tabTwo) !== -1,
        'the refusal did not name both the bound and the requested tab: ' + textOf(crossRead),
      );
      expect(readAfterCross.indexOf(tabTwo) === -1, 'the sibling session tab was read through anyway: ' + JSON.stringify(readAfterCross));
      expect(siblingRead.isError !== true, 'session two could not read its own tab: ' + textOf(siblingRead));
      expect(domReads.indexOf(tabTwo) !== -1, 'session two never reached its own tab: ' + JSON.stringify(domReads));
    } finally {
      NativeTabHost.prototype.getDom = originalGetDom;
      // This row is the only one that starts CLI sessions, and it ends them here: a live
      // interactive session keeps a streaming run and an attachment on its tab alive by
      // design, so two sessions left running would make the close rows later in this scenario
      // address a window that is rightly busy - a refusal about work this scenario created,
      // not about the behaviour those rows measure.
      for (const release of [
        { label: 'session one', server: serverOne, session: sessionOne },
        { label: 'session two', server: serverTwo, session: sessionTwo },
      ]) {
        try {
          await release.server.stop();
          await controlPlane.endCliSession(release.session.run.id, release.session.attempt.id, 'completed');
        } catch (err) {
          console.log('  NOTE  ' + release.label + ' could not be released: ' + messageOf(err));
        }
      }
    }
  });

  // ---------------------------- (7) a background window's page is laid out and capturable
  await check('window.background-surface-and-capture-ready', async function () {
    const betaHost = hostOf(betaEntry.ownerKey);
    const alphaWindow = authority.windowFor(alphaKey);
    const betaWindow = authority.windowFor(betaEntry.ownerKey);
    expect(alphaWindow && !alphaWindow.isDestroyed(), 'window A has no native window to present');
    expect(betaWindow && !betaWindow.isDestroyed(), 'window B has no native window');

    // The subject is the window, not the occlusion: the two windows are placed side by side so
    // neither covers the other (a covered window is a different, legitimate case where the
    // compositor may stop rasterizing). Where this display cannot hold both, the run records
    // that instead of measuring an overlapped window and calling the result a rendering verdict.
    const workArea = screen.getPrimaryDisplay().workArea;
    const tiled = workArea.width >= 2 * SHELL_MIN_WIDTH + 16 && workArea.height >= SHELL_MIN_HEIGHT;
    if (tiled) {
      const halfWidth = Math.floor(workArea.width / 2);
      const height = Math.min(workArea.height, 900);
      alphaWindow.setBounds({ x: workArea.x, y: workArea.y, width: halfWidth, height: height });
      betaWindow.setBounds({ x: workArea.x + halfWidth, y: workArea.y, width: halfWidth, height: height });
    }
    if (alphaWindow.isMinimized()) alphaWindow.restore();
    alphaWindow.show();
    alphaWindow.focus();
    // Criterion 5 is about two windows on screen at once with A holding the foreground, and the
    // shipping composition builds every shell hidden: this row presents B without focusing it
    // rather than assuming an earlier row left it presented.
    if (betaWindow.isMinimized()) betaWindow.restore();
    betaWindow.showInactive();
    const betaEntryUnfocused = await waitFor(
      function () {
        const entry = entryOf(authority.snapshot(), betaEntry.ownerKey);
        return entry && entry.focused === false && betaWindow.isVisible() === true ? entry : false;
      },
      'window B to be presented in the background without taking the foreground',
    );

    const surface = await betaHost.readRenderSurface(tabB2, 'desktop');
    observations.backgroundSurface = {
      mode: tiled ? 'tiled' : 'stacked',
      workArea: { width: workArea.width, height: workArea.height },
      surface: surface,
      activeTabId: betaEntryUnfocused.activeTabId,
      visible: betaEntryUnfocused.visible,
      focused: betaEntryUnfocused.focused,
      presented: betaWindow.isVisible(),
      foregroundBeforeCapture: alphaWindow.isFocused(),
    };
    // Independent of tiling: the page in the other window still has a real layout viewport.
    expect(surface && surface.vw > 0 && surface.vh > 0, "window B's page has no laid-out viewport: " + JSON.stringify(surface));

    if (!tiled) {
      observations.backgroundCapture = null;
      console.log('  NOTE  windows were not tiled (work area ' + workArea.width + 'x' + workArea.height + '): a raster of an overlapped window is deferred to a display that can hold both, and no pixels are claimed here');
      return;
    }
    // document.hidden flips a frame after showInactive() — the visibility transition reaches
    // the renderer asynchronously — so the row waits for the page to see itself presented rather
    // than sampling the frame that still precedes the transition.
    const presentedSurface = surface.hidden === false
      ? surface
      : await waitFor(
          async function () {
            const candidate = await betaHost.readRenderSurface(tabB2, 'desktop');
            return candidate && candidate.hidden === false ? candidate : false;
          },
          "window B's page to stop reporting itself hidden",
        );
    observations.backgroundSurface = { ...observations.backgroundSurface, presentedSurface: presentedSurface };
    expect(presentedSurface.hidden === false, "window B's page reports itself hidden: " + JSON.stringify(presentedSurface));
    // Capturing a background window must not take the foreground from the window the user is
    // in: the capture path attaches the tab's own view for the raster, and evidence says so.
    const betaFocusedBeforeCapture = betaWindow.isFocused();
    const capture = await betaHost.captureVerificationScreenshot(undefined, tabB2, 'desktop');
    const betaFocusedAfterCapture = betaWindow.isFocused();
    const alphaFocusedAfterCapture = alphaWindow.isFocused();
    observations.backgroundCapture = capture
      ? {
          backend: capture.backend,
          rasterSize: capture.rasterSize,
          bytes: typeof capture.data === 'string' ? capture.data.length : 0,
          betaFocused: { before: betaFocusedBeforeCapture, after: betaFocusedAfterCapture },
          alphaFocusedAfterCapture: alphaFocusedAfterCapture,
        }
      : null;
    expect(capture && typeof capture.data === 'string' && capture.data.length > 0, 'the background capture returned no pixels');
    expect(capture.rasterSize && capture.rasterSize.width > 0 && capture.rasterSize.height > 0, 'the background capture has no raster size: ' + JSON.stringify(capture.rasterSize));
    expect(
      betaFocusedBeforeCapture === false && betaFocusedAfterCapture === false,
      "capturing window B's background tab moved the foreground to B: before " + String(betaFocusedBeforeCapture) + ', after ' + String(betaFocusedAfterCapture),
    );
  });

  // ---------------------------------------------- (8) cross-window search: inventory + labels
  await check('window.search-lists-every-window', async function () {
    const inventory = await toolbarA.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    observations.inventory = inventory;
    expect(inventory && inventory.status === 'OK', 'the search returned ' + JSON.stringify(inventory));
    const rows = inventory.rows || [];
    const byId = {};
    for (const row of rows) byId[row.tabId] = row;
    for (const tabId of [tabA1, tabA2, tabB1, tabB2]) {
      expect(byId[tabId], 'tab ' + tabId + ' is missing from the inventory: ' + JSON.stringify(rows.map(function (row) { return row.tabId; })));
    }
    const snapshot = authority.snapshot();
    const alpha = entryOf(snapshot, alphaKey);
    const beta = entryOf(snapshot, betaEntry.ownerKey);
    expect(byId[tabA1].ownerLabel === alpha.identity.title, 'the tab A label was ' + String(byId[tabA1].ownerLabel) + ', window A calls itself ' + String(alpha.identity.title));
    expect(byId[tabB1].ownerLabel === beta.identity.title, 'the tab B label was ' + String(byId[tabB1].ownerLabel) + ', window B calls itself ' + String(beta.identity.title));
    expect(samePath(byId[tabB1].pathLabel, BETA.path), 'the tab B path label was ' + String(byId[tabB1].pathLabel));

    // Listing has no side effects: the other window sees the same inventory.
    const fromB = await toolbarB.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(fromB && fromB.status === 'OK', 'the search from window B returned ' + JSON.stringify(fromB));
    const keyOf = function (result) {
      return JSON.stringify((result.rows || []).map(function (row) { return [row.tabId, row.ownerLabel, row.live]; }));
    };
    expect(keyOf(fromB) === keyOf(inventory), 'two windows listed different inventories');
  });

  // -------------------------- (9) activation presents the tab and moves no execution authority
  await check('window.search-activates-foreign-tab-without-authority-rotation', async function () {
    const alphaHost = hostOf(alphaKey);
    const betaHost = hostOf(betaEntry.ownerKey);
    // An agent's automation target is the execution authority for its window. It is set here
    // through the same host seam attachment binding uses, so the user activation below is
    // measured against real authority rather than against an empty field.
    alphaHost.setAutomationTabId(tabA2);
    betaHost.setAutomationTabId(tabB2);

    const before = authority.snapshot();
    const activation = await toolbarA.executeJavaScript('window.antifanToolbar.activateProjectTab(' + JSON.stringify(tabB1) + ')', true);
    const after = await waitFor(
      function () {
        const current = authority.snapshot();
        return entryOf(current, betaEntry.ownerKey).activeTabId === tabB1 ? current : false;
      },
      'window B to present the tab the search asked for',
    );
    observations.activation = {
      result: activation,
      alphaActiveBefore: entryOf(before, alphaKey).activeTabId,
      alphaActiveAfter: entryOf(after, alphaKey).activeTabId,
      betaActiveAfter: entryOf(after, betaEntry.ownerKey).activeTabId,
      alphaAutomation: alphaHost.getAutomationTabId(),
      betaAutomation: betaHost.getAutomationTabId(),
    };
    expect(activation && activation.status === 'ACTIVATED', 'the foreign activation returned ' + JSON.stringify(activation));
    expect(activation.tabId === tabB1, 'the foreign activation named tab ' + String(activation.tabId));
    expect(entryOf(after, betaEntry.ownerKey).activeTabId === tabB1, 'window B active tab was ' + entryOf(after, betaEntry.ownerKey).activeTabId + ', expected ' + tabB1);
    expect(entryOf(after, alphaKey).activeTabId === entryOf(before, alphaKey).activeTabId, 'the invoking window moved its own active tab to ' + entryOf(after, alphaKey).activeTabId);
    expect(alphaHost.getAutomationTabId() === tabA2, "the invoking window's automation target moved to " + String(alphaHost.getAutomationTabId()));
    expect(betaHost.getAutomationTabId() === tabB2, "the presented window's automation target moved to " + String(betaHost.getAutomationTabId()));
  });

  // ------------------------------------------------------------- (10) stale results refuse
  await check('window.search-stale-refusal-no-fallback', async function () {
    const betaHost = hostOf(betaEntry.ownerKey);
    const before = authority.snapshot();

    const never = await toolbarA.executeJavaScript("window.antifanToolbar.activateProjectTab('tab-that-never-existed')", true);
    expect(never && never.status === 'UNAVAILABLE', 'a never-existing tab returned ' + JSON.stringify(never));
    expect(never.reasonCode === 'TAB_CLOSED', 'a never-existing tab reported ' + String(never.reasonCode));
    expect(never.tabId === 'tab-that-never-existed', 'a refused activation named tab ' + String(never.tabId));

    // A real tab that has since closed: the exact case a rendered search result goes stale in.
    expect(await toolbarB.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(tabB2) + ')', true) === true, 'window B refused to close its own tab ' + tabB2);
    await waitFor(
      function () { return betaHost.hasExactTab(tabB2) === false; },
      'window B to drop the closed tab',
    );
    const stale = await toolbarA.executeJavaScript('window.antifanToolbar.activateProjectTab(' + JSON.stringify(tabB2) + ')', true);
    const after = authority.snapshot();
    observations.staleActivation = { never: never, closedTab: stale };
    expect(stale && stale.status === 'UNAVAILABLE', 'a closed tab returned ' + JSON.stringify(stale));
    expect(stale.reasonCode === 'TAB_CLOSED', 'a closed tab reported ' + String(stale.reasonCode));
    expect(stale.tabId === tabB2, 'the refusal named tab ' + String(stale.tabId));
    const activeBefore = before.map(function (entry) { return entry.activeTabId; }).join('|');
    const activeAfter = after.map(function (entry) { return entry.activeTabId; }).join('|');
    expect(activeBefore === activeAfter, 'a refused activation moved an active tab: ' + activeBefore + ' -> ' + activeAfter);
    const focusBefore = before.map(function (entry) { return entry.focused; }).join('|');
    const focusAfter = after.map(function (entry) { return entry.focused; }).join('|');
    expect(focusBefore === focusAfter, 'a refused activation moved window focus');
    expect(entryOf(after, betaEntry.ownerKey).activeTabId === tabB1, 'window B fell back to another tab: ' + entryOf(after, betaEntry.ownerKey).activeTabId);
  });

  // ------------------------------------------------- (11) five projects, twenty visible tabs
  await check('window.five-projects-twenty-tabs', async function () {
    for (const project of [GAMMA, DELTA, EPSILON]) {
      const opened = await openProjectFromSidebar(sidebarA, project);
      expect(opened.result && opened.result.status === 'OPENED', 'opening ' + project.name + ' returned ' + JSON.stringify(opened.result));
    }
    expect(authority.browserShellCount() === 5, 'browserShellCount() was ' + authority.browserShellCount() + ' for five projects');

    const windows = [];
    for (const project of PROJECTS) {
      const entry = authority.snapshot().find(function (candidate) {
        return candidate.owner.kind === 'project' && candidate.owner.projectId === project.projectId;
      });
      expect(entry, 'no window for ' + project.name);
      const shell = authority.shellFor(entry.ownerKey);
      const toolbar = surfaceOf(shell, 'toolbar');
      expect(toolbar, 'no toolbar surface for ' + project.name);
      await waitForApi(toolbar, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
      windows.push({ project: project, entry: entry, toolbar: toolbar });
    }

    // Four visible tabs per window, created through that window's own toolbar.
    for (const window of windows) {
      for (let index = window.entry.tabIds.length; index < 4; index += 1) {
        const created = await window.toolbar.executeJavaScript("window.antifanToolbar.createTab('about:blank')", true);
        expect(typeof created === 'string' && created.length > 0, window.project.name + ' created no tab at index ' + index);
      }
    }

    // Each window's own toolbar channel is what its renderer paints the strip from. Asking it
    // is a different path than the directory's snapshot: the title bar of each window shows the
    // tabs of that window, under that window's own project identity.
    const stripByWindow = {};
    for (const window of windows) {
      const state = await waitFor(
        async function () {
          const value = await window.toolbar.executeJavaScript('window.antifanToolbar.getInitialState()', true);
          return value && Array.isArray(value.tabs) && value.tabs.length === 4 ? value : false;
        },
        window.project.name + ' to paint four tabs in its own strip',
      );
      expect(state.projectWindow && state.projectWindow.owner.projectId === window.project.projectId, window.project.name + ' painted identity ' + JSON.stringify(state.projectWindow && state.projectWindow.owner));
      stripByWindow[window.entry.ownerKey] = { tabIds: state.tabs.map(function (tab) { return tab.id; }).sort(), activeTabId: state.activeTabId };
    }

    const snapshot = authority.snapshot();
    const perWindow = snapshot.map(function (entry) {
      const host = hostOf(entry.ownerKey);
      expect(host, 'no host behind ' + entry.ownerKey);
      const strip = stripByWindow[entry.ownerKey];
      expect(strip, 'window ' + entry.ownerKey + ' never answered its own toolbar');
      expect(
        strip.tabIds.join('|') === entry.tabIds.slice().sort().join('|'),
        'the strip a window painted and the directory disagree for ' + entry.ownerKey + ': ' + JSON.stringify(strip.tabIds) + ' vs ' + JSON.stringify(entry.tabIds),
      );
      expect(strip.activeTabId === entry.activeTabId, 'window ' + entry.ownerKey + ' painted active tab ' + String(strip.activeTabId) + ' while the directory said ' + String(entry.activeTabId));
      return { ownerKey: entry.ownerKey, label: entry.identity.title, path: entry.identity.pathLabel, tabIds: entry.tabIds.slice() };
    });
    const allIds = [];
    for (const entry of perWindow) {
      expect(entry.tabIds.length === 4, entry.label + ' has ' + entry.tabIds.length + ' tabs, expected 4');
      for (const tabId of entry.tabIds) {
        expect(allIds.indexOf(tabId) === -1, 'tab ' + tabId + ' is owned by two windows');
        allIds.push(tabId);
      }
    }
    expect(authority.browserShellCount() === 5, 'browserShellCount() was ' + authority.browserShellCount());
    expect(allIds.length === 20, 'the process presents ' + allIds.length + ' visible tabs, expected 20');

    // The routing answer is per window: each tab resolves to the host that presents it.
    for (const entry of perWindow) {
      const host = hostOf(entry.ownerKey);
      for (const tabId of entry.tabIds) {
        expect(authority.hostForTab(tabId) === host, 'tab ' + tabId + ' did not resolve to its own window host');
      }
    }

    // One search sees all twenty, each row labelled with the window that shows it.
    const inventory = await toolbarA.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(inventory && inventory.status === 'OK', 'the five-window search returned ' + JSON.stringify(inventory));
    const rows = inventory.rows || [];
    const ownerByTab = {};
    for (const row of rows) ownerByTab[row.tabId] = row;
    for (const entry of perWindow) {
      for (const tabId of entry.tabIds) {
        const row = ownerByTab[tabId];
        expect(row, 'tab ' + tabId + ' is missing from the five-window inventory');
        expect(row.ownerLabel === entry.label, 'tab ' + tabId + ' was labelled ' + String(row.ownerLabel) + ', expected ' + String(entry.label));
        expect(samePath(row.pathLabel, entry.path), 'tab ' + tabId + ' carried path label ' + String(row.pathLabel));
      }
    }
    const fromLast = await windows[windows.length - 1].toolbar.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(fromLast && fromLast.status === 'OK', 'the search from the last window returned ' + JSON.stringify(fromLast));
    expect(JSON.stringify((fromLast.rows || []).map(function (row) { return row.tabId; }).sort()) === JSON.stringify(rows.map(function (row) { return row.tabId; }).sort()), 'two windows listed different five-window inventories');

    observations.volume = { shellCount: authority.browserShellCount(), tabCount: allIds.length, windows: perWindow, inventoryRows: rows.length };
  });

  // ------------------------------------------- (12) an agent-intent window never presents
  await check('window.agent-intent-window-stays-unpresented', async function () {
    const presentationCalls = [];
    const patched = [];
    for (const method of ['show', 'showInactive', 'focus', 'moveTop', 'maximize', 'restore']) {
      const original = BrowserWindow.prototype[method];
      if (typeof original !== 'function') continue;
      patched.push([method, original]);
      BrowserWindow.prototype[method] = function patchedMethod() {
        presentationCalls.push({ method: method, windowId: this.id });
        return original.apply(this, arguments);
      };
    }

    let agentEntry = null;
    try {
      const before = authority.snapshot();
      agentEntry = await authority.ensureProjectWindow({ kind: 'project', projectId: UNRECORDED.projectId }, 'agent');
      // A presentation that arrives late is still a presentation, so the observation stays open
      // for a bounded window instead of a single instant: the editor's own creation path is
      // asynchronous, and reading the call list once would race it.
      for (let round = 0; round < 4; round += 1) {
        await sleep(100);
        expect(
          presentationCalls.filter(function (call) { return call.windowId === agentEntry.windowId; }).length === 0,
          'the agent window was presented: ' + JSON.stringify(presentationCalls.filter(function (call) { return call.windowId === agentEntry.windowId; })),
        );
      }
      const after = authority.snapshot();
      observations.agentWindow = {
        entry: agentEntry,
        callsForAgentWindow: presentationCalls.filter(function (call) { return call.windowId === agentEntry.windowId; }),
        callsForOtherWindows: presentationCalls.filter(function (call) { return call.windowId !== agentEntry.windowId; }),
      };
      expect(presentationCalls.filter(function (call) { return call.windowId === agentEntry.windowId; }).length === 0, 'the agent window was presented: ' + JSON.stringify(observations.agentWindow.callsForAgentWindow));
      expect(presentationCalls.filter(function (call) { return call.windowId !== agentEntry.windowId; }).length === 0, 'creating the agent window presented other windows: ' + JSON.stringify(observations.agentWindow.callsForOtherWindows));
      const window = authority.windowFor(agentEntry.ownerKey);
      expect(window && !window.isDestroyed(), 'the agent window has no native window');
      expect(window.isVisible() === false, 'the agent window is visible');
      expect(window.isFocused() === false, 'the agent window is focused');
      for (const entry of after) {
        if (entry.ownerKey === agentEntry.ownerKey) continue;
        const previous = before.find(function (candidate) { return candidate.ownerKey === entry.ownerKey; });
        if (!previous) continue;
        expect(entry.visible === previous.visible, 'window ' + entry.ownerKey + ' visibility changed while the agent window was created');
        expect(entry.focused === previous.focused, 'window ' + entry.ownerKey + ' focus changed while the agent window was created');
      }
      expect(agentEntry.title.indexOf(UNRECORDED.projectId) === 0, 'an unrecorded project showed the title ' + String(agentEntry.title) + ' instead of its id');
      expect(agentEntry.identity.workspacePath === undefined, 'the agent window claims workspace ' + String(agentEntry.identity.workspacePath));
    } finally {
      for (const [method, original] of patched) {
        BrowserWindow.prototype[method] = original;
      }
    }

    // The agent window is a managed window like any other: it closes without taking a sibling.
    expect(authority.requestClose(agentEntry.ownerKey) === true, 'the close request never reached the agent window');
    await waitFor(
      function () { return authority.browserShellCount() === 5; },
      'the agent window to close',
    );
    const remaining = authority.snapshot();
    expect(!remaining.some(function (entry) { return entry.ownerKey === agentEntry.ownerKey; }), 'the agent window is still in the directory');
    expect(remaining.length === 5, 'the directory lists ' + remaining.length + ' windows after the agent window closed');
  });

  // --------------------------------------------------- (13) closing one window keeps siblings
  let alphaWindowBeforeClose = null;
  let betaTabsBeforeClose = null;
  let siblingTabsBeforeClose = null;

  await check('window.close-keeps-sibling-and-tabs', async function () {
    const before = authority.snapshot();
    betaTabsBeforeClose = entryOf(before, betaEntry.ownerKey).tabIds.slice();
    siblingTabsBeforeClose = before
      .filter(function (entry) { return entry.ownerKey !== alphaKey; })
      .map(function (entry) { return { ownerKey: entry.ownerKey, tabIds: entry.tabIds.slice(), activeTabId: entry.activeTabId }; });
    alphaWindowBeforeClose = authority.windowFor(alphaKey);
    expect(alphaWindowBeforeClose && !alphaWindowBeforeClose.isDestroyed(), 'window A has no native window');
    // Nothing is bound to window A's pages here, so this is the idle close the spec describes.
    hostOf(alphaKey).setAutomationTabId(undefined);

    expect(authority.requestClose(alphaKey) === true, 'the close request never reached window A');
    await waitFor(
      function () { return authority.browserShellCount() === 4; },
      'window A to close',
    );
    // The shell count dropping is the close; the directory unregistering the host and its tabs
    // is the settle that this row judges, so wait for that state rather than a duration.
    await waitFor(
      function () { return authority.hostForOwner(alphaKey) === null && authority.hostForTab(tabA1) === null; },
      "the closed window's host and tabs to stop resolving",
    );
    const after = authority.snapshot();
    observations.close = { accepted: true, shellCount: authority.browserShellCount(), remaining: after.map(function (entry) { return entry.ownerKey; }) };
    expect(!entryOf(after, alphaKey), 'the closed window is still in the directory');
    expect(alphaWindowBeforeClose.isDestroyed() === true, "the closed window's native window survived");

    const betaAfter = entryOf(after, betaEntry.ownerKey);
    expect(betaAfter, 'window B disappeared with window A');
    expect(JSON.stringify(betaAfter.tabIds) === JSON.stringify(betaTabsBeforeClose), 'window B tabs changed from ' + JSON.stringify(betaTabsBeforeClose) + ' to ' + JSON.stringify(betaAfter.tabIds));
    const betaWindow = authority.windowFor(betaEntry.ownerKey);
    expect(betaWindow && !betaWindow.isDestroyed(), "window B's native window was destroyed");
    for (const entry of siblingTabsBeforeClose) {
      if (entry.ownerKey === betaEntry.ownerKey) continue;
      const current = entryOf(after, entry.ownerKey);
      expect(current && JSON.stringify(current.tabIds) === JSON.stringify(entry.tabIds), 'window ' + entry.ownerKey + ' lost tabs with window A');
      expect(current.activeTabId === entry.activeTabId, 'window ' + entry.ownerKey + ' changed its active tab when window A closed');
    }

    // The closed window's authority is gone: its host is unregistered and its tabs stop resolving.
    expect(authority.hostForOwner(alphaKey) === null, 'the closed window still has a host');
    expect(authority.hostForTab(tabA1) === null, "the closed window's tab " + tabA1 + ' still resolves to a host');
    expect(authority.hostForTab(betaTabsBeforeClose[0]) !== null, "window B's first tab no longer resolves to a host");
    for (const tabId of betaTabsBeforeClose) {
      expect(authority.hostForTab(tabId) === hostOf(betaEntry.ownerKey), 'window B tab ' + tabId + ' did not resolve back to window B');
    }
    expect(app.isReady() === true, 'the app is no longer ready after a window closed');
    expect(BrowserWindow.getAllWindows().some(function (window) { return window.id === betaWindow.id; }), "window B's native window is gone");
  });

  // --------------------- (14) the surviving window's toolbar and accelerator paths still work
  await check('window.survivor-toolbar-and-accelerator-after-sibling-close', async function () {
    const betaHost = hostOf(betaEntry.ownerKey);
    const toolbar = surfaceOf(authority.shellFor(betaEntry.ownerKey), 'toolbar');
    expect(toolbar, 'the surviving window has no toolbar surface');
    const toolbarTab = await toolbar.executeJavaScript("window.antifanToolbar.createTab('about:blank')", true);
    expect(typeof toolbarTab === 'string' && toolbarTab.length > 0, 'the surviving toolbar created no tab: ' + JSON.stringify(toolbarTab));
    await waitFor(
      function () { return betaHost.getActiveTabId() === toolbarTab; },
      "the surviving window's toolbar tab to become active",
    );

    // The application menu's New Tab carries the keyboard accelerator; invoking its handler with
    // this window is the command that accelerator dispatches, resolved per window by the directory.
    const menu = Menu.getApplicationMenu();
    const newTabItem = findMenuItem(menu, 'New Tab');
    expect(newTabItem && typeof newTabItem.click === 'function', 'the application menu has no invokable New Tab item');
    expect(String(newTabItem.accelerator || '') === 'CmdOrCtrl+T', 'the New Tab accelerator was ' + String(newTabItem.accelerator));
    const betaWindow = authority.windowFor(betaEntry.ownerKey);
    expect(betaWindow && !betaWindow.isDestroyed(), 'the surviving window has no native window');
    const beforeAccelerator = betaHost.getTabList().map(function (tab) { return tab.id; });
    newTabItem.click(newTabItem, betaWindow, {});
    await waitFor(
      function () { return betaHost.getTabList().length === beforeAccelerator.length + 1; },
      "the accelerator's command to create a tab",
    );
    const afterAccelerator = betaHost.getTabList().map(function (tab) { return tab.id; });
    const createdByAccelerator = afterAccelerator.filter(function (tabId) { return beforeAccelerator.indexOf(tabId) === -1; });
    expect(createdByAccelerator.length === 1, "the accelerator's command created " + createdByAccelerator.length + ' tabs: ' + JSON.stringify(createdByAccelerator));
    observations.survivorPaths = {
      toolbarTab: toolbarTab,
      acceleratorTab: createdByAccelerator[0],
      acceleratorActive: betaHost.getActiveTabId(),
      windowCount: authority.browserShellCount(),
    };
    expect(createdByAccelerator[0] !== toolbarTab, 'the accelerator reused the tab the toolbar had just created');
    expect(betaHost.getActiveTabId() === createdByAccelerator[0], "the accelerator's tab did not become active in the window it resolved");

    // A window no shell describes refuses the command instead of acting on another window. Both
    // handler paths are synchronous, so a tab created for either would already be in the
    // directory: the bounded re-read is what makes the absence an observation, not one sample.
    const totalBefore = allTabIds().length;
    expect(alphaWindowBeforeClose.isDestroyed() === true, 'the closed window unexpectedly survived for the refusal case');
    newTabItem.click(newTabItem, alphaWindowBeforeClose, {});
    newTabItem.click(newTabItem, null, {});
    for (let round = 0; round < 3; round += 1) {
      await sleep(100);
      expect(allTabIds().length === totalBefore, 'a menu command for a window no shell describes created a tab somewhere else');
    }
  });

  // ------------------------------------------------------------- (15) orderly owned teardown
  await check('window.cleanup-closes-every-shell', async function () {
    for (const entry of authority.snapshot()) {
      authority.requestClose(entry.ownerKey);
    }
    await waitFor(
      function () { return authority.browserShellCount() === 0; },
      'every remaining browser shell to close',
    );
    observations.teardown = { shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 0, 'browserShellCount() was ' + authority.browserShellCount());
  });
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
  } catch (err) {
    console.log('  NOTE  cleanup could not close every window: ' + messageOf(err));
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (err) {
    console.log('  NOTE  throwaway root survived: ' + messageOf(err));
  }
}

let exitCode = 1;
app.whenReady()
  .then(run)
  .catch(function (err) {
    check('scenario completed without an unexpected throw', function () {
      throw err;
    });
  })
  .finally(async function () {
    await cleanup();
    const failed = checks.filter(function (entry) { return !entry.ok; });
    const result = {
      scenario: 'project-windows-lifecycle',
      passed: checks.length - failed.length,
      failed: failed.length,
      checks: checks,
      observations: observations,
      deferred: DEFERRED,
      at: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(EVIDENCE_FILE), { recursive: true });
      fs.writeFileSync(EVIDENCE_FILE, JSON.stringify(result, null, 2), 'utf8');
    } catch (err) {
      console.log('[project-windows-e2e] failed to write evidence: ' + messageOf(err));
      process.exit(1);
    }
    console.log('[project-windows-e2e] ' + result.passed + ' passed, ' + result.failed + ' failed — evidence: ' + EVIDENCE_FILE);
    exitCode = failed.length === 0 ? 0 : 1;
    process.exit(exitCode);
  });
`;

describe('Live E2E: independent project windows lifecycle', () => {
  it('certifies multi-window tabs, split, search, close and survivor paths in the real app', async () => {
    const rootDir = process.cwd();
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const compiledEntry = path.join(rootDir, '.compiled', 'src', 'main', 'index.js');
    assert.ok(fs.existsSync(runnerScript), `the Electron runner is missing: ${runnerScript}`);
    assert.ok(
      fs.existsSync(compiledEntry),
      `the compiled main process is missing (${compiledEntry}); run \`npm run compile\` before the e2e lane`,
    );

    // The driver uses no template literals of its own, so this source can be a template
    // literal here. Guard the property instead of trusting it: a backtick or an interpolation
    // would silently change the scenario the app runs.
    assert.ok(!PROJECT_WINDOWS_DRIVER_SOURCE.includes('`'), 'the driver source must not contain a backtick');
    assert.ok(!PROJECT_WINDOWS_DRIVER_SOURCE.includes('${'), 'the driver source must not contain an interpolation');

    const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-pw-e2e-driver-'));
    const driverPath = path.join(driverDir, 'project-windows-driver.cjs');
    const evidencePath = path.join(rootDir, EVIDENCE_PATH);
    fs.writeFileSync(driverPath, PROJECT_WINDOWS_DRIVER_SOURCE, 'utf8');
    try { fs.unlinkSync(evidencePath); } catch {}

    // A broken scenario must fail here rather than half-way through an Electron boot.
    const syntax = spawnSync(process.execPath, ['--check', driverPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `the generated driver does not parse:\n${syntax.stdout}\n${syntax.stderr}`);

    const port = await pickFreePort();
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    env.ANTIFAN_DRIVER_REPO_ROOT = rootDir;
    env.ANTIFAN_DRIVER_EVIDENCE = evidencePath;
    env.ANTIFAN_DRIVER_BRIDGE_PORT = String(port);

    const proc = spawn(process.execPath, [runnerScript, driverPath], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => { stdout += data.toString('utf8'); });
    proc.stderr?.on('data', (data) => { stderr += data.toString('utf8'); });

    // A wall-clock watchdog for a hung Electron child, which no fake timer can reap. On Windows
    // taskkill /T /F takes the whole tree; elsewhere SIGKILL after a short grace.
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(proc);
    }, RUN_TIMEOUT_MS);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    proc.once('error', exited.reject);
    proc.once('exit', (code, signal) => exited.resolve({ code, signal }));
    try {
      exit = await exited.promise;
    } finally {
      clearTimeout(timeoutTimer);
      killProcessTree(proc);
    }

    const transcript = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    try {
      assert.equal(timedOut, false, `the project-window scenario timed out after ${RUN_TIMEOUT_MS}ms; killed child exited with code ${exit.code}, signal ${exit.signal}\n${transcript}`);
      // The single-instance lock is keyed by the profile this run created; a refusal here would
      // mean the scenario attached to someone else's instance instead of its own.
      assert.ok(!stdout.includes('Another instance is already running'), `the run was refused the single-instance lock\n${transcript}`);
      assert.equal(exit.code, 0, `the project-window scenario must exit cleanly\n${transcript}`);
      assert.match(stdout, /\[project-windows-e2e\] \d+ passed, 0 failed/);
      assert.ok(fs.existsSync(evidencePath), `the scenario wrote no evidence at ${evidencePath}\n${transcript}`);

      const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as DriverEvidence;
      assert.equal(evidence.scenario, 'project-windows-lifecycle');
      assert.equal(evidence.failed, 0, `the scenario reported failures: ${JSON.stringify(evidence.checks.filter((row) => !row.ok))}`);

      const reported = evidence.checks.map((row) => row.name);
      for (const name of EXPECTED_ROWS) {
        assert.ok(reported.includes(name), `the driver never reported row ${name}`);
      }
      // A row the suite does not know may only ever arrive failing: the driver's own
      // "unexpected throw" row is the one legitimate extra, and renaming a real row still trips
      // the loop above.
      const unexpected = evidence.checks.filter((row) => row.ok && !EXPECTED_ROWS.includes(row.name));
      assert.deepEqual(unexpected, [], 'the driver reported a passing row the suite does not know about');
      for (const row of evidence.checks) {
        assert.equal(row.ok, true, `row ${row.name} failed: ${row.error}`);
      }
      assert.deepEqual(evidence.deferred, [...DEFERRED_ROWS], 'the deferred-row list changed without the suite following');

      const observations = evidence.observations;
      assert.equal(observations.startup.shellCount, 1, 'the process did not start with exactly one project window');
      assert.equal(observations.duplicateOpen.status, 'FOCUSED', 'the duplicate open did not join the open window');
      assert.equal(observations.volume.shellCount, 5);
      assert.equal(observations.volume.tabCount, 20, 'the process did not present twenty tabs across five projects');
      assert.equal(observations.volume.inventoryRows, 20, 'the cross-window search did not list every visible tab');
      assert.equal(observations.teardown.shellCount, 0, 'the run left browser shells behind');
      // The raster is claimed only where the windows could be shown side by side; the run says
      // which of the two it did, and a stacked run must not claim pixels it never took.
      if (observations.backgroundSurface.mode === 'tiled') {
        assert.ok(observations.backgroundCapture, 'a tiled run must produce the background capture');
        assert.ok(observations.backgroundCapture.bytes > 0, 'the background capture produced no pixels');
        assert.ok(observations.backgroundCapture.rasterSize.width > 0);
      } else {
        assert.equal(observations.backgroundSurface.mode, 'stacked');
        assert.equal(observations.backgroundCapture, null, 'an untiled run must not claim a background capture');
      }
      assert.equal(observations.staleActivation.closedTab.reasonCode, 'TAB_CLOSED');
      assert.equal(observations.close.shellCount, 4, 'closing one window did not leave four siblings');
      assert.ok(
        observations.survivorPaths.acceleratorTab !== observations.survivorPaths.toolbarTab,
        'the accelerator path did not act on the surviving window',
      );

      // The second-window contract rows carry their own recorded evidence: a popup's
      // affiliation, a minimized window's target, and the same-project session boundary.
      const popup = observations.nativePopup;
      assert.ok(popup, 'the popup row recorded no affiliation evidence');
      assert.equal(popup.capsuleId, popup.parentCapsuleId, 'the popup did not record its parent capsule');
      assert.equal(popup.capsuleId, popup.windowCapsule, 'the popup did not record the capsule of its own window');
      assert.ok(popup.partition.startsWith('persist:'), `the popup did not run in a durable partition: ${popup.partition}`);
      assert.equal(popup.userAgentMode, popup.parentUserAgentMode, 'the popup did not inherit its parent user agent mode');

      const target = observations.minimizeRestore;
      assert.ok(target, 'the minimize/restore row recorded no window-state evidence');
      assert.equal(target.foreignTarget.adopted, null, 'a refused foreign target recorded an adopted tab');
      assert.equal(target.minimized.alphaTarget, target.restored.alphaTarget, 'minimize/restore moved the window target');

      const sessions = observations.sameProjectSessions;
      assert.ok(sessions, 'the session row recorded no boundary evidence');
      assert.equal(sessions.crossRefused, true, 'the same-project session boundary was not recorded as refused');
      assert.ok(sessions.crossText.includes('TARGET_MISMATCH'), 'the recorded refusal did not name the mismatch');
      assert.notEqual(sessions.tabOne, sessions.tabTwo, 'the session row compared a tab with itself');
      // Ownership, not a count: the row reads its own tab while it is in the background and
      // again once the window presents it, and the contract is that neither read before the
      // sibling read touched the sibling's tab.
      assert.ok(sessions.domReadsBeforeSibling.length > 0, 'the session row recorded no read of its own tab');
      assert.deepEqual(
        sessions.domReadsBeforeSibling.filter((tabId: string) => tabId !== sessions.tabOne),
        [],
        'a read escaped the session that owned it',
      );
      assert.ok(sessions.domReads.includes(sessions.tabTwo), 'session two never reached its own tab');
    } finally {
      fs.rmSync(driverDir, { recursive: true, force: true });
    }
  });
});
