import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import * as vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { TabAutomationHost, TabAutomationContext } from '../../src/main/browser/tab-automation-host';
import { buildIsolatedExecutorScript } from '../../src/main/browser/semantic-ref-executor';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';

describe('Phase 03: Pure CSS-Pixel CDP Input & Actionability Gate', () => {
  // --- Section A: In-Renderer Actionability & Auto-Wait Script Tests ---

  function createMockDomContext(
    initialHtml: string = '',
    currentUrl: string = 'https://storefront-test.com/products/jacket',
    maxTouchPoints: number = 0
  ) {
    const listeners: Record<string, Function[]> = {};
    const mutationObservers: any[] = [];

    class MockElement {
      tagName: string;
      id: string;
      className: string;
      style: Record<string, string>;
      disabled: boolean = false;
      attributes: Record<string, string> = {};
      children: MockElement[] = [];
      parentElement: MockElement | null = null;
      isConnected: boolean = true;
      rect: { x: number; y: number; width: number; height: number } = { x: 100, y: 200, width: 80, height: 40 };

      constructor(tag: string, id: string = '') {
        this.tagName = tag.toUpperCase();
        this.id = id;
        this.className = '';
        this.style = { display: 'block', visibility: 'visible', opacity: '1' };
      }

      getAttribute(name: string) {
        return this.attributes[name] || null;
      }

      setAttribute(name: string, value: string) {
        this.attributes[name] = value;
        for (const obs of mutationObservers) {
          obs.notify();
        }
      }

      getBoundingClientRect() {
        return {
          x: this.rect.x,
          y: this.rect.y,
          width: this.rect.width,
          height: this.rect.height,
          top: this.rect.y,
          left: this.rect.x,
          bottom: this.rect.y + this.rect.height,
          right: this.rect.x + this.rect.width,
        };
      }

      scrollIntoView() {
        // Simulates scroll adjustment
        this.rect.x = 100;
        this.rect.y = 150;
      }

      focus() {}

      dispatchEvent(event: any) {
        return true;
      }

      appendChild(child: MockElement) {
        child.parentElement = this;
        this.children.push(child);
        for (const obs of mutationObservers) {
          obs.notify();
        }
        return child;
      }

      querySelector(selector: string): MockElement | null {
        if (selector.startsWith('#') && this.id === selector.slice(1)) return this;
        for (const child of this.children) {
          const match = child.querySelector(selector);
          if (match) return match;
        }
        return null;
      }
    }

    const documentElement = new MockElement('HTML');
    const body = new MockElement('BODY');
    documentElement.appendChild(body);

    class MockMutationObserver {
      callback: Function;
      constructor(cb: Function) {
        this.callback = cb;
        mutationObservers.push(this);
      }
      observe() {}
      disconnect() {
        const idx = mutationObservers.indexOf(this);
        if (idx !== -1) mutationObservers.splice(idx, 1);
      }
      notify() {
        this.callback();
      }
    }

    class MockMouseEvent {
      type: string;
      constructor(type: string, public options: any = {}) {
        this.type = type;
      }
    }

    const sandbox = {
      window: {
        location: { href: currentUrl },
        getComputedStyle: (el: MockElement) => ({
          display: el.style.display || 'block',
          visibility: el.style.visibility || 'visible',
          opacity: el.style.opacity || '1',
        }),
      },
      document: {
        documentElement,
        body,
        location: { href: currentUrl },
        querySelector: (sel: string) => documentElement.querySelector(sel),
      },
      navigator: { maxTouchPoints },
      Element: MockElement,
      MutationObserver: MockMutationObserver,
      MouseEvent: MockMouseEvent,
      setTimeout,
      clearTimeout,
      requestAnimationFrame: (cb: Function) => setTimeout(cb, 16),
      cancelAnimationFrame: (id: any) => clearTimeout(id),
      Date,
      Array,
      Object,
      JSON,
      Promise,
      parseFloat,
      Boolean,
      String,
    };

    (sandbox.window as any).window = sandbox.window;
    (sandbox.window as any).document = sandbox.document;

    return {
      context: vm.createContext(sandbox),
      body,
      MockElement,
    };
  }

  it('1. Resolves delayed element via MutationObserver within auto-wait window', async () => {
    const { context, body, MockElement } = createMockDomContext();

    // Trigger script for element that does not exist yet
    const script = buildIsolatedExecutorScript({
      action: 'focus',
      selector: '#delayed-add-to-cart',
      documentUrl: 'https://storefront-test.com/products/jacket',
      nonce: 'test-nonce',
    });

    const executionPromise = vm.runInContext(script, context);

    // Simulate async element rendering after 60ms (Vue/React hydration)
    setTimeout(() => {
      const btn = new MockElement('BUTTON', 'delayed-add-to-cart');
      btn.rect = { x: 120, y: 300, width: 100, height: 50 };
      body.appendChild(btn);
    }, 60);

    const result = await executionPromise;
    assert.strictEqual(result.ok, true, 'Must successfully resolve delayed element');
    assert.strictEqual(result.executed, true);
    assert.ok(result.rect, 'Must return computed rect');
    // Bounding rect post-scroll: (100, 150), width 100, height 50 -> center (150, 175)
    assert.strictEqual(result.rect.centerX, 150);
    assert.strictEqual(result.rect.centerY, 175);
  });

  it('2. Rejects hidden elements with ELEMENT_NOT_VISIBLE', async () => {
    const { context, body, MockElement } = createMockDomContext();

    const hiddenBtn = new MockElement('BUTTON', 'hidden-cart-btn');
    hiddenBtn.style.display = 'none';
    body.appendChild(hiddenBtn);

    const script = buildIsolatedExecutorScript({
      action: 'click',
      selector: '#hidden-cart-btn',
      documentUrl: 'https://storefront-test.com/products/jacket',
      nonce: 'test-nonce',
    });

    const result = await vm.runInContext(script, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'ELEMENT_NOT_VISIBLE');
  });

  it('3. Rejects disabled elements with ELEMENT_DISABLED', async () => {
    const { context, body, MockElement } = createMockDomContext();

    const disabledBtn = new MockElement('BUTTON', 'disabled-submit');
    disabledBtn.setAttribute('aria-disabled', 'true');
    body.appendChild(disabledBtn);

    const script = buildIsolatedExecutorScript({
      action: 'click',
      selector: '#disabled-submit',
      documentUrl: 'https://storefront-test.com/products/jacket',
      nonce: 'test-nonce',
    });
    const result = await vm.runInContext(script, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'ELEMENT_DISABLED');
  });

  it('4. Rejects pre-execution navigation mismatch with REF_DOCUMENT_MUTATED', async () => {
    const { context, body, MockElement } = createMockDomContext('', 'https://storefront-test.com/cart');

    const btn = new MockElement('BUTTON', 'checkout-btn');
    body.appendChild(btn);

    const script = buildIsolatedExecutorScript({
      action: 'click',
      selector: '#checkout-btn',
      documentUrl: 'https://storefront-test.com/products/jacket',
      nonce: 'test-nonce',
    });

    const result = await vm.runInContext(script, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, 'REF_DOCUMENT_MUTATED');
  });

  // --- Section B: TabAutomationHost CDP Native Input Tests ---

  let cdpSentCommands: Array<{ method: string; params: any }> = [];
  let isDebuggerAttached = false;
  let debuggerAttachThrows = false;
  let emulatedMaxTouchPoints = 0;
  let rejectedCdpCommand: { method: string; type: string } | null = null;

  const mockWebContents = {
    isDestroyed: () => false,
    getURL: () => 'https://storefront-test.com/products/jacket',
    executeJavaScript: async () => {},
    mainFrame: {
      executeJavaScriptInIsolatedWorld: async (_worldId: number, scripts: Array<{ code: string }>) => {
        // Execute real buildIsolatedExecutorScript against simulated DOM
        const { context, body, MockElement } = createMockDomContext(
          '',
          'https://storefront-test.com/products/jacket',
          emulatedMaxTouchPoints
        );
        const btn = new MockElement('BUTTON', 'add-to-cart-button');
        btn.rect = { x: 100, y: 200, width: 80, height: 40 };
        body.appendChild(btn);

        const input = new MockElement('INPUT', 'customer-note');
        body.appendChild(input);

        return await vm.runInContext(scripts[0]?.code || '', context);
      },
    },
    debugger: {
      isAttached: () => isDebuggerAttached,
      attach: (_version: string) => {
        if (debuggerAttachThrows) {
          throw new Error('Another debugger is already attached to this target');
        }
        isDebuggerAttached = true;
      },
      detach: () => {
        isDebuggerAttached = false;
      },
      sendCommand: async (method: string) => {
        throw new Error(`Raw debugger command bypassed shared CDP transport: ${method}`);
      },
    },
  };

  const mockTabRecord = {
    state: {
      id: 'tab-test-01',
      title: 'Storefront',
      url: 'https://storefront-test.com/products/jacket',
      focusedPane: 'desktop',
    },
    view: {
      webContents: mockWebContents,
    },
  };

  const mockTabContext = {
    getActiveTabId: () => 'tab-test-01',
    getAutomationTabId: () => 'tab-test-01',
    getTabRecord: (_id: string) => mockTabRecord,
    getAllTabs: () => new Map([['tab-test-01', mockTabRecord]]).entries(),
    getTabWebContents: (_tabId?: string, _paneId?: any) => mockWebContents,
    getBrowserEpoch: () => 1,
    getSemanticDocumentGeneration: () => 1,
    runTargetOperation: async <T>(_tabId: string, _paneId: any, op: () => Promise<T>) => op(),
    broadcastState: () => {},
    syncFrameBackdrop: () => {},
    semanticRefRegistry: null as any,
    tabDevToolsHost: {
      sendCdpCommand: async (_wc: unknown, method: string, params: any) => {
        cdpSentCommands.push({ method, params });
        if (rejectedCdpCommand?.method === method && rejectedCdpCommand.type === params?.type) {
          rejectedCdpCommand = null;
          throw new Error(`Injected ${method} ${params.type} failure`);
        }
        return {};
      },
    },
  } as unknown as TabAutomationContext;

  let automationHost: TabAutomationHost;

  before(() => {
    automationHost = new TabAutomationHost(mockTabContext);
  });

  it('5. Dispatches CDP mouse click events with post-scroll CSS center coordinates', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = false;
    debuggerAttachThrows = false;
    emulatedMaxTouchPoints = 0;
    rejectedCdpCommand = null;

    const result = await automationHost.dispatchAgentAction('click', {
      selector: '#add-to-cart-button',
      trusted: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual((result.data as any)?.tier, 'cdp_trusted');
    // Post scroll rect: (100, 150), width 80, height 40 -> center (140, 170)
    assert.strictEqual((result.data as any)?.x, 140);
    assert.strictEqual((result.data as any)?.y, 170);

    const mouseMoved = cdpSentCommands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseMoved');
    const mousePressed = cdpSentCommands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mousePressed');
    const mouseReleased = cdpSentCommands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseReleased');

    assert.ok(mouseMoved, 'Must dispatch CDP mouseMoved');
    assert.ok(mousePressed, 'Must dispatch CDP mousePressed');
    assert.ok(mouseReleased, 'Must dispatch CDP mouseReleased');
    assert.strictEqual(mousePressed?.params?.x, 140);
    assert.strictEqual(mousePressed?.params?.y, 170);
    assert.strictEqual(mousePressed?.params?.buttons, 1);
    assert.strictEqual(mouseReleased?.params?.buttons, 0);
  });

  it('5b. Dispatches focused CDP mouse events and preserves touch inputType on touch-capable viewports', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = true;
    debuggerAttachThrows = false;
    emulatedMaxTouchPoints = 5;
    rejectedCdpCommand = null;

    const result = await automationHost.dispatchAgentAction('click', {
      selector: '#add-to-cart-button',
      trusted: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual((result.data as any)?.tier, 'cdp_trusted');
    assert.strictEqual((result.data as any)?.inputType, 'touch');
    assert.ok(cdpSentCommands.some((c) => c.method === 'Emulation.setFocusEmulationEnabled' && c.params?.enabled === true));
    const mouseEvents = cdpSentCommands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    assert.deepStrictEqual(mouseEvents.map((c) => c.params?.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.strictEqual(mouseEvents[1]?.params?.x, 140);
    assert.strictEqual(mouseEvents[1]?.params?.y, 170);
  });

  it('5c. Releases a partial mouse press on touch viewports and never crosses tiers after mousePressed', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = true;
    debuggerAttachThrows = false;
    emulatedMaxTouchPoints = 5;
    rejectedCdpCommand = { method: 'Input.dispatchMouseEvent', type: 'mouseReleased' };

    const result = await automationHost.dispatchAgentAction('click', {
      selector: '#add-to-cart-button',
      trusted: true,
    });

    assert.strictEqual(result.success, false);
    assert.match(result.reason || '', /mouse release failed after mousePressed/);
    const mouseEvents = cdpSentCommands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    assert.deepStrictEqual(mouseEvents.map((c) => c.params?.type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseReleased']);
    assert.strictEqual(mouseEvents.at(-1)?.params?.buttons, 0);
  });
  it('5d. Releases a partial mouse press and never crosses to synthetic click after mousePressed', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = true;
    debuggerAttachThrows = false;
    emulatedMaxTouchPoints = 0;
    rejectedCdpCommand = { method: 'Input.dispatchMouseEvent', type: 'mouseReleased' };

    const result = await automationHost.dispatchAgentAction('click', {
      selector: '#add-to-cart-button',
      trusted: true,
    });

    assert.strictEqual(result.success, false);
    assert.match(result.reason || '', /mouse release failed after mousePressed/);
    assert.deepStrictEqual(
      cdpSentCommands.filter((command) => command.method === 'Input.dispatchMouseEvent').map((command) => command.params?.type),
      ['mouseMoved', 'mousePressed', 'mouseReleased', 'mouseReleased']
    );
    assert.strictEqual(cdpSentCommands.at(-1)?.params?.buttons, 0);
  });

  it('6. Dispatches CDP mouse hover (mouseMoved) event to element center', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = true;

    const result = await automationHost.dispatchAgentAction('hover', {
      selector: '#add-to-cart-button',
      trusted: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual((result.data as any)?.tier, 'cdp_trusted');
    assert.strictEqual((result.data as any)?.x, 140);
    assert.strictEqual((result.data as any)?.y, 170);

    const mouseMoved = cdpSentCommands.find((c) => c.method === 'Input.dispatchMouseEvent' && c.params?.type === 'mouseMoved');
    assert.ok(mouseMoved, 'Must dispatch CDP mouseMoved for hover');
    assert.strictEqual(mouseMoved?.params?.x, 140);
    assert.strictEqual(mouseMoved?.params?.y, 170);
  });

  it('7. Dispatches CDP keyboard text insertion for trusted typing', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = true;

    const result = await automationHost.dispatchAgentAction('type', {
      selector: '#customer-note',
      text: 'Fragile handling please',
      trusted: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual((result as any)?.executionTier, 'cdp_trusted');
    assert.strictEqual((result.data as any)?.tier, 'cdp_trusted');
    assert.strictEqual((result.data as any)?.executionTier, 'cdp_trusted');
    const insertTextCmd = cdpSentCommands.find((c) => c.method === 'Input.insertText');
    assert.ok(insertTextCmd, 'Must issue CDP Input.insertText');
    assert.strictEqual(insertTextCmd?.params?.text, 'Fragile handling please');
  });

  it('8. Falls back gracefully to Isolated World synthetic event when wc.debugger is busy', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = false;
    debuggerAttachThrows = true;

    const result = await automationHost.dispatchAgentAction('click', {
      selector: '#add-to-cart-button',
      trusted: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual((result.data as any)?.executionTier, 'isolated_synthetic');
    assert.strictEqual(cdpSentCommands.length, 0, 'No CDP commands should be sent when debugger is busy');
  });

  it('9. Resolves initially-hidden connected element that becomes visible after 60ms', async () => {
    const { context, body, MockElement } = createMockDomContext();

    const initiallyHiddenBtn = new MockElement('BUTTON', 'hydrating-btn');
    initiallyHiddenBtn.style.display = 'none';
    body.appendChild(initiallyHiddenBtn);

    const script = buildIsolatedExecutorScript({
      action: 'focus',
      selector: '#hydrating-btn',
      documentUrl: 'https://storefront-test.com/products/jacket',
      nonce: 'test-nonce',
    });

    const executionPromise = vm.runInContext(script, context);

    // After 60ms, simulate React/Vue removing display: none
    setTimeout(() => {
      initiallyHiddenBtn.style.display = 'block';
      initiallyHiddenBtn.setAttribute('data-hydrated', 'true');
    }, 60);

    const result = await executionPromise;
    assert.strictEqual(result.ok, true, 'Must successfully resolve element once it becomes visible');
    assert.strictEqual(result.executed, true);
  });

  it('10. Exercises traceInteraction with TabAutomationHost verifying trusted_cdp on CDP type and isolated_synthetic fallback', async () => {
    cdpSentCommands = [];
    isDebuggerAttached = true;
    debuggerAttachThrows = false;

    const mockControlHost: Partial<BrowserHostPort> = {
      getTabList: () => [{ id: 'tab-1' }],
      getActiveTabId: () => 'tab-1',
      getAutomationTabId: () => 'tab-1',
      dispatchAgentAction: (action, params) => automationHost.dispatchAgentAction(action as any, params as any),
      evalJs: async () => ({
        url: 'https://storefront-test.com/products/jacket',
        bodyClasses: [],
        bodyOverflowLocked: false,
        activeOverlays: [],
        hasHorizontalOverflow: false,
      }),
      inspectStyles: async () => ({}),
    };

    const port = new BrowserControlPort(mockControlHost as BrowserHostPort);
    const res = await port.traceInteraction(
      { projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 },
      'run-1',
      'att-1',
      { action: 'type', selector: '#customer-note', text: 'Real host verified' }
    );

    assert.strictEqual(res.action, 'type');
    assert.strictEqual(res.actionSuccess, true);
    assert.strictEqual(res.interactionMode, 'trusted_cdp');

    // For click, when debugger is busy, executeTrustedClick falls back to isolated_synthetic
    isDebuggerAttached = false;
    debuggerAttachThrows = true;
    const fallbackClickRes = await port.traceInteraction(
      { projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 },
      'run-1',
      'att-1',
      { action: 'click', selector: '#add-to-cart-button' }
    );

    assert.strictEqual(fallbackClickRes.action, 'click');
    assert.strictEqual(fallbackClickRes.actionSuccess, true);
    assert.strictEqual(fallbackClickRes.interactionMode, 'programmatic_dom');

    // For type, when debugger fails, executeTrustedType fails closed (no synthetic fallback)
    const fallbackTypeRes = await port.traceInteraction(
      { projectId: 'p1', workspaceId: 'w1', runtimeId: 'r1', tabId: 'tab-1', browserEpoch: 1, documentGeneration: 1 },
      'run-1',
      'att-1',
      { action: 'type', selector: '#customer-note', text: 'Fail closed' }
    );

    assert.strictEqual(fallbackTypeRes.action, 'type');
    assert.strictEqual(fallbackTypeRes.actionSuccess, false);
    assert.strictEqual(fallbackTypeRes.verdict, 'ACTION_FAILED');
  });
});
