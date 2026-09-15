---
phase: 5
title: "Features: sidebar, categories, sleep"
status: pending
priority: P1
effort: "8h"
dependencies: [2, 3, 4]
---

# Phase 5: Features: sidebar, categories, sleep

## Overview
Triển khai toàn bộ các tính năng giao diện người dùng và quản lý vòng đời tab: (1) Chuyển đổi hiển thị danh sách tab dạng Sidebar dọc (mặc định vẫn là Ngang) kèm thanh kéo điều chỉnh độ rộng linh hoạt; (2) Phân loại tab theo Category (nhóm thư mục) với tiêu đề phân nhóm trong sidebar và chip màu khi ở dạng ngang; (3) Cơ chế Sleep/Archive tab hoàn toàn không tốn tài nguyên (giải phóng process PTY, hủy DOM xterm pane, giữ lại transcript xem tức thì, thức dậy ngay khi gõ phím, bảo toàn 100% affinity tab trình duyệt).

## Requirements
- Functional:
  - **Sidebar Tabs & Resizer**:
    - Nút toggle và context-menu item "Xếp dọc tab (Sidebar)" / "Xếp ngang tab (Horizontal)".
    - Chuyển đổi class CSS `.tabs-sidebar` trên `.standalone` thành CSS grid 2 cột (`var(--term-sidebar-w, 220px) 1fr`).
    - Thêm divider kéo resize ở mép sidebar với pointer capture và rAF, giới hạn chiều rộng trong khoảng 140px - 400px.
    - Bổ sung `min-width: 0` cho `#terminal` để tránh vỡ grid layout khi nội dung terminal dài.
    - Sửa lỗi cuộn vào view: chuyển từ `scrollLeft` sang `scrollIntoView({ block: 'nearest' })`.
    - Lưu cấu hình độ rộng và trạng thái sidebar theo chuẩn `saved-tabs.json` (thông qua IPC `setPanelWidth` / `buildPersistData`, tuyệt đối không dùng localStorage).
  - **Tab Categories**:
    - Thêm trường tùy chọn `category?: string` trong `Session`, `SavedSession`, và `SessionSummary`.
    - Context menu trên tab: "Đặt nhóm (Set category)...".
    - Khi ở dạng Sidebar: hiển thị header phân nhóm (collapsible, không bị kéo thả nhầm); cập nhật thuật toán sắp xếp DOM `renderTabs` và tính toán index khi drop thả tab để hỗ trợ nhóm.
    - Khi ở dạng Ngang: sắp xếp tab theo nhóm kèm chip màu phân biệt trên pill tab.
    - Bổ sung `capsuleId` vào `SessionSummary` để hỗ trợ gom nhóm theo capsule sau này.
  - **Sleep / Archive Tabs (Zero-Cost)**:
    - Context menu: "Ngủ (Sleep)" / "Đánh thức (Wake)".
    - Khi sleep: Main-process giải phóng PTY process tree (dùng hàm tách riêng `teardownSessionPty`), đổi trạng thái sang `'sleeping'`.
    - **RÀNG BUỘC SỐNG CÒN**: Quá trình sleep **TUYỆT ĐỐI KHÔNG EMIT** `session-closed` hay `close` để bảo toàn mapping affinity trong `native-tab-host.ts:1459-1461`.
    - Khi người dùng gõ phím vào pane tab đang ngủ: `writeTo` kích hoạt `ensureSessionPty` đánh thức PTY dậy trong cùng thư mục `cwd` cũ, tái sử dụng `reservedGeneration` để giữ nguyên khóa `${terminalId}@${generation}`.
    - **Affinity Zombie Guard**: Nếu tab trình duyệt bị đóng trong lúc terminal đang ngủ, `tombstoneTerminalAgentAffinity` sẽ đánh dấu `closedAt`. Khi đánh thức terminal, phải kiểm tra và dọn dẹp tombstone này, nếu không `isTerminalAllowedForTab` sẽ từ chối truy cập (`TERMINAL_FORBIDDEN`) khiến agent bị kẹt.
    - Tab ngủ trên giao diện hiển thị biểu tượng 💤 và làm mờ nhẹ; click vào tab sẽ tạo pane tạm và nạp transcript cũ dạng read-only mà **chưa cần spawn PTY**.
    - Lưu trạng thái: Tab ngủ được lưu vào đĩa với `state: 'sleeping'`; khi khởi động lại app, tab này được phục hồi ở trạng thái ngủ mà không spawn shell PTY.
    - Trong `terminal-manager.ts:switchSession`: thêm điều kiện guard để không tự động gọi `ensureSessionPty` khi click xem tab đang ngủ.
    - Trong `listSessions`: tab ngủ vẫn giữ chuỗi buffer để giao diện `mobile-remote-html.ts` không bị trắng màn hình.
    - Batch IPC cho affinity badges: gom N+1 lệnh `getTerminalAffinity` thành 1 lệnh gọi gộp `getTerminalAffinities`.
