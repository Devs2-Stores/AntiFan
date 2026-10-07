/**
 * AntiFan Browser Desktop — Toolbar Client Script
 * Classic Antigravity Browser UI Logic (Original VS Code Dark Theme).
 */

// The checklist domain constants live in `src/shared/theme-checklist.ts` so the
// toolbar, the main-owned store and the cockpit capabilities render identical
// defaults and reports. This file is a classic script (exports-shim provides
// `exports`/`module`, never `require`), so a value `import` would emit a CJS
// `require` that cannot run here — the shared module is injected into the
// compiled toolbar.js as the `ThemeChecklistShared` global by copy-static.mjs
// instead. Types are imported (erased at emit); values arrive via the ambient
// declaration below.
import type { ThemeChecklistItem, ThemePageDef } from '../shared/theme-checklist';

/** Value surface of `src/shared/theme-checklist.ts` consumed by this renderer. */
interface ThemeChecklistSharedApi {
  PAGE_DEFS: Record<string, ThemePageDef>;
  DEFAULT_THEME_CHECKLIST: ThemeChecklistItem[];
  QA_GATE_DISCLAIMER: string;
  UNKNOWN_WORKSPACE_TAG: string;
  WORKSPACE_IDENTIFY_TIMEOUT_MS: number;
  PRODUCT_PAGE_PATH: RegExp;
  workspaceTag(workspacePath?: string): string;
  checklistScope(origin: string, tag?: string): string;
  buildChecklistReport(scope: string, items: ThemeChecklistItem[]): string;
}

declare const ThemeChecklistShared: ThemeChecklistSharedApi | undefined;

/**
 * Resolve the shared checklist module. Lazy so a raw (non-copy-static) emit
 * keeps every non-checklist surface alive; the checklist itself has no local
 * copy of the constants to degrade to.
 */
function themeShared(): ThemeChecklistSharedApi {
  if (typeof ThemeChecklistShared === 'undefined' || !ThemeChecklistShared) {
    throw new Error('[ThemeStudio] theme-checklist shared module is not loaded');
  }
  return ThemeChecklistShared;
}

interface AntiFanTab {
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
  ephemeral?: boolean;
  hibernated?: boolean;
  splitMode?: boolean;
  splitDesktopPresetId?: string;
  splitMobilePresetId?: string;
  splitFocusedPane?: 'desktop' | 'mobile';
  splitError?: string;
  /** Web-hub scope stamp: absent means shared — the tab renders under every project. */
  projectId?: string;
}
interface ThemeQaState { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: Record<string, unknown>; error?: string; updatedAt: number; }
interface ToolbarPhoneStatus {
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
 * Wire shapes of the cross-project contracts. This renderer is a classic script, so it
 * cannot import `src/shared/contracts.ts` and mirrors the projections it consumes —
 * exactly as it already does for tabs and phone status. Everything arriving from the
 * bridge is validated before use: a renderer that trusted an unvalidated row could
 * address a tab id nobody reported.
 */
interface ProjectWindowIdentity {
  owner: { kind: 'project'; projectId: string } | { kind: 'web' } | { kind: 'unassigned' };
  title: string;
  pathLabel?: string;
  /** The project a 'web' hub presents; the strip filters to it only when this is a definite id. */
  activeProjectId?: string | null;
}

interface ProjectTabSearchRow {
  tabId: string;
  title: string;
  url: string;
  ownerLabel: string;
  pathLabel?: string;
  live?: boolean;
}

type ProjectTabSearchResult =
  | { status: 'OK'; rows: ProjectTabSearchRow[] }
  | { status: 'UNAVAILABLE'; reason: string };

type ProjectTabActivationResult =
  | { status: 'ACTIVATED'; tabId: string }
  | { status: 'UNAVAILABLE'; tabId: string; reasonCode: string; reason: string };
type ProjectOpenResult =
  | { status: 'OPENED' | 'FOCUSED' | 'CANCELLED'; projectId?: string }
  | { status: 'FAILED'; projectId?: string; reason: string };

type ProjectDetachResult =
  | { status: 'DETACHED' | 'FOCUSED'; projectId: string }
  | { status: 'FAILED'; projectId?: string; reason: string };

type ProjectReattachResult =
  | { status: 'REATTACHED'; projectId: string }
  | { status: 'FAILED'; projectId?: string; reason: string };

/** Payload shape of a successful THEME_CHECKLIST_LOAD invoke. */
interface ThemeChecklistLoadResult {
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
  /** Whether this scope already has a persisted record (vs. seeded defaults). */
  existed: boolean;
  /** Whether the record already absorbed legacy localStorage state. */
  migrated: boolean;
  legacyMigrated?: boolean;
  /** In-memory scope (unknown workspace): nothing it returns ever touched disk. */
  isProvisional: boolean;
}

/** Whole-array CAS save answer; `conflict` carries the store's rows for adoption. */
interface ThemeChecklistSaveResult {
  ok: boolean;
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
  conflict?: boolean;
  isProvisional?: boolean;
}

/** Broadcast frame every checklist mutation (toolbar or agent) emits. */
interface ThemeChecklistUpdatedPayload {
  scope: string;
  workspaceRoot: string;
  items: ThemeChecklistItem[];
  updatedAt: number;
}

interface AntiFanToolbarApi {
  getInitialState: () => Promise<any>;
  createTab: (url?: string) => Promise<string>;
  switchTab: (tabId: string) => Promise<boolean>;
  closeTab: (tabId: string) => Promise<boolean>;
  moveTab: (tabId: string, toIndex: number) => Promise<boolean>;
  duplicateTab: (tabId: string) => Promise<string>;
  closeOtherTabs: (tabId: string) => Promise<void>;
  closeTabsToRight: (tabId: string) => Promise<void>;
  setTabTerminalSession: (tabId: string, terminalSessionId: string) => Promise<boolean>;
  navigate: (url: string, tabId?: string) => Promise<boolean>;
  reload: (tabId?: string) => Promise<boolean>;
  reloadWindow: () => Promise<boolean>;
  stopLoading: (tabId?: string) => Promise<boolean>;
  goBack: (tabId?: string) => Promise<boolean>;
  goForward: (tabId?: string) => Promise<boolean>;
  toggleInspect: () => Promise<boolean>;
  toggleFontFinder: () => Promise<boolean>;
  toggleLens: () => Promise<boolean>;
  toggleRuler: () => Promise<boolean>;
  toggleDevTools: () => Promise<void>;
  toggleSidebar: () => Promise<boolean>;
  setDevicePreset: (presetId: string, tabId?: string) => Promise<boolean>;
  setZoom: (zoom: number, tabId?: string) => Promise<boolean>;
  toggleMute: (tabId?: string) => Promise<boolean>;
  captureFullPage: () => Promise<string>;
  captureViewport: () => Promise<string>;
  openExternal: (url?: string) => Promise<boolean>;
  openInVSCode: () => Promise<{ ok: boolean; error?: string; workspacePath?: string }>;
  getBookmarks: () => Promise<any>;
  findInPage: (text: string, forward?: boolean, findNext?: boolean) => Promise<void>;
  stopFindInPage: () => Promise<void>;
  showMenu: () => Promise<void>;
  setOverlay: (active: boolean, customHeight?: number) => Promise<void>;
  getWorkflowState: () => Promise<{ tools: any[]; workflows: any[] }>;
  runWorkflow: (payload: { workflowId?: string; workflowDef?: any }) => Promise<any>;
  invokeMcpTool: (payload: { name: string; params?: Record<string, unknown>; confirmRisk?: boolean }) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
  abortWorkflow: () => Promise<boolean>;
  saveWorkflow: (item: { id?: string; name: string; description?: string; steps: unknown[] }) => Promise<unknown>;
  deleteWorkflow: (id: string) => Promise<boolean>;
  getWorkflowArtifact: (artifactId: string) => Promise<any>;
  onWorkflowEvent: (callback: (event: any) => void) => () => void;
  getCoreHealthState?: (opts?: { refresh?: boolean }) => Promise<any>;
  getMcpDispatchState?: () => Promise<any>;
  getCoreTaskRunTrace?: (id: string) => Promise<any>;
  clearStorage: () => Promise<{ success: boolean; cleared: boolean; reason?: string; origin?: string }>;
  getChromeProfiles: () => Promise<any>;
  syncChromeProfile: (profileId: string) => Promise<any>;
  toggleBookmarkBar: () => Promise<boolean>;
  showMenuBar?: () => Promise<void>;
  addBookmark: (title: string, url: string) => Promise<any>;
  removeBookmark: (url: string) => Promise<any>;
  exportSessionVault?: (customPath?: string) => Promise<{ success: boolean; count: number; filePath: string; error?: string }>;
  importSessionVault?: (customPath?: string) => Promise<{ success: boolean; importedCount: number; failedCount: number; error?: string }>;
  importSessionVaultJson?: (json: string) => Promise<{ success: boolean; importedCount: number; failedCount: number; error?: string }>;
  getVaultStats?: (customPath?: string) => Promise<{ exists: boolean; count: number; lastModified?: number; filePath: string }>;
  checkUpdates?: () => Promise<void>;
  isChromeRunning?: () => Promise<boolean>;
  popoutTerminal?: () => Promise<boolean>;
  getSuggestions: (query: string) => Promise<{ suggestions: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> }>;
  toggleSplitReview: (tabId?: string, enabled?: boolean) => Promise<boolean>;
  setSplitPreset: (paneId: 'desktop' | 'mobile', presetId: string, tabId?: string) => Promise<boolean>;
  setSplitFocusedPane: (paneId: 'desktop' | 'mobile', tabId?: string) => Promise<boolean>;
  onStateUpdated: (callback: (state: any) => void) => () => void;
  onElementPicked: (callback: (element: any) => void) => () => void;
  onFocusFind: (callback: () => void) => () => void;
  onFocusOmnibox: (callback: () => void) => () => void;
  onShowShortcuts: (callback: () => void) => () => void;
  onFindResult: (callback: (result: any) => void) => () => void;
  onScreenshotCaptured?: (callback: () => void) => () => void;
  runThemeQa: (options?: { workspaceRoot?: string }) => Promise<{ ok: boolean; report?: any; error?: string }>;
  /** Workspace the active storefront belongs to; read-only, no side effects. */
  identifyWorkspace?: () => Promise<{ workspacePath?: string }>;
  /** Push frame carries the tab the scan ran on: foreign-tab scans must not repaint the badge. */
  onThemeQaState: (callback: (frame: { tabId?: string; state: ThemeQaState }) => void) => () => void;
  /** Read one checklist scope out of the main-owned store (`{workspaceRoot}/.antifan/qa-checklist.json`). */
  getThemeChecklist?: (scope: string, workspaceRoot: string) => Promise<ThemeChecklistLoadResult>;
  /** Whole-array CAS write; a conflict returns the store's items for adoption. */
  saveThemeChecklist?: (scope: string, workspaceRoot: string, items: ThemeChecklistItem[], baseUpdatedAt?: number) => Promise<ThemeChecklistSaveResult>;
  /** Push every mutation (toolbar or agent) triggers so each surface repaints the same scope. */
  onThemeChecklistUpdated?: (callback: (payload: ThemeChecklistUpdatedPayload) => void) => () => void;
  getPhoneStatus?: (forceRefresh?: boolean) => Promise<ToolbarPhoneStatus>;
  onPhoneStatusChanged?: (callback: (status: ToolbarPhoneStatus) => void) => () => void;
  /**
   * Cross-project tab inventory. Listing is side-effect free: it must never focus,
   * select or attach anything. Optional so an older preload cannot break this renderer —
   * a missing bridge is reported as an error state, never worked around.
   */
  searchProjectTabs?: (query: string) => Promise<ProjectTabSearchResult>;
  /** The only path that may present another window, for one explicit user action. */
  activateProjectTab?: (tabId: string) => Promise<ProjectTabActivationResult>;
  /**
   * The one explicit user intention to open a project. With no id Main presents its own
   * picker. Optional so a renderer hot-swapped ahead of its preload cannot fail at init.
   */
  openProject?: (projectId?: string, options?: { pickFolder?: boolean }) => Promise<ProjectOpenResult>;
  /** The picker this chrome hosts: Main pushes a requestId, this lists candidates and answers. */
  listProjects?: () => Promise<unknown>;
  onProjectOpenPicker?: (callback: (payload: { requestId?: unknown }) => void) => unknown;
  answerProjectOpenPicker?: (payload: {
    requestId: string;
    choice: { kind: 'project'; projectId: string } | { kind: 'folder' } | { kind: 'cancelled' };
  }) => Promise<unknown>;
  /** Detach the presented project into its own shell, or bring a detached shell home. */
  detachProject?: (request: { projectId: string }) => Promise<ProjectDetachResult>;
  reattachProject?: (request: { projectId: string }) => Promise<ProjectReattachResult>;
  /**
   * Reasons Main refused a close or quit, pushed for display only. The payload arrives
   * unvalidated like every other cross-process message, so it is typed `unknown` here and
   * read structurally at render time (see the refusal-notice section). Optional so a
   * renderer hot-swapped ahead of its preload cannot fail at init through a missing member.
   */
  onCloseRefused?: (callback: (notice: unknown) => void) => () => void;
  /** User-confirmed, sender-scoped force close of this chrome's own window. */
  forceCloseWindow?: () => Promise<unknown>;
}

declare global {
  interface Window {
    antifanToolbar?: AntiFanToolbarApi;
  }
}

function getApi(): AntiFanToolbarApi | undefined {
  return window.antifanToolbar;
}

/**
 * Overlay ownership: the toolbar WebContentsView is clipped to the strip height
 * unless the main process expands it via setOverlay. A single global boolean
 * meant any popup closing re-clipped every other open popup (last-closer-wins).
 * Tokens fix that: each popup acquires a token on open and releases it on
 * close; the view collapses only when the last token is released. Tokens carry
 * an optional customHeight — the active overlay height is the max requested.
 */
const overlayTokens = new Map<string, number | undefined>();
let overlaySyncQueued = false;

function acquireOverlay(token: string, customHeight?: number): void {
  overlayTokens.set(token, customHeight);
  syncOverlayState();
}

function releaseOverlay(token: string): void {
  if (!overlayTokens.delete(token)) return;
  syncOverlayState();
}

function syncOverlayState(): void {
  if (overlaySyncQueued) return;
  overlaySyncQueued = true;
  queueMicrotask(() => {
    overlaySyncQueued = false;
    if (overlayTokens.size === 0) {
      getApi()?.setOverlay(false);
      return;
    }
    let height: number | undefined;
    for (const h of overlayTokens.values()) {
      if (h === undefined) {
        height = undefined;
        break;
      }
      height = Math.max(height ?? 0, h);
    }
    getApi()?.setOverlay(true, height);
  });
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function showToolbarToast(message: string, duration = 2500) {
  const toast = document.getElementById('toolbarToast');
  if (!toast) return;
  toast.innerHTML = message;
  toast.style.display = 'flex';
  // Toast renders below the strip (top:76px) — it needs the view expanded or it
  // paints over toolbar buttons inside the 74px clip.
  acquireOverlay('toast', 40);
  if (toastTimer !== null) { clearTimeout(toastTimer); toastTimer = null; }
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
    releaseOverlay('toast');
    toastTimer = null;
  }, duration);
}

/**
 * Electron renderer has no window.prompt — this modal replaces it.
 * Resolves null on cancel/backdrop/Escape, string on OK/Enter.
 */
function showPromptDialog(title: string, initial = '', options?: { multiline?: boolean }): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const overlay = document.getElementById('promptOverlay') as HTMLElement | null;
  const modal = document.getElementById('promptModal') as HTMLElement | null;
  const titleEl = document.getElementById('promptTitle');
  const input = document.getElementById('promptInput') as HTMLInputElement | null;
  const multiline = document.getElementById('promptMultiline') as HTMLTextAreaElement | null;
  const btnOk = document.getElementById('promptOk');
  const btnCancel = document.getElementById('promptCancel');
  const useMultiline = Boolean(options?.multiline && multiline);
  const field: HTMLInputElement | HTMLTextAreaElement | null = useMultiline ? multiline : input;
  if (!overlay || !field || !btnOk || !btnCancel) {
    resolve(null);
    return promise;
  }
  if (titleEl) titleEl.textContent = title;
  if (input) input.style.display = useMultiline ? 'none' : '';
  if (multiline) multiline.style.display = useMultiline ? '' : 'none';
  modal?.classList.toggle('prompt-modal-wide', useMultiline);
  field.value = initial;
  overlay.style.display = 'flex';
  acquireOverlay('prompt');
  const done = (value: string | null) => {
    overlay.style.display = 'none';
    releaseOverlay('prompt');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
    btnOk.onclick = null;
    btnCancel.onclick = null;
    if (input) input.style.display = '';
    if (multiline) multiline.style.display = 'none';
    modal?.classList.remove('prompt-modal-wide');
    resolve(value);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !useMultiline) { e.preventDefault(); done(field.value); }
    else if (e.key === 'Enter' && useMultiline && (e.ctrlKey || e.metaKey)) { e.preventDefault(); done(field.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
  };
  const onBackdrop = (e: MouseEvent) => { if (e.target === overlay) done(null); };
  btnOk.onclick = () => done(field.value);
  btnCancel.onclick = () => done(null);
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
  field.focus();
  if ('select' in field) field.select();
  return promise;
}

function showConfirmDialog(title: string): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const overlay = document.getElementById('promptOverlay') as HTMLElement | null;
  const titleEl = document.getElementById('promptTitle');
  const input = document.getElementById('promptInput') as HTMLInputElement | null;
  const multiline = document.getElementById('promptMultiline') as HTMLTextAreaElement | null;
  const btnOk = document.getElementById('promptOk');
  const btnCancel = document.getElementById('promptCancel');
  if (!overlay || !btnOk || !btnCancel) {
    resolve(false);
    return promise;
  }
  if (titleEl) titleEl.textContent = title;
  if (input) input.style.display = 'none';
  if (multiline) multiline.style.display = 'none';
  overlay.style.display = 'flex';
  acquireOverlay('prompt');
  const done = (value: boolean) => {
    overlay.style.display = 'none';
    releaseOverlay('prompt');
    document.removeEventListener('keydown', onKey, true);
    overlay.removeEventListener('click', onBackdrop);
    btnOk.onclick = null;
    btnCancel.onclick = null;
    if (input) input.style.display = '';
    resolve(value);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); done(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
  };
  const onBackdrop = (e: MouseEvent) => { if (e.target === overlay) done(false); };
  btnOk.onclick = () => done(true);
  btnCancel.onclick = () => done(false);
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', onBackdrop);
  btnOk.focus();
  return promise;
}
function renderThemeQa(state: ThemeQaState, report?: Record<string, unknown>) {
  themeQaState = state;
  if (report) {
    lastThemeQaReport = report;
  } else if (state.report) {
    lastThemeQaReport = state.report;
  }
  if (!btnThemeQa || !themeQaText) return;
  btnThemeQa.classList.remove('status-pass', 'status-fail');
  if (state.status === 'running') {
    themeQaText.textContent = 'Checking…';
    btnThemeQa.disabled = true;
  } else if (state.status === 'pass') {
    themeQaText.textContent = 'QA Clean';
    btnThemeQa.classList.add('status-pass');
    btnThemeQa.disabled = false;
  } else if (state.status === 'fail') {
    themeQaText.textContent = `${state.issueCount} Issues`;
    btnThemeQa.classList.add('status-fail');
    btnThemeQa.disabled = false;
  } else if (state.status === 'error') {
    themeQaText.textContent = 'QA Error';
    btnThemeQa.classList.add('status-fail');
    btnThemeQa.disabled = false;
  } else {
    themeQaText.textContent = 'QA';
    btnThemeQa.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Theme Studio checklist state.
//
// Persistence moved out of localStorage into the main-owned store at
// `{workspaceRoot}/.antifan/qa-checklist.json`, reached through the
// THEME_CHECKLIST_LOAD / THEME_CHECKLIST_SAVE invoke channels. `workspaceRoot`
// rides every frame next to `scope` because the tag inside the scope is a
// one-way hash — nothing downstream may re-derive the root from it. Scopes
// whose workspace could not be resolved are provisional (in-memory on the
// main side); the two `antifan_theme_checklist_*` localStorage keys below are
// read ONLY by the migration path and deleted once the store accepted them.
// ---------------------------------------------------------------------------

/** Legacy done-flag map key — migration probe/removal only. */
const THEME_CHECKLIST_STORAGE_PREFIX = 'antifan_theme_checklist_state_v3';
/** Legacy custom-item array key — migration probe/removal only. */
const THEME_CHECKLIST_DATA_PREFIX = 'antifan_theme_checklist_custom_items';
/** Both legacy keys share this prefix; the boot sweep enumerates on it. */
const THEME_CHECKLIST_LEGACY_PREFIX = 'antifan_theme_checklist_';

let themeChecklist: ThemeChecklistItem[] = [];
let activePhaseFilter: string = 'all';
let checklistSearchQuery: string = '';
let activeThemeStudioTab: 'checklist' | 'findings' = 'checklist';
let activeChecklistScope: string = 'unbound';
/** Store `updatedAt` of the items currently on screen; CAS base for the next save. */
let checklistUpdatedAt = 0;
/** Scope the in-memory `themeChecklist` was last fully populated for (even when empty). */
let checklistLoadedForScope = '';
/** In-flight LOAD keyed by scope; only one read may be outstanding per scope. */
const checklistLoadPending = new Set<string>();
/**
 * Generation guard (F9): every `applyChecklistScope` that changes the scope —
 * or restarts a load — increments this; each async continuation captures it
 * plus the requested scope and bails when either drifted, so a stale LOAD can
 * never poison a scope the user already left.
 */
let checklistScopeGen = 0;
/** Workspace tag for the storefront in front of the user; empty until it is known. */
let checklistWorkspaceTag = '';
/** Workspace path `checklistWorkspaceTag` was derived from — sent verbatim on every LOAD/SAVE. */
let checklistWorkspaceRoot = '';
/** Origin the current tag+root pair was resolved for, so a tab switch re-resolves it. */
let checklistWorkspaceResolvedFor = '';
/**
 * In-flight workspace identity reads keyed by origin (F11): two storefronts on
 * different origins must never share one pending promise — the second would
 * inherit whichever answer landed first.
 */
const checklistWorkspacePending = new Map<string, Promise<void>>();
/** `workspaceTag` the legacy localStorage sweep already ran for. */
let checklistLegacySweepDoneFor = '';
/** True once the IPC bridge was found missing or failed; legacy ops stay the degraded fallback. */
let checklistIpcUnavailable = false;

/**
 * The storefront whose checklist is on screen. Progress is keyed by origin and by
 * the workspace that origin belongs to, so a second shop — or a second theme
 * project served on the same local port — never inherits the first one's ticks.
 */
function checklistOrigin(): string {
  const ordered = [currentTabs.find((tab) => tab.id === activeTabId), ...currentTabs];
  for (const tab of ordered) {
    if (!tab?.url) continue;
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch {
      // not a navigable origin — keep looking
    }
  }
  return 'unbound';
}

/** Scope for the storefront on screen inside its resolved workspace. */
function currentChecklistScope(): string {
  return themeShared().checklistScope(checklistOrigin(), checklistWorkspaceTag);
}

/** True while a mutation must be refused: identity or items are still in flight. */
function checklistBusy(): boolean {
  return checklistWorkspacePending.has(checklistOrigin()) || checklistLoadPending.size > 0;
}

/**
 * Learn which workspace the open storefront belongs to, once per origin. Every
 * theme project locally is served from a fixed port (`127.0.0.1:9292`), so two
 * projects on that port resolve to one origin and would otherwise share progress.
 * The pending map is keyed by origin (F11) and the post-await adoption re-checks
 * that the resolved origin is still the one on screen before committing the tag —
 * a late answer for a storefront the user already left must not be adopted.
 */
function resolveChecklistWorkspace(origin: string, force = false): Promise<void> {
  if (!force && origin === checklistWorkspaceResolvedFor) return Promise.resolve();
  const inFlight = checklistWorkspacePending.get(origin);
  if (inFlight) return inFlight;
  const identify = getApi()?.identifyWorkspace;
  if (!identify) {
    if (origin === checklistOrigin()) {
      checklistWorkspaceTag = '';
      checklistWorkspaceRoot = '';
      checklistWorkspaceResolvedFor = origin;
      sweepLegacyChecklistScopes();
    }
    return Promise.resolve();
  }
  const pending = (async () => {
    let workspacePath = '';
    try {
      // Bounded: a main process that never answers must not leave the panel
      // pending forever. Falling back to the unknown-workspace scope keeps the
      // checklist usable and honest about what it measured.
      const res = await Promise.race([
        identify(),
        new Promise<null>((resolve) => {
          setTimeout(() => resolve(null), themeShared().WORKSPACE_IDENTIFY_TIMEOUT_MS);
        }),
      ]);
      workspacePath = typeof res?.workspacePath === 'string' ? res.workspacePath : '';
    } catch (err) {
      console.warn('[ThemeStudio] Workspace identity unavailable; scoping the checklist to the unknown-workspace scope:', err);
      workspacePath = '';
    }
    // The user may have moved to another storefront while the identify call was
    // in flight: a tag+root resolved for origin A must not be filed under origin
    // B. When this answer no longer matches the origin on screen, drop it — the
    if (origin !== checklistOrigin()) return;
    checklistWorkspaceTag = themeShared().workspaceTag(workspacePath);
    checklistWorkspaceRoot = workspacePath;
    checklistWorkspaceResolvedFor = origin;
    sweepLegacyChecklistScopes();
  })();
  checklistWorkspacePending.set(origin, pending);
  void pending.finally(() => {
    if (checklistWorkspacePending.get(origin) === pending) {
      checklistWorkspacePending.delete(origin);
    }
  });
  return pending;
}

// ---------------------------------------------------------------------------
// Legacy localStorage state (probe + one-shot migration only — F10)
// ---------------------------------------------------------------------------

function checklistStorageKey(scope: string): string {
  return `${THEME_CHECKLIST_STORAGE_PREFIX}:${scope}`;
}

function checklistDataStorageKey(scope: string): string {
  return `${THEME_CHECKLIST_DATA_PREFIX}:${scope}`;
}

/**
 * Read one scope's legacy rows. Mirrors the pre-cutover loader exactly: the
 * custom-items array is the row source and the state map overrides `done`.
 * `null` means nothing stored; a corrupt blob counts as "nothing".
 */
function readLegacyChecklistItems(scope: string): ThemeChecklistItem[] | null {
  const rawData = localStorage.getItem(checklistDataStorageKey(scope));
  const rawDone = localStorage.getItem(checklistStorageKey(scope));
  if (rawData === null && rawDone === null) return null;
  try {
    const savedDone = rawDone ? (JSON.parse(rawDone) as Record<string, boolean>) : {};
    const baseItems = rawData
      ? sanitizeChecklistItems(JSON.parse(rawData) as unknown)
      : themeShared().DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
    return baseItems.map((item) => ({ ...item, done: Boolean(savedDone[item.id]) }));
  } catch {
    return null;
  }
}

function removeLegacyChecklistKeys(scope: string): void {
  try {
    localStorage.removeItem(checklistStorageKey(scope));
    localStorage.removeItem(checklistDataStorageKey(scope));
  } catch {
    // storage can be disabled entirely — the store is authoritative anyway
  }
}

/** Items arriving over the bridge are untrusted rows: coerce fields, drop junk. */
function sanitizeChecklistItems(raw: unknown): ThemeChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const items: ThemeChecklistItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const src = entry as Record<string, unknown>;
    if (typeof src.id !== 'string' || !src.id || seen.has(src.id)) continue;
    seen.add(src.id);
    const item: ThemeChecklistItem = {
      id: src.id,
      code: typeof src.code === 'string' ? src.code : '',
      name: typeof src.name === 'string' ? src.name : '',
      desc: typeof src.desc === 'string' ? src.desc : '',
      qaPoint: typeof src.qaPoint === 'string' ? src.qaPoint : '',
      page: typeof src.page === 'string' && src.page ? src.page : 'pages',
      done: src.done === true,
    };
    if (typeof src.pathHint === 'string' && src.pathHint) item.pathHint = src.pathHint;
    if (typeof src.note === 'string' && src.note) item.note = src.note;
    items.push(item);
  }
  return items;
}

/**
 * Union merge for the one-shot migration (F10): file rows win id collisions
 * (agent rows are never clobbered), legacy-only rows are appended.
 */
function mergeChecklistItems(fileItems: ThemeChecklistItem[], legacyItems: ThemeChecklistItem[]): ThemeChecklistItem[] {
  if (fileItems.length === 0) return legacyItems;
  const seen = new Set(fileItems.map((item) => item.id));
  const merged = fileItems.slice();
  for (const item of legacyItems) {
    if (!seen.has(item.id)) merged.push(item);
  }
  return merged;
}

/**
 * Fold one scope's legacy localStorage rows into the store, once. The LOAD
 * answer's `migrated`/`legacyMigrated` flag decides — never "looks default":
 * when the flag is clear and legacy rows exist, union them in, SAVE the merged
 * array once, and only then drop the local keys. Provisional (unknown
 * workspace) scopes save into the host's in-memory map and lose their rows on
 * restart by design.
 */
async function migrateChecklistScopeFromLegacy(
  scope: string,
  workspaceRoot: string,
  loaded: { items: ThemeChecklistItem[]; updatedAt: number; migrated: boolean; existed: boolean },
): Promise<{ items: ThemeChecklistItem[]; updatedAt: number }> {
  if (loaded.migrated) {
    // Keys are dropped only after a persisted union below — but a provisional
    // scope's merged rows live in the host's volatile in-memory map, so the
    // durable localStorage copy is the only durable record and stays (F14/H).
    if (workspaceRoot) removeLegacyChecklistKeys(scope);
    return { items: loaded.items, updatedAt: loaded.updatedAt };
  }
  // The legacy done-map applies by id to whatever rows exist — file rows and
  // legacy-only rows alike (pre-cutover loader semantics). Reading it directly
  // also covers the rawDone-only case: flags with no custom-items array.
  let savedDone: Record<string, boolean> = {};
  try {
    const rawDone = localStorage.getItem(checklistStorageKey(scope));
    if (rawDone) savedDone = JSON.parse(rawDone) as Record<string, boolean>;
  } catch {
    savedDone = {};
  }
  const legacyItems = readLegacyChecklistItems(scope) ?? [];
  if (!legacyItems.length && Object.keys(savedDone).length === 0) {
    return { items: loaded.items, updatedAt: loaded.updatedAt };
  }
  // File wins id collisions (F10): when the store record already exists — an
  // agent wrote it — its `done` flags are authoritative and legacy savedDone
  // only applies to rows the file never carried. When no record exists the
  // file rows are seeded defaults and legacy done is the real user state.
  const withDone = loaded.existed
    ? loaded.items
    : loaded.items.map((item) => ({
        ...item,
        done: Object.prototype.hasOwnProperty.call(savedDone, item.id) ? Boolean(savedDone[item.id]) : item.done,
      }));
  const merged = mergeChecklistItems(withDone, legacyItems);
  try {
    const res = await getApi()?.saveThemeChecklist?.(scope, workspaceRoot, merged, loaded.updatedAt);
    if (res && typeof res === 'object' && res.conflict === true) {
      // An agent wrote between LOAD and SAVE: fold the conflict winner's rows
      // into the same union (winner ids win, legacy-only appended) and retry
      // once against the conflict's updatedAt — the union must land before
      // the legacy keys die (F10). A second conflict keeps the keys and
      // adopts the winner's rows; the next load re-runs this merge.
      const winner = sanitizeChecklistItems(res.items);
      const union = mergeChecklistItems(winner, legacyItems);
      let res2: ThemeChecklistSaveResult | undefined;
      try {
        res2 = await getApi()?.saveThemeChecklist?.(scope, workspaceRoot, union, res.updatedAt);
      } catch {
        res2 = undefined;
      }
      if (res2 && typeof res2 === 'object' && res2.conflict !== true && Array.isArray(res2.items)) {
        if (workspaceRoot) removeLegacyChecklistKeys(scope);
        return { items: sanitizeChecklistItems(res2.items), updatedAt: typeof res2.updatedAt === 'number' ? res2.updatedAt : Date.now() };
      }
      return { items: winner, updatedAt: res.updatedAt };
    }
    if (res && typeof res === 'object' && Array.isArray(res.items)) {
      if (workspaceRoot) removeLegacyChecklistKeys(scope);
      return { items: sanitizeChecklistItems(res.items), updatedAt: typeof res.updatedAt === 'number' ? res.updatedAt : Date.now() };
    }
    // Malformed/undefined response: keep the legacy keys — merged renders now
    // and the next load retries the fold instead of losing the durable copy.
    return { items: merged, updatedAt: loaded.updatedAt };
  } catch (err) {
    console.warn('[ThemeStudio] Legacy checklist migration failed; keeping the local keys:', err);
    return { items: loaded.items, updatedAt: loaded.updatedAt };
  }
}

/**
 * Boot sweep (F10): at hydration, every `antifan_theme_checklist_*` scope that
 * belongs to THIS workspace — same tag, or an `unknown-workspace` scope whose
 * provisional rows belong wherever the toolbar opened it — migrates even if
 * its storefront tab was never opened this session. Scopes stamped with a
 * foreign workspace tag stay untouched: they will migrate the first time the
 * toolbar runs inside that workspace.
 */
function sweepLegacyChecklistScopes(): void {
  const api = getApi();
  if (!api?.getThemeChecklist || checklistIpcUnavailable) return;
  const sweepKey = `${checklistWorkspaceTag || themeShared().UNKNOWN_WORKSPACE_TAG}|${checklistWorkspaceRoot}`;
  if (checklistLegacySweepDoneFor === sweepKey) return;
  checklistLegacySweepDoneFor = sweepKey;
  const scopes = new Set<string>();
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(THEME_CHECKLIST_LEGACY_PREFIX)) continue;
      const scope = key.slice(key.indexOf(':') + 1);
      if (scope) scopes.add(scope);
    }
  } catch {
    return;
  }
  const ownTag = checklistWorkspaceTag;
  const unknownTag = themeShared().UNKNOWN_WORKSPACE_TAG;
  for (const scope of scopes) {
    if (scope === activeChecklistScope || scope === currentChecklistScope()) continue; // the live LOAD path migrates it
    const tag = scope.slice(scope.lastIndexOf('@') + 1);
    const rootFor = tag === ownTag ? checklistWorkspaceRoot : tag === unknownTag ? '' : null;
    if (rootFor === null) continue;
    void (async () => {
      try {
        const res = await api.getThemeChecklist!(scope, rootFor);
        if (!res || typeof res !== 'object') return;
        await migrateChecklistScopeFromLegacy(scope, rootFor, {
          items: sanitizeChecklistItems(res.items),
          updatedAt: typeof res.updatedAt === 'number' ? res.updatedAt : 0,
          migrated: res.migrated === true || res.legacyMigrated === true,
          existed: res.existed === true,
        });
      } catch (err) {
        console.warn('[ThemeStudio] Legacy sweep could not migrate scope:', scope, err);
      }
    })();
  }
}

