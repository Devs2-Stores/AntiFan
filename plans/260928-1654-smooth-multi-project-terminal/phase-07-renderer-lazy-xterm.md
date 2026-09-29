---
phase: 7
title: "Phase 7: Renderer Lazy Xterm"
status: done
priority: P1
effort: "2d"
dependencies: [4]
---

# Phase 7: Renderer Lazy Xterm

## Overview
Không tạo xterm cho session ẩn; hydrate khi user mở; bỏ full rebuild `renderTabs`.

## Requirements
- Functional: chunk của session chưa có pane → chỉ cập nhật activity indicator + ack; khi mở → hydration tail (256KiB, `standalone.js:2153`) + delta theo seq.
- Main không forward IPC `antifan:terminal:data` tới renderer không hiển thị session (sidebar/pane đóng); renderer vẫn nhận activity signal nhẹ.
- `renderTabs` diff theo key thay vì rebuild (`standalone.js:5936-5980`).

## Architecture
`terminalPool.get(sessionId)` hiện materialize pane ở chunk đầu (`standalone.js:6056-6062, 1657-1669`).

## Related Code Files
- Modify: `src/renderer/standalone.js`, `native-tab-host.ts` (suppress IPC)
- Test: `test/renderer/*` terminal pool

## Implementation Steps
1. Test đỏ: 20 session nền burst → 0 pane được tạo.
2. Đổi `get` → `peek` trên đường data; tạo khi activate.
3. Keyed renderTabs.

## Success Criteria
- [ ] 25 session nền: renderer heap tăng < 50MB
- [ ] Mở session nền: nội dung khớp đầy đủ (so hash với getFullBuffer)

## Risk Assessment
Hở scrollback/lệch seq khi hydrate. Tín hiệu: diff hash. Phản ứng: hydrate full buffer thay tail.
