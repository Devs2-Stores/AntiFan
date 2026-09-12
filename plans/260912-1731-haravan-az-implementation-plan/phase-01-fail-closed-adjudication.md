# Phase 01 — Fail-closed adjudication

Status: PLANNED. Depends on: 00.

## Context

`src/main/qa/theme-qa-workflow.ts:725–792` assigns unmeasured viewports pass/default scores; compliance details claim OS2 without evidence. `settleCapture` is optional when the port method is absent and throws for incomplete receipts when present. These are source observations, not runtime certification.

## Requirements

- All required cases need finite, in-range fresh measurements and valid identity/capture/settle receipts. Missing/null/NaN/infinite measurements are unmeasured and INCONCLUSIVE, never PASS. A caller-provided `passed:true` cannot override invalid measurements.
- Unmeasured dimension scores are nullable. Overall diagnostic mean includes only actually measured finite dimensions and is null when none exist. Coverage is explicit; mean never overrides required-case verdicts.
- Compliance details describe actual scan scope/results. `liquidClean` absent is UNKNOWN, not clean. Even true only certifies that scanner's checks, not all Haravan compliance or runtime execution.
- Mutation QA binds a cursor/generation baseline captured before mutation and an acknowledgment belonging to that mutation. Missing required barrier/receipt is INCONCLUSIVE. Caller omission of a baseline cannot reclassify a known mutation session as read-only.
- Pure read-only QA does not wait for a nonexistent upload. Both paths require current-target reload/capture identity and settled-page evidence.
- Authoritative capture cannot opt out of required settlement. Diagnostic paths may report missing capability, but never produce authoritative PASS. Reuse existing settle/quiescence and generation guards; do not duplicate waits without inspecting their coverage.

## Files and steps

1. Read `src/main/qa/theme-qa-workflow.ts`, `src/main/qa/haravan-sync-barrier.ts`, `src/main/qa/theme-mutation-session.ts`, `src/main/qa/theme-transaction-registry.ts`, `src/main/verification/capture-settle.ts` and browser port contracts. Resolve actual producers/consumers through LSP references before changing exported types.
2. Trace mutation ownership, baseline timing, reload generation and receipt propagation end-to-end. Preserve existing transaction metadata; add no caller-controlled bypass switch.
3. Update matrix measurement validation, nullable scores, coverage, derived details and terminal verdict handling together. Migrate every renderer, serializer and summary consumer affected by nullable fields.
4. Wire the missing lifecycle boundaries using actual source signatures. Require synchronization only where a mutation occurred, require settle for certification, propagate cancellation and stale-target failures without retries against old artifacts.
5. Update existing focused tests at discovered owning suites and consumer contracts. No speculative copy-paste code or guessed test filenames in this plan.

## Verification

Exercise omitted viewports; populated object with null, NaN or infinite mismatch and passed true; partial coverage; genuine all-case pass; one failed case; absent compliance scan; mutation with missing baseline/barrier; acknowledgment preceding mutation; stale generation; incomplete/absent settle; and pure read-only QA. Invalid/absent evidence must remain INCONCLUSIVE; a legitimate complete run can PASS. Smoke the actual QA entry point and affected UI serialization, not only a helper.

## Risks and rollback

Nullable scores affect downstream consumers; discover and migrate all before validation. Watcher logs may not identify the intended mutation; require lineage rather than any matching completion text. Roll back only owned changes with approval where destructive operations are involved; preserve user work and historical artifacts. Never restore false PASS as an operational workaround.
