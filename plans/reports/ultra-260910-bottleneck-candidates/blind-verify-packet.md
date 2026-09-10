# ULTRA SCOUT — FIVE SANITIZED, UNLABELED PASSES (unordered)
All passes received the same evidence packet. Identity markers were stripped before assembly.


===== PASS A =====
# Scout Report — PASS

## Relevant Files
- `package.json:18,21,37,38` — `clean`/`compile`/`test`/`verify`; 16 scripts invoke `npm run compile`
- `tsconfig.json` — no `incremental`; `include` pulls `src`+`scripts`+`test` (~124k LOC) into one cold program
- `scripts/dev.mjs:34-36,42,109,130,203,226` — watcher: dead `scripts/cdp` path, blocking cold compile, 1200 ms debounce, cold relaunch
- `scripts/dev-watcher-helpers.mjs:39-45,229-232` — `isHotSwappable` / `isUiHotSwappable`: the entire hot-swap surface
- `main.cjs:10-25,40` · `scripts/run-electron.cjs:22-24` — duplicate compile-on-missing preflights
- `src/main/browser/native-tab-host.ts` (280.2 KB) · `src/main/tools/browser-control-port.ts` (272.8 KB) — the two files that dominate `src/main`
- `src/main/tools/browser-control-port.ts:5806-6010` — `computePixelDiff`, per-pixel JS loop with in-loop mask scan
- `src/main/tools/browser-capabilities.ts` — canonical registrations + ~34 alias re-registrations
- `src/main/mcp/mcp-server.ts:594-563,769-802` — second alias layer generated at list time
- `scripts/antifan-omp-mcp.cjs:258-316` — third name table (`CAPABILITY_MAP`, `CLIENT_TIMEOUT_MS`)
- `src/main/index.ts:68-71` — `ALLOW_EVAL` resolution
- `.canary/CORE-BOTTLENECKS.md` (25.7 KB, 31 min old) — live-measured runtime findings F1–F10
- `.canary/state/instance-env.json` — ports 20130/20131, canary restart procedure, eval opt-in rationale
- `.canary/state/main-followup2.log:1707-1714` · `.canary/run3-test-main.log:1675` — measured suite durations
- `out/antigravity-browser-desktop-win32-x64/` — 699 MB stale package with the pre-rename app name

## Bottlenecks (ranked)

### B1. Every compile is a full cold rebuild, and 23 call sites trigger it [high]
- Evidence: `package.json:18` `clean = fs.rmSync('.compiled',{recursive:true,force:true})`; `:21` `compile = clean && build-shim && tsc -p ./ && copy-static && build:extension`. `tsconfig.json` sets no `incremental`/`composite`/`tsBuildInfoFile`, and `include: ["src/**/*.ts","scripts/**/*.ts","test/**/*.ts"]` compiles `src/main` 62,121 + `test/main` 41,474 + `test/unit` 10,532 + `src/renderer` 10,892 LOC in one program. Measured `.compiled/` = 647 files / 10 MB — rebuilt from zero each time.
- 16 npm scripts re-invoke it (`package.json:37,39-47,50,51,53-56`) plus 7 code call sites: `main.cjs:25`, `run-electron.cjs:24`, `dev.mjs:130`, `install-windows-shortcut.mjs:38`, `certify-core-freeze.cjs:25`, `benchmark-electron-performance.mjs:506,508`. `npm run verify` (`:38`) = `typecheck` (cold) then `test` → `compile` (cold) → two full typechecks of 124k LOC.
- Why it blocks: the solo loop is edit → rebuild → smoke. There is no incremental path anywhere; deleting `.compiled` is step 1 of the fast paths too.
- Mitigation: drop `clean` from `compile` (tsc overwrites), add `"incremental": true` + `tsBuildInfoFile`, split the test project out of `tsconfig.json`, and let `smoke:*` reuse an existing build (guard on mtime) instead of forcing one.

### B2. `src/main` edits always cold-relaunch — the only hot-swap branch is unreachable [high]
- Evidence: `dev-watcher-helpers.mjs:43` matches only `/^scripts\/cdp\/([^/]+)\.source\.js$/i`. `scripts/cdp/` is an **empty directory** (verified), and `dev.mjs:34-36` re-creates it at every start — so `allHot` is never true and `sendSoftReload` (`antifan.system.reloadScripts`) never runs. `isUiHotSwappable` (`:229-232`) covers only `src/renderer/**`.
- Everything the dev edits sits outside both predicates: `native-tab-host.ts`, `browser-control-port.ts`, `browser-capabilities.ts` (186.0 KB), `bridge-server.ts` (122.4 KB), `tab-devtools-host.ts` (119.2 KB), `tab-automation-host.ts` (87.7 KB). Those fall to the cold branch → `relaunchElectron()` = `taskkill /pid <pid> /T /F`, fixed 800 ms wait, respawn (`dev.mjs:109`), gated by `debounceMs: 1200` (`dev.mjs:203`).
- Why it blocks: a one-line fix in the 6,749-LOC tab host costs a full Electron restart that drops every open tab and PTY — which `dev.mjs:44-49` itself names as the failure mode it was written to prevent.
- Mitigation: either delete the dead `scripts/cdp` branch, or make the ~6 host/capability modules genuinely re-requirable so the soft-reload path earns its keep. At minimum drop `debounceMs` to ~300 and keep the relaunch only for files that seed main-process singletons.

### B3. One shared `.compiled` dir, wiped under live consumers [high]
- Evidence: consumers of the same dir are (a) the live `tsc --watch` (`dev.mjs:157+`), (b) the running app (`main.cjs:10,40` requires `.compiled/src/main/index.js`), (c) every harness. `.canary/state/instance-env.json` lists `npm run compile` as step 1 of the canary restart, and `.canary/tools/phase4-verify.mjs:2` calls itself "wave 3 owner of the shared `.compiled` build" — i.e. a hand-arbitrated mutex over a build directory.
- Why it blocks: `npm test` or any `smoke:*` while `npm run dev` is up runs `clean` first and deletes the tree the watcher and app are using; conversely `npm start` after a gate pays the synchronous cold compile at `main.cjs:25` before a window exists.
- Mitigation: separate dev output (`.compiled-dev` / `outDir` override on the watch project) from gate output; then `clean` no longer reaches across processes.

### B4. One capability is advertised under up to four names, in three hand-synced tables [high for the agent surface]
- Evidence: `browser-capabilities.ts:1490,1503,1513,1523` register `theme.resolve_product`, `anti.theme.resolve_product`, `storefront.resolve_product`, `antifan_theme_resolve_product` — four names, one behavior. Same shape at `:779/788/1188` (`browser.set-viewport` / `anti.browser.set_viewport` / `antifan_set_viewport`) and `:460/1782/1792/1121` (hover/move). `mcp-server.ts:769-802` then synthesizes a *second* layer at list time (`antifan_agent_click` → `anti.browser.click` + `anti.agent.cursor.click`; hover → 3 names), with a third table in `mcp-server.ts:594-563` mapping them back, and a fourth in `scripts/antifan-omp-mcp.cjs:258-305`.
- Why it blocks: the tool list handed to a client is roughly doubled, and the same name tables must be edited in three files for one rename. The harness prompt I was handed enumerates ~46 routes — that's the alias set, not the capability set.
- Mitigation: one canonical name per capability; keep compatibility names in a single generated list behind a flag, derived from the catalogue instead of re-declared.

