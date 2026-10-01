import { describe, it, mock } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NativeTabHost, NativeTabRecord, type CaptureLiftLease } from '../../src/main/browser/native-tab-host';
import { parseBenchmarkLine } from '../../src/main/benchmark/telemetry';
import { AntiFanTab } from '../../src/shared/contracts';
import { createShellDouble, ShellDouble, ShellDoubleView, ShellDoubleWindow } from '../support/project-window-shell-double';


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
  focusCalls: number;
}

interface PresentedHost {
  host: any;
  shell: ShellDouble;
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
  const recorder = { invalidateCalls: 0, focusCalls: 0 };

  const webContents = {
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => state.url,
    setZoomFactor: (_factor: number) => {},
    insertCSS: async (_css: string) => '',
    invalidate: () => {
      recorder.invalidateCalls += 1;
    },
    focus: () => {
      recorder.focusCalls += 1;
    },
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
    get focusCalls() {
      return recorder.focusCalls;
    },
  };
}

function createPresentedHost(params: { tabs: RecordedTab[]; activeTabId: string; attached: unknown[] }): PresentedHost {
  const children: unknown[] = [...params.attached];
  const host: any = Object.create(NativeTabHost.prototype);
  host.isDisposed = false;
  host.agentInputInFlight = 0;
  host.lastUserInputAtMs = 0;
  host.captureLift = null;
  host.captureLiftQueue = [];
  host.captureLiftToken = 0;
  host.tabOrder = params.tabs.map((recorded) => recorded.tab.state.id);
  host.tabs = new Map(params.tabs.map((recorded) => [recorded.tab.state.id, recorded.tab]));
  host.activeTabId = params.activeTabId;
  host.defaultUserAgent = 'MockDesktopUA';
  host.temporaryViewAttachCounts = new WeakMap();
  host.tabByWebContents = new WeakMap(
    params.tabs.map((recorded) => [recorded.tab.view!.webContents, { tabId: recorded.tab.state.id, tab: recorded.tab }])
  );
  const windowDouble: ShellDoubleWindow = {
    isDestroyed: () => false,
    getBounds: () => ({ ...WINDOW_CONTENT_BOX }),
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
    on: () => {},
    removeListener: () => {},
  };
  const shell = createShellDouble({
    window: windowDouble,
    isSidebarOpen: false,
    sidebarWidth: SIDEBAR_WIDTH,
  }) as unknown as ShellDouble;
  host.shell = shell;
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
  return { host, shell, children, emulationCalls };
}

