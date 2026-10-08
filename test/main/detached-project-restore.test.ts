/**
 * Boot restore + placement — the phase-03 surface: the marked-owner enumeration
 * seam, the 'restore' OpenIntent (present-unfocused, zero focus steals from the
 * boot leg), the registry/capsule admission predicate, per-record error
 * isolation, the hub restore's detached-row suppression, and the ordering after
 * the hub's own restore+fold.
 *
 * The Electron stub never resolves `app.whenReady()`, so `createWindow` never
 * runs here: the manager, the placement manager, the capsule store and the host
 * constructor are installed through the phase-03 test seams, and every shell is
 * a presentation double whose show/focus calls are recorded.
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { installElectronStub } from '../support/electron-stub';
installElectronStub();

import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { ProjectWindowManager } from '../../src/main/browser/project-window-manager';
import type { ProjectWindowShell, WindowOwner } from '../../src/main/browser/project-window-shell';
import { WorkspaceCapsuleManager } from '../../src/main/project/workspace-capsule';
import type { WindowStateManager } from '../../src/main/browser/window-state';
import type { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  detachedRestoreAdmitsProject,
  installShellForTesting,
  isKnownProjectId,
  projectRegistry as sharedProjectRegistry,
  restoreDetachedProjectShells,
  setBootProjectIdForTesting,
  setCapsuleManagerForTesting,
  setDetachedShellHostFactoryForTesting,
  setProjectWindowManagerForTesting,
  setWindowStateManagerForTesting,
} from '../../src/main/index';
import { DEFAULT_BOOT_PROJECT_ID } from '../../src/shared/control-plane-contracts';

// Reason: the harness needs the mutable module object (spies patch exports in
// place), and an import-type namespace cannot name that object — `typeof import`
// is the type of what require returns.
const hostModule = require('../../src/main/browser/native-tab-host') as typeof import('../../src/main/browser/native-tab-host');
const { NativeTabHost: HostCtor, listDetachedProjectOwnerRecords, SAVED_TABS_SCHEMA_VERSION } = hostModule;
const { createShellDouble } = require('../support/project-window-shell-double') as typeof import('../support/project-window-shell-double');

type AnyRecord = Record<string, any>;

const SUFFIX = '0000-4000-8000';
// Distinct ids per suite — the shared registry is process-scoped.
const PROJECT_A = `project-00000000-${SUFFIX}-0000000000a1`;
const PROJECT_B = `project-00000000-${SUFFIX}-0000000000a2`;
const PROJECT_C = `project-00000000-${SUFFIX}-0000000000a3`;
const PROJECT_D = `project-00000000-${SUFFIX}-0000000000a4`;
const PROJECT_F = `project-00000000-${SUFFIX}-0000000000a6`;
const PROJECT_G = `project-00000000-${SUFFIX}-0000000000a7`;
const PROJECT_H = `project-00000000-${SUFFIX}-0000000000a8`;
const PROJECT_J = `project-00000000-${SUFFIX}-0000000000a9`;
const PROJECT_K = `project-00000000-${SUFFIX}-0000000000aa`;
const PROJECT_L = `project-00000000-${SUFFIX}-0000000000ab`;
const PROJECT_M = `project-00000000-${SUFFIX}-0000000000ac`;
const DEAD_PROJECT = `project-00000000-${SUFFIX}-0000000000dd`;
const WORKSPACE_WS = `workspace-00000000-${SUFFIX}-0000000000a1`;

let tmpDir = '';
let workspacePath = '';

function savedTabsPath(): string {
  return path.join(process.env.ANTIFAN_USER_DATA ?? '', 'saved-tabs.json');
}

function readDoc(): AnyRecord {
  return JSON.parse(fs.readFileSync(savedTabsPath(), 'utf8'));
}

function writeDoc(owners: AnyRecord, extra: AnyRecord = {}): void {
  fs.mkdirSync(path.dirname(savedTabsPath()), { recursive: true });
  fs.writeFileSync(savedTabsPath(), JSON.stringify({ version: SAVED_TABS_SCHEMA_VERSION, owners, ...extra }), 'utf8');
}

function seedProject(projectId: string, name: string): void {
  // `ensureInitialWorkspace` refuses a record whose state is 'closed', and the
  // suite re-seeds ids an earlier test closed — reopen first so seeding is
  // idempotent within the process. Each project claims its own workspace id:
  // the registry refuses one workspace registered to two projects.
  const workspaceId = `workspace-00000000-${SUFFIX}-${projectId.slice(projectId.lastIndexOf('-') + 1)}`;
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

/** A recordable BrowserWindow stand-in: every presentation verb is counted. */
function makeFakeWindow() {
  const calls = { show: 0, showInactive: 0, focus: 0, restore: 0, maximize: 0, center: 0 };
  const listeners = new Map<string, Array<() => void>>();
  const on = (event: string, listener: () => void) => {
    const list = listeners.get(event) ?? [];
    list.push(listener);
    listeners.set(event, list);
  };
  const win: AnyRecord = {
    calls,
    destroyed: false,
    visible: false,
    minimized: false,
    on,
    once: on,
    removeListener: () => {},
    isDestroyed: () => win.destroyed,
    isVisible: () => win.visible,
    isMinimized: () => win.minimized,
    restore: () => { calls.restore++; win.minimized = false; },
    maximize: () => { calls.maximize++; },
    center: () => { calls.center++; },
    show: () => { calls.show++; win.visible = true; },
    showInactive: () => { calls.showInactive++; win.visible = true; },
    focus: () => { calls.focus++; },
    paint: () => {
      for (const listener of listeners.get('ready-to-show') ?? []) listener();
    },
    destroy: () => {
      win.destroyed = true;
      win.visible = false;
      for (const listener of listeners.get('closed') ?? []) listener();
    },
  };
  return win;
}

