---
phase: 2
title: "Batch-Scoped Verification Retry Lifecycle"
status: complete
priority: P1
effort: "1.5-2d"
dependencies: [1]
---

# Phase 2: Batch-Scoped Verification Retry Lifecycle

## Context Links

- [Plan](./plan.md)
- Owners: `src/main/verification/circuit-breaker.ts`, `src/main/session/issue-register.ts`, `src/main/tools/browser-capabilities.ts`, `src/main/session/receipt-store.ts`
- Existing authority: `AuthenticatedCapabilityContext.runId`, `attemptId`, `invocationId` in `src/shared/control-plane-contracts.ts`

## Overview

Replace the process-global per-claim counter with a two-budget state machine scoped to the existing runtime lineage. Current code counts every non-`VERIFIED` verdict as repair, clears a claim counter on any success, never connects the breaker to `verify_claim`, and writes receipts under `claim.id`; because terminal receipts are immutable per `commandId`, a later verification of the same claim can inherit an earlier terminal receipt.

## Requirements

- Functional:
  - Scope lifecycle by `VerificationBatchKey = (runId, attemptId, claimId)`; no new caller-provided batch ID.
  - Track independent `resampleAttempts/maxResamples` and `repairAttempts/maxRepairs`.
  - `INCONCLUSIVE + RESAMPLE` consumes only resample budget. `REJECTED` and repairable `PARTIAL` consume only repair budget.
  - `INCONCLUSIVE + NEED_INPUT|UNOBSERVABLE|UNSUPPORTED` halts automation without consuming either retry budget. `UNVERIFIED` remains non-terminal and cannot auto-close.
  - Exhaustion sets the existing `VerificationRecord.stalemateState = STALEMATE`; human exemption remains auditable and never changes verdict to `VERIFIED`.
  - `VERIFIED` closes the current batch without erasing historical counters. A new run attempt creates a new key and starts clean.
  - Wire lifecycle evaluation directly into `anti.verification.verify_claim`; reject verification after stalemate unless the existing human exemption state permits a caller-visible non-verified exit.
  - Use authenticated `context.invocationId` as `ReceiptBinding.commandId`; keep `claim.id` as the result subject. A receipt-enabled verify call without authenticated invocation identity fails closed.
  - A computed `REJECTED`, `PARTIAL`, `INCONCLUSIVE`, or `UNVERIFIED` is a successfully completed capability evaluation: terminal receipt `state=completed`, `deliveryState=accepted-exact`. Exceptions/abort/durability failure alone map to failed/unknown execution states.
- Non-functional:
  - Extend `IssueRegister`/verification record; do not add a retry database, singleton, or verdict taxonomy.
  - Bound in-memory state by persisted verification records and current max record limits; use deterministic keys and no timers.

## Architecture

```text
Authenticated verify invocation
  -> key(runId, attemptId, claimId)
  -> reject if batch already STALEMATE
  -> coherent evidence capture (Phase 1)
  -> VerificationEvaluator (unchanged 5 verdicts)
  -> classify lifecycle outcome
       RESAMPLE -> resample budget
       REJECTED / repairable PARTIAL -> repair budget
       NEED_INPUT / UNOBSERVABLE / UNSUPPORTED -> halt
       VERIFIED -> close batch
  -> persist VerificationRecord lifecycle snapshot
  -> put terminal receipt(commandId=invocationId, subject=claimId in result)
```

The circuit breaker becomes a pure transition function plus `IssueRegister` persistence. Lifecycle history belongs on the existing verification record, for example:

```typescript
type VerificationBatchLifecycle = {
  runId: string;
  attemptId: string;
  resampleAttempts: number;
  repairAttempts: number;
  maxResamples: number;
  maxRepairs: number;
  state: 'ACTIVE' | 'HALTED' | 'STALEMATE' | 'EXEMPTION_WAIVED' | 'VERIFIED';
  lastInvocationId?: string;
};
```

Defaults remain policy constants in `circuit-breaker.ts`, not public capability arguments. Initial implementation uses the current maximum of 3 for each budget; tests pin independent exhaustion, not a shared total.

## File Inventory

| Action | File | Rough Change | Test Impact |
|---|---|---:|---|
| Modify | `src/main/verification/verification-contract.ts` | Add batch lifecycle snapshot/result fields; preserve verdict union | Evaluator/type tests |
| Modify | `src/main/verification/circuit-breaker.ts` | Replace claim-global mutable semantics with keyed dual-budget transition API | Guardrail unit tests |
| Modify | `src/main/session/issue-register.ts` | Persist/update lifecycle snapshot atomically with verdict | Verification capability tests |
| Modify | `src/main/tools/browser-capabilities.ts` | Integrate lifecycle and per-invocation receipt semantics | Capability + golden tests |
| Modify | `src/main/session/receipt-store.ts` | Add list/query by attempt/subject only if tests need observation; do not change terminal immutability | Receipt tests |
| Modify | `test/unit/semantic-evidence-and-guardrails.test.ts` | Replace old reset-on-verified assertions with batch transitions | Focused state tests |
| Modify | `test/unit/verification-capabilities.test.ts` | End-to-end budgets, receipts, direct-dispatch rejection | Focused capability tests |
| Modify | `test/golden-slice-e2e.test.ts` | Query receipt by invocation instead of claim | Integration contract |

## Function and Interface Checklist

