# SUPERSEDED — Evidence Packet (bản cũ, có lỗi)

**File này đã bị thay thế.** Bản dùng cho lượt chạy hiện tại:
`plans/reports/ultra-260910-stuck/evidence-packet.md`

## Hai lỗi đã được bác bỏ trong bản cũ

1. **`webSecurity: true` (mục D1)** — bản cũ mô tả nó như thứ "chặn test HTTP storefront local / self-signed cert". **Sai.** `webSecurity: true` áp Same-Origin Policy chuẩn của Chromium; nó không chặn điều hướng HTTP thông thường. Ngoài ra ranh giới an ninh **không phải** ứng viên để gỡ bỏ: app render nội dung storefront bên thứ ba và mở RPC local.
2. **"Không có mô hình hiểm họa mạng ngoài"** — **sai**. App thực thi JavaScript của storefront bên thứ ba trên internet.

## Lỗi phương pháp khác trong bản cũ

3. Bản cũ trình bày **kết luận áp đặt** trong phần mô tả dimension thay vì câu hỏi + quan sát đã dẫn nguồn, khiến 5 candidate có nguy cơ trở thành **xác nhận tương quan** thay vì scout độc lập.
4. Bản cũ khẳng định "mọi sửa đổi `src/main/**` đều bị hard restart" mà không nêu đường soft-reload đã có (`antifan.system.reloadScripts`) và phạm vi thật của nó.

## Ghi chú kiểm chứng

`.canary/tools/canary-settle.mjs` **có tồn tại** (45 file trong `.canary/tools/`). Lưu ý: `.canary/` nằm trong `.gitignore`, nên công cụ grep tôn trọng gitignore sẽ **không** thấy nó — dễ dẫn tới kết luận sai rằng file không tồn tại.
