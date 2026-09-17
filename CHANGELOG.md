# AntiFan Browser Desktop — Changelog

Tất cả các thay đổi, tính năng mới và bản vá lỗi quan trọng của AntiFan Browser Desktop.

---

## [v1.3.6] - Unreleased

### Sửa lỗi — App biến mất khi split mode: gọi native emulation trên view không có platform widget
- **Nguyên nhân**: `enableDeviceEmulation`/`disableDeviceEmulation` là API native của `WebContentsView` và cần **platform widget** của chính view đó. Code cũ gọi thẳng, không hỏi view có đang nằm trong `window.contentView.children` hay không. View chưa attach (hoặc đã bị gỡ) ⇒ không có render widget host view ⇒ native đọc NULL. Sổ issue ghi đúng dạng đó: 3 record P0 `NATIVE_CRASH` từ `runtime.process`, tất cả `STATUS_ACCESS_VIOLATION` (`0xC0000005`), `faultingAccess: read`, `faultingAddress: 0x0`, `processType: browser` — `ISS-1789564111316-tmg4y` (16-09 13:08), `ISS-1789579340686-mkk3c` (16-09 17:22), `ISS-1789612090295-mp0wd` (17-09 02:28), dump `de686712-…` / `c2bbb433-…`. Chết ở **browser process** nên cả cửa sổ biến mất, không có log JS nào, và `try/catch` không cứu được fault native. Đường sinh lỗi: tab split mode → `applyTabDeviceEmulation` → nhánh mobile emulate pane không có surface.
- **Sửa**: `native-tab-host.ts` từ chối **trước** khi gọi native — `safeEnableDeviceEmulation`/`safeDisableDeviceEmulation` nhận thêm `view` và thoát sớm khi `view && !isTabViewAttached(view)` (`isTabViewAttached` = view có trong `window.contentView.children`), mọi call site truyền view của chính nó. Nửa `disable` trả về **trước** khi sửa sổ sách, nên `emulatedWebContents` vẫn trung thực (emulation vẫn đang bật) và lần gọi sau — khi view đã attach — sẽ retry. View đã attach giữ nguyên hành vi cũ: không pane nào đang hiển thị bị tắt emulation.
- **Bằng chứng**: đối chứng trước/sau trên cùng một host (script throwaway, đã xoá) — *detached enable*: sau fix `[]` / `emulated=false`, trước fix `[enable:desktop]` / `emulated=true`; *split tab, mobile detached*: sau fix `[enable:desktop]`, trước fix `[enable:desktop, enable:mobile]` (đúng lời gọi gây fault). Ca thứ tư là **contrast pair** trong một test: attach đủ 2 pane thì `enable:mobile` **có** xảy ra, nên khẳng định phủ định ở nhánh detached không rỗng. `test/main/native-tab-host-agent-lifecycle.test.ts` 13/13 (4 ca mới), 4 suite split 68/68, `npm run test:main` 1269/1272 — fail duy nhất `does NOT block quiescence on never-ending third-party analytics beacons` là assertion wall-clock, file đó không import `NativeTabHost` và pass khi chạy riêng; `tsc -p .` sạch.
- **Harness nói thật thay vì nới assertion**: `test/main/split-review-tabhost.test.ts` trước đây dựng `contentView` bằng hai hàm rỗng, **không có** mảng `children`, nên host không thể phân biệt view đã attach với view mồ côi — 2 ca cũ fail vì đúng lý do đó. Harness nay có child list thật và attach pane của tab active; không assertion nào bị nới.

### Sửa lỗi — Crash loop bị đọc thành một cái chết (register gộp row theo `errorMessage`)
- **Nguyên nhân**: `IssueRegister.record()` dedupe theo `toolName + errorMessage + status`, còn intake ghi `errorMessage = summary.headline` — mà headline chỉ gồm exception + offset + địa chỉ fault. Nhiều dump cùng signature (đúng dạng crash loop) ⇒ cùng headline ⇒ gộp thành **một** row: `affected` dồn cả danh sách dump và `timestamp` bị ghi đè thành lần cuối. Trong sổ thật, `ISS-1789564111316-tmg4y` và `ISS-1789579340686-mkk3c` cùng một dump nhưng **không** gộp, chỉ vì headline của chúng tình cờ khác nhau (một cái kèm full path `E:\Work\...\electron.exe+0x…`, một cái chỉ `electron.exe+0x…`) — may mắn, không phải thiết kế.
- **Sửa**: `crash-report-intake.ts` ghi `errorMessage` kèm tên dump (`${headline} (dump ${filename})`) — theo đúng convention sẵn có của chính file (`CRASH_DUMP_UNREADABLE` cũng nêu tên dump trong message). Mỗi cái chết còn một row, `affected` vẫn giữ bằng chứng, và việc chống ghi trùng cùng-dump vẫn do `accountedFor` lo nên không sinh row thừa.
- **Bằng chứng**: `test/unit/crash-report-intake.test.ts` 8/8 — ca "caps reports per launch and discards the rest so a crash loop cannot flood the register" trước đó fail `1 == 2`, nay xanh **mà không sửa một assertion nào**. Probe trước fix: register chỉ có 1 row `affected: [crash-a.dmp, capped-2.dmp, capped-1.dmp]`; sau fix: intake báo 2 và register giữ 2 row. Đây cũng là điều kiện để `runtime.crash` đếm đúng số cái chết.

### Cập nhật — Core Health UI nói thẳng về native crash (trước đây là một P0 lẫn trong 90 issue)
- **Vấn đề**: crash có vào sổ, nhưng Core Health chỉ gộp thành một dòng `DEGRADED / OPEN_HIGH_SEVERITY_ISSUES` với detail `19 P0 + 67 P1 open issues` — không phân biệt được "browser process chết" với một finding QA, cũng không thấy dump / pid / lúc nào.
- **Sửa**: `diagnostics/core-health.ts` thêm check hạng nhất `runtime.crash` (luôn có mặt, kể cả khi sạch) và `snapshot.crashes` (`total`, `latestAt`, `latestId`, `records`), đọc từ chính sổ issue (`errorCode === 'NATIVE_CRASH'`, đang OPEN, mới nhất trước); `notes` của crash reporter được parse phòng thủ nên record vẫn báo id/time/reasonCode khi metadata hỏng. UI (`renderer/toolbar.ts`, `renderer/toolbar.css`): badge tab Core Health hiện `CRASH ×N` (đỏ, giữ nguyên khi tab đang active, tooltip kèm thời điểm + reasonCode + dump) thay cho status; pane chi tiết của `runtime.crash` mở đầu bằng records (process, dump, pid) thay vì blob JSON chung. Check mới **không** tự làm xấu trạng thái — phiên sạch vẫn `HEALTHY / ALL_GATES_PASSED`.
- **Bằng chứng**: probe trên sổ issue thật → check `runtime.crash` = `DEGRADED / BROWSER_PROCESS_CRASHED`, `affected` = 3 id crash, detail `3 browser-process crash(es) recorded; latest 2026-09-17T02:28:10.295Z in the browser process · c2bbb433-925f-403a-adf2-9a1ae635509e.dmp`; `crashes.records` có đủ `processType: browser`, `pid: 32284`, dump. `test/unit/core-health-service.test.ts` 17/17 (3 ca mới: crash kèm evidence, notes hỏng, phiên sạch vẫn HEALTHY); `tsc -p .` sạch.
- **Chưa đóng**: 3 record P0 trong sổ vẫn để `OPEN` — crash native chỉ xác nhận được bằng một phiên chạy thật, nên phải khởi động lại app rồi thấy `runtime.crash` chuyển `HEALTHY / NO_CRASH_RECORDED` mới là bằng chứng fix ăn.

