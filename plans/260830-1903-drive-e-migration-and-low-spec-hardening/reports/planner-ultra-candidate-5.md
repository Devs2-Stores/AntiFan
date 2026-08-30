# AntiFan Browser Desktop — Drive E Complete Storage Relocation, Low-Spec Hardware Optimization, Async QA Generation Guard & Real Runtime Soak Test Plan

**Plan Identifier:** `plans/260830-1903-drive-e-migration-and-low-spec-hardening`  
**Author:** Candidate Planner 5 (Principal Systems & Reliability Engineer)  
**Target Application:** AntiFan Browser Desktop (Electron 43.4.0, TypeScript 5.5, Node-PTY 1.1.0, Chromium host)  
**Hardware Baseline:** Intel Core i5-9300H (4 Physical Cores / 8 Threads @ 2.40GHz), Intel UHD Graphics 630 (Shared System VRAM), Windows 11 x64, Drive C: (Constrained SSD), Drive E: (`E:\Work` Primary High-Capacity Work Volume).

---

## 1. Executive Summary & Core Objectives

### 1.1 Context & Problem Statement
AntiFan Browser Desktop is a specialized, high-performance Chromium host, Theme QA analyzer, and terminal workbench for theme developers and AI agents. In long-running development workflows on resource-constrained multi-drive Windows workstations:
1. **Drive C Storage Exhaustion:** Profile data, Chromium disk/GPU caches (defaulting to 512MB/256MB), session logs, terminal history, and artifacts default to `%APPDATA%\antifan-browser-desktop` and `~/.antifan` on Drive C:, exhausting limited primary partition capacity.
2. **Low-Spec Hardware Contention (i5-9300H / UHD 630):** Default Chromium process allocation spawns unrestricted Renderer processes per tab/split view, competing for 4 physical CPU cores and over-allocating shared iGPU memory buffers. Synchronous DOM and Liquid regex evaluation in QA scanners can monopolize the Node.js event loop.
3. **Async QA Generation Race Conditions:** When navigating between pages or switching storefront URLs, asynchronous QA scanning tasks across multiple await points can resolve against outdated DOM snapshots, overwriting fresh document diagnostics with stale findings.
4. **Synthetic vs. Real Endurance Verification:** Existing soak testing in `test/e2e/soak-test.test.ts` simulates memory slopes via mock buffer allocations without exercising real Electron runtime instances, Chromium WebContents, PTY streams, or concurrent QA queues.

### 1.2 Strategic Goals
- **Goal 1 (Zero Drive C Footprint):** Implement an intelligent Storage Relocation & Migration Engine that detects `E:\Work` (or Drive E:), re-routes 100% of Chromium profile, cache, session manifests, terminal history, and QA artifacts to `E:\Work\.antifan-data\...`, and performs atomic legacy profile migration without data loss.
- **Goal 2 (Low-Spec Hardware Hardening):** Tune Chromium runtime switches (`renderer-process-limit=4`, `process-per-site`, disk cache 128MB, media cache 64MB, `disable-gpu-memory-buffer-video-frames`), enforce background WebContentsView throttling, and insert cooperative event-loop yields into Theme QA scanning pipelines.
- **Goal 3 (Async QA Generation & Epoch Isolation):** Enforce strict document generation tracking and post-await `signal.aborted` verification across all Theme QA scanning stages to guarantee stale scan results never overwrite active page states.
- **Goal 4 (Real Runtime Endurance Soak Verification):** Build an automated physical Electron soak test suite (`scripts/smoke-real-soak.cjs` and enhanced `test/e2e/soak-test.test.ts`) that runs 50+ real tab transitions, split reviews, PTY streaming bursts, and QA analyses to prove memory stability ($\le 1.0\text{ MB/min}$ slope) and zero process leaks.

---

## 2. Architectural Blueprint & Target Data Hierarchy

### 2.1 Unified Storage Layout on Drive E (`E:\Work\.antifan-data`)
```text
E:\Work\.antifan-data\
├── profile\                     # Chromium UserData / SessionData (Cookies, Local Storage, IndexedDB)
│   ├── Default\
│   │   ├── Network\Cookies
│   │   ├── Local Storage\leveldb\
│   │   └── IndexedDB\
│   └── antifan-profile.lock    # Process Lease & Recovery State
├── cache\                       # Chromium Disk & GPU Caches (Redirected off Drive C)
│   ├── network\                 # Network Disk Cache (Capped at 128MB)
│   └── gpu\                     # GPU Shader/Pipeline Cache
├── config\                      # App Configuration & State
│   ├── browser-history.json     # Navigation History
│   ├── terminal-sessions.json   # Persistent Terminal Workbench State
│   ├── workspace-capsules.json  # Capsule & Tab Layout Manifests
│   ├── saved-tabs.json          # Crash-Resilient Saved Tabs
│   └── bridge.json              # Native Extension Bridge Metadata
├── sessions\                    # Agent & Session Resume Manifests
├── artifacts\                   # Theme QA DOM snapshots, screenshots, and diffs
└── logs\                        # Process & Crash Diagnostic Logs
```

