---
title: "soak-4h-workflow-performance"
description: "Run the 4h soak as a performance-improvement loop: make the app's per-process memory attributable, fix the retention that caps concurrency, then re-run the 4h soak against the fixed bundle."
status: active
priority: P0
effort: "1d"
tags: [soak, performance, concurrency, memory-attribution]
created: 2026-09-20
blockedBy: []
blocks: []
---
# soak-4h-workflow-performance

## Overview

The standing 2h soak fails two gates, and both failures bound how much work the app can
hold at once:

| Gate | Bound | 2026-09-19 2h run | Consequence for concurrency |
|---|---|---|---|
| renderer memory slope | ≤ 0.15 MB/min | **0.208** (reproduced 2/2 runs) | a long session ends in a restart, which costs every live tab and terminal |
| switch latency max | ≤ 35 ms | **42.1** (1 of 1756 switches, p95 6.8 ms) | one stall is invisible in aggregate but it is what a user feels on a switch |
| peak active memory | ≤ 1600 MB | 1549.7 | already inside the gate; a larger tab count has no headroom left |
| orphans | 0 | 0 | — |
| execution / teardown | clean | clean | — |

The stated goal of this run is *performance so more work can run at once*, so the two
failing gates are the work. A pass/fail re-run alone would not improve anything: the run
must first make the failure **attributable** and then **remove** it.

## Decisive constraint (verified, not assumed)

`app.getAppMetrics()` reports memory per *process type*: every renderer is `Tab`, so a
window-chrome leak and a page-renderer leak are indistinguishable in the existing
payload. The 2h verdict therefore ends with "investigate renderer creep" and no owner.
The soak's headline number cannot name the thing that grew, which is why the fix has
never been made.

`scripts/benchmark-real-soak-8h.cjs` already keeps a per-process sample in its payload
(`processSeries`, written by a separate scrape the harness owns), but the injected
app-side telemetry it prefers carries no role, so a run can show *which PID* grew and
still not know what that PID is.

## Phases

### Phase 1 — Attribution (instrument)
- `src/main/benchmark/telemetry.ts` + `src/main/index.ts`: emit per-process rows
  (`pid`, `type`, `workingSetKB`, `privateBytesKB`, `role`, `url`) on a 60s interval,
  benchmark mode only.
- Electron reports every `WebContentsView`-backed page as type `window`, the same type as
  the app chrome, so the role is resolved through the tab host (`getTabWebContents` per
  pane) and names the tab; only `mainWindow.webContents` is `window`.
- Harness: fold the process series into the report with a per-process slope and the
  worst-process identity, and keep the top-10 slowest switches.
- Attribution is a diagnostic, **not** a gate: acceptance bounds stay on the aggregate
  series so a pass/fail comparison across runs remains valid.

### Phase 2 — Diagnosis
Run a short instrumented soak and read which process owns the growth, then trace the
retaining allocation in that module.

### Phase 3 — Fix
Remove the retention; prove it with a narrow check and a preflight soak.

### Phase 3 order, set by what the run measured

The run's own instruments decided this order, not preference: the harness miscounted more
working time than the defect costs.

1. **Harness instruments first** — each is a one-line or one-function change, and each was
   demonstrated on live data during this run:
   - `benchmark-real-soak-8h.cjs:403` passes `'mb'` (working set) to `calculateSlope` and
     `:422` ranks by it, while the same row already emits `deltaPrivateMB` (`:397` collects
     both). Slope and ranking must use committed private bytes, with the working-set slope
     reported beside it.
   - The renderer series is the parent-pid walk, which on this desktop includes a foreign
     Electron app (Zalo: 3 renderers, 4 utilities, 1 GPU, 10 other processes). The walk must
     be scoped to app-owned processes — executable under the app path, or `--user-data-dir`
     matching the soak root — before `rendererActiveSlopeMBPerMin` or the peak-memory SLO can
     mean anything.
   - Criterion 2 must read the **per-process maximum**, not the app Tab sum: the sum reads
     +0.14 MB/min here and the one growing process inside it reads +0.17.
   - The latency gate needs phase scoping (5 of the 10 slowest switches are warmup).
2. **The retention fix** — trace it with a heap diff across the three documents that share pid
   47536, then fix, then verify on the 60-minute floor preflight; a shorter window cannot
   resolve 0.17 MB/min against a 10 MB collection amplitude.

   **Instrument first (applied 2026-09-20 06:54, `scripts/probe-renderer-retention-class.cjs`):
   classify the memory before snapshotting it.** A V8 heap snapshot is the wrong first move for
   this pid, for two reasons that are properties of the tool, not opinions: it forces a GC inside
   the process being measured (on a 0.17 MB/min slope, the collector's own effect is the same
   order as the signal), and it sees only V8 objects — the remaining suspects are Blink-side
   (`nodes` for the terminal scrollback and the tab strip, attribute/string tables, IPC buffers
   that keep a page committed until view teardown), which a JS-heap diff reports as "no growth"
   while the private bytes climb. The probe attaches to a running app's DevTools endpoint and
   classifies **per document**: `nodes` / `documents` / `jsEventListeners` are exact counts, so
   monotone growth is retention and is classified against a per-minute threshold;
   `JSHeapUsedSize` is a sawtooth, so it needs *both* an amplitude and a step-rate test before it
   is called growth; `RecalcStyleCount` / `LayoutCount` are cumulative work counters, so they are
   printed as rates rather than classified. A counter the protocol refuses is recorded
   `unsupported` and its document `UNMEASURED` — never `0`, because a zero reads as a flat,
   healthy series.

   Narrow check: probe `--self-test` **11/11** on a synthetic endpoint (three documents growing
   three different ways — `DOM_NODES` 600 nodes/min, `EVENT_LISTENERS` 30 listeners/min, one flat
   ⇒ `FLAT`; a sawtooth heap −10 MB then +4.5 MB is **not** classified as growth; a document whose
   counters fail ⇒ `UNMEASURED`), and the adversarial direction was run: flattening the nodes
   series in a **copy** of the fake makes the self-test fail in exactly that slot (`JS_HEAP`
   instead of `DOM_NODES`), restoring the original returns 11/11.

   **The running leg run cannot be probed (verified, not assumed): no CDP endpoint.** The harness
   gained `SOAK_APP_ARGS` for this, which appends extra switches to the app's argv and records
   them (`config.appArgs` in the payload plus a launch log), because a run carrying a debug
   endpoint that the payload does not record would later be read as a clean baseline. The leg run
   launched at 06:34 predates that switch, and the check confirms it:
   `Get-CimInstance Win32_Process` filtered to `electron|AntiFan` returns **19** processes, of
   which **8** carry `antifan-soak-8h` in their command line and **0** carry
   `--remote-debugging` (`wmic` returned an empty process list on this host; the CIM query is the
   one that works). A second, concurrent app is **not** an option: the soak app is a heavy
   workload of its own on four cores, and the leg bisect is a memory measurement — this is the
   same contamination that already produced two false gate failures (`memoryOk`, `processOk`) in
   the 4 h run's verdict. So the diagnosis run is sequenced after the leg run, with its own tag,
   and the recipe is:

   ```
   SOAK_APP_ARGS="--remote-debugging-port=0" node scripts/probe-renderer-retention-class.cjs \
     --profile=E:/Work/.antifan-soak-8h/Profile --samples=6 --interval-ms=60000
   ```
   launched while that run is in flight, so the probe samples the same process the run's own
   telemetry attributes.

3. **The throughput work** — the CPU costs on the shared thread pool, which are what "more work
   at once" is actually bound by.

**Applied while the diagnostic ran** (justified on its own: both remove invisible work from
the state-broadcast path, which fires at up to 5 Hz for the whole run). Narrow check for both:
`scripts/probe-toolbar-render-cost.cjs` paths 2 and 3 — an unchanged push rebuilds **0** nodes
for the dropdown and **0** for a closed panel body, while a renamed profile (6 mutations) and an
open-panel unplug (1 mutation, detached-device copy) still repaint. Neither has a unit test:
the renderer harness ("FakeElement") does not parse `innerHTML`, so it cannot see these nodes.

- `src/renderer/toolbar.ts` — `renderChromeProfiles()` ran on **every** state push and
  rebuilt the profile dropdown unconditionally: `innerHTML = ''`, one item per Chrome
  profile with a fresh `onclick` closure, a divider, and two Session-Vault rows with their
  own closures. The dropdown is closed in the soak and its input (profile list + active
  profile) never changes, so every push paid a full parse, subtree replacement and closure
  allocation for a menu nobody had opened. Now value-signature guarded
  (`computeChromeProfilesSignature`), matching the `computeTabsSignature` /
  `computeBookmarksSignature` convention already used in the same handler.
- `src/renderer/toolbar.ts` — `renderPhoneStatus()` called `renderPhoneModalContent()` on
  every push regardless of whether the panel was on screen, and that function is a single
  `innerHTML = <template>`: a full HTML parse plus subtree rebuild five times a second.
  It now renders when the panel is open; the disconnect-staleness case the old comment
  guarded against is still covered, because an open panel still re-renders and
  `openPhoneStatusModal()` renders once more before showing.

- `src/main/index.ts` — role resolution gap found in the diagnostic payload: a pid that
  already carried a role was skipped, so the shared `file://` renderer (toolbar + terminal
  sidebar + backdrop are one site, therefore one process) was labelled after whichever view
  was enumerated first — `chrome:standalone` alone. Chrome views now still join a pid that
  is not already named as a tab page or the window, which reports the fact
  (`chrome:standalone+chrome:toolbar`) instead of an arbitrary winner.
