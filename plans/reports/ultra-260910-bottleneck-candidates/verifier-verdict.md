# Ultra verifier verdicts — bottleneck scout (2026-09-10)

## Run 1 — UNBLINDED (labeling leaked; treat ranking as weak evidence)
The dispatch prompt and the required report header both said "Candidate <n>", so each pass
self-identified and the verifier de-anonymized itself (its table reads `Candidate E (Candidate 5)`).
Same-tier best-of-5 (verifier ran on the reviewer role, sharing the session model tier with the
passes) — not asymmetric verification. Anonymization map: A -> candidate 3
B -> candidate 1
C -> candidate 4
D -> candidate 2
E -> candidate 5

Overall correctness (verifier self-report): correct · Confidence: 1

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

---

## Run 2 — BLIND (identity markers stripped, new randomized mapping)
Every `candidate <n>` / `pass <n>` token was stripped from the five reports and they were re-assembled
under a fresh mapping, so this ranking is content-only. Same-tier best-of-5 still applies.
Mapping: A -> source pass 4
B -> source pass 1
C -> source pass 5
D -> source pass 3
E -> source pass 2

Ranking robustness vs Run 1: winner, runner-up and last place are identical across both runs
(source passes 5, 1 and 2); only the two middle passes swap adjacent ranks (3 and 4). The ranking is
therefore not an artifact of the leaked labels, but it remains same-tier evidence — the union of
findings, not the ranking, is the deliverable.

## Scoring

| Pass | Coverage (1-20) | Evidence Quality (1-20) | Signal Density (1-20) | Pathology Accuracy (1-20) | Gap Honesty (1-20) | Total (/100) |
|---|---|---|---|---|---|---|
| **PASS C** | 20 | 20 | 20 | 19 | 19 | **98** |
| **PASS B** | 19 | 19 | 19 | 19 | 19 | **95** |
| **PASS D** | 19 | 19 | 18 | 19 | 18 | **93** |
| **PASS A** | 18 | 17 | 18 | 17 | 17 | **87** |
| **PASS E** | 16 | 12 | 14 | 13 | 15 | **70** |

### Scoring Rationale

- **PASS C (98/100)**: Premier pass. Unearthed high-impact architectural landmines missed by others: synchronous `ArtifactStore` startup rehydration on Electron main thread with `enableRetentionCleaner` dead in code (`artifact-store.ts:70,71`), dev bridge port 20130 vs MCP default 20129 mismatch producing silent zero-tool agent sessions (`bridge-server.ts:245` vs `antifan-omp-mcp.cjs:76`), `run-antifan.vbs` running stale code silently due to boolean `fs.existsSync` check in `main.cjs:15-25`, and omitted test suites in `src/` and `.cjs`. Exact verified counts: 57 root PNGs, 76 script files + 3 subdirs.
- **PASS B (95/100)**: Exceptionally rigorous. Discovered that 10 test files in `test/main` string-pin `native-tab-host.ts` via `fs.readFileSync` and multiline regexes (`ipc-audit.test.ts:9-12,401-405`), directly penalizing refactoring of the 6,750-line host file. Accurately audited `.antifan/annotations` (1,428 unpruned markdown files) and verified that `artifact-retention-cleaner.ts:44` only sweeps `*.artifact`. Correctly identified that `.canary/CORE-BOTTLENECKS.md` defects D1–D5/F8/F9 were historical and closed. Minor flaw: root PNG count was 62 (5 over the verified 57).
- **PASS D (93/100)**: High engineering insight. Root-caused background tab capture stalls to `security-policy.ts:137` (`backgroundThrottling: true`), corroborating it with in-repo architectural analysis (`plans/reports/brainstorm-260905...:34`). Discovered `test/renderer/terminal-gap-state-machine.test.ts` is omitted from `package.json` test scripts. Explicitly confirmed prior canary defects D1–D5 closed at HEAD. Root PNG count was 56 (1 off).
- **PASS A (87/100)**: Strong structural quantification of the cold compilation graph (16 npm scripts + 7 code call sites) and detailed code-level profiling of `computePixelDiff` (`browser-control-port.ts:5862-5958`, per-pixel linear mask scan and `Math.sqrt` loops). Exact 57 root PNG count. Penalized for presenting historical `.canary/CORE-BOTTLENECKS.md` §F3/F4/F7 in B5 as active live bottlenecks without noting F3 and F7 were resolved at HEAD.
- **PASS E (70/100)**: Lowest quality. Promoted historical canary finding F4 (`Page.captureScreenshot did not settle within its bound`) to headline blocking bottleneck B2, despite commit `7d0850b` and code showing D1–D5 resolved. Hallucinated root PNG count as 25 (actual is 57). Relied on generic code-size smells in B5 ("god modules make every change expensive to reason about") rather than actionable pathology.

