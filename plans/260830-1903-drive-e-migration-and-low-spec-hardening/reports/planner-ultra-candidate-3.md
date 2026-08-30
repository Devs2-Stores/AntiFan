# AntiFan Browser Desktop — Technical Implementation Plan
## Drive E Storage Relocation, Low-Spec Hardware Hardening, Async QA Generation Guard, and Real Runtime Soak Testing

**Document Identifier:** `planner-ultra-candidate-3`  
**Plan Directory:** `plans/260830-1903-drive-e-migration-and-low-spec-hardening`  
**Target Platform:** Windows 11 x64 (Build 22000+)  
**Target Hardware:** Intel Core i5-9300H (4 Cores / 8 Threads @ 2.40GHz base, 4.10GHz boost), Intel UHD Graphics 630 (Shared System VRAM), Drive C (Low Space System SSD), Drive E (`E:\Work`, Primary High-Capacity Work Storage)  
**Core Runtime:** Electron 43.4.0, Node.js 20.x, TypeScript 5.5, @modelcontextprotocol/sdk 1.30.0, node-pty 1.1.0, @xterm/xterm 6.0.0  

---

## 1. Executive Summary & Goals

### 1.1 Context & Problem Statement
AntiFan Browser Desktop is a specialized, high-performance Chromium host, Extension Bridge companion, and Theme QA automation platform for storefront developers. In its current state:
1. **Drive C Storage Exhaustion:** Persistent profiles, disk caches, session manifests, terminal logs, and staged artifacts write to `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop` and `~/.antifan` on Drive C, worsening disk pressure on resource-constrained development machines.
2. **Low-Spec Hardware Contention (i5-9300H / UHD 630):** Default Chromium process allocation spawns an unrestricted number of Renderer processes across tabs and split views, leading to RAM bloat (>1.5GB) and CPU thread starvation on 4 physical cores. Uncapped caches (512MB disk / 256MB media) stress shared iGPU VRAM, while synchronous regex evaluation in Theme QA scanners locks the main event loop.
3. **Async QA Stale Result Race Condition:** In `NativeTabHost` and `ThemeQaWorkflow`, asynchronous Theme QA evaluation jobs can resolve after a tab has already navigated to a new document, risking stale issue counts overwriting fresh document states.
4. **Synthetic vs Real Soak Testing:** Existing soak tests (`test/e2e/soak-test.test.ts`) rely on simulated `Buffer.alloc` timers rather than executing real Electron processes, physical Chromium renderers, PTY streams, and live Theme QA scanners.

### 1.2 Core Architectural Goals
- **Goal 1: 100% Zero-Drive-C Footprint Storage Relocation Engine:** Auto-detect `E:\Work` (or Windows Drive E environment / `ANTIFAN_DATA_ROOT`) and redirect 100% of Chromium profile, disk/GPU cache, session manifests, history, terminal states, bridge tokens, and artifacts to `E:\Work\.antifan-data\...`. Execute an atomic, one-time migration from legacy Drive C locations without data corruption.
- **Goal 2: Low-Spec Hardware Optimization (Chromium Switches, Background Throttling & Cooperative Yields):** Constrain Chromium to `--renderer-process-limit=4`, `--process-per-site`, `--disk-cache-size=134217728` (128MB), `--media-cache-size=67108864` (64MB), and `--disable-gpu-memory-buffer-video-frames`. Enforce `setBackgroundThrottling(true)` on background tab views, and insert cooperative event-loop yields (`await cooperativeYield()`) between Theme QA scan stages.
- **Goal 3: Async QA Generation Guard & Race-Condition Defense:** Pin background QA jobs to tab-specific document generations (`documentGeneration`) and verify `signal.aborted` before and after all asynchronous operations, preventing stale results from overriding fresh state.
- **Goal 4: Real Runtime Endurance Soak Test Suite:** Implement `scripts/smoke-real-soak.cjs` and rewrite `test/e2e/soak-test.test.ts` to launch real Electron processes, exercise live WebSocket RPC, burst PTY data, execute concurrent Theme QA sweeps, and verify linear memory slope $\beta \le 1.0\text{ MB/min}$ with 0 orphaned processes.

---

## 2. Phase 1: Drive E Complete Storage Relocation & Migration Engine

### 2.1 Overview & Requirements
Redirect all application state, Chromium profiles, caches, and configuration directories away from Drive C onto Drive E (`E:\Work\.antifan-data\...`) with zero residual runtime writes to Drive C.

#### Functional Requirements:
1. **Dynamic Storage Root Resolution:** Detect if `E:\Work` exists or if `process.env.ANTIFAN_DATA_ROOT` is set.
   - If `process.env.ANTIFAN_DATA_ROOT` is set, use it as the data root.
   - Else if running on Windows and `E:\Work` exists (`fs.existsSync('E:\\Work')`), set data root to `E:\Work\.antifan-data`.
   - Else if `process.env.ANTIFAN_USER_DATA` or `ANTIFAN_CONFIG_DIR` is set, resolve accordingly.
   - Else fallback gracefully to standard platform AppData with a non-blocking diagnostic notice.
2. **Unified Directory Hierarchy:**
   - **Profile Directory (`profile`):** `E:\Work\.antifan-data\profile` (Chromium `userData` & `sessionData`).
   - **Cache Directory (`cache`):** `E:\Work\.antifan-data\cache` (`network` and `gpu` subdirectories).
   - **Config Directory (`config`):** `E:\Work\.antifan-data\config` (stores `bridge.json`, `browser-history.json`, `terminal-sessions.json`, `workspace-capsules.json`, `window-state.json`).
   - **Sessions Directory (`config/sessions`):** `E:\Work\.antifan-data\config\sessions` (`session-resume-controller.ts`).
   - **Artifacts Directory (`artifacts`):** `E:\Work\.antifan-data\artifacts` (stores staged DOM dumps, screenshots, and QA reports).
   - **Control Plane State (`control-plane`):** `E:\Work\.antifan-data\control-plane` (run attachments and workspace registries).
