import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NativeTabHost } from '../../src/main/browser/native-tab-host';
import { createChromeRouteHarness } from '../support/chrome-route-harness';
import {
  TOOLBAR_CHANNELS,
  SIDEBAR_CHANNELS,
  TERMINAL_CHANNELS,
} from '../../src/shared/contracts';
describe('Webview & Extension IPC Audit Invariants', () => {
  const root = fs.existsSync(path.join(process.cwd(), 'src')) ? process.cwd() : path.resolve(__dirname, '..', '..');
  const harness = createChromeRouteHarness({ host: Object.create(NativeTabHost.prototype) });
  const registeredRoutes = new Set(harness.registeredChannels());

  it('verifies Message Contract parity across native-tab-host and shared contracts', () => {
    // Check critical toolbar handlers
    const requiredToolbarChannels = [
      TOOLBAR_CHANNELS.CREATE_TAB,
      TOOLBAR_CHANNELS.SWITCH_TAB,
      TOOLBAR_CHANNELS.CLOSE_TAB,
      TOOLBAR_CHANNELS.MOVE_TAB,
      TOOLBAR_CHANNELS.NAVIGATE,
      TOOLBAR_CHANNELS.RELOAD,
      TOOLBAR_CHANNELS.STOP_LOADING,
      TOOLBAR_CHANNELS.GO_BACK,
      TOOLBAR_CHANNELS.GO_FORWARD,
      TOOLBAR_CHANNELS.TOGGLE_INSPECT,
      TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER,
      TOOLBAR_CHANNELS.TOGGLE_LENS,
      TOOLBAR_CHANNELS.TOGGLE_RULER,
      TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS,
      TOOLBAR_CHANNELS.TOGGLE_SIDEBAR,
      TOOLBAR_CHANNELS.SET_DEVICE_PRESET,
      TOOLBAR_CHANNELS.SET_ZOOM,
      TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE,
      TOOLBAR_CHANNELS.CAPTURE_VIEWPORT,
      TOOLBAR_CHANNELS.OPEN_EXTERNAL,
      TOOLBAR_CHANNELS.TOGGLE_BOOKMARK,
      TOOLBAR_CHANNELS.FIND_IN_PAGE,
      TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE,
      TOOLBAR_CHANNELS.SHOW_MENU,
      TOOLBAR_CHANNELS.SET_OVERLAY,
      TOOLBAR_CHANNELS.CLEAR_STORAGE,
      TOOLBAR_CHANNELS.GET_CHROME_PROFILES,
      TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE,
      TOOLBAR_CHANNELS.TOGGLE_BOOKMARK_BAR,
      TOOLBAR_CHANNELS.ADD_BOOKMARK,
      TOOLBAR_CHANNELS.GET_SUGGESTIONS,
      TOOLBAR_CHANNELS.REMOVE_BOOKMARK,
    ];

    for (const channel of requiredToolbarChannels) {
      assert.ok(
        registeredRoutes.has(channel),
        `Missing IPC handler for ${channel} in Chrome route table`
      );
    }

    // Check critical sidebar handlers
    const requiredSidebarChannels = [
      SIDEBAR_CHANNELS.GET_INITIAL_STATE,
      SIDEBAR_CHANNELS.CLOSE_SIDEBAR,
      SIDEBAR_CHANNELS.SET_WIDTH,
    ];

    for (const channel of requiredSidebarChannels) {
      assert.ok(
        registeredRoutes.has(channel),
        `Missing IPC handler for ${channel} in Chrome route table`
      );
    }

    // Check critical terminal channels
    const requiredTerminalChannels = [
      TERMINAL_CHANNELS.START,
      TERMINAL_CHANNELS.INPUT,
      TERMINAL_CHANNELS.KILL,
      TERMINAL_CHANNELS.RESTART,
      // The ownership handover the tab context menu drives: a session may be moved to
      // another project, and the host is the only side that may re-stamp it.
      TERMINAL_CHANNELS.ASSIGN_PROJECT,
    ];

    for (const channel of requiredTerminalChannels) {
      assert.ok(
        registeredRoutes.has(channel),
        `Missing IPC handler for ${channel} in Chrome route table`
      );
    }
  });

  it('scans renderer HTML templates for dead or duplicate script tags', () => {
    // 1. toolbar.html static script tags
    const toolbarHtmlPath = path.join(root, 'src', 'renderer', 'toolbar.html');
    assert.ok(fs.existsSync(toolbarHtmlPath), `toolbar.html must exist at ${toolbarHtmlPath}`);
    const toolbarHtml = fs.readFileSync(toolbarHtmlPath, 'utf8');
    const toolbarScriptMatches = [...toolbarHtml.matchAll(/<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi)].map((m) => m[1]!);
    assert.ok(toolbarScriptMatches.length >= 1, 'toolbar.html must declare external scripts');

    const toolbarSrcCounts = new Map<string, number>();
    for (const src of toolbarScriptMatches) {
      toolbarSrcCounts.set(src, (toolbarSrcCounts.get(src) || 0) + 1);
      const direct = path.resolve(path.dirname(toolbarHtmlPath), src);
      const tsSource = src.endsWith('.js') ? path.resolve(path.dirname(toolbarHtmlPath), src.replace(/\.js$/, '.ts')) : null;
      const targetExists = fs.existsSync(direct) || (tsSource && fs.existsSync(tsSource));
      assert.ok(targetExists, `Target file for script '${src}' in toolbar.html must exist on disk`);
    }
    for (const [src, count] of toolbarSrcCounts.entries()) {
      assert.strictEqual(count, 1, `Script '${src}' must appear exactly once in toolbar.html, found ${count}`);
    }

    // 2. standalone.html bootstrap script list
    const standaloneHtmlPath = path.join(root, 'src', 'renderer', 'standalone.html');
    assert.ok(fs.existsSync(standaloneHtmlPath), `standalone.html must exist at ${standaloneHtmlPath}`);
    const standaloneHtml = fs.readFileSync(standaloneHtmlPath, 'utf8');
    const standaloneScriptsBlock = standaloneHtml.match(/const scripts = \[([\s\S]*?)\];/);
    assert.ok(standaloneScriptsBlock, 'standalone.html must define scripts array');
    const standaloneScriptSrcs = [...standaloneScriptsBlock[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!);
    assert.ok(standaloneScriptSrcs.length >= 1, 'standalone.html scripts array must not be empty');

    const standaloneSrcCounts = new Map<string, number>();
    for (const src of standaloneScriptSrcs) {
      standaloneSrcCounts.set(src, (standaloneSrcCounts.get(src) || 0) + 1);
      const direct = path.resolve(path.dirname(standaloneHtmlPath), src);
      const nm = path.resolve(root, 'node_modules', src);
      const targetExists = fs.existsSync(direct) || fs.existsSync(nm);
      assert.ok(targetExists, `Target file for script '${src}' in standalone.html must exist on disk`);
    }
    for (const [src, count] of standaloneSrcCounts.entries()) {
      assert.strictEqual(count, 1, `Script '${src}' must appear exactly once in standalone.html, found ${count}`);
    }
  });

  it('keeps the legacy bottom terminal drawer fully removed [absence pin]', () => {
    const nativeTabHost = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts'), 'utf8');
    const appMenu = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'app-menu.ts'), 'utf8');
    const toolbarPreload = fs.readFileSync(path.join(root, 'src', 'preload', 'toolbar-preload.ts'), 'utf8');
    const contracts = fs.readFileSync(path.join(root, 'src', 'shared', 'contracts.ts'), 'utf8');

    for (const relativePath of [
      'src/preload/terminal-preload.ts',
      'src/renderer/terminal.ts',
      'src/renderer/terminal.html',
      'src/renderer/terminal.css',
    ]) {
      assert.strictEqual(fs.existsSync(path.join(root, relativePath)), false, `${relativePath} must remain deleted`);
    }

    for (const obsoleteSymbol of ['terminalView', 'isTerminalOpen', 'toggleTerminal', 'TOGGLE_TERMINAL']) {
      assert.strictEqual(nativeTabHost.includes(obsoleteSymbol), false, `NativeTabHost must not restore ${obsoleteSymbol}`);
    }
    assert.strictEqual(toolbarPreload.includes('toggleTerminal'), false, 'toolbar preload must not expose the removed drawer');
    assert.strictEqual(contracts.includes('TOGGLE_TERMINAL'), false, 'shared contracts must not expose the removed drawer');
    assert.strictEqual(appMenu.includes('Toggle Bottom Terminal Drawer'), false, 'application menu must not restore the removed drawer item');
    assert.match(appMenu, /label:\s*'Toggle Terminal Workbench'[\s\S]*?accelerator:\s*'CmdOrCtrl\+`'[\s\S]*?toggleSidebar\(\)/);
  });

  it('audits static event listeners to ensure no duplicate bindings on tool buttons', () => {
    const toolbarHtmlPath = path.join(root, 'src', 'renderer', 'toolbar.html');
    const toolbarTsPath = path.join(root, 'src', 'renderer', 'toolbar.ts');
    assert.ok(fs.existsSync(toolbarHtmlPath), `toolbar.html must exist at ${toolbarHtmlPath}`);
    assert.ok(fs.existsSync(toolbarTsPath), `toolbar.ts must exist at ${toolbarTsPath}`);
    const toolbarHtml = fs.readFileSync(toolbarHtmlPath, 'utf8');
    const toolbarTs = fs.readFileSync(toolbarTsPath, 'utf8');

    // Surviving active buttons in toolbar.html
    const activeButtons = [
      'btnQuickInspect',
      'btnFontFinder',
      'btnToggleSidebar',
      'btnNewTab',
      'btnBack',
      'btnForward',
      'btnReload',
      'btnStarBookmark',
    ];

    for (const btn of activeButtons) {
      // Must exist in toolbar.html
      assert.ok(toolbarHtml.includes(`id="${btn}"`), `Button ${btn} must exist in toolbar.html`);

      // Must have exactly 1 click listener binding in toolbar.ts
      const regex = new RegExp(`\\b${btn}\\s*\\??\\.addEventListener\\s*\\(\\s*['"]click['"]`, 'g');
      const matches = toolbarTs.match(regex) || [];
      assert.strictEqual(
        matches.length,
        1,
        `Button variable ${btn} must have exactly one click addEventListener binding in toolbar.ts, found ${matches.length}`
      );
    }

    // Dead buttons must remain deleted from toolbar.html [absence pin]
    const deadButtons = ['btnRuler', 'btnCaptureFullPage', 'btnDevTools'];
    for (const btn of deadButtons) {
      assert.strictEqual(
        toolbarHtml.includes(`id="${btn}"`),
        false,
        `Dead button ${btn} must not exist in toolbar.html [absence pin]`
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
    assert.ok(registeredRoutes.has('antifan:standalone:open-workspace'), 'antifan:standalone:open-workspace must be registered in route table');
    assert.ok(registeredRoutes.has('antifan:terminal:new-session'), 'antifan:terminal:new-session must be registered in route table');
    assert.match(preloadContent, /pickWorkspaceFolder:\s*\(sessionId\?: string\).*\{ sessionId \}/);
    // The tab context menu's ownership handover: the renderer names the session and the
    // project it is moving to, and the host owns the re-stamp. Both ends name the one
    // channel, and the payload keys are the frozen pair.
    assert.match(preloadContent, /assignTerminalProject/);
    assert.match(preloadContent, /invoke\(\s*TERMINAL_CHANNELS\.ASSIGN_PROJECT\s*,\s*\{[^}]*sessionId[^}]*projectId/);
    assert.ok(registeredRoutes.has(TERMINAL_CHANNELS.ASSIGN_PROJECT), 'TERMINAL_CHANNELS.ASSIGN_PROJECT must be registered in route table');
    // A terminal's own URL clicks join the owning project through Main, never whichever window
    // currently has focus.
    assert.match(preloadContent, /openTerminalLink/);
    assert.match(preloadContent, /invoke\(\s*TERMINAL_CHANNELS\.OPEN_LINK\s*,\s*\{[^}]*sessionId[^}]*url/);
    assert.ok(registeredRoutes.has(TERMINAL_CHANNELS.OPEN_LINK), 'TERMINAL_CHANNELS.OPEN_LINK must be registered in route table');
    // The audit pins the contract the picker must keep: the folder the user chose and the
    // session it was picked for reach setCapsule, for whichever capsule the route adopted.
    assert.ok(registeredRoutes.has('antifan:capsule:pick-folder'), 'antifan:capsule:pick-folder must be registered in route table');
    assert.match(nativeContent, /capsule:pick-folder[^]*setCapsule\([\w$]+\.id, chosenPath, opts\?\.sessionId\)/);
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

    // 4. CmdOrCtrl+F is registered in app-menu and triggers focusFindBar on the host the
    // menu resolved for the focused window: the find bar must act on the window the user
    // is in, never on the window the menu was built for.
    const appMenu = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'app-menu.ts'), 'utf8');
    assert.match(appMenu, /accelerator:\s*['"]CmdOrCtrl\+F['"][^]*hostForClick\(focusedWindow\)\?\.focusFindBar\(\)/);
    assert.match(nativeTabHost, /focusFindBar\s*\(\)\s*:\s*void\s*\{[^}]*antifan:focus-find/);
    // 5. Overlay lifecycle in show/hide find bar
    assert.match(toolbarTs, /function showFindBar\(\)[^]*acquireOverlay\('find-bar',\s*50\)/);
    assert.match(toolbarTs, /function hideFindBar\(\)[^]*releaseOverlay\('find-bar'\)/);
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
    assert.match(toolbarTs, /omniboxSuggestDropdown\.style\.display\s*=\s*'block'[^]*acquireOverlay\('suggest',\s*420\)/);
    assert.match(toolbarTs, /function hideSuggestDropdown\(\)[^]*omniboxSuggestDropdown\.style\.display\s*=\s*'none'[^]*releaseOverlay\('suggest'\)/);

    // 4. Must NOT immediately close the suggest dropdown after showing it
    assert.doesNotMatch(
      toolbarTs,
      /omniboxSuggestDropdown\.style\.display\s*=\s*'block';\s*acquireOverlay\('suggest',\s*420\);\s*hideSuggestDropdown\(\);/,
      'Must not call hideSuggestDropdown immediately after opening dropdown'
    );
  });

  it('verifies tab host handles WebContents close, destroyed, and OAuth window open events', () => {
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    const nativeTabHost = fs.readFileSync(nativeTabHostPath, 'utf8');

    // 1. WebContents close event must invoke closeTab
    assert.match(
      nativeTabHost,
      /\.on\('close',\s*\(\)\s*=>\s*\{[^}]*this\.closeTab\(id,\s*'view-close'\)/,
      'Must handle wc close event to close tab on window.close()'
    );

    // 2. WebContents destroyed event must clean up tab
    assert.match(
      nativeTabHost,
      /wc\.on\('destroyed',\s*\(\)\s*=>\s*\{[^}]*this\.closeTab\(id,\s*'view-destroyed'\)/,
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
      'CmdOrCtrl+Shift+M',
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
      /if\s*\(isCtrlOrCmd\s*&&\s*input\.key\s*===\s*['"]Tab['"]\)\s*\{[^{}]*_event\.preventDefault\(\);[\s\S]{0,600}?this\.switchTab\(/,
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
      /if\s*\(input\.key\s*===\s*['"]Escape['"]\)\s*\{[^}]*?if\s*\(tabId\)\s*_event\.preventDefault\(\);/,
      'Escape must be handled in setupGlobalShortcutsOnView without preventing default on chrome views, which own Escape for their own overlays'
    );
  });

  it('clears the implicit blank navigation entry after creating ordinary tabs without affecting view-source loading', () => {
    const nativeTabHost = fs.readFileSync(path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts'), 'utf8');
    assert.match(
      nativeTabHost,
      /else if \(url !== 'about:blank'\) \{[\s\S]*?wc\.loadURL\(url[^)]*\)\s*\.then\(\(\) => this\.clearInitialNavigationHistory\(wc, state\)\)/,
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
    
    // Verify all 5 workflow IPC channels exist in route table
    const requiredChannels = [
      'antifan:workflow:get-state',
      'antifan:workflow:save',
      'antifan:workflow:delete',
      'antifan:workflow:run',
      'antifan:workflow:abort',
    ];
    for (const ch of requiredChannels) {
      assert.ok(
        registeredRoutes.has(ch),
        `Chrome route table must register channel ${ch}`
      );
    }

    // Enforce no separate WorkflowEngine is instantiated in native-tab-host [absence pin]
    assert.strictEqual(
      nativeTabHost.includes('new WorkflowEngine'),
      false,
      'native-tab-host.ts must NOT instantiate its own WorkflowEngine; ControlPlaneRuntime owns workflow execution [absence pin]'
    );

    // Enforce workflow:run delegates to this.controlPlane.executeWorkflow
    assert.ok(
      /(?:this|host)\.controlPlane\.executeWorkflow/.test(nativeTabHost),
      'antifan:workflow:run must delegate to this.controlPlane.executeWorkflow'
    );
  });

  it('verifies safeSendWebContents guards against disposed frames and crashes', () => {
    const { safeSendWebContents } = require('../../src/main/browser/web-contents-guard');
    assert.strictEqual(typeof safeSendWebContents, 'function', 'safeSendWebContents must be exported');

    // Null / Undefined WebContents
    assert.strictEqual(safeSendWebContents(null, 'test'), false);
    assert.strictEqual(safeSendWebContents(undefined, 'test'), false);

    // Destroyed WebContents
    const destroyedWc = {
      isDestroyed: () => true,
      send: () => { throw new Error('Should not be called'); },
    };
    assert.strictEqual(safeSendWebContents(destroyedWc as unknown as Electron.WebContents, 'test'), false);

    // Crashed WebContents
    const crashedWc = {
      isDestroyed: () => false,
      isCrashed: () => true,
      mainFrame: {},
      send: () => { throw new Error('Should not be called'); },
    };
    assert.strictEqual(safeSendWebContents(crashedWc as unknown as Electron.WebContents, 'test'), false);

    // Missing mainFrame (frame disposed during reload)
    const missingFrameWc = {
      isDestroyed: () => false,
      isCrashed: () => false,
      mainFrame: null,
      send: () => { throw new Error('Should not be called'); },
    };
    assert.strictEqual(safeSendWebContents(missingFrameWc as unknown as Electron.WebContents, 'test'), false);

    // WebFrameMain.send throws disposal exception
    const throwingWc = {
      isDestroyed: () => false,
      isCrashed: () => false,
      mainFrame: {},
      send: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed');
      },
    };
    assert.strictEqual(safeSendWebContents(throwingWc as unknown as Electron.WebContents, 'test'), false);

    // Healthy WebContents
    let sentChannel = '';
    let sentArg = '';
    const healthyWc = {
      isDestroyed: () => false,
      isCrashed: () => false,
      mainFrame: {},
      send: (ch: string, arg: string) => {
        sentChannel = ch;
        sentArg = arg;
      },
    };
    assert.strictEqual(safeSendWebContents(healthyWc as unknown as Electron.WebContents, 'ch:ok', 'payload'), true);
    assert.strictEqual(sentChannel, 'ch:ok');
    assert.strictEqual(sentArg, 'payload');

    // Verify toolbarView does NOT receive terminal data in native-tab-host.ts
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    const content = fs.readFileSync(nativeTabHostPath, 'utf8');
    assert.strictEqual(
      content.includes('this.toolbarView.webContents.send(TERMINAL_CHANNELS.DATA'),
      false,
      'toolbarView must not receive TERMINAL_CHANNELS.DATA'
    );

    // Enforce no direct unsafe .webContents.send calls in native-tab-host.ts
    assert.strictEqual(
      content.includes('this.toolbarView.webContents.send('),
      false,
      'native-tab-host.ts must route toolbarView sends through safeSendWebContents'
    );
    assert.strictEqual(
      content.includes('this.sidebarView.webContents.send('),
      false,
      'native-tab-host.ts must route sidebarView sends through safeSendWebContents'
    );
    assert.strictEqual(
      content.includes('this.frameBackdropView.webContents.send('),
      false,
      'native-tab-host.ts must route frameBackdropView sends through safeSendWebContents'
    );
  });

  it('verifies Root Terminal Creation Invariants (No eager auto-binding of activeTabId to root sessions)', () => {
    const nativeTabHostPath = path.join(root, 'src', 'main', 'browser', 'native-tab-host.ts');
    assert.ok(fs.existsSync(nativeTabHostPath), `native-tab-host.ts must exist at ${nativeTabHostPath}`);
    const content = fs.readFileSync(nativeTabHostPath, 'utf8');

    // 1. session-created hook:
    // The host registers its TerminalManager listeners through a removable wrapper so
    // `dispose()` can release exactly its own handlers from the shared singleton. The
    // anchor therefore moves from the registration literal to the handler declaration
    // the registration names; every assertion about the handler body is unchanged.
    const sessionCreatedIdx = content.indexOf('const onTerminalSessionCreated = (');
    assert.ok(sessionCreatedIdx !== -1, 'session-created handler must exist');
    const sessionCreatedRegistrationIdx = content.indexOf(
      "subscribe('session-created', onTerminalSessionCreated);",
      sessionCreatedIdx
    );
    assert.ok(sessionCreatedRegistrationIdx !== -1, 'session-created listener must be registered on the shared TerminalManager');
    const nextHookIdx = content.indexOf('channel: TERMINAL_CHANNELS.GET_FULL_BUFFER', sessionCreatedIdx);
    assert.ok(nextHookIdx !== -1, 'TERMINAL_CHANNELS.GET_FULL_BUFFER boundary must exist');
    const sessionCreatedBlock = content.slice(sessionCreatedIdx, sessionCreatedRegistrationIdx);

    // Negative: must NOT fall back to this.activeTabId for root sessions
    assert.strictEqual(
      sessionCreatedBlock.includes('let targetTab = this.activeTabId;'),
      false,
      'session-created must not fall back to this.activeTabId for root sessions'
    );
    // Positive: targetTab starts undefined and only binds when parentId has alive affinity
    assert.ok(
      sessionCreatedBlock.includes('let targetTab: string | undefined = undefined;'),
      'session-created must initialize targetTab to undefined'
    );
    assert.ok(
      sessionCreatedBlock.includes('const parentAffinity = this.getTerminalAgentAffinity(parentId);'),
      'session-created must look up parent affinity'
    );
    assert.ok(
      sessionCreatedBlock.includes("parentAffinity.status === 'alive'"),
      'session-created must require parent affinity to be alive'
    );
    assert.ok(
      sessionCreatedBlock.includes('targetTab = parentAffinity.tabId;'),
      'session-created must inherit parent tabId'
    );
    assert.ok(
      sessionCreatedBlock.includes('this.bindTerminalAgentAffinity(id, generation || 1, targetTab);'),
      'session-created must bind targetTab when inherited from alive parent'
    );

    // 2. TERMINAL_CHANNELS.START handler must directly return startTerminal without binding activeTabId
    assert.ok(registeredRoutes.has(TERMINAL_CHANNELS.START), 'TERMINAL_CHANNELS.START route must be registered in Chrome route table');
    const startIdx = content.indexOf('channel: TERMINAL_CHANNELS.START');
    assert.ok(startIdx !== -1, 'TERMINAL_CHANNELS.START handler must exist in native-tab-host.ts');
    const nextIpcIdx = content.indexOf('channel: TERMINAL_CHANNELS.INPUT', startIdx);
    assert.ok(nextIpcIdx !== -1, 'TERMINAL_CHANNELS.INPUT boundary must exist');
    const startHandlerBlock = content.slice(startIdx, nextIpcIdx);
    const agentGuard = /const isAgent = senderInfo && \(senderInfo\.tab\.state\.ephemeral === true \|\| senderInfo\.tabId === (?:this|host)\.automationTabId\)/.test(startHandlerBlock);
    assert.ok(
      agentGuard,
      'TERMINAL_CHANNELS.START binding must be guarded by explicit agent-plane sender detection'
    );
    assert.ok(
      startHandlerBlock.includes('bindTerminalAgentAffinity'),
      'TERMINAL_CHANNELS.START must bind the agent affinity for the sender tab; dropping the binding silently leaves the terminal on the user tab'
    );
    // The bind moved into a local closure so the daemon path can bind after its RPC settles
    // (the session does not exist before that), so the invariant is asserted directly rather
    // than through the shape that used to carry it: every bind call names the sender tab as its
    // affinity subject, never the user's active tab.
    const bindArgs = [...startHandlerBlock.matchAll(/bindTerminalAgentAffinity\(([^;]*?)\)/g)].map((match) => match[1] ?? '');
    assert.ok(bindArgs.length > 0, 'TERMINAL_CHANNELS.START must call bindTerminalAgentAffinity for the sender tab');
    for (const args of bindArgs) {
      assert.match(
        args,
        /senderInfo\.tabId\s*$/,
        'TERMINAL_CHANNELS.START may bind only the agent sender tabId (senderInfo.tabId), never the user activeTabId'
      );
    }
    assert.ok(
      /if \(!isAgent\) return;/.test(startHandlerBlock),
      'TERMINAL_CHANNELS.START must gate the agent affinity binding on the agent-plane guard'
    );
    // The route passes the sender window's validated workspace root (`target`), its capsule
    // provenance AND the owner key that makes the mint belong to that window; any one of them
    // missing would let a project window inherit the process-wide cwd, another window's capsule,
    // or a terminal that two windows working one folder both answer for. The behaviour is covered
    // end-to-end by project-window-persistence's "passes the window workspace, capsule and
    // owner key to the creation routes".
    assert.ok(
      /TerminalManager\.getInstance\(\)\.startTerminal\(\s*target\.cwd\s*,\s*target\.capsuleId\s*,\s*target\.ownerKey\s*\)/.test(startHandlerBlock),
      'TERMINAL_CHANNELS.START must invoke startTerminal with the sender window workspace root, capsule and owner key'
    );

    // 3. antifan:terminal:new-session handler must directly return createSession without binding activeTabId
    assert.ok(registeredRoutes.has('antifan:terminal:new-session'), 'antifan:terminal:new-session route must be registered in Chrome route table');
    const newSessionIdx = content.indexOf("channel: 'antifan:terminal:new-session'");
    assert.ok(newSessionIdx !== -1, 'antifan:terminal:new-session handler must exist in native-tab-host.ts');
    const nextSplitIdx = content.indexOf("channel: 'antifan:terminal:split-session'", newSessionIdx);
    assert.ok(nextSplitIdx !== -1, 'antifan:terminal:split-session boundary must exist');
    const newSessionBlock = content.slice(newSessionIdx, nextSplitIdx);
    assert.ok(
      newSessionBlock.includes('bindTerminalAgentAffinity'),
      'antifan:terminal:new-session must bind the agent affinity for the sender tab; dropping the binding silently leaves the terminal on the user tab'
    );
    assert.ok(
      /if \(isAgent && id\)\s*\{[\s\S]{0,400}?bindTerminalAgentAffinity\(id, s\?\.sessionGeneration, senderInfo\.tabId\)/.test(newSessionBlock),
      'antifan:terminal:new-session may bind only the agent sender tabId (senderInfo.tabId), never the user activeTabId'
    );
    assert.ok(
      /TerminalManager\.getInstance\(\)\.createSession\(\s*target\.cwd\s*,\s*target\.capsuleId\s*,\s*target\.ownerKey\s*\)/.test(newSessionBlock),
      'antifan:terminal:new-session must invoke createSession with the sender window workspace root, capsule and owner key'
    );
  });
});
