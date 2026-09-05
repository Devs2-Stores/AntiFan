import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { TerminalManager } from '../../src/main/browser/terminal-manager';
import {
  makeControlPlaneId,
  issueRuntimeLease,
  BrowserTarget,
} from '../../src/shared/control-plane-contracts';

describe('Full-Stack E2E Integration: OMP / MCP Multi-Tab Affinity, Lineage & Failover', () => {
  const tm = TerminalManager.getInstance() as any;
  const originalListSessions = tm.listSessions;
  const originalGetSession = tm.getSession;
  const originalGetActiveSessionId = tm.getActiveSessionId;

  let liveSessions: Array<{ id: string; name: string; cwd: string; sessionGeneration: number }> = [];

  before(() => {
    liveSessions = [
      { id: 'terminal-e2e', name: 'Terminal E2E', cwd: 'C:\\test', sessionGeneration: 1 },
    ];
    tm.listSessions = () => liveSessions;
    tm.getActiveSessionId = () => 'terminal-e2e';
    tm.getSession = (id: string) => liveSessions.find((s) => s.id === id);
  });

  after(() => {
    tm.listSessions = originalListSessions;
    tm.getSession = originalGetSession;
    tm.getActiveSessionId = originalGetActiveSessionId;
  });

  it('verifies OMP -> MCP -> ControlPlane -> Affinity lifecycle (A/B/C ✅ vs D ❌) with Failover and Lineage Proof', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    // 1. Setup Mock Host that delegates affinity and tab logic to NativeTabHost seam
    const host = Object.create(NativeTabHost.prototype) as unknown as any;
    host.tabs = new Map<string, any>();
    host.terminalAgentAffinity = new Map();
    host.sessionTabPools = new Map();
    host.targetOperationQueues = new Map();
    host.mutationRevisions = new Map();
    host.broadcastState = () => {};

    // Helper to add tabs to mock host
    function registerTab(id: string, url: string, title: string) {
      const mockWc = {
        executeJavaScript: async () => true,
        isDestroyed: () => false,
      };
      host.tabs.set(id, {
        id,
        state: { url, title, terminalSessionId: undefined },
        activePaneId: 'desktop',
        view: { webContents: mockWc },
        desktopView: { webContents: mockWc },
      });
    }

    registerTab('tab-a', 'https://live-shop.com', 'Live Shop (Storefront A)');

    // Bind Terminal E2E to Tab A
    assert.strictEqual(host.bindTerminalAgentAffinity('terminal-e2e', 1, 'tab-a'), true);

    // Host port implementation for browser automation tools
    const interactiveActions: string[] = [];
    host.getTabList = () => Array.from(host.tabs.values()).map((t: any) => ({ id: t.id, url: t.state.url, title: t.state.title }));
    host.getActiveTabId = () => 'tab-a';
    host.getAutomationTabId = () => 'tab-a';
    host.getDocumentGeneration = (_id?: string) => 1;
    host.isCurrentTarget = () => true;
    host.documentGenerations = new Map();
    host.semanticDocumentGenerations = new Map();
    host.createTab = (url?: string) => {
      const newId = `tab-spawned-${host.tabs.size + 1}`;
      registerTab(newId, url || 'about:blank', `Spawned Tab ${newId}`);
      return newId;
    };
    host.closeTab = (id: string) => {
      host.tabs.delete(id);
      host.tombstoneTerminalAgentAffinity(id);
      return true;
    };
    host.switchTab = (id: string) => host.tabs.has(id);
    host.getDom = async (_sel?: string, tabId?: string) => `<html><body>DOM for ${tabId}</body></html>`;
    host.captureScreenshot = async (_rect?: unknown, tabId?: string) => Buffer.from(`screenshot:${tabId}`).toString('base64');
    host.agentClick = async (params: { selector?: string; tabId?: string }) => {
      interactiveActions.push(`click:${params.tabId}:${params.selector}`);
      return true;
    };
    host.evalJs = async (expr: string, tabId?: string) => ({ eval: expr, tabId });
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      getActiveLease: () => lease,
      isTabAllowed: (primaryId, targetId) => host.isTabAllowed(primaryId, targetId),
      resolveTabId: (id) => (host.tabs.has(id) ? id : host.resolveTargetTabId?.(id)),
      getDocumentGeneration: () => 1,
    });

    const browserPort = new BrowserControlPort(host as unknown as BrowserHostPort);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => 1,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);

    // Issue initial attachment bound to Tab A
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-a',
      documentGeneration: 1,
      grant: 'write',
    });

    const boundTarget: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      browserEpoch: 1,
      documentGeneration: 1,
      tabId: 'tab-a',
    };

    const mcpServer = new AntiFanMcpServer(host as unknown as NativeTabHost, true, transport, {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });
    // -------------------------------------------------------------
    // Step 2: Agent calls anti.browser.tabs.create -> spawns Tab B (Child)
    // -------------------------------------------------------------
    const createBRes = await mcpServer.callTool('anti.browser.tabs.create', { url: 'http://localhost:3000/local-dev' });
    assert.strictEqual(createBRes.isError, undefined);
    const createBData = JSON.parse(createBRes.content[0]?.text || '{}');
    const tabBId = createBData.data?.tabId || createBData.tabId;
    assert.ok(tabBId, `Tab B ID must be returned in response: ${createBRes.content[0]?.text}`);

    // Check Parent Proof Lineage for Tab B
    const lineageB = host.getTabLineage(tabBId);
    assert.ok(lineageB, 'Tab B must possess lineage record');
    assert.strictEqual(lineageB.parentTabId, 'tab-a', 'Parent of Tab B must be Tab A');
    assert.strictEqual(lineageB.source, 'agent_spawned');

    // -------------------------------------------------------------
    // Step 3: Agent calls anti.browser.tabs.create again -> spawns Tab C (Child)
    // -------------------------------------------------------------
    const createCRes = await mcpServer.callTool('anti.browser.tabs.create', { url: 'http://localhost:3000/local-cart' });
    assert.strictEqual(createCRes.isError, undefined);
    const createCData = JSON.parse(createCRes.content[0]?.text || '{}');
    const tabCId = createCData.data?.tabId || createCData.tabId;
    assert.ok(tabCId, `Tab C ID must be returned in response: ${createCRes.content[0]?.text}`);

    const lineageC = host.getTabLineage(tabCId);
    assert.ok(lineageC);
    assert.strictEqual(lineageC.parentTabId, tabBId, 'Tab C was spawned while Tab B was active target, so parent is Tab B');
    assert.strictEqual(lineageC.source, 'agent_spawned');

    const affinityAll = host.getTerminalAgentAffinity('terminal-e2e', 1);
    assert.ok(affinityAll);
    assert.deepStrictEqual(
      Array.from(affinityAll.managedTabIds).sort(),
      ['tab-a', tabBId, tabCId].sort(),
      'All three tabs A, B, C must be in terminal-e2e managedTabIds'
    );
    // -------------------------------------------------------------
    // Step 4: Standalone Tab D (unrelated user tab, e.g. YouTube)
    // -------------------------------------------------------------
    registerTab('tab-d', 'https://youtube.com', 'YouTube Music (Private User Tab)');
    // Assert Tab D has NO lineage and is NOT in managed tabs of Tab A
    assert.strictEqual(host.getTabLineage('tab-d'), undefined);
    assert.strictEqual(host.isTabAllowed('tab-a', 'tab-d'), false);

    // -------------------------------------------------------------
    // Step 5: Execute tools on Tab A, Tab B, Tab C (All must succeed)
    // -------------------------------------------------------------
    // Tool on Tab A (Primary)
    const domARes = await mcpServer.callTool('anti.inspect.dom', { tabId: 'tab-a' });
    assert.strictEqual(domARes.isError, undefined, `domARes failed: ${domARes.content[0]?.text}`);
    assert.ok(domARes.content[0]?.text?.includes('DOM for tab-a'));

    // Tool on Tab B (Child)
    const clickBRes = await mcpServer.callTool('anti.agent.cursor.click', { tabId: tabBId, selector: '#checkout' });
    assert.strictEqual(clickBRes.isError, undefined, `clickBRes failed: ${clickBRes.content[0]?.text}`);
    assert.ok(interactiveActions.includes(`click:${tabBId}:#checkout`));

    // Tool on Tab C (Child)
    const shotCRes = await mcpServer.callTool('anti.screenshot.viewport', { tabId: tabCId });
    assert.strictEqual(shotCRes.isError, undefined, `shotCRes failed: ${shotCRes.content[0]?.text}`);

    // -------------------------------------------------------------
    // Step 6: Adversarial Check on Tab D (Must throw TARGET_MISMATCH)
    // -------------------------------------------------------------
    const domDRes = await mcpServer.callTool('anti.inspect.dom', { tabId: 'tab-d' });
    assert.strictEqual(domDRes.isError, true);
    assert.ok(domDRes.content[0]?.text?.includes('TARGET_MISMATCH'), 'Tampering with Tab D must be rejected with TARGET_MISMATCH');

    const clickDRes = await mcpServer.callTool('anti.agent.cursor.click', { tabId: 'tab-d', selector: '#skip-ad' });
    assert.strictEqual(clickDRes.isError, true);
    assert.ok(clickDRes.content[0]?.text?.includes('TARGET_MISMATCH'));

    // -------------------------------------------------------------
    // Step 7: Scoped Evidence in Behavior Verification (traceInteraction)
    // -------------------------------------------------------------
    const traceRes = await browserPort.traceInteraction(
      boundTarget,
      runId,
      attemptId,
      { action: 'click', selector: '.add-to-cart', tabId: tabBId }
    );
    assert.strictEqual(traceRes.tabId, tabBId, 'Evidence must be strictly tagged with target tabId');
    assert.strictEqual(traceRes.role, 'managed_child');
    assert.strictEqual(traceRes.isPrimaryTab, false);

    // -------------------------------------------------------------
    // Step 8: Dynamic Failover on Tab Closure
    // -------------------------------------------------------------
    // Close active target Tab C
    const closeCRes = await mcpServer.callTool('antifan_close_tab', { tabId: tabCId });
    assert.strictEqual(closeCRes.isError, undefined);

    // Session target was Tab C (now dead). Default call must dynamically fail over to Tab A!
    const failoverToARes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(failoverToARes.isError, undefined, `Dynamic failover failed: ${failoverToARes.content[0]?.text}`);
    assert.ok(failoverToARes.content[0]?.text?.includes('DOM for tab-a'), 'Default call must dynamically fail over to primary tab A');

    // Now close Tab A
    const closeARes = await mcpServer.callTool('antifan_close_tab', { tabId: 'tab-a' });
    assert.strictEqual(closeARes.isError, undefined);

    // Assert NativeTabHost promoted Tab B to Primary
    const affinityAfterA = host.getTerminalAgentAffinity('terminal-e2e', 1);
    assert.ok(affinityAfterA);
    assert.strictEqual(affinityAfterA.status, 'alive', 'Terminal must stay alive after primary close if Tab B exists');
    assert.strictEqual(affinityAfterA.primaryTabId, tabBId, 'Tab B must be promoted to primary');

    // Default call must now dynamically fail over to Tab B!
    const failoverToBRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(failoverToBRes.isError, undefined, `Dynamic failover to B failed: ${failoverToBRes.content[0]?.text}`);
    assert.ok(failoverToBRes.content[0]?.text?.includes(`DOM for ${tabBId}`), 'Default call must dynamically resolve to promoted primary tab B');

    // -------------------------------------------------------------
    // Step 9: Final tombstone when all remaining tabs close
    // -------------------------------------------------------------
    await mcpServer.callTool('antifan_close_tab', { tabId: tabBId });
    const finalAffinity = host.getTerminalAgentAffinity('terminal-e2e', 1);
    assert.ok(finalAffinity);
    assert.strictEqual(finalAffinity.status, 'closed', 'Terminal must be marked closed once all managed tabs are closed');
  });

  it('verifies native_window_open automatically adopts popup tab into caller terminal affinity', async () => {
    const host = Object.create(NativeTabHost.prototype) as unknown as any;
    host.tabs = new Map<string, any>();
    host.terminalAgentAffinity = new Map();
    host.sessionTabPools = new Map();
    host.broadcastState = () => {};

    function registerTab(id: string, url: string) {
      host.tabs.set(id, {
        id,
        state: { url, title: id, terminalSessionId: undefined },
      });
    }

    registerTab('tab-parent', 'https://storefront.com');
    host.bindTerminalAgentAffinity('terminal-e2e', 1, 'tab-parent');

    host.createTab = (url?: string) => {
      const newId = `tab-popup-${host.tabs.size + 1}`;
      registerTab(newId, url || 'about:blank');
      return newId;
    };

    // Simulate popup creation through adoptChildTab with native_window_open
    const popupId = host.createTab('https://checkout.vnpay.vn');
    const adopted = host.adoptChildTab('tab-parent', popupId, undefined, 'native_window_open', 'tab-parent');

    assert.strictEqual(adopted, true);
    const lineage = host.getTabLineage(popupId);
    assert.ok(lineage);
    assert.strictEqual(lineage.source, 'native_window_open');
    assert.strictEqual(lineage.parentTabId, 'tab-parent');

    // Verified: popup is allowed for primary
    assert.strictEqual(host.isTabAllowed('tab-parent', popupId), true);
  });
});
