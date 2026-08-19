---
phase: 7
title: "Terminal Process And Dev Server Workspace"
status: done
priority: P1
effort: "6d"
dependencies: [4, 5]
---

# Phase 7: Terminal Process And Dev Server Workspace

## Overview

Port the existing integrated terminal UI and PTY behavior into a Workspace-bound
bottom panel, then add tracked processes and dev servers. Every terminal and
process keeps its creation binding even when the user changes the selected
Workspace or chat.

## Existing Capability Migration Contract

- Existing: terminal panel toggle, xterm rendering, create/switch/clear/close,
  resize, PTY service, terminal tools, and terminal E2E probes.
- Reuse: `TerminalService`, PTY lifecycle, xterm behavior, shortcuts, and tested
  session operations unless exact binding requires a narrow adapter change.
- Required delta: immutable Project/Workspace binding, process/dev-server
  registry, safe process identity, deterministic port ownership, and new panel UI.
- Legacy removal condition: terminal behavior parity, listener audit, Workspace
  isolation, and process-safety tests pass.

## Requirements

- Terminal tabs show shell, Workspace, cwd, live/exited status, and owner Project.
- Create terminal requires an explicit Workspace; no mutable global cwd fallback.
- Switching Workspace filters/opens relevant terminals but never retargets PTYs.
- Use bundled xterm modules through Vite; remove classic UMD globals.
- Track process command, PID, process start token, executable, cwd, port, origin,
  healthcheck, lifecycle, and shutdown result.
- Dev-server status exposes exact Workspace revision/build marker used by QA.
- Port conflict identifies the owner; never silently increments to another port.
- Stop actions revalidate process identity and affect only Project-owned resources.
- Close Project surfaces live blockers and uses the Phase 3 decision flow.

## Architecture

`WorkspacePanel` hosts terminal and process tabs. `TerminalSessionView` projects
Main-owned terminal metadata and attaches one xterm instance while visible.
Hidden terminals retain Main PTY state and bounded renderer scrollback snapshots;
the UI never claims serializable PTYs after suspension/restart.

`DevServerBinding` is the bridge between tracked process and post-fix QA. It is
immutable per process start and includes Project/Workspace/revision/process/port/origin.

## User Flows And States

- Create one or multiple terminals in a Workspace.
- Switch between Workspaces with terminals in both.
- Terminal exits, reconnects to panel, or becomes unavailable after app restart.
- Harness starts a dev server; user opens its origin in a Project tab.
- Port is occupied by a tracked or foreign process.
- Stop/kill confirmation and clean/forced/lost result.
- Resize/collapse/restore bottom panel with Harness open.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/project-contract.ts` | Terminal/process/dev-server view models and bindings | Schema/unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Terminal/process operations and events | Static parity |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-terminal-manager.ts` | Workspace-bound terminal lifecycle and summaries | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/terminal-service.ts` | PTY creation/resize/write/kill with exact binding | Unit/integration |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/workspace-scoped-services.ts` | Process/dev-server registry and ownership | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/capabilities/terminal-capability-adapter.ts` | Harness terminal/process dispatch parity | Capability tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/index.ts` | Typed terminal/process handlers only | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/workspace/workspace-panel.tsx` | Bottom dock and tab modes | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/workspace/terminal-tabs.tsx` | Terminal session navigation | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/workspace/terminal-view.tsx` | xterm lifecycle and resize | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/workspace/process-list.tsx` | Tracked process/dev-server states | Renderer/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/project-terminal-manager.test.ts` | Binding/lifecycle/process identity cases | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/terminal-and-chat.test.ts` | No retarget after chat/Workspace changes | Integration |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/_probe-termui.cjs` | New project-window terminal UI | Electron E2E |

## Implementation Steps

1. Extend terminal/process contracts with UI-safe state and `DevServerBinding`.
2. Route terminal/process operations through Project IPC and exact Workspace IDs.
3. Import xterm/fitting styles through Vite and remove renderer global assumptions.
4. Build terminal tabs, terminal view, process list, status/actions, and empty/error states.
5. Implement one resize observer/fit path and bounded visibility restoration.
6. Add deterministic port ownership, healthcheck, open-origin, and stop flows.
7. Integrate panel bounds with BrowserShell and close blockers with Project Home.
8. Run PTY, process identity, Workspace switch, port, resize, and dev-server tests.

## Function And Interface Checklist

- [x] `TerminalBinding` is immutable and displayed in every terminal tab.
- [x] `DevServerBinding` includes Project, Workspace revision, process start token, cwd, port, origin, and healthcheck.
- [x] `TerminalView.mount()` attaches one xterm instance and cleans listeners.
- [x] Stop path revalidates PID plus start token/executable before termination.
- [x] Layout fit reports dimensions only for the owning terminal.
- [x] No operation reads selected Workspace as a substitute for stored binding.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Workspace switch while terminal runs | PTY remains bound to original cwd/Workspace |
| Critical | PID reused before stop | Identity mismatch; no process killed |
| Critical | Foreign process owns deterministic port | Clear conflict; no new-port fallback |
| High | Hide/show panel repeatedly | One xterm/listener set; scrollback remains coherent |
| High | Close Project with live PTY/process | Explicit keep-running/stop/cancel dialog |
| Medium | Narrow window and bottom panel | Chromium minimum area preserved; panel resizable/collapsible |

## Dependency Map

`Workspace identity + Browser layout -> terminal/process contracts -> Main services -> bottom panel -> QA DevServerBinding`

## Success Criteria

- [x] Terminals/processes visibly and durably belong to one Project/Workspace.
- [x] Selected Workspace changes do not retarget live resources.
- [x] Dev-server identity is strong enough for Phase 9 QA proof.
- [x] xterm loads offline from the renderer bundle with no duplicate listeners.
- [x] Port/process safety and Project-close blocker tests pass.

## Risk Assessment

PTY output can overwhelm renderer memory and hidden WebGL canvases can leak GPU
resources. Bound scrollback, park hidden views deliberately, and measure process/
renderer memory. If stable hidden retention cannot be proven, keep PTY in Main
and recreate only the view with an explicit limited snapshot. Never silently
kill PTYs to meet UI memory goals.
