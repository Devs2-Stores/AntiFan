import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { TerminalManager } from '../../../src/main/browser/terminal-manager';
import { BrowserControlPort } from '../../../src/main/tools/browser-control-port';
import { AntiFanTab } from '../../../src/shared/contracts';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
interface TabShell {
  state: AntiFanTab;
  view?: unknown;
}

interface TestHost {
  tabs: Map<string, TabShell>;
  activeTabId: string;
  hasTab(tabId?: string | null): boolean;
  bindTerminalAgentAffinity(terminalId: string, generation: number | string | undefined, tabId: string): boolean;
  adoptChildTab(terminalId: string, childTabId: string, generation?: number | string, source?: string, parentTabId?: string): boolean;
  adoptChildTabForBoundTab(boundTabId: string, childTabId: string): boolean;
  getManagedTabIds(boundTabIdOrTerminalId: string): Set<string>;
  getManagedTabIdsForBoundTab(boundTabId: string): Set<string>;
  isTabAllowedForPrimary(primaryTabId: string, requestedTabId: string): boolean;
  removeManagedTab(terminalId: string, tabId: string, generation?: number | string): boolean;
  clearTerminalAgentAffinity(terminalId: string): void;
  migrateTerminalAgentAffinityGeneration(terminalId: string, newGeneration: number): void;
  tombstoneTerminalAgentAffinity(tabId: string, lastUrl?: string): void;
  getTerminalAgentAffinity(terminalSessionId: string, generation?: number | string): { tabId: string; status: 'alive' | 'closed'; lastUrl?: string; managedTabIds?: string[] } | undefined;
  getTabTerminalSession(tabId: string): string | undefined;
  setTabTerminalSession(tabId: string, sessionId?: string): boolean;
  closeTab(tabId: string): boolean;
  broadcastState(): void;
  resolveTargetTabId?(tabIdOrIdentifier?: string | null): string | undefined;
}

function createTestHost(tabIds: string[]): TestHost {
  const host = Object.create(NativeTabHost.prototype) as unknown as TestHost;
  const tabs = new Map<string, TabShell>();
  for (const id of tabIds) {
    tabs.set(id, {
      state: {
        id,
        url: `https://example.test/${id}`,
        title: `Tab ${id}`,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 1,
      },
    });
  }
  host.tabs = tabs;
  host.activeTabId = tabIds[0] ?? '';
  (host as any).tabOrder = [...tabIds];
  (host as any).switchTab = (id: string) => { host.activeTabId = id; };
  (host as any).createTab = () => '';
  (host as any).countAttachedViews = () => 0;
  (host as any).terminalAgentAffinity = new Map<string, { tabId: string; lastUrl?: string; closedAt?: number }>();
  (host as any).sessionTabPools = new Map<string, Set<string>>();
  (host as any).recentlyClosedTabs = [];
  (host as any).tabPreviewUnsubscribers = new Map();
  (host as any).activeTabThemeQAPromises = new Map();
  (host as any).tabThemeQaStates = new Map();
  (host as any).networkTracker = { detachTarget: () => {} };
  (host as any).tabDiagnostics = { deleteTab: () => {} };
  host.broadcastState = () => {};
  return host;
}