/** Degraded-boot loader: identical semantics to the pre-cutover localStorage read. */
function loadThemeChecklistLegacy(scope: string): ThemeChecklistItem[] {
  const legacy = readLegacyChecklistItems(scope);
  if (legacy) return legacy;
  return themeShared().DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
}

/**
 * Degraded-boot writer: when the bridge is gone, keep the old two-key local
 * shape so the panel stays usable and the next session still migrates it.
 */
function saveThemeChecklistLegacy(items: ThemeChecklistItem[], scope: string): void {
  try {
    const record: Record<string, boolean> = {};
    for (const item of items) {
      if (item.done) record[item.id] = true;
    }
    localStorage.setItem(checklistStorageKey(scope), JSON.stringify(record));
    localStorage.setItem(checklistDataStorageKey(scope), JSON.stringify(items));
  } catch (err) {
    console.warn('[ThemeStudio] Failed to save checklist state:', err);
  }
}

/**
 * Load `scope` into `themeChecklist` through the store, fenced by the scope
 * generation. Callers capture `gen`/`requestedScope` themselves: this helper
 * bails silently when the user already moved on, and the caller's `.finally`
 * decides whether a repaint is still owed.
 */
async function loadChecklistScope(scope: string, workspaceRoot: string, gen: number): Promise<void> {
  checklistLoadPending.add(scope);
  try {
    const api = getApi();
    if (!api?.getThemeChecklist || checklistIpcUnavailable) {
      if (!checklistIpcUnavailable && !api?.getThemeChecklist) {
        checklistIpcUnavailable = true;
        console.warn('[ThemeStudio] Checklist IPC bridge unavailable; falling back to localStorage state.');
      }
      if (gen !== checklistScopeGen || scope !== activeChecklistScope) return;
      themeChecklist = loadThemeChecklistLegacy(scope);
      checklistLoadedForScope = scope;
      return;
    }
    let res: ThemeChecklistLoadResult;
    try {
      res = await api.getThemeChecklist(scope, workspaceRoot);
    } catch (err) {
      // Transient failure: degrade THIS load to localStorage without latching
      // `checklistIpcUnavailable` — a sticky latch here made one dropped IPC
      // split-brain the whole session (localStorage writes vs agent file
      // writes) and let the next boot's migration erase the degraded ticks.
      console.warn('[ThemeStudio] Checklist load failed; falling back to localStorage state:', err);
      if (gen !== checklistScopeGen || scope !== activeChecklistScope) return;
      themeChecklist = loadThemeChecklistLegacy(scope);
      checklistLoadedForScope = scope;
      return;
    }
    if (gen !== checklistScopeGen || scope !== activeChecklistScope) return;
    const items = sanitizeChecklistItems(res?.items);
    const updatedAt = res && typeof res.updatedAt === 'number' ? res.updatedAt : 0;
    const migrated = res?.migrated === true || res?.legacyMigrated === true;
    const resolved = await migrateChecklistScopeFromLegacy(scope, workspaceRoot, {
      items,
      updatedAt,
      migrated,
      existed: res?.existed === true,
    });
    if (gen !== checklistScopeGen || scope !== activeChecklistScope) return;
    // A THEME_CHECKLIST_UPDATED push that landed mid-LOAD already carries a
    // newer snapshot — adopting the stale load response would re-display rows
    // an agent has since changed AND roll the CAS base backward so the next
    // save self-conflicts (RTT lost-update). Only adopt same-or-newer data.
    if (resolved.updatedAt < checklistUpdatedAt) return;
    themeChecklist = resolved.items;
    checklistUpdatedAt = resolved.updatedAt;
    checklistLoadedForScope = scope;
  } finally {
    checklistLoadPending.delete(scope);
    if (gen === checklistScopeGen && scope === activeChecklistScope) {
      renderThemeStudioChecklist();
    }
  }
}

/**
 * Serialize whole-array saves per scope. Each chained save reads the CAS base
 * (`checklistUpdatedAt`) at execution time — not at enqueue — so the second of
 * two rapid mutations CASes against the first save's `updatedAt` instead of
 * self-conflicting and silently discarding the second mutation (F6).
 */
let checklistSaveChain: Promise<void> = Promise.resolve();

function persistThemeChecklist(): void {
  const scope = activeChecklistScope;
  const workspaceRoot = checklistWorkspaceRoot;
  const gen = checklistScopeGen;
  const items = themeChecklist.map((item) => ({ ...item }));
  const save = getApi()?.saveThemeChecklist;
  if (!save || checklistIpcUnavailable) {
    if (!checklistIpcUnavailable) {
      checklistIpcUnavailable = true;
      console.warn('[ThemeStudio] Checklist IPC bridge unavailable; saving to localStorage.');
    }
    saveThemeChecklistLegacy(items, scope);
    return;
  }
  checklistSaveChain = checklistSaveChain.then(async () => {
    let res: ThemeChecklistSaveResult;
    try {
      res = await save(scope, workspaceRoot, items, checklistUpdatedAt);
    } catch (err) {
      // Same rule as the load path: a thrown save degrades this call to the
      // legacy mirror but never wedges the bridge — the next mutation retries
      // IPC and the file stays authoritative for agent writes.
      console.warn('[ThemeStudio] Checklist save failed; falling back to localStorage:', err);
      saveThemeChecklistLegacy(items, scope);
      return;
    }
    // The write targeted `scope` and landed (or conflicted). Whatever the
    // answer, only adopt it while that scope is still on screen — after a
    // switch this save's rows belong to the old scope's record.
    if (gen !== checklistScopeGen || scope !== activeChecklistScope) return;
    if (res && typeof res === 'object' && res.conflict === true) {
      // CAS lost to an interleaved writer (an agent mutation): adopt the
      // store's rows instead of blindly overwriting them (F6).
      themeChecklist = sanitizeChecklistItems(res.items);
      checklistUpdatedAt = typeof res.updatedAt === 'number' ? res.updatedAt : checklistUpdatedAt;
      checklistLoadedForScope = scope;
      renderThemeStudioChecklist();
      showToolbarToast('Checklist vừa được agent cập nhật');
      return;
    }
    if (res && typeof res === 'object' && typeof res.updatedAt === 'number' && res.updatedAt >= checklistUpdatedAt) {
      checklistUpdatedAt = res.updatedAt;
    }
  });
  // Keep the chain alive across rejections so a failed save never wedges the queue.
  checklistSaveChain = checklistSaveChain.catch(() => undefined);
}

/**
 * Move `themeChecklist` onto the active scope. No implicit pre-switch save
 * (F12): every mutation already persisted through the serialized save chain,
 * so re-persisting the stale in-memory array under a new scope would only risk
 * a cross-scope write. Returns false when nothing changed and no load is owed.
 */
function applyChecklistScope(): Promise<boolean> | boolean {
  const next = currentChecklistScope();
  const loadInFlight = checklistLoadPending.has(next);
  if (next === activeChecklistScope && (checklistLoadedForScope === next || loadInFlight)) {
    return false;
  }
  const gen = ++checklistScopeGen;
  const requestedScope = next;
  activeChecklistScope = next;
  themeChecklist = [];
  checklistUpdatedAt = 0;
  checklistLoadedForScope = '';
  const root = checklistWorkspaceRoot;
  return (async () => {
    try {
      await loadChecklistScope(requestedScope, root, gen);
    } catch (err) {
      console.warn('[ThemeStudio] Checklist load threw unexpectedly:', err);
    }
    return gen === checklistScopeGen && requestedScope === activeChecklistScope;
  })();
}

/**
 * Bind the checklist to the active storefront. Returns false while the storefront's
 * workspace or the scope's items are still in flight: committing a scope in that
 * window would file one project's ticks under a key another project may resolve
 * to. `force` re-reads the workspace, since switching projects does not change
 * the storefront origin when both are served from the same local port.
 */
function ensureChecklistScope(force = false): boolean {
  const origin = checklistOrigin();
  if (force || origin !== checklistWorkspaceResolvedFor) {
    const tagAlreadyKnown = origin === checklistWorkspaceResolvedFor;
    void resolveChecklistWorkspace(origin, force).then(() => {
      const scopeChanged = applyChecklistScope();
      // A forced re-read renders a frozen panel until it lands, so it must repaint
      // even when the workspace (and therefore the scope) turns out unchanged.
      if (force || scopeChanged instanceof Promise) {
        void Promise.resolve(scopeChanged).then(() => renderThemeStudioChecklist());
      } else if (scopeChanged) {
        renderThemeStudioChecklist();
      }
    });
    if (!tagAlreadyKnown) return false;
  }
  void applyChecklistScope();
  return checklistLoadPending.size === 0;
}


/**
 * Origin every storefront route is resolved against: the tab in front of the user
 * first, then any other browsing tab, then the local storefront dev server.
 */
function storefrontOrigin(): string {
  const ordered = [currentTabs.find((tab) => tab.id === activeTabId), ...currentTabs];
  for (const tab of ordered) {
    if (!tab?.url) continue;
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.origin;
    } catch {
      // not a navigable origin — keep looking
    }
  }
  return 'http://127.0.0.1:9292';
}

/**
 * The absolute route a checklist action should open, or `null` when the page has
 * no index route and no matching storefront page is open. Callers must refuse
 * rather than navigate: opening a made-up route would scan a 404 while claiming a
 * product page.
 */
function resolveChecklistRoute(pageDef: ThemePageDef, itemPath?: string): string | null {
  if (pageDef.routeKind === 'handle-required') {
    const openUrl = currentTabs.find((tab) => tab.id === activeTabId)?.url;
    if (!openUrl) return null;
    try {
      return themeShared().PRODUCT_PAGE_PATH.test(new URL(openUrl).pathname) ? openUrl : null;
    } catch {
      return null;
    }
  }
  try {
    return new URL(itemPath || pageDef.path, storefrontOrigin()).href;
  } catch {
    return null;
  }
}

function navigatePreview(pathHint: string) {
  const resolvedOrigin = storefrontOrigin();
  let targetUrl = pathHint;
  const activeTab = currentTabs.find((t) => t.id === activeTabId);

  try {
    targetUrl = new URL(pathHint, resolvedOrigin).href;
  } catch {
    targetUrl = `${resolvedOrigin}${pathHint.startsWith('/') ? pathHint : '/' + pathHint}`;
  }

  // 1. Navigate active tab
  getApi()?.navigate(targetUrl, activeTabId);

  // 2. Update Omnibox input
  if (urlInput) {
    urlInput.value = targetUrl;
  }

  // 3. Automatically close modal so storefront is visible immediately!
  if (themeQaOverlay) {
    themeQaOverlay.style.display = 'none';
    releaseOverlay('theme-qa');
  }

  showToolbarToast(`Đang mở Storefront: ${targetUrl}`);
}

const collapsedPages = new Set<string>();