---

## Ranking

1. **PASS C** (Rank 1): Best technical depth and discovery of silent failure modes (sync `ArtifactStore` scan, MCP port 20129/20130 desync, shortcut stale execution, omitted test files).
2. **PASS B** (Rank 2): Best analysis of refactoring barriers (tests pinning `native-tab-host.ts` source text) and unpruned annotation storage, with accurate historical context.
3. **PASS D** (Rank 3): Best diagnosis of runtime capture throttling (`backgroundThrottling: true`) and orphaned terminal gap tests, backed by in-repo post-audit documentation.
4. **PASS A** (Rank 4): Best build-graph call site audit (23 compile sites) and pixel-diff CPU analysis, but docked for misattributing historical canary findings.
5. **PASS E** (Rank 5): Significant hallucination and misattribution of historical F4 as an active blocker, inaccurate workspace counts, and generic code-size complaints.

---

## Final Union of Bottlenecks

### 1. Cold Full-Project Rebuild on Every Compile & File-Wipe Race Condition Under Live Consumers
- **Severity**: P0 (Blocker)
- **What it is**: `package.json:18` defines `"clean": "node -e \"fs.rmSync('.compiled',{recursive:true,force:true})\""`. `compile` (`:21`) always executes `clean` first. `tsconfig.json` specifies `"include": ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"]` with no `"incremental": true` and no `"tsBuildInfoFile"`. Every compilation is a cold typecheck and emit of 124k LOC (647 files). Furthermore, 16 npm scripts (`package.json:37,39-47,50,51,53-56`) and 7 code call sites (`main.cjs:25`, `run-electron.cjs:24`, `dev.mjs:129`, `install-windows-shortcut.mjs:38`, `certify-core-freeze.cjs:25`, `benchmark-electron-performance.mjs:506,508`) invoke `compile`.
- **Why it blocks**: Wiping `.compiled` while `npm run dev` and `tsc --watch` are running destroys files the active Electron process and preload scripts are actively loading, inducing intermittent `ENOENT` crashes (`plans/reports/brainstorm-260905...:33`). Devs cannot run `npm test` or smoke scripts without killing their live dev session.
- **Concrete Fix**:
  1. Remove `npm run clean` from `package.json` `"compile"`; make `clean` a standalone manual command.
  2. Enable `"incremental": true` and `"tsBuildInfoFile": ".compiled/.tsbuildinfo"` in `tsconfig.json`.
  3. Split test files into `tsconfig.test.json` so dev compile only builds `src/`.
  4. Make smoke scripts reuse the existing `.compiled` output without prepending `npm run compile`.

### 2. Main-Process Changes Force Cold Electron Kill & Relaunch (Hot-Swap Branch is Dead)
- **Severity**: P0 (Blocker)
- **What it is**: In `scripts/dev-watcher-helpers.mjs:39-45`, `isHotSwappable` strictly matches `/^scripts\/cdp\/([^/]+)\.source\.js$/i`. The directory `scripts/cdp` is completely empty (0 files) and only recreated empty by `dev.mjs:34-36`. `isUiHotSwappable` (`:229-232`) strictly matches `src/renderer/**`. Any edit to `src/main/**` (including `native-tab-host.ts`, `browser-control-port.ts`, `browser-capabilities.ts`) evaluates both to `false` and falls through to `relaunchElectron()` (`:420-424`): `taskkill /pid <pid> /T /F`, fixed 800 ms Windows mutex sleep, and respawn, gated by 1200 ms debounce (`dev.mjs:203`).
- **Why it blocks**: Editing a single line in any main-process module destroys the live Electron process, dropping all open storefront tabs, DevTools inspections, agent sessions, and terminal PTYs.
- **Concrete Fix**:
  1. Remove the dead `scripts/cdp` hot-swap check.
  2. Wire the existing soft-reload transport (`antifan.system.reloadScripts` in `bridge-server.ts:2334`) for stateless/leaf modules in `src/main/tools/*` and `src/main/verification/*`.
  3. Lower debounce from 1200 ms to 300 ms.
  4. Preserve tab session state across relaunches via `split-review-coordinator.ts` persistence.

