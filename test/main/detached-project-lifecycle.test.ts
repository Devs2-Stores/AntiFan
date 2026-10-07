/**
 * Detach lifecycle — the phase-02 index-level surface: `reattachProject` arms
 * (live shell closed through the coordinator, marked-but-dead fold), the
 * fold→ingest→persist ordering contract, the remove-detached arm's ordered
 * close→purge, and the reattach latch that keeps a mid-reattach project out of
 * every shell-creation path.
 *
 * The Electron boundary is stubbed through `installElectronStub` before
 * `src/main/index` is required, exactly like the project-rename-remove lane; the
 * real `NativeTabHost` instances are the same constructor-bypassed harness the
 * persistence/detach suites use. The close coordinator cannot reach a testing
 * shell — there is no `projectWindows` directory under `node --test` — so the
 * dedicated driver seam drives the same settle production's `handle.settled`
 * carries: dispose + final persistSync inside the driver, then the resolved
 * report.
 */
import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installElectronStub } from '../support/electron-stub';

installElectronStub();

import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { ownerKey, type WindowOwner } from '../../src/main/browser/project-window-shell';
import type { ProjectWindowShell } from '../../src/main/browser/project-window-shell';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import type { CloseReport } from '../../src/main/browser/project-close-coordinator';
import {
  installShellForTesting,
  isKnownProjectId,
  projectWindowAuthority,
  removeProjectEntry,
  setDetachedShellCloseDriverForTesting,
  setDetachedShellHostFactoryForTesting,
  setProjectWindowManagerForTesting,
  setReattachForceConfirmationForTesting,
  setWindowStateManagerForTesting,
  projectRegistry as sharedProjectRegistry,
} from '../../src/main/index';
import { ProjectWindowManager } from '../../src/main/browser/project-window-manager';
import type { WindowStateManager } from '../../src/main/browser/window-state';

// Reason: the harness needs the mutable module object (spies patch exports in
// place), and an import-type namespace cannot name that object — `typeof import`
// is the type of what require returns.
const hostModule = require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { NativeTabHost: HostCtor, normalizeSavedTabsDocument, savedTabsOwnerIsDetached } = hostModule;
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');

// Same convention as the persistence/detach harnesses: the host's un-constructed
// instance and the parsed persisted document are boundary objects the compiler
// lost track of, so member access goes through this in-process record type.
type AnyRecord = Record<string, any>;

const PROJECT_R = 'project-00000000-0000-4000-8000-0000000000d1';
const WORKSPACE_R = 'workspace-00000000-0000-4000-8000-0000000000d1';
const PROJECT_S = 'project-00000000-0000-4000-8000-0000000000e2';
const WORKSPACE_S = 'workspace-00000000-0000-4000-8000-0000000000e2';
const PROJECT_T = 'project-00000000-0000-4000-8000-0000000000f3';
const WORKSPACE_T = 'workspace-00000000-0000-4000-8000-0000000000f3';
const PROJECT_U = 'project-00000000-0000-4000-8000-0000000000c4';
const WORKSPACE_U = 'workspace-00000000-0000-4000-8000-0000000000c4';
const PROJECT_V = 'project-00000000-0000-4000-8000-0000000000b5';
const WORKSPACE_V = 'workspace-00000000-0000-4000-8000-0000000000b5';
const PROJECT_W = 'project-00000000-0000-4000-8000-0000000000a6';
const WORKSPACE_W = 'workspace-00000000-0000-4000-8000-0000000000a6';
const PROJECT_X = 'project-00000000-0000-4000-8000-000000000097';
const WORKSPACE_X = 'workspace-00000000-0000-4000-8000-000000000097';
const PROJECT_Y = 'project-00000000-0000-4000-8000-000000000088';
const WORKSPACE_Y = 'workspace-00000000-0000-4000-8000-000000000088';
const WEB: WindowOwner = { kind: 'web' };

let tmpDir = '';
let workspacePath = '';

function savedTabsPath(): string {
  return path.join(process.env.ANTIFAN_USER_DATA ?? '', 'saved-tabs.json');
}

function readDoc(): AnyRecord {
  return normalizeSavedTabsDocument(
    JSON.parse(fs.readFileSync(savedTabsPath(), 'utf8')) as AnyRecord,
  ).document;
}