function renderThemeStudioChecklist(refreshWorkspace = false) {
  const container = document.getElementById('themeChecklistList');
  const progressVal = document.getElementById('themeChecklistProgressVal');
  const progressBar = document.getElementById('themeChecklistProgressBar') as HTMLElement | null;
  const badgeNav = document.getElementById('badgeThemeChecklist');
  if (!container) return;

  if (!ensureChecklistScope(refreshWorkspace)) {
    container.innerHTML = '';
    const pending = document.createElement('div');
    pending.className = 'theme-checklist-pending';
    pending.textContent = 'Đang xác định storefront và workspace để mở đúng checklist…';
    container.appendChild(pending);
    if (progressVal) progressVal.textContent = '--';
    if (progressBar) progressBar.style.width = '0%';
    if (badgeNav) badgeNav.textContent = '--';
    return;
  }

  // A forced re-read (opening the panel after switching projects) renders the
  // committed scope until the new one lands. Editing is held off for that one
  // round-trip so a tick cannot be filed under the project being left behind —
  // and the same while a LOAD is outstanding, so an optimistic write cannot
  // reach the store ahead of the truth it is about to receive.
  const verifyingWorkspace = checklistWorkspacePending.has(checklistOrigin()) || checklistLoadPending.size > 0;

  const total = themeChecklist.length;
  const doneCount = themeChecklist.filter((it) => it.done).length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  if (progressVal) progressVal.textContent = `${doneCount}/${total} (${percent}%)`;
  if (progressBar) progressBar.style.width = `${percent}%`;
  if (badgeNav) badgeNav.textContent = `${doneCount}/${total}`;

  // Group items by page (standard pages first, then any custom pages)
  const standardPages = ['home', 'collection', 'product', 'cart', 'blog', 'account', 'pages', 'qa-gate'];
  const customPages = Array.from(new Set(themeChecklist.map((it) => it.page).filter((p) => !standardPages.includes(p))));
  const pageKeys = [...standardPages, ...customPages];
  container.innerHTML = '';

  const q = checklistSearchQuery.trim().toLowerCase();

  pageKeys.forEach((pageKey) => {
    if (activePhaseFilter !== 'all' && activePhaseFilter !== 'uncompleted' && activePhaseFilter !== pageKey) return;

    const pageItems = themeChecklist.filter((it) => it.page === pageKey);
    let visibleItems = pageItems;
    if (activePhaseFilter === 'uncompleted') {
      visibleItems = visibleItems.filter((it) => !it.done);
    }
    if (visibleItems.length === 0 && activePhaseFilter === 'uncompleted') return;

    if (q) {
      visibleItems = visibleItems.filter(
        (it) =>
          it.name.toLowerCase().includes(q) ||
          it.code.toLowerCase().includes(q) ||
          it.desc.toLowerCase().includes(q) ||
          it.qaPoint.toLowerCase().includes(q)
      );
    }
    if (visibleItems.length === 0 && q) return;

    const pageDone = pageItems.filter((it) => it.done).length;
    const pageTotal = pageItems.length;
    const pageDef = themeShared().PAGE_DEFS[pageKey] || {
      title: `Trang ${pageKey.charAt(0).toUpperCase() + pageKey.slice(1)}`,
      badge: pageKey.toUpperCase(),
      icon: '📌',
      path: '/',
    };

    const isCollapsed = collapsedPages.has(pageKey);

    const card = document.createElement('div');
    card.className = 'theme-phase-card';

    const header = document.createElement('div');
    header.className = 'theme-phase-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'theme-phase-header-title';
    headerLeft.innerHTML = `
      <span class="theme-phase-chevron">${isCollapsed ? '▶' : '▼'}</span>
      <span class="theme-phase-badge">${escapeHtml(pageDef.icon)} ${escapeHtml(pageDef.badge)}</span>
      <span>${escapeHtml(pageDef.title)}</span>
    `;

    header.addEventListener('click', () => {
      if (collapsedPages.has(pageKey)) {
        collapsedPages.delete(pageKey);
      } else {
        collapsedPages.add(pageKey);
      }
      renderThemeStudioChecklist();
    });

    const headerRight = document.createElement('div');
    headerRight.style.display = 'flex';
    headerRight.style.alignItems = 'center';

    const btnOpenPage = document.createElement('button');
    btnOpenPage.className = 'theme-btn-open-page';
    btnOpenPage.title = `Mở đường dẫn storefront: ${pageDef.path}`;
    btnOpenPage.textContent = `↗ Mở trang`;
    btnOpenPage.addEventListener('click', (e) => {
      e.stopPropagation();
      const route = resolveChecklistRoute(pageDef);
      if (!route) {
        showToolbarToast(pageDef.routeNote ?? `Không mở được ${pageDef.title}: chưa có trang tương ứng đang mở.`);
        return;
      }
      navigatePreview(route);
    });

    const btnScanPage = document.createElement('button');
    btnScanPage.className = 'theme-btn-scan-page';
    btnScanPage.title = `Mở và quét QA storefront cho trang: ${pageDef.title}`;
    btnScanPage.textContent = `🔍 Quét QA`;
    btnScanPage.addEventListener('click', async (e) => {
      e.stopPropagation();
      const route = resolveChecklistRoute(pageDef);
      if (!route) {
        showToolbarToast(pageDef.routeNote ?? `Không quét được ${pageDef.title}: chưa có trang tương ứng đang mở.`);
        return;
      }
      // Already on the resolved route: the QA run reloads the page itself, so a
      // pre-navigation would only add a second full load.
      if (route !== currentTabs.find((tab) => tab.id === activeTabId)?.url) {
        navigatePreview(route);
        showToolbarToast(`Đang chuyển đến ${pageDef.title} và chuẩn bị chạy QA…`);
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 800);
        await promise;
      } else {
        showToolbarToast(`Đang quét QA trên ${pageDef.title}…`);
      }
      const res = await getApi()?.runThemeQa();
      if (res?.report) {
        lastThemeQaReport = res.report;
        renderThemeQa({ ...themeQaState, report: res.report }, res.report);
        tabNavThemeFindings?.classList.add('active');
        tabNavThemeChecklist?.classList.remove('active');
        if (themeTabFindings) themeTabFindings.style.display = 'flex';
        if (themeTabChecklist) themeTabChecklist.style.display = 'none';
        renderThemeStudioFindings();
        openThemeQaSummary();
      }
    });

    const btnAddCardItem = document.createElement('button');
    btnAddCardItem.className = 'theme-btn-card-add';
    btnAddCardItem.title = `Thêm mục kiểm tra mới vào ${pageDef.title}`;
    btnAddCardItem.textContent = `+ Thêm`;
    btnAddCardItem.disabled = verifyingWorkspace;
    btnAddCardItem.addEventListener('click', (e) => {
      e.stopPropagation();
      openItemEditorDialog(null, pageKey);
    });

    const allDone = pageItems.length > 0 && pageItems.every((it) => it.done);
    const btnToggleAll = document.createElement('button');
    btnToggleAll.className = 'theme-btn-toggle-all';
    btnToggleAll.textContent = allDone ? '↺ Bỏ xong' : '✓ Xong cả trang';
    btnToggleAll.title = allDone ? 'Đánh dấu chưa hoàn thành toàn bộ mục trang này' : 'Đánh dấu đã hoàn thành toàn bộ mục trang này';
    btnToggleAll.disabled = verifyingWorkspace;
    btnToggleAll.addEventListener('click', (e) => {
      e.stopPropagation();
      if (checklistBusy()) return;
      const newStatus = !allDone;
      pageItems.forEach((it) => {
        it.done = newStatus;
        const found = themeChecklist.find((m) => m.id === it.id);
        if (found) found.done = newStatus;
      });
      persistThemeChecklist();
      renderThemeStudioChecklist();
      showToolbarToast(`${newStatus ? 'Đã hoàn thành' : 'Đã bỏ hoàn thành'} toàn bộ ${pageDef.title}`);
    });

    const progressPill = document.createElement('div');
    progressPill.className = 'theme-phase-progress-pill';
    progressPill.textContent = `${pageDone}/${pageTotal} Xong`;

    headerRight.append(btnOpenPage, btnScanPage, btnAddCardItem, btnToggleAll, progressPill);
    header.append(headerLeft, headerRight);
    card.append(header);

    if (pageDef.note && !isCollapsed) {
      const note = document.createElement('div');
      note.className = 'theme-phase-note';
      note.textContent = pageDef.note;
      card.append(note);
    }

    const itemsBox = document.createElement('div');
    itemsBox.className = 'theme-phase-items';
    if (isCollapsed) {
      itemsBox.style.display = 'none';
    }

    if (visibleItems.length === 0) {
      const emptyRow = document.createElement('div');
      emptyRow.className = 'theme-checklist-empty-page';
      emptyRow.innerHTML = `<span>Chưa có mục nào trong trang này.</span>`;
      const btnAddEmpty = document.createElement('button');
      btnAddEmpty.className = 'theme-btn-card-add';
      btnAddEmpty.style.marginLeft = '8px';
      btnAddEmpty.textContent = '+ Thêm mục đầu tiên';
      btnAddEmpty.addEventListener('click', (e) => {
        e.stopPropagation();
        openItemEditorDialog(null, pageKey);
      });
      emptyRow.appendChild(btnAddEmpty);
      itemsBox.appendChild(emptyRow);
    }

    visibleItems.forEach((item) => {
      const row = document.createElement('div');
      row.className = `theme-item-row${item.done ? ' is-done' : ''}`;

      const left = document.createElement('div');
      left.className = 'theme-item-left';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'theme-item-checkbox';
      cb.checked = item.done;
      cb.disabled = verifyingWorkspace;
      cb.addEventListener('change', () => {
        if (checklistBusy()) return;
        item.done = cb.checked;
        persistThemeChecklist();
        renderThemeStudioChecklist();
      });

      const codeTag = document.createElement('span');
      codeTag.className = 'theme-item-code';
      codeTag.textContent = item.code;

      const info = document.createElement('div');
      info.className = 'theme-item-info';
      // Every interpolated field below can be written by an agent through the
      // cockpit capabilities — F3 requires escaping before it reaches innerHTML.
      info.innerHTML = `
        <div class="theme-item-name">${escapeHtml(item.name)}</div>
        <div class="theme-item-desc">${escapeHtml(item.desc)}</div>
        <div class="theme-item-qa-point">🔍 QA: ${escapeHtml(item.qaPoint)}</div>
        ${item.note ? `<div class="theme-item-note">📝 ${escapeHtml(item.note)}</div>` : ''}
      `;

      left.append(cb, codeTag, info);

      const right = document.createElement('div');
      right.className = 'theme-item-right';

      const statusTag = document.createElement('span');
      statusTag.className = `theme-status-tag ${item.done ? 'done' : 'backlog'}`;
      statusTag.textContent = item.done ? '✓ Xong' : 'Chưa làm';
      right.appendChild(statusTag);

      const targetPath = resolveChecklistRoute(pageDef, item.pathHint);
      const btnNav = document.createElement('button');
      btnNav.className = 'theme-btn-nav';
      btnNav.title = targetPath ? `Mở đường dẫn storefront: ${targetPath}` : (pageDef.routeNote ?? 'Chưa có trang tương ứng đang mở');
      btnNav.textContent = '↗ Xem';
      btnNav.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!targetPath) {
          showToolbarToast(pageDef.routeNote ?? 'Chưa có trang tương ứng đang mở');
          return;
        }
        navigatePreview(targetPath);
      });
      right.appendChild(btnNav);

      const btnEdit = document.createElement('button');
      btnEdit.className = 'theme-btn-item-action theme-btn-item-edit';
      btnEdit.title = `Chỉnh sửa mục: ${item.name}`;
      btnEdit.textContent = '✏️ Sửa';
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        openItemEditorDialog(item, pageKey);
      });
      right.appendChild(btnEdit);

      const btnDelete = document.createElement('button');
      btnDelete.className = 'theme-btn-item-action theme-btn-item-delete';
      btnDelete.title = `Xóa mục: ${item.name}`;
      btnDelete.textContent = '🗑️ Xóa';
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Bạn có chắc muốn xóa mục "${item.code} - ${item.name}"?`)) {
          if (checklistBusy()) return;
          themeChecklist = themeChecklist.filter((it) => it.id !== item.id);
          persistThemeChecklist();
          renderThemeStudioChecklist();
          showToolbarToast(`Đã xóa mục: ${item.name}`);
        }
      });
      right.appendChild(btnDelete);

      row.append(left, right);
      itemsBox.appendChild(row);
    });

    card.append(itemsBox);
    container.appendChild(card);
  });
}

function renderThemeStudioFindings(report?: Record<string, unknown>) {
  const listEl = document.getElementById('themeQaFindingsList');
  const overallStatusPill = document.getElementById('themeQaOverallStatus');
  const overallStatusText = document.getElementById('themeQaOverallStatusText');
  const badgeFindings = document.getElementById('badgeThemeFindings');
  const platformBadge = document.getElementById('themePlatformBadge');
  const healthPill = document.getElementById('themeHealthPill');

  const statLiquid = document.getElementById('statCountLiquid');
  const statOverflow = document.getElementById('statCountOverflow');
  const statAssets = document.getElementById('statCountAssets');
  const statHs = document.getElementById('statCountHs');
  const statDiag = document.getElementById('statCountDiagnostics');

  if (!listEl) return;

  const rep = report || (lastThemeQaReport || themeQaState.report) as Record<string, unknown> | undefined;
  const findings = rep?.findings as Record<string, unknown> | undefined;
  const summary = rep?.summary as Record<string, unknown> | undefined;
  const platform = findings?.platform as Record<string, unknown> | undefined;

  const liquid = findings?.liquid as { errors?: Array<{ message?: string }> } | undefined;
  const overflow = findings?.overflow as { culprits?: Array<{ selector?: string }> } | undefined;
  const assets = findings?.assets as { brokenAssets?: Array<{ url?: string; src?: string }> } | undefined;
  const hsRules = findings?.hsRules as { totalViolations?: number; violations?: Array<{ ruleId?: string; message?: string }> } | undefined;
  const diagnosticIssues = findings?.diagnosticIssues as Array<{ kind?: string; message?: string; origin?: string }> | undefined;
  const diagnosticWarnings = findings?.diagnosticWarnings as Array<{ kind?: string; message?: string; origin?: string }> | undefined;

  const liquidCount = liquid?.errors?.length || 0;
  const overflowCount = overflow?.culprits?.length || 0;
  const assetsCount = assets?.brokenAssets?.length || 0;
  const hsCount = hsRules?.totalViolations || 0;
  const diagCount = (diagnosticIssues?.length || 0) + (diagnosticWarnings?.length || 0);
  const totalIssues = summary?.totalIssues ?? (liquidCount + overflowCount + assetsCount + hsCount + diagCount);

  if (platformBadge) platformBadge.textContent = typeof platform?.platform === 'string' ? platform.platform.toUpperCase() : 'THEME';
  if (statLiquid) statLiquid.textContent = String(liquidCount);
  if (statOverflow) statOverflow.textContent = String(overflowCount);
  if (statAssets) statAssets.textContent = String(assetsCount);
  if (statHs) statHs.textContent = String(hsCount);
  if (statDiag) statDiag.textContent = String(diagCount);

  if (badgeFindings) badgeFindings.textContent = `${totalIssues} Issues`;

  if (summary) {
    const passed = Boolean(summary.passed);
    if (healthPill) {
      healthPill.textContent = passed ? 'PASSED' : 'FAILED';
      healthPill.classList.toggle('fail', !passed);
    }
    if (overallStatusPill && overallStatusText) {
      overallStatusPill.classList.toggle('pass', passed);
      overallStatusPill.classList.toggle('fail', !passed);
      overallStatusText.textContent = passed
        ? 'STOREFRONT SẠCH (0 Critical Issues)'
        : `PHÁT HIỆN ${totalIssues} LỖI CẦN XỬ LÝ`;
    }
  }

  listEl.innerHTML = '';

  const allCards: Array<{ category: 'critical' | 'warning' | 'info'; title: string; desc: string; selector?: string }> = [];

  (liquid?.errors || []).forEach((item) => {
    allCards.push({ category: 'critical', title: 'LIQUID SYNTAX ERROR', desc: item.message || 'Lỗi cú pháp Liquid' });
  });
  (overflow?.culprits || []).forEach((item) => {
    allCards.push({
      category: 'warning',
      title: 'LAYOUT OVERFLOW (TRÀN CHIỀU NGANG)',
      desc: `Phần tử gây tràn màn hình: ${item.selector || 'Chưa rõ selector'}`,
      selector: item.selector,
    });
  });
  (assets?.brokenAssets || []).forEach((item) => {
    allCards.push({ category: 'warning', title: 'BROKEN ASSET (404)', desc: item.url || item.src || 'Tài nguyên ảnh/script bị hỏng' });
  });
  (hsRules?.violations || []).forEach((item) => {
    allCards.push({ category: 'info', title: `HS RULE [${item.ruleId || 'RULE'}]`, desc: item.message || '' });
  });
  (diagnosticIssues || []).forEach((item) => {
    allCards.push({
      category: 'critical',
      title: `CONSOLE ERROR [${item.kind || 'issue'}]`,
      desc: `${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`,
    });
  });
  (diagnosticWarnings || []).forEach((item) => {
    allCards.push({
      category: 'info',
      title: `DIAGNOSTIC WARNING [${item.kind || 'warning'}]`,
      desc: `${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`,
    });
  });

  if (allCards.length === 0) {
    listEl.innerHTML = `
      <div class="qa-empty-state">
        <div class="qa-empty-icon">${summary?.passed ? '✅' : '🧪'}</div>
        <div>${summary?.passed ? 'Tuyệt vời! Không phát hiện lỗi Liquid, lỗi tràn viền hay tài nguyên hỏng trên trang này.' : 'Bấm <strong>"Scan Live"</strong> để bắt đầu kiểm tra giao diện Storefront.'}</div>
      </div>
    `;
    return;
  }

  allCards.forEach((cardData) => {
    const card = document.createElement('div');
    card.className = `qa-finding-card ${cardData.category}`;

    const content = document.createElement('div');
    content.className = 'qa-finding-content';

    const titleRow = document.createElement('div');
    titleRow.className = 'qa-finding-title-row';
    titleRow.innerHTML = `
      <span class="qa-finding-badge ${cardData.category}">${cardData.category}</span>
      <span class="qa-finding-signature">${cardData.title}</span>
    `;

    const msg = document.createElement('div');
    msg.className = 'qa-finding-msg';
    msg.textContent = cardData.desc;

    content.append(titleRow, msg);

    if (cardData.selector) {
      const target = document.createElement('div');
      target.className = 'qa-finding-target';
      target.textContent = cardData.selector;
      content.appendChild(target);
    }

    card.appendChild(content);

    if (cardData.selector) {
      const btnInspect = document.createElement('button');
      btnInspect.className = 'btn-highlight-dom';
      btnInspect.title = 'Sao chép selector và soi phần tử';
      btnInspect.textContent = '🎯 Soi DOM';
      btnInspect.addEventListener('click', () => {
        navigator.clipboard?.writeText(cardData.selector!);
        showToolbarToast(`Đã sao chép selector: <code>${cardData.selector}</code>`);
      });
      card.appendChild(btnInspect);
    }

    listEl.appendChild(card);
  });
}

function openThemeQaSummary() {
  if (!themeQaOverlay || !themeQaSummary) return;
  const report = (lastThemeQaReport || themeQaState.report) as Record<string, unknown> | undefined;
  const findings = report?.findings as Record<string, unknown> | undefined;
  const summary = report?.summary as Record<string, unknown> | undefined;
  const platform = findings?.platform as Record<string, unknown> | undefined;
  const liquid = findings?.liquid as { errors?: Array<{ message?: string }> } | undefined;
  const overflow = findings?.overflow as { culprits?: Array<{ selector?: string }> } | undefined;
  const assets = findings?.assets as { brokenAssets?: Array<{ url?: string; src?: string }> } | undefined;
  const hsRules = findings?.hsRules as { totalViolations?: number; violations?: Array<{ ruleId?: string; message?: string }> } | undefined;
  const diagnosticIssues = findings?.diagnosticIssues as Array<{ kind?: string; message?: string; origin?: string }> | undefined;
  const diagnosticWarnings = findings?.diagnosticWarnings as Array<{ kind?: string; message?: string; origin?: string }> | undefined;

  const lines = findings ? [
    `Platform: ${platform?.platform || 'unknown'}`,
    `Result: ${summary?.passed ? 'PASSED' : 'FAILED'} (Critical: ${summary?.criticalCount ?? liquid?.errors?.length ?? 0}, Total: ${summary?.totalIssues ?? 0})`,
    `Liquid errors: ${liquid?.errors?.length || 0}`,
    `Layout overflow culprits: ${overflow?.culprits?.length || 0}`,
    `Broken assets: ${assets?.brokenAssets?.length || 0}`,
    `HS violations: ${hsRules?.totalViolations || 0}`,
    `Diagnostic issues (critical): ${diagnosticIssues?.length || 0}`,
    `Diagnostic warnings: ${diagnosticWarnings?.length || 0}`,
    '',
    ...(liquid?.errors || []).map((item) => `[Liquid] ${item.message || 'unknown error'}`),
    ...(overflow?.culprits || []).map((item) => `[Overflow] ${item.selector || 'unknown element'}`),
    ...(assets?.brokenAssets || []).map((item) => `[Asset] ${item.url || item.src || 'unknown asset'}`),
    ...(hsRules?.violations || []).map((item) => `[HS] ${item.ruleId || 'rule'}: ${item.message || ''}`),
    ...(diagnosticIssues || []).map((item) => `[Diagnostics Critical] [${item.kind || 'issue'}] ${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`),
    ...(diagnosticWarnings || []).map((item) => `[Diagnostics Warning] [${item.kind || 'warning'}] ${item.message || ''}${item.origin ? ` (${item.origin})` : ''}`),
  ] : [themeQaState.error || 'No validation has been run.'];

  // Keep hidden raw text updated for automated test suites
  themeQaSummary.textContent = lines.join('\n');

  // Render rich Cockpit UI
  renderThemeStudioChecklist();
  renderThemeStudioFindings(report);

  themeQaOverlay.style.display = 'flex';
  acquireOverlay('theme-qa');
}

let currentTabs: AntiFanTab[] = [];
// The web hub's presented project when Main has reported one; null renders the
// whole strip (fail-open: an absent or retracted identity never hides tabs).
// Set by renderProjectWindowIdentity from the identity broadcast, read by renderTabs.
let stripProjectScope: string | null = null;
let currentBookmarks: Array<{ id: string; title: string; url: string }> = [];
let activeTabId: string = '';
let isInspecting = false;
let isFontFinderActive = false;
let isLensActive = false;
let isRulerActive = false;
let isBookmarkBarVisible = false;
let themeQaState: ThemeQaState = { status: 'idle', issueCount: 0, updatedAt: Date.now() };
let lastThemeQaReport: any = null;
const btnPopoutTerminal = document.getElementById('btnPopoutTerminal') as HTMLButtonElement | null;

// DOM Elements
const tabList = document.getElementById('tabList')!;
// The strip scrolls but hides its scrollbar, and nothing mapped wheel input onto it, so
// a tab past the right edge was present in the DOM and impossible for the user to see or
// click — it read as "lost". Map vertical wheel to horizontal scroll so every tab stays
// reachable. (Tabs the agent plane creates are a separate case: getTabList excludes them
// by design, native-tab-host.ts:2791-2806.)
const tabStrip = document.getElementById('tabStrip') as HTMLElement | null;
if (tabStrip) {
  tabStrip.addEventListener('wheel', (event: WheelEvent) => {
    if (event.deltaY === 0) return;
    const before = tabStrip.scrollLeft;
    tabStrip.scrollLeft = before + event.deltaY;
    if (tabStrip.scrollLeft !== before) event.preventDefault();
  }, { passive: false });
}
const btnNewTab = document.getElementById('btnNewTab')!;
const btnBack = document.getElementById('btnBack') as HTMLButtonElement;
const btnForward = document.getElementById('btnForward') as HTMLButtonElement;
const btnReload = document.getElementById('btnReload') as HTMLButtonElement;
const btnMute = document.getElementById('btnMute') as HTMLButtonElement | null;
const urlInput = document.getElementById('urlInput') as HTMLInputElement;
const btnClearOmnibox = document.getElementById('btnClearOmnibox') as HTMLButtonElement;
const deviceSelect = document.getElementById('deviceSelect') as HTMLSelectElement;
const btnToggleSplit = document.getElementById('btnToggleSplit') as HTMLButtonElement | null;
const splitControlsContainer = document.getElementById('splitControlsContainer') as HTMLElement | null;
const splitDesktopSelect = document.getElementById('splitDesktopSelect') as HTMLSelectElement | null;
const splitMobileSelect = document.getElementById('splitMobileSelect') as HTMLSelectElement | null;
const btnSplitFocusDesktop = document.getElementById('btnSplitFocusDesktop') as HTMLButtonElement | null;
const btnSplitFocusMobile = document.getElementById('btnSplitFocusMobile') as HTMLButtonElement | null;
const agentActiveBadge = document.getElementById('agentActiveBadge') as HTMLElement | null;

// Zoom Stepper Elements
const zoomLabel = document.getElementById('zoomLabel')!;
const btnZoomOutPop = document.getElementById('btnZoomOutPop') as HTMLButtonElement;
const btnZoomInPop = document.getElementById('btnZoomInPop') as HTMLButtonElement;

// Tool Buttons
const btnThemeQa = document.getElementById('btnThemeQa') as HTMLButtonElement | null;
const btnQuickInspect = document.getElementById('btnQuickInspect') as HTMLButtonElement;
const themeQaText = document.getElementById('themeQaText') as HTMLElement | null;
const themeQaOverlay = document.getElementById('themeQaOverlay') as HTMLElement | null;
const themeQaClose = document.getElementById('themeQaClose') as HTMLButtonElement | null;
const themeQaSummary = document.getElementById('themeQaSummary') as HTMLElement | null;
const btnPhoneStatus = document.getElementById('btnPhoneStatus') as HTMLButtonElement | null;
const phoneStatusText = document.getElementById('phoneStatusText') as HTMLElement | null;
const phoneStatusOverlay = document.getElementById('phoneStatusOverlay') as HTMLElement | null;
const phoneStatusBody = document.getElementById('phoneStatusBody') as HTMLElement | null;
const phoneStatusClose = document.getElementById('phoneStatusClose') as HTMLButtonElement | null;
const btnPhoneStatusRefresh = document.getElementById('btnPhoneStatusRefresh') as HTMLButtonElement | null;
let lastPhoneStatus: ToolbarPhoneStatus | null = null;
const btnFontFinder = document.getElementById('btnFontFinder') as HTMLButtonElement;
const mobileRemoteOverlay = document.getElementById('mobileRemoteOverlay')!;
const mobileRemoteClose = document.getElementById('mobileRemoteClose') as HTMLButtonElement;
const mobileRemoteQrContainer = document.getElementById('mobileRemoteQrContainer')!;
const mobileRemoteUrlsList = document.getElementById('mobileRemoteUrlsList')!;
const btnToggleSidebar = document.getElementById('btnToggleSidebar') as HTMLButtonElement;
const btnChromeProfile = document.getElementById('btnChromeProfile') as HTMLButtonElement;
const profileAvatar = document.getElementById('profileAvatar')!;
const profileName = document.getElementById('profileName')!;
const profileDropdownMenu = document.getElementById('profileDropdownMenu')!;
const profileDropdownList = document.getElementById('profileDropdownList')!;
const btnMenu = document.getElementById('btnMenu') as HTMLButtonElement | null;
// (Dead ids removed: btnRuler, btnCaptureFullPage, btnMobileRemote, btnDevTools, codexMainMenu —
//  none exist in toolbar.html.)

let activeProfileInfo: any = null;
let availableChromeProfiles: any[] = [];

// (Dead menu ids removed: menuFind, menuQuickAnnotate, menuFontFinder, menuLens,
//  menuOpenBrowser, menuShortcuts — none exist in toolbar.html.)

// Find Bar
const findBar = document.getElementById('findBar') as HTMLElement | null;
const findInput = document.getElementById('findInput') as HTMLInputElement | null;
const findCount = document.getElementById('findCount') as HTMLElement | null;
const findPrev = (document.getElementById('btnFindPrev') || document.getElementById('findPrev')) as HTMLButtonElement | null;
const findNext = (document.getElementById('btnFindNext') || document.getElementById('findNext')) as HTMLButtonElement | null;
const findClose = (document.getElementById('btnFindClose') || document.getElementById('findClose')) as HTMLButtonElement | null;

// Shortcuts Overlay
const shortcutsOverlay = document.getElementById('shortcutsOverlay') as HTMLElement | null;
const shortcutsClose = document.getElementById('shortcutsClose') as HTMLButtonElement | null;
// Workflow & MCP Hub Elements
const btnWorkflowHub = document.getElementById('btnWorkflowHub') as HTMLButtonElement | null;
const workflowHubOverlay = document.getElementById('workflowHubOverlay') as HTMLElement | null;
const btnWorkflowHubClose = document.getElementById('btnWorkflowHubClose') as HTMLButtonElement | null;
const tabNavWorkflows = document.getElementById('tabNavWorkflows') as HTMLButtonElement | null;
const tabNavMcp = document.getElementById('tabNavMcp') as HTMLButtonElement | null;
const badgeWorkflowCount = document.getElementById('badgeWorkflowCount') as HTMLElement | null;
const badgeMcpCount = document.getElementById('badgeMcpCount') as HTMLElement | null;
const hubSearchInput = document.getElementById('hubSearchInput') as HTMLInputElement | null;
const hubSearchClear = document.getElementById('hubSearchClear') as HTMLButtonElement | null;
const btnHubNewWorkflow = document.getElementById('btnHubNewWorkflow') as HTMLButtonElement | null;
const hubItemsList = document.getElementById('hubItemsList') as HTMLElement | null;
// Static provenance disclosure, declared in toolbar.html and only ever shown or
// hidden here. It is deliberately NOT built from the payload: the panel reports
// dispatches the ledger recorded, which is a proxy for effectiveness rather than
// a measurement of it, so the sentence must stay identical for every payload
// (including no payload at all) instead of tracking the data it qualifies.
const hubMcpDispatchProvenance = document.getElementById('mcpDispatchProvenance') as HTMLElement | null;
const hubDetailEmpty = document.getElementById('hubDetailEmpty') as HTMLElement | null;
const hubWfDetail = document.getElementById('hubWfDetail') as HTMLElement | null;
const hubMcpDetail = document.getElementById('hubMcpDetail') as HTMLElement | null;
const mcpInvokeParams = document.getElementById('mcpInvokeParams') as HTMLTextAreaElement | null;
const mcpInvokeResult = document.getElementById('mcpInvokeResult') as HTMLElement | null;
const btnRunMcpTool = document.getElementById('btnRunMcpTool') as HTMLButtonElement | null;

const wfDetailCategory = document.getElementById('wfDetailCategory') as HTMLElement | null;
const wfDetailName = document.getElementById('wfDetailName') as HTMLElement | null;
const wfDetailDesc = document.getElementById('wfDetailDesc') as HTMLElement | null;
const btnRunWorkflow = document.getElementById('btnRunWorkflow') as HTMLButtonElement | null;
const btnStopWorkflow = document.getElementById('btnStopWorkflow') as HTMLButtonElement | null;
const btnCopyWorkflowJson = document.getElementById('btnCopyWorkflowJson') as HTMLButtonElement | null;
const btnDeleteCustomWf = document.getElementById('btnDeleteCustomWf') as HTMLButtonElement | null;

const hubRunStatusBar = document.getElementById('hubRunStatusBar') as HTMLElement | null;
const runStatusPill = document.getElementById('runStatusPill') as HTMLElement | null;
const runCurrentStepText = document.getElementById('runCurrentStepText') as HTMLElement | null;
const runTimerText = document.getElementById('runTimerText') as HTMLElement | null;
const hubProgressBar = document.getElementById('hubProgressBar') as HTMLElement | null;
const wfStepsCount = document.getElementById('wfStepsCount') as HTMLElement | null;
const wfStepsContainer = document.getElementById('wfStepsContainer') as HTMLElement | null;
const wfArtifactsSection = document.getElementById('wfArtifactsSection') as HTMLElement | null;
const wfArtifactsGrid = document.getElementById('wfArtifactsGrid') as HTMLElement | null;

const mcpDetailCategory = document.getElementById('mcpDetailCategory') as HTMLElement | null;
const mcpDetailName = document.getElementById('mcpDetailName') as HTMLElement | null;
const mcpDetailDesc = document.getElementById('mcpDetailDesc') as HTMLElement | null;
const mcpDetailPermission = document.getElementById('mcpDetailPermission') as HTMLElement | null;
const mcpSchemaCode = document.getElementById('mcpSchemaCode') as HTMLElement | null;
const tabNavCoreHealth = document.getElementById('tabNavCoreHealth') as HTMLButtonElement | null;
const tabNavBridge = document.getElementById('tabNavBridge') as HTMLButtonElement | null;
const tabNavTaskRuns = document.getElementById('tabNavTaskRuns') as HTMLButtonElement | null;
const tabNavRootCauses = document.getElementById('tabNavRootCauses') as HTMLButtonElement | null;
const tabNavRegressions = document.getElementById('tabNavRegressions') as HTMLButtonElement | null;
const tabNavMcpDispatch = document.getElementById('tabNavMcpDispatch') as HTMLButtonElement | null;
const badgeCoreHealth = document.getElementById('badgeCoreHealth') as HTMLElement | null;
const badgeBridge = document.getElementById('badgeBridge') as HTMLElement | null;
const badgeTaskRuns = document.getElementById('badgeTaskRuns') as HTMLElement | null;
const badgeRootCauses = document.getElementById('badgeRootCauses') as HTMLElement | null;
const badgeRegressions = document.getElementById('badgeRegressions') as HTMLElement | null;
const badgeMcpDispatch = document.getElementById('badgeMcpDispatch') as HTMLElement | null;
const hubCoreDetail = document.getElementById('hubCoreDetail') as HTMLElement | null;
const coreDetailCategory = document.getElementById('coreDetailCategory') as HTMLElement | null;
const coreDetailName = document.getElementById('coreDetailName') as HTMLElement | null;
const coreDetailDesc = document.getElementById('coreDetailDesc') as HTMLElement | null;
const coreStatusPill = document.getElementById('coreStatusPill') as HTMLElement | null;
const coreDetailCode = document.getElementById('coreDetailCode') as HTMLElement | null;
const btnCoreRefresh = document.getElementById('btnCoreRefresh') as HTMLButtonElement | null;

type HubTab = 'workflows' | 'mcp' | 'core-health' | 'bridge' | 'task-runs' | 'root-causes' | 'regressions' | 'mcp-dispatch';
const HUB_CORE_TABS: HubTab[] = ['core-health', 'bridge', 'task-runs', 'root-causes', 'regressions'];
const HUB_NAV_BUTTONS: Record<HubTab, HTMLButtonElement | null> = {
  'workflows': tabNavWorkflows,
  'mcp': tabNavMcp,
  'core-health': tabNavCoreHealth,
  'bridge': tabNavBridge,
  'task-runs': tabNavTaskRuns,
  'root-causes': tabNavRootCauses,
  'regressions': tabNavRegressions,
  'mcp-dispatch': tabNavMcpDispatch,
};
let hubCoreState: any = null;
let hubCoreSelected: { tab: HubTab; id: string } | null = null;

let hubActiveTab: HubTab = 'workflows';
let hubWorkflows: any[] = [];
let hubMcpTools: any[] = [];
let hubSelectedWorkflow: any = null;
let hubSelectedMcpTool: any = null;
let hubMcpDispatch: any = null;
let hubMcpDispatchSelected: { id: string } | null = null;
let isWorkflowRunning = false;
let runStartTime = 0;
let runTimerInterval: any = null;

interface ActiveRunStepStatus {
  status: string;
  attempts: number;
}

interface HubArtifact {
  id: string;
  name?: string;
  mimeType?: string;
  mime?: string;
  sizeBytes?: number;
}

interface ActiveRunState {
  workflowId: string;
  totalSteps: number;
  completedSteps: number;
  stepStatuses: Record<string, ActiveRunStepStatus>;
  artifacts: HubArtifact[];
}

function asHubArtifacts(value: unknown): HubArtifact[] {
  if (!Array.isArray(value)) return [];
  const out: HubArtifact[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !('id' in item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || !id) continue;
    const name = 'name' in item ? item.name : undefined;
    const mimeType = 'mimeType' in item ? item.mimeType : undefined;
    const mime = 'mime' in item ? item.mime : undefined;
    const sizeBytes = 'sizeBytes' in item ? item.sizeBytes : undefined;
    out.push({
      id,
      name: typeof name === 'string' ? name : undefined,
      mimeType: typeof mimeType === 'string' ? mimeType : undefined,
      mime: typeof mime === 'string' ? mime : undefined,
      sizeBytes: typeof sizeBytes === 'number' ? sizeBytes : undefined,
    });
  }
  return out;
}

let activeRun: ActiveRunState | null = null;

function updateAllHubBadges() {
  if (badgeWorkflowCount) badgeWorkflowCount.textContent = String(hubWorkflows.length);
  if (badgeMcpCount) badgeMcpCount.textContent = String(hubMcpTools.length);
  updateCoreBadges();
}

function rootCauseStatus(severity: string): string {
  if (severity === 'P0' || severity === 'P1') return 'DEGRADED';
  if (severity === 'P2') return 'WARN';
  if (severity === 'P3') return 'INFO';
  return 'UNKNOWN';
}

function artifactIcon(mimeType: string | undefined): string {
  const mime = (mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.includes('markdown') || mime.endsWith('/md')) return '📝';
  if (mime.includes('json')) return '📦';
  if (mime.startsWith('text/')) return '📄';
  return '📎';
}

function applyStepStatusToDom(stepId: string, status: string, attempts = 1) {
  const card = document.getElementById(`step-card-${stepId}`);
  const pill = document.getElementById(`step-status-${stepId}`);
  const isPassed = status === 'passed';
  const isSkipped = status === 'skipped';
  const isBlocked = status === 'blocked';
  const isRetry = status === 'retry';
  const isRunning = status === 'running';
  if (card) {
    card.className = `hub-step-card ${isPassed ? 'step-passed' : isSkipped ? 'step-skipped' : isBlocked ? 'step-blocked' : isRetry || isRunning ? 'step-running' : status === 'failed' ? 'step-failed' : ''}`;
  }
  if (pill) {
    pill.className = `hub-step-status ${isPassed ? 'step-status-passed' : isSkipped ? 'step-status-skipped' : isBlocked ? 'step-status-blocked' : isRetry || isRunning ? 'step-status-running' : status === 'failed' ? 'step-status-failed' : 'step-status-pending'}`;
    if (isRetry) pill.textContent = `RETRY ${attempts}`;
    else if (isRunning) pill.textContent = 'RUNNING';
    else pill.textContent = (status || 'PENDING').toUpperCase();
  }
}

function projectActiveRunProgress() {
  if (!activeRun || !hubProgressBar) return;
  const total = Math.max(1, activeRun.totalSteps);
  const pct = Math.round((activeRun.completedSteps / total) * 100);
  hubProgressBar.style.width = `${pct}%`;
}

function projectActiveRunOntoDom() {
  if (!activeRun) return;
  projectActiveRunProgress();
  for (const [stepId, st] of Object.entries(activeRun.stepStatuses)) {
    applyStepStatusToDom(stepId, st.status, st.attempts);
  }
  renderActiveRunArtifacts();
}

function renderActiveRunArtifacts() {
  if (!activeRun || !wfArtifactsSection || !wfArtifactsGrid) return;
  if (!activeRun.artifacts.length) {
    wfArtifactsSection.style.display = 'none';
    return;
  }
  wfArtifactsSection.style.display = 'flex';
  wfArtifactsGrid.innerHTML = '';
  for (const art of activeRun.artifacts) {
    wfArtifactsGrid.appendChild(buildArtifactCard(art));
  }
}

function buildArtifactCard(art: { id: string; name?: string; mimeType?: string; mime?: string; sizeBytes?: number }): HTMLDivElement {
  const card = document.createElement('div');
  card.className = 'hub-artifact-card';
  const mime = art.mimeType || art.mime || '';
  card.innerHTML = `
    <div class="hub-artifact-preview">
      <span style="font-size:32px;">${artifactIcon(mime)}</span>
    </div>
    <div class="hub-artifact-meta">
      <div class="hub-artifact-title">${escapeHtml(art.name || art.id)}</div>
      <div class="hub-artifact-desc">${escapeHtml(mime || 'artifact')} (${Math.round((art.sizeBytes || 0) / 1024)} KB)</div>
    </div>
  `;
  card.style.cursor = 'pointer';
  card.title = 'Mở / sao chép artifact';
  card.onclick = async () => {
    try {
      const fullArt = await getApi()?.getWorkflowArtifact(art.id);
      if (!fullArt) {
        showToolbarToast('Không đọc được artifact.');
        return;
      }
      if (fullArt.mimeType?.startsWith('image/') && fullArt.data) {
        const preview = card.querySelector('.hub-artifact-preview');
        if (preview) preview.innerHTML = `<img src="${fullArt.data}" alt="${escapeHtml(art.name || '')}" />`;
        await navigator.clipboard.writeText(fullArt.data);
        showToolbarToast('🖼️ Đã sao chép data URL ảnh vào clipboard.');
        return;
      }
      const text = typeof fullArt.data === 'string' ? fullArt.data : JSON.stringify(fullArt.data, null, 2);
      await navigator.clipboard.writeText(text);
      showToolbarToast('📋 Đã sao chép nội dung artifact vào clipboard.');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToolbarToast(`Không mở được artifact: ${message}`);
    }
  };
  if (mime.startsWith('image/')) {
    getApi()?.getWorkflowArtifact(art.id).then((fullArt) => {
      if (fullArt && fullArt.data && fullArt.mimeType?.startsWith('image/')) {
        const preview = card.querySelector('.hub-artifact-preview');
        if (preview) preview.innerHTML = `<img src="${fullArt.data}" alt="${escapeHtml(art.name || '')}" />`;
      }
    }).catch(() => null);
  }
  return card;
}

function getStepIcon(type: string): string {
  if (type.startsWith('browser.navigate')) return '🌐';
  if (type.startsWith('browser.click')) return '👆';
  if (type.startsWith('browser.type')) return '✍️';
  if (type.startsWith('browser.scroll')) return '📜';
  if (type.startsWith('browser.hover')) return '🎯';
  if (type.startsWith('browser.highlight')) return '✨';
  if (type.startsWith('browser.wait')) return '⏳';
  if (type.startsWith('browser.screenshot')) return '📸';
  if (type.startsWith('browser.extract')) return '🔍';
  if (type.startsWith('browser.set_')) return '📱';
  if (type.startsWith('qa.')) return '🛡️';
  if (type.startsWith('file.')) return '📄';
  if (type.startsWith('report.')) return '📊';
  return '⚡';
}

async function openWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'flex';
  acquireOverlay('workflow-hub');

  try {
    const [res] = await Promise.all([
      getApi()?.getWorkflowState(),
      refreshCoreHealthState(),
      refreshMcpDispatchState(),
    ]);
    if (res) {
      hubWorkflows = res.workflows || [];
      hubMcpTools = res.tools || [];
      updateAllHubBadges();
    }
  } catch (err) {
    console.error('[workflow hub] Failed to fetch state:', err);
  }

  renderHubList();
  if (hubActiveTab === 'workflows' && hubWorkflows.length > 0 && !hubSelectedWorkflow) {
    selectWorkflow(hubWorkflows[0]);
  } else if (hubActiveTab === 'workflows' && hubWorkflows.length === 0) {
    showHubEmptyDetail();
  } else if (hubActiveTab === 'mcp' && hubMcpTools.length > 0 && !hubSelectedMcpTool) {
    selectMcpTool(hubMcpTools[0]);
  } else if (hubActiveTab === 'mcp' && hubMcpTools.length === 0) {
    showHubEmptyDetail();
  } else if (hubActiveTab === 'mcp-dispatch') {
    renderMcpDispatchSelection();
  } else if (HUB_CORE_TABS.includes(hubActiveTab)) {
    renderCoreListSelection();
  }
}

async function refreshCoreHealthState(forceRefresh = false) {
  try {
    const res = await getApi()?.getCoreHealthState?.(forceRefresh ? { refresh: true } : undefined);
    if (res) {
      hubCoreState = res;
      updateCoreBadges();
    }
  } catch (err) {
    console.error('[core health] Failed to fetch state:', err);
    hubCoreState = {
      snapshot: { status: 'UNAVAILABLE', reasonCode: 'IPC_FAILED', affected: [String(err)], evidenceRefs: [], checks: [] },
    };
    updateCoreBadges();
  }
}

function updateCoreBadges() {
  const snap = hubCoreState?.snapshot;
  if (badgeCoreHealth) {
    // The badge carries the crash count instead of the status when there is one: a
    // browser-process death outranks every other condition this tab reports, and the
    // count is what decides whether the session is still safe to work in.
    const crashes = Number(snap?.crashes?.total || 0);
    const latest = snap?.crashes?.records?.[0];
    badgeCoreHealth.textContent = crashes > 0 ? `CRASH ×${crashes}` : (snap?.status ?? '–');
    badgeCoreHealth.classList.toggle('crash', crashes > 0);
    badgeCoreHealth.title = crashes > 0
      ? `${crashes} browser-process crash(es); latest ${String(latest?.time || '')}${latest?.reasonCode ? ` (${String(latest.reasonCode)})` : ''}${latest?.dump ? ` · ${String(latest.dump)}` : ''}`
      : `Core Health: ${String(snap?.status ?? 'UNKNOWN')}`;
  }
  const bridge = hubCoreState?.bridge;
  if (badgeBridge) badgeBridge.textContent = bridge?.status ?? '–';
  const tr = hubCoreState?.taskRuns;
  if (badgeTaskRuns) badgeTaskRuns.textContent = String(tr?.taskRuns?.length ?? 0);
  const rc = hubCoreState?.rootCauses;
  if (badgeRootCauses) badgeRootCauses.textContent = String(rc?.openTotal ?? 0);
  const reg = hubCoreState?.regressions;
  if (badgeRegressions) badgeRegressions.textContent = String(reg?.rows?.length ?? 0);
}

function closeWorkflowHub() {
  if (!workflowHubOverlay) return;
  workflowHubOverlay.style.display = 'none';
  releaseOverlay('workflow-hub');
}

function showHubEmptyDetail() {
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubDetailEmpty) hubDetailEmpty.style.display = 'flex';
}

function renderHubList() {
  if (!hubItemsList) return;
  hubItemsList.innerHTML = '';
  const search = (hubSearchInput?.value || '').toLowerCase().trim();

  if (hubActiveTab === 'workflows') {
    const filtered = hubWorkflows.filter((w) =>
      w.name.toLowerCase().includes(search) ||
      (w.description && w.description.toLowerCase().includes(search)) ||
      (w.category && w.category.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Không tìm thấy kịch bản nào.</div>';
      showHubEmptyDetail();
      return;
    }

    filtered.forEach((wf) => {
      const item = document.createElement('div');
      item.className = `hub-list-item ${hubSelectedWorkflow?.id === wf.id ? 'selected' : ''}`;
      const catClass = `pill-${wf.category || 'qa'}`;
      const stepsCount = wf.definition?.steps?.length || 0;

      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(wf.name)}</span>
          <span class="hub-item-pill ${catClass}">${escapeHtml(wf.category || 'QA')}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(wf.description || 'Chưa có mô tả')}</div>
        <div class="hub-item-meta">
          <span>📑 ${stepsCount} bước</span>
          <span>•</span>
          <span>${wf.isBuiltIn ? '🔒 Mặc định' : '✏️ Tùy chỉnh'}</span>
        </div>
      `;
      item.onclick = () => selectWorkflow(wf);
      hubItemsList.appendChild(item);
    });
  } else if (hubActiveTab === 'mcp-dispatch') {
    renderMcpDispatchList(search);
    return;
  } else if (HUB_CORE_TABS.includes(hubActiveTab)) {
    renderCoreHubList(search);
    return;
  } else {
    const filtered = hubMcpTools.filter((t) =>
      t.name.toLowerCase().includes(search) ||
      (t.description && t.description.toLowerCase().includes(search)) ||
      (t.category && t.category.toLowerCase().includes(search))
    );

    if (filtered.length === 0) {
      hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Không tìm thấy MCP Tool nào.</div>';
      showHubEmptyDetail();
      return;
    }

    filtered.forEach((tool) => {
      const item = document.createElement('div');
      item.className = `hub-list-item ${hubSelectedMcpTool?.id === tool.id ? 'selected' : ''}`;
      const catClass = `pill-${tool.category || 'browser'}`;

      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(tool.name)}</span>
          <span class="hub-item-pill ${catClass}">${escapeHtml(tool.category || 'tool')}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(tool.description || 'Không có mô tả')}</div>
        <div class="hub-item-meta">
          <span>Quyền: ${(tool.permissions || ['read']).join(', ')}</span>
        </div>
      `;
      item.onclick = () => selectMcpTool(tool);
      hubItemsList.appendChild(item);
    });
  }
}

function selectWorkflow(wf: typeof hubSelectedWorkflow) {
  if (!wf) {
    showHubEmptyDetail();
    return;
  }
  hubSelectedWorkflow = wf;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'flex';

  if (wfDetailCategory) {
    wfDetailCategory.textContent = (wf.category || 'QA').toUpperCase();
    wfDetailCategory.className = `hub-cat-pill pill-${wf.category || 'qa'}`;
  }
  if (wfDetailName) wfDetailName.textContent = wf.name;
  if (wfDetailDesc) wfDetailDesc.textContent = wf.description || '';
  if (btnDeleteCustomWf) {
    btnDeleteCustomWf.style.display = wf.isBuiltIn ? 'none' : 'inline-block';
  }

  const steps = wf.definition?.steps || [];
  if (wfStepsCount) wfStepsCount.textContent = `${steps.length} Bước`;
  if (wfStepsContainer) {
    wfStepsContainer.innerHTML = '';
    steps.forEach((step: { id?: string; name?: string; type?: string; params?: Record<string, unknown> }, idx: number) => {
      const card = document.createElement('div');
      card.className = 'hub-step-card';
      card.id = `step-card-${step.id || idx}`;

      const icon = getStepIcon(step.type || '');
      const paramsSummary = Object.entries(step.params || {})
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' | ');

      card.innerHTML = `
        <div class="hub-step-idx">${idx + 1}</div>
        <div class="hub-step-icon">${icon}</div>
        <div class="hub-step-info">
          <div class="hub-step-title">${escapeHtml(step.name || '')}</div>
          <div class="hub-step-meta">
            <span class="hub-step-tag">${escapeHtml(step.type || '')}</span>
            ${paramsSummary ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(paramsSummary)}</span>` : ''}
          </div>
        </div>
        <div class="hub-step-status step-status-pending" id="step-status-${step.id || idx}">PENDING</div>
      `;
      wfStepsContainer.appendChild(card);
    });
  }

  if (activeRun && activeRun.workflowId === wf.id) {
    if (hubRunStatusBar) hubRunStatusBar.style.display = 'flex';
    projectActiveRunOntoDom();
  } else {
    if (hubRunStatusBar) hubRunStatusBar.style.display = 'none';
    if (wfArtifactsSection) wfArtifactsSection.style.display = 'none';
    if (wfArtifactsGrid) wfArtifactsGrid.innerHTML = '';
  }
}


// ---- Core Health surfaces (Phase 6: items 13, 14, 15, 28, 29) --------------
// Every status carries reasonCode + affected; degraded never shows a bare %.

function coreStatusPillClass(status: string): string {
  if (status === 'HEALTHY' || status === 'PASS') return 'pill-passed';
  if (status === 'DEGRADED' || status === 'UNAVAILABLE' || status === 'FAIL') return 'pill-failed';
  return 'pill-ready';
}

interface CoreListItem { id: string; title: string; desc: string; status: string; meta: string }

function coreListItems(): CoreListItem[] {
  const s = hubCoreState;
  if (!s) return [];
  if (hubActiveTab === 'core-health') {
    const snap = s.snapshot || {};
    const checks = (snap.checks || []) as Array<{ name: string; status: string; reasonCode: string; detail?: string }>;
    const items: CoreListItem[] = [{
      id: '__snapshot__', title: 'Overall Core Health',
      desc: String(snap.reasonCode || ''), status: String(snap.status || 'UNKNOWN'),
      meta: String(snap.checkedAt || ''),
    }];
    for (const c of checks) {
      items.push({
        id: c.name, title: c.name, desc: c.detail || c.reasonCode, status: c.status,
        meta: `reasonCode: ${c.reasonCode}`,
      });
    }
    return items;
  }
  if (hubActiveTab === 'bridge') {
    const b = s.bridge || {};
    const items: CoreListItem[] = [{
      id: '__bridge__', title: 'Bridge status', desc: b.reasonCode || '', status: b.status || 'UNKNOWN',
      meta: `coreReachable: ${Boolean(b.coreReachable)}`,
    }];
    for (const p of (b.recentPacks || []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(p.packId), title: String(p.task || p.packId), desc: `context pack ${p.packId}`,
        status: 'INFO', meta: String(p.createdAt || ''),
      });
    }
    return items;
  }
  if (hubActiveTab === 'task-runs') {
    const t = s.taskRuns || {};
    const items: CoreListItem[] = [{
      id: '__task_runs__', title: 'Task runs',
      desc: t.taskRunsTable ? 'task_runs table present' : 'task_runs table absent — no producer writes it',
      status: t.status || 'UNKNOWN', meta: t.reasonCode || '',
    }];
    for (const r of (t.taskRuns || []) as Array<Record<string, unknown>>) {
      const rid = String(r.runId || r.taskRunId || r.id || '');
      items.push({ id: rid, title: String(r.task || rid || 'task run'), desc: 'task_runs row', status: 'INFO', meta: String(r.createdAt || '') });
    }
    for (const p of (t.packs || []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(p.packId), title: String(p.task || p.packId),
        desc: `context pack${p.platform ? ` · ${p.platform}` : ''}${p.taskHash ? ` · taskHash ${String(p.taskHash).slice(0, 12)}` : ''}`,
        status: 'INFO', meta: String(p.createdAt || ''),
      });
    }
    for (const c of (t.cases || []) as Array<Record<string, unknown>>) {
      items.push({ id: String(c.caseId), title: String(c.task || c.caseId), desc: 'verified outcome case', status: 'INFO', meta: String(c.createdAt || '') });
    }
    return items;
  }
  if (hubActiveTab === 'root-causes') {
    const groups = (s.rootCauses?.groups || []) as Array<{ key: string; count: number; issueClass: string; worstSeverity: string; latestMessage?: string }>;
    return groups.map((g) => ({
      id: g.key, title: g.key, desc: g.latestMessage || '',
      status: rootCauseStatus(g.worstSeverity),
      meta: `×${g.count} · ${g.issueClass}`,
    }));
  }
  if (hubActiveTab === 'regressions') {
    const r = s.regressions || {};
    const items: CoreListItem[] = [{
      id: '__regressions__', title: 'Replay engine',
      desc: r.replayEngineAvailable ? 'available' : 'unavailable',
      status: r.status || 'UNKNOWN', meta: r.reasonCode || '',
    }];
    for (const row of (r.rows || []) as Array<Record<string, unknown>>) {
      items.push({
        id: String(row.regressionId), title: String(row.newKnowledge || row.regressionId),
        desc: `replayResult: ${row.replayResult || 'n/a'}`,
        status: row.replayResult === 'PASS' ? 'HEALTHY' : 'DEGRADED',
        meta: String(row.createdAt || ''),
      });
    }
    return items;
  }
  return [];
}

function renderCoreHubList(search: string) {
  if (!hubItemsList) return;
  const items = coreListItems().filter((it) =>
    it.title.toLowerCase().includes(search) || it.desc.toLowerCase().includes(search) || it.id.toLowerCase().includes(search));
  if (items.length === 0) {
    hubItemsList.innerHTML = `<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">${hubCoreState ? 'Không có mục nào.' : 'Đang tải dữ liệu Core…'}</div>`;
    return;
  }
  items.forEach((it) => {
    const item = document.createElement('div');
    item.className = `hub-list-item ${hubCoreSelected?.id === it.id ? 'selected' : ''}`;
    // The selection key is mirrored on the DOM so a row can be addressed by
    // identity: the auto-selected surface row is always index 0, which makes
    // positional selection silently point at the wrong row.
    item.setAttribute('data-item-id', it.id);
    item.innerHTML = `
      <div class="hub-item-top">
        <span class="hub-item-title">${escapeHtml(it.title)}</span>
        <span class="hub-item-pill">${escapeHtml(it.status)}</span>
      </div>
      <div class="hub-item-desc">${escapeHtml(it.desc)}</div>
      <div class="hub-item-meta"><span>${escapeHtml(it.meta)}</span></div>`;
    item.onclick = () => { void selectCoreItem(it.id); };
    hubItemsList.appendChild(item);
  });
}

function renderCoreListSelection() {
  const items = coreListItems();
  if (items.length > 0 && items[0]) {
    void selectCoreItem(items[0].id);
  } else {
    showCoreDetailEmpty();
  }
}

function showCoreDetailEmpty() {
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubDetailEmpty) hubDetailEmpty.style.display = 'flex';
}

// ---- MCP Dispatch accounting (ledger population, not the capability catalogue) ----
// This tab renders `antifan:mcp-dispatch:get-state`, whose rows come from the
// control-plane invocation ledger. Every string it shows is either persisted
// (`frame.name`, the `frame.error.code` histogram keys) or injected (`reasonCode`,
// `affected[]`, `storePath`), so each interpolation passes escapeHtml (:1542) and
// every non-template assignment uses textContent (plan.md constraint E). Nothing
// here re-derives a payload value: the covered window is read from Phase 1's
// `census.limits.windowNewestMtimeMs`/`windowOldestMtimeMs` and the margin label is
// printed verbatim.