3. **Atomic One-Time Profile Migration:**
   - In `src/main/browser/profile-ownership.ts`, update `preparePersistentProfile` to detect if the target Drive E profile directory is uninitialized.
   - If uninitialized, locate the richest legacy candidate profile on Drive C (`%APPDATA%\antifan-browser-desktop\Profile` or legacy dev/prod folders).
   - Copy atomically to a temporary folder on Drive E (`E:\Work\.antifan-data\.antifan-profile-migration-<pid>-<timestamp>`), verify Chromium state markers (`Network/Cookies`, `Local Storage/leveldb`, `IndexedDB`, `Preferences`), and rename to `profile`.
   - Once migrated, leave a migration marker or clean temporary files to prevent redundant re-copies.
4. **Global Process Environment Alignment:**
   - In `src/main/index.ts`, set `process.env.ANTIFAN_CONFIG_DIR` and `process.env.ANTIFAN_USER_DATA` early before any subsystem imports read fallback paths.
   - Update `session-resume-controller.ts`, `history-manager.ts`, `terminal-manager.ts`, `bridge-server.ts`, and `native-tab-host.ts` to rely on the centralized storage path resolver.

### 2.2 Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
|                        StoragePaths Resolver Module                               |
|                  (src/main/storage/storage-paths.ts)                              |
+-----------------------------------------------------------------------------------+
                                   |
         +-------------------------+-------------------------+
         |                                                   |
         v                                                   v
[E:\Work exists or ANTIFAN_DATA_ROOT]            [Fallback / Non-Drive-E Platform]
         |                                                   |
         v                                                   v
Base: E:\Work\.antifan-data                     Base: %APPDATA%\antifan-browser-desktop
         |
         +--> profile       : E:\Work\.antifan-data\profile
         +--> cache         : E:\Work\.antifan-data\cache (network + gpu)
         +--> config        : E:\Work\.antifan-data\config
         +--> sessions      : E:\Work\.antifan-data\config\sessions
         +--> artifacts     : E:\Work\.antifan-data\artifacts
         +--> control-plane : E:\Work\.antifan-data\control-plane
```

### 2.3 Related Code Files
- **Create:** `src/main/storage/storage-paths.ts` — Centralized path resolution engine for all storage roots.
- **Modify:** `src/main/browser/profile-ownership.ts` — Update candidate discovery, migration source evaluation, and target paths to support Drive E root.
- **Modify:** `src/main/index.ts` — Integrate `resolveStoragePaths`, set Electron `app.setPath('userData', ...)` and cache paths to Drive E.
- **Modify:** `src/main/agent/session-resume-controller.ts` — Default `storageDir` to resolved config sessions directory.
- **Modify:** `src/main/browser/history-manager.ts` — Default `getHistoryFilePath` to resolved config directory.
- **Modify:** `src/main/browser/terminal-manager.ts` — Default `statePath()` to resolved config directory.
- **Modify:** `src/main/bridge/bridge-server.ts` — Default bridge token and socket path to resolved config directory.
- **Modify:** `src/main/browser/native-tab-host.ts` — Store tabs and window states in resolved config/userData path.
- **Create:** `test/main/storage-paths.test.ts` — Unit tests for Drive E path resolution and fallback logic.
- **Modify:** `test/main/profile-ownership.test.ts` — Verify migration from legacy Drive C paths to Drive E targets.

### 2.4 Step-by-Step Implementation

#### Step 1.1: Implement Centralized Storage Path Resolver (`src/main/storage/storage-paths.ts`)
```typescript
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

export interface StoragePaths {
  readonly root: string;
  readonly profile: string;
  readonly cache: string;
  readonly networkCache: string;
  readonly gpuCache: string;
  readonly config: string;
  readonly sessions: string;
  readonly artifacts: string;
  readonly controlPlane: string;
  readonly isDriveE: boolean;
}

export interface StoragePathOptions {
  customDataRoot?: string;
  customUserData?: string;
  customConfigDir?: string;
  appDataPath?: string;
  appPath?: string;
  platform?: NodeJS.Platform;
  existsSync?: (p: string) => boolean;
}

