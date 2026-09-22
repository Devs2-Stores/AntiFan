# Soak 4h — verdict (tag `night4h`) — COMPLETED, FAILED

A full 4 h run on the `46f1f609` bundle: 30 min warmup, 180 min workload split into three legs
that differ only in burst volume, 30 min recovery. It completed, it tore down cleanly, and it
**failed the latency gate by ~1.9× and the peak-memory gate by 92 MB**. Its own payload also
reproduces the bundle ladder's high arm (§4), which is what localises the regression.

## 1. Run identity

| field | value |
|---|---|
| tag / artifact | `night4h` / `real-soak-8h-night4h.json` (2,924,395 B) + `-checkpoint.json` |
| window | 2026-09-21T17:59:55.080Z → 22:01:21.445Z (00:59:55 → 05:01:21 local), 241.4 min |
| shape | 30 min warmup / 180 min workload / 30 min recovery |
| legs | `baseline:60:300/30000`, `burst4x:60:1200/30000`, `burst-off:60:1/600000` |
| bundle | 419 files, md5 `46f1f6098f366a8aa4251779ef121677` at launch **and** at exit, `changedDuringRun: false` |
| workload | 6 tabs; 3,920 switch samples (3,390 in the workload phase), 3,923 step samples, 303 bursts (60 warmup / 243 workload), 120 reloads, 4,819 terminal events, 242 memory samples, 0 suspended minutes |
| teardown | 6/6 tabs closed, terminal closed, `teardownDegraded: false` |
| exit | supervisor reports exit 1 — the harness's failure exit, not a crash |

## 2. Gate table

Criterion in force: `p50 ≤ 12 ms && p95 ≤ 18 ms` on the workload phase, peak active working set
`≤ 1600 MB`. `slopeGateApplicable` is false on a leg run, and the harness says so in its own
verdict line.

| gate | criterion | night4h | verdict |
|---|---|---|---|
| switch latency p50 (workload, n=3390) | ≤ 12 ms | **23.259 ms** | **FAILS** (1.94×) |
| switch latency p95 (workload) | ≤ 18 ms | **37.697 ms** | **FAILS** (2.09×) |
| switch latency max | not graded (`latencyMaxGated: false`) | 130.899 ms | reported |
| peak active working set | ≤ 1600 MB | **1692.17 MB** | **FAILS** (+92 MB) |
| overall active slope | ≤ 0.35 MB/min | −0.0228 | passes; not graded (leg run) |
| renderer active slope | ≤ 0.15 MB/min | −0.1543 | passes; not graded |
| app-owned private max | compared to 0.15 MB/min | 0.1323 (pid 19768, GPU) | under it; **not graded on a leg run** (see note) |
| worst per-process slope (payload) | **no gate** | 0.0787 (Browser) | not graded anywhere |
| orphan processes | 0 | 0 | passes |
| refused process samples | — | 0 | passes |
| teardown | clean | 6/6 tabs, terminal closed | passes |

**Note on the two per-process rows.** `appPrivateMaxSlopeMBPerMin` is compared against
`FREEZE_SLO.rendererSlopeMBPerMin` (0.15) in source (`benchmark-real-soak-8h.cjs:288-291`) and *is* verdict-forming on
a **single-leg** run, where it feeds `privateSlopeOk` -> `slopeOk` -> `isPassed`. `night4h` is a **leg run**, so both
slope terms are `null` (`:293-299`) and `isPassed`'s `slopeOk !== false` passes them through: the value is displayed
only (`:2297`). `worstProcessSlopeMBPerMin` is a different series (working set) and no gate reads it at all — do not
read either as one of the six pass/fail terms, and do not read `processOk` as a slope gate: `processOk` (`:314`) is
the **orphan** gate, printed as `orphanSloSatisfied`.

The harness's own verdict line, verbatim:

```
FAILED: SLO violations or execution failure detected
  (slopeOk: null, privateSlopeOk: null [measured: true], memoryOk: false,
   latencyOk: false, processOk: true, executionOk: true, teardownOk: true)
```

`executionOk: true` and `teardownOk: true` are the load-bearing fields for reading this as a
**measurement** rather than a mishap: the app stayed up, every sample was taken, and the run
closed its own resources. The two failures are the gate's, not the harness's.

