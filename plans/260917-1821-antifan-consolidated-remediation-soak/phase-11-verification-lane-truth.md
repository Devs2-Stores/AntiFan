---
title: "Phase 11: Verification Lane Truth"
status: in_progress
---

# Phase 11: Verification Lane Truth

## Overview

The remediation program is graded by its own lanes. Before any phase's acceptance
is trusted - and before the autonomous improvement loop iterates on that grade -
the lanes must be able to fail for the right reason and be unable to pass for the
wrong one.

Source: a best-of-5 adversarial audit of the e2e failure
(`plans/260917-1821-antifan-consolidated-remediation-soak/reports/260918-1930-code-review-packet.md`),
adjudicated by a strongest-model verifier against source. The verifier emitted a
24-finding union: **19 confirmed, 2 refuted candidate claims, 1 partially
uncertain**. Two packet claims were refuted outright and are recorded here so
they are not re-derived:

- The stale-target warnings are **not** caused by tab creation order
  (`setControlPlane` only stores a reference; `resolveTargetTabId` reads the live
  tabs map). They fire because both smokes omit the `ControlPlaneRuntime`
  delegates production wires at `src/main/index.ts:328-330` (U3).
- `latencies.sort()` **is** numeric (`(a, b) => a - b` is present); the
  lexicographic-sort claim is false (U21).

## The two confirmed root causes of the red lane

| # | Kind | Cause | Anchor |
|---|---|---|---|
| U1 | TEST | "p95" was `latencies[Math.floor(20 * 0.95)]` = `latencies[19]` = the **max** of 20 samples, gated at an absolute 120 ms - below the product's own documented 200-2500 ms concurrent-dispatch stall envelope, so a single tail sample fails deterministically (4/4 repro) | `scripts/smoke-mcp-industrial-e2e.cjs:355-370` |
| U2 | **PRODUCT** | The renewal-persist throttle was dead code: `lastPersistedExpiresAt` resynced to the *extended* expiry, so `newExpiresAt - lastPersisted` always equalled `extensionMs` (7.2e6 ms) ≫ the 60 s threshold. The harness's 1 Hz heartbeat (vs the 30 s production default) appended a full-revisions frame **every second** on the same temp volume the benchmark's 3 awaited ledger appends + artifact stage + synchronous `readBytesById` run on. The file's own comment documents this pattern as "2.3 s first append and 200-2500 ms stalls on concurrent dispatch" | `src/main/run/attachment-registry.ts` (persist call + `lastPersistedExpiresAt` write) |

U2 is fixed and regression-proven (see `## Repairs`). U1 is fixed by the repair
wave. The lane's redness was therefore **one real product defect the suite
accidentally surfaced**, plus one statistic that could not have passed.

## Findings register

Status legend: `done` = repaired and proven, `wip` = in this phase, `deferred` =
tracked, owned by a later phase, `info` = recorded, no action.

