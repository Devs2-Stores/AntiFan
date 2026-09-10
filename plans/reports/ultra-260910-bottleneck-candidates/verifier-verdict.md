# Ultra verifier verdict — bottleneck scout (2026-09-10)

Same-tier best-of-5 (independent samples + rubric selection); verifier ran on the runtime's
reviewer role, sharing the session model tier with candidates. Not asymmetric verification.

Anonymization map: A=candidate 3, B=candidate 1, C=candidate 4, D=candidate 2, E=candidate 5.
Winner: candidate 5 (label E). Finalized as a validated UNION, not a winner-selection.

Overall correctness (verifier self-report): correct
Confidence: 1

---

## Scoring

| Candidate | Coverage (1-20) | Evidence Quality (1-20) | Signal Density (1-20) | Pathology Accuracy (1-20) | Gap Honesty (1-20) | Total (/100) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Candidate A** (Candidate 3) | 17 | 16 | 18 | 18 | 18 | **87** |
| **Candidate B** (Candidate 1) | 18 | 18 | 19 | 18 | 19 | **92** |
| **Candidate C** (Candidate 4) | 18 | 19 | 18 | 18 | 18 | **91** |
| **Candidate D** (Candidate 2) | 15 | 14 | 15 | 14 | 17 | **75** |
| **Candidate E** (Candidate 5) | 20 | 20 | 20 | 20 | 19 | **99** |

### Scoring Breakdown & Deductions
- **Candidate E (99/100)**: Decisive winner. Uncovered 5 critical, live-verified bottlenecks that no other candidate found: (1) `ArtifactStore` constructor synchronous filesystem walk and JSON parsing of all historical runs on the Electron startup thread, with `enableRetentionCleaner` dead in code; (2) 4 orphaned test files completely skipped by `package.json` globs (3 in `src/main/` and 1 `.cjs` in `test/e2e/`); (3) `run-antifan.vbs` shortcut executing stale code silently due to `main.cjs` existence-only check; (4) Dev port 20130 vs MCP default 20129 silent disconnect; (5) `renderer-process-limit=4` throttling multi-tab storefront QA on a 4C/8T machine. Flawless evidence, exact counts (76 scripts + 3 subdirs, 57 PNGs), 0 hallucinations. Docked 1 point on gap honesty for not explicitly bounding baseline growth analysis.
- **Candidate B (92/100)**: Runner-up. Exceptional analysis of test source-pinning (10+ tests reading `native-tab-host.ts` via `fs.readFileSync` and matching regexes), 261.4s `test:main` execution time (.canary/state/main-followup2.log:1714), and unbounded `.antifan/annotations/` (1,428+ files) with cleaner only sweeping `.artifact`. Docked 2 points on evidence quality for stating 6,757 lines on `native-tab-host.ts` (actual: 6,749) and 62 root PNGs (actual: 57).
- **Candidate C (91/100)**: Strong 3rd. Uncovered that `scripts/cdp/` is an empty directory created at startup in `dev.mjs:34-36`, proving `isHotSwappable` is dead code. Profiled `computePixelDiff` (`browser-control-port.ts:5860-5965`) showing inner-loop `isMasked` linear box scans and `Math.sqrt` calls over 8.2M pixels in the main process. Exactly counted 57 root PNGs. Docked points for undercounting `scripts/` top-level code files as 65 (actual: 76).
- **Candidate A (87/100)**: Solid 4th. Identified the destructive `clean` race condition deleting `.compiled` under a running app (citing `brainstorm-260905...md:33`), identified orphaned `terminal-gap-state-machine.test.ts`, and verified closed findings at HEAD. Docked heavily (4 points) on evidence quality for a clear hallucination: claiming `.antigravity/` does not exist (verified present on disk). Missed root PNG count by 1 (reported 56).
- **Candidate D (75/100)**: 5th place. Correctly identified closed issues at HEAD and exact line counts of `native-tab-host.ts` (6,749) and `browser-control-port.ts` (6,033). Docked heavily for severely undercounting root PNGs (reported 25; actual: 57), treating module LOC size as a bottleneck rather than an architectural smell, and missing the live-process `.compiled` deletion conflict in B1.

