/**
 * AntiFan Browser Desktop — Toolbar Preload Script
 * 100% parity with Antigravity Desktop IPC surface.
 */
import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = {
  GET_INITIAL_STATE: 'antifan:toolbar:get-initial-state',
  CREATE_TAB: 'antifan:toolbar:create-tab',
  SWITCH_TAB: 'antifan:toolbar:switch-tab',
  CLOSE_TAB: 'antifan:toolbar:close-tab',
  MOVE_TAB: 'antifan:toolbar:move-tab',
  DUPLICATE_TAB: 'antifan:toolbar:duplicate-tab',
  CLOSE_OTHER_TABS: 'antifan:toolbar:close-other-tabs',
  CLOSE_TABS_TO_RIGHT: 'antifan:toolbar:close-tabs-to-right',
  SET_TAB_TERMINAL_SESSION: 'antifan:toolbar:set-tab-terminal-session',
  NAVIGATE: 'antifan:toolbar:navigate',
  RELOAD: 'antifan:toolbar:reload',
  RELOAD_WINDOW: 'antifan:toolbar:reload-window',
  STOP_LOADING: 'antifan:toolbar:stop-loading',
  GO_BACK: 'antifan:toolbar:go-back',
  GO_FORWARD: 'antifan:toolbar:go-forward',
  TOGGLE_INSPECT: 'antifan:toolbar:toggle-inspect',
  TOGGLE_FONT_FINDER: 'antifan:toolbar:toggle-font-finder',
  TOGGLE_LENS: 'antifan:toolbar:toggle-lens',
  TOGGLE_RULER: 'antifan:toolbar:toggle-ruler',
  TOGGLE_DEVTOOLS: 'antifan:toolbar:toggle-devtools',
  TOGGLE_SIDEBAR: 'antifan:toolbar:toggle-sidebar',
  SET_DEVICE_PRESET: 'antifan:toolbar:set-device-preset',
  SET_ZOOM: 'antifan:toolbar:set-zoom',
  TOGGLE_MUTE: 'antifan:toolbar:toggle-mute',
  CAPTURE_FULL_PAGE: 'antifan:toolbar:capture-full-page',
  CAPTURE_VIEWPORT: 'antifan:toolbar:capture-viewport',
  OPEN_EXTERNAL: 'antifan:toolbar:open-external',
  OPEN_IN_VSCODE: 'antifan:toolbar:open-in-vscode',
  TOGGLE_BOOKMARK: 'antifan:toolbar:toggle-bookmark',
  GET_BOOKMARKS: 'antifan:toolbar:get-bookmarks',
  FIND_IN_PAGE: 'antifan:toolbar:find-in-page',
  STOP_FIND_IN_PAGE: 'antifan:toolbar:stop-find-in-page',
  SHOW_MENU: 'antifan:toolbar:show-menu',
  SET_OVERLAY: 'antifan:toolbar:set-overlay',
  CLEAR_STORAGE: 'antifan:toolbar:clear-storage',
  SYNC_CHROME_PROFILE: 'antifan:toolbar:sync-chrome-profile',
  GET_CHROME_PROFILES: 'antifan:toolbar:get-chrome-profiles',
  TOGGLE_BOOKMARK_BAR: 'antifan:toolbar:toggle-bookmark-bar',
  ADD_BOOKMARK: 'antifan:toolbar:add-bookmark',
  REMOVE_BOOKMARK: 'antifan:toolbar:remove-bookmark',
  GET_SUGGESTIONS: 'antifan:toolbar:get-suggestions',
  STATE_UPDATED: 'antifan:toolbar:state-updated',
  ELEMENT_PICKED: 'antifan:toolbar:element-picked',
  FIND_RESULT: 'antifan:toolbar:find-result',
  GET_MOBILE_REMOTE_INFO: 'antifan:toolbar:get-mobile-remote-info',
  TOGGLE_SPLIT_REVIEW: 'antifan:toolbar:toggle-split-review',
  SET_SPLIT_PRESET: 'antifan:toolbar:set-split-preset',
  SET_SPLIT_FOCUSED_PANE: 'antifan:toolbar:set-split-focused-pane',
  THEME_QA_RUN: 'antifan:toolbar:theme-qa-run',
  THEME_QA_STATE: 'antifan:toolbar:theme-qa-state',
};

