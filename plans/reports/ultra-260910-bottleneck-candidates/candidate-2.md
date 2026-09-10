# Scout Report — Candidate 2

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