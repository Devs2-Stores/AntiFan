# Audit session OMP 05–06/10/2026 — phạm vi AntiFan

**Nguồn:** 28 session JSONL (~280MB) trong `~/.omp/agent/sessions/` sửa đổi 05–06/10. Phương pháp: digest lỗi từng session + 20 analyzer agent chạy song song + đối chiếu `git log` và source.

**Đã fix trong repo — không báo lại:**
- Workspace capsule leak (QA cockpit resolve nhầm `apps/Pancake` thay vì project của tab) → `15e53904 feat(workspace)`
- GPU Lens / Font Finder overlay rò rỉ qua tab + reload → `98622349` + `a5f07097`

---

## A. Nặng — cần fix, đã xác nhận

### A1. Terminal gõ phím ra escape sequence `;0;111;1;0;1_[` — chưa có fix
- Session `01a1119f`: user gõ trong tab terminal cũ thì shell echo raw win32-input-mode sequence (`Uc=111` là 'o', `Kd=1` keydown…). Tab terminal mới mở sạch → lỗi state theo session, nhiều khả năng process TUI/agent thoát mà không restore input mode.
- `grep win32-input|win32Input` trong `src/` → 0 kết quả. Đã chẩn đoán, chưa sửa.
- Hướng: `src/main/browser/terminal-manager.ts` + `terminal-output-router.ts` + `src/shared/terminal-write-dispatcher.ts` — reset input mode khi child process exit, hoặc gate passthrough theo trạng thái mode đang active.

### A2. Ephemeral agent tab `TARGET_NOT_ACTIVATABLE` → deadlock
- Session `01a10b6f` (Phukienmaymoc): `Tab did not become the active tab: it renders offscreen and is never shown in the window. No other tab in this session can be activated.` Agent BLOCKED tới khi user tự dán tabId khác.
- `7239394` đã thêm flag `userFacing` vào `openTab` — cần nối flag này vào luồng provision agent tab (`bridge-server.ts` createTab offscreen/ephemeral).

### A3. MCP bridge disconnect giữa chừng → QA_UNAVAILABLE, delivery BLOCKED
- `01a10cd6` (S2 Spa): `MCP server not connected: antifan-browser` trong lúc `theme.qa_validate` → final-showcase giao BLOCKED.
- `01a1028b`: `connect ECONNREFUSED 127.0.0.1:20130` sau autoheal.
- `01a110e7`: `MCP_BRIDGE_OFFLINE … TAB_NOT_FOUND: no live agent tab` khi session không chạy qua launcher chính thức.
- `01a10b07` (Mnbakery): `AUTHENTICATION_DENIED: Attachment … has been revoked` giữa phiên.
- Hướng: phân biệt "app chết" vs "session không được provision" trong error surface; degrade có tài liệu thay vì BLOCKED khi QA không bắt buộc.

---

## B. Đau đầu tần suất cao — bridge/CDP/capture layer

### B1. `CAPTURE_FRAME_STARVATION` — ~70 lần trên 6 session
- `src/main/browser/tab-devtools-host.ts:2242` — preflight refuse khi compositor window không sinh frame (renderer vẫn trả lời RAF). Check là đúng ý đồ; vấn đề là remedy message bắt user focus/move window — thù địch với agent chạy nền.
- Đã có fallback native raster ở `:2691` cho mode viewport non-offscreen — nhưng chỉ sau khi throw. Cân nhắc: auto-kick compositor mạnh hơn, hoặc mark retryable với wait thay vì terminal error.

### B2. `TARGET_MISMATCH`/`TARGET_STALE`/`TARGET_REQUIRED` — ~40 lần
- Levents (24), Giaohangnang (11), S2 Spa, Mnbakery, Bagamuioto.
- Pattern lặp: agent truyền raw tabId trong khi split-pane cần bound tabId + `paneId:"mobile"`; hoặc tabId cũ sau khi user đóng/reload tab.
- Hướng: auto-resolve tabId → pane-sibling của bound tab khi cùng window; hoặc error payload kèm topology pane hiện tại để agent tự sửa.

### B3. `SETTLE_INCOMPLETE` deadlock trên trang có animation vô hạn
- Giaohangnang (4 lần): `gates not all settled (dom=false)` — carousel/animation DOM loop giữ gate mở mãi.
- Hướng: cap thời gian chờ mỗi gate + verdict `unstable-dom` thay vì pending vô hạn; hoặc DOM-mutation instability chỉ là warning tier khi các gate khác pass.

### B4. `NAVIGATION_TIMEOUT` 8000ms quá ngắn cho preview Haravan live
- Mnbakery (3), Phukienmaymoc (2), Giaohangnang. Theme JS nặng vượt 8s.
- Hướng: nâng mặc định 15–20s hoặc expose timeout param.

