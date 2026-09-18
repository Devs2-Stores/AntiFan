# Test Report — 2026-09-19 — Full end-to-end suite (terminal-daemon-and-throughput)

Scope: the current working tree of `E:/Work/apps/AntiFan` (pending change set = terminal-daemon
sources + probe/stage scripts + tests; nothing else modified). Host: Windows 11, i5-9300H, E: 108 GB
free, C: 6.7 GB free. Full pipeline = `npm test` (`scripts/run-test-pipeline.mjs`, 13 lanes) plus the
daemon probe chain, plus a live product-surface MCP drive against the running app.

## Test Results Overview

Pipeline run (13 lanes): **10 passed, 3 failed** — `PIPELINE_EXIT=1`.

| Lane | Result | Time | Note |
|---|---|---|---|
| audit | passed | 7.0 s | |
| plans:check | **failed** → fixed → pass | 2.1 s | plan-tree status token (`in_progress` vs `in-progress`); re-run `npm run plans:check` exit=0 |
| compile | passed | 9.9 s | |
| test:canary | passed | 40.8 s | |
| test:fast | **failed** | 65.5 s | `test/unit/check-plans.test.mjs:106` (same token); now green — remaining red is the goal-runner case below (green when the same file set is serialized) |
| test:site-clone | passed | 22.0 s | |
| test:integration | passed | 2.7 s | |
| test:main | passed | 104.4 s | 1341 tests, 1339 pass, 0 fail |
| test:e2e | **failed** | 20.0 s | 6 tests, 5 pass, 1 fail — `mcp-industrial-overhaul` |
| test:terminal-transport | passed | 12.9 s | |
| test:terminal-rename | passed | 10.7 s | |
| test:mcp-dispatch-hub | passed | 11.9 s | |
| test:toolbar-qa-hub | passed | 12.2 s | |

Daemon probe chain: **all green** (see Evidence). Live product-surface MCP terminal drive: **green**.

### E2E verdict by surface — two lanes, never collapsed into one line

| Lane | Configuration | Result |
|---|---|---|
| (a) **Shipping / production** | no env, real resolution | **daemon never boots** — `mode=in-process reason="no staged daemon bundle"` (issue 1) and nothing invokes it (issue 2); the app serves terminals in-process |
| (b) **Pinned probe** | data root aligned via env | **daemon lifecycle fully green** — spawn chain L1/L2/L3, reattach 21/21, host survival, RPC surface, 38/38 call coverage |

The live product-surface MCP drive above ran on lane (a): **in-process surface green; daemon path
unexercised in shipping config**. It validates the terminal surface the user actually has **today**,
through the in-process manager, and says nothing about the daemon leg. In shipping configuration that leg
is not "passing" — it is **unverified**, because it never boots (1) and is never invoked (2). No single
"E2E passed" claim is made for it.

## Coverage Metrics (probe-based; repo has no line-coverage instrument)

| Metric | Value | Threshold | Status |
|---|---|---|---|
| GUI→proxy method coverage | 33/33 methods, 38 live calls, 0 failures | 100 % of surface | PASS |
| Daemon re-attach checks | 21/21 (phase 1: 10, phase 2: 11) | all | PASS |
| Host survival (relay killed) | host+child alive, heartbeat advances | all | PASS |
| Staged-host RPC | authenticate, RPC surface, prompt-gated input | all | PASS |
| Persist cost | 16 sessions / 16.5 MB → warm 113.6 ms, main-thread join 104.5 ms | measured, not asserted | INFO |

## Failed Tests

