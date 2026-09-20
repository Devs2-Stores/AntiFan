import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { CapabilityCatalogue } from '../../src/main/tools/capability-catalogue';
import { registerBrowserCapabilities } from '../../src/main/tools/browser-capabilities';
import { BrowserControlPort, BrowserHostPort } from '../../src/main/tools/browser-control-port';
import { CapabilityError, issueRuntimeLease, makeControlPlaneId, BrowserTarget } from '../../src/shared/control-plane-contracts';
import { NativeTabHost, NativeTabRecord } from '../../src/main/browser/native-tab-host';
import { DEVICE_PRESETS } from '../../src/main/browser/device-presets';
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

interface TestWindowShape {
  isDestroyed: () => boolean;
  getContentBounds: () => { x: number; y: number; width: number; height: number };
}

// Deliberately not the 1440x900 the background viewport path used to invent, so a box
// derived from this window can never be mistaken for the fabricated default.
const WINDOW_CONTENT_BOX = { x: 0, y: 0, width: 1280, height: 800 };

interface TestHostShape {
  tabs: Map<string, NativeTabRecord>;
  activeTabId: string;
  defaultUserAgent: string;
  window?: TestWindowShape;
  emulationCalls: EmulationParams[];
  disabledEmulationCount: number;
  updateLayoutCallCount: number;
  updateLayout: () => void;
  getToolbarHeight: () => number;
  applyTabDeviceEmulation: (tab: NativeTabRecord, availableWidth: number, availableHeight: number, toolbarHeight: number) => void;
  safeEnableDeviceEmulation: (wc: unknown, params: EmulationParams) => void;
  safeDisableDeviceEmulation: (wc: unknown) => void;
  setSafeUserAgent: (wc: unknown, ua: string) => void;
  touchEmulationPromise: Promise<void>;
  applyCdpTouchEmulation: (wc: unknown, enabled: boolean) => Promise<void>;
  applyDeviceCornerClipping: (wc: unknown, radius: number) => void;
  setViewportSize: (options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string; reload?: boolean }) => Promise<boolean>;
  setDevicePreset: (tabId: string, presetId: string) => boolean;
  broadcastCount: number;
  broadcastState: () => void;
}

function createTestTabRecord(id: string): NativeTabRecord & { backgroundColors: string[] } {
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

  const backgroundColors: string[] = [];

  const mockView = {
    webContents: mockWebContents,
    setBounds: (_rect: { x: number; y: number; width: number; height: number }) => {},
    setBackgroundColor: (color: string) => {
      backgroundColors.push(color);
    },
  };

  return {
    view: mockView as unknown as NativeTabRecord['view'],
    backgroundColors,
    state,
  };
}

