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
hold at once. The table below is written to match what `evaluateFreezeVerdict` actually
grades, because it grades a **leg run differently**: with `LEGS.length > 1` the memory
slopes report `null` (not-applicable) instead of a number a reader would take as a verdict —
"one slope fitted across legs that ran different burst volumes is a blend of regimes and
grades nothing" — while the peak and the latency percentiles stay graded. Per-leg
`topSlopes` is the memory measurement for such a run.

| Gate | Bound | 2026-09-19 2h run | 2026-09-21 4h legs run (perf4h, in flight) | Consequence for concurrency |
|---|---|---|---|---|
| renderer memory slope | ≤ 0.15 MB/min | **0.208** (reproduced 2/2 runs) | 0.0797 — **not graded on a leg run** (`slopeGateApplicable: false`) | a long session ends in a restart, which costs every live tab and terminal |
| switch latency | p50 ≤ 12 ms **and** p95 ≤ 18 ms, workload phase (`switchMaxMs` reported beside them, not graded) | max **42.1** (1 of 1756 switches, p95 6.8) | **p50 15.693 / p95 20.53 — fails** (max 30.94) | the user is told not to trust a switch; this is the gate a person feels |
| peak active memory | ≤ 1600 MB | 1549.7 | **1607.08 — fails** | a larger tab count has no headroom left |
| `appPrivateMaxSlopeMBPerMin` | ≤ 0.15 MB/min | not measured | 0.1828 — reported, **not graded on a leg run** | tighter app-owned companion to the slope row |
| orphans | 0 | 0 | 0 | — |
| execution / teardown | clean | clean | clean | — |

This run's verdict is therefore `FAILED` on exactly two graded criteria — the peak and the
latency percentiles — and a leg run that passed everything else would report the harness's
own name for it, `PASSED_SLOPE_NOT_GRADED`.

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
   # 1. Launch the diagnosis soak WITH the DevTools endpoint. SOAK_APP_ARGS is read by the harness
   #    (scripts/benchmark-real-soak-8h.cjs) and appended to the app's argv; setting it on the
   #    probe's own command line - as an earlier revision of this block did - does nothing except
   #    leave the probe with no DevToolsActivePort to read. Tag it so a diagnosis run is never
   #    mistaken for a clean measurement. --minutes 120 gives a 30/60/30 split (the harness prints
   #    this at launch, and 240 -> 30/180/30 fixes the split), so the baseline leg spans the full
   #    60 minutes the CPU comparison needs.
   SOAK_APP_ARGS="--remote-debugging-port=0" SOAK_REPORT_TAG=probe1 \
     SOAK_LEGS="baseline:60:300:30000" node scripts/benchmark-real-soak-8h.cjs --minutes 120

   # 2. Attach the probe to the running app's profile while it is in flight.
   node scripts/probe-renderer-retention-class.cjs \
     --profile=E:/Work/.antifan-soak-8h/Profile --samples=6 --interval-ms=60000

   # 3. Attribute the captured probe stdout to the right phases. The analyzer's defaults are
   #    legs4h2's window (--start=01:41:29, --schedule=30,60,60,60,30), so any other clock is
   #    mis-phased unless both are passed; for the 30/60/30 run above that is 30,60,30.
   node scripts/analyze-retention-probe-log.cjs <captured-probe-log> \
     --start=<HH:MM:SS of the probe run's start> --schedule=30,60,30
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

**Run identity (2026-09-21, tag `perf4h`).** Launched 06:20:18 with `--minutes 240` and the Phase 4c
schedule `SOAK_LEGS="baseline:60:300:30000,burst4x:60:1200:30000,burst-off:60:1:600000"` — the same
schedule §Phase 4c specifies, so this run carries both the full-window floor *and* the volume-vs-time
legs in one artifact. The tag diverges from the plan's earlier `legs4h` name on purpose: yesterday's
`legs4h` artifacts already exist under `real-soak-8h-legs4h*`, and a run that writes to the same
names would overwrite the prefix it is meant to be compared against.

Bundle measured: 417 files / 8.8 MB, md5 `c4a2d9f92a046701fce0192113649722`. Zero `.compiled` files
were rewritten after launch (`find .compiled -newermt 06:20:18` = 0 at T+6 min), so the measured
artifact is the one that started. Two instruments now make that a guarantee rather than a check:
`hashCompiledTree` writes the digest into the payload (`config.bundle{start,end,changedDuringRun}`),
and `bundlePreflight` refuses to launch a run whose bundle is stale (3 cases covered, full suite 56/56).
This is the plan's "Risk: bundle drift during measurement" converted from detection into prevention —
the earlier run in this plan died exactly there, booting an app that recompiled itself 6 s in.

Environment (the §Phase 4b load caveat, now measured rather than asserted): the user's own app
instance (pid 16884 tree, up since 01:31:43) and the shared terminal daemon host (pid 10952 tree,
since 2026-09-20 11:33) are alive alongside the run — 12 processes, ~2.98 GB RSS, 11.4 k s CPU at
T+6 min, with 6.2 GB of 15.9 GB free and 27% CPU load. A 5-minute sampler records that series to
`perf4h-external-load.jsonl` so the verdict can state the competition instead of assuming it away.
This *does not* touch the memory gates: `processSamples` is `benchmarkIngest.samples` (harness line
1599), which the app fills from its own `recordProcessMetrics` (`src/main/index.ts:348`) over
`app.getAppMetrics()` — i.e. only this run's app tree (main pid 2596) can enter the per-process
series, so leg slopes and floors stay clean and only the latency numbers carry the load caveat,
exactly as §Phase 4b says.

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

#### Result — the legs ran, and the checkpoint survived the final-write crash (2026-09-21)

`legs4h2` is recorded in this plan as "stopped, legs 2–3 unrun", which is wrong in one direction that
matters: the run **did** execute all three legs (it was killed at 05:31, 2 h into the 4 h shape) and its
`.json` payload died in the `closeOpenLeg` `ReferenceError` — but the **checkpoint** it wrote 10 minutes
before the kill carries every leg, and the checkpoint is the file the analyzer reads. Same role, same
`privateBytesMB` column, one row per leg, `legBurstCounterSuspect: false`:

| leg | obs min | bursts | lines written | chrome renderer pv first → last | LSQ pv |
|---|---|---|---|---|---|
| `baseline#1` | 60 | 119 | 35,700 | 70.38 → 84.36 (+13.98) | **0.2417** |
| `burst4x#2` | 60 | 119 | **142,800** (4×) | 84.61 → 97.63 (+13.02) | **0.2410** |
| `burst-off#3` | 60 | 5 | **5** (≈0) | 97.77 → 120.30 (+22.53) | **0.1806** |

The role is `chrome:standalone+chrome:toolbar+chrome:frame-backdrop` in all three legs (pid 22376). What the
table decides, and what it does not:

- **The terminal write path is not the driver.** Four times the lines over the same hour moves the slope by
  0.0007 MB/min (0.3 %, i.e. nothing). This is the 4× separation Phase 4c was built for, and it is the fact
  the earlier 298–336 B/line reading could not establish on its own.
- **The growth is dominated by something that costs per minute, not per line.** With five lines written in
  an hour the slope is still **0.1806 MB/min** — 75 % of the loaded baseline's rate. Whatever accumulates
  keeps accumulating while the terminal is silent.
- **A residual volume/path term exists but is not per-line.** `burst-off` sits 25 % below `baseline`, while
  `burst4x` — 4× the volume — sits *level* with it. A linear per-line cost cannot do both, so the honest
  reading is a small regime effect (streaming active vs silent), not a per-byte one.
- **The floor is monotone across regimes** (70 → 84 → 97 MB, then +22.5 MB in the silent leg), so nothing
  here is a buffer filling to a cap. `burst-off`'s endpoint delta (+22.53 MB) exceeds its own LSQ (0.1806 ⇒
  +10.8 MB), which is the shape the analyzer's rolling-min floor exists to resolve: a step plus a plateau,
  not a straight line — and the step is the reason the *floor* series, not the raw slope, is the instrument.
- **Its absolute level is not comparable to the 09-20 runs.** `legs4h2` measured on a host that already had
  the user's own app instance up (started 01:31:43, alive for its whole window); `soak4h`, `preflight-fixed`
  and `legs4h` all measured on 09-20 with no such load. Load moves the level (~0.20 unloaded vs ~0.24 loaded
  on the same leg-1 regime) and does **not** move the leg pattern — which is why the legs, not the absolute
  floor, are the load-robust comparison, and why the `perf4h` run keeps its own external-load series.
- **No per-line CPU price is quotable for `burst-off`**: `msPer1000BurstLines` divides by 5 lines, so it
  reads 34,478,400 ms/1000 lines. The row is arithmetically correct and semantically meaningless; the leg's
  value is its ≈0 volume, not its cost column.

`perf4h` (this run) reruns the identical three-leg schedule with the instrument defects closed: observed
burst counts present (`burstLinesObserved`), per-leg refusals visible (`refused*`), the bundle digest carried
in `config.bundle`, and the same per-process private column as the gate — so it either reproduces this table
on a clean artifact or contradicts it, and either answer is decisive.

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

**Correction (2026-09-21, read off the bundle the running 4 h soak actually loads).** "The work that
ran on every broadcast" is only half removed, and the half that survives is on the path that fires at
5 Hz:

- `updateAffinityBadges(deliveredTabs, deliveredAffinities)` does use the delivered halves when a
  caller hands them in, and `api.onTabsUpdated` does (`standalone.js:4703`) — follow-up 1 is real
  there.
- But `renderTabs()` still ends with a **bare** `updateAffinityBadges()` (`:4648`), which takes the
  fallback branch and issues `api.getTabs()` **and** `api.getTerminalAffinities()`. `renderTabs()` is
  called from the session-broadcast handler (`api.onTerminalSession`, `:4652` → `:4695`), so those two
  `invoke`s still run on every 5 Hz session push — the same ~72,000-`getTerminalAffinities` figure the
  open item below records, now with its call path named.
- Line numbers verified identical in `.compiled/src/renderer/standalone.js` (4501 / 4648 / 4652),
  which is the copy the harness loads, so this is a property of the measured bundle and not of the
  source tree alone.

What this does **not** do is explain the retention: the quoted cost of those calls is "a correlation
entry, a promise and a deserialized payload **on the main thread**", and the growing process is a
renderer. It is broadcast-rate CPU and main-thread garbage, and it closes the open item's shape
(carry affinities in the broadcast payload) rather than the retention question.

**Rank correction and the fix design, from the same reading pass.** The advisory is right that the cost
is not confined to main: the `invoke` reply is deserialized **in the renderer**, so 144,000 round trips
carrying the whole tab list plus the whole affinity map are 144,000 deserializations in the process that
is actually growing. That makes this a live suspect for **committed growth by churn/fragmentation**, not
only broadcast-rate CPU — and it comes with a falsifiable prediction: if churn is the driver, the fix
should collapse the renderer's **private-bytes sd / range** (legs4h2: sd 15.60 MB, range 115.95 MB on the
standalone renderer) far more than its slope. Read those two columns before and after, not just the slope.

The cheap fix is now identified, and it is smaller than this plan's open item assumed:

- Main is **already** sending both halves on one channel: `flushBroadcastState()` builds
  `{ tabs: payload.tabs, terminalAffinities: this.buildTerminalAffinityMap() }` and sends it as
  `antifan:tabs:updated` (`src/main/browser/native-tab-host.ts:7866-7887`), and its own comment says the
  map "is a projection of the state this broadcast already carries" — so any affinity change rides a push
  the renderer already receives, and the renderer's `onTabsUpdated` handler already gets both halves
  (`standalone.js:4703`).
