---
phase: 4
title: "Build Durable Exact Routing and Receipt Reconciliation"
status: completed
priority: P0
effort: "1.5-2 days"
dependencies: [1, 3]
---

# Phase 4: Build Durable Exact Routing and Receipt Reconciliation

## Context Links

- [Plan](./plan.md)
- Phase 3 compatibility evidence is a hard dependency.
- Review findings H2-H4, H10-H11 in
  [deep review](../reports/260820-0851-antifan-antigravity-deep-code-review.md)

## Overview

Replace timeout races and filename trust with a versioned, authenticated,
fully-bound, crash-durable protocol. Retain terminal receipts until explicit
acknowledgement so Desktop can reconcile late success across restarts.

## Requirements

- Bump incompatible contracts rather than silently accepting mixed versions.
- Every request/receipt binds command, source command, workspace, conversation,
  route, prompt digest, attachment-set digest, client/host/Sidecar instance,
  issued time, execution deadline, and receipt deadline.
- No fixed fallback HMAC key. Missing/unreadable key means capability offline.
- HMAC validation rejects bad encoding/length without throwing.
- Atomic rename owns claim transitions; external invocation starts only after a
  durable `invoking` record exists.
- Crash recovery never overwrites a verified terminal receipt with `unknown`.
- Producer retains receipt until a verified Desktop acknowledgement or bounded
  retention expiry.
- Absolute deadlines propagate unchanged; no layer grants fresh lifetime.
- Provider timeout terminates the process tree, waits for exit/grace, and keeps
  `unknown` when termination cannot be proven.
- Late authoritative receipt can refine `unknown`; no state transition causes
  automatic resend.

## Protocol Design

Use outer bridge protocol v3 and Sidecar protocol v2 (names may follow existing
project conventions, but mixed old/new documents must be rejected).

Minimum immutable fields:

```text
commandId, sourceCommandId, workspaceId/path, conversationId, requestedRoute,
promptDigest, attachmentSetDigest, clientInstanceId, hostInstanceId,
expectedSidecarInstanceId, issuedAtEpochMs, executeDeadlineAtEpochMs,
receiptDeadlineAtEpochMs, protocolVersion
```

Durable Sidecar state machine:

```text
command -> claimed -> invoking -> receipt -> completed -> acknowledged
```

Recovery rules:

```text
verified receipt exists       => re-emit it; never downgrade
invoking without receipt      => unknown, mayHaveInvoked=true
claimed before invoking       => failed, mayHaveInvoked=false
completed without ack         => retain/re-emit receipt
malformed/unbound document    => quarantine and typed failure, no invocation
```

## Related Code Files

- Modify: `E:/Work/apps/antigravity-browser/src/desktopBridge.ts`
- Modify: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts`
- Modify: `E:/Work/apps/antigravity-browser/src/sidecarRouterClient.ts`
- Modify: `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/router.mjs`
- Modify: packaged AgentAPI runtime helper created in Phase 1
- Modify: `src/shared/contracts.ts`
- Modify: `src/main/bridge/antigravity-command-client.ts`
- Create/Modify: protocol, malformed HMAC, binding, deadline, crash-boundary,
  multi-instance, child-lifecycle, acknowledgement, and late-receipt tests in
  both repositories

## Implementation Steps

1. Define versioned schemas and canonical serialization once per repository;
   reject unknown fields when they affect authority or identity.
2. Provision an owned per-user pairing/auth secret outside workspace data.
   Remove all fixed fallback values and expose offline diagnostics when absent.
3. Validate auth tag format and equal byte lengths before `timingSafeEqual`.
4. Validate every receipt against the original request object, not only its
   filename or schema shape.
5. Replace Sidecar write-plus-unlink claim with atomic rename into an owned
   processing path. Use atomic temp-write/rename for every state record.
6. Persist and sync `invoking` before spawn. If persistence fails, do not invoke.
7. Write immutable signed receipt, then completed marker referencing the receipt
   digest. Recovery checks receipt/completed before emitting ambiguity.
8. Apply equivalent recovery to Extension `.processing.*` commands. Startup
   must produce/re-emit a bound result rather than ignore/delete claims.
9. Add explicit Desktop acknowledgement. Keep receipts through acknowledgement
   or retention cleanup; cleanup never removes an unacknowledged recent receipt.
10. Replace relative timeout constants with propagated absolute execution and
    receipt deadlines. Each layer calculates remaining budget and fails before
    starting work with no budget.
11. Implement Windows process-tree termination with graceful wait, bounded hard
    kill, and exit observation. Reject unsafe `.cmd`/`.bat` direct spawn unless
    Phase 3 proved a safe wrapper.
12. Add Desktop durable pending ledger and background/startup reconciler for up
    to 10 minutes. Reconciliation accepts only verified bound receipts.
13. Represent `failed` with `mayHaveInvoked=false`; all ambiguous boundaries are
    `unknown` with no automated retry.

## Todo

- [ ] Version and validate full command/receipt schemas.
- [ ] Remove fallback keys and implement safe HMAC verification.
- [ ] Bind receipts to original requests and instances.
- [ ] Implement atomic claim and durable invocation marker.
- [ ] Implement receipt/completed/ack lifecycle and recovery.
- [ ] Propagate absolute execution/receipt deadlines.
- [ ] Terminate and observe child process trees.
- [ ] Add durable Desktop late-receipt ledger/reconciler.
- [ ] Add crash-boundary and multi-instance test matrix.

## Validation Matrix

| Case | Expected result |
|---|---|
| Forged/mismatched command ID | Rejected, no UI state change |
| Wrong workspace/conversation/digest/instance | Rejected, no invocation |
| Short/malformed auth tag | Typed failure, router remains live |
| Crash before invoking marker | `failed`, `mayHaveInvoked=false` |
| Crash after invoking marker | `unknown`, no auto retry |
| Crash after receipt before completed | Verified receipt re-emitted |
| Extension restart with processing file | Bound result recovered/re-emitted |
| Acceptance after Desktop foreground timeout | Late receipt refines `unknown` |
| Transcript response without receipt | Delivery stays `unknown` |
| Child ignores graceful termination | Hard-kill attempt, still `unknown` if exit unproven |

## Success Criteria

- [ ] No schema-shaped or filename-only receipt is accepted.
- [ ] No crash point can produce a false safe-to-retry state after invocation.
- [ ] Duplicate requests re-emit one stored terminal receipt without re-invoking.
- [ ] Deadline order is 18s execution, 22s Extension receipt, 30s Desktop wait.
- [ ] Late signed receipt reconciles across Desktop/Extension restart.
- [ ] All crash, malformed, deadline, and acknowledgement tests pass.

## Risks and Rollback

Protocol migration can strand old files. Quarantine unsupported versions with
diagnostics; do not auto-upgrade legacy commands. Rollback disables exact Auto
and preserves new ledgers/receipts read-only for diagnosis.
