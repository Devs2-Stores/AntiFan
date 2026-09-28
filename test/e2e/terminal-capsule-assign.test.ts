/**
 * Live E2E: one terminal, many projects — capsule assignment through the shipping app.
 *
 * A terminal window, a project window and the shared Terminals window all read the same
 * process-wide terminal manager, so the only thing that keeps one project's shells out of
 * another project's list is the window-derived owner key. This suite boots the real Electron
 * process with two project windows live, opens the shared manager (the window whose shell
 * owner is `unassigned`), and then moves sessions between scopes through the same chrome IPC
 * a user's tab context menu drives: one session minted by the manager and handed to a project,
 * one session minted by a project and taken away from it, and one handed to a capsule whose
 * window is not open yet. A caller that names no window at all — a renderer no shell owns, or
 * an MCP/attachment caller — must stay refused, because the manager's superset view is a
 * privilege of being a window, not a process-wide default.
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
 *
 * Coverage split:
 *
 *   Automated here (a scripted harness observes them):
 *     - two project windows live on distinct owners, each listing only its own terminal
 *     - the manager window's own list is the superset: every live project's session
 *     - a session minted by the manager, assigned to a project through the real
 *       `TERMINAL_CHANNELS.ASSIGN_PROJECT` invoke, appears in the target window's scope
 *     - a session moved out of the project window that minted it disappears from that
 *       window's scope while the manager keeps listing it
 *     - a target capsule whose window is closed is refused first (`TARGET_WINDOW_ABSENT`),
 *       then the renderer's own open-then-assign flow lands the session in the opened window
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
  'terminal.two-project-windows-hold-their-own-scopes',
  'terminal.manager-window-lists-every-project-scope',
  'terminal.manager-assigns-session-through-ipc',
  'terminal.assignment-moves-session-scope',
  'terminal.assign-opens-closed-target-window',
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
  error?: string;
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
    previousOwnerListed: boolean;
    targetListed: boolean;
    managerListed: boolean;
  };
  closedTarget: {
    refusal: { ok: boolean; reason?: string };
    openResult: { status?: string };
    assignReply: { ok: boolean; ownerKey?: string };
    targetListed: boolean;
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
 * teardown the repository's own two-window lane performs.
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
// Gamma's capsule exists from boot; its window is deliberately NOT open, which is what the
// closed-target row needs.
const GAMMA = makeProject('c3', 'Capsule Gamma');
const PROJECTS = [ALPHA, BETA, GAMMA];

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
      return { id: 'legacy-alpha-' + index, name: ALPHA.name, workspacePath: ALPHA.path,
        state: {}, createdAt: 1, updatedAt: 1 };
    })).concat([{ id: 'legacy-alpha-ambiguous', name: 'Ambiguous Alpha', workspacePath: ALPHA.path,
      state: {}, createdAt: 1, updatedAt: 1, projectId: ALPHA.projectId, workspaceId: ALPHA.workspaceId,
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
  try {
    await Promise.race([fn(), rowTimeout.promise]);
    checks.push({ name: name, ok: true });
    console.log('  PASS  ' + name);
  } catch (err) {
    checks.push({ name: name, ok: false, error: messageOf(err) });
    console.log('  FAIL  ' + name + ': ' + messageOf(err));
  } finally {
    clearTimeout(rowTimer);
    // A row that fails must still leave the scenario as it found it, so one honest failure does
    // not hand every later row its own leftovers. Cleanup is best-effort and never decides a row.
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
let managerEntry = null;
let managerSidebar = null;
let alphaSidebar = null;
let betaSidebar = null;
let gammaSidebar = null;
let unknownCallerWindow = null;
let alphaSession = null;
let betaSession = null;
let managerSession = null;
let gammaSession = null;

const surfaceOf = function (shell, surface) {
  const view = surface === 'sidebar' ? shell && shell.sidebarView : shell && shell.toolbarView;
  return view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null;
};
const ownerOfProject = function (project) { return 'project:' + project.projectId; };
const entryFor = function (ownerKeyValue) {
  return authority.snapshot().find(function (entry) { return entry.ownerKey === ownerKeyValue; }) || null;
};
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
const waitForRowIn = async function (surface, sessionId, description) {
  await waitFor(
    async function () { return idsOf(await listOf(surface)).includes(String(sessionId)) ? true : false; },
    description,
  );
};
const waitForRowGone = async function (surface, sessionId, description) {
  await waitFor(
    async function () { return idsOf(await listOf(surface)).includes(String(sessionId)) ? false : true; },
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
/** Open one project the way its own opening surface does, and wait for its presentable window. */
async function openProjectAndWait(surface, project) {
  const result = await surface.executeJavaScript(
    'window.antifanStandalone.openProject(' + JSON.stringify(project.projectId) + ')',
    true,
  );
  const entry = await waitFor(
    function () { return entryFor(ownerOfProject(project)) || false; },
    'the project window for ' + project.name,
  );
  // The entry existing is not the window reaching the user: a shell is built hidden, so a user
  // open must be shown by Main's own presentation, and every row here waits for that.
  const presented = await waitFor(
    function () {
      const current = entryFor(ownerOfProject(project));
      return current && current.visible === true ? current : false;
    },
    'the window opened for ' + project.name + ' to be presented',
  );
  return { result: result, entry: presented };
}

