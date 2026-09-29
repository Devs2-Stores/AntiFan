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
  userAgentMode?: 'clean' | 'native';
  partition?: string;
  ephemeral?: boolean;
  offscreen?: boolean;
  /**
   * Set while the tab's WebContentsViews are destroyed to reclaim the renderer.
   * The record (id, url, title, favicon, scroll) survives; wake recreates the
   * views on first touch. History back/forward is NOT restored.
   */
  hibernated?: boolean;
  /** Wall time the tab last was active or saw user input; 0/absent = never. */
  lastActiveAt?: number;
  splitMode?: boolean;
  splitDesktopPresetId?: string;
  splitMobilePresetId?: string;
  splitFocusedPane?: 'desktop' | 'mobile';
  splitError?: string | null;
  alias?: string;
  role?: 'storefront' | 'admin' | 'feedback' | 'spec' | string;
  aliasColor?: string;
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
  tabId?: string;
  /**
   * Annotation was captured for the clipboard only: artifacts are still written,
   * but the prompt is never typed into the terminal.
   */
  copyOnly?: boolean;
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
  /** The bridge's own self-report; the evaluated verdict lives on `BridgeHealthReport.state`. */
  health: BridgeHealthState;
  /** The last refusal or lost client attempt the server recorded, when inside memory. */
  lastFailure?: BridgeFailureRecord;
}

/**
 * What the bridge believes about itself. This is the vocabulary the published discovery
 * record and `AntiFanBridgeStatus.health` share; it is a *self-report*, and a consumer
 * that needs a verdict reads `BridgeHealthReport.state`, which weighs the record against
 * pid liveness and freshness.
 */
export type BridgeHealthState = 'listening' | 'degraded' | 'down';

/**
 * One refusal the server issued or one client attempt it lost. `message` is composed
 * server-side per `code` and never echoes client input: this record is published to
 * `bridge.json` and mirrored to `~/.gemini`, both of which other tools read.
 */
export interface BridgeFailureRecord {
  code: string;
  message: string;
  at: number;
}

/** Why an evaluated report does not read `listening` when the record itself cannot say. */
export type BridgeHealthReasonCode =
  | 'HEALTH_RECORD_ABSENT'
  | 'HEALTH_PID_DEAD'
  | 'HEALTH_STALE'
  | 'HEALTH_RECORD_CORRUPT'
  | 'HEALTH_RECORD_LEGACY';

/** One fresh row of the launcher's client-failure journal, as the report folds it in. */
export interface BridgeClientFailureRow {
  at: number;
  code: string;
  message: string;
  terminalSessionId?: string;
  pid?: number;
}

/**
 * The Manager's bridge answer: the live snapshot, the evaluated verdict, and both evidence
 * planes. `health` stays the writer's self-report while `state` is the verdict, so a
 * server whose record is stale or whose pid is gone is reported `down` even when its own
 * file still claims `listening`. A report is never thrown for a bridge that is down: a
 * `down` bridge is an answer, and the renderer tells it apart from broken IPC by getting a
 * well-formed payload back.
 */
export interface BridgeHealthReport {
  active: boolean;
  port: number;
  clientCount: number;
  activeTabId?: string;
  tabCount: number;
  inspecting: boolean;
  sidebarOpen?: boolean;
  /** The live process's self-report, or the record's when no instance is constructed yet. */
  health: BridgeHealthState;
  lastFailure?: BridgeFailureRecord;
  /** The evaluated verdict a consumer renders. */
  state: BridgeHealthState;
  reasonCode?: BridgeHealthReasonCode;
  record: { present: boolean; stale: boolean; updatedAt?: number };
  clientFailures: { count: number; latestAt?: number; latest?: BridgeClientFailureRow };
}

/** The MCP bridge's own channels: one invoke route, one transition push. */
export const BRIDGE_CHANNELS = {
  GET_STATUS: 'antifan:bridge:get-status',
  STATUS_CHANGED: 'antifan:bridge:status',
} as const;

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
  THEME_QA_RUN: 'antifan:toolbar:theme-qa-run',
  THEME_QA_STATE: 'antifan:toolbar:theme-qa-state',
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
  GET_SUGGESTIONS: 'antifan:toolbar:get-suggestions',
  STATE_UPDATED: 'antifan:toolbar:state-updated',
  ELEMENT_PICKED: 'antifan:toolbar:element-picked',
  FIND_RESULT: 'antifan:toolbar:find-result',
  GET_MOBILE_REMOTE_INFO: 'antifan:toolbar:get-mobile-remote-info',
  TOGGLE_SPLIT_REVIEW: 'antifan:toolbar:toggle-split-review',
  SET_SPLIT_PRESET: 'antifan:toolbar:set-split-preset',
  SET_SPLIT_FOCUSED_PANE: 'antifan:toolbar:set-split-focused-pane',
  PHONE_STATUS: 'antifan:toolbar:phone-status',
  GET_PHONE_STATUS: 'antifan:toolbar:get-phone-status',
  WORKSPACE_IDENTIFY: 'antifan:toolbar:workspace-identify',
};

