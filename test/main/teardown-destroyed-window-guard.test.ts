/**
 * Teardown robustness — a destroyed window is a fact, not an exception.
 *
 * Reported production frame, seen through the uncaughtException handler during an abrupt
 * teardown:
 *
 *   TabAutomationHost.clearTabAgentWorking
 *     -> NativeTabHost.syncFrameBackdrop
 *       -> ProjectWindowShell.getContentGeometry
 *         -> TypeError: Object has been destroyed
 *
 * It is not cosmetic: `src/main/index.ts` runs an ordered `shutdown()` whose steps are
 * awaited in sequence (`recordLifecycleEvent('shutdown.step.*')`). A throw raised by a peer
 * path inside that window aborts every step after it, so an exiting app can lose its
 * clean-shutdown marker or its flush. The last case here is exactly that contract.
 *
 * The doubles model Electron rather than a convenient API, which is what makes both
 * directions provable: a destroyed window throws when it is measured, a view whose native
 * object is gone cannot even be asked for its `webContents`, and a live window whose
 * measurement genuinely fails still raises through the whole chain. Nothing about the call
 * path itself is stubbed — a real `ProjectWindowShell` over an injected native seam, the real
 * `NativeTabHost` methods over it, and the real `TabAutomationHost` behind them.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import type { BrowserWindow, WebContentsView } from 'electron';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import {
  ProjectWindowShell,
  TOOLBAR_HEIGHT_COMPACT,
  type ShellContentGeometry,
  type ShellDisplayInfo,
  type ShellNativeSeam,
  type WindowOwner,
} from '../../src/main/browser/project-window-shell';
import { FRAME_BACKDROP_CHANNELS } from '../../src/shared/contracts';

type Rect = { x: number; y: number; width: number; height: number };
type TestHost = any;

const OWNER: WindowOwner = { kind: 'project', projectId: 'project-00000000-0000-4000-8000-000000000guard' };
const TOOLBAR_HEIGHT = TOOLBAR_HEIGHT_COMPACT;

/** Electron's own error for a native object that is gone; the doubles raise the real one. */
function destroyedError(): TypeError {
  return new TypeError('Object has been destroyed');
}

class StubWebContents {
  public readonly id: number;
  public readonly sends: Array<{ channel: string; args: unknown[] }> = [];
  public readonly scripts: string[] = [];
  /** A destroyed contents cannot be dispatched to at all. */
  public destroyed = false;
  /**
   * Models the race a probe cannot close: the contents is destroyed after `isDestroyed()`
   * reported it alive, so the dispatch raises instead of returning a rejected promise.
   */
  public destroyOnDispatch = false;
  public readonly mainFrame = { url: '' };
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  constructor(id: number) {
    this.id = id;
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (existing && index >= 0) existing.splice(index, 1);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('destroyed');
  }

  public close(): void {
    this.destroy();
  }

  public send(channel: string, ...args: unknown[]): void {
    if (this.destroyed) throw destroyedError();
    this.sends.push({ channel, args });
  }

  public executeJavaScript(code: string): Promise<unknown> {
    if (this.destroyOnDispatch || this.destroyed) throw destroyedError();
    this.scripts.push(code);
    return Promise.resolve(undefined);
  }

  public setBackgroundThrottling(): void {}

  public invalidate(): void {}

  public loadFile(file: string): void {
    this.mainFrame.url = file;
  }

  public getURL(): string {
    return this.mainFrame.url;
  }
}

class StubView {
  public readonly contents: StubWebContents;
  public readonly boundsWrites: Rect[] = [];
  /** This view's own native object is gone, so even reading `webContents` raises. */
  public nativeObjectGone = false;

  constructor(id: number) {
    this.contents = new StubWebContents(id);
  }

  /** Electron: a view whose native object is gone cannot be inspected at all. */
  public get webContents(): StubWebContents {
    if (this.nativeObjectGone) throw destroyedError();
    return this.contents;
  }

  public setBounds(rect: Rect): void {
    this.boundsWrites.push({ ...rect });
  }

  public setBackgroundColor(): void {}
}

class StubWindow {
  public readonly children: unknown[] = [];
  public readonly contentView: {
    children: unknown[];
    addChildView: (view: unknown) => void;
    removeChildView: (view: unknown) => void;
  };
  public destroyed = false;
  /** A live window whose native measurement genuinely fails: a failure, not a destruction. */
  public measurementFailure: Error | null = null;
  private readonly document: StubWebContents;
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  private readonly bounds: Rect;

