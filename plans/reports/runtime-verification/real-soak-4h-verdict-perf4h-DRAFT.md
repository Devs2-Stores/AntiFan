# Soak 4h — verdict (tag `perf4h`) — **DRAFT, run in flight**

> Assembled 2026-09-21 08:18 local while `real-soak-8h-perf4h` was still streaming (leg 2 of 3). Every number
> below was read from an artifact, not recalled; each is annotated with the artifact it came from. Leg 3, the
> recovery phase, the graded final report, and `slopeGateApplicable` for the whole run are **not available yet**
> and are marked accordingly. This file must not be read as the final verdict until the run ends (~10:20) and the
> missing rows are filled.

## 1. Run identity

| | |
|---|---|
| run | `scripts/benchmark-real-soak-8h.cjs`, tag `perf4h`, `--minutes 240` |
| launched | 2026-09-21 06:20:18 local (`startedAt` 2026-09-20T23:20:18.658Z) |
| ends | ~10:20 local (30 warmup + 60/60/60 legs + 30 recovery) |
| legs | `baseline:60:300:30000, burst4x:60:1200:30000, burst-off:60:1:600000` |
| comparator | `real-soak-8h-legs4h2`, launched 01:41, ended 05:31, **leg 1 only** (legs 2–3 ran, but no final report was written — checkpoint only) |
| artifact | `real-soak-8h-perf4h-checkpoint.json` (in flight), `perf4h-run.log`; `real-soak-8h-perf4h.json` not yet written |
| probe | `config.appArgs` is `[]`, so no DevTools endpoint and no retention probe attach; recorded, not assumed |

## 2. Gate table — the live criteria, not the ones an older note quoted

The switch-latency criterion is `p50 ≤ 12 ms && p95 ≤ 18 ms` on the workload phase; `switchMax` is **reported, not
graded**. That is a user decision taken 2026-09-20 (Phase 3c): the `switchLatencyMaxMs: 35` row was deleted from
`FREEZE_SLO`, the max term was removed from `latencyOk`, and `test/unit/soak-latency-gate.test.mjs` grades the
verdict function — reinstating the old term fails 2 of its 6 cases.

| gate | criterion | 2026-09-19 2h run | this run (leg-based) | verdict |
|---|---|---|---|---|
| renderer memory slope | ≤ 0.15 MB/min | 0.208 | 0.0797 | not graded on a leg run (`slopeGateApplicable: false`) |
| switch latency | p50 ≤ 12 **and** p95 ≤ 18, workload | max 42.1 | **p50 15.693 / p95 20.53** (max 30.94) | **FAILS** |
| peak active memory | ≤ 1600 MB | 1549.7 | **1607.08** | **FAILS** |
| `appPrivateMaxSlopeMBPerMin` | ≤ 0.15 | not measured | 0.1828 | reported, not graded on a leg run |
| orphans | 0 | 0 | 0 | passes |

Two readings of the latency gate have to be stated together, because the gate changed and both facts are true:

- Under the criterion in force **now** (p50/p95), this run **fails** where the comparator **passes** — 15.693/20.53
  against 10.737/13.069.
- Under the criterion that was in force on 09-19 (max ≤ 35), this run **passes** (30.94) and the 09-19 run failed
  (42.1). The tail is genuinely gone.

Both are the same measurement seen through two criteria; the percentile gate is the one the user chose, so the
verdict of record is **FAILED on latency**.

## 3. What the fix bought — measured against the comparator's leg 1

Leg 1 is the only clean pair: identical schedule, identical injected load to the unit (`119 bursts / 35,700 lines /
1169 switches` in both), no leg ambiguity, and the same workstation a few hours apart. That last point is context,
not a payload field: **neither checkpoint records any host identity** (checked — the sample and metric key sets
carry no host/os/machine field), so the claim rests on both runs using the same local `--user-data-dir` profile
under the same harness on this machine, which is an `[INFERENCE]`. Two parts of that are now measured rather than
inferred, from the harness itself: its data root is the **fixed path `E:/Work/.antifan-soak-8h`** and it
**`rmSync`s that path before every run**, so both runs started from an identical wiped profile rather than merely
a similar one; and the tab pages come from the harness's **local fixture HTTP server**, so the content the two
bundles composited is the same. Content and profile are therefore excluded as the source of the uniform +5.6 ms.
The one known asymmetry is that legs4h2's window also carried the other session's compile at 04:21 — and, as a
result of that same fixed data root, the A/B runs below must never overlap a live soak: starting one deletes the
profile the running app is using.

