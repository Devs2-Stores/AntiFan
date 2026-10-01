/**
 * Option A "web" hub: one shell owns every project's tabs and attributes what it
 * mints to the project it is currently presenting.
 *
 * With the `project:`-keyed windows retired, the 'web' window is the only web
 * surface: it holds several projects' tabs at once, so project membership can
 * never be re-derived from the window — it is stamped onto each tab record at
 * mint time (`setActiveProject` decides what mints stamp), carried through
 * saved-tabs as an optional `projectId`, and honored by the per-project removal
 * routes (`closeTabsForProject` live, `purgePersistedTabsForProject` on disk).
 * The same active project decides the owner key a terminal minted from the hub
 * carries (`project:<id>` while one is presented, `'web'` otherwise — never
 * `'unassigned'`, which belongs to the Terminal Manager) and the terminal scope
 * its sidebar projects: the hub shows the terminals of the project it presents,
 * switching project on click. Only the Unassigned window is the shared manager:
 * it sees every session row there is, while `assertManagerMayOperate` keeps the
 * `agent:` rows it renders read-only.
 *
 * These rows drive the real `createTab`, `closePage`/`closeTab`,
 * `persistSync`/`restoreTabs`, `resolveTerminalCreationTarget` and manager
 * gates over window and webContents doubles — Electron is faked at the module
 * boundary exactly as the neighbouring persistence suite does, because the
 * questions here are about the host's own decisions, not about Chromium.
 */
import { describe, it, mock, beforeEach, afterEach, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { ownerKey, type WindowOwner } from '../../src/main/browser/window-owner';
import type { ShellDouble } from '../support/project-window-shell-double';

// Every persistence path in this file points at a scratch directory, so a test can
// never touch the developer's real saved-tabs.json or terminal session file.
const SCRATCH_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'tsc-wsg', 'tmp-web-hub-project-routing');
fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
process.env.ANTIFAN_DATA_ROOT = SCRATCH_DIR;

const WEB = ownerKey({ kind: 'web' });
const UNASSIGNED = ownerKey({ kind: 'unassigned' });
const PROJECT_A = 'proj-a';
const PROJECT_B = 'proj-b';
const PROJECT_A_KEY = ownerKey({ kind: 'project', projectId: PROJECT_A });
const PROJECT_B_KEY = ownerKey({ kind: 'project', projectId: PROJECT_B });
const AGENT_KEY = 'agent:tab-agent-1';
const WEB_OWNER: WindowOwner = { kind: 'web' };
const UNASSIGNED_OWNER: WindowOwner = { kind: 'unassigned' };
const PROJECT_OWNER: WindowOwner = { kind: 'project', projectId: 'proj-legacy' };

/** A per-test userData directory, so each test owns exactly one saved-tabs.json. */
let userDataDir = path.join(SCRATCH_DIR, 'userdata-default');
function freshUserData(name: string): string {
  const dir = path.join(SCRATCH_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  userDataDir = dir;
  return dir;
}

// ---------------------------------------------------------------------------
// Electron / vault boundaries
// ---------------------------------------------------------------------------

type CloseBehavior = 'destroy' | 'veto' | 'silent';

/**
 * A WebContents double with EventEmitter semantics and a scripted answer to
 * `close()`: 'destroy' dies the way an accepted page close does, 'veto' emits
 * `will-prevent-unload` (the beforeunload refusal), and 'silent' never answers
 * so the attempt settles on its outcome bound as `unknown`.
 */
interface FakeWebContents extends EventEmitter {
  id: number;
  destroyed: boolean;
  closeBehavior: CloseBehavior;
  closeCalls: number;
  closeArgs: unknown[];
  session: { cookies: { flushStore(): Promise<void> } };
  isDestroyed(): boolean;
  destroy(): void;
  close(options?: unknown): void;
  loadURL(url: string, options?: unknown): Promise<void>;
  getURL(): string;
  setAudioMuted(muted: boolean): void;
  setBackgroundThrottling(allowed: boolean): void;
  isCurrentlyAudible(): boolean;
  setWindowOpenHandler(handler: unknown): void;
  insertCSS(css: string): Promise<unknown>;
  executeJavaScript(code: string): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
}

let nextWebContentsId = 1000;
function makeWebContents(closeBehavior: CloseBehavior = 'destroy'): FakeWebContents {
  const emitter = new EventEmitter() as FakeWebContents;
  emitter.setMaxListeners(0);
  emitter.id = nextWebContentsId++;
  emitter.destroyed = false;
  emitter.closeBehavior = closeBehavior;
  emitter.closeCalls = 0;
  emitter.closeArgs = [];
  emitter.isDestroyed = () => emitter.destroyed;
  emitter.destroy = () => {
    if (emitter.destroyed) return;
    emitter.destroyed = true;
    emitter.emit('destroyed');
  };
  emitter.close = (options?: unknown) => {
    emitter.closeCalls += 1;
    emitter.closeArgs.push(options);
    if (emitter.destroyed) return;
    if (emitter.closeBehavior === 'veto') emitter.emit('will-prevent-unload');
    else if (emitter.closeBehavior === 'destroy') emitter.destroy();
    // 'silent': Chromium asked and nothing answered; the outcome bound decides.
  };
  emitter.loadURL = () => Promise.resolve();
  emitter.getURL = () => 'about:blank';
  emitter.setAudioMuted = () => {};
  emitter.setBackgroundThrottling = () => {};
  emitter.isCurrentlyAudible = () => false;
  emitter.session = { cookies: { flushStore: () => Promise.resolve() } };
  emitter.setWindowOpenHandler = () => {};
  emitter.insertCSS = () => Promise.resolve('');
  emitter.executeJavaScript = () => Promise.resolve(undefined);
  emitter.send = () => {};
  return emitter;
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
    fromWebContents: () => null,
    fromId: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  }),
  // One real view surface per tab record: the host reads `view.webContents` and
  // paints `setBackgroundColor`, nothing more on this path.
  WebContentsView: function WebContentsView() {
    return {
      webContents: makeWebContents(),
      setBounds: () => {},
      setBackgroundColor: () => {},
    };
  },
  Menu: { buildFromTemplate: () => ({ popup: () => {} }), setApplicationMenu: () => {} },
  MenuItem: function MenuItem() {},
  clipboard: { writeText: () => {}, readText: () => '' },
  ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {}, removeAllListeners: () => {} },
  shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }), showOpenDialog: () => Promise.resolve({ canceled: true }) },
  net: {},
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1440, height: 900 } }) },
  session: { fromPartition: () => ({}), defaultSession: {} },
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

