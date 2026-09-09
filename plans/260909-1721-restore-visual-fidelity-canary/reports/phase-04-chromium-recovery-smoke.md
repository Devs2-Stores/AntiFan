# Phase 4 Evidence — Focused Verification and Chromium Recovery Smoke

Status: green
Run date: 2026-09-09 (local), canary instance `antifan-canary` (bridge 20131)
Owner surface: `.canary/tools/chromium-recovery-smoke.mjs` against the isolated project-owned instance; no user-owned process touched.

## 1. Verification sequence results

| Step | Command | Result | Log |
| --- | --- | --- | --- |
| 1 | `npx tsc -p ./ --noEmit` (same compiler config as `npm run typecheck`) | exit 0, no diagnostics | `.canary/run3-typecheck.log` |
| 2 | compiled output currency | no `src/**/*.ts` newer than `.compiled/**`; no `test/**/*.ts` newer than `.compiled/test/**` | mtime scan below |
| 3 | focused compiled suites (10 files from this phase) | 234 tests / 33 suites, **234 pass, 0 fail, 0 skipped**, 6.38s, exit 0 | `.canary/run3-focused-suite-2.log` |
| 4 | project-owned instance | reused `antifan-canary` (`scripts/run-electron.cjs . --allow-eval`), artifact ceilings 24 MiB/1 GiB from `instance-env.json` | `.canary/state/instance-env.json` |
| 5 | deterministic pages | hardened static server, incompressible full-document canvas noise | `.canary/tools/serve-static.mjs` |
| 6 | canonical capabilities only | bridge `antifan.capability.dispatch`, no browser mock | `.canary/smoke/recovery-smoke.json` |

Focused suites (step 3): `visual-capture`, `tab-devtools-host`, `capability-catalogue`, `visual-compare-mask-ledger`, `runtime-fullpage-evidence`, `baseline-authority-integration`, `theme-evidence-capabilities`, `artifact-capabilities`, `execution-control-cancellation`, `mcp-persistent-transport`.

Compile currency scan:

```
newest src .ts       2026-09-09T13:23:41.097Z  src/main/browser/tab-devtools-host.ts
newest compiled .js  2026-09-09T13:40:16.381Z  .compiled/src/renderer/terminal-write-dispatcher.js
newest test .ts      2026-09-09T13:32:17.294Z  test/main/ipc-audit.test.ts
newest compiled test 2026-09-09T13:32:58.635Z  .compiled/test/unit/tools/viewport-gate.test.js
any src .ts newer than compiled tree: false
any test .ts newer than compiled tests: false
```

## 2. Live Chromium smoke — 26/26 checks

Evidence: `.canary/smoke/recovery-smoke.json` (generated `2026-09-09T14:02:27.060Z`), runner `.canary/tools/chromium-recovery-smoke.mjs`, static pages from `.canary/tools/serve-static.mjs`.

