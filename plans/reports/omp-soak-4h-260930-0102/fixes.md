# Fixes — giai đoạn B không đạt được (A blocked)

Giai đoạn B yêu cầu số liệu A để chọn điểm nghẽn; A blocked ở A1 nên không có bản sửa hiệu năng nào được thực hiện.

## Sửa phụ (bắt buộc để harness có thể chạy): commit 568d9dc8

- Điểm nghẽn: `ReferenceError` chắc chắn — `++rpcId` tại `scripts/smoke-omp-closed-loop.cjs:438` (tools/list) dùng biến trước `let rpcId = 100` dòng 539 trong cùng scope `executeHarness`.
- Bằng chứng: đọc trực tiếp source (TDZ JS); `[INFERENCE]` mọi lần chạy cũ trên HEAD này sẽ crash ở `tools/list` nếu execution tới được đó.
- Thay đổi: hoist `let rpcId = 100` lên ngay trước `callRpc(++rpcId, 'tools/list', …)`; xoá declaration cũ tại 539 (giữ 1 declaration duy nhất).
- Test: typecheck 0, test:fast 1726/1726, selfcheck 12/12 (tests-final.txt). Runtime proof chưa có vì Electron không tới executeHarness (INC-3).