### 2.2 System Component Interaction Architecture
```
+-----------------------------------------------------------------------------------------+
|                                  Electron Main Process                                  |
|                                                                                         |
|  +-----------------------------------------------------------------------------------+  |
|  | Storage Location Engine (storage-locations.ts & profile-ownership.ts)             |  |
|  | - Evaluates ANTIFAN_DATA_ROOT -> E:\Work\.antifan-data -> Drive C Fallback        |  |
|  | - Sets app userData, cache, ANTIFAN_CONFIG_DIR to E:\Work\.antifan-data\...        |  |
|  +-----------------------------------------------------------------------------------+  |
|                                            |                                            |
|  +-----------------------------------------+-----------------------------------------+  |
|  |                                         |                                         |  |
|  v                                         v                                         v  |
|  +---------------------+   +-------------------------------+   +---------------------+  |
|  | Chromium Flags      |   | NativeTabHost & WebContents   |   | AsyncThemeQaQueue   |  |
|  | - limit=4 renderers |   | - backgroundThrottling: true  |   | - Tab generation ID |  |
|  | - process-per-site  |   | - Active tab prioritization   |   | - Abort on nav      |  |
|  | - 128MB/64MB caches |   | - Split pane memory control   |   | - Post-await checks |  |
|  +---------------------+   +-------------------------------+   +---------------------+  |
|                                                                            |            |
|                                                                            v            |
|                                                            +-------------------------+  |
|                                                            | Theme QA Pipeline       |  |
|                                                            | - Cooperative yields    |  |
|                                                            | - Platform -> Liquid    |  |
|                                                            | - Overflow -> Assets    |  |
|                                                            +-------------------------+  |
+-----------------------------------------------------------------------------------------+
```

---

## 3. Detailed Implementation Phases

### Phase 1: Drive E Complete Storage Relocation & Migration Engine

#### 1. Phase Overview
Design and implement a centralized storage location engine that automatically detects `E:\Work` (or Drive E: on Windows) and relocates all browser profiles, caches, config manifests, terminal states, and QA artifacts to `E:\Work\.antifan-data`. Implement safe, atomic profile migration from Drive C to Drive E with lease validation and disk space reclamation.

#### 2. Key Requirements
- **FR-1.1:** Auto-detect `E:\Work` or Drive E: root on Windows systems; allow explicit override via `ANTIFAN_DATA_ROOT`. Fallback to standard `%APPDATA%` only when Drive E is not present.
- **FR-1.2:** Configure `app.setPath('userData', ...)`, `app.setPath('sessionData', ...)`, `app.setPath('cache', ...)`, and Chromium switches `disk-cache-dir` / `gpu-cache-dir` to point strictly to `E:\Work\.antifan-data\...`.
- **FR-1.3:** Redirect `session-resume-controller.ts`, `bridge-server.ts`, `history-manager.ts`, `terminal-manager.ts`, `workspace-capsule.ts`, and `workspace-file-port.ts` to consume the unified config and storage roots.
- **FR-1.4:** In `preparePersistentProfile`, detect existing legacy profiles on Drive C (`%APPDATA%\antifan-browser-desktop\Profile` and legacy dev/prod paths) and perform safe, non-destructive migration across volumes using destination staging directories (`E:\Work\.antifan-data\.migration-temp-*`) with lease verification (`ProfileOwnership`).
- **FR-1.5:** Post-migration verification: confirm file integrity (Cookies, Local Storage leveldb, IndexedDB) on Drive E before releasing legacy locks.

#### 3. Architecture & Data Flow
- `src/main/storage/storage-locations.ts`: New single source of truth for all storage paths.
- Resolves base root via:
  ```typescript
  export function resolveStorageRoot(customRoot?: string): string {
    if (customRoot) return path.resolve(customRoot);
    if (process.env.ANTIFAN_DATA_ROOT) return path.resolve(process.env.ANTIFAN_DATA_ROOT);
    if (process.platform === 'win32') {
      const eWorkPath = path.resolve('E:\\Work\\.antifan-data');
      if (fs.existsSync('E:\\Work')) return eWorkPath;
      if (fs.existsSync('E:\\')) return path.resolve('E:\\.antifan-data');
    }
    return path.join(app ? app.getPath('appData') : (process.env.APPDATA || os.homedir()), 'antifan-browser-desktop');
  }
  ```