export interface ToolbarPhoneStatus {
  state: 'connected' | 'disconnected' | 'unknown';
  name?: string;
  model?: string;
  osVersion?: string;
  deviceId?: string;
  connection?: string;
  detail?: string;
  lastChecked?: number;
}

/**
 * Cross-project window contracts.
 *
 * Every label below is resolved by Main from its validated registries; a renderer only
 * displays it and echoes stable ids back. A title or a status line a renderer produced
 * itself is never authority over which window or tab a request targets.
 *
 * Listing and activation are deliberately two channels. `TABS_SEARCH` must stay free of
 * focus, selection and attachment side effects — it is an inventory read that any shell
 * may perform — while `TABS_SEARCH_ACTIVATE` is the only path that may present another
 * window, and it exists for one explicit user action on one exact id.
 *
 * `CLOSE_REFUSED` is the one channel Main pushes to a shell's chrome and nothing travels
 * back on it: it carries a decision already made (see `CloseRefusalNotice`), so it cannot
 * be a request and has no reply.
 */
export const PROJECT_WINDOW_CHANNELS = {
  TABS_SEARCH: 'antifan:tabs:search',
  TABS_SEARCH_ACTIVATE: 'antifan:tabs:search-activate',
  PROJECT_OPEN: 'antifan:project:open',
  PROJECT_LIST: 'antifan:project:list',
  PROJECT_OPEN_PICKER: 'antifan:project:open-picker',
  PROJECT_OPEN_PICKER_ANSWER: 'antifan:project:open-picker-answer',
  PROJECT_RENAME: 'antifan:project:rename',
  PROJECT_REMOVE: 'antifan:project:remove',
  PROJECT_REMOVE_ANSWER: 'antifan:project:remove-answer',
  CLOSE_REFUSED: 'antifan:close:refused',
} as const;

/**
 * Wire form of the Main-side window owner: a project and Unassigned are disjoint, so a
 * project id can never collide with the Unassigned bucket.
 */
export type ProjectWindowOwner =
  | { kind: 'project'; projectId: string }
  | { kind: 'unassigned' };

/**
 * The identity Main resolved for the shell a renderer is the chrome of.
 *
 * `title` and `pathLabel` are display projections of validated records. Absent identity
 * means Main has not described the shell — not that the renderer may name its own. On the
 * initial state the field is read as-is; in a later state broadcast the key's presence is
 * the signal, so a broadcast that omits it carries no identity news while an explicit
 * `projectWindow: null` retracts the identity and hides the renderer's labels.
 */
export interface ProjectWindowIdentity {
  owner: ProjectWindowOwner;
  title: string;
  /** Workspace path that disambiguates duplicate project titles. */
  pathLabel?: string;
  /** Workspace root this shell's terminals and workspace-scoped tools belong to. */
  workspacePath?: string;
}

/** Request body of `antifan:tabs:search`. A literal query; `''` lists the full inventory. */
export interface ProjectTabSearchQuery {
  query: string;
}

/** One row of the Main-owned user-visible tab inventory. */
export interface ProjectTabSearchRow {
  /** Exact live tab identity. A row is addressed by this id, never by its index. */
  tabId: string;
  title: string;
  url: string;
  /** Project title, or Unassigned, as Main resolved it. */
  ownerLabel: string;
  /** Workspace path that distinguishes duplicate names; absent when the owner has none. */
  pathLabel?: string;
  /**
   * False only when Main asserted the tab was already gone while building this row.
   * Absent is not evidence of staleness: a row wrongly painted unavailable would hide a
   * live tab, and activation revalidates the exact id before any side effect anyway.
   */
  live?: boolean;
}

