import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import vm from 'node:vm';
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
  mobileView?: any;
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
  it('1b. executes Font Finder on both desktop and mobile WebContents in split review mode', () => {
    const { ctx, scriptsExecuted, tabs } = createMockContext();
    const tab1 = tabs.get('tab-1')!;
    const mobileScripts: string[] = [];
    const mockMobileWc = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        mobileScripts.push(script);
        return undefined;
      },
    };
    tab1.state.splitMode = true;
    tab1.mobileView = { webContents: mockMobileWc } as any;

    const devTools = new TabDevToolsHost(ctx);
    devTools.startFontFinder();
    assert.strictEqual(devTools.getIsFontFinderActive(), true);
    assert.ok(scriptsExecuted.some((s) => s.includes('__antifanFontFinderActive')));
    assert.ok(mobileScripts.some((s) => s.includes('__antifanFontFinderActive')));

    devTools.stopFontFinder();
    assert.strictEqual(devTools.getIsFontFinderActive(), false);
    assert.ok(mobileScripts.some((s) => s.includes('__antifanFontFinderActive = false')));
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
    assert.ok(skeleton.includes('id="srcSearchInput"'), 'Must include Ctrl+F search input');
    assert.ok(skeleton.includes('id="btnFormat"'), 'Must include Format toggle button');
    assert.ok(skeleton.includes('id="btnWrap"'), 'Must include Word Wrap toggle button');
    assert.ok(skeleton.includes('id="srcTable"'), 'Must include line numbers table');

    // Extract embedded script and ensure 100% valid ECMAScript without SyntaxError
    const scriptMatch = skeleton.match(/<script>([\s\S]*?)<\/script>/i);
    const scriptContent = (scriptMatch && scriptMatch[1]) || '';
    assert.ok(scriptContent.length > 0, 'Must contain embedded client script');
    assert.doesNotThrow(() => {
      new vm.Script(scriptContent);
    }, 'Embedded view-source script must be 100% valid ECMAScript without SyntaxError');
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

  it('8. injectAutoJsonViewer emits valid pure JavaScript without TypeScript keywords or syntax errors', () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);
    let injectedScript = '';
    const mockWc = {
      isDestroyed: () => false,
      executeJavaScript: async (code: string) => {
        injectedScript = code;
        return undefined;
      },
    } as unknown as Electron.WebContents;

    devTools.injectAutoJsonViewer(mockWc);
    assert.ok(injectedScript.length > 0, 'Must inject AutoJsonViewer script');
    assert.doesNotThrow(() => {
      new vm.Script(injectedScript);
    }, 'Injected AutoJsonViewer script must be 100% valid ECMAScript without SyntaxError');
  });

  it('9. withDeviceMetricsOverride executes CDP Emulation commands and clears metrics in finally', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      return {};
    };

    let actionExecuted = false;
    const result = await devTools.withDeviceMetricsOverride('tab-1', { width: 768, height: 1024, mobile: true }, async () => {
      actionExecuted = true;
      return 'action-result';
    });

    assert.strictEqual(actionExecuted, true);
    assert.strictEqual(result, 'action-result');
    assert.strictEqual(cdpCommands.length, 2);
    const cmd0 = cdpCommands[0];
    const cmd1 = cdpCommands[1];
    assert.ok(cmd0);
    assert.ok(cmd1);
    assert.strictEqual(cmd0.method, 'Emulation.setDeviceMetricsOverride');
    assert.deepStrictEqual(cmd0.params, {
      width: 768,
      height: 1024,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.strictEqual(cmd1.method, 'Emulation.clearDeviceMetricsOverride');
  });

  it('10. captureScreenshot with fullPage: true sends CDP Page.captureScreenshot with fromSurface false and captureBeyondViewport true', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      if (method === 'Page.getLayoutMetrics') {
        return {
          contentSize: { width: 1440, height: 3200 },
        };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
      }
      return {};
    };

    const base64 = await devTools.captureScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true });
    assert.ok(base64.length > 0);

    const pageCaptureCmd = cdpCommands.find((c) => c.method === 'Page.captureScreenshot');
    assert.ok(pageCaptureCmd, 'Page.captureScreenshot must be invoked');
    const params = pageCaptureCmd.params as { fromSurface?: boolean; captureBeyondViewport?: boolean; clip?: { width: number; height: number } };
    assert.strictEqual(params.fromSurface, false, 'fromSurface must be false to avoid clipping to compositor surface');
    assert.strictEqual(params.captureBeyondViewport, true, 'captureBeyondViewport must be true to capture full document');
    assert.strictEqual(params.clip?.width, 1440);
    assert.strictEqual(params.clip?.height, 3200);
  });

  it('11. captureScreenshot with fullPage: true evaluates DOM scroll dimensions when layoutMetrics contentSize is truncated to viewport', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      if (method === 'Page.getLayoutMetrics') {
        return {
          contentSize: { width: 1200, height: 800 },
          layoutViewport: { clientWidth: 1200, clientHeight: 800 },
        };
      }
      if (method === 'Runtime.evaluate') {
        return {
          result: { value: { width: 1200, height: 5800 } },
        };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' };
      }
      return {};
    };

    const base64 = await devTools.captureScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true });
    assert.ok(base64.length > 0);

    const pageCaptureCmd = cdpCommands.find((c) => c.method === 'Page.captureScreenshot');
    assert.ok(pageCaptureCmd, 'Page.captureScreenshot must be invoked');
    const params = pageCaptureCmd.params as { clip?: { width: number; height: number } };
    assert.strictEqual(params.clip?.width, 1200);
    assert.strictEqual(params.clip?.height, 5800, 'Height must be evaluated from DOM scrollHeight 5800, not truncated 800');
  });
});
