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
  isAudible?: boolean;
  isMuted?: boolean;
  scrollX?: number;
  scrollY?: number;
  aiState?: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working';
  isAgentControlled?: boolean;
  themeError?: string | null;
  terminalSessionId?: string;
  capsuleId?: string;
  splitMode?: boolean;
  splitDesktopPresetId?: string;
  splitMobilePresetId?: string;
  splitFocusedPane?: 'desktop' | 'mobile';
  splitError?: string | null;
}

export type SplitPaneId = 'desktop' | 'mobile';

export interface SplitReviewState {
  enabled: boolean;
  desktopPresetId: string;
  mobilePresetId: string;
  focusedPane: SplitPaneId;
  error?: string | null;
}

export interface SplitReviewConfig {
  enabled: boolean;
  desktopPresetId: string;
  mobilePresetId: string;
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
  targetSessionId?: string;
  deliveryMode?: 'auto' | 'draft';
}

export interface ChatToolCall {
  id: string;
  name: string;
  args?: Record<string, any>;
  result?: any;
  status?: 'running' | 'done' | 'failed';
}

export type BridgeDeliveryState = 'queued' | 'ide-api-accepted' | 'failed' | 'unknown';
export type BridgeObservationState = 'none' | 'prompt-observed' | 'response-observed';
export type AntigravityDeliveryRoute = 'sidecar-agentapi' | 'active-panel';

export interface AntigravityAttachmentDescriptor {
  name: string;
  filePath: string;
  mime: string;
  byteLength: number;
  sha256?: string;
}

export interface AntigravityCommandV2 {
  protocolVersion: 2;
  id: string;
  senderId: string;
  createdAtEpochMs: number;
  expiresAtEpochMs: number;
  targetWorkspace: {
    folderUri: string;
    folderName?: string;
  };
  action: 'send-prompt' | 'abort';
  mode: 'draft' | 'auto';
  promptText: string;
  promptDigest: string;
  targetConversationId?: string;
  backendSessionRef?: string;
  requestedRoute?: AntigravityDeliveryRoute;
  attachments?: AntigravityAttachmentDescriptor[];
  clientInstanceId?: string;
  meta?: Record<string, unknown>;
}

export interface AntigravityResultV2 {
  protocolVersion: 2;
  commandId: string;
  hostInstanceId: string;
  hostEpoch: number;
  targetWorkspace: {
    folderUri: string;
  };
  ok: boolean;
  deliveryState: BridgeDeliveryState;
  actualRoute?: AntigravityDeliveryRoute;
  sidecarRequestId?: string;
  sidecarInstanceId?: string;
  fallbackReason?: string;
  errorCode?: string;
  errorMessage?: string;
  completedAtEpochMs: number;
  promptDigest?: string;
  projectId?: string;
  workspaceId?: string;
  attemptId?: string;
  backendSessionRef?: string;
  sourceCommandId?: string;
  meta?: Record<string, unknown>;
}

export interface AntigravityHostV2 {
  protocolVersion: 2;
  hostInstanceId: string;
  hostEpoch: number;
  workspaceUri: string;
  extensionVersion: string;
  capabilities: {
    actions: ('send-prompt' | 'abort')[];
    modes: ('draft' | 'auto')[];
    maxAttachments: number;
    maxPayloadBytes: number;
  };
  lastHeartbeatEpochMs: number;
}

export interface BridgeDeliveryUpdatePayload {
  messageId: string;
  commandId: string;
  deliveryState: BridgeDeliveryState;
  actualRoute?: AntigravityDeliveryRoute;
  observationState?: BridgeObservationState;
  errorCode?: string;
  errorMessage?: string;
  updatedAtEpochMs: number;
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
  commandId?: string;
  deliveryState?: BridgeDeliveryState;
  actualRoute?: AntigravityDeliveryRoute;
  observationState?: BridgeObservationState;
  deliveryError?: string;
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
  TOGGLE_RULER: 'antifan:toolbar:toggle-ruler',
  TOGGLE_TERMINAL: 'antifan:toolbar:toggle-terminal',
  GET_SUGGESTIONS: 'antifan:toolbar:get-suggestions',
  STATE_UPDATED: 'antifan:toolbar:state-updated',
  ELEMENT_PICKED: 'antifan:toolbar:element-picked',
  FIND_RESULT: 'antifan:toolbar:find-result',
  GET_MOBILE_REMOTE_INFO: 'antifan:toolbar:get-mobile-remote-info',
  TOGGLE_SPLIT_REVIEW: 'antifan:toolbar:toggle-split-review',
  SET_SPLIT_PRESET: 'antifan:toolbar:set-split-preset',
  SET_SPLIT_FOCUSED_PANE: 'antifan:toolbar:set-split-focused-pane',
};

export const FRAME_BACKDROP_CHANNELS = {
  UPDATE_LAYOUT: 'antifan:frame-backdrop:update-layout',
  FOCUS_PANE: 'antifan:frame-backdrop:focus-pane',
  READY: 'antifan:frame-backdrop:ready',
} as const;

export interface SessionInfo {
  id: string;
  title: string;
  mtime: number;
  active: boolean;
  status?: 'running' | 'done' | 'idle';
  messageCount?: number;
  projectGroup?: string;
  workspacePath?: string;
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
  ABORT_GENERATION: 'antifan:sidebar:abort-generation',
  GET_AUTOCOMPLETE_ITEMS: 'antifan:sidebar:get-autocomplete-items',
  DELIVERY_STATE_CHANGED: 'antifan:sidebar:delivery-state-changed',
  HOST_STATUS_CHANGED: 'antifan:sidebar:host-status-changed',
} as const;

export const TERMINAL_CHANNELS = {
  START: 'antifan:terminal:start',
  INPUT: 'antifan:terminal:input',
  KILL: 'antifan:terminal:kill',
  RESTART: 'antifan:terminal:restart',
  DATA: 'antifan:terminal:data',
  RESIZE: 'antifan:terminal:resize',
  NEW_SESSION: 'antifan:terminal:new-session',
  LIST_SESSIONS: 'antifan:terminal:list-sessions',
  SWITCH_SESSION: 'antifan:terminal:switch-session',
  RENAME_SESSION: 'antifan:terminal:rename-session',
  POPOUT: 'antifan:terminal:popout',
  NEW_WINDOW: 'antifan:terminal:new-window',
  CLOSE_WINDOW: 'antifan:terminal:close-window',
  SET_ACTIVE_SESSION: 'antifan:terminal:set-active-session',
  REDOCK: 'antifan:terminal:redock',
  GET_POPOUT_STATE: 'antifan:terminal:get-popout-state',
  POPOUT_STATE_CHANGED: 'antifan:terminal:popout-state-changed',
  OPEN_IN_VSCODE: 'antifan:terminal:open-in-vscode',
} as const;
