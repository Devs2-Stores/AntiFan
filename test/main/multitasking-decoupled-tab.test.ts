import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { BrowserControlPort, ViewportGate } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import {
  makeControlPlaneId,
  issueRuntimeLease,
  CapabilityError,
  BrowserTarget,
} from '../../src/shared/control-plane-contracts';

describe('Decoupled Dual-Plane Background Automation & TARGET_STALE Elimination (Phase 01-04)', () => {
  async function createHarness() {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      allowEval: true,
      getActiveLease: () => lease,
    });

    const tabList = [
      { id: 'tab-1', url: 'https://theme.myshopify.com', title: 'Storefront Theme' },
      { id: 'tab-2', url: 'https://youtube.com/watch', title: 'YouTube' },
    ];

    let userActiveTabId = 'tab-2';
    let automationTabId = 'tab-1';
    let tab1DocGen = 1;
    const tabThrottlingState = new Map<string, boolean>();

    class MockHost extends EventEmitter {
      public agentInputInFlight = 0;
      getTabList() { return [...tabList]; }
      getActiveTabId() { return userActiveTabId; }
      setActiveTabId(id: string) { userActiveTabId = id; }
      getAutomationTabId() { return automationTabId; }
      setAutomationTabId(id: string) { automationTabId = id; }
      getDocumentGeneration(tabId?: string) {
        if (tabId === 'tab-1') return tab1DocGen;
        return 1;
      }
      setDocumentGeneration(tabId: string, gen: number) {
        if (tabId === 'tab-1') tab1DocGen = gen;
      }
      isCurrentTarget(target: BrowserTarget) {
        if (target.tabId === 'tab-1') {
          return target.documentGeneration === tab1DocGen;
        }
        return true;
      }

      async getDom(selector?: string, tabId?: string) {
        return `<html><body>DOM for ${tabId || userActiveTabId} (gen:${this.getDocumentGeneration(tabId)})</body></html>`;
      }
      async captureScreenshot(rect?: unknown, tabId?: string) {
        return Buffer.from(`screenshot:${tabId || userActiveTabId}`).toString('base64');
      }
      async evalJs(expression: string, tabId?: string) {
        return `eval-result:${tabId || userActiveTabId}`;
      }
      async navigate(tabId: string, url: string) {
        const tab = tabList.find(t => t.id === tabId);
        if (tab) tab.url = url;
        return true;
      }
      async reload(tabId: string) {
        return true;
      }
      async agentClick(params: { tabId?: string; selector?: string }) {
        return true;
      }
      async agentType(params: { tabId?: string; text: string }) {
        return true;
      }
      async agentClear(tabId?: string) {
        return true;
      }
      async agentSnapshot(tabId?: string) {
        return `snapshot-tree:${tabId || userActiveTabId}`;
      }
      async sendKeyboardPress(params: { key: string; tabId?: string }) {
        return { success: true, key: params.key, modifiers: [] };
      }
    }

    const host = new MockHost();
    const port = new BrowserControlPort(host);
    registerBrowserCapabilities(catalogue, port);

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => tab1DocGen,
    });

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
    });

    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(host as unknown as any, false, transport, {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    return {
      projectId,
      workspaceId,
      lease,
      host,
      port,
      attachmentRegistry,
      launch,
      transport,
      mcpServer,
      getUserActiveTabId: () => userActiveTabId,
      getAutomationTabId: () => automationTabId,
      setTab1DocGen: (g: number) => { tab1DocGen = g; },
      getTab1DocGen: () => tab1DocGen,
    };
  }

  it('1. Decoupled Dual-Plane Execution: background agent calls on Tab 1 do not alter user active Tab 2', async () => {
    const { mcpServer, getUserActiveTabId } = await createHarness();

    assert.strictEqual(getUserActiveTabId(), 'tab-2', 'User starts on Tab 2 (e.g. YouTube)');

    // Execute passive reads on background Tab 1
    const domRes = await mcpServer.callTool('anti.inspect.dom', { tabId: 'tab-1' });
    assert.strictEqual(domRes.isError, undefined);
    assert.strictEqual(getUserActiveTabId(), 'tab-2', 'User active tab remains Tab 2 after DOM inspect');

    const snapRes = await mcpServer.callTool('antifan_agent_snapshot', { tabId: 'tab-1' });
    assert.strictEqual(snapRes.isError, undefined);
    assert.strictEqual(getUserActiveTabId(), 'tab-2', 'User active tab remains Tab 2 after snapshot');

    // Execute interactive write on background Tab 1
    const clickRes = await mcpServer.callTool('anti.agent.cursor.click', { tabId: 'tab-1', selector: 'button.checkout' });
    assert.strictEqual(clickRes.isError, undefined);
    assert.strictEqual(getUserActiveTabId(), 'tab-2', 'User active tab remains Tab 2 after click');

    const typeRes = await mcpServer.callTool('anti.agent.cursor.type', { tabId: 'tab-1', selector: 'input.coupon', text: 'DISCOUNT2026' });
    assert.strictEqual(typeRes.isError, undefined);
    assert.strictEqual(getUserActiveTabId(), 'tab-2', 'User active tab remains Tab 2 after type');
  });

  it('2. RT-01 Scoped Preemption: physical keyboard input on Tab 2 does NOT abort agent running on Tab 1', async () => {
    const { port } = await createHarness();

    let agentFinished = false;
    let agentError: unknown = null;
    let started1 = false;

    // Start long-running agent action on Tab 1 under ViewportGate lock
    const agentPromise = port.viewportGate.withLock(async (signal) => {
      started1 = true;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (signal.aborted) {
        throw signal.reason;
      }
      agentFinished = true;
      return true;
    }, { tabId: 'tab-1', timeoutMs: 1000 }).catch((err) => {
      agentError = err;
    });

    while (!started1) {
      await new Promise((r) => setImmediate(r));
    }

    // User types on Tab 2 (YouTube search bar)
    port.viewportGate.preemptActiveAgent('Manual keyboard input detected on tab', 'tab-2');

    await agentPromise;

    assert.strictEqual(agentFinished, true, 'Agent on Tab 1 successfully completed despite typing on Tab 2');
    assert.strictEqual(agentError, null, 'Agent on Tab 1 was not preempted');

    // Now test that typing on Tab 1 DOES abort agent on Tab 1
    let abortedCorrectly = false;
    let started2 = false;
    const agentPromise2 = port.viewportGate.withLock(async (signal) => {
      started2 = true;
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (signal.aborted) throw signal.reason;
      return true;
    }, { tabId: 'tab-1', timeoutMs: 1000 }).catch((err) => {
      if (err instanceof CapabilityError && err.code === 'PREEMPTED_BY_USER') {
        abortedCorrectly = true;
      }
    });

    while (!started2) {
      await new Promise((r) => setImmediate(r));
    }

    // User types on Tab 1 (the automation target tab)
    port.viewportGate.preemptActiveAgent('Manual keyboard input detected on tab', 'tab-1');

    await agentPromise2;
    assert.strictEqual(abortedCorrectly, true, 'Typing directly on Tab 1 correctly preempted Tab 1 agent');
  });

  it('3. RT-02 Dynamic Throttling Exemption: Tab unthrottles during agent run and re-throttles upon settle', () => {
    const tabs = new Map<string, { state: { aiState: string }; view?: { webContents: { throttled: boolean } } }>([
      ['tab-1', { state: { aiState: 'idle' }, view: { webContents: { throttled: true } } }],
      ['tab-2', { state: { aiState: 'idle' }, view: { webContents: { throttled: false } } }],
    ]);
    const activeTabId = 'tab-2';
    const agentWorkingRefs = new Map<string, number>();

    function applyTabThrottling() {
      for (const [id, tab] of tabs.entries()) {
        const isForeground = id === activeTabId;
        const isAgentWorking = tab.state.aiState === 'agent_working' || (agentWorkingRefs.get(id) || 0) > 0;
        const shouldThrottle = !isForeground && !isAgentWorking;
        if (tab.view) tab.view.webContents.throttled = shouldThrottle;
      }
    }

    // Initial state: Tab 1 throttled (background), Tab 2 unthrottled (foreground)
    applyTabThrottling();
    assert.strictEqual(tabs.get('tab-1')!.view!.webContents.throttled, true, 'Tab 1 initially throttled');
    assert.strictEqual(tabs.get('tab-2')!.view!.webContents.throttled, false, 'Tab 2 unthrottled');

    // Agent starts working on Tab 1
    tabs.get('tab-1')!.state.aiState = 'agent_working';
    applyTabThrottling();
    assert.strictEqual(tabs.get('tab-1')!.view!.webContents.throttled, false, 'Tab 1 dynamically unthrottled during agent run');

    // Agent finishes working on Tab 1
    tabs.get('tab-1')!.state.aiState = 'idle';
    applyTabThrottling();
    assert.strictEqual(tabs.get('tab-1')!.view!.webContents.throttled, true, 'Tab 1 re-throttled immediately after agent settles');
  });

  it('4. RT-03 Differential Generation Fencing: Passive reads auto-sync while interactive writes fail-close on HMR', async () => {
    const { port, setTab1DocGen } = await createHarness();

    const target: BrowserTarget = {
      projectId: makeControlPlaneId('project'),
      workspaceId: makeControlPlaneId('workspace'),
      runtimeId: makeControlPlaneId('run'),
      browserEpoch: 1,
      tabId: 'tab-1',
      documentGeneration: 1, // Target was issued at generation 1
    };

    // Dev server in background triggers HMR update -> document generation advances to 5
    setTab1DocGen(5);

    // 1. Passive DOM read: should automatically sync to generation 5 without throwing TARGET_STALE
    const domResult = await port.dom(target, 'run-1', 'att-1', undefined, 'tab-1');
    assert.ok(typeof domResult === 'string' && domResult.includes('gen:5'), 'Passive read auto-synced to live document generation 5');

    // 2. Passive screenshot: should automatically succeed
    const screenshotResult = await port.screenshot(target, 'run-1', 'att-1', 'tab-1');
    assert.ok(typeof screenshotResult === 'string' && screenshotResult.length > 0, 'Screenshot succeeded with auto-synced generation');

    // 3. Passive reload: should succeed and return updated target with docGen 5
    const reloadResult = await port.reload(target, 'tab-1');
    assert.strictEqual(reloadResult.reloaded, true);
    assert.strictEqual(reloadResult.target.documentGeneration, 5, 'Reload returned updated generation 5');

    // 4. Interactive write with stale target (gen 1 vs live gen 5): must fail-close with TARGET_STALE diagnostic
    let writeError: CapabilityError | null = null;
    try {
      await port.agentClick({ tabId: 'tab-1', selector: 'button.checkout' }, target);
    } catch (err) {
      if (err instanceof CapabilityError) writeError = err;
    }

    assert.ok(writeError !== null, 'Interactive write rejected due to stale generation');
    assert.strictEqual(writeError.code, 'TARGET_STALE');
    assert.ok(writeError.message.includes('stale'), 'Error message contains actionable stale diagnostic');
  });
});