- Therefore a **renderer-side cache of the last delivered pair**, refreshed in that handler and passed by
  `renderTabs()` into `updateAffinityBadges(...)`, fixes the 5 Hz path **without touching main's payload
  contract** — the fallback fetch stays only for the never-delivered cold case. Sleep/wake state, which
  `renderTabs()` also repaints after a session push, comes from renderer-local session state and needs no
  affinity refetch, so a cached pair cannot make a badge stale.
- The four other bare calls are **audited and need no work**: `standalone.js:2857`, `:2870`, `:2933` and
  `:2990` are all `onclick` handlers inside the affinity popover (after `removeTabAffinity` /
  `rebindTerminalAffinity` / `adoptTabAffinity`), so each fires once per user click. Only the
  `renderTabs()` tail sits on the 5 Hz path.
- A renderer-side cache is sound **only where every affinity change is accompanied by a push**, and the
  audit says that holds for some mutators and is unproven for others. `bindTerminalAgentAffinity` calls
  `broadcastState()` at `:6321` and `detachTabFromAffinityEntry` at `:6783`; but
  `dropTerminalAffinityEntries` (`:6870`), `clearTerminalAgentAffinity` (`:6886`),
  `clearTerminalAffinityTombstone` (`:6908`) and `reviveTerminalAgentAffinity` (`:6941`) contain no call
  of their own — they may rely on a caller broadcasting, which is precisely the assumption to verify
  before the cache lands. `broadcastState()` (`:7811`) is still the single coalescer that flushes
  `{ tabs: getTabList(), terminalAffinities: buildTerminalAffinityMap() }` and throttles repeat flushes to
  `BROADCAST_MIN_INTERVAL_MS`; the open question is only who calls it. The fix has a fallback that makes
  the question non-blocking: let the fetch path **write what it fetched into the cache**, so the four click
  handlers stay self-correcting, and a badge can then lag only for a change made off those paths.
- **Race to guard in the implementation**: `updateAffinityBadges` is `async` and `renderTabs()` calls it
  fire-and-forget. On the cold path the awaited fetch can land *after* a fresher `tabs:updated` has filled
  the cache, and the late result would install stale halves. Either resolve the cached pair synchronously
  before the `await`, or let the fallback write the cache only when it is still empty.

## Open after this pass — closed, retracted, or waiting on the next live run

The six instrument defects and the history-store defect were fixed after the first measured
run stopped (see the changelog for that batch). The 2026-09-21 `perf4h` soak was **aborted**
by the operator at 08:40 local after 109.1 min workload (verdict:
`plans/reports/runtime-verification/real-soak-4h-verdict-perf4h.md`). What that abort
changed about the two items recorded here:

1. **`api.getTerminalAffinities()` per 5 Hz broadcast — APPLIED in the working tree.**
   `native-tab-host.ts` already puts `terminalAffinities: this.buildTerminalAffinityMap()`
   on the broadcast payload; `standalone-preload.ts` parses it; `standalone.js`
   `updateAffinityBadges(deliveredTabs, deliveredAffinities)` resolves the delivered map
   and only calls `api.getTerminalAffinities()` when the payload omits it. The ~72,000
   invokes/4 h are gone on the broadcast path. Not on the measured `perf4h` bundle
   (uncommitted `src/` at abort time).
2. **`switchTab` sub-step timer — APPLIED in the app and the harness.** `markSwitchStep`
   records `ensureView` / `attachSweep` / `layoutBroadcast` / `throttle` /
   `invalidateFocus` / `presentedView` into a `tabs`/`switch-steps` row when
   `ANTIFAN_BENCHMARK=1`. The ingest no longer drops every non-`history`/non-`process`
   line: `switchStepSamples` is a first-class payload array (`[]` if missing, never
   omitted); the analyzer prints p50/p95/max/mean and share of mean, or `not collected`.
   The aborted run predates this, so the +5.6 ms p50 step is still unnamed. The next live
   soak is the measurement.

**Retracted:** `2697a28c` as the +5.6 ms mechanism. `git show` is 13 lines that only
change behaviour while an attach-for-capture count is held. A soak switch does not hold
a capture. "Make recycle conditional on a stale presentation" is not the next patch.

**Dropped:** seeding a pid manifest from sample 1 because `refusedProcessCount` went 0→1.
On `perf4h` that was **one** sample (`python.exe`, 18.58 MB) out of 141. Not a foreign
Electron tree.


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

### Status of each finding above (what carries it now, so it is not re-litigated)

| finding | state | carried by |
|---|---|---|
| latency gate not phase-scoped | **applied** | `metrics.switchLatencyMs` is the workload series (`scripts/benchmark-real-soak-8h.cjs:1131`) and the gate reads that series (`:188-194`, `:227`); `switchLatencyAllPhasesMs` (`:1137`) keeps the all-phase reading beside it for a reader, and `max` is reported rather than graded |
| slow tail is not destination-specific | **analysis** | `plans/reports/runtime-verification/switch-tail-spike-analysis-20260920.md`; `metrics.switchLatencyByTab` prints the per-tab table |
| the scrape-collision explanation is refuted | **applied** | the comment above `switchSamples` states what the data shows instead of a mechanism it contradicts |
| `calculatePerProcessSlopes` dropped its window | **applied** | `stats.processSlopeWindowStart/End` (`:1171-1172`); a window that cannot be derived yields an empty series rather than a whole-run fit wearing a workload label; pinned by `test/unit/soak-payload-contract.test.mjs` |
| non-WebContents rows report an empty `role` | **applied** | role falls back to `type` in the series mapping (`:546`, `:618-624`, `:640`) and in the CPU attribution (`:817`, `:829`); pinned by the "role is never empty" cases (`soak-payload-contract.test.mjs:355-396`) and `soak-analyzer-cpu.test.mjs:213` |
| `activeWorkloadMinutes` measured the wrong span | **applied** | `stats.activeWorkloadMinutes` is now the workload samples' own sleep-adjusted span (`:792`), the old reading keeps the name that says what it measures (`stats.activeMinutesSinceStart`), and the source field was renamed to match (`:1363`, `:1668`); pinned by the payload-contract cases and readable mid-run on `real-soak-8h-legs4h-checkpoint.json` (`activeWorkloadMinutes: 29.03` beside `activeMinutesSinceStart: 60.01`) |

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
| 1 | `updateAffinityBadges()` re-fetches both lists per broadcast | `standalone.js:4685` → `:2710-2775` | **applied (follow-up 1) — in the bundle the 09-21 run measures** |
| 2 | `renderTabs()` re-runs on title churn | `toolbar.ts:2413` (signature includes `t.title`), `:2435-2680` | **applied (follow-up 2) — in the bundle the 09-21 run measures** |
| 3 | `renderThemeQa()` per push | `toolbar.ts:4178`, `:236-267` | **already rejected below** |
| 4 | `updateControls()` per push | `toolbar.ts:4198`, `:2690-2750` | **already rejected below** |

Both leads named here were fixed in the follow-up batch, so this table is a record of what was
suspected, not a list of open work: `updateAffinityBadges(deliveredTabs, deliveredAffinities)` now
takes the broadcast's own two halves and only falls back to `api.getTabs()`/`api.getTerminalAffinities()`
when a caller hands in neither, and the tab-strip render reads the children list instead of parsing
48 selectors. What that fix removed was **main-thread** work — the load quoted at `:2711` is "a
correlation entry, a promise and a deserialized payload on the main thread" — and this finding is
about a *renderer* process, so it explains CPU contention during switches, not the committed growth.
Neither lead is therefore the retention owner, and the owner is still unnamed (see the open item
below). The `data-managed-sig` guard the author already had on the adjacent popover is what made
consumer 1 a lead rather than a guess; it is still the shape to copy when the owner is found.

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

## Operational notes — 2026-09-21, taken while the 4 h run was in flight

Recorded because each one would otherwise cost time after the run ends.

- **The stale-final hazard is not this harness failing to write finals.** `real-soak-8h-legs4h.json`
  and `real-soak-8h-legs4h2.json` **do not exist**; the runs whose tables this plan quotes left only
  their checkpoints (`real-soak-8h-legs4h-checkpoint.json` 419 KB / 08:07, `real-soak-8h-legs4h2-checkpoint.json`
  1.6 MB / 05:31). Both were superseded or stopped rather than completed, so the finals were never due —
  `diag1`, `soak4h` and `preflight-fixed` all wrote finals normally. The consequence for the verdict is
  the important part: **the checkpoint is an equal-grade source**, and `scripts/analyze-soak-app-only.cjs`
  was dry-run against *both* a checkpoint and a final (legs4h2 checkpoint, soak4h final) and prints the
  same windowed tables for each.
- **`legs4h2` is the load-matched comparator, and its shape is known now**: a Tab-role renderer
  (`chrome:standalone+chrome:toolbar+chrome:frame-backdrop`, `file:///…/standalone.html`) grows at
  **0.28 MB/min private** through the workload window (sd 15.60) and **0.00 MB/min in recovery** — it
  releases nothing when activity stops, which is what makes this retention rather than transient
  allocation. Every real page tab sits at 0.00. `worstProcessSlopeMBPerMin` 0.2657 is that same pid.
- **That comparator ran with `appArgs: ["--remote-debugging-port=0"]`; this run has `appArgs: []`.** The
  post-fix re-measure that the probes attach to must pass `SOAK_APP_ARGS` to match, or the comparison
  trades one variable for another.
- **The watcher's liveness probe is unreliable and did fire a false negative — cause not established.**
  The probe is `(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine
  -match 'benchmark-real-soak-8h' }).Count` (`perf4h-watch.cjs:79`, in `%LOCALAPPDATA%/Temp/`), and the
  live harness command line (`"…\node.exe" scripts/benchmark-real-soak-8h.cjs --minutes 240`) **does**
  contain that pattern — verified by running the same query from this session before writing this. It
  nevertheless returned 0 three times from 06:28 to 06:38 while harness PID 21752 was demonstrably alive:
  the checkpoint it wrote at 06:30:29 and the external-load samples at 06:38 are both later than the first
  "not visible". Two candidates remain and neither is tested — the pipeline string being mangled across
  the shell hop, or a CIM visibility limit in the spawned context — so this records the **symptom and the
  workaround**, not a cause. Liveness is instead established by the 10-minute checkpoint cadence plus
  `scripts/sample-external-load.cjs --harness-pid <pid>`, launched for 250 minutes and exiting when the
  harness does. Do not restore the PowerShell probe; check a pid directly.
- **Script locations for cleanup**: `perf4h-watch.cjs` lives in the OS temp directory
  (`%LOCALAPPDATA%/Temp/perf4h-watch.cjs`), not in `scripts/` as the Files table above says, and the
  external-load sampler writes `plans/reports/runtime-verification/perf4h-external-load.jsonl`. The
  files the verdict needs are the harness's own `real-soak-8h-perf4h.json` / `-checkpoint.json`,
  `perf4h-run.log` and `perf4h-pid-manifest-20260921.json`.
- **Per-leg memory slopes are not in the artifact.** `legSlopes[n]` carries the leg's schedule, its volumes
  (`bursts`, `burstLinesObserved`, `switchCount`) and its `cpu` block
  (`cpuSecondsPerMinute`, `msPerSwitch`, `msPer1000BurstLines`, `perProcess`), but **no memory slope** —
  that has to be sliced out of `samples` / `processSeries` by each leg's `startAt`/`endAt`. Compare PV sd on
  **equal-length 60-minute windows**: an 8-frame window's sd is not comparable to a 179-frame one, and sd is
  the column the churn prediction lives in.
