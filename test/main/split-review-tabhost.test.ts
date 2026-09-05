import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { SemanticRefRegistry } from '../../src/main/browser/semantic-ref-registry';
import { SplitNavigationCoordinator } from '../../src/main/browser/split-review-coordinator';
import { FirstPartyNetworkTracker } from '../../src/main/browser/first-party-network-tracker';
import { AntiFanTab } from '../../src/shared/contracts';
type PrivateHostMethods = {
  setupTabWebContentsEvents: (id: string, view: unknown, state: unknown, paneId: string) => void;
};
const privateHost = NativeTabHost.prototype as unknown as PrivateHostMethods;

type TestHost = any;
function createTestHost() {
  const host = Object.create(NativeTabHost.prototype) as TestHost;
  EventEmitter.call(host);
  const desktopWc = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    getUserAgent: (): string => '',
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: (): boolean => true,
    canGoForward: (): boolean => false,
    enableDeviceEmulation: (_cfg?: any) => {},
    disableDeviceEmulation: () => {},
    setZoomFactor: (_z?: number) => {},
    capturePage: async () => ({
      toPNG: () => Buffer.from('desktop-png'),
    }),
    executeJavaScript: async (code: string) => `desktop:${code}`,
    insertCSS: async () => '',
    setUserAgent: (_ua: string) => {},
    setWindowOpenHandler: () => {},
    debugger: Object.assign(new EventEmitter(), { isAttached: () => false, attach: () => {}, sendCommand: async () => {} }),
    destroy: () => {},
  });
  const mobileWc = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    getUserAgent: (): string => '',
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: (): boolean => true,
    canGoForward: (): boolean => false,
    enableDeviceEmulation: (_cfg?: any) => {},
    disableDeviceEmulation: () => {},
    setZoomFactor: (_z?: number) => {},
    capturePage: async () => ({
      toPNG: () => Buffer.from('mobile-png'),
    }),
    executeJavaScript: async (code: string) => `mobile:${code}`,
    insertCSS: async () => '',
    setUserAgent: (_ua: string) => {},
    setWindowOpenHandler: () => {},
    debugger: Object.assign(new EventEmitter(), { isAttached: (): boolean => false, attach: () => {}, sendCommand: async (_command?: string, _params?: any): Promise<any> => {} }),
    destroy: () => {},
  });
  const desktopView = {
    webContents: desktopWc,
    setBounds: () => {},
  };

  const mobileView = {
    webContents: mobileWc,
    setBounds: () => {},
  };

  const state: AntiFanTab = {
    id: 'tab-split-1',
    url: 'https://example.com/test',
    title: 'Test Page',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    devicePresetId: 'responsive',
  };

  host.activeTabId = 'tab-split-1';
  host.tabs = new Map([['tab-split-1', { state, view: desktopView, focusedPane: 'desktop' }]]);
  host.tabOrder = ['tab-split-1'];
  host.recentlyClosedTabs = [];
  host.splitCoordinator = new SplitNavigationCoordinator();
  host.transcriptSyncer = { dispose: () => {}, getActiveSessionId: () => 'auto' };
  host.agentWorkingTimers = new Map();
  host.agentWorkingRefs = new Map();
  host.terminalWindows = new Map();
  host.terminalWindowMeta = new Map();
  host.documentGenerations = new Map();
  host.semanticDocumentGenerations = new Map();
  host.semanticRefRegistry = new SemanticRefRegistry();
  host.targetOperationQueues = new Map();
  host.networkTracker = new FirstPartyNetworkTracker();
  host.previewWatcherPool = { clear: () => {} };
  host.persistTabs = () => {};
  host.inspectGeneration = 0;
  host.isInspecting = false;
  host.isProcessingInspectPick = false;
  host.inspectedTabId = null;
  host.programmaticNavigations = new Map();
  host.tabPreviewUnsubscribers = new Map();
  host.toolbarView = {
    webContents: {
      isDestroyed: () => false,
      send: () => {},
    },
  };
  host.window = {
    contentView: {
      addChildView: () => {},
      removeChildView: () => {},
    },
    getBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
    getContentBounds: () => ({ x: 0, y: 0, width: 1400, height: 900 }),
  };
  host.sidebarWidth = 380;
  host.isSidebarOpen = false;
  host.isBookmarkBarVisible = false;
  host.appliedClipRadius = new WeakMap();
  host.emulatedWebContents = new WeakSet();
  host.diagnosticsManager = { recordConsole: () => {}, recordFailure: () => {}, clear: () => {}, deleteTab: () => {} };
  host.broadcastState = () => {};
  host.updateLayout = () => {
    const tab = host.tabs.get(host.activeTabId);
    if (tab) {
      (NativeTabHost.prototype as any).applyTabDeviceEmulation.call(host, tab, 1400, 850, 42);
    }
  };
  host.schedulePersist = () => {};
  host.setupTabWebContentsEvents = () => {};
  host.setupGlobalShortcutsOnView = () => {};
  host.setupContextMenu = () => {};
  return { host, tabs: host.tabs, state, desktopWc, mobileWc, desktopView, mobileView };
}