/** `UNAVAILABLE` means the inventory itself could not be established — not an empty result. */
export type ProjectTabSearchResult =
  | { status: 'OK'; rows: ProjectTabSearchRow[] }
  | { status: 'UNAVAILABLE'; reason: string };

/** Why an exact tab id could not be presented. No substitute target is ever implied. */
export type ProjectTabUnavailableCode =
  | 'TAB_CLOSED'
  | 'TAB_NOT_VISIBLE'
  | 'OWNER_UNRESOLVED'
  | 'WINDOW_FAILED';

export interface ProjectTabActivateRequest {
  tabId: string;
}

export type ProjectTabActivationResult =
  | { status: 'ACTIVATED'; tabId: string }
  | { status: 'UNAVAILABLE'; tabId: string; reasonCode: ProjectTabUnavailableCode; reason: string };


/** `OPENED` created a shell; `FOCUSED` presented the one that already existed. */
/** An absent `projectId` asks Main to present its existing project-opening surface. */
export interface ProjectOpenRequest {
  projectId?: string;
  /**
   * Open the project that owns this folder, creating one for it when Main knows none —
   * the same resolution the picker's folder chooser runs, without the dialog.
   */
  folder?: string;
}

/**
 * The answer `PROJECT_OPEN` gives the renderer. `OPENED` created a shell, `FOCUSED`
 * presented the one that already existed, `CANCELLED` is the user closing the picker,
 * and `FAILED` carries a classed reason (`INVALID_PROJECT_ID`, `UNKNOWN_PROJECT`,
 * `PROJECT_FOLDER_INVALID`, `AMBIGUOUS_PROJECT_FOLDER`, or a message). `projectId` is
 * present on every answer that names a real project — including a refused one — so the
 * caller never has to guess which id the outcome belongs to.
 */
export type ProjectOpenResult =
  | { status: 'OPENED'; projectId: string }
  | { status: 'FOCUSED'; projectId: string }
  | { status: 'CANCELLED'; projectId?: string }
  | { status: 'FAILED'; projectId?: string; reason: string };

/**
 * One row of the project inventory a renderer may host a picker for. Everything in it is
 * resolved by Main from its own records — `isCurrent` marks the project the asking window
 * already owns — so a click can only ever echo an id Main itself offered.
 */
export interface ProjectOpenListCandidate {
  projectId: string;
  name: string;
  workspacePath: string;
  /** Canonical capsule resolved for this project; absent when no unambiguous target exists. */
  capsuleId?: string;
  /** False only when Main currently refuses terminal assignment (unknown or ambiguous capsule claim). */
  canAssignTerminal?: boolean;
  isCurrent?: boolean;
}

/** Answer to `PROJECT_LIST`: the same inventory Main's own picker is built from. */
export interface ProjectOpenListResult {
  candidates: ProjectOpenListCandidate[];
}

/** `PROJECT_OPEN_PICKER` push: the request a chrome's modal answers under. */
export interface ProjectOpenPickerPush {
  requestId: string;
}

/**
 * The modal's answer, position-free: a project id Main offered, the folder chooser, or a
 * dismissal. Unlike the native button index, the id is validated against the inventory
 * Main pushed for that request, so a forged or stale id is a dismissal, never a project.
 */
export type ProjectOpenPickerChoice =
  | { kind: 'project'; projectId: string }
  | { kind: 'folder' }
  | { kind: 'cancelled' };

/** `PROJECT_OPEN_PICKER_ANSWER` payload: which request this choice belongs to. */
export interface ProjectOpenPickerAnswerPayload {
  requestId: string;
  choice: ProjectOpenPickerChoice;
}

/** `PROJECT_RENAME` request body: the new label for a project Main already knows. */
export interface ProjectRenameRequest {
  projectId: string;
  name: string;
}

/**
 * `PROJECT_RENAME` result. `RENAMED` means the capsule store — the durable name
 * authority — accepted the name, so the project list, the window chip and the next
 * boot's re-registration all read it. `UNKNOWN_PROJECT` means the id named nothing
 * Main could rename; `FAILED` carries a reason Main could not apply.
 */
export type ProjectRenameResult =
  | { status: 'RENAMED'; projectId: string; name: string }
  | { status: 'UNKNOWN_PROJECT'; projectId: string }
  | { status: 'FAILED'; projectId: string; reason: string };

/**
 * `PROJECT_REMOVE` request body. `confirmed` is the consent the modal's own inline
 * confirmation row produces; a first ask leaves it absent and Main answers with what
 * removing this project would interrupt rather than acting.
 */
