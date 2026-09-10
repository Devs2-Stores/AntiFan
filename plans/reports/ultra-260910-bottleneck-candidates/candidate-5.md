# Scout Report — Candidate 5

## Packet corrections (verified against live repo)
- `scripts/` holds **76** files (not 71), 3 of them subdirs (`cdp/`, `native-host-shim/`, `probes/`).
- Root loose `*.png` = **57** (not ~20), plus `e2e-fail.log`, `e2e-results.log`, `probe.js`, `trees_all.txt`, `smoke-result.json`, `smoke-result-settings.json`.
- Confirmed: `git status` clean because `.gitignore` drops `*.png`, `*.log`, `probe.js`, `trees_all.txt`, `out/`, `.canary/`, `appdata/`, `.antifan/`. The clutter is invisible to git and therefore never cleaned.
- `appdata/` and `plans/` MB figures not re-measured (no shell available); verified structurally instead. Everything else below is measured.

## Relevant Files
- `package.json` — the entire script graph; where compile/clean redundancy lives
- `scripts/dev.mjs` — blocking cold compile + Electron relaunch loop
- `scripts/dev-watcher-helpers.mjs` — hot-swap classifier, debounce, dev lock
- `tsconfig.json` — compiles `src` + `scripts` + `test` as one project
- `main.cjs`, `run-antifan.vbs`, `scripts/run-electron.cjs` — three launch paths
- `src/main/tools/artifact-store.ts` — synchronous startup scan of unbounded artifact dir
- `src/main/index.ts` — startup order, Chromium switches, data-root wiring
- `src/main/bridge/bridge-server.ts` — dev/prod port split
- `scripts/antifan-omp-mcp.cjs`, `src/main/mcp/mcp-server.ts`, `src/main/tools/capability-catalogue.ts` — three parallel tool registries
- `src/main/browser/profile-ownership.ts` — legacy profile probing / migration
- `scripts/certify-core-freeze.cjs`, `scripts/audit-core-purity.ts` — verification ceremony

## Bottlenecks (ranked)

### B1. Cold full-project compile is the atomic unit of every loop [blocking]
- Evidence: `package.json:26` — `compile = clean && build-native-host-shim && tsc -p ./ && copy-static && build-extension`. `tsconfig.json:20` includes `src/**/*.ts` **and** `scripts/**/*.ts` **and** `test/**/*.ts`. Measured LOC in that scope: src/main 62,121 + test (41,474 main / 10,532 unit / 2,763 e2e) + src/renderer 10,892. `npm run compile` is a **cold** build every time: `clean` (`package.json:24`) `rmSync('.compiled')` before tsc, and no `incremental`/`tsBuildInfoFile` in `tsconfig.json` — so no cache survives. `scripts/dev.mjs:150` runs `execSync('npm run compile')` **blocking**, before `tsc --watch` is even spawned (`dev.mjs:186`) and before Electron launches (`dev.mjs:153`).
- Why it blocks: a solo dev cannot type a change until a full 114k-LOC emit completes; `--max-old-space-size=4096` at `dev.mjs:185` shows the compiler already needs 4 GB on a 4-core box. Editing a test file forces re-emit of the app, and vice versa.
- Fix: add `"incremental": true` + tsbuildinfo; split `compile:app` (src only, excludes `test/**`) from `compile:all`; drop `clean` from `compile` (keep a separate `clean`); have `dev.mjs` start `tsc --watch` first and launch Electron against the existing `.compiled`.

### B2. Any `src/main/**` edit is a hard Electron restart [high]
- Evidence: `dev-watcher-helpers.mjs` `isHotSwappable` matches only `^scripts/cdp/<name>\.source\.js$`; `isUiHotSwappable` matches only `^src/renderer/[^/]+\.(css|html|js|ts)$`. Everything else falls through `handleBatch` to `await relaunchElectronFn()` ("Detected non-UI or main-process change … restarting Electron"). `dev.mjs:113-134` implements that as `taskkill /pid <pid> /T /F` + a fixed **800 ms** sleep for the Windows mutex + respawn; `dev.mjs` sets `debounceMs: 1200`.
- Why it blocks: `src/main` is 62,121 LOC across 48 files including `native-tab-host.ts` (6,749) and `browser-control-port.ts` (6,033) — that is where the real work is. Every save costs ≥2 s of teardown plus total loss of tabs, PTY sessions, page state and open DevTools. The hot path covers two narrow file classes.
- Fix: the soft-reload transport already exists (`antifan.system.reloadScripts`, dev-gated in `bridge-server.ts:2334`). Extend the hot set to pure/leaf modules under `src/main/verification/**`, `src/main/qa/**`, `src/main/tools/*-capabilities.ts`, leaving only `index.ts`/`native-tab-host.ts` on the cold path.