- Subpaths mapped via `getStoragePaths(baseRoot)`:
  - `profilePath`: `${baseRoot}/profile`
  - `cachePath`: `${baseRoot}/cache`
  - `configPath`: `${baseRoot}/config`
  - `sessionsPath`: `${baseRoot}/sessions`
  - `artifactsPath`: `${baseRoot}/artifacts`
  - `logsPath`: `${baseRoot}/logs`

#### 4. Related Code Files
- **Create:**
  - `src/main/storage/storage-locations.ts` — Central path resolver and directory initializer.
  - `test/main/storage-locations.test.ts` — Unit tests for path resolution, platform detection, and fallback behaviors.
- **Modify:**
  - `src/main/browser/profile-ownership.ts` — Update `preparePersistentProfile` to migrate from legacy Drive C candidate paths to the new canonical Drive E profile path using cross-volume safe copy.
  - `src/main/index.ts` — Wire storage location resolver into startup before `app.whenReady()`, setting Electron paths and environment variables (`ANTIFAN_CONFIG_DIR`, `ANTIFAN_DATA_ROOT`).
  - `src/main/agent/session-resume-controller.ts` — Consume `getStoragePaths().sessionsPath`.
  - `src/main/bridge/bridge-server.ts` — Consume `getStoragePaths().configPath` for bridge manifests.
  - `src/main/browser/history-manager.ts` — Consume `getStoragePaths().configPath` for `browser-history.json`.
  - `src/main/browser/terminal-manager.ts` — Consume `getStoragePaths().configPath` for `terminal-sessions.json`.
  - `src/main/browser/native-tab-host.ts` — Consume `getStoragePaths().configPath` for `saved-tabs.json` and capsule manifests.
  - `src/main/tools/workspace-file-port.ts` — Consume `getStoragePaths().artifactsPath`.
- **Delete:** None.

#### 5. Step-by-Step Implementation Steps
1. **Implement `src/main/storage/storage-locations.ts`:**
   - Define interface `AntiFanStorageLayout` with typed paths (`root`, `profile`, `cache`, `config`, `sessions`, `artifacts`, `logs`).
   - Implement `resolveStorageRoot` with deterministic precedence (`customRoot` -> `ANTIFAN_DATA_ROOT` -> `E:\Work\.antifan-data` -> `E:\.antifan-data` -> `%APPDATA%`).
   - Implement `ensureStorageDirectories(layout)` to create all required directories with recursive safety.
2. **Refactor `src/main/browser/profile-ownership.ts`:**
   - Integrate `resolveStorageRoot` into `PersistentProfileOptions`.
   - Update canonical destination path to target `layout.profile`.
   - Implement volume-aware cross-device migration: use `fs.cpSync` into a staging folder located on the *destination drive* (`path.join(layout.root, '.profile-migration-staging-...')`), followed by atomic rename to `layout.profile`.
   - Add verification check confirming `hasPersistentProfileState(layout.profile)` before completing migration.
3. **Update `src/main/index.ts` Bootstrap Sequence:**
   - Call `resolveStorageRoot()` and initialize directories prior to Electron path overrides.
   - Set `process.env.ANTIFAN_CONFIG_DIR = layout.config`.
   - Call `app.setPath('userData', layout.profile)`, `app.setPath('sessionData', layout.profile)`, `app.setPath('cache', layout.cache)`.
   - Update Chromium switch bindings for `disk-cache-dir` (`layout.cache/network`) and `gpu-cache-dir` (`layout.cache/gpu`).
4. **Update Subsystem Callers:**
   - Refactor `SessionResumeController`, `BridgeServer`, `HistoryManager`, `TerminalManager`, and `WorkspaceCapsuleManager` to source paths from `storage-locations.ts` when no custom directory is passed.
5. **Unit & Regression Testing:**
   - Write comprehensive tests in `test/main/storage-locations.test.ts` verifying path resolution with mocked environment variables and drive roots.
   - Run existing `test/main/profile-ownership.test.ts` to ensure backward-compatible profile lease acquisition and migration safety.

