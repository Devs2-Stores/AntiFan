# Technical Implementation Plan: Drive E Storage Relocation, Low-Spec Hardware Hardening, Async QA Generation Defense, and Real Runtime Soak Testing

**Target Workstation Profile:**
- **CPU:** Intel Core i5-9300H (4 Cores / 8 Threads @ 2.40 GHz - 4.10 GHz Boost)
- **GPU:** Intel UHD Graphics 630 (Shared System VRAM, Direct3D 12 Feature Level 12_1)
- **RAM:** 16 GB DDR4 (Single/Dual Channel)
- **OS:** Windows 11 Pro x64 (Build 22000+)
- **Storage Topology:** Drive C (SSD - Low Space Constraint), Drive E (`E:\Work` - High Capacity Primary Work Volume)
- **Host Runtime:** Electron 43.4.0, Node.js 20+, TypeScript 5.5, @modelcontextprotocol/sdk 1.30.0, node-pty 1.1.0, @xterm/xterm 6.0.0

---

## 1. Executive Summary & Strategic Goals

### 1.1 Context & Problem Statement
AntiFan Browser Desktop is an ultra-high performance, developer-centric browser environment tailored for e-commerce storefront engineering, Shopify/Haravan/Sapo theme development, live DOM split-reviewing, and autonomous agent orchestration.

Analysis of the runtime footprint and telemetry on low-spec multi-core workstations (specifically the Intel Core i5-9300H / Intel UHD 630 target) identified four load-bearing bottlenecks:
1. **Drive C Storage Exhaustion:** Profile data (`%APPDATA%\antifan-browser-desktop\Profile`), network/GPU caches (`...-cache`), session manifests, terminal logs, and transient artifacts write by default to Drive C (`C:\Users\Admin\...`), rapidly exhausting system drive storage.
2. **Low-Spec Hardware Contention (i5-9300H / UHD 630):** Default Chromium configurations spawn unconstrained renderer processes across tabs and split views, resulting in excessive RAM usage (>1.5 GB), event-loop contention on 4 physical CPU cores, and shared VRAM pressure from oversized disk/media caches (512MB/256MB).
3. **Async QA Stale-State Race Conditions:** The background `AsyncThemeQaQueue` aborts previous jobs on navigation, but underlying asynchronous scanning operations in `ThemeQaWorkflow` awaiting CDP/DOM calls or event-loop yields can resume post-navigation if `signal.aborted` is not verified at every await boundary, risking stale QA reports overwriting fresh document states.
4. **Synthetic vs. Real Soak Testing Gaps:** Existing soak test suites rely on artificial buffer allocations and timer loops rather than launching physical Electron instances, real Chromium rendering pipelines, live node-pty streams, and concurrent Theme QA scanners under real-world endurance workloads.

### 1.2 Core Architectural Objectives
- **Zero Drive C Footprint:** Automatically detect `E:\Work` (or Drive E root) and redirect 100% of user data, Chromium profile partitions, network/GPU caches, session manifests, terminal session states, and debug artifacts to `E:\Work\.antifan-data\...`.
- **Low-Spec Hardware Optimization:** Constrain Chromium renderer process limits to 4, enforce `process-per-site`, resize disk/media caches (128MB / 64MB), disable GPU video memory buffers, enforce background tab throttling, and insert cooperative event-loop yields in theme analyzers.
- **Async QA Generation Guard:** Enforce atomic document generation tracking (`(tabId, generation)`) and post-await abort signal checks across all QA workflow stages so old generation results can never overwrite fresh page state.
- **Physical Runtime Soak Verification:** Implement an automated endurance soak test suite (`scripts/smoke-real-soak.cjs` and `test/e2e/soak-test.test.ts`) that executes physical Chromium tabs, active PTY streams, and concurrent QA scanners with zero process leaks and a memory regression slope $\le 0.5\text{ MB/min}$.

---

## 2. Phase 1: Drive E Complete Storage Relocation & Migration Engine

### 2.1 Overview & Requirements
The goal of Phase 1 is to eliminate all permanent and high-volume data writes to Drive C by relocating the application's storage root to Drive E (`E:\Work\.antifan-data`).