| # | Kind | Sev | Verdict | Finding | Status |
|---|---|---|---|---|---|
| U1 | TEST | HIGH | CONFIRMED | max-of-20 gated as p95 at 120 ms | wip |
| U2 | PRODUCT | HIGH | CONFIRMED | dead renewal throttle, 1 Hz full-revisions append | done |
| U3 | TEST | HIGH | CONFIRMED (packet cause refuted) | smokes omit `resolveTabId`/`resolveFailoverTabId`/`isTabAllowed`, so every dispatch takes the stale branch and the heal path is unreachable in both harnesses | done |
| U4 | PRODUCT | MED | CONFIRMED | the benchmark measures durability IO, not dispatch latency: 3 awaited ledger appends + artifact stage + synchronous `readBytesById` inside the timed interval | info |
| U5 | TEST | HIGH | CONFIRMED | theme-golden-live watchdog race (outer 180 s == inner 180 s); captured stdout/stderr never printed on timeout; inner `timedOut` assert is dead code | wip |
| U6 | TEST | MED | CONFIRMED | `mcp-industrial-overhaul.test.ts` has no watchdog - the only Electron test without one | wip |
| U7 | TEST | MED | CONFIRMED | `McpBridgeClient.sendRequest` has no timeout; pending promise rejects only on child exit | wip |
| U8 | TEST | MED | CONFIRMED | register/data-root isolation leak: run-electron passes full `process.env`; the industrial smoke strips `ANTIFAN_*` only for the proxy, so `IssueRegister` loads the live 1,000-record register | wip |
| U9 | TEST | MED | CONFIRMED | 101 sequential `rotateAuthorityRevision` calls, each appending a frame serializing all candidate revisions - O(n) x 101 self-inflicted IO | wip |
| U10 | TEST | MED | CONFIRMED | `soak-test.test.ts` is an in-process simulation asserting the constants it just wrote; `report.passed` never asserted; occupies the e2e soak slot while the real soak is `smoke:soak` | wip |
| U11 | TEST | MED | CONFIRMED | dead/hidden coverage: `mcp-dispatch-hub-probe.cjs` (real assertions, no lane), `toolbar-qa-hub-empirical-probe.cjs` (zero assertions, no exit code), `test:terminal-rename` never run by the pipeline, `terminal-oracle-harness.ts` imported by nothing | wip |
| U12 | TEST | MED | CONFIRMED | `clickDurationMs >= 90` cannot prove the actionability gate waited | wip |
| U13 | TEST | LOW | CONFIRMED | milestone 4 samples the Electron main process `heapUsed`, not the proxy child under test; one before/after sample, no GC control | wip |
| U14 | TEST | LOW | CONFIRMED | milestone 1 "authentic PNG" is a 4-byte magic check - no IHDR dimensions vs viewport, no content check | wip |
| U15 | TEST | MED | CONFIRMED | the 20-call benchmark never validates the payload; an empty-DOM regression still yields a green median | wip |
| U16 | TEST | LOW | CONFIRMED | `latencies.sort()` mutates in place before `samplesMs` is written to the artifact, so an outlier cannot be correlated to a call index | wip |
| U17 | PRODUCT | MED | CONFIRMED | dead-target contract inconsistent: `getDom` returns `''` and `evalJs` returns `undefined` for dead targets while `evalJsInFrame` throws `TARGET_STALE`; a teardown race can stage an empty DOM as a successful artifact | deferred |
| U18 | PRODUCT | LOW | CONFIRMED | `listTaskRuns` HEALTHY branch is unreachable - `task_runs` has zero writers repo-wide; the `UNKNOWN`/`NO_TASK_RUNS` assertion is the honest contract but nothing tracks the gap | deferred |
| U19 | TEST | LOW | CONFIRMED | packet metadata errors: `test:e2e` glob matches 6 compiled files, not 8 (correction only) | info |
| U20 | TEST | LOW | CONFIRMED | theme-golden-live 180 s bound is environment-fragile (15x cold-start variance on identical code) | wip |
| U21 | TEST | LOW | REFUTED | candidate claim that `latencies.sort()` is lexicographic - the comparator exists | info |
| U22 | TEST | LOW | REFUTED | candidate repair "move `setControlPlane` before `createTab`" would not fix the warnings; U3 is the real cause | info |
| U23 | PRODUCT | LOW | UNCERTAIN | `invocation-ledger` sync IO off the benchmark path: `ensurePartitionDir` `existsSync`/`mkdirSync` once per dir (verified); `getStats` `statSync` (not re-verified) | info |
| U31 | TEST | MED | CONFIRMED | `goal-runner.test.mjs` "loses at most one unit of work when killed mid-phase" waits on progress with `waitFor`'s 15 s default (`test/unit/goal-runner.test.mjs:41,105`). Under the lane's default concurrency that budget is environment-fragile: one `npm run test:fast` run failed the case at **15.03 s** - exactly the budget - while the same case passed in 3.98 s in the next lane run and 15/15 passed twice when the file ran alone. Same class as U20: the assertion is right, its bound tracks the machine instead of the work. | deferred - raise the progress wait above the lane's measured contention (or gate it on the checkpoint file existing before asserting progress) without weakening the successor-count assertions. Not touched this phase: two isolated green runs and one green lane run, so there is no standing failure to repair, only a bound to widen. |
| U24 | PRODUCT | LOW | CONFIRMED | warn-and-dispatch is a defensible contract, but transport and port compute the failover decision independently - two sources of truth for one invariant. The MCP proxy was a **third** opinion (its own bound-tab cache, U30); it now mirrors the authority instead of holding its own, leaving the transport-vs-port split as the remaining deferred item | deferred |