### `test/e2e/mcp-industrial-overhaul.test.ts` — live Electron MCP smoke (Milestone 3 latency)
- **Error**: `AssertionError: max latency must stay under 1000ms - one heartbeat interval (got 1150.8ms)`
- **Evidence**: `[Storefront Benchmark Metrics] 20 calls: mean=71.8ms, p50=13.0ms, p95=46.4ms, max=1150.8ms`; samples in call order show the stall at **index 10**. Re-run alone: `max=863.6ms` at **index 12** → fails the separate `no dispatch may take a half-second` gate. 2/2 isolated runs red; also red inside the lane (18.2 s).
- **Cause**: one identical `anti.inspect.dom` dispatch per 20 stalls ~0.9–1.2 s while p50 stays 13 ms and the outlier index moves — host/scheduling tail, not a heavier call type (all 20 calls are the same method, warm-up excluded). Live renderer `pid 17840` was pegged at 175 % CPU during both runs.
- **Gate margin**: the max criterion is zero-margin by construction — `STALL_ENVELOPE_MAX_MS = HEARTBEAT_MS`
  (`scripts/smoke-mcp-industrial-e2e.cjs:513`) with `HEARTBEAT_MS = 1000` injected as
  `ANTIFAN_HEARTBEAT_MS` (:297, :312). The two observed outliers (1150.8 / 863.6 ms) bracket exactly that
  interval, so any ~1 s host hiccup fails it regardless of dispatch health.
- **Mechanism excluded**: the heartbeat cannot block a dispatch. It runs on its own WebSocket with its own
  `heartbeatBusy` guard (`scripts/antifan-omp-mcp.cjs:2424-2558`); dispatch is a separate path,
  `CallToolRequestSchema` (:2584) → `invoke()` (:2147) → `invokeCore()` (:569); `heartbeatWs` is referenced
  nowhere outside the heartbeat block, so there is no shared socket, no shared await, no mutex. Causality
  therefore runs **calibration → gate** (the max was *defined as* one heartbeat interval), not
  heartbeat → stall.
- **Fix**: two independent channels, neither one "relax the gate": (a) give the max criterion real margin
  over the heartbeat interval (or make it p99-based over a larger sample) so a single host hiccup is not a
  red mark; (b) re-run quiesced and, if the ~1 s tail persists, break the slow dispatch into phases
  (transport vs. DOM read). Keep the p50/p95 gates as they are.

### `test/unit/goal-runner.test.mjs` — `loses at most one unit of work when killed mid-phase` (inside `test:fast`)
- **Error**: `AssertionError: runner never completed two units (stalled 118470ms and exhausted the hard budget):
  entries=5 verdicts=["PASS","pending","pending","pending","pending","pending"] heartbeatAgeMs=118540
  runnerAlive=no-lock last=[unit-verdict:u1=PASS@19:02:27.149Z unit-start:u2@19:02:27.182Z
  unit-verdict:u2=PASS@19:02:27.594Z]` (`fast-alone.log:2259`; same case red in the pipeline run).
- **Evidence**: this is **runner death, not slow progress**. The fixture's own readout says the child was not
  alive (`runnerAlive=no-lock`) with a **118.5 s-stale heartbeat** — i.e. it stopped right at the start, while
  unit activity (log lines) ceased at `...27.594Z`, ~1 s into the run; the test then spun out the full 118 s
  budget. Only 1 of 6 checkpoint verdicts reached PASS although the log shows u1 and u2 passing, so
  checkpoint writes stopped with the process. Outside parallel file execution the case is green 4/4
  (isolated `✔ 3749.0ms`; whole file `28.0 s`, same case `3548.0ms`; manual runner drive 6/6 units;
  serialized full set, below). In the parallel lane: 2/3 red, one pass at `4014.2ms`.