### 3. ArtifactStore Constructor Synchronously Scans and Parses Entire Historical Artifact Directory at Startup
- **Severity**: P1 (High)
- **What it is**: `src/main/tools/artifact-store.ts:70` invokes `this.rehydrateIndex()` synchronously inside its constructor. Lines 97–133 iterate over every directory in `options.root` with `readdirSync`, stats every `.artifact` file, and synchronously reads and JSON-parses every `index.json`. Live storage in `E:/Work/.antifan-data/control-plane-v2/artifacts/` contains over 1,226 run directories. Simultaneously, `enableRetentionCleaner` (`artifact-store.ts:48,71`) is NEVER passed by any caller in `src/` (`control-plane-runtime.ts:125`, `index.ts:235`), rendering the retention cleaner dead.
- **Why it blocks**: Blocks the Node/Electron main event loop during application startup, with freeze time scaling monotonically with every run created on the machine.
- **Concrete Fix**:
  1. Make `rehydrateIndex()` lazy (index loaded on demand per `runId`).
  2. Pass `enableRetentionCleaner: true` in `index.ts:235` and configure default LRU sweep limits.
  3. Run index parsing asynchronously off the main event loop.

### 4. Background Tab Throttling Stalls Dual-Plane Visual Compare and Capture
- **Severity**: P1 (High)
- **What it is**: `src/main/security/security-policy.ts:137` sets `backgroundThrottling: options?.backgroundThrottling ?? true`. For offscreen or background tabs (the secondary tab during dual-plane visual compare or storefront clone verification), Chromium throttles timers, rendering, and `requestAnimationFrame`. Documented as an unaddressed P0 root cause in `plans/reports/brainstorm-260905...:34`.
- **Why it blocks**: Background tabs fail to settle or render in time during automated capture passes, causing `TARGET_STALE` errors, blank screenshots, or 30–60 s timeout freezes.
- **Concrete Fix**: Implement scoped unthrottling: pass `backgroundThrottling: false` specifically for tabs holding an active agent lease or capture transaction in `security-policy.ts` and `browser-control-port.ts`.

### 5. Test Suite is a 4.5-Minute Serial Monolith and Fragile Tests String-Pin Host Source Code
- **Severity**: P1 (High)
- **What it is**: `test:main` runs 128 test files serially taking 261–270 s (`.canary/state/main-followup2.log:1714`). There is no script to run a single test file. Furthermore, 10 files in `test/main` read `src/main/browser/native-tab-host.ts` as raw text via `fs.readFileSync` and assert literal string and regex patterns (`ipc-audit.test.ts:9-12,401-405`, `split-view-fixes-regression.test.ts:46-49`, `terminal-switching-regression.test.ts:698-701,770-773`, `preview-protocol-and-watcher.test.ts:161-164`).
- **Why it blocks**: Refactoring, splitting, or formatting `native-tab-host.ts` breaks unrelated regression tests that expect exact source code regex matches. Developers must wait 4.5 minutes to discover text-matching breakage.
- **Concrete Fix**:
  1. Add `"test:file": "node --test --test-force-exit"` to `package.json`.
  2. Replace raw `fs.readFileSync` source-code assertions in `ipc-audit.test.ts` with behavioral tests against the IPC contract / `MockTabHost`.

### 6. Test Gates Silently Skip Critical Regression and E2E Tests
- **Severity**: P1 (High)
- **What it is**:
  - `test/renderer/terminal-gap-state-machine.test.ts` (verifying terminal chunk-loss prevention) exists on disk but is not matched by any glob in `package.json`.
  - Three tests in `src/main/` (`browser-control-port-zero-network.test.ts`, `zero-network-interceptor.test.ts`, `network-policy.test.ts`) emit to `.compiled/src/` but `package.json` only globs `.compiled/test/**`.
  - `test:e2e` globs `**/*.test.js`, silently skipping `.cjs` test harnesses (`terminal-rename-space.test.cjs`, `terminal-transport-sync.cjs`, `terminal-recovery-smoke.cjs`, etc.).
- **Why it blocks**: `npm test` reports green while silently skipping crucial P0 regression tests.
- **Concrete Fix**: Move `src/main/**/*.test.ts` to `test/main/`; add `test/renderer/**/*.test.js` to `test:fast`; add a glob pattern covering `.cjs` test harnesses in `test:e2e`.

