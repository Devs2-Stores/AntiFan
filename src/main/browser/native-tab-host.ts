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
import { AntiFanTab, SplitPaneId, AntiFanPickedElement, TOOLBAR_CHANNELS, SIDEBAR_CHANNELS, TERMINAL_CHANNELS, FRAME_BACKDROP_CHANNELS, TerminalAckPayload, TerminalDataPayload, TerminalTabLayout, TerminalTabPrefs, TERMINAL_TAB_LAYOUT_DEFAULT_WIDTH, clampTerminalTabSidebarWidth, TERMINAL_CATEGORY_COLORS_MAX, TERMINAL_CATEGORY_COLOR_PATTERN, ToolbarPhoneStatus, TerminalAgentAffinityInfo, TabsUpdatedPayload, ProjectWindowIdentity } from '../../shared/contracts';
import { getSecureWebPreferences, sanitizeUrl, isAllowedNavigation, cleanRestoredUrl, isInternalWidgetOrSubframeUrl } from '../security/security-policy';
import { ELEMENT_PICKER_SCRIPT } from './element-picker';
import { resolveWorkspaceFromUrl, DEFAULT_WORKSPACE_ROOTS } from './workspace-resolver';
import { FONT_FINDER_SCRIPT } from './font-finder';
import { GPU_LENS_SCRIPT } from './gpu-lens';
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
import { WorkspaceCapsuleManager, findCapsuleByRoot, findReusableCapsule, type WorkspaceCapsule, type CapsuleAffiliation } from '../project/workspace-capsule';
import { PreviewWatcherPool, type PreviewChangeEvent } from '../server/preview-watcher-pool';
import { buildPreviewUrl, parsePreviewUrl } from '../server/preview-url-codec';
import type { ControlPlaneResourceStats, ControlPlaneRuntime } from '../control-plane/control-plane-runtime';
import type { BrowserTarget } from '../../shared/control-plane-contracts';
import type { WorkflowDefinition } from '../workflow/workflow-schema';
import { ChromeProfileSyncManager } from './chrome-profile-sync';
import { buildCookieSetDetails, runCapsuleToProfileMigration, type CapsuleMigrationCookie, type CapsuleMigrationDeps } from './capsule-partition-migration';
import { LocalSessionVault, isTrustedSessionVaultSender } from './local-session-vault';
import { LocalCredentialVault, resolveSenderFrameOrigin } from './local-credential-vault';
import { HaravanUploader } from './haravan-uploader';
import type { ActionSequenceParams, ActionSequenceResult } from './tab-automation-host';
import { TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID, workspaceTerminalProvenance, selectAnnotationTargets, type SessionSummary, type TerminalDiagnosticsReport, type TerminalManagerStats, type TerminalSessionStateProjection } from './terminal-manager';
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
import { CapabilityError, type CapabilityErrorCode } from '../../shared/control-plane-contracts';
import { isBenchmarkEnabled, recordBenchmark } from '../benchmark/telemetry';
import { AsyncThemeQaQueue } from '../qa/async-qa-job-queue';
import {
  DEFAULT_SPLIT_DESKTOP_PRESET,
  DEFAULT_SPLIT_MOBILE_PRESET,
  calculateSplitLayout,
  SplitNavigationCoordinator,
  sanitizeTabForPersistence,
  migratePersistedTab,
} from './split-review-coordinator';
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

/**
 * Owner-key prefix of a session an agent created (`window-owner.ts` spells the window
 * owners; this is the third class, and no window ever carries it).
 */
const AGENT_OWNER_KEY_PREFIX = 'agent:';

/**
 * Why handing one session to a capsule's window was refused. One vocabulary for the route's
 * own reply and for the renderer that has to say something to the user, rather than a thrown
 * message the invoker would have to parse.
 */
type TerminalCapsuleAssignReason =
  | 'INVALID_PAYLOAD'
  | 'UNKNOWN_CAPSULE'
  | 'CAPSULE_WITHOUT_PROJECT'
  | 'TARGET_WINDOW_ABSENT'
  | 'SESSION_NOT_VISIBLE'
  | 'UNKNOWN_SESSION'
  | 'MANAGER_AGENT_SESSION_READ_ONLY';

/** The answer `antifan:terminal:assign-capsule` gives the renderer: an outcome, or a refusal it can render. */
export type TerminalCapsuleAssignResult =
  | { ok: true; sessionId: string; capsuleId: string; ownerKey: string }
  | { ok: false; reason: TerminalCapsuleAssignReason; message: string };

/**
 * A refusal of the shared manager's write gate: a typed answer, never a throw. The route that
 * hit it decides how its own contract carries the refusal — a boolean route answers `false`, a
 * fire-and-forget channel logs it, and the assign route replies with the code itself.
 */
type ManagerWriteRefusal = { ok: false; reason: Extract<TerminalCapsuleAssignReason, 'MANAGER_AGENT_SESSION_READ_ONLY'>; message: string };

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
}

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

export function inferTabSemanticRole(url?: string, title?: string): { alias?: string; role?: 'admin' | 'feedback' | 'pricing' | 'spec' | 'data' | 'storefront' | 'custom'; aliasColor?: string } {
  if (!url || url === 'about:blank') return {};
  const lowerUrl = url.toLowerCase();
  const lowerTitle = (title || '').toLowerCase();

  // 1. Admin / Management portals
  if (
    lowerUrl.includes('/admin') ||
    lowerUrl.includes('admin.shopify.com') ||
    lowerUrl.includes('.myshopify.com/admin') ||
    lowerUrl.includes('.myharavan.com/admin') ||
    lowerUrl.includes('.mysapo.vn/admin') ||
    lowerUrl.includes('/wp-admin') ||
    lowerTitle.includes('quản trị') ||
    lowerTitle.includes('admin') ||
    lowerTitle.includes('dashboard')
  ) {
    return { alias: '@admin', role: 'admin', aliasColor: '#2563eb' };
  }

  // 2. Documents / Spreadsheets / Data sources
  const isDocOrSheet =
    lowerUrl.includes('docs.google.com/spreadsheets') ||
    lowerUrl.includes('docs.google.com/document') ||
    lowerUrl.includes('airtable.com') ||
    lowerUrl.includes('notion.so') ||
    lowerUrl.endsWith('.xlsx') ||
    lowerUrl.endsWith('.xls') ||
    lowerUrl.endsWith('.docx') ||
    lowerUrl.endsWith('.pdf') ||
    lowerUrl.endsWith('.csv') ||
    lowerTitle.includes('trang tính') ||
    lowerTitle.includes('bảng tính') ||
    lowerTitle.includes('spreadsheet') ||
    lowerTitle.includes('document');

  if (isDocOrSheet) {
    // 2a. Báo giá / Pricing / Quotation / Cost
    if (
      lowerTitle.includes('báo giá') ||
      lowerTitle.includes('bảng giá') ||
      lowerTitle.includes('pricing') ||
      lowerTitle.includes('price') ||
      lowerTitle.includes('quote') ||
      lowerTitle.includes('quotation') ||
      lowerTitle.includes('cost') ||
      lowerUrl.includes('bao-gia') ||
      lowerUrl.includes('pricing')
    ) {
      return { alias: '@pricing', role: 'pricing', aliasColor: '#f59e0b' };
    }

    // 2b. Tài liệu / Spec / Brief / Requirements
    if (
      lowerTitle.includes('spec') ||
      lowerTitle.includes('brief') ||
      lowerTitle.includes('tài liệu') ||
      lowerTitle.includes('guideline') ||
      lowerTitle.includes('hướng dẫn') ||
      lowerTitle.includes('requirement') ||
      lowerUrl.includes('/document/') ||
      lowerUrl.endsWith('.docx') ||
      lowerUrl.endsWith('.pdf')
    ) {
      return { alias: '@spec', role: 'spec', aliasColor: '#06b6d4' };
    }

    // 2c. Feedback / Review / QA / Issue checklist
    if (
      lowerTitle.includes('feedback') ||
      lowerTitle.includes('lỗi') ||
      lowerTitle.includes('bug') ||
      lowerTitle.includes('qa') ||
      lowerTitle.includes('review') ||
      lowerTitle.includes('checklist') ||
      lowerTitle.includes('góp ý')
    ) {
      return { alias: '@feedback', role: 'feedback', aliasColor: '#16a34a' };
    }

    // 2d. Sản phẩm / Master data / Inventory
    if (
      lowerTitle.includes('sản phẩm') ||
      lowerTitle.includes('product') ||
      lowerTitle.includes('catalog') ||
      lowerTitle.includes('danh mục') ||
      lowerTitle.includes('sku')
    ) {
      return { alias: '@data', role: 'data', aliasColor: '#10b981' };
    }

    // 2e. Bảng tính Google Sheets / Excel chung
    if (
      lowerUrl.includes('docs.google.com/spreadsheets') ||
      lowerUrl.endsWith('.xlsx') ||
      lowerUrl.endsWith('.csv') ||
      lowerTitle.includes('trang tính') ||
      lowerTitle.includes('bảng tính')
    ) {
      return { alias: '@sheet', role: 'feedback', aliasColor: '#16a34a' };
    }

    return { alias: '@doc', role: 'spec', aliasColor: '#06b6d4' };
  }

  // 3. Storefront / Live Web
  if (lowerUrl.startsWith('http://') || lowerUrl.startsWith('https://')) {
    return { alias: '@storefront', role: 'storefront', aliasColor: '#9333ea' };
  }

  return {};
}

