/**
 * AntiFan Browser Desktop — Main Electron Bootstrap Entry Point
 * High-performance, ultra-lightweight Chromium host and Extension Bridge companion.
 */
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow, Menu, ipcMain, protocol, session, nativeTheme, webContents, crashReporter, dialog, type IpcMainInvokeEvent, type OpenDialogOptions } from 'electron';

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
import {
  collectProjectOpenCandidates,
  projectOpenDialogSpec,
  projectOpenChoiceFor,
  type ProjectOpenCandidate,
} from './project/project-open-picker';
import { NativeTabHost, collectTabSearchInventory, activateTabSearchResult, isUnhostedTerminalWindow, type TabSearchInventoryRow, type TabSearchActivationFailure } from './browser/native-tab-host';
import { closeAuxiliaryWindow } from './browser/auxiliary-close';
import { ProjectWindowManager, type OpenIntent } from './browser/project-window-manager';
import { ProjectWindowShell, ownerKey, ownerLabel, type ChromeSurface, type WindowOwner } from './browser/project-window-shell';
import { TabAuthorityDirectory } from './browser/tab-authority-directory';
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
import { BridgeServer, DEFAULT_EXTENSION_ALLOWED_DOMAINS, redactCredentials } from './bridge/bridge-server';
import { TerminalManager } from './browser/terminal-manager';
import { ensureDaemon } from './terminal-daemon/daemon-spawner';
import { DaemonTerminalProxy } from './terminal-daemon/daemon-client';
import { buildApplicationMenu } from './browser/app-menu';
import { WindowStateManager } from './browser/window-state';
import { HistoryManager } from './browser/history-manager';
import { configureBrowserSessionPartition } from './browser/browser-session-partition';
import { pruneDeadStores } from './browser/dead-store-cleaner';
import { ChromeProfileSyncManager } from './browser/chrome-profile-sync';
import { LocalIpcServer } from './native-messaging/local-ipc-server';
import { installNativeHost, COMPANION_EXTENSION_ID } from './native-messaging/manifest-installer';
import { chromeSessionUserAgent } from './browser/google-auth-identity';
import { ControlPlaneRuntime, resolveArtifactStoreOptionsFromEnv } from './control-plane/control-plane-runtime';
import { BrowserControlPort, assertApplicationAdmitsWork } from './tools/browser-control-port';
import { CapabilityTransportAdapter } from './tools/capability-transport';
import { DeviceManager } from './device/device-manager';
import { IosDeviceAdapter } from './device/ios-device-adapter';
import { validateControlPlaneId, makeControlPlaneId, type ProjectRecord } from '../shared/control-plane-contracts';
import {
  PROJECT_WINDOW_CHANNELS,
  type ProjectOpenResult,
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

// Fail-closed boot guard (`AP-DEADLINE-001`): the request deadline chain must strictly
// increase from the innermost callee bound to the outermost caller bound. A flattened or
// inverted chain lets a caller abandon a request while its callee still admits it, which
// converts a recoverable timeout into an orphaned command. Refuse to boot on an incoherent
// chain instead of serving requests under one. Deliberately above the uncaughtException
// handler: this throw must be fatal, never swallowed into a boot that continues anyway.
assertDeadlineChain();

// Every fatal path below also writes a durable journal line. A launch from Explorer
// or a shortcut has no attached console, so the console.* lines alone are discarded:
// the app used to die without leaving any record of how. See
// diagnostics/main-lifecycle-log.ts for why the appends are synchronous.
process.on('uncaughtException', (err) => {
  console.error('[antifan uncaughtException]', redactCredentials(err?.stack || String(err)));
  recordLifecycleEvent('uncaughtException', { detail: redactCredentials(err?.stack || String(err)) });
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

/** A capsule record whose affiliation Main can trust on the evidence of the record alone. */
export type ValidatedAffiliationCapsule = WorkspaceCapsule & { projectId: string; workspaceId: string };

/**
 * Whether a capsule carries an explicit, control-plane-safe affiliation: both ids present and
 * well formed. Ambiguity — two records claiming one project — is a separate rule, settled by
 * `uniqueValidatedClaim`, never here.
 *
 * A persisted record can carry `migrationMarker: 'explicit'` without a workspace id (the store
 * trusts a marker it reads from disk). Such a record must NOT count as a known project: the
 * synchronizer registers nothing for it, so opening it would mint a workspace id from nothing.
 */
export function hasValidatedAffiliation(capsule: WorkspaceCapsule): capsule is ValidatedAffiliationCapsule {
  if (!capsule.projectId || typeof capsule.projectId !== 'string' || capsule.projectId.trim().length === 0) {
    return false;
  }
  if (!capsule.workspaceId || typeof capsule.workspaceId !== 'string' || capsule.workspaceId.trim().length === 0) {
    return false;
  }
  try {
    validateControlPlaneId(capsule.projectId, 'project');
    validateControlPlaneId(capsule.workspaceId, 'workspace');
  } catch {
    return false;
  }
  return true;
}

/**
 * The capsule record authorizing an open of `projectId`, when exactly one exists and it carries a
 * validated affiliation. This is the same evidence the synchronizer registers from, so an open can
 * never name a project the registry refuses to know — and a second claim stays a refusal rather
 * than a tiebreak.
 */
export function uniqueValidatedClaim(capsules: WorkspaceCapsule[], projectId: string): ValidatedAffiliationCapsule | undefined {
  const matches = capsules.filter((capsule) => capsule.projectId === projectId);
  const [onlyMatch, ...rest] = matches;
  if (!onlyMatch || rest.length > 0) return undefined;
  return hasValidatedAffiliation(onlyMatch) ? onlyMatch : undefined;
}

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

const DEFAULT_BOOT_PROJECT_ID = 'project-00000000-0000-4000-8000-000000000001';
const DEFAULT_BOOT_WORKSPACE_ID = 'workspace-00000000-0000-4000-8000-000000000001';
/** Identity this process booted for, recorded when the bootstrap window opens. */
let bootProjectIdValue: string | null = null;
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

/** Live project shells, in the directory's registration order. */
function liveProjectShells(): ProjectWindowShell[] {
  return projectWindows?.listShells() ?? [];
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

/** The OS window title: the project's validated label, with this build's marker in dev. */
function shellTitleFor(projectTitle: string): string {
  return IS_DEV ? `${projectTitle} [DEV]` : projectTitle;
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
  if (owner.kind !== 'project') return { title: ownerLabel(owner) };

  // Look for unambiguous matching capsule in capsule store
  const matches = capsuleManager?.list().filter((capsule) => capsule.projectId === owner.projectId) ?? [];
  // Two records claiming one project is ambiguity, not a choice: until they are
  // reconciled, the window shows its stable id and claims no workspace. A lone record with no
  // well-formed workspace id is the record an open refuses (`uniqueValidatedClaim`), so it may
  // not hand a window a path or a capsule tag the registry never registered: such a project is
  // described by the registry fallback below alone, exactly as if no capsule store existed.
  const claimed = matches.length === 1 ? matches[0] : undefined;
  const capsule = claimed && hasValidatedAffiliation(claimed) ? claimed : undefined;

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
  return liveProjectShells().some((shell) => shell.owner.kind === 'project' && shell.owner.projectId === projectId);
}

/**
 * The host a shared service acts on when the call names neither a tab nor a sender.
 *
 * There is no ambient "current window": the automation-target owner is the one
 * window an unbound agent authority is already pinned to (see the bridge's runtime
 * binding), and a single-window process is unambiguous by construction. Anything
 * else refuses, so a request can never land in whichever window was created first.
 */
function ambientHostOrThrow(): NativeTabHost {
  const hosts = tabAuthorities.hosts();
  const automationHost = hosts.find((host) => host.getAutomationTabId() != null);
  if (automationHost) return automationHost;
  if (hosts.length === 1) return hosts[0]!;
  if (hosts.length === 0) throw new Error('No project window is live, so no tab host can serve this request');
  throw new Error(`${hosts.length} project windows are live and this request names no window, tab or sender`);
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
 * The project window that owns a tab. A tab no live window owns — one that was
 * closed, or a call that carries no tab id — falls back to the ambient host above,
 * which is the single-window path this replaced: every host answers an unknown id
 * the same way its caller expects (`false`, `''`, `1`, or a `TARGET_STALE`
 * capability error), so a stale id keeps its old outcome instead of turning into an
 * exception. Only a process with no window at all refuses.
 */
function hostForTabOrBootstrap(tabId: string | undefined): NativeTabHost {
  if (tabId) {
    const owner = tabAuthorities.hostForTab(tabId);
    if (owner) return owner;
  }
  return ambientHostOrThrow();
}
let bridgeServer: BridgeServer | null = null;
let windowStateManager: WindowStateManager | null = null;
let controlPlane: ControlPlaneRuntime | null = null;
let browserPort: BrowserControlPort | null = null;
let deviceAdapter: IosDeviceAdapter | null = null;
let terminalDaemonInitialized = false;
/** Hosts already given the control plane; attaching twice would re-run its device query. */
const hostsWithControlPlane = new WeakSet<NativeTabHost>();
let profileLease: ProfileLease | null = null;
let localIpcServer: LocalIpcServer | null = null;
// Enforce single instance lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  console.log(`[antifan] Another instance is already running (${IS_DEV ? 'DEV' : 'PROD'}). Exiting.`);
  app.exit(0);
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
        const offscreen = host.isTabOffscreen(tab.id) ? ':offscreen' : '';
        push(wc, `tab:${tab.id.slice(0, 8)}${pane === 'mobile' ? ':mobile' : ''}${offscreen}`);
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
function closePageInOwningHost(tabId: string): Promise<PageCloseOutcome> {
  const host = tabAuthorities.hostForTab(tabId);
  if (!host) return Promise.resolve('unknown');
  return host.closePage(tabId);
}

/**
 * The auxiliary windows an application quit must also close: one host's terminal windows
 * (the sidebar popout and any extra workbench window). They are not project shells — no
 * project snapshot claims them — but they are the user's own windows, so an orderly quit
 * closes them and honours a veto in one instead of tearing services down underneath it.
 *
 * They are found through the host's own surface lookup, never a window census by title:
 * a webContents a live host answers `terminalPopout` for is a terminal window that host
 * owns. Capture hosts are deliberately absent — they are non-closable offscreen windows
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
  return {
    ...surface,
    visibleMemberIds: () => hostForOwnerKey(surface.key)?.visibleMemberTabIds() ?? surface.visibleMemberIds(),
  };
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
  closePage: (tabId) => closePageInOwningHost(tabId),
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
  surfaces: () =>
    liveProjectShells().map((shell) => ({
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
  if (remaining > 0) {
    recordLifecycleEvent('window-closed.siblings-live', { remaining, owner: ownerKey(shell.owner) });
    return;
  }
  recordLifecycleEvent('window-closed.last-browser-shell', { owner: ownerKey(shell.owner) });
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
 * The ONLY path that creates a project window.
 *
 * The startup bootstrap and 'antifan:project:open' both come through here, so a
 * window opened later is wired exactly like the first one: its own NativeTabHost
 * registered with the window directory (which is what makes its tabs routable), its
 * own owner-keyed placement and saved tabs, and its own close gate. A path that
 * created only a shell would leave a window whose tabs nothing could resolve.
 */
async function ensureProjectWindow(owner: WindowOwner, intent: OpenIntent): Promise<ProjectWindowRuntime> {
  const manager = projectWindows;
  if (!manager) throw new Error('The project window manager is not up yet');

  if (owner.kind === 'project' && capsuleManager) {
    synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  }

  const shell = await manager.ensureWindow(owner, intent);
  // A join — a duplicate open, or a second caller racing the first — already owns its
  // host. Only the creation path wires one, and it does so with no await between the
  // check and the registration, so two callers cannot both build a host for one shell.
  const existingHost = tabAuthorities.hostForShell(shell);
  if (existingHost) return { shell, host: existingHost, created: false };

  const host = new NativeTabHost(shell, capsuleManager || undefined);
  // The reservation table, before the host can restore or create a single page: a tab
  // created inside an async close window would otherwise exist for exactly as long as it
  // takes the attempt to destroy its window.
  host.setCloseAdmission(closeReservations);
  tabAuthorities.register(shell, host);
  recordBenchmark({ surface: 'startup', name: 'tabHostCtor' });

  const record = resolveWindowRecord(shell.owner);
  if (record.workspacePath) {
    // This window's terminals belong to its own verified workspace. The host refuses a
    // path it cannot verify, which leaves the association unset rather than moving this
    // window's terminals into another window's directory.
    host.setWindowWorkspaceAffiliation({
      workspacePath: record.workspacePath,
      ...(record.capsuleId ? { capsuleId: record.capsuleId } : {}),
    });
  }
  if (owner.kind === 'project') {
    const targetWorkspaceId = record.workspaceId || projectRegistry.listWorkspaces(owner.projectId)[0]?.id || makeControlPlaneId('workspace');
    const targetWorkspaceRoot = record.workspacePath || process.cwd();
    projectRegistry.ensureInitialWorkspace(
      owner.projectId,
      targetWorkspaceId,
      targetWorkspaceRoot,
      StorageLocations.getControlPlaneDir(),
    );
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
  return { shell, host, created: true };
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
  Menu.setApplicationMenu(buildApplicationMenu(attachTo, null, {
    resolveHostForWindow: (window) => {
      const shell = shellForBrowserWindow(window);
      return shell ? tabAuthorities.hostForShell(shell) ?? null : null;
    },
    // The menu is the one project entry a project window has: the sidebar chip is the
    // other, and both ask the same Main function, so neither can drift from the other's
    // validation.
    openProjectPicker: (window) => { void openProjectWindow({}, window); },
  }));
}

/**
 * Present the bootstrap window as soon as its renderer paints, with a bounded fallback
 * so a slow first paint cannot leave the app invisible. Only the bootstrap window is
 * presented here: an agent-created window is never shown by this path.
 */
function presentBootstrapWindow(shell: ProjectWindowShell): void {
  const placement = windowStateManager?.getValidBounds(ownerKey(shell.owner));
  let fallbackTimer: NodeJS.Timeout | null = null;
  const present = (): void => {
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
    shell.window.show();
    shell.window.focus();
    recordBenchmark({ surface: 'startup', name: 'firstVisible' });
    recordProcessMetrics('afterFirstVisible');
    startProcessMetricsSampling();
  };
  shell.window.once('ready-to-show', present);
  shell.window.once('closed', () => {
    if (!fallbackTimer) return;
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  });
  fallbackTimer = setTimeout(present, 300);
}

/** Surfaces a project-window channel serves: the toolbar control and the sidebar's own. */
const PROJECT_WINDOW_ROUTE_SURFACES: readonly RoutedSurface[] = ['toolbar', 'sidebar'];

/**
 * Main's own label for an owner key: the window's validated record, the same source the
 * window's title and its identity message use. The host labels a project owner by its id,
 * which is the right stable key for persistence but not what a user searches against —
 * the search list must name a window the way that window names itself.
 */
function projectLabelFor(ownerKeyValue: string): string | undefined {
  const shell = liveShellFor(ownerKeyValue);
  return shell ? shellTitleFor(resolveWindowRecord(shell.owner).title) : undefined;
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
  const liveProjectIds = liveProjectShells()
    .map((shell) => (shell.owner.kind === 'project' ? shell.owner.projectId : ''))
    .filter((projectId) => projectId.length > 0);
  return collectProjectOpenCandidates({
    registryProjects: projectRegistry.listProjects(),
    knownProjectIds: bootProjectIdValue ? [bootProjectIdValue, ...liveProjectIds] : liveProjectIds,
    describe: (projectId) => {
      const record = resolveWindowRecord({ kind: 'project', projectId });
      return { title: record.title, ...(record.pathLabel ? { pathLabel: record.pathLabel } : {}) };
    },
  });
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
 * Main's own project-opening surface: a native list of the projects it can actually open,
 * modal to the window that asked. The answer is an id from Main's own inventory or the explicit
 * request to choose a folder, so the open path that follows validates nothing it did not build
 * itself.
 *
 * The spec always exists (`projectOpenDialogSpec`), which is why the folder action is offered even
 * with an empty inventory: opening one of the user's own folders is a real answer to "open a
 * project", and a dialog whose only other button was dismissal would be a dead end. Every label
 * carries its workspace path because the `detail` line is not rendered on every platform (Windows
 * drops it), so a bare title would leave two same-named projects indistinguishable in the buttons
 * the user actually clicks.
 */
async function pickProjectToOpen(parent: BrowserWindow | null): Promise<ProjectOpenPick> {
  const spec = projectOpenDialogSpec(projectOpenCandidates());
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
  // A dialog with no parent cannot be attached to one: the unparented overload is the only
  // legal call, and it is also what a window-less Main (a probe seam) has to use.
  const answer = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  const choice = projectOpenChoiceFor(spec, answer.response);
  if (choice.kind === 'folder') {
    recordLifecycleEvent('project-open.folder', {});
    return { kind: 'folder' };
  }
  return choice.kind === 'project'
    ? { kind: 'picked', projectId: choice.projectId }
    : { kind: 'cancelled' };
}

/**
 * Resolve the folder the user chooses into the project that opens there.
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
  const defaultPath = bootProjectId
    ? resolveWindowRecord({ kind: 'project', projectId: bootProjectId }).workspacePath
    : undefined;
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

  // A folder chooser can stay open as long as the user likes, so the admission is re-read now and
  // the mutation below follows it with no await in between: a quit that committed around the dialog
  // would otherwise end with a project — and a window — created after it counted the windows it
  // intends to end. The wrap is not for tidiness: a rejection here would surface as a dead click,
  // while every refusal, the admission included, becomes the same FAILED envelope the caller reads.
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
 */
async function openProjectWindow(payload: unknown, parent?: BrowserWindow | null): Promise<ProjectOpenResult> {
  let requested = payload && typeof payload === 'object' && 'projectId' in payload && typeof payload.projectId === 'string'
    ? payload.projectId.trim()
    : '';
  if (!requested) {
    recordLifecycleEvent('project-open.without-target', {});
    // One parent for both dialogs: the folder chooser belongs to the window whose picker the user
    // just answered, not to whatever window happens to be focused by the time it opens.
    const pickerParent = parent ?? BrowserWindow.getFocusedWindow();
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
    const { created } = await ensureProjectWindow({ kind: 'project', projectId }, 'user');
    recordLifecycleEvent('project-open', { projectId, created });
    return created ? { status: 'OPENED', projectId } : { status: 'FOCUSED', projectId };
  } catch (err) {
    recordLifecycleEvent('project-open.failed', { projectId, detail: String(err) });
    return { status: 'FAILED', projectId, reason: redactCredentials(String(err)) };
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
    surface: PROJECT_WINDOW_ROUTE_SURFACES,
    kind: 'handle',
    run: (_target, event, args) => openProjectWindow(args[0], senderWindowFor(event)),
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

async function createWindow(): Promise<void> {
  windowStateManager = new WindowStateManager(StorageLocations.getConfigDir(), 1360, 880);

  // The project identity this build boots for. It keys the window directory, the
  // control plane and every owner-keyed record, so it is resolved (and validated)
  // once, before any window is admitted.
  const projectId = validateControlPlaneId(process.env.ANTIFAN_PROJECT_ID || DEFAULT_BOOT_PROJECT_ID, 'project');
  bootProjectIdValue = projectId;
  const owner: WindowOwner = { kind: 'project', projectId };

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
          title: shellTitleFor(record.title),
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
          // First paint stays the presenter's job (see `presentBootstrapWindow`): showing
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
      if (spawnResult.handle) {
        const proxy = new DaemonTerminalProxy({
          port: spawnResult.handle.port,
          token: spawnResult.handle.token,
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

  const workspaceId = validateControlPlaneId(process.env.ANTIFAN_WORKSPACE_ID || DEFAULT_BOOT_WORKSPACE_ID, 'workspace');
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
      allowsTab: (tabId, terminalId) => hostForTabOrBootstrap(tabId).isTerminalAllowedForTab(tabId, terminalId),
      isAgentTerminal: (terminalId) => tabAuthorities.hosts().some((h) => h.getTerminalAgentAffinity(terminalId)?.status === 'alive'),
      bind: (terminalId, generation, tabId) => hostForTabOrBootstrap(tabId).bindTerminalAgentAffinity(terminalId, generation, tabId),
    },
    artifactStoreOptions: resolveArtifactStoreOptionsFromEnv(),
    getAutomationTabId: () => {
      for (const h of tabAuthorities.hosts()) {
        const id = h.getAutomationTabId();
        if (id) return id;
      }
      return null;
    },
    getDocumentGeneration: (tabId) => hostForTabOrBootstrap(tabId).getDocumentGeneration(tabId),
    isTabAllowed: (primaryTabId, requestedTabId) => hostForTabOrBootstrap(primaryTabId).isTabAllowedForPrimary(primaryTabId, requestedTabId),
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
    releaseSessionTab: (sessionId, tabId) => hostForTabOrBootstrap(tabId).releaseSessionTab(sessionId, tabId),
    releaseSessionTabPool: (sessionId) => {
      let anyReleased = false;
      for (const host of tabAuthorities.hosts()) {
        if (host.releaseSessionTabPool(sessionId)) anyReleased = true;
      }
      return anyReleased;
    },
  });

  // Synchronize capsule affiliations into the shared ProjectRegistry before opening any window
  if (capsuleManager) {
    synchronizeCapsulesWithRegistry(capsuleManager, projectRegistry, StorageLocations.getControlPlaneDir());
  }

  // Every window — this one and every later one — goes through the same factory.
  const { shell, host: bootstrapHost } = await ensureProjectWindow(owner, 'user');
  bootstrapShell = shell;
  recordBenchmark({ surface: 'startup', name: 'windowCtor' });

  // Set Top Menubar (File, Edit, Selection, View, Go, Run, Terminal, Help)
  installApplicationMenu();

  // Show the window as soon as its renderer paints (see `presentBootstrapWindow`), so
  // the user sees chrome immediately instead of waiting for the ~4s ledger/attachments
  // replay.
  presentBootstrapWindow(shell);

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

  // Phase 2 (step 10): deterministic attachment disposal. When an attachment is
  // revoked or expires, close ONLY the agent tab it owns (offscreen) and its
  // terminal affinity — never a user-visible tab nor another attachment's
  // resource. Agent tabs are provisioned offscreen, so isTabOffscreen is the safe
  // discriminator: a user-visible tab is never offscreen and is never closed here.
  // tabHost.closeTab already releases viewport locks, agent-working state,
  // terminal affinity, session pools, and partitions for that single tab.
  //
  // One reservation table for both seams, installed before either can serve a request:
  // the registry refuses a mint, a rebind or an adoption onto a page a close attempt has
  // reserved (a binding that arrived during unload would be destroyed with the page), and
  // the transport refuses dispatch whose admitted operation the gate could not measure.
  controlPlane.runs.attachments.setCloseAdmission(closeReservations);
  controlPlane.transport.setCloseAdmission(closeReservations);
  controlPlane.runs.attachments.setDisposeListener(({ attachmentId, tabId }) => {
    if (!tabId) return;
    const host = tabAuthorities.hostForTab(tabId);
    if (!host) return;
    if (host.isTabOffscreen(tabId) !== true) return; // never close a user-visible tab
    try {
      host.closeTab(tabId);
      console.log(`[antifan] Attachment ${attachmentId} disposed; closed owned agent tab ${tabId}`);
    } catch (err) {
      console.warn(`[antifan] Attachment ${attachmentId} disposal: failed to close agent tab ${tabId}`, err);
    }
  });
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
    getManagedTabIds: (primaryOrBoundTabId) => hostForTabOrBootstrap(primaryOrBoundTabId).getManagedTabIdsForBoundTab(primaryOrBoundTabId),
    isTabAllowed: (primaryOrBoundTabId, requestedTabId) => hostForTabOrBootstrap(primaryOrBoundTabId).isTabAllowedForPrimary(primaryOrBoundTabId, requestedTabId),
    getTabList: () => tabAuthorities.hosts().flatMap((h) => h.getTabList()),
    getSessionTabList: (boundTabId) => hostForTabOrBootstrap(boundTabId).getSessionTabRecords(boundTabId),
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
    isTabOffscreen: (tabId) => (tabId ? hostForTabOrBootstrap(tabId).isTabOffscreen(tabId) : false),
    resolveTabAffiliation: (tabId) => {
      const host = hostForTabOrBootstrap(tabId);
      if (!host.hasTab(tabId)) return undefined;
      // The tab's own creation-time capsule is the measured affiliation: a tab carries the capsule
      // it was created in, while the capsule ledger holds entries no runtime path writes.
      const resolvedTabId = host.resolveTargetTabId ? host.resolveTargetTabId(tabId) : tabId;
      const capsuleId = host.getTabCapsuleId(resolvedTabId ?? tabId);
      const capsule = capsuleId ? capsuleManager?.list().find((c) => c.id === capsuleId) : undefined;
      if (!capsule) return undefined;
      return {
        projectId: capsule.projectId,
        workspaceId: capsule.workspaceId,
        capsuleId: capsule.id,
      };
    },
    createTab: (url, activate = false, options) => {
      // `anchorTabId` selects the window; the host would not know what to do with it,
      // so it is consumed here and never forwarded.
      const { anchorTabId, ...hostOptions } = options ?? {};
      return hostForTabOrBootstrap(anchorTabId).createTab(url, activate, hostOptions);
    },
    closeTab: (tabId) => hostForTabOrBootstrap(tabId).closeTab(tabId),
    switchTab: (tabId) => hostForTabOrBootstrap(tabId).switchTab(tabId),
    navigate: (tabId, url) => hostForTabOrBootstrap(tabId).navigateAndWait(tabId, url),
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
    getDocumentGeneration: (tabId) => hostForTabOrBootstrap(tabId).getDocumentGeneration(tabId),
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
  controlPlane.registerBrowser(browserPortLocal);
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
    // Runs after the tab list exists so every live partition (offscreen
    // included) vetoes its own deletion; dry-run first so the exact inventory is
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
        const automationTarget = host.getAutomationTarget() as
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
              typeof host.getDocumentGeneration === 'function'
                ? host.getDocumentGeneration(targetTabId)
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
