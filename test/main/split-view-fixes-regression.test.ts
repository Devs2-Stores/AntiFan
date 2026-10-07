import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FRAME_BACKDROP_CHANNELS } from '../../src/shared/contracts';
import { ELEMENT_PICKER_SCRIPT } from '../../src/main/browser/element-picker';
import { FONT_FINDER_SCRIPT } from '../../src/main/browser/font-finder';
import { TabDevToolsHost, TabDevToolsContext } from '../../src/main/browser/tab-devtools-host';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { createShellDouble } from '../support/project-window-shell-double';

function getRepoRoot(): string {
  let cur = __dirname;
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(path.join(cur, 'package.json')) && fs.existsSync(path.join(cur, 'src'))) {
      return cur;
    }
    cur = path.dirname(cur);
  }
  return path.resolve(__dirname, '../../..');
}

describe('Split View 3 Fixes Regression Suite', () => {
  it('Issue 1: Frame Backdrop CSS and contracts configure #ffffff white screens and reload channel', () => {
    const root = getRepoRoot();
    assert.ok(fs.existsSync(path.join(root, 'package.json')), 'Derived repo root must contain package.json');

    // 1. Verify contracts channel
    assert.strictEqual(FRAME_BACKDROP_CHANNELS.RELOAD_PANE, 'antifan:frame-backdrop:reload-pane');

    // 2. Verify frame-backdrop.css screen-frame backgrounds are white (#ffffff), not black (#000000)
    const cssPath = path.join(root, 'src/renderer/frame-backdrop.css');
    assert.ok(fs.existsSync(cssPath), `CSS file must exist at ${cssPath}`);
    const css = fs.readFileSync(cssPath, 'utf8');

    // Check .laptop-screen-frame
    const laptopMatch = css.match(/\.laptop-screen-frame\s*\{[^}]*\}/);
    assert.ok(laptopMatch, 'laptop-screen-frame rule exists');
    assert.ok(laptopMatch[0].includes('background: #ffffff;'), 'laptop-screen-frame has background #ffffff');

    // Check .phone-screen-frame
    const phoneMatch = css.match(/\.phone-screen-frame\s*\{[^}]*\}/);
    assert.ok(phoneMatch, 'phone-screen-frame rule exists');
    assert.ok(phoneMatch[0].includes('background: #ffffff;'), 'phone-screen-frame has background #ffffff');

    // 3. Verify native-tab-host.ts initializes mobileView with #ffffff
    const hostPath = path.join(root, 'src/main/browser/native-tab-host.ts');
    assert.ok(fs.existsSync(hostPath), `Host file must exist at ${hostPath}`);
    const hostCode = fs.readFileSync(hostPath, 'utf8');
    assert.ok(hostCode.includes("mobileView.setBackgroundColor('#ffffff')"), 'mobileView is initialized with #ffffff');
    assert.ok(hostCode.includes("tab.mobileView?.setBackgroundColor('#ffffff')"), 'mobileView in split review layout uses #ffffff');
    assert.ok(hostCode.includes("FRAME_BACKDROP_CHANNELS.RELOAD_PANE"), 'FRAME_BACKDROP_CHANNELS.RELOAD_PANE is wired in IPC setup');
    assert.ok(hostCode.includes("isMainFrame && errorCode !== -3"), 'did-fail-load checks isMainFrame and ignores ERR_ABORTED (-3)');
  });

  it('Issue 1b: enforceZOrder maintains strict z-stack with already-attached desktop/mobile pair and backdrop', () => {
    const children: any[] = [];
    const mockContentView = {
      children,
      removeChildView: (view: any) => {
        const idx = children.indexOf(view);
        if (idx !== -1) children.splice(idx, 1);
      },
      addChildView: (view: any) => {
        // In Electron, adding a view pushes it to become topmost view
        const existing = children.indexOf(view);
        if (existing !== -1) {
          children.splice(existing, 1);
        }
        children.push(view);
      },
    };

    const host = Object.create(NativeTabHost.prototype) as any;
    const shell = createShellDouble({
      window: {
        isDestroyed: () => false,
        getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
        getContentBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
        contentView: mockContentView,
        on: () => {},
        removeListener: () => {},
      },
    });
    host.shell = shell;
    host.tabs = new Map();
    host.activeTabId = 'tab-1';

    const backdropView = { id: 'backdrop' };
    const desktopView = { id: 'desktop' };
    const mobileView = { id: 'mobile' };
    const sidebarView = { id: 'sidebar' };
    const toolbarView = { id: 'toolbar' };

    shell.frameBackdropView = backdropView as unknown as typeof shell.frameBackdropView;
    shell.sidebarView = sidebarView as unknown as typeof shell.sidebarView;
    shell.toolbarView = toolbarView as unknown as typeof shell.toolbarView;

    host.tabs.set('tab-1', {
      id: 'tab-1',
      view: desktopView,
      mobileView: mobileView,
      state: { splitMode: true },
    });

    // Simulate inverted/already-attached order (e.g. mobile was attached before desktop, or backdrop was on top)
    children.push(toolbarView, mobileView, backdropView, desktopView, sidebarView);

    // Call enforceZOrder
    host.enforceZOrder();

    // Verify resulting order: backdrop < desktop < mobile < sidebar < toolbar
    assert.strictEqual(children[0], backdropView, 'backdrop is bottom-most layer (index 0)');
    assert.strictEqual(children[1], desktopView, 'desktop view is above backdrop (index 1)');
    assert.strictEqual(children[2], mobileView, 'mobile view is above desktop (index 2)');
    assert.strictEqual(children[3], sidebarView, 'sidebar view is above web views (index 3)');
    assert.strictEqual(children[4], toolbarView, 'toolbar view is on top (index 4)');
  });

  it('Issue 2: Font Finder injects and cleans up across both desktop and mobile WebContents in split mode', async () => {
    const desktopScripts: string[] = [];
    const mobileScripts: string[] = [];
    let broadcastCount = 0;

    const mockDesktopWc = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        desktopScripts.push(script);
        return undefined;
      },
    };

    const mockMobileWc = {
      isDestroyed: () => false,
      executeJavaScript: async (script: string) => {
        mobileScripts.push(script);
        return undefined;
      },
    };

    const mockTabRecord = {
      id: 'test-tab-split',
      state: {
        splitMode: true,
      },
      view: {
        webContents: mockDesktopWc,
      },
      mobileView: {
        webContents: mockMobileWc,
      },
    };

    const mockContext: any = {
      getActiveTabId: () => 'test-tab-split',
      getTabRecord: (id: string) => (id === 'test-tab-split' ? (mockTabRecord as any) : undefined),
      getAllTabs: () => new Map([['test-tab-split', mockTabRecord as any]]).entries(),
      getTabTerminalSession: () => undefined,
      broadcastState: () => {
        broadcastCount++;
      },
    };

    const devTools = new TabDevToolsHost(mockContext);

    // 1. Toggle ON: Should inject into BOTH desktop and mobile WebContents
    assert.strictEqual(devTools.getIsFontFinderActive(), false);
    const started = devTools.toggleFontFinder();
    assert.strictEqual(started, true);
    assert.strictEqual(devTools.getIsFontFinderActive(), true);
    assert.strictEqual(broadcastCount, 1);

    // Assert script injection was sent to BOTH desktop and mobile views
    assert.ok(desktopScripts.some(s => s.includes('__antifanFontFinderActive = true')), 'Desktop received Font Finder script');
    assert.ok(mobileScripts.some(s => s.includes('__antifanFontFinderActive = true')), 'Mobile received Font Finder script');

    // 2. Toggle OFF: Should execute cleanup on BOTH desktop and mobile WebContents
    const stopped = devTools.toggleFontFinder();
    assert.strictEqual(stopped, false);
    assert.strictEqual(devTools.getIsFontFinderActive(), false);

    // Assert cleanup was sent to BOTH desktop and mobile views
    assert.ok(desktopScripts.some(s => s.includes('__antifanFontFinderActive = false')), 'Desktop received Font Finder cleanup');
    assert.ok(mobileScripts.some(s => s.includes('__antifanFontFinderActive = false')), 'Mobile received Font Finder cleanup');
  });
  it('Issue 2b: switchTab cleans Font Finder from old tab (both desktop and mobile) before activating new tab', async () => {
    const oldDesktopScripts: string[] = [];
    const oldMobileScripts: string[] = [];
    const newDesktopScripts: string[] = [];

    const oldTab = {
      id: 'tab-old',
      state: { url: 'https://example.com/old', splitMode: true },
      view: { webContents: { isDestroyed: () => false, executeJavaScript: async (s: string) => oldDesktopScripts.push(s) } },
      mobileView: { webContents: { isDestroyed: () => false, executeJavaScript: async (s: string) => oldMobileScripts.push(s) } },
    };

    const newTab = {
      id: 'tab-new',
      state: { url: 'https://example.com/new', splitMode: false },
      view: { webContents: { isDestroyed: () => false, executeJavaScript: async (s: string) => newDesktopScripts.push(s) } },
    };

    const host = Object.create(NativeTabHost.prototype) as any;
    const shell = createShellDouble();
    host.shell = shell;
    host.tabs = new Map([['tab-old', oldTab], ['tab-new', newTab]]);
    host.activeTabId = 'tab-old';
    host.isFontFinderActive = true;
    host.isDisposed = false;
    host.attachTabView = () => {};
    host.updateLayout = () => {};
    host.broadcastState = () => {};
    host.applyTabThrottling = () => {};
    host.resolveTargetTabId = (id: string) => id;

    // Switch from tab-old to tab-new
    const switched = host.switchTab('tab-new');
    assert.strictEqual(switched, true);
    assert.strictEqual(host.activeTabId, 'tab-new');

    // Assert old tab received cleanup on both desktop and mobile
    assert.ok(oldDesktopScripts.some(s => s.includes('__antifanFontFinderActive = false')), 'Old tab desktop received cleanup');
    assert.ok(oldMobileScripts.some(s => s.includes('__antifanFontFinderActive = false')), 'Old tab mobile received cleanup');

    // Assert new tab received Font Finder injection
    assert.ok(newDesktopScripts.some(s => s.includes('__antifanFontFinderActive = true') || s.length > 50), 'New tab desktop received Font Finder script');
  });
  it('Issue 2c: did-finish-load on active tab triggers stopFontFinder and stopLens handlers instead of re-injecting', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const executedScripts: string[] = [];
    let stopFontFinderCalled = 0;
    let stopLensCalled = 0;

    const mockWc = {
      isDestroyed: () => false,
      on: (event: string, fn: (...args: unknown[]) => void) => {
        listeners.set(event, fn);
      },
      getURL: () => 'https://example.com/test',
      session: {
        cookies: {
          flushStore: async () => {},
        },
      },
      executeJavaScript: async (s: string) => {
        executedScripts.push(s);
      },
      invalidate: () => {},
      setWindowOpenHandler: () => {},
    };

    const tab = {
      id: 'tab-1',
      state: { url: 'https://example.com/test', splitMode: false },
      view: { webContents: mockWc },
      redirectChain: [] as string[],
    };

    const host = Object.create(NativeTabHost.prototype) as any;
    host.shell = createShellDouble();
    host.tabs = new Map([['tab-1', tab]]);
    host.activeTabId = 'tab-1';
    host.appliedClipRadius = new Set();
    host.networkTracker = { ensureAttached: async () => {}, resetInflight: () => {} };
    host.applySiteMute = () => {};
    host.injectAutoJsonViewer = () => {};
    host.isTabViewAttached = () => true;
    host.updateLayout = () => {};
    host.stopFontFinder = () => {
      stopFontFinderCalled++;
      host.isFontFinderActive = false;
    };
    host.stopLens = () => {
      stopLensCalled++;
      host.isLensActive = false;
    };

    // 1. When Font Finder is active on active tab, did-finish-load triggers stopFontFinder and does NOT re-inject
    host.isFontFinderActive = true;
    host.isLensActive = false;
    (host as any).setupTabWebContentsEvents('tab-1', tab.view, tab.state, 'desktop');

    const onFinishLoad = listeners.get('did-finish-load');
    assert.ok(typeof onFinishLoad === 'function', 'did-finish-load listener registered');
    onFinishLoad();

    assert.strictEqual(stopFontFinderCalled, 1, 'stopFontFinder called on did-finish-load');
    assert.strictEqual(host.isFontFinderActive, false, 'isFontFinderActive reset to false');
    assert.strictEqual(executedScripts.filter(s => s.includes('__antifanFontFinderActive = true')).length, 0, 'No Font Finder script injected on reload');

    // 2. When GPU Lens is active on active tab, did-finish-load triggers stopLens and does NOT re-inject
    host.isLensActive = true;
    onFinishLoad();
    assert.strictEqual(stopLensCalled, 1, 'stopLens called on did-finish-load');
    assert.strictEqual(host.isLensActive, false, 'isLensActive reset to false');
    assert.strictEqual(executedScripts.filter(s => s.includes('__antifanLensActive = true')).length, 0, 'No GPU Lens script injected on reload');
  });

  it('Issue 3: ELEMENT_PICKER_SCRIPT includes dynamic repositioning, max-height clamping, and resize listeners', () => {
    // 1. Verify script has max-height and overflow constraints on modal style
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('max-height:calc(100vh - 20px)'), 'modal has max-height:calc(100vh - 20px)');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('overflow-y:auto'), 'modal has overflow-y:auto');

    // 2. Verify repositionModal helper exists
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('repositionModal = () =>'), 'repositionModal function is declared and defined');

    // 3. Verify collision logic (flip above and clamp inside viewport bounds)
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('top = r.top - modalH - 6'), 'flips above when space below cannot fit the modal');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('Math.max(12, vpH - modalH - 12)'), 'clamps top within viewport height');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('Math.max(12, vpW - modalW - 12)'), 'clamps left within viewport width');

    // 4. Verify textareaAutoGrow triggers repositionModal
    assert.ok(ELEMENT_PICKER_SCRIPT.includes('repositionModal();\n    };\n    textareaAutoGrow();'), 'textareaAutoGrow invokes repositionModal');

    // 5. Verify window resize listener is added and cleaned up
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("window.addEventListener('resize', repositionModal)"), 'window resize listener is attached');
    assert.ok(ELEMENT_PICKER_SCRIPT.includes("window.removeEventListener('resize', repositionModal)"), 'window resize listener is cleaned up');

    // 6. Verify script is syntactically valid JavaScript
    assert.doesNotThrow(() => {
      new Function(ELEMENT_PICKER_SCRIPT);
    }, 'ELEMENT_PICKER_SCRIPT parses as valid JavaScript without syntax errors');
  });
});