// The host module is required after this point on purpose: the saved-tabs writer
// must see the armed rename fault, and fs member descriptors are captured when
// the host module initializes, so the controller below is installed before the
// require and left inert until a test arms it.
let armedRenameFault: Error | null = null;
const realFs = require('node:fs') as { renameSync: typeof fs.renameSync };
const untouchedRenameSync = realFs.renameSync;
realFs.renameSync = ((...args: Parameters<typeof fs.renameSync>) => {
  if (armedRenameFault) throw armedRenameFault;
  return untouchedRenameSync(...args);
}) as typeof fs.renameSync;

const { NativeTabHost } = require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');

type AnyRecord = Record<string, any>;

// ---------------------------------------------------------------------------
// Host harness
// ---------------------------------------------------------------------------

const tm = TerminalManager.getInstance() as AnyRecord;

interface HostOptions {
  owner?: WindowOwner;
}

/**
 * A host instance with its real methods. The constructor is bypassed because it
 * builds a real BrowserWindow; the fields the exercised members read are seeded
 * here, exactly as the other host harnesses in this lane do.
 */
function createHost(options: HostOptions = {}): AnyRecord {
  const host = Object.create(NativeTabHost.prototype) as AnyRecord;
  // Presentation/delegation seams: no-ops so a decision stays readable.
  host.broadcastState = () => {};
  host.updateLayout = () => {};
  host.schedulePersist = () => {};
  host.reassertPresentedView = () => {};
  host.switchTab = (id: string) => {
    host.activeTabId = id;
    return true;
  };
  // The lazy automation host builds CDP plumbing this suite never exercises;
  // closeTab's only reach into it is this one call.
  host.clearTabAgentWorking = () => {};
  host.isDisposed = false;
  host.isPersistingTabs = false;
  host.hasPendingPersist = false;
  host.persistTimer = null;
  host.tabs = new Map<string, AnyRecord>();
  host.tabOrder = [];
  host.activeTabId = '';
  host.automationTabId = null;
  host.activeProjectId = null;
  host.unloadVetoedTabIds = new Set<string>();
  host.pendingPageCloses = new Map<string, Promise<unknown>>();
  host.attemptAuthorizedCloses = new Set<string>();
  host.closeAdmission = null;
  host.recentlyClosedTabs = [];
  host.documentGenerations = new Map<string, number>();
  host.semanticDocumentGenerations = new Map<string, number>();
  host.targetOperationQueues = new Map<string, unknown>();
  host.targetOperationOwners = new Map<string, unknown>();
  host.ownedReloadTokens = new Map<string, unknown>();
  host.tabByWebContents = new WeakMap<object, unknown>();
  host.sessionTabPools = new Map<string, Set<string>>();
  host.closedTabAnchors = new Map<string, string>();
  host.terminalAgentAffinity = new Map<string, AnyRecord>();
  host.terminalWindows = new Map<number, unknown>();
  host.terminalWindowMeta = new Map<number, { sessionId?: string; isPopout?: boolean }>();
  host.terminalDisplayedSessions = new Map<string, Set<string>>();
  host.terminalDataBatches = new Map<string, unknown>();
  host.hibernatingTabIds = new Set<string>();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.terminalDataFlushTimer = null;
  host.terminalSubscriptionReleases = [];
  host.terminalFanoutMessages = 0;
  host.lastPersistedProjection = undefined;
  host.lastPersistedFileMtimeMs = undefined;
  host.lastPersistedFileSize = undefined;
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
  host.networkTracker = {
    ensureAttached: () => Promise.resolve(),
    detachTarget: () => {},
    retireDocumentRequests: () => {},
    resetInflight: () => {},
  };
  host.semanticRefRegistry = { invalidateTab: () => {} };
  host.capsuleManager = {
    list: () => [],
    getActive: () => null,
    create: () => ({ id: 'capsule-created', name: 'Created', workspacePath: process.cwd() }),
    switchTo: () => {},
  };
  host.windowWorkspaceAffiliation = null;
  host.popoutWindow = null;

  const shell = createShellDouble({ isSidebarOpen: false, sidebarWidth: 380 });
  shell.sidebarView = null;
  if (options.owner) {
    // Reason: the shell double carries the presentation members the host reads; the
    // owner is the one identity field this suite has to supply per host.
    (shell as unknown as { owner: WindowOwner }).owner = options.owner;
  }
  host.shell = shell as unknown as ShellDouble;
  return host;
}