### 7. Dev Port 20130 vs MCP Default Port 20129 Causes Silent Zero-Tool Agent Sessions
- **Severity**: P1 (High)
- **What it is**: `src/main/bridge/bridge-server.ts:245` dynamically remaps port: `this.port = isDev && port === 20129 ? 20130 : port`. However, `scripts/antifan-omp-mcp.cjs:76` defaults to `parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10)`. Ambient disk discovery is disabled by dual-plane security design.
- **Why it blocks**: Any MCP client or agent session launched without explicitly setting `ANTIFAN_MCP_PORT=20130` attempts connection to 20129, receives no response or credentials, and fails closed with an empty tool list and no diagnostic error.
- **Concrete Fix**: In `scripts/antifan-omp-mcp.cjs`, read `bridge-dev.json` from `StorageLocations.getConfigDir()` in development mode as a fallback port resolver.

### 8. Capability Surface Fragmented Across Three Hand-Maintained Registries with Excessive Timeouts
- **Severity**: P2 (Medium)
- **What it is**: Capabilities are defined across `src/main/tools/browser-capabilities.ts` (~153 registrations with ~72 aliases), `src/main/mcp/mcp-server.ts:769-810` (dynamic alias synthesis), and `scripts/antifan-omp-mcp.cjs:10-61` (52 tool definitions + manual `CAPABILITY_MAP` at `:258-299`). Furthermore, `CLIENT_TIMEOUT_MS` in `antifan-omp-mcp.cjs:306-316` sets client budgets up to 240,000 ms (4 minutes) for visual compare.
- **Why it blocks**: Adding or modifying any tool requires coordinated edits in three files. When an operation hangs, client agents burn up to 4 minutes waiting for timeout.
- **Concrete Fix**: Derive MCP tool definitions and alias mappings directly from `CapabilityCatalogue` programmatically; clamp client timeouts close to server-side policy bounds (30–45 s).

### 9. Synchronous In-Process Pixel Diffing Saturates Main Thread CPU
- **Severity**: P2 (Medium)
- **What it is**: `src/main/tools/browser-control-port.ts:5862-5958` (`computePixelDiff`): For images up to 1440×5715 (8.2M pixels), it runs a nested JS loop executing an un-indexed linear scan over `maskBoxes` (`isMasked`), followed by `Math.sqrt` per pixel, and an 8-neighbor pass with multiple `Math.sqrt` calls for differences.
- **Why it blocks**: Freezes Electron's main process UI during visual comparisons, delaying IPC handling and window responsiveness.
- **Concrete Fix**: Pre-calculate a 1D boolean mask buffer to replace `isMasked` with an $O(1)$ index lookup; use squared Euclidean color distance ($(\Delta R)^2 + (\Delta G)^2 + (\Delta B)^2 > T^2$) to eliminate `Math.sqrt` in the inner loop.

### 10. Launcher Inconsistencies on `--allow-eval` and Stale Shortcut Execution
- **Severity**: P2 (Medium)
- **What it is**: `src/main/index.ts:68-71` gates `ALLOW_EVAL` on CLI flag `--allow-eval` or env var `ANTIFAN_ALLOW_EVAL`. `npm start` (`package.json:23`) omits the flag. `run-antifan.vbs` passes `--allow-eval` directly to Electron, but `main.cjs:15-25` only triggers compilation if `.compiled/src/main/index.js` is completely missing (`!fs.existsSync`), never checking file modification times.
- **Why it blocks**: Launching via `npm start` silently strips eval capabilities. Launching via desktop shortcut silently executes stale code without recompiling after edits.
- **Concrete Fix**: Add mtime comparison in `main.cjs` to warn or recompile if `src/**` is newer than `.compiled`; align `npm start` arguments with `dev.mjs`.

### 11. Dev Lock Stalls and Indiscriminate Process Kill Script
- **Severity**: P2 (Medium)
- **What it is**: `scripts/dev.mjs:36-53` acquires `node_modules/.cache/antifan-dev.pid`. When a process terminates abruptly, PID recycling or stale files cause startup failure requiring manual `taskkill`. Meanwhile, `scripts/kill-all.mjs:5` runs `taskkill /F /IM electron.exe`, which forcibly kills all Electron applications across Windows (including VS Code, Discord, Slack) while failing to kill the node watcher or delete the lock file.
- **Why it blocks**: Developers must manually troubleshoot lock conflicts, or run a kill script that crashes their entire desktop workspace.
- **Concrete Fix**: Update `kill-all.mjs` to target AntiFan PIDs specifically, clear `antifan-dev.pid`, and add an automatic `--force` takeover flag to `dev.mjs`.

