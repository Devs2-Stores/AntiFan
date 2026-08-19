---
title: "Phase 1: Contracts And Characterization"
status: done
---

# Phase 1: Contracts And Characterization

## Overview

Freeze current behavior with characterization tests, then define the versioned
Project, Workspace, browser, evidence, Harness, event, lease, mutation, and
artifact contracts required by every later phase.

## Requirements

- Project UUID is mandatory on every project-owned resource and IPC message.
- Sender window ownership is part of authorization, not just routing metadata.
- Browser generations use exact equality; future and stale generations fail.
- Run/turn/mutation/event IDs and revisions are durable and idempotent.
- Protocol payloads have size limits and reject unknown versions before effects.
- No raw Electron object, credential, cookie, screenshot base64, or unbounded DOM
  payload appears in shared contracts.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Add | `src/shared/project-contract.ts` | Project, Workspace, ChatSession, terminal/process ownership DTOs |
| Add | `src/shared/harness-contract.ts` | HarnessRun, Step, ContextManifest, lease, receipt, mutation, event states |
| Add | `src/shared/harness-protocol.ts` | Versioned request/response/event envelopes and handshake |
| Modify | `src/shared/evidence-contract.ts` | Project/browser binding, SelectionEvidence, AnnotationSet, QaRun/QaTarget, CaptureRef |
| Modify | `src/shared/protocol.ts` | Remove ambiguous global DTO assumptions and reference versioned contracts |
| Modify | `src/main/browser/tab-manager.ts` | Exact generation semantics and project-owned tab identity |
| Add | `test/main/project-contract.test.ts` | Ownership and serialization invariants |
| Add | `test/main/harness-protocol.test.ts` | Version, schema, idempotency, payload, and event sequencing tests |
| Add | `test/main/browser-binding-contract.test.ts` | Stale/future generation and browser epoch tests |

## Implementation Steps

1. Record current global singleton, IPC, active-tab, workspace, chat, provider,
   terminal, browser session, annotation, and QA behavior in focused tests.
2. Define durable IDs, revisions, UTC timestamps, lifecycle states, error codes,
   and cross-process opaque handles.
3. Define `ProjectBinding`, `WorkspaceBinding`, `BrowserBinding`, `RunTarget`,
   `ResourceLease`, `MutationReceipt`, `ArtifactRef`, `DevServerBinding`, and
   ordered event envelopes.
4. Define accepted run states and the separate prepared/dispatched/accepted/
   terminal mutation state machine.
5. Add exact target validation helpers with no fallback to focused/active state.
6. Add payload budgets for text, tool results, DOM snapshots, captures, and event
   replay pages.

## Contract Checklist

- [ ] `Project` is path-independent and owns a stable Chromium partition ID.
- [ ] `Workspace` contains canonical path, fingerprint, generation, and state.
- [ ] `ChatSession` requires Project and Workspace ownership.
- [ ] `HarnessRun` captures immutable ownership and initial browser binding.
- [ ] `BrowserBinding` contains Project, browser epoch, tab runtime instance,
  WebContents, and exact document generation.
- [ ] `MutationReceipt` distinguishes acceptance from completion/failure/unknown.
- [ ] `RunEvent` has monotonic per-run sequence and replay cursor.
- [ ] `ArtifactRef` contains hash, size, MIME, retention, and owning Project.
- [ ] Errors distinguish stale target, wrong Project, lease conflict, timeout, cancelled, delivery unknown, and policy denial.

## Validation

- Compile-time exhaustiveness for every discriminated union.
- Round-trip serialization and malformed/oversize/version-mismatch rejection.
- Exact generation tests for stale, current, and future values.
- Cross-project ID injection rejected even when local resource IDs collide.
- Existing tests remain green before production code moves to new contracts.

## Success Criteria

All later phases can depend on one reviewed set of serializable contracts, and
characterization tests demonstrate every unsafe current fallback that the
migration must remove.

## Risks And Rollback

Contract churn creates expensive downstream rework. Keep Phase 1 behavior-free,
version the protocol immediately, and change contracts only through explicit
compatibility tests.