const toolbarApi = {
  getInitialState: () => ipcRenderer.invoke(CHANNELS.GET_INITIAL_STATE),
  getMobileRemoteInfo: () => ipcRenderer.invoke(CHANNELS.GET_MOBILE_REMOTE_INFO),
  createTab: (url?: string) => ipcRenderer.invoke(CHANNELS.CREATE_TAB, url),
  switchTab: (tabId: string) => ipcRenderer.invoke(CHANNELS.SWITCH_TAB, tabId),
  setTabAlias: (tabId: string, alias?: string, role?: string, aliasColor?: string) => ipcRenderer.invoke('antifan:tab:set-alias', { tabId, alias, role, aliasColor }),
  closeTab: (tabId: string) => ipcRenderer.invoke(CHANNELS.CLOSE_TAB, tabId),
  moveTab: (tabId: string, toIndex: number) => ipcRenderer.invoke(CHANNELS.MOVE_TAB, { tabId, toIndex }),
  duplicateTab: (tabId: string) => ipcRenderer.invoke(CHANNELS.DUPLICATE_TAB, tabId),
  closeOtherTabs: (tabId: string) => ipcRenderer.invoke(CHANNELS.CLOSE_OTHER_TABS, tabId),
  closeTabsToRight: (tabId: string) => ipcRenderer.invoke(CHANNELS.CLOSE_TABS_TO_RIGHT, tabId),
  setTabTerminalSession: (tabId: string, terminalSessionId: string) => ipcRenderer.invoke(CHANNELS.SET_TAB_TERMINAL_SESSION, { tabId, terminalSessionId }),
  rebindTerminalAffinity: (tabId?: string, terminalId?: string) => ipcRenderer.invoke('antifan:terminal:rebind-affinity', { tabId, terminalId }),
  navigate: (url: string, tabId?: string) => ipcRenderer.invoke(CHANNELS.NAVIGATE, { url, tabId }),
  reload: (tabId?: string) => ipcRenderer.invoke(CHANNELS.RELOAD, tabId),
  reloadWindow: () => ipcRenderer.invoke(CHANNELS.RELOAD_WINDOW),
  stopLoading: (tabId?: string) => ipcRenderer.invoke(CHANNELS.STOP_LOADING, tabId),
  goBack: (tabId?: string) => ipcRenderer.invoke(CHANNELS.GO_BACK, tabId),
  goForward: (tabId?: string) => ipcRenderer.invoke(CHANNELS.GO_FORWARD, tabId),
  toggleInspect: () => ipcRenderer.invoke(CHANNELS.TOGGLE_INSPECT),
  toggleFontFinder: () => ipcRenderer.invoke(CHANNELS.TOGGLE_FONT_FINDER),
  toggleLens: () => ipcRenderer.invoke(CHANNELS.TOGGLE_LENS),
  toggleRuler: () => ipcRenderer.invoke(CHANNELS.TOGGLE_RULER),
  toggleDevTools: () => ipcRenderer.invoke(CHANNELS.TOGGLE_DEVTOOLS),
  toggleSidebar: () => ipcRenderer.invoke(CHANNELS.TOGGLE_SIDEBAR),
  setDevicePreset: (presetId: string, tabId?: string) => ipcRenderer.invoke(CHANNELS.SET_DEVICE_PRESET, { presetId, tabId }),
  setZoom: (zoom: number, tabId?: string) => ipcRenderer.invoke(CHANNELS.SET_ZOOM, { zoom, tabId }),
  toggleMute: (tabId?: string) => ipcRenderer.invoke(CHANNELS.TOGGLE_MUTE, tabId),
  captureFullPage: () => ipcRenderer.invoke(CHANNELS.CAPTURE_FULL_PAGE),
  captureViewport: () => ipcRenderer.invoke(CHANNELS.CAPTURE_VIEWPORT),
  openExternal: (url?: string) => ipcRenderer.invoke(CHANNELS.OPEN_EXTERNAL, url),
  openInVSCode: () => ipcRenderer.invoke(CHANNELS.OPEN_IN_VSCODE),
  toggleBookmark: (url: string, title?: string) => ipcRenderer.invoke(CHANNELS.TOGGLE_BOOKMARK, { url, title }),
  getBookmarks: () => ipcRenderer.invoke(CHANNELS.GET_BOOKMARKS),
  findInPage: (text: string, forward = true, findNext = false) => ipcRenderer.invoke(CHANNELS.FIND_IN_PAGE, { text, forward, findNext }),
  stopFindInPage: () => ipcRenderer.invoke(CHANNELS.STOP_FIND_IN_PAGE),
  showMenu: () => ipcRenderer.invoke(CHANNELS.SHOW_MENU),
  checkUpdates: () => ipcRenderer.invoke('antifan:toolbar:check-updates'),
  setOverlay: (active: boolean, customHeight?: number) => ipcRenderer.invoke(CHANNELS.SET_OVERLAY, active, customHeight),
  clearStorage: () => ipcRenderer.invoke(CHANNELS.CLEAR_STORAGE),
  getChromeProfiles: () => ipcRenderer.invoke(CHANNELS.GET_CHROME_PROFILES),
  syncChromeProfile: (profileId: string) => ipcRenderer.invoke(CHANNELS.SYNC_CHROME_PROFILE, profileId),
  toggleBookmarkBar: () => ipcRenderer.invoke(CHANNELS.TOGGLE_BOOKMARK_BAR),
  addBookmark: (title: string, url: string) => ipcRenderer.invoke(CHANNELS.ADD_BOOKMARK, { title, url }),
  removeBookmark: (url: string) => ipcRenderer.invoke(CHANNELS.REMOVE_BOOKMARK, url),
  launchChromeWithExtension: (profileId?: string) => ipcRenderer.invoke('antifan:chrome:launch-with-extension', profileId),
  launchChromeWithCdp: (port?: number, profileId?: string) => ipcRenderer.invoke('antifan:chrome:launch-with-cdp', { port, profileId }),
  openExtensionFolder: () => ipcRenderer.invoke('antifan:chrome:open-extension-folder'),
  isChromeRunning: () => ipcRenderer.invoke('antifan:chrome:is-running'),
  exportSessionVault: (customPath?: string) => ipcRenderer.invoke('antifan:vault:export', customPath),
  importSessionVault: (customPath?: string) => ipcRenderer.invoke('antifan:vault:import', customPath),
  importSessionVaultJson: (json: string) => ipcRenderer.invoke('antifan:vault:import-json', json),
  syncFromChromeCdp: (port?: number) => ipcRenderer.invoke('antifan:vault:cdp-sync', port),
  getVaultStats: (customPath?: string) => ipcRenderer.invoke('antifan:vault:get-stats', customPath),
  getSuggestions: (query: string) => ipcRenderer.invoke(CHANNELS.GET_SUGGESTIONS, query),
  toggleSplitReview: (tabId?: string, enabled?: boolean) => ipcRenderer.invoke(CHANNELS.TOGGLE_SPLIT_REVIEW, { tabId, enabled }),
  setSplitPreset: (paneId: string, presetId: string, tabId?: string) => ipcRenderer.invoke(CHANNELS.SET_SPLIT_PRESET, { paneId, presetId, tabId }),
  setSplitFocusedPane: (paneId: string, tabId?: string) => ipcRenderer.invoke(CHANNELS.SET_SPLIT_FOCUSED_PANE, { paneId, tabId }),

  // Workflow & MCP Hub APIs
  getWorkflowState: () => ipcRenderer.invoke('antifan:workflow:get-state'),
  runWorkflow: (payload: { workflowId?: string; workflowDef?: unknown }) => ipcRenderer.invoke('antifan:workflow:run', payload),
  abortWorkflow: () => ipcRenderer.invoke('antifan:workflow:abort'),
  saveWorkflow: (item: { id?: string; name: string; description?: string; steps: unknown[] }) => ipcRenderer.invoke('antifan:workflow:save', item),
  deleteWorkflow: (id: string) => ipcRenderer.invoke('antifan:workflow:delete', id),
  runThemeQa: (options?: { workspaceRoot?: string }) => ipcRenderer.invoke(CHANNELS.THEME_QA_RUN, options),
  onThemeQaState: (callback: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on(CHANNELS.THEME_QA_STATE, handler);
    return () => ipcRenderer.removeListener(CHANNELS.THEME_QA_STATE, handler);
  },
  getWorkflowArtifact: (artifactId: string) => ipcRenderer.invoke('antifan:workflow:get-artifact', artifactId),
  onWorkflowEvent: (callback: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data);
    ipcRenderer.on('antifan:workflow:event', handler);
    return () => {
      ipcRenderer.removeListener('antifan:workflow:event', handler);
    };
  },

  onStateUpdated: (callback: (state: any) => void) => {
    const handler = (_event: unknown, state: any) => callback(state);
    ipcRenderer.on(CHANNELS.STATE_UPDATED, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.STATE_UPDATED, handler);
    };
  },

  onElementPicked: (callback: (element: any) => void) => {
    const handler = (_event: unknown, element: any) => callback(element);
    ipcRenderer.on(CHANNELS.ELEMENT_PICKED, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.ELEMENT_PICKED, handler);
    };
  },

  onFocusFind: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('antifan:focus-find', handler);
    return () => {
      ipcRenderer.removeListener('antifan:focus-find', handler);
    };
  },

  onFocusOmnibox: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('antifan:focus-omnibox', handler);
    return () => {
      ipcRenderer.removeListener('antifan:focus-omnibox', handler);
    };
  },

  onShowShortcuts: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('antifan:show-shortcuts', handler);
    return () => {
      ipcRenderer.removeListener('antifan:show-shortcuts', handler);
    };
  },

  onFindResult: (callback: (result: any) => void) => {
    const handler = (_event: unknown, result: any) => callback(result);
    ipcRenderer.on(CHANNELS.FIND_RESULT, handler);
    return () => {
      ipcRenderer.removeListener(CHANNELS.FIND_RESULT, handler);
    };
  },

  onScreenshotCaptured: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('antifan:screenshot-captured', handler);
    return () => {
      ipcRenderer.removeListener('antifan:screenshot-captured', handler);
    };
  },
  popoutTerminal: () => ipcRenderer.invoke('antifan:terminal:popout'),
};

try {
  contextBridge.exposeInMainWorld('antifanToolbar', toolbarApi);
} catch (err) {
  console.error('[antifan preload] Failed to expose antifanToolbar:', err);
}

export type AntiFanToolbarApi = typeof toolbarApi;