#### Key Requirements:
1. **Centralized Storage Path Resolver:** Create a canonical storage resolver module (`src/main/config/storage-paths.ts`) that evaluates environment variables (`ANTIFAN_DATA_ROOT`, `ANTIFAN_CONFIG_DIR`, `ANTIFAN_USER_DATA`), probes candidate root paths (`E:\Work\.antifan-data`, `E:\.antifan-data`), and falls back to `%LOCALAPPDATA%\antifan-data` only when Drive E is unavailable.
2. **Comprehensive Subdirectory Layout:**
   - Profile Root: `<DATA_ROOT>\profile` (holds Chromium default & partition cookies, IndexedDB, LocalStorage)
   - Cache Root: `<DATA_ROOT>\cache` (with `<DATA_ROOT>\cache\network` and `<DATA_ROOT>\cache\gpu`)
   - Config & State Root: `<DATA_ROOT>\config` (holds `bridge.json`, `browser-history.json`, `terminal-sessions.json`)
   - Session Manifest Root: `<DATA_ROOT>\sessions` (holds OMP/Agent session resumption manifests)
   - Artifacts Root: `<DATA_ROOT>\artifacts` (holds DOM dumps, screenshots, and QA telemetry)
   - Temp Root: `<DATA_ROOT>\tmp` (holds transient extraction files and native host shims)
3. **Atomic One-Time Profile Migration Engine:** Enhance `preparePersistentProfile` in `src/main/browser/profile-ownership.ts` to detect legacy profiles on Drive C (`%APPDATA%\antifan-browser-desktop\Profile`, `%APPDATA%\antigravity-browser-desktop`), lock the source using `ProfileOwnership` lease checks, copy to a transient directory on Drive E, verify SQLite/Chromium state markers, and atomically rename to canonical target.
4. **Zero-Byte Footprint Guarantee:** Update `session-resume-controller.ts`, `history-manager.ts`, `terminal-manager.ts`, `bridge-server.ts`, `artifact-store.ts`, and `index.ts` to consume the canonical path resolver.

### 2.2 Storage Hierarchy & Architecture

```text
E:\Work\.antifan-data\
├── profile\
│   ├── Default\
│   │   ├── Network\
│   │   │   └── Cookies (SQLite)
│   │   ├── Local Storage\
│   │   └── IndexedDB\
│   ├── Partitions\
│   └── antifan-profile.lock
├── cache\
│   ├── network\
│   └── gpu\
├── config\
│   ├── bridge.json
│   ├── browser-history.json
│   └── terminal-sessions.json
├── sessions\
│   ├── session_sess_01j7...json
│   └── manifests.lock
├── artifacts\
│   └── <runId>\
│       └── <hash>.artifact
└── tmp\
    └── .antifan-migration-tmp...
```

### 2.3 Related Code Files
- **Create:**
  - `src/main/config/storage-paths.ts`: Unified path resolution engine and directory initializer.
  - `test/main/storage-paths.test.ts`: Unit tests verifying drive detection, environment overrides, fallback logic, and directory creation.
- **Modify:**
  - `src/main/browser/profile-ownership.ts`: Direct canonical target to Drive E storage paths; integrate legacy Drive C discovery into candidate evaluation.
  - `src/main/index.ts`: Initialize storage root before `app.whenReady()`, configure `userData`, `sessionData`, `cache`, `disk-cache-dir`, and `gpu-cache-dir`.
  - `src/main/agent/session-resume-controller.ts`: Consume `getStoragePaths().sessionsDir`.
  - `src/main/browser/history-manager.ts`: Consume `getStoragePaths().configDir` and use `getStoragePaths().tempDir` for Chrome history SQLite extraction.
  - `src/main/browser/terminal-manager.ts`: Consume `getStoragePaths().configDir` for session persistence.
  - `src/main/bridge/bridge-server.ts`: Consume `getStoragePaths().configDir` for bridge connection discovery files.
  - `src/main/tools/artifact-store.ts`: Default store root to `getStoragePaths().artifactsDir`.

### 2.4 Step-by-Step Implementation

1. **Implement `StoragePathResolver` (`src/main/config/storage-paths.ts`):**
   ```typescript
   export interface AntiFanStoragePaths {
     root: string;
     profileDir: string;
     cacheDir: string;
     networkCacheDir: string;
     gpuCacheDir: string;
     configDir: string;
     sessionsDir: string;
     artifactsDir: string;
     tempDir: string;
     isDriveE: boolean;
   }

   export function resolveStorageRoot(): { root: string; isDriveE: boolean } {
     if (process.env.ANTIFAN_DATA_ROOT) {
       return { root: path.resolve(process.env.ANTIFAN_DATA_ROOT), isDriveE: process.env.ANTIFAN_DATA_ROOT.toLowerCase().startsWith('e:') };
     }
     const primaryCandidate = path.join('E:\\Work', '.antifan-data');
     if (fs.existsSync('E:\\Work') || fs.existsSync('E:\\')) {
       return { root: primaryCandidate, isDriveE: true };
     }
     const fallback = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AntiFan', 'data');
     return { root: fallback, isDriveE: false };
   }

   export function getStoragePaths(): AntiFanStoragePaths { ... }
   export function ensureStorageDirectories(): void { ... }
   ```
