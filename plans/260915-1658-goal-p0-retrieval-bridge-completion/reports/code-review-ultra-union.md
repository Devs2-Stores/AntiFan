---
title: Code review — P0→P1 retrieval-bridge completion (ultra, best-of-5)
status: report
date: 2026-09-16
scope: efa14a6~1..HEAD (base 43ffb89, head 8eeaca8; accepted revision 2985471)
method: ak:code-review --ultra
---

# Code review — ultra (best-of-5), P0→P1 retrieval-bridge completion

## What was reviewed

`ak:code-review --pending --ultra` was invoked with an empty pending diff — the change set had
already been committed and pushed — so the resolved target is the committed range
`efa14a6~1..HEAD`: 87 files, +14435/−458, three commits (`efa14a6` code, `2985471` health +
reuse metric + ladder, `8eeaca8` docs only). A `--pending` review would also have missed every
new untracked file; the committed range covers all of them.

**Method disclosure.** This host is single-model, so `--ultra` ran as **same-tier best-of-5**
(independent samples + rubric selection), not asymmetric verification. Five independent
read-only reviewers received one identical evidence packet; a sixth agent (Kongming) acted as
verifier. Per this skill's asymmetric finalizer, the result is the **evidence-validated,
deduplicated union** of findings — not a winning review.

## Stage 1 — spec compliance: PASS

Every changed file maps to the approved contract's eight phases and the 31 items. No criterion
was relaxed: the ladder's Final condition (`PASS == 31 AND NOT_IMPLEMENTED == 0 AND BLOCKED == 0`)
holds at 31/31 with revision-bound receipts. No unrequested feature was found; the one dependency
addition (`jsdom`, a declared devDependency) is justified by six tests that silently skipped
without it.

## Stage 2 — reviewer scores (1–20 per criterion, max 140)

| Candidate | C1 correctness | C2 regression | C3 tests | C4 scope | C5 verification | C6 security | C7 precision | Total |
|---|---|---|---|---|---|---|---|---|
| A | 19 | 19 | 18 | 15 | 19 | 19 | 20 | **129** |
| B | 17 | 18 | 15 | 13 | 18 | 18 | 20 | **119** |
| D | 17 | 14 | 17 | 13 | 16 | 13 | 20 | **110** |
| C | 17 | 15 | 16 | 15 | 17 | 13 | 16 | **109** |
| E | 12 | 11 | 12 | 12 | 10 | 12 | 18 | **87** |

Ranking: A (8/8 validated, both HIGHs, live production-store probe) → B (5/5 validated, unique
PID-recycle kill) → D (6/6 validated, perfect precision) → C (6/7, one over-reach) → E (5/5
validated but all restatements with asserted-not-shown evidence). 31 candidate findings were
validated against the repo: **30 confirmed, 1 dropped**. The verifier's validation is decisive
here — candidate E scored lowest yet contributed a unique confirmed finding, which is exactly why
the finalizer is a union rather than a winner.

**Dropped:** Candidate C #6 (`receiptV2`'s `NO_PACK` unreachable) — not a defect. `NO_PACK` is the
intended default for the no-`packId` path, and the claimed path is unreachable: `receipt()` throws
`unknown packId` before the branch for a nonexistent id.

## Validated union — 2 HIGH, 6 MEDIUM, 7 LOW

### HIGH

**1. Regression phase gate passes on a never-replayed caller-supplied PASS — live on the production store**
`packages/super-core/src/index.ts:938-943` · found by A, B