---

## Ranking

1. **Candidate E (Candidate 5)** — **Winner** (Score: 99/100). Superior diagnostic depth. Discovered multiple unique, verifiable architectural defects (main-thread synchronous startup scan in `ArtifactStore`, orphaned zero-network/e2e tests, shortcut silent stale launch, port 20130/20129 silent disconnect, Chromium renderer throttling).
2. **Candidate B (Candidate 1)** — **Runner-up** (Score: 92/100). Outstanding discovery of source-text pinning in tests that penalizes refactoring the 6.7k-LOC host file, deep test suite duration metrics (261.4s), and discovery of the `.artifact`-only retention cleaner flaw.
3. **Candidate C (Candidate 4)** — **Third** (Score: 91/100). Excellent discovery of the dead `scripts/cdp` hot-swap branch, rigorous identification of main-process CPU thrashing in `computePixelDiff`, and exact file counting.
4. **Candidate A (Candidate 3)** — **Fourth** (Score: 87/100). Identified the `clean` preload ENOENT live race condition and skipped P0 terminal test harnesses, but marred by a factual hallucination regarding `.antigravity/`.
5. **Candidate D (Candidate 2)** — **Fifth** (Score: 75/100). Accurate on module LOC counts and HEAD closures, but lacked unique findings, undercounted root files by >50%, and conflated code size with active bottlenecks.

---

## Final Union of Bottlenecks

### B1. Destructive Shared `.compiled` Clean Wipes Live App & Watcher Artifacts During Gates [P0 - Blocking]
- **What it is**: `package.json` `"clean"` (`line 18`) executes `node -e "fs.rmSync('.compiled',{recursive:true,force:true})"`. This clean command is hardcoded as the first step of `"compile"` (`line 21`) and duplicated in `"test"` (`line 37`). Furthermore, 14 `smoke:*` scripts (`lines 40-56`), `package` (`line 39`), and `certify-core-freeze.cjs:25` all invoke `npm run compile`.
- **Evidence**: `package.json:18, 21, 37, 40-56`; `scripts/dev.mjs:129-133` launches Electron against `.compiled/src/main/index.js` and runs `tsc -p ./ --watch` emitting into `.compiled`. In-repo documentation `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md:33` verifies the symptom: *"Race condition khi script npm run compile chạy fs.rmSync('.compiled') trong lúc app đang chạy -> preload ENOENT"*.
- **Why it blocks the daily loop**: In the standard solo loop, `npm run dev` runs in Terminal 1. When the developer runs `npm test`, `npm run verify`, `npm run certify:core-freeze`, or any `smoke:*` command in Terminal 2, the build immediately deletes `.compiled` from disk. The running Electron app crashes with missing module/preload errors or fails to spawn webviews, forcing a tedious teardown and restart.
- **Concrete Fix**: Remove `npm run clean` from `"compile"` and `"test"` (tsc safely overwrites existing files). Create an explicit `"rebuild": "npm run clean && npm run compile"`. Remove `clean` prerequisites from all `smoke:*` scripts and `certify-core-freeze.cjs`.

### B2. No Incremental Typecheck / Compilation: 124k+ LOC Cold Rebuild on Every Entry Point [P1 - High]
- **What it is**: `tsconfig.json` lacks `"incremental": true` and `"tsBuildInfoFile"`. Its `"include"` glob pulls `src/**/*.ts`, `scripts/**/*.ts`, and `test/**/*.ts` (~124k LOC total; 62,121 LOC in `src/main`, 54,769 LOC across `test/main`, `test/unit`, `test/e2e`, 10,892 LOC in `src/renderer`) into a single monolithic compilation unit.
- **Evidence**: `tsconfig.json:1-24` (no `incremental`, no `composite`); `package.json:38` (`"verify": "npm run typecheck && npm test"`, which executes `tsc --noEmit`, then `clean`, then `compile` [`tsc -p ./`], performing two full typechecks of the identical 124k LOC program); `scripts/dev.mjs:129-135` runs blocking synchronous `execSync('npm run compile')` before spawning `tsc --watch`.
- **Why it blocks the daily loop**: Any change in a test file forces a full re-emit of the application, and any change in `src/main` forces re-checking of all 128 `test/main` files. Cold compilation takes tens of seconds with memory flags up to `--max-old-space-size=4096`, imposing a heavy tax on every startup, smoke run, and git pre-commit check.
- **Concrete Fix**: Add `"incremental": true` and `"tsBuildInfoFile": ".cache/tsconfig.tsbuildinfo"` to `tsconfig.json`. Split test compilation into `tsconfig.test.json` (excluding tests from the main app emit). Change `verify` to compile once and reuse the emitted types.