### 12. Unbounded Growth of Annotation Storage and Dead Legacy Profiles
- **Severity**: P3 (Low)
- **What it is**: `.antifan/annotations/` accumulates 1,430 markdown files written by `annotation-manager.ts:159-179,349-351` that are never swept by `artifact-retention-cleaner.ts`. `appdata/` contains 1.9 GB across 7 profile trees from legacy migrations, and `out/` contains 699 MB from obsolete pre-rename builds.
- **Why it blocks**: Wastes disk space and slows down file tree traversals and backup tools.
- **Concrete Fix**: Extend `artifact-retention-cleaner.ts` to include `.antifan/annotations` and `.antifan/snapshots`; delete dead `appdata/` and `out/` trees.

---

## Dropped Findings

1. **Pass E B2 (`Render-dependent capability calls burn 10–60 s bounds instead of failing`)**:
   - **Reason Dropped**: Stale historical finding. Pass E cited `.canary/CORE-BOTTLENECKS.md:82-96` (F4). As established by commit `7d0850b` and the tail of `CORE-BOTTLENECKS.md`, core defects D1–D5 (render-surface fail-fast, verified viewport writes, truthful session tab listing, capture geometry as a transaction, reference capture with materialization) and F8/F9 were resolved. The active 2026-09-10 plan (`plans/260910-2008...`) confirms the live canary blocker was `domSettled` childList churn and the CDP 16384px ceiling, not F4 draining.
2. **Pass A B5 (historical §F3/F4/F7 citations from `CORE-BOTTLENECKS.md`)**:
   - **Reason Dropped**: F3 (`browser.set-viewport` 0x0) was fixed with verified viewport writes in `anti.browser.set_viewport` (`browser-capabilities.ts:787-795`). F7 viewport timeout was fixed with `NO_RENDER_SURFACE` fail-fast in `browser-control-port.ts:1526-1548`. The retained part of Pass A B5 is the verified in-process CPU loop of `computePixelDiff`.
3. **Pass E B5 (`God modules make every change expensive to reason about`)**:
   - **Reason Dropped**: Pure code-size smell (`native-tab-host.ts` 6,750 lines, `browser-control-port.ts` 6,034 lines). The actual actionable bottlenecks caused by module size are test string-pinning and cold-relaunch overhead (captured in items 2 and 5).
4. **Pass C B10 (`Chromium caps: renderer-process-limit=4 and process-per-site`)**:
   - **Reason Dropped**: These switches are intentional low-spec hardware hardening constraints for the i5-9300H CPU defined in `plans/260830-1903`. There is no evidence of multi-tab renderer crashes in normal local operation.
5. **Pass E B9 (`Duplicated verification ceremony in certify-core-freeze.cjs`)**:
   - **Reason Dropped**: Non-bottleneck ceremony. `certify-core-freeze.cjs` is not part of the daily inner dev or test loop (`package.json:52`); it is only run on demand during freeze gates.

---

## Unresolved Questions

1. **Exact compile wall-time on workstation hardware**: In read-only mode without executing commands, the exact duration of `npm run compile` and `npm run verify` on this Intel i5-9300H machine cannot be timed. The structural overhead (cold 124k LOC compile with 4GB heap) is verified, but exact seconds remain `[INFERENCE]`.
2. **Failure mode of `fs.rmSync('.compiled')` under live `tsc --watch` on Windows NTFS**: While the race condition is documented in-repo (`plans/reports/brainstorm-260905...:33`), the exact frequency of file-locking errors (`EPERM`/`EBUSY`) when `clean` deletes directories actively watched by Windows file system handles was not exercised in read-only mode.
3. **Active utility of root `*.png` artifacts**: Whether any personal dev workflow or historical documentation references the 57 loose `.png` files in the repository root, or whether they are all safe to purge immediately.
4. **Startup latency impact of `.antifan-data/control-plane-v2/artifacts/`**: The exact startup delay (in milliseconds) caused by `ArtifactStore.rehydrateIndex()` traversing the 1,226 run directories on disk cannot be profiled without launching Electron with telemetry probes.
