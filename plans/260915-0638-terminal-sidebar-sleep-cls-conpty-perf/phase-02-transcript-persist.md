---
phase: 2
title: "Transcript lifecycle + persist"
status: pending
priority: P1
effort: "6h"
dependencies: [1]
---

# Phase 2: Transcript lifecycle + persist

## Overview
Giải quyết dứt điểm vấn đề banner PowerShell chồng chất sau mỗi lần khởi động và lệnh `cls`/`clear` không xóa sạch transcript lưu trên đĩa. Tối ưu hóa việc persist bằng dirty-scoping để xóa bỏ hiện tượng đơ main-thread định kỳ 2 giây (từ ~50MB JSON.stringify xuống ~1MB), chặn đứng việc regex quét toàn bộ 4MB buffer trong `waitTerminal`, tối ưu `listSessions` thành O(S) và thay thế journal `shift()` bằng cấu trúc ring buffer.

## Requirements
- Functional:
  - Tách transcript lưu cũ thành `s.restoredTail` (chỉ hiển thị lần đầu, có đường kẻ phân cách), `s.buffer` của shell mới bắt đầu rỗng (`''`).
  - `persistAsync`/`persistSync` chỉ lưu `s.buffer`, vĩnh viễn không lưu lại `s.restoredTail` → không còn hiện tượng cộng dồn banner.
  - Nhận diện `cls`, `clear`, `Clear-Host`, `Ctrl+L` phía input (`write`/`writeTo`) qua rolling buffer (≤128 chars). Khi phát hiện ngoài alt-screen (`?1049`), đặt cờ `pendingClearScreen`. **Lưu ý**: Chỉ áp dụng cho shell prompt chuẩn, tránh xóa nhầm transcript khi gõ `cls` trong REPL (Node/Python) hoặc `clear` trong cmd.exe gây lỗi.
  - Khi append chunk tiếp theo: reset `s.buffer = ''` và inject `\x1b[3J` để renderer xóa sạch scrollback, đảm bảo seq/journal nhất quán.
  - Dirty-scope persist: duy trì `dirtySessionIds: Set<string>`, chỉ serialize các session bị thay đổi, tái sử dụng chuỗi JSON fragment cho các session sạch. Vẫn giữ nguyên atomic write + rename và `writeSequence`. **Lưu ý**: Chỉ xóa `dirtySessionIds` sau khi ghi đĩa xác nhận thành công; nếu `fs.rename` thất bại (EPERM/EBUSY trên Windows) và fallback sang direct write, phải đảm bảo không làm mất cờ dirty nếu crash giữa chừng. Sửa lỗi `readSavedSessions` trả về mảng rỗng khi `sessions.size === 0` để tránh hồi sinh tab đã đóng.
  - `listSessions`: tối ưu hóa tìm kiếm split bằng Map tạo trước (O(S²) → O(S)), tính dung lượng buffer bytes tăng dần (incremental) thay vì `Buffer.byteLength(s.buffer)` mỗi lần gọi.
- Non-functional:
  - Giữ nguyên hợp đồng atomicity của file `terminal-sessions.json`.
  - Không phá vỡ các trường hợp alt-screen của vim/htop/less (`?1049`).

## Architecture
```
Shell Input: 'cls\r' ──> detect command ──> s.pendingClearScreen = true
                                                   │
PTY Chunk Arrives ──> if (s.pendingClearScreen) ───┤
                         s.buffer = ''             │
                         prepend '\x1b[3J' to data ┘
                         s.pendingClearScreen = false
                                │
appendData ──> journal.append (RingBuffer O(1)) ──> s.buffer += data (rope)
                                │
schedulePersist ──> mark dirtySessionIds.add(s.id)
                          │ (2s debounce)
persistAsync ──> serialize ONLY dirty sessions ──> merge with cached clean fragments ──> atomic rename
```