  constructor(options: Electron.BrowserWindowConstructorOptions) {
    this.bounds = {
      x: typeof options.x === 'number' ? options.x : 0,
      y: typeof options.y === 'number' ? options.y : 0,
      width: typeof options.width === 'number' ? options.width : 800,
      height: typeof options.height === 'number' ? options.height : 600,
    };
    this.document = new StubWebContents(1);
    this.contentView = {
      children: this.children,
      addChildView: (view: unknown) => {
        if (!this.children.includes(view)) this.children.push(view);
      },
      removeChildView: (view: unknown) => {
        const index = this.children.indexOf(view);
        if (index >= 0) this.children.splice(index, 1);
      },
    };
  }

  /** Electron: a window whose native object is gone cannot report its own document. */
  public get webContents(): StubWebContents {
    if (this.destroyed) throw destroyedError();
    return this.document;
  }

  public on(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    if (existing) existing.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  public once(event: string, listener: (...args: unknown[]) => void): this {
    const wrapped = (...args: unknown[]): void => {
      this.removeListener(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  public removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const existing = this.listeners.get(event);
    const index = existing ? existing.indexOf(listener) : -1;
    if (existing && index >= 0) existing.splice(index, 1);
    return this;
  }

  public emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
  }

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public getBounds(): Rect {
    if (this.destroyed) throw destroyedError();
    return { ...this.bounds };
  }

  /** The measurement the reported frame died on. */
  public getContentBounds(): Rect {
    if (this.destroyed) throw destroyedError();
    if (this.measurementFailure) throw this.measurementFailure;
    return { ...this.bounds };
  }

  /**
   * Electron destroys the window's own document with the window; child view contents are
   * deliberately left alive, which is exactly the leak the shell's own disposal accounts for.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.document.destroy();
    this.emit('closed');
  }

  /**
   * An abrupt process teardown destroys the window natively and never delivers its JS
   * `closed` notification: the process is exiting, so the shell never runs `disposeChrome()`
   * and still holds its chrome references — with their contents reporting alive — while the
   * window's native object is already gone. That is the state the reported frame was seen in,
   * and the only difference from `destroy()` above.
   */
  public tearDownNatively(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.document.destroy();
  }

  public isVisible(): boolean {
    return !this.destroyed;
  }

  public isMinimized(): boolean {
    return false;
  }

  public isMaximized(): boolean {
    return false;
  }

  public show(): void {}

  public focus(): void {}
}

interface StubSeam {
  seam: ShellNativeSeam;
  windows: StubWindow[];
  views: StubView[];
}

function createStubSeam(): StubSeam {
  const windows: StubWindow[] = [];
  const views: StubView[] = [];
  const display: ShellDisplayInfo = {
    id: 1,
    scaleFactor: 1,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  };
  let nextContentsId = 100;
  return {
    windows,
    views,
    seam: {
      createWindow: (options) => {
        const created = new StubWindow(options);
        windows.push(created);
        return created as unknown as BrowserWindow;
      },
      createView: () => {
        const created = new StubView(nextContentsId);
        nextContentsId += 1;
        views.push(created);
        return created as unknown as WebContentsView;
      },
      displayForBounds: () => ({
        id: display.id,
        scaleFactor: display.scaleFactor,
        bounds: { ...display.bounds },
        workArea: { ...display.workArea },
      }),
    },
  };
}

function createShell(): { shell: ProjectWindowShell; window: StubWindow; seam: StubSeam } {
  const seam = createStubSeam();
  const shell = new ProjectWindowShell(
    { owner: OWNER, title: 'Teardown guard', bounds: { width: 1280, height: 800 } },
    undefined,
    seam.seam,
  );
  const [window] = seam.windows;
  assert.ok(window, 'the seam must have created exactly one window');
  return { shell, window, seam };
}

/**
 * A host over the real `ProjectWindowShell`, with the fields the exercised path reads
 * injected — the same partial-host shape the tab host's own lifecycle tests use. Commented
 * out is every other subsystem: no persistence, no broadcast, no DevTools host.
 */
function createHost(shell: ProjectWindowShell): TestHost {
  const host: TestHost = Object.create(NativeTabHost.prototype);
  host.shell = shell;
  host.tabs = new Map();
  host.tabOrder = [];
  host.activeTabId = null;
  host.automationTabId = null;
  host.bookmarks = [];
  host.isBookmarkBarVisible = false;
  host.isDisposed = false;
  host.broadcastState = () => {};
  host.persistTabs = () => {};
  return host;
}

function bindAgentTab(host: TestHost, tabId: string): { view: StubView; contents: StubWebContents } {
  const view = new StubView(9001);
  host.tabs.set(tabId, {
    state: { id: tabId, url: 'https://example.test/', title: 'Example', aiState: 'agent_working' },
    view,
  });
  host.tabOrder.push(tabId);
  host.activeTabId = tabId;
  host.automationTabId = tabId;
  return { view, contents: view.contents };
}

describe('teardown over a destroyed window', () => {
  it('reports the live geometry, and no geometry at all once the window is gone', () => {
    const { shell, window } = createShell();

    assert.deepStrictEqual(shell.getContentGeometry(TOOLBAR_HEIGHT), {
      width: 1280,
      height: 800,
      toolbarHeight: TOOLBAR_HEIGHT,
      availableWidth: 1280,
      availableHeight: 800 - TOOLBAR_HEIGHT,
      sidebarActualWidth: 0,
    });

    window.destroy();
    assert.strictEqual(shell.getContentGeometry(TOOLBAR_HEIGHT), undefined);
  });

  it('lets the agent-working clear step finish when the window died first', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');

    // The reported shape: the window's native object is gone while the shell still holds the
    // tab record and its chrome, because the exiting process never delivered `closed`.
    window.tearDownNatively();

    assert.doesNotThrow(() => host.clearTabAgentWorking('tab-1'));
  });

  it('lets a global agent-working clear finish when the window died first', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');

    window.tearDownNatively();

    assert.doesNotThrow(() => host.clearAllAgentWorking());
  });

  it('survives a backdrop view whose native object is already gone', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');
    const backdrop = shell.frameBackdropView as unknown as StubView;
    backdrop.nativeObjectGone = true;

    window.tearDownNatively();

    assert.doesNotThrow(() => host.clearTabAgentWorking('tab-1'));
  });