#### 6. Success Criteria
- 100% of new profile state, caches, manifests, and artifacts are created under `E:\Work\.antifan-data\` when running on the target machine.
- Drive C writes during normal browsing, terminal sessions, and Theme QA runs drop to 0 bytes.
- Legacy profiles on Drive C are cleanly discovered and migrated to Drive E without corrupting cookies, local storage, or session states.
- All unit tests in `test/main/profile-ownership.test.ts` and `test/main/storage-locations.test.ts` pass cleanly.

#### 7. Risk Assessment & Mitigations
- *Risk 1 (Cross-Device Rename Error `EXDEV`):* Renaming across different drive letters (C: to E:) fails with `EXDEV: cross-device link not permitted`.
  - *Mitigation:* Ensure staging temporary directories are allocated on the destination volume (`E:\Work\.antifan-data\.staging-...`) so the final `fs.renameSync` is always intra-volume.
- *Risk 2 (Drive E Disconnection/Unavailability):* If Drive E is an external/removable volume that is unmounted, app could crash on startup.
  - *Mitigation:* `resolveStorageRoot` verifies directory/drive existence (`fs.existsSync`) and gracefully falls back to `%APPDATA%` if Drive E is inaccessible.

---

### Phase 2: Low-Spec Hardware Optimization (Chromium Flags, Throttling & Cooperative Yields)

#### 2.1 Phase Overview
Optimize CPU and GPU utilization for the Intel Core i5-9300H (4 cores / 8 threads) and Intel UHD Graphics 630 (shared VRAM). Cap Chromium renderer processes, reduce disk and media cache sizes, enable aggressive background tab throttling on WebContentsViews, and introduce cooperative event-loop yields into synchronous regex and DOM scanners.

#### 2.2 Key Requirements
- **FR-2.1:** Configure Chromium startup flags in `src/main/index.ts`:
  - `renderer-process-limit=4` (align with 4 physical CPU cores, preventing context switching thrash).
  - `process-per-site` (consolidate renderers for identical origins in split views and multi-tab workflows).
  - `disk-cache-size=134217728` (128 MB, reduced from 512 MB).
  - `media-cache-size=67108864` (64 MB, reduced from 256 MB).
  - `disable-gpu-memory-buffer-video-frames` (prevent shared VRAM memory buffer exhaust on Intel UHD 630).
- **FR-2.2:** Enforce background throttling on all inactive `WebContentsView` instances in `NativeTabHost`:
  - Ensure `backgroundThrottling: true` is configured in `getSecureWebPreferences()`.
  - In `NativeTabHost.attachTabView()` and tab switching routines, explicitly invoke `view.webContents.setBackgroundThrottling(true)` on background tabs and mobile paired views when hidden.
- **FR-2.3:** Introduce cooperative event loop yielding in `ThemeQaWorkflow` and scanners:
  - Add helper `yieldEventLoop()` (`await new Promise((resolve) => setImmediate(resolve))`).
  - Yield between heavy scan stages: Platform Detection $\rightarrow$ Liquid Error Scanning $\rightarrow$ Layout Overflow Engine $\rightarrow$ Broken Asset Telemetry $\rightarrow$ Diagnostics Classification.

#### 2.3 Architecture & Data Flow
```text
[Tab Activation / Navigation]
            |
            v
[NativeTabHost.switchTab(tabId)]
   ├── Active View   --> setBackgroundThrottling(false) (Focus & Render Priority)
   └── Inactive Views --> setBackgroundThrottling(true)  (Throttle timers to 1Hz, suspend RAF)

[ThemeQaWorkflow.validate()]
   ├── Step 1: Reload Page            --> await reload()
   ├── Step 2: Yield Event Loop       --> await yieldEventLoop()
   ├── Step 3: Platform Detection     --> PlatformDetector.detect()
   ├── Step 4: Yield Event Loop       --> await yieldEventLoop()
   ├── Step 5: Liquid Error Scanning  --> await browser.eval(LiquidScript)
   ├── Step 6: Yield Event Loop       --> await yieldEventLoop()
   ├── Step 7: Layout Overflow Engine --> await browser.eval(OverflowScript)
   ├── Step 8: Yield Event Loop       --> await yieldEventLoop()
   └── Step 9: Asset Correlation      --> BrokenAssetScanner.correlate()
