# Certification Run — Unit/E2E Suites (Phase 11)

- **Date:** 2026-09-29
- **Runner:** CertRunner (QA subagent)
- **Method:** `node --test .compiled/test/<file>.js`, sequential, one process per suite
- **Result:** **10/12 suites PASS · 2/12 FAIL** (both deterministic — re-ran, identical failures)

## Suite Results

| # | Suite (compiled path) | Tests | Pass | Fail | Duration | Verdict |
|---|---|---|---|---|---|---|
| 1 | `test/main/terminal-output-router.test.js` (P4 router) | 8 | 7 | 1 | 320ms | FAIL |
| 2 | `test/renderer/terminal-lazy-pane.test.js` (P7 lazy xterm) | 4 | 4 | 0 | 3754ms | PASS |
| 3 | `test/unit/browser/terminal-backpressure.test.js` (P8) | 5 | 5 | 0 | 446ms | PASS |
| 4 | `test/unit/terminal-daemon/output-batcher.test.js` (P5) | 7 | 6 | 1 | 307ms | FAIL |
| 5 | `test/unit/browser/tab-hibernation.test.js` (P9) | 20 | 20 | 0 | 2659ms | PASS |
| 6 | `test/unit/browser/terminal-sleep-lifecycle.test.js` (regression) | 10 | 10 | 0 | 1332ms | PASS |
| 7 | `test/unit/native-tab-host-presented-view.test.js` (hibernation view) | 14 | 14 | 0 | 1237ms | PASS |
| 8 | `test/unit/browser/terminal-transcript-lifecycle.test.js` | 10* | 10 | 0 | 350ms | PASS |
| 9 | `test/e2e/terminal-daemon-batching.test.js` (batch ordering e2e) | 1 | 1 | 0 | 14000ms | PASS |
| 10 | `test/main/project-rename-remove.test.js` (P10 CRUD) | 5 | 5 | 0 | 1803ms | PASS |
| 11 | `test/renderer/project-open-picker.test.js` (P2/P10 picker) | 11 | 11 | 0 | 3562ms | PASS |
| 12 | `test/main/terminal-daemon-provenance.test.js` | 6 | 6 | 0 | 2895ms | PASS |

**Totals: 111 tests, 109 pass, 2 fail.** Total wall ≈ 44s.

\* Assignment said 46 tests; actual leaf tests = 10 (3 nested suites + root). Assignment counts were stale vs. current source.

## Path Corrections (assignment paths vs. actual)

- #1 `test/unit/browser/terminal-output-router.test.js` → actually `test/main/terminal-output-router.test.js`
- #7 `test/unit/browser/native-tab-host-presented-view.test.js` → actually `test/unit/native-tab-host-presented-view.test.js`

## Failures (deterministic; first error line + root cause)

### FAIL 1 — P4 router: listener-count invariant vs. P6 detach-on-empty
- **Test:** `20 register/unregister cycles keep the seam listener counts flat`
- **First error:** `AssertionError [ERR_ASSERTION]: data listener count must not grow per host — 0 !== 1` at `test/main/terminal-output-router.test.ts:220`
- **Root cause:** `src/main/browser/terminal-output-router.ts:166` — `unregisterHost` calls `this.detach()` when `hosts.size === 0` (deliberate P6 pruning: "The last host out leaves no consumer for the seam"). Post-loop `seam.listenerCount('data')` is legitimately **0**; the test asserts `=== baseline` (1). Behavior is correct per the new contract — **the test predates detach-on-empty and needs updating** (assert `<= baseline` / `=== 0` when empty), not the implementation. Notified P6Broadcast.

### FAIL 2 — P5 batcher: quiet-window fast path uses adaptive window
- **Test:** `a chunk after a quiet flush window is emitted immediately so echo never waits`
- **First error:** `AssertionError [ERR_ASSERTION]: deepStrictEqual ['a'] !== ['a','b']` at `test/unit/terminal-daemon/output-batcher.test.ts:34`
- **Root cause:** `src/main/terminal-daemon/output-batcher.ts:100` — `push()` checks `now - last >= win` where `win` is the **adaptive** window (`1.5 × gap`, clamped). With steady cadence `g`, `win = 1.5g > g` always, so a chunk arriving after a quiet ≥`flushMs` window is **buffered, never sent immediately** — the echo-latency guarantee is dead code. Fix: compare elapsed against `this.flushMs`; `win` should govern only the batch timer/size. Notified P6Broadcast for ownership routing.

## Notes
- Both failures sit in mid-flight slices: phase-05 `in-progress` (batcher), phase-06 `todo` (pruning — change already partially landed).
- No flake observed: re-ran both failing suites, identical failures.
- Perf harness gates (main p99, statSync data path, WS frames, keystroke p95, RSS) **not run** — assignment covered unit/e2e suites only.
- Full TAP logs: `reports/cert-logs/*.log` (runner: `cert-logs/run-suites.sh`).

## Unresolved
- Router test update ownership (P6Broadcast pinged).
- Phase-11 perf harness + `test/e2e/project-windows` N=3/N=7 gate run still outstanding — metrics table required by success criteria not yet produced.
