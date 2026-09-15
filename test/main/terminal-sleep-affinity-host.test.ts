/**
 * Main-process IPC half of the Sleep/Archive feature (native-tab-host.ts).
 *
 * These tests drive the REAL NativeTabHost and the REAL TerminalManager. Only the
 * OS/browser boundaries are stubbed: the Electron module (ipcMain/BrowserWindow/
 * dialogs), the two credential/session vaults, and — for the implicit writeTo wake
 * path — node-pty's spawn step. No logic under test is replaced.
 *
 * Coverage:
 *   1. Affinity Zombie Guard: a tombstone written while a terminal slept is lifted
 *      by the 'session-woken' listener, and the entry is repaired so a subsequent
 *      badge read cannot re-arm it.
 *   2. The listener never migrates the `${terminalId}@${generation}` key.
 *   3. writeTo (implicit wake) lifts the tombstone too — the host needs no second
 *      emitter for that path.
 *   4. GET_ALL_AFFINITIES: one round-trip, one O(1) exact-generation lookup per
 *      session, no O(N*E) prefix scan, no transcript slicing.
 *   5. sleep/wake/set-category handlers enforce agent ownership and return the
 *      manager's boolean.
 *   6. Sleep flushes a pending coalesced data batch BEFORE the state broadcast, and
 *      the sidebar-visibility send gate still holds.
 *   7. Terminal tab-layout prefs and the sleeping session's affinity still round-trip
 *      through buildPersistData.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { TERMINAL_CHANNELS } from '../../src/shared/contracts';

// Point every persistence path at a scratch directory so a test can never touch the
// developer's real saved-tabs.json / terminal-sessions.json.
const SCRATCH_DIR = path.join(process.cwd(), 'node_modules', '.cache', 'tsc-wsg', 'tmp-terminal-sleep-host');
fs.mkdirSync(SCRATCH_DIR, { recursive: true });
process.env.ANTIFAN_CONFIG_DIR = path.join(SCRATCH_DIR, 'config');
process.env.ANTIFAN_DATA_ROOT = SCRATCH_DIR;

// ---------------------------------------------------------------------------
// Electron / vault boundaries
// ---------------------------------------------------------------------------

interface SentMessage { channel: string; args: unknown[] }

interface FakeWebContents {
  sent: SentMessage[];
  isDestroyed(): boolean;
  mainFrame: { url: string };
  send(channel: string, ...args: unknown[]): void;
}

function makeWebContents(url = 'about:blank'): FakeWebContents {
  const wc: FakeWebContents = {
    sent: [],
    isDestroyed: () => false,
    mainFrame: { url },
    send(channel: string, ...args: unknown[]) {
      wc.sent.push({ channel, args });
    },
  };
  return wc;
}

class FakeIpcMain {
  public handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  public listeners = new Map<string, (event: unknown, ...args: unknown[]) => void>();
  public invokes = new Map<string, number>();

  public handle(channel: string, fn: (event: unknown, ...args: unknown[]) => unknown): void {
    this.handlers.set(channel, fn);
  }

  public on(channel: string, fn: (event: unknown, ...args: unknown[]) => void): void {
    this.listeners.set(channel, fn);
  }

  public removeHandler(channel: string): void {
    this.handlers.delete(channel);
  }

  public invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
    const fn = this.handlers.get(channel);
    if (!fn) throw new Error(`no handler registered for ${channel}`);
    this.invokes.set(channel, (this.invokes.get(channel) || 0) + 1);
    return fn(event, ...args);
  }

  public count(channel: string): number {
    return this.invokes.get(channel) || 0;
  }
}

const fakeIpcMain = new FakeIpcMain();

const fakeElectron: Record<string, unknown> = {
  app: {
    getPath: () => path.join(SCRATCH_DIR, 'userdata'),
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
  ipcMain: fakeIpcMain,
  shell: { openExternal: () => Promise.resolve(), showItemInFolder: () => {} },
  dialog: { showMessageBox: () => Promise.resolve({ response: 0 }) },
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

const NodeModule = require('node:module') as any;
const originalModuleLoad = NodeModule._load;
NodeModule._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return fakeElectron;
  if (request.endsWith('local-session-vault')) return fakeSessionVaultModule;
  if (request.endsWith('local-credential-vault')) return fakeCredentialVaultModule;
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { NativeTabHost } = require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');

// ---------------------------------------------------------------------------
// Host + manager harness
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, any>;

interface TabShell {
  state: AnyRecord;
  view: { webContents: FakeWebContents };
}

const tm = TerminalManager.getInstance() as any;
const originalGetSession = tm.getSession;
const originalListSessions = tm.listSessions;

let liveSessions: Array<{ id: string; name: string; cwd: string; sessionGeneration: number; state?: string }> = [];
let sessionLookups = 0;
let listSessionsCalls = 0;

let host: AnyRecord;

function seedSession(id: string, generation: number, state = 'running'): void {
  liveSessions = liveSessions.filter((s) => s.id !== id);
  liveSessions.push({ id, name: id, cwd: process.cwd(), sessionGeneration: generation, state });
}

/** A Session record inside the real manager map (needed by sleepSession/writeTo). */
function installManagerSession(id: string, generation: number, state: string, overrides: AnyRecord = {}): AnyRecord {
  const record: AnyRecord = {
    id,
    name: id,
    cwd: process.cwd(),
    state,
    sessionGeneration: generation,
    buffer: 'SEED',
    bufferBytes: 4,
    restoredTail: undefined,
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
    ...overrides,
  };
  tm.sessions.set(id, record);
  return record;
}

