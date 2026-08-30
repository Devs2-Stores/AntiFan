# AntiFan Browser Desktop — Technical Implementation Plan
## Drive E Migration, Low-Spec Hardware Optimization, Async QA Generation Guard & Real Runtime Soak Endurance

**Target Version:** v1.4.0-hardened  
**Target Environment:** Intel Core i5-9300H (4 Cores / 8 Threads @ 2.40GHz), Intel UHD Graphics 630 (Shared System VRAM), Windows 11 x64  
**Primary Storage Target:** `E:\Work\.antifan-data` (Zero byte footprint on Drive C)  
**Baseline Test Status:** 437/437 tests passing across 81 suites; 0 TypeScript compilation errors  

---

## Executive Summary & Strategic Goals

The purpose of this engineering plan is to harden AntiFan Browser Desktop for resource-constrained developer workstations and high-intensity production usage. Specifically, this plan addresses four foundational system challenges:

1. **Drive C Storage Exhaustion & Zero Footprint Guarantee:** Automatically redirect 100% of Chromium user profiles, disk/GPU caches, session manifests, terminal logs, browser history, workspace capsules, window states, and control-plane artifacts to `E:\Work\.antifan-data\...`. Implement an atomic, one-time migration engine that safely transfers existing authenticated profiles from Drive C to Drive E without data loss or downtime.
2. **Low-Spec Hardware Hardening (i5-9300H / UHD 630):** Enforce strict Chromium process budgeting (`renderer-process-limit=4`, `process-per-site`), reduce disk/media cache ceilings (128MB disk, 64MB media), disable GPU video frame buffers, enable aggressive background tab throttling (`setBackgroundThrottling(true)` on inactive `WebContentsView` instances), and introduce cooperative event-loop yields across Theme QA scanners to prevent event-loop stalls and iGPU VRAM contention.
3. **Async QA Generation & Stale Result Defense:** Eliminate race conditions in asynchronous storefront auditing by enforcing post-`await` abort signal checks and document generation verifications across all scanner stages, guaranteeing that background scans for prior navigation epochs never overwrite or corrupt fresh page diagnostics.
4. **Real Runtime Endurance Soak Test Suite:** Replace synthetic `Buffer.alloc()` unit tests with a physical Electron/Chromium/PTY/QA endurance harness (`scripts/smoke-real-soak.cjs` and `test/e2e/soak-test.test.ts`) that executes a 4-stage soak sequence, measures linear memory regression slope ($\beta \le 1.0\text{ MB/min}$), and proves zero process or memory leaks under extended runtime.

---

## Phase 1: Drive E Complete Storage Relocation & Migration Engine

### 1.1 Overview
AntiFan Browser Desktop currently defaults several subsystems (Chromium profile in `profile-ownership.ts`, session manifests in `session-resume-controller.ts`, history in `history-manager.ts`, terminal state in `terminal-manager.ts`, and bridge configs in `bridge-server.ts`) to `AppData\Roaming\antifan-browser-desktop` or `~/.antifan` on Drive C. In low-capacity system drives (Drive C), this leads to rapid disk space exhaustion and potential OS failure. Phase 1 introduces a centralized storage location engine that automatically anchors all mutable state to `E:\Work\.antifan-data` while providing seamless one-time data migration from legacy locations.

### 1.2 Requirements & Invariants
- **INV-P1-01 (Zero Drive C Footprint):** Under normal execution on machines with `E:\Work` or Drive E present, zero bytes of profile, cache, session, history, or artifact data shall be written to Drive C (`AppData\Roaming\antifan-browser-desktop`, `~/.antifan`, or `~/.antifan-browser`).
- **INV-P1-02 (Centralized Path Resolution):** All main-process subsystems must query a single authoritative storage resolver (`StorageLocations`) rather than independently calling `os.homedir()` or `app.getPath('userData')`.
- **INV-P1-03 (Lossless Atomic Migration):** If a user launches the app and durable browser state (cookies, local storage, indexedDB, session tokens) exists only in legacy Drive C locations, the engine must atomically copy and verify that state in `E:\Work\.antifan-data` before launching Chromium, releasing or unlinking transient locks.
- **INV-P1-04 (Configurable Override):** Environment variables (`ANTIFAN_DATA_ROOT`, `ANTIFAN_USER_DATA`, `ANTIFAN_CONFIG_DIR`) must continue to work with highest precedence for isolated testing, benchmark harnesses, and custom developer configurations.

