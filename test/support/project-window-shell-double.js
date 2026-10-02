"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createShellDouble = createShellDouble;
const project_window_shell_1 = require("../../src/main/browser/project-window-shell");
function createView(webContentsId) {
    return {
        webContents: {
            id: webContentsId,
            isDestroyed: () => false,
            send: () => { },
            executeJavaScript: async () => undefined,
        },
        setBounds: () => { },
        setBackgroundColor: () => { },
    };
}
function createWindow(contentBounds) {
    const children = [];
    return {
        isDestroyed: () => false,
        getBounds: () => contentBounds,
        getContentBounds: () => contentBounds,
        contentView: {
            children,
            addChildView: (view, index) => {
                const existing = children.indexOf(view);
                if (existing >= 0)
                    children.splice(existing, 1);
                if (typeof index === 'number')
                    children.splice(Math.max(0, Math.min(index, children.length)), 0, view);
                else
                    children.push(view);
            },
            removeChildView: (view) => {
                const existing = children.indexOf(view);
                if (existing >= 0)
                    children.splice(existing, 1);
            },
        },
        on: () => { },
        removeListener: () => { },
    };
}
function createShellDouble(options = {}) {
    const requested = options.contentBounds ?? { x: 0, y: 0, width: 1440, height: 900 };
    const contentBounds = { x: requested.x ?? 0, y: requested.y ?? 0, width: requested.width, height: requested.height };
    const window = options.window ?? createWindow(contentBounds);
    const toolbarView = options.toolbarView ?? createView(-1);
    const frameBackdropView = options.frameBackdropView ?? null;
    const sidebarView = options.sidebarView ?? null;
    const shell = {
        window,
        toolbarView,
        frameBackdropView,
        sidebarView,
        isSidebarOpen: options.isSidebarOpen ?? false,
        title: '',
        retitle(title) {
            if (typeof title === 'string' && title.trim())
                shell.title = title.trim();
        },
        sidebarWidth: options.sidebarWidth ?? 380,
        getToolbarHeight(hasBookmarks, bookmarkBarVisible) {
            return bookmarkBarVisible && hasBookmarks ? project_window_shell_1.TOOLBAR_HEIGHT_WITH_BOOKMARKS : project_window_shell_1.TOOLBAR_HEIGHT_COMPACT;
        },
        isTerminalOnly() {
            return shell.owner?.kind === 'unassigned';
        },
        getContentGeometry(toolbarHeight) {
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
        applyChromeBounds(geometry, toolbarOverlay) {
            if (frameBackdropView) {
                frameBackdropView.setBounds({ x: 0, y: geometry.toolbarHeight, width: geometry.availableWidth, height: geometry.availableHeight });
            }
            const overlayHeight = toolbarOverlay.active
                ? (toolbarOverlay.extraHeight > 0 ? Math.min(geometry.height, geometry.toolbarHeight + toolbarOverlay.extraHeight) : geometry.height)
                : geometry.toolbarHeight;
            toolbarView.setBounds({ x: 0, y: 0, width: geometry.availableWidth, height: overlayHeight });
            if (sidebarView) {
                sidebarView.setBounds(shell.isSidebarOpen && geometry.sidebarActualWidth > 0
                    ? { x: geometry.availableWidth, y: 0, width: geometry.sidebarActualWidth, height: geometry.height }
                    : { x: geometry.width, y: 0, width: 0, height: 0 });
            }
        },
        chromeSurfaceFor(webContentsId) {
            // Read through the shell object, not the construction options: a harness that seats a
            // chrome view on `host.shell` after building the double must be able to make a sender
            // chrome, exactly as the host reads it in production.
            if (shell.toolbarView?.webContents?.id === webContentsId)
                return 'toolbar';
            if (shell.frameBackdropView?.webContents?.id === webContentsId)
                return 'frameBackdrop';
            if (shell.sidebarView?.webContents?.id === webContentsId)
                return 'sidebar';
            return undefined;
        },
        ownsChromeWebContents(webContentsId) {
            return this.chromeSurfaceFor(webContentsId) !== undefined;
        },
        onResize: () => { },
        onShow: () => { },
        onRestore: () => { },
        onFocus: () => { },
        onBlur: () => { },
        disposeChrome: () => { },
    };
    // Reason: the host only reads these presentation members, and the real shell's
    // private fields make it structurally incompatible with this double.
    return shell;
}
