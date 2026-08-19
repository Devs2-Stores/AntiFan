---
title: "Phase 7: New Renderer, Preload, Chat, And Run Path"
status: done
---

# Phase 7: New Renderer, Preload, Chat, And Run Path

## Overview

Build and verify the new Project-window path as a thin client of Main-owned
Project/chat/run truth. Add versioned preload APIs, sender-validated routing,
durable turn creation, scoped subscriptions, and event replay. Production
authority remains on the old path until Phase 10 migration reaches `verified`
and performs the single atomic cutover.

## Requirements

- A renderer belongs to one ProjectRuntime for its entire window lifetime.
- Preload exposes explicit Project, Workspace, chat, run, browser, annotation,
  terminal, and QA clients instead of unversioned generic action bags.
- Main validates request schema, Project ownership, protocol version, and payload
  budget before dispatch.
- Run events route only to owning Project/chat/requesting window and can replay.
- Renderer stores UI preferences only; credentials, chat truth, run truth, and
  evidence bytes are Main-owned.
- Turn plus attachments is committed atomically before composer state clears.
- Duplicate switch cases, listeners, event names, and Main/preload/renderer
  contract mismatches fail static tests.
- New and old paths never register parallel listeners in one renderer/window;
  isolated test entrypoints or build-time routing select exactly one path.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `src/preload/app-preload.ts` | Versioned Project/Harness/browser/terminal/annotation/QA clients |
| Modify | `src/preload/index.ts` | Strict event allowlist and scoped subscriptions |
| Modify | `src/main/index.ts` | Remove duplicate/global action handlers; sender-owned routing |
| Modify | `src/renderer/app.ts` | Main-owned sessions/runs, event replay, no raw credentials/base64 |
| Modify | `src/renderer/index.html` | Project identity/window actions and durable run status surfaces |
| Modify | `src/renderer/components/comment-composer.ts` | Attachment IDs and atomic submit semantics |
| Add | `test/main/ipc-project-routing.test.ts` | Sender ownership, schema, version, and cross-project rejection |
| Modify | `test/main/renderer-ipc-contract.test.ts` | Duplicate case/listener, event allowlist, and parity scanner |
| Add | `test/main/chat-turn-atomicity.test.ts` | duplicate submit, retry, attachment, and renderer reload tests |
| Add | `test/e2e/project-chat-reconnect.cjs` | Project window reload and run event replay smoke |

## Implementation Steps

1. Define preload clients from shared versioned schemas and remove generic
   renderer-to-Main payloads from new paths.
2. Bind each Project renderer WebContents to its runtime at creation; reject any
   request whose explicit Project ID does not match sender ownership.
3. Replace renderer-built history/system prompt/global stream flags with
   Main-owned ChatSession/Turn/Run snapshots and sequence-based subscriptions.
4. Commit user Turn and attachment references using `clientRequestId`; acknowledge
   durable acceptance before clearing composer or starting Utility work.
5. Route run, tool, question, usage, completion, and error events by Project,
   ChatSession, Run, and sequence; support snapshot plus `eventsSince` recovery.
6. Remove renderer localStorage API keys and raw auth status. Keep only provider
   profile selection and redacted connection state.
7. Consolidate duplicate workspace/chat IPC cases and add static parity checks for
   action/event names and duplicate DOM listeners.
8. Show explicit states for queued, running, awaiting user, interrupted, unknown
   mutation, stale browser target, and reconciliation required.
9. Keep activation dormant outside test/internal routing. Emit a cutover-readiness
   report consumed by Phase 10; do not claim production authority here.

## Chat Semantics

- New chat requires an existing Project Workspace selection.
- Switching sidebar chat changes visible state only; it does not redirect an
  existing run, terminal, or browser binding.
- Evidence attachments are immutable references on a Turn.
- Retry creates a new run attempt linked to the original; it never reuses an
  accepted mutation idempotency key blindly.

## Validation

- Two Project windows receive only their own events, even with colliding local IDs.
- Duplicate click/send, delayed event, reload, reconnect, and out-of-order event
  cases render one durable Turn and one run timeline.
- Main/preload/renderer message matrix has exact parity and every DOM element ID
  has at most one relevant listener binding.
- Renderer storage and IPC dumps contain no raw credentials or artifact bytes.

## Success Criteria

The new Project renderer path does not act as authority for chat history or run
state, passes integration gates, and is ready for one Phase 10 activation.

## Risks And Rollback

`src/renderer/app.ts` is a large shared hotspot. Build vertical Project/chat/run
slices behind isolated test routing, then activate once in Phase 10; never leave
two listeners or IPC bridges active in one renderer.
