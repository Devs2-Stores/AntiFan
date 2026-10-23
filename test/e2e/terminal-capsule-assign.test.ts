/**
 * Live E2E: one terminal manager, many project windows — project assignment through the shipping app.
 *
 * Every project has its own window (owner key `project:<id>`) and that window's terminal list is
 * its own project's scope only; the shared Terminals window — the shell whose owner is
 * `unassigned` — is the one `managerAll` surface that lists every project's rows. The only thing
 * that keeps one project's shells out of another project's rows is the `project:<id>` owner key
 * stamped at mint time. This suite boots the real Electron process with a project window live,
 * opens a second project window and the shared manager, and then moves sessions between project
 * scopes through the same chrome IPC a user's tab context menu drives: one session minted by the
 * manager and handed to a project, one session minted by a project window and re-stamped to
 * another project through the shipped renderer's own context-menu flow, and one handed to a
 * project while no manager window exists to show the moved row — refused
 * (`TARGET_WINDOW_ABSENT`) first, then landed once the user's own menu entry recreates the
 * manager. A caller that names no window at all — a renderer no shell owns, or an MCP/attachment
 * caller — must stay refused, because the manager's superset view is a privilege of being a
 * window, not a process-wide default.
 *
 * How it runs: the scenario is a real Electron main-process script, generated into a throwaway
 * directory from `TERMINAL_CAPSULE_ASSIGN_DRIVER_SOURCE` below and launched through the
 * repository's own `scripts/run-electron.cjs`. The driver boots the shipping `src/main/index.ts`
 * inside the process (never a copy of it), drives each window's own chrome surfaces the way its
 * renderers do, and reports per-row results plus observations as JSON. Keeping the scenario
 * beside the assertions is what stops the two from drifting: a row that is not in
 * `EXPECTED_ROWS` fails the suite, and a row the driver stops reporting fails it too.
 *
 * Isolation: throwaway `ANTIFAN_DATA_ROOT`, `ANTIFAN_CONFIG_DIR`, `ANTIFAN_USER_DATA` and a
 * bridge port this test picks free before the launch, plus one real directory per project for
 * its capsule to point at. Every write this run performs happens inside those temp roots: the
 * driver's evidence file lives in a per-run evidence directory, and the developer's profile,
 * data root and capsules are never read or written.
 * Coverage split:
 *
 *   Automated here (a scripted harness observes them):
 *     - each project window lists the scope of its own project only; the shared manager lists
 *       the superset — per-project separation is carried by `project:<id>` owner stamps,
 *       asserted on the sessions themselves and on the rows every window lists
 *     - a session minted by the manager, assigned to a project through the real
 *       `TERMINAL_CHANNELS.ASSIGN_PROJECT` invoke, flips its ownerKey stamp, appears in the
 *       owning project's window and conjures no window of its own
 *     - a session minted by one project window is re-stamped to another project through the
 *       shipped renderer's own context-menu flow, keeping pid and cwd, and moves from the
 *       source window's list to the destination window's
 *     - assigning while NO Terminal Manager exists — and the sender is not the manager's own
 *       chrome — is refused (`TARGET_WINDOW_ABSENT`) and moves nothing; the same assign lands
 *       once the menu entry recreates the manager, and the destination's window, opened by the
 *       user afterwards, lists the moved row
 *     - a project known to the registry with no capsule is a valid destination: the assign
 *       clears the capsule stamp and its own window lists the row
 *     - a renderer no live shell owns, and an MCP attachment caller naming no window, are
 *       both refused instead of receiving the superset
 *     - every shell this run opened is closed again
 *
 *   Deferred, NOT faked here (see `DEFERRED_ROWS`):
 *     - the native tab-strip context menu's own click path: the menu is presented by the OS,
 *       which a headless run cannot drive; the row below invokes the same IPC that menu item
 *       invokes
 *     - the manager window's rendered rows (pixels), read here through the window's own preload
 *     - detached terminal-daemon survival of an assignment (the daemon is disabled in this
 *       isolated run; owned by the terminal smoke lane)
 *     - `agent:*` rows staying view-only in the manager (this lane mints no agent session)
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
  'terminal.project-windows-and-manager-hold-project-scopes',
  'terminal.manager-window-lists-every-project-scope',
  'terminal.manager-assigns-session-through-ipc',
  'terminal.assignment-moves-session-stamp',
  'terminal.assign-refuses-when-manager-window-absent',
  'terminal.window-less-chrome-caller-refused',
  'terminal.window-less-mcp-caller-refused',
  'terminal.cleanup-closes-every-shell',
];

/**
 * Rows this lane reports as unverified instead of simulating them. A rendered context menu
 * clicks that nobody clicked and a daemon that this isolated run deliberately disables are
 * claims about artifacts the process under test does not present here.
 */
const DEFERRED_ROWS: readonly string[] = [
  'native.tab-context-menu-click-path',
  'ui.manager-window-rendered-rows',
  'daemon.detached-assignment-survival',
  'agent.view-only-manager-rows',
];

const RUN_TIMEOUT_MS = 300_000;

interface DriverCheckRow {
  name: string;
  ok: boolean;
  status?: string;
  error?: string;
  cleanupError?: string;
}