- `scripts/benchmark-real-soak-8h.cjs` — the diagnostic's slowest switches were 5 of the
  top 10, all landing on the same two heavy pages (`wikipedia`, `google`), while p50 was
  9.6 ms. A single `max` cannot say that, so the report now carries
  `switchLatencyByTab` (count/p50/p95/max per destination, with its URL) and prints the
  slowest destination in the terminal verdict.

### Phase 3c — Latency gate — DECIDED (2026-09-20) and applied
The gate fails on `max`, and `switchLatencyByTab` answers the question it was added for:
**neither branch holds.** It is not a per-destination cost (the per-destination table under
"Harness findings" shows **all six** breaching 35 ms while every p95 sits at 15–17 ms) and it
is not a one-off stall (8 of the 10 slowest fall in the steady-state workload phase, spread
across the run: 18:23, 18:25, 18:40, 18:41, 18:58, 19:05, 19:37, 21:08). What is left is a
global stall that hits every destination equally, at ~0.2 % of 4090 switches, on a uniformly
shifted distribution (every p50 10.1–10.9 and the run's fastest switch at 6.76, against a 2 h
baseline whose fastest switch was 3.092).

**User decision (asked with the run's numbers, answered 2026-09-20): gate percentiles, report
the max.** The gate is now `p50 ≤ 12 ms && p95 ≤ 18 ms` on the workload phase; `switchMax` is
reported only. Applied in `scripts/benchmark-real-soak-8h.cjs`: the `switchLatencyMaxMs: 35`
row is deleted from `FREEZE_SLO` (a threshold sitting in an SLO object that nothing grades is a
trap for the next reader), the `switchMax` term is removed from `latencyOk` with the reason and
date in-line, and the payload gains `switchLatencyMaxMs` + `latencyMaxGated: false` so a
dropped bound is distinguishable from a passed one.
Discriminating proof: `test/unit/soak-latency-gate.test.mjs` grades the exported
`evaluateFreezeVerdict` — reinstating the old `switchMax <= 35` term fails 2 of its 6 cases
(max 50.976 with p50/p95 inside; max 900 at the bounds), restoring it returns 6/6. This
threshold is the *only* one the user changed; the memory and process bounds are untouched.

rawMetrics already carries the full distribution (`switchLatencyMs` min 6.76 / p50 10.346 / p95
15.513 / max 50.976), so nothing about the tail is lost — it stops deciding the verdict.

### Phase 3d — A/B the driver
Run the same instrumented soak twice on the fixed bundle, changing only the workload's
page-event rate (`SOAK_FIXTURE_TICK_MS`): a per-broadcast retention must scale with the
broadcast rate, so a slope that tracks the tick and collapses when the rate drops is
evidence of a retaining consumer rather than of Chromium's own page cost. (It separates
per-broadcast retention from Chromium page cost; it does **not** separate the two live
per-broadcast consumers, because the tick drives both — see "Suspect list narrowed".)

### Phase 4 — Soak
Run the full 240-minute soak on the fixed bundle.

### Phase 4b — Post-fix preflight (the retention re-measure, DONE — claim WITHDRAWN)
`SOAK_DURATION_MINUTES=90 SOAK_WARMUP_MINUTES=15 SOAK_RECOVERY_MINUTES=15 SOAK_REPORT_TAG=preflight-fixed`
— the 60-minute workload window is the floor instrument (0.17 MB/min is +10 MB against ~1 MB of
floor noise, so 60 minutes resolves it and another 4 h run does not). Machine load is *not*
controlled (the user's own app instance, this session and the terminal daemon share four cores),
so latency numbers from this run are not comparable to the 4 h run — the memory floor is, and that
is what the preflight is for.

**Result: the floor did not hold, so the mechanism note is withdrawn rather than restated.** Both
fits are over the workload phase, same role (`chrome:standalone+chrome:toolbar+chrome:frame-backdrop`),
same `privateBytesMB` column, 60 s frames, fitted by LSQ:

| run | bundle | workload | pv first → last | slope ±1se | residual sd | 2nd half |
|---|---|---|---|---|---|---|
| 4h | pre-fix | 179 min | 85.48 → 117.54 (+32.06 MB) | **0.1699 ± 0.0010** | 0.66 | 0.166 |
| preflight | post-fix | 58 min | 82.43 → 94.13 (+11.70 MB) | **0.2234 ± 0.0070** | 0.92 | 0.209 |

The post-fix slope is *higher* (+0.0535 MB/min, ~7.5σ), so the two per-broadcast fixes do not own
the growth. Two further facts decide what does:

- The growth is linear and steady (2nd half 0.209 vs 1st half 0.243; the rolling-min floor still
  climbs +2.79 MB in the last 20 min), so it is **not** a bounded buffer filling up: xterm's
  scrollback is capped at 10,000 lines (`src/renderer/standalone.js:2034`), which would flatten
  ~16 minutes in, and it does not flatten.
- Both runs cost the same per line of terminal output — 32.06 MB / 107,400 lines = **298 B/line**
  (4h) and 11.70 MB / 34,800 lines = **336 B/line** (preflight) — so the suspect moves from the
  broadcast path to the **terminal write path**. The confound this leaves open is honest and
  stated: both runs write ~10 lines/s, so a purely **time**-proportional driver fits the same
  numbers. Phase 4c separates the two by measurement.

### Phase 4c — Leg bisect (STOPPED 08:10 local at the operator's request after 63 min; one leg closed, legs 2–3 unrun)
A re-run of the same workload cannot separate a per-line cost from a per-minute one, and the 4 h
run already showed what the whole-window slope does with that ambiguity. The harness now splits
its **own** workload phase into consecutive legs that differ in one driver
(`SOAK_LEGS="name:minutes:burstLines:burstIntervalMs,..."`), records the leg boundaries it actually
observed, and fits each leg separately, so process identity, page set, host load and the switch
rate are held fixed while only the burst volume moves. Legs are keyed by name *and* window, so a
bisect that returns to an earlier regime reads as three legs rather than one swallowing the leg
between them, and each leg carries its **observed** burst count, because a leg whose writes failed
would otherwise read as "this driver costs nothing".

Because a leg run's workload slope is a blend of deliberately different regimes, the slope gate no
longer grades it: `slopeSloSatisfied: null`, `slopeGateApplicable: false`, verdict
`PASSED_SLOPE_NOT_GRADED`, with `legSlopes` carrying the measurement. The other gates (peak memory,
latency, orphans, execution, teardown) stay meaningful and still run — leg 2 is also the throughput
test the concurrency goal asks for (40 lines/s of PTY output while switching tabs every 3 s).

`SOAK_DURATION_MINUTES=240 SOAK_WARMUP_MINUTES=30 SOAK_RECOVERY_MINUTES=30 SOAK_REPORT_TAG=legs4h SOAK_LEGS="baseline:60:300:30000,burst4x:60:1200:30000,burst-off:60:1:600000"`

| leg | minutes | burst | what its slope decides |
|---|---|---|---|
| `baseline` | 60 | 300 lines / 30 s (10 lines/s) | the current bundle's rate (must reproduce 0.2234) |
| `burst4x` | 60 | 1200 lines / 30 s (40 lines/s) | ≈4× leg 1 ⇒ cost is per **line**; ≈leg 1 ⇒ per **minute** |
| `burst-off` | 60 | 1 line / 600 s (off) | ≈0 ⇒ per line; ≈leg 1 ⇒ per minute |

Order is deliberate: a cost that rises 4× and then collapses cannot be produced by a monotone
time-decay, which is the confound a single knob change across separate runs would leave open.

**Mid-run read (applied 2026-09-20 06:55 local, run in flight).** `legSlopes` is written only
when the harness finishes, so a leg that has already completed could not be read from the
payload — the bisect's answer would arrive at 10:34 instead of at the end of leg 2. The
analyzer now derives the leg windows from the run's own schedule (`config.legs` + `startedAt` +
`warmupMinutes`) when the payload carries no `legSlopes`, and **labels every derived window
`PROVISIONAL`** in the header, on each leg line, and in the reading text: those boundaries are
scheduled, not observed, so a machine sleep or a delayed phase shifts them, and the observed
burst count is unknown, so the per-line column prints `n/a` rather than a number computed from
a fabricated count. The final payload's observed `legSlopes` supersedes the derived read.
Verified three ways on real data: derived mode over the 4 h artifact's workload window (three
legs, real frames, `PROVISIONAL`, per-line `n/a`), observed mode with leg counts injected
(per-line column computed, and suppressed below 1000 observed lines, where the quotient is a
large number that reads like a measurement), and the live leg-run checkpoint (three derived
windows, `no usable window (0 frames)` — correct, the workload had not started in that launch).

**Leg burst counter fault — found, fixed, and the run restarted (2026-09-20 07:05–07:08).**
Found by the repair round, confirmed in source, and fatal to half of this run's reading: `legAt()`
returns `{ ...leg, startAt, endAt }` — a fresh spread of a `LEGS` schedule entry — while `enterLeg()`
pushes a *separate* object into `legTimeline` with `bursts: 0`. The loop's `if (activeLeg) activeLeg.bursts++`
therefore incremented a throwaway on every burst, and every `legTimeline[].bursts` stayed 0. The
consequence was silent and total: `legBurstsObserved` = 0 → in leg mode `workloadBurstLines` = 0 →
`costPerUnit(x, 0)` returns `null` → **`metrics.cpu.msPer1000BurstLines` was null for the whole run**, and
each leg's `msPer1000BurstLines` with it. Since "performance so more work runs at once" is read from exactly
that number (cost per line of PTY output), the leg run in flight could not answer its own throughput question.

