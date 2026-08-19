# Antigravity Browser Desktop — Changelog

Tất cả các thay đổi, tính năng mới và bản vá lỗi quan trọng của Antigravity Browser Desktop.

---

## [v1.1.0] - 2026-08-16

### 🤖 Agent Engine (theo DSH patterns)
- **Transient Step Retry**: Lỗi mạng nhất thời khi gọi model (`fetch failed`, `ECONNRESET`, timeout, 429, 5xx) được retry 1 lần với backoff thay vì hủy toàn bộ tác vụ.
- **Tool Execution Timeout Guard**: Tool chạy quá 60 giây bị chặn và trả lỗi về cho model tự xử lý tiếp, không treo loop.
- **Tool Result Size Bound**: Kết quả tool được nén giới hạn kích thước (JSON luôn hợp lệ, đánh dấu `truncated`) để chống phình context trên phiên dài.
- **Stop/Abort đúng đường**: `abortStream` giờ abort theo prefix stream id — dừng được cả stream step, retry và final-summary của agent (trước đây bỏ qua vì stream đăng ký id suffix).
- **Retry Broadcast**: Renderer nhận sự kiện `agb:ai:retry`, reset bubble stream (giữ thought + step history) để không nhân đôi nội dung khi retry.
- **Chat Sidebar Status Header**: Dot trạng thái + nhãn trực tiếp (`Sẵn sàng` / `Đang suy nghĩ…` / `Tool: …` / `Hoàn tất` / `Lỗi`) với màu và pulse theo trạng thái agent.
- **Platform Context Injection**: Tự nhận diện theme repo (`.workspace-context.json` → marker `*.bwt` / `.haravan-cli_*` → `settings_schema.json` + `layout/`) và nhúng block quy ước Haravan / Sapo / Shopify vào system prompt — gồm cảnh báo settings_data.json, cấm hrv CLI, quirk Liquid từng platform; không phát hiện được thì prompt giữ nguyên.
- **Gemini 3.6 Flash qua 9Router (20128)**: Driver Antigravity Direct giờ gửi `Authorization: Bearer <key>` khi gọi model `ag/*` / `gemini-3*` qua local proxy — key lấy từ `config.apiKey` hoặc API key đã lưu (nút 🔑 trong modal auth). Model `ag/gemini-3.6-flash-high/medium/low` đã có sẵn trong danh sách chọn.
- **Chuẩn xác hoá xác thực 9Router**: Nghiên cứu source 9Router `0.5.45` xác nhận — proxy yêu cầu **API key dashboard dạng `sk-...`** (bảng `apiKeys`, `requireApiKey=1`), token OAuth chỉ dùng phía upstream (provider `antigravity`, cùng OAuth client `1071006060591-…` và y hệt scopes của app). Hướng đi chính được chốt theo yêu cầu user: **không dùng API 9Router** mà tái hiện cách làm của nó — gọi thẳng upstream Antigravity.
- **Gemini 3.7 Flash Tiered Direct Support**: Hỗ trợ trọn bộ `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low` (route sang `gemini-3.7-flash-tiered` + `thinkingLevel` tương ứng) trực tiếp qua Google Code Assist upstream.
- **Antigravity Code Assist direct (không qua 9Router)**: Model `ag/*` giờ gọi thẳng `https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse` bằng **token OAuth của chính app** (cùng OAuth client + scopes mà 9Router dùng — đã probe: same account có entitlement "Gemini Code Assist" standard-tier). Wire format khớp bundle 9Router: body `{model, requestType:'agent', userAgent:'antigravity', request:{contents, generationConfig:{thinkingConfig:{thinkingLevel}}}}`; `ag/gemini-3.6-flash-high|medium|low` → upstream `gemini-3.6-flash-tiered` + thinkingLevel tương ứng; parse SSE `response.candidates[].content.parts[].text`. Độ trễ stream ~1s (proxy cũ ~12.7s). Driver cũ với 9Router (gemini-3/sonnet/opus) giữ nguyên làm fallback.
- **Sửa bug token mã hoá vỡ**: `safeStorage.decryptString` thất bại (blob `v101…` tạo bằng key cũ) trước đây khiến app dùng **chính ciphertext làm Bearer token** → 401 mọi nơi. Giờ decrypt lỗi → trả `undefined`, và `getValidCredentials` chỉ chấp nhận token dạng `ya29.*`/`1//*` — blob không lọt; UI báo đăng nhập lại. Sau khi đăng nhập, `persistAuthState` mã hoá bằng key hiện tại nên lần sau giải mã được.
- **Bỏ mã hoá safeStorage khi lưu token**: blob DPAPI không đọc được giữa các build/instance khác nhau (entropy theo executable), gây vòng lặp "đã login nhưng vẫn bắt login lại". `persistAuthState` giờ ghi **plaintext với mode `0600`** trong `~/.gemini/`; chặn crash cứng của `decryptString` trên blob rác bằng guard prefix `v10`/`v11`, và **tự xoá file auth không giải mã được** khi khởi động để không còn file "mồi" gây vòng lặp.
- **Bỏ prefix `ag/`**: Model Code Assist hiển thị thuần tên (`gemini-3.6-flash-high/medium/low`, `gemini-3.5-flash-*`, `gemini-pro-agent`, `claude-sonnet-4-6`...) trong danh sách chọn + placeholder; driver vẫn nhận cả `ag/...` cũ (config đã lưu) lẫn tên không prefix và route thẳng lên Code Assist. Prefix `ag/` giờ chỉ còn trong nhánh proxy 9Router cho sonnet/opus.
- **CSP allowlist inline CJS shim**: `<meta http-equiv="Content-Security-Policy">` bổ sung hash `sha256-…` cho inline `<script>var exports = exports || {};</script>` — nếu không, CSP `script-src 'self'` chặn shim và `app.js` (bundle CJS) chết ngay với `ReferenceError: exports is not defined`, renderer không boot bridge. Hash-locked, không nới security.
- **E2E smoke chống treo**: `executeJavaScript` trong `chat-sidebar-smoke.cjs` được bọc timeout (`Promise.race` 8s) — renderer treo giờ fail rõ ràng thay vì đơ vô hạn.
- **Phát hiện phiên OAuth chết**: `getValidCredentials()` trả `null` khi token hết hạn và refresh thất bại thay vì trả token cũ — driver hiển thị lỗi rõ ràng "Phiên Google OAuth hết hạn hoặc chưa đăng nhập" thay vì nhầm lẫn thành "Missing/Invalid API key" hay "Model không tồn tại".
- **Chống 9Router nuốt callback đăng nhập**: redirect_uri phải khớp chính xác bản đăng ký OAuth (`localhost:20128/callback`) nên cổng không thể đổi — fix dựa trên việc Windows cho phép bind `127.0.0.1:20128` song song với listener wildcard của 9Router (`0.0.0.0:20128`), kết nối từ browser tới `localhost:20128` ưu tiên listener cụ thể nên authorization code luôn về app (đã probe thật trên máy đang chạy 9Router). Port bị chiếm hoàn toàn thì báo lỗi hướng dẫn đóng ứng dụng giữ cổng.

