# Báo Cáo Phân Tích Điểm Yếu AntiFan Browser Desktop (Session Toda)

**Ngày thực hiện:** 2026-09-05  
**File log phân tích:** `<omp-sessions-dir>/--E--Work-customizes-Toda--/2026-09-05T05-05-10-088Z_01a06ff4-cfc8-709a-8baf-2d4d0e3cceb1.jsonl`  
**Quy mô session:** 1,271 records, 716 messages, 240 lượt gọi AntiFan MCP (9 lần nộp issue trực tiếp vào `xd://report_issue`).  
**Mục tiêu session gốc:** Tùy biến storefront Haravan Toda Thailand (`https://<customer-storefront-domain>/`), xử lý feedback từ Google Sheets trên nhiều tab, lead form, trang order sample, và tạo khối 3D Online Catalogue với yêu cầu "áp Visual Compare".  
**Môi trường client:** Windows 11 Pro, chạy ngầm `hrv theme dev` (Haravan CLI file watcher).

---

## I. TỔNG QUAN ĐỊNH LƯỢNG & ĐIỂM NGHẼN (TELEMETRY)

Trong 533 lượt gọi công cụ của session, tương tác với trình duyệt chiếm tỷ trọng áp đảo:
- `anti.browser.evaluate`: **65 lần (27.1% tổng MCP calls)** — Agent bị phụ thuộc nặng nề vào raw JS eval do thiếu các primitive cơ bản (scroll tuyệt đối, đo bounding box nhanh, kiểm tra readyState).
- `anti.screenshot.viewport`: 19 lần — Bị lỗi bleed giữa các tab và lỗi trả ảnh rỗng.
- `anti.visual.compare`: 9 lượt gọi — **9 lượt thất bại trực tiếp (100% failure rate)** với `TARGET_STALE`, timeout CDP 10 giây, `TARGET_MISMATCH` và thiếu artifact.
- `report_issue`: **9 lần nộp issue** — Con số kỷ lục ghi nhận agent chủ động báo lỗi kỹ thuật của AntiFan vào issue register.
- `theme.debug_bundle`: 5 lượt — Trả sai siêu dữ liệu `target.tabId` so với tab thực tế được phân tích.
- **Tổng số lỗi kỹ thuật thực tế:** Toàn bộ phiên ghi nhận **21 lỗi runtime AntiFan MCP thực sự** (9 lỗi visual compare, 3 lỗi theme QA validate mismatch, 3 lỗi evaluate timeout/failure, 2 lỗi claim obligation schema, 2 lỗi stale document generation, 1 lỗi close tab mismatch, 1 lỗi inspect styles detached node) cùng **2 lỗi xung đột artifact ID** với harness OMP.

## II. BẢN HỢP ĐỒNG BRAINSTORM (BRAINSTORM CONTRACT)

### 1. Outcome (Kết quả mong muốn)
- Loại bỏ triệt để hiện tượng Cross-Tab Screenshot Bleed khi chụp màn hình tab chạy ngầm (background tab).
- Ổn định năng lực `anti.visual.compare`, hỗ trợ so sánh tab-to-tab hoặc tab-to-image với `selector`/`clipRect` chính xác mà không bị timeout hay false `TARGET_STALE`.
- Đồng bộ hóa siêu dữ liệu `target.tabId` trong `theme.debug_bundle` khi gọi với `tabId` cụ thể.
- Khớp nối hoàn toàn JSON Schema giữa `antifan-omp-mcp.cjs` và backend validator cho `proofObligations` trong `anti.verification.record_claim`.
- Cung cấp cơ chế phân giải hoặc chuyển đổi định dạng artifact ID giữa AntiFan (UUID) và harness (`numeric`).

### 2. Constraints (Ràng buộc kỹ thuật)
- Bảo toàn tuyệt đối cơ chế cô lập an toàn giữa các tenant/workspace.
- Không phá vỡ backward compatibility của các tool interface đã công bố.
- Mọi thay đổi phải chạy pass toàn bộ test suite hiện có (`npm run test:fast`, `npm run test:main`, `npm run smoke:terminal`).

### 3. Non-goals (Phạm vi không can thiệp)
- Không viết lại toàn bộ kiến trúc Lease / Control Plane thành multi-tenant đa tab mở rộng (yêu cầu đại phẫu kiến trúc vượt quá phạm vi khắc phục điểm yếu).
- Không nhúng CDN proxy hay sửa Haravan theme watcher bên ngoài.

### 4. Acceptance Criteria (Bằng chứng nghiệm thu)
1. Chụp ảnh màn hình background tab bằng `anti.screenshot.viewport` phải trả về đúng nội dung của background tab đó, không được lấy nhầm khung hình của foreground tab (`fromSurface: false` trên offscreen/background view).
2. `anti.visual.compare` với `comparisonTabId` thực thi thành công trên tab đang mở, áp dụng đúng `clipRect`/`selector` và trả về diff score cùng receipt hợp lệ thay vì timeout hay `TARGET_STALE`.
3. `theme.debug_bundle({ tabId })` trả về object với `target.tabId === tabId`.
4. Gọi `anti.verification.record_claim` với schema đã công bố không bị crash bởi lỗi thiếu field `metric`.

