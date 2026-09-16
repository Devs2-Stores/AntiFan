---
phase: 3
title: "Engine Transactional Execution & Diagnostics"
status: pending
priority: P1
effort: "1d"
dependencies: [2]
---

# Phase 3: Engine Transactional Execution & Diagnostics

## Overview

Fix workflow execution invariants — semantic assertions instead of truthiness, complete abort/skip event propagation, correct `continueOnError` semantics, backoff retries — plus Core Health caching/dedup and renderer status CSS.

## Requirements

- Functional: DEF-02 (wait_for_selector false-pass), DEF-06 (abort leaves pending cards), DEF-07 (Hub open stalls), DEF-08 (continueOnError), DEF-09 (task-runs misreport), DEF-10 (severity mismatch), DEF-11 (duplicate spawn), DEF-13 (no backoff), DEF-14 (precondition refusal styling), DEF-15 (skipped CSS).
- Non-functional: Hub open < 200ms warm path; retries observable via `step:retry` events.

## Architecture

**Metaphor: transactional WAL.** Each step runs inside a transaction boundary; abort = rollback that writes `skipped` records for all uncommitted steps to the event journal. `continueOnError` is a handled catch — run status becomes `completed_with_errors`, not `failed`. Core Health becomes a materialized view: CLI results cached 5s TTL, single `task-runs` spawn shared between `getBridgeState()` and `listTaskRuns()`. Note: `this.cli` spawns in `core-health.ts:231-255` are already async — DEF-07's stall is the *sequential await chain* on Hub open, fixed by caching + parallel spawn, not by making sync code async.

## Related Code Files

- Modify: `src/main/workflow/workflow-engine.ts` (~497-505 wait_for_selector; ~237-250 abort propagation; ~231-233 continueOnError; ~110-179 retry loop)
- Modify: `src/main/diagnostics/core-health.ts` (~231-255 cli spawn; ~420, ~493 dedup task-runs; ~503-511 task-runs health; ~357-378, ~575-580 severity alignment)
- Modify: `src/renderer/toolbar.ts` (~1045-1055 precondition refusal styling — NOT ~999-1008; ~2910-2919 skipped CSS mapping — NOT ~2867-2873)

## Implementation Steps

1. `wait_for_selector`: require non-empty `selector` (else `INVALID_ARGUMENT`); poll `browser.evaluate` → `Boolean(document.querySelector(sel))` until `timeoutMs`; throw on timeout. Never truthy-pass an ArtifactRef (DEF-02).
2. Abort path: after loop break, emit `step:end {status:'skipped'}` for every remaining step + append `skipped` StepResults (DEF-06).
3. `continueOnError`: failed step with `continueOnError: true` → record failure, continue loop, final status `completed_with_errors` unless aborted (DEF-08).
4. Retry loop: jittered exponential backoff `min(2000, 200·2^attempt + jitter)`; emit `step:retry {attempt, delayMs}` (DEF-13).
5. `core-health.ts`: 5s TTL cache for CLI results; single shared `task-runs` query; parallelize independent spawns on Hub open (DEF-07, DEF-11).
6. Task-runs health: base on `taskRuns.length` only; `NO_TASK_RUNS` when only packs/cases exist (DEF-09). Align P2/P3 severity filtering between `getRootCauses()` and `getSnapshot().openIssues` (DEF-10).
7. `toolbar.ts`: precondition refusal → `step-blocked`/warning styling (DEF-14); `skipped` → `step-skipped`/`step-status-skipped` classes (DEF-15).

## Success Criteria

- [ ] `node --test --test-force-exit .compiled/test/main/workflow-engine.test.js` — non-existent selector fails with timeout; abort emits skipped for all remaining steps; continueOnError → `completed_with_errors`
- [ ] Hub open → Core Health renders without >200ms stall (single spawn, cached)
- [ ] `npm run test:fast` green; `npm run typecheck` clean

## Risk Assessment

- **Semantic assertion adds latency**: bounded by existing `timeoutMs` (default 5s), 100ms poll — same envelope, no false-pass.
- **`completed_with_errors` breaks binary pass/fail consumers**: treat as non-`failed` in badge logic; document in workflow-schema comment.
- **5s cache serves stale health**: refresh button bypasses cache.
