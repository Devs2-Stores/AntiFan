/**
 * Window assignment and routed creation must not move a tab onto another session.
 *
 * A project window owns its tabs through its own NativeTabHost, and the session a tab
 * runs in is decided by its partition: a workspace capsule jar for an isolated tab, the
 * shared profile jar for the rest. Two routing decisions from the project-window
 * cutover sit in front of that choice - resolving a tab to the window that presents it
 * (the `TabAuthorityDirectory`, which answers from the host that holds the tab) and
 * creating a child in the anchor's window
 * (`anchorTabId`, consumed by the index adapter). Neither may change which session an
 * existing tab uses, and a new tab must not land in another window's jar: a tab that
 * changed jar would read another workspace's cookies, and re-selecting a profile during
 * a window open would migrate the cookie store every tab in the process shares.
 *
 * The Electron `session` boundary is stubbed - the same seam
 * `capsule-partition-cookie-isolation.test.ts` uses - so the partitions registered here
 * are real: `configureBrowserSessionPartition` records partition-to-session identity,
 * and the assertions read it back through `getTabSession` and
 * `getBrowserSessionPartition`, the accessors production exposes, instead of comparing
 * strings a test wrote down for itself.
 */
import { describe, it, before } from 'node:test';
import * as assert from 'node:assert/strict';
import type * as PartitionModule from '../../src/main/browser/browser-session-partition';
import type * as HostModule from '../../src/main/browser/native-tab-host';
import type * as PortModule from '../../src/main/tools/browser-control-port';
import { ownerKey, type ProjectWindowShell, type WindowOwner } from '../../src/main/browser/project-window-shell';
import { ProjectWindowManager } from '../../src/main/browser/project-window-manager';
import { TabAuthorityDirectory } from '../../src/main/browser/tab-authority-directory';
import type { BrowserTarget } from '../../src/shared/control-plane-contracts';

type PartitionApi = typeof PartitionModule;

const PROJECT_A: WindowOwner = { kind: 'project', projectId: 'project-aaaaaaaa-0000-4000-8000-000000000001' };
const PROJECT_B: WindowOwner = { kind: 'project', projectId: 'project-bbbbbbbb-0000-4000-8000-000000000002' };
const WORKSPACE_A = 'workspace-aaaaaaaa-0000-4000-8000-00000000000a';
const WORKSPACE_B = 'workspace-bbbbbbbb-0000-4000-8000-00000000000b';
const CAPSULE_A = 'cap-aaaaaaaa-0000-4000-8000-00000000000a';
const CAPSULE_B = 'cap-bbbbbbbb-0000-4000-8000-00000000000b';
const PROFILE_MODE: 'clean' = 'clean';
const ELECTRON_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AntiFan/1.0.0 Electron/43.4.0 Chrome/140.0.0.0 Safari/537.36';

interface FakeSession {
  readonly partition: string;
  getUserAgent(): string;
  setUserAgent(ua: string): void;
  cookies: { on(event: string, listener: () => void): void; flushStore(): Promise<void> };
  webRequest: { onBeforeSendHeaders(filter: unknown, handler: unknown): void };
}

const sessionsByPartition = new Map<string, FakeSession>();

function makeFakeSession(partition: string): FakeSession {
  return {
    partition,
    getUserAgent: () => ELECTRON_UA,
    setUserAgent: () => {},
    cookies: { on: () => {}, flushStore: async () => {} },
    webRequest: { onBeforeSendHeaders: () => {} },
  };
}

function installElectronSessionStub(): void {
  const resolved = require.resolve('electron');
  if (!require.cache[resolved]) require(resolved);
  const entry = require.cache[resolved];
  if (!entry) throw new Error('electron module could not be resolved for the session stub');
  entry.exports = {
    session: {
      fromPartition: (partition: string) => {
        let sess = sessionsByPartition.get(partition);
        if (!sess) {
          sess = makeFakeSession(partition);
          sessionsByPartition.set(partition, sess);
        }
        return sess;
      },
      defaultSession: makeFakeSession('default'),
    },
  } as unknown as typeof entry.exports;
}