---

## III. CHI TIẾT 8 ĐIỂM YẾU CỐT LÕI & CĂN NGUYÊN MÃ NGUỒN

### 1. Điểm yếu 1 (P0): Cross-Tab Screenshot Bleed (Chụp tab này ra hình tab kia)
- **Hiện tượng:** Gọi `anti.screenshot.viewport` cho tab Google Sheets `08ce62f2...`, nhưng ảnh trả về lại là trang storefront của tab `1b1fe78a...`. Người dùng phải ngắt lời cảnh báo: *"Sai nhé, nội dung đúng là tab 08ce62f2-64c7-408c-a91e-e992aae7095a"*.
- **Căn nguyên mã nguồn:** Tại `src/main/browser/tab-devtools-host.ts:1047-1055` (Tier 2 CDP capture), lệnh gọi `Page.captureScreenshot` thiết lập `{ fromSurface: true }`. Trong Electron Chromium, `fromSurface: true` bắt buộc Chromium chụp từ OS compositor surface của cửa sổ — nơi mà chỉ tab active/foreground mới đang được vẽ trực tiếp! Do đó, khi tab mục tiêu nằm ở background, CDP lấy luôn hình ảnh của tab active phía trước.
- **Giải pháp:** Thiết lập `fromSurface: false` hoặc sử dụng offscreen view render khi tab mục tiêu không phải là active visible tab của window.

### 2. Điểm yếu 2 (P0): `anti.visual.compare` tê liệt trên Background/Reference Tabs
- **Hiện tượng:** Agent gọi visual compare 9 lần đều gặp sự cố `TARGET_STALE: Failed to capture non-empty viewport screenshot` hoặc timeout 10 giây. Agent đành bỏ cuộc dù người dùng nhấn mạnh: *"Chỗ Online Catalogue làm y chang dùm, áp Visual Compare"*.
- **Căn nguyên mã nguồn:**
  - `src/main/tools/browser-control-port.ts:2357` và `2410`: `visualCompare()` gọi `this.host.captureScreenshot(undefined, tabId, ...)` với `undefined` cho tham số `rect`. Nó không hề truyền `clipRect` hay tính toán tọa độ của `selector` vào lệnh chụp, dẫn đến việc luôn cố chụp full viewport. Khi tab so sánh ở background, lệnh chụp viewport bị rỗng và ném lỗi `TARGET_STALE`.
  - CDP command `Page.captureScreenshot` trên tab nền không có compositor pump nên bị timeout sau 10,000ms.
- **Giải pháp:** Trong `visualCompare()`, nếu có `selector` hoặc `clipRect`, giải quyết bounding rect trước và truyền trực tiếp `rect` vào `captureScreenshot()`. Kích hoạt render pump cho background comparison tab trước khi chụp.

### 3. Điểm yếu 3 (P1): Đơn nhiệm Tab cứng nhắc & Lỗi `TARGET_MISMATCH`
- **Hiện tượng:** Khi agent cố gắng đóng tab phụ bằng `anti.browser.tabs.close` hoặc kiểm định bằng `theme.qa_validate`, hệ thống quăng lỗi `TARGET_MISMATCH: This session is isolated to tab "08ce62f2-..." and its managed tabs`.
- **Căn nguyên mã nguồn:** `browser-control-port.ts:941-943` và `browser-capabilities.ts:1168-1170` áp đặt cơ chế tab lease đơn nhiệm. Mọi hành động nhắm vào tab khác ngoài tab đã bind ban đầu đều bị từ chối, gây cản trở lớn khi workflow cần tham chiếu Google Sheet song song với Storefront.
- **Giải pháp:** Cho phép các lệnh read-only (`inspect`, `debug_bundle`, `validate`) và lệnh lifecycle (`tabs.close`) chấp nhận các tab hợp lệ thuộc cùng một session/project mà không chặn cứng bằng `TARGET_MISMATCH`.

### 4. Điểm yếu 4 (P1): Lệch siêu dữ liệu trong `theme.debug_bundle`
- **Hiện tượng:** Record [689] nộp issue: nội dung DOM và Liquid được quét từ tab sản phẩm/đặt hàng, nhưng trường `target.tabId` trong object trả về lại ghi ID của tab chính sách (`8712ef0d-...`).
- **Căn nguyên mã nguồn:** `src/main/tools/browser-capabilities.ts:1316, 1338`: `const target = context.browserTarget as BrowserTarget;` và trả nguyên vẹn `target` này mà không cập nhật `target.tabId = params.tabId || target.tabId`.
- **Giải pháp:** Tạo bản sao nông của `target` với `tabId: params.tabId || target.tabId` trước khi trả về kết quả.