export interface ProjectRemoveRequest {
  projectId: string;
  confirmed?: boolean;
}

/**
 * `PROJECT_REMOVE` result. `REMOVED` is a closed window plus a closed registry record
 * — nothing on disk is touched, so the workspace files stay and the capsule keeps its
 * path for a later re-open. `CONFIRM_REQUIRED` reports the live terminal count the
 * confirmation row has to quote; `CLOSE_REFUSED` means the window's own close gate
 * vetoed and the project stays; `UNKNOWN_PROJECT`/`FAILED` are the refusal envelope.
 */
export type ProjectRemoveResult =
  | { status: 'REMOVED'; projectId: string }
  | { status: 'CONFIRM_REQUIRED'; projectId: string; liveSessions: number }
  | { status: 'CLOSE_REFUSED'; projectId: string; reason: string }
  | { status: 'UNKNOWN_PROJECT'; projectId: string }
  | { status: 'FAILED'; projectId: string; reason: string };

/** `PROJECT_REMOVE_ANSWER` payload: the modal's confirmation of a `CONFIRM_REQUIRED` ask. */
export interface ProjectRemoveAnswerPayload {
  projectId: string;
  confirmed: boolean;
}

/**
 * One reason a close or quit was refused, as a display projection.
 *
 * `code` is the machine category Main already recorded; `detail` is the evidence text to
 * show verbatim. `controls` are the existing stop/release actions that would clear the
 * blocking work, and they are named for reading only — a surface that showed them as
 * buttons would be promising actions it cannot perform (`antifan.cli.endSession` is an
 * agent-session action no chrome can invoke). There is deliberately no force override:
 * the work named here has to end before the surface may close.
 */
export interface CloseRefusalReasonWire {
  code: string;
  detail: string;
  /** Page this reason concerns, when the evidence was page-scoped. */
  tabId?: string;
  controls: Array<{ id: string; label: string }>;
}

/**
 * A refused close or quit, pushed to the chrome that has to explain it.
 *
 * These are reasons Main already decided: the renderer displays them and decides nothing —
 * it cannot approve, defer or override the close, and no reply of any kind travels back.
 * `kind` is which request was refused (`close` is one shell's window close, `quit` is the
 * whole application), `ownerKey` names the refused shell and is present for `close` only,
 * `haltedBy` is the stop reason that ended the attempt, and `summary` is Main's own
 * one-line account of the attempt, which stands even when `reasons` is empty.
 */
export interface CloseRefusalNotice {
  kind: 'close' | 'quit';
  ownerKey?: string;
  haltedBy: string | null;
  summary: string;
  reasons: CloseRefusalReasonWire[];
}

export const FRAME_BACKDROP_CHANNELS = {
  UPDATE_LAYOUT: 'antifan:frame-backdrop:update-layout',
  FOCUS_PANE: 'antifan:frame-backdrop:focus-pane',
  READY: 'antifan:frame-backdrop:ready',
  RELOAD_PANE: 'antifan:frame-backdrop:reload-pane',
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
  CLOSE_SIDEBAR: 'antifan:sidebar:close-sidebar',
  SET_WIDTH: 'antifan:sidebar:set-width',
} as const;

/** What a terminal is for, stamped when it is created (or re-stamped by a person). Values are sanitised by the manager. */
export interface TerminalRoleMeta {
  role?: unknown;
  idlePolicy?: unknown;
  spaceTerminalId?: unknown;
}

/**
 * The outcome of one attempt to sleep a terminal: refused for a reason, or done. The IPC route
 * adds the two envelope refusals (`INVALID_PAYLOAD`, `NOT_PERMITTED`) before the manager is reached.
 */
export type TerminalSleepResult =
  | { ok: true }
  | { ok: false; reason: 'SLEEP_REFUSED_WATCHER' | 'NOT_RUNNING' | 'INVALID_PAYLOAD' | 'NOT_PERMITTED' };