### B3. `ArtifactStore` constructor synchronously scans an unbounded, never-pruned artifact tree [high]
- Evidence: `artifact-store.ts:70` calls `rehydrateIndex()` from the constructor; `:97-133` does `readdirSync(root, {withFileTypes:true})` → for **every** `run-*` dir `readdirSync(runDir)` + `statSync` per `.artifact` file + `readFileSync` + `JSON.parse(index.json)`. Live state at `E:/Work/.antifan-data/control-plane-v2/artifacts/`: a single directory listing of just the first level ran **1,226 lines** and contains hundreds of `run-<uuid>/` dirs, `index.json` files up to 157 KB, and individual `.artifact` files to 2.8 MB. The cleaner exists (`artifact-retention-cleaner.ts:17`) but `enableRetentionCleaner` (`artifact-store.ts:48,71`) is **passed by nobody** — the only other reference in the whole of `src/` is the option's own declaration. `index.ts:235` passes only `resolveArtifactStoreOptionsFromEnv()`.
- Why it blocks: this runs on the Electron main thread during startup, before the window is usable, and its cost grows monotonically with every session. It is the one bottleneck that gets worse the more you use the app.
- Fix: pass `enableRetentionCleaner: true` from `resolveArtifactStoreOptionsFromEnv`, cap retained runs (keep newest N per workspace), and make rehydrate lazy per-`runId` instead of eager for all runs.

### B4. `verify`/`npm test` compiles the project twice and still skips tests [high]
- Evidence: `package.json:37` — `test = clean && compile && test:fast && test:site-clone && test:integration && test:main && test:e2e`. `clean` is executed twice (line 37 then again inside `compile`, line 26). `package.json:38` — `verify = typecheck && test`, i.e. a full `tsc --noEmit` (line 34) followed by a full emitting `compile`: **two complete compiles of 114k LOC**, then `build:site-clone` plus 5 test groups including `test:e2e` which boots Electron. Coverage is also not what it claims: `test:unit` (line 36) = `test:fast` + integration + benchmark, a strict superset of two other scripts in the same chain.
- Never-runnable tests confirmed: `src/main/tools/browser-control-port-zero-network.test.ts`, `src/main/browser/zero-network-interceptor.test.ts`, `src/main/browser/network-policy.test.ts` compile into `.compiled/src/**` (visible: `.compiled/src/main/tools/browser-control-port-zero-network.test.js`, 40m ago) but **no npm glob points at `.compiled/src/**`** (grep for `compiled/src` in `package.json` → no matches). `test/e2e/terminal-rename-space.test.cjs` cannot run either: `test:e2e` globs `.compiled/test/e2e/**/*.test.js`.
- Fix: drop the duplicate `clean`; give `verify` a single `compile` plus a `--noEmit` pass over already-emitted output; add `.compiled/src/**/*.test.js` to `test:main` (or move those 3 files to `test/main/`); widen the e2e glob or rename the `.cjs` probe.

### B5. Fourteen smoke/test scripts each recompile the world from cold [high]
- Evidence: `package.json:40-56` — `smoke:split`, `smoke:theme-qa`, `smoke:persistence`, `smoke:google`, `smoke:cdp`, `smoke:owned-cdp`, `smoke:cdp-queue`, `smoke:vault`, `smoke:soak`, `smoke:theme-golden-live`, `smoke:multitasking`, `smoke:parity`, `smoke:terminal`, `test:terminal-transport` — **14** entries begin with `npm run compile`. `certify-core-freeze.cjs:33-42` additionally runs `npm run compile` internally, despite `certify:core-freeze` (line 52) not being prefixed with it.
- Why it blocks: verifying one behavior at a time costs a full cold build each invocation; five checks in a session = five full compiles.
- Fix: make smoke scripts assume a current `.compiled` (with an explicit `smoke:compile` prerequisite) or gate on an mtime/hash check against `src/**`.

