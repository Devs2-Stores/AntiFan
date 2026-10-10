/**
 * AntiFan Browser Desktop — Main Electron Bootstrap Entry Point
 * High-performance, ultra-lightweight Chromium host and Extension Bridge companion.
 */
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, ipcMain, protocol, session, nativeTheme, webContents, crashReporter, dialog, powerMonitor, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';

// Register custom privileged scheme for local workspace preview before app.whenReady()
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'antifan-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: false,
    },
  },
]);
import { registerPreviewProtocolHandler } from './server/preview-protocol-handler';
import { StorageLocations, DISK_CACHE_BYTES, MEDIA_CACHE_BYTES } from './config/storage-locations';
import { WorkspaceCapsuleManager, findReusableCapsule, type WorkspaceCapsule } from './project/workspace-capsule';
import { ProjectRegistry } from './project/project-registry';
import { ProjectPreferences, PROJECT_PREFERENCES_FILE } from './project/project-preferences';
import { reconcileProjectRecords } from './project/project-reconcile';
import {
  hasValidatedAffiliation,
  parseOwnerKey,
  resolveProjectContext,
  uniqueValidatedClaim,
  type ProjectContextPorts,
  type ValidatedAffiliationCapsule,
} from './project/project-context';
import {
  collectProjectOpenCandidates,
  projectOpenDialogSpec,
  projectOpenChoiceFor,
  projectOpenWireChoice,
  type ProjectOpenCandidate,
  type ProjectOpenChoice,
  type ProjectOpenDialogSpec,
} from './project/project-open-picker';
import { NativeTabHost, collectTabSearchInventory, activateTabSearchResult, isUnhostedTerminalWindow, purgeSavedTabsFileForProject, foldDetachedOwnerRecord, listDetachedProjectOwnerRecords, normalizeSavedTabsDocument, savedTabsFilePath, savedTabsOwnerIsDetached, type FoldDetachedOwnerResult, type TabSearchInventoryRow, type TabSearchActivationFailure } from './browser/native-tab-host';
import { singleInstanceLockExitCode } from './browser/single-instance-lock';
import { closeAuxiliaryWindow } from './browser/auxiliary-close';
import { ProjectWindowManager, type OpenIntent } from './browser/project-window-manager';
import { ProjectWindowShell, ownerKey, ownerLabel, resolveRendererAsset, resolvePreloadAsset, type ChromeSurface, type WindowOwner } from './browser/project-window-shell';
import { TabAuthorityDirectory } from './browser/tab-authority-directory';
import { TabAmbientAuthority } from './browser/tab-ambient-authority';
import {
  PageCloseReservations,
  ProjectCloseCoordinator,
  type ClosePhase,
  type CloseReport,
  type CloseSurface,
  type LiveUseReport,
  type LiveUseRequest,
  type PageCloseOutcome,
  type QuitReport,
  type SurfaceCloseOutcome,
} from './browser/project-close-coordinator';
import {
  collectCloseLiveUse,
  projectLiveUseAttachments,
  ORPHANED_RUN_STATE,
  type CloseLiveUseAffinity,
  type CloseLiveUseAttachmentRecord,
  type CloseLiveUsePort,
  type CloseLiveUseRun,
  type CloseLiveUseTerminalState,
} from './browser/close-live-use';
import {
  presentCloseRefusal,
  type CloseRefusalPresentationPort,
} from './browser/close-refusal-notice';
import { safeSendWebContents } from './browser/web-contents-guard';
import {
  setChromeSenderResolver,
  installChromeIpcOnce,
  listRegisteredChromeChannels,
  type IpcRoute,
  type RoutedSurface,
} from './browser/ipc-router';
import { BridgeServer, DEFAULT_EXTENSION_ALLOWED_DOMAINS, redactCredentials, type BridgeMintHostResolver } from './bridge/bridge-server';
import { TerminalManager, DEFAULT_TERMINAL_CAPSULE_ID } from './browser/terminal-manager';
import { ensureDaemon } from './terminal-daemon/daemon-spawner';
import { DaemonTerminalProxy } from './terminal-daemon/daemon-client';
import { TerminalOutputRouter } from './browser/terminal-output-router';
import { EventEmitter } from 'node:events';
import { buildApplicationMenu, dispatchApplicationMenuShortcut } from './browser/app-menu';
import type { ApplicationMenuOptions } from './browser/app-menu';
import { WindowStateManager } from './browser/window-state';
import { HistoryManager } from './browser/history-manager';
import { configureBrowserSessionPartition } from './browser/browser-session-partition';
import { pruneDeadStores } from './browser/dead-store-cleaner';
import { ChromeProfileSyncManager } from './browser/chrome-profile-sync';
import { LocalIpcServer } from './native-messaging/local-ipc-server';
import { installNativeHost, COMPANION_EXTENSION_ID } from './native-messaging/manifest-installer';
import { chromeSessionUserAgent } from './browser/google-auth-identity';
import { ControlPlaneRuntime, resolveArtifactStoreOptionsFromEnv } from './control-plane/control-plane-runtime';
import { RunStateService } from './run/run-state-service';
import type { ExecutionBackend } from './agent/execution-backend';
import { BrowserControlPort, assertApplicationAdmitsWork } from './tools/browser-control-port';
import { CockpitPort } from './tools/cockpit-port';
import { CapabilityTransportAdapter } from './tools/capability-transport';
import { DeviceManager } from './device/device-manager';
import { IosDeviceAdapter } from './device/ios-device-adapter';
import { validateControlPlaneId, makeControlPlaneId, CapabilityError, DEFAULT_BOOT_PROJECT_ID, DEFAULT_BOOT_WORKSPACE_ID, isBootProjectId, type ProjectRecord } from '../shared/control-plane-contracts';
import {
  PROJECT_WINDOW_CHANNELS,
  type ProjectOpenListCandidate,
  type ProjectOpenListResult,
  type ProjectStoredStatus,
  type ProjectOpenResult,
  type ProjectDetachResult,
  type ProjectReattachResult,
  type ProjectRemoveResult,
  type ProjectRenameResult,
  type ProjectAppearanceResult,
  type ProjectTabActivationResult,
  type ProjectTabSearchRow,
  type ProjectTabSearchResult,
  type ProjectTabUnavailableCode,
  type ProjectWindowIdentity,
  type ProjectWindowOwner,
} from '../shared/contracts';
import { assertDeadlineChain } from '../shared/deadline-chain';
import { preparePersistentProfile, ProfileMigrationError, ProfileOwnership, ProfileOwnershipError, type PersistentProfileResult, type ProfileLease } from './browser/profile-ownership';
import { recordBenchmark, startEventLoopDelayMonitor, isBenchmarkEnabled, refusesWindowClose, BENCHMARK_ALLOW_WINDOW_CLOSE_ENV } from './benchmark/telemetry';
import type { ForceCloseWindowResult } from '../shared/contracts';
import type { ActionSequenceParams } from './browser/tab-automation-host';
import {
  recordLifecycleEvent,
  installExitInterceptor,
  installExitRecorder,
  getLifecycleLogPath,
  runBoundedShutdownStep,
} from './diagnostics/main-lifecycle-log';
import { pruneOldCrashDumps } from './diagnostics/crash-dump-retention';
import { intakeCrashReports } from './diagnostics/crash-report-intake';
import { IssueRegister } from './session/issue-register';

// Fail-closed boot guard (`AP-DEADLINE-001`): the request deadline chain must strictly
// increase from the innermost callee bound to the outermost caller bound. A flattened or
// inverted chain lets a caller abandon a request while its callee still admits it, which
// converts a recoverable timeout into an orphaned command. Refuse to boot on an incoherent
// chain instead of serving requests under one. Deliberately above the uncaughtException
// handler: this throw must be fatal, never swallowed into a boot that continues anyway.
assertDeadlineChain();

// Every fatal path below also writes a durable journal line. A launch from Explorer
// or a shortcut has no attached console, so the console.* lines alone are discarded:
// the app used to die without leaving any record of how. Runtime events are queued
// and appended off-thread; only exit/crash paths flush synchronously.
process.on('uncaughtException', (err) => {
  console.error('[antifan uncaughtException]', redactCredentials(err?.stack || String(err)));
  recordLifecycleEvent('uncaughtException', { detail: redactCredentials(err?.stack || String(err)) }, { sync: true });
});

process.on('unhandledRejection', (reason) => {
  console.error('[antifan unhandledRejection]', redactCredentials(String(reason)));
  recordLifecycleEvent('unhandledRejection', { detail: redactCredentials(String(reason)) });
});

app.on('render-process-gone', (_event, webContents, details) => {
  console.warn('[antifan render-process-gone]', details.reason, 'exitCode:', details.exitCode, 'url:', webContents?.getURL?.() || 'unknown');
  recordLifecycleEvent('render-process-gone', {
    reason: details.reason,
    exitCode: details.exitCode,
    url: webContents?.getURL?.() || 'unknown',
  });
});

app.on('child-process-gone', (_event, details) => {
  console.warn('[antifan child-process-gone]', details.type, details.reason, 'exitCode:', details.exitCode);
  recordLifecycleEvent('child-process-gone', { type: details.type, reason: details.reason, exitCode: details.exitCode });
});

// One interceptor covers every explicit exit — including `app.exit`, which fires no
// before-quit/will-quit event and is therefore invisible to all lifecycle listeners
// below. Recording the call site is what turns "the app vanished" into "the app
// exited here". Installed before any later code can exit.
installExitInterceptor(app, process);
installExitRecorder(process);

// Electron's own crash reporter is enabled so that a fatal native crash leaves a dump with
// metadata inside the app's data directory, instead of only in the machine-wide WER store
// that has to be found by hand. Measured 2026-09-14: pid 20812 died with exception code
// 0xC000041D (STATUS_FATAL_USER_CALLBACK_EXCEPTION) and wrote NO journal line at all,
// because the exception left through a native callback before any handler above could run.
// For that class of death the dump is the only surviving artifact, and this is what makes
// it findable on the next launch. The dump path must be set before the reporter starts.
let crashDumpsDir: string | null = null;
// Earliest boot marker: precedes crash-reporter setup so a process that dies
// before any other lifecycle event still leaves one journal row proving it started.
recordLifecycleEvent('boot.start', { argv0: process.argv[0] ? 'set' : 'unset' });

try {
  crashDumpsDir = path.join(StorageLocations.getRuntimeDir(), 'crashDumps');
  fs.mkdirSync(crashDumpsDir, { recursive: true });
  app.setPath('crashDumps', crashDumpsDir);
  crashReporter.start({
    productName: 'AntiFan Desktop',
    companyName: 'AntiFan',
    submitURL: '',
    uploadToServer: false,
    compress: false,
  });
  const prunedDumps = pruneOldCrashDumps(crashDumpsDir, 3);
  recordLifecycleEvent('crashReporter.enabled', { crashDumps: crashDumpsDir, prunedDumps: prunedDumps.length });
} catch (err) {
  // Never fatal: failing to arm the crash reporter must not stop the app from starting.
  recordLifecycleEvent('crashReporter.failed', { detail: redactCredentials(String(err)) });
}

// Read what earlier deaths left behind BEFORE retention can delete it. The dump is written by a
// native fault that runs no JS handler, so this launch is the first moment the death can be
// named; pruneOldCrashDumps keeps only the newest few, so pruning first would delete an
// unrecorded dump and turn a named death back into silence. The same is true when intake
// itself fails: pruning then would delete dumps that were never read, so retention runs only
// when intake reports it completed. Intake never throws and never blocks startup: it is
// awaited by nothing, and its failures are its own.
try {
  if (crashDumpsDir) {
    const dumpsDir = crashDumpsDir;
    void intakeCrashReports({ crashDumpsDir: dumpsDir })
      .then((intake) => {
        if (!intake.completed) return;
        // Dumps intaken this boot recorded OPEN rows after the constructor's
        // one-shot reconcile ran; re-run the signature pass so a crash whose
        // fix already shipped doesn't sit OPEN for a whole session.
        try { IssueRegister.getInstance().autoReconcileKnownIssues(); } catch {}
        const prunedDumps = pruneOldCrashDumps(dumpsDir, 3);
        if (prunedDumps.length > 0) {
          recordLifecycleEvent('crashReporter.pruned', { prunedDumps: prunedDumps.length });
        }
      })
      .catch(() => undefined);
  }
} catch (err) {
  recordLifecycleEvent('crashReporter.intakeFailed', { detail: redactCredentials(String(err)) });
}

const IS_PROD = process.argv.includes('--production') || process.env.NODE_ENV === 'production';
const IS_DEV = !IS_PROD;
if (process.argv.includes('--mcp-server')) {
  console.error('[antifan] Electron --mcp-server is discontinued. Use the standalone Node MCP proxy (scripts/antifan-omp-mcp.cjs) to connect to a running AntiFan Desktop instance.');
  app.exit(1);
  process.exit(1);
}
const IS_CI = Boolean(process.env.CI && process.env.CI !== 'false' && process.env.CI !== '0');
const HAS_EVAL_FLAG = process.argv.includes('--allow-eval') || process.argv.includes('--mcp-high-risk');
const HAS_EVAL_ENV = process.env.ANTIFAN_ALLOW_EVAL === 'true' || process.env.ANTIFAN_ALLOW_EVAL === '1';
// Require explicit opt-in (ANTIFAN_ALLOW_EVAL=true or --allow-eval/--mcp-high-risk); exclude CI; never default eval-on for win32 prod
const ALLOW_EVAL = !process.env.ANTIFAN_CLOUD_HOSTED && (HAS_EVAL_FLAG || (!IS_CI && HAS_EVAL_ENV));
// Every packaged, shortcut, and development launch owns the same Chromium
// profile. The environment override remains available for isolated tests and
// benchmarks, but launch mode never changes a user's browser identity.
const customUserData = process.env.ANTIFAN_USER_DATA || process.env.ANTIFAN_USER_DATA_DIR;
StorageLocations.ensureDirectories();
if (!process.env.ANTIFAN_CONFIG_DIR) {
  process.env.ANTIFAN_CONFIG_DIR = StorageLocations.getConfigDir();
}
if (!process.env.ANTIFAN_DATA_ROOT) {
  process.env.ANTIFAN_DATA_ROOT = StorageLocations.getDataRoot();
}
let preparedProfile: PersistentProfileResult;
try {
  preparedProfile = preparePersistentProfile({
    appDataPath: app.getPath('appData'),
    appPath: app.getAppPath(),
    customUserData,
    canonicalPath: StorageLocations.getProfileDir(),
  });
} catch (error) {
  if (error instanceof ProfileMigrationError) {
    console.error(`[antifan] ${error.message}`);
  }
  throw error;
}
const persistentUserData = preparedProfile.profilePath;
if (preparedProfile.migratedFrom) {
  console.log(`[antifan] Migrated Chromium profile from ${preparedProfile.migratedFrom} to ${persistentUserData}`);
}
const chromiumCachePath = StorageLocations.getCacheDir();
try { fs.mkdirSync(persistentUserData, { recursive: true }); } catch {}
try { fs.mkdirSync(chromiumCachePath, { recursive: true }); } catch {}
app.setPath('userData', persistentUserData);
app.setPath('sessionData', persistentUserData);
app.setPath('cache', chromiumCachePath);
// No `--disk-cache-dir`: measured at 0 bytes since it was added — the sessions
// that actually serve traffic are partition sessions, and each partition keeps
// its own `Cache` directory under <userData>/Partitions/<name>/Cache, which the
// switch never redirected. That per-partition cache is what the app pays for:
// measured 168–171 MB on the live jar while `--disk-cache-size` was set to
// 128 MB, so the switch is NOT the bound on it — Chromium evicts those backends
// on its own policy. The switches below stay because they do bind the
// default-session caches, and `Profile/Cache` (the default session's HTTP cache,
// stale since tabs moved onto explicit partitions) is reclaimed by the
// housekeeping pass whenever a launch finds it unheld.
app.commandLine.appendSwitch('gpu-cache-dir', StorageLocations.getGpuCacheDir());
app.name = 'AntiFan Browser Desktop';
nativeTheme.themeSource = 'system';

// Configure high-performance Chromium hardware acceleration, memory caps, and security switches
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('enable-fast-unload');
app.commandLine.appendSwitch('enable-tcp-fast-open');
app.commandLine.appendSwitch('renderer-process-limit', '4');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disk-cache-size', String(DISK_CACHE_BYTES)); // 128 MB
app.commandLine.appendSwitch('media-cache-size', String(MEDIA_CACHE_BYTES));  // 64 MB
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill,SmoothScrolling,ParallelDownloading,BackForwardCache,AsyncImageDecoding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
const CHROME_USER_AGENT = chromeSessionUserAgent();
app.userAgentFallback = CHROME_USER_AGENT;

export const projectRegistry = new ProjectRegistry();
let projectWindows: ProjectWindowManager | null = null;
let capsuleManager: WorkspaceCapsuleManager | null = null;

export { hasValidatedAffiliation, uniqueValidatedClaim, type ValidatedAffiliationCapsule } from './project/project-context';

/**
 * Synchronize explicit capsule project/workspace affiliations into the ProjectRegistry.
 *
 * Capsule store is the durable record and the ProjectRegistry is the runtime projection.
 * Main's synchronizer is the single writer.
 *
 * Rules:
 * 1. For every capsule carrying explicit projectId + workspaceId:
 *    - Registers the project (id = capsule.projectId, name = capsule.name, state = 'open', dataRoot)
 *    - Registers the workspace (id = capsule.workspaceId, projectId, rootPath = capsule.workspacePath, state = 'attached')
 * 2. Idempotent: running twice leaves the registry unchanged.
 * 3. Never overwrites a newer root with an older one (compares updatedAt timestamps).
 * 4. Never invents a project for a capsule that claims none (absent or ambiguous affiliation stays unregistered).
 *    Matching the plan's "ambiguity is Unassigned" rule: multiple capsules claiming the same projectId is ambiguous.
 */
export function synchronizeCapsulesWithRegistry(
  capsules: WorkspaceCapsuleManager | WorkspaceCapsule[],
  registry: ProjectRegistry,
  dataRoot: string,
): { registeredProjects: number; registeredWorkspaces: number } {
  const capsuleList = Array.isArray(capsules) ? capsules : capsules.list();
  const resolvedDataRoot = path.resolve(dataRoot);

  const validExplicitCapsules: ValidatedAffiliationCapsule[] = [];
  const projectClaimCounts = new Map<string, number>();

  for (const capsule of capsuleList) {
    if (!hasValidatedAffiliation(capsule)) continue;
    validExplicitCapsules.push(capsule);
    const count = projectClaimCounts.get(capsule.projectId) || 0;
    projectClaimCounts.set(capsule.projectId, count + 1);
  }

  let registeredProjects = 0;
  let registeredWorkspaces = 0;

  for (const capsule of validExplicitCapsules) {
    const projectId = capsule.projectId;
    const workspaceId = capsule.workspaceId;

    // Ambiguity check: multiple capsules claiming the same project ID is ambiguous -> stays unregistered
    if ((projectClaimCounts.get(projectId) || 0) > 1) {
      continue;
    }

    const normalizedRoot = capsule.workspacePath && typeof capsule.workspacePath === 'string' && capsule.workspacePath.trim().length > 0
      ? path.resolve(capsule.workspacePath)
      : '';
    const capsuleTimestamp = typeof capsule.updatedAt === 'number' && capsule.updatedAt > 0
      ? capsule.updatedAt
      : (typeof capsule.createdAt === 'number' && capsule.createdAt > 0 ? capsule.createdAt : Date.now());

    // 1. Ensure/register project
    let existingProject: ProjectRecord | undefined;
    try {
      existingProject = registry.getProject(projectId);
    } catch {
      existingProject = undefined;
    }

    if (!existingProject) {
      registry.registerProject({
        id: projectId,
        name: capsule.name || `Project-${projectId}`,
        dataRoot: resolvedDataRoot,
        state: 'open',
        createdAt: capsule.createdAt || capsuleTimestamp,
        updatedAt: capsuleTimestamp,
      });
      registeredProjects++;
    } else {
      // If project exists, keep it open; update if capsule is newer and name changed
      const shouldUpdateProject = existingProject.state !== 'open' ||
        (capsuleTimestamp > existingProject.updatedAt && capsule.name && capsule.name !== existingProject.name);
      if (shouldUpdateProject) {
        registry.registerProject({
          ...existingProject,
          name: capsule.name || existingProject.name,
          state: 'open',
          updatedAt: Math.max(existingProject.updatedAt, capsuleTimestamp),
        });
      }
    }

    // 2. Ensure/register workspace
    const existingWs = registry.findWorkspaceById(workspaceId);
    if (!existingWs) {
      registry.registerWorkspace({
        id: workspaceId,
        projectId,
        rootPath: normalizedRoot,
        state: 'attached',
        createdAt: capsule.createdAt || capsuleTimestamp,
        updatedAt: capsuleTimestamp,
      });
      registeredWorkspaces++;
    } else {
      // Workspace already exists.
      // Idempotency: if root, project, and state match, do nothing.
      const rootMatches = process.platform === 'win32'
        ? existingWs.rootPath.toLowerCase() === normalizedRoot.toLowerCase()
        : existingWs.rootPath === normalizedRoot;

      if (rootMatches && existingWs.projectId === projectId && existingWs.state === 'attached') {
        continue;
      }

      // If roots differ: never overwrite a newer root with an older one!
      if (!rootMatches) {
        if (existingWs.updatedAt > capsuleTimestamp) {
          continue;
        }
      }

      registry.registerWorkspace({
        ...existingWs,
        projectId,
        rootPath: normalizedRoot,
        state: 'attached',
        updatedAt: Math.max(existingWs.updatedAt, capsuleTimestamp),
      });
      registeredWorkspaces++;
    }
  }

  return { registeredProjects, registeredWorkspaces };
}
/**
 * The shell this process opened for itself at launch. It is a convenience pointer
 * for launch-time sequencing (first paint, control-plane warm-up), never a routing
 * authority: every request resolves through the window directory below.
 */
let bootstrapShell: ProjectWindowShell | null = null;
/**
 * Shared services resolve a tab or a sender to its owning project window through
 * this directory. There is deliberately no "first window's host" here: a request
 * that cannot name the window it means is refused rather than served by whichever
 * window happened to be created first.
 */
const tabAuthorities = new TabAuthorityDirectory();
/** Whether an agent still holds a terminal; see `TabAuthorityDirectory.agentHoldsTerminal`. */
function agentHoldsTerminal(terminalId: string): boolean {
  return tabAuthorities.agentHoldsTerminal(terminalId, TerminalManager.getInstance().sessionOwnerKey(terminalId));
}
/**
 * Tab→host routing with the dead-binding degrade contract: an explicit id no live
 * host owns degrades per seam (never the ambient host's answer), an absent id is the
 * only input the ambient host answers, and every refusal carries a typed code.
 * `capsules` is read lazily — capsuleManager is only assigned during boot.
 */
const tabAmbient = new TabAmbientAuthority({
  directory: tabAuthorities,
  capsules: () => capsuleManager?.list() ?? [],
  journal: recordLifecycleEvent,
});

/** Identity this process booted for, recorded when the bootstrap window opens. */
let bootProjectIdValue: string | null = null;
/**
 * The project the singleton 'web' hub currently presents, or null — the replacement for
 * "which project owns this window" now that project windows are retired. The answer is
 * read off the hub's live host (NativeTabHost.activeProject), not kept as parallel
 * state in Main, so it cannot drift from what the window actually shows.
 */
function webHubActiveProjectId(): string | null {
  return hostForOwnerKey('web')?.activeProject() ?? null;
}
/** This app's own surfaces: a launch URL pointing at one is not a page to restore. */
const LOCAL_SURFACE_HOSTS = ['localhost:20128', 'localhost:20129', 'localhost:20130'];

/** A launch-time http(s) argument, when the caller supplied one. */
function launchUrlArgument(argv: readonly string[] = process.argv): string | undefined {
  return argv.find(
    (arg) => (arg.startsWith('http://') || arg.startsWith('https://')) && !LOCAL_SURFACE_HOSTS.some((local) => arg.includes(local)),
  );
}

/** Set once this process has handed its launch URL to the window that opened for it. */
let launchUrlConsumed = false;

/**
 * The launch URL, for the window this process launched for and no other.
 *
 * A launch argument describes the process start, not every window: taking it again for a
 * window opened minutes later would inject a tab for a URL the user passed at launch, in a
 * window that never asked for it.
 */
function consumeLaunchUrlArgument(): string | undefined {
  if (launchUrlConsumed) return undefined;
  const url = launchUrlArgument();
  if (!url) return undefined;
  launchUrlConsumed = true;
  return url;
}

/**
 * Test-only shells merged into the live-shell answer. `node --test` runs never reach
 * `createWindow()` (the Electron stub leaves `app.whenReady()` pending), so paths that
 * distinguish "a window is live" from "its host resolved" could never see the first
 * half. Module export only — unreachable from IPC, MCP or any renderer surface.
 */
const testingShells = new Set<ProjectWindowShell>();

/**
 * Register a shell-like as live (and, when given, its host) so `liveShellFor` /
 * `hostForOwnerKey` answer the same way they would for a real window. Omit the host to
 * model a live window whose host could not be resolved — the state removal must treat
 * as fail-closed rather than as "no window, nothing live to purge under". Returns the
 * unregister the test must run.
 */
export function installShellForTesting(shell: ProjectWindowShell, host?: NativeTabHost): () => void {
  testingShells.add(shell);
  if (host) tabAuthorities.register(shell, host);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    testingShells.delete(shell);
    if (host) tabAuthorities.unregister(shell);
  };
}

/** Live project shells, in the directory's registration order. */
function liveProjectShells(): ProjectWindowShell[] {
  const shells = projectWindows?.listShells() ?? [];
  for (const shell of testingShells) {
    if (!shell.window.isDestroyed()) shells.push(shell);
  }
  return shells;
}

/** The shell whose native window this is, or undefined when no shell owns it. */
function shellForBrowserWindow(window: Electron.BrowserWindow | null | undefined): ProjectWindowShell | undefined {
  if (!window || window.isDestroyed()) return undefined;
  return liveProjectShells().find((shell) => shell.window === window);
}

/** The live shell behind an owner key, or undefined when no window carries it. */
function liveShellFor(ownerKeyValue: string): ProjectWindowShell | undefined {
  return liveProjectShells().find((shell) => ownerKey(shell.owner) === ownerKeyValue);
}

/** Shells whose first-paint presentation is armed and has not run yet (at most 300 ms). */
const shellsAwaitingFirstPaint = new WeakSet<ProjectWindowShell>();

/**
 * Whether a person can see this shell, or is about to: shown (minimized counts — it sits
 * on the taskbar) or armed to show on its first paint. A shell created for agent work is
 * never presented, so a hub an agent reopened stays off-screen until someone opens it.
 */
function shellIsOnScreen(shell: ProjectWindowShell): boolean {
  const win = shell.window;
  if (win.isDestroyed()) return false;
  return win.isVisible() || win.isMinimized() || shellsAwaitingFirstPaint.has(shell);
}

/** The icon this build ships, resolved once for every window. */
let cachedAppIconPath: string | null | undefined;

function appIconPath(): string | undefined {
  if (cachedAppIconPath === undefined) {
    cachedAppIconPath = [
      path.join(__dirname, '..', '..', 'assets', 'icon.png'),
      path.join(process.cwd(), 'assets', 'icon.png'),
    ].find((candidate) => fs.existsSync(candidate)) ?? null;
  }
  return cachedAppIconPath ?? undefined;
}

/** Wire-form owner (contracts) to Main's window owner. An invalid id is refused, never repaired. */
function toWindowOwner(owner: ProjectWindowOwner): WindowOwner {
  return owner.kind === 'project'
    ? { kind: 'project', projectId: validateControlPlaneId(owner.projectId, 'project') }
    : owner.kind === 'web'
      ? { kind: 'web' }
      : { kind: 'unassigned' };
}

/**
 * The validated labels for a window's owner. A project's title and path come from
 * the capsule Main recorded for that project once that record's affiliation
 * validates — never from a page title or a renderer string — and an owner no
 * record describes keeps its stable id as its title with no path, rather than
 * borrowing another project's workspace.
 */
export function resolveWindowRecord(owner: WindowOwner): {
  title: string;
  pathLabel?: string;
  workspacePath?: string;
  capsuleId?: string;
  projectId?: string;
  workspaceId?: string;
} {
  // The web hub is a singleton multi-project surface: it owns no workspace itself
  // (the active project is a host concern, not a window identity), so its record is
  // just the stable product title — the same treatment the Unassigned shell gets.
  if (owner.kind === 'web') return { title: 'AntiFan Browser' };
  if (owner.kind !== 'project') return { title: ownerLabel(owner) };

  // Look for unambiguous matching capsule in capsule store
  // A lone validated record speaks for the project; two records claiming one project is
  // ambiguity, not a choice — until they are reconciled, the window shows its stable id and
  // claims no workspace. A lone record with no well-formed workspace id is the record an open
  // refuses (`uniqueValidatedClaim`), so it may not hand a window a path or a capsule tag the
  // registry never registered: such a project is described by the registry fallback below
  // alone, exactly as if no capsule store existed.
  const capsule = uniqueValidatedClaim(capsuleManager?.list() ?? [], owner.projectId);

  // 1. Registry workspace root (first in fallback order)
  let registryWorkspaceRoot: string | undefined;
  let registryWorkspaceId: string | undefined;
  try {
    const wsList = projectRegistry.listWorkspaces(owner.projectId);
    const attached = wsList.find((w) => w.state === 'attached' && w.rootPath && w.rootPath.trim().length > 0);
    if (attached) {
      registryWorkspaceRoot = attached.rootPath;
      registryWorkspaceId = attached.id;
    }
  } catch {}

  // 2. Affiliated capsule root (second in fallback order)
  // There is no third fallback to the process cwd: an owner no record describes keeps its stable
  // id as its title and claims no workspace (see the docblock above), rather than presenting the
  // application's own launch directory as the project's. Callers that need a working directory
  // still fall back on their own (the initial registry seeding below does exactly that).
  const workspacePath = registryWorkspaceRoot || capsule?.workspacePath;

  // Resolve title: capsule-derived label first, registry project name second, stable id fallback
  let title = owner.projectId;
  if (capsule?.name) {
    title = capsule.name;
  } else {
    try {
      const proj = projectRegistry.getProject(owner.projectId);
      if (proj?.name) title = proj.name;
    } catch {}
  }
  // The built-in browsing window keeps its stable owner key and existing tabs.
  // Only replace the generated label; explicit project/capsule names still win.
  if (owner.projectId === DEFAULT_BOOT_PROJECT_ID
    && (title === owner.projectId || title === `Project-${owner.projectId}`)) {
    title = 'Tổng hợp';
  }

  // Preference order for workspaceId: explicit capsule workspaceId wins, then registry workspaceId
  const workspaceId = capsule?.workspaceId || registryWorkspaceId;

  return {
    title,
    pathLabel: capsule?.workspacePath || workspacePath,
    workspacePath,
    capsuleId: capsule?.id,
    projectId: owner.projectId,
    workspaceId,
  };
}