Verifier gaps also recorded (not findings): `test:e2e` runs with
`--test-force-exit`, which can mask hanging handles across the lane; `callMcp`
has no client-side timeout; milestone 6 was not deeply audited by any candidate;
nobody checked whether `packs`/`cases` have writers (assumed from a passing test).

## Repairs (verifier's repair order)

1. **U3** - wire `resolveTabId`/`resolveFailoverTabId`/`isTabAllowed` into the
   `ControlPlaneRuntime` of both smokes, mirroring `src/main/index.ts:328-330`;
   add one close-tab failover case asserting a typed heal or `TARGET_STALE`.
2. **U2** - persist on wall-clock elapsed since the last persist, not on expiry
   drift. **Done**: `ExpiryPersistThrottle` in `src/main/run/attachment-registry.ts`
   stamps `lastPersistAtMs` on `markPersisted` (an append or an already-fresh
   process-local record), and `shouldPersist(now)` compares
   `now - lastPersistAtMs >= 60_000`. Regression test
   `test/main/attachment-runtime-scoping.test.ts`: "throttles heartbeat renewals
   instead of appending a durable frame per tick" - proven to **fail pre-fix**
   (`actual: 6, expected: 1` frames) and pass post-fix, including the immediate
   write-through on a pid rebind.
3. **U1 + U16** - correct nearest-rank p95, separate `maxMs` catastrophic
   tripwire, one warmup call, unsorted samples persisted.
4. **U5 + U6 + U7** - watchdogs: `mcp-industrial-overhaul` SIGTERM/SIGKILL +
   output dump; theme-golden outer timer > inner timer and captured output printed
   on timeout; per-request timeout in `McpBridgeClient.sendRequest`.
5. **U8** - set `ANTIFAN_VERIFICATION_REGISTER_DIR` + `ANTIFAN_DATA_ROOT` to the
   temp root in the industrial smoke (copy the pattern at
   `scripts/smoke-theme-golden-live.cjs:15-18`).
6. **U15** - assert non-error envelope + non-empty DOM inside the benchmark loop.
7. **U9 + U20** - `maxHistoricalRevisions: 1` + two rotations instead of 101;
   raise the golden watchdog to ~300 s.
8. **U12 + U13 + U14** - actionability ordering proof, proxy-child memory sampling
   (or explicit informational), IHDR dimensions.
9. **U10 + U11** - move the soak simulation's honest part to unit and delete the
   tautologies; wire or retire the probes and the terminal lanes.
10. **U17 + U24 + U18** - product hardening, not required for lane green;
    `deferred` (U17 needs a caller audit before the `''` convention is removed).

## Integration findings (found while making the lanes green, `test:main`)