| leg 1 (60 min, 60 frames each) | `perf4h` | `legs4h2` | direction |
|---|---|---|---|
| `rendererActiveSlopeMBPerMin` — **the graded series** | **0.079728** | 0.261952 | **3.3× better — the retention fix works on its own target** |
| `overallActiveSlopeMBPerMin` | **0.117506** | 0.646958 | 5.5× better |
| `switchLatencyMs` p50 / p95 / max | **15.56** / 20.53 / 30.94 | 10.737 / 13.069 / **94.691** | tail 3× lower, floor 4.5 ms higher |
| `activeWorkingSetMB` p50 / max | 1582.79 / **1607.08** | 1534.82 / 1584.20 | ~+23 MB held |
| `postWarmupMB` → `finalActiveMB` | 1571.77 → 1579.93 | 1503.57 → 1560.39 | flatter, higher |
| CPU s/min, `msPerSwitch` | **7.039**, 355.61 | 2.488, 125.64 | **2.83× more CPU** |

**Provenance of the two slope rows.** Both were refitted here from `samples[].byType.renderer.workingSetMB` and
`samples[].totalWorkingSetMB` over each run's **own** leg-1 window (`legSlopes[0].observedFrom .. observedTo`,
60 frames on each side) with the harness's least-squares fit. The method is certified by reproducing stored values
exactly on three independent series — `perf4h` leg 1 (`0.079728` renderer / `0.117506` total), `perf4h` run level
(`0.099247` / `0.130035`) and `legs4h2` run level (`0.26137` / `0.409933`) — so it is the harness's own method,
not a lookalike. Note that the stored run-level values move as a live checkpoint accumulates: the numbers quoted
for `legs4h2` are final (its run ended), while `perf4h`'s run-level pair was `0.079728` / `0.117506` at leg-1 close
and reads `0.099247` / `0.130035` with leg 2 half done. Only the leg-scoped pair is a like-for-like comparator.

**Do not use a run-level slope as the comparator.** `legs4h2`'s run-level `overallActiveSlopeMBPerMin` is
**0.409933**, fitted across all 180 workload minutes while the burst volume changed twice; the harness refuses to
grade precisely that blend (`slopeOk = legRun ? null : …`, "a blend of regimes … grades nothing"). It is not a
leg-1 number, and using it understates the improvement by about a third (0.4099 against the true 0.646958). Its
per-leg slopes are 0.646958 / 0.525956 / 0.397676 for total and **0.261952 / 0.258899 / 0.280939** for renderer —
i.e. the leak was **regime-independent** on the graded series, which is the bisect's null result stated as a
number, and leg 3 still slopes 0.281 MB/min while injecting five lines in an hour.

**The slope gate is not graded on a leg run.** `slopeGateApplicable: false`, and a leg run that passes everything
else reports the harness's own name for it, `PASSED_SLOPE_NOT_GRADED`. So the improvement above is a
**measurement, not a passed gate**; this run's two graded failures are the peak (1607.08 > 1600) and the latency
percentiles (15.69 / 20.53 against 12 / 18).

**What the latency number is.** It is `performance.now()` bracketing `await rpc('antifan.switchTab', { tabId })` —
the full IPC round trip, not an app-internal timer. It therefore conflates host scheduling and transport with
handler work, and a uniformly slower host would inflate it exactly as observed (a ~+5 ms constant, with `min`
moving from 8.08 to 12.06). It cannot by itself separate host from app; that separation is what a same-bundle
control run is for.

## 4. CPU and GPU — the same work, 2.83× the cost, and where it sits

Per-component CPU over leg 1 (seconds counted inside the 59-minute leg; `scripts/analyze-soak-app-only.cjs` /
`recompute-soak-metrics.cjs`):

| component | `perf4h` | `legs4h2` | ratio |
|---|---|---|---|
| GPU process | **124.16** | 28.16 (own pid) | 4.41× |
| UI-surface bundle (`chrome:standalone+toolbar+frame-backdrop`) | **99.31** | 16.39 | 6.06× |
| Browser (main) | **59.31** | 32.19 | 1.84× |
| console host (pty child) | **49.61** | 8.58 (partial) | 1.48× (bounded) |
| four page renderers | **46.50** | 7.70 | 5.08× |
| Utility / pty agent / pty shell | 10.69 / 4.94 / 4.70 | ~0 | — |

124.16 s of a 3543.6 s leg is 3.5% of one core; 415.705 s of leg-1 CPU over 59.06 min is 7.039 s/min. Against the
comparator's 2.488 s/min that is the headline: **on identical injected work the app now costs 2.83× the CPU**, and
the cost is not per line of terminal output.

Volume is not the driver: the run's own leg 2 injected 4× the terminal lines and moved CPU **+0.8%** (7.039 →
7.098), and the comparator's leg 3 injected five lines in an hour and still cost 2.919 s/min. The cost is
per-minute baseline work.

### 4b. What the 62 MB warmup elevation is — and is not

Mean footprint over the 31 warmup frames of each run, by role:

| role | `perf4h` (MB) | `legs4h2` (MB) | delta | relative |
|---|---|---|---|---|
| renderer (5 procs) | 747.6 | 713.0 | **+34.6** | +4.6% |
| gpu (1) | 186.7 | 171.8 | **+14.9** | +8.7% |
| browser (1) | 228.0 | 216.1 | **+11.9** | +5.5% |
| utility (1) | 120.0 | 119.7 | +0.3 | +0.3% |
| other (7) | 286.9 | 286.7 | +0.2 | +0.1% |
| **total** | **1569.2** | **1507.3** | **+61.9** | +4.1% |

**All of it is Chromium-owned and proportional.** Every Chromium role moves by roughly the same 4–9% while the
seven non-Chromium processes move by under 0.2 MB combined — so this is a whole-tree scale factor (build or
commit accounting, or host state), not allocation: an app-object leak would concentrate in the renderer and leave
gpu and browser flat. The gap then **narrows** over the run rather than widening — +61.9 MB at warmup, +48.0 MB on
active p50 (1582.79 vs 1534.82), +22.9 MB on active max (1607.08 vs 1584.20) — which is the retention fix's own
signature measured against the comparator's growth. So the peak breach of **+7.08 MB** is a small margin riding on
a ~62 MB shift that this run's bundle cannot explain, and the control that settles it is a same-bundle run.

## 5. The switch-latency shift is a floor, not a tail

Both checkpoints keep their full `switchSamples` (dropped = 0), so the two runs compare by phase directly:

| phase | `perf4h` min / p50 / p95 / max | `legs4h2` min / p50 / p95 / max |
|---|---|---|
| warmup (n = 585 in both) | 12.49 / **15.75** / 20.99 / 34.85 | 8.29 / **10.68** / 13.26 / 32.10 |
| workload | 12.06 / **15.69** / 20.53 / 30.94 | 8.08 / **10.74** / 13.07 / 94.69 |

- `min` moves too (8.08 → 12.06): a constant additive cost on every switch, not a heavier tail.
- It is present in warmup at identical sample counts, at the run's lowest load: not drift, not a leak.
- Per destination, all six of this run's p50s sit at 15.1–17.0 ms while the comparator's six sit at 10.4–10.9 —
  uniform, so it is not a per-destination or per-page cost.
- The comparator's tail is **one sample**: its next-slowest switch is 25.33 ms, so `max 94.69` is a single stall at
  +48.8 min, not a distribution. This run's top three are 34.85 / 30.94 / 26.91 — flat by comparison — and its
  worst sits in **warmup** at +16.6 min, one more independent statement that this run's cost is not
  workload-triggered.
- Provenance trap for anyone reading mid-flight: the in-flight checkpoint carries a `finishedAt`
  (2026-09-21 08:10:29) that tracks the newest sample rather than the run's end. The run log shows leg 2 still open
  at that time, so `finishedAt` must not be read as completion.

## 6. What is established, and what is not

**Established (measured):** the retention fix works (leg-1 renderer slope 0.261952 → 0.079728, leg-1 total
0.646958 → 0.117506, on identical injected work); the stall tail
is gone (94.69 → 30.94 max); a fixed ~+5 ms cost appeared on every switch; CPU is 2.83× on identical work; the
cost is baseline-per-minute, not per-line; the GPU and UI-surface compositing are where the largest shares sit; the
peak-memory gate fails by 7.08 MB; the run carried a differently-built bundle than the comparator.

**Not established:** which change owns the CPU and the floor. Three terms moved at once — the bundle, the harness,
and the host — and this pair separates none of them on its own.

- The bundle delta is measured, not guessed, and it is **wider than the five files named earlier**: `src/` took
  **14** edits between **01:09:53 and 01:37:15** (`native-tab-host.ts`, `standalone.js`, `standalone-preload.ts`,
  `contracts.ts`, `toolbar.ts` and nine more), `git status` shows **13 tracked files modified** plus 20 untracked
  artifacts, and `.compiled` was written again at **01:37**, **04:21** and **06:16**. The comparator's own tree is
  therefore **not reconstructible** — its digest is null and incremental emits moved under it — so this is a
  cross-bundle pair in a way that cannot be narrowed further, which is exactly why the separating run below is
  required rather than optional.
  `toolbar.ts` (06:10, uncommitted) is the retention fix and *removes* work, so it predicts a memory rise and a CPU
  *drop* — the memory it does explain (the DOM it no longer rebuilds is memory it now keeps, which is why peak
  active memory ran ~23 MB higher), the CPU it does not.
