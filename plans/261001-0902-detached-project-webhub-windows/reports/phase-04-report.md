# Phase 4 Report — MCP Field Blockers (fix/classify)

**Date**: 2026-10-01 · **Plan**: `plans/261001-0902-detached-project-webhub-windows/plan.md` → `phase-04-mcp-field-blockers.md`
**Diagnosis**: `reports/phase-04-diagnosis.md` (source-trace, unchanged) + port-side D3 fix landed there
**Files changed this leg**: `src/main/browser/native-tab-host.ts`, `src/main/tools/browser-control-port.ts`, `test/main/navigation-waiter-commit-recheck.test.ts` (new), `test/main/browser-wait-deterministic.test.ts`, `test/main/target-stale-rebind-contract.test.ts`

---

## D1 — CAPTURE_FRAME_STARVATION on background capture: narrow Electron probe

**Probe** (throwaway, KmGate3 binding): `scripts/probe-unfocused-visible-capture.cjs` — plain visible `BrowserWindow` + presented `WebContentsView`, no app boot, no detach plumbing. rAF roundtrip mirrors `FRAME_LIVENESS_PROBE_EXPRESSION` (`tab-devtools-host.ts:92-99`; gate at `:2102-2167`), then CDP `Page.captureScreenshot {fromSurface:true}`. A second small window takes focus because `win.blur()` alone on Windows leaves the window focused when nothing accepts it (verified on the first run — `focused:true` persisted; win2 added). A minimized contrast row guards false positives.

**Run output (verbatim, `node scripts/run-electron.cjs scripts/probe-unfocused-visible-capture.cjs`, Electron 43.4.0 / Windows)**:

```text
=== UNFOCUSED-VISIBLE PROBE RESULTS ===
final document.visibilityState: visible
[
 { "phase": "A focused-visible (baseline)", "focused": false, "visible": true,  "minimized": false, "label": "raf",   "raf": true, "ms": 16 },
 { "phase": "A focused-visible (baseline)", "focused": false, "visible": true,  "minimized": false, "label": "shot",  "ok": true, "ms": 77,  "bytes": 18920 },
 { "phase": "B unfocused-visible",          "focused": false, "visible": true,  "minimized": false, "label": "raf-1", "raf": true, "ms": 8 },
 { "phase": "B unfocused-visible",          "focused": false, "visible": true,  "minimized": false, "label": "raf-2", "raf": true, "ms": 8 },
 { "phase": "B unfocused-visible",          "focused": false, "visible": true,  "minimized": false, "label": "shot",  "ok": true, "ms": 72,  "bytes": 17744 },
 { "phase": "C refocused (recovery)",       "focused": true,  "visible": true,  "minimized": false, "label": "raf",   "raf": true, "ms": 2 },
 { "phase": "C refocused (recovery)",       "focused": true,  "visible": true,  "minimized": false, "label": "shot",  "ok": true, "ms": 71,  "bytes": 18124 },
 { "phase": "D minimized (contrast)",       "focused": false, "visible": false, "minimized": true,  "label": "raf",   "raf": false, "ms": 315 },
 { "phase": "D minimized (contrast)",       "focused": false, "visible": false, "minimized": true,  "label": "shot",  "ok": true, "ms": 2152, "bytes": 16700 }
]
```