```

#### 2.4 Related Code Files
- **Create:**
  - `src/main/utils/event-loop.ts` — Cooperative scheduling and microtask/macrotask yield utilities.
  - `test/main/event-loop.test.ts` — Unit test for cooperative yield delay and unblocking.
- **Modify:**
  - `src/main/index.ts` — Add low-spec Chromium command line switches (`renderer-process-limit`, `process-per-site`, `disable-gpu-memory-buffer-video-frames`, cache size reductions).
  - `src/main/browser/native-tab-host.ts` — Add explicit `setBackgroundThrottling` toggling on active/inactive tab views and split panes.
  - `src/main/security/security-policy.ts` — Ensure `backgroundThrottling: true` is default in `getSecureWebPreferences()`.
  - `src/main/qa/theme-qa-workflow.ts` — Insert `yieldEventLoop()` calls between major validation steps.
- **Delete:** None.

#### 2.5 Step-by-Step Implementation Steps
1. **Update Chromium Switches in `src/main/index.ts`:**
   - Update `app.commandLine.appendSwitch('disk-cache-size', '134217728')`.
   - Update `app.commandLine.appendSwitch('media-cache-size', '67108864')`.
   - Add `app.commandLine.appendSwitch('renderer-process-limit', '4')`.
   - Add `app.commandLine.appendSwitch('process-per-site')`.
   - Add `app.commandLine.appendSwitch('disable-gpu-memory-buffer-video-frames')`.
2. **Implement `src/main/utils/event-loop.ts`:**
   - Export `yieldEventLoop(): Promise<void>` utilizing `setImmediate` (or `setTimeout(r, 0)` fallback).
   - Add optional time-budgeted chunking utility `yieldIfLongTask(startTime: number, maxBudgetMs = 16)`.
3. **Hardening `NativeTabHost` Background Throttling:**
   - In `switchTab(tabId: string)`: Iterate all tabs in `this.tabs`; for the active tab, ensure `view.webContents.setBackgroundThrottling(false)`; for all other tabs (and hidden `mobileView` instances), call `view.webContents.setBackgroundThrottling(true)`.
   - In `closeTab()` and `destroy()`: Ensure throttled/detached views release event listeners.
4. **Integrate Cooperative Yields in `ThemeQaWorkflow.validate()`:**
   - Import `yieldEventLoop` in `src/main/qa/theme-qa-workflow.ts`.
   - Insert `await yieldEventLoop()` after `reload`, after `inspect`, after `PlatformDetector`, after `LiquidErrorScanner`, and after `LayoutOverflowEngine`.
5. **Validation & Benchmarking:**
   - Run `npm test` and targeted benchmark tests to verify event-loop latency stays below 15ms during heavy QA scans.

#### 2.6 Success Criteria
- Maximum active Chromium renderer processes bounded to $\le 4$ during multi-tab workflows.
- Idle CPU usage on i5-9300H drops to $< 2\%$ with 5 background tabs open.
- Main process event loop lag (`telemetry.ts` event loop delay monitor) remains $< 25\text{ms}$ during full 5-stage Theme QA scans.
- GPU VRAM consumption on Intel UHD 630 stays below 200MB.

#### 2.7 Risk Assessment & Mitigations
- *Risk 1 (Background Tab Audio/Timer Stalls):* Background throttling might delay background audio or WebSocket heartbeats.
  - *Mitigation:* AntiFan Browser Desktop is an interactive theme testing host where active tabs receive priority; background WebSocket connections in Node/Electron main process are unaffected.
- *Risk 2 (Process Limit Sharing Side Effects):* `process-per-site` could cause one tab crash to take down another tab of the exact same origin.
  - *Mitigation:* `NativeTabHost` already implements crash recovery (`render-process-gone` listener) that recreates tab views on demand.

---

### Phase 3: Async QA Generation Guard & Race-Condition Defense

#### 3.1 Phase Overview
Eliminate race conditions where rapid page navigation or user interactions during an active Theme QA validation run cause stale scan results to overwrite fresh document states. Enforce document generation epoch tracking and post-await `signal.aborted` verification across all asynchronous boundaries in `AsyncThemeQaQueue` and `ThemeQaWorkflow`.

#### 3.2 Key Requirements
- **FR-3.1:** Maintain a strictly monotonic `generation: number` on each `AntiFanTab` record in `NativeTabHost`, incremented on `did-start-navigation` and `did-navigate`.
- **FR-3.2:** In `AsyncThemeQaQueue`:
  - Link each enqueued QA task to the exact `(tabId, generation)` tuple.
  - Calling `enqueue(tabId, generation, ...)` or `abort(tabId)` must immediately trigger `AbortController.abort()` on any existing job for that tab.
  - Catch and swallow `CapabilityError('TARGET_STALE')` cleanly without polluting error logs.
- **FR-3.3:** In `ThemeQaWorkflow.validate()`:
  - Enforce `if (input.signal?.aborted) throw new CapabilityError('TARGET_STALE', ...)` immediately before AND after EVERY `await` call (`reload`, `inspect`, `eval`, `responsiveCheck`, `diagnostics`, `yieldEventLoop`).
  - Capture and verify `target.generation` before emitting or persisting report artifacts.
- **FR-3.4:** Ensure MCP tools (`theme.qa_validate`, `theme.debug_bundle`) and UI IPC channels respect the `TARGET_STALE` protocol and discard outdated payload broadcasts.

#### 3.3 Architecture & State Transition
```text
Navigation Event (Tab 1: Gen 1 -> Gen 2)
  │
  ├── 1. NativeTabHost detects did-start-navigation
  │      └── tab.state.generation = 2
  │
  ├── 2. AsyncThemeQaQueue.enqueue(tabId: '1', generation: 2, task)
  │      ├── Aborts Gen 1 AbortController (signal.aborted = true)
  │      └── Spawns Gen 2 Worker with signal
  │
  └── 3. Gen 1 Task (in-flight in ThemeQaWorkflow.validate)
         ├── Wakes from await browser.eval(...)
         ├── Checks if (input.signal?.aborted) -> TRUE!
         ├── Throws CapabilityError('TARGET_STALE')
         └── Cleanly exits without publishing stale artifacts