`passed = lastReg?.replayResult === 'PASS' ? 1 : 0` never requires `replayedAt`, contradicting the
invariant this change set introduced ("a regression with no replay has `replayResult` NULL and
fails the gate closed"). Migration 6→7 added `replayedAt` but left pre-existing asserted values in
place.

I reproduced this independently against a **copy** of the production store (never the live file):

```
newest regression row: {"regressionId":"reg-52eeb5d3-13fb-4320-8dff-76dd32c4ff0b",
                        "replayResult":"PASS","replayedAt":null,
                        "createdAt":"2026-09-15T01:58:16.239Z"}
checkPhaseGate(regression, {record:false}) ->
  {"passed":true,"detail":"last regression: PASS at null"}
VERDICT: CONFIRMED
```

So `health()` reports a green regression gate, and `getRegressions()` reports `LAST_REPLAY_PASSED`,
on a value that was never produced by `replayRegression()`. **Fix:** require `replayedAt IS NOT NULL`
(and `replayDetailJson`) for a pass, and re-replay or quarantine the legacy row.

**2. Core Health can never report HEALTHY; the "all gates pass" test uses an unreachable fixture**
`src/main/diagnostics/core-health.ts:336-343` + `packages/super-core/src/index.ts:993` · found by A, D

`health()` deliberately emits `uncertainty: { level: 'UNKNOWN', reason: 'unscoped: …' }` — a
defensible producer decision, since uncertainty is per-task, not corpus-wide. But the consumer folds
that into the status: `core-health.ts` pushes a `core.uncertainty` check with `status: 'UNKNOWN'`,
and `STATUS_RANK` ranks `UNKNOWN` (1) above `HEALTHY` (0), while `worstOf` returns `HEALTHY` only
when *every* check is HEALTHY. Since the producer's level is always `UNKNOWN`, HEALTHY is
unreachable — the toolbar badge and Overall Core Health item permanently show UNKNOWN on a healthy
store, disagreeing with the CLI/MCP surface the shared composition exists to keep in lockstep.

The test that asserts `all gates pass → HEALTHY` passes only because its fixture stubs
`uncertainty.level: 'STRONGLY_SUPPORTED'` — a value the real producer cannot emit. It therefore
asserts a state the shipped code cannot reach. **Fix:** exclude the unscoped-uncertainty check from
`worstOf` (or have `health()` give it a real corpus level), and change the fixture to the
producible `UNKNOWN` shape so the test exercises production input.

### MEDIUM

**3. `judgeTestRoute` passes routes that executed zero assertions or exited non-zero** —
`scripts/goal/ladder/p0-p1.mjs:113-124` · found by A, B, C, E
Reproduced: an all-`t.skip` file under `--test-reporter=tap` emits `ok N - name # SKIP`, `# pass 0`,
`# fail 0`, exit 0; `parseTap` collects the SKIP name, so `actualNames` is non-empty and the route
judges PASS with zero assertions run. Routed files contain live skip guards
(`core-health-hub.test.ts` jsdom guards; `core-health-service.test.ts` tsc-build guard), so
items #11–#15/#28/#29 can PASS on scaffolding in an environment missing jsdom. `judgeTestRoute`
also never inspects `res.status`, so a non-zero exit with a clean TAP summary yields PASS while the
receipt reports `exit != 0`. **Fix:** strip ` # SKIP` names, require `out.pass > 0`, and FAIL when
`res.status !== 0`. This is the scaffolding-PASS class the harness exists to prevent.

**4. `finalHolds` omits FAIL, so a retained orphan FAIL does not block Final** —
`scripts/run-goal-ladder.mjs:130` · found by C, D, E
The expression checks `PASS == 31`, `NOT_IMPLEMENTED == 0`, `BLOCKED == 0` — no FAIL term — while
`mergeLadder` retains judged orphan units and the tally counts them. Renaming away a FAILed item
yields `{PASS:31, FAIL:1}` with `finalHolds` true and exit 0; the drift detector watches only the
criteria markdown, not the executable spec's item ids. **Fix:** add `(tally.FAIL ?? 0) === 0`.

**5. Refused compare receipts are no longer classified as compare-receipt by the report builder** —
`src/main/verification/visual-capture.ts:1516` → `scripts/lib/build-report.mjs:533,1130` · found by A
The change makes refused/INCONCLUSIVE compare paths emit `mismatchPercentage: null`, but the
consumer still classifies a document as `compare-receipt` only when
`isNum(num(json.mismatchPercentage))`, and `num(null)` is null. A refused compare artifact is
therefore invisible to `driftDocFor` — a refused ref-vs-ref drift check silently drops out of the
report instead of surfacing as invalid. **Fix:** classify on `captureReceipts`/status rather than on
a numeric percentage being present.

**6. Bridge receipt-required set covers 8 of 28 mutating dispatch entries despite the "mirrors" comment** —
`.omp/hooks/pre/antifan-core-bridge.ts:122-147` · found by B, C, D, E
The bridge table has exactly 8 keys; `CORE_DISPATCH` declares 28 mutating entries. Fail-closed is
preserved (`invokeCore` still throws `CORE_UNAVAILABLE`), so the impact is missing
`REFUSED_CORE_UNAVAILABLE`/`BRIDGE_ACTION_REFUSED` audit events plus a false comment — not a
fail-open. **Fix:** derive the set from `CORE_DISPATCH`'s mutability flags.

**7. Supervisor stale-kill can kill an unrelated process on PID recycling** —
`scripts/goal/supervisor.mjs:175-184` · found by B
`isProcessAlive(pid)` is the only check before `killProcessTree`. If the runner dies and its PID is
recycled within `heartbeatStaleMs` (180 s) while its heartbeat stays attributable, an innocent
process tree is force-killed — the same defect class as closed bottleneck B12. **Fix:** re-verify
lock pid+runId, or compare process start time against the heartbeat timestamp.

### LOW

8. **THRESHOLD_DIGEST misses four live bounds; the completeness guard is uncalled and inverted** —
   `scripts/goal/thresholds.mjs:82-106` · A, C, E
   `FROZEN_KEYS` lists 7 of 11 thresholds, omitting `heartbeatIntervalMs`,
   `supervisorTermGraceMs`, `supervisorPollIntervalMs`, `mutexLeaseMs`; `assertThresholdsComplete`
   checks `FROZEN_KEYS ⊆ THRESHOLDS` (the inverse of its docstring) and has zero callers.
9. **`routes: []` passes vacuously with a bound-looking receipt** — `scripts/goal/ladder/p0-p1.mjs:285-293` · B, D
   Empty results → `worst` undefined → verdict PASS, `allExitedZero` vacuously true, and
   `routeIdentity: ''` is non-null so it satisfies the receipt check. Latent (all 31 declare routes).
10. **POSIX tree-kill is leader-only in both kill paths; Windows is correct** —
    `scripts/goal/supervisor.mjs:65-80`, `scripts/goal/ladder/p0-p1.mjs:199-207` · A, C, D
    `process.kill(-pid)` needs a process-group leader and nothing spawns detached, so the fallback
    kills only the leader, orphaning children the comment claims die too.
11. **`reuseMetric`'s "latest pack" is stale when a deduped pack is re-issued** —
    `packages/super-core/src/index.ts:1013-1016` · A
    The dedupe upsert refreshes `claimIdsJson` without touching `createdAt`, so a re-issued older
    pack keeps its original timestamp.
12. **`openCoreDb` has no production caller** — `scripts/goal/core-db.mjs:19-35` · A
    Only its own tests use it; it bypasses Core's migration path.
13. **`spawnRoute` buffers child stdout/stderr unbounded** — `scripts/goal/ladder/p0-p1.mjs:181-186` · D
    No cap, unlike the bridge's `MAX_OUTPUT_CHARS`.
14. **`mcp-health-metrics` probe leaks its temp store directory** — `scripts/goal/ladder/probes/mcp-health-metrics.mjs:55` · E
    Sibling probes `rmSync` their scratch; this one does not.
15. **`KNOWN_PLATFORMS` is a dead export; the backfill SQL hardcodes the same names** —
    `packages/super-core/src/schema.ts:10` · C

## Verdict

**Not production-ready as-is.** The change set is substantively correct — migrations are atomic,
the bridge fails open on a hook with a single named event, the parity gate is real, no test was
weakened (the only 4 removed test lines are one import consolidation and three assertions that
pinned a fabricated `mismatchPercentage: 100`, re-pinned to the corrected `null`), and the ladder
reproduces 31/31 with revision-bound receipts. But two shipped invariants do not hold: the
regression gate fails open on a row that exists in the live store, and the health surface can never
report HEALTHY. A third defect sits in the acceptance harness itself — the judge can mint PASS on a
zero-assertion route, which is the scaffolding-PASS class the contract forbids.

Recommended fix order: (1) `replayedAt IS NOT NULL` in the regression gate → (2) the
unscoped-uncertainty check in `getSnapshot` (plus its fixture) → (3) `pass > 0` and exit-code
checks in `judgeTestRoute` → (4) the FAIL term in `finalHolds`. Items 1, 3 and 4 are integrity
gates, so each must ship with a fail-before proof. After fixing 1–3 the acceptance ladder must be
re-run, because items #25/#27 and the health items are exactly the ones whose receipts would
otherwise certify behaviour that has changed.

Verifier confidence: high — every union entry was confirmed against the repo, both HIGHs
reproduced live, and the single dropped finding was disproven by reading the code path.

## Verification performed by the controller

- Stage 1 spec compliance: PASS (mapping of all 87 files to the approved contract).
- Both HIGHs confirmed independently at source (`index.ts:938-943`, `index.ts:993`,
  `core-health.ts:339-340`, `STATUS_RANK`/`worstOf` at `core-health.ts:148-161`) and the
  production-store claim reproduced against a copy of `.super-core/core.db`.
- Aggregate gates re-run: `check-bottlenecks` OK · `check-mcp-budget-dominance` OK
  (121 advertised / 51 dispatched / 242 catalogue) · `check-plans` 512 classified.
- Tree unmodified by the review itself: `git status --porcelain` showed only the pre-existing untracked
  `Storefront/`, `issue172_dom.html`, `issue172_pristine.html`.
- The review changed no code. The fixes below were applied afterwards, so the pipeline results in the
  phase-08 handoff describe the revision *before* them.

# Fixes applied (disposition of the union)

Authorised scope: both HIGHs plus the four harness integrity items. The other nine MEDIUM/LOW entries
were left as recorded findings.

## 1. Regression gate fails open — FIXED

- `packages/super-core/src/index.ts:945` — a verdict now counts only when a replay produced it:
  `passed = lastReg?.replayResult === 'PASS' && lastReg.replayedAt != null`. A `replayResult` without a
  `replayedAt` gets its own detail string ("asserts PASS with no replay — not adjudicated") instead of
  being read as a failure or a pass.
- `packages/super-core/src/schema.ts` — `SCHEMA_VERSION` 7 → 8 and migration `7 -> 8` withdraws the
  assertion from rows that were never replayed:
  `UPDATE regressions SET replayResult = NULL WHERE replayedAt IS NULL AND replayResult IS NOT NULL`.
  The row keeps its definition and reads as "recorded but never replayed".

Fail-before (pre-fix code, copy of the production store):

```
newest row: reg-52eeb5d3-… | replayResult "PASS" | replayedAt null | 2026-09-15
checkPhaseGate(regression) -> {"passed":true,"detail":"last regression: PASS at null"}
```

Pass-after (same input, current code):

```
after the 7->8 migration: {"replayResult":null,"replayedAt":null} | schemaVersion 8
checkPhaseGate(regression) -> {"passed":false,"detail":"last regression recorded but never replayed"}
asserted PASS inserted directly at v8 (migration bypassed)
  -> {"passed":false,"detail":"last regression asserts PASS with no replay — not adjudicated"}
after a real replayRegression() -> adjudicated on the observed verdict
```

Consequence, stated plainly: `health()` now reports the regression gate as **failed** on the live store,
because the live store genuinely has no replayed regression. That state is truthful rather than
comfortable. A `replayRegression()` against a real store flips it back.

## 2. Core Health could never report HEALTHY — FIXED

- `src/main/diagnostics/core-health.ts` — `CoreHealthCheck` gains an optional `gating` flag and `worstOf`
  folds only gating checks, so the unscoped-uncertainty check is still reported but cannot decide the
  aggregate. The producer's deliberate `UNKNOWN` stays as it is: uncertainty really is per-task, so a
  corpus-wide confident level would be a fabrication.
- The test fixture in `test/unit/core-health-service.test.ts` now supplies the shape the producer
  actually emits (`UNKNOWN` + the unscoped reason), not an unreachable confident level.
- `packages/super-core/src/core.test.ts` pins that producer shape
  (`uncertainty.level === 'UNKNOWN'`, reason matching `/unscoped/`) so the two cannot drift apart again
  — the drift that hid this defect was a test asserting a state the producer cannot reach.

Fail-before — corrected fixture against the unchanged consumer:
`expected: 'HEALTHY'`, `actual: 'UNKNOWN'` (13/14).

Pass-after — same fixture, fixed consumer: 14/14.

End-to-end seam (real store driven green by real state changes → real `health()` → real compiled service):

```
PRODUCER health(): HEALTHY | ALL_GATES_PASS | gates all passed: true
  uncertainty: {"level":"UNKNOWN","reason":"unscoped: uncertainty is per-task/claim, not corpus-wide"}
CONSUMER getSnapshot(): HEALTHY | ALL_GATES_PASSED
  core.uncertainty check: {"status":"UNKNOWN","gating":false,"reasonCode":"INSUFFICIENT_EVIDENCE"}
SEAM: CONFIRMED — a healthy store now surfaces as HEALTHY
```

## 3. Harness integrity items — FIXED

- `judgeTestRoute` now takes the exit status and fails a route that exited non-zero under a clean TAP
  summary (`ROUTE_NONZERO_EXIT`), and fails a route that executed no assertions
  (`ROUTE_EXECUTED_NO_ASSERTIONS`) — which covers a pattern matched only by skip-guarded tests.
- `parseTap` strips the `# SKIP`/`# TODO` directive so a skipped test is not counted as a passing name,
  and reports a `skipped` count.
- `item()` fails closed on `routes: []` with `NO_ROUTES_DECLARED`, and exposes the declared `routes` so
  the declaration stays inspectable.
- `finalHolds` moved to `scripts/goal/ladder/final.mjs` as a testable `finalHoldsFor(tally, missing)`,
  and now requires `FAIL === 0`. A judged orphan FAIL retained after a spec edit could previously
  coexist with `PASS == 31`.
- `scripts/goal/thresholds.mjs` freezes all 11 bounds (not 7), inverts `assertThresholdsComplete` to
  check `THRESHOLDS ⊆ FROZEN_KEYS` as its docstring always claimed, and calls it at module load.
  Freezing `heartbeatIntervalMs`, `supervisorTermGraceMs`, `supervisorPollIntervalMs` and `mutexLeaseMs`
  changes `THRESHOLD_DIGEST`, so checkpoints written under the old bounds refuse to resume — intended.

Fail-before: reverting the four fixes fails exactly the five tests that encode those defects
(tests 1, 2, 3, 7, 9 of `test/unit/goal-ladder-judge.test.mjs`), with the file restored byte-exactly.
Pass-after: 9/9.

## Verification of the fixes

| Check | Result |
|---|---|
| super-core suite (migration, gate, health) | 24/24 — includes the quarantine asserted against a copy of the real populated store |
| goal unit tests (`goal-runner`, `goal-safety`, `goal-ladder-judge`) | 48/48 |
| health service (compiled) | 14/14 |
| acceptance ladder, `ladder-bound` @ `07ae15f` | **31/31 PASS, `finalHolds: true`**, all receipts `exit: 0`, 31 distinct `finishedAt`, no empty `routeIdentity` |
| full pipeline | 5 of 7 lanes pass |

The ladder result is *stronger* than the pre-fix one: the judge that certifies it is now stricter
(executed assertions required, zero exit required), and the 31 PASSes survive that.

### Lane failures, attributed

- `test:main` — `bridge-pairing-queue-concurrency` fails at ~30.2s. **Not caused by these fixes.**
  Measured both ways: with the fixes the full lane fails and the file alone passes (7.4s); with
  `core-health.ts` reverted to HEAD the full lane still fails (30.2s) and the file alone passes (8.7s).
  It fails only under lane-level parallelism.
- `test:e2e` — `theme-golden-live` (`structuralDelta: 1` vs 0). **Flaky and live-gated**: two subsequent
  standalone runs were 7/7, exit 0. Same lane class as B23/L1/L2.

### Revision binding — resolved

The first post-fix run (`ladder-postfix`) was discarded: its receipts named `8eeaca8`, a revision that
does not contain the fixes, so it verified behaviour without binding to it. The fixes are committed as
`07ae15f`, and the acceptance ladder was re-run on a clean tree against that revision:

```
run ladder-bound: status completed | finalHolds true | pass 31/31 | unboundPasses []
receipt gitShas: 07ae15f02719a5727a6c330cc7bc0e9f99ea621a   (= HEAD)
receipt exits: 0 | 31 distinct finishedAt | durationMs 48103
```

All 31 receipts now name the commit that contains the code they exercised.

## Round 2 — the remaining nine entries

Committed as `1e77fbc`, `e4cb667`, `3aac318`, `1745e37`, `b93dadf`, `d22c869`.

| Entry | Fix | Evidence |
|---|---|---|
| **5. Refused compare receipts unclassified** | `scripts/lib/build-report.mjs` gains an `isCompareReceiptDoc` shape predicate, applied at both gates (`classifyDocument`, `loadHistorical`) | `ref-vs-ref-1440.json` classified `other` → `compare-receipt`; a standalone capture and a garbage percentage still do not classify |
| **6. Bridge receipt set covered 8 of 28 mutating ops** | the required-receipt maps now cover 28 canonical ops and 29 CLI commands, and `test/unit/bridge-receipt-coverage.test.mjs` derives the mutating set from `CORE_DISPATCH` (51 entries, 28 mutating) and the CLI switch (55 arms), so a new mutating op without a receipt fails the test | fail-before `core.recommend must be refused (advertised name)`; pass-after 1/1, `context-bridge` 15/15 |
| **7. Supervisor stale-kill on pid recycling** | `scripts/goal/supervisor.mjs` re-proves pid identity (OS start time bound to the newest heartbeat/lock evidence, plus the adoption-time start token) before any kill; a recycled or unverifiable pid is refused as `gone` | fail-before: a stale attributed heartbeat naming a live innocent pid force-killed it; pass-after: verdict `gone` / `RUNNER_PID_RECYCLED`, target alive; positive control: a genuine stale tree still killed, runner and grandchild dead |
| **POSIX tree-kill leader-only** | both kill paths now signal the group (`kill(-pid)`) with a pid fallback, next to a detached spawn, matching contract and comments | with `GOAL_ROUTE_TIMEOUT_MS=3000` on a route spawning a heartbeat grandchild: `FAIL/ROUTE_TIMEOUT` and the grandchild's heartbeat froze, i.e. the signal reached it |
| **11. `reuseMetric` picked a stale pack** | v9 adds `packs.lastIssuedAt`; the upsert sets it in both the INSERT and the `DO UPDATE`, and the pick orders `COALESCE(lastIssuedAt, createdAt) DESC, rowid DESC`; the CLI pack list uses the same order | new test pins the timestamps through raw `DatabaseSync`: the re-issued pack wins, and a NULL `lastIssuedAt` row still falls back to `createdAt`. Package suite 26/26 |
| **12. `core-db.mjs` had no production caller** | deleted; the locked concurrent-access mode it duplicated is covered against the public surface in `packages/super-core/src/core.test.ts` | zero importers across `scripts/ src/ test/ packages/ .omp/`; the three goal test files 46/46 |
| **13. `spawnRoute` buffered output unbounded** | `MAX_ROUTE_OUTPUT_CHARS = 512 * 1024` tail, judged lines captured verbatim, a marker naming the dropped bytes | 1,191,306 → 667,012 bytes with the marker present, the verdict unchanged; a verbose PASS route stays PASS |
| **14. `mcp-health-metrics` leaked a temp store** | removed on every exit path | temp count 16 → 16 on the PASS and NOT_IMPLEMENTED paths; was 15 → 16 |
| **15. `KNOWN_PLATFORMS` was a dead export** | `PLATFORM_BACKFILL_SQL` is derived from it, so the backfill and the known set cannot drift | the generated SQL is byte-identical to the hardcoded text it replaces |

### Advisory batch — dispositions

- **CLI `gate` recording.** Kept read-only by default, because the observed harm was an inspection probe appending gate rows to a live store and no repo caller records through the CLI. It is no longer silent: the command prints a note on stderr and `{"record":true}` records exactly as before. The MCP surface keeps recording.
- **`core-db.mjs`.** Deleted, per the entry above.
- **StoreOrdering wiring.** Verified rather than trusted: the INSERT column list, the `DO UPDATE` clause and the pick order are all present.
- **Icon weight.** The six emoji were replaced with authored SVG, and the advisory was right that they must match the row's dominant weight — measured, the first filled set read as solid blocks next to the row's thin chevrons, and an isolated icon sheet (rendered from the live markup, at size) showed the filled phone reading like a flash drive. The monitor, phone and shield are now thin silhouettes; the avatar and the sparkle stay solid because they sit inside filled badge chips.
- **`.btn-theme-qa` leaks outside the row.** It is the only tokenised class used outside `.toolbar` (the QA modal's Re-run button), so it carries `var(--tb-h, 28px)` and `var(--tb-r, 6px)` fallbacks. `device-select`, `zoom-step-btn` and `split-pane-pill` are row-only.
- **Split mode was never measured.** Forcing the *real* split state (split tracks and phone pill visible, global preset select hidden as `toolbar.ts` hides it) exposed a 406px overflow at 900px that the resting-state audit could not see. The row now compresses instead: preset tracks cap at 108px/76px, and two labels drop at ≤1024px. See the table below.

## Toolbar row — measured before and after

The harness renders the real `toolbar.html` + `toolbar.css` in Electron and measures geometry at four widths, in both the resting and split states.

| Metric | Before | After |
|---|---|---|
| Control heights | `[16,18,22,24,26]` | `[16,24,28]` (16 = the text field inside a 28px track) |
| Radii | `[0,4,5,6,14,50%]` | `[0,5,6,8,50%]` |
| Font sizes | `[11,11.5,12,13,13.3333]` | `[12]` |
| Gap rhythm | `[1,2,5,6,8,23,26,33.89,37]` | 4px within a cluster, 8px between clusters, 2px tight |
| Bordered panels in the row | 5 | 0 (clusters are transparent; only real tracks draw a box) |
| Overflow at 900px, split mode | 406px | **0** |
| Overflow, resting, 900–1440px | 0 | 0 |
| Unlabelled controls | 1 (`urlInput`) | 0 |
| Disabled contrast | 2.49:1 | 3.84:1 |

Two measurement defects were found and fixed in the harness itself, because a wrong measurement is worse than none: zoom is persisted per origin, so a zoom left by an earlier probe silently shrank the layout viewport (1440 content px at 3x = 480 CSS px) and invalidated a whole round of numbers; and a media-query override declared above the rule it overrides loses on source order even with `!important`, which is why the first width ladder had no effect. The ladder now sits after every base rule.

### The split-mode numbers, reproduced

An earlier round of split-mode numbers (152px at 1200, 282px at 1024, 406px at 900) is **superseded**: that
run left the global preset select visible, and the app hides it while split is on, so those figures
carried a control the app never renders — 175px of it at 1200 and 112px at 900, which is the whole
difference. The state is now forced exactly as `toolbar.ts` applies it (`splitControlsContainer` flex,
`deviceSelect` none, `mode-active` on the toggle), plus the phone-status pill visible as the worst case,
and the harness prints the state it applied so a run cannot silently measure the wrong one:

```
node scripts/run-electron.cjs .canary/tools/toolbar-measure.cjs           # resting
TOOLBAR_MEASURE_SPLIT=1 node scripts/run-electron.cjs .canary/tools/toolbar-measure.cjs
```

```
resting  w=1440 n=17 heights=[16,24,28] overflow=0 unnamed=0 fonts=["12px"]   console errors []
resting  w=1200 n=17 heights=[16,24,28] overflow=0 unnamed=0 fonts=["12px"]
resting  w=1024 n=17 heights=[16,24,28] overflow=0 unnamed=0 fonts=["12px"]
resting  w=900  n=17 heights=[16,24,28] overflow=0 unnamed=0 fonts=["12px"]
split    w=1440 n=21 heights=[16,24,28] overflow=0 unnamed=0 fonts=["12px"]   splitState {"split":"flex","device":"none","toggleActive":true,"phone":""}
split    w=1200 n=20 heights=[24,28]    overflow=0 unnamed=0 fonts=["12px"]
split    w=1024 n=21 heights=[16,24,28] overflow=0 unnamed=0 fonts=["12px"]
split    w=900  n=20 heights=[24,28]    overflow=0 unnamed=0 fonts=["12px"]
```

The icon work is closed on the in-context reading rather than the isolated sheet: at 1x the row's
utility marks read as one thin-outline family, and the marks that still carry mass are the ones that are
meant to — the avatar chip, the status dots, and the lock the omnibox already had.

## Verification (round 2)

| Check | Result |
|---|---|
| super-core package (migration, gate, reuse ordering, concurrent access) | 26/26 |
| goal `mjs` batch (`goal-ladder-judge`, `goal-safety`, `goal-runner`, `bridge-receipt-coverage`, `context-bridge`) | 62/62 |
| compiled TS batch (health service, hub, tab-layout invariants, ipc-audit, vault, dev-watcher) | 87/87 |
| acceptance ladder @ `d22c869` (HEAD) | **31/31 PASS, `finalHolds: true`**, `unboundPasses: []`, all exits 0, `durationMs` 56340 |
| full pipeline | all lanes passed on one of three post-commit runs — `compile` 5.6s, `test:canary` 28.5s, `test:fast` 56.6s, `test:site-clone` 17.0s, `test:integration` 1.8s, `test:main` 106.0s, `test:e2e` 20.0s. The other two runs had `test:e2e` fail (once with `test:fast`); see the `test:e2e` note below. |

The ladder ran four times in this round — `3aac318` (35.6s), `1745e37` (36.3s), `b93dadf` (54.0s) and
`d22c869` (56.3s) — each 31/31. A run is superseded whenever a commit touches a file a route executes,
because a receipt names the revision it exercised: the second run followed a new case in the hub test
that two routes run, and the third and fourth followed cases added to the health-service test that
three routes run.
The summary of the final run is committed next to this report as `ladder-run-union-fixes.json`.

Both lanes that failed in the round-1 pipeline (`test:main`'s pairing-queue file and `test:e2e`'s
theme-golden-live) passed here, which is consistent with the round-1 attribution: they fail under
lane-level contention, not because of these changes.

A test was added for the branch the health surface and the hub both got wrong: a regression row whose
recorded verdict is FAIL reads as `DEGRADED` even when it carries no replay stamp, while an asserted
PASS no replay produced does not read as green. The service side is covered in
`test/unit/core-health-service.test.ts`; the hub side, which derives the same status from the same CLI
rows, is covered in the new case in `test/renderer/core-health-hub.test.ts`.

**Do not run the acceptance ladder and the pipeline at the same time.** A first ladder run stalled for 18 minutes on `p1/root-cause-ui`: that route executes a file under `.compiled/`, and the pipeline's `compile` lane was rewriting `.compiled/` underneath it. Run alone, the same ladder finished in 43 seconds with the same 31/31.

### `test:e2e` inside the pipeline — measured, not caused by these changes

Three full pipeline runs after the final commit: one failed on `test:fast` and `test:e2e`, one passed
every lane, one failed on `test:e2e` alone (that run's log is the one quoted below). The lane passes
consistently on its own — five standalone runs, `7/7` each — so the failure needs the pipeline's
sequence, not the repository state.

The failing case is the live slice in `test/e2e/theme-golden-live.test.js`, and the worker exits 1
without a diagnostic of its own; the cause is visible in the transcript around it:

```
[capability-transport] attachment attachment-db50e649-... bound tab '5e3c104f-...' is gone and no
failover target exists; dispatching 'anti.screenshot.viewport' against the stale target
[Live Theme Proof FAIL] AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
[Live Theme Proof Orchestrator FAIL] ... Live theme proof Electron worker exited with code 1
```

The proof's Chromium tab is gone before the slice runs, so every capability call after that lands on a
stale target. This is the same lane the round-1 pipeline recorded as flaky (`structuralDelta: 1` vs 0,
green on two standalone re-runs), and the code it exercises is untouched by this change set: the two
commits that followed touch a theme checkout, two captured documents, and a report. It is left as
recorded behaviour rather than papered over with a retry, because a retry would hide a live-tab
lifecycle defect that is worth someone's attention.