export const TERMINAL_CHANNELS = {
  START: 'antifan:terminal:start',
  INPUT: 'antifan:terminal:input',
  KILL: 'antifan:terminal:kill',
  RESTART: 'antifan:terminal:restart',
  DATA: 'antifan:terminal:data',
  /**
   * Lightweight counterpart of DATA: same envelope, routed to surfaces that do
   * not display the session, so their tab strip keeps streaming/ack bookkeeping
   * without an xterm ever parsing the payload.
   */
  ACTIVITY: 'antifan:terminal:activity',
  GET_FULL_BUFFER: 'antifan:terminal:get-full-buffer',
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
  DUMP_DIAGNOSTICS: 'antifan:terminal:dump-diagnostics',
  GET_DELTA: 'antifan:terminal:get-delta',
  ACK: 'antifan:terminal:ack',
  SYNC_VIEW: 'antifan:terminal:sync-view',
  SLEEP_SESSION: 'antifan:terminal:sleep-session',
  WAKE_SESSION: 'antifan:terminal:wake-session',
  SET_CATEGORY: 'antifan:terminal:set-category',
  ASSIGN_PROJECT: 'antifan:terminal:assign-project',
  /** Mark a human-owned terminal as a theme-sync watcher (or clear it): a watcher refuses sleep. */
  SET_ROLE: 'antifan:terminal:set-role',
  /**
   * Mint a terminal bound to one folder — from a chooser or an explicit `{ folder }` —
   * without re-pointing any window's capsule or cwd. The folder a project window names
   * must be its own; the shared manager may name any real directory.
   */
  NEW_IN_FOLDER: 'antifan:terminal:new-in-folder',
  /** Open a folder's declared Space (`.antifan/space.json`): its terminals and web tabs. */
  SPACE_OPEN: 'antifan:space:open',
  /** Scaffold `.antifan/space.json` from the folder's current terminals and tabs. Never overwrites. */
  SPACE_INIT: 'antifan:space:init',
  OPEN_LINK: 'antifan:terminal:open-link',
  SET_TAB_PREFS: 'antifan:terminal:set-tab-prefs',
  /** One run-control request (cancel or steer) aimed at a run bound to a terminal session. */
  RUN_CONTROL: 'antifan:run:control',
  /** The per-window run-card projection, pushed on every run-state change. */
  RUN_STATE: 'antifan:run:state',
} as const;

/**
 * Why a folder-bound terminal mint was refused. Each member is a class the renderer can
 * translate, and none of them is invented success: a chooser the user closed is `CANCELLED`,
 * a folder the asking window does not own is `FOLDER_NOT_OWNED`, never `ok`.
 */
export type TerminalNewInFolderReason =
  | 'INVALID_PAYLOAD'
  | 'CANCELLED'
  | 'FOLDER_INVALID'
  | 'FOLDER_NOT_OWNED'
  | 'SENDER_NOT_ADMITTED'
  | 'CREATE_FAILED';

/**
 * The answer `antifan:terminal:new-in-folder` gives the renderer: the minted session and
 * the capsule it was bound to, or a refusal with its class.
 */
export type TerminalNewInFolderResult =
  | { ok: true; sessionId: string; capsuleId: string }
  | { ok: false; reason: TerminalNewInFolderReason; message: string };

/**
 * The answer `antifan:space:open` gives the renderer. `NEEDS_CONFIRM` carries the exact commands
 * the manifest would type into shells and the content hash the confirming call must echo back.
 */
export type SpaceOpenReason =
  | 'INVALID_PAYLOAD'
  | 'FOLDER_INVALID'
  | 'FOLDER_NOT_OWNED'
  | 'NO_MANIFEST'
  | 'MANIFEST_INVALID'
  | 'CONFIRM_MISMATCH'
  | 'WINDOW_FAILED'
  | 'CREATE_FAILED'
  | 'SENDER_NOT_ADMITTED';

export type SpaceOpenResult =
  | {
      ok: true;
      terminalsOpened: number;
      terminalsReused: number;
      /** Of the reused terminals, how many were sleeping and were woken to run their declared command. */
      terminalsWoken?: number;
      tabsOpened: number;
      tabsReused: number;
      /** Declared `sync` terminals not minted because a live watcher already pushes to their remote. */
      syncDuplicates?: Array<{ spaceTerminalId: string; duplicate: { id: string; label: string } }>;
    }
  | { ok: false; reason: 'NEEDS_CONFIRM'; hash: string; commands: Array<{ label: string; command: string }> }
  | { ok: false; reason: SpaceOpenReason; message: string; errors?: Array<{ path: string; message: string }> };

export type SpaceInitResult =
  | { ok: true; terminals: number; tabs: number; gitignoreWarning?: true }
  | { ok: false; reason: 'INVALID_PAYLOAD' | 'FOLDER_INVALID' | 'FOLDER_NOT_OWNED' | 'ALREADY_EXISTS' | 'WRITE_FAILED'; message: string };


