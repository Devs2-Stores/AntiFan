import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost, NativeTabRecord } from '../../src/main/browser/native-tab-host';
import { parseBenchmarkLine } from '../../src/main/benchmark/telemetry';
import { AntiFanTab } from '../../src/shared/contracts';


/**
 * Every tab transaction - a switch, a close, a refused activation, the release of an
 * attach-for-capture - has to leave the window presenting something. The window has
 * exactly one pane that shows a tab, so a transaction that takes the presented view out
 * and then returns without putting it back leaves a blank window until the user happens
 * to activate that tab again. These tests pin that invariant at the two points where it
 * used to break: a refused activation on a window that is already empty, and a switch
 * running while a capture holds another tab's view on screen.
 */

// The host journals presentation changes into the runtime the live app writes to. A unit
// run must not append to the user's journal, so the journal is redirected to a temp root
// before the first event is recorded (the journal resolves its path on first write).
const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'antifan-tabhost-runtime-'));
process.env.ANTIFAN_RUNTIME_DIR = RUNTIME_DIR;

// Deliberately not the 1440x900 the background viewport path is known to invent, so a box
// derived from this window can never be mistaken for a fabricated default.
const WINDOW_CONTENT_BOX = { x: 0, y: 0, width: 1280, height: 800 };
const TOOLBAR_HEIGHT = 90;
const SIDEBAR_WIDTH = 380;

interface PaneBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RecordedTab {
  tab: NativeTabRecord;
  setBoundsCalls: PaneBounds[];
  currentBounds: () => PaneBounds;
  invalidateCalls: number;
}

interface PresentedHost {
  host: any;
  children: unknown[];
  emulationCalls: Array<{ tabId: string; availableWidth: number; availableHeight: number; toolbarHeight: number }>;
}

function createTestTab(id: string, overrides: Partial<AntiFanTab> = {}): RecordedTab {
  const state: AntiFanTab = {
    id,
    url: 'https://store.example.com',
    title: 'Store',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1.0,
    ...overrides,
  };

  const bounds: PaneBounds = { x: 0, y: 0, width: 0, height: 0 };
  const setBoundsCalls: PaneBounds[] = [];
  const recorder = { invalidateCalls: 0 };

  const webContents = {
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => state.url,
    setZoomFactor: (_factor: number) => {},
    insertCSS: async (_css: string) => '',
    invalidate: () => {
      recorder.invalidateCalls += 1;
    },
    focus: () => {},
    setBackgroundThrottling: (_enabled: boolean) => {},
    executeJavaScript: async (_script: string) => undefined,
    loadURL: async (_url: string) => undefined,
  };

  const view = {
    webContents,
    setBounds: (rect: PaneBounds) => {
      setBoundsCalls.push({ ...rect });
      Object.assign(bounds, rect);
    },
    getBounds: () => ({ ...bounds }),
    setBackgroundColor: (_color: string) => {},
  };

  const tab = { state, view } as unknown as NativeTabRecord;
  return {
    tab,
    setBoundsCalls,
    currentBounds: () => ({ ...bounds }),
    get invalidateCalls() {
      return recorder.invalidateCalls;
    },
  };
}

function createPresentedHost(params: { tabs: RecordedTab[]; activeTabId: string; attached: unknown[] }): PresentedHost {
  const children: unknown[] = [...params.attached];
  const host: any = Object.create(NativeTabHost.prototype);
  host.isDisposed = false;
  host.tabs = new Map(params.tabs.map((recorded) => [recorded.tab.state.id, recorded.tab]));
  host.activeTabId = params.activeTabId;
  host.defaultUserAgent = 'MockDesktopUA';
  host.isSidebarOpen = false;
  host.sidebarWidth = SIDEBAR_WIDTH;
  host.temporaryViewAttachCounts = new WeakMap();
  host.tabByWebContents = new WeakMap(
    params.tabs.map((recorded) => [recorded.tab.view.webContents, { tabId: recorded.tab.state.id, tab: recorded.tab }])
  );
  host.window = {
    isDestroyed: () => false,
    getContentBounds: () => ({ ...WINDOW_CONTENT_BOX }),
    contentView: {
      children,
      addChildView: (view: unknown, index?: number) => {
        const at = typeof index === 'number' ? Math.max(0, Math.min(index, children.length)) : children.length;
        children.splice(at, 0, view);
      },
      removeChildView: (view: unknown) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      },
    },
  };
  host.getToolbarHeight = () => TOOLBAR_HEIGHT;
  // Device emulation is the layout path activation uses - it is what sizes the pane's
  // view for the window. The box arithmetic itself is covered by the pane-layout suite;
  // what matters here is that a re-attached view is handed to it at all.
  const emulationCalls: Array<{ tabId: string; availableWidth: number; availableHeight: number; toolbarHeight: number }> = [];
  host.applyTabDeviceEmulation = (tab: NativeTabRecord, availableWidth: number, availableHeight: number, toolbarHeight: number) => {
    emulationCalls.push({ tabId: tab.state.id, availableWidth, availableHeight, toolbarHeight });
  };
  host.updateLayout = () => {};
  host.broadcastState = () => {};
  host.applyTabThrottling = () => {};
  host.setSafeUserAgent = () => {};
  host.setupTabWebContentsEvents = () => {};
  host.destroyOwnedWebContents = () => {};
  host.schedulePersist = () => {};
  return { host, children, emulationCalls };
}

