/**
 * Project-window tab authority: saved tabs, workspace provenance and search.
 *
 * These tests drive the REAL NativeTabHost and the REAL TerminalManager. Only the
 * OS/browser boundaries are stubbed: the Electron module (BrowserWindow, dialogs),
 * the two credential/session vaults, and the PTY spawn step when a route is being
 * checked for the arguments it passes. No logic under test is replaced.
 *
 * Coverage:
 *   1. Legacy saved-tabs migration: runs once, is a file-level transaction (an
 *      interrupted write retains the source), converges on retry without
 *      duplicating tabs, and puts unresolved records on Unassigned.
 *   2. Owner-keyed persistence: one window's save never overwrites another
 *      project's record, including when a project is reopened.
 *   3. Search inventory: stable strip order for an empty query, project/owner
 *      labels, automation surfaces excluded.
 *   4. Search activation: exact-id + owner revalidation, no index substitution, no
 *      fallback, no attachment change.
 *   5. Terminal provenance: a window's terminals resolve to its own verified workspace and
 *      owner key, a popout keeps its bound session, and the process-wide last directory is
 *      never inherited.
 *   6. Workspace scoping: the sidebar projection, session events and output are filtered to
 *      the window's own owner key, a record written before ownership keeps the capsule rule
 *      it was created under, an unattributable session is refused rather than passed through,
 *      and a seam that cannot scope yields an empty projection instead of the unscoped one.
 *   7. Persist no-op skip: an unchanged projection never re-reads or rewrites
 *      saved-tabs.json, while a changed projection or a missing file still does.
 *   8. Terminal activity envelopes: non-displaying surfaces receive a bounded
 *      data tail, never the full batch payload.
 */
import { describe, it, before, after, afterEach, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TerminalManager,
  DEFAULT_TERMINAL_CAPSULE_ID,
  DEFAULT_TERMINAL_OWNER_KEY,
  workspaceTerminalProvenance,
} from '../../src/main/browser/terminal-manager';
import { ownerKey, type WindowOwner } from '../../src/main/browser/project-window-shell';
import { TerminalOutputRouter } from '../../src/main/browser/terminal-output-router';
import { SIDEBAR_CHANNELS, TERMINAL_CHANNELS, TOOLBAR_CHANNELS } from '../../src/shared/contracts';
import type { ShellDouble } from '../support/project-window-shell-double';
// Type-only: erased at compile time, so it loads nothing before the Electron fault is installed.
import type { TabHostCloseAdmission } from '../../src/main/browser/native-tab-host';
import type { ChromeRouteHarness } from '../support/chrome-route-harness';

// Every persistence path in this file points at a scratch directory, so a test can
// never touch the developer's real saved-tabs.json or terminal session file.
const SCRATCH_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'tsc-wsg', 'tmp-project-window-persistence');
fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
process.env.ANTIFAN_DATA_ROOT = SCRATCH_DIR;

const UNASSIGNED = ownerKey({ kind: 'unassigned' });
const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'proj-a' };
const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'proj-b' };

let userDataDir = path.join(SCRATCH_DIR, 'userdata-default');

/** A per-test userData directory, so each test owns exactly one saved-tabs.json. */
function freshUserData(name: string): string {
  const dir = path.join(SCRATCH_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  userDataDir = dir;
  return dir;
}

function freshWorkspace(name: string): string {
  const dir = path.join(SCRATCH_DIR, `ws-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// Electron / vault boundaries
// ---------------------------------------------------------------------------

interface FakeWebContents {
  sent: Array<{ channel: string; args: unknown[] }>;
  mainFrame: { url: string };
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

function makeWebContents(): FakeWebContents {
  const wc: FakeWebContents = {
    sent: [],
    // safeSendWebContents refuses a webContents without a main frame.
    mainFrame: { url: 'file:///E:/Work/apps/AntiFan/src/renderer/sidebar.html' },
    isDestroyed: () => false,
    send(channel: string, ...args: unknown[]) {
      wc.sent.push({ channel, args });
    },
  };
  return wc;
}

/** Which window a webContents belongs to, for BrowserWindow.fromWebContents. */
const webContentsWindowIds = new WeakMap<object, number>();

function makeWindowForWebContents(id: number): { webContents: FakeWebContents; window: { id: number } } {
  const webContents = makeWebContents();
  const window = { id };
  webContentsWindowIds.set(webContents as unknown as object, id);
  return { webContents, window };
}

const fakeElectron: Record<string, unknown> = {
  app: {
    getPath: () => userDataDir,
    getName: () => 'AntiFan',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve(),
    quit: () => {},
    commandLine: { appendSwitch: () => {} },
  },
  BrowserWindow: Object.assign(function BrowserWindow() {}, {
    fromWebContents: (sender: unknown) => {
      const id = sender && typeof sender === 'object' ? webContentsWindowIds.get(sender) : undefined;
      return id === undefined ? null : { id };
    },
    fromId: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  }),
  WebContentsView: function WebContentsView() {},
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  MenuItem: function MenuItem() {},
  clipboard: { writeText: () => {}, readText: () => '' },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }), showOpenDialog: () => Promise.resolve({ canceled: true }) },
  net: {},
  session: { fromPartition: () => ({}) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
};

const fakeSessionVaultModule = {
  LocalSessionVault: { getInstance: () => ({ registerIpcHandlers: () => {} }) },
  isTrustedSessionVaultSender: () => true,
};

const fakeCredentialVaultModule = {
  LocalCredentialVault: {
    DEFAULT_VAULT_FILENAME: 'credentials.vault',
    getInstance: () => ({ registerIpcHandlers: () => {} }),
  },
  resolveSenderFrameOrigin: () => null,
};

type ModuleLoad = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
// Reason: node's module loader is untyped here; this is the boundary the harness
// owns, and the replacement keeps the original loader for every other request.
const NodeModule = require('node:module') as { _load: ModuleLoad };
const originalModuleLoad = NodeModule._load;
NodeModule._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  if (request.endsWith('local-session-vault')) return fakeSessionVaultModule;
  if (request.endsWith('local-credential-vault')) return fakeCredentialVaultModule;
  return originalModuleLoad.call(this, request, parent, isMain);
};

// The host module is required after this point on purpose. `import * as fs` compiles
// to an interop copy whose member descriptors are captured at load time, so a fault
// has to be installed on the real module BEFORE the host is loaded to be visible to
// it. The controller below is inert until a test arms `armedRenameFault`.
let armedRenameFault: Error | null = null;
const realFs = require('node:fs') as { renameSync: typeof fs.renameSync };
const untouchedRenameSync = realFs.renameSync;
realFs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
  if (armedRenameFault) throw armedRenameFault;
  return untouchedRenameSync(...args);
}) as typeof fs.renameSync;

const { NativeTabHost, SAVED_TABS_SCHEMA_VERSION, collectTabSearchInventory, activateTabSearchResult } =
  require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');
const { createChromeRouteHarness } = require('../support/chrome-route-harness') as typeof import('../support/chrome-route-harness');

type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// Host harness
// ---------------------------------------------------------------------------

const tm = TerminalManager.getInstance() as AnyRecord;
const originalGetSession = tm.getSession;
const originalStartTerminal = tm.startTerminal;
const originalCreateSession = tm.createSession;
const originalCurrentCwd: string = tm.currentCwd;

function addTab(host: AnyRecord, id: string, state: AnyRecord = {}): void {
  host.tabs.set(id, {
    state: {
      id,
      url: `https://example.test/${id}`,
      title: id,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      ...state,
    },
    view: { webContents: makeWebContents() },
  });
  host.tabOrder.push(id);
}

interface HostOptions {
  owner?: WindowOwner;
  tabs?: Array<[string, AnyRecord?]>;
  activeTabId?: string;
  /** Installs the terminal event subscriptions the sidebar projections rely on. */
  withTerminalSubscriptions?: boolean;
}

/**
 * A host instance with its real methods. The constructor is bypassed because it
 * builds a real BrowserWindow; the fields the exercised members read are seeded
 * here, exactly as the other host harnesses in this lane do.
 */
function createHost(options: HostOptions = {}): AnyRecord {
  const host = Object.create(NativeTabHost.prototype) as AnyRecord;
  host.broadcastState = () => {};
  host.updateLayout = () => {};
  host.schedulePersist = () => {};
  host.isDisposed = false;
  host.isPersistingTabs = false;
  host.hasPendingPersist = false;
  host.persistTimer = null;
  host.tabs = new Map<string, AnyRecord>();
  host.tabOrder = [];
  host.activeTabId = '';
  host.automationTabId = null;
  host.terminalAgentAffinity = new Map<string, AnyRecord>();
  host.sessionTabPools = new Map<string, AnyRecord>();
  host.closedTabAnchors = new Map<string, AnyRecord>();
  host.tabByWebContents = new WeakMap<object, string>();
  host.terminalWindows = new Map<number, AnyRecord>();
  host.terminalWindowMeta = new Map<number, { sessionId?: string; isPopout?: boolean }>();
  host.terminalDataBatches = new Map<string, AnyRecord>();
  host.terminalDisplayedSessions = new Map<string, Set<string>>();
  host.hibernatingTabIds = new Set<string>();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.terminalDataFlushTimer = null;
  host.lastPersistedProjection = undefined;
  host.lastPersistedFileMtimeMs = undefined;
  host.lastPersistedFileSize = undefined;
  // Field initializers do not run on a prototype-built double; withTerminalSubscriptions
  // pushes each seam listener's release here, and afterEach resets the router + manager.
  host.terminalSubscriptionReleases = [];
  host.terminalFanoutMessages = 0;
  host.bookmarks = [];
  host.mutedSites = new Set<string>();
  host.terminalTabLayout = 'horizontal';
  host.terminalSidebarWidth = 220;
  host.terminalCollapsedCategories = [];
  host.terminalCategories = [];
  host.terminalCategoryColors = {};
  host.terminalStarredCategories = [];
  host.terminalProjectOrder = [];
  host.touchedSharedTerminalPrefs = new Set<string>();
  host.previewWatcherPool = { retain: () => () => {} };
  host.tabPreviewUnsubscribers = new Map<string, () => void>();
  host.capsuleManager = {
    list: () => [],
    getActive: () => null,
    create: () => ({ id: 'capsule-created', name: 'Created', workspacePath: process.cwd() }),
    switchTo: () => {},
  };

  const shell = createShellDouble({ isSidebarOpen: false, sidebarWidth: 380 });
  shell.sidebarView = null;
  if (options.owner) {
    // Reason: the shell double carries the presentation members the host reads; the
    // owner is the one identity field this suite has to supply per host.
    (shell as unknown as { owner: WindowOwner }).owner = options.owner;
  }
  host.shell = shell as unknown as ShellDouble;
  host.windowWorkspaceAffiliation = null;

  for (const [id, state] of options.tabs ?? []) addTab(host, id, state);
  if (options.activeTabId) host.activeTabId = options.activeTabId;
  if (options.withTerminalSubscriptions) host.setupTerminalSubscriptions();
  return host;
}