function createTestHost(): TestHostShape {
  const host = Object.create(NativeTabHost.prototype) as TestHostShape;
  host.tabs = new Map<string, NativeTabRecord>();
  host.activeTabId = 'tab-1';
  host.defaultUserAgent = 'MockDesktopUA';
  // A window the host can measure, without a contentView: these cases exercise the
  // emulation path, so an attach-and-lay-out pass (owned by the capture describe) must
  // not run behind them.
  host.window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ ...WINDOW_CONTENT_BOX }),
  };
  host.emulationCalls = [];
  host.disabledEmulationCount = 0;
  host.updateLayoutCallCount = 0;
  host.broadcastCount = 0;
  // Real NativeTabHost.broadcastState needs toolbarView/tabOrder/persistence;
  // the fake host stubs the notification channel and counts invocations so the
  // tests can assert the Issue A contract (MCP resize must announce itself).
  host.broadcastState = () => {
    host.broadcastCount++;
  };

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
    assert.strictEqual(host.broadcastCount, 1, 'MCP viewport change must broadcast so the toolbar Device cluster re-renders');

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
    // One broadcast from the custom viewport set + one from the preset switch.
    assert.strictEqual(host.broadcastCount, 2, 'Device preset switches must broadcast so the toolbar stays truthful');
  });

  it('rejects invalid viewport dimensions', async () => {
    const host = createTestHost();
    const tab = createTestTabRecord('tab-1');
    host.tabs.set('tab-1', tab);

    assert.strictEqual(await host.setViewportSize({ width: 0, height: 667 }), false);
    assert.strictEqual(await host.setViewportSize({ width: -100, height: -200 }), false);
    assert.strictEqual(host.broadcastCount, 0, 'Rejected dimensions must not announce a state change');
  });

  it('keeps the tab view background opaque white for every device preset', () => {
    const host = createTestHost();
    const tab = createTestTabRecord('tab-1');
    host.tabs.set('tab-1', tab);

    // Rounded presets used to clear the view (`#00000000`) so a device chassis
    // could show through the corners. That punch-through is gone: clipping only
    // removes leftover document CSS, and single-tab mode hides the chassis.
    // A transparent view then shows frameBackdropView `#060910` through any
    // page that leaves html/body unpainted. Guest canvas must stay UA white.
    host.setDevicePreset('tab-1', 'phone-iphone16promax');
    assert.strictEqual(tab.backgroundColors[tab.backgroundColors.length - 1], '#ffffff', 'A rounded preset must keep the opaque UA canvas');
    host.setDevicePreset('tab-1', 'laptop-macbook13');
    assert.strictEqual(tab.backgroundColors[tab.backgroundColors.length - 1], '#ffffff', 'A flat preset following a rounded one must keep the opaque view background');
    host.setDevicePreset('tab-1', 'xiaomi-14');
    assert.strictEqual(tab.backgroundColors[tab.backgroundColors.length - 1], '#ffffff', 'xiaomi-14 (the reported leak preset) must keep the opaque UA canvas');

    for (const preset of DEVICE_PRESETS) {
      host.setDevicePreset('tab-1', preset.id);
      assert.strictEqual(tab.backgroundColors[tab.backgroundColors.length - 1], '#ffffff', `Preset ${preset.id} left the guest canvas transparent`);
    }
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
    assert.strictEqual(host.broadcastCount, 1, 'Background-tab viewport changes must broadcast too');
  });
  it('BrowserControlPort.setViewport delegates reload to host.setViewportSize without calling host.reloadAndWait twice', async () => {
    let reloadAndWaitCalls = 0;
    let reloadCalls = 0;
    let setViewportCalls = 0;
    let capturedOptions: unknown = null;
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => { reloadCalls++; return true; },
      reloadAndWait: async () => { reloadAndWaitCalls++; return true; },
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-1' }],
      evalJs: async () => ({ innerWidth: 390, innerHeight: 844 }),
      setViewportSize: async (opts) => {
        setViewportCalls++;
        capturedOptions = opts;
        return true;
      },
    };
    const port = new BrowserControlPort(mockHost);
    const res = await port.setViewport({ width: 390, height: 844, reload: true, tabId: 'tab-1' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reloaded, true);
    assert.strictEqual(setViewportCalls, 1);
    assert.strictEqual((capturedOptions as any)?.reload, true);
    assert.strictEqual(reloadAndWaitCalls, 0, 'Must NOT trigger secondary redundant host.reloadAndWait');
    assert.strictEqual(reloadCalls, 0, 'Must NOT trigger secondary redundant host.reload');
  });

  it('BrowserControlPort.setViewport rejects when structured host reports reloaded: false', async () => {
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-1' }],
      evalJs: async () => ({ innerWidth: 390, innerHeight: 844 }),
      setViewportSize: async () => ({ success: true, reloaded: false }),
    };
    const port = new BrowserControlPort(mockHost);
    await assert.rejects(
      () => port.setViewport({ width: 390, height: 844, reload: true, tabId: 'tab-1' }),
      /Failed to reload tab tab-1 after viewport resize/
    );
  });

  it('BrowserControlPort.setViewport rejects when structured host omits reloaded on reload: true', async () => {
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-1' }],
      evalJs: async () => ({ innerWidth: 390, innerHeight: 844 }),
      setViewportSize: async () => ({ success: true }), // reloaded omitted!
    };
    const port = new BrowserControlPort(mockHost);
    await assert.rejects(
      () => port.setViewport({ width: 390, height: 844, reload: true, tabId: 'tab-1' }),
      /Failed to reload tab tab-1 after viewport resize/
    );
  });

  it('BrowserControlPort.setViewport accepts when structured host reports reloaded: true', async () => {
    const mockHost: BrowserHostPort = {
      navigate: () => true,
      reload: () => true,
      getDom: async () => '<html></html>',
      captureScreenshot: async () => 'data:image/png;base64,mock',
      getTabList: () => [{ id: 'tab-1' }],
      evalJs: async () => ({ innerWidth: 390, innerHeight: 844 }),
      setViewportSize: async () => ({ success: true, reloaded: true }),
    };
    const port = new BrowserControlPort(mockHost);
    const res = await port.setViewport({ width: 390, height: 844, reload: true, tabId: 'tab-1' });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.reloaded, true);
  });

  it('rejects failed viewport reloads as stale targets and propagates reload exceptions', async () => {
    const host = createTestHost();
    const tab = createTestTabRecord('tab-1');
    host.tabs.set('tab-1', tab);

    let reloadAttempts = 0;
    (host as any).reloadAndWait = async () => {
      reloadAttempts++;
      return false;
    };

    await assert.rejects(
      () => host.setViewportSize({ width: 390, height: 844, reload: true, tabId: 'tab-1' }),
      (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TARGET_STALE'
    );
    assert.strictEqual(reloadAttempts, 1, 'Must make exactly 1 reload attempt');

    // Now test that exceptions from reloadAndWait propagate without being swallowed
    let throwingAttempts = 0;
    (host as any).reloadAndWait = async () => {
      throwingAttempts++;
      throw new Error('CDP target detached during reloadAndWait');
    };

    await assert.rejects(
      () => host.setViewportSize({ width: 390, height: 844, reload: true, tabId: 'tab-1' }),
      /CDP target detached during reloadAndWait/
    );
    assert.strictEqual(throwingAttempts, 1, 'Must make exactly 1 reload attempt on throw');
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
      resolveTabId: (id) => (id === 'tab-1' ? 'tab-1' : undefined),
      isTabAllowed: () => true,
      getDocumentGeneration: () => 1,
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

  it('refuses a background viewport when the window cannot name a content box, and applies it when the window can', async () => {
    const host = createTestHost();
    host.activeTabId = 'tab-1';
    const backgroundTab = createTestTabRecord('tab-bg');
    host.tabs.set('tab-bg', backgroundTab);

    const TOOLBAR_HEIGHT = 68;
    host.getToolbarHeight = () => TOOLBAR_HEIGHT;

    // A refused request must leave no geometry behind, so the view records every box it is
    // given and the emulation records the box it is handed.
    const appliedBounds: Array<{ x: number; y: number; width: number; height: number }> = [];
    backgroundTab.view = {
      webContents: {
        isDestroyed: () => false,
        setZoomFactor: (_factor: number) => {},
        insertCSS: async (_css: string) => '',
      },
      setBounds: (rect: { x: number; y: number; width: number; height: number }) => {
        appliedBounds.push({ ...rect });
      },
      setBackgroundColor: (_color: string) => {},
    } as unknown as NativeTabRecord['view'];

    const emulationBoxes: Array<{ width: number; height: number; toolbarHeight: number }> = [];
    // applyTabDeviceEmulation is private, so the prototype is reached through a named
    // alias: the box it is handed is the only place the fabricated default ever showed.
    const prototypeWithEmulation = NativeTabHost.prototype as unknown as {
      applyTabDeviceEmulation: (tab: NativeTabRecord, availableWidth: number, availableHeight: number, toolbarHeight: number) => void;
    };
    host.applyTabDeviceEmulation = (tabRecord, availableWidth, availableHeight, toolbarHeight) => {
      emulationBoxes.push({ width: availableWidth, height: availableHeight, toolbarHeight });
      prototypeWithEmulation.applyTabDeviceEmulation.call(host, tabRecord, availableWidth, availableHeight, toolbarHeight);
    };

    const unusableWindows: Array<{ label: string; window: TestWindowShape | undefined }> = [
      { label: 'no window at all', window: undefined },
      { label: 'destroyed window', window: { isDestroyed: () => true, getContentBounds: () => ({ ...WINDOW_CONTENT_BOX }) } },
      { label: 'minimized window reporting 0x0', window: { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: 0, height: 0 }) } },
      { label: 'window shorter than its toolbar', window: { isDestroyed: () => false, getContentBounds: () => ({ x: 0, y: 0, width: WINDOW_CONTENT_BOX.width, height: TOOLBAR_HEIGHT - 10 }) } },
    ];

    for (const unusable of unusableWindows) {
      host.window = unusable.window;
      await assert.rejects(
        () => host.setViewportSize({ width: 390, height: 844, tabId: 'tab-bg' }),
        (error: unknown) => {
          assert.ok(error instanceof CapabilityError, `${unusable.label}: the refusal must be typed`);
          assert.strictEqual(error.code, 'VIEWPORT_NOT_APPLIED', `${unusable.label}: the requested viewport was not applied`);
          assert.deepStrictEqual(error.details, {
            tabId: 'tab-bg',
            expectedWidth: 390,
            expectedHeight: 844,
            operation: 'setViewport',
            cause: 'window-unmeasurable',
          });
          return true;
        }
      );
    }
    assert.deepStrictEqual(emulationBoxes, [], 'No emulation may be laid out against a box the window never named');
    assert.deepStrictEqual(appliedBounds, [], 'A refused viewport must leave no geometry behind');
    assert.strictEqual(host.broadcastCount, 0, 'A refused viewport must not be announced as applied');

    // The same call with a window that can name its box applies the requested viewport,
    // laid out in that measured box instead of the 1440x900 default.
    host.window = { isDestroyed: () => false, getContentBounds: () => ({ ...WINDOW_CONTENT_BOX }) };
    assert.strictEqual(await host.setViewportSize({ width: 411, height: 866, mobile: true, tabId: 'tab-bg' }), true);
    assert.deepStrictEqual(
      emulationBoxes,
      [{ width: WINDOW_CONTENT_BOX.width, height: WINDOW_CONTENT_BOX.height - TOOLBAR_HEIGHT, toolbarHeight: TOOLBAR_HEIGHT }],
      'The emulation box must be the box the window actually gives the tab'
    );
    assert.deepStrictEqual(backgroundTab.customViewport, { width: 411, height: 866, mobile: true, deviceScaleFactor: 2 });
    assert.deepStrictEqual(host.emulationCalls[0]?.screenSize, { width: 411, height: 866 }, 'The requested viewport is what the tab emulates');
    assert.deepStrictEqual(
      appliedBounds,
      [{ x: Math.floor((WINDOW_CONTENT_BOX.width - 411) / 2), y: TOOLBAR_HEIGHT, width: 411, height: 866 }],
      'A background tab renders exactly at the requested viewport, inside the measured box'
    );
    assert.strictEqual(host.broadcastCount, 1, 'An applied background viewport must broadcast');
  });
});

