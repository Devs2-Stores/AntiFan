# AntiFan Browser Desktop — Changelog

Tất cả các thay đổi, tính năng mới và bản vá lỗi quan trọng của AntiFan Browser Desktop.

---

## [v1.4.2] - 2026-08-28 (Annotation Popup Compact & Queue Prefix)

### Popup Annotation — /queue Prefix & Gọn Lại
- Popup Annotation mặc định bắt đầu bằng tiền tố `/queue `: mọi annotation được đẩy vào hàng đợi agent (`/queue`) ngay khi mở, chỉ cần gõ yêu cầu; nếu xoá tiền tố, nó được tự chèn lại lúc gửi.
- Xoá nút đính kèm ảnh và dòng gợi ý phím tắt trên footer — popup gọn chỉ còn nút Gửi; dán ảnh (Ctrl+V) và kéo-thả ảnh vẫn hoạt động như cũ.
- Popup đáp ứng kích thước màn hình: rộng `min(92vw, 400px)` (to hơn trên màn lớn, co gọn trên màn nhỏ), định vị dựa trên kích thước đo thực tế nên không tràn viewport dù textarea tự nở rộng.

## [v1.4.1] - 2026-08-28 (Per-Tab Terminal Memory Fix)

### Popup Annotation — Ghi nhớ Terminal theo từng tab
- Sửa lỗi Popup Annotation dùng nhầm Terminal của tab khác: trước đây lựa chọn Terminal được lưu ở một slot toàn cục (`lastAnnotationSessionId`) + `localStorage` chia sẻ theo origin, nên chọn Terminal B ở tab 2 sẽ ghi đè lựa chọn Terminal A ở tab 1.
- Lựa chọn Terminal giờ được lưu **theo từng tab** (`tab.state.terminalSessionId`, field đã có sẵn trong contract `AntiFanTab`); `startInspect`, `did-finish-load` và poll 200ms chỉ đọc/ghi đúng tab đang inspect.
- Xoá toàn bộ đọc/ghi `localStorage['antifan_last_annotation_session_id']` khỏi element-picker — hết rò rỉ giữa các tab cùng origin.
- Poll inspect được khoá chặt vào `inspectedTabId`: chuyển tab giữa lúc inspect không còn đọc nhầm context của tab khác.
- Nối dây kênh IPC chết `SET_TAB_TERMINAL_SESSION` (`antifan:toolbar:set-tab-terminal-session`) — bổ sung handler tại `NativeTabHost`.
- Giữ backward-compat: `getLastAnnotationSessionId()` / `setLastAnnotationSessionId()` vẫn hoạt động (mặc định theo tab đang active, hỗ trợ tham số `tabId`).
- Tab mới chưa chọn Terminal vẫn mặc định `auto`; session bị đóng/kill → tự động quay về `auto`, không crash. Thêm regression test `test/main/per-tab-terminal-session.test.ts`.

### Diagnostics Trust Gate
- `TabDiagnosticsManager` thêm `clear()`: buffer diagnostics bị xoá ĐỒNG BỘ tại `did-start-navigation` (main-frame, không in-place, pane có quyền điều hướng) — dữ liệu QA không còn nhiễm từ navigation trước.
- Console/failure entries gắn `origin` + `isFirstParty` tại thời điểm record (tính theo URL tab); eval/blob/data/javascript fallback page-owned, không bao giờ throw.

### Shared Diagnostics Filter
- Module `src/main/qa/diagnostics-filter.ts` là nguồn duy nhất: `computeOrigin`, `classifyDiagnostics`, `sanitizeDiagnosticText`, `stripUrlQuery`, `confineWorkspaceRoot`.
- Verdict: console level ≥ 3 và network failure (Chromium NetError âm, trừ `-3` aborted) từ first-party/theme-asset CDN (`hstatic.net`, `shopifycdn.com`, `cdn.shopify.com`, `cdn.sapo.vn`) → critical; third-party noise (GTM, FB Pixel, chat widget) → warning; main-frame failure luôn critical.
- Cả full path `ThemeQaWorkflow.validate` lẫn fallback path đều dùng chung filter → cùng verdict; fallback giờ luôn trả `summary` đầy đủ (`passed`/`totalIssues`/`criticalCount`).
- Sanitize đầu ra: bỏ control chars/backticks/role markers, cắt query string (token/email không lộ vào prompt); workspaceRoot confine chống traversal.