interface McpDispatchListItem {
  id: string;
  kind: 'notice' | 'overview' | 'name' | 'margin' | 'truncation' | 'core-hole';
  title: string;
  desc: string;
  status: string;
  meta: string;
  category: string;
  row: any;
}

// The two GENERAL reconciliation forms are printed verbatim (plan.md Success
// Criteria). Phase 3's `reconciliation.lines` carry the same two forms with the
// numbers filled in and are printed beside them, so the invariant cannot be
// restated as the `keylessFrames === 0` special case that is false by construction
// whenever a frame reaches admission without a validated composite.
const MCP_DISPATCH_KEYS_INVARIANT = 'classifiedKeys + unattributedKeys == compositeKeys';
const MCP_DISPATCH_FRAMES_INVARIANT = 'frames == compositeKeys + superseded + keylessFrames';

// The launch paths that cannot carry the proxy store's environment variable
// (phase-05-core-proxy-emitter.md "Coverage is disclosed per launch path"). The
// two package.json anchors and the Codex child-env anchor were re-read live; the
// "no AntiFan MCP server in ~/.codex/config.toml" half is phase-05's measurement,
// cited rather than re-asserted here.
const MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS = [
  'bin.antifan-mcp (package.json:12) — spawned directly, never receives ANTIFAN_PROXY_TELEMETRY_DIR',
  'npm run mcp (package.json:17) — same proxy, same missing variable',
  'Codex — src/main/agent/codex-execution-backend.ts:81-100 builds the child env and injects no proxy telemetry path',
];

/**
 * The renderer-local UNMEASURED envelope. Used when the bridge method is absent or
 * its promise rejects: the tab must render a well-formed UNMEASURED notice rather
 * than a blank pane, and `IPC_FAILED`/`NO_DATA` are renderer-local codes, not
 * members of the service's UnmeasuredReason enum.
 */
function unmeasuredRendererFallback(reasonCode: string, affected: string[] = []): any {
  return {
    status: 'UNMEASURED',
    reasonCode,
    affected,
    evidenceRefs: [],
    asOf: new Date().toISOString(),
    storePath: '—',
    census: null,
    fileRollups: [],
    rows: [],
    totals: null,
    reconciliation: null,
  };
}

/**
 * `storePath` is a display label or null. Null is the NO_DATA_ROOT_RESOLVED case —
 * a first-class state with its own copy — so it renders the reasonCode, never the
 * text "null" and never an invented placeholder path (constraint D).
 */
function mcpDispatchStoreLabel(payload: any): string {
  if (payload && typeof payload.storePath === 'string' && payload.storePath.length > 0) return payload.storePath;
  return String(payload?.reasonCode ?? 'NO_DATA');
}

/** A count is only a count when the payload carries a number; otherwise UNMEASURED. */
function mcpDispatchCount(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'UNMEASURED';
}

function mcpDispatchHistogram(map: unknown, limit: number): string {
  if (!map || typeof map !== 'object') return 'UNMEASURED';
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length === 0) return 'UNMEASURED';
  const sorted = entries.slice().sort((a, b) => {
    const an = typeof a[1] === 'number' ? a[1] : -1;
    const bn = typeof b[1] === 'number' ? b[1] : -1;
    if (an !== bn) return bn - an;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  });
  return sorted.slice(0, limit).map(([key, value]) => `${key}×${mcpDispatchCount(value)}`).join(' · ');
}

function mcpDispatchMs(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${value}ms` : 'UNMEASURED';
}

/** `count === 0` is not a measurement: an empty latency sample renders UNMEASURED. */
function mcpDispatchLatency(latency: unknown): string {
  if (!latency || typeof latency !== 'object') return 'UNMEASURED';
  const sample = latency as { count?: unknown; p50Ms?: unknown; p95Ms?: unknown };
  if (typeof sample.count !== 'number' || !Number.isFinite(sample.count) || sample.count === 0) return 'UNMEASURED';
  return `p50 ${mcpDispatchMs(sample.p50Ms)} · p95 ${mcpDispatchMs(sample.p95Ms)} (n=${sample.count})`;
}

/**
 * The covered window of a truncated read. Phase 1 owns these two fields; deriving
 * the window from `census.files` or from row timestamps would be a second source
 * of truth for the same fact.
 */
function mcpDispatchWindow(census: any): string {
  const limits = census?.limits;
  const stamp = (value: unknown) => (typeof value === 'number' && Number.isFinite(value)
    ? `${new Date(value).toISOString()} (${value})`
    : 'UNMEASURED');
  return `newest ${stamp(limits?.windowNewestMtimeMs)} → oldest ${stamp(limits?.windowOldestMtimeMs)}`;
}

/**
 * The read facts an UNMEASURED payload may still carry. An UNMEASURED status with a
 * non-null `census` means the store WAS read and yielded nothing admissible (census
 * drift, a degenerate ceiling with `filesRead === 0`, or a partition that vanished
 * between census and read) — which must not read as "nothing was read at all".
 * Every value is read verbatim from `census.limits`; a field the payload does not
 * carry renders nothing rather than a fabricated count, and `census === null` yields
 * '' so that case keeps the reasonCode-only copy.
 */
function mcpDispatchReadFacts(payload: any): string {
  const limits = payload?.census?.limits;
  if (!limits || typeof limits !== 'object') return '';
  const facts: string[] = [];
  // Both counts print when the payload carries both: the degenerate-ceiling case is
  // exactly `observedFiles` large with `filesRead` 0, and printing only the first
  // would hide the state this line exists to disclose.
  if (typeof limits.observedFiles === 'number' && Number.isFinite(limits.observedFiles)) {
    facts.push(`census.limits.observedFiles: ${limits.observedFiles}`);
  }
  if (typeof limits.filesRead === 'number' && Number.isFinite(limits.filesRead)) {
    facts.push(`census.limits.filesRead: ${limits.filesRead}`);
  }
  facts.push(`census.limits.outcome: ${typeof limits.outcome === 'string' && limits.outcome.length > 0 ? limits.outcome : 'UNMEASURED'}`);
  if (limits.ceiling !== null && limits.ceiling !== undefined) {
    facts.push(`census.limits.ceiling: ${String(limits.ceiling)}`);
  }
  return facts.join(' · ');
}

function mcpDispatchListItems(): McpDispatchListItem[] {
  const payload = hubMcpDispatch;
  if (!payload) return [];
  const rows: any[] = Array.isArray(payload.rows) ? payload.rows : [];

  if (payload.status !== 'MEASURED' && rows.length === 0) {
    const status = String(payload.status ?? 'UNMEASURED');
    const reasonCode = String(payload.reasonCode ?? 'NO_DATA');
    const affected = Array.isArray(payload.affected) ? payload.affected.map((a: unknown) => String(a)).join(' · ') : '';
    const readFacts = mcpDispatchReadFacts(payload);
    return [{
      id: 'mcpDispatchNotice', kind: 'notice', title: status,
      // The read facts are repeated here so the auto-selected detail pane cannot
      // contradict the notice beside it (both print the same helper's output).
      desc: `${reasonCode} · ${mcpDispatchStoreLabel(payload)}${readFacts ? ` · read: ${readFacts}` : ''}`,
      status, meta: affected, category: reasonCode, row: null,
    }];
  }

  const items: McpDispatchListItem[] = [];
  const reconciliation = payload.reconciliation || null;
  const invariantLines: string[] = Array.isArray(reconciliation?.lines)
    ? (reconciliation.lines as unknown[]).map((line) => String(line))
    : [];
  items.push({
    id: 'mcpDispatchReconciliation',
    kind: 'overview',
    title: 'Đối soát (Reconciliation)',
    desc: [MCP_DISPATCH_KEYS_INVARIANT, MCP_DISPATCH_FRAMES_INVARIANT, ...invariantLines].join('\n'),
    status: String(payload.status ?? 'UNMEASURED'),
    meta: `asOf ${String(payload.asOf ?? 'UNMEASURED')} · ${mcpDispatchStoreLabel(payload)}`,
    category: 'RECONCILIATION',
    row: null,
  });

  rows.forEach((row, index) => {
    // Rows describe RETAINED frames only, and a short read or an input ceiling
    // makes every count a floor: the marker is rendered, never rounded away.
    const lowerBound = row?.lowerBound === true;
    items.push({
      id: `mcpDispatchRow:${index}`,
      kind: 'name',
      title: String(row?.name ?? ''),
      desc: `states: ${mcpDispatchHistogram(row?.states, 8)} · errors: ${mcpDispatchHistogram(row?.errors, 6)}`
        + ` · latency: ${mcpDispatchLatency(row?.latency)} · excluded: ${mcpDispatchLatency(row?.excludedLatency)}`
        + (lowerBound ? ' · sàn (lowerBound): đây là sàn, không phải tổng lịch sử' : ''),
      status: lowerBound ? '≥ LOWER BOUND' : 'RETAINED',
      meta: `${lowerBound ? '≥ ' : ''}calls ${mcpDispatchCount(row?.calls)} · frames ${mcpDispatchCount(row?.frames)}`
        + ` · superseded ${mcpDispatchCount(row?.superseded)}`
        + ` · window ${String(row?.firstSeen ?? 'UNMEASURED')} → ${String(row?.lastSeen ?? 'UNMEASURED')}`,
      category: 'DISPATCH NAME',
      row,
    });
  });

  const totals = payload.totals || null;
  const margin = totals?.quarantineMargin || null;
  if (margin) {
    items.push({
      id: 'mcpDispatchQuarantineMargin', kind: 'margin',
      title: 'Chuẩn cách ly (quarantine margin)',
      desc: String(margin.label ?? 'UNMEASURED'),
      status: 'MARGIN', meta: '', category: 'QUARANTINE_MARGIN', row: null,
    });
  }

  const truncation = totals?.truncation || null;
  if (truncation) {
    const filesRead = truncation.filesRead;
    const filesSkipped = truncation.filesSkipped;
    // The label is built from the payload's own integers; a missing field renders
    // UNMEASURED rather than a fabricated 0.
    const partial = (typeof filesRead === 'number' && typeof filesSkipped === 'number')
      ? `partial: ${filesRead} of ${filesRead + filesSkipped} files`
      : 'partial: UNMEASURED of UNMEASURED files';
    items.push({
      id: 'mcpDispatchTruncation', kind: 'truncation',
      title: 'Đọc một phần (truncation)',
      desc: partial,
      status: 'PARTIAL', meta: '', category: 'POPULATION_TRUNCATED', row: null,
    });
  }

  // Unconditional in this phase: Phase 5 either fills this hole with measured
  // proxy attempts or leaves it named. A store nothing reads is not telemetry.
  items.push({
    id: 'mcpDispatchCoreHole', kind: 'core-hole',
    title: 'Lỗ core.* (chưa đo được)',
    desc: 'core.* không có frame nào trong ledger: lệnh trả về trong tiến trình trước khi định danh invocation được cấp'
      + ' (scripts/antifan-omp-mcp.cjs: nhánh core.* trả về trước cổng bootstrap). Đơn vị: proxy-attempt · nguồn: omp-proxy.'
      + ' 0 lần thử nghĩa là CHƯA ĐƯỢC GHI NHẬN, không phải "không dùng".',
    status: 'UNMEASURED',
    meta: MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS.join(' · '),
    category: 'CORE_HOLE',
    row: null,
  });

  return items;
}

/** The one non-metric notice: UNMEASURED + reasonCode + storePath label, no rows. */
function renderMcpDispatchNotice() {
  if (!hubItemsList) return;
  const payload = hubMcpDispatch;
  const status = String(payload?.status ?? 'UNMEASURED');
  const reasonCode = String(payload?.reasonCode ?? 'NO_DATA');
  const affected = Array.isArray(payload?.affected)
    ? (payload.affected as unknown[]).map((entry) => String(entry)).join(' · ')
    : '';
  const readFacts = mcpDispatchReadFacts(payload);
  const notice = document.createElement('div');
  notice.id = 'mcpDispatchNotice';
  notice.setAttribute('style', 'color:#64748b;font-size:12px;padding:20px;text-align:center;white-space:pre-line;');
  // textContent, not a template: reasonCode / storePath / affected and every
  // census-derived read fact are injected or persisted strings.
  notice.textContent = `${status}\n${reasonCode} · ${mcpDispatchStoreLabel(payload)}`
    + `${readFacts ? `\nread: ${readFacts}` : ''}`
    + `${affected ? `\naffected: ${affected}` : ''}`;
  hubItemsList.innerHTML = '';
  hubItemsList.appendChild(notice);
}

function renderMcpDispatchList(search: string) {
  if (!hubItemsList) return;
  if (!hubMcpDispatch) {
    hubItemsList.innerHTML = '<div style="color:#64748b;font-size:12px;padding:20px;text-align:center;">Đang tải dữ liệu MCP Dispatch…</div>';
    return;
  }
  const rows: any[] = Array.isArray(hubMcpDispatch.rows) ? hubMcpDispatch.rows : [];
  if (hubMcpDispatch.status !== 'MEASURED' && rows.length === 0) {
    renderMcpDispatchNotice();
    return;
  }

  const needle = (search || '').toLowerCase().trim();
  const items = mcpDispatchListItems().filter((it) => {
    // The search box filters per-name rows ONLY: an UNMEASURED notice, the
    // quarantine margin, the truncation label and the core.* hole are disclosures
    // and must never be hideable by a search box.
    if (it.kind !== 'name') return true;
    if (!needle) return true;
    return it.title.toLowerCase().includes(needle);
  });

  hubItemsList.innerHTML = '';
  for (const it of items) {
    const item = document.createElement('div');
    item.className = `hub-list-item ${hubMcpDispatchSelected?.id === it.id ? 'selected' : ''}`;
    // Assigned as a DOM property, so a row value can never be parsed as markup.
    item.id = it.id;
    if (it.kind === 'margin' || it.kind === 'truncation') {
      // These two rows carry their labelled line and nothing else, so the element's
      // text is exactly the label the envelope published.
      item.innerHTML = `<div class="hub-item-desc">${escapeHtml(it.desc)}</div>`;
    } else {
      item.innerHTML = `
        <div class="hub-item-top">
          <span class="hub-item-title">${escapeHtml(it.title)}</span>
          <span class="hub-item-pill">${escapeHtml(it.status)}</span>
        </div>
        <div class="hub-item-desc">${escapeHtml(it.desc)}</div>
        <div class="hub-item-meta"><span>${escapeHtml(it.meta)}</span></div>`;
    }
    item.onclick = () => { void selectMcpDispatchRow(it.id); };
    hubItemsList.appendChild(item);
  }
}

function renderMcpDispatchSelection() {
  const items = mcpDispatchListItems();
  const first = items[0];
  if (first) {
    void selectMcpDispatchRow(first.id);
  } else {
    showCoreDetailEmpty();
  }
}

function mcpDispatchDetailBody(item: McpDispatchListItem | null): unknown {
  const payload = hubMcpDispatch;
  if (!item) {
    return {
      status: String(payload?.status ?? 'UNMEASURED'),
      reasonCode: String(payload?.reasonCode ?? 'NO_DATA'),
      storePath: payload?.storePath ?? null,
      storeLabel: mcpDispatchStoreLabel(payload),
      affected: Array.isArray(payload?.affected) ? payload.affected : [],
      asOf: payload?.asOf ?? null,
      evidenceRefs: Array.isArray(payload?.evidenceRefs) ? payload.evidenceRefs : [],
    };
  }
  if (item.kind === 'name') {
    const row = item.row;
    return {
      name: row?.name, calls: row?.calls, frames: row?.frames, superseded: row?.superseded,
      lowerBound: row?.lowerBound === true,
      firstSeen: row?.firstSeen ?? null, lastSeen: row?.lastSeen ?? null,
      states: row?.states ?? null, errors: row?.errors ?? null,
      latency: row?.latency ?? null, excludedLatency: row?.excludedLatency ?? null,
    };
  }
  if (item.kind === 'overview') {
    const reconciliation = payload?.reconciliation || null;
    return {
      status: payload?.status ?? null,
      reasonCode: payload?.reasonCode ?? null,
      asOf: payload?.asOf ?? null,
      storeLabel: mcpDispatchStoreLabel(payload),
      invariants: [MCP_DISPATCH_KEYS_INVARIANT, MCP_DISPATCH_FRAMES_INVARIANT],
      reconciliation,
      reconciliationLines: Array.isArray(reconciliation?.lines) ? reconciliation.lines : [],
    };
  }
  if (item.kind === 'margin') {
    const margin = payload?.totals?.quarantineMargin || null;
    return {
      label: margin?.label ?? 'UNMEASURED',
      files: margin?.files ?? null,
      framesPresent: margin?.framesPresent ?? null,
      framesAdmitted: margin?.framesAdmitted ?? null,
      framesNamedInvalid: margin?.framesNamedInvalid ?? null,
      reasons: margin?.reasons ?? [],
    };
  }
  if (item.kind === 'truncation') {
    const truncation = payload?.totals?.truncation || null;
    return {
      label: item.desc,
      ceiling: truncation?.ceiling ?? null,
      filesRead: truncation?.filesRead ?? null,
      filesSkipped: truncation?.filesSkipped ?? null,
      order: truncation?.order ?? null,
      // Phase 1's own fields — never re-derived from census.files or row timestamps.
      coveredWindow: mcpDispatchWindow(payload?.census),
      windowNewestMtimeMs: payload?.census?.limits?.windowNewestMtimeMs ?? null,
      windowOldestMtimeMs: payload?.census?.limits?.windowOldestMtimeMs ?? null,
    };
  }
  if (item.kind === 'core-hole') {
    return {
      unit: 'proxy-attempt',
      provenance: 'omp-proxy',
      launchPathsThatCannotCarryTheEnvironmentVariable: MCP_DISPATCH_CORE_HOLE_LAUNCH_PATHS,
      zeroAttemptsMeans: 'not yet instrumented — never "unused"',
    };
  }
  return {
    status: String(payload?.status ?? 'UNMEASURED'),
    reasonCode: String(payload?.reasonCode ?? 'NO_DATA'),
    storePath: payload?.storePath ?? null,
    storeLabel: mcpDispatchStoreLabel(payload),
    affected: Array.isArray(payload?.affected) ? payload.affected : [],
    // Present only when the payload carries a census: an UNMEASURED payload that was
    // read and admitted nothing still publishes what the read observed.
    censusReadFacts: mcpDispatchReadFacts(payload),
    asOf: payload?.asOf ?? null,
    evidenceRefs: Array.isArray(payload?.evidenceRefs) ? payload.evidenceRefs : [],
  };
}

async function selectMcpDispatchRow(id: string) {
  hubMcpDispatchSelected = { id };
  hubSelectedWorkflow = null;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'flex';

  const item = mcpDispatchListItems().find((it) => it.id === id) || null;
  const status = item ? item.status : 'UNMEASURED';
  // textContent only: these values are persisted or injected strings.
  if (coreDetailName) coreDetailName.textContent = item ? item.title : 'MCP Dispatch';
  if (coreDetailDesc) coreDetailDesc.textContent = item ? item.desc : '';
  if (coreStatusPill) {
    coreStatusPill.textContent = status;
    coreStatusPill.className = `hub-status-pill ${coreStatusPillClass(status)}`;
  }
  if (coreDetailCategory) coreDetailCategory.textContent = item ? item.category : 'NO_DATA';
  if (coreDetailCode) coreDetailCode.textContent = JSON.stringify(mcpDispatchDetailBody(item), null, 2);
}

/**
 * Failure-tolerant refresh, mirroring refreshCoreHealthState (:526-540): a host
 * that loads the real preload without the new handler makes `ipcRenderer.invoke`
 * reject, and the tab must degrade to a well-formed UNMEASURED notice.
 */
async function refreshMcpDispatchState() {
  try {
    const res = await getApi()?.getMcpDispatchState?.();
    hubMcpDispatch = res ?? unmeasuredRendererFallback('NO_DATA');
  } catch (err) {
    hubMcpDispatch = unmeasuredRendererFallback('IPC_FAILED', [String(err)]);
  }
  if (badgeMcpDispatch) {
    const rows: any[] = Array.isArray(hubMcpDispatch?.rows) ? hubMcpDispatch.rows : [];
    // `–` while the truth is unknown: a `0` badge would claim "never dispatched".
    badgeMcpDispatch.textContent = hubMcpDispatch?.status === 'MEASURED' ? String(rows.length) : '–';
  }
  renderMcpDispatchList(hubSearchInput?.value || '');
}

async function selectCoreItem(id: string) {
  hubCoreSelected = { tab: hubActiveTab, id };
  hubSelectedWorkflow = null;
  hubSelectedMcpTool = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'flex';
  await renderCoreDetail(id);
}

async function renderCoreDetail(id: string) {
  const s = hubCoreState;
  const setHeader = (name: string, desc: string, status: string, reasonCode: string) => {
    if (coreDetailName) coreDetailName.textContent = name;
    if (coreDetailDesc) coreDetailDesc.textContent = desc;
    if (coreStatusPill) {
      coreStatusPill.textContent = status;
      coreStatusPill.className = `hub-status-pill ${coreStatusPillClass(status)}`;
    }
    if (coreDetailCategory) coreDetailCategory.textContent = reasonCode;
  };
  const setBody = (obj: unknown) => {
    if (coreDetailCode) coreDetailCode.textContent = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  };
  if (!s) {
    setHeader('Core', 'no data loaded', 'UNKNOWN', 'NO_DATA');
    setBody('Core state not loaded.');
    return;
  }

  if (hubActiveTab === 'core-health') {
    const checks = (s.snapshot?.checks || []) as Array<{ name: string; status: string; reasonCode: string; detail?: string; affected?: string[]; evidenceRefs?: string[] }>;
    const check = checks.find((c) => c.name === id);
    const snap = s.snapshot || {};
    // The crash check answers a different question from the gate checks: not "is the Core
    // healthy" but "has this runtime died, and against what evidence". Its body therefore
    // leads with the crash records — process, dump, pid — so the next action is obvious.
    if (id === 'runtime.crash') {
      const crash = (snap.crashes || { total: 0, latestAt: '', latestId: '', records: [] }) as {
        total: number; latestAt: string; latestId: string; records: unknown[];
      };
      setHeader(
        'runtime.crash',
        String(check?.detail || `${crash.total} browser-process crash(es)`),
        String(check?.status || (crash.total > 0 ? 'DEGRADED' : 'UNKNOWN')),
        String(check?.reasonCode || 'NO_CRASH_RECORDED'),
      );
      setBody({
        total: crash.total,
        latestAt: crash.latestAt,
        latestId: crash.latestId,
        records: crash.records,
        affected: check?.affected || [],
        evidenceRefs: check?.evidenceRefs || [],
        snapshotStats: snap.stats,
        openIssues: snap.openIssues,
      });
      return;
    }
    if (check) {
      setHeader(check.name, check.detail || '', check.status, check.reasonCode);
      setBody({ ...check, snapshotStats: snap.stats, audit: snap.audit, decay: snap.decay, uncertainty: snap.uncertainty, openIssues: snap.openIssues });
    } else {
      setHeader('Core Health', String(snap.checkedAt || ''), String(snap.status || 'UNKNOWN'), String(snap.reasonCode || 'NO_DATA'));
      setBody(snap);
    }
    return;
  }
  if (hubActiveTab === 'bridge') {
    const b = s.bridge || {};
    if (id === '__bridge__') {
      setHeader('Core Bridge', b.telemetryFound ? 'telemetry file found' : 'no telemetry file', String(b.status || 'UNKNOWN'), String(b.reasonCode || ''));
      setBody({ coreReachable: b.coreReachable, telemetryPaths: b.telemetryPaths, failures: b.failures, unknowns: b.unknowns });
    } else {
      const pack = ((b.recentPacks || []) as Array<Record<string, unknown>>).find((p) => p.packId === id);
      setHeader(id, String(pack?.task || ''), 'INFO', 'PACK');
      setBody(pack || 'pack not found');
    }
    return;
  }
  if (hubActiveTab === 'task-runs') {
    const t = s.taskRuns || {};
    if (id === '__task_runs__') {
      setHeader('Task runs', t.taskRunsTable ? 'task_runs table present' : 'task_runs table absent — no producer writes it', String(t.status || 'UNKNOWN'), String(t.reasonCode || ''));
      setBody({ taskRunsTable: t.taskRunsTable, affected: t.affected, taskRuns: t.taskRuns });
      return;
    }
    if (coreDetailCode) coreDetailCode.textContent = 'Đang tải trace…';
    try {
      const trace = await getApi()?.getCoreTaskRunTrace?.(id);
      setHeader(id, String(trace?.kind || ''), String(trace?.status || 'UNKNOWN'), String(trace?.reasonCode || ''));
      setBody(trace || 'trace unavailable');
    } catch (err) {
      setHeader(id, '', 'UNAVAILABLE', 'IPC_FAILED');
      setBody(String(err));
    }
    return;
  }
  if (hubActiveTab === 'root-causes') {
    const groups = (s.rootCauses?.groups || []) as Array<{ key: string; worstSeverity: string; issueClass: string; latestMessage?: string }>;
    const g = groups.find((x) => x.key === id);
    if (g) {
      setHeader(g.key, g.latestMessage || '', rootCauseStatus(g.worstSeverity), g.issueClass);
      setBody(g);
    }
    return;
  }
  if (hubActiveTab === 'regressions') {
    const r = s.regressions || {};
    if (id === '__regressions__') {
      setHeader('Core Regression', r.replayEngineAvailable ? 'replay engine available' : 'replay engine unavailable', String(r.status || 'UNKNOWN'), String(r.reasonCode || ''));
      setBody({ replayEngineAvailable: r.replayEngineAvailable, rows: r.rows });
    } else {
      const row = ((r.rows || []) as Array<Record<string, unknown>>).find((x) => x.regressionId === id);
      setHeader(id, String(row?.newKnowledge || ''), row?.replayResult === 'PASS' ? 'HEALTHY' : 'DEGRADED', String(row?.replayResult || 'NO_RESULT'));
      setBody(row || 'row not found');
    }
    return;
  }
}

function setHubTab(tab: HubTab) {
  hubActiveTab = tab;
  for (const t of Object.keys(HUB_NAV_BUTTONS) as HubTab[]) {
    const btn = HUB_NAV_BUTTONS[t];
    if (btn) btn.classList.toggle('active', t === tab);
  }
  hubCoreSelected = null;
  // The provenance line belongs to the MCP Dispatch tab's counts, so it is shown
  // exactly with that tab. Visibility only — its text never depends on the data.
  if (hubMcpDispatchProvenance) {
    hubMcpDispatchProvenance.style.display = tab === 'mcp-dispatch' ? 'block' : 'none';
  }
  renderHubList();
  if (tab === 'workflows') {
    if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
    else showHubEmptyDetail();
  } else if (tab === 'mcp') {
    if (hubMcpTools.length > 0) selectMcpTool(hubMcpTools[0]);
    else showHubEmptyDetail();
  } else if (tab === 'mcp-dispatch') {
    renderMcpDispatchSelection();
  } else {
    renderCoreListSelection();
  }
}
function selectMcpTool(tool: any) {
  hubSelectedMcpTool = tool;
  hubSelectedWorkflow = null;
  renderHubList();

  if (hubDetailEmpty) hubDetailEmpty.style.display = 'none';
  if (hubWfDetail) hubWfDetail.style.display = 'none';
  if (hubCoreDetail) hubCoreDetail.style.display = 'none';
  if (hubMcpDetail) hubMcpDetail.style.display = 'flex';

  if (mcpDetailCategory) {
    mcpDetailCategory.textContent = (tool.category || 'BROWSER').toUpperCase();
    mcpDetailCategory.className = `hub-cat-pill pill-${tool.category || 'browser'}`;
  }
  if (mcpDetailName) mcpDetailName.textContent = tool.name;
  if (mcpDetailDesc) mcpDetailDesc.textContent = tool.description || 'Không có mô tả chi tiết.';
  if (mcpDetailPermission) {
    mcpDetailPermission.textContent = `Quyền Yêu Cầu: ${(tool.permissions || ['read']).join(', ')}`;
  }
  if (mcpSchemaCode) {
    try {
      mcpSchemaCode.textContent = JSON.stringify(tool.inputSchema || {}, null, 2);
    } catch {
      mcpSchemaCode.textContent = String(tool.inputSchema);
    }
  }
  // Seed the invoke box with a params skeleton built from required schema fields so a
  // one-field tool is one keystroke from runnable; optional fields stay out of it.
  if (mcpInvokeParams) {
    const schema = (tool.inputSchema && typeof tool.inputSchema === 'object') ? tool.inputSchema as { required?: unknown[]; properties?: Record<string, { type?: string; default?: unknown }> } : {};
    const required = Array.isArray(schema.required) ? schema.required.filter((f): f is string => typeof f === 'string') : [];
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
    const skeleton: Record<string, unknown> = {};
    for (const field of required) {
      const prop = props[field] || {};
      skeleton[field] = prop.default !== undefined ? prop.default : prop.type === 'number' || prop.type === 'integer' ? 0 : prop.type === 'boolean' ? false : prop.type === 'array' ? [] : prop.type === 'object' ? {} : '';
    }
    mcpInvokeParams.value = JSON.stringify(skeleton, null, 2);
  }
  if (mcpInvokeResult) {
    mcpInvokeResult.style.display = 'none';
    mcpInvokeResult.textContent = '';
    mcpInvokeResult.classList.remove('is-error');
  }
  if (btnRunMcpTool) {
    btnRunMcpTool.disabled = false;
  }
}

let isMcpToolRunning = false;
async function runSelectedMcpTool() {
  const tool = hubSelectedMcpTool;
  if (!tool || isMcpToolRunning || !mcpInvokeResult) return;
  let params: Record<string, unknown> = {};
  const rawParams = (mcpInvokeParams?.value || '').trim();
  if (rawParams) {
    try {
      const parsed: unknown = JSON.parse(rawParams);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        mcpInvokeResult.style.display = 'block';
        mcpInvokeResult.classList.add('is-error');
        mcpInvokeResult.textContent = 'Params phải là một JSON object {…}';
        return;
      }
      params = parsed as Record<string, unknown>;
    } catch (err: unknown) {
      mcpInvokeResult.style.display = 'block';
      mcpInvokeResult.classList.add('is-error');
      mcpInvokeResult.textContent = `JSON không hợp lệ: ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
  }

  const risk = String((tool.permissions && tool.permissions[0]) || 'read');
  let confirmRisk = false;
  if (risk !== 'read') {
    confirmRisk = await showConfirmDialog(`Tool '${tool.name}' có quyền '${risk.toUpperCase()}' — sẽ tác động tab/workspace hiện tại. Chạy luôn?`);
    if (!confirmRisk) return;
  }

  isMcpToolRunning = true;
  if (btnRunMcpTool) btnRunMcpTool.disabled = true;
  mcpInvokeResult.style.display = 'block';
  mcpInvokeResult.classList.remove('is-error');
  mcpInvokeResult.textContent = `Đang chạy ${tool.name}…`;
  try {
    const res = await getApi()?.invokeMcpTool?.({ name: tool.name, params, confirmRisk });
    if (!res) {
      mcpInvokeResult.classList.add('is-error');
      mcpInvokeResult.textContent = 'IPC invokeMcpTool không khả dụng.';
      return;
    }
    if (res.ok) {
      mcpInvokeResult.classList.remove('is-error');
      mcpInvokeResult.textContent = typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? null, null, 2);
    } else {
      mcpInvokeResult.classList.add('is-error');
      mcpInvokeResult.textContent = `${res.error?.code || 'ERROR'}: ${res.error?.message || 'Unknown error'}`;
    }
  } catch (err: unknown) {
    mcpInvokeResult.classList.add('is-error');
    mcpInvokeResult.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    isMcpToolRunning = false;
    if (btnRunMcpTool) btnRunMcpTool.disabled = false;
  }
}

