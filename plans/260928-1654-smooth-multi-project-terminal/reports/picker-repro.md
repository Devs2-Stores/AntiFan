# Picker root-cause repro (Phase 2)

Date: 2026-09-29. Probe: `scripts/probe-project-picker.cjs` in `ANTIFAN_PICKER_MODE=legacy`
against the current `.compiled` tree (boot OK — no sibling mid-edit failures observed).

Command:

```text
ANTIFAN_PICKER_MODE=legacy node scripts/run-electron.cjs scripts/probe-project-picker.cjs
```

## Observed (evidence: `picker-probe-legacy.json`, `picker-legacy-*.png`)

| Scenario | sidebarOpen | overlay | native dialogs | lifecycle events | `antifan:project:open-picker` sends |
|---|---|---|---|---|---|
| sidebar closed + Ctrl+Shift+O | false | hidden | 1 (`showMessageBox`, title "Mở dự án", 4 buttons) | `project-open.without-target` | 0 |
| sidebar still closed (probe "open" leg) | false | hidden | 1 (same spec) | `project-open.without-target` | 0 |

Both legs of the File-menu accelerator (`Mở dự án…`, the real Ctrl+Shift+O path) were
answered by the **native `dialog.showMessageBox` fallback**, never by the in-app
`#projectOpenOverlay` modal. The overlay never painted (`hidden`), the sidebar never
opened, and zero `PROJECT_OPEN_PICKER` pushes reached any surface.

## Root cause — confirmed

`projectPickerHostFor` (`src/main/index.ts:1753-1769`) returns `null` whenever the asking
shell's sidebar is closed (`if (!shell.isSidebarOpen) return null;`), so
`pickProjectToOpen` (`index.ts:1894`) skips the renderer push entirely and runs the
native `dialog.showMessageBox` path (the `project-open.picker-fallback` event at
`index.ts:1905` only records the *timed-out* fallback; the no-host fallback is silent).

The user-visible surface for "open a project" with the sidebar closed is therefore the
cramped native message box — the modal only exists while the sidebar happens to be open.

## Consequence for Phase 10

- The fix is the host-resolution one Phase 10 already lists: when the shell resolves but
  the sidebar is closed, toggle the sidebar open (`host.toggleSidebar()`), await the
  surface, then push `PROJECT_OPEN_PICKER`. Native dialog stays only for a parent that
  owns no shell/workbench renderer at all.
- The modal, not the native box, becomes the single project manager surface: rename,
  remove (with confirm when live terminals exist, never deleting files), folder pick.

## Post-fix status (2026-09-29, same session)

The fix described above landed: `projectPickerHostReadyFor` opens the sidebar when a
shell resolves, then pushes `PROJECT_OPEN_PICKER`; `renameProjectEntry` /
`removeProjectEntry` ride `PROJECT_RENAME` / `PROJECT_REMOVE` /
`PROJECT_REMOVE_ANSWER` with the confirm-gated, file-safe remove flow; the modal
hosts inline rename + inline remove-confirm rows.

Verified this run:

- `node --test` on `.tmp-p10-tests` (scratch outDir): `test/main/project-rename-remove.test.js` 5/5, `test/renderer/project-open-picker.test.js` 11/11.
- `npx tsc --noEmit --incremental --tsBuildInfoFile .compiled/.tsbuildinfo-p10`: zero errors in touched files; remaining errors are sibling-owned (`native-tab-host.ts`, `browser-control-port.ts`, `tab-devtools-host.test.ts`, `bridge-health-banner.test.ts`).

Pending (blocked on sibling build): the probe's `current` mode assertion (sidebar
closed → sidebar opens + overlay + zero native dialogs) needs a `.compiled` emit,
which is refused while sibling errors stand.
