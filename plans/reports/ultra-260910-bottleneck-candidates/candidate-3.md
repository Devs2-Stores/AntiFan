# Scout Report — Candidate 3

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