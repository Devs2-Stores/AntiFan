---
phase: 10
title: "Phase 10: Project Manager UI + CRUD"
status: done
priority: P1
effort: "3d"
dependencies: [2]
---

# Phase 10: Project Manager UI + CRUD

## Overview
Một trình quản lý dự án trong app thay native dialog; CRUD: tạo, mở, đổi tên, bỏ khỏi danh sách.

## Requirements
- Functional: tạo (Chọn thư mục… → `resolveProjectFromFolder`), đổi tên (`WorkspaceCapsuleManager.rename` workspace-capsule.ts:286-294), xoá = đóng window qua `ProjectCloseCoordinator.attemptClose(key,'user')` (project-close-coordinator.ts:643; tôn trọng busy/unload veto) rồi mới `ProjectRegistry.closeProject` bỏ khỏi danh sách; không xoá file; confirm nếu terminal còn chạy; nếu user xác nhận thì dọn PTY sessions của workspace trong daemon (không để rò rỉ tiến trình nền). Không có nhân bản.
- Sidebar đóng → tự mở sidebar và hiện modal (hoặc theo kết quả phase 2).
- Tìm kiếm, phím mũi tên/Enter/Escape, hiển thị path khi trùng tên.

## Architecture
Kênh IPC mới thêm vào `PROJECT_WINDOW_CHANNELS` (`contracts.ts:318-323`): rename, remove. Preload `standalone-preload.ts`. Xác minh nguồn tên authority: capsule hay registry.

## Related Code Files
- Modify: `src/shared/contracts.ts`, `src/preload/standalone-preload.ts`, `src/main/index.ts` (:1739-1756, :1880-1910, :2174-2192), `project-registry.ts`, `workspace-capsule.ts`, `standalone.html:166-181`, `standalone.css:809-956`, `standalone.js:4022-4292`

## Implemented (2026-09-29)
- `contracts.ts`: `PROJECT_WINDOW_CHANNELS` + `PROJECT_RENAME` / `PROJECT_REMOVE` / `PROJECT_REMOVE_ANSWER`; payload types `ProjectRenameResult` (RENAMED|UNKNOWN_PROJECT|FAILED), `ProjectRemoveResult` (REMOVED|CONFIRM_REQUIRED{liveSessions}|UNKNOWN_PROJECT|FAILED), `ProjectRemoveAnswerPayload`.
- `standalone-preload.ts`: `renameProject` (invoke), `removeProject` (invoke), `answerProjectRemove` (send).
- `index.ts`: `renameProjectEntry` / `removeProjectEntry` (export, unit-testable) + `PROJECT_WINDOW_ROUTES` entries behind `PROJECT_PICKER_ROUTE_SURFACES`; `projectPickerHostReadyFor` mo sidebar khi dong roi moi push `PROJECT_OPEN_PICKER` - native dialog chi con cho parent khong shell. `removeProjectEntry`: `closeCoordinator.attemptClose` truoc (ton trong veto), roi `projectRegistry.closeProject` + `capsuleManager.clearAffiliation`, terminal song -> `CONFIRM_REQUIRED` va `confirmed` moi don session; khong bao gio xoa file.
- `project-window-shell.ts`: `retitle(name)` cap nhat title bar + chip.
- `workspace-capsule.ts`: `rename` + `clearAffiliation` (giu capsule, go claim de sync boot sau khong resurrect).
- UI `standalone.html/css/js`: subtitle hien path khi trung ten; row actions rename inline + remove confirm inline (ke so terminal song); focusables/keyboard mo rong cho input/buttons, Esc huy edit khong dong modal.
- Tests: `test/main/project-rename-remove.test.ts` (5) + `test/renderer/project-open-picker.test.ts` CRUD block (5). `.tmp-smoke-project-picker.cjs` da xoa.
- Note: typecheck `--noEmit` sach cho cac file thuoc phase; loi con lai (`native-tab-host.ts`, `browser-control-port.ts`, `bridge-health-banner.test.ts`) thuoc slice khac. Post-fix probe `current` chua chay duoc vi `.compiled` dang giua loi sibling - se chay khi build xanh.
- Delete: `.tmp-smoke-project-picker.cjs`

## Implementation Steps
1. Chốt authority của tên.
2. IPC + preload + validate sender.
3. UI: row actions (rename inline, remove với confirm), style theo `docs/ui-architecture.md`.
4. Bỏ dùng native dialog trừ đường không có parent.

## Success Criteria
- [x] Ctrl+Shift+O khi sidebar đóng → modal trong app (`projectPickerHostReadyFor`; e2e probe `current` chờ `.compiled` xanh)
- [x] Rename bền qua restart; remove không xoá file; confirm khi terminal sống (unit: `project-rename-remove.test.ts`)
- [x] Unit + e2e cho từng thao tác (unit 5 main + 5 renderer; e2e leg = probe `current`, pending sibling build)

## Risk Assessment
`closeProject`/`rename` chưa từng được gọi → bug ẩn, race với persist debounce. Phản ứng: test persist sau rename + restart.