### Sửa lỗi — Dải tab của Hub nghiền nát nhãn (báo trực tiếp từ app đang chạy)
- **Nguyên nhân**: `.hub-nav-strip` là flex row 7 tab, còn `.hub-nav-tab` không có `flex-shrink: 0` lẫn `nowrap` — nên khi nội dung vượt bề rộng thì flexbox **co từng tab cho vừa** (bề rộng tab = 1009-1180px, tổng bề rộng tự nhiên của 7 tab là 1629px), nhãn tiếng Việt rơi xuống 2-3 dòng và badge bị đẩy sang dòng riêng. Badge `CRASH ×3` / `DEGRADED` dài hơn các badge số cũ nên càng siết thêm.
- **Sửa**: `.hub-nav-tab`, `.hub-tab-icon` và `.hub-tab-badge` giữ nguyên bề rộng (`flex-shrink: 0`) và không ngắt dòng (`white-space: nowrap`); `.hub-nav-strip` cuộn ngang (thanh cuộn mảnh) nên nhãn luôn nguyên vẹn ở mọi bề rộng, kể cả khi badge dài thêm (`CRASH ×12`).
- **Bằng chứng** (đo trong chính Electron 43, chạy đúng tệp HTML/CSS của Hub, cửa sổ 1317×819 như ảnh báo lỗi): CSS ở `HEAD` → 7 tab bị co còn tổng 1098px, **chiều cao tab 86px** (nhãn 2 dòng), strip không cuộn; sau fix → tab giữ đủ bề rộng tự nhiên (1629px), **chiều cao 41px** đồng nhất (1 dòng), strip cuộn ngang. Ở cửa sổ 1000px: `HEAD` 102px (3 dòng) / sau fix 41px.

### Sửa lỗi — App biến mất khi chụp tab agent offscreen (`Page.captureScreenshot fromSurface:false`)
- **Nguyên nhân**: tab agent Dual-Plane chạy OSR (`prefs.offscreen = true`, `paintWhenInitiallyHidden = false`) nên **không có native window**; `fromSurface:false` là đường native-window snapshot của Chromium → `WindowSnapshotReachedScreen` → `GrabNativeWindowSnapshot(GetNativeView() = null)` → **deref NULL, chết cả browser process** (app biến mất, không có log JS nào). Dump trong `runtime/crashDumps/reports/` là `0xC0000005` tại địa chỉ `0x0`.
- **Sửa**: `tab-devtools-host.ts` không bao giờ gửi `fromSurface:false` nữa — Tier 2 (CDP fallback) và `captureVerificationScreenshot` (mọi mode, kể cả `viewport`) đều dùng `fromSurface:true`; **xoá hẳn Tier 3 "Offscreen Native View Paint Fallback"** (trùng Tier 2, chỉ khác đúng đường native gây chết). Đích không có compositor surface giờ trả về lỗi capture có kiểu (`CAPTURE_*`) thay vì giết process.
- **Guard vòng đời**: `onNavigate` và `onMessage` (`CSS.styleSheetAdded`) của CDP thoát sớm khi WebContents đã bị huỷ, không đọc state của target đã chết.
- **Giữ dump có biên**: `diagnostics/crash-dump-retention.ts` giữ 3 dump mới nhất theo mtime (đệ quy trong `reports/`, không đụng tệp không phải `.dmp`, không ném lỗi), chạy sau `crashReporter.start` và sau intake (prune trước intake sẽ xoá mất dump chưa được ghi sổ); 4 ca trong `test/main/crash-dump-retention.test.ts`.
- **Bằng chứng**: `npm run test:main` → 1242/1244 pass, 0 fail (2 skip), gồm `tab-devtools-host.test.ts` (assert `fromSurface:true` cho desktop viewport và background attached tab) và ca 6 `playwright-parity-kernel.test.ts` (CDP fallback rasterize từ compositor surface, không bao giờ xin native-window snapshot). `npm run test:unit` lúc đó → 939/947; 2 fail còn lại (`bridge-receipt-coverage`, `core-health-service`) đã được vá trong cùng release — xem mục "Sửa test — CLI coverage + core-health hermetic" bên dưới; suite hiện 958/963 pass, 0 fail.
- **Gỡ test lỗi thời**: `workflow-schema` / `frame-queue` / `semantic-ref-occlusion` / `touch-lifecycle` — API mà chúng kiểm đã bị xoá hoặc đổi tên trên nhánh này (`LegacyWorkflow*Schema`, `normalizeStepParams`, hằng coalescing của bridge, script executor viết lại), nên giữ lại chỉ là ghim chữ trong script sinh ra.

### Sửa lỗi — Full-page capture treo 60s khi cửa sổ ẩn/minimized (NO_RENDER_SURFACE)
- **Nguyên nhân**: `captureVerificationScreenshot` mode `fullPage`/`clip` gọi `Page.captureScreenshot` với `captureBeyondViewport:true`; cửa sổ `hide()`/minimized không sinh compositor frame nên lệnh không bao giờ settle → treo đúng deadline 60s (`CAPTURE_TIMEOUT`). `document.hidden` **không** quan sát được `win.hide()` trong app này (renderer vẫn báo visible), nên gate settle không chặn được. Port path đã có `NO_RENDER_SURFACE` từ trước; verify path thiếu kiểm tra tương đương.
- **Sửa**: `tab-devtools-host.ts` thêm refusal trong `captureAction` (sau attach + zero-geometry check): `mode !== 'viewport'` && target không offscreen && cửa sổ không presented → `CaptureError('NO_RENDER_SURFACE', cause 'window-not-presented' | classifyRenderSurfaceCause(surface))`. Seam mới `ctx.isWindowRenderable` (`native-tab-host.ts`: `!isDestroyed() && isVisible() && !isMinimized()`). Viewport-hidden vẫn chụp được (không cần beyond-viewport surface); offscreen target giữ path riêng; `fromSurface` giữ `true` mọi mode — không chạm lại đường native-window-snapshot gây crash 0xC0000005.
- **Bằng chứng** (`.tmp-af-hub-audit/cap-parity.cjs`, control-plane thật gắn vào host, cả hai GPU mode): `hidden/verify-fullpage` `NO_RENDER_SURFACE` trong **5-6 ms** (trước: 60.286/60.297 ms `CAPTURE_TIMEOUT`); `hidden/verify-viewport` OK ~316-356 ms; `hidden/port-fullpage` `NO_RENDER_SURFACE` 4-7 ms; `recovered/verify-viewport` OK ~333-358 ms sau `show()`.

