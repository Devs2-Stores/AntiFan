# Báo Cáo Phân Tích Điểm Yếu AntiFan Browser Desktop (Session Tototuantu)

**Ngày thực hiện:** 2026-09-05  
**File log phân tích:** `<omp-sessions-dir>/--E--Work-customizes-Tototuantu--/2026-09-05T04-42-44-030Z_01a06fe0-45be-70f8-bad9-ae99b06187a1.jsonl`  
**Quy mô session:** 429 records, 281 messages, 125 sự kiện công cụ liên quan đến AntiFan/Browser.  
**Mục tiêu session gốc:** Sửa giao diện storefront Haravan `https://<customer-storefront-domain>/` (cố định Header đen, Menu trắng và thanh Breadcrumb phân tầng sản phẩm khi cuộn trang).  
**Môi trường client:** Windows 11 Pro, chạy ngầm `hrv theme dev` (Haravan CLI file watcher).

---

## I. TỔNG QUAN ĐỊNH LƯỢNG SỬ DỤNG CÔNG CỤ ANTIFAN
Trong suốt phiên làm việc, agent đã thực hiện 40 lượt tương tác với AntiFan MCP:
- `anti.browser.evaluate`: **26 lần (chiếm 65%)** — Áp đảo hoàn toàn runtime.
- `anti.browser.navigate`: **6 lần**
- `browser_set_viewport`: **4 lần** (tất cả đều bị desync layout)
- `anti.screenshot.viewport`: **2 lần** (cả 2 lần đều hỏng: dữ liệu rỗng 0-byte)
- `anti.browser.tabs.create`: **1 lần**
- `anti.browser.tabs.list`: **1 lần** (trả về `[]` mảng rỗng)
- `anti.browser.tabs.close`: **1 lần**
- `anti.browser.reload`: **1 lần** (làm mất trạng thái URL, reset về trang chủ)
- `anti.inspect.styles`: **2 lần**
- `anti.inspect.responsive_matrix`: **1 lần**
- **Các công cụ domain cao cấp của AntiFan** (`theme.qa_validate`, `theme.debug_bundle`, `theme.assert_cart`, `storefront.resolve_product`, `anti.agent.cursor.*`, `anti.visual.compare`): **0 lần gọi (0%)** — Hoàn toàn bị bỏ qua do không hỗ trợ kiểm thử bố cục/sticky/scroll.

---

## II. CHI TIẾT 6 ĐIỂM YẾU CỐT LÕI & CĂN NGUYÊN MÃ NGUỒN

### 1. Điểm yếu 1 (P0): Screenshot trả thành công với ảnh rỗng
- **Hiện tượng thực tế:**
  - Lượt gọi [219] (`png`) và [222] (`jpeg`) đều trả MCP image content đúng kiểu nhưng `data: ""`.
  - Điều này bác bỏ chẩn đoán cũ rằng `mcp-server.ts` không map `ArtifactRef` sang MCP ImageContent: bridge đã map được kiểu ảnh, chỉ không có bytes.
- **Căn nguyên đã chứng minh trong repo:**
  - `TabDevToolsHost.captureScreenshot()` có thể trả `''` khi target/WebContents không tồn tại hoặc mọi capture tier đều thất bại (`src/main/browser/tab-devtools-host.ts:900-905,1083-1092`).
  - `BrowserControlPort.screenshot()` không kiểm tra chuỗi rỗng trước khi decode và stage (`src/main/tools/browser-control-port.ts:668-675`); `ArtifactStore.stage()` chấp nhận buffer 0 byte (`src/main/tools/artifact-store.ts:124-163`).
  - `scripts/antifan-omp-mcp.cjs:547-569` đã resolve artifact ảnh thành MCP image content đúng chuẩn.
- **Hệ quả:** Visual verification thất bại nhưng tool vẫn báo thành công. Cần fail closed trước khi stage artifact.


---

### 2. Điểm yếu 2 (P0): Viewport báo thành công mà không xác minh renderer đích
- **Hiện tượng thực tế:**
  - Các lượt [243], [313], [322] báo đã đặt viewport; [320] và [326] vẫn đọc `window.innerWidth = 1920`.
