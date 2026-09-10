# Scout Report — Candidate 4

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