/** Which control a run card can send. */
export type RunControlOp = 'cancel' | 'steer';

/**
 * Why a run control was refused. Every member is a class the renderer can render, and
 * none of them is invented success: an ack that cannot be read is `RUN_CONTROL_FAILED`,
 * never `ok`.
 */
export type RunControlReason =
  | 'INVALID_PAYLOAD'
  | 'UNKNOWN_SESSION'
  | 'SESSION_NOT_VISIBLE'
  | 'MANAGER_AGENT_SESSION_READ_ONLY'
  | 'RUN_NOT_ACTIVE'
  | 'STALE_RUN_SEQ'
  | 'RUN_CONTROL_TIMEOUT'
  | 'RUN_CONTROL_UNSUPPORTED'
  | 'RUN_BACKEND_UNAVAILABLE'
  | 'ACTUATOR_FAILED'
  | 'RUN_CONTROL_FAILED';

/**
 * The answer `antifan:run:control` gives the renderer: the control that landed, or a
 * refusal with its class.
 */
export type RunControlResult =
  | { ok: true; op: RunControlOp; at: number }
  | { ok: false; reason: RunControlReason; message: string };

/** The lifecycle an agent process reports about one terminal session's run. */
export type RunCardLifecycle = 'idle' | 'running' | 'waiting_user' | 'ended';

/** The edit-mode mirror (S1) as the run file records it. `unset` is "no scoped mode". */
export type RunCardMode = 'unset' | 'core' | 'direct' | 'fast';

/**
 * One run card as Main projects it for a *receiving window*: the run file an agent
 * process wrote about a terminal session, joined to the session, its capsule and any
 * control-plane run, with `viewOnly` already computed for the window being answered.
 */
export interface RunCardState {
  terminalSessionId: string;
  ompSessionId?: string;
  state: RunCardLifecycle;
  /** The run file's process is gone or its heartbeat is older than the stale window. */
  stale: boolean;
  mode: RunCardMode;
  runSeq: number;
  runStartedAt?: number;
  lastEventAt?: number;
  lastTool?: string;
  /** First ≤120 chars of the run's prompt: a preview, never a transcript. */
  promptHead?: string;
  cwd?: string;
  capsuleId?: string;
  /** True when this window may observe the run but not steer it (an agent-owned row). */
  viewOnly: boolean;
  controlPlane?: { runId: string; attemptId?: string; backendId: string };
  changes?: { files: string[]; fileCount: number; blockedCount: number };
}

/**
 * A capsule's pinned brief: the client-work context every prompt of an agent run bound to
 * that capsule carries. Every field is optional; validation happens on the write path, and
 * a bad field refuses the whole write rather than feeding an agent rules nobody agreed to.
 */
export interface CapsuleBrief {
  /** http(s) only, ≤300 chars. */
  storefrontUrl?: string;
  /** ≤80 chars. */
  siteName?: string;
  /** ≤64 chars, `^[0-9A-Za-z_-]+$`. */
  themeId?: string;
  /** ≤8 entries, each ≤200 chars. */
  rules?: string[];
}

/** Why a capsule brief read or write was refused. */
export type CapsuleBriefReason = 'INVALID_BRIEF' | 'UNKNOWN_CAPSULE' | 'INVALID_PAYLOAD';

/** The answer of the brief read and the brief write: the brief that is now in force. */
export type CapsuleBriefResult =
  | { ok: true; capsuleId: string; brief: CapsuleBrief | null }
  | { ok: false; reason: CapsuleBriefReason; message: string };

export type TerminalSyncViewResult =
  | { status: 'UP_TO_DATE'; generation: number; lastSeq: number }
  | { status: 'DELTA'; generation: number; fromSeq: number; throughSeq: number; chunks: Array<{ seq: number; data: string }> }
  | { status: 'DELTA_EXPIRED'; generation: number; retainedFromSeq: number; retainedThroughSeq: number }
  | { status: 'GENERATION_CHANGED'; currentGeneration: number }
  | { status: 'SESSION_CLOSED'; finalSeq: number };

export interface TerminalAckPayload {
  rendererInstanceId: string;
  sessionId: string;
  generation: number;
  seq: number;
  role?: 'DOCK' | 'POPOUT';
}

