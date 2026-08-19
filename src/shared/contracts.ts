/**
 * AntiFan Browser Desktop — Shared Protocol Contracts & Data Types
 * Parity with Antigravity Desktop Chromium Engine, Utilities & AI Sidebar Bridge.
 */

export interface AntiFanTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  devicePresetId?: string;
  crashed?: boolean;
}

export interface ElementRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AntiFanPickedElement {
  tag: string;
  id?: string;
  classes: string[];
  textSnippet: string;
  xpath: string;
  selector: string;
  rect: ElementRect;
  computedStyles: Record<string, string>;
  fontFamily?: string;
  fontSize?: string;
  color?: string;
  backgroundColor?: string;
  screenshotBase64?: string;
  userComment?: string;
  markdownPath?: string;
  markdownContent?: string;
  targetImagePath?: string;
  viewportImagePath?: string;
  domAncestry?: string;
  dimensions?: string;
  outerHTML?: string;
  timestamp: number;
}

export interface ChatToolCall {
  id: string;
  name: string;
  args?: Record<string, any>;
  result?: any;
  status?: 'running' | 'done' | 'failed';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  thinking?: string;
  toolCalls?: ChatToolCall[];
  attachedElement?: AntiFanPickedElement;
  attachedImages?: Array<{ name: string; dataUrl: string }>;
  timestamp: number;
}

export interface AntiFanBridgeStatus {
  active: boolean;
  port: number;
  clientCount: number;
  activeTabId?: string;
  tabCount: number;
  inspecting: boolean;
  sidebarOpen?: boolean;
}

export interface BridgeRequestPayload<T = unknown> {
  id: string;
  method: string;
  params?: T;
}

export interface BridgeResponsePayload<T = unknown> {
  id: string;
  success: boolean;
  data?: T;
  error?: string;
}

export interface BridgeEventPayload<T = unknown> {
  event: string;
  data: T;
}

export const TOOLBAR_CHANNELS = {
  GET_INITIAL_STATE: 'antifan:toolbar:get-initial-state',
  CREATE_TAB: 'antifan:toolbar:create-tab',
  SWITCH_TAB: 'antifan:toolbar:switch-tab',
  CLOSE_TAB: 'antifan:toolbar:close-tab',
  MOVE_TAB: 'antifan:toolbar:move-tab',
  NAVIGATE: 'antifan:toolbar:navigate',
  RELOAD: 'antifan:toolbar:reload',
  STOP_LOADING: 'antifan:toolbar:stop-loading',
  GO_BACK: 'antifan:toolbar:go-back',
  GO_FORWARD: 'antifan:toolbar:go-forward',
  TOGGLE_INSPECT: 'antifan:toolbar:toggle-inspect',
  TOGGLE_FONT_FINDER: 'antifan:toolbar:toggle-font-finder',
  TOGGLE_LENS: 'antifan:toolbar:toggle-lens',
  TOGGLE_DEVTOOLS: 'antifan:toolbar:toggle-devtools',
  TOGGLE_SIDEBAR: 'antifan:toolbar:toggle-sidebar',
  SET_DEVICE_PRESET: 'antifan:toolbar:set-device-preset',
  SET_ZOOM: 'antifan:toolbar:set-zoom',
  CAPTURE_FULL_PAGE: 'antifan:toolbar:capture-full-page',
  CAPTURE_VIEWPORT: 'antifan:toolbar:capture-viewport',
  OPEN_EXTERNAL: 'antifan:toolbar:open-external',
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
  TOGGLE_RULER: 'antifan:toolbar:toggle-ruler',
  TOGGLE_TERMINAL: 'antifan:toolbar:toggle-terminal',
  GET_SUGGESTIONS: 'antifan:toolbar:get-suggestions',
  STATE_UPDATED: 'antifan:toolbar:state-updated',
  ELEMENT_PICKED: 'antifan:toolbar:element-picked',
  FIND_RESULT: 'antifan:toolbar:find-result',
} as const;

export interface SessionInfo {
  id: string;
  title: string;
  mtime: number;
  active: boolean;
  status?: 'running' | 'done' | 'idle';
  messageCount?: number;
  projectGroup?: string;
}

export const SIDEBAR_CHANNELS = {
  GET_INITIAL_STATE: 'antifan:sidebar:get-initial-state',
  SEND_PROMPT: 'antifan:sidebar:send-prompt',
  STREAM_UPDATE: 'antifan:sidebar:stream-update',
  CLEAR_HISTORY: 'antifan:sidebar:clear-history',
  ATTACH_ELEMENT: 'antifan:sidebar:attach-element',
  CLOSE_SIDEBAR: 'antifan:sidebar:close-sidebar',
  SET_WIDTH: 'antifan:sidebar:set-width',
  GET_SESSIONS: 'antifan:sidebar:get-sessions',
  SWITCH_SESSION: 'antifan:sidebar:switch-session',
  RENAME_SESSION: 'antifan:sidebar:rename-session',
  DELETE_SESSION: 'antifan:sidebar:delete-session',
  SESSION_CHANGED: 'antifan:sidebar:session-changed',
} as const;

export const TERMINAL_CHANNELS = {
  START: 'antifan:terminal:start',
  INPUT: 'antifan:terminal:input',
  KILL: 'antifan:terminal:kill',
  RESTART: 'antifan:terminal:restart',
  DATA: 'antifan:terminal:data',
} as const;
