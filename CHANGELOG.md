# AntiFan Browser Desktop — Changelog

Tất cả các thay đổi, tính năng mới và bản vá lỗi quan trọng của AntiFan Browser Desktop.

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