describe('Presented view invariant', () => {
  it('never parks the presented audible pane on an off-screen capture host', () => {
    const presented = createTestTab('music', { isAudible: true });
    const { host, children } = createPresentedHost({ tabs: [presented], activeTabId: 'music', attached: [presented.tab.view] });
    host.ensureCaptureHostWindow = () => { throw new Error('presented panes must not borrow another window'); };
    assert.strictEqual(host.raiseViewOnCaptureHost(presented.tab.view), false);
    assert.deepStrictEqual(children, [presented.tab.view]);
    assert.strictEqual(host.tabs.get('music').view, presented.tab.view);
  });

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

  it('a capture lift presents the borrowed pane above the user tab, never switches it, and release buries it again', async () => {
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

      // The capture host cannot be constructed in this lane, so the lease grants
      // on the in-window origin — the same fallback the production path takes
      // when BrowserWindow refuses.
      const lease = await host.acquireCaptureLift(background.tab.view);
      const raisedPresented = children.indexOf(presented.tab.view);
      const raisedBackground = children.indexOf(background.tab.view);
      assert.ok(raisedBackground > raisedPresented && raisedPresented >= 0, 'the lift must sit the capture view above the user tab');
      assert.strictEqual(host.activeTabId, 'tab-visible', 'a lift must not switch the visible tab');
      assert.strictEqual(lease.released, false, 'the lease is held while the raster runs');
      assert.deepStrictEqual(host.captureLiftState()?.origin, 'in-window', 'the held lift records where the pane was parked');

      lease.release('raster-finished');
      assert.strictEqual(lease.released, true, 'release reports on the same lease object');
      assert.strictEqual(host.captureLiftState(), null, 'release clears the window slot');
      const restoredPresented = children.indexOf(presented.tab.view);
      const restoredBackground = children.indexOf(background.tab.view);
      assert.ok(restoredPresented > restoredBackground && restoredBackground >= 0, 'release must put the user tab back on top');
    });

    assert.deepStrictEqual(children, [presented.tab.view], 'releasing the capture must hand the window back to the presented tab only');
  });

  it('a lift takes its raster without taking the user focus', async () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    await host.runWithAttachedTabView(background.tab.view, async () => {
      const lease = await host.acquireCaptureLift(background.tab.view);
      assert.strictEqual(children[children.length - 1], background.tab.view, 'the lifted pane presents for its raster');
      assert.strictEqual(background.focusCalls, 0, 'the lift never moves real DOM focus');
      assert.strictEqual(presented.focusCalls, 0, 'the presented pane is never refocused either');
      lease.release('raster-finished');
    });
  });

  it('a second acquire queues on the held lift and is granted only when it frees', async () => {
    const presented = createTestTab('tab-visible');
    const backgroundA = createTestTab('tab-bg-a');
    const backgroundB = createTestTab('tab-bg-b');
    const { host, children } = createPresentedHost({
      tabs: [presented, backgroundA, backgroundB],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    await host.runWithAttachedTabView(backgroundA.tab.view, async () => {
      await host.runWithAttachedTabView(backgroundB.tab.view, async () => {
        const leaseA = await host.acquireCaptureLift(backgroundA.tab.view);
        assert.strictEqual(host.captureLiftState()?.view, backgroundA.tab.view, 'the first acquire owns the slot');

        let grantedB: { view: unknown } | null = null;
        const pendingB = host.acquireCaptureLift(backgroundB.tab.view).then((lease: CaptureLiftLease) => {
          grantedB = lease;
          return lease;
        });
        await new Promise((resolve) => setImmediate(resolve));
        assert.strictEqual(grantedB, null, 'the second acquire waits on the held lease rather than stealing it');
        assert.strictEqual(host.captureLiftState()?.view, backgroundA.tab.view, 'the holder is undisturbed while a waiter queues');

        leaseA.release('raster-finished');
        const leaseB = await pendingB;
        assert.ok(leaseB, 'the queued acquire resolves once the window frees the slot');
        assert.strictEqual(host.captureLiftState()?.view, backgroundB.tab.view, 'the waiter is granted in FIFO order');
        assert.strictEqual(children[children.length - 1], backgroundB.tab.view, 'the second pane is the one now presented for its raster');
        leaseB.release('raster-finished');
      });
    });
  });

  it('the watchdog lowers a raster that outlives its bound and frees the queue', async () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await host.runWithAttachedTabView(background.tab.view, async () => {
        const lease = await host.acquireCaptureLift(background.tab.view, { budgetMs: 200 });
        assert.strictEqual(children[children.length - 1], background.tab.view, 'the pane is lifted for its raster');

        // A raster that abandons its dispatch never releases; the watchdog is
        // the backstop that buries the pane and frees the slot on its own.
        mock.timers.tick(200);
        assert.strictEqual(lease.released, true, 'the watchdog releases the held lease');
        assert.strictEqual(host.captureLiftState(), null, 'the slot is freed for the next capture');
        const restoredPresented = children.indexOf(presented.tab.view);
        const restoredBackground = children.indexOf(background.tab.view);
        assert.ok(restoredPresented > restoredBackground && restoredBackground >= 0, 'the user pane is back on top after the watchdog fired');
      });
    } finally {
      mock.timers.reset();
    }
  });

  it('an agent-plane switch while the user is typing defers instead of moving the presented pane', () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    host.noteUserActivity('keyDown');
    const deferred = host.trySwitchTab('tab-bg', { plane: 'agent' });
    assert.strictEqual(deferred.ok, false, 'the agent-plane activation must refuse while recent input owns the window');
    if (!deferred.ok) {
      assert.strictEqual(deferred.reason, 'ACTIVATION_DEFERRED_USER_INPUT', 'the refusal names the deferral, not a generic failure');
      assert.ok(typeof deferred.retryAfterMs === 'number' && deferred.retryAfterMs > 0, 'the caller is told how long to wait');
    }
    assert.strictEqual(host.activeTabId, 'tab-visible', 'a deferred switch leaves the active tab untouched');
    assert.deepStrictEqual(children, [presented.tab.view], 'a deferred switch never moves the presented pane');
    assert.strictEqual(background.focusCalls, 0, 'a deferred switch never takes focus');

    host.lastUserInputAtMs = 0;
    const switched = host.trySwitchTab('tab-bg', { plane: 'agent' });
    assert.strictEqual(switched.ok, true, 'the same call proceeds once the recency window has passed');
    assert.deepStrictEqual(children, [background.tab.view], 'the agent-plane switch still presents its tab');
    assert.strictEqual(background.focusCalls, 0, 'the agent-plane switch presents but never focuses');
  });

  it('a user-plane switch succeeds during recent input and takes focus', () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });

    host.noteUserActivity('keyDown');
    const switched = host.trySwitchTab('tab-bg', { plane: 'user' });
    assert.strictEqual(switched.ok, true, 'the user plane is immune to the deferral gate');
    assert.deepStrictEqual(children, [background.tab.view], 'the user-plane switch presents its tab');
    assert.strictEqual(background.focusCalls, 1, 'the user plane takes real DOM focus — that is the asymmetry the agent plane lacks');
    assert.strictEqual(background.invalidateCalls >= 1, true, 'the presented pane is still repainted');
  });

  it('reassert on an already-attached pane recycles the compositor layer without a getBounds kick', () => {
    const presented = createTestTab('tab-visible');
    const { host, shell, children } = createPresentedHost({
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
    presented.tab.view!.setBounds(laidOut);
    const boundsBeforeRecycle = presented.setBoundsCalls.length;
    let removes = 0;
    let adds = 0;
    const origRemove = shell.window.contentView.removeChildView.bind(shell.window.contentView);
    const origAdd = shell.window.contentView.addChildView.bind(shell.window.contentView);
    shell.window.contentView.removeChildView = (view: unknown) => {
      removes += 1;
      origRemove(view);
    };
    shell.window.contentView.addChildView = (view: unknown, index?: number) => {
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

  it('a switch onto a tab the window is not presenting must not drop the visual it just attached', () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const { host, shell, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });
    let removes = 0;
    let adds = 0;
    const moved: Array<{ view: unknown; kind: 'add' | 'remove' }> = [];
    const origRemove = shell.window.contentView.removeChildView.bind(shell.window.contentView);
    const origAdd = shell.window.contentView.addChildView.bind(shell.window.contentView);
    shell.window.contentView.removeChildView = (view: unknown) => {
      removes += 1;
      moved.push({ view, kind: 'remove' });
      origRemove(view);
    };
    shell.window.contentView.addChildView = (view: unknown, index?: number) => {
      adds += 1;
      moved.push({ view, kind: 'add' });
      origAdd(view, index);
    };

    assert.strictEqual(host.isTabViewAttached(background.tab.view), false, 'the background tab starts off screen');
    assert.strictEqual(host.switchTab('tab-bg'), true, 'the switch must be accepted');

    assert.deepStrictEqual(children, [background.tab.view], 'the switched-to tab must be the presented view afterwards');
    assert.strictEqual(
      moved.filter((op) => op.kind === 'add' && op.view === background.tab.view).length,
      1,
      'the target view is attached once for the switch'
    );
    assert.strictEqual(
      moved.filter((op) => op.kind === 'remove' && op.view === background.tab.view).length,
      0,
      'the switch must not tear down and re-create the visual it just attached'
    );
    assert.strictEqual(
      moved.filter((op) => op.kind === 'remove' && op.view === presented.tab.view).length,
      1,
      'the pane being replaced is the one that leaves the window'
    );
    assert.ok(background.invalidateCalls >= 1, 'the switched-to view must still be repainted');
  });

  it('a switch must not re-stack the shell chrome it never touched', () => {
    const presented = createTestTab('tab-visible');
    const background = createTestTab('tab-bg');
    const sidebar = { webContents: { isDestroyed: () => false } };
    const toolbar = { webContents: { isDestroyed: () => false } };
    const { host, shell, children } = createPresentedHost({
      tabs: [presented, background],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view, sidebar, toolbar],
    });
    shell.sidebarView = sidebar as unknown as ShellDoubleView;
    shell.toolbarView = toolbar as unknown as ShellDoubleView;

    const moved: unknown[] = [];
    const origRemove = shell.window.contentView.removeChildView.bind(shell.window.contentView);
    const origAdd = shell.window.contentView.addChildView.bind(shell.window.contentView);
    shell.window.contentView.removeChildView = (view: unknown) => {
      moved.push(view);
      origRemove(view);
    };
    shell.window.contentView.addChildView = (view: unknown, index?: number) => {
      moved.push(view);
      origAdd(view, index);
    };

    assert.strictEqual(host.switchTab('tab-bg'), true, 'the switch must be accepted');

    // The chrome is what bounds a tab pane from above, so the pane is inserted under it and the
    // order check has nothing left to move. Re-stacking the chrome per switch costs a remove, an
    // add and an invalidate for each shell view, on every switch.
    assert.deepStrictEqual(children, [background.tab.view, sidebar, toolbar], 'the switched-to pane sits under the chrome');
    assert.deepStrictEqual(
      moved.filter((view) => view === sidebar || view === toolbar),
      [],
      'presenting a tab must not detach and re-add the toolbar or the sidebar'
    );
    assert.strictEqual(moved.filter((view) => view === background.tab.view).length, 1, 'the target pane is inserted once');
  });

  it('a leaked attach-for-capture count must not skip recycling the presented compositor layer', async () => {
    const presented = createTestTab('tab-visible');
    const { host, shell, children } = createPresentedHost({
      tabs: [presented],
      activeTabId: 'tab-visible',
      attached: [presented.tab.view],
    });
    let removes = 0;
    let adds = 0;
    const origRemove = shell.window.contentView.removeChildView.bind(shell.window.contentView);
    const origAdd = shell.window.contentView.addChildView.bind(shell.window.contentView);
    shell.window.contentView.removeChildView = (view: unknown) => {
      removes += 1;
      origRemove(view);
    };
    shell.window.contentView.addChildView = (view: unknown, index?: number) => {
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

describe('Presented view resurface after the window was out of sight', () => {
  /** Counts drop-and-re-add recycles: the only thing that gives a white pane a new visual. */
  function countRecycles(host: any): { recycled: () => number } {
    const original = host.recyclePresentedLayer.bind(host);
    let recycled = 0;
    host.recyclePresentedLayer = (view: unknown, isMobile: boolean) => {
      recycled += 1;
      original(view, isMobile);
    };
    return { recycled: () => recycled };
  }

  it('regaining focus after a long absence re-presents the tab once and keeps page focus; a quick Alt+Tab does not', () => {
    const presented = createTestTab('tab-visible');
    const { host, children } = createPresentedHost({ tabs: [presented], activeTabId: 'tab-visible', attached: [presented.tab.view] });
    Object.assign(presented.tab.view!.webContents, { isFocused: () => true });
    const removals = { removed: countRecycles(host).recycled };

    host.noteWindowBlurred();
    host.noteWindowFocused();
    assert.strictEqual(removals.removed(), 0, 'a quick Alt+Tab must keep the surface it has');

    host.windowBlurredAtMs = Date.now() - 31_000;
    host.noteWindowFocused();
    assert.strictEqual(removals.removed(), 1, 'a long absence must drop and re-add the presented view');
    assert.deepStrictEqual(children, [presented.tab.view], 'the presented tab is back on screen after the recycle');
    assert.strictEqual(presented.focusCalls, 1, 'the page the user was typing in gets its focus back');
    const journal = fs.readFileSync(path.join(RUNTIME_DIR, 'logs', 'main.log'), 'utf8');
    assert.match(journal, /"event":"tabhost\.presentedViewResurfaced"[^\n]*"trigger":"focus"/);

    host.noteWindowFocused();
    assert.strictEqual(removals.removed(), 1, 'a focus without a preceding blur re-presents nothing');
  });

  it('restore followed by focus recycles once, and a minimized window is left alone', () => {
    const presented = createTestTab('tab-visible');
    const { host, shell } = createPresentedHost({ tabs: [presented], activeTabId: 'tab-visible', attached: [presented.tab.view] });
    const removals = { removed: countRecycles(host).recycled };
    let minimized = true;
    Object.assign(shell.window!, { isMinimized: () => minimized });
    assert.strictEqual(host.resurfacePresentedView('resume'), false, 'a minimized window has nothing to re-present');
    assert.strictEqual(removals.removed(), 0);

    minimized = false;
    assert.strictEqual(host.resurfacePresentedView('restore'), true);
    host.windowBlurredAtMs = Date.now() - 60_000;
    host.noteWindowFocused();
    assert.strictEqual(removals.removed(), 1, 'the focus that trails a restore must not recycle the view a second time');
    const journal = fs.readFileSync(path.join(RUNTIME_DIR, 'logs', 'main.log'), 'utf8');
    assert.match(journal, /"event":"tabhost\.presentedViewResurfaced"[^\n]*"trigger":"focus"[^\n]*"skipped":"deduped"/, 'the deduped trigger stays on the incident timeline');
    assert.strictEqual(presented.focusCalls, 0, 'a page that did not have focus (sidebar or toolbar did) is not handed it');
  });
});
