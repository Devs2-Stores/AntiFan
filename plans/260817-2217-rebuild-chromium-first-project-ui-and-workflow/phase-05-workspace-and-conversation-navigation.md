---
phase: 5
title: "Workspace And Conversation Navigation"
status: done
priority: P1
effort: "5d"
dependencies: [2, 3]
---

# Phase 5: Workspace And Conversation Navigation

## Overview

Port the existing session/workspace navigation behavior into the Project-scoped
model, then add immutable Workspace ownership, recent-run state, and explicit
Project switch/focus behavior. A ChatSession stays permanently pinned to the
Workspace where it was created.

## Existing Capability Migration Contract

- Existing: session list/actions, workspace display/open-folder behavior, chat
  selection, model/skill/agent entry points, and related Main services.
- Reuse: durable Workspace/chat services and pure list/action behavior that does
  not depend on mutable global selection.
- Required delta: normalized Project snapshot, immutable chat-to-Workspace
  binding, recovery states, Project navigation, and command palette.
- Legacy removal condition: create/select/rename/archive/delete parity plus
  cross-Workspace retarget-denial tests pass.

## Requirements

- Left navigation shows Project identity, Workspace groups, chats, recent run
  state, pinned items, and explicit background Project indicators.
- Add Workspace uses a folder picker, canonical path/fingerprint validation, and
  explicit duplicate/worktree handling.
- Creating a chat requires a selected Workspace and records that immutable binding.
- Selecting another Workspace changes where new chats are created; it never
  retargets existing chats, runs, terminals, or annotations.
- Chat rename/delete/archive actions are durable Main operations with confirmation.
- Search/filter and keyboard navigation work across large chat lists.
- A Project command palette provides keyboard access to Project/Workspace/chat,
  pane, browser utility, terminal, annotation, QA, and settings actions.
- Collapsed navigation retains Project and Workspace identity through tooltips
  and the Binding Rail.
- Empty/missing/needsBinding Workspace states have recovery actions.

## Architecture

Main returns a normalized `ProjectNavigationSnapshot`: Project, ordered
Workspaces, ChatSession summaries, latest run summaries, and replay cursor.
Renderer projects it into a tree but never reconstructs ownership from folder
names or current focus.

Workspace and chat commands use expected revisions. A chat selection is a UI
selection only; a new run receives the chat's persisted Workspace binding.

## User Flows And States

- Add first Workspace and create first chat.
- Add a second checkout/worktree to the same Project.
- Switch Workspace, create new chat, return to an older bound chat.
- Search, rename, pin, archive, and delete chat.
- Missing folder recovery: locate, archive, or remove binding.
- Large list with active background run.
- Collapse/expand navigation and restore width preference per Project window.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/project-contract.ts` | Navigation summaries, archive/pin metadata when absent | Schema/unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Workspace/chat navigation operations and events | Static parity |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/workspace-registry.ts` | Add/rebind/archive/revision operations | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-chat-service.ts` | Workspace-pinned create/rename/archive/delete summaries | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-runtime.ts` | Navigation snapshot and events | Integration |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/index.ts` | Register exact navigation handlers | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/navigation/project-navigation.tsx` | Left navigation container | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/navigation/workspace-group.tsx` | Workspace state and chat grouping | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/navigation/chat-list-item.tsx` | Chat/run state row and actions | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/navigation/navigation-search.tsx` | Filter/keyboard navigation | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/navigation/project-command-palette.tsx` | Keyboard-first scoped actions | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/main/project-navigation-contract.test.ts` | Binding/revision/archive behavior | Unit |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/e2e/workspace-chat-navigation.cjs` | Multi-workspace and chat navigation | Electron E2E |

## Implementation Steps

1. Define normalized navigation snapshot and revisioned operations.
2. Add Workspace picker/rebind/archive flows through Main-owned native dialogs.
3. Enforce Workspace binding at chat creation and prohibit chat retarget operations.
4. Render Project navigation, Workspace groups, chat rows, run status, search,
   rename/archive/delete menus, and empty/recovery states.
5. Keep selected Workspace and selected chat distinct in UI state.
6. Add keyboard navigation, focus management, collapsed state, and persistence.
7. Add a catalog-driven command palette; hide or disable actions whose exact
   Project/Workspace/tab/run target is unavailable.
8. Test duplicate paths, missing folders, large lists, background runs, and
   cross-Workspace retarget attempts.

## Function And Interface Checklist

- [ ] `ProjectNavigationSnapshot` has ordered Workspaces/chats and replay cursor.
- [ ] `createChat(workspaceId, title)` persists immutable Workspace ownership.
- [ ] No `moveChatToWorkspace` or focus-derived run binding exists.
- [ ] `WorkspaceRecoveryAction` is explicit and revision-checked.
- [ ] Navigation selection changes renderer projection only.
- [ ] Search/filter preserves active item and keyboard focus.
- [ ] Command palette actions carry explicit scope and never use global focus fallback.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Switch Workspace while old chat run is active | Run/chat remain on original Workspace |
| Critical | Cross-Project Workspace ID submitted | Rejected before service call |
| High | Folder moved or missing | `needsBinding` state with locate/archive actions |
| High | Rename/delete with stale revision | Conflict UI; snapshot refresh; no lost update |
| Medium | 500 chats across Workspaces | Search/navigation stays responsive and deterministic |
| Medium | Collapsed sidebar | Project/Workspace scope remains visible via rail/tooltips |

## Dependency Map

`Project lifecycle -> navigation snapshot -> Workspace/chat operations -> left rail -> navigation E2E`

## Success Criteria

- [ ] Workspaces and chats are discoverable and manageable per Project.
- [ ] New chats bind explicitly; existing chats/runs never retarget.
- [ ] Missing/duplicate/stale Workspace states have safe recovery UX.
- [ ] Navigation remains usable collapsed, narrow, keyboard-only, and at scale.
- [ ] Main remains the only durable navigation-state writer.

## Risk Assessment

Current chat APIs use a mutable selected session. If exact chat IDs cannot be
passed on every operation, stop and extend the Main contract before UI work.
Do not emulate durable selection in localStorage. Rollback hides the new
navigation in the isolated renderer while retaining stored Project data.

## Evidence

- 429 unit/IPC tests pass (includes `test/main/project-navigation-contract.test.ts` — 6 tests: duplicate/nested/cross-project workspace rejection, revision-checked archive/remove-binding, chat revision conflicts, workspace-mismatch turn refusal, archived-hide/pinned-first ordering, forbidden retarget ops absent from the catalogue).
- `test/e2e/workspace-chat-navigation.cjs` → `WORKSPACE-CHAT-NAVIGATION_OK` (26 checks): multi-workspace add, duplicate/nested denial, immutable chat→Workspace binding, stale-revision conflicts, missing-folder → `missing` state + recovery actions, nav rail DOM (groups, state badges, chat rows), search filter, collapse with scope counts, Ctrl+K command palette (scoped actions, chat actions, Escape close), archive of missing workspace.
- Screenshots: `test/artifacts/phase-05/nav-1280x800.png` (rail + workspaces + chats).
- Renderer bridge client now unwraps Main's `{ok, projectVersion, result}` into the client `value` contract (fix surfaced by the nav e2e).
- Migration 2: `chat_sessions.archived`/`pinned` columns (idempotent ALTERs).