### 1.3 Architecture & Directory Layout
A new module `src/main/config/storage-locations.ts` will compute and expose all directory paths:

```text
E:\Work\.antifan-data/
├── Profile/                     # Chromium user data, cookies, local storage, extensions
│   ├── Default/
│   ├── Network/Cookies
│   └── antifan-profile.lock     # Process lease lock file
├── Profile-cache/               # Dedicated Chromium cache directory
│   ├── network/                 # disk-cache-dir
│   └── gpu/                     # gpu-cache-dir
├── config/                      # Application configuration & persistent state
│   ├── browser-history.json     # Navigation history (HistoryManager)
│   ├── terminal-sessions.json   # Terminal tabs & working dirs (TerminalManager)
│   ├── workspace-capsules.json  # Capsule definitions (WorkspaceCapsuleManager)
│   ├── window-state.json        # Main window bounds (WindowStateManager)
│   └── bridge-token.json        # Local bridge authentication token
├── sessions/                    # Agent & CLI session manifests (SessionResumeController)
│   └── session_<id>.json
├── control-plane-v2/            # Control plane database & records
│   ├── events.jsonl
│   ├── receipts.jsonl
│   └── artifacts/               # Staged QA reports, DOM dumps, screenshots
└── runtime/                     # Transient IPC descriptors & logs
    ├── bridge-auth.json
    └── logs/
```