export interface NativeTabRecord {
  view: WebContentsView;
  mobileView?: WebContentsView;
  state: AntiFanTab;
  focusedPane?: SplitPaneId;
  customViewport?: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number };
  redirectChain?: string[];
  lastNavigationFailure?: { cause: string; message: string; timedOut: boolean };
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
  /** Off-screen window that hosts a background pane for one raster so MCP capture does not paint that pane over the user's tab. */
  private captureHostWindow: BrowserWindow | null = null;
  private raisedCaptureView: WebContentsView | null = null;
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
  // they never affect this host's outer window geometry. Horizontal is the
  // default so a fresh install looks exactly like before.
  private terminalTabLayout: TerminalTabLayout = 'horizontal';
  private terminalSidebarWidth: number = TERMINAL_TAB_LAYOUT_DEFAULT_WIDTH;
  private terminalCollapsedCategories: string[] = [];
  /** User-managed group names; the only representation of an empty group. */
  private terminalCategories: string[] = [];
  /** Category name -> user-chosen chip colour. Absence means "derive from the name". */
  private terminalCategoryColors: Record<string, string> = {};
  /** Categories the user marked with `*`. A marker only; `terminalCategories` orders. */
  private terminalStarredCategories: string[] = [];
  // Running count of 'antifan:terminal:data' payloads actually handed to
  // safeSendWebContents; readable via getResourceStats/DUMP_DIAGNOSTICS without
  // benchmark mode.
  private terminalFanoutMessages = 0;
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
  private automationTabId: string | null = null;
  private terminalAgentAffinity = new Map<string, TerminalAgentAffinityEntry>();
  private readonly sessionTabPools = new Map<string, Set<string>>();
  /**
   * Pool anchor of each recently closed tab (bounded). Closing a tab removes it from
   * every pool, which would otherwise erase the only trace of which session it belonged
   * to and leave that session unable to name a replacement target.
   */
  private readonly closedTabAnchors = new Map<string, string>();
  private tabThemeQaStates = new Map<string, { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: unknown; error?: string; updatedAt: number }>();
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
   * resolves to nothing. That refusal is the point: a capsule whose project cannot be named has no
   * window to hand a terminal to, and guessing one would file a running shell under a window the
   * user never chose.
   */
  private capsuleAffiliation(capsule: WorkspaceCapsule): CapsuleAffiliation | undefined {
    const projectId = typeof capsule.projectId === 'string' ? capsule.projectId.trim() : '';
    const workspaceId = typeof capsule.workspaceId === 'string' ? capsule.workspaceId.trim() : '';
    if (projectId && workspaceId) return { projectId, workspaceId };
    return this.capsuleManager.uniqueAffiliationByRoot(capsule.workspacePath);
  }

  /** The owner key of the window a capsule's project owns, or undefined when it names no project. */
  private capsuleOwnerKey(capsule: WorkspaceCapsule): string | undefined {
    const projectId = this.capsuleAffiliation(capsule)?.projectId;
    return projectId ? ownerKey({ kind: 'project', projectId }) : undefined;
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
        resolveTargetWorkspace: (targetSessionId, tabUrl) => this.resolveTargetWorkspace(targetSessionId, tabUrl),
        resolveAnnotationWorkspace: (targetSessionId, tabUrl) => this.resolveAnnotationWorkspace(targetSessionId, tabUrl),
        getDiagnostics: (tabId, level) => (this.diagnosticsManager && typeof this.diagnosticsManager.getDiagnostics === 'function') ? this.diagnosticsManager.getDiagnostics(tabId, level as any) : null,
        createTab: (url, activate) => this.createTab(url, activate),
        withTabAgentWorking: (tabId, action) => this.withTabAgentWorking(tabId, action),
        runWithAttachedTabView: (view, action, isMobile) => this.runWithAttachedTabView(view, action, isMobile),
        getTabContentBounds: (tabId, paneId) => this.getTabContentBounds(tabId, paneId),
        switchTab: (tabId) => this.switchTab(tabId),
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
        raiseViewForCapture: (view, opts) => this.raiseViewForCapture(view, opts),
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
        if (this.shell.window.contentView.children.includes(tab.view)) count += 1;
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

    // Pre-load saved sidebar state so initial layout matches persisted user intent (no auto-open flash)
    const savedTabsPath = path.join(stateDir, 'saved-tabs.json');
    if (fs.existsSync(savedTabsPath)) {
      try {
        const raw = fs.readFileSync(savedTabsPath, 'utf8');
        const data = JSON.parse(raw);
        this.restoreMutedSites(data.mutedSites);
        if (typeof data.isSidebarOpen === 'boolean') {
          this.shell.isSidebarOpen = data.isSidebarOpen;
        }
        if (typeof data.sidebarWidth === 'number' && data.sidebarWidth >= 260 && data.sidebarWidth <= 850) {
          this.shell.sidebarWidth = data.sidebarWidth;
        }
        this.applyTerminalTabPrefs({
          layout: data.terminalTabLayout,
          sidebarWidth: data.terminalSidebarWidth,
          collapsedCategories: data.terminalCollapsedCategories,
        });
      } catch {}
    } else {
      const activeCapsule = this.capsuleManager.getActive();
      if (typeof activeCapsule?.state?.sidebarOpen === 'boolean') {
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
        safeSendWebContents(
          this.shell.sidebarView?.webContents,
          'antifan:terminal:session',
          this.terminalStateForWindow(
            TerminalManager.getInstance().getSessionState(),
            undefined,
            this.shell.sidebarView?.webContents?.id,
          ),
        );
      });
    }

    this.updateLayout();

    this.shell.onResize(() => {
      this.updateLayout();
    });
    this.shell.onShow(() => {
      this.updateLayout();
    });
    this.shell.onRestore(() => {
      this.updateLayout();
    });

    this.setupTerminalSubscriptions();
    this.setupVaultIpc();
    installChromeIpcOnce(NativeTabHost.CHROME_ROUTES);
    this.setupGlobalShortcutsOnView(this.shell.toolbarView?.webContents);
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
      if (tab && tab.view && !tab.state.offscreen && !tab.state.ephemeral) {
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
    const onTerminalData = (payload: TerminalDataPayload): void => {
      // Another project's terminal output never reaches this window's subscribers.
      if (!this.isSessionVisibleToWindow(payload.sessionId)) return;
      const pending = this.terminalDataBatches.get(payload.sessionId);
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
    };
    subscribe('data', onTerminalData);

    const onTerminalSession = (state: unknown): void => {
      // Session state must never overtake buffered output for the same session.
      this.flushAllTerminalDataBatches();
      if (this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
        safeSendWebContents(
          this.shell.sidebarView.webContents,
          'antifan:terminal:session',
          this.terminalStateForWindow(state, undefined, this.shell.sidebarView.webContents.id),
        );
      }
      for (const [id, win] of this.terminalWindows.entries()) {
        if (win && !win.isDestroyed()) {
          // A popout keeps the session it was opened with, even when that session is
          // outside the window's capsule filter.
          const boundSessionId = this.terminalWindowMeta.get(id)?.sessionId;
          safeSendWebContents(win.webContents, 'antifan:terminal:session', this.terminalStateForWindow(state, boundSessionId, win.webContents.id));
        } else {
          this.terminalWindows.delete(id);
        }
      }
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
    // repairs the entry, because the next badge read would otherwise re-arm it.
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
          const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === this.automationTabId);
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
            const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === this.automationTabId);
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
          const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === this.automationTabId);
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
      // Reject agent-plane / offscreen / ephemeral tabs; fail closed otherwise.
      isUserPlaneSender: (event: unknown): boolean => {
        const sender = this.getEventSenderWebContents(event);
        if (!sender) return false;
        const senderInfo = this.findTabByWebContents(sender);
        if (!senderInfo) return false;
        const isAgent = senderInfo.tab.state.ephemeral === true ||
          senderInfo.tab.state.offscreen === true ||
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
          const targetWc = paneId === 'mobile' ? tab.mobileView?.webContents : tab.view.webContents;
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
    channel: TOOLBAR_CHANNELS.GET_PHONE_STATUS,
    surface: 'toolbar',
    run: async ({ host }, event, args) => { return host.getPhoneStatus(typeof args[0] === 'boolean' ? args[0] : undefined); },
  },
  {
    channel: TOOLBAR_CHANNELS.THEME_QA_RUN,
    surface: 'toolbar',
    run: async ({ host }, event, args) => { return host.runThemeQa(args[0] as { workspaceRoot?: string } | undefined); },
  },
  {
    channel: TOOLBAR_CHANNELS.WORKSPACE_IDENTIFY,
    surface: 'toolbar',
    run: ({ host }) => {
      const activeTab = host.tabs.get(host.activeTabId);
      return { workspacePath: host.resolveTargetWorkspace(undefined, activeTab?.state.url) };
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
    run: ({ host }, event, args) => { return host.switchTab(typeof args[0] === 'string' ? args[0] : ''); },
  },
  {
    channel: TOOLBAR_CHANNELS.CLOSE_TAB,
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.closeTab(typeof args[0] === 'string' ? args[0] : ''); },
  },
  {
    channel: 'antifan:tab:set-alias',
    surface: 'toolbar',
    run: ({ host }, event, args) => {
      const { tabId, alias, role, aliasColor } = (args[0] || {}) as { tabId?: string; alias?: string; role?: string; aliasColor?: string };
      return host.setTabAlias(tabId || host.activeTabId, alias, role, aliasColor);
    },
  },
  {
    channel: 'antifan:tab:get-alias',
    surface: 'toolbar',
    run: ({ host }, event, args) => { return host.resolveAliasToTabId(typeof args[0] === 'string' ? args[0] : ''); },
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
        if (t.view.webContents === senderWc) {
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
        if (t.view.webContents === senderWc || (t.mobileView && t.mobileView.webContents === senderWc)) {
          host.bumpMutationRevision(id);
          break;
        }
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
        if (tab && tab.state.ephemeral !== true && tab.state.offscreen !== true && (tab.state.title.toLowerCase().includes(lower) || tab.state.url.toLowerCase().includes(lower))) {
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
      TerminalManager.getInstance().recordSubscriberAck(payload);
    },
  },
  {
    channel: TERMINAL_CHANNELS.START,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const cwd = typeof args[0] === 'string' ? args[0] : undefined;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
    channel: TERMINAL_CHANNELS.KILL,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
    channel: TERMINAL_CHANNELS.RESIZE,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const { cols, rows } = (args[0] || {}) as { cols: number; rows: number };
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
      // An explicit cwd is honoured, but provenance is not the caller's to choose: the new
      // session belongs to the capsule this window verified, never to the manager's ambient
      // one, which another window's workspace switch may have set.
      const resolvedTarget = host.resolveTerminalCreationTarget(event?.sender);
      const target = cwd ? { ...resolvedTarget, cwd } : resolvedTarget;
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
    channel: 'antifan:terminal:rebind-affinity',
    surface: ['toolbar', 'sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { terminalId?: string } | undefined)?.terminalId],
    run: ({ host }, event, args) => {
      const { tabId, terminalId } = (args[0] || {}) as { tabId?: string; terminalId?: string };
      const targetTabId = tabId || host.activeTabId;
      const targetTerminalId = terminalId || host.windowActiveSessionId(event?.sender);
      if (!host.hasTab(targetTabId)) return false;
      const canonicalTabId = host.resolveTargetTabId(targetTabId) || targetTabId;
      const session = TerminalManager.getInstance().getSession(targetTerminalId);
      if (!session) return false;
      const ok = host.bindTerminalAgentAffinity(targetTerminalId, session.sessionGeneration, canonicalTabId);
      if (ok) {
        host.broadcastState();
      }
      return ok;
    },
  },
  {
    channel: 'antifan:terminal:adopt-tab',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { terminalId?: string } | undefined)?.terminalId],
    run: ({ host }, event, args) => {
      const { tabId, terminalId } = (args[0] || {}) as { tabId?: string; terminalId?: string };
      const targetTabId = tabId || host.activeTabId;
      const targetTerminalId = terminalId || host.windowActiveSessionId(event?.sender);
      if (!targetTerminalId || !host.hasTab(targetTabId)) return false;
      const canonicalTabId = host.resolveTargetTabId(targetTabId) || targetTabId;
      const session = TerminalManager.getInstance().getSession(targetTerminalId);
      if (!session) return false;
      const ok = host.adoptChildTab(targetTerminalId, canonicalTabId, session.sessionGeneration);
      if (ok) {
        host.broadcastState();
      }
      return ok;
    },
  },
  {
    channel: 'antifan:terminal:remove-tab',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [(args[0] as { terminalId?: string } | undefined)?.terminalId],
    run: ({ host }, event, args) => {
      const { tabId, terminalId } = (args[0] || {}) as { tabId?: string; terminalId?: string };
      const targetTabId = tabId || host.activeTabId;
      const targetTerminalId = terminalId || host.windowActiveSessionId(event?.sender);
      if (!targetTerminalId) return false;
      const canonicalTabId = host.resolveTargetTabId(targetTabId) || targetTabId;
      const session = TerminalManager.getInstance().getSession(targetTerminalId);
      if (!session) return false;
      return host.removeManagedTab(targetTerminalId, canonicalTabId, session.sessionGeneration);
    },
  },
  {
    channel: 'antifan:tabs:get-list',
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }) => {
      return host.getTabList().map((t) => ({
        id: t.id,
        title: t.title || 'Tab',
        url: t.url || 'about:blank',
      }));
    },
  },
  {
    channel: 'antifan:terminal:get-affinity',
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args) => [typeof args[0] === 'string' ? args[0] : undefined],
    run: ({ host }, event, args) => { const targetId = (typeof args[0] === 'string' ? args[0] : undefined) || host.windowActiveSessionId(event?.sender);
      if (!targetId) return undefined;
      return host.getTerminalAgentAffinity(targetId); },
  },
  {
    channel: TERMINAL_CHANNELS.SLEEP_SESSION,
    surface: ['sidebar', 'terminalPopout'],
    sessionArgs: (args, host) => [host.resolveTerminalChannelId(args[0])],
    run: ({ host }, event, args) => {
      const payload = args[0];
      const id = host.resolveTerminalChannelId(payload);
      if (!id) return false;
      const senderInfo = host.findTabByWebContents(event?.sender);
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      // Sleeping parks a session the manager shows; an agent-owned one is the agent's to park.
      const gate = host.assertManagerMayOperate(id, event?.sender?.id);
      if (gate !== true) {
        host.reportManagerWriteRefusal('antifan:terminal:sleep-session', gate);
        return false;
      }
      return TerminalManager.getInstance().sleepSession(id);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
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
      const isAgent = senderInfo && (senderInfo.tab.state.ephemeral === true || senderInfo.tab.state.offscreen === true || senderInfo.tabId === host.automationTabId);
      if (isAgent) {
        host.assertTerminalAccess(senderInfo.tabId, id);
      }
      const result = TerminalManager.getInstance().setCategory(id, category);
      host.schedulePersist();
      return result;
    },
  },
  {
    channel: TERMINAL_CHANNELS.SET_TAB_PREFS,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const prefs = (args[0] || {}) as Partial<TerminalTabPrefs>;
      const layoutChanged = host.applyTerminalTabPrefs(prefs);
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
      } satisfies TerminalTabPrefs;
    },
  },
  {
    channel: TERMINAL_CHANNELS.GET_ALL_AFFINITIES,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }) => {
      // One round-trip for every badge on the strip, over the same projection the tab
      // broadcast carries. A refresh that follows a mutation the renderer just made
      // pulls it instead of waiting for the next broadcast to echo its own change back.
      return host.buildTerminalAffinityMap();
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
      return host.togglePopoutTerminal();
    },
  },
  {
    channel: TERMINAL_CHANNELS.NEW_WINDOW,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const opts = args[0] as { sessionId?: string } | undefined;
      // Same mint, same gate as the popout: a window opened into a committed teardown
      // would register its terminal after the quit passed the point of no return.
      host.assertApplicationAdmitsHostWork('antifan:window:new');
      // The window mint is synchronous, so the asking window's own close is an assert too,
      // not a held admission: one synchronous step, no interleave to measure.
      host.assertOwnerAdmitsHostWork('antifan:window:new', host.shellOwnerKeyForSender(event?.sender?.id));
      return host.openNewTerminalWindow(opts?.sessionId);
    },
  },
  {
    channel: TERMINAL_CHANNELS.CLOSE_WINDOW,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      const senderWin = (event?.sender ? BrowserWindow.fromWebContents(event.sender) : null);
      if (senderWin && !senderWin.isDestroyed() && senderWin !== host.shell.window) {
        senderWin.close();
      } else if (host.popoutWindow && !host.popoutWindow.isDestroyed()) {
        host.popoutWindow.close();
      }
      return true;
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
    channel: TERMINAL_CHANNELS.REDOCK,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event) => {
      const senderWin = (event?.sender ? BrowserWindow.fromWebContents(event.sender) : null);
      if (senderWin && !senderWin.isDestroyed() && senderWin !== host.shell.window) {
        senderWin.close();
        if (host.wasSidebarOpenBeforePopout && !host.shell.isSidebarOpen) {
          host.toggleSidebar();
        }
        host.wasSidebarOpenBeforePopout = false;
      } else if (host.popoutWindow && !host.popoutWindow.isDestroyed()) {
        host.popoutWindow.close();
      } else {
        if (host.wasSidebarOpenBeforePopout && !host.shell.isSidebarOpen) {
          host.toggleSidebar();
        }
        host.wasSidebarOpenBeforePopout = false;
      }
      return true;
    },
  },
  {
    channel: TERMINAL_CHANNELS.GET_POPOUT_STATE,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }) => {
      return Boolean(host.popoutWindow && !host.popoutWindow.isDestroyed());
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
      const defaultDir = fs.existsSync('E:/Work')
        ? 'E:/Work'
        : (fs.existsSync('E:\\Work')
          ? 'E:\\Work'
          : (fs.existsSync('e:\\Work')
            ? 'e:\\Work'
            : (fs.existsSync('e:/Work')
              ? 'e:/Work'
              : process.cwd())));
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
    channel: TERMINAL_CHANNELS.ASSIGN_CAPSULE,
    surface: ['sidebar', 'terminalPopout'],
    run: ({ host }, event, args) => {
      const raw = args[0];
      const payload = raw && typeof raw === 'object' ? raw : {};
      const sessionId = 'sessionId' in payload && typeof payload.sessionId === 'string' ? payload.sessionId.trim() : '';
      const capsuleId = 'capsuleId' in payload && typeof payload.capsuleId === 'string' ? payload.capsuleId.trim() : '';
      const refused = (reason: TerminalCapsuleAssignReason, message: string): TerminalCapsuleAssignResult => ({ ok: false, reason, message });
      // Both ids come from a renderer, so neither is trusted: a session id nothing owns and a
      // capsule id nothing stores are answered, not attempted.
      if (!sessionId || !capsuleId) {
        return refused('INVALID_PAYLOAD', 'assign-capsule needs both a sessionId and a capsuleId');
      }
      let capsule: WorkspaceCapsule;
      try {
        capsule = host.capsuleManager.get(capsuleId);
      } catch {
        return refused('UNKNOWN_CAPSULE', `No capsule '${capsuleId}'`);
      }
      // The window a row belongs to is its project's window, and only an unambiguous affiliation
      // names one. Main's own directory refuses an ambiguous record rather than choosing a project
      // for it, so the same answer holds here: a capsule that names no single project cannot hand a
      // terminal to a window, and picking one would file a running shell under a window the user
      // never chose.
      const ownerKeyValue = host.capsuleOwnerKey(capsule);
      if (!ownerKeyValue) {
        return refused('CAPSULE_WITHOUT_PROJECT', `Capsule '${capsuleId}' has no one open project to own the session`);
      }
      // A row's owner key IS the window that renders it, so the move is only legal onto a window
      // that exists: a project-owned row no window claims would be visible to no window at all.
      // Opening that window is the renderer's step (the same `openProject` call a user's own open
      // goes through); this route never creates a window.
      if (!host.ownerWindowPresenceFor(ownerKeyValue)) {
        return refused('TARGET_WINDOW_ABSENT', `No open window owns '${ownerKeyValue}'`);
      }
      // The manager reads every row; it drives none of the agent-owned ones. A window that cannot
      // even see the session has no authority over it either, which is what keeps one project's
      // terminal from being re-homed by another project's window.
      const gate = host.assertManagerMayOperate(sessionId, event?.sender?.id);
      if (gate !== true) return refused(gate.reason, gate.message);
      if (!host.isSessionVisibleToWindow(sessionId, undefined, event?.sender?.id)) {
        return refused('SESSION_NOT_VISIBLE', `Session '${sessionId}' does not belong to this window`);
      }
      // The move re-stamps a live row, so it is admitted like every other mutation: a close attempt
      // that already began measures this work instead of a row changing hands underneath it.
      const settled: unknown = host.admitThenRun(
        TERMINAL_CHANNELS.ASSIGN_CAPSULE,
        { ownerKey: host.shellOwnerKeyForSender(event?.sender?.id) },
        () => {
          const transferred: unknown = TerminalManager.getInstance().transferSessionOwner(sessionId, ownerKeyValue, capsuleId);
          // The singleton is a daemon proxy installed by cast: it answers the same boolean the
          // in-process manager does, but as the settlement of its round-trip, so a refusal is read
          // off whichever answer arrives.
          const thenable = transferred as { then?: unknown } | null | undefined;
          if (thenable && typeof thenable.then === 'function') {
            return Promise.resolve(transferred).then((moved: unknown) =>
              moved === true
                ? ({ ok: true, sessionId, capsuleId, ownerKey: ownerKeyValue } satisfies TerminalCapsuleAssignResult)
                : refused('UNKNOWN_SESSION', `No live session '${sessionId}'`)
            );
          }
          return transferred === true
            ? ({ ok: true, sessionId, capsuleId, ownerKey: ownerKeyValue } satisfies TerminalCapsuleAssignResult)
            : refused('UNKNOWN_SESSION', `No live session '${sessionId}'`);
        }
      );
      return settled;
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
    run: ({ host }) => {
      const activeTab = host.tabs.get(host.activeTabId);
      const targetWorkspace = host.resolveTargetWorkspace(undefined, activeTab?.state.url);
      return {
        isOpen: host.shell.isSidebarOpen,
        width: host.shell.sidebarWidth,
        workspacePath: targetWorkspace,
        activeWorkspace: targetWorkspace,
        // Boot-time prefs so the renderer can paint the persisted tab layout
        // without a second IPC round-trip.
        terminalTabPrefs: {
          layout: host.terminalTabLayout,
          sidebarWidth: host.terminalSidebarWidth,
          collapsedCategories: host.terminalCollapsedCategories,
          categories: host.terminalCategories,
          categoryColors: host.terminalCategoryColors,
          starredCategories: host.terminalStarredCategories,
        } satisfies TerminalTabPrefs,
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

  public toggleSidebar(): boolean {
    this.shell.isSidebarOpen = !this.shell.isSidebarOpen;
    this.updateLayout();
    this.broadcastState();
    if (this.shell.isSidebarOpen && this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
      safeSendWebContents(
        this.shell.sidebarView.webContents,
        'antifan:terminal:session',
        this.terminalStateForWindow(TerminalManager.getInstance().getSessionState(), undefined, this.shell.sidebarView.webContents.id),
      );
    }
    return this.shell.isSidebarOpen;
  }

  private openInVSCode(targetPath?: string): { ok: boolean; error?: string; workspacePath?: string } {
    let workspacePath = targetPath;
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      const activeSessionId = TerminalManager.getInstance().getActiveSessionId();
      const activeTab = this.tabs.get(this.activeTabId);
      workspacePath = this.resolveTargetWorkspace(activeSessionId, activeTab?.state.url);
    }
    if (!workspacePath || !fs.existsSync(workspacePath)) {
      return { ok: false, error: 'WORKSPACE_NOT_FOUND' };
    }

    try {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'code.cmd' : 'code';
      const child = spawn(cmd, [workspacePath], {
        detached: true,
        stdio: 'ignore',
        shell: process.platform === 'win32',
      });
      child.unref();
      return { ok: true, workspacePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private setupGlobalShortcutsOnView(wc: Electron.WebContents | null | undefined, tabId?: string): void {
    if (!wc) return;
    wc.on('before-input-event', (_event, input) => {
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
          return t && t.state.ephemeral !== true && t.state.offscreen !== true;
        });
        if (userTabs.length > 1) {
          const currIdx = userTabs.indexOf(this.activeTabId);
          const nextIdx = input.shift ? (currIdx - 1 + userTabs.length) % userTabs.length : (currIdx + 1) % userTabs.length;
          this.switchTab(userTabs[nextIdx]!);
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
    this.lowerRaisedCaptureView();
    if (this.isDisposed) return;
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) return;
    // Guarded by their own fields: several tests build a host without running field
    // initializers, and a re-assert on such a host must be a no-op, not a TypeError.
    const activeTab = this.activeTabId && this.tabs ? this.tabs.get(this.activeTabId) : null;
    if (!activeTab || !activeTab.view || !activeTab.view.webContents || activeTab.state.offscreen === true) return;
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
    if (typeof wc.setBackgroundThrottling === 'function') {
      try { wc.setBackgroundThrottling(false); } catch {}
    }
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
    for (const tab of this.tabs.values()) {
      for (const view of [tab.view, tab.mobileView]) {
        if (!view || view === activeTab?.view || view === activeTab?.mobileView) continue;
        if (this.isTemporarilyAttachedView(view)) continue;
        if (!this.isTabViewAttached(view)) continue;
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
    const wasThrottled = wc && 'backgroundThrottling' in wc && typeof wc.backgroundThrottling === 'boolean' ? wc.backgroundThrottling : true;
    if (wc && typeof wc.setBackgroundThrottling === 'function') {
      try { wc.setBackgroundThrottling(false); } catch {}
    }
    if (wc && typeof wc.invalidate === 'function') {
      try { wc.invalidate(); } catch {}
    }
    try {
      return await action();
    } finally {
      if (wc && !wc.isDestroyed() && typeof wc.setBackgroundThrottling === 'function') {
        try { wc.setBackgroundThrottling(wasThrottled); } catch {}
      }
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
   * `{ fromSurface: true }` then waits out the 8s no-surface probe (measured:
   * inactive bagamuioto + mdn video). Host the pane on an off-screen window for
   * the raster so it is not painted over the user's tab. Does not change `activeTabId`.
   *
   * The off-screen host is itself not a surface the Windows compositor drives
   * (measured live: a raised pane starves while the main window is maximized
   * and visible), so `inWindow: true` skips the host and presents the pane in
   * the real window — the frame gate's repair ladder reaches for that after a
   * host raise left the pane starved.
   */
  public raiseViewForCapture(view: WebContentsView, opts?: { inWindow?: boolean }): void {
    if (!view || !this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed()) || !this.shell.window.contentView) return;
    if (this.raisedCaptureView !== view && !this.isTabViewAttached(view)) return;
    if (!opts?.inWindow && this.raiseViewOnCaptureHost(view)) return;
    // Host unavailable (tests, or BrowserWindow refused), not preferred, or
    // starved: fall back to the in-window lift. That paints the pane over the
    // user's tab for the raster; reassert lowers it. A pane currently parked
    // on the capture host comes back to the window first — a view parented to
    // the host cannot be lifted inside this window.
    if (this.raisedCaptureView === view) this.lowerRaisedCaptureView();
    this.raiseViewInWindow(view);
  }

  /**
   * Move the capture pane to a shown-but-off-screen window so Windows still
   * composites a frame (an occluded in-window view does not) without covering
   * the tab the user is looking at. Returns false when that window cannot be
   * created; the caller then lifts in-window.
   */
  private raiseViewOnCaptureHost(view: WebContentsView): boolean {
    const host = this.ensureCaptureHostWindow();
    if (!host) return false;
    // The host has one tracked occupant. Release it before transferring a
    // different pane, otherwise its parent becomes invisible to cleanup.
    if (this.raisedCaptureView && this.raisedCaptureView !== view) this.lowerRaisedCaptureView();
    const current = typeof view.getBounds === 'function' ? view.getBounds() : undefined;
    const width = Math.max(1, Math.round(current?.width || 1280));
    const height = Math.max(1, Math.round(current?.height || 800));
    const origin = this.offscreenCaptureOrigin(width, height);
    try {
      host.setBounds({ x: origin.x, y: origin.y, width, height });
      if (!host.isVisible()) host.showInactive();
      if (this.shell.window.contentView.children.includes(view)) this.shell.window.contentView.removeChildView(view);
      host.contentView.addChildView(view);
      this.raisedCaptureView = view;
      if (typeof view.setBounds === 'function') view.setBounds({ x: 0, y: 0, width, height });
      const wc = view.webContents;
      if (wc && typeof wc.isDestroyed === 'function' && !wc.isDestroyed() && typeof wc.invalidate === 'function') {
        try { wc.invalidate(); } catch {}
      }
      return true;
    } catch (err) {
      console.warn('[native-tab-host] capture-host raise failed:', err);
      if (this.raisedCaptureView === view) this.lowerRaisedCaptureView();
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

  /** Return a host-raised pane to the main window, below the presented tab. */
  private lowerRaisedCaptureView(): void {
    const view = this.raisedCaptureView;
    if (!view) return;
    this.raisedCaptureView = null;
    const host = this.captureHostWindow;
    try {
      if (host && (typeof host.isDestroyed !== 'function' || !host.isDestroyed()) && Array.isArray(host.contentView?.children) && host.contentView.children.includes(view)) {
        host.contentView.removeChildView(view);
      }
    } catch {}
    if (!this.isTemporarilyAttachedView(view)) return;
    if (!this.shell.window || (typeof this.shell.window.isDestroyed === 'function' && this.shell.window.isDestroyed())) return;
    this.attachTabView(view, false);
  }

  private raiseViewInWindow(view: WebContentsView): void {
    if (!this.shell.window || !this.shell.window.contentView) return;
    const contentView = this.shell.window.contentView;
    try {
      if (typeof contentView.removeChildView === 'function') contentView.removeChildView(view);
      if (typeof contentView.addChildView === 'function') contentView.addChildView(view);
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
    } catch (err) {
      console.warn('[native-tab-host] raiseViewForCapture error:', err);
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
    const currentUrl = activeTab.view.webContents.getURL();
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
      const ses = activeTab.view.webContents.session;
      await ses.clearStorageData({ origin, storages: ['cookies', 'localstorage', 'cachestorage'] });
      if (!activeTab.view.webContents.isDestroyed()) {
        activeTab.view.webContents.reload();
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
        if (tab.state.offscreen === true || tab.state.ephemeral === true) return undefined;
        const isAttached = Boolean(tab.view && this.isTabViewAttached(tab.view));
        return {
          ...tab.state,
          customViewport: tab.customViewport,
          attached: isAttached,
          isAgentControlled: id === this.automationTabId,
        } as AntiFanTab & { customViewport?: { width: number; height: number; mobile?: boolean }; attached?: boolean };
      })
      .filter(Boolean) as AntiFanTab[];
  }

  /**
   * Session-scoped tab listing. `getTabList` projects the user's tab strip, which
   * deliberately excludes the offscreen/ephemeral tabs the agent plane creates —
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
        customViewport: tab.customViewport,
        attached: isAttached,
        isAgentControlled: tab.state.ephemeral === true || tab.state.offscreen === true || id === this.automationTabId,
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
    return true;
  }

  public getWindowWorkspaceAffiliation(): WindowWorkspaceAffiliation | null {
    return this.windowWorkspaceAffiliation ? { ...this.windowWorkspaceAffiliation } : null;
  }

  /**
   * The workspace root this window's terminals belong to, or '' when the window has
   * no verified association. Never another window's workspace.
   */
  public resolveWindowWorkspaceRoot(): string {
    const affiliation = this.windowWorkspaceAffiliation;
    if (affiliation && isExistingDirectory(affiliation.workspacePath)) return affiliation.workspacePath;
    return '';
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
   * `managerAll` is the third answer, and it is not a wider version of the two above: the shared
   * manager window sees every row there is (see `isSharedTerminalManagerSender`). Everything that
   * reads a terminal row on behalf of a window asks here, so the manager answers the same way for
   * the projection it renders, the list it bootstraps from and the diagnostics it can read.
   */
  private windowSessionScope(senderId?: number): { ownerKey: string; tags: Set<string>; acceptsUnclaimed: boolean; managerAll: boolean } {
    const tags = new Set<string>();
    const capsuleId = this.windowWorkspaceAffiliation?.capsuleId;
    if (capsuleId) tags.add(capsuleId);
    const root = this.resolveWindowWorkspaceRoot();
    if (root) tags.add(workspaceTerminalProvenance(this.windowOwnerKey(), root));
    return {
      ownerKey: this.windowOwnerKey(),
      tags,
      acceptsUnclaimed: tags.size === 0,
      managerAll: this.isSharedTerminalManagerSender(senderId),
    };
  }

  /**
   * Whether a caller is the shared terminal manager — the one window that shows every project's
   * terminals at once.
   *
   * The manager is the Unassigned shell: the window that belongs to no project, and whose whole
   * purpose is one list spanning capsules. Its scope is therefore the process-wide one, `agent:`
   * rows included, because an agent's terminal is exactly the kind of row a person watching all
   * projects wants to see. What that scope may *do* with those rows is decided separately (see
   * `assertManagerMayOperate`).
   *
   * Only that window's own chrome may ask. A page inside it is not the manager — a page is never a
   * chrome surface, so the WebContents check below refuses it — and neither is the bridge or MCP:
   * those answer through the terminal capability surface and never reach this host. A caller that
   * names no WebContents at all is the host projecting to its own renderers (its sidebar, its
   * terminal windows, its diagnostics), and the host's own window is the only scope it can be
   * speaking for.
   */
  private isSharedTerminalManagerSender(senderId?: number): boolean {
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
    if (!owner || !owner.startsWith(AGENT_OWNER_KEY_PREFIX)) return true;
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
      sessions,
      ...(splitSessionId ? { splitSessionId } : {}),
      snapshot: transcriptKept && typeof projection.snapshot === 'string' ? projection.snapshot : '',
      snapshotThroughSeq: transcriptKept && typeof projection.snapshotThroughSeq === 'number' ? projection.snapshotThroughSeq : 0,
    };
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
   * this window's key, which is what keeps two windows that share one folder apart. The
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
          ownerKey: (typeof tm.sessionOwnerKey === 'function' ? tm.sessionOwnerKey(popoutSessionId) : undefined) ?? this.windowOwnerKey(),
          source: 'popout-session',
        };
      }
    }
    const windowRoot = this.resolveWindowWorkspaceRoot();
    if (windowRoot) {
      return {
        cwd: windowRoot,
        capsuleId: this.windowTerminalProvenance() ?? DEFAULT_TERMINAL_CAPSULE_ID,
        ownerKey: this.windowOwnerKey(),
        source: 'window-workspace',
      };
    }
    const defaultCwd = tm.getDefaultCwd?.() || process.cwd();
    return {
      cwd: defaultCwd,
      capsuleId: DEFAULT_TERMINAL_CAPSULE_ID,
      ownerKey: this.windowOwnerKey(),
      source: 'process-default',
    };
  }

  /**
   * Exact tab identity: never alias- or index-resolved, so a stale id can never
   * name a different tab. `hasTab` deliberately resolves aliases and numeric
   * references and must not be used where exactness is the contract.
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
    return {
      owner,
      title: this.shell?.title ?? '',
      ...(this.shell?.pathLabel ? { pathLabel: this.shell.pathLabel } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    };
  }

  /**
   * The user-visible inventory the `'antifan:tabs:search'` contract lists: this
   * window's tabs in strip order, excluding the offscreen/ephemeral automation
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
      if (tab.state.ephemeral === true || tab.state.offscreen === true) return;
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
    if (!tab || tab.state.ephemeral === true || tab.state.offscreen === true) {
      return { ok: false, tabId, reason: 'TAB_UNAVAILABLE' };
    }
    if (this.windowOwnerKey() !== expectedOwnerKey) {
      return { ok: false, tabId, reason: 'OWNER_CHANGED' };
    }
    this.switchTab(tabId);
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

    if (paneId === 'mobile') {
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        return tab.mobileView.webContents;
      }
      return null;
    }

    if (paneId === 'desktop') {
      return tab.view.webContents.isDestroyed() ? null : tab.view.webContents;
    }

    if (tab.state.splitMode && tab.focusedPane === 'mobile' && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      return tab.mobileView.webContents;
    }
    return tab.view.webContents.isDestroyed() ? null : tab.view.webContents;
  }
  public getAutomationTabId(): string | null {
    return this.automationTabId;
  }
  /**
   * Dual-Plane Runtime Isolation: reports whether a tab renders offscreen (i.e. a
   * dedicated agent tab that is never attached to the user's visible view hierarchy).
   * Capture paths use this to skip any physical `switchTab` foreground/restore dance,
   * capturing directly from the offscreen compositor surface instead — so a screenshot
   * or visual compare never hijacks or flickers the user's active working tab.
   */
  public isTabOffscreen(tabId?: string): boolean {
    if (!tabId) return false;
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    return tab.state.offscreen === true;
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
   * Every partition currently referenced by a tab, offscreen and ephemeral tabs
   * included, plus `'default'` when a tab runs without an explicit partition.
   * `getTabList()` deliberately projects only the user's tab strip, so a
   * lifecycle consumer (housekeeping, cleanup) that asks this question must read
   * the tab map instead — an offscreen tab still owns its jar.
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
      state.isAudible = Boolean(tab && (
        (!tab.view.webContents.isDestroyed() && tab.view.webContents.isCurrentlyAudible()) ||
        (tab.mobileView && !tab.mobileView.webContents.isDestroyed() && tab.mobileView.webContents.isCurrentlyAudible())
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
        if (tab && tab.view && !tab.state.offscreen && !tab.state.ephemeral) {
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
          this.tabThemeQaStates?.set(id, { status: 'idle', issueCount: 0, updatedAt: Date.now() });
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
        if (tab && tab.view && !tab.state.offscreen && !tab.state.ephemeral) {
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
        wc.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
      }
      if (this.isFontFinderActive && id === this.activeTabId) {
        wc.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
      }
      if (this.isInspecting && id === this.activeTabId) {
        const tm = TerminalManager.getInstance();
        const tabSessionId = this.getTabTerminalSession(id);
        const termContextData: Record<string, unknown> = {
          tabId: id,
          sessions: selectAnnotationTargets(this.visibleTerminalSessions()),
          selectedSessionId: tm.getActiveSessionId(),
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
        if (!state.alias) {
          const inferred = inferTabSemanticRole(state.url, state.title);
          if (inferred.alias) {
            let canAssignAlias = true;
            if (inferred.alias === '@storefront') {
              for (const [otherId, otherTab] of this.tabs.entries()) {
                if (otherId !== id && otherTab.state.alias?.toLowerCase() === '@storefront') {
                  canAssignAlias = false;
                  break;
                }
              }
            }
            if (canAssignAlias) {
              state.alias = inferred.alias;
              state.aliasColor = inferred.aliasColor;
            }
            state.role = inferred.role;
          }
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
        if (!state.alias) {
          const inferred = inferTabSemanticRole(state.url, state.title);
          if (inferred.alias) {
            let canAssignAlias = true;
            if (inferred.alias === '@storefront') {
              for (const [otherId, otherTab] of this.tabs.entries()) {
                if (otherId !== id && otherTab.state.alias?.toLowerCase() === '@storefront') {
                  canAssignAlias = false;
                  break;
                }
              }
            }
            if (canAssignAlias) {
              state.alias = inferred.alias;
              state.aliasColor = inferred.aliasColor;
            }
            state.role = inferred.role;
          }
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
      if (paneId === 'desktop' && !this.isDisposed && this.tabs.has(id)) {
        this.closeTab(id);
      }
    });

    wc.on('destroyed', () => {
      clearLoadingTimer();
      if (paneId === 'desktop' && !this.isDisposed && this.tabs.has(id)) {
        this.closeTab(id);
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
                });
                // Adoption failure cleans up only the child this call created and never
                // retargets its parent, so an unowned child is closed instead of orphaned.
                if (newTabId && !this.adoptChildTab(parentTabId, newTabId, undefined, 'native_window_open', parentTabId)) {
                  this.closeTab(newTabId);
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
      offscreen?: boolean;
      /** Explicit terminal session that should own this tab. Omit for user-opened tabs. */
      terminalSessionId?: string;
      devicePresetId?: string;
      mobile?: boolean;
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
    const isOffscreen = Boolean(options?.offscreen);
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
      webPreferences: getSecureWebPreferences(partition, {
        offscreen: isOffscreen,
        backgroundThrottling: isOffscreen ? false : undefined,
      }),
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
      offscreen: isOffscreen,
    };
    this.setupTabWebContentsEvents(id, view, state, 'desktop');

    const effectivePreset = initialPreset || (options?.mobile ? findDevicePreset('iphone-15') : undefined);

    const tabEntry: { view: WebContentsView; state: AntiFanTab; focusedPane: 'desktop' | 'mobile'; customViewport?: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number } } = { view, state, focusedPane: 'desktop' };
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
    const isAgentTab = isEphemeral || isOffscreen;
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
    } else if (url !== 'about:blank' || isOffscreen) {
      // An offscreen agent tab must materialize about:blank too: constructing a
      // WebContentsView without a load leaves no renderer document to answer CDP
      // (measured by scripts/probe-background-full-page.cjs), so the first MCP
      // call wedges the session before capture is attempted.
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
      this.switchTab(id);
    } else {
      if (!isOffscreen && !isAgentTab) {
        wc.once('did-stop-loading', () => {
          if (!wc.isDestroyed() && this.tabs.has(id) && this.activeTabId !== id) {
            try {
              wc.setBackgroundThrottling(true);
            } catch {}
          }
        });
      }
      this.updateLayout();
      this.broadcastState();
    }
    this.schedulePersist();
    recordBenchmark({ surface: 'tabs', name: 'created', extra: { activate, url: url.slice(0, 80) } });
    return id;
  }

  public switchTab(tabId: string): boolean {
    if (this.isDisposed) return false;
    try {
      const targetId = this.resolveTargetTabId(tabId) || tabId;
      const target = this.tabs.get(targetId);
      if (!target) return false;
      if (target.state.offscreen === true || target.state.ephemeral === true) {
        // Refusing to present an agent-plane tab must not also leave the window with no
        // view at all when an earlier transaction took the presented one away.
        this.reassertPresentedView();
        return false;
      }
      const switchStartMs = performance.now();
      // Per-step timings for this switch (see markSwitchStep). The aggregate `switched`
      // benchmark says a switch got slower but never which step paid for it, and the
      // bucket exists only while benchmarks are on.
      const stepBucket = isBenchmarkEnabled() ? ({} as Record<string, number>) : null;
      let stepMark = switchStartMs;

      // Guard against destroyed WebContents/WebContentsView or crashed renderer
      const isTargetDestroyed = !target.view || target.view.webContents.isDestroyed();
      const isTargetCrashed = !isTargetDestroyed && (target.state.crashed === true || (typeof target.view.webContents.isCrashed === 'function' && target.view.webContents.isCrashed()));
      if (isTargetDestroyed || isTargetCrashed) {
        console.warn(`[native-tab-host] Target tab ${targetId} webContents is ${isTargetCrashed ? 'crashed' : 'destroyed'}; recreating view`);
        // Release the previous view before replacing it. A crashed renderer leaves its
        // WebContentsView attached to the window, holding a renderer, forever: the
        // detach sweep below walks `this.tabs` and never destroys, so nothing else
        // would ever free this one. The window can be narrower than the renderer's
        // appetite, so leaking one view per crash compounds.
        try {
          if (this.shell.window && !this.shell.window.isDestroyed() && target.view && this.shell.window.contentView.children.includes(target.view)) {
            this.shell.window.contentView.removeChildView(target.view);
          }
        } catch {}
        try { this.destroyOwnedWebContents(target.view?.webContents); } catch {}
        if (target.view?.webContents) this.tabByWebContents?.delete(target.view.webContents);
        target.view = new WebContentsView({
          webPreferences: getSecureWebPreferences(target.state.partition),
        });
        try { target.view.setBackgroundColor('#ffffff'); } catch {}
        target.state.crashed = false;
        this.setSafeUserAgent(target.view.webContents, this.defaultUserAgent);
        const isBlank = !target.state.url || target.state.url === 'about:blank';
        target.state.isLoading = !isBlank;
        this.setupTabWebContentsEvents(targetId, target.view, target.state, 'desktop');
        this.tabByWebContents?.set(target.view.webContents, { tabId: targetId, tab: target });
        if (!isBlank && isAllowedNavigation(target.state.url)) {
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
      if (previousTab && previousTabId !== targetId && this.isFontFinderActive) {
        const cleanScript = `(() => {
          if (typeof window.__antifanFontFinderCleanup === 'function') window.__antifanFontFinderCleanup();
          const tip = document.getElementById('antifan-font-tooltip');
          if (tip) tip.remove();
          const outline = document.getElementById('antifan-font-hover-outline');
          if (outline) outline.remove();
          window.__antifanFontFinderActive = false;
        })()`;
        if (previousTab.view && !previousTab.view.webContents.isDestroyed()) {
          previousTab.view.webContents.executeJavaScript(cleanScript).catch(() => {});
        }
        if (previousTab.mobileView && !previousTab.mobileView.webContents.isDestroyed()) {
          previousTab.mobileView.webContents.executeJavaScript(cleanScript).catch(() => {});
        }
      }

      stepMark = markSwitchStep(stepBucket, 'ensureView', stepMark);

      this.activeTabId = targetId;

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
            if (tab.view && !this.isTemporarilyAttachedView(tab.view) && this.shell.window.contentView.children.includes(tab.view)) {
              try { this.shell.window.contentView.removeChildView(tab.view); } catch {}
            }
            if (tab.mobileView && !this.isTemporarilyAttachedView(tab.mobileView) && this.shell.window.contentView.children.includes(tab.mobileView)) {
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

      if (this.isRulerActive && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(RULER_SCRIPT).catch(() => {});
        }
      }
      if (this.isLensActive && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(GPU_LENS_SCRIPT).catch(() => {});
        }
      }
      if (this.isFontFinderActive && !target.view.webContents.isDestroyed()) {
        target.view.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
        if (target.mobileView && !target.mobileView.webContents.isDestroyed()) {
          target.mobileView.webContents.executeJavaScript(FONT_FINDER_SCRIPT).catch(() => {});
        }
      }
      this.applyTabThrottling();
      stepMark = markSwitchStep(stepBucket, 'throttle', stepMark);
      if (target.view?.webContents && !target.view.webContents.isDestroyed()) {
        try { target.view.webContents.invalidate(); } catch {}
        try { target.view.webContents.focus(); } catch {}
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
      return true;
    } catch (err) {
      console.error('[native-tab-host] switchTab unexpected error:', err);
      try {
        if (this.activeTabId && this.tabs.has(this.activeTabId)) {
          const fallbackTab = this.tabs.get(this.activeTabId);
          if (fallbackTab?.view && !fallbackTab.state.offscreen && !fallbackTab.state.ephemeral) {
            this.attachTabView(fallbackTab.view, false);
          }
        }
        this.updateLayout();
        this.broadcastState();
      } catch {}
      // A switch that failed still owes the window a presented view: whatever is active
      // now beats an empty pane.
      try { this.reassertPresentedView(); } catch {}
      return false;
    }
  }
  public applyTabThrottling(): void {
    if (this.isDisposed) return;
    for (const [id, tab] of this.tabs.entries()) {
      // Both panes are probed through the tolerant accessor: a view whose native object is gone
      // cannot be throttled, and asking it anyway would throw out of the clear/teardown step
      // that called this pass.
      const desktop = this.liveViewContents(tab.view);
      const mobile = this.liveViewContents(tab.mobileView);
      // Offscreen agent tabs must keep painting continuously so capturePage always
      // has a fresh compositor frame; skip throttling for offscreen tabs and keep backgroundThrottling: false.
      if (tab.state.offscreen === true) {
        if (desktop) {
          try {
            desktop.setBackgroundThrottling(false);
          } catch {}
        }
        if (mobile) {
          try {
            mobile.setBackgroundThrottling(false);
          } catch {}
        }
        continue;
      }
      const isForeground = id === this.activeTabId;
      const isAgentWorking = tab.state.aiState === 'agent_working' || (this.automationHost?.agentWorkingRefs.get(id) || 0) > 0;
      // Dynamic In-Flight Throttling Exemption (RT-02):
      // Unthrottle if the tab is foreground OR currently executing active agent operations.
      // Once agent finishes (returns to idle), tab immediately throttles to conserve CPU/RAM.
      const shouldThrottle = !isForeground && !isAgentWorking;
      if (desktop) {
        try {
          desktop.setBackgroundThrottling(shouldThrottle);
        } catch {}
      }
      if (mobile) {
        try {
          mobile.setBackgroundThrottling(shouldThrottle);
        } catch {}
      }
    }
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
  public clearAllAgentWorking(): void {
    this.getAutomationHost().clearAllAgentWorking();
  }

  public closeTab(tabId: string): boolean {
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
    const isAgent = target.state.ephemeral === true || target.state.offscreen === true;
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
    if (this.activeTabId === tabId) {
      try {
        this.shell.window.contentView.removeChildView(target.view);
      } catch {}
      if (target.mobileView) {
        try {
          this.shell.window.contentView.removeChildView(target.mobileView);
        } catch {}
      }
    }
    try {
      this.destroyOwnedWebContents(target.view.webContents);
    } catch {}
    if (target.mobileView) {
      try {
        this.destroyOwnedWebContents(target.mobileView.webContents);
      } catch {}
    }
    this.splitCoordinator?.cleanupTab(tabId);
    this.unindexTabWebContents(target);
    this.tabs.delete(tabId);
    this.tabOrder = this.tabOrder.filter((id) => id !== tabId);

    if (this.activeTabId === tabId) {
      const userTabs = this.tabOrder.filter((id) => {
        const t = this.tabs.get(id);
        return t && t.state.ephemeral !== true && t.state.offscreen !== true;
      });
      if (userTabs.length > 0) {
        this.switchTab(userTabs[userTabs.length - 1]!);
      } else if (reservedForClose || authorizedByAttempt) {
        // Repairing "the window is never empty" must not run inside an authorized close:
        // the replacement page would be a new arrival the attempt has to treat as one, so
        // a project shell could never reach zero member pages and never close. The shell
        // stays empty and the attempt decides; a tab a user or agent opens during the
        // close is a real arrival and keeps the shell open, which is reported honestly
        // rather than as a failure.
        this.activeTabId = '';
        this.broadcastState();
      } else {
        this.createTab('https://www.google.com');
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
  public closePage(tabId: string): Promise<TabPageCloseOutcome> {
    if (this.isDisposed) return Promise.resolve('unknown');
    const targetId = (this.resolveTargetTabId(tabId) || tabId || '').trim();
    if (targetId.length === 0) return Promise.resolve('unknown');
    const inFlight = this.pendingPageCloses?.get(targetId);
    if (inFlight) return inFlight;
    const record = this.tabs?.get(targetId);
    const wc: Electron.WebContents | null | undefined = record?.view?.webContents;
    if (!record || !wc) return Promise.resolve('unknown');

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
    const onWillPreventUnload = (): void => finish('vetoed');

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
      wc.close({ waitForBeforeUnload: true });
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
    this.closeTab(tabId);
  }

  /**
   * The visible member-page snapshot a close attempt takes BEFORE it destroys anything:
   * this shell's presented tabs in strip order, excluding the offscreen/ephemeral
   * agent-plane views that `auxiliaryViewTabIds()` reports separately.
   */
  public visibleMemberTabIds(): string[] {
    if (this.isDisposed || !this.tabs) return [];
    const isMember = (tab: NativeTabRecord | undefined): boolean =>
      Boolean(tab && tab.state.ephemeral !== true && tab.state.offscreen !== true);
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
   * The auxiliary views this host owns: offscreen and ephemeral agent-plane tabs. They
   * are deliberately outside `visibleMemberTabIds()` — no project snapshot may claim
   * them — but they hold live renderers and can carry in-flight work, so an
   * application-scope busy check must still see them.
   */
  public auxiliaryViewTabIds(): string[] {
    if (this.isDisposed || !this.tabs) return [];
    const ids: string[] = [];
    for (const [id, tab] of this.tabs) {
      if (tab.state.ephemeral === true || tab.state.offscreen === true) ids.push(id);
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
    return this.switchTab(target);
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
    // shell question when the target is an offscreen or ephemeral tab: those are not member
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
      if (tab && (tab.state.ephemeral === true || tab.state.offscreen === true)) continue;
      this.closeTab(id);
    }
  }

  public closeTabsToRight(tabId: string): void {
    const idx = this.tabOrder.indexOf(tabId);
    if (idx === -1) return;
    const toClose = this.tabOrder.slice(idx + 1);
    for (const id of toClose) {
      const tab = this.tabs.get(id);
      if (tab && (tab.state.ephemeral === true || tab.state.offscreen === true)) continue;
      this.closeTab(id);
    }
  }

  public navigate(tabId: string, inputUrl: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    const cleanUrl = sanitizeUrl(inputUrl);
    if (!isAllowedNavigation(cleanUrl)) {
      return false;
    }
    tab.state.url = cleanUrl;
    this.networkTracker.resetInflight(tabId, 'desktop');
    if (tab.state.splitMode) {
      this.networkTracker.resetInflight(tabId, 'mobile');
    }
    if (cleanUrl.startsWith('view-source:')) {
      const sourceTargetUrl = cleanUrl.slice('view-source:'.length).trim();
      tab.state.title = `view-source:${sourceTargetUrl}`;
      this.fetchAndLoadPageSource(tab.view.webContents, sourceTargetUrl, tab.state);
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        this.fetchAndLoadPageSource(tab.mobileView.webContents, sourceTargetUrl, tab.state);
      }
    } else {
      if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
        this.splitCoordinator.startTransaction(tabId, authorityPane, cleanUrl);
        const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;
        authorityView.webContents.loadURL(cleanUrl).catch(() => {});
      } else {
        tab.view.webContents.loadURL(cleanUrl).catch(() => {});
      }
    }
    return true;
  }
  public async navigateAndWait(tabId: string, inputUrl: string, timeoutMs: number = 8000): Promise<boolean> {
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
    const authorityPane = tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()
      ? (tab.focusedPane || tab.state.splitFocusedPane || 'desktop')
      : 'desktop';
    const authorityView = authorityPane === 'mobile' && tab.mobileView ? tab.mobileView : tab.view;
    if (!authorityView || authorityView.webContents.isDestroyed()) return false;

    this.lastNavigationFailures.delete(tabId);
    const waiter = this.createNavigationLifecycleWaiter(authorityView.webContents, timeoutMs, Math.min(3000, timeoutMs), tabId);
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
    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
      if (tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
        tab.mobileView.webContents.reload();
      }
    } else {
      if (!tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
    }
    return true;
  }
  public async reloadAndWait(tabId: string, timeoutMs: number = 8000, options?: { ownedReloadToken?: string }): Promise<boolean> {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;
    if (options?.ownedReloadToken) {
      this.registerOwnedReload(tabId, options.ownedReloadToken);
    }
    const isBackground = tabId !== this.activeTabId;
    const effectiveTimeoutMs = timeoutMs !== 8000 ? timeoutMs : (isBackground ? 10000 : 8000);
    const isSplit = Boolean(tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed());

    // Reset inflight records for reload and ensure active debugger attachment
    this.networkTracker.resetInflight(tabId, 'desktop');
    await this.networkTracker.ensureAttached(
      tabId,
      'desktop',
      tab.view.webContents,
      () => this.tabs.get(tabId)?.state.url || ''
    );
    const desktopWaiter = this.createLoadCompletionWaiter(tab.view.webContents, effectiveTimeoutMs);

    let mobileWaiter: { promise: Promise<boolean>; cancel: () => void } | null = null;
    if (isSplit && tab.mobileView) {
      this.networkTracker.resetInflight(tabId, 'mobile');
      await this.networkTracker.ensureAttached(
        tabId,
        'mobile',
        tab.mobileView.webContents,
        () => this.tabs.get(tabId)?.state.url || ''
      );
      mobileWaiter = this.createLoadCompletionWaiter(tab.mobileView.webContents, effectiveTimeoutMs);
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

    await Promise.all([
      this.networkTracker.awaitQuiescence(tabId, 'desktop', { idleWindowMs: 500, maxCeilingMs: Math.min(2000, effectiveTimeoutMs) }),
      isSplit ? this.networkTracker.awaitQuiescence(tabId, 'mobile', { idleWindowMs: 500, maxCeilingMs: Math.min(2000, effectiveTimeoutMs) }) : Promise.resolve(),
    ]);

    return true;
  }
  public getNetworkTracker(): FirstPartyNetworkTracker {
    return this.networkTracker;
  }

  private createLoadCompletionWaiter(wc: Electron.WebContents, timeoutMs: number = 8000): { promise: Promise<boolean>; cancel: () => void } {
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
    timeoutMs: number = 8000,
    startTimeoutMs: number = 3000,
    tabId?: string
  ): { promise: Promise<boolean>; cancel: () => void } {
    let cancelFn: () => void = () => {};
    const promise = new Promise<boolean>((resolve) => {
      if (!wc || wc.isDestroyed()) {
        resolve(false);
        return;
      }
      let settled = false;
      let navStarted = false;
      let startTimer: NodeJS.Timeout | null = null;
      let totalTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (startTimer) {
          clearTimeout(startTimer);
          startTimer = null;
        }
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
        try { wc.removeListener('did-start-navigation', onStart); } catch {}
        try { wc.removeListener('did-finish-load', onFinish); } catch {}
        try { wc.removeListener('did-fail-load', onFail); } catch {}
        try { wc.removeListener('did-navigate-in-page', onInPage); } catch {}
      };

      const finish = (result: boolean) => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve(result);
        }
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
        // ONLY accept finish after this navigation has started in main-frame (non-in-place)
        if (!settled && navStarted) {
          if (tabId) {
            this.lastNavigationFailures.delete(tabId);
          }
          finish(true);
        }
      };

      const onInPage = (_event: unknown, _url: unknown, isMainFrame: boolean) => {
        if (isMainFrame && !settled) {
          if (tabId) {
            this.lastNavigationFailures.delete(tabId);
          }
          finish(true);
        }
      };
      const onFail = (_event: unknown, errorCode: unknown, errorDescription: unknown, _validatedURL: unknown, isMainFrame?: boolean) => {
        if (isMainFrame === false) {
          return;
        }
        // Chromium emits ERR_ABORTED (-3) on HTTP 301/302/307 redirects or request replacements
        if (errorCode === -3 || errorDescription === 'ERR_ABORTED') {
          return;
        }
        // ONLY accept real failure after this navigation has started in main-frame
        if (!settled && navStarted) {
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
          if (tabId) {
            this.lastNavigationFailures.set(tabId, {
              cause: 'NAVIGATION_START_TIMEOUT',
              message: `Navigation start timed out after ${Math.min(startTimeoutMs, timeoutMs)}ms`,
              timedOut: true,
            });
          }
          finish(false);
        }
      }, Math.min(startTimeoutMs, timeoutMs));

      totalTimer = setTimeout(() => {
        if (!settled) {
          if (tabId) {
            this.lastNavigationFailures.set(tabId, {
              cause: 'NAVIGATION_TIMEOUT',
              message: `Navigation load completion timed out after ${timeoutMs}ms`,
              timedOut: true,
            });
          }
          finish(false);
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
    tab.view.webContents.stop();
    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      tab.mobileView.webContents.stop();
    }
    return true;
  }

  public goBack(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
      const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;

      const canAuthBack = this.getCanGoBack(authorityView.webContents);
      if (!canAuthBack) return false;

      this.splitCoordinator.startHistoryTransaction(tabId, authorityPane, 'back');
      return this.safeGoBack(authorityView.webContents);
    }

    return this.safeGoBack(tab.view.webContents);
  }

  public goForward(tabId: string): boolean {
    const tab = this.tabs.get(tabId);
    if (!tab) return false;

    if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
      const authorityPane = tab.focusedPane || tab.state.splitFocusedPane || 'desktop';
      const authorityView = authorityPane === 'mobile' ? tab.mobileView : tab.view;

      const canAuthFwd = this.getCanGoForward(authorityView.webContents);
      if (!canAuthFwd) return false;

      this.splitCoordinator.startHistoryTransaction(tabId, authorityPane, 'forward');
      return this.safeGoForward(authorityView.webContents);
    }

    return this.safeGoForward(tab.view.webContents);
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
        // were asked for instead: an agent-plane tab, which renders offscreen at its own
        // size, and any tab that is not the active one, which is measured and captured
        // by a caller that requested an exact CSS viewport. Measured before this rule:
        // a 1440x900 request on a background tab laid the document out at 1186 CSS px
        // (window 1186 wide) and a 390x844 request at 342, while the capture rasterized
        // the requested size — the tab reported a viewport it never had.
        const isAgentPlane = tab.state.ephemeral === true || tab.state.offscreen === true;
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
    if (!tab || tab.view.webContents.isDestroyed()) return false;
    const site = getMuteSite(tab.view.webContents.getURL());
    if (!site) return false;
    if (this.mutedSites.has(site)) this.mutedSites.delete(site);
    else this.mutedSites.add(site);
    for (const record of this.tabs.values()) {
      const desktop = record.view.webContents;
      if (!desktop.isDestroyed() && getMuteSite(desktop.getURL()) === site) {
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

    if (!tab.view.webContents.isDestroyed()) {
      try {
        tab.view.webContents.executeJavaScript(`
          window.dispatchEvent(new Event('resize'));
          window.dispatchEvent(new Event('orientationchange'));
        `).catch(() => {});
      } catch {}

      if (shouldReload) {
        try {
          const wc = tab.view.webContents;
          if (typeof this.reloadAndWait === 'function') {
            this.reloadAndWait(tabId).catch(() => {});
          } else if (wc && typeof wc.reload === 'function') {
            wc.reload();
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
    const wc = active.view.webContents;
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

  public resolveAliasToTabId(alias: string): string | undefined {
    if (!alias || typeof alias !== 'string' || !this.tabs) return undefined;
    const lower = alias.trim().toLowerCase();
    for (const [id, tab] of this.tabs.entries()) {
      if (tab.state.alias?.toLowerCase() === lower || `@${tab.state.role?.toLowerCase()}` === lower) {
        return id;
      }
    }

    // Fallback for data/document/sheet synonyms
    const dataSynonyms = new Set(['@feedback', '@sheet', '@data', '@pricing', '@spec', '@doc', '@baogia']);
    if (dataSynonyms.has(lower)) {
      for (const [id, tab] of this.tabs.entries()) {
        if (tab.state.alias && dataSynonyms.has(tab.state.alias.toLowerCase())) {
          return id;
        }
      }
    }

    // Fallback for web/storefront synonyms
    const webSynonyms = new Set(['@storefront', '@web', '@store', '@live']);
    if (webSynonyms.has(lower)) {
      for (const [id, tab] of this.tabs.entries()) {
        if (tab.state.alias && webSynonyms.has(tab.state.alias.toLowerCase())) {
          return id;
        }
      }
    }

    return undefined;
  }

  public setTabAlias(tabId: string, alias?: string, role?: string, aliasColor?: string): boolean {
    const targetId = typeof tabId === 'string' && tabId.startsWith('@') ? this.resolveAliasToTabId(tabId) || tabId : tabId;
    const tab = this.tabs.get(targetId);
    if (!tab) return false;
    tab.state.alias = alias;
    if (role) tab.state.role = role;
    if (aliasColor) tab.state.aliasColor = aliasColor;
    this.broadcastState();
    this.schedulePersist();
    return true;
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
    if (trimmed.startsWith('@')) {
      return this.resolveAliasToTabId(trimmed);
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
   * Fans one terminal data payload out to every subscriber. The sidebar only
   * receives data while it is open — a closed sidebar re-hydrates from
   * getFullBuffer when toggleSidebar pushes 'antifan:terminal:session' on open,
   * so dropping sends here costs nothing and saves background render CPU.
   */
  private dispatchTerminalData(payload: TerminalDataPayload): void {
    let sent = 0;
    if (this.shell.isSidebarOpen && this.shell.sidebarView && !this.shell.sidebarView.webContents.isDestroyed()) {
      safeSendWebContents(this.shell.sidebarView.webContents, 'antifan:terminal:data', payload);
      sent += 1;
    }
    for (const [id, win] of this.terminalWindows.entries()) {
      if (win && !win.isDestroyed()) {
        safeSendWebContents(win.webContents, 'antifan:terminal:data', payload);
        sent += 1;
      } else {
        this.terminalWindows.delete(id);
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
   * exists, so the first badge refresh after the wake (GET_ALL_AFFINITIES) would
   * restore the tombstone and wedge the agent again. This therefore also drops dead
   * ids from the entry and re-points a stale primary at a live tab from the
   * surviving session pool.
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
      isOffscreen: primaryTab?.state.offscreen === true,
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

  public resolveTargetWorkspace(targetSessionId?: string, tabUrl?: string): string {
    const tm = TerminalManager.getInstance();
    if (targetSessionId && targetSessionId !== 'auto') {
      const session = tm.getSession(targetSessionId);
      if (session?.cwd && fs.existsSync(path.normalize(session.cwd))) {
        return path.normalize(session.cwd);
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

    // 4. Try to classify based on tab URL (e.g. seahorse.com.vn -> customizes/Seahorse2)
    if (tabUrl) {
      const urlWorkspace = resolveWorkspaceFromUrl(tabUrl, DEFAULT_WORKSPACE_ROOTS);
      if (urlWorkspace) {
        return urlWorkspace;
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
    const userData = app ? app.getPath('userData') : StorageLocations.getConfigDir();
    if (!fs.existsSync(userData)) {
      try { fs.mkdirSync(userData, { recursive: true }); } catch {}
    }
    return path.join(userData, 'saved-tabs.json');
  }

  /** Raw parse of the saved-tabs file; null when absent, unreadable or not an object. */
  private readSavedTabsFile(filePath: string): Record<string, unknown> | null {
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

  /** Read + normalize without writing; the caller's write persists the migration. */
  private normalizeSavedTabsFileForMerge(filePath: string): SavedTabsDocument | null {
    const data = this.readSavedTabsFile(filePath);
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
    const data = this.readSavedTabsFile(filePath);
    if (!data) return null;
    const { document, migrated } = normalizeSavedTabsDocument(data);
    if (migrated) {
      try {
        this.writeSavedTabsDocumentSync(filePath, document);
        console.log('[native-tab-host] Migrated legacy saved tabs to the owner-keyed document');
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
    const data = this.readSavedTabsFile(filePath);
    if (!data) return { migrated: false, reason: 'no-document' };
    const { document, migrated } = normalizeSavedTabsDocument(data);
    if (!migrated) return { migrated: false, reason: 'already-versioned' };
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
    const tempPath = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const json = JSON.stringify(document, null, 2);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      fs.writeFileSync(tempPath, json, 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try { fs.rmSync(tempPath, { force: true }); } catch {}
      throw err;
    }
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
    return {
      ...this.sharedPrefsFromPersistData(data),
      version: SAVED_TABS_SCHEMA_VERSION,
      owners,
      updatedAt: Date.now(),
    };
  }
  private isDisposed = false;
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
  private broadcastStatePending = false;
  private broadcastMicrotaskQueued = false;
  private broadcastTimer?: NodeJS.Timeout;
  private broadcastDeadline = 0;
  private readonly BROADCAST_MIN_INTERVAL_MS = 200; // 5 Hz ceiling

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
      if (tab.state.ephemeral === true || tab.state.offscreen === true) return null;
      return sanitizeTabForPersistence(tab.state);
    }).filter(Boolean);

    const openTerminalWindows: Array<{
      sessionId?: string;
      bounds: {
        x?: number;
        y?: number;
        width: number;
        height: number;
        isMaximized: boolean;
      };
      isPopout?: boolean;
    }> = [];

    for (const [winId, win] of this.terminalWindows.entries()) {
      if (win && !win.isDestroyed()) {
        let bounds = win.getBounds();
        if ('getNormalBounds' in win && typeof (win as any).getNormalBounds === 'function') {
          try {
            bounds = (win as any).getNormalBounds();
          } catch {}
        }
        const isMaximized = win.isMaximized();
        const meta = this.terminalWindowMeta.get(winId);
        openTerminalWindows.push({
          sessionId: meta?.sessionId || undefined,
          isPopout: win === this.popoutWindow,
          bounds: {
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            isMaximized,
          },
        });
      }
    }

    const persistedAffinities: Array<{
      terminalId: string;
      primaryTabId: string;
      managedTabIds: string[];
    }> = [];

    if (this.terminalAgentAffinity) {
      const isAgentTabId = (id?: string) => {
        if (!id) return false;
        const t = this.tabs.get(id);
        return t ? (t.state.ephemeral === true || t.state.offscreen === true) : false;
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
      if (!activeTab || activeTab.state.ephemeral === true || activeTab.state.offscreen === true) {
        persistedActiveTabId = undefined;
      }
    }

    return {
      activeTabId: persistedActiveTabId,
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
      isTerminalPopoutOpen: Boolean(this.popoutWindow && !this.popoutWindow.isDestroyed()),
      wasSidebarOpenBeforePopout: this.wasSidebarOpenBeforePopout,
      popoutSessionId: this.popoutWindow && !this.popoutWindow.isDestroyed() ? TerminalManager.getInstance().getActiveSessionId() : undefined,
      terminalWindows: openTerminalWindows,
      terminalAffinities: persistedAffinities,
      updatedAt: Date.now(),
    };
  }

  public async persistTabsAsync(): Promise<void> {
    if (this.isDisposed) return;
    if (this.isPersistingTabs) {
      this.hasPendingPersist = true;
      return;
    }
    this.isPersistingTabs = true;
    try {
      do {
        this.hasPendingPersist = false;
        const filePath = this.getTabsStoragePath();
        const data = this.buildPersistData();
        await enqueueSavedTabsWrite(filePath, async () => {
          // Merge and swap in ONE uninterrupted synchronous step. The read has to see what
          // another window wrote since this window last looked, and the rename has to happen
          // before anyone else reads — an await between the two lets a synchronous writer (a
          // closing window's disposal persist, which cannot enter this chain) land its newer
          // record in the gap, and this task would then rename an older snapshot over it.
          const existing = this.normalizeSavedTabsFileForMerge(filePath);
          this.writeSavedTabsDocumentSync(filePath, this.buildSavedTabsDocument(existing, data));
        });
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

  public persistSync(): void {
    if (this.isDisposed) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const filePath = this.getTabsStoragePath();
      const data = this.buildPersistData();
      const document = this.buildSavedTabsDocument(this.normalizeSavedTabsFileForMerge(filePath), data);
      this.writeSavedTabsDocumentSync(filePath, document);
      console.log('[native-tab-host] Persisted tabs sync to:', filePath);
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
        if (typeof document.isSidebarOpen === 'boolean') {
          this.shell.isSidebarOpen = document.isSidebarOpen;
        }
        this.applyTerminalTabPrefs({
          layout: document.terminalTabLayout,
          sidebarWidth: document.terminalSidebarWidth,
          collapsedCategories: document.terminalCollapsedCategories,
          categories: document.terminalCategories,
          categoryColors: document.terminalCategoryColors,
          starredCategories: document.terminalStarredCategories,
        });
        const record = document.owners[this.windowOwnerKey()];
        if (record && Array.isArray(record.terminalWindows) && record.terminalWindows.length > 0) {
          // Booting the manager is not provenance-free: `startTerminal()` with no target
          // keeps the process-wide `currentCwd` (another window's workspace may have set it)
          // and stamps the session with the ambient creation capsule, so a restored window
          // could come back as an invisible default-capsule PTY in the wrong directory. The
          // saved windows belong to this window, so this window's resolved target decides.
          const terminalTarget = this.resolveTerminalCreationTarget();
          TerminalManager.getInstance().startTerminal(terminalTarget.cwd, terminalTarget.capsuleId, terminalTarget.ownerKey);
          const wasOpen = typeof record.wasSidebarOpenBeforePopout === 'boolean' ? record.wasSidebarOpenBeforePopout : true;
          for (const tw of record.terminalWindows) {
            if (tw.isPopout) {
              this.togglePopoutTerminal(tw.sessionId, { wasSidebarOpenBeforePopout: wasOpen, bounds: tw.bounds });
            } else {
              this.openNewTerminalWindow(tw.sessionId, tw.bounds);
            }
          }
        } else if (record && record.isTerminalPopoutOpen) {
          // Same provenance rule as the saved-window branch above: the popout was this
          // window's, so it boots on this window's workspace and capsule, never on the
          // ambient process-wide ones.
          const terminalTarget = this.resolveTerminalCreationTarget();
          TerminalManager.getInstance().startTerminal(terminalTarget.cwd, terminalTarget.capsuleId, terminalTarget.ownerKey);
          const wasOpen = typeof record.wasSidebarOpenBeforePopout === 'boolean' ? record.wasSidebarOpenBeforePopout : true;
          this.togglePopoutTerminal(record.popoutSessionId, { wasSidebarOpenBeforePopout: wasOpen });
        }
        if (document.activeChromeProfileId) {
          ChromeProfileSyncManager.getInstance().activeProfileId = document.activeChromeProfileId;
        }
        if (Array.isArray(document.bookmarks) && document.bookmarks.length > 0) {
          this.bookmarks = document.bookmarks;
        }
        if (record && Array.isArray(record.tabs) && record.tabs.length > 0) {
          let restoredActiveId = record.activeTabId;
          const oldIdToNewId = new Map<string, string>();

          // Identify target active tab ID from persisted session
          let targetActiveOldId = typeof record.activeTabId === 'string' ? record.activeTabId : undefined;
          if (!targetActiveOldId || !record.tabs.some((t: Record<string, unknown> | null) => t && (t.id === targetActiveOldId || (t.state as Record<string, unknown> | undefined)?.id === targetActiveOldId))) {
            const firstValid = record.tabs.find((t: Record<string, unknown> | null) => t && !t.ephemeral && !t.offscreen);
            if (firstValid && typeof firstValid.id === 'string') {
              targetActiveOldId = firstValid.id;
            }
          }

          for (const rawTab of record.tabs) {
            // Persisted entries were written from AntiFanTab states, and
            // migratePersistedTab re-validates every field it reads, so the shape
            // assertion ends at this call.
            const migrated = migratePersistedTab(rawTab as Partial<AntiFanTab>);
            const rawId = typeof rawTab.id === 'string' ? rawTab.id : undefined;
            if (rawTab.ephemeral === true || rawTab.offscreen === true) continue;
            if (migrated.ephemeral === true || migrated.offscreen === true) continue;
            const safeUrl = cleanRestoredUrl(migrated.url || 'about:blank');
            const isTargetActive = rawId === targetActiveOldId || migrated.id === targetActiveOldId;
            const isUnloadedStub = options?.safeStart === true && !isTargetActive;
            const initialTabUrl = isUnloadedStub ? 'about:blank' : safeUrl;
            const id = this.createTab(initialTabUrl, false, {
              capsuleId: migrated.capsuleId,
              userAgentMode: migrated.userAgentMode,
            });
            if (rawId) {
              oldIdToNewId.set(rawId, id);
            }
            if (migrated.id) {
              oldIdToNewId.set(migrated.id, id);
            }
            const tab = this.tabs.get(id);
            if (tab) {
              tab.state.url = safeUrl;
              if (isUnloadedStub) {
                tab.state.isLoading = false;
              }
              if (migrated.title) tab.state.title = migrated.title;
              if (migrated.devicePresetId) this.setDevicePreset(id, migrated.devicePresetId);
              if (typeof migrated.zoomFactor === 'number') tab.state.zoomFactor = migrated.zoomFactor;
              if (migrated.alias) tab.state.alias = migrated.alias;
              if (migrated.role) tab.state.role = migrated.role;
              if (migrated.aliasColor) tab.state.aliasColor = migrated.aliasColor;
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
            if ((rawId !== undefined && rawId === record.activeTabId) || migrated.id === record.activeTabId) {
              restoredActiveId = id;
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
            if (activeCandidate && activeCandidate.state.ephemeral !== true && activeCandidate.state.offscreen !== true) {
              this.switchTab(restoredActiveId);
            } else if (this.tabOrder.length > 0) {
              this.switchTab(this.tabOrder[0]!);
            }
          } else if (this.tabOrder.length > 0) {
            this.switchTab(this.tabOrder[0]!);
          }
          this.updateLayout();
          return;
        }
      }
    } catch (err) {
      console.warn('[native-tab-host] Failed to restore tabs:', err);
    }

    // Default fallback
    this.createTab(fallbackUrl || 'https://www.google.com');
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
    // The sidebar and every terminal window read the tab list; the ones showing a
    // terminal tab strip also read the affinity map behind its badges. Both ride one
    // channel because the map is a projection of the state this broadcast already
    // carries, and fetching it separately cost a second `invoke` per broadcast —
    // ~72,000 over one 4 h soak — each allocating a correlation entry, a promise and
    // a deserialized map on the main thread that every switch, bridge RPC and
    // terminal fanout also runs on. Built once here, however many windows read it.
    const tabTargets = [
      this.shell.sidebarView?.webContents,
      ...(this.terminalWindows ? Array.from(this.terminalWindows.values(), (win) => win?.webContents) : []),
    ].filter((wc): wc is Electron.WebContents => Boolean(wc));
    if (tabTargets.length > 0) {
      const tabsPayload: TabsUpdatedPayload = {
        tabs: payload.tabs,
        terminalAffinities: this.buildTerminalAffinityMap(),
      };
      for (const wc of tabTargets) {
        safeSendWebContents(wc, 'antifan:tabs:updated', tabsPayload);
      }
    }
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
  public getThemeQaState(tabId?: string): { status: 'idle' | 'running' | 'pass' | 'fail' | 'error'; issueCount: number; reportArtifactId?: string; report?: unknown; error?: string; updatedAt: number } {
    const id = tabId || this.activeTabId;
    return this.tabThemeQaStates?.get(id) || { status: 'idle', issueCount: 0, updatedAt: Date.now() };
  }

  private async runThemeQa(options?: { workspaceRoot?: string }): Promise<{ ok: boolean; report?: unknown; error?: string }> {
    if (!this.controlPlane) {
      const error = 'Control plane runtime is not initialized';
      this.tabThemeQaStates?.set(this.activeTabId, { status: 'error', issueCount: 0, error, updatedAt: Date.now() });
      this.broadcastState();
      return { ok: false, error };
    }
    const tab = this.tabs.get(this.activeTabId);
    const target = this.getAutomationTarget() || (() => {
      if (!tab) return undefined;
      const lease = this.controlPlane!.getLease();
      return { projectId: lease.projectId, workspaceId: lease.workspaceId || '', runtimeId: lease.runtimeId, tabId: this.activeTabId, browserEpoch: lease.hostEpoch, documentGeneration: this.getDocumentGeneration(this.activeTabId), url: tab.state.url };
    })();
    if (!target) {
      const error = 'No active browser tab for Theme QA validation';
      this.tabThemeQaStates?.set(this.activeTabId, { status: 'error', issueCount: 0, error, updatedAt: Date.now() });
      this.broadcastState();
      return { ok: false, error };
    }
    const workspaceRoot = options?.workspaceRoot || this.capsuleManager.getActive()?.workspacePath || this.controlPlane.getWorkspaceRoot();
    const tabId = target.tabId;
    this.tabThemeQaStates?.set(tabId, { status: 'running', issueCount: 0, updatedAt: Date.now() });
    if (tabId === this.activeTabId) {
      this.broadcastState();
    }
    return new Promise((resolve) => {
      const gen = this.getDocumentGeneration(tabId);
      this.asyncQaQueue.enqueue(tabId, gen, async (signal: AbortSignal) => {
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
          this.tabThemeQaStates?.set(tabId, { status, issueCount, reportArtifactId, report, updatedAt: Date.now() });
          if (tabId === this.activeTabId) {
            this.broadcastState();
          }
          resolve({ ok: true, report });
        } catch (error) {
          if (signal.aborted) {
            resolve({ ok: false, error: 'Theme QA was aborted by document navigation' });
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.tabThemeQaStates?.set(tabId, { status: 'error', issueCount: 0, error: message, updatedAt: Date.now() });
          if (tabId === this.activeTabId) {
            this.broadcastState();
          }
          resolve({ ok: false, error: message });
        }
      });
    });
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
    if (!tab || tab.view.webContents.isDestroyed()) return { ok: false, error: 'Tab not found or destroyed' };

    const wc = tab.view.webContents;
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

        const timeoutPromise = new Promise<{ timeout: boolean }>((resolve) => setTimeout(() => resolve({ timeout: true }), 1500));
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
    if (!tab || tab.view.webContents.isDestroyed()) {
      throw new CapabilityError('TARGET_STALE', `Target tab '${targetId}' not found or destroyed`);
    }
    const release = this.admitAgentAction('sendKeyboardPress', targetId);
    try {
      return await this.withTabAgentWorking(targetId, async () => {
        const events = buildKeyboardInputEvents(params.key, params.modifiers);
        for (const evt of events) {
          this.syncWithAgentInput(() => {
            tab.view.webContents.sendInputEvent(evt);
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
      const wc = tab.view.webContents;

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
      if (tab.state.capsuleId?.toLowerCase() === targetKey && !tab.view.webContents.isDestroyed()) {
        if (event.type === 'css-swap') {
          tab.view.webContents.executeJavaScript(`(() => {
            document.querySelectorAll('link[rel="stylesheet"]').forEach((link) => {
              const url = new URL(link.href);
              url.searchParams.set('antifan_ts', Date.now().toString());
              link.href = url.toString();
            });
          })()`).catch(() => {});
        } else {
          if (!tab.view.webContents.isDestroyed()) {
            tab.view.webContents.reload();
          }
          if (tab.state.splitMode && tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
            tab.mobileView.webContents.reload();
          }
        }
      }
    }
  }
  /**
   * The session a terminal window may be created bound to: the requested id only when this
   * host can already attribute that session to the window that asked.
   *
   * A session id is not a capability. A renderer that names another project's session would
   * otherwise make this host present it, forward its output, and let the new window type
   * into it — the binding enters `terminalWindowMeta`, which is exactly the positive
   * attribution the scope is built on. An unadmitted request leaves the window unbound.
   */
  private admitTerminalWindowBinding(sessionId?: string): string | undefined {
    return typeof sessionId === 'string' && sessionId && this.isSessionVisibleToWindow(sessionId) ? sessionId : undefined;
  }

  /** The active session of this window's own scope, never the process-wide one another window set. */
  private ownActiveSessionId(): string {
    return this.terminalStateForWindow(TerminalManager.getInstance().getSessionState()).activeSessionId;
  }

  public togglePopoutTerminal(sessionId?: string, options?: { wasSidebarOpenBeforePopout?: boolean; bounds?: Partial<WindowState> }): boolean {
    if (this.popoutWindow && !this.popoutWindow.isDestroyed()) {
      this.popoutWindow.close();
      this.popoutWindow = null;
      this.broadcastPopoutState(false);
      if (this.wasSidebarOpenBeforePopout && !this.shell.isSidebarOpen) {
        this.toggleSidebar();
      }
      this.wasSidebarOpenBeforePopout = false;
      this.schedulePersist();
      return false;
    }

    const admittedSessionId = this.admitTerminalWindowBinding(sessionId);

    const bounds = WindowStateManager.validateBounds(options?.bounds || this.terminalWindowStateManager.getState(), 900, 600);
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: bounds.width || 900,
      height: bounds.height || 600,
      minWidth: 500,
      minHeight: 350,
      backgroundColor: '#060a11',
      title: 'AntiFan Terminal Workbench',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'standalone-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    const showPopoutWin = () => {
      if (!win.isDestroyed() && !win.isVisible()) {
        if (bounds.isMaximized) {
          win.maximize();
        }
        win.show();
      }
    };
    win.once('ready-to-show', showPopoutWin);
    setTimeout(showPopoutWin, 300);
    this.terminalWindowStateManager.manage(win);
    this.popoutWindow = win;
    this.terminalWindows.set(win.id, win);
    const activeSessionId = admittedSessionId || this.ownActiveSessionId();
    this.terminalWindowMeta.set(win.id, { sessionId: activeSessionId, isPopout: true });

    const onWindowChange = () => {
      this.schedulePersist();
    };
    win.on('resize', onWindowChange);
    win.on('move', onWindowChange);
    win.on('maximize', onWindowChange);
    win.on('unmaximize', onWindowChange);
    const standaloneHtml = this.resolveStandaloneRendererPage();

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
      }
    });

    win.webContents.on('did-finish-load', async () => {
      const tm = TerminalManager.getInstance();
      // The sessions this window's own window may see, never another project's: the bound
      // session stays in the list, and with no explicit binding the active one is this
      // window's own active session rather than the process-wide one.
      const scoped = this.terminalStateForWindow(tm.getSessionState(), admittedSessionId);
      const activeId = admittedSessionId || scoped.activeSessionId || '';
      const s = activeId ? await tm.getSession(activeId, { includeBuffer: true }) : undefined;
      const activeSession = scoped.sessions.find((summary) => summary.id === activeId);
      safeSendWebContents(win.webContents, 'antifan:terminal:session', {
        activeSessionId: activeId,
        sessions: scoped.sessions,
        splitSessionId: activeSession?.splitSessionId,
        snapshot: s?.buffer || '',
      });
    });

    win.loadFile(standaloneHtml, { query: { mode: 'popout', ...(admittedSessionId ? { sessionId: admittedSessionId } : {}) } });
    if (options && typeof options.wasSidebarOpenBeforePopout === 'boolean') {
      this.wasSidebarOpenBeforePopout = options.wasSidebarOpenBeforePopout;
    } else {
      this.wasSidebarOpenBeforePopout = this.shell.isSidebarOpen;
    }
    if (this.shell.isSidebarOpen) {
      this.toggleSidebar();
    }
    win.on('closed', () => {
      this.terminalWindows.delete(win.id);
      this.terminalWindowMeta.delete(win.id);
      if (this.popoutWindow === win) {
        this.popoutWindow = null;
        this.broadcastPopoutState(false);
        if (this.wasSidebarOpenBeforePopout && !this.shell.isSidebarOpen) {
          this.toggleSidebar();
        }
        this.wasSidebarOpenBeforePopout = false;
      }
      this.schedulePersist();
    });
    this.broadcastPopoutState(true);
    this.schedulePersist();
    return true;
  }

  public openNewTerminalWindow(sessionId?: string, customBounds?: Partial<WindowState>): boolean {
    const admittedSessionId = this.admitTerminalWindowBinding(sessionId);
    const baseBounds = customBounds ? WindowStateManager.validateBounds(customBounds, 900, 600) : this.terminalWindowStateManager.getValidBounds();
    const count = this.terminalWindows.size;
    const offsetX = (!customBounds && count > 0 && typeof baseBounds.x === 'number') ? baseBounds.x + (count * 25) : baseBounds.x;
    const offsetY = (!customBounds && count > 0 && typeof baseBounds.y === 'number') ? baseBounds.y + (count * 25) : baseBounds.y;

    const win = new BrowserWindow({
      x: offsetX,
      y: offsetY,
      width: baseBounds.width || 900,
      height: baseBounds.height || 600,
      minWidth: 500,
      minHeight: 350,
      backgroundColor: '#060a11',
      title: 'AntiFan Terminal Workbench',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, '..', '..', 'preload', 'standalone-preload.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
      },
    });

    const showNewTermWin = () => {
      if (!win.isDestroyed() && !win.isVisible()) {
        if (baseBounds.isMaximized) {
          win.maximize();
        }
        win.show();
      }
    };
    win.once('ready-to-show', showNewTermWin);
    setTimeout(showNewTermWin, 300);

    this.terminalWindows.set(win.id, win);
    const activeSessionId = admittedSessionId || this.ownActiveSessionId();
    this.terminalWindowMeta.set(win.id, { sessionId: activeSessionId, isPopout: false });

    const onWindowChange = () => {
      this.schedulePersist();
    };
    win.on('resize', onWindowChange);
    win.on('move', onWindowChange);
    win.on('maximize', onWindowChange);
    win.on('unmaximize', onWindowChange);

    win.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'F11') {
        event.preventDefault();
        win.setFullScreen(!win.isFullScreen());
      }
    });
    const standaloneHtml = this.resolveStandaloneRendererPage();

    win.webContents.on('did-finish-load', async () => {
      const tm = TerminalManager.getInstance();
      // The sessions this window's own window may see, never another project's: the bound
      // session stays in the list, and with no explicit binding the active one is this
      // window's own active session rather than the process-wide one.
      const scoped = this.terminalStateForWindow(tm.getSessionState(), admittedSessionId);
      const activeId = admittedSessionId || scoped.activeSessionId || '';
      const s = activeId ? await tm.getSession(activeId, { includeBuffer: true }) : undefined;
      const activeSession = scoped.sessions.find((summary) => summary.id === activeId);
      safeSendWebContents(win.webContents, 'antifan:terminal:session', {
        activeSessionId: activeId,
        sessions: scoped.sessions,
        splitSessionId: activeSession?.splitSessionId,
        snapshot: s?.buffer || '',
      });
    });

    win.loadFile(standaloneHtml, { query: { mode: 'popout', ...(admittedSessionId ? { sessionId: admittedSessionId } : {}) } });

    win.on('closed', () => {
      this.terminalWindows.delete(win.id);
      this.terminalWindowMeta.delete(win.id);
      this.schedulePersist();
    });
    this.schedulePersist();
    return true;
  }

  private broadcastPopoutState(isPopout: boolean): void {
    safeSendWebContents(this.shell.sidebarView?.webContents, 'antifan:terminal:popout-state-changed', isPopout);
    for (const [, win] of this.terminalWindows) {
      safeSendWebContents(win?.webContents, 'antifan:terminal:popout-state-changed', isPopout);
    }
  }

  public dispose(): void {
    if (this.isDisposed) return;
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
    // A raised view is normally one of the tab views disposed above; a view this host
    // raised that no tab record owns would otherwise keep its renderer alive.
    try {
      if (this.raisedCaptureView) this.destroyOwnedWebContents(this.raisedCaptureView.webContents);
    } catch {}
    this.raisedCaptureView = null;
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
      try {
        this.shell.window.contentView.removeChildView(tab.view);
      } catch {}
      try {
        this.destroyOwnedWebContents(tab.view.webContents);
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