async function runActiveWorkflow() {
  if (!hubSelectedWorkflow || isWorkflowRunning) return;
  isWorkflowRunning = true;

  if (btnRunWorkflow) btnRunWorkflow.style.display = 'none';
  if (btnStopWorkflow) btnStopWorkflow.style.display = 'flex';
  if (hubRunStatusBar) hubRunStatusBar.style.display = 'flex';
  if (runStatusPill) {
    runStatusPill.className = 'hub-status-pill pill-running';
    runStatusPill.textContent = 'RUNNING';
  }
  if (runCurrentStepText) runCurrentStepText.textContent = 'Bắt đầu khởi chạy workflow...';
  if (hubProgressBar) {
    hubProgressBar.style.width = '0%';
    hubProgressBar.style.backgroundColor = '';
  }

  const steps = hubSelectedWorkflow.definition?.steps || [];
  activeRun = {
    workflowId: String(hubSelectedWorkflow.id),
    totalSteps: steps.length,
    completedSteps: 0,
    stepStatuses: {},
    artifacts: [],
  };
  steps.forEach((s: { id?: string }, idx: number) => {
    const stepId = String(s.id || idx);
    const run = activeRun;
    if (run) run.stepStatuses[stepId] = { status: 'pending', attempts: 0 };
    applyStepStatusToDom(stepId, 'pending');
  });
  projectActiveRunProgress();

  runStartTime = Date.now();
  clearInterval(runTimerInterval);
  runTimerInterval = setInterval(() => {
    const elapsed = ((Date.now() - runStartTime) / 1000).toFixed(1);
    if (runTimerText) runTimerText.textContent = `${elapsed}s`;
  }, 100);

  try {
    const res = await getApi()?.runWorkflow({ workflowId: hubSelectedWorkflow.id, workflowDef: hubSelectedWorkflow.definition });
    if (res) {
      const isPassed = res.status === 'passed';
      const isCompletedWithErrors = res.status === 'completed_with_errors';
      const isBlocked = res.status === 'blocked' || (res.ok === false && res.error === 'FORBIDDEN_SENDER');
      if (runStatusPill) {
        if (isPassed) {
          runStatusPill.className = 'hub-status-pill pill-passed';
          runStatusPill.textContent = 'PASSED (100%)';
        } else if (isCompletedWithErrors) {
          runStatusPill.className = 'hub-status-pill pill-interrupted';
          runStatusPill.textContent = 'COMPLETED WITH ERRORS';
        } else if (isBlocked) {
          runStatusPill.className = 'hub-status-pill step-blocked';
          runStatusPill.textContent = 'BLOCKED';
        } else {
          runStatusPill.className = 'hub-status-pill pill-failed';
          runStatusPill.textContent = (res.status || 'FAILED').toUpperCase();
        }
      }
      if (runCurrentStepText) {
        if (isBlocked) {
          runCurrentStepText.textContent = `Bị chặn: ${res.error || 'Precondition refused'}`;
        } else {
          runCurrentStepText.textContent = `Hoàn thành: ${res.passedSteps || 0}/${steps.length} bước thành công (${((res.totalDurationMs || 0) / 1000).toFixed(2)}s)`;
        }
      }
      if (hubProgressBar) {
        hubProgressBar.style.width = '100%';
        if (isBlocked) {
          hubProgressBar.style.backgroundColor = '#f59e0b';
        }
      }

      if (activeRun) {
        activeRun.artifacts = asHubArtifacts(res.artifacts);
        renderActiveRunArtifacts();
      }
      showToolbarToast(isPassed ? '✅ Workflow chạy hoàn tất thành công!' : '⚠️ Workflow kết thúc có lỗi.');
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[workflow] Run failed:', err);
    if (runStatusPill) {
      runStatusPill.className = 'hub-status-pill pill-failed';
      runStatusPill.textContent = 'ERROR';
    }
    if (runCurrentStepText) runCurrentStepText.textContent = `Lỗi: ${message}`;
    showToolbarToast(`❌ Lỗi chạy workflow: ${message}`);
  } finally {
    isWorkflowRunning = false;
    if (runTimerInterval) {
      clearInterval(runTimerInterval);
      runTimerInterval = null;
    }
    if (btnRunWorkflow) btnRunWorkflow.style.display = 'flex';
    if (btnStopWorkflow) btnStopWorkflow.style.display = 'none';
  }
}

async function stopActiveWorkflow() {
  try {
    await getApi()?.abortWorkflow();
    showToolbarToast('⏹ Đã yêu cầu dừng Workflow.');
  } catch (err) {
    console.error('[workflow] Failed to abort:', err);
  }
}
function hostname(u: string): string {
  try {
    return new URL(u).hostname || u;
  } catch {
    return u;
  }
}

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let draggedTabId: string | null = null;
// One pending "scroll the active tab into view" frame callback; see renderTabs().
let activeTabScrollRaf = 0;
let lastTabsSignature = '';
let lastBookmarksSignature = '';
let lastChromeProfileName = '';
let lastAppliedDevicePresetId: string | null = null;
let lastAppliedSplitMode: boolean | null = null;
let lastAppliedSplitDesktopPresetId: string | null = null;
let lastAppliedSplitMobilePresetId: string | null = null;
let lastAppliedSplitFocusedPane: string | null = null;
let lastAppliedZoomText = '';
let lastAppliedBackDisabled: boolean | null = null;
let lastAppliedForwardDisabled: boolean | null = null;
let lastAppliedAgentControlled: boolean | null = null;

function computeTabsSignature(tabs: AntiFanTab[], activeId: string): string {
  // The scope itself is part of the signature: a project switch that keeps the same
  // shared tab active would otherwise produce an identical signature and the strip
  // would keep showing the previous project's rows.
  let sig = `${stripProjectScope ?? ''}:${activeId}:${tabs.length}`;
  for (let i = 0; i < tabs.length; i++) {
    const t = tabs[i];
    if (!t) continue;
    sig += `;${t.id},${t.title || ''},${t.url || ''},${t.favicon || ''},${t.isLoading ? 1 : 0},${t.themeError || ''},${t.isAudible ? 1 : 0},${t.isMuted ? 1 : 0},${t.aiState || ''},${t.isAgentControlled ? 1 : 0},${t.hibernated ? 1 : 0}`;
  }
  return sig;
}

function computeBookmarksSignature(bookmarks: Array<{ id?: string; title?: string; url: string }>, activeTab: AntiFanTab | undefined): string {
  const activeUrl = activeTab ? (activeTab.url || '') : '';
  // isBookmarkBarVisible must be part of the signature: toggling the bar changes
  // neither bookmarks nor activeTab, so without it renderBookmarks() is skipped
  // and the bar stays hidden while the host expands the strip by 28px.
  let sig = `${activeUrl}:${isBookmarkBarVisible ? 1 : 0}:${bookmarks.length}`;
  for (let i = 0; i < bookmarks.length; i++) {
    const b = bookmarks[i];
    if (b) sig += `;${b.url}`;
  }
  return sig;
}

/**
 * Child refs of one tab element, resolved once per element.
 *
 * The strip re-renders on every state broadcast and its signature includes `title`,
 * so a retitling page drives this at up to 5 Hz; before the cache, each pass re-queried
 * seven children per tab with attribute/class selectors (~210 DOM queries/s on a six-tab
 * strip). A WeakMap keeps the refs with the element, so a closed tab's entry dies with it.
 */
interface TabElementRefs {
  indexBadge: HTMLElement | null;
  spinner: HTMLElement | null;
  icon: HTMLImageElement | null;
  statusDot: HTMLElement | null;
  titleSpan: HTMLElement | null;
  audioBtn: HTMLButtonElement | null;
  agentBadge: HTMLElement | null;
}

const tabRefsCache = new WeakMap<HTMLElement, TabElementRefs>();

function cacheTabRefs(tabEl: HTMLElement): TabElementRefs {
  const refs: TabElementRefs = {
    indexBadge: tabEl.querySelector<HTMLElement>('.tab-index-badge'),
    spinner: tabEl.querySelector<HTMLElement>('.tab-spinner'),
    icon: tabEl.querySelector<HTMLImageElement>('.tab-icon'),
    statusDot: tabEl.querySelector<HTMLElement>('.tab-status-dot'),
    titleSpan: tabEl.querySelector<HTMLElement>('.tab-title'),
    audioBtn: tabEl.querySelector<HTMLButtonElement>('.tab-audio-btn'),
    agentBadge: tabEl.querySelector<HTMLElement>('.tab-agent-badge'),
  };
  tabRefsCache.set(tabEl, refs);
  return refs;
}

/**
 * The tabs the strip renders: the presented project's own rows plus shared
 * (unstamped) ones when the web identity carries a definite scope, every row
 * otherwise. renderTabs paints it and the pushState signature compares on it,
 * so the two must read the same set — the filter lives exactly once.
 */
function visibleStripTabs(): AntiFanTab[] {
  return stripProjectScope
    ? currentTabs.filter((tab) => !tab.projectId || tab.projectId === stripProjectScope)
    : currentTabs;
}

function renderTabs() {
  if (!tabList) return;
  // The web hub presents one project at a time: only its tabs plus the shared
  // (unstamped) ones render. Filtering is a strip concern — `currentTabs` still
  // holds the full inventory for the url/active lookups elsewhere. Fail-open:
  // with no definite scope every tab renders.
  const visibleTabs = visibleStripTabs();
  lastTabsSignature = computeTabsSignature(visibleTabs, activeTabId);

  const currentTabIds = new Set(visibleTabs.map((t) => t.id));
  
  // 1. Remove closed tabs
  Array.from(tabList.children).forEach((child) => {
    const tabId = child.getAttribute('data-tab-id');
    if (tabId && !currentTabIds.has(tabId)) {
      child.remove();
    }
  });

  // One pass over the surviving children replaces a per-tab attribute query: the
  // strip re-renders on every broadcast, so that lookup ran for every tab each time.
  const tabElById = new Map<string, HTMLElement>();
  for (const child of Array.from(tabList.children)) {
    const tabId = child.getAttribute('data-tab-id');
    if (tabId) tabElById.set(tabId, child as HTMLElement);
  }

  // 2. Update or insert tabs
  visibleTabs.forEach((tab, index) => {
    // The condition below guarantees an element: every current tab is either already in
    // the map or created and appended in this iteration. The assertion keeps the type
    // the previous per-tab `querySelector(...) as HTMLElement` gave its closures.
    let tabEl = tabElById.get(tab.id) as HTMLElement;
    const isActive = tab.id === activeTabId;

    if (!tabEl) {
      tabEl = document.createElement('div');
      tabEl.setAttribute('data-tab-id', tab.id);
      tabEl.setAttribute('role', 'tab');
      tabEl.setAttribute('draggable', 'true');
      
      tabEl.innerHTML = `
        <span class="tab-index-badge">#${index + 1}</span>
        <span class="tab-spinner" style="display:none;"></span>
        <img class="tab-icon" src="" alt=""/>
        <span class="tab-title"></span>
        <span class="tab-agent-badge" style="display:none;">🤖 AGENT</span>
        <button type="button" class="tab-audio-btn" style="display:none;" title="Tắt tiếng website — lựa chọn được lưu cho website này" aria-label="Tắt tiếng website" aria-pressed="false" disabled></button>
        <span class="tab-status-dot done" title="Ready"></span>
        <span class="tab-close" title="Close Tab"></span>
      `;

      const closeBtn = tabEl.querySelector('.tab-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        });
        closeBtn.addEventListener('mousedown', (e) => {
          e.stopPropagation();
        });
      }

      tabEl.querySelector('.tab-audio-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          if (!(await getApi()?.toggleMute(tab.id))) {
            showToolbarToast('Không thể lưu lựa chọn âm thanh cho website này.');
          }
        } catch (err) {
          console.error('[antifan toolbar] Failed to update website mute:', err);
          showToolbarToast('Không thể lưu lựa chọn âm thanh cho website này.');
        }
      });

      tabEl.addEventListener('click', (e) => {
        const target = e.target as HTMLElement | null;
        if (target && target.closest('.tab-close, .tab-audio-btn')) return;
        hideTabContextMenu();
        getApi()?.switchTab(tab.id);
      });
      tabEl.addEventListener('keydown', (e) => {
        if (e.target !== tabEl) return;
        const tabs = Array.from(tabList.querySelectorAll<HTMLElement>('.tab'));
        const currIdx = tabs.indexOf(tabEl);
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          const nextTab = tabs[(currIdx + 1) % tabs.length];
          nextTab?.focus();
          const nextId = nextTab?.getAttribute('data-tab-id');
          if (nextId) getApi()?.switchTab(nextId);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevTab = tabs[(currIdx - 1 + tabs.length) % tabs.length];
          prevTab?.focus();
          const prevId = prevTab?.getAttribute('data-tab-id');
          if (prevId) getApi()?.switchTab(prevId);
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          getApi()?.switchTab(tab.id);
        } else if (e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        }
      });

      tabEl.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          e.stopPropagation();
          getApi()?.closeTab(tab.id);
        }
      });

      tabEl.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showTabContextMenu(e.clientX, e.clientY, tab.id);
      });

      // Drag and Drop Tab Reordering
      tabEl.addEventListener('dragstart', (e) => {
        draggedTabId = tab.id;
        tabEl.classList.add('tab-dragging');
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', tab.id);
        }
      });

      tabEl.addEventListener('dragend', () => {
        draggedTabId = null;
        document.querySelectorAll('.tab').forEach((el) => {
          el.classList.remove('tab-dragging', 'drag-over');
        });
      });

      tabEl.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) {
          e.dataTransfer.dropEffect = 'move';
        }
        if (draggedTabId && draggedTabId !== tab.id) {
          tabEl.classList.add('drag-over');
        }
      });

      tabEl.addEventListener('dragleave', () => {
        tabEl.classList.remove('drag-over');
      });

      tabEl.addEventListener('drop', (e) => {
        e.preventDefault();
        tabEl.classList.remove('drag-over');
        if (!draggedTabId || draggedTabId === tab.id) return;
        
        const toIndex = currentTabs.findIndex((t) => t.id === tab.id);
        if (toIndex !== -1) {
          getApi()?.moveTab(draggedTabId, toIndex);
        }
      });

      tabList.appendChild(tabEl);
    }

    // Sync tab position if reordered
    if (tabList.children[index] !== tabEl) {
      tabList.insertBefore(tabEl, tabList.children[index] || null);
    }
    // Update classes & aria
    const isAiStreaming = tab.aiState === 'streaming' || tab.aiState === 'thinking';
    const isAiCompleted = tab.aiState === 'completed';
    const isAgentWorking = tab.aiState === 'agent_working';
    const isAgentControlled = tab.isAgentControlled === true;
    const hasThemeError = Boolean(tab.themeError);
    const isHibernated = tab.hibernated === true;

    // The strip re-renders on every state broadcast — a page that retitles itself drives this at
    // up to 5 Hz — and most of the properties below already hold the value being written. An
    // unchanged attribute write is not free: it replaces the attribute value and invalidates
    // style, which is what this path was paying per broadcast for a title that had moved and
    // nothing else. Compare first, as `titleSpan` below and the `lastApplied*` controls do.
    const nextTabClassName = `tab ${isActive ? 'active' : ''} ${isAgentControlled ? 'agent-controlled' : ''} ${isAgentWorking ? 'agent-working' : isAiStreaming ? 'ai-streaming' : ''} ${hasThemeError ? 'tab-has-error' : ''} ${isHibernated ? 'hibernated' : ''}`;
    if (tabEl.className !== nextTabClassName) tabEl.className = nextTabClassName;
    const nextAriaSelected = isActive ? 'true' : 'false';
    if (tabEl.getAttribute('aria-selected') !== nextAriaSelected) tabEl.setAttribute('aria-selected', nextAriaSelected);
    if (isActive) {
      // Keep the active tab on screen: with a hidden scrollbar an off-screen active tab
      // is invisible, which makes switching to a later tab look like it did nothing.
      // Coalesced to one pending callback: the strip re-renders on every state broadcast
      // (a retitling page drives it at up to 5 Hz), and an uncancelled schedule per render
      // retains that render's closure — this element, the tab payload it captured, and the
      // per-render Map/Set — for as long as the frame loop is stalled. Cancelling first also
      // scrolls the element of the latest render rather than a superseded one.
      if (activeTabScrollRaf) cancelAnimationFrame(activeTabScrollRaf);
      activeTabScrollRaf = requestAnimationFrame(() => {
        activeTabScrollRaf = 0;
        try { tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch {}
      });
    }
    const nextTabIndex = isActive ? '0' : '-1';
    if (tabEl.getAttribute('tabindex') !== nextTabIndex) tabEl.setAttribute('tabindex', nextTabIndex);
    // Update Spinner & Icon
    const refs = tabRefsCache.get(tabEl) || cacheTabRefs(tabEl);
    const indexBadge = refs.indexBadge;
    if (indexBadge) {
      const badgeText = `#${index + 1}`;
      if (indexBadge.textContent !== badgeText) indexBadge.textContent = badgeText;
      const badgeTitle = `Tab #${index + 1} (ID: ${tab.id}) - Nhấp chuột phải để sao chép cho Agent`;
      if (indexBadge.title !== badgeTitle) indexBadge.title = badgeTitle;
    }
    const spinner = refs.spinner;
    const icon = refs.icon;
    const statusDot = refs.statusDot;
    const titleSpan = refs.titleSpan;
    const audioBtn = refs.audioBtn;
    const agentBadge = refs.agentBadge;
    if (agentBadge) {
      const badgeDisplay = isAgentControlled ? 'inline-flex' : 'none';
      if (agentBadge.style.display !== badgeDisplay) agentBadge.style.display = badgeDisplay;
      const badgeClass = isAgentWorking ? 'tab-agent-badge working' : 'tab-agent-badge';
      const badgeLabel = isAgentWorking ? '⚡ AGENT' : '🤖 AGENT';
      // Class and label move together, so the class is the value that decides whether the pair
      // is written at all.
      if (agentBadge.className !== badgeClass) {
        agentBadge.className = badgeClass;
        agentBadge.textContent = badgeLabel;
      }
    }
    // Update Audio & Mute State
    if (audioBtn) {
      const audioDisplay = tab.isAudible || tab.isMuted ? 'inline-flex' : 'none';
      if (audioBtn.style.display !== audioDisplay) audioBtn.style.display = audioDisplay;
      const pressed = String(!!tab.isMuted);
      if (audioBtn.getAttribute('aria-pressed') !== pressed) audioBtn.setAttribute('aria-pressed', pressed);
      if (tab.isAudible || tab.isMuted) {
        let canMute = false;
        try {
          const url = new URL(tab.url);
          canMute = (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname.replace(/\.+$/, '');
        } catch {
          // Internal and invalid URLs have no website preference.
        }
        if (audioBtn.disabled !== !canMute) audioBtn.disabled = !canMute;
        const audioTitle = canMute
          ? `${tab.isMuted ? 'Bật' : 'Tắt'} tiếng website — lựa chọn được lưu cho website này`
          : 'Tắt tiếng theo website chỉ hỗ trợ HTTP/HTTPS — lựa chọn được lưu cho website này';
        if (audioBtn.title !== audioTitle) audioBtn.title = audioTitle;
        const audioClass = tab.isMuted ? 'tab-audio-btn muted' : 'tab-audio-btn playing';
        if (audioBtn.className !== audioClass) {
          audioBtn.className = audioClass;
          audioBtn.innerHTML = tab.isMuted
            ? `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`
            : `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>`;
        }
      }
    }


    if (hasThemeError) {
      if (spinner && spinner.style.display !== 'none') spinner.style.display = 'none';
      if (icon && icon.style.display !== 'inline-block') icon.style.display = 'inline-block';
      if (statusDot) {
        if (statusDot.style.display !== 'inline-block') statusDot.style.display = 'inline-block';
        if (statusDot.className !== 'tab-status-dot theme-error') {
          statusDot.className = 'tab-status-dot theme-error';
          statusDot.title = `⚠️ Lỗi Theme: ${tab.themeError}`;
        }
      }
    } else if (isHibernated) {
      // Sleeping tab: renderer freed, only the record survives — reduced strip
      // presentation (title + favicon, dimmed) and a marker dot instead of the
      // spinner. Clicking the tab wakes it through the host's ensureTabAwake.
      if (spinner && spinner.style.display !== 'none') spinner.style.display = 'none';
      if (icon) {
        if (icon.style.display !== 'inline-block') icon.style.display = 'inline-block';
        const nextIconSrc =
          tab.favicon ||
          'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
        if (icon.getAttribute('src') !== nextIconSrc) icon.src = nextIconSrc;
      }
      if (statusDot) {
        if (statusDot.style.display !== 'inline-block') statusDot.style.display = 'inline-block';
        if (statusDot.className !== 'tab-status-dot hibernated') {
          statusDot.className = 'tab-status-dot hibernated';
          statusDot.title = '💤 Tab đang ngủ để tiết kiệm bộ nhớ — bấm để đánh thức';
        }
      }
    } else if (tab.isLoading) {
      if (spinner && spinner.style.display !== 'inline-block') spinner.style.display = 'inline-block';
      if (icon && icon.style.display !== 'none') icon.style.display = 'none';
      if (statusDot) {
        if (statusDot.style.display !== 'inline-block') statusDot.style.display = 'inline-block';
        if (statusDot.className !== 'tab-status-dot loading') {
          statusDot.className = 'tab-status-dot loading';
          statusDot.title = 'Đang tải trang...';
        }
      }
    } else {
      if (spinner && spinner.style.display !== 'none') spinner.style.display = 'none';
      if (icon) {
        if (icon.style.display !== 'inline-block') icon.style.display = 'inline-block';
        // Re-assigning `src` restarts the image load even when the URL is unchanged, which is a
        // decode and a repaint per broadcast for a favicon that did not move.
        const nextIconSrc =
          tab.favicon ||
          'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="%2394a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>';
        if (icon.getAttribute('src') !== nextIconSrc) icon.src = nextIconSrc;
      }
      if (statusDot) {
        if (isAgentWorking) {
          if (statusDot.style.display !== 'inline-block') statusDot.style.display = 'inline-block';
          if (statusDot.className !== 'tab-status-dot agent-working') {
            statusDot.className = 'tab-status-dot agent-working';
            statusDot.title = '🤖 AI Agent đang điều phối tab này!';
          }
        } else if (isAiStreaming) {
          if (statusDot.style.display !== 'inline-block') statusDot.style.display = 'inline-block';
          if (statusDot.className !== 'tab-status-dot ai-streaming') {
            statusDot.className = 'tab-status-dot ai-streaming';
            statusDot.title = '⚡ AI đang phản hồi...';
          }
        } else if (isAiCompleted) {
          if (statusDot.style.display !== 'inline-block') statusDot.style.display = 'inline-block';
          if (statusDot.className !== 'tab-status-dot ai-completed') {
            statusDot.className = 'tab-status-dot ai-completed';
            statusDot.title = '✓ AI đã phản hồi xong!';
          }
        } else {
          if (statusDot.style.display !== 'none') statusDot.style.display = 'none';
          if (statusDot.className !== 'tab-status-dot') statusDot.className = 'tab-status-dot';
          if (statusDot.title !== '') statusDot.title = '';
        }
      }
    }
    const baseTitle = tab.title || hostname(tab.url) || 'New Tab';
    if (titleSpan && titleSpan.textContent !== baseTitle) {
      titleSpan.textContent = baseTitle;
    }
  });
}

function updateControls() {
  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  if (btnMute) {
    let canMute = false;
    try {
      if (activeTab?.url) {
        const url = new URL(activeTab.url);
        canMute = (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname.replace(/\.+$/, '');
      }
    } catch {
      // Internal and invalid URLs have no website preference.
    }
    const isMuted = canMute && !!activeTab?.isMuted;
    if (btnMute.disabled !== !canMute) btnMute.disabled = !canMute;
    if (btnMute.classList.contains('muted') !== isMuted) btnMute.classList.toggle('muted', isMuted);
    const pressed = String(isMuted);
    if (btnMute.getAttribute('aria-pressed') !== pressed) btnMute.setAttribute('aria-pressed', pressed);
    const muteTitle = canMute
      ? `${isMuted ? 'Bật' : 'Tắt'} tiếng website — lựa chọn được lưu cho website này`
      : 'Tắt tiếng theo website chỉ hỗ trợ HTTP/HTTPS — lựa chọn được lưu cho website này';
    if (btnMute.title !== muteTitle) btnMute.title = muteTitle;
  }
  if (activeTab) {
    if (document.activeElement !== urlInput && urlInput) {
      const targetUrl = activeTab.url === 'about:blank' ? '' : activeTab.url;
      if (urlInput.value !== targetUrl) {
        urlInput.value = targetUrl;
      }
    }
    const canGoBack = !activeTab.canGoBack;
    if (btnBack && lastAppliedBackDisabled !== canGoBack) {
      lastAppliedBackDisabled = canGoBack;
      btnBack.disabled = canGoBack;
    }
    const canGoForward = !activeTab.canGoForward;
    if (btnForward && lastAppliedForwardDisabled !== canGoForward) {
      lastAppliedForwardDisabled = canGoForward;
      btnForward.disabled = canGoForward;
    }
    
    const pct = `${Math.round(activeTab.zoomFactor * 100)}%`;
    if (zoomLabel && pct !== lastAppliedZoomText) {
      lastAppliedZoomText = pct;
      zoomLabel.textContent = pct;
    }

    if (deviceSelect) {
      const presetId = activeTab.devicePresetId || '';
      if (presetId !== lastAppliedDevicePresetId) {
        lastAppliedDevicePresetId = presetId;
        deviceSelect.querySelectorAll('option[value^="custom-"]').forEach((o) => o.remove());
        if (presetId && /^custom-\d+x\d+$/i.test(presetId)) {
          const m = /^custom-(\d+)x(\d+)$/i.exec(presetId);
          const opt = document.createElement('option');
          opt.value = presetId;
          opt.disabled = true;
          opt.textContent = m ? `Custom (${m[1]}×${m[2]})` : presetId;
          deviceSelect.appendChild(opt);
        }
        if (presetId) {
          deviceSelect.value = presetId;
        }
      }
    }
    const isSplit = !!activeTab.splitMode;
    if (isSplit !== lastAppliedSplitMode) {
      lastAppliedSplitMode = isSplit;
      if (isSplit) {
        if (btnToggleSplit) btnToggleSplit.classList.add('mode-active');
        if (splitControlsContainer) splitControlsContainer.style.display = 'flex';
        if (deviceSelect) deviceSelect.style.display = 'none';
      } else {
        if (btnToggleSplit) btnToggleSplit.classList.remove('mode-active');
        if (splitControlsContainer) splitControlsContainer.style.display = 'none';
        if (deviceSelect) deviceSelect.style.display = 'inline-block';
      }
    }
    if (isSplit) {
      if (splitDesktopSelect && activeTab.splitDesktopPresetId && activeTab.splitDesktopPresetId !== lastAppliedSplitDesktopPresetId) {
        lastAppliedSplitDesktopPresetId = activeTab.splitDesktopPresetId;
        splitDesktopSelect.value = activeTab.splitDesktopPresetId;
      }
      if (splitMobileSelect && activeTab.splitMobilePresetId && activeTab.splitMobilePresetId !== lastAppliedSplitMobilePresetId) {
        lastAppliedSplitMobilePresetId = activeTab.splitMobilePresetId;
        splitMobileSelect.value = activeTab.splitMobilePresetId;
      }
      const focusedPane = activeTab.splitFocusedPane || 'desktop';
      if (focusedPane !== lastAppliedSplitFocusedPane) {
        lastAppliedSplitFocusedPane = focusedPane;
        if (btnSplitFocusDesktop) btnSplitFocusDesktop.classList.toggle('active', focusedPane === 'desktop');
        if (btnSplitFocusMobile) btnSplitFocusMobile.classList.toggle('active', focusedPane === 'mobile');
      }
    }

    const isAgent = !!activeTab.isAgentControlled;
    if (agentActiveBadge && isAgent !== lastAppliedAgentControlled) {
      lastAppliedAgentControlled = isAgent;
      agentActiveBadge.style.display = isAgent ? 'inline-flex' : 'none';
    }
  }
  if (btnClearOmnibox && urlInput) {
    btnClearOmnibox.style.display = urlInput.value ? 'block' : 'none';
  }

  if (btnQuickInspect) {
    if (isInspecting) btnQuickInspect.classList.add('mode-active');
    else btnQuickInspect.classList.remove('mode-active');
  }

  if (btnFontFinder) {
    if (isFontFinderActive) btnFontFinder.classList.add('mode-active');
    else btnFontFinder.classList.remove('mode-active');
  }
  const menuItemFontFinder = document.getElementById('menuItemFontFinder');
  if (menuItemFontFinder) {
    if (isFontFinderActive) menuItemFontFinder.classList.add('mode-active');
    else menuItemFontFinder.classList.remove('mode-active');
  }
  const menuItemGpuLens = document.getElementById('menuItemGpuLens');
  if (menuItemGpuLens) {
    if (isLensActive) menuItemGpuLens.classList.add('mode-active');
    else menuItemGpuLens.classList.remove('mode-active');
  }
}

const bookmarkBar = document.getElementById('bookmarkBar') as HTMLElement | null;
const bookmarkItems = document.getElementById('bookmarkItems') as HTMLElement | null;
const btnStarBookmark = document.getElementById('btnStarBookmark') as HTMLButtonElement | null;

function renderBookmarks() {
  const activeTab = currentTabs.find((t) => t.id === activeTabId);
  lastBookmarksSignature = computeBookmarksSignature(currentBookmarks, activeTab);
  const isBookmarked = activeTab && currentBookmarks.some((b) => b.url === activeTab.url);
  if (btnStarBookmark) {
    btnStarBookmark.classList.toggle('active', !!isBookmarked);
    if (isBookmarked) {
      btnStarBookmark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>`;
    } else {
      btnStarBookmark.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2.866 14.85c-.078.444.36.791.746.593l4.39-2.256 4.389 2.256c.386.198.824-.149.746-.592l-.83-4.73 3.522-3.356c.33-.314.16-.888-.282-.95l-4.898-.696L8.465.792a.513.513 0 0 0-.927 0L5.354 5.12l-4.898.696c-.441.062-.612.636-.283.95l3.523 3.356-.83 4.73zm4.905-2.767-3.686 1.894.694-3.957a.565.565 0 0 0-.163-.505L1.71 6.745l4.052-.576a.525.525 0 0 0 .393-.288L8 2.223l1.847 3.658a.525.525 0 0 0 .393.288l4.052.575-2.906 2.77a.565.565 0 0 0-.163.506l.694 3.957-3.686-1.895a.5.5 0 0 0-.461 0z"/></svg>`;
    }
  }
  // Mirror main-side rule: bar shows only when toggled on AND bookmarks exist
  // (toolbarHeight already accounts for it — native-tab-host.ts toolbarHeight).
  const showBar = isBookmarkBarVisible && currentBookmarks.length > 0;
  if (bookmarkBar) {
    bookmarkBar.style.display = showBar ? 'flex' : 'none';
  }
  document.documentElement.style.setProperty('--bookmark-bar-offset', showBar ? '28px' : '0px');
  if (bookmarkItems) {
    bookmarkItems.innerHTML = '';
    for (const b of currentBookmarks) {
      const el = document.createElement('button');
      el.className = 'bookmark-item';
      el.textContent = b.title || b.url;
      el.title = b.url;
      el.addEventListener('click', () => getApi()?.navigate?.(b.url));
      bookmarkItems.appendChild(el);
    }
  }
}


// Navigation Listeners
if (btnNewTab) btnNewTab.addEventListener('click', () => getApi()?.createTab());
if (btnBack) btnBack.addEventListener('click', () => getApi()?.goBack());
if (btnForward) btnForward.addEventListener('click', () => getApi()?.goForward());
if (btnReload) {
  btnReload.title = 'Reload page (Ctrl+R) • Right-click or Ctrl+Alt+R for Reload Window';
  btnReload.addEventListener('click', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) {
      getApi()?.reloadWindow();
    } else {
      getApi()?.reload();
    }
  });
  btnReload.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    getApi()?.reloadWindow();
  });
}
if (btnMute) {
  btnMute.addEventListener('click', async () => {
    if (btnMute.disabled || !activeTabId) return;
    try {
      if (!(await getApi()?.toggleMute(activeTabId))) {
        showToolbarToast('Không thể lưu lựa chọn âm thanh cho website này.');
      }
    } catch (err) {
      console.error('[antifan toolbar] Failed to update website mute:', err);
      showToolbarToast('Không thể lưu lựa chọn âm thanh cho website này.');
    }
  });
}

if (btnStarBookmark) {
  btnStarBookmark.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (!activeTab || !activeTab.url || activeTab.url === 'about:blank') return;
    const isBookmarked = currentBookmarks.some((b) => b.url === activeTab.url);
    if (isBookmarked) {
      getApi()?.removeBookmark(activeTab.url);
      showToolbarToast('⭐ Đã xóa dấu trang');
    } else {
      getApi()?.addBookmark(activeTab.title || activeTab.url, activeTab.url);
      showToolbarToast('⭐ Đã lưu dấu trang thành công');
    }
  });
}

// Device Viewport
if (deviceSelect) {
  deviceSelect.addEventListener('change', () => {
    getApi()?.setDevicePreset(deviceSelect.value);
  });
}
// Split Review Controls
if (btnToggleSplit) {
  btnToggleSplit.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    const nextEnabled = !(activeTab && activeTab.splitMode);
    getApi()?.toggleSplitReview(activeTabId, nextEnabled);
  });
}
if (splitDesktopSelect) {
  splitDesktopSelect.addEventListener('change', () => {
    getApi()?.setSplitPreset('desktop', splitDesktopSelect.value, activeTabId);
  });
}
if (splitMobileSelect) {
  splitMobileSelect.addEventListener('change', () => {
    getApi()?.setSplitPreset('mobile', splitMobileSelect.value, activeTabId);
  });
}
if (btnSplitFocusDesktop) {
  btnSplitFocusDesktop.addEventListener('click', () => {
    getApi()?.setSplitFocusedPane('desktop', activeTabId);
  });
}
if (btnSplitFocusMobile) {
  btnSplitFocusMobile.addEventListener('click', () => {
    getApi()?.setSplitFocusedPane('mobile', activeTabId);
  });
}

// Zoom Stepper Controls
if (zoomLabel) {
  zoomLabel.addEventListener('click', () => {
    getApi()?.setZoom(1.0);
  });
}

if (btnZoomInPop) {
  btnZoomInPop.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      getApi()?.setZoom(Math.min(activeTab.zoomFactor + 0.1, 3.0));
    }
  });
}

if (btnZoomOutPop) {
  btnZoomOutPop.addEventListener('click', () => {
    const activeTab = currentTabs.find((t) => t.id === activeTabId);
    if (activeTab) {
      getApi()?.setZoom(Math.max(activeTab.zoomFactor - 0.1, 0.5));
    }
  });
}

// Tools
if (btnThemeQa) {
  btnThemeQa.addEventListener('click', async () => {
    const report = lastThemeQaReport || themeQaState.report;
    if (report && (themeQaState.status === 'pass' || themeQaState.status === 'fail' || themeQaState.status === 'error')) {
      openThemeQaSummary();
      return;
    }
    showToolbarToast('Theme QA: Validating Storefront…');
    const result = await getApi()?.runThemeQa();
    if (result?.report) {
      lastThemeQaReport = result.report;
      renderThemeQa({ ...themeQaState, report: result.report }, result.report);
      openThemeQaSummary();
    } else if (result && !result.ok) {
      themeQaState = { ...themeQaState, status: 'error', error: result.error || 'validation failed' };
      openThemeQaSummary();
    }
  });
}
const btnThemeQaRerun = document.getElementById('btnThemeQaRerun') as HTMLButtonElement | null;
btnThemeQaRerun?.addEventListener('click', async () => {
  showToolbarToast('Theme QA: Re-validating Storefront…');
  const result = await getApi()?.runThemeQa();
  if (result?.report) {
    lastThemeQaReport = result.report;
    renderThemeQa({ ...themeQaState, report: result.report }, result.report);
    openThemeQaSummary();
  } else if (result && !result.ok) {
    themeQaState = { ...themeQaState, status: 'error', error: result.error || 'validation failed' };
    openThemeQaSummary();
  }
});
themeQaClose?.addEventListener('click', () => { if (themeQaOverlay) themeQaOverlay.style.display = 'none'; releaseOverlay('theme-qa'); });
themeQaOverlay?.addEventListener('click', (event) => { if (event.target === themeQaOverlay) { themeQaOverlay.style.display = 'none'; releaseOverlay('theme-qa'); } });

// Theme Studio Cockpit Event Listeners
const tabNavThemeChecklist = document.getElementById('tabNavThemeChecklist');
const tabNavThemeFindings = document.getElementById('tabNavThemeFindings');
const themeTabChecklist = document.getElementById('themeTabChecklist');
const themeTabFindings = document.getElementById('themeTabFindings');

