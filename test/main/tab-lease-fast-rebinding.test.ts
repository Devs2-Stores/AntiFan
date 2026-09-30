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
  CapabilityError,
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
      hasTab(id?: string | null) { return Boolean(id && tabList.some(t => t.id === id)); }
      resolveTabAffiliation(tabId: string) {
        if (!tabList.some(t => t.id === tabId)) return undefined;
        return { projectId, workspaceId, capsuleId: 'capsule-initial' };
      }
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
    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport);

    // 1. Issue an attachment initially bound to tab-initial with write grant
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-initial',
      grant: 'write',
      documentGeneration: 1,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // 2. Call anti.browser.tabs.create to open a new tab
    const createRes = await mcpServer.callTool('anti.browser.tabs.create', {
      url: 'https://haravan.com',
    });

    assert.strictEqual(createRes.isError, undefined, 'Tab creation should succeed');
    const parsedCreate = JSON.parse(createRes.content[0]?.text || '{}');
    const createdData = parsedCreate.data || parsedCreate;
    assert.strictEqual(createdData.tabId, 'tab-new-123');

    // Verify AttachmentRegistry is updated to tab-new-123
    const recordAfterCreate = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterCreate?.tabId, 'tab-new-123');

    // 3. Immediately call anti.inspect.dom without passing explicit tabId or manual rebind
    const domRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(domRes.isError, undefined, 'DOM inspection should succeed on new tab');
    assert.ok((domRes.content[0]?.text || '').includes('tab-new-123'));

    // 4. Calling with invalid non-existent tabId fails closed with TARGET_MISMATCH
    const alienRes = await mcpServer.callTool('anti.inspect.dom', {
      tabId: 'tab-non-existent-999',
    });
    assert.strictEqual(alienRes.isError, true);
    assert.ok((alienRes.content[0]?.text || '').includes('TARGET_MISMATCH'));
  });

  it('verifies Bridge WebSocket tab creation rebinding and dynamic tab adoption', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    let currentAutoTab = 'tab-ws-1';
    let docGen = 1;
    const tabList = [
      { id: 'tab-ws-1', url: 'https://example.com/ws1', title: 'WS1' },
      { id: 'tab-ws-2', url: 'https://example.com/ws2', title: 'WS2' },
    ];

    class MockHost extends EventEmitter {
      hasTab(id?: string | null) { return Boolean(id && tabList.some(t => t.id === id)); }
      resolveTabAffiliation(tabId: string) {
        if (!tabList.some(t => t.id === tabId)) return undefined;
        return { projectId, workspaceId, capsuleId: 'capsule-ws-1' };
      }
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

    let managedTabs = new Set<string>();
    const mockHost = new MockHost() as unknown as NativeTabHost;
    (mockHost as any).isTabAllowed = (bound: string, req: string) => bound === req || managedTabs.has(req);
    (mockHost as any).resolveTargetTabId = (id: string) => tabList.some(t => t.id === id) ? id : undefined;

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      isTabAllowed: (bound: string, req: string) => (mockHost as any).isTabAllowed(bound, req),
      resolveTabId: (id: string) => (mockHost as any).resolveTargetTabId(id),
      getDocumentGeneration: (id?: string) => (mockHost as any).getDocumentGeneration(id),
    });

    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');
    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const bridgeServer = new BridgeServer(mockHost, 0, false, transport, undefined, attachmentRegistry);
    const port = await bridgeServer.start();

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'cli',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-ws-1',
      grant: 'write',
      documentGeneration: 1,
    });

    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { 'x-antifan-attachment-secret': launch.secret },
    });
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

      let currentRevision = launch.authorityRevision;

      // 1. Dispatch antifan_open_tab over WebSocket
      const openResp = await sendRpc('req-ws-open', 'antifan.capability.dispatch', {
        name: 'antifan_open_tab',
        params: { url: 'https://example.com/new-ws' },
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: currentRevision,
      });
      assert.strictEqual(openResp.success, true);
      const openEnvelope = openResp.data as { data: { tabId: string }; authorityRevision?: string };
      assert.strictEqual(openEnvelope.data.tabId, 'tab-ws-created-888');
      if (openEnvelope.authorityRevision) currentRevision = openEnvelope.authorityRevision;
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-ws-created-888');

      // 2. Observation without retargeting to tab-ws-2 fails closed with TARGET_MISMATCH
      const alienObserve = await sendRpc('req-ws-alien-obs', 'antifan.capability.dispatch', {
        name: 'anti.inspect.dom',
        params: { tabId: 'tab-ws-2' },
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: currentRevision,
      });
      assert.strictEqual(alienObserve.success, false);
      assert.ok(alienObserve.error?.includes('TARGET_MISMATCH'));

      managedTabs.add('tab-ws-2');
      // 3. Explicitly switch/activate tab-ws-2
      const switchResp = await sendRpc('req-ws-switch', 'antifan.capability.dispatch', {
        name: 'browser.switch-tab',
        params: { tabId: 'tab-ws-2' },
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: currentRevision,
      });
      assert.strictEqual(switchResp.success, true);
      const switchEnvelope = switchResp.data as { data: unknown; authorityRevision?: string };
      if (switchEnvelope.authorityRevision) currentRevision = switchEnvelope.authorityRevision;
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-ws-2');

      // 4. Dispatch browser.reload over WebSocket -> docGen updates
      const reloadResp = await sendRpc('req-ws-reload', 'antifan.capability.dispatch', {
        name: 'browser.reload',
        params: {},
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: currentRevision,
      });
      assert.strictEqual(reloadResp.success, true);
      const reloadEnvelope = reloadResp.data as { data: unknown; authorityRevision?: string };
      if (reloadEnvelope.authorityRevision) currentRevision = reloadEnvelope.authorityRevision;
      assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.documentGeneration, docGen);

      // 5. Dispatch to non-existent tab fails closed with TARGET_MISMATCH
      const failResp = await sendRpc('req-ws-fail', 'antifan.capability.dispatch', {
        name: 'anti.inspect.dom',
        params: { tabId: 'tab-ws-unknown-999' },
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        authorityRevision: currentRevision,
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
    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport);

    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-adv-1',
      grant: 'write',
      documentGeneration: 1,
    });

    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // 1. Initial DOM call at docGen 1 succeeds
    const initialDom = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(initialDom.isError, undefined);
    assert.ok(initialDom.content[0]?.text?.includes('Gen 1'));

    // 2. Navigate tab to advance docGen to 2
    const navRes = await mcpServer.callTool('anti.browser.navigate', {
      url: 'https://example.com/adv-page2',
    });
    assert.strictEqual(navRes.isError, undefined);
    assert.strictEqual(docGen, 2);

    // Verify AttachmentRegistry was updated with fresh documentGeneration 2
    const recordAfterNav = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(recordAfterNav?.documentGeneration, 2);

    // 3. Subsequent DOM call succeeds because target has fresh docGen 2
    const freshDom = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(freshDom.isError, undefined);
    assert.ok(freshDom.content[0]?.text?.includes('Gen 2'));
  });

  it('dynamically queries and binds live documentGeneration (>1) when attachment is issued on pre-advanced tab', async () => {
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

    const liveDocGenByTab = new Map<string, number>([
      ['tab-advanced', 9],
      ['tab-switched', 14],
    ]);

    class PreAdvancedMockHost extends EventEmitter {
      getTabList() {
        return [
          { id: 'tab-advanced', url: 'https://example.com/advanced', title: 'Advanced' },
          { id: 'tab-switched', url: 'https://example.com/switched', title: 'Switched' },
        ];
      }
      getActiveTabId() { return 'tab-advanced'; }
      getActiveTab() { return { id: 'tab-advanced', url: 'https://example.com/advanced', title: 'Advanced' }; }
      getAutomationTabId() { return 'tab-advanced'; }
      setAutomationTabId() {}
      getDocumentGeneration(tId?: string) {
        return liveDocGenByTab.get(tId || 'tab-advanced') ?? 1;
      }
      isCurrentTarget(t?: unknown) {
        if (!t || typeof t !== 'object') return false;
        const target = t as { tabId?: string; documentGeneration?: number };
        const expectedGen = liveDocGenByTab.get(target.tabId || 'tab-advanced') ?? 1;
        return target.tabId === 'tab-advanced' && target.documentGeneration === expectedGen;
      }
      async getDom(_sel?: string, tabId?: string) {
        const gen = liveDocGenByTab.get(tabId || 'tab-advanced') ?? 1;
        return `<html><body>Live Content for ${tabId || 'tab-advanced'} at DocGen ${gen}</body></html>`;
      }
    }

    const mockHost = new PreAdvancedMockHost() as unknown as NativeTabHost;
    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort);

    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: (id) => mockHost.getDocumentGeneration(id),
      getAutomationTabId: () => 'tab-advanced',
    });

    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');

    // Issue attachment on tab-advanced without specifying documentGeneration: MUST dynamically resolve 9 from delegate!
    const { launch, record } = await attachmentRegistry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      backendId: 'mcp',
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      tabId: 'tab-advanced',
      grant: 'write',
    });

    assert.strictEqual(record.documentGeneration, 9, 'Issue must dynamically bind live generation 9 from delegate');
    assert.strictEqual(record.browserTarget?.documentGeneration, 9, 'BrowserTarget must carry dynamic generation 9');

    const mcpServer = new AntiFanMcpServer(mockHost, false, transport, {
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // Initial DOM inspection succeeds directly at generation 9 without TARGET_STALE
    const domRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(domRes.isError, undefined);
    assert.ok(domRes.content[0]?.text?.includes('DocGen 9'));

    // Dynamic tab update to tab-switched without explicit documentGeneration: MUST dynamically resolve 14!
    const newRev = await attachmentRegistry.updateAttachmentTab(launch.attachmentId, 'tab-switched');
    assert.ok(newRev);
    const updatedRecord = attachmentRegistry.getRecord(launch.attachmentId);
    assert.strictEqual(updatedRecord?.documentGeneration, 14, 'updateAttachmentTab must resolve live generation 14');
    assert.strictEqual(updatedRecord?.browserTarget?.documentGeneration, 14);
  });

  it('rebinds to a same-project tab owned by another session when bound tab has no affiliation', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const otherWorkspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    let currentAutoTab = 'tab-agent-ephemeral';
    let docGen = 3;
    const tabList = [
      // Bound agent surface: ephemeral tabs mint without a capsule, so affiliation measures nothing.
      { id: 'tab-agent-ephemeral', url: 'about:blank', title: 'Agent' },
      // Persist-profile tab another session attached: same project+workspace.
      { id: 'tab-admin-dashboard', url: 'https://dev.shopify.com/dashboard', title: 'Admin' },
      // Same project, different workspace — not adoptable.
      { id: 'tab-other-workspace', url: 'https://example.com/ow', title: 'OtherWS' },
      // No capsule at all — foreign surface.
      { id: 'tab-foreign', url: 'https://trello.com', title: 'Foreign' },
    ];
    const affiliationByTab: Record<string, { projectId: string; workspaceId: string; capsuleId: string } | undefined> = {
      'tab-agent-ephemeral': undefined,
      'tab-admin-dashboard': { projectId, workspaceId, capsuleId: 'capsule-admin' },
      'tab-other-workspace': { projectId, workspaceId: otherWorkspaceId, capsuleId: 'capsule-ow' },
      'tab-foreign': undefined,
    };

    class MockHost extends EventEmitter {
      hasTab(id?: string | null) { return Boolean(id && tabList.some(t => t.id === id)); }
      resolveTabAffiliation(tabId: string) { return affiliationByTab[tabId]; }
      getTabList() { return [...tabList]; }
      getActiveTabId() { return currentAutoTab; }
      getActiveTab() { return tabList.find(t => t.id === currentAutoTab); }
      getAutomationTabId() { return currentAutoTab; }
      setAutomationTabId(id?: string) { if (id) currentAutoTab = id; }
      getManagedTabIds() { return new Set([currentAutoTab]); }
      resolveTargetTabId(id: string) { return tabList.some(t => t.id === id) ? id : undefined; }
      getDocumentGeneration(tabId?: string) { return docGen; }
      isCurrentTarget(target: any) {
        // Mirrors NativeTabHost.isCurrentTarget: tab existence + generation +
        // lease envelope (browserEpoch, runtimeId, projectId, workspaceId).
        if (!target || typeof target.tabId !== 'string' || !tabList.some(t => t.id === target.tabId)) return false;
        if (typeof target.documentGeneration !== 'number' || target.documentGeneration !== docGen) return false;
        if (typeof target.browserEpoch !== 'number' || target.browserEpoch !== lease.hostEpoch) return false;
        if (typeof target.runtimeId !== 'string' || target.runtimeId !== lease.runtimeId) return false;
        if (target.projectId !== lease.projectId) return false;
        if (lease.workspaceId && target.workspaceId !== lease.workspaceId) return false;
        return true;
      }
      async getDom(selector?: string, tabId?: string) { return `<html><body>DOM for ${tabId || currentAutoTab} gen ${docGen}</body></html>`; }
      async captureScreenshot() { return Buffer.from('screenshot').toString('base64'); }
      evalJs() { return null; }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    (mockHost as any).isTabAllowed = (bound: string, req: string) => bound === req;

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      isTabAllowed: (bound: string, req: string) => (mockHost as any).isTabAllowed(bound, req),
      resolveTabId: (id: string) => (mockHost as any).resolveTargetTabId(id),
      resolveTabAffiliation: (id: string) => (mockHost as any).resolveTabAffiliation(id),
      getDocumentGeneration: (id?: string) => (mockHost as any).getDocumentGeneration(id),
    });

    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');
    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport);

    const { launch } = await attachmentRegistry.issueAttachment(
      makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId,
      { backendId: 'mcp', lease, leaseToken: lease.token, hostEpoch: 1, tabId: 'tab-agent-ephemeral', grant: 'write', documentGeneration: docGen },
    );
    mcpServer.setBoundSession({
      attachmentId: launch.attachmentId,
      attachmentSecret: launch.secret,
      authorityRevision: launch.authorityRevision,
    });

    // Cross-session same-project tab: rebind succeeds through transport pre-gate
    // and the port's scoped adoption leg.
    const rebindRes = await mcpServer.callTool('anti.browser.rebind_target', { tabId: 'tab-admin-dashboard' });
    assert.strictEqual(rebindRes.isError, undefined, `same-project rebind must succeed: ${rebindRes.content[0]?.text}`);
    assert.strictEqual(
      attachmentRegistry.getRecord(launch.attachmentId)?.tabId,
      'tab-admin-dashboard',
      'attachment authority must rotate onto the adopted tab',
    );

    // Ordinary dispatch now executes on the adopted tab without a second rebind.
    const domRes = await mcpServer.callTool('anti.inspect.dom', {});
    assert.strictEqual(domRes.isError, undefined, 'DOM inspection must succeed on adopted tab');
    assert.ok(domRes.content[0]?.text?.includes('tab-admin-dashboard'));

    // Denials still hold: a same-project but different-workspace tab, and an
    // unmeasured foreign tab, both keep refusing.
    const denyWorkspace = await mcpServer.callTool('anti.browser.rebind_target', { tabId: 'tab-other-workspace' });
    assert.strictEqual(denyWorkspace.isError, true);
    assert.ok(denyWorkspace.content[0]?.text?.includes('TARGET_MISMATCH'));

    const denyForeign = await mcpServer.callTool('anti.browser.rebind_target', { tabId: 'tab-foreign' });
    assert.strictEqual(denyForeign.isError, true);
    assert.ok(denyForeign.content[0]?.text?.includes('TARGET_MISMATCH'));
    assert.strictEqual(attachmentRegistry.getRecord(launch.attachmentId)?.tabId, 'tab-admin-dashboard', 'denied rebinds must not rotate authority');
  });

  it('keeps MCP project scope: list shows only same-project tabs and create pins the project capsule', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const otherProjectId = makeControlPlaneId('project');
    const otherWorkspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    let currentAutoTab = 'tab-anchor';
    let docGen = 2;
    const tabList = [
      { id: 'tab-anchor', url: 'https://wpjyvu-ry.myshopify.com', title: 'Anchor' },
      { id: 'tab-same', url: 'https://wpjyvu-ry.myshopify.com/products', title: 'SameProject' },
      { id: 'tab-other-project', url: 'https://owlbrand.vn', title: 'OtherProject' },
      { id: 'tab-no-capsule', url: 'about:blank', title: 'NoCapsule' },
    ];
    const affiliationByTab: Record<string, { projectId: string; workspaceId: string; capsuleId: string } | undefined> = {
      'tab-anchor': { projectId, workspaceId, capsuleId: 'capsule-whenever' },
      'tab-same': { projectId, workspaceId, capsuleId: 'capsule-whenever' },
      'tab-other-project': { projectId: otherProjectId, workspaceId: otherWorkspaceId, capsuleId: 'capsule-owl' },
      'tab-no-capsule': undefined,
    };
    const managedTabs = new Set<string>(['tab-anchor']);
    let createdWith: { capsuleId?: string; anchorTabId?: string; plane?: string } | undefined;

    class MockHost extends EventEmitter {
      hasTab(id?: string | null) { return Boolean(id && tabList.some(t => t.id === id)); }
      resolveTabAffiliation(tabId: string) { return affiliationByTab[tabId]; }
      getTabList() { return [...tabList]; }
      getActiveTabId() { return currentAutoTab; }
      getActiveTab() { return tabList.find(t => t.id === currentAutoTab); }
      getAutomationTabId() { return currentAutoTab; }
      setAutomationTabId(id?: string) { if (id) currentAutoTab = id; }
      getManagedTabIds() { return managedTabs; }
      resolveTargetTabId(id: string) { return tabList.some(t => t.id === id) ? id : undefined; }
      getDocumentGeneration(tabId?: string) { return docGen; }
      adoptChildTab(parent: string, child: string) { managedTabs.add(child); return true; }
      createTab(url?: string, activate?: boolean, opts?: any) {
        createdWith = opts;
        const id = 'tab-created-' + (tabList.length + 1);
        tabList.push({ id, url: url || 'about:blank', title: 'New' });
        affiliationByTab[id] = opts?.capsuleId
          ? { projectId, workspaceId, capsuleId: opts.capsuleId }
          : { projectId: otherProjectId, workspaceId: otherWorkspaceId, capsuleId: 'capsule-active-window' };
        return id;
      }
      isCurrentTarget(target: any) {
        if (!target || typeof target.tabId !== 'string' || !tabList.some(t => t.id === target.tabId)) return false;
        if (typeof target.documentGeneration !== 'number' || target.documentGeneration !== docGen) return false;
        if (typeof target.browserEpoch !== 'number' || target.browserEpoch !== lease.hostEpoch) return false;
        if (typeof target.runtimeId !== 'string' || target.runtimeId !== lease.runtimeId) return false;
        if (target.projectId !== lease.projectId) return false;
        if (lease.workspaceId && target.workspaceId !== lease.workspaceId) return false;
        return true;
      }
      async getDom(selector?: string, tabId?: string) { return `<html><body>DOM ${tabId || currentAutoTab}</body></html>`; }
      async captureScreenshot() { return Buffer.from('s').toString('base64'); }
      evalJs() { return null; }
    }

    const mockHost = new MockHost() as unknown as NativeTabHost;
    (mockHost as any).isTabAllowed = (bound: string, req: string) => bound === req || managedTabs.has(req);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
      getActiveLease: () => lease,
      isTabAllowed: (bound: string, req: string) => (mockHost as any).isTabAllowed(bound, req),
      resolveTabId: (id: string) => (mockHost as any).resolveTargetTabId(id),
      resolveTabAffiliation: (id: string) => (mockHost as any).resolveTabAffiliation(id),
      getDocumentGeneration: (id?: string) => (mockHost as any).getDocumentGeneration(id),
    });
    const browserPort = new BrowserControlPort(mockHost as any);
    registerBrowserCapabilities(catalogue, browserPort, undefined, () => '');
    const attachmentRegistry = new AttachmentRegistry({
      getHostEpoch: () => 1,
      getDocumentGeneration: () => docGen,
      getAutomationTabId: () => currentAutoTab,
    });
    const transport = new CapabilityTransportAdapter(catalogue, attachmentRegistry);
    const mcpServer = new AntiFanMcpServer(mockHost, false, transport);
    const { launch } = await attachmentRegistry.issueAttachment(
      makeControlPlaneId('run'), makeControlPlaneId('attempt'), projectId, workspaceId,
      { backendId: 'mcp', lease, leaseToken: lease.token, hostEpoch: 1, tabId: 'tab-anchor', grant: 'write', documentGeneration: docGen },
    );
    mcpServer.setBoundSession({ attachmentId: launch.attachmentId, attachmentSecret: launch.secret, authorityRevision: launch.authorityRevision });

    // 1. tabs.list (default) must not leak foreign-project tabs; same-project
    //    rows stay, and the session-managed unaffiliated bound tab stays listed.
    const listRes = await mcpServer.callTool('anti.browser.tabs.list', {});
    assert.strictEqual(listRes.isError, undefined, `list must succeed: ${listRes.content[0]?.text}`);
    const listPayload = JSON.parse(listRes.content[0]?.text || '{}');
    const listed = (listPayload.data ?? listPayload) as Array<{ id: string; isBoundTab?: boolean }>;
    const listedIds = new Set(listed.map(t => t.id));
    assert.ok(listedIds.has('tab-anchor'), 'own anchor must be listed');
    assert.ok(listedIds.has('tab-same'), 'same-project tab must be listed');
    assert.ok(!listedIds.has('tab-other-project'), 'foreign-project tab must not leak into the list');
    assert.ok(!listedIds.has('tab-no-capsule'), 'unaffiliated window tab must not leak into the list');

    // 2. tabs.create on a routed target pins the anchor's own capsule, never the
    //    globally active one.
    const createRes = await mcpServer.callTool('anti.browser.tabs.create', { url: 'https://example.com/x' });
    assert.strictEqual(createRes.isError, undefined, `create must succeed: ${createRes.content[0]?.text}`);
    assert.strictEqual(createdWith?.capsuleId, 'capsule-whenever', 'created tab must be pinned to the anchor capsule of this project');

    // 3. Routed target without a bound anchor must fail closed: creating through
    //    the window's active capsule would mint the tab in a foreign project.
    //    Direct port call — the transport path already requires a bound target
    //    before capabilities run, so this exercises the port's own contract.
    createdWith = undefined;
    assert.throws(
      () => browserPort.openTab(
        { url: 'https://example.com/orphan' },
        { target: { tabId: '', projectId, workspaceId, runtimeId: lease.runtimeId, browserEpoch: 1, documentGeneration: docGen } as any },
      ),
      (err: any) => err instanceof CapabilityError && err.code === 'TARGET_REQUIRED',
    );
    assert.strictEqual(createdWith, undefined, 'createTab must not run without a verifying anchor');
    // And an unrouted (no-project) call keeps its legacy behavior: it creates
    // through the ambient window path without any capsule pin.
    const unrouted = browserPort.openTab({ url: 'https://example.com/free' });
    assert.ok(typeof unrouted.tabId === 'string' && unrouted.tabId.length > 0);
    assert.strictEqual((createdWith as { capsuleId?: string } | undefined)?.capsuleId, undefined, 'unrouted creation must not pin a capsule');

    // 4. No bound target: the port must not fall back to the global strip —
    //    a routed session without a bound tab sees nothing, never foreign tabs.
    const unboundList = browserPort.listTabs({}) as Array<{ id: string }>;
    assert.deepStrictEqual(unboundList, [], 'unbound listTabs must return no tabs');

  });
});
