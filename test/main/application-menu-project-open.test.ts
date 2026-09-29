/**
 * The application menu's two window-opening entries: File's "Mở dự án…" and Terminal's
 * "Cửa sổ Terminal chung (Shared Terminal Manager)".
 *
 * A project window is the only window this build boots, and the sidebar chip that asks Main
 * to open a project is therefore the *only* project entry the user could reach — which is
 * why the menu carries one too, on the window the user actually clicked in. The Unassigned
 * manager shell has no chrome entry at all, so the Terminal entry is its only door. The menu
 * cannot build itself outside Electron, so the transport is stubbed while the template, the
 * click routing and the injected openers stay the production paths.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import type { BrowserWindow } from 'electron';
import type { buildApplicationMenu } from '../../src/main/browser/app-menu';

interface CapturedItem {
  label?: string;
  accelerator?: string;
  enabled?: boolean;
  type?: string;
  click?: (item?: unknown, window?: unknown, event?: unknown) => void;
  submenu?: CapturedItem[];
}

let capturedTemplates: CapturedItem[][] = [];

class StubMenu {
  public readonly items: CapturedItem[] = [];

  public append(item: CapturedItem): void {
    this.items.push(item);
  }

  public static buildFromTemplate(template: CapturedItem[]): StubMenu {
    capturedTemplates.push(template);
    const menu = new StubMenu();
    menu.items.push(...template);
    return menu;
  }
}

class StubMenuItem {
  constructor(options: CapturedItem) {
    Object.assign(this, options);
  }
}

/**
 * The Electron stand-in the menu module captures at load time. Installed before the module
 * is required, because `app-menu.ts` imports `electron` at module scope.
 */
function installElectronStub(): void {
  const stub = {
    app: { quit: () => undefined, relaunch: () => undefined, exit: () => undefined },
    dialog: { showMessageBox: async () => ({ response: 0 }), showMessageBoxSync: () => 2, showErrorBox: () => undefined },
    Menu: StubMenu,
    MenuItem: StubMenuItem,
    BrowserWindow: class {},
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

const appMenu: { buildApplicationMenu: typeof buildApplicationMenu } = require('../../src/main/browser/app-menu');

function fileItems(): CapturedItem[] {
  const template = capturedTemplates[capturedTemplates.length - 1];
  assert.ok(template, 'a menu template must have been captured');
  const file = template.find((item) => item.label === 'File');
  assert.ok(file?.submenu, 'the File section must be a submenu');
  return file.submenu;
}

function openProjectItem(): CapturedItem {
  const item = fileItems().find((entry) => entry.label === 'Mở dự án…');
  assert.ok(item, 'the File menu must offer "Mở dự án…"');
  return item;
}

function terminalItems(): CapturedItem[] {
  const template = capturedTemplates[capturedTemplates.length - 1];
  assert.ok(template, 'a menu template must have been captured');
  const terminal = template.find((item) => item.label === 'Terminal');
  assert.ok(terminal?.submenu, 'the Terminal section must be a submenu');
  return terminal.submenu;
}

function sharedManagerItem(): CapturedItem {
  const item = terminalItems().find((entry) => entry.label === 'Cửa sổ Terminal chung (Shared Terminal Manager)');
  assert.ok(item, 'the Terminal menu must offer the shared Terminal Manager window');
  return item;
}

const hostDouble = { createTab: () => 'tab-created' };

describe('application menu: Mở dự án…', () => {
  it('offers the entry with a free accelerator, and hands the picker the window the user clicked in', () => {
    const asked: Array<BrowserWindow | null> = [];
    capturedTemplates = [];

    appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, hostDouble as never, {
      openProjectPicker: (window) => asked.push(window),
    });

    const item = openProjectItem();
    assert.strictEqual(item.accelerator, 'CmdOrCtrl+Shift+O', 'the entry needs a shortcut the user can learn');
    assert.notStrictEqual(item.enabled, false, 'an injected picker makes the entry usable');

    const windowB = { id: 2 } as unknown as BrowserWindow;
    item.click?.(undefined, windowB);
    assert.deepStrictEqual(asked, [windowB], 'the picker is told which window asked, so its dialog can be modal to it');
  });

  it('stays inert and visibly disabled when no picker is injected', () => {
    capturedTemplates = [];

    appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, hostDouble as never);

    const item = openProjectItem();
    assert.strictEqual(item.enabled, false, 'a menu entry that cannot open a project must not look available');
    assert.doesNotThrow(() => item.click?.(undefined, { id: 2 }));
  });

  it('does not disturb the tab commands that already live in File', () => {
    capturedTemplates = [];
    appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, hostDouble as never, {
      openProjectPicker: () => undefined,
    });

    const labels = fileItems().map((item) => item.label ?? item.type);
    assert.deepStrictEqual(labels.slice(0, 4), ['Mở dự án…', 'separator', 'New Tab', 'Reopen Closed Tab']);
  });
});

describe('application menu: Cửa sổ Terminal chung (Shared Terminal Manager)', () => {
  it('offers the entry with a free accelerator, and hands the opener the window the user clicked in', () => {
    const asked: Array<BrowserWindow | null> = [];
    capturedTemplates = [];

    appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, hostDouble as never, {
      openSharedTerminalManager: (window) => asked.push(window),
    });

    const item = sharedManagerItem();
    assert.strictEqual(item.accelerator, 'CmdOrCtrl+Shift+M', 'the manager window needs a shortcut the user can learn');
    assert.notStrictEqual(item.enabled, false, 'an injected opener makes the entry usable');

    const windowB = { id: 2 } as unknown as BrowserWindow;
    item.click?.(undefined, windowB);
    assert.deepStrictEqual(asked, [windowB], 'the opener is told which window the user clicked in');
  });

  it('stays inert and visibly disabled when no opener is injected', () => {
    capturedTemplates = [];

    appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, hostDouble as never);

    const item = sharedManagerItem();
    assert.strictEqual(item.enabled, false, 'a menu entry that cannot open the manager must not look available');
    assert.doesNotThrow(() => item.click?.(undefined, { id: 2 }));
  });

  it('keeps the sidebar toggles and has no per-window terminal pop-out: the manager is the one terminal window', () => {
    capturedTemplates = [];
    appMenu.buildApplicationMenu({ id: 1 } as unknown as BrowserWindow, hostDouble as never, {
      openSharedTerminalManager: () => undefined,
    });

    const labels = terminalItems().map((item) => item.label ?? item.type);
    assert.deepStrictEqual(labels, [
      'Cửa sổ Terminal chung (Shared Terminal Manager)',
      'separator',
      'Toggle Sidebar Terminal',
      'Toggle Terminal Workbench',
    ]);
  });
});
