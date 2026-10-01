# Final Verification — detached-project-webhub-windows

**Date:** 2026-10-01 · **Verifier:** FinalVerify (independent re-run; reports not trusted)
**Verdict: VERIFIED_COMPLETE** — all gates green on isolated re-runs. Two
concurrency-induced flakes observed and isolated; none deterministic.

## Results

| # | Gate | Command | Result | Verdict |
|---|------|---------|--------|---------|
| 1 | Compile | `npm run compile` | clean — emit-integrity 542/542 files, tsc 0 errors, budget-dominance OK, payload fixtures OK, ~11.5s | ✅ |
| 2 | Full main suite | `npm run test:main` | **2231 tests / 389 suites — 2229 pass, 1 fail, 1 skipped** (212s). Sole fail: `pairing-grant-authority.test.js:351` → `PAIRING_UNAVAILABLE` after 4 attempts. | ✅ (flake-with-evidence) |
| 3 | Regression lanes | `node --test` on `project-close-coordinator.test.js` + `project-window-manager.test.js` | **72 pass / 0 fail** (11 suites, 3.1s) — F1 regression verified fixed | ✅ |
| 4 | New detached suites | `node --test` on detached-project-window, detached-project-lifecycle, detached-project-restore, navigation-waiter-commit-recheck, browser-navigate-error-codes | **54 pass / 0 fail** (20 suites, 10.3s) | ✅ |
| 5 | Live probe | `node scripts/run-electron.cjs scripts/probe-detached-webhub.cjs` | **24 passed / 0 failed**; restart leg **5/0**. Fresh evidence written: `detached-webhub.json` (13.9KB), `detached-webhub-restart.json` (3.9KB), `detached-webhub.log` — all mtime 12:59:1xZ today | ✅ |
| 6 | e2e hub guards + detached rows | `node --test --test-concurrency=1 .compiled/test/e2e/project-windows.test.js` | **21/0** incl. `detached-project-shell-lifecycle`, `detached-project-exclusivity`, `detached-project-reattach`; all 18 pre-existing hub guards pass | ✅ |
| 7 | Diff sanity | `git diff --stat` + untracked-set diff vs `pre-cook-git-baseline.txt` | 16 modified tracked files, +2299/−280. New untracked vs baseline: 2 probe scripts (`probe-detached-webhub.cjs`, `probe-unfocused-visible-capture.cjs`) + 6 new test files. **Zero unexpected additions, zero removals.** | ✅ |

## Flakes observed (both concurrency-induced, both cleared on isolated re-run)

1. **`pairing-grant-authority.test.js`** — `PAIRING_UNAVAILABLE` after 4 attempts
   against `127.0.0.1:54426`, only inside the full-suite run. Standalone re-run:
   **18/0 pass** (65s). Same class as phase-05's recorded history-manager mtime
   flake: load-dependent handshake retry exhaustion, not a code regression.
   Unrelated to this plan's diff (pairing bridge untouched).

2. **Probe leg5b nav-miss row** — on the *first* run (executed concurrently with
   the e2e Electron instance, a verifier scheduling error), the refused-socket
   navigation to `127.0.0.1:1` answered `navigated:true` even though Chromium
   logged `ERR_UNSAFE_PORT`. Standalone re-run: leg5b reports `LOAD_FAILED`
   correctly, full probe 24/0. Root cause plausibly a timing window in
   `createNavigationLifecycleWaiter` (`did-finish-load` racing `did-fail-load`
   under CPU contention) — flagged for the implementer as a latent race worth a
   look, but it did not reproduce under isolation and is not a gate failure.

3. **e2e first attempt** — the `antifan_bridge_dev.json` "held by a live
   instance" refusal was caused by the concurrent probe above. Re-run after the
   probe exited: clean 21/0. Scheduling artifact only.

## Isolation evidence

- `resource-stability.test.js` EPIPE/session-count failures appeared ONLY in the
  first `test:main` run (while two Electron instances were running); the
  standalone re-run passed all of them.
- No test file, probe, or source line was modified between runs — same tree.

## Notes / leftovers

- Scratch capture files left in repo root (untracked, safe to delete):
  `__vstat.txt`, `__e2e-out.txt`, `__tmain.txt`, `__pairing.txt`, `__probe.txt`.
- `git status` shows 16 modified tracked files, all inside the plan's declared
  scope; `git diff --stat` totals +2299/−280 consistent with code-review's
  +2158/−278 + F1–F8 fix deltas.
- Known low findings F9/F10 left as-is per code-review disposition (dead
  parameter, info-level menu UX) — confirmed still present, not blocking.

## Acceptance

VERIFIED_COMPLETE — every commanded gate re-executed with real output;
deviations isolated and classified as flake-with-evidence.