| Required proof (phase-04) | Check(s) | Live detail |
| --- | --- | --- |
| Receipts report mode/backend/CSS/raster geometry, DPR, zoom | viewport capture receipt; full-page receipt mode; raster = css × dpr × zoom | viewport `1440×900` css/raster, backend `cdp`, dpr 1, zoom 1; full-page css `1440×2200`, raster `1440×2200` |
| Full-page raster exceeds viewport and includes below-fold marker | full-page raster exceeds viewport height; below-fold marker inside captured region | marker y=1800 h=80 → ends 1880 ≤ 2200 captured |
| Offscreen full-page cannot silently produce viewport geometry | offscreen full-page rejects or stays full-page geometry | typed `FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN` |
| >8 MiB complete PNG round-trips byte-for-byte with SHA256 + valid decode | artifactRef carries declared sha256; round-trips byte-exact; complete decodable PNG; exceeds 8 MiB | 9,441,008 bytes (9.0 MiB), sha `09a8113814c24538…`, IHDR `1440×2200`, terminal IEND, fetched bytes == declared |
| Over-policy screenshot fails before an artifact reference | over-policy full-page fails without an ArtifactRef | `ARTIFACT_TOO_LARGE` at 31,112,713 bytes > 25,165,824 ceiling, no ref |
| Self-compare deterministic with zero implicit masks | self-compare deterministic at 0%; no implicit masks | both runs 0%; mask ledger `status: ok`, `maskedAreaRatio: 0`, empty entries |
| Pre-dispatch cancellation recovers pair-lock admission; next waiter succeeds | same-pair waiter times out client-side; holder completes; next waiter succeeds | waiter `RPC timeout 1500ms` (`code: TIMEOUT`), holder mismatch 0%, next waiter mismatch 0% |
| Forced post-dispatch timeout is bounded and non-replaying | post-dispatch client timeout returns bounded failure without replay | `RPC timeout 1200ms: anti.screenshot.full_page` (`code: TIMEOUT`), server completed the capture (recovery check below) |
| Same-target op during quarantine fails typed or serializes | same-target operation during in-flight/quarantine | serialized clip compare returned mismatch 0% (no cross-talk, no partial state) |
| Recovery after the timed-out operation | target recovers after the timed-out operation completes | subsequent full-page capture succeeds, `captureMode: full-page` |
| No second authority revision on timeout | authority revision well-formed and attachment-scoped after cancellation | `rev_c7a5f55e9fa1be167e41cecbd92a9d62`, attachment-scoped |

Additional negative controls: both viewport-only capabilities reject `fullPage: true` with `INVALID_ARGUMENT`; clipRect compare returns a receipt-bearing result.

## 3. Harness defects found and corrected during this phase

All were defects in the **evidence harness**, not the product; product behavior was never weakened, and every assertion got stricter.

1. PNG validator checked bytes `-12..-8` (chunk length) instead of `-8..-4` (chunk type) → false `no terminal IEND`. Fixed; artifact re-verified as a complete decodable PNG by an independent chunk scan.
2. Noise page used a repeated 512×512 tile → zlib matched the duplicated rows and collapsed a 9.5 MiB raster to 3.3 MiB, so the >8 MiB and over-policy subjects never reached the ceiling. Replaced with one full-document canvas (xorshift128) → 9,441,008-byte incompressible PNG.
3. Artifact fetch requested `limit=128 MiB` but the endpoint caps one response at 1 MiB → truncated download. The runner now pages on `x-artifact-has-more`, matching the MCP proxy's real fetch path.
4. Compare stages each side with a hard 8 MiB reject ceiling (independent of the instance ceiling). Pair-lock and quarantine subjects were resized below it (7,801,900-byte compare page) and the quarantine probe uses a clipRect compare, so the checks can only pass on lock/quarantine semantics, never on an artifact-size error.
5. Tab lifecycle: creating a tab rebinds the attachment, and closing the bound tab strands re-targeting (`TARGET_MISMATCH`). The runner now keeps its subjects alive for the run, sweeps only its own leaked pages pre-flight, and releases them in `finally`.
6. Assertions tightened: waiter and post-dispatch checks now require `code === 'TIMEOUT'` (a server-side error would no longer count), and the quarantine check accepts only typed target-busy/quarantine codes or a serialized 0% mismatch.

## 4. Measured timings (why the subjects are sized as they are)

```
capture 1800px: 868ms   bytes=7801900    (compare subject, < 8 MiB per-side ceiling)
compare 1800px: 2668ms  mismatch=0       (holder outlives the 1.5s waiter budget)
capture 5400px: 2181ms  bytes=23405526   (post-dispatch subject, < 24 MiB instance ceiling)
compare 5400px: 3220ms  ARTIFACT_TOO_LARGE (correctly refused: > 8 MiB compare ceiling)
```

## 5. Verdict

Phase 4 required proof is met on real Chromium through canonical production capabilities: full-page integrity, >8 MiB byte-exact round-trip, over-policy refusal before any ArtifactRef, offscreen refusal, deterministic zero-mask self-compare, pre-dispatch lock recovery, and post-dispatch quarantine/recovery on the same tab. Phase 5 may start.