Fixed in `scripts/benchmark-real-soak-8h.cjs`: `enterLeg()` keeps a reference to the timeline entry it pushed
(`activeLegEntry`) and the burst path increments that. The same class of hole is now loud instead of silent —
the payload derives `metrics.legBurstCounterSuspect` ("legs recorded 0 bursts while the workload phase wrote
some"), the harness prints it in the terminal verdict, and the analyzer prints it in the CPU section, on each
leg header (`~N bursts scheduled, 0 recorded -> per-line n/a`), and in the cross-leg table. The analyzer also
stops pricing a leg run's workload against the *base* knob: when a leg schedule exists it divides by the legs'
**observed** volume, and says so in the line.

Because the fix is a harness change, the running process could not pick it up, and the run had 3 h 28 m left
with a null metric in its deliverable. Restarted at **07:07** with the identical schedule
(`SOAK_REPORT_TAG=legs4h`, `SOAK_LEGS="baseline:60:300:30000,burst4x:60:1200:30000,burst-off:60:1:600000"`,
warmup 30 / workload 180 / recovery 30 → ends **11:07**), which costs the 32 minutes already spent rather
than a 4-hour artifact with the throughput column missing. The aborted prefix is kept as
`real-soak-8h-legs4h-aborted-prefix-counter-20260920-0706.json` so no reader mistakes it for the run.

Narrow check for the fix: `test/unit/soak-analyzer-cpu.test.mjs` drives the **real** `buildReportPayload`
in leg mode and the real analyzer through a process spawn — per-phase CPU, the independent recompute agreeing
with the reported block, per-leg pricing (leg 2 = 1406.250 ms / 1000 lines), the sub-1000-line floor reading
`n/a`, a legacy artifact reading `NOT MEASURED` rather than `0`, and legs at 0 bursts producing both fault
lines — **5/5 pass**; the four soak suites together are **31/31**. The end-to-end proof is the restarted run's
own payload: leg 1's observed burst count is read from the 07:44 checkpoint.

**Two analyzer guards, added with the fix (07:10).** A mid-run checkpoint carries `legSlopes` for
the legs it has already exited, so a 3-leg workload read after leg 1 holds **one** leg's volume;
pricing the phase's CPU against it would report a cost several times the truth and print it as a
measurement. The phase line now prices a leg run only when **every scheduled leg is observed**,
and otherwise says how many legs the artifact holds and prints no per-line number at all — the
fallback to the base knob is removed for that case, because the knob is a different regime's
volume. The branch was verified against the real analyzer through a spawned process: leg-run
complete → prices the legs' observed volume; partial → refuses; all-legs-zero-bursts → the counter
fault. Two cases were wrong before this pass and are pinned by
`test/unit/soak-analyzer-cpu.test.mjs` (7/7): the partial fixture printed `266.667 ms per 1000
burst lines` from the base knob, and the whole leg-reading printed nothing at all for it. A third
wording defect of the same class was found by reading the live 07:17 checkpoint: the switch-tail
section told a leg run with no tagged sample yet "no leg schedule in this run", which the payload's
own `config.legs` contradicts — one group is either "no schedule" or "no sample inside a leg yet",
and it now says which.

**The run in flight is instrumented in memory, stale in CPU and history (measured 2026-09-20 08:05–09:20).**
The 07:07 restart was made for the burst counter alone, so it inherited a **second** reader defect that
also landed after the original launch: the payload's CPU block was computed from a series that carries no
per-process counters. Read from the live artifact rather than inferred: `real-soak-8h-legs4h-checkpoint.json`
(07:57 — checkpoints are on a **10-minute** cadence, so an intermediate read of a 17-minute-old mtime is the
cadence, not a stall) reports `metrics.cpu = {cpuSecondsTotal: 0, windowMinutes: 18, perProcess: []}` while the
same file's `samples[].cpuByPid` holds real counters, and `metrics.cpu.source` is **undefined** — the field the
fix introduces. So the process launched at 07:06:57 runs the harness as it stood *before* the CPU-source fix.
The consequence would have been the same one the burst counter produced: a deliverable that prices the whole
workload at zero, and a throughput question ("how much work at once") answered with `0 s/min`.

The counters are in the payload regardless of which reader ran, so the numbers are recoverable without
restarting a third time: **`scripts/recompute-soak-metrics.cjs <payload.json> [--stdout <log>] [--out <file>]`**
replays a saved payload through the current `buildReportPayload` and writes a **sidecar** — the payload stays
byte-identical as the record of what the run reported, and the sidecar carries the corrected blocks beside the
stale ones, so nothing is silently rewritten.

- Validation, on the live checkpoint: the memory round-trip **AGREES** (all seven control metrics identical —
  the inputs are faithful), stale CPU `0 s / 18 min` → recomputed **131.547 s over 19.02 min = 6.916 s/min over
  15 pids**; leg 1 `baseline` reads the same window, `40 bursts`, `381 switches`. The per-phase block attributes
  it: warmup 201.657 s / 29.06 min = 6.939 s/min, of which pid 14108 (main) 57.8 s, pid 34492 49.7 s, and pid
  29832 44.9 s carrying `chrome:standalone+chrome:toolbar+chrome:frame-backdrop`.
- Refusal check (the guard is not decorative): dropping one sample makes the memory metrics disagree
  (overall slope 0.3698 → 0.3895), and the tool prints `REFUSED` and exits **2** rather than publishing
  plausible CPU numbers from mis-mapped inputs.
- Contamination caveat, stated because it bounds the number: this run's host also ran a full-project `tsc`
  emit and four test suites during the run, and from ~09:15 it shares the machine with the user's own work.
  Read the recomputed CPU as **attribution** (which process, which phase, which leg) and not as a clean
  per-minute cost; the first run whose payload carries the fixed reader is the comparable one.
- History: that fix also landed after the 07:06 launch, so this artifact carries no `historyPersist`. The
  app-side metric itself is proven (`5/5` on the rewrite-storm test, `19/19` payload contract); `--stdout`
  recovers rows for a payload written before ingestion existed, and the first run whose payload carries the
  block is the next one.

**Decision — finish and recompute, not a third restart.** The memory bisect in flight is the run's actual
deliverable and it is valid; CPU is exactly recoverable offline (proven above on this very data) and history
is absent from one artifact only. A third launch would pay another 4 hours of the user's machine for a block
that is already reconstructible, and would put a fresh full-workload soak on top of the user's own working
session — the contamination it would inherit costs more than the field it would add.

**STOPPED at 08:10 local, at the operator's request (supersedes the decision above; 2026-09-20).** The
operator needed the machine for their own work session, so the run was ended deliberately — this is a stop,
not a failure, and the artifact must not be read as a run that crashed. What the stop leaves, all of it on
disk before the process died:

- `real-soak-8h-legs4h-checkpoint.json`, written **08:07** on the harness's own 10-minute cadence: **61
  samples**, last at 08:06, `stats` 60 bursts / 572 switches / leg 1's observed window recorded
  (`legs[0] = baseline`, 60 bursts, 572 switches). Sampling and the checkpoint writer were both alive at the
  cut: the checkpoint advanced from 51 to 61 samples across the 10 minutes before it.
- `real-soak-8h-legs4h-checkpoint-recomputed.json`, the offline CPU sidecar over that checkpoint (see above):
  memory round-trip agrees, CPU **131.547 s / 19.02 min = 6.916 s/min**, 15 pids.
- Teardown verified: the harness pid and its Electron tree (main 14108) are gone; the surviving `electron.exe`
  processes belong to the operator's own app (`--user-data-dir` = the default profile) and to the detached
  terminal **daemon host** (`daemon-entry.js`), neither of which this run owns and neither of which was touched.

What it does **not** have, stated so a reader does not infer it later: no final payload, therefore no
`metrics.verdict`, no `metrics.cpu` (the in-flight reader was the pre-fix one — CPU is the sidecar, not the
payload), no `historyPersist`, and **legs 2 and 3 never ran**, so the bisect's discriminator (leg 2 at 4× the
burst volume, and leg 3 as the monotone-decay falsifier) is still an open measurement. The pre-registered
predictions above remain unfired, which is the point of having registered them: a resume re-runs the same
schedule and reads them against a run that has not been fitted to its own outcome.

Defects confirmed by reading the instruments during this run and **not** yet applied (each has its evidence
in the session that found it; none is time-critical before the bisect is re-run):

1. The leg boundary does not reset `nextBurstTime`, so a leg with a long interval followed by a loud one
   starves the loud leg's opening minutes (the schedule here puts the silent leg last, which is why this run
   is unaffected — a future reordering would be silently biased).
2. An open leg's `observedMinutes` is the *scheduled* span (`observedTo ?? endAt`), so the live leg reported
   60 minutes after 10 minutes of runtime; the fit is unaffected, a reader computing a burst rate is not.
3. Ledger `B41` states its closure as `all-of` over two negated markers, which only reopens the row when
   *both* markers vanish; a partial revert (one marker dropped) leaves the tripwire green. `any-of` matches
   the `closedBy` wording, which pins both.
4. The analyzer prints the top CPU consumer of the workload as `unattributed` even when it is `rootPid`
   (pid 14108 here — the main process) — the headline fact of a CPU reading.
5. The analyzer's leg table prints per-pid *memory* but not per-pid *CPU*, though `cpuDelta.per` already
   carries it, so "whose cost scales with the burst volume" is unanswerable from the artifact.
6. `historyPersist` is in the payload but no analyzer section prints it, so the new metric is readable only
   by opening JSON; and the derived-leg windows anchor to `startedAt + warmupMinutes` rather than to the
   first observed workload sample, which disagrees with every other section when warmup overruns.
7. Two history-store guards the fix's own design implies but does not contain: an unchanged title still bumps
   `mutationVersion` (discarding an in-flight snapshot and re-arming the debounce for zero content change),
   and `persistSync` clears the timer but not `persistArmedAt` (so the next mutation takes the ceiling path
   and writes immediately instead of debouncing).

**Pre-registered predictions (recorded 06:55, before any leg has frames).** The bisect's value
is that it was not fitted to its own outcome, so each leg's reading is fixed in advance:

| leg | if the cost is per **line** | if the cost is per **minute** |
|---|---|---|
| `baseline` (300 lines / 30 s) | 47536 floor ≈ **0.22 MB/min** (reproduces 0.2234) | 47536 floor ≈ **0.17–0.22 MB/min** (indistinguishable — this leg is the control) |
| `burst4x` (1200 lines / 30 s) | floor ≈ **0.8–0.9 MB/min** (4× leg 1) | floor ≈ **leg 1 ± noise** |
| `burst-off` (1 line / 600 s) | floor ≈ **0** | floor ≈ **leg 1** |

Leg 2 is the discriminator; leg 3 is the falsifier of a monotone time-decay, because a cost
that rises 4× and then collapses cannot be a decay of the same thing.

**Leg 2 is also the throughput measurement** the concurrency objective asks for: 40 lines/s of
PTY output while switching tabs every 3 s. Its `switchLatencyMs` and its observed burst count
are read as a work-rate result, not only as a bisect leg.

**The switch tail is in this run (corrected at the restart).** The tail instrument landed at 06:52,
after the first launch (06:34), so that attempt's payload kept only the ten slowest switches. The
re-launched run (07:07) postdates it and therefore carries the **whole series** with a leg stamp on
every row, which is what lets the tail be attributed per leg rather than argued from ten samples.
The earlier limitation is kept here as the reason the restart's tail section is the comparable one.

### Instrument — the whole switch series, so the tail can be attributed (applied, next run)

The gate now grades percentiles and reports the maximum, which leaves the question the 4 h
verdict could not answer: **what produces the tail**. The harness collected every switch
(`switchSamples`, one `{at, ms, tabId, phase}` per switch) and then dropped the series at
report time, keeping ten rows. Ten rows can say the tail exists; they cannot separate the two
candidates that matter, because a stall that collides with the terminal write path and a stall
indifferent to it produce the same top ten.

Applied in `scripts/benchmark-real-soak-8h.cjs`: the payload carries the **whole series**
(capped at 20 000 rows — 4 h at a 3 s cadence is ~4 800 — with `switchSamplesDropped` beside
the cap so a truncated series is never read as a complete one), each row stamped with the
**leg** it ran in (`baseline#1`, `burst4x#2`, …; ordinal included because a returning bisect
would otherwise merge legs 1 and 3) and its phase. `scripts/analyze-soak-app-only.cjs` reads it
as a **switch tail** section: an independent recompute of the workload quantiles that states
whether it *agrees with or contradicts* the reported gate, stall counts per phase and **per
leg** (the burst-volume A/B, on one series in one run), and the positions of the stalls inside
the harness's own 60 s sampling interval with every switch printed beside them, so a pile-up
that is only the harness's scrape is visible as one.

Narrow checks: `test/unit/soak-switch-series.test.mjs` grades the **real** `buildReportPayload`
(now exported for this, like `evaluateFreezeVerdict`) — every switch carried, the cap reported
rather than silent, the slowest ten still ranked by latency, an absent series yielding `[]`
instead of a missing field — **5/5 pass**; and fixtures over the analyzer verify derived and
observed leg modes plus all three switch-tail paths (series agrees, series contradicts, legacy
artifact without the series).

### Phase 5 — Close
Verdict with every gate, per-process evidence, and a changelog entry. The machine-checkable
`plans/bottlenecks.json` ledger is scoped to build/gate/devloop/hygiene defects, so an app
runtime perf finding is recorded in the verdict report rather than invented as a ledger row.

## Acceptance criteria

1. The 4h soak's report names the process that grew, by role and URL, not just by PID — and
   the name must come from the app-owned telemetry stream, because the parent-pid walk also
   picks up unrelated processes whose pid a dead parent used to hold.
2. The **app-owned** renderer slope is inside 0.15 MB/min on the fixed bundle and the fix is
   traceable to a retaining allocation, not to a threshold change. The gate field
   `rendererActiveSlopeMBPerMin` is reported alongside, with its contamination quantified,
   instead of being read as if it were app-only.
3. Switch latency max is inside 35 ms **on the workload phase**, or the outlier is
   characterised as a one-off with evidence. The warmup distribution is printed next to it,
   because the gate currently accumulates both phases while the memory gates are scoped to
   workload samples.
4. Every gate the previous run passed still passes (no pass bought by weakening a gate).
5. `npm run compile` and the touched test suites are green.

## Risks

- **Restart during the soak**: the run is long; a machine sleep invalidates it. The
  harness discounts sleep and the recovery phase catches a degraded teardown.
- **Bundle drift during measurement**: a recompile between launch and verdict would leave
  the measured bundle different from the delivered one. No source edit is compiled until
  the 4h run ends, which is why the follow-up below is recorded rather than applied.

## Follow-ups — APPLIED after the measured run ended (each with its narrow check)

Both renderer items were held out of the measured bundle on purpose (see Risks: bundle drift), so
the 4 h run's own numbers are pre-fix. They are in the tree now, and the third candidate was
refuted rather than implemented.

| # | item | status | narrow check |
|---|---|---|---|
| 1 | `getTabs()` re-fetch per tab broadcast | **applied** | delivered list beats a *differing* re-fetch on the badge text, and no `getTabs` call; mutation on the bundle the harness actually loads (`.compiled/src/renderer/standalone.js`) → **46 pass / 1 fail** on "a delivered tab list must not be re-fetched"; restored → 47/47 |
| 2 | 48 selector parses per tab-strip render | **applied** | real-DOM probe (jsdom + emitted bundle, `scripts/probe-toolbar-render-cost.cjs`): first paint **54** (42 = 7 refs × 6 tabs + 6 `.tab-close` + 6 `.tab-audio-btn`), steady-state **0** `querySelector` with 12 `getAttribute` on the children list, +1 tab **9**, −1 tab **0**; cache proven non-staling (title/agent/loading/audio all repaint) |
| 3 | default PTY spawned 1.1 s after start | **refuted** | `#terminal` is a permanent container: no collapse/hide affordance exists anywhere in the renderer, and that same call *is* the saved-session restore path (`TerminalManager.startTerminal` → `readSavedSessions`), so suppressing it hides a user's terminals instead of saving 83 MB. The app's own idle mechanism is `state === 'sleeping'`, not lazy spawn — a product decision, not a defect |

Fixes 1 and 2 remove the work that ran on every broadcast. The *quantified* claim is deliberately
not made here: whether the private-bytes floor flattens is what Phase 4b measures. The mechanism
proposed for the retention (Blink attribute/string table plus IPC buffers holding the page
committed until view teardown) remains `[INFERENCE]` — the fix is justified by the work removed,
not by the mechanism.

## Open after this pass — one item, with the reason it is not a patch

The six instrument defects and the history-store defect were fixed after the run was stopped
(see the changelog for the batch and its proof). Two findings from the same pass are recorded
here instead of patched:

1. **`api.getTerminalAffinities()` is still one `invoke` per 5 Hz broadcast** (~72,000 per 4 h),
   and no push channel exists for affinities. A renderer-side cache was **rejected with
   evidence**, not deferred for effort: main still owns writers the renderer cannot observe
   (`native-tab-host.ts:1667` revive, `:6221` entry deletion, `:7073-7120` tab-driven updates),
   so a cached map cannot be proven fresh, and a stale badge is a worse failure than the CPU the
   cache would save. The correct shape is to carry affinities in the broadcast payload itself —
   the same move follow-up 1 made for the tab list, and the only one with no staleness window —
   which changes main's payload contract and therefore needs its own pass with a payload test.
2. **The retention owner is still unnamed, and the existing data cannot name it.** The terminal
   write path is now *refuted* by caps in the code itself (`scrollback: 10000` at
   `standalone.js:2034,2599`; `MAX_RECOVERY_QUEUE_BYTES`/`_CHUNKS` at `:1283-1284`, enforced at
   `:1497-1498`; `MAX_HYDRATION_WRITE_CHARS` at `:1663`) — a monotone slope cannot come from a
   saturated circular buffer — and the inventory found no unbounded renderer structure on that
   path. What remains are engine-level effects (Blink string interning under the fixture's 5 Hz
   title churn, allocator/page behaviour under IPC + terminal parse churn), which the current
   payloads cannot separate from host contention. The decisive test needs either a run with the
   burst legs (legs 2-3) or a sub-step timer inside `switchTab`; both need the app live, which is
   why they are recorded rather than run. See
   `plans/reports/runtime-verification/renderer-retention-lead-analysis-20260920.md` and
   `.../switch-tail-spike-analysis-20260920.md` (the tail is steady-state, not an outlier:
   22/1143 switches over 35 ms, median gap 105 s, whole distribution shifted ~2.5x, and the shift
   is inside `NativeTabHost.switchTab()` while `tabs.layout` stays under 0.2 ms).

### Analysis behind rows 1 and 2 (written while both were still candidates)

- **Redundant `getTabs()` per tab broadcast.** `api.onTabsUpdated((tabs) => …)` already
  receives the tab list, and `updateAffinityBadges()` immediately calls `api.getTabs()`
  for the same data. Both sides build it from the same `tabHost.getTabList()`
  (`bridge-server.ts:2675` for the RPC, `native-tab-host.ts:7787` for the broadcast), so
  the second round-trip is pure cost on the main thread — the thread every switch, bridge
  RPC and terminal fanout also runs on. Passing the delivered list into
  `updateAffinityBadges(tabs)` halves the per-broadcast RPC count without changing what
  the badges read.