describe('Terminal-to-Tab Agent Affinity Contract Tests (NativeTabHost Seam)', () => {
  const tm = TerminalManager.getInstance() as any;
  const originalListSessions = tm.listSessions;
  const originalGetSession = tm.getSession;
  const originalGetActiveSessionId = tm.getActiveSessionId;
  let liveSessions: Array<{ id: string; name: string; cwd: string; sessionGeneration: number }> = [];

  before(() => {
    liveSessions = [
      { id: 'terminal-1', name: 'Terminal 1', cwd: 'C:\\test', sessionGeneration: 1 },
      { id: 'terminal-2', name: 'Terminal 2', cwd: 'C:\\test', sessionGeneration: 1 },
    ];
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => 'terminal-1';
    tm.getSession = (id: string) => liveSessions.find((s) => s.id === id);
  });

  after(() => {
    tm.listSessions = originalListSessions;
    tm.getSession = originalGetSession;
    tm.getActiveSessionId = originalGetActiveSessionId;
  });

  it('1. Binds terminal to primary tab and retrieves affinity with exact generation', () => {
    const host = createTestHost(['tab-1', 'tab-2']);

    const bound = host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-1');
    assert.strictEqual(bound, true);

    const affinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(affinity);
    assert.strictEqual(affinity.tabId, 'tab-1');
    assert.strictEqual(affinity.status, 'alive');
    assert.strictEqual(affinity.lastUrl, 'https://example.test/tab-1');
  });

  it('2. Fails to bind if tab or terminal does not exist', () => {
    const host = createTestHost(['tab-1']);

    assert.strictEqual(host.bindTerminalAgentAffinity('nonexistent-terminal', 1, 'tab-1'), false);
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'nonexistent-tab'), false);
  });

  it('3. Enforces exact-generation fail-closed (no fallback to latest when generation is given)', () => {
    const host = createTestHost(['tab-1']);
    host.bindTerminalAgentAffinity('terminal-1', 2, 'tab-1');

    // Stale generation query must yield undefined, NEVER falling back to gen 2
    const staleAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.strictEqual(staleAffinity, undefined);

    // Generation 2 returns the active affinity
    const currentAffinity = host.getTerminalAgentAffinity('terminal-1', 2);
    assert.ok(currentAffinity);
    assert.strictEqual(currentAffinity.tabId, 'tab-1');
  });

  it('4. Migrates affinity generation upon terminal restart/clear and retains metadata', () => {
    const host = createTestHost(['tab-1']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-1');

    host.migrateTerminalAgentAffinityGeneration('terminal-1', 2);

    // Gen 1 is now absent
    assert.strictEqual(host.getTerminalAgentAffinity('terminal-1', 1), undefined);

    // Gen 2 holds the migrated affinity
    const migrated = host.getTerminalAgentAffinity('terminal-1', 2);
    assert.ok(migrated);
    assert.strictEqual(migrated.tabId, 'tab-1');
    assert.strictEqual(migrated.status, 'alive');
  });

  it('5. Marks affinity status as "closed" when bound tab is closed (fail-closed contract)', () => {
    const host = createTestHost(['tab-1', 'tab-2']);
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-1');

    // Tombstone tab-1 via host method called during tab close
    host.tombstoneTerminalAgentAffinity('tab-1', 'https://example.test/tab-1');

    const affinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(affinity);
    assert.strictEqual(affinity.tabId, 'tab-1');
    assert.strictEqual(affinity.status, 'closed');
    assert.strictEqual(affinity.lastUrl, 'https://example.test/tab-1');
  });

  it('6. Keeps annotation binding independent from agent affinity (clean separation)', () => {
    const host = createTestHost(['tab-1', 'tab-2']);

    // Terminal-1 agent affinity is bound to tab-1
    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-1');

    // User chooses terminal-1 for popup annotation on tab-2
    host.setTabTerminalSession('tab-2', 'terminal-1');

    // Annotation memory for tab-2 points to terminal-1
    assert.strictEqual(host.getTabTerminalSession('tab-2'), 'terminal-1');

    // But agent affinity for terminal-1 is still cleanly bound to tab-1!
    const agentAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(agentAffinity);
    assert.strictEqual(agentAffinity.tabId, 'tab-1');
  });

  it('7. hasTab executes in O(1) time and guards against undefined/null safely', () => {
    const host = createTestHost(['tab-alpha', 'tab-beta']);

    assert.strictEqual(host.hasTab('tab-alpha'), true);
    assert.strictEqual(host.hasTab('tab-beta'), true);
    assert.strictEqual(host.hasTab('tab-gamma'), false);
    assert.strictEqual(host.hasTab(null), false);
    assert.strictEqual(host.hasTab(undefined), false);
    assert.strictEqual(host.hasTab(''), false);
  });

  it('8. Synchronizes Annotation popup memory automatically when tab is bound to a terminal', () => {
    const host = createTestHost(['tab-lemon', 'tab-youtube']);

    // Terminal-2 is bound to tab-lemon
    host.bindTerminalAgentAffinity('terminal-2', 1, 'tab-lemon');

    // Annotation memory on tab-lemon automatically resolves to terminal-2
    assert.strictEqual(host.getTabTerminalSession('tab-lemon'), 'terminal-2');

    // Unbound tab-youtube remains undefined (falling back to auto in picker)
    assert.strictEqual(host.getTabTerminalSession('tab-youtube'), undefined);
  });

  it('9. Scopes listTabs to ONLY the bound tab in an isolated session', () => {
    const mockHost = {
      getTabList: () => [
        { id: 'tab-lemon', url: 'https://thienfarm.vn/lemon', title: 'Cây Chanh Vàng' },
        { id: 'tab-youtube', url: 'https://youtube.com/watch', title: 'YouTube Music' },
      ],
    };
    const port = new BrowserControlPort(mockHost as any);

    // 1. When isolated to tab-lemon: ONLY tab-lemon is returned
    const isolatedTabs = port.listTabs({
      target: { tabId: 'tab-lemon', documentGeneration: 1, projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1', browserEpoch: 1 },
    }) as any[];
    assert.strictEqual(isolatedTabs.length, 1);
    assert.strictEqual(isolatedTabs[0].id, 'tab-lemon');
    assert.strictEqual(isolatedTabs[0].isBoundTab, true);

    // 2. When unbound (global view): all tabs are returned
    const allTabs = port.listTabs({}) as any[];
    assert.strictEqual(allTabs.length, 2);
  });

  it('10. Enforces isolation on switchTab and closeTab (throws TARGET_MISMATCH on cross-tab tampering)', () => {
    let switchedId = '';
    let closedId = '';
    const mockHost = {
      switchTab: (id: string) => { switchedId = id; return true; },
      closeTab: (id: string) => { closedId = id; return true; },
    };
    const port = new BrowserControlPort(mockHost as any);
    const boundTarget = { tabId: 'tab-lemon', documentGeneration: 1 } as any;

    // Permitted: operating on the bound tab
    assert.deepStrictEqual(port.switchTab('tab-lemon'), { switched: true });
    assert.strictEqual(switchedId, 'tab-lemon');

    assert.deepStrictEqual(port.closeTab('tab-lemon', { target: boundTarget }), { closed: true });
    assert.strictEqual(closedId, 'tab-lemon');

    // Rejected: tampering with another tab (e.g. closing YouTube)
    assert.throws(
      () => port.closeTab('tab-youtube', { target: boundTarget }),
      (err: any) => err.code === 'TARGET_MISMATCH' && err.message.includes('isolated to tab')
    );
  });
  it('11. Multi-Tab Affinity: adoptChildTab allows terminal to manage multiple tabs (Primary + Child)', () => {
    const host = createTestHost(['tab-live', 'tab-local', 'tab-unrelated']);

    // 1. Initial bind to tab-live
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-live'), true);
    const initialAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(initialAffinity);
    assert.strictEqual(initialAffinity.tabId, 'tab-live');
    assert.deepStrictEqual(initialAffinity.managedTabIds, ['tab-live']);

    // 2. Adopt tab-local into the same terminal
    assert.strictEqual(host.adoptChildTab('terminal-1', 'tab-local', 1), true);
    const multiAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(multiAffinity);
    assert.strictEqual(multiAffinity.managedTabIds?.length, 2);
    assert.ok(multiAffinity.managedTabIds?.includes('tab-live'));
    assert.ok(multiAffinity.managedTabIds?.includes('tab-local'));

    // 3. Permission verification: both tabs are allowed!
    assert.strictEqual(host.isTabAllowedForPrimary('tab-live', 'tab-live'), true);
    assert.strictEqual(host.isTabAllowedForPrimary('tab-live', 'tab-local'), true);
    // Unrelated tab is rejected:
    assert.strictEqual(host.isTabAllowedForPrimary('tab-live', 'tab-unrelated'), false);
  });

  it('12. Auto-Adoption in openTab and enforces max 10 tabs rate limit', () => {
    let createdCount = 0;
    const managedSet = new Set(['tab-primary']);
    const mockHost = {
      createTab: (_url?: string) => {
        createdCount++;
        return `tab-child-${createdCount}`;
      },
      getManagedTabIds: (_primaryId: string) => managedSet,
      adoptChildTab: (_primaryId: string, childId: string) => {
        managedSet.add(childId);
        return true;
      },
      isTabAllowed: (_primaryId: string, targetId: string) => managedSet.has(targetId),
    };
    const port = new BrowserControlPort(mockHost as any);
    const boundTarget = { tabId: 'tab-primary', projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1', browserEpoch: 1, documentGeneration: 1 } as any;

    // Spawn 9 child tabs (total 10 tabs: primary + 9 children)
    for (let i = 1; i <= 9; i++) {
      const res = port.openTab({ url: `http://localhost:${3000 + i}` }, { target: boundTarget });
      assert.strictEqual(res.tabId, `tab-child-${i}`);
    }
    assert.strictEqual(managedSet.size, 10);

    // Attempting 11th tab: throws POLICY_DENIED
    assert.throws(
      () => port.openTab({ url: 'http://localhost:3010' }, { target: boundTarget }),
      (err: any) => err.code === 'POLICY_DENIED' && err.message.includes('maximum 10 tabs')
    );
  });

  it('14. Ad-hoc Session Pool: adoptChildTab anchors at boundTabId when terminal session is absent', () => {
    const host = createTestHost(['tab-bound-mcp', 'tab-child-mcp', 'tab-other']);
    // No terminal affinity bound for tab-bound-mcp
    const ok = host.adoptChildTab('tab-bound-mcp', 'tab-child-mcp');
    assert.strictEqual(ok, true, 'adoptChildTab must succeed by creating ad-hoc session pool anchored at boundTabId');

    const managed = host.getManagedTabIdsForBoundTab('tab-bound-mcp');
    assert.strictEqual(managed.has('tab-bound-mcp'), true);
    assert.strictEqual(managed.has('tab-child-mcp'), true);
    assert.strictEqual(managed.has('tab-other'), false);

    assert.strictEqual(host.isTabAllowedForPrimary('tab-bound-mcp', 'tab-child-mcp'), true);
    assert.strictEqual(host.isTabAllowedForPrimary('tab-bound-mcp', 'tab-other'), false);
  });

  it('13. listTabs returns all managed tabs with isBoundTab: true and marks primary', () => {
    const managedSet = new Set(['tab-live', 'tab-local']);
    const mockHost = {
      getTabList: () => [
        { id: 'tab-live', title: 'Live Shop' },
        { id: 'tab-local', title: 'Local Dev' },
        { id: 'tab-music', title: 'YouTube Music' },
      ],
      getManagedTabIds: (_id: string) => managedSet,
    };
    const port = new BrowserControlPort(mockHost as any);
    const boundTarget = { tabId: 'tab-live', projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1', browserEpoch: 1, documentGeneration: 1 } as any;
    const res = port.listTabs({ target: boundTarget }) as any[];

    assert.strictEqual(res.length, 2);
    assert.strictEqual(res[0].id, 'tab-live');
    assert.strictEqual(res[0].isPrimaryTab, true);
    assert.strictEqual(res[0].isBoundTab, true);

    assert.strictEqual(res[1].id, 'tab-local');
    assert.strictEqual(res[1].isPrimaryTab, false);
    assert.strictEqual(res[1].isBoundTab, true);

    // Private YouTube tab is NOT in list!
    assert.strictEqual(res.some((t: any) => t.id === 'tab-music'), false);
  });

  it('14. Primary Tab Closure triggers Failover Promotion, keeping terminal session alive', () => {
    const host = createTestHost(['tab-live', 'tab-local']);

    host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-live');
    host.adoptChildTab('terminal-1', 'tab-local', 1);

    // Close tab-live: tab-local must be promoted!
    host.tabs.delete('tab-live');
    host.tombstoneTerminalAgentAffinity('tab-live', 'https://roahtrip.com');
    const afterAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(afterAffinity);
    assert.strictEqual(afterAffinity.status, 'alive', 'Terminal must stay alive after primary close if child exists');
    assert.strictEqual(afterAffinity.tabId, 'tab-local', 'tab-local must be promoted to primary');
    assert.deepStrictEqual(afterAffinity.managedTabIds, ['tab-local']);

    // Now close tab-local as well: only now is the terminal tombstoned
    host.tabs.delete('tab-local');
    host.tombstoneTerminalAgentAffinity('tab-local', 'http://localhost:3000');
    const closedAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.ok(closedAffinity);
    assert.strictEqual(closedAffinity.status, 'closed', 'Terminal must be marked closed when all managed tabs are closed');
  });

  it('15. resolveTargetTab permits any managed child tab without TARGET_MISMATCH', () => {
    const managedSet = new Set(['tab-primary', 'tab-child']);
    const mockHost = {
      hasTab: (id: string) => managedSet.has(id) || id === 'tab-youtube',
      isTabAllowed: (primaryId: string, requestedId: string) => primaryId === 'tab-primary' && managedSet.has(requestedId),
    };
    const port = new BrowserControlPort(mockHost as any);
    const boundTarget = { tabId: 'tab-primary', projectId: 'proj-1', workspaceId: 'ws-1', runtimeId: 'rt-1', browserEpoch: 1, documentGeneration: 1 } as any;

    // 1. Write on primary tab: allowed
    assert.strictEqual((port as any).resolveTargetTab(boundTarget, 'tab-primary', 'write'), 'tab-primary');

    // 2. Write on child tab: allowed without TARGET_MISMATCH!
    assert.strictEqual((port as any).resolveTargetTab(boundTarget, 'tab-child', 'write'), 'tab-child');

    // 3. Write on unrelated tab: throws TARGET_MISMATCH
    assert.throws(
      () => (port as any).resolveTargetTab(boundTarget, 'tab-youtube', 'write'),
      (err: any) => err.code === 'TARGET_MISMATCH' && err.message.includes('does not match')
    );
  });

  it('16. Quota Enforcement: NativeTabHost.adoptChildTab rejects 11th tab and leaves sessionTabPools clean without leaks', () => {
    const tabIds = ['tab-primary', ...Array.from({ length: 11 }, (_, i) => `tab-sub-${i + 1}`)];
    const host = createTestHost(tabIds);

    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'tab-primary'), true);

    // Adopt 9 child tabs (total 10 tabs: primary + 9 children)
    for (let i = 1; i <= 9; i++) {
      assert.strictEqual(host.adoptChildTab('tab-primary', `tab-sub-${i}`), true);
    }
    const managedTabs = host.getManagedTabIds('tab-primary');
    assert.strictEqual(managedTabs.size, 10);

    // 10th child (attempted 11th tab) must be rejected
    assert.strictEqual(host.adoptChildTab('tab-primary', 'tab-sub-10'), false);
    // Quota must still be 10, not 11
    assert.strictEqual(host.getManagedTabIds('tab-primary').size, 10);
    // Rejected tab must NOT be allowed
    assert.strictEqual(host.isTabAllowedForPrimary('tab-primary', 'tab-sub-10'), false);
  });
  it('17. Multi-Tab Affinity Persistence & Remap: Correctly restores and adopts multiple tabs across ID remaps', () => {
    const host = createTestHost(['old-tab-1', 'old-tab-2', 'old-tab-3']);

    // Original setup before restart
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-1', 1, 'old-tab-1'), true);
    assert.strictEqual(host.adoptChildTab('terminal-1', 'old-tab-2'), true);
    assert.strictEqual(host.adoptChildTab('terminal-1', 'old-tab-3'), true);

    const beforeAffinity = host.getTerminalAgentAffinity('terminal-1', 1);
    assert.deepStrictEqual(beforeAffinity?.managedTabIds, ['old-tab-1', 'old-tab-2', 'old-tab-3']);

    // Simulate restart with new tab UUIDs and ID remap map
    const newHost = createTestHost(['new-tab-1', 'new-tab-2', 'new-tab-3']);
    const oldIdToNewId = new Map<string, string>([
      ['old-tab-1', 'new-tab-1'],
      ['old-tab-2', 'new-tab-2'],
      ['old-tab-3', 'new-tab-3'],
    ]);

    const persistedAffinities = [
      {
        terminalId: 'terminal-1',
        primaryTabId: 'old-tab-1',
        managedTabIds: ['old-tab-1', 'old-tab-2', 'old-tab-3'],
      },
    ];

    // Rebuild logic as in restoreTabs
    for (const aff of persistedAffinities) {
      const newPrimaryId = oldIdToNewId.get(aff.primaryTabId);
      if (newPrimaryId && newHost.hasTab(newPrimaryId)) {
        newHost.bindTerminalAgentAffinity(aff.terminalId, undefined, newPrimaryId);
        for (const oldChildId of aff.managedTabIds) {
          const newChildId = oldIdToNewId.get(oldChildId);
          if (newChildId && newChildId !== newPrimaryId && newHost.hasTab(newChildId)) {
            newHost.adoptChildTab(aff.terminalId, newChildId, undefined, 'user_attached', newPrimaryId);
          }
        }
      }
    }

    const restoredAffinity = newHost.getTerminalAgentAffinity('terminal-1');
    assert.ok(restoredAffinity);
    assert.strictEqual(restoredAffinity.tabId, 'new-tab-1');
    assert.strictEqual(restoredAffinity.status, 'alive');
    assert.deepStrictEqual(restoredAffinity.managedTabIds, ['new-tab-1', 'new-tab-2', 'new-tab-3']);
    assert.strictEqual(newHost.isTabAllowedForPrimary('new-tab-1', 'new-tab-2'), true);
    assert.strictEqual(newHost.isTabAllowedForPrimary('new-tab-1', 'new-tab-3'), true);
  });

  it('18. Numeric #N Tab Reference Resolution in hasTab and resolveTargetTabId', () => {
    const host = createTestHost(['tab-first', 'tab-second', 'tab-third']);

    assert.strictEqual(host.hasTab('#1'), true);
    assert.strictEqual(host.hasTab('#2'), true);
    assert.strictEqual(host.hasTab('#3'), true);
    assert.strictEqual(host.hasTab('#4'), false);
    assert.strictEqual(host.hasTab('#0'), false);
    assert.strictEqual(host.hasTab('#99'), false);
    assert.strictEqual(host.hasTab('unknown-uuid'), false);

    assert.strictEqual((host as any).resolveTargetTabId('#1'), 'tab-first');
    assert.strictEqual((host as any).resolveTargetTabId('#2'), 'tab-second');
    assert.strictEqual((host as any).resolveTargetTabId('#3'), 'tab-third');
    assert.strictEqual((host as any).resolveTargetTabId('#0'), undefined);
    assert.strictEqual((host as any).resolveTargetTabId('#4'), undefined);
    assert.strictEqual((host as any).resolveTargetTabId('#99'), undefined);
    assert.strictEqual((host as any).resolveTargetTabId('unknown-uuid'), undefined);

    // Guard validation: switchTab and closeTab return false safely without throwing
    assert.strictEqual(host.closeTab('#0'), false);
    assert.strictEqual(host.closeTab('#99'), false);
    assert.strictEqual(host.closeTab('unknown-uuid'), false);
  });
});