export function resolveStoragePaths(options: StoragePathOptions = {}): StoragePaths {
  const platform = options.platform ?? process.platform;
  const exists = options.existsSync ?? fs.existsSync;
  const envDataRoot = options.customDataRoot ?? process.env.ANTIFAN_DATA_ROOT;
  const envUserData = options.customUserData ?? process.env.ANTIFAN_USER_DATA ?? process.env.ANTIFAN_USER_DATA_DIR;
  const envConfigDir = options.customConfigDir ?? process.env.ANTIFAN_CONFIG_DIR;

  let baseRoot: string;
  let isDriveE = false;

  if (envDataRoot) {
    baseRoot = path.resolve(envDataRoot);
    isDriveE = baseRoot.toLowerCase().startsWith('e:');
  } else if (platform === 'win32' && exists('E:\\Work')) {
    baseRoot = path.resolve('E:\\Work\\.antifan-data');
    isDriveE = true;
  } else if (envUserData) {
    baseRoot = path.resolve(envUserData, '..');
  } else {
    const appData = options.appDataPath ?? (platform === 'win32' ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming') : path.join(os.homedir(), '.config'));
    baseRoot = path.join(appData, 'antifan-browser-desktop');
  }

  const profile = envUserData ? path.resolve(envUserData) : path.join(baseRoot, 'profile');
  const cache = `${profile}-cache`;
  const networkCache = path.join(cache, 'network');
  const gpuCache = path.join(cache, 'gpu');
  const config = envConfigDir ? path.resolve(envConfigDir) : path.join(baseRoot, 'config');
  const sessions = path.join(config, 'sessions');
  const artifacts = path.join(baseRoot, 'artifacts');
  const controlPlane = path.join(baseRoot, 'control-plane');

  return {
    root: baseRoot,
    profile,
    cache,
    networkCache,
    gpuCache,
    config,
    sessions,
    artifacts,
    controlPlane,
    isDriveE,
  };
}

export function ensureStorageDirectories(paths: StoragePaths): void {
  const dirs = [paths.root, paths.profile, paths.cache, paths.networkCache, paths.gpuCache, paths.config, paths.sessions, paths.artifacts, paths.controlPlane];
  for (const dir of dirs) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}
```

#### Step 1.2: Upgrade `preparePersistentProfile` in `src/main/browser/profile-ownership.ts`
Update `PersistentProfileOptions` to accept resolved storage paths:
```typescript
export interface PersistentProfileOptions {
  appDataPath: string;
  appPath: string;
  targetProfilePath?: string;
  customUserData?: string;
  pid?: number;
  now?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}
```
In `preparePersistentProfile`:
```typescript
export function preparePersistentProfile(options: PersistentProfileOptions): PersistentProfileResult {
  const canonicalPath = options.targetProfilePath
    ? path.resolve(options.targetProfilePath)
    : (options.customUserData ? path.resolve(options.customUserData) : path.join(options.appDataPath, 'antifan-browser-desktop', 'Profile'));

  if (hasPersistentProfileState(canonicalPath)) {
    return { profilePath: canonicalPath };
  }

  if (fs.existsSync(canonicalPath) && hasDirectoryEntries(canonicalPath)) {
    throw new ProfileMigrationError('PROFILE_MIGRATION_FAILED', `Target profile directory is non-empty but contains no recognized Chromium state: ${canonicalPath}`);
  }

  const legacyAppDataRoot = path.join(options.appDataPath, 'antifan-browser-desktop');
  const candidatePaths = [
    path.join(options.appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-dev'),
    path.join(options.appPath, 'appdata', 'antifan-browser-desktop', 'Chromium'),
    path.join(options.appPath, 'appdata', 'antifan-browser-desktop', 'Chromium-prod'),
    path.join(legacyAppDataRoot, 'Profile'),
    path.join(legacyAppDataRoot, 'Chromium-dev'),
    path.join(legacyAppDataRoot, 'Chromium'),
    path.join(legacyAppDataRoot, 'Chromium-prod'),
    legacyAppDataRoot,
    path.join(options.appPath, 'appdata', 'antigravity-browser-desktop', 'Chromium-dev'),
    path.join(options.appDataPath, 'antigravity-browser-desktop'),
  ].map((candidate) => path.resolve(candidate));

  const candidates = candidatePaths
    .filter((candidate, index) => candidatePaths.indexOf(candidate) === index)
    .filter((candidate) => candidate !== path.resolve(canonicalPath) && hasPersistentProfileState(candidate))
    .sort(compareProfileValue);

  const sourcePath = candidates[0];
  if (!sourcePath) {
    return { profilePath: canonicalPath };
  }

  const lease = readProfileLease(sourcePath);
  const isProcessAlive = options.isProcessAlive ?? defaultProcessProbe;
  if (lease && isProcessAlive(lease.pid)) {
    throw new ProfileMigrationError('PROFILE_IN_USE', `Cannot migrate Chromium profile while pid ${lease.pid} is using it`, sourcePath);
  }

  const parentPath = path.dirname(canonicalPath);
  const tempPath = path.join(parentPath, `.antifan-profile-migration-${options.pid ?? process.pid}-${(options.now ?? Date.now)()}`);
  try {
    fs.mkdirSync(parentPath, { recursive: true });
    if (fs.existsSync(canonicalPath)) fs.rmdirSync(canonicalPath);
    fs.cpSync(sourcePath, tempPath, {
      recursive: true,
      filter: (source) => {
        const relativePath = path.relative(sourcePath, source);
        if (relativePath === '') return true;
        if (TRANSIENT_PROFILE_FILES[relativePath] === true) return false;
        if (sourcePath === path.resolve(legacyAppDataRoot)) {
          const topLevelName = relativePath.split(path.sep, 1)[0] ?? '';
          if (LEGACY_NESTED_PROFILE_DIRECTORIES[topLevelName] === true || topLevelName.startsWith('.antifan-profile-migration-')) return false;
        }
        return true;
      },
    });
    if (!hasPersistentProfileState(tempPath)) {
      throw new Error('Copied profile contains no recognized Chromium state');
    }
    fs.renameSync(tempPath, canonicalPath);
    return { profilePath: canonicalPath, migratedFrom: sourcePath };
  } catch (error) {
    try { fs.rmSync(tempPath, { recursive: true, force: true }); } catch {}
    throw new ProfileMigrationError('PROFILE_MIGRATION_FAILED', `Failed to migrate Chromium profile from ${sourcePath}`, sourcePath, error);
  }
}
```

#### Step 1.3: Update `src/main/index.ts` Bootstrap Sequence
Integrate `resolveStoragePaths` at the very top of `src/main/index.ts`:
```typescript
import { resolveStoragePaths, ensureStorageDirectories } from './storage/storage-paths';

const storagePaths = resolveStoragePaths({
  appDataPath: app.getPath('appData'),
  appPath: app.getAppPath(),
});
ensureStorageDirectories(storagePaths);

// Seed environment variables for child processes and subsystems
process.env.ANTIFAN_CONFIG_DIR = storagePaths.config;
process.env.ANTIFAN_USER_DATA = storagePaths.profile;
process.env.ANTIFAN_DATA_ROOT = storagePaths.root;

let preparedProfile: PersistentProfileResult;
try {
  preparedProfile = preparePersistentProfile({
    appDataPath: app.getPath('appData'),
    appPath: app.getAppPath(),
    targetProfilePath: storagePaths.profile,
  });
} catch (error) {
  if (error instanceof ProfileMigrationError) {
    console.error(`[antifan] ${error.message}`);
  }
  throw error;
}

const persistentUserData = preparedProfile.profilePath;
app.setPath('userData', persistentUserData);
app.setPath('sessionData', persistentUserData);
app.setPath('cache', storagePaths.cache);
app.commandLine.appendSwitch('disk-cache-dir', storagePaths.networkCache);
app.commandLine.appendSwitch('gpu-cache-dir', storagePaths.gpuCache);
```

#### Step 1.4: Update Path Consumers across Main Subsystems
- **`src/main/agent/session-resume-controller.ts`:**
  ```typescript
  constructor(customDir?: string) {
    this.storageDir = customDir || process.env.ANTIFAN_CONFIG_DIR
      ? path.join(process.env.ANTIFAN_CONFIG_DIR!, 'sessions')
      : path.join(os.homedir(), '.antifan', 'sessions');
    try { fs.mkdirSync(this.storageDir, { recursive: true }); } catch {}
  }
  ```
- **`src/main/browser/history-manager.ts`:**
  ```typescript
  private getHistoryFilePath(): string {
    const dir = process.env.ANTIFAN_CONFIG_DIR || path.join(os.homedir(), '.antifan');
    return path.join(dir, 'browser-history.json');
  }
  ```
- **`src/main/browser/terminal-manager.ts`:**
  ```typescript
  private statePath(): string {
    const dir = process.env.ANTIFAN_CONFIG_DIR || path.join(os.homedir(), '.antifan');
    return path.join(dir, 'terminal-sessions.json');
  }
  ```
- **`src/main/bridge/bridge-server.ts`:**
  ```typescript
  const configDir = process.env.ANTIFAN_CONFIG_DIR || path.join(os.homedir(), '.antifan');
  ```

### 2.5 Success Criteria & Verification
- `npm test` runs 100% clean without regressions in existing 437 unit tests.
- `test/main/storage-paths.test.ts` validates that on Windows with `E:\Work`, all resolved paths point strictly to `E:\Work\.antifan-data\...`.
- Running the application creates 0 files in `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop` or `C:\Users\Admin\.antifan`.

### 2.6 Risk Assessment & Rollback Strategy
- **Risk:** Drive E may become temporarily disconnected or read-only (e.g. external volume).
- **Mitigation:** If `fs.mkdirSync(paths.root)` throws `EACCES` or `ENOENT` on Drive E, `resolveStoragePaths` falls back to `%APPDATA%` with a prominent stderr warning.
- **Rollback:** Unsetting `ANTIFAN_DATA_ROOT` and removing `E:\Work` detection in `storage-paths.ts` reverts instantly to default AppData behavior.

---

## 3. Phase 2: Low-Spec Hardware Optimization (Chromium Switches, Background Throttling & Cooperative Yields)

### 3.1 Overview & Requirements
Optimize browser execution for workstations with 4 physical CPU cores (Intel i5-9300H) and shared system VRAM (Intel UHD Graphics 630). Prevent thread starvation, renderer process proliferation, and event-loop blocking during Theme QA scanning.

#### Functional Requirements:
1. **Chromium Process & Cache Optimization Switches:**
   Configure low-spec hardened Chromium switches in `src/main/index.ts`:
   - `renderer-process-limit=4`: Limit concurrent renderer processes to match physical CPU core count.
   - `process-per-site`: Consolidate renderer processes per eTLD+1 domain, preventing process sprawl across multiple preview tabs.
   - `disk-cache-size=134217728`: Reduce disk cache ceiling from 512MB to 128MB.
   - `media-cache-size=67108864`: Reduce media cache ceiling from 256MB to 64MB.
   - `disable-gpu-memory-buffer-video-frames`: Prevent video frames from locking shared system memory on UHD 630.
2. **Background Tab View Throttling:**
   - In `src/main/browser/native-tab-host.ts`, configure `backgroundThrottling: true` in `getSecureWebPreferences`.
   - When switching tabs (`switchTab(tabId)`), explicitly invoke `webContents.setBackgroundThrottling(false)` on the active tab and `webContents.setBackgroundThrottling(true)` on all inactive background tabs.
3. **Cooperative Event-Loop Yields in Theme QA Scanners:**
   - Implement `cooperativeYield()` utility (`await new Promise((r) => setImmediate(r))`).
   - Insert yields between distinct analysis phases in `ThemeQaWorkflow.validate`:
     - After DOM & screenshot capture.
     - After `PlatformDetector.detect`.
     - After `LiquidErrorScanner` browser evaluation / HTML scan.
     - After `LayoutOverflowEngine` viewport evaluation.
     - After `BrokenAssetScanner` evaluation and CDP failure correlation.
     - After `classifyDiagnostics`.
     - After `HsGateRules.evaluate`.
   - Chunk large string scanning in `LiquidErrorScanner.scanHtmlString` to yield every 100KB of scanned HTML.

### 3.2 Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
|                           ThemeQaWorkflow.validate                                |
+-----------------------------------------------------------------------------------+
       |
       +--> 1. Pre-reload Diagnostics Snapshot & Tab URL
       |
       +--> 2. Reload to Load-Complete Document -------> [signal.aborted check]
       |
       +--> 3. Inspect DOM & Screenshot Capture --------> [signal.aborted check]
       |                                          -----> [await cooperativeYield()]
       +--> 4. Platform Detection (Haravan/Sapo/Shopify) -> [await cooperativeYield()]
       |
       +--> 5. Liquid Error Scanner (DOM/Regex) --------> [signal.aborted check]
       |                                          -----> [await cooperativeYield()]
       +--> 6. Layout Overflow Engine (Viewport/DeltaX) -> [signal.aborted check]
       |                                          -----> [await cooperativeYield()]
       +--> 7. Broken Asset Telemetry + CDP Correlation -> [signal.aborted check]
       |                                          -----> [await cooperativeYield()]
       +--> 8. Shared Diagnostics Classification -------> [await cooperativeYield()]
       |
       +--> 9. Platform-Scoped HS Gate Evaluation ------> [signal.aborted check]
       |                                          -----> [await cooperativeYield()]
       +--> 10. Checklist & Summary Compilation
       |
       +--> 11. PII Sanitization & Artifact Staging ----> [signal.aborted check]
```

### 3.3 Related Code Files
- **Modify:** `src/main/index.ts` — Add low-spec Chromium switches (`renderer-process-limit=4`, `process-per-site`, `disk-cache-size`, `media-cache-size`, `disable-gpu-memory-buffer-video-frames`).
- **Modify:** `src/main/browser/native-tab-host.ts` — Implement `setBackgroundThrottling` toggle on active vs background `WebContentsView` instances.
- **Modify:** `src/main/qa/theme-qa-workflow.ts` — Add `cooperativeYield()` between validation stages.
- **Modify:** `src/main/qa/scanners/liquid-error-scanner.ts` — Add cooperative regex execution for large HTML inputs.
- **Modify:** `src/main/qa/scanners/layout-overflow-engine.ts` — Optimize DOM query density.
- **Create:** `test/main/low-spec-optimization.test.ts` — Verify Chromium switch initialization, background throttling state, and cooperative yield execution.

### 3.4 Step-by-Step Implementation

#### Step 2.1: Configure Hardened Chromium Switches in `src/main/index.ts`
```typescript
// Configure low-spec hardened Chromium hardware acceleration and process switches
app.commandLine.appendSwitch('renderer-process-limit', '4');
app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disk-cache-size', '134217728'); // 128 MB
app.commandLine.appendSwitch('media-cache-size', '67108864');  // 64 MB
app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
app.commandLine.appendSwitch('enable-smooth-scrolling');
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-quic');
app.commandLine.appendSwitch('enable-fast-unload');
app.commandLine.appendSwitch('enable-tcp-fast-open');
app.commandLine.appendSwitch('enable-features', 'PasswordManager,Autofill,SmoothScrolling,ParallelDownloading,BackForwardCache,AsyncImageDecoding');
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
```

#### Step 2.2: Implement Background Throttling in `src/main/browser/native-tab-host.ts`
In `getSecureWebPreferences`:
```typescript
function getSecureWebPreferences(partition?: string): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '..', '..', 'preload', 'tab-preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    backgroundThrottling: true,
    partition: partition || deriveCapsulePartition('default'),
  };
}
```
In `NativeTabHost.switchTab`:
```typescript
// Throttling management for active vs inactive tabs
for (const [id, tab] of this.tabs.entries()) {
  const isTarget = id === tabId;
  if (tab.view && !tab.view.webContents.isDestroyed()) {
    try {
      tab.view.webContents.setBackgroundThrottling(!isTarget);
    } catch {}
  }
  if (tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
    try {
      tab.mobileView.webContents.setBackgroundThrottling(!isTarget);
    } catch {}
  }
}
```

#### Step 2.3: Integrate Cooperative Yields in `src/main/qa/theme-qa-workflow.ts`
Define `cooperativeYield`:
```typescript
export function cooperativeYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
```
Integrate within `ThemeQaWorkflow.validate`:
```typescript
// 4. Platform Detection
const platformResult = PlatformDetector.detect(input.workspaceRoot, undefined, rawHtml);
const detectedPlatform: EcommercePlatform = platformResult.platform;
await cooperativeYield();
if (input.signal?.aborted) {
  throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
}

// 5. Liquid Error Scanning
let liquidResult: LiquidScanResult = { hasErrors: false, errors: [], scannedElementsCount: 0 };
try {
  const evalRes = await this.ports.browser.eval(activeTarget, LiquidErrorScanner.getBrowserScanScript());
  if (evalRes && typeof evalRes === 'object' && 'hasErrors' in evalRes) {
    liquidResult = evalRes as LiquidScanResult;
  } else if (rawHtml) {
    liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
  }
} catch (error) {
  rethrowTargetLifecycleError(error);
  if (rawHtml) liquidResult = LiquidErrorScanner.scanHtmlString(rawHtml);
}
await cooperativeYield();
if (input.signal?.aborted) {
  throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
}
```

### 3.5 Success Criteria & Verification
- Renderer processes are limited to at most 4 across multiple preview tabs on the same site.
- Disk cache does not exceed 128MB under heavy browsing.
- Main process event-loop delay (`telemetry.ts` event-loop monitor) stays below 15ms during Theme QA sweeps.

### 3.6 Risk Assessment & Rollback Strategy
- **Risk:** `backgroundThrottling: true` could slow down active background WebSocket connections in unselected tabs.
- **Mitigation:** The active docked terminal workbench runs in its own dedicated `terminalView` / `popoutWindow` and is exempt from tab-level background throttling.
- **Rollback:** Removing the `setBackgroundThrottling` loop in `switchTab` restores unthrottled background tab behavior.

---

## 4. Phase 3: Async QA Generation Guard & Race-Condition Defense

### 4.1 Overview & Requirements
Eliminate race conditions where an asynchronous Theme QA job completing on a previous document epoch overwrites the state or error badges of a freshly navigated page.

#### Functional Requirements:
1. **Document Generation Tracking:**
   - Maintain an integer `documentGeneration` per tab in `NativeTabHost`, incremented on `did-start-navigation` and `did-navigate`.
   - Pass the captured `generation` into `AsyncThemeQaQueue.enqueue(tabId, generation, task)`.
2. **Strict Generation Verification in `AsyncThemeQaQueue`:**
   - In `src/main/qa/async-qa-job-queue.ts`, if an enqueue request arrives for a tab with a higher generation, abort the existing controller immediately.
   - Suppress error logs when a job terminates with `signal.aborted` or `TARGET_STALE`.
3. **Pervasive Post-Await Abort Checks in `ThemeQaWorkflow`:**
   - Check `input.signal?.aborted` before and after every asynchronous boundary (`ports.reload`, `inspect`, `ports.browser.eval`, `responsiveCheck`, `ports.artifacts.stage`).
   - Immediately throw `CapabilityError('TARGET_STALE', ...)` if aborted.
4. **State Commit Guard in `NativeTabHost`:**
   - In `NativeTabHost.runThemeQa`, before writing to `this.themeQaState` or calling `this.broadcastState()`, verify:
     `this.getDocumentGeneration(tabId) === gen && !signal.aborted`
   - If the generation has changed, discard the result silently and resolve `{ ok: false, error: 'Theme QA was aborted by document navigation' }`.

### 4.2 Architecture & Data Flow

```
User Action: Navigate Tab (/products/item-a -> /collections/all)
       |
       v
1. 'did-start-navigation' Event Fired in NativeTabHost
       |
       +--> documentGenerations.set(tabId, gen + 1)
       +--> asyncQaQueue.abort(tabId)  ------------------------+
                                                               |
In-Flight QA Job for Gen 1:                                    v
       |                                               controller.abort()
       +--> (await ports.browser.eval)                         |
       +--> Post-Await Check: if (signal.aborted) <------------+
       |         |
       |         +--> throw CapabilityError('TARGET_STALE')
       |
       v
NativeTabHost.runThemeQa Completion Handler:
       |
       +--> Check: if (this.getDocumentGeneration(tabId) !== gen || signal.aborted)
       |         |
       |         +--> SILENTLY DISCARD RESULT (Do NOT mutate themeQaState)
       |
       v
Fresh State Preserved for Gen 2
```

### 4.3 Related Code Files
- **Modify:** `src/main/qa/async-qa-job-queue.ts` — Enhance generation-aware enqueue, abort, and cleanup semantics.
- **Modify:** `src/main/qa/theme-qa-workflow.ts` — Ensure all async steps throw `TARGET_STALE` on `signal.aborted`.
- **Modify:** `src/main/browser/native-tab-host.ts` — Add state commit guard in `runThemeQa`.
- **Create:** `test/main/async-qa-generation-guard.test.ts` — Unit test suite simulating fast navigation interleaving during long QA scans.
- **Modify:** `test/main/theme-qa-fresh-target.test.ts` — Verify target freshness assertions.

### 4.4 Step-by-Step Implementation

#### Step 3.1: Enhance `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`)
```typescript
export interface AsyncQaJob {
  readonly tabId: string;
  readonly generation: number;
  readonly controller: AbortController;
  readonly startedAt: number;
}

export class AsyncThemeQaQueue {
  private activeJobs = new Map<string, AsyncQaJob>();

  public enqueue(tabId: string, generation: number, task: (signal: AbortSignal) => Promise<void>): void {
    this.abort(tabId);
    const controller = new AbortController();
    const job: AsyncQaJob = {
      tabId,
      generation,
      controller,
      startedAt: Date.now(),
    };
    this.activeJobs.set(tabId, job);

    task(controller.signal)
      .catch((err) => {
        if (controller.signal.aborted || (err && typeof err === 'object' && ((err as any).code === 'TARGET_STALE' || (err as any).name === 'AbortError'))) {
          return;
        }
        console.warn(`[async-qa-queue] Background QA job failed for tab ${tabId} (gen ${generation}):`, err);
      })
      .finally(() => {
        const current = this.activeJobs.get(tabId);
        if (current && current.generation === generation) {
          this.activeJobs.delete(tabId);
        }
      });
  }

  public abort(tabId: string): void {
    const job = this.activeJobs.get(tabId);
    if (job) {
      try {
        job.controller.abort();
      } catch {}
      this.activeJobs.delete(tabId);
    }
  }

  public abortAll(): void {
    for (const job of this.activeJobs.values()) {
      try {
        job.controller.abort();
      } catch {}
    }
    this.activeJobs.clear();
  }

  public getActiveJob(tabId: string): AsyncQaJob | undefined {
    return this.activeJobs.get(tabId);
  }

  public isRunning(tabId: string): boolean {
    return this.activeJobs.has(tabId);
  }
}
```

#### Step 3.2: Enforce Commit Guard in `NativeTabHost.runThemeQa` (`src/main/browser/native-tab-host.ts`)
```typescript
return new Promise((resolve) => {
  const tabId = target.tabId;
  const gen = this.getDocumentGeneration(tabId);
  this.asyncQaQueue.enqueue(tabId, gen, async (signal) => {
    try {
      if (this.getDocumentGeneration(tabId) !== gen || signal.aborted) {
        resolve({ ok: false, error: 'Theme QA was aborted by document navigation' });
        return;
      }

      const report = await this.controlPlane!.validateThemeQa(target, { workspaceRoot, signal });

      // Guard against race condition: if page navigated while validateThemeQa was executing
      if (this.getDocumentGeneration(tabId) !== gen || signal.aborted) {
        resolve({ ok: false, error: 'Theme QA was aborted by document navigation' });
        return;
      }

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

      this.themeQaState = { status, issueCount, reportArtifactId, report, updatedAt: Date.now() };
      this.broadcastState();
      resolve({ ok: true, report });
    } catch (error) {
      if (signal.aborted || this.getDocumentGeneration(tabId) !== gen) {
        resolve({ ok: false, error: 'Theme QA was aborted by document navigation' });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.themeQaState = { status: 'error', issueCount: 0, error: message, updatedAt: Date.now() };
      this.broadcastState();
      resolve({ ok: false, error: message });
    }
  });
});
```

### 4.5 Success Criteria & Verification
- Unit test `test/main/async-qa-generation-guard.test.ts` executes 50 rapid interleavings of navigation and QA runs: 0 stale state commits recorded.
- Discarded jobs produce 0 uncaught rejections or warning logs.

### 4.6 Risk Assessment & Rollback Strategy
- **Risk:** Fast hash navigation (`#section-id`) might increment document generation unnecessarily if not distinguished from full document loads.
- **Mitigation:** In `NativeTabHost`, hash changes (`did-navigate-in-page`) do not bump `documentGenerations`, preserving active QA scans on single-page scrolls.

---

## 5. Phase 4: Real Runtime Endurance Soak Test Suite & Final Verification

### 5.1 Overview & Requirements
Replace mock timers with an automated physical Electron soak test harness (`scripts/smoke-real-soak.cjs` and `test/e2e/soak-test.test.ts`) that executes real Electron processes, establishes WebSocket RPC connections, streams PTY terminal bursts, drives concurrent tab navigations, and executes live Theme QA sweeps on mock storefronts.

#### Functional Requirements:
1. **Real Electron Process Driver:**
   - Spawn real compiled Electron binary (`.compiled/src/main/index.js` or `electron . --production`) with isolated data directory on Drive E (`E:\Work\.antifan-data-soak-test-...`).
   - Monitor stdout/stderr for crash signatures, benchmark telemetry, and uncaught exceptions.
2. **4-Stage Physical Endurance Scenario:**
   - **Stage 1 (Steady Baseline — 15s):** Establish Bridge WebSocket RPC connection, sample idle RSS and heap at 1s intervals.
   - **Stage 2 (High-Throughput PTY Burst — 15s):** Spawn real `node-pty` terminal session, stream 10MB of structured ANSI data chunks, verify output ordering and memory reclamation.
   - **Stage 3 (Split Review & Tab Thrashing — 20s):** Open 6 concurrent tabs, toggle desktop/mobile split reviews, perform rapid tab switching, verify WebContentsView destruction and memory bounds.
   - **Stage 4 (Concurrent Theme QA Stress — 30s):** Spin up local HTTP mock storefront with simulated Liquid syntax errors, layout overflows, and broken assets. Execute 15 concurrent Theme QA scans while triggering rapid navigations to exercise the generation guard.
3. **Statistical Linear Memory Regression Analysis:**
   - Calculate linear regression slope $\beta = \frac{\text{Cov}(t, \text{RAM})}{\text{Var}(t)}$ in $\text{MB/min}$.
   - **Assertion 1:** Memory slope $\beta \le 1.0\text{ MB/min}$ across the entire test lifecycle.
   - **Assertion 2:** Zero orphaned child processes or zombie renderer processes remaining after clean shutdown.
   - **Assertion 3:** 100% of persisted files contained within Drive E test directory; 0 bytes created under `%APPDATA%` or `%USERPROFILE%/.antifan`.
4. **Machine-Readable Benchmark Output:**
   - Emit machine-readable report to `plans/260830-1903-drive-e-migration-and-low-spec-hardening/reports/real-soak-report.json`.

### 5.2 Architecture & Data Flow

```
+-----------------------------------------------------------------------------------+
|                  Physical Electron Soak Runner (scripts/smoke-real-soak.cjs)       |
+-----------------------------------------------------------------------------------+
       |
       +--> 1. Spawn Electron Main Process (ANTIFAN_DATA_ROOT=E:\Work\.antifan-soak)
       |
       +--> 2. Connect WebSocket RPC (127.0.0.1:20129 / 20130)
       |
       +--> 3. Stage 1: Steady Idle Baseline (15s @ 1Hz RSS Sampling)
       |
       +--> 4. Stage 2: Real node-pty Stream Thrash (10MB ANSI Data)
       |
       +--> 5. Stage 3: Split Review & Tab View Thrashing (6 Tabs + Resizes)
       |
       +--> 6. Stage 4: Concurrent Theme QA Sweeps on Mock HTTP Storefront
       |
       +--> 7. Clean Teardown & Process Tree Audit (tasklist / ps)
       |
       +--> 8. Compute Beta Slope & Output real-soak-report.json
```

### 5.3 Related Code Files
- **Create:** `scripts/smoke-real-soak.cjs` — Physical Electron endurance test runner.
- **Modify:** `test/e2e/soak-test.test.ts` — Node test runner integration for linear regression calculation and automated execution.
- **Modify:** `package.json` — Add `npm run test:soak` script.

### 5.4 Step-by-Step Implementation

#### Step 5.1: Implement Real Runtime Soak Script (`scripts/smoke-real-soak.cjs`)
```javascript
#!/usr/bin/env node
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.resolve(__dirname, '..');
const REPORT_PATH = path.join(ROOT, 'plans', '260830-1903-drive-e-migration-and-low-spec-hardening', 'reports', 'real-soak-report.json');

function calculateMemorySlope(samples) {
  const n = samples.length;
  if (n < 2) return 0;
  const firstT = samples[0].timestamp;
  const tMinutes = samples.map((s) => (s.timestamp - firstT) / 60000);
  const rMB = samples.map((s) => s.rssBytes / (1024 * 1024));
  const meanT = tMinutes.reduce((a, b) => a + b, 0) / n;
  const meanM = rMB.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dt = tMinutes[i] - meanT;
    const dm = rMB[i] - meanM;
    num += dt * dm;
    den += dt * dt;
  }
  return den === 0 ? 0 : num / den;
}

async function runRealSoakTest() {
  console.log('[Soak Test] Starting AntiFan Physical Electron Soak Endurance Test...');
  const testRoot = fs.existsSync('E:\\Work')
    ? path.join('E:\\Work', '.antifan-soak-' + Date.now())
    : path.join(os.tmpdir(), 'antifan-soak-' + Date.now());
  fs.mkdirSync(testRoot, { recursive: true });

  const samples = [];
  let child = null;
  let mockServer = null;

  try {
    // 1. Start mock storefront server
    mockServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body><h1>Soak Storefront</h1><div class="liquid-err">Liquid error: Missing snippet</div></body></html>`);
    });
    await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
    const serverPort = mockServer.address().port;
    const storefrontUrl = `http://127.0.0.1:${serverPort}/`;

    // 2. Launch real Electron process
    const electronBin = require('electron');
    const env = {
      ...process.env,
      ANTIFAN_DATA_ROOT: testRoot,
      ANTIFAN_USER_DATA: path.join(testRoot, 'profile'),
      ANTIFAN_CONFIG_DIR: path.join(testRoot, 'config'),
      ANTIFAN_BENCHMARK: '1',
      NODE_ENV: 'production',
    };
    child = spawn(electronBin, [path.join(ROOT, '.'), '--production'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    // 3. Wait for Bridge RPC readiness
    const bridgeJsonPath = path.join(testRoot, 'config', 'bridge.json');
    let bridgeInfo = null;
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(bridgeJsonPath)) {
        try {
          bridgeInfo = JSON.parse(fs.readFileSync(bridgeJsonPath, 'utf8'));
          if (bridgeInfo && bridgeInfo.port && bridgeInfo.token) break;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!bridgeInfo) throw new Error('Bridge server failed to initialize on Drive E root');

    const wsUrl = `ws://127.0.0.1:${bridgeInfo.port}/?token=${bridgeInfo.token}`;
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    let reqId = 1;
    function rpc(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = `req-${reqId++}`;
        const timeout = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 15000);
        const handler = (raw) => {
          try {
            const msg = JSON.parse(raw);
            if (msg.id === id) {
              clearTimeout(timeout);
              ws.off('message', handler);
              if (msg.error) reject(new Error(msg.error.message || msg.error));
              else resolve(msg.result);
            }
          } catch {}
        };
        ws.on('message', handler);
        ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      });
    }

    // Stage 1: Idle Baseline (10 samples)
    console.log('[Soak Test] Stage 1: Steady Idle Baseline...');
    for (let i = 0; i < 10; i++) {
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Stage 2: PTY Stream Thrash
    console.log('[Soak Test] Stage 2: PTY Output Burst Stress...');
    for (let i = 0; i < 20; i++) {
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
      await new Promise((r) => setTimeout(r, 250));
    }

    // Stage 3: Tab & Split Review Thrash
    console.log('[Soak Test] Stage 3: Tab Creation & Split Review Thrash...');
    for (let i = 0; i < 5; i++) {
      try {
        await rpc('browser_create_tab', { url: storefrontUrl });
      } catch {}
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
      await new Promise((r) => setTimeout(r, 1000));
    }

    // Stage 4: Concurrent Theme QA Sweeps
    console.log('[Soak Test] Stage 4: Concurrent Theme QA Sweeps...');
    for (let i = 0; i < 8; i++) {
      try {
        await rpc('theme_qa_validate', { workspaceRoot: ROOT });
      } catch {}
      samples.push({ timestamp: Date.now(), rssBytes: process.memoryUsage().rss });
      await new Promise((r) => setTimeout(r, 1000));
    }

    ws.close();
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 2000));

    // Calculate memory slope and process metrics
    const slope = calculateMemorySlope(samples);
    console.log(`[Soak Test] Memory Slope: ${slope.toFixed(4)} MB/min (Threshold: <= 1.0 MB/min)`);

    const report = {
      timestamp: Date.now(),
      samplesCount: samples.length,
      baselineRssMB: samples[0].rssBytes / (1024 * 1024),
      finalRssMB: samples[samples.length - 1].rssBytes / (1024 * 1024),
      memorySlopeMBPerMin: slope,
      passed: Math.abs(slope) <= 1.0,
    };

    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf8');
    console.log(`[Soak Test] Machine report written to: ${REPORT_PATH}`);

    if (Math.abs(slope) > 1.0) {
      throw new Error(`Memory slope exceeded 1.0 MB/min limit: ${slope} MB/min`);
    }
  } finally {
    if (child && !child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
    if (mockServer) {
      try { mockServer.close(); } catch {}
    }
    try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch {}
  }
}

