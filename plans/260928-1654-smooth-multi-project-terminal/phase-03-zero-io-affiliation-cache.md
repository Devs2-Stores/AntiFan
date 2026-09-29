---
phase: 3
title: "Phase 3: Zero-I/O Affiliation Cache"
status: done
priority: P1
effort: "1d"
dependencies: [1]
---

# Phase 3: Zero-I/O Affiliation Cache

## Overview
Loại `fs.statSync` khỏi đường xử lý mỗi chunk và mỗi session broadcast.

## Requirements
- Functional: `resolveWindowWorkspaceRoot`/`windowSessionScope` trả kết quả cache; tính và cache (path + isDirectory) tại `setWindowWorkspaceAffiliation`; xoá khi window đóng. Không dùng fs.watch.
- Non-functional: không đổi ngữ nghĩa hiển thị: session vẫn chỉ hiện ở window đúng scope.

## Architecture
Chuỗi gọi: `isSessionVisibleToWindow` → `windowSessionScope` → `resolveWindowWorkspaceRoot` → `isExistingDirectory` statSync (verified :403; line khác đã dịch, re-grep khi làm) (`native-tab-host.ts`). Thay bằng field `cachedScope` + generation counter.

## Related Code Files
- Modify: `src/main/browser/native-tab-host.ts`
- Test: `test/unit/native-tab-capsule-affiliation.test.ts` (mở rộng), unit mới cho invalidation

## Implemented (2026-09-29)
- `setWindowWorkspaceAffiliation` là điểm kiểm tra thư mục duy nhất (từ chối path không tồn tại, giữ affiliation cũ). Field đã lưu luôn là thư mục đã xác minh, nên không cần field `isDirectory` riêng hay generation counter: `resolveWindowWorkspaceRoot()` giờ chỉ đọc field → 0 statSync trên đường routing.
- `dispose()` xoá affiliation; đổi/xoá affiliation có hiệu lực ngay (test `native-tab-capsule-affiliation.test.ts`).
- Quyết định có chủ đích: đường tạo terminal (`resolveTerminalCreationTarget`, lạnh, 1 lần/terminal) vẫn stat root trước khi spawn shell, để không spawn vào thư mục đã bị xoá. Không phải data path.
- Đổi ngữ nghĩa nhỏ: thư mục bị xoá sau khi gán không còn làm session biến mất khỏi window (trước đây ẩn ngay). Hiển thị theo ownerKey/capsule không đổi.

## Implementation Steps
1. Viết test đỏ: đếm statSync qua stub fs khi đẩy 1000 chunk → kỳ vọng 0.
2. Cache + invalidate.
3. Test: đổi affiliation → session chuyển đúng window; gọi lại setWindowWorkspaceAffiliation → cache làm mới.

## Success Criteria
- [ ] statSync trên data path = 0/s (probe phase 1)
- [ ] Main event-loop p99 khi burst giảm so baseline; mục tiêu < 50ms ở N=3
- [ ] Không có session nào hiện sai window trong `test/e2e/project-windows.test.ts`

## Risk Assessment
Cache stale → terminal hiện sai window (cùng loại bug ownerKey migration). Tín hiệu: e2e visibility fail. Phản ứng: thêm invalidation điểm thiếu, không nới test.
