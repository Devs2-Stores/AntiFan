# Code Review — ak:code-review --pending --ultra (2026-11-03)

Packet: `local://ultra-review-evidence-packet.md`. Ứng viên: `local://ultra-review-candidates.md` (5/5 usable; A=RevC2, B=RevC4, C=RevC1, D=RevC5, E=RevC3). Same-tier best-of-5.

## Union (UltraRevVerifier) + trạng thái xử lý của controller

- **T1 (ACCEPT → ĐÃ SỬA):** `terminal-manager.ts` `persistDueAt`/`dueAt` đổi từ `Date.now()` sang `performance.now()` (đồng hồ đơn điệu, khớp timer). Thêm test bất biến pull-only ("never lets output push a pending structural write later").
- **T2 (ACCEPT → ĐÃ SỬA):** nhánh `pendingClearScreen` (`cls`/Ctrl+L) đặt `persistDelayMs = STRUCTURAL_PERSIST_DELAY_MS`.
- **W1 (ACCEPT → ĐÃ SỬA):** xóa wrapper chỉ dùng cho test `isClientAuthorizedForTerminal`; test gọi `terminalFrameGate(id)(client)` trực tiếp.
- **B1 (ACCEPT → ĐÃ SỬA):** `broadcast` benchmark ghi tổng byte thực gửi (`sentBytes`), tính cả nhánh `mobileSessionFrame`.
- **S1 (ACCEPT → ĐÃ SỬA):** `terminal-persist-cadence.test.ts` lưu và khôi phục `node-pty.spawn` trong `after()`; sửa mô tả đầu file.
- **W2, D1, D2, D3, D4, S2, I1 (ACCEPT-DOC → ĐÃ SỬA):** sửa docstring ("each attachment's home at most once"), JSDoc `isLiveSplitOf`, chú thích legacy `userPlane`, và viết lại mục CHANGELOG với đúng số đo (differential 26.620 + 23.620, 0 lệch; bench 5% split; ghi chú triển khai cần restart terminal host; flush khi thoát app là RPC bất đồng bộ).
- **T3/T4, X1–X7 (DEFER):** giữ theo quyết định verifier (có sẵn hoặc ngoài phạm vi).
- **E-F1 (REJECT):** `lastSeq` không nằm trong fragment ghi đĩa (`terminal-manager.ts:1287-1308`), nên chu kỳ 60 s không đổi hành vi seq sau restore.

ultra: union kept=22/proposed=50 scores=A:15,B:17,C:13,D:16,E:10