### B5. Capture/compare verbs are the slowest operations and fail as timeouts [medium-high]
- Evidence: `antifan-omp-mcp.cjs:306-316` gives `browser.visual_compare` a 240,000 ms and `anti.screenshot.full_page` a 150,000 ms client budget against `DEFAULT_CLIENT_TIMEOUT_MS = 30000`. `computePixelDiff` (`browser-control-port.ts:5913-5958`) walks each of `minW×minH` pixels in a JS loop, calls `isMasked(x,y)` (`:5862-5867`, linear over `[...targetMask.maskBoxes, ...compMask.maskBoxes]`, `:5177`) inside the inner loop, does a `Math.sqrt` per pixel, and a second 3×3-neighbour pass with 6 more `sqrt` per candidate difference. At 1440×5715 (page-12 doc height, `CORE-BOTTLENECKS.md` §F6) that is 8.2 M pixels in the main process.
- Measured on the same machine, 31 min before this pass: `anti.screenshot.viewport` "**times out at the MCP 30 s bound**" and leaves the target draining; `full_page` fails on the *first* attempt with `TARGET_BUSY_DRAINING` (§F3/F4/F7). `.canary/run3/REPORT.md:457` — all 3 viewports `INCONCLUSIVE` (`EXCESSIVE_REFERENCE_DRIFT`, `COMPARE_STATUS_NOT_RESULT`).
- Mitigation: precompute a per-row mask interval table (or merge/validate boxes) and skip masked rows before entering the inner loop; replace `sqrt` comparisons with squared distance; run the neighbour pass only for pixels that already differ.

### B6. `test:main` is a 4.5-minute serial monolith and is the only guard on most contracts [medium]
- Evidence: measured `duration_ms 261444.2423`, 1,077 tests / 179 suites / 0 fail (`.canary/state/main-followup2.log:1707-1714`); 270,199 ms in the run3 tree (`.canary/run3-test-main.log:1675`). Against `test:fast` 7,398 ms and `test:integration` 7,437 ms (`.canary/state/fast-followup2.log:701`, `int-followup.log:47`) — `test:main` is ~35× both combined.
- `package.json:35` globs 129 files (verified by glob: exactly 129 `test/main/*.test.ts`), several at 80.9 KB (`capability-catalogue.test.ts`), 74.7 KB (`visual-compare-mask-ledger.test.ts`), 52.2 KB (`bridge-attachment-dispatch.test.ts`), 47.7 KB (`bridge-server.test.ts`). There is no `test:one`/`test:file` script.
- Why it blocks: any change touching the capability catalogue, bridge, or tab host forces the 4.5-minute run to know whether it broke something — on top of B1's cold compile.
- Mitigation: add `test:file` (`node --test .compiled/test/main/<file>.js`) as a first-class script, and split the two ~80 KB catalogue/mask suites by concern so a targeted run is meaningful.

### B7. 4.6 GB tree: 1.9 GB of abandoned Chromium profiles, 955 MB of duplicated canary clones, 699 MB of a stale package [medium]
- `appdata/` (1885 MB / 10,305 files) contains 7 profile roots; only `antifan-browser-desktop/` is plausibly live, and it alone holds 7 Chromium roots (`Chromium`, `Chromium-dev`, `Chromium-dev-test`, `Chromium-prod`, and three `*-cache`). Dead by name: `antifan-test-new-instance`, `antifan-test-new-instance-cache`, `antigravity-browser-desktop`, `google-auth-live-profile`, `google-auth-live-probe`.
- `.canary/` (955 MB / 4,083 files) holds **12 full trees of the same site** — `run1`, `run2`, `run3`, `run3-attempt1..8`, `run3-attempt-inconclusive`, `run3-stale-attempt1` — each with `clone/ reference/ sections/ diff/ a0-assets/`, plus `15-pages/` with 15 more clones. Per-bundle payload is ~38.5 MB (`.canary/smoke/record.json:20` `assetBytes: 38,493,611`), and every copy repeats `flatsome.js`/`jquery-min.js`/`dashicons.ttf`/`fa-solid-900.woff2` (visible in `15-pages/*/clone/assets/`).
- `out/` 699 MB is three weeks old **and unfixably stale**: `out/antigravity-browser-desktop-win32-x64/antigravity-browser-desktop.exe` (215.1 MB) while the package is now `antifan-browser-desktop` (`package.json:2`). `out/make/squirrel.windows/x64` is likewise dead.
- Root: **57** loose `*.png` (packet says ~20) including ten 2.4-3.8 MB `diff_*.png`, ~46 MB total; 15 loose `*.md`; `trees_all.txt` 896.4 KB.
- Mitigation: delete `out/` and the 5 dead profile roots (both regenerable); keep `run3` + `15-pages` and retire `run1`/`run2`/`run3-attempt*`; move root PNGs under `.canary/` where `.gitignore` already covers them.

### B8. Launch paths disagree on `--allow-eval`, so capabilities vanish by launcher [medium]
- Evidence: `src/main/index.ts:68-71` — `ALLOW_EVAL = !ANTIFAN_CLOUD_HOSTED && (--allow-eval | --mcp-high-risk || (!IS_CI && ANTIFAN_ALLOW_EVAL))`. `.canary/state/instance-env.json` records that the dev shell exports `CI=true`, disabling the env path, leaving the **flag** as "the only reproducible opt-in". Four launchers: `npm run dev -- --allow-eval` (forwarded at `dev.mjs:29-31` via `resolveElectronArgs`, `dev-watcher-helpers.mjs:22-25`); `run-antifan.vbs` (raw `electron.exe … --allow-eval`, hidden window, no watcher); `npm start` = `scripts/run-electron.cjs .` (`package.json:23`, **no flag**); canary (explicit flag).
- Why it blocks: `npm start` produces an app where eval/write capabilities are simply absent from the tool list — a missing tool with no error, which reads as a bug in whatever the dev was testing.
- Mitigation: one launcher for development with the flag defaulted on, and log the resolved `ALLOW_EVAL` at startup.

### B9. Compile-on-missing is implemented four times [low-medium]
- Evidence: `dev.mjs:130` (startup), `main.cjs:25` (app entry), `run-electron.cjs:24` (e2e launcher), and each `smoke:*` preflight. Because B1's `compile` begins with `clean`, each of these is a **full delete-and-rebuild**, and `main.cjs` runs it synchronously before the window can appear.
- Mitigation: make the fallback `tsc -p ./` (or a `build:check`), not the full `compile`.

