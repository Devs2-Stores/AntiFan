# OSR capture crash — root cause, fix, live pre/post proof

Ngày: 2026-09-16 · Nhánh: `integrate/audit-fixes`

## Triệu chứng

App (Electron) **biến mất** trong lúc làm việc: không cửa sổ báo lỗi, **không log JS nào**
(`main.log` chỉ ghi `crashReporter.enabled`), không có `render-process-gone` /
`child-process-gone` / `uncaughtException`. Dump trong `runtime/crashDumps/reports/`
(16:11:59, 16:19:47, 16:38:46) đều là access violation `0xC0000005` tại địa chỉ `0x0`.

## Nguyên nhân gốc

- Tab agent Dual-Plane là **OSR**: `security-policy.ts` đặt `prefs.offscreen = true`,
  `paintWhenInitiallyHidden = false` → tab **không có native window**.
- `tab-devtools-host.ts` gửi `Page.captureScreenshot { fromSurface: false }` ở hai chỗ:
  Tier 2 (CDP fallback, `fromSurface: isForeground`) và `captureVerificationScreenshot`
  (`fromSurface: mode !== 'viewport'`).
- `fromSurface:false` là đường **native-window snapshot** của Chromium →
  `WindowSnapshotReachedScreen` → `GrabNativeWindowSnapshot(GetNativeView() = null)` →
  deref NULL → **chết cả browser process**, không phải lỗi JS nên không có log.

## Sửa

- `fromSurface: true` ở mọi đường capture: Tier 2 fallback, `captureVerificationScreenshot`
  cho **mọi** mode kể cả `viewport`, và ca foreground.
- Xoá hẳn Tier 3 "Offscreen Native View Paint Fallback" (trùng Tier 2, chỉ khác đúng đường
  native gây chết). Đích không có compositor surface giờ trả lỗi capture có kiểu
  (`CAPTURE_*`) thay vì giết process.
- Guard vòng đời: `onNavigate` / `onMessage` (`CSS.styleSheetAdded`) thoát sớm khi
  WebContents đã huỷ.
- Giữ dump có biên: `diagnostics/crash-dump-retention.ts` giữ 3 dump mới nhất theo mtime.

## Bằng chứng live (pre/post) — probe `.tmp-osr-capture-probe.cjs` (đã xoá sau khi đo)

Probe chạy Electron thật qua `scripts/run-electron.cjs`: tạo 1 tab **agent nền** (OSR) + 1 tab
user đang active, rồi gọi capture trên cả hai. Đo hai lần: cây **pristine** (stash toàn bộ thay
đổi) và cây **đã sửa**.

| Lệnh gọi | Pristine | Đã sửa |
|---|---|---|
| `user captureScreenshot` (tab active) | ok 9553 B | ok 9553 B |
| `user captureVerificationScreenshot` (viewport) | CaptureError timeout 60s, process còn sống | CaptureError timeout 60s, process còn sống |
| `agent captureScreenshot` (tab nền OSR) | ok 10215 B | ok 14773 B |
| `agent captureVerificationScreenshot` (viewport) | **process chết ngay, exit 5, không có dòng lỗi, không có `PROBE_COMPLETE`** | CaptureError timeout, process còn sống |
| `agent captureVerificationScreenshot` (fullPage) | (không tới được) | CaptureError (`draining`), process còn sống |
| `PROBE_COMPLETE` | **không in** | **in**, exit 0 |

Kết luận: đúng lệnh gọi `Page.captureScreenshot { fromSurface:false }` trên tab OSR là chỗ
giết process; sau khi sửa, cùng chuỗi lệnh chạy hết và process sống.

## Hồi quy (test lane)

- `npm run test:main` → **1244 test, 1242 pass, 0 fail**, 2 skip. Gồm
  `test/main/tab-devtools-host.test.ts` (assert `fromSurface:true` cho desktop viewport và
  background attached tab) và ca 6 `test/main/playwright-parity-kernel.test.ts` (CDP fallback
  rasterize từ compositor surface, không bao giờ xin native-window snapshot).
