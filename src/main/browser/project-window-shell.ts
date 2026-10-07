/**
 * AntiFan Browser Desktop — Project Window Shell
 *
 * Owns the native presentation of exactly one project window: its BrowserWindow,
 * the three chrome WebContentsViews (toolbar, frame backdrop, terminal sidebar),
 * the sidebar layout preferences, and the geometry derived from them.
 *
 * It is deliberately NOT an authority. It owns no tab map, no selection, no
 * attachments and no shared service. Tab views are attached and stacked by the
 * singleton tab authority, which reads geometry from the shell.
 *
 * Two presentation rules hold here:
 * - Identity comes from the validated record Main passes in. A page inside the
 *   window can never retitle the project (`page-title-updated` is refused), and
 *   no shell API accepts a renderer-supplied name.
 * - Construction never presents. The window is built hidden unless the caller
 *   explicitly asked for `show`, so an agent-driven creation cannot raise,
 *   focus or maximize anything; explicit user presentation stays the caller's
 *   action.
 *
 * Native close lives here too, because only this shell can observe its own window and its
 * own chrome contents. There is one attempt at a time and authorization is an explicit,
 * single-use token — never a flag such as "shutdown in progress". The order the close
 * coordinator must use:
 * 1. The platform asks to close. The shell calls `event.preventDefault()` synchronously and
 *    notifies its `onCloseRequest` listeners. Nothing was torn down and nothing is authorized.
 * 2. The policy owner (`ProjectCloseCoordinator`) closes this shell's member pages and then,
 *    through its surface adapter, calls `closeSelf()`.
 * 3. `closeSelf()` mints one attempt (`beginCloseAttempt()`: exact-instance observers
 *    registered before any native call), arms its single-use authorization (`authorize()`),
 *    issues the native close (`requestNativeClose()`) and settles from that attempt.
 * 4. Veto or error: the attempt is reset (`reset()`), so authorization never survives the
 *    attempt it was minted for and the next native close is checked again.
 */
import type { SurfaceCloseOutcome } from './project-close-coordinator';
import { BrowserWindow, WebContentsView, screen } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ownerKey, type WindowOwner } from './window-owner';
// Owner identity lives in a pure module: `terminal-manager.ts` stamps it onto sessions and
// is itself the headless daemon's closure, which must not import Electron. Re-exported here
// so every existing `from './project-window-shell'` import keeps working.
export { ownerKey, type WindowOwner };

/** Human label for a title bar; disambiguation with a path stays the caller's job. */
export function ownerLabel(owner: WindowOwner): string {
  if (owner.kind === 'project') return owner.projectId;
  return owner.kind === 'web' ? 'AntiFan Browser' : 'Unassigned';
}

/**
 * Called when the platform asked to close a shell and the shell refused to do it on its own,
 * so policy can run instead. The native close is already prevented when this fires and the
 * shell, its views and its tabs are untouched.
 */
export type ShellCloseRequestListener = (key: string) => void;

/**
 * One attempt at closing this shell's own window. Authorization is single-use and belongs to
 * this attempt alone: `authorize()` covers exactly the next native close request, and
 * `reset()` withdraws it, so no later native close inherits a decision made for this one.
 */
export interface ShellCloseAttempt {
  /** Monotonic identity within this shell; never reused. */
  readonly id: number;
  /** True while this attempt may still authorize a native close. */
  isAuthorized(): boolean;
  /** Arm the single-use authorization for the native close this attempt is about to issue. */
  authorize(): void;
  /** Withdraw the authorization after a veto or an error, settling the attempt `'unknown'`. */
  reset(): void;
  /**
   * Terminal outcome: `'closed'` when this window is gone, `'vetoed'` when the close was
   * refused, `'unknown'` when the attempt was withdrawn before any terminal signal.
   */
  readonly settled: Promise<SurfaceCloseOutcome>;
}

/** What the shell itself needs to know about the attempt it is running. */
interface ActiveCloseAttempt extends ShellCloseAttempt {
  /** Consume this attempt's authorization with the one native close request it covers. */
  consume(): void;
  /** True once a native close was dispatched for this attempt: only then can a veto belong to it. */
  isCloseDispatched(): boolean;
  isSettled(): boolean;
  /** Set when this attempt's own-content audit starts, so one closure is audited exactly once. */
  auditStarted: boolean;
  /** WebContents ids of this shell's own contents seen reaching `destroyed` in this attempt. */
  readonly observedDestroyed: Set<number>;
  /** Exact-instance detachers, drained on settlement so no attempt can settle another. */
  readonly observers: Array<() => void>;
  settle(outcome: SurfaceCloseOutcome): void;
}

/**
 * The chrome renderers a shell owns. IPC authorization is keyed on this role,
 * not on a webContents id alone: the sidebar and the toolbar of one window must
 * not be able to invoke each other's channels.
 */
export type ChromeSurface = 'toolbar' | 'sidebar' | 'frameBackdrop';

export const TOOLBAR_HEIGHT_COMPACT = 76;
export const TOOLBAR_HEIGHT_WITH_BOOKMARKS = 108;

/**
 * How long a chrome content gets to finish dying before its survival is called a leak.
 *
 * Chromium completes a `WebContents` teardown on a later turn, not in the call that asked for
 * it: measured with Electron 43, a `WebContentsView` content still answers
 * `isDestroyed() === false` in the task that called `destroy()` and has landed within ~5ms.
 * Judging disposal inside that task therefore reported a content that was already on its way
 * out; judging it after this window reports only what genuinely failed to die.
 */
