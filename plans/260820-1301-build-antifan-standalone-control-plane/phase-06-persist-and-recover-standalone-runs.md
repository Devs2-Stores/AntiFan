---
phase: 6
title: "Persist and recover standalone runs"
status: completed
priority: P1
effort: "5d"
dependencies: [3, 5]
---

# Phase 6: Persist and Recover Standalone Runs

## Overview

Make Chat/Run/Attempt events and mutation receipts durable, replayable, versioned,
and safe across crashes, timeouts, and late evidence.

## Requirements

- Functional: append/replay events, derive Chat projection, recover interrupted
  turns, reconcile late receipts, and resume provider sessions when exact refs
  remain valid.
- Non-functional: atomic writes, schema/version checks, bounded retention,
  privacy/redaction, and deterministic idempotency.

## Architecture

Use an AntiFan-owned append-only JSONL store first, with a header containing
format version and Project/Workspace lineage. Keep event facts separate from
live hooks. A single receipt authority replaces the in-memory pending list and
unused parallel ledgers.

## Related Code Files

- Create: `src/main/session/event-store.ts`, `src/main/session/run-recovery.ts`, `src/main/session/receipt-store.ts`
- Modify: `src/main/bridge/delivery-ledger.ts`, `src/main/browser/native-tab-host.ts`
- Create: `test/main/event-store-recovery.test.ts`, `test/main/receipt-store.test.ts`, `test/main/run-recovery.test.ts`

## Implementation Steps

1. Define minimum events: turn/start/end, step/start/end, user/message,
   assistant/chunk/message, tool/call/result, approval, backend status, and
   receipt transitions.
2. Persist an expected binding before dispatch: command ID, prompt digest,
   canonical Workspace identity, host epoch/instance, backend session ref, and
   attachment artifact IDs. Immediate and late receipts must require every field
   exactly; omitted fields are invalid, not wildcard matches.
3. Add append flush/checkpoint, corrupt-final-line repair, unknown/future version
   rejection, and interrupted-turn synthetic closure.
4. On startup, load the store before accepting new work, rebuild queued/running/
   unknown attempts, and reconcile only persisted expected bindings. IO/parse
   failures fail closed and remain visible; they never silently reset to empty.
5. Implement timeout -> `unknown`, late exact reconciliation, and no automatic
   retry for mutations or paid model requests.
6. Add close/reopen/replay tests for queued, running, completed, interrupted,
   unknown, and late-receipt cases.

## Success Criteria

- [x] Replaying the store reconstructs model-visible input, tool outcomes, and
  Chat projection without reading Antigravity transcript files.
- [x] A crash at every dispatch boundary yields one deterministic state.
- [x] Restart reconstructs pending work and owns reconciliation before any new
      dispatch; corrupt storage fails closed instead of erasing history.
- [x] Late evidence is accepted only when command ID, digest, Workspace, and
  host epoch match the original attempt.
- [x] Existing delivery tests migrate to one durable authority.
- [x] A crash during command claim cannot cause a second execution; claim and
      processing use an atomic state transition or durable idempotency record.

## Risk Assessment

Event format becomes durable product data. Version it independently of DSH,
reject unknown formats, and add migration/export tests before broad rollout.
