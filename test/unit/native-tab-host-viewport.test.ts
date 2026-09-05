import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { issueRuntimeLease, makeControlPlaneId, BrowserTarget } from '../../src/shared/control-plane-contracts';
import { NativeTabHost, NativeTabRecord } from '../../src/main/browser/native-tab-host';
import { AntiFanTab } from '../../src/shared/contracts';
import { TabDevToolsHost } from '../../src/main/browser/tab-devtools-host';
import { SemanticElementDescriptor } from '../../src/main/browser/semantic-ref-types';

interface CdpCssProperty {
  name: string;
  value: string;
}

interface CdpMatchedRule {
  rule: {
    selectorList: { selectors: Array<{ text: string }> };
    style: { cssProperties: CdpCssProperty[] };
    styleSheetId: string;
  };
}

interface CdpMatchedStylesPayload {
  matchedCSSRules?: CdpMatchedRule[];
}

function isCdpMatchedStylesPayload(val: unknown): val is CdpMatchedStylesPayload {
  return typeof val === 'object' && val !== null && 'matchedCSSRules' in val;
}

interface EmulationParams {
  screenPosition?: string;
  screenSize?: { width: number; height: number };
  viewPosition?: { x: number; y: number };
  deviceScaleFactor?: number;
  viewSize?: { width: number; height: number };
  scale?: number;
}

interface TestHostShape {
  tabs: Map<string, NativeTabRecord>;
  activeTabId: string;
  defaultUserAgent: string;
  emulationCalls: EmulationParams[];
  disabledEmulationCount: number;
  updateLayoutCallCount: number;
  updateLayout: () => void;
  safeEnableDeviceEmulation: (wc: unknown, params: EmulationParams) => void;
  safeDisableDeviceEmulation: (wc: unknown) => void;
  setSafeUserAgent: (wc: unknown, ua: string) => void;
  touchEmulationPromise: Promise<void>;
  applyCdpTouchEmulation: (wc: unknown, enabled: boolean) => Promise<void>;
  applyDeviceCornerClipping: (wc: unknown, radius: number) => void;
  setViewportSize: (options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string }) => Promise<boolean>;
  setDevicePreset: (tabId: string, presetId: string) => boolean;
}

function createTestTabRecord(id: string): NativeTabRecord {
  const state: AntiFanTab = {
    id,
    url: 'https://store.example.com',
    title: 'Store',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
  };

  const mockWebContents = {
    isDestroyed: () => false,
    setZoomFactor: (_factor: number) => {},
    insertCSS: async (_css: string) => '',
  };

  const mockView = {
    webContents: mockWebContents,
    setBounds: (_rect: { x: number; y: number; width: number; height: number }) => {},
    setBackgroundColor: (_color: string) => {},
  };

  return {
    view: mockView as unknown as NativeTabRecord['view'],
    state,
  };
}

function createTestHost(): TestHostShape {
  const host = Object.create(NativeTabHost.prototype) as TestHostShape;
  host.tabs = new Map<string, NativeTabRecord>();
  host.activeTabId = 'tab-1';
  host.defaultUserAgent = 'MockDesktopUA';
  host.emulationCalls = [];
  host.disabledEmulationCount = 0;
  host.updateLayoutCallCount = 0;

  host.safeEnableDeviceEmulation = (_wc: unknown, params: EmulationParams) => {
    host.emulationCalls.push(params);
  };
  host.safeDisableDeviceEmulation = (_wc: unknown) => {
    host.disabledEmulationCount++;
  };
  host.setSafeUserAgent = (_wc: unknown, _ua: string) => {};
  host.touchEmulationPromise = Promise.resolve();
  host.applyCdpTouchEmulation = (_wc: unknown, _enabled: boolean) => host.touchEmulationPromise;
  host.applyDeviceCornerClipping = (_wc: unknown, _radius: number) => {};

  host.updateLayout = () => {
    host.updateLayoutCallCount++;
    const tab = host.tabs.get(host.activeTabId);
    if (tab) {
      const applyEmulation = (NativeTabHost.prototype as unknown as {
        applyTabDeviceEmulation: (tab: NativeTabRecord, availableWidth: number, availableHeight: number, toolbarHeight: number) => void;
      }).applyTabDeviceEmulation;
      applyEmulation.call(host, tab, 1440, 900, 40);
    }
  };

  return host;
}