/**
 * Reason: the harness builds hosts without the constructor (recorded above), so a
 * host has to be re-asserted as NativeTabHost when it crosses the public API.
 */
function asHost(host: AnyRecord): InstanceType<typeof NativeTabHost> {
  return host as unknown as InstanceType<typeof NativeTabHost>;
}

/** One recorded frame's payload, asserted to exist. */
function framePayload(sent: Array<{ channel: string; args: unknown[] }>, channel: string): unknown {
  const frame = sent.find((message) => message.channel === channel);
  assert.ok(frame, `expected a ${channel} frame`);
  return frame.args[0];
}

/** A sidebar view double that records what the host sends it. */
function attachSidebar(host: AnyRecord): FakeWebContents {
  const webContents = makeWebContents();
  host.shell.isSidebarOpen = true;
  host.shell.sidebarView = { webContents, setBounds: () => {} };
  return webContents;
}

function savedTabsPath(): string {
  return path.join(userDataDir, 'saved-tabs.json');
}

function readSavedTabsFile(): AnyRecord {
  return JSON.parse(fs.readFileSync(savedTabsPath(), 'utf8')) as AnyRecord;
}

function writeLegacySavedTabs(document: AnyRecord): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(savedTabsPath(), JSON.stringify(document, null, 2), 'utf8');
}

before(() => {
  tm.getSession = (id: string) => {
    const seeded = tm.sessions.get(id);
    if (seeded) return seeded;
    return originalGetSession.call(tm, id);
  };
});

beforeEach(() => {
  userDataDir = path.join(SCRATCH_DIR, 'userdata-default');
});

afterEach(() => {
  // Hosts registered listeners on the process-wide manager; drop them so one test's
  // window can never observe another test's emissions. The removeAllListeners sweep
  // also strips the shared output router's seam listeners without running its
  // detach(), which would leave it half-attached for the next test — resetting the
  // singleton rebuilds both its listener set and its host registry.
  TerminalOutputRouter.resetInstance();
  tm.removeAllListeners('data');
  tm.removeAllListeners('session');
  tm.removeAllListeners('session-closed');
  tm.removeAllListeners('session-restarted');
  tm.removeAllListeners('session-woken');
  tm.removeAllListeners('session-created');
  tm.startTerminal = originalStartTerminal;
  tm.createSession = originalCreateSession;
  tm.currentCwd = originalCurrentCwd;
  tm.sessions.clear();
});

after(() => {
  tm.getSession = originalGetSession;
  tm.startTerminal = originalStartTerminal;
  tm.createSession = originalCreateSession;
});

// ---------------------------------------------------------------------------
// 1. Legacy migration
// ---------------------------------------------------------------------------

describe('saved tabs: legacy migration', () => {
  it('migrates the flat document once and leaves it versioned', () => {
    freshUserData('legacy-once');
    writeLegacySavedTabs({
      activeTabId: 't1',
      tabs: [
        { id: 't1', url: 'https://legacy.test/one', title: 'One' },
        { id: 't2', url: 'https://legacy.test/two', title: 'Two' },
      ],
      sidebarWidth: 420,
    });

    const host = createHost();
    const document = host.loadSavedTabsDocument();

    assert.equal(document.version, SAVED_TABS_SCHEMA_VERSION);
    // A flat file carries no verified affiliation, so its records are Unassigned.
    assert.deepEqual(Object.keys(document.owners), [UNASSIGNED]);
    assert.equal(document.owners[UNASSIGNED].tabs.length, 2);
    assert.equal(document.owners[UNASSIGNED].activeTabId, 't1');

    const onDisk = readSavedTabsFile();
    assert.equal(onDisk.version, SAVED_TABS_SCHEMA_VERSION);
    assert.equal('tabs' in onDisk, false, 'flat tab list must not survive the migration');
    assert.equal('activeTabId' in onDisk, false);
    assert.equal(onDisk.sidebarWidth, 420, 'shared preferences are preserved');

    // A second run is a no-op, so a boot that migrates twice cannot duplicate tabs.
    assert.deepEqual(host.migrateLegacySavedTabsFile(), { migrated: false, reason: 'already-versioned' });
    const again = host.loadSavedTabsDocument();
    assert.equal(again.owners[UNASSIGNED].tabs.length, 2);
    assert.equal(readSavedTabsFile().owners[UNASSIGNED].tabs.length, 2);
  });

  it('retains the legacy source when the write is interrupted and does not duplicate on retry', () => {
    freshUserData('legacy-interrupted');
    writeLegacySavedTabs({
      activeTabId: 't2',
      tabs: [
        { id: 't1', url: 'https://legacy.test/one', title: 'One' },
        { id: 't2', url: 'https://legacy.test/two', title: 'Two' },
        { id: 't3', url: 'https://legacy.test/three', title: 'Three' },
      ],
    });
    const sourceBytes = fs.readFileSync(savedTabsPath(), 'utf8');

    const host = createHost();
    // The interruption has to happen inside the real write, so that the temp-file
    // cleanup and the retained source are both exercised. Only the OS rename step
    // fails, exactly as it would on a full or interrupted volume.
    armedRenameFault = new Error('EIO: interrupted');
    try {
      const interrupted = host.migrateLegacySavedTabsFile();
      assert.equal(interrupted.migrated, false);
      assert.match(String(interrupted.reason), /^write-failed: EIO: interrupted$/);
      assert.equal(fs.readFileSync(savedTabsPath(), 'utf8'), sourceBytes, 'legacy source retained byte-for-byte');
      assert.deepEqual(
        fs.readdirSync(userDataDir).filter((name) => name.includes('.tmp.')),
        [],
        'an interrupted write leaves no temp file behind',
      );

      // The user still sees their tabs this launch, even though the rewrite failed —
      // and that read must not migrate the file behind the failure either.
      const inMemory = host.loadSavedTabsDocument();
      assert.equal(inMemory.owners[UNASSIGNED].tabs.length, 3);
      assert.equal(fs.readFileSync(savedTabsPath(), 'utf8'), sourceBytes);
      assert.deepEqual(
        fs.readdirSync(userDataDir).filter((name) => name.includes('.tmp.')),
        [],
        'a failed migration write leaves no temp file behind',
      );
    } finally {
      armedRenameFault = null;
    }

    // Retry converges: one migration, one record, no duplicated tabs.
    assert.deepEqual(host.migrateLegacySavedTabsFile(), { migrated: true });
    const migrated = readSavedTabsFile();
    assert.equal(migrated.version, SAVED_TABS_SCHEMA_VERSION);
    assert.deepEqual(Object.keys(migrated.owners), [UNASSIGNED]);
    assert.deepEqual(migrated.owners[UNASSIGNED].tabs.map((tab: AnyRecord) => tab.id), ['t1', 't2', 't3']);
    assert.deepEqual(host.migrateLegacySavedTabsFile(), { migrated: false, reason: 'already-versioned' });
  });

  it('keeps already-versioned owner records and only adds Unassigned for the flat leftovers', () => {
    freshUserData('legacy-with-owners');
    writeLegacySavedTabs({
      version: 2,
      owners: {
        [ownerKey(PROJECT_A)]: {
          tabs: [{ id: 'p1', url: 'https://project.test/one', title: 'Project one' }],
          activeTabId: 'p1',
          updatedAt: 1,
        },
      },
      tabs: [{ id: 'legacy1', url: 'https://legacy.test/one', title: 'Legacy one' }],
      activeTabId: 'legacy1',
    });

    const host = createHost();
    const document = host.loadSavedTabsDocument();

    assert.deepEqual(Object.keys(document.owners).sort(), [ownerKey(PROJECT_A), UNASSIGNED].sort());
    assert.deepEqual(document.owners[ownerKey(PROJECT_A)].tabs.map((tab: AnyRecord) => tab.id), ['p1']);
    assert.deepEqual(document.owners[UNASSIGNED].tabs.map((tab: AnyRecord) => tab.id), ['legacy1']);
    // The project record keeps its own active tab; the unresolved one gets its own.
    assert.equal(document.owners[ownerKey(PROJECT_A)].activeTabId, 'p1');
    assert.equal(document.owners[UNASSIGNED].activeTabId, 'legacy1');
  });
});

// ---------------------------------------------------------------------------
// 2. Per-owner persistence
// ---------------------------------------------------------------------------