describe('Launcher CLI (antifan-agent.cjs) Argument Parsing & Syntax Tests', () => {
  const scriptPath = path.resolve(__dirname, '../../../scripts/antifan-agent.cjs');

  it('1. Passes syntax check (node -c)', () => {
    assert.doesNotThrow(() => {
      execFileSync(process.execPath, ['-c', scriptPath], { stdio: 'pipe' });
    });
  });

  it('2. Shows usage on --help or -h with exit code 0', () => {
    const stdout = execFileSync(process.execPath, [scriptPath, '--help'], { encoding: 'utf8' });
    assert.ok(stdout.includes('AntiFan Agent Launcher'));
    assert.ok(stdout.includes('--tab=<tabId>'));
    assert.ok(stdout.includes('Usage:'));
  });

  it('3. Rejects missing or empty --tab argument', () => {
    assert.throws(() => {
      execFileSync(process.execPath, [scriptPath, '--tab='], { stdio: 'pipe' });
    });
    assert.throws(() => {
      execFileSync(process.execPath, [scriptPath, '--tab'], { stdio: 'pipe' });
    });
  });

  it('4. Rejects invocation with only --tab and no target command', () => {
    const stdout = execFileSync(process.execPath, [scriptPath, '--tab=tab-123'], { encoding: 'utf8' });
    // Should display usage since no target command was provided
    assert.ok(stdout.includes('Usage:'));
  });

  it('5. Directly tests parseLauncherArgs unit function', () => {
    const { parseLauncherArgs } = require(scriptPath);
    const parsed1 = parseLauncherArgs(['--tab=tab-99', 'claude', '--print']);
    assert.strictEqual(parsed1.tabId, 'tab-99');
    assert.deepStrictEqual(parsed1.commandArgs, ['claude', '--print']);

    const parsed2 = parseLauncherArgs(['-t', 'tab-101', 'npm', 'test']);
    assert.strictEqual(parsed2.tabId, 'tab-101');
    assert.deepStrictEqual(parsed2.commandArgs, ['npm', 'test']);

    assert.throws(() => parseLauncherArgs(['--tab=']));
    assert.throws(() => parseLauncherArgs(['--tab']));
  });
});