const CHROME_DISPOSAL_SETTLE_MS = 50;

/**
 * How long one shell's own close may stay silent before it is reported `unknown`.
 *
 * The platform can answer a close with nothing at all — measured on the auxiliary terminal
 * window, where neither `close`, nor `will-prevent-unload`, nor `closed` ever arrived. Without
 * a bound this attempt's promise never resolves, and the application quit awaits it while
 * holding application admission, so that swallow alone makes the app unquittable. The bound
 * decides nothing about the close: `closed` is still reported only from a fact (the window is
 * gone), a surviving window is reported `unknown` — which the coordinator retains and retries —
 * and nothing is ever destroyed on a timer.
 */
const SHELL_CLOSE_OUTCOME_DEADLINE_MS = 1_500;

/**
 * Display facts a shell needs for its own scale-aware layout. Deliberately a
 * plain serializable shape instead of Electron's `Display`, so a shell-local
 * event can cross an IPC seam later without carrying the whole native object.
 */
export interface ShellDisplayInfo {
  id: number;
  scaleFactor: number;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
}

/** Native constructors and display lookup. Production uses Electron; tests inject a stub. */
export interface ShellNativeSeam {
  createWindow(options: Electron.BrowserWindowConstructorOptions): BrowserWindow;
  createView(options: Electron.WebContentsViewConstructorOptions): WebContentsView;
  /** The display a window rectangle occupies; undefined when it cannot be resolved. */
  displayForBounds(bounds: { x: number; y: number; width: number; height: number }): ShellDisplayInfo | undefined;
}

export const defaultShellNativeSeam: ShellNativeSeam = {
  createWindow: (options) => new BrowserWindow(options),
  createView: (options) => new WebContentsView(options),
  displayForBounds: (bounds) => {
    try {
      const display = screen.getDisplayMatching(bounds);
      return {
        id: display.id,
        scaleFactor: display.scaleFactor,
        bounds: { ...display.bounds },
        workArea: { ...display.workArea },
      };
    } catch {
      return undefined;
    }
  },
};

/** What a passive capture needs to know about one view, without presenting the window. */
export interface ShellCaptureReadiness {
  /** Exact instance identity: this same view is an attached child of this window right now. */
  attached: boolean;
  /** Attached view and window both have non-zero laid-out bounds, so a raster has pixels. */
  laidOut: boolean;
  /** The view's current bounds when attached; undefined otherwise. */
  bounds?: { x: number; y: number; width: number; height: number };
}

export interface ProjectWindowShellOptions {
  owner: WindowOwner;
  /** Validated registry title Main resolved for this owner. Never a renderer string. */
  title: string;
  /** Validated workspace-path label; disambiguates duplicate project names. */
  pathLabel?: string;
  icon?: string;
  bounds: { x?: number; y?: number; width: number; height: number };
  minWidth?: number;
  minHeight?: number;
  backgroundColor?: string;
  /** Explicit construction-time presentation. Default false: a shell never shows itself. */
  show?: boolean;
}

/** Content rectangle available to tab views for a given sidebar/toolbar state. */
export interface ShellContentGeometry {
  width: number;
  height: number;
  toolbarHeight: number;
  availableWidth: number;
  availableHeight: number;
  sidebarActualWidth: number;
}

/**
 * Resolve a renderer asset that may live beside the compiled output or in the
 * source tree during development.
 */
export function resolveRendererAsset(fileName: string): string {
  const compiled = path.join(__dirname, '..', '..', 'renderer', fileName);
  if (fs.existsSync(compiled)) return compiled;
  return path.join(process.cwd(), 'src', 'renderer', fileName);
}

export function resolvePreloadAsset(fileName: string): string {
  return path.join(__dirname, '..', '..', 'preload', fileName);
}

export class ProjectWindowShell {
  public readonly owner: WindowOwner;
  /**
   * Validated registry identity. Only `retitle` may change it, and only after Main has
   * renamed the durable record: a page title or a renderer message must never become
   * the project's name in the title bar.
   */
  private _title: string;
  public get title(): string {
    return this._title;
  }
  public readonly pathLabel?: string;
  public readonly window: BrowserWindow;
  public toolbarView: WebContentsView | null = null;
  public frameBackdropView: WebContentsView | null = null;
  public sidebarView: WebContentsView | null = null;

  /**
   * Sidebar presentation state belongs to the shell: it is what the chrome
   * geometry is derived from. The tab authority writes it when the user (or a
   * persisted preference) changes it, and never reads another window's copy.
   */
  public isSidebarOpen: boolean;
  public sidebarWidth: number;
  private chromeDisposed = false;
  /** One attempt at a time: two closes of one window would fight over a single authorization. */
  private activeCloseAttempt: ActiveCloseAttempt | null = null;
  private closeAttemptCounter = 0;
  private readonly closeRequestListeners = new Set<ShellCloseRequestListener>();
  private readonly closedListeners = new Set<() => void>();
  private closedNotified = false;
  /**
   * Chrome contents this shell disposed, recorded by `disposeChrome()` before it forgets the
   * views. The shell's own `closed` listener disposes the chrome before a close attempt audits
   * it, so this is what keeps the audit able to answer for every surface it owned.
   */
  private readonly disposedChrome: Array<{ role: string; contents: Electron.WebContents }> = [];
  private readonly native: ShellNativeSeam;
  private displayInfo: ShellDisplayInfo | undefined;
  private displaySignature = '';
  private readonly displayChangeListeners = new Set<(info: ShellDisplayInfo | undefined) => void>();
  private readonly handleDisplayCandidate = (): void => { this.refreshDisplayInfo(); };

