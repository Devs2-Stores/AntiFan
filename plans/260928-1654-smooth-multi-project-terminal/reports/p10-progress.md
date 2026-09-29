# p10 slice — recovery progress log

## 2026-09-29 session (interrupted)

### Landed
- `scripts/probe-project-picker.cjs` (NEW, complete): Electron probe on the boot pattern
  of `probe-project-windows.cjs` — temp `ANTIFAN_DATA_ROOT`/`ANTIFAN_USER_DATA`, seeded
  `config/workspace-capsules.json` (alpha+beta, explicit markers), `ANTIFAN_USE_TERMINAL_DAEMON=0`,
  wraps `dialog.showMessageBox`/`showMessageBoxSync` to record + auto-cancel, watches
  `webContents.send` for `antifan:project:open-picker`, drives the File-menu `Mở dự án…`
  accelerator click (the real Ctrl+Shift+O path), waits on `runtime/logs/main.log` for
  `project-open*` lifecycle events, captures chrome surfaces to
  `reports/picker-*.png`, writes `reports/picker-probe-{mode}.json`.
  Modes: `ANTIFAN_PICKER_MODE=legacy` = observe-only (root-cause evidence vs pre-fix build);
  default `current` = asserts (sidebar closed → sidebar opens + overlay visible + zero
  native dialogs; sidebar open → push reaches sidebar).

### Verified analysis (re-derived from source this session)
- Root cause: `projectPickerHostFor` (index.ts ~1753) returns null when sidebar closed →
  `pickProjectToOpen` falls back to `dialog.showMessageBox` native picker
  (`recordLifecycleEvent('project-open.picker-fallback')` ~1891). Legacy smoke
  `.tmp-smoke-project-picker.cjs` (root, THROWAWAY) confirms pre-fix runs.
- Fix design (recorded for resume):
  - In `openProjectWindow`/`projectPickerHostFor`: if no chrome parent resolves but the
    window has a shell, toggle sidebar open via `host.toggleSidebar()` and await sidebar
    ready, then push `PROJECT_OPEN_PICKER` to sidebar. Native dialog only when no parent
    window at all.
  - Name authority = capsule store (`WorkspaceCapsuleManager.updateCapsule` with bumped
    `updatedAt`); `synchronizeCapsulesWithRegistry` already re-syncs registry name when
    capsule newer (index.ts:374-464) — no new registry API needed.
  - New channels in `PROJECT_WINDOW_CHANNELS` (contracts.ts:318-323): RENAME, REMOVE,
    REMOVE_ANSWER (confirm) + payload types `ProjectRenameResult`, `ProjectRemoveResult`,
    `ProjectRemoveConfirmPayload`. Route surface list mirrors `PROJECT_OPEN_ROUTE_SURFACES`
    (toolbar/sidebar/terminalPopout) — 'terminalPopover' must NOT be added (index.ts:1638).
  - Remove flow: confirm in-app if live terminals → `closeCoordinator.attemptClose(key,'user')`
    → `projectRegistry.closeProject(id)` → delete/mark capsule closed; never delete files.
  - Retitle: `ProjectWindowShell` add public retitle setter (title is readonly today ~line 720+);
    after rename, `shell.retitle(name)` + `host.broadcastState()` so toolbar `.project-chip` refreshes.
  - Renderer: extend existing `#projectOpenOverlay` modal — search input, list rows with
    hover/focus-visible actions (rename inline, remove w/ inline confirm), header shows
    path when names collide, `Chọn thư mục…` action reuses resolveProjectFromFolder.
  - `TerminalManager.closeWorkspaceSessions(workspaceId)` — need a public API to close a
    workspace's PTY sessions after confirmed remove; check terminal-manager.ts for the
    closest existing close-session API to reuse.
- ownerKey helper: `src/main/browser/window-owner.ts` `ownerKey(owner)` → `project:<id>` | `unassigned`.
- Harness: `test/renderer/standalone-harness.ts` has `emitProjectPicker`, `apiCalls`,
  `apiCallArgs`, `queryAll`; preload API shape at `standalone-preload.ts` openProjectPicker block.
- Pending tasks at handoff: (1) run probe vs `.tmp-p10-before` build + write
  `reports/picker-repro.md`; (2) contracts types/channels; (3) preload API; (4) index.ts
  rename/remove handlers + host-resolution fix; (5) registry `closeProject`+`rename` paths;
  (6) shell retitle; (7) overlay HTML/CSS/JS; (8) tests
  `test/main/project-rename-remove.test.ts` + `test/renderer/project-manager.test.ts`;
  (9) delete `.tmp-smoke-project-picker.cjs`; (10) phase-file status updates.
- Owned regions (from assignment): index.ts picker/project regions only; contracts
  PROJECT_WINDOW_CHANNELS + new payload types; standalone-preload project bridge;
  project/* (registry closeProject, capsule rename); project-window-shell retitle;
  standalone.html overlay ~166-181; standalone.css ~809-956; standalone.js ~3745-4292.