tabNavThemeChecklist?.addEventListener('click', () => {
  tabNavThemeChecklist.classList.add('active');
  tabNavThemeFindings?.classList.remove('active');
  if (themeTabChecklist) themeTabChecklist.style.display = 'flex';
  if (themeTabFindings) themeTabFindings.style.display = 'none';
  // Opening the panel is the moment the user may have switched theme projects
  // behind the same local port, so re-read the workspace instead of trusting the
  // identity cached when the storefront origin was first seen.
  renderThemeStudioChecklist(true);
});

tabNavThemeFindings?.addEventListener('click', () => {
  tabNavThemeFindings.classList.add('active');
  tabNavThemeChecklist?.classList.remove('active');
  if (themeTabFindings) themeTabFindings.style.display = 'flex';
  if (themeTabChecklist) themeTabChecklist.style.display = 'none';
  renderThemeStudioFindings();
});

const phaseFilterBtns = document.querySelectorAll('.phase-filter-btn');
phaseFilterBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    phaseFilterBtns.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    activePhaseFilter = btn.getAttribute('data-page') || btn.getAttribute('data-phase') || 'all';
    renderThemeStudioChecklist();
  });
});

const themeChecklistSearch = document.getElementById('themeChecklistSearch') as HTMLInputElement | null;
themeChecklistSearch?.addEventListener('input', () => {
  checklistSearchQuery = themeChecklistSearch.value;
  renderThemeStudioChecklist();
});

const btnThemeChecklistReset = document.getElementById('btnThemeChecklistReset');
btnThemeChecklistReset?.addEventListener('click', () => {
  if (confirm('Bạn có chắc muốn đặt lại toàn bộ checklist về mặc định ban đầu?')) {
    if (checklistBusy()) return;
    // Reset is a whole-array SAVE of the shared defaults — the store's CAS marks
    // the scope `legacyMigrated`, so dropping the local keys here would only
    // pretend the file cleared them.
    themeChecklist = themeShared().DEFAULT_THEME_CHECKLIST.map((item) => ({ ...item }));
    persistThemeChecklist();
    renderThemeStudioChecklist();
    showToolbarToast('Đã đặt lại checklist về mặc định');
  }
});

const btnThemeExportReport = document.getElementById('btnThemeExportReport');
btnThemeExportReport?.addEventListener('click', () => {
  if (!ensureChecklistScope()) {
    showToolbarToast('Đang xác định storefront và workspace, thử xuất lại sau một nhịp…');
    return;
  }
  // The shared builder renders the identical markdown `theme.cockpit_report`
  // produces — a diff between the two surfaces is impossible by construction.
  const reportText = themeShared().buildChecklistReport(activeChecklistScope, themeChecklist);
  const clipboard = navigator.clipboard;
  if (clipboard?.writeText) {
    clipboard.writeText(reportText).then(() => {
      showToolbarToast('📋 Đã sao chép Báo cáo Tiến độ Markdown vào Clipboard!');
    }).catch(() => {
      console.log(reportText);
      showToolbarToast('📋 Đã in báo cáo Markdown vào Console F12');
    });
  } else {
    console.log(reportText);
    showToolbarToast('📋 Đã in báo cáo Markdown vào Console F12');
  }
});

/* THEME CHECKLIST ITEM CRUD MODAL LOGIC */
let editingItemId: string | null = null;

function openItemEditorDialog(item: ThemeChecklistItem | null = null, defaultPage = 'home') {
  const overlay = document.getElementById('themeItemEditOverlay');
  const titleEl = document.getElementById('themeItemEditTitle');
  const selPage = document.getElementById('itemEditPage') as HTMLSelectElement | null;
  const inputCode = document.getElementById('itemEditCode') as HTMLInputElement | null;
  const inputName = document.getElementById('itemEditName') as HTMLInputElement | null;
  const inputDesc = document.getElementById('itemEditDesc') as HTMLTextAreaElement | null;
  const inputQa = document.getElementById('itemEditQa') as HTMLInputElement | null;
  const inputPath = document.getElementById('itemEditPath') as HTMLInputElement | null;

  if (!overlay || !selPage || !inputCode || !inputName || !inputDesc || !inputQa || !inputPath) return;

  editingItemId = item ? item.id : null;

  const standardPages = ['home', 'collection', 'product', 'cart', 'blog', 'account', 'pages', 'qa-gate'];
  const allPages = Array.from(new Set([...standardPages, ...themeChecklist.map((it) => it.page)]));
  selPage.innerHTML = '';
  allPages.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p;
    const def = themeShared().PAGE_DEFS[p];
    opt.textContent = def ? `${def.icon} ${def.title.split(' (')[0]} (${def.badge})` : `📌 Trang ${p}`;
    selPage.appendChild(opt);
  });

  if (item) {
    if (titleEl) titleEl.textContent = `✏️ Chỉnh sửa: ${item.code} - ${item.name}`;
    selPage.value = item.page;
    inputCode.value = item.code;
    inputName.value = item.name;
    inputDesc.value = item.desc;
    inputQa.value = item.qaPoint;
    inputPath.value = item.pathHint || '';
  } else {
    if (titleEl) titleEl.textContent = '➕ Thêm mục kiểm tra mới';
    const targetPage = (activePhaseFilter !== 'all' && activePhaseFilter !== 'uncompleted' && (themeShared().PAGE_DEFS[activePhaseFilter] || allPages.includes(activePhaseFilter)))
      ? activePhaseFilter
      : defaultPage;
    selPage.value = targetPage;

    const prefixMap: Record<string, string> = {
      home: 'HOM', collection: 'COL', product: 'PDP', cart: 'CRT',
      blog: 'BLG', account: 'ACC', pages: 'SYS', 'qa-gate': 'QAG',
    };
    const prefix = prefixMap[targetPage] || targetPage.slice(0, 3).toUpperCase();
    const existingNums = themeChecklist
      .filter((it) => it.code.startsWith(prefix))
      .map((it) => {
        const m = it.code.match(/\d+/);
        return m ? parseInt(m[0], 10) : 0;
      });
    const nextNum = (existingNums.length > 0 ? Math.max(...existingNums) : 0) + 1;
    inputCode.value = `${prefix}-${String(nextNum).padStart(2, '0')}`;
    inputName.value = '';
    inputDesc.value = '';
    inputQa.value = '';
    inputPath.value = themeShared().PAGE_DEFS[targetPage]?.path || '';
  }

  overlay.style.display = 'flex';
  setTimeout(() => inputName.focus(), 50);
}

function closeItemEditorDialog() {
  const overlay = document.getElementById('themeItemEditOverlay');
  if (overlay) overlay.style.display = 'none';
  editingItemId = null;
}

function saveItemEditorForm() {
  const selPage = document.getElementById('itemEditPage') as HTMLSelectElement | null;
  const inputCode = document.getElementById('itemEditCode') as HTMLInputElement | null;
  const inputName = document.getElementById('itemEditName') as HTMLInputElement | null;
  const inputDesc = document.getElementById('itemEditDesc') as HTMLTextAreaElement | null;
  const inputQa = document.getElementById('itemEditQa') as HTMLInputElement | null;
  const inputPath = document.getElementById('itemEditPath') as HTMLInputElement | null;

  if (!selPage || !inputCode || !inputName || !inputDesc || !inputQa || !inputPath) return;

  const page = selPage.value;
  const name = inputName.value.trim();
  const desc = inputDesc.value.trim();
  const qaPoint = inputQa.value.trim();
  const pathHint = inputPath.value.trim() || undefined;

  if (!name) {
    showToolbarToast('Vui lòng nhập tên mục kiểm tra');
    inputName.focus();
    return;
  }

  if (!qaPoint) {
    showToolbarToast('Vui lòng nhập điểm kiểm tra QA tiêu chuẩn');
    inputQa.focus();
    return;
  }

  const prefixMap: Record<string, string> = {
    home: 'HOM', collection: 'COL', product: 'PDP', cart: 'CRT',
    blog: 'BLG', account: 'ACC', pages: 'SYS', 'qa-gate': 'QAG',
  };
  const code = inputCode.value.trim() || `${prefixMap[page] || page.slice(0, 3).toUpperCase()}-01`;

  if (checklistBusy()) {
    showToolbarToast('Đang đồng bộ checklist, thử lại sau một nhịp…');
    return;
  }

  if (editingItemId) {
    const item = themeChecklist.find((it) => it.id === editingItemId);
    if (item) {
      item.page = page;
      item.code = code;
      item.name = name;
      item.desc = desc;
      item.qaPoint = qaPoint;
      item.pathHint = pathHint;
    }
    showToolbarToast(`Đã cập nhật mục: ${name}`);
  } else {
    const newItem: ThemeChecklistItem = {
      id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      code,
      name,
      desc,
      qaPoint,
      page,
      pathHint,
      done: false,
    };
    themeChecklist.push(newItem);
    showToolbarToast(`Đã thêm mục kiểm tra mới: ${name}`);
  }

  persistThemeChecklist();
  renderThemeStudioChecklist();
  closeItemEditorDialog();
}

const btnThemeItemAdd = document.getElementById('btnThemeItemAdd');
btnThemeItemAdd?.addEventListener('click', () => openItemEditorDialog(null, 'home'));

const btnItemEditSave = document.getElementById('btnItemEditSave');
btnItemEditSave?.addEventListener('click', saveItemEditorForm);

const btnItemEditCancel = document.getElementById('btnItemEditCancel');
btnItemEditCancel?.addEventListener('click', closeItemEditorDialog);

const themeItemEditClose = document.getElementById('themeItemEditClose');
themeItemEditClose?.addEventListener('click', closeItemEditorDialog);

const themeItemEditOverlay = document.getElementById('themeItemEditOverlay');
themeItemEditOverlay?.addEventListener('click', (e) => {
  if (e.target === themeItemEditOverlay) closeItemEditorDialog();
});

const itemEditPageSelect = document.getElementById('itemEditPage') as HTMLSelectElement | null;
itemEditPageSelect?.addEventListener('change', () => {
  if (editingItemId) return;
  const p = itemEditPageSelect.value;
  const prefixMap: Record<string, string> = {
    home: 'HOM', collection: 'COL', product: 'PDP', cart: 'CRT',
    blog: 'BLG', account: 'ACC', pages: 'SYS', 'qa-gate': 'QAG',
  };
  const prefix = prefixMap[p] || p.slice(0, 3).toUpperCase();
  const existingNums = themeChecklist
    .filter((it) => it.code.startsWith(prefix))
    .map((it) => {
      const m = it.code.match(/\d+/);
      return m ? parseInt(m[0], 10) : 0;
    });
  const nextNum = (existingNums.length > 0 ? Math.max(...existingNums) : 0) + 1;
  const inputCode = document.getElementById('itemEditCode') as HTMLInputElement | null;
  const inputPath = document.getElementById('itemEditPath') as HTMLInputElement | null;
  if (inputCode) inputCode.value = `${prefix}-${String(nextNum).padStart(2, '0')}`;
  if (inputPath && !inputPath.value) inputPath.value = themeShared().PAGE_DEFS[p]?.path || '';
});


const btnVpQuicks = document.querySelectorAll('.btn-vp-quick');
btnVpQuicks.forEach((btn) => {
  btn.addEventListener('click', () => {
    const preset = btn.getAttribute('data-preset');
    if (preset) {
      getApi()?.setDevicePreset(preset);
      showToolbarToast(`Chuyển Viewport: ${preset}`);
    }
  });
});

/**
 * True once this renderer session has actually seen an attached phone.
 *
 * It is the difference between "the phone was here and something broke" (worth an amber badge) and
 * "this host has no phone" (worth nothing at all). An unanswered usbmuxd is indistinguishable from an
 * absent phone, so the badge only appears once attachment has been observed for real.
 */
let sawPhoneConnected = false;

function renderPhoneStatus(status: ToolbarPhoneStatus | null | undefined) {
  if (!btnPhoneStatus || !phoneStatusText) return;
  lastPhoneStatus = status || null;
  const connected = status?.state === 'connected';
  if (connected) sawPhoneConnected = true;

  if (!status || status.state === 'disconnected') {
    btnPhoneStatus.style.display = 'none';
    btnPhoneStatus.classList.remove('phone-wda-offline', 'phone-offline');
  } else if (connected) {
    const displayName = status.name || status.model || 'iPhone';
    btnPhoneStatus.style.display = 'inline-flex';
    btnPhoneStatus.classList.remove('phone-wda-offline', 'phone-offline');
    btnPhoneStatus.title = [`${displayName} Connected`, status.osVersion ? `iOS ${status.osVersion}` : undefined, 'USB']
      .filter(Boolean)
      .join(' • ');
    phoneStatusText.textContent = `${displayName} Connected`;
  } else {
    const displayName = status.name || status.model || 'iPhone';
    btnPhoneStatus.style.display = sawPhoneConnected ? 'inline-flex' : 'none';
    btnPhoneStatus.classList.remove('phone-offline');
    btnPhoneStatus.classList.toggle('phone-wda-offline', sawPhoneConnected);
    btnPhoneStatus.title = `${displayName} • usbmuxd chưa phản hồi (bấm để xem chi tiết)`;
    phoneStatusText.textContent = `${displayName} (Muxer Offline)`;
  }

  // The badge above is cheap and always applies. The panel body is a full HTML
  // parse plus a subtree rebuild, and the state broadcast calls this on every push:
  // while the panel is closed that parse was invisible work five times a second. A
  // panel that IS on screen still re-renders, including on disconnect, so an open
  // panel can never keep showing "🟢 Đã kết nối" for a phone that was unplugged —
  // and openPhoneStatusModal() renders once more before it shows.
  if (phoneStatusOverlay?.style.display === 'flex') {
    renderPhoneModalContent(status || null);
  }
}

function renderPhoneModalContent(status: ToolbarPhoneStatus | null) {
  if (!phoneStatusBody) return;
  const detail = status?.detail ? escapeHtml(status.detail) : '';
  if (!status || status.state === 'disconnected') {
    phoneStatusBody.innerHTML = `
      <div style="text-align:center;padding:24px 0;color:#94a3b8;">
        <div style="font-size:32px;margin-bottom:8px;">🔌</div>
        <div>Không phát hiện thiết bị iPhone nào cắm qua USB.</div>
        <div style="font-size:11px;margin-top:6px;color:#64748b;">Hãy cắm cáp USB và mở khóa màn hình iPhone.</div>
      </div>
    `;
    return;
  }
  if (status.state === 'unknown') {
    phoneStatusBody.innerHTML = `
      <div style="text-align:center;padding:24px 0;color:#eab308;">
        <div style="font-size:32px;margin-bottom:8px;">⚠️</div>
        <div style="font-weight:600;font-size:14px;color:#facc15;">Chưa đọc được trạng thái thiết bị</div>
        <div style="font-size:12px;margin-top:8px;color:#94a3b8;line-height:1.5;">
          ${detail || 'Cổng kết nối usbmuxd (tcp:27015) chưa phản hồi.'}
        </div>
        <div style="font-size:11px;margin-top:12px;color:#64748b;">
          Hãy đảm bảo iTunes đang chạy ngầm hoặc bấm <strong>"🔄 Làm mới"</strong> ở góc trên.
        </div>
      </div>
    `;
    return;
  }
  // Every value below is device-reported. When the device did not report one, the panel says so rather
  // than substituting a default that would read as an observation.
  const name = status.name ? escapeHtml(status.name) : 'Chưa xác định';
  const model = status.model ? escapeHtml(status.model) : 'Chưa xác định';
  const osVersion = status.osVersion ? `iOS ${escapeHtml(status.osVersion)}` : 'Chưa xác định';
  const connection = status.connection
    ? (status.connection === 'usb' ? 'Cáp USB vật lý (usbmuxd)' : escapeHtml(status.connection))
    : 'Chưa xác định';

  phoneStatusBody.innerHTML = `
    <div style="margin-bottom:14px;">
      <div class="phone-card-row">
        <span class="phone-card-label">Tên thiết bị</span>
        <span class="phone-card-value">${name}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Model phần cứng</span>
        <span class="phone-card-value">${model}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Phiên bản iOS</span>
        <span class="phone-card-value">${osVersion}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Giao tiếp</span>
        <span class="phone-card-value">${connection}</span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">Trạng thái</span>
        <span class="phone-card-value"><span style="color:#4ade80;font-weight:600;">🟢 Đã kết nối</span></span>
      </div>
      <div class="phone-card-row">
        <span class="phone-card-label">UDID</span>
        <span class="phone-card-value" style="font-size:11px;">${status.deviceId ? escapeHtml(status.deviceId) : 'Chưa cung cấp'}</span>
      </div>
      ${detail ? `
      <div class="phone-card-row" style="margin-top:6px;">
        <span class="phone-card-label">Chi tiết</span>
        <span class="phone-card-value" style="font-size:11px;color:#94a3b8;">${detail}</span>
      </div>` : ''}
    </div>
  `;
}
function openPhoneStatusModal() {
  if (!phoneStatusOverlay) return;
  renderPhoneModalContent(lastPhoneStatus);
  phoneStatusOverlay.style.display = 'flex';
  acquireOverlay('phone-status');
}

function closePhoneStatusModal() {
  if (!phoneStatusOverlay) return;
  phoneStatusOverlay.style.display = 'none';
  releaseOverlay('phone-status');
}

if (btnPhoneStatus) {
  btnPhoneStatus.addEventListener('click', () => {
    openPhoneStatusModal();
  });
}
btnPhoneStatusRefresh?.addEventListener('click', async () => {
  showToolbarToast('Đang kiểm tra kết nối thiết bị...');
  const res = await getApi()?.getPhoneStatus?.(true);
  if (res) renderPhoneStatus(res);
});
phoneStatusClose?.addEventListener('click', () => closePhoneStatusModal());
phoneStatusOverlay?.addEventListener('click', (e) => {
  if (e.target === phoneStatusOverlay) closePhoneStatusModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (projectPickerOverlay?.style.display === 'flex') { answerProjectPicker({ kind: 'cancelled' }); return; }
  if (tabSearchOverlay?.style.display === 'flex') { closeTabSearch(true); return; }
  if (phoneStatusOverlay?.style.display === 'flex') { closePhoneStatusModal(); return; }
  if (tabContextMenu?.classList.contains('active')) { hideTabContextMenu(); return; }
  if (appDropdownMenu?.style.display !== 'none' && appDropdownMenu) { closeAppMenu(); return; }
  if (profileDropdownMenu?.style.display !== 'none' && profileDropdownMenu) { profileDropdownMenu.style.display = 'none'; releaseOverlay('profile-dropdown'); return; }
  if (shortcutsOverlay?.style.display === 'flex') { closeShortcutsOverlay(); return; }
  if (workflowHubOverlay?.style.display === 'flex') { closeWorkflowHub(); return; }
  if (mobileRemoteOverlay?.style.display === 'flex') { closeMobileRemoteModal(); return; }
  if (themeItemEditOverlay?.style.display === 'flex') { closeItemEditorDialog(); return; }
  if (themeQaOverlay?.style.display === 'flex') { themeQaOverlay.style.display = 'none'; releaseOverlay('theme-qa'); return; }
  if (findBar?.style.display === 'flex') { hideFindBar(); return; }
  if (projectChipMenu?.style.display === 'flex') { closeProjectChipMenu(); return; }
  if (omniboxSuggestDropdown?.style.display === 'block') { hideSuggestDropdown(); return; }
});
if (btnQuickInspect) btnQuickInspect.addEventListener('click', () => getApi()?.toggleInspect());
if (btnFontFinder) btnFontFinder.addEventListener('click', () => getApi()?.toggleFontFinder());
if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', () => getApi()?.toggleSidebar());
if (btnPopoutTerminal) btnPopoutTerminal.addEventListener('click', () => getApi()?.popoutTerminal?.());
// (btnRuler/btnDevTools/btnCaptureFullPage listeners removed — elements never existed.)

let lastChromeProfilesSignature = '';

/**
 * The dropdown is rebuilt from `availableChromeProfiles` plus the active profile,
 * and those two are its whole input. The state broadcast calls this on every push
 * (up to 5 Hz), so without a value signature the same subtree and its handlers were
 * reparsed and replaced while the dropdown was closed — thousands of throwaway
 * nodes and closures per hour for a menu nobody had opened.
 */
function computeChromeProfilesSignature(profiles: any[], activeId: string): string {
  let sig = `${activeId}:${profiles.length}`;
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    if (p) sig += `;${p.id || ''},${p.name || ''}`;
  }
  return sig;
}

function renderChromeProfiles() {
  if (profileName) {
    const nextProfileName = activeProfileInfo?.name || 'Default';
    if (profileName.textContent !== nextProfileName) profileName.textContent = nextProfileName;
  }
  if (profileAvatar && profileAvatar.textContent !== '👤') {
    profileAvatar.textContent = '👤';
  }
  if (!profileDropdownList) return;
  const signature = computeChromeProfilesSignature(availableChromeProfiles || [], activeProfileInfo?.id || '');
  if (signature === lastChromeProfilesSignature) return;
  lastChromeProfilesSignature = signature;
  profileDropdownList.innerHTML = '';

  availableChromeProfiles.forEach((p) => {
    const item = document.createElement('div');
    const isActive = activeProfileInfo && activeProfileInfo.id === p.id;
    item.className = `profile-dropdown-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span>👤 ${escapeHtml(p.name || p.id)}</span>
      ${isActive ? '<span style="color:#22c55e;font-size:11px;">● Active</span>' : '<span style="font-size:10px;color:#94a3b8;">Sync</span>'}
    `;
    item.onclick = async () => {
      profileDropdownMenu.style.display = 'none';
      releaseOverlay('profile-dropdown');
      showToolbarToast(`🔄 Đang đồng bộ Chrome Profile: ${p.name || p.id}...`);
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res && res.success !== false) {
        activeProfileInfo = p;
        renderChromeProfiles();
        renderAppMenuProfiles();
        if (res.hasLiveCookies === false && (!res.cookiesCount || res.cookiesCount === 0)) {
          showToolbarToast(`ℹ️ Đã nạp ${res.bookmarksCount || 0} dấu trang, chưa nạp được cookies: ${res?.message || 'Chrome đang bảo vệ cookies (App-Bound Encryption) hoặc đang mở. Hãy đóng hẳn Chrome rồi thử lại, hoặc dùng 💾 Sao lưu / 📥 Khôi phục Session Vault.'}`, 9000);
        } else {
          const cookieNote = res.cookiesCount > 0 ? ` (${res.cookiesCount} cookies, ${res.bookmarksCount || 0} bookmarks)` : '';
          showToolbarToast(`✅ Đã đồng bộ Chrome Profile: ${p.name || p.id}${cookieNote}`, 4000);
        }
      } else {
        showToolbarToast(`⚠️ Không thể đồng bộ: ${res?.message || 'Lỗi profile'}`, 4000);
      }
    };
    profileDropdownList.appendChild(item);
  });
  // Append Session Vault actions to the dropdown
  const divider = document.createElement('div');
  divider.style.height = '1px';
  divider.style.background = 'rgba(255, 255, 255, 0.1)';
  divider.style.margin = '4px 0';
  profileDropdownList.appendChild(divider);

  // Backup Vault Item
  const backupItem = document.createElement('div');
  backupItem.className = 'profile-dropdown-item';
  backupItem.innerHTML = '<span>💾 Sao lưu Session Vault</span><span style="font-size:10px;color:#38bdf8;">Export</span>';
  backupItem.onclick = async () => {
    profileDropdownMenu.style.display = 'none';
    releaseOverlay('profile-dropdown');
    showToolbarToast('🔄 Đang sao lưu session cookies...');
    const res = await getApi()?.exportSessionVault?.();
    if (res?.success) {
      showToolbarToast(`✅ Đã sao lưu ${res.count} cookies vào session-vault.json`, 4000);
    } else {
      showToolbarToast(`⚠️ Lỗi sao lưu: ${res?.error || 'Thất bại'}`, 4000);
    }
  };
  profileDropdownList.appendChild(backupItem);

  // Restore Vault Item
  const restoreItem = document.createElement('div');
  restoreItem.className = 'profile-dropdown-item';
  restoreItem.innerHTML = '<span>📥 Khôi phục Session Vault</span><span style="font-size:10px;color:#4ade80;">Import</span>';
  restoreItem.onclick = async () => {
    profileDropdownMenu.style.display = 'none';
    releaseOverlay('profile-dropdown');
    showToolbarToast('🔄 Đang nạp cookies từ session-vault.json...');
    const res = await getApi()?.importSessionVault?.();
    if (res?.success) {
      showToolbarToast(`✅ Đã khôi phục ${res.importedCount} cookies thành công!`, 4000);
    } else {
      showToolbarToast(`⚠️ Lỗi nạp: ${res?.error || 'Chưa có file session-vault.json'}`, 4000);
    }
  };
  profileDropdownList.appendChild(restoreItem);

}

if (btnChromeProfile) {
  btnChromeProfile.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isHidden = profileDropdownMenu.style.display === 'none';
    if (isHidden) {
      if (appDropdownMenu) { appDropdownMenu.style.display = 'none'; releaseOverlay('app-menu'); }
      // Acquire before the async IPC round-trip: releasing 'app-menu' above can
      // empty the token set, and the queued microtask would collapse the view
      // to strip height only to re-expand when profiles resolve (visible flicker).
      acquireOverlay('profile-dropdown');
      const profiles = await getApi()?.getChromeProfiles();
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
      }
      renderChromeProfiles();
      profileDropdownMenu.style.display = 'flex';
    } else {
      profileDropdownMenu.style.display = 'none';
      releaseOverlay('profile-dropdown');
    }
  });
}

document.addEventListener('click', (e) => {
  if (profileDropdownMenu && profileDropdownMenu.style.display !== 'none') {
    if (!profileDropdownMenu.contains(e.target as Node) && !btnChromeProfile.contains(e.target as Node)) {
      profileDropdownMenu.style.display = 'none';
      releaseOverlay('profile-dropdown');
    }
  }
});

// Modern App Dropdown Menu (Three-dot ⋮)
const appDropdownMenu = document.getElementById('appDropdownMenu') as HTMLElement | null;
const menuProfileSubList = document.getElementById('menuProfileSubList') as HTMLElement | null;
const menuItemSyncProfile = document.getElementById('menuItemSyncProfile') as HTMLElement | null;
const menuProfileContainer = document.getElementById('menuProfileContainer') as HTMLElement | null;

function renderAppMenuProfiles() {
  if (!menuProfileSubList) return;
  if (!availableChromeProfiles || availableChromeProfiles.length === 0) {
    menuProfileSubList.innerHTML = '<div class="profile-sub-item disabled">Không tìm thấy Chrome Profile</div>';
    return;
  }
  menuProfileSubList.innerHTML = '';
  availableChromeProfiles.forEach((p) => {
    const item = document.createElement('div');
    const isActive = activeProfileInfo && activeProfileInfo.id === p.id;
    item.className = `profile-sub-item ${isActive ? 'active' : ''}`;
    item.innerHTML = `
      <span>👤 ${escapeHtml(p.name || p.id)}</span>
      ${isActive ? '<span style="font-size:10px;color:#4ade80;">● Đang dùng</span>' : '<span style="font-size:10px;color:#38bdf8;">Đồng bộ</span>'}
    `;
    item.onclick = async (e) => {
      e.stopPropagation();
      closeAppMenu();
      showToolbarToast(`🔄 Đang đồng bộ Chrome Profile: ${p.name || p.id}...`);
      const res = await getApi()?.syncChromeProfile(p.id);
      if (res && res.success !== false) {
        activeProfileInfo = p;
        renderChromeProfiles();
        if (res.hasLiveCookies === false && (!res.cookiesCount || res.cookiesCount === 0)) {
          showToolbarToast(`ℹ️ Đã nạp ${res.bookmarksCount || 0} dấu trang, chưa nạp được cookies: ${res?.message || 'Chrome đang bảo vệ cookies (App-Bound Encryption) hoặc đang mở. Hãy đóng hẳn Chrome rồi thử lại, hoặc dùng 💾 Sao lưu / 📥 Khôi phục Session Vault.'}`, 9000);
        } else {
          const cookieNote = res.cookiesCount > 0 ? ` (${res.cookiesCount} cookies, ${res.bookmarksCount || 0} bookmarks)` : '';
          showToolbarToast(`✅ Đã đồng bộ Chrome Profile: ${p.name || p.id}${cookieNote}`, 4000);
        }
      } else {
        showToolbarToast(`⚠️ Không thể đồng bộ: ${res?.message || 'Lỗi profile'}`, 4000);
      }
    };
    menuProfileSubList.appendChild(item);
  });
  // Divider
  const appMenuDivider = document.createElement('div');
  appMenuDivider.style.height = '1px';
  appMenuDivider.style.background = 'rgba(255, 255, 255, 0.1)';
  appMenuDivider.style.margin = '4px 0';
  menuProfileSubList.appendChild(appMenuDivider);

}

function closeAppMenu() {
  if (appDropdownMenu && appDropdownMenu.style.display !== 'none') {
    appDropdownMenu.style.display = 'none';
    if (menuProfileContainer) {
      menuProfileContainer.style.display = 'none';
    }
    menuItemSyncProfile?.classList.remove('expanded');
    releaseOverlay('app-menu');
  }
}

async function toggleAppMenu() {
  if (!appDropdownMenu) return;
  const isHidden = appDropdownMenu.style.display === 'none';
  if (isHidden) {
    if (profileDropdownMenu) { profileDropdownMenu.style.display = 'none'; releaseOverlay('profile-dropdown'); }
    
    // Pre-fetch Chrome profiles asynchronously
    getApi()?.getChromeProfiles().then((profiles) => {
      if (profiles && Array.isArray(profiles)) {
        availableChromeProfiles = profiles;
        renderChromeProfiles();
        renderAppMenuProfiles();
      }
    }).catch(() => {});

    renderAppMenuProfiles();
    appDropdownMenu.style.display = 'flex';
    acquireOverlay('app-menu');
  } else {
    closeAppMenu();
  }
}

if (btnMenu && appDropdownMenu) {
  btnMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAppMenu();
  });
}

if (menuItemSyncProfile) {
  menuItemSyncProfile.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!menuProfileContainer) return;
    const isExpanded = menuProfileContainer.style.display !== 'none';
    if (isExpanded) {
      menuProfileContainer.style.display = 'none';
      menuItemSyncProfile.classList.remove('expanded');
    } else {
      if (!availableChromeProfiles || availableChromeProfiles.length === 0) {
        const profiles = await getApi()?.getChromeProfiles();
        if (profiles && Array.isArray(profiles)) {
          availableChromeProfiles = profiles;
          renderChromeProfiles();
        }
      }
      renderAppMenuProfiles();
      menuProfileContainer.style.display = 'block';
      menuItemSyncProfile.classList.add('expanded');
    }
  });
}

// App Menu Items Clicks
document.getElementById('menuItemCheckUpdates')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.checkUpdates?.();
});
document.getElementById('menuItemBookmarkTab')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  const star = document.getElementById('btnStarBookmark');
  if (star) star.click();
});

document.getElementById('menuItemToggleBookmarksBar')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleBookmarkBar();
});

document.getElementById('menuItemShowMenuBar')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.showMenuBar?.();
});

document.getElementById('menuItemFindInPage')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  showFindBar();
});

document.getElementById('menuItemQuickInspect')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleInspect();
});

document.getElementById('menuItemFontFinder')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleFontFinder();
});

document.getElementById('menuItemGpuLens')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleLens();
});

document.getElementById('menuItemScreenshot')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.captureViewport().then(async (dataUrl) => {
    if (!dataUrl) {
      showToolbarToast('⚠️ Chụp màn hình thất bại');
      return;
    }
    // captureViewport returns a base64 data URL — write the decoded PNG binary
    // to the clipboard so paste targets receive an image, not raw base64 text.
    try {
      const blob = await (await fetch(dataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
      showToolbarToast('📸 Đã sao chép ảnh chụp màn hình vào Clipboard!');
    } catch {
      // ClipboardItem/image write unsupported (e.g. permission or platform) —
      // fall back to text so the capture is still retrievable.
      try {
        await navigator.clipboard.writeText(dataUrl);
        showToolbarToast('📸 Đã sao chép ảnh (dạng text base64)');
      } catch {
        showToolbarToast('📸 Đã chụp màn hình (clipboard không khả dụng)');
      }
    }
  }).catch(() => {
    showToolbarToast('⚠️ Chụp màn hình thất bại');
  });
});

document.getElementById('menuItemOpenSystemBrowser')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.openExternal();
});

document.getElementById('menuItemDevTools')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  getApi()?.toggleDevTools();
});

document.getElementById('menuItemClearStorage')?.addEventListener('click', async (e) => {
  e.stopPropagation();
  closeAppMenu();
  const clearRes = await getApi()?.clearStorage();
  if (clearRes && clearRes.success !== false) {
    showToolbarToast('Đã xóa Cookies & Cache của trang này');
  } else {
    showToolbarToast(`⚠️ Không thể xóa: chỉ hỗ trợ trang http(s). ${clearRes?.reason || ''}`, 5000);
  }
});

document.getElementById('menuItemShortcuts')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  openShortcutsOverlay();
});
function openShortcutsOverlay() {
  if (!shortcutsOverlay) return;
  acquireOverlay('shortcuts');
  shortcutsOverlay.style.display = 'flex';
}

function closeShortcutsOverlay() {
  if (!shortcutsOverlay) return;
  shortcutsOverlay.style.display = 'none';
  releaseOverlay('shortcuts');
}

if (shortcutsClose) shortcutsClose.addEventListener('click', closeShortcutsOverlay);
if (shortcutsOverlay) {
  shortcutsOverlay.addEventListener('click', (e) => {
    if (e.target === shortcutsOverlay) closeShortcutsOverlay();
  });
}

async function openMobileRemoteModal() {
  if (!mobileRemoteOverlay) return;
  acquireOverlay('mobile-remote');
  mobileRemoteOverlay.style.display = 'flex';

  try {
    const info = await (getApi() as any)?.getMobileRemoteInfo?.();
    if (info) {
      if (mobileRemoteQrContainer && info.qrSvg) {
        mobileRemoteQrContainer.innerHTML = info.qrSvg;
      }
      if (mobileRemoteUrlsList && Array.isArray(info.urls)) {
        mobileRemoteUrlsList.innerHTML = '';
        info.urls.forEach((url: string) => {
          const item = document.createElement('div');
          item.className = 'mobile-url-item';
          item.innerHTML = `
            <span class="mobile-url-text">${escapeHtml(url)}</span>
            <button class="btn-copy-url">Sao chép</button>
          `;
          item.querySelector('.btn-copy-url')?.addEventListener('click', (e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(url);
            showToolbarToast('📋 Đã sao chép liên kết Mobile Remote!');
          });
          mobileRemoteUrlsList.appendChild(item);
        });
      }
    }
  } catch (e) {
    console.error('Failed to load mobile remote info', e);
  }
}