- **Căn nguyên đã chứng minh trong repo:**
  - `setViewportSize()` ghi `customViewport`, gọi `updateLayout()`, đợi touch emulation rồi trả `true`, nhưng không đo hậu điều kiện trong renderer (`src/main/browser/native-tab-host.ts:5478-5496`).
  - `updateLayout()` chỉ áp dụng emulation cho `activeTabId` (`src/main/browser/native-tab-host.ts:764-790`), trong khi setter chấp nhận một `tabId` khác. Đây là lỗi target-affinity rõ ràng đối với background tab.
  - Với active single view, `updateLayout()` đã gọi `webContents.enableDeviceEmulation()` gián tiếp qua `safeEnableDeviceEmulation()` (`src/main/browser/native-tab-host.ts:3982-4012,514-527`). Nhận định cũ “không hề gọi device metrics” là sai.
  - **[INFERENCE]** Target-affinity là nguyên nhân hợp lý cho session này, nhưng phải tái hiện trên Chromium thật mới chốt cơ chế runtime.
- **Hệ quả:** False-success làm bằng chứng mobile không đáng tin.


---

### 3. Điểm yếu 3 (P0): Reload trả thành công trước khi tài liệu sẵn sàng
- **Hiện tượng thực tế:**
  - Sau call [380] reload, call [386] quan sát tab ở trang chủ thay vì URL collection đã dùng trước đó.
- **Căn nguyên đã chứng minh trong repo:**
  - `BrowserControlPort.reload()` gọi host `reload()` dạng fire-and-forget rồi trả `reloaded: true` ngay (`src/main/tools/browser-control-port.ts:581-586`).
  - Repo đã có `NativeTabHost.reloadAndWait()` với load-completion và network-quiescence nhưng capability không dùng nó (`src/main/browser/native-tab-host.ts:3518-3568`).
  - `webContents.reload()` thông thường reload URL hiện tại; **[INFERENCE]** session chưa chứng minh cơ chế nào khiến URL về trang chủ. Có thể là redirect, navigation state hoặc race khác. Không được ghi đó là căn nguyên đã xác minh.
- **Hệ quả:** Caller kiểm tra DOM khi document chưa ổn định; hợp đồng `reloaded: true` sai nghĩa.


---

### 4. Điểm yếu 4 (P0 quy trình): Không có ranh giới rõ giữa Preview và Apply
- **Hiện tượng thực tế:**
  - User đang chạy `hrv theme dev`; agent sửa `assets/main.css`, nên watcher ngoài AntiFan đồng bộ thay đổi lên storefront.
  - In-memory CSS injection qua `anti.browser.evaluate` trước đó đã test được mà không ghi đĩa.
- **Phân loại đúng:** Đây chủ yếu là lỗi agent/workflow, không phải bằng chứng AntiFan cần một CDN proxy. CDP Fetch interception sẽ tăng rủi ro cache, Service Worker và lệch giữa CSS override với Liquid server-rendered.
- **Hướng nhỏ nhất:** chuẩn hóa một capability in-memory `anti.theme.style_override` với thao tác `apply | clear`, idempotent theo `id`, tự mất khi reload/document generation đổi. Nó chỉ là lớp an toàn/ergonomics trên cơ chế injection đã chứng minh hiệu quả; không đọc hay sửa file local.


---

### 5. Điểm yếu 5: Discovery và target/pane guidance chưa đủ rõ
- **Hiện tượng thực tế:** Agent phải đọc schema 9 lần; sau `tabs.list = []`, agent tạo background tab rồi điều khiển qua explicit `tabId`.
- **Hướng xử lý:** Cải thiện mô tả/capability catalogue và lỗi hướng dẫn `tabId`/`paneId`; không tự động chiếm tab người dùng ngoài authority hiện tại.

### 6. `anti.browser.evaluate` là escape hatch tốt, không phải lỗi kiến trúc
- 26/40 tương tác dùng evaluate và đã hoàn thành phép đo tùy biến đặc thù.
- Không xây `sticky_stack`, `scroll_collision` hay sensory suite riêng từ một session. Chỉ chuẩn hóa primitive lặp lại và có ranh giới an toàn rõ: style override in-memory.


---

