---
title: "Phase 6: Capability Broker, Leases, Receipts, And Checkpoints"
status: done
---

# Phase 6: Capability Broker, Leases, Receipts, And Checkpoints

## Overview

Create the Main-side Project CapabilityBroker that validates and executes every
browser, workspace, terminal, process, artifact, and checkpoint operation with
immutable targets, leases, policy checks, and durable receipts.

## Requirements

- Utility cannot call production side-effect services directly.
- Capability lookup is scoped by ProjectRuntime and validated against sender/run.
- Read and mutation capabilities are classified explicitly.
- Workspace mutation serializes per Workspace; browser mutation serializes per tab.
- Dispatched/accepted mutations survive timeout and IPC loss as queryable state.
- An accepted mutation with no terminal receipt becomes `unknown`; it is never
  replayed automatically.
- Checkpoint restore validates path containment, type, hash, mode, generation,
  symlink/reparse status, and conflict preconditions.
- Haravan/HRV commands remain separately approval-gated and are not automated.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Add | `src/main/capabilities/capability-broker.ts` | Project-scoped validation, dispatch, policy, receipt coordination |
| Add | `src/main/capabilities/lease-manager.ts` | Workspace/tab/terminal resource leases and owner epochs |
| Add | `src/main/capabilities/browser-capability-adapter.ts` | Explicit Project tab inspection/control through NativeTabHost |
| Add | `src/main/capabilities/workspace-capability-adapter.ts` | Safe read/search/write/hash-edit/checkpoint operations |
| Add | `src/main/capabilities/terminal-capability-adapter.ts` | Command/PTy/process execution with Project/Workspace ownership |
| Add | `src/main/capabilities/checkpoint-service.ts` | Content-addressed checkpoint manifests and conflict-aware restore |
| Modify | `src/main/services/hash-anchored-editor.ts` | Broker target/revision/receipt integration |
| Modify | `src/main/security-policy.ts` | Capability-level command, path, URL, and high-risk policy |
| Modify | `src/main/mcp/mcp-tool-contract.ts` | Reuse capability classifications without becoming Harness backend |
| Modify | `src/main/mcp/live-browser-service.ts` | Broker adapter and durable receipt queries |
| Modify | `src/main/mcp/node-reference-store.ts` | Project/browser epoch/document generation ownership |
| Add | `test/main/capability-broker.test.ts` | Authorization, routing, idempotency, timeout, and result budget tests |
| Add | `test/main/resource-lease.test.ts` | conflict, expiry, revocation, epoch rotation, and release tests |
| Add | `test/main/checkpoint-service.test.ts` | create/modify/delete/new/binary/symlink/conflict/outside-root tests |
| Add | `test/main/mutation-reconciliation.test.ts` | prepared through unknown/compensated crash matrix |

## Implementation Steps

1. Define one catalogue of capabilities, input/output schemas, side-effect class,
   lease mode, timeout, payload budget, policy, and reconciliation behavior.
2. Route every request through ProjectRuntime and verify run ownership, immutable
   Workspace/browser target, expected revisions/generations, and lease.
3. Persist mutation `prepared` before dispatch, then `dispatched`, authority
   `accepted`, and terminal state. Store before/after digests or artifact refs.
4. Add idempotency keys so duplicate pre-acceptance dispatch returns the original
   receipt; never re-execute an accepted unknown operation.
5. Add workspace shared-read/exclusive-write leases and per-tab browser mutation
   queues. Keep UI navigation distinct from Harness navigation. Every queued
   operation revalidates its binding before dispatch and after result; user
   navigation, tab replacement, close, or runtime-instance change revokes it.
6. Extract safe file/search/hash-edit/terminal/browser behavior from AgentEngine;
   do not carry over mutable workspace/tab lookup or DSH parser state.
7. Implement checkpoint manifests using workspace-relative canonical paths and
   content-addressed blobs. Restore uses an immutable plan, before-digests,
   staged writes, per-entry receipts, atomic rename where possible, a commit
   marker, and explicit crash recovery/compensation rules.
8. Reconcile late completion after timeout/cancel and expose explicit status to
   renderer/Utility.

## Concurrency Rules

| Resource | Read | Mutation |
|----------|------|----------|
| Project metadata | snapshot/revision | short transaction |
| Workspace files | best-effort per-file hash/metadata with revalidation, or explicit snapshot | one exclusive lease per Workspace |
| Browser Project tab list | concurrent bounded snapshot | n/a |
| Browser tab/document | concurrent at exact generation | serialized per tab |
| Terminal | snapshot output | one ordered writer per terminal |
| Checkpoint restore | inspect manifest | exclusive Workspace lease |

## Validation

- Focus/window/workspace/tab switches cannot redirect a queued or active tool.
- Duplicate requests around every mutation state execute at most once.
- Timeout/cancel does not falsely claim an underlying accepted side effect stopped.
- Cross-project resource IDs, stale hashes, stale/future generations, missing
  leases, traversal, symlink/reparse, and policy-denied commands fail closed.
- Main restart reconciles all nonterminal journal entries without blind replay.
- Receipts record before/after browser bindings and distinguish committed success,
  stale-after-execution, and delivery unknown.
- Crash injection after every checkpoint restore entry either completes the
  verified plan or reports recoverable partial/compensation state; never silent
  half-restore success.

## Success Criteria

Every production side effect has one Project-scoped authority path, immutable
target, lease/policy decision, durable receipt, and deterministic reconciliation.

## Risks And Rollback

This broker is the highest-risk shared Main boundary. Keep adapters narrow,
separately tested, output-bounded, and free of fallback resolution. Do not enable
background or concurrent mutation before the full crash matrix passes.
