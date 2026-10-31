/**
 * Live E2E: one window per project, and the saved-tabs migration at boot, certified through the
 * shipping app.
 *
 * The individual smokes each prove one surface-level behaviour (split review, background
 * multitasking, profile persistence, terminal survival). This suite boots the real Electron
 * process and watches what a user sees: every project has its own window (`project:<id>`), the
 * shared Terminal Manager (`unassigned`) is a sibling that hosts no browser tabs, there is no
 * shared 'web' window and no placeholder project. Opening a project opens (or focuses) that
 * project's window, tabs minted in a window carry that project's stamp and live only there,
 * per-tab state (active tab, split layout) belongs to the window and its tab, a native
 * `window.open` popup inherits its own tab's affiliation, a window-wide search finds a tab in
 * any window and presents that tab's own window without moving execution authority, and closing
 * one window (the Terminal Manager included) leaves every other window and its tabs alone.
 * A second run seeds a profile written by the shared-window layout and certifies the one-time
 * migration that splits it into per-project records.
 *
 * How it runs: each scenario is a real Electron main-process script, generated into a
 * throwaway directory from `PROJECT_WINDOWS_DRIVER_SOURCE` below and launched through the
 * repository's own `scripts/run-electron.cjs`. The driver boots the shipping `src/main/index.ts`
 * inside the process (never a copy of it), drives the chrome surfaces the way their renderers
 * do, and reports per-row results plus observations as JSON. Keeping the scenario beside the
 * assertions is what stops the two from drifting: a row that is not in the scenario's row list
 * fails the suite, and a row the driver stops reporting fails it too. The pages the tabs load
 * are served by the driver itself on a loopback port, so no row depends on the network.
 *
 * Isolation: throwaway `ANTIFAN_DATA_ROOT`, `ANTIFAN_CONFIG_DIR`, `ANTIFAN_USER_DATA`, a bridge
 * port and a page port this test picks free before the launch, and an environment scrubbed of
 * every inherited `ANTIFAN_*` variable (a developer shell carries the live app's bridge and
 * terminal identity). The developer's profile, data root and capsules are never read or written,
 * and every process this suite starts is its own.
 *
 * Coverage (old shared-window row -> row here):
 *
 *   `lifecycle` scenario (boot with no saved state, five seeded projects):
 *     - startup-single-web-shell            -> boot-opens-only-the-terminal-manager
 *     - second-project-joins-web-hub        -> open-project-creates-its-own-window,
 *                                              second-project-gets-a-second-window
 *     - duplicate-open-refocuses-hub        -> duplicate-open-focuses-the-existing-window
 *     - unknown-project-refused             -> unknown-project-refused
 *     - tabs-stamped-per-project-active-tab-independent
 *                                           -> tabs-stay-in-their-own-window-and-keep-their-stamp
 *     - split-layout-per-tab-across-projects-> split-layout-per-tab-survives-window-focus
 *     - native-popup-inherits-tab-affiliation-> native-popup-inherits-tab-affiliation
 *     - minimize-restore-keeps-hub-target   -> minimize-restore-keeps-window-target
 *     - same-project-sessions-cannot-cross-invoke -> same-project-sessions-cannot-cross-invoke
 *     - background-hub-surface-and-capture-ready  -> background-window-surface-and-capture-ready
 *     - search-lists-every-stamped-tab      -> search-lists-the-tabs-of-every-window
 *     - search-activates-tab-without-authority-rotation
 *                                           -> search-presents-the-tabs-own-window-without-authority-rotation
 *     - search-stale-refusal-no-fallback    -> search-stale-refusal-no-fallback
 *     - five-projects-twenty-stamped-tabs   -> five-project-windows-twenty-stamped-tabs
 *     - agent-project-ensure-resolves-to-hub-unpresented
 *                                           -> agent-ensure-opens-the-project-window-unpresented,
 *                                              user-open-presents-and-restores-the-windows-own-tabs
 *     - close-keeps-hub-and-tabs            -> close-terminal-manager-keeps-project-windows,
 *                                              close-project-window-keeps-the-others
 *     - project-inactivity-closer (a project's window closes when it stops running)
 *                                           -> project-window-closes-when-its-last-running-terminal-sleeps,
 *                                              last-visible-project-window-stays-when-its-last-terminal-sleeps,
 *                                              project-window-closes-when-only-a-sync-watcher-keeps-running,
 *                                              project-window-whose-only-terminals-are-sync-watchers-stays-open,
 *                                              terminal-manager-close-closes-windows-of-projects-with-only-sleeping-terminals
 *     - survivor-toolbar-and-accelerator-after-sibling-close
 *                                           -> survivor-toolbar-and-accelerator-after-sibling-close,
 *                                              terminal-manager-menu-reopens-it-beside-project-windows
 *     - cleanup-closes-every-shell          -> cleanup-closes-every-shell
 *     - detached-project-shell-lifecycle / -exclusivity / -reattach: no longer exist. Detaching
 *       a project out of a shared window has no meaning when every project already has its own
 *       window, so those rows are retired with the behaviour, not rewritten.
 *
 *   `migration` scenario (profile written by the shared-window layout):
 *     - migration.windows-reopen-for-the-presented-and-ledger-projects
 *     - migration.saved-tabs-document-upgraded-with-a-backup
 *     - migration.each-tab-lands-under-its-projects-owner
 *     - migration.restored-windows-hold-their-migrated-tabs-live
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

type Scenario = 'lifecycle' | 'migration';

/** Every row the lifecycle scenario must report, and the only ones it may report. */
const LIFECYCLE_ROWS: readonly string[] = [
  'window.boot-opens-only-the-terminal-manager',
  'window.open-project-creates-its-own-window',
  'window.duplicate-open-focuses-the-existing-window',
  'window.second-project-gets-a-second-window',
  'window.unknown-project-refused',
  'window.tabs-stay-in-their-own-window-and-keep-their-stamp',
  'window.split-layout-per-tab-survives-window-focus',
  'window.native-popup-inherits-tab-affiliation',
  'window.minimize-restore-keeps-window-target',
  'window.same-project-sessions-cannot-cross-invoke',
  'window.background-window-surface-and-capture-ready',
  'window.search-lists-the-tabs-of-every-window',
  'window.search-presents-the-tabs-own-window-without-authority-rotation',
  'window.search-stale-refusal-no-fallback',
  'window.five-project-windows-twenty-stamped-tabs',
  'window.close-project-window-keeps-the-others',
  'window.agent-ensure-opens-the-project-window-unpresented',
  'window.user-open-presents-and-restores-the-windows-own-tabs',
  'window.agent-visible-ensure-shows-the-window-without-focus',
  'window.user-open-starts-theme-watchers-and-agent-open-does-not',
  'window.user-created-window-starts-theme-watchers-after-its-first-terminal',
  'window.user-open-skips-a-watcher-already-running-in-a-plain-shell',
  'window.project-window-closes-when-its-last-running-terminal-sleeps',
  'window.last-visible-project-window-stays-when-its-last-terminal-sleeps',
  'window.project-window-closes-when-only-a-sync-watcher-keeps-running',
  'window.project-window-whose-only-terminals-are-sync-watchers-stays-open',
  'window.terminal-manager-close-closes-windows-of-projects-with-only-sleeping-terminals',
  'window.close-terminal-manager-keeps-project-windows',
  'window.survivor-toolbar-and-accelerator-after-sibling-close',
  'window.terminal-manager-menu-reopens-it-beside-project-windows',
  'window.cleanup-closes-every-shell',
];

/** Every row the migration scenario must report, and the only ones it may report. */
const MIGRATION_ROWS: readonly string[] = [
  'migration.windows-reopen-for-the-presented-and-ledger-projects',
  'migration.saved-tabs-document-upgraded-with-a-backup',
  'migration.each-tab-lands-under-its-projects-owner',
  'migration.restored-windows-hold-their-migrated-tabs-live',
  'migration.cleanup-closes-every-shell',
];

const ROWS_BY_SCENARIO: Record<Scenario, readonly string[]> = {
  lifecycle: LIFECYCLE_ROWS,
  migration: MIGRATION_ROWS,
};

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

const RUN_TIMEOUT_MS = 420_000;
// Evidence destination: every run rewrites one JSON receipt per scenario, so it MUST NOT
// silently target another plan's curated record. Callers pick a plan-owned path via
// ANTIFAN_E2E_EVIDENCE (absolute or repo-relative); the migration scenario writes beside it
// with `-migration` before the extension. The default writes to a gitignored scratch dir and is
// for run-verification only.
const EVIDENCE_PATH = process.env.ANTIFAN_E2E_EVIDENCE
  ? process.env.ANTIFAN_E2E_EVIDENCE
  : path.join('.probe-tmp', 'project-windows-e2e.json');

