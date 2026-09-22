# Real 4 h soak verdict — `4hfix9` (bundle `2aacaa2c…`)

Run: 2026-09-22 01:40:41Z → 05:41:50Z (08:40:41 → 12:41:50 local), `--minutes 240`, exit code 1.
Payload: `real-soak-8h-4hfix9.json` (2,847,462 bytes). Sidecar: `real-soak-8h-4hfix9-recomputed.json`.
**Exit 1 is the harness's FAIL verdict, not a crash** — `executionOk: true`, `teardownOk: true`, and the process rode
the full 4 h 01 m under the retry supervisor with zero `attempt.stalled` events.

## Headline

**FAILED on two gates** — latency and peak memory. **Neither failure is evidence of a regression, and one of them
is not evidence of a defect at all:**

- **Latency** misses by **+12 % on p50 and +16 % on p95** at a measured host load of ~94 % on an 8-thread CPU, and
  the switch cost is shown below to be **workload-independent** — so it is a rate/tab-set cost, not a burst cost.
- **Peak memory** fails because the bound (1600 MB) sits **26 MB above where the app had already loaded before any
  workload began** (`initialLoadedMB` 1574.46) and the warmup fill adds ~69 MB. The app's renderers are **flat in
  the workload and recovery windows** (`+0.02 MB/min`).

## Gate table (bounds read from `FREEZE_SLO`, `scripts/benchmark-real-soak-8h.cjs:222-229`)

| gate | measured | bound | verdict |
|---|---|---|---|
| slope (leg run) | `null` — `slopeGateApplicable: false` | 0.35 MB/min | **not graded** |
| private slope (leg run) | `null` — `privateSlopeMeasured: true` | 0.15 MB/min | **not graded** |
| peak working set | `activeWorkingSetMB.max` **1670.30** | 1600 | **FAIL** |
| switch latency | workload p50 **13.487**, p95 **20.853** | 12 / 18 | **FAIL** |
| switch latency max | **152.674** (reported, not graded) | — | not graded |
| orphans | **0** (query OK) | 0 | PASS |
| execution | no error, no premature exit | — | PASS |
| teardown | not degraded | — | PASS |

The two slope gates report `null` **by design on a leg run** — one slope fitted across legs that ran different burst
volumes is a blend of regimes and grades nothing. Per-leg slopes are the measurement for this run, below.

**Bundle identity: `changedDuringRun: false`.** md5 `2aacaa2c11df5a9331ede42f7b0b4747`, 419 files, 9,255,060 bytes,
identical at start and end. The bundle the verdict grades is the bundle that ran. The graded bundle equals delivered
`HEAD` as of `3e6f7594`: the one runtime-relevant file that differed (`src/renderer/standalone.js`, dirty during
launch) was byte-identical to its `.compiled` copy and has since been committed.

## The leg bisect — the run's actual payload

All three legs closed at ~60 min with **switch count held constant and burst volume moved**:

| leg | burst lines | switches | app CPU s/min | ms/switch | Browser private Δ |
|---|---|---|---|---|---|
| 1 `baseline` | 35,700 | 1075 | **12.125** | **665.7** | +19.96 MB |
| 2 `burst4x` | 142,800 (**4×**) | 1080 | **12.770** | **698.4** | +13.08 MB |
| 3 `burst-off` | **5** (≈0) | 1077 | **12.099** | **663.5** | +10.46 MB |

Burst volume varies across a **28,560× range** (35,700 → 142,800 → 5) and **app CPU per minute is flat to within
5 %**; per-switch cost is flat to within 5 %. Confirmed independently by `recompute-soak-metrics.cjs`, whose CPU
block is an exact difference of cumulative per-process counters rather than a sampled rate
(`memory round-trip: AGREES`).

**Conclusion: the app's CPU and its per-switch cost are workload-independent at this tab set and this switch rate.**
`msPer1000BurstLines` collapses 20046 → 5282 → 142918800 across the legs because its *denominator* collapses, not
because the cost fell. In the quietest possible leg — 5 burst lines in 60 minutes — the app still spends
**12.099 s/min** and **663.5 ms per switch**. Whatever the switch path costs, the burst workload does not own it.

## Criterion 2 — app-owned memory

**The renderers do not grow.** `rendererActiveSlopeMBPerMin` = **-0.011668** (negative). Per window, from the
app-owned `processSeries`:

| window | app Tab sum private (LSQ) | Browser pid 11648 private (LSQ) |
|---|---|---|
| warmup (28 min) | **+1.21 MB/min** | +0.82 |
| workload (59 min) | **+0.02 MB/min** | +0.04 |
| recovery (29 min) | **+0.02 MB/min** | -0.12 |

**The entire growth is a warmup fill.** After warmup the app-owned series is flat to two decimal places, and it
falls in recovery. That is the shape of caches filling and then plateauing, not of a retention leak.