### Self-QA Directive trong Annotation Prompt
- `buildAgentTaskHeader` chèn directive Self-QA: sau khi sửa file gọi `theme.qa_validate`, chỉ báo hoàn tất khi `summary.passed === true && criticalCount === 0`, tối đa 2 vòng tự sửa; nhánh fallback khi tool thiếu/lỗi auth (`ATTACHMENT_REQUIRED`/`ATTACHMENT_INVALID`/`MCP_CONTEXT_REQUIRED`) → báo dev xác nhận visual, CẤM bịa kết quả QA.
- Intents read-only (review/research/security/documentation/testing/extract-component) dùng variant bằng chứng không bắt buộc.
- `AGENT_CONTRACT_VERSION` 3.0.0 → 3.1.0 (đồng bộ test literal + evidence envelope).

## [v1.3.0] - 2026-08-27 (Theme QA & Verification Gate Release)

### E-Commerce Platform Detection (Haravan, Sapo, Shopify)
- Tích hợp `PlatformDetector` nhận diện tự động nền tảng Theme qua cấu trúc thư mục (`settings_schema.json`, `.bwt` vs `.liquid`, `package.json`), domain runtime (`haravan.com`, `mysapo.net`, `myshopify.com`) và script CDN (`hstatic.net`, `bizweb.dktcdn.net`, `cdn.shopify.com`).

### Zero-Liquid Error Scanner (RT-01, RT-05)
- Tự động phát hiện lỗi biên dịch Liquid runtime (`Liquid error:`, `missing_include`, `filter_error`, `translation_missing`, `syntax_error`).
- Áp dụng bộ lọc loại trừ thông minh (RTE / Rich Text Content Exclusion) không báo lỗi giả khi nội dung văn bản trong bài viết hoặc mô tả sản phẩm chứa từ khoá "Liquid error".

### Responsive Layout Overflow Engine & Culprit Attribution (RT-04, RT-06)
- Quét tự động tràn ngang (Horizontal Layout Overflow) trên 3 breakpoints chuẩn e-commerce (Mobile 375px, Tablet 768px, Desktop 1440px).
- Bổ sung ngưỡng deadband sub-pixel 0.5px loại trừ sai số làm tròn floating-point của trình duyệt.
- Thuật toán Culprit Attribution xác định chính xác thẻ DOM và selector gây tràn ngang cùng toạ độ bounding box.

- Tích hợp bộ quy tắc kiểm định tương thích Haravan / Sapo / Shopify (đã triển khai HS-01 đến HS-06, mở rộng theo lỗi thực tế từ pilot):
  - **HS-01**: Kiểm tra form Add to Cart (`name="variantId"` cho Sapo vs `name="id"` cho Haravan/Shopify).
  - **HS-02**: Kiểm tra endpoint form liên hệ (`action="/postcontact"` cho Sapo vs `action="/contact"` cho Haravan/Shopify) và sự hiện diện trường `contact[email]`.
  - **HS-03**: Casing trường blog comment trên Sapo (`Author/Email/Body` chuẩn hoa chữ đầu vs dạng thường).
  - **HS-04**: Kiểm tra handler xoá địa chỉ khách hàng (`deleteAddress`) — engine runtime chứng minh sự vắng mặt qua `typeof`, fallback static chỉ cảnh báo (không thể chứng minh handler thiếu vì có thể nạp từ script ngoài).
  - **HS-05**: Ảnh featured phải dùng URL CDN tuyệt đối của đúng nền tảng (`hstatic.net` / `dktcdn.net` / `cdn.shopify.com`).
  - **HS-06**: Script analytics/nặng phải được bảo vệ bởi guard noPS/StartOptimize trước khi tải.

