/**
 * Presentation double for NativeTabHost harnesses.
 *
 * The host reads its window, chrome views and sidebar state from its
 * ProjectWindowShell. Unit harnesses run without Electron, so they need a shell
 * shaped object that carries the pieces the host actually touches: the window
 * (with its contentView child list), the chrome views, the sidebar state, and the
 * geometry helpers the host delegates to.
 *
 * This is deliberately a double, not a reimplementation: every geometry method
 * mirrors the production formulas so a harness that exercises layout sees the
 * same numbers a real shell would produce.
 */
import type { ChromeSurface, ProjectWindowShell, ShellContentGeometry } from '../../src/main/browser/project-window-shell';
import { TOOLBAR_HEIGHT_COMPACT, TOOLBAR_HEIGHT_WITH_BOOKMARKS } from '../../src/main/browser/project-window-shell';

/** The chrome view surface the host reaches: bounds application and a webContents handle. */
export interface ShellDoubleView {
  webContents: ShellDoubleWebContents;
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
  setBackgroundColor?(color: string): void;
}

export interface ShellDoubleWebContents {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  executeJavaScript?(code: string): Promise<unknown>;
}

/** The window surface the host reaches: identity, geometry and its contentView child list. */
export interface ShellDoubleWindow {
  isDestroyed(): boolean;
  getBounds(): { x: number; y: number; width: number; height: number };
  getContentBounds(): { x: number; y: number; width: number; height: number };
  contentView: {
    children: unknown[];
    addChildView(view: unknown, index?: number): void;
    removeChildView(view: unknown): void;
  };
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
}

export interface ShellDoubleOptions {
  window?: ShellDoubleWindow;
  toolbarView?: ShellDoubleView | null;
  frameBackdropView?: ShellDoubleView | null;
  sidebarView?: ShellDoubleView | null;
  isSidebarOpen?: boolean;
  sidebarWidth?: number;
  contentBounds?: { x?: number; y?: number; width: number; height: number };
}

export interface ShellDouble {
  window: ShellDoubleWindow;
  toolbarView: ShellDoubleView | null;
  frameBackdropView: ShellDoubleView | null;
  sidebarView: ShellDoubleView | null;
  isSidebarOpen: boolean;
  /** The title the window last carried; `retitle` mirrors the real shell's non-blank rule. */
  title: string;
  retitle(title: string): void;
  sidebarWidth: number;
  getToolbarHeight(hasBookmarks: boolean, bookmarkBarVisible: boolean): number;
  getContentGeometry(toolbarHeight: number): ShellContentGeometry | undefined;
  /** Same rule as the real shell: only an unassigned owner is the terminal-only manager window. */
  isTerminalOnly(): boolean;
  applyChromeBounds(geometry: ShellContentGeometry, toolbarOverlay: { active: boolean; extraHeight: number }): void;
  /**
   * Which chrome surface a webContents is, in production's own precedence. A host that has to
   * tell a chrome sender from a page sender (close admission attribution) reads this rather
   * than a membership boolean, so the double answers with the surface name the real shell does.
   */
  chromeSurfaceFor(webContentsId: number): ChromeSurface | undefined;
  ownsChromeWebContents(webContentsId: number): boolean;
  onResize(listener: () => void): void;
  onShow(listener: () => void): void;
  onRestore(listener: () => void): void;
  onFocus(listener: () => void): void;
  onBlur(listener: () => void): void;
  disposeChrome(): void;
}

function createView(webContentsId: number): ShellDoubleView {
  return {
    webContents: {
      id: webContentsId,
      isDestroyed: () => false,
      send: () => {},
      executeJavaScript: async () => undefined,
    },
    setBounds: () => {},
    setBackgroundColor: () => {},
  };
}

function createWindow(contentBounds: { x: number; y: number; width: number; height: number }): ShellDoubleWindow {
  const children: unknown[] = [];
  return {
    isDestroyed: () => false,
    getBounds: () => contentBounds,
    getContentBounds: () => contentBounds,
    contentView: {
      children,
      addChildView: (view: unknown, index?: number) => {
        const existing = children.indexOf(view);
        if (existing >= 0) children.splice(existing, 1);
        if (typeof index === 'number') children.splice(Math.max(0, Math.min(index, children.length)), 0, view);
        else children.push(view);
      },
      removeChildView: (view: unknown) => {
        const existing = children.indexOf(view);
        if (existing >= 0) children.splice(existing, 1);
      },
    },
    on: () => {},
    removeListener: () => {},
  };
}

