---
title: "Phase 2: Run and Attachment Authority"
status: completed
priority: P1
effort: "5-8d"
dependencies: [1]
---

# Phase 2: Run and Attachment Authority

## Overview

Make RunService the source of truth for Run/ExecutionAttempt existence,
lineage, lifecycle, and terminal transitions, with a narrow live attachment
registry for secret/process/replay state. The registry is an index owned by
RunService; it is not a second control plane and cannot authenticate IDs that
it did not issue.

## Requirements

- Issue attachments only for a known Run and prepared active Attempt. Bind
  project, workspace, chat, run, attempt, backend, runtime, host epoch, grant,
  immutable `tabId` and browser epoch, a Main-owned current document cursor,
  authenticated connection/session state, issue/expiry times, and revocation
  state.
- Store only a one-way secret hash in Main state. Compare supplied secrets in
  constant time. Never return the raw secret through runtime binding, logs,
  receipts, events, or renderer IPC.
- Verify Run exists and belongs to project/workspace; Attempt exists and has the
  exact `runId`, project, workspace, chat, and backend lineage; Attempt state is
  dispatching/running/waiting-tool as appropriate; attachment is not expired,
  revoked, or stale.
- Bind child-adapter requests using the high-entropy secret, authenticated
  connection handshake, and Main-owned `ChildProcess` liveness record. PID is
  diagnostic only and cannot authenticate a request; reject an unknown or
  recycled connection/session.
- Bind browser capabilities to the issued `tabId` and browser epoch. A caller
  cannot replace those fields or the Main-owned document cursor in payload
  context. Successful navigation/load updates the cursor in Main; a stale
  same-document expected generation rejects before execution.
- Revoke on cancel, terminal Attempt state, process exit, runtime drain, host
  epoch change, and shutdown. Recovery must invalidate all pre-crash secrets.
- An `interrupted` or `unknown` Attempt cannot be restarted directly. Require
  explicit reconciliation, record the resume/retry decision, and issue a new
  attachment before starting a new Attempt; never auto-replay an unknown
  mutation.

## Current source anchors

- `src/main/run/run-service.ts:17-23` currently stores Runs, Attempts, and
  receipt maps in one service; `:25-77` creates Attempts; `:99-108` cancels;
  `:112-176` applies backend events.
- `src/shared/control-plane-contracts.ts:43-67` defines Run/Attempt records and
  `:126-136` currently accepts optional IDs in request context.
- `src/main/tools/capability-catalogue.ts:44-56` has no Run/Attempt lookup or
  process/attachment validation.
- `src/main/control-plane/control-plane-runtime.ts:45-60` constructs RunService
  and CapabilityCatalogue but does not connect them.

## Architecture

```text
RunService
  startup hydrate -> open external transports
  createRun -> start -> prepare Attempt
                    |
                    +-> issue attachment (registry record + secret hash)
                    +-> child backend spawn
                    +-> bind connection/session and ChildProcess liveness
                    +-> activate child MCP channel
                    |
  validateAttachment(claims, connection, invocationIdentity)
       |  lookup hydrated Run + Attempt from this service
       |  compare immutable lineage/tab/browser epoch and live cursor
       |  reserve transport-issued identity in a bounded atomic window
       v
  AuthenticatedCapabilityContext
```

The registry API should expose operations such as `issue`, `bindProcess`,
`activate`, `validate`, `revoke`, `revokeForAttempt`, and
`invalidateAllForHostEpoch`. `validate` returns a derived context or a typed
`CapabilityError`; it never returns an arbitrary caller target. RunService
calls it before the transport adapter and records attachment/rejection events
without raw secrets.

Standard MCP tool arguments do not carry a custom cryptographic nonce. The
authoritative transport assigns connection-scoped invocation identity and
ordering, then applies bounded atomic deduplication for mutation calls. A
replayed transport frame cannot execute a mutation twice; an expired or
revoked attachment remains stale rather than becoming a new session.

## Related Code Files

- Create or modify: `src/main/run/execution-attachment-registry.ts`
- Modify: `src/main/run/run-service.ts`
- Modify: `src/main/control-plane/control-plane-runtime.ts`
- Modify: `src/shared/control-plane-contracts.ts`
- Modify: `src/main/agent/execution-backend.ts`
- Modify: `src/main/tools/capability-transport.ts`
- Modify: `test/main/run-lifecycle.test.ts`
- Create or modify: `test/main/execution-attachment-registry.test.ts`

## Implementation Steps

1. Add the registry record/state machine and stable error codes. Keep the raw
   token out of returned records and use a bounded expiry and bounded
   transport-invocation deduplication window.
2. Hydrate Run/Attempt projections from durable events/receipts during runtime
   startup before opening external transports. Add RunService APIs that
   issue/revoke/validate attachments against that hydrated state.
3. Change `CapabilityTransportAdapter.dispatch()` to accept the authenticated
   result or an attachment-validation dependency, rather than trusting raw
   `runId`, `attemptId`, or target fields from the request.
4. Ensure status/cancel/terminal event transitions revoke attachments at the
   same ownership boundary. Make late events unable to reactivate an attempt;
   preserve an intentional `interrupted` state when cancellation causes a
   backend exit event.
5. Add the negative matrix below before wiring MCP callers.

## Mandatory rejection matrix

| No attachment/secret | `ATTACHMENT_REQUIRED` | catalogue lookup/executor |
| Random or malformed secret | `ATTACHMENT_INVALID` | Run/Attempt mutation |
| Unknown `runId` or `attemptId` claim | `LINEAGE_MISMATCH` | executor |
| Attempt belongs to another Run/project/workspace | `LINEAGE_MISMATCH` | executor |
| Caller changes only `runId` or only `attemptId` | `LINEAGE_MISMATCH` | executor |
| Expired, revoked, host-old, or stale attachment | `ATTACHMENT_STALE` | executor |
| Attempt completed, failed, interrupted, or unknown | `ATTEMPT_NOT_ACTIVE` | executor |
| Connection/session secret or Main-owned ChildProcess liveness mismatch | `PROCESS_MISMATCH` | executor |
| Caller changes grant | `POLICY_DENIED` or `ATTACHMENT_INVALID` | executor |
| Caller changes tab or browser epoch | `TARGET_MISMATCH` | browser executor |
| Caller supplies an old same-document expected generation | `TARGET_STALE` | browser executor |

## Success Criteria

- [ ] `runId`/`attemptId` are accepted as claims only and cannot create or
      authenticate a Run/Attempt.
- [ ] Startup hydration completes before external transports open; failed
      hydration disables attachment validation and external MCP.
- [ ] Authority tests cover every mandatory rejection row and assert the side
      effect spy count remains zero.
- [ ] A valid attachment derives exact Run/Attempt/project/workspace/tab/
      browser-epoch context even when payload omits those fields; document
      generation comes from the current Main cursor.
- [ ] Explicit `tabId` cannot override the attachment target.
- [ ] Navigation/load advances the Main cursor, while stale same-document
      expectations reject without blocking later valid navigation steps.
- [ ] Cancel, terminal status, drain, restart, and host-epoch changes revoke
      or invalidate attachment state.
- [ ] Late/replayed backend events cannot reopen a completed or revoked Attempt,
      and cancellation cannot be overwritten by a post-kill failure event.

## Risks and rollback

Do not make the registry a free-standing identity store. If in-memory maps are
not yet durable, recovery must conservatively mark all active attachments
invalid and attempts interrupted/unknown; it must not reconstruct secrets from
payloads or receipts. Keep the old transport disabled for external CLI until
validation is the only entry into capability execution.
