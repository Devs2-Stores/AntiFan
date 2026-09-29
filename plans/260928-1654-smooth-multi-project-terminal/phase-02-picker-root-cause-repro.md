---
phase: 2
title: "Phase 2: Picker Root-Cause Repro"
status: done
priority: P1
effort: "2h"
dependencies: []
---

# Phase 2: Picker Root-Cause Repro

## Overview
Xác nhận ảnh user là native `dialog.showMessageBox` hay modal `#projectOpenOverlay` trước khi viết phase 10. Hiện là [INFERENCE].

## Requirements
- Functional: tái hiện: đóng sidebar → Ctrl+Shift+O; kiểm lifecycle event `project-open.picker-fallback` (`src/main/index.ts:1891`).

## Architecture
`projectPickerHostFor` (`index.ts:1739-1755`) trả null khi sidebar đóng → fallback `pickProjectToOpen` (`index.ts:1880-1910`).

## Related Code Files
- Read only: `src/main/index.ts`, `src/renderer/standalone.js:4022-4292`

## Implementation Steps
1. Chạy app, đóng sidebar, Ctrl+Shift+O, chụp screenshot (AntiFan MCP hoặc OS).
2. Mở sidebar, lặp lại, chụp.
3. Ghi kết luận + ảnh vào `reports/picker-repro.md`.

## Implemented (2026-09-29)
- Probe `scripts/probe-project-picker.cjs` chay `ANTIFAN_PICKER_MODE=legacy` tren `.compiled` (boot OK).
- Evidence `reports/picker-probe-legacy.json`: ca hai leg (sidebar closed) deu di qua native `dialog.showMessageBox` "Mo du an" (nativeDialogs=1), overlay hidden, zero `antifan:project:open-picker` sends. Ket luan + anh huong toi phase 10 o `reports/picker-repro.md`.
- Root cause xac nhan: `projectPickerHostFor` tra null khi sidebar dong -> khong co host de push modal.

## Success Criteria
- [x] Xác định bề mặt nào user thấy; phase 10 cập nhật nguyên nhân tương ứng

## Risk Assessment
Nếu cả hai đường đều ra modal → vấn đề là styling modal; phase 10 bỏ bước fix host resolution.