describe('Render-surface probe geometry', () => {
  // One tab, one reading: window 1440x900 with a 15px classic scrollbar, so the layout
  // content box is 1425 while the capture raster covers the full 1440 CSS viewport.
  const rasterAlignedRendererReading = {
    vw: 1440,
    vh: 900,
    layoutWidth: 1425,
    layoutHeight: 900,
    windowWidth: 1440,
    windowHeight: 900,
    dpr: 1,
    scrollX: 0,
    scrollY: 0,
    docH: 5422,
    readyState: 'complete',
    hidden: false,
  };

  const makeProbeHost = (
    rendererValue: Record<string, unknown>,
    options: { activeTabId?: string; view?: unknown; mobileView?: unknown; runWithAttachedTabView?: unknown; offscreen?: boolean } = {}
  ): { host: any; methods: string[]; attachCalls: Array<{ view: unknown; isMobile?: boolean }> } => {
    const methods: string[] = [];
    const attachCalls: Array<{ view: unknown; isMobile?: boolean }> = [];
    const host = Object.create(TabDevToolsHost.prototype) as any;
    host.ctx = {
      getActiveTabId: () => options.activeTabId ?? 'tab-emulated',
      getTabRecord: (id: string) =>
        id === 'tab-emulated'
          ? {
              id,
              focusedPane: 'desktop',
              view: options.view ?? { id: 'view-emulated' },
              mobileView: options.mobileView,
              state: { id, offscreen: options.offscreen === true },
            }
          : undefined,
      getTabWebContents: () => ({ isDestroyed: () => false }),
      ...(options.runWithAttachedTabView !== undefined ? { runWithAttachedTabView: options.runWithAttachedTabView } : {}),
    };
    host.sendCdpCommand = async (_wc: unknown, method: string) => {
      methods.push(method);
      return { result: { value: rendererValue } };
    };
    host.ctx.runWithAttachedTabView =
      options.runWithAttachedTabView ??
      (async (view: unknown, action: () => Promise<unknown>, isMobile?: boolean) => {
        attachCalls.push({ view, isMobile });
        return await action();
      });
    return { host, methods, attachCalls };
  };

  it('reports the viewport a capture rasterizes, with the scrollbar-excluded box as a diagnostic', async () => {
    const { host, methods } = makeProbeHost(rasterAlignedRendererReading);

    const surface = await host.readRenderSurface('tab-emulated');

    assert.strictEqual(surface.vw, 1440, 'The full CSS viewport is what the raster covers');
    assert.strictEqual(surface.vh, 900);
    assert.strictEqual(surface.layoutWidth, 1425, 'The content box stays available as a diagnostic');
    assert.strictEqual(surface.layoutHeight, 900);
    assert.strictEqual(surface.docH, 5422, 'Document height still comes from the renderer');
    assert.strictEqual(surface.readyState, 'complete');
    assert.deepStrictEqual(methods, ['Runtime.evaluate'], 'The probe reads the tab it is measuring, nothing else');
  });

  it('reports no viewport for a document that is not laid out instead of promoting its widget box', async () => {
    const { host, attachCalls } = makeProbeHost({ ...rasterAlignedRendererReading, vw: 0, vh: 0, layoutWidth: 0, layoutHeight: 0 });

    const surface = await host.readRenderSurface('tab-emulated');

    assert.strictEqual(surface.vw, 0, 'A view with no compositor surface must not report a viewport');
    assert.strictEqual(surface.vh, 0);
    assert.strictEqual(attachCalls.length, 0, 'The active target is read where it is, without an extra attach');
  });

  it('measures a background target inside a temporary in-place attach of its own view', async () => {
    const backgroundView = { id: 'view-background' };
    const { host, attachCalls } = makeProbeHost(rasterAlignedRendererReading, {
      activeTabId: 'tab-active',
      view: backgroundView,
    });

    const surface = await host.readRenderSurface('tab-emulated');

    assert.strictEqual(surface.vw, 1440);
    assert.strictEqual(attachCalls.length, 1);
    assert.strictEqual(attachCalls[0]?.view, backgroundView);
    assert.strictEqual(attachCalls[0]?.isMobile, false);
  });

  it('measures an offscreen target where it renders, without attaching it', async () => {
    const { host, attachCalls } = makeProbeHost(rasterAlignedRendererReading, {
      activeTabId: 'tab-active',
      offscreen: true,
    });

    const surface = await host.readRenderSurface('tab-emulated');

    assert.strictEqual(surface.vw, 1440);
    assert.strictEqual(attachCalls.length, 0, 'An offscreen tab renders offscreen and must not enter the view tree');
  });
});

