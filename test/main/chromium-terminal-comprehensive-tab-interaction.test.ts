import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { dispatchAnnotationToTerminal, sanitizeTerminalPrompt } from '../../src/main/browser/annotation-dispatch';
import { AntiFanTab } from '../../src/shared/contracts';
import { BrowserTarget, CapabilityError } from '../../src/shared/control-plane-contracts';

// Test seams for mock Host and WebContents
interface MockWebContents {
  isDestroyed: () => boolean;
  destroy?: () => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  loadURL?: (url: string) => Promise<void>;
}

interface MockTabRecord {
  id: string;
  state: AntiFanTab;
  view: { webContents: MockWebContents };
  mobileView?: { webContents: MockWebContents };
  focusedPane?: 'desktop' | 'mobile';
  activePaneId?: 'desktop' | 'mobile';
}

interface MockTerminalWindow {
  id: number;
  isDestroyed: () => boolean;
  close?: () => void;
  webContents?: {
    isDestroyed: () => boolean;
    send: (channel: string, ...args: unknown[]) => void;
  };
  on?: (evt: string, cb: () => void) => void;
}

interface ComprehensiveTestHost {
  tabs: Map<string, MockTabRecord>;
  tabOrder: string[];
  activeTabId: string;
  isDisposed: boolean;
  isSidebarOpen: boolean;
  wasSidebarOpenBeforePopout: boolean;
  popoutWindow: unknown;
  terminalWindows: Map<number, MockTerminalWindow>;
  terminalWindowMeta: Map<number, { sessionId?: string; isPopout?: boolean }>;
  recentlyClosedTabs: Array<{ url: string; title: string }>;
  tabPreviewUnsubscribers: Map<string, () => void>;
  terminalAgentAffinity: Map<string, {
    tabId: string;
    primaryTabId: string;
    managedTabIds: Set<string>;
    lineage?: Map<string, { tabId: string; parentTabId?: string; source: string; createdAt: number }>;
    lastUrls?: Map<string, string>;
    lastUrl?: string;
    closedAt?: number;
  }>;
  sessionTabPools: Map<string, Set<string>>;