## III. BẢN HỢP ĐỒNG ĐỀ NGHỊ CẢI TIẾN (BRAINSTORM DELIVERY CONTRACT)

### 1. Outcome (Mục tiêu nghiệm thu kỹ thuật)
AntiFan fail closed tại ba capability nền tảng và tách rõ Preview khỏi Apply:
- Screenshot không bao giờ trả success với ảnh 0 byte.
- Viewport chỉ trả success khi đúng renderer đích báo lại kích thước/media-query tương ứng.
- Reload chỉ trả success sau load completion/network quiescence; response nêu URL trước/sau để làm rõ redirect.
- CSS preview dùng override trong memory; không chạm workspace, không kích hoạt `hrv theme dev`.

### 2. Constraints (Ràng buộc kỹ thuật)
- Giữ nguyên `NativeTabHost`, `BrowserControlPort`, `ArtifactStore`, attachment/authority model và public verdict taxonomy.
- Không tự attach tab ngoài authority; không đánh chặn CDN; không tạo proxy server hoặc tool zoo.
- Mọi sửa lỗi phải có regression test ở đúng boundary và real-Chromium smoke cho viewport/reload/screenshot.

### 3. Non-goals (Ngoài phạm vi)
- Không thay CLI Haravan/Shopify, không quản lý watcher bên ngoài, không giả lập Liquid server-side.
- Không tự động sửa file khi ở preview mode; không thêm sticky/layout-specific tools.

### 4. Acceptance Criteria (Tiêu chí chứng minh thành công)
- Screenshot: empty capture ném `TARGET_STALE` và không tạo artifact; PNG/JPEG thật resolve thành MCP image có bytes hợp lệ.
- Viewport: explicit background `tabId` được áp dụng đúng target; response chỉ success sau khi evaluate trên cùng target xác nhận `innerWidth/innerHeight` và media query. Mismatch trả lỗi, không false-success.
- Reload: deep URL được capture trước reload; capability dùng `reloadAndWait`; response gồm `urlBefore`, `urlAfter`, `redirected`; inspection sau success thấy document mới đã load. Redirect do site được báo, không quy kết cho reload.
- Style override: `apply`/replace/`clear` idempotent theo ID; làm đổi computed style nhưng không đổi workspace mtime; cleanup được kiểm tra qua reload/document generation.


---

## IV. HƯỚNG XỬ LÝ CUỐI — SIMPLIFICATION CASCADE

**Insight:** cả ba lỗi nền tảng là một loại lỗi: capability trả success dựa trên việc “đã gọi API”, thay vì xác minh hậu điều kiện trên đúng browser/document target. Chuẩn hóa một quy tắc chung: **Effect → Observe same target → Validate → Return success; nếu không, fail closed.**

### P0 — Reliability boundary
1. `BrowserControlPort.screenshot()`: kiểm tra base64/buffer không rỗng trước `ArtifactStore.stage()`; lỗi `TARGET_STALE`; giữ nguyên secure artifact resolver hiện có.
2. Viewport: áp dụng emulation trực tiếp cho explicit target thay vì qua active-only `updateLayout()`, rồi đo `window.innerWidth`, `innerHeight` và media query trên đúng tab/pane trước success.
3. Reload: chuyển public capability sang `reloadAndWait()`; capture URL trước/sau và trả metadata redirect. Không tuyên bố reload gây redirect nếu site đổi URL.

### P1 — Safe theme preview primitive
Thêm một capability nhỏ `anti.theme.style_override` (`apply | clear`, `id`, `css`, `tabId`, `paneId`) trên runtime injection hiện có. Không CDP Fetch proxy, không đọc file disk, không đồng bộ watcher. Quy trình agent: **Preview in memory → verify → xin/nhận lệnh Apply → mới sửa workspace.**

### P2 — Discoverability only
Cải thiện descriptions và lỗi target/pane. Giữ `anti.browser.evaluate` làm escape hatch; không phát triển sensory-tool suite khi chưa có dữ liệu lặp lại từ nhiều session.

**Thứ tự triển khai chốt:** P0 trước và nhập vào Core hardening; P1 chỉ sau khi P0 qua real-Chromium proof; P2 làm cùng catalogue cleanup. CDN proxy và layout tool zoo bị loại khỏi hướng xử lý.
