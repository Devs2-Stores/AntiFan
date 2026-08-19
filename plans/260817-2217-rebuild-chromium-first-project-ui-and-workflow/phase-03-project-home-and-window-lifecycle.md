---
phase: 3
title: "Project Home And Window Lifecycle"
status: done
priority: P1
effort: "5d"
dependencies: [2]
---

# Phase 3: Project Home And Window Lifecycle

## Overview

Build the Codex-like Project Home and one-window-per-Project lifecycle. The Home
window owns no Chromium tabs; each opened Project materializes or focuses its
own ProjectRuntime and Chromium profile.

## Requirements

- Cold launch shows recent Projects when no explicit Project should reopen.
- Create Project chooses a folder, creates durable Project/Workspace identity,
  and opens one Project window.
- Opening an already materialized Project focuses it; it never creates a second
  BrowserWindow/profile owner.
- Project Home shows foreground, background-active, background-warm, suspended,
  recovering, profile-delete-pending, and closed states from Main.
- Project window close with active work offers keep running, stop and close, or cancel.
- Reopen restores durable tabs/chats metadata but never claims PTY/live-JS restoration.
- Window bootstrap binds renderer WebContents to Project before any Project IPC.
- App-level Project commands remain separate from Project-bound commands.
- Home/Project screens remain on explicit test/internal routing until Phase 11;
  this phase does not activate a second production renderer.

## Architecture

Add a Main-owned `ProjectWindowCoordinator` above `ProjectRuntimeManager`.
It owns the launcher window, Project window bootstrap, focus/reopen routing,
close policy, sender binding, and window-state events. It does not own browser
tabs or durable Project data.

The same React bundle renders `ProjectHomeScreen` for an app-level bootstrap and
`ProjectWindowShell` for a Project-bound bootstrap. Home uses a narrow app bridge;
Project windows switch immediately to the Project bridge.

## User Flows And States

- Create from folder, validation error, duplicate folder already bound.
- Open recent Project, focus already-open Project, reopen suspended Project.
- Rename Project, reveal Workspace, remove catalog record without profile deletion.
- Close idle Project immediately.
- Close active Project and keep running; return from background indicator.
- Profile deletion pending/failed/retry state.
- App second-instance request focuses Home or named Project.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Create | `E:/Work/apps/antigravity-browser-desktop/src/shared/app-shell-contract.ts` | App-level Project catalog/window bootstrap schemas | Unit/IPC parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/main/project-window-coordinator.ts` | Home and Project window lifecycle | Main unit/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/app-main.ts` | Project create/list/update/materialize lifecycle APIs | Main unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/index.ts` | Startup and second-instance routing through coordinator | App smoke |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-runtime-manager.ts` | Expose lifecycle snapshots and generation-fenced window binding | Isolation tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-runtime.ts` | Close-policy and bootstrap-safe window attachment | Lifecycle tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/app-preload.ts` | Pure app-shell command/event catalogue | Static parity |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/index.ts` | Self-contained app-shell bootstrap bridge | Static/security tests |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/screens/project-home-screen.tsx` | Recent Projects and actions | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/components/project-list-item.tsx` | Project status and action row | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/components/project-close-dialog.tsx` | Keep-running/stop/cancel decision | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/main/project-window-coordinator.test.ts` | Single-flight/focus/close/bootstrap ownership | Unit |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/e2e/project-home-flow.cjs` | Create/open/background/reopen flow | Electron E2E |

## Implementation Steps

1. Define app-shell bootstrap, Project summary, lifecycle event, and command schemas.
2. Add coordinator startup routing and guarantee one launcher plus at most one window per Project.
3. Bind sender/window ownership before loading the Project renderer entry.
4. Implement create/open/focus/rename/remove/close-policy operations.
5. Render Home empty, recent, running, recovering, and error states.
6. Render Project identity in title bar and expose a Project switcher that focuses
   another Project instead of retargeting the current window.
7. Implement active-work close dialog and background project indicators.
8. Add concurrent open/open, close/reopen, stale callback, second-instance, and
   profile-delete-pending tests.

## Function And Interface Checklist

- [x] `AppShellBootstrap` contains window kind, app version, and redacted Project summaries.
- [x] `ProjectWindowCoordinator.openProject()` is single-flight and focuses existing owners.
- [x] `ProjectWindowCoordinator.bindProjectRenderer()` runs before Project load completion.
- [x] `ProjectCloseDecision` is `keep-running | stop-and-close | cancel`.
- [x] `ProjectSummary` reports lifecycle/blockers without Electron objects or credentials.
- [x] No app-level command can address tabs, terminals, chats, or evidence directly.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Two simultaneous opens for one Project | One runtime/window; both callers receive same owner |
| Critical | Stale closed callback after reopen | New runtime/window remains registered |
| Critical | Unbound renderer sends Project command | Rejected before handler dispatch |
| High | Close with live run/PTY/process | Explicit decision dialog; no silent kill |
| High | Duplicate folder create | Focus existing Project or require explicit new-worktree choice |
| Medium | Empty catalog | Clear create/open actions and keyboard focus |

## Dependency Map

`Renderer foundation -> app-shell contracts -> window coordinator -> Home UI -> lifecycle E2E`

## Success Criteria

- [x] Project Home is fully usable without creating a global Chromium owner.
- [x] One Project maps to one window/runtime/profile owner and duplicate open focuses it.
- [x] Renderer sender ownership is established before Project IPC.
- [x] Background and close behavior are explicit and visible.
- [x] Lifecycle tests cover concurrent and stale-callback failures.
- [x] Production remains legacy-only until the atomic cutover phase.

## Risk Assessment

The current `NativeTabHost.launch()` discovers its owner indirectly, so window
binding may remain ambiguous. If the coordinator cannot receive the exact created
BrowserWindow, first add an explicit host launch result contract; do not use
`BrowserWindow.getAllWindows()[0]`. Roll back by leaving Home test-only and
retaining legacy startup until the exact-owner tests pass.