let partitions: PartitionApi;
let HostCtor: typeof HostModule.NativeTabHost;
let PortCtor: typeof PortModule.BrowserControlPort;

before(() => {
  installElectronSessionStub();
  // Required after the stub: these modules read the Electron session export, and the
  // partition registry only answers for sessions created through it.
  partitions = require('../../src/main/browser/browser-session-partition') as PartitionApi;
  HostCtor = (require('../../src/main/browser/native-tab-host') as typeof HostModule).NativeTabHost;
  PortCtor = (require('../../src/main/tools/browser-control-port') as typeof PortModule).BrowserControlPort;
});

type TabRecord = {
  id: string;
  view: { webContents: { isDestroyed(): boolean; session: unknown } };
  state: Record<string, unknown>;
};

/**
 * The real host surface this file reads, entered through `NativeTabHost.prototype` (the
 * seam test/unit/browser/session-tab-slot-release.test.ts uses). Only the allocation the
 * Electron WebContentsView would own is replaced; identity, partitions, pools and the
 * adopt path are the production methods.
 */
type FixtureHost = {
  tabs: Map<string, TabRecord>;
  tabOrder: string[];
  sessionTabPools: Map<string, Set<string>>;
  terminalAgentAffinity: Map<string, unknown>;
  broadcastState(): void;
  hasTab(tabId?: string | null): boolean;
  getTabList(): unknown[];
  getTabSession(tabId: string): unknown;
  getLivePartitionNames(): string[];
  getSharedProfilePartition(mode?: 'clean' | 'native', ephemeral?: boolean, profileId?: string): string;
  getManagedTabIdsForBoundTab(boundTabId: string): Set<string>;
  adoptChildTabForBoundTab(boundTabId: string, childTabId: string, source?: 'agent_spawned'): boolean;
};

type Affiliation = { projectId: string; workspaceId: string; capsuleId: string };

type WindowFixture = {
  owner: WindowOwner;
  shell: ProjectWindowShell;
  host: FixtureHost;
  affiliations: Map<string, Affiliation>;
};

function makeWindow(owner: WindowOwner): WindowFixture {
  const host = Object.create(HostCtor.prototype) as FixtureHost;
  host.tabs = new Map<string, TabRecord>();
  host.tabOrder = [];
  host.sessionTabPools = new Map<string, Set<string>>();
  host.terminalAgentAffinity = new Map<string, unknown>();
  // The adopt path broadcasts a state update; no renderer exists in this process.
  host.broadcastState = () => {};
  return {
    owner,
    shell: { owner, window: { isDestroyed: () => false }, dispose: () => {} } as unknown as ProjectWindowShell,
    host,
    affiliations: new Map<string, Affiliation>(),
  };
}

/** Seat a tab the way `NativeTabHost.createTab` seats one on a given partition. */
function seatTab(window: WindowFixture, id: string, partition: string, capsuleId: string, affiliation: Affiliation): void {
  const session = partitions.configureBrowserSessionPartition(partition, PROFILE_MODE);
  window.host.tabs.set(id, {
    id,
    view: { webContents: { isDestroyed: () => false, session } },
    state: { id, url: `https://${id}.example/`, title: id, capsuleId, userAgentMode: PROFILE_MODE, partition },
  });
  window.host.tabOrder.push(id);
  window.affiliations.set(id, affiliation);
}

/** The session a tab actually runs in, read through the production accessor. */
function sessionOf(window: WindowFixture, tabId: string): FakeSession {
  const session = window.host.getTabSession(tabId);
  assert.ok(session, `tab ${tabId} has no session`);
  return session as FakeSession;
}

/** The partition a tab's session belongs to, read through the production registry. */
function jarOf(window: WindowFixture, tabId: string): string {
  return partitions.getBrowserSessionPartition(sessionOf(window, tabId) as never);
}

