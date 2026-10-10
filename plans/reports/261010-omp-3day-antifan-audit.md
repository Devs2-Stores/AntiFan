# Rà soát session OMP 3 ngày (07–10/10/2026) — AntiFan

Nguồn: `archive.sessions({project:'*'})` → 86 file JSONL có dùng AntiFan MCP; 5413 lời gọi `antifan-browser`, 376 lỗi (02–10/10). Cửa sổ 3 ngày (từ 07/10 00:00 +07): 334 lỗi, 253 tin nhắn người dùng.

## P1 — MCP không lên được khi cửa sổ Hub (`web`) đã đóng

- Triệu chứng: `MCP server not connected`; wrapper in `MCP_BRIDGE_OFFLINE … Please verify that AntiFan Browser Desktop is running` (`scripts/antifan-agent.cjs:712-714`) dù app vẫn chạy.
- Lỗi thật (probe `E:/Work/scratch/mcp-init-probe/init.cjs`, 10/10):
  - bỏ env terminal: `TAB_NOT_FOUND: no live agent tab is available for this session (tabId 'none provisioned')`, exit sau 1010 ms;
  - env terminal (boot project, `terminal-8`): cùng lỗi, 2573 ms;
  - `--tab=bd14117d…` trong terminal: refused — tab đo được thuộc `project-2b5d9f07…`, không phải boot project của terminal;
  - bỏ env terminal + `--tab`: `initialize` trả lời sau 1063 ms.
- Chuỗi nguyên nhân (suy ra từ code + lỗi quan sát được; chưa đọc trực tiếp `isDisposed` trong process đang chạy, chưa có repro sau khi sửa):
  1. `main.log` 14:25:37Z: `window-close.closed owner:"web" closed:7`, `siblings-live remaining:4`; sau đó không có sự kiện nào mở lại cửa sổ `web`. Lỗi MCP tiếp theo lúc 14:26.
  2. Đường mint không có `--tab` (`bridge-server.ts:2732-2737`): `mintHost = mintTarget?.host ?? this.tabHost`. Resolver rơi về `hubHost()` = `hostForOwnerKey('web') ?? bootstrapHost` (`index.ts:4700`); `this.tabHost` là `bootstrapHost` (`index.ts:4635-4638`). `bootstrapHost` là `const` gán một lần (`index.ts:4247`), bị `dispose()` khi cửa sổ đóng (`index.ts:4033-4034`); `handleShellClosed` chỉ xoá `bootstrapShell`.
  3. `createTab('about:blank')` chỉ trả `''` ở nhánh `isDisposed` (`native-tab-host.ts:8924`); mọi nhánh `''` khác (8942/8949/8955/9077) là preview `file://`/workspace hoặc URL bị chặn. `''` → `bridge-server.ts:2745` ném `TAB_NOT_FOUND 'none provisioned'`.
  4. Đã loại giả thuyết binary cũ: fix `unpinnedBootProject` là `d2dfc6a3` (07/10 23:35 +07), app (pid 24536) khởi động 10/10 13:54Z.
- Phạm vi bằng chứng: chỉ lần 10/10 14:26. `main.log` + `main.log.1` chỉ phủ từ ~09/10 20:12Z và chỉ có đúng 1 lần đóng Hub; 9 lỗi "not connected" ngày 07–09/10 nằm ngoài vùng log → chưa quy được nguyên nhân.
- Đề xuất: `hubHost()` bỏ qua host đã dispose (chọn host còn sống hoặc mở lại Hub), nếu không thì từ chối bằng một mã có kiểu riêng; wrapper phải in nguyên văn lý do từ chối của bridge thay cho câu "verify Desktop is running".

## P1 — `anti.browser.evaluate` làm mất thông điệp của DOMException

- Repro (10/10, tab `bd14117d…`):
  - `document.querySelectorAll("#shopify-section-* , main > *")` → `CAPABILITY_ERROR: {}`;
  - `throw new TypeError("plain-type-error")` → `CAPABILITY_ERROR: plain-type-error`.
- Trong 3 ngày: 9/43 lỗi `CAPABILITY_ERROR` của evaluate là `{}` rỗng (TrueBeef, S2 Spa); agent phải đoán lỗi.
- Nguyên nhân (đã xác nhận bằng probe Electron 43 `E:/Work/scratch/mcp-init-probe/domex.cjs`): wrapper trong trang của `evalJs` (`src/main/browser/tab-devtools-host.ts:3116-3118`) `throw err` nguyên trạng. `executeJavaScript` chuyển một DOMException bị reject qua ranh giới thành object rỗng:
  - `wrapperRethrow` (mô phỏng đúng wrapper) → reject `{}` (`isError:false`, không có `message`) → `relayErrorMessage` (`capability-transport.ts:37`) in `{}`;
  - cùng biểu thức nhưng `throw new Error(err.name + ': ' + err.message)` → reject `Error: SyntaxError: Failed to execute 'querySelectorAll' … is not a valid selector.`;
  - trong trang, lỗi là `DOMException` (`instanceof Error` = true, có `name`/`message`), nên chỉ kiểm `instanceof Error` là không đủ.
