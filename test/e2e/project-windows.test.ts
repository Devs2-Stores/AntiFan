/**
 * Live E2E: the singleton web hub and its sibling shells, certified through the shipping app.
 *
 * The individual smokes each prove one surface-level behaviour (split review, background
 * multitasking, profile persistence, terminal survival). This suite is the one that boots the
 * real Electron process and watches what a user sees under Phương án A: one 'web' hub shell
 * holds every project's tabs, opening a project joins that hub and switches which project it
 * is showing, tabs minted while a project is active keep that project's stamp, per-tab state
 * (active tab, split layout) survives project switches, a native `window.open` popup inherits
 * its parent tab's affiliation, a window-wide search presents a tab without moving execution
 * authority, a `kind:'project'` ensure resolves to the hub instead of minting a window, and
 * closing the Terminal Manager sibling leaves the hub, its tabs and its chrome paths alone.
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
 *     - one 'web' hub shell at boot, carrying the boot project as its active project
 *     - a second project open joins the same hub (FOCUSED, no new shell, active project
 *       switches), a re-open of the same project refocuses without creating a window,
 *       and an unknown project is refused without touching the hub
 *     - tabs minted under an active project keep that project's stamp across later
 *       project switches, and the hub's single active tab moves independently of them
 *     - per-tab split layout survives rotating the hub between projects
 *     - a native `window.open` popup inherits its own tab's verified capsule and
 *       partition, never a global active capsule
 *     - minimize/restore keeps the hub's automation target and an invalid target clears
 *       instead of silently adopting
 *     - two agent sessions in the SAME project cannot cross-invoke each other's tabs
 *     - a background hub's page stays laid out and capturable while the Terminal
 *       Manager is focused, and capturing never takes the foreground
 *     - the tab search inventory spans every project stamp on the hub, exact
 *       activation presents a tab without rotating the automation target, stale
 *       results refuse with no fallback
 *     - five projects / twenty stamped tabs, all routed through the one hub host,
 *       listed identically from both live shells
 *     - `ensureProjectWindow({kind:'project'}, 'agent')` resolves to the web hub with
 *       zero presentation calls and activates the project it names
 *     - closing the Terminal Manager sibling preserves the hub, its tabs and its
 *       layout; the surviving hub's toolbar and application-menu accelerator still work
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
  'window.startup-single-web-shell',
  'window.second-project-joins-web-hub',
  'window.duplicate-open-refocuses-hub',
  'window.unknown-project-refused',
  'window.tabs-stamped-per-project-active-tab-independent',
  'window.split-layout-per-tab-across-projects',
  'window.native-popup-inherits-tab-affiliation',
  'window.minimize-restore-keeps-hub-target',
  'window.same-project-sessions-cannot-cross-invoke',
  'window.background-hub-surface-and-capture-ready',
  'window.search-lists-every-stamped-tab',
  'window.search-activates-tab-without-authority-rotation',
  'window.search-stale-refusal-no-fallback',
  'window.five-projects-twenty-stamped-tabs',
  'window.agent-project-ensure-resolves-to-hub-unpresented',
  'window.close-keeps-hub-and-tabs',
  'window.survivor-toolbar-and-accelerator-after-sibling-close',
  'window.detached-project-shell-lifecycle',
  'window.detached-project-exclusivity',
  'window.detached-project-reattach',
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
// Evidence destination: every run rewrites one JSON receipt, so it MUST NOT silently
// target another plan's curated record. Callers pick a plan-owned path via
// ANTIFAN_E2E_EVIDENCE (absolute or repo-relative); the default writes to a
// gitignored scratch dir and is for run-verification only.
const EVIDENCE_PATH = process.env.ANTIFAN_E2E_EVIDENCE
  ? process.env.ANTIFAN_E2E_EVIDENCE
  : path.join('.probe-tmp', 'project-windows-e2e.json');

interface DriverCheckRow {
  name: string;
  ok: boolean;
  status?: string;
  error?: string;
  cleanupError?: string;
  timedOut?: boolean;
}

/** The observation fields the suite asserts on, declared here so the assertions stay typed. */
interface DriverObservations {
  startup: { ownerKey: string; windowId: number; title: string; activeProject: string | null; shellCount: number };
  secondOpen: { status: string; projectId?: string };
  duplicateOpen: { status: string };
  volume: { shellCount: number; stampedCount: number; inventoryRows: number };
  teardown: { shellCount: number };
  backgroundSurface: { mode: string; workArea: { width: number; height: number } };
  backgroundCapture: { bytes: number; rasterSize: { width: number; height: number } } | null;
  staleActivation: { closedTab: { reasonCode: string } };
  close: { shellCount: number };
  survivorPaths: { toolbarTab: string; acceleratorTab: string };
  agentResolve: {
    entry: { ownerKey: string; windowId: number };
    activeAfter: string | null;
    restoredActive: string | null;
    callsForHub: unknown[];
    callsForOtherWindows: unknown[];
  };
  nativePopup?: {
    capsuleId: string;
    parentCapsuleId: string;
    projectId: string;
    partition: string;
    userAgentMode: string;
    parentUserAgentMode: string;
  };
  minimizeRestore?: {
    minimized: { hubTarget: string | null };
    restored: { hubTarget: string | null };
    invalidTarget: { requested: string; adopted: string | null };
  };
  sameProjectSessions?: {
    tabOne: string;
    tabTwo: string;
    ownReadFailed: string | null;
    crossRefused: boolean;
    crossText: string;
    crossWriteRefused: boolean;
    crossWriteText: string;
    domReadsBeforeSibling: string[];
    domReads: string[];
    siblingReadFailed: string | null;
  };
  webPresentation?: { nativeTitle: string; recordTitle: string; chip: string | null };
  detach?: {
    status: string;
    ownerKey: string;
    shellCount: number;
    movedTabs: number;
    hubTabs: number;
    hubActiveProject: string | null;
  };
  detachExclusivity?: {
    openStatus: string;
    shellCount: number;
    ensureRefusal: string;
    hubActiveProject: string | null;
  };
  reattach?: {
    status: string;
    shellCount: number;
    liveTabs: number;
    foldedTabIds: string[];
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
const EXPECTED_ROWS = [
  'window.startup-single-web-shell',
  'window.second-project-joins-web-hub',
  'window.duplicate-open-refocuses-hub',
  'window.unknown-project-refused',
  'window.tabs-stamped-per-project-active-tab-independent',
  'window.split-layout-per-tab-across-projects',
  'window.native-popup-inherits-tab-affiliation',
  'window.minimize-restore-keeps-hub-target',
  'window.same-project-sessions-cannot-cross-invoke',
  'window.background-hub-surface-and-capture-ready',
  'window.search-lists-every-stamped-tab',
  'window.search-activates-tab-without-authority-rotation',
  'window.search-stale-refusal-no-fallback',
  'window.five-projects-twenty-stamped-tabs',
  'window.agent-project-ensure-resolves-to-hub-unpresented',
  'window.close-keeps-hub-and-tabs',
  'window.survivor-toolbar-and-accelerator-after-sibling-close',
  'window.detached-project-shell-lifecycle',
  'window.detached-project-exclusivity',
  'window.detached-project-reattach',
  'window.cleanup-closes-every-shell',
];
// The minimum any browser shell accepts, as src/main/index.ts creates it. Two of them side by
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
// No capsule describes this id: the owner a 'project'-shaped ensure is asked for, resolved to
// the hub rather than minting a window.
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
const ROW_TIMEOUT_MS = Number(process.env.ANTIFAN_TEST_ROW_TIMEOUT_MS || 90000);
let laneStopped = false;
let frozenObservations = null;

async function check(name, fn, cleanup) {
  if (laneStopped) {
    checks.push({
      name: name,
      ok: false,
      status: 'BLOCKED',
      error: 'cascade: lane stopped after an earlier row timed out',
    });
    console.log('  BLOCKED  ' + name + ' (cascade: lane stopped after timeout)');
    return;
  }
  let timedOut = false;
  const rowTimeout = Promise.withResolvers();
  const rowTimer = setTimeout(function () {
    timedOut = true;
    rowTimeout.reject(new Error('the row did not finish within ' + ROW_TIMEOUT_MS + 'ms'));
  }, ROW_TIMEOUT_MS);
  let rowEntry = { name: name, ok: true };
  try {
    await Promise.race([fn(), rowTimeout.promise]);
    console.log('  PASS  ' + name);
  } catch (err) {
    rowEntry.ok = false;
    rowEntry.error = messageOf(err);
    if (timedOut) {
      rowEntry.status = 'FAIL';
      rowEntry.timedOut = true;
      laneStopped = true;
      try {
        frozenObservations = structuredClone(observations);
      } catch {
        frozenObservations = JSON.parse(JSON.stringify(observations));
      }
    }
    console.log('  FAIL  ' + name + ': ' + messageOf(err));
  } finally {
    clearTimeout(rowTimer);
    // A row that fails must still leave the scenario as it found it. An aborted row used to
    // hand every later row its own leftovers (an extra open and still-active tab), which
    // turned one honest failure into a cascade of unrelated ones — the receipt then blames
    // rows that were never the cause. Cleanup failure is recorded in the row.
    if (cleanup) {
      try {
        await cleanup();
      } catch (err) {
        rowEntry.ok = false;
        rowEntry.cleanupError = messageOf(err);
        rowEntry.error = rowEntry.error
          ? (rowEntry.error + '; cleanup failed: ' + messageOf(err))
          : ('cleanup failed: ' + messageOf(err));
        console.log('  FAIL  ' + name + ' [cleanup]: ' + messageOf(err));
      }
    }
    checks.push(rowEntry);
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
const hubHost = function () { return authority.hostForOwner('web'); };
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

/**
 * Open one project the way its own opening surface does. Under the hub contract there is no
 * per-project window to wait for: the open has landed when the single 'web' shell is presented
 * AND its host reports the project as active — the two states a user-facing open must both
 * reach, and the join the directory can honestly report.
 */
async function openProjectFromSidebar(sidebarSurface, project) {
  const result = await sidebarSurface.executeJavaScript(
    'window.antifanStandalone.openProject(' + JSON.stringify(project.projectId) + ')',
    true,
  );
  const entry = await waitFor(
    function () {
      const current = authority.snapshot().find(function (candidate) { return candidate.ownerKey === 'web'; });
      if (!current || current.visible !== true) return false;
      const host = hubHost();
      return host && host.activeProject() === project.projectId ? current : false;
    },
    'the web hub to be presented under ' + project.name,
  );
  return { result: result, entry: entry };
}

async function run() {
  authority = mainProcess.projectWindowAuthority;
  await app.whenReady();

  // ------------------------------------------------------- (1) the startup web hub shell
  const startup = await waitFor(
    function () {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the startup web shell',
  );
  const webKey = startup.ownerKey;
  observations.startup = {
    ownerKey: webKey,
    windowId: startup.windowId,
    title: startup.title,
    activeProject: null,
    shellCount: authority.browserShellCount(),
  };

  let toolbarHub = null;
  let sidebarHub = null;

  await check('window.startup-single-web-shell', async function () {
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount());
    expect(startup.ownerKey === 'web', 'the startup owner key was ' + String(startup.ownerKey));
    expect(startup.owner.kind === 'web', 'the startup owner kind was ' + String(startup.owner.kind));
    // The hub retitles its OS title bar to the project it presents (setActiveProject calls
    // shell.retitle; row 11's title === EPSILON.name contract). With a boot project
    // seeded, 'Window Alpha' IS the correct first-paint title; 'AntiFan Browser' is the
    // no-project fallback. Pinning the fallback here is stale implementation wording.
    expect(startup.title === 'AntiFan Browser' || startup.title === ALPHA.name, 'the startup title was ' + String(startup.title));
    // The boot project is the hub's active project from its first paint, and its verified
    // workspace is what the hub's terminals belong to while it is active.
    const host = hubHost();
    expect(host, 'the web hub has no host');
    await waitFor(
      function () { return host.activeProject() === ALPHA.projectId ? true : false; },
      'the hub to activate the boot project',
    );
    observations.startup.activeProject = host.activeProject();
    expect(startup.identity && startup.identity.owner && startup.identity.owner.kind === 'web', 'the startup identity owner was ' + JSON.stringify(startup.identity && startup.identity.owner));
    const window = authority.windowFor(webKey);
    expect(window && !window.isDestroyed(), 'the startup window has no live native window');
    const shell = authority.shellFor(webKey);
    expect(shell, 'the web hub has no shell');
    toolbarHub = surfaceOf(shell, 'toolbar');
    sidebarHub = surfaceOf(shell, 'sidebar');
    expect(toolbarHub, 'the web hub has no toolbar surface');
    expect(sidebarHub, 'the web hub has no sidebar surface');
    await waitForApi(toolbarHub, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
    await waitForApi(sidebarHub, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");
    // The hub's native title and painted chrome name the multi-project surface, never one
    // project's name — the ambiguity rule a project window used to enforce is the hub's
    // constant identity now.
    const chip = await toolbarHub.executeJavaScript('document.getElementById("projectChipTitle")?.textContent || null', true);
    observations.webPresentation = {
      nativeTitle: authority.windowFor(webKey).getTitle(),
      recordTitle: startup.title,
      chip: chip,
    };
    // Post-activation the OS title is deterministic: setActiveProject retitles the shell
    // synchronously (native-tab-host setActiveProject → shell.retitle) and the activeProject
    // waitFor above only completes after that call — the no-project fallback arm would be
    // dead code masking a retitle regression, so this pin is single-valued.
    expect(authority.windowFor(webKey).getTitle() === ALPHA.name, 'the hub native title was ' + JSON.stringify(authority.windowFor(webKey).getTitle()));
  });

  // ------------------------------- (2) a second project open joins the hub, no new shell
  let secondOpenResult = null;

  await check('window.second-project-joins-web-hub', async function () {
    const opened = await openProjectFromSidebar(sidebarHub, BETA);
    secondOpenResult = opened.result;
    observations.secondOpen = opened.result;
    expect(secondOpenResult && secondOpenResult.status === 'FOCUSED', 'the second open returned ' + JSON.stringify(secondOpenResult));
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount());
    expect(opened.entry.windowId === startup.windowId, 'the second open presented a different window: ' + String(opened.entry.windowId));
    expect(opened.entry.hostOwnerKey === 'web', 'the hub host key was ' + String(opened.entry.hostOwnerKey));
    // The join is not cosmetic: the project the hub shows is BETA now, and the verified
    // workspace it hands its terminals moved with it.
    expect(hubHost().activeProject() === BETA.projectId, 'the hub active project stayed ' + String(hubHost().activeProject()));
    const reasserted = entryOf(authority.snapshot(), webKey);
    expect(reasserted && samePath(reasserted.identity.workspacePath, BETA.path), 'the hub workspace did not switch to BETA: ' + JSON.stringify(reasserted && reasserted.identity.workspacePath));
    const foreign = authority.snapshot().find(function (entry) {
      return entry.owner.kind === 'project' || entry.ownerKey === 'project:' + BETA.projectId;
    });
    expect(!foreign, 'a project shell appeared for BETA: ' + JSON.stringify(foreign && foreign.owner));
  });

  // ---------------------------- (3) re-opening the shown project refocuses, never creates
  await check('window.duplicate-open-refocuses-hub', async function () {
    // Back to ALPHA through the same path first: the open of the project the hub already
    // shows is the duplicate-open case.
    const alphaJoin = await openProjectFromSidebar(sidebarHub, ALPHA);
    expect(alphaJoin.result && alphaJoin.result.status === 'FOCUSED', 'the ALPHA switch returned ' + JSON.stringify(alphaJoin.result));
    const again = await sidebarHub.executeJavaScript(
      'window.antifanStandalone.openProject(' + JSON.stringify(ALPHA.projectId) + ')',
      true,
    );
    observations.duplicateOpen = again;
    expect(again && again.status === 'FOCUSED', 'the duplicate open returned ' + JSON.stringify(again));
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount() + ' after the duplicate open');
    const after = entryOf(authority.snapshot(), webKey);
    expect(after && after.windowId === startup.windowId, 'the hub changed identity across the duplicate open');
    expect(hubHost().activeProject() === ALPHA.projectId, 'the duplicate open moved the active project to ' + String(hubHost().activeProject()));
    const foreign = authority.snapshot().find(function (entry) { return entry.ownerKey !== 'web'; });
    expect(!foreign, 'a second shell appeared: ' + JSON.stringify(foreign && foreign.owner));
  });

  // ------------------------------------------------------------- (4) unknown project refused
  await check('window.unknown-project-refused', async function () {
    const refused = await sidebarHub.executeJavaScript(
      "window.antifanStandalone.openProject('project-00000000-0000-4000-8000-0000000000ff')",
      true,
    );
    observations.unknownProject = refused;
    expect(refused && refused.status === 'FAILED', 'an unknown project returned ' + JSON.stringify(refused));
    expect(refused.reason === 'UNKNOWN_PROJECT', 'an unknown project reported ' + String(refused.reason));
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount() + ' after a refused open');
    expect(hubHost().activeProject() === ALPHA.projectId, 'a refused open moved the active project to ' + String(hubHost().activeProject()));
  });

  // ------------------------ (5) mint-time project stamps and the hub's single active tab
  let tabA1 = null;
  let tabA2 = null;
  let tabB1 = null;
  let tabB2 = null;

  await check('window.tabs-stamped-per-project-active-tab-independent', async function () {
    // The hub is showing ALPHA after the rows above; its tabs mint under ALPHA. The tabs carry
    // a real page rather than about:blank. A blank tab is constructed without a load, so its
    // WebContents has no renderer document and the first evaluate against it waits out the
    // whole eval ceiling instead of answering - the shipping host states that boundary itself
    // when it materializes about:blank for agent tabs. Every later row here reads,
    // opens a popup from or captures these tabs, so they are given documents.
    expect(hubHost().activeProject() === ALPHA.projectId, 'the hub is not showing ALPHA: ' + String(hubHost().activeProject()));
    tabA1 = await toolbarHub.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    tabA2 = await toolbarHub.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    expect(typeof tabA1 === 'string' && tabA1.length > 0, 'the hub created no first ALPHA tab: ' + JSON.stringify(tabA1));
    expect(typeof tabA2 === 'string' && tabA2.length > 0, 'the hub created no second ALPHA tab: ' + JSON.stringify(tabA2));

    // Rotate the hub to BETA — the same user open the earlier rows used — and mint BETA's pair.
    const betaJoin = await openProjectFromSidebar(sidebarHub, BETA);
    expect(betaJoin.result && betaJoin.result.status === 'FOCUSED', 'the BETA switch returned ' + JSON.stringify(betaJoin.result));
    tabB1 = await toolbarHub.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    tabB2 = await toolbarHub.executeJavaScript("window.antifanToolbar.createTab('https://example.com/')", true);
    expect(typeof tabB1 === 'string' && tabB1.length > 0, 'the hub created no first BETA tab: ' + JSON.stringify(tabB1));
    expect(typeof tabB2 === 'string' && tabB2.length > 0, 'the hub created no second BETA tab: ' + JSON.stringify(tabB2));

    // The stamp is decided at mint time and never re-resolves: ALPHA's tabs still answer to
    // ALPHA while BETA is the project being shown.
    const alphaTabs = hubHost().tabsForProject(ALPHA.projectId);
    const betaTabs = hubHost().tabsForProject(BETA.projectId);
    observations.projectStamps = { alpha: alphaTabs, beta: betaTabs };
    expect(alphaTabs.indexOf(tabA1) !== -1 && alphaTabs.indexOf(tabA2) !== -1, 'ALPHA does not claim both its tabs: ' + JSON.stringify(alphaTabs));
    expect(betaTabs.indexOf(tabB1) !== -1 && betaTabs.indexOf(tabB2) !== -1, 'BETA does not claim both its tabs: ' + JSON.stringify(betaTabs));
    expect(alphaTabs.indexOf(tabB1) === -1 && alphaTabs.indexOf(tabB2) === -1, 'ALPHA claims BETA tabs: ' + JSON.stringify(alphaTabs));
    expect(betaTabs.indexOf(tabA1) === -1 && betaTabs.indexOf(tabA2) === -1, 'BETA claims ALPHA tabs: ' + JSON.stringify(betaTabs));
    const entry = entryOf(authority.snapshot(), webKey);
    for (const tabId of [tabA1, tabA2, tabB1, tabB2]) {
      expect(entry.tabIds.indexOf(tabId) !== -1, 'the hub does not list tab ' + tabId + ': ' + JSON.stringify(entry.tabIds));
      expect(authority.hostForTab(tabId) === hubHost(), 'tab ' + tabId + ' does not route to the hub host');
    }

    // One window, one active tab — and one presented project: on the hub, selecting a tab
    // stamped with another project *is* the scope switch (Main's foreign-project handoff runs
    // the same activateWebHubProject path a project pick would), so the stamp follows the tab.
    expect(await toolbarHub.executeJavaScript('window.antifanToolbar.switchTab(' + JSON.stringify(tabA1) + ')', true) === true, 'the hub refused to select ' + tabA1);
    const selected = entryOf(authority.snapshot(), webKey);
    observations.activeTab = { selected: selected.activeTabId, activeProject: hubHost().activeProject() };
    expect(selected.activeTabId === tabA1, 'the hub active tab was ' + selected.activeTabId + ', expected ' + tabA1);
    expect(hubHost().activeProject() === ALPHA.projectId, 'selecting an ALPHA-stamped tab left the active project at ' + String(hubHost().activeProject()));
    expect(await toolbarHub.executeJavaScript('window.antifanToolbar.switchTab(' + JSON.stringify(tabA2) + ')', true) === true, 'the hub refused its second selection');
    expect(entryOf(authority.snapshot(), webKey).activeTabId === tabA2, 'the hub active tab was not ' + tabA2);

    // Back to ALPHA for the rows that follow; the stamps and the selection survive the switch.
    const alphaJoin = await openProjectFromSidebar(sidebarHub, ALPHA);
    expect(alphaJoin.result && alphaJoin.result.status === 'FOCUSED', 'the ALPHA return returned ' + JSON.stringify(alphaJoin.result));
    expect(hubHost().tabsForProject(BETA.projectId).indexOf(tabB1) !== -1, 'BETA lost its tab stamp when the hub switched back');
    expect(entryOf(authority.snapshot(), webKey).activeTabId === tabA2, 'a project switch moved the hub active tab to ' + entryOf(authority.snapshot(), webKey).activeTabId);
  });

  // --------------------------------------------------- (6) split layout is per tab, per hub
  let splitGeometry = null;

  await check('window.split-layout-per-tab-across-projects', async function () {
    const host = hubHost();
    expect(host, 'the hub lost its tab host');

    expect(await toolbarHub.executeJavaScript('window.antifanToolbar.toggleSplitReview()', true) === true, 'the hub refused to enable split review');
    expect(await toolbarHub.executeJavaScript("window.antifanToolbar.setSplitPreset('mobile', 'ipad-mini')", true) === true, 'the hub refused its mobile preset');
    expect(await toolbarHub.executeJavaScript("window.antifanToolbar.setSplitPreset('desktop', 'laptop-macbook13')", true) === true, 'the hub refused its desktop preset');
    expect(await toolbarHub.executeJavaScript("window.antifanToolbar.setSplitFocusedPane('desktop')", true) === true, 'the hub refused its focused pane');

    const tabStateOf = function (tabId) {
      return host.getTabList().find(function (candidate) { return candidate.id === tabId; }) || null;
    };
    const alphaTab = await waitFor(
      function () {
        const tab = tabStateOf(tabA2);
        return tab && tab.splitMode === true ? tab : false;
      },
      "the ALPHA tab's split state",
    );
    // The same layout verbs on another project's tab: per-tab state, not per-window.
    expect(await toolbarHub.executeJavaScript('window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabB2) + ', true)', true) === true, 'the hub refused to split the BETA tab');
    expect(await toolbarHub.executeJavaScript("window.antifanToolbar.setSplitPreset('mobile', 'mobile-small', " + JSON.stringify(tabB2) + ')', true) === true, 'the hub refused the BETA mobile preset');
    expect(await toolbarHub.executeJavaScript("window.antifanToolbar.setSplitFocusedPane('mobile', " + JSON.stringify(tabB2) + ')', true) === true, 'the hub refused the BETA focused pane');
    const betaTab = await waitFor(
      function () {
        const tab = tabStateOf(tabB2);
        return tab && tab.splitMode === true ? tab : false;
      },
      "the BETA tab's split state",
    );
    observations.splitState = {
      alpha: { tabId: tabA2, mobile: alphaTab.splitMobilePresetId, desktop: alphaTab.splitDesktopPresetId, focused: alphaTab.splitFocusedPane },
      beta: { tabId: tabB2, mobile: betaTab.splitMobilePresetId, desktop: betaTab.splitDesktopPresetId, focused: betaTab.splitFocusedPane },
    };
    expect(alphaTab.splitMobilePresetId === 'ipad-mini', "the ALPHA tab's mobile preset was " + String(alphaTab.splitMobilePresetId));
    expect(alphaTab.splitDesktopPresetId === 'laptop-macbook13', "the ALPHA tab's desktop preset was " + String(alphaTab.splitDesktopPresetId));
    expect(alphaTab.splitFocusedPane === 'desktop', "the ALPHA tab's focused pane was " + String(alphaTab.splitFocusedPane));
    expect(betaTab.splitMobilePresetId === 'mobile-small', "the BETA tab's mobile preset was " + String(betaTab.splitMobilePresetId));
    expect(betaTab.splitFocusedPane === 'mobile', "the BETA tab's focused pane was " + String(betaTab.splitFocusedPane));
    // The tabs that were not split stay whole: the layout is per tab, not per project.
    expect(tabStateOf(tabA1).splitMode !== true, "the first ALPHA tab reports split mode");
    expect(tabStateOf(tabB1).splitMode !== true, "the first BETA tab reports split mode");

    const alphaMobile = host.getTabContentBounds(tabA2, 'mobile');
    const betaMobileBefore = host.getTabContentBounds(tabB2, 'mobile');
    expect(alphaMobile && alphaMobile.width > 0 && alphaMobile.height > 0, "the ALPHA tab's mobile pane has no geometry: " + JSON.stringify(alphaMobile));
    expect(betaMobileBefore && betaMobileBefore.width > 0, "the BETA tab's mobile pane has no geometry: " + JSON.stringify(betaMobileBefore));

    // A preset change on the BETA tab moves its own geometry; the ALPHA tab's does not.
    expect(await toolbarHub.executeJavaScript("window.antifanToolbar.setSplitPreset('mobile', 'ipad-mini', " + JSON.stringify(tabB2) + ')', true) === true, 'the hub refused the second BETA mobile preset');
    const betaMobileAfter = await waitFor(
      function () {
        const bounds = host.getTabContentBounds(tabB2, 'mobile');
        return bounds && bounds.width > 0 && bounds.width !== betaMobileBefore.width ? bounds : false;
      },
      "the BETA tab's mobile pane to follow its own new preset",
      8000,
    );
    const alphaMobileAfter = host.getTabContentBounds(tabA2, 'mobile');
    splitGeometry = {
      alphaMobile: alphaMobile.width,
      betaMobileBefore: betaMobileBefore.width,
      betaMobileAfter: betaMobileAfter.width,
      alphaMobileAfter: alphaMobileAfter && alphaMobileAfter.width,
    };
    observations.splitGeometry = splitGeometry;
    expect(alphaMobileAfter && alphaMobileAfter.width === alphaMobile.width, "the ALPHA tab's pane moved to " + JSON.stringify(alphaMobileAfter) + " when the BETA tab changed its preset");

    // Turning the ALPHA tab's split off leaves the BETA tab's split, its preset and its
    // geometry exactly where they were.
    expect(await toolbarHub.executeJavaScript('window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabA2) + ', false)', true) === false, 'the hub reported split mode still on after disabling it');
    const alphaTabAfter = tabStateOf(tabA2);
    const betaTabAfter = tabStateOf(tabB2);
    expect(alphaTabAfter.splitMode !== true, "the ALPHA tab is still in split mode");
    expect(betaTabAfter.splitMode === true, "disabling the ALPHA tab's split disturbed the BETA tab's split");
    expect(betaTabAfter.splitMobilePresetId === 'ipad-mini', "the BETA tab's preset changed to " + String(betaTabAfter.splitMobilePresetId));
    const betaMobileUnchanged = host.getTabContentBounds(tabB2, 'mobile');
    expect(betaMobileUnchanged && betaMobileUnchanged.width === betaMobileAfter.width, "the BETA tab's pane moved to " + JSON.stringify(betaMobileUnchanged) + " when the ALPHA tab left split mode");
  });

  // ------------------------- (7a) a native window.open popup belongs to its own tab
  let popupChildId = null;
  // Row state, not callback state: this row rotates the active capsule and its cleanup is a
  // sibling callback, so a declaration inside the row body is not in the cleanup's scope.
  let activeCapsuleBeforePopup = null;
  await check('window.native-popup-inherits-tab-affiliation', async function () {
    const host = hubHost();

    // Diagnostic, never an assertion, and run before this row's own popup so it records even
    // when that one fails: the same page call from the tab row 6 had just toggled in and out
    // of split review - the opener the earlier contract runs measured, where a popup tab
    // could fail to appear while the page's open call never settled. This bisects that: first
    // a handler of this scenario's own, whose only job is to record whether Chromium
    // dispatched the request out of this tab at all, then the product's own composition put
    // back and asked the same question, so the record says which side of the popup path
    // stopped. Bounded, and any tab either attempt creates is closed again.
    const splitOpenerContents = host.getTabWebContents(tabA2, 'desktop');
    if (splitOpenerContents && !splitOpenerContents.isDestroyed()) {
      const popupManager = require(compiledModule('browser/oauth-popup-manager.js')).OAuthPopupManager.getInstance();
      const hubWindow = authority.windowFor(webKey);
      const productWindowOpenHandler = function (details) {
        return popupManager.handleWindowOpen(splitOpenerContents, hubWindow, details, {
          onNewTabRequested: function (url) {
            const adoptedId = host.createTab(url, true);
            if (adoptedId) host.adoptChildTab(tabA2, adoptedId, undefined, 'native_window_open', tabA2);
          },
        });
      };
      const fireFromSplitOpener = async function (url, label) {
        const before = host.getTabList().map(function (tab) { return tab.id; });
        let settled = false;
        splitOpenerContents
          .executeJavaScript("String(window.open('" + url + "', '_blank'))", true)
          .then(function () { settled = true; })
          .catch(function () { settled = true; });
        let created = [];
        try {
          created = await waitFor(
            function () {
              const fresh = host.getTabList().filter(function (tab) { return before.indexOf(tab.id) === -1; });
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
            await toolbarHub.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(createdId) + ')', true);
            await waitFor(
              function () { return host.hasExactTab(createdId) === false; },
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
      host.switchTab(tabA2, { plane: 'user' });
      await waitFor(
        function () { return host.getActiveTabId() === tabA2; },
        'the hub to present the tab with split history',
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

    // The opener is the hub's first ALPHA tab - a tab that has never entered split review. The
    // requirement is about which affiliation a popup lands with, not about which tab asked,
    // and the tab row 6 toggled in and out of split review is exercised separately, as a
    // bounded diagnostic recorded above rather than as the opener this row is decided on.
    const parentTabId = tabA1;
    // The opener is presented first. A background tab's renderer does not run script in this
    // build - a bounded probe below measures exactly that - so opening the popup from an
    // unpresented tab would decide this row on the tab's rendering state instead of on what
    // the popup inherits.
    host.switchTab(parentTabId, { plane: 'user' });
    await waitFor(
      function () { return host.getActiveTabId() === parentTabId; },
      'the hub to present the tab the popup is opened from',
    );
    const parentTab = host.getTabList().find(function (candidate) { return candidate.id === parentTabId; });
    expect(parentTab, 'the hub lost its parent tab ' + parentTabId);
    const parentContents = host.getTabWebContents(parentTabId, 'desktop');
    expect(parentContents && !parentContents.isDestroyed(), 'the parent tab has no page to open a popup from');
    const tabsBefore = host.getTabList().map(function (tab) { return tab.id; });

    // Make this row discriminating, not just passing. ALPHA is also the process-wide active
    // capsule in this scenario, so a child that merely took "the active capsule" would satisfy
    // an inheritance equality without reading its parent at all. The active capsule is
    // therefore rotated to BETA's for the duration of the popup and restored in cleanup: a
    // child that consults global state lands in BETA's workspace and fails the assertions
    // below, while one that reads its own parent keeps ALPHA's capsule. The rotation is the
    // same manager-level switch the product performs when a workspace is reselected; it
    // changes no tab's verified affiliation, which is exactly the point.
    const capsuleManager = host.capsuleManager;
    activeCapsuleBeforePopup = capsuleManager && capsuleManager.getActive() ? capsuleManager.getActive().id : null;
    if (capsuleManager) capsuleManager.switchTo(BETA.capsuleId);
    expect(
      capsuleManager && capsuleManager.getActive() && capsuleManager.getActive().id === BETA.capsuleId,
      'the active capsule could not be rotated to ' + BETA.capsuleId + ' for this row',
    );

    // The page asks for a real popup. Chromium hands the request to this tab's window-open
    // handler, which is where the child's affiliation is decided — before its page exists.
    // The handler denies the native window on purpose and opens the popup as a tab of this
    // hub instead, which is why window.open answers null here instead of a WindowProxy.
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
    // by the tab it landed on and the capsule/partition it carries, which is this row's
    // requirement. The lineage, when the product has one, is recorded as an observation.
    const child = await waitFor(
      function () {
        for (const tab of host.getTabList()) {
          if (tabsBefore.indexOf(tab.id) !== -1) continue;
          if (tab.url !== popupUrl) continue;
          return { tab: tab, lineage: host.getTabLineage(tab.id) };
        }
        return false;
      },
      'the native popup to be adopted as a hub tab',
    );
    popupChildId = child.tab.id;
    observations.nativePopup = {
      childTabId: child.tab.id,
      lineage: child.lineage,
      capsuleId: child.tab.capsuleId,
      projectId: child.tab.projectId || null,
      partition: child.tab.partition,
      userAgentMode: child.tab.userAgentMode,
      parentCapsuleId: parentTab.capsuleId,
      parentPartition: parentTab.partition,
      parentUserAgentMode: parentTab.userAgentMode,
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
    expect(host.hasTab(child.tab.id), 'the popup tab is not owned by the hub');
    expect(authority.hostForTab(child.tab.id) === host, 'the popup tab does not route to the hub host');
    // Inheritance: the child carries its parent tab's own verified capsule — never the global
    // active capsule this row rotated, and never an unassigned jar.
    expect(
      child.tab.capsuleId === parentTab.capsuleId,
      'the popup capsule was ' + String(child.tab.capsuleId) + ' while its parent carried ' + String(parentTab.capsuleId),
    );
    expect(child.tab.capsuleId !== BETA.capsuleId, 'the popup inherited the globally active capsule ' + BETA.capsuleId + ' instead of its parent');
    // The stamp the hub wrote on its parent at mint time is the one affiliation a child on the
    // same hub must keep: a popup stamped with the hub's *current* project would follow global
    // state the same way an active-capsule read would.
    expect(
      child.tab.projectId === parentTab.projectId && child.tab.projectId === ALPHA.projectId,
      'the popup project stamp was ' + String(child.tab.projectId) + ' while its parent carried ' + String(parentTab.projectId),
    );
    expect(
      child.tab.partition === parentTab.partition,
      'the popup partition was ' + String(child.tab.partition) + ' while its parent ran in ' + String(parentTab.partition),
    );
    expect(
      typeof child.tab.partition === 'string' && child.tab.partition.indexOf('persist:') === 0,
      'the popup ran in an unassigned partition: ' + String(child.tab.partition),
    );
    expect(
      child.tab.userAgentMode === 'clean' || child.tab.userAgentMode === 'native',
      'the popup user agent mode was unassigned: ' + String(child.tab.userAgentMode),
    );
    expect(
      child.tab.userAgentMode === parentTab.userAgentMode,
      'the popup user agent mode was ' + String(child.tab.userAgentMode) + ' while its parent was ' + String(parentTab.userAgentMode),
    );

    // Leave the run as this row found it: the popup is opened and accounted for, then closed
    // through the hub's own toolbar, and the active tab the earlier rows established is
    // restored. The tab-count rows later in this scenario count four stamped tabs per
    // project.
    const closed = await toolbarHub.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(child.tab.id) + ')', true);
    expect(closed === true, 'the hub refused to close its own popup tab ' + child.tab.id);
    await waitFor(
      function () { return host.hasExactTab(child.tab.id) === false; },
      'the hub to drop the closed popup tab',
    );
    host.switchTab(tabA2, { plane: 'user' });
    expect(host.getActiveTabId() === tabA2, 'the hub did not return to its own active tab ' + tabA2);
    expect(host.getTabList().length === tabsBefore.length, 'the hub kept ' + host.getTabList().length + ' tabs instead of ' + tabsBefore.length);

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
    // Whatever happened above, the hub does not hand the next row a popup tab it opened
    // and left active: the rows after this one address the hub's own tab A2 and count its
    // tabs, and one aborted row must not turn into their failures.
    const host = hubHost();
    // The active capsule this row rotated to BETA's is put back before any later row reads
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
        await toolbarHub.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(popupChildId) + ')', true);
        await waitFor(
          function () { return host.hasExactTab(popupChildId) === false; },
          'the popup tab to be gone from the hub',
          5000,
        );
      } catch (err) {
        console.log('  NOTE  the popup tab could not be closed during cleanup: ' + messageOf(err));
      }
    }
    if (host && tabA2) host.switchTab(tabA2, { plane: 'user' });
  });

  // --------- (7b) minimize/restore keeps the hub's target and refuses an invalid one
  await check('window.minimize-restore-keeps-hub-target', async function () {
    const host = hubHost();
    const hubWindow = authority.windowFor(webKey);
    expect(hubWindow && !hubWindow.isDestroyed(), 'the hub has no native window');
    host.setAutomationTabId(tabA2);
    expect(host.getAutomationTabId() === tabA2, 'the hub refused its own tab ' + tabA2 + ' as its target');

    hubWindow.minimize();
    await waitFor(
      function () { return hubWindow.isMinimized() === true; },
      'the hub to minimize',
    );
    const minimized = {
      hubTarget: host.getAutomationTabId(),
    };
    expect(minimized.hubTarget === tabA2, 'minimizing the hub moved its target to ' + String(minimized.hubTarget));

    hubWindow.restore();
    await waitFor(
      function () { return hubWindow.isMinimized() === false && hubWindow.isVisible() === true; },
      'the hub to restore',
    );
    const restored = {
      hubTarget: host.getAutomationTabId(),
      visible: entryOf(authority.snapshot(), webKey).visible,
    };
    expect(restored.hubTarget === tabA2, 'restoring the hub rotated its target to ' + String(restored.hubTarget));

    // A tab this host does not own can never become the hub's target: the host clears rather
    // than adopting, so no silent authority rotation is possible.
    host.setAutomationTabId('tab-that-belongs-to-no-host');
    const afterInvalid = host.getAutomationTabId();
    observations.minimizeRestore = {
      minimized: minimized,
      restored: restored,
      invalidTarget: { requested: 'tab-that-belongs-to-no-host', adopted: afterInvalid },
    };
    expect(afterInvalid !== 'tab-that-belongs-to-no-host', 'the hub adopted a tab it does not own as its target');
    expect(afterInvalid === null, 'a refused target left ' + String(afterInvalid) + ' instead of clearing');
    host.setAutomationTabId(tabA2);
    expect(host.getAutomationTabId() === tabA2, 'the hub could not take its own tab back as target');
  });

  // ------- (7c) two sessions in one project share read scope but cannot cross-mutate
  await check('window.same-project-sessions-cannot-cross-invoke', async function () {
    const host = hubHost();
    const controlPlane = authority.controlPlane();
    expect(controlPlane, 'the process exposes no control plane');
    const tabOne = tabA1;
    const tabTwo = tabA2;
    expect(host.hasTab(tabOne) && host.hasTab(tabTwo), 'the hub lost a tab this row needs');

    // Both sessions belong to the SAME project and the SAME hub: the boundary under test is
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
    const serverOne = new AntiFanMcpServer(host, false, transport, {
      attachmentId: sessionOne.launch.attachmentId,
      attachmentSecret: sessionOne.launch.secret,
      authorityRevision: sessionOne.launch.authorityRevision,
    });
    const serverTwo = new AntiFanMcpServer(host, false, transport, {
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
      // The tabs these sessions are bound to are background tabs of their hub, so the first
      // read measures what a bound session gets with the page never presented. That state is
      // recorded, not asserted: this row's requirement is the session boundary, and a tab whose
      // page has never been laid out is a separate question. The reads that decide the row run
      // with the tab presented - the binding is to the tab, not to its rendering.
      const backgroundOwnRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabOne });
      host.switchTab(tabOne, { plane: 'user' });
      await waitFor(
        function () { return host.getActiveTabId() === tabOne; },
        'the hub to present the tab session one is bound to',
      );
      const ownRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabOne });
      // Reads share the project scope: a tab that measures into this attachment's own
      // project/workspace is observable across sessions without a rebind. The session
      // boundary now lives on mutations, not on observation.
      const crossRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabTwo });
      const crossWrite = await serverOne.callTool('anti.browser.navigate', { tabId: tabTwo, url: 'https://nav-refused.test/' });
      const readAfterCross = domReads.slice();
      host.switchTab(tabTwo, { plane: 'user' });
      await waitFor(
        function () { return host.getActiveTabId() === tabTwo; },
        'the hub to present the tab session two is bound to',
      );
      const siblingRead = await serverTwo.callTool('anti.inspect.dom', { tabId: tabTwo });
      observations.sameProjectSessions = {
        tabOne: tabOne,
        tabTwo: tabTwo,
        ownReadFailed: ownRead.isError === true ? textOf(ownRead) : null,
        crossRefused: crossRead.isError === true,
        crossText: textOf(crossRead),
        crossWriteRefused: crossWrite.isError === true,
        crossWriteText: textOf(crossWrite),
        domReadsBeforeSibling: readAfterCross,
        siblingReadFailed: siblingRead.isError === true ? textOf(siblingRead) : null,
        domReads: domReads.slice(),
      };
      expect(ownRead.isError !== true, 'session one could not read its own tab: ' + textOf(ownRead));
      expect(crossRead.isError !== true, 'session one could not read the same-project sibling tab: ' + textOf(crossRead));
      expect(readAfterCross.indexOf(tabTwo) !== -1, 'the same-project sibling read never reached its tab: ' + JSON.stringify(readAfterCross));
      expect(crossWrite.isError === true, 'session one navigated the sibling session tab: ' + textOf(crossWrite));
      expect(textOf(crossWrite).indexOf('TARGET_MISMATCH') !== -1, 'the write refusal did not name the mismatch: ' + textOf(crossWrite));
      expect(siblingRead.isError !== true, 'session two could not read its own tab: ' + textOf(siblingRead));
      expect(domReads.indexOf(tabTwo) !== -1, 'session two never reached its own tab: ' + JSON.stringify(domReads));
    } finally {
      NativeTabHost.prototype.getDom = originalGetDom;
      // This row is the only one that starts CLI sessions, and it ends them here: a live
      // interactive session keeps a streaming run and an attachment on its tab alive by
      // design, so two sessions left running would make the close rows later in this scenario
      // address a hub that is rightly busy - a refusal about work this scenario created,
      // not about the behaviour those rows measure.
      for (const release of [
        { label: 'session one', session: sessionOne },
        { label: 'session two', session: sessionTwo },
      ]) {
        try {
          await controlPlane.endCliSession(release.session.run.id, release.session.attempt.id, 'completed');
        } catch (err) {
          console.log('  NOTE  ' + release.label + ' could not be released: ' + messageOf(err));
        }
      }
    }
  });

  // ------- (8) a background hub's page is laid out and capturable while the manager is in front
  let managerEntry = null;
  await check('window.background-hub-surface-and-capture-ready', async function () {
    const host = hubHost();
    const hubWindow = authority.windowFor(webKey);
    expect(hubWindow && !hubWindow.isDestroyed(), 'the hub has no native window');

    // The foreground sibling is the Terminal Manager, opened through the same menu entry the
    // user clicks — the second surface this contract keeps alive beside the hub.
    expect(entryOf(authority.snapshot(), 'unassigned') === null, 'the manager window was already open before the row started');
    const managerMenuItem = findMenuItem(Menu.getApplicationMenu(), 'Cửa sổ Terminal chung (Shared Terminal Manager)');
    expect(managerMenuItem, 'the Terminal menu has no shared-manager entry');
    expect(managerMenuItem.enabled === true, 'the shared-manager entry is disabled');
    managerMenuItem.click(managerMenuItem, BrowserWindow.getAllWindows()[0], {});
    managerEntry = await waitFor(
      function () {
        const entry = entryOf(authority.snapshot(), 'unassigned');
        return entry && entry.visible === true ? entry : false;
      },
      'the manager window the menu opened to be presented',
    );
    expect(authority.browserShellCount() === 2, 'the manager open left ' + authority.browserShellCount() + ' shells');
    const managerWindow = authority.windowFor('unassigned');
    expect(managerWindow && !managerWindow.isDestroyed(), 'the manager window has no native window');

    // The subject is the hub, not the occlusion: the two windows are placed side by side so
    // neither covers the other (a covered window is a different, legitimate case where the
    // compositor may stop rasterizing). Where this display cannot hold both, the run records
    // that instead of measuring an overlapped window and calling the result a rendering verdict.
    const workArea = screen.getPrimaryDisplay().workArea;
    const tiled = workArea.width >= 2 * SHELL_MIN_WIDTH + 16 && workArea.height >= SHELL_MIN_HEIGHT;
    if (tiled) {
      const halfWidth = Math.floor(workArea.width / 2);
      const height = Math.min(workArea.height, 900);
      hubWindow.setBounds({ x: workArea.x, y: workArea.y, width: halfWidth, height: height });
      managerWindow.setBounds({ x: workArea.x + halfWidth, y: workArea.y, width: halfWidth, height: height });
    }
    if (managerWindow.isMinimized()) managerWindow.restore();
    managerWindow.show();
    managerWindow.focus();
    // The hub was presented by its own user opens (see openProjectFromSidebar), so this row
    // re-presents it without focusing rather than assuming which window the earlier rows left
    // in front.
    if (hubWindow.isMinimized()) hubWindow.restore();
    hubWindow.showInactive();
    const hubEntryUnfocused = await waitFor(
      function () {
        const entry = entryOf(authority.snapshot(), webKey);
        return entry && entry.focused === false && hubWindow.isVisible() === true ? entry : false;
      },
      'the hub to be presented in the background without taking the foreground',
    );

    const surface = await host.readRenderSurface(tabB2, 'desktop');
    observations.backgroundSurface = {
      mode: tiled ? 'tiled' : 'stacked',
      workArea: { width: workArea.width, height: workArea.height },
      surface: surface,
      activeTabId: hubEntryUnfocused.activeTabId,
      visible: hubEntryUnfocused.visible,
      focused: hubEntryUnfocused.focused,
      presented: hubWindow.isVisible(),
      managerPresented: managerWindow.isVisible(),
    };
    // Independent of tiling: the page in the background window still has a real layout viewport.
    expect(surface && surface.vw > 0 && surface.vh > 0, "the hub's page has no laid-out viewport: " + JSON.stringify(surface));

    if (!tiled) {
      observations.backgroundCapture = null;
      console.log('  NOTE  windows were not tiled (work area ' + workArea.width + 'x' + workArea.height + '): a raster of an overlapped window is deferred to a display that can hold both, and no pixels are claimed here');
      return;
    }
    // document.hidden flips a frame after showInactive() — the visibility transition reaches
    // the renderer asynchronously — so the row waits for the page to see itself presented rather
    // than sampling the frame that still precedes the transition. Some display layers never
    // deliver the occlusion notification at all; the wait is bounded and the report is
    // recorded, so the capture below — the pixel-level claim this row actually owns — still
    // runs instead of the row deciding itself on a renderer notification Chromium may skip.
    const presentedSurface = surface.hidden === false
      ? surface
      : await waitFor(
          async function () {
            const candidate = await host.readRenderSurface(tabB2, 'desktop');
            return candidate && candidate.hidden === false ? candidate : false;
          },
          "the hub's page to stop reporting itself hidden",
          8000,
        ).catch(function (err) {
          console.log('  NOTE  the page still reports itself hidden after ' + (8000 / 1000) + 's: ' + messageOf(err) + ' — the capture decides the row');
          return null;
        });
    observations.backgroundSurface = { ...observations.backgroundSurface, presentedSurface: presentedSurface };
    // Capturing a background window must not take the foreground from the window the user is
    // in: the capture path attaches the tab's own view for the raster, and evidence says so.
    const hubFocusedBeforeCapture = hubWindow.isFocused();
    const capture = await host.captureVerificationScreenshot(undefined, tabB2, 'desktop');
    const hubFocusedAfterCapture = hubWindow.isFocused();
    const managerFocusedAfterCapture = managerWindow.isFocused();
    observations.backgroundCapture = capture
      ? {
          backend: capture.backend,
          rasterSize: capture.rasterSize,
          bytes: typeof capture.data === 'string' ? capture.data.length : 0,
          hubFocused: { before: hubFocusedBeforeCapture, after: hubFocusedAfterCapture },
          managerFocusedAfterCapture: managerFocusedAfterCapture,
        }
      : null;
    expect(capture && typeof capture.data === 'string' && capture.data.length > 0, 'the background capture returned no pixels');
    expect(capture.rasterSize && capture.rasterSize.width > 0 && capture.rasterSize.height > 0, 'the background capture has no raster size: ' + JSON.stringify(capture.rasterSize));
    expect(
      hubFocusedBeforeCapture === false && hubFocusedAfterCapture === false,
      "capturing the hub's background tab moved the foreground to the hub: before " + String(hubFocusedBeforeCapture) + ', after ' + String(hubFocusedAfterCapture),
    );
  });

  // --------------------------- (9) the search inventory spans every project stamp
  await check('window.search-lists-every-stamped-tab', async function () {
    const inventory = await toolbarHub.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    observations.inventory = inventory;
    expect(inventory && inventory.status === 'OK', 'the search returned ' + JSON.stringify(inventory));
    const rows = inventory.rows || [];
    const byId = {};
    for (const row of rows) byId[row.tabId] = row;
    for (const tabId of [tabA1, tabA2, tabB1, tabB2]) {
      expect(byId[tabId], 'tab ' + tabId + ' is missing from the inventory: ' + JSON.stringify(rows.map(function (row) { return row.tabId; })));
    }
    // One presenting window means one honest label: ownerLabel is the window's stable
    // product name ('AntiFan Browser'), not the rotating project title the hub's identity
    // field carries — every row names the same shell no matter which project it shows.
    for (const tabId of [tabA1, tabB1]) {
      expect(byId[tabId].ownerLabel === 'AntiFan Browser', 'the tab ' + tabId + ' label was ' + String(byId[tabId].ownerLabel) + ', the hub calls itself AntiFan Browser');
    }

    // Listing has no side effects: the manager window's toolbar sees the same inventory —
    // the search contract is process-wide by design and must not depend on which window asks.
    const managerToolbar = surfaceOf(authority.shellFor('unassigned'), 'toolbar');
    expect(managerToolbar, 'the manager window has no toolbar surface');
    await waitForApi(managerToolbar, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.searchProjectTabs === 'function'");
    const fromManager = await managerToolbar.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(fromManager && fromManager.status === 'OK', 'the search from the manager returned ' + JSON.stringify(fromManager));
    const keyOf = function (result) {
      return JSON.stringify((result.rows || []).map(function (row) { return [row.tabId, row.ownerLabel, row.live]; }));
    };
    expect(keyOf(fromManager) === keyOf(inventory), 'two shells listed different inventories');
  });

  // ----------------- (10) activation presents the tab and moves no execution authority
  await check('window.search-activates-tab-without-authority-rotation', async function () {
    const host = hubHost();
    // An agent's automation target is the execution authority for the hub. It is set here
    // through the same host seam attachment binding uses, so the user activation below is
    // measured against real authority rather than against an empty field.
    host.setAutomationTabId(tabA2);
    const hubWindow = authority.windowFor(webKey);
    const hubFocusedBefore = hubWindow.isFocused();

    const before = entryOf(authority.snapshot(), webKey);
    const activation = await toolbarHub.executeJavaScript('window.antifanToolbar.activateProjectTab(' + JSON.stringify(tabB1) + ')', true);
    const after = await waitFor(
      function () {
        const entry = entryOf(authority.snapshot(), webKey);
        return entry && entry.activeTabId === tabB1 ? entry : false;
      },
      'the hub to present the tab the search asked for',
    );
    observations.activation = {
      result: activation,
      activeBefore: before.activeTabId,
      activeAfter: after.activeTabId,
      hubFocusedBefore: hubFocusedBefore,
      hubFocusedAfter: authority.windowFor(webKey).isFocused(),
      hubAutomation: host.getAutomationTabId(),
    };
    expect(activation && activation.status === 'ACTIVATED', 'the activation returned ' + JSON.stringify(activation));
    expect(activation.tabId === tabB1, 'the activation named tab ' + String(activation.tabId));
    expect(after.activeTabId === tabB1, 'the hub active tab was ' + after.activeTabId + ', expected ' + tabB1);
    // A user activation presents the tab's own window: the hub the result belongs to comes
    // forward, and the manager the last row left in front does not take that over.
    expect(authority.windowFor('unassigned').isFocused() === false, 'the manager kept the foreground over a hub activation');
    expect(host.getAutomationTabId() === tabA2, "the hub's automation target moved to " + String(host.getAutomationTabId()));
    // Presenting a BETA-stamped tab *is* the scope switch on a single hub: authority stays
    // un-rotated (automation target above), while the presented project follows the pane.
    expect(host.activeProject() === BETA.projectId, 'presenting a BETA-stamped tab left the active project at ' + String(host.activeProject()));
  });

  // ------------------------------------------------------------- (11) stale results refuse
  await check('window.search-stale-refusal-no-fallback', async function () {
    const host = hubHost();
    const before = entryOf(authority.snapshot(), webKey);

    const never = await toolbarHub.executeJavaScript("window.antifanToolbar.activateProjectTab('tab-that-never-existed')", true);
    expect(never && never.status === 'UNAVAILABLE', 'a never-existing tab returned ' + JSON.stringify(never));
    expect(never.reasonCode === 'TAB_CLOSED', 'a never-existing tab reported ' + String(never.reasonCode));
    expect(never.tabId === 'tab-that-never-existed', 'a refused activation named tab ' + String(never.tabId));

    // A real tab that has since closed: the exact case a rendered search result goes stale in.
    expect(await toolbarHub.executeJavaScript('window.antifanToolbar.closeTab(' + JSON.stringify(tabB2) + ')', true) === true, 'the hub refused to close its own tab ' + tabB2);
    await waitFor(
      function () { return host.hasExactTab(tabB2) === false; },
      'the hub to drop the closed tab',
    );
    const stale = await toolbarHub.executeJavaScript('window.antifanToolbar.activateProjectTab(' + JSON.stringify(tabB2) + ')', true);
    const after = entryOf(authority.snapshot(), webKey);
    observations.staleActivation = { never: never, closedTab: stale };
    expect(stale && stale.status === 'UNAVAILABLE', 'a closed tab returned ' + JSON.stringify(stale));
    expect(stale.reasonCode === 'TAB_CLOSED', 'a closed tab reported ' + String(stale.reasonCode));
    expect(stale.tabId === tabB2, 'the refusal named tab ' + String(stale.tabId));
    expect(after.activeTabId === before.activeTabId, 'a refused activation moved the active tab: ' + before.activeTabId + ' -> ' + after.activeTabId);
    expect(after.activeTabId === tabB1, 'the hub fell back to another tab: ' + after.activeTabId);
  });

  // ------------------------------------- (12) five projects, twenty stamped tabs, one hub
  await check('window.five-projects-twenty-stamped-tabs', async function () {
    for (const project of [GAMMA, DELTA, EPSILON]) {
      const opened = await openProjectFromSidebar(sidebarHub, project);
      expect(opened.result && opened.result.status === 'FOCUSED', 'opening ' + project.name + ' returned ' + JSON.stringify(opened.result));
      expect(hubHost().activeProject() === project.projectId, 'the hub did not switch to ' + project.name);
    }
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount() + ' for five projects and one manager');

    // Four stamped tabs per project, minted through the hub's own toolbar while it shows that
    // project. Top-up rather than a blind four: the boot tab may already carry ALPHA's stamp.
    for (const project of PROJECTS) {
      await openProjectFromSidebar(sidebarHub, project);
      for (let index = hubHost().tabsForProject(project.projectId).length; index < 4; index += 1) {
        const created = await toolbarHub.executeJavaScript("window.antifanToolbar.createTab('about:blank')", true);
        expect(typeof created === 'string' && created.length > 0, project.name + ' created no tab at index ' + index);
      }
    }

    // The hub's own toolbar channel is what its renderer paints the strip from. Asking it is
    // a different path than the directory's snapshot: the title bar shows the hub's tabs under
    // the hub's own multi-project identity.
    const state = await waitFor(
      async function () {
        const value = await toolbarHub.executeJavaScript('window.antifanToolbar.getInitialState()', true);
        return value && Array.isArray(value.tabs) && value.tabs.length === 20 ? value : false;
      },
      'the hub to paint twenty tabs in its own strip',
    );
    expect(state.projectWindow && state.projectWindow.owner && state.projectWindow.owner.kind === 'web', 'the hub painted identity ' + JSON.stringify(state.projectWindow && state.projectWindow.owner));
    // The hub's identity title tracks the project it currently presents — the mint loop ends
    // on EPSILON, which is the scope this strip was just painted under.
    expect(state.projectWindow.title === EPSILON.name, 'the hub painted title ' + JSON.stringify(state.projectWindow.title));
    const strip = { tabIds: state.tabs.map(function (tab) { return tab.id; }).sort(), activeTabId: state.activeTabId };

    const snapshot = authority.snapshot();
    const hubEntry = entryOf(snapshot, webKey);
    const host = hubHost();
    expect(
      strip.tabIds.join('|') === hubEntry.tabIds.slice().sort().join('|'),
      'the strip the hub painted and the directory disagree: ' + JSON.stringify(strip.tabIds) + ' vs ' + JSON.stringify(hubEntry.tabIds),
    );
    expect(strip.activeTabId === hubEntry.activeTabId, 'the hub painted active tab ' + String(strip.activeTabId) + ' while the directory said ' + String(hubEntry.activeTabId));

    const stamped = [];
    for (const project of PROJECTS) {
      const ids = host.tabsForProject(project.projectId);
      expect(ids.length === 4, project.name + ' holds ' + ids.length + ' stamped tabs, expected 4');
      for (const tabId of ids) {
        expect(stamped.indexOf(tabId) === -1, 'tab ' + tabId + ' is stamped for two projects');
        stamped.push(tabId);
      }
    }
    expect(stamped.length === 20, 'the hub holds ' + stamped.length + ' project-stamped tabs, expected 20');

    // The routing answer is per host: every stamped tab resolves to the hub that presents it.
    for (const tabId of stamped) {
      expect(authority.hostForTab(tabId) === host, 'tab ' + tabId + ' did not resolve to the hub host');
    }

    // One search sees all twenty, each row labelled with the window that shows it.
    const inventory = await toolbarHub.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(inventory && inventory.status === 'OK', 'the five-project search returned ' + JSON.stringify(inventory));
    const rows = inventory.rows || [];
    const ownerByTab = {};
    for (const row of rows) ownerByTab[row.tabId] = row;
    for (const tabId of stamped) {
      const row = ownerByTab[tabId];
      expect(row, 'tab ' + tabId + ' is missing from the five-project inventory');
      expect(row.ownerLabel === 'AntiFan Browser', 'tab ' + tabId + ' was labelled ' + String(row.ownerLabel) + ', expected the hub label AntiFan Browser');
      expect(row.live === true, 'tab ' + tabId + ' was listed as not live');
    }
    const managerToolbar = surfaceOf(authority.shellFor('unassigned'), 'toolbar');
    const fromManager = await managerToolbar.executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(fromManager && fromManager.status === 'OK', 'the search from the manager returned ' + JSON.stringify(fromManager));
    expect(JSON.stringify((fromManager.rows || []).map(function (row) { return row.tabId; }).sort()) === JSON.stringify(rows.map(function (row) { return row.tabId; }).sort()), 'two shells listed different five-project inventories');

    observations.volume = { shellCount: authority.browserShellCount(), stampedCount: stamped.length, inventoryRows: rows.length };
  });

  // ------------- (13) a 'project' ensure resolves to the hub and never presents anything
  await check('window.agent-project-ensure-resolves-to-hub-unpresented', async function () {
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

    let resolvedEntry = null;
    try {
      const before = authority.snapshot();
      resolvedEntry = await authority.ensureProjectWindow({ kind: 'project', projectId: UNRECORDED.projectId }, 'agent');
      // A presentation that arrives late is still a presentation, so the observation stays open
      // for a bounded window instead of a single instant: the editor's own creation path is
      // asynchronous, and reading the call list once would race it.
      for (let round = 0; round < 4; round += 1) {
        await sleep(100);
        expect(
          presentationCalls.filter(function (call) { return call.windowId === resolvedEntry.windowId; }).length === 0,
          'the resolved hub window was presented: ' + JSON.stringify(presentationCalls.filter(function (call) { return call.windowId === resolvedEntry.windowId; })),
        );
      }
      const after = authority.snapshot();
      observations.agentResolve = {
        entry: { ownerKey: resolvedEntry.ownerKey, windowId: resolvedEntry.windowId },
        activeAfter: hubHost().activeProject(),
        restoredActive: null,
        callsForHub: presentationCalls.filter(function (call) { return call.windowId === resolvedEntry.windowId; }),
        callsForOtherWindows: presentationCalls.filter(function (call) { return call.windowId !== resolvedEntry.windowId; }),
      };
      // The retired owner resolves to the one web hub — the same window the user already has —
      // never to a new shell and never to a presentation.
      expect(resolvedEntry.ownerKey === 'web', "the 'project' ensure resolved to " + String(resolvedEntry.ownerKey));
      expect(resolvedEntry.windowId === startup.windowId, "the 'project' ensure minted window " + String(resolvedEntry.windowId) + ' instead of the hub ' + String(startup.windowId));
      expect(presentationCalls.filter(function (call) { return call.windowId === resolvedEntry.windowId; }).length === 0, 'the resolved window was presented: ' + JSON.stringify(observations.agentResolve.callsForHub));
      expect(presentationCalls.filter(function (call) { return call.windowId !== resolvedEntry.windowId; }).length === 0, 'the ensure presented other windows: ' + JSON.stringify(observations.agentResolve.callsForOtherWindows));
      expect(authority.browserShellCount() === 2, 'the ensure left ' + authority.browserShellCount() + ' shells');
      const window = authority.windowFor(resolvedEntry.ownerKey);
      expect(window && !window.isDestroyed(), 'the resolved shell has no native window');
      // The project the retired owner named is what the hub switched to: the ensure is a join
      // plus an activation, which is the whole of the new contract for that call shape.
      expect(hubHost().activeProject() === UNRECORDED.projectId, 'the hub did not adopt the ensured project: ' + String(hubHost().activeProject()));
      for (const entry of after) {
        if (entry.ownerKey === resolvedEntry.ownerKey) continue;
        const previous = before.find(function (candidate) { return candidate.ownerKey === entry.ownerKey; });
        if (!previous) continue;
        expect(entry.visible === previous.visible, 'shell ' + entry.ownerKey + ' visibility changed while the ensure resolved');
        expect(entry.focused === previous.focused, 'shell ' + entry.ownerKey + ' focus changed while the ensure resolved');
      }
    } finally {
      for (const [method, original] of patched) {
        BrowserWindow.prototype[method] = original;
      }
    }

    // The ensure switched the hub to a project id no record describes; leave the run under the
    // project the next rows measure, through the same code path.
    await authority.ensureProjectWindow({ kind: 'project', projectId: ALPHA.projectId }, 'agent');
    observations.agentResolve.restoredActive = hubHost().activeProject();
    expect(hubHost().activeProject() === ALPHA.projectId, 'the hub did not switch back to ALPHA: ' + String(hubHost().activeProject()));
  });

  // ----------------------------------------- (14) closing the manager sibling keeps the hub
  let managerWindowBeforeClose = null;
  let hubTabsBeforeClose = null;
  let hubActiveBeforeClose = null;

  await check('window.close-keeps-hub-and-tabs', async function () {
    const before = authority.snapshot();
    const hubBefore = entryOf(before, webKey);
    hubTabsBeforeClose = hubBefore.tabIds.slice();
    hubActiveBeforeClose = hubBefore.activeTabId;
    managerWindowBeforeClose = authority.windowFor('unassigned');
    expect(managerWindowBeforeClose && !managerWindowBeforeClose.isDestroyed(), 'the manager window has no native window');
    // Nothing is bound to the manager's pages here, so this is the idle close the spec describes.
    const managerHost = authority.hostForOwner('unassigned');
    if (managerHost) managerHost.setAutomationTabId(undefined);

    expect(authority.requestClose('unassigned') === true, 'the close request never reached the manager window');
    await waitFor(
      function () { return authority.browserShellCount() === 1; },
      'the manager window to close',
    );
    // The shell count dropping is the close; the directory unregistering the manager's host is
    // the settle that this row judges, so wait for that state rather than a duration.
    await waitFor(
      function () { return authority.hostForOwner('unassigned') === null; },
      "the closed window's host to stop resolving",
    );
    const after = authority.snapshot();
    observations.close = { accepted: true, shellCount: authority.browserShellCount(), remaining: after.map(function (entry) { return entry.ownerKey; }) };
    expect(!entryOf(after, 'unassigned'), 'the closed manager is still in the directory');
    expect(managerWindowBeforeClose.isDestroyed() === true, "the closed window's native window survived");

    const hubAfter = entryOf(after, webKey);
    expect(hubAfter, 'the hub disappeared with the manager');
    expect(JSON.stringify(hubAfter.tabIds) === JSON.stringify(hubTabsBeforeClose), 'hub tabs changed from ' + JSON.stringify(hubTabsBeforeClose) + ' to ' + JSON.stringify(hubAfter.tabIds));
    expect(hubAfter.activeTabId === hubActiveBeforeClose, 'the hub changed its active tab when the manager closed');
    expect(authority.windowFor(webKey) && !authority.windowFor(webKey).isDestroyed(), "the hub's native window was destroyed");

    // The closed window's authority is gone: its host is unregistered and its tabs would stop
    // resolving. The hub's authority is untouched.
    expect(authority.hostForOwner('unassigned') === null, 'the closed manager still has a host');
    expect(authority.hostForTab(hubTabsBeforeClose[0]) === hubHost(), "the hub's first tab no longer resolves to its host");
    for (const tabId of hubTabsBeforeClose) {
      expect(authority.hostForTab(tabId) === hubHost(), 'hub tab ' + tabId + ' did not resolve back to the hub');
    }
    expect(app.isReady() === true, 'the app is no longer ready after a window closed');
    expect(BrowserWindow.getAllWindows().some(function (window) { return window.id === authority.windowFor(webKey).id; }), "the hub's native window is gone");
  });

  // --------------------- (15) the surviving hub's toolbar and accelerator paths still work
  await check('window.survivor-toolbar-and-accelerator-after-sibling-close', async function () {
    const host = hubHost();
    const toolbar = surfaceOf(authority.shellFor(webKey), 'toolbar');
    expect(toolbar, 'the surviving hub has no toolbar surface');
    const toolbarTab = await toolbar.executeJavaScript("window.antifanToolbar.createTab('about:blank')", true);
    expect(typeof toolbarTab === 'string' && toolbarTab.length > 0, 'the surviving toolbar created no tab: ' + JSON.stringify(toolbarTab));
    await waitFor(
      function () { return host.getActiveTabId() === toolbarTab; },
      "the surviving hub's toolbar tab to become active",
    );

    // The application menu's New Tab carries the keyboard accelerator; invoking its handler with
    // this window is the command that accelerator dispatches, resolved per window by the directory.
    const menu = Menu.getApplicationMenu();
    const newTabItem = findMenuItem(menu, 'New Tab');
    expect(newTabItem && typeof newTabItem.click === 'function', 'the application menu has no invokable New Tab item');
    expect(String(newTabItem.accelerator || '') === 'CmdOrCtrl+T', 'the New Tab accelerator was ' + String(newTabItem.accelerator));
    const hubWindow = authority.windowFor(webKey);
    expect(hubWindow && !hubWindow.isDestroyed(), 'the surviving hub has no native window');
    const beforeAccelerator = host.getTabList().map(function (tab) { return tab.id; });
    newTabItem.click(newTabItem, hubWindow, {});
    await waitFor(
      function () { return host.getTabList().length === beforeAccelerator.length + 1; },
      "the accelerator's command to create a tab",
    );
    const afterAccelerator = host.getTabList().map(function (tab) { return tab.id; });
    const createdByAccelerator = afterAccelerator.filter(function (tabId) { return beforeAccelerator.indexOf(tabId) === -1; });
    expect(createdByAccelerator.length === 1, "the accelerator's command created " + createdByAccelerator.length + ' tabs: ' + JSON.stringify(createdByAccelerator));
    observations.survivorPaths = {
      toolbarTab: toolbarTab,
      acceleratorTab: createdByAccelerator[0],
      acceleratorActive: host.getActiveTabId(),
      windowCount: authority.browserShellCount(),
    };
    expect(createdByAccelerator[0] !== toolbarTab, 'the accelerator reused the tab the toolbar had just created');
    expect(host.getActiveTabId() === createdByAccelerator[0], "the accelerator's tab did not become active in the window it resolved");

    // A window no shell describes refuses the command instead of acting on another window. Both
    // handler paths are synchronous, so a tab created for either would already be in the
    // directory: the bounded re-read is what makes the absence an observation, not one sample.
    const totalBefore = allTabIds().length;
    expect(managerWindowBeforeClose.isDestroyed() === true, 'the closed window unexpectedly survived for the refusal case');
    newTabItem.click(newTabItem, managerWindowBeforeClose, {});
    newTabItem.click(newTabItem, null, {});
    for (let round = 0; round < 3; round += 1) {
      await sleep(100);
      expect(allTabIds().length === totalBefore, 'a menu command for a window no shell describes created a tab somewhere else');
    }
  });

  // ------- (16) detach the hub-presented project into its own live shell -------
  // The detached mode is what plans/261001-0902-detached-project-webhub-windows ships:
  // a 'project:<id>' owner with its own window, its own host and its own tab record —
  // while the singleton hub keeps presenting every other project. The assertions read
  // the same authority/directory/host seams the menu and IPC rows above use.
  let detachedKeyGamma = null;
  let detachedTabIdsGamma = null;

  await check('window.detached-project-shell-lifecycle', async function () {
    // Present GAMMA on the hub and hand it a stamped tab: the detach transfer below
    // must carry exactly those rows and nothing else.
    await openProjectFromSidebar(sidebarHub, GAMMA);
    const host = hubHost();
    const toolbar = surfaceOf(authority.shellFor(webKey), 'toolbar');
    expect(toolbar, 'the hub has no toolbar surface for the detach row');
    const stampedTab = await toolbar.executeJavaScript("window.antifanToolbar.createTab('https://example.com/detach-transfer')", true);
    expect(typeof stampedTab === 'string' && stampedTab.length > 0, 'no GAMMA-stamped tab was minted: ' + JSON.stringify(stampedTab));
    await waitFor(
      function () { return host.tabsForProject(GAMMA.projectId).indexOf(stampedTab) >= 0; },
      "the minted tab to carry GAMMA's project stamp",
    );
    // The transfer serializes persisted-shape rows; ingest drops ephemeral
    // (agent-plane) tabs by design — the detachable set is the user-plane subset.
    const stampedBefore = host.tabsForProject(GAMMA.projectId).filter(function (id) {
      return !(host.isTabEphemeral && host.isTabEphemeral(id));
    });
    expect(stampedBefore.indexOf(stampedTab) >= 0, "the minted tab is not in GAMMA's stamp set");
    const hubTabCountBefore = host.getTabList().length;
    // Journal the serialized envelope BEFORE the call — after detach the hub's map
    // is already emptied and the number would only ever read zero.
    observations.detachTransfer = {
      serializedTabs: host.serializeProjectTabsForTransfer(GAMMA.projectId).tabs.length,
      stampedBefore: stampedBefore.length,
    };

    // The one entrypoint the menu drives — the probe is asserting the same result the
    // renderer answer reports, so a refusal is a real FAIL, never a fake pass.
    const detached = await authority.detachProject(GAMMA.projectId);
    detachedKeyGamma = 'project:' + GAMMA.projectId;
    const detachedEntry = await waitFor(
      function () { return entryOf(authority.snapshot(), detachedKeyGamma); },
      'the detached project shell to register in the directory',
    );
    const detachedHost = authority.hostForOwner(detachedKeyGamma);

    expect(detached && detached.status === 'DETACHED', 'detachProject returned ' + JSON.stringify(detached));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount());
    expect(detachedEntry.owner.kind === 'project' && detachedEntry.owner.projectId === GAMMA.projectId, 'the detached owner was ' + JSON.stringify(detachedEntry.owner));
    expect(detachedEntry.identity && detachedEntry.identity.owner && detachedEntry.identity.owner.kind === 'project', 'the detached identity named no project: ' + JSON.stringify(detachedEntry.identity));
    expect(detachedHost && detachedHost !== host, 'the detached shell shares the hub host');

    // Every transferable GAMMA-stamped tab moved with the project; the hub kept the rest.
    // The serialized envelope was journaled above the call; the catch records what
    // actually landed if the wait times out.
    await waitFor(
      function () {
        const n = detachedHost.tabsForProject(GAMMA.projectId).length;
        return n === stampedBefore.length ? true : n;
      },
      "the stamped tabs to land on the detached host",
      30000,
    ).catch(function (err) {
      observations.detachTransfer.landed = detachedHost.tabsForProject(GAMMA.projectId).length;
      observations.detachTransfer.detachedTabList = detachedHost.getTabList().map(function (t) { return { id: t.id, projectId: t.projectId }; });
      throw err;
    });
    detachedTabIdsGamma = detachedHost.tabsForProject(GAMMA.projectId).slice();
    expect(host.tabsForProject(GAMMA.projectId).length === 0, 'the hub kept GAMMA tabs: ' + JSON.stringify(host.tabsForProject(GAMMA.projectId)));
    // The wire list drops agent-plane rows, so the fold's true delta is the stamped
    // count — the serialized envelope itself is the ledger: serialized == stamped ==
    // landed, and the hub's stamp set is empty.
    expect(observations.detachTransfer.serializedTabs === stampedBefore.length, 'serialize offered ' + observations.detachTransfer.serializedTabs + ' of ' + stampedBefore.length + ' stamped tabs');
    expect(host.activeProject() !== GAMMA.projectId, 'the hub still presents GAMMA: ' + String(host.activeProject()));

    // Chrome is live: the detached window answers its own toolbar and sidebar APIs.
    const detachedToolbar = surfaceOf(authority.shellFor(detachedKeyGamma), 'toolbar');
    const detachedSidebar = surfaceOf(authority.shellFor(detachedKeyGamma), 'sidebar');
    await waitForApi(detachedToolbar, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
    await waitForApi(detachedSidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");
    expect(detachedEntry.visible === true, 'the detached shell was never presented');
    detachedTabIdsGamma = detachedHost.tabsForProject(GAMMA.projectId).slice();

    observations.detach = {
      status: detached.status,
      ownerKey: detachedKeyGamma,
      shellCount: authority.browserShellCount(),
      movedTabs: detachedTabIdsGamma.length,
      hubTabs: host.getTabList().length,
      hubActiveProject: host.activeProject(),
    };
  });

  // ------- (17) exclusivity: a detached project is never presented by the hub -----
  await check('window.detached-project-exclusivity', async function () {
    const host = hubHost();
    const detachedHost = authority.hostForOwner(detachedKeyGamma);
    expect(detachedHost, 'the detached host vanished before the exclusivity row');
    const shellCount = authority.browserShellCount();

    // The user-facing open lands on the detached shell — FOCUSED, never a hub flip
    // and never a second window. The shared helper waits for the HUB to present the
    // project, which exclusivity itself forbids — this row calls the open channel
    // directly and asserts the result instead.
    const openResult = await sidebarHub.executeJavaScript('window.antifanStandalone.openProject(' + JSON.stringify(GAMMA.projectId) + ')', true);
    const openDetached = { result: openResult };
    expect(openDetached.result && openDetached.result.status === 'FOCUSED', 'opening a detached project returned ' + JSON.stringify(openDetached.result));
    expect(authority.browserShellCount() === shellCount, 'a phantom shell appeared: ' + authority.browserShellCount());
    expect(host.activeProject() !== GAMMA.projectId, 'the hub adopted a detached project: ' + String(host.activeProject()));
    const entryAfterOpen = entryOf(authority.snapshot(), detachedKeyGamma);
    expect(entryAfterOpen && entryAfterOpen.visible === true, 'the detached shell was not presented by the open');

    // The creation arm refuses too: an agent-side ensure naming the detached owner
    // is a typed conflict — the funnel never mints a second window and never puts
    // the project on the hub.
    let refused = null;
    try {
      await authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'agent');
    } catch (err) {
      refused = err;
    }
    expect(refused, 'the agent-side ensure accepted a detached project');
    expect(/TRANSACTION_CONFLICT|detached/i.test(String(refused && (refused.code || refused.message || refused))), 'the ensure refused with ' + messageOf(refused));
    expect(authority.browserShellCount() === shellCount, 'the refused ensure grew a shell: ' + authority.browserShellCount());

    // And the hub-side activation surface — the tab-click flip the picker would ride —
    // refuses the same way, through the one funnel every presentation takes.
    let hubFlipped = null;
    try {
      await authority.ensureProjectWindow({ kind: 'project', projectId: GAMMA.projectId }, 'user');
    } catch (err) {
      hubFlipped = err;
    }
    expect(hubFlipped, 'the user-side ensure accepted a detached project');
    expect(host.activeProject() !== GAMMA.projectId, 'the refused ensure still flipped the hub');

    observations.detachExclusivity = {
      openStatus: openDetached.result.status,
      shellCount: authority.browserShellCount(),
      ensureRefusal: String(refused && (refused.code || refused.message || refused)).slice(0, 160),
      hubActiveProject: host.activeProject(),
    };
  });

  // ------- (18) reattach: the fold returns every tab to the hub, marker cleared --
  await check('window.detached-project-reattach', async function () {
    const host = hubHost();
    const reattach = await authority.reattachProject(GAMMA.projectId);
    expect(reattach && reattach.status === 'REATTACHED', 'reattachProject returned ' + JSON.stringify(reattach));

    // The shell is gone, the hub holds the tabs live again, and the detached record
    // is folded into owners.web — the entrypoint's own post-fold re-read already
    // proved the landing before it answered REATTACHED.
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount());
    expect(!entryOf(authority.snapshot(), detachedKeyGamma), 'the detached shell survived the reattach');
    const expectedFolded = detachedTabIdsGamma || [];
    await waitFor(
      function () { return host.tabsForProject(GAMMA.projectId).length === expectedFolded.length; },
      'the folded tabs to land live on the hub',
      15000,
    );
    expect(expectedFolded.length > 0, 'the detach lifecycle recorded no folded tab ids');
    expect(authority.hostForOwner(detachedKeyGamma) === null, 'the folded owner still has a host');
    expect(app.isReady() === true, 'the app died with the reattached shell');

    observations.reattach = {
      status: reattach.status,
      shellCount: authority.browserShellCount(),
      liveTabs: host.tabsForProject(GAMMA.projectId).length,
      foldedTabIds: detachedTabIdsGamma,
    };
  });

  // ------------------------------------------------------------- (19) orderly owned teardown
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
    for (const expected of EXPECTED_ROWS) {
      if (!checks.some(function (c) { return c.name === expected; })) {
        checks.push({
          name: expected,
          ok: false,
          status: 'BLOCKED',
          error: 'cascade: lane stopped before row was reached',
        });
      }
    }
    const failed = checks.filter(function (entry) { return !entry.ok; });
    const result = {
      scenario: 'project-windows-lifecycle',
      passed: checks.filter(function (entry) { return entry.ok; }).length,
      failed: failed.length,
      checks: checks,
      observations: frozenObservations || observations,
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

describe('Live E2E: the web hub lifecycle', () => {
  it('certifies hub joins, per-project stamps, search, close and survivor paths in the real app', async () => {
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
    const evidencePath = path.resolve(rootDir, EVIDENCE_PATH);
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
      assert.equal(exit.code, 0, `the web-hub scenario must exit cleanly\n${transcript}`);
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
      assert.equal(observations.startup.shellCount, 1, 'the process did not start with exactly one browser shell');
      assert.equal(observations.startup.ownerKey, 'web', 'the startup shell is not the web hub');
      // The second project open joins the hub it already has: FOCUSED, never OPENED.
      assert.equal(observations.secondOpen.status, 'FOCUSED', 'the second project open did not join the web hub');
      assert.equal(observations.duplicateOpen.status, 'FOCUSED', 'the duplicate open did not refocus the hub');
      assert.equal(observations.volume.shellCount, 2, 'five projects produced more than the hub plus its manager sibling');
      assert.equal(observations.volume.stampedCount, 20, 'the hub did not stamp twenty tabs across five projects');
      // The search is window-wide: it returns every tab the hub presents, stamped or not —
      // `presentTabForActiveProject` mints a shared blank tab when a scope has no remembered
      // tab, so the honest bound is "at least all twenty stamped tabs", not an exact count.
      assert.ok(observations.volume.inventoryRows >= 20, 'the window-wide search did not list every stamped tab');
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
      assert.equal(observations.close.shellCount, 1, 'closing the manager did not leave the hub');
      assert.ok(
        observations.survivorPaths.acceleratorTab !== observations.survivorPaths.toolbarTab,
        'the accelerator path did not act on the surviving hub',
      );

      // The join rows carry their own recorded evidence: a popup's affiliation, a minimized
      // window's target, a 'project' ensure resolved to the hub, and the session boundary.
      const popup = observations.nativePopup;
      assert.ok(popup, 'the popup row recorded no affiliation evidence');
      assert.equal(popup.capsuleId, popup.parentCapsuleId, 'the popup did not record its parent capsule');
      assert.notEqual(popup.capsuleId, 'capsule-pw-b2', 'the popup took the globally rotated capsule instead of its parent');
      assert.ok(popup.partition.startsWith('persist:'), `the popup did not run in a durable partition: ${popup.partition}`);
      assert.ok(
        popup.userAgentMode === 'clean' || popup.userAgentMode === 'native',
        `the popup user agent mode was unassigned: ${popup.userAgentMode}`,
      );
      assert.equal(popup.userAgentMode, popup.parentUserAgentMode, 'the popup did not inherit its parent user agent mode');

      const target = observations.minimizeRestore;
      assert.ok(target, 'the minimize/restore row recorded no window-state evidence');
      assert.equal(target.invalidTarget.adopted, null, 'a refused target recorded an adopted tab');
      assert.equal(target.minimized.hubTarget, target.restored.hubTarget, 'minimize/restore moved the hub target');

      const agentResolve = observations.agentResolve;
      assert.ok(agentResolve, "the 'project' ensure row recorded no resolution evidence");
      assert.equal(agentResolve.entry.ownerKey, 'web', "the 'project' ensure did not resolve to the web hub");
      assert.equal(
        agentResolve.activeAfter,
        'project-00000000-0000-4000-8000-0000000000f6',
        'the hub did not adopt the ensured project',
      );
      assert.equal(agentResolve.restoredActive, observations.startup.activeProject, 'the hub was not restored to the boot project');
      assert.deepEqual(agentResolve.callsForHub, [], 'the resolved window was presented');
      assert.deepEqual(agentResolve.callsForOtherWindows, [], 'the ensure presented other windows');

      const sessions = observations.sameProjectSessions;
      assert.ok(sessions, 'the session row recorded no boundary evidence');
      assert.equal(sessions.crossRefused, false, 'the same-project sibling read was refused: ' + sessions.crossText);
      assert.equal(sessions.crossWriteRefused, true, 'the same-project write boundary was not recorded as refused');
      assert.ok(sessions.crossWriteText.includes('TARGET_MISMATCH'), 'the recorded write refusal did not name the mismatch');
      assert.notEqual(sessions.tabOne, sessions.tabTwo, 'the session row compared a tab with itself');
      // Read scope is the project: session one's sibling read reaches tabTwo, while a
      // mutation against a tab the session does not own is still refused outright.
      assert.ok(sessions.domReadsBeforeSibling.length > 0, 'the session row recorded no reads');
      assert.ok(
        sessions.domReadsBeforeSibling.indexOf(sessions.tabTwo) !== -1,
        'the recorded reads did not reach the same-project sibling tab',
      );
      assert.ok(sessions.domReads.includes(sessions.tabTwo), 'session two never reached its own tab');
      const detach = observations.detach;
      assert.ok(detach, 'the detach row recorded no lifecycle evidence');
      assert.equal(detach.status, 'DETACHED', 'the detach did not create a project shell');
      assert.equal(detach.ownerKey, 'project:project-00000000-0000-4000-8000-0000000000c3', 'the detached shell carries a non-GAMMA owner');
      assert.equal(detach.shellCount, 2, 'detach did not leave exactly hub + detached');
      assert.ok(detach.movedTabs > 0, 'the detach transferred no stamped tabs');
      assert.notEqual(detach.hubActiveProject, 'project-00000000-0000-4000-8000-0000000000c3', 'the hub kept presenting the detached project');

      const exclusivity = observations.detachExclusivity;
      assert.ok(exclusivity, 'the exclusivity row recorded no evidence');
      assert.equal(exclusivity.openStatus, 'FOCUSED', 'opening a detached project did not focus its shell');
      assert.equal(exclusivity.shellCount, 2, 'exclusivity let a phantom shell appear');
      assert.match(exclusivity.ensureRefusal, /TRANSACTION_CONFLICT|detached/i, 'the creation arm refused without a typed conflict');
      assert.notEqual(exclusivity.hubActiveProject, 'project-00000000-0000-4000-8000-0000000000c3', 'exclusivity let the hub adopt the detached project');

      const reattach = observations.reattach;
      assert.ok(reattach, 'the reattach row recorded no evidence');
      assert.equal(reattach.status, 'REATTACHED', 'the reattach did not fold the record');
      assert.equal(reattach.shellCount, 1, 'the reattach left shells behind');
      assert.equal(reattach.liveTabs, reattach.foldedTabIds.length, 'the hub did not ingest every folded tab');
    } finally {
      fs.rmSync(driverDir, { recursive: true, force: true });
    }
  });
});