### B3. All `src/main/**` Edits Force Hard Electron Kill, 800ms Wait, and Complete Session State Loss [P1 - High]
- **What it is**: `scripts/dev-watcher-helpers.mjs` provides hot-swap dispatching, but its predicates only recognize two paths: `isHotSwappable` matches strictly `^scripts/cdp/([^/]+)\.source\.js$` (`line 43`), and `isUiHotSwappable` matches `^src/renderer/[^/]+\.(css|html|js|ts)$` (`line 231`). `scripts/cdp/` is an **empty directory** created by `dev.mjs:35`, meaning the CDP hot-swap branch is completely dead in practice. All edits in `src/main/**` (130+ files, ~62k LOC) fall through to `relaunchElectronFn()`.
- **Evidence**: `scripts/dev-watcher-helpers.mjs:39-45, 229-232, 400-425`; `scripts/dev.mjs:102-120` (`killTree` via `taskkill /pid ... /T /F` + fixed `setTimeout(800ms)` sleep + spawn fresh Electron) and `debounceMs: 1200` (`dev.mjs:203`). `scripts/cdp/` is verified empty on disk.
- **Why it blocks the daily loop**: When fixing core logic in `native-tab-host.ts`, `browser-control-port.ts`, or capability modules, saving triggers an ungraceful process kill, a 2-second delay, and destroys all open storefront tabs, active terminals, PTY sessions, agent attachments, and DevTools windows.
- **Concrete Fix**: Delete or populate the dead `scripts/cdp` branch. Extend the soft-reload transport (`antifan.system.reloadScripts`, wired in `bridge-server.ts:2334`) to leaf modules in `src/main/tools/*` and `src/main/verification/*`. Auto-restore persisted tab sessions (`sanitizeTabForPersistence`/`migratePersistedTab`) on dev relaunch.

### B4. `ArtifactStore` Constructor Synchronously Scans & Parses Unbounded Filesystem Tree on Main Startup Thread [P1 - High]
- **What it is**: `ArtifactStore` constructor synchronously calls `this.rehydrateIndex()` (`artifact-store.ts:70`). This method traverses every `run-*` directory in the storage root using synchronous `readdirSync`, calls `statSync` on every `.artifact` file, and executes `readFileSync` and `JSON.parse` on every `index.json` (`artifact-store.ts:97-133`).
- **Evidence**: `src/main/tools/artifact-store.ts:70, 97-133`; `src/main/index.ts:235` passes `resolveArtifactStoreOptionsFromEnv()`. In `src/main/control-plane/control-plane-runtime.ts:61-75`, `resolveArtifactStoreOptionsFromEnv` parses only `maxArtifactBytes` and `maxRunBytes` — it **never passes `enableRetentionCleaner: true`**. Grepping the repository confirms `enableRetentionCleaner` is never passed by any caller.
- **Why it blocks the daily loop**: Because this runs synchronously on Electron's main thread inside `ControlPlaneRuntime` initialization (`control-plane-runtime.ts:125`), application startup blocks before the first window can be displayed. Because retention cleaning is never enabled, the artifact store grows monotonically with every run, making app startup progressively slower over weeks of development.
- **Concrete Fix**: Pass `enableRetentionCleaner: true` by default in `resolveArtifactStoreOptionsFromEnv()`. Make `rehydrateIndex()` lazy (load run indices on demand when a run is accessed by ID) or asynchronous, off the main Electron startup path.

