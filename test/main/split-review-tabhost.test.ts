import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { SplitNavigationCoordinator } from '../../src/main/browser/split-review-coordinator';
import { AntiFanTab } from '../../src/shared/contracts';

type TestHost = any;

function createTestHost() {
  const host = Object.create(NativeTabHost.prototype) as TestHost;
  const desktopWc = {
    isDestroyed: () => false,
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: () => true,
    canGoForward: () => false,
    enableDeviceEmulation: () => {},
    disableDeviceEmulation: () => {},
    setZoomFactor: (_z?: number) => {},
    capturePage: async () => ({
      toPNG: () => Buffer.from('desktop-png'),
    }),
    executeJavaScript: async (code: string) => `desktop:${code}`,
    destroy: () => {},
  };

  const mobileWc = {
    isDestroyed: () => false,
    loadURL: async () => {},
    reload: () => {},
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: () => true,
    canGoForward: () => false,
    enableDeviceEmulation: () => {},
    disableDeviceEmulation: () => {},
    setZoomFactor: (_z?: number) => {},
    capturePage: async () => ({
      toPNG: () => Buffer.from('mobile-png'),
    }),
    executeJavaScript: async (code: string) => `mobile:${code}`,
    destroy: () => {},
  };

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
  host.splitCoordinator = new SplitNavigationCoordinator();
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
  host.broadcastState = () => {};
  host.updateLayout = () => {
    const tab = host.tabs.get(host.activeTabId);
    if (tab) {
      (NativeTabHost.prototype as any).applyTabDeviceEmulation.call(host, tab, 1400, 850, 42);
    }
  };
  host.schedulePersist = () => {};
  host.setupTabWebContentsEvents = () => {};
  return { host, state, desktopWc, mobileWc, desktopView, mobileView };
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
});
