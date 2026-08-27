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
      'SIDEBAR_CHANNELS.CLOSE_SIDEBAR',
      'SIDEBAR_CHANNELS.SET_WIDTH',
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
      path.join(root, 'src', 'renderer', 'standalone.html'),
      path.join(root, 'src', 'renderer', 'terminal.html'),
    ];

    for (const file of htmlFiles) {
      assert.ok(fs.existsSync(file), `HTML file ${file} must exist`);
      const html = fs.readFileSync(file, 'utf8');
      const externalScriptTags = html.match(/<script\b[^>]*src=[\s\S]*?<\/script>/gi) || [];
      assert.ok(externalScriptTags.length >= 1, `File ${file} should have external script tags`);
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

  it('verifies standalone and toolbar IPC surface bindings', () => {
    const standalonePreloadPath = path.join(root, 'src', 'preload', 'standalone-preload.ts');
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');

    const preloadContent = fs.readFileSync(standalonePreloadPath, 'utf8');
    const nativeContent = fs.readFileSync(nativeTabHostPath, 'utf8');

    assert.match(preloadContent, /antifan:standalone:open-workspace/);
    assert.match(preloadContent, /antifan:terminal:new-session/);
    assert.match(nativeContent, /antifan:standalone:open-workspace/);
    assert.match(nativeContent, /antifan:terminal:new-session/);
    assert.match(preloadContent, /pickWorkspaceFolder:\s*\(sessionId\?: string\).*\{ sessionId \}/);
    assert.match(nativeContent, /capsule:pick-folder[^]*setCapsule\(created\.id, chosenPath, opts\?\.sessionId\)/);
  });

  it('verifies Find in Page DOM ID parity, IPC contracts, and shortcut prevention', () => {
    const toolbarHtmlPath = path.join(root, 'src', 'renderer', 'toolbar.html');
    const toolbarTsPath = path.join(root, 'src', 'renderer', 'toolbar.ts');
    const preloadPath = path.join(root, 'src', 'preload', 'toolbar-preload.ts');
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');

    const toolbarHtml = fs.readFileSync(toolbarHtmlPath, 'utf8');
    const toolbarTs = fs.readFileSync(toolbarTsPath, 'utf8');
    const preload = fs.readFileSync(preloadPath, 'utf8');
    const nativeTabHost = fs.readFileSync(nativeTabHostPath, 'utf8');

    // 1. HTML element IDs exist
    assert.ok(toolbarHtml.includes('id="findBar"'), 'toolbar.html must define findBar');
    assert.ok(toolbarHtml.includes('id="findInput"'), 'toolbar.html must define findInput');
    assert.ok(toolbarHtml.includes('id="findCount"'), 'toolbar.html must define findCount');
    assert.ok(toolbarHtml.includes('id="btnFindPrev"'), 'toolbar.html must define btnFindPrev');
    assert.ok(toolbarHtml.includes('id="btnFindNext"'), 'toolbar.html must define btnFindNext');
    assert.ok(toolbarHtml.includes('id="btnFindClose"'), 'toolbar.html must define btnFindClose');

    // 2. TypeScript queries matching IDs
    assert.ok(toolbarTs.includes("document.getElementById('btnFindPrev')"), 'toolbar.ts must query btnFindPrev');
    assert.ok(toolbarTs.includes("document.getElementById('btnFindNext')"), 'toolbar.ts must query btnFindNext');
    assert.ok(toolbarTs.includes("document.getElementById('btnFindClose')"), 'toolbar.ts must query btnFindClose');

    // 3. Preload & IPC contracts pass findNext
    assert.match(preload, /findInPage:\s*\(text:\s*string,\s*forward\s*=\s*true,\s*findNext\s*=\s*false\)/);
    assert.match(nativeTabHost, /FIND_IN_PAGE[^]*findNext/);

    // 4. CmdOrCtrl+F is registered in app-menu and triggers focusFindBar
    const appMenu = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'app-menu.ts'), 'utf8');
    assert.match(appMenu, /accelerator:\s*['"]CmdOrCtrl\+F['"][^]*tabHost\?\.focusFindBar\(\)/);
    assert.match(nativeTabHost, /focusFindBar\s*\(\)\s*:\s*void\s*\{[^}]*antifan:focus-find/);
    // 5. Overlay lifecycle in show/hide find bar
    assert.match(toolbarTs, /function showFindBar\(\)[^]*getApi\(\)\?\.setOverlay\(true,\s*50\)/);
    assert.match(toolbarTs, /function hideFindBar\(\)[^]*getApi\(\)\?\.setOverlay\(false\)/);
  });

  it('verifies search suggestion encoding uses standard UTF-8 parameters and charset fallback', () => {
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    const nativeTabHost = fs.readFileSync(nativeTabHostPath, 'utf8');

    assert.match(
      nativeTabHost,
      /suggestqueries\.google\.com\/complete\/search\?[^`]*ie=utf-8&oe=utf-8/,
      'Google suggest query must use standard hyphenated ie=utf-8&oe=utf-8 parameters'
    );
    assert.match(
      nativeTabHost,
      /TextDecoder\('utf-8'/,
      'Must decode search suggestions with UTF-8 TextDecoder'
    );
  });

  it('verifies Omnibox Suggest dropdown DOM parity, overlay lifecycle, and focus trigger', () => {
    const toolbarHtmlPath = path.join(root, 'src', 'renderer', 'toolbar.html');
    const toolbarTsPath = path.join(root, 'src', 'renderer', 'toolbar.ts');
    const toolbarHtml = fs.readFileSync(toolbarHtmlPath, 'utf8');
    const toolbarTs = fs.readFileSync(toolbarTsPath, 'utf8');

    // 1. DOM IDs exist in toolbar.html
    assert.ok(toolbarHtml.includes('id="omniboxSuggestDropdown"'), 'toolbar.html must define omniboxSuggestDropdown');
    assert.ok(toolbarHtml.includes('id="omniboxSuggestList"'), 'toolbar.html must define omniboxSuggestList');

    // 2. TypeScript queries matching IDs
    assert.ok(toolbarTs.includes("document.getElementById('omniboxSuggestDropdown')"), 'toolbar.ts must query omniboxSuggestDropdown');
    assert.ok(toolbarTs.includes("document.getElementById('omniboxSuggestList')"), 'toolbar.ts must query omniboxSuggestList');

    // 3. Overlay lifecycle when showing and hiding suggest dropdown
    assert.match(toolbarTs, /omniboxSuggestDropdown\.style\.display\s*=\s*'block'[^]*getApi\(\)\?\.setOverlay\(true,\s*420\)/);
    assert.match(toolbarTs, /function hideSuggestDropdown\(\)[^]*omniboxSuggestDropdown\.style\.display\s*=\s*'none'[^]*getApi\(\)\?\.setOverlay\(false\)/);

    // 4. Must NOT immediately close the suggest dropdown after showing it
    assert.doesNotMatch(
      toolbarTs,
      /omniboxSuggestDropdown\.style\.display\s*=\s*'block';\s*getApi\(\)\?\.setOverlay\(true,\s*420\);\s*hideSuggestDropdown\(\);/,
      'Must not call hideSuggestDropdown immediately after opening dropdown'
    );
  });

  it('verifies tab host handles WebContents close, destroyed, and OAuth window open events', () => {
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    const nativeTabHost = fs.readFileSync(nativeTabHostPath, 'utf8');

    // 1. WebContents close event must invoke closeTab
    assert.match(
      nativeTabHost,
      /\.on\('close',\s*\(\)\s*=>\s*\{[^}]*this\.closeTab\(id\)/,
      'Must handle wc close event to close tab on window.close()'
    );

    // 2. WebContents destroyed event must clean up tab
    assert.match(
      nativeTabHost,
      /wc\.on\('destroyed',\s*\(\)\s*=>\s*\{[^}]*this\.closeTab\(id\)/,
      'Must handle wc destroyed event to clean up tab'
    );

    // 3. Window open handler must delegate to OAuthPopupManager
    assert.match(
      nativeTabHost,
      /OAuthPopupManager\.getInstance\(\)\.handleWindowOpen/,
      'Must delegate window.open calls to OAuthPopupManager'
    );
  });

  it('enforces single authority for shortcuts: app-menu owns menu accelerators with no duplicate accelerators, native-tab-host owns non-menu WebContents shortcuts with zero overlap', () => {
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    const nativeTabHost = fs.readFileSync(nativeTabHostPath, 'utf8');

    const appMenuPath = path.join(root, 'src', 'main', 'browser', 'app-menu.ts');
    const appMenu = fs.readFileSync(appMenuPath, 'utf8');

    // 1. Extract and assert uniqueness of all accelerator literals in app-menu.ts
    const acceleratorRegex = /accelerator:\s*['"]([^'"]+)['"]/g;
    const foundAccelerators: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = acceleratorRegex.exec(appMenu)) !== null) {
      foundAccelerators.push(match[1]!);
    }

    // Frequency map of every accelerator in app-menu.ts
    const counts = new Map<string, number>();
    for (const acc of foundAccelerators) {
      counts.set(acc, (counts.get(acc) || 0) + 1);
    }

    // Every accelerator present in app-menu must have an occurrence count of exactly 1
    for (const [acc, count] of counts.entries()) {
      assert.strictEqual(
        count,
        1,
        `app-menu.ts contains duplicate accelerator '${acc}' (count: ${count})`
      );
    }

    // 2. app-menu.ts authoritatively defines core application accelerators exactly once
    const requiredAccelerators = [
      'CmdOrCtrl+T',
      'CmdOrCtrl+Shift+T',
      'CmdOrCtrl+W',
      'CmdOrCtrl+R',
      'F5',
      'CmdOrCtrl+Shift+R',
      'CmdOrCtrl+Shift+B',
      'CmdOrCtrl+Shift+I',
      'F12',
      'F11',
      'CmdOrCtrl+F',
      'CmdOrCtrl+Alt+B',
      'CmdOrCtrl+`',
      'CmdOrCtrl+Shift+N',
    ];
    for (const acc of requiredAccelerators) {
      const occurrence = counts.get(acc) || 0;
      assert.strictEqual(
        occurrence,
        1,
        `app-menu.ts must define accelerator '${acc}' exactly once, but found ${occurrence}`
      );
    }

    // 3. Extract setupGlobalShortcutsOnView function body from native-tab-host.ts
    const fnMatch = nativeTabHost.match(/setupGlobalShortcutsOnView\s*\([^)]*\)\s*:\s*void\s*\{([\s\S]*?)\n\s*private setupContextMenu/);
    assert.ok(fnMatch, 'setupGlobalShortcutsOnView method must be present in native-tab-host.ts');
    const fnBody = fnMatch[1]!;

    // 4. Ensure NO overlapping handlers exist in setupGlobalShortcutsOnView for keys owned by app-menu
    assert.doesNotMatch(
      fnBody,
      /input\.key\.toLowerCase\(\)\s*===\s*['"]t['"]/,
      'setupGlobalShortcutsOnView must not duplicate Ctrl+T / Ctrl+Shift+T (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\.toLowerCase\(\)\s*===\s*['"]w['"]/,
      'setupGlobalShortcutsOnView must not duplicate Ctrl+W (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\.toLowerCase\(\)\s*===\s*['"]r['"]/,
      'setupGlobalShortcutsOnView must not duplicate Ctrl+R (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\.toLowerCase\(\)\s*===\s*['"]b['"]/,
      'setupGlobalShortcutsOnView must not duplicate Ctrl+Alt+B (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\.toLowerCase\(\)\s*===\s*['"]f['"]/,
      'setupGlobalShortcutsOnView must not duplicate Ctrl+F (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\.toLowerCase\(\)\s*===\s*['"]i['"]/,
      'setupGlobalShortcutsOnView must not duplicate Ctrl+Shift+I (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\s*===\s*['"]F12['"]/,
      'setupGlobalShortcutsOnView must not duplicate F12 (owned by app-menu)'
    );
    assert.doesNotMatch(
      fnBody,
      /input\.key\s*===\s*['"]F5['"]/,
      'setupGlobalShortcutsOnView must not duplicate F5 (owned by app-menu)'
    );

    // 5. Ensure non-menu WebContents shortcuts are handled and prevent default
    assert.match(
      fnBody,
      /if\s*\(isCtrlOrCmd\s*&&\s*input\.key\s*===\s*['"]Tab['"]\)\s*\{[^}]*_event\.preventDefault\(\);[^}]*this\.switchTab\(/,
      'Ctrl+Tab must be handled in setupGlobalShortcutsOnView with _event.preventDefault()'
    );
    assert.match(
      fnBody,
      /if\s*\(isCtrlOrCmd\s*&&\s*!input\.shift\s*&&\s*input\.key\.toLowerCase\(\)\s*===\s*['"]u['"]\)\s*\{[^}]*_event\.preventDefault\(\);[^}]*this\.viewPageSource\(/,
      'Ctrl+U must be handled in setupGlobalShortcutsOnView with _event.preventDefault()'
    );
    assert.match(
      fnBody,
      /if\s*\(isCtrlOrCmd\s*&&\s*input\.key\.toLowerCase\(\)\s*===\s*['"]l['"]\)\s*\{[^}]*_event\.preventDefault\(\);/,
      'Ctrl+L must be handled in setupGlobalShortcutsOnView with _event.preventDefault()'
    );
    assert.match(
      fnBody,
      /if\s*\(input\.key\s*===\s*['"]Escape['"]\)\s*\{[^}]*_event\.preventDefault\(\);/,
      'Escape must be handled in setupGlobalShortcutsOnView with _event.preventDefault()'
    );
  });

  it('clears the implicit blank navigation entry after creating ordinary tabs without affecting view-source loading', () => {
    const nativeTabHost = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts'), 'utf8');
    assert.match(
      nativeTabHost,
      /else if \(url !== 'about:blank'\) \{\s*wc\.loadURL\(url\)\s*\.then\(\(\) => this\.clearInitialNavigationHistory\(wc, state\)\)/,
      'ordinary new tabs must clear the implicit about:blank history only after their initial URL loads'
    );
    assert.match(
      nativeTabHost,
      /if \(url\.startsWith\('view-source:'\)\) \{[\s\S]*?this\.fetchAndLoadPageSource\(wc, sourceTargetUrl, state\);\s*\} else if/,
      'view-source tabs must retain their dedicated data-URL loading path'
    );
  });

  it('enforces single workflow authority in native-tab-host delegating through control-plane runtime', () => {
    const nativeTabHost = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts'), 'utf8');
    
    // Verify all 5 workflow IPC channels exist
    const requiredChannels = [
      'antifan:workflow:get-state',
      'antifan:workflow:save',
      'antifan:workflow:delete',
      'antifan:workflow:run',
      'antifan:workflow:abort',
    ];
    for (const ch of requiredChannels) {
      assert.ok(
        nativeTabHost.includes(`ipcMain.handle('${ch}'`) || nativeTabHost.includes(`ipcMain.on('${ch}'`),
        `native-tab-host.ts must register channel ${ch}`
      );
    }

    // Enforce no separate WorkflowEngine is instantiated in native-tab-host
    assert.strictEqual(
      nativeTabHost.includes('new WorkflowEngine'),
      false,
      'native-tab-host.ts must NOT instantiate its own WorkflowEngine; ControlPlaneRuntime owns workflow execution'
    );

    // Enforce workflow:run delegates to this.controlPlane.executeWorkflow
    assert.ok(
      nativeTabHost.includes('this.controlPlane.executeWorkflow'),
      'antifan:workflow:run must delegate to this.controlPlane.executeWorkflow'
    );
  });
});