| # | Kind | Finding | Repair |
|---|---|---|---|
| U25 | TEST | `tab-devtools-host.test.ts` case 22 ("a CDP capture timeout surfaces CAPTURE_TIMEOUT") went red when the committed capture rework landed: a viewport capture whose native tier never answered is now given a short CDP probe bound and any failure in that state is reported as `NO_RENDER_SURFACE` (`tab-devtools-host.ts`, the `captureHasNoSurface` branch). The mock's never-resolving `Page.captureScreenshot` therefore produced a surface diagnosis instead of the timeout the test pins. The production contract is deliberate and measured (a detached view times out for viewport captures), so the test was repaired, not the code: the native tier now answers with a raster whose dimensions do not match the measured surface, which keeps the native result unused and leaves the CDP tier as the failing tier. | `test/main/tab-devtools-host.test.ts` case 22 |
| U26 | TEST (contract narrowing, recorded for review) | `omp-mcp-adapter.test.ts` banned `require('node:fs')` outright. The accepted MCP-dispatch-accounting feature makes the stdio proxy append attempt frames to `ANTIFAN_PROXY_TELEMETRY_DIR` (env-named, no default, no plausible-path fallback, nothing at import). The blanket ban and the accepted feature cannot both hold. | The ban is replaced by the invariant it protected: no bridge/credential/instance discovery (all previous bans retained), exactly one `node:fs` require, the directory named only by environment (no `homedir`/`USERPROFILE`/`APPDATA`/`LOCALAPPDATA`), plus a new behavioural test that requiring the module writes nothing to an env-named store. The store's own frames are read back only by the operator CLI `--core-attempts`, which is not exposed over MCP. |

U26 is the only assertion in this phase that was **narrowed** rather than strengthened;
it is flagged here because it touches a security contract. The alternative - removing
proxy-side attempt accounting - was rejected: per-MCP usage must be a dispatch fact
(`accounting:mcp-dispatch`), which the user required and the accounting plan already
materialized.

## Integration findings (found by running `npm run test:e2e`)