- Non-functional:
  - Mặc định cài đặt mới và mở cửa sổ mới luôn là dạng **Ngang (Horizontal)**.
  - 20 tab ngủ + 5 tab đang chạy có mức tiêu thụ CPU và RAM tương đương với 5 tab chạy đơn thuần (A2.9).

## Architecture
```
[User clicks "Sleep"]
       │
       ▼
IPC 'antifan:terminal:sleep-session'
       │
       ├─► Main: teardownSessionPty() ──► Terminate PTY tree (powershell + conhost)
       │         s.state = 'sleeping'
       │         DO NOT emit 'session-closed'! (Affinity preserved)
       │         emit('session') broadcast
       │
       └─► Renderer: teardownTerminalPane() ──► Dispose xterm, free memory, drop DOM
                     Update Tab Pill: Dimmed + 💤

[User clicks Sleeping Tab] ──► Render read-only snapshot (Fast preview, 0 PTY spawn)

[User types a key] ──► writeTo() ──► ensureSessionPty() ──► Wake up shell in same cwd & generation!
```

## Related Code Files
- Modify:
  - `src/main/browser/terminal-manager.ts` (state sleeping, category field, teardownSessionPty, sleepSession, wakeSession, switchSession guard, affinity-safe close)
  - `src/main/browser/native-tab-host.ts` (IPC handlers sleep/wake, bulk affinity, saved-tabs pref persistence)
  - `src/shared/contracts.ts` (channels mới SLEEP/WAKE, SET_CATEGORY, GET_BULK_AFFINITY, schema fields)
  - `src/preload/standalone-preload.ts` (wrappers sleepTerminal, wakeTerminal, setCategory, getTerminalAffinities)
  - `src/renderer/standalone.html` (sidebar resizer element, menu items sleep/category/sidebar)
  - `src/renderer/standalone.css` (.tabs-sidebar grid, resizer, category headers, sleeping styles, min-width:0)
  - `src/renderer/standalone.js` (renderTabs layout logic, drag resize, category headers, pane disposal on sleep, wake-on-input)
- Tests:
  - `test/e2e/terminal-renderer-smoke.cjs`
  - `test/e2e/terminal-tab-affinity-lifecycle.test.ts`

## Implementation Steps
1. Mở rộng type và contracts trong `src/shared/contracts.ts`: thêm channels `TERMINAL_CHANNELS.SLEEP_SESSION`, `WAKE_SESSION`, `SET_CATEGORY`, `GET_ALL_AFFINITIES`; cập nhật `SessionSummary` với `category?: string`, `capsuleId?: string`, `state: ... | 'sleeping'`.
2. Sửa `src/main/browser/terminal-manager.ts`:
   - Thêm `category` và `sleptAt` vào `Session` và `SavedSession`.
   - Tách logic hủy tiến trình từ `safelyKillSession` thành `teardownSessionPty(s)`.
   - Viết `sleepSession(id)`: gọi `teardownSessionPty(s)`, gán `s.state = 'sleeping'`, loại khỏi `deferredPtyQueue`, gọi `emitSession()`. Không emit `session-closed`.
   - Viết `wakeSession(id)`: gọi `ensureSessionPty(s)` tái sinh PTY và kích hoạt lại deferred listeners. **Affinity Zombie Guard**: Nếu tab trình duyệt bị đóng trong lúc terminal đang ngủ, `tombstoneTerminalAgentAffinity` sẽ đánh dấu `closedAt`. Khi đánh thức terminal, phải kiểm tra và dọn dẹp tombstone này, nếu không `isTerminalAllowedForTab` sẽ từ chối truy cập (`TERMINAL_FORBIDDEN`) khiến agent bị kẹt.
   - Sửa `switchSession`: bỏ qua `ensureSessionPty` nếu session đang ở trạng thái `sleeping`.
   - Bỏ qua session ngủ trong vòng lặp `resize()`.