- `npm run test:e2e` → 8 test, 7 pass, 1 fail (`mcp-industrial-overhaul`) — fail có sẵn, tái hiện
  trên cây pristine (xem mục phát hiện #2 bên dưới).
- `npm run test:unit` → 947 test, 939 pass, **2 fail đã có từ trước**: `bridge-receipt-coverage`
  và `core-health-service` — cả hai tái hiện trên cây pristine (đã chạy riêng từng ca).
- Test lỗi thời đã gỡ (API bị xoá/đổi tên trên nhánh này): `workflow-schema`,
  `frame-queue`, `semantic-ref-occlusion`, `touch-lifecycle`.

## Ảnh hưởng đã biết của thay đổi cờ

`fromSurface:true` đổi **đường rasterize** của hai nhóm capture: Tier 2 trên tab nền/OSR (trước
đây `isForeground` → `false`) và verification capture ở mode `viewport` (trước đây
`mode !== 'viewport'` → `false`). Vì vậy ảnh viewport nay lấy từ compositor surface thay vì
renderer view, và **byte ảnh đổi** dù nội dung trang không đổi: artifact
`plans/260905-0012-…/reports/live-theme-proof.json` do `test/e2e/theme-golden-live.test.ts`
sinh lại trong lần chạy lane e2e cho `pngBytes` 13304 → 13270 và checksum mới, **verdict vẫn
`PASSED`** (phép kiểm của nó không so byte cứng).

Đánh đổi có chủ ý: process chết là hỏng không phục hồi được, còn lệch byte thì re-baseline được.
Nếu sau này có workflow so byte ảnh với baseline cứng cho mode `viewport`, baseline đó phải được
sinh lại. Phương án hẹp hơn (`fromSurface: isForeground && mode !== 'viewport'`) sẽ giữ byte cho
tab foreground nhưng đưa lại đúng đường native-window snapshot, nên đã bị loại.

## Phát hiện khác trong lúc kiểm chứng (chưa sửa — không thuộc phạm vi vá crash)

1. `scripts/smoke-dual-plane-two-attachments.cjs` **fail trên cả cây pristine lẫn cây đã sửa**:
   ngay sau khi tạo tab, capability-transport báo
   `bound tab '<id>' is gone and no failover target exists` cho `antifan_get_dom`,
   `antifan_agent_type`, `antifan_set_viewport`, rồi assert `B viewport change succeeded` fail.
   Đây là lỗi vòng đời tab/attachment riêng, cần điều tra độc lập.
2. `npm run test:e2e` → 7/8 pass; ca `mcp-industrial-overhaul` fail với **cùng chữ ký**
   `bound tab 'b4cae40c-…' is gone and no failover target exists` lặp lại cho mọi lệnh
   (`anti.screenshot.viewport`, `browser.agent-click`, `browser.agent-type`, `browser.dom`) —
   tức attachment mất tab đã bind nên 20 lệnh benchmark chạy vào target chết, kéo p95 lên
   1626 ms và fail assert "p95 under 120ms". **Tái hiện trên cây pristine**: 46 lần
   `is gone and no failover target exists`, cùng assert p95 fail (867 ms). Lỗi có sẵn, không
   do bản vá crash; nhưng đây là bề mặt đáng ưu tiên vì nó hạ cấp mọi lệnh MCP qua attachment.
3. `captureVerificationScreenshot` khi cửa sổ Electron không hiển thị — **đính chính sau đo lại
   (16-09, probe `.tmp-af-hub-audit/cap-parity.cjs`, control-plane thật gắn vào host)**: biến quyết định là
   *cửa sổ ẩn*, không phải `disable-gpu`. Trên trang hợp lệ 14.604 px, cửa sổ `hide()`:
   `verify-fullpage` treo đúng 60.286 ms (gpu-on) / 60.297 ms (gpu-off) → `CAPTURE_TIMEOUT`;
   `verify-viewport` vẫn OK ~330-351 ms; port path từ chối tức thì `NO_RENDER_SURFACE`; sau
   `show()` mọi capture hồi phục ~320-364 ms. `disable-gpu` bị minh oan: software raster chụp
   full-page 14.604 px trong 1,39-4,14 s, ngang GPU (1,36-5,06 s). Ghi nhận ban đầu
   (`show:false` + `disable-gpu`, viewport timeout) gộp hai biến; phần "viewport timeout" chỉ
   đúng với cửa sổ **chưa từng hiển thị** (`show:false`), còn cửa sổ đã hiện rồi `hide()` chỉ
   làm treo full-page. Đây là defect thật còn mở: verify path thiếu kiểm tra render-surface mà
   port path đã có — đang vá riêng.
