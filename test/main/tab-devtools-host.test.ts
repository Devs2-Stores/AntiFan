import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import vm from 'node:vm';
import * as zlib from 'node:zlib';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { CaptureError } from '../../src/main/verification/visual-capture';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement } from '../../src/shared/contracts';

/**
 * Structurally complete PNG with real zlib-compressed IDAT data so the
 * canonical capture path's PNG integrity gate and raster/CSS scale gate both
 * see a decodable payload with the requested IHDR dimensions.
 */
function makePng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

interface MockTabRecord {
  state: AntiFanTab;
  focusedPane: SplitPaneId;
  view: {
    webContents: {
      isDestroyed: () => boolean;
      executeJavaScript: (script: string, ...args: unknown[]) => Promise<unknown>;
      capturePage: (rect?: unknown) => Promise<{ isEmpty: () => boolean; toPNG: () => Buffer; toJPEG?: () => Buffer; toDataURL: () => string; getSize: () => { width: number; height: number }; crop: (r: unknown) => unknown }>;
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
      id: 1,
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
        toPNG: () => makePng(1, 1),
        toJPEG: () => makePng(1, 1),
        toDataURL: () => `data:image/png;base64,${makePng(1, 1).toString('base64')}`,
        getSize: () => ({ width: 1, height: 1 }),
        crop: () => ({ isEmpty: () => false, toPNG: () => makePng(1, 1) }),
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

  it('10. captureScreenshot with fullPage: true issues exactly one CDP Page.captureScreenshot with fromSurface true and captureBeyondViewport true', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      const expression =
        params && typeof params === 'object' && 'expression' in params && typeof params.expression === 'string'
          ? params.expression
          : '';
      if (method === 'Runtime.evaluate') {
        if (expression.includes('devicePixelRatio')) {
          return { result: { value: { dpr: 1, vw: 40, vh: 30 } } };
        }
        if (expression.includes('scrollHeight')) {
          return { result: { value: 300 } };
        }
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(40, 300).toString('base64') };
      }
      return {};
    };

    const base64 = await devTools.captureScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true });
    assert.ok(base64.length > 0);

    const pageCaptureCmds = cdpCommands.filter((c) => c.method === 'Page.captureScreenshot');
    assert.strictEqual(pageCaptureCmds.length, 1, 'Canonical full-page capture must issue exactly one Page.captureScreenshot');
    const params = pageCaptureCmds[0]?.params;
    assert.ok(params && typeof params === 'object');
    // fromSurface:true is required for a document-tall clip: live CDP on the
    // windowed Electron runtime returned a 1440x900 renderer view for a
    // 1440x2200 clip with fromSurface:false, while fromSurface:true returned
    // the full 1440x2200 raster.
    assert.strictEqual('fromSurface' in params && params.fromSurface, true, 'Non-viewport captures must rasterize from the compositor surface');
    assert.strictEqual('captureBeyondViewport' in params && params.captureBeyondViewport, true, 'captureBeyondViewport must be true to capture the document');
    const clip = 'clip' in params ? params.clip : undefined;
    assert.deepStrictEqual(clip, { x: 0, y: 0, width: 40, height: 300, scale: 1 });
  });

  it('11. captureScreenshot with fullPage: true derives clip geometry from DOM scrollHeight, not truncated layout metrics', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      const expression =
        params && typeof params === 'object' && 'expression' in params && typeof params.expression === 'string'
          ? params.expression
          : '';
      if (method === 'Page.getLayoutMetrics') {
        return {
          contentSize: { width: 20, height: 10 },
          layoutViewport: { clientWidth: 20, clientHeight: 10 },
        };
      }
      if (method === 'Runtime.evaluate') {
        if (expression.includes('devicePixelRatio')) {
          return { result: { value: { dpr: 1, vw: 20, vh: 10 } } };
        }
        if (expression.includes('scrollHeight')) {
          return { result: { value: 5800 } };
        }
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(20, 5800).toString('base64') };
      }
      return {};
    };

    const base64 = await devTools.captureScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true });
    assert.ok(base64.length > 0);

    // The session layout metrics are read as the geometry-transaction baseline, but they
    // are truncated to the 10px viewport here: a full-page clip that used them would be
    // 10px tall, so the 5800px assertion below is what proves they do not drive it.
    const pageCaptureCmds = cdpCommands.filter((c) => c.method === 'Page.captureScreenshot');
    assert.strictEqual(pageCaptureCmds.length, 1);
    const params = pageCaptureCmds[0]?.params;
    assert.ok(params && typeof params === 'object' && 'clip' in params && params.clip && typeof params.clip === 'object');
    const clip = params.clip;
    assert.strictEqual('width' in clip ? clip.width : undefined, 20);
    assert.strictEqual('height' in clip ? clip.height : undefined, 5800, 'Height must come from DOM scrollHeight 5800, not the truncated 10px viewport');
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
        (err: unknown) => err instanceof CaptureError && err.code === 'TARGET_BUSY_DRAINING' && /TARGET_BUSY_DRAINING/.test(err.message)
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

  it('13. captureVerificationScreenshot on background desktop tab wraps in runWithAttachedTabView with desktop view and isMobile false', async () => {
    const { ctx, tabs } = createMockContext();
    ctx.createTab('https://example.com/bg');
    const tab2 = tabs.get('tab-2')!;

    const attachCalls: Array<{ view: unknown; isMobile?: boolean }> = [];
    ctx.runWithAttachedTabView = async <T>(_view: unknown, action: () => Promise<T>, isMobile?: boolean): Promise<T> => {
      attachCalls.push({ view: _view, isMobile });
      return await action();
    };

    const devTools = new TabDevToolsHost(ctx);
    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 2, vw: 3, vh: 2 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(6, 4).toString('base64') };
      }
      return {};
    };

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-2', 'desktop');
    assert.strictEqual(envelope.backend, 'cdp');
    assert.strictEqual(envelope.dpr, 2);
    assert.strictEqual(envelope.captureMode, 'viewport');
    assert.deepStrictEqual(envelope.cssViewport, { width: 3, height: 2 });
    assert.deepStrictEqual(envelope.cssCaptureSize, { width: 3, height: 2 });
    assert.deepStrictEqual(envelope.rasterSize, { width: 6, height: 4 });

    // Every step that needs pixels — the geometry baseline probe, the pre-capture
    // settle and the raster — attaches the tab view in place, and never the mobile
    // view: the attach is temporary per step, so more than one is expected.
    assert.ok(attachCalls.length >= 1, 'A background capture must attach the target view in place');
    assert.ok(attachCalls.every((c) => c.view === tab2.view), 'Only the tab view may be attached');
    assert.ok(attachCalls.every((c) => c.isMobile === false), 'A desktop capture must not attach as mobile');
    assert.strictEqual(attachCalls[attachCalls.length - 1]?.view, tab2.view);

    const capCmd = cdpCommands.find((c) => c.method === 'Page.captureScreenshot');
    assert.ok(capCmd);
    const params = capCmd.params;
    assert.ok(params && typeof params === 'object');
    // Background desktop tab is wrapped in runWithAttachedTabView: the tab view is
    // attached at viewport bounds, so this is a viewport capture — fromSurface:true
    // (rasterize the attached view's compositor surface) and captureBeyondViewport:false
    // (do not capture pixels beyond the sized viewport). fullPage captures set
    // captureBeyondViewport:true separately. fromSurface is never false: that is
    // Chromium's native-window snapshot path, and an offscreen (OSR) agent tab has no
    // native view, so the path kills the browser process (access violation 0xC0000005).
    assert.strictEqual('fromSurface' in params && params.fromSurface, true);
    assert.strictEqual('captureBeyondViewport' in params && params.captureBeyondViewport, false);
  });

  it('14. captureVerificationScreenshot on background mobile pane wraps in runWithAttachedTabView with mobileView and isMobile true', async () => {
    const { ctx, tabs } = createMockContext();
    ctx.createTab('https://example.com/bg');
    const tab2 = tabs.get('tab-2')!;
    const mockMobileWc = { isDestroyed: () => false };
    tab2.mobileView = { webContents: mockMobileWc, getBounds: () => ({ width: 375, height: 667 }), setBounds: () => {} };
    const origGetWc = ctx.getTabWebContents;
    ctx.getTabWebContents = (tabId, pane) => {
      if (tabId === 'tab-2' && pane === 'mobile') return mockMobileWc as unknown as Electron.WebContents;
      return origGetWc(tabId, pane);
    };

    const attachCalls: Array<{ view: unknown; isMobile?: boolean }> = [];
    ctx.runWithAttachedTabView = async <T>(_view: unknown, action: () => Promise<T>, isMobile?: boolean): Promise<T> => {
      attachCalls.push({ view: _view, isMobile });
      return await action();
    };

    const devTools = new TabDevToolsHost(ctx);
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 3, vw: 2, vh: 3 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(6, 9).toString('base64') };
      }
      return {};
    };

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-2', 'mobile');
    assert.strictEqual(envelope.backend, 'cdp');
    assert.strictEqual(envelope.dpr, 3);
    assert.strictEqual(envelope.captureMode, 'viewport');
    assert.deepStrictEqual(envelope.cssCaptureSize, { width: 2, height: 3 });
    assert.deepStrictEqual(envelope.rasterSize, { width: 6, height: 9 });

    assert.ok(attachCalls.every((c) => c.view === tab2.mobileView), 'A mobile-pane capture must only attach the mobile view');
    assert.ok(attachCalls.some((c) => c.isMobile === true), 'A mobile-pane capture must attach as mobile');
  });

  it('15. captureVerificationScreenshot on foreground tab executes directly without invoking runWithAttachedTabView', async () => {
    const { ctx } = createMockContext();
    let attachCount = 0;
    ctx.runWithAttachedTabView = async <T>(_view: unknown, action: () => Promise<T>): Promise<T> => {
      attachCount++;
      return await action();
    };

    const devTools = new TabDevToolsHost(ctx);
    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 1, vw: 4, vh: 3 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(4, 3).toString('base64') };
      }
      return {};
    };

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop');
    assert.strictEqual(envelope.backend, 'cdp');
    assert.strictEqual(envelope.captureMode, 'viewport');
    assert.deepStrictEqual(envelope.cssCaptureSize, { width: 4, height: 3 });
    assert.deepStrictEqual(envelope.rasterSize, { width: 4, height: 3 });

    assert.strictEqual(attachCount, 0, 'Foreground capture must not attach view');

    const capCmd = cdpCommands.find((c) => c.method === 'Page.captureScreenshot');
    assert.ok(capCmd);
    const params = capCmd.params;
    assert.ok(params && typeof params === 'object');
    // Viewport mode takes the same surface path as document/clip modes: fromSurface:true
    // captures the foreground view's own compositor surface (no beyond-viewport raster).
    // fromSurface:false is never requested — that native-window snapshot path
    // dereferences a null native window for offscreen (OSR) agent tabs and kills the
    // browser process.
    assert.strictEqual('fromSurface' in params && params.fromSurface, true);
    assert.strictEqual('captureBeyondViewport' in params && params.captureBeyondViewport, false);
  });

  it('16. rect wins over fullPage: clip capture carries the requested rect and one captureBeyondViewport call', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      if (method === 'Page.getLayoutMetrics') {
        return { cssLayoutViewport: { clientWidth: 100, clientHeight: 80 } };
      }
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 1, vw: 100, vh: 80 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(30, 20).toString('base64') };
      }
      return {};
    };

    const rect = { x: 10, y: 20, width: 30, height: 20 };
    const envelope = await devTools.captureVerificationScreenshot(rect, 'tab-1', 'desktop', { fullPage: true });

    assert.strictEqual(envelope.captureMode, 'clip');
    assert.deepStrictEqual(envelope.cssCaptureSize, { width: 30, height: 20 });
    assert.deepStrictEqual(envelope.cssViewport, { width: 100, height: 80 });
    assert.deepStrictEqual(envelope.rasterSize, { width: 30, height: 20 });

    const pageCaptureCmds = cdpCommands.filter((c) => c.method === 'Page.captureScreenshot');
    assert.strictEqual(pageCaptureCmds.length, 1, 'Clip capture must issue exactly one Page.captureScreenshot');
    const params = pageCaptureCmds[0]?.params;
    assert.ok(params && typeof params === 'object');
    assert.strictEqual('fromSurface' in params && params.fromSurface, true, 'Clip capture must rasterize from the compositor surface');
    assert.strictEqual('captureBeyondViewport' in params && params.captureBeyondViewport, true);
    const clip = 'clip' in params ? params.clip : undefined;
    assert.deepStrictEqual(clip, { x: 10, y: 20, width: 30, height: 20, scale: 1 });
  });

  it('17. full-page capture on an offscreen target is rejected typed before any CDP capture call', async () => {
    const { ctx, tabs } = createMockContext();
    const tab = tabs.get('tab-1');
    assert.ok(tab);
    tab.state.offscreen = true;

    const devTools = new TabDevToolsHost(ctx);
    const cdpCommands: string[] = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method) => {
      cdpCommands.push(method);
      return {};
    };

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true }),
      (err: unknown) => err instanceof CaptureError && err.code === 'FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN'
    );
    assert.deepStrictEqual(cdpCommands, [], 'Offscreen full-page rejection must not touch CDP');
  });

  it('18. full-page geometry above the 16384 CSS-pixel ceiling is rejected with zero capture calls', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const cdpCommands: string[] = [];
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push(method);
      if (method === 'Runtime.evaluate') {
        const expression =
          params && typeof params === 'object' && 'expression' in params && typeof params.expression === 'string'
            ? params.expression
            : '';
        if (expression.includes('devicePixelRatio')) {
          return { result: { value: { dpr: 1, vw: 1200, vh: 800 } } };
        }
        if (expression.includes('scrollHeight')) {
          return { result: { value: 20000 } };
        }
      }
      return {};
    };

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { fullPage: true }),
      (err: unknown) => err instanceof CaptureError && err.code === 'FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY'
    );
    assert.strictEqual(cdpCommands.includes('Page.captureScreenshot'), false, 'Geometry rejection must happen before any capture');
  });

  it('19. an empty CDP screenshot payload surfaces CAPTURE_EMPTY_PAYLOAD', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 1, vw: 4, vh: 4 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: '' };
      }
      return {};
    };

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop'),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_EMPTY_PAYLOAD'
    );
  });

  it('20. a truncated PNG payload surfaces CAPTURE_PNG_TRUNCATED', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);
    const truncated = makePng(4, 4).subarray(0, 30).toString('base64');
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 1, vw: 4, vh: 4 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: truncated };
      }
      return {};
    };

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop'),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_PNG_TRUNCATED'
    );
  });

  it('21. raster bytes that do not match CSS x DPR x zoom surface CAPTURE_SCALE_MISMATCH', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);
    (devTools as unknown as { sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown> }).sendCdpCommand = async (_wc, method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { dpr: 1, vw: 100, vh: 80 } } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(50, 80).toString('base64') };
      }
      return {};
    };

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop'),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_SCALE_MISMATCH'
    );
  });

  it('22. a CDP capture timeout surfaces CAPTURE_TIMEOUT and quarantines the target as draining', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    const { promise: screenshotPromise, resolve: resolveScreenshot } = Promise.withResolvers<unknown>();
    const mockWc = {
      id: 600,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      executeJavaScript: async () => undefined,
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) =>
          method === 'Page.captureScreenshot'
            ? screenshotPromise
            : Promise.resolve({ result: { value: { dpr: 1, vw: 4, vh: 4 } } }),
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);
    // The native tier has to ANSWER here, or the capture path never reaches the CDP
    // timeout mapping: a viewport capture whose native raster did not answer is given a
    // short probe bound and any CDP failure in that state is reported as a missing
    // render surface (NO_RENDER_SURFACE), which is correct for that case and would mask
    // the mapping this test pins. An answer whose dimensions do not match the measured
    // 4x4 CSS surface keeps the native result unused, so the CDP tier is the failing one.
    const devToolsInternals = devTools as unknown as { captureNativeViewportRaster: () => Promise<{ bytes: Buffer | null; timedOut: boolean }> };
    devToolsInternals.captureNativeViewportRaster = async () => ({ bytes: makePng(8, 8), timedOut: false });

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { timeoutMs: 10 }),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_TIMEOUT'
    );
    assert.strictEqual(devTools.isTargetDraining('tab-1', 'desktop'), true, 'Timed-out capture must quarantine the target');
    assert.strictEqual(devTools.isTargetDraining('tab-1'), true, 'Pane-less probe must resolve the focused pane');

    resolveScreenshot({ data: makePng(4, 4).toString('base64') });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    assert.strictEqual(devTools.isTargetDraining('tab-1', 'desktop'), false, 'Draining clears once the in-flight command settles');
  });

  it('23. drainTarget reports a healthy target drained and resets a poisoned one with a bounded debugger detach', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);

    const healthy = await devTools.drainTarget('tab-1', 'desktop', 50);
    assert.strictEqual(healthy.ok, true);
    assert.strictEqual(healthy.drained, true);
    assert.strictEqual(healthy.resetPerformed, false);
    assert.ok(healthy.elapsedMs >= 0);

    let attached = false;
    let detachCount = 0;
    const { promise: screenshotPromise } = Promise.withResolvers<unknown>();
    const poisonedWc = {
      id: 601,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      executeJavaScript: async () => undefined,
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        detach: () => { detachCount++; attached = false; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) =>
          method === 'Page.captureScreenshot' ? screenshotPromise : Promise.resolve({ result: { value: { dpr: 1, vw: 4, vh: 4 } } }),
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => poisonedWc;

    await assert.rejects(devTools.sendCdpCommand(poisonedWc, 'Page.captureScreenshot', {}, 5), /timed out/);
    assert.strictEqual(devTools.isTargetDraining('tab-1', 'desktop'), true);

    const recovered = await devTools.drainTarget('tab-1', 'desktop', 50);
    assert.strictEqual(recovered.ok, true);
    assert.strictEqual(recovered.drained, true);
    assert.strictEqual(recovered.resetPerformed, true, 'A poisoned queue must be reset by a bounded debugger detach');
    assert.strictEqual(detachCount, 1);
    assert.strictEqual(devTools.isTargetDraining('tab-1', 'desktop'), false);

    const afterRecovery = await devTools.sendCdpCommand(poisonedWc, 'DOM.enable', {}, 50);
    assert.deepStrictEqual(afterRecovery, { result: { value: { dpr: 1, vw: 4, vh: 4 } } });
  });

  it('24. getDom, evalJs and evalJsInFrame all reject TARGET_STALE on a dead target', async () => {
    const { ctx, tabs, mockWc } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);
    const isStale = (err: unknown) => err instanceof Error && 'code' in err && err.code === 'TARGET_STALE';

    // Missing tab record: all three paths agree on the typed refusal.
    await assert.rejects(devTools.getDom(undefined, 'tab-missing'), isStale);
    await assert.rejects(devTools.evalJs('1 + 1', 'tab-missing'), isStale);
    await assert.rejects(devTools.evalJsInFrame('1 + 1', 'frame', 'tab-missing'), isStale);

    // Live record whose WebContents is gone: same contract, never '' or undefined.
    const deadWc = { ...mockWc, isDestroyed: () => true };
    tabs.set('tab-dead', {
      state: {
        id: 'tab-dead',
        url: 'about:blank',
        title: 'Dead',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        crashed: false,
        zoomFactor: 1,
        devicePresetId: 'responsive',
      },
      focusedPane: 'desktop',
      view: { webContents: deadWc },
    });
    ctx.getTabWebContents = (tabId) => (tabId === 'tab-dead' ? deadWc : mockWc) as unknown as Electron.WebContents;

    await assert.rejects(devTools.getDom(undefined, 'tab-dead'), isStale);
    await assert.rejects(devTools.evalJs('1 + 1', 'tab-dead'), isStale);
    await assert.rejects(devTools.evalJsInFrame('1 + 1', 'frame', 'tab-dead'), isStale);

    // A live target still answers: the contract only refuses dead targets.
    const dom = await devTools.getDom(undefined, 'tab-1');
    assert.strictEqual(dom, '<html><body><h1>Hello Test</h1></body></html>');
  });

  it('25. a hung CDP viewport raster reports CAPTURE_TIMEOUT, not NO_RENDER_SURFACE', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    let capturePageCalls = 0;
    const { promise: screenshotPromise, resolve: resolveScreenshot } = Promise.withResolvers<unknown>();
    const mockWc = {
      id: 700,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      executeJavaScript: async () => undefined,
      capturePage: () => {
        capturePageCalls += 1;
        throw new Error('capturePage must not run on verification capture');
      },
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) =>
          method === 'Page.captureScreenshot'
            ? screenshotPromise
            : Promise.resolve({ result: { value: { dpr: 1, vw: 4, vh: 4 } } }),
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { timeoutMs: 10 }),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_TIMEOUT'
    );
    assert.strictEqual(capturePageCalls, 0, 'Verification capture must not start uncancelable capturePage');

    resolveScreenshot({ data: makePng(4, 4).toString('base64') });
    await Promise.resolve();
  });

  it('26. a second native raster request shares the in-flight capture instead of stacking another capturePage', async () => {
    const { ctx } = createMockContext();
    let capturePageCalls = 0;
    const { promise: rasterPromise, resolve: resolveRaster } = Promise.withResolvers<unknown>();
    const mockWc = {
      id: 701,
      isDestroyed: () => false,
      capturePage: () => {
        capturePageCalls += 1;
        return rasterPromise;
      },
    } as unknown as Electron.WebContents;
    const devTools = new TabDevToolsHost(ctx);
    const internals = devTools as unknown as {
      captureNativeViewportRaster: (wc: Electron.WebContents, format: 'png' | 'jpeg', quality?: number, boundMs?: number) => Promise<{ bytes: Buffer | null; timedOut: boolean }>;
    };

    const first = internals.captureNativeViewportRaster(mockWc, 'png', undefined, 5);
    const second = internals.captureNativeViewportRaster(mockWc, 'png', undefined, 5);
    const [firstRes, secondRes] = await Promise.all([first, second]);
    assert.strictEqual(firstRes.timedOut, true);
    assert.strictEqual(secondRes.timedOut, true);
    assert.strictEqual(capturePageCalls, 1, 'A wedged raster must not accumulate a second capturePage');

    // Once the raster settles, the shared promise is released and a later call
    // captures fresh — the map never pins a stale entry.
    resolveRaster({ isEmpty: () => false, toPNG: () => makePng(4, 4) });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const third = await internals.captureNativeViewportRaster(mockWc, 'png', undefined, 50);
    assert.strictEqual(third.timedOut, false);
    assert.strictEqual(capturePageCalls, 2);
    assert.ok(third.bytes && third.bytes.length > 0);
  });

  it('27. a background capture restores geometry against the surface it measured, never a detached pre-attach 0x0', async () => {
    const { ctx, tabs } = createMockContext();
    ctx.createTab('https://example.com/bg');
    const tab2 = tabs.get('tab-2')!;

    // The window presents the target's view only for the duration of the
    // attach-for-capture helper, and a view nobody presents has no compositor
    // surface: the probe reports 0x0 for it, exactly as the live renderer does.
    // The helper refcounts (a nested attach — the settle evaluation — keeps the
    // view presented), so the mock counts depth the same way.
    let presented = false;
    let attachDepth = 0;
    ctx.runWithAttachedTabView = async <T>(_view: unknown, action: () => Promise<T>): Promise<T> => {
      attachDepth += 1;
      presented = true;
      try {
        return await action();
      } finally {
        attachDepth -= 1;
        presented = attachDepth > 0;
      }
    };

    const devTools = new TabDevToolsHost(ctx);
    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    // Named handle for the private transport seam, the way cases 22-25 stub internals.
    const devToolsInternals = devTools as unknown as {
      sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown>;
    };
    devToolsInternals.sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      const expression =
        params && typeof params === 'object' && 'expression' in params && typeof params.expression === 'string'
          ? params.expression
          : '';
      if (method === 'Runtime.evaluate') {
        if (expression.includes('devicePixelRatio')) {
          return {
            result: {
              value: presented
                ? { dpr: 2, vw: 4, vh: 3, readyState: 'complete' }
                : { dpr: 2, vw: 0, vh: 0, readyState: 'complete' },
            },
          };
        }
        return { result: { value: undefined } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(8, 6).toString('base64') };
      }
      return {};
    };

    // Never-attached background target: must capture, and must not fail on a restore
    // it could not have proven (CAPTURE_VIEWPORT_NOT_RESTORED) nor report one that
    // never happened.
    const envelope = await devTools.captureVerificationScreenshot({ x: 0, y: 0, width: 4, height: 3 }, 'tab-2', 'desktop');
    assert.strictEqual(envelope.backend, 'cdp');
    assert.strictEqual(envelope.captureMode, 'clip');
    assert.strictEqual(envelope.dpr, 2);
    assert.deepStrictEqual(envelope.rasterSize, { width: 8, height: 6 });

    // Both readings belong to the presented surface the capture measured (4x3 at dpr
    // 2); a detached 0x0 pair is not a measurement and can never read as restored.
    const transaction = envelope.viewportTransaction;
    assert.ok(transaction, 'A clip capture must report the geometry transaction it ran');
    assert.deepStrictEqual(transaction.before, { width: 4, height: 3, scrollX: 0, scrollY: 0 });
    assert.deepStrictEqual(transaction.after, { width: 4, height: 3, scrollX: 0, scrollY: 0 });
    assert.strictEqual(transaction.restored, true);

    // The post-drain recovery path hands over whatever baseline it had, and a capture
    // that could not measure one arrives as an empty geometry, never a size. Restoring
    // against that would clamp it into a fabricated device-metrics override.
    const commandsBefore = cdpCommands.length;
    const refused = await devTools.reapplyTabGeometry('tab-2', 'desktop', { width: Number.NaN, height: Number.NaN, scrollX: 0, scrollY: 0 });
    assert.strictEqual(refused.restored, false);
    assert.strictEqual(refused.attempts, 0);
    assert.strictEqual(refused.before, null);
    assert.strictEqual(refused.after, null);
    assert.strictEqual(
      cdpCommands.slice(commandsBefore).some((c) => c.method === 'Emulation.setDeviceMetricsOverride'),
      false,
      'An unmeasured baseline must never become a fabricated device-metrics override'
    );
  });

  it('28. a geometry-moving capture that cannot measure a baseline skips the restore instead of inventing one', async () => {
    const { ctx } = createMockContext();
    ctx.createTab('https://example.com/no-layout');
    const devTools = new TabDevToolsHost(ctx);
    const cdpCommands: Array<{ method: string; params?: unknown }> = [];
    const devToolsInternals = devTools as unknown as {
      sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown>;
    };
    // A target with no layout viewport of its own: every reading reports 0x0, so no
    // capture of it can ever establish the baseline a restore would be compared against.
    devToolsInternals.sendCdpCommand = async (_wc, method, params) => {
      cdpCommands.push({ method, params });
      const expression =
        params && typeof params === 'object' && 'expression' in params && typeof params.expression === 'string'
          ? params.expression
          : '';
      if (method === 'Runtime.evaluate' && expression.includes('devicePixelRatio')) {
        return { result: { value: { dpr: 1, vw: 0, vh: 0, readyState: 'complete' } } };
      }
      return {};
    };

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-2', 'desktop', { fullPage: true }),
      (err: unknown) => err instanceof CaptureError && err.code === 'NO_RENDER_SURFACE'
    );

    // Full-page moves the layout viewport, so a measured baseline would have been
    // restored here; with nothing measured there is nothing to restore against, and
    // writing replacement geometry from a 0x0 pair is the invented 1x1 viewport.
    const geometryWrites = cdpCommands.filter(
      (c) => c.method === 'Emulation.clearDeviceMetricsOverride' || c.method === 'Emulation.setDeviceMetricsOverride'
    );
    assert.deepStrictEqual(geometryWrites, [], 'A capture that never measured a surface must not write replacement geometry for it');
  });

  it('29. a target whose view is outside the window fails fast with NO_RENDER_SURFACE and never waits on the compositor', async () => {
    const { ctx } = createMockContext();
    ctx.createTab('https://example.com/detached');
    const devTools = new TabDevToolsHost(ctx);
    const commands: string[] = [];
    let rasterCalls = 0;
    const internals = devTools as unknown as {
      sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown>;
      captureNativeViewportRaster: () => Promise<{ bytes: Buffer | null; timedOut: boolean }>;
    };
    internals.sendCdpCommand = async (_wc, method, params) => {
      commands.push(method);
      // A laid-out surface the probe can read: the only reason this target cannot be
      // captured is that its view is outside the window, so the refusal under test is
      // the attachment one and not the pre-existing 0x0 gate.
      if (method === 'Runtime.evaluate') {
        const expression = params && typeof params === 'object' && 'expression' in params ? String((params as { expression?: unknown }).expression) : '';
        if (expression.includes('devicePixelRatio')) {
          return { result: { value: { dpr: 1, vw: 4, vh: 3, readyState: 'complete' } } };
        }
        return { result: { value: undefined } };
      }
      return {};
    };
    // A view outside the window has no compositor surface: its raster never settles.
    // Reaching that tier is the defect — the wait it costs is what the bound pays for.
    internals.captureNativeViewportRaster = async () => {
      rasterCalls += 1;
      return { bytes: null, timedOut: true };
    };
    // Ground truth: the target's view is not in the window, and the target is not the
    // presented tab, so there is no presented view to re-assert for it.
    ctx.isTabViewAttached = () => false;
    ctx.getActiveTabId = () => 'tab-1';

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-2', 'desktop', { timeoutMs: 10 }),
      (err: unknown) => err instanceof CaptureError && err.code === 'NO_RENDER_SURFACE'
    );
    assert.strictEqual(rasterCalls, 0, 'A view outside the window must be refused before the native raster tier');
    assert.strictEqual(
      commands.includes('Page.captureScreenshot'),
      false,
      'A target with no surface must never reach the CDP capture that waits out its bound'
    );
  });

  it('30. a presented tab whose view fell out of the window is re-asserted before the capture waits on it', async () => {
    const { ctx } = createMockContext();
    const devTools = new TabDevToolsHost(ctx);
    let attached = false;
    let reasserts = 0;
    let rasterCalls = 0;
    const internals = devTools as unknown as {
      sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown>;
      captureNativeViewportRaster: () => Promise<{ bytes: Buffer | null; timedOut: boolean }>;
    };
    internals.sendCdpCommand = async (_wc, method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = params && typeof params === 'object' && 'expression' in params ? String((params as { expression?: unknown }).expression) : '';
        if (expression.includes('devicePixelRatio')) {
          return { result: { value: { dpr: 1, vw: 4, vh: 3, readyState: 'complete' } } };
        }
        return { result: { value: undefined } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(4, 3).toString('base64') };
      }
      return {};
    };
    internals.captureNativeViewportRaster = async () => {
      rasterCalls += 1;
      return { bytes: makePng(4, 3), timedOut: false };
    };
    ctx.isTabViewAttached = () => attached;
    ctx.reassertPresentedView = () => {
      reasserts += 1;
      attached = true;
    };

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { timeoutMs: 500 });

    assert.strictEqual(reasserts, 1, 'The presented tab is the one whose view the window owns, so its missing view is repaired, not refused');
    assert.strictEqual(rasterCalls, 0, 'Verification capture must not start capturePage');
    assert.strictEqual(envelope.backend, 'cdp');
    assert.ok(envelope.data.length > 0);
  });

  it('31. an attach-for-capture target is never refused: the wrapper presents the view before the guard reads it', async () => {
    const { ctx } = createMockContext();
    ctx.createTab('https://example.com/bg');
    const devTools = new TabDevToolsHost(ctx);
    let wrapperRuns = 0;
    let attachDepth = 0;
    ctx.isTabViewAttached = () => attachDepth > 0;
    // The temporary attach is what gives a background view a surface at all, so the
    // guard has to read attachment inside it — reading it outside would refuse every
    // background capture. The helper refcounts (inner reads attach the same view), so
    // the mock counts depth the same way.
    ctx.runWithAttachedTabView = async <T>(_view: unknown, action: () => Promise<T>): Promise<T> => {
      wrapperRuns += 1;
      attachDepth += 1;
      try {
        return await action();
      } finally {
        attachDepth -= 1;
      }
    };
    const internals = devTools as unknown as {
      sendCdpCommand: (wc: unknown, method: string, params?: unknown) => Promise<unknown>;
      captureNativeViewportRaster: () => Promise<{ bytes: Buffer | null; timedOut: boolean }>;
    };
    let rasterCalls = 0;
    internals.sendCdpCommand = async (_wc, method, params) => {
      if (method === 'Runtime.evaluate') {
        const expression = params && typeof params === 'object' && 'expression' in params ? String((params as { expression?: unknown }).expression) : '';
        if (expression.includes('devicePixelRatio')) {
          return { result: { value: { dpr: 1, vw: 4, vh: 3, readyState: 'complete' } } };
        }
        return { result: { value: undefined } };
      }
      if (method === 'Page.captureScreenshot') {
        return { data: makePng(4, 3).toString('base64') };
      }
      return {};
    };
    internals.captureNativeViewportRaster = async () => {
      rasterCalls += 1;
      return { bytes: makePng(4, 3), timedOut: false };
    };

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-2', 'desktop', { timeoutMs: 500 });

    assert.ok(wrapperRuns >= 1, 'A background target is captured through the attach-for-capture helper');
    assert.strictEqual(rasterCalls, 0, 'Background attach-for-capture must not start capturePage');
    assert.strictEqual(envelope.backend, 'cdp');
    assert.ok(envelope.data.length > 0);
  });

  it('32. verification capture does not start capturePage when CDP hangs', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    let capturePageCalls = 0;
    let cdpCaptureCalls = 0;
    const { promise: screenshotPromise, resolve: resolveScreenshot } = Promise.withResolvers<unknown>();
    const mockWc = {
      id: 800,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      executeJavaScript: async () => undefined,
      capturePage: () => {
        capturePageCalls += 1;
        throw new Error('capturePage must not run on verification capture');
      },
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) => {
          if (method === 'Page.captureScreenshot') {
            cdpCaptureCalls += 1;
            return screenshotPromise;
          }
          return Promise.resolve({ result: { value: { dpr: 1, vw: 4, vh: 4 } } });
        },
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    await assert.rejects(
      () => devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { timeoutMs: 20 }),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_TIMEOUT'
    );
    assert.strictEqual(capturePageCalls, 0, 'Verification capture must not start uncancelable capturePage');
    assert.ok(cdpCaptureCalls >= 1, 'Hung compositor is observed on the CDP path');

    resolveScreenshot({ data: makePng(4, 4).toString('base64') });
    await Promise.resolve();
  });

  it('33. verification capture uses CDP even if native raster would hang', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    let nativeCalls = 0;
    let cdpCaptureCalls = 0;
    const mockWc = {
      id: 801,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      executeJavaScript: async () => undefined,
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) => {
          if (method === 'Page.captureScreenshot') {
            cdpCaptureCalls += 1;
            return Promise.resolve({ data: makePng(4, 4).toString('base64') });
          }
          return Promise.resolve({ result: { value: { dpr: 1, vw: 4, vh: 4 } } });
        },
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);
    const internals = devTools as unknown as {
      captureNativeViewportRaster: () => Promise<{ bytes: Buffer | null; timedOut: boolean }>;
    };
    internals.captureNativeViewportRaster = async () => {
      nativeCalls += 1;
      return { bytes: null, timedOut: true };
    };

    const envelope = await devTools.captureVerificationScreenshot(undefined, 'tab-1', 'desktop', { timeoutMs: 50 });
    assert.strictEqual(nativeCalls, 0, 'Verification capture must not enter the native raster path');
    assert.ok(cdpCaptureCalls >= 1);
    assert.strictEqual(envelope.backend, 'cdp');
    assert.ok(envelope.data.length > 0);
  });

  it('34. viewport captureScreenshot must not stack a second capturePage after a hung raster', async () => {
    const { ctx } = createMockContext();
    let attached = false;
    let capturePageCalls = 0;
    let reasserts = 0;
    ctx.reassertPresentedView = () => { reasserts += 1; };
    const hung = new Promise<never>(() => {});
    const mockWc = {
      id: 901,
      isDestroyed: () => false,
      on: () => {},
      removeListener: () => {},
      executeJavaScript: async () => undefined,
      capturePage: () => {
        capturePageCalls += 1;
        return hung;
      },
      debugger: {
        isAttached: () => attached,
        attach: () => { attached = true; },
        once: () => {},
        on: () => {},
        removeListener: () => {},
        sendCommand: (method: string) => {
          if (method === 'Page.captureScreenshot') {
            return Promise.reject(new Error('CDP command Page.captureScreenshot timed out after 4000ms'));
          }
          return Promise.resolve({});
        },
      },
    } as unknown as Electron.WebContents;
    ctx.getTabWebContents = () => mockWc;
    const devTools = new TabDevToolsHost(ctx);

    await assert.rejects(
      () => devTools.captureScreenshot(undefined, 'tab-1', 'desktop'),
      (err: unknown) => err instanceof CaptureError && err.code === 'CAPTURE_TIMEOUT'
    );
    assert.strictEqual(capturePageCalls, 1, 'a hung capturePage must be shared, never raced-and-retried');
    assert.ok(reasserts >= 1, 'a timed-out viewport capture must reassert the presented view');
  });

});