- Đề xuất: trong `catch` của wrapper, luôn ném lại `new Error((err.name ? err.name + ': ' : '') + err.message)` khi `err` không phải `Error` gốc của realm (vd. `err instanceof DOMException`); thêm test repro bằng selector không hợp lệ.

## P2 — `CAPTURE_FRAME_STARVATION` (nguyên nhân chưa rõ)

- 3 ngày: 55 lỗi kiểu compositor stall (`theme_qa_validate` 18, `anti_screenshot_viewport` 9 với mã `CAPTURE_FRAME_STARVATION`). Thuộc 11 session, 7 project; lần cuối 10/10 14:38Z trên Lux Wine (`bd14117d…`).
- `main.log`: `capture.frameGate` có `probe:false`, đã chạy đủ các bước `invalidate, reassert, updateLayout, reassert-recycle, invalidate-2`, cửa sổ `visible, maximized`. Sau đó `capture.raster engine:native-fallback outcome:empty`.
- Đo trực tiếp lúc rà soát: tab `visibilityState:visible`, `hasFocus:true`, rAF 10 ms → lỗi là tạm thời.
- Phân bố trong `main.log` (09/10 20:12Z → 10/10 14:38Z): `capture.raster` `surface:ok` 231 lần; `native-fallback` `empty` 4 + `timeout` 1, trong đó 4/5 trên cùng tab `bd14117d…` → nghiêng về trạng thái riêng của tab/cửa sổ, không phải lỗi compositor toàn cục.
- `outcome:empty` không phân biệt được hai trường hợp: `captureNativeViewportRaster` gọi `wc.capturePage().catch(() => null)` (`tab-devtools-host.ts:2242`) nên một lần capture bị reject cũng thành "empty" và mất lý do. Probe occlusion từng gặp `capturePage` reject `UnknownVizError` sau 7 ms.
- Giả thuyết OS occlusion chưa được xác nhận (probe `E:/Work/scratch/occlusion-probe`):
  - BrowserWindow mặc định bị che hoàn toàn → `hidden`, rAF TIMEOUT, nhưng `capturePage` và CDP `Page.captureScreenshot` vẫn thành công;
  - view có `backgroundThrottling:false` (cấu hình AntiFan đang dùng) vẫn chạy rAF 22–40 ms khi bị che.
- Trùng thời điểm: 14:25:32 có `project-open.detached` cho `project-2b5d9f07…` (project chứa tab này), 14:25:37 Hub đóng.
- Bước tiếp: ghi lý do reject của `capturePage` (thay cho `.catch(() => null)`), cùng `document.visibilityState`, `wc.getBackgroundThrottling()` và trạng thái detach của cửa sổ vào `capture.frameGate`/`capture.raster`, để lần lỗi sau đủ dữ liệu tìm nguyên nhân.

## P3 — Lỗi do schema/hợp đồng tool gây ra

| Mã | Số lần (3 ngày) | Lần cuối | Ghi chú |
|---|---|---|---|
| `anti.screenshot.full_page` `format:"jpeg"` bị từ chối | 8 | 09/10 | Agent cứ truyền jpeg; nên chấp nhận jpeg hoặc nói rõ "PNG only" ngay ở đầu description |
| `anti.theme.style_override` `operation:"remove"` | 7 | 09/10 | Description hiện tại đã nhận `remove`/`revert` là synonym của `clear` → coi như đã sửa |
| `VIEWPORT_NOT_APPLIED` (375 → đo được 981x2123) | 4 | 09/10 | Trùng với phát hiện mobile zoom-out trên trang bị overflow (E2E 10/10) |
| `REVISION_STALE` trên `anti.browser.tabs.list` | 7 | 09/10 | Một lệnh khám phá chỉ đọc lại bị từ chối vì revision |
| `IMAGE_IDENTITY_UNSTABLE` | 9 | 09/10 | Ảnh trong carousel đổi kích thước giữa các lần lấy mẫu |

## Đã giảm hoặc đã sửa

- `TARGET_MISMATCH`: 53 lần ngày 07/10, sau đó còn 4–5 lần/ngày, lần cuối 09/10.
- `CAPTURE_TIMEOUT`: 28 lần ngày 07/10, còn 1 lần ngày 10/10 (frame gate đã thay chỗ).
- Lỗi "lag khi xem tab Terminal đang sleep": có commit `ec17ac2e` (08/10 00:08, "perf(renderer): bound the slept-terminal transcript preview"). [INFERENCE: chưa kiểm tra lại trên app.]
