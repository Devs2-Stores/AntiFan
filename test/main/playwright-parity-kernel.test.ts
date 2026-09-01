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
        return { ok: true, count: 1 };
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

    const host = new TabAutomationHost({
      getTabWebContents: () => mockWc,
      getTabRecord: () => tabRecord,
      getAutomationTabId: () => 'tab-p1',
      getActiveTabId: () => 'tab-p1',
      getBrowserEpoch: () => 1,
      getSemanticDocumentGeneration: () => 1,
      semanticRefRegistry: registry,
      runTargetOperation: async (_tabId, _paneId, op) => op(),
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
      agentClick: async () => true,
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

    return { host, registry, cdpCalls, mockWc, catalogue, browserPort, target, lease };
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
});
