# AntiFan Browser Desktop (Lite Extension Bridge)

Trình duyệt Chromium Desktop siêu nhẹ, đóng vai trò là **Companion Engine & Extension Bridge** phục vụ Antigravity / VS Code Extension và AI Agent.

> 🔒 **LƯU Ý PHẠM VI DỰ ÁN (PERSONAL USE ONLY):**
> - **Dùng cá nhân & Nội bộ 100%:** Ứng dụng này được phát triển phục vụ mục đích cá nhân trong quy trình kỹ thuật Theme E-commerce & AI Automation.
> - **Không Public / Không Thương mại hóa:** Bỏ qua hoàn toàn các yêu cầu liên quan tới Public Distribution, Chrome Web Store, App Store, chứng chỉ số thương mại (EV Code Signing Authenticode), hoặc hạ tầng Auto-update công cộng.
> - **Tập trung tối đa:** Toàn bộ nỗ lực kỹ thuật tập trung 100% vào chất lượng code, độ ổn định tuyệt đối, tốc độ thực thi, khả năng quét lỗi Theme QA chuyên sâu (Haravan, Sapo, Shopify) và bộ công cụ MCP Agent.

---

## 🎯 Mục đích & Kiến trúc Cốt lõi

1. **Chromium-First Authority (`WebContentsView`)**:
   - Khắc phục 100% hạn chế của Webview Iframe (vượt qua hoàn toàn CORS, X-Frame-Options, CSP, cookie authentication).
   - Hỗ trợ đăng nhập trực tiếp Google, Facebook, Haravan Admin trên trang storefront.
2. **High-Fidelity DOM Inspection & GPU Capture**:
   - Tích hợp Element Picker: Click chọn phần tử bất kỳ trên giao diện để trích xuất Selector, XPath, CSS Styles, và ảnh chụp pixel-perfect gửi về cho AI Agent.
   - GPU Lens Zoom 1.5x - 5.0x mượt mà.
3. **Local Extension Bridge (`127.0.0.1:20129`)**:
   - WebSocket RPC Server bảo mật với session token.
   - Giao tiếp 2 chiều với Extension trong IDE (nhận lệnh duyệt web, gửi event khi user inspect phần tử).
4. **Model Context Protocol (MCP)**:
   - Chạy chế độ `--mcp-server` để cung cấp tool duyệt web trực tiếp qua stdio cho Antigravity IDE, Claude Code, Cursor.
5. **Siêu nhẹ & Hiệu năng cao**:
   - Không chứa bloatware (đã loại bỏ toàn bộ sub-processes, AI loop riêng, checkpoint thừa).
   - Khởi động tức thì, tiêu tốn <150MB RAM.

---

### Annotation & định tuyến Workspace
- Element Picker thu thập selector/XPath, ngữ cảnh DOM, computed styles, ảnh chụp và tối đa các ảnh đính kèm để đưa vào prompt cho AI.
- `Tự động (theo site URL)` lưu annotation vào project tương ứng dưới `E:\Work\customizes`, `E:\Work\themes` hoặc `E:\Work\apps`; tên project khớp chính xác luôn được ưu tiên trước hậu tố số.
- Khi người dùng chọn một terminal session cụ thể, lựa chọn đó là nguồn quyết định cho cả nơi lưu artifact và nơi gửi prompt. Chế độ tự động ngăn annotation rơi vào session đang active nhưng không liên quan.
- Artifact được ghi vào `.antifan/annotations` và `.antifan/snapshots` của project đích. `auto` gửi prompt ngay tới terminal; `draft` giữ delivery ở trạng thái chờ.

## 🚀 Hướng dẫn Chạy & Phát triển

### Cài đặt & Build
```powershell
npm install
npm run compile
```

### Chạy Development (Hot-Reload)
```powershell
npm run dev
```

### Chạy Tests & Typecheck
```powershell
npm test
npm run typecheck
npm run verify
npm run smoke:persistence
npm run smoke:google
```

`smoke:persistence` xác minh cookie, localStorage, IndexedDB và OAuth popup qua hai tiến trình Electron. `smoke:google` chạy kiểm tra live Google, nên cần kết nối mạng.

### Zoom giao diện ứng dụng
- `Ctrl+Alt+=` tăng zoom UI AntiFan.
- `Ctrl+Alt+-` giảm zoom UI AntiFan.
- `Ctrl+Alt+0` đưa zoom UI về 100%.
- `Ctrl+/-/0` vẫn giữ nguyên cho zoom trang Chromium.

---

## 🔌 Giao thức Bridge & MCP Tools

### WebSocket RPC Methods:
- `antifan.openTab({ url })`
- `antifan.closeTab({ tabId })`
- `antifan.switchTab({ tabId })`
- `antifan.navigate({ url, tabId })`
- `antifan.getDOM({ selector })`
- `antifan.captureScreenshot()`
- `antifan.toggleInspect()`
- `antifan.getStatus()`
- `antifan.getRuntimeBinding()` trả lease và browser target hiện hành cho OMP client đã xác thực. Client phải lấy lại binding sau navigation hoặc khi lease hết hạn.

### MCP Stdio Tools:
- `antifan_open_tab`
- `antifan_list_tabs`
- `antifan_switch_tab`
- `antifan_close_tab`
- `antifan_navigate`
- `antifan_reload`
- `antifan_get_dom`
- `antifan_screenshot`
- `antifan_toggle_inspect`