- **Live reading at 07:00, nine minutes into leg 1 — the mechanism's identity is already reproducing.** The
  top private-bytes grower is the standalone renderer `19124`
  (`chrome:standalone+chrome:toolbar+chrome:frame-backdrop`, `file:///…/standalone.html`) at **+0.37 MB/min**
  across the workload window, and `worstProcessPid` is that same pid (0.2318 MB/min). Every real page tab
  sits at or below 0.14 MB/min. Switch latency **fails the live gate** (p50 15.7 ms, p95 20.5 against `p50 ≤ 12 &&
  p95 ≤ 18`; the max-35 bound this line first cited was deleted by the Phase 3c decision, and the comparator
  passes the same gate at 10.7 / 13.1), and the throughput columns the legs4h restart was missing are present
  (`msPerSwitch` 314.19, `msPer1000BurstLines` 10748.60).
- **The verdict must state the spread, not only this run's slope.** `soak4h.json` — same bundle family —
  reported `rendererActiveSlopeMBPerMin` **0.039** where `legs4h2` reported **0.261**: a ~7× run-to-run
  spread, so a single perf4h slope settles nothing. The verdict therefore leads with (a) whether the
  mechanism's identity reproduces, (b) the load-matched 60-minute window floors against legs4h2's legs, and
  (c) the spread named next to whatever single number this run produces, so it cannot be over-read.
- **The peak-memory gate is breached, but marginally — and the metric is phase-scoped, so the two peaks
  must be read separately.** At 07:03, nine minutes into leg 1, the checkpoint's
  `metrics.activeWorkingSetMB.max` reads **1601.01 MB** against the gate's **≤ 1600 MB**, with
  `appPrivateMax` 0.3726 MB/min on the standalone renderer. The chain is in the harness end to end:
  `const totals = activeSamples.map((s) => s.totalWorkingSetMB)` (`:984`) → `activeWorkingSetMB:
  quantiles(totals)` (`:1357`) → the gate check itself, `const maxActive = metrics.activeWorkingSetMB?.max`
  (`:265`), printed as `Peak Max … SLO <= …` (`:2223`) against `FREEZE_SLO.peakTotalWorkingSetMB`. The scope
  is verified and not assumed: `activeSamples = samples.filter((s) => s.label === 'workload')`
  (`scripts/benchmark-real-soak-8h.cjs:972`) feeds `activeWorkingSetMB`, `overallActiveSlopeMBPerMin` and
  `rendererActiveSlopeMBPerMin` alike, and the label is set per phase — so the 1601.01 sample is inside the
  workload window (it is the second workload sample: `1589.32 → **1601.01** → 1579.82` MB, latest 1575.39).
  The tree's global maximum in the same artifact, **1608.43 MB at 06:40:32**, sits in warmup and is therefore
  *outside* the gated metric rather than inside it. The breach is **1.01 MB on an active-window transition
  peak** — present, but not an overrun and not a warmup artifact.
  What it does confirm is this plan's premise at the workload it was written for: 1549.7 MB had "no headroom
  left", and the same workload now touches 1601. For completeness, the private release at the workload
  boundary is *small* — the Browser drops `168.95 → 154.30 MB`, i.e. **14.65 MB**, not the hundreds of MB a
  warmup teardown would imply — so the transition peak is not explained by warmup memory being reclaimed.
- **What the verdict cites from `metrics`, by name** — all of it on one artifact, no cross-run lookups:
  `activeWorkingSetMB.max` (the gated peak), `rendererActiveSlopeMBPerMin` / `overallActiveSlopeMBPerMin`
  (phase-scoped slopes), `rolling60MinSlopes` (the floor), the four point readings `initialLoadedMB` /
  `postWarmupMB` / `finalActiveMB` / `recoveredMB` (raw endpoint deltas, computed without a regression),
  `perProcessSlopes[0]` with `worstProcessPid` / `worstProcessRole` (attribution), `switchLatencyMs` beside
  `switchLatencyAllPhasesMs` (the phase-scoped gate next to the pre-scoping reading the harness deliberately
  kept for this comparison), `cpu.msPerSwitch` / `cpu.msPer1000BurstLines` (throughput), and `config.bundle`
  with `bundle.changedDuringRun`.
- **The external-process attribution held, and its one gap is visible.** `refusedProcessCount` is 0 in the
  early samples and 1 later — the harness's pid manifest learned about the user's own app tree partway
  through, so the first samples excluded it by ignorance rather than by rule. The next run should list the
  other app trees from the first sample.
- **Leg 1 closed at 07:50:29 and it points at the "contradicts" branch — with one caveat that decides how
  much weight it carries.** Same schedule, and the *injected load* is identical to legs4h2's leg 1 to the
  unit: `bursts 119 / 35700 bursts lines / 1169 switches` in both. The measured result differs sharply:

  | Leg 1 (60 min, identical schedule) | this run (`perf4h`) | `legs4h2` leg 1 |
  |---|---|---|
  | `rendererActiveSlopeMBPerMin` — the graded series | **0.079728** | **0.261952** |
  | `overallActiveSlopeMBPerMin` | **0.117506** | **0.646958** |
  | — the same two series at run level (a blend, **not** a leg) | 0.099247 / 0.130035 | 0.26137 / 0.409933 |
  | `switchLatencyMs` p50 / p95 / max | 15.56 / 20.53 / **30.94** | 10.737 / 13.069 / **94.691** |
  | `activeWorkingSetMB` p50 / max | 1582.79 / **1607.08** (gate 1600) | 1534.82 / 1584.20 |
  | `postWarmupMB` → `finalActiveMB` | 1571.77 → 1579.93 | 1503.57 → 1560.39 |
  | CPU s/min, `msPerSwitch` | **7.039**, 355.61 | 2.488, 125.64 |

  The two leg-1 slope pairs are refitted from `samples[]` over each run's **own** leg-1 window
  (`legSlopes[0].observedFrom .. observedTo`, 60 frames on each side) with the harness's least-squares fit. The
  method is certified by reproducing every stored slope in both checkpoints exactly — perf4h leg 1
  (`0.079728` / `0.117506`), perf4h run level (`0.099247` / `0.130035`), legs4h2 run level (`0.26137` /
  `0.409933`) — so it is the harness's own method rather than a lookalike. The leg-1 row is the right comparator:
  a run-level slope on a leg run is fitted across regimes the harness itself refuses to grade
  (`slopeGateApplicable: false`, "a blend of regimes … grades nothing"), so `0.409933` understates the leg-1 gap by
  about a third and `0.26137` would understate the renderer gap by the same class of error. The bound on the
  latency row is the live one (**p50 ≤ 12 / p95 ≤ 18**, workload phase); the retired `max ≤ 35` is not graded at
  all (`latencyMaxGated: false`).

  Two readings follow, and they are different in kind:
  - **The graded series improves 3.3× and the tail 3×, but this run fails the same latency gate legs4h2 failed.**
    `rendererActiveSlopeMBPerMin` falls from legs4h2's leg-1 `0.261952` to `0.079728` (`overall` from
    `0.646958` to `0.117506`) — but a leg run does not grade slopes at all (`slopeGateApplicable: false`), so
    that is a measurement, not a passed gate. The live `switchLatencyMs` bound is **p50 ≤ 12 / p95 ≤ 18** and this
    run reads **15.56 / 20.53**: it fails the same criterion legs4h2 failed, on a 3× smaller tail (max `30.94`
    vs `94.691`) and with its floor 4.5 ms higher. The retention owner is still named and still the same role
    (`chrome:standalone+chrome:toolbar+chrome:frame-backdrop`, pid `19124`) at **0.1236** MB/min now (`0.1247`
    at leg-1 close) against legs4h2's `0.2657`, so the mechanism's identity reproduces and its magnitude halves.
  - **The peak gate is now the failing one, and by 7.08 MB rather than 1.01** (`activeWorkingSetMB.max`
    moved 1601.01 → 1607.08 as leg 1 ran), while `postWarmupMB` starts **68 MB higher** than legs4h2
    (1571.77 vs 1503.57) and `finalActiveMB` only rises 8.16 MB across the leg. So the ceiling is being
    touched by the *startup/warmup footprint*, not by growth during the leg — the fix's justification is a
    startup cost story here, not a steady-state growth story.
  - **The cost columns are not comparable across the two runs.** Identical injected work cost 2.83× the CPU
    per switch and 3.83× the `msPer1000BurstLines` (10748.60 vs 2806.64) — a near-uniform slowdown factor,
    which points at machine-level contention rather than at the workload. Use the leg table for
    **within-run** ratios (which is what §Phase 4c designed it for) and never compare absolute CPU across
    these two runs.
  - **The 62 MB warmup elevation is Chromium-wide and proportional, so it is not an app-object leak — and that
    redirects the optimizer away from app code.** Mean warmup footprint over 31 frames per run: renderer
    `+34.6 MB` (5 procs, **+4.6%**), gpu `+14.9` (**+8.7%**), browser `+11.9` (**+5.5%**), utility `+0.3`,
    other `+0.2` — i.e. **61.9 MB of the elevation sits entirely in the Chromium-owned roles and every one of them
    moves by roughly the same 4–9%**, while the seven non-Chromium processes move by under 0.2 MB combined. A leak
    in app code would concentrate in the renderer and leave gpu and browser flat; a uniform proportional lift across
    all three is a whole-tree scale factor (build/commit-accounting or host state), not allocation. So the peak
    breach of **+7.08 MB** is a small margin riding on a ~62 MB shift that this run's bundle *cannot* explain —
    which is the strongest argument in this plan for settling it with a **same-bundle control run** before touching
    app code.
- **The comparator's bundle is not recorded anywhere, and its tree moved around it.** `grep` for
  its md5 across `plans/` finds only this plan's own `perf4h` digest and my pid manifest; legs4h2's
  checkpoint carries `config.bundle: null` and no final payload survives. Meanwhile
  `.compiled/src/main/index.js` was rewritten at **04:21:45** (verified by `stat` this session), inside legs4h2's
  01:41 → 05:31 span. That write **cannot** have reached the running process — a live process holds its own loaded
  modules, so a file rewritten under it is invisible to it, and the boundary a file mtime draws is the compile, not
  the run — so it is *not* evidence that run measured a drifting tree, and the earlier "same drift class" reading of
  it is withdrawn. What makes the comparison cross-bundle is independent of it and is recorded: `git status` shows
  **13 tracked files modified** plus 20 untracked artifacts, and `src/` alone took **14** edits between **01:09:53
  and 01:37:15** — before legs4h2 launched at 01:41 but after the 01:04 compile — while `.compiled` was written
  again at **01:37**, **04:21** and **06:16** (incremental emits, not one compile). The tree legs4h2 loaded is
  therefore **not reconstructible** from mtimes, which is exactly why its missing digest matters; this run's bundle
  comes from the 06:16 full recompile. So every cross-run column above is cross-bundle as well as cross-load, and
  the verdict must say so rather than treating legs4h2 as a clean comparator. This run's own bundle is the verified one: the T+6 minute check found zero rewritten
  `.compiled` files, and `config.bundle{start,end,changedDuringRun}` will confirm it at the end.
