---
phase: 4
title: "IPC coalescing + fan-out"
status: pending
priority: P1
effort: "5h"
dependencies: [1]
---

# Phase 4: IPC coalescing + fan-out

## Overview
Giảm thiểu bão IPC giữa main-process và renderer (từ hàng nghìn tin nhắn/giây xuống ~60-120 batch/giây). Triển khai cấu trúc envelope `{fromSeq, throughSeq, data}` để tránh bão resync delta, duy trì đường truyền tức thì (bypass) cho các gói input ≤ 256 bytes để bảo toàn độ nhạy khi gõ phím. Bổ sung cổng chặn gửi dữ liệu khi sidebar đang đóng, chuyển keystroke sang dạng `send` một chiều, tối ưu tìm tab bằng WeakMap, và biến phép merge nghẽn của bridge từ O(n²) thành O(n).

## Requirements
- Functional:
  - Mở rộng payload dữ liệu terminal với cấu trúc `fromSeq` và `throughSeq` (hoặc mảng chunks) để renderer nhận biết phạm vi sequence đã gộp, cập nhật `lastRenderedSeq = throughSeq` mà không kích hoạt xử lý gap nhầm. **Bắt buộc giữ lại trường `seq: throughSeq`** trong payload để đảm bảo tương thích ngược với `standalone-preload.ts` và `processIncomingChunk` (tránh lỗi `chunkSeq = 0` bị loại bỏ nhầm).
  - Coalesce dữ liệu terminal trong `native-tab-host.ts`: gom các chunk theo từng tick (hoặc window ≤ 8ms) theo từng `sessionId`.
  - Bypass coalescing: các chunk dữ liệu ≤ 256 bytes (ví dụ ký tự echo khi gõ phím) khi hàng đợi rỗng phải được gửi đi ngay lập tức.
  - Thêm cổng kiểm tra hiển thị sidebar (`native-tab-host.ts:1434`): nếu `sidebarView` đang đóng (`!this.isSidebarOpen`), không gửi `antifan:terminal:data` vào view này (tránh lãng phí CPU render nền).
  - Chuyển `sendTerminalInputTo` từ `ipcRenderer.invoke` sang `ipcRenderer.send` / `ipcMain.on` (loại bỏ chi phí IPC 2 chiều cho mỗi phím bấm).
  - Dùng `WeakMap<WebContents, Tab>` hoặc cache `webContents.id` trong `findTabByWebContents` để chuyển việc tìm kiếm tab người gửi từ O(T) sang O(1).
  - Tối ưu hóa bridge server (`bridge-server.ts:2807-2851`): khi nghẽn mạng, lưu mảng các chuỗi thô `dataParts: string[]` và chỉ gọi `JSON.stringify` 1 lần duy nhất khi flush; thay thế `queue.shift()` bằng index pointer.
- Non-functional:
  - Không làm tăng latency echo khi người dùng gõ phím (`interactiveEchoLatencyMs` không bị thoái lui).
  - Hoàn toàn tương thích ngược với format dữ liệu mà `mobile-remote-html.ts` và Bridge WebSocket clients mong đợi.

## Architecture
```
Main Process: PTY Data Event
      │
Chunk length <= 256B & queue empty? ──[YES]──> Send immediately (Low Latency Echo)
      │
    [NO]
      │
Accumulate in Map<sessionId, {parts, fromSeq, throughSeq}>
Flush on next microtask / 4ms timer
      │
safeSendWebContents('antifan:terminal:data', {sessionId, data: joined, fromSeq, throughSeq})
      │
Renderer: processIncomingChunk
      │
Recognize throughSeq ──> advance lastRenderedSeq = throughSeq ──> NO delta gap storm!
```

## Related Code Files
- Modify:
  - `src/main/browser/native-tab-host.ts` (coalescing fan-out, sidebar-visibility gate, input listener, WeakMap tab lookup)
  - `src/main/bridge/bridge-server.ts` (O(n) congestion merge)
  - `src/shared/contracts.ts` (mở rộng TerminalDataPayload với fromSeq/throughSeq)
  - `src/preload/standalone-preload.ts` (sendTerminalInputTo chuyển sang send)
  - `src/renderer/standalone.js` (xử lý payload coalesced có throughSeq)
- Tests:
  - `test/e2e/terminal-transport-sync.cjs`
  - `test/main/bridge-server.test.ts`
  - `scripts/benchmark-electron-performance.mjs` (kiểm tra interactiveEchoLatencyMs)

## Implementation Steps
1. Cập nhật `src/shared/contracts.ts` định nghĩa kiểu payload dữ liệu terminal hỗ trợ cả dạng đơn và dạng gộp (`fromSeq`, `throughSeq`). **Bắt buộc giữ lại trường `seq: throughSeq`** trong payload để đảm bảo tương thích ngược với `standalone-preload.ts` và `processIncomingChunk` (tránh lỗi `chunkSeq = 0` bị loại bỏ nhầm).
2. Sửa `src/main/browser/native-tab-host.ts`:
   - Tạo bộ đệm batch cho các chunk gửi tới renderer, xả đệm qua `setImmediate` hoặc timer ≤ 4ms.
   - Thêm điều kiện bypass cho chunk echo ≤ 256B.
   - Thêm điều kiện kiểm tra `this.isSidebarOpen` trước khi bắn IPC vào `this.sidebarView.webContents`.
   - Chuyển handler của channel input terminal sang `ipcMain.on`.
   - Thêm cache `webContentsId -> Tab` để tìm tab với chi phí O(1).
3. Sửa `src/preload/standalone-preload.ts`: đổi `sendTerminalInputTo` dùng `ipcRenderer.send`.
4. Sửa `src/renderer/standalone.js`: trong `processIncomingChunk`, nếu payload có `throughSeq`, kiểm tra tính liên tục từ `fromSeq` và cập nhật thẳng `lastRenderedSeq = throughSeq`, ngăn chặn việc gọi nhầm `getTerminalDelta`.
5. Sửa `src/main/bridge/bridge-server.ts`: lưu mảng string cho các frame nghẽn, hoãn stringify đến thời điểm flush.
6. Chạy benchmark kiểm tra: đảm bảo thông lượng tăng nhưng `interactiveEchoLatencyMs` không bị chậm hơn baseline.

## Success Criteria
- [ ] Số lượng tin nhắn IPC `antifan:terminal:data` giảm > 80% trong các bài test stream tải cao.
- [ ] Không có hiện tượng giật cục khi gõ phím; độ trễ echo đạt chuẩn tương đương baseline.
- [ ] Đóng sidebar không làm app tốn CPU render terminal ngầm.
- [ ] Không xuất hiện lỗi `DEGRADED` hay bão gọi `getTerminalDelta` trong `terminal-transport-sync.cjs`.

## Risk Assessment
- Rủi ro: Payload gộp khiến renderer hiểu nhầm là bị mất sequence number và kích hoạt cơ chế tự sửa lỗi liên tục.
- Giảm thiểu: Mở rộng tường minh contract với `fromSeq` và `throughSeq` giúp renderer phân biệt rõ ràng giữa "nhận 1 khối gộp nhiều seq" và "bị mất gói tin thật sự".