/**
 * Reason: the harness builds hosts without the constructor (recorded above), so a
 * host has to be re-asserted as NativeTabHost when it crosses the public API.
 */
function asHost(host: AnyRecord): InstanceType<typeof NativeTabHost> {
  return host as unknown as InstanceType<typeof NativeTabHost>;
}

function tabWebContents(host: AnyRecord, tabId: string): FakeWebContents {
  return host.tabs.get(tabId).view.webContents as FakeWebContents;
}

function savedTabsPath(): string {
  return path.join(userDataDir, 'saved-tabs.json');
}

function readSavedTabsFile(): AnyRecord {
  return JSON.parse(fs.readFileSync(savedTabsPath(), 'utf8')) as AnyRecord;
}

function writeSavedTabsDocument(document: AnyRecord): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(savedTabsPath(), JSON.stringify(document, null, 2), 'utf8');
}

/** One persisted tab row in the shape `ownerRecordFromPersistData` writes. */
function savedTabRow(id: string, projectId?: string): AnyRecord {
  const row: AnyRecord = { id, url: `https://example.test/${id}`, title: id };
  if (projectId) row.projectId = projectId;
  return row;
}

/** The minimal Session record the manager's list/summary seam reads. */
function seedSession(id: string, sessionOwnerKey: string, cwd: string): void {
  tm.sessions.set(id, {
    id,
    name: id,
    cwd,
    buffer: '',
    bufferBytes: 0,
    chunks: [],
    lastSeq: 0,
    sessionGeneration: 1,
    state: 'running',
    ownerKey: sessionOwnerKey,
    pty: null,
    disposed: false,
  });
}

beforeEach(() => {
  userDataDir = path.join(SCRATCH_DIR, 'userdata-default');
  tm.sessions.clear();
});

afterEach(() => {
  // Hosts registered listeners on the process-wide manager through terminal
  // subscriptions this suite never installs; the sessions map is the shared
  // state rows seed, so it is the one cleanup that matters.
  tm.sessions.clear();
  armedRenameFault = null;
});

after(() => {
  realFs.renameSync = untouchedRenameSync;
  NodeModule._load = originalModuleLoad;
});

// ---------------------------------------------------------------------------
// 1. Project stamping at mint time
// ---------------------------------------------------------------------------

