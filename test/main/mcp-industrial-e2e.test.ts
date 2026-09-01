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
    getTabList() {
      return this.tabs;
    }
    getActiveTabId() {
      return 'tab-1';
    }
    getAutomationTabId() {
      return 'tab-1';
    }
    async captureScreenshot() {
      return validPngBytes.toString('base64');
    }
    async getDom() {
      return '<html><body><button id="buy-now">Buy Now</button></body></html>';
    }
    async dispatchAgentAction(action: string) {
      return { success: true, data: { ok: true, executed: true, tier: 'cdp_trusted', action } };
    }
  }

  before(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-e2e-bench-'));
    testRunId = makeControlPlaneId('run');
    testAttemptId = makeControlPlaneId('attempt');
    testProjectId = makeControlPlaneId('project');
    testWorkspaceId = makeControlPlaneId('workspace');

    attachmentRegistry = new AttachmentRegistry();
    const lease = issueRuntimeLease(testProjectId, testWorkspaceId, 3600000, 1);

    const issued = attachmentRegistry.issueAttachment(
      testRunId,
      testAttemptId,
      testProjectId,
      testWorkspaceId,
      {
        backendId: 'test-backend',
        lease,
        leaseToken: lease.token,
        grant: 'write',
        browserTarget: {
          projectId: testProjectId,
          workspaceId: testWorkspaceId,
          runtimeId: lease.runtimeId,
          tabId: 'tab-1',
          browserEpoch: 1,
          documentGeneration: 1,
        },
      }
    );
    testSecret = issued.launch.secret;
    testAttachmentId = issued.record.id;

    const mockTabHost = new MockTabHost() as unknown as NativeTabHost;

    controlPlaneRuntime = new ControlPlaneRuntime({
      dataRoot: tempDir,
      projectId: testProjectId,
      workspaceId: testWorkspaceId,
      runtimeId: lease.runtimeId,
      hostEpoch: lease.hostEpoch,
    });
    const browserPort = new BrowserControlPort({
      getTabList: () => mockTabHost.getTabList(),
      getActiveTabId: () => mockTabHost.getActiveTabId(),
      getAutomationTabId: () => mockTabHost.getAutomationTabId(),
      setAutomationTabId: () => {},
      createTab: () => 'tab-1',
      closeTab: () => true,
      switchTab: () => true,
      navigate: async () => true,
      reload: async () => true,
      getDom: async () => mockTabHost.getDom(),
      captureScreenshot: async () => mockTabHost.captureScreenshot(),
      evalJs: async () => ({}),
      getDiagnostics: () => ({ console: [], failures: [] }),
      runResponsiveCheck: async () => ({ passes: true }),
      agentTrajectory: async () => ({ success: true }),
      agentMove: async () => true,
      agentClick: async () => true,
      agentType: async () => true,
      agentScroll: async () => true,
      agentHover: async () => true,
      agentHighlight: async () => true,
      agentClear: async () => true,
      agentSnapshot: async () => '',
      sendKeyboardPress: async (p) => ({ success: true, key: p.key, modifiers: p.modifiers || [] }),
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
    const capabilityTransport = new CapabilityTransportAdapter(controlPlaneRuntime.capabilities);

    bridgeServer = new BridgeServer(mockTabHost, 0, false, capabilityTransport, undefined, attachmentRegistry, '127.0.0.1', controlPlaneRuntime);
    port = await bridgeServer.start();
    const env = {
      ...process.env,
      ANTIFAN_MCP_BOOTSTRAP: JSON.stringify({
        port,
        secret: testSecret,
        attachmentId: testAttachmentId,
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
});