2. **Update Profile Ownership & Migration Engine (`src/main/browser/profile-ownership.ts`):**
   - In `preparePersistentProfile`, set `canonicalPath` to `getStoragePaths().profileDir`.
   - Include legacy `%APPDATA%\antifan-browser-desktop\Profile` and `%APPDATA%\antigravity-browser-desktop` in the `candidatePaths` array.
   - When migrating across drive boundaries (`C:` to `E:`), copy files to `path.join(getStoragePaths().tempDir, ...)` before atomic validation and rename.
   - Guard against active process locks using `readProfileLease` and `isProcessAlive`.
3. **Wire Electron Main Bootstrap (`src/main/index.ts`):**
   - Call `ensureStorageDirectories()` at the very top of `index.ts`.
   - Update `app.setPath('userData', paths.profileDir)`, `app.setPath('sessionData', paths.profileDir)`, `app.setPath('cache', paths.cacheDir)`.
   - Set command line switches:
     - `app.commandLine.appendSwitch('disk-cache-dir', paths.networkCacheDir);`
     - `app.commandLine.appendSwitch('gpu-cache-dir', paths.gpuCacheDir);`
4. **Update Dependent Subsystem Paths:**
   - `SessionResumeController`: replace `os.homedir()/.antifan/sessions` with `getStoragePaths().sessionsDir`.
   - `HistoryManager`: replace `os.homedir()/.antifan` with `getStoragePaths().configDir`, and use `getStoragePaths().tempDir` for temporary SQLite extraction.
   - `TerminalManager`: replace `os.homedir()/.antifan` with `getStoragePaths().configDir`.
   - `BridgeServer`: replace `os.homedir()/.antifan` with `getStoragePaths().configDir`.
   - `ArtifactStore`: point default root to `getStoragePaths().artifactsDir`.

### 2.5 Success Criteria & Validation Matrix
- [ ] `resolveStorageRoot()` returns `E:\Work\.antifan-data` when `E:\Work` or `E:\` exists.
- [ ] Launching the app on Windows 11 creates directories under `E:\Work\.antifan-data\` and writes 0 bytes to `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop`.
- [ ] Existing profiles on Drive C are cleanly copied to Drive E with full cookie store and state marker verification.
- [ ] Unit tests in `test/main/storage-paths.test.ts` pass with 100% coverage across environment overrides, Drive E detection, and fallback paths.

### 2.6 Risk Assessment & Rollback
- **Risk:** Drive E becomes unmounted or disconnected (e.g. external drive detachment).
  - *Mitigation:* The path resolver checks `fs.existsSync` for root drives and gracefully falls back to `%LOCALAPPDATA%\AntiFan\data` without crashing.
- **Risk:** Interrupted file copy during cross-drive migration.
  - *Mitigation:* Migration writes to an isolated temp directory (`.antifan-migration-tmp-*`) on the destination drive, verifies `hasPersistentProfileState(tempDir)` before moving, and cleans up temp files in `catch` blocks.

---

## 3. Phase 2: Low-Spec Hardware Optimization (Chromium Flags, Throttling & Cooperative Yields)

### 3.1 Overview & Requirements
On systems equipped with 4-core CPUs (e.g. Intel Core i5-9300H @ 2.40GHz) and integrated graphics sharing system RAM (Intel UHD Graphics 630), unconstrained Chromium process architectures lead to severe memory contention, high IPC latency, and UI micro-stutters.

#### Key Requirements:
1. **Chromium Process & Resource Constraining Switches:**
   - `--renderer-process-limit=4`: Limit concurrent renderer processes to match the 4 physical CPU cores.
   - `--process-per-site`: Group tabs of the same origin into a single renderer process, drastically cutting memory overhead during multi-tab storefront navigation.
   - `--disk-cache-size=134217728` (128 MB): Reduce disk cache from 512 MB to 128 MB.
   - `--media-cache-size=67108864` (64 MB): Reduce media cache from 256 MB to 64 MB.
   - `--disable-gpu-memory-buffer-video-frames`: Prevent hardware video decoders from allocating unmappable VRAM buffers that degrade Intel UHD 630 performance.
2. **Background WebContents Throttling:**
   - In `NativeTabHost`, enforce active background throttling for inactive tabs (`wc.setBackgroundThrottling(true)`).
   - Ensure the currently visible/active tab receives full priority (`wc.setBackgroundThrottling(false)` when focused, `true` when backgrounded).
   - Shell views (`sidebarView`, `terminalView`, `frameBackdropView`) must enable background throttling when hidden.
3. **Cooperative Event-Loop Yields in Heavy Analyzers:**
   - Introduce cooperative yield helper `yieldToEventLoop()` (`await new Promise((r) => setImmediate(r))`).
   - Insert cooperative yields in `LiquidErrorScanner`, `LayoutOverflowEngine`, and `BrokenAssetScanner` between heavy regex parsing, DOM traversal, and breakpoint loops to keep Node.js IPC and PTY terminal streaming 100% responsive.

### 3.2 Hardware Optimization Architecture

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                       Electron Main Process (1 Core)                         │
│   • Background WebContents Throttler                                        │
│   • Memory Watcher & Cooperative Scheduler                                  │
└───────────────────────┬─────────────────────────────┬───────────────────────┘
                        │                             │
                        ▼                             ▼
   ┌────────────────────────────────────────┐ ┌───────────────────────────────┐
   │    Chromium Renderer Pool (Max 4)      │ │   Intel UHD 630 GPU Process   │
   │  • process-per-site Consolidation      │ │  • Disk Cache: 128 MB         │
   │  • Active Tab: Unthrottled             │ │  • Media Cache: 64 MB         │
   │  • Inactive Tabs: Throttled (1 FPS)    │ │  • No GpuMemoryBuffer video   │
   └────────────────────────────────────────┘ └───────────────────────────────┘
```