async function run() {
  authority = mainProcess.projectWindowAuthority;
  await app.whenReady();

  // ----------------------------------- (1) two project windows, each with its own scope
  const startup = await waitFor(
    function () { return entryFor(ownerOfProject(ALPHA)) || false; },
    'the startup project window',
  );
  const alphaKey = startup.ownerKey;
  observations.startup = { ownerKey: alphaKey, windowId: startup.windowId, shellCount: authority.browserShellCount() };

  let betaEntry = null;

  await check('terminal.two-project-windows-hold-their-own-scopes', async function () {
    expect(startup.owner.kind === 'project', 'the startup owner kind was ' + String(startup.owner.kind));
    expect(startup.owner.projectId === ALPHA.projectId, 'the startup owner project was ' + String(startup.owner.projectId));
    const alphaShell = authority.shellFor(alphaKey);
    expect(alphaShell, 'the startup window has no shell');
    alphaSidebar = surfaceOf(alphaShell, 'sidebar');
    expect(alphaSidebar, 'the startup window has no sidebar surface');
    await waitForApi(alphaSidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.assignTerminalProject === 'function'");
    const alphaToolbar = surfaceOf(alphaShell, 'toolbar');
    const alphaChip = alphaToolbar
      ? await alphaToolbar.executeJavaScript('document.getElementById("projectChipTitle")?.textContent || null', true)
      : null;
    // The two names a project shell presents, captured before either is judged: the native
    // title Main set, and the record title the entry carries. Alpha's project carries two
    // capsule records on purpose (the transfer row needs an ambiguous destination), so both
    // must land on the stable label rather than on either record's name.
    observations.alphaPresentation = {
      nativeTitle: alphaShell.window.getTitle(),
      recordTitle: startup.title,
      chip: alphaChip,
    };
    const alphaRecordTitle = startup.title;
    expect(alphaShell.window.getTitle() === alphaRecordTitle, 'the native title ' + JSON.stringify(alphaShell.window.getTitle()) + ' differs from the record title ' + JSON.stringify(alphaRecordTitle));
    expect(alphaShell.window.getTitle().includes(ALPHA.projectId), 'the ambiguous project was presented as ' + JSON.stringify(alphaShell.window.getTitle()) + ' instead of a label naming ' + ALPHA.projectId);
    expect(alphaShell.window.getTitle() !== ALPHA.name && alphaShell.window.getTitle() !== 'Ambiguous Alpha', 'an ambiguous claim was presented as a project name: ' + JSON.stringify(alphaShell.window.getTitle()));
    await waitForApi(alphaToolbar, 'document.getElementById("projectChipTitle")?.textContent === ' + JSON.stringify(alphaRecordTitle));

    const opened = await openProjectAndWait(alphaSidebar, BETA);
    betaEntry = opened.entry;
    expect(opened.result && opened.result.status === 'OPENED', 'the second project open returned ' + JSON.stringify(opened.result));
    expect(betaEntry.ownerKey !== alphaKey, 'both windows reported the owner ' + String(betaEntry.ownerKey));
    expect(betaEntry.owner.projectId === BETA.projectId, 'the second window owner was ' + JSON.stringify(betaEntry.owner));
    // Exactly the two project windows under test: a third shell here would mean the boot opened
    // something else, and every later count in this run would be measuring more than the pair.
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount() + ' with two projects open');
    const betaShell = authority.shellFor(betaEntry.ownerKey);
    expect(betaShell, 'the second window has no shell');
    betaSidebar = surfaceOf(betaShell, 'sidebar');
    expect(betaSidebar, 'the second window has no sidebar surface');
    await waitForApi(betaSidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.listTerminals === 'function'");
    // Beta's claim is unambiguous — exactly one record names its project — so this is the window
    // where a capsule's own name must reach the user, in the record the window directory holds and
    // in the native title the shell was built with.
    observations.betaPresentation = { nativeTitle: betaShell.window.getTitle(), recordTitle: betaEntry.title };
    expect(betaEntry.title === BETA.name, 'the second window record presented ' + JSON.stringify(betaEntry.title) + ' instead of its capsule name');
    expect(betaShell.window.getTitle() === BETA.name, 'the second window native title was ' + JSON.stringify(betaShell.window.getTitle()) + ' instead of ' + JSON.stringify(BETA.name));

    // Each window mints its own terminal through its own chrome. The working directory is a real
    // path inside this run's temp root, so no shell can spawn anywhere else.
    alphaSession = await newTerminal(alphaSidebar, ALPHA.path);
    betaSession = await newTerminal(betaSidebar, BETA.path);
    expect(typeof alphaSession === 'string' && alphaSession.length > 0, 'the first window minted no session: ' + JSON.stringify(alphaSession));
    expect(typeof betaSession === 'string' && betaSession.length > 0, 'the second window minted no session: ' + JSON.stringify(betaSession));
    expect(alphaSession !== betaSession, 'both windows minted the same session id');

    await waitForRowIn(alphaSidebar, alphaSession, 'the first window to list the session it minted');
    await waitForRowIn(betaSidebar, betaSession, 'the second window to list the session it minted');
    const alphaRows = await listOf(alphaSidebar);
    const betaRows = await listOf(betaSidebar);
    observations.projectScopes = {
      alphaOwnerKey: alphaKey,
      betaOwnerKey: betaEntry.ownerKey,
      alpha: idsOf(alphaRows),
      beta: idsOf(betaRows),
    };
    expect(idsOf(alphaRows).includes(String(betaSession)) === false, 'the first window lists the second window session: ' + JSON.stringify(observations.projectScopes.alpha));
    expect(idsOf(betaRows).includes(String(alphaSession)) === false, 'the second window lists the first window session: ' + JSON.stringify(observations.projectScopes.beta));
    // The row's owner stamp, read from the manager itself: the list above is a scope decision
    // made from this stamp, so a scope that agreed by accident would still be visible here.
    expect(ownerKeyOf(alphaSession) === alphaKey, 'the first session owner was ' + String(ownerKeyOf(alphaSession)));
    expect(ownerKeyOf(betaSession) === betaEntry.ownerKey, 'the second session owner was ' + String(ownerKeyOf(betaSession)));
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
    expect(authority.browserShellCount() === 3, 'the menu click left ' + authority.browserShellCount() + ' shells with two projects and one manager');
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
    await waitForApi(managerSidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.listTerminals === 'function'");

    const rows = await waitFor(
      async function () {
        const current = await listOf(managerSidebar);
        return idsOf(current).includes(String(alphaSession)) && idsOf(current).includes(String(betaSession)) ? current : false;
      },
      'the manager window to list both projects sessions',
    );
    observations.managerScope = { ownerKey: managerEntry.ownerKey, list: idsOf(rows) };
    expect(idsOf(rows).includes(String(alphaSession)), 'the manager window does not list the first project session: ' + JSON.stringify(observations.managerScope.list));
    expect(idsOf(rows).includes(String(betaSession)), 'the manager window does not list the second project session: ' + JSON.stringify(observations.managerScope.list));
  });

  // ------------------------- (3) a manager-minted session assigned to a capsule through IPC
  await check('terminal.manager-assigns-session-through-ipc', async function () {
    managerSession = await newTerminal(managerSidebar, tempRoot);
    expect(typeof managerSession === 'string' && managerSession.length > 0, 'the manager window minted no session: ' + JSON.stringify(managerSession));
    await waitForRowIn(managerSidebar, managerSession, 'the manager window to list the session it minted');
    expect(ownerKeyOf(managerSession) === 'unassigned', 'the manager session owner was ' + String(ownerKeyOf(managerSession)));
    expect(idsOf(await listOf(alphaSidebar)).includes(String(managerSession)) === false, 'the first project window lists the unassigned session before any assignment');
    expect(idsOf(await listOf(betaSidebar)).includes(String(managerSession)) === false, 'the second project window lists the unassigned session before any assignment');

    const reply = await assignProject(managerSidebar, managerSession, BETA.projectId);
    observations.assignReply = reply;
    expect(reply && typeof reply === 'object', 'the assign invoke answered ' + JSON.stringify(reply));
    expect(reply.ok === true, 'the assign invoke refused: ' + JSON.stringify(reply));
    expect(reply.sessionId === managerSession, 'the assign answered for ' + String(reply.sessionId));
    expect(reply.capsuleId === BETA.capsuleId, 'the assign named capsule ' + String(reply.capsuleId));
    expect(reply.ownerKey === ownerOfProject(BETA), 'the assign named owner ' + String(reply.ownerKey));
    // The reply is a projection; the manager's own stamp is what every later scope decision
    // reads, so it is asserted separately rather than inferred from the answer.
    expect(ownerKeyOf(managerSession) === ownerOfProject(BETA), 'the session owner stayed ' + String(ownerKeyOf(managerSession)));
    expect(capsuleOf(managerSession) === BETA.capsuleId, 'the session capsule stayed ' + String(capsuleOf(managerSession)));
  });

  // ---------------------------------------------- (4) the scope move, both directions
  await check('terminal.assignment-moves-session-scope', async function () {
    await waitForRowIn(betaSidebar, managerSession, 'the target window to list the assigned session');
    expect(idsOf(await listOf(alphaSidebar)).includes(String(managerSession)) === false, 'a project window that was never the target lists the assigned session');
    await waitForRowIn(managerSidebar, managerSession, 'the manager window to still list the assigned session');

    // Drive the shipped project renderer's context menu, not just the preload IPC:
    // a renderer-only scope gate must not hide a transfer that Main permits.
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
    expect(betaRow.capsuleId === BETA.capsuleId, 'wrong canonical target capsule');
    // Pickability is the user's half of the contract: a destination Main would accept must be a
    // row that can be clicked, and one Main resolves to nothing must not look clickable.
    expect(betaRow.ariaDisabled === 'false' && betaRow.pickable === true, 'the canonical destination is not pickable: ' + JSON.stringify(betaRow));
    const alphaRow = destinations.find(row => row.projectId === ALPHA.projectId);
    expect(alphaRow.capsuleId === null, 'ambiguous claims still offered a transfer capsule');
    expect(alphaRow.ariaDisabled === 'true' && alphaRow.pickable === false, 'an ambiguous destination is offered as pickable: ' + JSON.stringify(alphaRow));
    await alphaSidebar.executeJavaScript('document.querySelector(' + targetSelector + ').click()', true);
    // The click answers through the renderer's own notice, and reading it is what separates
    // "Main refused the move" from "the row never acted" when the ownership wait below fails.
    const transferNotice = await waitFor(
      async function () {
        const text = await alphaSidebar.executeJavaScript('(document.getElementById("terminalNotice") || {}).textContent || null', true);
        return text && text.indexOf('Đang mở') === -1 ? text : false;
      },
      'the renderer notice answering the transfer click',
    );
    observations.transferNotice = transferNotice;
    await waitFor(function () { return ownerKeyOf(alphaSession) === ownerOfProject(BETA); }, 'project menu to transfer ownership after ' + JSON.stringify(transferNotice));
    const afterMove = TerminalManager.getInstance().getSession(alphaSession);
    expect(afterMove.pty.pid === originalPid, 'transfer restarted the running shell');
    expect(afterMove.cwd === originalCwd, 'transfer changed the running shell working directory');
    expect(capsuleOf(alphaSession) === BETA.capsuleId, 'transfer did not update the capsule');
    await waitForRowIn(betaSidebar, alphaSession, 'the target window to list the moved session');
    await waitForRowGone(alphaSidebar, alphaSession, 'the previous owner window to drop the moved session');
    observations.moved = {
      sessionId: alphaSession,
      previousOwnerKey: alphaKey,
      previousOwnerListed: idsOf(await listOf(alphaSidebar)).includes(String(alphaSession)),
      targetListed: idsOf(await listOf(betaSidebar)).includes(String(alphaSession)),
      managerListed: idsOf(await listOf(managerSidebar)).includes(String(alphaSession)),
    };
    expect(observations.moved.targetListed === true, 'the target window does not list the moved session');
    expect(observations.moved.previousOwnerListed === false, 'the window the session moved out of still lists it: ' + JSON.stringify(observations.moved));
    expect(observations.moved.managerListed === true, 'the manager window stopped listing the moved session');
    expect(ownerKeyOf(alphaSession) === ownerOfProject(BETA), 'the moved session owner was ' + String(ownerKeyOf(alphaSession)));
  });

  // ------------------------- (5) a target capsule whose window is not open yet
  await check('terminal.assign-opens-closed-target-window', async function () {
    expect(entryFor(ownerOfProject(GAMMA)) === null, 'the third project window was already open before the row started');
    gammaSession = await newTerminal(managerSidebar, tempRoot);
    expect(typeof gammaSession === 'string' && gammaSession.length > 0, 'the manager window minted no session for the closed target: ' + JSON.stringify(gammaSession));

    // The route refuses a target no window owns rather than moving a session into a scope that
    // does not exist yet: a silently dropped row would be the worst outcome here.
    const refusal = await assignProject(managerSidebar, gammaSession, GAMMA.projectId);
    observations.closedTarget = { refusal: refusal, openResult: {}, assignReply: {}, targetListed: false };
    expect(refusal && typeof refusal === 'object', 'the closed-target assign answered ' + JSON.stringify(refusal));
    expect(refusal.ok === false, 'assigning to a capsule whose window is closed was accepted: ' + JSON.stringify(refusal));
    expect(refusal.reason === 'TARGET_WINDOW_ABSENT', 'the closed-target refusal reason was ' + String(refusal.reason));
    expect(ownerKeyOf(gammaSession) === 'unassigned', 'a refused assignment moved the session to ' + String(ownerKeyOf(gammaSession)));
    expect(idsOf(await listOf(managerSidebar)).includes(String(gammaSession)), 'the manager window lost the session the refusal left alone');

    // Then the flow the manager renderer performs: open the capsule's project window first, and
    // assign once it is live.
    const opened = await openProjectAndWait(managerSidebar, GAMMA);
    observations.closedTarget.openResult = opened.result;
    expect(opened.result && opened.result.status === 'OPENED', 'opening the third project returned ' + JSON.stringify(opened.result));
    const gammaShell = authority.shellFor(opened.entry.ownerKey);
    expect(gammaShell, 'the opened window has no shell');
    gammaSidebar = surfaceOf(gammaShell, 'sidebar');
    expect(gammaSidebar, 'the opened window has no sidebar surface');
    await waitForApi(gammaSidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.listTerminals === 'function'");

    const accepted = await assignProject(managerSidebar, gammaSession, GAMMA.projectId);
    observations.closedTarget.assignReply = accepted;
    expect(accepted && accepted.ok === true, 'the assign was refused after the window opened: ' + JSON.stringify(accepted));
    expect(accepted.ownerKey === ownerOfProject(GAMMA), 'the accepted assign named owner ' + String(accepted.ownerKey));
    await waitForRowIn(gammaSidebar, gammaSession, 'the opened window to list the assigned session');
    observations.closedTarget.targetListed = true;
    expect(ownerKeyOf(gammaSession) === ownerOfProject(GAMMA), 'the assigned session owner was ' + String(ownerKeyOf(gammaSession)));

    // The built-in capsule-less project is the durable destination itself: assigning to it
    // clears the old capsule stamp instead of inventing a workspace link. A project no capsule
    // record names cannot arrive from the capsule store at all, so the harness seeds the same
    // runtime projection Main's own synchronizer writes, through the registry's public API.
    const unmappedProjectId = 'project-00000000-0000-4000-8000-000000000001';
    const unmappedWorkspaceId = 'workspace-00000000-0000-4000-8000-000000000001';
    mainProcess.projectRegistry.registerProject({
      id: unmappedProjectId, name: 'Tổng hợp', dataRoot: tempRoot, state: 'open', createdAt: 1, updatedAt: 1,
    });
    mainProcess.projectRegistry.registerWorkspace({
      id: unmappedWorkspaceId, projectId: unmappedProjectId, rootPath: tempRoot, state: 'attached', createdAt: 1, updatedAt: 1,
    });
    // The user's half of the contract for such a destination: unresolved is not the same as
    // unassignable, so it must be offered as a destination that can actually be picked.
    const unmappedInventory = await managerSidebar.executeJavaScript('window.antifanStandalone.listProjects()', true);
    const unmappedCandidate = (unmappedInventory.candidates || []).find((candidate) => candidate.projectId === unmappedProjectId);
    observations.closedTarget.unmappedCandidate = unmappedCandidate;
    expect(unmappedCandidate && unmappedCandidate.canAssignTerminal === true, 'a capsule-less known project was not offered as a transfer destination: ' + JSON.stringify(unmappedCandidate));
    const bootOpened = await openProjectAndWait(managerSidebar, {
      projectId: unmappedProjectId,
      workspaceId: unmappedWorkspaceId,
      capsuleId: '',
      name: 'Tổng hợp',
      path: tempRoot,
    });
    expect(bootOpened.result && (bootOpened.result.status === 'OPENED' || bootOpened.result.status === 'FOCUSED'), 'the capsule-less project window did not open');
    const boot = await assignProject(managerSidebar, managerSession, unmappedProjectId);
    expect(boot && boot.ok === true, 'the unmapped project refused a terminal: ' + JSON.stringify(boot));
    expect(boot.projectId === unmappedProjectId, 'the assign named project ' + String(boot.projectId));
    expect(boot.capsuleId === undefined, 'the unmapped project answered with capsule ' + String(boot.capsuleId));
    expect(ownerKeyOf(managerSession) === 'project:' + unmappedProjectId, 'the unmapped owner was ' + String(ownerKeyOf(managerSession)));
    expect(capsuleOf(managerSession) === undefined, 'the unmapped project kept capsule ' + String(capsuleOf(managerSession)));
    // The stamp is cleared, not re-pointed, and the row lands in the destination's own window:
    // both halves are what the user sees after the move.
    const unmappedShell = authority.shellFor('project:' + unmappedProjectId);
    expect(unmappedShell, 'the capsule-less project has no shell to read');
    const unmappedSidebar = surfaceOf(unmappedShell, 'sidebar');
    expect(unmappedSidebar, 'the capsule-less project has no sidebar surface');
    await waitForApi(unmappedSidebar, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.listTerminals === 'function'");
    await waitForRowIn(unmappedSidebar, managerSession, 'the capsule-less project window to list the session handed to it');
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
    let thrown = null;
    try {
      dispatchChromeRoute(NativeTabHost.CHROME_ROUTES, CONTRACTS.TERMINAL_CHANNELS.LIST_SESSIONS, unknownCallerWindow.webContents, []);
    } catch (err) {
      thrown = err;
    }
    observations.refusals.chromeIdentity = thrown
      ? { name: String(thrown.name), code: String(thrown.code), isUnknownSenderError: thrown instanceof UnknownChromeSenderError }
      : null;
    expect(
      thrown instanceof UnknownChromeSenderError,
      'the router did not refuse an unknown sender with its own error class: ' + (thrown ? String(thrown.name) : 'nothing was raised'),
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
      try { await bound.stop(); } catch (err) { console.log('  NOTE  the MCP surface did not stop: ' + messageOf(err)); }
      try { await controlPlane.endCliSession(session.run.id, session.attempt.id, 'completed'); }
      catch (err) { console.log('  NOTE  the window-less session did not end: ' + messageOf(err)); }
    }
  });

  // ------------------------------------------------------- (8) orderly owned teardown
  await check('terminal.cleanup-closes-every-shell', async function () {
    for (const sessionId of [alphaSession, betaSession, managerSession, gammaSession]) {
      if (!sessionId) continue;
      try { await closeOwnedSession(sessionId); } catch (err) { console.log('  NOTE  session ' + sessionId + ' did not close: ' + messageOf(err)); }
    }
    for (const entry of authority.snapshot()) {
      authority.requestClose(entry.ownerKey);
    }
    await waitFor(
      function () { return authority.browserShellCount() === 0 ? true : false; },
      'every remaining browser shell to close',
    );
    observations.teardown = { shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 0, 'browserShellCount() was ' + authority.browserShellCount());
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
    for (const sessionId of [alphaSession, betaSession, managerSession, gammaSession]) {
      if (sessionId) await closeOwnedSession(sessionId);
    }
  } catch (err) {
    console.log('  NOTE  a terminal session survived: ' + messageOf(err));
  }
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

describe('Live E2E: terminal capsule assignment across project windows', () => {
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
      // (1) two windows, two owners, two disjoint terminal sets. The driver's own row also
      // asserts the live shell count at that moment; here the recorded owners must differ.
      assert.notEqual(
        observed.projectScopes.alphaOwnerKey,
        observed.projectScopes.betaOwnerKey,
        'both project windows reported the same owner key',
      );
      assert.ok(observed.projectScopes.alpha.length > 0, 'the first window listed no terminal of its own');
      assert.ok(observed.projectScopes.beta.length > 0, 'the second window listed no terminal of its own');
      // (2)+(3) the manager lists both projects, and the assignment answers for the target.
      assert.ok(observed.managerScope.list.length >= 2, 'the manager window did not list both projects');
      assert.equal(observed.managerScope.ownerKey, 'unassigned', 'the manager window owner key changed');
      assert.equal(observed.assignReply.ok, true, 'the assign invoke was refused');
      assert.equal(
        observed.assignReply.ownerKey,
        observed.projectScopes.betaOwnerKey,
        'the assign answered with an owner other than the target window',
      );
      // (4) the move happened in both directions, and the manager kept the row.
      assert.equal(observed.moved.targetListed, true, 'the target window never listed the moved session');
      assert.equal(observed.moved.previousOwnerListed, false, 'the previous owner window still listed the moved session');
      assert.equal(observed.moved.managerListed, true, 'the manager window stopped listing the moved session');
      // (5) the closed target was refused first, then opened, then accepted.
      assert.equal(observed.closedTarget.refusal.ok, false, 'the closed-target assign was accepted');
      assert.equal(observed.closedTarget.refusal.reason, 'TARGET_WINDOW_ABSENT', 'the closed-target refusal reason changed');
      assert.equal(observed.closedTarget.openResult.status, 'OPENED', 'the closed target window was not opened');
      assert.equal(observed.closedTarget.assignReply.ok, true, 'the assign was refused after the target window opened');
      assert.equal(observed.closedTarget.targetListed, true, 'the opened window never listed the assigned session');
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
      assert.equal(observed.teardown.shellCount, 0, 'the run left browser shells behind');
    } catch (err) {
      // The evidence the assertions just read is the only durable trace of the run, and it lives
      // in a temp directory this suite removes: quote it in the failure instead of losing it.
      const evidence = readEvidence();
      const detail = evidence ? `\nevidence: ${JSON.stringify(evidence, null, 2)}` : '';
      throw new Error(`${(err as Error).message}${detail}`);
    } finally {
      // Both directories are this suite's own mkdtemp roots, named by this lane's prefix.
      for (const dir of [driverDir, evidenceDir]) {
        if (path.basename(dir).startsWith('antifan-tca-e2e-')) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    }
  });
});