  it('survives a tab view whose native object is already gone', () => {
    const { shell } = createShell();
    const host = createHost(shell);
    const { view } = bindAgentTab(host, 'tab-1');
    view.nativeObjectGone = true;

    assert.doesNotThrow(() => host.clearTabAgentWorking('tab-1'));
  });

  it('survives a contents that dies between the liveness probe and the glow dispatch', () => {
    const { shell } = createShell();
    const host = createHost(shell);
    const { contents } = bindAgentTab(host, 'tab-1');
    contents.destroyOnDispatch = true;

    assert.doesNotThrow(() => host.clearTabAgentWorking('tab-1'));
  });

  it('makes a layout pass over a destroyed window a no-op', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');

    window.destroy();

    assert.doesNotThrow(() => host.updateLayout());
  });

  it('never repositions chrome the shell already disposed', () => {
    const { shell } = createShell();
    const host = createHost(shell);
    const toolbar = shell.toolbarView as unknown as StubView;

    shell.disposeChrome();
    const writesBefore = toolbar.boundsWrites.length;

    assert.doesNotThrow(() => host.updateLayout());
    assert.strictEqual(
      toolbar.boundsWrites.length,
      writesBefore,
      'a chrome view the shell disposed is never repositioned',
    );
  });

  it('still surfaces a genuine measurement failure on a live window', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');
    window.measurementFailure = new Error('EIO: native measurement failed');

    assert.strictEqual(window.isDestroyed(), false, 'this window is live: the failure is not a destruction');
    assert.throws(() => shell.getContentGeometry(TOOLBAR_HEIGHT), /EIO: native measurement failed/);
    assert.throws(() => host.clearTabAgentWorking('tab-1'), /EIO: native measurement failed/);
  });

  it('publishes the live backdrop payload exactly as before', () => {
    const { shell } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');
    const backdrop = shell.frameBackdropView as unknown as StubView;

    host.clearTabAgentWorking('tab-1');

    assert.deepStrictEqual(backdrop.contents.sends, [{
      channel: FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT,
      args: [{
        splitMode: false,
        focusedPane: 'desktop',
        containerWidth: 1280,
        containerHeight: 800 - TOOLBAR_HEIGHT,
        agentWorking: true,
      }],
    }]);
  });

  it('lets an ordered teardown reach its last step after the window died', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    bindAgentTab(host, 'tab-1');
    window.tearDownNatively();

    const steps: string[] = [];
    const teardown: Array<{ name: string; run: () => void }> = [
      { name: 'shutdown.step.persist', run: () => { steps.push('persist'); } },
      { name: 'shutdown.step.agentWorking', run: () => host.clearTabAgentWorking('tab-1') },
      { name: 'shutdown.step.sessionFlush', run: () => { steps.push('sessionFlush'); } },
    ];
    for (const step of teardown) {
      try {
        step.run();
      } catch (err) {
        steps.push(`aborted at ${step.name}: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
    }

    assert.deepStrictEqual(steps, ['persist', 'sessionFlush']);
  });

  it('names the surface whose chrome renderer stops answering', () => {
    const { shell } = createShell();
    const toolbar = shell.toolbarView as unknown as StubView;
    const sidebar = shell.sidebarView as unknown as StubView;
    assert.ok(toolbar && sidebar, 'the harness builds both chrome surfaces');
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(' '));
    };
    try {
      toolbar.contents.emit('unresponsive');
      sidebar.contents.emit('unresponsive');
      toolbar.contents.emit('responsive');
    } finally {
      console.warn = originalWarn;
    }

    assert.deepStrictEqual(warnings, [
      '[project-window-shell] toolbar renderer stopped answering (unresponsive)',
      '[project-window-shell] sidebar renderer stopped answering (unresponsive)',
      '[project-window-shell] toolbar renderer answering again',
    ]);
  });

  it('routes the toolbar overlay through the shell\'s single geometry pass', () => {
    const { shell, window } = createShell();
    const host = createHost(shell);
    const toolbar = shell.toolbarView as unknown as StubView;

    const applied: Array<{ overlay: { active: boolean; extraHeight: number }; geometry: ShellContentGeometry }> = [];
    const applyChromeBounds = shell.applyChromeBounds.bind(shell);
    shell.applyChromeBounds = (geometry, overlay) => {
      applied.push({ overlay: { ...overlay }, geometry: { ...geometry } });
      applyChromeBounds(geometry, overlay);
    };
    let measureCalls = 0;
    const measure = window.getContentBounds.bind(window);
    window.getContentBounds = () => { measureCalls += 1; return measure(); };

    // Baseline: one canonical layout pass measures and applies bounds a fixed number of times.
    // A toggle that ran its own geometry authority would measure again and write bounds without
    // going through `applyChromeBounds`; both would show up as a surplus over this baseline.
    host.updateLayout();
    const baselineMeasures = measureCalls;
    const baselineApplies = applied.length;

    applied.length = 0;
    measureCalls = 0;
    const writesBefore = toolbar.boundsWrites.length;
    host.setToolbarOverlay(true, 220);

    assert.strictEqual(applied.length, 1, 'the overlay reaches the shell\'s canonical bounds pass exactly once');
    assert.deepStrictEqual(applied[0]!.overlay, { active: true, extraHeight: 220 });
    assert.strictEqual(measureCalls, baselineMeasures, 'the overlay adds no measurement of its own over a canonical pass');
    assert.strictEqual(toolbar.boundsWrites.length, writesBefore + 1, 'one layout pass writes the toolbar once');
    const bounds = toolbar.boundsWrites.at(-1)!;
    assert.strictEqual(bounds.width, applied[0]!.geometry.availableWidth, 'the toolbar takes the shell\'s computed content width');
    assert.strictEqual(bounds.height, TOOLBAR_HEIGHT + 220, 'the overlay extends the toolbar by its custom height');

    host.setToolbarOverlay(false);
    assert.strictEqual(applied.length, 2);
    assert.deepStrictEqual(applied[1]!.overlay, { active: false, extraHeight: 0 });
    assert.strictEqual(toolbar.boundsWrites.at(-1)!.height, TOOLBAR_HEIGHT, 'clearing the overlay restores the plain toolbar height');
    assert.strictEqual(baselineApplies > 0, true, 'the baseline pass must have applied bounds for the comparison to mean anything');
  });

  it('leaves no live toolbar reference once the shell\'s chrome is disposed', () => {
    const { shell } = createShell();
    const host = createHost(shell);
    const toolbar = shell.toolbarView as unknown as StubView;
    const toolbarContentsId = toolbar.contents.id;

    shell.disposeChrome();

    assert.strictEqual(shell.toolbarView, null, 'a disposed shell releases its toolbar reference');
    assert.strictEqual(toolbar.contents.isDestroyed(), true, 'the released view\'s contents were torn down');
    const writesBefore = toolbar.boundsWrites.length;

    // Every reader that can still run after disposal fails closed: the overlay toggle no-ops
    // instead of resurrecting geometry for dead chrome, the shortcut surface drops the send,
    // and chrome-surface lookup no longer answers for the released view.
    assert.doesNotThrow(() => host.setToolbarOverlay(true));
    assert.strictEqual(toolbar.boundsWrites.length, writesBefore, 'a layout pass after disposal never repositions the released toolbar');
    assert.doesNotThrow(() => host.showShortcuts());
    assert.strictEqual(toolbar.contents.sends.length, 0, 'no message reaches the released toolbar contents');
    assert.strictEqual(shell.chromeSurfaceFor(toolbarContentsId), undefined, 'a released surface is never claimed as this window\'s chrome');
  });
});
