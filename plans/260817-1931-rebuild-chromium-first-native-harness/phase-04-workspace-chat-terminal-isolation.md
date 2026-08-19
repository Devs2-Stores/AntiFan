---
title: "Phase 4: Workspace, Chat, Terminal, And Process Isolation"
status: done
---

# Phase 4: Workspace, Chat, Terminal, And Process Isolation

## Overview

Make Workspace the immutable code-execution scope inside a Project. Bind chats,
terminals, processes, memory, skills, checkpoints, and future runs to explicit
Project/Workspace identities instead of a mutable global folder.

## Requirements

- A Project may register multiple folders/worktrees as Workspaces.
- Each ChatSession belongs to one Project and exactly one Workspace.
- Existing chats, terminals, processes, and runs never change target when the
  selected Workspace or focused window changes.
- Terminals are owned by a Project TerminalManager but bind permanently to
  `{projectId, workspaceId, cwd}`.
- Harness command execution is journaled separately from interactive PTYs.
- Long-running processes record PID, process birth/start token, executable,
  parent/group identity, command, cwd, port, owner, lifecycle, and shutdown result;
  deterministic ports replace increment-on-conflict behavior.
- Workspace containment uses canonical paths and `path.relative`, not prefix
  matching.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Add | `src/main/projects/workspace-registry.ts` | Workspace registration, canonicalization, fingerprint, generation, relocation |
| Add | `src/main/projects/project-chat-service.ts` | Project/Workspace-owned chats, turns, attachments, and active selection |
| Add | `src/main/projects/project-terminal-manager.ts` | Terminal and process ownership per Project/Workspace |
| Modify | `src/main/terminal-service.ts` | Explicit workspace/cwd sessions and tracked execution receipts |
| Modify | `src/main/chat-sync-service.ts` | Legacy import adapter; remove global default `Work` behavior |
| Modify | `src/main/services/project-memory-service.ts` | Explicit Project/Workspace repositories |
| Modify | `src/main/services/skill-sync-service.ts` | Explicit Workspace source and revision |
| Modify | `src/main/services/platform-conventions.ts` | Workspace-scoped platform detection |
| Modify | `src/main/services/agent-persona-service.ts` | Project profile reference without global mutable state |
| Modify | `src/main/index.ts` | Project-aware workspace/chat/terminal/process IPC |
| Add | `test/main/workspace-registry.test.ts` | Canonicalization, relocation, missing, generation, containment tests |
| Add | `test/main/project-chat-service.test.ts` | Project/Workspace ownership, turn ordering, attachment atomicity |
| Add | `test/main/project-terminal-manager.test.ts` | cwd isolation, process tracking, port ownership, cleanup tests |

## Implementation Steps

1. Add Workspace registration with durable UUID, canonical path/folder URI,
   filesystem fingerprint, generation, and active/missing/archived state.
   Project creation atomically registers its default Workspace so the common UX
   remains one Project/one folder without exposing worktree complexity.
2. Distinguish selected Workspace for new UI actions from the immutable Workspace
   already owned by a chat, run, terminal, or process.
3. Replace global chat JSON/default Project values with transactional Project
   chat/turn repositories. Create a Turn atomically with attachment references.
4. Refactor terminal construction so every PTY and command execution receives a
   validated Project/Workspace/cwd at creation and cannot be retargeted.
5. Add a Project process registry for dev servers/watchers with deterministic
   port policy, observable exit, platform process groups/Windows Job Objects where
   available, and clean shutdown ownership.
6. Scope memory, skills, platform detection, and context revisions to the exact
   Workspace used by the run.
7. Add explicit workspace relocation/rebind flow; a missing path fails closed and
   never silently falls back to process cwd.

## Terminal And Process Semantics

- Interactive user PTYs and Harness command executions are different resource
  types even when both use `node-pty`.
- A PTY may remain open across chats in the same Workspace, but another Workspace
  cannot write to it.
- Harness one-shot commands return bounded stdout/stderr artifacts and mutation
  receipts. Long-running commands become tracked Process records.
- Project suspension is blocked while any PTY or tracked process is alive unless
  the user explicitly stops it.

## Validation

- Two Workspaces under one Project can run different commands and dev servers
  without cwd, output, or port leakage.
- Two Projects with identical folder names remain isolated.
- Workspace selection changes do not affect existing chats/terminals/runs.
- Missing, symlinked, relocated, outside-root, and generation-changed paths fail
  according to contract.
- Process shutdown tests prove only owned PIDs are stopped and no ghost process
  remains after runtime close.
- PID reuse and app-restart tests revalidate process birth/executable/group
  identity immediately before termination.

## Success Criteria

Every code, chat, terminal, process, memory, and skill operation has one explicit
Project/Workspace owner, and no API depends on `process.cwd()` or a mutable
AgentEngine workspace after initialization.

## Risks And Rollback

Workspace relocation and existing chat imports can be ambiguous. Preserve the
old source, mark unresolved records `needsBinding`, and require explicit user
selection rather than guessing.
