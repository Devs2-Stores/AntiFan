import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities, legacyContext } from '../../src/main/tools/browser-capabilities';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { AntiFanMcpServer, buildMcpToolList } from '../../src/main/mcp/mcp-server';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { DEVICE_PRESETS } from '../../src/main/browser/device-presets';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId, BrowserTarget } from '../../src/shared/control-plane-contracts';
describe('Capability catalogue', () => {
  it('uses one lease/policy-aware catalogue and fails closed on missing target/grant', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    catalogue.register({ name: 'read', description: 'read', risk: 'read', inputSchema: { type: 'object' }, execute: () => 'ok' });
    catalogue.register({ name: 'write', description: 'write', risk: 'write', inputSchema: { type: 'object' }, execute: () => 'written' });
    assert.strictEqual(await catalogue.dispatch('read', {}, { lease, leaseToken: lease.token, projectId, workspaceId }), 'ok');
    await assert.rejects(() => catalogue.dispatch('write', {}, { lease, leaseToken: lease.token, projectId, workspaceId }), (error: unknown) => error instanceof CapabilityError && error.code === 'POLICY_DENIED');
    assert.strictEqual(await catalogue.dispatch('write', {}, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' }), 'written');
    catalogue.beginDrain();
    await assert.rejects(() => catalogue.dispatch('read', {}, { lease, leaseToken: lease.token, projectId, workspaceId }), (error: unknown) => error instanceof CapabilityError && error.code === 'RUNTIME_DRAINING');
  });

  it('rejects a caller-forged lease even when its token is self-consistent', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const activeLease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: activeLease.runtimeId, hostEpoch: 1, getActiveLease: () => activeLease });
    catalogue.register({ name: 'read', description: 'read', risk: 'read', inputSchema: { type: 'object' }, execute: () => 'ok' });
    const forged = { ...activeLease, token: 'f'.repeat(64), expiresAt: activeLease.expiresAt + 10_000 };
    await assert.rejects(() => catalogue.dispatch('read', {}, { lease: forged, leaseToken: forged.token, projectId, workspaceId }), (error: unknown) => error instanceof CapabilityError && error.code === 'UNAUTHENTICATED');
  });

  it('rejects a lease from a different runtimeId when constructed without getActiveLease', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const runtimeLease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const differentRuntimeLease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: runtimeLease.runtimeId, hostEpoch: 1 });
    catalogue.register({ name: 'read', description: 'read', risk: 'read', inputSchema: { type: 'object' }, execute: () => 'ok' });
    await assert.rejects(() => catalogue.dispatch('read', {}, { lease: differentRuntimeLease, leaseToken: differentRuntimeLease.token, projectId, workspaceId }), (error: unknown) => error instanceof CapabilityError && error.code === 'RUNTIME_MISMATCH');
  });
  it('registers and dispatches full suite of browser capabilities and compatibility aliases', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });

    let openedUrl = '';
    let closedTabId = '';
    let switchedTabId = '';
    let movedParams: unknown = null;
    let navigatedTabId = '';
    let navigatedUrl = '';
    let trajectoryParams: unknown = null;
    let viewportOptions: unknown = null;
    let presetTabId = '';
    let presetName = '';
    let zoomTabId = '';
    let zoomValue = 0;
    const mockHost = {
      getTabList: () => [{ id: 'tab-1', url: 'https://example.com' }, { id: 'tab-2', url: 'https://other.com' }],
      getActiveTabId: () => 'tab-1',
      createTab: (url?: string, activate?: boolean) => { openedUrl = `${url || ''}|activate=${activate}`; return 'tab-new'; },
      closeTab: (tabId: string) => { closedTabId = tabId; return true; },
      switchTab: (tabId: string) => {
        if (tabId === 'tab-invalid') return false;
        switchedTabId = tabId;
        return true;
      },
      navigate: (tabId: string, url: string) => { navigatedTabId = tabId; navigatedUrl = url; return true; },
      reload: () => true,
      getDom: async () => '<html>ok</html>',
      captureScreenshot: async () => 'base64img',
      evalJs: async () => 'res',
      getDiagnostics: () => ({ console: [], failures: [] }),
      runResponsiveCheck: async () => ({ ok: true }),
      agentMove: async (p: unknown) => { movedParams = p; return true; },
      agentClick: async () => true,
      agentType: async () => true,
      agentScroll: async () => true,
      agentHover: async () => true,
      agentHighlight: async () => true,
      agentClear: async () => true,
      agentSnapshot: async () => 'tree',
      agentTrajectory: async (p: unknown) => { trajectoryParams = p; return { success: true, executedSteps: 1, totalSteps: 1 }; },
      setViewportSize: (options: unknown) => { viewportOptions = options; return true; },
      setDevicePreset: (tabId: string, presetId: string) => { presetTabId = tabId; presetName = presetId; return true; },
      getDevicePresets: () => [{ id: 'iphone-16-pro', name: 'iPhone 16 Pro', width: 393, height: 852, mobile: true }],
      setZoom: (tabId: string, zoomFactor: number) => { zoomTabId = tabId; zoomValue = zoomFactor; return true; },
      toggleInspect: () => true,
    };
    const browser = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browser);

    // 1. List tabs (read)
    const tabs = await catalogue.dispatch('browser.list-tabs', {}, { lease, leaseToken: lease.token, projectId, workspaceId });
    assert.deepStrictEqual(tabs, [{ id: 'tab-1', url: 'https://example.com' }, { id: 'tab-2', url: 'https://other.com' }]);

    // 2. Open tab (write)
    const openRes = await catalogue.dispatch('browser.open-tab', { url: 'https://antifan.test' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' });
    assert.deepStrictEqual(openRes, { tabId: 'tab-new' });
    assert.strictEqual(openedUrl, 'https://antifan.test|activate=false');

    // 3. Alias antifan_open_tab (write)
    const aliasOpen = await catalogue.dispatch('antifan_open_tab', { url: 'https://alias.test' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' });
    assert.deepStrictEqual(aliasOpen, { tabId: 'tab-new' });
    assert.strictEqual(openedUrl, 'https://alias.test|activate=false');

    // 4. Close tab & Switch tab
    await catalogue.dispatch('browser.close-tab', { tabId: 'tab-1' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' });
    assert.strictEqual(closedTabId, 'tab-1');
    await catalogue.dispatch('browser.switch-tab', { tabId: 'tab-2' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' });
    assert.strictEqual(switchedTabId, 'tab-2');

    // 5. Missing target rejection & Agent move with target
    await assert.rejects(
      () => catalogue.dispatch('browser.agent-move', { x: 100, y: 200, label: 'test' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED'
    );
    const boundTarget: BrowserTarget = { projectId, workspaceId, runtimeId: lease.runtimeId, browserEpoch: 1, documentGeneration: 1, tabId: 'tab-1' };
    await catalogue.dispatch('browser.agent-move', { x: 100, y: 200, label: 'test' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget });
    assert.deepStrictEqual(movedParams, { x: 100, y: 200, label: 'test', tabId: 'tab-1' });
    // 6. Diagnostics
    const diag = await catalogue.dispatch('browser.diagnostics', { tabId: 'tab-1' }, { lease, leaseToken: lease.token, projectId, workspaceId });
    assert.deepStrictEqual(diag, { console: [], failures: [] });

    // 7. Toggle inspect
    const inspect = await catalogue.dispatch('antifan_toggle_inspect', {}, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write' });
    assert.deepStrictEqual(inspect, { inspecting: true });

    // 8. Navigation with explicit tabId auto-switching
    const navResult = await catalogue.dispatch('browser.navigate', { url: 'https://apshop.vn', tabId: 'tab-2' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget });
    assert.deepStrictEqual(navResult, { navigated: true, target: { ...boundTarget, tabId: 'tab-2' } });
    assert.strictEqual(switchedTabId, 'tab-2');
    assert.strictEqual(navigatedTabId, 'tab-2');
    assert.strictEqual(navigatedUrl, 'https://apshop.vn');

    // 9. Rejection on invalid explicit tabId
    await assert.rejects(
      () => catalogue.dispatch('browser.navigate', { url: 'https://apshop.vn', tabId: 'tab-invalid' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget }),
      (error: unknown) => error instanceof CapabilityError && error.code === 'CAPABILITY_NOT_FOUND'
    );

    // 10. Agent trajectory registration and execution with tabId
    const trajResult = await catalogue.dispatch('browser.agent-trajectory', { steps: [{ action: 'move', x: 50, y: 50 }], tabId: 'tab-2' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget });
    assert.deepStrictEqual(trajResult, { success: true, executedSteps: 1, totalSteps: 1 });
    assert.strictEqual(switchedTabId, 'tab-2');

    // 11. Viewport and Mobile Device Emulation
    const vpRes = await catalogue.dispatch('browser.set-viewport', { width: 390, height: 844, mobile: true, tabId: 'tab-2' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget });
    assert.deepStrictEqual(vpRes, { success: true, width: 390, height: 844, mobile: true, presetId: 'custom-390x844' });
    assert.deepStrictEqual(viewportOptions, { width: 390, height: 844, mobile: true, tabId: 'tab-2' });

    // 12. Device Preset
    const presetRes = await catalogue.dispatch('browser.set-device-preset', { presetId: 'iphone-16-pro', tabId: 'tab-2' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget });
    assert.deepStrictEqual(presetRes, { success: true, presetId: 'iphone-16-pro' });
    assert.strictEqual(presetTabId, 'tab-2');
    assert.strictEqual(presetName, 'iphone-16-pro');

    // 13. List Device Presets
    const presetsRes = await catalogue.dispatch('browser.list-device-presets', {}, { lease, leaseToken: lease.token, projectId, workspaceId });
    assert.deepStrictEqual(presetsRes, [{ id: 'iphone-16-pro', name: 'iPhone 16 Pro', width: 393, height: 852, mobile: true }]);

    // 14. Set Zoom
    const zoomRes = await catalogue.dispatch('browser.set-zoom', { zoomFactor: 1.5, tabId: 'tab-2' }, { lease, leaseToken: lease.token, projectId, workspaceId, grant: 'write', browserTarget: boundTarget });
    assert.deepStrictEqual(zoomRes, { success: true, zoomFactor: 1.5 });
    assert.strictEqual(zoomTabId, 'tab-2');
    assert.strictEqual(zoomValue, 1.5);

    // 15. Verify input schemas expose tabId and properties
    const navSchema = catalogue.get('browser.navigate')?.inputSchema as { properties?: Record<string, unknown> };
    const domSchema = catalogue.get('browser.dom')?.inputSchema as { properties?: Record<string, unknown> };
    const ssSchema = catalogue.get('browser.screenshot')?.inputSchema as { properties?: Record<string, unknown> };
    const clickSchema = catalogue.get('browser.agent-click')?.inputSchema as { properties?: Record<string, unknown> };
    const trajSchema = catalogue.get('browser.agent-trajectory')?.inputSchema as { properties?: Record<string, unknown> };
    const vpSchema = catalogue.get('browser.set-viewport')?.inputSchema as { properties?: Record<string, unknown> };
    const dpSchema = catalogue.get('browser.set-device-preset')?.inputSchema as { properties?: Record<string, unknown> };
    assert.ok(navSchema?.properties?.tabId, 'browser.navigate must expose tabId in schema');
    assert.ok(domSchema?.properties?.tabId, 'browser.dom must expose tabId in schema');
    assert.ok(ssSchema?.properties?.tabId, 'browser.screenshot must expose tabId in schema');
    assert.ok(clickSchema?.properties?.tabId, 'browser.agent-click must expose tabId in schema');
    assert.ok(trajSchema?.properties?.tabId, 'browser.agent-trajectory must expose tabId in schema');
    assert.ok(vpSchema?.properties?.tabId, 'browser.set-viewport must expose tabId in schema');
    assert.ok(dpSchema?.properties?.tabId, 'browser.set-device-preset must expose tabId in schema');
  });

  it('verifies production index.ts wires all required browser and responsive control methods', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const indexSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/main/index.ts'), 'utf8');
    const requiredBindings = [
      'getTabList',
      'getActiveTabId',
      'createTab',
      'closeTab',
      'switchTab',
      'navigate',
      'reload',
      'getDom',
      'captureScreenshot',
      'evalJs',
      'getDiagnostics',
      'runResponsiveCheck',
      'agentTrajectory',
      'agentMove',
      'agentClick',
      'agentType',
      'agentScroll',
      'agentHover',
      'agentHighlight',
      'agentClear',
      'agentSnapshot',
      'sendKeyboardPress',
      'setViewportSize',
      'setDevicePreset',
      'getDevicePresets',
      'setZoom',
      'toggleInspect',
      'isCurrentTarget',
    ];
    for (const binding of requiredBindings) {
      assert.ok(indexSrc.includes(`${binding}:`), `src/main/index.ts must bind ${binding} in BrowserControlPort`);
    }
  });

  it('verifies device presets catalog and mobile emulation parameters', async () => {
    assert.ok(Array.isArray(DEVICE_PRESETS));

    const iphone16 = DEVICE_PRESETS.find((p) => p.id === 'iphone-16-pro');
    assert.ok(iphone16);
    assert.strictEqual(iphone16?.category, 'mobile');
    assert.strictEqual(iphone16?.width, 393);
    assert.strictEqual(iphone16?.height, 852);
    assert.strictEqual(iphone16?.mobile, true);

    const ipad = DEVICE_PRESETS.find((p) => p.id === 'ipad-pro-12');
    assert.ok(ipad);
    assert.strictEqual(ipad?.category, 'tablet');
    assert.strictEqual(ipad?.width, 1024);
    assert.strictEqual(ipad?.height, 1366);

    const responsive = DEVICE_PRESETS.find((p) => p.id === 'responsive');
    assert.ok(responsive);
    assert.strictEqual(responsive?.category, 'responsive');
  });

  it('verifies MCP tools/list discovery includes all responsive and viewport tool aliases', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    let currentZoom = 1.0;
    let automationTabId: string | undefined;
    const mockHost = {
      getTabList: () => [{ id: 'tab-1', url: 'https://example.com', title: 'Example' }],
      getActiveTab: () => ({ id: 'tab-1', url: 'https://example.com', title: 'Example' }),
      getActiveTabId: () => 'tab-1',
      setAutomationTabId: (tabId?: string) => { automationTabId = tabId; },
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      setZoom: (_tabId: string, zoom: number) => {
        currentZoom = zoom;
        return true;
      },
    };
    const browser = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browser);

    const transport = new CapabilityTransportAdapter(catalogue);
    
    // 1. Verify grant-level isolation: read grant returns read tools and excludes write tools
    const readListed = transport.list({ grant: 'read' }).map((t: { name: string }) => t.name);
    assert.ok(readListed.includes('antifan_list_device_presets'), 'antifan_list_device_presets must be in read list');
    assert.ok(!readListed.includes('antifan_set_viewport'), 'antifan_set_viewport (write) must not be in read list');

    // 2. Verify write grant returns write tools
    const writeListed = transport.list({ grant: 'write' }).map((t: { name: string }) => t.name);
    assert.ok(writeListed.includes('antifan_set_viewport'), 'antifan_set_viewport must be in write list');
    assert.ok(writeListed.includes('antifan_set_device_preset'), 'antifan_set_device_preset must be in write list');
    assert.ok(writeListed.includes('antifan_set_zoom'), 'antifan_set_zoom must be in write list');

    // 3. Verify server-level AntiFanMcpServer.listTools() returns all aliases via grant union
    const registry = new AttachmentRegistry();
    const mcpServer = new AntiFanMcpServer(mockHost as any, false, transport, registry);
    const serverResult = await mcpServer.listTools();
    const serverToolNames = serverResult.tools.map((t) => t.name);

    assert.ok(serverToolNames.includes('antifan_set_viewport'));
    assert.ok(serverToolNames.includes('antifan_set_device_preset'));
    assert.ok(serverToolNames.includes('antifan_list_device_presets'));
    assert.ok(serverToolNames.includes('antifan_set_zoom'));
    assert.ok(serverToolNames.includes('anti.browser.viewport.set'));
    assert.ok(serverToolNames.includes('anti.browser.set_device'));
    assert.ok(serverToolNames.includes('anti.browser.viewport.set_preset'));
    assert.ok(serverToolNames.includes('anti.browser.viewport.list_presets'));
    assert.ok(serverToolNames.includes('anti.browser.set_zoom'));
    assert.ok(serverToolNames.includes('anti.browser.zoom.set'));

    // 4. Verify listTools() returns empty list when transport is omitted
    const fallbackServer = new AntiFanMcpServer(mockHost as any, false);
    const fallbackResult = await fallbackServer.listTools();
    assert.strictEqual(fallbackResult.tools.length, 0, 'Must return empty tool list when transport is omitted');

    // 5. Test MCP callTool without transport or attachment fails closed
    const unauthCall = await fallbackServer.callTool('anti.browser.set_zoom', { zoomFactor: 2.0, tabId: 'tab-1' });
    assert.strictEqual(unauthCall.isError, true);
    assert.ok(unauthCall.content?.[0]?.text?.includes('MCP_CONTEXT_REQUIRED'));

    const noAttachmentCall = await mcpServer.callTool('anti.browser.set_zoom', { zoomFactor: 2.0, tabId: 'tab-1' });
    assert.strictEqual(noAttachmentCall.isError, true);
    assert.ok(noAttachmentCall.content?.[0]?.text?.includes('ATTACHMENT_REQUIRED'));

    // 6. Test valid MCP callTool with authoritative attachment
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-1',
      backendId: 'codex',
    });

    const validCall = await mcpServer.callTool('anti.browser.set_zoom', {
      zoomFactor: 2.0,
      tabId: 'tab-1',
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-1',
        invocationId: 'inv-zoom-1',
      },
    });
    assert.strictEqual(currentZoom, 2.0);

    const outOfBoundsCall = await mcpServer.callTool('anti.browser.set_zoom', {
      zoomFactor: 0.1,
      tabId: 'tab-1',
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-1',
        invocationId: 'inv-zoom-2',
      },
    });
    assert.strictEqual(outOfBoundsCall.isError, true);
    assert.ok(outOfBoundsCall.content?.[0]?.text?.includes('between 0.25 and 5.0'));
  });

  it('rejects direct unauthenticated MCP actions and enforces attachment validation', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    let markedTabId: string | undefined;
    let automationTabId: string | undefined;
    let clickResult = true;
    const mockHost = {
      getTabList: () => [{ id: 'tab-active', url: 'https://example.com', title: 'Example', isAgentControlled: automationTabId === 'tab-active' }],
      getActiveTab: () => ({ id: 'tab-active', url: 'https://example.com', title: 'Example', isAgentControlled: automationTabId === 'tab-active' }),
      getActiveTabId: () => 'tab-active',
      setAutomationTabId: (tabId?: string) => { automationTabId = tabId; },
      markTabAgentWorking: (tabId?: string) => { markedTabId = tabId; },
      navigate: () => true,
      reload: () => true,
      getDom: async () => '',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      agentClick: async () => clickResult,
    };
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    const browser = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browser);
    const registry = new AttachmentRegistry();
    const transport = new CapabilityTransportAdapter(catalogue);
    const server = new AntiFanMcpServer(mockHost as any, false, transport, registry);

    // Call without attachment fails closed
    const unauth = await server.callTool('antifan_agent_click', { selector: '#submit' });
    assert.strictEqual(unauth.isError, true);
    assert.ok(unauth.content?.[0]?.text?.includes('ATTACHMENT_REQUIRED'));
    assert.strictEqual(automationTabId, undefined);

    // Call with valid attachment executes
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-active',
      backendId: 'codex',
      browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-active', browserEpoch: 1, documentGeneration: 1 },
    });
    const success = await server.callTool('antifan_agent_click', {
      selector: '#submit',
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-active',
        invocationId: 'inv-click-1',
      },
    });
    assert.strictEqual(success.isError, undefined);
  });

  it('uses canonical transport agent names with attachment verification', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    let automationTabId: string | undefined;
    let keyboardSuccess = true;
    let clickSuccess = true;
    const mockHost = {
      getTabList: () => [{ id: 'tab-active', url: 'https://example.com', title: 'Example' }],
      getActiveTab: () => ({ id: 'tab-active', url: 'https://example.com', title: 'Example' }),
      getActiveTabId: () => 'tab-active',
      setAutomationTabId: (tabId?: string) => { automationTabId = tabId; },
      markTabAgentWorking: () => {},
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      sendKeyboardPress: async ({ tabId }: { tabId?: string }) => ({ success: keyboardSuccess, key: 'Enter', modifiers: [], tabId }),
      agentClick: async () => clickSuccess,
    };
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    const browser = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browser);
    const registry = new AttachmentRegistry();
    const server = new AntiFanMcpServer(mockHost as any, false, new CapabilityTransportAdapter(catalogue), registry);
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-active',
      backendId: 'codex',
      browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-active', browserEpoch: 1, documentGeneration: 1 },
    });
    const keyboard = await server.callTool('browser.keyboard-press', {
      key: 'Enter',
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-active',
        invocationId: 'inv-kb-1',
      },
    });
    assert.strictEqual(keyboard.isError, undefined);

    const click = await server.callTool('browser.agent-click', {
      selector: '#submit',
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-active',
        invocationId: 'inv-click-2',
      },
    });
    assert.strictEqual(click.isError, undefined);
  });
  it('rejects stale bound targets before both DOM reads and agent actions', async () => {
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    let agentCalls = 0;
    const mockHost = {
      getTabList: () => [{ id: 'tab-active', url: 'https://example.com', title: 'Example' }],
      getActiveTabId: () => 'tab-active',
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html>must not execute</html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      agentClick: async () => { agentCalls += 1; return true; },
      isCurrentTarget: () => false,
    };
    const catalogue = new CapabilityCatalogue({ runtime: { mode: 'standalone', lifecycle: 'active' }, projectId, workspaceId, runtimeId: lease.runtimeId, hostEpoch: 1 });
    const browser = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, browser);
    const registry = new AttachmentRegistry();
    const server = new AntiFanMcpServer(mockHost as any, false, new CapabilityTransportAdapter(catalogue), registry);
    const runId = makeControlPlaneId('run');
    const attemptId = makeControlPlaneId('attempt');
    const { launch } = registry.issueAttachment(runId, attemptId, projectId, workspaceId, {
      lease,
      leaseToken: lease.token,
      hostEpoch: 1,
      grant: 'write',
      tabId: 'tab-active',
      backendId: 'codex',
      browserTarget: { projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-active', browserEpoch: 1, documentGeneration: 1 },
    });
    const dom = await server.callTool('browser.dom', {
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-active',
        invocationId: 'inv-dom-stale',
      },
    });
    assert.strictEqual(dom.isError, true);
    assert.match(dom.content[0]?.text || '', /TARGET_STALE/);

    const agent = await server.callTool('browser.agent-click', {
      selector: '#submit',
      attachmentClaims: {
        attachmentId: launch.attachmentId,
        attachmentSecret: launch.secret,
        runId,
        attemptId,
        projectId,
        workspaceId,
        tabId: 'tab-active',
        invocationId: 'inv-click-stale',
      },
    });
    assert.strictEqual(agent.isError, true);
    assert.match(agent.content[0]?.text || '', /TARGET_STALE/);
    assert.strictEqual(agentCalls, 0);
  });

  it('enforces zoom boundaries (0.25 to 5.0) and validates boundary conditions', async () => {
    let currentZoom = 1.0;
    const mockHost = {
      getTabList: () => [{ id: 'tab-active', url: 'https://example.com' }],
      getActiveTabId: () => 'tab-active',
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      setZoom: (_tabId: string, zoom: number) => {
        currentZoom = zoom;
        return true;
      },
    };
    const browser = new BrowserControlPort(mockHost);

    // Valid boundaries
    const minZoom = browser.setZoom({ zoomFactor: 0.25, tabId: 'tab-active' });
    assert.strictEqual(minZoom.success, true);
    assert.strictEqual(minZoom.zoomFactor, 0.25);
    assert.strictEqual(currentZoom, 0.25);

    const maxZoom = browser.setZoom({ zoomFactor: 5.0, tabId: 'tab-active' });
    assert.strictEqual(maxZoom.success, true);
    assert.strictEqual(maxZoom.zoomFactor, 5.0);
    assert.strictEqual(currentZoom, 5.0);

    const midZoom = browser.setZoom({ zoomFactor: 1.5, tabId: 'tab-active' });
    assert.strictEqual(midZoom.success, true);
    assert.strictEqual(midZoom.zoomFactor, 1.5);
    assert.strictEqual(currentZoom, 1.5);

    // Out of bounds: < 0.25, > 5.0, negative, zero, NaN
    assert.throws(() => browser.setZoom({ zoomFactor: 0.24, tabId: 'tab-active' }), (err: { code?: string }) => err.code === 'INVALID_ARGUMENT');
    assert.throws(() => browser.setZoom({ zoomFactor: 5.01, tabId: 'tab-active' }), (err: { code?: string }) => err.code === 'INVALID_ARGUMENT');
    assert.throws(() => browser.setZoom({ zoomFactor: -1.0, tabId: 'tab-active' }), (err: { code?: string }) => err.code === 'INVALID_ARGUMENT');
    assert.throws(() => browser.setZoom({ zoomFactor: 0, tabId: 'tab-active' }), (err: { code?: string }) => err.code === 'INVALID_ARGUMENT');
    assert.throws(() => browser.setZoom({ zoomFactor: NaN, tabId: 'tab-active' }), (err: { code?: string }) => err.code === 'INVALID_ARGUMENT');
  });

  it('unconditionally forwards resolved target tabId to host for non-active target tabs', async () => {
    const calls: Array<{ method: string; tabId?: string; params?: unknown }> = [];
    const mockHost = {
      getTabList: () => [
        { id: 'tab-active', url: 'https://example.com/active' },
        { id: 'tab-background', url: 'https://example.com/bg' },
      ],
      getActiveTabId: () => 'tab-active',
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      agentTrajectory: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentTrajectory', tabId: args.tabId, params: args });
        return { success: true };
      },
      agentMove: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentMove', tabId: args.tabId, params: args });
        return true;
      },
      agentClick: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentClick', tabId: args.tabId, params: args });
        return true;
      },
      agentType: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentType', tabId: args.tabId, params: args });
        return true;
      },
      agentScroll: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentScroll', tabId: args.tabId, params: args });
        return true;
      },
      agentHover: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentHover', tabId: args.tabId, params: args });
        return true;
      },
      agentHighlight: async (args: { tabId?: string }) => {
        calls.push({ method: 'agentHighlight', tabId: args.tabId, params: args });
        return true;
      },
      agentClear: async (tabId?: string) => {
        calls.push({ method: 'agentClear', tabId });
        return true;
      },
      agentSnapshot: async (tabId?: string) => {
        calls.push({ method: 'agentSnapshot', tabId });
        return '<snapshot/>';
      },
    };

    const browser = new BrowserControlPort(mockHost);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);
    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-background',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // 1. Direct BrowserControlPort target-bound calls without explicit args.tabId
    await browser.agentClick({ selector: '#btn' }, target);
    await browser.agentType({ selector: '#input', text: 'hello' }, target);
    await browser.agentMove({ selector: '#header' }, target);
    await browser.agentScroll({ deltaY: 200 }, target);
    await browser.agentHover({ selector: '#menu' }, target);
    await browser.agentHighlight({ selector: '#item' }, target);
    await browser.agentTrajectory({ steps: [{ type: 'click' }] }, target);
    await browser.agentClear(undefined, target);
    await browser.agentSnapshot(undefined, target);

    assert.strictEqual(calls.length, 9);
    for (const call of calls) {
      assert.strictEqual(call.tabId, 'tab-background', `${call.method} must forward tab-background instead of host active tab`);
    }

    // 2. CapabilityCatalogue dispatched calls with context.browserTarget
    calls.length = 0;
    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);
    const ctx = legacyContext(target, lease);
    ctx.grant = 'write';
    await catalogue.dispatch('browser.agent-click', { selector: '#btn' }, ctx);
    await catalogue.dispatch('browser.agent-type', { selector: '#input', text: 'hi' }, ctx);
    await catalogue.dispatch('browser.agent-move', { selector: '#move' }, ctx);
    await catalogue.dispatch('browser.agent-clear', {}, ctx);
    ctx.grant = 'read';
    await catalogue.dispatch('browser.agent-snapshot', {}, ctx);
    assert.strictEqual(calls.length, 5);
    for (const call of calls) {
      assert.strictEqual(call.tabId, 'tab-background', `catalogue ${call.method} must forward target tab-background`);
    }

    // 3. Enforce missing target rejection across all target-bound agent capabilities & aliases
    const ctxNoTarget = { lease, leaseToken: lease.token, projectId: target.projectId, workspaceId: target.workspaceId, grant: 'write' as const };
    const targetBoundCapabilities = [
      'browser.agent-click',
      'browser.agent-type',
      'browser.agent-move',
      'browser.agent-scroll',
      'browser.agent-hover',
      'browser.agent-highlight',
      'browser.agent-clear',
      'browser.agent-trajectory',
      'antifan_agent_click',
      'antifan_agent_type',
      'antifan_agent_scroll',
      'antifan_agent_hover',
      'antifan_agent_highlight',
      'antifan_agent_clear',
      'antifan_agent_trajectory',
    ];
    for (const capName of targetBoundCapabilities) {
      await assert.rejects(
        () => catalogue.dispatch(capName, {}, ctxNoTarget),
        (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED',
        `Missing browserTarget must reject ${capName} with TARGET_REQUIRED`
      );
    }
    const ctxReadNoTarget = { ...ctxNoTarget, grant: 'read' as const };
    for (const capName of ['browser.agent-snapshot', 'antifan_agent_snapshot']) {
      await assert.rejects(
        () => catalogue.dispatch(capName, {}, ctxReadNoTarget),
        (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED',
        `Missing browserTarget must reject ${capName} with TARGET_REQUIRED`
      );
    }
  });

  it('auto-provisions dedicated isolated agent tab and enforces strict full BrowserTarget for capability execution', async () => {
    let automationTab: string | null = null;
    const tabs: Array<{ id: string; url: string }> = [
      { id: 'tab-user-active', url: 'https://user-website.com' },
    ];
    let createdUrl: string | undefined;
    let createdActivate: boolean | undefined;
    const dispatchedCalls: Array<{ method: string; tabId?: string; args?: unknown }> = [];

    const mockHost = {
      getTabList: () => tabs,
      getActiveTabId: () => 'tab-user-active',
      getAutomationTabId: () => automationTab,
      setAutomationTabId: (id?: string) => { automationTab = id || null; },
      createTab: (url = 'about:blank', activate = false) => {
        createdUrl = url;
        createdActivate = activate;
        const newId = `tab-agent-auto-${tabs.length + 1}`;
        tabs.push({ id: newId, url });
        return newId;
      },
      navigate: (tabId: string, url: string) => {
        dispatchedCalls.push({ method: 'navigate', tabId, args: { url } });
        const t = tabs.find((x) => x.id === tabId);
        if (t) t.url = url;
        return true;
      },
      captureScreenshot: async (_rect?: unknown, tabId?: string) => {
        dispatchedCalls.push({ method: 'screenshot', tabId });
        return `screenshot-of-${tabId}`;
      },
      agentClick: async (args: { tabId?: string; selector?: string }) => {
        dispatchedCalls.push({ method: 'agentClick', tabId: args.tabId, args });
        return true;
      },
      agentSnapshot: async (tabId?: string) => {
        dispatchedCalls.push({ method: 'agentSnapshot', tabId });
        return `<snapshot tab="${tabId}"/>`;
      },
    };

    const browser = new BrowserControlPort(mockHost as any);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const catalogue = new CapabilityCatalogue({
      runtime: { mode: 'standalone', lifecycle: 'active' },
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: 1,
    });
    registerBrowserCapabilities(catalogue, browser);

    // 1. Target with blank/empty fields strictly fails closed with TARGET_REQUIRED or TARGET_STALE before any tab provisioning
    await assert.rejects(
      async () => browser.navigate({} as any, 'https://new-url.com'),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_REQUIRED'
    );
    assert.strictEqual(tabs.length, 1); // No tab was created for empty target

    await assert.rejects(
      async () => browser.navigate({ projectId, workspaceId, runtimeId: lease.runtimeId, tabId: 'tab-agent-auto-2', browserEpoch: 0, documentGeneration: 1 } as any, 'https://new-url.com'),
      (error: unknown) => error instanceof CapabilityError && error.code === 'TARGET_STALE'
    );
    // 2. End-to-end catalogue.dispatch with target lacking tabId auto-provisions a background tab
    const targetWithoutTabId: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: undefined as any,
      browserEpoch: 1,
      documentGeneration: 1,
    };
    const ctx = {
      lease,
      leaseToken: lease.token,
      projectId,
      workspaceId,
      browserTarget: targetWithoutTabId,
      grant: 'write' as const,
    };

    // Agent click executes and auto-creates an isolated tab
    const clickRes = await catalogue.dispatch('browser.agent-click', { selector: '#login-btn' }, ctx);
    assert.deepStrictEqual(clickRes, { clicked: true });
    assert.strictEqual(automationTab, 'tab-agent-auto-2');
    assert.strictEqual(createdActivate, false); // Tab was created in the background without activating!
    assert.strictEqual(mockHost.getActiveTabId(), 'tab-user-active'); // User active tab is untouched!
    assert.strictEqual(dispatchedCalls[0]?.tabId, 'tab-agent-auto-2'); // Action was directed to agent tab

    // Read snapshot reuses the already provisioned automation tab
    const ctxRead = { ...ctx, grant: 'read' as const };
    const snapshotRes = await catalogue.dispatch('browser.agent-snapshot', {}, ctxRead);
    assert.deepStrictEqual(snapshotRes, { snapshot: '<snapshot tab="tab-agent-auto-2"/>' });
    assert.strictEqual(dispatchedCalls[1]?.tabId, 'tab-agent-auto-2');
    assert.strictEqual(tabs.find((x) => x.id === 'tab-user-active')?.url, 'https://user-website.com'); // User tab was NOT touched!
    assert.strictEqual(targetWithoutTabId.tabId, undefined); // Original target remains completely immutable!
  });

  it('enforces copied effective target validation on browser.navigate with explicit tabs, tabless targets, and stale targets', async () => {
    let hostNavigateCalls = 0;
    let createTabCalls = 0;
    let navigatedTab: string | null = null;
    let autoTab: string | null = null;
    const mockHost = {
      getTabList: () => [
        { id: 'tab-1', url: 'https://example.com' },
        { id: 'tab-2', url: 'https://example.com/2' },
        ...(autoTab ? [{ id: autoTab, url: 'about:blank' }] : []),
      ],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => autoTab || null,
      setAutomationTabId: (id?: string) => { autoTab = id || null; },
      createTab: (url: string, activate: boolean) => {
        createTabCalls++;
        autoTab = 'tab-auto-prov';
        return autoTab;
      },
      navigate: (tabId: string) => {
        hostNavigateCalls++;
        navigatedTab = tabId;
        return true;
      },
      reload: () => true,
      getDom: async () => '',
      captureScreenshot: async () => '',
      evalJs: async () => null,
      isCurrentTarget: (target: BrowserTarget) => {
        return target.browserEpoch === 1 && target.documentGeneration === 1;
      },
    };

    const browser = new BrowserControlPort(mockHost);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const tablessTarget: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: undefined as any,
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // 1. Tabless target with invalid generation rejects up front before createTab or navigate
    const invalidTablessTarget: BrowserTarget = { ...tablessTarget, documentGeneration: 0 };
    await assert.rejects(
      async () => browser.navigate(invalidTablessTarget, 'https://example.com/new'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.strictEqual(createTabCalls, 0, 'createTab must not be called when initial assertTarget fails');
    assert.strictEqual(hostNavigateCalls, 0, 'host.navigate must not be called when initial assertTarget fails');

    // 2. Tabless target with explicitTabId succeeds and returns updated target without mutating original target
    const nav1 = await browser.navigate(tablessTarget, 'https://example.com/new', 'tab-2');
    assert.strictEqual(nav1.navigated, true);
    assert.strictEqual(nav1.target.tabId, 'tab-2');
    assert.strictEqual(navigatedTab, 'tab-2');
    assert.strictEqual(hostNavigateCalls, 1);
    assert.strictEqual(tablessTarget.tabId, undefined, 'Original tabless target remains unmutated');

    // 3. Bound target (tab-1) with explicitTabId override (tab-2) succeeds without mutating original bound target
    const boundTarget: BrowserTarget = { ...tablessTarget, tabId: 'tab-1' };
    const nav2 = await browser.navigate(boundTarget, 'https://example.com/new', 'tab-2');
    assert.strictEqual(nav2.navigated, true);
    assert.strictEqual(nav2.target.tabId, 'tab-2');
    assert.strictEqual(navigatedTab, 'tab-2');
    assert.strictEqual(hostNavigateCalls, 2);
    assert.strictEqual(boundTarget.tabId, 'tab-1', 'Original bound target tabId remains unmutated');

    // 4. Stale target (documentGeneration = 2) must be rejected with TARGET_STALE before host.navigate
    const staleTarget: BrowserTarget = { ...tablessTarget, tabId: 'tab-1', documentGeneration: 2 };
    await assert.rejects(
      async () => browser.navigate(staleTarget, 'https://example.com/new'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.strictEqual(hostNavigateCalls, 2, 'host.navigate must not be called on stale target');

    // 5. Stale target even when explicitTabId is provided must be rejected with TARGET_STALE before host.navigate
    await assert.rejects(
      async () => browser.navigate(staleTarget, 'https://example.com/new', 'tab-2'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.strictEqual(hostNavigateCalls, 2, 'host.navigate must not be called on stale target with explicitTabId');

    // 6. Unknown explicit tabId must be rejected with CAPABILITY_NOT_FOUND before host.navigate
    await assert.rejects(
      async () => browser.navigate(boundTarget, 'https://example.com/new', 'tab-unknown'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'CAPABILITY_NOT_FOUND'
    );
    assert.strictEqual(hostNavigateCalls, 2, 'host.navigate must not be called on unknown explicit tabId');

    // 7. Valid tabless target without explicit tab auto-provisions and navigates
    const navAuto = await browser.navigate(tablessTarget, 'https://example.com/auto');
    assert.strictEqual(navAuto.navigated, true);
    assert.strictEqual(navAuto.target.tabId, 'tab-auto-prov');
    assert.strictEqual(createTabCalls, 1);
    assert.strictEqual(hostNavigateCalls, 3);
    assert.strictEqual(tablessTarget.tabId, undefined, 'Original tabless target remains unmutated');

    // 8. Stale tabless target (generation: 2) without explicit tab provisions but rejects on assertCurrent before host.navigate
    const staleTablessGen2: BrowserTarget = { ...tablessTarget, documentGeneration: 2 };
    await assert.rejects(
      async () => browser.navigate(staleTablessGen2, 'https://example.com/stale-auto'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
    assert.strictEqual(hostNavigateCalls, 3, 'host.navigate must not be called on stale tabless target');
  });

  it('enforces updated documentGeneration on browser.reload and allows subsequent target-validated operations', async () => {
    let currentDocGen = 1;
    let hostReloadCalls = 0;
    const mockHost = {
      getTabList: () => [{ id: 'tab-1', url: 'https://example.com' }],
      getActiveTabId: () => 'tab-1',
      reload: () => {
        hostReloadCalls++;
        currentDocGen = 2; // Simulate host advancing generation upon reload
        return true;
      },
      getDocumentGeneration: () => currentDocGen,
      isCurrentTarget: (target: BrowserTarget) => {
        return target.browserEpoch === 1 && target.documentGeneration === currentDocGen;
      },
      getDom: async () => '<main>Refreshed Content</main>',
      navigate: () => true,
      captureScreenshot: async () => '',
      evalJs: async () => null,
    };

    const browser = new BrowserControlPort(mockHost);
    const projectId = makeControlPlaneId('project');
    const workspaceId = makeControlPlaneId('workspace');
    const lease = issueRuntimeLease(projectId, workspaceId, 30_000, 1);

    const initialTarget: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    // Reload advances target to generation 2
    const reloadResult = await browser.reload(initialTarget);
    assert.strictEqual(reloadResult.reloaded, true);
    assert.strictEqual(reloadResult.target.documentGeneration, 2);
    assert.strictEqual(hostReloadCalls, 1);

    // Subsequent DOM operation with the updated target succeeds
    const domResult = await browser.dom(reloadResult.target, 'run-1', 'attempt-1');
    assert.strictEqual(domResult, '<main>Refreshed Content</main>');

    // Old initialTarget with generation 1 is now rejected as stale
    await assert.rejects(
      async () => browser.dom(initialTarget, 'run-1', 'attempt-1'),
      (err: unknown) => err instanceof CapabilityError && err.code === 'TARGET_STALE'
    );
  });
});
