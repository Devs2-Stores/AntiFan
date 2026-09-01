import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { spawn, ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { BridgeServer } from '../../src/main/bridge/bridge-server';
import { BrowserControlPort } from '../../src/main/tools/browser-control-port';
import { CapabilityTransportAdapter } from '../../src/main/tools/capability-transport';
import { ControlPlaneRuntime } from '../../src/main/control-plane/control-plane-runtime';
import { AttachmentRegistry } from '../../src/main/run/attachment-registry';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { makeControlPlaneId, issueRuntimeLease } from '../../src/shared/control-plane-contracts';
describe('Phase 04: E2E Industrial Overhaul & Storefront Latency Benchmarks', () => {
  let tempDir: string;
  let bridgeServer: BridgeServer;
  let port: number;
  let controlPlaneRuntime: ControlPlaneRuntime;
  let attachmentRegistry: AttachmentRegistry;
  let testRunId: string;
  let testAttemptId: string;
  let testProjectId: string;
  let testWorkspaceId: string;
  let testSecret: string;
  let testAttachmentId: string;
  let testAuthorityRevision: string;
  let mcpChild: ChildProcess;
  const scriptPath = path.resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs');

  const validPngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82,
  ]);

  class MockTabHost extends EventEmitter {
    tabs = [{ id: 'tab-1', url: 'https://storefront.myshopify.com', title: 'Home' }];
    recordedCalls: Array<{ method: string; tabId?: string; params?: any }> = [];
    activeTabId = 'tab-1';
    automationTabId = 'tab-1';

    getTabList() {
      return this.tabs;
    }
    getActiveTabId() {
      return this.activeTabId;
    }
    getAutomationTabId() {
      return this.automationTabId;
    }
    setAutomationTabId(tabId: string) {
      this.automationTabId = tabId;
    }
    createTab(url?: string) {
      const id = `tab-created-${this.tabs.length + 1}`;
      this.tabs.push({ id, url: url || 'about:blank', title: 'New Tab' });
      this.automationTabId = id;
      return id;
    }
    switchTab(tabId: string) {
      const exists = this.tabs.some((t) => t.id === tabId);
      if (exists) {
        this.activeTabId = tabId;
        this.automationTabId = tabId;
      }
      return exists;
    }
    async captureScreenshot(rect?: any, tabId?: string) {
      this.recordedCalls.push({ method: 'screenshot', tabId });
      return validPngBytes.toString('base64');
    }
    async getDom(selector?: string, tabId?: string) {
      this.recordedCalls.push({ method: 'getDom', tabId, params: { selector } });
      return '<html><body><button id="buy-now">Buy Now</button></body></html>';
    }
    async agentFind(params: any) {
      this.recordedCalls.push({ method: 'agentFind', tabId: params?.tabId, params });
      return { matches: [{ ref: '@e1', label: 'Buy Now', role: 'button' }], count: 1 };
    }
    async agentType(params: any) {
      this.recordedCalls.push({ method: 'agentType', tabId: params?.tabId, params });
      return true;
    }
    async agentClick(params: any) {
      this.recordedCalls.push({ method: 'agentClick', tabId: params?.tabId, params });
      return true;
    }
    async sendKeyboardPress(p: any) {
      this.recordedCalls.push({ method: 'sendKeyboardPress', tabId: p?.tabId, params: p });
      return { success: true, key: p.key, modifiers: p.modifiers || [] };
    }
    async dispatchAgentAction(action: string) {
      return { success: true, data: { ok: true, executed: true, tier: 'cdp_trusted', action } };
    }
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-e2e-bench-'));
    testRunId = makeControlPlaneId('run');
    testProjectId = makeControlPlaneId('project');
    testWorkspaceId = makeControlPlaneId('workspace');

    controlPlaneRuntime = new ControlPlaneRuntime({
      dataRoot: tempDir,
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
      hostEpoch: 1,
    });
    await controlPlaneRuntime.initialize();

    attachmentRegistry = controlPlaneRuntime.runs.attachments;
    const session = await controlPlaneRuntime.createCliSession({
      tabId: 'tab-1',
      grant: 'write',
    });
    testRunId = session.run.id;
    testAttemptId = session.attempt.id;
    testProjectId = session.launch.projectId;
    testWorkspaceId = session.launch.workspaceId;
    testSecret = session.launch.secret;
    testAttachmentId = session.launch.attachmentId;
    testAuthorityRevision = session.launch.authorityRevision;
    const mockTabHost = new MockTabHost() as unknown as NativeTabHost;

    const browserPort = new BrowserControlPort({
      getTabList: () => mockTabHost.getTabList(),
      getActiveTabId: () => mockTabHost.getActiveTabId(),
      getAutomationTabId: () => mockTabHost.getAutomationTabId(),
      setAutomationTabId: (id) => mockTabHost.setAutomationTabId(id),
      createTab: (url, act) => (mockTabHost as any).createTab(url),
      closeTab: (id) => true,
      switchTab: (id) => (mockTabHost as any).switchTab(id),
      agentFind: (p) => (mockTabHost as any).agentFind(p),
      agentType: (p) => (mockTabHost as any).agentType(p),
      agentClick: (p) => (mockTabHost as any).agentClick(p),
      navigate: async () => true,
      reload: async () => true,
      getDom: async (sel, tid) => (mockTabHost as any).getDom(sel, tid),
      captureScreenshot: async (rect, tid) => (mockTabHost as any).captureScreenshot(rect, tid),
      evalJs: async () => ({}),
      getDiagnostics: () => ({ console: [], failures: [] }),
      runResponsiveCheck: async () => ({ passes: true }),
      agentTrajectory: async () => ({ success: true }),
      agentMove: async () => true,
      agentScroll: async () => true,
      agentHover: async () => true,
      agentHighlight: async () => true,
      agentClear: async () => true,
      agentSnapshot: async () => '',
      sendKeyboardPress: async (p) => (mockTabHost as any).sendKeyboardPress(p),
      setViewportSize: () => true,
      setDevicePreset: () => true,
      getDevicePresets: () => [],
      setZoom: () => true,
      toggleInspect: () => true,
      isCurrentTarget: () => true,
      clearAllAgentWorking: () => {},
      getDocumentGeneration: () => 1,
    }, controlPlaneRuntime.artifacts);
    controlPlaneRuntime.registerBrowser(browserPort);
    const capabilityTransport = controlPlaneRuntime.transport;

    bridgeServer = new BridgeServer(mockTabHost, 0, false, capabilityTransport, undefined, attachmentRegistry, '127.0.0.1', controlPlaneRuntime);
    port = await bridgeServer.start();
    const env = {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
        port,
        secret: testSecret,
        attachmentId: testAttachmentId,
        authorityRevision: testAuthorityRevision,
        runId: testRunId,
        attemptId: testAttemptId,
        projectId: testProjectId,
        workspaceId: testWorkspaceId,
      }),
      ANTIFAN_HEARTBEAT_MS: '2000',
    };

    mcpChild = spawn(process.execPath, [scriptPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Send MCP initialize
    mcpChild.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-bench-runner', version: '1.0.0' },
        },
      }) + '\n'
    );
  });

  after(() => {
    try {
      mcpChild.kill();
    } catch {}
    bridgeServer.dispose();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const { StringDecoder } = require('node:string_decoder');
  const decoder = new StringDecoder('utf8');
  const pendingCalls = new Map<number, { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout }>();
  let stdoutAccumulator = '';

  before(() => {
    mcpChild.stdout?.on('data', (chunk: Buffer) => {
      stdoutAccumulator += decoder.write(chunk);
      const lines = stdoutAccumulator.split('\n');
      stdoutAccumulator = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && parsed.id !== undefined && pendingCalls.has(parsed.id)) {
            const entry = pendingCalls.get(parsed.id)!;
            pendingCalls.delete(parsed.id);
            clearTimeout(entry.timer);
            entry.resolve(parsed);
          }
        } catch {}
      }
    });
  });

  function sendMcpToolCall(id: number, name: string, args: Record<string, unknown> = {}, timeoutMs = 15000): Promise<any> {
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    const timer = setTimeout(() => {
      pendingCalls.delete(id);
      reject(new Error(`Tool call '${name}' (${id}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    pendingCalls.set(id, { resolve, reject, timer });
    mcpChild.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name, arguments: args },
      }) + '\n'
    );
    return promise;
  }

  it('1. Captures screenshot end-to-end and resolves valid MCP image envelope via authenticated HTTP stream', async () => {
    const resp = await sendMcpToolCall(1, 'anti.screenshot.viewport', {});
    assert.strictEqual(resp.error, undefined);
    assert.strictEqual(resp.result?.isError, undefined);
    const content = resp.result?.content?.[0];
    assert.ok(content, 'Must return content array');
    assert.strictEqual(content.type, 'image', 'Must return standard MCP Image type');
    assert.strictEqual(content.mimeType, 'image/png');
    assert.ok(typeof content.data === 'string', 'Must contain base64 image data');

    const decoded = Buffer.from(content.data, 'base64');
    assert.strictEqual(decoded.compare(validPngBytes), 0, 'Returned binary image must match pixel-perfect authentic screenshot bytes');
  });

  it('2. Dispatches DOM inspection and agent actions cleanly over persistent channel', async () => {
    const domResp = await sendMcpToolCall(2, 'anti.inspect.dom', {});
    assert.strictEqual(domResp.error, undefined);
    assert.strictEqual(domResp.result?.isError, undefined);
    const domContent = domResp.result?.content?.[0]?.text;
    assert.ok(domContent && domContent.includes('Buy Now'), 'Must inspect DOM content');

    const clickResp = await sendMcpToolCall(3, 'anti.agent.cursor.click', { selector: '#buy-now', trusted: true });
    assert.strictEqual(clickResp.error, undefined);
    assert.strictEqual(clickResp.result?.isError, undefined);
  });

  it('3. Benchmarks RPC dispatch latency under 100ms per tool invocation after warmup', async () => {
    const iterations = 5;
    const latencies: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      await sendMcpToolCall(100 + i, 'anti.browser.tabs.list', {});
      const elapsed = performance.now() - start;
      latencies.push(elapsed);
    }

    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    // Log benchmark telemetry
    console.log(`[Storefront Benchmark] Average tool call latency: ${avgLatency.toFixed(2)}ms (samples: ${latencies.map((l) => l.toFixed(1) + 'ms').join(', ')})`);

    assert.ok(
      avgLatency < 100,
      `Average tool dispatch latency must be under 100ms on Windows CI (got ${avgLatency.toFixed(2)}ms)`
    );
  });

  it('4. Dispatches anti.agent.cursor.type with ref-only (no selector) without MCP validation failure', async () => {
    const typeResp = await sendMcpToolCall(4, 'anti.agent.cursor.type', {
      ref: '@e1',
      text: 'hello from agent',
    });
    assert.strictEqual(typeResp.error, undefined);
    assert.strictEqual(typeResp.result?.isError, undefined);
  });

  it('5. Dispatches Playwright canonical browser_find and browser_press_key over OMP MCP proxy', async () => {
    const findResp = await sendMcpToolCall(5, 'browser_find', { text: 'Buy Now' });
    assert.strictEqual(findResp.error, undefined);
    assert.strictEqual(findResp.result?.isError, undefined);

    const pressResp = await sendMcpToolCall(6, 'browser_press_key', { key: 'Control+a' });
    assert.strictEqual(pressResp.error, undefined);
    assert.strictEqual(pressResp.result?.isError, undefined);
  });

  it('6. Exercises tab creation -> screenshot -> action sequence in the same MCP proxy session', async () => {
    // 1. Create a new tab
    const createResp = await sendMcpToolCall(7, 'anti.browser.tabs.create', { url: 'https://storefront.myshopify.com/cart' });
    assert.strictEqual(createResp.error, undefined);
    assert.strictEqual(createResp.result?.isError, undefined);
    const parsedCreate = JSON.parse(createResp.result?.content?.[0]?.text || '{}');
    const createdTabId = parsedCreate.tabId;
    assert.ok(createdTabId, 'Must return created tab ID');

    // 2. Immediately capture screenshot passing explicit createdTabId in the same session without TARGET_MISMATCH
    const screenshotResp = await sendMcpToolCall(8, 'anti.screenshot.viewport', { tabId: createdTabId });
    assert.strictEqual(screenshotResp.error, undefined);
    assert.strictEqual(screenshotResp.result?.isError, undefined);
    assert.strictEqual(screenshotResp.result?.content?.[0]?.type, 'image');
    // 3. Execute ref-only cursor typing on the created tab in the same session
    const typeResp = await sendMcpToolCall(9, 'anti.agent.cursor.type', { ref: '@e1', text: 'order now', tabId: createdTabId });
    assert.strictEqual(typeResp.error, undefined);
    assert.strictEqual(typeResp.result?.isError, undefined);

    // 4. Immediately execute cursor click passing explicit createdTabId in the same session
    const actionResp = await sendMcpToolCall(10, 'anti.agent.cursor.click', { selector: '#buy-now', tabId: createdTabId });
    assert.strictEqual(actionResp.error, undefined);
    assert.strictEqual(actionResp.result?.isError, undefined);

    // 5. Assert host recorded calls targeting createdTabId
    const screenshotCall = (bridgeServer as any).tabHost.recordedCalls.find((c: any) => c.method === 'screenshot' && c.tabId === createdTabId);
    assert.ok(screenshotCall, 'Host must have executed screenshot against createdTabId');
    const typeCall = (bridgeServer as any).tabHost.recordedCalls.find((c: any) => c.method === 'agentType' && c.tabId === createdTabId);
    assert.ok(typeCall, 'Host must have executed agentType against createdTabId');
    const clickCall = (bridgeServer as any).tabHost.recordedCalls.find((c: any) => c.method === 'agentClick' && c.tabId === createdTabId);
    assert.ok(clickCall, 'Host must have executed agentClick against createdTabId');
  });
});