### MCP Stdio Capabilities & Renderer QA Badge
- Expose 2 MCP Tools mới cho AI Coding Agents (Antigravity, Claude Code, Cursor): `theme.qa_validate` và `theme.debug_bundle` (hỗ trợ alias `antifan_theme_qa_validate`, `antifan_theme_debug_bundle`).
- Tích hợp Theme QA Badge trên Toolbar Renderer hiển thị trạng thái và kích hoạt quét kiểm thử storefront nhanh.
- Tự động lọc thông tin nhạy cảm (PII Sanitization - email, số điện thoại, token) trên toàn bộ báo cáo và artifact lưu trữ.

### Trusted Diagnostics Gate & Annotation Self-QA Prompt
- Diagnostics buffer được xoá đồng bộ tại `did-start-navigation` (main-frame, đúng authority pane) — hết lỗi ma khi navigate A→B; mọi console/network entry mang theo `origin`/`isFirstParty` để phân loại theo nguồn.
- Shared filter `diagnostics-filter` dùng chung cho full path + fallback quick path: verdict nhất quán, `summary` object đầy đủ trên cả hai path (3rd-party noise chỉ là warning, không fail gate), workspace root bị confine chống path traversal.
- Prompt annotation giờ yêu cầu agent tự gọi `theme.qa_validate` sau khi sửa (tối đa 2 vòng tự sửa) với fallback không tool / lỗi auth / hết vòng — CẤM bịa kết quả QA; `AGENT_CONTRACT_VERSION` bump `3.0.0` → `3.1.0`.

---

## [v1.2.4] - 2026-08-19 (AntiFan Unified Release)

### Desktop Viewport Auto-Fit Zoom & Presets
- Tự động tính toán tỷ lệ `fitScale = min(1.0, availableWidth / presetWidth)` và áp dụng `webContents.setZoomFactor(fitScale)` khi chọn kích thước thiết bị Desktop (FHD 1920×1080, 1728×1117, 1440×900).
- Khắc phục triệt để lỗi tràn ngang (horizontal viewport clipping) trên màn hình nhỏ hoặc khi mở đồng thời Sidebar Chat, đảm bảo website luôn hiển thị vừa khít 100% không bị che khuất nội dung.

### Google Chrome Parity: Ctrl + Mouse Wheel Zoom
- Bổ sung phím tắt chuẩn Google Chrome: giữ `Ctrl` (hoặc `Cmd`) kết hợp lăn chuột (Mouse Wheel) để phóng to / thu nhỏ nội dung trang web mượt mà từ 25% đến 500% theo bước nhảy 10%.

### Single-Bridge IPC Command Dispatch & Multi-Chat Loop Fix
- Thay thế toàn bộ cơ chế ghi file shotgun đa thư mục bằng việc xác định đúng Workspace đích và ghi duy nhất vào `.antigravity/mcp-bridge/${cmdId}.json` kèm `conversationId`.
- Triệt tiêu 100% hiện tượng tin nhắn bị loop vô hạn hoặc phát tán sang tất cả các phiên chat đang hoạt động trong IDE.

### Rich Markdown Table Rendering
- Tích hợp bộ tiền xử lý Markdown Tables với container bo góc hiện đại, tự động trích xuất bảng biểu thành placeholder `ANTIFANTABLEBLOCK` trước khi xử lý đoạn văn, loại bỏ lỗi bảng vỡ do thẻ `<p>`.

---

## [v1.2.3] - 2026-08-19