- **The 2.8× CPU gap is real, is not uniform, and is unattributed — so the verdict must not call it a
  regression.** The component split of the two leg-1 `cpu.perProcess` blocks rules out a single machine-level
  factor:

  | leg-1 component | perf4h | legs4h2 | ratio |
  |---|---|---|---|
  | GPU | 124.16 s (30%) | 28.16 s | 4.41× |
  | standalone renderer (`chrome:standalone+…`) | 99.31 s | 16.39 s | 6.06× |
  | page-tab renderer (`tab:…`) | 46.50 s | 7.70 s | 6.04× |
  | Browser | 59.31 s | 32.19 s | 1.84× |
  | console host / pty children `[INFERENCE]` | 58.19 s | 52.39 s | ~1.11× |
  | **total** | **415.71 s (7.039 s/min)** | **146.88 s (2.488 s/min)** | 2.83× |

  The driver side — the pty children, which are the workload being injected — costs the *same* in both runs,
  so the work per unit did not change; every **Chromium** process is 4.4–6× more expensive while the Browser
  is 1.84×. A machine-wide contention story would not leave the pty children at ~1.0 and would not spare the
  Browser at 1.84 while renderers sit at 6×. (The legs4h2 rows are role-less `?` entries whose count and
  magnitude match the console hosts, hence the `[INFERENCE]`.) A Windows `CurrentClockSpeed` read is not a
  usable throttle check: it returned `2400` against a `2400` base, i.e. the configured speed rather than the
  live clock, with an instantaneous `LoadPercentage` of 15% and 6.2 GB free.
  What the artifacts *cannot* settle is whether legs4h2 ran the same app code — its bundle digest was never
  recorded (see above) and `.compiled` moved inside its window. The *known* background, by contrast, is
  comparable and does not separate the runs: the user's own app tree has been up since 01:31:43 — ten minutes
  before legs4h2 launched at 01:41 — and the shared terminal daemon since 2026-09-20 11:33, so both runs had
  both. Each window also carried heavy session work of its own (the earlier session emitted one compiled file at
  04:21, inside legs4h2 — a write a live process cannot observe, so it is contention at most, not bundle drift;
  this session ran its proxy sweeps and samplers during perf4h). Machine contention
  therefore fits the *magnitude* poorly: it would have to spare the pty children at ~1.0× and the Browser at
  1.84× while inflating every rendering process 4.4–6×. The machine's own largest background consumer is also
  measurably idle: the user's app tree (pid 16884, up since 01:31:43) had accrued **264 CPU-seconds in 6.5
  hours — 0.68 s/min**, and the shared terminal daemon (pid 10952, since 2026-09-20 11:33) **2056 s over
  20.5 h — 1.67 s/min**. Neither can supply a 2.83× factor on a workload the app itself drove at 7.04 s/min.
  A sampler running outside the harness (`perf4h-external-load.jsonl`, one tick a minute from 06:26:57, before
  leg 1 opened at 06:50:29) now measures the host side of this leg directly instead of by inference: 12 external
  processes holding **~2.9 GB** RSS, **~6.0 GB** machine-free, `loadPct` between 9 and 52 with no sustained
  saturation, and an external CPU draw of **32–42 cpu-s/min** against the app's 7.04–7.31 s/min — under a sixth of
  the sampled demand, on a machine at roughly a third of capacity. That cuts both ways and the verdict must keep
  both cuts: contention cannot be *dismissed* (the host was carrying about 5× the soak's own CPU in other work),
  and it cannot be *measured on the comparator's side* either, because no sampler existed on 09-20 01:41 — the
  external load during legs4h2's leg 1 is simply unrecorded, so the 2.83× stays unattributed rather than being
  assigned to the host. That working tree is also a *verified* same-bundle control rather than an assumed one: no
  file under `src/` is newer than the last compile (06:16:57), and the single file carrying exactly that timestamp
  — `src/renderer/terminal-write-dispatcher.js` — is the tracked emit mirror of
  `src/shared/terminal-write-dispatcher.ts`, sharing its `.compiled` twin's timestamp to the millisecond. The
  harness itself has not changed since 06:19:48, and that is the one this run used. What the sampler does settle,
  independently of the harness, is that this run's tree did not
  move under it: `compiledRewritten` — `.compiled` files newer than the run launch — reads **0 on every tick**, and
  its own CPU series puts leg 2 (7.31 s/min at 4× the injected lines) level with leg 1 (7.039 s/min), which is the
  fixed-per-switch shape arriving from a second instrument.
  So this stays an **unattributed 2.8×
  per-switch cost** with the component table as its evidence. The control that would settle it is a
  **same-bundle** short leg-1 re-run, which is one more reason the retention-probe run must happen **before**
  the **retention fix (Phase 3 item 2)** lands — and it is specifically that fix, not "any fix": the
  latency-gate change and the broadcast-path guards shipped on 2026-09-20 and are already in **both** bundles,
  which the artifacts show rather than assume — legs4h2's `perProcess` carries the same
  `chrome:standalone+chrome:toolbar+chrome:frame-backdrop` role string this run's does, and that combined
  labelling is the role-resolution change from that same batch. A run taken after the retention fix measures a
  different tree and cannot answer this question at all. That control no longer needs a separate run: it is the
  working-tree leg of the A/B ladder below, and the ordering this bullet demanded is already satisfied by the clock
  — `perf4h` launched at **06:20:29**, after the 06:10 `toolbar.ts` retention fix and its 06:16:57 compile, so that
  leg and this run are both post-fix bundles. The 200-minute retention-probe leg the earlier sequencing reserved for
  this question is superseded by that leg plus the retention analysis already taken from this run's checkpoint.
- **`recoveredMB` is a cleaner retention signal than any slope, and it has a comparator target.**
  legs4h2 went from `finalActiveMB` 1560.39 to `recoveredMB` 1062.36 — **32% of the active footprint came
  back**. The verdict reads this run's pair the same way: a comparable release exonerates steady-state
  retention, a release of ~0 means the workload's memory was retained outright. Endpoint deltas are not
  regression-fitted and do not depend on the window length that makes 60-minute slopes noisy.
- **`recoveredMB` now has a numerical expectation, not just a comparator.** The release ratio across every
  completed run that records both numbers:

  | run | peak (MB) | recovered (MB) | released |
  |---|---|---|---|
  | `real-soak-8h-soak4h` (09-20 04:52) | 2126.06 | 1422.84 | 33.1% |
  | `real-soak-8h-preflight-fixed` (09-20 06:28) | 1551.93 | 1007.64 | 35.1% |
  | `real-soak-8h-diag1` (09-20 12:45) | 1556.34 | 981.61 | 36.9% |
  | `real-soak-2h` (09-19 10:24) | 1549.71 | 1026.71 | 33.7% |
  | `real-soak-8h-legs4h2` (09-21 05:31) | 1560.39 | 1062.36 | 31.9% |

  Five independent runs — four of them on the same 1550-1560 peak plateau — release **32-37%** of the peak. A
  band that tight across different harness revisions and bundles says the release is a property of this
  workload's teardown, not of any one build, so the verdict can *predict* instead of merely compare: from a
  ~1607-1610 peak, `recoveredMB` should land near **1010-1090 MB**. Land there and the steady-state retention
  hypothesis is bounded from the other side as well — the memory does come back; land near the peak (~1600)
  and the workload's memory is retained outright, which is the signature this plan is hunting. One historical
  outlier is named so it is not read as support either way: `real-soak-8h.json` (09-19) released only 0.7%,
  but from a *lower* peak (1204.88) — a different regime, not a counterexample.
  Two facts fall out of the same sweep. **No historical run carries CPU metrics at all** — the `cpu` block is
  this plan's own instrumentation — which is why legs4h2 is the only CPU comparator that exists and why a
  same-bundle control run is the only way to close that question. And a probe run was already attempted once:
  `real-soak-8h-domprobe-aborted-duration-mismatch-20260921-0610.json` (09-21 06:06) is `in-progress`, carries
  `appArgs: ["--remote-debugging-port=0"]`, and its filename records why it died — a duration mismatch, before
  this run's first launch. The recipe in §Instrument first is therefore not untried.
- **The peak breach is a regression against the comparator too, not only against the gate.** On the same
  injected workload, legs4h2 peaked at `activeWorkingSetMB.max` **1584.20 MB** (inside the ceiling) while this
  run already reads **1607.08 MB** during leg 1. The verdict states both comparisons separately from the
  slope result, which went the other way.
- **Context for the peak gate: 1607 is mild by history, and footprint level is independent of slope.** The run
  that breached the ceiling hardest is `real-soak-8h-soak4h` (09-19 17:52Z → 21:52Z = 09-20 00:52 → 04:52
  local, tag `soak4h`, `status: failed`, 242 samples, 240 workload minutes, teardown clean with 6/6 tabs
  closed). Its `activeWorkingSetMB` reads **min 2019.92 / p50 2069.17 / p95 2099.23 / max 2126.06** — a *floor*
  above this plan's 1600 ceiling, held for the whole run rather than overshooting during load. Its workload
  configuration matches this run's (240 total, 30/180/30, 3000 ms switches, 300 lines / 30 s bursts, 200 ms
  fixture, 6 tabs), so the 2000+ MB level did not come from the schedule; the artifact records no cause, so it
  is left as an open question rather than guessed at. (That run is also the source of the latency decision in
  §Phase 3c — its `switchLatencyMs` p50 10.346 / p95 15.513 / max 50.976 is quoted there verbatim.)
  Two consequences for how the verdict states the peak. First, **a breach of this ceiling is not novel**: runs
  plateau at 1549-1560 (`real-soak-2h`, `preflight-fixed`, `diag1`, legs4h2) and one sat at 2019-2126, so this
  run's 1607.08 is one point on a wide historical spread and must not be written up as unprecedented. Second,
  and more useful: **footprint level and slope are independent quantities**. `soak4h` held its 2126 MB while
  showing the *flattest* renderer slope on record — 0.0389 MB/min against this run's 0.0797 and legs4h2's
  0.2614 — and it still released 33.1% of its peak, inside the release band above. A large steady footprint is
  therefore not evidence of retention, which is why the peak row and the slope row are read separately: this
  run's peak breach is a *level* finding (startup footprint — 1571.77 post-warmup against legs4h2's 1503.57),
  not a *growth* finding.
- **The leg-2 shape test is already answered for CPU, and it answers in the direction that protects the app.**
  Recomputing both payloads with `scripts/recompute-soak-metrics.cjs` (sidecar only — the payloads stay
  byte-identical, and its round-trip check reproduces this run's stored `cpu` block exactly: 486.252 s over
  69.07 min = 7.04 s/min) gives the first same-denominator per-leg comparison:

  | run / leg | window | cpu s/min | bursts / lines | switches |
  |---|---|---|---|---|
  | perf4h leg 1 baseline | 59.06 min | **7.039** | 119 / 35,700 | 1169 |
  | perf4h leg 2 burst4x | 9.01 min (in flight) | **7.098** | 19 / 22,800 | 195 |
  | legs4h2 leg 1 baseline | 59.04 min | 2.488 | 119 / 35,700 | 1169 |
  | legs4h2 leg 2 burst4x | 59.05 min | 2.985 | 119 / 142,800 | 1169 |
  | legs4h2 leg 3 burst-off | 59.05 min | 2.919 | 5 / 5 | 1170 |

  A 4× volume increase moves this run's CPU by **+0.8%** and legs4h2's by +20%: both flat, in the same
  direction. The current bundle is therefore **not** volume-sensitive where legs4h2 was not, so the
  broadcast-path work is not what makes this run cost 2.83× more — that closes the "did the app become
  workload-dependent" half of the question and leaves only the *level* (baseline work, or the machine), which
  is exactly where the same-bundle control run points. Note the denominators: legs4h2's `legSlopes` entries
  carry **no `metrics` block** — but they do carry `topSlopes`, the per-leg measurement the harness intends for a
  legs run, in **both** payloads, so leg-to-leg *memory* comparison is available on the same denominator as the
  CPU table above. The recompute's own contribution is CPU only; its `memoryAgrees` round-trip check is what
  certifies the memory blocks it does not touch.