### B5. Test Suite Monolith (4.5 min) & Brittle Tests Pinning Exact Source Text of God Modules [P1 - High]
- **What it is**: `test:main` runs 128 test files serially taking 261.4s (over 4.3 minutes) with zero per-file execution scripts in `package.json`. Worse, over 10 test files read `src/main/browser/native-tab-host.ts` (6,749 LOC) directly via `fs.readFileSync` and assert literal string substrings and complex multi-line regular expressions against its private source code.
- **Evidence**: Measured runtime in `.canary/state/main-followup2.log:1714` (`duration_ms 261444.2423`, `MAIN_EXIT=0`). In `test/main/ipc-audit.test.ts:10-12`, `nativeTabHostPath` is read as UTF-8 string, followed by `content.includes('ipcMain.handle(' + channel)` (`:53, 67, 82`), method body regex extractions (`:331-334`), and multi-line regex matches for `clearInitialNavigationHistory` (`:401-405`). Also verified in `test/main/split-view-fixes-regression.test.ts:46-49`, `terminal-switching-regression.test.ts:698-701, 770-773`, and `preview-protocol-and-watcher.test.ts:161-164`.
- **Why it blocks the daily loop**: A developer cannot run a single test without invoking custom terminal commands. More critically, any code cleanup, refactoring, whitespace change, or modularization of the 6.7k-LOC `native-tab-host.ts` causes unrelated test suites to fail after a 4.5-minute wait, penalizing structural improvements.
- **Concrete Fix**: Add `"test:file": "node --test --test-force-exit"` to `package.json`. Delete source-code text inspections in `test/main/*.test.ts`; replace them with behavioral assertions against `MockTabHost` or the public IPC/capability registration surface.

### B6. Skipped & Orphaned P0 Regression Tests in Test Gates [P1 - High]
- **What it is**: Critical regression tests and transport harnesses are silently omitted from the `npm test` and `npm run verify` gate graph due to path and glob mismatches.
- **Evidence**:
  1. `test/renderer/terminal-gap-state-machine.test.ts` (the regression test for terminal chunk-loss on cold start) is matched by no npm script in `package.json`.
  2. 3 unit test files located in `src/main/` (`src/main/tools/browser-control-port-zero-network.test.ts`, `src/main/browser/zero-network-interceptor.test.ts`, and `src/main/browser/network-policy.test.ts`) compile into `.compiled/src/`, but `package.json` only globs `.compiled/test/**/*.test.js`.
  3. `test/e2e/terminal-rename-space.test.cjs` and the 4 terminal e2e harnesses (`terminal-transport-sync.cjs`, `terminal-recovery-smoke.cjs`, `terminal-renderer-smoke.cjs`, `terminal-split-hydration-probe.cjs`) are `.cjs` files, whereas `"test:e2e"` only globs `".compiled/test/e2e/**/*.test.js"`.
- **Why it blocks the daily loop**: The developer relies on `npm test` or `npm run verify` as proof of correctness, but these runs provide false confidence while silently skipping zero-network security invariants and terminal transport regressions.
- **Concrete Fix**: Move the 3 `src/main/**/*.test.ts` files into `test/main/` or add `".compiled/src/**/*.test.js"` to `"test:unit"`. Add `test/renderer/**/*.test.js` to `"test:fast"`. Add a `"test:e2e:cjs"` script or rename `.cjs` test fixtures so they are evaluated in the standard gate.

