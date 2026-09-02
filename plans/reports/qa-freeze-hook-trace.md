# Báo Cáo Phân Tích Đường Dẫn Gọi & Loại Bỏ Fixture `qa-freeze-hook.js`

## 1. Bản Chất Fixture & Phân Tích Đường Dẫn Gọi (Invocation Tracing)
- **Tập tin đã xóa**: `benchmark-hoplongtech/assets/js/qa-freeze-hook.js`
- **Thẻ liên kết trong HTML**: `<script src="assets/js/qa-freeze-hook.js"></script>` trong `benchmark-hoplongtech/index.html` (Đã gỡ bỏ).
- **Hành vi ban đầu**:
  File này định nghĩa hàm toàn cục `window.__antiFreezeState(options)`. Khi được kích hoạt, nó thực hiện các thao tác mang tính phá hủy (destructive mutations):
  1. `for (let i = 1; i < 99999; i++) clearInterval(i);` (Hủy toàn bộ timer trong trình duyệt)
  2. Chèn style ép `transition: none !important; animation: none !important;` vĩnh viễn trên DOM.
- **Kết quả điều tra gọi hàm (Callsite Analysis)**:
  - Quét toàn bộ repository: **0 lời gọi tự động** (`zero in-repo programmatic callers`).
  - Đường dẫn kích hoạt duy nhất là các lệnh gọi thủ công ad-hoc qua công cụ `anti.browser.evaluate` (`window.__antiFreezeState()`) trong các phiên benchmark ban đầu của lập trình viên nhằm cố định khung hình cho visual compare.

## 2. Quyết Định Kỹ Thuật (Superseded Decision)
- Cơ chế freeze hủy diệt này chính thức bị **loại bỏ hoàn toàn**.
- Thay thế bằng **Reversible-State Contract** và **Two-Phase Settle Policy** trong `packages/site-clone`:
  1. Sử dụng Clean-Tab Protocol (`anti.browser.reload` hoặc tab mới) trước khi thực hiện các bài kiểm tra hành vi tương tác.
  2. Sử dụng `CanvasMaskingHelper` với dual-geometry union masks để loại trừ các vùng động (dynamic widgets) thay vì can thiệp bạo lực vào timer hay DOM của trang web.