(One cosmetic caveat: the harness's own chromium resource warning `Failed to load …chrome_100_percent.pak` appears in stderr; it does not affect rAF/screenshot results. Phase A read `focused:false` because the probe window had not yet won OS focus — frame production still measured normally, and phase C confirms focused behavior.)

### Verdict: **Y — unfocused-visible produces frames**

A visible-but-unfocused presented pane answers rAF in ~8 ms (two consecutive probes, well under the 300 ms in-page bound) and `Page.captureScreenshot` settles in ~72 ms. Focus is not required for BeginFrames on Windows; the diagnosis's model holds. The minimized contrast row confirms the gate still discriminates: rAF starves (315 ms timeout → `false`) while the capture still lands late (~2.1 s). The frame-starvation remedy "focus or move the window" maps to **presented-vs-not-presented**, not focus — no `webContents` paint enforcement needed. D1 resolved as documented design-constraint; typed refuse stays for occluded/minimized/occluded-stacked targets.

---

## D2 — baseline certification gate

- **Producer found and named**: `promoteBaseline()` (`browser-control-port.ts:5852-5905`) → registered as `anti.visual.promote_baseline` + `browser.promote-baseline` (`browser-capabilities.ts:2917-2969`) → mints `vbase_*` via `BaselineAuthority.promote` → consumed by `visualCompare`'s `params.baselineRef` path (`browser-control-port.ts:6900-6953`, resolve + `verifyCaptureCompatibility` + real pixel diff).
- **Field error**: the session passed `baselineScreenshotRef`, which **permanently refuses** — a raw staged artifact carries no verification receipt, so compare settles INCONCLUSIVE regardless of content. Param left in the schema (removal is breaking; binding forbids it).
- **Edit applied** (`browser-control-port.ts:6954-6987`): refuse `reason`/`notes` now say "a staged screenshot artifact carries no baseline verification receipt. Remedy: call `anti.visual.promote_baseline` on the baseline tab …, then pass the returned `vbase_…` ref as `baselineRef`" — the dead-end "pending Phase 6 certification" text is gone.

Correct recipe for the field: `anti.visual.promote_baseline { tabId }` → `vbase_*` → `anti.visual.compare { tabId, baselineRef, expectedBaselineUrl, expectedTargetUrl }`.

---

## D3 — TARGET_STALE on committed navigations: both defects fixed

**Bug A (error-code mislabel)** — port side landed with the diagnosis leg (`browser-control-port.ts:1992-2007`); this leg fixed the twin site at `:3416-3422` (`browser.wait` `condition:'navigation'`): recorded cause is now thrown AS the `CapabilityError.code` (`failureCause as CapabilityErrorCode`), `[cause]` bracket prefix preserved. Pin re-set: `browser-wait-deterministic.test.ts:208-225` now asserts `NAVIGATION_TIMEOUT`.

**Bug B (missing committed-navigation re-check)** — `createNavigationLifecycleWaiter` (`native-tab-host.ts:10622+`):

- On **totalTimer** fire with `navStarted` (and on **startTimer** fire with `!navStarted`), the waiter now runs a bounded ~500 ms unref'd grace window instead of resolving false immediately. During grace, `did-finish-load`/`did-navigate-in-page` still complete the waiter; a `document.readyState === 'complete'` probe confirms early only when `wc.getURL()` matches the committed target — the requested URL, or the redirectChain tail once `did-start-navigation` has reset/repopulated it (handles redirects).
- **Correctness guards**: a WebContents destroyed mid-grace settles unclassified — **no failure record** — so the port's no-record path keeps meaning TARGET_STALE (target genuinely gone). The start-timeout recheck requires the URL match precisely because `readyState 'complete'` alone describes the OLD document.
- **Scope addition**: `reloadAndWait` → `createLoadCompletionWaiter` accepts an `onTimeout` hook and now records `{ cause: 'NAVIGATION_TIMEOUT', timedOut: true }` when the load waiter times out (`native-tab-host.ts:10520-10530`, `:10559`, `:10591-10601`). Cancel/load-fail arms stay unclassified.

### Wire-contract change (consumers must update retry tables)

Clients keyed on `TARGET_STALE` for "navigate/wait failed → rebind and retry" now receive **`NAVIGATION_TIMEOUT`** (and `NAVIGATION_START_TIMEOUT`, `LOAD_FAILED`, `NAVIGATION_BLOCKED` where recorded) from `browser.navigate`, `browser.wait condition:'navigation'`, and reload-driven paths that read the failure record. `TARGET_STALE` now means only "no recorded cause" (genuinely stale/dead target). Anything parsing the old blanket `TARGET_STALE` for navigation misses must re-key on the bracketed cause — which is now also the error code.

### Watch item

A **bare `TARGET_STALE` (no `[NAV_*]` bracket in the message)** post-fix is no longer produced by the navigation waiters — it implicates the `isCurrentTarget` epoch/lease path (`native-tab-host.ts:14866-14897`, checks `documentGeneration`/`browserEpoch`/`runtimeId`/project against the control-plane lease — authority identity, not tab liveness). If field symptoms recur without a bracketed cause, that is the producer to inspect.

---

## D4 — bound-tab authority invariant pinned

`target-stale-rebind-contract.test.ts` gained two pin cases:

- rebind to a foreign-project tab → `TARGET_MISMATCH` (capsule affiliation `proj-foreign/ws-foreign` ≠ target scope `proj-test/ws-test`).
- rebind to a same-project affiliated tab → allowed via `resolveTabAffiliation` even with `isTabAllowed → false` — the gate measures the tab's **capsule** project/workspace, not which window presents it, so a same-project tab presented by a detached shell remains rebindable (the detach-relevant nuance).

---

## Test evidence

- `npm run compile` — clean (earlier `stampProjectIdForMint` transient from sibling phase-01 work is gone).
- `node --test` on `.compiled` touched suites — **35/35 pass**:
  - `navigation-waiter-commit-recheck` (new, 6/6): navStarted+timeout+`readyState 'complete'`→true/no record; never-commit→false+`NAVIGATION_TIMEOUT`; destroyed mid-grace→false/no record; start-timeout recheck refuses old-doc `readyState` (`NAVIGATION_START_TIMEOUT`); start-timeout recheck passes on committed URL match; reload timeout→`NAVIGATION_TIMEOUT` record.
  - `browser-wait-deterministic` 18/18 (re-pinned twin case).
  - `target-stale-rebind-contract` 6/6 (incl. two new D4 pins).
  - `browser-navigate-error-codes` 5/5.
- `npm run test:main` — full lane, 174.8 s, **2214 pass / 2216** (1 skipped). Dispositions:
  1. `visual-compare-mask-ledger` — had pinned the old refusal wording verbatim (`'pending Phase 6 baseline authority certification'`). Pin deleted per the wording-test rule (the INCONCLUSIVE/ok/captureStateCompatible/maskResolution settle contract stays asserted); suite green in the final full-lane run.
  2. `project-window-shell-disposal` — `a shell whose chrome teardown lands reports no survivor` failed in BOTH full-lane runs: its 50 ms post-disposal audit deadline is too tight under suite load (`3 content(s) still alive 50ms after disposal`). **Not phase-04 code** — the suite and `project-window-shell.ts` come from committed plan-260930-0945 work (clean porcelain); it passes standalone. Pre-existing timing flake; owning sibling notified.

## Status

**DONE_WITH_CONCERNS** — all code/test/doc items landed and verified; D1 unfocused-visible confirmed at the Electron level (the detached-shell live leg remains a phase-05 probe row per plan). Concern: the wire-contract change is a deliberate behavioral break for callers keyed on `TARGET_STALE`-for-navigation (documented above); field integrations must be told.

## Waiter race (ERR_UNSAFE_PORT)

**Symptom** (FinalVerify, probe leg5b under concurrent e2e load): `browser.navigate` to `http://127.0.0.1:1/dwh-miss` answered `navigated:true` while `ERR_UNSAFE_PORT` was recorded; standalone re-run reports `LOAD_FAILED` correctly.

**Mechanism.** Chromium commits a `chrome-error://chromewebdata/` interstitial for a refused/unsafe-port load, and `wc.getURL()` on that error document reports the FAILED target URL (evidence: `reports/detached-webhub.json:206-211`, clean run's `viewState.url` is the miss URL after LOAD_FAILED). The phase-04 grace recheck probed `readyState==='complete'` + `getURL` match — both true on the error page — so when `did-fail-load` delivery slipped past the total bound under CPU contention, the probe resolved the waiter true off the interstitial. Same exposure on `did-finish-load`: error pages emit it, and no failure latch vetoed it. A third hole: `onFail` required `navStarted`, so a `did-fail-load` racing ahead of `did-start-navigation` was dropped entirely (mislabeled NAVIGATION_START_TIMEOUT later).

**Fix** (`native-tab-host.ts`, `createNavigationLifecycleWaiter`):
- `navFailed` latch set on any ATTRIBUTED main-frame `did-fail-load` (non-ERR_ABORTED): attributed when `navStarted` OR `validatedURL === committedTargetUrl` — covers start/fail reordering without letting the previous document's leftover failures veto a real commit.
- Every success arm (`did-finish-load`, `did-navigate-in-page`, grace readyState probe) checks `!navFailed`; `endGraceRecheck` skips the timeout record when the load-failed record already exists; `beginGraceRecheck` refuses to open on `navFailed`.
- The readyState probe expression now also requires `document.location.protocol !== "chrome-error:"` — error-page commits can never satisfy the commit recheck.
- Phase-04 guards preserved: destroyed-wc still settles unclassified (no record → TARGET_STALE), and the start-timeout recheck still requires `navStarted` + URL match so the OLD document can't false-positive.

**Evidence.** `test/main/navigation-waiter-commit-recheck.test.ts` gained `waiter failure veto — ERR_UNSAFE_PORT / error-page race` (4 cases): error-page-beats-fail-event → `res:true` before fix (exact flake repro), `LOAD_FAILED`+false after; pre-start `did-fail-load` on the target → `NAVIGATION_START_TIMEOUT` before, `LOAD_FAILED` after; unattributed pre-start failure still allows a real commit; subframe `did-fail-load` ignored during grace. Full file 10/10; siblings `browser-wait-deterministic`, `browser-navigate-error-codes`, `detached-project-window|lifecycle|restore`, `split-review-tabhost`: 99/99.

**Residual.** A `did-finish-load` for the error page would only false-succeed if Chromium delivered it BEFORE `did-fail-load` on the same frame channel — not observed; every reproduced arm lands the failure event or an error document the probe now rejects.