- **42 `querySelector` calls per tab-strip render.** `renderTabs()` is correctly
  create-or-update (handler wiring happens once, `titleSpan.textContent` only on change),
  but each invocation re-queries seven child elements per tab — `indexBadge`, `spinner`,
  `icon`, `statusDot`, `titleSpan`, `audioBtn`, `agentBadge` — with attribute/class
  selectors, and a tab-strip signature that includes `title` means the fixture's
  200 ms retitle drives it at up to 5 Hz. That is ~210 DOM queries/s plus one
  `requestAnimationFrame(scrollIntoView)` per active tab per run. Memory is bounded, so
  this is not the creep; it is CPU spent on the same thread pool the tab renderers and the
  main process share, which is what the concurrency goal is actually bound by. Caching the
  child refs on the wrap element at creation removes the queries without changing what is
  painted.

## Contamination: the gate series is not app-only (measured, corrects an earlier claim)

Two memory views ship in one report and they do not agree, because they are built two
different ways:

1. **Harness tree walk** — `sampleMetrics()` → `collectProcessTree(all, rootPid)` by
   **parent pid**. Drives `totalWorkingSetMB`, `byType`, and therefore every gate series
   (`activeWorkingSetMB`, `activeRendererWorkingSetMB`, `rendererActiveSlopeMBPerMin`).
2. **App telemetry stream** — the app's own `[antifan-benchmark]` rows, one per process per
   minute with `role` + `url`. Drives `perProcessSlopes` / `worstProcess*`. On this run it
   carries **8 pids, all app-owned**.

The walk is not app-owned. Measured live on the running tree (root 28216):

| class | procs | MB |
|---|---|---|
| app-owned Electron | 9 | 1372.4 |
| terminal pty chain (2 sessions: winpty + conhost + powershell) | 6 | 166.2 |
| **foreign (Zalo.exe + ZaloCall + ZaloCap)** | 11 | **526.4** |
| tree total — what the harness reports | 26 | 2065.1 |

Zalo is inside the tree because Windows reports its parent as pid 11704, which is now the
soak app's own crashpad-handler; its real parent exited and the pid was recycled. A walk by
parent pid therefore swallows unrelated processes, and any such process inflates the gates.

**Retraction.** An earlier reading in this session claimed a +511 MB footprint regression
and +11 processes against the 2 h baseline (26 procs / 1995 MB vs 15 / 1484 MB). That
reading was Zalo. On the app's own composition the two runs match: **5 renderers
(742.6 MB vs 728.62 MB, +1.9 %)**, 1 browser, 1 GPU, 1 utility, 1 crashpad. The
"8 renderers / +324 MB" was Zalo's three renderer processes (51.8 + 190.6 + 86.8 = 329.2 MB);
"GPU 2" was app 1 + Zalo 1; "utility 5" was app 1 + Zalo 4.

**Consequence for the gate.** `rendererActiveSlopeMBPerMin` sums app tabs *and* any foreign
renderer the walk catches, so for **this** run the number cannot be read as app-only. But the
2 h run is a different case and an earlier note here got it backwards: its own
`byType.renderer.count` is **5** in every sample, i.e. exactly the app's renderer count, where
a walk that had swallowed a foreign Electron app would have reported 8 (this run does). The
2 h walk therefore caught no foreign renderers, and its failing 0.208 MB/min — 0.1687 MB/min
by endpoint over its 60 workload minutes (717.16 → 727.28 MB) — was measured on AntiFan's own
five renderers. **Retracted:** "a chat client drifting over two hours fits that number equally
well." It does not; that hypothesis is dead, and the original concern stands.

**The clean series for this run is the app-owned one.** Slopes below are over the **whole
40-frame series (warmup + early workload)**, which is not the window the gates use:

| app-owned pid | type | role | slope MB/min (whole series, 40 frames) | first→last MB |
|---|---|---|---|---|
| 47536 | Tab | `chrome:standalone+chrome:toolbar+chrome:frame-backdrop` | 0.325 | 160.65 → 181.56 |
| 28216 | Browser | — | 0.370 | 198.35 → 223.49 |
| 11244 | Tab | `tab:63a8c54b` (wikipedia) | 0.142 | 146.88 → 152.79 |
| 34196 | GPU | — | 0.059 | 179.07 → 182.70 |
| 33800 | Tab | 4 fixture tabs, one process | 0.058 | 126.45 → 133.86 |
| 25348 | Tab | `tab:5939438c` (example) | 0.018 | 122.41 → 123.98 |
| 46880 | Utility | — | −0.001 | 112.50 → 112.32 |
| 44852 | Tab | `tab:c4aa5fac` (google) | −0.006 | 150.41 → 148.81 |

App Tab sum **0.537 MB/min** over that whole-series window; foreign Tab sum **0.000** (never
in the stream). The **Browser process at 0.370 MB/min over the whole series collapses to
0.0662 MB/min over the workload window** (207.71 → 208.24 MB), against the 2 h baseline's
0.0922 MB/min over its 60 workload minutes — so the "main-process growth series no gate has
ever covered" is cold-start settling, not a regression, and the window label is what makes
that visible.

