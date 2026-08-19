import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Webview & Extension IPC Audit Invariants', () => {
  const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..');

  it('verifies Message Contract parity across native-tab-host and shared contracts', () => {
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    assert.ok(fs.existsSync(nativeTabHostPath), `native-tab-host.ts must exist at ${nativeTabHostPath}`);
    const content = fs.readFileSync(nativeTabHostPath, 'utf8');

    // Check critical toolbar handlers
    const requiredToolbarChannels = [
      'TOOLBAR_CHANNELS.CREATE_TAB',
      'TOOLBAR_CHANNELS.SWITCH_TAB',
      'TOOLBAR_CHANNELS.CLOSE_TAB',
      'TOOLBAR_CHANNELS.MOVE_TAB',
      'TOOLBAR_CHANNELS.NAVIGATE',
      'TOOLBAR_CHANNELS.RELOAD',
      'TOOLBAR_CHANNELS.STOP_LOADING',
      'TOOLBAR_CHANNELS.GO_BACK',
      'TOOLBAR_CHANNELS.GO_FORWARD',
      'TOOLBAR_CHANNELS.TOGGLE_INSPECT',
      'TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER',
      'TOOLBAR_CHANNELS.TOGGLE_LENS',
      'TOOLBAR_CHANNELS.TOGGLE_RULER',
      'TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS',
      'TOOLBAR_CHANNELS.TOGGLE_TERMINAL',
      'TOOLBAR_CHANNELS.TOGGLE_SIDEBAR',
      'TOOLBAR_CHANNELS.SET_DEVICE_PRESET',
      'TOOLBAR_CHANNELS.SET_ZOOM',
      'TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE',
      'TOOLBAR_CHANNELS.CAPTURE_VIEWPORT',
      'TOOLBAR_CHANNELS.OPEN_EXTERNAL',
      'TOOLBAR_CHANNELS.TOGGLE_BOOKMARK',
      'TOOLBAR_CHANNELS.FIND_IN_PAGE',
      'TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE',
      'TOOLBAR_CHANNELS.SHOW_MENU',
      'TOOLBAR_CHANNELS.SET_OVERLAY',
      'TOOLBAR_CHANNELS.CLEAR_STORAGE',
      'TOOLBAR_CHANNELS.GET_CHROME_PROFILES',
      'TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE',
      'TOOLBAR_CHANNELS.TOGGLE_BOOKMARK_BAR',
      'TOOLBAR_CHANNELS.ADD_BOOKMARK',
      'TOOLBAR_CHANNELS.GET_SUGGESTIONS',
      'TOOLBAR_CHANNELS.REMOVE_BOOKMARK',
    ];

    for (const channel of requiredToolbarChannels) {
      assert.ok(
        content.includes(`ipcMain.handle(${channel}`) || content.includes(`ipcMain.on(${channel}`),
        `Missing IPC handler for ${channel} in native-tab-host.ts`
      );
    }

    // Check critical sidebar handlers
    const requiredSidebarChannels = [
      'SIDEBAR_CHANNELS.GET_INITIAL_STATE',
      'SIDEBAR_CHANNELS.SEND_PROMPT',
      'SIDEBAR_CHANNELS.CLEAR_HISTORY',
      'SIDEBAR_CHANNELS.CLOSE_SIDEBAR',
      'SIDEBAR_CHANNELS.SET_WIDTH',
      'SIDEBAR_CHANNELS.GET_SESSIONS',
      'SIDEBAR_CHANNELS.SWITCH_SESSION',
      'SIDEBAR_CHANNELS.RENAME_SESSION',
      'SIDEBAR_CHANNELS.DELETE_SESSION',
    ];

    for (const channel of requiredSidebarChannels) {
      assert.ok(
        content.includes(`ipcMain.handle(${channel}`),
        `Missing IPC handler for ${channel} in native-tab-host.ts`
      );
    }

    // Check critical terminal channels
    const requiredTerminalChannels = [
      'TERMINAL_CHANNELS.START',
      'TERMINAL_CHANNELS.INPUT',
      'TERMINAL_CHANNELS.KILL',
      'TERMINAL_CHANNELS.RESTART',
    ];

    for (const channel of requiredTerminalChannels) {
      assert.ok(
        content.includes(`ipcMain.handle(${channel}`),
        `Missing IPC handler for ${channel} in native-tab-host.ts`
      );
    }
  });

  it('scans renderer HTML templates for dead or duplicate script tags', () => {
    const htmlFiles = [
      path.join(root, 'src', 'renderer', 'toolbar.html'),
      path.join(root, 'src', 'renderer', 'sidebar.html'),
      path.join(root, 'src', 'renderer', 'terminal.html'),
    ];

    for (const file of htmlFiles) {
      assert.ok(fs.existsSync(file), `HTML file ${file} must exist`);
      const html = fs.readFileSync(file, 'utf8');
      const externalScriptTags = html.match(/<script\b[^>]*src=[\s\S]*?<\/script>/gi) || [];
      // Each view should have exactly 1 primary script entry tag
      assert.ok(externalScriptTags.length <= 1, `File ${file} has multiple external script tags: ${externalScriptTags.length}`);
    }
  });

  it('audits static event listeners to ensure no duplicate bindings on tool buttons', () => {
    const toolbarTsPath = path.join(root, 'src', 'renderer', 'toolbar.ts');
    assert.ok(fs.existsSync(toolbarTsPath), `toolbar.ts must exist at ${toolbarTsPath}`);
    const toolbarTs = fs.readFileSync(toolbarTsPath, 'utf8');

    // Extract all direct addEventListener calls on known button variables
    const checkButtons = [
      'btnQuickInspect',
      'btnFontFinder',
      'btnRuler',
      'btnCaptureFullPage',
      'btnDevTools',
      'btnToggleSidebar',
      'btnToggleTerminal',
      'btnNewTab',
      'btnBack',
      'btnForward',
      'btnReload',
      'btnStarBookmark',
    ];

    for (const btn of checkButtons) {
      const regex = new RegExp(`\\b${btn}\\s*\\?\\.addEventListener|if\\s*\\(${btn}\\)\\s*${btn}\\.addEventListener`, 'g');
      const matches = toolbarTs.match(regex) || [];
      assert.ok(
        matches.length <= 1,
        `Button variable ${btn} has duplicate addEventListener bindings (${matches.length}) in toolbar.ts`
      );
    }
  });
});