  constructor(
    options: ProjectWindowShellOptions,
    sidebar?: { isOpen: boolean; width: number },
    native: ShellNativeSeam = defaultShellNativeSeam,
  ) {
    this.owner = options.owner;
    this._title = options.title;
    this.pathLabel = options.pathLabel;
    this.native = native;
    // The Terminal Manager is a terminals-only surface: its sidebar is the whole window and
    // never closes, so it is born open whatever the persisted state said.
    this.isSidebarOpen = this.isTerminalOnly() || (sidebar?.isOpen ?? false);
    this.sidebarWidth = sidebar?.width ?? 380;

    this.window = native.createWindow({
      title: options.title,
      icon: options.icon,
      x: options.bounds.x,
      y: options.bounds.y,
      width: options.bounds.width,
      height: options.bounds.height,
      minWidth: options.minWidth ?? 700,
      minHeight: options.minHeight ?? 500,
      backgroundColor: options.backgroundColor ?? '#080c14',
      autoHideMenuBar: true,
      show: options.show ?? false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // A page title is not project identity. Electron would otherwise follow the
    // window's own document title, and a renamed window would mislabel the
    // project the manager routed this shell for.
    this.window.on('page-title-updated', (event: Electron.Event) => { event.preventDefault(); });
    // Display placement is shell-local: only this window's move/resize can
    // change which display it occupies, and only its listeners hear about it.
    this.window.on('move', this.handleDisplayCandidate);
    this.window.on('resize', this.handleDisplayCandidate);
    this.window.on('maximize', this.handleDisplayCandidate);
    this.window.on('unmaximize', this.handleDisplayCandidate);
    this.window.on('restore', this.handleDisplayCandidate);
    // The platform asking to close is not an instruction to obey: the shell refuses the
    // native close synchronously and lets the close coordinator decide (see the call order
    // in the module header). Nothing is torn down here.
    this.window.on('close', (event: Electron.Event) => { this.handleNativeClose(event); });
    // Native closure does not prove child chrome disposal, so the shell tears its own chrome
    // down first and then reports the closure to its listeners.
    this.window.on('closed', () => {
      this.disposeChrome();
      this.notifyClosed();
    });
    this.refreshDisplayInfo();
    this.stripMenuBar();

    // Toolbar is never optional: it is the shell's own address surface.
    this.toolbarView = native.createView({
      webPreferences: {
        preload: resolvePreloadAsset('toolbar-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    this.createFrameBackdrop();
    this.createToolbarAndSidebar();

    // Chrome renderers belong to this window alone, and a surface that stops answering is
    // otherwise visible only as a caller that never returns somewhere else in the process,
    // with nothing naming which surface went quiet. Electron reports the fact per contents;
    // the shell is the one place that still knows which role it was created for.
    this.watchChromeLiveness('toolbar', this.toolbarView);
    this.watchChromeLiveness('sidebar', this.sidebarView);
    this.watchChromeLiveness('frameBackdrop', this.frameBackdropView);
  }

  /**
   * Retire the native `electron::MenuBar` this window was born with.
   *
   * Crash class this closes (three identical minidumps, `electron.exe+0xe22b52`,
   * `views::FocusManager::SetFocusedViewWithReason` CHECK `view && ContainsView(view)`):
   * `RootView::HandleKeyEvent` records `last_focused_view_tracker_` on every Alt release
   * while a menubar exists — autoHideMenuBar does NOT exempt it, Alt is precisely how the
   * hidden strip is raised — and `ViewTracker` only clears that pointer when the tracked
   * view is DESTROYED, never when it is detached. This shell reparents tab
   * WebContentsViews for capture-lift, tab-switch detaches, resurface, and split panes, so
   * the tracker can hold a view that no longer lives under the RootView; the next
   * `MenuBar::RestoreFocus` caller (AcceleratorPressed / OnDidChangeFocus /
   * OnBeforeExecuteCommand) feeds it to `SetFocusedViewWithReason` and the process dies.
   *
   * `setMenu(null)` resets `menu_bar_` (all three callers die with it) and unregisters the
   * window's accelerators; the chord set the menu owned is replayed on `before-input-event`
   * by `dispatchApplicationMenuShortcut` in app-menu.ts. macOS keeps its global NSMenu —
   * it never instantiates `views::MenuBar` — so this is a no-op off win32/linux surfaces.
   * Called again by `installApplicationMenu` after `Menu.setApplicationMenu` re-applies a
   * menubar to every live window. Doubles may omit `setMenu`; `?.` keeps them working.
   */
  public stripMenuBar(): void {
    if (process.platform === 'darwin') return;
    if (this.window.isDestroyed()) return;
    this.window.setMenu?.(null);
  }

  /**
   * Re-label the window after Main renamed the project's durable record (the capsule
   * store). The record changed first — this only mirrors it into the title bar and the
   * chrome identity projections — so the renderer-facing name still cannot be authored
   * by a page or a renderer message.
   */
  public retitle(title: string): void {
    if (typeof title !== 'string' || !title.trim()) return;
    const next = title.trim();
    if (next === this._title) return;
    this._title = next;
    if (!this.window.isDestroyed()) {
      this.window.setTitle(next);
    }
  }

  /**
   * Report a chrome renderer's liveness against the surface that owns it. Deliberately not a
   * teardown guard: it decides nothing and changes no behaviour, it only makes the fact
   * visible, because a hung chrome renderer must not be indistinguishable from a hung caller.
   */
  private watchChromeLiveness(role: ChromeSurface, view: WebContentsView | null): void {
    const contents = this.contentsOf(view);
    if (!contents) return;
    try {
      contents.on('unresponsive', () => {
        console.warn(`[project-window-shell] ${role} renderer stopped answering (unresponsive)`);
      });
      contents.on('responsive', () => {
        console.warn(`[project-window-shell] ${role} renderer answering again`);
      });
    } catch (err) {
      console.warn('[project-window-shell] Failed to watch chrome liveness:', err);
    }
  }

  private createFrameBackdrop(): void {
    try {
      this.frameBackdropView = this.native.createView({
        webPreferences: {
          preload: resolvePreloadAsset('frame-backdrop-preload.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
        },
      });
      this.frameBackdropView.setBackgroundColor('#060910');
      this.window.contentView.addChildView(this.frameBackdropView);
      this.frameBackdropView.webContents.loadFile(resolveRendererAsset('frame-backdrop.html'));
    } catch (err) {
      console.error('[project-window-shell] Failed to initialize frameBackdropView:', err);
      this.frameBackdropView = null;
    }
  }

  private createToolbarAndSidebar(): void {
    if (this.toolbarView) {
      this.toolbarView.setBackgroundColor('#00000000');
      this.window.contentView.addChildView(this.toolbarView);
      this.toolbarView.webContents.loadFile(resolveRendererAsset('toolbar.html'));
    }

    try {
      this.sidebarView = this.native.createView({
        webPreferences: {
          preload: resolvePreloadAsset('standalone-preload.js'),
          contextIsolation: true,
          sandbox: false,
          nodeIntegration: false,
        },
      });
      this.sidebarView.setBackgroundColor('#060a11');
      this.window.contentView.addChildView(this.sidebarView);
      this.sidebarView.webContents.loadFile(resolveRendererAsset('standalone.html'));
    } catch (err) {
      console.error('[project-window-shell] Failed to initialize sidebarView:', err);
      this.sidebarView = null;
    }
  }

  /** Toolbar height for the current bookmark-bar state; the authority owns bookmarks. */
  public getToolbarHeight(hasBookmarks: boolean, bookmarkBarVisible: boolean): number {
    return bookmarkBarVisible && hasBookmarks ? TOOLBAR_HEIGHT_WITH_BOOKMARKS : TOOLBAR_HEIGHT_COMPACT;
  }

  /** The display this shell's window currently occupies, or undefined when unknown. */
  public getDisplayInfo(): ShellDisplayInfo | undefined {
    return this.displayInfo;
  }

  /**
   * Per-shell display events. Fires only when the display identity, its scale
   * factor or its geometry actually changed, so a move inside one monitor stays
   * silent. Main calls `refreshDisplayInfo()` after a global display-metrics
   * change; a shell's own listeners never hear another shell's window.
   */
  public onDisplayChange(listener: (info: ShellDisplayInfo | undefined) => void): () => void {
    this.displayChangeListeners.add(listener);
    return () => { this.displayChangeListeners.delete(listener); };
  }

  /** Re-read the current display. Never presents the window; a hidden shell has one too. */
  public refreshDisplayInfo(): void {
    if (this.window.isDestroyed()) return;
    let next: ShellDisplayInfo | undefined;
    try {
      next = this.native.displayForBounds(this.window.getBounds());
    } catch {
      next = undefined;
    }
    const signature = next
      ? `${next.id}:${next.scaleFactor}:${next.workArea.x},${next.workArea.y},${next.workArea.width},${next.workArea.height}`
      : '';
    if (signature === this.displaySignature && Boolean(next) === Boolean(this.displayInfo)) return;
    this.displaySignature = signature;
    this.displayInfo = next;
    for (const listener of [...this.displayChangeListeners]) {
      try {
        listener(next);
      } catch (err) {
        console.error('[project-window-shell] display change listener failed:', err);
      }
    }
  }

  /**
   * True once this shell's window is gone. Every measurement on a destroyed native window
   * raises, so the fact is probed once here instead of being caught at each call site, and a
   * probe that cannot even be asked counts as gone.
   */
  private isWindowGone(): boolean {
    try {
      return this.window.isDestroyed();
    } catch {
      return true;
    }
  }

  /**
   * The shared Terminal Manager (the `unassigned` owner) shows terminals only: no toolbar, no
   * tab strip, no page area. Web content lives in the `web` hub; this window is its companion.
   */
  public isTerminalOnly(): boolean {
    return this.owner.kind === 'unassigned';
  }

  /**
   * A view's contents while that view can still be inspected. A view whose native object is
   * gone raises on the property read itself, so `undefined` answers "this surface cannot be
   * asked anything" rather than aborting a teardown step that was only reporting on it.
   */
  private contentsOf(view: WebContentsView | null | undefined): Electron.WebContents | undefined {
    if (!view) return undefined;
    try {
      return view.webContents ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Facts a passive capture needs, resolved without presenting anything: the
   * exact view instance must still be attached to this window and have laid-out
   * bounds. A hidden window answers this truthfully, which is what lets capture
   * run in the background instead of showing the project to raster it.
   */
  public captureReadinessFor(view: WebContentsView | null | undefined): ShellCaptureReadiness {
    // The view is checked first so the bounds read below is narrowed to a real view; the
    // contents probe then answers whether that view's native surface can still be inspected.
    if (!view) return { attached: false, laidOut: false };
    const contents = this.contentsOf(view);
    if (!contents || this.isContentsDestroyed(contents) || this.isWindowGone()) {
      return { attached: false, laidOut: false };
    }
    const children = this.window.contentView?.children;
    if (!Array.isArray(children) || !children.includes(view)) return { attached: false, laidOut: false };

    const viewBounds = typeof view.getBounds === 'function' ? view.getBounds() : undefined;
    const contentBounds = this.window.getContentBounds();
    return {
      attached: true,
      laidOut: Boolean(viewBounds && viewBounds.width > 0 && viewBounds.height > 0 && contentBounds.width > 0 && contentBounds.height > 0),
      bounds: viewBounds,
    };
  }

  /**
   * Content rectangle available to the window's tab views, or undefined once this shell's
   * window is gone. A destroyed window cannot be measured at all, so its geometry is reported
   * as absent instead of raised: a teardown step that reads layout while the app is exiting
   * must not be the thing that aborts the steps after it. Only destruction answers this way —
   * a live window whose measurement genuinely fails still raises.
   */
  public getContentGeometry(toolbarHeight: number): ShellContentGeometry | undefined {
    if (this.isWindowGone()) return undefined;
    const { width, height } = this.window.getContentBounds();
    if (this.isTerminalOnly()) {
      return { width, height, toolbarHeight: 0, availableWidth: 0, availableHeight: 0, sidebarActualWidth: width };
    }
    const availableWidth = this.isSidebarOpen ? Math.max(400, width - this.sidebarWidth) : width;
    return {
      width,
      height,
      toolbarHeight,
      availableWidth,
      availableHeight: Math.max(0, height - toolbarHeight),
      sidebarActualWidth: width - availableWidth,
    };
  }

  /**
   * Apply chrome bounds for the current geometry. Tab view bounds stay with the
   * tab authority, which owns the tab records.
   */
  public applyChromeBounds(geometry: ShellContentGeometry, toolbarOverlay: { active: boolean; extraHeight: number }): void {
    // The chrome this repositions is this shell's own, so the shell can answer when it is
    // gone: after `disposeChrome()` these views are destroyed, and a destroyed window takes
    // its children with it. Neither state may reach a native `setBounds` — a layout pass that
    // arrives after disposal is reporting on nothing, not failing.
    if (this.chromeDisposed || this.isWindowGone()) return;
    if (this.frameBackdropView) {
      this.frameBackdropView.setBounds({
        x: 0,
        y: geometry.toolbarHeight,
        width: geometry.availableWidth,
        height: geometry.availableHeight,
      });
    }

    if (this.toolbarView) {
      if (toolbarOverlay.active && !this.isTerminalOnly()) {
        const overlayHeight = toolbarOverlay.extraHeight > 0
          ? Math.min(geometry.height, geometry.toolbarHeight + toolbarOverlay.extraHeight)
          : geometry.height;
        this.toolbarView.setBounds({ x: 0, y: 0, width: geometry.availableWidth, height: overlayHeight });
      } else {
        this.toolbarView.setBounds({ x: 0, y: 0, width: geometry.availableWidth, height: geometry.toolbarHeight });
      }
    }

    if (this.sidebarView) {
      if (this.isSidebarOpen && geometry.sidebarActualWidth > 0) {
        this.sidebarView.setBounds({ x: geometry.availableWidth, y: 0, width: geometry.sidebarActualWidth, height: geometry.height });
      } else {
        this.sidebarView.setBounds({ x: geometry.width, y: 0, width: 0, height: 0 });
      }
    }
  }

  /**
   * Which chrome surface a webContents presents, or undefined when this shell
   * owns neither. Ownership is not enough on its own: a chrome view that has
   * been navigated to some other page keeps its preload, so the frame must still
   * be showing the page this shell loaded.
   */
  public chromeSurfaceFor(webContentsId: number): ChromeSurface | undefined {
    if (this.loadsExpectedPage(this.toolbarView, 'toolbar.html', webContentsId)) return 'toolbar';
    if (this.loadsExpectedPage(this.frameBackdropView, 'frame-backdrop.html', webContentsId)) return 'frameBackdrop';
    if (this.loadsExpectedPage(this.sidebarView, 'standalone.html', webContentsId)) return 'sidebar';
    return undefined;
  }

  /** True when this webContents is the given view and still shows the page that view loaded. */
  private loadsExpectedPage(view: WebContentsView | null, fileName: string, webContentsId: number): boolean {
    const contents = this.contentsOf(view);
    if (!contents || contents.id !== webContentsId || this.isContentsDestroyed(contents)) return false;
    const frameUrl = contents.mainFrame?.url || contents.getURL();
    if (!frameUrl.startsWith('file:')) return false;
    try {
      const loaded = path.resolve(fileURLToPath(frameUrl));
      const expected = path.resolve(resolveRendererAsset(fileName));
      return process.platform === 'win32' ? loaded.toLowerCase() === expected.toLowerCase() : loaded === expected;
    } catch {
      return false;
    }
  }

  public ownsChromeWebContents(webContentsId: number): boolean {
    return this.chromeSurfaceFor(webContentsId) !== undefined;
  }

  public onResize(listener: () => void): void {
    this.window.on('resize', listener);
  }

  public onRestore(listener: () => void): void {
    this.window.on('restore', listener);
  }

  public onShow(listener: () => void): void {
    this.window.on('show', listener);
  }

  public onFocus(listener: () => void): void {
    this.window.on('focus', listener);
  }

  public onBlur(listener: () => void): void {
    this.window.on('blur', listener);
  }

  /**
   * Close requests the shell refused to perform on its own. The listener runs after the
   * native close was already prevented, so policy starts from a shell that is fully intact.
   */
  public onCloseRequest(listener: ShellCloseRequestListener): () => void {
    this.closeRequestListeners.add(listener);
    return () => { this.closeRequestListeners.delete(listener); };
  }

  /**
   * Fires once, after the platform destroyed this shell's window — the only proof the shell
   * is gone, and therefore the moment routing may be unregistered. A listener added after
   * the closure never runs.
   */
  public onClosed(listener: () => void): () => void {
    if (this.closedNotified) return () => {};
    this.closedListeners.add(listener);
    return () => { this.closedListeners.delete(listener); };
  }

  /**
   * Mint one close attempt, exact-instance observers first: the window's `closed` and every
   * content this shell owns. The attempt owns a single-use authorization, so a native close
   * is admitted only when the coordinator armed it for exactly this attempt.
   */
  public beginCloseAttempt(): ShellCloseAttempt {
    if (this.activeCloseAttempt !== null) {
      throw new Error('this shell is already running a close attempt');
    }
    const id = ++this.closeAttemptCounter;
    const deferred = Promise.withResolvers<SurfaceCloseOutcome>();
    let authorized = false;
    let closeDispatched = false;
    let settledWith: SurfaceCloseOutcome | null = null;
    const attempt: ActiveCloseAttempt = {
      id,
      settled: deferred.promise,
      observedDestroyed: new Set<number>(),
      observers: [],
      auditStarted: false,
      isAuthorized: () => authorized && !closeDispatched && settledWith === null,
      isCloseDispatched: () => closeDispatched,
      isSettled: () => settledWith !== null,
      authorize: () => {
        if (settledWith !== null) {
          throw new Error(`close attempt ${id} already settled as ${settledWith}`);
        }
        authorized = true;
      },
      consume: () => { closeDispatched = true; },
      settle: (outcome: SurfaceCloseOutcome): void => {
        if (settledWith !== null) return;
        settledWith = outcome;
        authorized = false;
        closeDispatched = false;
        for (const detach of attempt.observers.splice(0)) {
          try {
            detach();
          } catch {
            // The observed object is already gone; its listeners went with it.
          }
        }
        if (this.activeCloseAttempt === attempt) this.activeCloseAttempt = null;
        deferred.resolve(outcome);
      },
      reset: () => {
        if (settledWith !== null) return;
        authorized = false;
        closeDispatched = false;
        this.completeCloseAttempt(attempt, 'unknown');
      },
    };
    this.activeCloseAttempt = attempt;
    this.observeCloseAttempt(attempt);
    return attempt;
  }

  /**
   * Issue the native close for the running attempt. An armed authorization is required: it is
   * single-use and belongs to one attempt, so nothing — not even a shutdown in progress — can
   * push a close through this window unnoticed.
   */
  public requestNativeClose(): void {
    const attempt = this.activeCloseAttempt;
    if (attempt === null || !attempt.isAuthorized()) {
      throw new Error('requestNativeClose requires an armed close attempt');
    }
    if (this.window.isDestroyed()) return;
    this.window.close();
  }

  /**
   * Close this shell's own window, honoring unload: what the coordinator's surface adapter
   * calls. Resolving `'closed'` means the window is gone and this shell's chrome was disposed,
   * which the coordinator reads as "local teardown already ran".
   */
  public async closeSelf(force = false): Promise<SurfaceCloseOutcome> {
    if (this.window.isDestroyed()) return 'closed';
    const attempt = this.beginCloseAttempt();
    try {
      attempt.authorize();
      if (force) this.window.destroy();
      else this.requestNativeClose();
    } catch (error) {
      // An error is not a close: withdraw the authorization so the next native close is
      // checked again, and let the coordinator classify the rejection as `failed`.
      attempt.reset();
      throw error;
    }
    // The object minted by `beginCloseAttempt` is the active shape; the public interface only
    // promises the terminal outcome, and the bound has to ask whether it already settled.
    const running = attempt as ActiveCloseAttempt;
    const bound = setTimeout(() => {
      if (running.isSettled()) return;
      // `completeCloseAttempt`, not `settle`: a `'closed'` outcome owes the disposal audit
      // ("a shell never reports a closure whose disposal it has not seen"), while an
      // `'unknown'` one settles directly.
      this.completeCloseAttempt(running, this.window.isDestroyed() ? 'closed' : 'unknown');
    }, SHELL_CLOSE_OUTCOME_DEADLINE_MS);
    bound.unref?.();
    try {
      return await attempt.settled;
    } finally {
      clearTimeout(bound);
    }
  }

  /**
   * The platform asked to close this window. Only the running attempt's armed authorization
   * lets it through, and that authorization is consumed by exactly this request. Everything
   * else is refused synchronously and reported, so a native close can never destroy a shell
   * that policy has not cleared.
   */
  private handleNativeClose(event: Electron.Event): void {
    const attempt = this.activeCloseAttempt;
    if (attempt !== null && attempt.isAuthorized()) {
      attempt.consume();
      // Veto detection needs the final state of this dispatch, so it runs after every
      // listener for the close event has had its turn.
      queueMicrotask(() => { this.settleFromCloseDispatch(attempt, event); });
      return;
    }
    event.preventDefault();
    for (const listener of [...this.closeRequestListeners]) {
      try {
        listener(ownerKey(this.owner));
      } catch (error) {
        console.error('[project-window-shell] close-request listener failed:', error);
      }
    }
  }

  /**
   * Settle an authorized close dispatch. A close event nobody prevented is being carried out
   * by the platform, so the exact-instance `closed` observer settles this attempt; a close
   * event some other listener prevented is a veto, and the shell reports it instead of
   * overriding it.
   */
  private settleFromCloseDispatch(attempt: ActiveCloseAttempt, event: Electron.Event): void {
    if (attempt.isSettled()) return;
    if (this.window.isDestroyed()) {
      this.completeCloseAttempt(attempt, 'closed');
      return;
    }
    if (event.defaultPrevented) this.completeCloseAttempt(attempt, 'vetoed');
  }

  /**
   * A page or a chrome document asked to prevent its unload. The shell honors that veto: it
   * never calls `preventDefault()` on `will-prevent-unload`, because doing so would override
   * the veto and destroy the window against the page's will. Only a `will-prevent-unload`
   * belonging to a dispatched close can be this attempt's outcome: a veto that arrives before
   * any native close carries no terminal meaning, so it is ignored rather than reported.
   */
  private handlePreventUnload(attempt: ActiveCloseAttempt): void {
    if (attempt.isSettled() || !attempt.isCloseDispatched()) return;
    this.completeCloseAttempt(attempt, this.window.isDestroyed() ? 'closed' : 'vetoed');
  }

  private completeCloseAttempt(attempt: ActiveCloseAttempt, outcome: SurfaceCloseOutcome): void {
    if (attempt.isSettled()) return;
    if (outcome !== 'closed') {
      attempt.settle(outcome);
      return;
    }
    // The window is gone, so this attempt now owns the one question the platform does not
    // answer: whether the chrome this shell owned went with it. That audit decides when
    // `'closed'` is settled, so a shell never reports a closure whose disposal it has not seen.
    if (attempt.auditStarted) return;
    attempt.auditStarted = true;
    this.auditOwnContentsDisposed(attempt);
  }

  /**
   * Register this attempt's exact-instance observers before any native call. The `destroyed`
   * observers are the shell's own account of child-content disposal, because a closed window
   * does not prove its child `WebContentsView` contents were destroyed.
   *
   * The window's own document is observed alongside the chrome views: the window close is
   * what runs that document's unload, so a page that vetoes there must reach this attempt as
   * a veto instead of an open-ended wait.
   */
  private observeCloseAttempt(attempt: ActiveCloseAttempt): void {
    const onWindowClosed = (): void => { this.completeCloseAttempt(attempt, 'closed'); };
    this.window.once('closed', onWindowClosed);
    attempt.observers.push(() => { this.window.removeListener('closed', onWindowClosed); });

    for (const { contents } of this.ownedContents()) {
      if (this.isContentsDestroyed(contents)) continue;
      const id = contents.id;
      const onDestroyed = (): void => { attempt.observedDestroyed.add(id); };
      const onPreventUnload = (): void => { this.handlePreventUnload(attempt); };
      contents.on('destroyed', onDestroyed);
      contents.on('will-prevent-unload', onPreventUnload);
      attempt.observers.push(() => {
        contents.removeListener('destroyed', onDestroyed);
        contents.removeListener('will-prevent-unload', onPreventUnload);
      });
    }
  }

  /**
   * Every content this shell owns and is therefore accountable for: the window's own
   * document first, then its chrome views, each with the role it presents. Tab pages are
   * never here — the tab authority owns them.
   */
  private ownedContents(): Array<{ role: string; contents: Electron.WebContents }> {
    const views: Array<[string, WebContentsView | null]> = [
      ['toolbar', this.toolbarView],
      ['sidebar', this.sidebarView],
      ['frameBackdrop', this.frameBackdropView],
    ];
    const out: Array<{ role: string; contents: Electron.WebContents }> = [];
    try {
      const contents = this.window.webContents as Electron.WebContents | null | undefined;
      if (contents) out.push({ role: 'window', contents });
    } catch {
      // A window whose native object is gone cannot report its contents; the closure this
      // attempt observes is its own signal.
    }
    for (const [role, view] of views) {
      let contents: Electron.WebContents | null | undefined;
      try {
        contents = view?.webContents as Electron.WebContents | null | undefined;
      } catch {
        // A view whose native object is gone cannot be inspected; the window teardown path
        // already attempted its disposal.
        continue;
      }
      if (!contents) continue;
      out.push({ role, contents });
    }
    return out;
  }

  private isContentsDestroyed(contents: Electron.WebContents): boolean {
    try {
      return contents.isDestroyed();
    } catch {
      return true;
    }
  }

  /**
   * Every content this shell owned, including the ones disposal has already forgotten.
   * `disposeChrome()` nulls the chrome views out to signal "no surface", so reading them there
   * would answer for a shell that never had a sidebar — which is how a leaked sidebar stayed
   * invisible while the audit reported only the toolbar.
   */
  private everOwnedContents(): Array<{ role: string; contents: Electron.WebContents }> {
    const seen = new Set<number>();
    const out: Array<{ role: string; contents: Electron.WebContents }> = [];
    for (const entry of [...this.ownedContents(), ...this.disposedChrome]) {
      if (seen.has(entry.contents.id)) continue;
      seen.add(entry.contents.id);
      out.push(entry);
    }
    return out;
  }

  /**
   * Dispose this shell's chrome, then judge the result before settling `'closed'`.
   *
   * Two measured facts shape this. A window's own destruction never destroys its child
   * `WebContentsView` contents — this shell's disposal is the only thing that does — and that
   * disposal is not instantaneous (see `CHROME_DISPOSAL_SETTLE_MS`). The honest question is
   * therefore "what is still alive once the teardown has had its chance", asked of
   * `everOwnedContents()` so a surface disposal already forgot is still somebody's answer.
   */
  private auditOwnContentsDisposed(attempt: ActiveCloseAttempt): void {
    const owned = this.everOwnedContents();
    this.disposeChrome();
    const pending = owned.filter(({ contents }) => !this.isContentsDestroyed(contents));
    if (pending.length === 0) {
      attempt.settle('closed');
      return;
    }
    const deadline = Date.now() + CHROME_DISPOSAL_SETTLE_MS;
    const settleWhenDisposed = (): void => {
      const alive = pending.filter(({ contents }) => !this.isContentsDestroyed(contents));
      if (alive.length === 0) {
        attempt.settle('closed');
        return;
      }
      if (Date.now() < deadline) {
        setTimeout(settleWhenDisposed, 1);
        return;
      }
      // Every one of these outlived its own disposal: a leak in this process, never a
      // silent success, and never an error the shell swallows.
      console.error(
        `[project-window-shell] ${ownerLabel(this.owner)} closed with ${alive.length} content(s) still alive ` +
        `${CHROME_DISPOSAL_SETTLE_MS}ms after disposal: ` +
        `${alive.map(({ role, contents }) => `${role}#${contents.id}`).join(', ')} ` +
        `(contents that reported destroyed during the attempt: ${attempt.observedDestroyed.size})`
      );
      attempt.settle('closed');
    };
    settleWhenDisposed();
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    for (const listener of [...this.closedListeners]) {
      try {
        listener();
      } catch (error) {
        console.error('[project-window-shell] closed listener failed:', error);
      }
    }
  }

  /**
   * Destroy this shell's chrome surfaces. Only this window's own chrome is
   * touched; tab webContents and every shared service stay the authority's.
   */
  public disposeChrome(): void {
    if (this.chromeDisposed) return;
    this.chromeDisposed = true;

    const detach = (role: string, view: WebContentsView | null): void => {
      if (!view) return;
      let contents: (Electron.WebContents & { destroy?: () => void }) | null | undefined;
      try {
        contents = view.webContents as (Electron.WebContents & { destroy?: () => void }) | null | undefined;
      } catch {
        // A view whose native object is gone cannot be inspected; nothing is left to record
        // or to destroy for it.
        return;
      }
      // Remembered before the view is forgotten below: the shell's own `closed` listener
      // disposes the chrome before a close attempt audits it, so an audit that read the live
      // views alone could never see a sidebar or a backdrop that outlived its disposal.
      if (contents) this.disposedChrome.push({ role, contents });
      try {
        if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      } catch {}
      try {
        if (!contents || (typeof contents.isDestroyed === 'function' && contents.isDestroyed())) return;
        // Electron 43 exposes destroy() at runtime but omits it from the declaration;
        // chrome teardown is a hard teardown, matching the tab host's disposal path.
        if (typeof contents.destroy === 'function') contents.destroy();
        else contents.close();
      } catch {}
    };

    detach('sidebar', this.sidebarView);
    detach('frameBackdrop', this.frameBackdropView);
    detach('toolbar', this.toolbarView);
    this.sidebarView = null;
    this.frameBackdropView = null;
    this.toolbarView = null;
  }

  /**
   * Final teardown of this shell's own presentation: chrome views first, then
   * its window. The tab authority closes this window's pages before a shell is
   * disposed; this never presents, never touches another shell and never
   * disposes a shared service.
   */
  public dispose(): void {
    this.disposeChrome();
    this.displayChangeListeners.clear();
    try {
      this.window.removeListener('move', this.handleDisplayCandidate);
      this.window.removeListener('resize', this.handleDisplayCandidate);
      this.window.removeListener('maximize', this.handleDisplayCandidate);
      this.window.removeListener('unmaximize', this.handleDisplayCandidate);
      this.window.removeListener('restore', this.handleDisplayCandidate);
    } catch (err) {
      console.warn('[project-window-shell] Failed to detach display listeners:', err);
    }
    if (this.window.isDestroyed()) return;
    try {
      this.window.destroy();
    } catch (err) {
      console.error('[project-window-shell] Failed to destroy window:', err);
    }
  }
}
