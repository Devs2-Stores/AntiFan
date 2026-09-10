import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { CapabilityCatalogue } from '../../../src/main/tools/capability-catalogue';
import { BrowserControlPort, type BrowserHostPort } from '../../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../../src/main/tools/browser-capabilities';
import { issueRuntimeLease, makeControlPlaneId } from '../../../src/shared/control-plane-contracts';
import type { BrowserTarget } from '../../../src/shared/control-plane-contracts';

const AGENT_TAB = { id: 'tab-agent-offscreen', url: 'about:blank', title: 'Agent' };
const USER_STRIP = [
  { id: 'tab-user-a', url: 'https://user-a.test', title: 'User A' },
  { id: 'tab-user-b', url: 'https://user-b.test', title: 'User B' },
];

// The production host adapter (src/main/index.ts) answers a scoped listing from
// NativeTabHost.getSessionTabRecords, whose records include the offscreen/ephemeral
// tabs the user's tab strip never renders. These cases pin both halves of the
// contract: a session sees the tabs it owns during a scoped call, and the window
// listing stays an explicit request.
function makeHost(options: { strip: unknown[]; owned: string[]; sessionRecords?: unknown[] }): BrowserHostPort {
  const host: Record<string, unknown> = {
    getTabList: () => options.strip,
    getManagedTabIds: () => new Set(options.owned),
  };
  if (options.sessionRecords) {
    host.getSessionTabList = () => options.sessionRecords;
  }
  return host as unknown as BrowserHostPort;
}

describe('Tab listing for an attached agent session', () => {
  it('lists the offscreen agent tab the session owns instead of an unexplained empty list', () => {
    const port = new BrowserControlPort(makeHost({
      strip: [USER_STRIP[0]],
      owned: [AGENT_TAB.id],
      sessionRecords: [AGENT_TAB],
    }));
    const target: BrowserTarget = {
      tabId: AGENT_TAB.id,
      documentGeneration: 1,
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      browserEpoch: 1,
    };

    assert.deepStrictEqual(port.listTabs({ target }), [
      { ...AGENT_TAB, isBoundTab: true, isPrimaryTab: true },
    ]);
  });

  it('lists every tab of the window for anti.browser.tabs.list, and the session scope only when asked', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      isTabAllowed: (bound: string, requested: string) => bound === requested,
      resolveTabId: (id: string) => id,
      getDocumentGeneration: () => 1,
    });
    const port = new BrowserControlPort(makeHost({
      strip: USER_STRIP,
      owned: [AGENT_TAB.id],
      sessionRecords: [AGENT_TAB],
    }));
    registerBrowserCapabilities(catalogue, port);

    const target: BrowserTarget = {
      tabId: AGENT_TAB.id,
      documentGeneration: 1,
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      browserEpoch: 1,
    };
    const context = { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target };

    // The tool the agent calls: no flags means "show me this window", never a
    // silently empty list.
    assert.deepStrictEqual(await catalogue.dispatch('anti.browser.tabs.list', { tabId: AGENT_TAB.id }, context), USER_STRIP);
    assert.deepStrictEqual(
      await catalogue.dispatch('anti.browser.tabs.list', { tabId: AGENT_TAB.id, all: false }, context),
      [{ ...AGENT_TAB, isBoundTab: true, isPrimaryTab: true }]
    );

    // The canonical capability keeps its session-scoped default.
    assert.deepStrictEqual(
      await catalogue.dispatch('browser.list-tabs', { tabId: AGENT_TAB.id }, context),
      [{ ...AGENT_TAB, isBoundTab: true, isPrimaryTab: true }]
    );
    assert.deepStrictEqual(
      await catalogue.dispatch('browser.list-tabs', { tabId: AGENT_TAB.id, all: true }, context),
      USER_STRIP
    );
  });
});
