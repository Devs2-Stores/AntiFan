/**
 * An ephemeral tab lives in the host's tab map but never in the user's tab strip:
 * `NativeTabHost.getTabList()` leaves `state.ephemeral` tabs out by design. Every liveness
 * check the browser port makes has to read the tab map, or a live ephemeral tab is refused as
 * closed ("Target tab '<id>' no longer exists") by the trusted-click path, by rebind_target and
 * by set_automation_target while tabs.get and get_viewport still describe it. A tab that really
 * closed is refused by all of them, and no listing names it.
 *
 * The host is the real NativeTabHost bookkeeping; the port is wired through the same seams
 * src/main/index.ts gives it.
 */
import { after, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { SemanticRefRegistry } from '../../../src/main/browser/semantic-ref-registry';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { CapabilityError, type BrowserTarget } from '../../../src/shared/control-plane-contracts';
import { createShellDouble } from '../../support/project-window-shell-double';

// Closing a tab journals into the lifecycle log, which binds its file lazily on first write.
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-ephemeral-liveness-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;
after(() => {
  fs.rmSync(RUNTIME_DIR, { recursive: true, force: true });
});

const PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000001';
const STOREFRONT_TAB = 'tab-storefront';
const OTHER_TAB = 'tab-other';
const EPHEMERAL_TAB = 'tab-ephemeral';

interface Host {
  tabs: Map<string, unknown>;
  getTabList(): Array<{ id: string }>;
  hasTab(tabId?: string | null): boolean;
  resolveTargetTabId(tabId?: string | null): string | undefined;
  getSessionTabRecords(boundTabId: string): unknown[];
  getManagedTabIdsForBoundTab(boundTabId: string): Set<string>;
  isTabAllowedForPrimary(primary: string, requested: string): boolean;
  adoptChildTab(identifier: string, childTabId: string): boolean;
  releaseSessionTab(sessionId: string, tabId: string): boolean;
  getAutomationTabId(): string | null;
  setAutomationTabId(tabId?: string): void;
  getDocumentGeneration(tabId?: string): number;
  closeTab(tabId: string, source?: string): boolean;
  [key: string]: unknown;
}

function makeHost(): Host {
  const host = Object.create(NativeTabHost.prototype) as unknown as Host;
  const noopContents = () => {
    let destroyed = false;
    return {
      isDestroyed: () => destroyed,
      destroy: () => { destroyed = true; },
      close: () => { destroyed = true; },
      on: () => {},
      once: () => {},
      removeListener: () => {},
      setBackgroundThrottling: () => {},
      getURL: () => 'https://shop.test/',
    };
  };
  host.tabs = new Map([STOREFRONT_TAB, OTHER_TAB, EPHEMERAL_TAB].map((id) => [
    id,
    { state: { id, url: `https://shop.test/${id}`, title: id, ephemeral: id === EPHEMERAL_TAB }, view: { webContents: noopContents() } },
  ]));
  host.tabOrder = [STOREFRONT_TAB, OTHER_TAB, EPHEMERAL_TAB];
  host.activeTabId = '';
  host.isDisposed = false;
  host.closeAdmission = null;
  host.pendingPageCloses = new Map();
  host.attemptAuthorizedCloses = new Set();
  host.automationTabId = null;
  host.recentlyClosedTabs = [];
  host.tabPreviewUnsubscribers = new Map();
  host.documentGenerations = new Map();
  host.semanticDocumentGenerations = new Map();
  host.crossDocumentGenerations = new Map();
  host.targetOperationQueues = new Map();
  host.targetOperationOwners = new Map();
  host.sessionTabPools = new Map();
  host.closedTabAnchors = new Map();
  host.tabThemeQaStates = new Map();
  host.terminalAgentAffinity = new Map();
  host.hibernatingTabIds = new Set();
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.agentWorkingRefs = new Map();
  host.agentWorkingTimers = new Map();
  host.shell = createShellDouble();
  host.semanticRefRegistry = new SemanticRefRegistry();
  host.networkTracker = { dispose: () => {}, detachTarget: () => {} };
  host.broadcastState = () => {};
  host.switchTab = () => true;
  host.createTab = () => 'created-tab';
  host.reassertPresentedView = () => {};
  host.updateLayout = () => {};
  host.persistTabs = () => {};
  return host;
}

/** The port seams src/main/index.ts wires, over one window host. */
function makePort(host: Host, clicks: string[] = []): BrowserControlPort {
  return new BrowserControlPort({
    hasTab: (tabId: string | null | undefined) => Boolean(tabId && host.hasTab(tabId)),
    resolveTargetTabId: (tabId: string | null | undefined) => (tabId ? host.resolveTargetTabId(tabId) : undefined),
    getTabList: () => host.getTabList(),
    getSessionTabList: (boundTabId: string) => host.getSessionTabRecords(boundTabId),
    getManagedTabIds: (boundTabId: string) => host.getManagedTabIdsForBoundTab(boundTabId),
    isTabAllowed: (primary: string, requested: string) => host.isTabAllowedForPrimary(primary, requested),
    getAutomationTabId: () => host.getAutomationTabId(),
    setAutomationTabId: (tabId?: string) => host.setAutomationTabId(tabId && host.hasTab(tabId) ? tabId : undefined),
    getDocumentGeneration: (tabId?: string) => host.getDocumentGeneration(tabId),
    // Every tab here was created in the project's capsule, as the agent's tabs.create does.
    resolveTabAffiliation: (tabId: string) => (host.hasTab(tabId) ? { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, capsuleId: 'capsule-test' } : undefined),
    agentClick: async (args: { tabId?: string }) => {
      clicks.push(String(args.tabId));
      return true;
    },
    navigate: async () => true,
    reload: async () => true,
    getDom: async () => '<html></html>',
    captureScreenshot: async () => '',
    evalJs: async () => undefined,
  } as unknown as BrowserHostPort);
}

function target(tabId: string): BrowserTarget {
  return { projectId: PROJECT_ID, workspaceId: WORKSPACE_ID, runtimeId: 'runtime-test', tabId, browserEpoch: 1, documentGeneration: 1 };
}

const stale = (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE';
const ids = (rows: unknown[]) => rows.map((row) => (row as { id: string }).id);

describe('an ephemeral tab is live to every browser port check', () => {
  it('lives in the tab map and never in the strip', () => {
    const host = makeHost();
    assert.deepEqual(host.getTabList().map((tab) => tab.id), [STOREFRONT_TAB, OTHER_TAB]);
    assert.equal(host.hasTab(EPHEMERAL_TAB), true);
  });

  it('runs a trusted click on a live ephemeral tab the session is bound to', async () => {
    const host = makeHost();
    assert.equal(host.adoptChildTab(STOREFRONT_TAB, EPHEMERAL_TAB), true);
    const clicks: string[] = [];
    const port = makePort(host, clicks);

    const result = await port.agentClick({ selector: '#open-drawer', tabId: EPHEMERAL_TAB }, target(EPHEMERAL_TAB));

    assert.equal(result.clicked, true);
    assert.deepEqual(clicks, [EPHEMERAL_TAB]);
  });

  it('rebinds onto, and sets as automation target, a live ephemeral tab the session owns', () => {
    const host = makeHost();
    assert.equal(host.adoptChildTab(STOREFRONT_TAB, EPHEMERAL_TAB), true);
    host.setAutomationTabId(STOREFRONT_TAB);
    const port = makePort(host);

    const rebound = port.rebindTarget({ tabId: EPHEMERAL_TAB }, target(STOREFRONT_TAB));
    assert.equal(rebound.success, true);
    assert.equal(rebound.tabId, EPHEMERAL_TAB);
    assert.equal(rebound.url, `https://shop.test/${EPHEMERAL_TAB}`);

    assert.deepEqual(port.setAutomationTarget(EPHEMERAL_TAB), { success: true, tabId: EPHEMERAL_TAB });
    assert.equal(host.getAutomationTabId(), EPHEMERAL_TAB);
  });

  it('describes and rebinds onto a live same-project ephemeral tab the session released', () => {
    const host = makeHost();
    assert.equal(host.adoptChildTab(STOREFRONT_TAB, EPHEMERAL_TAB), true);
    // The release AttachmentRegistry.updateAttachmentTab makes when the binding leaves the tab
    // for one outside the managed set: it lets the tab go, it does not close it.
    host.releaseSessionTab(EPHEMERAL_TAB, EPHEMERAL_TAB);
    host.setAutomationTabId(STOREFRONT_TAB);
    assert.equal(host.hasTab(EPHEMERAL_TAB), true);
    assert.equal(host.isTabAllowedForPrimary(STOREFRONT_TAB, EPHEMERAL_TAB), false);
    const port = makePort(host);

    assert.equal(port.getTab(target(STOREFRONT_TAB), EPHEMERAL_TAB).id, EPHEMERAL_TAB);
    const rebound = port.rebindTarget({ tabId: EPHEMERAL_TAB }, target(STOREFRONT_TAB));
    assert.equal(rebound.success, true);
    assert.equal(rebound.tabId, EPHEMERAL_TAB);
  });

  it('refuses a closed ephemeral tab on every path and no listing names it', async () => {
    const host = makeHost();
    assert.equal(host.adoptChildTab(STOREFRONT_TAB, EPHEMERAL_TAB), true);
    host.setAutomationTabId(STOREFRONT_TAB);
    const clicks: string[] = [];
    const port = makePort(host, clicks);
    assert.ok(ids(port.listTabs({ target: target(STOREFRONT_TAB), scope: 'session' })).includes(EPHEMERAL_TAB), 'listed while live');

    assert.equal(host.closeTab(EPHEMERAL_TAB, 'test'), true);

    assert.equal(ids(port.listTabs({ target: target(STOREFRONT_TAB), scope: 'session' })).includes(EPHEMERAL_TAB), false);
    assert.equal(ids(port.listTabs({ target: target(STOREFRONT_TAB) })).includes(EPHEMERAL_TAB), false);
    assert.throws(() => port.getTab(target(STOREFRONT_TAB), EPHEMERAL_TAB), stale);
    assert.throws(() => port.rebindTarget({ tabId: EPHEMERAL_TAB }, target(STOREFRONT_TAB)), stale);
    assert.throws(() => port.setAutomationTarget(EPHEMERAL_TAB), (err: unknown) => err instanceof CapabilityError && err.code === 'INVALID_ARGUMENT');
    await assert.rejects(port.agentClick({ selector: '#open-drawer', tabId: EPHEMERAL_TAB }, target(EPHEMERAL_TAB)), stale);
    assert.deepEqual(clicks, []);
  });
});
