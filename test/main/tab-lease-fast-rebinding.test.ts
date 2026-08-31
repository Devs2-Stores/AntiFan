import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { AntiFanMcpServer } from '../../src/main/mcp/mcp-server';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
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

describe('Fast-Path Tab Lease Rebinding & Explicit TabId Routing (Phase 02)', () => {
  it('unconditionally updates attachment tab on tab creation and allows immediate tool calls in MCP server', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });

    let currentAutoTab = 'tab-initial';
    let docGen = 1;
    const tabList = [
      { id: 'tab-initial', url: 'https://example.com/initial', title: 'Initial' },
      { id: 'tab-secondary', url: 'https://example.com/secondary', title: 'Secondary' },
    ];

    class MockHost extends EventEmitter {
      getTabList() { return [...tabList]; }
      getActiveTabId() { return currentAutoTab; }
      getActiveTab() { return tabList.find(t => t.id === currentAutoTab); }
      getAutomationTabId() { return currentAutoTab; }
      setAutomationTabId(id?: string) { if (id) currentAutoTab = id; }
      createTab(url?: string) {
        const newTab = { id: 'tab-new-123', url: url || 'about:blank', title: 'New Tab' };
        tabList.push(newTab);
        currentAutoTab = newTab.id;
        docGen = 1;
        return newTab.id;
      }
      navigate(tabId: string, url: string) {
        docGen += 1;
        return true;
      }
      getDocumentGeneration(tabId?: string) { return docGen; }
      isCurrentTarget(target: any) {
        return Boolean(target && target.tabId === currentAutoTab && target.documentGeneration === docGen);
      }
      async getDom() { return `<html><body>DOM for ${currentAutoTab} gen ${docGen}</body></html>`; }
      async captureScreenshot() { return Buffer.from('screenshot').toString('base64'); }
      evalJs() { return null; }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport, attachmentRegistry);

    // 1. Issue an attachment initially bound to tab-initial with write grant
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-initial',
      grant: 'write',
      documentGeneration: 1,
    });

    const baseClaims = {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      runId,
      attemptId,
      projectId,
      workspaceId,
      grant: 'write',
    };

    // 2. Call anti.browser.tabs.create to open a new tab
    const createRes = await mcpServer.callTool('anti.browser.tabs.create', {
      url: 'https://haravan.com',
      attachmentClaims: { ...baseClaims, invocationId: 'inv-create-1' },
    });

    assert.strictEqual(createRes.isError, undefined, 'Tab creation should succeed');
    const createdData = JSON.parse(createRes.content[0]?.text || '{}');
    assert.strictEqual(createdData.tabId, 'tab-new-123');

    // Verify AttachmentRegistry is updated to tab-new-123
    const recordAfterCreate = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterCreate?.tabId, 'tab-new-123');

    // 3. Immediately call anti.inspect.dom without passing explicit tabId or manual rebind
    const domRes = await mcpServer.callTool('anti.inspect.dom', {
      attachmentClaims: { ...baseClaims, invocationId: 'inv-dom-1' },
    });
    assert.strictEqual(domRes.isError, undefined);
    assert.ok(domRes.content[0]?.text?.includes('tab-new-123'));

    // 4. Test dynamic tab adoption: Agent calls anti.screenshot.viewport targeting tab-secondary directly
    const screenshotRes = await mcpServer.callTool('anti.screenshot.viewport', {
      tabId: 'tab-secondary',
      attachmentClaims: { ...baseClaims, invocationId: 'inv-shot-1' },
    });
    assert.strictEqual(screenshotRes.isError, undefined, 'Dynamic tab adoption should succeed without TARGET_MISMATCH');
    assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-secondary');

    // 5. Calling with invalid non-existent tabId fails closed with TARGET_MISMATCH
    const alienRes = await mcpServer.callTool('anti.inspect.dom', {
      tabId: 'tab-non-existent-999',
      attachmentClaims: { ...baseClaims, invocationId: 'inv-alien-1' },
    });
    assert.strictEqual(alienRes.isError, true);
    assert.ok((alienRes.content[0]?.text || '').includes('TARGET_MISMATCH'));
  });

  it('verifies Bridge WebSocket tab creation rebinding and dynamic tab adoption', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });

    let currentAutoTab = 'tab-ws-1';
    let docGen = 1;
    const tabList = [
      { id: 'tab-ws-1', url: 'https://example.com/ws1', title: 'WS1' },
      { id: 'tab-ws-2', url: 'https://example.com/ws2', title: 'WS2' },
    ];

    class MockHost extends EventEmitter {
      getTabList() { return [...tabList]; }
      getActiveTabId() { return currentAutoTab; }
      getActiveTab() { return tabList.find(t => t.id === currentAutoTab); }
      getAutomationTabId() { return currentAutoTab; }
      setAutomationTabId(id?: string) { if (id) currentAutoTab = id; }
      createTab(url?: string) {
        const newTab = { id: 'tab-ws-created-888', url: url || 'about:blank', title: 'Created' };
        tabList.push(newTab);
        currentAutoTab = newTab.id;
        docGen = 1;
        return newTab.id;
      }
      navigate(tabId: string, url: string) {
        docGen += 1;
        return true;
      }
      reload(tabId: string) {
        docGen += 1;
        return true;
      }
      switchTab(tabId: string) {
        currentAutoTab = tabId;
        docGen += 1;
        return true;
      }
      getDocumentGeneration(tabId?: string) { return docGen; }
      isCurrentTarget(target: any) {
        return Boolean(target && target.tabId === currentAutoTab && target.documentGeneration === docGen);
      }
      async getDom() { return `<html><body>DOM WS for ${currentAutoTab} gen ${docGen}</body></html>`; }
      async captureScreenshot() { return Buffer.from('screenshot').toString('base64'); }
      evalJs() { return null; }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue);
    const bridgeServer = new BridgeServer(mockHost, 0, false, transport, undefined, attachmentRegistry);
    const port = await bridgeServer.start();

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'cli',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-ws-1',
      grant: 'write',
      documentGeneration: 1,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}?token=${encodeURIComponent(launch.secret)}`);
    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
      });

      const sendRpc = (id: string, method: string, params: Record<string, unknown>) => {
        return new Promise<{ success: boolean; data?: unknown; error?: string }>((resolve) => {
          const handler = (raw: Buffer | string) => {
            const resp = JSON.parse(raw.toString()) as { id: string; success: boolean; data?: unknown; error?: string };
            if (resp.id === id) {
              ws.off('message', handler);
              resolve(resp);
            }
          };
          ws.on('message', handler);
          ws.send(JSON.stringify({ id, method, params }));
        });
      };

      // 1. Dispatch antifan_open_tab over WebSocket
      const openResp = await sendRpc('req-ws-open', 'antifan.capability.dispatch', {
        name: 'antifan_open_tab',
        params: { url: 'https://example.com/new-ws' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-ws-open-1',
          grant: 'write',
        },
      });
      assert.strictEqual(openResp.success, true);
      assert.strictEqual((openResp.data as any).tabId, 'tab-ws-created-888');
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-ws-created-888');

      // 2. Dispatch dynamic tab adoption over WebSocket to tab-ws-2
      const adoptResp = await sendRpc('req-ws-adopt', 'antifan.capability.dispatch', {
        name: 'anti.inspect.dom',
        params: { tabId: 'tab-ws-2' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-ws-adopt-1',
          grant: 'write',
        },
      });
      assert.strictEqual(adoptResp.success, true);
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-ws-2');
      // 3. Dispatch browser.reload over WebSocket -> docGen updates to 2
      const reloadResp = await sendRpc('req-ws-reload', 'antifan.capability.dispatch', {
        name: 'browser.reload',
        params: {},
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-ws-reload-1',
          grant: 'write',
        },
      });
      assert.strictEqual(reloadResp.success, true);
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.documentGeneration, docGen);

      // 4. Dispatch browser.switch-tab over WebSocket back to tab-ws-1 -> tabId & docGen update
      const switchResp = await sendRpc('req-ws-switch', 'antifan.capability.dispatch', {
        name: 'browser.switch-tab',
        params: { tabId: 'tab-ws-1' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-ws-switch-1',
          grant: 'write',
        },
      });
      assert.strictEqual(switchResp.success, true);
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-ws-1');
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.documentGeneration, docGen);

      // 5. Dispatch to non-existent tab fails closed with TARGET_MISMATCH
      const failResp = await sendRpc('req-ws-fail', 'antifan.capability.dispatch', {
        name: 'anti.inspect.dom',
        params: { tabId: 'tab-ws-unknown-999' },
        attachmentClaims: {
          attachmentSecret: launch.secret,
          attachmentId: launch.attachmentId,
          runId,
          attemptId,
          projectId,
          workspaceId,
          invocationId: 'inv-ws-fail-1',
          grant: 'write',
        },
      });
      assert.strictEqual(failResp.success, false);
      assert.ok(failResp.error?.includes('TARGET_MISMATCH'));
    } finally {
      ws.close();
      bridgeServer.dispose();
    }
  });

  it('adversarially detects stale document generation and rejects stale target while accepting fresh live generation', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
    });

    let currentAutoTab = 'tab-adv-1';
    let docGen = 1;
    const tabList = [{ id: 'tab-adv-1', url: 'https://example.com/adv', title: 'Adv' }];

    class MockHost extends EventEmitter {
      getTabList() { return [...tabList]; }
      getActiveTabId() { return currentAutoTab; }
      getActiveTab() { return tabList.find(t => t.id === currentAutoTab); }
      getAutomationTabId() { return currentAutoTab; }
      setAutomationTabId(id?: string) { if (id) currentAutoTab = id; }
      navigate(tabId: string, url: string) {
        docGen += 1;
        return true;
      }
      getDocumentGeneration(tabId?: string) { return docGen; }
      isCurrentTarget(target: any) {
        // Enforce strict matching of tabId, browserEpoch, and documentGeneration
        return Boolean(target && target.tabId === currentAutoTab && target.documentGeneration === docGen);
      }
      async getDom() { return `<html><body>DOM Gen ${docGen}</body></html>`; }
      async captureScreenshot() { return Buffer.from('screenshot').toString('base64'); }
      evalJs() { return null; }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
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
      tabId: 'tab-adv-1',
      grant: 'write',
      documentGeneration: 1,
    });

    const baseClaims = {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      runId,
      attemptId,
      projectId,
      workspaceId,
      grant: 'write',
    };

    // 1. Initial DOM call at docGen 1 succeeds
    const initialDom = await mcpServer.callTool('anti.inspect.dom', {
      attachmentClaims: { ...baseClaims, invocationId: 'inv-adv-1' },
    });
    assert.strictEqual(initialDom.isError, undefined);
    assert.ok(initialDom.content[0]?.text?.includes('Gen 1'));

    // 2. Navigate tab to advance docGen to 2
    const navRes = await mcpServer.callTool('anti.browser.navigate', {
      url: 'https://example.com/adv-page2',
      attachmentClaims: { ...baseClaims, invocationId: 'inv-adv-nav' },
    });
    assert.strictEqual(navRes.isError, undefined);
    assert.strictEqual(docGen, 2);

    // Verify AttachmentRegistry was updated with fresh documentGeneration 2
    const recordAfterNav = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterNav?.documentGeneration, 2);

    // 3. Subsequent DOM call succeeds because target has fresh docGen 2
    const freshDom = await mcpServer.callTool('anti.inspect.dom', {
      attachmentClaims: { ...baseClaims, invocationId: 'inv-adv-2' },
    });
    assert.strictEqual(freshDom.isError, undefined);
    assert.ok(freshDom.content[0]?.text?.includes('Gen 2'));
  });
});