describe('Attach-for-capture pane layout', () => {
  interface PaneBounds {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface RecordingPaneView {
    webContents: {
      isDestroyed: () => boolean;
      setZoomFactor: (factor: number) => void;
    };
    setBounds: (rect: PaneBounds) => void;
    getBounds: () => PaneBounds;
    setBackgroundColor: (color: string) => void;
  }

  interface AttachHostShape {
    tabs: Map<string, NativeTabRecord>;
    activeTabId: string;
    defaultUserAgent: string;
    isSidebarOpen: boolean;
    sidebarWidth: number;
    tabByWebContents: WeakMap<object, { tabId: string; tab: NativeTabRecord }>;
    window: {
      isDestroyed: () => boolean;
      getContentBounds: () => PaneBounds;
      contentView: {
        children: unknown[];
        addChildView: (view: unknown, index?: number) => void;
        removeChildView: (view: unknown) => void;
      };
    };
    getToolbarHeight: () => number;
    applyDeviceCornerClipping: (wc: unknown, radius: number) => void;
    applyCdpTouchEmulation: (wc: unknown, enabled: boolean) => Promise<void>;
    safeDisableDeviceEmulation: (wc: unknown, view?: unknown) => void;
    setSafeUserAgent: (wc: unknown, ua: string) => void;
    runWithAttachedTabView: <T>(view: unknown, action: () => Promise<T>, isMobile?: boolean) => Promise<T>;
    isTabViewAttached: (view: unknown) => boolean;
  }

  // Deliberately not the 1200x800 the capture path used to invent, so a pane box
  // derived from the real window can never be mistaken for the fabricated one.
  const WINDOW_BOUNDS: PaneBounds = { x: 0, y: 0, width: 1366, height: 768 };
  const TOOLBAR_HEIGHT = 90;
  const SIDEBAR_WIDTH = 380;

  function createRecordingPaneView(initialBounds: PaneBounds): {
    view: RecordingPaneView;
    setBoundsCalls: PaneBounds[];
    currentBounds: () => PaneBounds;
  } {
    const state = { bounds: { ...initialBounds } };
    const setBoundsCalls: PaneBounds[] = [];
    const view: RecordingPaneView = {
      webContents: {
        isDestroyed: () => false,
        setZoomFactor: (_factor: number) => {},
      },
      setBounds: (rect: PaneBounds) => {
        setBoundsCalls.push({ ...rect });
        state.bounds = { ...rect };
      },
      getBounds: () => ({ ...state.bounds }),
      setBackgroundColor: (_color: string) => {},
    };
    return { view, setBoundsCalls, currentBounds: () => view.getBounds() };
  }

  function createAttachHost(params: {
    tab: NativeTabRecord;
    view: RecordingPaneView;
    preAttached: boolean;
    sidebarOpen: boolean;
  }): AttachHostShape {
    const host = Object.create(NativeTabHost.prototype) as AttachHostShape;
    const children: unknown[] = params.preAttached ? [params.view] : [];
    host.tabs = new Map([[params.tab.state.id, params.tab]]);
    // Only the tab the user is looking at keeps its view in the window, so the
    // pre-attached case is the visible tab and the capture target is background.
    host.activeTabId = params.preAttached ? params.tab.state.id : 'tab-other';
    host.defaultUserAgent = 'MockDesktopUA';
    host.isSidebarOpen = params.sidebarOpen;
    host.sidebarWidth = SIDEBAR_WIDTH;
    host.tabByWebContents = new WeakMap<object, { tabId: string; tab: NativeTabRecord }>([
      [params.view.webContents, { tabId: params.tab.state.id, tab: params.tab }],
    ]);
    host.window = {
      isDestroyed: () => false,
      getContentBounds: () => ({ ...WINDOW_BOUNDS }),
      contentView: {
        children,
        addChildView: (view: unknown, index?: number) => {
          children.splice(typeof index === 'number' ? index : children.length, 0, view);
        },
        removeChildView: (view: unknown) => {
          const at = children.indexOf(view);
          if (at >= 0) children.splice(at, 1);
        },
      },
    };
    host.getToolbarHeight = () => TOOLBAR_HEIGHT;
    host.applyDeviceCornerClipping = (_wc: unknown, _radius: number) => {};
    host.applyCdpTouchEmulation = (_wc: unknown, _enabled: boolean) => Promise.resolve();
    host.safeDisableDeviceEmulation = (_wc: unknown, _view?: unknown) => {};
    host.setSafeUserAgent = (_wc: unknown, _ua: string) => {};
    return host;
  }

  it('lays a helper-attached pane out with the window geometry and leaves an already-presented view untouched', async () => {
    const layoutCases = [
      { label: 'sidebar closed', sidebarOpen: false, paneWidth: WINDOW_BOUNDS.width },
      { label: 'sidebar open', sidebarOpen: true, paneWidth: WINDOW_BOUNDS.width - SIDEBAR_WIDTH },
    ];

    for (const layoutCase of layoutCases) {
      const tab = createTestTabRecord('tab-bg');
      // A view that was never presented has no size at all — the case the helper exists for.
      const pane = createRecordingPaneView({ x: 0, y: 0, width: 0, height: 0 });
      tab.view = pane.view as unknown as NativeTabRecord['view'];
      const host = createAttachHost({ tab, view: pane.view, preAttached: false, sidebarOpen: layoutCase.sidebarOpen });
      const expectedBox: PaneBounds = {
        x: 0,
        y: TOOLBAR_HEIGHT,
        width: layoutCase.paneWidth,
        height: WINDOW_BOUNDS.height - TOOLBAR_HEIGHT,
      };

      let attachedDuringAction = false;
      let boundsDuringAction: PaneBounds | undefined;
      const result = await host.runWithAttachedTabView(pane.view, async () => {
        attachedDuringAction = host.isTabViewAttached(pane.view);
        boundsDuringAction = pane.currentBounds();
        return 'ok';
      });

      assert.strictEqual(result, 'ok');
      assert.strictEqual(attachedDuringAction, true, `${layoutCase.label}: the action must run with the pane on screen`);
      assert.deepStrictEqual(boundsDuringAction, expectedBox, `${layoutCase.label}: the pane must be measurable before the action runs`);
      assert.deepStrictEqual(pane.setBoundsCalls, [expectedBox], `${layoutCase.label}: the pane box must be the window's own geometry`);
    }

    // The visible tab's own view is already presenting; a capture of it must not relayout it.
    const presentedTab = createTestTabRecord('tab-visible');
    const presentedBox: PaneBounds = {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: WINDOW_BOUNDS.width - SIDEBAR_WIDTH,
      height: WINDOW_BOUNDS.height - TOOLBAR_HEIGHT,
    };
    const presentedPane = createRecordingPaneView(presentedBox);
    presentedTab.view = presentedPane.view as unknown as NativeTabRecord['view'];
    const attachedHost = createAttachHost({ tab: presentedTab, view: presentedPane.view, preAttached: true, sidebarOpen: true });
    const childrenBefore = [...attachedHost.window.contentView.children];

    const attachedResult = await attachedHost.runWithAttachedTabView(presentedPane.view, async () => 'ok');

    assert.strictEqual(attachedResult, 'ok');
    assert.deepStrictEqual(presentedPane.setBoundsCalls, [], 'An already-presented view must not be laid out again');
    assert.deepStrictEqual(presentedPane.currentBounds(), presentedBox, 'The presented box must survive the capture unchanged');
    assert.deepStrictEqual(attachedHost.window.contentView.children, childrenBefore, 'A view the helper did not attach must not be detached either');
  });
});

describe('Responsive sweep surface', () => {
  interface BreakpointReading {
    name: string;
    width: number;
    height: number;
    mobile: boolean;
    clientWidth?: number;
    scrollWidth?: number;
    documentOverflowX?: boolean;
    hasHorizontalOverflow?: boolean;
  }

  interface EmulatedBox {
    width: number;
    height: number;
  }

  interface EmulationCall {
    width: number;
    height: number;
    attached: boolean;
  }

  interface SweepWebContents {
    isDestroyed: () => boolean;
    setZoomFactor: (factor: number) => void;
    insertCSS: (css: string) => Promise<string>;
    invalidate: () => void;
    enableDeviceEmulation: (params: EmulationParams) => void;
    disableDeviceEmulation: () => void;
    executeJavaScript: (script: string) => Promise<Record<string, unknown>>;
  }

  interface SweepView {
    webContents: SweepWebContents;
    setBounds: (rect: { x: number; y: number; width: number; height: number }) => void;
    setBackgroundColor: (color: string) => void;
  }

  interface SweepWindow {
    isDestroyed: () => boolean;
    getContentBounds: () => { x: number; y: number; width: number; height: number };
    contentView: {
      children: unknown[];
      addChildView: (view: unknown, index?: number) => void;
      removeChildView: (view: unknown) => void;
    };
  }

  interface SweepHost {
    tabs: Map<string, NativeTabRecord>;
    activeTabId: string;
    defaultUserAgent: string;
    emulatedWebContents: WeakSet<Electron.WebContents>;
    isSidebarOpen: boolean;
    sidebarWidth: number;
    window: SweepWindow;
    tabByWebContents: WeakMap<object, { tabId: string; tab: NativeTabRecord }>;
    getToolbarHeight: () => number;
    applyDeviceCornerClipping: (wc: unknown, radius: number) => void;
    applyCdpTouchEmulation: (wc: unknown, enabled: boolean) => Promise<void>;
    setSafeUserAgent: (wc: unknown, ua: string) => void;
    updateLayout: () => void;
    runResponsiveCheck: (params?: { tabId?: string; selector?: string }) => Promise<Record<string, unknown>>;
  }

  interface SweepHarness {
    host: SweepHost;
    view: SweepView;
    activeView: SweepView;
    emulationCalls: EmulationCall[];
    attachedDuringReadings: boolean[];
    children: () => unknown[];
    childrenDuringFirstReading: () => unknown[];
    liveEmulation: () => EmulatedBox | null;
    disableCount: () => number;
    updateLayoutCount: () => number;
  }

  // Deliberately not the 1440x900 the background viewport path once invented, so a box
  // derived from this window can never be mistaken for a fabricated default.
  const WINDOW_BOX = { x: 0, y: 0, width: 1280, height: 800 };
  const TOOLBAR_HEIGHT = 68;
  // A page a little wider than the narrowest breakpoint: it overflows 320 and fits every
  // viewport above it. A reading taken against a detached zero-width box reports overflow
  // at all five, so this page is what tells a real measurement from a refused one.
  const PAGE_CONTENT_WIDTH = 330;
  const BREAKPOINT_IDS = ['mobile-small', 'mobile-standard', 'tablet-portrait', 'tablet-landscape', 'desktop-laptop'];
  const BREAKPOINT_WIDTHS = [320, 375, 768, 1024, 1440];

  function createSweepHarness(): SweepHarness {
    const children: unknown[] = [];
    const emulationCalls: EmulationCall[] = [];
    const attachedDuringReadings: boolean[] = [];
    let liveEmulation: EmulatedBox | null = null;
    let disableCount = 0;
    let updateLayoutCount = 0;
    let childrenDuringFirstReading: unknown[] = [];

    // The reading is the document's own answer, so the stub computes it the way the page
    // script does: against whatever emulation the tab actually carries at that moment.
    const view: SweepView = {
      webContents: {
        isDestroyed: () => false,
        setZoomFactor: (_factor: number) => {},
        insertCSS: async (_css: string) => '',
        invalidate: () => {},
        enableDeviceEmulation: (params: EmulationParams) => {
          const box = params.viewSize ? { width: params.viewSize.width, height: params.viewSize.height } : null;
          liveEmulation = box;
          emulationCalls.push({ width: box ? box.width : 0, height: box ? box.height : 0, attached: children.includes(view) });
        },
        disableDeviceEmulation: () => {
          disableCount += 1;
          liveEmulation = null;
        },
        executeJavaScript: async (_script: string) => {
          const clientWidth = liveEmulation ? liveEmulation.width : 0;
          const clientHeight = liveEmulation ? liveEmulation.height : 0;
          const scrollWidth = Math.max(PAGE_CONTENT_WIDTH, clientWidth);
          const documentOverflowX = scrollWidth > clientWidth + 1;
          attachedDuringReadings.push(children.includes(view));
          if (attachedDuringReadings.length === 1) {
            childrenDuringFirstReading = [...children];
          }
          return {
            scrollWidth,
            clientWidth,
            scrollHeight: clientHeight,
            clientHeight,
            documentOverflowX,
            hasHorizontalOverflow: documentOverflowX,
            targetOverflowX: false,
            target: null,
            hasViewportMeta: false,
            viewportContent: null,
          };
        },
      },
      setBounds: (_rect: { x: number; y: number; width: number; height: number }) => {},
      setBackgroundColor: (_color: string) => {},
    };

    const activeView: SweepView = {
      webContents: {
        isDestroyed: () => false,
        setZoomFactor: (_factor: number) => {},
        insertCSS: async (_css: string) => '',
        invalidate: () => {},
        enableDeviceEmulation: (_params: EmulationParams) => {},
        disableDeviceEmulation: () => {},
        executeJavaScript: async (_script: string) => ({}),
      },
      setBounds: (_rect: { x: number; y: number; width: number; height: number }) => {},
      setBackgroundColor: (_color: string) => {},
    };

    // Only the tab the user is looking at keeps its view in the window; the sweep target
    // is a background tab and starts outside it.
    children.push(activeView);

    const host = Object.create(NativeTabHost.prototype) as unknown as SweepHost;
    host.tabs = new Map<string, NativeTabRecord>();
    host.activeTabId = 'tab-active';
    host.defaultUserAgent = 'MockDesktopUA';
    // The real emulation guards read this bookkeeping, so the harness keeps it real: the
    // sweep's emulation only lands if the tab's view genuinely has a surface.
    host.emulatedWebContents = new WeakSet<Electron.WebContents>();
    host.isSidebarOpen = false;
    host.sidebarWidth = 0;
    host.window = {
      isDestroyed: () => false,
      getContentBounds: () => ({ ...WINDOW_BOX }),
      contentView: {
        children,
        addChildView: (child: unknown, index?: number) => {
          children.splice(typeof index === 'number' ? index : children.length, 0, child);
        },
        removeChildView: (child: unknown) => {
          const at = children.indexOf(child);
          if (at >= 0) children.splice(at, 1);
        },
      },
    };
    host.tabByWebContents = new WeakMap<object, { tabId: string; tab: NativeTabRecord }>();
    host.getToolbarHeight = () => TOOLBAR_HEIGHT;
    host.applyDeviceCornerClipping = (_wc: unknown, _radius: number) => {};
    host.applyCdpTouchEmulation = (_wc: unknown, _enabled: boolean) => Promise.resolve();
    host.setSafeUserAgent = (_wc: unknown, _ua: string) => {};
    host.updateLayout = () => {
      updateLayoutCount += 1;
    };

    return {
      host,
      view,
      activeView,
      emulationCalls,
      attachedDuringReadings,
      children: () => children,
      childrenDuringFirstReading: () => childrenDuringFirstReading,
      liveEmulation: () => liveEmulation,
      disableCount: () => disableCount,
      updateLayoutCount: () => updateLayoutCount,
    };
  }

  it('measures every breakpoint of a background tab against the emulated width instead of a detached zero-width box', async () => {
    const harness = createSweepHarness();
    const host = harness.host;
    const backgroundTab = createTestTabRecord('tab-bg');
    backgroundTab.view = harness.view as unknown as NativeTabRecord['view'];
    const activeTab = createTestTabRecord('tab-active');
    activeTab.view = harness.activeView as unknown as NativeTabRecord['view'];
    host.tabs.set('tab-active', activeTab);
    host.tabs.set('tab-bg', backgroundTab);
    host.tabByWebContents.set(harness.view.webContents, { tabId: 'tab-bg', tab: backgroundTab });

    const payload = await host.runResponsiveCheck({ tabId: 'tab-bg' });
    const readings = payload.breakpoints as Record<string, BreakpointReading>;

    assert.strictEqual(payload.ok, true);
    assert.deepStrictEqual(
      harness.emulationCalls.map((call) => call.width),
      BREAKPOINT_WIDTHS,
      'Every standard breakpoint must be emulated, in order'
    );
    assert.deepStrictEqual(
      harness.emulationCalls.map((call) => call.attached),
      [true, true, true, true, true],
      'An emulation applied to a view with no surface measures nothing but the refusal'
    );

    for (let index = 0; index < BREAKPOINT_IDS.length; index += 1) {
      const id = BREAKPOINT_IDS[index]!;
      const width = BREAKPOINT_WIDTHS[index]!;
      const reading = readings[id];
      assert.ok(reading, `${id} must report a reading`);
      assert.strictEqual(reading.clientWidth, width, `${id}: the document must lay out at the emulated width`);
      assert.strictEqual(
        reading.scrollWidth,
        Math.max(PAGE_CONTENT_WIDTH, width),
        `${id}: the document must be measured against the emulated viewport`
      );
      assert.strictEqual(reading.width, width, `${id}: the reported breakpoint is the one that was probed`);
    }

    // The page overflows the narrowest breakpoint alone; a detached zero-width box would
    // report this document as overflowing all five.
    assert.strictEqual(readings['mobile-small']?.hasHorizontalOverflow, true, 'A page wider than 320px must overflow it');
    for (const id of BREAKPOINT_IDS.slice(1)) {
      assert.strictEqual(readings[id]?.hasHorizontalOverflow, false, `${id}: a page that fits must not be reported as overflowing`);
    }
    assert.strictEqual(readings['mobile-small']?.documentOverflowX, true, 'documentOverflowX stays the document-level signal it always was');

    // The sweep borrows the window for a real surface, never for the user's attention.
    assert.deepStrictEqual(harness.attachedDuringReadings, [true, true, true, true, true], 'Every reading must be taken with the tab view on screen');
    assert.strictEqual(host.activeTabId, 'tab-active', 'The sweep must not activate the background tab');
    const childrenDuringReading = harness.childrenDuringFirstReading();
    const sweepIndex = childrenDuringReading.indexOf(harness.view);
    const activeIndex = childrenDuringReading.indexOf(harness.activeView);
    assert.ok(sweepIndex >= 0 && activeIndex > sweepIndex, 'The temporary attach must sit behind the visible tab, not in its place');
    assert.deepStrictEqual(harness.children(), [harness.activeView], 'The window keeps the visible tab once the sweep returns');

    // The tab's own state comes back: the emulation is undone where it landed, and the
    // prior layout is restored through the path the visible-tab case always used.
    assert.strictEqual(harness.liveEmulation(), null, 'No breakpoint emulation may survive the sweep');
    assert.strictEqual(harness.disableCount(), 1, 'Undoing the emulation must reach the tab instead of being refused by a detached view');
    assert.strictEqual(harness.updateLayoutCount(), 1, 'The tab is handed back to its prior layout exactly as before');
  });
});