### 3.3 Related Code Files
- **Modify:**
  - `src/main/index.ts`: Configure hardware acceleration and low-spec switches in `app.commandLine`.
  - `src/main/security/security-policy.ts`: Ensure `backgroundThrottling: true` is standard in `getSecureWebPreferences()`.
  - `src/main/browser/native-tab-host.ts`: Dynamically toggle `setBackgroundThrottling` on tab switch, view attachment, and split-mode transitions.
  - `src/main/qa/scanners/liquid-error-scanner.ts`: Insert cooperative yields during multi-rule evaluation.
  - `src/main/qa/scanners/layout-overflow-engine.ts`: Insert cooperative yields during element inspection loops.
  - `src/main/qa/scanners/broken-asset-scanner.ts`: Insert cooperative yields during network diagnostic correlation.
  - `src/main/qa/theme-qa-workflow.ts`: Insert cooperative yields between scanning stages (Platform -> Liquid -> Overflow -> Assets -> HS Rules).

### 3.4 Step-by-Step Implementation

1. **Apply Hardware Switches in `src/main/index.ts`:**
   ```typescript
   // Low-Spec Hardware Tuning (4-Core i5-9300H / Intel UHD 630)
   app.commandLine.appendSwitch('renderer-process-limit', '4');
   app.commandLine.appendSwitch('process-per-site');
   app.commandLine.appendSwitch('disk-cache-size', '134217728'); // 128 MB
   app.commandLine.appendSwitch('media-cache-size', '67108864');  // 64 MB
   app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');

   // Maintain Core Hardware Acceleration
   app.commandLine.appendSwitch('enable-smooth-scrolling');
   app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
   app.commandLine.appendSwitch('enable-accelerated-video-decode');
   app.commandLine.appendSwitch('enable-quic');
   app.commandLine.appendSwitch('enable-fast-unload');
   app.commandLine.appendSwitch('enable-tcp-fast-open');
   ```
2. **Implement Dynamic Background Throttling in `NativeTabHost` (`src/main/browser/native-tab-host.ts`):**
   - In `switchTab(tabId)`:
     ```typescript
     for (const [id, tab] of this.tabs) {
       const isCurrent = id === tabId;
       if (tab.view && !tab.view.webContents.isDestroyed()) {
         tab.view.webContents.setBackgroundThrottling(!isCurrent);
       }
       if (tab.mobileView && !tab.mobileView.webContents.isDestroyed()) {
         tab.mobileView.webContents.setBackgroundThrottling(!isCurrent);
       }
     }
     ```
   - In `toggleSidebar` / `toggleTerminal`: When closed, set `sidebarView.webContents.setBackgroundThrottling(true)` and `terminalView.webContents.setBackgroundThrottling(true)`.
3. **Implement Cooperative Event-Loop Yields:**
   - Add utility in `src/main/qa/scanners/scanner-utils.ts`:
     ```typescript
     export function yieldToEventLoop(): Promise<void> {
       return new Promise((resolve) => setImmediate(resolve));
     }
     ```
   - In `ThemeQaWorkflow.validate`, invoke `await yieldToEventLoop()` between stage 4 (Platform), stage 5 (Liquid), stage 6 (Overflow), stage 7 (Assets), and stage 9 (HS Rules).