**The per-process measurement is under its bound, and the estimator matters.** The app-owned per-process maximum is
`appPrivateMaxSlopeMBPerMin` = **0.1096 MB/min** at pid 11648 (`Browser`), against the 0.15 bound — under it. It is
**not graded on this run**: `4hfix9` is a leg run, so `privateSlopeOk` and `slopeOk` are both `null`
(`benchmark-real-soak-8h.cjs:293-299`) and `isPassed`'s `slopeOk !== false` passes them through. The same bound
*is* verdict-forming on a single-leg run, where the value feeds `privateSlopeOk` -> `slopeOk` -> `isPassed` (`:318`);
here it is displayed only (`:2297`). Do not read `processOk: true` as this gate — `processOk` is the **orphan** gate
(`:314`, printed as `orphanSloSatisfied`). But the
same series' endpoint delta is `deltaPrivateMB` **39.77 MB over 179 min = 0.222 MB/min**, which is **above** 0.15.
What puts it under the bound is the least-squares fit on a decelerating curve, not the endpoints: measured
endpoint-to-endpoint the same series would breach. Anyone quoting "0.1096 <= 0.15" should quote the 0.222 alongside
it. Both are in the payload (`metrics.perProcessSlopes[0]`).

`activeRendererWorkingSetMB` is min 784.46 / p50 802.65 / **max 811.25** — a 27 MB spread over 242 samples.

## Criterion 3 — latency and its outlier

Workload p50 **13.487 ms** (bound 12) and p95 **20.853** (bound 18); warmup p50 15.34 / p95 25.273; all phases p50
13.745 / p95 21.468. The maximum, **152.674 ms**, is **reported and not graded** (`latencyMaxGated: false`), so plan
criterion 3's "max inside 35 ms" was stale against the source and is not a gate.

**The tail is a property of one page.** The harness prints it itself:
`Slowest Switch Destination: https://www.wikipedia.org (max 152.674ms, p95 26.192ms over 627 switches)`. Of the ten
slowest switches, all six above 90 ms are the same tab `f012e6f1-…` (wikipedia) except one, and they span all three
legs (`baseline#1`, `burst-off#3`) and both phases. So the outlier is characterised and reproducible — it is not a
one-off and not a phase-transition artifact. Whatever makes that page expensive to attach sits outside this plan's
scope; it is named here so it is not re-discovered.

## Criterion 1 — naming the process

Met by construction rather than by a parent-pid walk: `processSeries` carries `{pid, type, role, url,
workingSetMB, privateBytesMB}` per process per sample, and the report names the grower as
**`Browser`, pid 11648**. That matters because `samples[].byType`/`totalWorkingSetMB` is a **parent-pid walk that
can swallow non-app processes** (Windows reuses the pid of a dead parent) and the gates read that view.
`analyze-soak-app-only.cjs` was run over the full payload for this verdict, and the two foreign Electron trees
present on the host (pids 5704/16696 from 09-21 22:28; a second full app instance rooted at 28324 from 09-22 00:37,
all under `.antifan-data`, not the soak's `.antifan-soak-8h`) never appear in the app-owned series. Orphan query
returned **0** with `Query OK: true`.

## The load confound, quantified

The switch numbers were taken at **~94 % CPU on a 4-core/8-thread host** with 18 external processes, alongside a
resident population that predates the run: ~24 `node.exe` from a 09-21 22:28–23:44 session, a second full app
instance (00:37), plus the user's Chrome, Figma, Zalo and Orca. A separate post-fix A/B found the same switch band
at **9.621 ms (63.5 % load)** and **15.34 ms (94.4 % load)** — a ~1.5× swing carried by load at constant tab set,
URLs and switch interval. **The workload p50 of 13.487 ms is therefore an upper-bound reading, not a clean one**,
and the ~3.1 ms transport term between the app's own marks (12.042) and the harness's number sits inside it.

## What this run establishes, and what it does not

**Established:** the leg bisect executed as designed and answers its question — app CPU and per-switch cost are
**workload-independent** (flat across a 28,560× burst range). The app-owned renderer memory is **flat in the
workload and recovery windows** and grows only during warmup. No orphans, clean execution, clean teardown, no bundle
drift. The slow-switch tail is a single reproducible page.

**Not established:** that the two failing gates indicate a defect. The peak-memory gate cannot be passed by
retention work while the app loads at 1574 MB against a 1600 MB bound. The latency gate is being read at 94 % host
load with a known ~1.5× load sensitivity. **The load-matched discriminator** — rebuild the pre-fix bundle and
measure the same band at recorded load, controlling the app data root so the extra terminal PTY tree cannot confound
it — is the next decisive step and was deliberately **not** run before this verdict, because a recompile would have
invalidated the bundle being graded.

**Open, with evidence recorded:** the Browser process (pid 11648) is the only app-owned grower — +39.77 MB private
over 179 workload minutes, concentrated in warmup; if it grows in a `burst-off` leg from a fresh launch it becomes a
main-process retention signal rather than a cache fill. The extra terminal PTY tree costs ~82 MB of baseline
(`initialLoadedMB` +83.43 vs measured PTY working set +81.75) and is a confound in any bundle A/B that does not
control the persisted profile.
