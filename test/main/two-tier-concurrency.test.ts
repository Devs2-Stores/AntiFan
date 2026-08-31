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
        interactiveSequence.push(`click:${params.tabId}`);
        await new Promise((r) => setImmediate(r));
        return true;
      }

      async agentType(params: { text: string; tabId?: string }) {
        interactiveSequence.push(`type:${params.tabId}:${params.text}`);
        await new Promise((r) => setImmediate(r));
        return true;
      }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => 1,
    });
    const transport = new CapabilityTransportAdapter(catalogue);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport, attachmentRegistry);

    // Issue Session 1 (bound to tab-1)
    const run1 = makeControlPlaneId('run');
    const att1 = makeControlPlaneId('attempt');
    const { launch: launch1 } = attachmentRegistry.issueAttachment(run1, att1, projectId, workspaceId, {
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
    const { launch: launch2 } = attachmentRegistry.issueAttachment(run2, att2, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-2',
      grant: 'write',
    });

    // 1. Concurrent Passive Calls across both sessions
    const pDom1 = mcpServer.callTool('anti.inspect.dom', {
      attachmentClaims: { attachmentId: launch1.attachmentId, attachmentSecret: launch1.secret, runId: run1, attemptId: att1, projectId, workspaceId, grant: 'read', invocationId: 'inv-p1' },
    });
    const pDom2 = mcpServer.callTool('anti.inspect.dom', {
      attachmentClaims: { attachmentId: launch2.attachmentId, attachmentSecret: launch2.secret, runId: run2, attemptId: att2, projectId, workspaceId, grant: 'read', invocationId: 'inv-p2' },
    });
    const pShot1 = mcpServer.callTool('anti.screenshot.viewport', {
      attachmentClaims: { attachmentId: launch1.attachmentId, attachmentSecret: launch1.secret, runId: run1, attemptId: att1, projectId, workspaceId, grant: 'read', invocationId: 'inv-p3' },
    });
    const pShot2 = mcpServer.callTool('anti.screenshot.viewport', {
      attachmentClaims: { attachmentId: launch2.attachmentId, attachmentSecret: launch2.secret, runId: run2, attemptId: att2, projectId, workspaceId, grant: 'read', invocationId: 'inv-p4' },
    });

    const [rDom1, rDom2, rShot1, rShot2] = await Promise.all([pDom1, pDom2, pShot1, pShot2]);

    assert.strictEqual(rDom1.isError, undefined, `rDom1 failed: ${rDom1.content[0]?.text}`);
    assert.strictEqual(rDom2.isError, undefined, `rDom2 failed: ${rDom2.content[0]?.text}`);
    assert.strictEqual(rShot1.isError, undefined, `rShot1 failed: ${rShot1.content[0]?.text}`);
    assert.strictEqual(rShot2.isError, undefined, `rShot2 failed: ${rShot2.content[0]?.text}`);
    assert.ok(activeOperations.includes('dom:tab-1'));
    assert.ok(activeOperations.includes('dom:tab-2'));

    // 2. Interactive actions serialize through ViewportGate in order
    const pClick1 = mcpServer.callTool('anti.agent.cursor.click', {
      selector: '#btn-submit',
      attachmentClaims: { attachmentId: launch1.attachmentId, attachmentSecret: launch1.secret, runId: run1, attemptId: att1, projectId, workspaceId, grant: 'write', invocationId: 'inv-i1' },
    });
    const pType2 = mcpServer.callTool('anti.agent.cursor.type', {
      text: 'hello world',
      attachmentClaims: { attachmentId: launch2.attachmentId, attachmentSecret: launch2.secret, runId: run2, attemptId: att2, projectId, workspaceId, grant: 'write', invocationId: 'inv-i2' },
    });

    const [rClick1, rType2] = await Promise.all([pClick1, pType2]);
    assert.strictEqual(rClick1.isError, undefined, `rClick1 failed: ${rClick1.content[0]?.text}`);
    assert.strictEqual(rType2.isError, undefined, `rType2 failed: ${rType2.content[0]?.text}`);
    assert.deepStrictEqual(interactiveSequence, ['click:tab-1', 'type:tab-2:hello world']);
  });

  it('synchronizes live documentGeneration on tab navigation, switch, and reload', async () => {
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
    const browserPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: (id?: string) => {
        if (id === 'tab-created') return 7;
        return currentDocGen;
      },
    });
    const transport = new CapabilityTransportAdapter(catalogue);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport, attachmentRegistry);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-sync',
      documentGeneration: 1,
      grant: 'write',
    });

    // 1. Navigate tab -> docGen updates to 5
    const navResult = await mcpServer.callTool('anti.browser.navigate', {
      url: 'https://example.com/page2',
      attachmentClaims: { attachmentId: launch.attachmentId, attachmentSecret: launch.secret, runId, attemptId, projectId, workspaceId, grant: 'write', invocationId: 'inv-n1' },
    });
    assert.strictEqual(navResult.isError, undefined);

    const attRecordAfterNav = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterNav?.documentGeneration, 5);

    // 2. Reload tab -> docGen updates to 6
    const reloadResult = await mcpServer.callTool('anti.browser.reload', {
      attachmentClaims: { attachmentId: launch.attachmentId, attachmentSecret: launch.secret, runId, attemptId, projectId, workspaceId, grant: 'write', invocationId: 'inv-r1' },
    });
    assert.strictEqual(reloadResult.isError, undefined);

    const attRecordAfterReload = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterReload?.documentGeneration, 6);

    // 3. Create new tab -> docGen updates to 7 and tabId updates to tab-created
    const createResult = await mcpServer.callTool('anti.browser.tabs.create', {
      url: 'https://example.com/created',
      attachmentClaims: { attachmentId: launch.attachmentId, attachmentSecret: launch.secret, runId, attemptId, projectId, workspaceId, grant: 'write', invocationId: 'inv-c1' },
    });
    assert.strictEqual(createResult.isError, undefined);

    const attRecordAfterCreate = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterCreate?.tabId, 'tab-created');
    assert.strictEqual(attRecordAfterCreate?.documentGeneration, 7);

    // 4. Switch tab back to tab-sync -> docGen updates to currentDocGen (6 or new 8)
    currentDocGen = 8;
    const switchResult = await mcpServer.callTool('anti.browser.tabs.activate', {
      tabId: 'tab-sync',
      attachmentClaims: { attachmentId: launch.attachmentId, attachmentSecret: launch.secret, runId, attemptId, projectId, workspaceId, grant: 'write', invocationId: 'inv-s1' },
    });
    assert.strictEqual(switchResult.isError, undefined);

    const attRecordAfterSwitch = attachmentRegistry.getAttachment(launch.attachmentId);
    assert.strictEqual(attRecordAfterSwitch?.tabId, 'tab-sync');
    assert.strictEqual(attRecordAfterSwitch?.documentGeneration, 8);

    // 5. Subsequent inspectDom succeeds with synchronized docGen without TARGET_STALE
    const domResult = await mcpServer.callTool('anti.inspect.dom', {
      attachmentClaims: { attachmentId: launch.attachmentId, attachmentSecret: launch.secret, runId, attemptId, projectId, workspaceId, grant: 'read', invocationId: 'inv-d1' },
    });
    assert.strictEqual(domResult.isError, undefined);
  });
});
