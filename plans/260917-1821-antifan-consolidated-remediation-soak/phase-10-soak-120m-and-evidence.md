---
title: "Phase 10: 120-minute soak & evidence"
status: deferred
---

# Phase 10: 120-minute soak & evidence

## Status — not executed (deferred)

The 120-minute window has **not** been spent: this phase has no run, no telemetry
and no report, so nothing in phases 1–11 is certified by it. The runner of record
is `node run-omp-soak.cjs --minutes 120` (fixture `scripts/smoke-omp-closed-loop.cjs
--soak`), to be driven against one live app instance and one OMP session.

Until it runs, every claim in this plan rests on the phase lanes (`tsc -p .`,
`test:main`, `test:unit`, `test:e2e`) and on the targeted probes recorded per
phase — never on soak evidence. `plan.md § Global success criteria` keeps the soak
criterion unchecked for the same reason.

## Overview

The program's own acceptance gate: 120 minutes of continuous wall-clock load
against one live app instance and one OMP session, with every invariant in
`plan.md § 120-minute soak contract` sampled continuously, and every counter
compared against `plan.md § Evidence baseline`. Nothing in phases 1–9 is "done"
by intent; this phase turns the fix list into measured behavior. It runs **last**,
after every other phase's binary probe has passed.

## Requirements

- **R1 — Duration and shape.** `--minutes 120`, one live app instance, one OMP
  session driving it, uninterrupted. An app restart aborts the run: the defects
  it reproduces (authority decay, wedge accumulation, register growth, quota
  leaks) only surface across one long-lived process window.
- **R2 — Load.** `scripts/run-omp-soak.cjs` drives
  `scripts/smoke-omp-closed-loop.cjs` in `--soak` mode. The cycle set covers the
  defect families of this plan: target identity (`TARGET_MISMATCH` /
  `TARGET_STALE` / `TARGET_BUSY_DRAINING`), capture (`anti.screenshot.*`,
  `anti.visual.compare`, `anti.media.freeze`), failure taxonomy
  (`NO_RENDER_SURFACE` split by form), quota adoption/release, terminal split
  projection and transcript, register integrity, MCP surface and args transport.
  Cycle counts are **computed at run time**, never hard-coded in the fixture.
- **R3 — Continuous sampling.** Each interval the runner samples heap / RSS /
  heapTotal / external, artifact count and staged bytes, invocation-ledger
  partition WAL frames plus `inFlightCount === 0`, and the Super Core health
  snapshot, streaming JSONL telemetry and writing a certification summary.
- **R4 — Counters.** Per-tool error rate (`anti.screenshot.viewport`,
  `anti.screenshot.full_page`, `anti.theme.qa_validate`, `anti.visual.compare`,
  `anti.media.freeze`), total tool error rate, `TARGET_MISMATCH`,
  `TARGET_STALE`, `TARGET_BUSY_DRAINING`, `NO_RENDER_SURFACE` (split by form),
  `RUNTIME_MISMATCH`, args-parse failures, `mcp__mcp__` doubled-prefix errors,
  `xd://mcp__antifan` occurrences, compaction count, register byte length,
  `anti.verification.list().totalCount`. Per-MCP figures come from the dispatch
  accounting aggregate (`npm run accounting:mcp-dispatch`) and the invocation
  ledger — never from a client-side tally.
- **R5 — Invariants (must hold for the entire 120 minutes).**
  1. `verification-register.jsonl` byte length never shrinks.
  2. `anti.verification.list().totalCount` equals the on-disk record count at
     every sample.
  3. Zero `expects a JSON args object as content`, zero `[object Object]`, zero
     `mcp__mcp__` doubled-prefix `No such tool`, zero `xd://mcp__antifan`.
  4. No error carries `TARGET_BUSY_DRAINING` as message while carrying
     `NO_RENDER_SURFACE` as code.
  5. `inFlightCount === 0` at every sample; no leaked invocation.
  6. RSS/heap slope over the final 30 minutes inside the runner's thresholds
     (recorded, not assumed).
- **R6 — Evidence.** One soak report under this plan's `reports/` holding the raw
  counter deltas, the scenario matrix, every invariant's observed value, the
  telemetry JSONL path, and the certification summary path.
- **R7 — Honest failure.** A breached gate exits non-zero and the report names
  the failing counter and its owning phase. A failed soak is reported failed; it
  is never re-run into green without the first failure kept in the report.

## Implementation Steps

1. `npm run compile`, then launch the live app and attach one OMP session.
2. Capture `npm run accounting:mcp-dispatch` output (per-MCP baseline for the
   window).
3. `node scripts/run-omp-soak.cjs --minutes 120`; record the telemetry JSONL and
   summary paths printed in the banner.
4. During the window, sample at least three times: `anti.verification.list()`
   `totalCount` against `wc -l` on `verification-register.jsonl`, and the app logs
   for `RUNTIME_MISMATCH` / `TARGET_*`.
5. Capture `npm run accounting:mcp-dispatch` again after the window.
6. Write the soak report; compare each counter with the baseline table and name
   the owning phase for every counter that moved the wrong way.

## Todo

- [ ] Compile, launch the app, attach the OMP session
- [ ] Capture the pre-window `accounting:mcp-dispatch` gate output
- [ ] Run `--minutes 120` to completion
- [ ] Sample register / `totalCount` equality ≥ 3× during the window
- [ ] Capture the post-window `accounting:mcp-dispatch` gate output
- [ ] Compare every counter against the baseline table
- [ ] Write the soak report with the scenario matrix and invariant observations

## Success Criteria

- The runner exits 0 after ≥ 120 minutes with zero failed iterations.
- Every R5 invariant holds for the whole window, with sampled evidence attached.
- Every R4 counter lands on the target side of the baseline.
- The soak report exists under `reports/` and links its raw evidence.

## Risks / Rollback

| Risk | Mitigation |
|---|---|
| Laptop sleeps / updates mid-window, breaking the continuity the defects need | Hold power settings for the window; the runner records wall-clock drift and a drifted run is re-run with the first run's evidence kept. |
| Runner thresholds too loose to catch a regression | Thresholds are printed into the summary; the counter table (R4) is the primary gate, thresholds are secondary. |
| The soak mutates live app state | It drives the same capabilities a normal session drives; phase 1's disk-authoritative register guard makes register writes monotone for the whole window. |
| Phase order violated (soak run early) | The soak is the last phase by construction; an early run is discarded, not counted as evidence. |