### 3.5 Success Criteria & Validation Matrix
- [ ] Active Chromium renderer processes never exceed 4 under multi-tab load (verified via `app.getAppMetrics()` / `tasklist`).
- [ ] Disk cache and media cache limits respect 128 MB / 64 MB configurations.
- [ ] Background tabs drop timer and render activity when inactive.
- [ ] Terminal PTY input and IPC round-trips remain responsive (<25ms) during heavy full-theme QA scans.

### 3.6 Risk Assessment & Rollback
- **Risk:** `process-per-site` could cause tab crashes to affect sibling tabs sharing the same origin.
  - *Mitigation:* AntiFan’s `NativeTabHost` already features automated crashed-view recovery (`target.state.crashed` listener recreates `WebContentsView` seamlessly).

---

## 4. Phase 3: Async QA Generation Guard & Race-Condition Defense

### 4.1 Overview & Requirements
Theme QA analysis performs a multi-step pipeline (reload -> DOM snapshot -> screenshot -> Liquid scan -> layout overflow check -> broken asset correlation -> HS gate rules).
Because users frequently navigate between pages while an autonomous agent or background scanner is running, rapid tab navigations can cause race conditions where a background QA job from an older page navigation finishes late and inadvertently writes stale findings over the active tab's new page state.

#### Key Requirements:
1. **Document Generation Epoch Stamping:**
   - `NativeTabHost` maintains a monotonically increasing `documentGenerations: Map<string, number>` counter per tab.
   - The generation counter increments synchronously on `did-start-navigation` and `did-navigate` (main frame).
2. **Post-Await `signal.aborted` Checks:**
   - Every async `await` in `ThemeQaWorkflow` (`inspect`, `validate`, `ports.browser.eval`, `ports.browser.responsiveCheck`, `yieldToEventLoop`) MUST immediately check `if (input.signal?.aborted) throw new CapabilityError('TARGET_STALE', ...)`.
3. **Generation Guard in `AsyncThemeQaQueue`:**
   - The queue ties every job to `(tabId, generation)`.
   - On completion, `AsyncThemeQaQueue` verifies that `activeJob.generation === currentTabGeneration` before emitting events or caching results.
4. **Stale Target Error Handling:**
   - Catch `TARGET_STALE` errors cleanly in `AsyncThemeQaQueue` without propagating false-positive warnings to the UI or logs.

### 4.2 Async QA Lifecycle & Generation Guard Sequence

```text
User / Agent               NativeTabHost             AsyncThemeQaQueue          ThemeQaWorkflow
    │                            │                           │                         │
    ├── Navigate URL 1 ─────────►│                           │                         │
    │                            ├── inc gen (gen=1)         │                         │
    │                            ├── enqueue(tab, gen=1) ───►│                         │
    │                            │                           ├── start validate() ────►│
    │                            │                           │                         ├── inspect()
    ├── Navigate URL 2 ─────────►│                           │                         │   [await CDP]
    │   (Fast click)             ├── inc gen (gen=2)         │                         │
    │                            ├── enqueue(tab, gen=2) ───►│                         │
    │                            │                           ├── abort(gen=1) ────────►│ (signal.aborted)
    │                            │                           │   (signal fires)        │
    │                            │                           │                         ├── post-await check
    │                            │                           │                         └── throws TARGET_STALE
    │                            │                           │                                 │
    │                            │                           │◄── caught & swallowed ──────────┘
    │                            │                           │
    │                            │                           ├── start validate(gen=2)►│
    │                            │                           │                         └── complete clean!
```

### 4.3 Related Code Files
- **Create:**
  - `test/main/async-qa-generation-guard.test.ts`: Test suite verifying rapid navigation aborts, post-await rejections, and stale report suppression.
- **Modify:**
  - `src/main/qa/async-qa-job-queue.ts`: Add generation verification before result publication, add lifecycle state queries.
  - `src/main/qa/theme-qa-workflow.ts`: Insert post-await abort checks after every single asynchronous call in `validate` and `inspect`.
  - `src/main/browser/native-tab-host.ts`: Expose `getDocumentGeneration(tabId: string): number` and synchronize with QA trigger points.

### 4.4 Step-by-Step Implementation