### B5. `EVALUATION timeout 15000ms (tab visibility: hidden)`
- Levents: evaluate timeout khi tab bị ẩn — agent phải nhờ user foreground AntiFan Desktop.
- Hướng: cho phép evaluate DOM-only trên tab hidden (không phụ thuộc raster), hoặc auto-foreground tạm.

### B6. `URL_HOST_MISMATCH` — route gate reject URL thiếu scheme
- Levents: `Malformed expected URL 'levents-global.myharavan.com/collections/all'` — normalize thêm `https://` trước khi so.

### B7. `FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY` >16384px
- Levents: region `1920x43600` vượt cap CDP. Hướng: tile capture + stitch, hoặc trả segment offsets rõ ràng.

### B8. `CAPTURE_NOT_READY` — layout drift 879px vượt tolerance 6px
- S2 Spa: pre-capture quiescence `layoutStable` fail do docHeight nhảy 4374→5253 (lazy mount). Đã có `anti.reference.capture` materialize-first — xem settle gate có cần retry sau mount settle không.

---

## C. Tooling/repo AntiFan — friction nhỏ

- **`theme-qa-gate` hook test non-hermetic** với `E:\Work\.antifan-data\config\bridge-dev.json` — PID chết → `HEALTH_PID_DEAD` inject vào mọi hook output → ~26 test fail dây chuyển (`01a107e1`). Fix: fixture record trong test hoặc skip khi live record dead.
- **`npm install` EBUSY** trên `node_modules/electron/dist/debug.log` khi app đang chạy — có workaround (kill app tree trước), cân nhắc staging install hoặc doc vào CONTRIBUTING.
- **`git worktree remove` fail** khi có junction `node_modules` trong worktree — doc: `rmdir` junction trước.
- **MCP tool-name mismatch**: agent gọi `xd://mcp__antifan_browser_anti_theme_qa_validate` và `anti_browser_promote_baseline` → `No such tool` (tên thật khác). Nguyên nhân là agent hallucinate — nhưng đáng thêm alias hoặc fuzzy-suggest trong error message.
- **`anti_browser_evaluate` JSON parse lỗi lặp** (~20 lần tổng các session): agent truyền payload chưa escape → `JSON Parse error: Unterminated string`. Error message đã hướng dẫn `Write ? for docs` — có thể thêm ví dụ cụ thể vào schema description.
- **`anti_theme_style_override` validation** (6 lần): agent thiếu `operation`+`id` bắt buộc — schema description cần ví dụ minimal call.
- **`PENDING_CLEANUP` execution timeout 30s** trên `anti.browser.evaluate` (Phukienmaymoc) — evaluate nặng vượt response budget.
- **`haravan_preflight.py` path mất backslash** (`01a10cd6`): `C:\\\\UsersAdmin.claudeskills…` — Windows path không quote khi ghép vào command string.
- **`theme compiler test ENOENT icon.png`** (`01a10b76`): `packages/site-clone/assets/icon.png` thiếu.

---

## D. Hành vi agent trên AntiFan surface — cần rule, không phải bug code

| Vi phạm | Session | Hệ quả |
|---|---|---|
| `PUT 742.=746:` syntax leak vào `mn-product.css.liquid` | `01a10b07` | CSS hỏng trên storefront |
| Paste preview bị truncate `…` vào code | `01a10cf3` | Logout link + tag vỡ |
| Xóa snippet chưa có quyết định user | `01a11083` | Phải restore |
| `npm install --no-save` trong tests/ không xin phép | `01a10cf3` | Vượt mutation scope |
| Xóa asset fallback → mất toàn bộ ảnh storefront | `01a10cf3` | Emergency restore từ backup |
| Batch-edit `<img>` mất thẻ mở → attribute text lộ trên 10 template | `01a10b28` | User phải report |
| `@DESIGN` model alias không resolve → designer subagent preflight fail | `01a1028b`, `01a10cf5` | Fallback thủ công |
| `edit` anchor reject "never displayed" | 7 session | ~100 lượt retry lãng phí |
| `wait` skipped do queued completion (không nói job nào) | 8 session | ~80 lượt |

---

## Ưu tiên đề xuất

| Hạng | Việc | Effort |
|---|---|---|
| 1 | A1 terminal typing corruption — reset input mode on process exit | med |
| 2 | B1 frame starvation — auto-recovery thay vì kêu user focus window | med |
| 3 | B2 TARGET_MISMATCH — auto-resolve pane siblings | low-med |
| 4 | A2 agent tab not activatable — provision userFacing surface | low |
| 5 | B3 SETTLE_INCOMPLETE cap + B4 nav timeout bump | low |
| 6 | A3 bridge disconnect → degrade path có tài liệu | med |
| 7 | C: test non-hermetic bridge-dev.json; MCP alias/suggest | low |