```

#### 3.4 Related Code Files
- **Create:**
  - `test/main/qa/async-qa-generation-guard.test.ts` — Tests for generation increments, rapid aborts, and stale report suppression.
- **Modify:**
  - `src/main/qa/async-qa-job-queue.ts` — Enhance generation matching, error handling for `TARGET_STALE`, and cleanup logic.
  - `src/main/qa/theme-qa-workflow.ts` — Add comprehensive post-await `signal.aborted` checks across all 8 scan steps.
  - `src/main/browser/native-tab-host.ts` — Ensure `generation` increments on navigation events and passes into async QA triggers.
- **Delete:** None.

#### 3.5 Step-by-Step Implementation Steps
1. **Audit `src/main/qa/theme-qa-workflow.ts` Await Boundaries:**
   - Locate every `await` statement inside `validate()`:
     - `await this.ports.reload(input.target)`
     - `await this.inspect(...)`
     - `await this.ports.browser.eval(..., LiquidErrorScanner...)`
     - `await this.ports.browser.eval(..., LayoutOverflowEngine...)`
     - `await this.ports.browser.responsiveCheck(...)`
     - `await this.ports.browser.eval(..., BrokenAssetScanner...)`
     - `await yieldEventLoop()`
   - Add post-await guard immediately after each:
     ```typescript
     if (input.signal?.aborted) {
       throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
     }
     ```
2. **Harden `AsyncThemeQaQueue` in `src/main/qa/async-qa-job-queue.ts`:**
   - Verify that `enqueue()` atomically aborts the previous job and records `generation`.
   - In the `.finally()` handler, ensure active job deletion only occurs if the active job's generation matches the completing generation:
     ```typescript
     const current = this.activeJobs.get(tabId);
     if (current && current.generation === generation) {
       this.activeJobs.delete(tabId);
     }
     ```
3. **Connect Navigation Hooks in `NativeTabHost`:**
   - In `setupWebContentsEvents(tabId, view)`:
     - On `did-start-navigation`: Increment `tab.state.generation += 1`, call `this.asyncQaQueue.abort(tabId)`.
     - On `did-finish-load` / `did-stop-loading`: Trigger non-blocking async QA validation passing the new `tab.state.generation`.
4. **Integration & Concurrency Tests:**
   - Write `test/main/qa/async-qa-generation-guard.test.ts` simulating 20 rapid sequential navigations during active scanning and asserting that only the final generation's result resolves.

#### 3.6 Success Criteria
- Rapid tab navigation (10 URL changes in 500ms) produces 0 unhandled promise rejections and 0 stale report emissions.
- All stale background tasks terminate within $\le 5\text{ms}$ of abort signal trigger.
- Zero race condition regressions in multi-tab QA validation suites.

#### 3.7 Risk Assessment & Mitigations
- *Risk 1 (Silent Swallowing of Real Errors):* Swallowing errors too broadly in `AsyncThemeQaQueue` might mask unexpected syntax or runtime bugs.
  - *Mitigation:* Restrict error suppression strictly to `signal.aborted === true` and `err.code === 'TARGET_STALE'`; all other error types are logged via `console.warn`.

---

### Phase 4: Real Runtime Endurance Soak Test Suite & Final Verification

#### 4.1 Phase Overview
Upgrade the existing mock-based soak test into a comprehensive, real-runtime endurance testing suite. Implement `scripts/smoke-real-soak.cjs` to launch real Electron instances with Chromium tabs, PTY streams, and concurrent Theme QA workloads, calculating linear memory regression ($\beta = \frac{\text{Cov}(t, \text{RAM})}{\text{Var}(t)}$) to mathematically prove zero memory and process leaks.

#### 4.2 Key Requirements
- **FR-4.1:** Retain and strengthen mathematical slope calculation (`calculateMemorySlope`) in `test/e2e/soak-test.test.ts` with unit test vectors.
- **FR-4.2:** Create `scripts/smoke-real-soak.cjs` capable of:
  - Spawning a real Electron process running AntiFan Browser Desktop in automated smoke mode via `scripts/run-electron.cjs`.
  - Initializing local HTTP test servers serving rich mock storefront templates (Liquid errors, horizontal overflow, broken assets).
  - Executing a 4-Stage Real Endurance Pipeline over 50+ iterations:
    - *Stage 1 (Idle Baseline):* 10s steady-state memory recording.
    - *Stage 2 (High-Throughput PTY Streaming):* Spawn PTY shells, blast 500KB of streaming data across IPC, verify buffer deallocation.
    - *Stage 3 (Tab Thrash & Split Review):* Rapidly open, switch, split-review, and close 10 WebContents tabs.
    - *Stage 4 (Concurrent QA Execution):* Execute 20 concurrent Theme QA validations while navigating.
  - Sampling RSS, Heap Used, and child process counts every 500ms.
- **FR-4.3:** Compute regression slope: Assert $\beta \le 1.0\text{ MB/min}$ and assert 0 orphaned child/renderer/PTY processes on completion.
- **FR-4.4:** Integrate `smoke-real-soak.cjs` into package scripts as `npm run test:soak:real`.

#### 4.3 Architecture & Endurance Pipeline
```text
[scripts/smoke-real-soak.cjs]
  │
  ├── 1. Spawns Local Mock Storefront HTTP Server (Port: ephemeral)
  │
  ├── 2. Spawns Electron Host (scripts/run-electron.cjs)
  │      └── Connects via Local IPC / Bridge Protocol
  │
  ├── 3. Executes 4-Stage Endurance Flow:
  │      ├── Stage 1: Idle Baseline (Sample RAM every 500ms)
  │      ├── Stage 2: PTY Stream Burst (10x 50KB chunks -> clean exit)
  │      ├── Stage 3: Split Tab Thrash (Create 10 tabs -> split -> close)
  │      └── Stage 4: Continuous Theme QA Scans (20 runs under load)
  │
  ├── 4. Telemetry Aggregation & Mathematical Analysis:
  │      ├── Calculates Linear Slope: Beta = Cov(t, RAM) / Var(t)
  │      ├── Inspects Process Tree for Orphaned Renderers / PTYs
  │      └── Verifies E:\Work\.antifan-data Storage Invariants
  │
  └── 5. Pass/Fail Gate:
         ├── Beta <= 1.0 MB/min -> PASS
         └── Beta > 1.0 MB/min or Leaked PIDs -> FAIL (Exit Code 1)