type FakeWindow = ReturnType<typeof makeFakeWindow>;

/** The shell-plus-recordable-window pair a suite drives. */
interface RestorableShell {
  shell: ProjectWindowShell;
  window: FakeWindow;
}

function makeRestorableShell(owner: WindowOwner): RestorableShell {
  const window = makeFakeWindow();
  const shell = {
    owner,
    window,
    dispose: () => { window.destroy(); },
    closeSelf: () => {},
    onClosed: (listener: () => void) => window.on('closed', listener),
    onCloseRequest: (listener: () => void) => window.on('close-request', listener),
    ownsChromeWebContents: () => false,
  } as unknown as ProjectWindowShell;
  return { shell, window };
}

/**
 * A host stand-in for `ensureDetachedProjectShell`'s wiring arm: the factory
 * seam receives the shell and returns the host, so only the members the wiring
 * actually calls are filled in — `restoreTabs` is captured, not driven (the
 * host's own restore behaviour is asserted through the real `restoreTabs` in
 * the host-level rows below).
 */
function makeWiringHost(shell: ProjectWindowShell): AnyRecord {
  const host: AnyRecord = {
    shell,
    isDisposed: false,
    restoreCalls: 0,
  };
  host.setCloseAdmission = () => {};
  host.setOpenTerminalManagerHandler = () => {};
  host.setDetachedShellProbe = () => {};
  host.setWindowWorkspaceAffiliation = () => true;
  host.setOwnerWindowPresence = () => {};
  host.setProjectAssignmentResolver = () => {};
  host.setTerminalLinkOpener = () => {};
  host.setSpaceWindowOpener = () => {};
  host.setRunStateService = () => {};
  host.setRunBackendResolver = () => {};
  host.restoreTabs = () => { host.restoreCalls++; };
  host.dispose = () => { host.isDisposed = true; };
  return host;
}

interface InstalledLeg {
  manager: ProjectWindowManager;
  createdShells: Map<string, RestorableShell>;
  managedKeys: string[];
  hosts: Map<string, AnyRecord>;
}