### Performance & Continuous Live Streaming Sync
- Kích hoạt phần cứng GPU toàn diện trong Electron/Chromium: bỏ qua danh sách đen GPU (`ignore-gpu-blocklist`), bật GPU rasterization, zero-copy memory transfer và smooth-scrolling giúp cuộn trang và hiệu ứng mượt mà 60fps.
- Tắt tính năng `CalculateNativeWinOcclusion` trên Windows giúp triệt tiêu hiện tượng giật lag/drop frame khi sử dụng đa màn hình hoặc nhiều cửa sổ.
- Giữ toggle Work luôn mở (`open = true`) và cập nhật liên tục theo thời gian thực trong suốt quá trình Agent đang suy nghĩ hoặc gọi tool calls. Chỉ tự động đóng lại khi cả turn hoàn tất 100%.
- Nâng cấp cơ chế đồng bộ Live Transcript: theo dõi trực tiếp thư mục logs và stat poll 500ms. Bảo đảm không bị mất hoặc nghẽn sự kiện trên Windows.
- Bộ nhớ đệm Markdown Render Cache (LRU Map) trong Sidebar Chat giúp tái sử dụng HTML đã render của các tin nhắn trước đó, triệt tiêu CPU spike khi streaming.

### GPU Lens Zoom & Color Loupe (DPI & Aspect Ratio Fix)
- Khắc phục triệt để lỗi vỡ hình và méo tỷ lệ ảnh trong Lens Zoom do sai lệch toạ độ `devicePixelRatio` giữa ảnh chụp `capturePage` và CSS viewport trên màn hình Windows High-DPI.
- Tính toán tỷ lệ co giãn thực tế (`scaleX`, `scaleY`) theo pixel bitmap gốc của viewport, bảo đảm hình ảnh trong Lens luôn sắc nét 100%, đúng vị trí và không bị biến dạng.
- Hỗ trợ render Canvas High-DPI (`220px * dpr`) với đường cắt tròn (circular clip mask) chống răng cưa.
- Bổ sung lưới pixel chuyên dụng (Pixel Grid) khi phóng to >= 4x giúp dò tìm pixel và mã màu HEX chính xác như trong Figma/Photoshop.

### Thinking Markdown Formatting & Section Headers
- Định dạng toàn diện Markdown bên trong khung Thinking: tự động chuyển đổi tiêu đề in đậm `**...**` thành các khối section header tinh tế với biểu tượng ✦, tô màu inline code `` `...` ``, danh sách gạch đầu dòng và khoảng cách đoạn văn chuẩn typography.

### Continuous Message Queue Auto-Dispatch
- Tự động đẩy tin nhắn tiếp theo trong Hàng chờ (Message Queue) ngay khi Turn của Agent kết thúc (`isRunning: false` trong `onSessionChanged`).
- Bổ sung cơ chế Watchdog giám sát trạng thái idle định kỳ, bảo đảm không bao giờ bị kẹt hàng chờ.

### Agent Browser (Visual AI Cursor & Chromium Web Automation)
- Bổ sung chế độ Agent Browser 100% tương đồng Antigravity IDE:
  - Con trỏ chuột AI Agent phát sáng (`🤖 Agent`) di chuyển mượt mà trên trang web theo thời gian thực.
  - Hiệu ứng gợn sóng (ripple wave pulse) khi click và spotlight quang bao quanh element mục tiêu.
  - Bong bóng thông báo hành động (Action Banner) và mô phỏng gõ phím từng ký tự (Typing simulation).
  - Tích hợp đầy đủ bộ công cụ Agent Automation qua MCP và WebSocket Bridge: `antifan_agent_click`, `antifan_agent_type`, `antifan_agent_scroll`, `antifan_agent_hover`, `antifan_agent_highlight`, `antifan_agent_clear`.

### Strict Workspace & Session Prompt Routing Isolation
- Khắc phục triệt để lỗi prompt bị gửi đồng loạt tới tất cả các cửa sổ Antigravity IDE đang mở.
- Xây dựng thuật toán `findWorkspaceRoot(path)` phân tích transcript và trích xuất chính xác thư mục workspace gốc của từng phiên trò chuyện.
- Cơ chế phân luồng đơn (Single-Targeted Bridge Dispatch): Chỉ ghi lệnh MCP bridge duy nhất vào thư mục `.antigravity/mcp-bridge` của đúng Workspace được chọn.