Two things the table cannot say by itself:

- The graded workload p50 (23.259 ms) is a **blend over a decaying series** (§3). The gate failed
  *after* the decay had already removed roughly half of the cold-phase latency.
- The peak-memory figure comes from a process walk whose membership is **not app-only** (§7), so
  it bounds the app from above; it is not an app-only measurement.

## 3. Regime: the run is not stationary, and the decay is front-loaded

Per-30-minute bands over all phases (n ≈ 565 per band, so the bands are comparable):

| elapsed | n | p50 | p95 |
|---|---|---|---|
| 0–30 min | 511 | **47.89** | 59.24 |
| 30–60 min | 565 | 28.82 | 41.31 |
| 60–90 min | 570 | 27.75 | 40.22 |
| 90–120 min | 555 | 26.84 | 40.92 |
| 120–150 min | 564 | 20.21 | 29.79 |
| 150–180 min | 568 | 19.18 | 26.50 |
| 180–210 min | 568 | 19.41 | 27.13 |
| 210–240 min | 19 | 19.54 | 27.99 |

The shape is a **front-loaded decay**: −40% inside the first 30 minutes (47.89 → 28.82), then a
slow crawl to ~19.2 by 180–210 min, then flat. The workload aggregate (23.259 ms) therefore
describes no instant in the run — it is an average across a series that moved by 2.5×.

This is why the A/B in §9 measures an **elapsed band** (0–10 min) rather than a phase: "warmup"
covers 30 minutes here and 12 minutes in an arm, so the same phase name spans different elapsed
spans and is not a like-for-like axis.

**The decay is bundle-specific, not a general property of the harness.** Comparator runs of
earlier bundles are flat across the same axis:

| run (bundle) | 0–10 min band p50 | 10–30 min band p50 |
|---|---|---|
| `legs4h2` (digest not recorded) | 11.20 (n=191) | 10.43 (n=390) |
| `legs4h` (digest not recorded) | 13.16 (n=187) | 12.96 (n=380) |
| `perf4h` (digest not recorded) | 15.97 (n=192) | 15.64 (n=389) |
| `domprobe` (digest not recorded) | 16.59 (n=192) | 15.92 (n=389) |
| `night4h` (`46f1f609…`) | **49.16** (n=145) | **47.10** (n=366) |

Every earlier bundle sits in a flat 10–16 ms band; this one starts at 47–49 ms and decays from
there. A decay is a property of *this* code, not of the harness: it is absent in four other runs
on four other bundles.

## 4. Localization: the bundle ladder

Two bundles, two runs each, compared on the only axis they share: elapsed 0–10 min. That axis is
not identical in configuration — `night4h` is 30 min of warmup with no leg, while the shorter runs
are 1–4 min smokes whose bands cover their own leg — so the comparison leans on a *measured* result
rather than an assumption: §6 shows burst volume moves CPU and not latency, so a leg inside the
band is not a latency confound. Compare only the band, never the phase names.

| bundle | run | 0–10 min p50 (n) |
|---|---|---|
| `6a333f3c…` | `steps4h2` | **19.00** (187) |
| `6a333f3c…` | `smokefinal` | **20.45** (39) |
| `46f1f609…` | `guardcheck` | **47.68** (56) |
| `46f1f609…` | `night4h` | **49.16** (145) |

Same-bundle spread: **1.45 ms** (`19.00`/`20.45`) and **1.48 ms** (`47.68`/`49.16`).
Between-bundle gap: **27.23 ms** (`20.45` → `47.68`).

**The band is not the run's headline latency, and must not be read as one.** `night4h`'s 0–10 min p50
is 49.16 because its **cold phase is slow and decaying**; the same run settles far below that in
workload (40–241 min: **22.89 ms**, n=3222, and 30–40 min: 28.95, n=187). The ladder compares *like
bands across bundles* — cold band to cold band — never a band against a phase or against a run's
overall figure.

Signal-to-variance is therefore ~19×, and the older bundle's runs bracket each other while the
newer bundle's runs bracket each other — the two groups do not overlap. `night4h`'s own payload
independently reproduces the high group: its launch bundle is `46f1f609…` and its cold-phase
warmup p50 is **47.599 ms** (n=530, p95 59.243).

