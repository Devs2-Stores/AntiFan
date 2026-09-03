import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  makeControlPlaneId,
  issueRuntimeLease,
} from '../../src/shared/control-plane-contracts';

describe('Two-Tier Concurrency Engine & ViewportGate Integration (Phase 03)', () => {
  it('allows concurrent passive calls across tabs while serializing interactive visual actions', async () => {
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

    const activeOperations: string[] = [];
    const interactiveSequence: string[] = [];
    let inFlightInteractive = 0;
    let maxInFlightInteractive = 0;

    const tabList = [
      { id: 'tab-1', url: 'https://example.com/1', title: 'Tab 1' },
      { id: 'tab-2', url: 'https://example.com/2', title: 'Tab 2' },
    ];

    class MockHost extends EventEmitter {
      public agentInputInFlight = 0;
      getTabList() { return [...tabList]; }
      getActiveTabId() { return 'tab-1'; }
      getActiveTab() { return tabList[0]; }
      getAutomationTabId() { return 'tab-1'; }
      getDocumentGeneration() { return 1; }
      isCurrentTarget() { return true; }

      async getDom(selector?: string, tabId?: string) {
        activeOperations.push(`dom:${tabId}`);
        // Simulate IO latency
        await new Promise((r) => setImmediate(r));
        return `<html><body>DOM for ${tabId}</body></html>`;
      }

      async captureScreenshot(rect?: unknown, tabId?: string) {
        activeOperations.push(`screenshot:${tabId}`);
        await new Promise((r) => setImmediate(r));
        return Buffer.from('png').toString('base64');
      }

      async evalJs(expression: string, tabId?: string) {
        activeOperations.push(`eval:${tabId}`);
        await new Promise((r) => setImmediate(r));
        return { result: expression };
      }

      async agentClick(params: { selector?: string; tabId?: string }) {
        inFlightInteractive++;
        maxInFlightInteractive = Math.max(maxInFlightInteractive, inFlightInteractive);
        interactiveSequence.push(`click:${params.tabId}`);
        await new Promise((r) => setImmediate(r));
        inFlightInteractive--;
        return true;
      }

      async agentType(params: { text: string; tabId?: string }) {
        inFlightInteractive++;
        maxInFlightInteractive = Math.max(maxInFlightInteractive, inFlightInteractive);
        interactiveSequence.push(`type:${params.tabId}:${params.text}`);
        await new Promise((r) => setImmediate(r));
        inFlightInteractive--;
        return true;
      }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => 1,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);

    // Issue Session 1 (bound to tab-1)
    const run1 = makeControlPlaneId('run');
    const att1 = makeControlPlaneId('attempt');
    const { launch: launch1 } = await attachmentRegistry.issueAttachment(run1, att1, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-1',
      grant: 'write',
    });

    // Issue Session 2 (bound to tab-2)
    const run2 = makeControlPlaneId('run');
    const att2 = makeControlPlaneId('attempt');
    const { launch: launch2 } = await attachmentRegistry.issueAttachment(run2, att2, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-2',
      grant: 'write',
    });

    const server1 = new AntiFanMcpServer(mockHost, false, transport, {
      attachmentId: launch1.attachmentId,
      attachmentSecret: launch1.secret,
      authorityRevision: launch1.authorityRevision,
    });
    const server2 = new AntiFanMcpServer(mockHost, false, transport, {
      attachmentId: launch2.attachmentId,
      attachmentSecret: launch2.secret,
      authorityRevision: launch2.authorityRevision,
    });

    // 1. Concurrent Passive Calls across both sessions
    const pDom1 = server1.callTool('anti.inspect.dom', {});
    const pDom2 = server2.callTool('anti.inspect.dom', {});
    const pShot1 = server1.callTool('anti.screenshot.viewport', {});
    const pShot2 = server2.callTool('anti.screenshot.viewport', {});

    const [rDom1, rDom2, rShot1, rShot2] = await Promise.all([pDom1, pDom2, pShot1, pShot2]);

    assert.strictEqual(rDom1.isError, undefined, `rDom1 failed: ${rDom1.content[0]?.text}`);
    assert.strictEqual(rDom2.isError, undefined, `rDom2 failed: ${rDom2.content[0]?.text}`);
    assert.strictEqual(rShot1.isError, undefined, `rShot1 failed: ${rShot1.content[0]?.text}`);
    assert.strictEqual(rShot2.isError, undefined, `rShot2 failed: ${rShot2.content[0]?.text}`);
    assert.ok(activeOperations.includes('dom:tab-1'));
    assert.ok(activeOperations.includes('dom:tab-2'));

    // 2. Serialized Visual Calls (FIFO & max 1 in-flight enforcement)
    const vClick1 = server1.callTool('anti.agent.cursor.click', { selector: '#btn-1' });
    const vType2 = server2.callTool('anti.agent.cursor.type', { selector: '#input-2', text: 'concurrent-payload' });
    const [rClick1, rType2] = await Promise.all([vClick1, vType2]);
    assert.strictEqual(rClick1.isError, undefined);
    assert.strictEqual(rType2.isError, undefined);
    assert.strictEqual(maxInFlightInteractive, 1, 'ViewportGate must strictly serialize interactive actions to max 1 in-flight');
    assert.deepStrictEqual(interactiveSequence, ['click:tab-1', 'type:tab-2:concurrent-payload'], 'Visual actions must execute in strict FIFO order');

    // 3. Mixed Viewport & Passive Execution
    const mixedClick = server1.callTool('anti.agent.cursor.click', { selector: '#btn-mixed' });
    const mixedDom = server2.callTool('anti.inspect.dom', {});
    const [rMixedClick, rMixedDom] = await Promise.all([mixedClick, mixedDom]);
    assert.strictEqual(rMixedClick.isError, undefined);
    assert.strictEqual(rMixedDom.isError, undefined);
    assert.deepStrictEqual(
      interactiveSequence,
      ['click:tab-1', 'type:tab-2:concurrent-payload', 'click:tab-1'],
      'Mixed execution must preserve sequential visual order'
    );
  });

  it('synchronizes documentGeneration and tab tracking seamlessly across navigation and tab switches', async () => {
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

    let currentDocGen = 1;
    const tabList = [
      { id: 'tab-sync', url: 'https://example.com' },
      { id: 'tab-created', url: 'https://example.com/created' },
    ];
    const mockHost = {
      getTabList: () => tabList,
      getDocumentGeneration: (id?: string) => {
        if (id === 'tab-created') return 7;
        return currentDocGen;
      },
      setAutomationTabId: () => {},
      createTab: () => 'tab-created',
      switchTab: () => true,
      navigate: async () => {
        currentDocGen = 5;
        return true;
      },
      reload: async () => {
        currentDocGen = 6;
        return true;
      },
      getDom: async () => '<div>test</div>',
    } as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: (id?: string) => {
        if (id === 'tab-created') return 7;
        return currentDocGen;
      },
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-sync',
      documentGeneration: 1,
      grant: 'write',
    });

    const mcpServer = new AntiFanMcpServer(mockHost, false, transport, {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // 1. Navigate tab -> docGen updates to 5
    const navResult = await mcpServer.callTool('anti.browser.navigate', {
      url: 'https://example.com/page2',
    });
    assert.strictEqual(navResult.isError, undefined);

    const attRecordAfterNav = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterNav?.documentGeneration, 5);

    // 2. Reload tab -> docGen updates to 6
    const reloadResult = await mcpServer.callTool('anti.browser.reload', {});
    assert.strictEqual(reloadResult.isError, undefined);

    const attRecordAfterReload = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterReload?.documentGeneration, 6);

    // 3. Create new tab -> docGen updates to 7 and tabId updates to tab-created
    const createResult = await mcpServer.callTool('anti.browser.tabs.create', {
      url: 'https://example.com/created',
    });
    assert.strictEqual(createResult.isError, undefined);

    const attRecordAfterCreate = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterCreate?.tabId, 'tab-created');
    assert.strictEqual(attRecordAfterCreate?.documentGeneration, 7);

    // 4. Switch tab back to tab-sync -> docGen updates to currentDocGen (8)
    currentDocGen = 8;
    const switchResult = await mcpServer.callTool('anti.browser.tabs.activate', {
      tabId: 'tab-sync',
    });
    assert.strictEqual(switchResult.isError, undefined);
    const attRecordAfterSwitch = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterSwitch?.tabId, 'tab-sync');
    assert.strictEqual(attRecordAfterSwitch?.documentGeneration, 8);

    // 5. Subsequent inspectDom succeeds with synchronized docGen without TARGET_STALE
    const domResult = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(domResult.isError, undefined);
  });
});