/**
 * The process the port sees: an id resolves to the window directory, and each window
 * answers through its own host - the composition index.ts builds for the port
 * (`hasTab`/`getManagedTabIds`/`adoptChildTab`/`resolveTabAffiliation`/`createTab`).
 * Allocation is the one step that cannot run here, because `createTab` constructs a
 * WebContentsView; the child is registered on the partition the real partition
 * functions select for the options the port sends.
 */
function makeAuthorityPort(args: {
  directory: TabAuthorityDirectory;
  /** The host the adapter falls back to when an id belongs to no live window. */
  bootstrap: WindowFixture;
  windows: WindowFixture[];
  activeCapsuleId: () => string;
}): { port: PortModule.BrowserControlPort; allocations: string[] } {
  const allocations: string[] = [];
  const windowOfTab = (tabId?: string | null): WindowFixture | undefined => {
    if (!tabId) return undefined;
    const host = args.directory.hostForTab(tabId) as FixtureHost | undefined;
    return args.windows.find((candidate) => candidate.host === host);
  };
  const ownerOf = (tabId?: string | null): WindowFixture => windowOfTab(tabId) ?? args.bootstrap;
  const host = {
    hasTab: (tabId?: string | null) => Boolean(tabId && args.directory.hostForTab(tabId) !== undefined),
    getTabList: () => args.windows.flatMap((window) => window.host.getTabList()),
    getManagedTabIds: (boundTabId: string) => ownerOf(boundTabId).host.getManagedTabIdsForBoundTab(boundTabId),
    resolveTabAffiliation: (tabId: string) => windowOfTab(tabId)?.affiliations.get(tabId),
    adoptChildTab: (boundTabId: string, childTabId: string) => ownerOf(boundTabId).host.adoptChildTabForBoundTab(boundTabId, childTabId),
    createTab: (url?: string, activate?: boolean, options?: { capsuleId?: string; userAgentMode?: 'clean' | 'native'; ephemeral?: boolean; offscreen?: boolean; anchorTabId?: string }) => {
      // `anchorTabId` is consumed by the adapter to select the window (index.ts:725-729);
      // the host below never sees it. No window means the bootstrap host, as production.
      const owner = ownerOf(options?.anchorTabId);
      const mode = options?.userAgentMode ?? PROFILE_MODE;
      const capsuleId = options?.capsuleId ?? args.activeCapsuleId();
      const partition = owner.host.getSharedProfilePartition(mode, Boolean(options?.ephemeral));
      const session = partitions.configureBrowserSessionPartition(partition, mode);
      const id = `tab-created-${allocations.length + 1}`;
      allocations.push(id);
      owner.host.tabs.set(id, {
        id,
        view: { webContents: { isDestroyed: () => false, session } },
        state: {
          id,
          url: url || 'about:blank',
          title: 'New Tab',
          capsuleId,
          userAgentMode: mode,
          partition,
          ephemeral: Boolean(options?.ephemeral),
          offscreen: Boolean(options?.offscreen),
        },
      });
      owner.host.tabOrder.push(id);
      return id;
    },
  } as unknown as PortModule.BrowserHostPort;
  return { port: new PortCtor(host), allocations };
}

function makeDirectory(managerShells: Map<string, WindowFixture>): {
  directory: TabAuthorityDirectory;
  manager: ProjectWindowManager;
} {
  const directory = new TabAuthorityDirectory();
  const manager = new ProjectWindowManager({
    createShell: (owner) => {
      const fixture = makeWindow(owner);
      managerShells.set(ownerKey(owner), fixture);
      // index.ts registers a new shell's host in the same directory the resolver reads.
      directory.register(fixture.shell, fixture.host as unknown as HostModule.NativeTabHost);
      return fixture.shell;
    },
  });
  return { directory, manager };
}