```

#### 4.4 Related Code Files
- **Create:**
  - `scripts/smoke-real-soak.cjs` — Real runtime Electron endurance soak test runner.
  - `test/e2e/soak-slope.test.ts` — Isolated unit test suite for linear regression mathematical accuracy.
- **Modify:**
  - `test/e2e/soak-test.test.ts` — Enhance endurance test harness with real allocation and timing patterns.
  - `package.json` — Add `test:soak` and `test:soak:real` scripts.
- **Delete:** None.

#### 4.5 Step-by-Step Implementation Steps
1. **Develop `test/e2e/soak-slope.test.ts`:**
   - Implement unit tests for `calculateMemorySlope` covering flat slope ($0.0\text{ MB/min}$), rising slope ($2.0\text{ MB/min}$), and negative slope.
2. **Develop `scripts/smoke-real-soak.cjs`:**
   - Setup ephemeral HTTP mock server with realistic store HTML/CSS assets.
   - Spawn Electron via `child_process.spawn(process.execPath, [launcherPath, smokeAppPath])`.
   - Setup memory sampling polling using `process.memoryUsage()` and Windows `tasklist /FI "IMAGENAME eq electron.exe"` to monitor main and renderer processes.
   - Execute Stage 1 (Idle Baseline), Stage 2 (PTY Streaming 500KB burst), Stage 3 (Tab Thrash: 10 cycles of create/split/close), Stage 4 (20 QA validations).
   - Perform linear regression calculation on collected memory samples.
   - Verify process cleanup: confirm all child renderers and PTY shells are terminated.
   - Exit with code 0 if all assertions hold; exit 1 on memory slope breach or process leak.
3. **Configure `package.json` Commands:**
   - Add `"test:soak": "node --test .compiled/test/e2e/soak-test.test.js"`
   - Add `"test:soak:real": "node scripts/smoke-real-soak.cjs"`
4. **Execution & Final Validation:**
   - Execute `npm run test:soak:real` and verify endurance metrics on the host machine.

#### 4.6 Success Criteria
- `smoke-real-soak.cjs` completes all 4 endurance stages without crash or timeout.
- Linear memory regression slope $\beta \le 1.0\text{ MB/min}$ across the test run.
- Zero orphaned Electron renderer processes or `conpty`/`winpty` child processes remaining.
- Full compatibility with Drive E storage redirection verified during soak execution.

#### 4.7 Risk Assessment & Mitigations
- *Risk 1 (Transient Garbage Collection Spikes):* V8 minor/major GC cycles can cause temporary memory fluctuations that skew linear slope calculation over short time windows.
  - *Mitigation:* Ensure baseline sampling window is sufficiently long ($\ge 30\text{s}$) with high sampling density ($\ge 60$ data points) and sample RSS after `global.gc()` if available in smoke mode.

---

## 4. Acceptance Criteria & Success Gates

| Gate ID | Category | Observable Verification Criteria | Verification Method |
| :--- | :--- | :--- | :--- |
| **AC-01** | **Drive E Storage Relocation** | All Chromium profile files, disk/gpu caches, session manifests, terminal states, and artifacts are created inside `E:\Work\.antifan-data\...`. Zero bytes written to `%APPDATA%\antifan-browser-desktop` on Drive C. | File system assertion in `test/main/storage-locations.test.ts` & manual inspection of `E:\Work\.antifan-data`. |
| **AC-02** | **Legacy Profile Migration** | Existing authenticated cookies and localStorage in legacy Drive C profile are atomically copied to `E:\Work\.antifan-data\profile` on first run without data corruption or lock conflicts. | `node --test .compiled/test/main/profile-ownership.test.js` |
| **AC-03** | **Low-Spec Hardware Tuning** | Chromium starts with `renderer-process-limit=4`, `process-per-site`, disk cache 128MB, media cache 64MB, and `disable-gpu-memory-buffer-video-frames`. Inactive WebContentsViews have `backgroundThrottling: true`. | Startup flags verification probe & WebPreferences inspection in `native-tab-host.test.ts`. |
| **AC-04** | **Event Loop Responsiveness** | Cooperative yields in `ThemeQaWorkflow` prevent event loop starvation; main process event loop delay remains $< 25\text{ms}$ during 5-stage Theme QA scans. | Event loop monitor telemetry in `telemetry.ts` during QA run. |
| **AC-05** | **Async QA Race Defense** | Navigating a tab during an in-flight QA run immediately aborts previous scanners; stale reports from generation $N$ are never published when active generation is $N+1$. | Concurrency test in `test/main/qa/async-qa-generation-guard.test.ts`. |
| **AC-06** | **Real Runtime Soak Stability** | 4-stage real Electron soak test runs 50+ tab switches, PTY bursts, and QA scans with memory slope $\beta \le 1.0\text{ MB/min}$ and 0 orphaned child processes. | Execution of `node scripts/smoke-real-soak.cjs` with exit code 0. |
| **AC-07** | **Zero Regression Baseline** | Full test suite maintains 100% pass rate (437+/437+ tests across all suites) and 0 TypeScript compilation errors. | `npm run build && npm test` |

---

## 5. Implementation Roadmap & Execution Sequencing

```text
+-------------------------------------------------------------------------------+
| Sequence 1: Phase 1 — Drive E Complete Storage Relocation & Migration Engine  |
| - Create src/main/storage/storage-locations.ts & unit tests                   |
| - Update profile-ownership.ts for cross-volume migration                      |
| - Update index.ts, session-resume, bridge, history, terminal, and capsules    |
+-------------------------------------------------------------------------------+
                                       │
                                       v
