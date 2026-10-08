/**
 * AntiFan Browser Desktop — Full Native Tab Host & AI Sidebar (Chromium Engine)
 * Features: 100% parity with Antigravity Desktop architecture:
 * Multi-tab, Docked DevTools, GPU Lens, Font Finder, Device Emulation, Bookmarks,
 * AI Chat Sidebar (WebSocket Relay with Antigravity IDE), Global Shortcuts, and Context Menu.
 */
import { app, BrowserWindow, WebContentsView, Menu, MenuItem, clipboard, Rectangle, ipcMain, shell, dialog, net, session, safeStorage, screen } from 'electron';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLifecycleEvent } from '../diagnostics/main-lifecycle-log';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { StorageLocations } from '../config/storage-locations';
import { parseOwnerKey } from '../project/project-context';
import { openSpace, createConfirmationStore, type SpaceOpenDeps } from '../project/space-open';
import { buildSpaceTemplate, writeSpaceManifestExclusive, antifanDirUnignoredInGit } from '../project/space-manifest';
import type { SpaceInitResult, ReadFilePreviewResult } from '../../shared/contracts';
import { AntiFanTab, SplitPaneId, AntiFanPickedElement, TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, TERMINAL_CHANNELS, FRAME_BACKDROP_CHANNELS, PROJECT_WINDOW_CHANNELS, TerminalAckPayload, TerminalDataPayload, TerminalNewInFolderResult, SpaceOpenResult, TerminalTabLayout, TerminalTabPrefs, TERMINAL_TAB_LAYOUT_DEFAULT_WIDTH, clampTerminalTabSidebarWidth, TERMINAL_CATEGORY_COLORS_MAX, TERMINAL_CATEGORY_COLOR_PATTERN, ToolbarPhoneStatus, TerminalAgentAffinityInfo, ProjectWindowIdentity, BRIDGE_CHANNELS, RunCardState, RunControlOp, RunControlReason, RunControlResult, CapsuleBrief, CapsuleBriefResult, CapsuleBriefReason } from '../../shared/contracts';
import { buildBridgeHealthReport, subscribeBridgeHealth } from '../bridge/bridge-health';
import { RunStateService } from '../run/run-state-service';
import type { ExecutionBackend } from '../agent/execution-backend';
import type { ExecutionAttachmentRecord } from '../../shared/control-plane-contracts';
import { getSecureWebPreferences, sanitizeUrl, isAllowedNavigation, cleanRestoredUrl, isInternalWidgetOrSubframeUrl } from '../security/security-policy';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { resolveWorkspaceFromUrl, DEFAULT_WORKSPACE_ROOTS } from './workspace-resolver';
import { FONT_FINDER_SCRIPT, FONT_FINDER_CLEANUP_SCRIPT } from './font-finder';
import { RULER_SCRIPT } from './ruler';
import {
  DEVICE_PRESETS,
  DevicePreset,
  findDevicePreset,
  getPresetUserAgent,
  getPresetPlatform,
  getPresetCornerRadius,
  IPHONE_USER_AGENT,
  MAC_DESKTOP_USER_AGENT,
} from './device-presets';
import { chromeSessionUserAgent } from './google-auth-identity';
import { configureBrowserSessionPartition, deriveCapsulePartition, unconfigureBrowserSessionPartition, type BrowserSessionUserAgentMode } from './browser-session-partition';
import { TabDiagnosticsManager, computeOrigin, normalizeConsoleLevel } from './tab-diagnostics';
import type { CaptureViewportTransaction, RenderSurfaceSnapshot, VerificationCaptureEnvelope } from '../verification/visual-capture';
import { buildKeyboardInputEvents } from './keyboard-normalizer';
import { FirstPartyNetworkTracker, type NetworkTrackerStats } from './first-party-network-tracker';
import { WorkspaceCapsuleManager, canonicalFolderKey, findCapsuleByRoot, findReusableCapsule, workspaceDialogDefaultPath, type WorkspaceCapsule, type CapsuleAffiliation } from '../project/workspace-capsule';
import { findSyncDuplicate, syncIdentity } from '../project/sync-identity';
import { PreviewWatcherPool, type PreviewChangeEvent } from '../server/preview-watcher-pool';
import { buildPreviewUrl, parsePreviewUrl } from '../server/preview-url-codec';
import type { ControlPlaneResourceStats, ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
import type { BrowserTarget } from '../../shared/control-plane-contracts';
import type { WorkflowDefinition } from '../workflow/workflow-schema';
import type { CliSessionResult } from '../run/run-service';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { buildCookieSetDetails, runCapsuleToProfileMigration, type CapsuleMigrationCookie, type CapsuleMigrationDeps } from './capsule-partition-migration';
import { LocalSessionVault, isTrustedSessionVaultSender } from './local-session-vault';
import { LocalCredentialVault, resolveSenderFrameOrigin } from './local-credential-vault';
import { HaravanUploader } from './haravan-uploader';
import type { ActionSequenceParams, ActionSequenceResult } from './tab-automation-host';
import { TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID, workspaceTerminalProvenance, selectAnnotationTargets, selectAnnotationPickerRows, type SessionSummary, type TerminalDiagnosticsReport, type TerminalManagerStats, type TerminalSessionStateProjection } from './terminal-manager';
import { checkForUpdatesAndRestart } from './app-menu';
import { SkillScanner } from './skill-scanner';
import { getCoreHealthService } from '../diagnostics/core-health';
import { buildMcpToolList } from '../mcp/mcp-server';
import { getMcpDispatchService, mcpDispatchStoreLabel, unmeasuredBoundaryEnvelope } from '../diagnostics/mcp-dispatch-service';
import { UnmeasuredReason } from '../diagnostics/mcp-dispatch-accounting';
import { WindowStateManager, WindowState } from './window-state';
import { BridgeServer } from '../bridge/bridge-server';
import { ViewportGate } from '../tools/browser-control-port';
import { safeSendWebContents } from './web-contents-guard';
import { ownerKey, ownerLabel, type ProjectWindowShell, type WindowOwner, type ChromeSurface } from './project-window-shell';
import { installChromeIpcOnce, type IpcRoute, type IpcEvent } from './ipc-router';

import { HistoryManager } from './history-manager';
import { OAuthPopupManager } from './oauth-popup-manager';
import { SemanticRefRegistry, makeTargetKey } from './semantic-ref-registry';
import { settleWithinBound } from './target-operation-chain';
import { TabAutomationHost } from './tab-automation-host';
import { TabDevToolsHost, type TabDevToolsStats } from './tab-devtools-host';
import { TerminalOutputRouter } from './terminal-output-router';
import { isTrackerBlockedUrl, isTrackerIsolationConsoleNoise } from './tracker-isolation';
import type { TrackerIsolationReceipt } from './tracker-isolation';
import {
  buildIsolatedExecutorScript,
  buildIsolatedCollectorScript,
  ISOLATED_AGENT_WORLD_ID,
  validateActionResponse,
} from './semantic-ref-executor';
import type { SemanticElementDescriptor } from './semantic-ref-types';
import { generateCollectionNonce, validateCollectionEnvelope } from './semantic-ref-types';
import { CapabilityError, isBootProjectId, type CapabilityErrorCode } from '../../shared/control-plane-contracts';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
import { AsyncThemeQaQueue } from '../qa/async-qa-job-queue';
import { confineWorkspaceRoot } from '../qa/diagnostics-filter';
import {
  applyChecklistMutation,
  defaultChecklistItems,
  getScope as getChecklistScopeRecord,
  isProvisionalChecklistScope,
  mutateScope as mutateChecklistScopeRecord,
  setScopeCas as setChecklistScopeCas,
  validateChecklistItems as validateThemeChecklistItems,
  type ChecklistMutationOp,
} from '../qa/theme-checklist-store';
import type { ThemeChecklistItem } from '../../shared/theme-checklist';
export interface NativeTabHostResourceStats {
  disposed: boolean;
  tabCount: number;
  attachedTabViewCount: number;
  terminalWindowCount: number;
  terminalWindowMetadataCount: number;
  previewWatcherCount: number;
  previewSubscriptionCount: number;
  targetOperationQueueCount: number;
  agentWorkingTimerCount: number;
  agentWorkingRefCount: number;
  network: NetworkTrackerStats;
  devTools: TabDevToolsStats;
  terminal: TerminalManagerStats;
  controlPlane: ControlPlaneResourceStats | null;
  terminalFanoutMessages: number;
}

/**
 * The per-tab Theme QA row `tabThemeQaStates` holds and `THEME_QA_STATE`
 * pushes carry inside `{tabId, state}`.
 */
export interface TabThemeQaState {
  status: 'idle' | 'running' | 'pass' | 'fail' | 'error';
  issueCount: number;
  reportArtifactId?: string;
  report?: unknown;
  error?: string;
  updatedAt: number;
}
import {
  DEFAULT_SPLIT_DESKTOP_PRESET,
  DEFAULT_SPLIT_MOBILE_PRESET,
  calculateSplitLayout,
  SplitNavigationCoordinator,
  sanitizeTabForPersistence,
  migratePersistedTab,
} from './split-review-coordinator';
import { shouldHibernate, hibernationIdleMsForUrl, HIBERNATE_IDLE_MS, HIBERNATE_SWEEP_INTERVAL_MS, type HibernationContext } from './tab-hibernation';
export interface NativeTabHostResourceStats {
  disposed: boolean;
  tabCount: number;
  attachedTabViewCount: number;
  terminalWindowCount: number;
  terminalWindowMetadataCount: number;
  previewWatcherCount: number;
  previewSubscriptionCount: number;
  targetOperationQueueCount: number;
  agentWorkingTimerCount: number;
  agentWorkingRefCount: number;
  network: NetworkTrackerStats;
  devTools: TabDevToolsStats;
  terminal: TerminalManagerStats;
  controlPlane: ControlPlaneResourceStats | null;
  terminalFanoutMessages: number;
}

export const TOOLBAR_HEIGHT_WITH_BOOKMARKS = 102;
export const TOOLBAR_HEIGHT_COMPACT = 74;
const TITLE_BROADCAST_INTERVAL_MS = 200;
// Chunks at or below this size with no pending batch bypass coalescing so
// keystroke echo latency never regresses; `data.length` counts UTF-16 code
// units, which is what the renderer consumes.
const TERMINAL_DATA_COALESCE_BYPASS_LENGTH = 256;
// Upper bound on how long a coalesced batch may wait before it is flushed.
const TERMINAL_DATA_FLUSH_MS = 4;
// The activity envelope's bounded copy of the batch data. The activity
// classifier consumes only the tail: its wait/idle OSC markers are emitted
// trailing, prompt detection is $-anchored, and the cross-chunk tail window
// is 64 chars — so the head of a big batch buys the non-displaying surface
// nothing and is not worth the structured clone.
const TERMINAL_ACTIVITY_DATA_TAIL_CHARS = 4096;
// Upper bound on persisted collapsed-category names so a corrupt saved-tabs.json
// cannot smuggle in an unbounded array.
const TERMINAL_COLLAPSED_CATEGORIES_MAX = 64;
/** Cap on user-managed groups, and on the length of one group name. */
const TERMINAL_CATEGORIES_MAX = 64;
const TERMINAL_CATEGORY_NAME_MAX = 48;

/**
 * Version of the saved-tabs document this authority writes. Version 1 was the
 * flat document (top-level `tabs`/`activeTabId`); it carried no verified
 * affiliation, so its records migrate to Unassigned. Every owner-keyed document
 * states its version, which is what makes the migration run exactly once.
 */
export const SAVED_TABS_SCHEMA_VERSION = 2;

/** Owner key of the Unassigned window; derived, never a second literal. */
const UNASSIGNED_OWNER_KEY = ownerKey({ kind: 'unassigned' });

/** Owner key of the 'web' hub shell; derived, never a second literal. */
const WEB_OWNER_KEY = ownerKey({ kind: 'web' });

/**
 * Why handing one session to a project window was refused. One vocabulary for the route's own
 * reply and for the renderer that has to say something to the user, rather than a thrown message
 * the invoker would have to parse.
 */
type TerminalProjectAssignReason =
  | 'INVALID_PAYLOAD'
  | 'PROJECT_UNAVAILABLE'
  | 'TARGET_WINDOW_ABSENT'
  | 'SESSION_NOT_VISIBLE'
  | 'UNKNOWN_SESSION'
  | 'MANAGER_AGENT_SESSION_READ_ONLY';

/** The assignment authority Main resolves for a project id, when the project may receive a terminal. */
export interface TerminalProjectAssignment {
  /** Canonical capsule stamped on a project that has one; omitted for a workspace-less project. */
  capsuleId?: string;
}

/** The answer `antifan:terminal:assign-project` gives the renderer: an outcome, or a refusal it can render. */
export type TerminalProjectAssignResult =
  | { ok: true; sessionId: string; projectId: string; ownerKey: string; capsuleId?: string }
  | { ok: false; reason: TerminalProjectAssignReason; message: string };

/** Why opening a terminal's URL was refused before any window could claim it. */
type TerminalProjectLinkReason =
  | 'INVALID_PAYLOAD'
  | 'SESSION_NOT_VISIBLE'
  | 'UNKNOWN_SESSION'
  | 'MANAGER_AGENT_SESSION_READ_ONLY'
  | 'TERMINAL_OWNER_UNAVAILABLE'
  | 'TARGET_WINDOW_ABSENT';

/** The answer `antifan:terminal:open-link` gives the renderer: a typed outcome, never a fallback instruction. */
export type TerminalProjectLinkResult =
  | { ok: true; sessionId: string; ownerKey: string }
  | { ok: false; reason: TerminalProjectLinkReason; message: string };

/**
 * A refusal of the shared manager's write gate: a typed answer, never a throw. The route that
 * hit it decides how its own contract carries the refusal — a boolean route answers `false`, a
 * fire-and-forget channel logs it, and the assign route replies with the code itself.
 */
type ManagerWriteRefusal = { ok: false; reason: Extract<TerminalProjectAssignReason | TerminalProjectLinkReason, 'MANAGER_AGENT_SESSION_READ_ONLY'>; message: string };

/** Timeout in milliseconds waiting for a run control request acknowledgement. */
export const RUN_CONTROL_ACK_TIMEOUT_MS = 5_000;

/** Vocabulary of known RunControlReason values used for validating hook ack errors. */
const KNOWN_RUN_CONTROL_REASONS = new Set<RunControlReason>([
  'INVALID_PAYLOAD',
  'UNKNOWN_SESSION',
  'SESSION_NOT_VISIBLE',
  'MANAGER_AGENT_SESSION_READ_ONLY',
  'RUN_NOT_ACTIVE',
  'STALE_RUN_SEQ',
  'RUN_CONTROL_TIMEOUT',
  'RUN_CONTROL_UNSUPPORTED',
  'RUN_BACKEND_UNAVAILABLE',
  'ACTUATOR_FAILED',
  'RUN_CONTROL_FAILED',
]);

/** One terminal window as persisted inside the record of the window that owns it. */
export interface SavedTerminalWindowRecord {
  sessionId?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number; isMaximized?: boolean };
  isPopout?: boolean;
}

/** A terminal-to-tab affinity as persisted inside its owner's record. */
export interface SavedTerminalAffinityRecord {
  terminalId: string;
  primaryTabId: string;
  managedTabIds: string[];
}

/** The persisted browser state of one window, keyed by its serialized owner. */
export interface SavedTabsOwnerRecord {
  activeTabId?: string;
  tabs: Array<Record<string, unknown>>;
  terminalWindows?: SavedTerminalWindowRecord[];
  terminalAffinities?: SavedTerminalAffinityRecord[];
  isTerminalPopoutOpen?: boolean;
  wasSidebarOpenBeforePopout?: boolean;
  popoutSessionId?: string;
  updatedAt: number;
  /** The web hub's presented project at persist time; only the 'web' owner carries it. */
  activeProjectId?: string;
  /** This window's terminal tab-strip layout: each window remembers the one the user set there. */
  terminalTabLayout?: TerminalTabLayout;
  /** This window's terminal sidebar column width (px). */
  terminalSidebarWidth?: number;
  /**
   * A `project:<id>` record this owner detached deliberately: the marker survives an
   * ordinary window close — the project stays detached until an explicit reattach —
   * and it exempts the record from `foldLegacyProjectOwnerRecords`, which would
   * otherwise absorb the rows into `owners.web` on the next web-host read.
   */
  detached?: boolean;
}

/** Terminal prefs every window shares: the saved-tabs top-level keys they persist under. */
const SHARED_TERMINAL_PREF_KEYS = [
  'terminalCollapsedCategories',
  'terminalCategories',
  'terminalCategoryColors',
  'terminalStarredCategories',
  'terminalProjectOrder',
] as const;
type SharedTerminalPrefKey = typeof SHARED_TERMINAL_PREF_KEYS[number];

/**
 * The on-disk saved-tabs document. `owners` is the only place window-scoped
 * browser state lives; the remaining top-level keys are application-wide
 * preferences (bookmarks, muted sites, profile, terminal presentation) that were
 * shared before project windows existed and stay shared.
 */
export interface SavedTabsDocument extends Record<string, unknown> {
  version: number;
  owners: Record<string, SavedTabsOwnerRecord>;
  sidebarWidth?: number;
  isSidebarOpen?: boolean;
  mutedSites?: string[];
  bookmarks?: BookmarkItem[];
  activeChromeProfileId?: string;
  terminalTabLayout?: TerminalTabLayout;
  terminalSidebarWidth?: number;
  terminalCollapsedCategories?: string[];
  terminalCategories?: string[];
  terminalCategoryColors?: Record<string, string>;
  terminalStarredCategories?: string[];
  terminalProjectOrder?: string[];
  updatedAt?: number;
}

/**
 * Persisted tab entries, as written from tab states. Non-object entries are
 * dropped here rather than cast, so everything downstream reads a real object.
 */
function tabRecordsFromUnknown(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const records: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    records.push(entry as Record<string, unknown>);
  }
  return records;
}

const TERMINAL_BOUND_KEYS = ['x', 'y', 'width', 'height'] as const;

/** Persisted terminal windows, with every field re-checked against its declared type. */
function terminalWindowRecordsFromUnknown(value: unknown): SavedTerminalWindowRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: SavedTerminalWindowRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const record: SavedTerminalWindowRecord = {};
    if (typeof source.sessionId === 'string') record.sessionId = source.sessionId;
    if (typeof source.isPopout === 'boolean') record.isPopout = source.isPopout;
    const rawBounds = source.bounds;
    if (rawBounds && typeof rawBounds === 'object' && !Array.isArray(rawBounds)) {
      const boundsSource = rawBounds as Record<string, unknown>;
      const bounds: NonNullable<SavedTerminalWindowRecord['bounds']> = {};
      for (const key of TERMINAL_BOUND_KEYS) {
        const coordinate = boundsSource[key];
        if (typeof coordinate === 'number' && Number.isFinite(coordinate)) bounds[key] = coordinate;
      }
      if (typeof boundsSource.isMaximized === 'boolean') bounds.isMaximized = boundsSource.isMaximized;
      record.bounds = bounds;
    }
    records.push(record);
  }
  return records;
}

/** Persisted terminal-to-tab affinities; an entry missing its ids is not an affinity. */
function terminalAffinityRecordsFromUnknown(value: unknown): SavedTerminalAffinityRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records: SavedTerminalAffinityRecord[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    if (typeof source.terminalId !== 'string' || typeof source.primaryTabId !== 'string') continue;
    const managedTabIds = Array.isArray(source.managedTabIds)
      ? source.managedTabIds.filter((id): id is string => typeof id === 'string')
      : [];
    records.push({ terminalId: source.terminalId, primaryTabId: source.primaryTabId, managedTabIds });
  }
  return records;
}

/** Outcome of the one-time legacy migration. */
export interface SavedTabsMigrationResult {
  migrated: boolean;
  reason?: string;
}

/**
 * Workspace a window's terminals belong to. Main resolves and validates it
 * against the workspace registry; the host never derives it from focus, from the
 * renderer, or from another window's live state.
 */
export interface WindowWorkspaceAffiliation {
  workspacePath: string;
  /** Capsule the window's terminals are pinned to, when one is verified. */
  capsuleId?: string;
}

/** Where a new terminal's working directory came from. */
export type TerminalCreationSource = 'popout-session' | 'window-workspace' | 'process-default';

export interface TerminalCreationTarget {
  cwd: string;
  /**
   * The capsule this session belongs to. Always concrete: the window's verified capsule,
   * a popout session's own, or the sentinel for a window that has none — never left to the
   * manager's process-wide ambient capsule, which is another window's workspace whenever
   * two project windows are open.
   */
  capsuleId: string;
  /**
   * Owner key of the window the session is minted for. The key travels with the session and
   * is what its visibility is decided by afterwards, so a terminal belongs to the window that
   * asked for it even when a sibling window shares the same folder and the same capsule. A
   * mint with no window to attribute — the process-start directory fallback — carries the
   * manager's `'unassigned'` sentinel instead of guessing a window.
   */
  ownerKey: string;
  source: TerminalCreationSource;
}

/** One user-visible tab in the cross-project search inventory. */
export interface TabSearchInventoryRow {
  tabId: string;
  title: string;
  url: string;
  ownerKey: string;
  ownerLabel: string;
  /** Workspace label that distinguishes two projects with the same name. */
  projectPath?: string;
  active: boolean;
  /** Position in the owning window's strip; the inventory's stable order. */
  order: number;
}

/** Why an activation was refused. Both mean "unavailable"; neither permits a fallback. */
export type TabSearchActivationFailure = 'TAB_UNAVAILABLE' | 'OWNER_CHANGED';

export type TabSearchActivationResult =
  | { ok: true; tabId: string; ownerKey: string; ownerLabel: string }
  | { ok: false; tabId: string; reason: TabSearchActivationFailure };

/**
 * The manager methods the window-scoped projections need. `TerminalManager` can
 * also be the daemon proxy, which implements only the long-standing surface, so
 * every added call is optional and degrades to the unscoped process view.
 */
type TerminalManagerSeam = TerminalManager & {
  getDefaultCwd?(): string;
  sessionCapsuleId?(sessionId: string): string | undefined;
  /**
   * Owner key the session was minted under, or undefined for a row written before ownership
   * existed. Optional like the capsule accessor: a minimal seam may not answer it, and the
   * scope then falls back to the legacy capsule rule rather than admitting everything.
   */
  sessionOwnerKey?(sessionId: string): string | undefined;
};

/** The WebContents id behind an IPC sender, when the sender is one. */
function senderWebContentsId(sender: unknown): number | undefined {
  if (!sender || typeof sender !== 'object' || !('id' in sender)) return undefined;
  const id = sender.id;
  return typeof id === 'number' ? id : undefined;
}

function isExistingDirectory(candidate: string | undefined): boolean {
  if (!candidate) return false;
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Normalize any parsed saved-tabs document into its owner-keyed shape. Pure, so
 * the migration decision can be inspected without touching the file.
 *
 * A legacy document has no verified affiliation for its records — the flat file
 * predates project windows and names no project — so they become the Unassigned
 * window's record rather than being guessed onto whichever window reads them.
 */
export function normalizeSavedTabsDocument(data: Record<string, unknown>): { document: SavedTabsDocument; migrated: boolean } {
  const existingOwners: Record<string, SavedTabsOwnerRecord> = {};
  const ownersValue = data.owners;
  if (ownersValue && typeof ownersValue === 'object' && !Array.isArray(ownersValue)) {
    for (const [key, value] of Object.entries(ownersValue)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      if (!('tabs' in value) || !Array.isArray(value.tabs)) continue;
      const record: SavedTabsOwnerRecord = { tabs: tabRecordsFromUnknown(value.tabs), updatedAt: Date.now() };
      if ('activeTabId' in value && typeof value.activeTabId === 'string') record.activeTabId = value.activeTabId;
      if ('updatedAt' in value && typeof value.updatedAt === 'number') record.updatedAt = value.updatedAt;
      const terminalWindows = terminalWindowRecordsFromUnknown(value.terminalWindows);
      if (terminalWindows) record.terminalWindows = terminalWindows;
      const terminalAffinities = terminalAffinityRecordsFromUnknown(value.terminalAffinities);
      if (terminalAffinities) record.terminalAffinities = terminalAffinities;
      if ('isTerminalPopoutOpen' in value && typeof value.isTerminalPopoutOpen === 'boolean') record.isTerminalPopoutOpen = value.isTerminalPopoutOpen;
      if ('wasSidebarOpenBeforePopout' in value && typeof value.wasSidebarOpenBeforePopout === 'boolean') record.wasSidebarOpenBeforePopout = value.wasSidebarOpenBeforePopout;
      if ('popoutSessionId' in value && typeof value.popoutSessionId === 'string') record.popoutSessionId = value.popoutSessionId;
      if ('activeProjectId' in value && typeof value.activeProjectId === 'string') record.activeProjectId = value.activeProjectId;
      if ('terminalTabLayout' in value && (value.terminalTabLayout === 'horizontal' || value.terminalTabLayout === 'sidebar')) record.terminalTabLayout = value.terminalTabLayout;
      if ('terminalSidebarWidth' in value && typeof value.terminalSidebarWidth === 'number' && Number.isFinite(value.terminalSidebarWidth)) record.terminalSidebarWidth = value.terminalSidebarWidth;
      if ('detached' in value && value.detached === true) record.detached = true;
      existingOwners[key] = record;
    }
  }

  const legacyTabs = tabRecordsFromUnknown(data.tabs);
  const legacyTerminalWindows = terminalWindowRecordsFromUnknown(data.terminalWindows);
  const legacyAffinities = terminalAffinityRecordsFromUnknown(data.terminalAffinities);
  const hasLegacyWindowState = legacyTabs.length > 0
    || Boolean(legacyTerminalWindows?.length)
    || Boolean(legacyAffinities?.length)
    || typeof data.activeTabId === 'string'
    || data.isTerminalPopoutOpen === true;

  if (data.version === SAVED_TABS_SCHEMA_VERSION && !hasLegacyWindowState) {
    return { document: { ...data, version: SAVED_TABS_SCHEMA_VERSION, owners: existingOwners }, migrated: false };
  }

  const owners: Record<string, SavedTabsOwnerRecord> = { ...existingOwners };
  if (hasLegacyWindowState) {
    const previous = owners[UNASSIGNED_OWNER_KEY];
    owners[UNASSIGNED_OWNER_KEY] = {
      activeTabId: typeof data.activeTabId === 'string' ? data.activeTabId : previous?.activeTabId,
      tabs: legacyTabs.length > 0 ? legacyTabs : (previous?.tabs ?? []),
      terminalWindows: legacyTerminalWindows ?? previous?.terminalWindows,
      terminalAffinities: legacyAffinities ?? previous?.terminalAffinities,
      isTerminalPopoutOpen: data.isTerminalPopoutOpen === true || previous?.isTerminalPopoutOpen === true,
      wasSidebarOpenBeforePopout: typeof data.wasSidebarOpenBeforePopout === 'boolean' ? data.wasSidebarOpenBeforePopout : previous?.wasSidebarOpenBeforePopout,
      popoutSessionId: typeof data.popoutSessionId === 'string' ? data.popoutSessionId : previous?.popoutSessionId,
      updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
    };
  }

  const document: SavedTabsDocument = { ...data, version: SAVED_TABS_SCHEMA_VERSION, owners };
  // The flat keys are now owner-scoped: leaving them behind would let a reader
  // that ignores `owners` see the same tabs under two owners.
  delete document.tabs;
  delete document.activeTabId;
  delete document.terminalWindows;
  delete document.terminalAffinities;
  delete document.isTerminalPopoutOpen;
  delete document.wasSidebarOpenBeforePopout;
  delete document.popoutSessionId;
  return { document, migrated: true };
}

/**
 * Per-file serialization of saved-tabs writes. Every window merges its own owner
 * record into the same document, and each merge is a read-modify-write: running
 * two of them concurrently would let the later rename drop the earlier window's
 * record. The chain keeps the read inside the critical section.
 */
const savedTabsWriteChains = new Map<string, Promise<unknown>>();

function enqueueSavedTabsWrite<T>(filePath: string, task: () => Promise<T>): Promise<T> {
  const previous = savedTabsWriteChains.get(filePath) ?? Promise.resolve();
  const run = previous.then(task, task);
  savedTabsWriteChains.set(filePath, run.then(() => undefined, () => undefined));
  return run;
}

/**
 * The saved-tabs file's canonical location: the Chromium user-data directory a live
 * app reports, the ANTIFAN_* override an isolated harness pins, or the config dir when
 * Electron never materialized. Reading this without a host is what lets a removal
 * purge persisted rows while no window exists to reach a file.
 */
export function savedTabsFilePath(): string {
  const userData = process.env.ANTIFAN_USER_DATA
    || process.env.ANTIFAN_USER_DATA_DIR
    || (app ? app.getPath('userData') : '')
    || StorageLocations.getConfigDir();
  if (!fs.existsSync(userData)) {
    try { fs.mkdirSync(userData, { recursive: true }); } catch {}
  }
  return path.join(userData, 'saved-tabs.json');
}

/** Raw parse of the saved-tabs file; null when absent, unreadable or not an object. */
function readSavedTabsFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch (err) {
    console.warn('[native-tab-host] Failed to read saved tabs:', err);
    return null;
  }
}

/**
 * Bumped by every swap of the saved-tabs document, sync or async. An async writer
 * snapshots it at merge time and refuses to rename when it moved: a synchronous
 * writer (a closing window's disposal persist, which cannot enter the chain)
 * landed a newer record in between, and the merged projection is stale.
 */
let savedTabsWriteVersion = 0;

function savedTabsTempPath(filePath: string): string {
  return `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The one atomic write of the saved-tabs document. Throws on failure so a caller
 * can retain what it was replacing; a partially written temp file is removed so it
 * can never be mistaken for the document.
 */
function writeSavedTabsDocumentSync(filePath: string, document: SavedTabsDocument): void {
  const tempPath = savedTabsTempPath(filePath);
  const json = JSON.stringify(document, null, 2);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    fs.writeFileSync(tempPath, json, 'utf8');
    fs.renameSync(tempPath, filePath);
    savedTabsWriteVersion += 1;
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

/**
 * Same swap with the byte write off the main thread. The rename itself stays
 * synchronous: it is a metadata operation, and keeping it on the main thread is
 * what makes the version check right before it airtight - nothing synchronous
 * can run between the check and the swap. Returns false (and leaves the document
 * untouched) when the version moved while the bytes were being written.
 */
async function writeSavedTabsDocumentAsync(filePath: string, document: SavedTabsDocument, expectedVersion: number): Promise<boolean> {
  const tempPath = savedTabsTempPath(filePath);
  const json = JSON.stringify(document, null, 2);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.promises.writeFile(tempPath, json, 'utf8');
    if (savedTabsWriteVersion !== expectedVersion) {
      try {
        await fs.promises.rm(tempPath, { force: true });
      } catch {}
      return false;
    }
    const maxAttempts = 3;
    const delaysMs = [25, 50];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (savedTabsWriteVersion !== expectedVersion) {
          try {
            await fs.promises.rm(tempPath, { force: true });
          } catch {}
          return false;
        }
        fs.renameSync(tempPath, filePath);
        savedTabsWriteVersion += 1;
        return true;
      } catch (err: unknown) {
        const isLockError =
          err !== null && typeof err === 'object' && 'code' in err &&
          (err.code === 'EBUSY' || err.code === 'EPERM');
        if (isLockError && attempt < maxAttempts - 1) {
          const delay = delaysMs[attempt] ?? 50;
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, delay);
          await promise;
          continue;
        }
        throw err;
      }
    }
    return false;
  } catch (err) {
    try { fs.rmSync(tempPath, { force: true }); } catch {}
    throw err;
  }
}

/** Current swap version; test seam for the stale-projection guard. */
export function currentSavedTabsWriteVersion(): number {
  return savedTabsWriteVersion;
}

/**
 * Purge one project's persisted rows — the removal path's work when no live window
 * exists to host it. Two arms, one write: every `projectId`-stamped row leaves the
 * 'web' owner record, and the whole `project:<id>` owner record — the detach
 * marker's home — leaves the document, so a removed project can never resurrect
 * its detached window or its rows on the next boot. Identical fail-closed rule as
 * before: absent file removes nothing, a present-but-unreadable file throws
 * because the removal cannot prove the project's persisted tabs are gone.
 */
export function purgeSavedTabsFileForProject(filePath: string, projectId: string): Promise<number> {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (!id) return Promise.resolve(0);
  return enqueueSavedTabsWrite(filePath, async () => {
    const data = readSavedTabsFile(filePath);
    // readSavedTabsFile cannot tell "no file" from "a file it could not parse":
    // both come back null. Absent is empty and answers 0; present-but-unreadable
    // is not — the removal cannot prove the project's persisted tabs are gone,
    // so it fails closed instead of reporting a clean purge.
    if (!data) {
      if (fs.existsSync(filePath)) {
        throw new Error(`saved-tabs.json at '${filePath}' exists but is unreadable or corrupt; refusing to purge '${id}'`);
      }
      return 0;
    }
    const { document } = normalizeSavedTabsDocument(data);
    const projectOwnerKey = `project:${id}`;
    // The detached record drops whole — rows, active pointer, affinities, marker.
    // A fold-shaped merge is deliberately wrong here: removal keeps nothing.
    const droppedRecord = projectOwnerKey in document.owners ? (document.owners[projectOwnerKey]?.tabs?.length ?? 0) : 0;
    if (projectOwnerKey in document.owners) delete document.owners[projectOwnerKey];
    const record = document.owners[ownerKey({ kind: 'web' })];
    const tabs = record && Array.isArray(record.tabs) ? record.tabs : [];
    const kept = tabs.filter((t) => t && t.projectId !== id);
    const removed = droppedRecord + tabs.length - kept.length;
    // A persisted presented-project pointer at the removed project would resurrect it
    // on the next boot whenever the restore's knownness check still passes (the boot
    // project always does), so it goes with the rows even when no row matched.
    const clearsActive = Boolean(record && record.activeProjectId === id);
    if (removed === 0 && !clearsActive) return 0;
    if (record) {
      record.tabs = kept;
      if (clearsActive) delete record.activeProjectId;
      if (record.activeTabId && !kept.some((t) => t && (t.id === record.activeTabId || (t.state as Record<string, unknown> | undefined)?.id === record.activeTabId))) {
        delete record.activeTabId;
      }
    }
    writeSavedTabsDocumentSync(filePath, document);
    return removed;
  });
}

/**
 * Whether the saved-tabs document marks `project:<id>`'s owner record detached —
 * the persisted half of the exclusivity check: a detached window may be closed while
 * the marker survives, and that marker alone must keep the project out of the hub.
 * Absent or unreadable files answer `false`: detach-as-mode must not be inferred from
 * a file that cannot be read, and a corrupt file failing every open closed is the
 * worse failure. Console warn keeps the corruption observable.
 */
export function savedTabsOwnerIsDetached(filePath: string, projectId: string): boolean {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (!id) return false;
  const data = readSavedTabsFile(filePath);
  if (!data) {
    if (fs.existsSync(filePath)) {
      console.warn(`[native-tab-host] saved-tabs.json at '${filePath}' is unreadable; treating 'project:${id}' as not detached`);
    }
    return false;
  }
  const { document } = normalizeSavedTabsDocument(data);
  return document.owners[`project:${id}`]?.detached === true;
}

/**
 * The owner keys whose saved-tabs records are marked `detached === true` —
 * `project:<id>` entries only; every other owner kind can never carry the
 * marker. This is the boot restore's enumeration seam: the same read +
 * `normalizeSavedTabsDocument` pipeline `loadSavedTabsDocument` runs, minus the
 * web-owner fold, so enumeration never mutates the document and never absorbs
 * records it is only listing.
 *
 * Fail-closed like `savedTabsOwnerIsDetached`: an absent or unreadable file
 * answers an empty list (nothing to restore), and a `project:`-shaped key with
 * an empty id is malformed, not restorable.
 */
export function listDetachedProjectOwnerRecords(filePath: string): string[] {
  const data = readSavedTabsFile(filePath);
  if (!data) return [];
  const { document } = normalizeSavedTabsDocument(data);
  const keys: string[] = [];
  for (const [key, record] of Object.entries(document.owners)) {
    if (record?.detached !== true) continue;
    if (parseOwnerKey(key).kind !== 'project') continue;
    keys.push(key);
  }
  return keys;
}

/**
 * Fold one `project:<id>` owner record into `owners.web`: the rows merge deduped
 * by tab id, the project id the owner key carried is stamped onto every merged
 * row, terminal affinities merge deduped by terminal+primary, the web record's
 * persisted active pointers only fill in when the web record has none of its own,
 * and the project record — marker included — leaves the document. Both the legacy
 * migration fold and the reattach fold run exactly this body; the callers differ
 * only in which records they hand it.
 */
function foldProjectOwnerRecordIntoWeb(
  document: SavedTabsDocument,
  ownerKeyValue: string,
  projectId: string,
): void {
  const record = document.owners[ownerKeyValue];
  if (!record || typeof record !== 'object') return;
  const webRecord = (document.owners[WEB_OWNER_KEY] ??= { tabs: [], updatedAt: Date.now() });
  const knownTabIds = new Set(
    webRecord.tabs.map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>).id : undefined)),
  );
  for (const tab of Array.isArray(record.tabs) ? record.tabs : []) {
    const tabId = tab && typeof tab === 'object' ? (tab as Record<string, unknown>).id : undefined;
    if (tabId !== undefined && knownTabIds.has(tabId)) continue;
    if (tab && typeof tab === 'object') {
      (tab as Record<string, unknown>).projectId = projectId;
      if (tabId !== undefined) knownTabIds.add(tabId);
    }
    webRecord.tabs.push(tab);
  }
  const knownAffinityKeys = new Set(
    (webRecord.terminalAffinities ?? []).map((a) => `${a.terminalId}:${a.primaryTabId}`),
  );
  for (const aff of record.terminalAffinities ?? []) {
    const key = `${aff.terminalId}:${aff.primaryTabId}`;
    if (knownAffinityKeys.has(key)) continue;
    knownAffinityKeys.add(key);
    (webRecord.terminalAffinities ??= []).push(aff);
  }
  if (typeof webRecord.activeTabId !== 'string' && typeof record.activeTabId === 'string') {
    webRecord.activeTabId = record.activeTabId;
  }
  if (typeof webRecord.activeProjectId !== 'string' && typeof record.activeProjectId === 'string') {
    webRecord.activeProjectId = record.activeProjectId;
  }
  webRecord.updatedAt = Math.max(webRecord.updatedAt, record.updatedAt);
  delete document.owners[ownerKeyValue];
}

/** The one-key reattach fold's report: what the record carried before it left the document. */
export interface FoldDetachedOwnerResult {
  /** Whether a `project:<id>` record existed to fold. */
  folded: boolean;
  /** The record's tab rows — the same row objects that landed in `owners.web` (stamped). */
  tabs: Array<Record<string, unknown>>;
  /** The record's terminal affinities, for the live-hub ingest to rebuild. */
  terminalAffinities: SavedTerminalAffinityRecord[];
}

/**
 * The scoped, single-key fold the explicit reattach drives: `owners['project:<id>']`
 * merges into `owners.web` and the record (marker included) leaves the document,
 * written atomically through the shared read-modify-write. Unlike the legacy fold
 * this never consults `detached` — the reattach IS the marker-clearing act, and a
 * record whose marker was already lost folds identically.
 *
 * It runs ONLY from explicit lifecycle paths (`reattachProject`), never from a
 * close/quit hook: the caller owes the proof the dying host's final `persistSync`
 * already completed, because that write would re-add the record after this fold.
 * Present-but-unreadable file throws — same fail-closed contract the purge keeps.
 */
export function foldDetachedOwnerRecord(filePath: string, ownerKeyValue: string): Promise<FoldDetachedOwnerResult> {
  const key = typeof ownerKeyValue === 'string' ? ownerKeyValue.trim() : '';
  if (!key.startsWith('project:') || key.length === 'project:'.length) {
    return Promise.resolve({ folded: false, tabs: [], terminalAffinities: [] });
  }
  const projectId = key.slice('project:'.length);
  return enqueueSavedTabsWrite(filePath, async () => {
    const data = readSavedTabsFile(filePath);
    if (!data) {
      if (fs.existsSync(filePath)) {
        throw new Error(`saved-tabs.json at '${filePath}' exists but is unreadable or corrupt; refusing to fold '${key}'`);
      }
      return { folded: false, tabs: [], terminalAffinities: [] };
    }
    const { document } = normalizeSavedTabsDocument(data);
    const record = document.owners[key];
    if (!record || typeof record !== 'object') {
      return { folded: false, tabs: [], terminalAffinities: [] };
    }
    // Snapshot BEFORE the fold: these are the same row objects the merge stamps and
    // pushes onto the web record, so the live ingest re-homes exactly what landed.
    const tabs = Array.isArray(record.tabs) ? [...record.tabs] : [];
    const terminalAffinities = Array.isArray(record.terminalAffinities) ? [...record.terminalAffinities] : [];
    foldProjectOwnerRecordIntoWeb(document, key, projectId);
    document.updatedAt = Date.now();
    writeSavedTabsDocumentSync(filePath, document);
    return { folded: true, tabs, terminalAffinities };
  });
}

/**
 * Cross-window search inventory. Hosts arrive in the caller's stable order (the
 * Main window directory) and each reports its own strip order, so an empty query
 * returns a deterministic list and a non-empty query only filters it — matching
 * is literal and case-insensitive, and the order never depends on which window
 * happens to be focused.
 */
export function collectTabSearchInventory(hosts: readonly NativeTabHost[], query: string): TabSearchInventoryRow[] {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const rows: TabSearchInventoryRow[] = [];
  for (const host of hosts) {
    if (!host) continue;
    rows.push(...host.listSearchInventory());
  }
  if (!needle) return rows;
  return rows.filter((row) => row.title.toLowerCase().includes(needle) || row.url.toLowerCase().includes(needle));
}

/**
 * Activation entry point for `'antifan:tabs:search-activate'`.
 *
 * The tab is found by exact identity across live windows, then revalidated inside
 * the window that currently owns it — existence, current owner and user
 * visibility — with no await between validation and selection. A result whose tab
 * closed, moved, or became an automation surface is reported unavailable; it is
 * never substituted by index and no attachment is changed, so the caller must not
 * present a window for a refused result.
 */
export function activateTabSearchResult(
  hosts: readonly NativeTabHost[],
  request: { tabId: string; expectedOwnerKey: string },
): TabSearchActivationResult {
  const tabId = typeof request?.tabId === 'string' ? request.tabId : '';
  const expectedOwnerKey = typeof request?.expectedOwnerKey === 'string' ? request.expectedOwnerKey : '';
  if (!tabId) return { ok: false, tabId, reason: 'TAB_UNAVAILABLE' };
  for (const host of hosts) {
    if (!host?.hasExactTab(tabId)) continue;
    return host.selectSearchResultTab(tabId, expectedOwnerKey);
  }
  return { ok: false, tabId, reason: 'TAB_UNAVAILABLE' };
}


function getMuteSite(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.hostname.replace(/\.$/, '') || undefined;
  } catch {
    return undefined;
  }
}
/**
 * Normalize a persisted or renderer-supplied group list: strings only, trimmed,
 * non-empty, de-duplicated case-insensitively — two names differing only in case
 * would otherwise render as two headers for what the user reads as one group — in
 * the order given, and capped.
 */
function normalizeTerminalCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().slice(0, TERMINAL_CATEGORY_NAME_MAX);
    if (!name) continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push(name);
    if (out.length >= TERMINAL_CATEGORIES_MAX) break;
  }
  return out;
}

/**
 * Normalize persisted or renderer-supplied colour overrides: a category name keyed to a
 * plain 6-digit hex, capped. Any other value is dropped rather than repaired — a colour
 * the picker never offered is not one the sidebar should paint — and the key keeps the
 * same trimmed, length-capped shape as a group name so a stray key cannot paint a header
 * the user cannot rename.
 */
function normalizeTerminalCategoryColors(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawColor] of Object.entries(value as Record<string, unknown>)) {
    const key = String(rawKey).trim().slice(0, TERMINAL_CATEGORY_NAME_MAX);
    if (!key) continue;
    if (typeof rawColor !== 'string' || !TERMINAL_CATEGORY_COLOR_PATTERN.test(rawColor)) continue;
    out[key] = rawColor.toLowerCase();
    count += 1;
    if (count >= TERMINAL_CATEGORY_COLORS_MAX) break;
  }
  return out;
}

export const MOBILE_OVERLAY_SCROLLBAR_CSS = `
/* AntiFan Chrome DevTools Mobile Scrollbar Simulation */
::-webkit-scrollbar {
  width: 0px !important;
  height: 0px !important;
  background: transparent !important;
}
::-webkit-scrollbar-track {
  background: transparent !important;
}
::-webkit-scrollbar-thumb {
  background: transparent !important;
}
::-webkit-scrollbar-button {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
::-webkit-scrollbar-corner {
  background: transparent !important;
}
html, body {
  -webkit-touch-callout: default;
  -webkit-tap-highlight-color: rgba(0, 0, 0, 0);
  touch-action: manipulation;
}
`;


export const MOBILE_TOUCH_CLIENT_SCRIPT = `(() => {
  if (window.__antifanMobileEmulated) return;
  window.__antifanMobileEmulated = true;
  try {
    Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 5, configurable: true });
  } catch {}
  if (!('ontouchstart' in window)) {
    try { window.ontouchstart = null; } catch {}
  }
  let isDown = false;
  let startX = 0, startY = 0;
  let scrollLeft = 0, scrollTop = 0;
  let activeScrollEl = null;

  function findScrollableParent(el) {
    let curr = el;
    while (curr && curr !== document.documentElement) {
      if (curr instanceof HTMLElement) {
        const style = window.getComputedStyle(curr);
        const overflowX = style.overflowX;
        const overflowY = style.overflowY;
        const isScrollableX = (overflowX === 'auto' || overflowX === 'scroll') && curr.scrollWidth > curr.clientWidth;
        const isScrollableY = (overflowY === 'auto' || overflowY === 'scroll') && curr.scrollHeight > curr.clientHeight;
        if (isScrollableX || isScrollableY) return curr;
      }
      curr = curr.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
    isDown = true;
    startX = e.pageX;
    startY = e.pageY;
    activeScrollEl = findScrollableParent(e.target);
    if (activeScrollEl) {
      scrollLeft = activeScrollEl.scrollLeft;
      scrollTop = activeScrollEl.scrollTop;
    }
  }, { capture: true, passive: true });

  window.addEventListener('mousemove', (e) => {
    if (!isDown || !activeScrollEl) return;
    const dx = e.pageX - startX;
    const dy = e.pageY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
      activeScrollEl.scrollLeft = scrollLeft - dx;
      activeScrollEl.scrollTop = scrollTop - dy;
    }
  }, { capture: true, passive: true });

  const stopDrag = () => { isDown = false; activeScrollEl = null; };
  window.addEventListener('mouseup', stopDrag, { capture: true, passive: true });
  window.addEventListener('mouseleave', stopDrag, { capture: true, passive: true });
})();`;
export interface BookmarkItem {
  id: string;
  url: string;
  title: string;
  createdAt: number;
}


export interface NativeTabRecord {
  /**
   * The presented WebContentsView. Absent while the tab is hibernated — the
   * record (id, state) survives, and `ensureTabAwake`/`switchTab`/`navigate`
   * rebuild it on first touch. Always read via `liveViewContents` or
   * `?.webContents` — never assumed non-null.
   */
  view?: WebContentsView;
  mobileView?: WebContentsView;
  state: AntiFanTab;
  focusedPane?: SplitPaneId;
  customViewport?: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number };
  redirectChain?: string[];
  lastNavigationFailure?: { cause: string; message: string; timedOut: boolean };
  /**
   * The project this tab was minted under while it was the web hub's active
   * project (`setActiveProject`), or undefined for a tab minted with no active
   * project. Stamping — not deriving — is what lets one 'web' window hold tabs
   * of several projects at once: the key never re-resolves when the hub's
   * active project changes. Persisted in saved-tabs as an optional field and
   * restored verbatim; only the 'web' shell stamps it.
   */
  projectId?: string;
  /**
   * Wall time the tab was last active or saw user input; the hibernation sweep
   * measures idleness from it. Never persisted — a restored tab starts at 0
   * (the idlest possible value), which is correct: it was not touched.
   */
  lastActiveAt?: number;
  /** Last time an agent operation resolved this tab as its target. Distinct from
   * `lastActiveAt` (which feeds hibernation); reported in close telemetry. */
  agentActivityAt?: number;
}

/**
 * One terminal's agent ownership record: the tabs it may address, the tab its agent
 * is bound to, and the per-tab bookkeeping the badge and lineage queries read.
 */
type TerminalAgentAffinityEntry = {
  tabId: string;
  primaryTabId: string;
  managedTabIds: Set<string>;
  lineage?: Map<string, {
    tabId: string;
    parentTabId?: string;
    source: 'agent_spawned' | 'native_window_open' | 'user_attached';
    createdAt: number;
  }>;
  lastUrls?: Map<string, string>;
  lastUrl?: string;
  closedAt?: number;
};

/**
 * Time one step of `switchTab` into a bucket that exists only while benchmarks are on.
 * The aggregate `switched` number shows a per-switch cost and never attributes it, so
 * the switch path reports its steps separately (row `switch-steps`). A production
 * switch pays one null test per step and allocates nothing beyond the bucket the row
 * consumes; a benchmark switch pays one `performance.now()` per step.
 */
function markSwitchStep(bucket: Record<string, number> | null, name: string, from: number): number {
  if (bucket === null) return from;
  const now = performance.now();
  bucket[name] = Number((now - from).toFixed(3));
  return now;
}

/**
 * The close-admission facts this host consumes: whether a member page is inside an
 * authorized close attempt's reservation window, whether a quit attempt holds all
 * admission closed, and how to register the work this host is about to admit so the
 * close gate measures real work instead of guessing. Declared structurally, and injected
 * with `setCloseAdmission`, so the tab authority reads the facts without importing the
 * close policy — `PageCloseReservations` in `project-close-coordinator.ts` satisfies this
 * interface.
 */
export interface TabHostCloseAdmission {
  /** True from the moment an attempt reserves the page until it releases it. */
  isPageReserved(tabId: string): boolean;
  /**
   * True while a quit holds application admission closed — the broader refusal, read
   * before the per-page one, because work admitted then would attach to services that
   * attempt is disposing. Optional so the narrow page face still satisfies this type; an
   * implementation that cannot answer must throw, and this host refuses rather than
   * admitting.
   */
  isApplicationAdmissionReserved?(): boolean;
  /**
   * True from the moment an attempt reserves a window's own admission until it releases it.
   * Read before registering owner-attributed work, so a mint asked for by a closing window's
   * chrome — which names no page — is refused instead of being created while that window
   * closes. Optional like the application face; an unreadable answer refuses.
   */
  isOwnerReserved?(ownerKey: string): boolean;
  /**
   * Registers one admitted operation, attributed to the pages it will reach and to the owner
   * key of the window that asked, and returns its release — safe to call exactly once from
   * every exit path. Either attribution may be absent; an operation that names neither is
   * still counted process-wide. Optional: a seam without it cannot be measured, which is the
   * behaviour a host with no seam already has.
   */
  beginAdmittedOperation?(tabIds?: string | readonly string[], ownerKey?: string): () => void;
}

/**
 * Native outcome of one page's unload-aware close. Same vocabulary as the close
 * coordinator's `PageCloseOutcome`, so `closePage` can be injected as `deps.closePage`
 * unchanged; `failed` is a rejected promise, because a thrown native call carries the
 * error text the coordinator reports and must never be flattened into `unknown`.
 */
export type TabPageCloseOutcome = 'closed' | 'vetoed' | 'unknown';

/**
 * How long one page's unload-aware close may stay silent before it is reported `unknown`.
 *
 * Measured on Electron 43: a live content answers `close({ waitForBeforeUnload: true })` with
 * `destroyed` (~11ms) or `will-prevent-unload` (~0ms), and an already-destroyed content makes
 * the call itself throw. A platform that answers a close request with NOTHING is not
 * hypothetical — it was measured on the auxiliary terminal window, where neither `close`, nor
 * `will-prevent-unload`, nor `closed` ever arrived — and the cost of that swallow here is
 * permanent: the pending promise is handed to every later attempt and the tab stays
 * unclosable under this attempt's authorization. The bound decides nothing about the close:
 * `closed` is still reported only from a destroyed instance, and no page is ever destroyed on
 * a timer.
 */
export const PAGE_CLOSE_OUTCOME_DEADLINE_MS = 1_500;

/**
 * How long a terminal window gets to finish dying before its survival is called a fact.
 *
 * Measured on Electron 43 alongside the shell's chrome audit: a content that asked to close
 * still answers `isDestroyed() === false` in the calling task and is gone within ~5ms, so a
 * judgement made in that task reports a window that was already on its way out.
 */
const TERMINAL_WINDOW_CLOSE_SETTLE_MS = 50;

/**
 * Narrow a renderer-supplied pane id to the two panes that exist. The IPC table
 * receives unknown payloads; an unknown value must not reach tab state, where the
 * string would silently travel through focus and layout comparisons.
 */
function normalizeSplitPaneId(value: unknown): SplitPaneId {
  return value === 'mobile' ? 'mobile' : 'desktop';
}

/**
 * Terminal windows that outlived the host that created them, by the id of their content.
 *
 * A terminal window is created by a host but belongs to the user, so host disposal asks it to
 * close politely and a `beforeunload` veto holds — the veto is never overridden. That leaves a
 * live window whose host no longer exists, and the application quit gate resolves an auxiliary
 * terminal window through a *live* host (`surfaceForWebContents`). Without this registry such
 * a window is invisible to every later attempt: alive when the application reports a committed
 * quit, and then destroyed by the platform with its veto unread. The entry keeps the window
 * answerable — "this webContents is a terminal window" — until the window is gone, so a later
 * close attempt reaches it through any live shell and honours its veto.
 *
 * Process-wide and self-cleaning: one entry is added when a host is disposed with a live
 * terminal window, and removed the moment that window reports itself closed or destroyed.
 */
const unownedTerminalWindows = new Map<number, { label: string; window: BrowserWindow }>();

/**
 * Answer for a terminal window whose host is gone. The window is checked on every lookup, so a
 * platform-driven death that never reached the listeners cannot leave a stale answer behind.
 */
function unownedTerminalWindowFor(webContentsId: number): { label: string; window: BrowserWindow } | undefined {
  const entry = unownedTerminalWindows.get(webContentsId);
  if (!entry) return undefined;
  let destroyed = true;
  try {
    destroyed = entry.window.isDestroyed();
  } catch {
    // A window whose native object is gone cannot be alive; the entry is worthless either way.
    destroyed = true;
  }
  if (destroyed) {
    unownedTerminalWindows.delete(webContentsId);
    return undefined;
  }
  return entry;
}

/**
 * Take responsibility for a terminal window this host could not take with it: the window stays a
 * terminal window for as long as it lives, and the entry dies with it.
 */
function keepTerminalWindowAnswerable(label: string, window: BrowserWindow): void {
  let contentsId: number;
  try {
    if (window.isDestroyed()) return;
    const contents = window.webContents;
    if (!contents || typeof contents.id !== 'number') return;
    contentsId = contents.id;
  } catch {
    // A window that cannot report its content cannot be answered for either.
    return;
  }
  // Chromium recycles a content id once its webContents is gone, so an entry is only kept for
  // the window it was made for: a later window that carries the same id replaces a dead one
  // instead of being shadowed by it. The old window's own cleanup is identity-checked, so it
  // can never delete the entry that replaced it.
  if (unownedTerminalWindows.get(contentsId)?.window === window) return;
  unownedTerminalWindows.set(contentsId, { label, window });
  const forget = (): void => {
    if (unownedTerminalWindows.get(contentsId)?.window === window) unownedTerminalWindows.delete(contentsId);
  };
  try {
    window.once('closed', forget);
  } catch (err) {
    console.warn('[native-tab-host] Failed to watch a terminal window left behind:', err);
  }
}

/**
 * Is this webContents a terminal window that no live host answers for?
 *
 * The application's auxiliary-surface lookup iterates live hosts, so a window that outlived
 * every host that could answer for it — the case this registry exists for — is invisible to it
 * even though the census proves the window is still there. The lookup asks here instead: this
 * registry is the only place that still knows such a window is a terminal window, and it stays
 * true until the window itself is gone.
 */
export function isUnhostedTerminalWindow(webContentsId: number): boolean {
  return unownedTerminalWindowFor(webContentsId) !== undefined;
}

/**
 * Which capsule owns a tab that is being created.
 *
 * Precedence, and why each step exists:
 * 1. `explicit` — the caller measured the capsule (a routed/agent tab verified against its anchor,
 *    a restored tab carrying its own, or a child inheriting the tab that opened it). A measured
 *    capsule is never second-guessed.
 * 2. `windowWorkspaceCapsuleId` — the shell's selected verified workspace. A user tab belongs to
 *    the window it was opened in, which is not necessarily the process-wide active capsule: two
 *    windows can hold different workspaces, and creating a tab in one must never file it under the
 *    other's capsule.
 * 3. `activeCapsuleId` — the last resort for a window with no verified workspace (Unassigned, a
 *    legacy window). This is the process-wide selection, so it is only correct once nothing more
 *    specific is known.
 */
export function resolveNewTabCapsuleId(input: {
  explicit?: string | null;
  windowWorkspaceCapsuleId?: string | null;
  activeCapsuleId?: string | null;
}): string | undefined {
  for (const candidate of [input.explicit, input.windowWorkspaceCapsuleId, input.activeCapsuleId]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}
/** Which presentation plane a tab switch is made for. Every caller that does not
 * declare user intent rides the agent plane: no DOM focus, and deferral to real
 * user input. */
export type SwitchPlane = 'user' | 'agent';

export interface SwitchTabOptions {
  /** Defaults to 'agent': the agent plane never takes focus and defers to fresh user input. */
  plane?: SwitchPlane;
}

/** Why an activation was refused, in the shared capability vocabulary. */
export type SwitchTabRefusalReason = 'TARGET_MISSING' | 'TARGET_NOT_ACTIVATABLE' | 'ACTIVATION_DEFERRED_USER_INPUT' | 'PROJECT_MISMATCH';

export type SwitchTabResult =
  | { ok: true; tabId: string }
  | { ok: false; tabId: string; reason: SwitchTabRefusalReason; retryAfterMs?: number };

/**
 * The project display facts the web hub's identity needs for its active project:
 * Main resolves these through `resolveWindowRecord` — the same source the Terminal
 * Manager's rows and the shell's own title read — and installs the resolver per host
 * so this module never reaches across to Main. `undefined` means Main holds no
 * validated record for the id, which is also the restore-path knownness check.
 */
export type WebHubProjectDescriptor = { title: string; pathLabel?: string };
export type WebHubProjectDescriptorResolver = (projectId: string) => WebHubProjectDescriptor | undefined;
/**
 * How recent user input has to be for an agent-plane activation to defer. The
 * window counts deliberate input only (keyDown, char, mouseDown, pointerDown,
 * mouseWheel, touchStart, contextMenu) — cursor motion never stamps.
 */
export const USER_INPUT_RECENCY_MS = 2_000;

/**
 * How long the window must have been out of focus before regaining it re-presents the
 * active tab. A quick Alt+Tab keeps its surface; a window left behind others for this
 * long is the case that came back white.
 */
export const PRESENTED_VIEW_RESURFACE_AFTER_BLUR_MS = 30_000;
/** `restore` and the `focus` that follows it arrive together: one recycle serves both. */
export const PRESENTED_VIEW_RESURFACE_DEDUPE_MS = 1_000;
export type PresentedViewResurfaceTrigger = 'show' | 'restore' | 'focus' | 'resume' | 'unlock-screen';

/** Deliberate input types that prove the user is present. Movement-only events are
 * absent on purpose: gliding the cursor to look at a lifted pane is not input. */
const USER_ACTIVITY_INPUT_TYPES: Record<string, true> = {
  keyDown: true,
  char: true,
  mouseDown: true,
  pointerDown: true,
  mouseWheel: true,
  touchStart: true,
  contextMenu: true,
};

/** A queued acquire may wait this long for the window's one lift before CAPTURE_LIFT_BUSY answers. */
export const CAPTURE_LIFT_ACQUIRE_BOUND_MS = 30_000;

/** The hard cap on a pane lifted above the user's tab: the user should never stare at someone else's pane. */
export const IN_WINDOW_CAPTURE_LIFT_MAX_MS = 10_000;

/** Where a capture lift parks its pane: on the off-screen capture host, or above the presented view inside the window. */
export type CaptureLiftOrigin = 'capture-host' | 'in-window';

/** The one held lift in a window: named, serialized per window, bounded by the raster deadline and the visible cap. */
interface CaptureLiftRecord {
  token: number;
  view: WebContentsView;
  origin: CaptureLiftOrigin;
  liftedAtMs: number;
  lease: CaptureLiftLease;
}

/**
 * The handle a capture holds across its raster. `release` is idempotent and
 * synchronous; `upgradeToInWindow` keeps the same lease and re-bounds it for the
 * repair step that re-presents the pane in the real window.
 */
export interface CaptureLiftLease {
  readonly view: WebContentsView;
  readonly origin: CaptureLiftOrigin;
  readonly liftedAtMs: number;
  readonly released: boolean;
  upgradeToInWindow(opts?: { budgetMs?: number }): boolean;
  release(reason?: string): void;
}
/** First-party network silence `reloadAndWait` requires after did-finish-load. */
export const RELOAD_SETTLE_IDLE_MS = 150;

export class NativeTabHost extends EventEmitter {
  /**
   * The window this host presents in. The shell owns the BrowserWindow and the
   * chrome views; this host owns tab identity, selection and authority. Every
   * `this.shell.window` / `this.shell.toolbarView` reference below reads that
   * ownership rather than a host-private copy.
   */
  private readonly shell: ProjectWindowShell;
  /**
   * The workspace this window's terminals belong to, resolved and validated by
   * Main. Absent means "no verified association yet", which is a real state: the
   * host then keeps the unscoped single-window behaviour instead of guessing from
   * focus or from the process-wide active capsule.
   */
  private windowWorkspaceAffiliation: WindowWorkspaceAffiliation | null = null;
  /**
   * The project the 'web' hub shell is currently presenting — set by Main's
   * window routing (S1's `openProjectWindow` path). It is NOT the workspace
   * affiliation: that stays a separate verified fact this setter never touches.
   * The value is read at mint time only — new web tabs are stamped `projectId`
   * (see `NativeTabRecord.projectId`) and new terminals mint under
   * `project:<id>` (see `terminalMintOwnerKey`).
   */
  private activeProjectId: string | null = null;
  /**
   * The tab the web hub most recently presented under each project. Updated on
   * every successful activation: a stamped tab records under its own stamp, a
   * shared (unstamped) tab records under the project being presented at the time.
   * This is a memory, not an authority — a gone or re-stamped entry is skipped on
   * read, and the map is pruned when a tab closes.
   */
  private lastActiveTabByProject: Map<string, string> = new Map();
  /**
   * The delegate Main installs to run a foreign-project activation: when a user-plane
   * switch presents a tab stamped with a different project, the host emits the id
   * here instead of writing `activeProjectId` itself, so the affiliation and the
   * identity change together on the one `activateWebHubProject` path.
   */
  private foreignProjectActivatedHandler: ((projectId: string) => void) | null = null;
  /** See `setOpenTerminalManagerHandler`. */
  private openTerminalManagerHandler: (() => void) | null = null;
  /**
   * Depth of in-flight `closeTabsForProject` loops. While a project's tabs are being
   * torn down, each close repoints presentation onto the next tab — often one of the
   * same dying project — and a flip there would hand Main the project it is removing.
   */
  private foreignFlipSuppressed = 0;
  /**
   * Main's validated-record lookup for a project id: titles the hub identity and
   * doubles as the knownness oracle the restore path validates a persisted active
   * project against. Absent means this host answers from its own fields alone.
   */
  private webHubProjectDescriptorResolver: WebHubProjectDescriptorResolver | null = null;
  /**
   * `restoreTabs` has run to its end (success or not). `setActiveProject` repoints
   * the presented tab only after this point: at boot the call lands before the
   * persisted rows are read, and a repoint then would mint a stray default tab
   * ahead of the restore.
   */
  private hasRestoredTabs = false;
  /**
   * Main's live-shell answer for the detach gate: which `project:<id>` shells exist
   * right now. The host reads it only where a routing decision needs detached-shell
   * liveness (the hub's assign-project row exception today); absent means "no detached
   * shells", which is exactly the pre-detach world.
   */
  private detachedShellProbe: ((projectId: string) => boolean) | null = null;
  /**
   * Source-side ids of rows a detach transfer already re-homed here. Live rows mint new
   * ids in this window, so this set — not `tabs` keys alone — is what makes a repeated
   * transfer delivery idempotent instead of a duplicate strip.
   */
  private transferredSourceIds: Set<string> = new Set();
  /**
   * Canonical folder facts per input path spelling — `folderKey`/`folderLabel` are stamped on
   * every session row of every window's projection, so each realpath the stamping needs is
   * paid once per spelling, not once per row per broadcast. Entries never expire on their own:
   * a capsule rename or an affiliation change renames nothing on disk, so nothing cached here
   * can be orphaned by the records it is read beside. A spelling that stops resolving keeps
   * its last answer, which is also its correct one for a deleted folder.
   */
  private folderFactsCache = new Map<string, { canonicalPath: string; folderKey: string; folderLabel: string }>();
  /** Off-screen window that hosts a background pane for one raster so MCP capture does not paint that pane over the user's tab. */
  private captureHostWindow: BrowserWindow | null = null;
  /**
   * The window's one capture lift: a bounded, serialized lease over the view
   * stack. `null` whenever no capture is borrowing a pane; the queue holds
   * acquires that arrived while it was held.
   */
  private captureLift: CaptureLiftRecord | null = null;
  private captureLiftQueue: Array<{ view: WebContentsView; opts: { inWindow?: boolean; budgetMs?: number }; grant: (lease: CaptureLiftLease) => void; reject: (err: unknown) => void; timer: NodeJS.Timeout }> = [];
  private captureLiftToken = 0;
  /** Last deliberate user input this window saw, for the agent-plane activation deferral. 0 means "never observed". */
  private lastUserInputAtMs = 0;
  private popoutWindow: BrowserWindow | null = null;
  private terminalWindows: Map<number, BrowserWindow> = new Map();
  // Per-session coalescing buffer for 'antifan:terminal:data' fan-out. PTY bursts
  // arrive as thousands of chunks/sec; each flush emits one payload per session
  // carrying the contiguous {fromSeq, throughSeq} range it covers.
  private terminalDataBatches: Map<string, { parts: string[]; fromSeq: number; throughSeq: number; generation?: number }> = new Map();
  private terminalDataFlushTimer: NodeJS.Timeout | null = null;
  // O(1) sender lookup for findTabByWebContents; entries are keyed by the live
  // WebContents so replaced views and closed tabs self-clean via GC.
  private tabByWebContents: WeakMap<Electron.WebContents, { tabId: string; tab: NativeTabRecord }> = new WeakMap();
  private terminalWindowMeta: Map<number, { sessionId?: string; isPopout?: boolean }> = new Map();
  private terminalWindowStateManager: WindowStateManager;
  private isSidebarOpen: boolean = false;
  private wasSidebarOpenBeforePopout: boolean = false;
  private isBookmarkBarVisible: boolean = false;
  private sidebarWidth: number = 380;
  // Terminal tab-strip prefs are an INNER layout of the standalone renderer —
  // they never affect this host's outer window geometry. Layout and width are this
  // window's own (owner record); a browser window defaults to the horizontal strip,
  // the Terminal Manager to the sidebar column (set in the constructor).
  private terminalTabLayout: TerminalTabLayout = 'horizontal';
  private terminalSidebarWidth: number = TERMINAL_TAB_LAYOUT_DEFAULT_WIDTH;
  private terminalCollapsedCategories: string[] = [];
  /** User-managed group names; the only representation of an empty group. */
  private terminalCategories: string[] = [];
  /** Category name -> user-chosen chip colour. Absence means "derive from the name". */
  private terminalCategoryColors: Record<string, string> = {};
  /** Categories the user marked with `*`. A marker only; `terminalCategories` orders. */
  private terminalStarredCategories: string[] = [];
  /** Project ids in the order the user dragged the Terminal Manager's project sections. */
  private terminalProjectOrder: string[] = [];
  /**
   * Shared terminal pref keys this host changed through SET_TAB_PREFS since boot. Every
   * window keeps a boot-time copy of the shared prefs; a window that never touched a key
   * must not write its stale copy over what a sibling window committed.
   */
  private touchedSharedTerminalPrefs = new Set<SharedTerminalPrefKey>();
  // Running count of 'antifan:terminal:data' payloads actually handed to
  // safeSendWebContents; readable via getResourceStats/DUMP_DIAGNOSTICS without
  // benchmark mode.
  private terminalFanoutMessages = 0;
  /**
   * Per-surface displayed-session sets for terminal data suppression. Keyed by
   * surface: `c<webContentsId>` for the sidebar, `w<windowId>` for terminal
   * windows. Refreshed on every session projection push and on terminal-window
   * binding changes; `dispatchTerminalData` reads it, never recomputes per chunk.
   */
  private terminalDisplayedSessions: Map<string, Set<string>> = new Map();
  private isToolbarOverlayActive: boolean = false;
  private toolbarOverlayCustomHeight?: number;
  private readonly splitCoordinator = new SplitNavigationCoordinator();
  private defaultUserAgent: string = chromeSessionUserAgent();
  private tabs: Map<string, NativeTabRecord> = new Map();
  private tabOrder: string[] = [];
  private activeTabId: string = '';
  private mutedSites = new Set<string>();

  public bookmarks: BookmarkItem[] = [];
  private readonly diagnosticsManager = new TabDiagnosticsManager();
  private readonly networkTracker = new FirstPartyNetworkTracker();
  private readonly previewWatcherPool = new PreviewWatcherPool();
  private readonly capsuleManager: WorkspaceCapsuleManager;
  private controlPlane: ControlPlaneRuntime | null = null;
  private activeWorkflowAbortController: AbortController | null = null;
  private documentGenerations: Map<string, number> = new Map();
  private mutationRevisions: Map<string, number> = new Map();
  private browserEpoch: number = 1;
  private tabPreviewUnsubscribers: Map<string, () => void> = new Map();
  private recentlyClosedTabs: Array<{ url: string; title: string }> = [];
  /**
   * The 60s sweep that hibernates idle tabs. Created lazily by
   * `ensureHibernationSweep`; cleared in `dispose`. `unref`'d so it can never
   * keep the process alive for a timer that only frees memory.
   */
  private hibernationSweepTimer: NodeJS.Timeout | null = null;
  /**
   * Idle threshold the sweep uses. Fixed at `HIBERNATE_IDLE_MS` in production;
   * the probe/test seam may narrow it via `setHibernationIdleMsForTesting`.
   */
  private hibernationIdleMs: number = HIBERNATE_IDLE_MS;
  /** Tabs currently being destroyed by the hibernation sweep; their `destroyed`/`close` listeners must not run `closeTab`. */
  private hibernatingTabIds = new Set<string>();
  /** Tabs whose beforeunload vetoed a sleep probe in this cycle — never re-probed. */
  private unloadVetoedTabIds = new Set<string>();
  /** In-flight `ensureTabReady` waits, deduped per tab so a burst of MCP calls shares one wake. */
  private tabReadyWaits = new Map<string, Promise<boolean>>();
  private automationTabId: string | null = null;
  private terminalAgentAffinity = new Map<string, TerminalAgentAffinityEntry>();
  private readonly sessionTabPools = new Map<string, Set<string>>();
  /**
   * Pool anchor of each recently closed tab (bounded). Closing a tab removes it from
   * every pool, which would otherwise erase the only trace of which session it belonged
   * to and leave that session unable to name a replacement target.
   */
  private readonly closedTabAnchors = new Map<string, string>();
  private tabThemeQaStates = new Map<string, TabThemeQaState>();
  /**
   * In-memory checklist scopes for storefronts whose workspace could not be
   * resolved (`origin@unknown-workspace`). No durable identity means no file:
   * these rows never reach disk and die with the host (accepted, F14).
   */
  private provisionalChecklistScopes = new Map<string, { items: ThemeChecklistItem[]; updatedAt: number }>();
  private asyncQaQueue = new AsyncThemeQaQueue();
  public readonly semanticRefRegistry = new SemanticRefRegistry();
  private semanticDocumentGenerations = new Map<string, number>();
  private targetOperationQueues = new Map<string, Promise<void>>();

  /**
   * How long an operation may wait for the tab's previous operation to settle
   * before it is refused. Generous by design: the slowest self-bounded operation in
   * this host is reloadAndWait (8-10s) plus a 2s quiescence ceiling, so a
   * predecessor still running past this bound is stuck rather than merely slow.
   */
  private static readonly TARGET_OPERATION_ACQUIRE_BOUND_MS = 15_000;

  /**
   * What currently holds each tab's operation chain. Observability only: it lets a
   * refused waiter name the holder and how long it has held, which is the difference
   * between a diagnosable refusal and an anonymous one.
   */
  private targetOperationOwners = new Map<string, { label: string; startedAt: number }>();
  private lastNavigationFailures = new Map<string, { cause: string; message: string; timedOut: boolean }>();
  private ownedReloadTokens = new Map<string, { token: string; expiresAt: number }>();

  public registerOwnedReload(tabId: string, token?: string): string {
    const effectiveToken = token || `owned-reload-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.ownedReloadTokens.set(tabId, { token: effectiveToken, expiresAt: Date.now() + 15000 });
    return effectiveToken;
  }

  public consumeOwnedReload(tabId: string, token?: string): boolean {
    // Guarded like the other maps: partial hosts may lack ownedReloadTokens.
    if (!this.ownedReloadTokens) return false;
    const entry = this.ownedReloadTokens.get(tabId);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.ownedReloadTokens.delete(tabId);
      return false;
    }
    if (token && entry.token !== token) {
      return false;
    }
    this.ownedReloadTokens.delete(tabId);
    return true;
  }
  public agentInputInFlight = 0;
  private viewportGate: ViewportGate | null = null;

  public setViewportGate(gate: ViewportGate): void {
    this.viewportGate = gate;
  }

  public syncWithAgentInput<T>(action: () => T): T {
    this.agentInputInFlight++;
    try {
      return action();
    } finally {
      this.agentInputInFlight = Math.max(0, this.agentInputInFlight - 1);
    }
  }
  /**
   * The async twin of `syncWithAgentInput`: the attribution counter stays
   * incremented across the awaited work, so a CDP `Input.*` dispatch can never
   * surface as a `mouseDown` on the recency clock and defer a later activation.
   */
  public async withAgentInput<T>(action: () => Promise<T>): Promise<T> {
    this.agentInputInFlight++;
    try {
      return await action();
    } finally {
      this.agentInputInFlight = Math.max(0, this.agentInputInFlight - 1);
    }
  }

  /**
   * Stamp the window's user-presence clock from a real `input-event`. Deliberate
   * input types only — cursor motion does not stamp — and never while agent
   * input is in flight, so the agent cannot mark the user present for itself.
   * A pane lifted in-window above the user's tab is buried at once: the user
   * gets their pane back mid-raster while the lease stays held, so the in-flight
   * capture fails closed instead of resurrecting the lift.
   */
  public noteUserActivity(inputType: string): void {
    if (this.agentInputInFlight !== 0) return;
    if (!USER_ACTIVITY_INPUT_TYPES[inputType]) return;
    this.lastUserInputAtMs = Date.now();
    if (this.captureLift?.origin === 'in-window') {
      this.buryCaptureLift('user-input');
    }
  }

  private trackUserActivityOnView(wc: Electron.WebContents | null | undefined): void {
    if (!wc || typeof wc.on !== 'function') return;
    wc.on('input-event', (_event: unknown, input: { type?: string }) => {
      this.noteUserActivity(input?.type || '');
    });
  }

  /** True while deliberate user input in this window is younger than the recency bound. */
  public userInputRecentlySeen(): boolean {
    return this.lastUserInputAtMs > 0 && Date.now() - this.lastUserInputAtMs < USER_INPUT_RECENCY_MS;
  }

  public getActiveCapsule(): WorkspaceCapsule | null {
    return this.capsuleManager ? this.capsuleManager.getActive() : null;
  }

  /**
   * The one open project + workspace a capsule belongs to, or undefined when nothing claims it
   * unambiguously.
   *
   * A record that carries both ids is taken at its word — affiliation was validated when it was
   * written. A record that carries neither is a legacy one, and its directory decides: the registry
   * answers only when exactly one open project attaches that root, so a folder two projects attach
   * resolves to nothing. That refusal is the point: the capsule list answers `resolvedProjectId`
   * only for a capsule whose project can be named, and guessing one would hand its row to a window
   * the user never chose.
   */
  private capsuleAffiliation(capsule: WorkspaceCapsule): CapsuleAffiliation | undefined {
    const projectId = typeof capsule.projectId === 'string' ? capsule.projectId.trim() : '';
    const workspaceId = typeof capsule.workspaceId === 'string' ? capsule.workspaceId.trim() : '';
    if (projectId && workspaceId) return { projectId, workspaceId };
    return this.capsuleManager.uniqueAffiliationByRoot(capsule.workspacePath);
  }

  /**
   * Owner key for a Terminal Manager mint into `folder`. The manager owns no folder, so the
   * folder's one open project owns the new row; a folder no project claims unambiguously stays
   * the manager's own key, which is what files it under "Chưa gắn dự án" for triage.
   */
  public managerFolderMintOwnerKey(folder: string, capsule: WorkspaceCapsule | null | undefined, senderId: number | undefined): string | undefined {
    const affiliation = capsule ? this.capsuleAffiliation(capsule) : this.capsuleManager.uniqueAffiliationByRoot(folder);
    return affiliation ? `project:${affiliation.projectId}` : this.shellOwnerKeyForSender(senderId);
  }


  /**
   * Whether a window currently owns an owner key, as Main's window directory answers it.
   *
   * A seam that is absent, or that fails, answers "absent": the hand-over is refused rather than
   * performed against a window nothing can prove exists.
   */
  private ownerWindowPresenceFor(ownerKeyValue: string): boolean {
    const presence = this.ownerWindowPresence;
    if (!presence) return false;
    try {
      return presence(ownerKeyValue) === true;
    } catch (err) {
      console.warn(`[native-tab-host] window presence for '${ownerKeyValue}' could not be read:`, err);
      return false;
    }
  }

  public get isInspecting(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsInspecting() : false;
  }
  public set isInspecting(val: boolean) {
    this.getDevToolsHost().setIsInspecting(val);
  }
  public get isFontFinderActive(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsFontFinderActive() : false;
  }
  public set isFontFinderActive(val: boolean) {
    this.getDevToolsHost().setIsFontFinderActive(val);
  }
  public get isLensActive(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsLensActive() : false;
  }
  public set isLensActive(val: boolean) {
    this.getDevToolsHost().setIsLensActive(val);
  }
  public get isRulerActive(): boolean {
    return this.devToolsHost ? this.devToolsHost.getIsRulerActive() : false;
  }
  public set isRulerActive(val: boolean) {
    this.getDevToolsHost().setIsRulerActive(val);
  }
  public get inspectedTabId(): string | null {
    return this.devToolsHost ? this.devToolsHost.getInspectedTabId() : null;
  }
  public set inspectedTabId(val: string | null) {
    this.getDevToolsHost().setInspectedTabId(val);
  }
  public get inspectGeneration(): number {
    return this.devToolsHost ? this.devToolsHost.inspectGeneration : 0;
  }
  public set inspectGeneration(val: number) {
    this.getDevToolsHost().inspectGeneration = val;
  }
  public get agentWorkingRefs(): Map<string, number> {
    return this.getAutomationHost().agentWorkingRefs;
  }
  public set agentWorkingRefs(val: Map<string, number>) {
    this.getAutomationHost().agentWorkingRefs = val;
  }
  public get agentWorkingTimers(): Map<string, NodeJS.Timeout> {
    return this.getAutomationHost().agentWorkingTimers;
  }
  public set agentWorkingTimers(val: Map<string, NodeJS.Timeout>) {
    this.getAutomationHost().agentWorkingTimers = val;
  }
  private devToolsHost?: TabDevToolsHost;
  private getDevToolsHost(): TabDevToolsHost {
    if (!this.devToolsHost) {
      this.devToolsHost = new TabDevToolsHost({
        getTabWebContents: (tabId, paneId) => this.getTabWebContents(tabId, paneId),
        getTabRecord: (tabId) => this.tabs?.get(tabId),
        getActiveTabId: () => this.activeTabId,
        getAllTabs: () => (this.tabs ? this.tabs.entries() : [][Symbol.iterator]()),
        broadcastState: () => this.broadcastState(),
        emitInspectToggled: (active) => this.emit('inspect-toggled', active),
        emitElementPicked: (picked) => this.emit('element-picked', picked),
        sendToolbarElementPicked: (picked) => safeSendWebContents(this.shell.toolbarView?.webContents, TOOLBAR_CHANNELS.ELEMENT_PICKED, picked),
        getTabTerminalSession: (tabId) => this.getTabTerminalSession(tabId),
        visibleTerminalSessions: () => this.visibleTerminalSessions(),
        resolveTargetWorkspace: (targetSessionId, tabUrl) => this.resolveTargetWorkspace(targetSessionId, tabUrl),
        resolveAnnotationWorkspace: (targetSessionId, tabUrl) => this.resolveAnnotationWorkspace(targetSessionId, tabUrl),
        windowActiveSessionId: () => this.windowActiveSessionId(),
        getDiagnostics: (tabId, level) => (this.diagnosticsManager && typeof this.diagnosticsManager.getDiagnostics === 'function') ? this.diagnosticsManager.getDiagnostics(tabId, level as any) : null,
        createTab: (url, activate) => this.createTab(url, activate),
        withTabAgentWorking: (tabId, action) => this.withTabAgentWorking(tabId, action),
        runWithAttachedTabView: (view, action, isMobile) => this.runWithAttachedTabView(view, action, isMobile),
        getTabContentBounds: (tabId, paneId) => this.getTabContentBounds(tabId, paneId),
        // Declared 'user' so the seam is unambiguous: a capture never switches
        // tabs, and anything this host activates is for the person watching.
        switchTab: (tabId, opts) => this.switchTab(tabId, { plane: 'user', ...opts }),
        getSemanticDocumentGeneration: (tabId, paneId) => this.getSemanticDocumentGeneration(tabId, paneId),
        getLegacyDocumentGeneration: (tabId) => (this.getDocumentGeneration ? this.getDocumentGeneration(tabId) : (this.documentGenerations?.get(tabId) || 0)),
        getMutationRevision: (tabId) => (this.mutationRevisions ? (this.mutationRevisions.get(tabId) || 0) : 0),
        getTabUrl: (tabId) => this.getTabUrl(tabId),
        getRedirectChain: (tabId) => this.getRedirectChain(tabId),
        getLastNavigationFailure: (tabId) => this.getLastNavigationFailure(tabId),
        updateLayout: () => this.updateLayout(),
        applyTabDeviceEmulation: (tabId: string) => this.applyTabDeviceEmulationForTab(tabId),
        isTabViewAttached: (view) => this.isTabViewAttached(view),
        reassertPresentedView: () => this.reassertPresentedView(),
        acquireCaptureLift: (view, opts) => this.acquireCaptureLift(view, opts),
        captureLiftState: () => this.captureLiftState(),
        isWindowRenderable: () => !this.shell.window.isDestroyed() && this.shell.window.isVisible() && !this.shell.window.isMinimized(),
        getWindowPresentationState: () => ({
          visible: !this.shell.window.isDestroyed() && this.shell.window.isVisible(),
          minimized: !this.shell.window.isDestroyed() && this.shell.window.isMinimized(),
          maximized: !this.shell.window.isDestroyed() && this.shell.window.isMaximized(),
        }),
      });
    }
    return this.devToolsHost;
  }
  private persistTimer: NodeJS.Timeout | null = null;
  private titleBroadcastTimer?: NodeJS.Timeout;
  private titleBroadcastDeadline = 0;
  private automationHost?: TabAutomationHost;

  private getAutomationHost(): TabAutomationHost {
    if (!this.automationHost) {
      this.automationHost = new TabAutomationHost({
        getTabWebContents: (tabId, paneId) => this.getTabWebContents(tabId, paneId),
        getTabRecord: (tabId) => this.tabs?.get(tabId),
        getAutomationTabId: () => this.automationTabId,
        getActiveTabId: () => this.activeTabId,
        getBrowserEpoch: () => this.browserEpoch,
        getSemanticDocumentGeneration: (tabId, paneId) => (this.getSemanticDocumentGeneration ? this.getSemanticDocumentGeneration(tabId, paneId) : 0),
        getLegacyDocumentGeneration: (tabId) => (this.getDocumentGeneration ? this.getDocumentGeneration(tabId) : (this.documentGenerations?.get(tabId) || 0)),
        semanticRefRegistry: this.semanticRefRegistry,
        runTargetOperation: (tabId, paneId, op) => this.runTargetOperation(tabId, paneId, op),
        broadcastState: () => this.broadcastState(),
        syncFrameBackdrop: () => this.syncFrameBackdrop(),
        getAllTabs: () => this.tabs ? this.tabs.entries() : [][Symbol.iterator](),
        applyTabThrottling: () => this.applyTabThrottling(),
        tabDevToolsHost: this.getDevToolsHost(),
        resolveTargetWorkspace: (targetSessionId, tabUrl) => this.resolveTabStrictWorkspace(targetSessionId, tabUrl),
        getTabTerminalSession: (tabId) => this.getTabTerminalSession(tabId),
        sendKeyboardPress: (params) => this.sendKeyboardPress(params),
        withAgentInput: (action) => this.withAgentInput(action),
        navigateAndWait: (tabId, inputUrl, timeoutMs) => this.navigateAndWait(tabId, inputUrl, timeoutMs),
      });
    }
    return this.automationHost;
  }
  private appliedClipRadius = new WeakMap<Electron.WebContents, number>();
  private touchEmulationStates = new WeakMap<Electron.WebContents, {
    desired: boolean;
    settled: boolean;
    promise: Promise<void>;
  }>();
  private pendingEmulationDeferrals = new WeakMap<Electron.WebContents, {
    preset: DevicePreset | null | undefined;
    scale: number;
  }>();
  private destroyOwnedWebContents(wc: Electron.WebContents | null | undefined): void {
    if (!wc || wc.isDestroyed()) return;
    // Electron 43 exposes destroy() at runtime but omits it from the WebContents declaration.
    const destroyableWebContents = wc as Electron.WebContents & { destroy?: () => void };
    destroyableWebContents.destroy?.();
  }


  /** Benchmark-mode helper: counts attached desktop+mobile views; no behavior. */
  private countAttachedViews(): number {
    if (!this.shell.window || this.shell.window.isDestroyed() || !this.shell.window.contentView) return 0;
    let count = 0;
    for (const [, tab] of this.tabs.entries()) {
      try {
        if (tab.view && this.shell.window.contentView.children.includes(tab.view)) count += 1;
        if (tab.mobileView && this.shell.window.contentView.children.includes(tab.mobileView)) count += 1;
      } catch {}
    }
    return count;
  }
  public getResourceStats(): NativeTabHostResourceStats {
    const devTools = this.devToolsHost?.getStats() ?? {
      attachedWebContentsCount: 0,
      hostOwnedAttachmentCount: 0,
      listenerTargetCount: 0,
      queuedTargetCount: 0,
      drainingTargetCount: 0,
      stylesheetTargetCount: 0,
      isolatedContextCount: 0,
      trackerIsolationTargetCount: 0,
    };
    return {
      disposed: this.isDisposed,
      terminalFanoutMessages: this.terminalFanoutMessages,
      tabCount: this.tabs.size,
      attachedTabViewCount: this.countAttachedViews(),
      terminalWindowCount: this.terminalWindows.size,
      terminalWindowMetadataCount: this.terminalWindowMeta.size,
      previewWatcherCount: this.previewWatcherPool.getActiveWatcherCount(),
      previewSubscriptionCount: this.tabPreviewUnsubscribers.size,
      targetOperationQueueCount: this.targetOperationQueues.size,
      agentWorkingTimerCount: this.automationHost?.agentWorkingTimers.size ?? 0,
      agentWorkingRefCount: this.automationHost?.agentWorkingRefs.size ?? 0,
      network: this.networkTracker.getStats(),
      devTools,
      terminal: TerminalManager.getInstance().getStats(),
      controlPlane: this.controlPlane?.getResourceStats() ?? null,
    };
  }


  public getSemanticDocumentGeneration(tabId: string, paneId?: string): number {
    const key = makeTargetKey(tabId, paneId);
    return this.semanticDocumentGenerations.get(key) || 1;
  }

  public setSemanticDocumentGeneration(tabId: string, paneId: string | undefined, gen: number): void {
    const key = makeTargetKey(tabId, paneId);
    this.semanticDocumentGenerations.set(key, gen);
  }

  public async runTargetOperation<T>(tabId: string, paneId: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (this.isDisposed) {
      throw new CapabilityError('RUNTIME_DRAINING', 'NativeTabHost is disposed');
    }
    const key = makeTargetKey(tabId, paneId);
    // Partial hosts (Object.create without field initializers) lack the queue
    // map; run the operation directly rather than crashing on .get of undefined.
    if (!this.targetOperationQueues) {
      return operation();
    }
    const previousTail = this.targetOperationQueues.get(key) || Promise.resolve();

    let resolveTail!: () => void;
    const currentTail = new Promise<void>((resolve) => {
      resolveTail = resolve;
    });

    this.targetOperationQueues.set(key, currentTail);

    const label = operation.name || 'anonymous-operation';
    const ownerRecord = { label, startedAt: Date.now() };
    try {
      // Waiting on this tail without a bound is what turns one stuck operation into a
      // permanently dead tab: every later capability queues behind the same tail and
      // never answers, so callers observe silence instead of an error. Refusing is the
      // only fail-closed option available, and a refusal still resolves this
      // operation's own tail, so a refused waiter can never become the next wedge.
      const predecessorSettled = await settleWithinBound(previousTail, NativeTabHost.TARGET_OPERATION_ACQUIRE_BOUND_MS);
      if (!predecessorSettled) {
        const holder = this.targetOperationOwners?.get(key);
        const heldForMs = holder ? Date.now() - holder.startedAt : undefined;
        throw new CapabilityError(
          'WAIT_TIMEOUT',
          `Operation '${label}' cannot start on tab '${tabId}' pane '${paneId ?? 'desktop'}': the previous operation on this tab has not settled within ${NativeTabHost.TARGET_OPERATION_ACQUIRE_BOUND_MS}ms` +
            (holder ? ` (holder '${holder.label}', holding for ${heldForMs}ms)` : ' (holder unknown: it began before this host observed the chain)') +
            '. This tab refuses further serialized work until that operation settles or the runtime restarts; retry, or operate on a different tab.',
          {
            tabId,
            paneId,
            operation: label,
            acquireBoundMs: NativeTabHost.TARGET_OPERATION_ACQUIRE_BOUND_MS,
            ...(holder ? { holder: holder.label, heldForMs } : {}),
          }
        );
      }
      if (this.isDisposed) {
        throw new CapabilityError('RUNTIME_DRAINING', 'NativeTabHost disposed before operation began');
      }
      // The bound is measured from the moment work actually starts, not from queue
      // entry, so a holder that waited a long time is not reported as stuck for it.
      // Guarded like every other map in this class: the owner map exists for
      // observability, and several tests drive this method on a host built by hand
      // without field initializers, so an observability aid must never be the reason
      // the operation it observes fails.
      ownerRecord.startedAt = Date.now();
      if (this.targetOperationOwners) {
        this.targetOperationOwners.set(key, ownerRecord);
      }
      return await operation();
    } finally {
      // Optional-chained on purpose: this block runs while an exception from the try body
      // (a designed failure path, e.g. preflight rejection) is already in flight. Reading
      // .get off undefined here threw a TypeError that REPLACED the real error, so the
      // caller saw "cannot read properties of undefined" instead of why its operation
      // failed. A finally block must never mask the exception it is unwinding.
      if (this.targetOperationOwners?.get(key) === ownerRecord) {
        this.targetOperationOwners.delete(key);
      }
      resolveTail();
      if (this.targetOperationQueues.get(key) === currentTail) {
        this.targetOperationQueues.delete(key);
      }
    }
  }


  private getCanGoBack(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoBack?: () => boolean } }).navigationHistory;
      if (nav && typeof nav.canGoBack === 'function') return Boolean(nav.canGoBack());
      if (typeof (wc as unknown as { canGoBack?: () => boolean }).canGoBack === 'function') {
        return Boolean((wc as unknown as { canGoBack: () => boolean }).canGoBack());
      }
    } catch {}
    return false;
  }

  private getCanGoForward(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoForward?: () => boolean } }).navigationHistory;
      if (nav && typeof nav.canGoForward === 'function') return Boolean(nav.canGoForward());
      if (typeof (wc as unknown as { canGoForward?: () => boolean }).canGoForward === 'function') {
        return Boolean((wc as unknown as { canGoForward: () => boolean }).canGoForward());
      }
    } catch {}
    return false;
  }

  private safeGoBack(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoBack?: () => boolean; goBack?: () => void } }).navigationHistory;
      if (nav && typeof nav.canGoBack === 'function' && nav.canGoBack()) {
        if (typeof nav.goBack === 'function') nav.goBack();
        return true;
      }
    } catch {}
    return false;
  }

  private safeGoForward(wc: Electron.WebContents | null | undefined): boolean {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return false;
    try {
      const nav = (wc as unknown as { navigationHistory?: { canGoForward?: () => boolean; goForward?: () => void } }).navigationHistory;
      if (nav && typeof nav.canGoForward === 'function' && nav.canGoForward()) {
        if (typeof nav.goForward === 'function') nav.goForward();
        return true;
      }
    } catch {}
    return false;
  }
  constructor(shell: ProjectWindowShell, capsuleManager?: WorkspaceCapsuleManager) {
    super();
    this.shell = shell;
    const stateDir = app ? app.getPath('userData') : StorageLocations.getConfigDir();
    this.terminalWindowStateManager = new WindowStateManager(stateDir, 900, 600, 'terminal-popout-window-state.json');
    this.capsuleManager = capsuleManager || new WorkspaceCapsuleManager({ filePath: path.join(stateDir, 'workspace-capsules.json') });
    this.getAutomationHost();
    this.getDevToolsHost();

    // The Terminal Manager is itself a sidebar surface: its tab strip opens as the sidebar
    // column unless the user chose otherwise in that window.
    if (this.isTerminalOnlyWindow()) this.terminalTabLayout = 'sidebar';
    // Pre-load saved sidebar state so initial layout matches persisted user intent (no auto-open flash)
    const savedTabsPath = path.join(stateDir, 'saved-tabs.json');
    if (fs.existsSync(savedTabsPath)) {
      try {
        const raw = fs.readFileSync(savedTabsPath, 'utf8');
        const data = JSON.parse(raw);
        this.restoreMutedSites(data.mutedSites);
        // The Terminal Manager's sidebar is the whole window and never closes (the shell is born
        // open); a persisted "closed" from a project window must not shrink it to 0x0.
        if (typeof data.isSidebarOpen === 'boolean' && !this.shell.isTerminalOnly()) {
          this.shell.isSidebarOpen = data.isSidebarOpen;
        }
        if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 260 && data.sidebarWidth <= 850) {
          this.shell.sidebarWidth = data.sidebarWidth;
        }
        this.restoreWindowTerminalLayout(data);
        this.applyTerminalTabPrefs({ collapsedCategories: data.terminalCollapsedCategories });
      } catch {}
    } else {
      const activeCapsule = this.capsuleManager.getActive();
      if (typeof activeCapsule?.state?.sidebarOpen === 'boolean' && !this.shell.isTerminalOnly()) {
        this.shell.isSidebarOpen = activeCapsule.state.sidebarOpen;
      }
      if (typeof activeCapsule?.state?.sidebarWidth === 'number' && activeCapsule.state.sidebarWidth >= 260 && activeCapsule.state.sidebarWidth <= 850) {
        this.shell.sidebarWidth = activeCapsule.state.sidebarWidth;
      }
    }
    if (!this.capsuleManager.getActive()) {
      const defaultDir = fs.existsSync('E:/Work') ? 'E:/Work' : (fs.existsSync('E:\\Work') ? 'E:\\Work' : process.cwd());
      this.capsuleManager.create('Default Workspace', defaultDir, {
        sidebarOpen: this.shell.isSidebarOpen,
        sidebarWidth: this.shell.sidebarWidth,
      });
    }
    // Chrome views are created and owned by the shell. The host only wires the
    // behaviour it owns: the backdrop context menu and the terminal projection.
    if (this.shell.frameBackdropView) {
      this.setupBackdropContextMenu(this.shell.frameBackdropView.webContents);
    }
    if (this.shell.sidebarView) {
      this.shell.sidebarView.webContents.on('did-finish-load', () => {
        // The first paint is scoped exactly like every later push: a window with no capsule
        // of its own shows the sessions no project claimed, never the process-wide list.
        const contents = this.shell.sidebarView?.webContents;
        if (!contents || contents.isDestroyed()) return;
        const projection = this.terminalStateForWindow(
          TerminalManager.getInstance().getSessionState(),
          undefined,
          contents.id,
        );
        this.terminalDisplayedSessions.set(`c${contents.id}`, this.displayedSessionIdsOf(projection));
        safeSendWebContents(contents, 'antifan:terminal:session', projection);
      });
    }

    this.updateLayout();

    this.shell.onResize(() => {
      this.updateLayout();
    });
    // A window coming back from hidden/minimized, from a long stretch behind other windows,
    // or from sleep / a locked screen can hold an attached view Windows stopped compositing:
    // the page keeps running but paints white. `updateLayout` only invalidates an attached
    // view, which does not restart its frames, so these re-present it instead.
    this.shell.onShow(() => {
      this.updateLayout();
      this.resurfacePresentedView('show');
    });
    this.shell.onRestore(() => {
      this.updateLayout();
      this.resurfacePresentedView('restore');
    });
    this.shell.onBlur(() => this.noteWindowBlurred());
    this.shell.onFocus(() => this.noteWindowFocused());
    // The 60s idle sweep is per-host: it frees renderers for background tabs of
    // THIS window only, so it is created here with the subscriptions and cleared
    // by dispose. The timer is unref'd — it never keeps the process alive.
    this.ensureHibernationSweep();

    this.setupTerminalSubscriptions();
    this.setupVaultIpc();
    installChromeIpcOnce(NativeTabHost.CHROME_ROUTES);
    this.setupGlobalShortcutsOnView(this.shell.toolbarView?.webContents);
    // Deliberate input on the chrome surfaces counts as user presence too: the
    // sidebar is the terminal surface, so typing in it defers an agent-plane
    // activation exactly like typing in a page. Terminal popout windows stay
    // out of scope — they belong to a different BrowserWindow.
    this.trackUserActivityOnView(this.shell.toolbarView?.webContents);
    this.trackUserActivityOnView(this.shell.sidebarView?.webContents);
  }

  public getToolbarHeight(): number {
    return this.shell.getToolbarHeight(this.bookmarks.length > 0, this.isBookmarkBarVisible);
  }

  public updateLayout(): void {
    const toolbarHeight = this.getToolbarHeight();
    const geometry = this.shell.getContentGeometry(toolbarHeight);
    // A destroyed window has no geometry to lay out: the shell reports that absence instead of
    // raising, so a resize, restore or layout request arriving during teardown reports on
    // nothing rather than aborting the step after it.
    if (!geometry) return;
    const { availableWidth, availableHeight } = geometry;
    const layoutStartMs = performance.now();

    this.shell.applyChromeBounds(geometry, {
      active: this.isToolbarOverlayActive,
      extraHeight: this.toolbarOverlayCustomHeight ?? 0,
    });

    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab && tab.view && !tab.state.ephemeral) {
        if (!this.isTabViewAttached(tab.view)) {
          try { this.attachTabView(tab.view, false); } catch {}
        }
        if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed() && !this.isTabViewAttached(tab.mobileView)) {
          try { this.attachTabView(tab.mobileView, true); } catch {}
        }
        this.applyTabDeviceEmulation(tab, availableWidth, availableHeight, toolbarHeight);
        if (tab.view.webContents && !tab.view.webContents.isDestroyed() && typeof tab.view.webContents.invalidate === 'function') {
          try { tab.view.webContents.invalidate(); } catch {}
        }
        if (tab.mobileView?.webContents && !tab.mobileView.webContents.isDestroyed() && typeof tab.mobileView.webContents.invalidate === 'function') {
          try { tab.mobileView.webContents.invalidate(); } catch {}
        }
      }
    }


    // 5. Broadcast to Frame Backdrop
    if (isBenchmarkEnabled()) {
      recordBenchmark({ surface: 'tabs', name: 'layout', value: performance.now() - layoutStartMs, extra: { width: geometry.width, height: geometry.height, attachedViews: this.countAttachedViews() } });
    }
    this.enforceZOrder();
    this.syncFrameBackdrop();
  }

  /**
   * A tab or chrome view's contents while that view can still be asked anything, or undefined
   * once it cannot. A view whose native object is gone raises on the property read itself, and
   * that read sits on the teardown path — a throttle pass or backdrop sync over a window being
   * torn down must report on a dead surface, not abort the step that called it.
   */
  private liveViewContents(view: Electron.WebContentsView | null | undefined): Electron.WebContents | undefined {
    if (!view) return undefined;
    try {
      const contents = view.webContents;
      if (!contents || contents.isDestroyed()) return undefined;
      return contents;
    } catch {
      return undefined;
    }
  }

  private syncFrameBackdrop(): void {
    const backdrop = this.liveViewContents(this.shell?.frameBackdropView);
    if (!backdrop) return;
    // Geometry is absent once the window is gone; the shell answers that as a fact, and without
    // it there is no surface left to publish a layout to.
    const geometry = this.shell.getContentGeometry(this.getToolbarHeight());
    if (!geometry) return;
    const { availableWidth, availableHeight } = geometry;
    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;

    const isAgentWorking = Boolean(activeTab && activeTab.state.aiState === 'agent_working');
    if (activeTab && activeTab.state.splitMode) {
      const userZoom = activeTab.state.zoomFactor || 1.0;
      const splitLayout = calculateSplitLayout(
        { width: availableWidth, height: availableHeight, yOffset: 0 },
        activeTab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET,
        activeTab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET,
        userZoom
      );
      const payload = {
        splitMode: true,
        focusedPane: activeTab.focusedPane || activeTab.state.splitFocusedPane || 'desktop',
        desktopFrame: splitLayout.desktopFrame,
        mobileFrame: splitLayout.mobileFrame,
        containerWidth: availableWidth,
        containerHeight: availableHeight,
        url: activeTab.state.url || '',
        agentWorking: isAgentWorking,
      };
      safeSendWebContents(backdrop, FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT, payload);
    } else {
      safeSendWebContents(backdrop, FRAME_BACKDROP_CHANNELS.UPDATE_LAYOUT, {
        splitMode: false,
        focusedPane: 'desktop',
        containerWidth: availableWidth,
        containerHeight: availableHeight,
        agentWorking: isAgentWorking,
      });
    }
  }

  private setupTerminalSubscriptions(): void {
    // Every listener below is registered on the shared singleton, so it has to be
    // removable by this host: `dispose()` releases exactly the handlers this instance
    // registered, never another window's.
    // The listener type is derived from EventEmitter itself rather than respelled, so it
    // cannot drift from the emitter contract this call has to satisfy.
    const subscribe = (event: string, handler: Parameters<EventEmitter['on']>[1]): void => {
      TerminalManager.getInstance().on(event, handler);
      this.terminalSubscriptionReleases?.push(() => {
        try { TerminalManager.getInstance().removeListener(event, handler); } catch {}
      });
    };
    // Routed delivery: TerminalOutputRouter holds the single `data` listener on the
    // seam and hands each chunk only to hosts whose session map includes it, so this
    // path performs no visibility check per chunk. The unregister releases with the
    // rest of this host's subscriptions at dispose.
    const unregisterRoute = TerminalOutputRouter.getInstance().registerHost(this);
    this.terminalSubscriptionReleases?.push(() => {
      try { unregisterRoute(); } catch {}
    });

    const onTerminalSession = (state: unknown): void => {
      // Session state must never overtake buffered output for the same session.
      this.flushAllTerminalDataBatches();
      this.sendTerminalProjections(state);
    };
    subscribe('session', onTerminalSession);

    const onTerminalSessionClosed = ({ id }: { id: string }): void => {
      // Deliver any buffered output for the closing session before the close
      // notification so subscribers never see close precede its final data.
      this.flushTerminalDataBatch(id);
      this.clearTerminalAgentAffinity(id);
    };
    subscribe('session-closed', onTerminalSessionClosed);

    const onTerminalSessionRestarted = ({ id, generation }: { id: string; generation: number }): void => {
      this.flushTerminalDataBatch(id);
      this.migrateTerminalAgentAffinityGeneration(id, generation);
    };
    subscribe('session-restarted', onTerminalSessionRestarted);
    // Sleep is not a close: the session record survives with its affinity intact, so
    // a wake must NOT migrate the generation key — `wakeSession` reuses the reserved
    // generation, which is exactly the generation the affinity entry is keyed under.
    // The wake does have to lift any tombstone written while the session slept: a
    // bound browser tab that closed during the nap leaves `closedAt` set, and
    // `isTerminalAllowedForTab` rejects a tombstoned entry outright, which would
    // wedge the agent that owns the terminal. `reviveTerminalAgentAffinity` also
    // repairs the entry, because the next affinity read would otherwise re-arm it.
    const onTerminalSessionWoken = (payload: { id: string; generation?: number | string }): void => {
      const id = payload?.id;
      if (!id) return;
      this.flushTerminalDataBatch(id);
      this.reviveTerminalAgentAffinity(id, payload?.generation);
      // The repair changes what buildPersistData writes — `closedAt` no longer
      // suppresses the entry — so the wake has to save the repaired shape.
      this.schedulePersist();
    };
    subscribe('session-woken', onTerminalSessionWoken);

    const onTerminalSessionCreated = ({ id, parentId, generation }: { id: string; parentId?: string; generation?: number }): void => {
      let targetTab: string | undefined = undefined;
      if (parentId) {
        const parentAffinity = this.getTerminalAgentAffinity(parentId);
        if (parentAffinity && parentAffinity.status === 'alive') {
          targetTab = parentAffinity.tabId;
        }
      }
      if (targetTab && this.hasTab(targetTab)) {
        const existing = this.getTerminalAgentAffinity(id, generation);
        if (!existing || existing.status === 'closed') {
          this.bindTerminalAgentAffinity(id, generation || 1, targetTab);
        }
      }
    };
    subscribe('session-created', onTerminalSessionCreated);

    const onBridgeHealthChanged = (): void => {
      const report = buildBridgeHealthReport();
      if (this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
        safeSendWebContents(this.shell.sidebarView.webContents, BRIDGE_CHANNELS.STATUS_CHANGED, report);
      }
      for (const [id, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          safeSendWebContents(win.webContents, BRIDGE_CHANNELS.STATUS_CHANGED, report);
        } else {
          this.terminalWindows.delete(id);
        }
      }
    };
    const unsubscribeBridgeHealth = subscribeBridgeHealth(onBridgeHealthChanged);
    this.terminalSubscriptionReleases?.push(() => {
      try { unsubscribeBridgeHealth(); } catch {}
    });

    const wireRunStateService = (service: RunStateService): void => {
      const onRunStateChange = (payload?: unknown): void => {
        void (async () => {
          try {
            const runs = Array.isArray(payload) ? (payload as RunCardState[]) : await service.getRuns();
            if (this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
              safeSendWebContents(
                this.shell.sidebarView.webContents,
                TERMINAL_CHANNELS.RUN_STATE,
                { runs: this.runCardsForWindow(runs, this.shell.sidebarView.webContents.id) }
              );
            }
            for (const [id, win] of this.terminalWindows.entries()) {
              if (win && !win.isDestroyed()) {
                const boundSessionId = this.terminalWindowMeta.get(id)?.sessionId;
                safeSendWebContents(
                  win.webContents,
                  TERMINAL_CHANNELS.RUN_STATE,
                  { runs: this.runCardsForWindow(runs, win.webContents.id, boundSessionId) }
                );
              } else {
                this.terminalWindows.delete(id);
              }
            }
          } catch (err) {
            console.warn('[native-tab-host] failed to push run state:', err);
          }
        })();
      };
      service.on('change', onRunStateChange);
      this.terminalSubscriptionReleases?.push(() => {
        try { service.removeListener('change', onRunStateChange); } catch {}
      });
    };

    this.wireRunStateService = wireRunStateService;
    if (this.runStateService) {
      wireRunStateService(this.runStateService);
    }
  }

  private setupVaultIpc(): void {
    LocalSessionVault.getInstance().registerIpcHandlers(
      (_event?: unknown, payload?: unknown) => {
        const options = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : undefined;
        // Explicit tabId requested: ensure authority and return that tab's session.
        // An in-memory ephemeral tab is refused outright — writing credentials there
        // "succeeds" and then evaporates with the tab, which is exactly the failure
        // this resolver exists to prevent. Capsule tabs are durable and isolated, so
        // an authorized agent may still target them explicitly.
        if (typeof options?.tabId === 'string' && options.tabId.length > 0) {
          const tabId = options.tabId;
          const tab = this.tabs.get(tabId);
          if (!tab) return null;
          const sender = this.getEventSenderWebContents(_event);
          const senderInfo = this.findTabByWebContents(sender);
          const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === this.automationTabId);
          if (isAgent && senderInfo.tabId !== tabId) {
            return null;
          }
          if (tab.state.ephemeral === true || (tab.state.partition || '').startsWith('ephemeral-')) {
            return null;
          }
          return this.getTabSession(tabId);
        }
        if (typeof options?.profileId === 'string' && options.profileId.length > 0) {
          return this.resolveTargetProfileSession(options.profileId);
        }
        if (typeof options?.partition === 'string' && options.partition.length > 0) {
          if (this.isValidCapsulePartition(options.partition)) {
            return session.fromPartition(options.partition);
          }
          return null;
        }
        // Non-ambient target: hydration/vault operations target the shared profile session,
        // never implicitly reading or mutating the user's focused tab without explicit authority
        return this.resolveTargetProfileSession();
      },
      {
        validateSender: (event: unknown): boolean => {
          if (!isTrustedSessionVaultSender(event)) {
            const sender = this.getEventSenderWebContents(event);
            const senderInfo = this.findTabByWebContents(sender);
            const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === this.automationTabId);
            if (!isAgent) return false;
          }
          return true;
        },
        resolveAttachmentBinding: (
          event: unknown,
          payload?: unknown
        ): { valid: boolean; attachmentId?: string; error?: string } => {
          const sender = this.getEventSenderWebContents(event);
          const senderInfo = this.findTabByWebContents(sender);
          const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === this.automationTabId);
          const options = (payload && typeof payload === 'object') ? (payload as Record<string, unknown>) : undefined;
          const attachmentId = typeof options?.attachmentId === 'string' ? options.attachmentId.trim() : undefined;

          if (attachmentId) {
            const registry = this.controlPlane?.runs?.attachments;
            if (!registry) {
              return { valid: false, error: 'ATTACHMENT_REGISTRY_UNAVAILABLE: Attachment registry not configured' };
            }
            const record = registry.getAttachment(attachmentId);
            if (!record || record.state !== 'active' || Date.now() > record.expiresAt) {
              return { valid: false, error: 'ATTACHMENT_INVALID: Attachment record is inactive, expired, or missing' };
            }
            const boundTabId = record.browserTarget?.tabId;
            if (isAgent && boundTabId && boundTabId !== senderInfo.tabId) {
              return { valid: false, error: 'ATTACHMENT_FORBIDDEN: Sender tab does not match attachment target tab' };
            }
            return { valid: true, attachmentId };
          }

          if (isAgent) {
            return { valid: false, error: 'ATTACHMENT_REQUIRED: Agent plane session vault operations require a valid active attachment binding' };
          }

          if (isTrustedSessionVaultSender(event)) {
            return { valid: true };
          }

          return { valid: false, error: 'ATTACHMENT_REQUIRED: Valid attachment binding or trusted user-plane sender required' };
        },
      }
    );
    LocalCredentialVault.getInstance({
      safeStorage,
      filePath: path.join(StorageLocations.getConfigDir(), LocalCredentialVault.DEFAULT_VAULT_FILENAME),
      ipc: ipcMain,
      // Security: the page origin is derived from the sender frame (fail-closed
      // top-frame check), never from renderer-supplied arguments.
      resolveEventOrigin: (event: unknown): string | null => resolveSenderFrameOrigin(event),
      // Only user-plane tabs may access credentials (autofill / get-for-origin).
      // Reject agent-plane / ephemeral tabs; fail closed otherwise.
      isUserPlaneSender: (event: unknown): boolean => {
        const sender = this.getEventSenderWebContents(event);
        if (!sender) return false;
        const senderInfo = this.findTabByWebContents(sender);
        if (!senderInfo) return false;
        const isAgent = senderInfo.tab.state.ephemeral === true ||
          senderInfo.tabId === this.automationTabId;
        return !isAgent;
      },
      // Trusted main-process consent dialog before persisting a password.
      requestSaveConsent: async (entry: { origin: string; username: string }): Promise<boolean> => {
        const targetWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
        if (!targetWindow) return false; // fail-closed: no window, no save
        const res = await dialog.showMessageBox(targetWindow, {
          type: 'question',
          title: 'AntiFan — Lưu mật khẩu?',
          message: `Lưu mật khẩu đăng nhập cho ${entry.origin}?`,
          detail: entry.username ? `Tài khoản: ${entry.username}\nMật khẩu sẽ được mã hoá bằng safeStorage (DPAPI), chỉ lưu trên máy này.` : 'Mật khẩu sẽ được mã hoá bằng safeStorage (DPAPI), chỉ lưu trên máy này.',
          buttons: ['Không lưu', 'Lưu mật khẩu'],
          defaultId: 1,
          cancelId: 0,
          noLink: true,
        });
        return res.response === 1;
      },
    }).registerIpcHandlers();
  }

  public static readonly CHROME_ROUTES: readonly IpcRoute[] = [
  {
    channel: FRAME_BACKDROP_CHANNELS.FOCUS_PANE,
    kind: 'on',
    surface: 'frameBackdrop',
    run: ({ host }, event, args) => {
      const paneId = normalizeSplitPaneId(args[0]);
      if (host.activeTabId) {
        host.setSplitFocusedPane(host.activeTabId, paneId);
      }
    },
  },
  {
    channel: FRAME_BACKDROP_CHANNELS.READY,
    kind: 'on',
    surface: 'frameBackdrop',
    run: ({ host }) => {
      host.syncFrameBackdrop();
    },
  },
  {
    channel: FRAME_BACKDROP_CHANNELS.RELOAD_PANE,
    kind: 'on',
    surface: 'frameBackdrop',
    run: ({ host }, event, args) => {
      const paneId = normalizeSplitPaneId(args[0]);
      if (host.activeTabId) {
        const tab = host.tabs.get(host.activeTabId);
        if (tab) {
          const targetWc = paneId === 'mobile' ? tab.mobileView?.webContents : tab.view?.webContents;
          if (targetWc && !targetWc.isDestroyed()) {
            targetWc.reload();
          }
        }
      }
    },
  },
  {
    channel: TOOLBAR_CHANNELS.GET_INITIAL_STATE,
    surface: 'toolbar',
    run: ({ host }) => {
      return {
        tabs: host.getTabList(),
        activeTabId: host.activeTabId,
        isInspecting: host.isInspecting,
        isFontFinderActive: host.isFontFinderActive,
        isLensActive: host.isLensActive,
        isRulerActive: host.isRulerActive,
        isSidebarOpen: host.shell.isSidebarOpen,
        bookmarks: host.bookmarks,
        isBookmarkBarVisible: host.isBookmarkBarVisible,
        devicePresets: DEVICE_PRESETS,
        activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
        chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
        themeQa: host.getThemeQaState(host.activeTabId),
        phoneStatus: host.cachedPhoneStatus,
        projectWindow: host.projectWindowIdentity(),
      };
    },
  },
  {
    channel: TOOLBAR_CHANNELS.SHOW_MENU_BAR,
    surface: 'toolbar',
    // The shell creates windows with autoHideMenuBar: Alt should already toggle
    // the strip; this item is the discoverable path when it does not.
    run: ({ host }) => {
      const win = host.shell.window;
      if (win && !win.isDestroyed()) win.setMenuBarVisibility(true);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.GET_PHONE_STATUS,
    surface: 'toolbar',
    run: async ({ host }, event, args) => { return host.getPhoneStatus(typeof args[0] === 'boolean' ? args[0] : undefined); },
  },
  {
    channel: TOOLBAR_CHANNELS.THEME_QA_RUN,
    surface: 'toolbar',
    // The toolbar asks to scan "its" tab: the tab id is always this host's own
    // active tab, and only a string `workspaceRoot` survives the boundary —
    // renderer args are never forwarded verbatim (F13).
    run: async ({ host }, event, args) => {
      const input = args[0];
      const workspaceRoot = input && typeof input === 'object' && 'workspaceRoot' in input && typeof input.workspaceRoot === 'string'
        ? input.workspaceRoot
        : undefined;
      return host.runThemeQa(host.activeTabId, { workspaceRoot });
    },
  },
  {
    channel: TOOLBAR_CHANNELS.THEME_CHECKLIST_LOAD,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const input = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {}; // IPC boundary: fields re-checked below
      const scope = typeof input.scope === 'string' ? input.scope : '';
      const candidate = typeof input.workspaceRoot === 'string' ? input.workspaceRoot : '';
      // Same confinement rule as runThemeQa: the toolbar-supplied root is
      // clamped to the active tab's resolved workspace before it can name a
      // qa-checklist.json file — a traversal candidate can never read or
      // steer state outside the real root. An unresolvable host root fails
      // closed to '' (provisional scope) instead of passing the candidate.
      const activeTab = host.tabs.get(host.activeTabId);
      const resolvedRoot = host.resolveTabWorkspace(host.activeTabId, activeTab?.state.url);
      const workspaceRoot = resolvedRoot ? confineWorkspaceRoot(candidate, resolvedRoot) : '';
      return host.themeChecklistLoad({ scope, workspaceRoot });
    },
  },
  {
    channel: TOOLBAR_CHANNELS.THEME_CHECKLIST_SAVE,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const input = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, unknown> : {}; // IPC boundary: fields re-checked below
      const scope = typeof input.scope === 'string' ? input.scope : '';
      const candidate = typeof input.workspaceRoot === 'string' ? input.workspaceRoot : '';
      const items = 'items' in input ? input.items : undefined;
      const baseUpdatedAt = typeof input.baseUpdatedAt === 'number' ? input.baseUpdatedAt : undefined;
      const activeTab = host.tabs.get(host.activeTabId);
      const resolvedRoot = host.resolveTabWorkspace(host.activeTabId, activeTab?.state.url);
      const workspaceRoot = resolvedRoot ? confineWorkspaceRoot(candidate, resolvedRoot) : '';
      return host.themeChecklistSave({ scope, workspaceRoot, items, baseUpdatedAt });
    },
  },
  {
    channel: TOOLBAR_CHANNELS.WORKSPACE_IDENTIFY,
    surface: 'toolbar',
    run: ({ host }) => {
      const activeTab = host.tabs.get(host.activeTabId);
      return { workspacePath: host.resolveTabWorkspace(host.activeTabId, activeTab?.state.url) };
    },
  },
  {
    channel: TOOLBAR_CHANNELS.CREATE_TAB,
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => { return host.createTab(typeof args[0] === 'string' ? args[0] : undefined); },
  },
  {
    channel: TOOLBAR_CHANNELS.SWITCH_TAB,
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => { return host.switchTab(typeof args[0] === 'string' ? args[0] : '', { plane: 'user' }); },
  },
  {
    channel: TOOLBAR_CHANNELS.CLOSE_TAB,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.closeTab(typeof args[0] === 'string' ? args[0] : '', 'user-toolbar'); },
  },
  {
    channel: TOOLBAR_CHANNELS.MOVE_TAB,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, toIndex } = (args[0] || {}) as { tabId?: unknown; toIndex?: unknown };
      if (typeof tabId !== 'string' || typeof toIndex !== 'number' || !Number.isInteger(toIndex)) return false;
      return host.moveTab(tabId, toIndex);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.DUPLICATE_TAB,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.duplicateTab(typeof args[0] === 'string' ? args[0] : ''); },
  },
  {
    channel: TOOLBAR_CHANNELS.CLOSE_OTHER_TABS,
    surface: 'toolbar',
    run: ({ host }, event, args) => { host.closeOtherTabs(typeof args[0] === 'string' ? args[0] : ''); },
  },
  {
    channel: TOOLBAR_CHANNELS.CLOSE_TABS_TO_RIGHT,
    surface: 'toolbar',
    run: ({ host }, event, args) => { host.closeTabsToRight(typeof args[0] === 'string' ? args[0] : ''); },
  },
  {
    channel: TOOLBAR_CHANNELS.NAVIGATE,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, url } = (args[0] || {}) as { tabId?: string; url: string };
      return host.navigate(tabId || host.activeTabId, url);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.RELOAD,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.reload((typeof args[0] === 'string' ? args[0] : undefined) || host.activeTabId); },
  },
  {
    channel: TOOLBAR_CHANNELS.RELOAD_WINDOW,
    surface: 'toolbar',
    // Reloads the chrome surfaces and terminal windows, not a tab page: the reply
    // races the toolbar's own reload, so the command's authority is the call having
    // reached Main, not a value the reloaded sender could still receive.
    run: ({ host }) => { host.reloadWindow(); },
  },
  {
    channel: TOOLBAR_CHANNELS.STOP_LOADING,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.stopLoading((typeof args[0] === 'string' ? args[0] : undefined) || host.activeTabId); },
  },
  {
    channel: TOOLBAR_CHANNELS.GO_BACK,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.goBack((typeof args[0] === 'string' ? args[0] : undefined) || host.activeTabId); },
  },
  {
    channel: TOOLBAR_CHANNELS.GO_FORWARD,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.goForward((typeof args[0] === 'string' ? args[0] : undefined) || host.activeTabId); },
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_INSPECT,
    surface: 'toolbar',
    run: ({ host }) => host.toggleInspect(),
  },
  {
    channel: TOOLBAR_CHANNELS.SET_TAB_TERMINAL_SESSION,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, terminalSessionId } = (args[0] || {}) as { tabId?: string; terminalSessionId?: string };
      return host.setTabTerminalSession(tabId || host.activeTabId, terminalSessionId);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_FONT_FINDER,
    surface: 'toolbar',
    run: ({ host }) => host.toggleFontFinder(),
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_LENS,
    surface: 'toolbar',
    run: ({ host }) => host.toggleLens(),
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_RULER,
    surface: 'toolbar',
    run: ({ host }) => host.toggleRuler(),
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_DEVTOOLS,
    surface: 'toolbar',
    run: ({ host }) => host.toggleDevTools(),
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_SIDEBAR,
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    run: ({ host }) => host.toggleSidebar(),
  },
  {
    channel: TOOLBAR_CHANNELS.SET_DEVICE_PRESET,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, presetId } = (args[0] || {}) as { tabId?: string; presetId: string };
      return host.setDevicePreset(tabId || host.activeTabId, presetId);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_SPLIT_REVIEW,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const payload = args[0] as { tabId?: string; enabled?: boolean } | undefined;
      return host.toggleSplitReview(payload?.tabId || host.activeTabId, payload?.enabled);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.SET_SPLIT_PRESET,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, paneId, presetId } = (args[0] || {}) as { tabId?: string; paneId?: unknown; presetId: string };
      return host.setSplitPreset(tabId || host.activeTabId, normalizeSplitPaneId(paneId), presetId);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.SET_SPLIT_FOCUSED_PANE,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, paneId } = (args[0] || {}) as { tabId?: string; paneId?: unknown };
      return host.setSplitFocusedPane(tabId || host.activeTabId, normalizeSplitPaneId(paneId));
    },
  },
  {
    channel: TOOLBAR_CHANNELS.SET_ZOOM,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, zoom } = (args[0] || {}) as { tabId?: string; zoom: number };
      return host.setZoom(tabId || host.activeTabId, zoom);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_MUTE,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const tabId = typeof args[0] === 'string' ? args[0] : undefined;
      if (event?.sender !== host.shell.toolbarView?.webContents) return false;
      return host.toggleSiteMute(tabId ?? host.activeTabId);
    },
  },
  {
    channel: 'antifan:tab-wheel-zoom',
    kind: 'on',
    // Sent by the page's own preload (`src/preload/tab-preload.ts`) and answered for the tab it
    // came from: the sender is the page being zoomed, not a chrome surface.
    surface: 'tab',
    run: ({ host }, event, args) => {
      const { isZoomIn } = (args[0] || {}) as { isZoomIn: boolean };
      const senderWc = event?.sender;
      for (const [id, t] of host.tabs.entries()) {
        if (t.view?.webContents === senderWc) {
          const current = t.state.zoomFactor || 1.0;
          const step = 0.1;
          const nextZoom = isZoomIn
            ? Math.min(5.0, Number((current + step).toFixed(2)))
            : Math.max(0.25, Number((current - step).toFixed(2)));
          host.setZoom(id, nextZoom);
          break;
        }
      }
    },
  },
  {
    channel: 'antifan:dom-mutation',
    kind: 'on',
    // Same surface as the wheel-zoom report: the page announces its own DOM changed, so the
    // document-generation revision it bumps is the page's, resolved from the sender.
    surface: 'tab',
    run: ({ host }, event) => {
      const senderWc = event?.sender;
      for (const [id, t] of host.tabs.entries()) {
        if (t.view?.webContents === senderWc || (t.mobileView && t.mobileView.webContents === senderWc)) {
          host.bumpMutationRevision(id);
          break;
        }
      }
    },
  },
  {
    channel: 'antifan:tab-ai-state',
    kind: 'on',
    // The page's own detector (src/preload/tab-preload.ts) reports chat-streaming state;
    // the tab it came from is the record the badge paints, resolved from the sender.
    surface: 'tab',
    run: ({ host }, event, args) => {
      const { aiState } = (args[0] || {}) as { aiState?: string };
      if (aiState !== 'idle' && aiState !== 'thinking' && aiState !== 'streaming' && aiState !== 'completed' && aiState !== 'agent_working') return;
      const senderInfo = host.findTabByWebContents(event?.sender);
      if (senderInfo) host.setTabAiState(senderInfo.tabId, aiState);
    },
  },
  {
    channel: 'antifan:tab-theme-error',
    kind: 'on',
    // The page's sentinel reports a Liquid/server error signature it found; the badge
    // rides `state.themeError` on the same sender-resolved record.
    surface: 'tab',
    run: ({ host }, event, args) => {
      const { themeError } = (args[0] || {}) as { themeError?: unknown };
      const senderInfo = host.findTabByWebContents(event?.sender);
      if (senderInfo) host.setTabThemeError(senderInfo.tabId, typeof themeError === 'string' && themeError ? themeError : undefined);
    },
  },
  {
    channel: 'antifan:tab:scroll-changed',
    kind: 'on',
    // The page's passive tracker keeps `state.scrollX/scrollY` current so a later
    // hibernate or view recreate restores where the user actually stopped reading.
    surface: 'tab',
    run: ({ host }, event, args) => {
      const { scrollX, scrollY } = (args[0] || {}) as { scrollX?: unknown; scrollY?: unknown };
      const senderInfo = host.findTabByWebContents(event?.sender);
      if (senderInfo) {
        host.setTabScrollPosition(
          senderInfo.tabId,
          typeof scrollX === 'number' && Number.isFinite(scrollX) ? scrollX : 0,
          typeof scrollY === 'number' && Number.isFinite(scrollY) ? scrollY : 0
        );
      }
    },
  },
  {
    channel: TOOLBAR_CHANNELS.CAPTURE_FULL_PAGE,
    surface: 'toolbar',
    run: ({ host }) => host.captureScreenshot(undefined, undefined, undefined, { fullPage: true }),
  },
  {
    channel: TOOLBAR_CHANNELS.CAPTURE_VIEWPORT,
    surface: 'toolbar',
    run: ({ host }) => host.captureScreenshot(),
  },
  {
    channel: TOOLBAR_CHANNELS.OPEN_EXTERNAL,
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => { return host.openExternal(typeof args[0] === 'string' ? args[0] : undefined); },
  },
  {
    channel: TOOLBAR_CHANNELS.OPEN_IN_VSCODE,
    surface: 'toolbar',
    run: ({ host }) => host.openInVSCode(),
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_BOOKMARK,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { url, title } = (args[0] || {}) as { url: string; title?: string };
      return host.toggleBookmark(url, title);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.FIND_IN_PAGE,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { text, forward, findNext } = (args[0] || {}) as { text: string; forward?: boolean; findNext?: boolean };
      return host.findInPage(text, forward, findNext);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.STOP_FIND_IN_PAGE,
    surface: 'toolbar',
    run: ({ host }) => host.stopFindInPage(),
  },
  {
    channel: TOOLBAR_CHANNELS.SHOW_MENU,
    surface: 'toolbar',
    run: ({ host }) => host.showMainMenu(),
  },
  {
    channel: 'antifan:toolbar:check-updates',
    surface: 'toolbar',
    run: ({ host }) => checkForUpdatesAndRestart(host.shell.window),
  },
  {
    channel: 'antifan:copy-bridge-token',
    surface: 'toolbar',
    run: ({ host }, event) => {
      if (!isTrustedSessionVaultSender(event)) {
        return { success: false, error: 'FORBIDDEN_SENDER' };
      }
      const bridge = BridgeServer.getInstance();
      if (bridge) {
        const token = bridge.getToken();
        clipboard.writeText(token);
        return { success: true };
      }
      return { success: false, error: 'Bridge server not running' };
    },
  },
  {
    channel: 'antifan:rotate-bridge-token',
    surface: 'toolbar',
    run: async ({ host }, event) => {
      if (!isTrustedSessionVaultSender(event)) {
        return { success: false, error: 'FORBIDDEN_SENDER' };
      }
      const bridge = BridgeServer.getInstance();
      if (bridge) {
        const token = await bridge.rotateToken();
        clipboard.writeText(token);
        return { success: true };
      }
      return { success: false, error: 'Bridge server not running' };
    },
  },
  {
    channel: TOOLBAR_CHANNELS.SET_OVERLAY,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const active = Boolean(args[0]);
      const customHeight = typeof args[1] === 'number' ? args[1] : undefined;
      return host.setToolbarOverlay(active, customHeight);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.CLEAR_STORAGE,
    surface: 'toolbar',
    run: ({ host }, event) => {
      if (!isTrustedSessionVaultSender(event)) {
        return { success: false, error: 'FORBIDDEN_SENDER' };
      }
      return host.clearStorageForActiveTab();
    },
  },
  {
    channel: TOOLBAR_CHANNELS.GET_CHROME_PROFILES,
    surface: 'toolbar',
    run: ({ host }) => ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
  },
  {
    channel: TOOLBAR_CHANNELS.SYNC_CHROME_PROFILE,
    surface: 'toolbar',
    run: async ({ host }, event, args) => {
      const profileId = typeof args[0] === 'string' ? args[0] : '';
      if (!isTrustedSessionVaultSender(event)) {
        return { success: false, cookiesCount: 0, bookmarksCount: 0, hasLiveCookies: false, message: 'FORBIDDEN_SENDER' };
      }
      // Partition unification: cookies always hydrate the shared profile
      // partition (persist:profile-*), never a workspace capsule session, so
      // regular tabs and imports stay on one stable cookie store per profile.
      // Select the profile FIRST: the partition is derived from the explicit
      // profileId, so syncing 'Profile 1' must target
      // persist:profile-profile-1, never the previously active profile and
      // never the tab the user happens to have focused.
      const manager = ChromeProfileSyncManager.getInstance();
      // Validate BEFORE mutating global state or deriving a partition: a
      // missing profile must leave activeProfileId and partitions untouched.
      if (!manager.hasProfile(profileId)) {
        return { success: false, cookiesCount: 0, bookmarksCount: 0, hasLiveCookies: false, message: `Profile '${profileId}' not found.` };
      }
      manager.activeProfileId = profileId;
      const targetSession = host.resolveTargetProfileSession(profileId);
      const res = await manager.syncProfile(profileId, targetSession);
      const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(profileId);
      if (bm && bm.length > 0) {
        host.bookmarks = bm.map(b => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
      }
      host.updateLayout();
      host.broadcastState();
      return res;
    },
  },
  {
    channel: 'antifan:chrome:is-running',
    surface: 'toolbar',
    run: ({ host }) => {
      return ChromeProfileSyncManager.getInstance().isChromeRunning();
    },
  },
  {
    channel: TOOLBAR_CHANNELS.TOGGLE_BOOKMARK_BAR,
    surface: 'toolbar',
    run: ({ host }) => {
      host.isBookmarkBarVisible = !host.isBookmarkBarVisible;
      host.updateLayout();
      host.broadcastState();
      return host.isBookmarkBarVisible;
    },
  },
  {
    channel: TOOLBAR_CHANNELS.ADD_BOOKMARK,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { title, url } = (args[0] || {}) as { title: string; url: string };
      const existing = host.bookmarks.find(b => b.url === url);
      if (!existing) {
        host.bookmarks.push({ id: url, title: title || url, url, createdAt: Date.now() });
        host.updateLayout();
        host.broadcastState();
      }
      return { ok: true, bookmarks: host.bookmarks };
    },
  },
  {
    channel: 'antifan:preview:open',
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { path: filePath, capsuleId } = (args[0] || {}) as { path: string; capsuleId?: string };
      return host.createPreviewTab(filePath, capsuleId);
    },
  },
  {
    channel: TOOLBAR_CHANNELS.GET_SUGGESTIONS,
    surface: 'toolbar',
    run: async ({ host }, event, args) => {
      const query = typeof args[0] === 'string' ? args[0] : '';
      const q = (query || '').trim();
      if (!q) {
        const results = host.bookmarks.slice(0, 5).map(b => ({
          type: 'bookmark' as const,
          text: b.title,
          url: b.url,
          subText: b.url,
        }));
        return { suggestions: results };
      }

      const results: Array<{ type: 'search' | 'url' | 'bookmark' | 'history' | 'tab'; text: string; url?: string; tabId?: string; subText?: string }> = [];
      const lower = q.toLowerCase();

      // 1. Search browser history (frecency matched)
      try {
        const historyMatches = HistoryManager.getInstance().search(q, 6);
        for (const h of historyMatches) {
          if (!results.some(r => r.url === h.url)) {
            results.push({
              type: 'history',
              text: h.title || h.domain || h.url,
              url: h.url,
              subText: h.domain || h.url,
            });
          }
        }
      } catch {}

      // 2. Check local bookmarks match
      host.bookmarks.forEach(b => {
        if (b.title.toLowerCase().includes(lower) || b.url.toLowerCase().includes(lower)) {
          if (!results.some(r => r.url === b.url)) {
            results.push({ type: 'bookmark', text: b.title, url: b.url, subText: b.url });
          }
        }
      });

      // 3. Check local open tabs match
      host.tabOrder.forEach(id => {
        const tab = host.tabs.get(id);
        if (tab && tab.state.ephemeral !== true && (tab.state.title.toLowerCase().includes(lower) || tab.state.url.toLowerCase().includes(lower))) {
          if (!results.some(r => r.url === tab.state.url)) {
            results.push({ type: 'tab', text: tab.state.title, url: tab.state.url, tabId: id, subText: 'Chuyển sang tab' });
          }
        }
      });

      // 4. Fetch live Google search suggestions with UTF-8 encoding
      try {
        const apiUrl = `https://suggestqueries.google.com/complete/search?client=chrome&hl=vi&gl=vn&ie=utf-8&oe=utf-8&q=${encodeURIComponent(q)}`;
        const res = await fetch(apiUrl, {
          headers: {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Charset': 'utf-8',
          },
        });
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          const buffer = await res.arrayBuffer();
          let text = '';
          if (/charset=iso-8859-1/i.test(contentType)) {
            text = new TextDecoder('iso-8859-1').decode(buffer);
          } else if (/charset=windows-1258/i.test(contentType)) {
            text = new TextDecoder('windows-1258').decode(buffer);
          } else {
            try {
              text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
            } catch {
              text = new TextDecoder('utf-8').decode(buffer);
            }
          }
          const data: unknown = JSON.parse(text);
          if (Array.isArray(data) && Array.isArray(data[1])) {
            const rawQueries = data[1] as unknown[];
            const googleQueries = rawQueries.filter((item): item is string => typeof item === 'string').slice(0, 6);
            googleQueries.forEach(suggestedText => {
              if (suggestedText && !results.some(r => r.text === suggestedText)) {
                results.push({
                  type: 'search',
                  text: suggestedText,
                  url: `https://www.google.com/search?q=${encodeURIComponent(suggestedText)}`
                });
              }
            });
          }
        }
      } catch {
        if (!results.some(r => r.type === 'search')) {
          results.push({ type: 'search', text: q, url: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
        }
      }

      return { suggestions: results.slice(0, 8) };
    },
  },
  {
    channel: TOOLBAR_CHANNELS.REMOVE_BOOKMARK,
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const url = typeof args[0] === 'string' ? args[0] : '';
      host.bookmarks = host.bookmarks.filter(b => b.url !== url);
      host.updateLayout();
      host.broadcastState();
      return { ok: true, bookmarks: host.bookmarks };
    },
  },
  {
    channel: TERMINAL_CHANNELS.GET_FULL_BUFFER,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [typeof args[0] === 'string' ? args[0] : undefined],
    run: ({ host }, event, args) => {
      const sessionId = typeof args[0] === 'string' ? args[0] : '';
      // A named session was admitted by the scope gate; with none named the buffer is this
      // window's own active session, never the process-wide one another window switched to.
      const targetId = sessionId || host.windowActiveSessionId(event?.sender);
      if (!targetId) return { sessionId: '', buffer: '', snapshotThroughSeq: 0 };
      return TerminalManager.getInstance().getFullBuffer(targetId);
    },
  },
  {
    channel: TERMINAL_CHANNELS.DUMP_DIAGNOSTICS,
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event) => {
      // The manager may be the detached daemon's proxy, whose diagnostics answer arrives as a
      // promise; it is awaited and then narrowed, because a filtered report spread out of a
      // pending promise would silently drop every session row instead of scoping them.
      const report: unknown = await Promise.resolve(TerminalManager.getInstance().getDiagnostics());
      return {
        ...host.scopeTerminalDiagnostics(report, event?.sender?.id),
        fanoutMessages: host.terminalFanoutMessages,
      };
    },
  },
  {
    channel: TERMINAL_CHANNELS.GET_DELTA,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { sessionId?: string } | undefined)?.sessionId],
    run: ({ host }, event, args) => {
      const query = (args[0] || {}) as { sessionId: string; generation: number; fromSeq: number };
      if (!query || !query.sessionId) {
        return { status: 'SESSION_CLOSED', finalSeq: 0 };
      }
      const tm = TerminalManager.getInstance();
      return tm.getTerminalDelta(query.sessionId, query.generation || 0, Math.max(1, query.fromSeq || 0));
    },
  },
  {
    channel: TERMINAL_CHANNELS.SYNC_VIEW,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { sessionId?: string } | undefined)?.sessionId],
    run: ({ host }, event, args) => {
      const query = (args[0] || {}) as { sessionId: string; knownGeneration: number; lastAppliedSeq: number };
      if (!query || !query.sessionId) {
        return { status: 'SESSION_CLOSED', finalSeq: 0 };
      }
      return TerminalManager.getInstance().syncTerminalView(query);
    },
  },
  {
    channel: TERMINAL_CHANNELS.ACK,
    kind: 'on',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { sessionId?: string } | undefined)?.sessionId],
    run: ({ host }, event, args) => {
      const payload = args[0] as TerminalAckPayload;
      // The daemon-mode proxy returns a promise; a dropped daemon socket must not
      // surface as an unhandled rejection on a fire-and-forget ack path.
      void Promise.resolve(TerminalManager.getInstance().recordSubscriberAck(payload)).catch(() => {});
    },
  },
  {
    channel: TERMINAL_CHANNELS.START,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const cwd = typeof args[0] === 'string' ? args[0] : undefined;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      // An omitted cwd means "this window's workspace", never the process-wide last
      // directory another window's workspace switch may have left behind. An explicit cwd
      // is honoured, but provenance is not the caller's to choose: the session belongs to
      // the capsule this window verified, never to the manager's ambient one.
      const resolvedTarget = host.resolveTerminalCreationTarget(event?.sender);
      const target = cwd ? { ...resolvedTarget, cwd } : resolvedTarget;
      // Starting with no live session spawns the shell: a mint, and in daemon mode a round-trip.
      // The admission is taken in the same step the call starts and released when it settles, so
      // the route keeps returning the value (or the promise) it always returned.
      return host.admitThenRun(
        'antifan:terminal:start',
        { tabIds: senderInfo?.tabId, ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => {
          // The singleton is a daemon proxy installed by cast: it answers a settlement
          // promise while the in-process manager answers a boolean, so the value is
          // genuinely unknown at compile time.
          const started: unknown = TerminalManager.getInstance().startTerminal(target.cwd, target.capsuleId, target.ownerKey);
          const bindAffinity = (): void => {
            if (!isAgent) return;
            const tm = TerminalManager.getInstance();
            const sessionId = tm.getActiveSessionId();
            const session = tm.getSession(sessionId) as { sessionGeneration?: number } | undefined;
            if (sessionId && senderInfo.tabId) {
              host.bindTerminalAgentAffinity(sessionId, session?.sessionGeneration, senderInfo.tabId);
            }
          };
          const thenable = started as { then?: unknown } | null | undefined;
          if (thenable && typeof thenable.then === 'function') {
            // The session the affinity names does not exist until the RPC resolves, so
            // the bind must ride the settlement: reading active state now would still
            // describe the previous session.
            return Promise.resolve(started).then((value) => {
              if (value) bindAffinity();
              return value;
            });
          }
          if (started) bindAffinity();
          return started;
        }
      );
    },
  },
  {
    channel: TERMINAL_CHANNELS.INPUT,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const input = typeof args[0] === 'string' ? args[0] : '';
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      // A write can be what wakes a sleeping session - `resolveWritableSession` spawns its PTY -
      // so it is admitted like the mint it may become, held until the write settles.
      return host.admitThenRun(
        'antifan:terminal:input',
        { tabIds: senderInfo?.tabId, ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => {
          if (isAgent) {
            return host.terminalWrite(senderInfo.tabId, input);
          }
          // The write goes to the session this window presents, never to the process-wide
          // active one: another window's switch must not receive this window's keystrokes.
          const targetId = host.windowActiveSessionId(event?.sender);
          if (!targetId) return false;
          // The shared manager presents every row, including an agent's; writing into one is the
          // one thing showing it does not license.
          const gate = host.assertManagerMayOperate(targetId, event?.sender?.id);
          if (gate !== true) {
            host.reportManagerWriteRefusal('antifan:terminal:input', gate);
            return false;
          }
          const written: unknown = TerminalManager.getInstance().writeTo(targetId, input);
          // The singleton is a daemon proxy installed by cast: it answers boolean|Promise<boolean>
          // while the in-process manager answers undefined, which maps to the old constant true.
          return written === undefined ? true : (written as boolean | Promise<boolean>);
        }
      );
    },
  },
  {
    channel: 'antifan:terminal:input-session',
    kind: 'on',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { id?: string } | undefined)?.id],
    run: ({ host }, event, args) => {
      const { id, input } = (args[0] || {}) as { id: string; input: string };
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      // The named session's own gate, read before the admission is taken: the shared manager may
      // render an agent-owned row, but typing into it would take that agent's shell out from under
      // it. This channel has no reply, so the refusal is the log line rather than a value.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:input-session', gate);
        return;
      }
      // A write can be what wakes a sleeping session and spawns its PTY, so it is admitted
      // like the mint it may become. This channel is fire-and-forget: the router dispatches it
      // without awaiting and with no rejection path back to the sender, so the handler stays
      // synchronous and releases the admission from the write's own promise.
      const release = host.admitHostWork('antifan:terminal:input-session', {
        tabIds: senderInfo?.tabId,
        ownerKey: host.shellOwnerKeyForSender(event?.sender?.id),
      });
      const settle = (written: unknown): void => {
        const thenable = written as { then?: unknown } | null | undefined;
        if (thenable && typeof thenable.then === 'function') {
          void Promise.resolve(written).then(release, (err: unknown) => {
            release();
            console.warn(`[native-tab-host] terminal input-session '${id}' failed during write:`, err);
          });
          return;
        }
        release();
      };
      if (isAgent) {
        try {
          settle(host.terminalWrite(senderInfo.tabId, input, id));
        } catch (err) {
          release();
          console.warn(`[native-tab-host] terminal input-session rejected for tab '${senderInfo.tabId}' session '${id}':`, err);
        }
        return;
      }
      try {
        settle(TerminalManager.getInstance().writeTo(id, input));
      } catch (err) {
        // A synchronous throw would otherwise leak the admission and keep every close busy.
        release();
        console.warn(`[native-tab-host] terminal input-session '${id}' failed during write:`, err);
      }
    },
  },
  {
    channel: 'antifan:terminal:paste-image',
    surface: ['sidebar', 'terminalPopout'],
    // Ctrl+V with an image (not text) on the clipboard: Main owns the clipboard, so the
    // preload asks here; the staged path goes back and the renderer types it like text.
    run: ({ host }, event) => host.pasteClipboardImage(host.windowActiveSessionId(event?.sender)),
  },
  {
    channel: TERMINAL_CHANNELS.KILL,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        const ownedTerminalId = host.getOwnedTerminalSession(senderInfo.tabId);
        if (!ownedTerminalId) {
          throw new CapabilityError('TERMINAL_FORBIDDEN' as unknown as CapabilityErrorCode, `Agent tab '${senderInfo.tabId}' does not own a terminal session; cannot kill active terminal`);
        }
        host.assertTerminalAccess(senderInfo.tabId, ownedTerminalId);
        TerminalManager.getInstance().closeSession(ownedTerminalId);
        return true;
      }
      // Killing "the active terminal" means the one this window presents: the process-wide
      // active session may belong to another project's window.
      const targetId = host.windowActiveSessionId(event?.sender);
      if (!targetId) return false;
      // An agent's terminal is shown to the shared manager, not handed to it: ending that PTY
      // would end the work the agent is in the middle of.
      const gate = host.assertManagerMayOperate(targetId, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:kill', gate);
        return false;
      }
      return TerminalManager.getInstance().closeSession(targetId);
    },
  },
  {
    channel: TERMINAL_CHANNELS.RESTART,
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event, args) => {
      const cwd = typeof args[0] === 'string' ? args[0] : undefined;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      // restart replaces the terminal process — a mint — so it is admitted like the other
      // terminal RPCs and held until the awaited restart settles.
      return host.admitThenRun(
        'antifan:terminal:restart',
        { tabIds: senderInfo?.tabId, ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        async () => {
          if (isAgent) {
            const ownedTerminalId = host.getOwnedTerminalSession(senderInfo.tabId);
            if (!ownedTerminalId) {
              throw new CapabilityError('TERMINAL_FORBIDDEN' as unknown as CapabilityErrorCode, `Agent tab '${senderInfo.tabId}' does not own a terminal session; cannot restart active terminal`);
            }
            host.assertTerminalAccess(senderInfo.tabId, ownedTerminalId);
            const tm = TerminalManager.getInstance();
            const prevActiveId = tm.getActiveSessionId();
            // switchSession is a daemon round-trip in daemon mode: awaiting keeps the
            // restart aimed at the owned PTY, and the awaited restore keeps the admission
            // held until the previous active session is put back.
            await tm.switchSession(ownedTerminalId);
            try {
              await tm.restart(cwd);
            } finally {
              if (prevActiveId && prevActiveId !== ownedTerminalId && tm.getSession(prevActiveId)) {
                await tm.switchSession(prevActiveId);
              }
            }
            return true;
          }
          // Restarting "the terminal" means the one this window presents: the manager only
          // exposes restart against its process-wide active session, so the window's own
          // session is made active for the call and the previous one restored after it.
          const targetId = host.windowActiveSessionId(event?.sender);
          const gate = host.assertManagerMayOperate(targetId, event?.sender?.id);
          if (gate !== true) {
            host.reportManagerWriteRefusal('antifan:terminal:restart', gate);
            return false;
          }
          return host.runAgainstWindowActive(event?.sender, () => TerminalManager.getInstance().restart(cwd));
        }
      );
    },
  },
  {
    channel: TERMINAL_CHANNELS.OPEN_IN_VSCODE,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => { return host.openInVSCode(typeof args[0] === 'string' ? args[0] : undefined); },
  },
  {
    channel: TERMINAL_CHANNELS.READ_FILE_PREVIEW,
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event, args): Promise<ReadFilePreviewResult> => {
      const raw = args[0];
      const payload = raw && typeof raw === 'object' ? (raw as { filePath?: unknown; sessionId?: unknown }) : {};
      const rawPath = typeof payload.filePath === 'string' ? payload.filePath.trim() : '';
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      if (!rawPath) {
        return {
          ok: false,
          filePath: '',
          fileName: '',
          reason: 'INVALID_PAYLOAD',
          message: 'Đường dẫn file không hợp lệ',
        };
      }

      let targetPath = rawPath;
      if ((targetPath.startsWith('"') && targetPath.endsWith('"')) ||
          (targetPath.startsWith("'") && targetPath.endsWith("'")) ||
          (targetPath.startsWith('`') && targetPath.endsWith('`'))) {
        targetPath = targetPath.slice(1, -1).trim();
      }
      targetPath = targetPath.replace(/[,\.;\)]+$/, '');
      const lineColMatch = /:(\d+)(?::\d+)?$/.exec(targetPath);
      if (lineColMatch) {
        targetPath = targetPath.slice(0, lineColMatch.index).trim();
      }

      if (!path.isAbsolute(targetPath)) {
        let baseCwd = '';
        if (sessionId) {
          try {
            const s = TerminalManager.getInstance().getSession(sessionId);
            if (s && s.cwd) baseCwd = s.cwd;
          } catch {}
        }
        if (!baseCwd) {
          const activeCapsule = host.capsuleManager?.getActive?.();
          if (activeCapsule?.workspacePath) baseCwd = activeCapsule.workspacePath;
        }
        targetPath = baseCwd ? path.resolve(baseCwd, targetPath) : path.resolve(targetPath);
      }

      const fileName = path.basename(targetPath);
      try {
        if (!fs.existsSync(targetPath)) {
          return { ok: false, filePath: targetPath, fileName, reason: 'NOT_FOUND', message: `File không tồn tại: ${targetPath}` };
        }
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
          return { ok: false, filePath: targetPath, fileName, reason: 'IS_DIRECTORY', message: `Đường dẫn là thư mục, không phải file: ${targetPath}`, size: stat.size };
        }
        const MAX_READ_BYTES = 512 * 1024;
        const MAX_ALLOW_SIZE = 10 * 1024 * 1024;
        if (stat.size > MAX_ALLOW_SIZE) {
          return { ok: false, filePath: targetPath, fileName, reason: 'TOO_LARGE', message: `File quá lớn (${(stat.size / (1024 * 1024)).toFixed(1)} MB), hãy mở bằng VS Code`, size: stat.size };
        }

        const fd = fs.openSync(targetPath, 'r');
        try {
          const bytesToRead = Math.min(stat.size, MAX_READ_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          fs.readSync(fd, buffer, 0, bytesToRead, 0);

          const checkLen = Math.min(buffer.length, 4096);
          for (let i = 0; i < checkLen; i++) {
            if (buffer[i] === 0) {
              return { ok: false, filePath: targetPath, fileName, reason: 'BINARY_FILE', message: 'File nhị phân (binary/image), không thể xem dạng text', size: stat.size };
            }
          }

          const content = buffer.toString('utf8');
          const isTruncated = stat.size > MAX_READ_BYTES;
          const lineCount = content.split('\n').length;
          return {
            ok: true,
            filePath: targetPath,
            fileName,
            content,
            size: stat.size,
            lineCount,
            isTruncated,
          };
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        return {
          ok: false,
          filePath: targetPath,
          fileName,
          reason: 'READ_ERROR',
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  },
  {
    channel: TERMINAL_CHANNELS.RESIZE,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const { cols, rows } = (args[0] || {}) as { cols: number; rows: number };
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        const ownedTerminalId = host.getOwnedTerminalSession(senderInfo.tabId);
        if (!ownedTerminalId) {
          throw new CapabilityError('TERMINAL_FORBIDDEN' as unknown as CapabilityErrorCode, `Agent tab '${senderInfo.tabId}' does not own a terminal session; cannot resize active terminal`);
        }
        host.assertTerminalAccess(senderInfo.tabId, ownedTerminalId);
        TerminalManager.getInstance().resizeTo(ownedTerminalId, cols, rows);
        return true;
      }
      // The size belongs to the terminal this window presents; the process-wide active
      // session may be another project's window.
      const targetId = host.windowActiveSessionId(event?.sender);
      if (!targetId) return false;
      TerminalManager.getInstance().resizeTo(targetId, cols, rows);
      return true;
    },
  },
  {
    channel: 'antifan:terminal:resize-session',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { id?: string } | undefined)?.id],
    run: ({ host }, event, args) => {
      const { id, cols, rows } = (args[0] || {}) as { id: string; cols: number; rows: number };
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      TerminalManager.getInstance().resizeTo(id, cols, rows);
      return true;
    },
  },
  {
    channel: 'antifan:terminal:new-session',
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event, args) => {
      host.assertApplicationAdmitsHostWork('antifan:terminal:new-session');
      const cwd = typeof args[0] === 'string' ? args[0] : undefined;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      // An explicit cwd is honoured, but provenance is not the caller's to choose: the new
      // session belongs to the capsule this window verified, never to the manager's ambient
      // one, which another window's workspace switch may have set.
      const resolvedTarget = host.resolveTerminalCreationTarget(event?.sender);
      let target = cwd ? { ...resolvedTarget, cwd } : resolvedTarget;
      // The shared manager owns no folder: an explicit cwd there names the folder whose
      // project owns the row, reusing (never creating) the capsule recorded for it.
      if (cwd && host.isSharedTerminalManagerSender(event?.sender?.id)) {
        let real = '';
        try {
          real = fs.realpathSync.native(cwd);
          if (!fs.statSync(real).isDirectory()) real = '';
        } catch {
          real = '';
        }
        if (real) {
          const activeId = host.capsuleManager.getActive()?.id ?? '';
          const capsule = findCapsuleByRoot(host.capsuleManager.list(), real, activeId);
          const ownerKey = host.managerFolderMintOwnerKey(real, capsule, event?.sender?.id);
          target = {
            ...target,
            capsuleId: capsule?.id || target.capsuleId,
            ownerKey: ownerKey ?? target.ownerKey,
          };
        }
      }
      // The daemon mints the PTY after this call resolves: hold the admission across it, and
      // attribute it to the page that asked plus the owner of the shell that asked - a sidebar
      // sender is chrome, so without the owner a shell close could not see this mint.
      const release = host.admitHostWork('antifan:terminal:new-session', {
        tabIds: senderInfo?.tabId,
        ownerKey: host.shellOwnerKeyForSender(event?.sender?.id),
      });
      try {
        const id = await TerminalManager.getInstance().createSession(target.cwd, target.capsuleId, target.ownerKey);
        if (isAgent && id) {
          const s = TerminalManager.getInstance().getSession(id);
          host.bindTerminalAgentAffinity(id, s?.sessionGeneration, senderInfo.tabId);
        }
        return id;
      } finally {
        release();
      }
    },
  },
  {
    channel: 'antifan:terminal:split-session',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => {
      const p = args[0];
      const pObj = p && typeof p === 'object' ? (p as Record<string, unknown>) : undefined;
      const parentId = typeof p === 'string' ? p : (typeof pObj?.parentId === 'string' ? pObj.parentId : (typeof pObj?.id === 'string' ? pObj.id : undefined));
      return [parentId];
    },
    run: async ({ host }, event, args) => {
      host.assertApplicationAdmitsHostWork('antifan:terminal:split-session');
      const p = args[0];
      const pObj = p && typeof p === 'object' ? p as Record<string, unknown> : undefined;
      const parentId = typeof p === 'string' ? p : (typeof pObj?.parentId === 'string' ? pObj.parentId : (typeof pObj?.id === 'string' ? pObj.id : undefined));
      const cwd = typeof pObj?.cwd === 'string' ? pObj.cwd : undefined;
      const cols = typeof pObj?.cols === 'number' ? pObj.cols : undefined;
      const rows = typeof pObj?.rows === 'number' ? pObj.rows : undefined;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      let targetParentId = parentId;
      if (isAgent) {
        if (parentId) {
          host.assertTerminalAccess(senderInfo.tabId, parentId);
        } else {
          const ownedTerminalId = host.getOwnedTerminalSession(senderInfo.tabId);
          if (!ownedTerminalId) {
            throw new CapabilityError('TERMINAL_FORBIDDEN' as unknown as CapabilityErrorCode, `Agent tab '${senderInfo.tabId}' does not own a terminal session to split`);
          }
          host.assertTerminalAccess(senderInfo.tabId, ownedTerminalId);
          targetParentId = ownedTerminalId;
        }
      } else if (!parentId) {
        // A named parent was admitted by the scope gate. With none named the split belongs
        // to the session this window presents, never to the process-wide active one.
        targetParentId = host.windowActiveSessionId(event?.sender);
        if (!targetParentId) return false;
      }
      // A split mints a second PTY beside the parent: for the shared manager presenting an
      // agent's row, that would put a shell the agent never asked for next to its own.
      const gate = host.assertManagerMayOperate(targetParentId || '', event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:split-session', gate);
        return false;
      }
      const splitId = await (async () => {
        // Same shape as `new-session`: the split PTY is minted inside the daemon, so the
        // admission is re-read and registered in one step across the call.
        const release = host.admitHostWork('antifan:terminal:split-session', {
          tabIds: senderInfo?.tabId,
          ownerKey: host.shellOwnerKeyForSender(event?.sender?.id),
        });
        try {
          return await TerminalManager.getInstance().createSplitSession(targetParentId || '', cwd, cols, rows);
        } finally {
          release();
        }
      })();
      if (isAgent && splitId) {
        const s = TerminalManager.getInstance().getSession(splitId);
        host.bindTerminalAgentAffinity(splitId, s?.sessionGeneration, senderInfo.tabId);
      }
      return splitId;
    },
  },
  {
    channel: 'antifan:terminal:unsplit-session',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [typeof args[0] === 'string' ? args[0] : undefined],
    run: ({ host }, event, args) => {
      const parentId = typeof args[0] === 'string' ? args[0] : '';
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent && parentId) {
        host.assertTerminalAccess(senderInfo.tabId, parentId);
      }
      return TerminalManager.getInstance().closeSplitSession(parentId);
    },
  },
  {
    channel: 'antifan:terminal:close-split',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { id?: string } | undefined)?.id],
    run: ({ host }, event, args) => {
      const { id } = (args[0] || {}) as { id: string };
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent && id) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      return TerminalManager.getInstance().closeSplitSession(id);
    },
  },
  {
    channel: TERMINAL_CHANNELS.LIST_SESSIONS,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      // The list the sidebar bootstraps from carries the same scope as its pushed
      // projection: never another project's sessions — and every project's, when the
      // asking renderer is the shared manager's own chrome.
      return host.visibleTerminalSessions(event?.sender?.id);
    },
  },
  {
    channel: TERMINAL_CHANNELS.SWITCH_SESSION,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [typeof args[0] === 'string' ? args[0] : undefined],
    run: ({ host }, event, args) => {
      const id = typeof args[0] === 'string' ? args[0] : '';
      // Switching to a sleeping session materializes its PTY, so the switch is admitted like the
      // mint it may become and held until it settles. The admission is taken BEFORE the metadata
      // below: a refused switch must not leave the window pointing at a session it was never
      // allowed to adopt.
      return host.admitThenRun(
        'antifan:terminal:switch-session',
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => {
          const senderWin = (event?.sender ? BrowserWindow.fromWebContents(event.sender) : null);
          if (senderWin && host.terminalWindowMeta.has(senderWin.id)) {
            const meta = host.terminalWindowMeta.get(senderWin.id);
            if (meta) meta.sessionId = id;
            host.schedulePersist();
          }
          return TerminalManager.getInstance().switchSession(id);
        }
      );
    },
  },
  {
    channel: TERMINAL_CHANNELS.RENAME_SESSION,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => {
      const p = args[0] as { id?: string; sessionId?: string } | string | undefined;
      return [typeof p === 'string' ? undefined : (p?.id || p?.sessionId)];
    },
    run: ({ host }, event, args) => {
      const p = args[0] as { id?: string; sessionId?: string; name?: string; newTitle?: string } | string | undefined;
      const id = typeof p === 'string' ? '' : (p?.id || p?.sessionId);
      const name = typeof p === 'string' ? p : (p?.name || p?.newTitle);
      // A named session was admitted by the scope gate; with none named the rename applies
      // to the session this window presents, never to the process-wide active one.
      const targetId = id || host.windowActiveSessionId(event?.sender);
      if (!targetId) return false;
      return TerminalManager.getInstance().renameSession(targetId, name || '');
    },
  },
  {
    channel: 'antifan:terminal:reorder-sessions',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => (Array.isArray(args[0]) ? (args[0] as string[]) : []),
    run: ({ host }, event, args) => {
      const orderIds = Array.isArray(args[0]) ? (args[0] as string[]) : [];
      return TerminalManager.getInstance().reorderSessions(orderIds);
    },
  },
  {
    channel: 'antifan:terminal:close-session',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [typeof args[0] === 'string' ? args[0] : undefined],
    run: ({ host }, event, args) => {
      const id = typeof args[0] === 'string' ? args[0] : '';
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent && id) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      // The manager's own read-only rule: it may close any row it shows except the agent-owned
      // ones, whose shells are not the manager's to end.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:close-session', gate);
        return false;
      }
      host.clearTerminalAgentAffinity(id);
      return TerminalManager.getInstance().closeSession(id);
    },
  },
  {
    channel: 'antifan:terminal:delete-session',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [typeof args[0] === 'string' ? args[0] : undefined],
    run: ({ host }, event, args) => {
      const id = typeof args[0] === 'string' ? args[0] : '';
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent && id) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      // Deleting is closing by another name, so the manager's read-only rule is the same one:
      // an agent-owned row is shown, never destroyed.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:delete-session', gate);
        return false;
      }
      host.clearTerminalAgentAffinity(id);
      return TerminalManager.getInstance().closeSession(id);
    },
  },
  {
    channel: TERMINAL_CHANNELS.SLEEP_SESSION,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args, host) => [host.resolveTerminalChannelId(args[0])],
    run: async ({ host }, event, args) => {
      const payload = args[0];
      const id = host.resolveTerminalChannelId(payload);
      if (!id) return { ok: false, reason: 'INVALID_PAYLOAD' };
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      // Sleeping parks a session the manager shows; an agent-owned one is the agent's to park.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:sleep-session', gate);
        return { ok: false, reason: 'NOT_PERMITTED' };
      }
      const manager = TerminalManager.getInstance();
      const result = await manager.sleepSession(id);
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
  },
  {
    channel: TERMINAL_CHANNELS.WAKE_SESSION,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args, host) => [host.resolveTerminalChannelId(args[0])],
    run: ({ host }, event, args) => {
      const payload = args[0];
      const id = host.resolveTerminalChannelId(payload);
      if (!id) return false;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      // Waking a sleeping session spawns its PTY: admitted like the other terminal RPCs, held
      // until the wake settles, and the access refusal above stays synchronous.
      // The wake is what emits 'session-woken'; the affinity tombstone written
      // while the session slept is lifted by the listener, not here.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:wake-session', gate);
        return false;
      }
      return host.admitThenRun(
        'antifan:terminal:wake-session',
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => TerminalManager.getInstance().wakeSession(id)
      );
    },
  },
  {
    channel: TERMINAL_CHANNELS.SET_CATEGORY,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args, host) => [host.resolveTerminalChannelId(args[0])],
    run: ({ host }, event, args) => {
      const payload = args[0];
      const categoryArg = args[1];
      // Accept both call shapes already used across the terminal channels: a
      // `{ id, category }` object and a positional `(id, category)` pair.
      const record = payload && typeof payload === 'object'
        ? payload as { id?: unknown; sessionId?: unknown; category?: unknown }
        : undefined;
      const id = host.resolveTerminalChannelId(payload);
      if (!id) return false;
      const category = typeof record?.category === 'string'
        ? record.category
        : (typeof categoryArg === 'string' ? categoryArg : undefined);
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      const result = TerminalManager.getInstance().setCategory(id, category);
      host.schedulePersist();
      return result;
    },
  },
  {
    channel: TERMINAL_CHANNELS.SET_ROLE,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args, host) => [host.resolveTerminalChannelId(args[0])],
    run: async ({ host }, event, args) => {
      const raw = args[0];
      const payload = raw && typeof raw === 'object' ? raw as { role?: unknown; acknowledgeDuplicate?: unknown } : {};
      const id = host.resolveTerminalChannelId(raw);
      if (!id) return { ok: false, reason: 'INVALID_PAYLOAD' };
      // Marking is an operation on a shell the manager shows, so it takes the same gate as
      // sleep: an agent-owned row is not the manager's to relabel.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal(TERMINAL_CHANNELS.SET_ROLE, gate);
        return { ok: false, reason: 'NOT_PERMITTED' };
      }
      const manager = TerminalManager.getInstance();
      const sessions = manager.listSessions() as unknown as Array<Record<string, unknown>>;
      const target = sessions.find((item) => item.id === id);
      if (!target) return { ok: false, reason: 'NOT_FOUND' };
      const baseId = typeof target.splitOf === 'string' ? target.splitOf : id;
      if (payload.role === 'sync') {
        const briefOf = (item: Record<string, unknown>) => {
          const capsuleId = typeof item.capsuleId === 'string' ? item.capsuleId : '';
          return capsuleId ? host.capsuleManager.get(capsuleId)?.brief : undefined;
        };
        const base = sessions.find((item) => item.id === baseId) ?? target;
        const identity = syncIdentity(String(base.cwd || ''), briefOf(base));
        const live = sessions
          .filter((item) => item.role === 'sync' && item.state === 'running' && !item.splitOf)
          .map((item) => ({
            id: String(item.id),
            label: String(item.displayLabel || item.name || item.id),
            folder: String(item.cwd || ''),
            brief: briefOf(item),
          }));
        const duplicate = findSyncDuplicate(identity, live, baseId);
        if (duplicate && payload.acknowledgeDuplicate !== true) {
          return { ok: false, reason: 'SYNC_DUPLICATE', duplicate: { id: duplicate.id, label: duplicate.label }, identityKind: identity.kind };
        }
        const ok = await manager.setSessionRole(id, { role: 'sync', spaceTerminalId: base.spaceTerminalId });
        host.schedulePersist();
        return ok ? { ok: true, identityKind: identity.kind } : { ok: false, reason: 'NOT_FOUND' };
      }
      if (payload.role !== null && payload.role !== undefined) return { ok: false, reason: 'INVALID_PAYLOAD' };
      const ok = await manager.setSessionRole(id, { spaceTerminalId: target.spaceTerminalId });
      host.schedulePersist();
      return ok ? { ok: true } : { ok: false, reason: 'NOT_FOUND' };
    },
  },
  {
    channel: TERMINAL_CHANNELS.SET_TAB_PREFS,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const prefs = (args[0] || {}) as Partial<TerminalTabPrefs>;
      const layoutChanged = host.applyTerminalTabPrefsFromUser(prefs);
      if (layoutChanged) {
        // The outer window geometry does not depend on the inner tab-strip
        // layout, but updateLayout is the established re-broadcast point.
        host.updateLayout();
      }
      host.schedulePersist();
      return {
        layout: host.terminalTabLayout,
        sidebarWidth: host.terminalSidebarWidth,
        collapsedCategories: host.terminalCollapsedCategories,
        categories: host.terminalCategories,
        categoryColors: host.terminalCategoryColors,
        starredCategories: host.terminalStarredCategories,
        projectOrder: host.terminalProjectOrder,
      } satisfies TerminalTabPrefs;
    },
  },
  {
    channel: TERMINAL_CHANNELS.POPOUT,
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      // A popout created after the quit committed would outlive the windows it was asked
      // from. Creating it is synchronous, so an assert is the whole gate: no close attempt
      // can interleave inside the call.
      host.assertApplicationAdmitsHostWork('antifan:terminal:popout');
      // The window mint is synchronous, so the asking window's own close is an assert too,
      // not a held admission: one synchronous step, no interleave to measure.
      host.assertOwnerAdmitsHostWork('antifan:terminal:popout', host.shellOwnerKeyForSender(event?.sender?.id));
      return host.openTerminalManager();
    },
  },
  {
    channel: TERMINAL_CHANNELS.NEW_WINDOW,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      // Same mint, same gate as the popout: a window opened into a committed teardown
      // would register its terminal after the quit passed the point of no return.
      host.assertApplicationAdmitsHostWork('antifan:window:new');
      // The window mint is synchronous, so the asking window's own close is an assert too,
      // not a held admission: one synchronous step, no interleave to measure.
      host.assertOwnerAdmitsHostWork('antifan:window:new', host.shellOwnerKeyForSender(event?.sender?.id));
      return host.openTerminalManager();
    },
  },
  {
    channel: TERMINAL_CHANNELS.CLOSE_WINDOW,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      // No popout window exists anymore: the only honest semantics left is to close the
      // window that asked — the sender's own shell included.
      const senderWin = (event?.sender ? BrowserWindow.fromWebContents(event.sender) : null);
      if (senderWin && !senderWin.isDestroyed()) {
        senderWin.close();
        return true;
      }
      return false;
    },
  },
  {
    channel: TERMINAL_CHANNELS.SET_ACTIVE_SESSION,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => {
      const p = args[0] as { sessionId?: string; id?: string } | string | undefined;
      return [typeof p === 'string' ? p : (p?.sessionId || p?.id)];
    },
    run: ({ host }, event, args) => {
      const p = args[0] as { sessionId?: string; id?: string } | string | undefined;
      const sessionId = typeof p === 'string' ? p : (p?.sessionId || p?.id);
      if (!sessionId) return true;
      // The same mint as SWITCH_SESSION by another name: this route switches too, and a switch to
      // a sleeping session materializes its PTY.
      return host.admitThenRun(
        'antifan:terminal:set-active-session',
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => TerminalManager.getInstance().switchSession(sessionId)
      );
    },
  },
  {
    channel: 'antifan:window:toggle-fullscreen',
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      const callingWin = (event?.sender ? BrowserWindow.fromWebContents(event.sender) : null) || host.shell.window;
      if (callingWin && !callingWin.isDestroyed()) {
        const next = !callingWin.isFullScreen();
        callingWin.setFullScreen(next);
        return next;
      }
      return false;
    },
  },
  {
    channel: 'antifan:toolbar:get-mobile-remote-info',
    surface: 'toolbar',
    run: ({ host }, event) => {
      if (!isTrustedSessionVaultSender(event)) {
        return null;
      }
      return BridgeServer.getInstance()?.getRemoteConnectionInfo() || null;
    },
  },
  {
    channel: 'antifan:workflow:get-state',
    surface: 'toolbar',
    run: ({ host }) => {
      const workflows = host.controlPlane ? host.controlPlane.workflowRegistry.getAll() : [];
      const tools = host.controlPlane?.transport
        ? buildMcpToolList([], host.controlPlane.transport, true).map((tool) => {
          const name = tool.name;
          const category = name.startsWith('anti.')
            ? 'mcp'
            : name.startsWith('browser.')
              ? 'browser'
              : name.startsWith('theme.')
                ? 'theme'
                : 'tool';
          const risk = tool.risk === 'write' || tool.risk === 'eval' || tool.risk === 'execute'
            ? tool.risk
            : 'read';
          return {
            id: name,
            name,
            description: tool.description || '',
            category,
            permissions: [risk],
            inputSchema: tool.inputSchema,
          };
        })
        : [];
      return { workflows, tools };
    },
  },
  {
    channel: 'antifan:workflow:get-artifact',
    surface: 'toolbar',
    run: async ({ host }, event, args) => {
      const id = args[0];
      if (!isTrustedSessionVaultSender(event)) {
        return null;
      }
      if (!host.controlPlane || typeof id !== 'string') {
        return null;
      }
      try {
        const artifactStore: object = host.controlPlane.artifacts;
        if ('resolve' in artifactStore) {
          const resolver = artifactStore.resolve;
          if (typeof resolver === 'function') {
            return await resolver.call(artifactStore, id);
          }
        }
        const { ref, data } = host.controlPlane.artifacts.readBytesById(id);
        const mime = ref.mime || 'application/octet-stream';
        const dataUrl = mime.startsWith('image/')
          ? `data:${mime};base64,${data.toString('base64')}`
          : data.toString('utf8');
        return {
          id: ref.id,
          name: path.basename(ref.path),
          mimeType: mime,
          sizeBytes: ref.byteLength,
          data: dataUrl,
          createdAt: ref.createdAt,
        };
      } catch {
        return null;
      }
    },
  },
  {
    channel: 'antifan:workflow:save',
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const item = args[0];
      if (!isTrustedSessionVaultSender(event)) {
        throw new Error('FORBIDDEN_SENDER');
      }
      if (!host.controlPlane) {
        throw new Error('Control plane runtime is not initialized');
      }
      return host.controlPlane.workflowRegistry.saveCustom(item as Parameters<typeof host.controlPlane.workflowRegistry.saveCustom>[0]);
    },
  },
  {
    channel: 'antifan:workflow:delete',
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const id = args[0];
      if (!isTrustedSessionVaultSender(event)) {
        throw new Error('FORBIDDEN_SENDER');
      }
      if (!host.controlPlane) {
        throw new Error('Control plane runtime is not initialized');
      }
      return typeof id === 'string' ? host.controlPlane.workflowRegistry.deleteCustom(id) : false;
    },
  },
  {
    channel: 'antifan:workflow:run',
    surface: 'toolbar',
    run: async ({ host }, event, args) => {
      const payload = args[0];
      if (!isTrustedSessionVaultSender(event)) {
        return { ok: false, status: 'failed', error: 'FORBIDDEN_SENDER' };
      }
      if (!host.controlPlane) {
        return { ok: false, status: 'failed', error: 'Control plane runtime is not initialized' };
      }
      if (host.activeWorkflowAbortController) {
        return { ok: false, status: 'failed', error: 'ALREADY_RUNNING' };
      }
      const raw = (payload && typeof payload === 'object') ? payload as { workflowDef?: unknown; workflowId?: unknown } : undefined;
      let wfDef: WorkflowDefinition | undefined;
      let isPreRegistered = false;
      if (raw?.workflowDef && typeof raw.workflowDef === 'object') {
        // A renderer-supplied definition carries no registry id (id lives on WorkflowItem, not
        // WorkflowDefinition): it counts as pre-registered only when it matches a registered
        // definition structurally. Otherwise it runs under the read grant.
        const supplied = raw.workflowDef as WorkflowDefinition;
        const registered = host.controlPlane.workflowRegistry.getAll().find((item) => {
          const candidate = item.definition as WorkflowDefinition;
          return candidate?.name === supplied.name
            && JSON.stringify(candidate) === JSON.stringify(supplied);
        });
        isPreRegistered = registered !== undefined;
        wfDef = supplied;
      } else if (typeof raw?.workflowId === 'string') {
        const item = host.controlPlane.workflowRegistry.getById(raw.workflowId);
        if (item?.definition) {
          wfDef = item.definition as WorkflowDefinition;
          isPreRegistered = true;
        }
      }
      if (!wfDef) {
        return { ok: false, status: 'failed', error: 'Không tìm thấy kịch bản Workflow' };
      }
      const grant = isPreRegistered ? 'write' : 'read';
      const activeTab = host.getActiveTab();
      const activeTabId = host.getActiveTabId();
      if (!activeTab || !activeTabId) {
        return { ok: false, status: 'failed', error: 'No active browser tab for workflow execution' };
      }
      const lease = host.controlPlane.getLease();
      const hostEpoch = typeof host.browserEpoch === 'number' ? host.browserEpoch : 1;
      if (hostEpoch !== lease.hostEpoch) {
        return {
          ok: false,
          status: 'failed',
          error: `Stale browser epoch: host is at epoch ${hostEpoch} but lease is at epoch ${lease.hostEpoch}`,
          completedAt: new Date().toISOString(),
        };
      }
      const target: BrowserTarget = {
        tabId: activeTabId,
        url: activeTab.url || '',
        browserEpoch: hostEpoch,
        documentGeneration: host.getDocumentGeneration(activeTabId),
        projectId: lease.projectId,
        workspaceId: lease.workspaceId || '',
        runtimeId: lease.runtimeId || '',
      };
      const abortController = new AbortController();
      host.activeWorkflowAbortController = abortController;
      try {
        const result = await host.controlPlane.executeWorkflow({
          workflow: wfDef,
          target,
          grant,
          signal: abortController.signal,
          onEvent: (event) => {
            try {
              host.shell.toolbarView?.webContents?.send?.('antifan:workflow:event', event);
            } catch (err) {
              console.error('[workflow] failed to send antifan:workflow:event', err);
            }
          },
        });
        return {
          ok: result.status === 'passed',
          status: result.status,
          completedAt: new Date().toISOString(),
          totalDurationMs: result.totalDurationMs,
          passedSteps: result.passedSteps,
          failedSteps: result.failedSteps,
          skippedSteps: result.skippedSteps,
          stepResults: result.stepResults,
          artifacts: result.artifacts,
        };
      } catch (err: unknown) {
        const errMessage = err instanceof Error ? err.message : String(err);
        return {
          ok: false,
          status: 'failed',
          error: errMessage,
          completedAt: new Date().toISOString(),
        };
      } finally {
        if (host.activeWorkflowAbortController === abortController) {
          host.activeWorkflowAbortController = null;
        }
      }
    },
  },
  {
    channel: 'antifan:workflow:abort',
    surface: 'toolbar',
    run: ({ host }) => {
      if (host.activeWorkflowAbortController) {
        host.activeWorkflowAbortController.abort();
        host.activeWorkflowAbortController = null;
        return true;
      }
      return false;
    },
  },
  {
    // The Hub's MCP detail pane invokes one advertised capability through the same
    // authority path every other caller uses: a fresh short-lived CLI session supplies
    // the attachment, the grant is derived from the capability's own declared risk
    // (never from renderer input), and the session is ended — and its attachment
    // revoked — in the finally block regardless of outcome.
    channel: 'antifan:mcp:invoke',
    surface: 'toolbar',
    run: async ({ host }, event, args) => {
      if (!isTrustedSessionVaultSender(event)) {
        return { ok: false, error: { code: 'FORBIDDEN_SENDER', message: 'Untrusted sender' } };
      }
      if (!host.controlPlane) {
        return { ok: false, error: { code: 'CONTROL_PLANE_UNAVAILABLE', message: 'Control plane runtime is not initialized' } };
      }
      const payload = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as { name?: unknown; params?: unknown; confirmRisk?: unknown };
      const name = typeof payload.name === 'string' ? payload.name.trim() : '';
      if (!name) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'name is required' } };
      }
      const definition = host.controlPlane.capabilities.get(name);
      if (!definition) {
        return { ok: false, error: { code: 'CAPABILITY_NOT_FOUND', message: `Unknown capability: ${name}` } };
      }
      const risk = definition.risk === 'write' || definition.risk === 'execute' || definition.risk === 'eval'
        ? definition.risk
        : 'read';
      if (risk !== 'read' && payload.confirmRisk !== true) {
        return { ok: false, error: { code: 'CONFIRMATION_REQUIRED', message: `Capability '${name}' has risk '${risk}'; re-invoke with confirmRisk: true.` } };
      }
      const params = (payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params))
        ? payload.params as Record<string, unknown>
        : {};
      const lease = host.controlPlane.getLease();
      const hostEpoch = typeof host.browserEpoch === 'number' ? host.browserEpoch : 1;
      if (hostEpoch !== lease.hostEpoch) {
        return { ok: false, error: { code: 'STALE_EPOCH', message: `Stale browser epoch: host ${hostEpoch} vs lease ${lease.hostEpoch}` } };
      }
      const activeTabId = host.getActiveTabId();

      let session: CliSessionResult | undefined;
      try {
        session = await host.controlPlane.createCliSession({
          backendId: 'hub-mcp-invoke',
          grant: risk,
          tabId: activeTabId || undefined,
          browserEpoch: hostEpoch,
          ttlMs: 60_000,
          ownerPid: process.pid,
        });
        const dispatchResult = await host.controlPlane.transport.dispatchIntent({
          requestId: session.attempt.id,
          idempotencyKey: `hub-mcp-${randomUUID()}`,
          attachmentId: session.launch.attachmentId,
          attachmentSecret: session.launch.secret,
          authorityRevision: session.launch.authorityRevision,
          name,
          params,
        });
        if (dispatchResult.ok) {
          return {
            ok: true,
            requestId: dispatchResult.requestId,
            invocationId: dispatchResult.invocationId,
            data: dispatchResult.data,
          };
        }
        return {
          ok: false,
          error: {
            code: dispatchResult.error?.code || 'CAPABILITY_ERROR',
            message: dispatchResult.error?.message || 'Capability dispatch failed',
            details: dispatchResult.error?.details,
          },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
        return { ok: false, error: { code: typeof code === 'string' && code ? code : 'CAPABILITY_ERROR', message } };
      } finally {
        if (session) {
          try {
            await host.controlPlane.endCliSession(session.run.id, session.attempt.id, 'completed');
          } catch {}
        }
      }
    },
  },
  {
    channel: 'antifan:core-health:get-state',
    surface: 'toolbar',
    run: async ({ host }, event, args) => {
      const opts = args[0];
      const refresh = Boolean(opts && typeof opts === 'object' && (opts as { refresh?: unknown }).refresh === true);
      try {
        const service = getCoreHealthService();
        if (refresh) service.clearCache();
        return await service.getState();
      } catch (err) {
        return {
          snapshot: {
            status: 'UNAVAILABLE',
            reasonCode: 'CORE_HEALTH_SERVICE_FAILED',
            affected: [String(err instanceof Error ? err.message : err)],
            evidenceRefs: [],
            checkedAt: new Date().toISOString(),
            checks: [],
          },
        };
      }
    },
  },
  {
    channel: 'antifan:core-health:get-task-run-trace',
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const id = args[0];
      if (typeof id !== 'string' || !id) {
        return { status: 'UNKNOWN', reasonCode: 'TASK_RUN_NOT_FOUND', affected: [], evidenceRefs: [] };
      }
      return getCoreHealthService().getTaskRunTrace(id);
    },
  },
  {
    channel: 'antifan:mcp-dispatch:get-state',
    surface: 'toolbar',
    run: async ({ host }, event) => {
      if (!isTrustedSessionVaultSender(event)) {
        // A refusal is a well-formed UNMEASURED envelope, never null: the renderer must not have to
        // distinguish null from a payload, and an absent value would render as a blank pane.
        //
        // The label is resolved lazily here, not at import time: a module-level constant would make
        // importing this host create the data directories (`StorageLocations.getDataRoot()` probes
        // and caches a process-wide root). It names the app's canonical store because a refusal
        // happens before any service instance exists and so has no injected directory to name.
        return unmeasuredBoundaryEnvelope(UnmeasuredReason.SERVICE_FAILED, ['ipc-sender-not-trusted'], mcpDispatchStoreLabel());
      }
      try { return await getMcpDispatchService().getState(); }
      catch { return unmeasuredBoundaryEnvelope(UnmeasuredReason.SERVICE_FAILED, ['service-failed'], mcpDispatchStoreLabel()); }
    },
  },
  {
    channel: 'antifan:capsule:list',
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }) => {
      // `projectId` is optional on a capsule record and a legacy record carries none, so the
      // renderer cannot always name the project window it would open before handing a terminal
      // over. The resolved id is additive: the stored record stays exactly as the store spells it,
      // and this is the same affiliation the assign route computes for itself, so the renderer
      // opens the very window the move will target instead of one it guessed.
      return {
        activeCapsuleId: host.capsuleManager.getActive()?.id || '',
        capsules: host.capsuleManager.list().map((capsule) => {
          const projectId = host.capsuleAffiliation(capsule)?.projectId;
          return projectId ? { ...capsule, resolvedProjectId: projectId } : capsule;
        }),
      };
    },
  },
  {
    channel: 'antifan:capsule:pick-folder',
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event, args) => {
      host.assertApplicationAdmitsHostWork('antifan:capsule:pick-folder');
      const opts = args[0] as { sessionId?: string } | undefined;
      const defaultDir = workspaceDialogDefaultPath();
      const result = await dialog.showOpenDialog(host.shell.window, {
        defaultPath: defaultDir,
        properties: ['openDirectory', 'createDirectory'],
        title: 'Chọn thư mục Workspace (Select Workspace Folder)',
      });
      if (result.canceled || !result.filePaths || !result.filePaths.length || !result.filePaths[0]) {
        return null;
      }
      // The modal picker can stay open for as long as the user likes, so the admission that was
      // checked when the handler started says nothing about now: re-read it immediately before
      // the mint, with no await in between, or a quit could have committed around the dialog.
      host.assertApplicationAdmitsHostWork('antifan:capsule:pick-folder');
      // The chooser can hand back a junction or 8.3 spelling of a folder that already has a capsule.
      // One canonical spelling is used for the lookup, the stored path, and the terminal cwd — the
      // same resolution a folder open performs — or an alias would mint a second row for a folder
      // the store already records.
      let chosenPath = result.filePaths[0];
      try {
        chosenPath = fs.realpathSync(chosenPath);
      } catch {
        // An unreadable path keeps the spelling the chooser returned: refusing here would take
        // away a folder the dialog was allowed to create.
      }
      const folderName = path.basename(chosenPath) || 'Workspace';
      // The admission has to be in hand before any state moves: creating or switching the
      // capsule first would leave a mutation behind when the owner reservation refuses.
      return await host.admitThenRun(
        'antifan:capsule:pick-folder',
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        async () => {
          // Pointing the shell at a folder it already has a capsule for adopts that record. The
          // switcher only re-points the shell — it never moves a capsule's affiliation — so a
          // second row for the same path would be a duplicate the next folder open has to fold
          // back together, which is how one folder became nine identically named capsules.
          const activeId = host.capsuleManager.getActive()?.id ?? '';
          const existing = findCapsuleByRoot(host.capsuleManager.list(), chosenPath, activeId);
          const target = existing ?? host.capsuleManager.create(folderName, chosenPath);
          if (target.id !== activeId) host.capsuleManager.switchTo(target.id);
          // setCapsule can spawn PTYs and is a daemon round-trip in daemon mode, so the mint
          // stays inside the held window until that call settles.
          await TerminalManager.getInstance().setCapsule(target.id, chosenPath, opts?.sessionId);
          return target;
        }
      );
    },
  },
  {
    channel: 'antifan:capsule:create',
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      host.assertApplicationAdmitsHostWork('antifan:capsule:create');
      const { name, workspacePath } = (args[0] || {}) as { name: string; workspacePath: string };
      // Both fields come from a renderer, so neither is trusted. The manager enforces only
      // "absolute", which would still accept a path that does not exist or names a file — and a
      // capsule is a filesystem anchor for PTY cwd and preview containment, so it has to be a
      // real directory. The path is resolved through the filesystem so the anchor is the
      // directory itself, never a symlink that a later containment check would compare against.
      if (typeof name !== 'string' || !name.trim()) {
        throw new Error('Capsule name is required');
      }
      if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath)) {
        throw new Error('Capsule workspace must be an absolute path');
      }
      let resolvedWorkspace = '';
      try {
        resolvedWorkspace = fs.realpathSync(workspacePath);
        if (!fs.statSync(resolvedWorkspace).isDirectory()) resolvedWorkspace = '';
      } catch {
        resolvedWorkspace = '';
      }
      if (!resolvedWorkspace) {
        throw new Error('Capsule workspace must be an existing directory');
      }
      return host.capsuleManager.create(name, resolvedWorkspace);
    },
  },
  {
    channel: 'antifan:capsule:switch',
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      host.assertApplicationAdmitsHostWork('antifan:capsule:switch');
      const { capsuleId, sessionId } = (args[0] || {}) as { capsuleId: string; sessionId?: string };
      // The admission has to be in hand before the switch: a refused owner would otherwise
      // leave the active capsule already changed. The route stays synchronous, so the held
      // window carries the manager mutation plus the setCapsule mint, releasing on every exit.
      const settled: unknown = host.admitThenRun(
        'antifan:capsule:switch',
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => {
          host.capsuleManager.switchTo(capsuleId);
          return TerminalManager.getInstance().setCapsule(capsuleId, host.capsuleManager.getActive()?.workspacePath, sessionId);
        }
      );
      // In daemon mode the settled value is a promise the synchronous route cannot await:
      // the release already rides it, so the only duty left is swallowing its rejection
      // in-band instead of leaving an unhandled rejection in main.
      const thenable = settled as { then?: unknown } | null | undefined;
      if (thenable && typeof thenable.then === 'function') {
        void Promise.resolve(settled).catch((err: unknown) => {
          console.warn(`[native-tab-host] capsule:switch '${capsuleId}' failed during setCapsule:`, err);
        });
      }
      return true;
    },
  },
  {
    channel: TERMINAL_CHANNELS.NEW_IN_FOLDER,
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event, args): Promise<TerminalNewInFolderResult> => {
      // This route mints a shell bound to ONE folder and nothing else: the capsule that
      // already records that folder is attached, or one is created for it — but nothing
      // re-points. `antifan:capsule:pick-folder` would answer the same chooser and then
      // switch the shell's capsule AND type `Set-Location` into the selected live shell,
      // which is exactly how one project's agent used to end up inside another folder.
      host.assertApplicationAdmitsHostWork(TERMINAL_CHANNELS.NEW_IN_FOLDER);
      const senderId = event?.sender?.id;
      const rawFolder = args[0] && typeof args[0] === 'object'
        ? (args[0] as { folder?: unknown }).folder
        : undefined;
      let chosen = typeof rawFolder === 'string' && rawFolder.trim() ? rawFolder.trim() : '';
      if (!chosen) {
        if (rawFolder !== undefined) {
          // A caller that named a folder field at all asked for a filesystem answer, and a
          // dialog popping open instead would answer a question nobody put to the user.
          return { ok: false, reason: 'INVALID_PAYLOAD', message: 'folder must be a non-empty string' };
        }
        // A chooser the user closes cancels the mint; a quit that commits while it hangs is
        // the same refusal, re-checked below, so nothing mints into a closing shell.
        const defaultDir = workspaceDialogDefaultPath();
        const result = await dialog.showOpenDialog(host.shell.window, {
          defaultPath: defaultDir,
          properties: ['openDirectory', 'createDirectory'],
          title: 'Chọn thư mục cho Terminal mới (Select Terminal Folder)',
        });
        chosen = !result.canceled && result.filePaths && result.filePaths.length > 0 ? result.filePaths[0] ?? '' : '';
        if (!chosen) return { ok: false, reason: 'CANCELLED', message: 'No folder chosen' };
      }
      // One canonical spelling serves the capsule lookup, the session cwd and the group the
      // row lands in: an 8.3 or junction alias minting a second row is how one folder used
      // to grow nine identically named capsules. A path that is not a real directory is
      // refused — the minted shell would otherwise run somewhere the user never asked for.
      let realPath = '';
      try {
        realPath = fs.realpathSync.native(chosen);
        if (!fs.statSync(realPath).isDirectory()) realPath = '';
      } catch {
        realPath = '';
      }
      if (!realPath) {
        return { ok: false, reason: 'FOLDER_INVALID', message: `'${chosen}' is not a readable directory` };
      }
      // A folder a window may mint into is its own workspace's: a project window naming a
      // foreign folder would land an owned terminal behind a path that window was never
      // shown, so it is refused rather than secretly re-owned. The shared manager owns no
      // folder, which is what lets it mint anywhere.
      if (!host.isSharedTerminalManagerSender(senderId)) {
        const ownRoot = host.resolveWindowWorkspaceRoot();
        if (!ownRoot || canonicalFolderKey(ownRoot) !== canonicalFolderKey(realPath)) {
          return {
            ok: false,
            reason: 'FOLDER_NOT_OWNED',
            message: ownRoot
              ? 'This window can only start terminals inside its own workspace folder'
              : 'This window owns no workspace folder to start a terminal in',
          };
        }
      }
      try {
        // The chooser may have hung open across a quit commit, so the admission is taken
        // now — the capsule lookup, any capsule create and the mint all run under it, with
        // no await between the reservation and the write that could interleave them.
        return await host.admitThenRun(
          TERMINAL_CHANNELS.NEW_IN_FOLDER,
          { ownerKey: host.shellOwnerKeyForSender(senderId) },
          async () => {
            const activeId = host.capsuleManager.getActive()?.id ?? '';
            const existing = findCapsuleByRoot(host.capsuleManager.list(), realPath, activeId);
            const capsule = existing ?? host.capsuleManager.create(path.basename(realPath) || 'Workspace', realPath);
            try {
              // The daemon mints the PTY after this call resolves: held until it settles, so a
              // Promise-shaped id is awaited exactly like the in-process string id.
              // A project window may only mint into its own folder and keeps its own key; the
              // shared manager hands the row to the folder's project so it lands in that
              // project's section instead of the triage card.
              const mintOwnerKey = host.isSharedTerminalManagerSender(senderId)
                ? host.managerFolderMintOwnerKey(realPath, capsule, senderId)
                : host.shellOwnerKeyForSender(senderId);
              const sessionId = await TerminalManager.getInstance().createSession(
                realPath,
                capsule.id,
                mintOwnerKey,
              );
              if (typeof sessionId !== 'string' || !sessionId) {
                return { ok: false, reason: 'CREATE_FAILED', message: 'Terminal minted no session id' };
              }
              return { ok: true, sessionId, capsuleId: capsule.id };
            } catch (err) {
              return { ok: false, reason: 'CREATE_FAILED', message: String(err instanceof Error ? err.message : err) };
            }
          },
        );
      } catch (err) {
        return { ok: false, reason: 'SENDER_NOT_ADMITTED', message: String(err instanceof Error ? err.message : err) };
      }
    },
  },
  {
    channel: TERMINAL_CHANNELS.SPACE_OPEN,
    surface: ['sidebar'],
    run: async ({ host }, event, args): Promise<SpaceOpenResult> => {
      host.assertApplicationAdmitsHostWork(TERMINAL_CHANNELS.SPACE_OPEN);
      const senderId = event?.sender?.id;
      const payload = args[0] && typeof args[0] === 'object' ? (args[0] as { folder?: unknown; confirmHash?: unknown }) : {};
      const folder = typeof payload.folder === 'string' ? payload.folder.trim() : '';
      if (!folder || (payload.confirmHash !== undefined && typeof payload.confirmHash !== 'string')) {
        return { ok: false, reason: 'INVALID_PAYLOAD', message: 'folder must be a non-empty string' };
      }
      let realPath = '';
      try {
        realPath = fs.realpathSync.native(folder);
        if (!fs.statSync(realPath).isDirectory()) realPath = '';
      } catch {
        realPath = '';
      }
      if (!realPath) return { ok: false, reason: 'FOLDER_INVALID', message: `'${folder}' is not a readable directory` };
      if (!host.isSharedTerminalManagerSender(senderId)) {
        const ownRoot = host.resolveWindowWorkspaceRoot();
        if (!ownRoot || canonicalFolderKey(ownRoot) !== canonicalFolderKey(realPath)) {
          return { ok: false, reason: 'FOLDER_NOT_OWNED', message: 'This window can only open its own workspace Space' };
        }
      }
      const opener = host.getSpaceWindowOpener();
      if (!opener) return { ok: false, reason: 'WINDOW_FAILED', message: 'No project window opener is installed' };
      const manager = TerminalManager.getInstance();
      let targetOwnerKey = '';
      const store = createConfirmationStore(path.join(StorageLocations.getControlPlaneDir(), 'space-confirmed.json'));
      const deps: SpaceOpenDeps = {
        folderKey: canonicalFolderKey,
        admit: () => host.assertApplicationAdmitsHostWork(TERMINAL_CHANNELS.SPACE_OPEN),
        isConfirmed: store.isConfirmed,
        recordConfirmed: store.recordConfirmed,
        openWindow: async (folderPath) => {
          const opened = await opener(folderPath);
          if (!opened.ok) return opened;
          targetOwnerKey = opened.ownerKey;
          const activeId = opened.host.capsuleManager.getActive()?.id ?? '';
          const capsule = findCapsuleByRoot(opened.host.capsuleManager.list(), folderPath, activeId);
          if (!capsule) return { ok: false, message: 'The project window has no workspace capsule for this folder' };
          const capsuleId = capsule.id;
          const windowHost = opened.host;
          return {
            ok: true,
            window: {
              capsuleId,
              hasTab: (spec) =>
                windowHost.getTabList().some((tab) => {
                  const url = typeof tab.url === 'string' ? tab.url : '';
                  if (spec.kind === 'url') return url.replace(/\/+$/, '') === spec.url.replace(/\/+$/, '');
                  if (!url.startsWith('antifan-preview://')) return false;
                  // Exact capsule + path equality (not a suffix): a different file or another
                  // capsule's preview of the same relative path is not the tab this Space declares.
                  try {
                    const parsed = parsePreviewUrl(url);
                    return parsed.capsuleId === capsuleId.toLowerCase() && parsed.relativePath === `/${spec.path}`;
                  } catch {
                    return false;
                  }
                }),
              openTab: (spec, absolutePath) => {
                const tabId =
                  spec.kind === 'url'
                    ? windowHost.createTab(spec.url, false, { capsuleId })
                    : absolutePath
                      ? windowHost.createPreviewTab(absolutePath, capsuleId)
                      : null;
                if (!tabId) return false;
                return true;
              },
            },
          };
        },
        sessions: () =>
          (manager.listSessions() as SessionSummary[]).map((s) => ({
            id: s.id,
            cwd: s.cwd,
            state: s.state,
            spaceTerminalId: s.spaceTerminalId,
          })),
        mint: async (folderPath, capsuleId, spec) =>
          await host.admitThenRun<string | null>(TERMINAL_CHANNELS.SPACE_OPEN, { ownerKey: targetOwnerKey }, async () => {
            const sessionId = await manager.createSession(folderPath, capsuleId, targetOwnerKey, {
              role: spec.role,
              idlePolicy: spec.idlePolicy,
              spaceTerminalId: spec.id,
            });
            if (typeof sessionId !== 'string' || !sessionId) return null;
            await manager.renameSession(sessionId, spec.label);
            return sessionId;
          }),
        findSyncDuplicate: (folderPath, capsuleId) => {
          const briefOf = (id: string) => (id ? host.capsuleManager.get(id)?.brief : undefined);
          const live = (manager.listSessions() as SessionSummary[])
            .filter((s) => s.role === 'sync' && s.state === 'running' && !s.splitOf)
            .map((s) => ({
              id: s.id,
              label: String(s.displayLabel || s.name || s.id),
              folder: String(s.cwd || ''),
              brief: briefOf(typeof s.capsuleId === 'string' ? s.capsuleId : ''),
            }));
          const duplicate = findSyncDuplicate(syncIdentity(folderPath, briefOf(capsuleId)), live);
          return duplicate ? { id: duplicate.id, label: duplicate.label } : undefined;
        },
        typeCommand: (sessionId, text) => manager.writeTo(sessionId, text),
        wake: async (sessionId) => (await manager.wakeSession(sessionId)) !== false,
      };
      return openSpace(deps, realPath, typeof payload.confirmHash === 'string' ? payload.confirmHash : undefined);
    },
  },
  {
    channel: TERMINAL_CHANNELS.SPACE_INIT,
    surface: ['sidebar'],
    run: async ({ host }, event, args): Promise<SpaceInitResult> => {
      host.assertApplicationAdmitsHostWork(TERMINAL_CHANNELS.SPACE_INIT);
      const senderId = event?.sender?.id;
      const rawFolder = args[0] && typeof args[0] === 'object' ? (args[0] as { folder?: unknown }).folder : undefined;
      const folder = typeof rawFolder === 'string' ? rawFolder.trim() : '';
      if (!folder) return { ok: false, reason: 'INVALID_PAYLOAD', message: 'folder must be a non-empty string' };
      let realPath = '';
      try {
        realPath = fs.realpathSync.native(folder);
        if (!fs.statSync(realPath).isDirectory()) realPath = '';
      } catch {
        realPath = '';
      }
      if (!realPath) return { ok: false, reason: 'FOLDER_INVALID', message: `'${folder}' is not a readable directory` };
      const isManager = host.isSharedTerminalManagerSender(senderId);
      if (!isManager) {
        const ownRoot = host.resolveWindowWorkspaceRoot();
        if (!ownRoot || canonicalFolderKey(ownRoot) !== canonicalFolderKey(realPath)) {
          return { ok: false, reason: 'FOLDER_NOT_OWNED', message: 'This window can only scaffold its own workspace Space' };
        }
      }
      const key = canonicalFolderKey(realPath);
      const terminals = (TerminalManager.getInstance().listSessions() as SessionSummary[])
        .filter((s) => (s.state === 'running' || s.state === 'sleeping') && typeof s.cwd === 'string' && canonicalFolderKey(s.cwd) === key)
        .map((s) => ({ label: s.name, role: s.role, idlePolicy: s.idlePolicy }));
      // Tabs belong to a project window; the shared manager owns none, so it scaffolds terminals only.
      const tabs = isManager
        ? []
        : host.getTabList().map((tab) => ({ url: typeof tab.url === 'string' ? tab.url : '' }));
      const manifest = buildSpaceTemplate(path.basename(realPath), terminals, tabs);
      try {
        if (writeSpaceManifestExclusive(realPath, manifest) === 'exists') {
          return { ok: false, reason: 'ALREADY_EXISTS', message: 'space.json already exists' };
        }
      } catch (err) {
        return { ok: false, reason: 'WRITE_FAILED', message: String(err instanceof Error ? err.message : err) };
      }
      return {
        ok: true,
        terminals: manifest.terminals.length,
        tabs: manifest.tabs.length,
        ...(antifanDirUnignoredInGit(realPath) ? { gitignoreWarning: true as const } : {}),
      };
    },
  },
  {
    channel: BRIDGE_CHANNELS.GET_STATUS,
    surface: ['sidebar', 'terminalPopout'],
    run: () => buildBridgeHealthReport(),
  },
  {
    channel: 'antifan:capsule:get-brief',
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, _event, args): CapsuleBriefResult => {
      const p = args[0] as { capsuleId?: string } | undefined;
      const capsuleId = typeof p?.capsuleId === 'string' ? p.capsuleId.trim() : '';
      if (!capsuleId) {
        return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Missing or invalid capsuleId' };
      }
      if (typeof host.capsuleManager.getBrief === 'function') {
        return host.capsuleManager.getBrief(capsuleId);
      }
      const capsule = host.capsuleManager.list().find((c) => c.id === capsuleId);
      if (!capsule) {
        return { ok: false, reason: 'UNKNOWN_CAPSULE', message: `Capsule not found: ${capsuleId}` };
      }
      return { ok: true, capsuleId, brief: capsule.brief ?? null };
    },
  },
  {
    channel: 'antifan:capsule:set-brief',
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args): CapsuleBriefResult => {
      host.assertApplicationAdmitsHostWork('antifan:capsule:set-brief');
      const p = args[0] as { capsuleId?: string; brief?: unknown } | undefined;
      if (!p || typeof p !== 'object' || typeof p.capsuleId !== 'string' || !p.capsuleId.trim()) {
        return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Missing or invalid capsuleId' };
      }
      const capsuleId = p.capsuleId.trim();
      const briefInput = p.brief;
      if (briefInput !== null && briefInput !== undefined && (typeof briefInput !== 'object' || Array.isArray(briefInput))) {
        return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Brief must be an object or null' };
      }

      if (typeof host.capsuleManager.setBrief === 'function') {
        const result = host.capsuleManager.setBrief(capsuleId, briefInput);
        if (result.ok === true && host.runStateService) {
          void host.runStateService.syncBriefs().catch((err) => {
            console.warn('[native-tab-host] syncBriefs failed after set-brief:', err);
          });
        }
        return result.ok === true
          ? { ok: true, capsuleId: result.capsuleId, brief: result.brief }
          : { ok: false, reason: result.reason, message: result.message };
      }

      return { ok: false, reason: 'UNKNOWN_CAPSULE', message: `Capsule not found: ${capsuleId}` };
    },
  },
  {
    channel: TERMINAL_CHANNELS.RUN_CONTROL,
    kind: 'handle',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { terminalSessionId?: string })?.terminalSessionId],
    run: async ({ host }, event, args): Promise<RunControlResult> => {
      const payload = (args[0] || {}) as {
        terminalSessionId?: string;
        runId?: string;
        op?: unknown;
        text?: unknown;
      };

      const op = payload.op;
      if (op !== 'cancel' && op !== 'steer') {
        return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Invalid or missing op' };
      }

      let text: string | undefined = undefined;
      if (op === 'steer') {
        if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 4000) {
          return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Steer requires non-empty text <= 4000 characters' };
        }
        text = payload.text;
      }

      let terminalSessionId = typeof payload.terminalSessionId === 'string' && payload.terminalSessionId.trim()
        ? payload.terminalSessionId.trim()
        : undefined;
      const runId = typeof payload.runId === 'string' && payload.runId.trim()
        ? payload.runId.trim()
        : undefined;

      if (!terminalSessionId && !runId) {
        return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Must specify terminalSessionId or runId' };
      }

      if (!terminalSessionId && runId) {
        // Control-plane branch
        if (!host.controlPlane?.runs) {
          return { ok: false, reason: 'RUN_CONTROL_FAILED', message: 'Control plane runs service is not available' };
        }

        let runRecord: { id: string; state: string; backendId?: string } | undefined;
        try {
          runRecord = host.controlPlane.runs.getRun(runId);
        } catch {
          return { ok: false, reason: 'RUN_NOT_ACTIVE', message: `Run '${runId}' not found` };
        }

        if (runRecord.state === 'completed' || runRecord.state === 'failed' || runRecord.state === 'interrupted') {
          return { ok: false, reason: 'RUN_NOT_ACTIVE', message: `Run '${runId}' is not active (${runRecord.state})` };
        }

        const registry = host.controlPlane.runs.attachments;
        let matchedRecord: ExecutionAttachmentRecord | undefined;
        if (registry) {
          for (const attachmentId of registry.getActiveRecordIds()) {
            const rec = registry.getRecord(attachmentId);
            if (rec && rec.runId === runId) {
              matchedRecord = rec;
              break;
            }
          }
          if (!matchedRecord) {
            const internalRegistry = registry as unknown as { records?: Map<string, ExecutionAttachmentRecord> };
            if (internalRegistry.records instanceof Map) {
              for (const rec of internalRegistry.records.values()) {
                if (rec && rec.runId === runId) {
                  matchedRecord = rec;
                  break;
                }
              }
            }
          }
        }

        const originTerminalSessionId = matchedRecord?.originTerminalSessionId;
        if (!originTerminalSessionId || !host.isSessionVisibleToWindow(originTerminalSessionId, undefined, event?.sender?.id)) {
          return { ok: false, reason: 'SESSION_NOT_VISIBLE', message: `Origin session for run '${runId}' is not visible to this window` };
        }

        const gate = host.assertManagerMayOperate(originTerminalSessionId, event?.sender?.id);
        if (gate !== true) {
          return { ok: false, reason: gate.reason as RunControlReason, message: gate.message };
        }

        const backendId = runRecord.backendId || matchedRecord?.backendId || '';
        if (backendId === 'cli') {
          const runsDir = path.join(StorageLocations.getRuntimeDir(), 'runs');
          const runFilePath = path.join(runsDir, `${originTerminalSessionId}.json`);
          let isLiveRun = false;
          try {
            if (fs.existsSync(runFilePath)) {
              const data = JSON.parse(fs.readFileSync(runFilePath, 'utf8'));
              if (data && (data.state === 'running' || data.state === 'waiting_user')) {
                isLiveRun = true;
              }
            }
          } catch {}

          if (isLiveRun) {
            terminalSessionId = originTerminalSessionId;
            // Falls through to terminal branch below
          } else {
            return { ok: false, reason: 'RUN_NOT_ACTIVE', message: `No active run for session '${originTerminalSessionId}'` };
          }
        } else {
          if (op === 'steer') {
            return { ok: false, reason: 'RUN_CONTROL_UNSUPPORTED', message: 'Steer is not supported on control-plane runs' };
          }
          const backend = host.runBackendFor(backendId);
          if (!backend) {
            return { ok: false, reason: 'RUN_BACKEND_UNAVAILABLE', message: `Backend '${backendId}' is not registered` };
          }
          try {
            await host.controlPlane.runs.cancel(runId, backend);
            return { ok: true, op: 'cancel', at: Date.now() };
          } catch (err) {
            return { ok: false, reason: 'RUN_CONTROL_FAILED', message: (err as Error)?.message || 'Failed to cancel run' };
          }
        }
      }

      if (terminalSessionId) {
        // Terminal branch
        const gate = host.assertManagerMayOperate(terminalSessionId, event?.sender?.id);
        if (gate !== true) {
          return { ok: false, reason: gate.reason as RunControlReason, message: gate.message };
        }

        if (!host.isSessionVisibleToWindow(terminalSessionId, undefined, event?.sender?.id)) {
          return { ok: false, reason: 'SESSION_NOT_VISIBLE', message: `Session '${terminalSessionId}' does not belong to this window` };
        }

        const runsDir = path.join(StorageLocations.getRuntimeDir(), 'runs');
        const runFilePath = path.join(runsDir, `${terminalSessionId}.json`);
        let runFile: { state?: string; ompSessionId?: string; runSeq?: number } | null = null;
        try {
          if (fs.existsSync(runFilePath)) {
            runFile = JSON.parse(fs.readFileSync(runFilePath, 'utf8'));
          }
        } catch {
          runFile = null;
        }

        if (!runFile || (runFile.state !== 'running' && runFile.state !== 'waiting_user') || !runFile.ompSessionId) {
          return { ok: false, reason: 'RUN_NOT_ACTIVE', message: `Run is not active for session '${terminalSessionId}'` };
        }

        const controlDir = path.join(runsDir, 'control', runFile.ompSessionId);
        try {
          fs.mkdirSync(controlDir, { recursive: true });
        } catch {}

        const nonce = randomUUID();
        const reqPath = path.join(controlDir, `${nonce}.json`);
        const tmpPath = path.join(controlDir, `${nonce}.tmp-${process.pid}-${Date.now()}`);
        const ackPath = path.join(controlDir, `${nonce}.ack.json`);

        const now = Date.now();
        const requestPayload = {
          schema: 1,
          op,
          ...(text ? { text } : {}),
          runSeq: typeof runFile.runSeq === 'number' ? runFile.runSeq : 0,
          requestedAt: now,
          expiresAt: now + 15_000,
        };

        try {
          fs.writeFileSync(tmpPath, JSON.stringify(requestPayload), 'utf8');
          fs.renameSync(tmpPath, reqPath);
        } catch (err) {
          try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
          return { ok: false, reason: 'RUN_CONTROL_FAILED', message: `Failed to write control request: ${(err as Error)?.message || String(err)}` };
        }

        const pollIntervalMs = 100;
        const deadline = Date.now() + RUN_CONTROL_ACK_TIMEOUT_MS;
        let ackContent: string | null = null;

        while (Date.now() < deadline) {
          try {
            if (fs.existsSync(ackPath)) {
              ackContent = fs.readFileSync(ackPath, 'utf8');
              try { fs.unlinkSync(ackPath); } catch {}
              break;
            }
          } catch {}
          const { promise, resolve } = Promise.withResolvers<void>();
          setTimeout(resolve, pollIntervalMs);
          await promise;
        }

        try { if (fs.existsSync(reqPath)) fs.unlinkSync(reqPath); } catch {}

        if (!ackContent) {
          return { ok: false, reason: 'RUN_CONTROL_TIMEOUT', message: 'Timed out waiting for run control acknowledgement' };
        }

        try {
          const ack = JSON.parse(ackContent);
          if (ack && ack.ok === true) {
            return { ok: true, op, at: typeof ack.at === 'number' ? ack.at : Date.now() };
          }
          const errorStr = typeof ack?.error === 'string' ? ack.error : '';
          if (KNOWN_RUN_CONTROL_REASONS.has(errorStr as RunControlReason)) {
            return { ok: false, reason: errorStr as RunControlReason, message: typeof ack?.message === 'string' ? ack.message : errorStr };
          }
          return { ok: false, reason: 'RUN_CONTROL_FAILED', message: typeof ack?.message === 'string' ? ack.message : (errorStr || 'Run control failed') };
        } catch {
          return { ok: false, reason: 'RUN_CONTROL_FAILED', message: 'Malformed run control acknowledgement' };
        }
      }

      return { ok: false, reason: 'INVALID_PAYLOAD', message: 'Must specify terminalSessionId or runId' };
    },
  },
  {
    channel: TERMINAL_CHANNELS.ASSIGN_PROJECT,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const raw = args[0];
      const payload = raw && typeof raw === 'object' ? raw : {};
      const sessionId = 'sessionId' in payload && typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      const projectId = 'projectId' in payload && typeof payload.projectId === 'string' ? payload.projectId.trim() : '';
      const refused = (reason: TerminalProjectAssignReason, message: string): TerminalProjectAssignResult => ({ ok: false, reason, message });
      // Both ids come from a renderer, so neither is trusted: a session id nothing owns and a
      // project id Main's own directory cannot resolve are answered, not attempted.
      if (!sessionId || !projectId) {
        return refused('INVALID_PAYLOAD', 'assign-project needs both a sessionId and a projectId');
      }
      const assignment = host.projectAssignmentFor(projectId);
      if (!assignment) {
        return refused('PROJECT_UNAVAILABLE', `Project '${projectId}' has no unambiguous terminal assignment`);
      }
      const ownerKeyValue = ownerKey({ kind: 'project', projectId });
      // No per-project window exists, and the Terminal Manager renders every `project:` row
      // whether or not the web hub is open, so the target is always a window that can show
      // the row; the visibility and manager gates below decide whether *this* sender may act.
      if (!host.ownerWindowPresenceFor(ownerKey({ kind: 'unassigned' })) && !host.isSharedTerminalManagerSender(event?.sender?.id)) {
        return refused('TARGET_WINDOW_ABSENT', 'No open Terminal Manager can show the moved session');
      }
      // The manager reads every row; it drives none of the agent-owned ones. A window that cannot
      // even see the session has no authority over it either, which is what keeps one project's
      // terminal from being re-homed by another project's window.
      const gate = host.assertManagerMayOperate(sessionId, event?.sender?.id);
      if (gate !== true) return refused(gate.reason, gate.message);
      // The web hub is every project's window, but its live scope is only the project it
      // presents — and the shipped move flow switches that scope before this IPC resolves
      // (`openProject` then `assignTerminalProject`), which would hide the source row and refuse
      // its own user's gesture. The hub therefore re-homes a project/web/unassigned row without
      // presenting it first; agent-owned rows keep the strict visibility check because the hub
      // is never their owner.
      const senderOwnerKey = host.shellOwnerKeyForSender(event?.sender?.id);
      const rowOwner = parseOwnerKey(TerminalManager.getInstance().sessionOwnerKey(sessionId) || '');
      // A `project:` row owned by a live detached shell is NOT the hub's to move: the
      // exclusivity the detach guards enforce would be defeated by a hub-side assign
      // silently re-homing it. Unassigned/web rows keep the shipped exception.
      const hubRowVisible = senderOwnerKey === WEB_OWNER_KEY
        && (rowOwner.kind === 'unassigned' || rowOwner.kind === 'web'
          || (rowOwner.kind === 'project' && !host.detachedShellOwns(rowOwner.projectId)));
      if (!hubRowVisible && !host.isSessionVisibleToWindow(sessionId, undefined, event?.sender?.id)) {
        return refused('SESSION_NOT_VISIBLE', `Session '${sessionId}' does not belong to this window`);
      }
      const capsuleId = assignment.capsuleId;
      const success = (): TerminalProjectAssignResult => ({
        ok: true,
        sessionId,
        projectId,
        ownerKey: ownerKeyValue,
        ...(capsuleId ? { capsuleId } : {}),
      });
      // The move re-stamps a live row, so it is admitted like every other mutation: a close attempt
      // that already began measures this work instead of a row changing hands underneath it.
      const settled: unknown = host.admitThenRun(
        TERMINAL_CHANNELS.ASSIGN_PROJECT,
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => {
          const transferred: unknown = TerminalManager.getInstance().transferSessionOwner(sessionId, ownerKeyValue, capsuleId);
          // The singleton is a daemon proxy installed by cast: it answers the same boolean the
          // in-process manager does, but as the settlement of its round-trip, so a refusal is read
          // off whichever answer arrives.
          const thenable = transferred as { then?: unknown } | null | undefined;
          if (thenable && typeof thenable.then === 'function') {
            return Promise.resolve(transferred).then((moved: unknown) =>
              moved === true ? success() : refused('UNKNOWN_SESSION', `No live session '${sessionId}'`)
            );
          }
          return transferred === true
            ? success()
            : refused('UNKNOWN_SESSION', `No live session '${sessionId}'`);
        }
      );
      return settled;
    },
  },
  {
    channel: TERMINAL_CHANNELS.OPEN_LINK,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const raw = args[0];
      const payload = raw && typeof raw === 'object' ? raw : {};
      const sessionId = 'sessionId' in payload && typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      const url = 'url' in payload && typeof payload.url === 'string' ? payload.url.trim() : '';
      const refused = (reason: TerminalProjectLinkReason, message: string): TerminalProjectLinkResult => ({ ok: false, reason, message });
      if (!sessionId || !url || !isAllowedNavigation(url)) {
        return refused('INVALID_PAYLOAD', 'open-link needs a sessionId and a navigable url');
      }
      const gate = host.assertManagerMayOperate(sessionId, event?.sender?.id);
      if (gate !== true) return refused(gate.reason, gate.message);
      if (!host.isSessionVisibleToWindow(sessionId, undefined, event?.sender?.id)) {
        return refused('SESSION_NOT_VISIBLE', `Session '${sessionId}' does not belong to this window`);
      }
      let ownerKeyValue = '';
      try {
        ownerKeyValue = TerminalManager.getInstance().sessionOwnerKey(sessionId) || '';
      } catch {
        ownerKeyValue = '';
      }
      if (!ownerKeyValue) {
        return refused('UNKNOWN_SESSION', `No live session '${sessionId}'`);
      }
      // The three refusals above separate on their own evidence, and each one is the one its own
      // caller can act on: the manager's chrome is told agent rows are read-only, a window that
      // never saw the row is told so, and only a caller with neither objection - a popout
      // presenting the agent's own session, whose host-scope check passes - reaches this one,
      // where the honest answer is that no project window owns the row to open the link in.
      if (parseOwnerKey(ownerKeyValue).kind === 'agent') {
        return refused('TERMINAL_OWNER_UNAVAILABLE', `Session '${sessionId}' is owned by an agent, not a project window`);
      }
      const opener = host.terminalLinkOpener;
      if (!opener) {
        return refused('TARGET_WINDOW_ABSENT', `No project window can own '${ownerKeyValue}'`);
      }
      const success = (): TerminalProjectLinkResult => ({ ok: true, sessionId, ownerKey: ownerKeyValue });
      const targetAbsent = (): TerminalProjectLinkResult => refused('TARGET_WINDOW_ABSENT', `No project window can own '${ownerKeyValue}'`);
      const opened: unknown = host.admitThenRun(
        TERMINAL_CHANNELS.OPEN_LINK,
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => opener(ownerKeyValue, url),
      );
      const thenable = opened as { then?: unknown } | null | undefined;
      if (thenable && typeof thenable.then === 'function') {
        return Promise.resolve(opened)
          .then((openedInTarget) => (openedInTarget === true ? success() : targetAbsent()))
          .catch(() => targetAbsent());
      }
      return opened === true ? success() : targetAbsent();
    },
  },
  {
    channel: 'antifan:standalone:open-workspace',
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event, args) => {
      const opts = args[0] as { sessionId?: string } | undefined;
      const activeTab = host.tabs.get(host.activeTabId);
      const targetWorkspace = host.resolveTargetWorkspace(opts?.sessionId, activeTab?.state.url);
      if (targetWorkspace) {
        const normalized = path.normalize(targetWorkspace);
        if (fs.existsSync(normalized)) {
          const errMsg = await shell.openPath(normalized);
          if (errMsg) {
            console.error('[OpenWorkspace] shell.openPath error:', errMsg);
            return { ok: false, error: errMsg };
          }
          return { ok: true, workspacePath: normalized };
        }
      }
      const fallback = fs.existsSync('e:\\Work') ? 'e:\\Work' : process.cwd();
      await shell.openPath(fallback);
      return { ok: true, workspacePath: fallback };
    },
  },
  {
    channel: SIDEBAR_CHANNELS.GET_INITIAL_STATE,
    surface: ['sidebar', 'terminalPopout'],
    run: async ({ host }, event) => {
      const activeTab = host.tabs.get(host.activeTabId);
      const targetWorkspace = host.resolveTabWorkspace(host.activeTabId, activeTab?.state.url);
      const runs = host.runStateService ? await host.runStateService.getRuns() : [];
      return {
        isOpen: host.shell.isSidebarOpen,
        width: host.shell.sidebarWidth,
        workspacePath: targetWorkspace,
        activeWorkspace: targetWorkspace,
        runCards: host.runCardsForWindow(runs, event?.sender?.id),
        // Boot-time prefs so the renderer can paint the persisted tab layout
        // without a second IPC round-trip.
        terminalTabPrefs: {
          layout: host.terminalTabLayout,
          sidebarWidth: host.terminalSidebarWidth,
          collapsedCategories: host.terminalCollapsedCategories,
          categories: host.terminalCategories,
          categoryColors: host.terminalCategoryColors,
          starredCategories: host.terminalStarredCategories,
          projectOrder: host.terminalProjectOrder,
        } satisfies TerminalTabPrefs,
        // The renderer scopes its shell owner off this identity, same contract
        // the toolbar publishes: a project shell its project, the shared
        // manager shell Unassigned.
        projectWindow: host.projectWindowIdentity(),
      };
    },
  },
  {
    channel: SIDEBAR_CHANNELS.CLOSE_SIDEBAR,
    surface: 'sidebar',
    run: ({ host }) => {
      host.toggleSidebar();
    },
  },
  {
    channel: SIDEBAR_CHANNELS.SET_WIDTH,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const width = typeof args[0] === 'number' ? args[0] : 0;
      host.shell.sidebarWidth = Math.max(260, Math.min(width, 850));
      host.updateLayout();
      host.schedulePersist();
    },
  },
  ];

  public surfaceForWebContents(webContentsId: number): ChromeSurface | 'terminalPopout' | 'devtools' | 'tab' | undefined {
    const shellSurface = this.shell.chromeSurfaceFor(webContentsId);
    if (shellSurface) return shellSurface;

    if (this.popoutWindow && !this.popoutWindow.isDestroyed() && this.popoutWindow.webContents?.id === webContentsId) {
      return this.isShowingTerminalWorkbenchPage(this.popoutWindow) ? 'terminalPopout' : undefined;
    }
    for (const win of this.terminalWindows.values()) {
      if (!win.isDestroyed() && win.webContents?.id === webContentsId) {
        return this.isShowingTerminalWorkbenchPage(win) ? 'terminalPopout' : undefined;
      }
    }
    // A terminal window whose own host is gone is still a terminal window, and any live host
    // answers for it: that answer is what lets a later close attempt reach a window a disposed
    // host had to leave behind (see `unownedTerminalWindows`).
    const unownedTerminal = unownedTerminalWindowFor(webContentsId);
    if (unownedTerminal) {
      return this.isShowingTerminalWorkbenchPage(unownedTerminal.window) ? 'terminalPopout' : undefined;
    }

    if (this.tabs) {
      for (const tab of this.tabs.values()) {
        if (!tab.view?.webContents?.isDestroyed() && tab.view?.webContents?.devToolsWebContents?.id === webContentsId) {
          return 'devtools';
        }
        if (tab.mobileView && !tab.mobileView.webContents.isDestroyed() && tab.mobileView.webContents.devToolsWebContents?.id === webContentsId) {
          return 'devtools';
        }
      }
    }
    if (this.shell.window && !this.shell.window.isDestroyed() && this.shell.window.webContents?.devToolsWebContents?.id === webContentsId) {
      return 'devtools';
    }
    if (this.shell.toolbarView && !this.shell.toolbarView.webContents.isDestroyed() && this.shell.toolbarView.webContents.devToolsWebContents?.id === webContentsId) {
      return 'devtools';
    }
    if (this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed() && this.shell.sidebarView.webContents.devToolsWebContents?.id === webContentsId) {
      return 'devtools';
    }
    if (this.shell.frameBackdropView && !this.shell.frameBackdropView.webContents.isDestroyed() && this.shell.frameBackdropView.webContents.devToolsWebContents?.id === webContentsId) {
      return 'devtools';
    }

    // A member page reports about itself (its own mutations, its own wheel zoom). It is resolved
    // last so that no chrome surface or auxiliary window answer is ever shadowed by a tab, and it
    // is resolved at all because the alternative is refusing the page's own messages: routes that
    // belong to a page declare `surface: 'tab'`, and every other route keeps refusing them.
    if (this.tabs) {
      for (const tab of this.tabs.values()) {
        const desktop = tab.view?.webContents;
        if (desktop && !desktop.isDestroyed() && desktop.id === webContentsId) return 'tab';
        const mobile = tab.mobileView?.webContents;
        if (mobile && !mobile.isDestroyed() && mobile.id === webContentsId) return 'tab';
      }
    }

    return undefined;
  }

  /**
   * A terminal workbench window keeps its surface role only while it still shows
   * the renderer page it was created with. A window navigated to anything else
   * (a link, a redirect) is refused rather than trusted by window identity — the
   * same expected-page rule the chrome surfaces already enforce.
   */
  private isShowingTerminalWorkbenchPage(win: BrowserWindow): boolean {
    const contents = win.webContents;
    if (!contents || contents.isDestroyed()) return false;
    const frameUrl = contents.mainFrame?.url || (typeof contents.getURL === 'function' ? contents.getURL() : '');
    // Nothing to identify yet (a window before its first navigation): not evidence of a
    // foreign page, so the window keeps its surface role as before.
    if (!frameUrl) return true;
    // A page replaced the workbench: the window is refused rather than trusted by identity.
    if (!frameUrl.startsWith('file:')) return false;
    try {
      const loaded = path.resolve(fileURLToPath(new URL(frameUrl)));
      const expected = path.resolve(this.resolveStandaloneRendererPage());
      return process.platform === 'win32' ? loaded.toLowerCase() === expected.toLowerCase() : loaded === expected;
    } catch {
      return false;
    }
  }

  /** The standalone renderer page used by terminal workbench windows. */
  private resolveStandaloneRendererPage(): string {
    const bundled = path.join(__dirname, '..', '..', 'renderer', 'standalone.html');
    if (fs.existsSync(bundled)) return bundled;
    return path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
  }

  /**
   * True for the shared Terminal Manager: a terminals-only window with no page area or tabs.
   * Only an explicit `unassigned` owner qualifies; a host whose shell carries no owner keeps
   * the browser behaviour (default tab, closable sidebar) rather than losing its pages.
   */
  private isTerminalOnlyWindow(): boolean {
    return this.shell?.owner?.kind === 'unassigned';
  }

  public toggleSidebar(): boolean {
    // The Terminal Manager's sidebar is the whole window; closing it would leave nothing.
    if (this.isTerminalOnlyWindow()) return true;
    this.shell.isSidebarOpen = !this.shell.isSidebarOpen;
    this.updateLayout();
    this.broadcastState();
    if (this.shell.isSidebarOpen && this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
      const contents = this.shell.sidebarView.webContents;
      const projection = this.terminalStateForWindow(TerminalManager.getInstance().getSessionState(), undefined, contents.id);
      this.terminalDisplayedSessions.set(`c${contents.id}`, this.displayedSessionIdsOf(projection));
      safeSendWebContents(contents, 'antifan:terminal:session', projection);
    }
    return this.shell.isSidebarOpen;
  }

  private openInVSCode(targetPath?: string): { ok: boolean; error?: string; workspacePath?: string } {
    let cleanPath = typeof targetPath === 'string' ? targetPath.trim() : '';
    let lineColSuffix = '';
    if (cleanPath) {
      const lineColMatch = cleanPath.match(/:\d+(?::\d+)?$/);
      if (lineColMatch) {
        lineColSuffix = lineColMatch[0];
        cleanPath = cleanPath.slice(0, cleanPath.length - lineColSuffix.length);
      }
    }

    let resolvedTarget = cleanPath;
    let isFile = false;

    // If not found directly, try resolving relative path against active workspace
    if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
      const activeSessionId = TerminalManager.getInstance().getActiveSessionId();
      const activeTab = this.tabs.get(this.activeTabId);
      const ws = this.resolveTargetWorkspace(activeSessionId, activeTab?.state.url);
      if (ws && cleanPath && !path.isAbsolute(cleanPath)) {
        const candidate = path.resolve(ws, cleanPath);
        if (fs.existsSync(candidate)) {
          resolvedTarget = candidate;
        }
      }
      if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
        resolvedTarget = ws ?? '';
      }
    }

    if (!resolvedTarget || !fs.existsSync(resolvedTarget)) {
      return { ok: false, error: 'WORKSPACE_NOT_FOUND' };
    }

    try {
      const stat = fs.statSync(resolvedTarget);
      isFile = stat.isFile();
    } catch {}

    try {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'code.cmd' : 'code';
      const args: string[] = ['-r'];
      if (isFile) {
        args.push('-g', `${resolvedTarget}${lineColSuffix}`);
      } else {
        args.push(resolvedTarget);
      }
      const child = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      child.unref();
      return { ok: true, workspacePath: resolvedTarget };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private setupGlobalShortcutsOnView(wc: Electron.WebContents | null | undefined, tabId?: string): void {
    if (!wc) return;
    wc.on('before-input-event', (_event, input) => {
      // Real user input (keyboard) on this tab is keep-alive evidence for the
      // hibernation sweep — a page the user is typing into is never idle. This
      // runs before the agent-preemption check so a user's own keystroke always
      // resets the clock even while an agent drives another tab.
      if (tabId) {
        const rec = this.tabs.get(tabId);
        if (rec) rec.lastActiveAt = Date.now();
      }
      if (this.agentInputInFlight === 0 && this.viewportGate) {
        const automationTargetTabId = this.automationTabId;
        // Scoped User Preemption (RT-01):
        // If tabId is not explicitly bound (e.g. toolbarView), the event belongs to the current foreground tab (this.activeTabId).
        // Only preempt the active agent if the physical keyboard input occurred on the automation target tab.
        // User typing on Tab 2 (YouTube/Chat or toolbar URL bar) must never cancel or poison background agent work on Tab 1.
        const eventTabId = tabId ?? this.activeTabId;
        if (automationTargetTabId && eventTabId === automationTargetTabId) {
          this.viewportGate.preemptActiveAgent('Manual keyboard input detected on tab', eventTabId);
        }
      }
      if (input.type !== 'keyDown') return;
      const isCtrlOrCmd = input.control || input.meta;
      // Note: Standard application shortcuts (CmdOrCtrl+T, CmdOrCtrl+Shift+T, CmdOrCtrl+W,
      // CmdOrCtrl+R, CmdOrCtrl+Shift+R, CmdOrCtrl+Alt+B, F12, CmdOrCtrl+F, zoom, etc.)
      // are authoritatively registered in app-menu.ts to prevent duplicate execution.
      // This listener handles ONLY non-menu WebContents navigation & inspection shortcuts.

      // 1. Ctrl+Tab / Ctrl+Shift+Tab -> Switch Tab
      if (isCtrlOrCmd && input.key === 'Tab') {
        _event.preventDefault();
        const userTabs = this.tabOrder.filter((id) => {
          const t = this.tabs.get(id);
          return t && t.state.ephemeral !== true;
        });
        if (userTabs.length > 1) {
          const currIdx = userTabs.indexOf(this.activeTabId);
          const nextIdx = input.shift ? (currIdx - 1 + userTabs.length) % userTabs.length : (currIdx + 1) % userTabs.length;
          this.switchTab(userTabs[nextIdx]!, { plane: 'user' });
        }
        return;
      }

      // 2. Ctrl+U -> View Page Source
      if (isCtrlOrCmd && !input.shift && input.key.toLowerCase() === 'u') {
        _event.preventDefault();
        this.viewPageSource(this.activeTabId);
        return;
      }

      // 3. Ctrl+L -> Focus Omnibox
      if (isCtrlOrCmd && input.key.toLowerCase() === 'l') {
        _event.preventDefault();
        safeSendWebContents(this.shell.toolbarView?.webContents, 'antifan:focus-omnibox');
        return;
      }

      // 4. Esc -> Stop Inspect / Font Finder / Lens / Find
      if (input.key === 'Escape') {
        // A chrome view owns Escape for its own overlays: the toolbar's document-level chain closes
        // tab search, the app and profile dropdowns, the shortcuts sheet, the theme-QA panel, the
        // find bar and the omnibox suggestions. A key main has already consumed never reaches that
        // renderer, so the chrome keeps its key while the shortcut's own work still applies.
        if (tabId) _event.preventDefault();
        if (this.isInspecting) this.stopInspect();
        if (this.isFontFinderActive) this.stopFontFinder();
        if (this.isLensActive) this.stopLens();
        this.stopFindInPage();
      }
    });
  }

  private setupContextMenu(wc: Electron.WebContents, paneId?: SplitPaneId): void {
    wc.on('context-menu', async (_event, params) => {
      if (this.activeTabId) {
        const tab = this.tabs.get(this.activeTabId);
        if (tab && tab.state.splitMode && paneId && tab.focusedPane !== paneId) {
          tab.focusedPane = paneId;
          tab.state.splitFocusedPane = paneId;
          this.broadcastState();
        }
      }

      try {
        const menu = new Menu();
        const uploader = HaravanUploader.getInstance();

        // ─── 1. AI & Design Inspection Tools ───
      menu.append(
        new MenuItem({
          label: '🎯 Inspect Element (Attach to AI Chat)',
          accelerator: 'Alt+Ctrl+A',
          click: () => this.startInspect(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔤 Font Finder (Typography)',
          accelerator: 'Alt+Ctrl+F',
          click: () => this.toggleFontFinder(),
        })
      );
      menu.append(
        new MenuItem({
          label: '📐 Pixel Ruler Layout Grid',
          accelerator: 'Alt+Ctrl+R',
          click: () => this.toggleRuler(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔍 GPU Lens (Pixel Zoom)',
          accelerator: 'Alt+Ctrl+L',
          click: () => this.toggleLens(),
        })
      );
      menu.append(
        new MenuItem({
          label: '💬 Toggle AI Chat Sidebar',
          accelerator: 'Alt+Ctrl+B',
          click: () => this.toggleSidebar(),
        })
      );

      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 2. Haravan Image Toolkit (Always Active for Images) ───
      let imageUrl = (params.srcURL && (params.mediaType === 'image' || params.srcURL.match(/\.(png|jpe?g|webp|gif|svg|avif)(\?.*)?$/i))) ? params.srcURL : '';

      if (!imageUrl && !wc.isDestroyed()) {
        try {
          const detected = await wc.executeJavaScript(`
            (function() {
              try {
                var el = document.elementFromPoint(${params.x}, ${params.y});
                if (!el) return '';
                if (el.tagName === 'IMG' && (el.currentSrc || el.src)) return el.currentSrc || el.src;
                var img = el.querySelector('img');
                if (img && (img.currentSrc || img.src)) return img.currentSrc || img.src;
                var bg = window.getComputedStyle(el).backgroundImage;
                if (bg && bg.startsWith('url(')) {
                  return bg.slice(4, -1).replace(/^["']|["']$/g, '');
                }
                var p = el.parentElement;
                for (var i = 0; i < 6 && p && p !== document.body; i++) {
                  if (p.tagName === 'IMG' && (p.currentSrc || p.src)) return p.currentSrc || p.src;
                  var pImg = p.querySelector('img');
                  if (pImg && (pImg.currentSrc || pImg.src)) return pImg.currentSrc || pImg.src;
                  var pBg = window.getComputedStyle(p).backgroundImage;
                  if (pBg && pBg.startsWith('url(')) {
                    return pBg.slice(4, -1).replace(/^["']|["']$/g, '');
                  }
                  p = p.parentElement;
                }
                return '';
              } catch (e) {
                return '';
              }
            })()
          `, true);
          if (detected && typeof detected === 'string' && (detected.startsWith('http://') || detected.startsWith('https://') || detected.startsWith('data:image/'))) {
            imageUrl = detected;
          }
        } catch {}
      }

      if (imageUrl) {
        menu.append(
          new MenuItem({
            label: '⚡ Save PNG + Upload Haravan (Copy CDN)',
            click: () => uploader.uploadImageToHaravan(imageUrl, undefined, this.shell.window),
          })
        );

        const saveAsSubmenu = new Menu();
        for (const format of ['png', 'jpg', 'webp', 'pdf', 'gif'] as const) {
          saveAsSubmenu.append(
            new MenuItem({
              label: `Save as ${format.toUpperCase()}`,
              click: () => uploader.saveImageAs(imageUrl, format, this.shell.window),
            })
          );
        }

        menu.append(
          new MenuItem({
            label: '💾 Save Image As',
            submenu: saveAsSubmenu,
          })
        );

        menu.append(
          new MenuItem({
            label: 'ℹ️ View Image Info & Dimensions',
            click: () => uploader.showImageInfo(imageUrl, this.shell.window, wc),
          })
        );
        menu.append(
          new MenuItem({
            label: '📋 Copy Image Address',
            click: () => clipboard.writeText(imageUrl),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 3. Link Actions ───
      if (params.linkURL) {
        menu.append(
          new MenuItem({
            label: 'Open Link in New Tab',
            click: () => this.createTab(params.linkURL),
          })
        );
        menu.append(
          new MenuItem({
            label: 'Copy Link Address',
            click: () => clipboard.writeText(params.linkURL),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 4. Selection Tools ───
      if (params.selectionText) {
        menu.append(
          new MenuItem({
            label: `Search Google for "${params.selectionText.slice(0, 20)}..."`,
            click: () => this.createTab(`https://www.google.com/search?q=${encodeURIComponent(params.selectionText)}`),
          })
        );
        menu.append(
          new MenuItem({
            label: 'Copy Selection',
            role: 'copy',
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 5. Navigation ───
      interface NavigationHistoryCarrier {
        navigationHistory?: {
          canGoBack?: () => boolean;
          canGoForward?: () => boolean;
          goBack?: () => void;
          goForward?: () => void;
        };
      }
      const navHistory = (wc as unknown as NavigationHistoryCarrier).navigationHistory;
      const canBack = navHistory?.canGoBack?.() ?? false;
      menu.append(
        new MenuItem({
          label: '⬅️ Back',
          enabled: canBack,
          click: () => {
            if (navHistory?.canGoBack?.() && typeof navHistory.goBack === 'function') {
              navHistory.goBack();
            } else {
              this.goBack(this.activeTabId);
            }
          },
        })
      );
      const canForward = navHistory?.canGoForward?.() ?? false;
      menu.append(
        new MenuItem({
          label: '➡️ Forward',
          enabled: canForward,
          click: () => {
            if (navHistory?.canGoForward?.() && typeof navHistory.goForward === 'function') {
              navHistory.goForward();
            } else {
              this.goForward(this.activeTabId);
            }
          },
        })
      );
      menu.append(
        new MenuItem({
          label: '🔄 Reload',
          accelerator: 'Ctrl+R',
          click: () => {
            if (!wc.isDestroyed()) {
              wc.reload();
            } else {
              this.reload(this.activeTabId);
            }
          },
        })
      );
      menu.append(
        new MenuItem({
          label: '↗️ Open in External Browser',
          click: () => {
            const active = this.getActiveTab();
            if (active?.url) shell.openExternal(active.url);
          },
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 6. Developer Tools & Source Viewer ───
      menu.append(
        new MenuItem({
          label: '📄 View Page Source',
          accelerator: 'Ctrl+U',
          click: () => this.viewPageSource(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '🛠️ Inspect in DevTools',
          accelerator: 'F12',
          click: () => {
            if (!wc.isDestroyed()) {
              if (wc.isDevToolsOpened()) {
                wc.closeDevTools();
              } else {
                wc.openDevTools({ mode: 'detach' });
              }
            } else {
              this.toggleDevTools();
            }
          },
        })
      );

        menu.popup({ window: this.shell.window });
      } catch {}
    });
  }

  private setupBackdropContextMenu(wc: Electron.WebContents): void {
    wc.on('context-menu', async (_event, _params) => {
      const tab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
      if (!tab) return;

      try {
        const menu = new Menu();
      // ─── 1. Split Pane Focus & Presets ───
      if (tab.state.splitMode) {
        menu.append(
          new MenuItem({
            label: '💻 Focus Desktop Pane',
            click: () => this.setSplitFocusedPane(this.activeTabId, 'desktop'),
          })
        );
        menu.append(
          new MenuItem({
            label: '📱 Focus Mobile Pane',
            click: () => this.setSplitFocusedPane(this.activeTabId, 'mobile'),
          })
        );
        menu.append(new MenuItem({ type: 'separator' }));

        const desktopPresetsMenu = new Menu();
        for (const preset of DEVICE_PRESETS.filter((p) => !p.mobile && p.id !== 'responsive')) {
          desktopPresetsMenu.append(
            new MenuItem({
              label: preset.name,
              type: 'radio',
              checked: (tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET) === preset.id,
              click: () => this.setSplitPreset(this.activeTabId, 'desktop', preset.id),
            })
          );
        }
        menu.append(
          new MenuItem({
            label: '🖥️ Desktop Device Preset',
            submenu: desktopPresetsMenu,
          })
        );

        const mobilePresetsMenu = new Menu();
        for (const preset of DEVICE_PRESETS.filter((p) => p.mobile)) {
          mobilePresetsMenu.append(
            new MenuItem({
              label: preset.name,
              type: 'radio',
              checked: (tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET) === preset.id,
              click: () => this.setSplitPreset(this.activeTabId, 'mobile', preset.id),
            })
          );
        }
        menu.append(
          new MenuItem({
            label: '📱 Mobile Device Preset',
            submenu: mobilePresetsMenu,
          })
        );

        menu.append(new MenuItem({ type: 'separator' }));
      }

      // ─── 2. AI & Design Inspection Tools ───
      menu.append(
        new MenuItem({
          label: '🎯 Inspect Element (Attach to AI Chat)',
          accelerator: 'Alt+Ctrl+A',
          click: () => this.startInspect(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔤 Font Finder (Typography)',
          accelerator: 'Alt+Ctrl+F',
          click: () => this.toggleFontFinder(),
        })
      );
      menu.append(
        new MenuItem({
          label: '📐 Pixel Ruler Layout Grid',
          accelerator: 'Alt+Ctrl+R',
          click: () => this.toggleRuler(),
        })
      );
      menu.append(
        new MenuItem({
          label: '🔍 GPU Lens (Pixel Zoom)',
          accelerator: 'Alt+Ctrl+L',
          click: () => this.toggleLens(),
        })
      );
      menu.append(
        new MenuItem({
          label: '💬 Toggle AI Chat Sidebar',
          accelerator: 'Alt+Ctrl+B',
          click: () => this.toggleSidebar(),
        })
      );
      menu.append(new MenuItem({ type: 'separator' }));

      // ─── 3. Navigation & DevTools ───
      menu.append(
        new MenuItem({
          label: '🔄 Reload Tab / Both Panes',
          accelerator: 'Ctrl+R',
          click: () => this.reload(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '📄 View Page Source',
          accelerator: 'Ctrl+U',
          click: () => this.viewPageSource(this.activeTabId),
        })
      );
      menu.append(
        new MenuItem({
          label: '🛠️ Inspect in DevTools',
          accelerator: 'F12',
          click: () => this.toggleDevTools(),
        })
      );

        menu.popup({ window: this.shell.window });
      } catch {}
    });
  }


  public showMainMenu(): void {
    const chromeProfiles = ChromeProfileSyncManager.getInstance().getAvailableProfiles();
    const profileSubmenu = chromeProfiles.length > 0
      ? chromeProfiles.map((p) => ({
          label: `Sync: ${p.name} (${p.id})`,
          click: async () => {
            const res = await ChromeProfileSyncManager.getInstance().syncProfile(p.id, this.resolveTargetProfileSession(p.id));
            const bm = ChromeProfileSyncManager.getInstance().getChromeBookmarks(p.id);
            if (bm.length > 0) {
              this.bookmarks = bm.map((b) => ({ id: b.url, title: b.title, url: b.url, createdAt: Date.now() }));
              this.broadcastState();
            }
            dialog.showMessageBox(this.shell.window, {
              type: res.success ? 'info' : 'warning',
              title: 'Chrome Profile Sync',
              message: res.message,
            });
          },
        }))
      : [{ label: 'Không tìm thấy Chrome Profile', enabled: false }];

    const menu = Menu.buildFromTemplate([
      {
        label: '🔄 Check for Updates... (Recompile & Restart)',
        accelerator: 'CmdOrCtrl+Shift+U',
        click: () => checkForUpdatesAndRestart(this.shell.window),
      },
      { type: 'separator' },
      {
        label: '🌟 Sync Google Chrome Profile',
        submenu: profileSubmenu,
      },
      {
        label: '🔑 Copy Bridge Token',
        click: () => {
          const bridge = BridgeServer.getInstance();
          if (bridge) {
            const token = bridge.getToken();
            clipboard.writeText(token);
            dialog.showMessageBox(this.shell.window, {
              type: 'info',
              title: 'Bridge Token',
              message: 'Đã sao chép mã Bridge Token vào Clipboard.',
            });
          }
        },
      },
      {
        label: '🔄 Rotate Bridge Token (Invalidate & Regenerate)',
        click: async () => {
          const bridge = BridgeServer.getInstance();
          if (bridge) {
            const token = await bridge.rotateToken();
            clipboard.writeText(token);
            dialog.showMessageBox(this.shell.window, {
              type: 'info',
              title: 'Bridge Token Rotated',
              message: 'Đã tạo mới mã Bridge Token và sao chép vào Clipboard.\nCác kết nối cũ đã bị vô hiệu hóa.',
            });
          }
        },
      },
      {
        label: '⭐ Bookmark this Tab...',
        accelerator: 'CmdOrCtrl+D',
        click: () => this.bookmarkActiveTab(),
      },
      {
        label: 'Toggle Bookmarks Bar',
        accelerator: 'CmdOrCtrl+Shift+B',
        click: () => this.toggleBookmarkBar(),
      },
      { type: 'separator' },
      {
        label: 'Find in Page...',
        accelerator: 'CmdOrCtrl+F',
        click: () => this.focusFindBar(),
      },
      { type: 'separator' },
      {
        label: 'Quick Inspect (Annotate DOM)',
        accelerator: 'CmdOrCtrl+B',
        click: () => this.toggleInspect(),
      },
      {
        label: 'Font Finder',
        click: () => this.toggleFontFinder(),
      },
      {
        label: 'GPU Lens Zoom Glass',
        click: () => this.toggleLens(),
      },
      { type: 'separator' },
      {
        label: 'Capture Viewport Screenshot',
        click: () => this.captureScreenshot(),
      },
      {
        label: 'Open in System Browser',
        click: () => this.openExternal(),
      },
      {
        label: 'Toggle Developer Tools',
        accelerator: 'F12',
        click: () => this.toggleDevTools(),
      },
      { type: 'separator' },
      {
        label: 'Clear Cookies & Cache for this site',
        click: () => this.clearStorageForActiveTab(),
      },
      {
        label: 'Keyboard Shortcuts...',
        click: () => this.showShortcuts(),
      },
    ]);

    menu.popup({ window: this.shell.window });
  }

  public bookmarkActiveTab(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    const url = active.state.url;
    const title = active.state.title || url;
    const existing = this.bookmarks.find((b) => b.url === url);
    if (!existing) {
      this.bookmarks.push({ id: url, title, url, createdAt: Date.now() });
      this.broadcastState();
    }
  }

  public toggleBookmarkBar(): boolean {
    this.isBookmarkBarVisible = !this.isBookmarkBarVisible;
    this.updateLayout();
    this.broadcastState();
    return this.isBookmarkBarVisible;
  }

  private temporaryViewAttachCounts = new WeakMap<WebContentsView, { count: number; attachedByHelper: boolean }>();

  public isTabViewAttached(view: WebContentsView | null | undefined): boolean {
    if (!view) return false;
    if (this.shell.window && (typeof this.shell.window.isDestroyed !== 'function' || !this.shell.window.isDestroyed()) && this.shell.window.contentView && Array.isArray(this.shell.window.contentView.children) && this.shell.window.contentView.children.includes(view)) {
      return true;
    }
    const host = this.captureHostWindow;
    return Boolean(host && (typeof host.isDestroyed !== 'function' || !host.isDestroyed()) && Array.isArray(host.contentView?.children) && host.contentView.children.includes(view));
  }

  /**
   * Every detach path runs on the single-threaded main loop, but the transactions that
   * move views span `await`s: a temporary attach-for-capture, another session's
   * activation, or a renderer crash can land between one transaction's attach and the
   * next check, and the presented tab's view then sits outside `contentView.children`.
   * A view outside the window has no compositor surface, so its renderer receives no
   * BeginFrame: the DOM stays alive and fully styled while the pane paints nothing but
   * the window background (the reported "trang" page that heals the moment the tab is
   * activated again). Re-assert the invariant after every view-stack mutation rather
   * than trusting whichever transaction ran last.
   *
   * Re-attach is not enough on Windows: an occluded WebContentsView can stay in
   * `contentView.children` with a dead DirectComposition visual. A 1px
   * `getBounds()` round-trip was measured harmful — the pane went black
   * (`frameBackdropView` `#060910` showing through) while DevTools still showed
   * the DOM; F5 healed because `did-finish-load` calls `updateLayout()` with the
   * window's content box. Recycle the layer (remove + attach) then run that
   * same layout.
   */
  public reassertPresentedView(options: { recyclePresentedLayer?: boolean; recycleMobileLayer?: boolean } = {}): void {
    // The drop-and-re-add exists for a view that may already be occluded, or that a capture is
    // holding. A caller that attached the view itself, moments earlier in the same operation, has
    // that visual already, so it opts out and pays neither the remove nor the re-allocation.
    const recyclePresentedLayer = options.recyclePresentedLayer !== false;
    const recycleMobileLayer = options.recycleMobileLayer !== false;
    this.buryCaptureLift('reassert');
    if (this.isDisposed) return;
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) return;
    // Guarded by their own fields: several tests build a host without running field
    // initializers, and a re-assert on such a host must be a no-op, not a TypeError.
    const activeTab = this.activeTabId && this.tabs ? this.tabs.get(this.activeTabId) : null;
    if (!activeTab || !activeTab.view || !activeTab.view.webContents) return;
    const wc = activeTab.view.webContents;
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
    if (!this.isTabViewAttached(activeTab.view)) {
      this.attachTabView(activeTab.view, false);
      // The view never had a surface while it was outside the window, so the window has
      // to lay it out before its renderer can commit a frame.
      this.layOutDetachedView(activeTab.view);
      recordLifecycleEvent('tabhost.presentedViewReattached', { tabId: this.activeTabId });
    } else if (recyclePresentedLayer) {
      // Recycle even when an attach-for-capture count is held. A leaked or hung
      // capture used to skip this and leave the user on a white DirectComposition
      // canvas until F5. Recycle is remove+add — the view stays attached.
      this.recyclePresentedLayer(activeTab.view, false);
    }
    if (activeTab.state.splitMode && activeTab.mobileView?.webContents && !activeTab.mobileView.webContents.isDestroyed()) {
      if (!this.isTabViewAttached(activeTab.mobileView)) {
        this.attachTabView(activeTab.mobileView, true);
      } else if (recycleMobileLayer) {
        this.recyclePresentedLayer(activeTab.mobileView, true);
      }
    }
    this.setWebContentsThrottling(wc, false);
    this.enforceZOrder();
    this.detachUnpresentedTabViews();
    this.enforceZOrder();
    // Authoritative bounds — same path F5 uses. Do not round-trip getBounds().
    this.updateLayout();
    if (typeof wc.invalidate === 'function') {
      try { wc.invalidate(); } catch {}
    }
  }

  /**
   * Re-present the active tab after the window was out of sight. A view Windows stopped
   * compositing while the window was hidden, covered or asleep comes back as a white
   * canvas although its renderer keeps running (audio plays, the DOM is live);
   * `invalidate()` does not restart its frames, the fresh visual `reassertPresentedView`
   * allocates does. The journal row carries the pane's state from before the recycle, so a
   * white pane that survives it can be told apart from one it healed.
   *
   * Returns whether the pane was re-presented; a hidden or minimized window, a window with
   * nothing presented, or a trigger arriving right after another recycle is left alone.
   */
  public resurfacePresentedView(trigger: PresentedViewResurfaceTrigger, blurredMs?: number): boolean {
    if (this.isDisposed) return false;
    const win = this.shell.window;
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
    if (typeof win.isVisible === 'function' && !win.isVisible()) return false;
    if (typeof win.isMinimized === 'function' && win.isMinimized()) return false;
    // A restore raises `restore` and then `focus`: one recycle covers both. The trailing
    // trigger is still journaled so an incident timeline shows every event that arrived.
    const now = Date.now();
    if (now - this.lastResurfaceAtMs < PRESENTED_VIEW_RESURFACE_DEDUPE_MS) {
      recordLifecycleEvent('tabhost.presentedViewResurfaced', { trigger, tabId: this.activeTabId, skipped: 'deduped' });
      return false;
    }
    const activeTab = this.activeTabId && this.tabs ? this.tabs.get(this.activeTabId) : null;
    const view = activeTab?.view;
    const wc = view?.webContents;
    if (!activeTab || !view || !wc) return false;
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return false;
    this.lastResurfaceAtMs = now;
    const wasFocused = typeof wc.isFocused === 'function' && wc.isFocused();
    recordLifecycleEvent('tabhost.presentedViewResurfaced', {
      trigger,
      tabId: this.activeTabId,
      ...(blurredMs !== undefined ? { blurredMs } : {}),
      attached: this.isTabViewAttached(view),
      crashed: typeof wc.isCrashed === 'function' ? wc.isCrashed() : null,
      bounds: typeof view.getBounds === 'function' ? view.getBounds() : null,
    });
    this.reassertPresentedView();
    // Dropping and re-adding the view can take keyboard focus from the page the user was in.
    if (wasFocused && !(typeof wc.isDestroyed === 'function' && wc.isDestroyed())) {
      try { wc.focus(); } catch {}
    }
    return true;
  }

  public noteWindowBlurred(): void {
    this.windowBlurredAtMs = Date.now();
  }

  /** Regaining focus after a long absence re-presents the tab; a quick Alt+Tab does not. */
  public noteWindowFocused(): void {
    const blurredAt = this.windowBlurredAtMs;
    this.windowBlurredAtMs = null;
    if (typeof blurredAt !== 'number') return;
    const blurredMs = Date.now() - blurredAt;
    if (blurredMs >= PRESENTED_VIEW_RESURFACE_AFTER_BLUR_MS) this.resurfacePresentedView('focus', blurredMs);
  }

  /**
   * Drop and re-insert a presented view so Windows DirectComposition allocates a
   * new visual. `invalidate()` on an already-attached occluded view does not
   * restart BeginFrame; a getBounds 1px kick destroyed the visual instead
   * (black pane, backdrop showing through). A hung capturePage raster is a
   * different death mode (navigation heals it; recycle does not) — do not skip
   * recycle because an attach-for-capture count leaked.
   */
  private recyclePresentedLayer(view: WebContentsView | null | undefined, isMobile: boolean): void {
    if (!view || !this.shell.window || !this.shell.window.contentView) return;
    try {
      if (this.isTabViewAttached(view)) {
        this.shell.window.contentView.removeChildView(view);
      }
    } catch {}
    this.attachTabView(view, isMobile);
  }

  /**
   * A view an in-flight attach-for-capture operation is holding. The detach sweeps must
   * leave it alone: removing it mid-flight both invalidates the measurement the caller
   * attached it for and, once that caller releases, can strip the view the window was
   * presenting.
   */
  private isTemporarilyAttachedView(view: WebContentsView | null | undefined): boolean {
    if (!view || !this.temporaryViewAttachCounts) return false;
    const state = this.temporaryViewAttachCounts.get(view);
    return Boolean(state && state.count > 0);
  }

  /**
   * A tab view that is in the window but is neither the presented tab nor held by
   * an in-flight attach-for-capture paints over the user's tab (measured: a white
   * background pane covering the content area while MCP runs). Detach those.
   * A temporarily-held view stays: the capture path owns its lifetime.
   */
  private detachUnpresentedTabViews(): void {
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView || !this.tabs) return;
    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    for (const [id, tab] of this.tabs.entries()) {
      for (const view of [tab.view, tab.mobileView]) {
        if (!view || view === activeTab?.view || view === activeTab?.mobileView) continue;
        if (this.isTemporarilyAttachedView(view)) continue;
        if (!this.isTabViewAttached(view)) continue;
        this.setWebContentsThrottling(this.liveViewContents(view), this.backgroundThrottlingFor(id, tab));
        try { this.shell.window.contentView.removeChildView(view); } catch {}
      }
    }
  }

  public async runWithAttachedTabView<T>(view: WebContentsView | null | undefined, action: () => Promise<T>, isMobile = false): Promise<T> {
    if (!view || !this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) {
      return action();
    }
    if (!this.temporaryViewAttachCounts) {
      this.temporaryViewAttachCounts = new WeakMap();
    }
    const state = this.temporaryViewAttachCounts.get(view);
    if (!state || state.count === 0) {
      const wasAttached = this.isTabViewAttached(view);
      if (!wasAttached) {
        this.attachTabView(view, isMobile);
        this.layOutDetachedView(view);
      }
      this.temporaryViewAttachCounts.set(view, { count: 1, attachedByHelper: !wasAttached });
    } else {
      state.count++;
    }
    const wc = view.webContents;
    const wasThrottled = (wc && this.readBackgroundThrottling(wc)) ?? true;
    this.setWebContentsThrottling(wc, false);
    if (wc && typeof wc.invalidate === 'function') {
      try { wc.invalidate(); } catch {}
    }
    try {
      return await action();
    } finally {
      this.setWebContentsThrottling(wc, wasThrottled);
      const current = this.temporaryViewAttachCounts.get(view);
      if (current) {
        current.count--;
        if (current.count <= 0) {
          this.temporaryViewAttachCounts.delete(view);
          const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
          const isActiveView = activeTab && (activeTab.view === view || activeTab.mobileView === view);
          // Detach whenever this view is no longer the presented tab. `attachedByHelper`
          // is false when the view was already attached at entry (it was the active tab).
          // A switch during the probe leaves that view in the tree — switchTab will not
          // detach a temporarily-held view — and skipping the detach here is what leaves
          // a second full-size pane painted over the tab the user is looking at.
          if (!isActiveView) {
            try {
              if (this.shell.window && (typeof this.shell.window.isDestroyed !== 'function' || !this.shell.window.isDestroyed()) && this.shell.window.contentView && this.isTabViewAttached(view)) {
                this.shell.window.contentView.removeChildView(view);
              }
            } catch {}
          }
          // Releasing a temporary attach must not leave the presented tab outside the
          // window. The release used to invalidate the active view only, and an invalidate
          // on a detached view repaints nothing, so the pane stayed blank until something
          // else happened to activate that tab again. A helper that attached nothing — the
          // view was already presented and is still the active one — mutated no view stack,
          // and re-asserting there recycles the layer the user is looking at and relays it
          // out under them, so only a release that changed the tree re-asserts the invariant.
          if (current.attachedByHelper || !isActiveView) {
            this.reassertPresentedView();
          }
        }
      }
    }
  }

  /**
   * `enforceZOrder` keeps the user's active tab above every other pane, so a
   * helper-attached background view is occluded. On Windows an occluded
   * WebContentsView produces no compositor frame, and Page.captureScreenshot
   * `{ fromSurface: true }` then waits out the no-surface probe (measured:
   * inactive bagamuioto + mdn video). A capture lift parks the pane somewhere a
   * compositor still drives it — the off-screen host by default, the real
   * window when the host cannot take the pane or left it starved. Does not
   * change `activeTabId`.
   *
   * A lift is a per-window lease: one held at a time, FIFO-queued while held,
   * bounded by the caller's raster deadline and, for the in-window origin, by
   * `IN_WINDOW_CAPTURE_LIFT_MAX_MS`. The caller's `finally` releases; the
   * watchdog releases a raster that abandons its dispatch; a reassert or real
   * user input buries the pane while the lease stays held, so the in-flight
   * raster degrades to its typed timeout instead of resurrecting the lift.
   */
  public async acquireCaptureLift(view: WebContentsView, opts?: { inWindow?: boolean; budgetMs?: number }): Promise<CaptureLiftLease> {
    if (!this.captureLiftQueue) this.captureLiftQueue = [];
    // An invalid view rejects immediately — it is refused even when another
    // pane holds the slot, because it could never be granted when its turn came.
    this.assertCaptureLiftableView(view);
    const held = this.captureLift;
    if (held && held.lease) {
      if (held.view === view && !held.lease.released) {
        // Same-view re-entry is an upgrade, never a second queue slot: the
        // frame gate's repair ladder escalates capture-host -> in-window on
        // the lease it already holds, keeping the original lift stamp.
        if (opts?.inWindow && held.origin !== 'in-window') {
          held.lease.upgradeToInWindow(opts);
        }
        return held.lease;
      }
      const { promise, resolve, reject } = Promise.withResolvers<CaptureLiftLease>();
      const waiter = {
        view,
        opts: opts ?? {},
        grant: resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.captureLiftQueue.indexOf(waiter);
          if (idx >= 0) this.captureLiftQueue.splice(idx, 1);
          reject(new CapabilityError(
            'CAPTURE_LIFT_BUSY',
            `The window's capture lift is held by another pane; this acquire outlived ${CAPTURE_LIFT_ACQUIRE_BOUND_MS}ms waiting for it.`,
            { queueWaitMs: CAPTURE_LIFT_ACQUIRE_BOUND_MS }
          ));
        }, CAPTURE_LIFT_ACQUIRE_BOUND_MS),
      };
      waiter.timer.unref?.();
      this.captureLiftQueue.push(waiter);
      return await promise;
    }
    return this.grantCaptureLift(view, opts ?? {});
  }

  /** The live lift for diagnostics: the view borrowed, where it is parked, and when it started. */
  public captureLiftState(): { view: unknown; origin: string; liftedAtMs: number } | null {
    const record = this.captureLift;
    if (!record) return null;
    return { view: record.view, origin: record.origin, liftedAtMs: record.liftedAtMs };
  }

  /**
   * A pane worth lifting has a live renderer and a window to be lifted in.
   * Refuse loudly: the bare raise this replaced swallowed all three of these,
   * which made a failed lift indistinguishable from a fast raster.
   */
  private assertCaptureLiftableView(view: WebContentsView | null | undefined): asserts view is WebContentsView {
    const missingSurface =
      !view ||
      !view.webContents ||
      (typeof view.webContents.isDestroyed === 'function' && view.webContents.isDestroyed()) ||
      !this.isTabViewAttached(view);
    if (missingSurface) {
      throw new CapabilityError(
        'NO_RENDER_SURFACE',
        'A capture lift needs a live pane that is attached to a window: the view is destroyed, was never attached, or is absent.'
      );
    }
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) {
      throw new CapabilityError(
        'NO_RENDER_SURFACE',
        'A capture lift needs the owning window to be alive and able to present a pane.'
      );
    }
  }

  /**
   * Grant the window's one lift now that the slot is free: record the slot,
   * raise on the preferred origin (the capture host falls back to in-window
   * when it cannot take the pane or left it starved), arm the watchdog, and
   * hand the caller its lease. Queued acquires never reach this directly;
   * `wakeCaptureLiftQueue` grants them one at a time after a release.
   */
  private grantCaptureLift(view: WebContentsView, opts: { inWindow?: boolean; budgetMs?: number }): CaptureLiftLease {
    this.assertCaptureLiftableView(view);
    let record!: CaptureLiftRecord;
    let released = false;
    let watchdog: NodeJS.Timeout | null = null;
    const disarm = (): void => {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    };
    const recordLift = (phase: 'raised' | 'upgraded' | 'lowered' | 'watchdog-lowered', reason?: string): void => {
      const tabId = this.tabByWebContents?.get(view.webContents)?.tabId;
      recordLifecycleEvent('capture.lift', {
        tabId,
        origin: record.origin,
        phase,
        liftedMs: Date.now() - record.liftedAtMs,
        lowered: phase === 'lowered' || phase === 'watchdog-lowered',
        reason,
      });
    };
    const arm = (): void => {
      disarm();
      const bound = Math.min(
        opts.budgetMs ?? CAPTURE_LIFT_ACQUIRE_BOUND_MS,
        record.origin === 'in-window' ? IN_WINDOW_CAPTURE_LIFT_MAX_MS : Number.POSITIVE_INFINITY
      );
      if (!Number.isFinite(bound)) return;
      watchdog = setTimeout(() => {
        watchdog = null;
        lease.release('watchdog');
      }, bound);
      watchdog.unref?.();
    };
    const lease: CaptureLiftLease = {
      view,
      get origin() { return record.origin; },
      get liftedAtMs() { return record.liftedAtMs; },
      get released() { return released; },
      upgradeToInWindow: (upgradeOpts?: { budgetMs?: number }) => {
        if (released || this.captureLift !== record) return false;
        if (record.origin === 'in-window') return true;
        if (upgradeOpts?.budgetMs !== undefined) opts.budgetMs = upgradeOpts.budgetMs;
        if (!this.raiseViewInWindow(view)) {
          this.lowerCaptureLift(record, 'upgrade-failed');
          return false;
        }
        arm();
        recordLift('upgraded');
        return true;
      },
      release: (reason?: string) => {
        if (released) return;
        released = true;
        disarm();
        this.lowerCaptureLift(record, reason);
      },
    };
    record = { token: ++this.captureLiftToken, view, origin: 'capture-host', liftedAtMs: Date.now(), lease };
    this.captureLift = record;
    try {
      if (!opts?.inWindow && this.raiseViewOnCaptureHost(view)) {
        arm();
        recordLift('raised');
        return lease;
      }
      // Host unavailable (tests, or BrowserWindow refused), not preferred, or
      // starved: the in-window lift paints the pane over the user's tab for the
      // raster, bounded by the hard cap. A pane parked on the capture host
      // cannot be lifted inside the window — the failed raise already restored
      // it to where the attach helper left it.
      if (!this.raiseViewInWindow(view)) {
        this.captureLift = null;
        throw new CapabilityError('NO_RENDER_SURFACE', 'The window could not present the pane for its capture lift.');
      }
      arm();
      recordLift('raised');
      return lease;
    } catch (err) {
      if (this.captureLift === record) this.captureLift = null;
      disarm();
      throw err;
    }
  }

  /** Both raise origins record into the same slot — an in-window lift is finally visible to the burying path. */
  private writeCaptureLift(view: WebContentsView, origin: CaptureLiftOrigin): void {
    if (this.captureLift && this.captureLift.view === view) {
      this.captureLift.origin = origin;
    }
  }

  /** Hand the freed slot to the next queued acquire in FIFO order; a waiter whose pane died meanwhile is refused. */
  private wakeCaptureLiftQueue(): void {
    while (this.captureLift === null && this.captureLiftQueue && this.captureLiftQueue.length > 0) {
      const waiter = this.captureLiftQueue.shift()!;
      clearTimeout(waiter.timer);
      try {
        this.assertCaptureLiftableView(waiter.view);
        waiter.grant(this.grantCaptureLift(waiter.view, waiter.opts));
      } catch (err) {
        waiter.reject(err);
      }
    }
  }

  /**
   * Keep the lease, bury the pane: remove it from the capture host when raised
   * there, ensure it is back in the window below the presented view (only while
   * an attach-for-capture helper still owns its parent — the existing
   * contract), and re-assert the z-stack. The capture's own `finally` still
   * owns the release; a bury never fakes one.
   */
  private buryCaptureLift(reason?: string): void {
    const record = this.captureLift;
    if (!record) return;
    const view = record.view;
    const host = this.captureHostWindow;
    try {
      if (host && (typeof host.isDestroyed !== 'function' || !host.isDestroyed()) && Array.isArray(host.contentView?.children) && host.contentView.children.includes(view)) {
        host.contentView.removeChildView(view);
      }
    } catch {}
    if (this.isTemporarilyAttachedView(view)) {
      try {
        if (this.shell.window && (typeof this.shell.window.isDestroyed !== 'function' || !this.shell.window.isDestroyed())) {
          this.attachTabView(view, false);
        }
      } catch {}
    } else {
      try {
        if (this.shell.window && (typeof this.shell.window.isDestroyed !== 'function' || !this.shell.window.isDestroyed())) {
          if (!this.isTabViewAttached(view)) {
            this.attachTabView(view, false);
          }
        }
      } catch {}
    }
    try { this.enforceZOrder(); } catch {}
  }

  /**
   * Terminal release: bury the pane, clear the slot, journal the transition,
   * and wake the FIFO queue. A stale lease is answered with the bury only — a
   * release can never clear a lease a newer capture is holding.
   */
  private lowerCaptureLift(record: CaptureLiftRecord, reason?: string): void {
    this.buryCaptureLift(reason);
    const isCurrent = this.captureLift === record;
    if (isCurrent) this.captureLift = null;
    const tabId = this.tabByWebContents?.get(record.view.webContents)?.tabId;
    recordLifecycleEvent('capture.lift', {
      tabId,
      origin: record.origin,
      phase: reason === 'watchdog' ? 'watchdog-lowered' : 'lowered',
      liftedMs: Date.now() - record.liftedAtMs,
      lowered: true,
      reason,
    });
    if (isCurrent) this.wakeCaptureLiftQueue();
  }

  /**
   * Move the capture pane to a shown-but-off-screen window so Windows still
   * composites a frame (an occluded in-window view does not) without covering
   * the tab the user is looking at. Returns false when that window cannot be
   * created; the caller then lifts in-window.
   */
  private raiseViewOnCaptureHost(view: WebContentsView): boolean {
    // A screenshot of the presented pane must keep its compositor in the user's
    // window. Parking it off-screen leaves a white hole while its audio continues.
    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    if (view === activeTab?.view || view === activeTab?.mobileView) return false;
    const host = this.ensureCaptureHostWindow();
    if (!host) return false;
    const current = typeof view.getBounds === 'function' ? view.getBounds() : undefined;
    const width = Math.max(1, Math.round(current?.width || 1280));
    const height = Math.max(1, Math.round(current?.height || 800));
    const origin = this.offscreenCaptureOrigin(width, height);
    try {
      host.setBounds({ x: origin.x, y: origin.y, width, height });
      if (!host.isVisible()) host.showInactive();
      if (this.shell.window.contentView.children.includes(view)) this.shell.window.contentView.removeChildView(view);
      host.contentView.addChildView(view);
      this.writeCaptureLift(view, 'capture-host');
      if (typeof view.setBounds === 'function') view.setBounds({ x: 0, y: 0, width, height });
      const wc = view.webContents;
      if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.invalidate === 'function') {
        try { wc.invalidate(); } catch {}
      }
      return true;
    } catch (err) {
      console.warn('[native-tab-host] capture-host raise failed:', err);
      if (this.captureLift?.view === view) this.buryCaptureLift('raise-failed');
      return false;
    }
  }

  private ensureCaptureHostWindow(): BrowserWindow | null {
    if (this.captureHostWindow && (typeof this.captureHostWindow.isDestroyed !== 'function' || !this.captureHostWindow.isDestroyed())) {
      return this.captureHostWindow;
    }
    try {
      const host = new BrowserWindow({
        show: false,
        frame: false,
        skipTaskbar: true,
        focusable: false,
        minimizable: false,
        closable: false,
        resizable: false,
        width: 1280,
        height: 800,
        x: -16000,
        y: -16000,
        backgroundColor: '#000000',
      });
      this.captureHostWindow = host;
      return host;
    } catch (err) {
      console.warn('[native-tab-host] capture host window unavailable:', err);
      return null;
    }
  }

  private offscreenCaptureOrigin(width: number, height: number): { x: number; y: number } {
    let minX = 0;
    let minY = 0;
    try {
      for (const display of screen.getAllDisplays()) {
        minX = Math.min(minX, display.bounds.x);
        minY = Math.min(minY, display.bounds.y);
      }
    } catch {}
    return { x: minX - width - 64, y: minY - height - 64 };
  }

  private raiseViewInWindow(view: WebContentsView): boolean {
    if (!this.shell.window || !this.shell.window.contentView) return false;
    const contentView = this.shell.window.contentView;
    try {
      // A pane parked on the capture host cannot be lifted inside this window:
      // hand it back first so the parent is the window the lift raises it in.
      const captureHost = this.captureHostWindow;
      if (captureHost && (typeof captureHost.isDestroyed !== 'function' || !captureHost.isDestroyed()) && Array.isArray(captureHost.contentView?.children) && captureHost.contentView.children.includes(view)) {
        captureHost.contentView.removeChildView(view);
      }
      if (typeof contentView.removeChildView === 'function') contentView.removeChildView(view);
      if (typeof contentView.addChildView === 'function') contentView.addChildView(view);
      this.writeCaptureLift(view, 'in-window');
      if (this.shell.sidebarView && this.isTabViewAttached(this.shell.sidebarView as unknown as WebContentsView)) {
        contentView.removeChildView(this.shell.sidebarView);
        contentView.addChildView(this.shell.sidebarView);
      }
      if (this.shell.toolbarView && this.isTabViewAttached(this.shell.toolbarView as unknown as WebContentsView)) {
        contentView.removeChildView(this.shell.toolbarView);
        contentView.addChildView(this.shell.toolbarView);
      }
      const wc = view.webContents;
      if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.invalidate === 'function') {
        try { wc.invalidate(); } catch {}
      }
      return true;
    } catch (err) {
      console.warn('[native-tab-host] in-window capture lift error:', err);
      return false;
    }
  }

  /**
   * Lay out a pane view the attach-for-capture helper just put on screen. A view that
   * was never presented has no size, so its document lays out against a zero-width box
   * and every reading taken through the temporary attach — the render-surface probe,
   * evaluate, the capture raster — measures 0x0 on a tab that can do the work. The
   * attach is only worth anything if the surface it presents is the one the window
   * would present, so the pane is laid out exactly as activation lays it out (device
   * presets, split frames and all) instead of being handed an invented size.
   */
  private layOutDetachedView(view: WebContentsView | null | undefined): void {
    if (!view || !view.webContents) return;
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || typeof this.shell.window.getContentBounds !== 'function') return;
    const indexed = this.tabByWebContents?.get(view.webContents);
    if (!indexed) return;
    const { width, height } = this.shell.window.getContentBounds();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return;
    const availableWidth = this.shell.isSidebarOpen ? Math.max(400, width - this.shell.sidebarWidth) : width;
    const toolbarHeight = this.getToolbarHeight();
    const availableHeight = Math.max(0, height - toolbarHeight);
    if (availableWidth < 1 || availableHeight < 1) return;
    this.applyTabDeviceEmulation(indexed.tab, availableWidth, availableHeight, toolbarHeight);
  }

  /**
   * The box the window gives a pane's view: the fluid area, or the pane's own frame in
   * split review. `undefined` when the window cannot name a real size, because a caller
   * that asked for geometry must refuse on that answer rather than invent one.
   */
  public getTabContentBounds(tabId: string, paneId?: SplitPaneId): { width: number; height: number } | undefined {
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || typeof this.shell.window.getContentBounds !== 'function') {
      return undefined;
    }
    const { width, height } = this.shell.window.getContentBounds();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return undefined;
    const availableWidth = this.shell.isSidebarOpen ? Math.max(400, width - this.shell.sidebarWidth) : width;
    const toolbarHeight = this.getToolbarHeight();
    const availableHeight = Math.max(0, height - toolbarHeight);
    if (availableWidth < 1 || availableHeight < 1) return undefined;

    const tab = this.tabs?.get(tabId);
    if (tab?.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const splitLayout = calculateSplitLayout(
        { width: availableWidth, height: availableHeight, yOffset: toolbarHeight },
        tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET,
        tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET,
        tab.state.zoomFactor || 1.0
      );
      const pane = paneId === 'mobile' ? splitLayout.mobile : splitLayout.desktop;
      if (!Number.isFinite(pane.width) || !Number.isFinite(pane.height) || pane.width < 1 || pane.height < 1) return undefined;
      return { width: Math.round(pane.width), height: Math.round(pane.height) };
    }
    return { width: Math.round(availableWidth), height: Math.round(availableHeight) };
  }

  public attachTabView(view: WebContentsView | null | undefined, isMobile = false): void {
    if (!view || !this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) return;
    if (view.webContents && typeof view.webContents.isDestroyed === 'function' && view.webContents.isDestroyed()) return;
    try {
      const children = Array.isArray(this.shell.window.contentView.children) ? this.shell.window.contentView.children : [];
      // Where the pane belongs is already written down in `enforceZOrder`: above every other
      // child, below the shell chrome. Inserting it at the backdrop instead leaves it beneath
      // the tab views this switch is replacing, and the order check then re-stacks this view,
      // the sidebar and the toolbar on every switch - three removes, three adds and three
      // invalidates spent producing an order this insert can produce directly.
      let insertIndex = children.length;
      const shellAbove = [this.shell.sidebarView, this.shell.toolbarView].find((shell) => shell && children.includes(shell));
      if (shellAbove) insertIndex = children.indexOf(shellAbove);
      if (isMobile && this.activeTabId) {
        const activeTab = this.tabs.get(this.activeTabId);
        if (activeTab?.view && children.includes(activeTab.view)) {
          insertIndex = children.indexOf(activeTab.view) + 1;
        }
      }
      insertIndex = Math.max(0, Math.min(insertIndex, children.length));
      if (!children.includes(view)) {
        this.shell.window.contentView.addChildView(view, insertIndex);
      }
      this.enforceZOrder();
    } catch (err) {
      console.error('[native-tab-host] attachTabView error:', err);
    }
  }

  public enforceZOrder(): void {
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) return;
    const contentView = this.shell.window.contentView;
    const children = Array.isArray(contentView.children) ? contentView.children : [];
    if (children.length <= 1) return;

    // Strict z-stack order from bottom to top:
    // 0: frameBackdropView (backdrop behind all web views)
    // 1: activeTab.view (desktop view)
    // 2: activeTab.mobileView (mobile view in split review)
    // 3: sidebarView (shell sidebar workbench)
    // 4: toolbarView (shell top toolbar and dropdown overlays)
    const activeTab = this.activeTabId ? this.tabs.get(this.activeTabId) : null;
    const desiredOrder: Electron.View[] = [];

    if (this.shell.frameBackdropView && children.includes(this.shell.frameBackdropView)) {
      desiredOrder.push(this.shell.frameBackdropView);
    }
    for (const child of children) {
      if (
        child !== this.shell.frameBackdropView &&
        child !== activeTab?.view &&
        child !== activeTab?.mobileView &&
        child !== this.shell.sidebarView &&
        child !== this.shell.toolbarView
      ) {
        desiredOrder.push(child);
      }
    }
    if (activeTab?.view && children.includes(activeTab.view)) {
      desiredOrder.push(activeTab.view);
    }
    if (activeTab?.state.splitMode && activeTab.mobileView && children.includes(activeTab.mobileView)) {
      desiredOrder.push(activeTab.mobileView);
    }
    if (this.shell.sidebarView && children.includes(this.shell.sidebarView)) {
      desiredOrder.push(this.shell.sidebarView);
    }
    if (this.shell.toolbarView && children.includes(this.shell.toolbarView)) {
      desiredOrder.push(this.shell.toolbarView);
    }

    // Check if relative order already matches
    let needsReorder = false;
    let lastSeenIndex = -1;
    let firstOutOfOrderIdx = -1;
    for (let i = 0; i < desiredOrder.length; i++) {
      const v = desiredOrder[i]!;
      const idx = children.indexOf(v);
      if (idx === -1 || idx < lastSeenIndex) {
        needsReorder = true;
        firstOutOfOrderIdx = i;
        break;
      }
      lastSeenIndex = idx;
    }

    if (!needsReorder || firstOutOfOrderIdx === -1) return;

    // Only detach and re-add views from firstOutOfOrderIdx to the end of desiredOrder.
    // Views prior to firstOutOfOrderIdx are already at their correct relative index
    // at the bottom and MUST NOT be detached, preserving DirectComposition swapchains
    // and avoiding iGPU frame drops.
    for (let i = firstOutOfOrderIdx; i < desiredOrder.length; i++) {
      const v = desiredOrder[i]!;
      try {
        if (typeof contentView.removeChildView === 'function') {
          contentView.removeChildView(v);
        }
        if (typeof contentView.addChildView === 'function') {
          contentView.addChildView(v);
        }
        // `WebContentsView` is a real constructor inside Electron and resolves to a string
        // path outside it, where the `node --test` doubles carry only the structural surface.
        // Checking for the constructor before the `instanceof` keeps the strict check in the
        // app and stops a TypeError from skipping the invalidate below in every headless run.
        const isElectronView = typeof WebContentsView === 'function' && v instanceof WebContentsView;
        if (isElectronView && !v.webContents.isDestroyed() && typeof v.webContents.invalidate === 'function') {
          try { v.webContents.invalidate(); } catch {}
        }
      } catch (err) {
        console.warn('[native-tab-host] enforceZOrder error:', err);
      }
    }
  }

  public bringViewToFront(_view: WebContentsView | null | undefined): void {
    this.enforceZOrder();
  }

  public ensureShellViewsZOrder(): void {
    this.enforceZOrder();
  }

  public setToolbarOverlay(active: boolean, customHeight?: number): void {
    this.isToolbarOverlayActive = active;
    this.toolbarOverlayCustomHeight = customHeight;
    // The overlay is chrome this window owns, so a toolbar renderer message that arrives while
    // the window is being torn down must report on nothing rather than raise out of the IPC
    // route that delivered it (the window object survives its native counterpart).
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || typeof this.shell.window.getContentBounds !== 'function') return;
    // The shell is the only writer of chrome bounds: the overlay flags above are inputs to the
    // canonical pass, which reaches `applyChromeBounds` with the same geometry the tab views
    // just took. A second write here would compute its own width and desync the toolbar
    // renderer's viewport from every other surface.
    this.updateLayout();
  }

  private ensureToolbarOnTop(): void {
    // Retained for API compatibility; shell views are permanently ordered above tab views
  }
  public async clearStorageForActiveTab(): Promise<{ success: boolean; cleared: boolean; reason?: string; origin?: string }> {
    const activeTab = this.tabs.get(this.activeTabId);
    if (!activeTab) {
      return { success: false, cleared: false, reason: 'NO_ACTIVE_TAB' };
    }
    // Fail-closed: only an http(s) origin can be scoped. Without `origin`,
    // Electron's clearStorageData wipes the ENTIRE partition (every site),
    // so about:blank / file: / chrome:// pages REFUSE instead.
    const activeWc = activeTab.view?.webContents;
    const currentUrl = activeWc && !activeWc.isDestroyed() ? activeWc.getURL() : (activeTab.state.url || '');
    let origin: string | null = null;
    try {
      const parsed = new URL(currentUrl);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        origin = parsed.origin;
      }
    } catch {}
    if (!origin) {
      return { success: false, cleared: false, reason: 'UNSUPPORTED_ORIGIN', origin: currentUrl };
    }
    try {
      const ses = activeTab.view?.webContents?.session || (activeTab.state.partition ? session.fromPartition(activeTab.state.partition) : undefined);
      if (!ses) return { success: false, cleared: false, reason: 'UNSUPPORTED_ORIGIN', origin: currentUrl };
      await ses.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'cachestorage'] });
      const liveWc = activeTab.view?.webContents;
      if (liveWc && !liveWc.isDestroyed()) {
        liveWc.reload();
      }
      if (activeTab.state.splitMode && activeTab.mobileView && !activeTab.mobileView.webContents.isDestroyed()) {
        activeTab.mobileView.webContents.reload();
      }
      return { success: true, cleared: true, origin };
    } catch (err) {
      console.error('[native-tab-host] Failed to clear storage:', err);
      return { success: false, cleared: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  public showShortcuts(): void {
    this.setToolbarOverlay(true);
    safeSendWebContents(this.shell.toolbarView?.webContents, 'antifan:show-shortcuts');
  }

  public focusFindBar(): void {
    safeSendWebContents(this.shell.toolbarView?.webContents, 'antifan:focus-find');
  }

  public getTabList(): AntiFanTab[] {
    return this.tabOrder
      .map((id) => {
        const tab = this.tabs.get(id);
        if (!tab) return undefined;
        if (tab.state.ephemeral === true) return undefined;
        const isAttached = Boolean(tab.view && this.isTabViewAttached(tab.view));
        return {
          ...tab.state,
          // The stamp lives on the record, not the state, so the spread never
          // carries it: the strip's project filter and the search inventory read
          // the wire field and must see it on every row.
          projectId: tab.projectId,
          customViewport: tab.customViewport,
          attached: isAttached,
          isAgentControlled: id === this.automationTabId,
        } as AntiFanTab & { customViewport?: { width: number; height: number; mobile?: boolean }; attached?: boolean };
      })
      .filter(Boolean) as AntiFanTab[];
  }

  /**
   * Session-scoped tab listing. `getTabList` projects the user's tab strip, which
   * deliberately excludes ephemeral tabs the agent plane creates —
   * so a session that asks what it owns must be answered from the tab map, not
   * from the strip. Anything the session owns is listed, including tabs the
   * window never showed.
   */
  public getSessionTabRecords(boundTabId: string): AntiFanTab[] {
    if (!boundTabId) return [];
    const owned = this.getManagedTabIdsForBoundTab(boundTabId);
    owned.add(boundTabId);
    const records: AntiFanTab[] = [];
    for (const id of owned) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      const isAttached = Boolean(tab.view && this.isTabViewAttached(tab.view));
      records.push({
        ...tab.state,
        projectId: tab.projectId,
        customViewport: tab.customViewport,
        attached: isAttached,
        isAgentControlled: tab.state.ephemeral === true || id === this.automationTabId,
      } as AntiFanTab & { customViewport?: { width: number; height: number; mobile?: boolean }; attached?: boolean });
    }
    return records;
  }

  /**
   * Serialized owner of this window, as persisted and as the search inventory
   * reports it. A shell without a verified owner is Unassigned — the same state a
   * historical page with no unique project match gets, never a guess.
   */
  public windowOwnerKey(): string {
    const owner = this.shell?.owner;
    return owner ? ownerKey(owner) : UNASSIGNED_OWNER_KEY;
  }

  /** Human label for this window's owner (a project id, or Unassigned). */
  public windowOwnerLabel(): string {
    const owner = this.shell?.owner;
    return owner ? ownerLabel(owner) : ownerLabel({ kind: 'unassigned' });
  }

  /**
   * Pin this window's terminals to a verified workspace. Main resolves the
   * relationship and passes it here; an invalid path or capsule is refused and the
   * previous association is kept, so a malformed update can never silently move a
   * window's terminals into another workspace.
   */
  public setWindowWorkspaceAffiliation(affiliation: WindowWorkspaceAffiliation | null): boolean {
    if (affiliation === null) {
      this.windowWorkspaceAffiliation = null;
      try { TerminalOutputRouter.getInstance().invalidateRoutes(); } catch {}
      return true;
    }
    if (!affiliation || typeof affiliation !== 'object') return false;
    const workspacePath = typeof affiliation.workspacePath === 'string' ? affiliation.workspacePath.trim() : '';
    if (!workspacePath || !path.isAbsolute(workspacePath) || !isExistingDirectory(workspacePath)) return false;
    const capsuleId = affiliation.capsuleId;
    if (capsuleId !== undefined && (typeof capsuleId !== 'string' || !capsuleId.trim())) return false;
    this.windowWorkspaceAffiliation = {
      workspacePath: path.normalize(workspacePath),
      ...(capsuleId ? { capsuleId: capsuleId.trim() } : {}),
    };
    // The affiliation decides which sessions this window owns; the routed map
    // follows it immediately instead of the next session event.
    try { TerminalOutputRouter.getInstance().invalidateRoutes(); } catch {}
    return true;
  }

  public getWindowWorkspaceAffiliation(): WindowWorkspaceAffiliation | null {
    return this.windowWorkspaceAffiliation ? { ...this.windowWorkspaceAffiliation } : null;
  }

  /**
   * Set (or clear) the project the 'web' hub shell is presenting. Main calls
   * this on `openProjectWindow({projectId})` and calls
   * `setWindowWorkspaceAffiliation` separately — the two facts are different
   * authorities and this setter deliberately does not re-resolve the
   * affiliation. A blank id normalizes to null.
   *
   * On the 'web' shell the presented tab and the active project may never
   * disagree, so a change also repoints the strip: the remembered tab for the
   * new project if it still exists, else that project's most recent tab, else a
   * fresh tab minted under it (stamped by `createTab`). Clearing the project
   * repoints to the newest shared tab instead. Every call ends with a state
   * broadcast so the identity the chrome paints can never lag the switch.
   * Non-web shells keep the original field-only behaviour: the map and the
   * repoint are hub concerns.
   */
  public setActiveProject(projectId: string | null): void {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    this.activeProjectId = id ? id : null;
    // The OS title bar names the presented project too; the hub's own record only
    // knows the product title, so a project flip is what has to retitle it.
    if (this.windowOwnerKey() === WEB_OWNER_KEY && this.shell) {
      const descriptor = id ? this.describeWebHubProject(id) : undefined;
      this.shell.retitle(id ? (descriptor?.title ?? id) : 'AntiFan Browser');
    }
    // The repoint is a live-switch concern: during boot (restore not run yet) the
    // window owns no tabs to repoint and creating one would shadow the restore.
    if (this.windowOwnerKey() === WEB_OWNER_KEY && !this.isDisposed && this.hasRestoredTabs) {
      this.presentTabForActiveProject();
    }
    this.broadcastState();
  }

  /**
   * The tab Main's user-facing project switch should land on, or '' when the
   * project owns no strip tab at all. The remembered tab wins while it still
   * exists and still carries the stamp; after it the newest `lastActiveAt` among
   * the project's tabs, with strip order breaking the all-zero restore tie.
   * `projectId === null` means the shared pool: tabs with no stamp.
   */
  private presentationCandidateForProject(projectId: string | null): string {
    if (projectId) {
      const remembered = this.lastActiveTabByProject?.get(projectId);
      if (remembered) {
        const tab = this.tabs.get(remembered);
        if (tab && tab.projectId === projectId && tab.state.ephemeral !== true) {
          return remembered;
        }
      }
    }
    let best = '';
    let bestActiveAt = -1;
    for (const tabId of this.tabOrder ?? []) {
      const tab = tabId ? this.tabs.get(tabId) : undefined;
      if (!tab) continue;
      if (tab.state.ephemeral === true) continue;
      const stamped = typeof tab.projectId === 'string' && tab.projectId ? tab.projectId : undefined;
      if ((stamped ?? null) !== projectId) continue;
      const at = typeof tab.lastActiveAt === 'number' ? tab.lastActiveAt : 0;
      // `>=` keeps the later tab on an exact tie, which matters on restore where
      // lastActiveAt repays equal (0) for every tab: the freshest strip row wins.
      if (at >= bestActiveAt) {
        bestActiveAt = at;
        best = tabId;
      }
    }
    return best;
  }

  /**
   * Reconcile the presented pane with `activeProjectId` after a project change.
   * A presented tab that already satisfies the scope (stamped with the project, or
   * shared) is remembered and left in place — re-activating the same tab under a
   * new project would flash the strip for no user-visible gain. All activation
   * goes through `this.switchTab` so the flip bookkeeping and the deferral gate
   * see the same call.
   */
  private presentTabForActiveProject(): void {
    const activeId = this.activeProjectId;
    const presented = this.activeTabId ? this.tabs.get(this.activeTabId) : undefined;
    const presentedStamp = presented && typeof presented.projectId === 'string' && presented.projectId
      ? presented.projectId
      : null;
    const presentedSatisfies = Boolean(
      presented
      && presented.state.ephemeral !== true
      && (activeId === null ? presentedStamp === null : presentedStamp === activeId),
    );
    if (presentedSatisfies) {
      this.notePresentedTabProject(this.activeTabId, presented);
      return;
    }
    const candidateId = this.presentationCandidateForProject(activeId);
    if (candidateId && candidateId !== this.activeTabId) {
      this.switchTab(candidateId, { plane: 'user' });
      const presentedNow = this.tabs.get(this.activeTabId);
      if (this.activeTabId === candidateId && presentedNow) {
        this.notePresentedTabProject(candidateId, presentedNow);
      }
      return;
    }
    if (candidateId && candidateId === this.activeTabId) {
      const presentedNow = this.tabs.get(candidateId);
      if (presentedNow) this.notePresentedTabProject(candidateId, presentedNow);
      return;
    }
    // No tab under this scope: mint one, stamped (or shared when the scope is
    // cleared) by the active project at mint time.
    this.createTab('https://www.google.com');
  }

  /**
   * Record the presented tab in the per-project last-active map: a stamped tab
   * under its own stamp, a shared tab under the project being presented. The map
   * is memory for the next switch, never an authority, so a partial host without
   * the field simply skips the note.
   */
  private notePresentedTabProject(tabId: string, tab: NativeTabRecord | undefined): void {
    if (!tabId || !tab || !this.lastActiveTabByProject) return;
    const stamped = typeof tab.projectId === 'string' && tab.projectId ? tab.projectId : null;
    const bucket = stamped ?? this.activeProjectId;
    if (bucket) this.lastActiveTabByProject.set(bucket, tabId);
  }

  /**
   * Install (or clear) the delegate a user-plane foreign-project activation is
   * handed to. The host never writes `activeProjectId` on a flip: Main runs its
   * own `activateWebHubProject` so the affiliation, the identity and the
   * broadcast change together.
   */
  public setForeignProjectActivatedHandler(handler: ((projectId: string) => void) | null): void {
    this.foreignProjectActivatedHandler = typeof handler === 'function' ? handler : null;
  }

  /**
   * Install (or clear) Main's detached-shell probe — the liveness answer the
   * assign-project row exception consults before it lets the hub move a
   * `project:`-owned terminal row. See `detachedShellProbe`.
   */
  public setDetachedShellProbe(probe: ((projectId: string) => boolean) | null): void {
    this.detachedShellProbe = typeof probe === 'function' ? probe : null;
  }

  /** Whether a live detached shell currently owns `projectId`. */
  private detachedShellOwns(projectId: string): boolean {
    const probe = this.detachedShellProbe;
    if (!probe || !projectId) return false;
    try {
      return probe(projectId) === true;
    } catch {
      return false;
    }
  }

  /**
   * Main's opener for the shared Terminal Manager window. Every "give terminals their own
   * window" entry (toolbar pop-out, sidebar new-window, Ctrl+Shift+N) lands there: terminals
   * have exactly one window, never a per-host popout.
   */
  public setOpenTerminalManagerHandler(handler: (() => void) | null): void {
    this.openTerminalManagerHandler = typeof handler === 'function' ? handler : null;
  }

  /** Ask Main to open (or focus) the Terminal Manager. False when no Main is wired. */
  public openTerminalManager(): boolean {
    const handler = this.openTerminalManagerHandler;
    if (!handler) return false;
    handler();
    return true;
  }


  /**
   * Install (or clear) Main's project-descriptor resolver — the validated
   * title/pathLabel source the hub identity paints and the restore path's
   * knownness check reads. Absent means "no validated record could be proven".
   */
  public setWebHubProjectDescriptorResolver(resolver: WebHubProjectDescriptorResolver | null): void {
    this.webHubProjectDescriptorResolver = typeof resolver === 'function' ? resolver : null;
  }

  private describeWebHubProject(projectId: string): WebHubProjectDescriptor | undefined {
    const resolver = this.webHubProjectDescriptorResolver;
    if (!resolver) return undefined;
    try {
      const descriptor = resolver(projectId);
      if (!descriptor || typeof descriptor.title !== 'string' || !descriptor.title) return undefined;
      return descriptor;
    } catch {
      return undefined;
    }
  }

  /** The project the 'web' hub shell is presenting, or null when none is active. */
  public activeProject(): string | null {
    return this.activeProjectId;
  }

  /**
   * Tab ids whose record carries `projectId === projectId` — the membership
   * answer for the web hub's per-project tab questions (a LIVE check reads
   * `tabsForProject(id).length`; a renderer grouping reads the ids). Records
   * carry no projectId outside the 'web' shell, so other hosts answer [].
   */
  public tabsForProject(projectId: string): string[] {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    if (!id) return [];
    const tabIds: string[] = [];
    for (const [tabId, tab] of this.tabs) {
      if (tab?.projectId === id) tabIds.push(tabId);
    }
    return tabIds;
  }

  /**
   * The project id a freshly minted strip tab should carry, or undefined for none.
   * An explicit request wins (`null` deliberately mints a shared tab). Absent one, the
   * hub stamps its active project; a detached `project:<id>` window stamps the project
   * that owns it — the window's owner key IS that project's identity, since a detached
   * host carries no `activeProjectId`. Agent surfaces (`ephemeral`) and
   * every other owner stamp nothing.
   */
  public stampProjectIdForMint(requested: string | null | undefined, isAgentSurface: boolean): string | undefined {
    if (isAgentSurface) return undefined;
    if (requested === null) return undefined;
    const owner = parseOwnerKey(this.windowOwnerKey());
    if (typeof requested === 'string' && requested.trim()) {
      // An explicit stamp is honored on the two owners whose tabs a project legitimately
      // holds — the hub (stamps its presented scope) and a detached `project:` shell —
      // never widened to arbitrary owners.
      if (owner.kind === 'web' || owner.kind === 'project') return requested.trim();
      return undefined;
    }
    if (owner.kind === 'project') return owner.projectId;
    if (owner.kind === 'web' && this.activeProjectId) return this.activeProjectId;
    return undefined;
  }

  /**
   * Serialize this window's live tabs stamped `projectId` into persisted-row form for
   * a detach transfer — the same `sanitizeTabForPersistence` projection a persisted
   * record carries, so the receiving host re-homes them through the one normalization
   * path (`ingestTabRow`) a file restore uses. Strip order is preserved; agent
   * surfaces cannot carry a stamp (see `stampProjectIdForMint`) so nothing leaks.
   * `terminalAffinities` ride along — restricted to entries whose tabs are all moving,
   * so a terminal's bound tabs arrive with their affinity intact and partial sets are
   * never claimed.
   */
  public serializeProjectTabsForTransfer(projectId: string): {
    tabs: Array<Record<string, unknown>>;
    terminalAffinities: SavedTerminalAffinityRecord[];
    activeSourceTabId?: string;
  } {
    const id = typeof projectId === 'string' ? projectId.trim() : '';
    const rows: Array<Record<string, unknown>> = [];
    for (const tabId of this.tabOrder) {
      const tab = this.tabs.get(tabId);
      if (!tab || tab.projectId !== id) continue;
      const row = sanitizeTabForPersistence(tab.state) as Record<string, unknown>;
      row.projectId = id;
      rows.push(row);
    }
    const movedTabIds = new Set(
      rows.map((row) => (typeof row.id === 'string' ? row.id : undefined)).filter((value): value is string => Boolean(value)),
    );
    const terminalAffinities: SavedTerminalAffinityRecord[] = [];
    for (const [key, entry] of (this.terminalAgentAffinity ?? new Map<string, TerminalAgentAffinityEntry>())) {
      const terminalId = key.split('@')[0];
      const primaryTabId = entry?.primaryTabId || entry?.tabId;
      if (!terminalId || !primaryTabId || !movedTabIds.has(primaryTabId)) continue;
      const managed = Array.from(entry?.managedTabIds ?? [primaryTabId])
        .filter((tabId): tabId is string => typeof tabId === 'string' && movedTabIds.has(tabId));
      terminalAffinities.push({ terminalId, primaryTabId, managedTabIds: managed });
    }
    const active = this.activeTabId && movedTabIds.has(this.activeTabId) ? this.activeTabId : undefined;
    return { tabs: rows, terminalAffinities, ...(active ? { activeSourceTabId: active } : {}) };
  }

  /**
   * Durable removal of a project's persisted hub tabs. When the web hub is not open the
   * live `closeTabsForProject` cannot run, and leaving the stamped rows in `owners.web`
   * would resurrect a removed project's tabs on the next boot. The file is the source of
   * truth here — rewritten atomically, serialized behind the same write chain live
   * persists use, so a mid-write crash cannot half-remove the record.
   *
   * Returns the count of rows removed. Any read/parse/write failure throws: the caller
   * must fail the removal rather than close the project over tabs it cannot prove gone.
   */
  public async purgePersistedTabsForProject(projectId: string): Promise<number> {
    return purgeSavedTabsFileForProject(this.getTabsStoragePath(), projectId);
  }

  /**
   * Unload-aware close of every tab stamped with a project, the removal path's web
   * counterpart to the retired `project:`-shell close. Each page goes through the same
   * `closePage()` an attempt's own close does, so a vetoing page — an unsaved form, a
   * hanging unload — is reported rather than destroyed. Callers treat any entry in
   * `vetoed` as the refusal the retired shell-close used to carry.
   */
  public async closeTabsForProject(projectId: string): Promise<{ closed: string[]; vetoed: string[] }> {
    const closed: string[] = [];
    const vetoed: string[] = [];
    this.foreignFlipSuppressed = (this.foreignFlipSuppressed || 0) + 1;
    try {
      for (const tabId of this.tabsForProject(projectId)) {
        const outcome = await this.closePage(tabId);
        // 'unknown' for a tab that is already gone (closed by the user during the
        // awaited loop) is a close, not a veto: nothing of the project survives.
        if (outcome === 'closed' || (outcome === 'unknown' && !this.tabs.has(tabId))) closed.push(tabId);
        else vetoed.push(tabId);
      }
    } finally {
      this.foreignFlipSuppressed = (this.foreignFlipSuppressed || 1) - 1;
    }
    return { closed, vetoed };
  }

  /**
   * Tell every terminal surface this window renders that the stored project list moved, so
   * a Terminal Manager shows a project the moment it is created instead of at its next boot.
   */
  public notifyProjectInventoryChanged(): void {
    const sidebar = this.shell.sidebarView?.webContents;
    if (sidebar && !sidebar.isDestroyed()) {
      safeSendWebContents(sidebar, PROJECT_WINDOW_CHANNELS.PROJECT_INVENTORY_CHANGED);
    }
    for (const win of this.terminalWindows.values()) {
      if (win && !win.isDestroyed()) safeSendWebContents(win.webContents, PROJECT_WINDOW_CHANNELS.PROJECT_INVENTORY_CHANGED);
    }
  }

  /**
   * The workspace root this window's terminals belong to, or '' when the window has
   * no verified association. Never another window's workspace.
   */
  public resolveWindowWorkspaceRoot(): string {
    // A pure field read: terminal routing calls this for every output chunk of every
    // session, so the directory is verified once, in setWindowWorkspaceAffiliation.
    return this.windowWorkspaceAffiliation?.workspacePath ?? '';
  }

  /**
   * The provenance tag this window's sessions carry: its capsule when it has one, else its
   * verified workspace, so two project windows that both lack a capsule still own separate
   * buckets instead of sharing the sentinel. Undefined only when the window has no verified
   * workspace at all — the Unassigned case, which owns nothing but what no project claimed.
   */
  private windowTerminalProvenance(): string | undefined {
    const capsuleId = this.windowWorkspaceAffiliation?.capsuleId;
    if (capsuleId) return capsuleId;
    const root = this.resolveWindowWorkspaceRoot();
    return root ? workspaceTerminalProvenance(this.windowOwnerKey(), root) : undefined;
  }

  /**
   * The scope this window sees a session under.
   *
   * `ownerKey` is the window's own key, and it is the whole decision for every row that was
   * minted with one: two project windows that share one folder each mint under their own key,
   * so neither ever answers for the other's terminals the way a shared capsule let it.
   *
   * `tags` is the legacy rule, kept for the rows already on disk that carry no owner key: a
   * window's own capsule, plus the workspace tag it would carry without one, so a session
   * created before this window's project gained a capsule belongs to the same project
   * workspace and must not disappear from the window that created it. Both are positively
   * attributed, so another project's session — a different capsule, or the same directory
   * attached by another project — never matches. A window with no verified workspace at all
   * sees only what no window claimed (`DEFAULT_TERMINAL_CAPSULE_ID`, or a legacy record that
   * carries no tag).
   *
   * `managerAll` is the third answer, and it is not a wider version of the two above: the
   * shared Terminal Manager (the Unassigned shell) sees every row there is (see
   * `isSharedTerminalManagerSender`). The 'web' hub is deliberately not one: its scope is
   * the project it is presenting, and switching project is the hub's click. Everything
   * that reads a terminal row on behalf of a window asks here, so each window answers the
   * same way for the projection it renders, the list it bootstraps from and the
   * diagnostics it can read.
   */
  private windowSessionScope(senderId?: number): { ownerKey: string; tags: Set<string>; acceptsUnclaimed: boolean; managerAll: boolean } {
    const tags = new Set<string>();
    const capsuleId = this.windowWorkspaceAffiliation?.capsuleId;
    if (capsuleId) tags.add(capsuleId);
    const root = this.resolveWindowWorkspaceRoot();
    if (root) tags.add(workspaceTerminalProvenance(this.windowOwnerKey(), root));
    // The web hub is not a manager: it shows the terminals of the project it is currently
    // presenting (switching is its click), while only the Terminal Manager shows all of them.
    // A hub with no active project falls back to its own 'web' key.
    const scopeOwnerKey = this.windowOwnerKey() === WEB_OWNER_KEY && this.activeProjectId
      ? ownerKey({ kind: 'project', projectId: this.activeProjectId })
      : this.windowOwnerKey();
    return {
      ownerKey: scopeOwnerKey,
      tags,
      acceptsUnclaimed: tags.size === 0,
      managerAll: this.isSharedTerminalManagerSender(senderId),
    };
  }

  /**
   * Whether a caller is the shared Terminal Manager — the window that belongs to no
   * project and shows every project's terminals at once, `agent:` rows included, because
   * an agent's terminal is exactly the kind of row a person watching all projects wants to
   * see. The 'web' hub is not this: it shows one project at a time and switches on click.
   * What that scope may *do* with those rows is decided separately (see
   * `assertManagerMayOperate`).
   *
   * Only that window's own chrome may ask. A page inside it is not the manager — a page is never a
   * chrome surface, so the WebContents check below refuses it — and neither is the bridge or MCP:
   * those answer through the terminal capability surface and never reach this host. A caller that
   * names no WebContents at all is the host projecting to its own renderers (its sidebar, its
   * terminal windows, its diagnostics), and the host's own window is the only scope it can be
   * speaking for.
   */
  public isSharedTerminalManagerSender(senderId?: number): boolean {
    if (this.windowOwnerKey() !== UNASSIGNED_OWNER_KEY) return false;
    return senderId === undefined || this.ownsChromeSender(senderId);
  }

  /**
   * The manager's write gate: a session it may only read is refused before any manager call.
   *
   * The shared manager renders every window's rows, and an `agent:` row belongs to no window at
   * all — an agent created that shell and is driving it. Showing it is the point; typing into it,
   * sleeping it, killing it or handing it to another capsule would take a running agent's shell out
   * from under it, so the manager reads those rows and nothing more. Reads are untouched: every
   * projection, diagnostics report and buffer stays whole for the manager.
   *
   * The refusal is returned, never thrown: the calling route answers in its own contract, so a
   * boolean channel resolves `false` and a fire-and-forget channel reports the code it logged
   * instead of leaving a throw in an IPC path that has nowhere to put one.
   */
  public assertManagerMayOperate(sessionId: string, senderId?: number): true | ManagerWriteRefusal {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) return true;
    if (!this.isSharedTerminalManagerSender(senderId)) return true;
    const owner = this.sessionOwnerKey(id);
    if (!owner || parseOwnerKey(owner).kind !== 'agent') return true;
    return {
      ok: false,
      reason: 'MANAGER_AGENT_SESSION_READ_ONLY',
      message: `Agent-owned session '${id}' is shown to the shared manager read-only`,
    };
  }

  /** The owner key the manager holds for a session; `undefined` when nothing owns it. */
  private sessionOwnerKey(sessionId: string): string | undefined {
    const tm = TerminalManager.getInstance() as TerminalManagerSeam;
    if (typeof tm.sessionOwnerKey !== 'function') return undefined;
    const owner = tm.sessionOwnerKey(sessionId);
    return typeof owner === 'string' && owner.length > 0 ? owner : undefined;
  }

  /** Report a manager write refusal on the channel that hit it, for the channels that cannot reply. */
  private reportManagerWriteRefusal(surface: string, refusal: ManagerWriteRefusal): void {
    console.warn(`[native-tab-host] ${surface} refused: ${refusal.reason} — ${refusal.message}`);
  }

  /**
   * Session projection scoped to this window. `includeSessionId` keeps a terminal popout's
   * own binding visible even when the scope would hide it.
   *
   * There is no unscoped fallback: a seam that can name neither a session's owner nor its
   * capsule attributes nothing, so the projection is EMPTY. The unscoped view is every
   * project's sessions, and falling back to it would hand a scoped window exactly what the
   * scope exists to withhold.
   */
  private scopedTerminalProjection(includeSessionId?: string, senderId?: number): TerminalSessionStateProjection {
    return this.terminalStateForWindow(TerminalManager.getInstance().getSessionState(), includeSessionId, senderId);
  }

  /**
   * The terminal state this window may see, projected from the process-wide view.
   *
   * Only the sessions this window can attribute to itself survive — every one of them, when the
   * window is the shared manager; the transcript on hand belongs to whichever session the process
   * view made active, so a window that may not see that session is given an empty one instead of a
   * foreign transcript.
   *
   * `senderId` is the WebContents the projection is being built for, so the manager rule is
   * decided by the same funnel that decides the row's visibility (`windowSessionScope`).
   */
  private terminalStateForWindow(state: unknown, includeSessionId?: string, senderId?: number): TerminalSessionStateProjection {
    const projection = (state ?? {}) as Partial<TerminalSessionStateProjection>;
    const sessions = (Array.isArray(projection.sessions) ? projection.sessions : []).filter(
      (session) => session && (this.isSessionVisibleToWindow(session.id, undefined, senderId) || session.id === includeSessionId),
    );
    const rawActive = typeof projection.activeSessionId === 'string' ? projection.activeSessionId : '';
    const wanted = includeSessionId && sessions.some((session) => session.id === includeSessionId) ? includeSessionId : undefined;
    const activeSessionId = wanted ?? (sessions.some((session) => session.id === rawActive) ? rawActive : (sessions[0]?.id ?? ''));
    const transcriptKept = activeSessionId !== '' && activeSessionId === rawActive;
    const splitSessionId = typeof projection.splitSessionId === 'string' && sessions.some((session) => session.id === projection.splitSessionId)
      ? projection.splitSessionId
      : undefined;
    return {
      activeSessionId,
      sessions: this.stampFolderProjection(sessions),
      ...(splitSessionId ? { splitSessionId } : {}),
      snapshot: transcriptKept && typeof projection.snapshot === 'string' ? projection.snapshot : '',
      snapshotThroughSeq: transcriptKept && typeof projection.snapshotThroughSeq === 'number' ? projection.snapshotThroughSeq : 0,
    };
  }

  /**
   * The folder identity a row was minted with, stamped onto its summary copy. The stamped
   * fields answer "which folder" one way — `canonicalFolderKey` of the capsule's workspace
   * root when a capsule records one, else of the session's own cwd — so two spellings of one
   * directory, however they arrived, land the same key. The stamps are projection-only: the
   * session record keeps the path it was told, and nothing here is what gets persisted.
   *
   * `displayLabel` names the rows still wearing the minted `Terminal N` name — and only
   * those, because a name the user typed is the label they asked for. `n` counts this
   * window's visible rows of the same folder in list order, so each window's numbering is
   * contiguous over exactly the rows it renders.
   */
  private stampFolderProjection(rows: readonly SessionSummary[]): SessionSummary[] {
    if (rows.length === 0) return [];
    // The capsule index is built once per projection: `list()` already clones, and a row's
    // own capsule lookup over the full index is then O(1).
    const capsuleById = new Map<string, WorkspaceCapsule>();
    try {
      for (const capsule of this.capsuleManager.list()) capsuleById.set(capsule.id, capsule);
    } catch {
      // A manager that cannot list attributes nothing — rows keep their `name`, which is the
      // same absence of projection any pre-capsule session renders under.
    }
    // Folder a session claims: its capsule's workspace root is the anchor of record when one
    // exists; the spawn cwd stands in only when nothing else can say.
    const rawFolderOf = (row: SessionSummary): string => {
      const capsule = typeof row.capsuleId === 'string' ? capsuleById.get(row.capsuleId) : undefined;
      if (capsule && typeof capsule.workspacePath === 'string' && capsule.workspacePath.trim()) return capsule.workspacePath;
      return typeof row.cwd === 'string' ? row.cwd : '';
    };
    const counts = new Map<string, number>();
    return rows.map((row) => {
      const raw = rawFolderOf(row);
      const facts = raw.trim() ? this.folderFactsFor(raw) : null;
      if (!facts) return row;
      const n = (counts.get(facts.folderKey) ?? 0) + 1;
      counts.set(facts.folderKey, n);
      const stamped: SessionSummary = { ...row, folderKey: facts.folderKey, folderLabel: facts.folderLabel, folderPath: facts.canonicalPath };
      // `Terminal N` is what the mint wrote, so it is the name the badge replaces; a user-set
      // name that happens to spell the same words is still theirs and shows instead.
      const mintedName = `Terminal ${row.id.replace('terminal-', '')}`;
      if (row.name === mintedName || !row.name.trim()) {
        stamped.displayLabel = `${facts.folderLabel} · ${n}`;
      }
      return stamped;
    });
  }

  /**
   * Canonical folder facts for one input path, cached per spelling: `realpath` is the one
   * filesystem answer every grouping and label needs, and the per-window broadcast would pay
   * it for every row without the cache. A path that no longer resolves keeps its last facts —
   * the row's folder is still the folder it ran in — while one that never resolved is keyed
   * by `path.resolve` with the basename of the spelling itself, so a stale row can still land
   * beside a live one that names the same folder.
   */
  private folderFactsFor(folder: string): { canonicalPath: string; folderKey: string; folderLabel: string } {
    const input = folder.trim();
    // `private readonly` initializers do not run on `Object.create` test doubles, so the map
    // is made here rather than assumed — the field stays the single owner of the cache.
    const cache = (this.folderFactsCache ??= new Map());
    const cached = cache.get(input);
    if (cached) return cached;
    let canonicalPath = input;
    try {
      canonicalPath = fs.realpathSync.native(input);
    } catch {
      // An unreadable folder keys on its resolved spelling: it is still the one identity that
      // spelling has for this process, and the label below renders what the row told us.
      canonicalPath = path.resolve(input);
    }
    const facts = {
      canonicalPath,
      folderKey: canonicalFolderKey(input),
      folderLabel: path.basename(canonicalPath) || canonicalPath,
    };
    // Bounded: every distinct spelling a row ever reported is a key, so evict the oldest.
    if (this.folderFactsCache.size >= 512) {
      const oldest = this.folderFactsCache.keys().next();
      if (!oldest.done) this.folderFactsCache.delete(oldest.value);
    }
    this.folderFactsCache.set(input, facts);
    return facts;
  }

  /**
   * The session this window presents as active: its terminal window's own binding when the
   * sender is one, else the active session of this window's scope.
   *
   * The manager's active session is process-wide mutable state, so it answers for whichever
   * window switched last, not for this one. Every implicit terminal route — input, kill,
   * restart, resize, buffer — resolves its target here instead, and refuses when the window
   * presents nothing.
   */
  public windowActiveSessionId(sender?: unknown): string {
    const senderId = senderWebContentsId(sender);
    const bound = this.terminalSessionForSender(sender);
    if (bound && this.isSessionVisibleToWindow(bound, undefined, senderId)) return bound;
    return this.terminalStateForWindow(TerminalManager.getInstance().getSessionState(), undefined, senderId).activeSessionId;
  }

  /**
   * Run a manager call that only exists against the active session, aimed at this window's
   * own session.
   *
   * `restart` is the terminal RPC the manager exposes against no session in particular.
   * Switching first is what makes it act on the session the calling window presents instead
   * of whichever window switched last, and the restore puts the previous one back so the
   * other windows' views land where they were. Returns false when the window presents
   * nothing to act on.
   */
  public async runAgainstWindowActive(sender: unknown, run: () => Promise<unknown> | unknown): Promise<boolean> {
    const tm = TerminalManager.getInstance() as TerminalManagerSeam;
    const target = this.windowActiveSessionId(sender);
    if (!target) return false;
    const previous = tm.getActiveSessionId();
    if (previous !== target) {
      const switched = await tm.switchSession(target);
      if (!switched) return false;
    }
    try {
      await run();
      return true;
    } finally {
      if (previous && previous !== target && tm.getSession(previous)) {
        await tm.switchSession(previous);
      }
    }
  }

  /**
   * Whether a session may be acted on from this window: the same scope its sidebar renders.
   *
   * Every IPC route that names a session is admitted through here before it reaches the
   * manager, so a renderer cannot read, type into, rename or kill a session it was never
   * shown. A route that names no session acts on this window's own active session instead.
   */
  public admitsSessionForWindow(sessionId: string, senderId?: number): boolean {
    return this.isSessionVisibleToWindow(sessionId, undefined, senderId);
  }

  /**
   * Whether a session's output belongs to this window.
   *
   * Ownership is the key a session was minted under, and it decides alone as soon as the row
   * carries one: two project windows may share one folder and one capsule, and the key is what
   * keeps each window's terminals its own. A project window therefore never matches
   * `'unassigned'`, which is the process-default mint's owner, nor an `agent:` key, which
   * belongs to no window at all.
   *
   * A row written before ownership existed carries no key and keeps the capsule rule it was
   * created under, so nothing already on disk changes owner. An unattributable session — or a
   * seam that cannot answer — is refused rather than passed through, because the unscoped
   * answer is every project's session.
   *
   * The shared manager window is the one exception, and it is a scope of its own rather than a
   * widened project scope: an Unassigned window's own chrome sees every row, because one list
   * across projects is what that window is for (`windowSessionScope`).
   *
   * `facts` are the ownership facts a caller already holds, as a diagnostics row does. A
   * caller holding none has them read from the manager seam.
   */
  private isSessionVisibleToWindow(sessionId: string, facts?: { ownerKey?: string; capsuleId?: string }, senderId?: number): boolean {
    // A terminal window and the sidebar that opened it are the same window: the
    // session one of this host's own windows presents stays visible to its host.
    for (const meta of this.terminalWindowMeta.values()) {
      if (meta?.sessionId === sessionId) return true;
    }
    const { ownerKey, tags, acceptsUnclaimed, managerAll } = this.windowSessionScope(senderId);
    // The shared manager shows every project's rows, `agent:` rows included: the two rules below
    // attribute a row to ONE window, which is exactly the attribution this window exists to see
    // past. What it may then do with a row is a separate question (`assertManagerMayOperate`).
    if (managerAll) return true;
    const tm = TerminalManager.getInstance() as TerminalManagerSeam;
    const rowOwner = typeof facts?.ownerKey === 'string' && facts.ownerKey ? facts.ownerKey : undefined;
    const rowCapsule = typeof facts?.capsuleId === 'string' && facts.capsuleId ? facts.capsuleId : undefined;

    const sessionOwner = rowOwner ??
      (typeof tm.sessionOwnerKey === 'function' ? tm.sessionOwnerKey(sessionId) : undefined);
    if (sessionOwner !== undefined) return sessionOwner === ownerKey;

    // No owner key on the row: it predates ownership, so its capsule decides, exactly as it did
    // before the key existed. A seam that cannot name a capsule attributes nothing.
    if (rowCapsule === undefined && typeof tm.sessionCapsuleId !== 'function') return false;
    const sessionCapsuleId = rowCapsule ??
      (typeof tm.sessionCapsuleId === 'function' ? tm.sessionCapsuleId(sessionId) : undefined);
    if (tags.size > 0) {
      if (sessionCapsuleId === undefined) return false;
      return tags.has(sessionCapsuleId);
    }
    return acceptsUnclaimed && (sessionCapsuleId === undefined || sessionCapsuleId === DEFAULT_TERMINAL_CAPSULE_ID);
  }

  /**
   * The sessions this window may show, for a caller that asks for the list directly
   * instead of rendering the pushed projection.
   *
   * Same scope as `terminalStateForWindow`. The unscoped list is every project's
   * terminals, so it never leaves this host.
   */
  public visibleTerminalSessions(senderId?: number): SessionSummary[] {
    const tm = TerminalManager.getInstance();
    return this.terminalStateForWindow(tm.getSessionState(), undefined, senderId).sessions;
  }

  /**
   * Run cards visible to one window or popout. Popout windows are restricted to
   * their bound session; sidebar windows receive all sessions visible to this window.
   */
  public runCardsForWindow(runs: readonly RunCardState[], senderId?: number, boundSessionId?: string): RunCardState[] {
    let bound = boundSessionId;
    if (!bound && senderId !== undefined) {
      for (const [winId, meta] of this.terminalWindowMeta.entries()) {
        const win = this.terminalWindows.get(winId);
        if (win && win.webContents?.id === senderId) {
          bound = meta?.sessionId;
          break;
        }
      }
    }

    return (Array.isArray(runs) ? runs : []).filter((card) => {
      if (!card || typeof card.terminalSessionId !== 'string') return false;
      if (bound) {
        return card.terminalSessionId === bound;
      }
      return this.isSessionVisibleToWindow(card.terminalSessionId, undefined, senderId);
    });
  }

  /**
   * The process diagnostics this window may read.
   *
   * The report names every session, its owner key, its capsule, its subscriber and the
   * process-wide active session; a window is given its own rows only, with the active session
   * blanked when that session belongs to another window — the same attribution rule every
   * other terminal read goes through.
   *
   * The manager answers the process-wide report synchronously; the detached daemon's proxy
   * answers it asynchronously, so the caller awaits it and narrows the result here rather
   * than asking the authority for a filtered report it cannot always compute.
   */
  public scopeTerminalDiagnostics(report: unknown, senderId?: number): TerminalDiagnosticsReport {
    const source = (report ?? {}) as Partial<TerminalDiagnosticsReport>;
    // Each row names its own owner key and capsule, so the row is decided on the facts it
    // carries — by the same rule, in the same order, the sidebar and every other terminal read
    // go through.
    const sessions = (Array.isArray(source.sessions) ? source.sessions : []).filter(
      (session) => Boolean(session) && this.isSessionVisibleToWindow(session.sessionId, session, senderId),
    );
    // A subscriber row that cannot name its session cannot be attributed to any window, so it
    // is dropped rather than shown: `recordSubscriberAck` always records a session id.
    const subscribers = (Array.isArray(source.subscribers) ? source.subscribers : []).filter(
      (subscriber) => typeof subscriber?.sessionId === 'string' && this.isSessionVisibleToWindow(subscriber.sessionId, undefined, senderId),
    );
    const activeSessionId = typeof source.activeSessionId === 'string' && this.isSessionVisibleToWindow(source.activeSessionId, undefined, senderId)
      ? source.activeSessionId
      : '';
    return {
      timestamp: typeof source.timestamp === 'number' ? source.timestamp : Date.now(),
      sessionCount: sessions.length,
      activeSessionId,
      sessions,
      subscribers,
    };
  }

  /** The session a terminal window of this host presents directly, if any. */
  private terminalSessionForSender(sender: unknown): string | undefined {
    if (!sender || typeof sender !== 'object') return undefined;
    const windowId = BrowserWindow.fromWebContents(sender as Electron.WebContents)?.id;
    if (windowId === undefined) return undefined;
    return this.terminalWindowMeta?.get(windowId)?.sessionId;
  }

  /**
   * Working directory, capsule and owner for a terminal this window is about to create.
   *
   * A terminal popout keeps the workspace it was opened in (its own bound session
   * is this window's state, not another window's); otherwise the window's verified
   * workspace root wins. The last resort is the immutable process-start directory:
   * `TerminalManager.currentCwd` is process-wide mutable state another window's
   * workspace switch rewrites, so inheriting it is exactly how one project's
   * terminal opens in another project's directory.
   *
   * The owner travels with the mint: the popout session's own owner when it has one, otherwise
   * `terminalMintOwnerKey` — the viewed project on the 'web' hub, else this window's key — which
   * is what keeps two windows that share one folder apart. The
   * process-default arm attributes to this window too — the asking window's identity is always
   * known even when its workspace is not, and the sentinel would mint a row this window hides
   * from itself. `DEFAULT_TERMINAL_OWNER_KEY` stays the manager-level default for calls that
   * name no window at all.
   */
  public resolveTerminalCreationTarget(sender?: unknown): TerminalCreationTarget {
    const tm = TerminalManager.getInstance() as TerminalManagerSeam;
    const popoutSessionId = this.terminalSessionForSender(sender);
    if (popoutSessionId) {
      const session = tm.getSession(popoutSessionId) as { cwd?: string; capsuleId?: string } | undefined;
      if (session?.cwd && isExistingDirectory(session.cwd)) {
        return {
          cwd: path.normalize(session.cwd),
          capsuleId: session.capsuleId || DEFAULT_TERMINAL_CAPSULE_ID,
          ownerKey: (typeof tm.sessionOwnerKey === 'function' ? tm.sessionOwnerKey(popoutSessionId) : undefined) ?? this.terminalMintOwnerKey(),
          source: 'popout-session',
        };
      }
    }
    const windowRoot = this.resolveWindowWorkspaceRoot();
    // Spawning a shell is the one place a vanished workspace matters: check it here, cold,
    // rather than on the per-chunk routing path.
    if (windowRoot && isExistingDirectory(windowRoot)) {
      return {
        cwd: windowRoot,
        capsuleId: this.windowTerminalProvenance() ?? DEFAULT_TERMINAL_CAPSULE_ID,
        ownerKey: this.terminalMintOwnerKey(),
        source: 'window-workspace',
      };
    }
    const defaultCwd = tm.getDefaultCwd?.() || process.cwd();
    return {
      cwd: defaultCwd,
      capsuleId: DEFAULT_TERMINAL_CAPSULE_ID,
      ownerKey: this.terminalMintOwnerKey(),
      source: 'process-default',
    };
  }

  /**
   * Owner key a terminal minted from this host carries. On the 'web' hub the viewed project
   * owns its rows — `project:<activeProjectId>` — so a project terminal stays attributed to
   * its project even though the hub window itself is `web`. With no active project, or when
   * the hub presents the boot sentinel ("Tổng hợp" — the hub's own placeholder identity, not
   * a tenant), the mint falls back to this window's own key: `'web'` on the hub, deliberately
   * NOT `'unassigned'` — `'unassigned'` is the Terminal Manager's owner key, and stamping it
   * on hub-created terminals would attribute them to a window that never asked for them. A
   * `project:<bootId>` stamp would make the control plane measure the terminal as living in
   * a project no window can own, refusing every MCP target under it. Non-web shells are
   * unaffected: they mint under their own key exactly as before.
   */
  private terminalMintOwnerKey(): string {
    const activeId = this.activeProjectId;
    if (this.windowOwnerKey() === WEB_OWNER_KEY && activeId && !isBootProjectId(activeId)) return `project:${activeId}`;
    return this.windowOwnerKey();
  }

  /**
   * Exact tab identity: never index-resolved, so a stale id can never name a
   * different tab. `hasTab` deliberately resolves numeric references and must
   * not be used where exactness is the contract.
   */
  public hasExactTab(tabId: string): boolean {
    if (!tabId || !this.tabs) return false;
    return this.tabs.has(tabId);
  }

  /**
   * Identity of the project window this host belongs to, as the toolbar renderer
   * paints it. Every field is Main-resolved at shell construction or from this
   * host's own affiliation — a page title or a renderer string can never become
   * the project's name. The key's presence is the signal in a later broadcast, so
   * this is sent on every state push rather than only once at boot.
   */
  public projectWindowIdentity(): ProjectWindowIdentity {
    const workspacePath = this.resolveWindowWorkspaceRoot();
    // A shell without a resolved owner is the absence of project authority, and the
    // contract has no "unknown" member: fail closed to Unassigned rather than
    // reporting a window that owns nothing.
    const owner = this.shell?.owner ?? { kind: 'unassigned' };
    if (owner.kind === 'web') {
      // The hub's chrome belongs to the project it presents, not to the singleton
      // window: title/path come from the same validated record the Terminal
      // Manager's rows read (Main's resolver), and `activeProjectId` is the strip's
      // scope filter. With no active project the hub keeps its product title.
      const activeId = this.activeProjectId;
      const descriptor = activeId ? this.describeWebHubProject(activeId) : undefined;
      return {
        owner,
        title: activeId ? (descriptor?.title ?? activeId) : (this.shell?.title || 'AntiFan Browser'),
        activeProjectId: activeId,
        ...(descriptor?.pathLabel ? { pathLabel: descriptor.pathLabel } : {}),
        ...(workspacePath ? { workspacePath } : {}),
      };
    }
    return {
      owner,
      title: this.shell?.title ?? '',
      ...(this.shell?.pathLabel ? { pathLabel: this.shell.pathLabel } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    };
  }

  /**
   * The user-visible inventory the `'antifan:tabs:search'` contract lists: this
   * window's tabs in strip order, excluding ephemeral automation
   * surfaces no user can see or choose.
   */
  public listSearchInventory(): TabSearchInventoryRow[] {
    const ownerKeyValue = this.windowOwnerKey();
    const label = this.windowOwnerLabel();
    const projectPath = this.resolveWindowWorkspaceRoot();
    const rows: TabSearchInventoryRow[] = [];
    this.tabOrder.forEach((tabId, order) => {
      const tab = this.tabs.get(tabId);
      if (!tab) return;
      if (tab.state.ephemeral === true) return;
      rows.push({
        tabId,
        title: tab.state.title || tab.state.url || '',
        url: tab.state.url || '',
        ownerKey: ownerKeyValue,
        ownerLabel: label,
        ...(projectPath ? { projectPath } : {}),
        active: tabId === this.activeTabId,
        order,
      });
    });
    return rows;
  }

  /**
   * Select an exact tab on behalf of an explicit user search activation.
   *
   * Validation and selection are one synchronous step: the tab must still exist
   * under this exact id, must carry the owner the search result was rendered for,
   * and must still be user-visible. An incompatible result is refused outright —
   * never substituted by index, never retargeted to another tab — and nothing is
   * mutated when the check fails. Attachments are not touched: a user's visual
   * activation never rotates agent authority.
   */
  public selectSearchResultTab(tabId: string, expectedOwnerKey: string): TabSearchActivationResult {
    const tab = tabId && this.tabs ? this.tabs.get(tabId) : undefined;
    if (!tab || tab.state.ephemeral === true) {
      return { ok: false, tabId, reason: 'TAB_UNAVAILABLE' };
    }
    if (this.windowOwnerKey() !== expectedOwnerKey) {
      return { ok: false, tabId, reason: 'OWNER_CHANGED' };
    }
    this.switchTab(tabId, { plane: 'user' });
    if (this.activeTabId !== tabId) {
      return { ok: false, tabId, reason: 'TAB_UNAVAILABLE' };
    }
    return { ok: true, tabId, ownerKey: expectedOwnerKey, ownerLabel: this.windowOwnerLabel() };
  }

  public getActiveTabId(): string {
    return this.activeTabId;
  }

  public getActiveTab(): AntiFanTab | null {
    const t = this.tabs.get(this.activeTabId);
    return t ? { ...t.state, isAgentControlled: this.activeTabId === this.automationTabId } : null;
  }

  public getTabWebContents(tabId?: string, paneId?: SplitPaneId): Electron.WebContents | null {
    const targetId = tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return null;

    // A hibernated record materializes its views on first touch — this is the
    // single funnel every capability, devtools-host and legacy RPC path asks,
    // so waking here covers callers that never go through `switchTab`. Wake is
    // synchronous view+loadURL; the load-settle wait lives in `ensureTabReady`.
    if (tab.state.hibernated === true) {
      this.ensureTabAwake(targetId);
    }

    if (paneId === 'mobile') {
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        return tab.mobileView.webContents;
      }
      return null;
    }

    if (paneId === 'desktop') {
      const wc = tab.view?.webContents;
      return !wc || wc.isDestroyed() ? null : wc;
    }

    if (tab.state.splitMode && tab.focusedPane === 'mobile' && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      return tab.mobileView.webContents;
    }
    const wc = tab.view?.webContents;
    return !wc || wc.isDestroyed() ? null : wc;
  }
  public getAutomationTabId(): string | null {
    return this.automationTabId;
  }
  public setAutomationTabId(tabId?: string): void {
    const nextTabId = tabId && this.tabs.has(tabId) ? tabId : null;
    if (nextTabId === this.automationTabId) return;
    this.automationTabId = nextTabId;
    this.broadcastState();
  }

  public getAutomationTarget(): BrowserTarget | undefined {
    const tabId = this.automationTabId;
    if (!tabId || !this.tabs.has(tabId) || !this.controlPlane) return undefined;
    const lease = this.controlPlane.getLease();
    const tab = this.tabs.get(tabId);
    return {
      projectId: lease.projectId,
      workspaceId: lease.workspaceId || '',
      runtimeId: lease.runtimeId,
      tabId,
      browserEpoch: lease.hostEpoch,
      documentGeneration: this.getDocumentGeneration(tabId),
      url: tab?.state.url,
    };
  }

  private clearInitialNavigationHistory(wc: Electron.WebContents, state?: AntiFanTab): void {
    const navigationHistory = wc.navigationHistory;
    if (!navigationHistory || navigationHistory.length() <= 1) return;
    try {
      navigationHistory.clear();
      if (state) {
        state.canGoBack = navigationHistory.canGoBack();
        state.canGoForward = navigationHistory.canGoForward();
      }
      this.broadcastState();
    } catch (err) {
      console.warn('[native-tab-host] Failed to clear initial navigation history:', err);
    }
  }
  /**
   * Every partition currently referenced by a tab, ephemeral tabs
   * included, plus `'default'` when a tab runs without an explicit partition.
   * `getTabList()` deliberately projects only the user's tab strip, so a
   * lifecycle consumer (housekeeping, cleanup) that asks this question must read
   * the tab map instead.
   */
  public getLivePartitionNames(): string[] {
    const names = new Set<string>();
    for (const tab of this.tabs.values()) {
      const partition = tab.state.partition;
      names.add(partition && partition.length > 0 ? partition : 'default');
    }
    return Array.from(names);
  }

  public getTabSession(tabId: string): Electron.Session | null {
    const tab = this.tabs.get(tabId);
    if (!tab) return null;
    if (tab.view && !tab.view.webContents.isDestroyed()) {
      return tab.view.webContents.session;
    }
    if (tab.state.partition) {
      return session.fromPartition(tab.state.partition);
    }
    return session.defaultSession;
  }

  public isValidCapsulePartition(partition: string): boolean {
    if (!partition || typeof partition !== 'string') return false;
    const clean = partition.trim();
    if (clean.startsWith('persist:profile-') || clean.startsWith('ephemeral-profile-')) {
      return true;
    }
    if (clean.startsWith('ephemeral-')) {
      if (!/^ephemeral-[a-zA-Z0-9_-]+-[a-z0-9]+(-native)?$/.test(clean)) {
        return false;
      }
      for (const tab of this.tabs.values()) {
        if (tab.state.partition === clean) {
          return true;
        }
      }
      return false;
    }
    if (
      clean === deriveCapsulePartition('default') ||
      clean === 'persist:capsule-default' ||
      clean.startsWith('persist:profile-') ||
      clean.startsWith('persist:capsule-')
    ) {
      return true;
    }
    const allCapsules = this.capsuleManager.list();
    for (const cap of allCapsules) {
      if (
        clean === deriveCapsulePartition(cap.id, 'clean') ||
        clean === deriveCapsulePartition(cap.id, 'native')
      ) {
        return true;
      }
    }
    for (const tab of this.tabs.values()) {
      if (tab.state.partition === clean) {
        return true;
      }
    }
    return false;
  }

  public getPartitionSession(partition: string): Electron.Session {
    if (!partition || partition === 'default' || partition === 'persist:default') {
      return session.defaultSession;
    }
    return session.fromPartition(partition);
  }

  public getSharedProfilePartition(userAgentMode: BrowserSessionUserAgentMode = 'clean', ephemeral = false, profileId?: string): string {
    // Explicit profileId (when given) wins — the caller decides which profile's
    // cookies a hydration targets, without depending on prior mutable state.
    const activeProfileId = profileId ?? ChromeProfileSyncManager.getInstance().activeProfileId ?? 'default';
    const safeProfileKey = activeProfileId.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (ephemeral) {
      const nonce = Math.random().toString(36).slice(2, 10);
      return userAgentMode === 'native'
        ? `ephemeral-profile-${safeProfileKey}-${nonce}-native`
        : `ephemeral-profile-${safeProfileKey}-${nonce}`;
    }
    return userAgentMode === 'native'
      ? `persist:profile-${safeProfileKey}-native`
      : `persist:profile-${safeProfileKey}`;
  }

  public getSharedProfileSession(userAgentMode: BrowserSessionUserAgentMode = 'clean', profileId?: string): Electron.Session {
    const partition = this.getSharedProfilePartition(userAgentMode, false, profileId);
    configureBrowserSessionPartition(partition, userAgentMode);
    return session.fromPartition(partition);
  }

  /**
   * The single authoritative resolver for every profile-level credential
   * operation: Chrome profile sync, Session Vault export/import and extension
   * hydration. It is deliberately NON-AMBIENT: the focused tab never
   * participates, so a focused ephemeral (in-memory) or isolated capsule tab
   * can never silently receive a profile credential write as a side effect.
   * Fail-closed: the resolved partition must be a durable shared-profile
   * partition, otherwise this throws instead of writing into a jar that dies
   * with the tab.
   */
  public resolveTargetProfileSession(
    profileId?: string,
    userAgentMode: BrowserSessionUserAgentMode = 'clean'
  ): Electron.Session {
    const partition = this.getSharedProfilePartition(userAgentMode, false, profileId);
    if (!partition.startsWith('persist:profile-')) {
      throw new Error(`TARGET_SESSION_INVALID: refusing non-durable profile target (${partition})`);
    }
    configureBrowserSessionPartition(partition, userAgentMode);
    return session.fromPartition(partition);
  }

  /**
   * One-time, idempotent migration of legacy `persist:capsule-*` partitions to
   * the unified `persist:profile-*` partitions. Cookie data is COPIED — the
   * legacy partition is only ever deleted after manual verification, never
   * here. A marker file in the config dir guarantees exactly one run per
   * install. Local-only: never touches a Chrome profile. The copy/failure
   * logic is delegated to the Electron-free `runCapsuleToProfileMigration`.
   */
  public async migrateLegacyCapsuleToProfile(): Promise<{ migrated: number; legacyPartitions: string[] }> {
    const markerPath = path.join(StorageLocations.getConfigDir(), 'antifan-migration-capsule-to-profile.done');
    if (fs.existsSync(markerPath)) {
      return { migrated: 0, legacyPartitions: [] };
    }
    let partitionsDir = '';
    try {
      partitionsDir = path.join(app.getPath('userData'), 'Partitions');
    } catch {}
    const deps: CapsuleMigrationDeps = {
      listLegacyPartitionKeys: () => {
        if (!partitionsDir || !fs.existsSync(partitionsDir)) return [];
        return fs.readdirSync(partitionsDir).filter((n) => n.startsWith('capsule-'));
      },
      readCookies: async (partition) => {
        const cookies = await configureBrowserSessionPartition(partition).cookies.get({});
        return cookies.map((c) => ({
          domain: c.domain,
          path: c.path,
          secure: c.secure === true,
          httpOnly: c.httpOnly === true,
          name: c.name,
          value: c.value,
          expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
          sameSite: c.sameSite ? (c.sameSite as CapsuleMigrationCookie['sameSite']) : undefined,
        }));
      },
      writeCookie: async (target, c) => {
        await configureBrowserSessionPartition(target).cookies.set(buildCookieSetDetails(c));
      },
      flushStore: async (partition) => {
        await configureBrowserSessionPartition(partition).cookies.flushStore();
      },
    };
    const res = await runCapsuleToProfileMigration(deps);
    // Marker only marks the migration DONE when every legacy partition was
    // processed without error — a partial failure must retry on next launch.
    if (res.markerReady) {
      try {
        fs.writeFileSync(
          markerPath,
          JSON.stringify({ version: 1, migrated: res.migrated, legacyPartitions: res.legacyPartitions, at: new Date().toISOString() }, null, 2),
          'utf8'
        );
      } catch (err) {
        console.warn('[PartitionMigration] Cannot write marker file:', err);
      }
    }
    return { migrated: res.migrated, legacyPartitions: res.legacyPartitions };
  }

  public async flushAllSessions(): Promise<void> {
    const sessions = new Set<Electron.Session>();
    try {
      sessions.add(session.defaultSession);
    } catch {}
    try {
      const sharedSes = this.getSharedProfileSession();
      if (sharedSes) sessions.add(sharedSes);
    } catch {}
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        sessions.add(tab.view.webContents.session);
      } else if (tab.state.partition) {
        sessions.add(session.fromPartition(tab.state.partition));
      }
    }
    const promises = Array.from(sessions).map(async (s) => {
      try {
        if (s && s.cookies && typeof s.cookies.flushStore === 'function') {
          await s.cookies.flushStore();
        }
      } catch (err) {
        console.warn('[native-tab-host] Failed to flush cookie store for session:', err);
      }
    });
    await Promise.allSettled(promises);
  }


  private setupTabWebContentsEvents(
    id: string,
    view: WebContentsView,
    state: AntiFanTab,
    paneId: SplitPaneId = 'desktop'
  ): void {
    const wc = view.webContents;
    this.applySiteMute(wc, state, paneId, state.url);
    const updateAudible = () => {
      const tab = this.tabs.get(id);
      const desktopWc = tab?.view?.webContents;
      const mobileWc = tab?.mobileView?.webContents;
      state.isAudible = Boolean(tab && (
        (desktopWc && !desktopWc.isDestroyed() && desktopWc.isCurrentlyAudible()) ||
        (mobileWc && !mobileWc.isDestroyed() && mobileWc.isCurrentlyAudible())
      ));
      this.broadcastState();
    };
    wc.on('media-started-playing', updateAudible);
    wc.on('media-paused', updateAudible);
    let loadingSafetyTimer: NodeJS.Timeout | null = null;
    const clearLoadingTimer = () => {
      if (loadingSafetyTimer) {
        clearTimeout(loadingSafetyTimer);
        loadingSafetyTimer = null;
      }
    };

    this.networkTracker.ensureAttached(id, paneId, wc, () => wc.getURL()).catch(() => {});
    wc.on('did-start-loading', () => {
      state.isLoading = true;
      this.networkTracker.resetInflight(id, paneId);
      clearLoadingTimer();
      loadingSafetyTimer = setTimeout(() => {
        loadingSafetyTimer = null;
        if (!wc.isDestroyed() && this.tabs.has(id) && state.isLoading) {
          state.isLoading = false;
          this.broadcastState();
        }
      }, 12000);
      this.broadcastState();
    });

    wc.on('did-stop-loading', () => {
      clearLoadingTimer();
      state.isLoading = false;
      this.applySiteMute(wc, state, paneId, wc.getURL());
      this.networkTracker.retireDocumentRequests(id, paneId);
      const currentTab = this.tabs.get(id);
      const splitHasLiveMobile = Boolean(state.splitMode && currentTab?.mobileView && !currentTab.mobileView.webContents.isDestroyed());
      const authorityPane = splitHasLiveMobile ? (currentTab?.focusedPane || state.splitFocusedPane || 'desktop') : 'desktop';
      if (paneId === authorityPane) {
        state.canGoBack = this.getCanGoBack(wc);
        state.canGoForward = this.getCanGoForward(wc);
      }
      if (id === this.activeTabId) {
        const tab = this.tabs.get(id);
        if (tab && tab.view && !tab.state.ephemeral) {
          if (!this.isTabViewAttached(tab.view)) {
            try { this.attachTabView(tab.view, false); } catch {}
          }
          this.updateLayout();
          if (tab.view.webContents && typeof tab.view.webContents.invalidate === 'function') {
            try { tab.view.webContents.invalidate(); } catch {}
          }
        }
      }
      this.broadcastState();
    });
    wc.on('console-message', (event: any, ...legacyArgs: any[]) => {
      const hasParams = event && typeof event === 'object' && ('message' in event || 'level' in event);
      const rawLevel = hasParams ? event.level : legacyArgs[0];
      const rawMessage = hasParams ? event.message : legacyArgs[1];
      const line = hasParams ? event.lineNumber : legacyArgs[2];
      const rawSource = hasParams ? event.sourceId : legacyArgs[3];

      const source = String(rawSource || '');
      const message = String(rawMessage || '');
      // The failure channel is filtered in `did-fail-load`; this is the other
      // half of the same damage. Chromium's "Failed to load resource:
      // net::ERR_BLOCKED_BY_CLIENT" entry names the document as its source and is
      // error level, so the diagnostics classifier promotes it to a critical
      // first-party issue — an isolation window would flip QA's diagnostics check
      // from PASS to FAIL with no real defect on the page.
      if (
        this.devToolsHost?.isTrackerIsolationActive(id, paneId) &&
        isTrackerIsolationConsoleNoise(message, source, true)
      ) {
        return;
      }
      const origin = computeOrigin(source, wc.getURL());
      this.diagnosticsManager.recordConsole(id, {
        level: normalizeConsoleLevel(rawLevel),
        message,
        source,
        line: Number(line || 0),
        timestamp: Date.now(),
        origin: origin.origin,
        isFirstParty: origin.isFirstParty,
      });
    });
    wc.on('did-start-navigation', (_event, navUrl, isInPlace, isMainFrame) => {
      // Silence a muted destination before it can autoplay, but do not unmute
      // the old document until a different destination has actually committed.
      if (isMainFrame && this.mutedSites.has(getMuteSite(navUrl) || '')) {
        wc.setAudioMuted(true);
      }
      const semanticKey = makeTargetKey(id, paneId);
      if (!this.semanticDocumentGenerations) this.semanticDocumentGenerations = new Map();
      this.semanticDocumentGenerations.set(semanticKey, (this.semanticDocumentGenerations.get(semanticKey) || 1) + 1);
      this.semanticRefRegistry?.invalidateTarget(id, paneId);
      const currentTab = this.tabs.get(id);
      if (isMainFrame && !isInPlace && currentTab) {
        currentTab.redirectChain = [String(navUrl || '')];
      }
      const splitHasLiveMobile = Boolean(state.splitMode && currentTab?.mobileView && !currentTab.mobileView.webContents.isDestroyed());
      const authorityPane = splitHasLiveMobile ? (currentTab?.focusedPane || state.splitFocusedPane || 'desktop') : 'desktop';
      if (isMainFrame && !isInPlace && authorityPane === paneId) {
        const nextGen = (this.documentGenerations.get(id) || 0) + 1;
        this.documentGenerations.set(id, nextGen);
        const isOwnedReload = this.consumeOwnedReload(id);
        if (isOwnedReload) {
          this.asyncQaQueue?.rebindGeneration(id, nextGen);
        } else {
          this.asyncQaQueue?.abort(id);
          this.diagnosticsManager.clear(id);
          this.setThemeQaState(id, { status: 'idle', issueCount: 0, updatedAt: Date.now() });
        }
        if (id === this.activeTabId) {
          this.broadcastState();
        }
      }
    });
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) {
        this.bumpMutationRevision(id);
      }
    });
    wc.on('will-redirect', (event, redirectUrl, _isInPlace, isMainFrame) => {
      // Fail-closed unified navigation policy on server redirects — a 30x
      // must never escape the same allowlist as direct navigation.
      const rawRedirect = String(redirectUrl || '');
      const currentTab = this.tabs.get(id);
      if (currentTab?.redirectChain) {
        currentTab.redirectChain.push(rawRedirect);
      }
      if (!isAllowedNavigation(rawRedirect)) {
        event.preventDefault();
      } else if (isMainFrame && this.mutedSites.has(getMuteSite(rawRedirect) || '')) {
        wc.setAudioMuted(true);
      }
    });
    wc.on('will-navigate', (event, navigationUrl) => {
      // Unified policy for renderer-initiated navigation (link clicks,
      // location.href): block schemes that direct navigation forbids.
      // Main-process loadURL sites apply the same check separately.
      if (!isAllowedNavigation(String(navigationUrl || ''))) {
        event.preventDefault();
      }
    });
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      clearLoadingTimer();
      state.isLoading = false;
      if (isMainFrame && errorCode !== -3) {
        this.networkTracker.retireDocumentRequests(id, paneId);
      }
      this.broadcastState();
      const rawUrl = String(validatedURL || '');
      // A blocked tracker still arrives here as `net::ERR_BLOCKED_BY_CLIENT`,
      // and the diagnostics filter accepts any negative code as a real failure.
      // Left alone, an isolation window would manufacture third-party network
      // warnings on the page under test and evict genuine entries from the
      // FIFO-capped bucket, so this tool filters out its own damage.
      if (rawUrl && this.devToolsHost?.isTrackerIsolationActive(id, paneId) && isTrackerBlockedUrl(rawUrl)) {
        return;
      }
      const origin = computeOrigin(rawUrl, wc.getURL());
      this.diagnosticsManager.recordFailure(id, {
        errorCode,
        errorDescription: String(errorDescription || ''),
        validatedURL: rawUrl,
        isMainFrame: Boolean(isMainFrame),
        timestamp: Date.now(),
        origin: origin.origin,
        isFirstParty: origin.isFirstParty,
      });
      if (isMainFrame && errorCode !== -3) {
        this.splitCoordinator.handleNavigationFailure(id, paneId, String(errorDescription || ''));
      }
    });

    wc.on('did-finish-load', () => {
      const currentTab = this.tabs.get(id);
      const liveUrl = wc.getURL();
      if (currentTab?.redirectChain && liveUrl && !currentTab.redirectChain.includes(liveUrl)) {
        currentTab.redirectChain.push(liveUrl);
      }
      this.appliedClipRadius.delete(wc);
      wc.session.cookies.flushStore().catch(() => {});
      this.injectAutoJsonViewer(wc);
      // The native view canvas defaults to white (the user agent's default canvas)
      // via `view.setBackgroundColor('#ffffff')`. We deliberately do NOT inject
      // synthetic CSS into the document tree — doing so breaks CSS 2.1 Appendix E
      // canvas propagation (obscuring dark mode body backgrounds on Google/Facebook
      // with a white sheet) and breaks negative z-index section backgrounds on Shopify.
      // Idempotent layout and clipping synchronization on page load
      const isMobilePane = paneId === 'mobile' || Boolean(DEVICE_PRESETS.find((p) => p.id === state.devicePresetId)?.mobile);
      if (isMobilePane) {
        wc.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
        wc.executeJavaScript(MOBILE_TOUCH_CLIENT_SCRIPT).catch(() => {});
      }
      if (paneId === 'mobile') {
        const splitMobilePreset = DEVICE_PRESETS.find((p) => p.id === state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const splitMobileClipRadius = getPresetCornerRadius(splitMobilePreset);
        this.applyDeviceCornerClipping(wc, splitMobileClipRadius, true);
      } else if (state.devicePresetId && state.devicePresetId !== 'responsive') {
        const clipRadius = getPresetCornerRadius(state.devicePresetId);
        this.applyDeviceCornerClipping(wc, clipRadius, true);
      }
      if (id === this.activeTabId) {
        const tab = this.tabs.get(id);
        if (tab && tab.view && !tab.state.ephemeral) {
          if (!this.isTabViewAttached(tab.view)) {
            try { this.attachTabView(tab.view, false); } catch {}
          }
        }
        this.updateLayout();
        if (tab?.view?.webContents && typeof tab.view.webContents.invalidate === 'function') {
          try { tab.view.webContents.invalidate(); } catch {}
        }
      }
      if (this.isRulerActive && id === this.activeTabId) {
        wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
      }
      if (this.isLensActive && id === this.activeTabId) {
        this.stopLens();
      }
      if (this.isFontFinderActive && id === this.activeTabId) {
        this.stopFontFinder();
      }
      if (this.isInspecting && id === this.activeTabId) {
        const tm = TerminalManager.getInstance();
        const tabSessionId = this.getTabTerminalSession(id);
        const termContextData: Record<string, unknown> = {
          tabId: id,
          sessions: selectAnnotationPickerRows(this.visibleTerminalSessions()),
          selectedSessionId: tm.getActiveSessionId(),
          annotationMode: TabDevToolsHost.lastAnnotationMode,
          annotationActionChip: TabDevToolsHost.lastAnnotationActionChip,
        };
        if (tabSessionId !== undefined) {
          termContextData.annotationSessionId = tabSessionId;
        }
        const termContextScript = `(() => {
          window.__antifanTerminalContext = Object.assign(window.__antifanTerminalContext || {}, ${JSON.stringify(termContextData)});
          ${tabSessionId === undefined ? 'delete window.__antifanTerminalContext.annotationSessionId;' : `window.__antifanTerminalContext.annotationSessionId = ${JSON.stringify(tabSessionId)};`}
        })();`;
        wc.executeJavaScript(`${termContextScript}\n${ELEMENT_PICKER_SCRIPT}`).catch(() => {});
      }
    });

    wc.on('devtools-closed', () => {
      if (this.isDisposed) return;
      if (id !== this.activeTabId) return;
      // Docked DevTools (`mode: 'bottom'`) on a WebContentsView kills the guest
      // compositor: pane goes black (backdrop) while Elements still shows the DOM.
      // Closing it leaves the view attached with a white unpainted canvas. F5 heals
      // via did-finish-load → updateLayout. Recycle the layer instead of reloading.
      this.reassertPresentedView();
    });

    wc.on('dom-ready', () => {
      const isMobilePane = paneId === 'mobile' || Boolean(DEVICE_PRESETS.find((p) => p.id === state.devicePresetId)?.mobile);
      if (isMobilePane) {
        wc.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
        wc.executeJavaScript(MOBILE_TOUCH_CLIENT_SCRIPT).catch(() => {});
      }
      if (paneId === 'mobile') {
        const splitMobilePreset = DEVICE_PRESETS.find((p) => p.id === state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const splitMobileClipRadius = getPresetCornerRadius(splitMobilePreset);
        this.applyDeviceCornerClipping(wc, splitMobileClipRadius, true);
      } else if (state.devicePresetId && state.devicePresetId !== 'responsive') {
        const clipRadius = getPresetCornerRadius(state.devicePresetId);
        this.applyDeviceCornerClipping(wc, clipRadius, true);
      }
      if (id === this.activeTabId) {
        this.updateLayout();
      }
    });
    wc.on('page-title-updated', (_event, title) => {
      if (paneId === 'desktop') {
        const nextTitle = title || 'Untitled';
        if (nextTitle === state.title) return;
        state.title = nextTitle;
        if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
          HistoryManager.getInstance().updateTitle(state.url, state.title);
        }
        this.scheduleTitleBroadcast();

      }
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      if (paneId === 'desktop' && favicons.length > 0 && favicons[0] !== state.favicon) {
        state.favicon = favicons[0];
        this.scheduleTitleBroadcast();
      }
    });

    wc.on('did-navigate', (_event, navUrl, httpResponseCode, httpStatusText) => {
      if (isInternalWidgetOrSubframeUrl(navUrl)) return;
      const currentUrl = wc.getURL();
      const chosenUrl = (currentUrl && currentUrl !== 'about:blank' && !isInternalWidgetOrSubframeUrl(currentUrl))
        ? currentUrl
        : navUrl;
      const cleanUrl = cleanRestoredUrl(chosenUrl);
      this.applySiteMute(wc, state, paneId, cleanUrl);

      if (typeof httpResponseCode === 'number' && httpResponseCode >= 400) {
        const origin = computeOrigin(cleanUrl, currentUrl);
        this.diagnosticsManager.recordFailure(id, {
          errorCode: httpResponseCode,
          status: httpResponseCode,
          errorDescription: `HTTP ${httpResponseCode} ${httpStatusText || 'Error'}`,
          validatedURL: cleanUrl,
          isMainFrame: true,
          timestamp: Date.now(),
          origin: origin.origin,
          isFirstParty: origin.isFirstParty,
        });
      }

      if (paneId === 'desktop') {
        state.url = cleanUrl;
        if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
          HistoryManager.getInstance().recordVisit(state.url, state.title, state.favicon);
        }
      }
      const decision = this.splitCoordinator.handleNavigationEvent(id, paneId, cleanUrl, false);
      if (decision.shouldMirror && state.splitMode) {
        const tab = this.tabs.get(id);
        const siblingView = decision.targetPane === 'mobile' ? tab?.mobileView : tab?.view;
        if (siblingView && !siblingView.webContents.isDestroyed()) {
          this.splitCoordinator.markMirrorStarted(id);
          if (decision.historyDirection === 'back') {
            this.safeGoBack(siblingView.webContents);
          } else if (decision.historyDirection === 'forward') {
            this.safeGoForward(siblingView.webContents);
          } else if (decision.mirrorUrl && isAllowedNavigation(decision.mirrorUrl)) {
            // A sibling that already presents the mirror URL must be left alone:
            // reloading it is a no-op navigation that still wipes the live DOM
            // (form values, scroll, focus). Only a different URL needs correction.
            const siblingUrl = cleanRestoredUrl(siblingView.webContents.getURL());
            if (siblingUrl !== decision.mirrorUrl) {
              siblingView.webContents.loadURL(decision.mirrorUrl).catch(() => {});
            }
          }
        }
      }
      state.canGoBack = this.getCanGoBack(wc);
      state.canGoForward = this.getCanGoForward(wc);
      this.broadcastState();
      this.schedulePersist();
      if (this.isRulerActive && id === this.activeTabId) {
        wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
      }
    });

    wc.on('did-navigate-in-page', (_event, navUrl, isMainFrame) => {
      if (isMainFrame !== false && !isInternalWidgetOrSubframeUrl(navUrl)) {
        const cleanUrl = cleanRestoredUrl(navUrl);
        if (paneId === 'desktop') {
          state.url = cleanUrl;
          if (state.url && state.url !== 'about:blank' && !state.url.startsWith('view-source:')) {
            HistoryManager.getInstance().recordVisit(state.url, state.title, state.favicon);
          }
        }

        const decision = this.splitCoordinator.handleNavigationEvent(id, paneId, cleanUrl, true);
        if (decision.shouldMirror && state.splitMode) {
          const tab = this.tabs.get(id);
          const siblingView = decision.targetPane === 'mobile' ? tab?.mobileView : tab?.view;
          if (siblingView && !siblingView.webContents.isDestroyed()) {
            this.splitCoordinator.markMirrorStarted(id);
            if (decision.historyDirection === 'back') {
              this.safeGoBack(siblingView.webContents);
            } else if (decision.historyDirection === 'forward') {
              this.safeGoForward(siblingView.webContents);
            } else if (decision.mirrorUrl && isAllowedNavigation(decision.mirrorUrl)) {
              // A sibling that already presents the mirror URL must be left alone:
              // reloading it is a no-op navigation that still wipes the live DOM
              // (form values, scroll, focus). Only a different URL needs correction.
              const siblingUrl = cleanRestoredUrl(siblingView.webContents.getURL());
              if (siblingUrl !== decision.mirrorUrl) {
                siblingView.webContents.loadURL(decision.mirrorUrl).catch(() => {});
              }
            }
          }
        }
        state.canGoBack = this.getCanGoBack(wc);
        state.canGoForward = this.getCanGoForward(wc);
        this.broadcastState();
        this.schedulePersist();
        if (this.isRulerActive && id === this.activeTabId) {
          wc.executeJavaScript(RULER_SCRIPT).catch(() => {});
        }
      }
    });

    wc.on('focus', () => {
      const tab = this.tabs.get(id);
      if (tab && state.splitMode && tab.focusedPane !== paneId) {
        tab.focusedPane = paneId;
        state.splitFocusedPane = paneId;
        this.broadcastState();
      }
    });

    wc.on('render-process-gone', () => {
      clearLoadingTimer();
      if (paneId === 'desktop') {
        state.crashed = true;
        this.broadcastState();
      } else {
        this.toggleSplitReview(id, false);
        state.splitError = 'Mobile view process exited unexpectedly';
        this.broadcastState();
      }
    });
    (wc as unknown as EventEmitter).on('close', () => {
      clearLoadingTimer();
      // A hibernation-driven destroy keeps the record (the view is rebuilt on
      // wake); only an unexpected destruction tears the whole tab down.
      if (paneId === 'desktop' && !this.isDisposed && this.tabs.has(id) && !this.hibernatingTabIds.has(id)) {
        this.closeTab(id, 'view-close');
      }
    });

    wc.on('destroyed', () => {
      clearLoadingTimer();
      if (paneId === 'desktop' && !this.isDisposed && this.tabs.has(id) && !this.hibernatingTabIds.has(id)) {
        this.closeTab(id, 'view-destroyed');
      }
    });

    wc.on('found-in-page', (_event, result) => {
      safeSendWebContents(this.shell.toolbarView?.webContents, TOOLBAR_CHANNELS.FIND_RESULT, result);
    });

    wc.setWindowOpenHandler((details) => {
      return OAuthPopupManager.getInstance().handleWindowOpen(
        wc,
        this.shell.window,
        details,
        {
          onNewTabRequested: (url: string) => {
            if (isAllowedNavigation(url)) {
              // Chromium answers a page's window.open synchronously and the requesting page
              // is blocked inside that call until this handler returns, so the tab is not
              // built here: creating and activating one attaches WebContentsViews and
              // touches the compositor, and doing that under the renderer's own window-open
              // reply was observed deadlocking the two — window.open simply never returned
              // and the whole run stalled. Deferring keeps the reply immediate and the tab
              // arrives one turn later, which is what every caller of window.open sees
              // anyway: this path denies the native window, so the page's window.open is
              // `null` whatever happens to the tab.
              const parentTabId = id;
              // Read the opener's session identity now, not inside the deferred callback: the
              // source of a window.open is the tab that asked for it, and this tab can be gone
              // (or its capsule state already torn down) by the time the creation actually runs.
              // The capsule alone is not the identity: a popup placed in a different partition
              // reads a cookie jar the opener cannot see, and one with a different user agent
              // mode presents a different browser than the page that opened it, so the child
              // inherits all three from the opener.
              const parentState = this.tabs.get(parentTabId)?.state;
              // The child keeps the opener's project: a popup a project's page opens
              // belongs to that project even if the hub has since switched, and a
              // shared opener mints a shared child (explicit null, never the ambient
              // project). An unresolvable opener falls back to the mint-time rule.
              const parentTabRecord = this.tabs.get(parentTabId);
              const parentProjectId: string | null | undefined = parentTabRecord ? (parentTabRecord.projectId ?? null) : undefined;
              const parentCapsuleId = this.getTabCapsuleId(parentTabId);
              const parentPartition = parentState && typeof parentState.partition === 'string' && parentState.partition ? parentState.partition : undefined;
              const parentUserAgentMode = parentState?.userAgentMode;
              setImmediate(() => {
                if (this.isDisposed) return;
                // The request is deferred, so the opener can be closed in the meantime. A popup
                // whose parent died is not created at all: adopting into a gone parent would
                // leave a tab in this window that no opener and no pool owns.
                if (!this.hasExactTab(parentTabId)) return;
                const newTabId = this.createTab(url, true, {
                  ...(parentCapsuleId ? { capsuleId: parentCapsuleId } : {}),
                  ...(parentPartition ? { partition: parentPartition } : {}),
                  ...(parentUserAgentMode ? { userAgentMode: parentUserAgentMode } : {}),
                  ...(parentProjectId !== undefined ? { projectId: parentProjectId } : {}),
                });
                // Adoption failure cleans up only the child this call created and never
                // retargets its parent, so an unowned child is closed instead of orphaned.
                if (newTabId && !this.adoptChildTab(parentTabId, newTabId, undefined, 'native_window_open', parentTabId)) {
                  this.closeTab(newTabId, 'agent-open-adopt-failed');
                }
              });
            }
          }
        }
      );
    });

    wc.on('zoom-changed', (_event, zoomDirection) => {
      const current = state.zoomFactor || 1.0;
      const step = 0.1;
      const nextZoom = zoomDirection === 'in'
        ? Math.min(5.0, Number((current + step).toFixed(2)))
        : Math.max(0.25, Number((current - step).toFixed(2)));
      this.setZoom(id, nextZoom);
    });

    this.setupGlobalShortcutsOnView(wc, id);
    this.setupContextMenu(wc, paneId);
    this.trackUserActivityOnView(wc);
  }

  public createTab(
    initialUrl = 'https://www.google.com',
    activate = true,
    options?: {
      capsuleId?: string;
      userAgentMode?: BrowserSessionUserAgentMode;
      ephemeral?: boolean;
      isolateSession?: boolean;
      partition?: string;
      /** Explicit terminal session that should own this tab. Omit for user-opened tabs. */
      terminalSessionId?: string;
      devicePresetId?: string;
      mobile?: boolean;
      /** Which plane the activation rides when `activate` is set; agent callers declare 'agent'. */
      plane?: SwitchPlane;
      /**
       * The project stamp the web hub mints the tab under. `undefined` resolves to the
       * ambient `activeProjectId`; explicit `null` mints a shared tab; a string stamps
       * that project (the window.open opener-inheritance path). Strip tabs only —
       * ephemeral records are never stamped.
       */
      projectId?: string | null;
    }
  ): string {
    if (this.isDisposed) return '';
    const trimmed = (initialUrl || '').trim();
    if (trimmed && (trimmed.startsWith('file://') || /^[a-zA-Z]:[/\\]/.test(trimmed))) {
      const previewTabId = this.createPreviewTab(trimmed);
      if (previewTabId) return previewTabId;
    }

    const id = randomUUID();
    let capsuleIdForTab: string | undefined = options?.capsuleId;
    let url = initialUrl;

    if (initialUrl.startsWith('antifan-preview://')) {
      try {
        const { capsuleId, relativePath } = parsePreviewUrl(initialUrl);
        const allCapsules = this.capsuleManager.list();
        const cap = allCapsules.find((c) => c.id.toLowerCase() === capsuleId.toLowerCase());
        if (!cap || !cap.workspacePath || !fs.existsSync(cap.workspacePath)) {
          console.warn(`[native-tab-host] Workspace capsule not found: ${capsuleId}`);
          return '';
        }
        const canonicalRoot = fs.realpathSync.native(path.resolve(cap.workspacePath));
        const resolvedPath = path.resolve(canonicalRoot, relativePath);
        const rel = path.relative(canonicalRoot, resolvedPath);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          console.warn(`[native-tab-host] Preview path escapes workspace root: ${relativePath}`);
          return '';
        }
        capsuleIdForTab = cap.id;
        url = initialUrl;
      } catch (err) {
        console.warn(`[native-tab-host] Failed to parse preview url: ${initialUrl}`, err);
        return '';
      }
    } else {
      const cleanInitialUrl = cleanRestoredUrl(initialUrl);
      url = sanitizeUrl(cleanInitialUrl);
    }

    if (!capsuleIdForTab) {
      // The window's own verified workspace before the process-wide selection: a tab opened in
      // this window belongs to this window, and the active capsule can belong to another one.
      capsuleIdForTab = resolveNewTabCapsuleId({
        windowWorkspaceCapsuleId: this.windowWorkspaceAffiliation?.capsuleId,
        activeCapsuleId: this.capsuleManager.getActive()?.id,
      });
    }

    const userAgentMode: BrowserSessionUserAgentMode = options?.userAgentMode || 'clean';
    const isEphemeral = Boolean(options?.ephemeral);
    let partition: string;
    if (options?.partition && typeof options.partition === 'string') {
      partition = options.partition.trim();
    } else if (options?.isolateSession) {
      partition = deriveCapsulePartition(capsuleIdForTab, userAgentMode, isEphemeral);
    } else {
      partition = this.getSharedProfilePartition(userAgentMode, isEphemeral);
    }
    configureBrowserSessionPartition(partition, userAgentMode);
    const view = new WebContentsView({
      webPreferences: getSecureWebPreferences(partition),
    });
    // The view's own background is the canvas for whatever the page leaves unpainted, so
    // it is the only thing that keeps captures opaque: measured with Electron 43, a
    // transparent-canvas page captured through `capturePage()` and CDP
    // `Page.captureScreenshot` returns `rgba(0,0,0,0)` while this background is
    // transparent, and opaque white once it is `#ffffff`. CDP's
    // `Emulation.setDefaultBackgroundColorOverride` did NOT change either capture's
    // pixels (measured across reload, `Page.enable`, `invalidate`, and
    // `captureBeyondViewport` on/off), so opacity must not be delegated to it.
    try { view.setBackgroundColor('#ffffff'); } catch {}
    const isBlankUrl = !url || url === 'about:blank';
    const rawPresetId = options?.devicePresetId || (options?.mobile ? 'iphone-15' : undefined);
    const initialPreset = findDevicePreset(rawPresetId);
    const initialDevicePresetId = initialPreset?.id || (options?.mobile ? 'iphone-15' : 'responsive');
    const state: AntiFanTab = {
      id,
      url,
      title: 'New Tab',
      isLoading: !isBlankUrl,
      canGoBack: false,
      canGoForward: false,
      zoomFactor: 1.0,
      devicePresetId: initialDevicePresetId,
      crashed: false,
      capsuleId: capsuleIdForTab,
      userAgentMode,
      partition,
      ephemeral: isEphemeral,
    };
    this.setupTabWebContentsEvents(id, view, state, 'desktop');

    const effectivePreset = initialPreset || (options?.mobile ? findDevicePreset('iphone-15') : undefined);

    const tabEntry: NativeTabRecord = { view, state, focusedPane: 'desktop', lastActiveAt: Date.now() };
    // Mint-time stamp, strip tabs only: the 'web' hub stamps its active project, a
    // detached `project:<id>` window stamps the project that owns it (the host's owner
    // key is the project's identity there — the window has no "active project" field
    // to read). Other shells and ephemeral agent surfaces stamp nothing.
    // An explicit request (window.open's opener) wins; `null` mints a shared tab on
    // purpose. See `stampProjectIdForMint` — keep the rule in the one method the host
    // and the tests share.
    const mintStamp = this.stampProjectIdForMint(options?.projectId, isEphemeral);
    if (mintStamp) tabEntry.projectId = mintStamp;
    if (effectivePreset) {
      tabEntry.customViewport = {
        width: effectivePreset.width || 390,
        height: effectivePreset.height || 844,
        mobile: Boolean(effectivePreset.mobile),
        deviceScaleFactor: effectivePreset.deviceScaleFactor || 3,
      };
    }
    this.tabs.set(id, tabEntry);
    this.indexTabWebContents(id, tabEntry);
    const isAgentTab = isEphemeral;
    if (!isAgentTab) {
      this.tabOrder.push(id);
      // Only adopt a newly created tab into a terminal session when the caller explicitly
      // requests it. User-opened tabs (toolbar '+', Ctrl+T, context menu, URL bar) must stay
      // independent instead of being silently appended to whichever terminal is active.
      const requestedTerminalSessionId = options?.terminalSessionId;
      if (requestedTerminalSessionId) {
        state.terminalSessionId = requestedTerminalSessionId;
        let pool = this.sessionTabPools.get(requestedTerminalSessionId);
        if (!pool) {
          pool = new Set();
          this.sessionTabPools.set(requestedTerminalSessionId, pool);
        }
        pool.add(id);
        try {
          const session = TerminalManager.getInstance().getSession(requestedTerminalSessionId);
          if (session) {
            this.adoptChildTab(requestedTerminalSessionId, id, session.sessionGeneration);
          }
        } catch {}
      }
    }

    if (capsuleIdForTab && url.startsWith('antifan-preview://')) {
      const cap = this.capsuleManager.list().find((c) => c.id.toLowerCase() === capsuleIdForTab!.toLowerCase());
      if (cap && cap.workspacePath && fs.existsSync(cap.workspacePath)) {
        const unsub = this.previewWatcherPool.retain(cap.id, cap.workspacePath, (event) => {
          this.dispatchScopedReload(cap.id, event);
        });
        this.tabPreviewUnsubscribers.set(id, unsub);
      }
    }
    const wc = view.webContents;
    if (url.startsWith('view-source:')) {
      const sourceTargetUrl = url.slice('view-source:'.length).trim();
      state.title = `view-source:${sourceTargetUrl}`;
      state.url = url;
      this.fetchAndLoadPageSource(wc, sourceTargetUrl, state);
    } else if (url !== 'about:blank') {
      if (!isAllowedNavigation(url)) return '';
      let initialUa: string | undefined;
      if (effectivePreset) {
        const fallbackUa = effectivePreset.mobile ? IPHONE_USER_AGENT : this.defaultUserAgent;
        initialUa = getPresetUserAgent(effectivePreset, fallbackUa) || fallbackUa;
        this.setSafeUserAgent(wc, initialUa);
        this.applyCdpTouchEmulation(wc, Boolean(effectivePreset.mobile));
        this.applyCdpDeviceEmulationState(wc, effectivePreset);
      }
      wc.loadURL(url, initialUa ? { userAgent: initialUa } : undefined)
        .then(() => this.clearInitialNavigationHistory(wc, state))
        .catch((err: unknown) => {
          if (err && typeof err === 'object' && ('code' in err || 'errno' in err)) {
            const code = 'code' in err ? String(err.code) : '';
            const errno = 'errno' in err ? Number(err.errno) : 0;
            if (code === 'ERR_ABORTED' || errno === -3 || code === 'ERR_FAILED' || errno === -2) {
              state.isLoading = false;
              this.broadcastState();
              return;
            }
          }
          console.warn(`[native-tab-host] Failed to load initial url ${url} on tab ${id}:`, err);
          state.isLoading = false;
          this.broadcastState();
        });
    } else {
      state.isLoading = false;
    }
    if (activate && !isAgentTab) {
      // A tab opened on explicit user intent (the + button, Ctrl+T, a window.open
      // the user clicked) may take focus; an agent caller declares 'agent' and
      // rides the deferral gate like every other agent-plane activation.
      this.switchTab(id, { plane: options?.plane === 'agent' ? 'agent' : 'user' });
    } else {
      // Background tabs start throttled (`webPreferences.backgroundThrottling` defaults to true);
      // toggling it again on a view outside the window would un-hide its host.
      this.updateLayout();
      this.broadcastState();
    }
    this.schedulePersist();
    recordBenchmark({ surface: 'tabs', name: 'created', extra: { activate, url: url.slice(0, 80) } });
    return id;
  }

  /**
   * Boolean switch kept for callers that never asked why a switch did not happen.
   * Everything runs through `trySwitchTab` on the agent plane: an agent switch
   * never takes DOM focus and defers to user input the window saw moments ago.
   */
  public switchTab(tabId: string, opts?: SwitchTabOptions): boolean {
    return this.trySwitchTab(tabId, opts).ok;
  }

  /**
   * The typed activation entrypoint. A refusal is reported, never silent:
   * `TARGET_MISSING` for a tab that does not exist, `TARGET_NOT_ACTIVATABLE` for
   * ephemeral tabs, and `ACTIVATION_DEFERRED_USER_INPUT` when an
   * agent-plane switch would move the presented pane while the user typed
   * inside the recency window — the caller retries after `retryAfterMs`
   * instead of competing. `activeTabId` is untouched on every refusal; only
   * `TARGET_NOT_ACTIVATABLE` re-asserts the presented view, because an earlier
   * transaction may have taken it away and the window must not be left empty.
   */
  public trySwitchTab(tabId: string, opts?: SwitchTabOptions): SwitchTabResult {
    const plane: SwitchPlane = opts?.plane === 'user' ? 'user' : 'agent';
    if (this.isDisposed) return { ok: false, tabId, reason: 'TARGET_MISSING' };
    try {
      const targetId = this.resolveTargetTabId(tabId) || tabId;
      const target = this.tabs.get(targetId);
      // TARGET_MISSING attaches nothing, focuses nothing and touches no view —
      // there is nothing to restore, so it answers without reasserting.
      if (!target) return { ok: false, tabId: targetId, reason: 'TARGET_MISSING' };
      if (target.state.ephemeral === true) {
        // Refusing to present a pane must not also leave the window with no
        // view at all when an earlier transaction took the presented one away.
        this.reassertPresentedView();
        return { ok: false, tabId: targetId, reason: 'TARGET_NOT_ACTIVATABLE', retryAfterMs: undefined };
      }
      // The web hub presents exactly one project at a time: an agent-plane switch
      // on a tab stamped for another project would silently re-scope the window,
      // so it is refused outright — background operations on that tab never pass
      // through here and stay allowed. Shared tabs carry no stamp and activate
      // under any project. The user plane alone may cross, and reports the flip
      // to Main only after the switch below has succeeded.
      const targetProject = typeof target.projectId === 'string' && target.projectId ? target.projectId : null;
      if (
        plane === 'agent'
        && targetId !== this.activeTabId
        && this.windowOwnerKey() === WEB_OWNER_KEY
        && targetProject !== null
        && targetProject !== this.activeProjectId
      ) {
        this.reassertPresentedView();
        return { ok: false, tabId: targetId, reason: 'PROJECT_MISMATCH' };
      }
      if (plane === 'agent' && this.userInputRecentlySeen() && targetId !== this.activeTabId) {
        const retryAfterMs = Math.max(1, USER_INPUT_RECENCY_MS - (Date.now() - this.lastUserInputAtMs));
        recordLifecycleEvent('tabhost.agentSwitchDeferred', { tabId: targetId, retryAfterMs });
        return { ok: false, tabId: targetId, reason: 'ACTIVATION_DEFERRED_USER_INPUT', retryAfterMs };
      }
      const switchStartMs = performance.now();
      // Per-step timings for this switch (see markSwitchStep). The aggregate `switched`
      // benchmark says a switch got slower but never which step paid for it, and the
      // bucket exists only while benchmarks are on.
      const stepBucket = isBenchmarkEnabled() ? ({} as Record<string, number>) : null;
      let stepMark = switchStartMs;

      // Guard against a hibernated record (view destroyed by the sweep), a
      // destroyed WebContents/WebContentsView, or a crashed renderer. The hibernated
      // case funnels through the same recreate path — the only difference is the
      // destroy was deliberate, so the strip already knows the tab is asleep.
      const isHibernated = target.state.hibernated === true;
      const isTargetDestroyed = isHibernated || !target.view || !target.view.webContents || target.view.webContents.isDestroyed();
      const isTargetCrashed = !isTargetDestroyed && (target.state.crashed === true || (typeof target.view!.webContents.isCrashed === 'function' && target.view!.webContents.isCrashed()));
      if (isTargetDestroyed || isTargetCrashed) {
        if (isHibernated) {
          this.ensureTabAwake(targetId);
        } else {
          console.warn(`[native-tab-host] Target tab ${targetId} webContents is ${isTargetCrashed ? 'crashed' : 'destroyed'}; recreating view`);
          this.recreateDesktopView(targetId, target);
          const isBlank = !target.state.url || target.state.url === 'about:blank';
          target.state.isLoading = !isBlank;
          if (!isBlank && isAllowedNavigation(target.state.url)) {
            target.view!.webContents.loadURL(target.state.url).catch((err: unknown) => {
              if (err && typeof err === 'object' && ('code' in err || 'errno' in err)) {
                const code = 'code' in err ? String(err.code) : '';
                const errno = 'errno' in err ? Number(err.errno) : 0;
                if (code === 'ERR_ABORTED' || errno === -3) {
                  return;
                }
              }
              target.state.isLoading = false;
              this.broadcastState();
            });
          }
        }
      } else if (!target.state.url || target.state.url === 'about:blank') {
        target.state.isLoading = false;
      } else if (
        target.view &&
        target.state.url &&
        target.state.url !== 'about:blank' &&
        typeof target.view.webContents.getURL === 'function'
      ) {
        const currentUrl = target.view.webContents.getURL();
        if (!currentUrl || currentUrl === 'about:blank') {
          target.state.isLoading = true;
          if (isAllowedNavigation(target.state.url)) {
            target.view.webContents.loadURL(target.state.url).catch((err: unknown) => {
              if (err && typeof err === 'object' && ('code' in err || 'errno' in err)) {
                const code = 'code' in err ? String(err.code) : '';
                const errno = 'errno' in err ? Number(err.errno) : 0;
                if (code === 'ERR_ABORTED' || errno === -3) {
                  return;
                }
              }
              target.state.isLoading = false;
              this.broadcastState();
            });
          }
        }
      }

      const previousTabId = this.activeTabId;
      const previousTab = previousTabId ? this.tabs.get(previousTabId) : null;
      if (previousTabId !== targetId && this.isLensActive) {
        this.stopLens();
      }
      if (previousTab && previousTabId !== targetId && this.isFontFinderActive) {
        if (previousTab.view && !previousTab.view.webContents.isDestroyed()) {
          previousTab.view.webContents.executeJavaScript(FONT_FINDER_CLEANUP_SCRIPT).catch(() => {});
        }
        if (previousTab.mobileView && !previousTab.mobileView.webContents.isDestroyed()) {
          previousTab.mobileView.webContents.executeJavaScript(FONT_FINDER_CLEANUP_SCRIPT).catch(() => {});
        }
      }

      stepMark = markSwitchStep(stepBucket, 'ensureView', stepMark);

      this.activeTabId = targetId;
      // Idle clock resets on activation AND on user input (the input listener
      // in setupTabWebContentsEvents does the other half), so the sweep measures
      // from the last time this tab was genuinely seen or touched.
      target.lastActiveAt = Date.now();

      // Whether these views were presented before this switch touched them. An already attached
      // view may be occluded or held by a capture, so the re-assert below still drops and re-adds
      // it to force a new DirectComposition visual; a view this switch is about to attach has that
      // visual by construction, and re-creating it was the single most expensive step of a switch.
      const presentedWasAttached = this.isTabViewAttached(target.view);
      const presentedMobileWasAttached = this.isTabViewAttached(target.mobileView);

      // Safely attach target active tab views FIRST before detaching old views
      // to maintain a continuous valid view hierarchy and avoid focus access violations
      this.attachTabView(target.view, false);
      if (target.state.splitMode && target.mobileView && !target.mobileView.webContents.isDestroyed()) {
        this.attachTabView(target.mobileView, true);
      }

      // Defensively ensure no other inactive tab views remain attached
      if (this.shell.window && !this.shell.window.isDestroyed() && this.shell.window.contentView) {
        for (const [id, tab] of this.tabs.entries()) {
          if (id !== targetId) {
            // A view an in-flight attach-for-capture call is holding stays put: detaching
            // it here breaks that caller's measurement, and its release then decides the
            // visible stack from a picture of it that is already stale.
            // Throttle before detaching: the hide then really hides the host, so the page
            // reports hidden and nothing un-hides it from outside the window afterwards.
            const allowed = this.backgroundThrottlingFor(id, tab);
            if (tab.view && !this.isTemporarilyAttachedView(tab.view) && this.shell.window.contentView.children.includes(tab.view)) {
              this.setWebContentsThrottling(this.liveViewContents(tab.view), allowed);
              try { this.shell.window.contentView.removeChildView(tab.view); } catch {}
            }
            if (tab.mobileView && !this.isTemporarilyAttachedView(tab.mobileView) && this.shell.window.contentView.children.includes(tab.mobileView)) {
              this.setWebContentsThrottling(this.liveViewContents(tab.mobileView), allowed);
              try { this.shell.window.contentView.removeChildView(tab.mobileView); } catch {}
            }
          }
        }
        // Orphan sweep: a view that no tab record owns any more — a tab whose view was
        // replaced, or an entry dropped from `this.tabs` — stays in contentView.children
        // forever and keeps its renderer alive. Walk the real child list instead of
        // `this.tabs`. Detach rather than destroy: a view this code cannot attribute
        // could still belong to a shell surface added elsewhere, and detaching is the
        // reversible half that also makes the leak countable.
        const ownedViews = new Set<unknown>();
        for (const ownedTab of this.tabs.values()) {
          if (ownedTab.view) ownedViews.add(ownedTab.view);
          if (ownedTab.mobileView) ownedViews.add(ownedTab.mobileView);
        }
        for (const shellView of [this.shell.toolbarView, this.shell.sidebarView, this.shell.frameBackdropView]) {
          if (shellView) ownedViews.add(shellView);
        }
        let orphanViewCount = 0;
        for (const child of Array.from(this.shell.window.contentView.children)) {
          if (ownedViews.has(child)) continue;
          orphanViewCount += 1;
          try { this.shell.window.contentView.removeChildView(child); } catch {}
        }
        if (orphanViewCount > 0) {
          console.warn(`[native-tab-host] Detached ${orphanViewCount} view(s) that no tab or shell surface owns`);
          recordLifecycleEvent('tabhost.orphanViewsDetached', { count: orphanViewCount, activeTabId: targetId });
        }

        // Assert target view is attached after inactive clean-up
        if (target.view && !this.isTabViewAttached(target.view)) {
          try { this.shell.window.contentView.addChildView(target.view); } catch {}
        }
      }

      stepMark = markSwitchStep(stepBucket, 'attachSweep', stepMark);

      this.updateLayout();
      this.broadcastState();
      stepMark = markSwitchStep(stepBucket, 'layoutBroadcast', stepMark);

      const targetWc = target.view?.webContents;
      if (this.isRulerActive && targetWc && !targetWc.isDestroyed()) {
        targetWc.executeJavaScript(RULER_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
        }
      }
      if (this.isFontFinderActive && targetWc && !targetWc.isDestroyed()) {
        targetWc.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
        }
      }
      this.applyTabThrottling();
      stepMark = markSwitchStep(stepBucket, 'throttle', stepMark);
      if (targetWc && !targetWc.isDestroyed()) {
        try { targetWc.invalidate(); } catch {}
        if (plane === 'user') {
          // The user plane is the only plane that may take DOM focus — the
          // agent plane presents the pane but the user's focus stays put.
          try { targetWc.focus(); } catch {}
        }
      }
      if (target.mobileView?.webContents && !target.mobileView.webContents.isDestroyed()) {
        try { target.mobileView.webContents.invalidate(); } catch {}
      }
      stepMark = markSwitchStep(stepBucket, 'invalidateFocus', stepMark);
      this.reassertPresentedView({ recyclePresentedLayer: presentedWasAttached, recycleMobileLayer: presentedMobileWasAttached });
      stepMark = markSwitchStep(stepBucket, 'presentedView', stepMark);
      if (isBenchmarkEnabled()) {
        recordBenchmark({ surface: 'tabs', name: 'switched', value: performance.now() - switchStartMs, extra: { attachedViews: this.countAttachedViews() } });
        if (stepBucket) {
          recordBenchmark({ surface: 'tabs', name: 'switch-steps', value: Number((performance.now() - switchStartMs).toFixed(3)), extra: stepBucket });
        }
      }
      // The presented pane is committed here: the map note and a possible foreign-project
      // handoff run only after the view stack, layout and focus settled, so a failure
      // earlier can still roll back to the previous tab through the catch below without
      // leaving project state pointing at a tab it never showed.
      this.notePresentedTabProject(targetId, target);
      if (
        plane === 'user'
        && this.windowOwnerKey() === WEB_OWNER_KEY
        && targetProject !== null
        && targetProject !== this.activeProjectId
        && !this.foreignFlipSuppressed
        && this.hasRestoredTabs
      ) {
        // Main owns `activeProjectId`; the host emits the flip and Main runs the same
        // activateWebHubProject path a project pick would, so affiliation, identity and
        // the broadcast change together. The call is synchronous but guarded: a delegate
        // failure must not roll back a switch the user already sees.
        try {
          this.foreignProjectActivatedHandler?.(targetProject);
        } catch (err) {
          console.warn('[native-tab-host] foreign project activation handler failed:', err);
        }
      }
      return { ok: true, tabId: targetId };
    } catch (err) {
      console.error('[native-tab-host] switchTab unexpected error:', err);
      try {
        if (plane === 'user' && this.activeTabId && this.tabs.has(this.activeTabId)) {
          const fallbackTab = this.tabs.get(this.activeTabId);
          if (fallbackTab?.view && !fallbackTab.state.ephemeral) {
            this.attachTabView(fallbackTab.view, false);
          }
        }
        this.updateLayout();
        this.broadcastState();
      } catch {}
      // A switch that failed still owes the window a presented view: whatever is active
      // now beats an empty pane.
      try { this.reassertPresentedView(); } catch {}
      return { ok: false, tabId: this.resolveTargetTabId(tabId) || tabId, reason: 'TARGET_NOT_ACTIVATABLE' };
    }
  }
  public applyTabThrottling(): void {
    if (this.isDisposed) return;
    for (const [id, tab] of this.tabs.entries()) {
      // Both panes are probed through the tolerant accessor: a view whose native object is gone
      // cannot be throttled, and asking it anyway would throw out of the clear/teardown step
      // that called this pass.
      const allowed = this.backgroundThrottlingFor(id, tab);
      this.setWebContentsThrottling(this.liveViewContents(tab.view), allowed);
      this.setWebContentsThrottling(this.liveViewContents(tab.mobileView), allowed);
    }
  }

  /**
   * Whether Chromium may throttle a tab's panes. Only the presented tab and a tab
   * an agent is operating on (RT-02 in-flight exemption) run unthrottled; once the agent goes
   * idle the tab is throttled again to conserve CPU/RAM.
   */
  private backgroundThrottlingFor(id: string, tab: NativeTabRecord): boolean {
    const isAgentWorking = tab.state.aiState === 'agent_working' || (this.automationHost?.agentWorkingRefs.get(id) || 0) > 0;
    return id !== this.activeTabId && !isAgentWorking;
  }

  private readBackgroundThrottling(wc: Electron.WebContents): boolean | undefined {
    try {
      if (typeof wc.getBackgroundThrottling === 'function') return wc.getBackgroundThrottling();
      if (typeof wc.backgroundThrottling === 'boolean') return wc.backgroundThrottling;
    } catch {}
    return undefined;
  }

  /**
   * `setBackgroundThrottling()` un-hides a hidden RenderWidgetHost whatever value it is given,
   * and the host of a view outside the window is hidden. Electron 43.4.0 did it through
   * `RenderWidgetHostImpl::WasShown()`, desyncing the host from its view: once re-attached, the
   * pane's frame stayed evictable and the tab went white/black while the page kept running
   * (electron#52844). Later builds un-hide as hidden-but-painting, so a background tab handed a
   * redundant `true` starts painting. Only a real change reaches Electron, and callers throttle
   * a view before taking it out of the window rather than after.
   */
  private setWebContentsThrottling(wc: Electron.WebContents | null | undefined, allowed: boolean): void {
    if (!wc || typeof wc.setBackgroundThrottling !== 'function') return;
    try {
      if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return;
      if (this.readBackgroundThrottling(wc) === allowed) return;
      wc.setBackgroundThrottling(allowed);
    } catch {}
  }


  private activateAgentVisualGlow(tabId: string): void {
    this.getAutomationHost().activateAgentVisualGlow(tabId);
  }

  private deactivateAgentVisualGlow(tabId: string): void {
    this.getAutomationHost().deactivateAgentVisualGlow(tabId);
  }

  private beginTabAgentWorking(tabId: string): void {
    this.getAutomationHost().beginTabAgentWorking(tabId);
  }

  private clearTabAgentWorking(tabId: string): void {
    this.getAutomationHost().clearTabAgentWorking(tabId);
  }

  private endTabAgentWorking(tabId: string): void {
    this.getAutomationHost().endTabAgentWorking(tabId);
  }

  private async withTabAgentWorking<T>(tabId: string, action: () => Promise<T>): Promise<T> {
    return this.getAutomationHost().withTabAgentWorking(tabId, action);
  }

  public markTabAgentWorking(tabId?: string, durationMs = 5000): void {
    this.getAutomationHost().markTabAgentWorking(tabId, durationMs);
  }
  public setTabAiState(tabId: string, aiState: 'idle' | 'thinking' | 'streaming' | 'completed' | 'agent_working'): void {
    this.getAutomationHost().setTabAiState(tabId, aiState);
  }
  public setTabThemeError(tabId: string, themeError?: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.state.themeError = themeError;
    this.broadcastState();
  }
  public setTabScrollPosition(tabId: string, scrollX: number, scrollY: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.state.scrollX = scrollX;
    tab.state.scrollY = scrollY;
  }
  public clearAllAgentWorking(): void {
    this.getAutomationHost().clearAllAgentWorking();
  }

  public closeTab(tabId: string, source?: string): boolean {
    if (this.isDisposed) return false;
    const targetId = this.resolveTargetTabId(tabId) || tabId;
    const target = this.tabs.get(targetId);
    if (!target) return false;
    tabId = targetId;
    // A page inside an authorized close attempt belongs to that attempt: destroying it
    // here would race the attempt's own unload observers and could leave the shell
    // reporting a page it still believes it owns. The attempt's own closePage() is the
    // one caller allowed through, because it is the caller that took the reservation.
    const reservedForClose = this.isPageReservedForClose(tabId);
    // Optional like every other field this method reads: test harnesses build a host
    // without running field initializers, and a cleanup path must not throw there.
    const authorizedByAttempt = Boolean(this.attemptAuthorizedCloses?.has(tabId));
    if (reservedForClose && !authorizedByAttempt) return false;
    // ViewportGate per-tab lock cleanup (Phase 2 contract): ensures lock/poison state is scoped by target and cleaned up on tab destruction via this.viewportGate?.cleanupTab(tabId). Note for P5 owner: full distributed target lock release verified here.
    this.viewportGate?.cleanupTab(tabId);
    this.semanticRefRegistry?.invalidateTab(tabId);
    if (this.semanticDocumentGenerations) {
      const prefix = `${String(tabId).trim()}:`;
      for (const key of Array.from(this.semanticDocumentGenerations.keys())) {
        if (key.startsWith(prefix)) this.semanticDocumentGenerations.delete(key);
      }
    }
    if (this.targetOperationQueues) {
      const prefix = `${String(tabId).trim()}:`;
      for (const key of Array.from(this.targetOperationQueues.keys())) {
        if (key.startsWith(prefix)) this.targetOperationQueues.delete(key);
      }
    }
    // Guarded by its OWN field, like the queue map above. A partially constructed host
    // (several tests build one without running field initializers) defines
    // targetOperationQueues but not this map, and reading .keys() off undefined turned
    // tab cleanup into a TypeError instead of a cleanup.
    if (this.targetOperationOwners) {
      const prefix = `${String(tabId).trim()}:`;
      for (const key of Array.from(this.targetOperationOwners.keys())) {
        if (key.startsWith(prefix)) this.targetOperationOwners.delete(key);
      }
    }
    this.clearTabAgentWorking(tabId);
    // Guarded like targetOperationOwners above: partially constructed hosts
    // (Object.create without field initializers) may lack this map.
    this.ownedReloadTokens?.delete(tabId);
    const isAgent = target.state.ephemeral === true;
    if (!isAgent && target.state.url && target.state.url !== 'about:blank') {
      this.recentlyClosedTabs.push({ url: target.state.url, title: target.state.title || 'Tab' });
      if (this.recentlyClosedTabs.length > 20) this.recentlyClosedTabs.shift();
    }

    const unsub = this.tabPreviewUnsubscribers.get(tabId);
    if (unsub) {
      try { unsub(); } catch {}
      this.tabPreviewUnsubscribers.delete(tabId);
    }
    this.networkTracker?.detachTarget(tabId, 'desktop');
    this.networkTracker?.detachTarget(tabId, 'mobile');
    this.tabThemeQaStates?.delete(tabId);
    this.documentGenerations?.delete(tabId);
    if (this.automationTabId === tabId) {
      this.automationTabId = null;
    }
    this.tombstoneTerminalAgentAffinity(tabId, target.state.url);
    if (this.sessionTabPools) {
      for (const [sId, pool] of Array.from(this.sessionTabPools.entries())) {
        if (sId !== tabId && pool.has(tabId)) {
          // Guarded like the maps above: partial hosts may lack closedTabAnchors.
          if (this.closedTabAnchors) {
            this.closedTabAnchors.delete(tabId);
            this.closedTabAnchors.set(tabId, sId);
            while (this.closedTabAnchors.size > 64) {
              const oldest = this.closedTabAnchors.keys().next().value as string | undefined;
              if (oldest === undefined) break;
              this.closedTabAnchors.delete(oldest);
            }
          }
        }
        pool.delete(tabId);
        if (pool.size === 0) {
          this.sessionTabPools.delete(sId);
        }
      }
      this.sessionTabPools.delete(tabId);
    }
    if (target.state.partition) {
      unconfigureBrowserSessionPartition(target.state.partition);
    }
    if (this.isInspecting && this.inspectedTabId === tabId) {
      this.stopInspect(tabId);
    }
    if (this.isLensActive && this.activeTabId === tabId) {
      this.stopLens();
    }
    if (this.isFontFinderActive && this.activeTabId === tabId) {
      this.stopFontFinder();
    }
    if (this.activeTabId === tabId) {
      try {
        if (target.view) this.shell.window.contentView.removeChildView(target.view);
      } catch {}
      if (target.mobileView) {
        try {
          this.shell.window.contentView.removeChildView(target.mobileView);
        } catch {}
      }
    }
    try {
      this.destroyOwnedWebContents(target.view?.webContents);
    } catch {}
    if (target.mobileView) {
      try {
        this.destroyOwnedWebContents(target.mobileView.webContents);
      } catch {}
    }
    this.splitCoordinator?.cleanupTab(tabId);
    this.unindexTabWebContents(target);
    this.tabs.delete(tabId);
    this.recordTabClosedTelemetry(tabId, target, source ?? (authorizedByAttempt ? 'close-attempt' : 'unspecified'));
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId);
    // The last-active map is memory, not authority, but a dead entry would send a
    // project switch looking for a tab that no longer exists; the candidate read
    // tolerates it, pruning here just keeps the map honest and bounded.
    if (this.lastActiveTabByProject) {
      for (const [project, rememberedId] of Array.from(this.lastActiveTabByProject.entries())) {
        if (rememberedId === tabId) this.lastActiveTabByProject.delete(project);
      }
    }

    if (this.activeTabId === tabId) {
      // The web hub holds every project's tabs; the strip shows only the presented
      // project's (plus unstamped shared ones). A failover to a foreign-stamped tab
      // would fire the user-plane project flip, so a close never leaves the project.
      const scopedProject = this.windowOwnerKey() === WEB_OWNER_KEY ? this.activeProjectId : null;
      const userTabs = this.tabOrder.filter((id) => {
        const t = this.tabs.get(id);
        if (!t || t.state.ephemeral === true) return false;
        if (!scopedProject) return true;
        const stamp = typeof t.projectId === 'string' && t.projectId ? t.projectId : null;
        return stamp === null || stamp === scopedProject;
      });
      if (userTabs.length > 0) {
        this.switchTab(userTabs[userTabs.length - 1]!, { plane: 'user' });
      } else if (reservedForClose || authorizedByAttempt) {
        // Repairing "the window is never empty" must not run inside an authorized close:
        // the replacement page would be a new arrival the attempt has to treat as one, so
        // a project shell could never reach zero member pages and never close. The shell
        // stays empty and the attempt decides; a tab a user or agent opens during the
        // close is a real arrival and keeps the shell open, which is reported honestly
        // rather than as a failure.
        this.activeTabId = '';
        this.broadcastState();
      } else if (!this.isTerminalOnlyWindow()) {
        this.createTab('https://www.google.com');
      } else {
        this.activeTabId = '';
        this.broadcastState();
      }
    } else {
      this.broadcastState();
    }
    // Closing the presented tab picks a new one (or creates one); if that pick refuses
    // or fails the window would otherwise keep showing nothing at all.
    this.reassertPresentedView();
    recordBenchmark({ surface: 'tabs', name: 'closed', extra: { attachedViews: this.countAttachedViews() } });
    return true;
  }

  /**
   * One `tabhost.tabClosed` journal row per removed tab, snapshot from the record while
   * it is still in scope. Called immediately after `this.tabs.delete(tabId)` in
   * `closeTab` — before the failover/refill tail can mint a replacement — and once per
   * tab inside `disposeChildViewContents`, which is the removal path that bypasses
   * `closeTab` entirely. `source` names the caller that drove the removal (toolbar,
   * MCP, bridge, authorized close attempt, host dispose, ...); callers that
   * pass nothing degrade to 'unspecified' rather than to silence. `urlOrigin` carries
   * the page's origin only for http(s) URLs — same privacy convention as the
   * diagnostics query-stripping; capsuleId/projectId carry the attribution.
   */
  private recordTabClosedTelemetry(tabId: string, target: NativeTabRecord, source: string): void {
    const url = typeof target.state.url === 'string' ? target.state.url : '';
    let urlOrigin: string | undefined;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') urlOrigin = parsed.origin;
    } catch {}
    recordLifecycleEvent('tabhost.tabClosed', {
      tabId,
      source,
      ephemeral: target.state.ephemeral === true,
      capsuleId: target.state.capsuleId,
      projectId: target.projectId,
      urlOrigin,
      lastActiveAt: target.lastActiveAt,
      agentActivityAt: target.agentActivityAt,
    });
  }

  /**
   * Install (or clear) the close-admission seam. Main injects the singleton tab
   * authority's reservations here; the host reads the fact without importing close
   * policy, and a host that was never given the seam behaves as it did before it.
   */
  public setCloseAdmission(admission: TabHostCloseAdmission | null): void {
    this.closeAdmission = admission && typeof admission.isPageReserved === 'function' ? admission : null;
  }

  /**
   * Refuse work that mints something the committed teardown has already passed: a PTY or a
   * capsule created then would outlive the windows that asked for it. The close gate's
   * application reservation is the authority here, so this reads the same fact
   * `admitAgentAction` reads rather than keeping a second copy of the state.
   */
  public assertApplicationAdmitsHostWork(surface: string): void {
    if (!this.isApplicationAdmissionReservedForClose()) return;
    throw new CapabilityError('RUNTIME_DRAINING', `${surface} refused: application admission is reserved for a quit`);
  }

  /**
   * Refuse work that mints for a window whose own close attempt is already in flight.
   * The application assert above cannot see this: a *shell* close is not a quit, so the
   * broader reservation stays open while the asking window's own admission is held. For
   * synchronous mints — a popout, a terminal window — a held admission would add nothing:
   * no close attempt can interleave inside the call itself, so refusing it here is the
   * whole gate. An absent owner key means the sender names no window to protect.
   */
  public assertOwnerAdmitsHostWork(surface: string, ownerKey: string | undefined): void {
    const owner = typeof ownerKey === 'string' ? ownerKey.trim() : '';
    if (owner.length === 0) return;
    if (!this.isOwnerReservedForClose(owner)) return;
    throw new CapabilityError('TARGET_STALE', `${surface} refused: window '${owner}' is closing`);
  }

  /**
   * The owner key an admitted operation requested through `senderId` belongs to, or undefined.
   *
   * A sidebar, toolbar or popout sender is chrome rather than a page, so `findTabByWebContents`
   * answers undefined for it - and `beginAdmittedOperation` counts a *named page*, never the
   * process total, for every page-scoped question. A terminal mint admitted with no attribution is
   * therefore invisible to the very shell close that would take down the window presenting it:
   * that attempt reads an idle page and proceeds while the daemon is still minting the shell's PTY.
   * The shell's owner is the identity of the whole window, so attributing the mint to it makes the
   * work visible to that shell's close - and to no other window's, and not to a page close, because
   * a reserved page is not what a mint for the window is about.
   *
   * Every owner class keys on its window, including Unassigned: `ProjectWindowManager` holds at
   * most one live shell per owner key — `ensureWindow` reuses the entry its key already has and
   * `listShells` reads that same map — so `unassigned` cannot alias two live windows, and the
   * sentinel is disjoint from every `project:<id>` (see `ownerKey`). A sender this host cannot
   * place, or a host with no shell, names no owner; the process-wide count still holds the
   * operation.
   */
  public shellOwnerKeyForSender(senderId: number | undefined): string | undefined {
    if (typeof senderId !== 'number' || !this.ownsChromeSender(senderId)) return undefined;
    const owner = this.shell?.owner;
    return owner ? ownerKey(owner) : undefined;
  }

  /** True when this webContents is a surface this shell presents: its chrome, or a terminal window of it. */
  private ownsChromeSender(senderId: number): boolean {
    if (this.shell.chromeSurfaceFor(senderId)) return true;
    if (this.popoutWindow && !this.popoutWindow.isDestroyed() && this.popoutWindow.webContents?.id === senderId) return true;
    for (const win of this.terminalWindows.values()) {
      if (!win.isDestroyed() && win.webContents?.id === senderId) return true;
    }
    return false;
  }

  /**
   * Admit host work that spans an await, or refuse it as final - and release from a
   * `finally` on every path.
   *
   * The terminal RPCs mint their PTY inside the daemon after the call resolves, so reading
   * admission before the call proves nothing about the moment the PTY exists. The refusal
   * and the registration happen in one synchronous step in both directions: an attempt that
   * already began refuses this work instead of letting a PTY be created for a page it is
   * about to destroy, and this work is registered before control leaves the step, so an
   * attempt that begins mid-RPC measures it instead of tearing down around a PTY that is
   * about to exist.
   *
   * `attribution` names what the operation is about: the page it was asked from (a sidebar
   * request bound to a member page) and the owner key of the window that asked, which is
   * what makes a mint from chrome visible to that window's close. Either may be absent, and
   * an operation that names neither is still counted process-wide.
   */
  public admitHostWork(surface: string, attribution?: { readonly tabIds?: string | readonly string[]; readonly ownerKey?: string }): () => void {
    this.assertApplicationAdmitsHostWork(surface);
    const claimed = attribution?.tabIds === undefined ? [] : typeof attribution.tabIds === 'string' ? [attribution.tabIds] : [...attribution.tabIds];
    for (const page of claimed) {
      if (page.length > 0 && this.isPageReservedForClose(page)) {
        throw new CapabilityError('TARGET_STALE', `${surface} refused: page '${page}' is reserved for close`);
      }
    }
    const admission = this.closeAdmission;
    const owner = typeof attribution?.ownerKey === 'string' ? attribution.ownerKey.trim() : '';
    if (owner.length > 0 && this.isOwnerReservedForClose(owner)) {
      throw new CapabilityError('TARGET_STALE', `${surface} refused: window '${owner}' is closing`);
    }
    if (!admission || typeof admission.beginAdmittedOperation !== 'function') return () => {};
    return admission.beginAdmittedOperation(claimed, attribution?.ownerKey);
  }

  /**
   * Admit host work and run it, releasing the admission when that work settles.
   *
   * A route that admits must not change the shape it returned before admission existed: an
   * in-process call returns its value synchronously, and a daemon round-trip returns the very
   * promise the caller already awaited. What admission adds is the synchronous step — refuse or
   * register before control leaves the route — plus a release attached to settlement, so an
   * await that spans the call cannot outlive its own admission, and a rejection releases before
   * it propagates.
   */
  public admitThenRun<T>(
    surface: string,
    attribution: { readonly tabIds?: string | readonly string[]; readonly ownerKey?: string },
    work: () => T | Promise<T>
  ): T | Promise<T> {
    const release = this.admitHostWork(surface, attribution);
    let result: T | Promise<T>;
    try {
      result = work();
    } catch (err) {
      release();
      throw err;
    }
    const settled: unknown = result;
    const isThenable =
      !!settled &&
      (typeof settled === 'object' || typeof settled === 'function') &&
      typeof (settled as { then?: unknown }).then === 'function';
    if (!isThenable) {
      release();
      return result;
    }
    return Promise.resolve(result).then(
      (value: T) => {
        release();
        return value;
      },
      (err: unknown) => {
        release();
        throw err;
      }
    );
  }

  /**
   * Unload-aware native close of ONE member page — the native half the close
   * coordinator injects as `deps.closePage`.
   *
   * The native side owns the outcome vocabulary:
   * - both observers are registered on the exact `WebContents` instance BEFORE
   *   `close({ waitForBeforeUnload: true })` runs, because `close()` returns no
   *   awaitable result;
   * - `will-prevent-unload` is never answered with `preventDefault()`: that would
   *   override the page's veto and destroy a page the user asked to keep;
   * - a destroyed instance wins over a veto, so `closed` and `vetoed` are never
   *   conflated, and a thrown native call REJECTS rather than reporting an outcome, so
   *   the coordinator's `failed` bucket stays distinct from `unknown`;
   * - a missing or replaced instance resolves `unknown`, and a close that stays silent past
   *   `PAGE_CLOSE_OUTCOME_DEADLINE_MS` reports what the instance itself says: `closed` when
   *   the instance is destroyed (its `destroyed` event was dropped or arrived too late to be
   *   observed), `unknown` while it is still standing. The bound never decides a closure —
   *   `closed` still comes only from a destroyed instance, and no page is ever destroyed on a
   *   timer — it only stops one swallowed platform answer from holding this tab's reservation
   *   and handing its never-settling promise to every later attempt. Reporting `unknown` for
   *   an instance that was in fact destroyed would be the worse error of the two: it skips
   *   `finalizeClosedPage`, leaving a closed page's record owned by this shell.
   *
   * Local cleanup is explicit here: the tab record and its child contents are disposed
   * when the per-tab `destroyed` listener did not already do it, so no caller has to
   * assume that listener exists.
   */
  public closePage(tabId: string, force = false): Promise<TabPageCloseOutcome> {
    if (this.isDisposed) return Promise.resolve('unknown');
    const targetId = (this.resolveTargetTabId(tabId) || tabId || '').trim();
    if (targetId.length === 0) return Promise.resolve('unknown');
    const inFlight = this.pendingPageCloses?.get(targetId);
    if (inFlight) return force ? inFlight.then((outcome) => outcome === 'closed' ? outcome : this.closePage(targetId, true)) : inFlight;
    const record = this.tabs?.get(targetId);
    // A tab whose contents are gone but whose record survives is hibernated or
    // dead-renderered: there is no page to ask for unload consent, nothing that
    // can veto, and every durable fact lives in `record.state`. Local cleanup IS
    // the close — reporting 'unknown' left the record owned and retained the
    // whole shell. The record cleanup still runs under this call's attempt
    // authorization so closeTab admits it like every other attempt-owned close.
    this.attemptAuthorizedCloses?.add(targetId);
    if (record && !record.view?.webContents) {
      try {
        this.closeTab(targetId, 'close-attempt');
      } finally {
        this.attemptAuthorizedCloses?.delete(targetId);
      }
      return Promise.resolve(this.tabs?.has(targetId) === true ? 'unknown' : 'closed');
    }
    const wc: Electron.WebContents | null | undefined = record?.view?.webContents;
    if (!record || !wc) {
      this.attemptAuthorizedCloses?.delete(targetId);
      return Promise.resolve('unknown');
    }

    // From here this call owns the page: the attempt's reservation keeps every other
    // caller out of closeTab() for this tab id, and this set names the one caller that is
    // allowed through, so the attempt's own close still runs the local tab cleanup.
    const deferred = Promise.withResolvers<TabPageCloseOutcome>();
    let settled = false;
    let outcomeTimer: NodeJS.Timeout | null = null;
    const releaseAttempt = (): void => {
      if (outcomeTimer) {
        clearTimeout(outcomeTimer);
        outcomeTimer = null;
      }
      this.attemptAuthorizedCloses?.delete(targetId);
      this.pendingPageCloses?.delete(targetId);
      try { wc.removeListener('destroyed', onDestroyed); } catch {}
      try { wc.removeListener('will-prevent-unload', onWillPreventUnload); } catch {}
    };
    const finish = (outcome: TabPageCloseOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        // Cleanup runs while this call still owns the reservation: the tab authority
        // refuses to destroy a reserved page, so releasing first would leave the closed
        // page's record behind and the shell would report a page it no longer owns.
        if (outcome === 'closed') this.finalizeClosedPage(targetId, wc);
      } finally {
        releaseAttempt();
      }
      deferred.resolve(outcome);
    };
    const onDestroyed = (): void => finish('closed');
    // Never preventDefault here: the whole point of this observer is to honor the veto.
    // A page whose beforeunload vetoed a close is a dirty form the user chose to keep:
    // the hibernation sweep must never probe it either, so the veto marks the tab for
    // exclusion the same way a refused sleep probe does.
    const onWillPreventUnload = (): void => {
      this.unloadVetoedTabIds?.add(targetId);
      finish('vetoed');
    };

    this.attemptAuthorizedCloses?.add(targetId);
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) {
      // Already terminal: nothing can veto it, and no observer can fire for it again.
      // Same ordering rule as `finish`: the record cleanup happens under this call's
      // authorization, then the reservation is released.
      settled = true;
      try {
        this.finalizeClosedPage(targetId, wc);
      } finally {
        releaseAttempt();
      }
      return Promise.resolve('closed');
    }

    this.pendingPageCloses?.set(targetId, deferred.promise);
    wc.once('destroyed', onDestroyed);
    wc.once('will-prevent-unload', onWillPreventUnload);
    // Armed before the request, because a swallowed answer emits no event to arm one from.
    // The bound reports the same fact the `destroyed` observer reports, and reports it the
    // same way: a destruction that landed without its event being delivered is a closed page,
    // not a silent one, and calling it silent would skip `finalizeClosedPage` and leave the
    // destroyed record in `this.tabs` — a leak the page's own close is supposed to prevent.
    // `finish` routes through `releaseAttempt`, so it clears this timer and drops the
    // in-flight entry, and a later attempt can ask the page again.
    outcomeTimer = setTimeout(() => {
      const gone = typeof wc.isDestroyed === 'function' && wc.isDestroyed();
      finish(gone ? 'closed' : 'unknown');
    }, PAGE_CLOSE_OUTCOME_DEADLINE_MS);
    outcomeTimer.unref?.();
    try {
      // Only the explicitly confirmed force path skips beforeunload. Destruction still
      // settles through the exact-instance observer and normal local record cleanup.
      // Electron 43 removed `WebContents.destroy()`: `close` without waiting is the
      // unconditional destroy — the page cannot veto what it is never asked about.
      if (force) wc.close({ waitForBeforeUnload: false });
      else wc.close({ waitForBeforeUnload: true });
    } catch (error) {
      if (!settled) {
        settled = true;
        releaseAttempt();
        deferred.reject(error);
      }
    }
    return deferred.promise;
  }

  /**
   * Dispose the tab record of a page whose exact instance was just destroyed. Runs only
   * when the per-tab `destroyed` listener did not already clean the record up, and never
   * touches a record a newer instance now owns.
   */
  private finalizeClosedPage(tabId: string, destroyedInstance: Electron.WebContents): void {
    const record = this.tabs?.get(tabId);
    if (!record) return;
    if (record.view?.webContents !== destroyedInstance) return;
    this.closeTab(tabId, 'close-attempt');
  }

  /**
   * The visible member-page snapshot a close attempt takes BEFORE it destroys anything:
   * this shell's presented tabs in strip order, excluding ephemeral
   * agent-plane views that `auxiliaryViewTabIds()` reports separately.
   */
  public visibleMemberTabIds(): string[] {
    if (this.isDisposed || !this.tabs) return [];
    const isMember = (tab: NativeTabRecord | undefined): boolean =>
      Boolean(tab && tab.state.ephemeral !== true);
    const members: string[] = [];
    for (const id of this.tabOrder ?? []) {
      if (members.includes(id) || !isMember(this.tabs.get(id))) continue;
      members.push(id);
    }
    // A presented record missing from the strip order is still a member. Under-reporting
    // is the dangerous direction: a page left out of the snapshot is a page the attempt
    // would leave behind while reporting its shell closed.
    for (const [id, tab] of this.tabs) {
      if (members.includes(id) || !isMember(tab)) continue;
      members.push(id);
    }
    return members;
  }

  /**
   * The auxiliary views this host owns: ephemeral agent-plane tabs. They
   * are deliberately outside `visibleMemberTabIds()` — no project snapshot may claim
   * them — but they hold live renderers and can carry in-flight work, so an
   * application-scope busy check must still see them.
   */
  public auxiliaryViewTabIds(): string[] {
    if (this.isDisposed || !this.tabs) return [];
    const ids: string[] = [];
    for (const [id, tab] of this.tabs) {
      if (tab.state.ephemeral === true) ids.push(id);
    }
    return ids;
  }

  /**
   * Re-present a surviving member page INSIDE this shell after a partial close: the
   * current active page when it survived, otherwise the last survivor in strip order.
   * Never raises, shows or focuses another window and never touches another shell.
   */
  public restoreSurvivingLayout(survivingTabIds: readonly string[]): boolean {
    if (this.isDisposed || !this.tabs) return false;
    const survivors = this.visibleMemberTabIds().filter((id) => survivingTabIds.includes(id));
    if (survivors.length === 0) return false;
    const target = survivors.includes(this.activeTabId) ? this.activeTabId : survivors[survivors.length - 1]!;
    if (this.activeTabId === target) {
      this.reassertPresentedView();
      return true;
    }
    return this.switchTab(target, { plane: 'user' });
  }

  // ── Tab hibernation ────────────────────────────────────────────────────────

  /**
   * Test/probe seam: narrow the idle threshold below `HIBERNATE_IDLE_MS`.
   * Production never calls this; the constant stays the shipped default.
   */
  public setHibernationIdleMsForTesting(idleMs: number): void {
    if (typeof idleMs === 'number' && idleMs > 0) this.hibernationIdleMs = idleMs;
  }

  /**
   * Test/probe seam: force one tab through the hibernation machinery without
   * waiting out the sweep timer. Every exclusion the shipping sweep honors is
   * still consulted (agent plane, automation target, MCP/CDP bindings, unload
   * veto) — only the idle question is answered for the probe by a `now` read at
   * the tab's own idle boundary, so it never sleeps a tab the sweep itself
   * would refuse.
   */
  public beginTabHibernation(tabId: string): Promise<boolean> {
    const tab = this.tabs?.get(tabId);
    if (!tab || tab.state.hibernated === true || this.hibernatingTabIds?.has(tabId)) {
      return Promise.resolve(false);
    }
    const decision = shouldHibernate(
      { id: tabId, state: tab.state, lastActiveAt: tab.lastActiveAt },
      {
        activeTabId: this.activeTabId,
        automationTabId: this.automationTabId,
        boundTabIds: this.hibernationBoundTabIds(),
        cdpBoundTabIds: this.hibernationCdpBoundTabIds(),
        unloadVetoedTabIds: this.unloadVetoedTabIds,
        // The idle question is answered for the probe: `now` sits exactly at the
        // tab's own idle boundary against the SAME threshold the policy uses —
        // URL floors (e.g. Docs/Sheets 20min) are resolved before the hand-off.
        idleMs: hibernationIdleMsForUrl(tab.state.url, this.hibernationIdleMs || HIBERNATE_IDLE_MS),
        now: (tab.lastActiveAt || 0) + hibernationIdleMsForUrl(tab.state.url, this.hibernationIdleMs || HIBERNATE_IDLE_MS),
      },
    );
    if (!decision.hibernate) return Promise.resolve(false);
    return this.hibernateTab(tabId);
  }

  /** Ensure the per-host sweep timer exists (created lazily, `unref`'d). */
  public ensureHibernationSweep(): void {
    if (this.isDisposed || this.hibernationSweepTimer) return;
    this.hibernationSweepTimer = setInterval(() => {
      this.runHibernationSweep().catch((err) => {
        console.warn('[native-tab-host] hibernation sweep failed:', err);
      });
    }, HIBERNATE_SWEEP_INTERVAL_MS);
    this.hibernationSweepTimer.unref?.();
  }

  /**
   * The set of tab ids a live MCP attachment/evidence lease is bound to, read
   * through the control plane's attachment registry. A host with no control
   * plane has no bound tabs — the empty set, not a guess.
   */
  private hibernationBoundTabIds(): Set<string> {
    const bound = new Set<string>();
    const registry = this.controlPlane?.runs?.attachments;
    if (!registry || typeof registry.getActiveRecordIds !== 'function') return bound;
    try {
      for (const attachmentId of registry.getActiveRecordIds()) {
        const rec = registry.getRecord?.(attachmentId);
        const tabId = rec?.tabId || rec?.browserTarget?.tabId;
        if (typeof tabId === 'string' && tabId) bound.add(tabId);
      }
    } catch {}
    return bound;
  }

  /**
   * Stamp agent activity on `tabId`. Called by the three target-resolution
   * funnels (control-port resolveTargetTab, automation-host
   * resolveAutomationTargetId, bridge resolveDirectRpcTargetTab); surfaced in
   * `tabhost.tabClosed` telemetry.
   */
  public noteAgentTabActivity(tabId?: string): void {
    if (!tabId) return;
    const tab = this.tabs.get(tabId);
    if (tab) tab.agentActivityAt = Date.now();
  }


  /**
   * Tab ids with an open debugger/CDP session or open DevTools UI. The devtools
   * host tracks its transport registrations per WebContents id, so a replaced
   * view starts clean and a genuinely attached one reports bound.
   */
  private hibernationCdpBoundTabIds(): Set<string> {
    const bound = new Set<string>();
    const devToolsHost = this.devToolsHost as { hasActiveCdpSession?: (wcId: number) => boolean } | undefined;
    for (const [id, tab] of this.tabs) {
      try {
        const wc = tab.view?.webContents;
        if (!wc || wc.isDestroyed()) continue;
        if (typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()) {
          bound.add(id);
          continue;
        }
        if (typeof devToolsHost?.hasActiveCdpSession === 'function' && devToolsHost.hasActiveCdpSession(wc.id)) {
          bound.add(id);
        }
      } catch {}
    }
    return bound;
  }

  /**
   * One 60s sweep: for every tab that passes the pure policy, attempt the
   * unload-aware destroy. A beforeunload veto marks the tab and moves on — the
   * sweep never blocks waiting for a single tab's answer.
   */
  private async runHibernationSweep(): Promise<void> {
    if (this.isDisposed) return;
    const ctx: HibernationContext = {
      activeTabId: this.activeTabId,
      automationTabId: this.automationTabId,
      boundTabIds: this.hibernationBoundTabIds(),
      cdpBoundTabIds: this.hibernationCdpBoundTabIds(),
      unloadVetoedTabIds: this.unloadVetoedTabIds,
      idleMs: this.hibernationIdleMs,
    };
    for (const [id, tab] of [...this.tabs.entries()]) {
      const decision = shouldHibernate({ id, state: tab.state, lastActiveAt: tab.lastActiveAt }, ctx);
      if (!decision.hibernate) continue;
      await this.hibernateTab(id);
    }
  }

  /**
   * Snapshot the tab's URL/title/favicon/scroll, then destroy the desktop
   * WebContentsView (and `mobileView` in split mode) via an unload-aware close.
   * The record and id stay in `this.tabs`; `state.hibernated` marks the strip.
   *
   * Destroy goes through `wc.close({ waitForBeforeUnload: true })` armed with a
   * `will-prevent-unload` observer — exactly the close-page pattern — so a
   * dirty form vetoes the sleep instead of losing its data.
   */
  private async hibernateTab(tabId: string): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.state.hibernated === true) return false;
    if (this.hibernatingTabIds.has(tabId)) return false;
    const view = tab.view;
    const wc = view?.webContents;
    if (!view || !wc || wc.isDestroyed()) return false;
    const canStillHibernate = (): boolean => {
      if (this.isDisposed || this.tabs.get(tabId) !== tab || tab.view !== view || wc.isDestroyed()) return false;
      const audible = [tab.view, tab.mobileView].some((pane) => {
        const contents = pane?.webContents;
        return contents && !contents.isDestroyed() && typeof contents.isCurrentlyAudible === 'function' && contents.isCurrentlyAudible();
      });
      if (audible) return false;
      return shouldHibernate({ id: tabId, state: tab.state, lastActiveAt: tab.lastActiveAt }, {
        activeTabId: this.activeTabId,
        automationTabId: this.automationTabId,
        boundTabIds: this.hibernationBoundTabIds(),
        cdpBoundTabIds: this.hibernationCdpBoundTabIds(),
        unloadVetoedTabIds: this.unloadVetoedTabIds,
        idleMs: this.hibernationIdleMs,
      }).hibernate;
    };
    if (!canStillHibernate()) return false;

    // 1. Snapshot what the record must keep: scroll position (URL/title/favicon
    //    already live on `state`). A wedged renderer gets a bounded probe, not a
    //    hung sweep — scroll restore is best-effort.
    try {
      const pos = await Promise.race([
        wc.executeJavaScript('({ x: window.scrollX || 0, y: window.scrollY || 0 })'),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
      ]) as { x?: number; y?: number } | null;
      if (pos) {
        tab.state.scrollX = pos.x || 0;
        tab.state.scrollY = pos.y || 0;
      }
    } catch {}
    // Activation, playback, or a new capability lease can arrive during the
    // asynchronous snapshot. Eligibility at sweep entry is not close authority.
    if (!canStillHibernate()) return false;

    // 2. Close-aware destroy of the pane(s). Mark the tab BEFORE arming the
    //    close so its `destroyed`/`close` listeners skip `closeTab` and keep the
    //    record. A veto on either pane aborts the sleep and records the refusal.
    this.hibernatingTabIds.add(tabId);
    try {
      const panes: Array<{ pane: WebContentsView; kind: 'desktop' | 'mobile' }> = [];
      panes.push({ pane: view, kind: 'desktop' });
      if (tab.state.splitMode && tab.mobileView && tab.mobileView.webContents && !tab.mobileView.webContents.isDestroyed()) {
        panes.push({ pane: tab.mobileView, kind: 'mobile' });
      }
      for (const { pane, kind } of panes) {
        // Each page-close can await beforeunload; the desktop pane may already be
        // gone, or the tab may have become active/audible. Re-check before the
        // next pane loses its renderer.
        if (!canStillHibernate()) return false;
        const pwc = pane.webContents;
        if (!pwc || pwc.isDestroyed()) continue;
        const outcome = await new Promise<'closed' | 'vetoed' | 'unknown'>((resolve) => {
          let done = false;
          const finish = (v: 'closed' | 'vetoed' | 'unknown') => { if (!done) { done = true; resolve(v); } };
          const timer = setTimeout(() => finish('unknown'), 3000);
          timer.unref?.();
          pwc.once('will-prevent-unload', () => { clearTimeout(timer); finish('vetoed'); });
          pwc.once('destroyed', () => { clearTimeout(timer); finish('closed'); });
          try { pwc.close({ waitForBeforeUnload: true }); } catch { clearTimeout(timer); finish('unknown'); }
        });
        if (outcome !== 'closed') {
          if (outcome === 'vetoed') this.unloadVetoedTabIds.add(tabId);
          // A pane that refused is left live; a pane already closed is detached
          // below so its record keeps a coherent (dead or rebuilt-on-wake) view.
          return false;
        }
        try {
          if (this.shell.window && !this.shell.window.isDestroyed() && this.shell.window.contentView.children.includes(pane)) {
            this.shell.window.contentView.removeChildView(pane);
          }
        } catch {}
        // Drop the tracker + devtools-session bookkeeping bound to the dead wc.
        try { this.networkTracker?.detachTarget(tabId, kind); } catch {}
        if (kind === 'desktop') tab.view = undefined;
        else tab.mobileView = undefined;
      }

      // 3. Both panes destroyed: mark the record asleep and broadcast the strip.
      tab.state.hibernated = true;
      tab.state.isLoading = false;
      tab.state.isAudible = false;
      tab.state.crashed = false;
      this.schedulePersist();
      this.broadcastState();
      return true;
    } finally {
      this.hibernatingTabIds.delete(tabId);
    }
  }

  /**
   * Rebuild the desktop view of a record that is hibernated (or whose view is
   * otherwise gone/crashed) WITHOUT navigating. The shared recreate core —
   * extracted from `switchTab` so the wake path and the crash-repair path build
   * the same view, wire the same events, and index it identically.
   */
  private recreateDesktopView(targetId: string, target: NativeTabRecord): WebContentsView | null {
    // Release the previous view before replacing it: a crashed/destroyed renderer
    // leaves its WebContentsView attached to the window, holding a renderer,
    // forever — the detach sweep below walks `this.tabs` and never destroys, so
    // nothing else would ever free this one.
    try {
      if (target.view && this.shell.window && !this.shell.window.isDestroyed() && this.shell.window.contentView.children.includes(target.view)) {
        this.shell.window.contentView.removeChildView(target.view);
      }
    } catch {}
    try { this.destroyOwnedWebContents(target.view?.webContents); } catch {}
    if (target.view?.webContents) this.tabByWebContents?.delete(target.view.webContents);
    const view = new WebContentsView({
      webPreferences: getSecureWebPreferences(target.state.partition),
    });
    try { view.setBackgroundColor('#ffffff'); } catch {}
    target.state.crashed = false;
    this.setSafeUserAgent(view.webContents, this.defaultUserAgent);
    this.setupTabWebContentsEvents(targetId, view, target.state, 'desktop');
    this.tabByWebContents?.set(view.webContents, { tabId: targetId, tab: target });
    target.view = view;
    return view;
  }

  /**
   * Rebuild the split-mode `mobileView` of a record the same way
   * `toggleSplitReview` builds it originally, without navigating. Returns null
   * when the tab is not in split mode.
   */
  private recreateMobileView(targetId: string, target: NativeTabRecord): WebContentsView | null {
    if (target.state.splitMode !== true) return null;
    try {
      if (target.mobileView && this.shell.window && !this.shell.window.isDestroyed() && this.shell.window.contentView.children.includes(target.mobileView)) {
        this.shell.window.contentView.removeChildView(target.mobileView);
      }
    } catch {}
    try { this.destroyOwnedWebContents(target.mobileView?.webContents); } catch {}
    if (target.mobileView?.webContents) this.tabByWebContents?.delete(target.mobileView.webContents);
    const mobileView = new WebContentsView({
      webPreferences: getSecureWebPreferences(target.state.partition),
    });
    try { mobileView.setBackgroundColor('#ffffff'); } catch {}
    const mobilePreset = DEVICE_PRESETS.find((p) => p.id === target.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
    const mobileUA = getPresetUserAgent(mobilePreset, IPHONE_USER_AGENT);
    this.setSafeUserAgent(mobileView.webContents, mobileUA || IPHONE_USER_AGENT);
    target.mobileView = mobileView;
    this.tabByWebContents?.set(mobileView.webContents, { tabId: targetId, tab: target });
    this.setupTabWebContentsEvents(targetId, mobileView, target.state, 'mobile');
    return mobileView;
  }

  /**
   * Wake a hibernated tab synchronously: rebuild its views and start loading
   * its saved URL. Navigation history back/forward is intentionally NOT
   * restored — the reload always lands on the saved current URL.
   *
   * The guard reads the view as well as the flag: a sleep probe that closed the
   * desktop pane but was vetoed on the mobile pane leaves `view` undefined with
   * `hibernated` still false, and that half-slept record needs the same rebuild.
   */
  public ensureTabAwake(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const viewMissing = !tab.view || tab.view.webContents?.isDestroyed?.() === true;
    if (tab.state.hibernated !== true && !viewMissing) return true; // already awake
    const view = this.recreateDesktopView(tabId, tab);
    if (!view) return false;
    tab.state.hibernated = false;
    tab.state.isLoading = Boolean(tab.state.url && tab.state.url !== 'about:blank');
    if (tab.state.splitMode === true) {
      const mobile = this.recreateMobileView(tabId, tab);
      if (mobile && tab.state.url && tab.state.url !== 'about:blank' && isAllowedNavigation(tab.state.url)) {
        mobile.webContents.loadURL(tab.state.url).catch(() => {});
      }
    }
    const url = tab.state.url;
    if (url && url !== 'about:blank' && isAllowedNavigation(url)) {
      view.webContents.loadURL(url).catch((err: unknown) => {
        if (err && typeof err === 'object' && ('code' in err || 'errno' in err)) {
          const code = 'code' in err ? String(err.code) : '';
          const errno = 'errno' in err ? Number(err.errno) : 0;
          if (code === 'ERR_ABORTED' || errno === -3) return;
        }
        tab.state.isLoading = false;
        this.broadcastState();
      });
      this.restoreTabScrollAfterLoad(tab, view.webContents);
    }
    this.broadcastState();
    return true;
  }

  /**
   * Re-apply the saved scroll position once the woken page finishes loading.
   * Best-effort: a page that never finishes simply keeps its natural scroll.
   */
  private restoreTabScrollAfterLoad(tab: NativeTabRecord, wc: Electron.WebContents): void {
    const x = tab.state.scrollX || 0;
    const y = tab.state.scrollY || 0;
    if (!x && !y) return;
    const apply = () => {
      if (wc.isDestroyed()) return;
      wc.executeJavaScript(`window.scrollTo(${x}, ${y})`).catch(() => {});
    };
    wc.once('did-finish-load', apply);
    // Backstop for pages that never emit did-finish-load: try once shortly after.
    const t = setTimeout(apply, 4000);
    t.unref?.();
  }

  /**
   * Wake a hibernated tab AND wait for its page to settle, so an MCP/capability
   * action targeting it runs against the real document — never a spurious
   * TARGET_STALE, never a half-loaded DOM. Deduped per tab: a burst of calls
   * shares one wake-and-wait.
   */
  public ensureTabReady(tabId: string, timeoutMs = 15000): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return Promise.resolve(false);
    const existing = this.tabReadyWaits.get(tabId);
    if (existing) return existing;
    const wait = this.doEnsureTabReady(tabId, timeoutMs).finally(() => {
      if (this.tabReadyWaits.get(tabId) === wait) this.tabReadyWaits.delete(tabId);
    });
    this.tabReadyWaits.set(tabId, wait);
    return wait;
  }

  private async doEnsureTabReady(tabId: string, timeoutMs: number): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (tab.state.hibernated === true || !tab.view || tab.view.webContents?.isDestroyed?.()) {
      this.ensureTabAwake(tabId);
    }
    const wc = this.tabs.get(tabId)?.view?.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if (!tab.state.isLoading) return true;
    // The woken page is still loading: wait for it to commit so the action sees
    // the restored document. Bounded — a wedged load must not stall the call.
    return await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => { if (!done) { done = true; resolve(ok); } };
      const timer = setTimeout(() => finish(!wc.isDestroyed()), Math.min(timeoutMs, 15000));
      timer.unref?.();
      wc.once('did-stop-loading', () => { clearTimeout(timer); finish(true); });
      wc.once('destroyed', () => { clearTimeout(timer); finish(false); });
    });
  }

  /** Whether a tab is currently hibernated (strip + capability surface read this). */
  public isTabHibernated(tabId?: string | null): boolean {
    const id = this.resolveTargetTabId(tabId) || tabId || '';
    const tab = this.tabs.get(id);
    return tab?.state.hibernated === true;
  }

  /**
   * Read one page's close reservation. Fail-closed: a seam that throws reads as
   * "reserved", so an unreadable reservation can never authorize destroying a page.
   */
  private isPageReservedForClose(tabId: string): boolean {
    const admission = this.closeAdmission;
    if (!admission || typeof admission.isPageReserved !== 'function') return false;
    try {
      return admission.isPageReserved(tabId) === true;
    } catch {
      return true;
    }
  }

  /**
   * Read the application-wide admission fact. Fail-closed for the same reason as the
   * per-page read, and read BEFORE it, because it is the broader refusal. A host that was
   * never given the wider face reads as not reserved, so injecting the seam stays additive.
   */
  private isApplicationAdmissionReservedForClose(): boolean {
    const admission = this.closeAdmission;
    if (!admission || typeof admission.isApplicationAdmissionReserved !== 'function') return false;
    try {
      return admission.isApplicationAdmissionReserved() === true;
    } catch {
      return true;
    }
  }

  /**
   * Read one window's close reservation. Fail-closed for the same reason as the other two:
   * an unreadable answer refuses rather than admitting work into a closing window.
   */
  private isOwnerReservedForClose(ownerKey: string): boolean {
    const admission = this.closeAdmission;
    if (!admission || typeof admission.isOwnerReserved !== 'function') return false;
    try {
      return admission.isOwnerReserved(ownerKey) === true;
    } catch {
      return true;
    }
  }

  /**
   * Admit one agent action, or refuse it as final — the same two-step the port gate and
   * the capability transport perform, applied at the host so the bridge RPC surfaces
   * cannot admit work the gate would have refused.
   *
   * The refusal is a throw carrying a `CapabilityError` code from the shared vocabulary:
   * `RUNTIME_DRAINING` while a quit holds admission, `TARGET_STALE` for a page inside an
   * authorized close, with the surface name in the message so the caller can report which
   * action was refused and why. Registering the admitted operation is what makes an
   * in-flight agent action visible to the close gate's measurement; a registration that
   * throws is a refusal, not a warning, because unmeasurable work must not be admitted.
   */
  private admitAgentAction(surface: string, tabId?: string): () => void {
    if (this.isApplicationAdmissionReservedForClose()) {
      throw new CapabilityError(
        'RUNTIME_DRAINING',
        `${surface} refused: application admission is reserved for a quit`
      );
    }
    const target = tabId || this.automationTabId || '';
    if (target && this.isPageReservedForClose(target)) {
      throw new CapabilityError(
        'TARGET_STALE',
        `${surface} refused: page '${target}' is reserved for close`
      );
    }
    // A nested action — the keyboard action the automation host routes back through this
    // host — is already registered by the outer call, so registering here would count one
    // action twice in that measurement. The refusal above still applies to it.
    if (this.agentActionAdmissionDepth > 0) return () => {};
    const admission = this.closeAdmission;
    if (!admission || typeof admission.beginAdmittedOperation !== 'function') return () => {};
    // Attributed to the page AND to this window's owner. A page count alone is invisible to a
    // shell question when the target is an ephemeral tab: those are not member
    // pages, so a window close would destroy the tab mid-action and still measure as idle.
    const release = admission.beginAdmittedOperation(
      target ? [target] : undefined,
      this.windowOwnerKey()
    );
    this.agentActionAdmissionDepth++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.agentActionAdmissionDepth--;
      release();
    };
  }

  public reopenClosedTab(): string | null {
    if (this.recentlyClosedTabs.length === 0) return null;
    const last = this.recentlyClosedTabs.pop();
    if (last && last.url) {
      return this.createTab(last.url);
    }
    return null;
  }

  public moveTab(tabId: string, toIndex: number): boolean {
    const fromIndex = this.tabOrder.indexOf(tabId);
    if (fromIndex === -1 || toIndex < 0 || toIndex >= this.tabOrder.length) return false;
    this.tabOrder.splice(fromIndex, 1);
    this.tabOrder.splice(toIndex, 0, tabId);
    this.broadcastState();
    return true;
  }
  public duplicateTab(tabId: string): string {
    const tab = this.tabs.get(tabId);
    if (!tab) return '';
    const targetUrl = tab.state.url || 'https://www.google.com';
    const newTabId = this.createTab(targetUrl);
    const oldIndex = this.tabOrder.indexOf(tabId);
    if (newTabId && oldIndex !== -1) {
      // Place the duplicated tab directly to the right of the original tab
      this.moveTab(newTabId, oldIndex + 1);
    }
    return newTabId;
  }

  public closeOtherTabs(tabId: string): void {
    const toClose = this.tabOrder.filter((id) => id !== tabId);
    for (const id of toClose) {
      const tab = this.tabs.get(id);
      if (tab && tab.state.ephemeral === true) continue;
      this.closeTab(id, 'user-close-other');
    }
  }

  public closeTabsToRight(tabId: string): void {
    const idx = this.tabOrder.indexOf(tabId);
    if (idx === -1) return;
    const toClose = this.tabOrder.slice(idx + 1);
    for (const id of toClose) {
      const tab = this.tabs.get(id);
      if (tab && tab.state.ephemeral === true) continue;
      this.closeTab(id, 'user-close-right');
    }
  }

  public navigate(tabId: string, inputUrl: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    if (!isAllowedNavigation(cleanUrl)) {
      return false;
    }
    // A hibernated tab rebuilds its views WITHOUT loading: the normal navigate
    // path below loads `cleanUrl` itself, and pre-loading `state.url` (the URL
    // it slept on) would double the fetch. `ensureTabAwake` is for wake-on-read
    // and switch, where restoring the saved URL is the point.
    if (tab.state.hibernated === true) {
      this.recreateDesktopView(tabId, tab);
      if (tab.state.splitMode === true) this.recreateMobileView(tabId, tab);
      tab.state.hibernated = false;
    }
    tab.state.url = cleanUrl;
    this.networkTracker.resetInflight(tabId, 'desktop');
    if (tab.state.splitMode) {
      this.networkTracker.resetInflight(tabId, 'mobile');
    }
    if (cleanUrl.startsWith('view-source:')) {
      const sourceTargetUrl = cleanUrl.slice('view-source:'.length).trim();
      tab.state.title = `view-source:${sourceTargetUrl}`;
      const dWc = tab.view?.webContents;
      if (dWc && !dWc.isDestroyed()) this.fetchAndLoadPageSource(dWc, sourceTargetUrl, tab.state);
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        this.fetchAndLoadPageSource(tab.mobileView.webContents, sourceTargetUrl, tab.state);
      }
    } else {
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
        this.splitCoordinator.startTransaction(tabId, authorityPane, cleanUrl);
        const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;
        authorityView?.webContents.loadURL(cleanUrl).catch(() => {});
      } else {
        tab.view?.webContents.loadURL(cleanUrl).catch(() => {});
      }
    }
    return true;
  }
  public async navigateAndWait(tabId: string, inputUrl: string, timeoutMs: number = 20000): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    if (cleanUrl.startsWith('view-source:')) {
      return this.navigate(tabId, inputUrl);
    }
    const currentUrl = (tab.state.url || '').replace(/\/$/, '');
    const targetUrl = sanitizeUrl(inputUrl).replace(/\/$/, '');
    if (currentUrl && targetUrl === currentUrl) {
      return this.reloadAndWait(tabId, timeoutMs);
    }
    // Materialize a hibernated view before resolving the authority view — the
    // lifecycle waiter needs a real webContents to listen on. `navigate` skips
    // its own rebuild once `hibernated` is cleared.
    if (tab.state.hibernated === true) {
      this.recreateDesktopView(tabId, tab);
      if (tab.state.splitMode === true) this.recreateMobileView(tabId, tab);
      tab.state.hibernated = false;
    }
    const authorityPane = tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()
      ? (tab.focusedPane || tab.state.splitFocusedPane || 'desktop')
      : 'desktop';
    const authorityView = authorityPane === 'mobile' && tab.mobileView ? tab.mobileView : tab.view;
    if (!authorityView || authorityView.webContents.isDestroyed()) return false;

    this.lastNavigationFailures.delete(tabId);
    const waiter = this.createNavigationLifecycleWaiter(authorityView.webContents, timeoutMs, Math.min(3000, timeoutMs), tabId, cleanUrl);
    const initiated = this.navigate(tabId, inputUrl);
    if (!initiated) {
      this.lastNavigationFailures.set(tabId, {
        cause: 'NAVIGATION_BLOCKED',
        message: `Navigation to "${cleanUrl}" was blocked or disallowed`,
        timedOut: false,
      });
      waiter.cancel();
      return false;
    }
    const loadOk = await waiter.promise;
    if (!loadOk) return false;
    return true;
  }
  public reload(tabId: string, options?: { ownedReloadToken?: string }): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (options?.ownedReloadToken) {
      this.registerOwnedReload(tabId, options.ownedReloadToken);
    }
    // A hibernated tab's wake IS the reload: `ensureTabAwake` rebuilds the view
    // and loads the saved URL. Touching `tab.view` here would throw — it is
    // undefined until the wake materializes it.
    if (tab.state.hibernated === true) {
      this.ensureTabAwake(tabId);
      return true;
    }
    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
      if (tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        tab.mobileView.webContents.reload();
      }
    } else {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
    }
    return true;
  }
  public async reloadAndWait(tabId: string, timeoutMs: number = 20000, options?: { ownedReloadToken?: string }): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (options?.ownedReloadToken) {
      this.registerOwnedReload(tabId, options.ownedReloadToken);
    }
    const isBackground = tabId !== this.activeTabId;
    const effectiveTimeoutMs = timeoutMs !== 20000 ? timeoutMs : (isBackground ? 25000 : 20000);
    // A hibernated tab's wake IS the reload: rebuild + loadURL, then settle on
    // the same did-stop-loading gate capability callers use.
    if (tab.state.hibernated === true) {
      this.ensureTabAwake(tabId);
      return this.ensureTabReady(tabId, Math.max(effectiveTimeoutMs, 20000));
    }
    const isSplit = Boolean(tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed());

    // Reset inflight records for reload and ensure active debugger attachment
    const reloadWc = tab.view?.webContents;
    if (!reloadWc || reloadWc.isDestroyed()) return false;
    this.networkTracker.resetInflight(tabId, 'desktop');
    await this.networkTracker.ensureAttached(
      tabId,
      'desktop',
      reloadWc,
      () => this.tabs.get(tabId)?.state.url || ''
    );
    // A timed-out load waiter used to settle unclassified, so callers read the
    // same no-record path as a genuinely stale tab and wrapped a reload timeout
    // in TARGET_STALE. Record the timeout cause so the wire code classifies it.
    const recordReloadTimeout = () => {
      this.lastNavigationFailures.set(tabId, {
        cause: 'NAVIGATION_TIMEOUT',
        message: `Navigation load completion timed out after ${effectiveTimeoutMs}ms`,
        timedOut: true,
      });
    };
    const desktopWaiter = this.createLoadCompletionWaiter(reloadWc, effectiveTimeoutMs, recordReloadTimeout);

    let mobileWaiter: { promise: Promise<boolean>; cancel: () => void } | null = null;
    if (isSplit && tab.mobileView) {
      this.networkTracker.resetInflight(tabId, 'mobile');
      await this.networkTracker.ensureAttached(
        tabId,
        'mobile',
        tab.mobileView.webContents,
        () => this.tabs.get(tabId)?.state.url || ''
      );
      mobileWaiter = this.createLoadCompletionWaiter(tab.mobileView.webContents, effectiveTimeoutMs, recordReloadTimeout);
    }

    const initiated = this.reload(tabId, options);
    if (!initiated) {
      desktopWaiter.cancel();
      mobileWaiter?.cancel();
      return false;
    }

    const [desktopOk, mobileOk] = await Promise.all([
      desktopWaiter.promise,
      mobileWaiter ? mobileWaiter.promise : Promise.resolve(true),
    ]);

    if (!desktopOk || !mobileOk) return false;

    // The load waiter already saw did-finish-load, so this only catches the
    // first-party requests a page fires right after load. 150 ms of silence is
    // enough for that; the old 500 ms window was dead time on every reload.
    // An explicit `browser.wait` network condition keeps its own 500 ms default.
    const quiet = { idleWindowMs: RELOAD_SETTLE_IDLE_MS, maxCeilingMs: Math.min(2000, effectiveTimeoutMs) };
    await Promise.all([
      this.networkTracker.awaitQuiescence(tabId, 'desktop', quiet),
      isSplit ? this.networkTracker.awaitQuiescence(tabId, 'mobile', quiet) : Promise.resolve(),
    ]);

    return true;
  }
  public getNetworkTracker(): FirstPartyNetworkTracker {
    return this.networkTracker;
  }

  private createLoadCompletionWaiter(wc: Electron.WebContents, timeoutMs: number = 20000, onTimeout?: () => void): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      let domIsReady = false;
      const onDomReady = () => {
        domIsReady = true;
      };
      const onFinish = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(true);
        }
      };
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, _validatedURL: unknown, isMainFrame?: boolean) => {
        if (isMainFrame === false) {
          return;
        }
        if (errorCode === -3 || errorDescription === 'ERR_ABORTED') {
          return;
        }
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          // onTimeout runs inside the resolve(false) arm only — a cancelled or
          // load-failed waiter is not a navigation timeout and stays
          // unclassified so the caller's no-record path keeps its meaning.
          try { onTimeout?.(); } catch {}
          cleanup();
          resolve(false);
        }
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        try { wc.removeListener('dom-ready', onDomReady); } catch {}
        try { wc.removeListener('did-finish-load', onFinish); } catch {}
        try { wc.removeListener('did-fail-load', onFail); } catch {}
      };
      cancelFn = () => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(false);
        }
      };
      try { wc.once('dom-ready', onDomReady); } catch {}
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
    });
    return { promise, cancel: cancelFn };
  }

  private createNavigationLifecycleWaiter(
    wc: Electron.WebContents,
    timeoutMs: number = 20000,
    startTimeoutMs: number = 3000,
    tabId?: string,
    committedTargetUrl?: string
  ): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      let navStarted = false;
      let navFailed = false;
      let rechecking = false;
      let startTimer: NodeJS.Timeout | null = null;
      let totalTimer: NodeJS.Timeout | null = null;
      let recheckTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
        if (recheckTimer) {
          clearTimeout(recheckTimer);
          recheckTimer = null;
        }
        try { wc.removeListener('did-start-navigation', onStart); } catch {}
        try { wc.removeListener('did-finish-load', onFinish); } catch {}
        try { wc.removeListener('did-fail-load', onFail); } catch {}
        try { wc.removeListener('did-navigate-in-page', onInPage); } catch {}
        try { wc.removeListener('destroyed', onWcDestroyed); } catch {}
      };

      const finish = (result: boolean) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
      };

      // A torn-down WebContents settles unclassified — that is a stale target,
      // not a navigation timeout, so the port's no-record TARGET_STALE stays
      // correct and no NAVIGATION_* record is written for it.
      const onWcDestroyed = () => finish(false);

      // The committed URL is the post-redirect getURL(): once this navigation
      // starts, did-start-navigation resets redirectChain and did-navigate
      // appends each resolved URL, so the chain tail names where the document
      // actually committed. Before any start event the chain may be stale, so
      // only the requested target is trusted then — a readyState='complete'
      // read alone would describe the OLD document and false-positive.
      const committedMatches = (liveUrl: string): boolean => {
        // Every match requires this navigation to have started: on the start-timeout
        // path (`!navStarted`) `readyState==='complete' && getURL()===target` describes
        // the OLD document of a same-URL reload that never fired did-start-navigation —
        // a false success for a navigation that never happened (previously a timeout).
        if (!navStarted || !tabId) return false;
        const live = String(liveUrl || '').replace(/\/$/, '');
        const wanted = String(committedTargetUrl || '').replace(/\/$/, '');
        if (live && wanted && live === wanted) return true;
        const chain = this.tabs.get(tabId)?.redirectChain;
        const tail = chain && chain.length ? String(chain[chain.length - 1]).replace(/\/$/, '') : '';
        return Boolean(live && tail && live === tail);
      };

      // Timeout alone is not proof the navigation missed: a heavy page can
      // commit just past the bound. Give it one bounded recheck window that
      // still accepts did-finish-load / did-navigate-in-page, plus a
      // readyState='complete' probe gated on the committed URL. Failing the
      // window writes the timeout record only then.
      // readyState 'complete' + a matching getURL() also describe the
      // chrome-error:// interstitial Chromium commits for a failed load
      // (getURL on it reports the FAILED target URL — ERR_UNSAFE_PORT was
      // observed answering navigated:true off exactly this). The probe must
      // reject error documents and the latched navFailed must veto, so a
      // late did-fail-load can never lose to an error-page readyState.
      const endGraceRecheck = (record: () => void) => {
        if (!settled) {
          try {
            if (!wc.isDestroyed() && !navFailed) record();
          } catch {}
          finish(false);
        }
      };
      const beginGraceRecheck = (record: () => void) => {
        if (settled || rechecking || navFailed) return;
        rechecking = true;
        try { wc.once('destroyed', onWcDestroyed); } catch {}
        try {
          wc.executeJavaScript('document.readyState === "complete" && document.location.protocol !== "chrome-error:"')
            .then((ready: unknown) => {
              if (settled || navFailed) return;
              let live = '';
              try { live = wc.isDestroyed() ? '' : wc.getURL(); } catch { live = ''; }
              if (ready === true && live && committedMatches(live)) {
                if (tabId) this.lastNavigationFailures.delete(tabId);
                finish(true);
              }
            })
            .catch(() => {});
        } catch {}
        recheckTimer = setTimeout(() => {
          recheckTimer = null;
          endGraceRecheck(record);
        }, 500);
        recheckTimer.unref?.();
      };

      const onStart = (_event: unknown, _url: unknown, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace && !settled) {
          navStarted = true;
          if (startTimer) {
            clearTimeout(startTimer);
            startTimer = null;
          }
        }
      };

      const onFinish = () => {
        // ONLY accept finish after this navigation has started in main-frame
        // (non-in-place) and no main-frame failure was recorded for it: an
        // error page fires did-finish-load too, so a latched failure vetoes.
        if (!settled && !navFailed && navStarted) {
          if (tabId) {
            this.lastNavigationFailures.delete(tabId);
          }
          finish(true);
        }
      };

      const onInPage = (_event: unknown, _url: unknown, isMainFrame: boolean) => {
        if (isMainFrame && !settled && !navFailed) {
          if (tabId) {
            this.lastNavigationFailures.delete(tabId);
          }
          finish(true);
        }
      };
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, validatedURL: unknown, isMainFrame?: boolean) => {
        if (isMainFrame === false) {
          return;
        }
        // Chromium emits ERR_ABORTED (-3) on HTTP 301/302/307 redirects or request replacements
        if (errorCode === -3 || errorDescription === 'ERR_ABORTED') {
          return;
        }
        // Attribute the failure to this navigation when it already started,
        // or — delivery can race did-start-navigation under load — when the
        // failed URL names the requested target. An unattributed leftover
        // failure from the previous document must not veto a real commit.
        const failedUrl = String(validatedURL || '').replace(/\/$/, '');
        const wanted = String(committedTargetUrl || '').replace(/\/$/, '');
        const attributed = navStarted || Boolean(failedUrl && wanted && failedUrl === wanted);
        if (!settled && attributed) {
          // Once a failed load for this navigation is recorded, no success arm
          // may resolve true — an error-page did-finish-load or a readyState
          // probe on the interstitial is not a commit.
          navFailed = true;
          if (tabId) {
            this.lastNavigationFailures.set(tabId, {
              cause: 'LOAD_FAILED',
              message: `Navigation failed: ${errorDescription || errorCode}`,
              timedOut: false,
            });
          }
          finish(false);
        }
      };

      startTimer = setTimeout(() => {
        if (!settled && !navStarted) {
          beginGraceRecheck(() => {
            if (tabId) {
              this.lastNavigationFailures.set(tabId, {
                cause: 'NAVIGATION_START_TIMEOUT',
                message: `Navigation start timed out after ${Math.min(startTimeoutMs, timeoutMs)}ms`,
                timedOut: true,
              });
            }
          });
        }
      }, Math.min(startTimeoutMs, timeoutMs));

      totalTimer = setTimeout(() => {
        if (!settled && navStarted && !rechecking) {
          beginGraceRecheck(() => {
            if (tabId) {
              this.lastNavigationFailures.set(tabId, {
                cause: 'NAVIGATION_TIMEOUT',
                message: `Navigation load completion timed out after ${timeoutMs}ms`,
                timedOut: true,
              });
            }
          });
        }
      }, timeoutMs);
      cancelFn = () => {
        finish(false);
      };

      wc.on('did-start-navigation', onStart);
      wc.on('did-finish-load', onFinish);
      wc.on('did-fail-load', onFail);
      wc.on('did-navigate-in-page', onInPage);
    });

    return { promise, cancel: cancelFn };
  }

  public getLastNavigationFailure(tabId: string): { cause: string; message: string; timedOut: boolean } | undefined {
    return this.lastNavigationFailures.get(tabId);
  }

  public getTabUrl(tabId: string): string {
    const tab = this.tabs.get(tabId);
    if (!tab) return '';
    try {
      if (tab.view && !tab.view.webContents.isDestroyed()) {
        const live = tab.view.webContents.getURL();
        if (live) return live;
      }
    } catch {}
    return tab.state?.url || '';
  }

  public getRedirectChain(tabId: string): string[] {
    const tab = this.tabs.get(tabId);
    return tab?.redirectChain ? [...tab.redirectChain] : [];
  }

  public stopLoading(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (tab.state.hibernated === true) return true; // nothing is loading while asleep
    tab.view?.webContents.stop();
    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.stop();
    }
    return true;
  }

  public goBack(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    // Hibernated history is intentionally not restored — back on a sleeping tab
    // wakes it (current URL loads) and then finds no back-entry; returning
    // false is the honest answer, matching a freshly re-created renderer.
    if (tab.state.hibernated === true) return false;

    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
      const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;
      if (!authorityView) return false;

      const canAuthBack = this.getCanGoBack(authorityView.webContents);
      if (!canAuthBack) return false;

      this.splitCoordinator.startHistoryTransaction(tabId, authorityPane, 'back');
      return this.safeGoBack(authorityView.webContents);
    }

    const dWc = tab.view?.webContents;
    if (!dWc || dWc.isDestroyed()) return false;
    return this.safeGoBack(dWc);
  }

  public goForward(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (tab.state.hibernated === true) return false;

    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
      const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;
      if (!authorityView) return false;

      const canAuthFwd = this.getCanGoForward(authorityView.webContents);
      if (!canAuthFwd) return false;

      this.splitCoordinator.startHistoryTransaction(tabId, authorityPane, 'forward');
      return this.safeGoForward(authorityView.webContents);
    }

    const dWc = tab.view?.webContents;
    if (!dWc || dWc.isDestroyed()) return false;
    return this.safeGoForward(dWc);
  }

  public toggleSplitReview(tabId: string, enabled?: boolean): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const targetEnabled = enabled !== undefined ? enabled : !tab.state.splitMode;

    if (targetEnabled === tab.state.splitMode) {
      return Boolean(tab.state.splitMode);
    }

    tab.state.splitMode = targetEnabled;
    if (targetEnabled) {
      tab.state.splitDesktopPresetId = tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET;
      tab.state.splitMobilePresetId = tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET;
      tab.state.splitFocusedPane = 'desktop';
      tab.focusedPane = 'desktop';
      tab.state.splitError = null;

      if (!tab.mobileView) {
        const mobileView = new WebContentsView({
          webPreferences: getSecureWebPreferences(tab.state.partition),
        });
        mobileView.setBackgroundColor('#ffffff');
        const mobilePreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const mobileUA = getPresetUserAgent(mobilePreset, IPHONE_USER_AGENT);
        this.setSafeUserAgent(mobileView.webContents, mobileUA || IPHONE_USER_AGENT);
        tab.mobileView = mobileView;
        this.tabByWebContents?.set(mobileView.webContents, { tabId, tab });
        this.setupTabWebContentsEvents(tabId, mobileView, tab.state, 'mobile');

        if (tabId === this.activeTabId) {
          this.attachTabView(mobileView, true);
        }

        if (tab.state.url && tab.state.url !== 'about:blank' && !tab.state.url.startsWith('view-source:') && isAllowedNavigation(tab.state.url)) {
          mobileView.webContents.loadURL(tab.state.url).catch(() => {});
        }
      }
      if (tab.state.url && tab.state.url !== 'about:blank' && !tab.state.url.startsWith('view-source:') && isAllowedNavigation(tab.state.url)) {
        // The mirror transaction mirrors the mount itself: the desktop pane holds
        // the live document and is the authority; the mobile pane's initial load
        // (or the view's already-loaded document) is the host-driven mirror of it.
        // Seeding here settles that commit as the expected echo, so it can never
        // claim mobile authority and drive a correction against the live pane.
        this.splitCoordinator.startTransaction(tabId, 'desktop', cleanRestoredUrl(tab.state.url));
      }
    } else {
      if (tab.mobileView) {
        if (tabId === this.activeTabId) {
          try {
            this.shell.window.contentView.removeChildView(tab.mobileView);
          } catch {}
        }
        try {
          this.destroyOwnedWebContents(tab.mobileView.webContents);
        } catch {}
        this.tabByWebContents?.delete(tab.mobileView.webContents);
        tab.mobileView = undefined;
      }
      tab.state.splitFocusedPane = undefined;
      tab.focusedPane = undefined;
      tab.state.splitError = null;
      this.splitCoordinator.cleanupTab(tabId);
    }
    this.applyTabThrottling();
    this.updateLayout();
    this.broadcastState();
    return Boolean(tab.state.splitMode);
  }

  public setSplitPreset(tabId: string, paneId: SplitPaneId, presetId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (paneId === 'desktop') {
      tab.state.splitDesktopPresetId = presetId;
    } else {
      tab.state.splitMobilePresetId = presetId;
    }

    this.updateLayout();
    this.broadcastState();
    this.schedulePersist();
    return true;
  }

  public setSplitFocusedPane(tabId: string, paneId: SplitPaneId): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    tab.focusedPane = paneId;
    tab.state.splitFocusedPane = paneId;
    this.broadcastState();
    return true;
  }

  private applyTabDeviceEmulation(
    tab: NativeTabRecord,
    availableWidth: number,
    availableHeight: number,
    toolbarHeight: number
  ): void {
    if (!tab || !tab.view) return;
    if (tab.view.webContents.isDestroyed()) return;

    try {
      // Case A: Split Review Mode (Desktop + Mobile Paired WebContentsViews)
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        const userZoom = tab.state.zoomFactor || 1.0;
        const splitLayout = calculateSplitLayout(
          { width: availableWidth, height: availableHeight, yOffset: toolbarHeight },
          tab.state.splitDesktopPresetId || DEFAULT_SPLIT_DESKTOP_PRESET,
          tab.state.splitMobilePresetId || DEFAULT_SPLIT_MOBILE_PRESET,
          userZoom
        );
        // Both panes always restore the opaque view background. Besides the preset
        // emulation path below, this branch is the only other writer of the tab's
        // background colour, so it must never leave a pane transparent: an
        // unpainted pane would then show the dark window backdrop through the view.
        try { tab.view.setBackgroundColor('#ffffff'); } catch {}
        try { tab.mobileView?.setBackgroundColor('#ffffff'); } catch {}

        // Dynamic corner clipping for mobile pane, clear for desktop
        const splitMobilePreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const splitMobileClipRadius = getPresetCornerRadius(splitMobilePreset);
        this.applyDeviceCornerClipping(tab.view.webContents, 0);
        this.applyDeviceCornerClipping(tab.mobileView.webContents, splitMobileClipRadius);
        const desktopPreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitDesktopPresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_DESKTOP_PRESET);
        const desktopUA = getPresetUserAgent(desktopPreset, this.defaultUserAgent);
        this.setSafeUserAgent(tab.view.webContents, desktopUA || this.defaultUserAgent);
        this.applyCdpTouchEmulation(tab.view.webContents, false);
        this.applyCdpDeviceEmulationState(tab.view.webContents, desktopPreset, splitLayout.desktop.scale);
        // Emulation scale already handles visual zoom; keep zoomFactor at 1 to prevent double-scaling
        try {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(1);
          }
        } catch {}
        try {
          tab.view.setBounds({
            x: splitLayout.desktop.x,
            y: splitLayout.desktop.y,
            width: splitLayout.desktop.width,
            height: splitLayout.desktop.height,
          });
        } catch {}

        // Mobile view emulation & bounds
        const mobilePreset = DEVICE_PRESETS.find((p) => p.id === tab.state.splitMobilePresetId) || DEVICE_PRESETS.find((p) => p.id === DEFAULT_SPLIT_MOBILE_PRESET);
        const mobileUA = getPresetUserAgent(mobilePreset, IPHONE_USER_AGENT);
        this.setSafeUserAgent(tab.mobileView.webContents, mobileUA || IPHONE_USER_AGENT);
        this.applyCdpTouchEmulation(tab.mobileView.webContents, true);
        this.applyCdpDeviceEmulationState(tab.mobileView.webContents, mobilePreset, splitLayout.mobile.scale);
        try {
          if (!tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
          }
        } catch {}
        // Emulation scale already handles visual zoom; keep zoomFactor at 1 to prevent double-scaling
        try {
          if (!tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.setZoomFactor(1);
          }
        } catch {}
        try {
          tab.mobileView.setBounds({
            x: splitLayout.mobile.x,
            y: splitLayout.mobile.y,
            width: splitLayout.mobile.width,
            height: splitLayout.mobile.height,
          });
        } catch {}
        return;
      }

      // Case B: Standard Single-View Preset or Fluid Responsive
      let preset: DevicePreset | undefined = DEVICE_PRESETS.find((p) => p.id === tab.state.devicePresetId);
      if (!preset && tab.customViewport && tab.customViewport.width > 0 && tab.customViewport.height > 0) {
        preset = {
          id: tab.state.devicePresetId || `custom-${tab.customViewport.width}x${tab.customViewport.height}`,
          name: `Custom (${tab.customViewport.width}x${tab.customViewport.height})`,
          width: tab.customViewport.width,
          height: tab.customViewport.height,
          deviceScaleFactor: tab.customViewport.deviceScaleFactor ?? (tab.customViewport.mobile ? 2 : 1),
          mobile: tab.customViewport.mobile ?? (tab.customViewport.width < 768),
          category: tab.customViewport.mobile ? 'mobile' : (tab.customViewport.width < 1024 ? 'tablet' : 'desktop'),
        };
      } else if (!preset && tab.state.devicePresetId && /^\d+x\d+$/.test(tab.state.devicePresetId)) {
        const parts = tab.state.devicePresetId.split('x').map(Number);
        const w = parts[0];
        const h = parts[1];
        if (typeof w === 'number' && typeof h === 'number' && !Number.isNaN(w) && !Number.isNaN(h) && w > 0 && h > 0) {
          preset = {
            id: tab.state.devicePresetId,
            name: `Custom (${w}x${h})`,
            width: w,
            height: h,
            deviceScaleFactor: w < 768 ? 2 : 1,
            mobile: w < 768,
            category: w < 768 ? 'mobile' : (w < 1024 ? 'tablet' : 'desktop'),
          };
        }
      }
      if (preset && preset.width && preset.height) {
        const userZoom = tab.state.zoomFactor || 1.0;
        const maxW = Math.max(100, availableWidth);
        const maxH = Math.max(100, availableHeight);

        const fitScale = Math.min(1.0, maxW / preset.width, maxH / preset.height);
        // Fitting a preset into the window is a preview affordance for the tab the user
        // is looking at. Two kinds of target must render at exactly the viewport they
        // were asked for instead: an agent-plane tab, and any tab that is not the active
        // one, which is measured and captured
        // by a caller that requested an exact CSS viewport. Measured before this rule:
        // a 1440x900 request on a background tab laid the document out at 1186 CSS px
        // (window 1186 wide) and a 390x844 request at 342, while the capture rasterized
        // the requested size — the tab reported a viewport it never had.
        const isAgentPlane = tab.state.ephemeral === true;
        const rendersExactly = isAgentPlane || tab.state.id !== this.activeTabId;
        const renderScale = Math.max(0.1, Math.min(5.0, rendersExactly ? userZoom : fitScale * userZoom));
        const renderedW = Math.round(preset.width * renderScale);
        const renderedH = Math.round(preset.height * renderScale);
        const targetX = Math.max(0, Math.floor((maxW - renderedW) / 2));
        const targetY = toolbarHeight + Math.max(0, Math.floor((maxH - renderedH) / 2));

        const ua = getPresetUserAgent(preset, preset.mobile ? IPHONE_USER_AGENT : this.defaultUserAgent);
        this.setSafeUserAgent(tab.view.webContents, ua || this.defaultUserAgent);
        this.applyCdpTouchEmulation(tab.view.webContents, Boolean(preset.mobile));
        this.applyCdpDeviceEmulationState(tab.view.webContents, preset, renderScale);
        if (preset.mobile) {
          try {
            if (!tab.view.webContents.isDestroyed()) {
              tab.view.webContents.insertCSS(MOBILE_OVERLAY_SCROLLBAR_CSS).catch(() => {});
            }
          } catch {}
        }

        // Guest canvas stays the UA default white on every preset, including rounded
        // phones. A transparent view (`#00000000`) lets frameBackdropView `#060910`
        // show through any page that leaves html/body unpainted — the collection
        // page that "inherited AntiFan dark mode". Corner clipping no longer punches
        // the document (it only removes leftover `#antifan-device-clip`), and
        // single-tab mode hides the phone chassis, so there is nothing for a
        // transparent view to reveal. Split-review already keeps both panes
        // `#ffffff`; this branch must match. Do not inject document CSS: that
        // breaks CSS 2.1 Appendix E canvas propagation and Shopify negative z-index.
        const clipRadius = getPresetCornerRadius(preset);
        try { tab.view.setBackgroundColor('#ffffff'); } catch {}
        this.applyDeviceCornerClipping(tab.view.webContents, clipRadius);

        // Emulation scale already handles visual zoom; keep zoomFactor at 1 to prevent double-scaling
        try {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(1);
          }
        } catch {}
        // The view is where the device is drawn, and the emulation above is applied
        // with scale = renderScale, so the drawn box is renderedW x renderedH. Sizing
        // the view to the unscaled preset instead left the unpainted remainder
        // (window background, i.e. a dark band) to the right and below the page,
        // which reads as the device being pushed into the top-left corner; the view
        // and the centering basis must be the same box.
        const boundsW = renderedW;
        const boundsH = renderedH;
        try {
          tab.view.setBounds({
            x: targetX,
            y: targetY,
            width: boundsW,
            height: boundsH,
          });
        } catch {}
      } else {
        this.applyDeviceCornerClipping(tab.view.webContents, 0);
        try { tab.view.setBackgroundColor('#ffffff'); } catch {}
        this.applyCdpTouchEmulation(tab.view.webContents, false);
        this.applyCdpDeviceEmulationState(tab.view.webContents, null);
        this.setSafeUserAgent(tab.view.webContents, this.defaultUserAgent);

        const userZoom = tab.state.zoomFactor || 1.0;
        try {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.setZoomFactor(userZoom);
          }
        } catch {}
        try {
          tab.view.setBounds({
            x: 0,
            y: toolbarHeight,
            width: availableWidth,
            height: availableHeight,
          });
        } catch {}
      }
    } catch (err) {
      console.error('[native-tab-host] applyTabDeviceEmulation error:', err);
    }
  }
  public applyTabDeviceEmulationForTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    // Emulation is sized from this window's content box, and a DevTools- or teardown-driven
    // request can arrive after that window is gone; the destroyed check is the only honest
    // answer, because the method reference still exists on a destroyed window.
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || typeof this.shell.window.getContentBounds !== 'function') return;
    const { width, height } = this.shell.window.getContentBounds();
    const availableWidth = this.shell.isSidebarOpen ? Math.max(400, width - this.shell.sidebarWidth) : width;
    const toolbarHeight = this.getToolbarHeight();
    const availableHeight = Math.max(0, height - toolbarHeight);
    this.applyTabDeviceEmulation(tab, availableWidth, availableHeight, toolbarHeight);
  }
  private restoreMutedSites(value: unknown): void {
    this.mutedSites = new Set(Array.isArray(value)
      ? value.filter((site): site is string => typeof site === 'string' && getMuteSite(`https://${site}`) === site)
      : []);
  }

  private applySiteMute(wc: Electron.WebContents, state: AntiFanTab, paneId: SplitPaneId, url: string): void {
    if (wc.isDestroyed()) return;
    const site = getMuteSite(url);
    const muted = site !== undefined && this.mutedSites.has(site);
    wc.setAudioMuted(muted);
    if (paneId === 'desktop') state.isMuted = muted;
  }

  private toggleSiteMute(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view?.webContents.isDestroyed()) return false;
    const muteWc = tab.view?.webContents;
    if (!muteWc) return false;
    const site = getMuteSite(muteWc.getURL());
    if (!site) return false;
    if (this.mutedSites.has(site)) this.mutedSites.delete(site);
    else this.mutedSites.add(site);
    for (const record of this.tabs.values()) {
      const desktop = record.view?.webContents;
      if (desktop && !desktop.isDestroyed() && getMuteSite(desktop.getURL()) === site) {
        this.applySiteMute(desktop, record.state, 'desktop', desktop.getURL());
      }
      const mobile = record.mobileView?.webContents;
      if (mobile && !mobile.isDestroyed() && getMuteSite(mobile.getURL()) === site) {
        this.applySiteMute(mobile, record.state, 'mobile', mobile.getURL());
      }
    }
    this.schedulePersist();
    this.broadcastState();
    return true;
  }

  public setZoom(tabId: string, zoomFactor: number): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const clamped = Math.max(0.25, Math.min(zoomFactor, 5.0));
    tab.state.zoomFactor = clamped;
    this.updateLayout();
    this.broadcastState();
    return true;
  }
  private applyCdpTouchEmulation(wc: Electron.WebContents, enableTouch: boolean): Promise<void> {
    if (!wc || (wc as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) return Promise.resolve();
    const current = this.touchEmulationStates.get(wc);
    if (
      current &&
      current.desired === enableTouch &&
      (!current.settled || !enableTouch || Boolean(wc.debugger?.isAttached()))
    ) {
      return current.promise;
    }

    const state = {
      desired: enableTouch,
      settled: false,
      promise: Promise.resolve(),
    };
    state.promise = this.applyCdpTouchEmulationState(wc, enableTouch).finally(() => {
      state.settled = true;
    });
    this.touchEmulationStates.set(wc, state);
    return state.promise;
  }

  private async applyCdpTouchEmulationState(wc: Electron.WebContents, enableTouch: boolean): Promise<void> {
    try {
      if (!wc.debugger) return;
      // Same renderer gate as applyCdpDeviceEmulationState: a touch override sent to
      // a WebContents with no committed document never resolves on this Electron
      // build (the DevTools agent has no target to answer), which would park the
      // per-tab CDP queue in draining for 5s. Touch emulation is meaningless before
      // first paint anyway, so skip rather than defer — the metrics override that
      // follows on did-finish-load re-arms touch through the same call sites.
      try {
        if (typeof wc.getURL === 'function' && wc.getURL().length === 0) return;
      } catch {}
      if (!enableTouch) {
        if (wc.debugger.isAttached()) {
          await this.getDevToolsHost().sendCdpCommand(wc, 'Emulation.setTouchEmulationEnabled', {
            enabled: false,
          }).catch(() => {});
          await this.getDevToolsHost().sendCdpCommand(wc, 'Emulation.setEmitTouchEventsForMouse', {
            enabled: false,
          }).catch(() => {});
        }
        return;
      }

      if (!wc.debugger.isAttached()) {
        try {
          wc.debugger.attach('1.3');
        } catch {}
      }
      if (wc.debugger.isAttached()) {
        await this.getDevToolsHost().sendCdpCommand(wc, 'Emulation.setTouchEmulationEnabled', {
          enabled: true,
          maxTouchPoints: 5,
        }).catch(() => {});
        // Keep touch capability without hijacking mouse movements so hover, context menu, and annotation picker work smoothly
        await this.getDevToolsHost().sendCdpCommand(wc, 'Emulation.setEmitTouchEventsForMouse', {
          enabled: false,
        }).catch(() => {});
      }
    } catch {}
  }
  /**
   * All device emulation state goes through the DevTools agent's Emulation domain:
   * size, device pixel ratio, screen size, and the fit-preview scale are fields of
   * the same `DeviceEmulationParams` the native `WebContents.enableDeviceEmulation`
   * used to carry. The native API is gone because it dereferences the view's render
   * widget host without a null check — a view whose frame host has no widget (never
   * attached, pre-commit, or renderer gone) kills the whole browser process
   * (STATUS_ACCESS_VIOLATION, read of 0x0), and no JS-observable guard can prove
   * the widget exists before the call.
   *
   * The CDP path is NOT unconditionally safe either: a live probe on this Electron
   * build shows `Emulation.setDeviceMetricsOverride` sent to a WebContents that has
   * never committed a navigation (no renderer yet — detached or attached-but-not-
   * loaded) terminates the process the same way. The only reliable gate is whether
   * the view has a committed document, which `getURL()` answers: empty means no
   * renderer exists to emulate. When there is no document yet the override is
   * deferred to `did-finish-load`, which is also the earliest moment the emulation
   * can take visual effect anyway.
   *
   * @param preset The device preset to emulate; `null` clears the override.
   * @param scale  The fit-preview scale the layout computed for this pane
   *               (1 = exact size, <1 = shrunk preview). Same Blink field the
   *               native call carried.
   */
  private async applyCdpDeviceEmulationState(
    wc: Electron.WebContents,
    preset?: DevicePreset | null,
    scale = 1
  ): Promise<void> {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) || !wc.debugger) return;
    if (typeof wc.isCrashed === 'function' && wc.isCrashed()) return;

    // No committed document → no renderer → the metrics override dereferences a
    // missing widget and kills the process. Defer to first load; a clear on a
    // never-emulated view is a no-op and needs no deferral.
    let hasDocument = false;
    try {
      hasDocument = typeof wc.getURL === 'function' && wc.getURL().length > 0;
    } catch {}
    if (!hasDocument) {
      if (!preset) return;
      // updateLayout can call this several times before first commit; keep one
      // pending deferral per WebContents and let the latest preset win.
      const pending = this.pendingEmulationDeferrals.get(wc);
      if (pending) {
        pending.preset = preset;
        pending.scale = scale;
        return;
      }
      const deferral = { preset, scale };
      this.pendingEmulationDeferrals.set(wc, deferral);
      const onLoaded = () => {
        this.pendingEmulationDeferrals.delete(wc);
        void this.applyCdpDeviceEmulationState(wc, deferral.preset, deferral.scale);
      };
      try {
        wc.once('did-finish-load', onLoaded);
        // A failed navigation never fires did-finish-load; drop the listener so a
        // later successful load is not double-armed by repeated calls.
        wc.once('did-fail-load', () => {
          this.pendingEmulationDeferrals.delete(wc);
          try { wc.removeListener('did-finish-load', onLoaded); } catch {}
        });
      } catch {}
      return;
    }

    {
      try {
        if (!wc.debugger.isAttached()) {
          try {
            wc.debugger.attach('1.3');
          } catch {}
        }
        if (!wc.debugger.isAttached()) return;

        const devTools = this.getDevToolsHost();
        if (preset && preset.width && preset.height) {
          const mobileLike = Boolean(preset.mobile || preset.category === 'mobile' || preset.category === 'tablet');
          const ua = getPresetUserAgent(preset, mobileLike ? IPHONE_USER_AGENT : this.defaultUserAgent) || this.defaultUserAgent;
          const platform = getPresetPlatform(preset);
          const dpr = preset.deviceScaleFactor || (mobileLike ? 3 : 1);
          const targetW = Math.round(preset.width);
          const targetH = Math.round(preset.height);
          const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;

          await devTools.sendCdpCommand(wc, 'Emulation.setUserAgentOverride', {
            userAgent: ua,
            acceptLanguage: 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            platform,
          }).catch(() => {});

          await devTools.sendCdpCommand(wc, 'Emulation.setDeviceMetricsOverride', {
            width: targetW,
            height: targetH,
            deviceScaleFactor: dpr,
            mobile: mobileLike,
            screenWidth: targetW,
            screenHeight: targetH,
            scale: safeScale,
          }).catch(() => {});
        } else {
          await devTools.sendCdpCommand(wc, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
          await devTools.sendCdpCommand(wc, 'Emulation.setUserAgentOverride', {
            userAgent: this.defaultUserAgent,
            platform: 'Win32',
          }).catch(() => {});
        }
      } catch (err) {
        console.warn('[native-tab-host] applyCdpDeviceEmulationState error:', err);
      }
    }
  }

  private setSafeUserAgent(wc: Electron.WebContents, targetUA: string): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    if (!targetUA) return;
    try {
      if (typeof wc.setUserAgent === 'function') {
        const currentUA = typeof wc.getUserAgent === 'function' ? wc.getUserAgent() : undefined;
        if (currentUA !== targetUA) {
          wc.setUserAgent(targetUA);
        }
      }
    } catch (err) {
      console.warn('[native-tab-host] Failed to set user agent:', err);
    }
  }

  private applyDeviceCornerClipping(wc: Electron.WebContents, radiusPx: number, force: boolean = false): void {
    if (!wc || (typeof wc.isDestroyed === 'function' && wc.isDestroyed())) return;
    const prev = this.appliedClipRadius.get(wc);
    if (!force && prev === radiusPx) return;
    this.appliedClipRadius.set(wc, radiusPx);
    if (radiusPx <= 0 && (prev === undefined || prev <= 0)) return;
    const script = `(() => {
      const style = document.getElementById('antifan-device-clip');
      if (style) style.remove();
    })()`;
    wc.executeJavaScript(script).catch(() => {});
  }

  public setDevicePreset(tabId: string, presetId: string, options?: { reload?: boolean }): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const resolvedPreset = findDevicePreset(presetId);
    const effectivePresetId = resolvedPreset ? resolvedPreset.id : presetId;
    const oldPreset = findDevicePreset(tab.state.devicePresetId);
    const newPreset = resolvedPreset;
    const oldCategory = oldPreset?.category || (tab.state.devicePresetId === 'responsive' ? 'desktop' : undefined);
    const newCategory = newPreset?.category || (effectivePresetId === 'responsive' ? 'desktop' : undefined);
    const categoryChanged = Boolean(
      (oldCategory && newCategory && oldCategory !== newCategory) ||
      (newCategory === 'mobile' && oldCategory !== 'mobile') ||
      (oldCategory === 'mobile' && newCategory !== 'mobile')
    );
    const shouldReload = options?.reload ?? categoryChanged;

    tab.customViewport = undefined;
    tab.state.devicePresetId = effectivePresetId;
    this.updateLayout();
    // Keep the toolbar Device cluster in sync when the preset is applied from
    // outside the toolbar (MCP set_device_preset), same pair as setZoom.
    this.broadcastState();

    // A hibernated record still answers to preset changes: the new preset
    // persists on the state and is applied when the view wakes; there is no
    // live webContents to resize or reload.
    const presetWc = tab.view?.webContents;
    if (presetWc && !presetWc.isDestroyed()) {
      try {
        presetWc.executeJavaScript(`
          window.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('orientationchange'));
        `).catch(() => {});
      } catch {}

      if (shouldReload) {
        try {
          if (typeof this.reloadAndWait === 'function') {
            this.reloadAndWait(tabId).catch(() => {});
          } else if (typeof presetWc.reload === 'function') {
            presetWc.reload();
          }
        } catch {}
      }
    }
    return true;
  }

  public openExternal(url?: string): boolean {
    const targetUrl = url || this.getActiveTab()?.url;
    if (targetUrl && isAllowedNavigation(targetUrl) && (targetUrl.startsWith('http://') || targetUrl.startsWith('https://'))) {
      shell.openExternal(targetUrl);
      return true;
    }
    return false;
  }

  public toggleBookmark(url: string, title?: string): boolean {
    const existingIndex = this.bookmarks.findIndex((b) => b.url === url);
    if (existingIndex >= 0) {
      this.bookmarks.splice(existingIndex, 1);
      return false;
    } else {
      this.bookmarks.push({
        id: randomUUID(),
        url,
        title: title || url,
        createdAt: Date.now(),
      });
      return true;
    }
  }

  public toggleDevTools(): void {
    const active = this.tabs.get(this.activeTabId);
    if (!active) return;
    const wc = active.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    if (wc.isDevToolsOpened()) {
      wc.closeDevTools();
    } else {
      // `bottom` docks into the WebContentsView and kills the guest compositor
      // (black pane, DOM still in Elements). Context-menu Inspect already uses
      // detach. F12 / toolbar must match.
      wc.openDevTools({ mode: 'detach' });
    }
  }

  public toggleFontFinder(): boolean {
    return this.getDevToolsHost().toggleFontFinder();
  }
  public startFontFinder(): void {
    this.getDevToolsHost().startFontFinder();
  }
  public stopFontFinder(): void {
    this.getDevToolsHost().stopFontFinder();
  }

  public toggleLens(): boolean {
    return this.getDevToolsHost().toggleLens();
  }
  public async startLens(): Promise<void> {
    return this.getDevToolsHost().startLens();
  }
  public stopLens(): void {
    this.getDevToolsHost().stopLens();
  }

  public toggleRuler(): boolean {
    return this.getDevToolsHost().toggleRuler();
  }
  public startRuler(): void {
    this.getDevToolsHost().startRuler();
  }
  public stopRuler(): void {
    this.getDevToolsHost().stopRuler();
  }

  // ─── Agent Browser Automation & Visual Cursor ───
  public async ensureAgentBrowserInjected(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    return this.getAutomationHost().ensureAgentBrowserInjected(tabId, paneId);
  }
  public async dispatchAgentAction(action: 'click' | 'type' | 'move' | 'hover' | 'scroll' | 'highlight' | 'clear' | 'trajectory', params: { selector?: string; ref?: string; x?: number; y?: number; text?: string; clear?: boolean; trusted?: boolean; deltaY?: number; label?: string; tabId?: string; paneId?: SplitPaneId; steps?: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean }): Promise<{ success: boolean; data?: unknown; reason?: string }> {
    const release = this.admitAgentAction(`dispatchAgentAction(${action})`, params.tabId);
    try {
      return await this.getAutomationHost().dispatchAgentAction(action, params);
    } finally {
      release();
    }
  }
  private async executeInIsolatedWorld(wc: Electron.WebContents, script: string): Promise<unknown> {
    return this.getAutomationHost().executeInIsolatedWorld(wc, script);
  }

  public async agentClick(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; trusted?: boolean; force?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const release = this.admitAgentAction('agentClick', params.tabId);
    try {
      return await this.getAutomationHost().agentClick(params);
    } finally {
      release();
    }
  }

  public async agentType(params: { selector?: string; ref?: string; text: string; clear?: boolean; trusted?: boolean; force?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const release = this.admitAgentAction('agentType', params.tabId);
    try {
      return await this.getAutomationHost().agentType(params);
    } finally {
      release();
    }
  }
  public async agentScroll(params: { deltaY?: number; selector?: string; ref?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const release = this.admitAgentAction('agentScroll', params.tabId);
    try {
      return await this.getAutomationHost().agentScroll(params);
    } finally {
      release();
    }
  }

  public async agentHover(params: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const release = this.admitAgentAction('agentHover', params.tabId);
    try {
      return await this.getAutomationHost().agentHover(params);
    } finally {
      release();
    }
  }

  public async agentHighlight(params: { selector?: string; ref?: string; label?: string; color?: string; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const release = this.admitAgentAction('agentHighlight', params.tabId);
    try {
      return await this.getAutomationHost().agentHighlight(params);
    } finally {
      release();
    }
  }
  public async agentClear(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    // Clearing the visual cursor is the one agent surface that must never throw: it is
    // also a cancellation, reached from teardown paths that must not abort their ordered
    // steps. A reserved page refuses it the way `closePage` refuses instead of throwing.
    if (this.isApplicationAdmissionReservedForClose() || (tabId && this.isPageReservedForClose(tabId))) {
      return false;
    }
    return this.getAutomationHost().agentClear(tabId, paneId);
  }
  public async inspectStyles(params: { selector?: string; ref?: string; properties?: string[]; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    return this.getAutomationHost().inspectStyles(params);
  }

  public async inspectRegion(params: { x?: number; y?: number; width?: number; height?: number; selector?: string; ref?: string; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    return this.getAutomationHost().inspectRegion(params);
  }

  public async inspectFont(params: { selector?: string; ref?: string; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    return this.getAutomationHost().inspectFont(params);
  }

  public async getMatchedStylesForNode(params: {
    nodeId?: number;
    selector?: string;
    ref?: string;
    tabId?: string;
    paneId?: SplitPaneId;
  }): Promise<Record<string, unknown> | null> {
    const targetId = params.tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return null;
    const effectivePane: SplitPaneId = params.paneId || 'desktop';
    const wc = this.getTabWebContents(targetId, effectivePane);
    if (!wc || wc.isDestroyed()) return null;

    let targetNodeId = params.nodeId;
    let selector = params.selector;
    let descriptor: SemanticElementDescriptor | undefined;
    if (!targetNodeId && params.ref) {
      const normRef = params.ref.trim().startsWith('@') ? params.ref.trim() : `@${params.ref.trim()}`;
      try {
        const curEpoch = this.browserEpoch;
        const curGen = this.getSemanticDocumentGeneration(targetId, effectivePane);
        const curUrl = wc.getURL();
        descriptor = this.semanticRefRegistry?.resolveRef({
          tabId: targetId,
          paneId: effectivePane,
          browserEpoch: curEpoch,
          documentGeneration: curGen,
          documentUrl: curUrl,
        }, normRef);
      } catch {}
    }

    return this.getDevToolsHost().getMatchedStylesForNode(wc, {
      nodeId: targetNodeId,
      selector,
      descriptor,
    });
  }

  public toggleInspect(): boolean {
    return this.getDevToolsHost().toggleInspect();
  }

  public startInspect(): void {
    this.getDevToolsHost().startInspect();
  }

  public stopInspect(targetTabId?: string): void {
    this.getDevToolsHost().stopInspect(targetTabId);
  }

  public isInspectActive(): boolean {
    return this.getDevToolsHost().isInspectActive();
  }


  /**
   * The capsule a tab was created in, read from the live tab. This is the measured affiliation a
   * routed creation is authorized against: the persisted capsule ledger is written by no runtime
   * path, so reading it would report every tab this build creates as owned by no capsule.
   */
  public getTabCapsuleId(tabId?: string | null): string | undefined {
    const resolved = this.resolveTargetTabId(tabId);
    if (!resolved) return undefined;
    const capsuleId = this.tabs.get(resolved)?.state.capsuleId;
    return typeof capsuleId === 'string' && capsuleId.length > 0 ? capsuleId : undefined;
  }

  public resolveTargetTabId(tabIdOrIdentifier?: string | null): string | undefined {
    if (!tabIdOrIdentifier || typeof tabIdOrIdentifier !== 'string') return undefined;
    const trimmed = tabIdOrIdentifier.trim();
    if (this.tabs && this.tabs.has(trimmed)) return trimmed;
    if (/^#\d+$/.test(trimmed)) {
      const idx = parseInt(trimmed.slice(1), 10) - 1;
      if (idx >= 0 && idx < this.tabOrder.length) {
        return this.tabOrder[idx];
      }
    }
    const numericMatch = /^(?:tab[\s\-]*)?(\d+)$/i.exec(trimmed);
    if (numericMatch && numericMatch[1]) {
      const idx = parseInt(numericMatch[1], 10) - 1;
      if (idx >= 0 && idx < this.tabOrder.length) {
        return this.tabOrder[idx];
      }
    }
    return undefined;
  }

  public hasTab(tabId?: string | null): boolean {
    if (!tabId || !this.tabs) return false;
    return Boolean(this.resolveTargetTabId(tabId));
  }

  /**
   * The affinity projection a badge paints from — one entry per bound terminal.
   *
   * Each lookup is generation-aware on purpose: a generation-less one runs an O(E)
   * prefix scan, and `listSessions()` would slice a transcript per session. A
   * terminal whose session is gone has no badge to paint and is skipped, which
   * matches the session-enumerated version this replaced.
   *
   * Both the pull RPC and the tab broadcast read this, so the work happens once per
   * broadcast in the main process instead of once per requesting renderer.
   */
  public buildTerminalAffinityMap(): Record<string, TerminalAgentAffinityInfo> {
    const result: Record<string, TerminalAgentAffinityInfo> = {};
    const terminalIds = this.getTerminalIdsWithAffinity();
    if (terminalIds.length === 0) return result;
    const tm = TerminalManager.getInstance();
    for (const terminalId of terminalIds) {
      // The strip shows the badges of the terminals this window presents. Another project's
      // terminal id is not this window's to report, or to act on.
      if (!this.isSessionVisibleToWindow(terminalId)) continue;
      const session = tm.getSession(terminalId) as { sessionGeneration?: number } | undefined;
      if (!session) continue;
      const affinity = this.getTerminalAgentAffinity(terminalId, session.sessionGeneration);
      if (affinity) {
        result[terminalId] = affinity;
      }
    }
    return result;
  }

  /**
   * Terminal ids that currently hold an affinity entry. Keys are
   * `${terminalId}@${generation}` and terminal ids never contain `@`, so the id is
   * everything before the final one. O(E) once — never a scan per id.
   */
  private getTerminalIdsWithAffinity(): string[] {
    if (!this.terminalAgentAffinity || this.terminalAgentAffinity.size === 0) return [];
    const ids = new Set<string>();
    for (const key of this.terminalAgentAffinity.keys()) {
      const separator = key.lastIndexOf('@');
      ids.add(separator > 0 ? key.slice(0, separator) : key);
    }
    return Array.from(ids);
  }

  /**
   * A terminal id arrives either bare or wrapped (`{ id }` / `{ sessionId }`);
   * both shapes are already in use across the terminal channels, so the sleep /
   * wake / category handlers accept both instead of throwing on a destructure.
   */
  private resolveTerminalChannelId(payload: unknown): string {
    if (typeof payload === 'string') return payload.trim();
    if (payload && typeof payload === 'object') {
      const record = payload as { id?: unknown; sessionId?: unknown };
      if (typeof record.id === 'string') return record.id.trim();
      if (typeof record.sessionId === 'string') return record.sessionId.trim();
    }
    return '';
  }

  private resolveTerminalAffinityKey(terminalId: string, generation?: number | string): string | undefined {
    const normGen = generation !== undefined && generation !== '' ? String(generation).trim() : undefined;
    if (normGen) {
      const key = `${terminalId}@${normGen}`;
      return this.terminalAgentAffinity.has(key) ? key : undefined;
    }
    const prefix = `${terminalId}@`;
    let latestKey: string | undefined;
    let maxGen = -1;
    for (const key of this.terminalAgentAffinity.keys()) {
      if (key.startsWith(prefix)) {
        const genNum = parseInt(key.slice(prefix.length), 10);
        if (!isNaN(genNum) && genNum > maxGen) {
          maxGen = genNum;
          latestKey = key;
        }
      }
    }
    return latestKey;
  }

  private resolveTerminalAffinityEntry(terminalId: string, generation?: number | string) {
    const key = this.resolveTerminalAffinityKey(terminalId, generation);
    return key ? this.terminalAgentAffinity.get(key) : undefined;
  }

  /**
   * Every live terminal session id, splits included. listSessions() may carry a
   * split either as its own entry or only as the parent's splitSessionId, so
   * both shapes are collected; getSession() is the liveness oracle for anything
   * beyond this list.
   */
  private listTerminalSessionIds(): string[] {
    const tm = TerminalManager.getInstance();
    const ids = new Set<string>();
    for (const s of tm.listSessions()) {
      ids.add(s.id);
      // A split is projected as its own entry by listSessions, so it is usually
      // already in the set; the base entry naming it again must not double it.
      if (s.splitSessionId) ids.add(s.splitSessionId);
    }
    return [...ids];
  }

  /**
   * tab.state.terminalSessionId is the USER's per-tab terminal choice. Agent-side
   * ownership lives in the affinity map, so agent code may only claim the field
   * when it is unset or names a session that no longer exists — never overwrite a
   * live different choice (including an explicit 'auto'). A terminalId that does
   * not name a live session is never written.
   *
   * A split pane owns its browser tab through the affinity map and never through
   * this field: the field is read by the annotation "send to" picker, which offers
   * base running sessions only, so a pane value there would be hidden from the user
   * while still deciding where a prompt goes.
   */
  private claimTabTerminalSession(tab: NativeTabRecord | undefined, terminalId: string): void {
    if (!tab || !terminalId) return;
    const tm = TerminalManager.getInstance();
    // getSession is the liveness oracle: listSessions() composes per-session
    // transcripts and dereferences s.buffer — far too heavy for a membership
    // check.
    const target = tm.getSession(terminalId);
    if (!target || target.splitOf) return;
    const current = tab.state.terminalSessionId;
    if (!current) {
      tab.state.terminalSessionId = terminalId;
      return;
    }
    if (current === 'auto') return;
    const currentSession = tm.getSession(current);
    if (!currentSession) {
      tab.state.terminalSessionId = terminalId;
    }
  }

  public bindTerminalAgentAffinity(terminalId: string, generation: number | string | undefined, tabId: string): boolean {
    if (!this.terminalAgentAffinity) this.terminalAgentAffinity = new Map();
    if (!terminalId || !tabId) return false;
    const tab = this.tabs?.get(tabId);
    if (!tab) return false;
    const tm = TerminalManager.getInstance();
    const session = tm.getSession(terminalId);
    if (!session) return false;
    const resolvedGen = generation !== undefined && generation !== '' ? generation : session.sessionGeneration;
    const prior = this.resolveTerminalAffinityEntry(terminalId, resolvedGen);
    const carryManaged = prior?.managedTabIds
      ? new Set<string>([...prior.managedTabIds].filter((id) => id !== tabId && this.tabs?.has(id)))
      : new Set<string>();
    const carryLastUrls = prior?.lastUrls ? new Map<string, string>(prior.lastUrls) : new Map<string, string>();
    const carryLineage = prior?.lineage ? new Map<string, { tabId: string; parentTabId?: string; source: 'agent_spawned' | 'native_window_open' | 'user_attached'; createdAt: number }>(prior.lineage) : new Map();
    this.dropTerminalAffinityEntries(terminalId);
    const managedTabIds = new Set<string>([tabId, ...carryManaged]);
    const lastUrls = new Map<string, string>(carryLastUrls);
    lastUrls.set(tabId, tab.state.url || '');
    const lineage = new Map(carryLineage);
    lineage.set(tabId, { tabId, source: 'user_attached', createdAt: Date.now() });
    this.terminalAgentAffinity.set(`${terminalId}@${resolvedGen}`, {
      tabId,
      primaryTabId: tabId,
      managedTabIds,
      lineage,
      lastUrls,
      lastUrl: tab.state.url,
      closedAt: undefined,
    });
    this.claimTabTerminalSession(tab, terminalId);
    this.sessionTabPools.set(terminalId, new Set(managedTabIds));
    for (const mId of managedTabIds) {
      this.evictTabFromOtherOwners(mId, terminalId);
      this.claimTabTerminalSession(this.tabs?.get(mId), terminalId);
    }
    return true;
  }

  /**
   * Seats one tab in one ownership record and nowhere else: a tab has a single
   * owning session, so seating it anywhere evicts it from every other pool and
   * affinity entry.
   *
   * Without this rule two owners can hold the same tab — the user's adopt action
   * seats a tab into a second terminal while the affinity map and the pool of the
   * first terminal still name it. Both quota gates then read the tab through
   * whichever pool `getManagedTabIds` resolves first, so releasing the slot for one
   * owner silently shrinks the other's counted set, and a capability aimed at the
   * surviving owner is refused with TARGET_MISMATCH for a tab that is still open.
   * The affinity entry is a third reader — `adoptChildTab`'s cap and the authority
   * scan behind `isTabAllowedForPrimary`/`isTerminalAllowedForTab` — so a copy left
   * there keeps counting a slot the session gave up and keeps authorising a tab it
   * no longer drives.
   *
   * A pool keyed by the tab itself is its own anchored set (the tab is a member and
   * the quota reader returns that pool for it), so it keeps counting the tab; an
   * entry bound to that same tab is that ownership, not a competing one.
   */
  private evictTabFromOtherOwners(tabId: string, ownerKey: string): void {
    if (!tabId) return;
    if (this.sessionTabPools) {
      for (const [poolKey, pool] of Array.from(this.sessionTabPools.entries())) {
        if (poolKey === ownerKey || poolKey === tabId) continue;
        if (!pool.delete(tabId)) continue;
        if (pool.size === 0) this.sessionTabPools.delete(poolKey);
      }
    }
    if (!this.terminalAgentAffinity) return;
    for (const [entryKey, entry] of Array.from(this.terminalAgentAffinity.entries())) {
      if (entryKey.split('@')[0] === ownerKey || entry.primaryTabId === ownerKey) continue;
      if (!this.detachTabFromAffinityEntry(entry, tabId)) continue;
      // The entry owns nothing now, so it is deleted exactly as the unbind path
      // deletes it: no reader has to special-case an empty ownership record.
      if (entry.managedTabIds.size === 0) this.terminalAgentAffinity.delete(entryKey);
    }
  }

  /**
   * Drops ids that no longer name a live tab. Pools and affinity managed sets are
   * pruned lazily — every reader and every quota check runs this first, so a
   * closed tab can never be counted by one gate and ignored by another.
   */
  private pruneDeadTabIds(ids: Set<string>): void {
    for (const id of Array.from(ids)) {
      if (!this.tabs?.has(id)) ids.delete(id);
    }
  }

  public adoptChildTabForSession(sessionId: string, childTabId: string): boolean {
    if (!sessionId || !childTabId) return false;
    let pool = this.sessionTabPools.get(sessionId);
    if (!pool) {
      pool = new Set<string>();
      this.sessionTabPools.set(sessionId, pool);
    }
    this.pruneDeadTabIds(pool);
    if (pool.size >= 10 && !pool.has(childTabId)) {
      return false;
    }
    pool.add(childTabId);
    this.evictTabFromOtherOwners(childTabId, sessionId);
    const tab = this.tabs.get(childTabId);
    if (tab) {
      // Ad-hoc pools are keyed by a tabId, not a terminal session — writing that
      // into terminalSessionId would poison the user's per-tab choice field.
      const candidate = TerminalManager.getInstance().getSession(sessionId);
      const isLiveSession = !!candidate;
      if (isLiveSession) {
        this.claimTabTerminalSession(tab, sessionId);
      }
      this.broadcastState();
    }
    return true;
  }

  public adoptChildTab(
    identifier: string,
    childTabId: string,
    generation?: number | string,
    source: 'agent_spawned' | 'native_window_open' | 'user_attached' = 'agent_spawned',
    parentTabId?: string
  ): boolean {
    if (!this.terminalAgentAffinity || !identifier || !childTabId) return false;
    const childTab = this.tabs?.get(childTabId);
    if (!childTab) return false;

    // Check if identifier is an active session or found in sessionTabPools
    let targetSessionId: string | undefined;
    if (this.sessionTabPools.has(identifier)) {
      targetSessionId = identifier;
    } else {
      for (const [sId, pool] of this.sessionTabPools.entries()) {
        if (pool.has(identifier)) {
          targetSessionId = sId;
          break;
        }
      }
    }

    if (!targetSessionId) {
      try {
        const tm = TerminalManager.getInstance();
        if (tm.getSession(identifier) || tm.getActiveSessionId() === identifier) {
          targetSessionId = identifier;
        }
      } catch {}
    }

    if (!targetSessionId && this.tabs.has(identifier)) {
      // Resolve the parent tab's owning terminal from the affinity map — the
      // authoritative ownership record. tab.state.terminalSessionId is the user's
      // pick and can diverge from what the tab actually owns.
      for (const [key, ent] of this.terminalAgentAffinity.entries()) {
        if (ent.closedAt) continue;
        if (ent.primaryTabId === identifier || ent.managedTabIds?.has(identifier)) {
          targetSessionId = key.split('@')[0] || undefined;
          break;
        }
      }
      if (!targetSessionId) {
        // No affinity entry claims the tab: the field is usable only when it
        // names a live session.
        const fieldSessionId = this.tabs.get(identifier)?.state.terminalSessionId;
        if (fieldSessionId && fieldSessionId !== 'auto') {
          try {
            const tm = TerminalManager.getInstance();
            if (tm.getSession(fieldSessionId) || tm.getActiveSessionId() === fieldSessionId) {
              targetSessionId = fieldSessionId;
            }
          } catch {}
        }
      }
    }

    // Fallback: If identifier is a live tab (e.g. MCP bound tab without terminal affinity),
    // initialize an ad-hoc session pool anchored at identifier so child tabs are recognized.
    if (!targetSessionId && this.tabs.has(identifier)) {
      targetSessionId = identifier;
    }
    // 1. Try finding entry as terminalId
    let entry = this.resolveTerminalAffinityEntry(identifier, generation);
    let resolvedTerminalId = identifier;

    // 2. If not found by terminalId, try finding by boundTabId
    if (!entry) {
      for (const [key, ent] of this.terminalAgentAffinity.entries()) {
        if (ent.primaryTabId === identifier || ent.managedTabIds?.has(identifier)) {
          entry = ent;
          resolvedTerminalId = key.split('@')[0] || identifier;
          if (!parentTabId) parentTabId = identifier;
          break;
        }
      }
    }

    if (entry && entry.managedTabIds) {
      this.pruneDeadTabIds(entry.managedTabIds);
      if (entry.managedTabIds.size >= 10 && !entry.managedTabIds.has(childTabId)) {
        return false;
      }
    }

    let adoptedIntoPool = false;
    if (!targetSessionId && entry && entry.primaryTabId && this.tabs.has(entry.primaryTabId)) {
      targetSessionId = entry.primaryTabId;
    }
    // A pool write only means something when an affinity entry exists to surface
    // it, or when the identifier is a live tab anchoring an ad-hoc pool. For a
    // bare terminalId with no entry, skip the write entirely so the honest
    // failure below leaves no phantom membership behind.
    const canAnchorPool = Boolean(entry) || this.tabs.has(identifier);
    if (targetSessionId && canAnchorPool) {
      if (this.tabs.has(identifier)) {
        this.adoptChildTabForSession(targetSessionId, identifier);
      }
      adoptedIntoPool = this.adoptChildTabForSession(targetSessionId, childTabId);
      if (!adoptedIntoPool && !entry) {
        return false;
      }
    }

    // No affinity entry: a pool-only write is invisible to getTerminalIdsWithAffinity
    // (the badge never shows it), so report success only for the tab-anchored
    // ad-hoc pool case where the identifier is itself a live tab.
    if (!entry) return this.tabs.has(identifier) ? adoptedIntoPool : false;

    if (!entry.managedTabIds) entry.managedTabIds = new Set<string>([entry.tabId]);
    entry.managedTabIds.add(childTabId);
    // Adopting a live tab revives a tombstoned entry — the terminal owns a tab again.
    if (entry.closedAt) delete entry.closedAt;
    if (!entry.lastUrls) entry.lastUrls = new Map();
    entry.lastUrls.set(childTabId, childTab.state.url || '');
    if (!entry.lineage) entry.lineage = new Map();
    entry.lineage.set(childTabId, {
      tabId: childTabId,
      parentTabId: parentTabId || entry.primaryTabId || entry.tabId,
      source,
      createdAt: Date.now(),
    });

    this.claimTabTerminalSession(childTab, resolvedTerminalId);
    this.broadcastState();
    return true;
  }

  public adoptChildTabForBoundTab(
    boundTabId: string,
    childTabId: string,
    source: 'agent_spawned' | 'native_window_open' | 'user_attached' = 'agent_spawned',
    parentTabId?: string
  ): boolean {
    return this.adoptChildTab(boundTabId, childTabId, undefined, source, parentTabId || boundTabId);
  }

  /**
   * The session's managed set, pruned through the same source the adopt path
   * counts: dead ids are dropped from the underlying pool/entry before the copy
   * is returned, so the quota gates and adoption can never disagree about a
   * closed tab.
   */
  public getManagedTabIdsForBoundTab(boundTabId: string): Set<string> {
    if (!boundTabId) return new Set();
    const directPool = this.sessionTabPools.get(boundTabId);
    if (directPool) {
      this.pruneDeadTabIds(directPool);
      return new Set(directPool);
    }
    for (const pool of this.sessionTabPools.values()) {
      if (pool.has(boundTabId)) {
        this.pruneDeadTabIds(pool);
        return new Set(pool);
      }
    }
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.primaryTabId === boundTabId || entry.managedTabIds?.has(boundTabId)) {
        if (entry.managedTabIds) this.pruneDeadTabIds(entry.managedTabIds);
        return new Set(entry.managedTabIds);
      }
    }
    return new Set([boundTabId]);
  }

  public getManagedTabIds(boundTabIdOrTerminalId: string): Set<string> {
    if (!boundTabIdOrTerminalId) return new Set();
    const found = this.sessionTabPools.get(boundTabIdOrTerminalId);
    if (found) {
      this.pruneDeadTabIds(found);
      return new Set(found);
    }
    for (const pool of this.sessionTabPools.values()) {
      if (pool.has(boundTabIdOrTerminalId)) {
        this.pruneDeadTabIds(pool);
        return new Set(pool);
      }
    }
    return this.getManagedTabIdsForBoundTab(boundTabIdOrTerminalId);
  }

  public isTabAllowedForPrimary(primaryTabId: string, requestedTabId: string): boolean {
    if (!primaryTabId || !requestedTabId) return false;
    const pId = this.resolveTargetTabId(primaryTabId);
    const rId = this.resolveTargetTabId(requestedTabId);
    if (!pId || !rId) return false;
    if (pId === rId) return true;
    if (this.sessionTabPools) {
      for (const pool of this.sessionTabPools.values()) {
        if (pool.has(pId) && pool.has(rId)) {
          return true;
        }
      }
    }
    if (this.terminalAgentAffinity) {
      for (const entry of this.terminalAgentAffinity.values()) {
        const matchesSession =
          entry.primaryTabId === pId ||
          entry.managedTabIds?.has(pId) ||
          entry.lineage?.has(pId) ||
          entry.lastUrls?.has(pId);
        if (matchesSession && (entry.managedTabIds?.has(rId) || entry.primaryTabId === rId)) {
          return !entry.closedAt;
        }
    }
    }
    return false;
  }

  public isTabAllowed(primaryOrBoundTabId: string, requestedTabId: string): boolean {
    return this.isTabAllowedForPrimary(primaryOrBoundTabId, requestedTabId);
  }

  /**
   * Terminal Authority: checks whether a given tab owns or is permitted to operate the specified terminal.
   * A terminal is authorized if:
   * 1. The terminal has an active affinity entry whose primary or managed tabs include this tabId.
   * 2. The terminal session pool contains this tabId.
   * User terminals (no affinity entry) or foreign terminals (affinity to another tab) return false.
   */
  public isTerminalAllowedForTab(tabId: string, terminalId: string): boolean {
    if (!tabId || !terminalId) return false;
    const canonicalTabId = this.resolveTargetTabId(tabId) || tabId;
    const entry = this.resolveTerminalAffinityEntry(terminalId);
    if (!entry || entry.closedAt) return false;
    if (entry.primaryTabId === canonicalTabId || entry.tabId === canonicalTabId) return true;
    if (entry.managedTabIds && entry.managedTabIds.has(canonicalTabId)) return true;
    if (this.sessionTabPools) {
      const pool = this.sessionTabPools.get(terminalId);
      if (pool && pool.has(canonicalTabId)) return true;
    }
    return false;
  }

  /**
   * Terminal Authority: asserts that a tab is authorized to operate the given terminal.
   * Throws TERMINAL_FORBIDDEN if the terminal is unowned, foreign, or belongs to the user.
   */
  public assertTerminalAccess(tabId: string, terminalId: string): void {
    if (!this.isTerminalAllowedForTab(tabId, terminalId)) {
      throw new CapabilityError(
        'TERMINAL_FORBIDDEN' as unknown as CapabilityErrorCode,
        `Tab '${tabId}' is not authorized to operate terminal '${terminalId}'`
      );
    }
  }

  public terminalWrite(tabId: string, input: string, terminalId?: string): boolean | Promise<boolean> {
    const targetTerminalId = terminalId || this.getOwnedTerminalSession(tabId);
    if (!targetTerminalId) {
      throw new CapabilityError(
        'TERMINAL_FORBIDDEN' as unknown as CapabilityErrorCode,
        `Tab '${tabId}' does not own a terminal session; cannot write to terminal`
      );
    }
    this.assertTerminalAccess(tabId, targetTerminalId);
    const written: unknown = TerminalManager.getInstance().writeTo(targetTerminalId, input);
    // The singleton is a daemon proxy installed by cast: it answers boolean|Promise<boolean>
    // while the in-process manager answers undefined, which maps to the old constant true.
    return written === undefined ? true : (written as boolean | Promise<boolean>);
  }
  /**
   * Routed delivery point for terminal output. The TerminalOutputRouter only calls
   * this for sessions this host admits, so no per-chunk visibility check happens
   * here. Everything below is the 4 ms coalescing and the ≤256B keystroke bypass
   * the fan-out has always had.
   */
  public handleTerminalDataChunk(payload: TerminalDataPayload): void {
    const pending = this.terminalDataBatches.get(payload.sessionId);
    if (typeof payload.throughSeq === 'number') {
      // Already coalesced upstream (the terminal daemon batches per session): a second
      // window here would only add latency. Output this host still holds goes first.
      if (pending) this.flushTerminalDataBatch(payload.sessionId);
      this.dispatchTerminalData(payload);
      return;
    }
    if (!pending && payload.data.length <= TERMINAL_DATA_COALESCE_BYPASS_LENGTH) {
      // Keystroke echo and other small chunks take the immediate path so typing
      // latency is identical to the unbuffered baseline.
      this.dispatchTerminalData(payload);
      return;
    }
    if (pending && pending.generation !== payload.generation) {
      // A generation boundary (session restart) must never merge into the
      // previous generation's batch — the renderer resets on generation change.
      this.flushTerminalDataBatch(payload.sessionId);
    }
    const batch = this.terminalDataBatches.get(payload.sessionId);
    if (batch) {
      batch.parts.push(payload.data);
      batch.throughSeq = payload.seq;
    } else {
      this.terminalDataBatches.set(payload.sessionId, {
        parts: [payload.data],
        fromSeq: payload.seq,
        throughSeq: payload.seq,
        generation: payload.generation,
      });
    }
    if (!this.terminalDataFlushTimer) {
      this.terminalDataFlushTimer = setTimeout(() => {
        this.terminalDataFlushTimer = null;
        this.flushAllTerminalDataBatches();
      }, TERMINAL_DATA_FLUSH_MS);
      this.terminalDataFlushTimer.unref?.();
    }
  }

  /**
   * The router's per-host admission callback: whether a chunk addressed to
   * `sessionId` belongs to a surface this window owns. Delegates to the same
   * scope + terminal-window binding predicate the projections use, so routing
   * can never disagree with what the window would have shown.
   */
  public admitSession(sessionId: string): boolean {
    return this.isSessionVisibleToWindow(sessionId);
  }

  /**
   * The sessions one terminal-surface projection shows right now: its active
   * session and every pane mounted around it (the session's own split and the
   * projection-level split entry). Suppression keys on this set — a renderer not
   * showing a session gets the activity signal, never the data channel.
   */
  private displayedSessionIdsOf(projection: TerminalSessionStateProjection): Set<string> {
    const ids = new Set<string>();
    if (projection.activeSessionId) ids.add(projection.activeSessionId);
    const active = (Array.isArray(projection.sessions) ? projection.sessions : [])
      .find((s) => s && s.id === projection.activeSessionId);
    if (active?.splitSessionId) ids.add(active.splitSessionId);
    if (projection.splitSessionId) ids.add(projection.splitSessionId);
    return ids;
  }

  /**
   * Push this window's scoped session projection to every terminal surface, and
   * record which sessions each surface displays so `dispatchTerminalData` can
   * suppress full data for sessions a surface only watches in the tab strip.
   */
  private sendTerminalProjections(state: unknown): void {
    const sidebarContents = this.shell.sidebarView?.webContents;
    if (sidebarContents && !sidebarContents.isDestroyed()) {
      const projection = this.terminalStateForWindow(state, undefined, sidebarContents.id);
      this.terminalDisplayedSessions.set(`c${sidebarContents.id}`, this.displayedSessionIdsOf(projection));
      safeSendWebContents(sidebarContents, 'antifan:terminal:session', projection);
    }
    for (const [id, win] of this.terminalWindows.entries()) {
      if (win && !win.isDestroyed()) {
        // A popout keeps the session it was opened with, even when that session is
        // outside the window's capsule filter.
        const boundSessionId = this.terminalWindowMeta.get(id)?.sessionId;
        const wcId = win.webContents.id;
        const projection = this.terminalStateForWindow(state, boundSessionId, wcId);
        this.terminalDisplayedSessions.set(`w${id}`, this.displayedSessionIdsOf(projection));
        safeSendWebContents(win.webContents, 'antifan:terminal:session', projection);
      } else {
        this.terminalWindows.delete(id);
        this.terminalDisplayedSessions.delete(`w${id}`);
      }
    }
  }

  /**
   * Re-derive every surface's displayed set from the last state the seam pushed.
   * Called when the surface set itself changes (terminal window bound, unbound,
   * or closed) so suppression never reads a stale answer.
   */
  private refreshDisplayedSessionSets(): void {
    let state: unknown = null;
    try { state = TerminalManager.getInstance().getSessionState(); } catch {}
    const sidebarContents = this.shell.sidebarView?.webContents;
    const sidebarKey = sidebarContents ? `c${sidebarContents.id}` : '';
    if (!sidebarContents || sidebarContents.isDestroyed()) {
      if (sidebarKey) this.terminalDisplayedSessions.delete(sidebarKey);
    } else {
      const projection = this.terminalStateForWindow(state, undefined, sidebarContents.id);
      this.terminalDisplayedSessions.set(sidebarKey, this.displayedSessionIdsOf(projection));
    }
    for (const [id, win] of this.terminalWindows.entries()) {
      const key = `w${id}`;
      if (!win || win.isDestroyed()) {
        this.terminalDisplayedSessions.delete(key);
        continue;
      }
      const boundSessionId = this.terminalWindowMeta.get(id)?.sessionId;
      const projection = this.terminalStateForWindow(state, boundSessionId, win.webContents.id);
      this.terminalDisplayedSessions.set(key, this.displayedSessionIdsOf(projection));
    }
  }

  /**
   * A terminal window's session binding changed. Two consumers follow the same
   * fact: the router's session→host map (a bound session is always visible to
   * this window) and the suppression sets (the window now displays a session).
   */
  private terminalWindowBindingChanged(): void {
    try { TerminalOutputRouter.getInstance().invalidateRoutes(); } catch {}
    this.refreshDisplayedSessionSets();
  }

  /**
   * Whether one surface displays the session: its renderer parses the chunk,
   * every other admitted surface only tracks the tab-strip indicator.
   */
  private rendererDisplaysSession(key: string, sessionId: string): boolean {
    const shown = this.terminalDisplayedSessions.get(key);
    return shown ? shown.has(sessionId) : false;
  }

  /**
   * Fans one terminal data payload out to this host's subscribers. The sidebar
   * only receives sends while it is open — a closed sidebar re-hydrates from
   * getFullBuffer when toggleSidebar pushes 'antifan:terminal:session' on open,
   * so dropping sends here costs nothing and saves background render CPU.
   *
   * Per-surface suppression (renderer lazy-xterm): a surface showing the session
   * gets 'antifan:terminal:data'; every other admitted surface gets the
   * lightweight 'antifan:terminal:activity' envelope so its tab strip keeps the
   * streaming indicator and the subscriber ack without materializing an xterm.
   */
  private dispatchTerminalData(payload: TerminalDataPayload): void {
    let sent = 0;
    // Activity envelopes share the data tail, so the truncation is built once
    // per dispatch instead of per non-displaying surface.
    let activityPayload: TerminalDataPayload | undefined;
    const activityEnvelope = (): TerminalDataPayload => {
      if (activityPayload) return activityPayload;
      if (payload.data.length <= TERMINAL_ACTIVITY_DATA_TAIL_CHARS) {
        activityPayload = payload;
      } else {
        let tail = payload.data.slice(-TERMINAL_ACTIVITY_DATA_TAIL_CHARS);
        // The cut point may land inside a UTF-16 surrogate pair; a lone low
        // surrogate at the head renders as a replacement char in the classifier
        // and in any pane that ends up writing the frame.
        const first = tail.charCodeAt(0);
        if (first >= 0xdc00 && first <= 0xdfff) tail = tail.slice(1);
        // The retained data covers only the last chunk of the batch, so the
        // envelope names the range it honestly carries. If a pane goes live
        // mid-suppression, lastRenderedSeq+1 < throughSeq reads as a seq gap
        // and recovers through the delta path instead of materializing a
        // head-truncated batch as the full range.
        const end = typeof payload.throughSeq === 'number' ? payload.throughSeq : payload.seq;
        activityPayload = { ...payload, data: tail, fromSeq: end };
      }
      return activityPayload;
    };
    const sidebarContents = this.shell.isSidebarOpen ? this.shell.sidebarView?.webContents : undefined;
    if (sidebarContents && !sidebarContents.isDestroyed()) {
      if (this.rendererDisplaysSession(`c${sidebarContents.id}`, payload.sessionId)) {
        safeSendWebContents(sidebarContents, TERMINAL_CHANNELS.DATA, payload);
      } else {
        safeSendWebContents(sidebarContents, TERMINAL_CHANNELS.ACTIVITY, activityEnvelope());
      }
      sent += 1;
    }
    for (const [id, win] of this.terminalWindows.entries()) {
      if (win && !win.isDestroyed()) {
        if (this.rendererDisplaysSession(`w${id}`, payload.sessionId)) {
          safeSendWebContents(win.webContents, TERMINAL_CHANNELS.DATA, payload);
        } else {
          safeSendWebContents(win.webContents, TERMINAL_CHANNELS.ACTIVITY, activityEnvelope());
        }
        sent += 1;
      } else {
        this.terminalWindows.delete(id);
        this.terminalDisplayedSessions.delete(`w${id}`);
      }
    }
    this.terminalFanoutMessages += sent;
    // Counts payloads actually dispatched per flush — the true fan-out the
    // coalescing layer produces, which webContents.send injection cannot see.
    if (isBenchmarkEnabled()) {
      recordBenchmark({ surface: 'terminal', name: 'fanoutMessages', value: sent, extra: { sessionId: payload.sessionId, windows: sent } });
    }
  }

  /** Emits one session's buffered chunks as a single coalesced payload. */
  private flushTerminalDataBatch(sessionId: string): void {
    const batch = this.terminalDataBatches?.get(sessionId);
    if (!batch) return;
    this.terminalDataBatches.delete(sessionId);
    this.dispatchTerminalData({
      sessionId,
      data: batch.parts.join(''),
      // `seq` aliases `throughSeq`: consumers that only read `seq` keep working,
      // and preload/renderer treat a falsy seq as invalid.
      seq: batch.throughSeq,
      fromSeq: batch.fromSeq,
      throughSeq: batch.throughSeq,
      generation: batch.generation,
    });
  }

  private flushAllTerminalDataBatches(): void {
    if (!this.terminalDataBatches) return;
    for (const sessionId of this.terminalDataBatches.keys()) {
      this.flushTerminalDataBatch(sessionId);
    }
  }

  private indexTabWebContents(tabId: string, tab: NativeTabRecord): void {
    if (!this.tabByWebContents) return;
    if (tab.view?.webContents) this.tabByWebContents.set(tab.view.webContents, { tabId, tab });
    if (tab.mobileView?.webContents) this.tabByWebContents.set(tab.mobileView.webContents, { tabId, tab });
  }

  private unindexTabWebContents(tab: NativeTabRecord): void {
    if (!this.tabByWebContents) return;
    if (tab.view?.webContents) this.tabByWebContents.delete(tab.view.webContents);
    if (tab.mobileView?.webContents) this.tabByWebContents.delete(tab.mobileView.webContents);
  }

  public getEventSenderWebContents(event: unknown): Electron.WebContents | undefined {
    if (event && typeof event === 'object' && 'sender' in event) {
      const sender = (event as { sender: unknown }).sender;
      if (sender && typeof sender === 'object') {
        return sender as Electron.WebContents;
      }
    }
    return undefined;
  }

  public findTabByWebContents(sender: Electron.WebContents | null | undefined): { tabId: string; tab: NativeTabRecord } | undefined {
    if (!sender) return undefined;
    // O(1) fast path; the record is verified against the live views because a
    // WeakMap entry can outlive a view replacement until GC.
    const cached = this.tabByWebContents?.get(sender);
    if (cached && (cached.tab.view?.webContents === sender || cached.tab.mobileView?.webContents === sender)) {
      return cached;
    }
    // Fallback for senders registered before the index existed (e.g. partial
    // hosts in tests); a hit self-heals the index.
    for (const [id, tab] of this.tabs.entries()) {
      if (
        (tab.view && tab.view.webContents === sender) ||
        (tab.mobileView && tab.mobileView.webContents === sender)
      ) {
        this.tabByWebContents?.set(sender, { tabId: id, tab });
        return { tabId: id, tab };
      }
    }
    return undefined;
  }

  public getFailoverTargetTab(staleTabId: string): string | undefined {
    if (!staleTabId) return undefined;
    // Closing a tab prunes it from its pool, so the anchor recorded at close time is the
    // only surviving link between the stale tab and the session that still owns a tab.
    const anchor = this.closedTabAnchors?.get(staleTabId);
    if (anchor && this.hasTab(anchor)) return anchor;
    // A session that closed (or lost) the tab it was bound to must not be stranded: when
    // the stale tab belongs to a session pool, the pool's own open tab is a safe rebind —
    // same session, same workspace, same authority. Without this, a session that opens a
    // scratch tab, works in it and closes it answers every later call with TARGET_STALE,
    // and the close itself cannot hand the caller a replacement target.
    for (const [poolKey, pool] of this.sessionTabPools.entries()) {
      if (poolKey !== staleTabId && !pool.has(staleTabId)) continue;
      if (poolKey !== staleTabId && this.hasTab(poolKey)) return poolKey;
      const sibling = Array.from(pool).find((id) => id !== staleTabId && this.hasTab(id));
      if (sibling) return sibling;
    }
    if (!this.terminalAgentAffinity) return undefined;
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.primaryTabId && entry.primaryTabId !== staleTabId && this.hasTab(entry.primaryTabId)) {
        if (entry.managedTabIds?.has(staleTabId) || entry.lineage?.has(staleTabId) || entry.lastUrls?.has(staleTabId)) {
          return entry.primaryTabId;
        }
      }
    }
    return undefined;
  }

  public getTabLineage(tabId: string): { tabId: string; parentTabId?: string; source: string; createdAt: number } | undefined {
    if (!this.terminalAgentAffinity || !tabId) return undefined;
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.lineage?.has(tabId)) {
        return entry.lineage.get(tabId);
      }
    }
    return undefined;
  }
  /**
   * Detaches one tab from one affinity entry: drops it from the managed set along
   * with its recorded URL and lineage, and re-points the primary at a surviving
   * live tab. A re-point is not a tombstone — the entry keeps owning whatever else
   * it holds — so `closedAt` is written only when nothing live is left.
   *
   * Returns whether the tab was a managed member, which is what the release paths
   * report: a primary pointer can name a tab the managed set no longer holds (the
   * wake path re-points at the pool's first live tab), and re-pointing it is
   * bookkeeping rather than a freed slot.
   */
  private detachTabFromAffinityEntry(entry: TerminalAgentAffinityEntry, tabId: string): boolean {
    const wasManaged = entry.managedTabIds?.has(tabId) === true;
    entry.managedTabIds?.delete(tabId);
    entry.lastUrls?.delete(tabId);
    entry.lineage?.delete(tabId);
    if (entry.primaryTabId === tabId) {
      let nextPrimary: string | undefined;
      for (const id of entry.managedTabIds) {
        if (this.hasTab(id)) {
          nextPrimary = id;
          break;
        }
      }
      if (nextPrimary) {
        entry.primaryTabId = nextPrimary;
        entry.tabId = nextPrimary;
        entry.lastUrl = entry.lastUrls?.get(nextPrimary) || '';
      } else {
        entry.closedAt = Date.now();
      }
    }
    return wasManaged;
  }

  public removeManagedTab(terminalId: string, tabId: string, generation?: number | string): boolean {
    if (!this.terminalAgentAffinity || !terminalId || !tabId) return false;
    const entryKey = this.resolveTerminalAffinityKey(terminalId, generation);
    const entry = entryKey ? this.terminalAgentAffinity.get(entryKey) : undefined;
    if (!entry) return false;

    this.detachTabFromAffinityEntry(entry, tabId);
    const tab = this.tabs?.get(tabId);
    if (tab && tab.state.terminalSessionId === terminalId) {
      tab.state.terminalSessionId = undefined;
    }
    if (this.sessionTabPools) {
      const pool = this.sessionTabPools.get(terminalId);
      if (pool) {
        pool.delete(tabId);
        if (pool.size === 0) {
          this.sessionTabPools.delete(terminalId);
        }
      }
    }
    if (entry.managedTabIds.size === 0) {
      // User-initiated unbind emptied the managed set: the terminal owns nothing,
      // so the entry is deleted outright. The 'closed' tombstone is reserved for
      // tab-close (tombstoneTerminalAgentAffinity), not for unbinding.
      // `entry` came from `entryKey`, so a resolved entry always has a key.
      if (entryKey) this.terminalAgentAffinity.delete(entryKey);
    }
    this.broadcastState();
    return true;
  }

  /**
   * Releases one tab's slot in a session — the rebind-away counterpart of adoption.
   * A terminal-id caller hands the whole ownership record back, so the affinity
   * entry is consulted first and the release delegates to removeManagedTab; every
   * other caller names the tab it let go by value.
   *
   * The caller knows the tab, not the key its pool happens to carry. A tab seated
   * through `createTab({ terminalSessionId })` or adopted by a terminal lives in a
   * pool keyed by that terminal id, so a key-only delete is a silent no-op: the
   * slot stayed counted after a rebind-away and the next `openTab` refused with
   * POLICY_DENIED against a tab the session had already given up.
   */
  public releaseSessionTab(sessionId: string, tabId: string): boolean {
    if (!sessionId || !tabId) return false;
    if (this.terminalAgentAffinity && this.resolveTerminalAffinityKey(sessionId)) {
      return this.removeManagedTab(sessionId, tabId);
    }
    return this.releaseTabFromEveryOwner(tabId);
  }

  /**
   * Frees one tab from every record that counts it against a session.
   *
   * Two containers answer "tabs this session holds": the pool, read first by
   * `getManagedTabIds`/`getManagedTabIdsForBoundTab` and by the `openTab` quota gate,
   * and the affinity entry's managed set, read directly by `adoptChildTab`'s cap and as
   * the readers' fallback. Both are resolved by value — a pool is keyed by whichever
   * owner seated the tab (a terminal id, or the tab itself for an ad-hoc pool) — and a
   * release that updates only one of them leaves the other refusing an operation
   * against a slot the session has already given up.
   */
  private releaseTabFromEveryOwner(tabId: string): boolean {
    let released = false;
    if (this.terminalAgentAffinity) {
      for (const entry of Array.from(this.terminalAgentAffinity.values())) {
        if (this.detachTabFromAffinityEntry(entry, tabId)) released = true;
      }
    }
    return this.releaseTabFromEveryPool(tabId) || released;
  }

  /**
   * Frees one tab from every pool that holds it.
   *
   * A pool is keyed by whichever owner seated the tab — a terminal id for a tab
   * adopted into a session, the tab itself for an ad-hoc pool — so the caller's
   * identifier is resolved by value exactly as `adoptChildTab` and both quota
   * readers resolve it. That shared rule is what keeps a release from disagreeing
   * with the readers about which pool owns a tab.
   */
  private releaseTabFromEveryPool(tabId: string): boolean {
    if (!this.sessionTabPools) return false;
    let released = false;
    for (const [poolKey, pool] of Array.from(this.sessionTabPools.entries())) {
      if (pool.delete(tabId)) released = true;
      if (pool.size === 0) this.sessionTabPools.delete(poolKey);
    }
    return released;
  }

  /**
   * Releases every slot one identifier holds — the session-end counterpart of
   * adoption, for the callers that know the bound tab rather than the pool key.
   *
   * Two identifiers reach this through the same entry point: a terminal id (drop
   * the affinity keys and the pool outright) and a tab id (the attachment
   * registry's dispose path, which names the tab it is letting go). A key-only
   * delete answers the second caller with a silent no-op — the adopting terminal's
   * pool kept counting a slot the session had already given up — so the by-value
   * release runs for both. Member tabs are released, never closed.
   */
  public releaseSessionTabPool(sessionId: string): boolean {
    if (!sessionId) return false;
    const dropped = this.dropTerminalAffinityEntries(sessionId);
    return this.releaseTabFromEveryOwner(sessionId) || dropped;
  }

  /**
   * Drops a terminal's affinity map keys and session pool without touching
   * tab.state.terminalSessionId. Used by bindTerminalAgentAffinity on rebind:
   * the field is the user's per-tab pick, and wiping it would erase explicit
   * choices on tabs the terminal never managed.
   */
  private dropTerminalAffinityEntries(terminalId: string): boolean {
    if (!this.terminalAgentAffinity || !terminalId) return false;
    const prefix = `${terminalId}@`;
    let dropped = false;
    for (const key of Array.from(this.terminalAgentAffinity.keys())) {
      if (key === terminalId || key.startsWith(prefix)) {
        this.terminalAgentAffinity.delete(key);
        dropped = true;
      }
    }
    if (this.sessionTabPools) {
      dropped = this.sessionTabPools.delete(terminalId) || dropped;
    }
    return dropped;
  }

  public clearTerminalAgentAffinity(terminalId: string): void {
    if (!this.terminalAgentAffinity || !terminalId) return;
    this.dropTerminalAffinityEntries(terminalId);
    // Session-closed path only: the terminal is dead, so any remembered pick
    // naming it is stale and must be cleared.
    for (const tab of this.tabs.values()) {
      if (tab.state.terminalSessionId === terminalId) {
        tab.state.terminalSessionId = undefined;
      }
    }
  }

  /**
   * Lifts the "closed" tombstone from every affinity entry for a terminal without
   * touching its tab bindings. Called when a slept terminal wakes: the bindings were
   * preserved on purpose, but a browser tab that closed while the session slept left
   * `closedAt` behind, and `isTerminalAllowedForTab` treats that flag as an outright
   * denial — the owning agent would get TERMINAL_FORBIDDEN forever.
   *
   * Safe when the tab really is gone: `getTerminalAgentAffinity` still reports
   * `status: 'closed'` because it additionally requires a live bound tab.
   */
  public clearTerminalAffinityTombstone(terminalId: string): void {
    if (!this.terminalAgentAffinity || !terminalId) return;
    const prefix = `${terminalId}@`;
    for (const [key, entry] of this.terminalAgentAffinity.entries()) {
      if (key !== terminalId && !key.startsWith(prefix)) continue;
      if (entry.closedAt === undefined) continue;
      delete entry.closedAt;
    }
  }

  /**
   * Wake-side half of the Affinity Zombie Guard.
   *
   * Sleeping keeps the affinity bindings on purpose, but a browser tab that closed
   * during the nap left `closedAt` behind, and `isTerminalAllowedForTab` denies a
   * tombstoned entry outright — the owning agent would get TERMINAL_FORBIDDEN for
   * the rest of the run.
   *
   * Lifting the flag is not enough by itself. `getTerminalAgentAffinity` re-arms
   * `closedAt` whenever the entry's primary pointer names a tab that no longer
   * exists, so the first affinity read after the wake (the bridge gate, the close
   * gate's affinity map) would restore the tombstone and wedge the agent again. This
   * therefore also drops dead ids from the entry and re-points a stale primary at a
   * live tab from the surviving session pool.
   *
   * `generation` is the generation the wake reused. The manager keeps
   * `reservedGeneration`, so the entry is expected to be keyed under it already and
   * the key must never migrate: the generation is only used to resolve that exact
   * entry first. A terminal with no live bound tab left is deliberately left
   * pointer-stale — `getTerminalAgentAffinity` keeps reporting `status: 'closed'`
   * for it and no live tab resolves through it, so lifting the flag cannot widen
   * access to a tab that was never bound.
   */
  public reviveTerminalAgentAffinity(terminalId: string, generation?: number | string): void {
    if (!this.terminalAgentAffinity || !terminalId) return;
    const reportedGeneration = generation === undefined || generation === null || generation === ''
      ? undefined
      : String(generation).trim();
    if (reportedGeneration) {
      const wakeEntry = this.resolveTerminalAffinityEntry(terminalId, reportedGeneration);
      if (wakeEntry && wakeEntry.closedAt !== undefined) delete wakeEntry.closedAt;
    }
    this.clearTerminalAffinityTombstone(terminalId);
    const prefix = `${terminalId}@`;
    const pool = this.sessionTabPools?.get(terminalId);
    const firstLiveTabId = (ids: Iterable<string>): string | undefined => {
      for (const rawId of ids) {
        const id = typeof rawId === 'string' ? rawId : String(rawId);
        if (this.hasTab(id)) return id;
      }
      return undefined;
    };
    for (const [key, entry] of this.terminalAgentAffinity.entries()) {
      if (key !== terminalId && !key.startsWith(prefix)) continue;
      if (!entry.managedTabIds) entry.managedTabIds = new Set<string>();
      for (const rawId of Array.from(entry.managedTabIds)) {
        const id = typeof rawId === 'string' ? rawId : String(rawId);
        if (this.hasTab(id)) continue;
        entry.managedTabIds.delete(rawId);
        entry.lastUrls?.delete(id);
        entry.lineage?.delete(id);
      }
      const primaryAlive = Boolean(entry.primaryTabId) && this.hasTab(entry.primaryTabId);
      if (primaryAlive) {
        // `tabId` is the legacy alias of the primary pointer; keep it resolvable.
        if (!this.hasTab(entry.tabId)) entry.tabId = entry.primaryTabId;
        continue;
      }
      const nextPrimary = firstLiveTabId(entry.managedTabIds) || (pool ? firstLiveTabId(pool) : undefined);
      if (!nextPrimary) continue;
      entry.primaryTabId = nextPrimary;
      entry.tabId = nextPrimary;
      entry.lastUrl = entry.lastUrls?.get(nextPrimary) || entry.lastUrl;
    }
    // A tab that survived the nap keeps its right to operate the woken terminal
    // even if an earlier affinity rebuild dropped it from the pool.
    if (pool) {
      for (const rawId of Array.from(pool)) {
        const id = typeof rawId === 'string' ? rawId : String(rawId);
        if (!this.hasTab(id)) {
          pool.delete(rawId);
          continue;
        }
        const tab = this.tabs.get(id);
        if (tab && !tab.state.terminalSessionId) {
          tab.state.terminalSessionId = terminalId;
        }
      }
    }
  }

  public tombstoneTerminalAgentAffinity(tabId: string, lastUrl?: string): void {
    if (!this.terminalAgentAffinity || !tabId) return;
    for (const entry of this.terminalAgentAffinity.values()) {
      if (entry.managedTabIds && entry.managedTabIds.has(tabId)) {
        entry.managedTabIds.delete(tabId);
        if (entry.lastUrls) entry.lastUrls.delete(tabId);
        if (entry.primaryTabId === tabId) {
          let nextPrimary: string | undefined;
          for (const id of entry.managedTabIds) {
            if (this.hasTab(id)) {
              nextPrimary = id;
              break;
            }
          }
          if (nextPrimary) {
            entry.primaryTabId = nextPrimary;
            entry.tabId = nextPrimary;
            entry.lastUrl = entry.lastUrls?.get(nextPrimary) || '';
          } else {
            entry.closedAt = Date.now();
            entry.lastUrl = lastUrl || entry.lastUrl;
          }
        }
      } else if (entry.tabId === tabId) {
        entry.closedAt = Date.now();
        entry.lastUrl = lastUrl || entry.lastUrl;
      }
    }
  }

  public migrateTerminalAgentAffinityGeneration(terminalId: string, newGeneration: number): void {
    if (!this.terminalAgentAffinity || !terminalId) return;
    const prefix = `${terminalId}@`;
    let existingEntry: any = undefined;
    for (const [key, entry] of this.terminalAgentAffinity.entries()) {
      if (key.startsWith(prefix)) {
        existingEntry = entry;
        this.terminalAgentAffinity.delete(key);
      }
    }
    if (existingEntry) {
      this.terminalAgentAffinity.set(`${terminalId}@${newGeneration}`, existingEntry);
    }
  }

  public getTerminalAgentAffinity(terminalSessionId: string, generation?: number | string): TerminalAgentAffinityInfo | undefined {
    if (!this.terminalAgentAffinity || !terminalSessionId) return undefined;
    const entry = this.resolveTerminalAffinityEntry(terminalSessionId, generation);
    if (!entry) return undefined;
    // Self-healing: prune dead tabs that no longer exist in this.tabs
    if (entry.managedTabIds) {
      for (const mId of Array.from(entry.managedTabIds)) {
        const mIdStr = typeof mId === 'string' ? mId : String(mId);
        if (!this.hasTab(mIdStr)) {
          entry.managedTabIds.delete(mId);
          entry.lastUrls?.delete(mId);
          entry.lineage?.delete(mId);
        }
      }
    }
    if (this.sessionTabPools) {
      const pool = this.sessionTabPools.get(terminalSessionId);
      if (pool) {
        for (const pId of Array.from(pool)) {
          const pIdStr = typeof pId === 'string' ? pId : String(pId);
          if (!this.hasTab(pIdStr)) {
            pool.delete(pId);
          }
        }
      }
    }

    if (entry.primaryTabId && !this.hasTab(entry.primaryTabId)) {
      let nextPrimary: string | undefined;
      if (entry.managedTabIds) {
        for (const id of entry.managedTabIds) {
          const idStr = typeof id === 'string' ? id : String(id);
          if (this.hasTab(idStr)) {
            nextPrimary = idStr;
            break;
          }
        }
      }
      if (nextPrimary) {
        entry.primaryTabId = nextPrimary;
        entry.tabId = nextPrimary;
        entry.lastUrl = entry.lastUrls?.get(nextPrimary) || '';
      } else {
        entry.closedAt = Date.now();
      }
    }

    const rawManaged = entry.managedTabIds ? Array.from(entry.managedTabIds) : [entry.tabId];
    const managedArr: string[] = rawManaged.filter((id) => this.hasTab(id));
    const hasAliveTab = managedArr.length > 0 || (entry.tabId && this.hasTab(entry.tabId));
    const status: 'alive' | 'closed' = hasAliveTab && !entry.closedAt ? 'alive' : 'closed';
    const primaryTabId = entry.primaryTabId || entry.tabId;
    const primaryTab = this.tabs.get(primaryTabId);
    return {
      tabId: primaryTabId,
      primaryTabId,
      managedTabIds: managedArr,
      status,
      lastUrl: entry.lastUrl,
      isEphemeral: primaryTab?.state.ephemeral === true,
      title: primaryTab?.state.title,
      url: primaryTab?.state.url,
    };
  }

  public getTabTerminalSession(tabId: string): string | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab) return undefined;

    const tm = TerminalManager.getInstance();

    // 1. The user's explicit per-tab choice wins over agent affinity. 'auto' is a
    // real choice (follow the active terminal), not "unset". A remembered id that
    // no longer names a live session is stale: clear it and fall through.
    // getSession is the liveness oracle — it resolves split sessions too, so a
    // split the user picked stays a valid choice.
    if (tab.state.terminalSessionId) {
      const sessionId = tab.state.terminalSessionId;
      if (sessionId === 'auto') return 'auto';
      if (tm.getSession(sessionId)) {
        return sessionId;
      }
      tab.state.terminalSessionId = undefined;
    }

    // 2. Check if the active terminal session has affinity to this tab (primary or managed)
    const activeSessionId = tm.getActiveSessionId();
    if (activeSessionId) {
      const activeGen = tm.getSession(activeSessionId)?.sessionGeneration;
      const affinity = this.getTerminalAgentAffinity(activeSessionId, activeGen);
      if (affinity && affinity.status === 'alive') {
        if (affinity.tabId === tabId || (affinity.managedTabIds && affinity.managedTabIds.includes(tabId))) {
          return activeSessionId;
        }
      }
    }

    // 3. Check if any other live terminal session has affinity to this tab
    for (const sessionId of this.listTerminalSessionIds()) {
      if (sessionId === activeSessionId) continue;
      const affinity = this.getTerminalAgentAffinity(sessionId, tm.getSession(sessionId)?.sessionGeneration);
      if (affinity && affinity.status === 'alive') {
        if (affinity.tabId === tabId || (affinity.managedTabIds && affinity.managedTabIds.includes(tabId))) {
          return sessionId;
        }
      }
    }

    return undefined;
  }

  /**
   * Ownership oracle for agent operations: resolves the terminal session this tab
   * OWNS via the affinity map only — never the user's per-tab preference
   * (tab.state.terminalSessionId), and never sessionTabPools membership, which
   * isTerminalAllowedForTab (the gate every caller passes through) does not honor
   * without a live affinity entry. getTabTerminalSession answers "which terminal
   * did the user pick for this tab"; this answers "which terminal is this tab
   * allowed to operate". Active session is checked first, matching the old
   * affinity ordering.
   */
  public getOwnedTerminalSession(tabId: string): string | undefined {
    const tab = this.tabs.get(tabId);
    if (!tab) return undefined;

    const tm = TerminalManager.getInstance();
    const liveSessionIds = this.listTerminalSessionIds();
    const activeSessionId = tm.getActiveSessionId();
    const ordered = activeSessionId
      ? [activeSessionId, ...liveSessionIds.filter((id) => id !== activeSessionId)]
      : liveSessionIds;

    for (const sessionId of ordered) {
      const gen = tm.getSession(sessionId)?.sessionGeneration;
      const affinity = this.getTerminalAgentAffinity(sessionId, gen);
      if (affinity && affinity.status === 'alive') {
        if (affinity.tabId === tabId || (affinity.managedTabIds && affinity.managedTabIds.includes(tabId))) {
          return sessionId;
        }
      }
    }
    return undefined;
  }

  public setTabTerminalSession(tabId: string, terminalSessionId?: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (typeof terminalSessionId === 'string' && terminalSessionId) {
      const tm = TerminalManager.getInstance();
      const valid = terminalSessionId === 'auto' || Boolean(tm.getSession(terminalSessionId));
      tab.state.terminalSessionId = valid ? terminalSessionId : undefined;
    } else {
      tab.state.terminalSessionId = undefined;
    }
    this.broadcastState();
    return true;
  }
  public getLastAnnotationSessionId(tabId?: string): string | undefined {
    return this.getTabTerminalSession(tabId || this.activeTabId);
  }

  public setLastAnnotationSessionId(sessionId?: string, tabId?: string): void {
    this.setTabTerminalSession(tabId || this.activeTabId, sessionId);
  }

  /**
   * Fail-closed, tab-scoped workspace resolver for tab-facing surfaces (Cockpit,
   * theme QA, toolbar checklist, workspace identify).
   *
   * `resolveTargetWorkspace` answers "which workspace owns this terminal/session"
   * and legitimately consults ambient state (active capsule, active terminal,
   * global CWD) because its callers are interactive terminal actions. A tab is
   * not a terminal session: forwarding a tabId there is a category error, and
   * omitting it collapses onto the process-global active capsule — which is how
   * a tab stamped with the S2 Spa capsule resolved `E:\Work\apps\Pancake` while
   * Pancake happened to be the active capsule.
   *
   * Precedence (each tier verified to exist on disk before it wins):
   *   1. Tab's stamped capsuleId — mint-time capability token.
   *   2. Tab's bound terminal session CWD (skips 'auto': dynamic focus tracking
   *      is not a pinned binding).
   *   3. Window workspace affiliation — verified container root, never another
   *      window's workspace.
   *   4. URL classification via resolveWorkspaceFromUrl.
   *   5. Fail-closed '' — NEVER capsuleManager.getActive(), NEVER global CWD;
   *      '' degrades to a provisional, in-memory-only scope.
   */
  public resolveTabWorkspace(tabId?: string, tabUrl?: string): string {
    const targetTabId = this.resolveTargetTabId(tabId || this.activeTabId);
    const tab = targetTabId ? this.tabs.get(targetTabId) : undefined;

    // 1. Tab's stamped capsuleId — the mint-time ownership stamp.
    const capId = targetTabId ? this.getTabCapsuleId(targetTabId) : undefined;
    if (capId && this.capsuleManager) {
      const capsule = this.capsuleManager.list().find((c) => c.id.toLowerCase() === capId.toLowerCase());
      if (capsule?.workspacePath) {
        const normalized = path.normalize(capsule.workspacePath);
        if (fs.existsSync(normalized)) return normalized;
      }
    }

    // 2. Tab's bound terminal session CWD (explicit user pick or live agent affinity).
    if (targetTabId) {
      const termSessionId = this.getTabTerminalSession(targetTabId);
      if (termSessionId && termSessionId !== 'auto') {
        const session = TerminalManager.getInstance().getSession(termSessionId);
        if (session?.cwd) {
          const normalized = path.normalize(session.cwd);
          if (fs.existsSync(normalized)) return normalized;
        }
      }
    }

    // 3. Owning window's verified workspace affiliation.
    const windowRoot = this.resolveWindowWorkspaceRoot();
    if (windowRoot) {
      const normalized = path.normalize(windowRoot);
      if (fs.existsSync(normalized)) return normalized;
    }

    // 4. Deterministic URL classification.
    const effectiveUrl = tabUrl || tab?.state.url;
    if (effectiveUrl) {
      const urlWorkspace = resolveWorkspaceFromUrl(effectiveUrl, DEFAULT_WORKSPACE_ROOTS);
      if (urlWorkspace) {
        const normalized = path.normalize(urlWorkspace);
        if (fs.existsSync(normalized)) return normalized;
      }
    }

    // 5. Fail-closed: an unresolvable tab owns no workspace.
    return '';
  }

  public resolveTargetWorkspace(targetSessionId?: string, tabUrl?: string): string {
    const tm = TerminalManager.getInstance();
    if (targetSessionId && targetSessionId !== 'auto') {
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
      }
    }

    // 1b. A tab URL that classifies to a known shop outranks every ambient
    // signal below: the app-wide active capsule and the active terminal belong
    // to whichever window the user touched last, not to this tab.
    if (tabUrl) {
      const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
      if (urlWorkspace && fs.existsSync(path.normalize(urlWorkspace))) {
        return path.normalize(urlWorkspace);
      }
    }

    // 2. Active capsule workspace
    const capsuleWs = this.capsuleManager.getActive()?.workspacePath;
    if (capsuleWs && fs.existsSync(path.normalize(capsuleWs))) {
      return path.normalize(capsuleWs);
    }

    // 3. Check active session from TerminalManager
    const activeTermId = tm.getActiveSessionId();
    if (activeTermId) {
      const activeTerm = tm.getSession(activeTermId);
      if (activeTerm?.cwd && fs.existsSync(path.normalize(activeTerm.cwd))) {
        return path.normalize(activeTerm.cwd);
      }
    }

    // 6. Current CWD from TerminalManager
    const tmCwd = tm.getCurrentCwd();
    if (tmCwd && fs.existsSync(path.normalize(tmCwd))) {
      return path.normalize(tmCwd);
    }

    return '';
  }

  /**
   * Workspace for storing annotation artifacts. An explicit terminal session
   * chosen in the picker dropdown wins (user intent), else the annotated URL's
   * project (so annotations never leak into an unrelated active session),
   * else the same delivery resolution as before.
   */
  public resolveAnnotationWorkspace(targetSessionId?: string, tabUrl?: string): string {
    if (targetSessionId && targetSessionId !== 'auto') {
      const tm = TerminalManager.getInstance();
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
      }
    }
    const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
    if (urlWorkspace) {
      return urlWorkspace;
    }
    return this.resolveTargetWorkspace(targetSessionId, tabUrl);
  }

  /**
   * Fail-closed workspace resolver for Tab Automation (e.g. file upload/drop security).
   * Only resolves the specific tab's bound terminal session or explicit tab URL mapping.
   * NEVER falls through to active capsule, active terminal, or global CWD.
   */
  public resolveTabStrictWorkspace(targetSessionId?: string, tabUrl?: string): string {
    const tm = TerminalManager.getInstance();
    if (targetSessionId && targetSessionId !== 'auto') {
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
      }
    }
    if (tabUrl) {
      const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
      if (urlWorkspace && fs.existsSync(path.normalize(urlWorkspace))) {
        return path.normalize(urlWorkspace);
      }
    }
    return '';
  }
  /**
   * Stage the clipboard image for a terminal paste. The renderer sends the returned
   * path to the shell as text, so the file lands inside the session's own workspace
   * under `.antifan/snapshots` — the same directory convention annotations use —
   * falling back to the runtime dir when no session or capsule resolves a workspace.
   */
  public pasteClipboardImage(targetSessionId?: string): { ok: boolean; imagePath?: string; error?: string } {
    const image = clipboard.readImage();
    if (image.isEmpty()) return { ok: false };
    const png = image.toPNG();
    if (png.length === 0) return { ok: false };
    const workspace = this.resolveTargetWorkspace(targetSessionId);
    const dir = workspace
      ? path.join(workspace, '.antifan', 'snapshots')
      : path.join(StorageLocations.getRuntimeDir(), 'pasted-images');
    try {
      fs.mkdirSync(dir, { recursive: true });
      const imagePath = path.join(dir, `pasted_${Date.now()}_${randomUUID().slice(0, 8)}.png`);
      fs.writeFileSync(imagePath, png);
      return { ok: true, imagePath };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  public findInPage(text: string, forward = true, findNext = false): void {
    this.getDevToolsHost().findInPage(text, forward, findNext);
  }

  public stopFindInPage(): void {
    this.getDevToolsHost().stopFindInPage();
  }

  public async captureScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId, options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean }): Promise<string> {
    return this.getDevToolsHost().captureScreenshot(rect, tabId, paneId, options);
  }

  public async captureVerificationScreenshot(rect?: Rectangle, tabId?: string, paneId?: SplitPaneId, options?: { format?: 'png' | 'jpeg'; quality?: number; fullPage?: boolean; timeoutMs?: number }): Promise<VerificationCaptureEnvelope> {
    return this.getDevToolsHost().captureVerificationScreenshot(rect, tabId, paneId, options);
  }
  public async drainTarget(
    tabId: string,
    paneId?: SplitPaneId,
    timeoutMs?: number
  ): Promise<{ ok: boolean; drained: boolean; resetPerformed: boolean; elapsedMs: number }> {
    return this.getDevToolsHost().drainTarget(tabId, paneId, timeoutMs);
  }

  public async readRenderSurface(tabId?: string, paneId?: SplitPaneId, timeoutMs?: number): Promise<RenderSurfaceSnapshot> {
    return this.getDevToolsHost().readRenderSurface(tabId, paneId, timeoutMs);
  }

  public async beginTrackerIsolation(tabId?: string, paneId?: SplitPaneId): Promise<TrackerIsolationReceipt> {
    return this.getDevToolsHost().beginTrackerIsolation(tabId, paneId);
  }

  public async endTrackerIsolation(tabId?: string, paneId?: SplitPaneId): Promise<{ released: boolean; reason?: string }> {
    return this.getDevToolsHost().endTrackerIsolation(tabId, paneId);
  }

  public isTrackerIsolationActive(tabId?: string, paneId?: SplitPaneId): boolean {
    return this.getDevToolsHost().isTrackerIsolationActive(tabId, paneId);
  }

  public async agentDrag(params: {
    fromRef?: string;
    fromSelector?: string;
    fromX?: number;
    fromY?: number;
    toRef?: string;
    toSelector?: string;
    toX?: number;
    toY?: number;
    steps?: number;
    force?: boolean;
    tabId?: string;
    paneId?: SplitPaneId;
  }): Promise<{ success: boolean; reason?: string; data?: unknown }> {
    const release = this.admitAgentAction('agentDrag', params.tabId);
    try {
      return await this.getAutomationHost().agentDrag(params);
    } finally {
      release();
    }
  }

  public async reapplyTabGeometry(
    tabId: string,
    paneId: SplitPaneId | undefined,
    before: { width: number; height: number; scrollX: number; scrollY: number }
  ): Promise<CaptureViewportTransaction> {
    return this.getDevToolsHost().reapplyTabGeometry(tabId, paneId, before);
  }


  public async getDom(selector?: string, tabId?: string, paneId?: SplitPaneId): Promise<string> {
    return this.getDevToolsHost().getDom(selector, tabId, paneId);
  }

  public async evalJs(expression: string, tabId?: string, paneId?: SplitPaneId, userGesture = false, timeoutMs?: number): Promise<unknown> {
    return this.getDevToolsHost().evalJs(expression, tabId, paneId, userGesture, timeoutMs);
  }

  public async evalJsInFrame(expression: string, frameUrl: string, tabId?: string, paneId?: SplitPaneId, userGesture = false, timeoutMs?: number): Promise<unknown> {
    return this.getDevToolsHost().evalJsInFrame(expression, frameUrl, tabId, paneId, userGesture, timeoutMs);
  }

  public async uploadFileInput(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: SplitPaneId }): Promise<{ success: boolean; uploadedCount: number; reason?: string }> {
    const release = this.admitAgentAction('uploadFileInput', params.tabId);
    try {
      return await this.getAutomationHost().uploadFileInput(params.refOrSelector, params.filePaths, params.tabId, params.paneId);
    } finally {
      release();
    }
  }

  public async dropFiles(params: { refOrSelector: string; filePaths: string[]; tabId?: string; paneId?: SplitPaneId }): Promise<{ success: boolean; droppedCount: number; reason?: string }> {
    const release = this.admitAgentAction('dropFiles', params.tabId);
    try {
      return await this.getAutomationHost().dropFiles(params.refOrSelector, params.filePaths, params.tabId, params.paneId);
    } finally {
      release();
    }
  }
  public async executeActionSequence(params: ActionSequenceParams): Promise<ActionSequenceResult> {
    const release = this.admitAgentAction('executeActionSequence', params.tabId);
    try {
      return await this.getAutomationHost().executeActionSequence(params);
    } finally {
      release();
    }
  }

  private getTabsStoragePath(): string {
    return savedTabsFilePath();
  }


  /**
   * Fold 'project:<id>' owner records — written by the one-window-per-project era — into
   * the 'web' record. Only a web host may call this: the Terminal Manager has no page
   * area and non-web callers would consume tabs they cannot present. The owning
   * project's id is stamped onto every tab (the old key was the only place it was
   * recorded) and duplicates by tab id are skipped so a merge of two old records never
   * double-restores a tab the current 'web' record already carries.
   */
  private foldLegacyProjectOwnerRecords(document: SavedTabsDocument): boolean {
    let folded = false;
    for (const legacyKey of Object.keys(document.owners)) {
      if (!legacyKey.startsWith('project:')) continue;
      const legacy = document.owners[legacyKey];
      if (!legacy || typeof legacy !== 'object') continue;
      const legacyProjectId = legacyKey.slice('project:'.length).trim();
      if (!legacyProjectId) continue; // 'project:' alone is malformed, not an owner
      // A record the project detached itself marks as such: it must survive every
      // web-host read until an explicit reattach folds it. Unmarked `project:` records
      // are pre-detach legacy and still fold — the migration keeps absorbing them.
      if (legacy.detached === true) continue;
      foldProjectOwnerRecordIntoWeb(document, legacyKey, legacyProjectId);
      folded = true;
    }
    return folded;
  }

  /** Read + normalize without writing; the caller's write persists the migration. */
  private normalizeSavedTabsFileForMerge(filePath: string): SavedTabsDocument | null {
    const data = readSavedTabsFile(filePath);
    if (!data) return null;
    return normalizeSavedTabsDocument(data).document;
  }

  /**
   * Read the shared saved-tabs document, migrating a legacy flat file exactly once.
   *
   * The migration is a file-level transaction: the versioned document is written to
   * a temporary file in the same directory and only then renamed over the source, so
   * an interrupted write leaves the legacy source intact for the next launch. When
   * the write fails the in-memory versioned view is still returned — the user's tabs
   * are not lost just because the disk could not be rewritten yet.
   */
  public loadSavedTabsDocument(): SavedTabsDocument | null {
    const filePath = this.getTabsStoragePath();
    const data = readSavedTabsFile(filePath);
    if (!data) return null;
    const { document, migrated } = normalizeSavedTabsDocument(data);
    const folded = this.windowOwnerKey() === WEB_OWNER_KEY ? this.foldLegacyProjectOwnerRecords(document) : false;
    if (migrated || folded) {
      try {
        this.writeSavedTabsDocumentSync(filePath, document);
        console.log(`[native-tab-host] Migrated saved tabs to the owner-keyed document${folded ? ' (project owner records folded into web)' : ''}`);
      } catch (err) {
        console.warn('[native-tab-host] Saved-tabs migration write failed; legacy source retained:', err);
      }
    }
    return document;
  }

  /**
   * Explicit one-time migration entry point (boot, and the persistence suite).
   * A document that already states its version is left untouched, so retrying after
   * an interrupted write converges instead of duplicating records.
   */
  public migrateLegacySavedTabsFile(): SavedTabsMigrationResult {
    const filePath = this.getTabsStoragePath();
    const data = readSavedTabsFile(filePath);
    if (!data) return { migrated: false, reason: 'no-document' };
    const { document, migrated } = normalizeSavedTabsDocument(data);
    const folded = this.windowOwnerKey() === WEB_OWNER_KEY ? this.foldLegacyProjectOwnerRecords(document) : false;
    if (!migrated && !folded) return { migrated: false, reason: 'already-versioned' };
    try {
      this.writeSavedTabsDocumentSync(filePath, document);
    } catch (err) {
      return { migrated: false, reason: `write-failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { migrated: true };
  }

  /**
   * The one atomic write of the saved-tabs document. Throws on failure so a caller
   * can retain what it was replacing; a partially written temp file is removed so it
   * can never be mistaken for the document.
   */
  public writeSavedTabsDocumentSync(filePath: string, document: SavedTabsDocument): void {
    writeSavedTabsDocumentSync(filePath, document);
  }

  /** This window's record inside the document: tabs, its local active id, its auxiliaries. */
  private ownerRecordFromPersistData(data: Record<string, unknown>): SavedTabsOwnerRecord {
    const record: SavedTabsOwnerRecord = {
      tabs: tabRecordsFromUnknown(data.tabs),
      updatedAt: Date.now(),
    };
    if (typeof data.activeTabId === 'string') record.activeTabId = data.activeTabId;
    const terminalWindows = terminalWindowRecordsFromUnknown(data.terminalWindows);
    if (terminalWindows) record.terminalWindows = terminalWindows;
    const terminalAffinities = terminalAffinityRecordsFromUnknown(data.terminalAffinities);
    if (terminalAffinities) record.terminalAffinities = terminalAffinities;
    if (data.isTerminalPopoutOpen === true) record.isTerminalPopoutOpen = true;
    if (typeof data.wasSidebarOpenBeforePopout === 'boolean') record.wasSidebarOpenBeforePopout = data.wasSidebarOpenBeforePopout;
    if (typeof data.popoutSessionId === 'string') record.popoutSessionId = data.popoutSessionId;
    if (typeof data.activeProjectId === 'string') record.activeProjectId = data.activeProjectId;
    if (data.terminalTabLayout === 'horizontal' || data.terminalTabLayout === 'sidebar') record.terminalTabLayout = data.terminalTabLayout;
    if (typeof data.terminalSidebarWidth === 'number') record.terminalSidebarWidth = data.terminalSidebarWidth;
    // A `project:<id>` record carries the detach marker while the project lives in its
    // own shell; only the marked owner itself writes the flag — foreign records and
    // every other owner never carry it.
    if (this.shell?.owner?.kind === 'project') record.detached = true;
    return record;
  }

  /** Application-wide preferences: everything the window record does not own. */
  private sharedPrefsFromPersistData(data: Record<string, unknown>): Record<string, unknown> {
    const shared: Record<string, unknown> = { ...data };
    delete shared.tabs;
    delete shared.activeTabId;
    delete shared.terminalWindows;
    delete shared.terminalAffinities;
    delete shared.isTerminalPopoutOpen;
    delete shared.wasSidebarOpenBeforePopout;
    delete shared.popoutSessionId;
    delete shared.activeProjectId;
    // Layout and width are this window's own: they live in its owner record. The legacy
    // top-level copies are dropped so the last window to save can no longer impose them.
    delete shared.terminalTabLayout;
    delete shared.terminalSidebarWidth;
    return shared;
  }

  /**
   * Merge this window's record into the document, preserving every other owner's
   * record: closing or saving one project must never overwrite another project's
   * saved tabs, popouts or affinities.
   */
  private buildSavedTabsDocument(existing: SavedTabsDocument | null, data: Record<string, unknown>): SavedTabsDocument {
    const owners: Record<string, SavedTabsOwnerRecord> = { ...(existing?.owners ?? {}) };
    owners[this.windowOwnerKey()] = this.ownerRecordFromPersistData(data);
    // A `project:<id>` window owns its tab record and nothing else: the document-level
    // keys (bookmarks, sidebar, profile, terminal prefs) are the hub's authority, and
    // this write must leave every byte of them exactly as they were. Merging the
    // previous document forward means a detached persist that runs while the hub is
    // alive cannot clobber prefs the detached chrome cannot even see.
    if (this.shell?.owner?.kind === 'project') {
      return existing
        ? { ...existing, owners, version: SAVED_TABS_SCHEMA_VERSION, updatedAt: Date.now() }
        : { version: SAVED_TABS_SCHEMA_VERSION, owners, updatedAt: Date.now() };
    }
    const shared = this.sharedPrefsFromPersistData(data);
    // The Terminal Manager's sidebar is pinned open by construction and its width is the
    // whole window; its write must not flip or resize the browser windows' shared sidebar.
    if (this.isTerminalOnlyWindow()) {
      if (typeof existing?.isSidebarOpen === 'boolean') shared.isSidebarOpen = existing.isSidebarOpen;
      else delete shared.isSidebarOpen;
      if (typeof existing?.sidebarWidth === 'number') shared.sidebarWidth = existing.sidebarWidth;
      else delete shared.sidebarWidth;
    }
    // A shared terminal pref this window never changed is a boot-time copy; the file may
    // already hold a sibling window's newer value, which wins.
    for (const key of SHARED_TERMINAL_PREF_KEYS) {
      if (this.touchedSharedTerminalPrefs.has(key)) continue;
      if (existing && key in existing) shared[key] = existing[key];
    }
    return {
      ...shared,
      version: SAVED_TABS_SCHEMA_VERSION,
      owners,
      updatedAt: Date.now(),
    };
  }
  private isDisposed = false;
  /** When the window last lost focus; null while it has focus. */
  private windowBlurredAtMs: number | null = null;
  private lastResurfaceAtMs = 0;
  /**
   * Close-admission facts injected by Main (see `TabHostCloseAdmission`). Absent means
   * "no close attempt is running"; every consumer below then behaves exactly as it did
   * before this seam existed instead of guessing at an attempt's state.
   */
  private closeAdmission: TabHostCloseAdmission | null = null;
  /**
   * Whether a window currently exists for an owner key, as Main's window directory answers it.
   *
   * A terminal row's owner key names the window that renders it, so a row moved onto a project
   * whose window is not open would belong to nothing: no window's scope matches it and the shell
   * the user meant to hand it to is not there to show it. Main owns the window directory, so the
   * host asks through this seam rather than inferring a window from a title or a census. A host
   * that was never wired answers "absent", which refuses the move instead of filing a row under a
   * window nothing can produce.
   */
  private ownerWindowPresence: ((ownerKey: string) => boolean) | null = null;

  /**
   * Install (or clear) the window-presence seam. Main injects its window directory here, the
   * way it injects the close reservations; a host without it refuses owner-keyed moves rather
   * than assuming the window exists.
   */
  public setOwnerWindowPresence(presence: ((ownerKey: string) => boolean) | null): void {
    this.ownerWindowPresence = typeof presence === 'function' ? presence : null;
  }
  /**
   * Main's canonical answer for one project id, or undefined when the project has no unambiguous
   * assignment target. Main owns project/capsule authority, so the host asks through this seam and
   * never resolves a capsule from renderer state.
   */
  private projectAssignmentResolver: ((projectId: string) => TerminalProjectAssignment | undefined) | null = null;

  /**
   * Install (or clear) Main's project assignment resolver. A host without it cannot prove a
   * project id, so project-keyed moves fail closed rather than stamping a capsule id the renderer
   * supplied.
   */
  public setProjectAssignmentResolver(resolver: ((projectId: string) => TerminalProjectAssignment | undefined) | null): void {
    this.projectAssignmentResolver = typeof resolver === 'function' ? resolver : null;
  }

  /**
   * Main's resolver for execution backends. Enables control plane runs to resolve
   * their execution backend instance for cancellation.
   */
  private runBackendResolver: ((backendId: string) => ExecutionBackend | undefined) | null = null;

  public setRunBackendResolver(resolver: ((backendId: string) => ExecutionBackend | undefined) | null): void {
    this.runBackendResolver = typeof resolver === 'function' ? resolver : null;
  }

  public runBackendFor(backendId: string): ExecutionBackend | undefined {
    const resolver = this.runBackendResolver;
    if (!resolver) return undefined;
    try {
      return resolver(backendId);
    } catch (err) {
      console.warn(`[native-tab-host] run backend for '${backendId}' could not be resolved:`, err);
      return undefined;
    }
  }

  /**
   * RunStateService instance for observing and projecting terminal runs.
   */
  private runStateService: RunStateService | null = null;
  private wireRunStateService: ((service: RunStateService) => void) | null = null;

  public setRunStateService(service: RunStateService | null): void {
    if (this.runStateService === service) return;
    this.runStateService = service;
    if (service && this.wireRunStateService) {
      this.wireRunStateService(service);
    }
  }

  public getRunStateService(): RunStateService | null {
    return this.runStateService;
  }

  /**
   * Main's assignment record for a project id, or undefined for an unknown or ambiguous project.
   * Resolver failure is observed as a refusal: a malformed authority never turns into a guess.
   */
  private projectAssignmentFor(projectId: string): TerminalProjectAssignment | undefined {
    const resolver = this.projectAssignmentResolver;
    if (!resolver) return undefined;
    try {
      const assignment = resolver(projectId);
      if (!assignment) return undefined;
      const capsuleId = typeof assignment.capsuleId === 'string' ? assignment.capsuleId.trim() : '';
      return capsuleId ? { capsuleId } : {};
    } catch (err) {
      console.warn(`[native-tab-host] project assignment for '${projectId}' could not be resolved:`, err);
      return undefined;
    }
  }

  /**
   * Main-owned open for a terminal link. The owner key names the destination project window and the
   * opener is required to route the URL there — never to the caller's window and never externally.
   */
  private terminalLinkOpener: ((ownerKey: string, url: string) => Promise<boolean> | boolean) | null = null;

  /**
   * Install (or clear) Main's terminal-link opener. A host without it refuses the click rather than
   * opening the URL in whichever window happened to receive it.
   */
  public setTerminalLinkOpener(opener: ((ownerKey: string, url: string) => Promise<boolean> | boolean) | null): void {
    this.terminalLinkOpener = typeof opener === 'function' ? opener : null;
  }

  /**
   * Main-owned resolver for the project window a Space opens into: adopts or creates the project for
   * the folder, presents its window, and names the host and owner key its terminals belong to.
   */
  private spaceWindowOpener:
    | ((realFolder: string) => Promise<{ ok: true; host: NativeTabHost; ownerKey: string } | { ok: false; message: string }>)
    | null = null;

  public setSpaceWindowOpener(
    opener: ((realFolder: string) => Promise<{ ok: true; host: NativeTabHost; ownerKey: string } | { ok: false; message: string }>) | null,
  ): void {
    this.spaceWindowOpener = typeof opener === 'function' ? opener : null;
  }

  public getSpaceWindowOpener(): NativeTabHost['spaceWindowOpener'] {
    return this.spaceWindowOpener;
  }
  /**
   * Nesting depth of admitted agent actions. The keyboard action the automation host
   * routes back through this host arrives with an action already admitted, so the inner
   * call asserts the refusal but does not register a second operation for one action.
   */
  private agentActionAdmissionDepth = 0;
  /**
   * Pages this host's own `closePage()` is closing *under* an attempt's reservation.
   * A reservation alone means "an attempt owns this page and no other caller may
   * destroy it"; this set names the one caller that is allowed through, so the
   * attempt's own authorized close still runs the local tab cleanup.
   */
  private readonly attemptAuthorizedCloses = new Set<string>();
  /** In-flight `closePage()` calls by tab id, so a duplicate close is the same outcome. */
  private readonly pendingPageCloses = new Map<string, Promise<TabPageCloseOutcome>>();
  /** Latches the child-view teardown so it disposes each webContents exactly once. */
  private childViewsDisposed = false;
  /**
   * Releases for the listeners this host registered on the shared `TerminalManager`
   * singleton. The manager outlives every window, so a host that never unsubscribed
   * would be kept alive by the manager's listener list and would keep forwarding
   * terminal payloads into destroyed views.
   */
  private terminalSubscriptionReleases: Array<() => void> = [];
  private isPersistingTabs = false;
  private hasPendingPersist = false;
  /**
   * Persisted-row snapshot parked by `parkPersistDataForClose` while this window's
   * close attempt runs. `persistSync` spends it instead of rebuilding from the
   * (by then emptied) live map — that is what keeps a detached `project:` owner
   * record's rows on disk through the close, where `reattachProject` can fold
   * them back to the hub. `null` whenever no close is in flight.
   */
  private parkedPersistData: Record<string, unknown> | null = null;
  // Serialized projection of the last successful saved-tabs write, and the file
  // mtime it carried. When the next projection serializes identical AND the
  // file is untouched since our write, the read-modify-write would land the
  // same bytes — persist skips the whole disk trip in that case.
  private lastPersistedProjection: string | undefined;
  private lastPersistedFileMtimeMs: number | undefined;
  private lastPersistedFileSize: number | undefined;
  private broadcastStatePending = false;
  private broadcastMicrotaskQueued = false;
  private broadcastTimer?: NodeJS.Timeout;
  private broadcastDeadline = 0;
  private readonly BROADCAST_MIN_INTERVAL_MS = 200; // 5 Hz ceiling

  /** The shared terminal prefs as comparable text, keyed by their saved-tabs name. */
  private sharedTerminalPrefsSnapshot(): Record<SharedTerminalPrefKey, string> {
    return {
      terminalCollapsedCategories: JSON.stringify(this.terminalCollapsedCategories),
      terminalCategories: JSON.stringify(this.terminalCategories),
      terminalCategoryColors: JSON.stringify(this.terminalCategoryColors),
      terminalStarredCategories: JSON.stringify(this.terminalStarredCategories),
      terminalProjectOrder: JSON.stringify(this.terminalProjectOrder),
    };
  }

  /**
   * SET_TAB_PREFS: apply a renderer's prefs and remember which shared keys actually changed.
   * A renderer always sends its whole set, so only a real change marks a key as this
   * window's to write; an unchanged stale copy never overwrites a sibling's value.
   */
  public applyTerminalTabPrefsFromUser(prefs: Partial<TerminalTabPrefs>): boolean {
    const before = this.sharedTerminalPrefsSnapshot();
    const layoutChanged = this.applyTerminalTabPrefs(prefs);
    const after = this.sharedTerminalPrefsSnapshot();
    for (const key of SHARED_TERMINAL_PREF_KEYS) {
      if (before[key] !== after[key]) this.touchedSharedTerminalPrefs.add(key);
    }
    return layoutChanged;
  }

  /**
   * This window's terminal layout and width, read from its own owner record. A record that
   * never stored them falls back to the legacy top-level values — except the Terminal
   * Manager's layout, which opens as the sidebar column: the legacy layout was written by
   * whichever window saved last, not chosen in the manager.
   */
  private restoreWindowTerminalLayout(data: unknown): void {
    const doc = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    const owners = doc.owners && typeof doc.owners === 'object' ? doc.owners as Record<string, unknown> : {};
    const raw = owners[this.windowOwnerKey()];
    const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const layout = record.terminalTabLayout ?? (this.isTerminalOnlyWindow() ? undefined : doc.terminalTabLayout);
    const width = record.terminalSidebarWidth ?? doc.terminalSidebarWidth;
    this.applyTerminalTabPrefs({ layout, sidebarWidth: width } as Partial<TerminalTabPrefs>);
  }

  /**
   * Validates and applies terminal tab-strip prefs from any source
   * (saved-tabs.json, SET_TAB_PREFS). Unknown fields are ignored; invalid
   * values are dropped or clamped so a corrupt file can never wedge the
   * renderer. Returns true when the layout preference actually changed.
   */
  private applyTerminalTabPrefs(prefs: Partial<TerminalTabPrefs>): boolean {
    const p = (prefs && typeof prefs === 'object' ? prefs : {}) as Partial<TerminalTabPrefs>;
    const prevLayout = this.terminalTabLayout;
    if (p.layout === 'horizontal' || p.layout === 'sidebar') {
      this.terminalTabLayout = p.layout;
    }
    if (typeof p.sidebarWidth === 'number') {
      this.terminalSidebarWidth = clampTerminalTabSidebarWidth(p.sidebarWidth);
    }
    if (Array.isArray(p.collapsedCategories)) {
      this.terminalCollapsedCategories = p.collapsedCategories
        .filter((c): c is string => typeof c === 'string')
        .slice(0, TERMINAL_COLLAPSED_CATEGORIES_MAX);
    }
    if (Array.isArray(p.categories)) {
      this.terminalCategories = normalizeTerminalCategories(p.categories);
    }
    if (p.categoryColors && typeof p.categoryColors === 'object') {
      this.terminalCategoryColors = normalizeTerminalCategoryColors(p.categoryColors);
    }
    if (Array.isArray(p.starredCategories)) {
      // A star names a category, so it takes the same normalization as the name list:
      // trimmed, de-duplicated case-insensitively, length-capped.
      this.terminalStarredCategories = normalizeTerminalCategories(p.starredCategories);
    }
    if (Array.isArray(p.projectOrder)) {
      // Project ids are opaque names here: the same trim / de-dupe / cap as category names.
      this.terminalProjectOrder = normalizeTerminalCategories(p.projectOrder);
    }
    return this.terminalTabLayout !== prevLayout;
  }

  private schedulePersist(): void {
    if (this.isDisposed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistTabsAsync().catch((err) => {
        console.warn('[native-tab-host] Failed to persist tabs async:', err);
      });
    }, 400);
  }

  /**
   * Leading + trailing throttle for high-frequency title/favicon events
   * (pages rewriting document.title continuously). The leading edge paints
   * the first title change immediately; continuous churn is capped at
   * <= 1 broadcast / 200ms (5 Hz ceiling); a trailing flush guarantees the
   * final title value lands within 200ms of the last event without freeze.
   */
  private scheduleTitleBroadcast(): void {
    if (this.isDisposed) return;
    const now = Date.now();
    if (now >= this.titleBroadcastDeadline) {
      this.titleBroadcastDeadline = now + TITLE_BROADCAST_INTERVAL_MS;
      clearTimeout(this.titleBroadcastTimer);
      this.titleBroadcastTimer = undefined;
      this.broadcastState();
      return;
    }
    if (!this.titleBroadcastTimer) {
      this.titleBroadcastTimer = setTimeout(() => {
        this.titleBroadcastTimer = undefined;
        this.titleBroadcastDeadline = Date.now() + TITLE_BROADCAST_INTERVAL_MS;
        this.broadcastState();
      }, this.titleBroadcastDeadline - now);
    }
  }

  private buildPersistData(): Record<string, unknown> {
    const tabList = this.tabOrder.map((id) => {
      const tab = this.tabs.get(id);
      if (!tab) return null;
      if (tab.state.ephemeral === true) return null;
      // projectId lives on the record, not on AntiFanTab, so the sanitize/migrate
      // whitelist never sees it: merge it onto the serialized row here and read it back
      // verbatim in restoreTabs. Optional field — absent means "minted outside a project".
      const persisted: Partial<AntiFanTab> & { projectId?: string } = sanitizeTabForPersistence(tab.state);
      if (tab.projectId) persisted.projectId = tab.projectId;
      return persisted;
    }).filter(Boolean);


    const persistedAffinities: Array<{
      terminalId: string;
      primaryTabId: string;
      managedTabIds: string[];
    }> = [];

    if (this.terminalAgentAffinity) {
      const isAgentTabId = (id?: string) => {
        if (!id) return false;
        const t = this.tabs.get(id);
        return t ? t.state.ephemeral === true : false;
      };

      const seenTerminals = new Set<string>();
      for (const [key, entry] of this.terminalAgentAffinity.entries()) {
        const terminalId = key.split('@')[0];
        if (!terminalId || seenTerminals.has(terminalId) || entry.closedAt) continue;
        seenTerminals.add(terminalId);

        const rawPrimaryTabId = entry.primaryTabId || entry.tabId;
        if (isAgentTabId(rawPrimaryTabId) || isAgentTabId(entry.tabId)) {
          continue;
        }

        const rawManaged = Array.from(entry.managedTabIds || [entry.tabId]);
        const filteredManaged = rawManaged.filter((id) => !isAgentTabId(id));

        if (filteredManaged.length === 0 && (!rawPrimaryTabId || isAgentTabId(rawPrimaryTabId))) {
          continue;
        }

        persistedAffinities.push({
          terminalId,
          primaryTabId: rawPrimaryTabId,
          managedTabIds: filteredManaged.length > 0 ? filteredManaged : (rawPrimaryTabId ? [rawPrimaryTabId] : []),
        });
      }
    }

    let persistedActiveTabId: string | undefined = this.activeTabId;
    if (persistedActiveTabId) {
      const activeTab = this.tabs.get(persistedActiveTabId);
      if (!activeTab || activeTab.state.ephemeral === true) {
        persistedActiveTabId = undefined;
      }
    }

    return {
      activeTabId: persistedActiveTabId,
      // The hub's presented project is part of this window's scope record: restoring
      // it puts the booted hub back under the same project instead of defaulting to
      // "no project". Only the 'web' owner carries it; other shells have no scope.
      ...(this.windowOwnerKey() === WEB_OWNER_KEY ? { activeProjectId: this.activeProjectId } : {}),
      tabs: tabList,
      bookmarks: this.bookmarks,
      mutedSites: Array.from(this.mutedSites),
      activeChromeProfileId: ChromeProfileSyncManager.getInstance().activeProfileId,
      sidebarWidth: this.shell.sidebarWidth,
      isSidebarOpen: this.shell.isSidebarOpen,
      terminalTabLayout: this.terminalTabLayout,
      terminalSidebarWidth: this.terminalSidebarWidth,
      terminalCollapsedCategories: this.terminalCollapsedCategories,
      terminalCategories: this.terminalCategories,
      terminalCategoryColors: this.terminalCategoryColors,
      terminalStarredCategories: this.terminalStarredCategories,
      terminalProjectOrder: this.terminalProjectOrder,
      // Popout/terminal-window fields are intentionally absent: the producers were
      // removed with the one-Terminal-Manager cutover and the legacy keys only existed
      // for restore-time reopen, which no longer happens. `normalizeSavedTabsDocument`
      // still READS them so old files upgrade cleanly; we just stop writing constants.
      terminalAffinities: persistedAffinities,
      updatedAt: Date.now(),
    };
  }

  /**
   * The projection written on a successful persist, serialized the way the
   * merged document would use it. `updatedAt` is volatile per call — the merge
   * stamps its own — so it is masked before comparison.
   */
  private serializedPersistProjection(data: Record<string, unknown>): string {
    return JSON.stringify({ ...data, updatedAt: 0 });
  }

  /**
   * Whether the persisted file still carries this window's last write and the
   * projected data is identical: in that case the read-modify-write would
   * produce the same bytes and is skipped wholesale. An identical projection
   * against a deleted or externally rewritten file is still written — the
   * file-not-found and mtime checks keep crash-durability semantics exact.
   */
  private persistProjectionIsUnchanged(filePath: string, serialized: string): boolean {
    if (this.lastPersistedProjection !== serialized || this.lastPersistedFileMtimeMs === undefined) {
      return false;
    }
    try {
      const stat = fs.statSync(filePath);
      return stat.mtimeMs === this.lastPersistedFileMtimeMs && stat.size === this.lastPersistedFileSize;
    } catch {
      return false;
    }
  }

  /** Records the projection + file stamp of a confirmed write for the skip above. */
  private notePersistedProjection(filePath: string, serialized: string): void {
    this.lastPersistedProjection = serialized;
    try {
      const stat = fs.statSync(filePath);
      this.lastPersistedFileMtimeMs = stat.mtimeMs;
      this.lastPersistedFileSize = stat.size;
    } catch {
      this.lastPersistedFileMtimeMs = undefined;
      this.lastPersistedFileSize = undefined;
    }
  }

  public async persistTabsAsync(): Promise<void> {
    if (this.isDisposed) return;
    if (this.isPersistingTabs) {
      this.hasPendingPersist = true;
      return;
    }
    this.isPersistingTabs = true;
    try {
      const maxMergeAttempts = 5;
      let mergeAttempts = 0;
      do {
        mergeAttempts += 1;
        this.hasPendingPersist = false;
        const filePath = this.getTabsStoragePath();
        const data = this.buildPersistData();
        const serialized = this.serializedPersistProjection(data);
        if (this.persistProjectionIsUnchanged(filePath, serialized)) {
          continue;
        }
        const swapped = await enqueueSavedTabsWrite(filePath, async () => {
          // The read has to see what another window wrote since this window last looked.
          // `data` was captured when this task was QUEUED; if the host was disposed while it
          // waited (another write interleaved), the teardown's parked persistSync already wrote
          // the final record — writing stale captured data now would truncate it.
          if (this.isDisposed) return false;
          // Snapshot BEFORE the read: a swap that lands while the read is in progress
          // or during the off-thread byte write must both invalidate this merge.
          const version = currentSavedTabsWriteVersion();
          const existing = this.normalizeSavedTabsFileForMerge(filePath);
          // The byte write happens off the main thread. A synchronous writer (a closing
          // window's disposal persist, which cannot enter this chain) may land a newer
          // record while it runs; the version snapshot taken with the merge detects that
          // and the stale projection is discarded instead of renamed over the newer one.
          return writeSavedTabsDocumentAsync(filePath, this.buildSavedTabsDocument(existing, data), version);
        });
        if (!swapped) {
          // Discarded: re-merge against the newer document on the next pass.
          if (!this.isDisposed) {
            this.hasPendingPersist = true;
            if (mergeAttempts >= maxMergeAttempts) {
              console.warn(
                `[native-tab-host] Persist tabs async exceeded max merge attempts (${maxMergeAttempts}); deferring to next persist trigger`
              );
              break;
            }
          }
          continue;
        }
        this.notePersistedProjection(filePath, serialized);
        console.log('[native-tab-host] Persisted tabs async to:', filePath);
      } while (this.hasPendingPersist && !this.isDisposed);
    } catch (err) {
      console.warn('[native-tab-host] Failed to persist tabs async:', err);
    } finally {
      this.isPersistingTabs = false;
    }
  }

  public persistTabs(): void {
    this.persistSync();
  }

  /**
   * The detached-lifecycle parking seam the close coordinator calls before it
   * closes this window's pages. The snapshot is taken HERE — while every member
   * tab is still live — and `persistSync` spends it when the window's own
   * teardown runs, so a `project:` owner record's rows survive the close that
   * empties the map. Idempotent inside one attempt; a later `releaseParkedTabs`
   * (refused close) or a successful teardown's `isDisposed` guard bounds it.
   */
  public parkPersistDataForClose(): void {
    if (this.isDisposed) return;
    this.parkedPersistData = this.buildPersistData();
  }

  /** Discards a snapshot parked by `parkPersistDataForClose` (refused close). */
  public releaseParkedPersistData(): void {
    this.parkedPersistData = null;
  }

  /**
   * Drops the project stamp on each named live tab — the honest end state of a
   * tab that refused to leave during detach: it stays on the hub, unscoped and
   * VISIBLE, instead of keeping a stamp the suppressed-row read filter would
   * hide while the project record stays detached. Returns the ids cleared.
   */
  public clearTabProjectStamp(tabIds: readonly string[]): string[] {
    const cleared: string[] = [];
    for (const tabId of tabIds) {
      const tab = this.tabs.get(tabId);
      if (tab && tab.projectId) {
        tab.projectId = undefined;
        cleared.push(tabId);
      }
    }
    if (cleared.length > 0) this.schedulePersist();
    return cleared;
  }

  public persistSync(): void {
    if (this.isDisposed) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const filePath = this.getTabsStoragePath();
      // Parked rows win over the live map: during a detached shell's teardown the
      // map is already empty, and the owner record must keep the pre-close set.
      const data = this.parkedPersistData ?? this.buildPersistData();
      const serialized = this.serializedPersistProjection(data);
      if (!this.persistProjectionIsUnchanged(filePath, serialized)) {
        const document = this.buildSavedTabsDocument(this.normalizeSavedTabsFileForMerge(filePath), data);
        this.writeSavedTabsDocumentSync(filePath, document);
        this.notePersistedProjection(filePath, serialized);
        console.log('[native-tab-host] Persisted tabs sync to:', filePath);
      }
    } catch (err) {
      console.warn('[native-tab-host] Failed to persist tabs sync:', err);
    }
  }


  public restoreTabs(fallbackUrl?: string, options?: { safeStart?: boolean }): void {
    try {
      // Migrates a legacy flat file on first read; shared preferences apply to every
      // window, while tabs/popouts/affinities belong to this window's owner record.
      const document = this.loadSavedTabsDocument();
      if (document) {
        this.restoreMutedSites(document.mutedSites);
        if (typeof document.sidebarWidth === 'number' && document.sidebarWidth >= 260 && document.sidebarWidth <= 850) {
          this.shell.sidebarWidth = document.sidebarWidth;
        }
        if (typeof document.isSidebarOpen === 'boolean' && !this.isTerminalOnlyWindow()) {
          this.shell.isSidebarOpen = document.isSidebarOpen;
        }
        this.restoreWindowTerminalLayout(document);
        this.applyTerminalTabPrefs({
          collapsedCategories: document.terminalCollapsedCategories,
          categories: document.terminalCategories,
          categoryColors: document.terminalCategoryColors,
          starredCategories: document.terminalStarredCategories,
          projectOrder: document.terminalProjectOrder,
        });
        const record = document.owners[this.windowOwnerKey()];
        // The hub's presented project survives in the owner record (H5): restored here,
        // before any tab is minted or activated, so the mint stamps and the switch below
        // both run under the same scope. A persisted id is validated against Main's
        // registry seam — an id no record describes (removed project, foreign file)
        // clears to null rather than presenting a scope that cannot be proven. A host
        // built without the resolver cannot validate, so it fails closed the same way.
        // Restoring a different project than the boot one hands the change to Main
        // through the same delegate a user-plane flip uses, so the affiliation follows.
        if (record && this.windowOwnerKey() === WEB_OWNER_KEY) {
          const persistedProject = typeof record.activeProjectId === 'string' && record.activeProjectId.trim()
            ? record.activeProjectId.trim()
            : null;
          // A detached project's scope can never be restored onto the hub: the
          // boot leg resurrects its shell unfocused, while routing through the
          // activation delegate here would fire the exclusivity funnel —
          // recreating that shell FOCUSED mid-restore, spending the single
          // focus steal on the wrong window, then throwing.
          const persistedDetached = persistedProject !== null
            && document.owners[`project:${persistedProject}`]?.detached === true;
          const restoredProject = persistedProject && !persistedDetached && this.describeWebHubProject(persistedProject) ? persistedProject : null;
          // Main is the single writer of the hub's project scope: its boot activation has
          // already set the affiliation for the project it chose, so a different persisted
          // project goes back through the same delegate a flip uses (setActiveProject does
          // not repoint before the restore finishes, so this cannot shadow it). A persisted
          // id that cannot be proven leaves Main's scope alone instead of nulling it under
          // a live affiliation. A host with no delegate (no Main) applies the field.
          if (restoredProject && restoredProject !== this.activeProjectId) {
            if (this.foreignProjectActivatedHandler) {
              try {
                this.foreignProjectActivatedHandler(restoredProject);
              } catch (err) {
                console.warn('[native-tab-host] restoring the persisted hub project failed:', err);
              }
            } else {
              this.activeProjectId = restoredProject;
            }
          }
        }
        if (document.activeChromeProfileId) {
          ChromeProfileSyncManager.getInstance().activeProfileId = document.activeChromeProfileId;
        }
        if (Array.isArray(document.bookmarks) && document.bookmarks.length > 0) {
          this.bookmarks = document.bookmarks;
        }
        // The Terminal Manager has no page area: tabs persisted under it from before it
        // became terminals-only are not resurrected into a window that cannot show them.
        if (record && Array.isArray(record.tabs) && record.tabs.length > 0 && !this.isTerminalOnlyWindow()) {
          // Per-project exclusivity at boot: a `project:<id>`-stamped row under
          // `owners.web` (a refuse-detach leftover, or a live-session row) must
          // never be presented by the hub while that project's detached record
          // still exists — the boot leg restores that shell and presents the
          // same tabs, so reading the row here would present it twice. The row
          // stays on disk: this is a read filter, so a reattach's fold (which
          // deletes the record) makes the next hub restore read it again.
          const isWebOwner = this.windowOwnerKey() === WEB_OWNER_KEY;
          const detachedIds: Record<string, true> = {};
          if (isWebOwner) {
            for (const [key, otherRecord] of Object.entries(document.owners)) {
              if (otherRecord?.detached !== true) continue;
              const parsed = parseOwnerKey(key);
              if (parsed.kind === 'project') detachedIds[parsed.projectId] = true;
            }
          }
          const restorableTabs = isWebOwner
            ? record.tabs.filter((row) => {
                const stamp = row?.projectId;
                return typeof stamp !== 'string' || detachedIds[stamp] !== true;
              })
            : record.tabs;
          let restoredActiveId = record.activeTabId;
          const oldIdToNewId = new Map<string, string>();

          // Identify target active tab ID from persisted session
          let targetActiveOldId = typeof record.activeTabId === 'string' ? record.activeTabId : undefined;
          if (!targetActiveOldId || !restorableTabs.some((t) => t && (t.id === targetActiveOldId || (t.state as Record<string, unknown> | undefined)?.id === targetActiveOldId))) {
            const firstValid = restorableTabs.find((t) => t && !t.ephemeral);
            if (firstValid && typeof firstValid.id === 'string') {
              targetActiveOldId = firstValid.id;
            }
          }

          for (const rawTab of restorableTabs) {
            const ingested = this.ingestTabRow(rawTab, {
              oldIdToNewId,
              stubUnlessActiveId: options?.safeStart === true ? targetActiveOldId : undefined,
            });
            if (!ingested) continue;
            if (record.activeTabId !== undefined && ingested.sourceIds.includes(record.activeTabId)) {
              restoredActiveId = ingested.id;
            }
          }

          // Rebuild Terminal Multi-Tab Affinities
          if (Array.isArray(record.terminalAffinities) && record.terminalAffinities.length > 0) {
            for (const aff of record.terminalAffinities) {
              const newPrimaryId = oldIdToNewId.get(aff.primaryTabId);
              if (newPrimaryId && this.hasTab(newPrimaryId)) {
                this.bindTerminalAgentAffinity(aff.terminalId, undefined, newPrimaryId);
                if (Array.isArray(aff.managedTabIds)) {
                  for (const oldChildId of aff.managedTabIds) {
                    const newChildId = oldIdToNewId.get(oldChildId);
                    if (newChildId && newChildId !== newPrimaryId && this.hasTab(newChildId)) {
                      this.adoptChildTab(aff.terminalId, newChildId, undefined, 'user_attached', newPrimaryId);
                    }
                  }
                }
              }
            }
          }

          if (this.tabOrder.length === 0) {
            this.createTab(fallbackUrl || 'https://www.google.com');
          } else if (restoredActiveId && this.tabs.has(restoredActiveId)) {
            const activeCandidate = this.tabs.get(restoredActiveId);
            if (activeCandidate && activeCandidate.state.ephemeral !== true) {
              this.switchTab(restoredActiveId, { plane: 'user' });
            } else if (this.tabOrder.length > 0) {
              this.switchTab(this.tabOrder[0]!, { plane: 'user' });
            }
          } else if (this.tabOrder.length > 0) {
            this.switchTab(this.tabOrder[0]!, { plane: 'user' });
          }
          this.updateLayout();
          // From here the host is live: `setActiveProject` repoints the strip.
          this.hasRestoredTabs = true;
          return;
        }
      }
    } catch (err) {
      console.warn('[native-tab-host] Failed to restore tabs:', err);
    }

    // Default fallback: a browser window is never empty. The Terminal Manager has no tabs.
    if (this.isTerminalOnlyWindow()) {
      this.updateLayout();
    } else {
      this.createTab(fallbackUrl || 'https://www.google.com');
    }
    this.hasRestoredTabs = true;
  }

  /**
   * Re-home one persisted-shape tab row as a live tab: the normalization `restoreTabs`
   * applies (`migratePersistedTab` re-validates every field), the same mint and the same
   * field re-application. Returns the minted id and the source ids the row carried (the
   * row's own `id` plus `migratePersistedTab`'s resolved id), so a caller can resolve
   * "which arrived tab was the active one" in the source's vocabulary. Returns `null`
   * for rows that may not land (agent surfaces).
   */
  private ingestTabRow(
    rawTab: Record<string, unknown>,
    opts: { oldIdToNewId: Map<string, string>; stubUnlessActiveId?: string },
  ): { id: string; sourceIds: string[] } | null {
    // Persisted entries were written from AntiFanTab states, and migratePersistedTab
    // re-validates every field it reads, so the shape assertion ends at this call.
    const migrated = migratePersistedTab(rawTab as Partial<AntiFanTab>);
    if (rawTab.ephemeral === true) return null;
    if (migrated.ephemeral === true) return null;
    const sourceIds: string[] = [];
    const rawId = typeof rawTab.id === 'string' ? rawTab.id : undefined;
    if (rawId) sourceIds.push(rawId);
    if (migrated.id && migrated.id !== rawId) sourceIds.push(migrated.id);
    const safeUrl = cleanRestoredUrl(migrated.url || 'about:blank');
    const isUnloadedStub = opts.stubUnlessActiveId !== undefined && !sourceIds.includes(opts.stubUnlessActiveId);
    const id = this.createTab(isUnloadedStub ? 'about:blank' : safeUrl, false, {
      capsuleId: migrated.capsuleId,
      userAgentMode: migrated.userAgentMode,
    });
    for (const sourceId of sourceIds) opts.oldIdToNewId.set(sourceId, id);
    const persistedProjectId = typeof rawTab.projectId === 'string' && rawTab.projectId ? rawTab.projectId : undefined;
    const tab = this.tabs.get(id);
    if (tab) {
      // The persisted project decides the stamp, not whichever project happens to be
      // active while the hub restores — a foreign record's stamp is authoritative.
      tab.projectId = persistedProjectId;
      tab.state.url = safeUrl;
      if (isUnloadedStub) {
        tab.state.isLoading = false;
      }
      if (migrated.title) tab.state.title = migrated.title;
      if (migrated.devicePresetId) this.setDevicePreset(id, migrated.devicePresetId);
      if (typeof migrated.zoomFactor === 'number') tab.state.zoomFactor = migrated.zoomFactor;
      if (migrated.splitMode) {
        this.toggleSplitReview(id, true);
        if (migrated.splitDesktopPresetId) tab.state.splitDesktopPresetId = migrated.splitDesktopPresetId;
        if (migrated.splitMobilePresetId) tab.state.splitMobilePresetId = migrated.splitMobilePresetId;
      }
      if (migrated.capsuleId && typeof migrated.capsuleId === 'string' && !tab.state.capsuleId) {
        tab.state.capsuleId = migrated.capsuleId;
        const targetCapsuleId = migrated.capsuleId;
        const capsule = this.capsuleManager.list().find((c) => c.id.toLowerCase() === targetCapsuleId.toLowerCase());
        if (capsule && fs.existsSync(capsule.workspacePath) && !this.tabPreviewUnsubscribers.has(id)) {
          const unsub = this.previewWatcherPool.retain(capsule.id, capsule.workspacePath, (event) => {
            this.dispatchScopedReload(capsule.id, event);
          });
          this.tabPreviewUnsubscribers.set(id, unsub);
        }
      }
    }
    return { id, sourceIds };
  }

  /**
   * Re-home serialized tab rows from another live host (the detach transfer) — the
   * same normalization and affinity rebuild a file restore runs, without a disk
   * round-trip. Rows mint new ids in THIS window (`createTab` owns identity); the
   * source's ids are remembered so a second delivery of the same row never lands
   * twice. The source's presented tab becomes the presented tab here.
   */
  public ingestTransferredTabRows(
    rows: readonly Record<string, unknown>[],
    options?: { terminalAffinities?: readonly SavedTerminalAffinityRecord[]; activeSourceTabId?: string },
  ): string[] {
    const minted: string[] = [];
    const oldIdToNewId = new Map<string, string>();
    const knownSourceIds = new Set([...this.tabs.keys(), ...this.transferredSourceIds]);
    for (const rawTab of rows) {
      const sourceId = typeof rawTab?.id === 'string' ? rawTab.id : undefined;
      if (sourceId && knownSourceIds.has(sourceId)) continue;
      const ingested = this.ingestTabRow(rawTab, { oldIdToNewId });
      if (!ingested) continue;
      for (const sid of ingested.sourceIds) {
        knownSourceIds.add(sid);
        this.transferredSourceIds.add(sid);
      }
      minted.push(ingested.id);
    }
    // Rebind the terminal affinities that moved with the rows: the entry's terminal id
    // is window-neutral, but its tab references name the SOURCE window's ids, so each
    // is translated through the minted-id map and rebuilt under the same primitives
    // (`bindTerminalAgentAffinity` + `adoptChildTab`) a restore uses.
    for (const aff of options?.terminalAffinities ?? []) {
      const newPrimaryId = oldIdToNewId.get(aff.primaryTabId);
      if (newPrimaryId && this.hasTab(newPrimaryId)) {
        this.bindTerminalAgentAffinity(aff.terminalId, undefined, newPrimaryId);
        if (Array.isArray(aff.managedTabIds)) {
          for (const oldChildId of aff.managedTabIds) {
            const newChildId = oldIdToNewId.get(oldChildId);
            if (newChildId && newChildId !== newPrimaryId && this.hasTab(newChildId)) {
              this.adoptChildTab(aff.terminalId, newChildId, undefined, 'user_attached', newPrimaryId);
            }
          }
        }
      }
    }
    const restoredActiveId = options?.activeSourceTabId ? oldIdToNewId.get(options.activeSourceTabId) : undefined;
    const target = restoredActiveId && this.tabs.has(restoredActiveId) ? restoredActiveId : minted[minted.length - 1];
    if (target && this.tabs.has(target)) {
      this.switchTab(target, { plane: 'user' });
    }
    this.updateLayout();
    return minted;
  }

  /**
   * The reattach half of `ingestTransferredTabRows`: re-home rows the scoped fold
   * just merged into `owners.web` — the same persisted-shape rows a restore reads,
   * normalized through the one path (`ingestTabRow`) `restoreTabs` uses. Dedupe is
   * by persisted tab id against live tabs and earlier deliveries, and a live row
   * always wins a collision: the row already on the strip is the one the user is
   * inside, so the folded copy is skipped rather than double-mounted. No
   * `activeTabId` is touched — the hub keeps its own presented tab; a scope
   * decision is the caller's, not the row seam's.
   */
  public ingestPersistedOwnerRows(
    rows: readonly Record<string, unknown>[],
    options?: { terminalAffinities?: readonly SavedTerminalAffinityRecord[] },
  ): { minted: string[]; skipped: string[] } {
    const minted: string[] = [];
    const skipped: string[] = [];
    const oldIdToNewId = new Map<string, string>();
    const knownSourceIds = new Set([...this.tabs.keys(), ...this.transferredSourceIds]);
    for (const rawTab of rows) {
      const sourceId = typeof rawTab?.id === 'string' ? rawTab.id : undefined;
      if (sourceId && knownSourceIds.has(sourceId)) {
        skipped.push(sourceId);
        continue;
      }
      const ingested = this.ingestTabRow(rawTab, { oldIdToNewId });
      if (!ingested) {
        if (sourceId) skipped.push(sourceId);
        continue;
      }
      for (const sid of ingested.sourceIds) {
        knownSourceIds.add(sid);
        this.transferredSourceIds.add(sid);
      }
      minted.push(ingested.id);
    }
    // The affinities the folded record carried name its persisted ids; translate
    // them through the mint map exactly as a live transfer does.
    for (const aff of options?.terminalAffinities ?? []) {
      const newPrimaryId = oldIdToNewId.get(aff.primaryTabId);
      if (newPrimaryId && this.hasTab(newPrimaryId)) {
        this.bindTerminalAgentAffinity(aff.terminalId, undefined, newPrimaryId);
        if (Array.isArray(aff.managedTabIds)) {
          for (const oldChildId of aff.managedTabIds) {
            const newChildId = oldIdToNewId.get(oldChildId);
            if (newChildId && newChildId !== newPrimaryId && this.hasTab(newChildId)) {
              this.adoptChildTab(aff.terminalId, newChildId, undefined, 'user_attached', newPrimaryId);
            }
          }
        }
      }
    }
    if (minted.length > 0) this.updateLayout();
    return { minted, skipped };
  }

  private injectAutoJsonViewer(wc: Electron.WebContents): void {
    this.getDevToolsHost().injectAutoJsonViewer(wc);
  }

  public renderPageSourceSkeletonHtml(): string {
    return this.getDevToolsHost().renderPageSourceSkeletonHtml();
  }

  public async fetchAndLoadPageSource(
    wc: Electron.WebContents,
    targetUrl: string,
    tabState?: AntiFanTab,
    preloadedHtml?: string
  ): Promise<void> {
    return this.getDevToolsHost().fetchAndLoadPageSource(wc, targetUrl, tabState, preloadedHtml);
  }

  public async viewPageSource(tabId?: string): Promise<string> {
    return this.getDevToolsHost().viewPageSource(tabId);
  }

  public broadcastState(immediate = false): void {
    if (this.isDisposed) return;
    this.broadcastStatePending = true;

    if (immediate) {
      this.flushBroadcastState();
      return;
    }

    if (!this.broadcastMicrotaskQueued) {
      this.broadcastMicrotaskQueued = true;
      queueMicrotask(() => {
        this.broadcastMicrotaskQueued = false;
        if (!this.broadcastStatePending || this.isDisposed) return;
        const now = Date.now();
        if (now >= this.broadcastDeadline) {
          this.flushBroadcastState();
        } else if (!this.broadcastTimer) {
          this.broadcastTimer = setTimeout(() => {
            this.broadcastTimer = undefined;
            if (this.broadcastStatePending && !this.isDisposed) {
              this.flushBroadcastState();
            }
          }, this.broadcastDeadline - now);
        }
      });
    }
  }

  public flushBroadcastState(): void {
    if (this.isDisposed) return;
    if (this.broadcastTimer) {
      clearTimeout(this.broadcastTimer);
      this.broadcastTimer = undefined;
    }
    this.broadcastStatePending = false;
    this.broadcastDeadline = Date.now() + this.BROADCAST_MIN_INTERVAL_MS;

    const payload = {
      tabs: this.getTabList(),
      activeTabId: this.activeTabId,
      isInspecting: this.isInspecting,
      isFontFinderActive: this.isFontFinderActive,
      isLensActive: this.isLensActive,
      isRulerActive: this.isRulerActive,
      isSidebarOpen: this.shell.isSidebarOpen,
      bookmarks: this.bookmarks,
      isBookmarkBarVisible: this.isBookmarkBarVisible,
      devicePresets: DEVICE_PRESETS,
      activeChromeProfile: ChromeProfileSyncManager.getInstance().getActiveProfile(),
      chromeProfiles: ChromeProfileSyncManager.getInstance().getAvailableProfiles(),
      themeQa: this.getThemeQaState(this.activeTabId),
      phoneStatus: this.cachedPhoneStatus,
      projectWindow: this.projectWindowIdentity(),
    };
    safeSendWebContents(this.shell.toolbarView?.webContents, TOOLBAR_CHANNELS.STATE_UPDATED, payload);
    this.schedulePersist();
  }

  private cachedPhoneStatus: ToolbarPhoneStatus | null = null;
  private lastPhoneStatusCheck = 0;
  private pendingPhoneStatus?: Promise<ToolbarPhoneStatus>;

  public async getPhoneStatus(forceRefresh = false): Promise<ToolbarPhoneStatus> {
    const now = Date.now();
    if (!forceRefresh && this.cachedPhoneStatus && now - this.lastPhoneStatusCheck < 5000) {
      return this.cachedPhoneStatus;
    }
    // The poll tick, a window focus and a manual refresh can land together, and each query walks the USB
    // bus. Share one in-flight enumeration between concurrent callers.
    if (!this.pendingPhoneStatus) {
      this.pendingPhoneStatus = this.queryPhoneStatus().finally(() => {
        this.pendingPhoneStatus = undefined;
      });
    }
    return await this.pendingPhoneStatus;
  }

  private async queryPhoneStatus(): Promise<ToolbarPhoneStatus> {
    const now = Date.now();
    const port = this.controlPlane?.getDevicePort();
    if (!port) {
      // Registration is a later bootstrap step than `setControlPlane`, so this answer is a real
      // observation of an incomplete bootstrap — but caching it would pin the toolbar to a false
      // "unknown" for the whole cache window. Return it uncached: the next tick sees the adapter.
      return { state: 'unknown', detail: 'Device adapter not registered yet', lastChecked: now };
    }
    let status: ToolbarPhoneStatus;
    try {
      const devices = await port.list();
      const dev = devices?.[0];
      if (!dev) {
        status = { state: 'disconnected', detail: 'No physical iOS device attached via USB', lastChecked: now };
      } else {
        status = {
          state: 'connected',
          name: dev.name || undefined,
          model: dev.model || undefined,
          osVersion: dev.osVersion || undefined,
          deviceId: dev.deviceId,
          connection: dev.connection,
          detail: 'Physical iPhone connected via USB (usbmuxd)',
          lastChecked: now,
        };
      }
    } catch (err) {
      status = {
        state: 'unknown',
        detail: err instanceof Error ? err.message : String(err),
        lastChecked: now,
      };
    }
    this.cachedPhoneStatus = status;
    this.lastPhoneStatusCheck = Date.now();
    return status;
  }

  /** Re-reads the phone after a bootstrap step that changed what the adapter can observe. */
  public refreshPhoneStatus(): void {
    void this.getPhoneStatus(true)
      .then((st) => this.broadcastPhoneStatus(st))
      .catch(() => {});
  }

  public broadcastPhoneStatus(status?: ToolbarPhoneStatus): void {
    const payload = status || this.cachedPhoneStatus;
    if (!payload) return;
    safeSendWebContents(this.shell.toolbarView?.webContents, TOOLBAR_CHANNELS.PHONE_STATUS, payload);
  }

  public setControlPlane(cp: ControlPlaneRuntime): void {
    this.controlPlane = cp;
    this.refreshPhoneStatus();
  }
  public getThemeQaState(tabId?: string): TabThemeQaState {
    const id = tabId || this.activeTabId;
    return this.tabThemeQaStates?.get(id) || { status: 'idle', issueCount: 0, updatedAt: Date.now() };
  }

  /**
   * The single write path for per-tab QA state. Every transition pushes the
   * `{tabId, state}` frame on THEME_QA_STATE unconditionally — the toolbar
   * gates foreign tabs by tabId itself — while the throttled STATE_UPDATED
   * broadcast still only runs for the tab in front of the user.
   */
  private setThemeQaState(tabId: string, state: TabThemeQaState): void {
    this.tabThemeQaStates?.set(tabId, state);
    safeSendWebContents(this.shell?.toolbarView?.webContents, TOOLBAR_CHANNELS.THEME_QA_STATE, { tabId, state });
    if (tabId === this.activeTabId) {
      this.broadcastState();
    }
  }

  /**
   * Immediate (not throttled) push of one checklist scope's fresh rows. Fired
   * by every writer — toolbar CAS save, agent per-item op — so each surface
   * repaints from the same authoritative snapshot.
   */
  public broadcastChecklistUpdated(payload: { scope: string; workspaceRoot: string; items: ThemeChecklistItem[]; updatedAt: number }): void {
    safeSendWebContents(this.shell?.toolbarView?.webContents, TOOLBAR_CHANNELS.THEME_CHECKLIST_UPDATED, payload);
  }

  /**
   * LOAD handler: fresh-from-disk read for persisted scopes, the provisional
   * map for unknown-workspace ones. Unknown scopes seed the default checklist
   * without persisting anything.
   */
  public themeChecklistLoad(input: { scope: string; workspaceRoot: string }): {
    scope: string;
    workspaceRoot: string;
    items: ThemeChecklistItem[];
    updatedAt: number;
    existed: boolean;
    migrated: boolean;
    isProvisional: boolean;
  } {
    const scope = typeof input?.scope === 'string' ? input.scope.trim() : '';
    if (!scope) {
      throw new CapabilityError('INVALID_ARGUMENT', 'theme-checklist load requires a non-empty scope');
    }
    const workspaceRoot = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot : '';
    if (isProvisionalChecklistScope(scope, workspaceRoot)) {
      const rec = this.provisionalChecklistScopes.get(scope);
      return {
        scope,
        workspaceRoot,
        items: rec ? rec.items.map((item) => ({ ...item })) : defaultChecklistItems(),
        updatedAt: rec?.updatedAt ?? 0,
        existed: Boolean(rec),
        migrated: false,
        isProvisional: true,
      };
    }
    const snapshot = getChecklistScopeRecord(workspaceRoot, scope);
    return { scope, workspaceRoot, items: snapshot.items, updatedAt: snapshot.updatedAt, existed: snapshot.existed, migrated: snapshot.migrated, isProvisional: false };
  }

  /**
   * SAVE handler: whole-array CAS write. A stale `baseUpdatedAt` returns the
   * fresh items with `conflict:true` and writes/broadcasts nothing — the
   * caller re-bases instead of clobbering an interleaved mutation (F6).
   */
  public themeChecklistSave(input: { scope: string; workspaceRoot: string; items: unknown; baseUpdatedAt?: number }): {
    ok: boolean;
    scope: string;
    workspaceRoot: string;
    items: ThemeChecklistItem[];
    updatedAt: number;
    conflict?: boolean;
    isProvisional?: boolean;
  } {
    const scope = typeof input?.scope === 'string' ? input.scope.trim() : '';
    if (!scope) {
      throw new CapabilityError('INVALID_ARGUMENT', 'theme-checklist save requires a non-empty scope');
    }
    const workspaceRoot = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot : '';
    const baseUpdatedAt = typeof input?.baseUpdatedAt === 'number' ? input.baseUpdatedAt : undefined;
    if (isProvisionalChecklistScope(scope, workspaceRoot)) {
      const rec = this.provisionalChecklistScopes.get(scope);
      if (rec && (typeof baseUpdatedAt !== 'number' || !Number.isFinite(baseUpdatedAt) || rec.updatedAt !== baseUpdatedAt)) {
        return { ok: true, scope, workspaceRoot, items: rec.items.map((item) => ({ ...item })), updatedAt: rec.updatedAt, conflict: true, isProvisional: true };
      }
      // Same caps as the persisted path — provisional is still an untrusted boundary.
      const items = validateThemeChecklistItems(input?.items);
      const updatedAt = Date.now();
      this.provisionalChecklistScopes.set(scope, { items, updatedAt });
      this.broadcastChecklistUpdated({ scope, workspaceRoot, items, updatedAt });
      return { ok: true, scope, workspaceRoot, items, updatedAt, isProvisional: true };
    }
    const result = setChecklistScopeCas(workspaceRoot, scope, input?.items, baseUpdatedAt);
    if (result.conflict) {
      return { ok: true, scope, workspaceRoot, items: result.items, updatedAt: result.updatedAt, conflict: true, isProvisional: false };
    }
    this.broadcastChecklistUpdated({ scope, workspaceRoot, items: result.items, updatedAt: result.updatedAt });
    return { ok: true, scope, workspaceRoot, items: result.items, updatedAt: result.updatedAt, isProvisional: false };
  }

  /**
   * Per-item ops the agent surface drives (`mark`/`add`/`remove`/`markPage`).
   * Persisted scopes go through the store's single-step read→apply→write;
   * provisional scopes take the identical mutation against the in-memory map.
   * Both paths broadcast the post-op snapshot.
   */
  public themeChecklistMutate(input: { scope: string; workspaceRoot: string; op: ChecklistMutationOp }): {
    scope: string;
    workspaceRoot: string;
    items: ThemeChecklistItem[];
    updatedAt: number;
    item?: ThemeChecklistItem;
    toggled?: number;
    removed?: boolean;
    isProvisional: boolean;
  } {
    const scope = typeof input?.scope === 'string' ? input.scope.trim() : '';
    if (!scope) {
      throw new CapabilityError('INVALID_ARGUMENT', 'theme-checklist mutate requires a non-empty scope');
    }
    const workspaceRoot = typeof input?.workspaceRoot === 'string' ? input.workspaceRoot : '';
    const op = input?.op;
    if (!op || typeof op !== 'object' || !('op' in op)) {
      throw new CapabilityError('INVALID_ARGUMENT', 'theme-checklist mutate requires an op');
    }
    if (isProvisionalChecklistScope(scope, workspaceRoot)) {
      const rec = this.provisionalChecklistScopes.get(scope);
      const base = rec?.items ?? defaultChecklistItems();
      const applied = applyChecklistMutation(base, op);
      const updatedAt = applied.changed ? Date.now() : (rec?.updatedAt ?? 0);
      if (applied.changed) this.provisionalChecklistScopes.set(scope, { items: applied.items, updatedAt });
      if (applied.changed) this.broadcastChecklistUpdated({ scope, workspaceRoot, items: applied.items, updatedAt });
      return { scope, workspaceRoot, items: applied.items, updatedAt, item: applied.item, toggled: applied.toggled, removed: applied.removed, isProvisional: true };
    }
    const result = mutateChecklistScopeRecord(workspaceRoot, scope, op);
    this.broadcastChecklistUpdated({ scope, workspaceRoot, items: result.items, updatedAt: result.updatedAt });
    return { scope, workspaceRoot, items: result.items, updatedAt: result.updatedAt, item: result.item, toggled: result.toggled, removed: result.removed, isProvisional: false };
  }

  /**
   * Public rework: the caller names the tab, the tab is resolved strictly via
   * `this.tabs.get(tabId)` — no automation-target fallback, so a cockpit scan
   * can never QA a different page than the one it pointed at (F1). A dead or
   * unknown id returns TARGET_REQUIRED with its own error row keyed to the
   * requested id. `workspaceRoot` is confined to the resolved workspace (F4):
   * a traversal candidate can never steer receipts outside the real root.
   */
  public async runThemeQa(tabId: string, options?: { workspaceRoot?: string }): Promise<{ ok: boolean; report?: unknown; error?: string }> {
    const requestedTabId = typeof tabId === 'string' ? tabId : '';
    const tab = requestedTabId ? this.tabs.get(requestedTabId) : undefined;
    if (!tab || (tab.view?.webContents && tab.view.webContents.isDestroyed())) {
      this.setThemeQaState(requestedTabId, { status: 'error', issueCount: 0, error: 'TARGET_REQUIRED', updatedAt: Date.now() });
      return { ok: false, error: 'TARGET_REQUIRED' };
    }
    if (!this.controlPlane) {
      const error = 'Control plane runtime is not initialized';
      this.setThemeQaState(requestedTabId, { status: 'error', issueCount: 0, error, updatedAt: Date.now() });
      return { ok: false, error };
    }
    const lease = this.controlPlane.getLease();
    const target = {
      projectId: lease.projectId,
      workspaceId: lease.workspaceId || '',
      runtimeId: lease.runtimeId,
      tabId: requestedTabId,
      browserEpoch: lease.hostEpoch,
      documentGeneration: this.getDocumentGeneration(requestedTabId),
      url: tab.state.url,
    };
    // Fail closed when no host root resolved: passing the candidate through
    // `confineWorkspaceRoot`'s empty-default branch would let a traversal
    // root steer receipts for an unbound tab (C). '' degrades to provisional.
    const resolvedRoot = this.resolveTabWorkspace(requestedTabId, tab.state.url);
    const workspaceRoot = resolvedRoot
      ? confineWorkspaceRoot(options?.workspaceRoot, resolvedRoot)
      : '';
    this.setThemeQaState(requestedTabId, { status: 'running', issueCount: 0, updatedAt: Date.now() });
    const { promise, resolve } = Promise.withResolvers<{ ok: boolean; report?: unknown; error?: string }>();
    const gen = this.getDocumentGeneration(requestedTabId);
    this.asyncQaQueue.enqueue(requestedTabId, gen, async (signal: AbortSignal) => {
        try {
          const report = await this.controlPlane!.validateThemeQa(target, { workspaceRoot, signal });
          const summary = report.summary;
          const findings = report.findings;
          const issueCount = typeof summary?.criticalCount === 'number'
            ? summary.criticalCount
            : (findings ? (
                (findings.liquid?.errors?.length || 0) +
                (findings.overflow?.culprits?.length || 0) +
                (findings.assets?.brokenAssets?.length || 0) +
                (findings.hsRules?.totalViolations || 0) +
                (findings.diagnosticIssues?.length || 0)
              ) : 0);
          const isPassed = typeof summary?.passed === 'boolean' ? summary.passed : issueCount === 0;
          const status: 'pass' | 'fail' = isPassed ? 'pass' : 'fail';
          const reportArtifactId = report.artifacts?.find((item: { kind?: string; id?: string }) => item.kind === 'report')?.id;
          this.setThemeQaState(requestedTabId, { status, issueCount, reportArtifactId, report, updatedAt: Date.now() });
          resolve({ ok: true, report });
        } catch (error) {
          if (signal.aborted) {
            resolve({ ok: false, error: 'Theme QA was aborted by document navigation' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.setThemeQaState(requestedTabId, { status: 'error', issueCount: 0, error: message, updatedAt: Date.now() });
          resolve({ ok: false, error: message });
        }
    });
    return promise;
  }
  public getBrowserEpoch(): number {
    return this.browserEpoch;
  }

  public setBrowserEpoch(epoch: number): void {
    this.browserEpoch = epoch;
  }


  public getDiagnostics(tabId?: string, level?: number | string): { console: any[]; failures: any[] } {
    const targetId = tabId || this.activeTabId;
    return this.diagnosticsManager.getDiagnostics(targetId, level);
  }

  public async runResponsiveCheck(params?: {
    tabId?: string;
    selector?: string;
    customBreakpoints?: Array<{ id: string; name: string; width: number; height: number; mobile: boolean; deviceScaleFactor?: number }>;
  } | string): Promise<Record<string, unknown>> {
    const opts = typeof params === 'string' ? { tabId: params } : (params || {});
    const targetId = opts.tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return { ok: false, error: 'Tab not found or destroyed' };
    // A responsive sweep needs a live presented surface — wake a sleeping tab
    // before reading its view rather than failing on the absent view.
    if (tab.state.hibernated === true) {
      this.ensureTabAwake(targetId);
      await this.ensureTabReady(targetId, 20000);
    }
    const rcWc = tab.view?.webContents;
    if (!rcWc || rcWc.isDestroyed()) return { ok: false, error: 'Tab not found or destroyed' };

    const wc = rcWc;
    const previousPreset = tab.state.devicePresetId;
    const testBreakpoints = opts.customBreakpoints || [
      { id: 'mobile-small', name: 'Mobile Small (320px)', width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
      { id: 'mobile-standard', name: 'Mobile Standard (375px)', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
      { id: 'tablet-portrait', name: 'Tablet Portrait (768px)', width: 768, height: 1024, deviceScaleFactor: 2, mobile: false },
      { id: 'tablet-landscape', name: 'Tablet Landscape (1024px)', width: 1024, height: 768, deviceScaleFactor: 2, mobile: false },
      { id: 'desktop-laptop', name: 'Desktop Laptop (1440px)', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    ];

    const results: Record<string, unknown> = {};
    const targetSelector = opts.selector ? JSON.stringify(opts.selector) : 'null';

    // Every breakpoint below emulates a size and then reads that size back through the
    // document. A background tab's view sits outside the window: its renderer is
    // throttled and its layout is not presented, so a reading taken there can describe
    // a stale or zero-width box instead of the override just applied. Run the sweep
    // inside a temporary in-place attach — behind the active tab's view, released when
    // the call returns — so each measurement describes a live surface without the tab
    // ever becoming the visible one.
    const sweepBreakpoints = async (): Promise<void> => {
      for (const bp of testBreakpoints) {
        await this.applyCdpDeviceEmulationState(wc, {
          id: `sweep-${bp.id}`,
          name: bp.name,
          width: bp.width,
          height: bp.height,
          deviceScaleFactor: bp.deviceScaleFactor || (bp.mobile ? 2 : 1),
          mobile: bp.mobile,
          category: bp.mobile ? 'mobile' : 'desktop',
        }, 1);


        await new Promise((resolve) => setTimeout(resolve, 60));

        const evalPromise = wc.executeJavaScript(`(() => {
          const docEl = document.documentElement;
          const body = document.body;
          const scrollW = Math.max(docEl ? docEl.scrollWidth : 0, body ? body.scrollWidth : 0);
          const clientW = docEl ? docEl.clientWidth : window.innerWidth;
          const scrollH = Math.max(docEl ? docEl.scrollHeight : 0, body ? body.scrollHeight : 0);
          const clientH = docEl ? docEl.clientHeight : window.innerHeight;
          const documentOverflowX = scrollW > clientW + 1;
          const viewportMeta = document.querySelector('meta[name="viewport"]');

          let targetData = null;
          const sel = ${targetSelector};
          if (sel) {
            try {
              const el = document.querySelector(sel);
              if (el) {
                const rect = el.getBoundingClientRect();
                const parent = el.parentElement;
                const parentRect = parent ? parent.getBoundingClientRect() : null;
                const cs = window.getComputedStyle(el);
                const targetOverflowX = parentRect
                  ? (rect.right > parentRect.right + 1 || rect.width > parentRect.width + 1)
                  : (rect.right > clientW + 1);
                targetData = {
                  found: true,
                  targetOverflowX,
                  rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                  display: cs.display,
                  visibility: cs.visibility,
                  isVisible: cs.display !== 'none' && cs.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
                };
              } else {
                targetData = { found: false, targetOverflowX: false };
              }
            } catch (err) {
              targetData = { found: false, error: String(err) };
            }
          }

          return {
            scrollWidth: scrollW,
            clientWidth: clientW,
            scrollHeight: scrollH,
            clientHeight: clientH,
            documentOverflowX,
            hasHorizontalOverflow: documentOverflowX,
            targetOverflowX: targetData ? Boolean(targetData.targetOverflowX) : false,
            target: targetData,
            hasViewportMeta: Boolean(viewportMeta),
            viewportContent: viewportMeta ? viewportMeta.getAttribute('content') : null,
          };
        })()`).catch((err: unknown) => ({ error: String(err) }));

        const timeoutPromise = new Promise<{ timeout: boolean }>((resolve) => setTimeout(() => resolve({ timeout: true }), 5000));
        const evaluation = await Promise.race([evalPromise, timeoutPromise]);

        results[bp.id] = {
          name: bp.name,
          width: bp.width,
          height: bp.height,
          mobile: bp.mobile,
          ...(typeof evaluation === 'object' && evaluation !== null ? evaluation : {}),
        };
      }
    };

    await this.runWithAttachedTabView(tab.view, async () => {
      try {
        await sweepBreakpoints();
      } finally {
        // The override this sweep applied is cleared while the view still presents a
        // live surface, and the tab is handed back to its own preset through the same
        // restoration the visible-tab path always used.
        try {
          await this.applyCdpDeviceEmulationState(wc, null);
          if (previousPreset && previousPreset !== 'responsive') {
            this.setDevicePreset(targetId, previousPreset);
          } else {
            this.updateLayout();
          }
        } catch {}
      }
    }, false);

    return {
      ok: true,
      tabId: targetId,
      url: tab.state.url,
      timestamp: Date.now(),
      breakpoints: results,
    };
  }

  public async agentTrajectory(params: { steps: Array<Record<string, unknown>>; speed?: 'fast' | 'natural' | 'slow'; smoothScroll?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<Record<string, unknown>> {
    const release = this.admitAgentAction('agentTrajectory', params.tabId);
    try {
      return await this.getAutomationHost().agentTrajectory(params);
    } finally {
      release();
    }
  }

  public async agentMove(args: { selector?: string; ref?: string; x?: number; y?: number; label?: string; force?: boolean; tabId?: string; paneId?: SplitPaneId }): Promise<boolean> {
    const release = this.admitAgentAction('agentMove', args.tabId);
    try {
      return await this.getAutomationHost().agentMove(args);
    } finally {
      release();
    }
  }

  public async cancelActiveAgentAction(tabId?: string, paneId?: SplitPaneId): Promise<boolean> {
    // A cancellation, not work: it refuses without throwing so a teardown path that calls
    // it cannot be aborted by the refusal.
    if (this.isApplicationAdmissionReservedForClose() || (tabId && this.isPageReservedForClose(tabId))) {
      return false;
    }
    return this.getAutomationHost().agentClear(tabId, paneId);
  }

  public async agentSnapshot(tabId?: string, paneId?: SplitPaneId, selector?: string, viewportOnly?: boolean): Promise<string> {
    return this.getAutomationHost().agentSnapshot(tabId, paneId, selector, viewportOnly);
  }
  public async agentFind(params: { text?: string; regex?: string; tabId?: string; paneId?: SplitPaneId; maxMatches?: number }): Promise<unknown> {
    return this.getAutomationHost().agentFind(params);
  }
  public async sendKeyboardPress(params: { key: string; modifiers?: string[]; tabId?: string }): Promise<{ success: boolean; key: string; modifiers: string[]; error?: string }> {
    const rawTargetId = params.tabId || this.automationTabId;
    if (!rawTargetId) {
      throw new CapabilityError('TARGET_REQUIRED', 'sendKeyboardPress requires an explicit target tabId or bound automation tab; refusing to target foreground tab');
    }
    const targetId = this.resolveTargetTabId(rawTargetId) || rawTargetId;
    const tab = this.tabs.get(targetId);
    if (!tab) {
      throw new CapabilityError('TARGET_STALE', `Target tab '${targetId}' not found or destroyed`);
    }
    // A sleeping target wakes before the keystroke so the press reaches the real
    // page, not a stale-check failure. `ensureTabReady` gates on did-stop-loading.
    if (tab.state.hibernated === true) {
      this.ensureTabAwake(targetId);
      await this.ensureTabReady(targetId, 20000);
    }
    const pressWc = tab.view?.webContents;
    if (!pressWc || pressWc.isDestroyed()) {
      throw new CapabilityError('TARGET_STALE', `Target tab '${targetId}' not found or destroyed`);
    }
    const release = this.admitAgentAction('sendKeyboardPress', targetId);
    try {
      return await this.withTabAgentWorking(targetId, async () => {
        const events = buildKeyboardInputEvents(params.key, params.modifiers);
        for (const evt of events) {
          this.syncWithAgentInput(() => {
            pressWc.sendInputEvent(evt);
          });
        }
        return { success: true, key: params.key, modifiers: params.modifiers || [] };
      });
    } finally {
      release();
    }
  }
  public async setViewportSize(options: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number; tabId?: string; reload?: boolean }): Promise<boolean> {
    const targetId = options.tabId || this.activeTabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return false;
    // Emulation must land on a live surface; wake a sleeping tab before any
    // attach/emulate work rather than reading an absent `tab.view`.
    if (tab.state.hibernated === true) {
      this.ensureTabAwake(targetId);
      await this.ensureTabReady(targetId, 20000);
    }
    const w = Math.round(options.width);
    const h = Math.round(options.height);
    if (w <= 0 || h <= 0) return false;
    const mobile = options.mobile ?? (w < 768);
    const isIphoneDimensions = (w === 390 && h === 844) || (w === 393 && h === 852) || (w === 430 && h === 932) || (w === 440 && h === 956);
    const resolvedDpr = options.deviceScaleFactor ?? (isIphoneDimensions ? 3 : (w < 768 ? 2 : 1));
    tab.customViewport = {
      width: w,
      height: h,
      mobile,
      deviceScaleFactor: resolvedDpr,
    };
    tab.state.devicePresetId = `custom-${w}x${h}`;
    const applyForTarget = async (): Promise<boolean> => {
      const wc = tab.view?.webContents;
      if (!wc || wc.isDestroyed()) return false;

      await this.applyCdpTouchEmulation(wc, mobile);
      // The CDP override (including the fit-preview scale) is applied by
      // `applyTabDeviceEmulation`, which `updateLayout`/`runWithAttachedTabView` just
      // ran for this tab. Re-applying it here without the computed scale would reset
      // `scale` to 1 and break the preview shrink.
      if (wc && typeof wc.executeJavaScript === 'function') {
        try {
          await wc.executeJavaScript(`
            window.dispatchEvent(new Event('resize'));
            window.dispatchEvent(new Event('orientationchange'));
          `);
        } catch {}
      }
      if (options.reload) {
        const reloadOk = await this.reloadAndWait(targetId);
        if (!reloadOk) throw new CapabilityError('TARGET_STALE', 'Reload failed or timed out before a load-complete document was available', { tabId: targetId, operation: 'setViewport' });
      }
      return true;
    };
    if (targetId === this.activeTabId) {
      this.updateLayout();
    } else {
      // A background tab is emulated outside the visible layout, so the box its document
      // is laid out against has to be measured from the window itself. A window that
      // cannot name one — absent, destroyed, or reporting a non-positive box as a
      // minimized window does — has no geometry to lay the emulation out in: refuse the
      // request instead of applying it to an invented 1440x900 or to a 0x0 box.
      const contentBounds = this.shell.window && (typeof this.shell.window.isDestroyed !== 'function' || !this.shell.window.isDestroyed()) && typeof this.shell.window.getContentBounds === 'function'
        ? this.shell.window.getContentBounds()
        : undefined;
      const toolbarHeight = typeof this.getToolbarHeight === 'function' ? this.getToolbarHeight() : 40;
      const availableWidth = contentBounds
        ? (this.shell.isSidebarOpen ? Math.max(400, contentBounds.width - this.shell.sidebarWidth) : contentBounds.width)
        : 0;
      const availableHeight = contentBounds ? Math.max(0, contentBounds.height - toolbarHeight) : 0;
      if (!contentBounds || !Number.isFinite(contentBounds.width) || !Number.isFinite(contentBounds.height)
        || contentBounds.width < 1 || contentBounds.height < 1 || availableWidth < 1 || availableHeight < 1) {
        throw new CapabilityError(
          'VIEWPORT_NOT_APPLIED',
          `Cannot apply a ${w}x${h} viewport to background tab '${targetId}': the window cannot report a usable content box`,
          { tabId: targetId, expectedWidth: w, expectedHeight: h, operation: 'setViewport', cause: 'window-unmeasurable' }
        );
      }
      // A view that was never attached has no compositor surface, so an emulation
      // applied to it has no widget to be measured against: the document lays out
      // against a zero-width box and every later probe, evaluation and capture on the
      // tab reads a viewport it does not have. Apply the emulation, the resize dispatch
      // and any reload the caller asked for inside a temporary in-place attach — below
      // the active tab's view, released when the call returns — so the requested
      // viewport is real without the tab ever becoming the visible one.
      await this.runWithAttachedTabView(
        tab.view,
        async () => {
          this.applyTabDeviceEmulation(tab, availableWidth, availableHeight, toolbarHeight);
          return await applyForTarget();
        },
        false
      );
      this.broadcastState();
      return true;
    }
    // The toolbar Device Viewport Breakpoint cluster re-renders ONLY from the
    // STATE_UPDATED broadcast; without it an MCP resize is invisible in the UI
    // (stale select + zoom label). Mirrors the updateLayout+broadcastState
    // pairing used by setZoom/toggleSplit/setSplitPreset.
    this.broadcastState();
    return await applyForTarget();
  }

  public getDevicePresets(): DevicePreset[] {
    return DEVICE_PRESETS;
  }

  public isCurrentTarget(target: BrowserTarget): boolean {
    if (!target || typeof target.tabId !== 'string' || !this.tabs.has(target.tabId)) return false;

    const currentGen = this.getDocumentGeneration(target.tabId);
    if (typeof target.documentGeneration !== 'number' || target.documentGeneration !== currentGen) return false;

    if (!this.controlPlane) return false;

    const lease = this.controlPlane.getLease();
    if (typeof target.browserEpoch !== 'number' || target.browserEpoch !== lease.hostEpoch) return false;
    if (typeof target.runtimeId !== 'string' || target.runtimeId !== lease.runtimeId) return false;
    // Fast-path equality OR dynamic registry membership check
    let projectMatches = target.projectId === lease.projectId;
    if (!projectMatches) {
      try {
        projectMatches = Boolean(this.controlPlane.workspaces.get(target.workspaceId, target.projectId));
      } catch {
        projectMatches = false;
      }
    }
    if (!projectMatches) return false;

    if (lease.workspaceId && target.workspaceId !== lease.workspaceId) {
      try {
        const ws = this.controlPlane.workspaces.get(target.workspaceId, target.projectId);
        if (!ws) return false;
      } catch {
        return false;
      }
    }
    return true;
  }

  public getDocumentGeneration(tabId?: string): number {
    const id = tabId || this.activeTabId;
    return this.documentGenerations.get(id) || 1;
  }

  public bumpDocumentGeneration(tabId?: string): number {
    const id = tabId || this.activeTabId;
    const next = (this.documentGenerations.get(id) || 1) + 1;
    this.documentGenerations.set(id, next);
    return next;
  }

  public getMutationRevision(tabId?: string): number {
    if (!this.mutationRevisions) this.mutationRevisions = new Map<string, number>();
    const id = tabId || this.activeTabId;
    return this.mutationRevisions.get(id) || 1;
  }

  public bumpMutationRevision(tabId?: string): number {
    if (!this.mutationRevisions) this.mutationRevisions = new Map<string, number>();
    const id = tabId || this.activeTabId;
    const next = (this.mutationRevisions.get(id) || 1) + 1;
    this.mutationRevisions.set(id, next);
    return next;
  }

  public toggleFullScreen(): void {
    this.shell.window.setFullScreen(!this.shell.window.isFullScreen());
  }

  public reloadWindow(): void {
    this.persistTabs();
    TerminalManager.getInstance().persistSync();
    if (this.shell.toolbarView && !this.shell.toolbarView.webContents.isDestroyed()) {
      this.shell.toolbarView.webContents.reload();
    }
    if (this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
      this.shell.sidebarView.webContents.reload();
    }
    // Standalone / popout terminal windows load the same renderer bundle
    // (standalone.html) and are not part of toolbarView/sidebarView.
    for (const win of this.terminalWindows.values()) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.reload();
      }
    }
  }

  public createPreviewTab(rawPathOrUri: string, targetCapsuleId?: string): string | null {
    try {
      let cleanPath = rawPathOrUri.trim();
      if (cleanPath.startsWith('file:///')) {
        cleanPath = decodeURIComponent(cleanPath.slice(8));
        if (/^\/[a-zA-Z]:/.test(cleanPath)) {
          cleanPath = cleanPath.slice(1);
        }
      } else if (cleanPath.startsWith('file://')) {
        cleanPath = decodeURIComponent(cleanPath.slice(7));
      }

      const allCapsules = this.capsuleManager.list();
      let matchedCapsule: WorkspaceCapsule | null = null;
      let relativePath = '';

      if (targetCapsuleId) {
        matchedCapsule = allCapsules.find((c) => c.id.toLowerCase() === targetCapsuleId.toLowerCase()) || null;
      }

      if (!matchedCapsule) {
        const resolvedAbsolute = path.resolve(cleanPath);
        for (const cap of allCapsules) {
          if (cap.workspacePath && fs.existsSync(cap.workspacePath)) {
            const capRoot = fs.realpathSync.native(path.resolve(cap.workspacePath));
            const rel = path.relative(capRoot, resolvedAbsolute);
            if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
              matchedCapsule = cap;
              relativePath = rel;
              break;
            }
          }
        }
      }

      if (!matchedCapsule) {
        matchedCapsule = this.ensureActiveCapsule();
        const capRoot = fs.realpathSync.native(path.resolve(matchedCapsule.workspacePath));
        if (path.isAbsolute(cleanPath)) {
          const rel = path.relative(capRoot, path.resolve(cleanPath));
          if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            relativePath = rel;
          } else {
            relativePath = path.basename(cleanPath);
          }
        } else {
          relativePath = cleanPath;
        }
      } else if (!relativePath) {
        const capRoot = fs.realpathSync.native(path.resolve(matchedCapsule.workspacePath));
        relativePath = path.relative(capRoot, path.resolve(cleanPath));
      }

      const previewUrl = buildPreviewUrl(matchedCapsule.id, relativePath);
      const tabId = this.createTab(previewUrl);
      if (tabId) {
        const tab = this.tabs.get(tabId);
        if (tab) {
          tab.state.title = `Preview: ${path.basename(relativePath) || 'Workspace'}`;
          this.broadcastState();
        }
      }
      return tabId;
    } catch (err) {
      console.warn('[native-tab-host] Failed to create preview tab:', err);
      return null;
    }
  }

  private ensureActiveCapsule(): WorkspaceCapsule {
    const active = this.capsuleManager.getActive();
    if (active) return active;
    const all = this.capsuleManager.list();
    if (all.length > 0) {
      this.capsuleManager.switchTo(all[0]!.id);
      return all[0]!;
    }
    return this.capsuleManager.create('Default Workspace', process.cwd(), {
      sidebarOpen: this.shell.isSidebarOpen,
      sidebarWidth: this.shell.sidebarWidth,
    });
  }

  private dispatchScopedReload(capsuleId: string, event: PreviewChangeEvent): void {
    const targetKey = capsuleId.toLowerCase();
    for (const tab of this.tabs.values()) {
      const scopedWc = tab.view?.webContents;
      if (tab.state.capsuleId?.toLowerCase() === targetKey && scopedWc && !scopedWc.isDestroyed()) {
        if (event.type === 'css-swap') {
          scopedWc.executeJavaScript(`(() => {
            document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
              const url = new URL(link.href);
              url.searchParams.set('antifan_ts', Date.now().toString());
              link.href = url.toString();
            });
          })()`).catch(() => {});
        } else {
          if (!scopedWc.isDestroyed()) {
            scopedWc.reload();
          }
          if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.reload();
          }
        }
      }
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
    // A closed window owns no workspace; nothing may route by its stale affiliation.
    this.windowWorkspaceAffiliation = null;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    clearTimeout(this.broadcastTimer);
    this.broadcastStatePending = false;
    this.persistTabs();
    this.flushAllSessions().catch(() => {});
    // Deliver any still-buffered terminal output before views are torn down, then
    // disarm the flush timer so it cannot fire into destroyed webContents.
    this.flushAllTerminalDataBatches();
    if (this.terminalDataFlushTimer) {
      clearTimeout(this.terminalDataFlushTimer);
      this.terminalDataFlushTimer = null;
    }
    if (this.hibernationSweepTimer) {
      clearInterval(this.hibernationSweepTimer);
      this.hibernationSweepTimer = null;
    }
    // A queued wake-and-wait must not hold a disposed host's promise open.
    this.tabReadyWaits?.clear();
    this.isDisposed = true;
    // Child contents FIRST, ahead of every step that talks to the shell, a tracker or
    // another host: shell closure does not prove that a WebContentsView's contents were
    // disposed, so this host disposes every webContents it created itself, and doing it
    // here means no later teardown failure can strand a live renderer.
    this.disposeChildViewContents();
    this.releaseTerminalSubscriptions();
    this.pendingPageCloses?.clear();
    this.attemptAuthorizedCloses?.clear();
    try {
      if (this.captureHostWindow && (typeof this.captureHostWindow.isDestroyed !== 'function' || !this.captureHostWindow.isDestroyed())) {
        this.captureHostWindow.destroy();
      }
    } catch {}
    this.captureHostWindow = null;
    // A held lift is released rather than silently dropped: the lease journals
    // its own lowering, buries the pane, and the raster still in flight ends on
    // the destroyed-contents guards it already has. A lifted view no tab record
    // owns would otherwise keep its renderer alive.
    try {
      this.captureLift?.lease.release('dispose');
      if (this.captureLift?.view) this.destroyOwnedWebContents(this.captureLift.view.webContents);
    } catch {}
    // Queued acquires must not outlive the host: refuse each with the window's
    // death so no raster parks its pane on a window that no longer exists.
    try {
      const gone = new CapabilityError('NO_RENDER_SURFACE', 'The owning window was disposed before the queued capture lift could be granted.');
      for (const waiter of this.captureLiftQueue ?? []) {
        clearTimeout(waiter.timer);
        waiter.reject(gone);
      }
    } catch {}
    this.captureLiftQueue = [];
    this.captureLift = null;
    this.runDisposalStep('automationHost', () => this.automationHost?.dispose());
    this.asyncQaQueue?.abortAll();
    this.runDisposalStep('semanticRefRegistry', () => this.semanticRefRegistry?.destroy());
    this.targetOperationQueues?.clear();
    // Optional like every other map cleared in dispose: this line runs on hosts that were
    // never fully constructed, and dispose must not be the thing that throws there.
    this.targetOperationOwners?.clear();
    this.semanticDocumentGenerations?.clear();
    this.sessionTabPools?.clear();
    // Chrome surfaces belong to the shell and are torn down by it; tab and
    // auxiliary webContents above stay this host's responsibility.
    this.runDisposalStep('shellChrome', () => this.shell.disposeChrome());
    this.runDisposalStep('devToolsHost', () => this.devToolsHost?.dispose());
    this.runDisposalStep('networkTracker', () => this.networkTracker.dispose());
    this.previewWatcherPool.clear();
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.titleBroadcastTimer) {
      clearTimeout(this.titleBroadcastTimer);
      this.titleBroadcastTimer = undefined;
    }
    // Terminal windows are the user's own windows, so they are asked to close politely and a
    // veto holds. What this host must not do is forget one: a window that survives this
    // disposal has no host left to answer for it, so it is kept answerable for a later close
    // attempt and its survival is reported instead of dropped (see `unownedTerminalWindows`).
    const terminalWindowsAtDisposal = [...this.terminalWindows.values()];
    for (const win of terminalWindowsAtDisposal) {
      try {
        if (win && !win.isDestroyed()) win.close();
      } catch (err) {
        console.warn('[native-tab-host] Failed to close a terminal window at disposal:', err);
      }
    }
    this.terminalWindows.clear();
    this.terminalWindowMeta.clear();
    this.terminalDisplayedSessions.clear();
    this.popoutWindow = null;
    this.claimTerminalWindowsLeftBehind(terminalWindowsAtDisposal);
    for (const unsub of this.tabPreviewUnsubscribers.values()) {
      try { unsub(); } catch {}
    }
    this.tabPreviewUnsubscribers.clear();
  }

  /**
   * Keep the terminal windows this host could not take with it answerable, and say so.
   *
   * The claim is recorded in the task that disposed the host — a close attempt that starts
   * right after this one must already see the window — while the report waits for the close to
   * have had its chance, exactly like the shell's own chrome audit: the platform destroys a
   * window on a later turn, so "still alive in this task" is not survival and must never be
   * reported as one. A window that is still there afterwards is a fact worth naming: its host
   * is gone, it is visible only through another live shell, and its veto has to reach the next
   * attempt instead of being lost with this one.
   */
  private claimTerminalWindowsLeftBehind(windows: BrowserWindow[]): void {
    const label = this.windowOwnerKey();
    const survivors: Array<{ contentsId: number; windowId: number }> = [];
    for (const win of windows) {
      try {
        if (!win || win.isDestroyed()) continue;
        const contentsId = win.webContents?.id;
        if (typeof contentsId !== 'number') continue;
        keepTerminalWindowAnswerable(label, win);
        survivors.push({ contentsId, windowId: win.id });
      } catch (err) {
        console.warn('[native-tab-host] Failed to record a terminal window left behind:', err);
      }
    }
    if (survivors.length === 0) return;
    const timer = setTimeout(() => {
      const alive = survivors.filter((entry) => unownedTerminalWindowFor(entry.contentsId) !== undefined);
      if (alive.length === 0) return;
      console.error(
        `[native-tab-host] ${label} was disposed with ${alive.length} terminal window(s) still alive ` +
        `${TERMINAL_WINDOW_CLOSE_SETTLE_MS}ms after disposal: ` +
        `${alive.map((entry) => `terminalPopout#${entry.contentsId} (window ${entry.windowId})`).join(', ')} ` +
        `— their close was refused or has not landed, and they stay answerable to the next close attempt`
      );
      recordLifecycleEvent('tabhost.terminalWindowsLeftBehind', {
        owner: label,
        windows: alive.length,
        windowIds: alive.map((entry) => entry.windowId),
      });
    }, TERMINAL_WINDOW_CLOSE_SETTLE_MS);
    // A diagnostic must not hold the process open: the window it reports on is already an
    // orphan, and an exiting process reports it through the census instead.
    if (typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Destroy every tab child view's webContents and detach the view, exactly once per
   * host. Its own latch keeps a second call inert even if an earlier teardown step threw
   * before reaching this one, and each view is isolated so one failure cannot strand the
   * others. The tab map is cleared first, so a `destroyed` listener firing mid-loop can
   * never re-enter the close path against a record this loop is already unwinding.
   */
  private disposeChildViewContents(): void {
    if (this.childViewsDisposed) return;
    this.childViewsDisposed = true;
    const tabsToClean = [...this.tabs.entries()];
    this.tabs.clear();
    this.tabOrder = [];
    for (const [id, tab] of tabsToClean) {
      // The tabs map is already cleared, so `closeTab` would no-op; attribution is
      // emitted directly here instead of routing through the full teardown (which
      // would touch shell/views mid-dispose).
      this.recordTabClosedTelemetry(id, tab, 'host-dispose');
      try {
        if (tab.view) this.shell.window.contentView.removeChildView(tab.view);
      } catch {}
      try {
        this.destroyOwnedWebContents(tab.view?.webContents);
      } catch {}
      if (tab.mobileView) {
        try {
          this.shell.window.contentView.removeChildView(tab.mobileView);
        } catch {}
        try {
          this.destroyOwnedWebContents(tab.mobileView.webContents);
        } catch {}
      }
      // Teardown must finish the steps after it, so a collaborator that was never
      // constructed or that fails here cannot strand the remaining child contents.
      try { this.splitCoordinator?.cleanupTab(id); } catch {}
    }
  }

  /**
   * Drop the listeners this host registered on the shared `TerminalManager` singleton,
   * exactly once per host. The manager outlives every window: leaving them registered
   * would keep this host (and its views) reachable from the manager forever and would
   * keep fanning terminal payloads at a torn-down shell. Only this host's own handlers
   * are removed — another window's listeners are never touched.
   */
  private releaseTerminalSubscriptions(): void {
    const releases = this.terminalSubscriptionReleases ?? [];
    this.terminalSubscriptionReleases = [];
    for (const release of releases) {
      try { release(); } catch {}
    }
  }

  /**
   * Run one teardown step of a collaborator this host does not own. A failing step is
   * reported and skipped: teardown must still finish the steps after it, and the caller
   * of `dispose()` must not have to catch a failure that is already recorded.
   */
  private runDisposalStep(name: string, step: () => void): void {
    try {
      step();
    } catch (err) {
      console.warn(`[native-tab-host] dispose step '${name}' failed:`, err);
    }
  }
}