### 5. Điểm yếu 5 (P1): Schema Drift trong `anti.verification.record_claim`
- **Hiện tượng:** Record [790] nộp issue: agent truyền `proofObligations` hợp lệ theo schema nhưng bị backend văng lỗi `INVALID_ARGUMENT: Obligation at index 0 must have a non-empty metric string`.
- **Căn nguyên mã nguồn:** `scripts/antifan-omp-mcp.cjs:55` khai báo schema `proofObligations: { type: 'array', items: { type: 'object' } }` (rỗng, không có thuộc tính con), trong khi `browser-capabilities.ts:2546-2548` lại kiểm tra bắt buộc `obl.metric` phải là chuỗi không rỗng.
- **Giải pháp:** Cập nhật schema trong `scripts/antifan-omp-mcp.cjs` với đầy đủ định nghĩa `properties: { id, metric, tolerance, critical, expected }` và `required: ['metric']`.

### 6. Điểm yếu 6 (P1): Xung đột định dạng Artifact URI giữa AntiFan và Harness
- **Hiện tượng:** Agent cố đọc kết quả bằng `read(path="artifact://artifact-586415ab...")` nhưng bị harness từ chối: `artifact:// ID must be numeric`.
- **Căn nguyên mã nguồn:** OMP harness chỉ chấp nhận ID số (`artifact://<number>`), trong khi AntiFan `ArtifactStore` sinh ID dạng UUID (`artifact-<uuid>`).
- **Giải pháp:** Cung cấp helper hoặc bridge trong `antifan-omp-mcp.cjs` để ánh xạ hoặc tự động resolve UUID artifact sang nội dung text/image tương thích với MCP client.

### 7. Điểm yếu 7 (P2): Đụng độ khóa khi tổng hợp công cụ trong `eval`
- **Hiện tượng:** Record [648-651]: Agent gọi 24 tool song song trong `eval` bằng `Promise.all(tool.write(...))` để kiểm tra 8 routes cùng lúc. Toàn bộ các lượt gọi trả về rỗng do đụng độ `viewportGate.withLock`.
- **Giải pháp:** Hướng dẫn hoặc bổ sung cơ chế xếp hàng tuần tự (serial queue) trong bridge hoặc khuyến cáo agent không batch song song các write tool qua eval.

### 8. Điểm yếu 8 (P2): Khoảng trống tiện ích cấp cao (65 lượt gọi `anti_browser_evaluate`)
- **Hiện tượng:** Agent phải tự viết script JS để lấy tọa độ scroll, cuộn trang `window.scrollTo`, và kiểm tra `readyState`.
- **Giải pháp:** Bổ sung primitive `anti.browser.scroll_to({ x, y, behavior })` và `anti.inspect.geometry({ selector })` để agent không phải fallback về raw JS.

---

## IV. SO SÁNH CÁC PHƯƠNG ÁN TIẾP CẬN (TRADE-OFF ANALYSIS)

| Tiêu chí | Phương án A: Surgical Core Hardening (Khuyến nghị) | Phương án B: Full Multi-Tab Re-architecture |
|---|---|---|
| **Phạm vi thay đổi** | Tập trung sửa chính xác 5 điểm yếu P0-P1: `fromSurface: false` cho background capture, truyền `rect` cho `visualCompare`, sync `target.tabId` trong `debug_bundle`, sửa schema `proofObligations`, nới lỏng `TARGET_MISMATCH` cho read/close. | Viết lại toàn bộ kiến trúc Target Lease thành Multi-Target Context, thay đổi định dạng Artifact sang số nguyên, tái thiết lập Viewport Lock. |
| **Độ phức tạp** | Thấp - Trung bình (~120 dòng code, không chạm core architecture). | Rất cao (~800 dòng code, ảnh hưởng toàn bộ test suite và race condition). |
| **Thời gian triển khai** | Nhanh chóng, có thể hoàn tất và kiểm chứng ngay trong phiên làm việc. | Kéo dài nhiều ngày, rủi ro hồi quy cao. |
| **Tác động đến người dùng** | Giải quyết ngay 100% các lỗi mà agent Toda đã gặp và báo cáo qua `report_issue`. | Có thể giải quyết triệt để vấn đề concurrency nhưng tiềm ẩn rủi ro bảo mật lease. |

---

## V. KẾ HOẠCH HÀNH ĐỘNG (WORK CHECKLIST)
- [x] Phân tích toàn diện 1,271 records và trích xuất danh sách 9 `report_issue`.
- [x] Lập hồ sơ bằng chứng bất biến (`antifan-session-toda-evidence-packet.md`).
- [ ] Tham vấn cố vấn chiến lược (`kongming`) để đánh giá thứ tự ưu tiên và rủi ro.
- [ ] Tổng hợp phản hồi từ Kongming vào kết luận và định hướng hoàn tất.