describe('Presented view invariant', () => {
  it('refusing to present an agent-plane tab re-attaches the presented view instead of leaving the window empty', () => {
    const presented = createTestTab('tab-visible');
    const agentTab = createTestTab('tab-agent', { offscreen: true });
    // The window is already empty: the state an earlier transaction in this codebase
    // used to leave behind, and the one the refusal path has to be able to recover from.
    const { host, children, emulationCalls } = createPresentedHost({
      tabs: [presented, agentTab],
      activeTabId: 'tab-visible',
      attached: [],
    });

    assert.strictEqual(host.switchTab('tab-agent'), false, 'an offscreen tab must never be presented');
    assert.deepStrictEqual(children, [presented.tab.view], 'the presented tab must be back on screen after the refusal');
    assert.deepStrictEqual(
      emulationCalls,
      [{ tabId: 'tab-visible', availableWidth: WINDOW_CONTENT_BOX.width, availableHeight: WINDOW_CONTENT_BOX.height - TOOLBAR_HEIGHT, toolbarHeight: TOOLBAR_HEIGHT }],
      'a view returning to a window it never had a surface in must be sized for that window'
    );
    assert.strictEqual(presented.invalidateCalls, 1, 'the view must be repainted once it is back in the window');
    const journal = fs.readFileSync(path.join(RUNTIME_DIR, 'logs', 'main.log'), 'utf8');
    assert.ok(
      journal.includes('"event":"tabhost.presentedViewReattached"') && journal.includes('"tabId":"tab-visible"'),
      'the re-attach must be recorded in the runtime the host resolved, not appended to the live app journal'
    );
  });

  it('a switch made while a capture holds another tab keeps that tab on screen and leaves the window as it found it', async () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    let attachedDuringSwitch = false;
    await host.runWithAttachedTabView(background.tab.view, async () => {
      assert.strictEqual(host.isTabViewAttached(background.tab.view), true, 'the helper must put the pane on screen before the action runs');
      host.switchTab('tab-visible');
      attachedDuringSwitch = host.isTabViewAttached(background.tab.view);
    });

    assert.strictEqual(attachedDuringSwitch, true, 'the detach sweep must not take away a view an in-flight capture is holding');
    assert.deepStrictEqual(children, [presented.tab.view], 'releasing the capture must hand the window back to the presented tab only');
  });

  it('raiseViewForCapture lifts a background view above the user tab without switching it', async () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    await host.runWithAttachedTabView(background.tab.view, async () => {
      const buriedPresented = children.indexOf(presented.tab.view);
      const buriedBackground = children.indexOf(background.tab.view);
      assert.ok(buriedPresented > buriedBackground && buriedBackground >= 0, 'the attach helper keeps the capture view occluded');

      host.raiseViewForCapture(background.tab.view);
      const raisedPresented = children.indexOf(presented.tab.view);
      const raisedBackground = children.indexOf(background.tab.view);
      assert.ok(raisedBackground > raisedPresented && raisedPresented >= 0, 'raiseViewForCapture must sit the capture view above the user tab');
      assert.strictEqual(host.activeTabId, 'tab-visible', 'raise must not switch the visible tab');

      host.reassertPresentedView();
      const restoredPresented = children.indexOf(presented.tab.view);
      const restoredBackground = children.indexOf(background.tab.view);
      assert.ok(restoredPresented > restoredBackground && restoredBackground >= 0, 'reassertPresentedView must put the user tab back on top while capture still holds the view');
    });

    assert.deepStrictEqual(children, [presented.tab.view], 'releasing the capture must hand the window back to the presented tab only');
  });

  it('reassert on an already-attached pane recycles the compositor layer without a getBounds kick', () => {
    const presented = createTestTab('tab-visible');
    const { host, children } = createPresentedHost({
      tabs: [presented],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });
    const laidOut = {
      x: 0,
      y: TOOLBAR_HEIGHT,
      width: WINDOW_CONTENT_BOX.width,
      height: WINDOW_CONTENT_BOX.height - TOOLBAR_HEIGHT,
    };
    presented.tab.view.setBounds(laidOut);
    const boundsBeforeRecycle = presented.setBoundsCalls.length;
    let removes = 0;
    let adds = 0;
    const origRemove = host.window.contentView.removeChildView.bind(host.window.contentView);
    const origAdd = host.window.contentView.addChildView.bind(host.window.contentView);
    host.window.contentView.removeChildView = (view: unknown) => {
      removes += 1;
      origRemove(view);
    };
    host.window.contentView.addChildView = (view: unknown, index?: number) => {
      adds += 1;
      origAdd(view, index);
    };

    host.reassertPresentedView();

    assert.deepStrictEqual(children, [presented.tab.view], 'an already-presented view must stay the only child');
    assert.ok(removes >= 1 && adds >= 1, 'the dead DirectComposition visual is dropped and the view is re-inserted');
    assert.deepStrictEqual(
      presented.setBoundsCalls.slice(boundsBeforeRecycle),
      [],
      'must not pin getBounds() — that 1px round-trip destroyed the surface (black pane, backdrop showing through)'
    );
    assert.strictEqual(presented.currentBounds().width, laidOut.width, 'recycle must not mutate the already-laid-out width');
    assert.ok(presented.invalidateCalls >= 1, 'the view must still be invalidated after the recycle');
  });

  it('a leaked attach-for-capture count must not skip recycling the presented compositor layer', async () => {
    const presented = createTestTab('tab-visible');
    const { host, children } = createPresentedHost({
      tabs: [presented],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });
    let removes = 0;
    let adds = 0;
    const origRemove = host.window.contentView.removeChildView.bind(host.window.contentView);
    const origAdd = host.window.contentView.addChildView.bind(host.window.contentView);
    host.window.contentView.removeChildView = (view: unknown) => {
      removes += 1;
      origRemove(view);
    };
    host.window.contentView.addChildView = (view: unknown, index?: number) => {
      adds += 1;
      origAdd(view, index);
    };

    await host.runWithAttachedTabView(presented.tab.view, async () => {
      host.reassertPresentedView();
    });

    assert.deepStrictEqual(children, [presented.tab.view], 'the presented view must remain the only child');
    assert.ok(removes >= 1 && adds >= 1, 'leaked temp-attach must not skip DirectComposition recycle');
  });

  it('a benchmark-enabled switch emits one switch-steps row naming every timed step', () => {

    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    const prev = process.env.ANTIFAN_BENCHMARK;
    process.env.ANTIFAN_BENCHMARK = '1';
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[antifan-benchmark]')) captured.push(line);
    };
    try {
      assert.strictEqual(host.switchTab('tab-bg'), true, 'a live background tab must switch');
    } finally {
      console.log = origLog;
      if (prev === undefined) delete process.env.ANTIFAN_BENCHMARK;
      else process.env.ANTIFAN_BENCHMARK = prev;
    }

    const rows = captured.map((line) => parseBenchmarkLine(line)).filter((row): row is NonNullable<typeof row> => row !== null);
    const steps = rows.find((row) => row.surface === 'tabs' && row.name === 'switch-steps');
    assert.ok(steps, 'a benchmark-enabled switch must emit a switch-steps row');
    assert.ok(Number.isFinite(steps.value), 'the row value is the switch total in ms');
    for (const key of ['ensureView', 'attachSweep', 'layoutBroadcast', 'throttle', 'invalidateFocus', 'presentedView']) {
      assert.ok(Number.isFinite(Number(steps.extra?.[key])), `step ${key} must be a finite ms reading`);
    }
  });

  it('a production switch allocates no switch-steps row', () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });
    delete process.env.ANTIFAN_BENCHMARK;
    const captured: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[antifan-benchmark]')) captured.push(line);
    };
    try {
      assert.strictEqual(host.switchTab('tab-bg'), true);
    } finally {
      console.log = origLog;
    }
    const rows = captured.map((line) => parseBenchmarkLine(line)).filter((row): row is NonNullable<typeof row> => row !== null);
    assert.strictEqual(
      rows.some((row) => row.surface === 'tabs' && row.name === 'switch-steps'),
      false,
      'production path must not emit switch-steps',
    );
  });

});