### Đính chính phép đo — MCP/port surface hoạt động đúng; `disable-gpu` không phải nguyên nhân treo
- Probe `.tmp-cap-deep*` trước đây đo port/MCP bằng target tự mint (`browserEpoch: 1`, lease tự phát) → `isCurrentTarget` (`native-tab-host.ts:7609`) luôn false vì host không có control plane → **mọi** lệnh port/MCP trả `TARGET_STALE` trong ~1 ms. Đó là artifact của harness, không phải defect sản phẩm. Khi gắn `ControlPlaneRuntime` thật (như `index.ts:371`) và mint target qua `getAutomationTarget()`: `port-screenshot` 385-418 ms, `port-fullpage` ~1,0-1,2 s, `mcp-viewport` ~0,34-0,36 s, `mcp-full_page` 1,35-2,25 s trên trang 14.604 px — không lệnh nào gần bound 25/30 s.
- `disable-gpu` bị minh oan cho ca treo capture: software raster chụp full-page 14.604 px trong 1,39-4,14 s, ngang GPU-on (1,36-5,06 s); payload software còn nhỏ hơn (185.431 B vs 200.349 B). Biến quyết định là **cửa sổ ẩn**, đã vá ở mục trên.
- Trang vượt trần 16.384 px (18.900 px thử nghiệm) bị từ chối có kiểu `FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY` trong 4-11 ms trên cả verify lẫn port — không treo, không dark window.
- Drain state sau timeout có biên: `sendCdpCommand` (`tab-devtools-host.ts:652-660`) force-detach + xoá queue khi drain > 5.000 ms; không thể poison target vĩnh viễn.

### Sửa test — CLI coverage + core-health hermetic
- `scripts/antifan-core.cjs`: thêm `case 'replay'` → `core.replayRegression` và `case 'observe'` → `core.recordObservation` (tên bị pin bởi `RECEIPT_REQUIRED_CLI_COMMANDS` trong `.omp/hooks/pre/antifan-core-bridge.ts`). `bridge-receipt-coverage.test.mjs` xanh — hai dispatch mutating của commit `efa14a6` giờ có CLI subcommand.
- `test/unit/core-health-service.test.ts`: hai ca trước đây phụ thuộc môi trường (dist `.super-core` tồn tại sẵn trên máy dev → test "UNAVAILABLE" fail; temp tsconfig thiếu `types`/`typeRoots` → test real-CLI skip). Nay test 1 spawn **bản copy** của `antifan-core.cjs` trong temp dir (require `../packages/super-core/dist` miss deterministically → exit 2 → UNAVAILABLE thật), test 2 thêm `types:['node']` + `typeRoots` trỏ repo `node_modules/@types` để temp build compile được. 14/14 pass, 0 skip.

### Sửa lỗi — Hub không nói được vì sao app biến mất (native crash không có record)
- **Nguyên nhân**: một fault native không chạy handler JS nào, nên dump trong `runtime/crashDumps/` là **nhân chứng duy nhất** — nhưng không có gì đọc nó. `index.ts` chỉ bật crash reporter rồi để dump nằm im; sổ issue (`issues/issue-register.jsonl`) không có record nào về cái chết. Ca thật 16:38 ngày 16-09: `0xC0000005` (`STATUS_ACCESS_VIOLATION`), pid 30392, **browser process**, `electron.exe+0x684D7A8`, đọc địa chỉ `0x0`, 58 thread, có `pty.node` nạp sẵn — và Hub hoàn toàn im lặng.
- **Sửa**: `diagnostics/crash-dump-forensics.ts` đọc minidump bằng các `read()` có biên trên descriptor (không nạp bản sao 68 MB thứ hai): header + directory, exception record **64-bit** (`+8` code, `+24` address, `+32` số tham số, `+40` tham số — bản 32-bit làm address bị cắt và biến fault trong image thành fault "ngoài mọi image"), module list, dictionary annotation đọc **theo descriptor** trong CrashpadInfo, và crash-key pool của Chromium (`pid`/`ptype`) nằm trong khoảng trống không stream nào mô tả. `diagnostics/crash-report-intake.ts` mỗi lần khởi động đọc các dump **chưa có trên sổ**: ghi `crashReport.detected` vào lifecycle journal và issue P0 `NATIVE_CRASH` cho mỗi dump mới (issueClass `runtime`, gộp nhóm Root Causes của Hub), dedupe theo tên dump trong `affected`, tối đa 5 issue/lần khởi động (phần dư ghi `crashReport.deferred` để vòng crash không nhấn chìm sổ), dump không đọc được → P1 `CRASH_DUMP_UNREADABLE` (có dump vẫn là bằng chứng có cái chết). Nối vào `index.ts` ngay sau `crashReporter.start`, trước `pruneOldCrashDumps` (prune trước sẽ xoá dump chưa được ghi sổ), không chờ và không chặn khởi động. `IssueClass` thêm `runtime` (`NATIVE_CRASH`, `CRASH_DUMP_UNREADABLE`, tiền tố `runtime.`).
- **Bằng chứng**: parse dump thật (68.626.272 B) trong **22 ms** → `browser died with STATUS_ACCESS_VIOLATION (0xc0000005) at ...\electron.exe+0x000000000684d7a8, read of 0x0000000000000000` (pid 30392, `ver` 43.4.0, 58 thread, native addon `node-pty\prebuilds\win32-x64\pty.node`); sau intake, `IssueRegister.summarizeOpen()` có `P0 NATIVE_CRASH ×1 [runtime]`; `test/unit/crash-report-intake.test.ts` 7/7 (dump dựng theo đúng layout byte, gồm ca write-fault/địa chỉ ngoài mọi image, dump rác → null, dedupe lần khởi động thứ hai, cap 5).