/** Stand the boot leg's real dependencies up: manager, placement manager, host factory. */
function installLeg(options: { failFor?: Set<string> } = {}): InstalledLeg {
  const createdShells = new Map<string, RestorableShell>();
  const managedKeys: string[] = [];
  const hosts = new Map<string, AnyRecord>();
  const manager = new ProjectWindowManager({
    createShell: (owner, _intent) => {
      const projectId = owner.kind === 'project' ? owner.projectId : '';
      if (options.failFor?.has(projectId)) throw new Error(`creation exploded for ${projectId}`);
      const made = makeRestorableShell(owner);
      createdShells.set(projectId, made);
      return made.shell;
    },
    presentShellInactive: (shell) => {
      const win = shell.window as unknown as FakeWindow;
      if (win.destroyed) return;
      win.showInactive();
    },
  });
  setProjectWindowManagerForTesting(manager);
  setWindowStateManagerForTesting({
    manage: (_win: unknown, key: string | undefined) => { managedKeys.push(String(key)); },
    getValidBounds: () => ({}),
  } as unknown as WindowStateManager);
  setDetachedShellHostFactoryForTesting((shell) => {
    const projectId = shell.owner.kind === 'project' ? shell.owner.projectId : '';
    const host = makeWiringHost(shell);
    hosts.set(projectId, host);
    return host as NativeTabHost;
  });
  return { manager, createdShells, managedKeys, hosts };
}

function teardownLeg(): void {
  setProjectWindowManagerForTesting(null);
  setWindowStateManagerForTesting(null);
  setDetachedShellHostFactoryForTesting(null);
  setCapsuleManagerForTesting(null);
  setBootProjectIdForTesting(null);
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
  Object.assign(shell, { owner });
  host.shell = shell;
  host.windowWorkspaceAffiliation = null;
  for (const [id, state] of tabs) {
    host.tabs.set(id, {
      state: { id, url: `https://example.test/${id}`, title: id, isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1, ...state },
      view: { webContents: { isDestroyed: () => false, send: () => {}, mainFrame: { url: '' } } },
    });
    host.tabOrder.push(id);
  }
  if (activeTabId) host.activeTabId = activeTabId;
  return host;
}

/** Let a host mint live tabs during restore without a real WebContentsView. */
function stubMinting(host: AnyRecord): string[] {
  const minted: string[] = [];
  host.createTab = (url: string) => {
    const id = `minted-${minted.length + 1}`;
    minted.push(id);
    host.tabs.set(id, {
      state: { id, url, title: id, isLoading: false, canGoBack: false, canGoForward: false, zoomFactor: 1 },
      view: { webContents: { isDestroyed: () => false, send: () => {}, mainFrame: { url: '' } } },
    });
    host.tabOrder.push(id);
    return id;
  };
  host.hasTab = (id: string) => host.tabs.has(id);
  host.switchTab = () => {};
  host.bindTerminalAgentAffinity = () => {};
  host.adoptChildTab = () => {};
  return minted;
}