## Smells (not bottlenecks)
- `scripts/kill-all.mjs:5` — `taskkill /F /IM electron.exe` kills every Electron app on the machine, not just AntiFan.
- `npm test` (`package.json:37`) runs `npm run clean` twice; `verify` (`:38`) typechecks twice.
- `dev.mjs:34-36` mkdirs `scripts/cdp` at every start though nothing populates it — dead scaffolding around a dead branch.
- Two parallel canary harness families for the same runs: 65 top-level `scripts/*.{cjs,mjs,ts}` (packet's 71 includes subdirs) plus ~42 `.canary/tools/*.mjs`, including single files at 136.0 KB (`build-report.mjs`), 56.5 KB (`fifteen-pages-run.mjs`), 42.5 KB (`canary-run.mjs`).
- `.canary/tools/phase4-verify.mjs:20` defaults its receipt to `.canary/smoke/phase4-verification.json`, which is absent from disk — the machine-readable compile/typecheck timings it exists to record are not being kept.
- `.gitignore` hides `*.png`, `out/`, `.canary/`, `appdata/`, `tmp/`, `scratch/`, `trees_all.txt`, `probe.js`, so the packet's "working tree clean" reading is true but conceals all of B7.

## Unresolved Questions
- **Compile wall-time is unmeasured.** No `phase4-verification.json` and no timestamped compile log survives, so B1's cost is structural (clean + one cold program over ~124k LOC), not measured. `[INFERENCE]`
- **Failure mode of wiping `.compiled` under a live `tsc --watch`** — I verified the sharing and the `rmSync`, not what the watcher does when the dir disappears mid-watch (not exercised).
- **Packet corrections.** (a) Root clutter is 57 `*.png`, not ~20. (b) `.canary` has 12 full run trees + 15 more clones, not "~15 `run3-attemptN` trees" — there are exactly 8 `run3-attemptN` plus 3 variants plus `run1`/`run2`. (c) The packet contradicts itself on tracked files (table says 1,207, prose says 1,144) and I cannot arbitrate without git. (d) `scripts/` top-level code files = 65; the packet's 71 counts subdirectories.
- **Which `appdata/` profile root is live** — `src/main/config/storage-locations.ts` was not traced, so the "dead roots" list is name-based.
- **Whether `CI=true` is actually set in the dev shell** — asserted by `.canary/state/instance-env.json`, not verifiable from the repo.
- `createChangeDispatcher`'s post-relaunch branch (`dev-watcher-helpers.mjs:404-547`) was read only to the branch boundary; the relaunch-vs-error decision tail is unread.

===== PASS B =====
# Scout Report — PASS

Read-only pass; no file was written, no build/test/process was executed, git untouched. Severity reflects the single-developer local loop, not distribution.

## Packet corrections (re-verified)
- `scripts/` holds **76** files at its root (glob of `scripts/*`), not 71; plus 3 subdirs (`cdp/`, `native-host-shim/`, `probes/`).
- `out/` contains `antigravity-browser-desktop-win32-x64/` (215.1 MB exe) + `make/squirrel.windows/`, both 3 weeks old, while `scripts/package-windows.mjs:27-28` now names the output `AntiFan-Browser-Desktop` / `antifan-browser-desktop` → the 699 MB tree is orphaned output from the pre-rename era.
- Confirmed as stated: `native-tab-host.ts` 6,757 lines / 280.2 KB (`:6740` still in class body), `browser-control-port.ts` 6,033 lines / 272.8 KB (read refused `:6040` “beyond end of file (6033 lines total)”), `test/main` 129 files, `.gitignore` excludes `out/ .compiled/ .canary/ appdata/ .antifan/ *.png *.log`.
- **Not re-measurable read-only:** directory byte totals (appdata 1.9 GB, .canary 955 MB, plans 486 MB, out 699 MB, .compiled 10 MB) and the LOC figures. Structure and file counts were spot-verified; totals are carried from the packet.

## Relevant Files
- `package.json` — `compile`/`test`/14 `smoke:*` chains; the cost center.
- `scripts/dev.mjs` — blocking cold compile, tsc --watch, cold relaunch, pid lock, 1200 ms debounce.
- `scripts/dev-watcher-helpers.mjs` — hot-swap classifiers, tsc log parser, dev lock, change dispatcher.
- `tsconfig.json` — no incremental cache; one program spanning src+scripts+test.
- `scripts/certify-core-freeze.cjs` — freeze gate spawns `npm run compile` and requires `.compiled` modules.
- `scripts/run-electron.cjs`, `main.cjs` — both auto-run `npm run compile` when `.compiled` is missing.
- `scripts/copy-static.mjs` — writes a generated file into `src/renderer/` (watcher input).
- `src/main/browser/native-tab-host.ts` — 6,757 lines / 280.2 KB; cold-relaunch surface, text-pinned by tests.
- `src/main/tools/browser-control-port.ts` — 6,033 lines / 272.8 KB.
- `src/main/tools/browser-capabilities.ts` — 186 KB, ~150 registrations, ~60 explicit aliases.
- `scripts/antifan-omp-mcp.cjs` — second registry: 52 tool defs (`:9-56`) + `CAPABILITY_MAP` (`:258+`).
- `src/main/index.ts:67-71` — `ALLOW_EVAL` derivation.
- `src/main/bridge/annotation-manager.ts:116-179,349-351` — annotation/snapshot writer, no pruning.
- `src/main/tools/artifact-retention-cleaner.ts:44` — retention only for `*.artifact`.
- `.canary/CORE-BOTTLENECKS.md` — newest prior report (25.7 KB, 33 m old); records the fixed D1–D5/F8/F9 and tree `e1314c3` status.

## Bottlenecks (ranked)

### B1. Every build wipes `.compiled`; a live app/agent session dies with it [blocking]
- Evidence: `package.json` → `"compile": "npm run clean && node scripts/build-native-host-shim.mjs && tsc -p ./ && node scripts/copy-static.mjs && npm run build:extension"` and `"clean": "node -e \"fs.rmSync('.compiled',{recursive:true,force:true})\""`; `"test": "npm run clean && npm run compile && …"` (clean twice). 14 scripts re-run compile first (`smoke:split|theme-qa|persistence|google|cdp|owned-cdp|cdp-queue|vault|soak|theme-golden-live|multitasking|parity|terminal`, `test:terminal-transport`); `certify-core-freeze.cjs:25` `spawnSync(npm,['run','compile'])`. The bundle is loaded at runtime by `main.cjs:11`, `run-electron.cjs:17`, `certify-core-freeze.cjs:59-61`.
- Why it blocks: the loop is watcher+Electron in one terminal, verification in the other. Any verification (or a bare `npm run compile`) deletes the bundle the running main process, bridge and MCP proxy require → missing-module failure in a live session, and `npm run dev` cannot simply be restarted alongside (single-instance lock).
- Mitigation: drop `clean` from `compile` (keep a separate `rebuild`); only remove stale emit; add a `--no-clean` path to `certify:core-freeze`; have `dev.mjs` detect a deleted `.compiled` and re-emit instead of dying.

### B2. No incremental typecheck anywhere; cold compile taxes every entry point [high]
- Evidence: `tsconfig.json` (604 B) has no `incremental`/`composite`/`tsBuildInfoFile`; `include: ["src/**/*.ts","scripts/**/*.ts","test/**/*.ts"]`, `outDir: ".compiled"`, `strict` + `noUncheckedIndexedAccess` + `noImplicitAny`. `dev.mjs:137-140` runs a **blocking** `execSync('npm run compile')` before launch. Packet LOC: `src/main` 62,121 + `test/main` 41,474 + `test/unit` 10,532 + `src/renderer` 10,892 + `test/e2e` 2,763 → the app and 55 k LOC of tests live in one program.
- Why it blocks: no cache can exist because `clean` deletes the outDir first; cold starts and each `compile` re-check ~100 k+ LOC. Actual wall time is not recorded in the repo (`run3-compile.log` has no timing) → **[INFERENCE]** this is the dominant fixed cost of `npm run dev`, `npm test`, and all 14 smoke scripts.
- Mitigation: `"incremental": true` + `"tsBuildInfoFile"` outside the cleaned path; stop deleting `.compiled`; split `tsconfig.test.json` so app edits don't re-check the test tree.

### B3. Test feedback loop is 4–5 minutes and all-or-nothing [high]
- Evidence: `test:main` measured green at **261.4 s** (`.canary/state/main-followup2.log:1714` `duration_ms 261444.2423`, `MAIN_EXIT=0`); an older failing run at **270.3 s** (`.canary/run3-test-main.log:1785` `[clean-tests] exit=1 elapsed=270.3s`). Fast layers by contrast: 234 tests / 6.5 s (`.canary/run3-focused-suite-3.log`), integration 13 tests / 8.0 s (`.canary/run3-integration.log`). `test/main` = **129 files** (glob footer “Showing files 1-20 of 129”); there is no per-file or changed-file runner, and `npm test` adds clean+compile+site-clone build+Electron e2e.
- Why it blocks: a one-line edit in `native-tab-host.ts` cannot be validated in under 4.5 minutes, so the dev either blocks or skips verification.
- Mitigation: add `"test:file": "node --test --test-force-exit"` and remove the duplicated `npm run clean` from the `test` chain.

### B4. All main-process code is cold-relaunch; only two narrow paths are hot [high]
- Evidence: `dev-watcher-helpers.mjs:37-45` — `isHotSwappable` matches only `^scripts/cdp/<name>.source.js$`; `:231-243` — `isUiHotSwappable` matches only `^src/renderer/[^/]+\.(css|html|js|ts)$`. Everything else reaches `handleBatch` → `copyStaticFn()` → `relaunchElectronFn()` (`:400-425`): `killTree` (`taskkill /pid /T /F`) + 800 ms wait + fresh Electron (`dev.mjs:96-118`), debounce 1200 ms (`dev.mjs:236`). `dev.mjs` also never watches `scripts/**/*.ts` or `test/**/*.ts`, although tsconfig compiles them.
- Why it blocks: every save in the theme-QA core costs a full Chromium cold start plus profile/session restore, losing tabs, terminals and PTY state.
- Mitigation: extend the existing soft-reload path (`antifan.system.reloadScripts`) to main-process modules, or at minimum narrow the cold set to the module-load path; ensure the hash cache in `handleBatch` (`:305-322`) keeps `copy-static` self-writes from queuing a relaunch.

### B5. Tests pin the source text of the 6,757-line host file [high]
- Evidence: 10 files in `test/main` read `src/main/browser/native-tab-host.ts` as a string — `ipc-audit.test.ts:9-12` (`fs.readFileSync(nativeTabHostPath)` then `content.includes('ipcMain.handle(' + channel)`, `:401-405` a multi-line regex over the whole file), `split-view-fixes-regression.test.ts:46-49`, `terminal-switching-regression.test.ts:698-701` and `:770-773`, `preview-protocol-and-watcher.test.ts:161-164`, `per-tab-terminal-session.test.ts:208-210` (negative substring). The failure class is observable in a stale run: `.canary/run3-test-main.log` shows `ipc-audit.test.js` declaring the whole source “actual” against the regex `/else if \(url !== 'about:blank'\) \{[\s\S]*?wc\.loadURL\(url\)\s*\.then\(\(\) => this\.clearInitialNavigationHistory\(wc, state\)\)/`; the source now satisfies it at `native-tab-host.ts:3553-3556` (**[INFERENCE]** the instance was fixed after the 1-day-old log).
- Why it blocks: rename/extract/reformat inside the file the dev most needs to split breaks unrelated tests, and only after the 261 s suite — it penalizes refactoring directly.
- Mitigation: delete the source-text assertions (the same files already exercise behaviour through `MockTabHost`); where a channel must exist, assert it via the registered IPC/capability surface, never file bytes.

### B6. Three registries must be edited for one capability change [medium]
- Evidence: `browser-capabilities.ts` (186 KB) holds ~150 `catalogue.register({…})` blocks; `grep "description: 'Alias for"` matches ~60 (`anti.browser.tabs.create` → `Alias for browser.open-tab` `:1610-1611`; `antifan_set_viewport` `:1188-1189`; `browser_press_key` `:1091-1094`), i.e. one operation under `browser.*`, `anti.*` and `antifan_*`, each with its own `policy`/lane/timeout. `scripts/antifan-omp-mcp.cjs` restates 52 tools (`:9-56`) plus `CAPABILITY_MAP` (`:258+`) and per-capability client budgets; `test/main/capability-catalogue.test.ts` is 80.9 KB.
- Why it blocks (beyond untidiness): it is the documented generator of false symptoms — the prior note records the proxy advertising `fullPage` on `anti.screenshot.viewport` while omitting `anti.screenshot.full_page`, and a proxy budget (30 s) below the server policy (60 s), both later fixed (`.canary/CORE-BOTTLENECKS.md`, scout-inventory rows).
- Mitigation: keep one canonical `anti.*` name per operation and derive both the alias table and the MCP `definitions` from the catalogue in code.

### B7. Annotation evidence grows with no retention [medium]
- Evidence: `.antifan/annotations/` contains **1,428** `element_*.md` files (listing “… 1416 more”, newest 43 m ago) and `.antifan/snapshots/` 143+ PNGs written by `annotation-manager.ts:159-179` (target/viewport/attachments) and `:349-351` (markdown). The only cleaner, `artifact-retention-cleaner.ts:44`, walks files `endsWith('.artifact')` only.
- Why it blocks a local dev (moderately): annotations are the daily QA artifact and land in the workspace tree that gets synced and scanned; nothing removes them.
- Mitigation: extend the sweep to `.antifan/annotations|snapshots` under the same LRU/`maxAgeMs` contract, or write them under the already-swept artifact root.

### B8. Entry points disagree on eval authority; a second watcher is a hard exit [medium]
- Evidence: `src/main/index.ts:67-71` — `ALLOW_EVAL = !process.env.ANTIFAN_CLOUD_HOSTED && (HAS_EVAL_FLAG || (!IS_CI && HAS_EVAL_ENV))`; `dev.mjs:22-26` documents that `npm run dev` without `-- --allow-eval` silently drops the flag (every eval/write denied), while `run-antifan.vbs:4` passes `--allow-eval` directly and bypasses the watcher. `dev.mjs:36-51`: a second `npm run dev` prints the owner PID and `process.exit(1)`; liveness is `process.kill(pid,0)` with EPERM counted alive (`defaultIsProcAlive`), and a lock is present now — `node_modules/.cache/antifan-dev.pid` = `{pid:40304, root:E:\Work\apps\AntiFan}`.
- Why it blocks: launching the app the wrong way produces “capability denied” symptoms with no link to the cause, and clearing a stale/hijacked lock needs manual `taskkill` (Windows PID reuse can keep a lock “alive” — **[INFERENCE]**). Note also `scripts/kill-all.mjs:5` runs `taskkill /F /IM electron.exe`, i.e. every Electron on the machine.
- Mitigation: accept the eval opt-in in the launcher and forward it through env (single source of truth); add `npm run dev -- --unlock` that clears the lock after confirming the pid is not a watcher.

## Smells (not bottlenecks)
- Root clutter (all git-ignored): 62 loose `*.png` up to 3.8 MB (`diff_latest.png` 3.8 MB, `diff_fixed.png` 3.7 MB, `diff_section1/3/4` ≈ 2.4–3.4 MB each); 10 loose report `.md` (`AntiFan-improvement-report.md` 35.1 KB, `-final.md` 37.3 KB, `ANTIFAN_IMPROVEMENTS.md` 7.0 KB, `AntiFan-Final-Repo-Analysis…md` 20.2 KB, `deep-audit-round11-report.md` 13.6 KB, `AntiFan-HEAD-9e06cc4-…md` 9.2 KB, `AntiFan-Final-Fix-Report-ae6b435.md` 9.8 KB, `antifan-deep-architecture-6-plan-review.md` 26.0 KB, `RESEARCH_REPORT…md` 8.4 KB, `15-PAGE-HOPLONGTECH-CLONE-CANARY.md` 17.8 KB); `e2e-fail.log`/`e2e-results.log`; `probe.js` (0 B); `trees_all.txt` (896 KB); `smoke-result*.json`; `AntiFan_vs_Orca_Terminal_Chromium_Report.docx`.
- `.canary/` is a 30-entry scratch universe with **10** `run3-attempt*` clones (`attempt1..8`, `stale-attempt1`, `inconclusive`), each carrying `clone/ reference/ a0-assets/ sections/ diff/ evidence/`, plus `run1/ run2/ 15-pages/ dump/` (4 × ~800 KB HTML) and `tools/build-report.mjs` (136 KB), `fifteen-pages-run.mjs` (56.5 KB).
- `plans/` is append-only: ~60 dated plan dirs, `plans/journals/`, `plans/reports/` (63+ reports incl. four prior `ultra-toolbar-candidate-N.md` scout outputs), `plans/backups/legacy-*`.
- `appdata/` has 7 roots with legacy duplicates (`antifan-browser-desktop/{Chromium, Chromium-dev, Chromium-dev-test, Chromium-dev-cache, Chromium-cache, Chromium-prod, Chromium-prod-cache, state}`, `antigravity-browser-desktop/`, `google-auth-live-profile|probe`, `antifan-test-new-instance*`) that `src/main/browser/profile-ownership.ts:56-65,190-205` still lists among candidate/legacy paths.
- `out/` = stale packaged tree (3 weeks) whose name the current packaging script no longer emits.
- Dormant-era residue: `.playwright-mcp/` (94 files), `scratch/` (35+ incl. retired `patch-*.mjs`, `test-chrome-*.py|cjs`), `tmp/` (23 files + `antifan-probe/`), `.antigravity/`, `plugins/overflow-audit/`, `specs/roahtrip-html-spec/`, `tools/*.py`.
- `copy-static.mjs:72-73` writes a generated `src/renderer/terminal-write-dispatcher.js` back into the watched source tree; only the hash cache (`dev-watcher-helpers.mjs:305-322`) prevents a reload loop — cosmetic today, one cache miss from a spurious UI reload.
- Scripts referenced by no `package.json` script: `kill-all.mjs`, `cleanup-legacy.mjs`, `fix-temp-cleanup.js`, `fix-proxy-redirect.js`, `update-inspector.js`, `canary-server.mjs`, `freeze-*.cjs`, `audit-hoplongtech-*.mjs`, `serve-*.mjs`, `audit-core-purity.ts`.

## Unresolved Questions
- Wall-clock cost of `compile` and of a full `npm test`: no timing line exists in `.canary/run3-compile.log`, and read-only rules forbid running them — B1/B2 severity rests on structure (clean + full tsc), not a measured second count.
- Whether `npm run clean` has already corrupted a live session on this machine: not evidenced; the two-terminal conflict is derived from `package.json` + the single-instance lock (**[INFERENCE]**).
- Current suite status: `.canary/CORE-BOTTLENECKS.md` claims `test:main` 1076 pass / 0 fail on tree `e1314c3`, and the 1-day-old `run3-test-main.log` failure regex now matches the source, but I could not re-run tests to confirm the other earlier failures (`historical-authority-replay.test.js` expecting `ABORTED`, `bridge-terminal-affinity.test.js` RPC timeouts, `wave1-hardening-invariants.test.js`) are closed.
- Directory byte totals (appdata 1.9 GB, .canary 955 MB / 4,083 files, plans 486 MB / 878 files, out 699 MB) and the disk cost of the duplicate `.canary` trees are packet-sourced; only structure and file counts were spot-verified.
- Whether the dev lock pid 40304 is a live watcher or a reused PID — the lock file exists, but its mtime is not exposed by the read tools.
- Whether `out/` or the 62 root PNGs are still referenced by any manual workflow: no code reference found (`package-windows.mjs` excludes `/^\/out/`; `install-windows-shortcut.mjs:14` targets `node_modules/electron/dist/electron.exe`).
- `native-tab-host.ts` hot-path internals (CDP queueing, dispatch loops) were not line-reviewed — the T3 finding here is size/relaunch cost, not internal queue design.

===== PASS C =====
# Scout Report — PASS

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

===== PASS D =====
# Scout Report — PASS

## Relevant Files
- `package.json` — the whole build/test gate graph; `compile`/`test`/`verify`/14 `smoke:*` entries
- `tsconfig.json` — `include: src+scripts+test`, no `incremental`, `sourceMap: true`, outDir `.compiled`
- `scripts/dev.mjs` — blocking `execSync('npm run compile')` then `tsc --watch`; PID lock; 1.2 s debounce
- `scripts/dev-watcher-helpers.mjs` — hot-swap classifier (only 2 classes), tsc-settle gate, relaunch logic
- `src/main/tools/browser-capabilities.ts` (3555 lines) — ~4 name families per operation; `browser.set-viewport:779`, `anti.browser.set_viewport:787`, `antifan_set_viewport:1188`, `browser.inspect_styles:1873`
- `scripts/antifan-omp-mcp.cjs` — hand-written 52-tool `definitions` (:10-61) + 42-entry `CAPABILITY_MAP` (:258-299) + client timeouts (:306-316)
- `src/main/security/security-policy.ts:137` — `backgroundThrottling: true` default
- `scripts/certify-core-freeze.cjs:28-42` — spawns `npm run compile` before certifying
- `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md:33,35` — documented root cause + fix status
- `test/renderer/terminal-gap-state-machine.test.ts` — orphaned test (no npm glob)
- `.canary/run3*/` (11 trees), root `*.png` (56) — workspace weight

## Bottlenecks (ranked)

### B1. `clean` deletes `.compiled` under the running app — dev watcher and every test gate are mutually exclusive [blocking]
- Evidence: `package.json` `"clean": "node -e \"fs.rmSync('.compiled',…)\""`, `"compile": "npm run clean && …"`, `"test": "npm run clean && npm run compile && …"`. `scripts/dev.mjs` spawns Electron on `.compiled` and runs `tsc -p ./ --watch` emitting into `.compiled`. Root cause already documented in-repo: `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md:33` — *"Race condition khi script `npm run compile` chạy `fs.rmSync('.compiled')` trong lúc app đang chạy"* → preload ENOENT.
- Why it blocks a solo dev: with `npm run dev` running (the normal working state) you cannot run `npm test`, `npm run typecheck`, `verify`, `certify:core-freeze`, or any of the 14 `smoke:*` scripts without shredding the artifacts the live app is loading; and if you do, the app breaks with a misleading module/preload error.
- Fix: remove `clean` from `compile` (keep a separate `rebuild`), gate it behind `--if-changed`, and never clean from `test`/`smoke`.

### B2. Every `src/main/**` edit costs a full Electron kill+respawn and all session state [high]
- Evidence: hot-swap is restricted to two patterns — `scripts/cdp/*.source.js` (`dev-watcher-helpers.mjs:48-52`) and `src/renderer/*.{css,html,js,ts}` (`:240`). Everything else falls through to `relaunchElectron()` = `taskkill /pid … /T /F` + fixed 800 ms sleep + respawn (`dev.mjs`). Fixed overhead per edit = 1200 ms debounce (`dev.mjs` `debounceMs: 1200`) + tsc settle wait + 800 ms + measured cold start p50 1180-1714 ms (`plans/260828-1400-measured-performance-optimization/reports/phase-1-baseline-2026-08-28T14-10-11-182Z.json:170`, same OS/hardware).
- Why it costs: `src/main` is ~130 files / ~62k LOC; only ~13 renderer files are on the fast path. Editing `browser-control-port.ts` or `browser-capabilities.ts` (the two files any capability work touches) always drops tabs, terminals and agent attachments.
- Fix: use the already-built soft-reload transport (`antifan.system.reloadScripts` / `reloadUi` in `dev-watcher-helpers.mjs`) for a third class of module-level changes; failing that, restore the persisted tab session (`sanitizeTabForPersistence`/`migratePersistedTab` in `split-review-coordinator.ts`) automatically on dev relaunch.

### B3. Nothing is incremental; the same ~130k-LOC program is compiled twice per startup and twice per `verify` [high]
- Evidence: `tsconfig.json` has no `incremental`/`tsBuildInfoFile`; `.compiled/` contains only `src/ test/ scripts/` — no `*.tsbuildinfo`. `scripts/dev.mjs` runs blocking `execSync('npm run compile')` (full clean+emit) and then spawns `tsc -p ./ --watch` (second full program build). `"verify": "npm run typecheck && npm test"` = `tsc --noEmit` over the same program, then `clean && compile` over it again. `include` covers `src/**`, `scripts/**`, `test/**` (3 `.test.ts` files even live inside `src/main/`, and all 128 `test/main` files are emitted). 14 `smoke:*` scripts each begin with `npm run compile`.
- Why it blocks: the inner "edit → check" loop can never be seconds; and the emit set includes the entire test tree on every build.
- Fix: `"incremental": true` + `"tsBuildInfoFile"`; drop `clean` from `compile`; add `compile:fast` (`tsc -p ./`) and use it in `smoke:*`; add a `verify:fast`.

### B4. The full gate omits the tests that certify the P0 paths [high]
- Evidence: `"test:e2e": "node --test … \".compiled/test/e2e/**/*.test.js\""` — the `.cjs` harnesses `terminal-transport-sync.cjs`, `terminal-recovery-smoke.cjs`, `terminal-renderer-smoke.cjs`, `terminal-split-hydration-probe.cjs`, `toolbar-qa-hub-empirical-probe.cjs` are never matched; they only run via `test:terminal-transport` / `smoke:terminal`, each of which re-runs a full compile. `test/renderer/terminal-gap-state-machine.test.ts` matches no glob in `package.json` at all — it is the regression test for the cold-start chunk-loss fix recorded in `plans/reports/test-suite-audit-report-2026-09-06.md`.
- Why it costs: `npm test` feels like the full gate but silently excludes the terminal P0 certification and its regression test; the dev must remember 3 extra commands, each paying a clean rebuild.
- Fix: add `test/renderer/**` and the `.cjs` harnesses to the gate graph (or a `test:e2e:cjs` script), and make those scripts consume the existing `.compiled`.

### B5. MCP surface is a second, hand-maintained projection of the capability catalogue [medium]
- Evidence: `scripts/antifan-omp-mcp.cjs:10-61` hardcodes 52 tool definitions; `:258-299` maps each to a core name by hand (`'anti.inspect.styles': 'browser.inspect_styles'`). Core names are inconsistent by layer — `browser.inspect_styles` (`browser-capabilities.ts:1873`) vs `browser.media-freeze` (`:2503`); the same operation has 3-4 names (`:779`, `:787`, `:1188`, plus ~40 `antifan_*` aliases and Playwright-named `browser_find`/`browser_press_key`). Client timeouts: `anti.visual.compare` 240 000 ms, `anti.screenshot.full_page` 150 000 ms, default 30 000 ms (`:306-316`).
- Why it costs: adding/renaming a capability requires edits in two files in two languages or the MCP tool drifts silently from core; and one hung capture burns up to 4 minutes of an agent turn (consistent with `TARGET_BUSY_DRAINING` capture notes in `.canary/CORE-BOTTLENECKS.md` §F4).
- Fix: generate the `definitions`/`CAPABILITY_MAP` from the catalogue (single source), collapse aliases to one canonical name per operation, and cap the client timeouts near the server-side budgets.

### B6. `backgroundThrottling: true` throttles exactly the tab being compared [medium]
- Evidence: `src/main/security/security-policy.ts:137` `backgroundThrottling: options?.backgroundThrottling ?? true`; the option exists but is not used for agent-leased tabs. Listed as **CHƯA FIX** in `plans/reports/brainstorm-260905-antifan-toda-weaknesses-analysis.md:34` (P0 root cause of capture `TARGET_STALE`).
- Why it costs: live-vs-clone QA is inherently two tabs; the inactive one — the one being measured or rasterized — is the throttled one, producing empty/short captures.
- Fix: pass `backgroundThrottling: false` for tabs holding an active agent lease / capture transaction only (the scoped unthrottling the in-repo report already prescribes).

### B7. Workspace weight + duplicated evidence trees [medium]
- Evidence: 56 loose `*.png` at repo root (packet said ~20 — **corrected**) plus `e2e-fail.log`, `e2e-results.log`, `probe.js`, `trees_all.txt`, 14 loose `*.md` reports; `.canary/` holds 11 `run3*` trees, each carrying a full clone bundle (`.canary/run3/clone/mobile/index.html`, `assets/*`, per-viewport JSON); `appdata/` holds 5 profile trees (`antifan-browser-desktop`, `antigravity-browser-desktop`, `antifan-test-new-instance`, `google-auth-live-profile`, …).
- Why it costs a solo dev: every search/glob/Defender/backup pass over the working tree pays for ~24k files; the packet's 4.6 GB is not measurable with my tools (see gaps).
- Fix: archive `.canary/run3-attempt*` (11 trees are record of one campaign), move root PNG diffs under `reports/artifacts/`, and keep exactly one Chromium profile tree.

### B8. Dev lock/poller and electron kill-all [low]
- Evidence: `dev.mjs` refuses to start on a live lock and prints `taskkill /F /T /PID`, then polls its own scripts every 2 s only to print a stale banner (`dev.mjs` tail). `scripts/kill-all.mjs` = `taskkill /F /IM electron.exe`.
- Why it matters: recovery is manual and the kill-all is indiscriminate, but neither slows the normal loop.

## Smells (not bottlenecks)
- `scripts/` = **76 top-level files** + `cdp/`, `native-host-shim/`, `probes/` (packet said 71 — corrected), including one-shot residue `kill-all.mjs`, `cleanup-legacy.mjs`, `fix-temp-cleanup.js`, `fix-proxy-redirect.js`, `update-inspector.js`, 3 `.py` helpers.
- Three near-identical freeze tools: `certify-core-freeze.cjs`, `freeze-certification-core.cjs` (the first `require`s the second, `:14`), `freeze-theme-workload.cjs`.
- `.gitignore` hides `*.png`/`*.log`/`.canary`/`appdata`/`out`, so "git status clean" is not evidence the tree is tidy (it is clean, verified).
- `plans/` keeps 5-candidate ultra families with verifier verdicts (toolbar, terminal-black-screen, terminal-fix-plan, chrome-profile-sync) — historical record, harmless.
- Capability naming mixes `.`/`_`/`-` in one catalogue.
- `audit-core-purity.ts` gates 8 literal substrings and is reached only from `test/golden-slice-e2e.test.ts:491`; ceremony value is low but it is wired.
- `.cursor/rules/` holds 3 rules; there is **no** `.antigravity/` directory (packet wrong).
- Prior findings now **closed in code** (packet asked): `anti.browser.set_viewport` (`browser-capabilities.ts:787`), `anti.reference.capture`, `NO_RENDER_SURFACE` gate (`browser-control-port.ts:1526-1548`), `drainTarget`/`reapplyTabGeometry`/target quarantine (`:4008-4138`); empty-artifact now `isError` (`antifan-omp-mcp.cjs:1130-1140`); the hard `params.tabId !== target.tabId` in `theme.qa_validate` is gone (only `!target?.tabId` remains at `:1277`).

## Unresolved Questions
- Byte sizes (appdata 1885 MB, `.canary` 955 MB, `out` 699 MB, `plans` 486 MB) are controller-measured; my tools cannot `du`, so I verified structure/counts only.
- Wall-clock cost of one `npm run compile` on this machine: no logged measurement found. `tsc` is invoked with `--max-old-space-size=4096` in `dev.mjs`, and `plans/260828-1400…/phase-4-io-bounds-evidence.md:37` needed the same flag — memory pressure is implied, timing is `[INFERENCE]`.
- Whether `npm test` currently passes (read-only constraint).
- Whether `scripts/package-windows.mjs` excludes `.compiled/test/**` from the packaged app.
- Whether BridgeServer soft-reload can be extended to main-process modules (currently only injected scripts/UI reload).
- Workstation RAM is unspecified in the packet; 4 GB tsc heap + Electron + PTYs on an i5-9300H is unquantified.
- Whether the 11 `.canary/run3*` trees are still referenced by `canary-server.mjs`/`probes/` or are dead state.

===== PASS E =====
# Scout Report — PASS

## Relevant Files
- `package.json` — script graph; `compile` and `test` chains are the inner-loop cost center
- `tsconfig.json` — `include` pulls `test/**/*.ts` into the app build; no `incremental`
- `scripts/dev.mjs` — blocking `execSync('npm run compile')` at startup; singleton PID lock; `--watch` child
- `scripts/dev-watcher-helpers.mjs` — hot-swap classifier, lock, tsc-log parser
- `main.cjs` — auto-compiles the whole project if `.compiled` is missing
- `src/main/browser/native-tab-host.ts` (6,749 LOC), `src/main/tools/browser-control-port.ts` (6,033 LOC) — two god modules
- `src/main/tools/browser-capabilities.ts` (~3,600 LOC) — ~153 capability registrations, ~72 pure aliases
- `src/main/tools/tab-devtools-host.ts` — CDP drain / `TARGET_BUSY_DRAINING` admission control
- `.canary/CORE-BOTTLENECKS.md` (415 lines, 31 min old) — most recent measured runtime-bottleneck artifact
- `scripts/kill-all.mjs` (4 lines) — only kills `electron.exe`
- `appdata/`, `.canary/`, `out/`, `plans/` — 4.0 GB of the 4.6 GB tree

## Bottlenecks (ranked)

### B1. Every loop entry does a full *clean* compile of app **and** all tests [blocking]
- Evidence: `package.json` -> `"compile": "npm run clean && node scripts/build-native-host-shim.mjs && tsc -p ./ && node scripts/copy-static.mjs && npm run build:extension"`, and `"clean": "node -e \"fs.rmSync('.compiled',{recursive:true,force:true})\""`. `tsconfig.json` `"include": ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"]` — so `tsc -p ./` emits `src/main` 62,121 LOC **plus** `test/main` 41,474 + `test/unit` 10,532 + `test/e2e` 2,763 + 10 `integration` files (~128 `test/main` files confirmed by glob). `scripts/dev.mjs:135-139` runs `execSync('npm run compile')` synchronously before Electron starts.
- Why it blocks: `rmSync(.compiled)` guarantees a **cold** program on every `npm run dev`, every `smoke:*` (14 of them prefix `npm run compile`), and every `npm test`. Nothing the dev edits in `src/` reuses a previous emit — `tsc` has no `incremental: true` and no `tsBuildInfoFile` anywhere (grep over repo: only prose mentions). On an i5-9300H this is the single largest fixed cost in the day.
- Mitigation: split `tsconfig.test.json` (exclude `test/**` from the app build); add `"incremental": true`; drop `clean` from `compile` and keep a separate `rebuild` script.

### B2. Render-dependent capability calls burn 10–60 s bounds instead of failing [blocking]
- Evidence: `.canary/CORE-BOTTLENECKS.md:82-96` (F4) — first `anti.screenshot.full_page` on a fresh tab -> `ERR TARGET_BUSY_DRAINING: Page.captureScreenshot did not settle within its bound` (~60 s), second attempt fails in ~10 s because the tab is left draining; `:176-186` (F7) — `anti.screenshot.viewport` times out at the MCP 30 s bound and leaves the target draining; `:52-60` (F3b) — `browser.set-viewport` returns `success:true` with `observedWidth:0`. Code that produces this class: `src/main/tools/tab-devtools-host.ts:557-559`, `:1400-1403`, and `src/main/tools/browser-control-port.ts:1705`, `:1750`, `:4017-4033`.
- Why it blocks: the pixel-evidence loop is the core of the Haravan/Sapo theme QA job. One capture attempt can eat a minute of the loop and still yield nothing, with only a timeout-shaped error.
- Mitigation: keep the fail-fast path (`browser-control-port.ts:1543-1548` throws `NO_RENDER_SURFACE` with measured `vw x vh`) and make `full_page`'s drain quarantine self-healing — one bounded `drainTarget` then one internal retry.
- **Packet correction:** three headline findings of that file are **already closed at HEAD**. F3 (no canonical set-viewport) — `anti.browser.set_viewport` is registered at `browser-capabilities.ts:787-795`. F2 (`tabs.list` returns []) — `:1596-1608` now defaults to all tabs with `isBoundTab`. F6 (no reference-capture capability) — `anti.reference.capture` registered at `:1675-1702`. The residual blocker is F4 only.

### B3. Two full type-checks per `verify`, and no fast test path [high]
- Evidence: `"typecheck": "tsc -p ./ --noEmit"` and `"test": "npm run clean && npm run compile && …"`, composed as `"verify": "npm run typecheck && npm test"`. Both `tsc` invocations walk the same `include`. `test:fast` covers only `.compiled/test/*.test.js` + `unit/**` + `benchmark/**`; `test:main` (128 files, 41,474 LOC) has no scoped runner and always runs in full, sequentially, before `test:e2e`.
- Why it blocks: after any shared-contract edit the dev pays clean-emit + 5 sequential suites + a duplicate `--noEmit`. There is no "run the one test I broke" path.
- Mitigation: `verify` should call `compile` once and reuse it; add `test:one` taking a filename; make `test:main`/`test:e2e` opt-in rather than mandatory members of `test`.

### B4. Dev watcher startup is serialized behind a full build, and its lock has no foreign-owner escape [high]
- Evidence: `scripts/dev.mjs:135-139` — `execSync('npm run compile')` blocks *before* `relaunchElectron()` at `:141`; the `fs.watch` on `src/` is only installed at `:203`. Lock: `:36-53` via `acquireDevLock({lockPath: node_modules/.cache/antifan-dev.pid})`, implemented at `dev-watcher-helpers.mjs:520-524`; on a live holder the process prints `taskkill /F /T /PID …` and `process.exit(1)`. `scripts/kill-all.mjs` (4 lines) runs `taskkill /F /IM electron.exe` only — it never clears a stale `antifan-dev.pid` or the node watcher tree. `dev.mjs:216-236` can only print "restart `npm run dev` once" when its own code changed.
- Why it blocks: a crashed watcher leaves a lock whose PID may be recycled; the only sanctioned fix is a manual `taskkill` of an unverified PID. A 2–3 minute cold build also sits between `npm run dev` and a usable window.
- Mitigation: skip the initial `execSync` when `.compiled/src/main/index.js` is newer than the newest `src/**` mtime; extend `kill-all.mjs` to release the lock and kill the `dev.mjs` node tree.

### B5. God modules make every change expensive to reason about [medium]
- Evidence: `native-tab-host.ts` — read footer "Showing lines 1-300 of 6749"; imports 40+ modules and mixes tab lifecycle, sidebar chat, bookmarks, mobile touch emulation, Google identity, split-review. `browser-control-port.ts` — 6,033 LOC, `BrowserHostPort` declares ~60 optional methods, capture/quarantine state machine at 1380-1780 and 4000-4440.
- Why it blocks: the drain semantics the dev most needs to tune (`:4017-4033`) sit inside a 6k-LOC file; any edit reopens the whole-file type-check with a wide blast radius and no isolating test.
- Mitigation: extract the capture-attempt/quarantine state machine into its own module; move CDP admission queue out of `tab-devtools-host.ts` so `TARGET_BUSY_DRAINING` has one owner.

### B6. Capability registry is a fragmented alias wall [medium]
- Evidence: `browser-capabilities.ts` spans `:198`->`:3524`; I counted ~153 `catalogue.register({` sites, of which **72** carry `description: 'Alias for …'`. `browser.set-viewport` (`:778-786`) and `anti.browser.set_viewport` (`:787-795`) are two separate registrations of the same op with different descriptions (only `anti.*` promises measurement verification), plus `antifan_set_viewport` (`:1187-1195`) as a third. The same set is re-exported through `scripts/antifan-omp-mcp.cjs` (59.2 KB).
- Why it blocks: an agent or the dev picks the alias without the verified-viewport contract and silently gets the F3b behaviour; a fix applied to one registration is invisible on the others.
- Mitigation: collapse each canonical op to one registry entry; generate alias names from a table instead of 72 hand-written blocks.

### B7. 4.0 GB of generated state on a laptop SSD [medium]
- Evidence: `.canary/` holds 11 sibling campaign trees (`run1/`, `run2/`, `run3/`, `run3-attempt1..8/`, `run3-stale-attempt1/`, `run3-attempt-inconclusive/`), each with `clone/ reference/ diff/ sections/ a0-assets/ evidence/`, plus `state/` (168.6 KB + 169.5 KB + 63.0 KB logs) and `dump/` ref HTMLs of 775–809 KB each. `appdata/` lists 7 Chromium profile roots; `out/antigravity-browser-desktop-win32-x64/` is 3 weeks stale and is not a packaging target (`scripts/package-windows.mjs:16,26` writes to `artifacts/…`). Root holds 25 loose PNGs (several 2.4–3.8 MB).
- Why it blocks: nothing breaks, but Defender/indexing scans 10,305 files under `appdata/` and 4,083 under `.canary/` on every file operation. `.gitignore` already excludes all of these, so the cost is filesystem-only.
- Mitigation: delete `run3-attempt1..5/`, `run3-stale-attempt1/`, `run2/`, `run1/` and root `out/`; add a prune script wired into routine maintenance.

### B8. Script sprawl with no ownership boundary [low]
- Evidence: `scripts/` holds 71 executable files (`.cjs`/`.mjs`/`.js`/`.py`/`.cmd`) plus 2 `.ts` (`audit-core-purity.ts`, `probes/sapo-boundary-probe.ts`) and 3 subdirectories — ~74 items (packet said 71). Roughly a third are one-campaign artifacts: `serve-hoplongtech-clone.mjs`, `hoplongtech-server.mjs`, `audit-hoplongtech-clone.mjs`, `audit-hoplongtech-comprehensive.mjs`, `build-hoplongtech-clone.mjs`, `generate-hoplongtech-offline-bundle.mjs`, `serve-roahtrip.mjs`, `toolbar-keyboard-accessibility-probe.cjs`. A parallel unowned set lives in `.canary/tools/` (40 entries; `fifteen-pages-run.mjs` 56.5 KB, `build-report.mjs` 136 KB).
- Why it blocks: only indirectly — `audit-core-purity.ts` is inside the tsconfig include so it is type-checked on every build despite being one-shot.
- Mitigation: move campaign scripts to `scripts/campaigns/` and exclude it in tsconfig; promote still-used `.canary/tools/*.mjs` into `scripts/` and delete the rest.

### B9. Duplicated verification ceremony pinned to a stale plan path [low]
- Evidence: `scripts/certify-core-freeze.cjs:7-11` pins `reportsDir = plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports`, re-runs `npm run compile` (`:22-35`), hashes 11 named artifacts (`:38-50`); assisted by `scripts/freeze-certification-core.cjs` + `scripts/freeze-theme-workload.cjs`; `scripts/audit-core-purity.ts` is a separate banned-substring scanner. None are in `npm test` or `verify`, so the certificate silently goes stale.
- Severity rationale: real ceremony, but it never blocks the edit->reload->look loop. Ranked low deliberately.
- Mitigation: add the purity audit to `verify`; have the certifier emit a `stale` flag when `.compiled` hashes change.

## Smells (not bottlenecks)
- 14 loose root `*.md` reports, several overlapping (`AntiFan-improvement-report.md` 35.1 KB vs `AntiFan-improvement-report-final.md` 37.3 KB, both 2 weeks old and predating the current capability surface).
- `.playwright-mcp/` holds 94 stale `page-*.yml` / `console-*.log` files; gitignored, harmless.
- `plugins/overflow-audit/` (2 files), `specs/roahtrip-html-spec/` (5 files), `.cursor/rules/` (3 files), `.antigravity/` — no measurable cost; config sprawl is cosmetic.
- `tools/visual_diff.py` + `tools/capture_screenshot.py` + `__pycache__` duplicate `anti.visual.compare` / `anti.screenshot.*` inside the app.
- `probe.js` (0 B), `smoke-result.json` (106 B), `smoke-result-settings.json` (130 B) at root are placeholder files already gitignored.

## Unresolved Questions
- **Does F4 still reproduce at HEAD?** Cannot launch Electron read-only, so the `full_page` first-capture drain is asserted only from `.canary/CORE-BOTTLENECKS.md:82-96` (written 31 min before this pass). That file is provably stale on F2/F3/F6, so F4 may share that fate — unverified.
- **Wall-clock of `npm test` / `npm run dev` cold start** on this i5-9300H is not measured; only the work set is established (~125 k LOC, cold emit).
- **Absolute byte totals** for `.compiled/` (packet: 10 MB / 647 files), `appdata/` 1885 MB, `.canary/` 955 MB, `out/` 699 MB, `plans/` 486 MB: I verified structure and file counts, not bytes — directory sizes are not readable without shelling out.
- **`appdata/` provenance**: `Chromium-dev-test` vs `Chromium-prod-cache` are distinguishable only by name; whether any script still selects them is unchecked.
- **Whether `out/` is read at runtime** by any code path — the only writes I found point at `artifacts/` (`package-windows.mjs:16`), but I did not exhaustively grep `src/` for `'out'` path joins.