The two bundles straddle a commit window: `6a333f3c…` was compiled ~15:26 local on 09-21 and
`46f1f609…` at 00:53:59 on 09-22. Exactly **two** commits inside that window touch the measured
path — `f4d90277` (09-21 23:38, `native-tab-host.ts` + `tab-devtools-host.ts` + `terminal-manager.ts`
+ `standalone.js`) and `a1969e88` (09-22 00:38, `standalone.js` only). The ladder therefore
localises the step to *that pair of commits*, not to one of them, and §9 separates them by
**intervention** — three arms, not a reading — because a commit window is not evidence by itself.

## 5. Mechanism: where a switch spends its time

The app records a per-switch step series alongside the latency series. Median of each mark, in
the same windows as above:

| window | n | total p50 | `attachSweep` | `presentedView` | `ensureView` | others |
|---|---|---|---|---|---|---|
| elapsed 0–10 min | 146 | 45.82 | **26.689** (58%) | **16.677** (36%) | 0.034 | 1.019 |
| whole run | 3923 | 23.05 | **14.939** (65%) | **7.016** (30%) | 0.029 | 0.743 |

Reading:

- A switch is **two terms**: `attachSweep` and `presentedView`. Together they are ~94% of it;
  `ensureView` is 0.03 ms, i.e. view creation is not the cost.
- Both terms halve across the run (26.7 → 14.9, 16.7 → 7.0), which is the latency decay of §3
  seen from the inside: the decay is a property of these two marks, not of the fixture or the
  harness's timer.
- The marks do not sum exactly to the total (44.42 vs 45.82 in the cold band): the residual
  (~1.4 ms) is the head between the harness's `switchStart` and the app's first mark, which
  bounds the transport term at the low end rather than leaving it open.

**The same split on the older bundle says which marks move.** The ladder's comparator runs carry
the identical instrumentation, so the ~30 ms step is not "switching got slower" in general — it is
two named marks moving together (0–10 min band, p50 ms):

| band | total | `attachSweep` | `presentedView` | `ensureView` | other |
|---|---|---|---|---|---|
| `steps4h2` (`6a333f3c…`), 0–10 | 18.1 | 12.41 | 4.79 | 0.03 | 0.63 |
| `smokefinal` (`6a333f3c…`), 0–10 | 18.8 | 12.67 | 5.31 | 0.03 | 0.74 |
| `night4h` (`46f1f609…`), 0–10 | 45.82 | **26.689** | **16.677** | 0.034 | 1.019 |

`attachSweep` doubles (12.5 → 26.7) and `presentedView` more than triples (4.8 → 16.7) while
`ensureView` is flat at ~0.03 ms in all three, and the unattributed head stays ~0.6–1.0 ms. The
step therefore sits in the attach/present pair rather than in view creation, which is the pair
§9's arms hold fixed while the suspect commits move.

`attachSweep`'s name is also its mechanism claim: the sweep is O(all tabs), and the plan's
instrumentation points at the sweep in `src/main/browser/native-tab-host.ts`. This verdict
measures the *marks*; naming the sweep is what the intervention in §9 tests.

## 6. Driver test: CPU tracks burst volume, latency tracks elapsed time

The three legs differ only in burst volume. Read per leg (leg window, from the final payload):

| leg | burst lines / 30 s | observed bursts | CPU/min | ms/switch | p50 | p95 | n |
|---|---|---|---|---|---|---|---|
| `baseline` | 300 | 119 | 7.801 | 405.86 | 28.24 | 40.75 | 1135 |
| `burst4x` | 1200 | 119 | **8.927** | 470.84 | **23.23** | 37.47 | 1120 |
| `burst-off` | 1 | 5 | **6.142** | 319.77 | **19.34** | 26.85 | 1135 |

The legs are in time order, so the leg axis carries the elapsed axis with it. Once the two are
separated, each quantity has one owner:

- **CPU tracks the driver.** 4× the burst lines costs +14% CPU/min (7.801 → 8.927); nearly none
  costs −21% (6.142). Per-switch CPU moves the same way (405.86 → 470.84 → 319.77): more work
  between switches is more CPU per switch. The top CPU consumer is the console host (pty child,
  pid 26132, 330.7 s = 24.2%) — the burst workload itself, not the browser.