describe('Phase 1: Viewport Emulation & CDP Matched Styles Gateway', () => {
  it('applies a dynamic viewport and resolves only after touch emulation settles', async () => {
    const host = createTestHost();
    const tab = createTestTabRecord('tab-1');
    host.tabs.set('tab-1', tab);
    const deferred = Promise.withResolvers<void>();
    host.touchEmulationPromise = deferred.promise;

    let settled = false;
    const viewportPromise = host.setViewportSize({ width: 375, height: 667, mobile: true, deviceScaleFactor: 2 });
    viewportPromise.finally(() => { settled = true; });
    await Promise.resolve();
    assert.strictEqual(settled, false, 'Viewport setter must wait for touch emulation readiness');
    deferred.resolve();
    assert.strictEqual(await viewportPromise, true);

    // Verify customViewport state was recorded
    assert.deepStrictEqual(tab.customViewport, {
      width: 375,
      height: 667,
      mobile: true,
      deviceScaleFactor: 2,
    });
    assert.strictEqual(tab.state.devicePresetId, 'custom-375x667');
    assert.strictEqual(host.updateLayoutCallCount, 1);

    // Verify safeEnableDeviceEmulation was called with synthesized preset parameters (proves regression fix)
    assert.strictEqual(host.emulationCalls.length, 1);
    const emu = host.emulationCalls[0];
    assert.strictEqual(emu?.screenPosition, 'mobile');
    assert.deepStrictEqual(emu?.screenSize, { width: 375, height: 667 });
    assert.strictEqual(emu?.deviceScaleFactor, 2);
    assert.strictEqual(host.disabledEmulationCount, 0, 'Must NOT fall back to disabling device emulation');
  });

  it('clears customViewport when switching to a standard device preset', async () => {
    const host = createTestHost();
    const tab = createTestTabRecord('tab-1');
    host.tabs.set('tab-1', tab);

    // First apply custom viewport
    await host.setViewportSize({ width: 320, height: 568 });
    assert.ok(tab.customViewport);

    // Now switch to standard preset
    const presetSuccess = host.setDevicePreset('tab-1', 'desktop-laptop');
    assert.strictEqual(presetSuccess, true);
    assert.strictEqual(tab.customViewport, undefined, 'customViewport must be cleared on preset selection');
    assert.strictEqual(tab.state.devicePresetId, 'desktop-laptop');
  });

  it('rejects invalid viewport dimensions', async () => {
    const host = createTestHost();
    const tab = createTestTabRecord('tab-1');
    host.tabs.set('tab-1', tab);

    assert.strictEqual(await host.setViewportSize({ width: 0, height: 667 }), false);
    assert.strictEqual(await host.setViewportSize({ width: -100, height: -200 }), false);
  });
  it('applies device emulation to an explicit background tab without switching active tab', async () => {
    const host = createTestHost();
    const activeTab = createTestTabRecord('tab-active');
    const backgroundTab = createTestTabRecord('tab-bg');
    host.tabs.set('tab-active', activeTab);
    host.tabs.set('tab-bg', backgroundTab);
    host.activeTabId = 'tab-active';

    const success = await host.setViewportSize({ width: 375, height: 812, mobile: true, tabId: 'tab-bg' });
    assert.strictEqual(success, true);
    assert.strictEqual(host.activeTabId, 'tab-active', 'Active tab must not be altered');
    assert.deepStrictEqual(backgroundTab.customViewport, {
      width: 375,
      height: 812,
      mobile: true,
      deviceScaleFactor: 2,
    });
    assert.strictEqual(backgroundTab.state.devicePresetId, 'custom-375x812');
    assert.strictEqual(host.emulationCalls.length, 1);
    const emu = host.emulationCalls[0];
    assert.strictEqual(emu?.screenPosition, 'mobile');
    assert.deepStrictEqual(emu?.screenSize, { width: 375, height: 812 });
  });

  it('registers and dispatches browser.get-matched-styles by selector and ref', async () => {
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

    const receivedCalls: Array<{ selector?: string; ref?: string; tabId?: string }> = [];

    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-1' }],
      evalJs: async () => null,
      getMatchedStylesForNode: async (params) => {
        receivedCalls.push(params);
        return {
          matchedCSSRules: [
            {
              rule: {
                selectorList: { selectors: [{ text: params.selector || '.product-card' }] },
                style: { cssProperties: [{ name: 'margin-top', value: '24px' }] },
                styleSheetId: 'mock-stylesheet-1',
              },
            },
          ],
        };
      },
    };

    const port = new BrowserControlPort(mockHost);
    registerBrowserCapabilities(catalogue, port);

    assert.ok(catalogue.get('browser.get-matched-styles'));
    assert.ok(catalogue.get('anti.inspect.cdp_matched_styles'));

    const target: BrowserTarget = {
      tabId: 'tab-1',
      browserEpoch: 1,
      documentGeneration: 1,
      runtimeId: lease.runtimeId,
      projectId,
      workspaceId,
    };

    // Test 1: Query by selector
    const selectorRes = await catalogue.dispatch(
      'browser.get-matched-styles',
      { selector: '.product-card', tabId: 'tab-1' },
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    );

    assert.ok(isCdpMatchedStylesPayload(selectorRes));
    const firstRule = selectorRes.matchedCSSRules?.[0];
    assert.ok(firstRule);
    assert.deepStrictEqual(firstRule.rule.style.cssProperties[0], {
      name: 'margin-top',
      value: '24px',
    });
    assert.strictEqual(receivedCalls[0]?.selector, '.product-card');

    // Test 2: Query by ref
    const refRes = await catalogue.dispatch(
      'browser.get-matched-styles',
      { ref: '@e42', tabId: 'tab-1' },
      { lease, leaseToken: lease.token, projectId, workspaceId, browserTarget: target }
    );

    assert.ok(isCdpMatchedStylesPayload(refRes));
    assert.strictEqual(receivedCalls[1]?.ref, '@e42');
  });

  it('exercises TabDevToolsHost.getMatchedStylesForNode with descriptor and CDP command trace', async () => {
    const sentCdpCommands: Array<{ method: string; params: Record<string, unknown> }> = [];

    const host = Object.create(TabDevToolsHost.prototype) as {
      sendCdpCommand: (wc: unknown, method: string, params?: Record<string, unknown>) => Promise<unknown>;
      getOrCreateIsolatedWorldContext: (wc: unknown) => Promise<number | undefined>;
      getMatchedStylesForNode: typeof TabDevToolsHost.prototype.getMatchedStylesForNode;
      stylesheetUrls: Map<number, Map<string, string>>;
    };

    host.getOrCreateIsolatedWorldContext = async () => 1004;
    host.stylesheetUrls = new Map();

    host.sendCdpCommand = async (_wc, method, params = {}) => {
      sentCdpCommands.push({ method, params });
      if (method === 'DOM.enable' || method === 'CSS.enable') {
        return {};
      }
      if (method === 'Runtime.evaluate') {
        return {
          result: {
            objectId: 'remote-object-element-101',
            subtype: 'node',
          },
        };
      }
      if (method === 'DOM.requestNode') {
        assert.strictEqual(params.objectId, 'remote-object-element-101');
        return { nodeId: 42 };
      }
      if (method === 'CSS.getMatchedStylesForNode') {
        assert.strictEqual(params.nodeId, 42);
        return {
          matchedCSSRules: [
            {
              rule: {
                selectorList: { selectors: [{ text: '.product-card' }] },
                style: { cssProperties: [{ name: 'margin-top', value: '24px' }] },
                styleSheetId: 'mock-sheet-1',
              },
            },
          ],
        };
      }
      return {};
    };

    const mockWc = {
      isDestroyed: () => false,
    };

    const testDescriptor: SemanticElementDescriptor = {
      ref: '@e1',
      refIndex: 1,
      documentUrl: 'https://store.example.com',
      nonce: 'nonce-1',
      sequence: 1,
      label: 'Product Card',
      role: 'article',
      rect: { x: 0, y: 0, width: 300, height: 400, centerX: 150, centerY: 200 },
      fingerprint: { tag: 'div', classHint: 'product-card' },
      path: [
        { kind: 'dom', index: 0, tag: 'body' },
        { kind: 'dom', index: 1, tag: 'div' },
      ],
    };

    const result = await host.getMatchedStylesForNode(mockWc as unknown as Electron.WebContents, { descriptor: testDescriptor });

    assert.ok(isCdpMatchedStylesPayload(result));
    const firstRule = result.matchedCSSRules?.[0];
    assert.ok(firstRule);
    assert.strictEqual(firstRule.rule.style.cssProperties[0]?.name, 'margin-top');

    // Verify complete CDP command trace
    const methods = sentCdpCommands.map((c) => c.method);
    assert.deepStrictEqual(methods, [
      'DOM.enable',
      'CSS.enable',
      'Runtime.evaluate',
      'DOM.requestNode',
      'CSS.getMatchedStylesForNode',
    ]);

    // Verify that Runtime.evaluate ran in isolated context 1004 and inspected desc.path
    const evalCall = sentCdpCommands.find((c) => c.method === 'Runtime.evaluate');
    assert.strictEqual(evalCall?.params.contextId, 1004);
    assert.strictEqual(evalCall?.params.returnByValue, false);
    assert.ok(typeof evalCall?.params.expression === 'string' && evalCall.params.expression.includes('resolveTraversalPath(desc.path)'));
  });
});