### Sửa lỗi — Full-page capture từ chối oan trên trang có carousel/banner động
- **Nguyên nhân**: `imageIdentityStable` so **cả vị trí** từng ảnh, nên một carousel chạy bằng `transform` (tiki.vn: hộp ảnh `1000,4680,156,156` dịch chuyển trong khi `docHeight` đứng yên 7576) và một slot quảng cáo đổi nguồn ảnh (vnexpress.net: beacon 1×1 → creative) đều bị trả `IMAGE_IDENTITY_UNSTABLE` dù tài liệu đã đứng yên để raster.
- **Sửa**: structural identity chỉ còn **kích thước hộp ảnh** (bỏ vị trí, bỏ `naturalWidth/Height`): ảnh thêm/bớt/đổi cỡ → vẫn từ chối (tài liệu còn đang dựng); ảnh **dịch chuyển** (carousel transform, reflow trong viewport) → chấp nhận. Lý do và witness đổi theo đúng cái đã đo (`first differing box size`), không suy diễn tên lớp CSS của một trang cụ thể.
- **Bằng chứng** (full-page thật): tiki.vn `OK` 2.479.777 B raster 1424×7576 (trước: từ chối), vnexpress.net `OK` 3.614.737 B raster 1424×11359 (trước: từ chối), wikipedia từ chối **có lý do** (`1424x60913` vượt trần 16384) trong 8 ms; `test/unit/capture-settle.test.ts` 38/38, gồm ca mới "admits a capture while a transform carousel moves images without reshaping them".

### Haravan — Đổi đích theme, dọn đích cũ, siết script pull
- **Chọn đích theo tham số và từ chối theme đang chạy**: `scripts/lib/theme-target.mjs` (`resolveThemeId()`) là nguồn duy nhất cho 4 script kiểm chứng storefront — mặc định theme `1001514194`, đọc `HARAVAN_THEME_ID`, từ chối `1001510509` (theme `main`) và mọi giá trị không phải số (`test/unit/theme-target.test.mjs`). Chạy thật: `HARAVAN_THEME_ID=1001510509` → exit 1 kèm `[SAFETY] refusing to target the protected live theme`; mặc định → 15/15 route HTTP 200.
- **Pull là mirror chứ không phải sync, và biết remote đã đổi**: quyết định lấy/không lấy tách thành `scripts/lib/pull-decision.mjs` (12 ca trong `test/unit/pull-decision.test.mjs`) — tệp bị sửa sau pull **không bao giờ** bị ghi đè kể cả khi `HARAVAN_FORCE_REFRESH=1`; tệp văn bản so độ dài byte; **ảnh nhị phân so `updated_at`** và thêm tín hiệu thứ hai: độ dài lệch `size` API thì tải lại một lần, nếu vẫn lệch thì ghi `variantRepresentation: true` để tín hiệu yếu đó không thành vòng tải-lại-mỗi-lần-chạy (cờ sống qua cả nhánh `skip` và `edited`). Trước đây ảnh chỉ được tải lại khi bấm force nên drift thật không bao giờ bị thấy: `hera_index_hero_2_mobile.jpg` `17:02:03Z → 17:35:29Z`, `shop_social_sidebar_item_image_{1,5}.png` → `17:35:42Z`/`17:35:47Z` trong lúc làm việc. Script nay in danh sách khoá được tải lại; hai lần chạy liên tiếp cho `fetched 0, refreshed 0, skipped 241`.
- **Ghi nhận giới hạn của phép đo byte**: CDN trả byte khác nhau cho cùng một `public_url` (`hera_index_hero_1_mobile.jpg`: 45.507 B rồi 55.681 B) và theo `Accept` (`Vary: accept, accept-encoding`; webp 76.840 B vs jpeg 98.904 B) nên tài liệu **không** còn lấy "khớp byte với CDN" làm tiêu chí kiểm chứng. `size` là trường **không diễn giải được** — nó không khớp ổn định với `attachment` lẫn byte CDN (hero_1 `size` 55.681 vs `attachment` 45.507; coupon_2 2.140 vs 1.653; social_1 1.542 vs 1.288; chỉ hero_2 khớp) nên không dùng làm tiêu chí đủ/thiếu. Nội dung uỷ nhiệm là `value` (văn bản) / `attachment` base64 (nhị phân). Các ghi chú cấp khoá (`variantRepresentation`, `attachmentBytes`, `cdnSourced`) nay mang qua `skip`/`edited` bằng **một danh sách duy nhất** (`CARRIED_ENTRY_NOTES`) thay vì từng câu `if` viết tay — chính kiểu viết tay đó đã làm rơi `attachmentBytes` rồi `cdnSourced`. Khi API không trả `attachment` cho ảnh, byte lấy từ CDN được ghi dấu `cdnSourced: true` vô điều kiện (trước đây nguồn chỉ được suy ra từ độ dài ≠ `size`, bỏ sót đúng ca dài bằng `size`); đối chiếu nội dung 18:18:40Z–18:19:24Z: 237/237 khoá so sánh được khớp, 4 khoá remote không có nội dung nên không kiểm được. Đo tiếp trên 2 ảnh đang lệch cho thấy CDN trả **đúng định dạng** theo đuôi tệp (`image/jpeg`, `image/png`) và gửi `Accept` không đổi câu trả lời (cùng sha256) ⇒ không có byte sai định dạng, và không có cách nào "sửa" phía client để đạt parity với bản gốc; hai khoá đó được đánh dấu `variantRepresentation` và mỗi lần chạy in ra INFO.
- **Ảnh nhị phân lấy từ `attachment` của API, và có chế độ kiểm tra parity**: nội dung uỷ nhiệm của một asset là `value` (văn bản) hoặc `attachment` base64 (nhị phân); `public_url` có thể trả bản đã chuyển đổi/cache nên chỉ dùng làm đường dự phòng, và `public_url` không đúng host `cdn.hstatic.net` thì bị từ chối kèm lý do thay vì lỗi DNS. Thêm `HARAVAN_VERIFY_PARITY=1`: đọc lại nội dung uỷ nhiệm của API cho mọi khoá, so sha256 với mirror, in `[FAIL]` + exit 1 khi lệch (asset không có nội dung phía remote được báo `[WARN]` riêng, không tính là lệch). Đo được: 240/241 khoá khớp tại thời điểm kiểm.
- **Dọn đích cũ**: xoá 617 tệp tracked gắn theme `1001512581` (mirror `themes/phukienmaymoc-copy` 53 MB, plan `260912-1731`, report cấp store/phiên cũ, 3 script gắn mirror); hạ cấp claim `VERIFIED` mất nguồn trong `docs/haravan` (và repoint quan sát corpus sang `customizes/*` — nguồn còn sống); xoá rác `.hrv_tmp_pull-*`; giữ `reports/haravan-store-inventory.json` vì `specs/base-theme-contract.json` cite.