3. Sửa `src/main/browser/native-tab-host.ts`:
   - Đăng ký IPC handlers cho sleep, wake, set-category. Kiểm tra quyền `assertTerminalAccess`.
   - Thêm handler lấy bulk affinity cho tất cả tabs trong 1 round-trip.
   - Bổ sung cấu hình `terminalTabLayout`, `terminalSidebarWidth`, `terminalCollapsedCategories` vào chu trình persist của `saved-tabs.json`.
4. Sửa `src/preload/standalone-preload.ts`: phơi bày các API mới qua contextBridge.
5. Sửa `src/renderer/standalone.css`:
   - Định nghĩa layout grid `.standalone.tabs-sidebar`.
   - Thêm `min-width: 0` cho `#terminal`.
   - Style thanh kéo resizer `.sidebar-resizer`.
   - Style category header và trạng thái tab ngủ `.is-sleeping`.
6. Sửa `src/renderer/standalone.js`:
   - Triển khai kéo thả thay đổi kích thước sidebar với pointer capture.
   - Cập nhật `renderTabs` để nhóm tab theo category (dạng sidebar có collapsible header, dạng ngang có chip màu).
   - Khi nhận state session là `sleeping`: gọi `teardownTerminalPane` dọn sạch bộ nhớ. **Lưu ý**: Split pane (`#terminal-split`) mount độc lập với tab pool và không có class `.active`. Nếu session đang mở split, nó vẫn phải nhận `term.write` bình thường. Nếu bỏ qua, sẽ gây mất dữ liệu ngầm trên màn hình split.
   - Bắt sự kiện gõ phím vào pane đang xem để tự động gửi lệnh wake lên main process.
   - Thay thế vòng lặp N+1 `getTerminalAffinity` bằng 1 lần gọi bulk API.
   - Thay thế `scrollLeft` bằng `scrollIntoView({ block: 'nearest' })`.
   - Bổ sung các context menu items tương ứng và wire action.

## Success Criteria
- [ ] Toggle qua lại giữa tab Ngang và Sidebar mượt mà; kéo thanh resizer thay đổi độ rộng sidebar chuẩn xác và được lưu lại sau khi khởi động lại app.
- [ ] Tạo category và gán tab vào category thành công, hiển thị trực quan đẹp mắt ở cả 2 chế độ ngang và dọc.
- [ ] Đưa tab vào trạng thái Sleep: PTY biến mất khỏi Task Manager trong ≤ 2s; DOM xterm của tab đó bị hủy; mapping affinity của tab trình duyệt vẫn giữ nguyên 100%.
- [ ] Click vào tab đang ngủ: xem lại được transcript cũ tức thì; gõ phím: shell tự động thức dậy và tiếp tục làm việc bình thường.
- [ ] Mở 20 tab ngủ và 5 tab hoạt động: kiểm tra hiệu năng CPU và RAM tương đương với trường hợp chỉ mở 5 tab.

## Risk Assessment
- Rủi ro: Thao tác kéo thả (drag & drop) reorder tab bị xung đột với các header phân nhóm category.
- Giảm thiểu: Phân tách rõ ràng: header category là thành phần không thể kéo thả (`draggable=false`), và tính toán lại vị trí splice trong danh sách dựa trên session ID thay vì vị trí DOM node thuần túy.