#### Path Resolution Priority:
1. `process.env.ANTIFAN_DATA_ROOT` (explicit root override)
2. `E:\Work\.antifan-data` (if `E:\Work` or `E:\` drive exists and is writable)
3. Custom drive check (e.g. `D:\Work\.antifan-data` or other secondary drive if present)
4. Fallback: `path.join(app.getPath('appData'), 'antifan-browser-desktop')` (only if no secondary drive exists)

### 1.4 Related Code Files

| Action | File Path | Description |
| :--- | :--- | :--- |
| **CREATE** | `src/main/config/storage-locations.ts` | Centralized storage path resolver for profile, cache, config, sessions, artifacts, and runtime |
| **CREATE** | `test/main/storage-locations.test.ts` | Comprehensive unit tests for storage path resolution, environment variable precedence, and directory creation |
| **MODIFY** | `src/main/browser/profile-ownership.ts` | Integrate `StorageLocations`, expand candidate search to include legacy Drive C and secondary drive paths, ensure atomic migration to Drive E |
| **MODIFY** | `src/main/index.ts` | Set Electron `userData`, `sessionData`, `cache`, command line cache switches, control plane, and capsule manager paths using `StorageLocations` |
| **MODIFY** | `src/main/agent/session-resume-controller.ts` | Replace hardcoded `os.homedir()/.antifan/sessions` with `StorageLocations.getSessionsDir()` |
| **MODIFY** | `src/main/browser/history-manager.ts` | Replace hardcoded `os.homedir()/.antifan` with `StorageLocations.getConfigDir()` |
| **MODIFY** | `src/main/browser/terminal-manager.ts` | Replace hardcoded `os.homedir()/.antifan` with `StorageLocations.getConfigDir()` |
| **MODIFY** | `src/main/bridge/bridge-server.ts` | Update default bridge auth and config directory resolution |
| **MODIFY** | `src/main/browser/native-tab-host.ts` | Update fallback paths for window state and capsules |
| **MODIFY** | `test/main/profile-ownership.test.ts` | Add test coverage for Drive E auto-detection and migration |

### 1.5 Step-by-Step Implementation

1. **Implement `StorageLocations` (`src/main/config/storage-locations.ts`):**
   - Export `StorageLocations` class / singleton with getters for:
     * `getDataRoot()`: Resolves `ANTIFAN_DATA_ROOT` -> `E:\Work\.antifan-data` -> fallback.
     * `getProfileDir()`: Returns `path.join(dataRoot, 'Profile')`.
     * `getCacheDir()`: Returns `path.join(dataRoot, 'Profile-cache')`.
     * `getNetworkCacheDir()`: Returns `path.join(dataRoot, 'Profile-cache', 'network')`.
     * `getGpuCacheDir()`: Returns `path.join(dataRoot, 'Profile-cache', 'gpu')`.
     * `getConfigDir()`: Returns `path.join(dataRoot, 'config')`.
     * `getSessionsDir()`: Returns `path.join(dataRoot, 'sessions')`.
     * `getControlPlaneDir()`: Returns `path.join(dataRoot, 'control-plane-v2')`.
     * `getRuntimeDir()`: Returns `path.join(dataRoot, 'runtime')`.
   - Provide `ensureDirectories()` to initialize required directory structures safely with `fs.mkdirSync(dir, { recursive: true })`.

2. **Refactor `preparePersistentProfile` in `src/main/browser/profile-ownership.ts`:**
   - Default target canonical path to `StorageLocations.getProfileDir()`.
   - Expand legacy search paths to include `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop`, `C:\Users\Admin\AppData\Roaming\antifan-browser-desktop\Profile`, `C:\Users\Admin\.antifan`, and old `appdata/` relative paths.
   - If target profile on Drive E does not exist or lacks persistent state, scan candidate legacy locations, pick the highest-value profile via `compareProfileValue`, verify no live process holds the lease lock, and copy to Drive E staging temp folder before atomic rename.

3. **Update Electron Bootstrap in `src/main/index.ts`:**
   - Initialize `StorageLocations.ensureDirectories()`.
   - Pass `StorageLocations.getProfileDir()` to `preparePersistentProfile`.
   - Configure:
     ```ts
     app.setPath('userData', StorageLocations.getProfileDir());
     app.setPath('sessionData', StorageLocations.getProfileDir());
     app.setPath('cache', StorageLocations.getCacheDir());
     app.commandLine.appendSwitch('disk-cache-dir', StorageLocations.getNetworkCacheDir());
     app.commandLine.appendSwitch('gpu-cache-dir', StorageLocations.getGpuCacheDir());
     ```
   - Initialize `ControlPlaneRuntime` with `dataRoot: StorageLocations.getControlPlaneDir()`.
   - Initialize `WorkspaceCapsuleManager` with `filePath: path.join(StorageLocations.getConfigDir(), 'workspace-capsules.json')`.
   - Initialize `WindowStateManager` with `StorageLocations.getConfigDir()`.

4. **Update Downstream Subsystems:**
   - Update `SessionResumeController` constructor to use `StorageLocations.getSessionsDir()`.
   - Update `HistoryManager.getHistoryFilePath()` to use `StorageLocations.getConfigDir()`.
   - Update `TerminalManager.statePath()` to use `StorageLocations.getConfigDir()`.
   - Update `BridgeServer` token file generation to use `StorageLocations.getConfigDir()`.

### 1.6 Success Criteria & Acceptance Gates
- When running on Windows with `E:\Work` available, `app.getPath('userData')` evaluates to `E:\Work\.antifan-data\Profile`.
- Caches are located at `E:\Work\.antifan-data\Profile-cache` with zero new files written to `%APPDATA%`.
- Existing logins, cookies, and terminal histories on Drive C are seamlessly imported into Drive E on first launch.
- `npm test` passes 100% with all existing profile tests and new storage tests green.

### 1.7 Risk Assessment & Mitigations
- *Risk:* Drive E might be temporarily unmounted or read-only on some external configurations.  
  *Mitigation:* Implement a write-probe in `StorageLocations.getDataRoot()`. If `E:\Work` is not writable, gracefully fall back to `%APPDATA%` with a descriptive console warning.
- *Risk:* Concurrent instances attempting profile migration simultaneously.  
  *Mitigation:* Use atomic lockfile checking (`readProfileLease`) and temp directory copying with process-PID suffix before atomic directory rename.

---

## Phase 2: Low-Spec Hardware Optimization (Chromium Flags, Throttling & Cooperative Yields)

### 2.1 Overview
The target developer workstation (Intel Core i5-9300H with 4 physical cores and Intel UHD Graphics 630) suffers from CPU contention and shared VRAM memory pressure when Chromium spawns multiple independent renderer processes for tabs, split review views, and sidebars. Furthermore, large disk/media caches (512MB/256MB) and synchronous Theme QA regex scans cause event-loop stuttering. Phase 2 tunes Chromium flags, enforces background tab lifecycle throttling, and inserts cooperative microtask/macro-task yields in theme scanners.

### 2.2 Requirements & Invariants
- **INV-P2-01 (Process Ceiling):** Maximum concurrent Chromium renderer processes must be bounded to 4 (`renderer-process-limit=4`) and shared by site origin (`process-per-site`).
- **INV-P2-02 (Cache Ceiling):** Disk cache size must be restricted to 128MB (`134217728` bytes) and media cache to 64MB (`67108864` bytes).
- **INV-P2-03 (Shared VRAM Protection):** Disable GPU memory buffer video frames (`disable-gpu-memory-buffer-video-frames`) to prevent UHD 630 VRAM starvation.
- **INV-P2-04 (Background Tab Throttling):** Inactive `WebContentsView` instances must have `setBackgroundThrottling(true)` enforced. Only the currently active foreground tab view (and active split-mobile pane) shall have throttling disabled (`setBackgroundThrottling(false)`) to ensure 60fps rendering.
- **INV-P2-05 (Cooperative Scanner Yielding):** Long-running CPU-bound operations in `LiquidErrorScanner`, `LayoutOverflowEngine`, and `ThemeQaWorkflow` must yield to the event loop via `await new Promise((r) => setImmediate(r))` or `setTimeout(r, 0)` between scan stages and element batches, guaranteeing event-loop delay remains $< 50\text{ms}$.

### 2.3 Architectural Design

```text
+------------------------------------------------------------------------+
|                          Electron Main Process                         |
|  - renderer-process-limit=4      - process-per-site                    |
|  - disk-cache-size=128MB         - media-cache-size=64MB               |
|  - disable-gpu-memory-buffer-video-frames                              |
+------------------------------------------------------------------------+
                                    |
      +-----------------------------+-----------------------------+
      |                                                           |
+-----v---------------------------+         +---------------------v------+
| Foreground Active Tab           |         | Background Inactive Tabs   |
| - WebContentsView               |         | - WebContentsView (Tab 2)  |
| - setBackgroundThrottling(false)|         | - WebContentsView (Tab 3)  |
| -> Full 60fps interaction       |         | - setBackgroundThrottling  |
+---------------------------------+         |   (true)                   |
                                            | -> 1 tick/sec timer clamp  |
                                            | -> Throttled animations    |
                                            +----------------------------+
```

### 2.4 Related Code Files

| Action | File Path | Description |
| :--- | :--- | :--- |
| **MODIFY** | `src/main/index.ts` | Add Chromium low-spec optimization flags (`renderer-process-limit=4`, `process-per-site`, `disk-cache-size=134217728`, `media-cache-size=67108864`, `disable-gpu-memory-buffer-video-frames`) |
| **MODIFY** | `src/main/browser/native-tab-host.ts` | Implement dynamic background throttling management across `createTab`, `switchTab`, `closeTab`, and `toggleSplitReview` |
| **MODIFY** | `src/main/qa/theme-qa-workflow.ts` | Insert cooperative event loop yields between scan stages |
| **MODIFY** | `src/main/qa/scanners/liquid-error-scanner.ts` | Add chunked execution / event loop yielding for large HTML payloads |
| **MODIFY** | `src/main/qa/scanners/layout-overflow-engine.ts` | Add cooperative yielding for multi-breakpoint sweeps |
| **MODIFY** | `src/main/qa/scanners/broken-asset-scanner.ts` | Add yielding during asset correlation loops |
| **CREATE** | `test/main/low-spec-optimization.test.ts` | Unit and benchmark tests verifying flags, background throttling state transitions, and scanner yield intervals |

### 2.5 Step-by-Step Implementation

1. **Configure Low-Spec Chromium Switches in `src/main/index.ts`:**
   - Replace default 512MB/256MB cache switches with:
     ```ts
     app.commandLine.appendSwitch('renderer-process-limit', '4');
     app.commandLine.appendSwitch('process-per-site');
     app.commandLine.appendSwitch('disk-cache-size', '134217728'); // 128MB
     app.commandLine.appendSwitch('media-cache-size', '67108864');  // 64MB
     app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames');
     ```

2. **Implement Dynamic Tab Throttling in `NativeTabHost` (`src/main/browser/native-tab-host.ts`):**
   - In `createTab(url, activate)`:
     * When tab is created, set `view.webContents.setBackgroundThrottling(!activate)`.
   - In `switchTab(tabId)`:
     * For the newly active tab:
       - `target.view.webContents.setBackgroundThrottling(false);`
       - If `target.mobileView`, `target.mobileView.webContents.setBackgroundThrottling(false);`
     * For all inactive tabs in `this.tabs`:
       - `otherTab.view.webContents.setBackgroundThrottling(true);`
       - If `otherTab.mobileView`, `otherTab.mobileView.webContents.setBackgroundThrottling(true);`
   - In `toggleSplitReview(tabId, enabled)`:
     * Ensure `mobileView` matches active/inactive throttling state.

3. **Insert Cooperative Yields in Theme QA Scanners:**
   - In `ThemeQaWorkflow.validate` (`src/main/qa/theme-qa-workflow.ts`):
     * Define yield helper: `const yieldEventLoop = () => new Promise<void>((r) => setImmediate(r));`
     * Insert `await yieldEventLoop();` between Stage 4 (Platform Detection), Stage 5 (Liquid Scanning), Stage 6 (Layout Overflow), Stage 7 (Broken Assets), Stage 8 (Diagnostics Classification), Stage 9 (HS Gate Rules), and Stage 10 (Artifact Staging).
   - In `LiquidErrorScanner.scanHtmlString` (`src/main/qa/scanners/liquid-error-scanner.ts`):
     * If HTML string length $> 500\text{KB}$, process regex checks in batched iterations with cooperative yields if executed in async context.
   - In `LayoutOverflowEngine` and `BrokenAssetScanner`:
     * Ensure element correlation loops yield every 100 items when running large DOM audits.

### 2.6 Success Criteria & Acceptance Gates
- Chromium spawn limit is confirmed via `app.getAppMetrics()` to never exceed 4 renderer processes even when 10 tabs are opened.
- Disk cache is strictly bounded to 128MB.
- Background tabs consume $< 1\%$ CPU while idle.
- Main process event loop delay monitor (`startEventLoopDelayMonitor`) reports 0 stalls exceeding $50\text{ms}$ during full Theme QA scans on large storefronts.

### 2.7 Risk Assessment & Mitigations
- *Risk:* `process-per-site` could cause one unresponsive storefront tab to affect other tabs sharing the same domain.  
  *Mitigation:* AntiFan already implements individual WebContents crash handling and reload recovery (`render-process-gone` handler in `index.ts` and `NativeTabHost.switchTab` auto-recreation).
- *Risk:* Background throttling might delay background audio or downloads if initiated by user.  
  *Mitigation:* AntiFan's primary workflow is theme inspection, code editing, and MCP automation. Critical background operations (like Bridge WebSocket and MCP RPC) run on the Node main process, which is never throttled.

---

## Phase 3: Async QA Generation Guard & Race-Condition Defense

### 3.1 Overview
In fast interactive sessions, a user or automated agent may rapidly navigate a tab through multiple URLs (e.g. Home -> Collection -> Product). `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`) enqueues background validation tasks and triggers `controller.abort()` on prior jobs. However, if `ThemeQaWorkflow.validate()` does not check `signal.aborted` after every asynchronous `await` boundary (CDP calls, DOM script evals, responsive sweep checks, artifact staging), the stale job will continue executing in the background and may publish findings belonging to an obsolete document generation, overwriting the active page's status in the UI. Phase 3 implements an impenetrable dual-layer generation guard.

### 3.2 Requirements & Invariants
- **INV-P3-01 (Post-Await Abort Checks):** Every `await` statement inside `ThemeQaWorkflow.validate()` must be immediately followed by a check on `input.signal?.aborted`. If aborted, execution must terminate immediately with a `CapabilityError('TARGET_STALE', ...)` without performing further computation or disk I/O.
- **INV-P3-02 (Document Generation Lock):** Before generating and staging the final `ThemeQaReport` artifact, `ThemeQaWorkflow` must verify that `activeTarget.documentGeneration === this.ports.browser.getDocumentGeneration(activeTarget.tabId)`. If generation has incremented, discard immediately with `TARGET_STALE`.
- **INV-P3-03 (Atomic Queue Settlement):** `AsyncThemeQaQueue` must reject and silence any results or errors from superseded generations, ensuring that no stale IPC messages reach the renderer toolbar or control plane.

### 3.3 Architectural Design

```text
Navigation Event (Tab 1 -> URL A, Gen 1)
      │
      ├──> AsyncThemeQaQueue.enqueue(tabId="tab-1", gen=1)
      │      └──> ThemeQaWorkflow.validate(target={tabId: "tab-1", docGen: 1}, signal_1)
      │             ├──> await reload() ──> Check signal_1.aborted (OK)
      │             ├──> await inspect() ──> [User navigates to URL B, Gen 2]
      │             │                          │
      │             │                          └──> AsyncThemeQaQueue.abort("tab-1")
      │             │                                 └──> signal_1.abort()
      │             │
      │             └──> [inspect() resolves]
      │                    └──> if (signal_1.aborted) throw TARGET_STALE! (Terminated)
      │                         └──> NO regex scans, NO artifact writes, NO toolbar updates.
      │
      └──> AsyncThemeQaQueue.enqueue(tabId="tab-1", gen=2)
             └──> ThemeQaWorkflow.validate(target={tabId: "tab-1", docGen: 2}, signal_2)
                    └──> Completes cleanly and publishes fresh Gen 2 report.
```

### 3.4 Related Code Files

| Action | File Path | Description |
| :--- | :--- | :--- |
| **MODIFY** | `src/main/qa/theme-qa-workflow.ts` | Add post-await abort checks after every scanner stage and enforce `getDocumentGeneration` lock before report staging |
| **MODIFY** | `src/main/qa/async-qa-job-queue.ts` | Harden generation tracking, clean abort settlement, and error suppression for stale jobs |
| **MODIFY** | `src/main/tools/browser-control-port.ts` | Ensure `getDocumentGeneration(tabId)` is cleanly callable from `BrowserControlPort` |
| **CREATE** | `test/main/async-qa-generation-guard.test.ts` | Comprehensive unit and race-condition tests simulating rapid navigation bursts during in-flight QA scans |

### 3.5 Step-by-Step Implementation

1. **Expose Document Generation on `BrowserControlPort` (`src/main/tools/browser-control-port.ts`):**
   - Add `getDocumentGeneration(tabId?: string): number` to `BrowserControlPort` delegate interface if not already exposed.

2. **Harden `ThemeQaWorkflow.validate` (`src/main/qa/theme-qa-workflow.ts`):**
   - Helper function:
     ```ts
     const checkAborted = () => {
       if (input.signal?.aborted) {
         throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
       }
       const currentGen = this.ports.browser.getDocumentGeneration?.(activeTarget.tabId);
       if (typeof currentGen === 'number' && activeTarget.documentGeneration && currentGen !== activeTarget.documentGeneration) {
         throw new CapabilityError('TARGET_STALE', `Document generation advanced from ${activeTarget.documentGeneration} to ${currentGen}`);
       }
     };
     ```
   - Call `checkAborted()`:
     * After `this.ports.reload(input.target)`
     * After `this.inspect(...)`
     * After `this.ports.browser.eval(activeTarget, LiquidErrorScanner.getBrowserScanScript())`
     * After `this.ports.browser.eval(activeTarget, LayoutOverflowEngine.getBrowserScanScript('active'))`
     * After `this.ports.browser.responsiveCheck(activeTarget.tabId)`
     * After `this.ports.browser.eval(activeTarget, BrokenAssetScanner.getBrowserScanScript())`
     * After `this.ports.browser.eval(activeTarget, HsGateRules.getBrowserEvaluationScript(...))`
     * Immediately before `this.ports.artifacts.stage(...)`

3. **Harden `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`):**
   - When enqueuing a new job for `tabId`:
     ```ts
     public enqueue(tabId: string, generation: number, task: (signal: AbortSignal) => Promise<void>): void {
       this.abort(tabId);
       const controller = new AbortController();
       const job: AsyncQaJob = { tabId, generation, controller, startedAt: Date.now() };
       this.activeJobs.set(tabId, job);

       task(controller.signal)
         .catch((err) => {
           if (controller.signal.aborted || (err instanceof CapabilityError && err.code === 'TARGET_STALE') || (err && (err as any).code === 'TARGET_STALE')) {
             return; // Silently drop stale aborts
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
     ```

### 3.6 Success Criteria & Acceptance Gates
- Rapidly triggering 10 consecutive navigations on a single tab results in exactly 9 clean, silent aborts and 1 successful validation for the final URL.
- Zero stale report artifacts are staged in `ArtifactStore`.
- Toolbar UI never flickers with errors or warnings belonging to a previously navigated page.
- 100% of race condition test cases pass in `test/main/async-qa-generation-guard.test.ts`.

### 3.7 Risk Assessment & Mitigations
- *Risk:* An unexpected error thrown during abort handling could crash the queue or unhandledRejection handler.  
  *Mitigation:* Catch blocks in both `AsyncThemeQaQueue` and `ThemeQaWorkflow` explicitly inspect error types and ignore `TARGET_STALE` errors thrown from aborted signals.

---

## Phase 4: Real Runtime Endurance Soak Test Suite & Final Verification

### 4.1 Overview
The existing `test/e2e/soak-test.test.ts` was a synthetic mock that simulated memory slope using in-memory arrays and dummy `setTimeout` loops without spawning real Electron processes or exercising physical Chromium, PTY streams, or live DOM scanners. Phase 4 creates an industrial-grade automated soak test suite (`scripts/smoke-real-soak.cjs` and `test/e2e/soak-test.test.ts`) that launches the real compiled Electron binary, drives physical tabs and PTY streams over 4 distinct workload stages, computes linear memory regression ($\beta$), and validates that zero process or memory leaks occur.

### 4.2 Requirements & Invariants
- **INV-P4-01 (Real Process Execution):** The soak harness must execute the real Electron executable with Chromium WebContentsViews, real Node-PTY terminals, and live Theme QA scanners against a local HTTP fixture server.
- **INV-P4-02 (4-Stage Protocol):**
  * **Stage 1 (Idle Baseline):** Boot app, establish window and views, record stable baseline memory for 10 seconds.
  * **Stage 2 (PTY Streaming Stress):** Open terminal session, blast $\ge 500\text{KB}$ of high-frequency chunk data, verify zero buffer leaks and strict write sequence monotonically increasing.
  * **Stage 3 (Split Review & Tab Thrash):** Open 4 concurrent tabs, toggle desktop/mobile split review, switch active tabs 20 times, verify Chromium renderer process limit $\le 4$.
  * **Stage 4 (Concurrent QA Blast):** Trigger 15 rapid page reloads and concurrent QA validations, exercising Phase 3 generation guards and Phase 2 cooperative yields under load.
- **INV-P4-03 (Strict Memory Slope Threshold):** The linear regression memory slope across the entire run must satisfy:
  $$\beta = \frac{\sum_{i=1}^n (t_i - \bar{t})(M_i - \bar{M})}{\sum_{i=1}^n (t_i - \bar{t})^2} \le 1.0\text{ MB/min}$$
- **INV-P4-04 (Zero Orphan Processes):** On test completion and graceful shutdown, the number of orphaned Electron, Chromium, or ConPTY (`openconsole.exe` / `conhost.exe`) child processes must be exactly 0.

### 4.3 Related Code Files

| Action | File Path | Description |
| :--- | :--- | :--- |
| **CREATE** | `scripts/smoke-real-soak.cjs` | Real Electron endurance soak harness running 4 workload stages with telemetry sampling, linear slope calculation, and JSON reporting |
| **MODIFY** | `test/e2e/soak-test.test.ts` | Upgrade soak test suite to validate regression slope mathematics, endurance stages, and invoke the real soak runner |
| **MODIFY** | `package.json` | Add `test:soak` and `smoke:soak` scripts |

### 4.4 Step-by-Step Implementation

1. **Implement `scripts/smoke-real-soak.cjs`:**
   - Setup fixture HTTP server serving responsive mock storefront with Liquid snippets, styles, and oversized elements.
   - Launch Electron with isolated `ANTIFAN_DATA_ROOT` on Drive E (e.g. `E:\Work\.antifan-data-soak-test`).
   - Connect via Bridge WebSocket RPC / Control Plane.
   - Implement telemetry collector polling `process.memoryUsage().rss` and `app.getAppMetrics()` every 1 second.
   - **Execute Stage 1 (Baseline):** Sample for 10s.
   - **Execute Stage 2 (PTY Stress):** Create terminal session via `TerminalManager`, stream 50 chunks of 10KB (500KB total) through PTY, verify receipt and chunk sequence.
   - **Execute Stage 3 (Tab Thrash):** Create 4 tabs, toggle split mode, cycle active tab every 200ms for 20 cycles, verify `app.getAppMetrics()` reports $\le 4$ renderers.
   - **Execute Stage 4 (QA Blast):** Fire 15 rapid navigations and background QA validation jobs; confirm generation guards abort obsolete jobs without errors.
   - Calculate linear regression slope:
     ```js
     function calculateMemorySlope(samples) {
       const n = samples.length;
       if (n < 2) return 0;
       const t0 = samples[0].timestamp;
       const tMin = samples.map(s => (s.timestamp - t0) / 60000);
       const mMB = samples.map(s => s.rssBytes / (1024 * 1024));
       const avgT = tMin.reduce((a, b) => a + b, 0) / n;
       const avgM = mMB.reduce((a, b) => a + b, 0) / n;
       let num = 0, den = 0;
       for (let i = 0; i < n; i++) {
         num += (tMin[i] - avgT) * (mMB[i] - avgM);
         den += (tMin[i] - avgT) ** 2;
       }
       return den === 0 ? 0 : num / den;
     }
     ```
   - Check process tree for orphaned child PIDs before and after shutdown.
   - Emit report to `plans/260830-1903-drive-e-migration-and-low-spec-hardening/reports/smoke/real-soak-benchmark.json`.

2. **Upgrade `test/e2e/soak-test.test.ts`:**
   - Retain mathematical slope unit tests.
   - Add integration test that spawns `smoke-real-soak.cjs` in fast CI mode (e.g. `--quick`), verifies that slope $\beta \le 1.0\text{ MB/min}$, and asserts 0 orphan processes.

3. **Update `package.json` Scripts:**
   - Add `"smoke:soak": "node scripts/smoke-real-soak.cjs"`
   - Add `"test:soak": "node --test test/e2e/soak-test.test.ts"`

### 4.5 Success Criteria & Acceptance Gates
- `npm run smoke:soak` executes end-to-end without crashing or unhandled rejections.
- Measured memory slope $\beta \le 1.0\text{ MB/min}$ over the full endurance run.
- Zero orphaned Electron or ConPTY processes remain in Windows process table.
- Detailed benchmark JSON artifact is saved to reports directory.

### 4.6 Risk Assessment & Mitigations
- *Risk:* Chromium garbage collection timing might cause short-term RSS fluctuations.  
  *Mitigation:* The linear regression algorithm smooths out transient GC spikes by calculating the best-fit slope across the entire time series rather than measuring naive start-to-finish delta.

---

## Acceptance Criteria & Master Verification Gates

| Gate ID | Domain | Invariant / Acceptance Criterion | Verification Method |
| :--- | :--- | :--- | :--- |
| **GATE-01** | Drive E Relocation | 100% of user data, profiles, caches, sessions, and artifacts reside under `E:\Work\.antifan-data`. Zero bytes written to `%APPDATA%\antifan-browser-desktop` or `~/.antifan`. | Inspect filesystem paths during runtime; run `test/main/storage-locations.test.ts` |
| **GATE-02** | Profile Migration | Existing cookies and session state from legacy Drive C locations are safely migrated to Drive E on first run without data loss. | Run `test/main/profile-ownership.test.ts` with mock legacy profile |
| **GATE-03** | Low-Spec Flags | Chromium switches `renderer-process-limit=4`, `process-per-site`, 128MB disk cache, 64MB media cache, and disabled GPU memory buffer frames are active. | Verify `app.commandLine` and `app.getAppMetrics()` |
| **GATE-04** | Tab Throttling | Inactive background `WebContentsView` instances have `setBackgroundThrottling(true)` enabled; active foreground tab has throttling disabled. | Run `test/main/low-spec-optimization.test.ts` |
| **GATE-05** | Event-Loop Health | Cooperative yields between Theme QA scanner stages prevent main process event loop delays from exceeding $50\text{ms}$. | Run telemetry delay monitor during large storefront scan |
| **GATE-06** | Async QA Safety | Post-await abort checks and document generation locks prevent stale scan results from publishing after tab navigation. | Run `test/main/async-qa-generation-guard.test.ts` |
| **GATE-07** | Real Soak Test | Real Electron endurance test runs 4 stages with linear memory slope $\beta \le 1.0\text{ MB/min}$ and 0 orphan processes. | Run `npm run smoke:soak` and `npm run test:soak` |
| **GATE-08** | Full Suite Green | 0 TypeScript compilation errors; 100% of unit, integration, and E2E tests pass. | Run `npm run compile` and `npm test` |

---
*End of Candidate Implementation Plan.*
