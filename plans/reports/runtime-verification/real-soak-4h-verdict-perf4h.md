# Soak 4h — verdict (tag `perf4h`) — ABORTED

Supersedes `real-soak-4h-verdict-perf4h-DRAFT.md`. The operator stopped the run; there is no graded final payload. Every number below is from `real-soak-8h-perf4h-aborted-prefix-20260921-0840.json` unless named otherwise.

## 1. Run identity

| | |
|---|---|
| run | `scripts/benchmark-real-soak-8h.cjs`, tag `perf4h`, `--minutes 240` |
| launched | 2026-09-21 06:20:18 local (`startedAt` 2026-09-20T23:20:18.658Z) |
| aborted | 2026-09-21 08:40:30 local (`finishedAt` on the in-progress checkpoint 2026-09-21T01:40:30.128Z) |
| observed | 30 min warmup + 60 min `baseline` (closed) + 49.86 min `burst4x` (open) = **109.1 min workload** |
| unrun | remainder of `burst4x`, all of `burst-off`, 30 min recovery |
| samples / switches | 141 / 2727 |
| artifact | `real-soak-8h-perf4h-aborted-prefix-20260921-0840.json` (`status: aborted`). Copied from the in-progress checkpoint so no reader mistakes it for a live run. No `real-soak-8h-perf4h.json`. |
| probe | `config.appArgs` is `[]` |

## 2. Gate table (checkpoint, not a completed run)

The switch-latency criterion in force is `p50 ≤ 12 ms && p95 ≤ 18 ms` on the workload phase. `slopeGateApplicable` is false on a leg run.

| gate | criterion | checkpoint | note |
|---|---|---|---|
| renderer memory slope | ≤ 0.15 MB/min | 0.1185 | reported, **not graded** (`slopeGateApplicable: false`) |
| switch latency | p50 ≤ 12 and p95 ≤ 18, workload | **p50 15.723 / p95 20.656** (max 30.94) | **FAILS** |
| peak active memory | ≤ 1600 MB | **1607.08** | **FAILS** |
| orphans | 0 | 0 | passes |
| verdict field | — | `FAILED` | checkpoint, not a final grade |

Two readings of the latency gate, both true:

- Under the criterion in force now (p50/p95), this run fails where comparator `legs4h2` leg 1 passed (10.737 / 13.069).
- Under the 09-19 max ≤ 35 criterion, this run passes (30.94) and the 09-19 2h run failed (42.1). The tail is gone; the floor moved up.

## 3. What the aborted run did prove

Against `legs4h2` leg 1 (identical schedule, 119 bursts / 35,700 lines):

- Renderer slope **0.0797 vs 0.262** on the closed baseline leg — the retention fix holds on its target.
- Switch p50 **+5.6 ms** vs that comparator (15.56 vs 10.74 on the draft's leg-1 pair; checkpoint-wide 15.72). Load- and time-independent: a **constant step in `switchTab`**, not scaling work.
- Peak working set 1607.08 MB — no headroom under the 1600 MB gate.

`refusedProcessCount` 0→1 is **not** a foreign Electron tree learned late. Across 141 samples it is 1 on **exactly one** sample (`python.exe`, 18.58 MB, sample index 1) and 0 on the other 140. Seeding a pid manifest from sample 1 would have recorded a transient. Dropped.

## 4. Mechanism claim retracted

`2697a28c` (`git show`: 13 lines in `native-tab-host.ts`) only changes behaviour **while an attach-for-capture count is held** (`else if (!isTemporarilyAttachedView)` → `else`, and the skip inside `recyclePresentedLayer` removed). A plain soak switch does not hold a capture, so that commit **cannot** be the +5.6 ms constant step. The plan's "conditional recycle" A/B was written on that false premise and is not the next patch.

The next measurement that can name the step is the `switch-steps` row (`ensureView`, `attachSweep`, `layoutBroadcast`, `throttle`, `invalidateFocus`, `presentedView`), now emitted by `NativeTabHost.switchTab` when `ANTIFAN_BENCHMARK=1` (the soak always sets it) and collected as `switchStepSamples`. The aborted run predates that instrument; its aggregate `switched` number cannot attribute the step.

## 5. Applied after the abort (working tree, not on the measured bundle)

| item | where | proof |
|---|---|---|
| Affinities in the broadcast payload (Open 1) | `native-tab-host.ts` `terminalAffinities: this.buildTerminalAffinityMap()`, preload parse, `standalone.js` uses delivered map and only invokes `getTerminalAffinities` when the payload omits it | already in the uncommitted `src/` diff; invoke-per-broadcast path is the fallback only |
| `switchTab` sub-step timer (Open 2) | `markSwitchStep` + `recordBenchmark({ surface: 'tabs', name: 'switch-steps' })` | `native-tab-host-presented-view` **7/7** (row emitted with six finite keys when `ANTIFAN_BENCHMARK=1`; production path emits none) |
| Harness ingest of those rows | `createBenchmarkStreamIngest` keeps `tabs`/`switch-steps`; `buildReportPayload` exposes `switchStepSamples` (`[]` if missing, never omitted) | `soak-payload-contract` **29/29**; ingest case: switch-steps collected, aggregate `switched` still dropped, history unchanged |
| Analyzer section | `printSwitchSteps` | missing field → `not collected`; synthetic one-row payload prints the six-step table with share of mean |

`npm run compile` exit 0 after the timer landed.

## 6. Not run

A replacement 4h soak is **not** started. The user's own app tree (pid 16884, profile `E:\Work\.antifan-data\Profile`) is still alive; the harness `rmSync`s `E:/Work/.antifan-soak-8h` on launch; overlapping a live soak with a second instance on this host is the contamination the plan already recorded. The next 4h run needs the machine free and will be the first to carry `switchStepSamples`.