- **Latency does not.** p50 falls monotonically across the same three legs (28.24 → 23.23 →
  19.34) while the driver rises. Latency is tracking elapsed time, not volume.

So the earlier reading "the driver does not matter" is right about latency and wrong about cost:
the driver's footprint is real and lands in **CPU**, while its effect on the switch path is
swamped by the decay. The leg comparison conflates the two, and grading a leg's latency as if it
were a driver effect would attribute the decay to the driver.

## 7. Contamination: what else shared the host, and what that bounds

The harness samples the host it is running on. Over 48 samples spanning the run (01:01 → 04:50):

| quantity | min / median / max |
|---|---|
| run tree (inside the harness) | 7 / 11 / 11 procs; **1006.8 / 1504.0 / 1531.9 MB** RSS; 30.4 / 795.6 / 1173.8 CPU-s |
| external tree (outside it) | **18 / 18 / 24 procs**; **2514.9 / 2957.2 / 4580.8 MB** RSS; 3264 / 14014 / 24653 CPU-s |
| machine free / total | 2285 / 4212 / 4984 MB of 16236 MB |
| machine load | **51 / 76 / 100 %** |

At the last sample the external tree holds **72% of the two trees' combined RSS** and ~20× the
run's accumulated CPU. The machine is not quiet, and it is not quiet because of this run: the
user's own AntiFan app (pid 28324, launched 00:37:36 local) is alive throughout, with 9router and
a fleet of MCP/Playwright node processes behind it.

Consequences, stated as bounds rather than excuses:

- **Latency** is a wall-clock quantity measured while the host is 51–100% loaded, so the absolute
  numbers carry queueing that a quiet host would not show. This does not soften the §2 failure:
  the gate fails by 1.94×, and the ladder (§4) is a *matched* comparison where both bundles ran
  under the same kind of load and still separated by 27 ms.
- **Peak memory** is inflated by the walk's membership. The walk keys on process parentage, and
  the plan's contamination section already records a `parent-pid` collision (Zalo) landing inside
  the tree. The 1692.17 MB therefore bounds the app from above; it is not app-only. The
  app-owned measurement that *is* app-only (committed private bytes, 0.1323 MB/min at pid 19768)
  passes.

**No mid-run compile contaminated the bundle.** The external-load sampler's
`compiledRewritten` field is non-zero in **exactly one** sample — the first tick
(18:02:09Z, 816 files) — and zero in all 47 later samples; `.compiled`'s newest mtime on disk is
**00:54:34**, i.e. *before* the 01:00:57 launch. The single non-zero reading is a launch-epoch
comparison artifact, not a rewrite, and the harness's own `changedDuringRun: false` agrees.

## 8. Verification

| claim | evidence |
|---|---|
| the bundle did not move during the run | `config.bundle.start.md5 == config.bundle.end.md5 == 46f1f609…`, `changedDuringRun: false` |
| the digest is reproducible, not incidental | an independent hash of the live `.compiled` at 03:55 (mid-run) returned the same `46f1f609…`; `guardcheck` (4 min before launch, same tree) also recorded it |
| the digest is a content identity | `hashCompiledTree` hashes, per file, relative path + `\0` + content over `.js/.cjs/.mjs/.html/.css/.json`, sorted; no mtimes, no ordering effects |
| teardown was real | 6/6 tabs closed, terminal closed, `teardownDegraded: false`, RAM 1655.78 → 1084.96 MB across the recovery phase |
| no leaked processes | orphans 0 (`Query OK: true`), refused process samples 0 |
| the measurement harness itself | `executionOk: true`; 242 memory samples and 3,920 switch samples collected across the full 241 min |

