# AntiFan Browser Desktop (Lite Extension Bridge)

Trình duyệt Chromium Desktop siêu nhẹ, đóng vai trò là **Companion Engine & Extension Bridge** phục vụ Antigravity / VS Code Extension và AI Agent.

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
```

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