/**
 * Renderer-facing terminal output envelope.
 *
 * `seq` is intentionally retained as an alias of `throughSeq` (when the batch is
 * coalesced) so consumers that only understand a single sequence number keep
 * working. A coalesced batch additionally carries the contiguous range it
 * covers: the renderer advances `lastRenderedSeq` to `throughSeq` directly
 * instead of treating the batch as a gap and triggering a resync storm.
 */
export interface TerminalDataPayload {
  sessionId: string;
  data: string;
  seq: number;
  generation?: number;
  /** First sequence number contained in a coalesced batch. */
  fromSeq?: number;
  /** Last sequence number contained in a coalesced batch (equals `seq`). */
  throughSeq?: number;
}

/** Tab strip orientation for the terminal surface. Horizontal is the default. */
export type TerminalTabLayout = 'horizontal' | 'sidebar';

/** Durable terminal tab-strip preferences persisted alongside saved-tabs.json. */
export interface TerminalTabPrefs {
  layout: TerminalTabLayout;
  sidebarWidth: number;
  collapsedCategories: string[];
  /**
   * User-managed group names, in display order.
   *
   * Grouping is otherwise *derived* from `session.category`, which cannot express
   * a group with no tabs in it. This list is what makes an empty group possible
   * and survivable across a restart, and it is also the authoritative display
   * order for the sidebar's headers.
   */
  categories: string[];
  /**
   * Per-category chip colour, keyed by the category name exactly as displayed.
   *
   * Absence means "derive it": the sidebar hashes the name onto its palette, so a
   * group keeps one colour without anyone picking one. Only a deliberate choice is
   * stored, which is what makes "Màu tự động" a delete rather than a sentinel value.
   */
  categoryColors: Record<string, string>;
  /**
   * Categories the user marked with `*`.
   *
   * A marker, never an ordering: display order stays `categories`, so starring a group
   * can never reshuffle a list the user just arranged.
   */
  starredCategories: string[];
}

/** Public DTO describing a terminal session's browser-tab affinity binding. */
export interface TerminalAgentAffinityInfo {
  tabId: string;
  primaryTabId: string;
  managedTabIds: string[];
  status: 'alive' | 'closed';
  lastUrl?: string;
  isOffscreen?: boolean;
  isEphemeral?: boolean;
  title?: string;
  url?: string;
}

/** Cap on stored colour overrides, so a corrupt file cannot smuggle in an unbounded map. */
export const TERMINAL_CATEGORY_COLORS_MAX = 128;

/** A colour override is a plain 6-digit hex; anything else is unreadable and dropped. */
export const TERMINAL_CATEGORY_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const TERMINAL_TAB_LAYOUT_MIN_WIDTH = 140;
export const TERMINAL_TAB_LAYOUT_MAX_WIDTH = 400;
export const TERMINAL_TAB_LAYOUT_DEFAULT_WIDTH = 220;

export function clampTerminalTabSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return TERMINAL_TAB_LAYOUT_DEFAULT_WIDTH;
  return Math.max(TERMINAL_TAB_LAYOUT_MIN_WIDTH, Math.min(Math.round(width), TERMINAL_TAB_LAYOUT_MAX_WIDTH));
}

export interface TerminalJournalEntry {
  seq: number;
  generation: number;
  data: string;
  byteLength: number;
  timestamp: number;
}

export type TerminalDeltaResult =
  | {
      status: 'OK';
      generation: number;
      fromSeq: number;
      throughSeq: number;
      chunks: Array<{ seq: number; data: string }>;
    }
  | {
      status: 'DELTA_EXPIRED';
      generation: number;
      retainedFromSeq: number;
      retainedThroughSeq: number;
    }
  | {
      status: 'GENERATION_MISMATCH';
      currentGeneration: number;
    }
  | {
      status: 'SESSION_CLOSED';
      finalSeq: number;
    };

export type {
  ClientInvocationIntent,
  MainResolvedAuthority,
  CapabilityExecutionControl,
  InvocationDispatchStage,
  OwnerCancellationBehavior,
  SubscriberDisconnectBehavior,
  EffectMarker,
  EffectAcknowledgement,
  CancellationAck,
  CapabilityEffectPolicy,
  CapabilityEffectPolicyInput,
  AuthoritativeInvocationReceipt,
  McpEvidence,
  InvocationBinding,
  InvocationState,
  AuthorityRevisionHandle,
  CapabilityRisk,
  CapabilityErrorCode,
} from './control-plane-contracts';