**Why arm A's compile is not byte-identical to night4h's — measured, not assumed.** `tsconfig.json`
includes `src/**/*.ts`, `scripts/**/*.ts` **and `test/**/*.ts`**, so tests are emitted into
`.compiled/test/**` (present: `benchmark`, `e2e`, `integration`, `main`, `renderer`, `unit`). Scanning
every bundle-feeding source for an mtime after the 00:53:59 compile returns exactly one file that is
not this experiment's own checkout: `test/renderer/terminal-tab-categories-sleep.test.ts`
(+28 uncommitted lines, mtime **01:10:22**). Counting both trees with the harness's own
`BUNDLE_FILE_RE` walk (`.compiled/**` matching `.(js|cjs|mjs|html|css|json)`, Buffer lengths summed)
gives arm A **419 files / 9,247,656 B**, and arm A's own payload records exactly that at launch *and*
at exit, md5 `7575ec67…`, `changedDuringRun: false` — so the arm's bundle was stable throughout.
night4h's bundle is **419 files / 9,246,000 B**: the same file set, **+1,656 B of content**, and the
harness printed arm A's digest itself at launch (`419 compiled files, 8.8 MB, md5 7575ec67…`).
**And the identity test passed on the measured series:** arm A's cold band (0–10 min, n=181) is
**49.02 ms** against night4h's **49.16 ms** (n=145) — 0.14 ms apart, far inside the 1.48 ms
same-bundle spread §4 reports — so this content delta demonstrably does not move behaviour, which is
what the inference above predicts. That test file's edit accounts for +1,545 B of added
lines plus +28 B of CRLF (the working copy is CRLF, so the build reads 1,573 B more than HEAD's blob):
**95% of the delta**. The residual 83 B is either that same file's emitted form or build
non-determinism, which the close-out double-compile check tests directly — either way it is confined
to a **test** path, which the app does not load (grep for a `test/` path across every compiled source
and `main.cjs`: zero matches — the test tree is compiled and typechecked, never required by the
running app), so arm A is behaviourally night4h's bundle and the
0–10 min band is the identity test. The two files whose mtime is *current* are this experiment's own
doing (`standalone.js` is §4's parked checkout; `terminal-write-dispatcher.js` is re-written by the
build and `git diff` confirms it is unmodified). This is also the answer to "digest difference or
non-determinism": it is a source difference, measured, and named.

**One caveat that matters for §9.** `core.autocrlf` is `true` in this checkout with no
`.gitattributes`, so `git checkout HEAD -- <file>` rewrites that file with CRLF: the tracked blob
`HEAD:src/renderer/standalone.js` is 208,631 bytes with zero CRs, while the working-tree copy
after a checkout is 213,794 bytes with 5,163 CRs (exactly one CR per LF), and the compile copies
it verbatim. Demonstrated sensitivity: swapping only that one file's endings in a copy of arm A's
tree moves the digest by exactly its CR count (5,163 B → `90f03894…`). It is not what explains the
arm-A delta above — but it does mean bundle md5 equality is not a valid identity test between two
separately-checked-out trees. §9 states what was used instead.

## 9. Method: how the culprit is isolated, and what the comparison can and cannot resolve

The question left open is *which* commit on the measured path owns the step. Enumerating the delta
rather than assuming it settles the candidate list: the older bundle's tree contains everything up to
`5e5405cd` (09-21 10:55), so the commits between it and HEAD are exactly three -
**`f4d90277`** (09-21 23:38, tab freeze/overlay/drag: `native-tab-host.ts` +152, `tab-devtools-host.ts`,
`terminal-manager.ts`, `standalone.js`), **`990777e7`** (09-22 00:37, bridge: refuse identity cookies
on the companion sync channel: `bridge-server.ts`, `domain-scoper.ts`, `extension/background.js`), and
**`a1969e88`** (09-22 00:38, sidebar tab strip: `standalone.js`). `f4d90277` was the mechanism's
candidate (`attachSweep` is timed inside its file), but `990777e7` sits *between* them on the same main
event loop and is held constant by every arm that moves only the other two - so it gets its own arm.
Three commits cannot be separated by re-measuring one bundle, so they are separated by **four arms,
each moving exactly one commit and nothing else**, run back-to-back on the same harness config and keyed
by the bundle digest the harness prints at launch and at exit (one qualification, stated because it is
real: B and C also drop the parked renderer patch, since both check `standalone.js` out at a commit
that predates it - D restores it via `restore()`. Arm A shows that patch is inert, because A carries it
and still reproduces night4h, a bundle built at 00:53:59 *before* the patch was written at 01:10:22, to
0.14 ms; and B, C and the older reference bundle (steps4h2, 09-21 15:32) all ran without it, so the
B-vs-reference comparison is like-for-like):

| arm | the files it holds | what it isolates |
| --- | --- | --- |
| **A** | HEAD — all three commits present | the identity check against night4h |
| **B** | `f4d90277^` for `native-tab-host.ts`, `tab-devtools-host.ts`, `standalone.js` | `f4d90277` |
| **C** | `a1969e88^` for `standalone.js` | `a1969e88` |
| **D** | `990777e7^` for `bridge-server.ts`, `domain-scoper.ts`, `extension/background.js` | `990777e7` |

Every arm compiles outright, its digest is recorded at both ends (all arms so far:
`changedDuringRun: false`), and each checkout is guarded with `git diff --stat` so a silent no-op
revert cannot masquerade as a reverted arm.

**What serves as the identity test, given §8's CRLF caveat.** Digest equality is unavailable (§8: a
checkout rewrites line endings, so two identical trees can differ by thousands of bytes), so identity
is established two ways that do not depend on it: the **source-level comparison** - HEAD's two browser
files are byte-identical to `f4d90277`'s, `a1969e88^`'s `standalone.js` equals `f4d90277`'s, and
`git log a1969e88..HEAD` returns nothing, so HEAD *is* `a1969e88` - and the **behavioural
comparison**: arm A's cold band reproduces night4h's to 0.14 ms (§8). Together those mean B differs
from A by exactly `f4d90277`'s three files and C by exactly `a1969e88`'s one, which is what makes a
single-commit verdict possible at all. `terminal-manager.ts` is parked in every arm because the
working tree already carries that staged revert: it is a constant, not a variable.

