import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TabAutomationHost } from '../../src/main/browser/tab-automation-host';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';
import { CapabilityError, BrowserTarget, makeControlPlaneId, issueRuntimeLease } from '../../src/shared/control-plane-contracts';
import { recordFallbackTelemetry, getTelemetryLogPath } from '../../src/main/telemetry/fallback-recorder';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';

describe('Phase 5: Playwright Parity Kernel & Gap Telemetry Verification', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-parity-test-'));
  const testUploadFile = path.join(tmpDir, 'product-data.csv');

  before(() => {
    fs.writeFileSync(testUploadFile, 'sku,price,title\nSKU001,250000,Premium Shirt');
  });

  after(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  function createParityHarness() {
    const registry = new SemanticRefRegistry();
    const cdpCalls: Array<{ method: string; params: unknown }> = [];

    const mockWc: any = {
      id: 101,
      isDestroyed: () => false,
      getURL: () => 'https://myshopify.test/storefront/product-1',
      capturePage: async () => ({
        isEmpty: () => false,
        toPNG: () => Buffer.from('fake-png-surface-bytes'),
      }),
      executeJavaScript: async (code: string) => {
        if (code.includes('zero-dim')) return null;
        if (code.includes('drop-target')) return { x: 200, y: 300 };
        if (code.includes('__antifan_agent_execute') || code.includes('IsolatedAgentExecutor') || code.includes('focus')) {
          return { ok: true, executed: true, action: 'click', rect: { x: 100, y: 250, width: 180, height: 40, centerX: 190, centerY: 270 } };
        }
        return { ok: true, count: 1 };
      },
      executeJavaScriptInIsolatedWorld: async (_worldId: number, scripts: Array<{ code: string }>) => {
        const code = scripts[0]?.code || '';
        if (code.includes('zero-dim')) return null;
        if (code.includes('drop-target')) return { x: 200, y: 300 };
        if (code.includes('__antifan_agent_execute') || code.includes('IsolatedAgentExecutor') || code.includes('focus')) {
          return { ok: true, executed: true, action: 'click', rect: { x: 100, y: 250, width: 180, height: 40, centerX: 190, centerY: 270 } };
        }
        return { ok: true, count: 1 };
      },
      mainFrame: {
        executeJavaScriptInIsolatedWorld: async (_worldId: number, scripts: Array<{ code: string }>) => {
          const code = scripts[0]?.code || '';
          if (code.includes('zero-dim')) return null;
          if (code.includes('drop-target')) return { x: 200, y: 300 };
          if (code.includes('__antifan_agent_execute') || code.includes('IsolatedAgentExecutor') || code.includes('focus')) {
            return { ok: true, executed: true, action: 'click', rect: { x: 100, y: 250, width: 180, height: 40, centerX: 190, centerY: 270 } };
          }
          return { ok: true, count: 1 };
        },
      },
      debugger: {
        isAttached: () => true,
        attach: () => {},
        detach: () => {},
        sendCommand: async (method: string, params: any) => {
          cdpCalls.push({ method, params });
          return {};
        },
      },
    };

    const mockDevToolsHost: any = {
      sendCdpCommand: async (_wc: any, method: string, params: any) => {
        cdpCalls.push({ method, params });
        if (method === 'Page.captureScreenshot') {
          return { data: Buffer.from('cdp-screenshot-bytes').toString('base64') };
        }
        if (method === 'Runtime.evaluate') {
          return { result: { objectId: 'obj-element-101' } };
        }
        if (method === 'DOM.describeNode') {
          return 7788;
        }
        if (method === 'Runtime.callFunctionOn') {
          return { result: { value: true } };
        }
        return {};
      },
      describeNodeByObjectId: async (_wc: any, objectId: string) => {
        if (objectId === 'obj-element-101') return 7788;
        return undefined;
      },
      getOrCreateIsolatedWorldContext: async () => 1004,
      captureScreenshot: async () => Buffer.from('cdp-screenshot-bytes').toString('base64'),
      evalJs: async (exp: string) => {
        if (exp.includes('circular')) return { a: 'safe' };
        return { evaluated: true };
      },
    };

    const tabRecord: any = {
      state: { id: 'tab-p1', url: 'https://myshopify.test/storefront/product-1' },
      terminalSessionId: 'sess-p1',
    };

    const targetOperationQueues = new Map<string, Promise<void>>();
    const runTargetOperation = async <T>(_tabId: string, _paneId: string | undefined, operation: () => Promise<T>): Promise<T> => {
      const key = `${_tabId}:${_paneId || 'desktop'}`;
      const previousTail = targetOperationQueues.get(key) || Promise.resolve();
      let resolveTail!: () => void;
      const currentTail = new Promise<void>((resolve) => {
        resolveTail = resolve;
      });
      targetOperationQueues.set(key, currentTail);
      try {
        await previousTail;
        return await operation();
      } finally {
        resolveTail();
        if (targetOperationQueues.get(key) === currentTail) {
          targetOperationQueues.delete(key);
        }
      }
    };

    const host = new TabAutomationHost({
      getTabWebContents: () => mockWc,
      getTabRecord: () => tabRecord,
      getAutomationTabId: () => 'tab-p1',
      getActiveTabId: () => 'tab-p1',
      getBrowserEpoch: () => 1,
      getSemanticDocumentGeneration: () => 1,
      semanticRefRegistry: registry,
      runTargetOperation,
      broadcastState: () => {},
      syncFrameBackdrop: () => {},
      getAllTabs: () => [][Symbol.iterator](),
      tabDevToolsHost: mockDevToolsHost,
      getTabTerminalSession: () => 'sess-p1',
      resolveTargetWorkspace: (sessId) => (sessId === 'sess-p1' ? tmpDir : ''),
    });
    const hostPort: BrowserHostPort = {
      getTabList: () => [{ id: 'tab-p1', url: 'https://myshopify.test/storefront/product-1' }],
      getActiveTabId: () => 'tab-p1',
      getAutomationTabId: () => 'tab-p1',
      getDom: async () => '<main>Storefront Body</main>',
      captureScreenshot: async () => Buffer.from('cdp-screenshot-bytes').toString('base64'),
      evalJs: async (exp) => mockDevToolsHost.evalJs(exp),
      agentSnapshot: async () => '<snapshot tab="tab-p1"/>',
      agentFind: async (params) => host.agentFind(params),
      agentClick: async (params) => host.agentClick(params),
      sendKeyboardPress: async (params) => ({ success: true, key: params.key, modifiers: params.modifiers || [] }),
      agentType: async () => true,
      uploadFileInput: async (params) => host.uploadFileInput(params.refOrSelector, params.filePaths, params.tabId, params.paneId),
      dropFiles: async (params) => host.dropFiles(params.refOrSelector, params.filePaths, params.tabId, params.paneId),
      navigate: async () => true,
      reload: async () => true,
    };

    const browserPort = new BrowserControlPort(hostPort);
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
    registerBrowserCapabilities(catalogue, browserPort);

    const target: BrowserTarget = {
      projectId,
      workspaceId,
      runtimeId: lease.runtimeId,
      tabId: 'tab-p1',
      browserEpoch: 1,
      documentGeneration: 1,
    };
    const ctx = {
      grant: 'write' as const,
      browserTarget: target,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      lease,
      leaseToken: lease.token,
    };

    return { host, registry, cdpCalls, mockWc, catalogue, browserPort, target, lease, ctx };
  }

  it('1. Semantic Ref allocation produces clean monotonic @e1..@eN tags with spatial bounds and labels', () => {
    const registry = new SemanticRefRegistry();
    const collection = registry.beginCollection({
      tabId: 'tab-p1',
      paneId: 'desktop',
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://myshopify.test/storefront/product-1',
    });

    const snapshot = registry.publishSnapshot({
      tabId: 'tab-p1',
      paneId: 'desktop',
      nonce: collection.nonce,
      sequence: collection.sequence,
      browserEpoch: 1,
      documentGeneration: 1,
      documentUrl: 'https://myshopify.test/storefront/product-1',
      rawDescriptors: [
        {
          id: 'add-to-cart-btn',
          role: 'button',
          label: 'Add to Cart',
          path: [{ kind: 'dom', index: 0, tag: 'button', id: 'add-to-cart-btn' }],
          rect: { x: 50, y: 100, width: 200, height: 48, centerX: 150, centerY: 124 },
          fingerprint: { tag: 'button', role: 'button', name: 'Add to Cart' },
        },
        {
          id: 'variant-select',
          role: 'combobox',
          label: 'Size',
          path: [{ kind: 'dom', index: 1, tag: 'select', id: 'variant-select' }],
          rect: { x: 50, y: 160, width: 200, height: 40, centerX: 150, centerY: 180 },
          fingerprint: { tag: 'select', role: 'combobox', name: 'Size' },
        },
      ],
    });

    assert.ok(snapshot.formattedText.includes('@e1'));
    assert.ok(snapshot.formattedText.includes('@e2'));
    assert.ok(snapshot.formattedText.includes('Add to Cart'));
    assert.ok(snapshot.formattedText.includes('Size'));
  });

  it('2. uploadFileInput executes isolated CDP file upload with backendNodeId and event notification', async () => {
    const { host, cdpCalls } = createParityHarness();

    const res = await host.uploadFileInput('input[type="file"]', [testUploadFile]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.uploadedCount, 1);

    const setFilesCmd = cdpCalls.find((c) => c.method === 'DOM.setFileInputFiles');
    assert.ok(setFilesCmd, 'Must send DOM.setFileInputFiles CDP command');
    assert.strictEqual((setFilesCmd.params as any).backendNodeId, 7788);

    const callFnCmd = cdpCalls.find((c) => c.method === 'Runtime.callFunctionOn');
    assert.ok(callFnCmd, 'Must invoke Runtime.callFunctionOn for input/change dispatch');
    assert.strictEqual((callFnCmd.params as any).objectId, 'obj-element-101');
  });

  it('3. dropFiles executes pure CDP native drag and drop sequence', async () => {
    const { host, cdpCalls } = createParityHarness();

    const res = await host.dropFiles('.drop-target', [testUploadFile]);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.droppedCount, 1);

    const dragEvents = cdpCalls.filter((c) => c.method === 'Input.dispatchDragEvent');
    assert.strictEqual(dragEvents.length, 3);
    assert.strictEqual((dragEvents[0]?.params as any).type, 'dragEnter');
    assert.strictEqual((dragEvents[1]?.params as any).type, 'dragOver');
    assert.strictEqual((dragEvents[2]?.params as any).type, 'drop');
    assert.strictEqual((dragEvents[2]?.params as any).x, 200);
    assert.strictEqual((dragEvents[2]?.params as any).y, 300);
  });

  it('4. recordFallbackTelemetry records sanitized structured gap analysis event', () => {
    const res = recordFallbackTelemetry({
      sessionId: 'sess-parity-01',
      targetUrl: 'https://admin:pass123@store.com/checkout?token=secret99',
      primaryTool: 'anti.screenshot.viewport',
      errorCode: 'TIMEOUT',
      errorMessage: 'Compositor timed out during background capture\nSecond line details',
      fallbackTool: 'browser_take_screenshot',
      fallbackResult: 'SUCCESS',
      durationMs: 120.4,
      notes: 'Playwright standalone engine succeeded on isolated browser context',
    }, tmpDir);

    assert.strictEqual(res.recorded, true);
    const logPath = getTelemetryLogPath(tmpDir);
    const logData = fs.readFileSync(logPath, 'utf8');
    const entry = JSON.parse(logData.trim().split('\n').pop()!);

    assert.strictEqual(entry.primaryTool, 'anti.screenshot.viewport');
    assert.strictEqual(entry.fallbackTool, 'browser_take_screenshot');
    assert.strictEqual(entry.fallbackResult, 'SUCCESS');
    assert.strictEqual(entry.contextMode, 'STANDALONE_PLAYWRIGHT_DIAGNOSTIC_PROBE');
    assert.ok(!entry.targetUrl.includes('pass123'));
    assert.ok(!entry.targetUrl.includes('secret99'));
    assert.ok(!entry.errorMessage.includes('\n'));
  });

  it('5. CapabilityCatalogue dispatches upload-file, drop-files, evaluate, and snapshot via canonical anti.* aliases', async () => {
    const { catalogue, target, lease } = createParityHarness();
    const ctx = {
      grant: 'write' as const,
      browserTarget: target,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      lease,
      leaseToken: lease.token,
    };
    const uploadRes = await catalogue.dispatch('anti.agent.file_upload', {
      refOrSelector: 'input[type="file"]',
      filePaths: [testUploadFile],
    }, ctx);
    assert.deepStrictEqual(uploadRes, { success: true, uploadedCount: 1 });

    // 2. Dispatch anti.agent.drop
    const dropRes = await catalogue.dispatch('anti.agent.drop', {
      refOrSelector: '.drop-target',
      filePaths: [testUploadFile],
    }, ctx);
    assert.deepStrictEqual(dropRes, { success: true, droppedCount: 1 });
    // 3. Dispatch anti.browser.evaluate
    const ctxEval = { ...ctx, grant: 'eval' as const };
    const evalRes = await catalogue.dispatch('anti.browser.evaluate', {
      expression: 'document.title',
    }, ctxEval);
    assert.deepStrictEqual(evalRes, { evaluated: true });

    // 4. Dispatch anti.inspect.snapshot
    const ctxRead = {
      grant: 'read' as const,
      browserTarget: target,
      projectId: target.projectId,
      workspaceId: target.workspaceId,
      lease,
      leaseToken: lease.token,
    };
    const snapRes = await catalogue.dispatch('anti.inspect.snapshot', {}, ctxRead);
    assert.deepStrictEqual(snapRes, { snapshot: '<snapshot tab="tab-p1"/>' });

    // 5. Dispatch anti.telemetry.record_fallback
    const telRes = await catalogue.dispatch('anti.telemetry.record_fallback', {
      primaryTool: 'anti.browser.evaluate',
      fallbackTool: 'browser_evaluate',
      fallbackResult: 'SUCCESS',
    }, ctx);
    assert.strictEqual((telRes as any).recorded, true);
  });

  it('6. CDP screenshot fallback issues Page.captureScreenshot with fromSurface: false and captureBeyondViewport: true', async () => {
    const { cdpCalls } = createParityHarness();

    const mockWc: any = {
      id: 202,
      isDestroyed: () => false,
      capturePage: async () => ({ isEmpty: () => true }),
      debugger: {
        isAttached: () => false,
        attach: () => {},
        once: () => {},
        sendCommand: async (method: string, params: any) => {
          cdpCalls.push({ method, params });
          if (method === 'Page.captureScreenshot') return { data: 'b2NjbHVkZWQtc2NyZWVuc2hvdA==' };
          return {};
        },
      },
    };
    const devToolsHost = new (require('../../src/main/browser/tab-devtools-host').TabDevToolsHost)({
      getTabRecord: () => ({ state: { id: 'tab-p1' } }),
      getActiveTabId: () => 'tab-p1',
      getTabWebContents: () => mockWc,
      withTabAgentWorking: async (_tabId: string, fn: any) => fn(),
    });

    const shotBase64 = await devToolsHost.captureScreenshot();
    assert.strictEqual(shotBase64, 'b2NjbHVkZWQtc2NyZWVuc2hvdA==');

    const shotCmd = cdpCalls.find((c) => c.method === 'Page.captureScreenshot');
    assert.ok(shotCmd, 'Must send Page.captureScreenshot');
    assert.strictEqual((shotCmd.params as any).fromSurface, false, 'fromSurface must be false for background capture');
    assert.strictEqual((shotCmd.params as any).captureBeyondViewport, true, 'captureBeyondViewport must be true for full occlusion-proof capture');
  });

  it('7. CDP low-level command queue serializes execution and cleans up isolatedContext on detach', async () => {
    let detachCb: any;
    let navigateCb: any;
    const commandSeq: string[] = [];

    const mockWc: any = {
      id: 303,
      isDestroyed: () => false,
      on: (evt: string, cb: any) => {
        if (evt === 'did-navigate') navigateCb = cb;
      },
      debugger: {
        isAttached: () => false,
        attach: () => {},
        once: (evt: string, cb: any) => {
          if (evt === 'detach') detachCb = cb;
        },
        sendCommand: async (method: string) => {
          commandSeq.push(`start:${method}`);
          if (method === 'AsyncMethodA') {
            await new Promise((r) => setTimeout(r, 20));
          } else {
            await new Promise((r) => setTimeout(r, 5));
          }
          commandSeq.push(`end:${method}`);
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'f-303' } } };
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1004 };
          return {};
        },
      },
    };

    const devToolsHost = new (require('../../src/main/browser/tab-devtools-host').TabDevToolsHost)({
      getTabRecord: () => ({ state: { id: 'tab-303' } }),
      getActiveTabId: () => 'tab-303',
      getTabWebContents: () => mockWc,
    });

    // 1. Concurrent command dispatch: AsyncMethodA (20ms) and AsyncMethodB (5ms) dispatched simultaneously
    commandSeq.length = 0;
    const [resA, resB] = await Promise.all([
      devToolsHost.sendCdpCommand(mockWc, 'AsyncMethodA'),
      devToolsHost.sendCdpCommand(mockWc, 'AsyncMethodB'),
    ]);

    // Verify strict FIFO serialization: MethodB does NOT start until MethodA completes
    assert.deepStrictEqual(commandSeq, [
      'start:AsyncMethodA',
      'end:AsyncMethodA',
      'start:AsyncMethodB',
      'end:AsyncMethodB',
    ]);

    // 2. Establish isolated world context
    const ctxId1 = await devToolsHost.getOrCreateIsolatedWorldContext(mockWc);
    assert.strictEqual(ctxId1, 1004);

    // 3. Cached context is returned on subsequent calls
    const ctxId2 = await devToolsHost.getOrCreateIsolatedWorldContext(mockWc);
    assert.strictEqual(ctxId2, 1004);

    // 4. Detach clears cached context
    assert.ok(detachCb, 'Must register detach listener');
    detachCb();

    // 5. Next call re-creates isolated world context
    const ctxId3 = await devToolsHost.getOrCreateIsolatedWorldContext(mockWc);
    assert.strictEqual(ctxId3, 1004);

    // 6. Repeated navigation invalidates cached context
    assert.ok(navigateCb, 'Must register did-navigate listener');
    navigateCb();
    const ctxId4 = await devToolsHost.getOrCreateIsolatedWorldContext(mockWc);
    assert.strictEqual(ctxId4, 1004);
  });
  it('8. In-page evaluate handles circular references and async promises safely', async () => {
    let capturedScript = '';
    const devToolsHost = new (require('../../src/main/browser/tab-devtools-host').TabDevToolsHost)({
      getTabRecord: () => ({ state: { id: 'tab-p1' } }),
      getActiveTabId: () => 'tab-p1',
      getTabWebContents: () => ({
        id: 404,
        isDestroyed: () => false,
        executeJavaScript: async (script: string) => {
          capturedScript = script;
          // Run the wrapped script inside eval to test circular serialization logic
          return eval(script);
        },
      }),
      withTabAgentWorking: async (_tabId: string, fn: any) => fn(),
    });

    // 1. Test evaluating an object with a circular self-reference
    const res1 = await devToolsHost.evalJs('(() => { const obj = { name: "test-node" }; obj.self = obj; return obj; })()');
    assert.ok(capturedScript.includes('serializeCircularSafe'), 'Script must be wrapped in circular-safe serializer');
    assert.deepStrictEqual(res1, { name: 'test-node', self: '[Circular]' });

    // 2. Test evaluating an async promise expression
    const res2 = await devToolsHost.evalJs('Promise.resolve({ status: 200, asyncData: "resolved" })');
    assert.deepStrictEqual(res2, { status: 200, asyncData: 'resolved' });
  });

  it('9. Actionability auto-wait ensures animation velocity decay before dispatching clicks', async () => {
    const { buildIsolatedExecutorScript } = require('../../src/main/browser/semantic-ref-executor');

    const script = buildIsolatedExecutorScript({
      action: 'click',
      selector: '#animated-btn',
    });

    assert.ok(script.includes('requestAnimationFrame'), 'Executor script must include rAF velocity decay loop');
    assert.ok(script.includes('delta <= 2'), 'Executor script must enforce <= 2px threshold');

    let clickDispatched = false;
    let framesWaited = 0;
    const mockPositions = [
      { x: 100, y: 150 },
      { x: 120, y: 160 }, // moving fast (delta ~ 22px)
      { x: 125, y: 162 }, // moving slower (delta ~ 5.3px)
      { x: 126, y: 163 }, // delta = 1.41px <= 2px (settled!)
    ];

    let posIdx = 0;
    const mockElement: any = {
      tagName: 'BUTTON',
      isConnected: true,
      disabled: false,
      style: { display: 'block', visibility: 'visible', opacity: '1' },
      getAttribute: () => null,
      getBoundingClientRect: () => {
        const p = mockPositions[Math.min(posIdx, mockPositions.length - 1)]!;
        return { x: p.x, y: p.y, width: 100, height: 40 };
      },
      scrollIntoView: () => {},
      focus: () => {},
      dispatchEvent: (evt: any) => {
        if (evt.type === 'click') clickDispatched = true;
      },
    };

    // Construct global execution environment for the generated script
    const prevWindow = (global as any).window;
    const prevDoc = (global as any).document;
    const prevRaf = (global as any).requestAnimationFrame;
    const prevMouseEvent = (global as any).MouseEvent;

    try {
      (global as any).window = {
        location: { href: 'https://test.storefront.local/' },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      };
      (global as any).document = {
        querySelector: (sel: string) => (sel === '#animated-btn' ? mockElement : null),
        documentElement: { isConnected: true },
      };
      (global as any).requestAnimationFrame = (cb: () => void) => {
        posIdx++;
        framesWaited++;
        setImmediate(cb);
      };
      (global as any).MouseEvent = class MouseEvent {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      };

      // Execute the production generated script directly
      const result = await eval(script);
      assert.strictEqual(result.ok, true, `Script execution failed: ${result.error}`);
      assert.strictEqual(result.executed, true);
      assert.ok(framesWaited >= 3, `Must wait for velocity decay across rAF frames, waited: ${framesWaited}`);
      assert.strictEqual(clickDispatched, true, 'Click event must be dispatched after settling');
    } finally {
      (global as any).window = prevWindow;
      (global as any).document = prevDoc;
      (global as any).requestAnimationFrame = prevRaf;
      (global as any).MouseEvent = prevMouseEvent;
    }
  });

  it('10. Executor aborts with REF_DOCUMENT_MUTATED if document URL changes during animation stabilization wait', async () => {
    const { buildIsolatedExecutorScript } = require('../../src/main/browser/semantic-ref-executor');

    const script = buildIsolatedExecutorScript({
      action: 'click',
      selector: '#animated-btn',
      documentUrl: 'https://test.storefront.local/checkout',
    });

    let clickDispatched = false;
    let posIdx = 0;
    const mockPositions = [
      { x: 100, y: 150 },
      { x: 120, y: 160 },
      { x: 121, y: 160 }, // delta = 1px <= 2px
    ];

    const mockElement: any = {
      tagName: 'BUTTON',
      isConnected: true,
      disabled: false,
      style: { display: 'block', visibility: 'visible', opacity: '1' },
      getAttribute: () => null,
      getBoundingClientRect: () => {
        const p = mockPositions[Math.min(posIdx, mockPositions.length - 1)]!;
        return { x: p.x, y: p.y, width: 100, height: 40 };
      },
      scrollIntoView: () => {},
      focus: () => {},
      dispatchEvent: (evt: any) => {
        if (evt.type === 'click') clickDispatched = true;
      },
    };

    const prevWindow = (global as any).window;
    const prevDoc = (global as any).document;
    const prevRaf = (global as any).requestAnimationFrame;
    const prevMouseEvent = (global as any).MouseEvent;

    try {
      (global as any).window = {
        location: { href: 'https://test.storefront.local/checkout' },
        getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
      };
      (global as any).document = {
        querySelector: (sel: string) => (sel === '#animated-btn' ? mockElement : null),
        documentElement: { isConnected: true },
      };
      (global as any).requestAnimationFrame = (cb: () => void) => {
        posIdx++;
        // Simulate URL navigation occurring mid-flight during rAF frame 2
        if (posIdx === 2) {
          (global as any).window.location.href = 'https://test.storefront.local/thank-you';
        }
        setImmediate(cb);
      };
      (global as any).MouseEvent = class MouseEvent {
        type: string;
        constructor(type: string) {
          this.type = type;
        }
      };

      const result = await eval(script);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.code, 'REF_DOCUMENT_MUTATED');
      assert.strictEqual(clickDispatched, false, 'Click event must NOT be dispatched when URL mutates during wait');
    } finally {
      (global as any).window = prevWindow;
      (global as any).document = prevDoc;
      (global as any).requestAnimationFrame = prevRaf;
      (global as any).MouseEvent = prevMouseEvent;
    }
  });

  it('11. TabDevToolsHost.dispose detaches only host-attached debuggers and removes registered listeners', async () => {
    let attached1 = false;
    let detached1 = false;
    let ownedOnNavigate: any = null;
    let ownedOnDetach: any = null;
    let removedNavCb1: any = null;
    let removedDetachCb1: any = null;

    // mockWc1: Starts unattached -> host attaches -> must detach on dispose
    const mockWc1: any = {
      id: 101,
      isDestroyed: () => false,
      on: (evt: string, cb: any) => {
        if (evt === 'did-navigate') ownedOnNavigate = cb;
      },
      removeListener: (evt: string, cb: any) => {
        if (evt === 'did-navigate') {
          assert.strictEqual(cb, ownedOnNavigate, 'Must remove exact did-navigate callback');
          removedNavCb1 = cb;
        }
      },
      debugger: {
        isAttached: () => attached1,
        attach: () => { attached1 = true; },
        detach: () => {
          detached1 = true;
          attached1 = false;
          // Synchronously fire native detach event callback
          if (typeof ownedOnDetach === 'function') {
            ownedOnDetach();
          }
        },
        once: (evt: string, cb: any) => {
          if (evt === 'detach') ownedOnDetach = cb;
        },
        removeListener: (evt: string, cb: any) => {
          if (evt === 'detach') {
            assert.strictEqual(cb, ownedOnDetach, 'Must remove exact detach callback');
            removedDetachCb1 = cb;
          }
        },
        sendCommand: async () => ({}),
      },
    };

    let detached2 = false;
    let externalOnNavigate: any = null;
    let externalOnDetach: any = null;
    let removedNavCb2: any = null;
    let removedDetachCb2: any = null;

    // mockWc2: Starts externally attached -> host must NOT detach on dispose
    const mockWc2: any = {
      id: 102,
      isDestroyed: () => false,
      on: (evt: string, cb: any) => {
        if (evt === 'did-navigate') externalOnNavigate = cb;
      },
      removeListener: (evt: string, cb: any) => {
        if (evt === 'did-navigate') {
          assert.strictEqual(cb, externalOnNavigate, 'Must remove exact did-navigate callback');
          removedNavCb2 = cb;
        }
      },
      debugger: {
        isAttached: () => true, // already attached externally (e.g. Chrome DevTools)
        attach: () => { throw new Error('Already attached'); },
        detach: () => { detached2 = true; },
        once: (evt: string, cb: any) => {
          if (evt === 'detach') externalOnDetach = cb;
        },
        removeListener: (evt: string, cb: any) => {
          if (evt === 'detach') {
            assert.strictEqual(cb, externalOnDetach, 'Must remove exact detach callback');
            removedDetachCb2 = cb;
          }
        },
        sendCommand: async () => ({}),
      },
    };

    const devToolsHost = new (require('../../src/main/browser/tab-devtools-host').TabDevToolsHost)({
      getTabRecord: () => ({ state: { id: 'tab-101' } }),
      getActiveTabId: () => 'tab-101',
      getTabWebContents: () => mockWc1,
    });

    // Execute CDP commands on both WebContents
    await devToolsHost.sendCdpCommand(mockWc1, 'Page.enable');
    await devToolsHost.sendCdpCommand(mockWc2, 'Page.enable');

    assert.strictEqual(attached1, true, 'Host must attach mockWc1');
    assert.ok(ownedOnNavigate, 'Must register did-navigate on mockWc1');
    assert.ok(ownedOnDetach, 'Must register detach on mockWc1');
    assert.ok(externalOnNavigate, 'Must register did-navigate on mockWc2');
    assert.ok(externalOnDetach, 'Must register detach on mockWc2');

    // Dispose host
    devToolsHost.dispose();

    // Verify mockWc1 (owned) is detached and exact listeners removed
    assert.strictEqual(detached1, true, 'Host must detach owned mockWc1 on dispose');
    assert.ok(removedNavCb1, 'Host must remove did-navigate listener on mockWc1');
    assert.ok(removedDetachCb1, 'Host must remove detach listener on mockWc1');

    // Verify mockWc2 (external) is NOT detached and exact listeners removed
    assert.strictEqual(detached2, false, 'Host must NEVER detach externally attached mockWc2 on dispose');
    assert.ok(removedNavCb2, 'Host must remove did-navigate listener on mockWc2');
    assert.ok(removedDetachCb2, 'Host must remove detach listener on mockWc2');
  });

  it('12. browser.find / anti.inspect.find searches snapshot descriptors by text and regex pattern', async () => {
    const { catalogue, target, ctx, registry } = createParityHarness();

    // Populate registry with test descriptors
    const session = registry.beginCollection({
      tabId: target.tabId,
      paneId: 'desktop',
      browserEpoch: target.browserEpoch,
      documentGeneration: target.documentGeneration,
      documentUrl: 'https://myshopify.test/storefront/product-1',
    });

    registry.publishSnapshot({
      tabId: target.tabId,
      paneId: 'desktop',
      browserEpoch: target.browserEpoch,
      documentGeneration: target.documentGeneration,
      documentUrl: 'https://myshopify.test/storefront/product-1',
      sequence: session.sequence,
      nonce: session.nonce,
      rawDescriptors: [
        {
          path: [{ kind: 'dom', index: 0, id: 'main-nav' }, { kind: 'dom', index: 1 }],
          fingerprint: { tag: 'a', role: 'link' },
          role: 'link',
          label: 'Home Catalog',
          rect: { x: 10, y: 20, width: 100, height: 30, centerX: 60, centerY: 35 },
        },
        {
          path: [{ kind: 'dom', index: 0, id: 'buy-box' }, { kind: 'dom', index: 2, id: 'btn-add-to-cart' }],
          fingerprint: { tag: 'button', role: 'button', id: 'btn-add-to-cart' },
          role: 'button',
          type: 'submit',
          label: 'Thêm vào giỏ hàng',
          id: 'btn-add-to-cart',
          metadata: { sectionId: 'product-template', productId: 'prod_9988' },
          rect: { x: 50, y: 150, width: 200, height: 45, centerX: 150, centerY: 172 },
        },
        {
          path: [{ kind: 'dom', index: 0, id: 'footer' }],
          fingerprint: { tag: 'footer', role: 'contentinfo' },
          role: 'contentinfo',
          label: 'Copyright 2026 Storefront',
          rect: { x: 0, y: 800, width: 1200, height: 60, centerX: 600, centerY: 830 },
        },
      ],
    });

    // Search via text query: 'giỏ hàng'
    const findTextRes = (await catalogue.dispatch('anti.inspect.find', {
      text: 'giỏ hàng',
      tabId: target.tabId,
    }, ctx)) as any;

    assert.strictEqual(findTextRes.count, 1, 'Should find exactly 1 matching descriptor for text "giỏ hàng"');
    assert.ok(findTextRes.matches[0].ref.startsWith('@e'), 'Matching element must have a valid @eN ref');
    assert.strictEqual(findTextRes.matches[0].id, 'btn-add-to-cart');
    assert.strictEqual(findTextRes.matches[0].role, 'button');
    assert.ok(findTextRes.formattedText.includes('Thêm vào giỏ hàng'));

    // Search via regex query: '/(catalog|storefront)/i'
    const findRegexRes = (await catalogue.dispatch('browser.find', {
      regex: '/(catalog|storefront)/i',
      tabId: target.tabId,
    }, ctx)) as any;

    assert.strictEqual(findRegexRes.count, 2, 'Regex search should match Home Catalog and Storefront Footer');
    assert.ok(findRegexRes.matches[0].ref.startsWith('@e'));
    assert.ok(findRegexRes.matches[1].ref.startsWith('@e'));
    // Search via regex query with global flag 'g': '/(catalog|storefront)/gi' to verify no alternating stateful misses
    const findGlobalRegexRes = (await catalogue.dispatch('browser.find', {
      regex: '/(catalog|storefront)/gi',
      tabId: target.tabId,
    }, ctx)) as any;
    assert.strictEqual(findGlobalRegexRes.count, 2, 'Global flag g must be stripped so repeated tests do not fail on lastIndex mutation');
    assert.strictEqual(findGlobalRegexRes.matches[0].ref, findRegexRes.matches[0].ref);
    assert.strictEqual(findGlobalRegexRes.matches[1].ref, findRegexRes.matches[1].ref);

    const findEmptyRes = (await catalogue.dispatch('anti.inspect.find', {
      text: 'nonexistent-query-xyz',
      tabId: target.tabId,
    }, ctx)) as any;

    assert.strictEqual(findEmptyRes.count, 0);
    assert.ok(findEmptyRes.formattedText.includes('No elements matching'));
  });

  it('13. End-to-end ref loop: browser.find returns @eN which resolves and executes in action executor', async () => {
    const { host, catalogue, target, ctx, registry, cdpCalls } = createParityHarness();

    const session = registry.beginCollection({
      tabId: target.tabId,
      paneId: 'desktop',
      browserEpoch: target.browserEpoch,
      documentGeneration: target.documentGeneration,
      documentUrl: 'https://myshopify.test/storefront/product-1',
    });

    registry.publishSnapshot({
      tabId: target.tabId,
      paneId: 'desktop',
      browserEpoch: target.browserEpoch,
      documentGeneration: target.documentGeneration,
      documentUrl: 'https://myshopify.test/storefront/product-1',
      sequence: session.sequence,
      nonce: session.nonce,
      rawDescriptors: [
        {
          path: [{ kind: 'dom', index: 0, id: 'product-form' }, { kind: 'dom', index: 3, id: 'submit-order' }],
          fingerprint: { tag: 'button', role: 'button', id: 'submit-order' },
          role: 'button',
          type: 'submit',
          label: 'Proceed to Checkout',
          id: 'submit-order',
          rect: { x: 100, y: 250, width: 180, height: 40, centerX: 190, centerY: 270 },
        },
      ],
    });

    // 1. Agent calls find to locate the checkout button ref
    const findRes = (await catalogue.dispatch('browser.find', {
      text: 'Checkout',
      tabId: target.tabId,
    }, ctx)) as any;

    assert.strictEqual(findRes.count, 1);
    const foundRef = findRes.matches[0].ref;
    assert.ok(foundRef.startsWith('@e'), 'Must extract @eN token');

    // 2. Agent passes the extracted ref directly to resolveRef
    const resolvedDesc = registry.resolveRef({
      tabId: target.tabId,
      paneId: 'desktop',
      browserEpoch: target.browserEpoch,
      documentGeneration: target.documentGeneration,
      documentUrl: 'https://myshopify.test/storefront/product-1',
    }, foundRef);

    assert.strictEqual(resolvedDesc.ref, foundRef);
    assert.strictEqual(resolvedDesc.id, 'submit-order');
    assert.strictEqual(resolvedDesc.rect?.centerX, 190);
    assert.strictEqual(resolvedDesc.rect?.centerY, 270);

    // 3. Agent executes click on the found ref through catalogue and asserts action execution & CDP dispatch
    const clickRes = (await catalogue.dispatch('anti.agent.cursor.click', {
      ref: foundRef,
      tabId: target.tabId,
    }, ctx)) as any;
    assert.strictEqual(clickRes?.clicked, true, 'Action executor must successfully click on the resolved @eN ref');
    const mouseEvents = cdpCalls.filter((c) => c.method === 'Input.dispatchMouseEvent');
    assert.ok(mouseEvents.length >= 2, 'CDP Input.dispatchMouseEvent must be dispatched for mousePressed and mouseReleased');
    const pressEvent = mouseEvents.find((c: any) => (c.params as any)?.type === 'mousePressed');
    assert.strictEqual((pressEvent?.params as any)?.x, 190, 'Click X coordinate must match resolved center X');
    assert.strictEqual((pressEvent?.params as any)?.y, 270, 'Click Y coordinate must match resolved center Y');
  });

  it('14. browser_find canonical Playwright MCP schema validation', async () => {
    const { catalogue, target, ctx } = createParityHarness();

    // Verify canonical route exists in catalogue
    assert.ok(catalogue.get('browser_find'), 'browser_find must be registered');
    assert.ok(catalogue.get('anti.inspect.find'), 'anti.inspect.find must be registered');
    assert.ok(catalogue.get('antifan_find'), 'antifan_find must be registered');

    // Error case: both text and regex provided
    await assert.rejects(async () => {
      await catalogue.dispatch('browser_find', {
        text: 'hello',
        regex: '/hello/',
        tabId: target.tabId,
      }, ctx);
    }, (err: any) => {
      assert.strictEqual(err.code, 'INVALID_ARGUMENT');
      assert.ok(err.message.includes('Provide either "text" or "regex", not both'));
      return true;
    });

    // Error case: neither text nor regex provided
    await assert.rejects(async () => {
      await catalogue.dispatch('browser_find', {
        tabId: target.tabId,
      }, ctx);
    }, (err: any) => {
      assert.strictEqual(err.code, 'INVALID_ARGUMENT');
      assert.ok(err.message.includes('Either "text" or "regex" must be provided'));
      return true;
    });
  });

  it('15. Cold-registry agentFind triggers snapshot capture without deadlocking on targetOperation queue', async () => {
    const { host, target, registry } = createParityHarness();

    // Ensure registry has NO existing snapshot for target
    assert.strictEqual(registry.getStats().totalDescriptors, 0, 'Registry must start cold with 0 descriptors');

    // Call agentFind on cold target with race timeout — must not deadlock on targetOperation Promise tail
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Deadlock timeout: agentFind hung on targetOperation queue')), 2000);
      timer.unref?.();
    });

    const findRes = (await Promise.race([
      host.agentFind({
        text: 'fake',
        tabId: target.tabId,
      }),
      timeoutPromise,
    ])) as any;

    assert.ok(findRes, 'Cold agentFind must resolve without deadlocking or timing out');
    assert.strictEqual(typeof findRes.count, 'number');
  });

  it('16. keyboard-normalizer parses compound key combinations ("Control+a", "Shift+Tab", "Escape", "+")', () => {
    const { parseKeyCombo, buildKeyboardInputEvents } = require('../../src/main/browser/keyboard-normalizer');

    // Compound combo: Control+a
    const ctrlA = parseKeyCombo('Control+a');
    assert.strictEqual(ctrlA.key, 'a');
    assert.deepStrictEqual(ctrlA.modifiers, ['control']);

    const eventsCtrlA = buildKeyboardInputEvents('Control+a');
    assert.strictEqual(eventsCtrlA.length, 2, 'Ctrl+A shortcut must emit keyDown and keyUp without char event');
    assert.strictEqual(eventsCtrlA[0].type, 'keyDown');
    assert.strictEqual(eventsCtrlA[0].keyCode, 'a');
    assert.deepStrictEqual(eventsCtrlA[0].modifiers, ['control']);

    // Compound combo: Shift+Tab
    const shiftTab = parseKeyCombo('Shift+Tab');
    assert.strictEqual(shiftTab.key, 'Tab');
    assert.deepStrictEqual(shiftTab.modifiers, ['shift']);

    const eventsShiftTab = buildKeyboardInputEvents('Shift+Tab');
    assert.strictEqual(eventsShiftTab.length, 2);
    assert.strictEqual(eventsShiftTab[0].keyCode, 'Tab');
    assert.deepStrictEqual(eventsShiftTab[0].modifiers, ['shift']);

    // Literal plus sign: "+"
    const plus = parseKeyCombo('+');
    assert.strictEqual(plus.key, '+');
    assert.deepStrictEqual(plus.modifiers, []);

    // Trailing plus combinations: "Control++", "Shift++", "Ctrl+Shift++", "Control+Plus"
    assert.deepStrictEqual(parseKeyCombo('Control++'), { key: '+', modifiers: ['control'] });
    assert.deepStrictEqual(parseKeyCombo('Shift++'), { key: '+', modifiers: ['shift'] });
    assert.deepStrictEqual(parseKeyCombo('Ctrl+Shift++'), { key: '+', modifiers: ['control', 'shift'] });
    assert.deepStrictEqual(parseKeyCombo('Control+Plus'), { key: 'Plus', modifiers: ['control'] });

    const eventsCtrlPlus = buildKeyboardInputEvents('Control++');
    assert.strictEqual(eventsCtrlPlus.length, 2);
    assert.strictEqual(eventsCtrlPlus[0].keyCode, '+');
    assert.deepStrictEqual(eventsCtrlPlus[0].modifiers, ['control']);

    // Multi-modifier: Cmd+Option+ArrowRight
    const multiMod = parseKeyCombo('Cmd+Option+ArrowRight');
    assert.strictEqual(multiMod.key, 'ArrowRight');
    assert.ok(multiMod.modifiers.includes('meta'));
    assert.ok(multiMod.modifiers.includes('alt'));

    // Incomplete / malformed combinations must throw
    assert.throws(() => parseKeyCombo('Ctrl+'), /Incomplete or malformed key combination/);
    assert.throws(() => parseKeyCombo('Shift+'), /Incomplete or malformed key combination/);
    assert.throws(() => parseKeyCombo('Control+Shift+'), /Incomplete or malformed key combination/);
  });

  it('17. browser_press_key canonical Playwright MCP dispatch and execution', async () => {
    const { catalogue, target, ctx } = createParityHarness();

    assert.ok(catalogue.get('browser_press_key'), 'browser_press_key must be registered');

    const pressRes = (await catalogue.dispatch('browser_press_key', {
      key: 'Control+a',
      tabId: target.tabId,
    }, ctx)) as any;

    assert.strictEqual(pressRes?.success, true);
    assert.strictEqual(pressRes?.key, 'Control+a');
  });

  it('18. BrowserControlPort stages screenshot to ArtifactSink and returns valid ArtifactRef', async () => {
    const stagedArtifacts: any[] = [];
    const fakeArtifactSink = {
      stage(input: any) {
        const ref = {
          kind: input.kind,
          id: `artifact-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          mime: input.mime,
          size: input.data.length,
          digest: 'sha256-test',
          runId: input.runId,
          attemptId: input.attemptId,
          projectId: input.projectId,
          workspaceId: input.workspaceId,
          createdAt: Date.now(),
        };
        stagedArtifacts.push({ ref, data: input.data });
        return ref;
      },
    };

    const { BrowserControlPort } = require('../../src/main/tools/browser-control-port');
    const sampleBase64 = Buffer.from('fake-png-binary-data').toString('base64');
    const fakeHost = {
      getTabList: () => [{ id: 'tab-1', url: 'https://example.com' }],
      captureScreenshot: async () => sampleBase64,
      getDocumentGeneration: () => 1,
    };

    const portWithArtifacts = new BrowserControlPort(fakeHost, fakeArtifactSink);
    const target = {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const result = await portWithArtifacts.screenshot(target, 'run-1', 'attempt-1', 'tab-1');
    assert.ok(typeof result === 'object' && result !== null, 'Result must be an ArtifactRef object');
    assert.strictEqual(result.kind, 'screenshot');
    assert.strictEqual(result.mime, 'image/png');
    assert.ok(result.id.startsWith('artifact-'), 'Artifact ID must start with "artifact-"');
    assert.strictEqual(stagedArtifacts.length, 1);
    assert.strictEqual(stagedArtifacts[0].ref.id, result.id);
  });

  it('19. antifan-omp-mcp tool definitions include ref parameter and Playwright tools', () => {
    const ompScript = require('fs').readFileSync(
      require('path').resolve(__dirname, '../../scripts/antifan-omp-mcp.cjs'),
      'utf8'
    );
    assert.ok(ompScript.includes("'browser_find'"), 'Must declare browser_find in OMP MCP tools');
    assert.ok(ompScript.includes("'browser_press_key'"), 'Must declare browser_press_key in OMP MCP tools');
    assert.ok(ompScript.includes("['anti.agent.cursor.type'"), 'Must declare anti.agent.cursor.type');
    assert.ok(ompScript.includes("ref: { type: 'string' }"), 'Cursor tools must include ref: { type: "string" }');
  });

  it('20. anti.agent.sequence executes multi-step action sequence with navigation guard', async () => {
    const { catalogue, target, ctx } = createParityHarness();

    assert.ok(catalogue.get('browser.agent-sequence'), 'browser.agent-sequence must be registered');
    assert.ok(catalogue.get('anti.agent.sequence'), 'anti.agent.sequence must be registered');
    assert.ok(catalogue.get('antifan_agent_sequence'), 'antifan_agent_sequence must be registered');

    let executedActions: any[] = [];
    const fakeHostWithSeq = {
      getTabList: () => [{ id: 'tab-seq-1', url: 'https://example.com' }],
      getDocumentGeneration: () => 1,
      executeActionSequence: async (params: any) => {
        executedActions = params.actions;
        return {
          success: true,
          executedCount: params.actions.length,
          totalCount: params.actions.length,
          results: params.actions.map((a: any, i: number) => ({ actionIndex: i, type: a.type, success: true })),
        };
      },
    };

    const { BrowserControlPort } = require('../../src/main/tools/browser-control-port');
    const portWithSeq = new BrowserControlPort(fakeHostWithSeq);
    const targetSeq = {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      tabId: 'tab-seq-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const res = (await portWithSeq.sequence({
      actions: [
        { type: 'navigate', url: 'https://example.com/search?q=ram' },
        { type: 'type', text: 'RTX 4090', ref: '@e1' },
        { type: 'click', ref: '@e2', settleMs: 50 },
        { type: 'wait', waitMs: 100 },
        { type: 'screenshot', format: 'jpeg', quality: 80 },
      ],
      tabId: 'tab-seq-1',
    }, targetSeq)) as Record<string, unknown>;

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.executedCount, 5);
    assert.strictEqual(executedActions.length, 5);
    assert.strictEqual(executedActions[0].type, 'navigate');
    assert.strictEqual(executedActions[0].url, 'https://example.com/search?q=ram');
    assert.strictEqual(executedActions[1].text, 'RTX 4090');
    assert.strictEqual(executedActions[4].format, 'jpeg');
  });

  it('21. anti.screenshot.viewport and BrowserControlPort support JPEG format and quality', async () => {
    const sampleJpegBase64 = Buffer.from('fake-jpeg-binary-data').toString('base64');
    let capturedOptions: any = null;
    const fakeHost = {
      getTabList: () => [{ id: 'tab-1', url: 'https://example.com' }],
      captureScreenshot: async (_rect: any, _tabId: any, _paneId: any, options: any) => {
        capturedOptions = options;
        return sampleJpegBase64;
      },
      getDocumentGeneration: () => 1,
    };

    const { BrowserControlPort } = require('../../src/main/tools/browser-control-port');
    const port = new BrowserControlPort(fakeHost);
    const target = {
      projectId: 'proj-1',
      workspaceId: 'ws-1',
      runtimeId: 'rt-1',
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
    };

    const result = await port.screenshot(target, 'run-1', 'attempt-1', 'tab-1', undefined, { format: 'jpeg', quality: 80 });
    assert.strictEqual(capturedOptions?.format, 'jpeg');
    assert.strictEqual(capturedOptions?.quality, 80);
    assert.strictEqual(typeof result, 'string');
  });

  it('22. buildIsolatedCollectorScript incorporates viewportOnly and sticky element whitelist', () => {
    const { buildIsolatedCollectorScript } = require('../../src/main/browser/semantic-ref-executor');
    const scriptWithVp = buildIsolatedCollectorScript('test-nonce', 'https://example.com', undefined, true);
    assert.ok(scriptWithVp.includes('isViewportOnly = true'), 'Must set isViewportOnly flag to true');
    assert.ok(scriptWithVp.includes('isStickyOrFixed'), 'Must include sticky/fixed element whitelist check');
    assert.ok(scriptWithVp.includes('vpHeight * 1.5'), 'Must check viewport height threshold (1.5x)');
  });
});