describe('detached boot restore', () => {
  let releaseTerminalManager: (() => void) | null = null;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-p03-restore-'));
    process.env.ANTIFAN_USER_DATA = path.join(tmpDir, 'user-data');
    fs.mkdirSync(process.env.ANTIFAN_USER_DATA, { recursive: true });
    workspacePath = path.join(tmpDir, 'workspace-alpha');
    fs.mkdirSync(workspacePath, { recursive: true });
    releaseTerminalManager = installEmptyTerminalManager();
  });

  after(() => {
    releaseTerminalManager?.();
    delete process.env.ANTIFAN_USER_DATA;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  beforeEach(() => {
    const file = savedTabsPath();
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  });

  afterEach(() => {
    teardownLeg();
  });

  describe('marked-owner enumeration', () => {
    it('lists only `project:` records carrying detached:true, fail-closed on unreadable files', () => {
      writeDoc({
        web: { tabs: [], updatedAt: 1 },
        'unassigned': { detached: true, tabs: [], updatedAt: 1 },
        'agent:tab-9': { detached: true, tabs: [], updatedAt: 1 },
        'project:': { detached: true, tabs: [], updatedAt: 1 },
        [`project:${PROJECT_A}`]: { detached: true, tabs: [{ id: 'a1', url: 'https://example.test/a1' }], updatedAt: 1 },
        [`project:${PROJECT_B}`]: { detached: false, tabs: [], updatedAt: 1 },
        [`project:${PROJECT_C}`]: { tabs: [{ id: 'c1', url: 'https://example.test/c1' }], updatedAt: 1 },
      });

      const keys = listDetachedProjectOwnerRecords(savedTabsPath());
      assert.deepEqual(keys, [`project:${PROJECT_A}`], 'only the marked project record enumerates');

      const before = fs.readFileSync(savedTabsPath(), 'utf8');
      listDetachedProjectOwnerRecords(savedTabsPath());
      assert.equal(fs.readFileSync(savedTabsPath(), 'utf8'), before, 'enumeration is read-only — no fold, no rewrite');

      fs.writeFileSync(savedTabsPath(), '{ not json', 'utf8');
      assert.deepEqual(listDetachedProjectOwnerRecords(savedTabsPath()), [], 'a corrupt file enumerates nothing');
      fs.rmSync(savedTabsPath(), { force: true });
      assert.deepEqual(listDetachedProjectOwnerRecords(savedTabsPath()), [], 'an absent file enumerates nothing');
    });
  });

  describe('admission predicate', () => {
    it('admits an open registry project', () => {
      seedProject(PROJECT_A, 'Alpha');
      assert.equal(detachedRestoreAdmitsProject(PROJECT_A), true);
    });

    it('refuses a project the registry never held and no capsule claims', () => {
      assert.equal(detachedRestoreAdmitsProject(DEAD_PROJECT), false);
      assert.equal(isKnownProjectId(DEAD_PROJECT), false, 'sanity: the id is unknown to every authority');
    });

    it('refuses a project whose registry record is closed — a stored record is not an open one', () => {
      seedProject(PROJECT_B, 'Bravo');
      unseedProject(PROJECT_B);
      assert.equal(sharedProjectRegistry.getProject(PROJECT_B).state, 'closed', 'the record persists post-close');
      assert.equal(detachedRestoreAdmitsProject(PROJECT_B), false);
    });

    it('refuses a dead id even while it fills the boot-project slot — isKnownProjectId cannot authorize a window', () => {
      setBootProjectIdForTesting(DEAD_PROJECT);
      assert.equal(isKnownProjectId(DEAD_PROJECT), true, 'the boot-id arm answers true unconditionally');
      assert.equal(detachedRestoreAdmitsProject(DEAD_PROJECT), false, 'the restore predicate never reads the boot slot');
    });

    it('refuses the boot sentinel even while the registry holds it open — the hub is not a tenant', () => {
      seedProject(DEFAULT_BOOT_PROJECT_ID, 'Tổng hợp');
      assert.equal(sharedProjectRegistry.getProject(DEFAULT_BOOT_PROJECT_ID).state, 'open', 'sanity: the registry arm alone would admit it');
      assert.equal(detachedRestoreAdmitsProject(DEFAULT_BOOT_PROJECT_ID), false);
      setBootProjectIdForTesting(PROJECT_A);
      seedProject(PROJECT_A, 'Alpha');
      assert.equal(detachedRestoreAdmitsProject(PROJECT_A), true, 'the boot slot alone never changes admission for a real project');
    });

    it('admits a project exactly one validated capsule claims, registry-absent', () => {
      // `setAffiliation` needs the registry to already know the project — useless
      // for the registry-absent row — so the claim is written the way the store
      // actually persists it: a capsule file the manager loads and trusts.
      const filePath = path.join(tmpDir, 'capsules.json');
      fs.writeFileSync(filePath, JSON.stringify({
        activeCapsuleId: null,
        capsules: [{
          id: 'capsule-00000000-0000-4000-8000-0000000000c1',
          name: 'Claimed',
          workspacePath,
          projectId: PROJECT_C,
          workspaceId: WORKSPACE_WS,
          migrationMarker: 'explicit',
          updatedAt: 1,
        }],
        updatedAt: 1,
      }), 'utf8');
      setCapsuleManagerForTesting(new WorkspaceCapsuleManager({ filePath }));
      assert.throws(() => sharedProjectRegistry.getProject(PROJECT_C), 'registry knows nothing yet');
      assert.equal(detachedRestoreAdmitsProject(PROJECT_C), true, 'a single validated claim is sufficient evidence');
    });

    it('refuses a project two capsules claim — ambiguity is not evidence', () => {
      const filePath = path.join(tmpDir, 'capsules-two.json');
      const claim = (id: string) => ({
        id,
        name: id,
        workspacePath,
        projectId: PROJECT_D,
        workspaceId: WORKSPACE_WS,
        migrationMarker: 'explicit',
        updatedAt: 1,
      });
      fs.writeFileSync(filePath, JSON.stringify({
        activeCapsuleId: null,
        capsules: [claim('capsule-00000000-0000-4000-8000-0000000000d1'), claim('capsule-00000000-0000-4000-8000-0000000000d2')],
        updatedAt: 1,
      }), 'utf8');
      setCapsuleManagerForTesting(new WorkspaceCapsuleManager({ filePath }));
      assert.equal(detachedRestoreAdmitsProject(PROJECT_D), false);
    });
  });

  describe('restore intent presentation', () => {
    it('an existing shell joined with restore intent is presented unfocused, never focused', async () => {
      const { shell } = makeRestorableShell({ kind: 'project', projectId: PROJECT_A });
      const presented: string[] = [];
      const inactive: string[] = [];
      const manager = new ProjectWindowManager({
        createShell: () => shell,
        presentShell: () => presented.push('focused'),
        presentShellInactive: () => inactive.push('inactive'),
      });
      await manager.ensureWindow({ kind: 'project', projectId: PROJECT_A }, 'agent');
      assert.equal(inactive.length, 0, 'agent intent creates unseen');

      await manager.ensureWindow({ kind: 'project', projectId: PROJECT_A }, 'restore');
      assert.deepEqual(presented, [], 'restore never goes through the focused presenter');
      assert.equal(inactive.length, 1, 'the joined shell is surfaced through the inactive presenter');
    });

    it('a restore intent joining an in-flight creation surfaces the shell unfocused once it lands', async () => {
      const { shell, window } = makeRestorableShell({ kind: 'web' });
      const presentedInactive: string[] = [];
      const presented: string[] = [];
      const manager = new ProjectWindowManager({
        createShell: () => shell,
        presentShell: () => presented.push('focused'),
        presentShellInactive: () => presentedInactive.push('inactive'),
      });
      const first = manager.ensureWindow({ kind: 'web' }, 'agent');
      const second = manager.ensureWindow({ kind: 'web' }, 'restore');
      await Promise.all([first, second]);
      assert.equal(presentedInactive.length, 1, 'the restore join presents after creation settles');
      assert.equal(presented.length, 0);
      assert.equal(window.calls.focus, 0, 'no focus steal on the join path');
    });
  });

  describe('boot leg', () => {
    it('restores valid marked shells sequentially and unfocused, after the hub fold, and skips dead records', async () => {
      seedProject(PROJECT_F, 'Foxtrot');
      const leg = installLeg();

      // The pre-boot file: a folded legacy record, one marked record for a live
      // project, one for a project nothing claims, and a web row stamped with
      // the detached project (the refuse-detach leftover).
      writeDoc({
        web: {
          tabs: [
            { id: 'w1', url: 'https://example.test/w1' },
            { id: 'refused-1', url: 'https://example.test/r1', projectId: PROJECT_F },
          ],
          activeTabId: 'w1',
          updatedAt: 1,
        },
        'project:legacy-ghost': { tabs: [{ id: 'old-1', url: 'https://example.test/old' }], updatedAt: 1 },
        [`project:${PROJECT_F}`]: { detached: true, tabs: [{ id: 'f1', url: 'https://example.test/f1' }], updatedAt: 1 },
        [`project:${PROJECT_G}`]: { detached: true, tabs: [{ id: 'g1', url: 'https://example.test/g1' }], updatedAt: 1 },
      });

      // Hub restore runs first (the real boot order): its own load folds legacy
      // records and suppresses detached-owned stamped rows.
      const hub = createHost({ kind: 'web' });
      const minted = stubMinting(hub);
      hub.restoreTabs();
      const doc = readDoc();
      assert.equal(doc.owners['project:legacy-ghost'], undefined, 'the unmarked legacy record folded into web');
      assert.equal(doc.owners[`project:${PROJECT_F}`].detached, true, 'the marked record survived the fold');
      const mintedUrls = minted.map((id) => hub.tabs.get(id)?.state?.url);
      assert.equal(mintedUrls.includes('https://example.test/r1'), false, 'the detached-stamped web row was suppressed, not presented');
      assert.equal(mintedUrls.includes('https://example.test/w1'), true);
      assert.equal(mintedUrls.includes('https://example.test/old'), true, 'the folded legacy row belongs to the hub — suppression is scoped to marked owners');

      const outcomes = await restoreDetachedProjectShells();
      const byProject = new Map(outcomes.map((o) => [o.projectId, o]));
      assert.equal(byProject.get(PROJECT_F)?.status, 'restored');
      assert.equal(byProject.get(PROJECT_F)?.created, true);
      assert.equal(byProject.get(PROJECT_G)?.status, 'refused', 'dead project: nothing to admit it');
      assert.equal(outcomes.some((o) => o.projectId === 'legacy-ghost'), false, 'the folded record never enumerates');

      const restored = leg.createdShells.get(PROJECT_F);
      assert.ok(restored, 'the detached shell was created');
      restored.window.paint();
      assert.equal(restored.window.calls.showInactive >= 1, true, 'presented unfocused');
      assert.equal(restored.window.calls.focus, 0, 'zero focus steals from the boot leg');
      assert.equal(restored.window.calls.show, 0, 'restore never uses the focused show path');
      assert.equal(leg.managedKeys.includes(`project:${PROJECT_F}`), true, 'placement manages per owner key');
      assert.equal(leg.hosts.get(PROJECT_F)?.restoreCalls, 1, 'the host restored the project owner record');
      assert.equal(typeof byProject.get(PROJECT_F)?.durationMs, 'number', 'per-shell latency is instrumented');

      // The refused record stays on disk for purge, marker intact.
      const afterDoc = readDoc();
      assert.equal(afterDoc.owners[`project:${PROJECT_G}`]?.detached, true, 'refused records are left for purge');
    });

    it('a marked record whose registry record is closed never resurrects', async () => {
      seedProject(PROJECT_H, 'Hotel');
      unseedProject(PROJECT_H);
      installLeg();
      writeDoc({
        web: { tabs: [], updatedAt: 1 },
        [`project:${PROJECT_H}`]: { detached: true, tabs: [{ id: 'h1', url: 'https://example.test/h1' }], updatedAt: 1 },
      });
      const outcomes = await restoreDetachedProjectShells();
      assert.deepEqual(outcomes.map((o) => o.status), ['refused']);
      assert.equal(readDoc().owners[`project:${PROJECT_H}`]?.detached, true, 'the closed-project record is untouched');
    });

    it("one record's creation failure is journaled and never starves the records behind it", async () => {
      seedProject(PROJECT_J, 'Juliett');
      seedProject(PROJECT_K, 'Kilo');
      const leg = installLeg({ failFor: new Set([PROJECT_J]) });
      writeDoc({
        web: { tabs: [], updatedAt: 1 },
        [`project:${PROJECT_J}`]: { detached: true, tabs: [], updatedAt: 1 },
        [`project:${PROJECT_K}`]: { detached: true, tabs: [], updatedAt: 1 },
      });
      const outcomes = await restoreDetachedProjectShells();
      assert.equal(outcomes.length, 2);
      assert.equal(outcomes[0]!.projectId, PROJECT_J);
      assert.equal(outcomes[0]!.status, 'failed');
      assert.match(String(outcomes[0]!.detail), /creation exploded/);
      assert.equal(outcomes[1]!.projectId, PROJECT_K);
      assert.equal(outcomes[1]!.status, 'restored', 'the failing record did not starve the next one');
      assert.equal(leg.createdShells.has(PROJECT_K), true);
    });

    it('a live detached shell is joined and surfaced unfocused, not recreated', async () => {
      seedProject(PROJECT_L, 'Lima');
      const { shell, window } = makeRestorableShell({ kind: 'project', projectId: PROJECT_L });
      const unregister = installShellForTesting(shell, makeWiringHost(shell) as NativeTabHost);
      const leg = installLeg();
      writeDoc({
        web: { tabs: [], updatedAt: 1 },
        [`project:${PROJECT_L}`]: { detached: true, tabs: [], updatedAt: 1 },
      });
      try {
        const outcomes = await restoreDetachedProjectShells();
        assert.equal(outcomes[0]!.status, 'restored');
        assert.equal(outcomes[0]!.created, false, 'the live shell was joined');
        assert.equal(window.calls.showInactive, 1, 'joined restore surfaces without focus');
        assert.equal(window.calls.focus, 0);
        assert.equal(leg.createdShells.size, 0, 'no second window was minted');
      } finally {
        unregister();
      }
    });

    it('a record whose marker clears mid-loop (a fold raced the snapshot) is skipped, never restored', async () => {
      seedProject(PROJECT_M, 'Mike');
      installLeg();
      writeDoc({
        web: { tabs: [], updatedAt: 1 },
        [`project:${PROJECT_M}`]: { detached: true, tabs: [], updatedAt: 1 },
      });
      // The enumerate→ensure gap: a concurrent reattach folded the record between
      // the snapshot and this record's turn. The re-check at ensure time must
      // refuse — the snapshot alone can never authorize a window.
      const originalCheck = hostModule.savedTabsOwnerIsDetached;
      hostModule.savedTabsOwnerIsDetached = ((filePath: string, projectId: string) => {
        if (projectId === PROJECT_M) return false;
        return originalCheck(filePath, projectId);
      }) as typeof hostModule.savedTabsOwnerIsDetached;
      try {
        const outcomes = await restoreDetachedProjectShells();
        assert.deepEqual(outcomes.map((o) => [o.projectId, o.status, o.reason]), [
          [PROJECT_M, 'skipped', 'marker-cleared'],
        ]);
      } finally {
        hostModule.savedTabsOwnerIsDetached = originalCheck;
      }
      assert.equal(readDoc().owners[`project:${PROJECT_M}`]?.detached, true, 'the skip wrote nothing');
    });

    it('a persisted boot-sentinel record folds into web and mints no window', async () => {
      seedProject(DEFAULT_BOOT_PROJECT_ID, 'Tổng hợp');
      const leg = installLeg();
      writeDoc({
        web: { tabs: [{ id: 'w1', url: 'https://example.test/w1' }], updatedAt: 1 },
        [`project:${DEFAULT_BOOT_PROJECT_ID}`]: {
          detached: true,
          tabs: [{ id: 'boot-1', url: 'https://example.test/boot-1' }],
          updatedAt: 1,
        },
      });
      const outcomes = await restoreDetachedProjectShells();
      assert.deepEqual(outcomes, [], 'the folded record never enumerates, so it is neither restored nor refused');
      assert.equal(leg.createdShells.size, 0, 'no zombie "Tổng hợp" window');
      const doc = readDoc();
      assert.equal(doc.owners[`project:${DEFAULT_BOOT_PROJECT_ID}`], undefined, 'the record left the document');
      assert.deepEqual(
        doc.owners.web.tabs.map((tab: AnyRecord) => tab.id).sort(),
        ['boot-1', 'w1'],
        'the user\'s tabs from the zombie window land in the hub',
      );
    });
  });

  describe('hub restore suppression', () => {
    it('a `projectId`-stamped web row is suppressed only while its detached record exists', () => {
      writeDoc({
        web: {
          tabs: [
            { id: 'w1', url: 'https://example.test/w1' },
            { id: 'leftover-1', url: 'https://example.test/l1', projectId: 'proj-x' },
          ],
          activeTabId: 'w1',
          updatedAt: 1,
        },
        'project:proj-x': { detached: true, tabs: [{ id: 'x1', url: 'https://example.test/x1' }], updatedAt: 1 },
      });
      const hub = createHost({ kind: 'web' });
      const minted = stubMinting(hub);
      hub.restoreTabs();
      assert.equal(hub.tabs.size, 1, 'the stamped row did not present while proj-x is detached');
      assert.equal(hub.tabs.get(minted[0])?.state?.url, 'https://example.test/w1');

      // After a reattach's fold the record is gone: the same row must restore
      // normally — suppression is a read filter, not a deletion.
      writeDoc({
        web: {
          tabs: [
            { id: 'w1', url: 'https://example.test/w1' },
            { id: 'leftover-1', url: 'https://example.test/l1', projectId: 'proj-x' },
          ],
          activeTabId: 'leftover-1',
          updatedAt: 2,
        },
      });
      const hubAfter = createHost({ kind: 'web' });
      stubMinting(hubAfter);
      hubAfter.restoreTabs();
      assert.equal(hubAfter.tabs.size, 2, 'with no detached record the same rows restore verbatim');
    });

    it('the persisted hub scope never activates a detached project (no foreign-activation throw, no focused recreate)', () => {
      writeDoc({
        web: { tabs: [{ id: 'w1', url: 'https://example.test/w1' }], activeTabId: 'w1', activeProjectId: 'proj-det', updatedAt: 1 },
        'project:proj-det': { detached: true, tabs: [{ id: 'd1', url: 'https://example.test/d1' }], updatedAt: 1 },
      });
      const hub = createHost({ kind: 'web' });
      stubMinting(hub);
      const calls: string[] = [];
      hub.describeWebHubProject = (id: string) => ({ title: id });
      hub.foreignProjectActivatedHandler = (id: string) => { calls.push(id); };
      hub.restoreTabs();
      assert.deepEqual(calls, [], 'the detached project was never routed to the activation funnel');
      assert.equal(hub.activeProjectId, null, 'no detached scope lands on the hub');
    });
  });

  describe('detached-owner record restore', () => {
    it("a `project:` host restores tabs from its own record — the boot leg's tabs land under `project:<id>`", () => {
      writeDoc({
        web: { tabs: [{ id: 'w1', url: 'https://example.test/w1' }], updatedAt: 1 },
        'project:proj-own': {
          detached: true,
          tabs: [
            { id: 'p1', url: 'https://example.test/p1', projectId: 'proj-own' },
            { id: 'p2', url: 'https://example.test/p2' },
          ],
          activeTabId: 'p2',
          updatedAt: 1,
        },
      });
      const detached = createHost({ kind: 'project', projectId: 'proj-own' });
      const minted = stubMinting(detached);
      detached.restoreTabs();
      assert.equal(minted.length, 2, 'both rows of the project record restored');
      assert.equal(detached.tabs.get(minted[0]).projectId, 'proj-own', 'the persisted stamp survives the mint');
      const doc = readDoc();
      assert.equal(doc.owners.web.tabs.length, 1);
      assert.equal(doc.owners['project:proj-own'].detached, true, 'restore never consumes the marker');
    });
  });
});