## Related Code Files
- Modify:
  - `src/main/browser/terminal-manager.ts` (restoredTail split, clear detection, dirty persist, waitTerminal bounds, listSessions O(S), journal ring)
- Test adaptations:
  - `test/main/terminal-stream-invariants.test.ts` (cập nhật assertion kiểm tra s.buffer vs restoredTail)
  - `test/main/terminal-subscriber-and-sync.test.ts`
  - `test/main/terminal-delivery-journal.test.ts` (bảo toàn semantics ring buffer)

## Implementation Steps
1. Mở rộng `Session` interface với `restoredTail?: string`, `pendingClearScreen?: boolean`, `altScreen?: boolean`, `inputLineBuffer?: string`.
2. Sửa `createSessionRecord` và `spawn`: gán transcript phục hồi vào `s.restoredTail`, khởi tạo `s.buffer = ''`.
3. Cập nhật các vị trí đọc buffer:
   - `getFullBuffer`: trả về `(s.restoredTail ? s.restoredTail + '\r\n── phiên trước ──\r\n' : '') + s.buffer`.
   - `listSessions` (dành cho hydration và mobile-remote): tương tự, cung cấp đầy đủ transcript.
   - `persistAsync`: chỉ serialize `s.buffer`.
   - `waitTerminal`: chỉ kiểm tra trên `s.buffer` của shell đang chạy.
4. Triển khai input-side detection trong `writeTo`: bắt `\r` với pattern `^\s*(cls|clear|Clear-Host)\s*$` hoặc `\x0c`. **Lưu ý**: Chỉ áp dụng cho shell prompt chuẩn, tránh xóa nhầm transcript khi gõ `cls` trong REPL (Node/Python) hoặc `clear` trong cmd.exe gây lỗi.
5. Trong `appendData`: theo dõi escape sequence `\x1b[?1049h`/`l` để set `s.altScreen`. Nếu `pendingClearScreen && !s.altScreen`, reset `s.buffer = ''` và gắn `\x1b[3J` vào đầu `data`.
6. Cài đặt `dirtySessionIds` và fragment cache trong `persistAsync`. **Lưu ý**: Chỉ xóa `dirtySessionIds` sau khi ghi đĩa xác nhận thành công; nếu `fs.rename` thất bại (EPERM/EBUSY trên Windows) và fallback sang direct write, phải đảm bảo không làm mất cờ dirty nếu crash giữa chừng. Sửa lỗi `readSavedSessions` trả về mảng rỗng khi `sessions.size === 0` để tránh hồi sinh tab đã đóng.
7. Chuyển đổi `SessionDeliveryJournal` sang head-index pointer để việc xóa phần tử cũ đạt O(1).
8. Giới hạn cửa sổ kiểm tra `waitTerminal` ở mức 64KB tail.
9. Tối ưu `listSessions` loại bỏ vòng lặp O(S²).

## Success Criteria
- [ ] Gõ `cls` hoặc `Clear-Host` thì scrollback biến mất ngay lập tức và không bao giờ xuất hiện lại sau khi khởi động lại app.
- [ ] Khởi động lại app N lần liên tục: chỉ thấy 1 banner PowerShell duy nhất và 1 mẩu phân cách phiên cũ, không chồng chất N banners.
- [ ] Thao tác trong vim/htop không kích hoạt nhầm clear-screen của transcript.
- [ ] Thời gian thực thi `persistAsync` khi có 50 tab đạt < 5ms trên main-thread (so với baseline ~50-100ms).
- [ ] Tất cả unit tests của journal và stream invariants đều pass.

## Risk Assessment
- Rủi ro: REPL (Node/Python) nhận diện nhầm từ khóa `cls` gây xóa nhầm buffer.
- Giảm thiểu: Ràng buộc chặt chẽ với tín hiệu enter `\r` và trạng thái `altScreen`. Bản chất transcript trong terminal là volatile nên rủi ro ở mức chấp nhận được.
