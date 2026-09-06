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

  it('fails fast with TARGET_BUSY_DRAINING and bounds admission during unsettled command', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    const calls: string[] = [];
    const { promise: screenshotPromise, resolve: resolveScreenshot } = Promise.withResolvers<unknown>();

    const mockWc = {
      id: 500,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) => {
          calls.push(method);
          return method === 'Page.captureScreenshot'
            ? screenshotPromise
            : Promise.resolve({ ok: true });
        },
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    // Command 1 times out from caller perspective while still unresolved in Chromium
    await assert.rejects(
      devTools.sendCdpCommand(mockWc, 'Page.captureScreenshot', {}, 5),
      /timed out/
    );

    // Target is now draining Command 1
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1);

    // 50 repeated calls during the draining period must all fail-fast without enqueueing
    for (let i = 0; i < 50; i++) {
      await assert.rejects(
        devTools.sendCdpCommand(mockWc, 'DOM.enable', {}, 50),
        /TARGET_BUSY_DRAINING/
      );
    }

    // Underlying debugger.sendCommand was NOT called again; call count remains exactly 1
    assert.deepStrictEqual(calls, ['Page.captureScreenshot']);
    assert.strictEqual(devTools.getStats().queuedTargetCount, 1, 'Queue must retain pending drain promise during quarantine');
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1, 'Target must be marked as draining');

    // Now simulate Command 1 finally settling in Chromium
    resolveScreenshot({ data: 'done' });

    // Yield so microtasks run
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Draining state and queue entry are cleared once settled
    assert.strictEqual(devTools.getStats().drainingTargetCount, 0, 'Draining state must be cleared after settlement');
    assert.strictEqual(devTools.getStats().queuedTargetCount, 0, 'Queue must be drained and deleted after settlement');
    // Now a fresh command 3 can be admitted and dispatched
    const res = await devTools.sendCdpCommand(mockWc, 'DOM.enable', {}, 50) as { ok: boolean };
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(calls, ['Page.captureScreenshot', 'DOM.enable']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(devTools.getStats().queuedTargetCount, 0);
  });

  it('prevents stale settlement from clearing draining state of a newer command on recycled target ID', async () => {
    const { ctx } = createMockContext();
    let attached1 = false;
    let detachCb1: (() => void) | undefined;
    const { promise: p1, resolve: resolveP1 } = Promise.withResolvers<unknown>();
    const { promise: p2, resolve: resolveP2 } = Promise.withResolvers<unknown>();

    const mockWc1 = {
      id: 505,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      debugger: {
        isAttached: () => attached1,
        attach: () => { attached1 = true; },
        once: (event: string, cb: () => void) => {
          if (event === 'detach') detachCb1 = cb;
        },
        on: () => {},
        removeListener: () => {},
        sendCommand: () => p1,
      },
    } as unknown as Electron.WebContents;

    let attached2 = false;
    const mockWc2 = {
      id: 505, // Same recycled numeric ID
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      debugger: {
        isAttached: () => attached2,
        attach: () => { attached2 = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: () => p2,
      },
    } as unknown as Electron.WebContents;

    ctx.getTabWebContents = () => mockWc1;
    const devTools = new TabDevToolsHost(ctx);

    // Command 1 on wc1 times out
    await assert.rejects(
      devTools.sendCdpCommand(mockWc1, 'Cmd.one', {}, 5),
      /timed out/
    );
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1);

    // wc1 detaches (e.g., navigation or crash), clearing maps for 505
    detachCb1?.();
    assert.strictEqual(devTools.getStats().drainingTargetCount, 0);

    // wc2 is created with the same recycled numeric id (505); Command 2 times out on wc2
    await assert.rejects(
      devTools.sendCdpCommand(mockWc2, 'Cmd.two', {}, 5),
      /timed out/
    );
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1);

    // Now Command 1 on wc1 finally settles late in Chromium
    resolveP1({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Stale resolution of Command 1 must NOT clear Command 2's draining token on recycled id 505
    assert.strictEqual(devTools.getStats().drainingTargetCount, 1, 'Draining count must stay 1 for Cmd.two due to token fencing');

    // Resolving Command 2 clears the draining state because tokens match
    resolveP2({ ok: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(devTools.getStats().drainingTargetCount, 0);
  });

  it('serializes normal in-flight commands when neither times out', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    const calls: string[] = [];
    const { promise: cmd1Promise, resolve: resolveCmd1 } = Promise.withResolvers<unknown>();

    const mockWc = {
      id: 501,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) => {
          calls.push(method);
          return method === 'DOM.getDocument'
            ? cmd1Promise
            : Promise.resolve({ ok: true });
        },
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    // Command 1 is dispatched and in-flight
    const p1 = devTools.sendCdpCommand(mockWc, 'DOM.getDocument', {}, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(calls, ['DOM.getDocument']);

    // Command 2 is enqueued behind Command 1 before Command 1 settles
    const p2 = devTools.sendCdpCommand(mockWc, 'DOM.enable', {}, 100);
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Command 2 must not have started yet
    assert.deepStrictEqual(calls, ['DOM.getDocument']);

    // Command 1 resolves
    resolveCmd1({ root: { nodeId: 1 } });
    await p1;

    // Command 2 executes and resolves
    const r2 = await p2 as { ok: boolean };
    assert.strictEqual(r2.ok, true);
    assert.deepStrictEqual(calls, ['DOM.getDocument', 'DOM.enable']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(devTools.getStats().queuedTargetCount, 0);
  });

  it('advances the queue when underlying command rejects, clearing queue telemetry', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    const calls: string[] = [];

    const mockWc = {
      id: 502,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) => {
          calls.push(method);
          return method === 'Failing.method'
            ? Promise.reject(new Error('CDP target internal error'))
            : Promise.resolve({ ok: true });
        },
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    // Command 1 fails at Chromium debugger level
    await assert.rejects(
      devTools.sendCdpCommand(mockWc, 'Failing.method', {}, 50),
      /CDP target internal error/
    );

    // Command 2 is enqueued and must execute cleanly without deadlock
    const res = await devTools.sendCdpCommand(mockWc, 'DOM.enable', {}, 50) as { ok: boolean };
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(calls, ['Failing.method', 'DOM.enable']);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(devTools.getStats().queuedTargetCount, 0, 'Queue telemetry must be 0 after drain');
  });

  it('12. enriches matched rules from live stylesheet headers and clears provenance on navigation', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    let onMessage: ((event: unknown, method: string, params: Record<string, unknown>) => void) | undefined;
    let onNavigate: (() => void) | undefined;
    let removedMessage: unknown;
    let removedNavigate: unknown;
    let matchedCalls = 0;
    const mockWc: any = {
      id: 501,
      isDestroyed: () => false,
      on: (event: string, callback: () => void) => {
        if (event === 'did-navigate') onNavigate = callback;
      },
      removeListener: (event: string, callback: unknown) => {
        if (event === 'did-navigate') removedNavigate = callback;
      },
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { attached = false; },
        once: () => {},
        on: (event: string, callback: typeof onMessage) => {
          if (event === 'message') onMessage = callback;
        },
        removeListener: (event: string, callback: unknown) => {
          if (event === 'message') removedMessage = callback;
        },
        sendCommand: async (method: string) => {
          if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
          if (method === 'DOM.querySelector') return { nodeId: 2 };
          if (method === 'CSS.getMatchedStylesForNode') {
            matchedCalls++;
            return {
              matchedCSSRules: [{
                rule: {
                  styleSheetId: 'sheet-live',
                  selectorList: { selectors: [{ text: '.card' }] },
                  style: { cssProperties: [{ name: 'color', value: 'red', range: { startLine: 3, startColumn: 1 } }] },
                },
              }],
            };
          }
          return {};
        },
      },
    };
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    await devTools.sendCdpCommand(mockWc, 'CSS.enable');
    assert.ok(onMessage);
    onMessage({}, 'CSS.styleSheetAdded', { header: { styleSheetId: 'sheet-live', sourceURL: 'http://127.0.0.1/assets/card.css' } });
    const enriched = await devTools.getMatchedStylesForNode(mockWc, { selector: '.card' }) as any;
    assert.strictEqual(enriched.matchedCSSRules[0].rule.sourceUrl, 'http://127.0.0.1/assets/card.css');

    assert.ok(onNavigate);
    onNavigate();
    const afterNavigation = await devTools.getMatchedStylesForNode(mockWc, { selector: '.card' }) as any;
    assert.strictEqual(afterNavigation.matchedCSSRules[0].rule.sourceUrl, undefined);
    assert.strictEqual(matchedCalls, 2);

    devTools.dispose();
    assert.strictEqual(removedMessage, onMessage);
    assert.strictEqual(removedNavigate, onNavigate);
  });
});