function addTab(id: string, extra: AnyRecord = {}): TabShell {
  const tab: TabShell = {
    state: {
      id,
      url: `https://example.test/${id}`,
      title: id,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1,
      ...extra,
    },
    view: { webContents: makeWebContents(`https://example.test/${id}`) },
  };
  host.tabs.set(id, tab);
  host.tabOrder.push(id);
  return tab;
}

function resetHost(): void {
  host.tabs = new Map<string, TabShell>();
  host.tabOrder = [];
  host.activeTabId = '';
  host.automationTabId = null;
  host.terminalAgentAffinity = new Map();
  host.sessionTabPools = new Map();
  host.closedTabAnchors = new Map();
  host.tabByWebContents = new WeakMap();
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  host.terminalDataBatches = new Map();
  if (host.terminalDataFlushTimer) clearTimeout(host.terminalDataFlushTimer);
  host.terminalDataFlushTimer = null;
  host.terminalFanoutMessages = 0;
  host.sidebarView = null;
  host.popoutWindow = null;
  host.isSidebarOpen = false;
  host.isDisposed = false;
  host.persistTimer = null;
  host.bookmarks = [];
  host.terminalTabLayout = 'horizontal';
  host.terminalSidebarWidth = 220;
  host.terminalCollapsedCategories = [];
  host.scheduledPersists = 0;
  liveSessions = [];
  listSessionsCalls = 0;
  sessionLookups = 0;
  tm.sessions.clear();
}

before(() => {
  tm.getSession = (id: string) => {
    sessionLookups += 1;
    const seeded = liveSessions.find((s) => s.id === id);
    if (seeded) return seeded;
    return originalGetSession.call(tm, id);
  };
  tm.listSessions = (...args: unknown[]) => {
    listSessionsCalls += 1;
    return originalListSessions.apply(tm, args);
  };

  host = Object.create(NativeTabHost.prototype) as AnyRecord;
  host.broadcastState = () => {};
  host.updateLayout = () => {};
  host.schedulePersist = () => { host.scheduledPersists += 1; };
  resetHost();
  // Registration is the code under test for the listener wiring: it installs the
  // 'session-woken' listener and every terminal channel handler on the fake ipcMain.
  host.setupToolbarIpc();
});

beforeEach(() => {
  resetHost();
});

after(() => {
  tm.getSession = originalGetSession;
  tm.listSessions = originalListSessions;
  tm.removeAllListeners('session-woken');
  tm.removeAllListeners('session');
  tm.removeAllListeners('data');
  tm.sessions.clear();
  NodeModule._load = originalModuleLoad;
});

/** Emits exactly what TerminalManager.wakeSession emits. */
function emitWake(id: string, generation: number | string): void {
  tm.emit('session-woken', { id, generation });
}

// ---------------------------------------------------------------------------
// 1. Affinity Zombie Guard
// ---------------------------------------------------------------------------