1. **Harden `ThemeQaWorkflow` (`src/main/qa/theme-qa-workflow.ts`):**
   ```typescript
   private assertNotAborted(signal?: AbortSignal): void {
     if (signal?.aborted) {
       throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
     }
   }
   ```
   Insert `this.assertNotAborted(input.signal)`:
   - Immediately entering `validate()`
   - After `await this.ports.reload(input.target)`
   - After `await this.inspect(...)`
   - After `await this.ports.browser.eval(..., LiquidScanScript)`
   - After `await this.ports.browser.eval(..., OverflowScanScript)`
   - After `await this.ports.browser.responsiveCheck(...)`
   - After `await this.ports.browser.eval(..., BrokenAssetScanScript)`
   - After `await this.ports.browser.eval(..., HsGateScanScript)`
   - After every `await yieldToEventLoop()`
2. **Harden `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`):**
   ```typescript
   export class AsyncThemeQaQueue {
     private activeJobs = new Map<string, AsyncQaJob>();

     public enqueue(
       tabId: string,
       generation: number,
       task: (signal: AbortSignal) => Promise<void>,
       onComplete?: (generation: number) => void
     ): void {
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
         .then(() => {
           if (controller.signal.aborted) return;
           const current = this.activeJobs.get(tabId);
           if (current && current.generation === generation) {
             onComplete?.(generation);
           }
         })
         .catch((err) => {
           if (controller.signal.aborted || (err && typeof err === 'object' && (err as any).code === 'TARGET_STALE')) {
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
   }
   ```
3. **Synchronize in `NativeTabHost` (`src/main/browser/native-tab-host.ts`):**
   - When triggering background QA on navigation completion (`did-navigate` / `did-frame-finish-load`), retrieve generation via `this.documentGenerations.get(tabId) || 0`.
   - Pass generation to `AsyncThemeQaQueue.enqueue(tabId, generation, ...)`.
   - Ensure the completion callback verifies `this.documentGenerations.get(tabId) === generation` before emitting `antifan:qa:result` to Toolbar and Bridge.

### 4.5 Success Criteria & Validation Matrix
- [ ] Rapid navigations (5 navigations in 100ms) cancel previous in-flight scanner tasks immediately.
- [ ] No `TARGET_STALE` errors are logged to console as warnings.
- [ ] Out-of-order async resolution never overwrites the active document's QA report.
- [ ] 100% of unit tests in `test/main/async-qa-generation-guard.test.ts` pass cleanly.

### 4.6 Risk Assessment & Rollback
- **Risk:** AbortSignal listener memory leaks if not cleaned up.
  - *Mitigation:* Native `AbortController` handles GC automatically once tasks settle; the finally block guarantees map deletion.

---

## 5. Phase 4: Real Runtime Endurance Soak Test Suite & Final Verification

### 5.1 Overview & Requirements
The goal of Phase 4 is to replace synthetic mock benchmarks with a real, automated 4-stage runtime endurance soak testing engine that launches physical Electron instances, creates live Chromium tabs, pumps streaming data through `node-pty`, executes Theme QA scanners under load, and proves linear memory stability with zero process leaks.

#### Key Requirements:
1. **Automated 4-Stage Physical Soak Suite (`scripts/smoke-real-soak.cjs`):**
   - **Stage 1: Cold Start & Idle Baseline (60s):** Launch Electron, record initial baseline RSS, Heap, and child process trees (Main, GPU, Renderers, Utility).
   - **Stage 2: High-Volume PTY Terminal Streaming (120s):** Spawn real `node-pty` terminal instances, stream high-frequency data (>10 MB across 5,000 chunks), verify circular buffer recycling and zero memory leaks.
   - **Stage 3: Multi-Tab & Split-Review Thrash (120s):** Concurrently open, switch, toggle split-review mode (Desktop + Mobile views), and close tabs. Verify renderer process limit enforcement ($\le 4$) and WebContents garbage collection.
   - **Stage 4: Concurrent QA & Navigation Race Stress (120s):** Execute continuous Theme QA validations across active tabs while triggering rapid navigations. Verify that generation guards prevent stale overwrites and abort signals release resources.
2. **Mathematical Linear Memory Regression Slope ($\beta$):**
   - Collect telemetry samples $S_i = (t_i, \text{RSS}_i)$ at 5-second intervals.
   - Compute the linear regression slope:
     $$\beta = \frac{\sum_{i=1}^n (t_i - \bar{t})(\text{RSS}_i - \bar{\text{RSS}})}{\sum_{i=1}^n (t_i - \bar{t})^2} \quad (\text{MB / minute})$$
   - Acceptance gate: $\beta \le 0.5\text{ MB/min}$ over extended soak runs.
3. **Orphan Process Detection Gate:**
   - Track PID process tree (Parent Electron PID -> GPU PID, Renderer PIDs, PTY worker PIDs).
   - On shutdown, verify that all child processes terminate cleanly within 3,000ms.
   - Acceptance gate: `orphanProcessesCount === 0`.