function seedProject(projectId: string, workspaceId: string, name: string): void {
  // `ensureInitialWorkspace` refuses a record whose state is 'closed', and the
  // suite re-seeds ids that an earlier test's `unseedProject` closed — reopen
  // first so seeding is idempotent within the process.
  try {
    const prior = sharedProjectRegistry.getProject(projectId);
    if (prior.state === 'closed') sharedProjectRegistry.registerProject({ ...prior, state: 'open' });
  } catch {
    // not registered yet — the happy path
  }
  sharedProjectRegistry.ensureInitialWorkspace(projectId, workspaceId, workspacePath, tmpDir);
  const record = sharedProjectRegistry.getProject(projectId);
  sharedProjectRegistry.registerProject({ ...record, name, state: 'open' });
}

function unseedProject(projectId: string): void {
  try {
    const record = sharedProjectRegistry.getProject(projectId);
    sharedProjectRegistry.registerProject({ ...record, state: 'closed' });
  } catch {
    // already gone
  }
}

/** A fake terminal manager: no sessions, nothing claimed — removals run unconfirmed. */
function installEmptyTerminalManager(): () => void {
  const holder = TerminalManager as unknown as { instance?: unknown };
  const previous = holder.instance;
  holder.instance = {
    listSessions: () => [],
    sessionOwnerKey: () => undefined,
    sessionCapsuleId: () => undefined,
    closeSession: async () => true,
  };
  return () => { holder.instance = previous; };
}

function makeWebContents(): { isDestroyed(): boolean; send(...args: unknown[]): void; mainFrame: { url: string } } {
  return {
    mainFrame: { url: 'file:///E:/Work/apps/AntiFan/src/renderer/sidebar.html' },
    isDestroyed: () => false,
    send: () => {},
  };
}

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

/**
 * A host instance with its real methods, constructor bypassed — the persistence
 * lane's harness verbatim, minus the fields this suite never reaches.
 */
function createHost(owner: WindowOwner, tabs: Array<[string, AnyRecord?]> = [], activeTabId?: string): AnyRecord {
  const host = Object.create(HostCtor.prototype) as AnyRecord;
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
  (shell as unknown as { owner: WindowOwner }).owner = owner;
  host.shell = shell;
  host.windowWorkspaceAffiliation = null;
  for (const [id, state] of tabs) addTab(host, id, state);
  if (activeTabId) host.activeTabId = activeTabId;
  return host;
}

/** Let the hub mint live tabs during ingest without a real WebContentsView. */
function stubMinting(host: AnyRecord): string[] {
  const minted: string[] = [];
  host.createTab = (url: string) => {
    const id = `minted-${minted.length + 1}`;
    minted.push(id);
    addTab(host, id, { url });
    return id;
  };
  host.hasTab = (id: string) => host.tabs.has(id);
  host.switchTab = () => {};
  host.bindTerminalAgentAffinity = () => {};
  host.adoptChildTab = () => {};
  return minted;
}

/** A window-like the lifecycle code paths touch: focusable and destroy-tracked. */
function installShell(owner: WindowOwner, host?: NativeTabHost) {
  const win = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => {},
  };
  const shellLike = { owner, window: win } as unknown as ProjectWindowShell;
  const unregister = installShellForTesting(shellLike, host);
  return { shell: shellLike, window: win, unregister };
}

/** The CloseReport shape `recordCloseReport` reads, with only the meaning filled in. */
function closeReportFor(ownerKeyValue: string, disposition: 'closed' | 'retained', haltedBy: CloseReport['haltedBy']): CloseReport {
  return {
    attemptId: 1,
    ownerKey: ownerKeyValue,
    intent: 'user',
    coalescedRequests: 0,
    coalesced: false,
    disposition,
    phase: disposition === 'closed' ? 'closed' : 'open',
    closed: [],
    skipped: [],
    failed: [],
    refusals: [],
    haltedBy,
    surface: null,
    survivingTabIds: [],
    partial: false,
    lastBrowserShellGone: false,
    warnings: [],
    summary: `test close: ${disposition}`,
  };
}

/**
 * Wrap one module export with a sequence marker for the duration of a test.
 * Compiled CommonJS looks the export up per call, so `src/main/index` hits the
 * spy exactly where production does. Reason: `closeDetachedShellForLifecycle`
 * is module-local — the fold/purge exports are the only observable join points.
 * `typeof` on the import-type names the export's signature; no `any` needed.
 */