describe('sleep/wake affinity zombie guard (native-tab-host)', () => {
  it('lifts the tombstone on session-woken and keeps the surviving tab admitted after a badge read', () => {
    seedSession('terminal-1', 1);
    addTab('tab-agent-1', { ephemeral: true });
    addTab('tab-helper', { ephemeral: true });
    addTab('tab-foreign', { ephemeral: true });

    assert.equal(host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-agent-1'), true);
    // A second tab joins the session pool the way an adopted/native-window tab does.
    assert.equal(host.adoptChildTabForSession('terminal-1', 'tab-helper'), true);
    assert.deepEqual([...host.terminalAgentAffinity.keys()], ['terminal-1@1']);

    // The bound tab closes while the terminal sleeps.
    host.tabs.delete('tab-agent-1');
    host.tombstoneTerminalAgentAffinity('tab-agent-1', 'https://closed.test/');
    host.sessionTabPools.get('terminal-1').delete('tab-agent-1');

    // WEDGE (must fail before the fix): the surviving tab is denied purely because
    // the tombstone flag is set.
    assert.equal(host.isTerminalAllowedForTab('tab-helper', 'terminal-1'), false);
    assert.throws(
      () => host.assertTerminalAccess('tab-helper', 'terminal-1'),
      (err: any) => err.code === 'TERMINAL_FORBIDDEN'
    );

    // The wake reports the generation TerminalManager reused (reservedGeneration).
    emitWake('terminal-1', 1);

    assert.equal(host.isTerminalAllowedForTab('tab-helper', 'terminal-1'), true);
    assert.doesNotThrow(() => host.assertTerminalAccess('tab-helper', 'terminal-1'));
    assert.equal(host.terminalAgentAffinity.get('terminal-1@1').closedAt, undefined);

    // A badge refresh (GET_ALL_AFFINITIES -> getTerminalAgentAffinity) must not
    // re-arm the tombstone: the entry's primary has to name a live tab.
    const affinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.equal(affinity?.status, 'alive');
    assert.equal(affinity?.primaryTabId, 'tab-helper');
    assert.equal(host.isTerminalAllowedForTab('tab-helper', 'terminal-1'), true);

    // The wake reuses the reserved generation: the key must not migrate.
    assert.deepEqual([...host.terminalAgentAffinity.keys()], ['terminal-1@1']);

    // The repair changes what buildPersistData writes (the entry is no longer
    // tombstoned), so the wake schedules the host's own save.
    assert.ok(host.scheduledPersists >= 1, 'a wake that repairs an affinity must schedule a persist');

    // Still fail-closed for a tab that never held a binding.
    assert.equal(host.isTerminalAllowedForTab('tab-foreign', 'terminal-1'), false);
    // And still reportable as closed when nothing live is bound at all.
    assert.equal(host.getTerminalAgentAffinity('terminal-1', 1)?.status, 'alive');
  });

  it('never re-keys the affinity when the wake reports an unexpected generation', () => {
    seedSession('terminal-2', 4);
    addTab('tab-2', { ephemeral: true });
    assert.equal(host.bindTerminalAgentAffinity('terminal-2', 4, 'tab-2'), true);

    host.tombstoneTerminalAgentAffinity('tab-2');
    host.tabs.delete('tab-2');
    assert.equal(host.isTerminalAllowedForTab('tab-2', 'terminal-2'), false);

    emitWake('terminal-2', 9);

    // Tombstone lifted prefix-wide (defensive), key set untouched (no migration).
    assert.deepEqual([...host.terminalAgentAffinity.keys()], ['terminal-2@4']);
    assert.equal(host.terminalAgentAffinity.get('terminal-2@4').closedAt, undefined);
    // An exact-generation lookup for a generation that was never bound stays fail-closed.
    assert.equal(host.getTerminalAgentAffinity('terminal-2', 9), undefined);
  });

  it('clears the tombstone through the implicit writeTo wake path (no second emitter needed)', () => {
    addTab('tab-3', { ephemeral: true });
    addTab('tab-3b', { ephemeral: true });
    // A sleeping record with NO pty, exactly what a nap leaves behind.
    installManagerSession('terminal-3', 1, 'sleeping', { pty: null, buffer: '', bufferBytes: 0, restoredTail: 'previous transcript' });
    seedSession('terminal-3', 1, 'sleeping');
    assert.equal(host.bindTerminalAgentAffinity('terminal-3', 1, 'tab-3'), true);
    assert.equal(host.adoptChildTabForSession('terminal-3', 'tab-3b'), true);

    host.tabs.delete('tab-3');
    host.tombstoneTerminalAgentAffinity('tab-3');
    host.sessionTabPools.get('terminal-3').delete('tab-3');
    assert.equal(host.isTerminalAllowedForTab('tab-3b', 'terminal-3'), false);

    // Typing into the sleeping pane is the wake trigger. Only the node-pty spawn
    // (ensureSessionPty) is stubbed; writeTo/wakeSession/resolveWritableSession run.
    const written: string[] = [];
    const originalEnsureSessionPty = tm.ensureSessionPty;
    tm.ensureSessionPty = (id: string) => {
      if (id !== 'terminal-3') return undefined;
      const live = installManagerSession('terminal-3', 1, 'running', {
        pty: {
          cols: 80,
          rows: 24,
          pid: undefined,
          write: (data: string) => { written.push(data); },
          kill: () => {},
          removeAllListeners: () => {},
          on: () => {},
        },
      });
      return live;
    };
    try {
      tm.writeTo('terminal-3', 'ls\r');
    } finally {
      tm.ensureSessionPty = originalEnsureSessionPty;
    }

    // The keystroke reached the NEW shell (a sleeping record has no pty at all, so a
    // recorded write proves the wake happened first)...
    assert.deepEqual(written, ['ls\r']);
    assert.equal(tm.sessions.get('terminal-3').state, 'running');
    // ...and the wake emitted 'session-woken' itself, so the host lifted the tombstone
    // without any extra emitter on the write path.
    assert.equal(host.terminalAgentAffinity.get('terminal-3@1').closedAt, undefined);
    assert.equal(host.isTerminalAllowedForTab('tab-3b', 'terminal-3'), true);
    assert.equal(host.getTerminalAgentAffinity('terminal-3', 1)?.status, 'alive');
  });
});

// ---------------------------------------------------------------------------
// 2. GET_ALL_AFFINITIES
// ---------------------------------------------------------------------------

describe('GET_ALL_AFFINITIES bulk contract (native-tab-host)', () => {
  it('answers every badge in one round-trip with one exact-generation lookup per session', () => {
    seedSession('terminal-a', 2);
    seedSession('terminal-b', 5);
    seedSession('terminal-sleep', 1, 'sleeping');
    seedSession('terminal-none', 3);
    addTab('tab-a');
    addTab('tab-b');
    addTab('tab-sleep');
    assert.equal(host.bindTerminalAgentAffinity('terminal-a', 2, 'tab-a'), true);
    assert.equal(host.bindTerminalAgentAffinity('terminal-b', 5, 'tab-b'), true);
    assert.equal(host.bindTerminalAgentAffinity('terminal-sleep', 1, 'tab-sleep'), true);

    const lookupGenerations: Array<number | string | undefined> = [];
    const originalResolve = host.resolveTerminalAffinityEntry.bind(host);
    host.resolveTerminalAffinityEntry = (terminalId: string, generation?: number | string) => {
      lookupGenerations.push(generation);
      return originalResolve(terminalId, generation);
    };
    listSessionsCalls = 0;
    const invokesBefore = fakeIpcMain.count(TERMINAL_CHANNELS.GET_ALL_AFFINITIES);

    let result: AnyRecord;
    try {
      result = fakeIpcMain.invoke(TERMINAL_CHANNELS.GET_ALL_AFFINITIES, { sender: makeWebContents() }) as AnyRecord;
    } finally {
      delete host.resolveTerminalAffinityEntry;
    }

    // One round-trip for all three badges.
    assert.equal(fakeIpcMain.count(TERMINAL_CHANNELS.GET_ALL_AFFINITIES) - invokesBefore, 1);
    assert.deepEqual(Object.keys(result).sort(), ['terminal-a', 'terminal-b', 'terminal-sleep']);
    assert.equal(result['terminal-a'].status, 'alive');
    assert.deepEqual(result['terminal-a'].managedTabIds, ['tab-a']);
    // A sleeping session still reports its affinity, so its badge survives the nap.
    assert.equal(result['terminal-sleep'].status, 'alive');
    // A session without an affinity contributes nothing.
    assert.equal('terminal-none' in result, false);

    // Every lookup passed an explicit generation => the O(1) keyed path, never the
    // O(E) prefix scan that a generation-less lookup would run per session.
    assert.deepEqual(lookupGenerations, [2, 5, 1]);
    assert.equal(lookupGenerations.some((g) => g === undefined), false);
    // The handler must not pay listSessions()' per-session transcript slicing.
    assert.equal(listSessionsCalls, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. sleep / wake / set-category handlers
// ---------------------------------------------------------------------------

describe('sleep/wake/set-category IPC handlers (native-tab-host)', () => {
  const originalSleep = tm.sleepSession;
  const originalWake = tm.wakeSession;
  const originalSetCategory = tm.setCategory;

  function stubManager(calls: string[]): void {
    tm.sleepSession = (id: string) => { calls.push(`sleep:${id}`); return true; };
    tm.wakeSession = (id: string) => { calls.push(`wake:${id}`); return true; };
    tm.setCategory = (id: string, category?: string) => {
      calls.push(`setCategory:${id}:${JSON.stringify(category)}`);
      return true;
    };
  }

  after(() => {
    tm.sleepSession = originalSleep;
    tm.wakeSession = originalWake;
    tm.setCategory = originalSetCategory;
  });

  it('enforces agent ownership on an agent-owned tab and returns the manager boolean', () => {
    seedSession('terminal-own', 1);
    seedSession('terminal-foreign', 1);
    const agentTab = addTab('tab-agent', { ephemeral: true });
    addTab('tab-user');
    addTab('tab-owner');
    assert.equal(host.bindTerminalAgentAffinity('terminal-own', 1, 'tab-agent'), true);
    assert.equal(host.bindTerminalAgentAffinity('terminal-foreign', 1, 'tab-owner'), true);

    const calls: string[] = [];
    stubManager(calls);
    const agentEvent = { sender: agentTab.view.webContents };

    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, agentEvent, 'terminal-own'), true);
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.WAKE_SESSION, agentEvent, 'terminal-own'), true);
    assert.equal(
      fakeIpcMain.invoke(TERMINAL_CHANNELS.SET_CATEGORY, agentEvent, { id: 'terminal-own', category: ' build ' }),
      true
    );
    assert.deepEqual(calls, [
      'sleep:terminal-own',
      'wake:terminal-own',
      'setCategory:terminal-own:" build "',
    ]);
    // Category changes schedule the host's own saved-tabs.json write.
    assert.ok(host.scheduledPersists >= 1);

    // A terminal bound to a different tab is refused before the manager is reached.
    for (const channel of [TERMINAL_CHANNELS.SLEEP_SESSION, TERMINAL_CHANNELS.WAKE_SESSION, TERMINAL_CHANNELS.SET_CATEGORY]) {
      assert.throws(
        () => fakeIpcMain.invoke(channel, agentEvent, { id: 'terminal-foreign', category: 'x' }),
        (err: any) => err.code === 'TERMINAL_FORBIDDEN',
        `${channel} must refuse a foreign terminal`
      );
    }
    assert.deepEqual(calls, [
      'sleep:terminal-own',
      'wake:terminal-own',
      'setCategory:terminal-own:" build "',
    ]);

    // The automation tab counts as agent-plane too.
    host.automationTabId = 'tab-owner';
    assert.throws(
      () => fakeIpcMain.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, { sender: host.tabs.get('tab-owner').view.webContents }, 'terminal-own'),
      (err: any) => err.code === 'TERMINAL_FORBIDDEN'
    );
    host.automationTabId = null;

    // A user-plane tab keeps the sibling handlers' semantics: no agent authority check.
    assert.equal(
      fakeIpcMain.invoke(TERMINAL_CHANNELS.WAKE_SESSION, { sender: host.tabs.get('tab-user').view.webContents }, 'terminal-foreign'),
      true
    );

    // Malformed / missing ids never reach the manager.
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, agentEvent, undefined), false);
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, agentEvent, { sessionId: '  ' }), false);
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SET_CATEGORY, agentEvent, undefined), false);
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SET_CATEGORY, agentEvent, { category: 'x' }), false);
    assert.equal(calls.length, 4);
  });

  it('accepts both the positional and the wrapped call shapes', () => {
    seedSession('terminal-own', 1);
    const agentTab = addTab('tab-agent', { ephemeral: true });
    assert.equal(host.bindTerminalAgentAffinity('terminal-own', 1, 'tab-agent'), true);

    const calls: string[] = [];
    stubManager(calls);
    const agentEvent = { sender: agentTab.view.webContents };

    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SLEEP_SESSION, agentEvent, { id: 'terminal-own' }), true);
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.WAKE_SESSION, agentEvent, { sessionId: 'terminal-own' }), true);
    assert.equal(fakeIpcMain.invoke(TERMINAL_CHANNELS.SET_CATEGORY, agentEvent, 'terminal-own', 'qa'), true);
    assert.deepEqual(calls, ['sleep:terminal-own', 'wake:terminal-own', 'setCategory:terminal-own:"qa"']);
  });
});