describe('web hub: project stamping', () => {
  it('stamps each minted tab with the hub\'s active project and keeps every project\'s tabs', () => {
    const host = createHost({ owner: WEB_OWNER });

    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    const a2 = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    const b1 = host.createTab('about:blank', false);

    assert.equal(host.activeProject(), PROJECT_B);
    assert.equal(host.tabs.get(a1).projectId, PROJECT_A, 'a tab minted while A was presented belongs to A');
    assert.equal(host.tabs.get(a2).projectId, PROJECT_A);
    assert.equal(host.tabs.get(b1).projectId, PROJECT_B, 'the switch re-stamps new mints, never old ones');
    assert.equal(host.tabs.get(a1).projectId, PROJECT_A, 'A\'s earlier tabs must not be re-stamped by the switch');

    assert.deepEqual(asHost(host).tabsForProject(PROJECT_A).sort(), [a1, a2].sort());
    assert.deepEqual(asHost(host).tabsForProject(PROJECT_B), [b1]);
    assert.deepEqual(asHost(host).tabsForProject('proj-nobody'), []);
    assert.deepEqual(asHost(host).tabsForProject(''), []);
    assert.equal(host.tabs.size, 3, 'switching projects closes nothing');
  });

  it('titles the window with the presented project and returns to the product title when cleared', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setWebHubProjectDescriptorResolver((id: string) => ({ title: id === PROJECT_A ? 'Alpha Store' : 'Beta Store' }));

    host.setActiveProject(PROJECT_A);
    assert.equal(host.shell.title, 'Alpha Store');
    assert.equal(host.projectWindowIdentity().title, 'Alpha Store', 'the chrome chip reads the same name');
    host.setActiveProject(PROJECT_B);
    assert.equal(host.shell.title, 'Beta Store', 'a project flip retitles the window');
    host.setActiveProject(null);
    assert.equal(host.shell.title, 'AntiFan Browser');
  });

  it('mints no stamp while no project is presented, and the Terminal Manager never stamps', () => {
    const webHost = createHost({ owner: WEB_OWNER });
    const unassignedHost = createHost({ owner: UNASSIGNED_OWNER });
    const projectOwnedHost = createHost({ owner: PROJECT_OWNER });

    const plain = webHost.createTab('about:blank', false);
    unassignedHost.setActiveProject(PROJECT_A);
    const fromUnassigned = unassignedHost.createTab('about:blank', false);
    const fromProjectOwner = projectOwnedHost.createTab('about:blank', false);

    assert.equal(webHost.tabs.get(plain).projectId, undefined, 'the hub stamps only while it presents a project');
    assert.deepEqual(asHost(webHost).tabsForProject(PROJECT_A), []);
    assert.equal(unassignedHost.tabs.get(fromUnassigned).projectId, undefined, 'the Terminal Manager never stamps a project');
    // Since the detach work landed, a `project:`-owned shell is a detached window:
    // its mints stamp the project that owns it (the owner key IS the identity),
    // which is exactly the "detached-minted tabs stamped X" criterion.
    assert.equal(projectOwnedHost.tabs.get(fromProjectOwner).projectId, 'proj-legacy', 'a detached project shell stamps its own project');
    assert.deepEqual(asHost(unassignedHost).tabsForProject(PROJECT_A), []);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-project live close
// ---------------------------------------------------------------------------

describe('web hub: closeTabsForProject', () => {
  it('closes only the named project\'s tabs and reports every refusal without destroying it', async () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setActiveProject(PROJECT_A);
    const closedByPage = host.createTab('about:blank', false);
    const vetoedByPage = host.createTab('about:blank', false);
    const silentPage = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    const foreign = host.createTab('about:blank', false);

    tabWebContents(host, vetoedByPage).closeBehavior = 'veto';
    tabWebContents(host, silentPage).closeBehavior = 'silent';

    // A silent page answers nothing inside the bound; the mocked clock settles it
    // as `unknown` instead of waiting out the real deadline.
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      let outcome: { closed: string[]; vetoed: string[] } | undefined;
      const pending = asHost(host).closeTabsForProject(PROJECT_A).then((result) => { outcome = result; });
      for (let rounds = 0; !outcome && rounds < 10; rounds += 1) {
        mock.timers.tick(2000);
        // Flush microtasks so each closePage's settled outcome re-enters the
        // per-project loop and arms the next page's bound before we tick again.
        await Promise.resolve();
        await Promise.resolve();
      }
      await pending;
      assert.ok(outcome, 'the per-project close never settled');
      assert.deepEqual(outcome.closed, [closedByPage], 'only the accepted page close reports closed');
      assert.deepEqual(outcome.vetoed.sort(), [vetoedByPage, silentPage].sort(), 'vetoed and unanswered pages are both reported, never destroyed');
    } finally {
      mock.timers.reset();
    }

    assert.equal(host.tabs.has(closedByPage), false, 'the closed tab\'s record is gone');
    assert.equal(host.tabs.has(vetoedByPage), true, 'a vetoing page keeps its record');
    assert.equal(host.tabs.has(silentPage), true, 'an unanswered close keeps its record');
    assert.equal(host.tabs.has(foreign), true, 'another project\'s tab is untouched');
    assert.equal(tabWebContents(host, vetoedByPage).destroyed, false, 'a vetoed page is never destroyed');
    assert.equal(tabWebContents(host, silentPage).destroyed, false);
    assert.equal(host.unloadVetoedTabIds.has(vetoedByPage), true, 'the observed veto marks the tab for the hibernation sweep');
  });
});

// ---------------------------------------------------------------------------
// 3. Durable per-project purge of the saved-tabs file
// ---------------------------------------------------------------------------

describe('web hub: purgePersistedTabsForProject', () => {
  it('removes only the named project\'s rows from owners.web and clears a dangling activeTabId', async () => {
    freshUserData('purge-surgical');
    const host = createHost({ owner: WEB_OWNER });
    writeSavedTabsDocument({
      version: 2,
      owners: {
        [WEB]: {
          activeTabId: 'a2',
          updatedAt: 1,
          tabs: [savedTabRow('a1', PROJECT_A), savedTabRow('b1', PROJECT_B), savedTabRow('a2', PROJECT_A), savedTabRow('free')],
        },
        [UNASSIGNED]: { updatedAt: 1, tabs: [savedTabRow('u1')] },
        [PROJECT_A_KEY]: { updatedAt: 1, tabs: [savedTabRow('legacy-a', PROJECT_A)] },
      },
    });

    const removed = await asHost(host).purgePersistedTabsForProject(PROJECT_A);

    // The whole `project:<id>` record drops with removal (the detach lifecycle's
    // purge arm) — the count covers it plus the two stamped web rows.
    assert.equal(removed, 3);
    const document = readSavedTabsFile();
    const webRecord = document.owners[WEB];
    assert.deepEqual(webRecord.tabs.map((row: AnyRecord) => row.id), ['b1', 'free'], 'B\'s rows and unclaimed rows survive');
    assert.equal(webRecord.activeTabId, undefined, 'the persisted active id pointed at a removed row and must not resurrect it');
    assert.deepEqual(document.owners[UNASSIGNED].tabs.map((row: AnyRecord) => row.id), ['u1'], 'the Terminal Manager\'s record is untouched');
    assert.equal(document.owners[PROJECT_A_KEY], undefined, 'the project:<id> record — marker and rows — is dropped, not folded');
    assert.equal(document.version, 2);
  });

  it('keeps a surviving activeTabId and writes nothing when the project has no rows', async () => {
    freshUserData('purge-idempotent');
    const host = createHost({ owner: WEB_OWNER });
    const source = {
      version: 2,
      owners: {
        [WEB]: { activeTabId: 'b1', updatedAt: 1, tabs: [savedTabRow('b1', PROJECT_B)] },
      },
    };
    writeSavedTabsDocument(source);

    assert.equal(await asHost(host).purgePersistedTabsForProject(PROJECT_A), 0, 'no matching rows means no write and no churn');
    assert.equal(readSavedTabsFile().owners[WEB].activeTabId, 'b1');
    assert.equal(await asHost(host).purgePersistedTabsForProject(''), 0, 'a blank project id removes nothing');
    assert.equal(await asHost(host).purgePersistedTabsForProject('   '), 0);
  });

  it('returns 0 when no saved-tabs file exists', async () => {
    freshUserData('purge-absent');
    const host = createHost({ owner: WEB_OWNER });
    assert.equal(fs.existsSync(savedTabsPath()), false, 'precondition: no file');
    assert.equal(await asHost(host).purgePersistedTabsForProject(PROJECT_A), 0);
    assert.equal(fs.existsSync(savedTabsPath()), false, 'the purge must not create a file to remove nothing from');
  });

  it('fails closed when the document cannot be written, leaving the source intact', async () => {
    freshUserData('purge-unwritable');
    const host = createHost({ owner: WEB_OWNER });
    const source = {
      version: 2,
      owners: { [WEB]: { updatedAt: 1, tabs: [savedTabRow('a1', PROJECT_A)] } },
    };
    writeSavedTabsDocument(source);
    const sourceBytes = fs.readFileSync(savedTabsPath(), 'utf8');

    armedRenameFault = new Error('rename refused');
    try {
      await assert.rejects(asHost(host).purgePersistedTabsForProject(PROJECT_A), /rename refused/, 'a failed write must fail the removal, not report a clean purge');
    } finally {
      armedRenameFault = null;
    }
    assert.equal(fs.readFileSync(savedTabsPath(), 'utf8'), sourceBytes, 'the original document is untouched');
    assert.deepEqual(
      fs.readdirSync(userDataDir).filter((name) => name !== 'saved-tabs.json'),
      [],
      'the abandoned temp file is cleaned up rather than mistaken for the document later'
    );
  });

  it('fails closed on a file that cannot be read back, rather than reporting nothing to remove', async () => {
    freshUserData('purge-corrupt');
    const host = createHost({ owner: WEB_OWNER });
    fs.writeFileSync(savedTabsPath(), 'this is not json', 'utf8');

    await assert.rejects(
      asHost(host).purgePersistedTabsForProject(PROJECT_A),
      /saved-tabs\.json|unreadable|corrupt|parse/i,
      'an unreadable saved-tabs file cannot prove the project\'s tabs are gone, so the purge must refuse'
    );
    assert.equal(fs.readFileSync(savedTabsPath(), 'utf8'), 'this is not json', 'a refused purge rewrites nothing');
  });
});

// ---------------------------------------------------------------------------
// 4. Terminal mint owner key
// ---------------------------------------------------------------------------

describe('web hub: terminal mint owner key', () => {
  it('mints under the presented project, falls back to web — never unassigned', () => {
    const host = createHost({ owner: WEB_OWNER });

    host.setActiveProject(PROJECT_A);
    assert.equal(asHost(host).resolveTerminalCreationTarget().ownerKey, PROJECT_A_KEY);
    host.setActiveProject(PROJECT_B);
    assert.equal(asHost(host).resolveTerminalCreationTarget().ownerKey, PROJECT_B_KEY, 'the mint follows the presented project');
    host.setActiveProject(null);
    assert.equal(asHost(host).resolveTerminalCreationTarget().ownerKey, WEB, 'with nothing presented the hub mints under itself, not the Terminal Manager');
    host.setActiveProject('   ');
    assert.equal(asHost(host).resolveTerminalCreationTarget().ownerKey, WEB, 'a blank active project normalizes to none');
  });

  it('mints in the presented project\'s folder after a switch, never the previous project\'s', () => {
    const host = createHost({ owner: WEB_OWNER });
    const folderA = path.join(SCRATCH_DIR, 'ws-mint-a');
    const folderB = path.join(SCRATCH_DIR, 'ws-mint-b');
    fs.mkdirSync(folderA, { recursive: true });
    fs.mkdirSync(folderB, { recursive: true });

    assert.equal(asHost(host).setWindowWorkspaceAffiliation({ workspacePath: folderA, capsuleId: 'capsule-a' }), true);
    host.setActiveProject(PROJECT_A);
    assert.equal(asHost(host).setWindowWorkspaceAffiliation({ workspacePath: folderB, capsuleId: 'capsule-b' }), true);
    host.setActiveProject(PROJECT_B);

    const target = asHost(host).resolveTerminalCreationTarget();
    assert.equal(target.cwd, path.normalize(folderB), 'the folder follows the project the owner names');
    assert.equal(target.capsuleId, 'capsule-b');
    assert.equal(target.ownerKey, PROJECT_B_KEY);
  });

  it('leaves non-web shells minting under their own key regardless of active project', () => {
    const unassignedHost = createHost({ owner: UNASSIGNED_OWNER });
    const projectOwnedHost = createHost({ owner: PROJECT_OWNER });

    unassignedHost.setActiveProject(PROJECT_A);
    assert.equal(asHost(unassignedHost).resolveTerminalCreationTarget().ownerKey, UNASSIGNED, 'the Terminal Manager keeps its sentinel');
    projectOwnedHost.setActiveProject(PROJECT_A);
    assert.equal(asHost(projectOwnedHost).resolveTerminalCreationTarget().ownerKey, ownerKey(PROJECT_OWNER));
  });
});

// ---------------------------------------------------------------------------
// 5. Terminal scope: the hub shows the presented project; only the Terminal
//    Manager shows everything, with agent rows read-only.
// ---------------------------------------------------------------------------

describe('web hub: terminal session scope', () => {
  it('shows only the presented project\'s sessions, switching scope when the project does', () => {
    const webHost = createHost({ owner: WEB_OWNER });
    const sidebar = makeWebContents();
    webHost.shell.sidebarView = { webContents: sidebar, setBounds: () => {} };

    seedSession('sess-a', PROJECT_A_KEY, process.cwd());
    seedSession('sess-b', PROJECT_B_KEY, process.cwd());
    seedSession('sess-agent', AGENT_KEY, process.cwd());
    seedSession('sess-unassigned', UNASSIGNED, process.cwd());

    webHost.setActiveProject(PROJECT_A);
    assert.deepEqual(
      asHost(webHost).visibleTerminalSessions(sidebar.id).map((row: AnyRecord) => row.id),
      ['sess-a'],
      'while presenting A the hub shows A\'s rows and nothing else'
    );
    webHost.setActiveProject(PROJECT_B);
    assert.deepEqual(
      asHost(webHost).visibleTerminalSessions(sidebar.id).map((row: AnyRecord) => row.id),
      ['sess-b'],
      'switching the presented project is the hub\'s click'
    );
    webHost.setActiveProject(null);
    assert.deepEqual(
      asHost(webHost).visibleTerminalSessions(sidebar.id).map((row: AnyRecord) => row.id),
      [],
      'with nothing presented the hub falls back to its own web key, which owns none of these rows'
    );
    // The hub is not the manager, so the manager read-only gate does not apply to
    // it — its scope, not the write gate, is what keeps agent rows out.
    assert.equal(asHost(webHost).assertManagerMayOperate('sess-agent', sidebar.id), true);
  });

  it('keeps the Unassigned window as the shared manager: every row visible, agent rows read-only', () => {
    const unassignedHost = createHost({ owner: UNASSIGNED_OWNER });
    const sidebar = makeWebContents();
    unassignedHost.shell.sidebarView = { webContents: sidebar, setBounds: () => {} };

    seedSession('sess-a', PROJECT_A_KEY, process.cwd());
    seedSession('sess-b', PROJECT_B_KEY, process.cwd());
    seedSession('sess-agent', AGENT_KEY, process.cwd());
    seedSession('sess-web', WEB, process.cwd());

    assert.deepEqual(
      asHost(unassignedHost).visibleTerminalSessions(sidebar.id).map((row: AnyRecord) => row.id).sort(),
      ['sess-a', 'sess-agent', 'sess-b', 'sess-web'],
      'the Terminal Manager sees every project\'s rows and the agent\'s own'
    );
    const gate = asHost(unassignedHost).assertManagerMayOperate('sess-agent', sidebar.id);
    assert.ok(gate !== true, 'the manager may read an agent\'s row, never drive it');
    assert.equal(gate.reason, 'MANAGER_AGENT_SESSION_READ_ONLY');
    assert.equal(asHost(unassignedHost).assertManagerMayOperate('sess-a', sidebar.id), true, 'a project-owned row stays operable');

    // A page inside the manager window is not the manager: the chrome check scopes
    // it to the window's own rows, which the Unassigned sentinel does not own.
    const pageSenderId = 424242;
    assert.deepEqual(
      asHost(unassignedHost).visibleTerminalSessions(pageSenderId).map((row: AnyRecord) => row.id),
      [],
      'a non-chrome sender sees only its own owner\'s rows'
    );
    assert.equal(asHost(unassignedHost).assertManagerMayOperate('sess-agent', pageSenderId), true, 'the read-only rule exists for the manager; a page was never one');
  });
});

// ---------------------------------------------------------------------------
// 6. Saved-tabs round-trip
// ---------------------------------------------------------------------------

describe('web hub: saved-tabs round-trip', () => {
  it('persists each tab\'s projectId and restores the stamps into a fresh hub', () => {
    freshUserData('round-trip');
    const first = createHost({ owner: WEB_OWNER });
    first.setActiveProject(PROJECT_A);
    const a1 = first.createTab('about:blank', false);
    const a2 = first.createTab('about:blank', false);
    first.setActiveProject(PROJECT_B);
    const b1 = first.createTab('about:blank', false);
    first.setActiveProject(null);
    const free = first.createTab('about:blank', false);

    asHost(first).persistSync();

    const onDisk = readSavedTabsFile();
    const webRecord = onDisk.owners[WEB];
    assert.ok(webRecord, 'the hub persists under its own owner key');
    const byId = new Map<string, AnyRecord>(webRecord.tabs.map((row: AnyRecord) => [row.id, row]));
    assert.equal(byId.get(a1)?.projectId, PROJECT_A);
    assert.equal(byId.get(a2)?.projectId, PROJECT_A);
    assert.equal(byId.get(b1)?.projectId, PROJECT_B);
    assert.equal('projectId' in (byId.get(free) ?? {}), false, 'a tab minted with no active project persists no stamp');

    const second = createHost({ owner: WEB_OWNER });
    // A foreign active project while restoring must not leak onto restored stamps.
    second.setActiveProject('proj-unrelated');
    second.setDevicePreset = () => true;
    asHost(second).restoreTabs();

    assert.equal(second.tabs.size, 4, 'every persisted row comes back');
    assert.deepEqual(
      second.tabOrder.map((id: string) => second.tabs.get(id)?.projectId),
      [PROJECT_A, PROJECT_A, PROJECT_B, undefined],
      'each restored tab carries the project it was minted under, in strip order'
    );
    assert.deepEqual(asHost(second).tabsForProject(PROJECT_A).length, 2);
    assert.deepEqual(asHost(second).tabsForProject('proj-unrelated'), [], 'the ambient project stamps nothing it did not mint');
  });
});

// ---------------------------------------------------------------------------
// 7. Presented tab follows the active project (web-hub scope contract)
// ---------------------------------------------------------------------------

describe('web hub: presented tab scope', () => {
  it('re-activates the remembered tab when switching back to a project', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.lastActiveTabByProject = new Map<string, string>();

    // Seed while the host is still pre-restore (hasRestoredTabs unset): the
    // field-only setActiveProject calls mint no repoint tabs.
    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    const a2 = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    const b1 = host.createTab('about:blank', false);
    host.activeTabId = b1;
    // A's remembered tab is a2: a stale memory, a closed id, or a foreign tab
    // would each break the switch-back contract, so the map asserts directly.
    host.lastActiveTabByProject.set(PROJECT_A, a2);
    host.hasRestoredTabs = true;

    host.setActiveProject(PROJECT_A);

    assert.equal(host.activeTabId, a2, 'the remembered tab for A is presented again');
    assert.equal(host.lastActiveTabByProject.get(PROJECT_A), a2);
    assert.equal(host.tabs.size, 3, 'the repoint never destroys the other project\'s tab');
  });

  it('activates the project\'s most recent tab when nothing is remembered, then mints one when it owns none', () => {
    const host = createHost({ owner: WEB_OWNER });

    host.setActiveProject(PROJECT_A);
    const older = host.createTab('about:blank', false);
    const newer = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    const foreign = host.createTab('about:blank', false);

    // lastActiveAt, not strip order, picks the landing tab.
    host.tabs.get(older).lastActiveAt = 100;
    host.tabs.get(newer).lastActiveAt = 200;
    host.tabs.get(foreign).lastActiveAt = 300;
    host.activeTabId = foreign;
    host.lastActiveTabByProject = new Map<string, string>();
    host.hasRestoredTabs = true;

    host.setActiveProject(PROJECT_A);
    assert.equal(host.activeTabId, newer, 'the most recently active A tab wins over strip order');

    host.setActiveProject('proj-empty');
    assert.notEqual(host.activeTabId, newer);
    const minted = host.tabs.get(host.activeTabId);
    assert.ok(minted, 'a fresh tab was presented');
    assert.equal(minted.projectId, 'proj-empty', 'the new tab is minted under the presented project');
    assert.equal(host.tabs.size, 4, 'minting adds, it never prunes foreign tabs');
  });

  it('a user-plane activation of a foreign-stamped tab flips the hub through Main\'s delegate', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    const b1 = host.createTab('about:blank', false);
    // The hub presents A's tab while the click lands on B's.
    host.setActiveProject(PROJECT_A);
    host.activeTabId = a1;
    // The flip is only live after restore: pre-restore switches must never move scope.
    host.hasRestoredTabs = true;

    // The delegate plays Main's half: record the flip, then apply the scope.
    const flips: string[] = [];
    host.setForeignProjectActivatedHandler((id: string) => {
      flips.push(id);
      host.setActiveProject(id);
    });

    const result = asHost(host).trySwitchTab(b1, { plane: 'user' });
    assert.equal(result.ok, true, 'the user may click a tab stamped for another project');
    assert.equal(host.activeTabId, b1);
    assert.deepEqual(flips, [PROJECT_B], 'Main is handed the flip so identity + scope change together');
    assert.equal(host.activeProject(), PROJECT_B, 'the delegate applied the flip like activateWebHubProject');
  });

  it('closing a project\'s tabs never flips the hub back onto the project being removed', async () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    const a2 = host.createTab('about:blank', false);
    // Removal clears the pointer first; the teardown then runs under no scope.
    host.setActiveProject(null);
    host.activeTabId = a1;
    const flips: string[] = [];
    host.setForeignProjectActivatedHandler((id: string) => { flips.push(id); host.setActiveProject(id); });
    // Each close repoints presentation onto the next tab of the same dying project,
    // exactly as finalizeClosedPage -> closeTab -> switchTab('user') does live.
    host.closePage = async (tabId: string) => {
      const next = [a1, a2].find((id) => id !== tabId && host.tabs.has(id));
      if (next) asHost(host).trySwitchTab(next, { plane: 'user' });
      host.tabs.delete(tabId);
      return 'closed';
    };

    const outcome = await host.closeTabsForProject(PROJECT_A);
    assert.deepEqual(outcome, { closed: [a1, a2], vetoed: [] });
    assert.deepEqual(flips, [], 'a teardown repoint is not the user picking the project');
    assert.equal(host.activeProject(), null);

    // The suppression is scoped to the loop: a later click flips again.
    host.setActiveProject(PROJECT_B);
    const b1 = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_A);
    const a3 = host.createTab('about:blank', false);
    host.activeTabId = a3;
    host.hasRestoredTabs = true;
    asHost(host).trySwitchTab(b1, { plane: 'user' });
    assert.deepEqual(flips, [PROJECT_B]);
  });

  it('closing the presented tab fails over inside the presented project and never flips the hub', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    const a2 = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    // B's tab is last in the global strip order: the pre-scope failover picked it.
    host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_A);
    host.activeTabId = a2;
    host.hasRestoredTabs = true;
    const flips: string[] = [];
    host.setForeignProjectActivatedHandler((id: string) => { flips.push(id); host.setActiveProject(id); });

    host.closeTab(a2);
    assert.equal(host.activeTabId, a1, 'the survivor of the presented project is presented');

    host.closeTab(a1);
    const minted = host.tabs.get(host.activeTabId);
    assert.ok(minted, 'an emptied project gets a fresh tab instead of a foreign one');
    assert.equal(minted.projectId, PROJECT_A);
    assert.deepEqual(flips, [], 'closing a tab is never the user picking another project');
    assert.equal(host.activeProject(), PROJECT_A);
  });

  it('a persisted hub project different from Main\'s boot project is restored through Main\'s delegate', () => {
    freshUserData('restore-delegate');
    const first = createHost({ owner: WEB_OWNER });
    first.setActiveProject(PROJECT_A);
    first.createTab('about:blank', false);
    asHost(first).persistSync();

    const second = createHost({ owner: WEB_OWNER });
    second.setWebHubProjectDescriptorResolver((id: string) => (id === PROJECT_A || id === PROJECT_B ? { title: id } : undefined));
    // Main's boot activation already chose B (and set B's affiliation).
    second.setActiveProject(PROJECT_B);
    const flips: string[] = [];
    second.setForeignProjectActivatedHandler((id: string) => { flips.push(id); second.setActiveProject(id); });
    second.setDevicePreset = () => true;
    asHost(second).restoreTabs();

    assert.deepEqual(flips, [PROJECT_A], 'the restore hands the persisted project to Main, never a bare field write');
    assert.equal(second.activeProject(), PROJECT_A);
  });

  it('an unprovable persisted hub project leaves Main\'s boot scope in place', () => {
    freshUserData('restore-unknown');
    const first = createHost({ owner: WEB_OWNER });
    first.setActiveProject('proj-removed');
    first.createTab('about:blank', false);
    asHost(first).persistSync();

    const second = createHost({ owner: WEB_OWNER });
    second.setWebHubProjectDescriptorResolver((id: string) => (id === PROJECT_B ? { title: id } : undefined));
    second.setActiveProject(PROJECT_B);
    const flips: string[] = [];
    second.setForeignProjectActivatedHandler((id: string) => { flips.push(id); });
    second.setDevicePreset = () => true;
    asHost(second).restoreTabs();

    assert.deepEqual(flips, []);
    assert.equal(second.activeProject(), PROJECT_B, 'nulling here would strand B\'s affiliation under no scope');
  });

  it('the agent plane refuses a foreign-project tab rather than re-scoping the window', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    host.setActiveProject(PROJECT_B);
    const b1 = host.createTab('about:blank', false);

    const flips: string[] = [];
    host.setForeignProjectActivatedHandler((id: string) => { flips.push(id); });
    host.setActiveProject(PROJECT_A);
    host.activeTabId = a1;

    const result = asHost(host).trySwitchTab(b1, { plane: 'agent' });
    assert.deepEqual(result, { ok: false, tabId: b1, reason: 'PROJECT_MISMATCH' }, 'a background switch must not re-scope the presented pane');
    assert.equal(host.activeTabId, a1, 'the presented tab is untouched on refusal');
    assert.equal(host.activeProject(), PROJECT_A, 'the agent switch never wrote the scope');
    assert.deepEqual(flips, [], 'no flip reaches Main from a refused switch');
  });

  it('getTabList projects the mint stamp onto the wire shape', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setActiveProject(PROJECT_A);
    const a1 = host.createTab('about:blank', false);
    host.setActiveProject(null);
    const free = host.createTab('about:blank', false);

    const list = asHost(host).getTabList();
    const byId = new Map(list.map((row) => [row.id, row]));
    assert.equal(byId.get(a1)?.projectId, PROJECT_A, 'the strip filter and search inventory read the wire field');
    assert.equal('projectId' in (byId.get(free) ?? {}), true, 'the key exists even when unstamped');
    assert.equal(byId.get(free)?.projectId, undefined, 'a shared tab carries no stamp on the wire');
    assert.equal(list.length, 2, 'the projection is a filter-free inventory');
  });

  it('identity title follows the active project and falls back without one', () => {
    const host = createHost({ owner: WEB_OWNER });
    host.setWebHubProjectDescriptorResolver((id: string) =>
      id === PROJECT_A
        ? { title: 'Tổng hợp', pathLabel: 'E:\\p\\tong-hop' }
        : id === PROJECT_B
          ? { title: 'Shop', pathLabel: 'E:\\p\\shop' }
          : undefined,
    );

    host.setActiveProject(PROJECT_A);
    let identity = asHost(host).projectWindowIdentity();
    assert.deepEqual(identity.owner, { kind: 'web' });
    assert.equal(identity.title, 'Tổng hợp');
    assert.equal(identity.activeProjectId, PROJECT_A);
    assert.equal(identity.pathLabel, 'E:\\p\\tong-hop');

    host.setActiveProject(PROJECT_B);
    identity = asHost(host).projectWindowIdentity();
    assert.equal(identity.title, 'Shop', 'the chrome follows the switch without waiting on a boot');
    assert.equal(identity.activeProjectId, PROJECT_B);

    host.setActiveProject(null);
    identity = asHost(host).projectWindowIdentity();
    assert.equal(identity.title, 'AntiFan Browser', 'no presented project keeps the product title');
    assert.equal(identity.activeProjectId, null);
  });

  it('non-web shells never repoint tabs or emit a project identity', () => {
    const unassignedHost = createHost({ owner: UNASSIGNED_OWNER });
    unassignedHost.hasRestoredTabs = true;
    unassignedHost.lastActiveTabByProject = new Map<string, string>();
    const t1 = unassignedHost.createTab('about:blank', false);
    unassignedHost.activeTabId = t1;

    unassignedHost.setActiveProject(PROJECT_A);
    assert.equal(unassignedHost.activeTabId, t1, 'the Terminal Manager never repoints a presented tab');
    assert.equal(unassignedHost.tabs.get(t1).projectId, undefined, 'and it mints no stamps');
    const identity = asHost(unassignedHost).projectWindowIdentity();
    assert.deepEqual(identity.owner, { kind: 'unassigned' });
    assert.equal(identity.activeProjectId, undefined, 'the scope field exists only for the web owner');
  });
});