- [x] `VerificationCircuitBreaker.recordAttempt` accepts authoritative batch identity and inconclusive reason.
- [x] State transition result identifies consumed budget, remaining counts, halt reason, and stalemate state.
- [x] `IssueRegister.updateVerificationVerdict` persists verdict and lifecycle together; restart rehydrates truth.
- [x] `verify_claim` calls the breaker exactly once after evaluation and before returning.
- [x] `ReceiptBinding.commandId` equals authenticated `invocationId`; no fallback constant or `claim.id` collision.
- [x] Receipt execution state is independent of domain verdict.
- [x] Human exemption never mutates historical verdict/proof profile.

## Dependency Map

```text
Phase 1 coherent evidence
  -> evaluator result
  -> batch lifecycle transition
  -> IssueRegister + ReceiptStore
  -> Phase 3 strict source verdict
  -> Phase 4 real repair/verify loops
```

Phase 3 depends on correct handling of source non-pass states. Phase 4 proves receipt identity and retry behavior through transport rather than direct capability execution.

## Implementation Steps

1. Define batch lifecycle types adjacent to existing verification contracts. Keep public verdicts unchanged.
2. Refactor `VerificationCircuitBreaker` into deterministic transitions keyed by the exact run/attempt/claim tuple; remove success-driven deletion/reset behavior.
3. Add one `IssueRegister` update path that persists verdict, proof profile, inconclusive reason, and lifecycle snapshot in a single verification-register rewrite.
4. In `verify_claim`, require `AuthenticatedCapabilityContext` when `receipts` is configured; derive `commandId=context.invocationId` and binding lineage exclusively from context.
5. Evaluate, classify, persist, then write a completed/accepted receipt for every returned verdict. Let thrown capability errors flow to transport settlement; never mint a misleading domain receipt after an exception.
6. Return lifecycle status beside the existing verification record without adding verdict values.
7. Migrate tests from `findByCommand(claimId)` to invocation IDs and add two verifications of one claim proving distinct terminal receipts.
8. Add restart/rehydration, batch isolation, independent budget exhaustion, non-retryable halt, and exemption truthfulness tests.

## Test Scenario Matrix

| Priority | Scenario | Expected Transition | Receipt |
|---|---|---|---|
| Critical | Same claim: stale capture twice, then repaired reject | Resample=2, Repair=1 | Three distinct completed receipts |
| Critical | Resample budget exhausted | `STALEMATE`; repair budget untouched | Exhausting evaluation completed |
| Critical | Repair budget exhausted | `STALEMATE`; resample budget untouched | Exhausting evaluation completed |
| Critical | Same claim ID in two run attempts | Independent batch state | Distinct invocation receipts |
| Critical | Rejected then verified in same batch | Batch closes `VERIFIED`; history retained | Both receipts completed/accepted |
| Critical | Receipt-enabled trusted direct dispatch lacks invocation ID | No fallback collision | Fail closed before evaluation |
| High | `NEED_INPUT`, `UNOBSERVABLE`, `UNSUPPORTED` | `HALTED`, zero budget consumption | Completed/accepted result |
| High | Human exemption after stalemate | `EXEMPTION_WAIVED`; verdict unchanged | Auditable result only |
| High | Process restart | Persisted counts/state rehydrate | No budget reset |
| Medium | Abort during evidence sampling | No lifecycle transition | Transport failure/unknown only |

## Verification Commands

```text
npm run compile
node --test .compiled/test/unit/semantic-evidence-and-guardrails.test.js
node --test .compiled/test/unit/verification-capabilities.test.js
node --test .compiled/test/golden-slice-e2e.test.js
```

## Todo

- [x] Define persisted batch lifecycle contract.
- [x] Implement independent resample and repair transitions.
- [x] Wire verifier results to lifecycle state.
- [x] Make invocation ID the receipt command identity.
- [x] Separate capability completion from domain verdict.
- [x] Pass restart, isolation, and receipt regression tests.

## Success Criteria

- [x] No verification loop can retry indefinitely or borrow budget from another run attempt.
- [x] `RESAMPLE` never consumes repair budget; repair failure never consumes resample budget.
- [x] Every returned evaluation has one terminal receipt keyed by its invocation, including non-pass verdicts.
- [x] Two verification attempts for one claim retain two truthful receipts.
- [x] Human exemption unblocks policy without fabricating `VERIFIED`.

## Risk Assessment

- **Trusted unit callers bypass transport.** Signal: receipt-enabled tests call capability definitions with partial context. Response: route receipt tests through `CapabilityTransportAdapter`; keep direct execution only where receipts are absent.
- **IssueRegister singleton crosses test/process lineage.** Signal: one test inherits another's batch state. Response: add explicit test reset/isolated data-root seam, never weaken production persistence.
- **PARTIAL may not always be repairable.** Signal: `inconclusiveReason=NEED_INPUT`. Response: classification precedence uses reason first; such cases halt instead of spending repair budget.

## Security Considerations

- Caller cannot provide `runId`, `attemptId`, `invocationId`, budgets, counters, or state in capability params.
- Receipt and lifecycle binding derives only from authenticated Main-owned context.
- Reject forged replays through existing invocation ledger semantics; do not duplicate idempotency logic.

## Rollback Boundary

Revert lifecycle type/API and verifier integration together. Receipt identity migration must not be partially rolled back after tests or persisted files begin using invocation IDs.

## Next Steps

Proceed to Phase 3 only after independent budgets, persistence, and distinct receipt tests pass.