### 🧪 Kiểm thử
- Bộ test loop mới: `agent-engine.test.ts` — retry transient, fail-fast lỗi không transient, truncation JSON hợp lệ, timeout tool, lỗi tool phản hồi về model (5 test).
- `ai-service-abort.test.ts` — abort theo prefix stream id (step, retry, direct exact) (4 test).
- `e2e:chat-sidebar` `chat-sidebar-smoke.cjs` — smoke UI trên app thật, gồm kiểm tra delivery `agb:ai:retry` qua preload allowlist; chạy với `--mcp-server` để không vướng single-instance lock; runner `run-electron.cjs` tự dọn cây tiến trình trên Windows.

---

## [v1.0.0] - 2026-08-15 (Production Release)

### 🚀 Tính năng Nổi bật
- **Antigravity IDE Direct Session Picker**: Tích hợp danh sách Chat Session thật từ cơ sở dữ liệu `.gemini/antigravity-ide/conversations/*.db`, tự động trích xuất tiêu đề conversation và đồng bộ trực tiếp với menu chuột phải.
- **Ultra-Smooth GPU Lens Zoom**: Nâng cấp kính lúp phóng to với rendering phần cứng GPU (`requestAnimationFrame`), miễn nhiễm 100% với CSS trang web (`pointer-events: none !important`), hỗ trợ cuộn chuột chỉnh độ phóng đại mượt mà từ 1.5x đến 8.0x kèm tâm ngắm và huy hiệu zoom.
- **Global Web Shortcuts**: Hệ thống phím tắt hoạt động toàn diện ngay cả khi đang focus bên trong trang web (`Esc` hủy tác vụ, `F12` mở DevTools, `Ctrl+T`, `Ctrl+W`, `Ctrl+Tab`, `Ctrl+R`, `Ctrl+L`, `Ctrl++/-`).
- **Phân tách Môi trường Dev / Prod**: Hỗ trợ 2 chế độ vận hành độc lập (Development với hot-reload tức thì và Production đóng gói tối ưu).

### 🔒 Bảo mật & Ổn định
- **Cryptographic IPC Security**: Khóa phiên ngẫu nhiên `crypto.randomBytes(32)` với cơ chế hết hạn TTL 1 giờ.
- **Private Cookie Storage**: Lưu trữ an toàn session đăng nhập tại thư mục `userData` riêng tư của hệ điều hành.
- **Memory & Artifact Cleanup**: Tự động dọn dẹp snapshot và file markdown rác theo chu kỳ 24h.

---

## [v0.9.0] - 2026-08-14 (Dev Preview)

### ✨ Tính năng Ban đầu
- **Multi-Tab Chromium Architecture**: Quản lý nhiều tab độc lập bằng `WebContentsView` với thanh tab Chrome-like nén động.
- **Quick Add & Font Finder**: Bộ công cụ trích xuất CSS font chữ và gắn nhãn annotation trực tiếp trên DOM.
- **Docked Developer Tools**: Tích hợp Chromium DevTools gắn cố định ở cạnh dưới.