/**
 * Whether Main holds a validated record for a project: the boot identity, an open
 * registry project, a capsule-claimed explicit project, or a window already open for it.
 * A renderer-supplied id no record carries is refused rather than opened under a
 * name the renderer invented.
 */
/**
 * Whether a project id names one the Manager/picker lists: a validated record
 * (`isKnownProjectId`) OR a registry record still stored after close — the appearance
 * controls the stored sections render must answer to the same ids the inventory shows.
 */
function isListedProjectId(projectId: string): boolean {
  if (isKnownProjectId(projectId)) return true;
  try {
    return Boolean(projectRegistry.getProject(projectId));
  } catch {
    return false;
  }
}

export function isKnownProjectId(projectId: string): boolean {
  if (projectId === bootProjectIdValue) return true;
  // Branch A: Registry open (project exists in shared ProjectRegistry and state is 'open')
  try {
    const project = projectRegistry.getProject(projectId);
    if (project.state === 'open') return true;
  } catch {}
  // Branch B: one capsule claims this project and carries a validated affiliation — the same
  // evidence the synchronizer registers from, so an incomplete record (a persisted 'explicit'
  // marker with no workspace id) cannot authorize an open the registry knows nothing about.
  if (uniqueValidatedClaim(capsuleManager?.list() ?? [], projectId)) return true;
  // Project windows are retired: "a window open for it" is now "the web hub is showing it".
  if (projectId === webHubActiveProjectId()) return true;
  return liveProjectShells().some((shell) => shell.owner.kind === 'project' && shell.owner.projectId === projectId);
}

/**
 * The ports `resolveProjectContext` reads: the live capsule store and the durable registry.
 * Terminal/tab ports stay unset — this resolver only ever answers owner-key and project-id
 * subjects from the two stores.
 */
const projectContextPorts: ProjectContextPorts = {
  capsules: () => capsuleManager?.list() ?? [],
  registry: projectRegistry,
};

/** Resolve transfer ownership from project identity; ambiguous capsule claims never become a capsule-less destination. */
function resolveProjectAssignment(projectId: string): { capsuleId?: string } | undefined {
  if (!isKnownProjectId(projectId)) return undefined;
  const context = resolveProjectContext(projectContextPorts, { kind: 'projectId', projectId });
  if (context.kind !== 'project') return undefined;
  if (context.claim === 'ambiguous' || context.claim === 'invalid') return undefined;
  return context.capsuleId ? { capsuleId: context.capsuleId } : {};
}

/** A terminal click opens in the window that owns that exact session's project, never the focused host. */
async function openTerminalLinkInOwner(ownerKeyValue: string, url: string): Promise<boolean> {
  if (!ownerKeyValue || typeof url !== 'string' || !url) return false;
  let host = hostForOwnerKey(ownerKeyValue);
  if (!host) {
    const parsedOwner = parseOwnerKey(ownerKeyValue);
    // Project windows are retired: a session stamped `project:X` (and the hub's own
    // 'web' key) belongs to the single web hub, which activates that project before
    // the link opens. 'unassigned' keeps its own Terminal Manager shell.
    const shellOwner: WindowOwner | null = parsedOwner.kind === 'project' || parsedOwner.kind === 'web'
      ? { kind: 'web' }
      : parsedOwner.kind === 'unassigned'
        ? { kind: 'unassigned' }
        : null;
    if (!shellOwner) return false;
    if (parsedOwner.kind === 'project' && !isKnownProjectId(parsedOwner.projectId)) return false;
    assertApplicationAdmitsWork(closeReservations, 'Open terminal link owner');
    host = (await ensureProjectWindow(shellOwner, 'user', {
      ...(parsedOwner.kind === 'project' ? { activateProjectId: parsedOwner.projectId } : {}),
    })).host;
  }
  return Boolean(host.createTab(url));
}

/**
 * The host a shared service acts on when the call names neither a tab nor a sender —
 * see TabAmbientAuthority.ambientHostOrThrow; refusals are typed TARGET_REQUIRED.
 */
function ambientHostOrThrow(): NativeTabHost {
  return tabAmbient.ambientHostOrThrow();
}

/**
 * The same host, or null when no window is live — a legitimately empty process rather
 * than an error for callers that only need a window-shaped object for a process-wide
 * derivation.
 */
function sharedServiceHost(): NativeTabHost | null {
  const focused = shellForBrowserWindow(BrowserWindow.getFocusedWindow());
  const shell = focused ?? bootstrapShell ?? liveProjectShells()[0];
  if (shell) {
    const host = tabAuthorities.hostForShell(shell);
    if (host) return host;
  }
  return tabAuthorities.hosts()[0] ?? null;
}

/**
 * A host for a call whose subject is the process, not a window: partition naming,
 * cookie migration, housekeeping, the device-preset catalog. Every live window
 * answers those identically, so any host will do and none is preferred as "the"
 * window; a process with no window has nothing to derive from and refuses.
 */
function sharedServiceHostOrThrow(): NativeTabHost {
  const host = sharedServiceHost();
  if (!host) throw new Error('No project window is live, so no tab host can serve this request');
  return host;
}

/**
 * The project window that owns a tab — see TabAmbientAuthority.hostForTabOrBootstrap.
 * A tab no live window owns refuses TARGET_STALE rather than falling back to the
 * ambient host; only a call carrying no tab id consults it.
 */
function hostForTabOrBootstrap(tabId: string | undefined): NativeTabHost {
  return tabAmbient.hostForTabOrBootstrap(tabId);
}
/**
 * The host for a read/recovery seam, or undefined when the named tab is dead — see
 * TabAmbientAuthority.hostForTabOrDegrade. Callers degrade to the value a live host
 * returns for an unknown id.
 */
function hostForTabOrDegrade(tabId: string | undefined, seam: string): NativeTabHost | undefined {
  return tabAmbient.hostForTabOrDegrade(tabId, seam);
}
let bridgeServer: BridgeServer | null = null;
let windowStateManager: WindowStateManager | null = null;
let controlPlane: ControlPlaneRuntime | null = null;
let browserPort: BrowserControlPort | null = null;
let cockpitPort: CockpitPort | null = null;
let deviceAdapter: IosDeviceAdapter | null = null;
let terminalDaemonInitialized = false;
/** Hosts already given the control plane; attaching twice would re-run its device query. */
const hostsWithControlPlane = new WeakSet<NativeTabHost>();
let profileLease: ProfileLease | null = null;
let runStateService: RunStateService | null = null;
const executionBackends = new Map<string, ExecutionBackend>();
function resolveRunBackend(backendId: string): ExecutionBackend | undefined {
  return executionBackends.get(backendId);
}
export function registerExecutionBackend(backend: ExecutionBackend): void {
  executionBackends.set(backend.id, backend);
}
let localIpcServer: LocalIpcServer | null = null;
// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  const failOnContention = process.env.ANTIFAN_FAIL_ON_LOCK_CONTENTION === '1';
  const exitCode = singleInstanceLockExitCode(gotTheLock, failOnContention);
  console.error(`[antifan] Another instance is already running (${IS_DEV ? 'DEV' : 'PROD'}). Exiting with code ${exitCode}.`);
  app.exit(exitCode ?? 0);
} else {
  app.on('second-instance', (_event, commandLine) => {
    // A second launch is a user action in an already running process: bring the
    // window the user is working in forward and route its URL argument there. Every
    // live shell is a candidate — the focused window is the user's target — and a
    // process with no shell ignores the launch instead of resurrecting a global one.
    const shells = liveProjectShells();
    if (shells.length === 0) return;
    const target = shellForBrowserWindow(BrowserWindow.getFocusedWindow()) ?? shells[0]!;
    if (target.window.isMinimized()) target.window.restore();
    target.window.show();
    target.window.focus();

    const urlArg = launchUrlArgument(commandLine);
    if (urlArg) {
      tabAuthorities.hostForShell(target)?.createTab(urlArg);
    }
  });
}

// Benchmark-mode-only telemetry (ANTIFAN_BENCHMARK=1 / --benchmark). Disabled
// in normal startup; emits startup milestones and event-loop delay samples.
const ownsElectronInstance = app.hasSingleInstanceLock();
const benchmarkStopEventLoop = startEventLoopDelayMonitor();
recordBenchmark({ surface: 'startup', name: 'bootstrap' });
/**
 * Process-type aggregation hides which process actually grew: every renderer is
 * reported as `Tab`, so a window-chrome leak and a page-renderer leak look
 * identical. The per-process rows below keep the PID and attach the role of every
 * WebContents living in that process, which is what makes a memory series
 * attributable (chrome view vs a named tab) instead of anonymous.
 *
 * Two Electron behaviours shape this: `WebContentsView`-backed pages report type
 * `window`, the same type as app chrome, and every `file://` view is one site, so
 * the toolbar, the terminal sidebar and the backdrop share a single renderer
 * process. The app views are therefore named by file and joined when they share a
 * process, rather than being resolved to one arbitrary winner.
 */
function describeLiveWebContentsRoles(): Map<number, { role: string; url: string }> {
  const collected = new Map<number, { roles: string[]; url: string }>();
  // Every project shell's chrome is a 'window' role. With several windows live the
  // per-process row has to name all of them, not one global window that may already
  // be gone: a closed project must not hide its sibling's renderer from the series.
  const chromeWcIds = new Set<number>();
  for (const shell of liveProjectShells()) {
    for (const view of [shell.toolbarView, shell.sidebarView, shell.frameBackdropView]) {
      const chromeWc = view?.webContents;
      if (chromeWc && !chromeWc.isDestroyed()) chromeWcIds.add(chromeWc.id);
    }
  }
  const push = (wc: Electron.WebContents, label: string) => {
    let pid = 0;
    try {
      pid = wc.getOSProcessId();
    } catch {
      return;
    }
    if (!pid) return;
    const entry = collected.get(pid) ?? { roles: [], url: '' };
    if (!entry.roles.includes(label) && entry.roles.length < 4) entry.roles.push(label);
    if (!entry.url) {
      try {
        entry.url = wc.getURL().slice(0, 160);
      } catch {}
    }
    collected.set(pid, entry);
  };
  for (const host of tabAuthorities.hosts()) {
    for (const tab of host.getTabList()) {
      for (const pane of ['desktop', 'mobile'] as const) {
        const wc = host.getTabWebContents(tab.id, pane);
        if (!wc || wc.isDestroyed()) continue;
        push(wc, `tab:${tab.id.slice(0, 8)}${pane === 'mobile' ? ':mobile' : ''}`);
      }
    }
  }
  for (const wc of webContents.getAllWebContents()) {
    if (wc.isDestroyed()) continue;
    if (chromeWcIds.has(wc.id)) {
      push(wc, 'window');
      continue;
    }
    let already = false;
    let pid = 0;
    try {
      pid = wc.getOSProcessId();
      already = pid > 0 && (collected.get(pid)?.roles.length ?? 0) > 0;
    } catch {
      continue;
    }
    if (!pid) continue;
    // A renderer process can host several WebContents (`process-per-site` plus the
    // renderer process limit). A pid already named as a tab page or as the window
    // keeps that name — it is the more specific one. A pid that only carries app
    // chrome views still admits this one, because every `file://` view is one site
    // and the toolbar, the terminal sidebar and the backdrop normally share a single
    // renderer: dropping the later views would label the shared process after
    // whichever view happened to be enumerated first.
    if (already) {
      const existingRoles = collected.get(pid)?.roles ?? [];
      const namedAsTabOrWindow = existingRoles.some((role) => role.startsWith('tab:') || role === 'window');
      if (namedAsTabOrWindow) continue;
    }
    let label = `other:${wc.getType()}`;
    try {
      const file = path.basename(new URL(wc.getURL()).pathname).replace(/\.html?$/i, '');
      if (file && file !== 'blank' && !wc.getURL().startsWith('data:')) label = `chrome:${file}`;
    } catch {}
    push(wc, label);
  }
  const roles = new Map<number, { role: string; url: string }>();
  for (const [pid, entry] of collected) {
    roles.set(pid, { role: entry.roles.join('+') || 'unresolved', url: entry.url });
  }
  return roles;
}

/** Samples Electron app metrics per process type; benchmark mode only. */
function recordProcessMetrics(label: string, withPerProcess = false): void {
  if (!isBenchmarkEnabled()) return;
  try {
    const roles = withPerProcess ? describeLiveWebContentsRoles() : null;
    const appMetrics = app.getAppMetrics();
    const byType: Record<string, { processes: number; workingSetKB: number; privateBytesKB: number }> = {};
    for (const metric of appMetrics) {
      const key = metric.type || 'Unknown';
      const agg = byType[key] ?? (byType[key] = { processes: 0, workingSetKB: 0, privateBytesKB: 0 });
      agg.processes += 1;
      agg.workingSetKB += metric.memory?.workingSetSize ?? 0;
      agg.privateBytesKB += metric.memory?.privateBytes ?? 0;
    }
    const breakdown: Record<string, unknown> = {};
    for (const [type, agg] of Object.entries(byType)) breakdown[type] = agg;
    recordBenchmark({
      surface: 'process',
      name: label,
      extra: {
        breakdown,
        processes: roles
          ? appMetrics.map((metric) => ({
              pid: metric.pid,
              type: metric.type,
              workingSetKB: metric.memory?.workingSetSize ?? 0,
              privateBytesKB: metric.memory?.privateBytes ?? 0,
              role: roles.get(metric.pid)?.role ?? '',
              url: roles.get(metric.pid)?.url ?? '',
            }))
          : undefined,
        mainRssKB: process.memoryUsage().rss / 1024,
      },
    });
  } catch {}
}

/**
 * A soak can run for hours; sampling only at first paint and shutdown leaves the
 * growth between them unobserved per process. One sample per minute, benchmark
 * mode only.
 */
const PROCESS_METRICS_INTERVAL_MS = 60_000;
let processMetricsTimer: NodeJS.Timeout | null = null;
function startProcessMetricsSampling(): void {
  if (!isBenchmarkEnabled() || processMetricsTimer) return;
  processMetricsTimer = setInterval(() => recordProcessMetrics('periodic', true), PROCESS_METRICS_INTERVAL_MS);
  processMetricsTimer.unref?.();
}
function stopProcessMetricsSampling(): void {
  if (!processMetricsTimer) return;
  clearInterval(processMetricsTimer);
  processMetricsTimer = null;
}

/** Per-window wiring outcome. `created` distinguishes a new window from a join. */
interface ProjectWindowRuntime {
  shell: ProjectWindowShell;
  host: NativeTabHost;
  created: boolean;
}

/**
 * Give one window's host the shared services that exist at this moment. Called when
 * a host is created and again when a service it was too early for comes up, so a
 * window opened later is never left without the control plane or the viewport gate.
 */
function attachSharedServices(host: NativeTabHost): void {
  if (controlPlane && !hostsWithControlPlane.has(host)) {
    hostsWithControlPlane.add(host);
    // setControlPlane also re-reads the phone status; the explicit pass after the
    // device surface registers covers hosts that were attached before it existed.
    host.setControlPlane(controlPlane);
  }
  if (browserPort) host.setViewportGate(browserPort.viewportGate);
  // The terminal hand-over needs one fact this host cannot compute for itself: whether the
  // window a row is being moved to currently exists. Main owns that directory, so it is read
  // through this seam — the same shape as the close reservations above — and never by opening
  // a window from the tab host.
  host.setOwnerWindowPresence((ownerKeyValue) => liveShellFor(ownerKeyValue) !== undefined);
  // An `agent:` row is the agent's only while some tab still holds it, and the tab may sit in any
  // window, so the answer is Main's directory-wide one rather than this host's own tabs.
  host.setAgentTerminalHold(agentHoldsTerminal);
  host.setProjectAssignmentResolver(resolveProjectAssignment);
  host.setTerminalLinkOpener(openTerminalLinkInOwner);
  host.setSpaceWindowOpener(openSpaceWindow);
  if (runStateService) {
    host.setRunStateService(runStateService);
  }
  host.setRunBackendResolver(resolveRunBackend);
}

/**
 * The one close-admission table for the whole process, shared by every consumer that can
 * bind a page or admit work onto one (see `setCloseAdmission` on the tab host, the
 * attachment registry, the capability transport and the browser-control port). One
 * instance is what makes a reservation mean something: a page inside an async close
 * window refuses new bindings and new work from every path, and the operations those
 * paths admitted are what the close gate measures instead of guessing.
 */
const closeReservations = new PageCloseReservations();
/** Last close report per owner key, so the live probe can read the shipping path's own words. */
const lastCloseReports = new Map<string, CloseReport>();
/** Last coordinated quit report, for the same reason. */
let lastQuitReport: QuitReport | null = null;

/** The project window that presents this page, or undefined when no live host owns it. */
function ownerKeyOfPage(tabId: string): string | undefined {
  const owner = tabAuthorities.hostForTab(tabId)?.windowOwnerKey();
  return owner && owner.length > 0 ? owner : undefined;
}

/**
 * Destroy exactly one page through the host that presents it. `unknown` is the honest
 * answer for a page no live host claims: there is no terminator to ask, and a close
 * attempt must not read that silence as success.
 */
function closePageInOwningHost(tabId: string, force = false): Promise<PageCloseOutcome> {
  const host = tabAuthorities.hostForTab(tabId);
  if (!host) return Promise.resolve('unknown');
  return host.closePage(tabId, force);
}

/**
 * The auxiliary windows an application quit must also close: one host's terminal windows
 * (the sidebar popout and any extra workbench window). They are not project shells — no
 * project snapshot claims them — but they are the user's own windows, so an orderly quit
 * closes them and honours a veto in one instead of tearing services down underneath it.
 *
 * They are found through the host's own surface lookup, never a window census by title:
 * a webContents a live host answers `terminalPopout` for is a terminal window that host
 * owns. Capture hosts are deliberately absent — they are non-closable capture windows
 * whose views belong to a host, and destroying that host is what destroys them, which the
 * committed shutdown already does.
 */
function terminalWindowCloseSurfaces(): CloseSurface[] {
  const surfaces: CloseSurface[] = [];
  const seen = new Set<number>();
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    let isTerminalWindow = false;
    for (const host of tabAuthorities.hosts()) {
      try {
        if (host.surfaceForWebContents(contents.id) === 'terminalPopout') {
          isTerminalWindow = true;
          break;
        }
      } catch {
        // A host that cannot answer for this webContents is not evidence that it owns it.
      }
    }
    if (!isTerminalWindow) {
      // No live host can answer for a window that outlived its own host's disposal, and the
      // last browser shell closing is exactly when that happens: the process-wide registry
      // is the only remaining answer, so a committed quit still reaches the window instead
      // of leaving it alive behind the gate.
      isTerminalWindow = isUnhostedTerminalWindow(contents.id);
    }
    if (!isTerminalWindow) continue;
    const window = BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed() || seen.has(window.id)) continue;
    seen.add(window.id);
    surfaces.push({
      key: `terminal-window:${window.id}`,
      kind: 'auxiliary',
      visibleMemberIds: () => [],
      closeSelf: () => closeAuxiliaryWindow(window),
    });
  }
  return surfaces;
}

/**
 * Every closable surface, in order: the browser shells the window manager knows, then the
 * auxiliary terminal windows. Counting and closing both come from here, never from
 * `BrowserWindow.getAllWindows()` — a capture host or a terminal window must not be
 * mistaken for a project window, and a project window must not be missed because it is
 * not the first one created.
 */
function listApplicationCloseSurfaces(): CloseSurface[] {
  const shells = projectWindows ? projectWindows.listCloseSurfaces().map(withHostMembers) : [];
  return [...shells, ...terminalWindowCloseSurfaces()];
}

/** The host that presents a shell's pages, by owner key; null once that window is gone. */
function hostForOwnerKey(ownerKeyValue: string): NativeTabHost | null {
  const shell = liveShellFor(ownerKeyValue);
  return shell ? tabAuthorities.hostForShell(shell) ?? null : null;
}

/**
 * The live pages a close attempt must check, reserve and destroy for one browser shell.
 *
 * The member list is read from the hosting tab authority — the same source `ownerOfPage`,
 * the page-close path and the tab directory use — because under-reporting is the dangerous
 * direction: a shell whose members read empty would close while its pages were never
 * busy-checked, never reserved, and never closed. A host that has no pages yet answers with
 * its own (empty) list, and a host that is already gone falls back to the surface's list so
 * the attempt still reports the pages it can no longer ask for.
 */
function withHostMembers(surface: CloseSurface): CloseSurface {
  if (surface.kind !== 'browser') return surface;
  const wrapped: CloseSurface = {
    ...surface,
    visibleMemberIds: () => hostForOwnerKey(surface.key)?.visibleMemberTabIds() ?? surface.visibleMemberIds(),
  };
  // Detached-lifecycle parking: only `project:` owner records carry foldable rows, so
  // only their surfaces arm the snapshot. The hook throws when the host is gone —
  // an unparked project close would lose its rows, so the attempt must refuse.
  if (surface.key.startsWith('project:')) {
    wrapped.parkTabsForClose = () => {
      const live = hostForOwnerKey(surface.key);
      if (!live) throw new Error(`no live host for ${surface.key}; its rows cannot be parked`);
      live.parkPersistDataForClose();
    };
    wrapped.releaseParkedTabs = () => {
      try { hostForOwnerKey(surface.key)?.releaseParkedPersistData(); } catch {}
    };
  }
  return wrapped;
}

/** One browser shell, as the close path must see it (see `withHostMembers`). */
function browserCloseSurfaceFor(ownerKeyValue: string): CloseSurface | undefined {
  const surface = projectWindows?.closeSurfaceForOwner(ownerKeyValue);
  return surface ? withHostMembers(surface) : undefined;
}

/**
 * Enumerate every run the control plane knows for close live-use evidence.
 *
 * Runs are stored in the run service. Because the run service's public API indexes runs
 * by project id (`listRuns(projectId: string)`), simply iterating `plane.projects.listProjects()`
 * misses any run whose project was removed from the registry (an orphaned run).
 *
 * Rather than fabricating completeness, we actively detect unverified/orphaned runs:
 * 1. Collect all runs for registered projects.
 * 2. Check active attachments for any runId not enumerated under registered projects.
 * 3. Check the internal run store (if present at runtime) for any run whose projectId is unlisted.
 *
 * If an orphaned run is found (its project is absent from the project registry), its lifecycle
 * cannot be verified or managed through the project UI; it is reported with state 'unknown' so
 * close/quit refuses with `cannotTell` rather than silently folding an orphaned run into idle.
 */
export function enumerateCloseLiveUseRuns(plane: ControlPlaneRuntime): CloseLiveUseRun[] {
  const runs: CloseLiveUseRun[] = [];
  const seenRunIds = new Set<string>();
  const registeredProjectIds = new Set<string>();

  for (const project of plane.projects.listProjects()) {
    registeredProjectIds.add(project.id);
    for (const run of plane.runs.listRuns(project.id)) {
      runs.push({ runId: run.id, state: run.state });
      seenRunIds.add(run.id);
    }
  }

  // Check active attachments for orphaned runs (e.g. project was removed from registry)
  const registry = plane.runs.attachments;
  const now = Date.now();
  for (const attachmentId of registry.getActiveRecordIds()) {
    const record = registry.getRecord(attachmentId);
    if (!record?.runId || seenRunIds.has(record.runId)) continue;
    // The id set retains revoked and expired records for audit. Only a binding that can still
    // dispatch stands for live work: a record that is no longer active cannot be doing any, and
    // treating it as evidence made a dead attachment refuse every quit for the whole retention
    // window.
    if (record.state !== 'active' || (typeof record.expiresAt === 'number' && record.expiresAt <= now)) continue;

    // MCP transport attachments (backendId === 'mcp' or 'omp') mint an attachment with a synthetic runId
    // for authority/lineage but do not run project workflows in RunService.runs. They are NOT orphaned runs.
    if (record.backendId === 'mcp' || record.backendId === 'omp') continue;

    seenRunIds.add(record.runId);

    // This runId is active in attachments but was not listed under registered projects.
    // An orphaned run cannot be verified through registered projects, so its state is reported
    // outside the run vocabulary: the close gate refuses on a state it cannot interpret.
    runs.push({ runId: record.runId, state: ORPHANED_RUN_STATE });
  }

  // Check internal run service map at runtime for any unlisted orphaned runs
  const runStore: unknown = plane.runs;
  if (runStore && typeof runStore === 'object' && 'runs' in runStore) {
    const rawRuns = runStore.runs;
    if (rawRuns instanceof Map) {
      for (const run of rawRuns.values()) {
        if (run && typeof run === 'object' && 'id' in run && typeof run.id === 'string' && !seenRunIds.has(run.id)) {
          seenRunIds.add(run.id);
          const projectId = 'projectId' in run && typeof run.projectId === 'string' ? run.projectId : '';
          const state = 'state' in run && typeof run.state === 'string' ? run.state : ORPHANED_RUN_STATE;
          if (!registeredProjectIds.has(projectId)) {
            runs.push({ runId: run.id, state: ORPHANED_RUN_STATE });
          } else {
            runs.push({ runId: run.id, state });
          }
        }
      }
    }
  }

  return runs;
}

/**
 * The live-use port (see `close-live-use`): raw reads from the owners that decide whether
 * shared work is active. Nothing here interprets the answer — a throw from any of these
 * becomes `unknown` there, and unknown refuses.
 */