### Windows Desktop Installation & Application Icon
- Tạo icon ứng dụng độ phân giải cao (`assets/icon.png` và `assets/icon.ico`) với phong cách neon cyan / orbital particle sang trọng.
- Gắn icon chính thức vào cửa sổ BrowserWindow và thanh Taskbar trên Windows.
- Tạo bộ cài đặt Shortcut tự động trên Windows (`npm run install:shortcut`): tạo Shortcut "AntiFan Browser" trực tiếp trên Desktop và Start Menu.

---

## [v1.2.2] - 2026-08-19

### Assistant Turn Aggregation & Single Work Drawer
- Gộp tất cả các bước trung gian (Thinking và các Tool Calls liên tiếp) trong một phiên trả lời của Assistant vào một turn duy nhất.
- Thay vì tạo hàng chục dòng "Worked for a few seconds" rời rạc, giờ đây toàn bộ các bước thực thi được gom gọn trong 1 toggle tổng thể.
- Trong khi đang phản hồi trực tiếp (streaming): khối được mở để người dùng theo dõi các bước xử lý live.
- Khi phản hồi hoàn tất: khối tự động đóng lại thành một dòng duy nhất.

### Annotation Comment Validation
- Bắt buộc phải có comment người dùng mới được gửi annotation theo đúng chuẩn `E:\Work\apps\antigravity-browser`.
- Hiển thị cảnh báo màu đỏ "Add a comment before sending to Chat." bên dưới textarea và tự động focus con trỏ nếu bấm Send/Enter khi chưa nhập nội dung.

---

## [v1.2.1] - 2026-08-19

### Message Queue Edit & Session Scoping
- Bổ sung nút "Sửa" (Edit) cho từng tin nhắn trong hàng chờ: đưa toàn bộ nội dung text, phần tử đính kèm (Element Chip) và ảnh chụp trở lại khung soạn thảo.
- Hàng chờ tin nhắn được phân tách độc lập theo từng phiên chat (session ID).

### IDE Pause Sync
- Đồng bộ nút Tạm dừng (Pause) trực tiếp với Antigravity IDE: phát lệnh abortTurn qua file command bridge và kênh WebSocket abortPrompt.

### Dynamic Skill & Agent Catalog
- Tích hợp SkillScanner tự động quét và đồng bộ toàn bộ hơn 100+ skill được cài đặt trong thư mục `~/.gemini/config/skills/`, plugins và workspace `.agents/skills/` vào menu autocomplete.

---

## [v1.2.0] - 2026-08-19

### Annotation & Element Picker Auto-Submit
- Tự động dispatch lệnh sendToAgentPanel và phát tới đúng phiên làm việc (active session/tab) ngay khi người dùng nhấn Gửi hoặc Enter trên Modal Annotation.
- Lưu trữ toàn bộ file task Markdown vào `.antigravity/annotations/` và ảnh chụp DOM vào `.antigravity/snapshots/` trong thư mục workspace active.
- Đồng bộ đầy đủ preview chip phần tử trên Chat Composer với thông số tag, class, kích thước, font chữ, màu sắc và ảnh thumbnail.

### Window State & Multi-Monitor Persistence
- Triển khai WindowStateManager tự động ghi nhớ toạ độ (x, y), kích thước (width, height) và trạng thái phóng to (isMaximized) vào `window-state.json`.
- Hỗ trợ tự động nhận diện hệ thống đa màn hình qua `screen.getAllDisplays()`, đảm bảo cửa sổ mở lại đúng vị trí trên màn hình phụ.

---

## [v1.0.0] - 2026-08-15 (Production Release)

### Multi-Tab Chromium Architecture & Developer Tools
- Quản lý nhiều tab độc lập bằng WebContentsView với bảo mật webPreferences nghiêm ngặt.
- Quick Inspect, Font Finder, GPU Lens Zoom, Pixel Ruler & Layout Grid.
- Tích hợp docked Developer Tools gắn cố định ở cạnh dưới.