**Fix after the run**: scope the walk to app-owned processes (exe under the app path plus
`--user-data-dir` matching the soak root, or refuse a walk edge that lands on a pid whose
command line is not the app's) and label which series each metric is computed from.

## Instrument corrections (each measured on this run)

- **Working set is the wrong instrument for a leak gate; committed private memory is the
  right one.** Same five app renderer pids, same 8-minute workload window, two series from the
  same frames:

  | series | first | last | sd | range | LSQ |
  |---|---|---|---|---|---|
  | `workingSetMB` | 731.50 | 742.64 | 3.84 | 11.90 | **+1.0874 MB/min** |
  | `privateBytesMB` | 267.02 | 267.05 | 2.49 | 9.06 | **−0.1775 MB/min** |

  The "renderer growth" in the window is shared-page movement, not retention. Per-pid private
  bytes over the same frames: google 58.0 constant to 0.1 MB, example 29.4 → 29.1, chrome
  87.8 → 88.8, wikipedia 55.8 → 50.8, **fixture-4-tabs 36.0 → 40.4 sawtoothing**
  (37.5 / 36.4 / 36.2 / 38.2 / 36.1 / 37.2 / 38.5 / 40.4). One committed-growth candidate
  exists — pid 33800, the four local fixture pages that share a single renderer, ≈ +0.55
  MB/min private — and the 180-minute series is what decides plateau-by-GC from linear
  retention. The gate should carry the `private` slope per process and keep the WS series
  labelled as the noisy proxy it is, because WS also moves when the OS trims shared pages.
- **`rolling60MinSlopes` is `[]` in this checkpoint** and fills only once 60 workload minutes
  exist. It is the long-window instrument the verdict needs; its emptiness now is not a
  signal.
- **Config presence is not comparability.** The 2 h artifact *does* carry `config`, but only
  the four durations (`totalMinutes`/`warmupMinutes`/`workloadMinutes`/`recoveryMinutes`) —
  no `switchIntervalMs`, `burstIntervalMs`, `burstLines`, `tabRounds` or `fixtureTickMs`. Its
  driver cadence is therefore unrecoverable from its own report; this run's config carries
  all of them. Both runs report `openedTabs: 6`, and this run *does* record its tab list
  (`switchLatencyByTab`, 130 switches each) while the baseline records none.
- **Latency is not comparable to the 2 h baseline, and the artifact cannot repair that.** The
  per-tab table is uniform — p50 11.659 (product-test-2), 11.851 (example), 12.003
  (collection-featured), 12.217 (store-home), 14.007 (wikipedia) — and its run minimum is 6.76
  (9.47 at the 130-switch point) against the baseline's 3.092, so the whole distribution is
  shifted by an additive floor, not by one
  pathological destination. Two uncontrolled confounds: the machine load was never recorded
  (the harness has no CPU/process covariate while the user's own app, this OMP session and a
  terminal daemon share four cores), and the **bundle changed between the runs** — the
  toolbar and theme-studio-cockpit rebuilds shipped after the 2 h soak. Judge the 35 ms gate
  absolutely, with the phase split: on the early checkpoint that motivated this note every
  sample above 35 ms was warmup, but at 178 workload frames **2 of the 10 slowest are warmup
  and 8 are workload, with a workload max of 50.976** — so the max gate breaches in the
  steady-state phase with the startup explanation dead. The honest verdict stays "not
  comparable to the 2 h run", but for a different reason than this note first gave: the tail
  is steady-state and global, and the comparison is spoiled by the two renderer rebuilds
  shipped between the runs plus an unrecorded machine load, not by warmup.
- **A second PTY session exists that no one asked for.** Two winpty chains hang off the soak
  app (parent 28216): pid 15936 at **00:52:11.961**, 1.1 s after the main process started
  (00:52:10.817), and pid 45928 at **00:52:19.233**. The harness spawns exactly one
  (`rpc('antifan.terminalNewSession')` at `benchmark-real-soak-8h.cjs:909`, after the 6 tabs)
  and the profile is wiped before launch (`fs.rmSync(soakDataDir)` at `:596`), so nothing was
  restored. The only `createSession` caller is the `antifan:terminal:new-session` IPC handler
  (`native-tab-host.ts:1828`), which means a renderer asked for a shell 1.1 s into startup.
  Persisted state names them `terminal-1` / `terminal-2` with `activeSessionId: terminal-2`
  (the harness's). Cost: one winpty + conhost + powershell chain, ~83 MB, idle for the whole
  4 h. Follow-up fix: spawn the default session lazily on first dock mount instead of at boot.
- **The pid set is constant.** All 41 samples carry the same 26 pids (1 distinct set), so the
  foreign-process contamination is a level offset, not a step, and its drift is bounded:
  residual = `totalWorkingSetMB` − the 8 app pids ≈ 792 → 798 MB across the workload window
  (+2.3 MB over 9 min, with one 874 MB outlier at 18:27:25).



## What the renderer gate actually computes (measured, decides the verdict method)

`rendererActiveSlopeMBPerMin` = the least-squares slope of the **workload-phase** renderer
series. Reproduced on the 2 h artifact with an independent fit: **0.2082** against the
reported `0.208234`. So the gate is not polluted by warmup — and on that run it still failed a
0.15 MB/min threshold on a series whose shape is:

```
717 717 717 719 720 719 720 719 727 728 728 728 729 729 720 721 723 724 724 725 724 726
727 726 727 727 728 729 729 718 720 720 721 721 723 727 726 727 727 731 729 729 732 729
728 729 730 730 731 732 731 731 732 732 734 732 733 736 733 727
```

| 2 h phase | n | mean | sd | range | LSQ |
|---|---|---|---|---|---|
| warmup | 31 | 721.92 | 6.30 | 21.78 | **−0.4510** MB/min |
| workload | 60 | 726.30 | **4.86** | 18.98 | **0.2082** MB/min |
| workload, last 30 min | 30 | — | — | — | **0.3965** MB/min |
| recovery | 31 | 322.46 | **0.86** | 2.97 | −0.0388 MB/min |

Read the shape, not the slope: three drop-and-regrow cycles (729→720, 729→718, 736→727)
around a slowly rising baseline. Amplitude **18.98 MB** against a total drift of **10.12 MB**,
so the verdict is decided by *where the phase boundaries fall in the sawtooth*, and the
last-30-minutes slope (0.3965) is twice the full-phase slope (0.2082) — the opposite of a
saturating leak. A leak also does not evaporate in recovery: **322.46 MB, sd 0.86 MB, no creep
over 31 idle minutes** after the tabs close.

**Consequence: the 0.15 MB/min threshold cannot be judged on a raw series of this shape.** A
19 MB amplitude against a 10 MB trend means even 60 minutes is marginal, and a short window is
worthless. What a retention defect moves is the **floor** — the value the series returns to
after each collection — so `scripts/analyze-soak-app-only.cjs` prints the rolling-minimum
envelope beside the raw series plus the amplitude/drift ratio that says whether a trend is
measurable at all. First readings, all from the run's early minutes:

| window | series | raw LSQ | floor LSQ | amplitude/drift |
|---|---|---|---|---|
| 4 h warmup | WS | 0.87 | 0.89 | 1.1× |
| 4 h warmup | private | 0.92 | **1.14** | 1.1× |
| 4 h workload (8 min) | WS | **1.09** | 0.46 | 1.1× |
| 4 h workload (8 min) | private | −0.18 | **−1.15** | 302× |

Warmup grows in committed memory (235 → 264 MB — the "caches warmed" phase the harness
describes) and the workload window so far does not (+0.03 MB drift over 8 min). Eight minutes
decides nothing; the 180-minute floor series is the test.

**Baseline limitation, stated because it bounds every claim**: the 2 h artifact has **no
per-process series and no committed-memory series at all** (`processSeries` rows: 0 — those
fields landed after that run). Its renderer series is `samples[].byType.renderer`, which its
own counts show to be app-only (5 procs), but it cannot answer "was the 0.208 a leak" in the
currency that decides it. Only this run can.

## Harness findings measured on this run (fix after the verdict, not during it)

- **The latency gate is not phase-scoped, but phase scoping does not explain the tail.**
  `switchLatencies` accumulates for every non-recovery phase while the memory gates read
  `label === 'workload'` samples only. On the 01:02 checkpoint every sample above 35 ms lay in
  warmup, and this note originally generalised from that. At 178 workload frames the opposite
  holds: **8 of the 10 slowest switches are workload** (50.976, 44.773, 44.071, 43.066, 42.163,
  42.020, 41.533, 40.631) and only two are warmup (46.014, 45.652). The phase-scoping fix still
  stands on its own — a startup sample should not decide a steady-state gate — but it must not
  be used to excuse the breach, because the breach is steady-state.
- **The slow tail is not destination-specific.** Per destination, 682 switches each:

  | destination | p50 | p95 | max |
  |---|---|---|---|
  | store-home | 10.49 | 14.95 | **50.98** |
  | product-test-2 | 10.17 | 14.62 | **46.01** |
  | wikipedia | 10.88 | 16.94 | **45.65** |
  | collection-featured | 10.28 | 14.72 | **42.16** |
  | product-test-1 | 10.34 | 15.17 | **41.53** |
  | example.com | 10.13 | 15.14 | **38.10** |

  Every destination reaches 38–51 ms while every p95 sits at 15–17 ms, so the tail is a global
  stall that hits all six equally (≈0.2 % of 4 090 switches), not a per-page cost. That refutes
  both the 2 h run's wikipedia/google attribution and this plan's Phase 3c "per-destination
  cost" branch. Every p50 is also 10.1–10.9 and the run's fastest switch is 6.76, against a 2 h
  baseline whose fastest switch was 3.09 — the whole distribution is shifted, not just its tail.
- **The scrape-collision explanation is refuted.** The comment above `switchSamples`
  offers the harness's own per-minute process-table scrape as a candidate for the outlier.
  Measured: 1 of the 10 slowest switches sits within 3 s of a scrape and it is the
  *smallest* of them (17.0 ms); the three worst are 3.2 s, 29.3 s and 43.0 s away. The
  comment must state what the data shows, not a mechanism the data contradicts.
- **`calculatePerProcessSlopes` silently drops its window before the workload phase.**
  The window comes from the workload samples' stamps and falls back to `NaN`, and the
  finite-check then skips filtering entirely, so a mid-run checkpoint prints whole-run
  slopes in a field that reads as workload-windowed. Evidence: the 01:02 checkpoint carries
  8 populated slopes while `activeWorkingSetMB` is `{min:null,…}` for the same payload. The
  final report is unaffected because workload samples exist by then; the payload should
  carry the window it actually used.
- **Non-WebContents rows report an empty `role`.** On the 01:02 checkpoint those rows are
  `type: Browser` (pid 28216, +10.96 MB over the warmup window), `type: GPU` and
  `type: Utility`. `type` carries the identity, so the verdict must name them by type. The
  Browser row is not the growth series it looked like: its whole-series slope of 0.370 MB/min
  is 0.0662 MB/min across the workload window, i.e. warmup settling against the baseline's
  0.0922 MB/min — but the emptiness still makes a reader guess which process a row is.

- **`activeWorkloadMinutes` measures the wrong span for its name.** It is computed as
  elapsed-since-start minus suspended time, so the 01:12 checkpoint reports
  `activeWorkloadMinutes: 10` ten minutes into a thirty-minute warmup. Same class as the
  window label above: a field whose name asserts a scope it does not measure. The verdict
  and any later comparison must read it as "active minutes since start".

## Committed-growth finding: the chrome renderer owns it (68- and 129-minute reads)

Across the first **68 workload minutes** (69 frames), exactly one app process grows in
committed memory, and the floor confirms it is not noise:

| pid | type | role | private first→last | pv LSQ | 10-min floor first→last | floor LSQ |
|---|---|---|---|---|---|---|
| **47536** | Tab | `chrome:standalone+chrome:toolbar+chrome:frame-backdrop` | **87.8 → 99.7 MB** | **+0.171** | **86.19 → 96.43** | **+0.167** |
| 11244 | Tab | wikipedia | 55.8 → 51.8 | −0.008 | 50.29 → 51.83 | +0.037 |
| 28216 | Browser | — | 141.6 → 151.8 | −0.052 | 140.13 → 145.06 | +0.023 |
| 25348 | Tab | example.com | 29.4 → 29.9 | +0.016 | 29.11 → 29.91 | +0.021 |
| 46880 | Utility | — | 14.4 → 14.3 | −0.001 | 14.29 → 14.31 | 0.000 |
| 44852 | Tab | google.com | 58.0 → 58.0 | **0.000** | 58.02 → 58.02 | **0.000** |
| 33800 | Tab | 4 fixture pages, one renderer | 36.0 → 34.1 | −0.033 | 35.99 → 33.91 | −0.025 |
| 34196 | GPU | — | 163.9 → 144.2 | −0.302 | 157.05 → 125.35 | −0.374 |

The chrome renderer's per-minute private series shows retention with *partial* collection —
each release lands 2–4 MB above the previous one, and the floor never flattens:

```
87.8 87.7 86.8 86.2 87.4 89.3 86.2 87.4 88.8 88.7
89.0 88.5 88.4 89.6 89.7 90.5 90.8 90.8 92.1 91.5
90.7 91.0 91.5 92.3 92.8 92.2 92.2 92.6 93.2 91.9
92.3 92.4 93.9 94.4 92.7 92.8 94.1 94.4 94.2 93.8
94.6 94.3 96.6 94.5 94.4 95.1 96.0 93.6 95.6 95.4
95.9 97.3 95.1 95.8 95.9 97.8 98.8 95.7 96.3 96.4
97.4 97.2 97.5 98.2 98.4 98.4 99.0 98.7 99.7
```

**Consequences.**

1. Acceptance criterion 2 currently **fails on measured, app-owned, committed memory**:
   0.167–0.171 MB/min against the 0.15 threshold — and unlike the 2 h number this is not working
   set, not shared pages, and not a foreign process. ~10 MB/hour, ~30 MB over the soak.
2. The "the renderer series was in fact comparable all along" comfort does not apply to this
   process: page renderers are flat, the *chrome* renderer is not.
3. **The 129-minute read confirms retention, not high-water.** Same pid, same window, 129
   frames: private 87.8 → **109.9 MB** (+22.13 MB), floor 86.19 → **107.87 MB**, floor LSQ
   **+0.176 MB/min** — and the floor's first-half and second-half slopes are **0.170 / 0.169**,
   i.e. the second half runs at 99 % of the first, so the rate has *not* decayed over 2.1
   hours. A high-water curve flattens; this one does not. The staircase that looked like a
   plateau at 61 minutes (a 40-minute pause at 272–277 MB in the aggregate) was a pause, and
   the aggregate then resumed to 281.32 MB. (An ad-hoc first pass read 0.164 MB/min because it
   stretched the floor's x-axis by one frame; the retained instrument in
   `scripts/analyze-soak-app-only.cjs` is the correct one and is what the verdict cites.)
   Per-pid private floor LSQ over the same window: 47536 **+0.176**, Browser +0.07 (halves
   +0.02 / −0.05, i.e. noise), example.com +0.01, Utility 0.00, google.com −0.00,
   wikipedia −0.01, fixture −0.04, GPU −0.11. **One process grows and nothing else does.**

   **In working set the same process reads flat** — 47536's WS floor is 176.88 → 182.22
   (−0.01 MB/min) and the app-only Tab sum is −0.25 MB/min — because the renderer releases
   shared pages at the rate its committed memory grows. The leak is invisible in the currency
   the gates use, which is the subject of the gate section below.
4. **The suspect list stays open: the process is named, the allocation is not.** No positive
   evidence points inside the renderer yet, and the two toolbar follow-ups are *CPU* findings,
   not memory findings — promoting them to "prime suspects" was a leap. The retention could be
   xterm-internal (line/attribute pooling, reflow buffers, `BufferSet` churn across
   hydration), the preload bridge (`onTerminalData` / `onStateUpdated` listener registration),
   `liveQueue` / hydration leftovers, or tab-strip nodes held alive after removal. The decisive
   step is a heap diff across **all three documents that share pid 47536** (the `file://`
   renderer hosts toolbar, terminal sidebar and frame backdrop in one process), and it waits
   for the run because a heap snapshot forces a collection in the process under measurement.
5. **`__terminalBench` is not the leak — verified in code, not assumed.** The renderer's
   instrumentation exists only when the URL carries `__bench=1` (`standalone.js:219`, recording
   into a plain `events` array), and the only caller that passes the flag is
   `test/e2e/terminal-paint-bench.cjs:259`; nothing under `scripts/` sets it, so the soak's hook
   is `null` and its array is never allocated. This is recorded because the reverse is exactly
   what a reader would chase next: an `events.push` per terminal chunk would be a textbook
   linear leak, and it is one flag away from being active.

**Framing for the fix phase, corrected by the number.** The advisory branch resolves to the
*app fix*, not an instrument fix — the floor is not flat. But two things must not be conflated
when the fix is ordered:

- The leak is real, unbounded, always resident and present in every window (~10 MB/h; ~39 MB
  over this run), but against a 1.5 GB working set it is **not** what bounds "more work at
  once". The concurrency goal is bound by CPU on the shared thread pool — the per-render query
  storm, the redundant `getTabs()` round-trip — and by the switch-latency tail.
- Criterion 2's fix is therefore a correctness fix (unbounded growth is a defect at any size),
  and it must not displace the throughput work the objective actually asks for. Phase 3 fixes
  the CPU costs first, the retention second, and the verdict reports them as separate findings
  with separate evidence.

### Gate outcomes at 129 minutes: two artifacts in opposite directions

The checkpoint already carries the live gates, so the verdict's core is already machine-checkable:

| gate | live value | outcome | what it actually measured |
|---|---|---|---|
| `rendererActiveSlopeMBPerMin` | **−0.056089** | **pass** | working set of every renderer the parent-pid walk catches — the app's 5 plus Zalo's 3 |
| peak memory SLO | max **2126.06 MB** vs 1600 | **fail** | the same walk; the app's own 8 pids plus the pty chain ≈ **1409 MB** at the same instant |
| `latencySloSatisfied` | max 50.976 / p95 15.513 / p50 10.346 (final set, 4 090 switches) | **fail** | switch latency with warmup and workload accumulated; 8 of the 10 slowest are steady-state, so the max is not a startup artifact |
| `worstProcessSlopeMBPerMin` | **0.0261** at pid 34196 (GPU) | reported | `calculatePerProcessSlopes` slopes **working set** (`benchmark-real-soak-8h.cjs:403`), then ranks by it (`:422`) |

**The row that proves the instrument is reading the wrong column.** The app's own telemetry
stream carries both currencies for the same pid and the same 129 samples:

```json
{"pid":47536,"role":"chrome:standalone+chrome:toolbar+chrome:frame-backdrop",
 "firstWorkingSetMB":176.88,"lastWorkingSetMB":184.38,"deltaWorkingSetMB":7.5,
 "firstPrivateMB":87.78,"lastPrivateMB":109.91,"deltaPrivateMB":22.13,
 "slopeMBPerMin":-0.0174}
```

`deltaPrivateMB: 22.13` — the growth is *in the emitted row* — and `slopeMBPerMin: -0.0174`,
because that field is the working-set slope. Two consequences, and they point opposite ways:

1. **False pass.** `slopeSloSatisfied: true` on a run whose single growing process is the app's
   own UI renderer. Acceptance criterion 2 as written ("the app-owned renderer slope is inside
   0.15 MB/min") is satisfied by an instrument that is blind to it: app-only, the same window
   reads −0.25 MB/min on the working-set floor and **+0.176 MB/min on the committed floor**.
   The criterion must be re-specified on committed private bytes, app-only, with the working-set
   series reported beside it as the noisy proxy it is; under that specification this run fails.
2. **False failure.** `memorySloSatisfied: false` on a 2126 MB peak that the app does not own —
   the app's 8 pids plus its pty chain total ≈ 1409 MB, under the 1600 MB threshold. The earlier
   +511 MB "footprint regression" was the same contamination, and the 2 h run's 1549.71 MB
   "pass" was the same walk on a quieter desktop, which is why the two runs are not comparable
   in that field at all.

So the run currently has one gate passing on the wrong currency and one failing on someone
else's memory, while the defect neither sees is +22 MB in one process in 2.1 hours. Both
instrument defects are one-line fixes in the harness (`privateMb` is already collected at
`:397`; it is simply not the field passed to `calculateSlope` at `:403`), and they are the
highest-value throughput work in this soak: a lying instrument costs more working time than any
0.176 MB/min leak.



### Trailing-slope test: no bending (P3 resolved, workload complete at 180/180)

The aggregate floor LSQ did fall from ~0.21 MB/min at 68 minutes to ~0.12 at 129, which reads
as deceleration. Per process it is not: 47536's floor slope is flat across every window.

| window | 47536 `floor(10)` slope MB/min | raw private slope |
|---|---|---|
| full 178 min | 0.173 | 0.17 |
| first 60 min | 0.167 | 0.173 |
| last 60 min | **0.162** | 0.165 |
| last 30 min | **0.159** | 0.169 |
| last 15 min | 0.178 | — |

Floor tail, last 20 values:
`113 113 113 113 113 114 114 114 114 114 114 114 114 115 115 115 115 115 116 116` — still
climbing on the final frames, never returning to its earlier 108–110 level. The aggregate bends
because it is a rolling min over a *sum* whose other components are falling (GPU −0.05, fixture
−0.03, wikipedia −0.00): their improvement offsets 47536's rise. **Aggregate deceleration is a
composition artifact; the per-pid instrument decides, and it says constant.**

### Recovery release (P1: view-lifetime retention, not an unreclaimable leak)

47536 survived recovery — it is the window's own renderer, while tabs and terminal closed — and
released most of what it had accumulated:

| | MB |
|---|---|
| workload start (private) | 87.78 |
| workload end | 117.54 |
| workload peak | 118.29 |
| recovery min | 93.25 |
| **released vs peak** | **25.04 (84 %)** |
| residual above workload start | **5.47** |

Recovery private series: `96.3 96.3 93.3 93.3 93.3 93.3 93.3 93.3 93.3` — one step down, then
flat for seven frames, so nothing further was coming. For contrast, the Browser process released
20.98 MB and the google tab 5.64 MB, while the **GPU gained 10.16 MB** during teardown
(reallocation) — which is why this read has to be per-process and not a total.

**The characterization that fits both facts: view-lifetime retention.** Inside a session it
accumulates at a constant ~0.17 MB/min with no visible bound, and it is given back when the views
that own it close, leaving ~5.5 MB behind. It is therefore neither the unreclaimable leak the
first framing implied nor the bounded high-water the plateau reading suggested: an 8-hour day
with the terminal open costs this renderer ~80 MB, and closing the terminal returns ~84 % of it.

### A third instrument flaw, found by comparing currencies at the end state

The app-only Tab **sum** private floor is **+0.14 MB/min** — inside the 0.15 threshold — while
the single growing process *inside that sum* is **+0.17** — outside it. Summing lets two flat or
falling renderers (fixture −0.03, wikipedia −0.00) mask the one that grows: the same blindness
as the walk-based gate, one level down. Criterion 2 must be the **per-process maximum**, not an
aggregate, or it is satisfiable by adding a process.

Final live gate at 178 workload frames: `rendererActiveSlopeMBPerMin` **+0.04** (working set,
walk-based over 8 renderers including Zalo's 3) — a pass — while the app's own committed floor
holds 47536 at **+0.17**. The instrument gap is now measured at ~0.13 MB/min in the deciding
currency, with a sign inversion in the aggregate.

### Suspect list narrowed: four per-broadcast consumers, two of them already dead

The process is named and the shape is settled, so the open question is *which allocation inside
pid 47536*. A read-only pass over the three documents that share that process found four
consumers that run on every 5 Hz broadcast:

| # | consumer | anchor | status |
|---|---|---|---|
| 1 | `updateAffinityBadges()` re-fetches both lists per broadcast | `standalone.js:4685` → `:2710-2775` | **live lead** |
| 2 | `renderTabs()` re-runs on title churn | `toolbar.ts:2413` (signature includes `t.title`), `:2435-2680` | **live lead** |
| 3 | `renderThemeQa()` per push | `toolbar.ts:4178`, `:236-267` | **already rejected below** |
| 4 | `updateControls()` per push | `toolbar.ts:4198`, `:2690-2750` | **already rejected below** |

Ruled quiet by inspection: `frame-backdrop.ts` (layout only on split/resize), the session-activity
caches (`standalone.js:3412`, `:3457` — keyed by session, at most two entries), the write
dispatcher (`terminal-write-dispatcher.ts:260` drains by `splice`), and the stream-activity tail
(`standalone.js:3461` truncates to the trailing 64 characters).

Consumer 1 is the strongest new lead and it is the same site as the standalone `getTabs()`
follow-up above: `api.onTabsUpdated((tabs) => …)` receives the tab list at `:4685` and
`updateAffinityBadges()` immediately re-fetches it (`api.getTabs()` at `:2711`), so every
broadcast costs two `invoke` round-trips — ~106,800 over this run — each allocating a
correlation entry, a promise, a deserialized tab/affinity array and a `new Map`. The contrast
inside one file is what makes it a lead rather than a guess: the author **did** add a signature
guard for the adjacent popover (`data-managed-sig` at `:4689-4694` — "Tabs broadcasts fire on
every title/loading update, and rebuilding mid-click eats the click") and left
`updateAffinityBadges()` immediately above it unguarded.

[INFERENCE] The mechanism offered for consumer 1 — Blink's attribute/string table and V8 IPC
buffers holding committed pages until view teardown — is consistent with a per-push, view-bound
residue, but it is asserted, not measured; a string table also dedupes, so it grows only because
the fixture's retitles are distinct strings. Treat consumer 1 as the best lead, not as the cause.

**Phase 3d cannot separate the two live candidates.** The A/B varies `SOAK_FIXTURE_TICK_MS`,
which is the thing that *drives* the broadcast rate: at a 1 s tick the fixture retitles once a
second, so consumer 1 (per broadcast) and consumer 2 (per title change) scale together and both
collapse. The tick sweep still discriminates "per-broadcast retention" from "Chromium page cost",
which is what Phase 3d was written for — but separating consumer 1 from consumer 2 needs the
targeted fix applied and the floor re-measured, not a rate sweep. Instrument for that re-measure:
47536's rolling-minimum floor over a 60-minute window, where 0.17 MB/min is a +10 MB drift
against a floor whose noise is ~1 MB — detectable without another 4 h run.

### Hypotheses falsified before the verdict (so they are not re-tried)

- **Foreign contamination of this process** — dead for 47536: its role string is built from
  the app's own telemetry stream, and `google` (44852) is exactly 0.000 MB of slope in the
  same window while Zalo's renderers would not report an app role at all.
- **The 5 Hz fixture title storm retaining in a page renderer** — dead: pid 33800 hosts all
  four fixture pages and its private floor *falls* (35.99 → 33.91, −0.025 MB/min) over the
  same 68 minutes that the chrome renderer rises.
- **xterm's 10,000-line scrollback ring filling** — dead as the driver of the measured rise.
  The workload writes `1..300` per burst every 30 s (`benchmark-real-soak-8h.cjs:996`, 600
  lines/min), so two panes at `scrollback: 10000` (`standalone.js:2034`, `:2599`) saturate by
  **minute ~17**. The floor keeps climbing monotonically through minutes 17 → 68 (≈88 → 99.7
  MB), which a saturated ring cannot do. Any plateau attributable to the ring must appear
  before minute 20; none is present.
- **A module-scope accumulator in `toolbar.ts`** — not found: `overlayTokens` is the only
  module-scope container in the file and it is token-keyed and released; every other `push`
  is a local array rebuilt per render.
- **The renderer's own benchmark recorder (`__terminalBench`)** — a per-chunk push that is
  never drained *in code*: it appends `{ stage, ts, extra }` per terminal chunk (`T1`) and per
  write/parse/paint (`T2`–`T4`) into an array with no trim (`standalone.js:219-241`, `:4717`),
  which is the right shape (~300 B/line) and would explain why the growth tracks bytes
  written. **Dead for every soak run: the hook is opt-in on the URL (`urlParams.get('__bench')`),
  and `src/main` has no producer for that parameter** — a repo-wide grep finds it only in the
  renderer, its two compiled copies, a temporary mutation-test copy, and
  `test/e2e/terminal-paint-bench.cjs`, which sets it *and* drains it (`snapshot()`/`clear()`,
  `:259`, `:282`, `:321`). The soak launches the app with `ANTIFAN_BENCHMARK=1` but never
  `?__bench=1`, so the recorder is `null` in the measured renderer.

### Predictions this run will settle (recorded before the data)

1. **If the retention is terminal-bound** (xterm buffer objects, `liveQueue`/hydration
   leftovers, or the terminal sidebar's DOM), the chrome renderer's private floor releases
   materially in recovery, when the harness closes the terminal — expect a drop toward the
   warmup level (~86–88 MB) rather than a stay at ~99 MB.
   **RESOLVED: direction confirmed, magnitude partial.** 47536 released 25.04 MB of its 29.76 MB
   accumulation (84 %) and settled at 93.25 MB — well below its 117.54 MB workload end, but
   5.47 MB *above* its workload start rather than back at 86–88 MB. So the bulk of the retention
   is bound to the closed views and a small residue is not.
2. **If it is not terminal-bound** (tab strip, toolbar, or the state-broadcast consumer), the
   47536 floor stays at ~99 ± 2 MB through the 31 idle recovery minutes while Browser, GPU and
   Utility stay flat — which would also mean the memory is *always* resident and scales with
   how long the window has been open, not with what it is doing.
   **FALSIFIED as written**: the floor did not stay; it dropped 24.29 MB against the workload
   end. The residue does mean the small remainder scales with window lifetime, but the
   dominant term is released with the views.
3. **Retention vs high-water — RESOLVED: view-lifetime retention.** The floor is monotone at a
   rate that is constant across every trailing window (0.167 → 0.162 → 0.159 over the first 60,
   last 60 and last 30 minutes), so the plateau reading is dead; and recovery releases 84 % of
   the accumulation, so it is not an unreclaimable leak either. What remains open is only
   *which* allocation holds it while the view is alive.
4. Recovery is the discriminator for all three and it needs nothing but the final checkpoint.



## Rejected (with evidence, so it is not re-litigated)

- **`renderThemeQa` as a per-push rebuild**: inspected — it assigns one `textContent` and
  toggles two classes, and takes no subtree. It does run on every push because the
  broadcast always carries `themeQa` (`native-tab-host.ts:7799`), but the work is trivial.
- **`updateControls` as an unguarded render**: it performs no subtree work — every DOM rebuild
  it could do is guarded by a last-applied value (`lastAppliedBackDisabled`,
  `lastAppliedForwardDisabled`, `lastAppliedZoomText`, `lastAppliedDevicePresetId`,
  `lastAppliedSplitMode`, `lastAppliedSplitFocusedPane`, `lastAppliedAgentControlled`)
  and a change-detecting signature is therefore not needed. Three writes are unconditional on
  every push — `btnClearOmnibox.style.display`, `btnQuickInspect.classList` and
  `btnFontFinder.classList` (`toolbar.ts:2817-2828`) — but each writes a primitive whose value
  Blink compares before invalidating, so the cost is three O(1) style-token writes on two
  elements, µs per push at the measured 5 Hz broadcast: recorded so the "guarded end to end"
  shorthand is not read as "no write at all".
- **Terminal transcript as the main-process growth source**: `SessionRecord` is chunked with
  `trimTail()` eviction at `MAX_TRANSCRIPT_BYTES = 4 MB` per session (plus a 256 KB
  re-slice overshoot) and `MAX_PERSISTED_BYTES = 1 MB` on disk, and this run holds two pty
  sessions, so the whole transcript is capped around 8.5 MB. The 300-line bursts add roughly
  14 KB each, so it approaches that cap rather than growing without bound — which is why the
  Browser process's whole-series 0.370 MB/min cannot be the transcript — and that 0.370 is
  itself only warmup settling, since the same series reads 0.0662 MB/min across the workload
  window. The remaining candidates are discriminated by the **private-bytes floor series**
  (rolling minimum per collection), not by the raw slope: a rising floor is retention, a flat
  floor is allocation churn under a heap that grows to its high-water mark once.
- **Fixture page as the memory source**: the fixture writes `document.title` and one
  `textContent` per tick and appends no DOM, so a tab-renderer slope is not a fixture
  artifact.
- **The per-chunk terminal write path as an unbounded accumulator** — read end to end
  against the live source, bounded at every retention point:
  `TerminalWriteDispatcher.queueWrite` pushes then either fast-paths, flushes at the 64 KB
  frame budget, or schedules one rAF, and `flushWrite` **splices** what it drained off the
  head index (a remainder chunk is re-spliced in place), with `cancel()` emptying the queue
  and zeroing `queueByteLength` (`src/shared/terminal-write-dispatcher.ts:176-303`). The gap
  recovery queue is capped by `MAX_RECOVERY_QUEUE_BYTES` / `MAX_RECOVERY_QUEUE_CHUNKS` and on
  overflow sets `DEGRADED` and **clears** the queue, after which `DEGRADED` drops further
  chunks instead of queueing them (`standalone.js:1489-1508`, `:1454-1456`). The activity
  classifier throttles to 100 ms and slices its `tail` to 64 chars
  (`standalone.js:3423-3467`). The one genuinely unbounded window is the hydration branch
  (`standalone.js:1442-1452`), which queues every incoming chunk while
  `activeHydratingEpoch !== null`; the epoch is cleared in a `finally` on *every* exit
  including a rejected snapshot RPC (`:1684-1762`, `:1764-1836`), so that window is one
  in-flight await at first activation, not steady-state streaming — it is a burst risk during
  a slow hydration, not the per-minute rise.