function closeMobileRemoteModal() {
  if (!mobileRemoteOverlay) return;
  mobileRemoteOverlay.style.display = 'none';
  releaseOverlay('mobile-remote');
}

// menuItemMobileRemote (app menu) is the opener — btnMobileRemote never existed in toolbar.html.
document.getElementById('menuItemMobileRemote')?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  openMobileRemoteModal();
});
if (mobileRemoteClose) {
  mobileRemoteClose.addEventListener('click', closeMobileRemoteModal);
}
if (mobileRemoteOverlay) {
  mobileRemoteOverlay.addEventListener('click', (e) => {
    if (e.target === mobileRemoteOverlay) closeMobileRemoteModal();
  });
}

// (Legacy menu* ids — menuFind/menuQuickAnnotate/menuFontFinder/menuLens/menuOpenBrowser/menuShortcuts —
//  do not exist in toolbar.html; their listeners were dead code and have been removed.)

// Close menus when clicking outside
// TAB CONTEXT MENU
const tabContextMenu = document.getElementById('tabContextMenu') as HTMLDivElement | null;
const menuItemNewTabRight = document.getElementById('menuItemNewTabRight');
const menuItemDuplicateTab = document.getElementById('menuItemDuplicateTab');
const menuItemReloadTab = document.getElementById('menuItemReloadTab');
const menuItemCopyUrl = document.getElementById('menuItemCopyUrl');
const menuItemCopyTabId = document.getElementById('menuItemCopyTabId');
const menuItemCloseTab = document.getElementById('menuItemCloseTab');
const menuItemCloseOtherTabs = document.getElementById('menuItemCloseOtherTabs');
const menuItemCloseTabsToRight = document.getElementById('menuItemCloseTabsToRight');

let contextMenuTargetTabId: string | null = null;

function hideTabContextMenu() {
  if (!tabContextMenu) return;
  tabContextMenu.classList.remove('active');
  tabContextMenu.style.display = 'none';
  contextMenuTargetTabId = null;
  releaseOverlay('tab-context');
}

function showTabContextMenu(x: number, y: number, tabId: string) {
  if (!tabContextMenu) return;
  contextMenuTargetTabId = tabId;

  const tabIndex = currentTabs.findIndex((t) => t.id === tabId);
  const totalTabs = currentTabs.length;

  if (menuItemCloseOtherTabs) {
    if (totalTabs <= 1) {
      menuItemCloseOtherTabs.classList.add('disabled');
    } else {
      menuItemCloseOtherTabs.classList.remove('disabled');
    }
  }

  if (menuItemCloseTabsToRight) {
    if (tabIndex === -1 || tabIndex >= totalTabs - 1) {
      menuItemCloseTabsToRight.classList.add('disabled');
    } else {
      menuItemCloseTabsToRight.classList.remove('disabled');
    }
  }

  acquireOverlay('tab-context');
  tabContextMenu.style.display = 'flex';
  tabContextMenu.classList.add('active');

  const menuWidth = 210;
  const maxX = window.innerWidth - menuWidth - 8;
  const targetX = Math.max(8, Math.min(x, maxX));
  const targetY = Math.max(4, y);

  tabContextMenu.style.left = `${targetX}px`;
  tabContextMenu.style.top = `${targetY}px`;
}

if (menuItemNewTabRight) {
  menuItemNewTabRight.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const idx = currentTabs.findIndex((t) => t.id === contextMenuTargetTabId);
      getApi()?.createTab('https://www.google.com').then((newId: string) => {
        if (newId && idx !== -1) {
          getApi()?.moveTab(newId, idx + 1);
        }
      });
    }
    hideTabContextMenu();
  });
}

if (menuItemDuplicateTab) {
  menuItemDuplicateTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.duplicateTab(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemReloadTab) {
  menuItemReloadTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.reload(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCopyUrl) {
  menuItemCopyUrl.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const targetTab = currentTabs.find((t) => t.id === contextMenuTargetTabId);
      if (targetTab && targetTab.url) {
        navigator.clipboard.writeText(targetTab.url).then(() => {
          showToolbarToast('Đã sao chép liên kết tab');
        }).catch(() => {});
      }
    }
    hideTabContextMenu();
  });
}
if (menuItemCopyTabId) {
  menuItemCopyTabId.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      const targetTab = currentTabs.find((t) => t.id === contextMenuTargetTabId);
      const tabIdx = currentTabs.findIndex((t) => t.id === contextMenuTargetTabId);
      const tabNum = tabIdx !== -1 ? `#${tabIdx + 1}` : '';
      if (targetTab && targetTab.id) {
        navigator.clipboard.writeText(targetTab.id).then(() => {
          showToolbarToast(`📋 Đã chép Tab ID (${tabNum}): ${targetTab.id}`);
        }).catch(() => {
          showToolbarToast(`📋 Tab ID (${tabNum}): ${targetTab.id}`);
        });
      }
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseTab) {
  menuItemCloseTab.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeTab(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseOtherTabs) {
  menuItemCloseOtherTabs.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeOtherTabs(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

if (menuItemCloseTabsToRight) {
  menuItemCloseTabsToRight.addEventListener('click', () => {
    if (contextMenuTargetTabId) {
      getApi()?.closeTabsToRight(contextMenuTargetTabId);
    }
    hideTabContextMenu();
  });
}

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (appDropdownMenu && appDropdownMenu.style.display !== 'none') {
    const path = (e.composedPath && typeof e.composedPath === 'function') ? e.composedPath() : [];
    const isInsideMenu = path.includes(appDropdownMenu) || appDropdownMenu.contains(e.target as Node);
    const isMenuButton = (btnMenu && path.includes(btnMenu)) || e.target === btnMenu;
    if (!isInsideMenu && !isMenuButton) {
      closeAppMenu();
    }
  }

  if (tabContextMenu && !tabContextMenu.contains(e.target as Node)) {
    hideTabContextMenu();
  }
});

// Google Omnibox Suggest Dropdown
const omniboxSuggestDropdown = document.getElementById('omniboxSuggestDropdown') as HTMLDivElement | null;
const omniboxSuggestList = document.getElementById('omniboxSuggestList') as HTMLDivElement | null;

let suggestItems: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> = [];
let selectedSuggestIndex = -1;
let suggestDebounceTimer: any = null;

function hideSuggestDropdown() {
  if (!omniboxSuggestDropdown) return;
  omniboxSuggestDropdown.style.display = 'none';
  selectedSuggestIndex = -1;
  suggestItems = [];
  releaseOverlay('suggest');
}

async function updateSuggestDropdown(query: string) {
  if (!omniboxSuggestDropdown || !omniboxSuggestList) return;
  const q = (query || '').trim();
  try {
    const res = await getApi()?.getSuggestions(q);
    if (res && Array.isArray(res.suggestions) && res.suggestions.length > 0) {
      suggestItems = res.suggestions;
      selectedSuggestIndex = -1;
      renderSuggestItems(q);
      omniboxSuggestDropdown.style.display = 'block';
      acquireOverlay('suggest', 420);
    } else {
      hideSuggestDropdown();
    }
  } catch {
    hideSuggestDropdown();
  }
}

function renderSuggestItems(query: string) {
  if (!omniboxSuggestList) return;
  omniboxSuggestList.innerHTML = '';
  const lowerQ = (query || '').toLowerCase();

  suggestItems.forEach((item, idx) => {
    const el = document.createElement('div');
    el.className = `suggest-item ${idx === selectedSuggestIndex ? 'selected' : ''}`;

    let iconSvg = '';
    if (item.type === 'tab') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="12" height="10" rx="2"/><line x1="2" y1="7" x2="14" y2="7"/></svg>';
    } else if (item.type === 'bookmark') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#f59e0b"><path d="M3.612 15.443c-.386.198-.824-.149-.746-.592l.83-4.73L.173 6.765c-.329-.314-.158-.888.283-.95l4.898-.696L7.538.792c.197-.39.73-.39.927 0l2.184 4.327 4.898.696c.441.062.612.636.282.95l-3.522 3.356.83 4.73c.078.443-.36.79-.746.592L8 13.187l-4.389 2.256z"/></svg>';
    } else if (item.type === 'history') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="#60a5fa" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8 5 8 8 10.5 9.5"/></svg>';
    } else if (item.type === 'url') {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#a78bfa"><path d="M4.715 6.542 3.343 7.914a3 3 0 1 0 4.243 4.243l1.828-1.829A3 3 0 0 0 8.586 5.5L8 6.086a1.002 1.002 0 0 0-.154.199 2 2 0 0 1 .861 3.337L6.88 11.45a2 2 0 1 1-2.83-2.83l.793-.792a4.018 4.018 0 0 1-.128-1.287z"/><path d="M6.586 4.672A3 3 0 0 0 7.414 9.5l.775-.776a2 2 0 0 1-.896-3.346L9.12 3.55a2 2 0 1 1 2.83 2.83l-.793.792c.112.42.155.855.128 1.287l1.372-1.372a3 3 0 1 0-4.243-4.243L6.586 4.672z"/></svg>';
    } else {
      iconSvg = '<svg width="13" height="13" viewBox="0 0 16 16" fill="#9ca3af"><path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/></svg>';
    }

    let matchHtml = escapeHtml(item.text);
    if (lowerQ && item.text.toLowerCase().includes(lowerQ)) {
      const startIdx = item.text.toLowerCase().indexOf(lowerQ);
      const before = item.text.slice(0, startIdx);
      const match = item.text.slice(startIdx, startIdx + lowerQ.length);
      const after = item.text.slice(startIdx + lowerQ.length);
      matchHtml = `${escapeHtml(before)}<b>${escapeHtml(match)}</b>${escapeHtml(after)}`;
    }

    const subText = item.subText || (item.type === 'search' ? 'Google Search' : (item.url ? hostname(item.url) : ''));

    el.innerHTML = `
      <span class="suggest-icon">${iconSvg}</span>
      <div class="suggest-content">
        <span class="suggest-text">${matchHtml}</span>
        ${subText ? `<span class="suggest-subtext">${escapeHtml(subText)}</span>` : ''}
      </div>
    `;

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (item.type === 'tab' && item.tabId) {
        getApi()?.switchTab(item.tabId);
        hideSuggestDropdown();
        return;
      }
      const targetNav = item.url || item.text;
      if (targetNav === 'antifan:command:reload-window') {
        getApi()?.reloadWindow();
        hideSuggestDropdown();
        return;
      }
      if (urlInput) urlInput.value = targetNav;
      getApi()?.navigate(targetNav);
      hideSuggestDropdown();
    });
    omniboxSuggestList.appendChild(el);
  });
}

// Omnibox Event Listeners
if (urlInput) {
  urlInput.addEventListener('input', () => {
    const val = urlInput.value;
    if (btnClearOmnibox) btnClearOmnibox.style.display = val ? 'block' : 'none';
    clearTimeout(suggestDebounceTimer);
    suggestDebounceTimer = setTimeout(() => {
      updateSuggestDropdown(val);
    }, 120);
  });

  urlInput.addEventListener('focus', () => {
    urlInput.select();
    updateSuggestDropdown(urlInput.value);
  });
  urlInput.addEventListener('click', () => {
    if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display === 'none') {
      updateSuggestDropdown(urlInput.value);
    }
  });
  urlInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== urlInput) {
        hideSuggestDropdown();
      }
    }, 200);
  });

  urlInput.addEventListener('keydown', (e) => {
    if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display !== 'none' && suggestItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex + 1) % suggestItems.length;
        renderSuggestItems(urlInput.value);
        const sel = suggestItems[selectedSuggestIndex];
        if (sel) {
          urlInput.value = sel.url || sel.text;
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedSuggestIndex = (selectedSuggestIndex - 1 + suggestItems.length) % suggestItems.length;
        renderSuggestItems(urlInput.value);
        const sel = suggestItems[selectedSuggestIndex];
        if (sel) {
          urlInput.value = sel.url || sel.text;
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideSuggestDropdown();
        return;
      }
    }

    if (e.key === 'Enter') {
      const val = urlInput.value.trim();
      if (val === 'antifan:command:reload-window' || val.toLowerCase() === '> reload window' || val.toLowerCase() === '> reload' || val.toLowerCase() === '> developer: reload window') {
        getApi()?.reloadWindow();
        hideSuggestDropdown();
        urlInput.blur();
        return;
      }
      if (val) {
        if (selectedSuggestIndex >= 0 && selectedSuggestIndex < suggestItems.length) {
          const item = suggestItems[selectedSuggestIndex];
          if (item && item.type === 'tab' && item.tabId) {
            getApi()?.switchTab(item.tabId);
            hideSuggestDropdown();
            urlInput.blur();
            return;
          }
        }
        getApi()?.navigate(val);
        hideSuggestDropdown();
        urlInput.blur();
      }
    }
  });
}

const omniboxEl = document.querySelector('.omnibox') as HTMLDivElement | null;
if (omniboxEl && urlInput) {
  omniboxEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target && target.closest('#btnStarBookmark, #btnClearOmnibox')) return;
    if (document.activeElement !== urlInput) {
      urlInput.focus();
      urlInput.select();
    } else if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display === 'none') {
      updateSuggestDropdown(urlInput.value);
    }
  });
}

document.addEventListener('click', (e) => {
  if (omniboxSuggestDropdown && omniboxSuggestDropdown.style.display !== 'none') {
    if (!omniboxSuggestDropdown.contains(e.target as Node) && e.target !== urlInput) {
      hideSuggestDropdown();
    }
  }
});

if (btnClearOmnibox && urlInput) {
  btnClearOmnibox.addEventListener('click', () => {
    urlInput.value = '';
    urlInput.focus();
    btnClearOmnibox.style.display = 'none';
    hideSuggestDropdown();
  });
}

// Find In Page
function showFindBar() {
  if (!findBar || !findInput) return;
  findBar.style.display = 'flex';
  acquireOverlay('find-bar', 50);
  findInput.focus();
  findInput.select();
  const q = findInput.value.trim();
  if (q) {
    getApi()?.findInPage(q, true, false);
  }
}

function hideFindBar() {
  if (!findBar) return;
  findBar.style.display = 'none';
  if (findCount) findCount.textContent = '0/0';
  getApi()?.stopFindInPage();
  releaseOverlay('find-bar');
}

if (findInput) {
  findInput.addEventListener('input', () => {
    const q = findInput.value.trim();
    if (q) {
      getApi()?.findInPage(q, true, false);
    } else {
      if (findCount) findCount.textContent = '0/0';
      getApi()?.stopFindInPage();
    }
  });

  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const q = findInput.value.trim();
      if (q) {
        getApi()?.findInPage(q, !e.shiftKey, true);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideFindBar();
    }
  });
}

if (findNext && findInput) {
  findNext.addEventListener('click', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, true, true);
  });
}
if (findPrev && findInput) {
  findPrev.addEventListener('click', () => {
    const q = findInput.value.trim();
    if (q) getApi()?.findInPage(q, false, true);
  });
}
if (findClose) {
  findClose.addEventListener('click', hideFindBar);
}

// (Duplicate shortcuts-close listeners removed — the primary pair at ~line 1730
//  already handles close + releaseOverlay('shortcuts').)


async function initToolbar() {
  const api = getApi();
  if (!api) return;

  // Registered before the first `await`: the main process pushes the phone state during bootstrap, and a
  // listener attached after `getInitialState()` resolves can miss that push entirely.
  api.onPhoneStatusChanged?.((status) => {
    renderPhoneStatus(status);
  });

  // Same reason, and the same once-per-renderer rule: a refusal is pushed by Main while the
  // shell it refused is still settling, so a listener attached after the first await can
  // miss the only message that explains why this window is still open.
  closeRefusalUnsubscribe?.();
  closeRefusalUnsubscribe = api.onCloseRefused?.((notice) => renderCloseRefusalNotice(notice)) ?? null;

  try {
    const state = await api.getInitialState();
    if (state) {
      currentTabs = state.tabs || [];
      activeTabId = state.activeTabId || '';
      // Kick off the identity read without blocking the toolbar: a main process
      // that stalls here would freeze tabs, profiles and bookmarks. The checklist
      // paints its pending state until the answer lands.
      void resolveChecklistWorkspace(checklistOrigin());
      if (state.bookmarks) currentBookmarks = state.bookmarks;
      if (state.activeChromeProfile) activeProfileInfo = state.activeChromeProfile;
      if (state.chromeProfiles) availableChromeProfiles = state.chromeProfiles;
      isInspecting = !!state.isInspecting;
      isFontFinderActive = !!state.isFontFinderActive;
      isLensActive = !!state.isLensActive;
      isRulerActive = !!state.isRulerActive;
      isBookmarkBarVisible = !!state.isBookmarkBarVisible;
      if (state.themeQa) renderThemeQa(state.themeQa);
      if ('phoneStatus' in state) renderPhoneStatus(state.phoneStatus as ToolbarPhoneStatus);
      renderProjectWindowIdentity(state.projectWindow);
      renderTabs();
      renderBookmarks();
      renderChromeProfiles();
      updateControls();
    }
  } catch (err) {
    console.error('[antifan toolbar] Failed to load initial state:', err);
  }
  api.onStateUpdated((state: unknown) => {
    if (state && typeof state === 'object') {
      const s = state as Record<string, unknown>;
      currentTabs = (s.tabs as unknown as AntiFanTab[]) || [];
      activeTabId = (s.activeTabId as string) || '';
      if (s.bookmarks) currentBookmarks = s.bookmarks as unknown as Array<{ id: string; title: string; url: string }>;
      if (s.activeChromeProfile) activeProfileInfo = s.activeChromeProfile;
      if (s.chromeProfiles) availableChromeProfiles = s.chromeProfiles as unknown as unknown[];
      isInspecting = !!s.isInspecting;
      isFontFinderActive = !!s.isFontFinderActive;
      isLensActive = !!s.isLensActive;
      isRulerActive = !!s.isRulerActive;
      isBookmarkBarVisible = !!s.isBookmarkBarVisible;
      if (s.themeQa) renderThemeQa(s.themeQa as unknown as ThemeQaState);
      if ('phoneStatus' in s) renderPhoneStatus(s.phoneStatus as ToolbarPhoneStatus);
      // Main may resolve the shell's title after the first paint, so the identity rides
      // the state broadcast too rather than being read once at boot. Presence is the
      // signal — exactly as with `phoneStatus` above: a broadcast that leaves the key out
      // is carrying no identity news and must not blank a chip that is already correct,
      // while an explicit `projectWindow: null` retracts it.
      if ('projectWindow' in s) renderProjectWindowIdentity(s.projectWindow);
      const stripTabs = visibleStripTabs();
      const newTabsSig = computeTabsSignature(stripTabs, activeTabId);
      if (newTabsSig !== lastTabsSignature) {
        renderTabs();
      }

      const activeTab = currentTabs.find((t) => t.id === activeTabId);
      const newBookmarksSig = computeBookmarksSignature(currentBookmarks, activeTab);
      if (newBookmarksSig !== lastBookmarksSignature) {
        renderBookmarks();
      }

      renderChromeProfiles();
      updateControls();
    }
  });
  // THEME_QA_STATE now carries {tabId, state} for every tab, not just the one in
  // front: a cockpit scan bound to another tab must not repaint this badge (F2).
  api.onThemeQaState((frame) => {
    const rec: Record<string, unknown> | null = frame && typeof frame === 'object' ? (frame as Record<string, unknown>) : null;
    if (rec && typeof rec.tabId === 'string' && rec.tabId && rec.tabId !== activeTabId) return;
    const state: unknown = rec && 'state' in rec ? rec.state : frame;
    if (state && typeof state === 'object') renderThemeQa(state as ThemeQaState);
  });

  // Checklist mutations from either surface push {scope, workspaceRoot, items,
  // updatedAt}; adopt matching-scope frames and repaint — never SAVE back, or
  // the broadcast echo would loop.
  api.onThemeChecklistUpdated?.((payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.scope !== activeChecklistScope) return;
    if (payload.workspaceRoot !== checklistWorkspaceRoot) return;
    themeChecklist = sanitizeChecklistItems(payload.items);
    checklistUpdatedAt = typeof payload.updatedAt === 'number' ? payload.updatedAt : checklistUpdatedAt;
    checklistLoadedForScope = activeChecklistScope;
    renderThemeStudioChecklist();
  });

  api.onFocusFind(() => {
    showFindBar();
  });

  api.onFocusOmnibox(() => {
    urlInput.focus();
    urlInput.select();
  });

  api.onShowShortcuts(() => {
    openShortcutsOverlay();
  });

  api.onFindResult((result: any) => {
    if (result && result.matches !== undefined && findCount) {
      findCount.textContent = `${result.activeMatchOrdinal || 0}/${result.matches}`;
    }
  });
  if (api.onScreenshotCaptured) {
    api.onScreenshotCaptured(() => {
      showToolbarToast('📸 Đã sao chép ảnh chụp màn hình vào Clipboard!');
    });
  }

  // Wire Workflow & MCP Hub Events
  btnWorkflowHub?.addEventListener('click', openWorkflowHub);
  btnWorkflowHubClose?.addEventListener('click', closeWorkflowHub);
  workflowHubOverlay?.addEventListener('click', (e) => {
    if (e.target === workflowHubOverlay) closeWorkflowHub();
  });
  tabNavWorkflows?.addEventListener('click', () => setHubTab('workflows'));
  tabNavMcp?.addEventListener('click', () => setHubTab('mcp'));
  tabNavCoreHealth?.addEventListener('click', () => setHubTab('core-health'));
  tabNavBridge?.addEventListener('click', () => setHubTab('bridge'));
  tabNavTaskRuns?.addEventListener('click', () => setHubTab('task-runs'));
  tabNavRootCauses?.addEventListener('click', () => setHubTab('root-causes'));
  tabNavRegressions?.addEventListener('click', () => setHubTab('regressions'));
  tabNavMcpDispatch?.addEventListener('click', () => { setHubTab('mcp-dispatch'); void refreshMcpDispatchState(); });
  btnRunMcpTool?.addEventListener('click', () => { void runSelectedMcpTool(); });
  btnCoreRefresh?.addEventListener('click', async () => {
    await refreshCoreHealthState(true);
    renderHubList();
    if (hubCoreSelected) await renderCoreDetail(hubCoreSelected.id);
  });
  hubSearchInput?.addEventListener('input', () => {
    if (hubSearchClear && hubSearchInput) {
      hubSearchClear.style.display = hubSearchInput.value ? 'inline-block' : 'none';
    }
    renderHubList();
  });
  hubSearchClear?.addEventListener('click', () => {
    if (hubSearchInput) hubSearchInput.value = '';
    if (hubSearchClear) hubSearchClear.style.display = 'none';
    renderHubList();
  });
  btnRunWorkflow?.addEventListener('click', runActiveWorkflow);
  btnStopWorkflow?.addEventListener('click', stopActiveWorkflow);
  btnCopyWorkflowJson?.addEventListener('click', () => {
    if (hubSelectedWorkflow) {
      navigator.clipboard.writeText(JSON.stringify(hubSelectedWorkflow.definition, null, 2));
      showToolbarToast('📋 Đã sao chép kịch bản JSON vào Clipboard!');
    }
  });
  btnDeleteCustomWf?.addEventListener('click', async () => {
    if (hubSelectedWorkflow && !hubSelectedWorkflow.isBuiltIn) {
      const confirmed = await showConfirmDialog(`Xóa kịch bản "${hubSelectedWorkflow.name}"?`);
      if (!confirmed) return;
      await getApi()?.deleteWorkflow(hubSelectedWorkflow.id);
      const res = await getApi()?.getWorkflowState();
      hubWorkflows = res?.workflows || [];
      updateAllHubBadges();
      renderHubList();
      if (hubWorkflows.length > 0) selectWorkflow(hubWorkflows[0]);
      else showHubEmptyDetail();
      showToolbarToast('🗑️ Đã xóa kịch bản custom.');
    }
  });
  btnHubNewWorkflow?.addEventListener('click', async () => {
    const name = await showPromptDialog('Nhập tên Workflow mới:');
    if (!name || !name.trim()) return;
    const description = (await showPromptDialog('Nhập mô tả kịch bản (tùy chọn):')) || '';
    const rawJson = await showPromptDialog(
      'Dán JSON steps (Ctrl+Enter để OK). Để trống dùng mẫu 2 bước:',
      '',
      { multiline: true },
    );
    const defaultSteps = [
      {
        id: 'step-navigate',
        name: 'Mở trang web mục tiêu',
        type: 'browser.navigate' as const,
        params: { url: 'https://example.com' },
        timeoutMs: 8000,
        retryCount: 0,
        continueOnError: false,
      },
      {
        id: 'step-screenshot',
        name: 'Chụp ảnh màn hình kiểm thử',
        type: 'browser.screenshot' as const,
        params: { format: 'png' },
        timeoutMs: 10000,
        retryCount: 0,
        continueOnError: false,
      },
    ];
    let steps: unknown[] = defaultSteps;
    if (rawJson && rawJson.trim()) {
      try {
        const parsed: unknown = JSON.parse(rawJson);
        if (Array.isArray(parsed)) {
          steps = parsed;
        } else if (parsed && typeof parsed === 'object' && 'steps' in parsed && Array.isArray(parsed.steps)) {
          steps = parsed.steps;
        } else {
          showToolbarToast('JSON phải là mảng steps hoặc object có trường steps.');
          return;
        }
      } catch {
        showToolbarToast('JSON không hợp lệ.');
        return;
      }
    }
    const newWf = {
      name: name.trim(),
      description: description.trim(),
      steps,
    };
    try {
      await getApi()?.saveWorkflow(newWf);
      const res = await getApi()?.getWorkflowState();
      hubWorkflows = res?.workflows || [];
      updateAllHubBadges();
      renderHubList();
      const created = hubWorkflows.find((w) => w.name === newWf.name);
      if (created) selectWorkflow(created);
      showToolbarToast('✅ Đã tạo kịch bản Workflow mới!');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      showToolbarToast(`Lỗi tạo workflow: ${message}`);
    }
  });

  if (api.onWorkflowEvent) {
    api.onWorkflowEvent((raw) => {
      if (!raw || typeof raw !== 'object') return;
      const event = raw as {
        type?: string;
        stepId?: string;
        stepName?: string;
        status?: string;
        attempt?: number;
        result?: { artifacts?: unknown[] };
      };
      if (event.type === 'step:start' && event.stepId) {
        if (activeRun) {
          const prev = activeRun.stepStatuses[event.stepId];
          activeRun.stepStatuses[event.stepId] = { status: 'running', attempts: prev?.attempts || 1 };
        }
        applyStepStatusToDom(event.stepId, 'running', activeRun?.stepStatuses[event.stepId]?.attempts || 1);
        if (runCurrentStepText) {
          runCurrentStepText.textContent = `Đang chạy: ${event.stepName || event.stepId}...`;
        }
      } else if (event.type === 'step:retry' && event.stepId) {
        const attempts = Number(event.attempt || ((activeRun?.stepStatuses[event.stepId]?.attempts || 0) + 1));
        if (activeRun) {
          activeRun.stepStatuses[event.stepId] = { status: 'retry', attempts };
        }
        applyStepStatusToDom(event.stepId, 'retry', attempts);
        if (runCurrentStepText) {
          runCurrentStepText.textContent = `Retry ${attempts}: ${event.stepName || event.stepId}...`;
        }
      } else if (event.type === 'step:end' && event.stepId) {
        const status = event.status || 'failed';
        if (activeRun) {
          const prev = activeRun.stepStatuses[event.stepId];
          activeRun.stepStatuses[event.stepId] = { status, attempts: prev?.attempts || 1 };
          if (status === 'passed' || status === 'failed' || status === 'skipped' || status === 'blocked') {
            activeRun.completedSteps = Math.min(activeRun.totalSteps, activeRun.completedSteps + 1);
          }
          projectActiveRunProgress();
        }
        applyStepStatusToDom(event.stepId, status, activeRun?.stepStatuses[event.stepId]?.attempts || 1);
      } else if (event.type === 'workflow:end' && activeRun) {
        activeRun.artifacts = asHubArtifacts(event.result?.artifacts);
        renderActiveRunArtifacts();
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault();
      if (workflowHubOverlay && workflowHubOverlay.style.display === 'flex') {
        closeWorkflowHub();
      } else {
        openWorkflowHub();
      }
    } else if (e.key === 'Escape' && workflowHubOverlay && workflowHubOverlay.style.display === 'flex') {
      closeWorkflowHub();
    }
  });

  let phonePollInFlight = false;
  async function pollPhoneStatus() {
    // The 10s tick, a window focus and a manual refresh coincide routinely; one query at a time keeps a
    // single enumeration per burst instead of three overlapping walks of the USB bus.
    if (phonePollInFlight) return;
    phonePollInFlight = true;
    try {
      const currentApi = getApi();
      const st = await currentApi?.getPhoneStatus?.();
      if (st) renderPhoneStatus(st);
    } catch {
      // The badge is decorative: a failed poll leaves the previous state on screen and the next tick
      // retries. It must never surface as a toolbar error.
    } finally {
      phonePollInFlight = false;
    }
  }
  void pollPhoneStatus();
  setInterval(pollPhoneStatus, 10000);
  window.addEventListener('focus', () => void pollPhoneStatus());
}

// ===========================================================================
// REFUSED CLOSE / QUIT NOTICE
//
// Main decides whether this window or the whole application may close; a refusal arrives
// here as text with the reasons already recorded, and this surface displays it without
// deciding anything. It cannot approve the close, defer it, or offer a way around the
// named work: the reasons point at the existing stop/release actions, and those are shown
// as guidance because not every one of them is invocable from this chrome (an agent
// session is ended where it was started, not from a toolbar button). The latest notice
// replaces the previous one — a stale reason list describes work that is no longer what
// holds the window open.
// ===========================================================================

const closeRefusalNoticeEl = document.getElementById('closeRefusalNotice') as HTMLElement | null;
const closeRefusalTitleEl = document.getElementById('closeRefusalTitle') as HTMLElement | null;
const closeRefusalSummaryEl = document.getElementById('closeRefusalSummary') as HTMLElement | null;
const closeRefusalReasonsEl = document.getElementById('closeRefusalReasons') as HTMLElement | null;
const closeRefusalDismissEl = document.getElementById('closeRefusalDismiss') as HTMLButtonElement | null;

/** This chrome's overlay token: the panel is painted below the strip, which is clipped. */
const CLOSE_REFUSAL_OVERLAY_TOKEN = 'close-refusal';
/**
 * Floor for the strip expansion. A `position: fixed` panel outside a laid-out document
 * measures 0 (jsdom reports no layout at all), and asking for a 0-height expansion would
 * clip the very region this notice exists to show.
 */
const CLOSE_REFUSAL_MIN_HEIGHT = 96;
/** The clipped toolbar strip the overlay expansion is added to (the strip's 74px clip). */
const CLOSE_REFUSAL_STRIP_HEIGHT = 74;

/**
 * This renderer's one refusal-notice subscription. Held so a repeated init replaces the
 * listener instead of stacking a second painter onto the same region.
 */
let closeRefusalUnsubscribe: (() => void) | null = null;

/** A reason as this surface renders it: text to show, and the controls it names. */
interface CloseRefusalReasonView {
  code: string;
  detail: string;
  tabId: string | null;
  controls: Array<{ id: string; label: string }>;
}

interface CloseRefusalView {
  kind: 'close' | 'quit';
  /** Optional override; Main's own notices omit it and fall back to the kind defaults. */
  title?: string;
  summary: string;
  reasons: CloseRefusalReasonView[];
}

/** Only well-formed control entries survive: a label is what the user is shown. */
function toCloseRefusalControls(value: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ id: string; label: string }> = [];
  for (const entry of value) {
    if (!isPlainRecord(entry)) continue;
    if (typeof entry.id !== 'string' || typeof entry.label !== 'string') continue;
    if (entry.label.length === 0) continue;
    out.push({ id: entry.id, label: entry.label });
  }
  return out;
}

/** A reason without its detail is not a reason anyone can act on, so it is dropped. */
function toCloseRefusalReason(value: unknown): CloseRefusalReasonView | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.detail !== 'string' || value.detail.length === 0) return null;
  return {
    code: typeof value.code === 'string' ? value.code : '',
    detail: value.detail,
    tabId: typeof value.tabId === 'string' && value.tabId.length > 0 ? value.tabId : null,
    controls: toCloseRefusalControls(value.controls),
  };
}

/**
 * Read one notice out of an unvalidated message. A payload that is not shaped like a
 * notice reads as null: a message this surface cannot understand must not paint an empty
 * region claiming a close was refused for no stated reason, and must not throw either.
 */
function toCloseRefusalView(value: unknown): CloseRefusalView | null {
  if (!isPlainRecord(value)) return null;
  if (typeof value.summary !== 'string' || !Array.isArray(value.reasons)) return null;
  const reasons: CloseRefusalReasonView[] = [];
  for (const raw of value.reasons) {
    const reason = toCloseRefusalReason(raw);
    if (reason) reasons.push(reason);
  }
  // `title` is optional: Main's own notices omit it and get the close/quit defaults,
  // while renderer-raised notices (e.g. a refused project open) name themselves.
  const title = typeof value.title === 'string' && value.title.length > 0 ? value.title : undefined;
  return { kind: value.kind === 'quit' ? 'quit' : 'close', title, summary: value.summary, reasons };
}

/**
 * The route out of a vetoed close — the one refusal whose text names nothing the user can act on.
 *
 * A page that refuses to unload is never overridden by the shell, so Main's row says only
 * "Page <id> refused to unload" and the close cannot proceed until that page is gone. Closing
 * the tab does destroy it, which makes "close that tab and try again" the instruction that
 * works. The name comes from the strip the user is looking at: Main reports an id, and an id
 * is not something anyone can find. A veto with no tab on the strip still gets the route.
 */
function closeRefusalHint(reason: CloseRefusalReasonView): string {
  if (reason.code !== 'unload-veto') return '';
  const tab = reason.tabId ? currentTabs.find((entry) => entry && entry.id === reason.tabId) : undefined;
  const name = tab ? tab.title || hostname(tab.url || '') : '';
  return name
    ? `Trang "${name}" đang chặn đóng. Đóng tab đó (nút × trên tab) rồi thử đóng lại cửa sổ.`
    : 'Một trang trong cửa sổ này đang chặn đóng. Đóng tab đang chặn (nút × trên tab) rồi thử đóng lại cửa sổ.';
}