type FoldExport = typeof hostModule.foldDetachedOwnerRecord;
type PurgeExport = typeof hostModule.purgeSavedTabsFileForProject;

function spyFold(sequence: string[], probe?: () => void): () => void {
  const original = hostModule.foldDetachedOwnerRecord;
  hostModule.foldDetachedOwnerRecord = ((...args: Parameters<FoldExport>) => {
    sequence.push('fold');
    probe?.();
    return original(...args);
  }) as FoldExport;
  return () => { hostModule.foldDetachedOwnerRecord = original; };
}

function spyPurge(sequence: string[]): () => void {
  const original = hostModule.purgeSavedTabsFileForProject;
  hostModule.purgeSavedTabsFileForProject = ((...args: Parameters<PurgeExport>) => {
    sequence.push('purge');
    return original(...args);
  }) as PurgeExport;
  return () => { hostModule.purgeSavedTabsFileForProject = original; };
}

describe('detach lifecycle', () => {
  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p02-lifecycle-'));
    process.env.ANTIFAN_USER_DATA = path.join(tmpDir, 'user-data');
    fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });
    workspacePath = path.join(tmpDir, 'workspace-alpha');
    fs.mkdirSync(workspacePath, { recursive: true });
  });

  after(() => {
    delete process.env.ANTIFAN_USER_DATA;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  it('ARM A: a live detached shell closes through the coordinator and folds strictly post-persistSync', async () => {
    seedProject(PROJECT_R, WORKSPACE_R, 'Reattachable');
    const sequence: string[] = [];
    const foldedWhileDisposed = { value: null as boolean | null };
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_R }, [['pd-1'], ['pd-2']], 'pd-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_R }, detachedHost as NativeTabHost);
    const hubHost = createHost(WEB, [['hub-1']], 'hub-1');
    hubHost.persistSync();
    const minted = stubMinting(hubHost);
    const hub = installShell(WEB, hubHost as NativeTabHost);

    const unspyFold = spyFold(sequence, () => {
      foldedWhileDisposed.value = detachedHost.isDisposed === true;
    });
    setDetachedShellCloseDriverForTesting(async (shell) => {
      sequence.push('close');
      // The driver's job is the dispose settle production's `handle.settled`
      // carries: the dying host's final synchronous write happens INSIDE the
      // close, and only then does the report resolve.
      const realPersist = detachedHost.persistSync.bind(detachedHost) as () => void;
      detachedHost.persistSync = () => { sequence.push('persistSync'); realPersist(); };
      detachedHost.persistSync();
      detachedHost.isDisposed = true;
      detached.window.destroyed = true;
      return closeReportFor(ownerKey(shell.owner), 'closed', null);
    });
    try {
      const result = await projectWindowAuthority.reattachProject(PROJECT_R);
      assert.deepStrictEqual(result, { status: 'REATTACHED', projectId: PROJECT_R });
    } finally {
      setDetachedShellCloseDriverForTesting(null);
      unspyFold();
      detached.unregister();
      hub.unregister();
      unseedProject(PROJECT_R);
    }

    assert.ok(sequence.indexOf('close') < sequence.indexOf('persistSync'), 'the final write is inside the close');
    assert.ok(sequence.indexOf('persistSync') < sequence.indexOf('fold'), 'fold runs strictly post-persistSync — the awaited report is post-dispose');
    assert.equal(foldedWhileDisposed.value, true, 'the fold sees a disposed host');

    const doc = readDoc();
    assert.equal(doc.owners[`project:${PROJECT_R}`], undefined, 'the marked record left the document');
    const webIds = (doc.owners.web?.tabs ?? []).map((tab: AnyRecord) => tab.id);
    assert.ok(minted.every((id) => webIds.includes(id)), 'every minted row is in owners.web');
    const stamps = minted.map((id) => hubHost.tabs.get(id)?.projectId);
    assert.deepStrictEqual(stamps, minted.map(() => PROJECT_R), 'ingested live tabs carry the stamp');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), PROJECT_R), false, 'the marker is cleared');
  });

  it('a vetoed shell close refuses the reattach and never folds', async () => {
    seedProject(PROJECT_S, WORKSPACE_S, 'Vetoed');
    const sequence: string[] = [];
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_S }, [['sv-1']], 'sv-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_S }, detachedHost as NativeTabHost);
    const hubHost = createHost(WEB, [['hub-1']], 'hub-1');
    const hub = installShell(WEB, hubHost as NativeTabHost);

    const unspyFold = spyFold(sequence);
    setDetachedShellCloseDriverForTesting(async (shell) => {
      sequence.push('close');
      return closeReportFor(ownerKey(shell.owner), 'retained', 'unload-veto');
    });
    try {
      const result = await projectWindowAuthority.reattachProject(PROJECT_S);
      assert.deepStrictEqual(result, { status: 'FAILED', projectId: PROJECT_S, reason: 'CLOSE_REFUSED' });
    } finally {
      setDetachedShellCloseDriverForTesting(null);
      unspyFold();
      detached.unregister();
      hub.unregister();
      unseedProject(PROJECT_S);
    }

    assert.deepStrictEqual(sequence, ['close'], 'the fold is unreachable while the close refuses');
    assert.equal(detachedHost.isDisposed, false, 'the refused shell stays alive');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), PROJECT_S), true, 'the record stays marked');
  });

  it('ARM B: a marked record with no live shell folds and lands in the live hub', async () => {
    seedProject(PROJECT_T, WORKSPACE_T, 'Marked Dead');
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: 2,
      owners: {
        web: { tabs: [{ id: 'hub-1', url: 'https://example.test/hub-1' }], activeTabId: 'hub-1', updatedAt: 1 },
        [`project:${PROJECT_T}`]: {
          detached: true,
          tabs: [
            { id: 'pt-1', url: 'https://example.test/pt-1' },
            { id: 'pt-2', url: 'https://example.test/pt-2' },
          ],
          activeTabId: 'pt-1',
          updatedAt: 2,
        },
      },
    }), 'utf8');
    const hubHost = createHost(WEB, [['hub-1']], 'hub-1');
    const minted = stubMinting(hubHost);
    const hub = installShell(WEB, hubHost as NativeTabHost);
    try {
      const result = await projectWindowAuthority.reattachProject(PROJECT_T);
      assert.deepStrictEqual(result, { status: 'REATTACHED', projectId: PROJECT_T });
    } finally {
      hub.unregister();
      unseedProject(PROJECT_T);
    }

    assert.equal(minted.length, 2, 'both persisted rows minted into the live hub');
    const doc = readDoc();
    assert.equal(doc.owners[`project:${PROJECT_T}`], undefined);
    const webIds = (doc.owners.web?.tabs ?? []).map((tab: AnyRecord) => tab.id);
    assert.ok(minted.every((id) => webIds.includes(id)), 'the forced hub persist wrote the landed rows');
    const webStamps = (doc.owners.web?.tabs ?? []).filter((tab: AnyRecord) => minted.includes(tab.id)).map((tab: AnyRecord) => tab.projectId);
    assert.deepStrictEqual(webStamps, [PROJECT_T, PROJECT_T], 'persisted rows carry the project stamp');
  });

  it('ARM B without a live hub still lands the fold in the file', async () => {
    seedProject(PROJECT_U, WORKSPACE_U, 'Hub Closed');
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: 2,
      owners: {
        [`project:${PROJECT_U}`]: {
          detached: true,
          tabs: [{ id: 'pu-1', url: 'https://example.test/pu-1' }],
          updatedAt: 1,
        },
      },
    }), 'utf8');
    try {
      const result = await projectWindowAuthority.reattachProject(PROJECT_U);
      assert.deepStrictEqual(result, { status: 'REATTACHED', projectId: PROJECT_U });
    } finally {
      unseedProject(PROJECT_U);
    }
    const doc = readDoc();
    assert.equal(doc.owners[`project:${PROJECT_U}`], undefined);
    assert.deepStrictEqual(
      (doc.owners.web?.tabs ?? []).map((tab: AnyRecord) => tab.id),
      ['pu-1'],
      'the folded row waits on disk for the next hub construction to restore it',
    );
    assert.equal(doc.owners.web?.tabs[0]?.projectId, PROJECT_U);
  });

  it('a second reattach while one runs answers REATTACH_IN_PROGRESS', async () => {
    seedProject(PROJECT_V, WORKSPACE_V, 'Racy');
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_V }, [['pv-1']], 'pv-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_V }, detachedHost as NativeTabHost);
    const hubHost = createHost(WEB);
    stubMinting(hubHost);
    const hub = installShell(WEB, hubHost as NativeTabHost);

    let release: (report: CloseReport) => void = () => {};
    setDetachedShellCloseDriverForTesting(() => new Promise<CloseReport>((resolve) => {
      release = resolve;
    }));
    try {
      const first = projectWindowAuthority.reattachProject(PROJECT_V);
      await Promise.resolve();
      const second = await projectWindowAuthority.reattachProject(PROJECT_V);
      assert.deepStrictEqual(second, { status: 'FAILED', projectId: PROJECT_V, reason: 'REATTACH_IN_PROGRESS' });
      detached.window.destroyed = true;
      release(closeReportFor(`project:${PROJECT_V}`, 'closed', null));
      const firstResult = await first;
      assert.deepStrictEqual(firstResult, { status: 'REATTACHED', projectId: PROJECT_V });
    } finally {
      setDetachedShellCloseDriverForTesting(null);
      detached.unregister();
      hub.unregister();
      unseedProject(PROJECT_V);
    }
  });

  it('a latched project mid-reattach can never regrow a detached shell', async () => {
    seedProject(PROJECT_W, WORKSPACE_W, 'Latch');
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_W }, [['pw-1']], 'pw-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_W }, detachedHost as NativeTabHost);
    // A live hub keeps the ARM A ensure leg inert; without one the test would
    // exercise project-creation plumbing, not the latch.
    const hub = installShell(WEB);

    let foldStarted!: () => void;
    let foldGateRelease!: () => void;
    const foldSeen = new Promise<void>((resolve) => { foldStarted = resolve; });
    const foldGate = new Promise<void>((resolve) => { foldGateRelease = resolve; });
    // Gate INSIDE the fold window: the shell is already gone (destroyed before
    // the report resolved) and the latch is the only thing standing between this
    // project and `ensureDetachedProjectShell`.
    const originalFold = hostModule.foldDetachedOwnerRecord;
    hostModule.foldDetachedOwnerRecord = (async (filePath: string, ownerKeyValue: string) => {
      foldStarted();
      await foldGate;
      return originalFold(filePath, ownerKeyValue);
    }) as typeof hostModule.foldDetachedOwnerRecord;
    setDetachedShellCloseDriverForTesting(async (shell) => {
      detachedHost.isDisposed = true;
      detached.window.destroyed = true;
      return closeReportFor(ownerKey(shell.owner), 'closed', null);
    });
    try {
      const reattach = projectWindowAuthority.reattachProject(PROJECT_W);
      await foldSeen;
      const reDetach = await projectWindowAuthority.detachProject(PROJECT_W);
      assert.deepStrictEqual(
        reDetach,
        { status: 'FAILED', projectId: PROJECT_W, reason: 'REATTACH_IN_PROGRESS' },
        'shell dead, marker live, fold pending — only the latch refuses recreation',
      );
      foldGateRelease();
      assert.deepStrictEqual(await reattach, { status: 'REATTACHED', projectId: PROJECT_W });
    } finally {
      hostModule.foldDetachedOwnerRecord = originalFold;
      setDetachedShellCloseDriverForTesting(null);
      detached.unregister();
      hub.unregister();
      unseedProject(PROJECT_W);
    }
  });

  it('removeProjectEntry closes the detached shell BEFORE the purge, and never folds', async () => {
    seedProject(PROJECT_R, WORKSPACE_R, 'Remove Detached');
    const restoreTm = installEmptyTerminalManager();
    const sequence: string[] = [];
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_R }, [['rd-1']], 'rd-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_R }, detachedHost as NativeTabHost);

    const unspyPurge = spyPurge(sequence);
    const unspyFold = spyFold(sequence);
    setDetachedShellCloseDriverForTesting(async (shell) => {
      sequence.push('close');
      detachedHost.persistSync();
      detachedHost.isDisposed = true;
      detached.window.destroyed = true;
      return closeReportFor(ownerKey(shell.owner), 'closed', null);
    });
    try {
      const result = await removeProjectEntry({ projectId: PROJECT_R });
      assert.deepStrictEqual(result, { status: 'REMOVED', projectId: PROJECT_R });
    } finally {
      setDetachedShellCloseDriverForTesting(null);
      unspyFold();
      unspyPurge();
      detached.unregister();
      restoreTm();
      unseedProject(PROJECT_R);
    }

    assert.deepStrictEqual(sequence, ['close', 'purge'], 'the purge runs only after the dying host settled its write');
    const doc = readDoc();
    assert.equal(doc.owners[`project:${PROJECT_R}`], undefined, 'removal drops the whole record — no fold ran');
    assert.equal(isKnownProjectId(PROJECT_R), false);
  });

  it('a vetoed detached close refuses the removal before any purge', async () => {
    seedProject(PROJECT_S, WORKSPACE_S, 'Remove Vetoed');
    const restoreTm = installEmptyTerminalManager();
    const sequence: string[] = [];
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_S }, [['rv-1']], 'rv-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_S }, detachedHost as NativeTabHost);

    const unspyPurge = spyPurge(sequence);
    setDetachedShellCloseDriverForTesting(async (shell) => {
      sequence.push('close');
      return closeReportFor(ownerKey(shell.owner), 'retained', 'unload-veto');
    });
    try {
      const result = await removeProjectEntry({ projectId: PROJECT_S });
      assert.strictEqual(result.status, 'CLOSE_REFUSED');
      // The project record itself survives a refused removal — assert before the
      // finally-unseed deliberately closes it.
      assert.equal(isKnownProjectId(PROJECT_S), true, 'the project survives a refused removal');
    } finally {
      setDetachedShellCloseDriverForTesting(null);
      unspyPurge();
      detached.unregister();
      restoreTm();
      unseedProject(PROJECT_S);
    }

    assert.deepStrictEqual(sequence, ['close'], 'a refused close stops the removal before the file is touched');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), PROJECT_S), true, 'the record stays marked');
  });

  it('refused-detach reattach: hub-resident vetoed rows stay, folded rows land, zero duplicates', async () => {
    seedProject(PROJECT_T, WORKSPACE_T, 'Refused Residue');
    // The detach veto residue: the hub still shows one live tab stamped with the
    // project while the detached record persisted the rest.
    const hubHost = createHost(WEB, [['vetoed-1', {}]], 'vetoed-1');
    hubHost.tabs.get('vetoed-1').projectId = PROJECT_T;
    hubHost.persistSync();
    fs.writeFileSync(savedTabsPath(), JSON.stringify({
      version: 2,
      owners: {
        web: {
          tabs: [{ id: 'vetoed-1', url: 'https://example.test/vetoed-1', projectId: PROJECT_T }],
          activeTabId: 'vetoed-1',
          updatedAt: 1,
        },
        [`project:${PROJECT_T}`]: {
          detached: true,
          tabs: [
            { id: 'pt-1', url: 'https://example.test/pt-1' },
            { id: 'pt-2', url: 'https://example.test/pt-2' },
          ],
          updatedAt: 2,
        },
      },
    }), 'utf8');
    const minted = stubMinting(hubHost);
    const hub = installShell(WEB, hubHost as NativeTabHost);
    try {
      const result = await projectWindowAuthority.reattachProject(PROJECT_T);
      assert.equal(result.status, 'REATTACHED');
    } finally {
      hub.unregister();
      unseedProject(PROJECT_T);
    }

    assert.equal(minted.length, 2, 'the folded rows minted new ids beside the live vetoed tab');
    assert.equal(hubHost.tabs.size, 3, 'vetoed-1 plus the two minted rows — nothing doubled');
    const doc = readDoc();
    const webIds = (doc.owners.web?.tabs ?? []).map((tab: AnyRecord) => tab.id);
    assert.equal(new Set(webIds).size, webIds.length, 'owners.web holds no duplicate tab ids');
    assert.equal(webIds.length, 3);
    const stamped = (doc.owners.web?.tabs ?? []).filter((tab: AnyRecord) => tab.projectId === PROJECT_T);
    assert.equal(stamped.length, 3, 'every row — vetoed live and folded — ends stamped and hub-resident');
  });


  it('a confirmed force closes the vetoed shell and the reattach lands', async () => {
    seedProject(PROJECT_X, WORKSPACE_X, 'Force Reattach');
    const sequence: string[] = [];
    const detachedHost = createHost({ kind: 'project', projectId: PROJECT_X }, [['fx-1']], 'fx-1');
    detachedHost.persistSync();
    const detached = installShell({ kind: 'project', projectId: PROJECT_X }, detachedHost as NativeTabHost);
    const hubHost = createHost(WEB, [['hub-1']], 'hub-1');
    stubMinting(hubHost);
    const hub = installShell(WEB, hubHost as NativeTabHost);

    setReattachForceConfirmationForTesting(async () => true);
    setDetachedShellCloseDriverForTesting(async (shell, force) => {
      sequence.push(force === true ? 'force-close' : 'close');
      if (force !== true) return closeReportFor(ownerKey(shell.owner), 'retained', 'unload-veto');
      detachedHost.persistSync();
      detachedHost.isDisposed = true;
      detached.window.destroyed = true;
      return closeReportFor(ownerKey(shell.owner), 'closed', null);
    });
    try {
      const result = await projectWindowAuthority.reattachProject(PROJECT_X);
      assert.deepStrictEqual(result, { status: 'REATTACHED', projectId: PROJECT_X });
    } finally {
      setReattachForceConfirmationForTesting(null);
      setDetachedShellCloseDriverForTesting(null);
      detached.unregister();
      hub.unregister();
      unseedProject(PROJECT_X);
    }

    assert.deepStrictEqual(sequence, ['close', 'force-close'], 'the force retry runs only after the user confirms');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), PROJECT_X), false, 'the marker is cleared');
    assert.equal(readDoc().owners[`project:${PROJECT_X}`], undefined, 'the record folded into the hub');
  });

  it('a refused transfer on a fresh empty shell rolls back through reattach', async () => {
    seedProject(PROJECT_Y, WORKSPACE_Y, 'Refused Fresh Detach');
    // The hub presents PROJECT_Y with one tab whose page refuses to close —
    // detach's transfer is refused before a single row moves.
    const hubHost = createHost(WEB, [['vy-1']], 'vy-1');
    hubHost.tabs.get('vy-1').projectId = PROJECT_Y;
    hubHost.activeProjectId = PROJECT_Y;
    hubHost.closePage = async () => 'vetoed';
    stubMinting(hubHost);
    const hub = installShell(WEB, hubHost as NativeTabHost);

    const createdWindows: Array<{ destroyed: boolean }> = [];
    const detachedRef: { host: AnyRecord | null } = { host: null };
    const manager = new ProjectWindowManager({
      createShell: (owner: WindowOwner) => {
        const win = {
          destroyed: false,
          isDestroyed: () => win.destroyed,
          isMinimized: () => false,
          isVisible: () => !win.destroyed,
          restore: () => {},
          show: () => {},
          showInactive: () => {},
          focus: () => {},
          once: () => {},
          on: () => {},
          removeListener: () => {},
        };
        createdWindows.push(win);
        return { owner, window: win, onCloseRequest: () => {}, onClosed: () => {}, dispose: () => { win.destroyed = true; }, closeSelf: () => {} } as unknown as ProjectWindowShell;
      },
      presentShellInactive: () => {},
    });
    setProjectWindowManagerForTesting(manager);
    setWindowStateManagerForTesting({
      manage: () => {},
      getValidBounds: () => ({}),
    } as unknown as WindowStateManager);
    setDetachedShellHostFactoryForTesting((shell) => {
      detachedRef.host = createHost(shell.owner);
      // The wiring arm only needs the call observed; the real restoreTabs drives
      // createTab against shell chrome a fake shell never built.
      detachedRef.host.restoreTabs = () => {};
      return detachedRef.host as NativeTabHost;
    });
    setDetachedShellCloseDriverForTesting(async (shell) => {
      detachedRef.host?.persistSync();
      if (detachedRef.host) detachedRef.host.isDisposed = true;
      for (const win of createdWindows) win.destroyed = true;
      return closeReportFor(ownerKey(shell.owner), 'closed', null);
    });
    try {
      const result = await projectWindowAuthority.detachProject(PROJECT_Y);
      assert.deepStrictEqual(result, { status: 'FAILED', projectId: PROJECT_Y, reason: 'DETACH_REFUSED' });
    } finally {
      setDetachedShellCloseDriverForTesting(null);
      setDetachedShellHostFactoryForTesting(null);
      setProjectWindowManagerForTesting(null);
      setWindowStateManagerForTesting(null);
      hub.unregister();
      unseedProject(PROJECT_Y);
    }

    assert.equal(detachedRef.host?.isDisposed, true, 'the orphaned shell was closed and disposed');
    assert.equal(savedTabsOwnerIsDetached(savedTabsPath(), PROJECT_Y), false, 'no detached marker survives the rollback');
    assert.equal(readDoc().owners[`project:${PROJECT_Y}`], undefined, 'the parked record folded back into owners.web');
    assert.equal(hubHost.tabs.has('vy-1'), true, 'the vetoed tab stayed hub-resident');
  });
});
