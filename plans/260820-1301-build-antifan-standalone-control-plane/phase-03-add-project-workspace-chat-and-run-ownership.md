---
phase: 3
title: "Add Project, Workspace, Chat, and Run ownership"
status: completed
priority: P1
effort: "5d"
dependencies: [2]
---

# Phase 3: Add Project, Workspace, Chat, and Run Ownership

## Overview

Create the main-process ownership services that bind conversations, runs,
browser targets, workspaces, and terminal sessions without replacing the
existing renderer or deleting legacy paths.

## Requirements

- Functional: create/open/close Project, Workspace, Chat, and Run records;
  enforce immutable ownership and explicit target selection.
- Non-functional: no global mutable run/chat state; lifecycle transitions are
  observable and idempotent.

## Architecture

`ProjectRegistry` owns project identity and data root. `WorkspaceRegistry` owns
canonical roots. `ChatStore` owns user messages. `RunService` owns attempts and
event projections. `BrowserBinding` and terminal ownership are references, not
active-tab or singleton guesses.

## Related Code Files

- Create: `src/main/project/project-registry.ts`, `src/main/project/workspace-registry.ts`, `src/main/chat/chat-store.ts`, `src/main/run/run-service.ts`
- Modify: `src/main/index.ts`, `src/main/browser/native-tab-host.ts`
- Create: `test/main/project-workspace-ownership.test.ts`, `test/main/run-lifecycle.test.ts`

## Implementation Steps

1. Add registries with canonical IDs, lifecycle states, and explicit attach/
   detach APIs.
2. Bind Chat messages to Project/Workspace and Runs to Chat; persist only
   references initially while the event store is built in Phase 6.
3. Add browser epoch/document-generation checks to mutating commands.
4. Route legacy sidebar actions through an adapter that resolves a target once;
   new APIs reject omitted target IDs.
5. Add lease/ownership tests for restart, stale binding, duplicate close, and
   cross-project access.

## Success Criteria

- [x] No new control-plane mutation uses `getActiveTabId()` or heuristic cwd.
- [x] A Run cannot be attached to another Chat/Workspace after creation.
- [x] Repeated attach/detach/close calls are idempotent and tested.
- [x] Legacy UI remains functional through the compatibility adapter.

## Risk Assessment

The large `NativeTabHost` is a high-coupling seam. Extract one owner at a time,
retain delegation wrappers, and gate each extraction with existing IPC tests.