function evidencePathFor(scenario: Scenario): string {
  if (scenario === 'lifecycle') return EVIDENCE_PATH;
  const extension = path.extname(EVIDENCE_PATH);
  return `${EVIDENCE_PATH.slice(0, EVIDENCE_PATH.length - extension.length)}-${scenario}${extension}`;
}

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
  boot?: { ownerKeys: string[]; shellCount: number; terminalManagerTabs: number };
  firstOpen?: { status: string; ownerKey: string; windowId: number; shellCount: number };
  duplicateOpen?: { status: string; windowId: number; shellCount: number };
  secondOpen?: { status: string; ownerKey: string; windowId: number; shellCount: number };
  unknownProject?: { status: string; reason?: string };
  volume?: { shellCount: number; stampedCount: number; inventoryRows: number };
  teardown?: { shellCount: number };
  backgroundSurface?: { mode: string; workArea: { width: number; height: number } };
  backgroundCapture?: { bytes: number; rasterSize: { width: number; height: number } } | null;
  staleActivation?: { closedTab: { reasonCode: string } };
  closeManager?: { remaining: string[]; shellCount: number };
  closeProject?: { remaining: string[]; shellCount: number };
  survivorPaths?: { toolbarTab: string; acceleratorTab: string };
  agentEnsure?: {
    entry: { ownerKey: string; windowId: number };
    created: boolean;
    callsForWindow: unknown[];
    callsForOtherWindows: unknown[];
    visibleAfterEnsure: boolean;
    restoredTabCount: number;
    restoredLocalUrls: string[];
  };
  nativePopup?: {
    capsuleId: string;
    parentCapsuleId: string;
    projectId: string;
    partition: string;
    userAgentMode: string;
    parentUserAgentMode: string;
    hostOwnerKey: string;
  };
  minimizeRestore?: {
    minimized: { target: string | null; otherWindowTarget: string | null };
    restored: { target: string | null };
    invalidTarget: { requested: string; adopted: string | null };
    foreignTarget: { requested: string; adopted: string | null };
  };
  sameProjectSessions?: {
    tabOne: string;
    tabTwo: string;
    foreignTab: string;
    crossRefused: boolean;
    crossText: string;
    crossWriteRefused: boolean;
    crossWriteText: string;
    foreignWriteRefused: boolean;
    foreignWriteText: string;
    foreignReadRefused: boolean;
    foreignReadText: string;
    domReadsBeforeSibling: string[];
    domReads: string[];
    foreignTabNavigated: boolean;
  };
  migration?: {
    ownerKeys: string[];
    backupName: string | null;
    documentVersion: number | null;
    ownerRecords: Record<string, { urls: string[]; stamps: Array<string | null>; activeUrl: string | null }>;
    liveTabs: Record<string, { urls: string[]; stamps: Array<string | null>; activeUrl: string | null }>;
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

/** The scenarios that run inside the real Electron main process. */
const PROJECT_WINDOWS_DRIVER_SOURCE = `
'use strict';
const { app, BrowserWindow, Menu, screen } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');

app.commandLine.appendSwitch('no-sandbox');

const REPO_ROOT = process.env.ANTIFAN_DRIVER_REPO_ROOT || path.resolve(__dirname, '..');
const EVIDENCE_FILE = process.env.ANTIFAN_DRIVER_EVIDENCE || path.join(REPO_ROOT, 'project-windows-e2e.json');
const BRIDGE_PORT = process.env.ANTIFAN_DRIVER_BRIDGE_PORT || '';
const PAGE_PORT = process.env.ANTIFAN_DRIVER_PAGE_PORT || '';
const SCENARIO = process.env.ANTIFAN_DRIVER_SCENARIO || 'lifecycle';
const EXPECTED_ROWS = JSON.parse(process.env.ANTIFAN_DRIVER_EXPECTED_ROWS || '[]');
const SCENARIO_NAME = 'project-windows-' + SCENARIO;
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

// The pages every tab here loads. Served from this process on a loopback port the test picked,
// so a row decides on the app's behaviour and never on whether the machine is online.
const pageServer = http.createServer(function (request, response) {
  const name = String(request.url || '/').split('?')[0].replace('/', '') || 'index';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><html><head><title>' + name + '</title></head><body><h1>' + name + '</h1></body></html>');
});
pageServer.listen(Number(PAGE_PORT), '127.0.0.1');
const pageUrl = function (name) { return 'http://127.0.0.1:' + PAGE_PORT + '/' + name; };

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
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    path: dir,
  };
};
const ALPHA = makeProject('a1', 'Window Alpha');
const BETA = makeProject('b2', 'Window Beta');
const GAMMA = makeProject('c3', 'Window Gamma');
const DELTA = makeProject('d4', 'Window Delta');
const EPSILON = makeProject('e5', 'Window Epsilon');
const PROJECTS = [ALPHA, BETA, GAMMA, DELTA, EPSILON];
// No capsule describes this id: a project nothing in Main's records carries.
const UNRECORDED = { projectId: 'project-00000000-0000-4000-8000-0000000000f6' };
// The placeholder project the shared-window layout stamped onto rows it could not attribute.
const LEGACY_BOOT_PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';

process.env.ANTIFAN_DATA_ROOT = tempRoot;
process.env.ANTIFAN_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.ANTIFAN_USER_DATA = path.join(tempRoot, 'Profile');
process.env.ANTIFAN_USE_TERMINAL_DAEMON = '0';
if (BRIDGE_PORT) process.env.ANTIFAN_BRIDGE_PORT = BRIDGE_PORT;
// No project is named for the first window: the boot opens the windows the profile says were
// open, and a fresh profile opens only the Terminal Manager.
delete process.env.ANTIFAN_PROJECT_ID;
delete process.env.ANTIFAN_WORKSPACE_ID;

fs.mkdirSync(path.join(tempRoot, 'config'), { recursive: true });
fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });
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

// A profile as the shared-window layout left it: a document at version 2 whose 'web' record
// held tabs of several projects and named the project it was presenting, a detached project's
// own record, and the ledger of windows that were open at the last exit. The tab rows carry the
// ids and fields that layout wrote.
const LEGACY_ROWS = {
  w1: { project: ALPHA },
  w2: { project: BETA },
  w3: { project: ALPHA },
  w4: { project: null },
  w5: { project: { projectId: LEGACY_BOOT_PROJECT_ID } },
};
const legacyRow = function (name, project) {
  const row = { id: 'legacy-' + name, url: pageUrl('legacy-' + name), title: 'legacy ' + name };
  if (project) row.projectId = project.projectId;
  return row;
};
let seededSavedTabsText = '';
if (SCENARIO === 'migration') {
  const owners = {};
  owners.web = {
    tabs: Object.keys(LEGACY_ROWS).map(function (name) { return legacyRow(name, LEGACY_ROWS[name].project); }),
    activeTabId: 'legacy-w3',
    activeProjectId: ALPHA.projectId,
    updatedAt: 1000,
  };
  owners['project:' + GAMMA.projectId] = {
    tabs: [legacyRow('d1', GAMMA)],
    activeTabId: 'legacy-d1',
    detached: true,
    updatedAt: 900,
  };
  seededSavedTabsText = JSON.stringify({ version: 2, updatedAt: 1000, owners: owners }, null, 2);
  fs.writeFileSync(path.join(process.env.ANTIFAN_USER_DATA, 'saved-tabs.json'), seededSavedTabsText, 'utf8');
  // BETA's window was open at the last exit; GAMMA's was detached once and is not in the ledger;
  // the last key names a project nothing in Main's records carries.
  fs.writeFileSync(
    path.join(process.env.ANTIFAN_USER_DATA, 'open-windows.json'),
    JSON.stringify({ version: 1, owners: ['project:' + BETA.projectId, 'project:' + UNRECORDED.projectId] }, null, 2),
    'utf8',
  );
}

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
const keyOf = function (project) { return 'project:' + project.projectId; };
const hostOf = function (project) { return authority.hostForOwner(keyOf(project)); };
const entryFor = function (project) { return entryOf(authority.snapshot(), keyOf(project)); };
const ownerKeys = function () {
  return authority.snapshot().map(function (entry) { return entry.ownerKey; }).sort();
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
const bringForward = function (window) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
};
// The pages this driver serves. A window with no saved tabs opens one fallback page of its own
// on the public web; rows that compare restored tabs compare the pages this driver minted.
const localTabUrls = function (host) {
  return host.getTabList()
    .map(function (tab) { return tab.url; })
    .filter(function (url) { return typeof url === 'string' && url.indexOf(pageUrl('')) === 0; })
    .sort();
};

/**
 * A chrome surface of one window, once its renderer answers: the toolbar the user mints tabs
 * from, or the sidebar the user opens projects from. Every window carries both.
 */
async function chromeOf(ownerKeyValue, surface) {
  const shell = authority.shellFor(ownerKeyValue);
  expect(shell, 'no shell is open for ' + ownerKeyValue);
  const contents = surfaceOf(shell, surface);
  expect(contents, ownerKeyValue + ' has no ' + surface + ' surface');
  if (surface === 'toolbar') {
    await waitForApi(contents, "typeof window.antifanToolbar === 'object' && typeof window.antifanToolbar.createTab === 'function'");
  } else {
    await waitForApi(contents, "typeof window.antifanStandalone === 'object' && typeof window.antifanStandalone.openProject === 'function'");
  }
  return contents;
}
const toolbarOf = function (project) { return chromeOf(keyOf(project), 'toolbar'); };
const toolbarCall = async function (project, expression) {
  const toolbar = await toolbarOf(project);
  return toolbar.executeJavaScript(expression, true);
};

/**
 * Mint one tab through a window's own toolbar, the way its user does, loading a page this
 * driver serves. The tab is minted by that window's host and nowhere else.
 */
async function createTabIn(project, name) {
  const tabId = await toolbarCall(project, 'window.antifanToolbar.createTab(' + JSON.stringify(pageUrl(name)) + ')');
  expect(typeof tabId === 'string' && tabId.length > 0, project.name + ' created no tab for ' + name + ': ' + JSON.stringify(tabId));
  return tabId;
}

/**
 * Open one project the way its opening surface does: through a window's sidebar, the route a
 * user's click takes. The Terminal Manager's sidebar is used while it is open, any other
 * window's once it is closed. The open has landed when the project's own window is presented.
 */
async function openProjectFromSidebar(project) {
  const from = authority.shellFor('unassigned') ? 'unassigned' : authority.snapshot()[0].ownerKey;
  const sidebar = await chromeOf(from, 'sidebar');
  const result = await sidebar.executeJavaScript(
    'window.antifanStandalone.openProject(' + JSON.stringify(project.projectId) + ')',
    true,
  );
  if (!result || (result.status !== 'OPENED' && result.status !== 'FOCUSED')) {
    return { result: result, entry: null };
  }
  const entry = await waitFor(
    function () {
      const current = entryFor(project);
      return current && current.visible === true ? current : false;
    },
    'the window of ' + project.name + ' to be presented',
  );
  return { result: result, entry: entry };
}

async function waitForBootComplete() {
  // The deferred bridge listener comes up after the whole boot leg: the startup window, every
  // restored project window and the Terminal Manager restore. A window the boot still owes
  // cannot be told from a window it will never open until that listener answers.
  await waitFor(
    function () {
      const answered = Promise.withResolvers();
      const socket = net.connect({ host: '127.0.0.1', port: Number(BRIDGE_PORT) });
      socket.once('connect', function () { socket.destroy(); answered.resolve(true); });
      socket.once('error', function () { socket.destroy(); answered.resolve(false); });
      return answered.promise;
    },
    'the boot to reach its bridge listener',
    60000,
  );
}

async function closeWindowAndWait(ownerKeyValue) {
  const before = authority.windowFor(ownerKeyValue);
  expect(before && !before.isDestroyed(), ownerKeyValue + ' has no native window to close');
  expect(authority.requestClose(ownerKeyValue) === true, 'the close request never reached ' + ownerKeyValue);
  await waitFor(
    function () { return authority.hostForOwner(ownerKeyValue) === null && !entryOf(authority.snapshot(), ownerKeyValue); },
    ownerKeyValue + ' to leave the directory',
  );
  expect(before.isDestroyed() === true, "the closed window's native window survived");
}

const legacyEnvelope = function () {
  const dir = process.env.ANTIFAN_USER_DATA;
  return { dir: dir, saved: path.join(dir, 'saved-tabs.json'), ledger: path.join(dir, 'open-windows.json') };
};
const readJson = function (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
// Scenario: lifecycle
// ---------------------------------------------------------------------------------------------
async function runLifecycle() {
  let tabA1 = null;
  let tabA2 = null;
  let tabB1 = null;
  let tabB2 = null;
  let managerWindowBeforeClose = null;
  let windowIdOf = {};

  // ---------------- (1) a profile with no saved state opens the Terminal Manager and nothing else
  await check('window.boot-opens-only-the-terminal-manager', async function () {
    await waitForBootComplete();
    const snapshot = authority.snapshot();
    const keys = ownerKeys();
    observations.boot = {
      ownerKeys: keys,
      shellCount: authority.browserShellCount(),
      terminalManagerTabs: 0,
    };
    expect(JSON.stringify(keys) === JSON.stringify(['unassigned']), 'the boot opened windows ' + JSON.stringify(keys));
    expect(authority.browserShellCount() === 1, 'browserShellCount() was ' + authority.browserShellCount());
    const manager = snapshot[0];
    expect(manager.owner.kind === 'unassigned', 'the startup owner kind was ' + String(manager.owner.kind));
    expect(manager.hostOwnerKey === 'unassigned', 'the startup host key was ' + String(manager.hostOwnerKey));
    expect(manager.visible === true, 'the Terminal Manager was never presented');
    // The Terminal Manager hosts no browser tabs.
    observations.boot.terminalManagerTabs = manager.tabIds.length;
    expect(manager.tabIds.length === 0, 'the Terminal Manager holds tabs: ' + JSON.stringify(manager.tabIds));
    // There is no shared 'web' window and no window for any seeded project.
    expect(authority.shellFor('web') === null && authority.windowFor('web') === null, "a 'web' shell exists");
    expect(authority.hostForOwner('web') === null, "a 'web' host exists");
    for (const project of PROJECTS) {
      expect(authority.shellFor(keyOf(project)) === null, 'a window exists for ' + project.name + ' before anyone opened it');
    }
    expect(
      authority.shellFor('project:' + LEGACY_BOOT_PROJECT_ID) === null,
      'a window exists for the placeholder boot project',
    );
    const window = authority.windowFor('unassigned');
    expect(window && !window.isDestroyed(), 'the Terminal Manager has no live native window');
    await chromeOf('unassigned', 'toolbar');
    await chromeOf('unassigned', 'sidebar');
    // The ledger records the one window that opened.
    const ledger = await waitFor(
      function () {
        const parsed = readJson(legacyEnvelope().ledger);
        return parsed && Array.isArray(parsed.owners) ? parsed : false;
      },
      'the open-window ledger',
    );
    expect(JSON.stringify(ledger.owners) === JSON.stringify(['unassigned']), 'the ledger lists ' + JSON.stringify(ledger.owners));
    windowIdOf.unassigned = manager.windowId;
    managerWindowBeforeClose = window;
  });

  // ------------------------------------ (2) opening a project opens that project's own window
  await check('window.open-project-creates-its-own-window', async function () {
    const opened = await openProjectFromSidebar(ALPHA);
    expect(opened.result && opened.result.status === 'OPENED', 'the first open returned ' + JSON.stringify(opened.result));
    const entry = opened.entry;
    windowIdOf.alpha = entry.windowId;
    observations.firstOpen = {
      status: opened.result.status,
      ownerKey: entry.ownerKey,
      windowId: entry.windowId,
      shellCount: authority.browserShellCount(),
    };
    expect(entry.windowId !== windowIdOf.unassigned, "the project reused the Terminal Manager's window");
    expect(entry.owner.kind === 'project' && entry.owner.projectId === ALPHA.projectId, 'the owner was ' + JSON.stringify(entry.owner));
    expect(entry.hostOwnerKey === keyOf(ALPHA), 'the window host key was ' + String(entry.hostOwnerKey));
    expect(entry.title === ALPHA.name, 'the window title was ' + String(entry.title));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount());
    expect(ownerKeys().indexOf('web') === -1, "a 'web' window appeared");
    const host = hostOf(ALPHA);
    expect(host, 'the project window has no host');
    // The window runs in its own verified workspace, never another project's or the process's.
    const affiliation = host.getWindowWorkspaceAffiliation();
    expect(affiliation && samePath(affiliation.workspacePath, ALPHA.path), 'the window workspace was ' + JSON.stringify(affiliation));
    expect(samePath(entry.terminalCwd, ALPHA.path), 'the terminal working directory was ' + String(entry.terminalCwd));
    expect(entry.identity.owner.kind === 'project' && entry.identity.owner.projectId === ALPHA.projectId, 'the identity owner was ' + JSON.stringify(entry.identity.owner));
    // The window always has a page of its own, minted by its own host under its own stamp.
    await waitFor(function () { return host.getTabList().length > 0; }, "the project window's first tab");
    for (const tab of host.getTabList()) {
      expect(tab.projectId === ALPHA.projectId, 'a first-window tab carried stamp ' + String(tab.projectId));
    }
    await chromeOf(keyOf(ALPHA), 'toolbar');
    await chromeOf(keyOf(ALPHA), 'sidebar');
    // Opening a project did not disturb the Terminal Manager.
    expect(authority.windowFor('unassigned') === managerWindowBeforeClose, 'the Terminal Manager window changed');
    expect(entryOf(authority.snapshot(), 'unassigned').tabIds.length === 0, 'the Terminal Manager gained a tab');
  });

  // ------------------------------- (3) opening it again focuses the window it already has
  await check('window.duplicate-open-focuses-the-existing-window', async function () {
    const alphaWindow = authority.windowFor(keyOf(ALPHA));
    alphaWindow.minimize();
    await waitFor(function () { return alphaWindow.isMinimized() === true; }, 'the project window to minimize');
    const again = await openProjectFromSidebar(ALPHA);
    observations.duplicateOpen = {
      status: again.result && again.result.status,
      windowId: again.entry && again.entry.windowId,
      shellCount: authority.browserShellCount(),
    };
    expect(again.result && again.result.status === 'FOCUSED', 'the duplicate open returned ' + JSON.stringify(again.result));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount() + ' after the duplicate open');
    expect(again.entry.windowId === windowIdOf.alpha, 'the duplicate open presented window ' + String(again.entry.windowId));
    await waitFor(function () { return alphaWindow.isMinimized() === false && alphaWindow.isVisible() === true; }, 'the minimized window to be brought back');
    expect(authority.windowFor(keyOf(ALPHA)) === alphaWindow, 'the project window was replaced');
    expect(ownerKeys().join('|') === ['project:' + ALPHA.projectId, 'unassigned'].sort().join('|'), 'the duplicate open changed the window set: ' + JSON.stringify(ownerKeys()));
  });

  // ------------------------------------------ (4) a second project gets a second window
  await check('window.second-project-gets-a-second-window', async function () {
    const opened = await openProjectFromSidebar(BETA);
    expect(opened.result && opened.result.status === 'OPENED', 'the second open returned ' + JSON.stringify(opened.result));
    const entry = opened.entry;
    windowIdOf.beta = entry.windowId;
    observations.secondOpen = {
      status: opened.result.status,
      ownerKey: entry.ownerKey,
      windowId: entry.windowId,
      shellCount: authority.browserShellCount(),
    };
    expect(authority.browserShellCount() === 3, 'browserShellCount() was ' + authority.browserShellCount());
    expect(entry.windowId !== windowIdOf.alpha && entry.windowId !== windowIdOf.unassigned, 'the second project shares a window');
    expect(entry.ownerKey === keyOf(BETA) && entry.title === BETA.name, 'the second window was ' + JSON.stringify([entry.ownerKey, entry.title]));
    const beta = hostOf(BETA);
    const alpha = hostOf(ALPHA);
    expect(beta && alpha && beta !== alpha, 'the two project windows share one host');
    // The first window is exactly as it was: same native window, same host, its own workspace.
    const alphaEntry = entryFor(ALPHA);
    expect(alphaEntry.windowId === windowIdOf.alpha, 'the first window changed identity');
    expect(samePath(alpha.getWindowWorkspaceAffiliation().workspacePath, ALPHA.path), "the first window's workspace moved");
    expect(samePath(beta.getWindowWorkspaceAffiliation().workspacePath, BETA.path), "the second window's workspace was " + JSON.stringify(beta.getWindowWorkspaceAffiliation()));
    await waitFor(function () { return beta.getTabList().length > 0; }, "the second window's first tab");
    for (const tab of beta.getTabList()) {
      expect(tab.projectId === BETA.projectId, 'a second-window tab carried stamp ' + String(tab.projectId));
    }
  });

  // ------------------------------------------------------------- (5) unknown project refused
  await check('window.unknown-project-refused', async function () {
    const sidebar = await chromeOf('unassigned', 'sidebar');
    const before = ownerKeys();
    const refused = await sidebar.executeJavaScript(
      "window.antifanStandalone.openProject('project-00000000-0000-4000-8000-0000000000ff')",
      true,
    );
    observations.unknownProject = refused;
    expect(refused && refused.status === 'FAILED', 'an unknown project returned ' + JSON.stringify(refused));
    expect(refused.reason === 'UNKNOWN_PROJECT', 'an unknown project reported ' + String(refused.reason));
    // A project nothing records is refused here too, even though a window could be minted for it.
    const unrecorded = await sidebar.executeJavaScript(
      'window.antifanStandalone.openProject(' + JSON.stringify(UNRECORDED.projectId) + ')',
      true,
    );
    expect(unrecorded && unrecorded.status === 'FAILED' && unrecorded.reason === 'UNKNOWN_PROJECT', 'an unrecorded project returned ' + JSON.stringify(unrecorded));
    expect(authority.browserShellCount() === 3, 'browserShellCount() was ' + authority.browserShellCount() + ' after a refused open');
    expect(JSON.stringify(ownerKeys()) === JSON.stringify(before), 'a refused open changed the windows: ' + JSON.stringify(ownerKeys()));
  });

  // -------- (6) tabs stay in the window that minted them, under that project's stamp
  await check('window.tabs-stay-in-their-own-window-and-keep-their-stamp', async function () {
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    tabA1 = await createTabIn(ALPHA, 'a1');
    tabA2 = await createTabIn(ALPHA, 'a2');
    tabB1 = await createTabIn(BETA, 'b1');
    tabB2 = await createTabIn(BETA, 'b2');

    const alphaTabs = alpha.getTabList();
    const betaTabs = beta.getTabList();
    observations.projectStamps = {
      alpha: alphaTabs.map(function (tab) { return [tab.id, tab.projectId]; }),
      beta: betaTabs.map(function (tab) { return [tab.id, tab.projectId]; }),
    };
    for (const tab of alphaTabs) expect(tab.projectId === ALPHA.projectId, 'tab ' + tab.id + ' in the first window carries ' + String(tab.projectId));
    for (const tab of betaTabs) expect(tab.projectId === BETA.projectId, 'tab ' + tab.id + ' in the second window carries ' + String(tab.projectId));
    for (const tabId of [tabA1, tabA2]) {
      expect(alpha.hasExactTab(tabId) && !beta.hasExactTab(tabId), 'tab ' + tabId + ' is not exclusively in the first window');
      expect(authority.hostForTab(tabId) === alpha, 'tab ' + tabId + ' does not route to the first window');
    }
    for (const tabId of [tabB1, tabB2]) {
      expect(beta.hasExactTab(tabId) && !alpha.hasExactTab(tabId), 'tab ' + tabId + ' is not exclusively in the second window');
      expect(authority.hostForTab(tabId) === beta, 'tab ' + tabId + ' does not route to the second window');
    }
    const snapshot = authority.snapshot();
    const alphaIds = entryOf(snapshot, keyOf(ALPHA)).tabIds;
    const betaIds = entryOf(snapshot, keyOf(BETA)).tabIds;
    expect(alphaIds.indexOf(tabA1) !== -1 && alphaIds.indexOf(tabA2) !== -1, 'the first window does not list its tabs: ' + JSON.stringify(alphaIds));
    expect(betaIds.indexOf(tabB1) !== -1 && betaIds.indexOf(tabB2) !== -1, 'the second window does not list its tabs: ' + JSON.stringify(betaIds));
    expect(alphaIds.every(function (id) { return betaIds.indexOf(id) === -1; }), 'the two windows list a tab in common');
    expect(entryOf(snapshot, 'unassigned').tabIds.length === 0, 'the Terminal Manager gained a tab');

    // One window, one active tab: choosing a tab in one window never moves the other's.
    const betaActiveBefore = beta.getActiveTabId();
    expect(await toolbarCall(ALPHA, 'window.antifanToolbar.switchTab(' + JSON.stringify(tabA1) + ')') === true, 'the first window refused to select ' + tabA1);
    expect(alpha.getActiveTabId() === tabA1, 'the first window active tab was ' + alpha.getActiveTabId());
    expect(await toolbarCall(ALPHA, 'window.antifanToolbar.switchTab(' + JSON.stringify(tabA2) + ')') === true, 'the first window refused its second selection');
    expect(alpha.getActiveTabId() === tabA2, 'the first window did not move to ' + tabA2);
    expect(beta.getActiveTabId() === betaActiveBefore, "selecting in the first window moved the second window's active tab to " + beta.getActiveTabId());
    expect(await toolbarCall(BETA, 'window.antifanToolbar.switchTab(' + JSON.stringify(tabB2) + ')') === true, 'the second window refused to select ' + tabB2);
    expect(beta.getActiveTabId() === tabB2, 'the second window active tab was ' + beta.getActiveTabId());
    expect(alpha.getActiveTabId() === tabA2, "selecting in the second window moved the first window's active tab to " + alpha.getActiveTabId());

    // A window cannot select a tab it does not own.
    const foreign = await toolbarCall(ALPHA, 'window.antifanToolbar.switchTab(' + JSON.stringify(tabB1) + ')');
    observations.foreignSelect = foreign;
    expect(foreign !== true, "the first window selected the second window's tab");
    expect(alpha.getActiveTabId() === tabA2, 'a refused foreign select moved the first window to ' + alpha.getActiveTabId());
    expect(beta.getActiveTabId() === tabB2, 'a refused foreign select moved the second window to ' + beta.getActiveTabId());
  });

  // ------------------- (7) split layout is per tab and survives switching focus between windows
  await check('window.split-layout-per-tab-survives-window-focus', async function () {
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    const tabStateOf = function (host, tabId) {
      return host.getTabList().find(function (candidate) { return candidate.id === tabId; }) || null;
    };

    expect(await toolbarCall(ALPHA, 'window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabA2) + ', true)') === true, 'the first window refused to split ' + tabA2);
    expect(await toolbarCall(ALPHA, "window.antifanToolbar.setSplitPreset('mobile', 'ipad-mini', " + JSON.stringify(tabA2) + ')') === true, 'the first window refused its mobile preset');
    expect(await toolbarCall(ALPHA, "window.antifanToolbar.setSplitPreset('desktop', 'laptop-macbook13', " + JSON.stringify(tabA2) + ')') === true, 'the first window refused its desktop preset');
    expect(await toolbarCall(ALPHA, "window.antifanToolbar.setSplitFocusedPane('desktop', " + JSON.stringify(tabA2) + ')') === true, 'the first window refused its focused pane');
    expect(await toolbarCall(BETA, 'window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabB2) + ', true)') === true, 'the second window refused to split ' + tabB2);
    expect(await toolbarCall(BETA, "window.antifanToolbar.setSplitPreset('mobile', 'mobile-small', " + JSON.stringify(tabB2) + ')') === true, 'the second window refused its mobile preset');
    expect(await toolbarCall(BETA, "window.antifanToolbar.setSplitFocusedPane('mobile', " + JSON.stringify(tabB2) + ')') === true, 'the second window refused its focused pane');

    const alphaTab = await waitFor(function () {
      const tab = tabStateOf(alpha, tabA2);
      return tab && tab.splitMode === true ? tab : false;
    }, "the first window tab's split state");
    const betaTab = await waitFor(function () {
      const tab = tabStateOf(beta, tabB2);
      return tab && tab.splitMode === true ? tab : false;
    }, "the second window tab's split state");
    expect(alphaTab.splitMobilePresetId === 'ipad-mini' && alphaTab.splitDesktopPresetId === 'laptop-macbook13' && alphaTab.splitFocusedPane === 'desktop', 'the first window split state was ' + JSON.stringify([alphaTab.splitMobilePresetId, alphaTab.splitDesktopPresetId, alphaTab.splitFocusedPane]));
    expect(betaTab.splitMobilePresetId === 'mobile-small' && betaTab.splitFocusedPane === 'mobile', 'the second window split state was ' + JSON.stringify([betaTab.splitMobilePresetId, betaTab.splitFocusedPane]));
    expect(tabStateOf(alpha, tabA1).splitMode !== true, 'the unsplit first window tab reports split mode');
    expect(tabStateOf(beta, tabB1).splitMode !== true, 'the unsplit second window tab reports split mode');

    const alphaMobile = alpha.getTabContentBounds(tabA2, 'mobile');
    const betaMobile = beta.getTabContentBounds(tabB2, 'mobile');
    expect(alphaMobile && alphaMobile.width > 0 && alphaMobile.height > 0, "the first window's mobile pane has no geometry: " + JSON.stringify(alphaMobile));
    expect(betaMobile && betaMobile.width > 0 && betaMobile.height > 0, "the second window's mobile pane has no geometry: " + JSON.stringify(betaMobile));
    const activeBefore = { alpha: alpha.getActiveTabId(), beta: beta.getActiveTabId() };

    // Focus moves between the windows, by the user's own routes: the native window, then the
    // project open that brings an existing window forward.
    for (const project of [ALPHA, BETA, ALPHA]) {
      bringForward(authority.windowFor(keyOf(project)));
      const reopened = await openProjectFromSidebar(project);
      expect(reopened.result && reopened.result.status === 'FOCUSED', 'focusing ' + project.name + ' returned ' + JSON.stringify(reopened.result));
    }
    expect(alpha.getActiveTabId() === activeBefore.alpha && beta.getActiveTabId() === activeBefore.beta, 'switching window focus moved an active tab');
    expect(tabStateOf(alpha, tabA2).splitMode === true && tabStateOf(alpha, tabA2).splitMobilePresetId === 'ipad-mini', 'the first window lost its split layout when focus moved');
    expect(tabStateOf(beta, tabB2).splitMode === true && tabStateOf(beta, tabB2).splitMobilePresetId === 'mobile-small', 'the second window lost its split layout when focus moved');
    const alphaMobileAfterFocus = alpha.getTabContentBounds(tabA2, 'mobile');
    const betaMobileAfterFocus = beta.getTabContentBounds(tabB2, 'mobile');
    expect(alphaMobileAfterFocus && alphaMobileAfterFocus.width === alphaMobile.width, "the first window's pane moved to " + JSON.stringify(alphaMobileAfterFocus) + ' when focus moved');
    expect(betaMobileAfterFocus && betaMobileAfterFocus.width === betaMobile.width, "the second window's pane moved to " + JSON.stringify(betaMobileAfterFocus) + ' when focus moved');

    // A preset change in one window moves its own geometry; the other window's does not.
    expect(await toolbarCall(BETA, "window.antifanToolbar.setSplitPreset('mobile', 'ipad-mini', " + JSON.stringify(tabB2) + ')') === true, 'the second window refused the second mobile preset');
    const betaMobileChanged = await waitFor(function () {
      const bounds = beta.getTabContentBounds(tabB2, 'mobile');
      return bounds && bounds.width > 0 && bounds.width !== betaMobile.width ? bounds : false;
    }, "the second window's mobile pane to follow its own new preset", 8000);
    observations.splitGeometry = { alphaMobile: alphaMobile.width, betaMobileBefore: betaMobile.width, betaMobileAfter: betaMobileChanged.width };
    expect(alpha.getTabContentBounds(tabA2, 'mobile').width === alphaMobile.width, "the first window's pane moved when the second window changed its preset");

    // Turning the first window tab's split off leaves the second window's split exactly where it was.
    expect(await toolbarCall(ALPHA, 'window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabA2) + ', false)') === false, 'the first window reported split mode still on');
    expect(tabStateOf(alpha, tabA2).splitMode !== true, 'the first window tab is still in split mode');
    const betaAfter = tabStateOf(beta, tabB2);
    expect(betaAfter.splitMode === true && betaAfter.splitMobilePresetId === 'ipad-mini', "disabling the first window's split disturbed the second window's: " + JSON.stringify([betaAfter.splitMode, betaAfter.splitMobilePresetId]));
    expect(beta.getTabContentBounds(tabB2, 'mobile').width === betaMobileChanged.width, "the second window's pane moved when the first window left split mode");
    // The row leaves the second window tab whole for the rows that follow.
    expect(await toolbarCall(BETA, 'window.antifanToolbar.toggleSplitReview(' + JSON.stringify(tabB2) + ', false)') === false, 'the second window reported split mode still on');
  });

  // ----------------- (8) a native window.open popup belongs to its own tab, in its own window
  let popupChildId = null;
  let activeCapsuleBeforePopup = null;
  await check('window.native-popup-inherits-tab-affiliation', async function () {
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    bringForward(authority.windowFor(keyOf(ALPHA)));
    // The opener is presented first. A background tab's renderer does not run script in this
    // build, so opening the popup from an unpresented tab would decide this row on the tab's
    // rendering state instead of on what the popup inherits.
    alpha.switchTab(tabA1, { plane: 'user' });
    await waitFor(function () { return alpha.getActiveTabId() === tabA1; }, 'the first window to present the tab the popup is opened from');
    const parentTab = alpha.getTabList().find(function (candidate) { return candidate.id === tabA1; });
    expect(parentTab, 'the first window lost its parent tab ' + tabA1);
    const parentContents = alpha.getTabWebContents(tabA1, 'desktop');
    expect(parentContents && !parentContents.isDestroyed(), 'the parent tab has no page to open a popup from');
    await waitFor(function () {
      return parentContents.executeJavaScript("document.readyState === 'complete'", true).catch(function () { return false; });
    }, 'the opener page to finish loading');
    const tabsBefore = alpha.getTabList().map(function (tab) { return tab.id; });
    const betaTabsBefore = beta.getTabList().map(function (tab) { return tab.id; });

    // Make this row discriminating, not just passing. The process-wide active capsule is
    // rotated to the other window's project for the duration of the popup and restored in
    // cleanup: a child that consults global state lands in that capsule and fails the
    // assertions below, while one that reads its own parent keeps its capsule.
    const capsuleManager = alpha.capsuleManager;
    activeCapsuleBeforePopup = capsuleManager && capsuleManager.getActive() ? capsuleManager.getActive().id : null;
    capsuleManager.switchTo(BETA.capsuleId);
    expect(capsuleManager.getActive() && capsuleManager.getActive().id === BETA.capsuleId, 'the active capsule could not be rotated to ' + BETA.capsuleId);

    const popupUrl = pageUrl('native-popup');
    // The page's window.open result is recorded, never awaited: the product denies the native
    // window and opens the popup as a tab, so the page sees null either way, and this Chromium
    // build sometimes never settles the evaluate promise for exactly that denied call.
    observations.nativePopupOpen = { parentTabId: tabA1, windowOpenResult: 'UNSETTLED' };
    parentContents
      .executeJavaScript("String(window.open('" + popupUrl + "', '_blank'))", true)
      .then(function (value) { observations.nativePopupOpen = { parentTabId: tabA1, windowOpenResult: value }; })
      .catch(function (err) { observations.nativePopupOpen = { parentTabId: tabA1, windowOpenError: messageOf(err) }; });

    const child = await waitFor(function () {
      for (const tab of alpha.getTabList()) {
        if (tabsBefore.indexOf(tab.id) !== -1) continue;
        if (tab.url !== popupUrl) continue;
        return { tab: tab, lineage: alpha.getTabLineage(tab.id) };
      }
      return false;
    }, 'the native popup to be adopted as a tab of its opener window');
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
      hostOwnerKey: authority.hostForTab(child.tab.id) ? authority.hostForTab(child.tab.id).windowOwnerKey() : '',
      activeCapsuleDuringPopup: capsuleManager.getActive() ? capsuleManager.getActive().id : null,
      activeCapsuleBeforePopup: activeCapsuleBeforePopup,
    };
    // A lineage is recorded only for a child adopted into a terminal session's pool; this
    // row's parent is a plain user tab, so an absent lineage is the honest state here.
    if (child.lineage) {
      expect(child.lineage.parentTabId === tabA1, 'the popup lineage named parent ' + String(child.lineage.parentTabId));
    }
    expect(alpha.hasTab(child.tab.id), 'the popup tab is not owned by its opener window');
    expect(authority.hostForTab(child.tab.id) === alpha, 'the popup tab does not route to its opener window');
    expect(!beta.hasTab(child.tab.id), 'the popup landed in the other project window');
    expect(beta.getTabList().length === betaTabsBefore.length, 'the other project window gained a tab');
    // Inheritance: the child carries its parent tab's own verified capsule, project stamp,
    // partition and user agent mode — never the global active capsule this row rotated.
    expect(child.tab.capsuleId === parentTab.capsuleId, 'the popup capsule was ' + String(child.tab.capsuleId) + ' while its parent carried ' + String(parentTab.capsuleId));
    expect(child.tab.capsuleId !== BETA.capsuleId, 'the popup inherited the globally active capsule ' + BETA.capsuleId + ' instead of its parent');
    expect(child.tab.projectId === parentTab.projectId && child.tab.projectId === ALPHA.projectId, 'the popup project stamp was ' + String(child.tab.projectId) + ' while its parent carried ' + String(parentTab.projectId));
    expect(child.tab.partition === parentTab.partition, 'the popup partition was ' + String(child.tab.partition) + ' while its parent ran in ' + String(parentTab.partition));
    expect(typeof child.tab.partition === 'string' && child.tab.partition.indexOf('persist:') === 0, 'the popup ran in an unassigned partition: ' + String(child.tab.partition));
    expect(child.tab.userAgentMode === 'clean' || child.tab.userAgentMode === 'native', 'the popup user agent mode was unassigned: ' + String(child.tab.userAgentMode));
    expect(child.tab.userAgentMode === parentTab.userAgentMode, 'the popup user agent mode was ' + String(child.tab.userAgentMode) + ' while its parent was ' + String(parentTab.userAgentMode));

    // Leave the run as this row found it: the popup is closed through its own window's toolbar
    // and the rotation is put back, so the tab-count rows later in this scenario stay exact.
    expect(await toolbarCall(ALPHA, 'window.antifanToolbar.closeTab(' + JSON.stringify(child.tab.id) + ')') === true, 'the window refused to close its own popup tab ' + child.tab.id);
    await waitFor(function () { return alpha.hasExactTab(child.tab.id) === false; }, 'the window to drop the closed popup tab');
    alpha.switchTab(tabA2, { plane: 'user' });
    expect(alpha.getTabList().length === tabsBefore.length, 'the window kept ' + alpha.getTabList().length + ' tabs instead of ' + tabsBefore.length);
    capsuleManager.switchTo(activeCapsuleBeforePopup);
    expect(capsuleManager.getActive() && capsuleManager.getActive().id === activeCapsuleBeforePopup, 'the active capsule was not restored after the popup row');
  }, async function () {
    // Whatever happened above, no later row inherits a popup tab this row opened and left, or
    // the capsule rotation this row made.
    const alpha = hostOf(ALPHA);
    if (alpha && alpha.capsuleManager && activeCapsuleBeforePopup) {
      try {
        alpha.capsuleManager.switchTo(activeCapsuleBeforePopup);
      } catch (err) {
        console.log('  NOTE  the active capsule could not be restored during cleanup: ' + messageOf(err));
      }
    }
    if (alpha && popupChildId !== null && alpha.hasExactTab(popupChildId)) {
      try {
        await toolbarCall(ALPHA, 'window.antifanToolbar.closeTab(' + JSON.stringify(popupChildId) + ')');
        await waitFor(function () { return alpha.hasExactTab(popupChildId) === false; }, 'the popup tab to be gone', 5000);
      } catch (err) {
        console.log('  NOTE  the popup tab could not be closed during cleanup: ' + messageOf(err));
      }
    }
    if (alpha && tabA2) alpha.switchTab(tabA2, { plane: 'user' });
  });

  // ------- (9) minimize/restore keeps a window's target and refuses one it does not own
  await check('window.minimize-restore-keeps-window-target', async function () {
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    const alphaWindow = authority.windowFor(keyOf(ALPHA));
    expect(alphaWindow && !alphaWindow.isDestroyed(), 'the first window has no native window');
    alpha.setAutomationTabId(tabA2);
    beta.setAutomationTabId(tabB1);
    expect(alpha.getAutomationTabId() === tabA2, 'the first window refused its own tab ' + tabA2 + ' as its target');
    expect(beta.getAutomationTabId() === tabB1, 'the second window refused its own tab ' + tabB1 + ' as its target');

    alphaWindow.minimize();
    await waitFor(function () { return alphaWindow.isMinimized() === true; }, 'the first window to minimize');
    const minimized = { target: alpha.getAutomationTabId(), otherWindowTarget: beta.getAutomationTabId() };
    expect(minimized.target === tabA2, 'minimizing the window moved its target to ' + String(minimized.target));
    expect(minimized.otherWindowTarget === tabB1, "minimizing one window moved the other window's target to " + String(minimized.otherWindowTarget));

    alphaWindow.restore();
    await waitFor(function () { return alphaWindow.isMinimized() === false && alphaWindow.isVisible() === true; }, 'the first window to restore');
    const restored = { target: alpha.getAutomationTabId() };
    expect(restored.target === tabA2, 'restoring the window rotated its target to ' + String(restored.target));
    expect(beta.getAutomationTabId() === tabB1, "restoring one window moved the other window's target");

    // A tab this host does not own can never become its target: the host clears rather than
    // adopting, so no silent authority rotation is possible — not for a tab nobody owns, and not
    // for a tab another window owns.
    alpha.setAutomationTabId('tab-that-belongs-to-no-host');
    const afterInvalid = alpha.getAutomationTabId();
    alpha.setAutomationTabId(tabA2);
    alpha.setAutomationTabId(tabB1);
    const afterForeign = alpha.getAutomationTabId();
    observations.minimizeRestore = {
      minimized: minimized,
      restored: restored,
      invalidTarget: { requested: 'tab-that-belongs-to-no-host', adopted: afterInvalid },
      foreignTarget: { requested: tabB1, adopted: afterForeign },
    };
    expect(afterInvalid === null, 'a refused target left ' + String(afterInvalid) + ' instead of clearing');
    expect(afterForeign === null, "the first window adopted the second window's tab as its target: " + String(afterForeign));
    expect(beta.getAutomationTabId() === tabB1, "a refused foreign target disturbed the second window's target");
    alpha.setAutomationTabId(tabA2);
    expect(alpha.getAutomationTabId() === tabA2, 'the window could not take its own tab back as target');
  });

  // ------- (10) two sessions in one project share read scope but cannot cross-mutate
  await check('window.same-project-sessions-cannot-cross-invoke', async function () {
    const alpha = hostOf(ALPHA);
    const controlPlane = authority.controlPlane();
    expect(controlPlane, 'the process exposes no control plane');
    const tabOne = tabA1;
    const tabTwo = tabA2;
    expect(alpha.hasTab(tabOne) && alpha.hasTab(tabTwo), 'the window lost a tab this row needs');

    // Both sessions belong to the SAME project and the SAME window: the boundary under test is
    // the session, not the window. A third tab lives in another project's window.
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
    const serverOne = new AntiFanMcpServer(alpha, false, transport, {
      attachmentId: sessionOne.launch.attachmentId,
      attachmentSecret: sessionOne.launch.secret,
      authorityRevision: sessionOne.launch.authorityRevision,
    });
    const serverTwo = new AntiFanMcpServer(alpha, false, transport, {
      attachmentId: sessionTwo.launch.attachmentId,
      attachmentSecret: sessionTwo.launch.secret,
      authorityRevision: sessionTwo.launch.authorityRevision,
    });

    // Every DOM read the shipping path performs is recorded, so a refusal that quietly fell
    // back to another tab would show up as a read of that tab.
    const domReads = [];
    const originalGetDom = NativeTabHost.prototype.getDom;
    const beta = hostOf(BETA);
    const foreignUrlBefore = beta.getTabList().find(function (tab) { return tab.id === tabB1; }).url;
    try {
      NativeTabHost.prototype.getDom = async function patchedGetDom(selector, tabId, paneId) {
        domReads.push(String(tabId));
        return originalGetDom.call(this, selector, tabId, paneId);
      };
      const textOf = function (result) {
        return result && result.content && result.content[0] ? String(result.content[0].text) : '';
      };
      // The reads that decide the row run with the tab presented: the binding is to the tab,
      // not to its rendering.
      bringForward(authority.windowFor(keyOf(ALPHA)));
      alpha.switchTab(tabOne, { plane: 'user' });
      await waitFor(function () { return alpha.getActiveTabId() === tabOne; }, 'the window to present the tab session one is bound to');
      const ownRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabOne });
      // Reads share the project scope: a tab that measures into this attachment's own
      // project/workspace is observable across sessions without a rebind. The session
      // boundary lives on mutations, not on observation.
      const crossRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabTwo });
      const crossWrite = await serverOne.callTool('anti.browser.navigate', { tabId: tabTwo, url: pageUrl('nav-refused') });
      const readAfterCross = domReads.slice();
      // Another project's window: neither its tab's content nor its page may be reached.
      const foreignRead = await serverOne.callTool('anti.inspect.dom', { tabId: tabB1 });
      const foreignWrite = await serverOne.callTool('anti.browser.navigate', { tabId: tabB1, url: pageUrl('nav-refused-foreign') });
      alpha.switchTab(tabTwo, { plane: 'user' });
      await waitFor(function () { return alpha.getActiveTabId() === tabTwo; }, 'the window to present the tab session two is bound to');
      const siblingRead = await serverTwo.callTool('anti.inspect.dom', { tabId: tabTwo });
      const foreignUrlAfter = beta.getTabList().find(function (tab) { return tab.id === tabB1; }).url;
      observations.sameProjectSessions = {
        tabOne: tabOne,
        tabTwo: tabTwo,
        foreignTab: tabB1,
        crossRefused: crossRead.isError === true,
        crossText: textOf(crossRead),
        crossWriteRefused: crossWrite.isError === true,
        crossWriteText: textOf(crossWrite),
        foreignReadRefused: foreignRead.isError === true,
        foreignReadText: textOf(foreignRead),
        foreignWriteRefused: foreignWrite.isError === true,
        foreignWriteText: textOf(foreignWrite),
        domReadsBeforeSibling: readAfterCross,
        domReads: domReads.slice(),
        foreignTabNavigated: foreignUrlAfter !== foreignUrlBefore,
      };
      expect(ownRead.isError !== true, 'session one could not read its own tab: ' + textOf(ownRead));
      expect(crossRead.isError !== true, 'session one could not read the same-project sibling tab: ' + textOf(crossRead));
      expect(readAfterCross.indexOf(tabTwo) !== -1, 'the same-project sibling read never reached its tab: ' + JSON.stringify(readAfterCross));
      expect(crossWrite.isError === true, 'session one navigated the sibling session tab: ' + textOf(crossWrite));
      expect(textOf(crossWrite).indexOf('TARGET_MISMATCH') !== -1, 'the write refusal did not name the mismatch: ' + textOf(crossWrite));
      expect(foreignWrite.isError === true, "session one navigated another project window's tab: " + textOf(foreignWrite));
      expect(foreignUrlAfter === foreignUrlBefore, "the other project window's tab moved from " + foreignUrlBefore + ' to ' + foreignUrlAfter);
      expect(foreignRead.isError === true, "session one read another project window's tab: " + textOf(foreignRead));
      expect(domReads.indexOf(tabB1) === -1, "a read reached another project window's tab: " + JSON.stringify(domReads));
      expect(siblingRead.isError !== true, 'session two could not read its own tab: ' + textOf(siblingRead));
      expect(domReads.indexOf(tabTwo) !== -1, 'session two never reached its own tab: ' + JSON.stringify(domReads));
    } finally {
      NativeTabHost.prototype.getDom = originalGetDom;
      // This row is the only one that starts CLI sessions, and it ends them here: a live
      // interactive session keeps a streaming run and an attachment on its tab alive by
      // design, so two sessions left running would make the close rows later in this scenario
      // address a window that is rightly busy — a refusal about work this scenario created,
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

  // ---- (11) a background window's page is laid out and capturable while another is in front
  await check('window.background-window-surface-and-capture-ready', async function () {
    const alpha = hostOf(ALPHA);
    const alphaWindow = authority.windowFor(keyOf(ALPHA));
    const betaWindow = authority.windowFor(keyOf(BETA));
    expect(alphaWindow && !alphaWindow.isDestroyed() && betaWindow && !betaWindow.isDestroyed(), 'a project window has no native window');

    // The subject is the background window, not the occlusion: the two windows are placed side
    // by side so neither covers the other (a covered window is a different, legitimate case
    // where the compositor may stop rasterizing). Where this display cannot hold both, the run
    // records that instead of measuring an overlapped window and calling the result a rendering
    // verdict.
    const workArea = screen.getPrimaryDisplay().workArea;
    const tiled = workArea.width >= 2 * SHELL_MIN_WIDTH + 16 && workArea.height >= SHELL_MIN_HEIGHT;
    if (tiled) {
      const halfWidth = Math.floor(workArea.width / 2);
      const height = Math.min(workArea.height, 900);
      alphaWindow.setBounds({ x: workArea.x, y: workArea.y, width: halfWidth, height: height });
      betaWindow.setBounds({ x: workArea.x + halfWidth, y: workArea.y, width: halfWidth, height: height });
    }
    bringForward(betaWindow);
    if (alphaWindow.isMinimized()) alphaWindow.restore();
    alphaWindow.showInactive();
    const alphaEntry = await waitFor(function () {
      const entry = entryFor(ALPHA);
      return entry && entry.focused === false && alphaWindow.isVisible() === true ? entry : false;
    }, 'the first window to be presented in the background without taking the foreground');

    const surface = await alpha.readRenderSurface(tabA1, 'desktop');
    observations.backgroundSurface = {
      mode: tiled ? 'tiled' : 'stacked',
      workArea: { width: workArea.width, height: workArea.height },
      surface: surface,
      activeTabId: alphaEntry.activeTabId,
      visible: alphaEntry.visible,
      focused: alphaEntry.focused,
      presented: alphaWindow.isVisible(),
    };
    expect(surface && surface.vw > 0 && surface.vh > 0, "the background window's page has no laid-out viewport: " + JSON.stringify(surface));

    if (!tiled) {
      observations.backgroundCapture = null;
      console.log('  NOTE  windows were not tiled (work area ' + workArea.width + 'x' + workArea.height + '): a raster of an overlapped window is deferred to a display that can hold both, and no pixels are claimed here');
      return;
    }
    // document.hidden flips a frame after showInactive(); the wait is bounded and the report
    // recorded, so the capture below — the pixel-level claim this row owns — still runs instead
    // of the row deciding itself on a renderer notification Chromium may skip.
    const presentedSurface = surface.hidden === false
      ? surface
      : await waitFor(async function () {
          const candidate = await alpha.readRenderSurface(tabA1, 'desktop');
          return candidate && candidate.hidden === false ? candidate : false;
        }, "the background window's page to stop reporting itself hidden", 8000).catch(function (err) {
          console.log('  NOTE  the page still reports itself hidden after 8s: ' + messageOf(err) + ' — the capture decides the row');
          return null;
        });
    observations.backgroundSurface = { ...observations.backgroundSurface, presentedSurface: presentedSurface };
    // Capturing a background window must not take the foreground from the window the user is in.
    const alphaFocusedBefore = alphaWindow.isFocused();
    const capture = await alpha.captureVerificationScreenshot(undefined, tabA1, 'desktop');
    const alphaFocusedAfter = alphaWindow.isFocused();
    observations.backgroundCapture = capture
      ? {
          backend: capture.backend,
          rasterSize: capture.rasterSize,
          bytes: typeof capture.data === 'string' ? capture.data.length : 0,
          focused: { before: alphaFocusedBefore, after: alphaFocusedAfter },
        }
      : null;
    expect(capture && typeof capture.data === 'string' && capture.data.length > 0, 'the background capture returned no pixels');
    expect(capture.rasterSize && capture.rasterSize.width > 0 && capture.rasterSize.height > 0, 'the background capture has no raster size: ' + JSON.stringify(capture.rasterSize));
    expect(
      alphaFocusedBefore === false && alphaFocusedAfter === false,
      "capturing the background window's tab moved the foreground to it: before " + String(alphaFocusedBefore) + ', after ' + String(alphaFocusedAfter),
    );
  });

  // --------------------------- (12) the search inventory spans every window's tabs
  await check('window.search-lists-the-tabs-of-every-window', async function () {
    const inventory = await toolbarCall(ALPHA, "window.antifanToolbar.searchProjectTabs('')");
    observations.inventory = inventory;
    expect(inventory && inventory.status === 'OK', 'the search returned ' + JSON.stringify(inventory));
    const rows = inventory.rows || [];
    const byId = {};
    for (const row of rows) byId[row.tabId] = row;
    for (const tabId of [tabA1, tabA2, tabB1, tabB2]) {
      expect(byId[tabId], 'tab ' + tabId + ' is missing from the inventory: ' + JSON.stringify(rows.map(function (row) { return row.tabId; })));
    }
    // Each row names the window that shows it: the project's own title, not one shared label.
    for (const tabId of [tabA1, tabA2]) expect(byId[tabId].ownerLabel === ALPHA.name, 'tab ' + tabId + ' was labelled ' + String(byId[tabId].ownerLabel));
    for (const tabId of [tabB1, tabB2]) expect(byId[tabId].ownerLabel === BETA.name, 'tab ' + tabId + ' was labelled ' + String(byId[tabId].ownerLabel));
    expect(byId[tabA1].url === pageUrl('a1'), 'the inventory url was ' + String(byId[tabA1].url));

    // Listing has no side effects: the Terminal Manager's toolbar and the other project's
    // window see the same inventory — the search contract is process-wide by design and must
    // not depend on which window asks.
    const keyOfRows = function (result) {
      return JSON.stringify((result.rows || []).map(function (row) { return [row.tabId, row.ownerLabel, row.live]; }));
    };
    const fromManager = await (await chromeOf('unassigned', 'toolbar')).executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(fromManager && fromManager.status === 'OK', 'the search from the Terminal Manager returned ' + JSON.stringify(fromManager));
    expect(keyOfRows(fromManager) === keyOfRows(inventory), 'two windows listed different inventories');
    const fromBeta = await toolbarCall(BETA, "window.antifanToolbar.searchProjectTabs('')");
    expect(keyOfRows(fromBeta) === keyOfRows(inventory), 'the second window listed a different inventory');
    // A query only filters.
    const filtered = await toolbarCall(ALPHA, "window.antifanToolbar.searchProjectTabs('/b1')");
    expect(filtered.rows.length === 1 && filtered.rows[0].tabId === tabB1, 'a query listed ' + JSON.stringify(filtered.rows.map(function (row) { return row.tabId; })));
  });

  // ----- (13) activation presents the tab's own window and moves no execution authority
  await check('window.search-presents-the-tabs-own-window-without-authority-rotation', async function () {
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    const betaWindow = authority.windowFor(keyOf(BETA));
    // The first window's automation target is execution authority. It is set through the same
    // host seam attachment binding uses, so the user activation below is measured against real
    // authority rather than an empty field.
    alpha.setAutomationTabId(tabA2);
    const alphaActiveBefore = alpha.getActiveTabId();
    // The window the tab lives in is minimized, and a different window is in front.
    bringForward(authority.windowFor(keyOf(ALPHA)));
    betaWindow.minimize();
    await waitFor(function () { return betaWindow.isMinimized() === true; }, 'the second window to minimize');

    const activation = await toolbarCall(ALPHA, 'window.antifanToolbar.activateProjectTab(' + JSON.stringify(tabB1) + ')');
    const after = await waitFor(function () {
      const entry = entryFor(BETA);
      return entry && entry.activeTabId === tabB1 ? entry : false;
    }, 'the tab the search asked for to be presented in its own window');
    observations.activation = {
      result: activation,
      betaActiveAfter: after.activeTabId,
      alphaActive: alpha.getActiveTabId(),
      alphaAutomation: alpha.getAutomationTabId(),
      betaMinimizedAfter: betaWindow.isMinimized(),
    };
    expect(activation && activation.status === 'ACTIVATED', 'the activation returned ' + JSON.stringify(activation));
    expect(activation.tabId === tabB1, 'the activation named tab ' + String(activation.tabId));
    // A user activation presents the tab's own window: the window the result belongs to comes
    // forward, and the window the request came from does not keep the foreground.
    await waitFor(function () { return betaWindow.isMinimized() === false && betaWindow.isVisible() === true; }, "the tab's own window to be brought back");
    expect(beta.getActiveTabId() === tabB1, "the tab's own window active tab was " + beta.getActiveTabId());
    expect(alpha.getActiveTabId() === alphaActiveBefore, 'the activation moved the requesting window active tab to ' + alpha.getActiveTabId());
    expect(alpha.getAutomationTabId() === tabA2, "the requesting window's automation target moved to " + String(alpha.getAutomationTabId()));
    expect(beta.getAutomationTabId() === tabB1, "the tab's own window's automation target moved to " + String(beta.getAutomationTabId()));
    expect(authority.browserShellCount() === 3, 'the activation changed the window count to ' + authority.browserShellCount());
  });

  // ------------------------------------------------------------- (14) stale results refuse
  await check('window.search-stale-refusal-no-fallback', async function () {
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    const betaBefore = beta.getActiveTabId();
    const alphaBefore = alpha.getActiveTabId();

    const never = await toolbarCall(ALPHA, "window.antifanToolbar.activateProjectTab('tab-that-never-existed')");
    expect(never && never.status === 'UNAVAILABLE', 'a never-existing tab returned ' + JSON.stringify(never));
    expect(never.reasonCode === 'TAB_CLOSED', 'a never-existing tab reported ' + String(never.reasonCode));
    expect(never.tabId === 'tab-that-never-existed', 'a refused activation named tab ' + String(never.tabId));

    // A real tab that has since closed: the exact case a rendered search result goes stale in.
    // It is not the other window's active tab, so the fallback a stale result could take is
    // observable as a change of that window's active tab.
    expect(betaBefore === tabB1, 'the second window active tab was ' + betaBefore);
    expect(await toolbarCall(BETA, 'window.antifanToolbar.closeTab(' + JSON.stringify(tabB2) + ')') === true, 'the second window refused to close its own tab ' + tabB2);
    await waitFor(function () { return beta.hasExactTab(tabB2) === false; }, 'the second window to drop the closed tab');
    const stale = await toolbarCall(ALPHA, 'window.antifanToolbar.activateProjectTab(' + JSON.stringify(tabB2) + ')');
    observations.staleActivation = { never: never, closedTab: stale };
    expect(stale && stale.status === 'UNAVAILABLE', 'a closed tab returned ' + JSON.stringify(stale));
    expect(stale.reasonCode === 'TAB_CLOSED', 'a closed tab reported ' + String(stale.reasonCode));
    expect(stale.tabId === tabB2, 'the refusal named tab ' + String(stale.tabId));
    expect(beta.getActiveTabId() === tabB1, 'a refused activation moved the second window to ' + beta.getActiveTabId());
    expect(alpha.getActiveTabId() === alphaBefore, 'a refused activation moved the first window to ' + alpha.getActiveTabId());
  });

  // ------------------------------ (15) five projects, five windows, twenty stamped tabs
  await check('window.five-project-windows-twenty-stamped-tabs', async function () {
    for (const project of [GAMMA, DELTA, EPSILON]) {
      const opened = await openProjectFromSidebar(project);
      expect(opened.result && opened.result.status === 'OPENED', 'opening ' + project.name + ' returned ' + JSON.stringify(opened.result));
      expect(opened.entry.ownerKey === keyOf(project), 'opening ' + project.name + ' presented ' + opened.entry.ownerKey);
    }
    expect(authority.browserShellCount() === 6, 'browserShellCount() was ' + authority.browserShellCount() + ' for five projects and the Terminal Manager');

    // Four stamped tabs per project, minted through each window's own toolbar. Top-up rather
    // than a blind four: each window already holds its own first page.
    for (const project of PROJECTS) {
      const host = hostOf(project);
      await waitFor(function () { return host.getTabList().length > 0; }, project.name + "'s first tab");
      expect(host.getTabList().length <= 4, project.name + ' already holds ' + host.getTabList().length + ' tabs');
      for (let index = host.getTabList().length; index < 4; index += 1) {
        await createTabIn(project, project.slug + '-' + index);
      }
    }

    const stamped = [];
    for (const project of PROJECTS) {
      const host = hostOf(project);
      const tabs = host.getTabList();
      expect(tabs.length === 4, project.name + ' holds ' + tabs.length + ' tabs, expected 4');
      for (const tab of tabs) {
        expect(tab.projectId === project.projectId, 'tab ' + tab.id + ' in ' + project.name + ' carries stamp ' + String(tab.projectId));
        expect(stamped.indexOf(tab.id) === -1, 'tab ' + tab.id + ' is held by two windows');
        expect(authority.hostForTab(tab.id) === host, 'tab ' + tab.id + ' did not resolve to ' + project.name);
        stamped.push(tab.id);
      }
      // The strip the window paints is the one its directory entry reports, under its own identity.
      const state = await waitFor(async function () {
        const value = await toolbarCall(project, 'window.antifanToolbar.getInitialState()');
        return value && Array.isArray(value.tabs) && value.tabs.length === 4 ? value : false;
      }, project.name + ' to paint four tabs in its own strip');
      expect(state.projectWindow && state.projectWindow.owner && state.projectWindow.owner.kind === 'project' && state.projectWindow.owner.projectId === project.projectId, project.name + ' painted identity ' + JSON.stringify(state.projectWindow && state.projectWindow.owner));
      expect(state.projectWindow.title === project.name, project.name + ' painted title ' + JSON.stringify(state.projectWindow.title));
      const entry = entryFor(project);
      expect(state.tabs.map(function (tab) { return tab.id; }).sort().join('|') === entry.tabIds.slice().sort().join('|'), project.name + ' painted a strip the directory disagrees with');
      expect(state.activeTabId === entry.activeTabId, project.name + ' painted active tab ' + String(state.activeTabId) + ' while the directory said ' + entry.activeTabId);
    }
    expect(stamped.length === 20, 'the windows hold ' + stamped.length + ' project-stamped tabs, expected 20');
    expect(entryOf(authority.snapshot(), 'unassigned').tabIds.length === 0, 'the Terminal Manager gained a tab');

    // One search sees all twenty, each row labelled with the window that shows it.
    const inventory = await toolbarCall(ALPHA, "window.antifanToolbar.searchProjectTabs('')");
    expect(inventory && inventory.status === 'OK', 'the five-project search returned ' + JSON.stringify(inventory));
    const rows = inventory.rows || [];
    const rowByTab = {};
    for (const row of rows) rowByTab[row.tabId] = row;
    for (const project of PROJECTS) {
      for (const tab of hostOf(project).getTabList()) {
        const row = rowByTab[tab.id];
        expect(row, 'tab ' + tab.id + ' is missing from the five-project inventory');
        expect(row.ownerLabel === project.name, 'tab ' + tab.id + ' was labelled ' + String(row.ownerLabel) + ', expected ' + project.name);
        expect(row.live === true, 'tab ' + tab.id + ' was listed as not live');
      }
    }
    const fromManager = await (await chromeOf('unassigned', 'toolbar')).executeJavaScript("window.antifanToolbar.searchProjectTabs('')", true);
    expect(fromManager && fromManager.status === 'OK' && JSON.stringify(fromManager.rows.map(function (row) { return row.tabId; }).sort()) === JSON.stringify(rows.map(function (row) { return row.tabId; }).sort()), 'two windows listed different five-project inventories');
    observations.volume = { shellCount: authority.browserShellCount(), stampedCount: stamped.length, inventoryRows: rows.length };
  });

  // ------- (16) closing one project window leaves every other window and its tabs alone
  let deltaLocalUrlsBeforeClose = null;
  let deltaTabCountBeforeClose = 0;
  await check('window.close-project-window-keeps-the-others', async function () {
    const before = authority.snapshot();
    const survivors = PROJECTS.filter(function (project) { return project !== DELTA; });
    const tabsBefore = {};
    for (const project of survivors) {
      const entry = entryOf(before, keyOf(project));
      tabsBefore[project.projectId] = { tabIds: entry.tabIds.slice(), active: entry.activeTabId, windowId: entry.windowId };
    }
    const deltaHost = hostOf(DELTA);
    deltaLocalUrlsBeforeClose = localTabUrls(deltaHost);
    deltaTabCountBeforeClose = deltaHost.getTabList().length;
    const deltaTabIds = deltaHost.getTabList().map(function (tab) { return tab.id; });
    expect(deltaTabCountBeforeClose === 4 && deltaLocalUrlsBeforeClose.length >= 3, 'the window to close holds ' + deltaTabCountBeforeClose + ' tabs: ' + JSON.stringify(deltaLocalUrlsBeforeClose));

    await closeWindowAndWait(keyOf(DELTA));
    const after = authority.snapshot();
    observations.closeProject = { remaining: after.map(function (entry) { return entry.ownerKey; }), shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 5, 'browserShellCount() was ' + authority.browserShellCount());
    for (const tabId of deltaTabIds) {
      expect(authority.hostForTab(tabId) === null, 'the closed window tab ' + tabId + ' still resolves to a host');
    }
    for (const project of survivors) {
      const entry = entryOf(after, keyOf(project));
      expect(entry, project.name + ' disappeared with the closed window');
      expect(entry.windowId === tabsBefore[project.projectId].windowId, project.name + ' changed window');
      expect(JSON.stringify(entry.tabIds) === JSON.stringify(tabsBefore[project.projectId].tabIds), project.name + ' tabs changed from ' + JSON.stringify(tabsBefore[project.projectId].tabIds) + ' to ' + JSON.stringify(entry.tabIds));
      expect(entry.activeTabId === tabsBefore[project.projectId].active, project.name + ' changed its active tab');
      expect(authority.windowFor(keyOf(project)) && !authority.windowFor(keyOf(project)).isDestroyed(), project.name + ' native window was destroyed');
      for (const tabId of entry.tabIds) expect(authority.hostForTab(tabId) === hostOf(project), 'tab ' + tabId + ' no longer resolves to ' + project.name);
    }
    expect(entryOf(after, 'unassigned'), 'the Terminal Manager closed with the project window');
    expect(app.isReady() === true, 'the app is no longer ready after a window closed');
    // The user's own close is recorded: the closed project is no longer a window to bring back.
    const ledger = await waitFor(function () {
      const parsed = readJson(legacyEnvelope().ledger);
      return parsed && Array.isArray(parsed.owners) && parsed.owners.indexOf(keyOf(DELTA)) === -1 ? parsed : false;
    }, 'the ledger to drop the closed window');
    for (const project of survivors) expect(ledger.owners.indexOf(keyOf(project)) !== -1, 'the ledger dropped ' + project.name);
  });

  // ---- (17) an agent's ensure opens the project's window without presenting it
  await check('window.agent-ensure-opens-the-project-window-unpresented', async function () {
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

    try {
      const before = authority.snapshot();
      expect(!entryOf(before, keyOf(DELTA)), 'the window the agent asks for is already open');
      const entry = await authority.ensureProjectWindow({ kind: 'project', projectId: DELTA.projectId }, 'agent');
      // A presentation that arrives late is still a presentation, so the observation stays open
      // for a bounded window instead of a single instant: the window's creation path is
      // asynchronous, and reading the call list once would race it.
      for (let round = 0; round < 4; round += 1) {
        await sleep(100);
        expect(
          presentationCalls.filter(function (call) { return call.windowId === entry.windowId; }).length === 0,
          'the agent-opened window was presented: ' + JSON.stringify(presentationCalls.filter(function (call) { return call.windowId === entry.windowId; })),
        );
      }
      const after = authority.snapshot();
      const host = hostOf(DELTA);
      observations.agentEnsure = {
        entry: { ownerKey: entry.ownerKey, windowId: entry.windowId },
        created: !entryOf(before, keyOf(DELTA)),
        callsForWindow: presentationCalls.filter(function (call) { return call.windowId === entry.windowId; }),
        callsForOtherWindows: presentationCalls.filter(function (call) { return call.windowId !== entry.windowId; }),
        visibleAfterEnsure: authority.windowFor(keyOf(DELTA)).isVisible(),
        restoredTabCount: host.getTabList().length,
        restoredLocalUrls: localTabUrls(host),
      };
      expect(entry.ownerKey === keyOf(DELTA), "the agent's ensure resolved to " + String(entry.ownerKey));
      expect(entry.owner.kind === 'project' && entry.owner.projectId === DELTA.projectId, "the agent's ensure named owner " + JSON.stringify(entry.owner));
      expect(entry.windowId !== windowIdOf.unassigned, "the agent's ensure reused another window");
      expect(authority.browserShellCount() === 6, 'the ensure left ' + authority.browserShellCount() + ' windows');
      expect(observations.agentEnsure.callsForOtherWindows.length === 0, 'the ensure presented other windows: ' + JSON.stringify(observations.agentEnsure.callsForOtherWindows));
      expect(observations.agentEnsure.visibleAfterEnsure === false, 'the agent-opened window is visible');
      // The ledger is what the next boot reopens, and the user closed this window in (16): a
      // window nobody can see must not go back on it, or the boot would put it on screen.
      const ledgerAfterEnsure = readJson(legacyEnvelope().ledger);
      expect(
        ledgerAfterEnsure && Array.isArray(ledgerAfterEnsure.owners) && ledgerAfterEnsure.owners.indexOf(keyOf(DELTA)) === -1,
        'the ledger lists the agent-opened window: ' + JSON.stringify(ledgerAfterEnsure && ledgerAfterEnsure.owners),
      );
      for (const other of after) {
        if (other.ownerKey === entry.ownerKey) continue;
        const previous = before.find(function (candidate) { return candidate.ownerKey === other.ownerKey; });
        if (!previous) continue;
        expect(other.visible === previous.visible, 'window ' + other.ownerKey + ' visibility changed while the ensure ran');
        expect(other.focused === previous.focused, 'window ' + other.ownerKey + ' focus changed while the ensure ran');
      }
      // The window comes back with the tabs it had: its own record, restored by its own host.
      expect(JSON.stringify(observations.agentEnsure.restoredLocalUrls) === JSON.stringify(deltaLocalUrlsBeforeClose), 'the reopened window tabs were ' + JSON.stringify(observations.agentEnsure.restoredLocalUrls));
      expect(observations.agentEnsure.restoredTabCount === deltaTabCountBeforeClose, 'the reopened window holds ' + observations.agentEnsure.restoredTabCount + ' tabs instead of ' + deltaTabCountBeforeClose);
      for (const tab of host.getTabList()) expect(tab.projectId === DELTA.projectId, 'a restored tab carries stamp ' + String(tab.projectId));
    } finally {
      for (const [method, original] of patched) {
        BrowserWindow.prototype[method] = original;
      }
    }
  });

  // ---- (18) a user's open presents it, and finds the window the agent opened
  await check('window.user-open-presents-and-restores-the-windows-own-tabs', async function () {
    const before = entryFor(DELTA);
    expect(before && before.visible === false, 'the agent-opened window was already visible');
    const opened = await openProjectFromSidebar(DELTA);
    expect(opened.result && opened.result.status === 'FOCUSED', 'the user open returned ' + JSON.stringify(opened.result));
    expect(opened.entry.windowId === before.windowId, 'the user open created another window');
    expect(opened.entry.visible === true, 'the user open did not present the window');
    // Presented now, so the next boot brings it back.
    await waitFor(function () {
      const parsed = readJson(legacyEnvelope().ledger);
      return parsed && Array.isArray(parsed.owners) && parsed.owners.indexOf(keyOf(DELTA)) !== -1 ? parsed : false;
    }, 'the ledger to list the window the user presented');
    expect(authority.browserShellCount() === 6, 'browserShellCount() was ' + authority.browserShellCount());
    expect(JSON.stringify(localTabUrls(hostOf(DELTA))) === JSON.stringify(deltaLocalUrlsBeforeClose), 'the presented window lost its tabs');
  });

  // ---- (18b) an agent-visible ensure shows the project's window on first paint without activating it
  await check('window.agent-visible-ensure-shows-the-window-without-focus', async function () {
    await closeWindowAndWait(keyOf(DELTA));
    const presentationCalls = [];
    const patched = [];
    for (const method of ['show', 'showInactive', 'focus', 'moveTop']) {
      const original = BrowserWindow.prototype[method];
      if (typeof original !== 'function') continue;
      patched.push([method, original]);
      BrowserWindow.prototype[method] = function patchedMethod() {
        presentationCalls.push({ method: method, windowId: this.id });
        return original.apply(this, arguments);
      };
    }
    const callsFor = function (windowId) {
      return presentationCalls.filter(function (call) { return call.windowId === windowId; }).map(function (call) { return call.method; });
    };

    try {
      expect(!entryOf(authority.snapshot(), keyOf(DELTA)), 'the window the agent asks for is still open');
      const entry = await authority.ensureProjectWindow({ kind: 'project', projectId: DELTA.projectId }, 'agent-visible');
      const win = authority.windowFor(keyOf(DELTA));
      await waitFor(function () { return win.isVisible() ? true : false; }, 'the agent-visible window to be presented');
      expect(
        JSON.stringify(callsFor(entry.windowId)) === JSON.stringify(['showInactive']),
        'the agent-visible window was presented through ' + JSON.stringify(callsFor(entry.windowId)),
      );
      await waitFor(function () {
        const parsed = readJson(legacyEnvelope().ledger);
        return parsed && Array.isArray(parsed.owners) && parsed.owners.indexOf(keyOf(DELTA)) !== -1 ? parsed : false;
      }, 'the ledger to list the window an agent surfaced');

      // A window an earlier call left hidden is surfaced by the next agent-visible join.
      win.hide();
      expect(win.isVisible() === false, 'the window did not hide');
      presentationCalls.length = 0;
      await authority.ensureProjectWindow({ kind: 'project', projectId: DELTA.projectId }, 'agent-visible');
      expect(win.isVisible() === true, 'the hidden window stayed hidden');
      expect(
        JSON.stringify(callsFor(entry.windowId)) === JSON.stringify(['showInactive']),
        'the hidden window was revealed through ' + JSON.stringify(callsFor(entry.windowId)),
      );

      // A window that is already on screen is left alone by a repeated agent call.
      presentationCalls.length = 0;
      await authority.ensureProjectWindow({ kind: 'project', projectId: DELTA.projectId }, 'agent-visible');
      expect(callsFor(entry.windowId).length === 0, 'a visible window was presented again: ' + JSON.stringify(callsFor(entry.windowId)));
      expect(authority.browserShellCount() === 6, 'browserShellCount() was ' + authority.browserShellCount());
    } finally {
      for (const [method, original] of patched) {
        BrowserWindow.prototype[method] = original;
      }
    }
  });

  // ---- (18c) a user's open starts the theme watchers its project needs; an agent's never did
  await check('window.user-open-starts-theme-watchers-and-agent-open-does-not', async function () {
    const { TerminalManager } = require(compiledModule('browser/terminal-manager.js'));
    const manager = TerminalManager.getInstance();
    const rowsOf = function (project) {
      return manager.listSessions().filter(function (row) { return row.ownerKey === keyOf(project); });
    };
    const watchersOf = function (project) {
      return rowsOf(project).filter(function (row) { return String(row.spaceTerminalId || '').indexOf('theme-sync-') === 0; });
    };
    // hrv and sapo resolve to stubs that only record their arguments: nothing here may reach a
    // real remote, and the marker is what proves the command was typed into a live shell.
    const stubDir = path.join(tempRoot, 'cli-stubs');
    fs.mkdirSync(stubDir, { recursive: true });
    const markerOf = function (name) { return path.join(tempRoot, name + '.marker'); };
    // No backslash escapes in this block: the driver is an ordinary template literal.
    for (const name of ['hrv', 'sapo']) {
      if (process.platform === 'win32') {
        fs.writeFileSync(path.join(stubDir, name + '.cmd'), ['@echo ' + name + ' %* > "' + markerOf(name) + '"', ''].join(os.EOL));
      } else {
        fs.writeFileSync(path.join(stubDir, name), ['#!/bin/sh', 'echo ' + name + ' "$@" > "' + markerOf(name) + '"', ''].join(os.EOL), { mode: 0o755 });
      }
    }
    process.env.PATH = stubDir + path.delimiter + process.env.PATH;
    fs.writeFileSync(path.join(DELTA.path, '.haravan-cli_local.json'), JSON.stringify({ org_id: '1', theme_id: '2' }));
    fs.writeFileSync(path.join(DELTA.path, '.sapo-cli_local.json'), JSON.stringify({ store_prefix: 'e2e', theme_id: 3 }));

    // The window an agent surfaces, created AFTER the project is bound to its remotes: the case
    // where an autostart that ignored who opened the window would have something to start. It is
    // up, its sidebar has started a terminal, and nobody opened it: no watcher.
    await closeWindowAndWait(keyOf(DELTA));
    await authority.ensureProjectWindow({ kind: 'project', projectId: DELTA.projectId }, 'agent-visible');
    // The new window's own sidebar must be loaded: it is what starts the terminals.
    await chromeOf(keyOf(DELTA), 'sidebar');
    await waitFor(function () { return rowsOf(DELTA).some(function (row) { return !row.splitOf; }); }, 'the agent-visible window to start its first terminal', 60000);
    // A real wait, not a guess at a condition: the claim is that nothing starts, and an event that
    // never happens cannot be awaited. The first terminal exists, so a start would be under way.
    await sleep(1500);
    expect(watchersOf(DELTA).length === 0, 'an agent-visible window started watchers: ' + JSON.stringify(watchersOf(DELTA)));

    const opened = await openProjectFromSidebar(DELTA);
    expect(opened.result && opened.result.status === 'FOCUSED', 'the user open returned ' + JSON.stringify(opened.result));
    await waitFor(function () { return watchersOf(DELTA).length === 2 ? true : false; }, 'both theme watchers to be minted', 60000);
    const base = rowsOf(DELTA).filter(function (row) { return !row.splitOf; })[0];
    const watchers = watchersOf(DELTA);
    const byId = {};
    for (const row of watchers) byId[row.spaceTerminalId] = row;
    expect(byId['theme-sync-haravan'] && byId['theme-sync-sapo'], 'the watchers were ' + JSON.stringify(watchers.map(function (w) { return w.spaceTerminalId; })));
    for (const row of watchers) {
      expect(row.splitOf === base.id, row.spaceTerminalId + ' split ' + String(row.splitOf) + ', not the base ' + base.id);
      expect(row.role === 'sync' && row.idlePolicy === 'never', row.spaceTerminalId + ' was ' + String(row.role) + '/' + String(row.idlePolicy));
      expect(samePath(row.cwd, DELTA.path), row.spaceTerminalId + ' ran in ' + String(row.cwd));
    }
    // The stub creates its marker before it writes to it, so existence alone can be read while the file is still empty.
    const markerWritten = function (name) { return fs.existsSync(markerOf(name)) && fs.readFileSync(markerOf(name), 'utf8').trim().length > 0; };
    await waitFor(function () { return markerWritten('hrv') && markerWritten('sapo') ? true : false; }, 'both commands to reach a live shell', 60000);
    expect(fs.readFileSync(markerOf('hrv'), 'utf8').trim() === 'hrv theme dev', 'hrv got ' + fs.readFileSync(markerOf('hrv'), 'utf8'));
    expect(fs.readFileSync(markerOf('sapo'), 'utf8').trim() === 'sapo theme dev', 'sapo got ' + fs.readFileSync(markerOf('sapo'), 'utf8'));

    // A second open of the same window starts nothing more.
    const sessionsBefore = rowsOf(DELTA).length;
    await openProjectFromSidebar(DELTA);
    await sleep(1500);
    expect(watchersOf(DELTA).length === 2 && rowsOf(DELTA).length === sessionsBefore, 'a repeat open changed the sessions: ' + sessionsBefore + ' -> ' + rowsOf(DELTA).length);
  });

  // ---- (18d) the window a user creates while other windows hold terminals: its first terminal comes later
  await check('window.user-created-window-starts-theme-watchers-after-its-first-terminal', async function () {
    const { TerminalManager } = require(compiledModule('browser/terminal-manager.js'));
    const manager = TerminalManager.getInstance();
    const rowsOf = function (project) {
      return manager.listSessions().filter(function (row) { return row.ownerKey === keyOf(project); });
    };
    const watchersOf = function (project) {
      return rowsOf(project).filter(function (row) { return String(row.spaceTerminalId || '').indexOf('theme-sync-') === 0; });
    };
    const markerOf = function (name) { return path.join(tempRoot, name + '.marker'); };

    // Nothing the previous row left may satisfy this one: the window goes, every terminal it owned
    // goes, and the markers its watchers wrote go. Other windows still hold their terminals, so the
    // process-wide start finds sessions and mints none for the window created below. (Terminal ids
    // are reused after a close, so "new" is proved by the project owning nothing in between.)
    await closeWindowAndWait(keyOf(DELTA));
    for (const row of rowsOf(DELTA).filter(function (item) { return !item.splitOf; })) {
      await manager.closeSession(row.id);
    }
    expect(rowsOf(DELTA).length === 0, 'the project still owned terminals: ' + JSON.stringify(rowsOf(DELTA)));
    expect(manager.listSessions().some(function (row) { return row.state === 'running' && row.ownerKey !== keyOf(DELTA); }), 'no other window held a terminal, so this row would not be the case it names');
    for (const name of ['hrv', 'sapo']) fs.rmSync(markerOf(name), { force: true });

    const opened = await openProjectFromSidebar(DELTA);
    expect(opened.result && opened.result.status === 'OPENED', 'the user open returned ' + JSON.stringify(opened.result));
    await waitFor(function () { return watchersOf(DELTA).length === 2 ? true : false; }, 'both theme watchers to be minted in the new window', 60000);
    const base = rowsOf(DELTA).filter(function (row) { return !row.splitOf && row.state === 'running'; })[0];
    expect(base, 'the new window has no base terminal: ' + JSON.stringify(rowsOf(DELTA)));
    for (const row of watchersOf(DELTA)) {
      expect(row.splitOf === base.id, row.spaceTerminalId + ' was ' + JSON.stringify(row));
    }
    await waitFor(function () { return fs.existsSync(markerOf('hrv')) && fs.existsSync(markerOf('sapo')) ? true : false; }, 'both commands to reach the new window shells', 60000);
  });

  // ---- (18e) a watcher the user typed by hand already pushes to the remote: a user's open starts only the other one
  await check('window.user-open-skips-a-watcher-already-running-in-a-plain-shell', async function () {
    const { TerminalManager } = require(compiledModule('browser/terminal-manager.js'));
    const probe = require(compiledModule('process/theme-watcher-processes.js'));
    const manager = TerminalManager.getInstance();
    const rowsOf = function (project) {
      return manager.listSessions().filter(function (row) { return row.ownerKey === keyOf(project); });
    };
    const watchersOf = function (project) {
      return rowsOf(project).filter(function (row) { return String(row.spaceTerminalId || '').indexOf('theme-sync-') === 0; });
    };

    // hrv now stays alive the way the real watcher does; the process that runs it names the CLI.
    const stubDir = path.join(tempRoot, 'cli-stubs');
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(stubDir, 'hrv.cmd'), ['@ping -n 90 127.0.0.1 > nul', ''].join(os.EOL));
    } else {
      fs.writeFileSync(path.join(stubDir, 'hrv'), ['#!/bin/sh', 'sleep 90', ''].join(os.EOL), { mode: 0o755 });
    }
    fs.rmSync(path.join(tempRoot, 'sapo.marker'), { force: true });

    await closeWindowAndWait(keyOf(DELTA));
    for (const row of rowsOf(DELTA).filter(function (item) { return !item.splitOf; })) {
      await manager.closeSession(row.id);
    }
    expect(rowsOf(DELTA).length === 0, 'the project still owned terminals: ' + JSON.stringify(rowsOf(DELTA)));

    // A plain shell in another project window, started in this project's folder, with the
    // watcher typed into it by hand: it carries no role the app could read.
    const handId = manager.createSession(DELTA.path, undefined, keyOf(ALPHA));
    try {
      await waitFor(function () {
        const row = manager.listSessions().find(function (item) { return item.id === handId; });
        return row && row.shellPid ? true : false;
      }, 'the plain shell to have a process', 60000);
      const shellPid = manager.listSessions().find(function (item) { return item.id === handId; }).shellPid;
      manager.writeTo(handId, 'hrv theme dev' + String.fromCharCode(13));
      let covered = false;
      for (let attempt = 0; attempt < 30 && !covered; attempt++) {
        const processes = await probe.snapshotProcesses();
        covered = !!processes && probe.watchersUnder(processes, shellPid).length > 0;
        if (!covered) await sleep(1000);
      }
      expect(covered, 'the hand-typed watcher never showed in the process table');

      await openProjectFromSidebar(DELTA);
      await waitFor(function () {
        return watchersOf(DELTA).some(function (row) { return row.spaceTerminalId === 'theme-sync-sapo'; });
      }, 'the Sapo watcher, which nothing was running, to be minted', 90000);
      await sleep(1000);
      const ids = watchersOf(DELTA).map(function (row) { return row.spaceTerminalId; });
      expect(ids.length === 1 && ids[0] === 'theme-sync-sapo', 'the watchers minted were ' + JSON.stringify(ids));
    } finally {
      await manager.closeSession(handId);
    }
  });

  // ---- (18f) a project's window closes when the project stops running: terminal-lifecycle rows
  // Each row owns one project (EPSILON, GAMMA, BETA) and its cleanup hands the project back the way
  // the rows after it expect: a window and a running terminal. A window is closed and its terminals
  // are closed BEFORE a row builds its own state, so the closer sees no window while the row sets
  // up: only the edge the row names can close anything.
  const inactivityManager = function () {
    const { TerminalManager } = require(compiledModule('browser/terminal-manager.js'));
    return TerminalManager.getInstance();
  };
  const sessionRowsOf = function (project) {
    return inactivityManager().listSessions().filter(function (row) { return row.ownerKey === keyOf(project); });
  };
  const isWatcherRow = function (row) { return row.role === 'sync' || row.idlePolicy === 'never'; };
  const plainRowsOf = function (project) {
    return sessionRowsOf(project).filter(function (row) { return !row.splitOf && !isWatcherRow(row); });
  };
  const watcherMeta = { role: 'sync', idlePolicy: 'never' };
  const hiddenForLastWindow = [];
  // The close the closer decided on, as the lifecycle journal recorded it: the proof that a window
  // went because of the rule and not for an unrelated reason.
  const inactivityEvents = function () {
    const file = path.join(process.env.ANTIFAN_RUNTIME_DIR || path.join(tempRoot, 'runtime'), 'logs', 'main.log');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      return [];
    }
    const events = [];
    for (const line of text.split(String.fromCharCode(10))) {
      if (line.indexOf('project-window.close-on-inactive') === -1) continue;
      try {
        const record = JSON.parse(line);
        if (record.event === 'project-window.close-on-inactive') events.push(record);
      } catch (err) {
        // a line cut by the size rotation is not an event
      }
    }
    return events;
  };
  const closeEventFor = function (project, reason) {
    return inactivityEvents().find(function (record) { return record.projectId === project.projectId && record.reason === reason; });
  };
  // The closer settles terminal bursts for 600 ms before it reads them.
  const settleInactivity = function () { return sleep(1200); };
  const waitForSessionState = function (id, state) {
    return waitFor(function () {
      const row = inactivityManager().listSessions().find(function (item) { return item.id === id; });
      return row && row.state === state ? row : false;
    }, 'terminal ' + id + ' to be ' + state, 30000);
  };
  async function clearProjectTerminals(project) {
    const manager = inactivityManager();
    if (entryFor(project)) await closeWindowAndWait(keyOf(project));
    for (const row of sessionRowsOf(project).filter(function (item) { return !item.splitOf; })) {
      await manager.closeSession(row.id);
    }
    expect(sessionRowsOf(project).length === 0, project.name + ' still owned terminals: ' + JSON.stringify(sessionRowsOf(project)));
    await settleInactivity();
  }
  // The window a user opens, once its own sidebar has finished starting (or not starting) terminals.
  async function openWindowAndSettle(project) {
    const opened = await openProjectFromSidebar(project);
    expect(opened.result && opened.result.status === 'OPENED', 'the user open of ' + project.name + ' returned ' + JSON.stringify(opened.result));
    await chromeOf(keyOf(project), 'sidebar');
    await sleep(2500);
    return opened;
  }
  // Back to what the later rows expect: a window, and a terminal that runs in it.
  async function restoreProjectWindow(project) {
    await clearProjectTerminals(project);
    await openWindowAndSettle(project);
    if (plainRowsOf(project).filter(function (row) { return row.state === 'running'; }).length === 0) {
      const id = await inactivityManager().createSession(project.path, undefined, keyOf(project));
      await waitForSessionState(id, 'running');
      await settleInactivity();
    }
    expect(entryFor(project), project.name + ' has no window after the restore');
  }
  // A terminal that exists and runs BEFORE the project's window does, then that window opens.
  async function startTerminalThenOpenWindow(project, withWatcher) {
    const manager = inactivityManager();
    await clearProjectTerminals(project);
    const id = await manager.createSession(project.path, undefined, keyOf(project));
    await waitForSessionState(id, 'running');
    let watcherId = null;
    if (withWatcher) {
      watcherId = await manager.createSession(project.path, undefined, keyOf(project), watcherMeta);
      await waitForSessionState(watcherId, 'running');
    }
    await settleInactivity();
    expect(!entryFor(project), project.name + ' already had a window before its terminal ran');
    await openWindowAndSettle(project);
    const watcherRow = watcherId ? sessionRowsOf(project).find(function (row) { return row.id === watcherId; }) : null;
    if (watcherId) expect(watcherRow && watcherRow.role === 'sync' && watcherRow.idlePolicy === 'never', 'the watcher row was ' + JSON.stringify(watcherRow));
    return { id: id, watcherId: watcherId };
  }
  // Every OTHER plain terminal the window's own sidebar may have started sleeps first: the project
  // must still count as running until the terminal the row names is the last one.
  async function sleepOtherPlainTerminals(project, keepId) {
    const manager = inactivityManager();
    const others = plainRowsOf(project).filter(function (row) { return row.id !== keepId && row.state === 'running'; });
    for (const row of others) {
      const result = manager.sleepSession(row.id);
      expect(result.ok === true, 'sleeping the sidebar terminal ' + row.id + ' returned ' + JSON.stringify(result));
    }
    if (others.length > 0) {
      await settleInactivity();
      expect(entryFor(project), project.name + ' closed while its terminal ' + keepId + ' still ran');
    }
    return others.length;
  }

  await check('window.project-window-closes-when-its-last-running-terminal-sleeps', async function () {
    const manager = inactivityManager();
    const started = await startTerminalThenOpenWindow(EPSILON, false);
    // The window was opened after the terminal ran. Another window stays on screen, so this one is
    // not the last visible window and nothing but the terminal's state can close it.
    expect(entryFor(EPSILON).visible === true, 'the window of ' + EPSILON.name + ' is not on screen');
    expect(entryFor(ALPHA) && entryFor(ALPHA).visible === true, 'no other project window is on screen');
    const extra = await sleepOtherPlainTerminals(EPSILON, started.id);
    const keysBeforeSleep = authority.snapshot().map(function (entry) { return entry.ownerKey; });
    const slept = manager.sleepSession(started.id);
    expect(slept && slept.ok === true, 'sleeping the last running terminal returned ' + JSON.stringify(slept));
    await waitFor(function () { return !entryFor(EPSILON) && authority.hostForOwner(keyOf(EPSILON)) === null ? true : false; }, 'the window of ' + EPSILON.name + ' to close after its last terminal slept', 5000);
    await waitFor(function () { return closeEventFor(EPSILON, 'terminals-stopped') ? true : false; }, 'the journal to record why ' + EPSILON.name + ' closed', 5000);
    const survivors = authority.snapshot().map(function (entry) { return entry.ownerKey; });
    observations.inactivityClose = { sidebarTerminalsSleptFirst: extra, remaining: survivors };
    expect(entryFor(ALPHA) && entryFor(ALPHA).visible === true, 'the other window did not survive');
    for (const key of keysBeforeSleep) {
      if (key !== keyOf(EPSILON)) expect(survivors.indexOf(key) !== -1, key + ' closed with ' + EPSILON.name + ': ' + JSON.stringify(survivors));
    }
    expect(survivors.indexOf('unassigned') !== -1, 'the Terminal Manager closed');
    const row = manager.listSessions().find(function (item) { return item.id === started.id; });
    expect(row && row.state === 'sleeping', 'the terminal that slept is ' + JSON.stringify(row && row.state));
  }, async function () { await restoreProjectWindow(EPSILON); });

  await check('window.last-visible-project-window-stays-when-its-last-terminal-sleeps', async function () {
    const manager = inactivityManager();
    const started = await startTerminalThenOpenWindow(EPSILON, false);
    await sleepOtherPlainTerminals(EPSILON, started.id);
    // Every other window leaves the screen (hidden, never closed): this one is the only window a
    // user can see, and ending it would end the application.
    for (const entry of authority.snapshot()) {
      if (entry.ownerKey === keyOf(EPSILON)) continue;
      const win = authority.windowFor(entry.ownerKey);
      expect(win && !win.isMinimized(), entry.ownerKey + ' is minimized, which still counts as on screen');
      hiddenForLastWindow.push(win);
      win.hide();
    }
    const onScreen = authority.snapshot().filter(function (entry) { return entry.visible === true; }).map(function (entry) { return entry.ownerKey; });
    expect(JSON.stringify(onScreen) === JSON.stringify([keyOf(EPSILON)]), 'the windows still on screen were ' + JSON.stringify(onScreen));
    const slept = manager.sleepSession(started.id);
    expect(slept && slept.ok === true, 'sleeping the last running terminal returned ' + JSON.stringify(slept));
    // The check runs 600 ms after the burst: an absence needs a real wait that outlasts it.
    await sleep(2500);
    expect(entryFor(EPSILON) && authority.windowFor(keyOf(EPSILON)) && !authority.windowFor(keyOf(EPSILON)).isDestroyed(), 'the last visible window closed with its terminal');
    expect(authority.windowFor(keyOf(EPSILON)).isVisible() === true, 'the last visible window left the screen');
    const row = manager.listSessions().find(function (item) { return item.id === started.id; });
    expect(row && row.state === 'sleeping', 'the terminal that slept is ' + JSON.stringify(row && row.state));
  }, async function () {
    for (const win of hiddenForLastWindow.splice(0)) {
      if (!win.isDestroyed()) win.showInactive();
    }
    await restoreProjectWindow(EPSILON);
  });

  await check('window.project-window-closes-when-only-a-sync-watcher-keeps-running', async function () {
    const manager = inactivityManager();
    const started = await startTerminalThenOpenWindow(GAMMA, true);
    expect(entryFor(ALPHA) && entryFor(ALPHA).visible === true, 'no other project window is on screen');
    // The watcher refuses to sleep: it is infrastructure the app keeps alive, not work.
    const refused = manager.sleepSession(started.watcherId);
    expect(refused && refused.ok === false && refused.reason === 'SLEEP_REFUSED_WATCHER', 'sleeping the watcher returned ' + JSON.stringify(refused));
    await sleepOtherPlainTerminals(GAMMA, started.id);
    const slept = manager.sleepSession(started.id);
    expect(slept && slept.ok === true, 'sleeping the plain terminal returned ' + JSON.stringify(slept));
    await waitFor(function () { return !entryFor(GAMMA) && authority.hostForOwner(keyOf(GAMMA)) === null ? true : false; }, 'the window of ' + GAMMA.name + ' to close while only its watcher runs', 5000);
    const watcher = sessionRowsOf(GAMMA).find(function (row) { return row.id === started.watcherId; });
    expect(watcher && watcher.state === 'running', 'the watcher is ' + JSON.stringify(watcher && watcher.state) + ': closing the window must leave it running');
    expect(entryFor(ALPHA) && entryFor(BETA), 'another window closed with it');
  }, async function () { await restoreProjectWindow(GAMMA); });

  await check('window.project-window-whose-only-terminals-are-sync-watchers-stays-open', async function () {
    const manager = inactivityManager();
    await clearProjectTerminals(BETA);
    const watcherId = await manager.createSession(BETA.path, undefined, keyOf(BETA), watcherMeta);
    await waitForSessionState(watcherId, 'running');
    await settleInactivity();
    await openWindowAndSettle(BETA);
    const plain = plainRowsOf(BETA);
    expect(plain.length === 0, 'the window started a plain terminal of its own, so it is not watcher-only: ' + JSON.stringify(plain));
    // A real wait: the claim is that nothing happens, and an event that never comes cannot be awaited.
    await sleep(2500);
    expect(entryFor(BETA), 'the window with only a watcher closed');
    const watcher = sessionRowsOf(BETA).find(function (row) { return row.id === watcherId; });
    expect(watcher && watcher.state === 'running', 'the watcher is ' + JSON.stringify(watcher && watcher.state));
  }, async function () { await restoreProjectWindow(BETA); });

  await check('window.terminal-manager-close-closes-windows-of-projects-with-only-sleeping-terminals', async function () {
    const manager = inactivityManager();
    const restoreManager = async function () {
      if (!entryOf(authority.snapshot(), 'unassigned')) {
        const item = findMenuItem(Menu.getApplicationMenu(), 'Cửa sổ Terminal chung (Shared Terminal Manager)');
        expect(item && item.enabled === true, 'the Terminal menu cannot reopen the manager');
        item.click(item, authority.windowFor(keyOf(ALPHA)), {});
        await waitFor(function () {
          const entry = entryOf(authority.snapshot(), 'unassigned');
          return entry && entry.visible === true ? entry : false;
        }, 'the Terminal Manager to come back');
      }
    };
    try {
      // Y (BETA): terminals that only sleep. They slept while the window did not exist, so no
      // running -> not running edge was ever seen with a window to close.
      await clearProjectTerminals(BETA);
      const sleeperId = await manager.createSession(BETA.path, undefined, keyOf(BETA));
      await waitForSessionState(sleeperId, 'running');
      const parked = manager.sleepSession(sleeperId);
      expect(parked && parked.ok === true, 'sleeping the terminal of ' + BETA.name + ' returned ' + JSON.stringify(parked));
      await waitForSessionState(sleeperId, 'sleeping');
      await settleInactivity();
      await openWindowAndSettle(BETA);
      // The never-seen-running rule: the window outlives the debounce and the sidebar's start.
      expect(entryFor(BETA), 'the window of a project that never ran closed on open');
      const runningPlain = plainRowsOf(BETA).filter(function (row) { return row.state === 'running'; });
      expect(runningPlain.length === 0, 'the window started a running terminal, so ' + BETA.name + ' is not sleeping-only: ' + JSON.stringify(runningPlain));

      // Z (GAMMA): a window whose only terminal is a sync watcher is not a project with terminals.
      await clearProjectTerminals(GAMMA);
      const watcherId = await manager.createSession(GAMMA.path, undefined, keyOf(GAMMA), watcherMeta);
      await waitForSessionState(watcherId, 'running');
      await settleInactivity();
      await openWindowAndSettle(GAMMA);
      expect(entryFor(GAMMA), 'the watcher-only window closed on open');
      expect(plainRowsOf(GAMMA).length === 0, 'the window of ' + GAMMA.name + ' started a plain terminal: ' + JSON.stringify(plainRowsOf(GAMMA)));

      // R (ALPHA): a project that runs, so a live window must outlast the manager.
      if (plainRowsOf(ALPHA).filter(function (row) { return row.state === 'running'; }).length === 0) {
        const runningId = await manager.createSession(ALPHA.path, undefined, keyOf(ALPHA));
        await waitForSessionState(runningId, 'running');
        await settleInactivity();
      }
      const keysBefore = authority.snapshot().map(function (entry) { return entry.ownerKey; });

      const managerHost = authority.hostForOwner('unassigned');
      if (managerHost) managerHost.setAutomationTabId(undefined);
      await closeWindowAndWait('unassigned');

      await waitFor(function () { return !entryFor(BETA) && authority.hostForOwner(keyOf(BETA)) === null ? true : false; }, 'the window of ' + BETA.name + ' (sleeping terminals only) to close with the Terminal Manager', 8000);
      await settleInactivity();
      observations.inactivityManagerClose = {
        before: keysBefore,
        after: authority.snapshot().map(function (entry) { return entry.ownerKey; }),
      };
      expect(entryFor(GAMMA), 'the window with only a watcher closed with the Terminal Manager');
      expect(entryFor(ALPHA), 'the window of the running project closed with the Terminal Manager');
      expect(app.isReady() === true, 'the app is no longer ready');
      const row = manager.listSessions().find(function (item) { return item.id === sleeperId; });
      expect(row && row.state === 'sleeping', 'closing the window changed the sleeping terminal to ' + JSON.stringify(row && row.state));
      await waitFor(function () { return closeEventFor(BETA, 'terminal-manager-closed') ? true : false; }, 'the journal to record why ' + BETA.name + ' closed', 5000);
      expect(!closeEventFor(GAMMA, 'terminal-manager-closed') && !closeEventFor(ALPHA, 'terminal-manager-closed'), 'the closer reported closing a window that must stay: ' + JSON.stringify(inactivityEvents()));
    } finally {
      await restoreManager();
    }
  }, async function () {
    observations.inactivityJournal = inactivityEvents().map(function (record) { return { iso: record.iso, projectId: record.projectId, reason: record.reason }; });
    // The manager is back (the row's own finally), now every project gets its window and a
    // running terminal again: the Terminal Manager close that follows expects all five.
    for (const project of PROJECTS) {
      if (project === ALPHA) continue;
      if (project === DELTA) {
        if (!entryFor(DELTA)) await openProjectFromSidebar(DELTA);
        continue;
      }
      await restoreProjectWindow(project);
    }
  });

  // ---------- (19) closing the Terminal Manager keeps every project window and its tabs
  await check('window.close-terminal-manager-keeps-project-windows', async function () {
    const before = authority.snapshot();
    const tabsBefore = {};
    for (const project of PROJECTS) {
      const entry = entryOf(before, keyOf(project));
      tabsBefore[project.projectId] = { tabIds: entry.tabIds.slice(), active: entry.activeTabId, windowId: entry.windowId };
    }
    managerWindowBeforeClose = authority.windowFor('unassigned');
    expect(managerWindowBeforeClose && !managerWindowBeforeClose.isDestroyed(), 'the Terminal Manager has no native window');
    // Nothing is bound to the manager's pages here, so this is the idle close the spec describes.
    const managerHost = authority.hostForOwner('unassigned');
    if (managerHost) managerHost.setAutomationTabId(undefined);

    await closeWindowAndWait('unassigned');
    const after = authority.snapshot();
    observations.closeManager = { remaining: after.map(function (entry) { return entry.ownerKey; }), shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 5, 'browserShellCount() was ' + authority.browserShellCount());
    expect(!entryOf(after, 'unassigned'), 'the closed Terminal Manager is still in the directory');
    for (const project of PROJECTS) {
      const entry = entryOf(after, keyOf(project));
      expect(entry, project.name + ' disappeared with the Terminal Manager');
      expect(entry.windowId === tabsBefore[project.projectId].windowId, project.name + ' changed window');
      expect(JSON.stringify(entry.tabIds) === JSON.stringify(tabsBefore[project.projectId].tabIds), project.name + ' tabs changed from ' + JSON.stringify(tabsBefore[project.projectId].tabIds) + ' to ' + JSON.stringify(entry.tabIds));
      expect(entry.activeTabId === tabsBefore[project.projectId].active, project.name + ' changed its active tab when the Terminal Manager closed');
      expect(authority.windowFor(keyOf(project)) && !authority.windowFor(keyOf(project)).isDestroyed(), project.name + ' native window was destroyed');
      for (const tabId of entry.tabIds) expect(authority.hostForTab(tabId) === hostOf(project), 'tab ' + tabId + ' no longer resolves to ' + project.name);
    }
    expect(authority.hostForOwner('unassigned') === null, 'the closed Terminal Manager still has a host');
    expect(app.isReady() === true, 'the app is no longer ready after a window closed');
  });

  // --------------------- (20) the surviving windows' toolbar and accelerator paths still work
  await check('window.survivor-toolbar-and-accelerator-after-sibling-close', async function () {
    const host = hostOf(ALPHA);
    const other = hostOf(BETA);
    const toolbarTab = await createTabIn(ALPHA, 'survivor-toolbar');
    await waitFor(function () { return host.getActiveTabId() === toolbarTab; }, "the surviving window's toolbar tab to become active");

    // The application menu's New Tab carries the keyboard accelerator; invoking its handler with
    // this window is the command that accelerator dispatches, resolved per window by the directory.
    const menu = Menu.getApplicationMenu();
    const newTabItem = findMenuItem(menu, 'New Tab');
    expect(newTabItem && typeof newTabItem.click === 'function', 'the application menu has no invokable New Tab item');
    expect(String(newTabItem.accelerator || '') === 'CmdOrCtrl+T', 'the New Tab accelerator was ' + String(newTabItem.accelerator));
    const window = authority.windowFor(keyOf(ALPHA));
    const beforeAccelerator = host.getTabList().map(function (tab) { return tab.id; });
    const otherBefore = other.getTabList().map(function (tab) { return tab.id; });
    newTabItem.click(newTabItem, window, {});
    await waitFor(function () { return host.getTabList().length === beforeAccelerator.length + 1; }, "the accelerator's command to create a tab");
    const createdByAccelerator = host.getTabList().map(function (tab) { return tab.id; }).filter(function (tabId) { return beforeAccelerator.indexOf(tabId) === -1; });
    expect(createdByAccelerator.length === 1, "the accelerator's command created " + createdByAccelerator.length + ' tabs: ' + JSON.stringify(createdByAccelerator));
    observations.survivorPaths = {
      toolbarTab: toolbarTab,
      acceleratorTab: createdByAccelerator[0],
      acceleratorActive: host.getActiveTabId(),
      windowCount: authority.browserShellCount(),
    };
    expect(createdByAccelerator[0] !== toolbarTab, 'the accelerator reused the tab the toolbar had just created');
    expect(host.getActiveTabId() === createdByAccelerator[0], "the accelerator's tab did not become active in the window it resolved");
    expect(JSON.stringify(other.getTabList().map(function (tab) { return tab.id; })) === JSON.stringify(otherBefore), 'the accelerator created a tab in another window');
    expect(host.getTabList().find(function (tab) { return tab.id === createdByAccelerator[0]; }).projectId === ALPHA.projectId, 'the accelerator tab was stamped for another project');

    // A window no shell describes refuses the command instead of acting on another window. Both
    // handler paths are synchronous, so a tab created for either would already be in the
    // directory: the bounded re-read is what makes the absence an observation, not one sample.
    const totalBefore = PROJECTS.reduce(function (sum, project) { return sum + hostOf(project).getTabList().length; }, 0);
    expect(managerWindowBeforeClose.isDestroyed() === true, 'the closed window unexpectedly survived for the refusal case');
    newTabItem.click(newTabItem, managerWindowBeforeClose, {});
    newTabItem.click(newTabItem, null, {});
    for (let round = 0; round < 3; round += 1) {
      await sleep(100);
      const total = PROJECTS.reduce(function (sum, project) { return sum + hostOf(project).getTabList().length; }, 0);
      expect(total === totalBefore, 'a menu command for a window no shell describes created a tab somewhere else');
    }
  });

  // ------------- (21) the menu brings the Terminal Manager back without touching the windows
  await check('window.terminal-manager-menu-reopens-it-beside-project-windows', async function () {
    const before = authority.snapshot().map(function (entry) { return [entry.ownerKey, entry.windowId]; });
    const item = findMenuItem(Menu.getApplicationMenu(), 'Cửa sổ Terminal chung (Shared Terminal Manager)');
    expect(item, 'the Terminal menu has no shared-manager entry');
    expect(item.enabled === true, 'the shared-manager entry is disabled');
    item.click(item, authority.windowFor(keyOf(ALPHA)), {});
    const manager = await waitFor(function () {
      const entry = entryOf(authority.snapshot(), 'unassigned');
      return entry && entry.visible === true ? entry : false;
    }, 'the Terminal Manager to come back');
    expect(manager.tabIds.length === 0, 'the reopened Terminal Manager holds tabs');
    expect(authority.browserShellCount() === 6, 'browserShellCount() was ' + authority.browserShellCount());
    for (const pair of before) {
      const entry = entryOf(authority.snapshot(), pair[0]);
      expect(entry && entry.windowId === pair[1], pair[0] + ' changed window when the Terminal Manager reopened');
    }
    // One Terminal Manager only: a second request joins it.
    item.click(item, authority.windowFor(keyOf(ALPHA)), {});
    await sleep(300);
    expect(authority.browserShellCount() === 6, 'a second request opened another window: ' + authority.browserShellCount());
  });

  // ------------------------------------------------------------- (22) orderly owned teardown
  await check('window.cleanup-closes-every-shell', async function () {
    for (const entry of authority.snapshot()) {
      authority.requestClose(entry.ownerKey);
    }
    await waitFor(function () { return authority.browserShellCount() === 0; }, 'every remaining browser shell to close');
    observations.teardown = { shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 0, 'browserShellCount() was ' + authority.browserShellCount());
  });
}

// ---------------------------------------------------------------------------------------------
// Scenario: migration
// ---------------------------------------------------------------------------------------------
const describeRecord = function (record) {
  const tabs = record && Array.isArray(record.tabs) ? record.tabs : [];
  const active = tabs.find(function (tab) { return tab.id === record.activeTabId; });
  return {
    urls: tabs.map(function (tab) { return tab.url; }),
    stamps: tabs.map(function (tab) { return typeof tab.projectId === 'string' ? tab.projectId : null; }),
    activeUrl: active ? active.url : null,
  };
};
const describeHost = function (host) {
  const tabs = host.getTabList();
  const active = tabs.find(function (tab) { return tab.id === host.getActiveTabId(); });
  return {
    urls: tabs.map(function (tab) { return tab.url; }),
    stamps: tabs.map(function (tab) { return typeof tab.projectId === 'string' ? tab.projectId : null; }),
    activeUrl: active ? active.url : null,
  };
};

async function runMigration() {
  const expectedWindows = [keyOf(ALPHA), keyOf(BETA)].sort();
  observations.migration = { ownerKeys: [], backupName: null, documentVersion: null, ownerRecords: {}, liveTabs: {} };

  await check('migration.windows-reopen-for-the-presented-and-ledger-projects', async function () {
    await waitForBootComplete();
    const keys = ownerKeys();
    observations.migration.ownerKeys = keys;
    // The project the shared window was presenting and the project the ledger lists get their
    // own windows. GAMMA's record is marked detached but its window is not in the ledger, so
    // the marker opens nothing; the ledger's unknown project and the placeholder never open.
    expect(JSON.stringify(keys) === JSON.stringify(expectedWindows), 'the boot opened windows ' + JSON.stringify(keys) + ', expected ' + JSON.stringify(expectedWindows));
    expect(authority.browserShellCount() === 2, 'browserShellCount() was ' + authority.browserShellCount());
    expect(authority.shellFor('web') === null && authority.hostForOwner('web') === null, "a 'web' window exists");
    expect(authority.shellFor(keyOf(GAMMA)) === null, 'the detached marker opened a window for ' + GAMMA.name);
    expect(authority.shellFor('project:' + UNRECORDED.projectId) === null, 'the ledger opened a window for a project nothing records');
    expect(authority.shellFor('project:' + LEGACY_BOOT_PROJECT_ID) === null, 'the placeholder boot project opened a window');
    expect(authority.shellFor('unassigned') === null, 'the Terminal Manager opened though the ledger did not list it');
    for (const project of [ALPHA, BETA]) {
      const entry = entryFor(project);
      expect(entry.visible === true, project.name + ' was never presented');
      expect(entry.title === project.name, project.name + ' was titled ' + String(entry.title));
    }
  });

  await check('migration.saved-tabs-document-upgraded-with-a-backup', async function () {
    const { dir, saved } = legacyEnvelope();
    const document = await waitFor(function () {
      const parsed = readJson(saved);
      return parsed && parsed.version === 3 ? parsed : false;
    }, 'saved-tabs.json to be at version 3');
    observations.migration.documentVersion = document.version;
    expect(document.version === 3, 'the document version was ' + String(document.version));
    expect(!('web' in document.owners), "the document still carries a 'web' owner: " + JSON.stringify(Object.keys(document.owners)));
    expect(!(('project:' + LEGACY_BOOT_PROJECT_ID) in document.owners), 'the document still carries the placeholder project owner');
    for (const [key, record] of Object.entries(document.owners)) {
      expect(!('detached' in record), key + ' still carries a detached marker');
      expect(!('activeProjectId' in record), key + ' still carries an activeProjectId');
    }
    // Exactly one backup, written before the rewrite, byte-identical to what the old layout wrote.
    const backups = fs.readdirSync(dir).filter(function (name) { return /^saved-tabs\\.json\\.pre-project-windows-[0-9]{14}(-[0-9]+)?\\.bak$/.test(name); });
    observations.migration.backupName = backups[0] || null;
    expect(backups.length === 1, 'the profile holds ' + backups.length + ' backups: ' + JSON.stringify(fs.readdirSync(dir)));
    const backupText = fs.readFileSync(path.join(dir, backups[0]), 'utf8');
    expect(backupText === seededSavedTabsText, 'the backup is not the document the old layout wrote');
    const backup = JSON.parse(backupText);
    expect(backup.version === 2 && backup.owners.web && backup.owners.web.tabs.length === 5, 'the backup is not the version 2 document');
  });

  await check('migration.each-tab-lands-under-its-projects-owner', async function () {
    const document = await waitFor(function () {
      const parsed = readJson(legacyEnvelope().saved);
      return parsed && parsed.version === 3 ? parsed : false;
    }, 'saved-tabs.json to be at version 3');
    const records = {};
    for (const [key, record] of Object.entries(document.owners)) records[key] = describeRecord(record);
    observations.migration.ownerRecords = records;
    const page = function (name) { return pageUrl('legacy-' + name); };
    const alpha = records[keyOf(ALPHA)];
    const beta = records[keyOf(BETA)];
    const gamma = records[keyOf(GAMMA)];
    expect(alpha, "the document has no record for the presented project's window");
    expect(beta, "the document has no record for the ledger project's window");
    expect(gamma, "the document has no record for the detached project");
    // The rows stamped for the presented project, the unstamped row and the row stamped with
    // the placeholder all follow the presented project; each tab is stamped with it.
    expect(JSON.stringify(alpha.urls) === JSON.stringify([page('w1'), page('w3'), page('w4'), page('w5')]), 'the presented project record held ' + JSON.stringify(alpha.urls));
    expect(alpha.stamps.every(function (stamp) { return stamp === ALPHA.projectId; }), 'the presented project record stamps were ' + JSON.stringify(alpha.stamps));
    expect(alpha.activeUrl === page('w3'), "the presented project's active tab was " + String(alpha.activeUrl));
    // The row stamped for the other project moved to that project's own record.
    expect(JSON.stringify(beta.urls) === JSON.stringify([page('w2')]) && beta.stamps[0] === BETA.projectId, 'the second project record held ' + JSON.stringify(beta));
    // The detached project's record keeps its row under its own owner.
    expect(JSON.stringify(gamma.urls) === JSON.stringify([page('d1')]) && gamma.stamps[0] === GAMMA.projectId, 'the detached project record held ' + JSON.stringify(gamma));
    // No row was lost or duplicated, and none sits under an owner of another project.
    const everyUrl = Object.keys(records).reduce(function (all, key) { return all.concat(records[key].urls); }, []).sort();
    const expectedUrls = ['w1', 'w2', 'w3', 'w4', 'w5', 'd1'].map(page).sort();
    expect(JSON.stringify(everyUrl) === JSON.stringify(expectedUrls), 'the document held tabs ' + JSON.stringify(everyUrl));
  });

  await check('migration.restored-windows-hold-their-migrated-tabs-live', async function () {
    const page = function (name) { return pageUrl('legacy-' + name); };
    const alpha = hostOf(ALPHA);
    const beta = hostOf(BETA);
    await waitFor(function () { return alpha.getTabList().length === 4 && beta.getTabList().length === 1; }, 'both windows to restore their tabs');
    const live = { alpha: describeHost(alpha), beta: describeHost(beta) };
    observations.migration.liveTabs = {};
    observations.migration.liveTabs[keyOf(ALPHA)] = live.alpha;
    observations.migration.liveTabs[keyOf(BETA)] = live.beta;
    expect(JSON.stringify(live.alpha.urls) === JSON.stringify([page('w1'), page('w3'), page('w4'), page('w5')]), 'the presented project window holds ' + JSON.stringify(live.alpha.urls));
    expect(live.alpha.stamps.every(function (stamp) { return stamp === ALPHA.projectId; }), 'the presented project window stamps were ' + JSON.stringify(live.alpha.stamps));
    expect(live.alpha.activeUrl === page('w3'), "the presented project window's active tab was " + String(live.alpha.activeUrl));
    expect(JSON.stringify(live.beta.urls) === JSON.stringify([page('w2')]) && live.beta.stamps[0] === BETA.projectId, 'the second window holds ' + JSON.stringify(live.beta));
    for (const tab of alpha.getTabList()) expect(authority.hostForTab(tab.id) === alpha, 'tab ' + tab.id + ' does not route to the presented project window');
    for (const tab of beta.getTabList()) expect(authority.hostForTab(tab.id) === beta, 'tab ' + tab.id + ' does not route to the second window');
  });

  await check('migration.cleanup-closes-every-shell', async function () {
    for (const entry of authority.snapshot()) {
      authority.requestClose(entry.ownerKey);
    }
    await waitFor(function () { return authority.browserShellCount() === 0; }, 'every remaining browser shell to close');
    observations.teardown = { shellCount: authority.browserShellCount() };
    expect(authority.browserShellCount() === 0, 'browserShellCount() was ' + authority.browserShellCount());
  });
}

async function run() {
  authority = mainProcess.projectWindowAuthority;
  await app.whenReady();
  if (SCENARIO === 'migration') await runMigration();
  else await runLifecycle();
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
    pageServer.close();
  } catch (err) {
    console.log('  NOTE  page server could not close: ' + messageOf(err));
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
      scenario: SCENARIO_NAME,
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

interface ScenarioRun {
  evidence: DriverEvidence;
  transcript: string;
}

/**
 * Launch one scenario through the repository's Electron runner and return what it reported.
 * Every assertion about the run's exit, transcript and receipt that holds for both scenarios
 * lives here, so neither scenario can quietly skip one.
 */
async function runScenario(scenario: Scenario): Promise<ScenarioRun> {
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
  const evidencePath = path.resolve(rootDir, evidencePathFor(scenario));
  fs.writeFileSync(driverPath, PROJECT_WINDOWS_DRIVER_SOURCE, 'utf8');
  try { fs.unlinkSync(evidencePath); } catch {}

  try {
    // A broken scenario must fail here rather than half-way through an Electron boot.
    const syntax = spawnSync(process.execPath, ['--check', driverPath], { encoding: 'utf8' });
    assert.equal(syntax.status, 0, `the generated driver does not parse:\n${syntax.stdout}\n${syntax.stderr}`);

    const bridgePort = await pickFreePort();
    const pagePort = await pickFreePort();
    const env: NodeJS.ProcessEnv = {};
    // A developer shell carries the live app's bridge, data root and terminal identity; none of
    // it may reach the app under test. The driver sets its own throwaway values.
    for (const [name, value] of Object.entries(process.env)) {
      if (name.startsWith('ANTIFAN_') && !name.startsWith('ANTIFAN_E2E_')) continue;
      env[name] = value;
    }
    delete env.ELECTRON_RUN_AS_NODE;
    env.ANTIFAN_DRIVER_REPO_ROOT = rootDir;
    env.ANTIFAN_DRIVER_EVIDENCE = evidencePath;
    env.ANTIFAN_DRIVER_BRIDGE_PORT = String(bridgePort);
    env.ANTIFAN_DRIVER_PAGE_PORT = String(pagePort);
    env.ANTIFAN_DRIVER_SCENARIO = scenario;
    env.ANTIFAN_DRIVER_EXPECTED_ROWS = JSON.stringify(ROWS_BY_SCENARIO[scenario]);

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
    assert.equal(timedOut, false, `the ${scenario} scenario timed out after ${RUN_TIMEOUT_MS}ms; killed child exited with code ${exit.code}, signal ${exit.signal}\n${transcript}`);
    // The single-instance lock is keyed by the profile this run created; a refusal here would
    // mean the scenario attached to someone else's instance instead of its own.
    assert.ok(!stdout.includes('Another instance is already running'), `the run was refused the single-instance lock\n${transcript}`);
    assert.equal(exit.code, 0, `the ${scenario} scenario must exit cleanly\n${transcript}`);
    assert.match(stdout, /\[project-windows-e2e\] \d+ passed, 0 failed/);
    assert.ok(fs.existsSync(evidencePath), `the scenario wrote no evidence at ${evidencePath}\n${transcript}`);

    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as DriverEvidence;
    assert.equal(evidence.scenario, `project-windows-${scenario}`);
    assert.equal(evidence.failed, 0, `the scenario reported failures: ${JSON.stringify(evidence.checks.filter((row) => !row.ok))}`);

    const expectedRows = ROWS_BY_SCENARIO[scenario];
    const reported = evidence.checks.map((row) => row.name);
    for (const name of expectedRows) {
      assert.ok(reported.includes(name), `the driver never reported row ${name}`);
    }
    // A row the suite does not know may only ever arrive failing: the driver's own
    // "unexpected throw" row is the one legitimate extra, and renaming a real row still trips
    // the loop above.
    const unexpected = evidence.checks.filter((row) => row.ok && !expectedRows.includes(row.name));
    assert.deepEqual(unexpected, [], 'the driver reported a passing row the suite does not know about');
    for (const row of evidence.checks) {
      assert.equal(row.ok, true, `row ${row.name} failed: ${row.error}`);
    }
    assert.deepEqual(evidence.deferred, [...DEFERRED_ROWS], 'the deferred-row list changed without the suite following');
    return { evidence, transcript };
  } finally {
    fs.rmSync(driverDir, { recursive: true, force: true });
  }
}

describe('Live E2E: one window per project', () => {
  it('certifies per-project windows, stamps, search, close and survivor paths in the real app', async () => {
    const { evidence } = await runScenario('lifecycle');
    const observations = evidence.observations;

    const boot = observations.boot;
    assert.ok(boot, 'the boot row recorded no evidence');
    assert.deepEqual(boot.ownerKeys, ['unassigned'], 'a fresh profile must open only the Terminal Manager');
    assert.equal(boot.shellCount, 1, 'the process did not start with exactly one browser shell');
    assert.equal(boot.terminalManagerTabs, 0, 'the Terminal Manager hosts browser tabs');

    // A project open creates that project's own window; the same open again joins it.
    assert.equal(observations.firstOpen?.status, 'OPENED', 'the first open did not create the project window');
    assert.equal(observations.firstOpen?.ownerKey, 'project:project-00000000-0000-4000-8000-0000000000a1');
    assert.equal(observations.duplicateOpen?.status, 'FOCUSED', 'the duplicate open did not focus the existing window');
    assert.equal(observations.duplicateOpen?.windowId, observations.firstOpen?.windowId, 'the duplicate open presented another window');
    assert.equal(observations.duplicateOpen?.shellCount, 2, 'the duplicate open created a window');
    assert.equal(observations.secondOpen?.status, 'OPENED', 'the second project did not get a window');
    assert.notEqual(observations.secondOpen?.windowId, observations.firstOpen?.windowId, 'two projects share a window');
    assert.equal(observations.secondOpen?.shellCount, 3, 'the second project open did not produce exactly one more window');
    assert.equal(observations.unknownProject?.status, 'FAILED');
    assert.equal(observations.unknownProject?.reason, 'UNKNOWN_PROJECT');

    assert.equal(observations.volume?.shellCount, 6, 'five projects produced more than five windows plus the Terminal Manager');
    assert.equal(observations.volume?.stampedCount, 20, 'the windows did not stamp twenty tabs across five projects');
    // The search is process-wide: it returns every user-visible tab of every window.
    assert.ok((observations.volume?.inventoryRows ?? 0) >= 20, 'the search did not list every stamped tab');
    assert.equal(observations.teardown?.shellCount, 0, 'the run left browser shells behind');
    // The raster is claimed only where the windows could be shown side by side; the run says
    // which of the two it did, and a stacked run must not claim pixels it never took.
    const surface = observations.backgroundSurface;
    assert.ok(surface, 'the background row recorded no evidence');
    if (surface.mode === 'tiled') {
      assert.ok(observations.backgroundCapture, 'a tiled run must produce the background capture');
      assert.ok(observations.backgroundCapture.bytes > 0, 'the background capture produced no pixels');
      assert.ok(observations.backgroundCapture.rasterSize.width > 0);
    } else {
      assert.equal(surface.mode, 'stacked');
      assert.equal(observations.backgroundCapture, null, 'an untiled run must not claim a background capture');
    }
    assert.equal(observations.staleActivation?.closedTab.reasonCode, 'TAB_CLOSED');
    assert.equal(observations.closeProject?.shellCount, 5, 'closing a project window did not leave the other five windows');
    assert.ok(!observations.closeProject?.remaining.includes('project:project-00000000-0000-4000-8000-0000000000d4'), 'the closed project window is still listed');
    assert.equal(observations.closeManager?.shellCount, 5, 'closing the Terminal Manager did not leave the five project windows');
    assert.ok(!observations.closeManager?.remaining.includes('unassigned'), 'the closed Terminal Manager is still listed');
    assert.ok(
      observations.survivorPaths && observations.survivorPaths.acceleratorTab !== observations.survivorPaths.toolbarTab,
      'the accelerator path did not act on the surviving window',
    );

    // The join rows carry their own recorded evidence: a popup's affiliation, a minimized
    // window's target, an agent-opened window and the session boundary.
    const popup = observations.nativePopup;
    assert.ok(popup, 'the popup row recorded no affiliation evidence');
    assert.equal(popup.capsuleId, popup.parentCapsuleId, 'the popup did not record its parent capsule');
    assert.notEqual(popup.capsuleId, 'capsule-pw-b2', 'the popup took the globally rotated capsule instead of its parent');
    assert.equal(popup.projectId, 'project-00000000-0000-4000-8000-0000000000a1', 'the popup did not keep its opener tab stamp');
    assert.equal(popup.hostOwnerKey, 'project:project-00000000-0000-4000-8000-0000000000a1', 'the popup landed in another window');
    assert.ok(popup.partition.startsWith('persist:'), `the popup did not run in a durable partition: ${popup.partition}`);
    assert.ok(
      popup.userAgentMode === 'clean' || popup.userAgentMode === 'native',
      `the popup user agent mode was unassigned: ${popup.userAgentMode}`,
    );
    assert.equal(popup.userAgentMode, popup.parentUserAgentMode, 'the popup did not inherit its parent user agent mode');

    const target = observations.minimizeRestore;
    assert.ok(target, 'the minimize/restore row recorded no window-state evidence');
    assert.equal(target.invalidTarget.adopted, null, 'a refused target recorded an adopted tab');
    assert.equal(target.foreignTarget.adopted, null, "a window adopted another window's tab as its target");
    assert.equal(target.minimized.target, target.restored.target, 'minimize/restore moved the window target');

    const agentEnsure = observations.agentEnsure;
    assert.ok(agentEnsure, 'the agent-ensure row recorded no evidence');
    assert.equal(agentEnsure.created, true, 'the agent ensure joined a window instead of opening one');
    assert.equal(agentEnsure.entry.ownerKey, 'project:project-00000000-0000-4000-8000-0000000000d4', "the agent's ensure resolved to another window");
    assert.equal(agentEnsure.visibleAfterEnsure, false, 'the agent-opened window was presented');
    assert.deepEqual(agentEnsure.callsForWindow, [], 'the agent-opened window was presented');
    assert.deepEqual(agentEnsure.callsForOtherWindows, [], 'the ensure presented other windows');
    assert.equal(agentEnsure.restoredTabCount, 4, 'the reopened window did not restore its four tabs');
    assert.equal(agentEnsure.restoredLocalUrls.length, 3, 'the reopened window did not restore the pages it had');

    const sessions = observations.sameProjectSessions;
    assert.ok(sessions, 'the session row recorded no boundary evidence');
    assert.equal(sessions.crossRefused, false, 'the same-project sibling read was refused: ' + sessions.crossText);
    assert.equal(sessions.crossWriteRefused, true, 'the same-project write boundary was not recorded as refused');
    assert.ok(sessions.crossWriteText.includes('TARGET_MISMATCH'), 'the recorded write refusal did not name the mismatch');
    assert.equal(sessions.foreignWriteRefused, true, "a session navigated another project window's tab");
    assert.equal(sessions.foreignTabNavigated, false, "another project window's tab moved");
    assert.notEqual(sessions.tabOne, sessions.tabTwo, 'the session row compared a tab with itself');
    // Read scope is the project: session one's sibling read reaches tabTwo, while a
    // mutation against a tab the session does not own is still refused outright.
    assert.ok(sessions.domReadsBeforeSibling.length > 0, 'the session row recorded no reads');
    assert.ok(
      sessions.domReadsBeforeSibling.includes(sessions.tabTwo),
      'the recorded reads did not reach the same-project sibling tab',
    );
    assert.ok(!sessions.domReads.includes(sessions.foreignTab), "a read reached another project window's tab");
    assert.ok(sessions.domReads.includes(sessions.tabTwo), 'session two never reached its own tab');
  });

  it('migrates a profile written by the shared-window layout and reopens the right windows', async () => {
    const { evidence } = await runScenario('migration');
    const migration = evidence.observations.migration;
    assert.ok(migration, 'the migration scenario recorded no evidence');
    assert.deepEqual(
      migration.ownerKeys,
      [
        'project:project-00000000-0000-4000-8000-0000000000a1',
        'project:project-00000000-0000-4000-8000-0000000000b2',
      ],
      'the boot did not open exactly the presented and ledger projects',
    );
    assert.equal(migration.documentVersion, 3, 'the saved-tabs document was not upgraded');
    assert.match(migration.backupName ?? '', /^saved-tabs\.json\.pre-project-windows-\d{14}(-\d+)?\.bak$/, 'the migration wrote no backup');
    assert.equal(Object.keys(migration.ownerRecords).includes('web'), false, "the migrated document still has a 'web' owner");
    assert.equal(evidence.observations.teardown?.shellCount, 0, 'the run left browser shells behind');
  });
});
