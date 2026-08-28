# Phase 5–6 Evidence — Startup Profile, Packaging Audit, Rollout Decisions

Date: 2026-08-28. Plan: `local://electron-performance-optimization-plan.md`. Phase 4 report: `phase-4-io-bounds-evidence.md` (34 test suites green); this file records Phases 5–6.

## 1. Startup milestone profile (3 runs, guarded telemetry, isolated user data)

`--scenario cold-start --runs 3` (report `phase-1-baseline-2026-08-28T14-0x.json`, rows `bootstrapToReadyMs` / `readyToWindowMs` / `windowToFirstVisibleMs`):

| Milestone | p50 | min–max | Share of total |
|---|---|---|---|
| bootstrap → app ready | 47 ms | 44–48 | 4% |
| ready → windowCreated | **934 ms** | 866–966 | **71%** |
| windowCreated → firstVisible | 335 ms | 322–335 | 25% |
| bootstrap → firstVisible | **1318 ms** | 1245–1335 | 100% |

Single-run records varied 1714 → 1180 → 1318 ms (disk cache/AV noise, n=1); the 3-run profile is the stable record.

**Critical-path finding:** the ready→windowCreated segment (71%) is serial awaited I/O in `src/main/index.ts` `app.whenReady()`: `cleanCorruptedGoogleCookies()` + `CookiePersister.restoreCookies()` + capsule-manager load all run **before** `createWindow()`. The window cannot paint until cookie restore completes. This is the single dominant startup cost.

## 2. Packaging audit (`scripts/package-windows.mjs`, `scripts/copy-static.mjs`)

copy-static.mjs: audited clean (renderer asset list + 3 shim scripts + dispatcher classic-script wrapper, idempotent).

package-windows.mjs findings and fixes (all shipped):

| # | Finding | Fix | Effect |
|---|---|---|---|
| A1 | `appVersion: '1.0.0'` hardcoded, package.json is 1.3.0 | read from package.json; manifest gains `appVersion` | exe metadata matches app |
| A2 | `.compiled/test` + `.compiled/scripts` shipped in production asar | ignore additions | test/dev code out of package |
| A3 | `.antigravity/` MCP-selection residue (incl. screenshots) shipped | ignore `/^\/\.antigravity/` | residue out |
| A4 | Cross-platform node-pty prebuilds (darwin-arm64/x64, win32-arm64) + `*.pdb` debug symbols shipped | ignore additions | win32-x64-only native set |
| A5 | Stale `out/antigravity-browser-desktop-win32-x64` (699 MB, different product) packed into asar | ignore `/^\/out/` (runtime never reads `out/` — verified) | biggest single reduction |

**Package size before → after: 317 files / 1132 MB → 296 files / 378 MB (−754 MB, −67%)**; exe 225,562,624 B unchanged; asar now 24 MB + 7.6 MB unpacked; verified asar contents: 0 `.compiled/test`, 0 `.compiled/scripts`, 0 `.antigravity`, 0 `out/`, only `node-pty/prebuilds/win32-x64/*` (+ `build/Release/conpty/{OpenConsole.exe,conpty.dll}`); renderer assets include the new `terminal-write-dispatcher.js`.

## 3. Packaged-exe smoke (new harness scenario `--scenario packaged`)

Launch the built exe with isolated `ANTIFAN_USER_DATA`/`ANTIFAN_CONFIG_DIR`, wait `startup.firstVisible`, then create + list a terminal session over the bridge (token auth) — proves node-pty loads from the packed asar.

- First run: firstVisible 2696 ms, ptyLoad ok.
- Final source (post addon-web-links restore): firstVisible 3223 ms, ptyLoad ok.
- AppDriver kills only its own spawned tree (`taskkill /T /F` by PID); no interference with a running app instance (isolated config; bridge retries to an ephemeral port on contention).

## 4. Full regression (final source)

- `npm test`: **342 tests / 73 suites / 0 failures** (was 341 before the added regression test), typecheck green, compile green, duration ~8.9 s.
- Harness smokes on final source: cold-start 3-run above; tabs switch p50 8.1 ms / p95 11.0 ms (baseline 15.4 / 259.9); terminal echoLatency 4513 ms, burst 1564 chunks / 8444 B / 3438 ms (baseline 3871 ms / 1544 / 8346 / 4519 ms; n=1 variance, same order of magnitude); artifact 4 stages measured, binary byte-equal, redacted flags accurate; package 296 files / 378 MB; packaged ptyLoad ok.
- Deferred (not run): `smoke:theme-qa` (live storefront QA — owned by pending QA reliability plan 260828-1033-qa-fresh-target-reliability) and `smoke:split` (legacy split-review flow).

## 5. Bugs found and fixed during Phase 6 verification

1. **standalone.html lost its `@xterm/addon-web-links` script tag** during the Phase 4 dispatcher-script insertion (caught by existing regression test `terminal-process-tree-and-links.test.ts`). Restored; packaged asar re-built on fixed source.
2. **BridgeServer `sendEventFrame` fast path sent empty frames for `antifan:terminal:data`** (raw was `''` when coalesceKey set; only the congested-queue path rebuilt the real frame). Regression test added (`broadcasts terminal data as non-empty JSON frames over a live socket`): asserts every broadcast frame is non-empty and terminal frames carry exact payload bytes. Reproduced by the terminal smoke (`shell produced no data`), fixed, and re-verified: terminal scenario green end-to-end.

## 6. Rollout decisions

| Change | Decision | Rationale |
|---|---|---|
| Phase 4 I/O bounds (artifact binary safety, renderer dispatcher, bridge backpressure/heartbeat) | **SHIP** | 342/342 tests + smoke re-runs; terminal path verified end-to-end |
| Packaging fixes A1–A5 | **SHIP** | −67% package size, version/metadata correctness, verified asar |
| Startup reorder (cookie cleanup/restore behind window creation) | **NOT IMPLEMENTED** — follow-up | 71% of startup is serial pre-window cookie I/O; reordering is behavior-sensitive (storefront auth at first paint). Recommended: move `cleanCorruptedGoogleCookies` + `restoreCookies` to start concurrently with `createWindow()` with a warm-up gate; must pass a storefront-auth + cookie smoke first. Evidence ready for a cause-aligned change. |
| Phase 2 tab lifecycle + Phase 3 main-thread responsiveness | **BLOCKED** | Pending QA reliability plan 260828-1033-qa-fresh-target-reliability owns overlapping tab/reload/target contracts |
| `smoke:theme-qa` / `smoke:split` | Deferred | Live QA surface under the pending plan; run post-unblock |

## 7. Artifacts

- Reports: `phase-4-io-bounds-evidence.md`, this file; harness reports `phase-1-baseline-2026-08-28T14-*.json`.
- Harness: `scripts/benchmark-electron-performance.mjs` (startup milestone rows; `--scenario packaged`).
- Package: `plans/260827-1345-production-cutover-release-hardening/reports/artifacts/AntiFan-Browser-Desktop-win32-x64/` (manifest `appVersion: 1.3.0`, sha256 recorded on disk).