export function createShellDouble(options: ShellDoubleOptions = {}): ProjectWindowShell {
  const requested = options.contentBounds ?? { x: 0, y: 0, width: 1440, height: 900 };
  const contentBounds = { x: requested.x ?? 0, y: requested.y ?? 0, width: requested.width, height: requested.height };
  const window = options.window ?? createWindow(contentBounds);
  const toolbarView = options.toolbarView ?? createView(-1);
  const frameBackdropView = options.frameBackdropView ?? null;
  const sidebarView = options.sidebarView ?? null;
  const shell: ShellDouble = {
    window,
    toolbarView,
    frameBackdropView,
    sidebarView,
    isSidebarOpen: options.isSidebarOpen ?? false,
    title: '',
    retitle(title: string): void {
      if (typeof title === 'string' && title.trim()) shell.title = title.trim();
    },
    sidebarWidth: options.sidebarWidth ?? 380,
    getToolbarHeight(hasBookmarks: boolean, bookmarkBarVisible: boolean): number {
      return bookmarkBarVisible && hasBookmarks ? TOOLBAR_HEIGHT_WITH_BOOKMARKS : TOOLBAR_HEIGHT_COMPACT;
    },
    isTerminalOnly(): boolean {
      return (shell as unknown as { owner?: { kind?: string } }).owner?.kind === 'unassigned';
    },
    getContentGeometry(toolbarHeight: number): ShellContentGeometry {
      const bounds = window.getContentBounds();
      const availableWidth = shell.isSidebarOpen ? Math.max(400, bounds.width - shell.sidebarWidth) : bounds.width;
      return {
        width: bounds.width,
        height: bounds.height,
        toolbarHeight,
        availableWidth,
        availableHeight: Math.max(0, bounds.height - toolbarHeight),
        sidebarActualWidth: bounds.width - availableWidth,
      };
    },
    applyChromeBounds(geometry: ShellContentGeometry, toolbarOverlay: { active: boolean; extraHeight: number }): void {
      if (frameBackdropView) {
        frameBackdropView.setBounds({ x: 0, y: geometry.toolbarHeight, width: geometry.availableWidth, height: geometry.availableHeight });
      }
      const overlayHeight = toolbarOverlay.active
        ? (toolbarOverlay.extraHeight > 0 ? Math.min(geometry.height, geometry.toolbarHeight + toolbarOverlay.extraHeight) : geometry.height)
        : geometry.toolbarHeight;
      toolbarView.setBounds({ x: 0, y: 0, width: geometry.availableWidth, height: overlayHeight });
      if (sidebarView) {
        sidebarView.setBounds(
          shell.isSidebarOpen && geometry.sidebarActualWidth > 0
            ? { x: geometry.availableWidth, y: 0, width: geometry.sidebarActualWidth, height: geometry.height }
            : { x: geometry.width, y: 0, width: 0, height: 0 },
        );
      }
    },
    chromeSurfaceFor(webContentsId: number): ChromeSurface | undefined {
      // Read through the shell object, not the construction options: a harness that seats a
      // chrome view on `host.shell` after building the double must be able to make a sender
      // chrome, exactly as the host reads it in production.
      if (shell.toolbarView?.webContents?.id === webContentsId) return 'toolbar';
      if (shell.frameBackdropView?.webContents?.id === webContentsId) return 'frameBackdrop';
      if (shell.sidebarView?.webContents?.id === webContentsId) return 'sidebar';
      return undefined;
    },
    ownsChromeWebContents(webContentsId: number): boolean {
      return this.chromeSurfaceFor(webContentsId) !== undefined;
    },
    onResize: () => {},
    onShow: () => {},
    onRestore: () => {},
    onFocus: () => {},
    onBlur: () => {},
    disposeChrome: () => {},
  };
  // Reason: the host only reads these presentation members, and the real shell's
  // private fields make it structurally incompatible with this double.
  return shell as unknown as ProjectWindowShell;
}