- **What the live checkpoint already settles about the gates — and it is not what the plan's gate table says.**
  Read from the running payload (`real-soak-8h-perf4h-checkpoint.json`) against the harness's own verdict
  function, which grades a leg run differently by design:

  | criterion (`evaluateFreezeVerdict`) | this run | legs4h2 | note |
  |---|---|---|---|
  | `slopeGateApplicable` | **false** | false | `LEGS.length > 1` ⇒ memory slopes report **null**, not a number |
  | `slopeSloSatisfied` | **null** | null | "one slope fitted across legs that ran different burst volumes … grades nothing" |
  | `memorySloSatisfied` (peak ≤ 1600) | **false** | true | 1607.08 vs 1584.20 — the graded memory failure |
  | `latencyOk` (p50 ≤ 12, p95 ≤ 18, workload phase) | **false** | true | **15.693 / 20.53** vs 10.737 / 13.069 |
  | `appPrivateMaxSlopeMBPerMin` | 0.1828 | 0.2771 | stricter app-owned metric; reported, **not** graded on a leg run |
  | `verdict` | `FAILED` | `FAILED` | a leg run that passes everything else reports `PASSED_SLOPE_NOT_GRADED` |

  Two corrections follow. First, the plan's gate row "switch latency max ≤ 35 ms → 42.1" is the **pre-decision**
  reading: since the 2026-09-20 user decision the graded statistic is the p50/p95 pair with `switchMaxMs`
  reported beside it, so this run fails latency **at p50**, not at one stall. Second — and this decides how that
  failure may be *named* — `switchLatencyMs` is a full round trip: `const t0 = performance.now(); const sw = await
  rpc('antifan.switchTab', { tabId }); latency = performance.now() - t0;`. It spans the client transport and the
  harness's own event loop as well as the app, and this run's harness carries instrumentation legs4h2's did not
  (`switchSamples` retains all 2143 rows in the payload, CPU is enumerated per pid every sample, per-leg blocks
  are built). A uniform shift is therefore **not attributable to the app's switch path from this artifact
  alone** — a second thing only the same-bundle control run can separate.

  The shift is uniform, and the uniformity is the finding:

  | window | n | min | p50 | p95 | max |
  |---|---|---|---|---|---|
  | warmup, 30 min, low load | 585 | 12.488 | **15.748** | 20.987 | 34.847 |
  | workload leg 1 baseline | 1169 | 12.065 | **15.560** | 20.381 | 30.94 |
  | workload leg 2 burst4x (partial) | 389 | 12.694 | **16.341** | 20.886 | 25.477 |

  The p50 sits at 15.6-16.3 in **every** window, including warmup at low load, and even `min` only reaches
  12.1-12.7 — so this is not burst contention, not leg 2, and not a workload effect: it is ~+5 ms on essentially
  every switch. Meanwhile every app-owned metric moved the other way against legs4h2 — per-leg `topSlopes[0]`
  0.1779 MB/min against 0.2417 / 0.2410 / 0.1806, `appPrivateMaxSlopeMBPerMin` 0.1828 against 0.2771, latency
  **max** 30.94 against 94.691 — and the renderer tabs read ~0.02 MB/min or negative in every leg of both runs.
  The app improved; the level costs did not.

  Per-destination rows separate the two effects, and the `min` column is the cleanest signal in the pair:

  | destination (357-358 switches each) | legs4h2 min / p50 | perf4h min / p50 |
  |---|---|---|
  | https://www.wikipedia.org | 8.24 / 10.94 | 12.44 / 16.96 |
  | https://example.com | 8.21 / 10.38 | 12.06 / 15.13 |
  | fixture /store-home | 8.21 / 10.80 | 12.16 / 15.41 |
  | fixture /product-test-1, /product-test-2, /collection-featured | 8.08-8.29 / 10.72-10.76 | 12.63-12.74 / 15.58-15.77 |

  Every destination moved by the same amount at the floor (+3.8 to +4.4 ms at `min`) and by +4.3 to +6.0 ms at
  p50 — including the local fixture destinations, which traverse no network, and including wikipedia, which is
  the only remote one and the slowest on both sides. A constant additive term on a round trip that hits all six
  destinations equally is what a slower host or a costlier transport looks like; it is *not* what a per-page or
  per-destination cost looks like. If a host-wide slowdown were the whole story it would scale both metrics by
  one factor, and it does not: CPU rose **2.83×** per unit of work while the switch path rose ~**1.4×**. The two
  are work-normalized differently, so they are compatible — but the mismatch says the app's *non-switch* work
  grew proportionally more than its switch path, and the host hypothesis covers only the constant part. The
  proportional part has to be named from the leg-1 CPU split, where **79% of the tree's CPU sits inside
  Chromium**, which the plan's own instrumentation (app-side, benchmark-mode only) cannot account for.

  Naming that proportional part is what the per-component comparison does, and the two runs' baseline legs are
  the cleanest pair available: identical work (60 min, 119 bursts, 35,700 lines, 1169 switches), no leg
  ambiguity, and the same host two hours apart (legs4h2 ran 01:41-05:31 local today, this run 07:50 onward) —
  which is what retires the "slower machine" reading for the *level* as well, since a slower machine cannot
  differ from itself by 4-6× inside Chromium while the non-Chromium console host moves 1.48×.

  | component (leg baseline) | perf4h | legs4h2 | ratio |
  |---|---|---|---|
  | GPU | **124.16 s** | 28.16 s | **4.41×** |
  | chrome:standalone+toolbar+frame-backdrop | **99.31 s** | 16.39 s | **6.06×** |
  | Browser | 59.31 s | 32.19 s | 1.84× |
  | tabs (four renderers) | 49.96 s | 9.83 s | 5.08× |
  | console host (pty child) | 58.19 s | ~39.4 s | ~1.48× |
  | Utility | 10.69 s | ~0.45 s | — |
  | **total** | **415.705 s** | **146.876 s** | **2.829×** |

  The absolute gap is real and large — 2.488 → 7.039 s/min on identical work — but **it is not attributable from
  these two runs, and an earlier "it is in-app, render-side" reading must not be carried forward.** Three facts
  constrain it, and they point different ways:

  1. **The two runs loaded *different* bundles, and a directory mtime will not tell you that.** `.compiled`'s
     directory mtime reads 01:04, but a compile that overwrites files leaves the directory mtime alone — the
     real index is the files: **812 of 834** are newer than 01:05, and the newest is
     `.compiled/src/renderer/terminal-write-dispatcher.js` at **2026-09-21 06:16:57** local. legs4h2 ran
     01:41-05:31 and this run launched 06:20:18 (its own `startedAt`), so a full recompile sits **between** the
     two runs. The app-code term is therefore **live**, and this is consistent with what the plan already
     records elsewhere: the retention fix went into `.compiled`, so this run loaded it and legs4h2 did not.
     Do not read a bundle digest out of a directory timestamp again.
  2. **The growth is broad, not concentrated**: GPU 4.41×, the UI-surface bundle 6.06×, Browser 1.84×, the four
     renderers 5.08×, and the non-Chromium console host 1.48×. A whole-tree rebuild plus a fix that changes how
     often the renderers repaint would move several components at once, so breadth is *evidence* for a
     host-level term and not proof of one: a shift that also moves the pty children the rendering path never
     touches is what a host-level change looks like, and **this machine has a documented history of exactly
     that** — `plans/260830-1530-electron-cpu-memory-performance-optimization` exists because forced
     `ignore-gpu-blocklist` + `CanvasOopRasterization` spun the GPU process on this Intel UHD 630 to 130% of a
     core, and its red-team flagged the dual-GPU (UHD 630 + GTX 1650) adapter path. The GPU is *not* spinning
     here (124.16 s of a 3543.6 s leg = 3.5% of one core), so this is not that fault returning — but the same
     surface is where a host-side difference would sit, and the GPU's *share* of the app's CPU did rise,
     19.2% → 29.9%.
  3. **The harness differs, and the harness drives the app's work.** App-tree CPU counts work the app performs,
     and a CDP/RPC-driven scrape, per-switch bookkeeping and fixture traffic are app-tree work by construction.
     The newer harness carries more of all three, so part of the 2.829× can be harness-induced rather than
     intrinsic — a term the same-bundle control cannot bound, because it shares the harness.

  So three terms moved at once — bundle, harness, host — and the pair separates none of them on its own. What
  the pair does say is that the code delta is small and almost entirely on the capture/compositor path, which is
  also where the cost went:

  - `toolbar.ts`, edited 06:10:55 and uncommitted, is this plan's own retention fix, and it **removes** work:
    `renderChromeProfiles()` no longer rebuilds the profile dropdown on every state push, and `renderPhoneStatus()`
    no longer parses and rebuilds a template five times a second.
  - The rest of the delta is the 01:0x-01:31 cluster, all of it newer than legs4h2's 01:04 bundle:
    `native-tab-host.ts`, `standalone.js`, `standalone-preload.ts`, `contracts.ts`, plus the committed capture work
    `2697a28c` "stop hung capturePage wedging guest canvas", `d7c77d83` "raster inactive tabs and reassert after
    restore fail", `bee72187` "fail hung native raster without 25s wait", `462a48b4` "drop the background override
    the capture path never needed", and `a25d9f99` "restore native view canvas background and remove DOM fill".
    (`.compiled`'s newest file only *looks* like source: `src/renderer/terminal-write-dispatcher.js` is tracked,
    unmodified, and merely re-synced from `src/shared/terminal-write-dispatcher.ts` at 06:16:57.)

  That second group is the one that matters here. It moves background painting out of the DOM and onto the native
  view's canvas and the compositor — which is exactly where the cost went: GPU 4.41×, UI-surface bundle 6.06×,
  and a uniform +4 ms on every switch, because every switch paints. A work-removing renderer fix cannot produce a
  cost increase; a change that hands painting to the compositor can, and it predicts precisely the shape seen.
  Testing it is a bounded job: a worktree at the pre-01:04 revision, compiled and run against the *current*
  harness, separates this code term from the harness term — and it is the only run that can. Until then the
  verdict states the gap, states that it is not attributable from these two runs, and does not attribute it.
  `app.getGPUFeatureStatus()` — the prior plan's own acceptance check, compositing and video reporting Hardware
  Accelerated — plus the GPU process's share of the leg's CPU belong in the same artifact as the CPU table, so a
  4× GPU reading is either reproduced or named as a path change instead of left to inference.
- **No probe could have attached to this run, and that is recorded, not assumed.** `config.appArgs` is `[]`
  here, so the app carried no DevTools endpoint and the retention probe (`scripts/probe-renderer-retention-class.cjs`,
  self-test 11/11) had nothing to connect to. The probe therefore belongs to a *separate diagnosis run* —
  §Instrument first already carries its invocation — which is the same place the same-bundle leg-1 CPU control
  has to come from, since a post-fix run measures a different tree.
- **The component table above is the first hard evidence for Phase 3 item 3 ("the throughput work"), and it
  points somewhere the plan's wording does not.** Item 3 is scoped to "the CPU costs on the shared thread
  pool", but the leg-1 split puts **79% of the tree's CPU inside Chromium** (GPU 124.16 s + standalone
  renderer 99.31 s + page-tab renderer 46.50 s + Browser 59.31 s = 329.28 s of 415.71 s) and only ~12% in the
  console-host pty children, which are the *driver*, not the app. Whatever the 2.8× factor turns out to be, it
  is a Chromium-side cost that the plan's item 3 currently does not own — the `switchLatencyByTab` and
  signature-guard work already applied (2026-09-20) reduced *work per push*, and the remaining candidate on
  that side is the paint/composite volume the terminal pushes generate. Item 3's scope is widened here to say
  so rather than left to be rediscovered after the next run.
- **The launch log shows the bundle preflight doing its job for real, four minutes before this run started.**
  `perf4h-run.log` carries two blocks: `=== LAUNCH 2026-09-21 06:16:51 ===` with bundle md5
  `6d19d8a87a5e51da14e6eb00e71d10da`, then `=== RELAUNCH 2026-09-21 06:20:18 ===` with md5
  `c4a2d9f92a046701fce0192113649722` — the digest this run's identity records. That first block is the
  stale-bundle death §Phase 4 describes ("booting an app that recompiled itself 6 s in") caught on a real
  launch rather than in a fixture, and it is also why `.compiled` mtimes cluster at 06:16:57: the tree it
  compiled against moved underneath it and the run was replaced instead of measured. Every number below
  therefore belongs to the 06:20:18 relaunch.