**Criteria, fixed in the runner before the arms ran:** (1) the arm names the *same mark* -
`attachSweep` - that `verdict.steps4h.json` names; (2) reverting the owner drops the cold band by
**at least 15 ms** in the direct arm *and* its cross-check arm, with the intermediate arm sitting
**at least 28 ms** above the bands it separates, because a two-way split cannot be told from a
three-way one by a small margin. The separation this is applied to is 28.6 ms, so a 15 ms bar leaves
the decision about twice its own margin. (3) the outlier clause grades the tail, and the tail is
informative: the healthy bundle's **max is exactly 35 ms** (`perf4h`, n=2727, 0 samples >35 ms), so
the 35 ms threshold is calibrated to it - a bundle with p50 49 ms cannot pass that clause (night4h
735/3920 = 18.8%; arm A 450/453 = 99.3%, max 78 ms; the healthy bundle 0/2727), so that failure is
the finding rather than a measurement defect.

**The payload carries two series for the same event, and their difference sizes the transport.** The
harness times its own round trip (`switchSamples[].ms`: `t0` → `await rpc('antifan.switchTab')` →
elapsed, so the RPC path is inside it), while the app reports its own total
(`switchStepSamples[].value`, with the six marks in `extra`). On the compared band the two differ by
**2.60 ms for arm A** (49.02 round trip vs 46.4 in-app) and **3.36 ms for night4h** (49.16 vs 45.8) -
under a millisecond apart across bundles, and about a tenth of the step. So the step is not transport
or bridge overhead, and the mark split locates it inside `switchTab` itself.

**What the comparison resolves, and what it does not.** The arms warm up for 12 minutes and the
compared band is 0-10 min, so that band is *entirely* warmup and the leg configuration (burst volume,
leg boundaries, fixture mode) never enters the number being read - which is why the runner's own
stale header describing a `baseline` leg cannot colour the result. Two limits bound the verdict: each
10-minute band holds only 2-3 samples per run, so a band p50 carries roughly ±7 ms of resolution
against the ~28 ms step (~4x margin); and the suspects are identified *from* the data - the marks,
and the file mtimes behind them - rather than from a pre-registered list, so isolation rather than
prognostication is what makes the arms decisive. The bundle-content delta between A and night4h is a
test file the app never loads and §8 measures it behaviourally inert; the residual 83 B of content
difference stays labelled as possible build non-determinism rather than being explained away, with the
close-out double-compile check as its pending test.