### Annotation — Self-QA gate buộc mở tab xem thật + QA binding (contract 3.3.0-lean)
- `SELF_QA_DIRECTIVE` viết lại thành pipeline bắt buộc: (1) mở/reload tab tới Page URL của annotation và `anti.inspect.dom`/`anti.inspect.styles` đúng Element Selector để chứng minh DOM live phản ánh edit (chưa phản ánh → báo "verification pending theme sync", không báo pass/fail), (2) `anti.screenshot.viewport`/`full_page` làm bằng chứng, (3) `theme.qa_validate` với `tabId`/`workspaceRoot`/`expectedUrl` từ dòng "QA Binding" mới trong annotation markdown. Bổ sung nhánh lỗi còn thiếu: `CAPABILITY_NOT_FOUND` (không retry trong task, nhưng task mới phải tự probe lại), `SETTLE_INCOMPLETE`/`CAPTURE_NOT_READY` (retry đúng 1 lần rồi báo `INCONCLUSIVE` kèm gate detail), `TARGET_*`/`URL_*_MISMATCH` (`anti.browser.rebind_target` → navigate tab đang bind tới Page URL). `AGENT_CONTRACT_VERSION` 3.2.0-lean → 3.3.0-lean; test literal cập nhật có chủ đích.
- Annotation payload mang `tabId` của tab được annotate (`AnnotationPayload.tabId`, `AntiFanPickedElement.tabId`, inject tại `tab-devtools-host.ts` từ `targetTabId` phía host — không tin payload phía page); markdown sinh ra có dòng `QA Binding (AntiFan MCP)` gồm `tabId` + `workspaceRoot` + `expectedUrl`.
- `theme.qa_validate` nhận thêm `expectedUrl` (optional): khi khai báo, route gate `checkRouteIdentity` (host/themeid/path) chạy trước khi validate — sai trang hoặc sai `themeid` ném `URL_*_MISMATCH` thay vì QA lặng lẽ trên tab cũ. `BrowserControlPort.getLiveTabUrl`/`getTabRedirectChain` public hoá để capability dùng lại đúng route gate của visual compare.

### Annotation — QA receipt + terminal `qaStatus` token (contract 3.4.0-lean)
- `theme.qa_validate` nhận thêm `annotationId` và sau mỗi lần validate ghi **receipt file** `<workspaceRoot>/.antifan/qa-receipts/<ts>-<runId>.json` (receiptVersion, runId/attemptId, annotationId, tabId, documentGeneration, browserEpoch, expectedUrl, observedUrl, verdict `QA_PASSED`/`QA_FAILED`, passed, criticalCount, createdAt). Receipt là bằng chứng gate cho runtime phía consumer — ghi receipt lỗi không bao giờ làm fail call QA.
- `SELF_QA_DIRECTIVE` bắt buộc mọi đường kết thúc khai báo đúng một token `qaStatus`: `QA_PASSED` | `QA_FAILED` | `QA_INCONCLUSIVE` | `QA_UNAVAILABLE`; báo "done" không token là vi phạm contract. `CAPABILITY_NOT_FOUND` đổi từ "không retry" sang **re-probe đúng 1 lần** (capability có thể vừa đăng ký sau restart app) trước khi terminal `QA_UNAVAILABLE`.
- Enforcement phía consumer: `~/.omp/agent/hooks/post/theme-qa-gate.ts` (user-scope OMP hook) theo dõi write/edit vào workspace có `.antifan/`; khi chưa có receipt mới hơn lần edit, mọi `tool_result` bị nối reminder gate; bypass audited qua token `QA_UNAVAILABLE`/`QA_INCONCLUSIVE` trong message assistant. Gate trên edit quan sát được, không trên intent khai báo.


### Toolbar — Sửa lỗi popup bị clip, bookmark bar, prompt modal và các nút hỏng
- **Cơ chế overlay token (chống clip popup)**: `toolbar.ts` thay thế `setOverlay(true/false)` đơn lẻ bằng `overlayTokens: Map<string, number | undefined>` refcounted. Trước đây đóng 1 popup gọi `setOverlay(false)` vô điều kiện làm co toolbar view (74px) và clip mọi popup còn mở (find bar, app menu, context menu). Nay mỗi popup giữ token riêng (`theme-qa`, `workflow-hub`, `phone-status`, `profile-dropdown`, `app-menu`, `shortcuts`, `mobile-remote`, `tab-context`, `suggest`, `find-bar`, `toast`, `prompt`); view chỉ co khi token cuối cùng được giải phóng; chiều cao overlay là max của các token đang giữ.
- **Bookmark bar hiển thị thật**: `native-tab-host.ts` thêm `isBookmarkBarVisible` vào payload `GET_INITIAL_STATE` và `STATE_UPDATED`; `renderBookmarks()` bỏ dòng `style.display = 'none'` hardcode, hiển thị bar (`display: flex`) khi bật và có bookmark, đồng thời render danh sách bookmark items có click-to-navigate. Tự động set CSS var `--bookmark-bar-offset: 28px` (0px khi tắt).
- **Find bar dynamic top**: `toolbar.css` đổi `.find-bar` từ `top: 76px` cố định sang `top: calc(76px + var(--bookmark-bar-offset, 0px))` — không còn bị đè lên bookmark bar khi bar đang mở.
- **Toolbar toast**: chuyển từ `bottom: 8px` (bị vẽ đè lên nút toolbar trong strip 74px) sang `top: 76px; right: 14px` (hiển thị dưới strip, trên vùng trang) và tự acquire token overlay `toast` (chiều cao 40px) trong suốt thời gian hiển thị.
- **Prompt modal thay thế `window.prompt()`**: Electron renderer ném lỗi khi gọi `window.prompt()`, làm chết 2 tính năng (`btnHubNewWorkflow` tạo workflow mới trong Hub và `menuItemSetAlias` đặt alias tab trong context menu). Bổ sung `#promptOverlay` modal (HTML + CSS + `showPromptDialog()` bằng `Promise.withResolvers`) xử lý Enter/OK và Esc/Cancel/backdrop.
- **Opener cho Mobile Remote**: `#mobileRemoteOverlay` vốn mồ côi (không có nút mở vì `btnMobileRemote` không tồn tại trong HTML). Bổ sung mục `menuItemMobileRemote` (📱 Mobile Remote (QR)) vào `#appDropdownMenu` và wire sự kiện mở modal.
- **Phím Escape toàn cục**: nhấn Esc nay lần lượt đóng popup/modal đang mở (`phoneStatus`, `tabContextMenu`, `appDropdownMenu`, `profileDropdownMenu`, `shortcutsOverlay`, `workflowHubOverlay`, `mobileRemoteOverlay`, `themeQaOverlay`).
- **Screenshot ghi Clipboard**: `menuItemScreenshot` trước đây gọi `captureViewport()` rồi bỏ qua kết quả; nay ghi base64 vào `navigator.clipboard` và hiển thị toast xác nhận.
- **Theme QA hiển thị lỗi rõ ràng**: `runThemeQa()` thất bại nay mở `themeQaOverlay` hiển thị chi tiết lỗi thay vì chỉ hiện một toast thoáng rồi mất dấu.
- **Dọn dẹp mã chết**: gỡ bỏ các listener và biến thừa gắn với các ID không tồn tại trong `toolbar.html` (`btnRuler`, `btnCaptureFullPage`, `btnDevTools`, `codexMainMenu`, và 6 ID menu cũ `menuFind`, `menuQuickAnnotate`, `menuFontFinder`, `menuLens`, `menuOpenBrowser`, `menuShortcuts`). Sửa độ rộng tối thiểu của toolbar overlay khi mở sidebar từ `Math.max(200, ...)` thành `Math.max(400, ...)` cho nhất quán với `updateLayout`.
### Sửa lỗi — Terminal mất handle PTY (phát hiện khi làm test "cắn")
- `TerminalManager.spawn` tạo record với `pty: null` nhưng **không gán** handle `node-pty` vừa tạo vào record, nên mọi đường dùng handle đều là no-op: `writeTo`/`write` bỏ im lặng mọi phím gõ (`ensureSessionPty` coi record không PTY là "chờ khôi phục" và spawn lại), `resize`/`resizeTo` chỉ ghi `pendingCols/pendingRows`, teardown không kill được shell (nguy cơ tiến trình mồ côi), và `getDiagnostics` luôn báo `runningPtyCount = 0`. Nay `spawn` gán `s.pty = child`; hai test `INVARIANT 4 (Input Routing)` và `INVARIANT 5 (Geometry Routing)` trong `test/main/terminal-stream-invariants.test.ts` khẳng định input và geometry tới đúng PTY của session — đỏ riêng từng ca khi bỏ dòng gán, xanh khi có.

