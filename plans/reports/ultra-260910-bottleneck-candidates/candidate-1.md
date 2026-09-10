# Scout Report — Candidate 1

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