- **The commit part of that delta is exact, and it points at one subsystem.** `HEAD` as of the 01:04 compile — the
  tree the comparator launched on at 01:41 — was `08c4d541` (00:32:54); `HEAD` now is `2697a28c` (01:31:21). So
  **exactly two commits** entered this run's bundle that the comparator's could not have had: `0f8c51ca` "badge MCP
  risk and honor highlight color" (a hub-titled commit that also rewrites `src/renderer/toolbar.ts`, +495 lines) and
  `2697a28c` "stop hung capturePage wedging guest canvas". Both are
  browser capture/pane code — the class that adds work on a switch — which is where a fixed per-switch cost should
  be looked for first. The capture/compositor group as a whole (`a25d9f99` "restore native view canvas background
  and remove DOM fill", `133c54fa` "refuse a capture whose view has no compositor surface", `d7c77d83`, `bee72187`,
  `462a48b4`, plus `2697a28c`) remains the only group in the delta that *adds* per-switch compositor work, and it
  predicts the shape seen: a fixed cost on every switch, GPU-weighted, present from minute one. The uncommitted part
  (14 `src/` edits, uncommitted at 01:41) is **not** reconstructible, which is the residue the separating run
  cannot remove either. `[INFERENCE]` for the attribution; the revision pair itself is measured.
- **The fixed +5.6 ms has a mechanism, and it was measured rather than guessed.** Per-switch latency is
  **independent of load and of time in both runs**: over 1753 workload switches `r(ms, CPU per minute) = +0.074`
  (16.18 ms in the lowest-CPU fifth against 16.51 in the highest), drift `+0.006 ms/min` across 90 minutes, and
  the comparator shows the same shape (`r = −0.024`, `−0.001 ms/min`, 3508 switches). A cost that ignores an 8×
  CPU range and 90 minutes of growth is a **constant step inserted in the switch path**, not work that scales with
  anything. `2697a28c` is that step: it removes the `isTemporarilyAttachedView` guard in **three** places — both
  branches of the present/activate path and inside `recyclePresentedLayer` itself — so activation now runs
  `recyclePresentedLayer` (a `removeChildView` + re-`addChildView`, i.e. a fresh DirectComposition visual) **on
  every switch**, where it previously skipped whenever a capture held the view or an attach-for-capture count had
  leaked. GPU-weighted, once per switch, load-independent, flat in time: the committed delta contains exactly one
  change with that shape. `0f8c51ca` is the second candidate and points at the same subsystem from the other side:
  it rewrites `src/renderer/toolbar.ts` by **+495 lines** in the UI-surface renderer, the process that owns this
  run's retention slope (`0.1236 MB/min`) and its `6.06×` CPU ratio. `[INFERENCE]` for the attribution; the guard
  removal, the revision pair and both correlations are measured.
- **The A/B that decides it is prepared, not scheduled on faith.** Two worktrees ready, each with a `node_modules`
  junction so no install is needed: `E:/Work/apps/AntiFan-wt-08c4d541` (`08c4d541` — both commits absent) and
  `E:/Work/apps/AntiFan-wt-0f8c51ca` (`0f8c51ca` — only `2697a28c` absent). A 30-minute workload leg discriminates a
  5.6 ms p50 shift; neither may run while this soak holds the machine.
- The host term is bounded but not excluded: the console host — which no Chromium compositor change can affect —
  moved 1.48× while the GPU moved 4.41×, so a host-wide slowdown does not account for +5 ms on a Chromium switch;
  the remainder sits on the bundle. The host's *external* load is measured for this run only — a sampler ticked
  every minute from 06:26:57 (so from before leg 1 opened at 06:50:29) and read ~2.9 GB held by 12 external
  processes, ~6 GB machine-free, no sustained saturation, and 32–42 cpu-s/min of external demand against the app's
  7.04–7.31 — and it is unrecorded for the comparator, because no such sampler existed on 09-20 01:41. The step is
  therefore bounded from the inside (pty children ~1.0×, GPU 4.41× in the same window), not by a two-sided load
  comparison.
- `.compiled`'s newest file only *looks* like the delta: `src/renderer/terminal-write-dispatcher.js` is tracked,
  unmodified, and merely re-synced from `src/shared/terminal-write-dispatcher.ts` at 06:16:57.

**The separating run that does not exist yet** is a worktree at the pre-01:04 revision, compiled there, run
against the *current* harness. That single run separates the bundle term from the harness term, and it is the only
run that can. It must not be started while this soak holds the machine.

## 7. Pending before this verdict is final

1. Leg 3 (`burst-off`) and recovery numbers; the graded final report `real-soak-8h-perf4h.json`.
2. `slopeGateApplicable` is **already answered for this run: `false`** — it is a leg run, so there is no graded
   full-window slope to wait for. The criteria that decide this run are the peak and the latency percentiles, and
   both already fail.
3. `app.getGPUFeatureStatus()` (compositing/video Hardware Accelerated) and the GPU process's per-leg CPU share in
   the same artifact as the CPU table, so a 4.41× GPU reading is reproduced or named as a path change.
4. The changelog entry (Phase 5).