/**
 * One reason row: what Main recorded about the blocking work, then the controls it names
 * as guidance. Text only — details carry tab ids, paths and action ids.
 */
function buildCloseRefusalReasonRow(reason: CloseRefusalReasonView): HTMLElement {
  const row = document.createElement('div');
  row.className = 'close-refusal-reason';
  if (reason.code) row.setAttribute('data-reason-code', reason.code);
  if (reason.tabId) {
    row.setAttribute('data-tab-id', reason.tabId);
    const scope = document.createElement('div');
    scope.className = 'close-refusal-reason-scope';
    scope.textContent = `Tab ${reason.tabId}`;
    row.appendChild(scope);
  }
  const detail = document.createElement('div');
  detail.className = 'close-refusal-reason-detail';
  detail.textContent = reason.detail;
  row.appendChild(detail);
  const hint = closeRefusalHint(reason);
  if (hint) {
    const line = document.createElement('div');
    line.className = 'close-refusal-reason-hint';
    line.textContent = hint;
    row.appendChild(line);
  }
  if (reason.controls.length > 0) {
    const controls = document.createElement('div');
    controls.className = 'close-refusal-controls';
    const heading = document.createElement('div');
    heading.className = 'close-refusal-controls-label';
    heading.textContent = 'Xử lý bằng cách:';
    controls.appendChild(heading);
    for (const control of reason.controls) {
      const line = document.createElement('div');
      line.className = 'close-refusal-control';
      line.setAttribute('data-control-id', control.id);
      line.textContent = control.label;
      controls.appendChild(line);
    }
    row.appendChild(controls);
  }
  return row;
}

/** The rows on screen belong to the previous notice; nothing is kept across a replacement. */
function clearCloseRefusalReasons(): void {
  if (!closeRefusalReasonsEl) return;
  while (closeRefusalReasonsEl.firstChild) closeRefusalReasonsEl.removeChild(closeRefusalReasonsEl.firstChild);
}

function hideCloseRefusalNotice(): void {
  if (closeRefusalNoticeEl) closeRefusalNoticeEl.style.display = 'none';
  clearCloseRefusalReasons();
  releaseOverlay(CLOSE_REFUSAL_OVERLAY_TOKEN);
}

/**
 * Paint one refusal notice. Focus is never taken here: the user asked to close a window or
 * quit, and the answer must be readable without pulling them out of whatever they were
 * doing. A malformed payload renders nothing and leaves any notice already on screen alone.
 */
function renderCloseRefusalNotice(raw: unknown): void {
  const notice = toCloseRefusalView(raw);
  if (!notice) return;
  if (!closeRefusalNoticeEl || !closeRefusalSummaryEl || !closeRefusalReasonsEl) return;
  closeRefusalSummaryEl.textContent = notice.summary;
  if (closeRefusalTitleEl) {
    closeRefusalTitleEl.textContent = notice.title ?? (notice.kind === 'quit' ? 'Không thể thoát AntiFan' : 'Không thể đóng cửa sổ này');
  }
  closeRefusalNoticeEl.setAttribute('data-kind', notice.kind);
  clearCloseRefusalReasons();
  for (const reason of notice.reasons) closeRefusalReasonsEl.appendChild(buildCloseRefusalReasonRow(reason));
  if (closeRefusalForceEl) closeRefusalForceEl.style.display = notice.kind === 'close' && getApi()?.forceCloseWindow ? 'inline-flex' : 'none';
  closeRefusalNoticeEl.style.display = 'flex';
  // The panel is fixed below the strip, and the overlay expansion is added to the strip height
  // (see `applyChromeBounds`), so the extra needed is the panel's bottom edge minus the strip.
  const bottom = Math.ceil(closeRefusalNoticeEl.getBoundingClientRect().bottom);
  acquireOverlay(CLOSE_REFUSAL_OVERLAY_TOKEN, Math.max(CLOSE_REFUSAL_MIN_HEIGHT, bottom + 12 - CLOSE_REFUSAL_STRIP_HEIGHT));
}

if (closeRefusalDismissEl) closeRefusalDismissEl.addEventListener('click', hideCloseRefusalNotice);
const closeRefusalForceEl = document.getElementById('closeRefusalForce') as HTMLButtonElement | null;

/** Explicit user action only; the payload carries no owner and Main derives it from sender. */
async function requestForceCloseWindow(): Promise<void> {
  const api = getApi();
  if (!api?.forceCloseWindow || !closeRefusalForceEl || closeRefusalForceEl.disabled) return;
  closeRefusalForceEl.disabled = true;
  try {
    const raw = await api.forceCloseWindow();
    const result = isPlainRecord(raw) ? raw : {};
    if (result.status === 'FAILED') {
      const reason = typeof result.reason === 'string' ? result.reason : 'Không thể bắt buộc đóng cửa sổ này';
      window.alert(reason);
      return;
    }
    if (result.status === 'CLOSED') hideCloseRefusalNotice();
  } finally {
    closeRefusalForceEl.disabled = false;
  }
}

if (closeRefusalForceEl) {
  closeRefusalForceEl.addEventListener('click', () => {
    void requestForceCloseWindow();
  });
}
// Escape dismisses from anywhere in this chrome; the notice never takes focus, so a
// keyboard user has no other way to reach the button.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && closeRefusalNoticeEl && closeRefusalNoticeEl.style.display !== 'none') {
    hideCloseRefusalNotice();
  }
});

// ===========================================================================
// CROSS-PROJECT WINDOW IDENTITY & TAB SEARCH
//
// Two rules drive everything below:
//   1. Identity is display-only. Main resolves titles and paths; this renderer shows
//      them and never lets its own text decide which window or tab a request targets.
//   2. Listing and activation are different acts. Reading the inventory is safe and
//      side-effect free; presenting a foreign window happens only for the exact id the
//      user picked, and only through the activation channel.
// ===========================================================================

const btnTabSearch = document.getElementById('btnTabSearch') as HTMLButtonElement | null;
const tabSearchOverlay = document.getElementById('tabSearchOverlay') as HTMLElement | null;
const tabSearchInput = document.getElementById('tabSearchInput') as HTMLInputElement | null;
const tabSearchResults = document.getElementById('tabSearchResults') as HTMLElement | null;
const tabSearchStatus = document.getElementById('tabSearchStatus') as HTMLElement | null;
const tabSearchClose = document.getElementById('tabSearchClose') as HTMLButtonElement | null;

/** The control the user opened search from; Escape returns focus to it. */
type TabSearchInvoker = Element & { focus?: () => void };

/** A row plus the one piece of state the user can change here: whether it is still real. */
interface TabSearchEntry {
  row: ProjectTabSearchRow;
  unavailable: boolean;
  reason: string;
}

let tabSearchEntries: TabSearchEntry[] = [];
let tabSearchRowElements: HTMLElement[] = [];
let tabSearchActiveIndex = -1;
let tabSearchInvoker: TabSearchInvoker | null = null;
/**
 * Monotonic request id. Each keystroke re-lists, and only the newest answer may paint:
 * an older inventory landing late would resurrect rows the newer query excluded and
 * invite the user to pick a tab they are no longer looking at.
 */
let tabSearchRequestSeq = 0;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate the identity Main reported for this shell. Anything unrecognized reads as
 * "Main has not described this shell" — never as a licence to name one here.
 */
function parseProjectWindowIdentity(source: unknown): ProjectWindowIdentity | null {
  if (!isPlainRecord(source)) return null;
  const owner = source.owner;
  if (!isPlainRecord(owner)) return null;
  let parsedOwner: ProjectWindowIdentity['owner'];
  if (owner.kind === 'project' && typeof owner.projectId === 'string' && owner.projectId) {
    parsedOwner = { kind: 'project', projectId: owner.projectId };
  } else if (owner.kind === 'web') {
    // The web hub presents one project at a time and is where switching happens.
    parsedOwner = { kind: 'web' };
  } else if (owner.kind === 'unassigned') {
    parsedOwner = { kind: 'unassigned' };
  } else {
    return null;
  }
  return {
    owner: parsedOwner,
    title: typeof source.title === 'string' ? source.title : '',
    pathLabel: typeof source.pathLabel === 'string' ? source.pathLabel : undefined,
    // A definite non-empty string is the strip's scope; null/absent means no filter.
    activeProjectId: typeof source.activeProjectId === 'string' && source.activeProjectId ? source.activeProjectId : null,
  };
}

/**
 * The identity the last state broadcast described. Detach/reattach menu items and the
 * chip popover both read it: a detached `project:` shell reattaches, a hub presenting a
 * project detaches it.
 */
let lastProjectIdentity: ProjectWindowIdentity | null = null;

/**
 * Paint the shell's project identity. A duplicate project name is distinguished by the
 * workspace path label, which is also the chip's tooltip.
 */
function renderProjectWindowIdentity(source: unknown) {
  const identity = parseProjectWindowIdentity(source);
  lastProjectIdentity = identity;
  // The strip scope follows the identity's own definite answer (H6): a web hub
  // presenting a project filters to its tabs plus shared ones; a retraction or a
  // shell that is not the hub renders everything rather than hiding tabs behind a
  // stale scope.
  stripProjectScope = identity && identity.owner.kind === 'web' && identity.activeProjectId
    ? identity.activeProjectId
    : null;
  // The chip is the only project label: the tab strip scopes its tabs, the chip names the scope.
  const chip = document.getElementById('projectIdentityChip');
  const nameEl = document.getElementById('projectIdentityName');
  if (!chip || !nameEl) return;
  const showsProject = Boolean(identity && identity.owner.kind !== 'unassigned' && identity.title
    && (identity.owner.kind === 'project' || identity.activeProjectId));
  chip.style.display = showsProject ? 'inline-flex' : 'none';
  chip.classList.toggle('is-detached', identity?.owner.kind === 'project');
  if (identity && showsProject) {
    nameEl.textContent = identity.title;
    chip.title = identity.pathLabel ? `${identity.title} — ${identity.pathLabel}` : identity.title;
  } else {
    nameEl.textContent = '';
    chip.removeAttribute('title');
    closeProjectChipMenu();
  }
  syncProjectMenuItems();
}

/** The project id this chrome may detach/reattach, or null when neither applies. */
function projectActionTarget(): string | null {
  const identity = lastProjectIdentity;
  if (!identity) return null;
  if (identity.owner.kind === 'project') return identity.owner.projectId;
  if (identity.owner.kind === 'web' && identity.activeProjectId) return identity.activeProjectId;
  return null;
}

/** Reflect the identity into the ⋮ menu rows and the chip popover's content. */
function syncProjectMenuItems(): void {
  const detached = lastProjectIdentity?.owner.kind === 'project';
  const hasTarget = projectActionTarget() !== null;
  const detachItem = document.getElementById('menuItemDetachProject');
  const reattachItem = document.getElementById('menuItemReattachProject');
  const divider = document.getElementById('menuProjectDivider');
  if (detachItem) detachItem.style.display = !detached && hasTarget ? '' : 'none';
  if (reattachItem) reattachItem.style.display = detached ? '' : 'none';
  if (divider) divider.style.display = hasTarget ? '' : 'none';
  const badge = document.getElementById('projectChipBadge');
  const title = document.getElementById('projectChipTitle');
  const path = document.getElementById('projectChipPath');
  const moveLabel = document.getElementById('menuProjectMoveLabel');
  if (badge) {
    badge.textContent = detached ? 'DETACHED' : 'HUB';
    badge.classList.toggle('detached', detached);
  }
  if (title) title.textContent = lastProjectIdentity?.title || '';
  if (path) {
    const label = lastProjectIdentity?.pathLabel || '';
    path.style.display = label ? '' : 'none';
    path.textContent = label;
  }
  if (moveLabel) moveLabel.textContent = detached ? 'Gắn lại vào Web Hub' : 'Tách ra cửa sổ riêng';
}

/** Validate one inventory row. A row without an addressable id is dropped, not guessed. */
function toTabSearchRow(raw: unknown): ProjectTabSearchRow | null {
  if (!isPlainRecord(raw)) return null;
  const tabId = typeof raw.tabId === 'string' ? raw.tabId : '';
  if (!tabId) return null;
  return {
    tabId,
    title: typeof raw.title === 'string' ? raw.title : '',
    url: typeof raw.url === 'string' ? raw.url : '',
    ownerLabel: typeof raw.ownerLabel === 'string' ? raw.ownerLabel : '',
    pathLabel: typeof raw.pathLabel === 'string' ? raw.pathLabel : undefined,
    live: raw.live !== false,
  };
}

/**
 * Literal, case-insensitive substring match over title and URL: no regex, no tokenizing,
 * no ranking. It is deliberately not trimmed — a query is taken exactly as typed — and
 * it preserves the inventory order Main returned, so the same query always lists the
 * same tabs in the same order.
 */
function filterTabSearchRows(rows: ProjectTabSearchRow[], query: string): ProjectTabSearchRow[] {
  if (query === '') return rows;
  const needle = query.toLowerCase();
  return rows.filter((row) => row.title.toLowerCase().includes(needle) || row.url.toLowerCase().includes(needle));
}

/** Screen-reader status line: result counts, availability and failures travel here. */
function announceTabSearch(message: string) {
  if (tabSearchStatus) tabSearchStatus.textContent = message;
}

/** The single message row a state with no options to offer shows instead of rows. */
function renderTabSearchState(state: 'loading' | 'empty' | 'no-results' | 'error', message: string) {
  tabSearchEntries = [];
  tabSearchRowElements = [];
  tabSearchActiveIndex = -1;
  if (tabSearchInput) tabSearchInput.removeAttribute('aria-activedescendant');
  if (!tabSearchResults) return;
  tabSearchResults.dataset.state = state;
  tabSearchResults.textContent = '';
  const messageEl = document.createElement('div');
  messageEl.className = 'tab-search-message';
  messageEl.setAttribute('role', 'presentation');
  messageEl.textContent = message;
  tabSearchResults.appendChild(messageEl);
}

/**
 * Row markup is built with createElement/textContent rather than an HTML string: titles
 * and URLs come from pages, and a search surface is exactly where untrusted text would
 * otherwise be re-parsed as markup.
 */
function renderTabSearchRows(options: { preserveActive?: boolean } = {}) {
  if (!tabSearchResults) return;
  tabSearchResults.textContent = '';
  tabSearchRowElements = [];
  for (let i = 0; i < tabSearchEntries.length; i++) {
    const entry = tabSearchEntries[i];
    if (!entry) continue;
    const row = entry.row;
    const el = document.createElement('div');
    el.className = `tab-search-row${entry.unavailable ? ' unavailable' : ''}`;
    el.id = `tabSearchOption${i}`;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', 'false');
    el.setAttribute('data-tab-id', row.tabId);
    el.setAttribute('data-state', entry.unavailable ? 'unavailable' : 'available');
    if (entry.unavailable) el.setAttribute('aria-disabled', 'true');

    const main = document.createElement('div');
    main.className = 'tab-search-row-main';
    const titleEl = document.createElement('span');
    titleEl.className = 'tab-search-row-title';
    // A tab with no title is known by its address; showing an empty line would make two
    // untitled tabs indistinguishable.
    titleEl.textContent = row.title || row.url;
    const urlEl = document.createElement('span');
    urlEl.className = 'tab-search-row-url';
    urlEl.textContent = row.url;
    main.appendChild(titleEl);
    main.appendChild(urlEl);

    const meta = document.createElement('div');
    meta.className = 'tab-search-row-meta';
    const ownerEl = document.createElement('span');
    ownerEl.className = 'tab-search-row-project';
    ownerEl.textContent = row.ownerLabel || 'Unassigned';
    const pathEl = document.createElement('span');
    pathEl.className = 'tab-search-row-path';
    pathEl.textContent = row.pathLabel || '';
    meta.appendChild(ownerEl);
    meta.appendChild(pathEl);
    if (entry.unavailable) {
      const stateEl = document.createElement('span');
      stateEl.className = 'tab-search-row-unavailable';
      stateEl.textContent = entry.reason ? `Không khả dụng: ${entry.reason}` : 'Không khả dụng';
      meta.appendChild(stateEl);
    }

    el.appendChild(main);
    el.appendChild(meta);
    el.addEventListener('mouseenter', () => setActiveTabSearchEntry(i));
    el.addEventListener('click', () => { void activateTabSearchEntry(i); });
    tabSearchResults.appendChild(el);
    tabSearchRowElements.push(el);
  }
  tabSearchResults.dataset.state = tabSearchEntries.length ? 'results' : 'empty';
  // A repaint that follows a failed activation keeps the highlight on the row the user
  // actually picked: moving it to the top row would make one more Enter open a tab the
  // user never chose. Every other repaint starts at the top available row, so Enter can
  // open it — a highlight is a selection the user can see, not an activation they did
  // not ask for.
  if (options.preserveActive && tabSearchActiveIndex >= 0 && tabSearchActiveIndex < tabSearchEntries.length) {
    setActiveTabSearchEntry(tabSearchActiveIndex, false);
    return;
  }
  const firstAvailable = tabSearchEntries.findIndex((entry) => !entry.unavailable);
  setActiveTabSearchEntry(firstAvailable, false);
}

function setActiveTabSearchEntry(index: number, scrollIntoView = true) {
  tabSearchActiveIndex = index;
  if (tabSearchInput) {
    if (index >= 0) tabSearchInput.setAttribute('aria-activedescendant', `tabSearchOption${index}`);
    else tabSearchInput.removeAttribute('aria-activedescendant');
  }
  for (let i = 0; i < tabSearchRowElements.length; i++) {
    const el = tabSearchRowElements[i];
    if (!el) continue;
    const selected = i === index;
    el.setAttribute('aria-selected', selected ? 'true' : 'false');
    el.classList.toggle('active', selected);
  }
  const activeEl = index >= 0 ? tabSearchRowElements[index] : undefined;
  // jsdom has no layout, and a zero-height panel has nothing to scroll: a missing or
  // throwing scrollIntoView must not break the keyboard path.
  if (scrollIntoView && activeEl) {
    try { activeEl.scrollIntoView?.({ block: 'nearest' }); } catch { /* no layout here */ }
  }
}

/** Arrow keys walk available rows only; they never activate anything. */
function moveTabSearchActive(key: string) {
  const available: number[] = [];
  for (let i = 0; i < tabSearchEntries.length; i++) {
    const entry = tabSearchEntries[i];
    if (entry && !entry.unavailable) available.push(i);
  }
  if (!available.length) return;
  let position = available.indexOf(tabSearchActiveIndex);
  if (position < 0) {
    // Nothing highlighted yet: the first arrow starts at the edge it points at.
    position = key === 'ArrowUp' || key === 'End' ? available.length : -1;
  }
  let target = position;
  if (key === 'Home') target = 0;
  else if (key === 'End') target = available.length - 1;
  else if (key === 'ArrowDown') target = Math.min(position + 1, available.length - 1);
  else if (key === 'ArrowUp') target = Math.max(position - 1, 0);
  const targetIndex = target >= 0 ? available[Math.min(target, available.length - 1)] : undefined;
  if (typeof targetIndex === 'number') setActiveTabSearchEntry(targetIndex);
}

/**
 * Read the Main-owned inventory. This never focuses, selects or attaches anything — the
 * only calls it makes are the listing channel and local repaints.
 */
async function requestTabSearch(query: string) {
  const api = getApi();
  const seq = ++tabSearchRequestSeq;

  if (!api?.searchProjectTabs) {
    const message = 'Không tải được danh sách tab: preload thiếu searchProjectTabs';
    renderTabSearchState('error', message);
    announceTabSearch(message);
    return;
  }

  try {
    const result = await api.searchProjectTabs(query);
    if (seq !== tabSearchRequestSeq) return;
    const payload: Record<string, unknown> = isPlainRecord(result) ? result : {};
    if (payload.status !== 'OK') {
      const reason = typeof payload.reason === 'string' && payload.reason ? payload.reason : 'không rõ nguyên nhân';
      const message = `Không tải được danh sách tab: ${reason}`;
      renderTabSearchState('error', message);
      announceTabSearch(message);
      return;
    }
    const inventory = (Array.isArray(payload.rows) ? payload.rows : [])
      .map(toTabSearchRow)
      .filter((row): row is ProjectTabSearchRow => row !== null);
    const matches = filterTabSearchRows(inventory, query);
    if (!matches.length) {
      // Two empty states, not one: an empty inventory is a fresh shell, and a query with
      // no match must read as "your query found nothing", not as "you have no tabs".
      const message = query
        ? `Không có tab nào khớp "${query}"`
        : 'Chưa có tab nào đang mở';
      renderTabSearchState(query ? 'no-results' : 'empty', message);
      announceTabSearch(message);
      return;
    }
    tabSearchEntries = matches.map((row) => ({ row, unavailable: row.live === false, reason: '' }));
    renderTabSearchRows();
    announceTabSearch(query ? `Tìm thấy ${matches.length} tab khớp "${query}"` : `${matches.length} tab đang mở`);
  } catch (err) {
    if (seq !== tabSearchRequestSeq) return;
    const message = `Không tải được danh sách tab: ${err instanceof Error ? err.message : String(err)}`;
    renderTabSearchState('error', message);
    announceTabSearch(message);
  }
}

/**
 * The one place that may present another window, and only for the exact id the user
 * picked. A stale row is marked unavailable in place: nothing else is selected, no
 * neighbouring index is tried and no other project is substituted.
 */
async function activateTabSearchEntry(index: number) {
  const entry = tabSearchEntries[index];
  if (!entry) return;
  if (entry.unavailable) {
    announceTabSearch(`${entry.row.title || entry.row.url || entry.row.tabId} không còn khả dụng${entry.reason ? `: ${entry.reason}` : ''}`);
    return;
  }
  const api = getApi();
  if (!api?.activateProjectTab) {
    announceTabSearch('Không mở được tab: preload thiếu activateProjectTab');
    return;
  }
  try {
    const result = await api.activateProjectTab(entry.row.tabId);
    const payload: Record<string, unknown> = isPlainRecord(result) ? result : {};
    if (payload.status === 'ACTIVATED' && payload.tabId === entry.row.tabId) {
      // Focus now belongs to the window that was just presented; restoring it here would
      // fight the presentation the user asked for.
      closeTabSearch(false);
      return;
    }
    const reason = payload.status === 'UNAVAILABLE' && typeof payload.reason === 'string' && payload.reason
      ? payload.reason
      : payload.status === 'ACTIVATED'
        ? 'main xác nhận một tab khác'
        : 'phản hồi không hợp lệ';
    entry.unavailable = true;
    entry.reason = reason;
    renderTabSearchRows({ preserveActive: true });
    announceTabSearch(`${entry.row.title || entry.row.url || entry.row.tabId} không còn khả dụng: ${reason}`);
  } catch (err) {
    // The list stays on screen so the user can deliberately pick a different row; a
    // failed activation is not a reason to substitute one.
    announceTabSearch(`Không mở được tab: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function openTabSearch(invoker: Element | null) {
  if (!tabSearchOverlay) return;
  tabSearchInvoker = invoker && typeof (invoker as TabSearchInvoker).focus === 'function' ? invoker as TabSearchInvoker : null;
  tabSearchOverlay.style.display = 'flex';
  // The control is a disclosure: its expanded state follows the panel it opened, for
  // screen readers and for the active styling keyed on the attribute.
  btnTabSearch?.setAttribute('aria-expanded', 'true');
  acquireOverlay('tab-search');
  if (tabSearchInput) {
    tabSearchInput.value = '';
    tabSearchInput.removeAttribute('aria-activedescendant');
  }
  renderTabSearchState('loading', 'Đang tải danh sách tab…');
  announceTabSearch('Đang tải danh sách tab…');
  tabSearchInput?.focus();
  await requestTabSearch('');
}

function closeTabSearch(restoreFocus: boolean) {
  if (tabSearchOverlay) {
    tabSearchOverlay.style.display = 'none';
    releaseOverlay('tab-search');
  }
  btnTabSearch?.setAttribute('aria-expanded', 'false');
  // Invalidate any answer still in flight: a closed panel must not repaint later.
  tabSearchRequestSeq++;
  tabSearchEntries = [];
  tabSearchRowElements = [];
  tabSearchActiveIndex = -1;
  if (tabSearchResults) {
    tabSearchResults.textContent = '';
    tabSearchResults.dataset.state = 'idle';
  }
  announceTabSearch('');
  if (tabSearchInput) {
    tabSearchInput.value = '';
    tabSearchInput.removeAttribute('aria-activedescendant');
  }
  const invoker = tabSearchInvoker;
  tabSearchInvoker = null;
  // Escape returns the user to the control search was opened from. A successful
  // activation deliberately does not: focus then belongs to the window just presented.
  if (restoreFocus && invoker && document.contains(invoker)) invoker.focus?.();
}

if (btnTabSearch) {
  btnTabSearch.addEventListener('click', () => { void openTabSearch(btnTabSearch); });
}
// ---------------------------------------------------------------------------
// Project picker, hosted in the toolbar. Main pushes `onProjectOpenPicker` with a requestId
// when the chip (or the menu) asks to open a project; the answer echoes that id back.
// Living here means the terminal sidebar stays exactly as the user left it.
// ---------------------------------------------------------------------------
const projectPickerOverlay = document.getElementById('projectPickerOverlay') as HTMLElement | null;
const projectPickerList = document.getElementById('projectPickerList') as HTMLElement | null;
const projectPickerClose = document.getElementById('projectPickerClose') as HTMLElement | null;
const projectPickerFolder = document.getElementById('projectPickerFolder') as HTMLElement | null;
let projectPickerRequestId: string | null = null;

function answerProjectPicker(choice: { kind: 'project'; projectId: string } | { kind: 'folder' } | { kind: 'cancelled' }) {
  const requestId = projectPickerRequestId;
  projectPickerRequestId = null;
  if (projectPickerOverlay) {
    projectPickerOverlay.style.display = 'none';
    releaseOverlay('project-picker');
  }
  if (projectPickerList) projectPickerList.textContent = '';
  if (!requestId) return;
  void Promise.resolve(getApi()?.answerProjectOpenPicker?.({ requestId, choice })).catch(() => {});
}

function renderProjectPickerRows(candidates: unknown[]) {
  if (!projectPickerList) return;
  projectPickerList.textContent = '';
  projectPickerList.dataset.state = candidates.length ? 'ready' : 'empty';
  if (!candidates.length) {
    const empty = document.createElement('div');
    empty.className = 'tab-search-message';
    empty.textContent = 'Chưa có dự án nào. Dùng “Chọn thư mục…” để thêm.';
    projectPickerList.appendChild(empty);
    return;
  }
  for (const raw of candidates) {
    if (!isPlainRecord(raw) || typeof raw.projectId !== 'string' || !raw.projectId) continue;
    const projectId = raw.projectId;
    const row = document.createElement('div');
    row.className = 'tab-search-row';
    row.setAttribute('role', 'option');
    row.tabIndex = 0;
    const main = document.createElement('div');
    main.className = 'tab-search-row-main';
    const title = document.createElement('span');
    title.className = 'tab-search-row-title';
    title.textContent = (typeof raw.name === 'string' && raw.name) || projectId;
    const pathEl = document.createElement('span');
    pathEl.className = 'tab-search-row-url';
    pathEl.textContent = typeof raw.workspacePath === 'string' ? raw.workspacePath : '';
    main.appendChild(title);
    main.appendChild(pathEl);
    row.appendChild(main);
    if (raw.isCurrent === true) {
      const here = document.createElement('span');
      here.className = 'tab-search-row-project';
      here.textContent = 'Cửa sổ này';
      row.appendChild(here);
    }
    const pick = () => answerProjectPicker({ kind: 'project', projectId });
    row.addEventListener('click', pick);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(); }
    });
    projectPickerList.appendChild(row);
  }
}

async function showProjectPicker(requestId: string) {
  if (!projectPickerOverlay) {
    // No surface to host it: an unanswered request would hold Main until its timeout.
    void Promise.resolve(getApi()?.answerProjectOpenPicker?.({ requestId, choice: { kind: 'cancelled' } })).catch(() => {});
    return;
  }
  // A second push supersedes an unanswered one rather than stacking two modals.
  if (projectPickerRequestId) answerProjectPicker({ kind: 'cancelled' });
  projectPickerRequestId = requestId;
  projectPickerOverlay.style.display = 'flex';
  acquireOverlay('project-picker');
  if (projectPickerList) {
    projectPickerList.textContent = '';
    projectPickerList.dataset.state = 'loading';
  }
  try {
    const listed = await getApi()?.listProjects?.();
    if (projectPickerRequestId !== requestId) return;
    renderProjectPickerRows(listed && isPlainRecord(listed) && Array.isArray(listed.candidates) ? listed.candidates : []);
    (projectPickerList?.querySelector('.tab-search-row') as HTMLElement | null)?.focus();
  } catch {
    if (projectPickerRequestId === requestId) renderProjectPickerRows([]);
  }
}

getApi()?.onProjectOpenPicker?.((payload) => {
  if (payload && typeof payload.requestId === 'string' && payload.requestId) void showProjectPicker(payload.requestId);
});
projectPickerClose?.addEventListener('click', () => answerProjectPicker({ kind: 'cancelled' }));
projectPickerFolder?.addEventListener('click', () => answerProjectPicker({ kind: 'folder' }));
projectPickerOverlay?.addEventListener('click', (event) => {
  if (event.target === projectPickerOverlay) answerProjectPicker({ kind: 'cancelled' });
});
tabSearchClose?.addEventListener('click', () => closeTabSearch(true));
// ---------------------------------------------------------------------------
// Project chip menu — detach/reattach and project switching. The native menubar
// is retired on win32/linux (FocusManager crash), so this chip popover plus the
// ⋮ rows are the discoverable surface the File menu used to provide.
// ---------------------------------------------------------------------------
const projectIdentityChip = document.getElementById('projectIdentityChip') as HTMLElement | null;
const projectChipMenu = document.getElementById('projectChipMenu') as HTMLElement | null;
const projectChipWrap = document.getElementById('projectIdentityWrap') as HTMLElement | null;
const menuProjectMove = document.getElementById('menuProjectMove') as HTMLButtonElement | null;
const menuProjectOpenOther = document.getElementById('menuProjectOpenOther') as HTMLButtonElement | null;
const menuItemDetachProject = document.getElementById('menuItemDetachProject') as HTMLElement | null;
const menuItemReattachProject = document.getElementById('menuItemReattachProject') as HTMLElement | null;

function openProjectChipMenu(): void {
  if (!projectChipMenu || !projectIdentityChip) return;
  projectChipMenu.style.display = 'flex';
  projectIdentityChip.setAttribute('aria-expanded', 'true');
  acquireOverlay('project-chip');
  syncProjectMenuItems();
}

function closeProjectChipMenu(): void {
  if (!projectChipMenu) return;
  if (projectChipMenu.style.display !== 'none') releaseOverlay('project-chip');
  projectChipMenu.style.display = 'none';
  projectIdentityChip?.setAttribute('aria-expanded', 'false');
}

function projectMoveReasonText(reason: string | undefined): string {
  if (reason === 'NOT_DETACHED') return 'Dự án không đang tách';
  if (reason === 'CLOSE_REFUSED') return 'Một tab đang chặn đóng cửa sổ (xem thông báo)';
  if (reason === 'REATTACH_IN_PROGRESS') return 'Đang gắn lại…';
  if (reason === 'DETACH_REFUSED') return 'Có tab từ chối chuyển sang cửa sổ riêng';
  return reason || 'không rõ nguyên nhân';
}

async function runProjectMove(): Promise<void> {
  const projectId = projectActionTarget();
  if (!projectId) { showToolbarToast('⚠️ Không xác định được dự án của cửa sổ này'); return; }
  closeProjectChipMenu();
  const detached = lastProjectIdentity?.owner.kind === 'project';
  try {
    if (detached) {
      const result = await getApi()?.reattachProject?.({ projectId });
      // Success closes this very window — nothing else to paint.
      if (result && result.status === 'FAILED') showToolbarToast(`⚠️ Không gắn lại được: ${projectMoveReasonText(result.reason)}`);
    } else {
      const result = await getApi()?.detachProject?.({ projectId });
      if (!result) { showToolbarToast('⚠️ Preload thiếu detachProject'); return; }
      if (result.status === 'DETACHED') showToolbarToast('✅ Đã tách dự án ra cửa sổ riêng');
      else if (result.status === 'FOCUSED') showToolbarToast('Dự án đã có cửa sổ riêng — đang hiển thị');
      else if (result.status === 'FAILED') showToolbarToast(`⚠️ Không tách được: ${projectMoveReasonText(result.reason)}`);
    }
  } catch (err) {
    showToolbarToast(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
  }
}

projectIdentityChip?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (projectChipMenu?.style.display === 'flex') closeProjectChipMenu();
  else openProjectChipMenu();
});
projectIdentityChip?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); openProjectChipMenu(); }
  else if (e.key === 'ArrowDown' && projectChipMenu?.style.display === 'flex') {
    e.preventDefault();
    (projectChipMenu.querySelector('.project-chip-menu-item') as HTMLElement | null)?.focus();
  }
});
projectChipMenu?.addEventListener('click', (e) => e.stopPropagation());
projectChipMenu?.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const items = Array.from(projectChipMenu.querySelectorAll<HTMLElement>('.project-chip-menu-item'));
    const idx = items.indexOf(document.activeElement as HTMLElement);
    items[(idx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  }
});
menuProjectMove?.addEventListener('click', () => { void runProjectMove(); });
menuProjectOpenOther?.addEventListener('click', () => {
  closeProjectChipMenu();
  void getApi()?.openProject?.();
});
menuItemDetachProject?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  void runProjectMove();
});
menuItemReattachProject?.addEventListener('click', (e) => {
  e.stopPropagation();
  closeAppMenu();
  void runProjectMove();
});
document.addEventListener('click', (e) => {
  if (projectChipMenu?.style.display === 'flex' && projectChipWrap && !projectChipWrap.contains(e.target as Node)) {
    closeProjectChipMenu();
  }
});
tabSearchOverlay?.addEventListener('click', (event) => {
  if (event.target === tabSearchOverlay) closeTabSearch(true);
});
tabSearchInput?.addEventListener('input', () => {
  void requestTabSearch(tabSearchInput.value);
});
tabSearchInput?.addEventListener('keydown', (event) => {
  // Escape is handled once, by the document-level chain, so every overlay closes the
  // same way and returns focus through closeTabSearch().
  if (event.key === 'Enter') {
    event.preventDefault();
    if (tabSearchActiveIndex >= 0) void activateTabSearchEntry(tabSearchActiveIndex);
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    moveTabSearchActive(event.key);
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initToolbar);
} else {
  initToolbar();
}