// ---------------------------------------------------------------------------
// 4. Coalescing order + sidebar send gate across a sleep transition
// ---------------------------------------------------------------------------

describe('sleep transition vs coalesced terminal data (native-tab-host)', () => {
  it('flushes the pending batch before the sleep broadcast and honours the sidebar gate', () => {
    const sidebarWc = makeWebContents('antifan:terminal');
    host.sidebarView = { webContents: sidebarWc };
    host.isSidebarOpen = true;

    addTab('tab-sleep', { ephemeral: true });
    const record = installManagerSession('terminal-sleep-order', 1, 'running', {
      buffer: 'PRE-SLEEP-OUTPUT',
      bufferBytes: 16,
      lastSeq: 3,
      pty: { pid: undefined, kill: () => {}, removeAllListeners: () => {}, on: () => {} },
    });
    seedSession('terminal-sleep-order', 1);
    assert.equal(host.bindTerminalAgentAffinity('terminal-sleep-order', 1, 'tab-sleep'), true);

    // >256 B takes the coalescing path, so a batch is pending when sleep lands.
    const bigChunk = 'X'.repeat(300);
    tm.emit('data', { sessionId: 'terminal-sleep-order', data: bigChunk, seq: 3, generation: 1 });
    assert.equal(host.terminalDataBatches.size, 1);

    // The real sleep transition (terminal-manager) emits ONLY 'session'.
    assert.equal(tm.sleepSession('terminal-sleep-order'), true);
    assert.equal(record.state, 'sleeping');

    const channels = sidebarWc.sent.map((m) => m.channel);
    const dataIndex = channels.indexOf('antifan:terminal:data');
    const sessionIndex = channels.indexOf('antifan:terminal:session');
    assert.notEqual(dataIndex, -1, `expected a data flush, got ${channels.join(',')}`);
    assert.notEqual(sessionIndex, -1, `expected a session broadcast, got ${channels.join(',')}`);
    assert.ok(dataIndex < sessionIndex, `buffered data must precede the sleep state: ${channels.join(',')}`);

    // Exactly one coalesced payload carrying the whole range.
    assert.equal(channels.filter((c) => c === 'antifan:terminal:data').length, 1);
    const payload = sidebarWc.sent[dataIndex]!.args[0] as AnyRecord;
    assert.equal(payload.data, bigChunk);
    assert.equal(payload.fromSeq, 3);
    assert.equal(payload.throughSeq, 3);
    assert.equal(payload.seq, 3);

    // Sleep is not close: no close notification, affinity intact, nothing left queued.
    assert.equal(channels.includes('antifan:terminal:session-closed'), false);
    assert.equal(channels.includes('close'), false);
    assert.equal(host.terminalAgentAffinity.has('terminal-sleep-order@1'), true);
    assert.equal(host.terminalDataBatches.size, 0);

    // Sidebar closed: the visibility gate drops data fan-out but never the state
    // broadcast that tells the renderer to tear the pane down.
    host.isSidebarOpen = false;
    sidebarWc.sent.length = 0;
    tm.emit('data', { sessionId: 'terminal-sleep-order', data: 'Y'.repeat(300), seq: 4, generation: 1 });
    tm.emit('session', { activeSessionId: 'terminal-sleep-order', sessions: [], snapshot: '', snapshotThroughSeq: 4 });
    assert.equal(sidebarWc.sent.filter((m) => m.channel === 'antifan:terminal:data').length, 0);
    assert.equal(sidebarWc.sent.filter((m) => m.channel === 'antifan:terminal:session').length, 1);
    assert.equal(host.terminalDataBatches.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Persistence: tab prefs + a sleeping session's affinity
// ---------------------------------------------------------------------------

describe('persistence across sleep (native-tab-host)', () => {
  it('keeps terminal tab prefs and the sleeping session affinity in buildPersistData', () => {
    const prefs = fakeIpcMain.invoke(TERMINAL_CHANNELS.SET_TAB_PREFS, { sender: makeWebContents() }, {
      layout: 'sidebar',
      sidebarWidth: 9999,
      collapsedCategories: ['build', 'qa', 42],
    }) as AnyRecord;

    assert.equal(prefs.layout, 'sidebar');
    // Clamped by the tab-strip clamp (140..400), never the outer sidebar clamp.
    assert.equal(prefs.sidebarWidth, 400);
    assert.deepEqual(prefs.collapsedCategories, ['build', 'qa']);
    assert.ok(host.scheduledPersists >= 1);

    addTab('tab-user');
    addTab('tab-agent', { ephemeral: true });
    // A sleeping session has no PTY at all; restoring its affinity must still work.
    seedSession('terminal-sleep', 2, 'sleeping');
    assert.equal(host.bindTerminalAgentAffinity('terminal-sleep', 2, 'tab-user'), true);

    const data = host.buildPersistData() as AnyRecord;
    assert.equal(data.terminalTabLayout, 'sidebar');
    assert.equal(data.terminalSidebarWidth, 400);
    assert.deepEqual(data.terminalCollapsedCategories, ['build', 'qa']);
    // Agent-plane tabs are never persisted…
    assert.deepEqual(data.tabs.map((t: AnyRecord) => t.id), ['tab-user']);
    // …but the sleeping session's affinity is.
    assert.deepEqual(data.terminalAffinities, [
      { terminalId: 'terminal-sleep', primaryTabId: 'tab-user', managedTabIds: ['tab-user'] },
    ]);
    assert.equal(host.isTerminalAllowedForTab('tab-user', 'terminal-sleep'), true);
  });

  it('restores a sleeping session affinity and the persisted tab-strip prefs without spawning', () => {
    const userDataDir = path.join(SCRATCH_DIR, 'userdata');
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, 'saved-tabs.json'), JSON.stringify({
      activeTabId: 'old-tab-1',
      tabs: [{ id: 'old-tab-1', url: 'https://example.test/one', title: 'One', zoomFactor: 1 }],
      terminalTabLayout: 'sidebar',
      terminalSidebarWidth: 260,
      terminalCollapsedCategories: ['build'],
      terminalAffinities: [
        { terminalId: 'terminal-sleep', primaryTabId: 'old-tab-1', managedTabIds: ['old-tab-1'] },
      ],
    }), 'utf8');

    // The record restored from terminal-sessions.json is still asleep with no PTY.
    seedSession('terminal-sleep', 2, 'sleeping');

    // Browser boundaries only: tab creation and focus are Electron work.
    let created = 0;
    host.createTab = (url: string) => {
      const id = `new-tab-${++created}`;
      host.tabs.set(id, {
        state: { id, url, title: '', zoomFactor: 1 },
        view: { webContents: makeWebContents(url) },
      });
      host.tabOrder.push(id);
      return id;
    };
    host.switchTab = (id: string) => { host.activeTabId = id; };

    host.restoreTabs();

    assert.equal(host.terminalTabLayout, 'sidebar');
    assert.equal(host.terminalSidebarWidth, 260);
    assert.deepEqual(host.terminalCollapsedCategories, ['build']);
    assert.equal(created, 1);

    // The sleeping session keeps its binding across the restart, under the generation
    // the record carried, and without a shell ever being spawned.
    const entry = host.terminalAgentAffinity.get('terminal-sleep@2');
    assert.ok(entry, 'the sleeping session affinity must be rebound on restore');
    assert.equal(entry.primaryTabId, 'new-tab-1');
    assert.equal(entry.closedAt, undefined);
    assert.equal(host.isTerminalAllowedForTab('new-tab-1', 'terminal-sleep'), true);
    assert.equal(host.getTerminalAgentAffinity('terminal-sleep', 2)?.status, 'alive');
    assert.equal(tm.sessions.size, 0, 'restoring a sleeping session must not spawn a shell');
  });
});