+-------------------------------------------------------------------------------+
| Sequence 2: Phase 2 — Low-Spec Hardware Optimization                          |
| - Configure Chromium flags in src/main/index.ts                               |
| - Implement src/main/utils/event-loop.ts (yieldEventLoop)                     |
| - Enforce background throttling in native-tab-host.ts                         |
| - Insert cooperative yields in theme-qa-workflow.ts                           |
+-------------------------------------------------------------------------------+
                                       │
                                       v
+-------------------------------------------------------------------------------+
| Sequence 3: Phase 3 — Async QA Generation Guard & Race-Condition Defense      |
| - Add post-await signal.aborted guards across all steps in theme-qa-workflow  |
| - Harden generation tracking and cleanup in async-qa-job-queue.ts             |
| - Connect navigation epoch triggers in native-tab-host.ts                     |
| - Add test/main/qa/async-qa-generation-guard.test.ts                          |
+-------------------------------------------------------------------------------+
                                       │
                                       v
+-------------------------------------------------------------------------------+
| Sequence 4: Phase 4 — Real Runtime Endurance Soak Test Suite & Final QA Gate  |
| - Create test/e2e/soak-slope.test.ts for slope calculation validation         |
| - Create scripts/smoke-real-soak.cjs for 4-stage real Electron endurance test |
| - Update package.json scripts                                                 |
| - Execute full verification gate (npm run build && npm test && soak test)     |
+-------------------------------------------------------------------------------+
```

---
*Report generated and self-contained at `plans/260830-1903-drive-e-migration-and-low-spec-hardening/reports/planner-ultra-candidate-5.md`.*