- **Serialized control**: same 55-file set at `--test-concurrency=1` → `1341 tests, 1336 pass, **0 fail**,
  5 skipped, 135.5 s` (`fast-serial-tail.log`). So the case is sound in-file; the trigger is specifically
  **in-lane parallel file execution** — and not ambient load, since that green run happened with the same
  ambient configuration (the user's app + renderer) live.
- **Candidate resource-holders, narrowed**: no lane file launches a real Electron (all `electron` hits are
  fakes: `relaunchElectronFn` stubs, a `require.cache` nativeImage stub, a "stays electron-free" string
  assertion); every port bind is ephemeral (`port: 0` / `listen(0, '127.0.0.1')`, ~9 files), so no fixed-port
  contention; the fixture mutex is per-test-dir, so no shared-lock contention. What remains is generic
  CPU/handle pressure from the files that spawn child node processes — the MCP proxy/adapter tests
  (`omp-mcp-adapter.test.js`, `dispatch-socket-teardown.test.js`, `mcp-proxy-bound-tab-rotation.test.js`) do
  real `spawn(scripts/antifan-omp-mcp.cjs)` children, concurrently with the goal-runner's own child on a
  4-core host.
- **Context**: not declared flaky (no `skip`/`flaky` markers in the file), the tree is clean for the goal
  paths (`git status --short -- test/unit/goal-runner.test.mjs scripts/goal/` empty) so the pending daemon
  set is not implicated, and the timed-out runs left no orphaned fixtures (0 processes matching
  `goal-ladder|goal-runner|runner.mjs|.goal-test`). This is the **third** pass at this class of problem:
  `2a6667ce test(unit): stop the goal-runner waits from timing the machine` and
  `0efeea5b test(unit): bound the goal-runner waits by the runner's progress, not the clock` reworked the
  waits to be progress-bounded — but the remaining failure is the child dying, which progress-bounded waits
  cannot fix.
- **Fix**: the assertion does not record the child's **exit code/signal/stderr**, so the death cause is
  unknown. First make the fixture surface it and fail fast on early child death; then the candidate causes
  become decidable (host CPU/handle pressure from concurrent child-process-spawning files — the only
  surviving candidate after the narrowing above —, a raced lock write, or the fixture's own kill path).
  Serializing the case is a dodge, not a fix, but is a valid stopgap while the instrumentation lands.

### `plan status gate` / `test/unit/check-plans.test.mjs:106` — plan-tree status vocabulary
- **Error**: `AssertionError 1 !== 0`; `unknown: [{file: plans/260919-0130-terminal-daemon-and-throughput/plan.md, status: in_progress}]`
- **Cause**: plan front matter used `status: in_progress`; the vocabulary requires the hyphenated `in-progress`.
- **Fix applied**: corrected in the daemon plan; `npm run plans:check` exits 0 and the gate test passes.

## Live Product-Surface MCP Terminal E2E (green)

Driven over the live app's MCP tools (`client → app MCP stdio → in-process TerminalManager → PTY` —
lane (a), **no daemon on this path**), then verified and cleaned up:

```
terminal.create {cwd: E:\Work\apps\AntiFan}      → sessionId terminal-11
terminal.write  "echo MCP_E2E_MARK\r"            → written, state running, gen 1
terminal.wait   output-match MCP_E2E_MARK        → satisfied, lastSeq 7, real PowerShell + ANSI tail
terminal.create {parentId: terminal-11}          → sessionId split-6
terminal.write  "echo SPLIT_E2E_MARK\r"          → written, gen 1
terminal.wait   output-match SPLIT_E2E_MARK      → satisfied, lastSeq 7
terminal.list   {paged:true}                     → both present: terminal-11 {splitSessionId: split-6},
                                                   split-6 {splitOf: terminal-11}; user sessions intact
terminal.close  {split-6, isSplit:true}          → closed
terminal.close  {terminal-11}                    → closed
terminal.list                                    → both gone; activeSessionId back to terminal-1 (user's)
```

Side effect observed and restored: creating a session made it the active one; after closing both, the
active session returned to the user's `terminal-1`.

## Critical Issues

1. **Shipping-mode rendezvous is broken: the staging script and the runtime spawner resolve different
   data roots.** `scripts/stage-daemon-host.mjs:41-47` resolves env → `E:\Work\.antifan-data` →
   `E:\.antifan-data` → `D:\Work\.antifan-data` (dev-machine candidate list); live result without env:
   `"dataRoot": "E:\\Work\\.antifan-data"`. `src/main/terminal-daemon/daemon-spawner.ts:76-78` resolves
   env → `%LOCALAPPDATA%\antifan-data`. `resolveStagedEntry()` (same file, :86-94) reads
   `<dataRoot>\daemon-host\current.json`, so in shipping configuration the published pointer is invisible:
   probe case A (no env) → `mode=in-process reason="no staged daemon bundle (run scripts/stage-daemon-host.mjs)"`;
   probe case B (root aligned via env) → `detached pid=15700`. The probes only ever exercise the aligned
   root, so the detached path has never been verified in shipping resolution.

2. **The daemon is not wired into the app yet — "never invoked", not merely "never boots".** Both public
   entry points are defined and neither has a single consumer: `ensureDaemon`
   (`src/main/terminal-daemon/daemon-spawner.ts:258`), `DaemonTerminalProxy`
   (`src/main/terminal-daemon/daemon-client.ts:170`). Double-checked two ways:
   `grep -rn "ensureDaemon\|DaemonTerminalProxy" src/main/` → only the two definition sites;
   `grep -rn "terminal-daemon" src/ --include="*.ts"` **excluding** the directory itself → **zero matches**,
   and the directory holds no barrel (`daemon-client.ts`, `daemon-entry.ts`, `daemon-spawner.ts`,
   `protocol.ts`). No module outside `src/main/terminal-daemon/` imports any of them. This matches the
   plan's explicitly unchecked GUI-cutover item — but it means the P0 promise is not reachable by a user
   today, in any data-root configuration, and fixing (1) alone still yields an uninvoked daemon.

Neither issue is a regression: the app still runs in-process terminals exactly as before. Both are
pre-cutover prerequisites, and (1) also invalidates the shipping leg of the P0 evidence until fixed.

## Recommendations

1. [critical] Unify the data root: have the staging script resolve the same root as the spawner
   (`%LOCALAPPDATA%\antifan-data` unless `ANTIFAN_DATA_ROOT`), then re-run `probe-shipping-path.cjs` case A
   and require `detached` in shipping resolution.
2. [high] Re-run `test:e2e` with the host quiesced (no user Electron renderer at >100 % CPU) to settle the
   industrial-overhaul tail finding; keep the envelope evidence in the artifact if it persists.
3. [high] The goal-runner kill/resume case needs **instrumentation before a fix**: it fails on a *dead child*
   (`runnerAlive=no-lock`, 118.5 s-stale heartbeat) with no exit code/signal/stderr recorded, so the cause is
   undecidable today. Surface the child's death (and fail fast on it) instead of waiting out the hard budget;
   only then can load pressure, a raced lock write, or the fixture's kill path be separated.
4. [medium] `test:e2e` runs with `--test-concurrency=5` (five Electron-launching files) on a 4-core host —
   the same load class that flips (3). Consider `--test-concurrency=2` for e2e, or the existing
   `test:e2e:strict` in CI. For `test:fast`, serialized execution costs 135.5 s vs 65.5 s and turns the
   goal-runner case green — a cheap stopgap if the instrumentation takes time.
5. [low] 32 `setOverlay` TypeError lines appear as stderr noise in the fast lane (renderer domain); not a
   failure, but it hides real output when triaging.

## Evidence (artifacts)

| Artifact | Path |
|---|---|
| Full pipeline log (13 lanes) | `C:/Users/Admin/AppData/Local/Temp/antifan-review/e2e-verify.log` |
| Fast lane alone (goal-runner red) | `.../antifan-review/fast-alone.log` |
| Goal-runner isolated / whole-file | `.../goal-test-isolated.log`, `.../goal-file-whole.log` |
| Fast set serialized (`--test-concurrency=1`, 0 fail) | `.../antifan-review/fast-serial-tail.log` (summary tail) |
| Manual runner drive | `.../goal-runner-manual.log` |
| e2e industrial runs (1150.8 ms / 863.6 ms) | `.../e2e-industrial-alone.log`, `.../e2e-industrial-alone2.log` |
| Shipping probe re-run | `.../shipping-rerun.log` |
| Chain logs (reattach, coverage, survival, persist, stage) | `.../antifan-review/e2e-logs/*.log` |

## Unresolved Questions

- Is the dev-machine candidate list in `stage-daemon-host.mjs` meant to be production staging, or a
  dogfooding convenience that the cutover will replace? The answer decides whether issue (1) is a bug fix
  or a wiring task.
- Does the industrial-overhaul tail gate belong to the transport contract or to the fixture page's
  hydration under load? Needs the quiesced re-run to decide. Related, structural: the max gate is defined as
  one heartbeat interval (`STALL_ENVELOPE_MAX_MS = HEARTBEAT_MS`), so it has zero margin by design —
  should the criterion gain margin, or should the heartbeat interval be treated as a floor the gate must
  clear by a multiple?
- What kills the goal-runner fixture child under parallel file execution? The assertion records neither exit
  code nor signal, so this stays open until the fixture surfaces them (recommendation 3).