### B6. The shortcut launch path runs stale code silently [medium]
- Evidence: `run-antifan.vbs:2-3` launches `node_modules\electron\dist\electron.exe` with the repo path and `--allow-eval`, bypassing `dev.mjs` entirely (no dev singleton lock, no reload, no compile). `main.cjs:15-25` auto-compiles **only** `if (!fs.existsSync(compiledMain))` — a pure existence check, never a staleness check.
- Why it blocks: the loop "edit → double-click shortcut → wonder why nothing changed" has no signal. `main.cjs` prints a friendly auto-compile line, which actively implies freshness.
- Fix: in `main.cjs`, compare max mtime of `src/**` against `.compiled/src/main/index.js` and either recompile or print a loud stale-build banner; or make `run-antifan.vbs` call the same entrypoint as `npm run dev`.

### B7. Dev port 20130 vs MCP default 20129 gives silent zero-tool sessions [medium]
- Evidence: `bridge-server.ts:178` `port = 20129`; `:245` `this.port = isDev && port === 20129 ? 20130 : port`. `antifan-omp-mcp.cjs:76` `parseInt(process.env.ANTIFAN_MCP_PORT || '20129', 10)`, and `resolveBridgeCandidates()` returns `[]` unless `ANTIFAN_MCP_BOOTSTRAP` or `ANTIFAN_ATTACHMENT_SECRET` is set — on-disk discovery is enabled **only** with terminal context env (`ANTIFAN_TERMINAL_*`, `ANTIFAN_BRIDGE_PID`).
- Why it blocks: any agent session not spawned from an AntiFan terminal while the dev app is running fails closed with no tool list and no hint why. The failure looks like "MCP is broken", not "you are 1 port off".
- Fix: the app already writes `bridge-dev.json` (`E:/Work/.antifan-data/config/bridge-dev.json`, 312 B, 1h ago); let the proxy, in dev only, read that single file as a fallback candidate instead of hardcoding 20129.

### B8. Same tool surface defined in three registries, with 2–3 aliases each [medium]
- Evidence: `scripts/antifan-omp-mcp.cjs:9-62` — 52 hand-written definitions. `src/main/mcp/mcp-server.ts:89-505` — a second hand-written list, plus `:769-810` a generated alias table where one entry emits several names (e.g. `antifan_set_viewport` → `anti.browser.viewport.set` **and** `anti.browser.set_viewport`; `antifan_agent_hover` → three names). `capability-catalogue.ts:72-77` is a third registry with its own validation.
- Why it blocks: adding one capability is a 3-file, alias-consistent edit, and the live surface ships both `anti.*` and the legacy `mcp__antifan_browser_*` spelling of every tool.
- Fix: generate the MCP `definitions` array from `CapabilityCatalogue` at build time; keep the alias table as data, not a hand-maintained `if` ladder.

### B9. Three data roots; 1.9 GB of the biggest is unreachable dead weight [medium]
- Evidence: canonical root is `StorageLocations.getDataRoot()` → first writable of `E:/Work/.antifan-data`, `E:/.antifan-data`, `D:/Work/.antifan-data`, else `%APPDATA%/AntiFan/data` (`storage-locations.ts:41-70`), with a mkdir **and a write/unlink probe per candidate**. A second root is repo-local: `profile-ownership.ts:190-205` lists `appdata/AntiFan/Chromium{,-dev,-prod}`, `appdata/antifan-browser-desktop/*`, `appdata/antigravity-browser-desktop/Chromium-dev`; `package-windows.mjs:45` ignores `/^\/appdata/`, confirming it is app-owned. `index.ts:85-90` passes `canonicalPath: StorageLocations.getProfileDir()`; `profile-ownership.ts:180` returns immediately when the canonical profile has state — `E:/Work/.antifan-data/Profile` does (`antifan-profile.lock` 1h ago, `saved-tabs.json` 6.3 KB, `Network/`), so the probe list is never read.
- Result: `appdata/` (Chromium, Chromium-dev, Chromium-dev-test, Chromium-prod, three `*-cache` trees, a full `antigravity-browser-desktop/` legacy tree, `antifan-test-new-instance*`, `google-auth-live-profile`, `google-auth-live-probe`) survives only as a migration source that can no longer be reached — ~14 profile/cache trees untouched for 1–3 weeks.
- Fix: after confirming launch still works, delete `appdata/`; then prune `candidatePaths` in `profile-ownership.ts` to the two entries that could still matter.