### B7. Main-Process CPU Thrashing in `computePixelDiff` (Unoptimized JS Loops over 8.2M Pixels) [P1 - High]
- **What it is**: `computePixelDiff` (`src/main/tools/browser-control-port.ts:5860-5965`) executes bitmap comparison in pure JavaScript on the Electron main process thread.
- **Evidence**: Inside nested loops `for (let y = 0; y < minH; y++)` / `for (let x = 0; x < minW; x++)`, line 5863 calls `isMasked(x, y)` which linearly scans `maskBoxes` for every pixel. For every non-masked pixel, it computes `Math.sqrt(rDiff^2 + gDiff^2 + bDiff^2) / 441.67`. On color differences, it enters an 8-neighbor pass (`lines 5898-5926`) executing up to 16 additional `Math.sqrt` calculations. For a 1440x5715 document (Page 12 Hoplongtech), that equals 8.2 million pixels and tens of millions of square roots executed synchronously.
- **Why it blocks the daily loop**: Freezes the Electron UI thread and leads to client timeouts. `scripts/antifan-omp-mcp.cjs:308` has to raise the client timeout to 240,000 ms (4 minutes) for `anti.visual.compare` to prevent agent dropouts during comparison.
- **Concrete Fix**: Pre-calculate a 2D bitmask or interval map for `maskBoxes` before the loop to eliminate `isMasked` linear scans. Compare squared Euclidean distance (`rDiff^2 + gDiff^2 + bDiff^2 > threshold^2`) to eliminate `Math.sqrt` from the hot pixel path. Offload image diffing to a worker thread or native addon.

### B8. Render & Capture Timeout Cascades from Inactive Tab Throttling & Quarantine Traps [P2 - Medium]
- **What it is**: In `src/main/security/security-policy.ts:137`, `backgroundThrottling: options?.backgroundThrottling ?? true`. For non-offscreen background tabs, `backgroundThrottling` defaults to `true`. When an agent captures or compares against an inactive tab, Chromium throttles rAF and compositing.
- **Evidence**: Documented as **CHƯA FIX (Căn nguyên gốc P0)** in `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md:34`. Furthermore, in `.canary/CORE-BOTTLENECKS.md:82-96, 176-186` (F4, F7), `anti.screenshot.full_page` and `anti.screenshot.viewport` fail or time out at 30s/60s bounds, leaving the target in `TARGET_BUSY_DRAINING` quarantine, causing all subsequent captures on that tab to fail immediately.
- **Why it blocks the daily loop**: Live storefront vs clone visual QA inherently involves two tabs. The inactive tab being measured is throttled, leading to blank screenshots, `TARGET_STALE` errors, or 60-second timeouts that abort agent tasks.
- **Concrete Fix**: Implement scoped unthrottling: set `backgroundThrottling: false` whenever a tab has an active agent lease or capture transaction (`native-tab-host.ts:3706`). Make `drainTarget` quarantine self-healing with a fast internal abort-and-reset instead of persistent failure.

### B9. Triple-Registry Capability Duplication with Mismatched Names and Budgets [P2 - Medium]
- **What it is**: Capabilities are defined and maintained across three separate registries with up to 4 alias names per operation.
- **Evidence**:
  1. `src/main/tools/browser-capabilities.ts` (3,555 lines) contains ~150 registrations, ~72 of which are explicit aliases (e.g. `anti.browser.tabs.create` -> `browser.open-tab` at line 1610; `antifan_set_viewport` at line 1188; `browser_press_key` at line 1091).
  2. `src/main/mcp/mcp-server.ts:769-810` generates a secondary dynamic alias layer at list time.
  3. `scripts/antifan-omp-mcp.cjs:10-61` hardcodes 52 tool definitions and `:258-305` hardcodes a 42-entry `CAPABILITY_MAP`.
  4. Client timeout overrides in `antifan-omp-mcp.cjs:306-316` (240s for visual compare, 150s for full-page screenshot) diverge from the 30s default and server-side policy bounds.
- **Why it blocks the daily loop**: Adding or updating a capability requires manual synchronization across multiple files and languages. Name drift causes capabilities to disappear or fail silently depending on whether they are called via MCP, terminal, or internal IPC.
- **Concrete Fix**: Generate MCP tool definitions and `CAPABILITY_MAP` automatically from `CapabilityCatalogue` metadata at build time. Collapse aliases down to a single canonical `anti.*` namespace with a lightweight compatibility map.