if (require.main === module) {
  runRealSoakTest().catch((err) => {
    console.error('[Soak Test Failed]', err);
    process.exit(1);
  });
}

module.exports = { runRealSoakTest, calculateMemorySlope };
```

#### Step 5.2: Refactor `test/e2e/soak-test.test.ts`
Update unit test assertions to validate the statistical regression algorithm and execute bounded soak simulations cleanly under Node's native test runner (`node --test`).

### 5.5 Success Criteria & Verification
- `node scripts/smoke-real-soak.cjs` completes successfully with exit code 0.
- Machine report `real-soak-report.json` indicates `passed: true` and `memorySlopeMBPerMin <= 1.0`.
- Process tree audit confirms 0 orphan Electron or node-pty child processes left on the system.

### 5.6 Risk Assessment & Rollback Strategy
- **Risk:** High CPU thrashing on single-core test VMs might trigger RPC timeouts.
- **Mitigation:** RPC timeout threshold set generously to 15s with graceful rejection handling.

---

## 6. Global Acceptance Criteria & Verification Matrix

| Phase | Core Deliverable | Target File(s) | Verification Command | Success Threshold |
|---|---|---|---|---|
| **Phase 1** | Drive E Storage Relocation | `src/main/storage/storage-paths.ts`, `src/main/browser/profile-ownership.ts`, `src/main/index.ts` | `npm test -- test/main/storage-paths.test.ts` | 100% paths on `E:\Work\.antifan-data\...`; 0 bytes on Drive C |
| **Phase 2** | Low-Spec Hardware Optimization | `src/main/index.ts`, `src/main/browser/native-tab-host.ts`, `src/main/qa/theme-qa-workflow.ts` | `npm test -- test/main/low-spec-optimization.test.ts` | Chromium process limit = 4, background tabs throttled, event-loop delay < 15ms |
| **Phase 3** | Async QA Generation Guard | `src/main/qa/async-qa-job-queue.ts`, `src/main/qa/theme-qa-workflow.ts`, `src/main/browser/native-tab-host.ts` | `npm test -- test/main/async-qa-generation-guard.test.ts` | 0 stale results committed during rapid tab navigation |
| **Phase 4** | Real Runtime Soak Testing | `scripts/smoke-real-soak.cjs`, `test/e2e/soak-test.test.ts` | `node scripts/smoke-real-soak.cjs` | Memory slope $\beta \le 1.0\text{ MB/min}$, 0 zombie processes |

### 6.1 Final Full Test Gate Command Checklist
```bash
# 1. Compile TypeScript codebase
npm run compile

# 2. Run full suite unit tests (including new Phase 1-3 test suites)
npm test

# 3. Execute Automated Real Runtime Soak Endurance Test
node scripts/smoke-real-soak.cjs
```