/** The observation fields the suite asserts on, declared here so the assertions stay typed. */
interface DriverObservations {
  startup: { ownerKey: string; windowId: number; shellCount: number };
  projectScopes: { alphaOwnerKey: string; betaOwnerKey: string; alpha: string[]; beta: string[] };
  managerScope: { ownerKey: string; list: string[] };
  assignReply: { ok: boolean; sessionId?: string; capsuleId?: string; ownerKey?: string; reason?: string };
  moved: {
    sessionId: string;
    previousOwnerKey: string;
    ownerKeyAfter: string;
    targetListed: boolean;
    sourceDropped: boolean;
    managerListed: boolean;
  };
  closedTarget: {
    refusal: { ok: boolean; reason?: string };
    reopenResult: { ownerKey?: string; windowId?: number };
    assignReply: { ok: boolean; ownerKey?: string };
    targetListed: boolean;
    previousManagerWindowId: number;
    unmappedCandidate?: unknown;
  };
  refusals: {
    chrome: { refused: boolean; message: string } | null;
    chromeIdentity: { name: string; code: string; isUnknownSenderError: boolean } | null;
    mcpNoAttachment: { isError: boolean; code: string; text: string } | null;
    mcpNoTab: { isError: boolean; code: string; text: string } | null;
  };
  teardown: { shellCount: number };
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

/**
 * Kill the Electron child this suite spawned, and nothing else.
 *
 * Ownership is the `proc` handle: the PID is the child this test created with `spawn`, the
 * tree flag takes the helpers that child started, and no other process is ever matched by
 * name. A hung child is the only reason this runs — the watchdog below — and it is the same
 * teardown the repository's own multi-shell lane performs.
 */
function killOwnedChildTree(proc: ChildProcess): void {
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
const TERMINAL_CAPSULE_ASSIGN_DRIVER_SOURCE = `
'use strict';
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

app.commandLine.appendSwitch('no-sandbox');

const REPO_ROOT = process.env.ANTIFAN_DRIVER_REPO_ROOT || path.resolve(__dirname, '..');
const EVIDENCE_FILE = process.env.ANTIFAN_DRIVER_EVIDENCE || path.join(REPO_ROOT, 'terminal-capsule-assign-e2e.json');
const BRIDGE_PORT = process.env.ANTIFAN_DRIVER_BRIDGE_PORT || '';
const compiledRoot = process.env.ANTIFAN_COMPILED_ROOT
  ? path.resolve(process.env.ANTIFAN_COMPILED_ROOT)
  : path.join(REPO_ROOT, '.compiled');
const compiledMain = function (relative) {
  return path.join(compiledRoot, 'src', 'main', relative.split('/').join(path.sep));
};
const compiledUnder = function (group, relative) {
  return path.join(compiledRoot, 'src', group, relative.split('/').join(path.sep));
};

// Throwaway world: a temp data root (config, control plane, runtime), a temp Chromium profile,
// and one real directory per project for its capsule to point at. Nothing here can read or write
// the developer's data root, profile or capsules, and every shell this run mints is spawned with
// a working directory inside this tree.
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-'));
const makeProject = function (suffix, name) {
  const dir = path.join(tempRoot, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  return {
    projectId: 'project-00000000-0000-4000-8000-0000000000' + suffix,
    workspaceId: 'workspace-00000000-0000-4000-8000-0000000000' + suffix,
    capsuleId: 'capsule-tca-' + suffix,
    name: name,
    path: dir,
  };
};
const ALPHA = makeProject('a1', 'Capsule Alpha');
const BETA = makeProject('b2', 'Capsule Beta');
// Gamma's capsule exists from boot but its window is opened only by the row that needs it.
const GAMMA = makeProject('c3', 'Capsule Gamma');
// Delta is claimed by two capsules, so no single capsule can receive a terminal for it.
const DELTA = makeProject('d4', 'Capsule Delta');
const PROJECTS = [ALPHA, BETA, GAMMA, DELTA];

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
    }).concat(Array.from({ length: 226 }, function (_, index) {
      return { id: 'legacy-delta-' + index, name: DELTA.name, workspacePath: DELTA.path,
        state: {}, createdAt: 1, updatedAt: 1 };
    })).concat([{ id: 'legacy-delta-ambiguous', name: 'Ambiguous Delta', workspacePath: DELTA.path,
      state: {}, createdAt: 1, updatedAt: 1, projectId: DELTA.projectId, workspaceId: DELTA.workspaceId,
      migrationMarker: 'explicit' }]),
  }, null, 2),
  'utf8',
);

// The shipping main process, booted inside this same Electron instance: its boot guards run at
// import, so the throwaway environment above is already in place.
const mainProcess = require(compiledMain('index.js'));
// The classes the shipping composition wires: the router's own refusal identity, the manager
// that stamps every row, and the MCP surface a bridge caller reaches.
const { NativeTabHost } = require(compiledMain('browser/native-tab-host.js'));
const { TerminalManager } = require(compiledMain('browser/terminal-manager.js'));
const { dispatchChromeRoute, UnknownChromeSenderError } = require(compiledMain('browser/ipc-router.js'));
const { AntiFanMcpServer } = require(compiledMain('mcp/mcp-server.js'));
const CONTRACTS = require(compiledUnder('shared', 'contracts.js'));

const checks = [];
const observations = {};
const DEFERRED = [
  'native.tab-context-menu-click-path',
  'ui.manager-window-rendered-rows',
  'daemon.detached-assignment-survival',
  'agent.view-only-manager-rows',
];

const messageOf = function (err) { return err && err.message ? String(err.message) : String(err); };
const expect = function (condition, message) { if (!condition) throw new Error(message); };
// Poll interval only: every wait below waits for the state under test to exist (or to change),
// never for a guessed duration to elapse.
const sleep = require('node:timers/promises').setTimeout;

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
// driver runs inside the Electron main process, not under a test framework, so there is no clock
// to advance — and a row that never returns is exactly what this bound must report. A stalled
// row is one honest FAIL and the run continues, so a single hang cannot hide the rows that were
// fine.
const ROW_TIMEOUT_MS = 90000;

async function check(name, fn, cleanup) {
  const rowTimeout = Promise.withResolvers();
  const rowTimer = setTimeout(function () {
    rowTimeout.reject(new Error('the row did not finish within ' + ROW_TIMEOUT_MS + 'ms'));
  }, ROW_TIMEOUT_MS);
  let rowEntry = { name: name, ok: true };
  try {
    await Promise.race([fn(), rowTimeout.promise]);
    console.log('  PASS  ' + name);
  } catch (err) {
    rowEntry.ok = false;
    rowEntry.error = messageOf(err);
    console.log('  FAIL  ' + name + ': ' + messageOf(err));
  } finally {
    clearTimeout(rowTimer);
    // A row that fails must still leave the scenario as it found it, so one honest failure does
    // not hand every later row its own leftovers. Cleanup failure is recorded in the row.
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
let managerEntry = null;
let managerSidebar = null;
let alphaSidebar = null;
let betaSidebar = null;
let gammaSidebar = null;
let unmappedSidebar = null;
let betaWindowId = null;
let unknownCallerWindow = null;
let alphaSession = null;
let betaSession = null;
let managerSession = null;
let gammaSession = null;
let refusedSession = null;

const surfaceOf = function (shell, surface) {
  const view = surface === 'sidebar' ? shell && shell.sidebarView : shell && shell.toolbarView;
  return view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null;
};
const entryFor = function (ownerKeyValue) {
  return authority.snapshot().find(function (entry) { return entry.ownerKey === ownerKeyValue; }) || null;
};
const windowSidebar = function (project) { return surfaceOf(authority.shellFor(projectOwnerKey(project)), 'sidebar'); };
const projectOwnerKey = function (project) { return 'project:' + project.projectId; };
/**
 * The menu item the user clicks, found the way Electron finds one: by label in the menu this
 * process installed. No row may open a window through a path the user cannot, so the manager row
 * clicks this rather than calling the factory behind it.
 */
const applicationMenuItem = function (label) {
  const menu = Menu.getApplicationMenu();
  if (!menu) return null;
  for (const section of menu.items) {
    if (!section.submenu) continue;
    const found = section.submenu.items.find(function (item) { return item.label === label; });
    if (found) return found;
  }
  return null;
};
const ownerKeyOf = function (sessionId) { return TerminalManager.getInstance().sessionOwnerKey(sessionId); };
const capsuleOf = function (sessionId) { return TerminalManager.getInstance().sessionCapsuleId(sessionId); };

/** The window's own terminal list, through the real preload: the scope under test. */
const listOf = async function (surface) {
  const rows = await surface.executeJavaScript('window.antifanStandalone.listTerminals()', true);
  return Array.isArray(rows) ? rows : [];
};
const idsOf = function (rows) {
  return rows.map(function (row) { return String(row && row.id); }).sort();
};
const rowFor = function (rows, sessionId) {
  return rows.find(function (row) { return String(row && row.id) === String(sessionId); }) || null;
};
const waitForRowIn = async function (surface, sessionId, description) {
  await waitFor(
    async function () { return rowFor(await listOf(surface), sessionId) ? true : false; },
    description,
  );
};
const waitForRowOwner = async function (surface, sessionId, ownerKey, description) {
  await waitFor(
    async function () {
      const row = rowFor(await listOf(surface), sessionId);
      return row && String(row.ownerKey || '') === ownerKey ? true : false;
    },
    description,
  );
};
const waitForRowGone = async function (surface, sessionId, description) {
  await waitFor(
    async function () { return rowFor(await listOf(surface), sessionId) === null ? true : false; },
    description,
  );
};
const newTerminal = async function (surface, cwd) {
  return await surface.executeJavaScript('window.antifanStandalone.newTerminal(' + JSON.stringify(cwd) + ')', true);
};
const assignProject = async function (surface, sessionId, projectId) {
  return await surface.executeJavaScript(
    'window.antifanStandalone.assignTerminalProject(' + JSON.stringify(sessionId) + ', ' + JSON.stringify(projectId) + ')',
    true,
  );
};
const STANDALONE_API_READY = "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.listTerminals === 'function' && typeof window.antifanStandalone.assignTerminalProject === 'function'";
/**
 * Open one project the way its own opening surface does: from any window's sidebar. The open has
 * landed when the project's own window is presented and its sidebar answers the chrome API. A
 * project whose window is already live is joined, never duplicated.
 */
async function openProjectWindowAndWait(surface, project) {
  const result = await surface.executeJavaScript(
    'window.antifanStandalone.openProject(' + JSON.stringify(project.projectId) + ')',
    true,
  );
  const key = projectOwnerKey(project);
  const entry = await waitFor(
    function () { const current = entryFor(key); return current && current.visible === true ? current : false; },
    'the window of ' + project.name + ' to be presented',
  );
  const sidebar = await waitFor(
    function () { return windowSidebar(project) || false; },
    'the sidebar of ' + project.name,
  );
  await waitForApi(sidebar, STANDALONE_API_READY);
  return { result: result, entry: entry, sidebar: sidebar };
}

async function run() {
  authority = mainProcess.projectWindowAuthority;
  await app.whenReady();

  // ------------- (1) one window per project, scope carried by the project owner stamp
  const startup = await waitFor(
    function () {
      const snapshot = authority.snapshot();
      return snapshot.length === 1 ? snapshot[0] : false;
    },
    'the startup project window',
  );
  observations.startup = { ownerKey: startup.ownerKey, windowId: startup.windowId, shellCount: authority.browserShellCount() };

  await check('terminal.project-windows-and-manager-hold-project-scopes', async function () {
    // The environment names the project whose window opens first; no shared window stands in
    // for it and the Terminal Manager is not part of a project-led startup.
    expect(startup.ownerKey === projectOwnerKey(ALPHA), 'the startup owner key was ' + String(startup.ownerKey));
    expect(startup.owner.kind === 'project' && startup.owner.projectId === ALPHA.projectId, 'the startup owner was ' + JSON.stringify(startup.owner));
    expect(authority.hostForOwner(projectOwnerKey(ALPHA)), 'the ALPHA window has no host');
    alphaSidebar = windowSidebar(ALPHA);
    expect(alphaSidebar, 'the ALPHA window has no sidebar surface');
    await waitForApi(alphaSidebar, STANDALONE_API_READY);

    // Each session a project window mints is stamped with that window's own project.
    alphaSession = await newTerminal(alphaSidebar, ALPHA.path);
    expect(typeof alphaSession === 'string' && alphaSession.length > 0, 'the ALPHA window minted no session: ' + JSON.stringify(alphaSession));
    await waitForRowIn(alphaSidebar, alphaSession, 'the ALPHA window to list the session it minted');
    expect(ownerKeyOf(alphaSession) === projectOwnerKey(ALPHA), 'the ALPHA session owner was ' + String(ownerKeyOf(alphaSession)));

    // Opening another project creates that project's own window next to the first one.
    const betaOpen = await openProjectWindowAndWait(alphaSidebar, BETA);
    expect(betaOpen.result && betaOpen.result.status === 'OPENED', 'the BETA open returned ' + JSON.stringify(betaOpen.result));
    betaSidebar = betaOpen.sidebar;
    betaWindowId = betaOpen.entry.windowId;
    expect(betaWindowId !== startup.windowId, 'BETA reused the ALPHA window');
    expect(authority.browserShellCount() === 2, 'opening BETA left ' + authority.browserShellCount() + ' shells');
    const rejoin = await openProjectWindowAndWait(alphaSidebar, BETA);
    expect(rejoin.result && rejoin.result.status === 'FOCUSED', 'the second BETA open returned ' + JSON.stringify(rejoin.result));
    expect(authority.browserShellCount() === 2, 'joining BETA left ' + authority.browserShellCount() + ' shells');

    betaSession = await newTerminal(betaSidebar, BETA.path);
    expect(typeof betaSession === 'string' && betaSession.length > 0, 'the BETA window minted no session: ' + JSON.stringify(betaSession));
    expect(betaSession !== alphaSession, 'two windows minted the same session id');
    await waitForRowIn(betaSidebar, betaSession, 'the BETA window to list the session it minted');
    expect(ownerKeyOf(betaSession) === projectOwnerKey(BETA), 'the BETA session owner was ' + String(ownerKeyOf(betaSession)));

    // A window renders its own project only: the other project's row never appears in it.
    const alphaScope = idsOf(await listOf(alphaSidebar));
    const betaScope = idsOf(await listOf(betaSidebar));
    observations.projectScopes = {
      alphaOwnerKey: ownerKeyOf(alphaSession),
      betaOwnerKey: ownerKeyOf(betaSession),
      alpha: alphaScope,
      beta: betaScope,
    };
    expect(alphaScope.includes(String(alphaSession)), 'the ALPHA window never listed the session it minted: ' + JSON.stringify(alphaScope));
    expect(betaScope.includes(String(betaSession)), 'the BETA window never listed the session it minted: ' + JSON.stringify(betaScope));
    expect(alphaScope.includes(String(betaSession)) === false, 'the ALPHA window lists the BETA session: ' + JSON.stringify(alphaScope));
    expect(betaScope.includes(String(alphaSession)) === false, 'the BETA window lists the ALPHA session: ' + JSON.stringify(betaScope));
  });

  // ------------------------------------ (2) the shared manager window and its superset view
  await check('terminal.manager-window-lists-every-project-scope', async function () {
    expect(entryFor('unassigned') === null, 'the manager window was already open before the row started');
    // The user's own door: the Terminal menu entry this process installed at boot, clicked the way
    // the native menu clicks it. There is no chrome route that opens the Unassigned window, so if
    // this entry is missing, disabled or wired to nothing, the manager is unreachable — which is
    // exactly what this row must catch.
    const managerMenuItem = applicationMenuItem('Cửa sổ Terminal chung (Shared Terminal Manager)');
    expect(managerMenuItem, 'the Terminal menu has no shared-manager entry');
    expect(managerMenuItem.enabled === true, 'the shared-manager entry is disabled');
    managerMenuItem.click({}, BrowserWindow.getAllWindows()[0]);
    managerEntry = await waitFor(
      function () { return entryFor('unassigned'); },
      'the menu click to open the manager window',
    );
    expect(managerEntry.ownerKey === 'unassigned', 'the manager window owner key was ' + String(managerEntry.ownerKey));
    // A window the user asked for must reach the user: an invisible manager would be as
    // unreachable as the disabled menu entry this row replaced.
    const presented = await waitFor(
      function () { const entry = entryFor('unassigned'); return entry && entry.visible === true ? entry : false; },
      'the manager window the menu opened to be presented',
    );
    managerEntry = presented;
    expect(authority.browserShellCount() === 3, 'the menu click left ' + authority.browserShellCount() + ' shells: two project windows plus the manager');
    // A second click is the same window again: the manager is one window per process, and a
    // duplicate would split the cross-project list in two.
    const managerWindowId = managerEntry.windowId;
    managerMenuItem.click({}, BrowserWindow.getAllWindows()[0]);
    await sleep(500);
    const reclicked = entryFor('unassigned');
    expect(reclicked && reclicked.windowId === managerWindowId, 'the second click opened window ' + String(reclicked && reclicked.windowId) + ' instead of focusing ' + String(managerWindowId));
    expect(authority.browserShellCount() === 3, 'the second click left ' + authority.browserShellCount() + ' shells');
    const managerShell = authority.shellFor('unassigned');
    expect(managerShell, 'the manager window has no shell');
    managerSidebar = surfaceOf(managerShell, 'sidebar');
    expect(managerSidebar, 'the manager window has no sidebar surface');
    await waitForApi(managerSidebar, STANDALONE_API_READY);

    const rows = await waitFor(
      async function () {
        const current = await listOf(managerSidebar);
        return idsOf(current).includes(String(alphaSession)) && idsOf(current).includes(String(betaSession)) ? current : false;
      },
      'the manager window to list both projects sessions',
    );
    observations.managerScope = { ownerKey: managerEntry.ownerKey, list: idsOf(rows) };
    expect(idsOf(rows).includes(String(alphaSession)), 'the manager window does not list the ALPHA session: ' + JSON.stringify(observations.managerScope.list));
    expect(idsOf(rows).includes(String(betaSession)), 'the manager window does not list the BETA session: ' + JSON.stringify(observations.managerScope.list));
    // The manager renders the stamps it sees; both project scopes arrive intact.
    expect(rowFor(rows, alphaSession) && rowFor(rows, alphaSession).ownerKey === projectOwnerKey(ALPHA), 'the manager listed the ALPHA session under a foreign owner');
    expect(rowFor(rows, betaSession) && rowFor(rows, betaSession).ownerKey === projectOwnerKey(BETA), 'the manager listed the BETA session under a foreign owner');
  });

  // ------------------------- (3) a manager-minted session assigned to a project through IPC
  await check('terminal.manager-assigns-session-through-ipc', async function () {
    managerSession = await newTerminal(managerSidebar, tempRoot);
    expect(typeof managerSession === 'string' && managerSession.length > 0, 'the manager window minted no session: ' + JSON.stringify(managerSession));
    await waitForRowIn(managerSidebar, managerSession, 'the manager window to list the session it minted');
    expect(ownerKeyOf(managerSession) === 'unassigned', 'the manager session owner was ' + String(ownerKeyOf(managerSession)));
    // A session no project owns is the manager's view alone: no project window lists it.
    expect(rowFor(await listOf(alphaSidebar), managerSession) === null, 'the ALPHA window lists a session no project owns');
    expect(rowFor(await listOf(betaSidebar), managerSession) === null, 'the BETA window lists a session no project owns');

    const reply = await assignProject(managerSidebar, managerSession, BETA.projectId);
    observations.assignReply = reply;
    expect(reply && typeof reply === 'object', 'the assign invoke answered ' + JSON.stringify(reply));
    expect(reply.ok === true, 'the assign invoke refused: ' + JSON.stringify(reply));
    expect(reply.sessionId === managerSession, 'the assign answered for ' + String(reply.sessionId));
    expect(reply.capsuleId === BETA.capsuleId, 'the assign named capsule ' + String(reply.capsuleId));
    expect(reply.ownerKey === projectOwnerKey(BETA), 'the assign named owner ' + String(reply.ownerKey));
    // The reply is a projection; the manager's own stamp is what every later scope decision
    // reads, so it is asserted separately rather than inferred from the answer.
    expect(ownerKeyOf(managerSession) === projectOwnerKey(BETA), 'the session owner stayed ' + String(ownerKeyOf(managerSession)));
    expect(capsuleOf(managerSession) === BETA.capsuleId, 'the session capsule stayed ' + String(capsuleOf(managerSession)));
    // The stamp is the destination: the project's live window picks the row up, and assigning
    // neither opens a window nor replaces the one that is there.
    await waitForRowOwner(betaSidebar, managerSession, projectOwnerKey(BETA), 'the BETA window to list the assigned session');
    expect(rowFor(await listOf(alphaSidebar), managerSession) === null, 'the ALPHA window lists a session handed to BETA');
    expect(authority.browserShellCount() === 3, 'the assign left ' + authority.browserShellCount() + ' shells');
    const betaAfter = entryFor(projectOwnerKey(BETA));
    expect(betaAfter && betaAfter.windowId === betaWindowId, 'the assign replaced the BETA window');
  });

  // ---------------------------------------------- (4) the scope move, driven by the renderer
  await check('terminal.assignment-moves-session-stamp', async function () {
    await waitForRowOwner(managerSidebar, managerSession, projectOwnerKey(BETA), 'the manager to list the assigned session under BETA');
    // Delta is known to the registry but two capsules claim it, so Main resolves it to no capsule:
    // the runtime projection Main's own synchronizer writes is seeded through the registry's
    // public API, because an ambiguous claim never registers a project by itself.
    mainProcess.projectRegistry.registerProject({
      id: DELTA.projectId, name: DELTA.name, dataRoot: tempRoot, state: 'open', createdAt: 1, updatedAt: 1,
    });
    mainProcess.projectRegistry.registerWorkspace({
      id: DELTA.workspaceId, projectId: DELTA.projectId, rootPath: DELTA.path, state: 'attached', createdAt: 1, updatedAt: 1,
    });
    // Drive the shipped project renderer's context menu, not just the preload IPC: a
    // renderer-only scope gate must not hide a transfer that Main permits. The row acted on is
    // ALPHA's own, in ALPHA's own window.
    const beforeMove = TerminalManager.getInstance().getSession(alphaSession);
    const originalPid = beforeMove.pty.pid;
    const originalCwd = beforeMove.cwd;
    await waitForApi(alphaSidebar, "typeof showContextMenu === 'function'");
    const menu = await alphaSidebar.executeJavaScript(
      '(function () { showContextMenu({ preventDefault() {}, stopPropagation() {}, clientX: 20, clientY: 20 }, ' + JSON.stringify(alphaSession) + '); const item = document.querySelector("[data-action=assign-capsule]"); const state = { disabled: item.getAttribute("aria-disabled"), title: item.title }; item.click(); return state; })()',
      true,
    );
    expect(menu.disabled === 'false', 'project terminal move is disabled: ' + menu.title);
    const targetSelector = JSON.stringify('[data-project-id=' + BETA.projectId + ']');
    await waitForApi(alphaSidebar, 'Boolean(document.querySelector(' + targetSelector + '))');
    const destinations = await alphaSidebar.executeJavaScript('Array.from(document.querySelectorAll("#capsulePickerPopover [data-project-id]")).map(row => ({ projectId: row.getAttribute("data-project-id"), capsuleId: row.getAttribute("data-capsule-id"), ariaDisabled: row.getAttribute("aria-disabled"), pickable: typeof row.onclick === "function" }))', true);
    const inventory = await alphaSidebar.executeJavaScript('window.antifanStandalone.listProjects()', true);
    expect(destinations.length === inventory.candidates.length, 'terminal destinations differ from Open Project inventory');
    expect(new Set(destinations.map(row => row.projectId)).size === destinations.length, 'duplicate project destinations');
    const betaRow = destinations.find(row => row.projectId === BETA.projectId);
    expect(betaRow && betaRow.capsuleId === BETA.capsuleId, 'wrong canonical target capsule: ' + JSON.stringify(betaRow));
    // Pickability is the user's half of the contract: a destination Main would accept must be a
    // row that can be clicked, and one Main resolves to nothing must not look clickable.
    expect(betaRow.ariaDisabled === 'false' && betaRow.pickable === true, 'the canonical destination is not pickable: ' + JSON.stringify(betaRow));
    const alphaRow = destinations.find(row => row.projectId === ALPHA.projectId);
    expect(alphaRow && alphaRow.ariaDisabled === 'true' && alphaRow.pickable === false, 'the terminal own project is offered as a destination: ' + JSON.stringify(alphaRow));
    const deltaRow = destinations.find(row => row.projectId === DELTA.projectId);
    expect(deltaRow && deltaRow.capsuleId === null, 'ambiguous claims still offered a transfer capsule: ' + JSON.stringify(deltaRow) + ' among ' + JSON.stringify(destinations));
    expect(deltaRow.ariaDisabled === 'true' && deltaRow.pickable === false, 'an ambiguous destination is offered as pickable: ' + JSON.stringify(deltaRow));
    await alphaSidebar.executeJavaScript('document.querySelector(' + targetSelector + ').click()', true);
    // The click answers through the renderer's own notice, and reading it is what separates
    // "Main refused the move" from "the row never acted" when the ownership wait below fails.
    const transferNotice = await waitFor(
      async function () {
        const text = await alphaSidebar.executeJavaScript('(document.getElementById("terminalNotice") || {}).textContent || null', true);
        // Terminal answers only: a progress notice ("Đang mở…", "Đang chuyển…") or any stale
        // text the toast kept on screen is not the answer this click produced.
        const terminal = typeof text === 'string' && (
          text.indexOf('Đã chuyển') !== -1 || text.indexOf('Không chuyển được') !== -1
          || text.indexOf('Không mở được') !== -1 || text.indexOf('Đã huỷ') !== -1
          || text.indexOf('Không gắn được') !== -1
        );
        return terminal ? text : false;
      },
      'the renderer notice answering the transfer click',
    );
    observations.transferNotice = transferNotice;
    await waitFor(function () { return ownerKeyOf(alphaSession) === projectOwnerKey(BETA); }, 'project menu to transfer ownership after ' + JSON.stringify(transferNotice));
    const afterMove = TerminalManager.getInstance().getSession(alphaSession);
    expect(afterMove.pty.pid === originalPid, 'transfer restarted the running shell');
    expect(afterMove.cwd === originalCwd, 'transfer changed the running shell working directory');
    expect(capsuleOf(alphaSession) === BETA.capsuleId, 'transfer did not update the capsule');
    // The row leaves the window it was minted in and arrives in the destination's window.
    await waitForRowGone(alphaSidebar, alphaSession, 'the ALPHA window to drop the moved session');
    await waitForRowOwner(betaSidebar, alphaSession, projectOwnerKey(BETA), 'the BETA window to list the moved session');
    await waitForRowOwner(managerSidebar, alphaSession, projectOwnerKey(BETA), 'the manager to re-stamp the moved session to BETA');
    observations.moved = {
      sessionId: alphaSession,
      previousOwnerKey: projectOwnerKey(ALPHA),
      ownerKeyAfter: ownerKeyOf(alphaSession),
      targetListed: rowFor(await listOf(betaSidebar), alphaSession) !== null,
      sourceDropped: rowFor(await listOf(alphaSidebar), alphaSession) === null,
      managerListed: idsOf(await listOf(managerSidebar)).includes(String(alphaSession)),
    };
    expect(observations.moved.ownerKeyAfter === projectOwnerKey(BETA), 'the moved session owner was ' + String(observations.moved.ownerKeyAfter));
    expect(observations.moved.sourceDropped === true, 'the scope the session moved out of still lists it: ' + JSON.stringify(observations.moved));
    expect(observations.moved.managerListed === true, 'the manager window stopped listing the moved session');
    expect(authority.browserShellCount() === 3, 'a transfer changed the shell count to ' + authority.browserShellCount());
  });

  // ------------- (5) assigning needs the surface that can show the moved row
  await check('terminal.assign-refuses-when-manager-window-absent', async function () {
    // The move requires the one surface that can render a project's row from outside the
    // project's own window — the Terminal Manager. With it open the assign lands even though the
    // destination has no window yet: a project never needs its window open to receive a session.
    gammaSession = await newTerminal(managerSidebar, tempRoot);
    expect(typeof gammaSession === 'string' && gammaSession.length > 0, 'the manager window minted no session for the absent target: ' + JSON.stringify(gammaSession));
    const firstAssign = await assignProject(managerSidebar, gammaSession, GAMMA.projectId);
    expect(firstAssign && firstAssign.ok === true, 'assigning with the manager open refused: ' + JSON.stringify(firstAssign));
    expect(firstAssign.ownerKey === projectOwnerKey(GAMMA), 'the manager-open assign named owner ' + String(firstAssign.ownerKey));
    expect(ownerKeyOf(gammaSession) === projectOwnerKey(GAMMA), 'the manager-open assign did not stamp ' + String(ownerKeyOf(gammaSession)));
    expect(entryFor(projectOwnerKey(GAMMA)) === null, 'the assign conjured a GAMMA window');

    // Now the gate's own refusal: close the manager window itself. The project windows stay
    // open, so this is a shell close, never an app quit.
    const previousManagerWindowId = managerEntry.windowId;
    const managerWindow = authority.windowFor('unassigned');
    expect(managerWindow && !managerWindow.isDestroyed(), 'the manager has no native window to close');
    expect(authority.requestClose('unassigned') === true, 'the close request never reached the manager window');
    await waitFor(
      function () { return entryFor('unassigned') === null && authority.browserShellCount() === 2; },
      'the manager window to close while the project windows stay open',
    );
    expect(entryFor(projectOwnerKey(ALPHA)) !== null && entryFor(projectOwnerKey(BETA)) !== null, 'a project window went away with the manager');
    managerEntry = null;

    // The route refuses the move rather than moving a session into a scope no live window can
    // render: a silently dropped row would be the worst outcome here. The sender is the ALPHA
    // window's own sidebar and the session is its own, so the refusal is the missing manager,
    // not the caller's standing.
    refusedSession = await newTerminal(alphaSidebar, ALPHA.path);
    expect(typeof refusedSession === 'string' && refusedSession.length > 0, 'the ALPHA window minted no session for the refusal: ' + JSON.stringify(refusedSession));
    await waitForRowIn(alphaSidebar, refusedSession, 'the ALPHA window to list the session it minted for the refusal');
    const mintedOwner = ownerKeyOf(refusedSession);
    expect(mintedOwner === projectOwnerKey(ALPHA), 'the refusal session owner was ' + String(mintedOwner));
    const refusal = await assignProject(alphaSidebar, refusedSession, GAMMA.projectId);
    observations.closedTarget = { refusal: refusal, reopenResult: {}, assignReply: {}, targetListed: false, previousManagerWindowId: previousManagerWindowId };
    expect(refusal && typeof refusal === 'object', 'the manager-absent assign answered ' + JSON.stringify(refusal));
    expect(refusal.ok === false, 'assigning with no Terminal Manager was accepted: ' + JSON.stringify(refusal));
    expect(refusal.reason === 'TARGET_WINDOW_ABSENT', 'the manager-absent refusal reason was ' + String(refusal.reason));
    expect(ownerKeyOf(refusedSession) === mintedOwner, 'a refused assignment moved the session to ' + String(ownerKeyOf(refusedSession)));
    expect(rowFor(await listOf(alphaSidebar), refusedSession) !== null, 'the ALPHA window lost the session the refusal left alone');
    expect(entryFor(projectOwnerKey(GAMMA)) === null, 'a refused assign conjured a GAMMA window');

    // Then the flow the user performs: reopen the manager through the same menu entry that
    // opened it — the only door that window has — and assign once the surface is live.
    const reopenMenuItem = applicationMenuItem('Cửa sổ Terminal chung (Shared Terminal Manager)');
    expect(reopenMenuItem, 'the Terminal menu has no shared-manager entry');
    reopenMenuItem.click({}, BrowserWindow.getAllWindows()[0]);
    const reopenedEntry = await waitFor(
      function () { const entry = entryFor('unassigned'); return entry && entry.visible === true ? entry : false; },
      'the menu click to reopen the manager window',
    );
    observations.closedTarget.reopenResult = { ownerKey: reopenedEntry.ownerKey, windowId: reopenedEntry.windowId };
    expect(reopenedEntry.ownerKey === 'unassigned', 'the recreated surface is not the manager: ' + JSON.stringify(reopenedEntry.ownerKey));
    expect(reopenedEntry.windowId !== previousManagerWindowId, 'the reopened manager claims the destroyed window id');
    expect(authority.browserShellCount() === 3, 'the reopened manager left ' + authority.browserShellCount() + ' shells');
    const reopenedShell = authority.shellFor('unassigned');
    expect(reopenedShell, 'the recreated manager has no shell');
    managerSidebar = surfaceOf(reopenedShell, 'sidebar');
    managerEntry = reopenedEntry;
    expect(managerSidebar, 'the recreated manager has no sidebar surface');
    await waitForApi(managerSidebar, STANDALONE_API_READY);

    const accepted = await assignProject(managerSidebar, refusedSession, GAMMA.projectId);
    observations.closedTarget.assignReply = accepted;
    expect(accepted && accepted.ok === true, 'the assign was refused after the manager reopened: ' + JSON.stringify(accepted));
    expect(accepted.ownerKey === projectOwnerKey(GAMMA), 'the accepted assign named owner ' + String(accepted.ownerKey));
    expect(ownerKeyOf(refusedSession) === projectOwnerKey(GAMMA), 'the assigned session owner was ' + String(ownerKeyOf(refusedSession)));
    await waitForRowGone(alphaSidebar, refusedSession, 'the ALPHA window to drop the session handed to GAMMA');
    // The landing the refusal gate protects: the destination's own window, opened by the user
    // afterwards, lists both rows that were handed to it while it had no window.
    const gammaOpen = await openProjectWindowAndWait(managerSidebar, GAMMA);
    expect(gammaOpen.result && gammaOpen.result.status === 'OPENED', 'the GAMMA open returned ' + JSON.stringify(gammaOpen.result));
    gammaSidebar = gammaOpen.sidebar;
    await waitForRowIn(gammaSidebar, gammaSession, 'the GAMMA window to list the session assigned before it opened');
    await waitForRowIn(gammaSidebar, refusedSession, 'the GAMMA window to list the session assigned after the manager reopened');
    observations.closedTarget.targetListed = true;

    // A project the registry knows with no capsule is a destination as well: assigning to it
    // clears the old capsule stamp instead of inventing a workspace link. Such a project cannot
    // arrive from the capsule store, so the harness seeds the same runtime projection Main's own
    // synchronizer writes, through the registry's public API.
    const unmappedProjectId = 'project-00000000-0000-4000-8000-0000000000e5';
    const unmappedWorkspaceId = 'workspace-00000000-0000-4000-8000-0000000000e5';
    const unmappedPath = path.join(tempRoot, 'capsule-less');
    fs.mkdirSync(unmappedPath, { recursive: true });
    mainProcess.projectRegistry.registerProject({
      id: unmappedProjectId, name: 'Capsule-less', dataRoot: tempRoot, state: 'open', createdAt: 1, updatedAt: 1,
    });
    mainProcess.projectRegistry.registerWorkspace({
      id: unmappedWorkspaceId, projectId: unmappedProjectId, rootPath: unmappedPath, state: 'attached', createdAt: 1, updatedAt: 1,
    });
    // The user's half of the contract for such a destination: unresolved is not the same as
    // unassignable, so it must be offered as a destination that can actually be picked.
    const unmappedInventory = await managerSidebar.executeJavaScript('window.antifanStandalone.listProjects()', true);
    const unmappedCandidate = (unmappedInventory.candidates || []).find((candidate) => candidate.projectId === unmappedProjectId);
    observations.closedTarget.unmappedCandidate = unmappedCandidate;
    expect(unmappedCandidate && unmappedCandidate.canAssignTerminal === true, 'a capsule-less known project was not offered as a transfer destination: ' + JSON.stringify(unmappedCandidate));
    const unmappedProject = { projectId: unmappedProjectId, workspaceId: unmappedWorkspaceId, capsuleId: '', name: 'Capsule-less', path: unmappedPath };
    const unmappedOpen = await openProjectWindowAndWait(managerSidebar, unmappedProject);
    expect(unmappedOpen.result && unmappedOpen.result.status === 'OPENED', 'the capsule-less project open returned ' + JSON.stringify(unmappedOpen.result));
    unmappedSidebar = unmappedOpen.sidebar;
    const bare = await assignProject(managerSidebar, managerSession, unmappedProjectId);
    expect(bare && bare.ok === true, 'the unmapped project refused a terminal: ' + JSON.stringify(bare));
    expect(bare.projectId === unmappedProjectId, 'the assign named project ' + String(bare.projectId));
    expect(bare.capsuleId === undefined, 'the unmapped project answered with capsule ' + String(bare.capsuleId));
    expect(ownerKeyOf(managerSession) === 'project:' + unmappedProjectId, 'the unmapped owner was ' + String(ownerKeyOf(managerSession)));
    expect(capsuleOf(managerSession) === undefined, 'the unmapped project kept capsule ' + String(capsuleOf(managerSession)));
    // The stamp is cleared, not re-pointed, and the row lands in the destination's own window.
    await waitForRowIn(unmappedSidebar, managerSession, 'the capsule-less project window to list the session handed to it');
    await waitForRowGone(betaSidebar, managerSession, 'the BETA window to drop the session handed to the capsule-less project');
  }, async function () {
    // Rows that never got past the refusal leave the manager closed; the caller-refusal rows
    // that follow need it back, so a mid-row failure reopens it rather than leaking the close.
    if (managerEntry === null) {
      try {
        // Same door the row itself uses: the installed menu entry is the only path that
        // creates the shared manager window.
        const menuItem = applicationMenuItem('Cửa sổ Terminal chung (Shared Terminal Manager)');
        if (!menuItem) throw new Error('the Terminal menu has no shared-manager entry');
        menuItem.click({}, BrowserWindow.getAllWindows()[0]);
        const entry = await waitFor(
          function () { const e = entryFor('unassigned'); return e && e.visible === true ? e : false; },
          'the row-level manager restore to reopen the window',
        );
        managerSidebar = surfaceOf(authority.shellFor('unassigned'), 'sidebar');
        managerEntry = entry;
      } catch (err) {
        console.log('the row-level manager restore never reopened the window: ' + String(err));
      }
    }
  });

  // ------------------------- (6) a caller that names no window: a renderer no shell owns
  await check('terminal.window-less-chrome-caller-refused', async function () {
    // A real renderer carrying the shipping chrome preload, owned by no shell: the caller
    // class under test. Its window is created outside the shell factory on purpose, so the
    // sender resolver has nothing to attribute it to.
    const callerPage = path.join(__dirname, 'unknown-caller.html');
    fs.writeFileSync(
      callerPage,
      '<!doctype html><html><head><meta charset="utf-8"><title>unknown caller</title></head><body>unknown caller</body></html>',
      'utf8',
    );
    unknownCallerWindow = new BrowserWindow({
      show: false,
      width: 420,
      height: 320,
      webPreferences: {
        preload: compiledUnder('preload', 'standalone-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });
    await unknownCallerWindow.loadFile(callerPage);
    const outcome = await unknownCallerWindow.webContents.executeJavaScript(
      "(async function () { try { var rows = await window.antifanStandalone.listTerminals(); return { refused: false, rows: Array.isArray(rows) ? rows.length : -1 }; } catch (err) { return { refused: true, message: String(err && err.message ? err.message : err) }; } })()",
      true,
    );
    observations.refusals = observations.refusals || {};
    observations.refusals.chrome = outcome;
    expect(outcome && outcome.refused === true, 'a renderer no live shell owns read the terminal list: ' + JSON.stringify(outcome));
    const message = String(outcome.message || '');
    expect(message.indexOf(CONTRACTS.TERMINAL_CHANNELS.LIST_SESSIONS) !== -1, 'the refusal did not name the refused channel: ' + message);
    expect(message.indexOf(String(unknownCallerWindow.webContents.id)) !== -1, 'the refusal did not name the sending surface: ' + message);
    expect(
      message.indexOf(String(alphaSession)) === -1 && message.indexOf(String(managerSession)) === -1,
      'the refusal carried session rows: ' + message,
    );

    // The same refusal at the router itself: identity, not prose. An unknown sender must raise
    // the router's own error class, which is the identity a caller can assert without trusting
    // a sentence.
    // Dual module evaluation in Electron: the test harness imports ipc-router.js via its own
    // require path, while NativeTabHost resolves it through Electron's main process module cache.
    // Across separate evaluations, constructor prototype identity differs, causing instanceof to fail.
    // Assert structural identity via error name and code ('UnknownChromeSenderError' / 'UNKNOWN_CHROME_SENDER').
    let thrown = null;
    try {
      dispatchChromeRoute(NativeTabHost.CHROME_ROUTES, CONTRACTS.TERMINAL_CHANNELS.LIST_SESSIONS, unknownCallerWindow.webContents, []);
    } catch (err) {
      thrown = err;
    }
    const errObj = thrown && typeof thrown === 'object' ? thrown : null;
    const isUnknownSenderError = Boolean(
      thrown instanceof UnknownChromeSenderError ||
      (errObj && errObj.name === 'UnknownChromeSenderError' && errObj.code === 'UNKNOWN_CHROME_SENDER')
    );
    observations.refusals.chromeIdentity = errObj
      ? { name: String(errObj.name), code: String(errObj.code), isUnknownSenderError: isUnknownSenderError }
      : null;
    expect(
      isUnknownSenderError,
      'the router did not refuse an unknown sender with its own error class: ' + (errObj ? String(errObj.name) + ' (' + String(errObj.code) + ')' : 'nothing was raised'),
    );
  }, async function () {
    if (unknownCallerWindow && !unknownCallerWindow.isDestroyed()) unknownCallerWindow.destroy();
    unknownCallerWindow = null;
  });

  // ------------- (7) a caller that names no window: an MCP/attachment caller
  await check('terminal.window-less-mcp-caller-refused', async function () {
    // The control plane boots beside the first window, so the readiness wait is on the runtime
    // itself: dispatching at a half-built one would measure the boot, not the refusal.
    const controlPlane = await waitFor(
      function () { return mainProcess.projectWindowAuthority.controlPlane() || false; },
      'the control plane to be up',
    );
    const managerHost = authority.hostForOwner('unassigned');
    expect(managerHost, 'the manager window has no host');
    observations.refusals = observations.refusals || {};
    const leaks = function (text) {
      return text.indexOf(String(alphaSession)) !== -1
        || text.indexOf(String(betaSession)) !== -1
        || text.indexOf(String(managerSession)) !== -1
        || text.indexOf(String(gammaSession)) !== -1;
    };
    const refusalOf = function (result) {
      const text = result && result.content && result.content[0] ? String(result.content[0].text || '') : '';
      let parsed = null;
      try { parsed = JSON.parse(text); } catch {}
      return {
        isError: result.isError === true,
        code: parsed && typeof parsed.code === 'string' ? parsed.code : '',
        text: text.slice(0, 400),
      };
    };

    // (7a) No attachment at all: the caller names no window and no tab.
    const anonymous = new AntiFanMcpServer(managerHost, false, controlPlane.transport);
    const anonymousRefusal = refusalOf(await anonymous.callTool('terminal.list', { paged: false }));
    observations.refusals.mcpNoAttachment = anonymousRefusal;
    expect(anonymousRefusal.isError === true, 'an MCP caller with no attachment was served the terminal list: ' + anonymousRefusal.text);
    expect(leaks(anonymousRefusal.text) === false, 'a window-less MCP caller received session rows: ' + anonymousRefusal.text);

    // (7b) An attachment that exists but resolves to no tab: the caller names no window. The
    // workspace is the runtime's own default, so the row cannot fail on a registry the isolated
    // data root never populated.
    const session = await controlPlane.createCliSession({ backendId: 'mcp', grant: 'read' });
    expect(session && session.launch, 'the control plane minted no attachment for the window-less caller');
    const bound = new AntiFanMcpServer(managerHost, false, controlPlane.transport, {
      attachmentId: session.launch.attachmentId,
      attachmentSecret: session.launch.secret,
      authorityRevision: session.launch.authorityRevision,
    });
    try {
      const boundRefusal = refusalOf(await bound.callTool('terminal.list', { paged: false }));
      observations.refusals.mcpNoTab = boundRefusal;
      expect(boundRefusal.isError === true, 'an attachment naming no tab was served the terminal list: ' + boundRefusal.text);
      expect(boundRefusal.code === 'TERMINAL_FORBIDDEN', 'the refusal code was ' + boundRefusal.code + ': ' + boundRefusal.text);
      expect(leaks(boundRefusal.text) === false, 'a window-less MCP caller received session rows: ' + boundRefusal.text);
    } finally {
      // The attachment this row minted is released here: a live session keeps a streaming run
      // alive by design, and the teardown row must not address a process that is rightly busy.
      try { await controlPlane.endCliSession(session.run.id, session.attempt.id, 'completed'); }
      catch (err) { console.log('  NOTE  the window-less session did not end: ' + messageOf(err)); }
    }
  });

  // ------------------------------------------------------- (8) orderly owned teardown
  await check('terminal.cleanup-closes-every-shell', async function () {
    // Sessions close before their windows do. The last window is left standing on purpose:
    // closing it is an application quit, which would tear the harness down while the driver
    // still has its verdict to report; the process exit at the end disposes of it.
    for (const sessionId of [managerSession, gammaSession, refusedSession, alphaSession, betaSession]) {
      if (!sessionId) continue;
      try { await closeOwnedSession(sessionId); } catch (err) { console.log('  NOTE  session ' + sessionId + ' did not close: ' + messageOf(err)); }
    }
    const survivor = authority.snapshot()[0];
    expect(survivor, 'no window was left to report from');
    await waitFor(
      function () {
        if (authority.browserShellCount() === 1) return true;
        for (const entry of authority.snapshot()) {
          // The other windows close the way a user's window close does.
          if (entry.ownerKey !== survivor.ownerKey) authority.requestClose(entry.ownerKey);
        }
        return false;
      },
      'every window but the last to close',
    );
    observations.teardown = { shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount());
  });
}

/** Close one session through the manager's own API; a closed row is a closed PTY. */
async function closeOwnedSession(sessionId) {
  const manager = TerminalManager.getInstance();
  if (!manager.getSession(sessionId)) return;
  await manager.closeSession(sessionId);
}

async function cleanup() {
  try {
    if (unknownCallerWindow && !unknownCallerWindow.isDestroyed()) unknownCallerWindow.destroy();
  } catch (err) {
    console.log('  NOTE  the unknown-caller window survived: ' + messageOf(err));
  }
  try {
    for (const sessionId of [alphaSession, betaSession, managerSession, gammaSession, refusedSession]) {
      if (sessionId) await closeOwnedSession(sessionId);
    }
  } catch (err) {
    console.log('  NOTE  a terminal session survived: ' + messageOf(err));
  }
  // Windows are left to the process exit: closing the last one is an application quit.
  // Only ever the mkdtemp root this run created: the prefix check keeps a later edit from
  // ever aiming this at a path the environment supplied.
  try {
    if (path.basename(tempRoot).indexOf('antifan-tca-e2e-') === 0) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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
      scenario: 'terminal-capsule-assign',
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
      console.log('[terminal-capsule-assign-e2e] failed to write evidence: ' + messageOf(err));
      process.exit(1);
    }
    console.log('[terminal-capsule-assign-e2e] ' + result.passed + ' passed, ' + result.failed + ' failed — evidence: ' + EVIDENCE_FILE);
    exitCode = failed.length === 0 ? 0 : 1;
    process.exit(exitCode);
  });
`;

describe('Live E2E: terminal capsule assignment across project scopes', () => {
  it('moves a session between project scopes through the real assign IPC, and refuses a window-less caller', async () => {
    const rootDir = process.cwd();
    const runnerScript = path.join(rootDir, 'scripts', 'run-electron.cjs');
    const compiledEntry = path.join(rootDir, '.compiled', 'src', 'main', 'index.js');
    assert.ok(fs.existsSync(runnerScript), `the Electron runner is missing: ${runnerScript}`);
    assert.ok(
      fs.existsSync(compiledEntry),
      `the compiled main process is missing (${compiledEntry}); run \`npm run compile\` before the e2e lane`,
    );

    // The driver uses no template literals of its own, so this source can be a template literal
    // here. Guard the property instead of trusting it: a backtick or an interpolation would
    // silently change the scenario the app runs.
    assert.ok(!TERMINAL_CAPSULE_ASSIGN_DRIVER_SOURCE.includes('`'), 'the driver source must not contain a backtick');
    assert.ok(!TERMINAL_CAPSULE_ASSIGN_DRIVER_SOURCE.includes('${'), 'the driver source must not contain an interpolation');

    const driverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-driver-'));
    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-evidence-'));
    const driverPath = path.join(driverDir, 'terminal-capsule-assign-driver.cjs');
    const evidencePath = path.join(evidenceDir, 'terminal-capsule-assign-e2e.json');
    fs.writeFileSync(driverPath, TERMINAL_CAPSULE_ASSIGN_DRIVER_SOURCE, 'utf8');
    try { fs.unlinkSync(evidencePath); } catch {}

    // A broken scenario must fail here rather than half-way through an Electron boot.
    const syntax = spawnSync(process.execPath, ['--check', driverPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `the generated driver does not parse:\n${syntax.stdout}\n${syntax.stderr}`);

    const port = await pickFreePort();
    // The child must never inherit a running app's identity: every ANTIFAN_* variable of this
    // shell (bridge endpoint, terminal session, data/config/profile roots) is dropped, and the
    // three roots point at a throwaway directory from the first instruction of the launch, ahead
    // of the driver's own per-run root.
    const env: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (!name.toUpperCase().startsWith('ANTIFAN_')) env[name] = value;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    const launchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tca-e2e-launch-'));
    env.ANTIFAN_DATA_ROOT = launchRoot;
    env.ANTIFAN_CONFIG_DIR = path.join(launchRoot, 'config');
    env.ANTIFAN_USER_DATA = path.join(launchRoot, 'Profile');
    env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
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

    // A wall-clock watchdog for a hung Electron child, which no fake timer can reap. It kills
    // only the child this suite spawned (`proc`), never a process named or found by pattern.
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killOwnedChildTree(proc);
    }, RUN_TIMEOUT_MS);
    let exit: { code: number | null; signal: NodeJS.Signals | null };
    const exited = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
    proc.once('error', exited.reject);
    proc.once('exit', (code, signal) => exited.resolve({ code, signal }));
    try {
      exit = await exited.promise;
    } finally {
      clearTimeout(timeoutTimer);
      killOwnedChildTree(proc);
    }

    const transcript = `stdout:\n${stdout}\nstderr:\n${stderr}`;
    /** The scenario's own receipt, so a failed assertion can quote what the run recorded. */
    const readEvidence = (): DriverEvidence | null => {
      try {
        return JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as DriverEvidence;
      } catch {
        return null;
      }
    };
    try {
      assert.equal(timedOut, false, `the capsule-assign scenario timed out after ${RUN_TIMEOUT_MS}ms; killed child exited with code ${exit.code}, signal ${exit.signal}\n${transcript}`);
      // The single-instance lock is keyed by the profile this run created; a refusal here would
      // mean the scenario attached to someone else's instance instead of its own.
      assert.ok(!stdout.includes('Another instance is already running'), `the run was refused the single-instance lock\n${transcript}`);
      assert.equal(exit.code, 0, `the capsule-assign scenario must exit cleanly\n${transcript}`);
      assert.match(stdout, /\[terminal-capsule-assign-e2e\] \d+ passed, 0 failed/);
      assert.ok(fs.existsSync(evidencePath), `the scenario wrote no evidence at ${evidencePath}\n${transcript}`);

      const evidence = readEvidence();
      assert.ok(evidence, `the evidence at ${evidencePath} is not readable JSON\n${transcript}`);
      assert.equal(evidence.scenario, 'terminal-capsule-assign');
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

      const observed = evidence.observations;
      // (1) one window per project, two project scopes carried by `project:<id>` stamps. The
      // startup window is the project the environment named; the driver's own row also asserts the
      // live shell count at each step, and here the recorded owners must be the distinct
      // per-project keys the sessions were minted under.
      assert.equal(
        observed.startup.ownerKey,
        'project:project-00000000-0000-4000-8000-0000000000a1',
        'the startup window was not the project the environment named',
      );
      assert.equal(observed.startup.shellCount, 1, 'the startup opened more than one window');
      assert.equal(
        observed.projectScopes.alphaOwnerKey,
        'project:project-00000000-0000-4000-8000-0000000000a1',
        'the ALPHA session was not stamped with its own project owner',
      );
      assert.equal(
        observed.projectScopes.betaOwnerKey,
        'project:project-00000000-0000-4000-8000-0000000000b2',
        'the BETA session was not stamped with its own project owner',
      );
      assert.notEqual(
        observed.projectScopes.alphaOwnerKey,
        observed.projectScopes.betaOwnerKey,
        'both project sessions reported the same owner key',
      );
      assert.ok(observed.projectScopes.alpha.length > 0, 'the ALPHA window listed no terminal under the ALPHA stamp');
      assert.ok(observed.projectScopes.beta.length > 0, 'the BETA window listed no terminal under the BETA stamp');
      // (2)+(3) the manager lists both projects, and the assignment answers for the target.
      assert.ok(observed.managerScope.list.length >= 2, 'the manager window did not list both projects');
      assert.equal(observed.managerScope.ownerKey, 'unassigned', 'the manager window owner key changed');
      assert.equal(observed.assignReply.ok, true, 'the assign invoke was refused');
      assert.equal(
        observed.assignReply.ownerKey,
        observed.projectScopes.betaOwnerKey,
        'the assign answered with an owner other than the target project',
      );
      // (4) the move re-stamped the session: the window it left dropped the row, the destination
      // window and the manager list it.
      assert.equal(observed.moved.ownerKeyAfter, observed.projectScopes.betaOwnerKey, 'the moved session was not re-stamped to the target project');
      assert.equal(observed.moved.targetListed, true, 'the destination project window never listed the moved session');
      assert.equal(observed.moved.sourceDropped, true, 'the scope the session moved out of still lists it');
      assert.equal(observed.moved.managerListed, true, 'the manager window stopped listing the moved session');
      // (5) assigning with no Terminal Manager is refused; recreating the manager through its
      // menu entry makes the same assign land on the destination's scope.
      assert.equal(observed.closedTarget.refusal.ok, false, 'the manager-absent assign was accepted');
      assert.equal(observed.closedTarget.refusal.reason, 'TARGET_WINDOW_ABSENT', 'the manager-absent refusal reason changed');
      assert.equal(observed.closedTarget.reopenResult.ownerKey, 'unassigned', 'the recreated surface is not the manager');
      assert.notEqual(
        observed.closedTarget.reopenResult.windowId,
        observed.closedTarget.previousManagerWindowId,
        'the reopened manager claims the destroyed window id',
      );
      assert.equal(observed.closedTarget.assignReply.ok, true, 'the assign was refused after the manager reopened');
      assert.equal(observed.closedTarget.targetListed, true, 'the destination scope never listed the assigned session');
      // (6)+(7) a caller that names no window is refused, and receives no rows.
      assert.equal(observed.refusals.chrome?.refused, true, 'a renderer no live shell owns was not refused');
      assert.equal(
        observed.refusals.chromeIdentity?.isUnknownSenderError,
        true,
        'the router did not refuse the unknown sender with its own error class',
      );
      assert.equal(observed.refusals.mcpNoAttachment?.isError, true, 'an MCP caller with no attachment was not refused');
      assert.equal(
        observed.refusals.mcpNoAttachment?.code,
        'ATTACHMENT_REQUIRED',
        'the attachmentless MCP refusal code changed',
      );
      assert.equal(observed.refusals.mcpNoTab?.isError, true, 'an MCP attachment naming no tab was not refused');
      assert.equal(observed.refusals.mcpNoTab?.code, 'TERMINAL_FORBIDDEN', 'the window-less MCP refusal code changed');
      // (8) nothing this run opened is still alive.
      assert.equal(observed.teardown.shellCount, 1, 'the run left more than the reporting window behind');
    } catch (err) {
      // The evidence the assertions just read is the only durable trace of the run, and it lives
      // in a temp directory this suite removes: quote it in the failure instead of losing it.
      const evidence = readEvidence();
      const detail = evidence ? `\nevidence: ${JSON.stringify(evidence, null, 2)}` : '';
      throw new Error(`${(err as Error).message}${detail}`);
    } finally {
      // Every directory is this suite's own mkdtemp root, named by this lane's prefix.
      for (const dir of [driverDir, evidenceDir, launchRoot]) {
        if (path.basename(dir).startsWith('antifan-tca-e2e-')) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});