### B10. Dev Port (20130) vs MCP Default (20129) Causes Silent Zero-Tool Agent Sessions [P2 - Medium]
- **What it is**: `src/main/bridge/bridge-server.ts:245` shifts the bridge WebSocket port in development mode: `this.port = isDev && port === 20129 ? 20130 : port;`. However, the standalone MCP proxy `scripts/antifan-omp-mcp.cjs:76` parses `process.env.ANTIFAN_MCP_PORT || '20129'`.
- **Evidence**: `src/main/bridge/bridge-server.ts:178, 245`; `scripts/antifan-omp-mcp.cjs:76-95`. Furthermore, `resolveBridgeCandidates()` in `antifan-omp-mcp.cjs` returns `[]` unless `ANTIFAN_MCP_BOOTSTRAP` or `ANTIFAN_ATTACHMENT_SECRET` is set in the environment, intentionally rejecting on-disk discovery.
- **Why it blocks the daily loop**: Any coding agent or external MCP client attempting to connect to a running `npm run dev` instance without an explicit port override fails to connect or silently receives an empty tool list, with no log explaining that the dev server is listening on port 20130 rather than 20129.
- **Concrete Fix**: In dev mode (`NODE_ENV !== 'production'`), allow `scripts/antifan-omp-mcp.cjs` to read the active port from `bridge-dev.json` (written by `bridge-server.ts`) as a fallback when `ANTIFAN_MCP_PORT` is unspecified.

### B11. Shortcut Launch (`run-antifan.vbs`) Silently Executes Stale Code [P2 - Medium]
- **What it is**: `run-antifan.vbs` launches Electron directly with `--allow-eval` via `WshShell.Run "electron.exe . --allow-eval"`, bypassing `scripts/dev.mjs` completely. In `main.cjs:12`, compilation is only triggered `if (!fs.existsSync(compiledMain))` — an existence check, never a timestamp check.
- **Evidence**: `run-antifan.vbs:1-3`; `main.cjs:10-25`.
- **Why it blocks the daily loop**: If the developer edits code in `src/**` and launches AntiFan via the desktop shortcut or `.vbs` script, the application boots instantly without recompiling or warning that `.compiled/src/main/index.js` is older than `src/**` source files. The developer spends hours debugging why changes have no effect.
- **Concrete Fix**: In `main.cjs`, check whether any file in `src/**` has an `mtimeMs` newer than `compiledMain`. If stale, display a prominent warning dialog or trigger an incremental rebuild.

### B12. Dev Lock Orphanage on Crash and Indiscriminate Global Process Killing [P2 - Medium]
- **What it is**: `scripts/dev.mjs:42-56` acquires a PID singleton lock at `node_modules/.cache/antifan-dev.pid`. When `dev.mjs` crashes or is killed ungracefully, the lock file remains. On subsequent launches, `dev.mjs` exits with an error suggesting `taskkill /F /T /PID <pid>`. To recover, developers run `npm run clean` or `scripts/kill-all.mjs`, which executes `taskkill /F /IM electron.exe`.
- **Evidence**: `node_modules/.cache/antifan-dev.pid` verified present on disk (`{"pid":40304,"root":"E:\\Work\\apps\\AntiFan","startedAt":1788936259272}`); `scripts/kill-all.mjs:1-9` runs `taskkill /F /IM electron.exe` without scoping to AntiFan or deleting `antifan-dev.pid`.
- **Why it blocks the daily loop**: Windows PID recycling can cause `process.kill(pid, 0)` to falsely report an orphaned PID as alive. Manual recovery requires inspecting files and running cmd commands. Meanwhile, `kill-all.mjs` abruptly kills all unrelated Electron applications (VS Code, Slack, etc.) on the developer's system while leaving the stale PID file intact.
- **Concrete Fix**: Provide `npm run dev -- --force` or `--unlock` to invalidate stale locks safely. Scope `kill-all.mjs` to target AntiFan's specific process tree and remove `antifan-dev.pid`.

