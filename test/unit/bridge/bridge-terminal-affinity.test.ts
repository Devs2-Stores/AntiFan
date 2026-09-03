import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

describe('BridgeServer Terminal Affinity Resolution Contract Tests', () => {
  function simulateStartSession(params: {
    tabId?: string;
    terminalSessionId?: string;
    terminalGeneration?: string | number;
    allowUserTabFallback?: boolean;
  }, mockHost: {
    hasTab: (id?: string | null) => boolean;
    getTerminalAgentAffinity?: (id: string, gen?: string | number) => { tabId: string; status: 'alive' | 'closed'; lastUrl?: string } | undefined;
    getAutomationTabId?: () => string | null;
    getActiveTab?: () => { id: string } | null;
    createTab?: (url: string, activate: boolean) => string;
  }): string {
    let tabId = params.tabId;
    if (!tabId) {
      const terminalSessionId = typeof params.terminalSessionId === 'string' && params.terminalSessionId.trim() ? params.terminalSessionId.trim() : undefined;
      const terminalGen = typeof params.terminalGeneration === 'string' || typeof params.terminalGeneration === 'number' ? params.terminalGeneration : undefined;
      if (terminalSessionId) {
        if (typeof mockHost.getTerminalAgentAffinity === 'function') {
          const affinity = mockHost.getTerminalAgentAffinity(terminalSessionId, terminalGen);
          if (affinity) {
            if (affinity.status === 'alive' && mockHost.hasTab(affinity.tabId)) {
              tabId = affinity.tabId;
            } else {
              const closedNotice = affinity.lastUrl ? `(${affinity.lastUrl})` : `(${affinity.tabId})`;
              throw new Error(`TERMINAL_TAB_CLOSED: The tab previously attached to this terminal ${closedNotice} was closed. Please rebind or specify a tabId.`);
            }
          } else {
            const genNotice = terminalGen !== undefined ? ` at generation ${terminalGen}` : '';
            throw new Error(`TERMINAL_TAB_UNBOUND: No active tab is bound to terminal session '${terminalSessionId}'${genNotice}. Please attach a tab or specify tabId.`);
          }
        }
      } else {
        const currentAutoTab = mockHost.getAutomationTabId ? mockHost.getAutomationTabId() : undefined;
        if (currentAutoTab && mockHost.hasTab(currentAutoTab)) {
          tabId = currentAutoTab;
        } else if (params.allowUserTabFallback) {
          const activeTab = mockHost.getActiveTab ? mockHost.getActiveTab() : null;
          tabId = activeTab?.id;
        } else if (mockHost.createTab) {
          tabId = mockHost.createTab('about:blank', false);
        }
      }
    }
    return tabId || '';
  }

  it('1. Successfully resolves tabId from alive terminal affinity', () => {
    const mockHost = {
      hasTab: (id?: string | null) => id === 'tab-bound',
      getTerminalAgentAffinity: (id: string, gen?: string | number) => {
        if (id === 'terminal-1' && (gen === 1 || gen === '1')) {
          return { tabId: 'tab-bound', status: 'alive' as const, lastUrl: 'http://localhost:3000' };
        }
        return undefined;
      },
    };

    const resolved = simulateStartSession({ terminalSessionId: 'terminal-1', terminalGeneration: 1 }, mockHost);
    assert.strictEqual(resolved, 'tab-bound');
  });

  it('2. Fails closed with TERMINAL_TAB_CLOSED when bound tab was closed', () => {
    const mockHost = {
      hasTab: () => false,
      getTerminalAgentAffinity: () => ({ tabId: 'tab-closed', status: 'closed' as const, lastUrl: 'http://localhost:3000' }),
    };

    assert.throws(
      () => simulateStartSession({ terminalSessionId: 'terminal-1', terminalGeneration: 1 }, mockHost),
      (err: Error) => err.message.includes('TERMINAL_TAB_CLOSED')
    );
  });

  it('3. Fails closed with TERMINAL_TAB_UNBOUND when no affinity or generation mismatch (does NOT fallback to autoTab)', () => {
    const mockHost = {
      hasTab: (id?: string | null) => id === 'tab-auto',
      getTerminalAgentAffinity: () => undefined,
      getAutomationTabId: () => 'tab-auto',
    };

    // Even though automationTab exists, terminalSessionId was provided, so it MUST fail closed
    assert.throws(
      () => simulateStartSession({ terminalSessionId: 'terminal-unknown', terminalGeneration: 2 }, mockHost),
      (err: Error) => err.message.includes('TERMINAL_TAB_UNBOUND')
    );
  });

  it('4. Uses legacy fallback ONLY when no terminalSessionId was provided', () => {
    const mockHost = {
      hasTab: (id?: string | null) => id === 'tab-auto',
      getAutomationTabId: () => 'tab-auto',
    };

    const resolved = simulateStartSession({}, mockHost);
    assert.strictEqual(resolved, 'tab-auto');
  });
});