const closeLiveUsePort: CloseLiveUsePort = {
  // The admission table itself, not a snapshot: the module composes the process-wide count
  // for an application question and the attributed counts for a shell or page question —
  // per page, and per owner key for work a window's chrome asked for without naming a page —
  // so neither attributed read can be dropped here (a wiring that supplied only the pools
  // answered `idle` under an admitted dispatch).
  admission: () => closeReservations,
  operationCounters: () => {
    if (!browserPort) {
      throw new Error('the browser control port is not initialized');
    }
    return { pools: browserPort.passivePool, waits: browserPort.waitRegistry };
  },
  ledgerInFlight: () => (controlPlane ? controlPlane.ledger.getStats().inFlightCount : null),
  runs: () => {
    const plane = controlPlane;
    if (!plane) {
      throw new Error('the control plane runtime is not initialized');
    }
    return enumerateCloseLiveUseRuns(plane);
  },
  attachments: () => {
    const plane = controlPlane;
    if (!plane) {
      throw new Error('the control plane runtime is not initialized');
    }
    const registry = plane.runs.attachments;
    const records: CloseLiveUseAttachmentRecord[] = [];
    for (const attachmentId of registry.getActiveRecordIds()) {
      const record = registry.getRecord(attachmentId);
      if (!record) continue;
      records.push({
        id: record.id,
        state: record.state,
        expiresAt: record.expiresAt,
        runId: record.runId,
        tabId: record.tabId,
        browserTarget: record.browserTarget ? { tabId: record.browserTarget.tabId } : undefined,
        backendId: record.backendId,
      });
    }
    // Reclaim and lease rules live in the projection (and are tested against it), so this
    // read cannot drift from the evidence module's own contract; `ownerOfPage` supplies the
    // presentation owner a binding on a member page is scoped by.
    return projectLiveUseAttachments(records, Date.now(), (tabId) => ownerKeyOfPage(tabId));
  },
  affinities: () => {
    const affinities: CloseLiveUseAffinity[] = [];
    for (const host of tabAuthorities.hosts()) {
      const owner = host.windowOwnerKey() || undefined;
      for (const [terminalId, info] of Object.entries(host.buildTerminalAffinityMap())) {
        const tabIds = [info.tabId, info.primaryTabId, ...(info.managedTabIds ?? [])].filter(
          (tabId): tabId is string => typeof tabId === 'string' && tabId.length > 0
        );
        affinities.push({ terminalId, status: info.status, tabIds: [...new Set(tabIds)], ...(owner ? { ownerKey: owner } : {}) });
      }
    }
    return affinities;
  },
  terminalState: (): CloseLiveUseTerminalState => {
    if (process.env.ANTIFAN_USE_TERMINAL_DAEMON !== '0' && !terminalDaemonInitialized) {
      return { available: false, detail: 'the terminal host daemon connection has not settled' };
    }
    const terminal = TerminalManager.getInstance();
    const candidate: unknown = terminal;
    if (!candidate || typeof candidate !== 'object') {
      return { available: false, detail: 'the terminal manager is unavailable' };
    }
    if ('isDisposed' in candidate && candidate.isDisposed === true) {
      return { available: false, detail: 'the terminal manager is disposed' };
    }
    if ('client' in candidate && candidate.client && typeof candidate.client === 'object' && 'connected' in candidate.client) {
      if (candidate.client.connected !== true) {
        return { available: false, detail: 'the terminal host daemon is not connected' };
      }
    } else if (candidate instanceof DaemonTerminalProxy) {
      return { available: false, detail: 'the terminal host daemon is not connected' };
    }
    try {
      const raw = terminal.listSessions();
      if (!Array.isArray(raw)) {
        return { available: false, detail: 'the terminal manager did not return a session list' };
      }
      const sessions = (raw as Array<{ id?: unknown; state?: unknown }>).map((session) => ({
        id: typeof session?.id === 'string' ? session.id : '',
        ...(typeof session?.state === 'string' ? { state: session.state } : {}),
      }));
      return { available: true, sessions };
    } catch (err) {
      return {
        available: false,
        detail: `the terminal session list could not be read: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/**
 * Release every binding whose owner provably cannot come back, before live use is measured.
 *
 * The close gate reads liveness from the attachment registry, so an agent that crashed or
 * exited without ending its session would otherwise leave its page busy until the lease
 * deadline: a refusal whose only stop control is the client that died. The registry's own
 * release is the reachable route — it revokes a record whose `boundPid` is dead and marks
 * one whose deadline passed, the same durable mutation `antifan.cli.endSession` performs —
 * and a binding whose owner is still alive or unreadable keeps holding its page, which is
 * the fail-closed direction.
 *
 * A failed sweep changes nothing about the answer: the measurement below still runs, and an
 * attachment that is still active keeps refusing the close.
 */
async function releaseGoneOwnerBindings(): Promise<void> {
  const registry = controlPlane?.runs.attachments;
  if (!registry) return;
  try {
    const released = await registry.revokeGoneOwnerAttachments();
    if (released.revoked.length > 0 || released.expired.length > 0) {
      recordLifecycleEvent('close-live-use.gone-owner-release', {
        revoked: released.revoked.length,
        expired: released.expired.length,
        retained: released.retained,
      });
    }
  } catch (err) {
    recordLifecycleEvent('close-live-use.gone-owner-release.failed', { detail: String(err) });
  }
}

/** One authoritative read (see `close-live-use`), classified into idle / busy / unknown. */
async function readLiveUse(request: LiveUseRequest): Promise<LiveUseReport> {
  await releaseGoneOwnerBindings();
  // A run whose owner process is gone can never call endSession again: without
  // this reap it would report 'streaming' to every close/quit question forever.
  try {
    const reaped = controlPlane?.runs.reapGoneOwnerRuns?.();
    if (reaped && reaped.interrupted.length > 0) {
      recordLifecycleEvent('close-live-use.gone-owner-runs', { interrupted: reaped.interrupted.length });
    }
  } catch (err) {
    recordLifecycleEvent('close-live-use.gone-owner-runs.failed', { detail: String(err) });
  }
  return collectCloseLiveUse(request, closeLiveUsePort);
}

/**
 * The one close coordinator for the whole process. Its dependencies are the real system:
 * the windows that exist, the host that owns a page, the live-use owners above, and the
 * existing ordered teardown. The state machine itself is the coordinator's; nothing here
 * re-implements it.
 */
const closeCoordinator = new ProjectCloseCoordinator({
  reservations: closeReservations,
  listSurfaces: () => listApplicationCloseSurfaces(),
  surfaceForOwner: (target) => browserCloseSurfaceFor(target),
  ownerOfPage: (tabId) => ownerKeyOfPage(tabId),
  closePage: (tabId, force) => closePageInOwningHost(tabId, force),
  queryLiveUse: (request) => readLiveUse(request),
  commitShutdown: () => shutdown(),
});

/**
 * The one surface a refused close or quit reaches. It is presentation only: the decision was
 * already made by the coordinator above, and a delivery that fails changes neither the
 * outcome nor the windows (see `close-refusal-notice`).
 *
 * A shell's chrome is addressed through the same guard every other Main→chrome send uses, so
 * a crashed or already-destroyed toolbar answers `false` instead of throwing — that answer is
 * what lets the quit path notice it has no chrome left to explain itself in.
 */
const closeRefusalPresentation: CloseRefusalPresentationPort = {
  // Only a shell someone can see may carry the reason; a hub an agent reopened off-screen
  // would swallow it, and a quit with nothing on screen falls through to the dialog.
  surfaces: () =>
    liveProjectShells().filter(shellIsOnScreen).map((shell) => ({
      ownerKey: ownerKey(shell.owner),
      send: (notice) =>
        safeSendWebContents(shell.toolbarView?.webContents, PROJECT_WINDOW_CHANNELS.CLOSE_REFUSED, notice),
    })),
  // The one focus-affecting step in the path, and only because it is the last one: the user
  // asked to quit, no browser shell survived to show the reason, and a native dialog is the
  // only remaining way to say why the application is still here. It offers no way past the
  // refusal — one acknowledgement button, no force-quit option.
  showDialog: (notice) =>
    dialog
      .showMessageBox({
        type: 'warning',
        title: 'AntiFan could not quit',
        message: notice.summary,
        detail: notice.reasons
          .map((reason) => {
            const scope = reason.tabId === undefined ? '' : ` [${reason.tabId}]`;
            const guidance = reason.controls.map((control) => control.label).join(' ');
            return guidance.length === 0 ? `${reason.detail}${scope}` : `${reason.detail}${scope}\n→ ${guidance}`;
          })
          .join('\n\n'),
        buttons: ['OK'],
      })
      .then(() => undefined),
  journal: recordLifecycleEvent,
};

/** Journal one close outcome and keep it for the probe surface. */
function recordCloseReport(report: CloseReport): void {
  lastCloseReports.set(report.ownerKey, report);
  if (report.disposition === 'closed') {
    recordLifecycleEvent('window-close.closed', {
      owner: report.ownerKey,
      closed: report.closed.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
      lastBrowserShellGone: report.lastBrowserShellGone,
    });
    return;
  }
  recordLifecycleEvent('window-close.incomplete', {
    owner: report.ownerKey,
    haltedBy: report.haltedBy,
    partial: report.partial,
    closed: report.closed.length,
    skipped: report.skipped.length,
    failed: report.failed.length,
    refusals: report.refusals.map((refusal) => refusal.code).join(','),
  });
  console.warn(`[antifan] ${report.summary}`);
  // The shell stayed open, so it is the surface that has to explain itself: the refusal goes
  // to its own chrome and to no other window. A close nobody asked to quit never takes focus.
  presentCloseRefusal(report, 'close', closeRefusalPresentation);
}

/**
 * Route one user close request through the coordinator. The shell already prevented its own
 * native close synchronously, so the decision may take as long as the pages need: the
 * attempt reserves every member page before it awaits anything, and a refusal leaves all of
 * them — and every service — exactly as they were.
 */
function requestShellClose(shell: ProjectWindowShell): void {
  const key = ownerKey(shell.owner);
  closeCoordinator.attemptClose(key, 'user').then(recordCloseReport, (err) => {
    recordLifecycleEvent('window-close.failed', { owner: key, detail: String(err) });
    console.warn(`[antifan] Closing window '${key}' failed:`, err);
  });
}

/**
 * The one application-quit gate. Every entry — an explicit Quit, the last browser shell
 * going away, `window-all-closed` — comes through here, so repeated requests coalesce into
 * the single in-flight attempt instead of racing each other. Services are torn down only
 * after every native closure succeeded; a refusal or a late veto keeps them and releases
 * its reservations, which is what makes a retry work.
 */
function requestApplicationQuit(origin: string): void {
  if (closeCoordinator.hasCommittedShutdown()) return;
  recordLifecycleEvent('quit.requested', { origin, applicationPhase: closeCoordinator.applicationPhase() });
  closeCoordinator.attemptQuit().then(
    (report) => {
      lastQuitReport = report;
      recordLifecycleEvent('quit.outcome', {
        origin,
        shutdown: report.shutdown,
        phase: report.phase,
        haltedBy: report.haltedBy,
        closedShells: report.closedShells.length,
        survivingShells: report.survivingShells.length,
        auxiliaries: report.auxiliaries.length,
        coalescedRequests: report.coalescedRequests,
        ...(report.commitError ? { commitError: report.commitError } : {}),
      });
      if (report.shutdown !== 'committed') {
        console.warn(`[antifan] ${report.summary}`, report.refusals.map((refusal) => refusal.detail).join(' '));
        // A refused quit keeps the process, so it must also keep a window to come back to: a
        // hub an agent reopened off-screen holds the very work that refused, and the controls
        // that stop it live in its chrome. It is presented before the notice is delivered, so
        // the reason lands in that chrome rather than in a dialog over an empty screen.
        revealOffScreenShells(origin);
        // A refused quit is the user's own request being refused, and it has to be visible
        // wherever they are looking: every browser shell gets the reason. A halt with no
        // refusal (for example a failed commit) still has a summary worth showing, so the
        // notice is delivered whenever there is something to explain.
        if (report.refusals.length > 0 || report.haltedBy !== null) {
          presentCloseRefusal(report, 'quit', closeRefusalPresentation);
        }
        return;
      }
      // Every native closure succeeded and the ordered teardown resolved, so the quit is
      // the platform's to carry out now: the guarded `before-quit` lets this one through.
      // The last-resort bound is armed first: from here this process has no window left to
      // report anything, and a platform that never delivers the quit would strand it.
      armForceExitWatchdog('committed quit did not end the process within 2000ms');
      app.quit();
    },
    (err) => {
      recordLifecycleEvent('quit.failed', { origin, detail: String(err) });
      console.warn('[antifan] Coordinated quit failed:', err);
    }
  );
}

/**
 * Present every live shell when none is on screen. Only a refused quit calls this: the user
 * closed their last visible window, the process could not end, and an off-screen shell is the
 * only place left that shows what is still running.
 */
function revealOffScreenShells(origin: string): void {
  // The window directory presents only shells it owns; a shell it never registered has no
  // owner record to present through.
  const shells = projectWindows?.listShells() ?? [];
  if (shells.length === 0 || liveProjectShells().some(shellIsOnScreen)) return;
  for (const shell of shells) {
    recordLifecycleEvent('quit.refused.shell-revealed', { origin, owner: ownerKey(shell.owner) });
    void projectWindows?.ensureWindow(shell.owner, 'user');
  }
}

/**
 * A shell the platform destroyed. Unregistering first means a message from its dying
 * renderers can never be routed again, and its host is disposed with the shell, which
 * persists that owner's tabs. Whether the process may now end is not decided here: only the
 * coordinator authorises destruction, so this reports the last-browser-shell fact and asks
 * the same gate for an orderly quit — refused there while shared work is active or unknown,
 * and coalesced with a quit that is already running.
 */
function handleShellClosed(shell: ProjectWindowShell): void {
  if (bootstrapShell === shell) bootstrapShell = null;
  projectWindows?.notifyShellGone(shell.owner);
  // Electron fires `closed` before `window-all-closed`, so the keep-alive there never
  // gets its turn: a benchmark run that loses its window — to an incidental close, a
  // renderer crash or an OS action — would still shut down here and discard the whole
  // measurement. The run owns its process, so it records the loss and keeps going; a
  // run that finishes windowless is a finding for the report, not a reason to lose it.
  if (refusesWindowClose() && !isShuttingDown) {
    recordLifecycleEvent('window-closed.ignored', { reason: 'benchmark keep-alive' });
    console.warn('[antifan] Benchmark mode: main window closed; the run continues without a window.');
    return;
  }
  const remaining = projectWindows?.browserShellCount() ?? 0;
  // Only a window someone can see keeps the application running. A hub an agent reopened
  // off-screen is still a browser shell, but closing the last visible window is the user
  // ending the session: it must not leave a process with no window to come back to.
  if (remaining > 0 && liveProjectShells().some(shellIsOnScreen)) {
    recordLifecycleEvent('window-closed.siblings-live', { remaining, owner: ownerKey(shell.owner) });
    return;
  }
  recordLifecycleEvent('window-closed.last-browser-shell', {
    owner: ownerKey(shell.owner),
    ...(remaining > 0 ? { offScreenShells: remaining } : {}),
  });
  requestApplicationQuit('last-browser-shell-closed');
}

/**
 * Per-shell lifecycle. There is no global window: every shell carries its own close request
 * and its own close gate, so what happens to the process is decided by how many browser
 * shells are left rather than by which one happened to be created first.
 */
function attachShellLifecycle(shell: ProjectWindowShell): void {
  shell.onCloseRequest(() => {
    // A benchmark run owns its windows (see `refusesWindowClose`): an incidental close
    // would end the measurement and destroy the tabs it was measuring, so the request is
    // refused rather than honoured.
    if (refusesWindowClose() && !isShuttingDown) {
      recordLifecycleEvent('window-close.refused', { reason: 'benchmark run owns the window', owner: ownerKey(shell.owner) });
      console.warn(`[antifan] Benchmark mode: window close refused; the run owns it (set ${BENCHMARK_ALLOW_WINDOW_CLOSE_ENV}=1 to override).`);
      return;
    }
    // The shell prevented its own native close before this listener ran (see
    // project-window-shell), so from here the coordinator owns the decision and the
    // attempt's own single-use authorisation is the only gate that may carry it out.
    requestShellClose(shell);
  });
  shell.window.on('closed', () => { handleShellClosed(shell); });
}

/**
 * The ONLY path that creates a browser shell — the singleton 'web' hub or the
 * 'unassigned' Terminal Manager. Project owners are normalised to the 'web' shell
 * (see the routing below); `kind:'project'` windows are never admitted anymore.
 *
 * The startup bootstrap and 'antifan:project:open' both come through here, so a
 * window opened later is wired exactly like the first one: its own NativeTabHost
 * registered with the window directory (which is what makes its tabs routable), its
 * own owner-keyed placement and saved tabs, and its own close gate. A path that
 * created only a shell would leave a window whose tabs nothing could resolve.
 *
 * A creation with user intent is also presented here, on its first paint, because
 * construction never presents. `onFirstPresented` reports that moment to the one caller that
 * measures it; arming the presentation here rather than beside it is what keeps a single
 * presenter per window, and the caller's marker exactly once.
 */
async function ensureProjectWindow(
  owner: WindowOwner,
  intent: OpenIntent,
  options?: { onFirstPresented?: () => void; activateProjectId?: string },
): Promise<ProjectWindowRuntime> {
  const manager = projectWindows;
  if (!manager) throw new Error('The project window manager is not up yet');

  // Phương án A: project windows are retired. Any caller still naming a project
  // owner is routed to the single 'web' hub shell, and the project becomes the
  // hub's active project instead of a window identity. `activateProjectId` lets a
  // caller that already holds the 'web' owner say which project the hub is for.
  const requestedProjectId = owner.kind === 'project' ? owner.projectId : undefined;
  const activateProjectId = options?.activateProjectId ?? requestedProjectId;
  const shellOwner: WindowOwner = owner.kind === 'project' ? { kind: 'web' } : owner;

  if (activateProjectId !== undefined && capsuleManager) {
    synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  }

  const shell = await manager.ensureWindow(shellOwner, intent);
  // A join — a duplicate open, or a second caller racing the first — already owns its
  // host. Only the creation path wires one, and it does so with no await between the
  // check and the registration, so two callers cannot both build a host for one shell.
  const existingHost = tabAuthorities.hostForShell(shell);
  if (existingHost) {
    // Joining the hub still switches which project it is showing: the window is
    // shared, the active project is not.
    if (activateProjectId) activateWebHubProject(existingHost, activateProjectId);
    return { shell, host: existingHost, created: false };
  }

  // A window the user asked for must be shown; the manager only presents a shell it joins, and
  // construction never presents, so a creation with no presenter would leave the window alive,
  // answering its chrome and invisible. Agent intent is excluded: nothing here may raise a window
  // a caller created for work the user did not request. `restore` presents unfocused — the boot
  // leg's shells surface without stealing focus.
  if (intent === 'user' || intent === 'restore') {
    presentShellOnFirstPaint(shell, options?.onFirstPresented, intent === 'restore' ? 'unfocused' : 'focused');
  }

  const host = new NativeTabHost(shell, capsuleManager || undefined);
  // The reservation table, before the host can restore or create a single page: a tab
  // created inside an async close window would otherwise exist for exactly as long as it
  // takes the attempt to destroy its window.
  host.setCloseAdmission(closeReservations);
  host.setOpenTerminalManagerHandler(() => { void openSharedTerminalManagerWindow(); });
  tabAuthorities.register(shell, host);
  // Every host's detached-shell liveness answers come from the directory — the hub's
  // assign-project row exception consults it before it may move a `project:` row.
  host.setDetachedShellProbe((id) => {
    const candidate = liveProjectShells().find((shell) => shell.owner.kind === 'project' && shell.owner.projectId === id);
    return candidate !== undefined && !candidate.window.isDestroyed();
  });
  recordBenchmark({ surface: 'startup', name: 'tabHostCtor' });
  // The hub's active project — identity, workspace affiliation and initial
  // workspace seeding — is established before any tab is restored, so restored
  // or minted tabs never see the hub under a different (or no) project. A
  // detached-mode project is the exception: `activateWebHubProject` would fire
  // the detached-shell recreation FOCUSED mid-boot (spending the ≤1 focus
  // budget on the wrong window, before the boot leg's unfocused restore can
  // run) and then throw — a fatal failure for `createWindow` when the BOOT
  // project itself is marked detached. Skipping here leaves the hub unscoped
  // and lets the boot leg own the restore, unfocused.
  if (activateProjectId) {
    const activatesDetached = !reattachInProgress.has(activateProjectId)
      && (liveProjectShells().some((s) => s.owner.kind === 'project' && s.owner.projectId === activateProjectId)
        || savedTabsOwnerIsDetached(savedTabsFilePath(), activateProjectId));
    if (activatesDetached) {
      recordLifecycleEvent('boot.hub-activation-skipped-detached', { projectId: activateProjectId });
    } else {
      activateWebHubProject(host, activateProjectId);
    }
  }

  windowStateManager?.manage(shell.window, ownerKey(shell.owner));
  attachShellLifecycle(shell);
  // Restore this owner's tabs immediately so pages start loading and the layout is
  // established. Saved tabs are owner-scoped, so a new window can never inherit another
  // window's pages; the launch URL is consumed once for the same reason — it belongs to the
  // window this process launched for, not to every window opened afterwards.
  host.restoreTabs(consumeLaunchUrlArgument());
  recordBenchmark({ surface: 'startup', name: 'tabsRestored' });
  attachSharedServices(host);
  // The bridge answers unattributed requests from the hub's host. A hub reopened after a
  // close is a new host, and the one the bridge was built with is disposed.
  if (ownerKey(shell.owner) === 'web') bridgeServer?.setTabHost(host);
  return { shell, host, created: true };
}

/**
 * Point the web hub at one project: the host's active-project state, its terminal
 * workspace affiliation, and the initial-workspace seeding a project window used to
 * do for itself. A project with no verified workspace clears the affiliation rather
 * than inheriting the previous project's — a hub's terminals never belong to another
 * project's directory.
 */
function activateWebHubProject(host: NativeTabHost, projectId: string): void {
  // The seams a scoped hub needs before any project work runs: the descriptor
  // resolver the identity and the restore-path validation read, and the delegate a
  // user-plane activation of a foreign-stamped tab reports back through — this
  // same path, so a flip and a picked switch are the one authority. Idempotent,
  // so the boot call and every later flip re-assert it.
  host.setWebHubProjectDescriptorResolver((id) => {
    if (!isKnownProjectId(id)) return undefined;
    const descriptor = resolveWindowRecord({ kind: 'project', projectId: id });
    return { title: descriptor.title, ...(descriptor.pathLabel ? { pathLabel: descriptor.pathLabel } : {}) };
  });
  host.setForeignProjectActivatedHandler((id) => { activateWebHubProject(host, id); });
  // Exclusivity, enforced at the funnel: `openProjectWindow` hoists the detached check
  // over the web route, and the detach path itself never calls this — but every OTHER
  // way a project can be presented (restored capsule activation, annotation routing,
  // `antifan:project:open` still points at the hub while detached) funnels through
  // here. A `project:<id>` scope cannot be presented by the hub while that owner is
  // detached: a live shell gets the focus, a dead-but-marked one is recreated through
  // the same detach path the menu drives.
  const detachedShell = liveProjectShells().find((s) => s.owner.kind === 'project' && s.owner.projectId === projectId);
  // The reattach latch extends this exclusivity, never replaces it: a project MID-
  // reattach is still marked on disk until the fold lands, but recreating its shell
  // here would resurrect the window the reattach is closing. The latch routes the
  // request to the hub path instead.
  const detachedMode = !reattachInProgress.has(projectId)
    && (detachedShell !== undefined || savedTabsOwnerIsDetached(savedTabsFilePath(), projectId));
  if (detachedMode) {
    void ensureDetachedProjectShell(projectId, 'user')
      .then(({ shell }) => focusShellWindow(shell))
      .catch((err) => console.warn('[antifan] detached-shell presentation refused:', err));
    throw new CapabilityError(
      'TRANSACTION_CONFLICT',
      `Project '${projectId}' is presented by its detached window`,
      { projectId },
    );
  }
  const record = resolveWindowRecord({ kind: 'project', projectId });
  if (record.workspacePath) {
    // This window's terminals belong to the active project's verified workspace.
    // The host refuses a path it cannot verify and keeps the PREVIOUS association — so a
    // refused set must be followed by an explicit clear, otherwise terminals minted under
    // the new project run in the old project's directory with its provenance stamp.
    if (!host.setWindowWorkspaceAffiliation({
      workspacePath: record.workspacePath,
      ...(record.capsuleId ? { capsuleId: record.capsuleId } : {}),
    })) {
      host.setWindowWorkspaceAffiliation(null);
    }
  } else {
    host.setWindowWorkspaceAffiliation(null);
  }
  const targetWorkspaceId = record.workspaceId || projectRegistry.listWorkspaces(projectId)[0]?.id || makeControlPlaneId('workspace');
  const targetWorkspaceRoot = record.workspacePath || process.cwd();
  projectRegistry.ensureInitialWorkspace(
    projectId,
    targetWorkspaceId,
    targetWorkspaceRoot,
    StorageLocations.getControlPlaneDir(),
  );
  // The project scope lands last: setActiveProject repoints the presented tab to the
  // remembered/most-recent/newly-minted tab under the verified affiliation and pushes
  // the identity broadcast that carries the new scope to the chrome.
  host.setActiveProject(projectId);
}

/** Focus a shell's window, unminimizing it first — the shared "user asked to see this" tail. */
function focusShellWindow(shell: ProjectWindowShell): void {
  if (shell.window.isDestroyed()) return;
  if (shell.window.isMinimized()) shell.window.restore();
  shell.window.show();
  shell.window.focus();
}

/**
 * The detached-side of the per-owner wiring template — the same shell creation and
 * host wiring `ensureProjectWindow` runs, minus every hub-scoped step: no
 * `activateWebHubProject` (a detached window has no presented scope — its owner key IS
 * the project), and `restoreTabs` reads the `project:<id>` owner record the detach
 * marker protects from the web fold. Existing live shells are joined, not recreated.
 */
async function ensureDetachedProjectShell(
  projectId: string,
  intent: OpenIntent,
  options?: { onFirstPresented?: () => void },
): Promise<{ shell: ProjectWindowShell; host: NativeTabHost; created: boolean }> {
  const owner: WindowOwner = { kind: 'project', projectId };
  const key = ownerKey(owner);
  // The window directory is authoritative for "does this window exist" — no marker
  // file is consulted while a live shell can be focused instead.
  const existing = liveProjectShells().find((shell) => ownerKey(shell.owner) === key);
  if (existing && !existing.window.isDestroyed()) {
    const host = tabAuthorities.hostForShell(existing);
    if (!host) {
      throw new CapabilityError(
        'RESOURCE_FAILURE',
        `Detached shell for project '${projectId}' exists without a host`,
        { projectId },
      );
    }
    // A 'restore' intent joining a live shell still surfaces the window — a hidden
    // or minimized detached shell must not stay invisible to the boot leg — but
    // never steals focus for it.
    if (intent === 'restore') presentShellUnfocused(existing);
    return { shell: existing, host, created: false };
  }

  // A project mid-reattach may still carry its persisted marker — and a shell caught
  // mid-close is a join above — but creating a NEW detached shell now would
  // resurrect the window the reattach is dismantling. Refuse the creation arm only.
  if (reattachInProgress.has(projectId)) {
    throw new CapabilityError(
      'TRANSACTION_CONFLICT',
      `Project '${projectId}' is reattaching; its detached shell is not recreatable`,
      { projectId },
    );
  }

  assertApplicationAdmitsWork(closeReservations, `detached project window '${key}'`);
  // The boot leg's validity check leans on the same capsule→registry evidence the
  // hub's open path relies on: sync affiliations into the registry BEFORE a shell
  // is minted so a capsule-only project registers here, exactly as
  // `ensureProjectWindow` does above its own creation. Reused, never duplicated.
  if (capsuleManager) {
    synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  }
  const manager = projectWindows;
  if (!manager) throw new Error('The project window manager is not up yet');
  const shell = await manager.ensureWindow(owner, intent);
  if (intent === 'user' || intent === 'restore') {
    presentShellOnFirstPaint(shell, options?.onFirstPresented, intent === 'restore' ? 'unfocused' : 'focused');
  }
  const host = detachedShellHostFactoryForTesting?.(shell) ?? new NativeTabHost(shell, capsuleManager || undefined);
  host.setCloseAdmission(closeReservations);
  host.setOpenTerminalManagerHandler(() => { void openSharedTerminalManagerWindow(); });
  host.setDetachedShellProbe((id) => {
    const candidate = liveProjectShells().find((s) => s.owner.kind === 'project' && s.owner.projectId === id);
    return candidate !== undefined && !candidate.window.isDestroyed();
  });
  tabAuthorities.register(shell, host);

  // The same per-owner wiring `ensureProjectWindow` runs for the hub, pointed at this
  // project's own verified record — a detached window's terminals run in its project's
  // directory, never a shared scope. A refused set is cleared, not silently kept.
  const record = resolveWindowRecord(owner);
  if (record.workspacePath) {
    if (!host.setWindowWorkspaceAffiliation({
      workspacePath: record.workspacePath,
      ...(record.capsuleId ? { capsuleId: record.capsuleId } : {}),
    })) {
      host.setWindowWorkspaceAffiliation(null);
    }
  } else {
    host.setWindowWorkspaceAffiliation(null);
  }
  const targetWorkspaceId = record.workspaceId || projectRegistry.listWorkspaces(projectId)[0]?.id || makeControlPlaneId('workspace');
  const targetWorkspaceRoot = record.workspacePath || process.cwd();
  projectRegistry.ensureInitialWorkspace(projectId, targetWorkspaceId, targetWorkspaceRoot, StorageLocations.getControlPlaneDir());

  windowStateManager?.manage(shell.window, key);
  attachShellLifecycle(shell);
  host.restoreTabs(undefined);
  attachSharedServices(host);
  recordLifecycleEvent('detached-shell.created', { projectId });
  return { shell, host, created: true };
}

/** Per-shell boot-restore latency budget, in milliseconds. */
const DETACHED_RESTORE_BUDGET_MS = 500;

/**
 * Whether a marked `detached:true` record may resurrect a shell for `projectId`.
 *
 * The predicate is deliberately NARROWER than `isListedProjectId` (which the
 * appearance controls use — a record still stored after `closeProject` is
 * legitimately listed there) and narrower than `isKnownProjectId` (whose
 * `bootProjectIdValue` arm answers true unconditionally). A detached window is
 * restored only for a project the registry currently holds OPEN, or for one a
 * single validated capsule claims — the same evidence `synchronizeCapsulesWithRegistry`
 * registers from. Neither a `state === 'closed'` registry record nor a dead
 * boot-id slot can authorize a window; such records are left on disk for purge.
 */
export function detachedRestoreAdmitsProject(projectId: string): boolean {
  // The boot sentinel is admitted into the registry as `open` on every boot, so the
  // registry arm alone would resurrect a persisted boot-project record as a second
  // hub window. It is never a tenant; refuse before consulting either arm.
  if (isBootProjectId(projectId)) return false;
  try {
    if (projectRegistry.getProject(projectId).state === 'open') return true;
  } catch {
    // Absent or malformed id: the capsule arm below is the remaining evidence.
  }
  return uniqueValidatedClaim(capsuleManager?.list() ?? [], projectId) !== undefined;
}

/** The per-record verdict a boot restore lands on, for tests and the journal. */
export interface DetachedRestoreOutcome {
  projectId: string;
  status: 'restored' | 'skipped' | 'refused' | 'failed';
  created?: boolean;
  durationMs?: number;
  overBudget?: boolean;
  reason?: string;
  detail?: string;
}

/**
 * Live terminals the detached daemon kept across a GUI restart may still carry the
 * `project:<bootId>` stamp an earlier build minted while the hub showed "Tổng hợp".
 * The daemon owns those rows, so the on-read sanitization in TerminalManager never
 * sees them; re-home each one onto the hub's own key through the ordinary transfer
 * seam (sync in-process, async over the daemon wire), keeping its workspace capsule.
 * A refusal for one row (closed, disposed) is journaled and never blocks the boot.
 */
async function rehomeBootProjectTerminals(terminal: TerminalManager): Promise<void> {
  let summaries: unknown[];
  try {
    summaries = terminal.listSessions();
  } catch (err) {
    recordLifecycleEvent('terminal-boot-rehome.failed', { detail: redactCredentials(String(err)) });
    return;
  }
  if (!Array.isArray(summaries)) return;
  let moved = 0;
  let refused = 0;
  for (const summary of summaries) {
    if (!summary || typeof summary !== 'object' || !('id' in summary)) continue;
    const sessionId = summary.id;
    if (typeof sessionId !== 'string' || !sessionId) continue;
    const current = terminal.sessionOwnerKey(sessionId);
    if (typeof current !== 'string' || !current.startsWith('project:')) continue;
    if (!isBootProjectId(current.slice('project:'.length))) continue;
    try {
      const transferred = await Promise.resolve(terminal.transferSessionOwner(sessionId, 'web', terminal.sessionCapsuleId(sessionId)));
      if (transferred) moved += 1; else refused += 1;
    } catch (err) {
      refused += 1;
      recordLifecycleEvent('terminal-boot-rehome.failed', { sessionId, detail: redactCredentials(String(err)) });
    }
  }
  if (moved > 0 || refused > 0) {
    recordLifecycleEvent('terminal-boot-rehome.done', { moved, refused });
  }
}

/**
 * A persisted `project:<bootId>` owner record is a zombie: the boot sentinel is the hub
 * itself, so a record under that key only exists because an earlier build let "Tổng hợp"
 * detach. Folding it back into `owners.web` (tabs and terminal affinities, hub copies
 * win on duplicate ids) keeps the user's tabs and ends the detach mode on disk; the
 * live ingest + persist right after is what stops the hub's next sync from rebuilding
 * `owners.web` from stale memory and erasing the fold. No-op when no record exists.
 */
async function foldPersistedBootProjectRecord(): Promise<void> {
  const bootIds = [DEFAULT_BOOT_PROJECT_ID];
  for (const bootId of bootIds) {
    let folded: FoldDetachedOwnerResult;
    try {
      folded = await foldDetachedOwnerRecord(savedTabsFilePath(), ownerKey({ kind: 'project', projectId: bootId }));
    } catch (err) {
      recordLifecycleEvent('detached-restore.boot-fold-failed', { projectId: bootId, detail: redactCredentials(String(err)) });
      continue;
    }
    if (!folded.folded) continue;
    const hubHost = hostForOwnerKey('web');
    let minted = 0;
    if (hubHost) {
      minted = hubHost.ingestPersistedOwnerRows(folded.tabs, { terminalAffinities: folded.terminalAffinities }).minted.length;
      hubHost.persistSync();
    }
    recordLifecycleEvent('detached-restore.boot-folded', { projectId: bootId, tabs: folded.tabs.length, minted });
  }
}

/**
 * The boot leg that resurrects detached `project:<id>` shells. Runs once per
 * boot, AFTER the hub's restore — the hub owns the saved-tabs fold write
 * (synchronous inside `restoreTabs`), so enumerating marked records at this
 * point can never see a torn document.
 *
 * Per record, in order and sequentially: the reattach latch and the marker are
 * re-read at ensure time (a stale snapshot must not resurrect a record a
 * concurrent reattach already folded), the registry/capsule predicate gates
 * dead ids, then `ensureDetachedProjectShell` with the 'restore' intent —
 * `showInactive` presentation, zero focus steals from this leg. One record's
 * failure is caught, journaled and the loop continues: a corrupt or refusing
 * record must not starve the records behind it.
 */
export async function restoreDetachedProjectShells(): Promise<DetachedRestoreOutcome[]> {
  const outcomes: DetachedRestoreOutcome[] = [];
  await foldPersistedBootProjectRecord();
  let marked: string[];
  try {
    marked = listDetachedProjectOwnerRecords(savedTabsFilePath());
  } catch (err) {
    // An enumeration failure must never fail the boot: nothing is restored, the
    // record stays on disk exactly as written, and the skip is journaled.
    recordLifecycleEvent('detached-restore.failed', { detail: redactCredentials(String(err)) });
    return outcomes;
  }
  for (const markedKey of marked) {
    const parsed = parseOwnerKey(markedKey);
    if (parsed.kind !== 'project') continue; // enumeration contract: unreachable, fail closed
    const projectId = parsed.projectId;
    if (reattachInProgress.has(projectId)) {
      outcomes.push({ projectId, status: 'skipped', reason: 'reattach-in-progress' });
      continue;
    }
    if (!savedTabsOwnerIsDetached(savedTabsFilePath(), projectId)) {
      outcomes.push({ projectId, status: 'skipped', reason: 'marker-cleared' });
      continue;
    }
    if (!detachedRestoreAdmitsProject(projectId)) {
      recordLifecycleEvent('detached-restore.refused', { projectId });
      outcomes.push({ projectId, status: 'refused' });
      continue;
    }
    const startedAt = performance.now();
    try {
      const { created } = await ensureDetachedProjectShell(projectId, 'restore');
      const durationMs = Math.round(performance.now() - startedAt);
      const overBudget = durationMs > DETACHED_RESTORE_BUDGET_MS;
      if (overBudget) {
        console.warn(`[antifan] detached shell restore for '${projectId}' took ${durationMs}ms (budget ${DETACHED_RESTORE_BUDGET_MS}ms)`);
      }
      recordLifecycleEvent('detached-restore.shell', { projectId, created, durationMs, overBudget });
      outcomes.push({ projectId, status: 'restored', created, durationMs, overBudget });
    } catch (err) {
      const durationMs = Math.round(performance.now() - startedAt);
      const detail = redactCredentials(String(err));
      recordLifecycleEvent('detached-restore.failed', { projectId, durationMs, detail });
      outcomes.push({ projectId, status: 'failed', durationMs, detail });
    }
  }
  if (marked.length > 0) {
    recordLifecycleEvent('detached-restore.done', {
      marked: marked.length,
      restored: outcomes.filter((o) => o.status === 'restored').length,
      refused: outcomes.filter((o) => o.status === 'refused').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      skipped: outcomes.filter((o) => o.status === 'skipped').length,
    });
  }
  return outcomes;
}

/**
 * Test-only seams for `ensureDetachedProjectShell`: `node --test` never runs
 * `createWindow` (the Electron stub never resolves `app.whenReady`), so the
 * manager, the placement manager, the capsule store and the host constructor
 * stay null/unreachable. These let a harness stand the same directories up the
 * real wiring would — module-local, unreachable from any IPC surface.
 */
let detachedShellHostFactoryForTesting: ((shell: ProjectWindowShell) => NativeTabHost) | null = null;
export function setDetachedShellHostFactoryForTesting(factory: ((shell: ProjectWindowShell) => NativeTabHost) | null): void {
  detachedShellHostFactoryForTesting = factory;
}
export function setProjectWindowManagerForTesting(manager: ProjectWindowManager | null): void {
  projectWindows = manager;
}
export function setWindowStateManagerForTesting(manager: WindowStateManager | null): void {
  windowStateManager = manager;
}
export function setCapsuleManagerForTesting(manager: WorkspaceCapsuleManager | null): void {
  capsuleManager = manager;
}
export function setBootProjectIdForTesting(projectId: string | null): void {
  bootProjectIdValue = projectId;
}

/**
 * Move the hub's live `projectId`-stamped tabs into a detached host. Ordering is the
 * contract's own: rows are serialized, the hub's workspace affiliation is nulled
 * BEFORE its presented scope is nulled (a scope under a foreign affiliation would
 * mint terminals in the wrong directory between the two clears), then the tabs are
 * closed in the source and re-homed in the target — so a tab the user is inside is
 * never invisible in both windows at once. A refused close leaves that tab in the
 * hub and the transfer reports it; rows whose close ran are re-homed.
 */
async function transferHubProjectTabs(
  hubHost: NativeTabHost,
  detachedHost: NativeTabHost,
  projectId: string,
): Promise<{ transferred: string[]; refused: string[] }> {
  const serialized = hubHost.serializeProjectTabsForTransfer(projectId);
  // Affiliation precedes scope: between the two clears the hub must never carry the
  // old project's workspace while reporting no scope (or vice-versa — a minted tab in
  // that window would stamp the wrong directory). BOTH are gated on the hub actually
  // presenting this project: detaching X's stray stamped tabs while the hub presents
  // Y must not null Y's workspace affiliation under it.
  if (hubHost.activeProject() === projectId) {
    hubHost.setWindowWorkspaceAffiliation(null);
    try {
      hubHost.setActiveProject(null);
    } catch (err) {
      console.warn('[antifan] clearing detached hub project scope failed:', err);
    }
  }
  const { closed } = await hubHost.closeTabsForProject(projectId);
  const closedIds = new Set(closed);
  const arrivedRows = serialized.tabs.filter((row) => {
    const rowId = typeof row?.id === 'string' ? row.id : undefined;
    return rowId === undefined || closedIds.has(rowId);
  });
  const refused = serialized.tabs
    .map((row) => (typeof row?.id === 'string' ? row.id : undefined))
    .filter((rowId): rowId is string => rowId !== undefined && !closedIds.has(rowId));
  detachedHost.ingestTransferredTabRows(arrivedRows, {
    terminalAffinities: serialized.terminalAffinities,
    ...(serialized.activeSourceTabId ? { activeSourceTabId: serialized.activeSourceTabId } : {}),
  });
  return { transferred: arrivedRows.map((row) => String(row.id ?? '')), refused };
}

/**
 * The detach entrypoint — the ONLY path that creates or joins a `project:<id>` shell.
 * Exclusivity is enforced here (a live detached shell is focused and joined, never a
 * second window), and the hub's live tabs move to the detached shell before the
 * hub's affiliation and scope are nulled — the window that still owns the user is
 * never left presenting a project it no longer hosts.
 */
async function detachProject(payload: unknown, parent?: Electron.BrowserWindow | null): Promise<ProjectDetachResult> {
  const raw = payload && typeof payload === 'object' && 'projectId' in payload && typeof payload.projectId === 'string'
    ? payload.projectId.trim()
    : '';
  if (!raw) return { status: 'FAILED', reason: 'PROJECT_UNAVAILABLE' };
  if (isBootProjectId(raw)) {
    return { status: 'FAILED', projectId: raw, reason: 'BOOT_PROJECT_NOT_DETACHABLE' };
  }
  if (!isListedProjectId(raw)) {
    return { status: 'FAILED', projectId: raw, reason: 'PROJECT_UNAVAILABLE' };
  }
  let projectId: string;
  try {
    projectId = validateControlPlaneId(raw, 'project');
  } catch {
    return { status: 'FAILED', projectId: raw, reason: 'INVALID_PROJECT_ID' };
  }
  const existingShell = liveProjectShells().find((shell) => shell.owner.kind === 'project' && shell.owner.projectId === projectId);
  if (existingShell && !existingShell.window.isDestroyed()) {
    focusShellWindow(existingShell);
    recordLifecycleEvent('project-detach.focused', { projectId });
    return { status: 'FOCUSED', projectId };
  }
  // A reattach owns this project's routing right now: a shell caught mid-close is
  // focused above, but a re-detach must never race the fold by recreating one.
  if (reattachInProgress.has(projectId)) {
    return { status: 'FAILED', projectId, reason: 'REATTACH_IN_PROGRESS' };
  }
  try {
    const { shell, host: detachedHost, created } = await ensureDetachedProjectShell(projectId, 'user');
    const hubHost = hostForOwnerKey('web');
    if (hubHost) {
      const result = await transferHubProjectTabs(hubHost, detachedHost, projectId);
      if (result.refused.length > 0) {
        // Rollback for a fresh, empty shell: the detach just minted a `project:<id>`
        // window AND stamped its persisted record `detached`, but nothing moved —
        // leaving it would wedge the project in detached mode without a single tab
        // to show for it (the marker alone keeps it out of the hub, today and at
        // every boot). `reattachProject` owns the entire reverse path: it parks
        // and closes the shell through the coordinator, folds the record back into
        // `owners.web`, and clears the marker — the same unit the explicit menu
        // action runs, so the rollback cannot leave a second convention behind.
        // A shell that DID receive tabs keeps them (honest partial detach below),
        // and a pre-existing shell the call only joined is never closed on its
        // user's behalf.
        if (created && result.transferred.length === 0) {
          const rollback = await reattachProject({ projectId });
          recordLifecycleEvent('project-detach.refused-rollback', {
            projectId,
            refused: result.refused.length,
            rollbackStatus: rollback.status,
          });
          return { status: 'FAILED', projectId, reason: 'DETACH_REFUSED' };
        }
        // Complete detach, honest partial: the project DID detach (the shell and its
        // transferred tabs stay), so the tabs that refused to leave are cleared of
        // their stamp — live, unscoped and VISIBLE on the hub — instead of remaining
        // stamped rows the restore read-filter would hide under the marked record.
        // The refusal is still the typed answer the caller gets.
        const cleared = hubHost.clearTabProjectStamp(result.refused);
        if (cleared.length > 0) {
          try {
            await hubHost.persistTabsAsync();
          } catch (err) {
            console.warn('[antifan] persisting cleared detach stamps failed:', err);
          }
        }
        recordLifecycleEvent('project-detach.refused', { projectId, refused: result.refused.length, unscoped: cleared.length });
        return { status: 'FAILED', projectId, reason: 'DETACH_REFUSED' };
      }
    }
    focusShellWindow(shell);
    recordLifecycleEvent('project-detach', { projectId, created });
    broadcastProjectInventoryChanged();
    return created ? { status: 'DETACHED', projectId } : { status: 'FOCUSED', projectId };
  } catch (err) {
    recordLifecycleEvent('project-detach.failed', { projectId, detail: redactCredentials(String(err)) });
    return { status: 'FAILED', projectId, reason: 'CAPABILITY_FAILED' };
  }
}

/**
 * Projects whose reattach is in flight. Set before the close attempt begins and
 * cleared only when the whole sequence — close, fold, ingest, hub persist — has
 * settled, so it covers the entire span where the persisted marker still says
 * "detached" but a detached shell must never be recreated. The phase-01
 * exclusivity gates consult it: a marked project MID-reattach routes to the
 * hub/focus path, never back through `ensureDetachedProjectShell`.
 */
const reattachInProgress = new Set<string>();

/**
 * Test-only driver for the detached shell's coordinated close. `node --test` runs
 * have no `projectWindows` close-surface directory, so the real coordinator can
 * never reach a testing shell; this seam lets a harness drive the same settle —
 * the driver's resolved `CloseReport` stands in for the attempt's `handle.settled`,
 * which production resolves only after the dying host's `dispose()` has run its
 * synchronous `persistSync`. Module-local, unreachable from any IPC surface.
 */
let detachedShellCloseDriverForTesting: ((shell: ProjectWindowShell, force?: boolean) => Promise<CloseReport>) | null = null;
export function setDetachedShellCloseDriverForTesting(
  driver: ((shell: ProjectWindowShell, force?: boolean) => Promise<CloseReport>) | null,
): void {
  detachedShellCloseDriverForTesting = driver;
}


/**
 * Close a detached `project:<id>` shell through the close coordinator and await the
 * attempt's settle. `attemptClose` resolves `handle.settled`, which the coordinator
 * fulfils only after `closeSelf` has reported 'closed' — and the shell's own
 * `closed` listener ordering (Main's `handleShellClosed` is registered before the
 * attempt's observer) means `dispose()` and its synchronous `persistSync` have
 * already run. Awaiting this promise IS awaiting the final write; nothing may fold
 * before it resolves. `force` swaps the request for `forceClose` — the same
 * coordinator surface the confirmed destructive close uses — only after the user
 * explicitly authorized it.
 */
function closeDetachedShellForLifecycle(shell: ProjectWindowShell, force = false): Promise<CloseReport> {
  const driver = detachedShellCloseDriverForTesting;
  if (driver) return driver(shell, force);
  const key = ownerKey(shell.owner);
  return force ? closeCoordinator.forceClose(key) : closeCoordinator.attemptClose(key, 'user');
}
/**
 * Test seam for the reattach refusal's destructive-confirmation dialog. Production
 * falls through to the real `dialog.showMessageBox`; a probe answers without one.
 * Mirrors `forceCloseConfirmationForProbe` — confirmation seams are module-local
 * and unreachable from any IPC surface.
 */
let reattachForceConfirmationForTesting:
  | ((shell: { ownerKey: string; title: string }) => Promise<boolean>)
  | null = null;
export function setReattachForceConfirmationForTesting(
  probe: ((shell: { ownerKey: string; title: string }) => Promise<boolean>) | null,
): void {
  reattachForceConfirmationForTesting = probe;
}

/**
 * Ask the user whether a refused reattach may close the detached shell forcibly.
 * Default-deny: cancel/Escape answers 'keep detached' and a destroyed or throwing
 * dialog surface does the same — a force close is only ever an explicit 'yes'.
 */
async function confirmForceReattach(shell: ProjectWindowShell): Promise<boolean> {
  if (reattachForceConfirmationForTesting) {
    return reattachForceConfirmationForTesting({ ownerKey: ownerKey(shell.owner), title: shell.title });
  }
  try {
    const { response } = await dialog.showMessageBox(shell.window, {
      type: 'warning',
      title: 'Không thể gắn lại project?',
      message: `Cửa sổ project "${shell.title}" từ chối đóng để gắn lại vào cửa sổ chính.`,
      detail: 'Một trang đang veto đóng (dữ liệu chưa lưu) hoặc cửa sổ đang bận. Bắt buộc đóng sẽ hủy các thay đổi chưa lưu trong cửa sổ này.',
      buttons: ['Giữ cửa sổ riêng', 'Bắt buộc gắn lại'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return response === 1;
  } catch (err) {
    console.warn('[antifan] reattach force-confirmation failed; keeping the detached shell:', err);
    return false;
  }
}


/**
 * The explicit reattach — the ONLY path that folds a `project:<id>` owner record.
 * Ordinary close and quit never reach it: they leave the record marked for the
 * next boot's restore.
 *
 * ARM A (shell live): the shell is closed through the coordinator; only a settled
 * `disposition === 'closed'` may continue — the report arrives post-`persistSync`,
 * so the record the fold deletes can no longer be re-written by the dying host.
 * ARM B (marked, no live shell): nothing to close; the fold runs directly.
 *
 * Fold → ingest → hub persist is ONE unbroken unit: after the fold's atomic write,
 * the hub's in-memory record is updated and `persistSync` forced without awaiting
 * anything else, because any interleaved hub write would rebuild `owners.web`
 * from stale memory and erase the just-folded rows. The post-persist re-read
 * asserts both halves of the landing: the record is absent AND every minted tab
 * id is present.
 */
async function reattachProject(payload: unknown): Promise<ProjectReattachResult> {
  const raw = payload && typeof payload === 'object' && 'projectId' in payload && typeof payload.projectId === 'string'
    ? payload.projectId.trim()
    : '';
  if (!raw) return { status: 'FAILED', reason: 'PROJECT_UNAVAILABLE' };
  if (!isListedProjectId(raw)) {
    return { status: 'FAILED', projectId: raw, reason: 'PROJECT_UNAVAILABLE' };
  }
  let projectId: string;
  try {
    projectId = validateControlPlaneId(raw, 'project');
  } catch {
    return { status: 'FAILED', projectId: raw, reason: 'INVALID_PROJECT_ID' };
  }
  const detachedOwnerKey = ownerKey({ kind: 'project', projectId });
  const detachedShell = liveShellFor(detachedOwnerKey);
  const liveDetachedShell = detachedShell && !detachedShell.window.isDestroyed() ? detachedShell : undefined;
  const markedDetached = savedTabsOwnerIsDetached(savedTabsFilePath(), projectId);
  if (!liveDetachedShell && !markedDetached) {
    return { status: 'FAILED', projectId, reason: 'NOT_DETACHED' };
  }
  if (reattachInProgress.has(projectId)) {
    return { status: 'FAILED', projectId, reason: 'REATTACH_IN_PROGRESS' };
  }
  reattachInProgress.add(projectId);
  try {
    if (liveDetachedShell) {
      // A hub is ensured BEFORE the close, never after: when the detached shell is
      // the last browser shell, its `closed` handler would otherwise start an
      // application quit inside the awaited close — after which creating the hub
      // would mint a window a committed quit never counted. The hub is not
      // presented and its scope is untouched here; rows land below.
      if (!liveShellFor('web')) {
        await ensureProjectWindow({ kind: 'web' }, 'agent');
      }
      const report = await closeDetachedShellForLifecycle(liveDetachedShell);
      recordCloseReport(report);
      if (report.disposition !== 'closed') {
        // Veto or uncertainty: the record stays marked and nothing may fold. But a
        // permanent beforeunload veto (a dirty editor) would otherwise wedge the
        // project in detached mode forever — reattach is the user's own window
        // lifecycle action, so the refusal is surfaced WITH an explicit force
        // escape. Only a confirmed 'yes' authorizes forceClose; every other
        // answer leaves the exact pre-refusal state.
        if (liveDetachedShell.window.isDestroyed()) {
          // Racing a native teardown: refuse without offering a force on a dead window.
          recordLifecycleEvent('project-reattach.refused', { projectId, haltedBy: 'unknown-outcome' });
          return { status: 'FAILED', projectId, reason: 'CLOSE_REFUSED' };
        }
        const forceAuthorized = await confirmForceReattach(liveDetachedShell);
        if (!forceAuthorized) {
          recordLifecycleEvent('project-reattach.refused', { projectId, haltedBy: report.haltedBy ?? 'retained' });
          return { status: 'FAILED', projectId, reason: 'CLOSE_REFUSED' };
        }
        const forcedReport = await closeDetachedShellForLifecycle(liveDetachedShell, true);
        recordCloseReport(forcedReport);
        if (forcedReport.disposition !== 'closed' && forcedReport.surface?.outcome !== 'closed') {
          recordLifecycleEvent('project-reattach.refused', {
            projectId,
            haltedBy: forcedReport.haltedBy ?? 'retained',
            forced: true,
          });
          return { status: 'FAILED', projectId, reason: 'CLOSE_REFUSED' };
        }
        recordLifecycleEvent('project-reattach.forced-close', { projectId, haltedBy: report.haltedBy ?? 'retained' });
      }
    }

    const folded = await foldDetachedOwnerRecord(savedTabsFilePath(), detachedOwnerKey);
    if (!folded.folded) {
      // The shell closed but left no record behind: the detach mode is ended either
      // way (the marker dies with the shell), so this is a successful no-op fold.
      recordLifecycleEvent('project-reattach.empty-fold', { projectId });
      broadcastProjectInventoryChanged();
      return { status: 'REATTACHED', projectId };
    }

    // The unit closes here: no await may sit between the fold's write and this
    // persist — an interleaved hub write would rebuild owners.web from stale
    // memory and erase the folded rows.
    const hubHost = hostForOwnerKey('web');
    let mintedIds: string[] = [];
    if (hubHost) {
      const ingested = hubHost.ingestPersistedOwnerRows(folded.tabs, {
        terminalAffinities: folded.terminalAffinities,
      });
      mintedIds = ingested.minted;
      hubHost.persistSync();

      const verifyData = (() => {
        try {
          const rawFile = fs.readFileSync(savedTabsFilePath(), 'utf8');
          const parsed: unknown = JSON.parse(rawFile);
          return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
        } catch {
          return null;
        }
      })();
      const verifyOwners = verifyData ? normalizeSavedTabsDocument(verifyData).document.owners : null;
      const landed = new Set(
        (verifyOwners?.['web']?.tabs ?? [])
          .map((tab) => (tab && typeof tab === 'object' ? (tab as Record<string, unknown>).id : undefined))
          .filter((id): id is string => typeof id === 'string'),
      );
      const settled = verifyOwners !== null
        && !(detachedOwnerKey in verifyOwners)
        && mintedIds.every((id) => landed.has(id));
      if (!settled) {
        recordLifecycleEvent('project-reattach.failed', {
          projectId,
          detail: 'post-fold verification failed: record present or minted rows absent',
        });
        return { status: 'FAILED', projectId, reason: 'SETTLE_INCOMPLETE' };
      }
    }

    const hubShell = liveShellFor('web');
    if (hubShell && !hubShell.window.isDestroyed()) focusShellWindow(hubShell);
    recordLifecycleEvent('project-reattach', { projectId, tabs: folded.tabs.length, minted: mintedIds.length });
    broadcastProjectInventoryChanged();
    return { status: 'REATTACHED', projectId };
  } catch (err) {
    recordLifecycleEvent('project-reattach.failed', { projectId, detail: redactCredentials(String(err)) });
    return { status: 'FAILED', projectId, reason: 'CAPABILITY_FAILED' };
  } finally {
    reattachInProgress.delete(projectId);
  }
}

/**
 * The dependency surface `createBridgeMintHostResolver` reads per call — the same
 * seams the inline resolver consulted, named so a test can pin the full routing
 * truth table without booting the app.
 */
export interface BridgeMintResolverDeps {
  /** The host that owns a live tab, or null when no live window does. */
  hostForTab(tabId: string): NativeTabHost | null;
  /** The host behind a shell's owner key, or null once that window is gone. */
  hostForOwnerKey(ownerKeyValue: string): NativeTabHost | null;
  /** The session's stamped capsule, or undefined when it never carried one. */
  sessionCapsuleId(terminalSessionId: string): string | undefined;
  /** The session's owning window/project key, or undefined when unclaimed. */
  sessionOwnerKey(terminalSessionId: string): string | undefined;
  /** True while `capsuleId` names a capsule the store currently holds. */
  capsuleExists(capsuleId: string): boolean;
  /** The project's own validated capsule claim — the mint's pinning evidence. */
  projectCapsuleId(projectId: string): string | undefined;
  /**
   * Whether the project is in detached mode — a live `project:<id>` shell, a
   * `detached:true` persisted record a dead shell left behind, or a reattach in
   * flight. A project in this mode owns a mint's routing: it lands on the
   * detached host or it refuses — the hub is never the answer.
   */
  projectDetached(projectId: string): boolean;
  /**
   * Whether `projectId` is the project this process booted for. The boot project is
   * the hub's own default and no capsule ever claims it, so a terminal stamped with
   * it has no capsule evidence by construction.
   */
  isBootProject(projectId: string): boolean;
  /**
   * The hub host — the default window for claims nobody detached: project-owned
   * terminals still route through it (the hub presents that project), and
   * web/unassigned keys and unclaimed mints land on it. The hub may be closed while
   * sibling windows keep the process running; this reopens it rather than answering
   * with the host that window disposed. Read only on a path that lands on the hub, so
   * a refused or elsewhere-routed mint never reopens it.
   */
  ensureHubHost(): Promise<NativeTabHost>;
}

/**
 * Build the bridge's mint-host resolver: where an agent tab mint lands. Routing
 * rules, in order:
 *
 * - `boundTabId` names a live tab → that tab's own host and capsule (rebinds and
 *   attributed provisions stay with the tab they name, on whichever window owns
 *   it — a detached shell included).
 * - `terminalSessionId` → the terminal's owner key decides the host. A
 *   `project:<id>`-owned session routes to the project's live detached shell
 *   when one exists, to the hub when the project was never detached, and REFUSES
 *   (`TERMINAL_SCOPE_UNRESOLVED`) when the project is detached-but-windowless:
 *   minting onto the hub would re-home a tab under the wrong window identity and
 *   double-present the project. Malformed owner keys and project claims with no
 *   owning window refuse rather than borrowing the ambient window — the incident
 *   anchor that landed in another project's window and died with it.
 * - `projectId` → the validated claim mints on the live detached shell, refuses
 *   typed while detached-but-windowless, and otherwise lands on the hub pinned
 *   to the project's capsule.
 * - No claim → the hub, unpinned; a closed hub is reopened off-screen first.
 * - A `boundTabId` that is gone, with no other claim → `undefined`: reopening the
 *   hub would only host the bridge's TAB_NOT_FOUND refusal.
 */
export function createBridgeMintHostResolver(deps: BridgeMintResolverDeps): BridgeMintHostResolver {
  return async (opts) => {
    if (opts.boundTabId) {
      const tabHost = deps.hostForTab(opts.boundTabId);
      if (tabHost) return { host: tabHost, capsuleId: tabHost.getTabCapsuleId(opts.boundTabId) };
    }
    if (opts.terminalSessionId) {
      let capsuleId: string | undefined;
      const stamped = deps.sessionCapsuleId(opts.terminalSessionId);
      // 'default' is the daemon's unattributed sentinel and a stale id no live capsule
      // carries: neither may pin a tab under a workspace it does not belong to.
      if (stamped && stamped !== DEFAULT_TERMINAL_CAPSULE_ID && deps.capsuleExists(stamped)) {
        capsuleId = stamped;
      }
      const ownerKeyValue = deps.sessionOwnerKey(opts.terminalSessionId);
      const parsed = parseOwnerKey(ownerKeyValue);
      const claimedProjectId = parsed.kind === 'project' ? parsed.projectId : undefined;
      const projectClaim = claimedProjectId !== undefined || parsed.kind === 'malformed';
      // A stamp that no live capsule carries falls back to the project's own
      // validated capsule — the same claim evidence the synchronizer registers from.
      if (!capsuleId && claimedProjectId) {
        capsuleId = deps.projectCapsuleId(claimedProjectId);
      }
      const claimedDetached = claimedProjectId !== undefined && deps.projectDetached(claimedProjectId);
      let host: NativeTabHost | undefined;
      if (ownerKeyValue) {
        // The owner key resolves its own window first — a `project:` key names the
        // detached shell when one is live, the hub's 'web' key names the hub, and
        // 'unassigned'/'agent' keys name their shells or nothing. A project claim
        // with no live owner window may fall back to the hub ONLY when the project
        // was never detached: the hub presents it there. A detached project with no
        // live shell is refused below, never re-homed.
        host = deps.hostForOwnerKey(ownerKeyValue)
          ?? (projectClaim && !claimedDetached ? await deps.ensureHubHost() : null)
          ?? undefined;
      }
      if (projectClaim && !host) {
        // Fail closed: minting into a host the claim does not own is exactly how the
        // incident anchor landed in another project's window and died with it.
        const refusal = claimedDetached
          ? `Terminal '${opts.terminalSessionId}' is claimed by project '${claimedProjectId}', whose window is detached ` +
            '(marked or mid-reattach) but not live — refusing to mint its agent tab into the hub window.'
          : `Terminal '${opts.terminalSessionId}' is claimed by a project, but no window owns that claim; ` +
            'refusing to mint its agent tab into the ambient window.';
        throw new CapabilityError(
          'TERMINAL_SCOPE_UNRESOLVED',
          `TERMINAL_SCOPE_UNRESOLVED: ${refusal}`,
          { terminalSessionId: opts.terminalSessionId, ownerKey: ownerKeyValue, ...(claimedProjectId ? { projectId: claimedProjectId } : {}) },
        );
      }
      if (claimedProjectId && !capsuleId && !claimedDetached && deps.isBootProject(claimedProjectId)) {
        return { host: host ?? await deps.ensureHubHost(), capsuleId, unpinnedBootProject: true };
      }
      return { host: host ?? await deps.ensureHubHost(), capsuleId };
    }
    if (opts.projectId) {
      // Only a validated claim may pin a capsule; unknown/ambiguous projects mint
      // unpinned on the hub rather than borrowing whichever capsule is active. A
      // detached project's fresh provision lands on its own shell — or refuses
      // while the project is detached-but-windowless; minting on the hub would
      // present a tab under the window that no longer owns the project.
      const assignment = deps.projectCapsuleId(opts.projectId);
      const detachedHost = deps.hostForOwnerKey(ownerKey({ kind: 'project', projectId: opts.projectId }));
      if (detachedHost) return { host: detachedHost, capsuleId: assignment };
      if (deps.projectDetached(opts.projectId)) {
        throw new CapabilityError(
          'TERMINAL_SCOPE_UNRESOLVED',
          `TERMINAL_SCOPE_UNRESOLVED: Project '${opts.projectId}' is detached but owns no live window; ` +
            'refusing to mint an agent tab into the hub window.',
          { projectId: opts.projectId },
        );
      }
      return { host: await deps.ensureHubHost(), capsuleId: assignment };
    }
    if (opts.boundTabId) return undefined;
    return { host: await deps.ensureHubHost() };
  };
}

/**
 * The option bag every application-menu surface shares: the installed native menu,
 * and the `before-input-event` dispatcher that covers the shell windows whose
 * native menubar was retired (see `ProjectWindowShell.stripMenuBar`). Building it
 * once keeps the menu's clicks and the keyboard chords pointed at the same
 * Main-owned entries.
 */
function applicationMenuOptions(): ApplicationMenuOptions {
  return {
    resolveHostForWindow: (window) => {
      const shell = shellForBrowserWindow(window);
      return shell ? tabAuthorities.hostForShell(shell) ?? null : null;
    },
    // The menu is the one project entry a project window has: the sidebar chip is the
    // other, and both ask the same Main function, so neither can drift from the other's
    // validation.
    openProjectPicker: (window) => { void openProjectWindow({}, window); },
    // The manager window has no chrome entry by design, so the menu is its only door.
    openSharedTerminalManager: () => { void openSharedTerminalManagerWindow(); },
    // The detach click is project-scoped by the focused window's own host — the same
    // resolution every other menu command uses — so the payload reaches the one
    // detach entrypoint exactly as the chrome route's does.
    detachProject: (projectId, window) => { void detachProject({ projectId }, window); },
    // Reattach is keyed by the CLICKED window's owner — a detached window's host has
    // no active project to scope the click by, so the menu resolves the project id
    // from `windowOwnerKey` and the same entrypoint runs it.
    reattachProject: (projectId, _window) => { void reattachProject({ projectId }); },
  };
}

/**
 * Install the one application menu. Commands resolve their window per click through
 * the directory (`resolveHostForWindow`), so the global accelerators act on the window
 * the user is actually in, and a window no shell describes refuses instead of silently
 * acting on another one.
 */
function installApplicationMenu(): void {
  const attachTo = bootstrapShell?.window ?? liveProjectShells()[0]?.window;
  if (!attachTo || attachTo.isDestroyed()) return;
  const options = applicationMenuOptions();
  Menu.setApplicationMenu(buildApplicationMenu(attachTo, null, options));
  // `Menu.setApplicationMenu` re-applies a native menubar to EVERY live window,
  // re-arming the crash surface `ProjectWindowShell` retired at construction:
  // `electron::MenuBar` arms `last_focused_view_tracker_` on Alt release and the
  // tracker survives view reparenting until a MenuBar::RestoreFocus call feeds
  // the stale view to `SetFocusedViewWithReason`'s ContainsView CHECK. Strip it
  // back off every shell right now; the global object stays installed so
  // `Menu.getApplicationMenu()` and non-shell auxiliary windows keep theirs.
  if (process.platform !== 'darwin') {
    for (const shell of liveProjectShells()) shell.stripMenuBar();
  }
  installMenulessAcceleratorDispatch(options);
}

let menulessAcceleratorDispatchInstalled = false;

/**
 * Route the menubar's chord set through `before-input-event` for every webContents
 * a shell owns. Native accelerators die with the menubar; without this the strip
 * would cost the window Ctrl+T/W/R/F5/F12/Alt+arrows and the rest. Resolution runs
 * through `resolveSender` — chrome views, tab panes, terminal popouts — so a key
 * pressed in a window always commands that window's host, matching what the menu's
 * `focusedWindow` did. Devtools contents are skipped: devtools owns its own key
 * surface and the menubar accelerators never applied to it either.
 */
function installMenulessAcceleratorDispatch(options: ApplicationMenuOptions): void {
  if (menulessAcceleratorDispatchInstalled) return;
  menulessAcceleratorDispatchInstalled = true;
  const attached = new WeakSet<Electron.WebContents>();
  const attach = (contents: Electron.WebContents): void => {
    if (attached.has(contents) || contents.isDestroyed()) return;
    attached.add(contents);
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const routed = tabAuthorities.resolveSender(contents.id);
      if (!routed || routed.surface === 'devtools') return;
      let window: Electron.BrowserWindow | null = null;
      try {
        window = BrowserWindow.fromWebContents(contents);
      } catch {}
      if (dispatchApplicationMenuShortcut(input, { host: routed.host, window, sender: contents, options })) {
        event.preventDefault();
      }
    });
  };
  app.on('web-contents-created', (_event, contents) => attach(contents));
  // web-contents-created only hears FUTURE contents: the bootstrap shell and its
  // restored tabs were born earlier in this very createWindow call, so the sweep
  // below is what covers them — the WeakSet keeps the two paths from doubling up.
  for (const contents of webContents.getAllWebContents()) attach(contents);
}

/**
 * Present one shell as soon as its renderer paints, with a bounded fallback so a slow first
 * paint cannot leave a window the user asked for invisible. Construction never presents, so
 * this is the only thing that can show a window Main created after boot: without it a window
 * would exist, answer its chrome, and never be seen.
 *
 * `presentation` picks the mode: 'focused' for an explicit user action, 'unfocused' for a
 * `restore`-intent creation — the window surfaces via `showInactive` (visible, placement
 * applied, focus untouched) so a boot-restored fleet can never steal focus. `onFirstPaint`
 * reports the moment this call is what showed the window, which is how the bootstrap marks
 * its startup measurement exactly once instead of arming a second presenter for the same
 * window.
 */
function presentShellOnFirstPaint(
  shell: ProjectWindowShell,
  onFirstPaint?: () => void,
  presentation: 'focused' | 'unfocused' = 'focused',
): void {
  const placement = windowStateManager?.getValidBounds(ownerKey(shell.owner));
  let fallbackTimer: NodeJS.Timeout | null = null;
  const present = (): void => {
    shellsAwaitingFirstPaint.delete(shell);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = null;
    }
    if (shell.window.isDestroyed() || shell.window.isVisible()) return;
    if (placement?.isMaximized) {
      shell.window.maximize();
    } else if (typeof placement?.x !== 'number' || typeof placement?.y !== 'number') {
      shell.window.center();
    }
    if (presentation === 'unfocused') shell.window.showInactive();
    else shell.window.show();
    if (presentation === 'focused') shell.window.focus();
    onFirstPaint?.();
  };
  shellsAwaitingFirstPaint.add(shell);
  shell.window.once('ready-to-show', present);
  shell.window.once('closed', () => {
    shellsAwaitingFirstPaint.delete(shell);
    if (!fallbackTimer) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  });
  fallbackTimer = setTimeout(present, 300);
}

/**
 * Surface a shell without taking focus: restore a minimized window, apply its saved
 * placement (maximize/center), then `showInactive`. The manager's `presentShellInactive`
 * join path and the boot restore's live-shell join share this — a `restore` presentation
 * must never move focus off the window the user is already inside.
 */
function presentShellUnfocused(shell: ProjectWindowShell): void {
  if (shell.window.isDestroyed()) return;
  const placement = windowStateManager?.getValidBounds(ownerKey(shell.owner));
  if (placement?.isMaximized) shell.window.maximize();
  else if (typeof placement?.x !== 'number' || typeof placement?.y !== 'number') shell.window.center();
  if (shell.window.isMinimized()) shell.window.restore();
  shell.window.showInactive();
}

/** Surfaces a project-window channel serves: the toolbar control and the sidebar's own. */
const PROJECT_WINDOW_ROUTE_SURFACES: readonly RoutedSurface[] = ['toolbar', 'sidebar'];

/**
 * Surfaces that may ask Main to open a project.
 *
 * The toolbar and the sidebar ask for the user's next project. A terminal window asks for
 * the project it is about to hand a session to: opening or focusing that window is the
 * first step of moving a terminal, and it is the shared manager window — a
 * `terminalPopout` — where unclaimed sessions are listed and moved from. Refusing that
 * surface left the manager's own action failing against the router, so the move could
 * never start. Every other cross-window channel keeps the narrower list.
 */
const PROJECT_OPEN_ROUTE_SURFACES: readonly RoutedSurface[] = ['toolbar', 'sidebar', 'terminalPopout'];

/**
 * Surfaces that may host the renderer picker: both chrome views of a shell and the
 * standalone workbench windows (popout and extra terminal windows). The answer channel
 * serves exactly these because the push can only ever reach one of them.
 */
const PROJECT_PICKER_ROUTE_SURFACES: readonly RoutedSurface[] = ['toolbar', 'sidebar', 'terminalPopout'];

/**
 * Main's own label for an owner key: the window's validated record, the same source the
 * window's title and its identity message use. The host labels a project owner by its id,
 * which is the right stable key for persistence but not what a user searches against —
 * the search list must name a window the way that window names itself.
 */
function projectLabelFor(ownerKeyValue: string): string | undefined {
  const shell = liveShellFor(ownerKeyValue);
  return shell ? resolveWindowRecord(shell.owner).title : undefined;
}

/** One inventory row as the renderer's contract sees it. Main asserts liveness only for rows built from live tabs. */
function toProjectSearchRow(row: TabSearchInventoryRow): ProjectTabSearchRow {
  const label = projectLabelFor(row.ownerKey);
  return {
    tabId: row.tabId,
    title: row.title,
    url: row.url,
    ownerLabel: label ?? row.ownerLabel,
    ...(row.projectPath ? { pathLabel: row.projectPath } : {}),
    live: true,
  };
}

/** Why an exact activation was refused, in the contract's vocabulary. */
function activationFailureCode(reason: TabSearchActivationFailure, tabId: string): ProjectTabUnavailableCode {
  if (reason === 'OWNER_CHANGED') return 'OWNER_UNRESOLVED';
  return tabId && tabAuthorities.hostForTab(tabId)?.hasExactTab(tabId) ? 'TAB_NOT_VISIBLE' : 'TAB_CLOSED';
}

/**
 * The inventory the project picker offers: the registry's open projects plus the identities
 * Main already knows without a record — the boot project and every project a window owns.
 * A closed record and an id nothing describes are both left out, because either one would be
 * refused by the open below and a button that cannot work is worse than no button.
 */
function projectOpenCandidates(): ProjectOpenCandidate[] {
  // No project windows remain: "a project a window owns" is now "the project the web
  // hub is showing" (the shared Terminal Manager owns nothing).
  const liveProjectIds = liveProjectShells()
    .map((shell) => (shell.owner.kind === 'project' ? shell.owner.projectId : ''))
    .filter((projectId) => projectId.length > 0);
  const hubActive = webHubActiveProjectId();
  if (hubActive) liveProjectIds.push(hubActive);
  return collectProjectOpenCandidates({
    registryProjects: projectRegistry.listProjects(),
    knownProjectIds: bootProjectIdValue ? [bootProjectIdValue, ...liveProjectIds] : liveProjectIds,
    describe: (projectId) => {
      const record = resolveWindowRecord({ kind: 'project', projectId });
      return { title: record.title, ...(record.pathLabel ? { pathLabel: record.pathLabel } : {}) };
    },
  });
}

/** How long a pushed picker request may wait for its answer before the native dialog takes over. */
const PROJECT_PICKER_WAIT_MS = 120_000;

interface PendingProjectPicker {
  senderId: number;
  /** The inventory pushed with the request, so a later answer is validated against it, never re-derived. */
  spec: ProjectOpenDialogSpec;
  resolve: (choice: ProjectOpenChoice | null) => void;
  timer: NodeJS.Timeout;
}

/**
 * Requests Main pushed and is still waiting on, keyed by requestId. An answer that names
 * no live entry — a duplicate, a replay, or a stale id — is ignored rather than settled
 * against a different pick.
 */
const pendingProjectPickers = new Map<string, PendingProjectPicker>();
let projectPickerRequestSeq = 0;

/** The standalone renderer bundle a popout/new terminal window loads, resolved the way the host resolves it. */
function standaloneRendererPagePath(): string {
  const bundled = path.join(__dirname, '..', 'renderer', 'standalone.html');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(process.cwd(), 'src', 'renderer', 'standalone.html');
}

/**
 * Whether a webContents is showing the terminal workbench page — the one renderer outside
 * a shell's chrome views that can host the project picker. Page identity is checked the
 * same way `chromeSurfaceFor` checks chrome views: a view navigated elsewhere keeps its
 * preload, so the URL is what proves which surface the user is looking at.
 */
function isStandaloneRendererContents(contents: Electron.WebContents | null | undefined): boolean {
  if (!contents || contents.isDestroyed()) return false;
  try {
    if (typeof contents.isLoading === 'function' && contents.isLoading()) return false;
    const frameUrl = contents.mainFrame?.url || contents.getURL();
    if (!frameUrl.startsWith('file:')) return false;
    const loaded = path.resolve(fileURLToPath(frameUrl));
    const expected = path.resolve(standaloneRendererPagePath());
    return process.platform === 'win32' ? loaded.toLowerCase() === expected.toLowerCase() : loaded === expected;
  } catch {
    return false;
  }
}

/**
 * The webContents that can host the in-window picker for one parent window, and the shell
 * that owns it. A shell parent is hosted by its toolbar: the toolbar already floats overlays
 * (tab search, menus) over the page, so choosing a project neither opens nor resizes the
 * terminal sidebar. A non-shell parent is hosted only when its own page is the standalone
 * workbench (a terminal popout or workbench window). Any other parent yields nothing and the
 * caller falls back to the native dialog.
 */
function projectPickerHostFor(
  parent: BrowserWindow | null,
): { contents: Electron.WebContents; shell: ProjectWindowShell | null } | null {
  if (!parent || parent.isDestroyed()) return null;
  const shell = shellForBrowserWindow(parent) ?? null;
  if (shell) {
    // Terminal-only shells collapse the toolbar to a 0x0 pane (availableWidth 0), so the
    // picker would paint invisibly there — host it in the always-visible sidebar instead.
    const view = shell.isTerminalOnly() ? shell.sidebarView : shell.toolbarView;
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed() || contents.isLoading()) return null;
    const surface = shell.chromeSurfaceFor(contents.id);
    return surface === 'toolbar' || surface === 'sidebar' ? { contents, shell } : null;
  }
  const contents = parent.webContents;
  return isStandaloneRendererContents(contents) ? { contents, shell: null } : null;
}

/**
 * The shell behind a chrome webContents, for the `isCurrent` marker on `PROJECT_LIST`:
 * the sender's own host is resolved through the authority directory, then reversed to the
 * shell that host presents. A contents no live window owns has no current project.
 */
function shellForPickerContents(sender: Electron.WebContents | undefined): ProjectWindowShell | undefined {
  if (!sender || sender.isDestroyed()) return undefined;
  const routed = tabAuthorities.resolveSender(sender.id);
  if (!routed) return undefined;
  return liveProjectShells().find((shell) => tabAuthorities.hostForShell(shell) === routed.host);
}

/**
 * Reconcile the stored inventory - every open registry record plus the projects a window
 * owns that the registry does not hold - into LIVE / DEAD / STALE. A closed record is a
 * project the user removed; nothing can act on it (rename, remove and open all answer
 * UNKNOWN_PROJECT), so it is not listed. An open record whose folder vanished is the STALE
 * row the Manager must be able to show. LIVE wins over a missing path.
 */
export function projectStoredStatuses(): ProjectStoredStatus[] {
  const liveWindowProjectIds = new Set(
    liveProjectShells()
      .map((shell) => (shell.owner.kind === 'project' ? shell.owner.projectId : ''))
      .filter((projectId) => projectId.length > 0),
  );
  const registryProjects = projectRegistry.listProjects();
  const allWorkspaces = projectRegistry.listAllWorkspaces();
  // A closed record is a project the user removed: every action on it answers
  // UNKNOWN_PROJECT, so listing it would paint a section nothing can act on.
  const ids = new Set<string>(registryProjects.filter((project) => project.state === 'open').map((project) => project.id));
  for (const id of liveWindowProjectIds) ids.add(id);
  if (bootProjectIdValue) ids.add(bootProjectIdValue);
  const liveSessionProjectIds = new Set<string>();
  const registeredProjects = new Map(registryProjects.map((project) => [project.id, project]));
  // LIVE rule under the web hub: a project is live when a terminal session belongs to
  // it (the `projectTerminalSessions` leg) OR a tab in the web hub carries that
  // projectId — the hub shows every project's tabs, so the second leg is what keeps a
  // session-less project LIVE while it is being browsed.
  const webHost = hostForOwnerKey('web');
  // Third leg: the project the hub is presenting is live even when none of its tabs carry
  // the stamp — presenting IS being browsed, so the record the user is looking at can
  // never be DEAD/STALE.
  const presentedId = webHubActiveProjectId();
  if (presentedId) liveSessionProjectIds.add(presentedId);
  const stored = Array.from(ids).map((id) => {
    const record = resolveWindowRecord({ kind: 'project', projectId: id });
    if (projectTerminalSessions(id).open.length > 0 || (webHost?.tabsForProject(id).length ?? 0) > 0) {
      liveSessionProjectIds.add(id);
    }
    // A closed project detaches its workspace, so the record's path may be blank; the
    // registry still remembers the root the project was closed at.
    const registered = allWorkspaces
      .filter((w) => w.projectId === id)
      .sort((a, b) => (a.state === b.state ? 0 : a.state === 'attached' ? -1 : 1))[0];
    return {
      id,
      name: record.title || registeredProjects.get(id)?.name || id,
      workspacePath: record.workspacePath || registered?.rootPath || '',
    };
  });
  const reconciled = reconcileProjectRecords({
    stored: stored.map(({ id, workspacePath }) => ({ id, workspacePath })),
    liveSessionProjectIds,
    liveWindowProjectIds,
    pathExists: (candidatePath) => {
      try {
        return fs.existsSync(candidatePath);
      } catch {
        return false;
      }
    },
  });
  const byId = new Map(stored.map((entry) => [entry.id, entry]));
  return reconciled.map((entry) => ({
    projectId: entry.id,
    name: byId.get(entry.id)?.name ?? entry.id,
    workspacePath: byId.get(entry.id)?.workspacePath ?? '',
    status: entry.status,
    statusReason: entry.reason,
    ...projectAppearanceOf(entry.id),
  }));
}

/** Every live window re-reads the project list: one moved (opened, renamed, recoloured, removed). */
function broadcastProjectInventoryChanged(): void {
  for (const host of tabAuthorities.hosts()) {
    try {
      host.notifyProjectInventoryChanged();
    } catch (err) {
      console.warn('[project] inventory push failed:', err);
    }
  }
}

/**
 * The inventory `PROJECT_LIST` answers with: `candidates` are the projects the picker may
 * act on (Main's own picker list, with `isCurrent`), `stored` is the separate reconciled
 * view of every stored record for display.
 */
export function projectOpenListFor(sender: Electron.WebContents | undefined): ProjectOpenListResult {
  const shell = shellForPickerContents(sender);
  // The web hub is shared: "current" is the project it is showing, not an owner kind.
  const currentProjectId = shell && shell.owner.kind === 'project'
    ? shell.owner.projectId
    : shell && shell.owner.kind === 'web'
      ? (webHubActiveProjectId() ?? '')
      : '';
  return {
    candidates: projectOpenCandidates().map((candidate) => {
      const record = resolveWindowRecord({ kind: 'project', projectId: candidate.projectId });
      return {
        projectId: candidate.projectId,
        name: record.title || candidate.title,
        workspacePath: record.workspacePath || record.pathLabel || '',
        canAssignTerminal: resolveProjectAssignment(candidate.projectId) !== undefined,
        ...(record.capsuleId ? { capsuleId: record.capsuleId } : {}),
        ...projectAppearanceOf(candidate.projectId),
        ...(candidate.projectId === currentProjectId ? { isCurrent: true } : {}),
      };
    }),
    stored: projectStoredStatuses(),
  };
}

/**
 * The terminal sessions Main can prove belong to a project: stamped with that
 * window's owner key, or attributed to the project's own capsule. `live` is the
 * subset a removal would interrupt — running sessions plus sleeping ones that can
 * wake into work again; an exited shell is the only one provably not interrupted.
 */
function projectTerminalSessions(projectId: string): { live: string[]; open: string[] } {
  const live: string[] = [];
  const open: string[] = [];
  let manager: TerminalManager;
  try {
    manager = TerminalManager.getInstance();
  } catch {
    return { live, open };
  }
  const capsuleId = resolveWindowRecord({ kind: 'project', projectId }).capsuleId;
  const projectOwnerKey = `project:${projectId}`;
  for (const summary of manager.listSessions()) {
    const sessionId = summary?.id;
    if (typeof sessionId !== 'string' || !sessionId) continue;
    if (manager.sessionOwnerKey(sessionId) !== projectOwnerKey && (!capsuleId || manager.sessionCapsuleId(sessionId) !== capsuleId)) continue;
    if (summary.state === 'closed') continue;
    open.push(sessionId);
    if (summary.state === 'running' || summary.state === 'sleeping' || typeof summary.splitOf === 'string') {
      live.push(sessionId);
    }
  }
  return { live, open };
}

/**
 * Rename a project through its durable name record: the capsule store first — it is
 * the authority `resolveWindowRecord` reads and the next boot's synchronization
 * re-registers from — then the registry record, which seeds the same field when no
 * capsule claims the id. A live shell owning the project is retitled in place and
 * its chrome re-pushed, so the window's chip answers with the new name immediately.
 * The id is revalidated against Main's own inventory: a renderer echo of a forged id
 * is refused before any record moves.
 */
export function renameProjectEntry(payload: unknown): ProjectRenameResult {
  const projectId = payload && typeof payload === 'object' && 'projectId' in payload && typeof payload.projectId === 'string'
    ? payload.projectId.trim()
    : '';
  const name = payload && typeof payload === 'object' && 'name' in payload && typeof payload.name === 'string'
    ? payload.name.trim()
    : '';
  let validatedId: string;
  try {
    validatedId = validateControlPlaneId(projectId, 'project');
  } catch {
    return { status: 'FAILED', projectId, reason: 'INVALID_PROJECT_ID' };
  }
  if (!name) {
    return { status: 'FAILED', projectId: validatedId, reason: 'EMPTY_NAME' };
  }
  if (!isKnownProjectId(validatedId)) {
    return { status: 'UNKNOWN_PROJECT', projectId: validatedId };
  }

  const record = resolveWindowRecord({ kind: 'project', projectId: validatedId });
  let renamed = false;
  if (record.capsuleId && capsuleManager) {
    try {
      capsuleManager.rename(record.capsuleId, name);
      renamed = true;
    } catch (err) {
      return { status: 'FAILED', projectId: validatedId, reason: redactCredentials(String(err)) };
    }
  }
  // The registry carries the same name for capsule-less projects and mirrors it for
  // claimed ones. `getProject` throws on an absent record — the known-id check above
  // already admitted the project, so the throw here means the capsule is the only
  // name store and its rename alone is the durable change.
  try {
    const project = projectRegistry.getProject(validatedId);
    if (project.name !== name) {
      projectRegistry.registerProject({ ...project, name, updatedAt: Date.now() });
    }
    renamed = true;
  } catch {
    // No registry record: the capsule rename decides.
  }
  if (!renamed) {
    return { status: 'FAILED', projectId: validatedId, reason: 'NO_NAME_RECORD' };
  }

  const shell = liveShellFor(`project:${validatedId}`);
  if (shell) {
    shell.retitle(name);
    tabAuthorities.hostForShell(shell)?.broadcastState();
  }
  recordLifecycleEvent('project-renamed', { projectId: validatedId });
  broadcastProjectInventoryChanged();
  return { status: 'RENAMED', projectId: validatedId, name };
}

/** Colour/star of a project as the registry holds them, spread into list candidates. */
function projectAppearanceOf(projectId: string): { color?: string; starred?: boolean } {
  try {
    const project = projectRegistry.getProject(projectId);
    return {
      ...(project.color ? { color: project.color } : {}),
      ...(project.starred ? { starred: true } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Set a project's colour and/or star. The registry validates and persists (its store is the
 * durable authority), so a refusal - bad colour, cap reached, unwritable file - leaves the
 * record exactly as it was and nothing is reported as saved.
 */
export function setProjectAppearanceEntry(payload: unknown): ProjectAppearanceResult {
  const body = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  let validatedId: string;
  try {
    validatedId = validateControlPlaneId(projectId, 'project');
  } catch {
    return { status: 'FAILED', projectId, reason: 'INVALID_PROJECT_ID' };
  }
  if (!isListedProjectId(validatedId)) {
    return { status: 'UNKNOWN_PROJECT', projectId: validatedId };
  }
  const patch: { color?: string | null; starred?: boolean } = {};
  if (body.color !== undefined) {
    if (body.color !== null && typeof body.color !== 'string') {
      return { status: 'FAILED', projectId: validatedId, reason: 'APPEARANCE_REFUSED' };
    }
    patch.color = body.color;
  }
  if (body.starred !== undefined) {
    if (typeof body.starred !== 'boolean') {
      return { status: 'FAILED', projectId: validatedId, reason: 'APPEARANCE_REFUSED' };
    }
    patch.starred = body.starred;
  }
  if (patch.color === undefined && patch.starred === undefined) {
    return { status: 'FAILED', projectId: validatedId, reason: 'EMPTY_PATCH' };
  }
  const record = projectRegistry.setProjectAppearance(validatedId, patch);
  if (!record) {
    return { status: 'FAILED', projectId: validatedId, reason: 'APPEARANCE_REFUSED' };
  }
  recordLifecycleEvent('project-appearance-set', { projectId: validatedId });
  broadcastProjectInventoryChanged();
  return {
    status: 'UPDATED',
    projectId: validatedId,
    ...(record.color ? { color: record.color } : {}),
    ...(record.starred ? { starred: true } : {}),
  };
}

/**
 * Remove a project from the manager list. Removal never deletes a byte: the project
 * record closes, the capsule's affiliation clears (the capsule itself — name, path,
 * brief — survives for a later re-open), and the owning window, when one is live, is
 * shut through the same close gate a user close goes through so its unload vetoes
 * still apply. Live terminals gate the whole path behind `confirmed`: the modal
 * quotes `liveSessions` on the `CONFIRM_REQUIRED` answer, and only the confirmed ask
 * tears sessions down — first the window, then whatever the manager still lists for
 * the project, so no PTY outlives its project.
 */
export async function removeProjectEntry(payload: unknown): Promise<ProjectRemoveResult> {
  const projectId = payload && typeof payload === 'object' && 'projectId' in payload && typeof payload.projectId === 'string'
    ? payload.projectId.trim()
    : '';
  const confirmed = payload && typeof payload === 'object' && 'confirmed' in payload && payload.confirmed === true;
  let validatedId: string;
  try {
    validatedId = validateControlPlaneId(projectId, 'project');
  } catch {
    return { status: 'FAILED', projectId, reason: 'INVALID_PROJECT_ID' };
  }
  if (!isKnownProjectId(validatedId)) {
    return { status: 'UNKNOWN_PROJECT', projectId: validatedId };
  }

  const sessions = projectTerminalSessions(validatedId);
  if (sessions.live.length > 0 && !confirmed) {
    return { status: 'CONFIRM_REQUIRED', projectId: validatedId, liveSessions: sessions.live.length };
  }

  // Detached arm FIRST, ordered before any purge: a live `project:<id>` shell is
  // closed through the coordinator and only a settled 'closed' disposition may
  // continue — the report lands post-dispose, i.e. after the dying host's final
  // synchronous persistSync re-wrote its owner record. Purging before that write
  // completes would let the record be re-added after the file was cleaned. A veto
  // or a failed close refuses the whole removal: the record stays marked, the
  // shell stays alive, and no fold or purge runs.
  const detachedOwnerKey = ownerKey({ kind: 'project', projectId: validatedId });
  const detachedShell = liveShellFor(detachedOwnerKey);
  if (detachedShell && !detachedShell.window.isDestroyed()) {
    let report: CloseReport;
    try {
      report = await closeDetachedShellForLifecycle(detachedShell);
    } catch (err) {
      recordLifecycleEvent('project-remove.failed', { projectId: validatedId, detail: String(err) });
      return { status: 'FAILED', projectId: validatedId, reason: redactCredentials(String(err)) };
    }
    recordCloseReport(report);
    if (report.disposition !== 'closed') {
      recordLifecycleEvent('project-remove.refused', {
        projectId: validatedId,
        haltedBy: report.haltedBy ?? 'retained',
      });
      return { status: 'CLOSE_REFUSED', projectId: validatedId, reason: 'detached window close refused' };
    }
  }

  // A detached `project:` shell — when one existed — is already gone above. The
  // project's web-resident tabs live in the shared 'web' hub and close individually
  // through closePage — the same unload-aware path a shell close uses — so a
  // vetoing page of this project refuses the removal while every other project's
  // tabs stay put.
  const webHub = hostForOwnerKey('web');
  // If the removed project is the one the hub presents, drop the pointer BEFORE closing its
  // tabs: closing the presented tab repoints presentation, and with the pointer still set it
  // would mint a fresh tab stamped with the project being removed. Every failure below puts
  // the pointer back, so a refused or failed removal leaves the hub exactly as it was.
  const wasActive = Boolean(webHub) && webHubActiveProjectId() === validatedId;
  const savedAffiliation = wasActive && webHub ? webHub.getWindowWorkspaceAffiliation() : null;
  if (wasActive && webHub) {
    webHub.setWindowWorkspaceAffiliation(null);
    webHub.setActiveProject(null);
  }
  const restoreActive = () => {
    if (!wasActive || !webHub) return;
    webHub.setWindowWorkspaceAffiliation(savedAffiliation);
    webHub.setActiveProject(validatedId);
  };
  if (webHub) {
    let tabClose: { closed: string[]; vetoed: string[] };
    try {
      tabClose = await webHub.closeTabsForProject(validatedId);
    } catch (err) {
      restoreActive();
      recordLifecycleEvent('project-remove.failed', { projectId: validatedId, detail: String(err) });
      return { status: 'FAILED', projectId: validatedId, reason: redactCredentials(String(err)) };
    }
    if (tabClose.vetoed.length > 0) {
      restoreActive();
      recordLifecycleEvent('project-remove.refused', {
        projectId: validatedId,
        haltedBy: 'tab-unload',
      });
      return { status: 'CLOSE_REFUSED', projectId: validatedId, reason: `${tabClose.vetoed.length} tab(s) refused to close` };
    }
  }

  // Live close above is not enough: rows stamped with this projectId persist under
  // `owners.web` in saved-tabs.json and would resurrect a removed project on the next
  // boot. A live 'web' shell whose host cannot be resolved is fail-closed — its tabs
  // may still be open, so their persisted rows must survive. With no web window at all
  // nothing can be live, and the file purge runs host-free through the same
  // read-modify-write the hub's own host method delegates to.
  if (!webHub && liveShellFor(ownerKey({ kind: 'web' }))) {
    recordLifecycleEvent('project-remove.failed', { projectId: validatedId, detail: 'web window live but its host is unresolvable' });
    return { status: 'FAILED', projectId: validatedId, reason: 'WEB_HUB_UNAVAILABLE' };
  }
  try {
    await purgeSavedTabsFileForProject(savedTabsFilePath(), validatedId);
  } catch (err) {
    restoreActive();
    recordLifecycleEvent('project-remove.failed', { projectId: validatedId, detail: String(err) });
    return { status: 'FAILED', projectId: validatedId, reason: redactCredentials(String(err)) };
  }

  // Sessions are released only after the window is gone (or never existed): a failed
  // close must not leave the project stripped of terminals it still shows.
  let manager: TerminalManager | null = null;
  try {
    manager = TerminalManager.getInstance();
  } catch {
    manager = null;
  }
  if (manager && sessions.open.length > 0) {
    await Promise.all(sessions.open.map((sessionId) => manager!.closeSession(sessionId).catch(() => false)));
  }

  // The appearance belongs to the list entry. It must still be durable for the removal to
  // count: a failure here is reported, never swallowed. The hub's active project/affiliation
  // is restored like every other failure path — tabs and sessions are already closed, so a
  // retry repairs registry state but the user keeps their scope either way.
  if (!projectRegistry.forgetProjectAppearance(validatedId)) {
    restoreActive();
    recordLifecycleEvent('project-remove.appearance-failed', { projectId: validatedId });
    return { status: 'FAILED', projectId: validatedId, reason: 'APPEARANCE_NOT_CLEARED' };
  }
  try {
    projectRegistry.closeProject(validatedId);
  } catch {
    // A project with no registry record still exists by capsule or window: the
    // affiliation clear below is what removes it from the next inventory.
  }
  const record = resolveWindowRecord({ kind: 'project', projectId: validatedId });
  if (record.capsuleId && capsuleManager) {
    try {
      capsuleManager.clearAffiliation(record.capsuleId);
    } catch (err) {
      recordLifecycleEvent('project-remove.affiliation-failed', { projectId: validatedId, detail: String(err) });
    }
  }
  recordLifecycleEvent('project-removed', { projectId: validatedId });
  broadcastProjectInventoryChanged();
  return { status: 'REMOVED', projectId: validatedId };
}

/**
 * The modal's explicit answer to a `CONFIRM_REQUIRED` ask. `confirmed: true` is the
 * only consent this channel forwards — anything else never reaches the remove path,
 * which is what a dismissal means.
 */
function answerProjectRemove(payload: unknown): Promise<ProjectRemoveResult> {
  const confirmed = payload && typeof payload === 'object' && 'confirmed' in payload && payload.confirmed === true;
  if (!confirmed) {
    return Promise.resolve({ status: 'FAILED', projectId: '', reason: 'REMOVE_NOT_CONFIRMED' });
  }
  return removeProjectEntry(payload);
}


/**
 * An answer arriving on `PROJECT_OPEN_PICKER_ANSWER`. It settles the pending request only
 * when the requestId is one Main is still waiting on and the answering webContents is the
 * exact one the request was pushed to — a stale requestId or a sender that was never asked
 * changes nothing. Returns whether the answer was accepted, for the invoker's result.
 */
function acceptProjectPickerAnswer(
  sender: Electron.WebContents | undefined,
  payload: unknown,
): 'ACCEPTED' | 'IGNORED' {
  const requestId = payload && typeof payload === 'object' && 'requestId' in payload && typeof payload.requestId === 'string'
    ? payload.requestId
    : '';
  const pending = requestId ? pendingProjectPickers.get(requestId) : undefined;
  if (!pending || !sender || sender.id !== pending.senderId) return 'IGNORED';
  const choice = payload && typeof payload === 'object' && 'choice' in payload ? payload.choice : undefined;
  pendingProjectPickers.delete(requestId);
  clearTimeout(pending.timer);
  pending.resolve(projectOpenWireChoice(pending.spec, choice));
  return 'ACCEPTED';
}

/**
 * Ask a renderer to host the picker for one request and wait for its answer — bounded, so a
 * dead or stuck chrome cannot strand the open request behind it. `null` is the timeout or a
 * refused send, both of which read the same way to the caller: the renderer could not host
 * this pick and the native dialog is the answer instead.
 */
function awaitProjectPickerAnswer(
  spec: ProjectOpenDialogSpec,
  contents: Electron.WebContents,
): Promise<ProjectOpenChoice | null> {
  const requestId = `pick-${Date.now().toString(36)}-${++projectPickerRequestSeq}`;
  const { promise, resolve } = Promise.withResolvers<ProjectOpenChoice | null>();
  const timer = setTimeout(() => {
    pendingProjectPickers.delete(requestId);
    recordLifecycleEvent('project-open.picker-timeout', { requestId });
    resolve(null);
  }, PROJECT_PICKER_WAIT_MS);
  pendingProjectPickers.set(requestId, { senderId: contents.id, spec, resolve, timer });
  if (!safeSendWebContents(contents, PROJECT_WINDOW_CHANNELS.PROJECT_OPEN_PICKER, { requestId })) {
    pendingProjectPickers.delete(requestId);
    clearTimeout(timer);
    resolve(null);
  }
  return promise;
}

/** The choice an answer produced, mapped into the pick the open path already understands. */
function pickFromChoice(choice: ProjectOpenChoice): ProjectOpenPick {
  if (choice.kind === 'folder') {
    recordLifecycleEvent('project-open.folder', {});
    return { kind: 'folder' };
  }
  return choice.kind === 'project'
    ? { kind: 'picked', projectId: choice.projectId }
    : { kind: 'cancelled' };
}


/**
 * The outcome of Main's picker: a project the user chose, their request to choose a folder
 * instead, or a dialog they dismissed. There is no "nothing to offer" case: the folder action is
 * on the dialog whatever the inventory holds, so a build that knows no project still has a real
 * answer, and a dialog nobody could answer usefully is not a state Main can reach.
 */
type ProjectOpenPick =
  | { kind: 'picked'; projectId: string }
  | { kind: 'folder' }
  | { kind: 'cancelled' };

/**
 * Main's project-opening surface for the window that asked: the in-window picker first,
 * the native dialog wherever no renderer can host it. Both answer the same spec — an id
 * from Main's own inventory, the folder chooser, or a dismissal — so the open path that
 * follows validates nothing it did not build itself, whichever surface answered.
 *
 * The renderer path is preferred when the asking window's chrome is live: the native
 * dialog renders every candidate as one button row (and drops `detail` on Windows), which
 * is cramped and illegible next to a real list. The native dialog stays the answer when
 * there is no such renderer, when the surface rejects the push, or when the bounded wait
 * expires — a push a chrome ignored must not leave the user with nothing.
 *
 * The spec always exists (`projectOpenDialogSpec`), which is why the folder action is
 * offered even with an empty inventory: opening one of the user's own folders is a real
 * answer to "open a project", and a dialog whose only other button was dismissal would be
 * a dead end.
 */
async function pickProjectToOpen(parent: BrowserWindow | null): Promise<ProjectOpenPick> {
  const spec = projectOpenDialogSpec(projectOpenCandidates());
  const host = projectPickerHostFor(parent);
  if (host) {
    const choice = await awaitProjectPickerAnswer(spec, host.contents);
    if (choice !== null) {
      recordLifecycleEvent('project-open.picker-answered', {});
      return pickFromChoice(choice);
    }
    // Fell through: the surface refused the push or never answered in time. The native
    // dialog is the same question asked again on the surface that always answers.
    recordLifecycleEvent('project-open.picker-fallback', {});
  }
  const options = {
    type: 'question' as const,
    title: spec.message,
    message: spec.message,
    detail: spec.detail,
    buttons: spec.buttons,
    defaultId: spec.defaultId,
    cancelId: spec.cancelId,
    noLink: true,
  };
  // Focus the asking window first: a click delivered while the window had no focus only
  // activates the window, which is why the first click on a button seemed to do nothing.
  if (parent && !parent.isDestroyed()) {
    if (parent.isMinimized()) parent.restore();
    parent.focus();
  }
  // A dialog with no parent cannot be attached to one: the unparented overload is the only
  // legal call, and it is also what a window-less Main (a probe seam) has to use.
  const answer = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return pickFromChoice(projectOpenChoiceFor(spec, answer.response));
}

/**
 * Resolve the folder the user chooses into the project that opens there.
 *
 * A folder Main already registered as an attached workspace is adopted, never duplicated: the
 * registry is the identity of record, and a second project for one directory would leave two
 * windows whose terminals share a working directory but not a close gate. Two attached
 * workspaces on one root is ambiguity, not a choice, and is refused rather than tie-broken —
 * those rules live in `projectIdForResolvedFolder`, which this resolves the pick into and
 * every non-dialog folder open shares.
 *
 * The chosen path is resolved through the filesystem exactly as the capsule routes resolve theirs:
 * a workspace is a filesystem anchor for PTY cwd and preview containment, so the anchor has to be
 * the directory itself, never a symlink a later containment check would compare against.
 */
async function resolveProjectFromFolder(
  parent: BrowserWindow | null,
): Promise<{ projectId: string } | { result: ProjectOpenResult }> {
  // The chooser opens where the user already works when Main knows the boot project's workspace;
  // without one it is omitted, which leaves the platform's own last-used directory in charge.
  const bootProjectId = bootProjectIdValue;
  // Normalised: the Windows chooser drops a forward-slash `defaultPath` without a word.
  const bootWorkspacePath = bootProjectId
    ? resolveWindowRecord({ kind: 'project', projectId: bootProjectId }).workspacePath
    : undefined;
  const defaultPath = bootWorkspacePath ? path.normalize(bootWorkspacePath) : undefined;
  const options: OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Chọn thư mục dự án',
    ...(defaultPath ? { defaultPath } : {}),
  };
  // A folder chooser with no parent cannot be attached to one: the unparented overload is the only
  // legal call, and it is also what a window-less Main (a probe seam) has to use.
  const answer = parent && !parent.isDestroyed()
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options);
  const chosen = answer.canceled ? '' : answer.filePaths?.[0] ?? '';
  if (!chosen) return { result: { status: 'CANCELLED' } };

  let resolved = '';
  try {
    resolved = fs.realpathSync(chosen);
    if (!fs.statSync(resolved).isDirectory()) resolved = '';
  } catch {
    resolved = '';
  }
  if (!resolved) return { result: { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' } };

  return projectIdForResolvedFolder(resolved);
}

/**
 * The project id one already-resolved directory opens to: the attached workspace's project,
 * or a project minted for the folder — and it is *already resolved*, because every caller
 * (the folder chooser, a `{folder}` open payload, a later space-open that names a root) has
 * to reach the same identity through the same adoption rules rather than grow its own copy
 * of them.
 *
 * A folder Main already registered as an attached workspace is adopted, never duplicated: the
 * registry is the identity of record, and a second project for one directory would leave two
 * windows whose terminals share a working directory but not a close gate. Two attached
 * workspaces on one root is ambiguity, not a choice, and is refused rather than tie-broken.
 *
 * A folder no record describes becomes a project of its own. Its durability is the capsule
 * affiliation and nothing else: `workspace-capsules.json` is what the next boot's
 * `synchronizeCapsulesWithRegistry` re-registers the project from, so the affiliation has to land
 * before this reports success — and without the capsule manager no affiliation can be written, so
 * such a project would vanish at the next boot and take the window's identity with it. That is why
 * a missing manager refuses before any record moves, rather than creating what cannot persist.
 */
function projectIdForResolvedFolder(
  resolved: string,
): { projectId: string } | { result: ProjectOpenResult } {
  const attached = projectRegistry.findWorkspacesByRoot(resolved);
  if (attached.length > 1) {
    return { result: { status: 'FAILED', reason: 'AMBIGUOUS_PROJECT_FOLDER' } };
  }
  if (attached.length === 1) {
    // Bound to a local: the length check above is what proves the element exists, and rereading the
    // array through its index would make the type checker ask again for what this line already knows.
    const adopted = attached[0];
    if (adopted) {
      recordLifecycleEvent('project-open.folder-adopted', { projectId: adopted.projectId });
      return { projectId: adopted.projectId };
    }
  }

  // The chooser's caller can keep the user waiting as long as a dialog stays open, so the
  // admission is re-read now and the mutation below follows it with no await in between: a
  // quit that committed meanwhile would otherwise end with a project — and a window —
  // created after it counted the windows it intends to end. The wrap is not for tidiness: a
  // rejection here would surface as a dead click, while every refusal, the admission
  // included, becomes the same FAILED envelope the caller reads.
  try {
    assertApplicationAdmitsWork(closeReservations, 'open project from folder');
    // Bound once: the manager has to be the same instance for both calls below, and a manager that
    // is absent is absent before the first record moves rather than after.
    const manager = capsuleManager;
    if (!manager) {
      return { result: { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' } };
    }
    const dataRoot = StorageLocations.getControlPlaneDir();
    // An existing capsule for this folder is reused, not duplicated. A workspace directory is what
    // the user recognises, and the capsule carries what they have built up in it — its saved zoom,
    // sidebar width and device preset. Minting a second capsule for a folder that already has one
    // is how one directory becomes nine rows that each claim to be its own workspace.
    const reusable = findReusableCapsule(manager.list(), resolved, manager.getActive()?.id ?? '');
    const name = reusable && reusable.name.trim() ? reusable.name.trim() : path.basename(resolved) || 'Project';
    const project = projectRegistry.createProject(name, dataRoot);
    const workspace = projectRegistry.ensureInitialWorkspace(
      project.id,
      makeControlPlaneId('workspace'),
      resolved,
      dataRoot,
    );
    const capsule = reusable ?? manager.create(name, resolved);
    manager.setAffiliation(capsule.id, { projectId: project.id, workspaceId: workspace.id });
    recordLifecycleEvent(reusable ? 'project-open.folder-reused' : 'project-open.folder-created', {
      projectId: project.id,
      workspaceId: workspace.id,
      capsuleId: capsule.id,
    });
    return { projectId: project.id };
  } catch (err) {
    recordLifecycleEvent('project-open.folder-failed', { detail: redactCredentials(String(err)) });
    return { result: { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' } };
  }
}

/**
 * The window a chrome message came from, for a dialog that has to be modal to it. A probe
 * seam dispatches routes with no event at all, so an absent sender is an ordinary null
 * rather than an error.
 */
function senderWindowFor(event: unknown): BrowserWindow | null {
  const sender = event && typeof event === 'object' && 'sender' in event
    ? (event as { sender?: unknown }).sender
    : undefined;
  if (!sender || typeof sender !== 'object') return null;
  try {
    return BrowserWindow.fromWebContents(sender as Parameters<typeof BrowserWindow.fromWebContents>[0]);
  } catch {
    return null;
  }
}

/** Sender scope only: a chrome may force its own shell, never a renderer-named owner. */
function shellForWindow(window: BrowserWindow | null): ProjectWindowShell | null {
  if (!window || window.isDestroyed()) return null;
  for (const shell of liveProjectShells()) {
    if (shell.window === window) return shell;
  }
  return null;
}
/** Probe seam: route tests can answer the destructive confirmation without driving a dialog. */
let forceCloseConfirmationForProbe:
  | ((shell: { ownerKey: string; title: string }) => Promise<boolean>)
  | null = null;

/** Explicit user confirmation is the only authorization a destructive force close accepts. */
async function forceCloseWindowForSender(event: unknown): Promise<ForceCloseWindowResult> {
  const shell = shellForWindow(senderWindowFor(event));
  if (!shell || shell.window.isDestroyed()) return { status: 'FAILED', reason: 'WINDOW_NOT_FOUND' };
  const key = ownerKey(shell.owner);
  const confirmed = forceCloseConfirmationForProbe
    ? await forceCloseConfirmationForProbe({ ownerKey: key, title: shell.title })
    : (await dialog.showMessageBox(shell.window, {
        type: 'warning',
        title: 'Bắt buộc đóng cửa sổ?',
        message: `Bắt buộc đóng cửa sổ ${shell.title}?`,
        detail: 'Các trang chưa lưu và công việc Agent đang chạy trong cửa sổ này sẽ bị hủy.',
        buttons: ['Hủy', 'Bắt buộc đóng'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })).response === 1;
  if (!confirmed) return { status: 'CANCELLED' };
  const report = await closeCoordinator.forceClose(key);
  if (report.disposition === 'closed' || report.surface?.outcome === 'closed') {
    recordCloseReport(report);
    recordLifecycleEvent('window-close.force-closed', { owner: key });
    return { status: 'CLOSED' };
  }
  recordLifecycleEvent('window-close.force-failed', { owner: key, detail: report.summary });
  return { status: 'FAILED', reason: report.summary };
}

/**
 * Open or present one project window on a user's explicit request. The payload may name the
 * project, but the decision to open rests on Main's own records: a project no capsule, open
 * window or boot identity carries is refused rather than opened under a name a renderer
 * invented. A request that names no project at all asks Main to present its own picker —
 * the renderer never guesses which project the user meant, and a cancelled picker stays
 * cancelled rather than opening something the user did not choose.
 *
 * The picker may answer with a folder instead of an id. That answer is resolved into a project id
 * here and the open then continues below unchanged, so a folder open and an id open end in the
 * same validation and the same window factory rather than in two paths that could drift apart.
 * The payload may also name a `folder` instead of a `projectId`: the directory is resolved
 * through the filesystem, adopted or minted by `projectIdForResolvedFolder` exactly as the
 * picker's folder answer is, and the open continues with the id that came back.
 */
async function openProjectWindow(payload: unknown, parent?: BrowserWindow | null): Promise<ProjectOpenResult> {
  let requested = payload && typeof payload === 'object' && 'projectId' in payload && typeof payload.projectId === 'string'
    ? payload.projectId.trim()
    : '';
  if (!requested) {
    // An explicit folder answers the question the picker's chooser would have asked: resolve
    // the directory to its project (adopt or mint) and continue into the same open below.
    const folder = payload && typeof payload === 'object' && 'folder' in payload && typeof payload.folder === 'string'
      ? payload.folder.trim()
      : '';
    if (folder) {
      // Same filesystem boundary the chooser's answer crosses: the anchor is the directory
      // itself, never an alias a later containment check would compare against.
      let resolved = '';
      try {
        resolved = fs.realpathSync(folder);
        if (!fs.statSync(resolved).isDirectory()) resolved = '';
      } catch {
        resolved = '';
      }
      if (!resolved) return { status: 'FAILED', reason: 'PROJECT_FOLDER_INVALID' };
      const fromFolder = projectIdForResolvedFolder(resolved);
      if ('result' in fromFolder) return fromFolder.result;
      requested = fromFolder.projectId;
    }
  }
  if (!requested) {
    recordLifecycleEvent('project-open.without-target', {});
    // One parent for both dialogs: the folder chooser belongs to the window whose picker the user
    // just answered, not to whatever window happens to be focused by the time it opens.
    const pickerParent = parent ?? BrowserWindow.getFocusedWindow();
    // `pickFolder` skips the candidate picker entirely: the "+" menu's "Mở dự án…" is the
    // request to open a NEW project from a directory, so the folder chooser is the answer —
    // the stored-inventory picker stays for the app-menu entry and the Ctrl+Shift+O route.
    const pickFolder = payload && typeof payload === 'object' && 'pickFolder' in payload && payload.pickFolder === true;
    if (pickFolder) {
      const fromFolder = await resolveProjectFromFolder(pickerParent);
      if ('result' in fromFolder) return fromFolder.result;
      requested = fromFolder.projectId;
    } else {
      const picked = await pickProjectToOpen(pickerParent);
      if (picked.kind === 'cancelled') return { status: 'CANCELLED' };
      if (picked.kind === 'folder') {
        const fromFolder = await resolveProjectFromFolder(pickerParent);
        if ('result' in fromFolder) return fromFolder.result;
        requested = fromFolder.projectId;
      } else {
        recordLifecycleEvent('project-open.picked', { projectId: picked.projectId });
        requested = picked.projectId;
      }
    }
  }
  let projectId: string;
  try {
    projectId = validateControlPlaneId(requested, 'project');
  } catch {
    return { status: 'FAILED', reason: 'INVALID_PROJECT_ID' };
  }
  if (!isKnownProjectId(projectId)) {
    return { status: 'FAILED', projectId, reason: 'UNKNOWN_PROJECT' };
  }
  try {
    // Opening a shell is new work: a committed quit has already counted and passed every
    // window it intends to end, so admitting one now would leave it alive outside the
    // teardown. Raised inside the try so the refusal is the same FAILED envelope every
    // other refusal uses, not a rejected invoke.
    assertApplicationAdmitsWork(closeReservations, 'Open project window');
    // Detached mode runs first: a `project:<id>` owner that is detached — by a live
    // detached shell or by the persisted marker a dead window left behind — can never
    // be presented by the hub. The open goes through the same detach path the menu
    // drives: a live shell is focused, a marked-but-dead one is recreated on demand.
    const detachedShell = liveProjectShells().find((s) => s.owner.kind === 'project' && s.owner.projectId === projectId);
    // The reattach latch extends this exclusivity, never replaces it: a project MID-
    // reattach is still marked on disk until the fold lands, but recreating its shell
    // here would resurrect the window the reattach is closing. The latch routes the
    // request to the hub path instead.
    const detachedMode = !reattachInProgress.has(projectId)
      && (detachedShell !== undefined || savedTabsOwnerIsDetached(savedTabsFilePath(), projectId));
    if (detachedMode) {
      const { shell, created } = await ensureDetachedProjectShell(projectId, 'user');
      focusShellWindow(shell);
      recordLifecycleEvent('project-open.detached', { projectId, created });
      broadcastProjectInventoryChanged();
      return created ? { status: 'OPENED', projectId } : { status: 'FOCUSED', projectId };
    }
    // Phương án A: opening a project never creates a project window. The singleton
    // 'web' hub is ensured and the project becomes its active project; OPENED means
    // the hub shell was just created, FOCUSED means the user joined a live hub.
    const { created } = await ensureProjectWindow({ kind: 'web' }, 'user', { activateProjectId: projectId });
    recordLifecycleEvent('project-open', { projectId, created });
    // A folder pick may just have created or adopted the project: every manager lists it now.
    broadcastProjectInventoryChanged();
    return created ? { status: 'OPENED', projectId } : { status: 'FOCUSED', projectId };
  } catch (err) {
    recordLifecycleEvent('project-open.failed', { projectId, detail: String(err) });
    return { status: 'FAILED', projectId, reason: redactCredentials(String(err)) };
  }
}

/**
 * The window a Space opens into: the project that owns the folder (adopted or created exactly as a
 * folder open does, no dialog), its window presented, and the host plus owner key its shells and
 * tabs belong to. The folder is already a realpath the route validated.
 */
async function openSpaceWindow(
  realFolder: string,
): Promise<{ ok: true; host: NativeTabHost; ownerKey: string } | { ok: false; message: string }> {
  const opened = await openProjectWindow({ folder: realFolder });
  if (opened.status !== 'OPENED' && opened.status !== 'FOCUSED') {
    return { ok: false, message: opened.status === 'FAILED' ? opened.reason : 'Project window was not opened' };
  }
  // The opened project lives in the shared web hub, never in a `project:` window, so the
  // project-scoped key resolves nothing directly — route to the hub host while keeping
  // the project owner key in the result for the downstream contract that reads it.
  const key = ownerKey({ kind: 'project', projectId: opened.projectId });
  const host = hostForOwnerKey(key) ?? hostForOwnerKey('web');
  if (!host) return { ok: false, message: 'The project window closed before its Space could open' };
  return { ok: true, host, ownerKey: key };
}

/**
 * Present the one shared-terminal-manager window: the Unassigned shell whose sidebar lists every
 * project's terminals and where a row is filed under another capsule.
 *
 * It is created through `ensureProjectWindow` like every other window — the same factory the
 * bootstrap and `antifan:project:open` use — so its host joins the window directory, its placement
 is its own owner-keyed record, and the close gate counts it. Callers are the application menu
 entry plus the renderer's "open a terminal window" routes (`POPOUT`/`NEW_WINDOW`), which
 delegate here through each host's `openTerminalManager` — there is exactly one such window.
 */
async function openSharedTerminalManagerWindow(): Promise<void> {
  try {
    // New work, treated exactly as `openProjectWindow` treats it: a committed quit has already
    // counted every window it intends to end, so admitting one now would leave it alive outside
    // the teardown.
    assertApplicationAdmitsWork(closeReservations, 'Open shared terminal manager window');
    const { created } = await ensureProjectWindow({ kind: 'unassigned' }, 'user');
    recordLifecycleEvent('terminal-manager-open', { created });
  } catch (err) {
    recordLifecycleEvent('terminal-manager-open.failed', { detail: redactCredentials(String(err)) });
  }
}

/** The user-visible inventory every window can search. Listing has no side effects at all. */
function searchProjectTabs(payload: unknown): ProjectTabSearchResult {
  const query = payload && typeof payload === 'object' && 'query' in payload && typeof payload.query === 'string'
    ? payload.query
    : '';
  return { status: 'OK', rows: collectTabSearchInventory(tabAuthorities.hosts(), query).map(toProjectSearchRow) };
}

/**
 * Present one exact tab, wherever it lives. The owner the user selected is re-derived
 * from Main's own inventory in the same tick as the lookup and revalidated by the
 * activation below: validation, selection and presentation happen with no await between
 * them, so a result that went stale cannot be retargeted to another tab and is reported
 * unavailable instead. Nothing here changes an attachment: a user's visual activation
 * never rotates agent authority.
 */
function activateProjectTab(payload: unknown): ProjectTabActivationResult {
  const tabId = payload && typeof payload === 'object' && 'tabId' in payload && typeof payload.tabId === 'string'
    ? payload.tabId
    : '';
  const hosts = tabAuthorities.hosts();
  const expectedOwnerKey = collectTabSearchInventory(hosts, '').find((row) => row.tabId === tabId)?.ownerKey ?? '';
  const activation = activateTabSearchResult(hosts, { tabId, expectedOwnerKey });
  if (!activation.ok) {
    return {
      status: 'UNAVAILABLE',
      tabId,
      reasonCode: activationFailureCode(activation.reason, tabId),
      reason: activation.reason,
    };
  }
  const activationHost = tabAuthorities.hostForTab(tabId);
  const activationShell = activationHost
    ? liveProjectShells().find((shell) => tabAuthorities.hostForShell(shell) === activationHost)
    : undefined;
  if (activationShell && !activationShell.window.isDestroyed()) {
    if (activationShell.window.isMinimized()) activationShell.window.restore();
    activationShell.window.show();
    activationShell.window.focus();
  }
  recordLifecycleEvent('tab-search.activated', { tabId, ownerKey: activation.ownerKey });
  return { status: 'ACTIVATED', tabId };
}

/**
 * The cross-window chrome entrypoints: they resolve their target per message — the
 * sender is authorized as a live chrome surface, then the window directory is asked
 * for the inventory, the exact tab, or the project window — which is what makes a
 * second project window legal. They ride the same declarative table as every other
 * chrome channel rather than a second registration path of their own.
 *
 * Exported for the live probe (`scripts/probe-project-windows.cjs`), which drives these
 * routes through the router's own dispatch seam: that seam shares the authorization path
 * of the registered handlers, so the probe cannot bypass the sender or surface gate.
 */
export const PROJECT_WINDOW_ROUTES: readonly IpcRoute[] = [
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_OPEN,
    surface: PROJECT_OPEN_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, event, args) => openProjectWindow(args[0], senderWindowFor(event)),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_LIST,
    surface: PROJECT_PICKER_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, event) => projectOpenListFor(event?.sender),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_OPEN_PICKER_ANSWER,
    surface: PROJECT_PICKER_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, event, args) => acceptProjectPickerAnswer(event?.sender, args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.FORCE_CLOSE_WINDOW,
    surface: PROJECT_OPEN_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, event) => forceCloseWindowForSender(event),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_RENAME,
    surface: PROJECT_OPEN_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, _event, args) => renameProjectEntry(args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_REMOVE,
    surface: PROJECT_OPEN_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, _event, args) => removeProjectEntry(args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_SET_APPEARANCE,
    surface: PROJECT_OPEN_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, _event, args) => setProjectAppearanceEntry(args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_DETACH,
    // Toolbar + sidebar only — the surfaces a user hand reaches the action through.
    // `PROJECT_OPEN_ROUTE_SURFACES` also names `terminalPopout`, which can never drive
    // a project detach.
    surface: ['toolbar', 'sidebar'],
    kind: 'handle',
    run: (_target, event, args) => detachProject(args[0], senderWindowFor(event)),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_REATTACH,
    // Same reachability rule as detach — a user-hand surface only. The action is
    // live while the detached shell is (the detached window's own chrome can drive
    // it); gating on shell state would make the affordance unreachable exactly
    // where it is needed.
    surface: ['toolbar', 'sidebar'],
    kind: 'handle',
    run: (_target, _event, args) => reattachProject(args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.PROJECT_REMOVE_ANSWER,
    surface: PROJECT_OPEN_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, _event, args) => answerProjectRemove(args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.TABS_SEARCH,
    surface: PROJECT_WINDOW_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, _event, args) => searchProjectTabs(args[0]),
  },
  {
    channel: PROJECT_WINDOW_CHANNELS.TABS_SEARCH_ACTIVATE,
    surface: PROJECT_WINDOW_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, _event, args) => activateProjectTab(args[0]),
  },
];

/**
 * Register the chrome table once for the whole process: the host's channels and these
 * cross-window entrypoints, installed together. The host's own install is then the
 * documented no-op (see ipc-router), which is what makes the second project window
 * legal. A table that did not land would leave the entrypoints answering nothing, so
 * the ledger is checked here rather than assumed.
 */
function installProjectWindowChromeRoutes(): void {
  installChromeIpcOnce([...NativeTabHost.CHROME_ROUTES, ...PROJECT_WINDOW_ROUTES]);
  const registered = listRegisteredChromeChannels();
  const missing = PROJECT_WINDOW_ROUTES.map((route) => route.channel).filter((channel) => !registered.includes(channel));
  if (missing.length > 0) {
    throw new Error(`Project-window chrome channels were not registered: ${missing.join(', ')}`);
  }
}

let powerResurfaceRegistered = false;

async function createWindow(): Promise<void> {
  windowStateManager = new WindowStateManager(StorageLocations.getConfigDir(), 1360, 880);

  // The project identity this build boots for. It keys the control plane and every
  // owner-keyed record, so it is resolved (and validated) once, before any window is
  // admitted. The boot shell itself is the singleton 'web' hub — project windows are
  // retired — with `projectId` as the hub's active project at first paint.
  const projectId = validateControlPlaneId(process.env.ANTIFAN_PROJECT_ID || DEFAULT_BOOT_PROJECT_ID, 'project');
  bootProjectIdValue = projectId;
  const owner: WindowOwner = { kind: 'web' };

  projectWindows = new ProjectWindowManager({
    // Labels come from Main's validated records, never from a renderer or a page:
    // the shell's title is the project identity, and the path label is what
    // disambiguates two projects that share a name. Placement is resolved for THIS
    // owner, so each window opens where its own project was last left.
    createShell: (shellOwner) => {
      // The manager defers this callback to a microtask, so the admission the request was
      // checked against can already be reserved by a quit that committed in between. This is
      // the point of creation and nothing below awaits, so the refusal is read here rather
      // than only where the request arrived.
      assertApplicationAdmitsWork(closeReservations, 'Create project window');
      const record = resolveWindowRecord(shellOwner);
      const placement = windowStateManager?.getValidBounds(ownerKey(shellOwner));
      return new ProjectWindowShell(
        {
          owner: shellOwner,
          title: record.title,
          pathLabel: record.pathLabel,
          icon: appIconPath(),
          bounds: {
            x: placement?.x,
            y: placement?.y,
            width: placement?.width ?? 1360,
            height: placement?.height ?? 880,
          },
          minWidth: 700,
          minHeight: 500,
          backgroundColor: '#080c14',
          // First paint stays the presenter's job (see `presentShellOnFirstPaint`): showing
          // at construction would skip the ready-to-show path and its benchmark marker.
          show: false,
        },
        { isOpen: false, width: 380 },
      );
    },
    presentShell: (shell) => {
      if (shell.window.isDestroyed()) return;
      // Position is per owner: presenting a project restores THAT project's saved
      // maximized/positioned state, never the state of the window created first.
      const placement = windowStateManager?.getValidBounds(ownerKey(shell.owner));
      if (placement?.isMaximized) shell.window.maximize();
      else if (typeof placement?.x !== 'number' || typeof placement?.y !== 'number') shell.window.center();
      shell.window.show();
      shell.window.focus();
    },
    // The `restore` join path: same per-owner placement, `showInactive` — a shell
    // the boot leg surfaces must never take focus from the window the user is in.
    presentShellInactive: (shell) => presentShellUnfocused(shell),
    // A partial close — some of a window's tabs, not the window — leaves the surviving
    // pages in a layout still sized for the tabs that went away. The host owns its tab
    // layout, so the restore is delegated to it; a host that refuses is recorded rather
    // than silently leaving the strip mis-laid out.
    restoreShellLayout: (shell, survivingTabIds) => {
      const host = tabAuthorities.hostForShell(shell);
      if (!host) return;
      if (!host.restoreSurvivingLayout(survivingTabIds)) {
        recordLifecycleEvent('window-layout.restore-failed', { owner: ownerKey(shell.owner), surviving: survivingTabIds.length });
      }
    },
    // Unregister before the shell's own teardown: a removed window must never be
    // resolvable from a stale mapping, and its host must stop touching views that are
    // about to be destroyed. Host disposal is also what persists this owner's tabs.
    onShellDisposed: (shell) => {
      const host = tabAuthorities.hostForShell(shell);
      tabAuthorities.unregister(shell);
      try {
        host?.dispose();
      } catch (err) {
        console.error('[antifan] Failed to dispose a closed window host:', err);
      }
    },
  });

  // Chrome IPC is registered once for the whole process (see ipc-router): this
  // resolver is how a message finds its window, and it is recomputed per message
  // so a destroyed renderer can never be served from a stale mapping. It must be in
  // place before the install below, which is the one install the process performs.
  setChromeSenderResolver((webContents) => tabAuthorities.resolveSender(webContents.id));
  // The chrome table is installed here, before any host exists, because the install is
  // once per process and it carries both halves: the host's per-window channels and the
  // cross-window entrypoints this file owns. A host constructed first would install the
  // half that does not include the project-opening and search channels.
  installProjectWindowChromeRoutes();

  // Bring up or re-attach to the detached terminal host daemon so GUI restarts
  // never kill live agent sessions or shell processes.
  if (process.env.ANTIFAN_USE_TERMINAL_DAEMON !== '0') {
    try {
      const spawnResult = await ensureDaemon();
      if (spawnResult.failures?.length) {
        // A host that came up via `detached` on Windows is the GUI's descendant: a tree kill of the
        // GUI takes every live terminal with it. Say so, with the reason the escape failed.
        console.warn(`[index] Terminal Host Daemon spawn fell back (mode=${spawnResult.mode}): ${spawnResult.failures.join(' | ')}`);
      }
      if (spawnResult.handle) {
        const proxy = new DaemonTerminalProxy({
          port: spawnResult.handle.port,
          token: spawnResult.handle.token,
        }, {
          // Re-attach if the recorded process is still alive; only a dead recorded PID
          // authorizes ensureDaemon to spawn a replacement from the reconnect path.
          respawn: () => ensureDaemon({ onlyIfDead: true }),
        });
        await proxy.connect();
        TerminalManager.setInstance(proxy as unknown as TerminalManager);
        console.log(`[index] Terminal Host Daemon connected (mode=${spawnResult.mode}, pid=${spawnResult.handle.pid}, port=${spawnResult.handle.port})`);
      } else {
        console.warn(`[index] Terminal Host Daemon unavailable (${spawnResult.reason || 'unknown'}); falling back to in-process TerminalManager`);
      }
    } catch (err) {
      console.warn('[index] Failed to initialize Terminal Host Daemon, falling back to in-process:', err);
    } finally {
      terminalDaemonInitialized = true;
    }
  } else {
    terminalDaemonInitialized = true;
  }

  // Canonical single TerminalManager / DaemonTerminalProxy instance shared across
  // UI IPC, Bridge, NativeTabHost, control-plane capabilities, and theme transactions.
  const terminalManager = TerminalManager.getInstance();
  await rehomeBootProjectTerminals(terminalManager);

  // One `data` listener for the whole process: the router owns the
  // sessionId→host map and hands each chunk to the windows that present it,
  // replacing the per-host listener+filter fan-out.
  TerminalOutputRouter.getInstance().attach(terminalManager as unknown as EventEmitter);

  const workspaceId = validateControlPlaneId(process.env.ANTIFAN_WORKSPACE_ID || DEFAULT_BOOT_WORKSPACE_ID, 'workspace');
  /**
   * Measured affiliation of a tab: the capsule it was created under, read off the live host rather
   * than the capsule ledger (which holds entries no runtime path writes). Shared by the control
   * plane's terminal-origin gate and the browser port, so both refuse a foreign bound tab on the
   * same evidence instead of two copies that can drift apart.
   */
  // A bound id no live host owns measures undefined — never the ambient host's guess,
  // so a dead binding cannot inherit the first window's project.
  const measuredTabAffiliation = (tabId: string): { projectId?: string; workspaceId?: string; capsuleId?: string } | undefined =>
    tabAmbient.measuredTabAffiliation(tabId);

  controlPlane = new ControlPlaneRuntime({
    projectId,
    workspaceId,
    dataRoot: StorageLocations.getControlPlaneDir(),
    allowEval: ALLOW_EVAL,
    terminal: terminalManager,
    projects: projectRegistry,
    // Terminal ownership for attachment-bound calls: the host's live tab affinity is the single
    // source of truth already used by the Bridge gate, so both planes refuse a foreign shell the
    // same way. Without this the control plane had no owner notion at all and every attachment
    // shared one terminal namespace.
    terminalAuthority: {
      allowsTab: (tabId, terminalId) => (hostForTabOrDegrade(tabId, 'terminalAuthority.allowsTab')?.isTerminalAllowedForTab(tabId, terminalId) ?? false),
      isAgentTerminal: (terminalId) => tabAuthorities.terminalHasLiveAgentAffinity(terminalId),
      // A dead tab answers `false` rather than throwing, so the capability can roll the fresh PTY
      // back; anything the bind itself throws is a real fault and reaches the capability as is.
      bind: (terminalId, generation, tabId) =>
        hostForTabOrDegrade(tabId, 'terminalAuthority.bind')?.bindTerminalAgentAffinity(terminalId, generation, tabId) ?? false,
      tabAffiliation: (tabId) => {
        const host = hostForTabOrDegrade(tabId, 'terminalAuthority.tabAffiliation');
        if (!host || !host.hasTab(tabId)) {
          return { live: false };
        }
        return {
          live: true,
          capsuleId: host.getTabCapsuleId(tabId),
        };
      },
    },
    artifactStoreOptions: resolveArtifactStoreOptionsFromEnv(),
    getAutomationTabId: () => {
      for (const h of tabAuthorities.hosts()) {
        const id = h.getAutomationTabId();
        if (id) return id;
      }
      return null;
    },
    getDocumentGeneration: (tabId) => hostForTabOrDegrade(tabId, 'controlPlane.getDocumentGeneration')?.getDocumentGeneration(tabId) ?? 1,
    isTabAllowed: (primaryTabId, requestedTabId) => (hostForTabOrDegrade(primaryTabId, 'controlPlane.isTabAllowed')?.isTabAllowedForPrimary(primaryTabId, requestedTabId) ?? false),
    resolveTabId: (id) => {
      if (!id) return undefined;
      for (const host of tabAuthorities.hosts()) {
        const resolved = host.resolveTargetTabId(id);
        if (resolved) return resolved;
      }
      return undefined;
    },
    resolveFailoverTabId: (staleTabId) => {
      if (!staleTabId) return undefined;
      for (const host of tabAuthorities.hosts()) {
        const target = host.getFailoverTargetTab(staleTabId);
        if (target) return target;
      }
      return undefined;
    },
    releaseSessionTab: (sessionId, tabId) => (hostForTabOrDegrade(tabId, 'controlPlane.releaseSessionTab')?.releaseSessionTab(sessionId, tabId) ?? false),
    releaseSessionTabPool: (sessionId) => {
      let anyReleased = false;
      for (const host of tabAuthorities.hosts()) {
        if (host.releaseSessionTabPool(sessionId)) anyReleased = true;
      }
      return anyReleased;
    },
    // Terminal-origin MCP authority is minted under, and re-measured against, the terminal's
    // measured scope — never the caller's cwd. Capsule-exact first: the terminal's own workspace
    // capsule names one workspace even when its project holds several. A row with no capsule, or one
    // whose affiliation is incomplete, declines here on purpose, so the runtime's owner-key fallback
    // and its fail-closed TERMINAL_SCOPE_UNRESOLVED stay the reachable paths rather than being
    // short-circuited by a guess.
    resolveTerminalProjectScope: (terminalSessionId: string) => {
      const capsuleId = terminalManager.sessionCapsuleId(terminalSessionId);
      if (!capsuleId) return undefined;
      const capsule = capsuleManager?.list().find((c) => c.id === capsuleId);
      if (!capsule?.projectId || !capsule.workspaceId) return undefined;
      return { projectId: capsule.projectId, workspaceId: capsule.workspaceId };
    },
    // A bound tab that provably belongs to another project than the attachment is refused with
    // POLICY_DENIED, so the runtime gates on the same measured affiliation the browser port uses.
    resolveTabAffiliation: measuredTabAffiliation,
  });

  // Synchronize capsule affiliations into the shared ProjectRegistry before opening any window
  if (capsuleManager) {
    synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  }
  runStateService = new RunStateService({
    runsDir: path.join(StorageLocations.getRuntimeDir(), 'runs'),
    lookupSession: (terminalSessionId) => {
      const session = terminalManager.getSession(terminalSessionId);
      if (!session) return undefined;
      const ownerKey = terminalManager.sessionOwnerKey(session.id);
      return {
        id: session.id,
        owner: ownerKey,
        ownerKey,
        capsuleId: terminalManager.sessionCapsuleId(session.id),
        ...(typeof ownerKey === 'string' && ownerKey.startsWith('agent:') ? { agentHeld: agentHoldsTerminal(session.id) } : {}),
      };
    },
    listSessions: () =>
      terminalManager.listSessions().map((s) => {
        const ownerKey = terminalManager.sessionOwnerKey(s.id);
        return {
          id: s.id,
          owner: ownerKey,
          ownerKey,
          capsuleId: terminalManager.sessionCapsuleId(s.id),
        };
      }),
    lookupCapsule: (terminalSessionId) => terminalManager.sessionCapsuleId(terminalSessionId),
    lookupCapsuleBrief: (capsuleId) => {
      const brief = capsuleManager?.getBrief(capsuleId);
      if (!brief || !brief.ok || !brief.brief) return undefined;
      return { brief: brief.brief, updatedAt: Date.now() };
    },
    lookupAttachment: (terminalSessionId) => {
      if (!controlPlane) return undefined;
      const registry = controlPlane.runs.attachments;
      for (const id of registry.getActiveRecordIds()) {
        const rec = registry.getRecord(id);
        if (rec && rec.originTerminalSessionId === terminalSessionId) {
          return {
            runId: rec.runId,
            attemptId: rec.attemptId,
            backendId: rec.backendId,
          };
        }
      }
      return undefined;
    },
  });
  runStateService.start();
  for (const host of tabAuthorities.hosts()) {
    host.setRunStateService(runStateService);
  }

  // Waking from sleep or unlocking the screen can leave a window's presented tab white
  // (renderer alive, surface gone). One process-wide listener asks every window to
  // re-present; each host skips itself when hidden, minimized or showing nothing. Registered
  // once per process: `createWindow` can run again on `activate`.
  if (!powerResurfaceRegistered) {
    powerResurfaceRegistered = true;
    const resurfaceAllWindows = (trigger: 'resume' | 'unlock-screen'): void => {
      for (const host of tabAuthorities.hosts()) {
        try { host.resurfacePresentedView(trigger); } catch {}
      }
    };
    powerMonitor.on('resume', () => resurfaceAllWindows('resume'));
    powerMonitor.on('unlock-screen', () => resurfaceAllWindows('unlock-screen'));
  }

  // Every window — this one and every later one — goes through the same factory. The startup
  // window is also presented by it (see `presentShellOnFirstPaint`), so the user sees chrome as
  // soon as the renderer paints instead of waiting for the ~4s ledger/attachments replay — and
  // the measurement of that moment is armed with the presentation itself, never by a second
  // presenter racing it for the same window.
  const { shell, host: bootstrapHost } = await ensureProjectWindow(owner, 'user', {
    // The boot project is the hub's active project from its first paint: the call
    // inside the factory sets `setActiveProject` plus the workspace affiliation and
    // seeding, before any tab is restored.
    activateProjectId: projectId,
    onFirstPresented: () => {
      recordBenchmark({ surface: 'startup', name: 'firstVisible' });
      recordProcessMetrics('afterFirstVisible');
      startProcessMetricsSampling();
    },
  });
  bootstrapShell = shell;
  recordBenchmark({ surface: 'startup', name: 'windowCtor' });

  // Set Top Menubar (File, Edit, Selection, View, Go, Run, Terminal, Help)
  installApplicationMenu();

  // Finish control-plane init (async relative to the window show above; the
  // renderer already painted and is interactive). The ledger/attachment replay
  // is CPU-bound JSON.parse+sha256 per frame — on populated profiles it
  // saturates the main thread for seconds. Start it only after the window is
  // visible (or a bounded fallback) so first paint is never queued behind it.
  const initDone = Promise.withResolvers<void>();
  let initStarted = false;
  const startControlPlaneInit = () => {
    if (initStarted) return;
    initStarted = true;
    controlPlane!.initialize().then(initDone.resolve, initDone.reject);
  };
  if (shell.window.isVisible()) {
    setTimeout(startControlPlaneInit, 0);
  } else {
    shell.window.once('ready-to-show', () => setTimeout(startControlPlaneInit, 0));
    setTimeout(startControlPlaneInit, 1500);
  }
  await initDone.promise;
  startLifecycleHeartbeat();
  // The bootstrap host got everything that existed when it was built; the control plane
  // only exists now, so this is where it (and the phone status behind it) reaches the
  // window. Later windows get both from the same helper (see `attachSharedServices`).
  attachSharedServices(bootstrapHost);

  // Boot restore, after the hub's own restore+fold write has completed and the
  // control plane is attached: every marked `detached:true` `project:<id>`
  // record whose project still validates gets its shell back, sequentially and
  // unfocused ('restore' intent — zero focus steals from this leg). Records a
  // dead project owns are refused and left on disk for purge; hosts restored
  // here still receive the browser-port gate through the `hosts()` re-attach
  // pass below.
  await restoreDetachedProjectShells();

  // One reservation table for both seams, installed before either can serve a request:
  // the registry refuses a mint, a rebind or an adoption onto a page a close attempt has
  // reserved (a binding that arrived during unload would be destroyed with the page), and
  // the transport refuses dispatch whose admitted operation the gate could not measure.
  controlPlane.runs.attachments.setCloseAdmission(closeReservations);
  controlPlane.transport.setCloseAdmission(closeReservations);
  const browserPortLocal = new BrowserControlPort({
    hasTab: (tabId) => Boolean(tabId && tabAuthorities.hostForTab(tabId) !== undefined),
    resolveTargetTabId: (tabId) => {
      if (!tabId) return undefined;
      for (const host of tabAuthorities.hosts()) {
        const resolved = host.resolveTargetTabId(tabId);
        if (resolved) return resolved;
      }
      return undefined;
    },
    adoptChildTab: (primaryOrBoundTabId, childTabId) => hostForTabOrBootstrap(primaryOrBoundTabId).adoptChildTabForBoundTab(primaryOrBoundTabId, childTabId),
    getManagedTabIds: (primaryOrBoundTabId) => hostForTabOrDegrade(primaryOrBoundTabId, 'port.getManagedTabIds')?.getManagedTabIdsForBoundTab(primaryOrBoundTabId) ?? new Set(),
    noteAgentTabActivity: (tabId) => {
      if (!tabId) return;
      tabAuthorities.hostForTab(tabId)?.noteAgentTabActivity(tabId);
    },
    isTabAllowed: (primaryOrBoundTabId, requestedTabId) => (hostForTabOrDegrade(primaryOrBoundTabId, 'port.isTabAllowed')?.isTabAllowedForPrimary(primaryOrBoundTabId, requestedTabId) ?? false),
    getTabList: () => tabAuthorities.hosts().flatMap((h) => h.getTabList()),
    getSessionTabList: (boundTabId) => hostForTabOrDegrade(boundTabId, 'port.getSessionTabList')?.getSessionTabRecords(boundTabId) ?? [],
    getFailoverTargetTab: (tabId) => {
      if (!tabId) return undefined;
      for (const host of tabAuthorities.hosts()) {
        const target = host.getFailoverTargetTab(tabId);
        if (target) return target;
      }
      return undefined;
    },
    getBrowserEpoch: () => tabAuthorities.hosts().reduce((max, h) => Math.max(max, h.getBrowserEpoch()), 1),
    // Diagnostic only: the port labels a tab "active" in its render-surface snapshot
    // with this. Active-ness is a property of a tab's OWN window and this dependency
    // takes no tab id, so with several windows live the only honest answer is "unknown"
    // ('') — never whichever window was created first. The automation-target owner is
    // unambiguous and answers for real.
    getActiveTabId: () => {
      const hosts = tabAuthorities.hosts();
      const automationHost = hosts.find((h) => h.getAutomationTabId() != null);
      if (automationHost) return automationHost.getActiveTabId();
      return hosts.length === 1 ? hosts[0]!.getActiveTabId() : '';
    },
    getAutomationTabId: () => {
      for (const h of tabAuthorities.hosts()) {
        const id = h.getAutomationTabId();
        if (id) return id;
      }
      return null;
    },
    setAutomationTabId: (tabId) => {
      for (const h of tabAuthorities.hosts()) {
        if (tabId && h.hasTab(tabId)) {
          h.setAutomationTabId(tabId);
        } else {
          h.setAutomationTabId(undefined);
        }
      }
    },
    resolveTabAffiliation: measuredTabAffiliation,
    createTab: (url, activate = false, options) => {
      // `anchorTabId` selects the window; the host would not know what to do with it,
      // so it is consumed here and never forwarded.
      const { anchorTabId, ...hostOptions } = options ?? {};
      return hostForTabOrBootstrap(anchorTabId).createTab(url, activate, hostOptions);
    },
    closeTab: (tabId, source) => hostForTabOrBootstrap(tabId).closeTab(tabId, source),
    switchTab: (tabId, opts) => hostForTabOrBootstrap(tabId).switchTab(tabId, opts),
    trySwitchTab: (tabId, opts) => hostForTabOrBootstrap(tabId).trySwitchTab(tabId, opts),
    navigate: (tabId, url) => hostForTabOrBootstrap(tabId).navigateAndWait(tabId, url),
    navigateAndWait: (tabId, url, timeoutMs) => hostForTabOrBootstrap(tabId).navigateAndWait(tabId, url, timeoutMs),
    // The failure record is per-host: route the lookup to the tab's own window or
    // a genuine NAVIGATION_* miss serializes as TARGET_STALE (the retired blanket
    // code) because the composite itself keeps no record map.
    getLastNavigationFailure: (tabId) => hostForTabOrBootstrap(tabId).getLastNavigationFailure(tabId),
    reload: (tabId: string) => hostForTabOrBootstrap(tabId).reloadAndWait(tabId),
    getTabDebugger: (tabId: string) => {
      const wc = hostForTabOrBootstrap(tabId).getTabWebContents(tabId, 'desktop');
      return wc && !wc.isDestroyed() ? wc.debugger : undefined;
    },
    getDom: (selector, tabId, paneId) => hostForTabOrBootstrap(tabId).getDom(selector, tabId, paneId),
    captureScreenshot: (rect, tabId, paneId, options) => hostForTabOrBootstrap(tabId).captureScreenshot(rect as Electron.Rectangle | undefined, tabId, paneId, options),
    captureVerificationScreenshot: (rect, tabId, paneId, options) => hostForTabOrBootstrap(tabId).captureVerificationScreenshot(rect as Electron.Rectangle | undefined, tabId, paneId, options),
    drainTarget: (tabId, paneId, timeoutMs) => hostForTabOrBootstrap(tabId).drainTarget(tabId, paneId, timeoutMs),
    readRenderSurface: (tabId, paneId, timeoutMs) => hostForTabOrBootstrap(tabId).readRenderSurface(tabId, paneId, timeoutMs),
    reapplyTabGeometry: (tabId, paneId, before) => hostForTabOrBootstrap(tabId).reapplyTabGeometry(tabId, paneId, before),
    evalJs: (expression, tabId, paneId, userGesture, timeoutMs) => hostForTabOrBootstrap(tabId).evalJs(expression, tabId, paneId, userGesture, timeoutMs),
    evalJsInFrame: (expression, frameUrl, tabId, paneId, userGesture, timeoutMs) => hostForTabOrBootstrap(tabId).evalJsInFrame(expression, frameUrl, tabId, paneId, userGesture, timeoutMs),
    getNetworkTracker: () => ({
      isAttached: (tabId, paneId) => hostForTabOrBootstrap(tabId).getNetworkTracker().isAttached(tabId, paneId),
      awaitQuiescence: (tabId, paneId, options, signal) => hostForTabOrBootstrap(tabId).getNetworkTracker().awaitQuiescence(tabId, paneId, options, signal),
      getInflightSnapshot: (tabId, paneId) => hostForTabOrBootstrap(tabId).getNetworkTracker().getInflightSnapshot?.(tabId, paneId) ?? [],
    }),
    getDiagnostics: (tabId, level) => hostForTabOrBootstrap(tabId).getDiagnostics(tabId, level),
    runResponsiveCheck: (params) => {
      const tabId = typeof params === 'object' && params ? params.tabId : undefined;
      const host = hostForTabOrBootstrap(tabId);
      return host.runResponsiveCheck(params);
    },
    agentTrajectory: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentTrajectory(params);
    },
    dispatchAgentAction: (action, params) => {
      const tabId = typeof params === 'object' && params && 'tabId' in params && typeof params.tabId === 'string' ? params.tabId : undefined;
      const host = hostForTabOrBootstrap(tabId);
      return host.dispatchAgentAction(action, params as unknown as Parameters<NativeTabHost['dispatchAgentAction']>[1]);
    },
    agentMove: (args) => {
      const host = hostForTabOrBootstrap(args.tabId);
      return host.agentMove(args);
    },
    agentClick: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentClick(params);
    },
    agentType: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentType(params);
    },
    agentScroll: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentScroll(params);
    },
    agentHover: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentHover(params);
    },
    agentHighlight: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentHighlight(params);
    },
    agentClear: (tabId, paneId) => hostForTabOrBootstrap(tabId).agentClear(tabId, paneId),
    agentDrag: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentDrag(params);
    },
    setTrackerIsolation: (tabId, paneId, active) => (active
      ? hostForTabOrBootstrap(tabId).beginTrackerIsolation(tabId, paneId).then((receipt) => ({ active: receipt.active, reason: receipt.degradedReason }))
      // `active` means "isolation is still applied to this target", matching
      // `isTrackerIsolationActive`. A failed rollback leaves the blocklist in
      // place, so reporting `active: false` here would tell the QA workflow and
      // the port that a tab which is still blocked was released cleanly.
      : hostForTabOrBootstrap(tabId).endTrackerIsolation(tabId, paneId).then((receipt) => (receipt.released
        ? { active: false, reason: receipt.reason }
        : { active: true, reason: receipt.reason }))),
    agentSnapshot: (tabId, paneId) => hostForTabOrBootstrap(tabId).agentSnapshot(tabId, paneId),
    agentFind: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.agentFind(params);
    },
    sendKeyboardPress: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.sendKeyboardPress(params);
    },
    setViewportSize: (options) => {
      const host = hostForTabOrBootstrap(options.tabId);
      return host.setViewportSize(options);
    },
    setDevicePreset: (tabId, presetId) => hostForTabOrBootstrap(tabId).setDevicePreset(tabId, presetId),
    getDevicePresets: () => sharedServiceHostOrThrow().getDevicePresets(),
    setZoom: (tabId, zoomFactor) => hostForTabOrBootstrap(tabId).setZoom(tabId, zoomFactor),
    // The inspector is a per-window overlay and this dependency names no window: the
    // window an agent authority is pinned to answers for itself, a single-window process
    // is unambiguous, and anything else refuses instead of toggling the inspector in
    // whichever window happened to be created first.
    toggleInspect: () => ambientHostOrThrow().toggleInspect(),
    toggleSplitReview: (tabId, enabled) => hostForTabOrBootstrap(tabId).toggleSplitReview(tabId, enabled),
    isCurrentTarget: (target) => {
      if (!target?.tabId) return false;
      const host = tabAuthorities.hostForTab(target.tabId);
      return host ? host.isCurrentTarget(target) : false;
    },
    clearAllAgentWorking: () => {
      for (const host of tabAuthorities.hosts()) {
        host.clearAllAgentWorking();
      }
    },
    getDocumentGeneration: (tabId) => hostForTabOrDegrade(tabId, 'port.getDocumentGeneration')?.getDocumentGeneration(tabId) ?? 1,
    bumpDocumentGeneration: (tabId) => hostForTabOrBootstrap(tabId).bumpDocumentGeneration(tabId),
    getMutationRevision: (tabId) => hostForTabOrBootstrap(tabId).getMutationRevision(tabId),
    bumpMutationRevision: (tabId) => hostForTabOrBootstrap(tabId).bumpMutationRevision(tabId),
    uploadFileInput: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.uploadFileInput(params);
    },
    dropFiles: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.dropFiles(params);
    },
    executeActionSequence: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.executeActionSequence(params as ActionSequenceParams);
    },
    inspectStyles: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.inspectStyles(params);
    },
    inspectRegion: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.inspectRegion(params);
    },
    inspectFont: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.inspectFont(params);
    },
    getMatchedStylesForNode: (params) => {
      const host = hostForTabOrBootstrap(params.tabId);
      return host.getMatchedStylesForNode(params);
    },
  }, controlPlane.artifacts);
  // Published for windows opened later: `attachSharedServices` hands this same port's
  // viewport gate to every host it builds, so a new window is never left ungated.
  browserPort = browserPortLocal;
  // Same reservation table as every other consumer: the port's background pools and wait
  // registry refuse work for a page under close, and register the work they admit, so a
  // close can never destroy a page out from under an operation it did not see.
  browserPortLocal.setCloseAdmission(closeReservations);
  recordBenchmark({ surface: 'startup', name: 'browserPortReady' });
  for (const host of tabAuthorities.hosts()) {
    host.setViewportGate(browserPortLocal.viewportGate);
  }
  // The QA cockpit seam: same tab-authority routing as the browser port, so a
  // bound tab id always lands on its owning host and a dead id degrades to a
  // refusal instead of drifting to the ambient window.
  const cockpitPortLocal = new CockpitPort({
    hasTab: (tabId) => Boolean(tabId && tabAuthorities.hostForTab(tabId) !== undefined),
    getTabUrl: (tabId) => hostForTabOrDegrade(tabId, 'cockpit.getTabUrl')?.getTabUrl(tabId) ?? '',
    resolveTabWorkspaceRoot: (tabId, tabUrl) => hostForTabOrDegrade(tabId, 'cockpit.resolveTabWorkspaceRoot')?.resolveTabWorkspace(tabId, tabUrl) ?? '',
    navigateAndWait: (tabId, url, timeoutMs) => hostForTabOrBootstrap(tabId).navigateAndWait(tabId, url, timeoutMs),
    runThemeQa: (tabId, options) => hostForTabOrBootstrap(tabId).runThemeQa(tabId, options),
    getThemeQaState: (tabId) => hostForTabOrBootstrap(tabId).getThemeQaState(tabId),
    checklistLoad: (tabId, input) => hostForTabOrBootstrap(tabId).themeChecklistLoad(input),
    checklistMutate: (tabId, input) => hostForTabOrBootstrap(tabId).themeChecklistMutate(input),
    checklistSave: (tabId, input) => hostForTabOrBootstrap(tabId).themeChecklistSave(input),
  });
  cockpitPort = cockpitPortLocal;
  controlPlane.registerBrowser(browserPortLocal, cockpitPortLocal);
  recordBenchmark({ surface: 'startup', name: 'browserRegistered' });

  // Tier-2 reality gate: the physical phone is registered as a peer adapter beside the browser port,
  // never inside it. Its lifecycle (attachment epoch + automation session generation) is independent
  // of tab/document generation, and it stages evidence into the same artifact store.
  const deviceManager = new DeviceManager({
    projectId: controlPlane.getLease().projectId,
    workspaceId: controlPlane.getLease().workspaceId || '',
    runtimeId: controlPlane.getLease().runtimeId,
  });
  const deviceAdapterLocal = new IosDeviceAdapter({ devices: deviceManager, artifacts: controlPlane.artifacts });
  deviceAdapter = deviceAdapterLocal;
  controlPlane.registerDevice(deviceAdapterLocal, deviceManager);
  recordBenchmark({ surface: 'startup', name: 'deviceRegistered' });
  // `setControlPlane` above ran before the device surface existed, so its status query correctly saw an
  // unregistered adapter. Now that the port is live, re-read and push the real state instead of letting
  // the toolbar wait for its next poll tick to stop showing "not registered yet".
  for (const host of tabAuthorities.hosts()) {
    host.refreshPhoneStatus();
  }

  const capabilityTransport = controlPlane.transport;

  // One-time migration of legacy capsule partitions to the unified profile
  // partitions (persist:capsule-* -> persist:profile-*). Marker-gated and
  // local-only; never touches a Chrome profile.
  //
  // The reclaim pass below is chained behind this promise, never run beside it:
  // reading a partition opens its cookie database, which holds the partition
  // directory open for the life of the process, so a reclaim racing the read
  // either fails on a locked directory or — worse — deletes the very store the
  // migration is copying from. Chained, the reclaim sees a settled disk: the
  // stores the migration just read are deferred to the next launch, and by then
  // the done marker makes the migration a no-op, so nothing holds them.
  const legacyMigration = bootstrapHost
    .migrateLegacyCapsuleToProfile()
    .then((res) => {
      if (res.migrated > 0) {
        console.log(`[antifan] Migrated ${res.migrated} cookies from legacy capsule partitions to profile partitions`);
      }
    })
    .catch((err) => console.warn('[antifan] Capsule->profile migration failed:', err));

  /** Reclaims Chromium state nothing can reach, once the migration has settled. */
  const reclaimDeadStores = () => {
    // Runs after the tab list exists so every live partition vetoes its own
    // deletion; dry-run first so the exact inventory is
    // journaled before a single byte is removed.
    const host = sharedServiceHostOrThrow();
    try {
      // Every partition a tab currently owns, plus every partition the profile
      // resolver can derive for a real Chrome profile. The second half matters
      // because a Chrome profile directory may legitimately be named
      // `capsule-<something>`: its derived partition lands in the same namespace
      // the dead-store pattern matches, and only this list can tell them apart.
      const derivableProfiles: string[] = [];
      try {
        for (const profile of ChromeProfileSyncManager.getInstance().getAvailableProfiles()) {
          if (!profile?.id) continue;
          derivableProfiles.push(host.getSharedProfilePartition('clean', false, profile.id));
          derivableProfiles.push(host.getSharedProfilePartition('native', false, profile.id));
        }
      } catch (err) {
        console.warn('[antifan] Chrome profile enumeration for housekeeping failed:', err);
      }
      const cleanupTargets = {
        profileDir: persistentUserData,
        configDir: StorageLocations.getConfigDir(),
        livePartitions: [...tabAuthorities.hosts().flatMap((h) => h.getLivePartitionNames()), ...derivableProfiles],
      };
      const planned = pruneDeadStores({ ...cleanupTargets, dryRun: true });
      recordLifecycleEvent('housekeeping.deadStores.planned', { ...planned });
      const applied = pruneDeadStores(cleanupTargets);
      recordLifecycleEvent('housekeeping.deadStores.applied', { ...applied });
      if (applied.deletedPartitions.length > 0 || applied.deletedFiles.length > 0) {
        console.log(
          `[antifan] Reclaimed ${(applied.reclaimedBytes / (1024 * 1024)).toFixed(1)} MB: ` +
          `${applied.deletedPartitions.length} dead partitions, ${applied.deletedFiles.length} orphan files` +
          (applied.skippedPartitions.length > 0 ? ` (${applied.skippedPartitions.length} skipped: live)` : '') +
          (applied.deferredPaths.length > 0 ? ` (${applied.deferredPaths.length} deferred: in use)` : '')
        );
      }
    } catch (err) {
      console.warn('[antifan] Dead-store housekeeping failed:', err);
    }
  };
  void legacyMigration.then(reclaimDeadStores);
  // Start Bridge Server + Native Messaging IPC past first paint. The
  // BridgeServer constructor pays synchronous icacls/powershell DACL spawns
  // (~4s on Windows) for the pairing queue, and start() pays more for
  // bridge-info persistence — all main-thread work that stalled window
  // creation. Neither the bridge socket nor the IPC pipe is needed before the
  // user interacts; both come up ~1.5s after first paint.
  const startBridgeAndIpc = async () => {
    // Fail-closed against a quit racing the 1.5s deferral: never construct or
    // keep a listener alive after shutdown began.
    if (isShuttingDown) return;
    const host = bootstrapHost;
    const plane = controlPlane!;
    bridgeServer = new BridgeServer(
      host,
      Number(process.env.ANTIFAN_BRIDGE_PORT) || (IS_PROD ? 20129 : 20130),
      IS_DEV,
      capabilityTransport,
      () => {
        const lease = plane.getLease();
        // Dual-Plane Runtime Isolation: bind the agent's authority to a dedicated
        // automation tab, never the user's active foreground tab. This prevents any
        // MCP/CLI session bootstrapping without an explicit target from latching onto
        // and hijacking the user's working tab.
        // The hub that answers is the live one: a hub closed while siblings kept the process
        // running is reopened as a new host, and the boot-time one is disposed with no tabs.
        const hubHost = hostForOwnerKey('web') ?? host;
        const automationTarget = hubHost.getAutomationTarget() as
          | { tabId: string; url?: string; documentGeneration?: number }
          | undefined;
        const targetTabId = automationTarget?.tabId;
        if (!targetTabId) {
          // Unbound authority: no ambient fallback. Agent sessions must explicitly
          // provision a target via antifan.cli.startSession, which creates a dedicated
          // background agent tab. Return undefined so unbound tools fail-closed instead
          // of capturing the user's active tab.
          return { lease, projectId, workspaceId, browserTarget: undefined };
        }
        return {
          lease,
          projectId,
          workspaceId,
          browserTarget: {
            projectId,
            workspaceId,
            runtimeId: lease.runtimeId,
            tabId: targetTabId,
            browserEpoch: 1,
            documentGeneration:
              typeof hubHost.getDocumentGeneration === 'function'
                ? hubHost.getDocumentGeneration(targetTabId)
                : 1,
            url: automationTarget?.url,
          },
        };
      },
      plane.runs.attachments,
      '127.0.0.1',
      plane
    );
    bridgeServer.setControlPlane(plane);
    bridgeServer.setCloseAdmission(closeReservations);
    // Mint routing: a terminal's agent anchor must be created on the window that owns
    // the terminal and stamped with the terminal's own capsule — never the bootstrap
    // host or the process-wide ambient capsule. Detached `project:<id>` claims route
    // to the project's own shell while it lives and REFUSE (typed, never hub) while
    // the project is detached-but-windowless — a marked dead record or an in-flight
    // reattach means the hub does not own this project. See `createBridgeMintHostResolver`.
    bridgeServer.setMintHostResolver(createBridgeMintHostResolver({
      hostForTab: (tabId) => tabAuthorities.hostForTab(tabId) ?? null,
      hostForOwnerKey: (ownerKeyValue) => hostForOwnerKey(ownerKeyValue),
      sessionCapsuleId: (terminalSessionId) => terminalManager.sessionCapsuleId(terminalSessionId),
      sessionOwnerKey: (terminalSessionId) => terminalManager.sessionOwnerKey(terminalSessionId),
      capsuleExists: (capsuleId) => capsuleManager?.list().some((c) => c.id === capsuleId) === true,
      projectCapsuleId: (projectId) => resolveProjectAssignment(projectId)?.capsuleId,
      projectDetached: (projectId) => reattachInProgress.has(projectId)
        || liveProjectShells().some((s) => s.owner.kind === 'project' && s.owner.projectId === projectId)
        || savedTabsOwnerIsDetached(savedTabsFilePath(), projectId),
      isBootProject: (projectId) => projectId === bootProjectIdValue,
      ensureHubHost: async () => {
        const live = hostForOwnerKey('web');
        if (live) return live;
        // The hub was closed while sibling windows kept the process running. Agent intent
        // reopens it without raising it; the next user open presents it.
        const { host, created } = await ensureProjectWindow({ kind: 'web' }, 'agent');
        if (created) recordLifecycleEvent('hub.reopened-off-screen', { reason: 'agent-mint' });
        return host;
      },
    }));
    // Direct-RPC tab ops (switch/close/getDOM/capture/evalJS/navigate/reload/goBack/
    // goForward) act on the window's host that owns the resolved tab — not the
    // bootstrap host. Without this seam a minted tab living on a second window is
    // unreachable via RPC (TARGET_CLOSED on the wrong host, foreign-window
    // getActiveTabId defaults). This is the same authority index the mint resolver
    // consults.
    bridgeServer.setTabHostResolver((tabId) => tabAuthorities.hostForTab(tabId));
    recordBenchmark({ surface: 'startup', name: 'bridgeCtor' });
    const bridgePort = await bridgeServer.start();
    recordBenchmark({ surface: 'startup', name: 'bridgeStarted' });
    // Terminals spawned by this instance carry this instance's own endpoint identity.
    TerminalManager.getInstance().setBridgeEndpoint({ port: bridgePort, host: '127.0.0.1', pid: process.pid });

    // Windows Native Messaging Local IPC Server — re-check shutdown: the
    // bridge start above awaited, and a quit may have landed meanwhile.
    if (process.platform === 'win32' && !isShuttingDown) {
      try {
        localIpcServer = new LocalIpcServer();
        await localIpcServer.start(bridgePort, () => {
          const activeCapsule = capsuleManager?.getActive();
          const activePartition = sharedServiceHostOrThrow().getSharedProfilePartition('clean');
          const allowedDomains = new Set<string>(DEFAULT_EXTENSION_ALLOWED_DOMAINS);
          for (const host of tabAuthorities.hosts()) {
            for (const tab of host.getTabList()) {
              if (!tab?.url) continue;
              try {
                const parsed = new URL(tab.url);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
                const hostName = parsed.hostname.toLowerCase().trim();
                if (
                  hostName &&
                  !hostName.includes('*') &&
                  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i.test(hostName)
                ) {
                  allowedDomains.add(hostName);
                }
              } catch {}
            }
          }
          const grant = bridgeServer!.issueExtensionGrant(activePartition, Array.from(allowedDomains));
          return {
            token: grant.grantToken,
            port: bridgePort,
            activeCapsuleId: activeCapsule?.id,
            activePartition,
          };
        }, StorageLocations.getRuntimeDir());
        console.log(`[antifan] Native Messaging Local IPC Server listening at ${localIpcServer.getSocketPath()}`);

        // Auto-register Chrome/Edge/Brave native messaging manifest on Windows
        installNativeHost(COMPANION_EXTENSION_ID).catch((err) => {
          console.warn('[antifan] Native messaging manifest registration notice:', err?.message || err);
        });
      } catch (err) {
        console.warn('[antifan] Failed to start Native Messaging Local IPC Server:', err);
      }
    }
  };
  setTimeout(() => {
    startBridgeAndIpc().catch((err) => console.warn('[antifan] Deferred bridge/IPC startup failed:', err));
  }, 1500);
}

app.whenReady().then(async () => {
  if (!ownsElectronInstance) return;
  recordBenchmark({ surface: 'startup', name: 'ready' });
  try {
    profileLease = new ProfileOwnership().acquire(persistentUserData);
    // Journal the predecessor's verdict from `priorRecovery`, the snapshot taken
    // before acquire() overwrote the marker: `recovery.cleanShutdown` is this
    // boot's own state (always false here), so reading it would log a permanent
    // lie about the previous run.
    recordLifecycleEvent('boot.profile', {
      leasePid: profileLease.info.pid,
      leaseStartedAt: profileLease.info.startedAt,
      prevCleanShutdown: profileLease.priorRecovery.cleanShutdown,
      prevLastCleanShutdownAt: profileLease.priorRecovery.lastCleanShutdownAt,
      prevStartedAt: profileLease.priorRecovery.startedAt,
      prevSafeStartRecommended: profileLease.priorRecovery.safeStartRecommended,
      lifecycleLog: getLifecycleLogPath(),
    });
    if (!profileLease.priorRecovery.cleanShutdown) {
      console.warn('[antifan] Previous shutdown was unclean; restoring the active tab only (safe start).');
    }
  } catch (error) {
    if (error instanceof ProfileOwnershipError) {
      console.error(`[antifan] Profile is already owned: ${error.message}`);
    } else {
      console.error('[antifan] Failed to acquire profile ownership:', error);
    }
    app.exit(0);
    return;
  }
  // Configure default session policies cleanly without global header tampering
  configureBrowserSessionPartition('', 'clean');
  // Colour/star are durable per-project state the registry owns: attach before the first
  // capsule sync so every registration reads the store back.
  projectRegistry.attachAppearanceStore(new ProjectPreferences(path.join(StorageLocations.getConfigDir(), PROJECT_PREFERENCES_FILE)));
  const capsuleStoragePath = path.join(StorageLocations.getConfigDir(), 'workspace-capsules.json');
  capsuleManager = new WorkspaceCapsuleManager({
    filePath: capsuleStoragePath,
    affiliationAuthority: { projectRegistry },
  });
  if (!capsuleManager.getActive()) {
    const defaultDir = fs.existsSync('E:/Work') ? 'E:/Work' : (fs.existsSync('E:\\Work') ? 'E:\\Work' : process.cwd());
    capsuleManager.create('Default Workspace', defaultDir);
  }
  synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  registerPreviewProtocolHandler(capsuleManager);
  await createWindow();
  recordBenchmark({ surface: 'startup', name: 'windowCreated' });

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}).catch((error) => {
  console.error('[antifan startup failed]', redactCredentials(error?.stack || String(error)));
  app.exit(1);
});

let lifecycleHeartbeat: NodeJS.Timeout | null = null;
/**
 * Absolute-epoch heartbeat. The next boot bounds the death window from the last beat
 * instead of inferring one: a journal that stops mid-run with no shutdown.step line
 * means the process was ended from outside, while a stop immediately after a step
 * names the step it was inside. Every line carries `ts` in epoch milliseconds so the
 * gap is computable without guessing a timezone.
 */
function startLifecycleHeartbeat(): void {
  if (lifecycleHeartbeat) return;
  const beat = (): void => {
    let tabCount: number | null = null;
    let webContentsCount: number | null = null;
    try {
      const hosts = tabAuthorities.hosts();
      tabCount = hosts.length > 0 ? hosts.reduce((acc, h) => acc + h.getTabList().length, 0) : null;
    } catch {}
    try { webContentsCount = webContents.getAllWebContents().length; } catch {}
    const memory = process.memoryUsage();
    recordLifecycleEvent('heartbeat', {
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      tabCount,
      webContentsCount,
    });
  };
  beat();
  lifecycleHeartbeat = setInterval(beat, 5000);
  lifecycleHeartbeat.unref?.();
}

let shutdownPromise: Promise<void> | null = null;
/**
 * Bound on one teardown step. The committed shutdown is awaited by the quit path before
 * `app.quit()`, so a step that never settles would hang the quit instead of ending it; the
 * deadline is generous enough for a real profile flush and far below a hang, so only a
 * stuck native call hits it. The signal path keeps its own, tighter 2000ms bound on the
 * whole sequence.
 */
const SHUTDOWN_STEP_DEADLINE_MS = 5_000;
/**
 * The ordered, once-only teardown. It is reached through the close coordinator's committed
 * shutdown (`commitShutdown`) — only after every native closure of an application attempt
 * succeeded — or through the forced signal path, which admits it is not graceful. The
 * coordinator owns the decision to tear services down; this owns the order it happens in.
 * Nothing here may end the application: the caller that committed the shutdown quits it.
 */
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  // Before the first await: concurrent keep-alive checks must see a teardown in progress,
  // and nothing may start a new close while the services underneath are being disposed.
  isShuttingDown = true;
  // A hang anywhere inside it means the app never quits at all. Journaling every step is
  // what makes "a graceful quit that hung" distinguishable from "a process killed from
  // outside".
  recordLifecycleEvent('shutdown.begin', { lifecycleLog: getLifecycleLogPath() });
  const attempt = (async () => {
    const step = async (name: string, run: () => unknown): Promise<void> => {
      // Bounded: this sequence is awaited before `app.quit()`, so a native call that hangs
      // must not be able to keep the process alive forever. A step that exceeds the
      // deadline is journaled as `shutdown.step.timeout` and skipped; the ordered steps
      // after it still run, and the quit still happens.
      await runBoundedShutdownStep(name, SHUTDOWN_STEP_DEADLINE_MS, run, recordLifecycleEvent);
    };
    // First step, deliberately: if any later step hangs, these frames are already
    // terminal, so the next boot's replay cannot claim their outcome was never written.
    await step('ledger.settleInFlight', async () => {
      const settlement = await controlPlane?.ledger.settleInFlightForShutdown('graceful shutdown');
      if (settlement && settlement.pending > 0) {
        recordLifecycleEvent('ledger.settleInFlight', { ...settlement });
      }
    });
    await step('terminal.persistSync', () => TerminalManager.getInstance().persistSync());
    await step('history.persistSync', () => HistoryManager.getInstance().persistSync());
    await step('tabHost.flushAllSessions', async () => {
      await Promise.all(tabAuthorities.hosts().map((h) => h.flushAllSessions()));
    });
    await step('cookies.flushStore', () => session.defaultSession.cookies.flushStore());
    await step('tabHost.dispose', () => {
      for (const h of tabAuthorities.hosts()) h.dispose();
    });
    await step('runStateService.dispose', () => runStateService?.dispose());
    await step('bridgeServer.dispose', () => bridgeServer?.dispose());
    await step('localIpcServer.close', () => localIpcServer?.close());
    await step('terminal.dispose', () => TerminalManager.getInstance().dispose());
    try {
      profileLease?.markCleanShutdown();
      profileLease?.release();
      profileLease = null;
      recordLifecycleEvent('shutdown.clean', {});
    } catch (err) {
      recordLifecycleEvent('shutdown.markCleanShutdown.failed', { detail: String(err) });
    }
  })();
  shutdownPromise = attempt;
  // A failed teardown stays retryable. The quit gate re-runs the ordered sequence after a
  // failure (its report is refused, not cached), and a memoized rejection would answer every
  // later attempt with that same failure while the services underneath stayed half disposed —
  // a process that can never quit. The flags go back to "not shutting down" so a retry starts
  // from the top; the steps above already journaled which one threw.
  attempt.catch((err) => {
    recordLifecycleEvent('shutdown.failed', { detail: String(err) });
    if (shutdownPromise === attempt) {
      shutdownPromise = null;
      isShuttingDown = false;
    }
  });
  return attempt;
}

app.on('window-all-closed', () => {
  recordLifecycleEvent('window-all-closed', {});
  // Reached only when a window was destroyed despite the close guard (e.g. a renderer crash took
  // it). Quitting there would discard the run's whole artifact, so the benchmark keeps the process
  // alive and records the fact loudly instead — a run with no window is a finding, not a reason to
  // lose the measurement.
  if (refusesWindowClose()) {
    recordLifecycleEvent('window-all-closed.ignored', { reason: 'benchmark keep-alive' });
    console.warn('[antifan] Benchmark mode: window-all-closed ignored; the run continues without a window.');
    return;
  }
  // No `app.quit()` of its own: this is the same application gate as an explicit Quit, so a
  // refusal here leaves the process — and everything the user is still working in — exactly as
  // it was. Electron does not emit this event during `app.quit()`, so the guarded entries stay
  // the last browser shell going away (`handleShellClosed`) and `before-quit`.
  requestApplicationQuit('window-all-closed');
});

let isShuttingDown = false;
// Set by the `will-quit` listener below: the platform delivered the quit. The force-exit
// watchdog exists for a platform that never delivers it, so a delivered event disarms the kill.
let willQuitDelivered = false;
app.on('before-quit', (event) => {
  const committed = closeCoordinator.hasCommittedShutdown();
  recordLifecycleEvent('before-quit', { committed, applicationPhase: closeCoordinator.applicationPhase() });
  // A committed teardown is this process quitting itself: letting the event through is what
  // actually ends it, and by then every window that could veto it was already closed through
  // the coordinator, so the platform's own close pass has nothing left to destroy.
  if (committed) return;
  // Synchronously, before anything awaits: an unprevented `before-quit` starts closing every
  // window on its own, which is exactly the destruction the gate exists to decide. A repeated
  // Quit coalesces into the attempt already running rather than racing it.
  event.preventDefault();
  requestApplicationQuit('before-quit');
});
app.on('will-quit', () => {
  willQuitDelivered = true;
  recordLifecycleEvent('will-quit', { committed: closeCoordinator.hasCommittedShutdown() });
  // Synchronous and idempotent, deliberately: the committed teardown already flushed and
  // disposed everything, so there is no asynchronous work left for a guarded re-entry to
  // await. It stays as the last line of defence for an exit that reached the platform
  // without an orderly teardown (an OS-initiated quit).
  bridgeServer?.dispose();
  for (const h of tabAuthorities.hosts()) {
    h.dispose();
  }
  profileLease?.release();
  profileLease = null;
  benchmarkStopEventLoop?.();
  recordBenchmark({ surface: 'startup', name: 'shutdown' });
  stopProcessMetricsSampling();
  recordProcessMetrics('atShutdown', true);
});

/**
 * Arm the last-resort exit for a shutdown that has already committed to ending this process.
 * Nothing is left to decide by then: the only remaining failure is a platform that never
 * delivers the quit, which would leave the process alive with no window and no feedback. The
 * timer is unref'd so it can never be the thing holding the event loop open.
 *
 * A delivered `will-quit` falsifies that premise, so the watchdog yields to it: the platform is
 * not stuck, it asked, and a listener vetoed the quit — which is how a vetoed quit is supposed
 * to work. Killing the process there would discard state the veto exists to protect, and it
 * would journal `shutdown.forceExit` for a teardown that was, in fact, graceful.
 */
function armForceExitWatchdog(reason: string): NodeJS.Timeout {
  const forceTimer = setTimeout(() => {
    if (willQuitDelivered) return;
    // A silent exit: no clean marker is written, because shutdown() never reached it.
    recordLifecycleEvent('shutdown.forceExit', { code: 1, reason });
    process.exit(1);
  }, 2000);
  forceTimer.unref?.();
  return forceTimer;
}

let isSignalExiting = false;
function handleSignal(signal: NodeJS.Signals): void {
  recordLifecycleEvent('signal', { signal, alreadyExiting: isSignalExiting });
  if (isSignalExiting) return;
  isSignalExiting = true;
  isShuttingDown = true;
  const forceTimer = armForceExitWatchdog('shutdown did not finish within 2000ms');
  shutdown().finally(() => {
    clearTimeout(forceTimer);
    recordLifecycleEvent('shutdown.complete', { code: 0 });
    process.exit(0);
  });
}

process.on('SIGINT', handleSignal);
process.on('SIGTERM', handleSignal);

/** One window as the live probe sees it: presentation, authority and tabs together. */
export interface ProjectWindowProbeEntry {
  ownerKey: string;
  owner: WindowOwner;
  title: string;
  pathLabel?: string;
  windowId: number;
  visible: boolean;
  focused: boolean;
  hostOwnerKey: string;
  hostOwnerLabel: string;
  tabIds: string[];
  activeTabId: string;
  identity: ProjectWindowIdentity;
  terminalCwd: string;
  terminalCwdSource: string;
}

/** A window's authority and tabs, or the empty projection when it has no host yet. */
function describeShellForProbe(shell: ProjectWindowShell): ProjectWindowProbeEntry {
  const host = tabAuthorities.hostForShell(shell);
  const terminal = host
    ? host.resolveTerminalCreationTarget()
    : { cwd: '', source: 'no-host' };
  return {
    ownerKey: ownerKey(shell.owner),
    owner: shell.owner,
    title: shell.title,
    ...(shell.pathLabel ? { pathLabel: shell.pathLabel } : {}),
    windowId: shell.window.id,
    visible: shell.window.isVisible(),
    focused: shell.window.isFocused(),
    hostOwnerKey: host?.windowOwnerKey() ?? '',
    hostOwnerLabel: host?.windowOwnerLabel() ?? '',
    tabIds: host?.getTabList().map((tab) => tab.id) ?? [],
    activeTabId: host?.getActiveTabId() ?? '',
    identity: host?.projectWindowIdentity() ?? {
      owner: shell.owner,
      title: shell.title,
      ...(shell.pathLabel ? { pathLabel: shell.pathLabel } : {}),
    },
    terminalCwd: terminal.cwd,
    terminalCwdSource: terminal.source,
  };
}

/**
 * Live-process inspection seam for the multi-window probe
 * (`scripts/probe-project-windows.cjs`). Every function drives the shipping path — the
 * same factory, the same directory, the same close gate — so the probe's evidence is
 * this process's real behaviour rather than a second implementation of it that could
 * pass while the app fails.
 */
export const projectWindowAuthority = {
  /** Windows the process currently owns, as the quit gate counts them. */
  browserShellCount(): number {
    return projectWindows?.browserShellCount() ?? 0;
  },
  /** Chrome channels registered in this process, from the router's own ledger. */
  registeredChromeChannels(): readonly string[] {
    return listRegisteredChromeChannels();
  },
  snapshot(): ProjectWindowProbeEntry[] {
    return liveProjectShells().map(describeShellForProbe);
  },
  /** Open or join a project window through the one factory, exactly as a user request does. */
  async ensureProjectWindow(owner: ProjectWindowOwner, intent: OpenIntent): Promise<ProjectWindowProbeEntry> {
    const { shell } = await ensureProjectWindow(toWindowOwner(owner), intent);
    return describeShellForProbe(shell);
  },
  /**
   * Drive a project detach through the one entrypoint the menu and IPC route share —
   * the same exclusivity, transfer and marker semantics a user hand triggers. Probes
   * call this instead of reproducing the join/create arms.
   */
  async detachProject(projectId: string): Promise<ProjectDetachResult> {
    return detachProject({ projectId }, null);
  },
  /**
   * Drive a reattach through the one entrypoint the menu and IPC route share —
   * the same close-coordinator ordering, fold, ingest and latch semantics a user
   * hand triggers.
   */
  async reattachProject(projectId: string): Promise<ProjectReattachResult> {
    return reattachProject({ projectId });
  },
  /**
   * Ask a window to close the way a user does — a native close request. The shell
   * request handler (see `attachShellLifecycle`) routes it through the close coordinator,
   * which is the shipping path: no privileged shutdown, no bypass of the admission gate.
   */
  requestClose(ownerKeyValue: string): boolean {
    const shell = liveShellFor(ownerKeyValue);
    if (!shell || shell.window.isDestroyed()) return false;
    shell.window.close();
    return true;
  },
  /**
   * The coordinator's own close path, for the cases the probe cannot reach with a native
   * close request: a Quit that arrives while a run is queued, or a shell the platform
   * destroyed. Same entrypoint the shipping listeners call.
   */
  attemptClose(ownerKeyValue: string, intent: 'user' | 'quit'): Promise<CloseReport> {
    return closeCoordinator.attemptClose(ownerKeyValue, intent).then(
      (report) => {
        recordCloseReport(report);
        return report;
      },
      (err) => {
        recordLifecycleEvent('window-close.failed', { owner: ownerKeyValue, detail: String(err) });
        throw err;
      },
    );
  },
  /** Probe seam for explicit destructive close; same coordinator state machine IPC uses. */
  forceClose(ownerKeyValue: string): Promise<CloseReport> {
    return closeCoordinator.forceClose(ownerKeyValue);
  },
  /** The real sender-scoped route, with the confirmation answer supplied by the probe. */
  async forceCloseFromChrome(sender: unknown): Promise<ForceCloseWindowResult> {
    return forceCloseWindowForSender({ sender });
  },
  /** Drive the application quit gate exactly as `before-quit` and the last shell close do. */
  requestQuit(origin: string): void {
    requestApplicationQuit(origin);
  },
  /** The application attempt's state: `open` until admission is reserved, `closed` once committed. */
  applicationPhase(): ClosePhase {
    return closeCoordinator.applicationPhase();
  },
  /** The coordinator's admission snapshot: what a close currently reserves, and what it measures. */
  reservations(): { reservedTabIds: readonly string[]; reservedCount: number; inFlightOperations: number; applicationReserved: boolean } {
    const snapshot = closeReservations.snapshot();
    return { ...snapshot, reservedCount: snapshot.reservedTabIds.length };
  },
  /** Modal confirmation seam, injectable only for deterministic live-force probes. */
  setForceCloseConfirmationForProbe(callback: ((shell: { ownerKey: string; title: string }) => Promise<boolean>) | null): void {
    forceCloseConfirmationForProbe = callback;
  },
  /** The live-use port, so tests and the probe can query the exact snapshot wiring. */
  closeLiveUsePort(): CloseLiveUsePort {
    return closeLiveUsePort;
  },
  /**
   * The live control plane, so a probe can drive the shipping owners of shared work — a
   * run in a non-terminal state, an attachment binding a page — and then watch the quit
   * gate judge them. Nothing here fabricates state: every call below goes to the same
   * services the shipping paths use.
   */
  controlPlane(): ControlPlaneRuntime | null {
    return controlPlane;
  },
  /** The last coordinated quit report, or null while no quit has been attempted. */
  lastQuitReport(): QuitReport | null {
    return lastQuitReport;
  },
  /** The last close report the coordinator produced for an owner. */
  lastCloseReport(ownerKeyValue: string): CloseReport | null {
    return lastCloseReports.get(ownerKeyValue) ?? null;
  },
  /** The native window behind an owner key, so a probe can watch its events. */
  windowFor(ownerKeyValue: string): Electron.BrowserWindow | null {
    return liveShellFor(ownerKeyValue)?.window ?? null;
  },
  /**
   * The shell behind an owner key, so a probe can drive that window's own chrome surfaces
   * (toolbar, sidebar) the way its renderers do. One live window per owner key.
   */
  shellFor(ownerKeyValue: string): ProjectWindowShell | null {
    return liveShellFor(ownerKeyValue) ?? null;
  },
  /** The host that owns a tab right now, or null when no live window does. */
  hostForTab(tabId: string): NativeTabHost | null {
    return tabAuthorities.hostForTab(tabId) ?? null;
  },
  /** The host behind an owner key, or null when that window is not open. */
  hostForOwner(ownerKeyValue: string): NativeTabHost | null {
    const shell = liveShellFor(ownerKeyValue);
    return shell ? tabAuthorities.hostForShell(shell) ?? null : null;
  },
  /** Shared ProjectRegistry projection */
  projectRegistry(): ProjectRegistry {
    return projectRegistry;
  },
  /** Run capsule-registry synchronization on demand */
  synchronizeCapsulesWithRegistry(): { registeredProjects: number; registeredWorkspaces: number } {
    if (!capsuleManager) return { registeredProjects: 0, registeredWorkspaces: 0 };
    return synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  },
};