- **Correction from the same watch: the leg-2 "sampler starvation" I recorded a few minutes ago was my own
  misread of the clock, and the time check refutes it.** The checkpoint log emits one line per 10 samples —
  `11 … 81` across leg 1 and `91` at 07:50:29 — so leg 2's first checkpoint falls due at ~08:00:29, and the
  read that was about to be called "minutes late" ran at **08:00:10, nineteen seconds early**. Nothing was
  late and nothing is starving; the run's own last reading (RAM 1579.93 MB, nine app processes, three harness
  pids) was healthy throughout. What survives is worth keeping as a *criterion* rather than a finding: the
  harness is itself a writer at 1200 lines / 30 s in leg 2, so **if leg 2's checkpoints arrive sparser than
  leg 1's ten-minute cadence, the write path is the bottleneck** — and that would be throughput evidence for
  Phase 3 item 3 independent of anything the app does. The stale-bundle preflight block above is unaffected
  by this correction. The window's other writer is explained the same way: the external-load series
  (`perf4h-external-load.jsonl`) holds 23 entries from 06:26:53 to 08:04:32 local on a steady 5.1-minute
  cadence (its newest entry, 08:04:32, was 3.4 minutes old when measured at 08:07:56), so it was alive and on
  schedule *through* the leg-2 transition rather than stalled. Two claims that were written here first do not
  survive that measurement and are withdrawn: there is **no missed tick** — every gap in the series is 5.1
  minutes, and the apparent 07:54 → 08:04 hole was an artifact of comparing two of my own readings instead of
  two consecutive entries — and nothing here says the sampler *finished*, because it is a detached process and
  its absence from `hub jobs` proves nothing either way. Both writers in this window are simply healthy, which
  closes the "two writers stalled" reading of the leg-2 transition entirely. (The series also witnesses
  integrity independently: each entry carries `compiledRewritten` and `externalPids`, alongside `loadPct` and
  the machine's free/total MB.)
- **The comparator's three legs are all closed, and they say its CPU is baseline-dominated — which is what
  makes the 2.8× unattributable rather than merely unexplained.** `real-soak-8h-legs4h2.json` does not exist;
  only the checkpoint does (`status: in-progress`, 231 samples, yet all three legs closed — the same
  stale-final shape the first bullet in this section documents). Its legs, read from that checkpoint:

  | leg | injected volume | bursts / switches | cpu s/min |
  |---|---|---|---|
  | 1 baseline | 300 lines / 30 s — 35,700 lines | 119 / 1169 | **2.488** |
  | 2 burst4x | 1200 lines / 30 s — 142,800 lines | 119 / 1169 | **2.985** |
  | 3 burst-off | 1 line / 600 s — 5 lines | 5 / 1170 | **2.919** |

  A 4× volume increase moves CPU by 20%, and a leg that injects **five lines in an hour** still costs 2.919
  s/min — more than the heavy baseline leg. So for legs4h2 the cost is the *baseline* (fixture tick at 200 ms,
  six tabs, renderers), not the terminal burst. That matters here for exactly one reason: a 2.83× gap on
  baseline-dominated work cannot be explained by "more work per push", so it is either the machine (against
  which the idle-background measurements above argue) or the app code, which does differ between the two runs —
  and the clean evidence for that is the compile boundary, not any single file's mtime: legs4h2 loaded the last
  pre-launch compile (01:04), while 812 of the 834 compiled files were rewritten at 06:16, after legs4h2 ended. A
  file written *during* the window is not evidence about that run: what the boundary shows is the compile, and the
  app that ran had already loaded its own copy, so nothing written to `.compiled` while that run was in flight could
  have reached it. This run's own legs 2 and 3 are the other half of that evidence and are already in
  flight: if their CPU stays flat the way legs4h2's did, the *shape* matches and only the level differs; if
  they scale with volume, the current bundle has introduced workload-dependent cost, which would be a more
  serious finding than either hypothesis above.

## Open items added by the in-flight reads (2026-09-21)

Recorded so the verdict pass does not have to re-derive them. None of them is a patch to make while this run is
in flight.

### The checkpoint and log advance every 10 samples, so ~10 minutes of silence is not a stall

Measured 2026-09-21 08:19 while leg 2 was open: `perf4h-run.log` and `real-soak-8h-perf4h-checkpoint.json` both had
mtime 08:10:29 — 535 s old — while `samples` was 111 and leg 2's `observedMinutes` was 19.85, i.e. both writers were
exactly in step with each other. The reason is cadence, not failure: the checkpoint is written and logged once per
**10** samples (`Saved 11 / 21 / … / 111 samples`), and samples accrue at one per minute. Liveness was checked
directly instead of inferred — `perf4h-pid-manifest-20260921.json` records harness pid 21752 and app main pid 2596,
both alive at that moment (2596 is the same pid the CPU table lists as `Browser#2596`).

So an age of up to ~10 minutes is normal for both files, and neither one's mtime is a liveness signal. What *is* a
signal is the two disagreeing, or a leg's `observedMinutes` falling behind wall clock.



### The switch-latency shift is a floor, not a tail — and it is present from minute one

Both checkpoints keep their full `switchSamples` (dropped = 0), so the two runs can be compared by phase without
relying on the report's percentile fields:

| phase | perf4h min / p50 / p95 / max | legs4h2 min / p50 / p95 / max |
|---|---|---|
| warmup (n = 585 in both) | 12.49 / **15.75** / 20.99 / 34.85 | 8.29 / **10.68** / 13.26 / 32.10 |
| workload | 12.06 / **15.69** / 20.53 / 30.94 | 8.08 / **10.74** / 13.07 / 94.69 |

Three things follow, and they are what the verdict has to say next to the gate row:

- **The shift is additive and constant.** `min` moves too (8.08 → 12.06), so it is not a heavier tail; the tail
  actually *shrank* (94.69 → 30.94). Every switch pays roughly 4-5 ms more, and the fastest switch is no exception.
- **It is not drift and not a leak.** Warmup is the run's first 30 minutes at the lowest load, the sample count is
  identical (585 each), and the gap is already fully present there (10.68 → 15.75). A within-run degradation would
  start at parity and grow; this starts at +5 ms.
- **It is not attributable to the host on its own.** The same machine ran both, and the non-Chromium console host —
  which cannot have changed with a Chromium compositor fix — moved 1.48× while the GPU process moved 4.41× and the
  UI-surface bundle 6.06×. A host-wide slowdown would move the console host by the same factor it moves the
  compositor; 1.48× on that host does not account for +5 ms on a Chromium switch, so the remainder sits on the
  bundle. That remainder is the term the pre-01:04 worktree A/B below is meant to separate, and the capture and
  compositor commits (`a25d9f99` "restore native view canvas background and remove DOM fill", `133c54fa` "refuse a
  capture whose view has no compositor surface", `2697a28c` "stop hung capturePage wedging guest canvas") are the
  candidates that a fixed per-switch compositor cost would come from.

The comparator's tail is also a single sample, not a distribution: its next-slowest switch is 25.33 ms, against the
94.69 ms outlier at +48.8 min and a batch of 16-25 ms behind that. This run's top three are 34.85 / 30.94 / 26.91,
and its worst sits in warmup at +16.6 min. So the two runs differ not in how bad their worst case is but in where
the cost sits: the comparator had one stall and a 10.7 ms floor, this run has no stall and a 15.7 ms floor.

### Why the memory rise and the CPU rise almost certainly have different owners

`activeWorkingSetMB` runs higher in this run than in the comparator at every checkpoint (postWarmup → final:
1571.77 → 1579.93 against 1503.57 → 1560.39), which is what fails the ≤ 1600 MB gate at 1607.08. That direction is
exactly what the retention fix predicts: `renderChromeProfiles()` and `renderPhoneStatus()` stopped rebuilding
their subtrees on every push, and the DOM they no longer throw away is memory they now keep. So the same change
that removes per-push work also removes per-push garbage — memory up, work down.

The CPU and GPU went *up* (2.488 → 7.039 s/min on identical leg-1 work; GPU 0 → 124.16 s on a 59-minute leg). A
change that makes the app do less per push cannot produce that, and no per-workload term can either (leg 2 moved
the injected volume 4× and CPU by +0.8%). So the memory side of this run is the toolbar fix working, and the CPU
side is a different commit — which leaves the capture/compositor group named above as the candidate, not because
it is convenient but because it is the only group in the delta that adds work rather than removing it.
(`[INFERENCE]` — the split is inferred from the directions; the numbers on both sides are measured.)

1. **Compile in a worktree at `08c4d541`, then A/B it against the current harness.** `08c4d541` (00:32:54) was
   `HEAD` at the 01:04 compile, i.e. the tree the comparator (`legs4h2`) launched on at 01:41; `HEAD` now is
   `2697a28c` (01:31:21). So **exactly two commits** — `0f8c51ca` "badge MCP risk and honor highlight color"
   (which is also a browser/renderer commit: `toolbar.ts` +495 lines) and `2697a28c` (stop hung capturePage
   wedging guest canvas) — entered this run's bundle that the comparator's
   could not have had, alongside **14** `src/` edits made between **01:09:53 and 01:37:15** and **13** tracked files
   currently modified. The strongest candidate — the change that moved background painting from a DOM fill onto the
   native view's canvas and the compositor — sits in that group. `toolbar.ts` (06:10, uncommitted) is this plan's
   retention fix and it *removes* work, so it cannot explain a cost increase. The worktree run is the only run that
   separates this code term from the harness term; it needs its own `npm run compile` and must not run while this
   soak holds the machine. The uncommitted residue is not reconstructible, so that run bounds the **committed** delta
   rather than the whole one — and it is the only operation that removes the harness term from the host term.
2. **Put the GPU facts in the artifact.** `app.getGPUFeatureStatus()` (compositing/video Hardware Accelerated — the
   prior plan's own acceptance check) plus the GPU process's share of each leg's CPU, so a 4.41× GPU reading is
   either reproduced or named as a path change instead of left to inference. The per-process rows the app already
   emits carry neither GPU nor feature status.
3. **State the latency gate's harness-term limit in the verdict.** A same-bundle control bounds the *host* term but
   not the round-trip the harness itself takes through the browser-control port, which is where a slower reply lands
   as a tail-switch stall. The verdict can say the tail is not a per-tab or per-push cost; it cannot say the
   harness's own round trip is excluded while no same-bundle run under separate harness PIDs exists.
4. **The fixed switch cost is a constant step; its owner is not `2697a28c`.** Per-switch
   latency is load- and time-independent in both runs — over 1753 workload switches
   `r(ms, CPU per minute) = +0.074` (16.18 ms in the lowest-CPU fifth vs 16.51 in the
   highest), drift `+0.006 ms/min` over 90 minutes, with the comparator at `r = −0.024`,
   `−0.001 ms/min` — so the +5.6 ms p50 shift is a **constant step in the switch path**,
   not scaling work. The earlier attribution to `2697a28c` (removing
   `isTemporarilyAttachedView` so every activation recycles) is **false**: that commit
   only changes the capture-held path (`git show 2697a28c -- src/main/browser/native-tab-host.ts`,
   13 lines). A soak switch does not hold a capture. The working-tree instrument that
   names the step is the `switch-steps` row inside `switchTab` (six marks, collected as
   `switchStepSamples`); the aborted `perf4h` run does not carry it. The staged A/B
   worktrees (`AntiFan-wt-0f8c51ca`, `AntiFan-wt-08c4d541`) remain valid for *which commit
   introduced the step* once a short workload leg is run with the new rows — they are not
   a reason to ship a conditional-recycle patch first.


## steps4h — the run that names the switch step (in flight, 2026-09-21)

Launched **15:15:05** (`node scripts/benchmark-real-soak-8h.cjs --minutes 240`, `SOAK_REPORT_TAG=steps4h`,
`SOAK_LEGS=baseline:60:300:30000,burst4x:60:1200:30000,burst-off:60:1:600000`), warmup 30 → workload 180 →
recovery 30 → ends **19:15:35**. Identity and process attribution are in
`runtime-verification/steps4h-pid-manifest-20260921.json` (bundle md5 `adbf8916…`, 417 files; the external-load
series it writes is `steps4h-external-load.jsonl`).

It is the first run whose bundle carries the per-step instrument, verified in the running tree rather than in the
source: `.compiled/src/main/browser/native-tab-host.js:4529` records the `switch-steps` benchmark row inside
`switchTab`, guarded by `isBenchmarkEnabled()` and allocating nothing when benchmarks are off. The six marks are
`ensureView`, `attachSweep`, `layoutBroadcast`, `throttle`, `invalidateFocus`, `presentedView`; everything from
`switchStartMs` to the first mark is unattributed, so the analysis must also report
`switched − Σsteps` as the head rather than letting it hide.

What this run must settle (open item 4 above): whether the +5.6 ms constant p50 step sits in one of the six marks,
in the head, or outside the app entirely — the harness measures its own round trip, so `switch-steps` (inside the
app) against the harness's `switchSamples` (outside it) separates the app term from the transport term on the same
switches. Same leg schedule as `legs4h2`, so the comparator columns stay comparable.

### Applied in this pass but not yet compiled (must be verified after 19:15)

`openTab` reported a dead session anchor as a quota breach, with `used` defaulting to the limit:

- `src/main/tools/browser-control-port.ts` — `openTab` now refuses a dead anchor up front with `TARGET_STALE` and
  names the recovery (`anti.browser.rebind_target`), using `hasTab` exactly as `closeTab`/`switchTab` already do
  for the same staleness; and the adoption-refused branch only reports `POLICY_DENIED` when the counted set really
  reaches `SESSION_TAB_LIMIT`, otherwise `SESSION_STALE` carrying the measured count.
- `test/unit/browser/open-tab-anchor-liveness.test.ts` — five cases over a fake host: dead anchor creates nothing,
  pool refusal under the limit reports the measured count, a genuine quota refusal still reports the quota, the
  gate stops before creating, and the happy path returns the tab.

Both were verified as **source only** (`ts.transpileModule` syntax clean; no compile), because
`npm run compile` rewrites `.compiled` under the running app. Deferred to after the run, in this order:
`npm run compile`, `node --test --test-force-exit ".compiled/test/unit/browser/open-tab-anchor-liveness.test.js"`,
`npm run typecheck`, then the analyzer pass and the verdict.

#### steps4h ended at 7 minutes: the app's windows were closed from outside the run

Measured 2026-09-21 15:22. The harness printed `Electron child process exited unexpectedly with code 0`,
then aborted the loop; the app's own lifecycle journal (copied out before the directory was reused, because the
harness deletes its data root at launch) names the trigger and the sequence — pid 26464, uptime 6.77 min:

```
08:21:59.879Z shutdown.begin            (uptimeMs 406383)
08:21:59.940Z window-all-closed
08:22:00.385Z before-quit -> will-quit
08:22:00.387Z process.exit.event code 0
```

That is an **ordered shutdown triggered by the last window closing**, not a crash and not resource exhaustion:
every teardown step (`ledger.settleInFlight`, `terminal.persistSync`, `tabHost.flushAllSessions`,
`cookies.flushStore`, `bridgeServer.dispose`) completed before the exit. The handler is `src/main/index.ts:942`
(`window-all-closed` → `shutdown()` → `app.quit()`), so *any* external close of the soak app's windows ends a
measurement run. The degraded teardown the harness then reported (`WebSocket is not open` × 7) is the consequence
of the child already being gone, not a separate defect.

**The run was killed twice over, and the second one is a harness defect, now fixed.** With the child gone, the
final-report path threw `ReferenceError: workloadEndTime is not defined` at `benchmark-real-soak-8h.cjs:2225`: the
three deadline variables (`warmupEndTime`, `workloadEndTime`, `totalEndTime`) were declared with `let`/`const`
*inside* the `try` block whose `finally` reads them, and a `let` inside `try` is invisible in `catch`/`finally`. So
a run that lost its app also lost its report — the checkpoint written by the abort path was the only artifact.

Fix: the three deadlines are declared before the `try` (the minimal scope-preserving form; `startTime` and `now`
already were). Proven on a live run rather than argued: a 3-minute smoke (`SOAK_WARMUP_MINUTES=1
SOAK_RECOVERY_MINUTES=1 SOAK_LEGS="smoke:1:60:6000" SOAK_REPORT_TAG=smokefinal`, 15:28–15:31) wrote
`real-soak-8h-smokefinal.json` — `Final report saved to …\real-soak-8h-smokefinal.json` — which is exactly the
path that threw for steps4h. Its `FAILED` verdict is by construction (a 1-minute leg holds no workload samples to
fit and the latency band is calibrated for 60-minute legs), so the smoke proves the writer, not the gates.

The deferred verification above was then executed against the same compile (15:26–15:27):
`npm run compile` clean (emit-integrity 405 files, budget-dominance OK, dispatch-payload OK),
`open-tab-anchor-liveness.test.js` 4/4 pass, `npm run typecheck` clean.

### steps4h2 — the replacement run (in flight, 2026-09-21)

Launched **15:32:56** under a wrapper that restarts a run only if it dies *before* its schedule completes
(`C:/Users/Admin/AppData/Local/Temp/soak-attempts.cjs`; a run that reaches 240 minutes and fails its gates is a
result, not a retry). Identical schedule to steps4h, so its columns compare with `legs4h2`:

| | |
|---|---|
| tag / argv | `steps4h2`, `node scripts/benchmark-real-soak-8h.cjs --minutes 240` |
| legs | `baseline:60:300:30000,burst4x:60:1200:30000,burst-off:60:1:600000` (warmup 30 / workload 180 / recovery 30) |
| boundaries | warmup ends 16:03, legs end 17:03 / 18:03 / 19:03, recovery ends 19:33 |
| bundle | 418 files / 8.8 MB, md5 `6a333f3c1bee6438bbe2a1fcb13ed0a2` (carries the fixed harness **and** the `openTab` anchor fix) |
| pids | harness 26304, app main 25888, 12-process app tree — `steps4h2-pid-manifest.json` |
| log / sampler / monitor | `steps4h2-run.log`, `steps4h2-external-load.jsonl`, `steps4h2-monitor.jsonl` |

The watcher (`C:/Users/Admin/AppData/Local/Temp/soak-watch.cjs`) prints one status line a minute, appends a
leg row — latency percentiles, the six `switch-steps` medians, per-process private-byte slopes, renderer slope,
host competition — at each boundary, exits 3 if the checkpoint stalls past 15 minutes, and exits 0 when the final
report lands. It exists because the checkpoint and the run log both advance once per **10 samples**, so a silent
run and a dead one look identical for ten minutes at a time.

Host competition, measured for this run rather than assumed (sampler rows, 15:33 and 15:38):
`machineFreeMB` 1390 → 1241 of 16236, `external` 24–28 processes / 3.6–4.3 GB RSS, `loadPct` 100 → 14. A separate
reading of the same window puts **committed** memory at 26.9 GB against 16.2 GB physical, i.e. the host is paging
by ~10 GB. Yesterday's runs sat in the same regime (`machineFreeMB` 1884–1992, `loadPct` 51–88, external
4.1–4.3 GB, `steps4h-external-load.jsonl`), which is what keeps the cross-run comparison valid: the competition is
the constant, not a new confound. It does bound what the latency and peak gates can claim, and the verdict must
carry that bound.

**Not fixed here, deliberately: the app cannot survive its last window closing.** `src/main/index.ts:942` quits on
`window-all-closed`, and the harness holds no window of its own, so an incidental close — the user closing the
soak window while working in another app, as happened at 15:22 — destroys a four-hour measurement. The fix is an
opt-in keep-alive under benchmark mode (`ANTIFAN_BENCHMARK`), which is a lifecycle change with its own test, and
it cannot be compiled into a run that is already measuring (`npm run compile` would rewrite the bundle under it).
Recorded as a follow-up, not implemented mid-flight. If steps4h2 dies the same way, the machine is free again and
that change can be made and tested before the retry.

#### Instrument check on the smoke: `attachSweep` owns most of a switch

The 3-minute smoke carries the whole step instrument, so its 20 warmup switches are a free sanity read on the six
marks and on the head the plan asks the analysis to report. Switch p50 **19.207 ms** decomposes as `attachSweep`
**12.261**, `presentedView` 4.83, `layoutBroadcast` 0.465, `invalidateFocus` 0.149, `throttle` 0.114,
`ensureView` 0.032 — Σsteps 17.85 — leaving an unattributed **head of 1.36 ms** (`switchStart` → first mark). Two
provisional readings:

- **The head is small.** ~1.4 ms sits between the harness's call and the app's first mark, so the transport term
  the plan's open item 2 worries about is bounded at the low end.
- **`attachSweep` is the term to watch.** It is 64 % of the switch here. Its absolute value is *not* comparable to
  a clean run — the smoke is inflated by a cold start, six fresh tabs and `loadPct 100` on a paging host, and
  yesterday's warmup p50 was 10.68 ms against the smoke's 19.2 — so the claim is only that `attachSweep` dominates
  the delegate, not that 12 ms is what the app costs. steps4h2's leg rows carry the same six medians at 60-minute
  volume, with a head term computed per boundary.

### night4h — the completed 4 h run (2026-09-22, FAILED)

The first run in this plan to reach 240 minutes. The full analysis is
`plans/reports/runtime-verification/real-soak-4h-verdict-night4h.md`; this section records what it changes here.

- **Bundle `46f1f609…`, 419 files, held for the whole run** — `start.md5 == end.md5`, `changedDuringRun: false`.
  30/180/30 min, legs `baseline:60:300/30000 | burst4x:60:1200/30000 | burst-off:60:1/600000`, 3,920 switches.
- **Gates**: latency **FAIL** (workload p50 23.259 vs ≤12, p95 37.697 vs ≤18); peak memory **FAIL** (1692.17 vs
  ≤1600, and still a walk-contaminated number, see below); slopes pass but are **not graded** on a leg run; 0
  orphans; 6/6 tabs and the terminal closed; `executionOk: true, teardownOk: true`.
- **The run is not stationary**: p50 across 30-minute bands 47.89 → 28.82 → 27.75 → 26.84 → 20.21 → 19.18 →
  19.41, i.e. a front-loaded decay (−40 % inside the first 30 minutes). The comparators are flat on the same
  axis — `legs4h2` 11.20/10.43, `legs4h` 13.16/12.96, `perf4h` 15.97/15.64, `domprobe` 16.59/15.92 — so the decay
  belongs to this bundle rather than to the harness. This is why the A/B uses an elapsed band, not a phase.
- **The bundle ladder has four points and no overlap**: `6a333f3c…` **19.00 / 20.45** vs `46f1f609…`
  **47.68 / 49.16** on elapsed 0–10 min (two runs each), same-bundle spread ≤1.48 ms against a 27.23 ms
  between-bundle gap. `night4h`'s own payload is the fourth point (warmup p50 **47.599**, n=530).
- **Driver test resolved**: CPU tracks burst volume (6.142 / 7.801 / 8.927 per leg) while latency falls across the
  same legs (28.24 / 23.23 / 19.34). The legs are time-ordered, so "the driver doesn't matter" is true for
  latency only; its cost is real and lands in CPU (top consumer: the console host pty child, 24.2 %).
- **Mechanism, measured at volume**: `attachSweep` 58–65 % and `presentedView` 30–36 % of a switch, `ensureView`
  0.03 ms, unattributed head ~1.4 ms. Both terms halve across the run — the decay is inside these two marks.
- **Peak memory stays unreadable as app-only** while the walk keys on process parentage (the Zalo collision already
  recorded above). The app-owned private measure passes at 0.1323 MB/min (pid 19768, GPU).
- **No mid-run compile**: the sampler's `compiledRewritten` is non-zero in exactly one sample (the first tick) and
  `.compiled`'s newest mtime is 00:54:34, before the 01:00:57 launch.
- **New constraint on the A/B's identity test**: `core.autocrlf=true` with no `.gitattributes` means
  `git checkout HEAD -- <file>` rewrites that file CRLF (208,631 → 213,794 bytes for `standalone.js`), and the
  compile copies it verbatim. Bundle md5 equality across two separately-checked-out trees is therefore not a valid
  identity test; the arms compare the elapsed 0–10 band instead.

## r2 voids the A/B ladder, and the switch's cost is the insert index plus a re-created visual (2026-09-22)

Two fixes in the switch path, both landed, both measured against the run this pass launched.

### The ladder is void: one bundle shows the whole step

`r2` ran bundle `a1e5f358…` at **leg-1 volume only** and still produced the full step — warmup p50 **49.02 ms**
(n=530) against leg 1 **30.95 ms** (n=29). The same bundle, the same build, the same page set; only the phase
moved. The ladder's premise was that the *driver* separates the arms, so the step it localized was being produced
by the switch volume, not by the burst volume. The same pattern repeats in the legs of the earlier run: bundle
`f2e0b41f…` gave 13.48 ms at leg 4 (`burst-off`) and 23.89 at leg 5, and bundle `0b56f9f6…` gave 20.16 at leg 5
against 20.98 at leg 6 — one bundle, two numbers, decided by the phase and switch volume.

Consequence for every later gate read: a latency comparison is only valid **within one elapsed band**, and the
leg ladder cannot carry a causal claim about the burst driver. `legSlopes` remains valid for CPU (the driver's cost
shows there, not in latency).

### The mechanism: the pane was inserted under the views it was replacing

`attachTabView()` inserted the view at `children.indexOf(frameBackdropView) + 1` — i.e. *beneath* the tab views this
very switch was replacing. `enforceZOrder()` then had to remove and re-attach the view, the sidebar and the toolbar —
three removes, three adds, three invalidates — to reach the order a different insert index produces directly. Because
that index depends on the **current** `_children` order, the same compiled bundle costs 30.95 ms or 49.02 ms
depending on the attach history that preceded the switch: this is the hidden variable behind the run-to-run spread.

### Fix 1 — `reassertPresentedView()` no longer recycles a visual it just made

`reassertPresentedView(options)` takes `recyclePresentedLayer` / `recycleMobileLayer`. The switch records
`isTabViewAttached()` for the target **before** it calls `attachTabView()`, and passes that down: a view the switch
itself just attached already owns its visual, so the remove+add is pure cost. A view that was already attached still
recycles exactly as before — the occlusion/capture path (and the white-canvas guard it exists for) is unchanged.

This is **not** the patch this plan retracted (`2697a28c` read as "make recycle conditional on a stale
presentation"). That retraction stands on its own reasoning: a soak switch does not hold a capture, so a
capture-shaped condition would never fire. The predicate here is not staleness but **provenance** — it isolates
exactly the case the retraction did not consider, the view this same switch attached moments earlier — and the
step marks already name that case: `presentedView` is 36 % of a switch on the measured bundle.

### Fix 2 — `attachTabView()` inserts where `enforceZOrder()` wants it

```ts
let insertIndex = children.length;
const shellAbove = [this.sidebarView, this.toolbarView].find((shell) => shell && children.includes(shell));
if (shellAbove) insertIndex = children.indexOf(shellAbove);
```

Above every other child, below the shell chrome — the order the re-stack was computing, produced by one insert.

### How the two fixes were chosen

They are not guesses at the switch path; they are the two marked sub-steps. On the measured bundle a switch's
p50 decomposes as `attachSweep` **26.689 ms (58 %)** + `presentedView` **16.677 ms (36 %)** + `ensureView` 0.034 ms,
against a ~1.4 ms head. Fix 2 changes what `attachTabView()` — which runs inside `attachSweep` — does to the child
order; fix 1 removes the remove-and-re-add — which is `presentedView` — for the view the switch just attached.
Together the marked terms are 94 % of a switch.

### Evidence

`npm run compile` exit 0; `node --test --test-force-exit test/unit/native-tab-host-presented-view.test.ts` **2/2
pass** (new: a view attached within the same switch is not recycled; a view already attached still is; and the
checkable invariant that an insert at the z-order position leaves `enforceZOrder` nothing to fix). Mutation check:
restoring `recyclePresentedLayer: true` fails the test.

### Next target, recorded rather than applied

The two fixes took the two named terms down; the remaining one is now `attachSweep` itself — **9.76 ms of a
~14 ms switch (≈70 %)** in `4hfix7`'s warmup band, down 4× from 26.689 but still the largest term, with
`presentedView` at 0.78 ms and everything else under 1 ms. It is the attach sweep: the N view attaches a switch
performs, each of which lays out a view. Nothing here is applied, because the plan's own risk rule forbids a
recompile between launch and verdict — the workload numbers from the run in flight decide whether it is worth
opening at all.

**In-flight readout** (`4hfix6`, bundle `53f0fa88…`, warmup band only — the verdict number is the 180-minute
workload phase): at 27 minutes in, n=376 warmup switches give p50 **9.83 ms** and p95 **14.17 ms**, against a gate
of p50 ≤ 12 / p95 ≤ 18. Step means: `attachSweep` **6.735 ms** (was 26.689) and `presentedView` **0.581 ms**
(was 16.677) — the two marked terms the fixes target, moved 4× and 29×. The same phase on the older bundles read
47.599 (night4h) and 49.02 (r2). Max is 101.03 ms, a warmup outlier to characterise in the verdict;
`slowSwitchSamples` carries the ten worst. The band grew to n=566 by the time the run was killed, p50 **9.62** /
p95 **15.32** — the table below uses that larger band, and it is the last reading `4hfix6` can give.

The same-phase comparison against the unfixed bundle, on the same instrument, is the sharpest form of that
readout — `night4h`'s warmup band against the fixed bundle's, before either was touched by a workload. `4hfix6`
was killed externally at 31.01 minutes (see the section below: the harness watchdog, not the app), so its numbers
are an in-flight reading and not a gate result:

| warmup band | n | p50 | p95 | p99 | max | switches > 35 ms |
|---|---|---|---|---|---|---|
| `night4h` (bundle `46f1f609`, unfixed) | 530 | 47.60 | 59.24 | 67.70 | 132.32 | **454 (85.7 %)** |
| `4hfix6` (bundle `53f0fa88`, fixed, in-flight) | 566 | **9.62** | **15.32** | **25.87** | 101.03 | **2 (0.35 %)** |

4.9× on p50, 3.9× on p95, and the population above the 35 ms line falls from 85.7 % to 0.35 % — the tail is gone
as a *class*, not trimmed. `night4h`'s workload p50, the number that failed the gate at 23.259 ms, is 2.4× this
run's *warmup* p50.

## The attempt harness killed three healthy runs (2026-09-22, defect introduced and fixed in this pass)

`4hfix7` launched 08:20:29 and was gone at 11.01 minutes, in warmup, with `burstsByPhase.workload: 0`. That is the
same shape as `4hfix6`'s death, so the immediate read was "the window-close path again" and fix 3 was extended on
that reading. It was wrong. Both were killed by the wrapper's own stall watchdog, which states so itself:

```
soak-4hfix-d  {"event":"attempt.stalled","tag":"4hfix6","idleMinutes":5.01}
soak-4hfix-d  {"event":"attempt.finished","tag":"4hfix6","code":null,"signal":"SIGTERM","elapsedMinutes":31.01,...}
soak-4hfix-e  {"event":"attempt.stalled","tag":"4hfix7","idleMinutes":5.25}
soak-4hfix-e  {"event":"attempt.finished","tag":"4hfix7","code":null,"signal":"SIGTERM","elapsedMinutes":11.01,...}
```

**Cause.** The watchdog compared `stallLimitMs = 5 * 60 * 1000` against the **sampler file's mtime**, and the
comment above it justified the number with a false premise - "the sampler appends a row a minute". The sampler's
cadence is `INTERVAL_MS` (300 s by default) **plus** the duration of its own PowerShell process walk, so its rows
land 309-314 s apart, i.e. *past* the limit on every tick. The watchdog was therefore set below the heartbeat it
watched. `4hfix6`'s rows (00:46:26, 00:51:35, 00:56:47, 01:01:55, 01:07:03, 01:12:11) and `4hfix7`'s (01:21:00,
01:26:14) are the measurement of that cadence.

**Why it fired at 11 and at 31 minutes rather than at 5, and why that is not a dead sampler.** After each write,
`idle` crosses 300 s only in the **9-14 s** before the next row lands, while the watchdog asks every **60 s** - so it
fires with probability ~15-23 % per cycle, and the cycle it lands on is the death time. Both recorded `idleMinutes`
sit just above the limit (5.01, 5.25) rather than at 10-30 minutes, which is the signature of a sampler that is
**alive and slightly slower than the limit**; a dead sampler would have produced a much larger idle. One consequence
beyond these runs: silent deaths at around the half-hour mark in this harness have a mechanical explanation, and an
app-side cause must not be inferred from "the app is gone and no error was logged" alone.

**What this retracts.** Fix 3's evidence was `4hfix6`, and `4hfix6` was not a window close. The window-close class
is still real and still has its own evidence (`steps4h`, below, whose app journal shows an ordered self-shutdown),
so fix 3 is kept - re-anchored on `steps4h` - but the claim "the cause of `4hfix6`'s death" is withdrawn here and in
the changelog, and the harness's `SIGTERM` path is what made the two deaths *look* app-side: the harness installs a
`SIGTERM` handler that aborts through the teardown lifecycle, so an externally killed run still ends with closed
tabs and a clean-looking shutdown trail.

**Fix.** The limit is 20 minutes, and the watchdog now takes the **newest mtime across the three heartbeats the run
actually emits** - sampler row, checkpoint, run log - so the coarsest of them can no longer be read as a hang. A
genuine hang still trips it: nothing in the run writes for 20 minutes. The kill path is now a **tree kill**
(`taskkill /PID <pid> /T /F`) instead of `child.kill()`: the case the watchdog exists for is a *wedged* harness, and
a wedged harness never reaches its own `SIGTERM` handler - the one that runs the teardown and taskkills the app - so
a bare signal would leave the app holding the bridge port for the retry the wrapper is about to start.

**Consequence for the evidence.** `4hfix6` (31 min), `4hfix7` (11 min) and `4hfix8` (stopped deliberately once this
was found) produced **no completed payload and no gate number**, so none of them is cited as a gate result. What
they do carry is warmup-band *measurement* taken while the app was healthy - the 566 switches behind `4hfix6`'s
9.62 ms p50 were recorded over 31 minutes of normal operation and an external `SIGTERM` at the end does not
retroactively invalidate them. They are in-flight readings, superseded by `4hfix9` (same fix set, one more gated
change, and a run that can finish), and the band table above is recomputed against `4hfix9` below rather than
resting on a run the harness itself killed. Their logs, checkpoints and sampler rows stay on disk as the run
identities they were.

**Relaunch.** `4hfix9` / `4hfix10` / `4hfix11` (wrapper `soak-4hfix-g`), same compiled bundle `2aacaa2c…`. `4hfix9`
started 08:40:40: bundle `2aacaa2c11df5a9331ede42f7b0b4747`, 419 files, bridge connected on 20129 (app pid 11648),
6 tabs, terminal session, 9 app processes, warmup until 09:11:22, workload 09:11:22 → 12:11:22, recovery → ≈12:41,
verdict after that.

