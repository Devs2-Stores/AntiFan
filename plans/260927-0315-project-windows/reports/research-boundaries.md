# Project Windows research boundaries

## Scope

HOLD SCOPE: five project windows, twenty tabs, simultaneous project visibility, shared runtime, trusted routing, search/Unassigned, placement and protected closing. No tray, cookie migration, new scheduler or UI framework rewrite.

## Grounded findings

- index.ts:230-235,459 currently owns one mainWindow/tabHost and shared services.
- index.ts:525-530 protects benchmark windows, not active agents generally.
- NativeTabHost registers global IPC handlers and owns persistence/disposal; constructing it twice without extraction is unsafe (lifecycle scout: setupToolbarIpc, setupTerminalIpc, setupSidebarIpc, setupFrameBackdropIpc).
- docs/ui-architecture.md:28-42 owns 960x640 DIP minimum and Main native bounds.
- package.json:24,30,40-50,52,54,70,72 provides compilation, typecheck, test suites and split/persistence/background/terminal smokes. These commands have not been run for this planning task.

## Rejected scout suggestions

Do not preserve obsolete method stubs to satisfy source-text tests. Replace incidental-source assertions with behavior checks where required by the cutover. Do not create a second generic AppRuntime class merely to wrap existing singleton bootstrap. Use one project-window directory and a small close coordinator only where actual lifecycle boundaries justify them. Detached terminal daemon survival is intentional, not an orphan-process failure.

## Dependency scan

Scanned status fields of 69 direct project plan indexes. Existing pending Chromium-first UI and in-progress native-Harness plans contain overlapping window prescriptions; their window-specific work must consume this plan. Their unrelated chat/renderer/backend scopes are not prerequisites. Older native-host modularization is a shared-file coordination concern, not a requirement to complete unrelated capability expansion. Terminal daemon persistence must be preserved; no terminal process architecture rewrite is included.

## Tooling

AgentKit plan CLI available; scaffold and worktree pointer created. set-active-plan.cjs was not found under installed .claude or .omp hook paths; explicit plan paths are supplied to agents instead. No claim of session-hook activation.