4. **Enhanced Unit & E2E Integration (`test/e2e/soak-test.test.ts`):**
   - Maintain fast, deterministic mathematical regression tests for slope calculation.
   - Add automated subprocess integration tests exercising the real soak runner in automated test environments.

### 5.2 Soak Test Architecture & Telemetry Pipeline

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    scripts/smoke-real-soak.cjs                              │
│  1. Spawns Electron with --benchmark --production                          │
│  2. Connects to Control Plane / CDP / Bridge WebSocket                      │
│  3. Collects OS Process Telemetry (tasklist / ps) every 5s                  │
└───────────────────────┬─────────────────────────────────────────────────────┘
                        │
       ┌────────────────┼────────────────┬────────────────┐
       ▼                ▼                ▼                ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│   Stage 1    │ │   Stage 2    │ │   Stage 3    │ │   Stage 4    │
│ Idle Baseline│ │ PTY Stream   │ │ Tab Thrash   │ │ QA Race      │
│ (60s)        │ │ (120s)       │ │ (120s)       │ │ (120s)       │
└──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                │                │
       └────────────────┴────────────────┴────────────────┘
                                │
                                ▼
         ┌──────────────────────────────────────────────┐
         │ Telemetry Aggregator & Regression Calculator │
         │   • Samples: N ≥ 80                          │
         │   • Slope: β ≤ 0.5 MB/min                    │
         │   • Orphan PIDs: 0                           │
         │   • Output: soak-benchmark-<timestamp>.json  │
         └──────────────────────────────────────────────┘
