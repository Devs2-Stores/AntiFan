/**
 * The two halves of the native-menubar retirement on shell windows:
 *
 * 1. `ProjectWindowShell.stripMenuBar()` retires `electron::MenuBar` — the only owner
 *    of the `RootView::RestoreFocus` calls that can be fed a stale
 *    `last_focused_view_tracker_` after a tab WebContentsView is reparented
 *    (`SetFocusedViewWithReason` CHECK `view && ContainsView(view)`; three identical
 *    minidumps at `electron.exe+0xe22b52`, 2026-10-07). Asserting `setMenu(null)`
 *    reached the window IS the regression pin.
 *
 * 2. `dispatchApplicationMenuShortcut` replays the chord set the menubar's
 *    accelerators owned, resolved through the sender's own host. Every row below
 *    mirrors a real accelerator in `buildApplicationMenu`; a chord that drifts
 *    silently drops a keyboard command users rely on.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import type { dispatchApplicationMenuShortcut } from '../../src/main/browser/app-menu';

type ShortcutDispatch = typeof dispatchApplicationMenuShortcut;

class StubMenu {
  public readonly items: unknown[] = [];
  public static buildFromTemplate(template: unknown[]): StubMenu {
    const menu = new StubMenu();
    menu.items.push(...template);
    return menu;
  }
}

function installElectronStub(): void {
  const stub = {
    app: { quit: () => undefined, relaunch: () => undefined, exit: () => undefined, on: () => undefined },
    dialog: { showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 2, showErrorBox: () => undefined },
    Menu: StubMenu,
    MenuItem: class {},
    BrowserWindow: class {},
    WebContentsView: class {},
    shell: { openExternal: async () => undefined },
    clipboard: { writeText: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false },
  };
  const electronPath = require.resolve('electron');
  const entry = new (require('node:module').Module)(electronPath);
  entry.loaded = true;
  entry.exports = stub;
  require.cache[electronPath] = entry;
}

installElectronStub();

const appMenu: { dispatchApplicationMenuShortcut: ShortcutDispatch } =
  require('../../src/main/browser/app-menu');

const { ProjectWindowShell } = require('../../src/main/browser/project-window-shell');

function key(input: Partial<Electron.Input> & { key: string }): Electron.Input {
  return {
    type: 'keyDown',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    ...input,
  } as Electron.Input;
}

interface FakeHost {
  calls: Array<[string, ...unknown[]]>;
  getActiveTabId: () => string;
  getTabList: () => Array<{ id: string; zoomFactor: number }>;
  createTab: (url?: string) => boolean;
  reopenClosedTab: () => boolean;
  closeTab: (tabId: string, source?: string) => boolean;
  captureScreenshot: () => boolean;
  reload: (tabId: string) => boolean;
  toggleBookmarkBar: () => boolean;
  toggleFullScreen: () => boolean;
  toggleDevTools: () => boolean;
  goBack: (tabId: string) => boolean;
  goForward: (tabId: string) => boolean;
  bookmarkActiveTab: () => boolean;
  toggleInspect: () => boolean;
  toggleLens: () => boolean;
  focusFindBar: () => boolean;
  toggleSidebar: () => boolean;
  reloadWindow: () => boolean;
  setZoom: (tabId: string, zoom: number) => boolean;
}

function fakeHost(): FakeHost {
  const calls: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); return true; };
  return {
    calls,
    getActiveTabId: () => 'tab-1',
    getTabList: () => [{ id: 'tab-1', zoomFactor: 1.0 }],
    createTab: record('createTab'),
    reopenClosedTab: record('reopenClosedTab'),
    closeTab: record('closeTab'),
    captureScreenshot: record('captureScreenshot'),
    reload: record('reload'),
    toggleBookmarkBar: record('toggleBookmarkBar'),
    toggleFullScreen: record('toggleFullScreen'),
    toggleDevTools: record('toggleDevTools'),
    goBack: record('goBack'),
    goForward: record('goForward'),
    bookmarkActiveTab: record('bookmarkActiveTab'),
    toggleInspect: record('toggleInspect'),
    toggleLens: record('toggleLens'),
    focusFindBar: record('focusFindBar'),
    toggleSidebar: record('toggleSidebar'),
    reloadWindow: record('reloadWindow'),
    setZoom: record('setZoom'),
  };
}

function dispatch(input: Electron.Input, host: FakeHost | null, options?: Record<string, unknown>): boolean {
  return appMenu.dispatchApplicationMenuShortcut(input, {
    host: host as never,
    window: null,
    sender: {} as Electron.WebContents,
    options: options as never,
  });
}

function called(host: FakeHost, name: string): unknown[][] {
  return host.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
}

describe('dispatchApplicationMenuShortcut replays the retired menubar chords', () => {
  it('Ctrl+T opens a tab against the sender host', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ control: true, key: 't' }), host), true);
    assert.deepStrictEqual(called(host, 'createTab'), [['https://www.google.com']]);
  });

  it('lowercase and uppercase letters resolve to the same accelerator', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ control: true, key: 'T' }), host), true);
    assert.strictEqual(dispatch(key({ control: true, key: 't' }), host), true);
    assert.strictEqual(called(host, 'createTab').length, 2);
  });

  it('Ctrl+Shift+T reopens a closed tab and never creates one', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ control: true, shift: true, key: 't' }), host), true);
    assert.deepStrictEqual(called(host, 'reopenClosedTab'), [[]]);
    assert.strictEqual(called(host, 'createTab').length, 0);
  });

  it('Ctrl+W closes the active tab through the same path the menu click used', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ control: true, key: 'w' }), host), true);
    assert.deepStrictEqual(called(host, 'closeTab'), [['tab-1', 'user-menu']]);
  });

  it('Alt+Left / Alt+Right drive history navigation', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ alt: true, key: 'Left' }), host), true);
    assert.strictEqual(dispatch(key({ alt: true, key: 'Right' }), host), true);
    assert.deepStrictEqual(called(host, 'goBack'), [['tab-1']]);
    assert.deepStrictEqual(called(host, 'goForward'), [['tab-1']]);
  });

  it('F5 reloads the active tab like the hidden menu item did', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ key: 'F5' }), host), true);
    assert.deepStrictEqual(called(host, 'reload'), [['tab-1']]);
  });

  it('zoom chords route through host.setZoom so state stays authoritative', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ control: true, key: '=' }), host), true);
    assert.deepStrictEqual(called(host, 'setZoom'), [['tab-1', 1.1]]);
    assert.strictEqual(dispatch(key({ control: true, key: '0' }), host), true);
    assert.deepStrictEqual(called(host, 'setZoom').at(-1), ['tab-1', 1.0]);
  });

  it('F12 and Ctrl+Shift+I both toggle devtools', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ key: 'F12' }), host), true);
    assert.strictEqual(dispatch(key({ control: true, shift: true, key: 'i' }), host), true);
    assert.strictEqual(called(host, 'toggleDevTools').length, 2);
  });

  it('Ctrl+Shift+O asks the injected picker, not a host method', () => {
    const host = fakeHost();
    const picked: unknown[] = [];
    assert.strictEqual(dispatch(key({ control: true, shift: true, key: 'o' }), host, {
      openProjectPicker: (window: unknown) => picked.push(window),
    }), true);
    assert.strictEqual(picked.length, 1);
  });

  it('Ctrl+Shift+M opens the shared terminal manager through the injected opener', () => {
    const host = fakeHost();
    const opened: unknown[] = [];
    assert.strictEqual(dispatch(key({ control: true, shift: true, key: 'm' }), host, {
      openSharedTerminalManager: (window: unknown) => opened.push(window),
    }), true);
    assert.strictEqual(opened.length, 1);
  });

  it('a registered chord stays consumed when the host cannot be resolved', () => {
    assert.strictEqual(dispatch(key({ control: true, key: 't' }), null), true);
    assert.strictEqual(dispatch(key({ key: 'F5' }), null), true);
  });

  it('keys outside the accelerator table pass through to the page', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ key: 'a' }), host), false);
    assert.strictEqual(dispatch(key({ control: true, key: 'a' }), host), false);
    assert.strictEqual(dispatch(key({ control: true, key: 'v' }), host), false);
    assert.strictEqual(host.calls.length, 0);
  });

  it('only keyDown dispatches — keyUp and char never fire commands', () => {
    const host = fakeHost();
    assert.strictEqual(dispatch(key({ type: 'keyUp', control: true, key: 't' }), host), false);
    assert.strictEqual(dispatch(key({ type: 'char', control: true, key: 't' }), host), false);
  });
});

describe('ProjectWindowShell.stripMenuBar retires electron::MenuBar', () => {
  function shellWith(window: Record<string, unknown>): { stripMenuBar: () => void } {
    const shell = Object.create(ProjectWindowShell.prototype) as Record<string, unknown>;
    shell.window = window;
    return shell as unknown as { stripMenuBar: () => void };
  }

  it('calls window.setMenu(null) on a live non-darwin window', () => {
    if (process.platform === 'darwin') return;
    let captured: unknown = 'unset';
    const shell = shellWith({
      isDestroyed: () => false,
      setMenu: (menu: unknown) => { captured = menu; },
    });
    shell.stripMenuBar();
    assert.strictEqual(captured, null, 'the native menubar object must be retired');
  });

  it('leaves a destroyed window untouched', () => {
    let calls = 0;
    const shell = shellWith({
      isDestroyed: () => true,
      setMenu: () => { calls += 1; },
    });
    shell.stripMenuBar();
    assert.strictEqual(calls, 0);
  });

  it('tolerates doubles that do not implement setMenu', () => {
    const shell = shellWith({ isDestroyed: () => false });
    assert.doesNotThrow(() => shell.stripMenuBar());
  });
});