describe('saved tabs: one record per owner', () => {
  it('closing and reopening one project never overwrites another project record', () => {
    freshUserData('owner-isolation');
    const hostA = createHost({ owner: PROJECT_A, tabs: [['tab-a', {}]], activeTabId: 'tab-a' });
    hostA.persistSync();

    const afterA = readSavedTabsFile();
    assert.deepEqual(Object.keys(afterA.owners), [ownerKey(PROJECT_A)]);
    assert.deepEqual(afterA.owners[ownerKey(PROJECT_A)].tabs.map((tab: AnyRecord) => tab.id), ['tab-a']);
    assert.equal(afterA.owners[ownerKey(PROJECT_A)].activeTabId, 'tab-a');

    const hostB = createHost({ owner: PROJECT_B, tabs: [['tab-b', {}]], activeTabId: 'tab-b' });
    hostB.persistSync();

    const afterB = readSavedTabsFile();
    assert.deepEqual(Object.keys(afterB.owners).sort(), [ownerKey(PROJECT_A), ownerKey(PROJECT_B)].sort());
    assert.deepEqual(afterB.owners[ownerKey(PROJECT_A)].tabs.map((tab: AnyRecord) => tab.id), ['tab-a']);
    assert.deepEqual(afterB.owners[ownerKey(PROJECT_B)].tabs.map((tab: AnyRecord) => tab.id), ['tab-b']);

    // Project A closes and reopens with a different strip: B's record is untouched.
    const hostAReopened = createHost({ owner: PROJECT_A, tabs: [['tab-a2', {}]], activeTabId: 'tab-a2' });
    hostAReopened.persistSync();

    const afterReopen = readSavedTabsFile();
    assert.deepEqual(afterReopen.owners[ownerKey(PROJECT_A)].tabs.map((tab: AnyRecord) => tab.id), ['tab-a2']);
    assert.equal(afterReopen.owners[ownerKey(PROJECT_A)].activeTabId, 'tab-a2');
    assert.deepEqual(
      afterReopen.owners[ownerKey(PROJECT_B)],
      afterB.owners[ownerKey(PROJECT_B)],
      'another project record must survive verbatim',
    );
  });

  it('keeps the Unassigned window separate from project records', () => {
    freshUserData('owner-unassigned');
    const projectHost = createHost({ owner: PROJECT_A, tabs: [['tab-a', {}]], activeTabId: 'tab-a' });
    projectHost.persistSync();

    const unassignedHost = createHost({ tabs: [['tab-u', {}]], activeTabId: 'tab-u' });
    unassignedHost.persistSync();

    const document = readSavedTabsFile();
    assert.deepEqual(Object.keys(document.owners).sort(), [ownerKey(PROJECT_A), UNASSIGNED].sort());
    assert.deepEqual(document.owners[UNASSIGNED].tabs.map((tab: AnyRecord) => tab.id), ['tab-u']);
    assert.deepEqual(document.owners[ownerKey(PROJECT_A)].tabs.map((tab: AnyRecord) => tab.id), ['tab-a']);
  });

  it('keeps each window\'s terminal layout and width in its own record; the manager opens as the sidebar', () => {
    freshUserData('owner-terminal-layout');
    // A pre-per-window document: one top-level layout/width written by whichever window saved last.
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: 2,
      owners: {},
      terminalTabLayout: 'horizontal',
      terminalSidebarWidth: 317,
    }), 'utf8');
    const legacy = readSavedTabsFile();

    const manager = createHost({ owner: { kind: 'unassigned' } });
    manager.terminalTabLayout = 'sidebar';
    manager.restoreWindowTerminalLayout(legacy);
    assert.equal(manager.terminalTabLayout, 'sidebar', 'a legacy layout from another window must not close the manager\'s sidebar');
    assert.equal(manager.terminalSidebarWidth, 317, 'the legacy width is the one the user dragged');

    const hub = createHost({ owner: PROJECT_A });
    hub.restoreWindowTerminalLayout(legacy);
    assert.equal(hub.terminalTabLayout, 'horizontal');
    assert.equal(hub.terminalSidebarWidth, 317);

    // The user resizes the manager's column; the hub, untouched, saves after it.
    manager.applyTerminalTabPrefsFromUser({ layout: 'sidebar', sidebarWidth: 290 });
    manager.persistSync();
    hub.persistSync();

    const saved = readSavedTabsFile();
    assert.equal(saved.terminalTabLayout, undefined, 'no window may impose its layout on the others');
    assert.equal(saved.terminalSidebarWidth, undefined);
    assert.equal(saved.owners[UNASSIGNED].terminalTabLayout, 'sidebar');
    assert.equal(saved.owners[UNASSIGNED].terminalSidebarWidth, 290);
    assert.equal(saved.owners[ownerKey(PROJECT_A)].terminalTabLayout, 'horizontal');

    const reopened = createHost({ owner: { kind: 'unassigned' } });
    reopened.restoreWindowTerminalLayout(saved);
    assert.equal(reopened.terminalTabLayout, 'sidebar');
    assert.equal(reopened.terminalSidebarWidth, 290, 'the manager reopens at the width the user left it');
  });

  it('a window that never changed a shared terminal pref does not overwrite a sibling\'s change', () => {
    freshUserData('owner-terminal-shared');
    const manager = createHost({ owner: { kind: 'unassigned' } });
    const hub = createHost({ owner: PROJECT_A });

    // The hub's renderer echoes its whole (unchanged) set: nothing it holds is a change.
    hub.applyTerminalTabPrefsFromUser({ projectOrder: [], collapsedCategories: [] });
    manager.applyTerminalTabPrefsFromUser({ projectOrder: ['proj-b', 'proj-a'], collapsedCategories: ['project:proj-b'] });
    manager.persistSync();
    hub.persistSync();

    let saved = readSavedTabsFile();
    assert.deepEqual(saved.terminalProjectOrder, ['proj-b', 'proj-a'], 'the hub\'s boot-time copy clobbered the manager\'s order');
    assert.deepEqual(saved.terminalCollapsedCategories, ['project:proj-b']);

    // A real change in the hub is the hub's to write.
    hub.applyTerminalTabPrefsFromUser({ projectOrder: ['proj-a'] });
    hub.persistSync();
    saved = readSavedTabsFile();
    assert.deepEqual(saved.terminalProjectOrder, ['proj-a']);
    assert.deepEqual(saved.terminalCollapsedCategories, ['project:proj-b'], 'an untouched key keeps the sibling\'s value');
  });

  it('does not write an automation surface into the saved strip', () => {
    freshUserData('owner-agent-tabs');
    const host = createHost({
      owner: PROJECT_A,
      tabs: [['tab-a', {}], ['tab-agent', { ephemeral: true }], ['tab-offscreen', { offscreen: true }]],
      activeTabId: 'tab-a',
    });
    host.persistSync();

    const record = readSavedTabsFile().owners[ownerKey(PROJECT_A)];
    assert.deepEqual(record.tabs.map((tab: AnyRecord) => tab.id), ['tab-a']);
  });

  it('skips all disk work when the projection is unchanged, still writes on change or missing file', () => {
    freshUserData('persist-noop-skip');
    const host = createHost({ owner: PROJECT_A, tabs: [['tab-a', {}]], activeTabId: 'tab-a' });

    let reads = 0;
    let writes = 0;
    const originalMergeRead = host.normalizeSavedTabsFileForMerge;
    const originalWrite = host.writeSavedTabsDocumentSync;
    host.normalizeSavedTabsFileForMerge = (...args: unknown[]) => {
      reads += 1;
      return originalMergeRead.apply(host, args as [string]);
    };
    host.writeSavedTabsDocumentSync = (...args: unknown[]) => {
      writes += 1;
      return originalWrite.apply(host, args as [string, AnyRecord]);
    };

    // First persist lands the projection.
    host.persistSync();
    assert.equal(writes, 1);
    const firstRecord = readSavedTabsFile().owners[ownerKey(PROJECT_A)];

    // Triggering persist again with identical projected state does no disk work:
    // no merge read, no document write, no rename — this is the broadcast-driven
    // path flushBroadcastState hits at up to ~2.5 Hz during tab activity.
    host.persistSync();
    host.persistSync();
    assert.equal(reads, 1, 'only the first persist reads; an unchanged projection must not re-read the file');
    assert.equal(writes, 1, 'an unchanged projection must not rewrite the file');
    assert.deepEqual(readSavedTabsFile().owners[ownerKey(PROJECT_A)], firstRecord);

    // A real state change still persists.
    host.mutedSites.add('example.test');
    host.persistSync();
    assert.equal(writes, 2, 'a changed projection must write');
    assert.ok((readSavedTabsFile().mutedSites || []).includes('example.test'));

    // Same projected state: quiet again.
    host.persistSync();
    assert.equal(writes, 2);

    // Crash-durability: the file vanished after our last write, so even an
    // identical projection has to be rewritten rather than left absent.
    fs.unlinkSync(savedTabsPath());
    host.persistSync();
    assert.equal(writes, 3, 'a missing saved-tabs.json must be rewritten');
    assert.ok(fs.existsSync(savedTabsPath()));

    // An external rewrite bumps mtime, so the window merges again instead of
    // trusting its cached projection stamp.
    const tampered = readSavedTabsFile();
    tampered.bookmarks = [{ url: 'https://other-window.test/', title: 'other window' }];
    fs.writeFileSync(savedTabsPath(), JSON.stringify(tampered, null, 2), 'utf8');
    host.persistSync();
    assert.equal(reads, 4, 'every landed persist merges exactly once');
    assert.equal(writes, 4);
  });
});

// ---------------------------------------------------------------------------
// 3. Search inventory
// ---------------------------------------------------------------------------

