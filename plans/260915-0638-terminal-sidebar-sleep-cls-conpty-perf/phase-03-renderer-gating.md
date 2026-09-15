---
phase: 3
title: "Renderer pipeline gating"
status: pending
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 3: Renderer pipeline gating

## Overview
Loại bỏ hoàn toàn chi phí xử lý và render của các tab terminal bị ẩn (tiết kiệm ~49/50 công việc của xterm parser và canvas paint khi mở 50 tabs). Xóa bỏ thao tác ghi đúp trong quá trình hydrate, throttle bộ regex phân loại trạng thái hoạt động của tab, tối ưu hóa dispatcher và hợp nhất các lệnh fit/refresh.

## Requirements
  - Kiểm tra trạng thái hiển thị của pane theo từng cửa sổ (`paneEl.classList.contains('active')` hoặc là split đang hiển thị `splitId === sessionId`).
  - **RÀNG BUỘC QUAN TRỌNG**: Split pane (`#terminal-split`) mount độc lập với tab pool và không có class `.active`. Nếu session đang mở split, nó vẫn phải nhận `term.write` bình thường. Nếu bỏ qua, sẽ gây mất dữ liệu ngầm trên màn hình split.
  - Đối với các pane ẩn: bỏ qua nhánh nặng của `notifySessionActivity`, bỏ qua `term.write`. Vẫn tăng `lastRenderedSeq` và gửi ACK bình thường để giữ đồng bộ với journal của main-process và tránh bị prune subscriber sau 30 giây.
  - Khi pane ẩn được kích hoạt trở lại (thông qua `syncTerminalPool` tại nhánh `isNowActive` - điểm tập trung duy nhất): bắt buộc thực hiện re-hydrate qua snapshot (`atomicHydratePane` + `getFullBuffer`), **tuyệt đối không dùng delta resync** vì `lastRenderedSeq` đã chạy trước dẫn đến mất dữ liệu ngầm. Khi chuyển tab, nếu tab đích có split, phải re-hydrate cả split sibling từ `getFullBuffer` thay vì dùng `splitBuffer` cũ.
  - Xóa bỏ việc ghi transcript lần đầu bị lãng phí ở `standalone.js:1204-1208` trước khi `term.reset()` diễn ra trong `atomicHydratePane`.
  - Hợp nhất việc phát lại `liveQueue` thành một lần gọi `writeTermAsync` duy nhất bằng cách nối chuỗi dữ liệu contiguous.
  - Giới hạn tần suất gọi `notifySessionActivity`: tối đa 1 lần mỗi 100ms cho mỗi session khi đang nhận stream liên tục.
  - Tối ưu hóa `TerminalWriteDispatcher`: dùng `chunk.length` thay cho việc duyệt O(n) UTF-8 scan; lấy hàng đợi theo batch rồi `join('')` thay cho `shift()` từng phần tử.
  - Hợp nhất `fitCurrentTerminal`: giới hạn tối đa 1 lần fit/refresh mỗi frame, bỏ qua `term.refresh(0, rows-1)` nếu kích thước không đổi.
  - Thêm cờ guard `isProgrammaticScroll` cho pane chính tương tự như split pane.
  - Đồng bộ kích thước scrollback: giảm split pane từ 50000 dòng xuống 10000 dòng bằng với pane chính.
- Non-functional:
  - File `src/renderer/terminal-write-dispatcher.js` là file sinh tự động bởi script build; **mọi chỉnh sửa phải thực hiện trên `src/shared/terminal-write-dispatcher.ts`**.
  - Popout window có `activeId` riêng và phải tự quyết định trạng thái active của pane cục bộ.

## Architecture
```
onTerminalData ──> Check pane active?
                        │
         ┌──────────────┴──────────────┐
       [YES]                          [NO]
         │                              │
notifySessionActivity (throttled)   mark tab dirty
queueWrite ──> term.write           lastRenderedSeq = seq
                                    send ACK (keep subscriber alive)
                                    skip xterm.write entirely!
                                        │
User clicks tab ──> isNowActive funnel ─┘
                         │
                 atomicHydratePane (Snapshot reset + fullBuffer)
```

## Related Code Files
- Modify:
  - `src/renderer/standalone.js` (gating logic, rehydrate funnel, hydration fixes, fit coalescing, scroll guard)
  - `src/shared/terminal-write-dispatcher.ts` (chunk.length budget, batch dequeue)
  - Scripts: chạy `scripts/copy-static.mjs` để cập nhật `src/renderer/terminal-write-dispatcher.js`
- Tests:
  - `test/main/terminal-write-pipeline.test.ts`
  - `test/renderer/terminal-gap-state-machine.test.ts`
  - `test/e2e/terminal-renderer-smoke.cjs`

## Implementation Steps
1. Sửa `src/shared/terminal-write-dispatcher.ts`:
   - Dùng `chunk.length` cho việc tính toán quota 64KB/frame.
   - Thay thế `writeQueue.shift()` bằng việc drain toàn bộ batch qua `join('')`.
   - Chạy build/copy static để sync sang `src/renderer/terminal-write-dispatcher.js`.
2. Sửa `src/renderer/standalone.js`:
   - Trong `onTerminalData`: nếu pane không có class `.active` (và không phải split đang mở `splitId === sessionId`), bỏ qua `notifySessionActivity` nặng, gán `lastRenderedSeq = seq`, gọi `scheduleCoalescedAck` rồi return.
   - Thêm cờ `needsRehydrate: true` cho pane bị gated.
   - Trong `syncTerminalPool` tại nhánh `isNowActive`: nếu pane có cờ `needsRehydrate`, gọi `atomicHydratePane` để nạp snapshot sạch và xóa cờ. Khi chuyển tab, nếu tab đích có split, phải re-hydrate cả split sibling từ `getFullBuffer` thay vì dùng `splitBuffer` cũ.
   - Bỏ dòng `sTerm.write(sliceHydrationTail(snapshot))` thừa ở L1204-1208.
   - Gộp việc phát lại `liveQueue` ở L952-963 thành 1 lệnh write gộp chuỗi.
   - Thêm throttle 100ms cho `notifySessionActivity`.
   - Thêm cờ guard `item.isProgrammaticScroll` trong `onScroll` của pane chính (L1265).
   - Đặt scrollback của split pane về 10000 dòng (L1633).
   - Coalesce `fitCurrentTerminal` vào 1 rAF duy nhất.
3. Chạy lại dispatcher test suite và renderer test suite để kiểm tra tính toàn vẹn.

## Success Criteria
- [ ] Khi chạy benchmark stream 60s trên tab active, các tab ẩn nhận 0 lệnh `term.write`.
- [ ] Chuyển qua lại giữa các tab hiển thị đầy đủ dữ liệu mới nhất mà không bị thiếu chữ, không bị lệch scroll.
- [ ] `smoke:terminal` và `test:terminal-transport` chạy pass toàn bộ.

## Risk Assessment
- Rủi ro: Tab ẩn khi chuyển sang active bị trắng màn hình hoặc thiếu đoạn dữ liệu vừa stream.
- Giảm thiểu: Cơ chế snapshot re-hydrate (`getFullBuffer` + `term.reset()`) đảm bảo kéo toàn bộ trạng thái chuẩn từ main process về, không phụ thuộc vào delta chain.