/**
 * The window the authority resolves a tab to: the directory's answer for the host that
 * holds the tab, mapped back to the window fixture that presents it — the same lookup
 * index.ts performs when it needs the owner of a page.
 */
function windowOfTab(
  windowsByOwner: Map<string, WindowFixture>,
  directory: TabAuthorityDirectory,
  tabId: string
): WindowFixture | undefined {
  const host = directory.hostForTab(tabId);
  return host ? [...windowsByOwner.values()].find((fixture) => (fixture.host as unknown) === host) : undefined;
}

describe('Partition and session selection across project windows', () => {
  it('binds a tab to a second project window without touching the first window\'s session, and refuses to re-parent it while that window lives', async () => {
    const windowsByOwner = new Map<string, WindowFixture>();
    const { directory, manager } = makeDirectory(windowsByOwner);

    const shellA = await manager.ensureWindow(PROJECT_A, 'user');
    const windowA = windowsByOwner.get(ownerKey(PROJECT_A));
    assert.ok(windowA);
    assert.equal(shellA, windowA.shell);
    const capsuleAJar = partitions.deriveCapsulePartition(CAPSULE_A, PROFILE_MODE);
    seatTab(windowA, 'tab-a', capsuleAJar, CAPSULE_A, { projectId: PROJECT_A.projectId, workspaceId: WORKSPACE_A, capsuleId: CAPSULE_A });

    const sessionBefore = sessionOf(windowA, 'tab-a');
    const jarBefore = jarOf(windowA, 'tab-a');
    const partitionsBefore = windowA.host.getLivePartitionNames();
    const stateBefore = structuredClone(windowA.host.tabs.get('tab-a')?.state);
    // A tab is bound to the window whose host holds it — the directory resolves the tab,
    // and the host holding it is the answer — so that binding is what must not move.
    const hostBefore = directory.hostForTab('tab-a');
    assert.equal(hostBefore, windowA.host);

    const shellB = await manager.ensureWindow(PROJECT_B, 'agent');
    const windowB = windowsByOwner.get(ownerKey(PROJECT_B));
    assert.ok(windowB);
    assert.notEqual(shellB, shellA);
    assert.notEqual(windowB.host, windowA.host);

    // The first window is live and keeps its tab: admitting the second window leaves the
    // binding with the host that holds the tab, instead of silently re-parenting it into
    // the window that just appeared.
    assert.equal(directory.hostForTab('tab-a'), hostBefore);
    assert.equal(windowB.host.hasTab('tab-a'), false);
    assert.deepStrictEqual(windowOfTab(windowsByOwner, directory, 'tab-a')?.owner, PROJECT_A);
    assert.equal(windowOfTab(windowsByOwner, directory, 'tab-a')?.shell, shellA);

    // Nothing about the tab moved: same session object, same jar, same live partitions.
    assert.equal(sessionOf(windowA, 'tab-a'), sessionBefore);
    assert.equal(jarOf(windowA, 'tab-a'), jarBefore);
    assert.equal(jarBefore, capsuleAJar);
    assert.deepStrictEqual(windowA.host.getLivePartitionNames(), partitionsBefore);
    assert.deepStrictEqual(windowA.host.tabs.get('tab-a')?.state, stateBefore);
    // The new window brought a host, not a partition: it owns no tab yet.
    assert.deepStrictEqual(windowB.host.getLivePartitionNames(), []);
  });

  it('creates a routed tab in the anchor\'s window on that window\'s partition and leaves the other window\'s jar and session untouched', async () => {
    const windowsByOwner = new Map<string, WindowFixture>();
    const { directory, manager } = makeDirectory(windowsByOwner);
    await manager.ensureWindow(PROJECT_A, 'user');
    await manager.ensureWindow(PROJECT_B, 'user');
    const windowA = windowsByOwner.get(ownerKey(PROJECT_A));
    const windowB = windowsByOwner.get(ownerKey(PROJECT_B));
    assert.ok(windowA);
    assert.ok(windowB);

    const capsuleAJar = partitions.deriveCapsulePartition(CAPSULE_A, PROFILE_MODE);
    const capsuleBJar = partitions.deriveCapsulePartition(CAPSULE_B, PROFILE_MODE);
    seatTab(windowA, 'tab-a', capsuleAJar, CAPSULE_A, { projectId: PROJECT_A.projectId, workspaceId: WORKSPACE_A, capsuleId: CAPSULE_A });
    seatTab(windowB, 'tab-b', capsuleBJar, CAPSULE_B, { projectId: PROJECT_B.projectId, workspaceId: WORKSPACE_B, capsuleId: CAPSULE_B });

    const sessionOfTabA = sessionOf(windowA, 'tab-a');
    const stateOfTabA = structuredClone(windowA.host.tabs.get('tab-a')?.state);
    const partitionsOfWindowA = windowA.host.getLivePartitionNames();
    const anchorSession = sessionOf(windowB, 'tab-b');
    // The shared profile jar this window's creations select, captured before the route runs.
    const profileJar = windowB.host.getSharedProfilePartition(PROFILE_MODE, false);

    // The bootstrap host is the first window's, exactly as the adapter falls back, and the
    // globally active capsule is window A's workspace - a creation that lost either the
    // anchor's window or its verified capsule would land on A's session.
    const { port, allocations } = makeAuthorityPort({
      directory,
      bootstrap: windowA,
      windows: [windowA, windowB],
      activeCapsuleId: () => CAPSULE_A,
    });
    const routedTarget = {
      tabId: 'tab-b',
      documentGeneration: 1,
      browserEpoch: 1,
      runtimeId: 'runtime-partition-invariance',
      projectId: PROJECT_B.projectId,
      workspaceId: WORKSPACE_B,
    } as unknown as BrowserTarget;

    const created = port.openTab({}, { target: routedTarget });

    assert.deepStrictEqual(allocations, [created.tabId]);
    // The child belongs to the anchor's window only.
    assert.equal(windowB.host.hasTab(created.tabId), true);
    assert.equal(windowA.host.hasTab(created.tabId), false);
    assert.equal(directory.hostForTab(created.tabId), windowB.host);

    const createdTab = windowB.host.tabs.get(created.tabId);
    assert.ok(createdTab);
    // On the partition its own window's creation context selects - not on the anchor's
    // capsule jar, not on the other window's jar.
    assert.equal(createdTab.state.partition, profileJar);
    assert.equal(jarOf(windowB, created.tabId), profileJar);
    assert.notEqual(createdTab.state.partition, capsuleBJar);
    assert.notEqual(createdTab.state.partition, capsuleAJar);
    // Bound to the anchor's verified capsule, never to the globally active one.
    assert.equal(createdTab.state.capsuleId, CAPSULE_B);
    assert.notEqual(createdTab.state.capsuleId, CAPSULE_A);

    // Both windows keep the tab sessions they had, and window A's jars are untouched.
    assert.equal(sessionOf(windowA, 'tab-a'), sessionOfTabA);
    assert.equal(jarOf(windowA, 'tab-a'), capsuleAJar);
    assert.deepStrictEqual(windowA.host.getLivePartitionNames(), partitionsOfWindowA);
    assert.deepStrictEqual(windowA.host.tabs.get('tab-a')?.state, stateOfTabA);
    assert.equal(sessionOf(windowB, 'tab-b'), anchorSession);
    assert.equal(jarOf(windowB, 'tab-b'), capsuleBJar);
    // No profile re-selection: the jar both windows derive for new tabs is the one that was
    // selected before the route ran. The two windows share that profile jar by design - one
    // cookie store per profile - and differ only in the capsule jars a tab may be isolated in.
    assert.equal(windowB.host.getSharedProfilePartition(PROFILE_MODE, false), profileJar);
    assert.equal(windowA.host.getSharedProfilePartition(PROFILE_MODE, false), profileJar);
  });
});