describe('search inventory', () => {
  it('lists user-visible tabs in strip order with owner and path labels', () => {
    freshUserData('inventory');
    const workspaceA = freshWorkspace('inventory-a');
    const hostA = createHost({ owner: PROJECT_A, tabs: [['a1'], ['a2']], activeTabId: 'a2' });
    assert.equal(hostA.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' }), true);
    const hostB = createHost({ owner: PROJECT_B, tabs: [['b1']], activeTabId: 'b1' });
    const unassigned = createHost({ tabs: [['u1']], activeTabId: 'u1' });

    const rows = collectTabSearchInventory([asHost(hostA), asHost(hostB), asHost(unassigned)], '');

    assert.deepEqual(rows.map((row) => row.tabId), ['a1', 'a2', 'b1', 'u1']);
    assert.deepEqual(rows.map((row) => row.order), [0, 1, 0, 0]);
    assert.deepEqual(rows.map((row) => row.ownerKey), [
      ownerKey(PROJECT_A), ownerKey(PROJECT_A), ownerKey(PROJECT_B), UNASSIGNED,
    ]);
    assert.deepEqual(rows.map((row) => row.ownerLabel), ['proj-a', 'proj-a', 'proj-b', 'Unassigned']);
    assert.equal(rows[0]?.projectPath, path.normalize(workspaceA));
    assert.equal(rows[3]?.projectPath, undefined, 'an unaffiliated window carries no project path');
    assert.deepEqual(rows.map((row) => row.active), [false, true, true, true]);
  });

  it('answers an empty query identically on repeat and independently of the active tab', () => {
    freshUserData('inventory-stability');
    const host = createHost({ owner: PROJECT_A, tabs: [['a1'], ['a2'], ['a3']], activeTabId: 'a1' });

    const first = collectTabSearchInventory([asHost(host)], '');
    const second = collectTabSearchInventory([asHost(host)], '');

    assert.deepEqual(second, first, 'an empty query is a stable listing, not a search ranking');
    host.activeTabId = 'a3';
    const afterActivation = collectTabSearchInventory([asHost(host)], '');
    assert.deepEqual(afterActivation.map((row) => row.tabId), first.map((row) => row.tabId));
    assert.deepEqual(afterActivation.map((row) => row.active), [false, false, true]);
  });

  it('excludes offscreen and ephemeral automation tabs from the listing', () => {
    freshUserData('inventory-exclusion');
    const host = createHost({
      owner: PROJECT_A,
      tabs: [['visible'], ['agent', { ephemeral: true }], ['offscreen', { offscreen: true }]],
      activeTabId: 'agent',
    });

    const rows = collectTabSearchInventory([asHost(host)], '');
    assert.deepEqual(rows.map((row) => row.tabId), ['visible']);
    assert.equal(rows[0]?.active, false, 'an automation tab can never be reported as the user-visible active tab');
  });

  it('filters a non-empty query by title or url, case-insensitively', () => {
    freshUserData('inventory-filter');
    const host = createHost({
      owner: PROJECT_A,
      tabs: [
        ['a1', { title: 'Haravan Theme', url: 'https://example.test/a1' }],
        ['a2', { title: 'Shopify', url: 'https://haravan.test/product' }],
        ['a3', { title: 'Other', url: 'https://example.test/other' }],
      ],
    });

    assert.deepEqual(collectTabSearchInventory([asHost(host)], 'HARAVAN').map((row) => row.tabId), ['a1', 'a2']);
    assert.deepEqual(collectTabSearchInventory([asHost(host)], 'haravan.test').map((row) => row.tabId), ['a2']);
    assert.deepEqual(collectTabSearchInventory([asHost(host)], 'nothing-matches').map((row) => row.tabId), []);
  });
});

// ---------------------------------------------------------------------------
// 4. Search activation
// ---------------------------------------------------------------------------

describe('search activation', () => {
  function hostWithSwitchRecorder(tabs: Array<[string, AnyRecord?]>, owner?: WindowOwner): { host: AnyRecord; switched: string[] } {
    const host = createHost({ owner, tabs, activeTabId: tabs[0]?.[0] });
    const switched: string[] = [];
    host.switchTab = (tabId: string) => {
      switched.push(tabId);
      host.activeTabId = tabId;
    };
    return { host, switched };
  }

  it('activates the exact tab when the identity and owner still match', () => {
    freshUserData('activation-ok');
    const { host, switched } = hostWithSwitchRecorder([['tab-1'], ['tab-2']], PROJECT_A);

    const result = activateTabSearchResult([asHost(host)], { tabId: 'tab-2', expectedOwnerKey: ownerKey(PROJECT_A) });

    assert.deepEqual(result, { ok: true, tabId: 'tab-2', ownerKey: ownerKey(PROJECT_A), ownerLabel: 'proj-a' });
    assert.deepEqual(switched, ['tab-2'], 'selection happens inside the validated step, with no interleaved await');
    assert.equal(host.activeTabId, 'tab-2');
  });

  it('refuses a stale result without substituting another tab or touching attachments', () => {
    freshUserData('activation-stale');
    const { host, switched } = hostWithSwitchRecorder([['tab-1'], ['tab-2']], PROJECT_A);
    host.automationTabId = 'tab-2';
    const attachmentsBefore = host.automationTabId;

    const result = activateTabSearchResult([asHost(host)], { tabId: 'tab-closed', expectedOwnerKey: ownerKey(PROJECT_A) });

    assert.deepEqual(result, { ok: false, tabId: 'tab-closed', reason: 'TAB_UNAVAILABLE' });
    assert.deepEqual(switched, [], 'a refused activation never selects a neighbouring tab');
    assert.equal(host.activeTabId, 'tab-1', 'the window keeps its own selection');
    assert.equal(host.automationTabId, attachmentsBefore, 'activation never rotates agent authority');
  });

  it('refuses a result whose window now carries a different owner', () => {
    freshUserData('activation-owner-changed');
    const { host, switched } = hostWithSwitchRecorder([['tab-1']], PROJECT_A);

    const result = activateTabSearchResult([asHost(host)], { tabId: 'tab-1', expectedOwnerKey: ownerKey(PROJECT_B) });

    assert.deepEqual(result, { ok: false, tabId: 'tab-1', reason: 'OWNER_CHANGED' });
    assert.deepEqual(switched, []);
  });

  it('never resolves by index and refuses a tab that is now an automation surface', () => {
    freshUserData('activation-index');
    const { host, switched } = hostWithSwitchRecorder([['tab-1'], ['tab-2']], PROJECT_A);
    host.tabs.set('tab-2', { ...host.tabs.get('tab-2'), state: { ...host.tabs.get('tab-2').state, offscreen: true } });

    const unavailable = activateTabSearchResult([asHost(host)], { tabId: 'tab-2', expectedOwnerKey: ownerKey(PROJECT_A) });
    assert.deepEqual(unavailable, { ok: false, tabId: 'tab-2', reason: 'TAB_UNAVAILABLE' });

    // An integer-like id must not be read as a position in the strip.
    const byIndex = activateTabSearchResult([asHost(host)], { tabId: '0', expectedOwnerKey: ownerKey(PROJECT_A) });
    assert.deepEqual(byIndex, { ok: false, tabId: '0', reason: 'TAB_UNAVAILABLE' });
    assert.deepEqual(switched, []);
  });

  it('finds the owner by exact id across live windows and refuses an unknown window', () => {
    freshUserData('activation-multi');
    const { host: hostA } = hostWithSwitchRecorder([['a1']], PROJECT_A);
    const { host: hostB, switched: switchedB } = hostWithSwitchRecorder([['b1']], PROJECT_B);

    const result = activateTabSearchResult([asHost(hostA), asHost(hostB)], { tabId: 'b1', expectedOwnerKey: ownerKey(PROJECT_B) });
    assert.equal(result.ok, true);
    assert.deepEqual(switchedB, ['b1']);

    const missing = activateTabSearchResult([asHost(hostA), asHost(hostB)], { tabId: '', expectedOwnerKey: ownerKey(PROJECT_B) });
    assert.deepEqual(missing, { ok: false, tabId: '', reason: 'TAB_UNAVAILABLE' });
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal provenance
// ---------------------------------------------------------------------------

describe('terminal workspace provenance', () => {
  /**
   * One session row as the manager holds it. `ownerKeyValue` is the window that minted the
   * session; a row seeded without one is a record written before ownership existed, and its
   * capsule is the only attribution it carries.
   */
  function seedSession(id: string, capsuleId: string | undefined, cwd: string, ownerKeyValue?: string): AnyRecord {
    const record: AnyRecord = {
      id,
      name: id,
      cwd,
      capsuleId,
      state: 'running',
      sessionGeneration: 1,
      buffer: `buffer-${id}`,
      bufferBytes: 8,
      lastSeq: 1,
      splitOf: undefined,
      disposed: false,
      pty: null,
      deliveryJournal: { clear: () => {} },
      inputLineBuffer: '',
      pendingClearScreen: false,
      altScreen: false,
      dataSubscription: undefined,
      exitSubscription: undefined,
    };
    // A row minted with an owner key carries one; a row seeded without it stands for a record
    // read off disk before ownership existed, so the field is left off entirely rather than set
    // to `undefined`, which is how a row that lost its key would look.
    if (ownerKeyValue !== undefined) record.ownerKey = ownerKeyValue;
    tm.sessions.set(id, record);
    return record;
  }

  it('refuses an unverifiable affiliation and keeps the previous one', () => {
    freshUserData('provenance-refusal');
    const workspaceA = freshWorkspace('provenance-a');
    const host = createHost({ owner: PROJECT_A });

    assert.equal(host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' }), true);
    assert.equal(host.setWindowWorkspaceAffiliation({ workspacePath: path.join(SCRATCH_DIR, 'does-not-exist') }), false);
    assert.equal(host.setWindowWorkspaceAffiliation({ workspacePath: 'relative/path' }), false);
    assert.equal(host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: '  ' }), false);
    assert.deepEqual(host.getWindowWorkspaceAffiliation(), {
      workspacePath: path.normalize(workspaceA),
      capsuleId: 'capsule-a',
    });
    assert.equal(host.resolveWindowWorkspaceRoot(), path.normalize(workspaceA));
    assert.equal(host.setWindowWorkspaceAffiliation(null), true);
    assert.equal(host.resolveWindowWorkspaceRoot(), '');
  });

  it('resolves the window workspace instead of the process-wide last directory', () => {
    freshUserData('provenance-window');
    const workspaceA = freshWorkspace('provenance-window-a');
    const foreignWorkspace = freshWorkspace('provenance-window-foreign');
    const host = createHost({ owner: PROJECT_A });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });

    // Another window switched the process-wide working directory.
    tm.currentCwd = foreignWorkspace;

    assert.deepEqual(host.resolveTerminalCreationTarget(), {
      cwd: path.normalize(workspaceA),
      capsuleId: 'capsule-a',
      // The window that asks is the window the mint belongs to, which is what keeps two
      // project windows on one folder apart.
      ownerKey: ownerKey(PROJECT_A),
      source: 'window-workspace',
    });

    // Without a verified workspace the immutable process-start directory is used,
    // never the mutable directory another window left behind.
    const unaffiliated = createHost({ owner: PROJECT_B });
    const unaffiliatedTarget = unaffiliated.resolveTerminalCreationTarget();
    assert.equal(unaffiliatedTarget.cwd, tm.getDefaultCwd());
    assert.notEqual(unaffiliatedTarget.cwd, foreignWorkspace);
    // A window that verified no workspace still owns what it mints: the owner key is the
    // window's identity, and a sentinel there instead would leave the window unable to
    // attribute its own new terminal, which is the failure the key exists to end.
    assert.equal(unaffiliatedTarget.ownerKey, ownerKey(PROJECT_B), 'the mint carries the asking window\'s key');
    seedSession('session-unaffiliated-mint', unaffiliatedTarget.capsuleId, unaffiliatedTarget.cwd, unaffiliatedTarget.ownerKey);
    assert.equal(unaffiliated.isSessionVisibleToWindow('session-unaffiliated-mint'), true, 'so the window sees the terminal it just minted');
  });

  it('keeps a terminal popout bound to the workspace of its own session', () => {
    freshUserData('provenance-popout');
    const workspaceA = freshWorkspace('provenance-popout-a');
    const popoutWorkspace = freshWorkspace('provenance-popout-b');
    seedSession('session-popout', 'capsule-popout', popoutWorkspace);
    const { webContents } = makeWindowForWebContents(77);

    const host = createHost({ owner: PROJECT_A });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    host.terminalWindowMeta.set(77, { sessionId: 'session-popout', isPopout: true });

    assert.deepEqual(host.resolveTerminalCreationTarget(webContents), {
      cwd: path.normalize(popoutWorkspace),
      capsuleId: 'capsule-popout',
      // The popout row predates ownership, so the mint is attributed to the window that
      // presents the popout rather than to a key the row does not carry.
      ownerKey: ownerKey(PROJECT_A),
      source: 'popout-session',
    });
    // A sender that is not one of this host's terminal windows falls back to the window.
    assert.equal(host.resolveTerminalCreationTarget(makeWebContents()).source, 'window-workspace');

    // A popout row that carries an owner key mints under THAT key: the session the popout
    // presents decides, so a terminal opened there stays with the window the session belongs
    // to instead of being re-attributed to whoever happens to present the popout.
    const { webContents: ownedContents } = makeWindowForWebContents(78);
    seedSession('session-popout-owned', 'capsule-popout', popoutWorkspace, ownerKey(PROJECT_B));
    host.terminalWindowMeta.set(78, { sessionId: 'session-popout-owned', isPopout: true });
    assert.equal(
      host.resolveTerminalCreationTarget(ownedContents).ownerKey,
      ownerKey(PROJECT_B),
      "the popout's own session owns the mint",
    );
  });

  it('scopes the sidebar projection to the verified capsule and keeps the popout session', () => {
    freshUserData('provenance-projection');
    const workspaceA = freshWorkspace('provenance-projection-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-projection-b'));

    const host = createHost({ owner: PROJECT_A });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });

    const scoped = host.scopedTerminalProjection();
    assert.deepEqual(scoped.sessions.map((summary: AnyRecord) => summary.id), ['session-a']);

    const withPopout = host.scopedTerminalProjection('session-b');
    assert.deepEqual(withPopout.sessions.map((summary: AnyRecord) => summary.id), ['session-a', 'session-b']);
    assert.equal(withPopout.activeSessionId, 'session-b', 'the popout keeps its own binding');
  });

  it('drops another workspace session state and output before they reach the window', () => {
    freshUserData('provenance-events');
    const workspaceA = freshWorkspace('provenance-events-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-events-b'));

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: true });
    const sidebar = attachSidebar(host);
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });

    tm.emit('session', {
      activeSessionId: 'session-b',
      sessions: [
        { id: 'session-a', name: 'session-a', cwd: workspaceA, active: false, buffer: '', bufferLength: 0, sessionGeneration: 1 },
        { id: 'session-b', name: 'session-b', cwd: '/elsewhere', active: true, buffer: '', bufferLength: 0, sessionGeneration: 1 },
      ],
      snapshot: '',
      snapshotThroughSeq: 0,
    });

    const sessionFrames = sidebar.sent.filter((message) => message.channel === 'antifan:terminal:session');
    assert.equal(sessionFrames.length, 1);
    const frame = framePayload(sidebar.sent, 'antifan:terminal:session') as { sessions: Array<{ id: string }>; activeSessionId: string };
    assert.deepEqual(frame.sessions.map((summary) => summary.id), ['session-a']);
    assert.equal(frame.activeSessionId, 'session-a', 'a foreign session can never become this window active tab');

    sidebar.sent.length = 0;
    tm.emit('data', { sessionId: 'session-b', data: 'foreign', generation: 1, seq: 1 });
    assert.equal(sidebar.sent.length, 0, 'foreign terminal output is never forwarded');

    tm.emit('data', { sessionId: 'session-a', data: 'local', generation: 1, seq: 1 });
    const dataFrames = sidebar.sent.filter((message) => message.channel === 'antifan:terminal:data');
    assert.equal(dataFrames.length, 1);
    assert.equal((framePayload(sidebar.sent, 'antifan:terminal:data') as { sessionId: string }).sessionId, 'session-a');
  });

  it('a seam that cannot attribute a session yields an empty projection, never the unscoped one', () => {
    freshUserData('provenance-unscopable');
    const workspaceA = freshWorkspace('provenance-unscopable-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-unscopable-b'));

    const host = createHost({ owner: PROJECT_A });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    // The daemon-backed facade is not the only possible seam: a seam that cannot name a
    // session's capsule attributes nothing, and the unscoped view it would otherwise fall
    // back to is every project's sessions — exactly what a verified capsule exists to
    // withhold.
    const ownTagMethod = tm.sessionCapsuleId;
    try {
      tm.sessionCapsuleId = undefined as unknown as typeof tm.sessionCapsuleId;
      const scoped = host.scopedTerminalProjection();
      assert.deepEqual(scoped.sessions, [], 'a scoped window never falls back to the unscoped view');
      assert.equal(scoped.activeSessionId, '');
    } finally {
      if (ownTagMethod === undefined) delete (tm as { sessionCapsuleId?: unknown }).sessionCapsuleId;
      else tm.sessionCapsuleId = ownTagMethod;
    }
  });

  it('a session the seam cannot attribute is refused, while a popout binding stays visible', () => {
    freshUserData('provenance-unattributed');
    const workspaceA = freshWorkspace('provenance-unattributed-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-untagged', undefined, workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-unattributed-b'));

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: true });
    const sidebar = attachSidebar(host);
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });

    // The popout this host presents keeps its own binding even though the projection hides it.
    host.terminalWindowMeta.set(77, { sessionId: 'session-untagged', isPopout: true });
    assert.equal(host.isSessionVisibleToWindow('session-untagged'), true);
    assert.equal(host.scopedTerminalProjection('session-untagged').sessions.length, 2);

    // Without that binding the same session is unattributable: an untagged session has no
    // verified affiliation, so a scoped window may not receive its output.
    host.terminalWindowMeta.clear();
    assert.equal(host.isSessionVisibleToWindow('session-a'), true);
    assert.equal(host.isSessionVisibleToWindow('session-untagged'), false);
    assert.equal(host.isSessionVisibleToWindow('session-b'), false);

    // The daemon announces session state before the first output for a session arrives:
    // the projection push is what records which sessions the sidebar displays, and only
    // displayed sessions receive the data channel (everything else is the activity ping).
    tm.emit('session', {
      activeSessionId: 'session-a',
      sessions: [
        { id: 'session-a', name: 'session-a', cwd: workspaceA, active: true, buffer: '', bufferLength: 0, sessionGeneration: 1 },
        { id: 'session-b', name: 'session-b', cwd: '/elsewhere', active: false, buffer: '', bufferLength: 0, sessionGeneration: 1 },
      ],
      snapshot: '',
      snapshotThroughSeq: 0,
    });
    sidebar.sent.length = 0;
    tm.emit('data', { sessionId: 'session-untagged', data: 'unattributed', generation: 1, seq: 1 });
    assert.equal(sidebar.sent.length, 0, 'unattributed output is never forwarded to a scoped window');
    tm.emit('data', { sessionId: 'session-a', data: 'local', generation: 1, seq: 1 });
    assert.equal(sidebar.sent.filter((message) => message.channel === 'antifan:terminal:data').length, 1);
  });

  it('a window with no capsule sees the sessions it created and no project\'s', () => {
    freshUserData('provenance-uncapsuled');
    const workspaceOwn = freshWorkspace('provenance-uncapsuled-own');
    const foreignWorkspace = freshWorkspace('provenance-uncapsuled-a');
    // The process view: this window's own sessions (a window with no verified capsule stamps
    // its workspace), another capsule-less project's, a project's, and the records no window
    // claimed — a sentinel-stamped session from an Unassigned window, and a legacy record
    // that carries no tag at all.
    seedSession('session-own', workspaceTerminalProvenance(ownerKey(PROJECT_A), workspaceOwn), workspaceOwn);
    seedSession('session-other-uncapsuled', workspaceTerminalProvenance(ownerKey(PROJECT_B), foreignWorkspace), foreignWorkspace);
    seedSession('session-a', 'capsule-a', freshWorkspace('provenance-uncapsuled-b'));
    seedSession('session-unclaimed', DEFAULT_TERMINAL_CAPSULE_ID, workspaceOwn);
    seedSession('session-legacy', undefined, workspaceOwn);

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: true });
    const sidebar = attachSidebar(host);
    // A window whose project has no capsule: it verified a workspace, so it is not the
    // Unassigned case, and every session it creates is stamped with that workspace.
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceOwn });

    assert.equal(host.isSessionVisibleToWindow('session-own'), true, 'its own workspace-stamped session stays visible');
    assert.equal(host.isSessionVisibleToWindow('session-other-uncapsuled'), false, "another capsule-less project's session is not");
    assert.equal(host.isSessionVisibleToWindow('session-a'), false, "a capsule's session is not");
    assert.equal(host.isSessionVisibleToWindow('session-unclaimed'), false, 'nor is what an Unassigned window created');
    assert.equal(host.isSessionVisibleToWindow('session-legacy'), false, 'nor a record that carries no tag');

    sidebar.sent.length = 0;
    tm.emit('session', {
      activeSessionId: 'session-a',
      sessions: [
        { id: 'session-a', name: 'session-a', cwd: '/a', active: true, buffer: 'foreign', bufferLength: 7, sessionGeneration: 1 },
        { id: 'session-own', name: 'session-own', cwd: workspaceOwn, active: false, buffer: 'own', bufferLength: 3, sessionGeneration: 1 },
      ],
      snapshot: 'foreign',
      snapshotThroughSeq: 9,
    });

    const frame = framePayload(sidebar.sent, 'antifan:terminal:session') as {
      activeSessionId: string;
      sessions: Array<{ id: string }>;
      snapshot: string;
      snapshotThroughSeq: number;
    };
    assert.deepEqual(frame.sessions.map((summary) => summary.id), ['session-own']);
    assert.equal(frame.activeSessionId, 'session-own', 'a foreign active session cannot become this window active');
    assert.equal(frame.snapshot, '', 'and its transcript never travels with the projection');
    assert.equal(frame.snapshotThroughSeq, 0);

    sidebar.sent.length = 0;
    tm.emit('data', { sessionId: 'session-a', data: 'foreign', generation: 1, seq: 1 });
    assert.equal(sidebar.sent.length, 0, "another project's output is never forwarded");
    tm.emit('data', { sessionId: 'session-own', data: 'own', generation: 1, seq: 1 });
    assert.equal(sidebar.sent.filter((message) => message.channel === 'antifan:terminal:data').length, 1);
  });

  it('two capsule-less project windows keep their own terminals and never merge', () => {
    freshUserData('provenance-two-uncapsuled');
    const workspaceA = freshWorkspace('provenance-two-uncapsuled-a');
    const workspaceB = freshWorkspace('provenance-two-uncapsuled-b');

    const hostA = createHost({ owner: PROJECT_A });
    const hostB = createHost({ owner: PROJECT_B });
    hostA.setWindowWorkspaceAffiliation({ workspacePath: workspaceA });
    hostB.setWindowWorkspaceAffiliation({ workspacePath: workspaceB });

    // Both windows are open at once and neither has a capsule, so the shared sentinel would
    // have put their terminals in one bucket: each names its own verified workspace instead.
    const targetA = hostA.resolveTerminalCreationTarget();
    const targetB = hostB.resolveTerminalCreationTarget();
    assert.equal(targetA.cwd, path.normalize(workspaceA));
    assert.equal(targetB.cwd, path.normalize(workspaceB));
    assert.notEqual(targetA.capsuleId, targetB.capsuleId, 'two capsule-less projects never share one terminal bucket');
    assert.equal(targetA.capsuleId, workspaceTerminalProvenance(ownerKey(PROJECT_A), workspaceA));
    assert.equal(targetB.capsuleId, workspaceTerminalProvenance(ownerKey(PROJECT_B), workspaceB));

    seedSession('session-a', targetA.capsuleId, workspaceA);
    seedSession('session-b', targetB.capsuleId, workspaceB);

    assert.equal(hostA.isSessionVisibleToWindow('session-a'), true);
    assert.equal(hostA.isSessionVisibleToWindow('session-b'), false, "the other project's terminal is not this window's");
    assert.equal(hostB.isSessionVisibleToWindow('session-b'), true);
    assert.equal(hostB.isSessionVisibleToWindow('session-a'), false);
    assert.deepEqual(
      hostA
        .terminalStateForWindow({ activeSessionId: 'session-b', sessions: [{ id: 'session-a' }, { id: 'session-b' }] })
        .sessions.map((session: { id: string }) => session.id),
      ['session-a'],
    );
    assert.deepEqual(
      hostB
        .terminalStateForWindow({ activeSessionId: 'session-b', sessions: [{ id: 'session-a' }, { id: 'session-b' }] })
        .sessions.map((session: { id: string }) => session.id),
      ['session-b'],
    );

    // Two projects may attach the same directory, and the terminals still belong to the
    // project that made them: the tag names the owner as well as the root.
    const hostShared = createHost({ owner: PROJECT_B });
    hostShared.setWindowWorkspaceAffiliation({ workspacePath: workspaceA });
    const sharedTarget = hostShared.resolveTerminalCreationTarget();
    assert.equal(sharedTarget.cwd, path.normalize(workspaceA));
    assert.notEqual(sharedTarget.capsuleId, targetA.capsuleId, 'a shared directory is not a shared terminal bucket');
    seedSession('session-shared-root', sharedTarget.capsuleId, workspaceA);
    assert.equal(hostShared.isSessionVisibleToWindow('session-shared-root'), true);
    assert.equal(hostShared.isSessionVisibleToWindow('session-a'), false, "the other project's terminals stay its own");
    assert.equal(hostA.isSessionVisibleToWindow('session-shared-root'), false);
  });

  it('scopes a folder two projects work by the owner key that minted a session', () => {
    freshUserData('provenance-folder-row');
    const workspace = freshWorkspace('provenance-folder-row');
    const otherWorkspace = freshWorkspace('provenance-folder-row-other');
    const folderRow = 'capsule-folder-row';
    const otherRow = 'capsule-other-row';
    // Both windows work the SAME folder, each with a capsule row of its own, and the folder
    // carries rows of its own besides. Capsules alone cannot tell their terminals apart — one
    // window holds a row the other's sessions were stamped with — which is what the owner key
    // exists for.
    seedSession('session-key-a', folderRow, workspace, ownerKey(PROJECT_A));
    seedSession('session-key-b', 'capsule-a', workspace, ownerKey(PROJECT_B));
    seedSession('session-legacy-capsule', 'capsule-a', workspace);
    seedSession('session-legacy-tag', workspaceTerminalProvenance(ownerKey(PROJECT_A), workspace), workspace);
    seedSession('session-folder', folderRow, workspace);
    seedSession('session-other', otherRow, otherWorkspace);

    const hostA = createHost({ owner: PROJECT_A });
    const hostB = createHost({ owner: PROJECT_B });
    assert.equal(hostA.setWindowWorkspaceAffiliation({ workspacePath: workspace, capsuleId: 'capsule-a' }), true);
    assert.equal(hostB.setWindowWorkspaceAffiliation({ workspacePath: workspace, capsuleId: 'capsule-b' }), true);

    // Reason: a pick of this folder mints a row of its own, and a terminal created then carries
    // it. The row claims no project, so a registry that answers for the folder is the strongest
    // case for adopting it — and the rule that did so handed one project's terminals to another
    // window working the same directory.
    const rows: AnyRecord = {
      'capsule-a': { id: 'capsule-a', workspacePath: workspace, projectId: 'proj-a', workspaceId: 'ws-a' },
      'capsule-b': { id: 'capsule-b', workspacePath: workspace, projectId: 'proj-b', workspaceId: 'ws-b' },
      [folderRow]: { id: folderRow, workspacePath: workspace },
      [otherRow]: { id: otherRow, workspacePath: otherWorkspace },
    };
    const registry = {
      get: (id: string) => {
        const row = rows[id];
        if (!row) throw new Error(`Capsule not found: ${id}`);
        return row;
      },
      uniqueAffiliationByRoot: () => ({ projectId: 'proj-a', workspaceId: 'ws-a' }),
    };
    hostA.capsuleManager = registry;
    hostB.capsuleManager = registry;

    // A session minted with an owner key belongs to that window and to no other, whatever capsule
    // the row carries: one directory, two projects, two sets of terminals.
    assert.equal(hostA.isSessionVisibleToWindow('session-key-a'), true, "this window's own mint stays visible");
    assert.equal(hostB.isSessionVisibleToWindow('session-key-a'), false, "another project's mint does not, even working the same folder");
    assert.equal(hostB.isSessionVisibleToWindow('session-key-b'), true);
    assert.equal(hostA.isSessionVisibleToWindow('session-key-b'), false, "a foreign owner key is refused even under this window's own capsule");

    // A record written before ownership existed carries no key and keeps the capsule rule it was
    // created under: this window's own capsule, or the workspace tag its project mints under when
    // it has no capsule. Both name this window positively; neither matches another project.
    assert.equal(hostA.isSessionVisibleToWindow('session-legacy-capsule'), true, "the window's own capsule still attributes a legacy row");
    assert.equal(hostB.isSessionVisibleToWindow('session-legacy-capsule'), false);
    assert.equal(hostA.isSessionVisibleToWindow('session-legacy-tag'), true);
    assert.equal(hostB.isSessionVisibleToWindow('session-legacy-tag'), false, 'a shared directory is not a shared tag');

    // The folder's own row belongs to no window now: it names a directory, not a project, so with
    // two projects attached to that directory not even the project the registry names for the
    // root may take it.
    assert.equal(hostA.isSessionVisibleToWindow('session-folder'), false, 'the folder row is no longer adopted by the window working there');
    assert.equal(hostB.isSessionVisibleToWindow('session-folder'), false);
    assert.equal(hostA.isSessionVisibleToWindow('session-other'), false, 'nor does a row recording another directory belong to either window');
    assert.equal(hostB.isSessionVisibleToWindow('session-other'), false);
    // A row that claims a project is that project's durable record, and still not this window's.
    rows[folderRow] = { id: folderRow, workspacePath: workspace, projectId: 'proj-b', workspaceId: 'ws-b' };
    assert.equal(hostA.isSessionVisibleToWindow('session-folder'), false, "another project's row is never adopted");

    // The projection admits exactly what the gate admits, read from the live manager state, and a
    // sibling's active session never becomes this window's.
    assert.deepEqual(
      hostA.scopedTerminalProjection().sessions.map((session: AnyRecord) => session.id),
      ['session-key-a', 'session-legacy-capsule', 'session-legacy-tag'],
      'window A presents its own keyed and legacy rows and nothing of its sibling',
    );
    assert.deepEqual(hostB.scopedTerminalProjection().sessions.map((session: AnyRecord) => session.id), ['session-key-b']);
    const projection = hostA.terminalStateForWindow({
      activeSessionId: 'session-key-b',
      sessions: [
        'session-key-a', 'session-key-b', 'session-legacy-capsule', 'session-legacy-tag', 'session-folder', 'session-other',
      ].map((id) => ({ id })),
    });
    assert.deepEqual(
      projection.sessions.map((session: { id: string }) => session.id),
      ['session-key-a', 'session-legacy-capsule', 'session-legacy-tag'],
    );
    // The incoming state has no member of this window as active, so the sibling's active session
    // is never adopted: the window presents the first session it can actually see instead.
    assert.equal(projection.activeSessionId, 'session-key-a', "a sibling's active session never becomes this window's own");
    assert.notEqual(projection.activeSessionId, 'session-key-b', "the sibling's active session is never presented here");

    // The seam the gate reads reports the same fact for the same row.
    assert.equal(tm.sessionOwnerKey('session-key-a'), ownerKey(PROJECT_A));
    assert.equal(tm.sessionOwnerKey('session-key-b'), ownerKey(PROJECT_B));
    assert.equal(tm.sessionOwnerKey('session-legacy-capsule'), undefined, 'a row written before ownership has no key to report');
  });

  it('refuses a terminal route that names another window\'s session', async () => {
    freshUserData('provenance-route-scope');
    const workspaceA = freshWorkspace('provenance-route-scope-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-route-scope-b'));

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: false });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    host.findTabByWebContents = () => undefined;
    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });

    // Naming another project's session used to be enough on its own to read it, write into
    // it, rename it or kill it: the session id arrives from the renderer and is not a
    // capability, so the route gate decides before the manager is touched.
    const closed: string[] = [];
    const renamed: Array<[string, string]> = [];
    const written: Array<[string, string]> = [];
    const originals = {
      closeSession: tm.closeSession,
      renameSession: tm.renameSession,
      writeTo: tm.writeTo,
    };
    try {
      tm.closeSession = (async (id: string) => { closed.push(id); return true; }) as typeof tm.closeSession;
      tm.renameSession = ((id: string, name: string) => { renamed.push([id, name]); return true; }) as typeof tm.renameSession;
      tm.writeTo = ((id: string, input: string) => { written.push([id, input]); return true; }) as typeof tm.writeTo;

      await assert.rejects(async () => harness.invoke('antifan:terminal:close-session', 'session-b'), /does not belong/);
      await assert.rejects(async () => harness.invoke(TERMINAL_CHANNELS.RENAME_SESSION, { id: 'session-b', name: 'taken' }), /does not belong/);
      await assert.rejects(async () => harness.invoke(TERMINAL_CHANNELS.GET_FULL_BUFFER, 'session-b'), /does not belong/);
      await assert.rejects(async () => harness.invoke(TERMINAL_CHANNELS.SWITCH_SESSION, 'session-b'), /does not belong/);
      // A fire-and-forget channel has no rejection path back to its sender, so its refusal
      // is a drop: the write simply never happens.
      harness.invoke('antifan:terminal:input-session', { id: 'session-b', input: 'rm -rf /' });
      assert.deepEqual(closed, [], 'a refused kill never reaches the manager');
      assert.deepEqual(renamed, []);
      assert.deepEqual(written, []);

      // The window's own session is still served, so the gate refuses scope, not the route.
      await harness.invoke('antifan:terminal:close-session', 'session-a');
      assert.deepEqual(closed, ['session-a']);
    } finally {
      tm.closeSession = originals.closeSession;
      tm.renameSession = originals.renameSession;
      tm.writeTo = originals.writeTo;
    }
  });

  it('aims an implicit terminal route at this window\'s active session', async () => {
    freshUserData('provenance-route-active');
    const workspaceA = freshWorkspace('provenance-route-active-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-route-active-b'));
    // Another window switched last: the process-wide active session is not this window's.
    const previousActive = tm.activeSessionId;
    tm.activeSessionId = 'session-b';

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: false });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    host.findTabByWebContents = () => undefined;
    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });

    const closed: string[] = [];
    const written: Array<[string, string]> = [];
    const resized: Array<[string, number, number]> = [];
    const buffered: string[] = [];
    const originals = {
      closeSession: tm.closeSession,
      writeTo: tm.writeTo,
      resizeTo: tm.resizeTo,
      getFullBuffer: tm.getFullBuffer,
    };
    try {
      tm.closeSession = (async (id: string) => { closed.push(id); return true; }) as typeof tm.closeSession;
      tm.writeTo = ((id: string, input: string) => { written.push([id, input]); return true; }) as typeof tm.writeTo;
      tm.resizeTo = ((id: string, cols: number, rows: number) => { resized.push([id, cols, rows]); }) as typeof tm.resizeTo;
      tm.getFullBuffer = ((id: string) => { buffered.push(id); return { sessionId: id, buffer: '', snapshotThroughSeq: 0 }; }) as typeof tm.getFullBuffer;

      assert.equal(host.windowActiveSessionId(harness.sender), 'session-a', "the window's own active session, not the process-wide one");

      await harness.invoke(TERMINAL_CHANNELS.GET_FULL_BUFFER);
      await harness.invoke(TERMINAL_CHANNELS.INPUT, 'echo hi');
      await harness.invoke(TERMINAL_CHANNELS.RESIZE, { cols: 80, rows: 24 });
      await harness.invoke(TERMINAL_CHANNELS.KILL);

      assert.deepEqual(buffered, ['session-a'], 'the buffer is this window\'s, never another project\'s');
      assert.deepEqual(written, [['session-a', 'echo hi']]);
      assert.deepEqual(resized, [['session-a', 80, 24]]);
      assert.deepEqual(closed, ['session-a'], 'and the kill hits the session this window presents');
    } finally {
      tm.activeSessionId = previousActive;
      tm.closeSession = originals.closeSession;
      tm.writeTo = originals.writeTo;
      tm.resizeTo = originals.resizeTo;
      tm.getFullBuffer = originals.getFullBuffer;
    }
  });

  it('narrows the diagnostics route to this window\'s sessions and blanks a foreign active session', async () => {
    freshUserData('provenance-route-diagnostics');
    const workspaceA = freshWorkspace('provenance-route-diagnostics-a');
    seedSession('session-a', 'capsule-a', workspaceA);
    seedSession('session-b', 'capsule-b', freshWorkspace('provenance-route-diagnostics-b'));
    const previousActive = tm.activeSessionId;
    tm.activeSessionId = 'session-b';

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: false });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    host.findTabByWebContents = () => undefined;
    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });

    interface ScopedReport {
      sessionCount: number;
      activeSessionId: string;
      sessions: Array<{ sessionId: string }>;
      subscribers: Array<{ sessionId: string }>;
      fanoutMessages: number;
    }
    const assertScoped = (report: ScopedReport, label: string): void => {
      assert.deepEqual(report.sessions.map((session) => session.sessionId), ['session-a'], `${label}: only this window's session is reported`);
      assert.equal(report.sessionCount, 1, `${label}: the count matches the narrowed rows`);
      assert.equal(report.activeSessionId, '', `${label}: another window's active session is blanked, never named`);
      assert.equal(report.fanoutMessages, host.terminalFanoutMessages, `${label}: the fanout counter still rides along`);
    };

    try {
      const inProcess = (await harness.invoke(TERMINAL_CHANNELS.DUMP_DIAGNOSTICS)) as ScopedReport;
      assertScoped(inProcess, 'in-process report');
      assert.deepEqual(inProcess.subscribers, [], 'in-process report: no subscriber row survives that this window cannot attribute');

      // The detached daemon's proxy answers diagnostics as a promise. Spreading that pending
      // promise returned `{ fanoutMessages }` with no report at all, which is what a scoped
      // window must never be told is its own diagnostics. The subscribers ride the same rule:
      // a subscriber row this window cannot attribute is dropped, never shown.
      const report: Record<string, unknown> = { ...tm.getDiagnostics.call(tm) };
      report.subscribers = [
        { rendererInstanceId: 'renderer-a', sessionId: 'session-a', generation: 1, lastAckedSeq: 4, role: 'DOCK', lastHeartbeatAt: 1 },
        { rendererInstanceId: 'renderer-b', sessionId: 'session-b', generation: 1, lastAckedSeq: 9, role: 'DOCK', lastHeartbeatAt: 2 },
      ];
      const original = tm.getDiagnostics;
      try {
        tm.getDiagnostics = (async () => report) as typeof tm.getDiagnostics;
        const deferred = (await harness.invoke(TERMINAL_CHANNELS.DUMP_DIAGNOSTICS)) as ScopedReport;
        assertScoped(deferred, 'deferred report');
        assert.deepEqual(deferred.subscribers.map((subscriber) => subscriber.sessionId), ['session-a'], 'deferred report: only this window\'s subscriber rows survive');
      } finally {
        tm.getDiagnostics = original;
      }
    } finally {
      tm.activeSessionId = previousActive;
    }
  });

  it('only a window with no workspace at all sees the sessions no window claimed', () => {
    freshUserData('provenance-unassigned');
    const workspaceOwn = freshWorkspace('provenance-unassigned-own');
    seedSession('session-unclaimed', DEFAULT_TERMINAL_CAPSULE_ID, workspaceOwn);
    seedSession('session-legacy', undefined, workspaceOwn);
    seedSession('session-own', workspaceTerminalProvenance(ownerKey(PROJECT_A), workspaceOwn), workspaceOwn);

    // The Unassigned window: it verified no workspace, so it owns no project and the
    // sentinel plus legacy untagged records are the only sessions it can claim.
    const host = createHost({ owner: PROJECT_A });
    assert.equal(host.getWindowWorkspaceAffiliation(), null);
    assert.equal(host.resolveWindowWorkspaceRoot(), '');
    assert.equal(host.resolveTerminalCreationTarget().capsuleId, DEFAULT_TERMINAL_CAPSULE_ID);
    assert.equal(host.isSessionVisibleToWindow('session-unclaimed'), true);
    assert.equal(host.isSessionVisibleToWindow('session-legacy'), true);
    assert.equal(host.isSessionVisibleToWindow('session-own'), false, "a project's terminal is not the Unassigned window's");
  });

  it('a seam that cannot attribute leaves a capsule-less window with nothing', () => {
    freshUserData('provenance-uncapsuled-seam');
    const workspaceOwn = freshWorkspace('provenance-uncapsuled-seam-own');
    seedSession('session-own', workspaceTerminalProvenance(ownerKey(PROJECT_A), workspaceOwn), workspaceOwn);

    const host = createHost({ owner: PROJECT_A });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceOwn });

    const ownCapsuleMethod = tm.sessionCapsuleId;
    try {
      tm.sessionCapsuleId = undefined as unknown as typeof tm.sessionCapsuleId;
      // Without the seam there is no way to tell a sentinel-stamped session from a project's,
      // so the window that cannot answer admits nothing rather than everything.
      assert.equal(host.isSessionVisibleToWindow('session-own'), false);
      assert.deepEqual(host.terminalStateForWindow({ activeSessionId: 'session-own', sessions: [{ id: 'session-own' }] }), {
        activeSessionId: '',
        sessions: [],
        snapshot: '',
        snapshotThroughSeq: 0,
      });
    } finally {
      if (ownCapsuleMethod === undefined) delete (tm as { sessionCapsuleId?: unknown }).sessionCapsuleId;
      else tm.sessionCapsuleId = ownCapsuleMethod;
    }
  });

  it('passes the window workspace, capsule and owner key to the creation routes', async () => {
    freshUserData('provenance-routes');
    const workspaceA = freshWorkspace('provenance-routes-a');
    tm.currentCwd = freshWorkspace('provenance-routes-foreign');

    const host = createHost({ owner: PROJECT_A, withTerminalSubscriptions: false });
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    host.findTabByWebContents = () => undefined;

    const started: Array<{ cwd?: string; capsuleId?: string; ownerKey?: string }> = [];
    const created: Array<{ cwd?: string; capsuleId?: string; ownerKey?: string }> = [];
    tm.startTerminal = ((cwd?: string, capsuleId?: string, ownerKey?: string) => {
      started.push({ cwd, capsuleId, ownerKey });
      tm.activeSessionId = 'session-started';
      return true;
    }) as typeof tm.startTerminal;
    tm.createSession = ((cwd?: string, capsuleId?: string, ownerKey?: string) => {
      created.push({ cwd, capsuleId, ownerKey });
      return 'session-created';
    }) as typeof tm.createSession;

    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    await harness.invoke(TERMINAL_CHANNELS.START);
    await harness.invoke('antifan:terminal:new-session');

    assert.deepEqual(started, [{ cwd: path.normalize(workspaceA), capsuleId: 'capsule-a', ownerKey: ownerKey(PROJECT_A) }]);
    assert.deepEqual(created, [{ cwd: path.normalize(workspaceA), capsuleId: 'capsule-a', ownerKey: ownerKey(PROJECT_A) }]);

    // An explicit cwd from the renderer still wins for the directory, but the capsule and the
    // owner key stay this window's verified provenance: the manager's ambient capsule is
    // whatever the last window switched it to, so leaving it unset tags this session with
    // another project.
    const explicit = freshWorkspace('provenance-routes-explicit');
    await harness.invoke(TERMINAL_CHANNELS.START, explicit);
    assert.deepEqual(started[1], { cwd: explicit, capsuleId: 'capsule-a', ownerKey: ownerKey(PROJECT_A) });

    // A window with no capsule of its own names its own verified workspace, never the
    // capsule another window left ambient on the manager.
    const foreignCapsule = 'capsule-other-window';
    (tm as unknown as { currentCapsuleId?: string }).currentCapsuleId = foreignCapsule;
    const workspaceB = freshWorkspace('provenance-routes-b');
    const uncapsuled = createHost({ owner: PROJECT_B });
    uncapsuled.setWindowWorkspaceAffiliation({ workspacePath: workspaceB });
    const uncapsuledTarget = uncapsuled.resolveTerminalCreationTarget();
    assert.equal(uncapsuledTarget.capsuleId, workspaceTerminalProvenance(ownerKey(PROJECT_B), workspaceB));
    assert.notEqual(uncapsuledTarget.capsuleId, foreignCapsule, 'the ambient capsule another window set is never inherited');
    assert.equal(uncapsuledTarget.ownerKey, ownerKey(PROJECT_B), 'the mint is attributed to the window that asked, not to the ambient capsule or another window');
    (tm as unknown as { currentCapsuleId?: string }).currentCapsuleId = DEFAULT_TERMINAL_CAPSULE_ID;
  });

  it('mints an Unassigned window\'s terminal under the unassigned owner key', async () => {
    freshUserData('provenance-routes-unassigned');
    const host = createHost({ withTerminalSubscriptions: false });
    host.findTabByWebContents = () => undefined;
    assert.equal(host.windowOwnerKey(), UNASSIGNED, 'a window with no owner of its own carries the sentinel key');

    const started: Array<{ cwd?: string; capsuleId?: string; ownerKey?: string }> = [];
    tm.startTerminal = ((cwd?: string, capsuleId?: string, ownerKey?: string) => {
      started.push({ cwd, capsuleId, ownerKey });
      tm.activeSessionId = 'session-unassigned';
      return true;
    }) as typeof tm.startTerminal;

    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    await harness.invoke(TERMINAL_CHANNELS.START);

    assert.equal(started.length, 1, 'the route minted exactly one session');
    const [mint] = started;
    assert.ok(mint, 'the route minted exactly one session');
    assert.equal(mint.ownerKey, DEFAULT_TERMINAL_OWNER_KEY, 'the mint is attributed to the Unassigned window, never to a project that left its key behind');
    assert.equal(mint.ownerKey, UNASSIGNED, 'the manager sentinel and the window-shell key are one string, so a session stamped by either is the same window\'s');
    assert.equal(mint.capsuleId, DEFAULT_TERMINAL_CAPSULE_ID);
  });

  it('new-session returns the daemon session id, not a live Promise', async () => {
    freshUserData('daemon-new-session');
    const host = createHost({ owner: PROJECT_A });
    addTab(host, 'tab-agent', { ephemeral: true });
    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    // The route reads senderInfo.tab through the sender: seat the agent tab on it.
    host.tabs.get('tab-agent').view.webContents = harness.sender;

    // The daemon proxy issues session ids asynchronously; an awaited route must
    // surface the resolved string everywhere the synchronous shape was read.
    tm.createSession = (async (cwd?: string, capsuleId?: string) => {
      void cwd;
      void capsuleId;
      return 'session-daemon';
    }) as typeof tm.createSession;
    tm.sessions.set('session-daemon', { sessionGeneration: 7 });

    const issuedId = (await harness.invoke('antifan:terminal:new-session', 'E:/Work/agent-workspace')) as unknown;
    assert.strictEqual(issuedId, 'session-daemon', 'the route must resolve to the session id string, not the pending Promise');

    // The binding the route performs for an agent sender must be keyed by the
    // issued session id, not by the Promise object the daemon returned.
    const affinity = host.getTerminalAgentAffinity('session-daemon');
    assert.ok(affinity, 'agent affinity must be bound under the resolved session id');
    assert.equal(affinity.tabId, 'tab-agent');
  });

  it('counts a mint asked from the sidebar on its own window, for the whole daemon call', async () => {
    freshUserData('daemon-new-session-inflight');
    // Required inside the row, after the module fault above is installed: these modules must
    // load with the same stubbed Electron the host itself loads under.
    const { PageCloseReservations } = require('../../src/main/browser/project-close-coordinator') as typeof import('../../src/main/browser/project-close-coordinator');
    const { countPageOperations } = require('../../src/main/browser/close-live-use') as typeof import('../../src/main/browser/close-live-use');

    const host = createHost({ owner: PROJECT_A });
    addTab(host, 'tab-a');
    addTab(host, 'tab-b');
    const reservations = new PageCloseReservations();
    host.setCloseAdmission(reservations as unknown as TabHostCloseAdmission);

    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    // The shell double binds its chrome views at construction, while this row's subject is the
    // route's attribution: make the harness sender this window's sidebar, so the host resolves
    // the sender as chrome exactly as it does for a live sidebar.
    const senderId = (harness.sender as { id?: number }).id;
    host.shell.chromeSurfaceFor = (id: number) => (id === senderId ? 'sidebar' : undefined);
    const windowKey = ownerKey(PROJECT_A);

    let resolveCreate: (id: string) => void = () => {};
    tm.createSession = (() => new Promise<string>((resolve) => { resolveCreate = resolve; })) as typeof tm.createSession;

    const minted = harness.invoke('antifan:terminal:new-session') as Promise<unknown>;

    // The daemon has not answered yet. The shell close reads the owner count, so a mint it
    // cannot see would let the attempt proceed and outlive the window that asked.
    assert.equal(reservations.inFlightOperationsOnOwner(windowKey), 1, 'the question the shell close asks');
    assert.equal(countPageOperations('tab-a', { admitted: reservations }), 0, 'and this page is not what the mint is about');
    assert.equal(countPageOperations('tab-b', { admitted: reservations }), 0);
    assert.equal(reservations.inFlightOperationsOnPage('tab-a'), 0);

    resolveCreate('session-slow');
    assert.strictEqual(await minted, 'session-slow');
    assert.equal(reservations.inFlightOperationsOnOwner(windowKey), 0, 'the mint must release with the call');
    assert.equal(reservations.snapshot().inFlightOperations, 0);
  });
});

