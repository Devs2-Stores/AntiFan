/**
 * Detached `project:<id>` window capability — the phase-01 unit surface:
 * the `detached` owner-record marker (write → normalize roundtrip, legacy fold
 * compat, marked-record fold-skip), the detached-owner doc-prefs gate, the mint
 * stamp derivation from the window's owner key, and the live transfer serializer
 * + ingest seam.
 *
 * The Electron boundary is stubbed exactly like the persistence lane: the module
 * load hook answers 'electron' and the vault modules before the host module is
 * required, so these tests run under plain `node --test` with no real windows.
 */
import { describe, it, before, after, afterEach, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { TerminalOutputRouter } from '../../src/main/browser/terminal-output-router';
import { ownerKey, type WindowOwner } from '../../src/main/browser/project-window-shell';
import type { ShellDouble } from '../support/project-window-shell-double';
import type { SavedTabsDocument } from '../../src/main/browser/native-tab-host';

const SCRATCH_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'tsc-wsg', 'tmp-detached-project-window');
fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
process.env.ANTIFAN_DATA_ROOT = SCRATCH_DIR;

const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'proj-a' };
const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'proj-b' };
const WEB: WindowOwner = { kind: 'web' };
const UNASSIGNED: WindowOwner = { kind: 'unassigned' };

let userDataDir = path.join(SCRATCH_DIR, 'userdata-default');