### B13. Unbounded Accumulation of Annotations in Active Workspace [P3 - Low-Medium]
- **What it is**: UI element picking and snapshotting writes markdown annotations and PNG snapshots into `.antifan/annotations/` and `.antifan/snapshots/` inside the active repository root.
- **Evidence**: `.antifan/annotations/` contains **1,572** markdown files (`element_*.md`). `src/main/tools/artifact-retention-cleaner.ts:47` explicitly restricts its directory scan: `else if (entry.isFile() && entry.name.endsWith('.artifact'))`. It never sweeps `.md` or `.png` files in `.antifan/`.
- **Why it blocks the daily loop**: While excluded by `.gitignore`, these thousands of small files bloat the workspace tree, slowing down Git status, IDE indexing, file search, and Windows Defender real-time scans on a laptop SSD.
- **Concrete Fix**: Extend `artifact-retention-cleaner.ts` to sweep `.antifan/annotations/` and `.antifan/snapshots/` using the same `maxAgeMs` (e.g. 7 days) LRU policy applied to `.artifact` files.

---

## Dropped Findings

1. **Dropped: Candidate A's claim that `.antigravity/` directory does not exist (`there is no .antigravity/ directory (packet wrong)`)**
   - *Reason*: Directly refuted by filesystem inspection. The directory `.antigravity/` exists at repository root, containing `mcp-bridge/`, `latest_element_mcp.json` (12.8 KB), `snapshots/`, `session.json`, and `annotations/`. This was a candidate hallucination.
2. **Dropped: Candidate D's claim that repository root contains 25 loose PNG files**
   - *Reason*: Refuted by direct count. The repository root contains exactly **57 loose `.png` files** (accounting for ~46 MB of ignored clutter), confirmed by Candidates C and E. Candidate D missed 32 files (>56% omission).
3. **Dropped: Candidate D's classification of God Modules (`native-tab-host.ts` 6,749 LOC, `browser-control-port.ts` 6,033 LOC) as a standalone bottleneck (B5)**
   - *Reason*: Large source files are an architectural code smell, not an operational loop bottleneck for a solo developer. The real bottlenecks arising from these files—namely (a) lack of hot-reload forcing cold restarts (B3), (b) tests asserting raw file contents as strings (B5), and (c) unoptimized pixel loops in `browser-control-port.ts` (B7)—are captured as concrete, actionable defects.
4. **Dropped: Candidate B's line count of 6,757 for `native-tab-host.ts`**
   - *Reason*: Refuted by line inspection. `src/main/browser/native-tab-host.ts` terminates at line 6,749 (confirmed by Candidates C, D, and E).
5. **Dropped: Speculative Claims Regarding Pre-Existing Canary & Profiling Byte Sizes**
   - *Reason*: Directory byte counts from the packet (e.g., `appdata` 1.9 GB, `.canary` 955 MB, `out` 699 MB, `plans` 486 MB) cannot be verified via disk usage tools under read-only constraints. They are retained as structural inventory findings rather than measured byte bottlenecks.

---

## Unresolved Questions

1. **Wall-clock Compilation and Verification Durations**: The exact elapsed wall-clock seconds for `npm run compile`, `npm run typecheck`, and `npm run verify` on this Intel Core i5-9300H CPU cannot be determined without running builds (prohibited by read-only verification rules). The performance penalty is established structurally from the 124k-LOC single-unit scope and redundant cold build chains, but empirical timings remain `[INFERENCE]`.
2. **Current Gate Pass/Fail Status at HEAD**: Whether the full `npm test` suite currently passes with exit code 0 or has failing tests cannot be verified read-only.
3. **`tsc --watch` Resilience on Directory Deletion**: How the running `tsc --watch` child process behaves on Windows when `.compiled` is deleted out from under it by a secondary process (whether it recovers automatically on the next filesystem change or requires a manual restart) was not directly exercised.
4. **Viability of Fine-Grained Module Hot-Reloading in `src/main`**: Whether the existing `antifan.system.reloadScripts` transport can safely hot-swap pure Leaf modules in `src/main/tools/*` without corrupting Electron's `webContents` and main singleton references requires an active architectural spike.
5. **Active vs Abandoned Profiles in `appdata/`**: While `profile-ownership.ts:183` establishes that `appdata/` profiles are bypassed once canonical `E:/Work/.antifan-data/Profile` exists, whether any legacy test script or probe still binds to `appdata/antifan-test-new-instance` remains unverified.