### Kiểm thử — Audit suite (ultra: 5 ứng viên + 1 verifier)
- Gate `npm test` từng dừng ngay sau `test:canary` đỏ (`&&`), nên ~1.957 test phía sau chưa từng chạy trong gate mặc định. Nay `scripts/run-test-pipeline.mjs` chạy đủ 7 làn test ở `npm test` (thêm 2 cổng tĩnh `audit` + `plans:check` ở `npm run verify`), ghi nhận từng làn, đánh dấu `skipped` cho các làn phụ thuộc khi `compile` hỏng, và thoát 1 nếu có làn đỏ; `npm test`/`npm run verify` trỏ vào runner này.
- 12 test `test:main` đỏ vì fixture thiếu kỳ vọng URL (`URL_EXPECTATION_MISSING` → `INCONCLUSIVE`) và `diffPixels` đã bị bỏ khỏi payload so sánh: khôi phục `diffPixels` ở `src/main/tools/browser-control-port.ts` (tầng báo cáo, canary writer và QA matrix đều đọc trường này) và bổ sung `expectedTargetUrl`/`expectedBaselineUrl` trong fixture. `test:main` nay 1091 pass / 0 fail / 1 skip có tiền đề.
- `callTool` của MCP client nuốt `isError` và trả chuỗi lỗi như kết quả thành công ⇒ nay ném lỗi; test client chạy trên double stdio hermetic mới (`test/fixtures/mcp/fake-omp-mcp.cjs`, 52 tool) thay vì bridge sống.
- Ba test replay canary "pass" dù artifact không tồn tại: nay có tiền đề máy kiểm được (`test/fixtures/canary-run/replay-precondition.mjs` liệt kê 9 artifact thiếu kèm `sha256`/`byteLength`), skip phải nêu tên tiền đề thiếu thay vì im lặng.
- Test soak e2e khẳng định literal thay vì số đo: mọi trường báo cáo nay suy ra từ `samples` đã đo (`REQUIRED_SAMPLES = 10`, `SOAK_SLOPE_LIMIT_MB_PER_MIN = 5`).
- Bốn test "nói dối" được chuyển sang chạy code thật: cookie partition đi qua biên Electron `session` (bỏ `Map` RFC 6265 tự dựng); terminal invariants chỉ stub biên `node-pty` (bỏ ghi đè `privates.spawn`); gap state machine nạp `src/renderer/standalone.js` thật trong `vm` (harness dùng chung `test/renderer/standalone-harness.ts`); Round 1/4/6/8 của split (regex trên nguồn + số học sao chép) thay bằng 8 ca hành vi trong `test/renderer/terminal-split-behaviour.test.ts` — gồm hình học split đo từ `clientHeight`, kẹp `paneMin`, debounce nút, chord bàn phím, nhãn context menu, và định tuyến hyperlink (`createTab` → fallback `openExternal` khi thiếu **và** khi reject).
- Test "low-spec latency" đo vòng lặp `setImmediate` của Node (không chạm production) nay kiểm hai bất biến thật của `AsyncThemeQaQueue`: supersede abort đồng bộ, và job cũ settle muộn không xoá generation mới.
- `scripts/check-plans.mjs` bỏ qua plan **không có frontmatter** (11 plan không bao giờ bị gate) ⇒ nay nêu tên và thoát 1; đã ghi `status` có bằng chứng cho cả 11. `test/unit/check-plans.test.mjs` cập nhật theo hợp đồng mới (3 → 6 ca), gồm ca plan thiếu `status:` và ca cây plan của repo.
- Bất biến "zero remote hotlink" của site-clone không thấy `srcset`/`imagesrcset`/`poster`/`formaction`/CSS `url()`: nay có oracle độc lập `remoteResourceUrls()` tách từng candidate, fixture mang `srcset` remote thật, và ca chứng minh oracle bắt đủ 6 ngữ cảnh.
- `test/main/omp-mcp-adapter.test.ts`: 8 chỗ `await responsePromise` không có hạn (child im lặng ⇒ treo cả làn) nay bọc `withDeadline`; giữ `child.kill()` trong `finally`.
- Sửa nhỏ: tiêu đề test JPEG trùng với gate PNG trong `test/unit/visual-capture.test.ts`; chú thích sai "endpoint `/api/cookies/import` đã bị gỡ" (endpoint vẫn tồn tại, chỉ handshake extension bị gỡ); `.gitignore` thêm `.antifan-data/`.