describe('NativeTabHost Split Review Integration', () => {
  it('resolves WebContents targeting correctly based on focusedPane and explicit paneId', () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');

    // Single view default
    assert.strictEqual(host.getTabWebContents('tab-split-1'), desktopWc);
    assert.strictEqual(host.getTabWebContents('tab-split-1', 'desktop'), desktopWc);
    assert.strictEqual(host.getTabWebContents('tab-split-1', 'mobile'), null);

    // Attach mobile view in split mode
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'desktop';

    assert.strictEqual(host.getTabWebContents('tab-split-1'), desktopWc);
    assert.strictEqual(host.getTabWebContents('tab-split-1', 'mobile'), mobileWc);

    // Focus mobile pane
    tab.focusedPane = 'mobile';
    assert.strictEqual(host.getTabWebContents('tab-split-1'), mobileWc);
    assert.strictEqual(host.getTabWebContents('tab-split-1', 'desktop'), desktopWc);
  });

  it('updates split presets and focused pane via host methods', () => {
    const { host, state, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;

    let layoutUpdated = false;
    host.updateLayout = () => { layoutUpdated = true; };

    // Set desktop preset
    const presetRes1 = host.setSplitPreset('tab-split-1', 'desktop', 'desktop-2k');
    assert.strictEqual(presetRes1, true);
    assert.strictEqual(state.splitDesktopPresetId, 'desktop-2k');
    assert.strictEqual(layoutUpdated, true);

    // Set mobile preset
    layoutUpdated = false;
    const presetRes2 = host.setSplitPreset('tab-split-1', 'mobile', 'phone-iphone15pro');
    assert.strictEqual(presetRes2, true);
    assert.strictEqual(state.splitMobilePresetId, 'phone-iphone15pro');
    assert.strictEqual(layoutUpdated, true);

    // Set focused pane
    let stateBroadcast = false;
    host.broadcastState = () => { stateBroadcast = true; };
    const focusRes = host.setSplitFocusedPane('tab-split-1', 'mobile');
    assert.strictEqual(focusRes, true);
    assert.strictEqual(tab.focusedPane, 'mobile');
    assert.strictEqual(state.splitFocusedPane, 'mobile');
    assert.strictEqual(stateBroadcast, true);
  });

  it('routes DOM inspection, screenshot, and JS execution to focused pane', async () => {
    const { host, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'mobile';

    const dom = await host.getDom('div', 'tab-split-1');
    assert.match(dom, /^mobile:/);

    const evalResult = await host.evalJs('window.location.href', 'tab-split-1');
    assert.match(String(evalResult), /^mobile:/);

    const screenshot = await host.captureScreenshot(undefined, 'tab-split-1');
    assert.strictEqual(screenshot, Buffer.from('mobile-png').toString('base64'));
  });

  it('disables split review cleanly and restores single-view state', () => {
    const { host, state, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    (host as any).emulatedWebContents.add(desktopWc);
    let removedChild = false;
    let mobileDestroyed = false;
    let emulationDisabled = false;
    let zoomRestored = false;

    host.window.contentView.removeChildView = (v: any) => {
      if (v === mobileView) removedChild = true;
    };
    mobileWc.destroy = () => { mobileDestroyed = true; };
    desktopWc.disableDeviceEmulation = () => { emulationDisabled = true; };
    desktopWc.setZoomFactor = (_z?: number) => {
      if (_z === 1.0) zoomRestored = true;
    };

    const res = host.toggleSplitReview('tab-split-1', false);
    assert.strictEqual(res, false);
    assert.strictEqual(state.splitMode, false);
    assert.strictEqual(tab.mobileView, undefined);
    assert.strictEqual(removedChild, true);
    assert.strictEqual(mobileDestroyed, true);
    assert.strictEqual(emulationDisabled, true);
    assert.strictEqual(zoomRestored, true);
  });
  it('does NOT close tab when disabling split review even when mobile view emits destroyed/close events', () => {
    const { host, state, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;

    // Wire real setupTabWebContentsEvents to desktop and mobile views
    privateHost.setupTabWebContentsEvents.call(host, 'tab-split-1', tab.view, tab.state, 'desktop');
    privateHost.setupTabWebContentsEvents.call(host, 'tab-split-1', tab.mobileView, tab.state, 'mobile');

    let closeTabCalled = false;
    host.closeTab = (id: string) => {
      closeTabCalled = true;
      return true;
    };

    mobileWc.destroy = () => {
      mobileWc.emit('destroyed');
      mobileWc.emit('close');
    };

    const res = host.toggleSplitReview('tab-split-1', false);
    assert.strictEqual(res, false);
    assert.strictEqual(state.splitMode, false);
    assert.strictEqual(tab.mobileView, undefined);
    assert.strictEqual(closeTabCalled, false, 'toggleSplitReview(false) must not trigger closeTab');
    assert.strictEqual(host.tabs.has('tab-split-1'), true, 'Tab must remain alive in tabs map');

    // On the other hand, if desktop view emits destroyed, tab should close
    desktopWc.emit('destroyed');
    assert.strictEqual(closeTabCalled, true, 'Desktop webContents destroyed must close tab');
  });

  it('handles mobile render-process-gone by disabling split mode without crashing entire tab', () => {
    const { host, state, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;

    privateHost.setupTabWebContentsEvents.call(host, 'tab-split-1', tab.view, tab.state, 'desktop');
    privateHost.setupTabWebContentsEvents.call(host, 'tab-split-1', tab.mobileView, tab.state, 'mobile');

    // Mobile crashes
    mobileWc.emit('render-process-gone');
    assert.strictEqual(state.crashed, undefined, 'Mobile crash must not mark state.crashed');
    assert.strictEqual(state.splitMode, false, 'Mobile crash must toggle split review off');
    assert.strictEqual(state.splitError, 'Mobile view process exited unexpectedly');
    assert.strictEqual(host.tabs.has('tab-split-1'), true, 'Tab must remain open');
  });

  it('updates canGoBack/canGoForward from authority pane on did-stop-loading', () => {
    const { host, state, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'desktop';

    privateHost.setupTabWebContentsEvents.call(host, 'tab-split-1', tab.view, tab.state, 'desktop');
    privateHost.setupTabWebContentsEvents.call(host, 'tab-split-1', tab.mobileView, tab.state, 'mobile');

    desktopWc.canGoBack = () => true;
    desktopWc.canGoForward = () => false;
    mobileWc.canGoBack = () => false;
    mobileWc.canGoForward = () => true;

    // When desktop is authority and stops loading
    desktopWc.emit('did-stop-loading');
    assert.strictEqual(state.canGoBack, true);
    assert.strictEqual(state.canGoForward, false);

    // When mobile is mirror (not authority) and stops loading, it does not overwrite authority navigation state
    mobileWc.emit('did-stop-loading');
    assert.strictEqual(state.canGoBack, true);
    assert.strictEqual(state.canGoForward, false);

    // When mobile becomes authority (focused) and stops loading
    tab.focusedPane = 'mobile';
    mobileWc.emit('did-stop-loading');
    assert.strictEqual(state.canGoBack, false);
    assert.strictEqual(state.canGoForward, true);
  });

  it('manages device corner clipping safely and idempotently without corrupting DOM containing blocks', async () => {
    const { host, desktopWc } = createTestHost();

    const executedScripts: string[] = [];
    desktopWc.executeJavaScript = async (script: string) => {
      if (script.includes('antifan-device-clip')) {
        executedScripts.push(script);
      }
      return '';
    };

    // 1. Mobile preset: executes cleanup script safely removing any legacy clip style
    host.setDevicePreset('tab-split-1', 'phone-iphone15pro');
    assert.strictEqual(executedScripts.length, 1);
    assert.match(executedScripts[0] || '', /antifan-device-clip/);
    assert.match(executedScripts[0] || '', /style\.remove\(\)/);

    // Invariant: Never inject contain: paint or clip-path on html (breaks position: fixed & annotations)
    assert.doesNotMatch(executedScripts[0] || '', /contain:\s*paint/);
    assert.doesNotMatch(executedScripts[0] || '', /clip-path:\s*inset/);

    // 2. Mobile -> Desktop preset: executes safe removal script
    host.setDevicePreset('tab-split-1', 'laptop-macbook13');
    assert.strictEqual(executedScripts.length, 2);
    assert.match(executedScripts[1] || '', /style\.remove\(\)/);

    // 3. Tablet preset: retains clean DOM contract without clip injection
    host.setDevicePreset('tab-split-1', 'tablet-ipad-pro');
    assert.strictEqual(executedScripts.length, 3);
    assert.match(executedScripts[2] || '', /style\.remove\(\)/);
    assert.doesNotMatch(executedScripts[2] || '', /contain:\s*paint/);
  });

  it('detaches and destroys every owned WebContentsView during dispose', () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const removedViews: any[] = [];
    const destroyed = new Set<string>();
    const mockBackdropView: any = {
      webContents: {
        isDestroyed: () => destroyed.has('backdrop'),
        destroy: () => { destroyed.add('backdrop'); },
        send: () => {},
      },
      setBounds: () => {},
    };
    const mockToolbarView: any = {
      webContents: {
        isDestroyed: () => destroyed.has('toolbar'),
        destroy: () => { destroyed.add('toolbar'); },
        send: () => {},
      },
    };
    desktopWc.isDestroyed = () => destroyed.has('desktop');
    desktopWc.destroy = () => { destroyed.add('desktop'); };
    mobileWc.isDestroyed = () => destroyed.has('mobile');
    mobileWc.destroy = () => { destroyed.add('mobile'); };
    host.tabs.get('tab-split-1').mobileView = mobileView;
    host.window.contentView.removeChildView = (view: any) => {
      removedViews.push(view);
    };
    host.toolbarView = mockToolbarView;
    host.frameBackdropView = mockBackdropView;

    NativeTabHost.prototype.dispose.call(host);

    assert.ok(removedViews.includes(mockToolbarView));
    assert.ok(removedViews.includes(mockBackdropView));
    assert.deepStrictEqual([...destroyed].sort(), ['backdrop', 'desktop', 'mobile', 'toolbar']);
    assert.strictEqual(host.frameBackdropView, null);
  });

  it('injects inspect picker into both desktop and mobile webContents in split mode and auto-focuses picked pane', async () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'desktop';
    tab.state.splitFocusedPane = 'desktop';

    let pickedElement: any = null;
    let pickCount = 0;
    host.on('element-picked', (payload: any) => {
      pickCount++;
      pickedElement = payload;
    });
    host.resolveTargetWorkspace = () => process.cwd();
    host.resolveAnnotationWorkspace = () => process.cwd();

    const emptyImage = {
      isEmpty: () => true,
      toPNG: () => Buffer.from(''),
      getSize: () => ({ width: 0, height: 0 }),
    };
    (desktopWc as any).capturePage = async () => emptyImage;
    (mobileWc as any).capturePage = async () => emptyImage;

    const injectedWcs: any[] = [];
    (desktopWc as any).executeJavaScript = async (script: string): Promise<any> => {
      injectedWcs.push(desktopWc);
      if (script.includes('const r = window.__antifanPick')) return null;
      return undefined;
    };
    let mobilePendingPick: any = { selector: 'button.checkout', userComment: 'Test mobile button' };
    (mobileWc as any).executeJavaScript = async (script: string): Promise<any> => {
      injectedWcs.push(mobileWc);
      if (script.includes('const r = window.__antifanPick')) {
        const val = mobilePendingPick;
        mobilePendingPick = null;
        return val;
      }
      return undefined;
    };
    (NativeTabHost.prototype as any).startInspect.call(host);

    // Both panes had the element picker injected
    assert.strictEqual(injectedWcs.includes(desktopWc), true);
    assert.strictEqual(injectedWcs.includes(mobileWc), true);
    // Wait for the poll timer (200ms) to detect and process the mobile pick
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    // Verify auto-focus switched to mobile pane
    assert.strictEqual(tab.focusedPane, 'mobile');
    assert.strictEqual(tab.state.splitFocusedPane, 'mobile');
    assert.strictEqual(pickCount, 1);
    assert.strictEqual(pickedElement?.userComment, 'Test mobile button');

    (NativeTabHost.prototype as any).stopInspect.call(host);
  });

  it('prevents duplicate pick dispatch when both panes have pending picks in the same tick', async () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1');
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'desktop';

    let pickCount = 0;
    host.on('element-picked', () => { pickCount++; });
    host.resolveTargetWorkspace = () => process.cwd();
    host.resolveAnnotationWorkspace = () => process.cwd();

    const emptyImage = {
      isEmpty: () => true,
      toPNG: () => Buffer.from(''),
      getSize: () => ({ width: 0, height: 0 }),
    };
    (desktopWc as any).capturePage = async () => emptyImage;
    (mobileWc as any).capturePage = async () => emptyImage;

    // Both desktop and mobile have a pending pick at the exact same moment
    let desktopPendingPick: any = { selector: 'header.desktop', userComment: 'Desktop comment' };
    let mobilePendingPick: any = { selector: 'footer.mobile', userComment: 'Mobile comment' };
    (desktopWc as any).executeJavaScript = async (script: string): Promise<any> => {
      if (script.includes('const r = window.__antifanPick')) {
        const val = desktopPendingPick;
        desktopPendingPick = null;
        return val;
      }
      return undefined;
    };
    (mobileWc as any).executeJavaScript = async (script: string): Promise<any> => {
      if (script.includes('const r = window.__antifanPick')) {
        const val = mobilePendingPick;
        mobilePendingPick = null;
        return val;
      }
      return undefined;
    };
    (NativeTabHost.prototype as any).startInspect.call(host);

    // Wait for the poll timer (200ms) to detect and process the picks
    await new Promise<void>((resolve) => setTimeout(resolve, 350));
    assert.strictEqual(pickCount, 1);
    assert.strictEqual(host.isInspecting, false);
    (NativeTabHost.prototype as any).stopInspect.call(host);
  });

  it('applies genuine mobile user agent and touch emulation in split mode', async () => {
    const { host, tabs, desktopWc, mobileWc } = createTestHost();
    const tab = tabs.get('tab-split-1')!;
    tab.state.splitMode = true;
    tab.mobileView = { webContents: mobileWc, setBounds: () => {} } as any;

    let desktopUaSet = '';
    let mobileUaSet = '';
    let mobileEmulationConfig: any = null;
    let cdpCalls: Array<{ cmd: string; params: any }> = [];
    let mobileClippingScript = '';

    desktopWc.setUserAgent = (ua: string) => { desktopUaSet = ua; };
    mobileWc.setUserAgent = (ua: string) => { mobileUaSet = ua; };
    mobileWc.enableDeviceEmulation = (cfg: any) => { mobileEmulationConfig = cfg; };
    mobileWc.executeJavaScript = async (script: string) => {
      if (script.includes('antifan-device-clip')) mobileClippingScript = script;
      return '';
    };
    mobileWc.debugger = {
      isAttached: () => true,
      attach: () => {},
      sendCommand: async (cmd: string, params: any) => { cdpCalls.push({ cmd, params }); },
    } as any;

    (NativeTabHost.prototype as any).applyTabDeviceEmulation.call(host, tab, 1600, 900, 74);

    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await new Promise<void>((resolve) => { setTimeout(resolve, 10); });

    assert.ok(mobileUaSet.includes('iPhone') || mobileUaSet.includes('Mobile'), 'Mobile pane must receive mobile User-Agent');
    assert.ok(mobileEmulationConfig !== null, 'Mobile pane must enable device emulation');
    assert.strictEqual(mobileEmulationConfig.screenPosition, 'mobile');
    
    // Invariant: Clean web standards without contain:paint DOM clipping
    assert.match(mobileClippingScript, /style\.remove\(\)/);
    assert.doesNotMatch(mobileClippingScript, /contain:\s*paint/);
    // Invariant: Touch emulation must enable touch capability without suppressing mousemove/hover
    const touchEnabledCall = cdpCalls.find((c) => c.cmd === 'Emulation.setTouchEmulationEnabled');
    const mouseTouchCall = cdpCalls.find((c) => c.cmd === 'Emulation.setEmitTouchEventsForMouse');
    assert.ok(touchEnabledCall, 'Must enable CDP touch emulation on mobile');
    assert.strictEqual(touchEnabledCall.params?.enabled, true);
    assert.strictEqual(touchEnabledCall.params?.maxTouchPoints, 5);
    assert.ok(mouseTouchCall, 'Must configure setEmitTouchEventsForMouse');
    assert.strictEqual(mouseTouchCall.params?.enabled, false, 'Must disable setEmitTouchEventsForMouse so annotation hover is preserved');
  });

  it('reloads both desktop and mobile WebContents in split review mode', () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1')!;
    let desktopReloadCount = 0;
    let mobileReloadCount = 0;
    desktopWc.reload = () => { desktopReloadCount++; };
    mobileWc.reload = () => { mobileReloadCount++; };

    // Case A: Split Review Mode enabled -> must reload BOTH views
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'desktop';

    const res = host.reload('tab-split-1');
    assert.strictEqual(res, true);
    assert.strictEqual(desktopReloadCount, 1, 'Desktop WebContents must reload in split mode');
    assert.strictEqual(mobileReloadCount, 1, 'Mobile WebContents must reload in split mode');

    // Focus on mobile -> reload must still reload BOTH views
    tab.focusedPane = 'mobile';
    host.reload('tab-split-1');
    assert.strictEqual(desktopReloadCount, 2, 'Desktop WebContents must reload regardless of focusedPane');
    assert.strictEqual(mobileReloadCount, 2, 'Mobile WebContents must reload regardless of focusedPane');

    // Case B: Single View (splitMode false) -> only desktop reloads
    tab.state.splitMode = false;
    host.reload('tab-split-1');
    assert.strictEqual(desktopReloadCount, 3);
    assert.strictEqual(mobileReloadCount, 2, 'Mobile WebContents must NOT reload when split mode is disabled');
  });

  it('awaits desktop navigation start and load completion in navigateAndWait', async () => {
    const { host, desktopWc } = createTestHost();

    // navigateAndWait awaits did-start-navigation and did-finish-load
    let navPromise = host.navigateAndWait('tab-split-1', 'https://example.com/updated');
    setImmediate(() => {
      desktopWc.emit('did-start-navigation', {}, 'https://example.com/updated', false, true);
      desktopWc.emit('did-finish-load');
    });
    const navResult = await navPromise;
    assert.strictEqual(navResult, true);
  });

  it('ignores premature did-finish-load or did-fail-load from previous document before navigation start in navigateAndWait', async () => {
    const { host, desktopWc } = createTestHost();

    let navPromise = host.navigateAndWait('tab-split-1', 'https://example.com/clean-nav', 2000);
    
    // 1. Emit premature events from previous document abort/finish before did-start-navigation
    desktopWc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/old', true);
    desktopWc.emit('did-finish-load');

    // 2. Later, the new navigation actually starts and finishes
    await new Promise((resolve) => setTimeout(resolve, 20));
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/clean-nav', false, true);
    desktopWc.emit('did-finish-load');

    const navResult = await navPromise;
    assert.strictEqual(navResult, true, 'navigateAndWait must ignore previous document events and resolve true after new navigation finishes');
  });

  it('handles HTTP redirect sequence with intermediate ERR_ABORTED in navigateAndWait without prematurely failing', async () => {
    const { host, desktopWc } = createTestHost();

    let navPromise = host.navigateAndWait('tab-split-1', 'https://example.com/initial-302', 2000);
    
    // 1. Initial navigation starts
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/initial-302', false, true);

    // 2. Server responds 302: Chromium aborts initial request and fires did-fail-load with ERR_ABORTED
    desktopWc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/initial-302', true);

    // 3. Chromium immediately starts redirected navigation and finishes
    await new Promise((resolve) => setTimeout(resolve, 10));
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/destination', false, true);
    desktopWc.emit('did-finish-load');

    const navResult = await navPromise;
    assert.strictEqual(navResult, true, 'navigateAndWait must succeed across HTTP redirect without failing on intermediate ERR_ABORTED');
  });
  it('returns false in navigateAndWait when main frame did-fail-load fires', async () => {
    const { host, desktopWc } = createTestHost();

    let navPromise = host.navigateAndWait('tab-split-1', 'https://example.com/failed', 1000);
    setImmediate(() => {
      desktopWc.emit('did-start-navigation', {}, 'https://example.com/failed', false, true);
      desktopWc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://example.com/failed', true);
    });
    const navResult = await navPromise;
    assert.strictEqual(navResult, false, 'navigateAndWait must return false when main frame fails to load');
  });

  it('returns false in navigateAndWait when navigation start times out', async () => {
    const { host } = createTestHost();

    // Do not emit did-start-navigation to trigger timeout
    const navResult = await host.navigateAndWait('tab-split-1', 'https://example.com/timeout', 50);
    assert.strictEqual(navResult, false, 'navigateAndWait must return false on navigation start timeout');
  });

  it('returns false in navigateAndWait when load completion times out after start', async () => {
    const { host, desktopWc } = createTestHost();

    let navPromise = host.navigateAndWait('tab-split-1', 'https://example.com/load-timeout', 50);
    setImmediate(() => {
      desktopWc.emit('did-start-navigation', {}, 'https://example.com/load-timeout', false, true);
      // Do not emit did-finish-load or did-fail-load
    });
    const navResult = await navPromise;
    assert.strictEqual(navResult, false, 'navigateAndWait must return false when load completion times out');
  });

  it('awaits desktop load completion in reloadAndWait, ignoring premature navigation start', async () => {
    const { host, desktopWc } = createTestHost();

    let reloadInitiatedResolve: () => void = () => {};
    const reloadInitiated = new Promise<void>((resolve) => {
      reloadInitiatedResolve = resolve;
    });
    desktopWc.reload = () => {
      reloadInitiatedResolve();
    };

    let isResolved = false;
    const reloadPromise = host.reloadAndWait('tab-split-1');
    reloadPromise.then(() => {
      isResolved = true;
    });

    await reloadInitiated;

    // Emitting did-start-navigation must NOT resolve reloadAndWait
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/updated', false, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(isResolved, false, 'reloadAndWait must remain pending after did-start-navigation');

    // Emitting did-finish-load resolves reloadAndWait
    desktopWc.emit('did-finish-load');
    const reloadResult = await reloadPromise;
    assert.strictEqual(reloadResult, true);
  });

  it('awaits mobile authority navigation start and load completion in navigateAndWait when mobile pane is focused', async () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1')!;
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'mobile';

    // 1. navigateAndWait awaits did-start-navigation and did-finish-load on mobile WebContents
    let navPromise = host.navigateAndWait('tab-split-1', 'https://example.com/mobile-updated');
    setImmediate(() => {
      mobileWc.emit('did-start-navigation', {}, 'https://example.com/mobile-updated', false, true);
      mobileWc.emit('did-finish-load');
    });
    const navResult = await navPromise;
    assert.strictEqual(navResult, true);

    // 2. reloadAndWait awaits did-finish-load on mobile WebContents
    let mobileReloadInitiatedResolve: () => void = () => {};
    const mobileReloadInitiated = new Promise<void>((resolve) => {
      mobileReloadInitiatedResolve = resolve;
    });
    mobileWc.reload = () => {
      mobileReloadInitiatedResolve();
    };

    let isResolved = false;
    const reloadPromise = host.reloadAndWait('tab-split-1');
    reloadPromise.then(() => {
      isResolved = true;
    });

    await mobileReloadInitiated;

    // Desktop finish load does not resolve mobile authority reload
    desktopWc.emit('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(isResolved, false, 'reloadAndWait must not resolve from non-authority pane');

    // Mobile finish load resolves
    mobileWc.emit('did-finish-load');
    const reloadResult = await reloadPromise;
    assert.strictEqual(reloadResult, true);
  });

  it('handles did-fail-load and timeout in reloadAndWait with listener cleanup', async () => {
    const { host, desktopWc } = createTestHost();

    // 1. Subframe failure is ignored; subsequent finish-load resolves true
    let reload1InitiatedResolve: () => void = () => {};
    const reload1Initiated = new Promise<void>((resolve) => {
      reload1InitiatedResolve = resolve;
    });
    desktopWc.reload = () => {
      reload1InitiatedResolve();
    };
    const reloadPromise1 = host.reloadAndWait('tab-split-1');
    await reload1Initiated;
    desktopWc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.com/subframe', false);
    desktopWc.emit('did-finish-load');
    const result1 = await reloadPromise1;
    assert.strictEqual(result1, true, 'Subframe did-fail-load must not fail reloadAndWait');

    // 2. Main-frame failure resolves false
    let reload2InitiatedResolve: () => void = () => {};
    const reload2Initiated = new Promise<void>((resolve) => {
      reload2InitiatedResolve = resolve;
    });
    desktopWc.reload = () => {
      reload2InitiatedResolve();
    };
    const reloadPromise2 = host.reloadAndWait('tab-split-1');
    await reload2Initiated;
    desktopWc.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://example.com/main', true);
    const result2 = await reloadPromise2;
    assert.strictEqual(result2, false, 'Main-frame did-fail-load must resolve false');

    // 3. Bounded timeout resolves false and cleans up listeners
    desktopWc.reload = () => {};
    const result3 = await host.reloadAndWait('tab-split-1', 30);
    assert.strictEqual(result3, false, 'Timeout must resolve false');

    // Late finish load event after timeout should not throw or alter settled state
    assert.doesNotThrow(() => {
      desktopWc.emit('did-finish-load');
    });
  });

  it('increments documentGenerations only on authority pane navigation in split review mode', () => {
    const { host, desktopWc, mobileWc, mobileView } = createTestHost();
    const tab = host.tabs.get('tab-split-1')!;
    tab.state.splitMode = true;
    tab.mobileView = mobileView;
    tab.focusedPane = 'mobile';
    host.documentGenerations.set('tab-split-1', 1);

    // Call real setupTabWebContentsEvents on both desktop and mobile views
    (NativeTabHost.prototype as any).setupTabWebContentsEvents.call(host, 'tab-split-1', tab.view, tab.state, 'desktop');
    (NativeTabHost.prototype as any).setupTabWebContentsEvents.call(host, 'tab-split-1', tab.mobileView, tab.state, 'mobile');
    // Case 1: Mobile is authority -> did-start-navigation on mobile increments generation
    const initialMobileGen = host.getSemanticDocumentGeneration('tab-split-1', 'mobile');
    const initialDesktopGen = host.getSemanticDocumentGeneration('tab-split-1', 'desktop');

    mobileWc.emit('did-start-navigation', {}, 'https://example.com/mobile-1', false, true);
    assert.strictEqual(host.getDocumentGeneration('tab-split-1'), 2, 'Mobile authority navigation must increment tab generation');
    assert.strictEqual(host.getSemanticDocumentGeneration('tab-split-1', 'mobile'), initialMobileGen + 1, 'Mobile navigation must increment mobile semantic generation');
    assert.strictEqual(host.getSemanticDocumentGeneration('tab-split-1', 'desktop'), initialDesktopGen, 'Mobile navigation must not increment desktop semantic generation');

    // Case 2: Mirror navigation on desktop must NOT double-increment tab generation, but increments desktop semantic generation
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/mobile-1', false, true);
    assert.strictEqual(host.getDocumentGeneration('tab-split-1'), 2, 'Desktop mirror navigation must not double-increment tab generation');
    assert.strictEqual(host.getSemanticDocumentGeneration('tab-split-1', 'desktop'), initialDesktopGen + 1, 'Desktop mirror navigation must increment desktop semantic generation');

    // Case 3: Switch focused pane to desktop -> desktop becomes authority
    tab.focusedPane = 'desktop';
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/desktop-1', false, true);
    assert.strictEqual(host.getDocumentGeneration('tab-split-1'), 3, 'Desktop authority navigation must increment tab generation');

    // Mobile mirror does not increment tab generation, but increments mobile semantic generation
    mobileWc.emit('did-start-navigation', {}, 'https://example.com/desktop-1', false, true);
    assert.strictEqual(host.getDocumentGeneration('tab-split-1'), 3, 'Mobile mirror navigation must not double-increment tab generation');

    // Case 4: Subframe or in-place navigation on desktop increments desktop semantic generation without touching tab generation
    const curDesktopGen = host.getSemanticDocumentGeneration('tab-split-1', 'desktop');
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/desktop-1#hash', true, true);
    assert.strictEqual(host.getDocumentGeneration('tab-split-1'), 3, 'In-place navigation must not increment tab generation');
    assert.strictEqual(host.getSemanticDocumentGeneration('tab-split-1', 'desktop'), curDesktopGen + 1, 'In-place navigation must increment desktop semantic generation');

    // Case 5: Destroyed mobile view falls back to desktop authority even if focusedPane is mobile
    tab.focusedPane = 'mobile';
    tab.mobileView.webContents.isDestroyed = () => true;
    desktopWc.emit('did-start-navigation', {}, 'https://example.com/desktop-2', false, true);
    assert.strictEqual(host.getDocumentGeneration('tab-split-1'), 4, 'Destroyed mobile view falls back to desktop authority');
  });
  it('sets user agent safely and idempotently without redundant calls or ERR_ABORTED churn', () => {
    const { host, desktopWc } = createTestHost();
    let uaCallCount = 0;
    let currentUa = 'Mozilla/5.0 DefaultUA';

    desktopWc.getUserAgent = () => currentUa;
    desktopWc.setUserAgent = (newUa: string) => {
      uaCallCount++;
      currentUa = newUa;
    };

    // First call sets new UA
    (NativeTabHost.prototype as any).setSafeUserAgent.call(host, desktopWc, 'Mozilla/5.0 CustomUA');
    assert.strictEqual(uaCallCount, 1);
    assert.strictEqual(currentUa, 'Mozilla/5.0 CustomUA');

    // Second call with same UA is a no-op and does not call setUserAgent
    (NativeTabHost.prototype as any).setSafeUserAgent.call(host, desktopWc, 'Mozilla/5.0 CustomUA');
    assert.strictEqual(uaCallCount, 1, 'Redundant setSafeUserAgent must be a no-op');

    // Call on destroyed webContents does nothing
    desktopWc.isDestroyed = () => true;
    (NativeTabHost.prototype as any).setSafeUserAgent.call(host, desktopWc, 'Mozilla/5.0 AnotherUA');
    assert.strictEqual(uaCallCount, 1, 'Destroyed webContents must not invoke setUserAgent');
  });

  it('auto-focuses target pane on context-menu event in split review mode', () => {
    const { host, mobileWc } = createTestHost();
    const tab = host.tabs.get('tab-split-1')!;
    tab.state.splitMode = true;
    tab.focusedPane = 'desktop';
    tab.state.splitFocusedPane = 'desktop';

    // Attach real setupContextMenu for mobile pane
    (NativeTabHost.prototype as any).setupContextMenu.call(host, mobileWc, 'mobile');

    // Fire context-menu event on mobile webContents
    mobileWc.emit('context-menu', {}, { x: 100, y: 100 });

    assert.strictEqual(tab.focusedPane, 'mobile', 'Right-clicking mobile pane must switch focusedPane to mobile');
    assert.strictEqual(tab.state.splitFocusedPane, 'mobile', 'Right-clicking mobile pane must update state.splitFocusedPane');
  });

  it('configures CDP touch emulation without hijacking mouse movements so hover and context menu work smoothly', async () => {
    const { host, mobileWc } = createTestHost();
    const sentCommands: Array<{ command: string; params?: any }> = [];

    mobileWc.debugger = Object.assign(new EventEmitter(), {
      isAttached: (): boolean => true,
      attach: () => {},
      sendCommand: async (_command?: string, params?: any): Promise<any> => {
        sentCommands.push({ command: _command || '', params });
      },
    });

    // 1. Invoke applyCdpTouchEmulation with true (as called in split mobile mode)
    await (NativeTabHost.prototype as any).applyCdpTouchEmulation.call(host, mobileWc, true);

    const touchEnabledCommand = sentCommands.find((c) => c.command === 'Emulation.setTouchEmulationEnabled');
    const mouseTouchCommand = sentCommands.find((c) => c.command === 'Emulation.setEmitTouchEventsForMouse');
    assert.ok(touchEnabledCommand, 'Must send Emulation.setTouchEmulationEnabled command');
    assert.strictEqual(touchEnabledCommand.params?.enabled, true, 'Touch emulation should be enabled for mobile testing');
    assert.ok(mouseTouchCommand, 'Must configure mouse touch emission');
    assert.strictEqual(mouseTouchCommand.params?.enabled, false, 'Must not hijack mouse movements with touch emission so right-click works');

    // 2. Invoke applyCdpTouchEmulation with false (when exiting split mode)
    sentCommands.length = 0;
    await (NativeTabHost.prototype as any).applyCdpTouchEmulation.call(host, mobileWc, false);
    const disableTouchCommand = sentCommands.find((c) => c.command === 'Emulation.setTouchEmulationEnabled');
    assert.ok(disableTouchCommand, 'Must disable touch emulation on reset');
    assert.strictEqual(disableTouchCommand.params?.enabled, false);
  });

  it('registers context-menu listener on frameBackdropView', () => {
    const { host } = createTestHost();
    const backdropWc = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
    });

    (NativeTabHost.prototype as any).setupBackdropContextMenu.call(host, backdropWc);
    assert.strictEqual(backdropWc.listenerCount('context-menu'), 1, 'Backdrop webContents must have 1 context-menu listener');
  });
});