```

### 5.3 Related Code Files
- **Create:**
  - `scripts/smoke-real-soak.cjs`: Standalone physical Electron soak runner and telemetry aggregator.
- **Modify:**
  - `test/e2e/soak-test.test.ts`: Integrate physical subprocess validation alongside mathematical regression tests.
  - `package.json`: Add `test:soak:real` and `test:soak:fast` npm scripts.

### 5.4 Step-by-Step Implementation

1. **Build `scripts/smoke-real-soak.cjs`:**
   - Launch Electron binary with `E:\Work\.antifan-data` storage environment.
   - Establish communication over local IPC / CDP / Bridge to execute stage workloads.
   - Sample memory every 5 seconds using `process.memoryUsage()` and Windows `tasklist /FO CSV /NH` (filtering by PID tree).
   - Execute Stage 1: Wait 60s idle, recording baseline.
   - Execute Stage 2: Trigger `antifan:terminal:write` high-volume stream via IPC, verify frame receipt.
   - Execute Stage 3: Send IPC commands to open 10 tabs, switch between them rapidly, toggle mobile split review, and close 8 tabs.
   - Execute Stage 4: Trigger 20 rapid navigations paired with immediate Theme QA validation calls; assert 0 unhandled rejections.
   - Initiate clean shutdown via `app.quit()`.
   - Poll process table to confirm all child PIDs have exited.
   - Compute $\beta$ memory slope, generate JSON report in `plans/260830-1903-drive-e-migration-and-low-spec-hardening/reports/smoke/soak-benchmark-<timestamp>.json`.
2. **Update `test/e2e/soak-test.test.ts`:**
   - Refactor mathematical slope regression unit tests for edge cases (zero variance, negative slope, steep slope).
   - Add integration test that runs `scripts/smoke-real-soak.cjs --fast` (shortened 20s run for CI/test suite).
3. **Add NPM Scripts to `package.json`:**
   - `"test:soak:fast"`: Runs fast e2e soak suite (~25s).
   - `"test:soak:real"`: Runs full 420s physical endurance soak test.

### 5.5 Success Criteria & Validation Matrix
- [ ] `scripts/smoke-real-soak.cjs` completes all 4 physical stages without unhandled errors or process crashes.
- [ ] Memory regression slope $\beta \le 0.5\text{ MB/min}$ across the entire duration.
- [ ] Peak memory on 4-core / UHD 630 workstation remains $<950\text{ MB}$ total across all Electron processes.
- [ ] Post-test orphan process count is exactly 0 (`orphanProcessesCount === 0`).
- [ ] Full test suite (`npm test`) passes with 0 regressions across all 81+ test suites.

### 5.6 Risk Assessment & Rollback
- **Risk:** Windows process termination latency causing false-positive orphan detection.
  - *Mitigation:* Soak runner polls process exit with exponential backoff up to 5,000ms before asserting failure.

---

## 6. Comprehensive Project-Wide Acceptance Gates

Before marking this implementation complete, all of the following acceptance gates must be rigorously satisfied and empirically verified:

| Gate ID | Category | Requirement / Acceptance Invariant | Verification Method |
|:---|:---|:---|:---|
| **GATE-01** | Storage Relocation | 100% of profile, cache, sessions, config, and artifacts reside in `E:\Work\.antifan-data\` | Inspect filesystem & verify 0 new bytes in `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop` |
| **GATE-02** | Safe Migration | Existing Drive C profiles migrate seamlessly with verified cookies & session state | Run migration test with mock Drive C profile -> verify `hasPersistentProfileState` on Drive E |
| **GATE-03** | Low-Spec Hardware | Chromium switches (`renderer-process-limit=4`, `process-per-site`, 128MB cache, etc.) active | Check `app.commandLine.hasSwitch` and `app.getAppMetrics()` during multi-tab load |
| **GATE-04** | Tab Throttling | Inactive tabs are throttled (`setBackgroundThrottling(true)`) | Verify background timer tick rates drop to 1/s in inactive tabs |
| **GATE-05** | Cooperative Yields | Theme QA scanners yield to event loop between scanning stages | Measure IPC & PTY latency during scanner execution ($\le 25\text{ms}$) |
| **GATE-06** | Race-Condition Guard | Stale async QA tasks abort on navigation and never overwrite fresh document state | Run `test/main/async-qa-generation-guard.test.ts` (100% pass) |
| **GATE-07** | Real Soak Endurance | Linear memory slope $\beta \le 0.5\text{ MB/min}$ and 0 orphan processes over physical soak run | Run `scripts/smoke-real-soak.cjs` -> verify benchmark JSON output |
| **GATE-08** | Full Test Parity | All unit, integration, and E2E test suites pass with 0 errors | Run `npm test` (All 437+ tests passing across all suites) |

---

## 7. Implementation Roadmap & File Change Manifest

### Phase Summary Table

```text
┌─────────┬────────────────────────────────────────────┬─────────────────────────────┐
│ Phase   │ Primary Scope                              │ Affected Files              │
├─────────┼────────────────────────────────────────────┼─────────────────────────────┤
│ Phase 1 │ Drive E Complete Storage Relocation        │ src/main/config/storage-    │
│         │ & Migration Engine                         │   paths.ts (New)            │
│         │                                            │ src/main/browser/profile-   │
│         │                                            │   ownership.ts              │
│         │                                            │ src/main/index.ts           │
│         │                                            │ src/main/agent/session-     │
│         │                                            │   resume-controller.ts      │
│         │                                            │ src/main/browser/history-   │
│         │                                            │   manager.ts                │
│         │                                            │ src/main/browser/terminal-  │
│         │                                            │   manager.ts                │
│         │                                            │ src/main/bridge/bridge-     │
│         │                                            │   server.ts                 │
│         │                                            │ src/main/tools/artifact-    │
│         │                                            │   store.ts                  │
│         │                                            │ test/main/storage-paths.    │
│         │                                            │   test.ts (New)             │
├─────────┼────────────────────────────────────────────┼─────────────────────────────┤
│ Phase 2 │ Low-Spec Hardware Optimization             │ src/main/index.ts           │
│         │ (Chromium Flags, Throttling & Yields)      │ src/main/browser/native-    │
│         │                                            │   tab-host.ts               │
│         │                                            │ src/main/security/security- │
│         │                                            │   policy.ts                 │
│         │                                            │ src/main/qa/scanners/       │
│         │                                            │   scanner-utils.ts (New)    │
│         │                                            │ src/main/qa/theme-qa-       │
│         │                                            │   workflow.ts               │
├─────────┼────────────────────────────────────────────┼─────────────────────────────┤
│ Phase 3 │ Async QA Generation Guard                  │ src/main/qa/async-qa-job-   │
│         │ & Race-Condition Defense                   │   queue.ts                  │
│         │                                            │ src/main/qa/theme-qa-       │
│         │                                            │   workflow.ts               │
│         │                                            │ src/main/browser/native-    │
│         │                                            │   tab-host.ts               │
│         │                                            │ test/main/async-qa-         │
│         │                                            │   generation-guard.test.ts  │
├─────────┼────────────────────────────────────────────┼─────────────────────────────┤
│ Phase 4 │ Real Runtime Endurance Soak Test           │ scripts/smoke-real-soak.cjs │
│         │ Suite & Final Verification                 │ test/e2e/soak-test.test.ts  │
│         │                                            │ package.json                │
└─────────┴────────────────────────────────────────────┴─────────────────────────────┘
```

This concludes the complete, rigorous, standalone implementation plan for AntiFan Browser Desktop: Drive E Migration, Low-Spec Hardware Optimization, Async QA Generation Guard, and Real Runtime Soak Testing.