### Haravan A–Z — Đợt rà soát chéo (ultra: 5 ứng viên + 1 verifier)
- Newsletter ở footer dùng đúng quy ước form của theme: khối thành công là `div.alert.alert-success[role="alert"]`, khối lỗi là `div.form-errors.alert.alert-danger[role="alert"]` với `{{ form.errors | default_errors }}`; trước đó là `div.form-error` cùng vòng lặp `form.errors.messages[field]` — không có CSS trong `assets/theme.css` và lệch khỏi `§states.formErrors` của hợp đồng cùng 7 form còn lại (article, activate_account, addresses, login, register, reset password, page.contact).
- Hợp đồng hết mâu thuẫn với code đã ship: `§states.variantUnavailable` và `SCENARIO_03` không còn mô tả nhãn "Không khả dụng" qua `selected_variant == nil` (theme không có chuỗi đó; `product.liquid:1` luôn có `current_variant`, và nút chỉ có "Thêm vào giỏ hàng"/"Hết hàng"). Trạng thái nay mô tả đúng kiến trúc swatch zero-JS: mọi chip trỏ tới biến thể thật, combo không tồn tại thì rơi về biến thể còn hàng mang giá trị đó.
- `ROUTE_LIST_COLLECTIONS` khai `paginate` trong `requiredLiquidObjects`, khớp quy ước của các route phân trang khác (`ROUTE_COLLECTION`, `ROUTE_SEARCH`, `ROUTE_BLOG`) và khớp bảng route trong tài liệu.
- Mục 9 tài liệu hợp đồng cập nhật 12 → 13 kịch bản; mục 10 bổ sung dòng `UNRESOLVED_06_NEWSLETTER_FORM_MECHANISM` (trước đó chỉ có 5 dòng dù JSON đã định nghĩa 6).
- Harness render `plans/reports/_render-base-theme.mjs` được nâng từ 19 lên **37 kiểm tra**: stub `paginate` nay cắt mảng theo `per_page`, dựng `parts`/`previous`/`next` nên nhánh `paginate.pages > 1` của `pagination-default.liquid` thực sự chạy (12/12/2 tile cho 26 danh mục, ẩn nav khi chỉ 1 trang); render thật `snippets/footer.liquid` (mặc định, thành công, lỗi, và tắt newsletter → không gọi form tag) cùng `templates/404.liquid` (không prefill `search.terms`).
- Kiểm tra pass 3 của swatch được sửa cho đúng đích: fixture cũ còn biến thể 4 nên pass 1 khớp trước và pass 3 không bao giờ chạy; nay `removeVariants: [4]` + `availability: { 2: false }` buộc pass 3 chạy, và assertion kiểm tra `href` trỏ đúng `?variant=2` thay vì chỉ tìm chuỗi "(Hết hàng)". Mỗi kiểm tra mới đều được xác nhận bằng đột biến: đổi `default_errors`, đổi `form 'customer'`, giới hạn `(1..2)`, bỏ include pagination, thêm prefill 404 — cả năm đều làm harness đỏ đúng chỗ.
- Gỡ hàm chết `hrefs()` trong harness.
- Vòng soát advisory sau đó: gỡ cờ chết `is_color`/lớp `color-swatch` trong `swatch.liquid` (không có rule CSS nào trong theme, chỉ là affordance rỗng); `pagination-default.liquid` ép kiểu `part.title | times: 1` trước khi so với `paginate.current_page` (corpus dùng đúng idiom này; nếu `title` về dạng chuỗi thì so sánh trực tiếp sẽ trượt); stub harness đặt `current_page` trong drop `paginate` và phát `title` dạng chuỗi, nên `aria-current="page"` được render thật và kiểm tra mới bắt được lỗi nếu ai bỏ ép kiểu (đột biến xác nhận). Siết lại hai câu quá mạnh: `SCENARIO_03` nay nói rõ thứ tự pass (hết hàng thì trỏ biến thể đã hết hàng và trang render "Hết hàng"), `SCENARIO_04` nói rõ số cột lấy từ setting `collection_grid_columns` ở mọi viewport vì theme không có breakpoint đổi số cột. Harness: **37 → 38 kiểm tra**. Mục 4.2 của tài liệu hợp đồng còn mô tả swatch theo kiểu "ưu tiên biến thể còn hàng" (tức là chọn theo tồn kho) — đã viết lại đúng 3 lượt như spec, lượt 1 cố ý không xét tồn kho.

### Haravan A–Z — Lint truthfulness, Base Theme, QA fail-closed
- Sửa bộ lint Haravan theo bằng chứng 45 theme: biến vòng lặp `cart.items` được tự do (chỉ chặn alias sai `cart_item`/`item_cart`/`cart_line_item`); `settings['x']` được phân giải theo cả `config/settings_schema.json` lẫn tên control trong `config/settings.html` (control nằm trong HTML comment không khai báo gì); `product.media` buộc có fallback `product.images` cùng file; `media_tag` bị từ chối; `blog.articles.size` chỉ bị chặn khi dùng như tổng số (không chặn phép kiểm rỗng); `settings.html` chỉ bị cấm khi schema đi kèm còn sống. Trên theme dự án: 27 → 5 vi phạm, cả 5 đều là include trỏ tới snippet không tồn tại.
- `dod-validator` chỉ chấp nhận `?themeid=<số>` khi audit preview Haravan; `theme_id=`/`preview_theme_id=` bị từ chối (chuỗi này từng xác nhận sai 45/45 case).
- QA fail-closed: thiếu bằng chứng ⇒ `INCONCLUSIVE`, điểm chưa đo để `null`, không tự cấp 100 cho một lần quét tĩnh.
- Bổ sung `themes/universal-haravan-base/` (base theme trung tính), wiki `docs/haravan/` (10 tài liệu), hợp đồng `specs/base-theme-contract.json`, cùng kế hoạch triển khai Haravan A–Z và bằng chứng scout/capture.

### Haravan A–Z — Vòng soát bàn giao (ShipReview) và Base Theme
- Lint: `settingsSchemaIsLive`/`settingsFormIsLive` từng là tham chiếu hàm trần (luôn truthy) nên chế độ `f1genz` từ chối mọi theme có `settings.html` và luật "thiếu khai báo settings" không bao giờ chạy; `SETTINGS_READ_PATTERN` cắt cụt id có dấu gạch nối (`settings.footer-top-check-1` → `footer`). Cả hai đã sửa và có fixture riêng.
- Site-clone/compiler: `atomicSwap` dọn `sections/`/`locales/` cũ khi hoán đổi thư mục; bộ sinh snippet không còn ghi đè header/footer do IR sinh ra; nhánh import `.ts` thứ ba của `compile-haravan-theme.mjs` nằm trong `try/catch`.
- `.gitignore`: `*.png` từng loại 123 ảnh PNG (18.82 MB) đang được Liquid trong theme dự án tham chiếu; negation `!themes/*/assets/*.png` khôi phục khả năng theo dõi.
- QA viewport chỉ-giảm: `passed` của caller là bắt buộc và được AND với ngưỡng `VISUAL_MISMATCH_PASS_THRESHOLD_PERCENT = 10`, nên diff 0.99% không thể nâng một FAIL cấu trúc thành PASS.
- Base theme: swatch là liên kết `/products/{handle}?variant={id}` (server render đúng biến thể, không cần JS, không lệch giá/ảnh); quickview nạp fragment từ `?view=quickview` → `templates/product.quickview.liquid` (`{% layout none %}`) và báo lỗi rõ khi tải hỏng; 404 có form tìm kiếm; gỡ 3 asset chết (`base-theme.css`, `base-theme.js`, `theme-tokens.css`).
- Hợp đồng base theme và `docs/haravan/base-theme-contract.md` khớp lại thực tế: input của product-loop, mô tả mini-cart/cart-table/quickview, số liệu census đo trên 45 root, và form newsletter được ghi nhận `UNVERIFIED`.

