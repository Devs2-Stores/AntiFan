# Autonomous remediation loop — protocol

Status: active from 2026-09-18. Resumable: a fresh session reads
`plan.md` → this file → `phase-11-verification-lane-truth.md` →
`loop-state.json` and continues at the recorded unit.

## Purpose

Iterate the consolidated remediation plan to a measurable end (Core Health whole,
live-surface defects closed) without a human gate per iteration, while keeping the
two failure modes of autonomous loops out: **grading yourself with a lane you
cannot trust**, and **accumulating unattributable edits**.

## Non-negotiable gates

1. **The instrument first.** No iteration is "passed" by a lane whose assertions
   have not survived the falsification pass (§ Verify the verifier). Phase 11
   exists for this and runs before/with the rest.
2. **Compile + the covering lane are the only ground truth.** A subagent's report
   is a claim, never evidence. Every unit closes with a command run in the
   controller session.
3. **One unit, one commit.** Conventional message, files named in the body.
   A unit that does not improve its metric is reverted, not "kept for later".
4. **No assertion may be weakened** to reach green. Deleting a named tautology is
   the only allowed removal, and it is recorded with its reason.
5. **The live store is never a fixture.** Probes that write run against a temp
   root; the live register/data root is touched only by an explicit live-proof
   unit.

## Iteration shape

```
0 PREFLIGHT   plan SoT + loop-state + git status + the covering lane's current color
1 SELECT      next unit from the phase SoT (phase 11 register first, then plan order)
2 IMPLEMENT   parallel subagents, one file-owner each, no build/lint/test (integration owns it)
3 INTEGRATE   controller: npm run compile + the covering lane; collect raw output
4 VERIFY      read-only falsifier per unit: try to make the green mean nothing
5 DECIDE      green+verified -> commit; red -> one fix round -> else revert the unit
6 RECORD      loop-state.json + one evidence line; next iteration
```

Phases 0 and 6 are the loop's own bookkeeping; a phase boundary is never a yield
point - the loop continues until the unit queue is empty, the iteration cap is
reached, or a unit is `BLOCKED` twice for the same reason.

## Verify the verifier (falsification pass)

Run for every unit whose closure came from a lane, by a read-only subagent with
the lane's raw output and the changed files:

- Name the assertion(s) that would have failed if the change were absent, and
  state the observed pre-fix value (a `git stash`-style proof, or the recorded
  red run). If no assertion distinguishes them, the unit is unproven.
- Reject any assertion that cannot fail: re-derived constants, mock echoes,
  wiring/field copies, source-text pins, `not-throw`, non-empty checks.
- Confirm the lane ran the compiled artifact (`.compiled/**`) of the edited
  source, not a stale build.
- Report `PROVEN` / `UNPROVEN` with the falsifying evidence. `UNPROVEN` blocks
  the commit.

## State

`loop-state.json` (same directory): `iteration`, `unit`, `phase`, `status`
(`pending|in_progress|proven|reverted|blocked`), `lane`, `evidence` (path or
command), `commit`, `notes`. It is the loop's only mutable memory; the plan files
are its intent.

## Objective metrics (recorded every iteration)

The loop is not allowed to report progress from prose. Each iteration records, in
`loop-state.json`:

| Metric | Source | Direction |
|---|---|---|
| Instrument green | `npm run test:e2e` exit code (+ the covering lane for the unit) | must be 0 |
| Instrument wall clock | `node scripts/loop-e2e-metric.cjs` (stdout is exactly one number - lane seconds, compile excluded; the lane's log and any receipt restoration go to stderr; exits non-zero on red so a failed run never reports a fast number; restores the tracked receipts the lane rewrites, so a verify leaves the tree as it found it) | down |
| Register integrity | on-disk byte length and record count of `issues/verification-register.jsonl` vs `anti.verification.list().totalCount` | equal, never shrinking |
| Live error classes | `TARGET_MISMATCH`, `TARGET_STALE`, `RUNTIME_MISMATCH`, args-parse failures, `[object Object]`, doubled-prefix errors in the session logs and invocation ledger | down to 0 |
| Core Health | `core.health` status/gate/candidate counts | whole (no `GATE_*_FAILED`), candidates resolved through the writer |
| Per-MCP usage | `accounting:mcp-dispatch` aggregate (dispatch/ledger fact, never a client tally) | recorded |

**Which metric owns a unit.** A unit's metric is the metric its phase-file
success criterion names - a correctness unit is graded by its criterion (e.g.
phase 1: register `totalCount` ≥ 1000; phase 11: lane green), never by the wall
clock, so watchdogs, extra assertions and canaries cannot be reverted for taking
time. The wall clock grades only a unit whose stated goal is speed, and then as
the **median of ≥ 3 runs** of `node scripts/loop-e2e-metric.cjs`: a single lane
run varies by seconds, and the spread widens as the files contend (measured
2026-09-18: 38.4/40.1 s at `--test-concurrency=1`, 13.5/14.9/19.0 s at 5), which
is wider than the wins these units are chasing. Each measured iteration is
recorded in `loop-results.tsv` beside this file: iteration 0 baseline 40.1 s,
then 22.0 -> 17.9 -> 14.9 s (files run concurrently, then in one wave), each with
`npm run test:main` green at 1315 pass / 0 fail.

A candidate improvement that raises the instrument's wall clock for no product
metric gain is still a valid iteration only if it removes a confirmed defect; an
iteration that improves neither is reverted.

**Baseline (iteration 0).** e2e lane wall clock 40.1 s, green, 5 files at
`--test-concurrency=1` (per-file 3.8-8.6 s); the lane is the gate, so a cheaper
metric never replaces it. The first speed units were the ones with measured waste
(per-subagent rotation IO) and the isolation that made concurrency safe (each
live smoke pins its register and data root to a run-scoped temp root) - not
weaker assertions. What is left is inside the lane bodies: at concurrency 5 the
wall clock tracks the slowest file (~11 s under the wave) plus runner startup, so
the remaining units are per-file waits that can become condition waits without
weakening what the lane proves. Hard-coding 5 buys nothing on a host with fewer
cores, so an adaptive bound (`min(file count, available parallelism)`) is a
recorded follow-up rather than part of the win.

## Safety

- Destructive VCS/filesystem commands and any live push stay prohibited
  (root contract): no `git reset --hard`, no `clean -fd`, no `push --force`, no
  live theme push. Revert = `git revert` of the loop's own commit.
- The loop never edits the plan's acceptance criteria to fit an outcome; a
  criterion that turns out to be wrong is raised, not quietly narrowed.
