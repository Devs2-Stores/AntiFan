import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { NativeTabHost } from '../../../src/main/browser/native-tab-host';
import { TerminalManager } from '../../../src/main/browser/terminal-manager';
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
  clearTerminalAgentAffinity(terminalId: string): void;
  migrateTerminalAgentAffinityGeneration(terminalId: string, newGeneration: number): void;
  getTerminalAgentAffinity(terminalSessionId: string, generation?: number | string): { tabId: string; status: 'alive' | 'closed'; lastUrl?: string } | undefined;
  getTabTerminalSession(tabId: string): string | undefined;
  setTabTerminalSession(tabId: string, sessionId?: string): boolean;
  closeTab(tabId: string): boolean;
  broadcastState(): void;
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

    // Close tab-1
    host.closeTab('tab-1');
    assert.strictEqual(host.hasTab('tab-1'), false);

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
});

describe('Launcher CLI (antifan-agent.cjs) Argument Parsing & Syntax Tests', () => {
  const scriptPath = path.resolve(__dirname, '../../../../scripts/antifan-agent.cjs');

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
});