describe('project window identity', () => {
  it('paints the shell owner on initial state and on every state broadcast', async () => {
    const host = createHost({ owner: PROJECT_A, tabs: [['a1', { title: 'One' }]], activeTabId: 'a1' });
    const shell = host.shell as AnyRecord;
    shell.title = 'Project A';
    shell.pathLabel = 'E:/work/project-a';

    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    const initial = (await harness.invoke(TOOLBAR_CHANNELS.GET_INITIAL_STATE)) as AnyRecord;
    assert.deepEqual(initial.projectWindow, {
      owner: PROJECT_A,
      title: 'Project A',
      pathLabel: 'E:/work/project-a',
    });

    // A later broadcast carries the key as well: for the renderer the key's
    // presence is the signal, so identity must ride every state push, not only boot.
    const sent: Array<{ channel: string; args: unknown[] }> = [];
    const toolbarView = shell.toolbarView as AnyRecord;
    // safeSendWebContents refuses a webContents without a main frame.
    toolbarView.webContents = makeWebContents();
    (toolbarView.webContents as FakeWebContents).send = (channel: string, ...args: unknown[]) => { sent.push({ channel, args }); };
    host.flushBroadcastState();
    const payload = framePayload(sent, TOOLBAR_CHANNELS.STATE_UPDATED) as AnyRecord;
    assert.deepEqual(payload.projectWindow, initial.projectWindow);
  });

  it('adds the workspace path only for a verified affiliation and never invents one', async () => {
    const host = createHost({ owner: PROJECT_A, tabs: [['a1']], activeTabId: 'a1' });
    (host.shell as AnyRecord).title = 'Project A';

    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    const before = (await harness.invoke(TOOLBAR_CHANNELS.GET_INITIAL_STATE)) as AnyRecord;
    assert.equal(Object.prototype.hasOwnProperty.call(before.projectWindow, 'workspacePath'), false);

    const workspaceA = freshWorkspace('identity-verified-root');
    host.setWindowWorkspaceAffiliation({ workspacePath: workspaceA, capsuleId: 'capsule-a' });
    const after = (await harness.invoke(TOOLBAR_CHANNELS.GET_INITIAL_STATE)) as AnyRecord;
    assert.equal(after.projectWindow.workspacePath, path.normalize(workspaceA));

    const unassigned = createHost({ tabs: [['u1']], activeTabId: 'u1' });
    (unassigned.shell as AnyRecord).title = '';
    const unassignedHarness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(unassigned) });
    const identity = ((await unassignedHarness.invoke(TOOLBAR_CHANNELS.GET_INITIAL_STATE)) as AnyRecord).projectWindow as AnyRecord;
    assert.deepEqual(identity.owner, { kind: 'unassigned' });
  });

  it('publishes the same shell identity on the sidebar boot payload, for both owner kinds', async () => {
    // The sidebar renderer scopes its shell off the same `projectWindow` identity
    // the toolbar publishes: a project shell is a project, the shared manager
    // shell is Unassigned. The boot payload must also retain the fields it has
    // always shipped.
    const host = createHost({ owner: PROJECT_A, tabs: [['a1', { title: 'One' }]], activeTabId: 'a1' });
    (host.shell as AnyRecord).title = 'Project A';
    const harness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(host) });
    const state = (await harness.invoke(SIDEBAR_CHANNELS.GET_INITIAL_STATE)) as AnyRecord;
    assert.deepEqual(state.projectWindow.owner, PROJECT_A);
    assert.equal(state.isOpen, false, 'the seeded sidebar state, not a dropped field');
    assert.equal(state.width, 380);
    for (const field of ['workspacePath', 'activeWorkspace', 'terminalTabPrefs', 'isOpen', 'width'] as const) {
      assert.ok(field in state, `the ${field} field must still ship on the boot payload`);
    }
    assert.deepEqual(state.terminalTabPrefs, {
      layout: 'horizontal',
      sidebarWidth: 220,
      collapsedCategories: [],
      categories: [],
      categoryColors: {},
      starredCategories: [],
      projectOrder: [],
    });

    const unassigned = createHost({ tabs: [['u1']], activeTabId: 'u1' });
    const unassignedHarness: ChromeRouteHarness = createChromeRouteHarness({ host: asHost(unassigned) });
    const unassignedState = (await unassignedHarness.invoke(SIDEBAR_CHANNELS.GET_INITIAL_STATE)) as AnyRecord;
    assert.deepEqual(unassignedState.projectWindow.owner, { kind: 'unassigned' });
  });
});