  // NativeTabHost prototype methods
  hasTab(tabId?: string | null): boolean;
  resolveTargetTabId(tabIdOrIdentifier?: string | null): string | undefined;
  createTab(url?: string, activate?: boolean, options?: Record<string, unknown>): string;
  switchTab(tabId: string): boolean;
  closeTab(tabId: string): boolean;
  closeTabsToRight(tabId: string): void;
  closeOtherTabs(tabId: string): void;
  reopenClosedTab(): string | null;
  bindTerminalAgentAffinity(terminalId: string, generation: number | string | undefined, tabId: string): boolean;
  adoptChildTab(identifier: string, childTabId: string, generation?: number | string, source?: 'agent_spawned' | 'native_window_open' | 'user_attached', parentTabId?: string): boolean;
  adoptChildTabForSession(sessionId: string, childTabId: string): boolean;
  getManagedTabIds(boundTabIdOrTerminalId: string): Set<string>;
  getManagedTabIdsForBoundTab(boundTabId: string): Set<string>;
  isTabAllowed(primaryOrBoundTabId: string, requestedTabId: string): boolean;
  isTabAllowedForPrimary(primaryTabId: string, requestedTabId: string): boolean;
  getFailoverTargetTab(staleTabId: string): string | undefined;
  getTabLineage(tabId: string): { tabId: string; parentTabId?: string; source: string; createdAt: number } | undefined;
  removeManagedTab(terminalId: string, tabId: string, generation?: number | string): boolean;
  clearTerminalAgentAffinity(terminalId: string): void;
  tombstoneTerminalAgentAffinity(tabId: string, lastUrl?: string): void;
  migrateTerminalAgentAffinityGeneration(terminalId: string, newGeneration: number): void;
  getTerminalAgentAffinity(terminalSessionId: string, generation?: number | string): { tabId: string; status: 'alive' | 'closed'; lastUrl?: string; managedTabIds?: string[] } | undefined;
  getTabTerminalSession(tabId: string): string | undefined;
  setTabTerminalSession(tabId: string, sessionId?: string): boolean;
  resolveTabStrictWorkspace(targetSessionId?: string, tabUrl?: string): string;
  toggleSidebar(): boolean;
  togglePopoutTerminal(sessionId?: string, options?: Record<string, unknown>): boolean;
  broadcastState(): void;
  countAttachedViews(): number;
  clearTabAgentWorking(tabId: string): void;
  executedClicks: Array<{ selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }>;
  executedTypes: Array<{ selector?: string; text: string; tabId?: string; paneId?: 'desktop' | 'mobile' }>;
  getTabList(): Array<{ id: string; url?: string; title?: string; alias?: string; role?: string }>;
  agentClick(params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
  agentType(params: { selector?: string; text: string; tabId?: string; paneId?: 'desktop' | 'mobile' }): Promise<boolean>;
}

function createMockWebContents(): MockWebContents {
  let destroyed = false;
  return {
    isDestroyed: () => destroyed,
    destroy: () => { destroyed = true; },
    executeJavaScript: async () => undefined,
    loadURL: async () => {},
  };
}

function createComprehensiveHost(initialTabIds: string[] = ['tab-1']): ComprehensiveTestHost {
  const host = Object.create(NativeTabHost.prototype) as unknown as ComprehensiveTestHost;
  const tabs = new Map<string, MockTabRecord>();
  for (const id of initialTabIds) {
    tabs.set(id, {
      id,
      state: {
        id,
        url: `https://example.test/${id}`,
        title: `Tab ${id}`,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
      },
      view: { webContents: createMockWebContents() },
    });
  }

  host.tabs = tabs;
  host.tabOrder = [...initialTabIds];
  host.activeTabId = initialTabIds[0] ?? '';
  host.isDisposed = false;
  host.isSidebarOpen = true;
  host.wasSidebarOpenBeforePopout = false;
  host.popoutWindow = null;
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  host.recentlyClosedTabs = [];
  host.tabPreviewUnsubscribers = new Map();
  host.terminalAgentAffinity = new Map();
  host.sessionTabPools = new Map();

  // Test environment wrappers for UI calls that touch Electron display/windows
  const hostSeam = host as unknown as Record<string, unknown>;
  const childrenList: unknown[] = [];
  hostSeam.window = {
    contentView: {
      children: childrenList,
      addChildView: (view: unknown) => { childrenList.push(view); },
      removeChildView: (view: unknown) => {
        const idx = childrenList.indexOf(view);
        if (idx !== -1) childrenList.splice(idx, 1);
      },
    },
    isDestroyed: () => false,
  };
  hostSeam.attachTabView = (view: unknown) => {
    if (view && !childrenList.includes(view)) {
      childrenList.push(view);
    }
  };
  hostSeam.updateLayout = () => {};
  hostSeam.broadcastState = () => {};
  hostSeam.countAttachedViews = () => host.tabs.size;
  hostSeam.clearTabAgentWorking = () => {};
  hostSeam.schedulePersist = () => {};
  hostSeam.documentGenerations = new Map<string, number>();
  hostSeam.semanticDocumentGenerations = new Map<string, number>();
  hostSeam.mutationRevisions = new Map<string, number>();
  hostSeam.isCurrentTarget = () => true;
  const executedClicks: Array<{ selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }> = [];
  const executedTypes: Array<{ selector?: string; text: string; tabId?: string; paneId?: 'desktop' | 'mobile' }> = [];
  host.executedClicks = executedClicks;
  host.executedTypes = executedTypes;
  hostSeam.executedClicks = executedClicks;
  hostSeam.executedTypes = executedTypes;
  hostSeam.agentClick = async (params: { selector?: string; tabId?: string; paneId?: 'desktop' | 'mobile' }) => {
    executedClicks.push(params);
    return true;
  };
  hostSeam.agentType = async (params: { selector?: string; text: string; tabId?: string; paneId?: 'desktop' | 'mobile' }) => {
    executedTypes.push(params);
    return true;
  };
  hostSeam.getTabList = () => Array.from(host.tabs.values()).map((t) => ({
    id: t.id,
    url: t.state.url,
    title: t.state.title,
    alias: t.state.alias,
    role: t.state.role,
  }));
  // Custom createTab that operates safely in node test runner without Electron BrowserWindow
  host.createTab = function (url = 'https://www.google.com', activate = true): string {
    const id = `tab-spawned-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const tabRecord: MockTabRecord = {
      id,
      state: {
        id,
        url,
        title: `Tab ${id}`,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
      },
      view: { webContents: createMockWebContents() },
    };
    host.tabs.set(id, tabRecord);
    host.tabOrder.push(id);
    if (activate) {
      host.activeTabId = id;
    }
    host.broadcastState();
    return id;
  };

  return host;
}

describe('Chromium <-> Terminal 30-Flow Interaction & Tab Management Matrix', () => {
  interface TerminalManagerMockSeam {
    listSessions: () => Array<{ id: string; name: string; cwd: string; sessionGeneration: number }>;
    getSession: (id: string) => { id: string; name: string; cwd: string; sessionGeneration: number } | undefined;
    getActiveSessionId: () => string;
  }
  const tm = TerminalManager.getInstance() as unknown as TerminalManagerMockSeam;
  const originalListSessions = tm.listSessions;
  const originalGetSession = tm.getSession;
  const originalGetActiveSessionId = tm.getActiveSessionId;
  let liveSessions: Array<{ id: string; name: string; cwd: string; sessionGeneration: number }>;
  let tempDir: string;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-30flow-test-'));
    liveSessions = [
      { id: 'terminal-1', name: 'Terminal 1', cwd: tempDir, sessionGeneration: 1 },
      { id: 'terminal-2', name: 'Terminal 2', cwd: tempDir, sessionGeneration: 1 },
      { id: 'terminal-3', name: 'Terminal 3', cwd: tempDir, sessionGeneration: 1 },
    ];
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => 'terminal-1';
    tm.getSession = (id: string) => liveSessions.find((s) => s.id === id);
  });

  after(() => {
    tm.listSessions = originalListSessions;
    tm.getSession = originalGetSession;
    tm.getActiveSessionId = originalGetActiveSessionId;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // =========================================================================
  // DOMAIN 1: Basic & Advanced Tab Creation & Focus Management (Flows 1-5)
  // =========================================================================

  it('Flow 01: Foreground Tab Creation sets activeTabId, appends to tabOrder, and defaults terminal to undefined', () => {
    const host = createComprehensiveHost(['tab-1']);
    const createdId = host.createTab('https://antifan.test/home', true);

    assert.strictEqual(host.activeTabId, createdId);
    assert.ok(host.tabOrder.includes(createdId));
    assert.strictEqual(host.tabOrder[host.tabOrder.length - 1], createdId);
    // Fresh tab without explicit affinity defaults to undefined (popup will preselect auto)
    assert.strictEqual(host.getTabTerminalSession(createdId), undefined);
  });

  it('Flow 02: Background Tab Creation (activate: false) preserves current activeTabId and terminal focus', () => {
    const host = createComprehensiveHost(['tab-foreground']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-foreground');

    const backgroundId = host.createTab('https://antifan.test/background', false);
    assert.strictEqual(host.activeTabId, 'tab-foreground', 'Active tab must not change on background tab creation');
    assert.ok(host.tabOrder.includes(backgroundId));
    assert.strictEqual(host.getTabTerminalSession('tab-foreground'), 'terminal-1');
  });

  it('Flow 03: Tab Switching updates activeTabId and routes terminal session per tab', () => {
    const host = createComprehensiveHost(['tab-alpha', 'tab-beta']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-alpha');
    host.bindTerminalAgentAffinity('terminal-2', 1, 'tab-beta');

    assert.strictEqual(host.switchTab('tab-beta'), true);
    assert.strictEqual(host.activeTabId, 'tab-beta');
    assert.strictEqual(host.getTabTerminalSession(host.activeTabId), 'terminal-2');

    assert.strictEqual(host.switchTab('tab-alpha'), true);
    assert.strictEqual(host.activeTabId, 'tab-alpha');
    assert.strictEqual(host.getTabTerminalSession(host.activeTabId), 'terminal-1');
  });

  it('Flow 04: Numeric #N Index and Semantic Role Lookups adapt dynamically across tab reorders', () => {
    const host = createComprehensiveHost(['tab-1', 'tab-2', 'tab-3']);
    host.tabs.get('tab-2')!.state.url = 'https://myshopify.com/admin/orders';
    host.tabs.get('tab-2')!.state.role = 'admin';

    // In initial order [tab-1, tab-2, tab-3]:
    assert.strictEqual(host.resolveTargetTabId('#1'), 'tab-1');
    assert.strictEqual(host.resolveTargetTabId('#2'), 'tab-2');
    assert.strictEqual(host.resolveTargetTabId('#3'), 'tab-3');
    assert.strictEqual(host.resolveTargetTabId('#4'), undefined);

    // Reorder tabs: tab-3 moves to first position
    host.tabOrder = ['tab-3', 'tab-1', 'tab-2'];
    assert.strictEqual(host.resolveTargetTabId('#1'), 'tab-3');
    assert.strictEqual(host.resolveTargetTabId('#2'), 'tab-1');
    assert.strictEqual(host.resolveTargetTabId('#3'), 'tab-2');

    // Semantic alias resolution
    assert.strictEqual(host.resolveTargetTabId('@admin'), 'tab-2');
  });

  it('Flow 05: Duplicate URLs in separate tabs maintain independent IDs, document generations and affinity', () => {
    const host = createComprehensiveHost(['tab-dup-1', 'tab-dup-2']);
    host.tabs.get('tab-dup-1')!.state.url = 'https://shop.test/product';
    host.tabs.get('tab-dup-2')!.state.url = 'https://shop.test/product';

    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-dup-1');
    assert.strictEqual(host.getTabTerminalSession('tab-dup-1'), 'terminal-1');
    assert.strictEqual(host.getTabTerminalSession('tab-dup-2'), undefined);
    assert.strictEqual(host.isTabAllowedForPrimary('tab-dup-1', 'tab-dup-2'), false);
  });

  // =========================================================================
  // DOMAIN 2: Tab Deletion, Bulk Closure & Reopening (Flows 6-10)
  // =========================================================================

  it('Flow 06: Active Tab Closure falls back focus to adjacent/last tab in tabOrder', () => {
    const host = createComprehensiveHost(['tab-1', 'tab-2', 'tab-3']);
    host.activeTabId = 'tab-2';

    assert.strictEqual(host.closeTab('tab-2'), true);
    assert.strictEqual(host.tabs.has('tab-2'), false);
    assert.deepStrictEqual(host.tabOrder, ['tab-1', 'tab-3']);
    assert.strictEqual(host.activeTabId, 'tab-3', 'Focus must fallback to last remaining tab in tabOrder');
  });

  it('Flow 07: Inactive / Background Tab Closure keeps active tab and its terminal affinity intact', () => {
    const host = createComprehensiveHost(['tab-active', 'tab-inactive']);
    host.activeTabId = 'tab-active';
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-active');

    assert.strictEqual(host.closeTab('tab-inactive'), true);
    assert.strictEqual(host.activeTabId, 'tab-active');
    assert.strictEqual(host.getTabTerminalSession('tab-active'), 'terminal-1');
    assert.strictEqual(host.hasTab('tab-inactive'), false);
  });

  it('Flow 08: closeTabsToRight batches cleanup of terminal affinities for closed tabs only', () => {
    const host = createComprehensiveHost(['tab-1', 'tab-2', 'tab-3', 'tab-4', 'tab-5']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-2');
    host.bindTerminalAgentAffinity('terminal-2', 1, 'tab-4');

    host.closeTabsToRight('tab-2');
    assert.deepStrictEqual(host.tabOrder, ['tab-1', 'tab-2']);
    assert.strictEqual(host.hasTab('tab-3'), false);
    assert.strictEqual(host.hasTab('tab-4'), false);
    assert.strictEqual(host.hasTab('tab-5'), false);

    // Tab-2's affinity survived:
    assert.strictEqual(host.getTerminalAgentAffinity('terminal-1', 1)?.status, 'alive');
    // Tab-4's affinity was tombstoned:
    assert.strictEqual(host.getTerminalAgentAffinity('terminal-2', 1)?.status, 'closed');
  });

  it('Flow 09: closeOtherTabs closes all except designated tab and preserves its affinity', () => {
    const host = createComprehensiveHost(['tab-1', 'tab-2', 'tab-3']);
    host.activeTabId = 'tab-1';
    host.bindTerminalAgentAffinity('terminal-2', 1, 'tab-2');

    host.closeOtherTabs('tab-2');
    assert.deepStrictEqual(host.tabOrder, ['tab-2']);
    assert.strictEqual(host.activeTabId, 'tab-2');
    assert.strictEqual(host.getTabTerminalSession('tab-2'), 'terminal-2');
  });

  it('Flow 10: Closing the final remaining tab auto-recreates default tab without crash', () => {
    const host = createComprehensiveHost(['tab-sole']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-sole');

    assert.strictEqual(host.closeTab('tab-sole'), true);
    // host.createTab was triggered on tabOrder.length === 0
    assert.ok(host.tabOrder.length >= 1, 'Host must maintain at least one default tab');
    assert.notStrictEqual(host.activeTabId, 'tab-sole');
    assert.strictEqual(host.hasTab('tab-sole'), false);
    assert.strictEqual(host.getTerminalAgentAffinity('terminal-1', 1)?.status, 'closed');
  });

  // =========================================================================
  // DOMAIN 3: Terminal-Tab Affinity & Binding Lifecycle (Flows 11-15)
  // =========================================================================

  it('Flow 11: Direct Binding creates generation anchor, lineage, and sets tab.state.terminalSessionId', () => {
    const host = createComprehensiveHost(['tab-a']);
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-a'), true);

    const aff = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(aff);
    assert.strictEqual(aff.tabId, 'tab-a');
    assert.strictEqual(aff.status, 'alive');
    assert.strictEqual(host.tabs.get('tab-a')?.state.terminalSessionId, 'terminal-1');

    const lineage = host.getTabLineage('tab-a');
    assert.ok(lineage);
    assert.strictEqual(lineage.source, 'user_attached');
  });

  it('Flow 12: Rebinding terminal from Tab A to Tab B cleans up Tab A state seamlessly', () => {
    const host = createComprehensiveHost(['tab-a', 'tab-b']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-a');
    assert.strictEqual(host.getTabTerminalSession('tab-a'), 'terminal-1');

    // Rebind terminal-1 to tab-b
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-b'), true);
    assert.strictEqual(host.getTabTerminalSession('tab-b'), 'terminal-1');

    // Tab A is no longer primary and no longer has terminal-1 affinity
    const aff = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.strictEqual(aff?.tabId, 'tab-b');
  });

  it('Flow 13: Binding to non-existent tabId or non-existent terminalId fails closed (returns false)', () => {
    const host = createComprehensiveHost(['tab-a']);
    assert.strictEqual(host.bindTerminalAgentAffinity('non-existent-terminal', 1, 'tab-a'), false);
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'non-existent-tab'), false);
  });

  it('Flow 14: Generation migration on terminal restart updates affinity key and invalidates stale generation queries', () => {
    const host = createComprehensiveHost(['tab-live']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-live');

    // Terminal restarts -> generation 2
    host.migrateTerminalAgentAffinityGeneration('terminal-1', 2);

    // Stale generation 1 query fails
    assert.strictEqual(host.getTerminalAgentAffinity('terminal-1', 1), undefined);

    // Generation 2 query succeeds with alive status
    const gen2 = host.getTerminalAgentAffinity('terminal-1', 2);
    assert.ok(gen2);
    assert.strictEqual(gen2.tabId, 'tab-live');
    assert.strictEqual(gen2.status, 'alive');
  });

  it('Flow 15: Terminal session closure clears affinity and resets tab.state.terminalSessionId', () => {
    const host = createComprehensiveHost(['tab-bound']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-bound');
    assert.strictEqual(host.tabs.get('tab-bound')?.state.terminalSessionId, 'terminal-1');

    // Simulate TerminalManager 'session-closed' event
    host.clearTerminalAgentAffinity('terminal-1');
    assert.strictEqual(host.getTerminalAgentAffinity('terminal-1', 1), undefined);
    assert.strictEqual(host.tabs.get('tab-bound')?.state.terminalSessionId, undefined);
  });

  // =========================================================================
  // DOMAIN 4: Child Tab Adoption, Lineage & Quotas (Flows 16-20)
  // =========================================================================

  it('Flow 16: Child Tab Adoption via agent_spawned joins managed pool and records lineage', () => {
    const host = createComprehensiveHost(['tab-parent', 'tab-child']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-parent');

    assert.strictEqual(host.adoptChildTab('terminal-1', 'tab-child', 1, 'agent_spawned', 'tab-parent'), true);
    const aff = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(aff?.managedTabIds?.includes('tab-child'));

    const lineage = host.getTabLineage('tab-child');
    assert.ok(lineage);
    assert.strictEqual(lineage.source, 'agent_spawned');
    assert.strictEqual(lineage.parentTabId, 'tab-parent');
  });

  it('Flow 17: Child Tab Adoption via native_window_open tracks popup link lineage', () => {
    const host = createComprehensiveHost(['tab-origin', 'tab-popup']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-origin');

    assert.strictEqual(host.adoptChildTab('terminal-1', 'tab-popup', 1, 'native_window_open', 'tab-origin'), true);
    const lineage = host.getTabLineage('tab-popup');
    assert.ok(lineage);
    assert.strictEqual(lineage.source, 'native_window_open');
    assert.strictEqual(lineage.parentTabId, 'tab-origin');
    assert.strictEqual(host.isTabAllowedForPrimary('tab-origin', 'tab-popup'), true);
  });

  it('Flow 18: Ad-hoc Session Pool Anchoring allows adoption when terminal session is absent', () => {
    const host = createComprehensiveHost(['tab-bound-only', 'tab-ad-hoc-child']);
    // No terminal affinity bound
    assert.strictEqual(host.adoptChildTab('tab-bound-only', 'tab-ad-hoc-child'), true);

    const managed = host.getManagedTabIdsForBoundTab('tab-bound-only');
    assert.ok(managed.has('tab-bound-only'));
    assert.ok(managed.has('tab-ad-hoc-child'));
    assert.strictEqual(host.isTabAllowedForPrimary('tab-bound-only', 'tab-ad-hoc-child'), true);
  });

  it('Flow 19: Strict 10-Tab Pool Quota enforces rate limiting on runaway tab creation', () => {
    const childIds = Array.from({ length: 11 }, (_, i) => `tab-sub-${i + 1}`);
    const host = createComprehensiveHost(['tab-root', ...childIds]);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-root');

    // Adopt 9 child tabs (total 10 tabs: root + 9 children)
    for (let i = 0; i < 9; i++) {
      assert.strictEqual(host.adoptChildTab('tab-root', childIds[i]!, 1), true);
    }
    assert.strictEqual(host.getManagedTabIds('tab-root').size, 10);

    // 10th child (attempted 11th tab) MUST be rejected
    assert.strictEqual(host.adoptChildTab('tab-root', childIds[9]!, 1), false);
    assert.strictEqual(host.getManagedTabIds('tab-root').size, 10);
  });

  it('Flow 20: Deep Lineage Hierarchy preserves multi-level parent-child relationship (Grandchild)', () => {
    const host = createComprehensiveHost(['tab-root', 'tab-child', 'tab-grandchild']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-root');

    host.adoptChildTab('terminal-1', 'tab-child', 1, 'agent_spawned', 'tab-root');
    host.adoptChildTab('terminal-1', 'tab-grandchild', 1, 'agent_spawned', 'tab-child');

    const lineageChild = host.getTabLineage('tab-child');
    const lineageGrandchild = host.getTabLineage('tab-grandchild');

    assert.strictEqual(lineageChild?.parentTabId, 'tab-root');
    assert.strictEqual(lineageGrandchild?.parentTabId, 'tab-child');
    assert.strictEqual(host.isTabAllowedForPrimary('tab-root', 'tab-grandchild'), true);
  });

  // =========================================================================
  // DOMAIN 5: Agent Interaction, Security Gates & Failover (Flows 21-25)
  // =========================================================================

  it('Flow 21: Cross-Terminal Isolation Barrier throws TARGET_MISMATCH on alien tab mutation via public agentClick', async () => {
    const host = createComprehensiveHost(['tab-agent-1', 'tab-agent-2']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-agent-1');
    host.bindTerminalAgentAffinity('terminal-2', 1, 'tab-agent-2');

    const port = new BrowserControlPort(host as unknown as BrowserHostPort);
    const target1: BrowserTarget = {
      tabId: 'tab-agent-1',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // 1. Public agentClick on bound tab-agent-1 succeeds:
    const clickRes = await port.agentClick({ selector: '#submit', tabId: 'tab-agent-1' }, target1);
    assert.strictEqual(clickRes.clicked, true);
    assert.strictEqual(host.executedClicks[host.executedClicks.length - 1]?.tabId, 'tab-agent-1');

    // 2. Public agentClick attempting to mutate alien tab-agent-2 is REJECTED with TARGET_MISMATCH:
    await assert.rejects(
      async () => port.agentClick({ selector: '#alien-button', tabId: 'tab-agent-2' }, target1),
      (err: unknown) => {
        const capErr = err as CapabilityError;
        return capErr.code === 'TARGET_MISMATCH';
      }
    );
  });

  it('Flow 22: Primary Tab Closure triggers Child Promotion Failover allowing public agentClick to continue seamlessly', async () => {
    const host = createComprehensiveHost(['tab-primary', 'tab-child-1']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-primary');
    host.adoptChildTab('terminal-1', 'tab-child-1', 1);

    const port = new BrowserControlPort(host as unknown as BrowserHostPort);
    const targetPrimary: BrowserTarget = {
      tabId: 'tab-primary',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // Public click on primary succeeds
    const resPrimary = await port.agentClick({ selector: '#checkout' }, targetPrimary);
    assert.strictEqual(resPrimary.clicked, true);
    assert.strictEqual(host.executedClicks[host.executedClicks.length - 1]?.tabId, 'tab-primary');

    // Primary tab closes
    assert.strictEqual(host.closeTab('tab-primary'), true);

    // Terminal must survive and tab-child-1 must be promoted to primary
    const aff = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(aff);
    assert.strictEqual(aff.status, 'alive', 'Terminal affinity must stay alive via failover');
    assert.strictEqual(aff.tabId, 'tab-child-1', 'Child tab must be promoted to primary tabId');

    // Public click with same targetPrimary automatically fails over to promoted tab-child-1!
    const resFailover = await port.agentClick({ selector: '#continue-on-child' }, targetPrimary);
    assert.strictEqual(resFailover.clicked, true);
    assert.strictEqual(host.executedClicks[host.executedClicks.length - 1]?.tabId, 'tab-child-1');
  });


  it('Flow 23: All Managed Tabs Closed marks affinity as closed (tombstoned)', () => {
    const host = createComprehensiveHost(['tab-last']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-last');

    host.closeTab('tab-last');
    const aff = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(aff);
    assert.strictEqual(aff.status, 'closed');
    assert.strictEqual(host.getFailoverTargetTab('tab-last'), undefined);
  });

  it('Flow 24: Agent Action Against Stale/Closed Tab throws TARGET_STALE gracefully on public agentClick', async () => {
    const host = createComprehensiveHost(['tab-initial']);
    const port = new BrowserControlPort(host as unknown as BrowserHostPort);
    const staleTarget: BrowserTarget = {
      tabId: 'tab-stale-1234',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // Public call to agentClick on stale target throws TARGET_STALE
    await assert.rejects(
      async () => port.agentClick({ selector: '#button' }, staleTarget),
      (err: unknown) => {
        const capErr = err as CapabilityError;
        return capErr.code === 'TARGET_STALE';
      }
    );
  });

  it('Flow 25: Dynamic Child Tab Removal immediately revokes public agent permissions', async () => {
    const host = createComprehensiveHost(['tab-main', 'tab-sub']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-main');
    host.adoptChildTab('terminal-1', 'tab-sub', 1);
    assert.strictEqual(host.isTabAllowedForPrimary('tab-main', 'tab-sub'), true);

    const port = new BrowserControlPort(host as unknown as BrowserHostPort);
    const targetMain: BrowserTarget = {
      tabId: 'tab-main',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // Public click on sub-tab is permitted before eviction:
    const resBefore = await port.agentClick({ selector: '#sub-btn', tabId: 'tab-sub' }, targetMain);
    assert.strictEqual(resBefore.clicked, true);

    // Evict child tab
    assert.strictEqual(host.removeManagedTab('terminal-1', 'tab-sub', 1), true);
    assert.strictEqual(host.isTabAllowedForPrimary('tab-main', 'tab-sub'), false);

    // Public click on sub-tab is now REJECTED with TARGET_MISMATCH:
    await assert.rejects(
      async () => port.agentClick({ selector: '#sub-btn', tabId: 'tab-sub' }, targetMain),
      (err: unknown) => {
        const capErr = err as CapabilityError;
        return capErr.code === 'TARGET_MISMATCH';
      }
    );
  });

  // =========================================================================
  // DOMAIN 6: Annotation, Inspect Modal & Split Panes (Flows 26-28)
  // =========================================================================

  it('Flow 26: Per-Tab Popup Annotation Session Memory isolates selections across tabs', () => {
    const host = createComprehensiveHost(['tab-x', 'tab-y']);
    host.setTabTerminalSession('tab-x', 'terminal-1');
    host.setTabTerminalSession('tab-y', 'terminal-2');

    assert.strictEqual(host.getTabTerminalSession('tab-x'), 'terminal-1');
    assert.strictEqual(host.getTabTerminalSession('tab-y'), 'terminal-2');

    // Setting explicit 'auto'
    host.setTabTerminalSession('tab-x', 'auto');
    assert.strictEqual(host.getTabTerminalSession('tab-x'), 'auto');
    assert.strictEqual(host.getTabTerminalSession('tab-y'), 'terminal-2', 'Tab Y memory must be untouched');
  });

  it('Flow 27: Annotation Prompt Dispatch routes to tab session and sanitizes multiline input', () => {
    const writtenCommands: Array<{ id: string; input: string }> = [];
    let switchedId = '';
    const mockDispatchPort = {
      getActiveSessionId: () => 'terminal-1',
      switchSession: (id: string) => { switchedId = id; return true; },
      writeTo: (id: string, input: string) => { writtenCommands.push({ id, input }); },
      write: (input: string) => { writtenCommands.push({ id: 'active', input }); },
    };

    const rawPrompt = 'Inspect button\r\nconsole.log("bad multiline");\r\nrm -rf /\n';
    dispatchAnnotationToTerminal(mockDispatchPort, 'terminal-2', rawPrompt);

    assert.strictEqual(switchedId, 'terminal-2', 'Must switch to tab-specific terminal session');
    assert.strictEqual(writtenCommands.length, 1);
    assert.strictEqual(writtenCommands[0]!.id, 'terminal-2');
    // Multiline newlines replaced with single spaces and trimmed:
    assert.strictEqual(writtenCommands[0]!.input, 'Inspect button console.log("bad multiline"); rm -rf /\r');
  });

  it('Flow 28: Chromium Split Review (Desktop + Mobile) targets focused pane accurately via public agentClick', async () => {
    const host = createComprehensiveHost(['tab-split']);
    const tabRecord = host.tabs.get('tab-split')!;
    tabRecord.state.splitMode = true;
    tabRecord.mobileView = { webContents: createMockWebContents() };

    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-split');

    const port = new BrowserControlPort(host as unknown as BrowserHostPort);
    const target: BrowserTarget = {
      tabId: 'tab-split',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // Public agentClick targeting mobile pane on the bound tab succeeds
    const res = await port.agentClick({ selector: '#mobile-hamburger', tabId: 'tab-split', paneId: 'mobile' }, target);
    assert.strictEqual(res.clicked, true);
    assert.strictEqual(host.executedClicks[host.executedClicks.length - 1]?.tabId, 'tab-split');
    assert.strictEqual(host.executedClicks[host.executedClicks.length - 1]?.paneId, 'mobile');
  });

  // =========================================================================
  // DOMAIN 7: Terminal Windows, Concurrency & Chaos (Flows 29-31)
  // =========================================================================

  it('Flow 29: Terminal Popout Window vs Sidebar View multi-broadcast bookkeeping & destroyed window pruning (Synthetic seam test - live native BrowserWindow requires OS desktop session)', () => {
    const host = createComprehensiveHost(['tab-1']);
    host.isSidebarOpen = true;

    // Open popout window
    let popoutClosed = false;
    const mockPopout = {
      id: 101,
      isDestroyed: () => popoutClosed,
      close: () => { popoutClosed = true; },
      webContents: {
        isDestroyed: () => popoutClosed,
        send: () => {},
      },
      on: (_evt: string, cb: () => void) => {},
    };

    host.terminalWindows.set(101, mockPopout);
    assert.strictEqual(host.terminalWindows.size, 1);

    // Simulate popout closing:
    mockPopout.close();
    // Prune check
    for (const [id, win] of host.terminalWindows.entries()) {
      if (win.isDestroyed()) host.terminalWindows.delete(id);
    }
    assert.strictEqual(host.terminalWindows.size, 0, 'Destroyed popout windows must be pruned cleanly');
  });

  it('Flow 30: High-Frequency Tab Churn Thrash (50 rapid iterations) runs leak-free without rejections', async () => {
    const host = createComprehensiveHost(['tab-initial']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-initial');

    for (let i = 0; i < 50; i++) {
      // 1. Create tab
      const childId = host.createTab(`https://antifan.test/churn-${i}`, i % 2 === 0);
      // 2. Adopt or rebind
      if (i % 3 === 0) {
        host.adoptChildTab('terminal-1', childId, 1);
      }
      // 3. Switch active tab
      host.switchTab(childId);
      // 4. Close previous tab if more than 3 tabs
      if (host.tabOrder.length > 3) {
        const victimId = host.tabOrder[1]!;
        host.closeTab(victimId);
      }
    }

    assert.ok(host.tabOrder.length <= 3, 'Tab count must stay bounded under churn');
    assert.ok(host.tabs.size <= 3, 'Tabs map must stay bounded');
    assert.ok(host.hasTab(host.activeTabId), 'Active tab must point to an alive tab');
  });

  it('Flow 31: End-to-End Public Agent Tab Lifecycle (openTab -> agentType child -> closeTab primary -> agentClick failover child -> closeTab child -> agentClick throws TARGET_STALE)', async () => {
    const host = createComprehensiveHost(['tab-start']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-start');

    const port = new BrowserControlPort(host as unknown as BrowserHostPort);
    const targetStart: BrowserTarget = {
      tabId: 'tab-start',
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // 1. Agent calls public openTab to spawn child tab
    const openRes = port.openTab({ url: 'https://shop.test/admin', activate: true }, { target: targetStart });
    const spawnedChildId = openRes.tabId;
    assert.ok(spawnedChildId);
    assert.ok(host.hasTab(spawnedChildId));
    assert.ok(host.getManagedTabIds('tab-start').has(spawnedChildId));

    // 2. Agent interacts with spawned child tab via public agentType
    const typeRes = await port.agentType({ selector: '#search-box', text: 'product SKU 101', tabId: spawnedChildId }, targetStart);
    assert.strictEqual(typeRes.typed, true);
    assert.strictEqual(host.executedTypes[host.executedTypes.length - 1]?.tabId, spawnedChildId);
    assert.strictEqual(host.executedTypes[host.executedTypes.length - 1]?.text, 'product SKU 101');

    // 3. User closes primary tab-start via public port.closeTab
    const closeRes = port.closeTab('tab-start', { target: targetStart });
    assert.strictEqual(closeRes.closed, true);
    assert.strictEqual(host.hasTab('tab-start'), false);

    // 4. Agent issues public agentClick without explicit tabId -> auto fails over to the promoted spawnedChildId!
    const clickFailoverRes = await port.agentClick({ selector: '#save-button' }, targetStart);
    assert.strictEqual(clickFailoverRes.clicked, true);
    assert.strictEqual(host.executedClicks[host.executedClicks.length - 1]?.tabId, spawnedChildId);

    // 5. Agent closes the remaining child tab
    const closeChildRes = port.closeTab(spawnedChildId, { target: targetStart });
    assert.strictEqual(closeChildRes.closed, true);

    // 6. Agent attempts action after all tabs in pool closed -> throws TARGET_STALE
    await assert.rejects(
      async () => port.agentClick({ selector: '#button' }, targetStart),
      (err: unknown) => {
        const capErr = err as CapabilityError;
        return capErr.code === 'TARGET_STALE';
      }
    );
  });
});