| # | Kind | Finding | Repair |
|---|---|---|---|
| U27 | PRODUCT (diagnosability) + HARNESS (divergence) | `BrowserControlPort.getViewport` discarded a thrown render-surface probe (`catch {}`), so an unmeasurable tab and a tab with no surface were indistinguishable: the payload said `probe-unavailable` while the real cause (CDP timeout, busy pool, missing target) was lost. Under that blind spot, **no live harness mirrored `readRenderSurface` / `isTabOffscreen` / `getSessionTabList`** from the composition root (`src/main/index.ts:410,416,430`), and the port skips the surface gate entirely when the probe is absent - so every lane asserted captures on surfaces it had never measured. | Port: the probe failure is now reported as `probeError { code, message }` beside the classified `cause` (test: `render-surface-and-viewport-gates.test.ts`, "names the probe failure on get_viewport"). Harnesses: both live capture smokes mirror the three fields, and `test/main/capture-lane-host-mirror.test.ts` fails if a future adapter drops one. The product option - making `assertRenderSurface` refuse when the host cannot measure at all - is **not** taken here: 249 `new BrowserControlPort(...)` constructions in `test/` are partial mock hosts, so that is its own wave. |
| U28 | CLAIM CHANGE (removed assertion, recorded for review) | Milestone 6 asserted `anti.screenshot.viewport` returns an MCP **image** for a tab created in the background. That tab is never laid out: measured `0x296 CSS px`, `document.hidden`. It has no compositor surface, so the old assertion could only pass on an empty or fabricated raster - and it did, until the capture rework made the refusal explicit. | The milestone now asserts what the product actually guarantees: the refusal is a capability error **named** `NO_RENDER_SURFACE` with a classified cause, the active tab is unchanged, and the same tab still answers `browser_find` + ref-only `anti.agent.cursor.type` with real DOM events. Positive capture coverage is unchanged: Milestone 1 proves a live viewport raster (IHDR dimensions vs the measured viewport) and the golden lane proves the product-card slice. Product alternative, if background capture is wanted: apply window geometry during the temporary attach (the capture path's `runWithAttachedTabView` block) so a never-displayed tab can raster. |
| U30 | PRODUCT (client cache) + HARNESS | The MCP proxy filled `tabId` for every call that omitted it from its own bound-tab cache (`bootstrap.tabId \|\| ANTIFAN_BOUND_TAB_ID`) and updated that cache only for switch/rebind/set-automation/open. A close therefore left the default naming the **closed** tab: the authority had rotated to the failover correctly, but the next omitted-`tabId` call arrived as an explicit request for a dead id and was refused `TARGET_MISMATCH: Unknown browser target` - the session looked broken until re-pairing. Found by the new close-tab case; the same class as U3 (a second copy of an invariant the authority owns). | Proxy: one owner for the default (`resolveBoundTabId`/`recordBoundTab`); the close records the replacement the port returns (`failoverTabId`) when it closed the tab being defaulted to, and **clears** the default when there is none, so a stale id cannot be re-derived from the bootstrap. Tests: `test/main/mcp-proxy-bound-tab-rotation.test.ts` (4 cases: open rotates, close-with-replacement rotates, close-without-replacement clears, an unrelated close does not move the default); falsified by disabling the close branch - cases 2 and 3 fail as expected, 1 and 4 stay green. Milestone 7 now also asserts the attachment's authority rotated onto the named replacement. |
| U29 | HARNESS (honesty) | The e2e lane's two long-running children (`mcp-industrial-overhaul`, `theme-golden-live`) are bounded and print captured output on timeout (U5/U6), but the lane still relies on `--test-force-exit` for leaked handles; `test:e2e:strict` exists as an opt-in lane and is deliberately **not** in the default pipeline until its watchdogs are proven. | Recorded as known: the strict lane stays opt-in. |

## Success criteria

- [x] `npm run test:e2e` is green (5/5, 40.1 s) with corrected statistics. The
      shipped gate is **tighter** than this criterion's first draft: `p50 < 60 ms`,
      `p95 < 120 ms` as a true nearest-rank p95 (at most one of 20 samples may reach
      it), `max < HEARTBEAT_MS` - one client heartbeat, because a dispatch that
      outlives it stalls the session - and `tailSamplesOver500ms === 0`. The artifact
      carries unsorted `samplesMs`, `p95Ms`, `maxMs` and `heartbeatMs`
      (`plans/reports/mcp-overhaul-benchmark.json`, written by the lane run:
      p50 12.29, p95 15.59, max 15.96, heartbeat 1000).
- [x] Both harnesses emit **zero** false stale-target warnings, and the heal
      branch is reachable: the industrial lane's Milestone 7 closes the session's
      bound tab, asserts the attachment authority rotated onto the named replacement
      and that the next target-bound dispatch answers with the live storefront DOM
      while capturing this process's own warnings (none may name a stale target);
      the golden lane opens the same capture window around its whole dispatch phase
      and asserts it. Falsified: unwiring `resolveTabId` in the golden harness makes
      that lane fail on the captured warnings, and disabling the close branch in the
      proxy makes the rotation cases fail.
- [ ] No smoke reads or writes the live register: the industrial smoke's register
      and data root point at its temp root.
- [ ] Every Electron-spawning e2e test is bounded by a watchdog that prints the
      child's captured output on timeout.
- [ ] Every probe with real assertions is reachable from the pipeline; no probe
      that cannot fail remains.
- [ ] The soak lane no longer hosts a simulation that asserts its own constants.
- [ ] No assertion was weakened, and each deleted assertion is named with its
      tautology reason.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Wiring the control-plane delegates changes what the smoke exercises (the heal path becomes live for the first time). | That is the intent: the heal path is production behavior that was never under test. A new failure here is a finding, not a regression - record it before touching product code. |
| Adding a strict `test:e2e:strict` lane without `--test-force-exit` may expose hangs. | Keep the existing lane's flag until the watchdogs are proven; the strict lane is opt-in and its failures are findings. |
| Raising the golden watchdog hides a real slowdown. | The bound is raised with the measured variance recorded, and the lane still fails on a hang; the strict lane keeps the lower bound visible. |
| Rollback | Revert the named files; no product behavior outside `attachment-registry.ts` (U2) is changed by this phase. |
