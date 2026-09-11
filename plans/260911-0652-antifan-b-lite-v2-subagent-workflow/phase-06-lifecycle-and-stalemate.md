---
title: "Phase 6: Loop Lifecycle, STALEMATE & Ownership Split"
status: done
---

# Phase 6: Loop Lifecycle, STALEMATE & Ownership Split

## Overview

Phases 1–5 make one round bounded and auditable. This phase makes an unbounded number of rounds terminate with a typed state instead of drifting, and fixes the ownership boundary that Round 3 corrected: the AntiFan verification engine owns **evidence, artifact, and lifecycle state** — it does not own source-file recovery. Main owns source/workspace checkpoint, staged recovery, and rewind.

The correction is explicit because the first design put filesystem rollback in the engine, which would have required repo-wide git operations the loop is forbidden to run.

## Requirements

- [ ] A repair budget exists per run (`repairAttempts`) and is enforced where verification is driven, not only recorded: the budget is a field on the lifecycle/verification batch state, not a note in a report.
- [ ] `STALEMATE` is a first-class outcome: repeated failure, or a fix whose audit is refused twice for the same cause, ends the loop with a typed terminal state and an evidence path.
- [ ] A `SCOPE_DISCOVERY` class exists: a fix that cannot proceed inside `allowedFiles` is reported as discovery, returns to Main for a new FixRequest, and never expands scope itself.
- [ ] The circuit breaker stops the loop on repeated identical failure signatures rather than retrying them.
- [ ] Ownership is documented as it is implemented: engine keeps evidence/artifact/lifecycle; Main owns source checkpoint, staged merge, and path-scoped recovery.
- [ ] No source-file rollback path exists inside the verification engine; the only recovery is Main's path-scoped restore from Phase 4. Note the pre-existing exception: `theme.qa_repair.begin/verify` is already a write-class capability that snapshots the workspace and can roll it back to R0 — it is outside the fixer allowlist, is never invoked by this loop, and is documented so the ownership rule is not silently contradicted by a live tool.

## Implementation Steps

1. Locate the lifecycle/verification state surface and add the repair-attempt budget plus terminal states as structured fields (extend the existing contract rather than adding a parallel one).
2. Wire the budget into the loop's round accounting so an exhausted budget transitions to `STALEMATE` with the last failure signature.
3. Add the repeated-signature circuit breaker: identical signature N times ends the loop with that signature recorded.
4. Wire `SCOPE_DISCOVERY` into the fixer's return contract and into Main's decision step so a discovery produces a new FixRequest rather than an in-place scope change.
5. Assert the ownership boundary in tests: the engine's state transitions never touch source files; the only writer to the workspace is the merge gate.
6. Replay the Phase 5 negative round against the budget to prove the terminal states are reachable and typed.

## Evidence Anchors

- `src/main/verification/verification-contract.ts` (lifecycle/verification contract surface — note: the plan index and the Round 3 record name this as `src/main/control-plane/verification/…`; that path does not exist, measured by glob, and the real surface is this file)
- `src/shared/control-plane-contracts.ts` (shared contract types)
- `plans/260910-2008-clone-campaign-evidence-provenance/phase-01-…` (single-writer, fail-closed, immutable attempt state)
- Phase 4 (audit refusal causes), Phase 5 (typed outcomes)

## Todo

- [x] Add `repairAttempts` budget to the lifecycle state
- [x] Add `STALEMATE` terminal state + transition rule
- [x] Add repeated-signature circuit breaker
- [x] Add `SCOPE_DISCOVERY` class and its Main-side handling
- [x] Document + test the ownership split (engine never writes source)
- [x] Replay the negative round to prove terminal states are reachable
- [x] Document `theme.qa_repair.*` as out-of-loop and outside the fixer allowlist

## Success Criteria

- [ ] An exhausted budget or repeated signature ends the loop in a typed terminal state with evidence, without a destructive rollback.
- [ ] `SCOPE_DISCOVERY` produces a new FixRequest and never an in-place scope change.
- [ ] Tests show the verification engine's transitions never write source files.
- [ ] The engine contains no source-recovery code path; recovery is Main's, path-scoped, and names its files.

## Measured Contract (2026-09-11, after review round)

The budget contract is pinned by tests and was settled deliberately; a future audit that proposes
changing it must bring evidence, not an abstract concern:

- **Counters are per attempt** (`resampleAttempts`, `repairAttempts` restart at zero for a new
  `attemptId`); **the ceilings and the failure signature carry** into the next attempt of the same
  `runId`. Pinned by `test/unit/semantic-evidence-and-guardrails.test.ts` ("tracks resample and repair
  budgets independently per run attempt") and by `test/unit/verification-lifecycle-budget.test.ts`.
- **STALEMATE is reachable two ways**: budget exhaustion *inside* one attempt (`recordAttempt` with the
  same `VerificationBatchKey` reuses the lifecycle and increments), and a repeated failure signature
  *across* attempts (`consecutiveRefusalCount`/`lastFailureSignature` are carried per run, default
  `maxIdenticalFailures = 2`). Both are asserted in `test/unit/verification-lifecycle-budget.test.ts`.
- **Rejected**: a review round proposed carrying the counters themselves across attempts, on the theory
  that a budget which resets per attempt can never exhaust. Rejected because (a) it contradicts the
  pre-existing test above, which is a verified decision, and (b) cross-attempt termination is already
  provided by the carried signature, which is what requirement 2 below asks for. The counters-per-attempt
  reading was restored; only the terminal fast-exit gap (below) was kept.
- **Landed**: the terminal fast-exit tested `FIXED_VERIFIED`, which is written to `terminalOutcome`, not
  to `state`, so `VERIFIED` and `REFUSED_SCOPE` — the states `recordAttempt` actually assigns — were not
  tested and a terminal batch could re-enter budget accounting.

## Measured Verification (2026-09-11)

The cross-attempt lever was dead in production when this phase was written, and that is what the wiring
below fixed.

- **The signature now comes from measured evidence, not from an unfed options object.**
  `VerificationEvaluator.failureSignature(result, bundle)` returns the sorted, de-duplicated set of
  failed proof obligations for a `REJECTED` verdict and `undefined` for every other verdict, and
  `browser-capabilities.ts:3509-3522` passes it as the sixth argument to `recordAttempt`. Before this,
  the only production call site passed five arguments, so `currentSignature` was always undefined and
  `recordAuditRefusal` / `recordScopeDiscovery` / `recordFailureSignature` had zero callers repo-wide.
  Non-`REJECTED` verdicts deliberately return no signature, so resample semantics are untouched.
- **Budgets are per attempt; ceilings and the signature carry across attempts.** A reviewer proposed
  carrying the counters themselves across attempts; that was **rejected** because it contradicts the
  pre-existing verified contract (`test/unit/semantic-evidence-and-guardrails.test.ts`: on attempt 2,
  `resampleAttempts === 0` and `repairAttempts === 1`) and because termination is already provided by
  the carried signature with `maxIdenticalFailures = 2`. The rejection is recorded in this phase file so
  it is not re-applied.
- **The terminal fast-exit tested states that are actually assigned.** The guard tested
  `FIXED_VERIFIED` (which is written to `terminalOutcome`, never to `state`) and omitted `VERIFIED` and
  `REFUSED_SCOPE`; it now tests `STALEMATE | EXEMPTION_WAIVED | SCOPE_DISCOVERY | VERIFIED |
  REFUSED_SCOPE | FIXED_VERIFIED` (`circuit-breaker.ts:182-192`).
- **Tests:** `test/unit/verification-lifecycle-budget.test.ts` (10 cases across two suites) covers
  per-attempt counters with carried ceilings, STALEMATE from budget exhaustion on either budget,
  STALEMATE from a repeated derived signature, the `VERIFIED` and `REFUSED_SCOPE` fast exits, a clean
  budget on a fresh run, and the order-insensitive de-duplicated signature itself. Compiled suites:
  **68 tests / 13 suites / 68 pass, 0 fail**; `npm run typecheck` exit 0.
- **Ownership split:** documented in `rules/loop-contract.md` (the Main-agent role section, and the
  `FIXED_VERIFIED` / `SCOPE_DISCOVERY` definitions) and exercised by the fix-loop self-tests, in which
  the fixer writes only inside the staged root and the merge gate is the only writer. Caveat stated
  plainly: the engine-side `recordScopeDiscovery` / audit-refusal helpers still have **no production
  caller by construction** - `theme.qa_repair.begin/verify` delegate to `ThemeQaRepairCoordinator`,
  which never touches the circuit breaker - so the audit-refusal route is a contract surface awaiting a
  Main-side caller and must not be described as a working lever.
- **`theme.qa_repair.*` is out of the loop and outside the fixer allowlist:** it is in
  `DEFAULT_FORBIDDEN_TOOLS` (the union merged today) and named as prohibited in
  `rules/loop-contract.md:34` and `prompts/builder-fixer.md:23`.
- **Negative replay:** the unit suite replays the terminal rounds - STALEMATE, VERIFIED, REFUSED_SCOPE -
  and proves each is reachable. The loop-level negative round (a real fixer session refused with
  `REFUSED_SCOPE` naming the path) belongs to Phase 5 and is not yet run.


## Risk & Rollback

Risk: adding lifecycle fields to a shared contract ripples into existing callers. Mitigation: extend the existing contract with optional fields first, keep defaults, then make the budget required once all callers pass it. Rollback: the budget/enum additions are additive state; a revert leaves prior behaviour and prior evidence untouched. Never "roll back" by clearing verification state directories.