describe('terminal activity envelopes', () => {
  it('bounds the data a non-displaying surface receives to a trailing tail', () => {
    const host = createHost({ owner: PROJECT_A });
    const sidebarWc = attachSidebar(host);
    (sidebarWc as unknown as { id?: number }).id = 31;

    const winWc = makeWebContents();
    (winWc as unknown as { id?: number }).id = 32;
    host.terminalWindows.set(7, { isDestroyed: () => false, webContents: winWc });

    // Window 7 displays the session; the sidebar only watches it in the strip.
    host.terminalDisplayedSessions.set('w7', new Set(['sess-activity']));

    const head = 'HEAD-ONLY-CONTENT-NOT-WORTH-CLONING ';
    const marker = '\x1b]777;antifan;wait=1';
    const data = head.repeat(400) + marker;
    host.dispatchTerminalData({
      sessionId: 'sess-activity',
      data,
      seq: 9,
      fromSeq: 5,
      throughSeq: 9,
      generation: 2,
    });

    // The displaying surface still receives the full payload on the data channel.
    const dataFrame = winWc.sent.find((m) => m.channel === TERMINAL_CHANNELS.DATA);
    assert.ok(dataFrame, 'the displaying surface keeps the full data frame');
    assert.equal((dataFrame.args[0] as AnyRecord).data, data);
    assert.equal((dataFrame.args[0] as AnyRecord).fromSeq, 5);

    // The non-displaying surface gets the activity channel — same envelope
    // shape, data bounded to the trailing tail the classifier consumes, and
    // fromSeq honest about the range that tail covers so a pane going live
    // recovers via the seq gap instead of accepting a head-truncated batch.
    const activityFrame = sidebarWc.sent.find((m) => m.channel === TERMINAL_CHANNELS.ACTIVITY);
    assert.ok(activityFrame, 'a non-displaying surface must get an activity frame');
    const envelope = activityFrame.args[0] as AnyRecord;
    assert.equal(envelope.sessionId, 'sess-activity');
    assert.equal(envelope.generation, 2);
    assert.equal(envelope.seq, 9);
    assert.equal(envelope.throughSeq, 9, 'the ack cursor still names the real batch end');
    assert.equal(envelope.fromSeq, 9, 'the envelope names only the range its data covers');
    assert.ok(envelope.data.length <= 4096, `activity data is bounded, got ${envelope.data.length}`);
    assert.ok(envelope.data.endsWith(marker), 'trailing wait markers survive the tail cut');

    // Small payloads pass through untouched — truncation only pays for big bursts.
    sidebarWc.sent.length = 0;
    const small = { sessionId: 'sess-activity', data: 'echo', seq: 10, fromSeq: 10, throughSeq: 10 };
    host.dispatchTerminalData(small);
    const smallFrame = sidebarWc.sent.find((m) => m.channel === TERMINAL_CHANNELS.ACTIVITY);
    assert.ok(smallFrame);
    assert.deepEqual(smallFrame.args[0], small);
  });
});