function freshUserData(name: string): string {
  const dir = path.join(SCRATCH_DIR, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  userDataDir = dir;
  return dir;
}

interface FakeWebContents {
  sent: Array<{ channel: string; args: unknown[] }>;
  mainFrame: { url: string };
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

function makeWebContents(): FakeWebContents {
  const wc: FakeWebContents = {
    sent: [],
    mainFrame: { url: 'file:///E:/Work/apps/AntiFan/src/renderer/sidebar.html' },
    isDestroyed: () => false,
    send(channel: string, ...args: unknown[]) {
      wc.sent.push({ channel, args });
    },
  };
  return wc;
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

// Reason: the harness needs the mutable module object (spies patch exports in
// place), and the import-type namespace cannot name that object — `typeof import`
// is the type of what require returns.
const hostModule = require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const {
  NativeTabHost,
  SAVED_TABS_SCHEMA_VERSION,
  normalizeSavedTabsDocument,
  savedTabsOwnerIsDetached,
  savedTabsFilePath,
  foldDetachedOwnerRecord,
  purgeSavedTabsFileForProject,
} = hostModule;
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');

type AnyRecord = Record<string, any>;

const tm = TerminalManager.getInstance() as AnyRecord;
const originalStartTerminal = tm.startTerminal;
const originalCreateSession = tm.createSession;
const originalCurrentCwd: string = tm.currentCwd;

function addTab(host: AnyRecord, id: string, state: AnyRecord = {}, projectId?: string): void {
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
    projectId,
  });
  host.tabOrder.push(id);
}

interface HostOptions {
  owner?: WindowOwner;
  tabs?: Array<[string, AnyRecord?]>;
  activeTabId?: string;
}

/**
 * A host instance with its real methods. The constructor is bypassed because it
 * builds a real BrowserWindow; the fields the exercised members read are seeded
 * here, exactly as the persistence lane's harness does.
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
  host.activeProjectId = null;
  host.detachedShellProbe = null;
  host.transferredSourceIds = new Set<string>();
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
  host.previewWatcherPool = { retain: () => () => {}, clear: () => {} };
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
  return host;
}

function savedTabsPath(): string {
  return path.join(userDataDir, 'saved-tabs.json');
}

function readSavedTabsFile(): AnyRecord {
  return JSON.parse(fs.readFileSync(savedTabsPath(), 'utf8')) as AnyRecord;
}

beforeEach(() => {
  userDataDir = path.join(SCRATCH_DIR, 'userdata-default');
});

afterEach(() => {
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

// ---------------------------------------------------------------------------
// 1. The detached marker: write, whitelist, roundtrip
// ---------------------------------------------------------------------------

describe('detached marker', () => {
  it('a project-owned host persists detached: true on its owner record', () => {
    freshUserData('marker-write');
    const detached = createHost({ owner: PROJECT_A, tabs: [['tab-a', {}]], activeTabId: 'tab-a' });
    detached.persistSync();

    const record = readSavedTabsFile().owners[ownerKey(PROJECT_A)];
    assert.equal(record.detached, true, 'the detach marker is the persisted exclusivity half');
    assert.deepEqual(record.tabs.map((tab: AnyRecord) => tab.id), ['tab-a']);
  });

  it('web and unassigned records never carry the marker', () => {
    freshUserData('marker-absent');
    createHost({ owner: WEB, tabs: [['tab-w', {}]] }).persistSync();
    createHost({ owner: UNASSIGNED, tabs: [['tab-u', {}]] }).persistSync();

    const doc = readSavedTabsFile();
    assert.equal(doc.owners.web.detached, undefined);
    assert.equal(doc.owners.unassigned.detached, undefined);
  });

  it('the normalizer keeps a marked record verbatim — the roundtrip a recreate depends on', () => {
    const { document } = normalizeSavedTabsDocument({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        'project:proj-a': {
          detached: true,
          tabs: [{ id: 'tab-1', url: 'https://example.test/tab-1' }],
          activeTabId: 'tab-1',
          updatedAt: 1,
        },
      },
    } as AnyRecord);
    const record = document.owners['project:proj-a'];
    assert.equal(record?.detached, true, 'normalizeSavedTabsDocument must whitelist detached');
    assert.equal(record?.activeTabId, 'tab-1');
    assert.equal(record?.tabs.length, 1);
  });

  it('savedTabsOwnerIsDetached answers the marker and fails closed on missing/corrupt data', () => {
    freshUserData('marker-probe');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), 'proj-a'), false, 'no file means not detached');

    createHost({ owner: PROJECT_A, tabs: [['tab-a', {}]] }).persistSync();
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), 'proj-a'), true);
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), 'proj-b'), false, 'a foreign record says nothing');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), ''), false, 'a blank id never answers detached');

    fs.writeFileSync(savedTabsPath(), '{ not json', 'utf8');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), 'proj-a'), false, 'unreadable file cannot prove detached');
  });
});

// ---------------------------------------------------------------------------
// 2. Fold behaviour: marked survives, legacy unmarked still folds
// ---------------------------------------------------------------------------

describe('legacy project-record fold', () => {
  it('a web host folds an unmarked legacy project record and keeps a marked one', () => {
    freshUserData('fold-marked');
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        'project:legacy': { tabs: [{ id: 'old-1', url: 'https://example.test/old-1' }], updatedAt: 1 },
        'project:proj-a': { detached: true, tabs: [{ id: 'new-1', url: 'https://example.test/new-1' }], updatedAt: 2 },
      },
    }), 'utf8');

    const web = createHost({ owner: WEB });
    const document = web.loadSavedTabsDocument() as SavedTabsDocument;
    assert.equal(document.owners['project:legacy'], undefined, 'unmarked records still fold — migration compat');
    assert.ok(document.owners['project:proj-a'], 'a marked record is never absorbed into the web record');
    assert.equal(document.owners['project:proj-a']?.detached, true);
    assert.deepEqual(
      document.owners.web?.tabs.map((tab: AnyRecord) => tab.id),
      ['old-1'],
      'the legacy rows land on the web record exactly as before',
    );
    // The migration write lands the folded document: the surviving marked record is
    // re-read from disk, not just held in memory.
    const onDisk = readSavedTabsFile();
    assert.equal(onDisk.owners['project:proj-a'].detached, true);
    assert.equal(onDisk.owners['project:legacy'], undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Document-level prefs isolation for detached owners
// ---------------------------------------------------------------------------

describe('detached document-prefs gate', () => {
  it('a project-owned persist touches only its record, never the document prefs', () => {
    freshUserData('prefs-gate');
    const hub = createHost({ owner: WEB, tabs: [['tab-hub', {}]], activeTabId: 'tab-hub' });
    hub.bookmarks = [{ url: 'https://hub.example/', title: 'hub bookmark' }];
    hub.persistSync();
    const before = readSavedTabsFile();
    assert.equal(before.bookmarks.length, 1);

    // The detached window persists while the hub's document prefs already exist.
    const detached = createHost({ owner: PROJECT_A, tabs: [['tab-x', {}]], activeTabId: 'tab-x' });
    detached.bookmarks = [{ url: 'https://injected.example/', title: 'must never land' }];
    detached.persistSync();

    const after = readSavedTabsFile();
    assert.deepEqual(after.bookmarks, before.bookmarks, 'a detached write must not clobber the hub\'s bookmarks');
    assert.equal(after.owners['project:proj-a'].detached, true);
    assert.deepEqual(after.owners['project:proj-a'].tabs.map((tab: AnyRecord) => tab.id), ['tab-x']);
    assert.deepEqual(after.owners.web.tabs.map((tab: AnyRecord) => tab.id), ['tab-hub'], 'sibling records survive verbatim');
  });
});

// ---------------------------------------------------------------------------
// 4. Mint stamp derivation from the owner key
// ---------------------------------------------------------------------------

describe('mint stamp derivation', () => {
  it('a detached host stamps its owner\'s project; the hub stamps its active project', () => {
    const detached = createHost({ owner: PROJECT_A });
    assert.equal(detached.stampProjectIdForMint(undefined, false), 'proj-a');
    assert.equal(detached.stampProjectIdForMint(null, false), undefined, 'an explicit null still mints a shared tab');
    assert.equal(detached.stampProjectIdForMint(undefined, true), undefined, 'agent surfaces never carry a stamp');

    const hub = createHost({ owner: WEB });
    hub.activeProjectId = 'proj-b';
    assert.equal(hub.stampProjectIdForMint(undefined, false), 'proj-b');
    hub.activeProjectId = null;
    assert.equal(hub.stampProjectIdForMint(undefined, false), undefined, 'an unscoped hub mints unscoped tabs');

    const manager = createHost({ owner: UNASSIGNED });
    assert.equal(manager.stampProjectIdForMint(undefined, false), undefined, 'the terminal-only window stamps nothing');
  });

  it('an explicit stamp request beats both the active project and the owner key', () => {
    const detached = createHost({ owner: PROJECT_A });
    const hub = createHost({ owner: WEB });
    hub.activeProjectId = 'proj-b';
    assert.equal(detached.stampProjectIdForMint('proj-c', false), 'proj-c');
    assert.equal(hub.stampProjectIdForMint('proj-c', false), 'proj-c');
  });
});

// ---------------------------------------------------------------------------
// 5. Live transfer: serialize on the hub, ingest on the detached host
// ---------------------------------------------------------------------------

describe('live tab transfer', () => {
  it('serializeProjectTabsForTransfer hands the stamped rows and the source active id', () => {
    const hub = createHost({ owner: WEB, tabs: [['t1', {}], ['t2', {}], ['other', {}]] });
    hub.tabs.get('t1').projectId = 'proj-a';
    hub.tabs.get('t2').projectId = 'proj-a';
    hub.tabs.get('other').projectId = 'proj-b';
    hub.activeTabId = 't2';
    hub.terminalAgentAffinity.set('term-1@gen1', {
      tabId: 't1',
      primaryTabId: 't1',
      managedTabIds: new Set(['t1', 't2']),
      closedAt: undefined,
    });
    // An affinity whose managed set is split across projects cannot transfer whole.
    hub.terminalAgentAffinity.set('term-2@gen1', {
      tabId: 'other',
      primaryTabId: 'other',
      managedTabIds: new Set(['other', 't1']),
      closedAt: undefined,
    });

    const serialized = hub.serializeProjectTabsForTransfer('proj-a');
    assert.deepEqual(serialized.tabs.map((row: AnyRecord) => row.id), ['t1', 't2'], 'strip order preserved, foreign stamps excluded');
    assert.equal(serialized.activeSourceTabId, 't2', 'the source\'s presented tab is named for the ingest side');
    assert.deepEqual(serialized.terminalAffinities, [
      { terminalId: 'term-1', primaryTabId: 't1', managedTabIds: ['t1', 't2'] },
    ], 'only the fully-moving affinity transfers');
  });

  it('ingestTransferredTabRows mints new ids, presents the source active tab, and dedupes re-delivery', () => {
    const detached = createHost({ owner: PROJECT_A });
    const mintedIds: string[] = [];
    const switched: string[] = [];
    // The real createTab builds a WebContentsView; the harness mints an id and seats
    // the record the ingest writes into instead.
    detached.createTab = (url: string) => {
      const id = `minted-${mintedIds.length + 1}`;
      mintedIds.push(id);
      addTab(detached, id, { url });
      return id;
    };
    detached.hasTab = (id: string) => detached.tabs.has(id);
    detached.switchTab = (id: string) => { switched.push(id); detached.activeTabId = id; };
    detached.bindTerminalAgentAffinity = () => {};
    detached.adoptChildTab = () => {};

    const rows = [
      { id: 'src-1', url: 'https://example.test/a', title: 'A', projectId: 'proj-a' },
      { id: 'src-2', url: 'https://example.test/b', title: 'B', projectId: 'proj-a' },
    ];
    const arrived = detached.ingestTransferredTabRows(rows, {
      activeSourceTabId: 'src-2',
      terminalAffinities: [{ terminalId: 'term-1', primaryTabId: 'src-1', managedTabIds: ['src-1', 'src-2'] }],
    });

    assert.equal(arrived.length, 2, 'both rows land');
    assert.notEqual(arrived[0], 'src-1', 'the ingested tab carries THIS window\'s minted id');
    assert.deepEqual(switched, [arrived[1]], 'the source window\'s active tab is presented here');
    assert.equal(detached.tabs.get(arrived[0]).state.url, 'https://example.test/a');
    assert.equal(detached.tabs.get(arrived[0]).projectId, 'proj-a', 'the stamp rides the row');

    const replay = detached.ingestTransferredTabRows(rows, { activeSourceTabId: 'src-2' });
    assert.deepEqual(replay, [], 'a second delivery of the same source ids lands nothing');
    assert.equal(detached.tabs.size, 2);
  });

  it('agent-surface rows and ephemeral/offscreen rows are refused at ingest', () => {
    const detached = createHost({ owner: PROJECT_A });
    detached.createTab = (url: string) => {
      const id = `minted-${detached.tabs.size + 1}`;
      addTab(detached, id, { url });
      return id;
    };
    detached.hasTab = (id: string) => detached.tabs.has(id);
    detached.switchTab = () => {};

    const arrived = detached.ingestTransferredTabRows([
      { id: 'keep', url: 'https://example.test/keep' },
      { id: 'eph', url: 'https://example.test/e', ephemeral: true },
      { id: 'off', url: 'https://example.test/o', offscreen: true },
    ]);
    assert.equal(arrived.length, 1, 'only the real tab lands');
    assert.equal(detached.tabs.get(arrived[0]!).state.url, 'https://example.test/keep');
  });
});

// ---------------------------------------------------------------------------
// 6. Scoped fold: the reattach's file mutation
// ---------------------------------------------------------------------------

describe('foldDetachedOwnerRecord', () => {
  it('merges the marked record into owners.web, stamped and deduped, and clears the marker', async () => {
    freshUserData('fold-scoped');
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        web: { tabs: [{ id: 'hub-1', url: 'https://example.test/hub-1' }], activeTabId: 'hub-1', updatedAt: 1 },
        'project:proj-a': {
          detached: true,
          tabs: [
            { id: 'proj-1', url: 'https://example.test/p1' },
            { id: 'proj-2', url: 'https://example.test/p2' },
            { id: 'hub-1', url: 'https://example.test/dup' },
          ],
          activeTabId: 'proj-2',
          updatedAt: 2,
        },
      },
    }), 'utf8');

    const result = await foldDetachedOwnerRecord(savedTabsPath(), 'project:proj-a');
    assert.equal(result.folded, true);
    assert.equal(result.tabs.length, 3, 'the report names every row the record carried');

    const doc = normalizeSavedTabsDocument(readSavedTabsFile() as AnyRecord).document;
    assert.equal(doc.owners['project:proj-a'], undefined, 'the record — marker included — leaves the document');
    const projRows = (doc.owners.web?.tabs ?? []).filter((tab: AnyRecord) => tab.projectId === 'proj-a');
    assert.deepEqual(projRows.map((tab: AnyRecord) => tab.id), ['proj-1', 'proj-2'], 'rows merge stamped; the colliding id is skipped');
    assert.equal(doc.owners.web?.activeTabId, 'hub-1', 'the web record keeps its own active pointer');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), 'proj-a'), false, 'the marker is gone');
  });

  it('fills the web record\'s absent active pointers and merges affinities deduped', async () => {
    freshUserData('fold-pointers');
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        web: {
          tabs: [],
          terminalAffinities: [{ terminalId: 'term-1', primaryTabId: 'shared-1', managedTabIds: ['shared-1'] }],
          updatedAt: 1,
        },
        'project:proj-a': {
          detached: true,
          tabs: [{ id: 'p1', url: 'https://example.test/p1' }],
          activeTabId: 'p1',
          activeProjectId: 'proj-a',
          terminalAffinities: [
            { terminalId: 'term-1', primaryTabId: 'shared-1', managedTabIds: ['shared-1'] },
            { terminalId: 'term-2', primaryTabId: 'p1', managedTabIds: ['p1'] },
          ],
          updatedAt: 5,
        },
      },
    }), 'utf8');

    await foldDetachedOwnerRecord(savedTabsPath(), 'project:proj-a');
    const web = normalizeSavedTabsDocument(readSavedTabsFile() as AnyRecord).document.owners.web;
    assert.equal(web?.activeTabId, 'p1', 'an empty web record inherits the folded pointer');
    assert.equal(web?.activeProjectId, 'proj-a');
    assert.deepEqual(
      (web?.terminalAffinities ?? []).map((aff: { terminalId: string; primaryTabId: string }) => `${aff.terminalId}:${aff.primaryTabId}`),
      ['term-1:shared-1', 'term-2:p1'],
      'affinities merge deduped by terminal+primary',
    );
  });

  it('fails closed on wrong key, absent record, missing file, and corrupt file', async () => {
    freshUserData('fold-noop');
    const missing = await foldDetachedOwnerRecord(savedTabsPath(), 'project:proj-a');
    assert.equal(missing.folded, false, 'no file folds nothing');
    fs.writeFileSync(savedTabsPath(), '{broken', 'utf8');
    await assert.rejects(
      () => foldDetachedOwnerRecord(savedTabsPath(), 'project:proj-a'),
      /unreadable|corrupt/,
      'a file it cannot read fails closed',
    );
    fs.rmSync(savedTabsPath(), { force: true });
    assert.equal((await foldDetachedOwnerRecord(savedTabsPath(), 'web')).folded, false, 'a non-project key is refused');
    assert.equal((await foldDetachedOwnerRecord(savedTabsPath(), 'project:')).folded, false, 'a bare prefix is malformed');
    assert.equal((await foldDetachedOwnerRecord(savedTabsPath(), '  ')).folded, false);
  });
});

// ---------------------------------------------------------------------------
// 7. The purge's project:* whole-record arm
// ---------------------------------------------------------------------------

describe('purge project owner record', () => {
  it('drops the whole project:<id> record AND stamped web rows in one write', async () => {
    freshUserData('purge-project-arm');
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: SAVED_TABS_SCHEMA_VERSION,
      owners: {
        web: {
          tabs: [
            { id: 'w1', url: 'https://example.test/w1' },
            { id: 'v1', url: 'https://example.test/v1', projectId: 'proj-a' },
          ],
          activeTabId: 'w1',
          updatedAt: 1,
        },
        'project:proj-a': {
          detached: true,
          tabs: [{ id: 'p1', url: 'https://example.test/p1' }],
          activeTabId: 'p1',
          updatedAt: 2,
        },
      },
    }), 'utf8');

    const removed = await purgeSavedTabsFileForProject(savedTabsPath(), 'proj-a');
    const doc = normalizeSavedTabsDocument(readSavedTabsFile() as AnyRecord).document;
    assert.equal(doc.owners['project:proj-a'], undefined, 'the whole record — marker and rows — is dropped, not folded');
    assert.deepEqual((doc.owners.web?.tabs ?? []).map((tab: AnyRecord) => tab.id), ['w1'], 'stamped web rows go with it');
    assert.equal(removed, 2, 'the count reports both arms');
  });
});

// ---------------------------------------------------------------------------
// 8. The live-ingest seam a reattach feeds
// ---------------------------------------------------------------------------

describe('ingestPersistedOwnerRows', () => {
  it('mints ids, dedupes by persisted tabId, and never touches the presented tab', () => {
    const hub = createHost({ owner: WEB, tabs: [['hub-live', {}]], activeTabId: 'hub-live' });
    const minted: string[] = [];
    hub.createTab = (url: string) => {
      const id = `minted-${minted.length + 1}`;
      minted.push(id);
      addTab(hub, id, { url });
      return id;
    };
    hub.hasTab = (id: string) => hub.tabs.has(id);
    const switched: string[] = [];
    hub.switchTab = (id: string) => { switched.push(id); };

    const first = hub.ingestPersistedOwnerRows([
      { id: 'p1', url: 'https://example.test/p1', projectId: 'proj-a' },
      { id: 'hub-live', url: 'https://example.test/collision', projectId: 'proj-a' },
      { id: 'p2', url: 'https://example.test/p2', projectId: 'proj-a' },
    ]);
    assert.equal(first.minted.length, 2, 'the collision with a live tab id is deduped, not re-mounted');
    assert.equal(first.skipped.length, 1);
    assert.equal(hub.tabs.get(first.minted[0]).projectId, 'proj-a', 'the row stamp rides into the live tab');
    assert.equal(hub.activeTabId, 'hub-live', 'the presented tab is never the ingest\'s business');
    assert.deepEqual(switched, [], 'no presentation change');

    const replay = hub.ingestPersistedOwnerRows([{ id: 'p1', url: 'https://example.test/p1', projectId: 'proj-a' }]);
    assert.equal(replay.minted.length, 0, 'a re-delivery of the same persisted ids lands nothing');
    assert.equal(hub.tabs.size, 3, 'hub-live plus the two minted rows');
  });
});

// ---------------------------------------------------------------------------
// 9. Fold is an explicit action — never a close or quit hook
// ---------------------------------------------------------------------------

describe('ordinary close and quit never fold', () => {
  it('dispose persists the marked record and never invokes the fold helper', () => {
    freshUserData('close-no-fold');
    let foldCalls = 0;
    const originalFold = hostModule.foldDetachedOwnerRecord;
    hostModule.foldDetachedOwnerRecord = ((...args: unknown[]) => {
      foldCalls += 1;
      return (originalFold as (...a: unknown[]) => unknown)(...args);
    }) as typeof originalFold;
    try {
      const detached = createHost({ owner: PROJECT_A, tabs: [['tab-a', {}]], activeTabId: 'tab-a' });
      detached.persistSync();
      // `flushAllSessions` waits on daemon plumbing the harness never builds; the
      // close semantics under test — final persist, then disposal — need it silent.
      detached.flushAllSessions = () => Promise.resolve();
      // The ordinary teardown both paths share: `handleShellClosed` → onShellDisposed
      // → host.dispose(), and a committed quit's dispose is the same call. Nothing in
      // it may reach the fold.
      detached.dispose();
      assert.equal(foldCalls, 0, 'no close path may run the scoped fold');
      assert.equal(detached.isDisposed, true, 'the dispose itself ran');
      const doc = normalizeSavedTabsDocument(readSavedTabsFile() as AnyRecord).document;
      assert.equal(doc.owners['project:proj-a']?.detached, true, 'the record survives the close marked');
      assert.equal(doc.owners['project:proj-a']?.tabs.length, 1);
      assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), 'proj-a'), true, 'the marker survives for the next boot');
    } finally {
      hostModule.foldDetachedOwnerRecord = originalFold;
    }
  });
});
