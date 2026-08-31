import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement } from '../../src/shared/contracts';

interface MockTabRecord {
  state: AntiFanTab;
  focusedPane: SplitPaneId;
  view: {
    webContents: {
      isDestroyed: () => boolean;
      executeJavaScript: (script: string, ...args: unknown[]) => Promise<unknown>;
      capturePage: (rect?: unknown) => Promise<{ isEmpty: () => boolean; toPNG: () => { toString: (fmt: string) => string }; toDataURL: () => string; getSize: () => { width: number; height: number }; crop: (r: unknown) => unknown }>;
      findInPage: (text: string, options?: unknown) => void;
      stopFindInPage: (action: string) => void;
      loadURL: (url: string) => Promise<void>;
    };
  };
}

describe('TabDevToolsHost (Sub-Controller Unit Tests)', () => {
  function createMockContext() {
    const scriptsExecuted: string[] = [];
    let broadcastCount = 0;
    const tabs = new Map<string, MockTabRecord>();

    const mockWc = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        scriptsExecuted.push(script);
        if (script.includes('document.documentElement ? document.documentElement.outerHTML')) {
          return '<html><body><h1>Hello Test</h1></body></html>';
        }
        if (script.includes('window.__antifanPickedElement')) {
          return null;
        }
        return undefined;
      },
      capturePage: async () => ({
        isEmpty: () => false,
        toPNG: () => ({ toString: () => 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }),
        toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        getSize: () => ({ width: 100, height: 100 }),
        crop: () => ({ isEmpty: () => false, toPNG: () => ({ toString: () => 'cropped' }) }),
      }),
      findInPage: (text: string) => {
        scriptsExecuted.push(`findInPage:${text}`);
      },
      stopFindInPage: (action: string) => {
        scriptsExecuted.push(`stopFindInPage:${action}`);
      },
      loadURL: async (url: string) => {
        scriptsExecuted.push(`loadURL:${url.slice(0, 30)}`);
      },
    };

    const initialTab: MockTabRecord = {
      state: {
        id: 'tab-1',
        url: 'https://example.com/store',
        title: 'Example Store',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        zoomFactor: 1,
        devicePresetId: 'responsive',
      },
      focusedPane: 'desktop',
      view: { webContents: mockWc },
    };
    tabs.set('tab-1', initialTab);

    let activeTabId = 'tab-1';

    const ctx: TabDevToolsContext = {
      getTabWebContents: (_tabId, _paneId) => mockWc as any,
      getTabRecord: (tabId) => tabs.get(tabId) as any,
      getActiveTabId: () => activeTabId,
      getAllTabs: () => tabs.entries() as any,
      broadcastState: () => {
        broadcastCount++;
      },
      getTabTerminalSession: () => 'session-1',
      resolveTargetWorkspace: () => 'E:/Work/project',
      resolveAnnotationWorkspace: () => 'E:/Work/project',
      createTab: (url) => {
        const newId = `tab-${tabs.size + 1}`;
        tabs.set(newId, {
          state: {
            id: newId,
            url: url || 'about:blank',
            title: url || 'New Tab',
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
            crashed: false,
            zoomFactor: 1,
            devicePresetId: 'responsive',
          },
          focusedPane: 'desktop',
          view: { webContents: mockWc },
        });
        return newId;
      },
      withTabAgentWorking: async (_tabId, action) => action(),
    };

    return { ctx, scriptsExecuted, getBroadcastCount: () => broadcastCount, tabs, mockWc };
  }

  it('1. toggles Font Finder, executes script on start, and cleans up on stop', () => {
    const { ctx, scriptsExecuted, getBroadcastCount } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    assert.strictEqual(devTools.getIsFontFinderActive(), false);
    const started = devTools.toggleFontFinder();
    assert.strictEqual(started, true);
    assert.strictEqual(devTools.getIsFontFinderActive(), true);
    assert.strictEqual(getBroadcastCount(), 1);

    const stopped = devTools.toggleFontFinder();
    assert.strictEqual(stopped, false);
    assert.strictEqual(devTools.getIsFontFinderActive(), false);
    assert.strictEqual(getBroadcastCount(), 2);
    assert.ok(scriptsExecuted.some((s) => s.includes('__antifanFontFinderActive = false')));
  });

  it('2. toggles GPU Lens, captures snapshot, and cleans up', async () => {
    const { ctx, scriptsExecuted, getBroadcastCount } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    assert.strictEqual(devTools.getIsLensActive(), false);
    await devTools.startLens();
    assert.strictEqual(devTools.getIsLensActive(), true);
    assert.strictEqual(getBroadcastCount(), 1);
    assert.ok(scriptsExecuted.some((s) => s.includes('__antifanLensUpdateSnapshot')));

    devTools.stopLens();
    assert.strictEqual(devTools.getIsLensActive(), false);
    assert.strictEqual(getBroadcastCount(), 2);
    assert.ok(scriptsExecuted.some((s) => s.includes('__antifanLensActive = false')));
  });

  it('3. toggles Screen Ruler across all open tabs and cleans up grid', () => {
    const { ctx, scriptsExecuted, getBroadcastCount } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    assert.strictEqual(devTools.getIsRulerActive(), false);
    devTools.startRuler();
    assert.strictEqual(devTools.getIsRulerActive(), true);
    assert.strictEqual(getBroadcastCount(), 1);

    devTools.stopRuler();
    assert.strictEqual(devTools.getIsRulerActive(), false);
    assert.strictEqual(getBroadcastCount(), 2);
    assert.ok(scriptsExecuted.some((s) => s.includes('__antifan_ruler_grid')));
  });

  it('4. manages element inspection lifecycle and stops cleanly', () => {
    const { ctx, scriptsExecuted, getBroadcastCount } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    assert.strictEqual(devTools.getIsInspecting(), false);
    devTools.startInspect();
    assert.strictEqual(devTools.getIsInspecting(), true);
    assert.strictEqual(devTools.getInspectedTabId(), 'tab-1');
    assert.strictEqual(getBroadcastCount(), 1);

    devTools.stopInspect();
    assert.strictEqual(devTools.getIsInspecting(), false);
    assert.strictEqual(devTools.getInspectedTabId(), null);
    assert.strictEqual(getBroadcastCount(), 2);
    assert.ok(scriptsExecuted.some((s) => s.includes('__antifanPickerActive = false')));
  });

  it('5. captures screenshot, queries DOM, evaluates JS, and manages FindInPage', async () => {
    const { ctx, scriptsExecuted } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const screenshotBase64 = await devTools.captureScreenshot();
    assert.ok(screenshotBase64.length > 0);

    const dom = await devTools.getDom();
    assert.strictEqual(dom, '<html><body><h1>Hello Test</h1></body></html>');

    devTools.findInPage('search text');
    assert.ok(scriptsExecuted.includes('findInPage:search text'));

    devTools.stopFindInPage();
    assert.ok(scriptsExecuted.includes('stopFindInPage:clearSelection'));
  });

  it('6. generates view-source tab with skeleton and disposes cleanly', async () => {
    const { ctx, tabs } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const newTabId = await devTools.viewPageSource('tab-1');
    assert.ok(newTabId);
    assert.strictEqual(tabs.has(newTabId), true);

    const skeleton = devTools.renderPageSourceSkeletonHtml();
    assert.ok(skeleton.includes('VIEW SOURCE'));
    assert.ok(skeleton.includes('__antifanRenderSource'));

    devTools.dispose();
    assert.strictEqual(devTools.getIsInspecting(), false);
  });

  it('7. viewPageSource creates about:blank and triggers exactly one preloaded fetch without double network load', async () => {
    const { ctx, tabs, scriptsExecuted } = createMockContext();
    let createTabUrl = '';
    const origCreateTab = ctx.createTab;
    ctx.createTab = (url?: string, activate?: boolean) => {
      createTabUrl = url || '';
      return origCreateTab(url, activate);
    };

    const devTools = new TabDevToolsHost(ctx);
    let fetchCalls = 0;
    (devTools as any).fetchAndLoadPageSource = async (_wc: any, _url: string, _state: any, _html: string) => {
      fetchCalls++;
    };

    const newTabId = await devTools.viewPageSource('tab-1');
    assert.strictEqual(createTabUrl, 'about:blank', 'Must create tab with about:blank to prevent native double fetch');
    assert.strictEqual(fetchCalls, 1, 'fetchAndLoadPageSource must be invoked exactly once');

    const newTab = tabs.get(newTabId);
    assert.ok(newTab);
    assert.strictEqual(newTab.state.url, 'view-source:https://example.com/store');
  });
});