### B10. Chromium caps tuned below this machine's useful parallelism [medium]
- Evidence: `index.ts:119` `renderer-process-limit=4` on an i5-9300H (4C/8T); `:120` `process-per-site`; `:121-122` disk cache 128 MB / media 64 MB; `:123` `disable-gpu-memory-buffer-video-frames` on Intel UHD 630; `:124` one combined `enable-features` switch (any later `appendSwitch('enable-features', …)` would silently clobber all five features).
- Why it blocks: the core workflow is multi-tab storefront QA plus a terminal plus toolbar/sidebar renderers. `renderer-process-limit=4` with `process-per-site` means several same-origin storefront tabs share one renderer and one crash takes them all.
- Fix: raise to 8 on this box or drop the switch; move feature flags into a later appended `enable-features` call that cannot clobber the first.

## Smells (not bottlenecks)
- 57 loose PNGs + `e2e-fail.log`/`e2e-results.log`/`probe.js`/`trees_all.txt`/`smoke-result*.json` at root — all gitignored, so nothing prompts cleanup; they only slow naive root scans.
- Three overlapping report sinks: 12 loose root `*.md` reports + `AntiFan_vs_Orca_Terminal_Chromium_Report.docx`, `reports/` (21 md + 2 stray compiled CSS files `home-CW7DK4JA.css`, `app-DCc2d3nB.css`), and `plans/reports/` (≥65 md including 5-way `ultra-*-candidate-N.md` sets).
- `scripts/` contains npm-unreferenced one-offs, including a **source-mutating codemod**: `fix-temp-cleanup.js:33-35` `code.replace(...)` + `fs.writeFileSync(file, code)`. Also `kill-all.mjs:5` `taskkill /F /IM electron.exe` kills *every* Electron process on the machine, not just AntiFan's.
- `.canary/` 955 MB: 10 `run3-attempt*` trees (plus `run3-stale-attempt1`, `run3-attempt-inconclusive`) and `run1/`, `run2/`, `run3/` — 13 full clone copies. Gitignored; no code reads it.
- `out/` 699 MB is orphaned: it contains only `antigravity-browser-desktop-win32-x64/` (215 MB exe) from the pre-rename product, while `package-windows.mjs:26-28` now emits to `artifactsDir` as `AntiFan-Browser-Desktop` / `antifan-browser-desktop.exe`. No script produces `out/` any more.
- `.antifan/annotations/` — 1,572 files (~2 markdown files per element pick) under the bound workspace (`annotation-manager.ts:120-129,349-351`).
- `CLAUDE.md` (37 lines) restates `AGENTS.md` (34 lines) body text despite declaring `@inherits AGENTS.md`; drift is inevitable and nothing pins them together.
- `.compiled` doubles its footprint with `.js.map` for every `.js` (`sourceMap: true`, `tsconfig.json:13`) — including maps for the 3 never-run tests.
- `.antifan-data/config/terminal-sessions.json` 830 KB and `browser-history.json` 2.5 MB are rewritten whole via temp-file + rename (`terminal-manager.ts:490-494`); fine now, linear forever.

## Unresolved Questions
- **Elapsed time of `npm run compile`, `npm test`, `verify`** on this machine: not measured (read-only, no execution permitted). B1/B4/B5 are structural (redundant cold emits, doubled scope, 14 embedded compiles) and provable from files; the wall-clock multiplier is `[INFERENCE]`.
- `plans/` 486 MB and `appdata/` 1,885 MB were not independently re-measured — no shell/`du` available. Verified indirectly (file counts, directory listings, `.gitignore` entries).
- Whether `E:/Work/.antifan-data/baselines/` (85+ `workspace-*` dirs) is enumerated anywhere at startup: `BaselineAuthority.resolve` is strictly workspace-scoped (`baseline-authority.ts:248-256`), so no cross-workspace scan was found — but not every consumer was read, so unbounded baseline growth is reported as a smell, not a bottleneck.
- Whether anything outside `package.json` (external harness, `scripts/probes/`, IDE task) runs the 3 `src/**/*.test.ts` files or `test/e2e/terminal-rename-space.test.cjs`. No such caller found; absence of evidence noted rather than asserted.
- T4 verification-ceremony scripts (`certify-core-freeze.cjs`, `certify-dual-plane`) were inspected only at their heads: `audit-core-purity.ts` is reachable via `golden-slice-e2e.test.ts:29` (so it is not orphaned), but the full dual-plane certification chain was not traced end to end.