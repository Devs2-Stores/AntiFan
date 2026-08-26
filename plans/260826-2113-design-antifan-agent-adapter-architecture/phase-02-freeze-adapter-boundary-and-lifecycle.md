---
title: "Phase 2: Freeze adapter boundary and lifecycle"
status: complete
---

# Phase 2: Freeze adapter boundary and lifecycle

## Overview

Define the AntiFan-owned adapter contract before any concrete runtime migration. The contract must be narrow enough to preserve control-plane authority and rich enough to represent streaming output, approvals, cancellation, session identity, capability negotiation, reconnect/resume, receipt enforcement, and terminal outcomes.

## Requirements

- [x] Separate runtime translation from AntiFan orchestration, browser authority, policy, persistence, and evidence ownership.
- [x] Define stable input/output types for adapter identity, launch context, session references, normalized events, capabilities, approval requests, cancellation, and terminal status.
- [x] Define lifecycle states and legal transitions, including initialize, session creation/loading/resume, prompt/run, update streaming, cancellation, completion, failure, and disposal.
- [x] Define event identity and ordering rules so duplicate, late, malformed, or out-of-order runtime records cannot corrupt a run.
- [x] Preserve current `ExecutionBackend` compatibility during migration; avoid a flag-day replacement of existing callers while propagating `requiresAuthoritativeReceipt` security flags without downgrading.

## Implementation Steps

1. Write the ownership table: control plane owns run IDs, user/project context, executable allowlisting, browser registration, approvals, evidence, persistence, and final verification; adapters own runtime process/protocol translation only.
2. Introduce a runtime-neutral adapter input containing validated executable/runtime selection, run/session identifiers, prompt payload, approved capability set, timeout, and cancellation signal.
3. Introduce a runtime-neutral event union covering assistant messages, tool intent/result, approval request, status/progress, diagnostics, session state, completion, cancellation, and failure.
4. Define adapter methods around `initialize`, `createSession`/`loadSession`/`resumeSession`, `prompt`, `cancel`, and `dispose`, with `ExecutionBackend` as the compatibility facade until all callers migrate.
5. Specify invariants: one terminal outcome per run, monotonic sequence numbers, stable opaque IDs, bounded payloads, no adapter-originated browser authority, authoritative receipt propagation, and cleanup on every terminal path.
6. Specify control-plane event guard requirements at the compatibility boundary in `src/main/run/run-service.ts`: accept only the current run/attempt identity, reject or record duplicate/late events after a terminal outcome, and make cancellation win over post-kill runtime exit status unless an authoritative receipt proves otherwise.
7. Require adapter process cleanup in a `finally`-equivalent path owned by the concrete adapter, including consumer-thrown errors from `applyEvent()`, malformed/oversized records, cancellation, timeout, spawn failure, and disposal.

## Todo

- [x] Document ownership and forbidden authority crossings
- [x] Define adapter contract and normalized event model
- [x] Define lifecycle state machine and terminal invariants
- [x] Define compatibility facade and migration rule

## Success Criteria

- [x] A future adapter can be implemented without importing Codex-specific event names into the control plane.
- [x] Existing Codex callers can continue through an adapter-backed compatibility facade during incremental migration.
- [x] `AdapterExecutionBackendWrapper` faithfully propagates `requiresAuthoritativeReceipt` to preserve security enforcement.
- [x] Every lifecycle transition has success, error, cancellation, and cleanup behavior.
- [x] The contract makes malformed, duplicate, late, and unsupported events observable and non-authoritative.