### Haravan A–Z — Đợt sửa sau rà soát (swatch đa thuộc tính, route /collections, newsletter)
- Swatch: chọn một thuộc tính không còn lật ngược thuộc tính khác. Mỗi giá trị chọn biến thể theo 3 lượt — (1) biến thể khớp mọi thuộc tính còn lại với biến thể đang render, **không xét tồn kho**, nên combo hết hàng vẫn được trỏ đúng và gắn nhãn (Hết hàng) thay vì lặng lẽ đổi sang giá trị khác; (2) biến thể còn hàng mang giá trị đó, chỉ dùng khi combo không tồn tại; (3) biến thể bất kỳ. Đang ở Xanh/S bấm M sẽ sang Xanh/M (kể cả khi Xanh/M hết hàng) thay vì Đỏ/M. Đã render thật qua LiquidJS: 19/19 kiểm tra.
- Bổ sung `templates/list-collections.liquid` cho route `/collections`: base theme trước đó không có template này trong khi route vẫn tồn tại — storefront thật trả HTTP 200 với class `template-list-collections`, và 41/45 root corpus phục vụ route bằng chính file đó (contract trước đây map sai sang `templates/collection.liquid`).
- Newsletter trở lại `{% form 'customer' %}` kèm `form.posted_successfully?`/`form.errors` — đây là cơ chế chuẩn của corpus (79 file thuộc 40/45 root đo được), thay cho POST thô tới `/account/contact` (chỉ 2 file). Đích lưu dữ liệu vẫn `UNVERIFIED` (`UNRESOLVED_06`).
- Gỡ snippet chết `product-grid.liquid` cùng setting `product_grid_columns` chỉ nó đọc (3 mặt cấu hình còn 38/38/38 khớp nhau); `collection-card.liquid` nay có nơi dùng thật là `list-collections`; bỏ prefill `search.terms` không có nguồn trên trang 404.

### Kiểm thử — Live PTY smoke trên shell thật
- `test/e2e/terminal-live-pty.test.ts` mở `powershell.exe` thật qua `node-pty` thật và chứng minh đường ống của sản phẩm, không phải stub: gõ dấu mốc rồi đọc lại từ chính shell, resize 100×40 được xác nhận **từ trong shell** (`[Console]::WindowWidth` = 100) lẫn trên handle (`pty.cols/rows`), `runningPtyCount` về 0 và teardown xong dưới 20 s với **shell pid cùng toàn bộ tiến trình con đều thoát**. Test theo dõi pid của chính shell (không quét cả máy) nên không đỏ giả khi các làn chạy song song; bỏ `safelyKillSession` làm test đỏ đúng chỗ (`timed out … waiting for the shell process`), khôi phục thì xanh. Làn `test:e2e` 7/7.

### Rendering & Device Preset Background
- Khắc phục triệt để lỗi tab Chromium hiển thị toàn màu đen (hoặc trắng) sau khi chuyển từ preset bo góc (iPhone/iPad/Galaxy) sang preset phẳng kích thước cố định (MacBook 13/14, Full HD, Surface Pro, iPhone SE…): `applyTabDeviceEmulation` giờ luôn đồng bộ màu nền của `WebContentsView` theo bán kính bo góc của preset (`#00000000` khi bo góc, `#ffffff` khi phẳng), thay vì chỉ đặt trong nhánh bo góc và bỏ quên nhánh còn lại. Trước đây view giữ nguyên trạng thái trong suốt, khiến mọi khoảnh khắc chưa được vẽ của tab lộ nền cửa sổ `#080c14` ra ngoài (tab đen) cho tới khi F5 vẽ lại toàn bộ viewport.
- Bổ sung unit test khoá hợp đồng "màu nền view luôn khớp bán kính bo góc" cho toàn bộ danh mục `DEVICE_PRESETS`, chặn tái phát khi thêm preset mới.

---
## [v1.3.5] - 2026-09-01 (Core Runtime Hardening, Lineage Safety & Dual-Tier MCP Parity)

### Core Runtime & Lineage Security
- Bổ sung canonical control-plane ID validation (`validateControlPlaneId`) và containment validation (`assertWorkspaceContained`, `assertNoReparseTraversal`) trong `WorkspaceFilePort.stageAttachment`, ngăn chặn triệt để path traversal qua `runId` và symlink/junction reparse points.
- Kiểm tra `assertNoReparseTraversal` trước khi `mkdirSync` đệ quy thư mục run, ngăn chặn side-effect tạo thư mục ngoài workspace khi `.antifan` hoặc `.antifan/artifacts` là symlink trỏ ra ngoài.
- Hỗ trợ idempotent duplicate staging: phát hiện file trùng qua `flag: 'wx'`, kiểm tra `isFile()` và so khớp hash `sha256` nguyên vẹn; ném `INVALID_ARGUMENT` khi phát hiện file bị sửa đổi / sai lệch hash.

### MCP & Capability Tool Parity
- Khớp nối và chuẩn hóa danh mục tool alias: expose đầy đủ `anti.theme.assert_cart` qua `mcpServer.listTools()` và duy trì contract đồng nhất cho `anti.agent.cursor.move`.
- Khắc phục triệt để các trường hợp edge case trong bootstrap parsing và heartbeat renewal.

## [v1.3.3] - 2026-08-31 (Runtime Performance, Token Guarding & Modular TabHost)

### Runtime Performance & Terminal Buffer Optimization
- Tối ưu hoá $O(1)$ memory cho `safeSliceTailJsonBounded` trong `TerminalManager`: duyệt ngược 1 lần (single-pass reverse scan) tính toán chính xác byte size UTF-8, escape sequences (`\x1b[0m`), ký tự điều khiển và lone surrogates ES2019 ($0xD800..0xDFFF \rightarrow 6\text{ bytes}$), xử lý buffer 512KB+ dưới 4ms mà không cấp phát mảng lớn.
- Bổ sung bảo vệ biên UTF-16 surrogate pairs cho `safeSliceTail`.

### Token Guard & Semantic Ref Error Protection
- Khắc phục triệt để nguy cơ rò rỉ toàn bộ DOM/`outerHTML` vào LLM context khi ref lookup thất bại: `SemanticRefRegistry` và `TabAutomationHost` trả về error payload cấu trúc ngắn gọn kèm gợi ý CSS selector.

### Phân tách Modular Sub-Controllers cho NativeTabHost
- Tách `TabAutomationHost` quản lý con trỏ AI trực quan (Visual Cursor), quỹ đạo Bézier (Bézier Trajectory), và thực thi World 1004 có bảo vệ hàng đợi FIFO.
- Tách `TabDevToolsHost` quản lý Font Finder, Lens, Ruler, Picker, In-Page DOM/screenshot, và View Page Source.
- Duy trì 100% public API parity và tương thích ngược hoàn hảo trên `NativeTabHost`.


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
