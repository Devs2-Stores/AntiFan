# Research: Full Page chạy ngầm và giữ trạng thái MCP

- Thời điểm: 2026-09-27T18:09:01+07:00.
- Phạm vi: phương án kiến trúc cho AntiFan; không triển khai, không chứng nhận backend.
- Contract: capture đúng page/document sau evaluate, style override và tương tác; không lấy focus, đổi tab hoặc vẽ đè lên giao diện người dùng; ảnh full-page phải có phạm vi xác định và không bị cắt âm thầm.

## Mục lục

1. [Kết luận](#kết-luận)
2. [Phương pháp và bằng chứng](#phương-pháp-và-bằng-chứng)
3. [So sánh phương án](#so-sánh-phương-án)
4. [Thiết kế đề xuất](#thiết-kế-đề-xuất)
5. [Phép thử quyết định](#phép-thử-quyết-định)
6. [Bảo mật và hiệu năng](#bảo-mật-và-hiệu-năng)
7. [Nguồn](#nguồn)
8. [Bước tiếp theo và câu hỏi mở](#bước-tiếp-theo-và-câu-hỏi-mở)

## Kết luận

Ưu tiên ngắn hạn: tách orchestration capture khỏi Electron nhưng giữ nguyên live target và đường CDP hiện có. Đánh giá full-page một raster trên OSR trước; đây là ứng viên cần thử, không phải khả năng đã được chứng minh. Không xóa guard full-page hiện tại chỉ để gọi thử trong app đang phục vụ người dùng.

Nếu cần backend độc lập với desktop compositor, chuyển toàn bộ workflow của job sang Chromium headless ngay từ đầu: navigate, evaluate, inspect, style override, interaction và capture cùng page. Đây là thay backend automation, không phải fallback riêng của screenshot. Playwright là ứng viên hợp lý nếu cần lifecycle/automation đầy đủ; CDP thuần hợp lý nếu tái sử dụng được hạ tầng hiện có và chủ động sở hữu lifecycle. Chưa có benchmark để tuyên bố thư viện nào ổn định hoặc nhanh hơn trong AntiFan.

Không chọn ba hướng: mở lại URL ở bước screenshot rồi coi là cùng trạng thái; thêm Playwright/Puppeteer chỉ để bọc cùng target đang thiếu frame; thêm cửa sổ hidden/off-monitor như giải pháp bảo đảm. Scroll-and-stitch là phương án có điều kiện cho nội dung hữu hạn, không phải thay thế tương đương một snapshot.

## Phương pháp và bằng chứng

Hai lượt web search trong lượt nghiên cứu này; ba trang chính thức được đọc trực tiếp mới, cộng ba tài liệu chính thức đã đọc ở bước tư vấn trước trong cùng phiên. Tổng sáu trang trực tiếp dùng trong danh sách nguồn. Search thứ hai trả nguồn ngoài bộ site yêu cầu; chỉ dùng để định hướng, không lấy code hoặc kết luận trong phần tổng hợp tìm kiếm làm bằng chứng.

Từ khóa: Electron offscreen rendering, capturePage stayHidden/stayAwake, backgroundThrottling, Playwright connectOverCDP, fullPage screenshot, unified Chrome headless. Ưu tiên tài liệu đang xuất bản; bài Chrome headless ghi cập nhật 2024-10-21, các trang API khác không cung cấp ngày xuất bản trong nội dung đã lấy.

Phân biệt phiên bản: package.json đã đọc khai báo electron ^43.4.0, không chứng minh runtime đang chạy đúng bản đó. Trang OSR hiện liên kết ví dụ 44.4.5; Puppeteer ScreenshotOptions đã đọc hiển thị 25.12.0; Playwright docs có noDefaults được thêm ở 1.60. Không suy ra tương thích trực tiếp giữa các phiên bản này.

Bằng chứng local đã đọc trong phiên:

- src/main/browser/tab-devtools-host.ts:2407–2418: canonical capture dùng Page.captureScreenshot, fromSurface:true, captureBeyondViewport cho mode không phải viewport.
- Cùng file, đoạn 2086–2091 ở lần đọc trước: từ chối FULLPAGE_CAPTURE_UNSUPPORTED_ON_OFFSCREEN. Số dòng có thể đổi do workspace đang được sửa đồng thời.
- src/main/browser/native-tab-host.ts:5538–5602: agent WebContentsView offscreen, ephemeral, không vào tabOrder; 5918–5939: không background-throttle offscreen.
- Cùng file:4041–4065: capture host ngoài màn hình có fallback đưa view lên cửa sổ thật. Không đổi activeTabId chưa đủ chứng minh không ảnh hưởng người dùng.
- src/main/tools/browser-control-port.ts:7337–7373 ở lần đọc trước: styleDiff đọc computed styles trên các target; không phải thao tác sửa CSS.
- Live probe trước nghiên cứu: session có tab offscreen/ephemeral riêng; Runtime.evaluate timeout 3000ms; get_viewport báo probe-unavailable. Không kết luận đây là giới hạn OSR hoặc nguyên nhân giống CAPTURE_TIMEOUT cũ.

Các nhận định thiết kế dưới đây là suy luận từ nguồn, chưa phải kết quả chạy phương án mới.

## So sánh phương án

| Phương án | Giữ trạng thái MCP | Chạy ngầm | Chi phí/rủi ro | Quyết định |
|---|---|---|---|---|
| Core capture riêng + CDP trên chính Electron target | Có nếu không reload/recreate | Phải kiểm chứng OSR | Thấp hơn thay backend; vẫn chịu vòng đời renderer Electron | Ưu tiên thử cho hiện trạng |
| Scroll/tile capture trên cùng target | Cùng page, nhưng scroll gây thay đổi | Phải có raster nền hoạt động | Fixed/sticky, virtualized content, seam và thời gian khác nhau giữa tile | Có điều kiện, không fallback âm thầm |
| Chromium headless sở hữu toàn bộ job | Có trong page của job từ đầu | Headless không có UI hiển thị theo tài liệu Chrome | Chuyển routing MCP, auth, custom scheme, lifecycle và evidence | Hướng thay thế mạnh nếu OSR không đạt |
| Playwright/Puppeteer attach vào Electron hiện tại | Có nếu attach đúng target, không navigate lại | Không có bảo đảm khắc phục compositor | Thêm controller/override/phiên bản | Không chọn mặc định để sửa thiếu frame |
| Worker mở URL mới chỉ lúc capture | Không bảo toàn trạng thái page cũ | Có thể render nền | Sai bằng chứng nếu coi là ảnh page cũ | Chỉ hợp với tác vụ URL-render độc lập |
| BrowserWindow hidden/off-monitor riêng | Tùy cách dùng target | Không bảo đảm raster không phụ thuộc presentation | AntiFan đã có biến thể capture-host và fallback | Không coi là phương án bảo đảm |

### Electron OSR: điều tài liệu chứng minh và không chứng minh

[S1] mô tả OSR của BrowserWindow xuất bitmap/shared GPU texture, có thể điều khiển painting/frame rate. Trang không đổi thì không phát frame mới. Không được dùng thiếu paint event đơn lẻ để kết luận renderer treo.

[S1] không chứng minh full-page beyond-viewport trên WebContentsView của AntiFan hoạt động ở Electron 43.x. Ví dụ BrowserWindow OSR chính thức và construction WebContentsView hiện tại khác nhau; cần kiểm tra construction và runtime thực tế. Không được kết luận WebContentsView không hỗ trợ chỉ từ việc ví dụ dùng BrowserWindow.

[S2] định nghĩa Page.captureScreenshot và Page.getLayoutMetrics/cssContentSize, fromSurface và captureBeyondViewport. API tồn tại không bảo đảm một surface cụ thể sinh raster được.

Giữ fromSurface:true cho OSR trong thử nghiệm này: source AntiFan ghi nhận nguy cơ native crash khi fromSurface:false trên target không có native window. Không dùng phép thử nguy hiểm đó trên app của người dùng.

### Playwright và Puppeteer

[S3] chứng minh Playwright hỗ trợ fullPage:true. [S4] chứng minh Puppeteer có fullPage, clip, fromSurface và captureBeyondViewport. Không tài liệu nào là bằng chứng auto-materialize mọi infinite/virtualized page hoặc chụp thành công mọi kích thước.

[S5] cảnh báo connectOverCDP có fidelity thấp hơn kết nối protocol Playwright, và launch args khác có thể làm chức năng hỏng. Fidelity ở đây là độ đầy đủ của kết nối automation, không phải kết luận pixel kém hơn. Tài liệu còn nêu noDefaults ở bản 1.60 để tránh override mặc định lên context đang có; không dùng API này nếu chưa pin phiên bản hỗ trợ.

[S6] xác nhận Chrome headless không có UI hiển thị và hiện chia sẻ code với headful; old headless chuyển sang chrome-headless-shell từ Chrome 132. Không suy ra pixel của Chrome độc lập giống tuyệt đối Electron: engine version, fonts, DPR, GPU, color và media vẫn phải được kiểm soát.

Lựa chọn thư viện theo phạm vi:

- Chỉ orchestration capture với hạ tầng CDP sẵn có: ưu tiên adapter CDP nhỏ, không tự tạo framework plugin.
- Toàn bộ job browser độc lập: ưu tiên đánh giá Playwright-managed Chromium; lợi ích dự kiến là giảm lifecycle/automation tự viết, không phải raster engine mạnh hơn.
- Puppeteer: ứng viên hợp lệ cho Chromium-focused workflow; chưa có bằng chứng lợi thế vượt Playwright hoặc CDP thuần trong repo này.
- Không thêm cả hai thư viện. Không sử dụng con số dependency 200MB+ từ tư vấn trước; chưa đo và dễ lẫn browser binary với package.

## Thiết kế đề xuất

```text
AntiFan authority / target lock / job / evidence
                      |
           Capture orchestration core
      prepare → measure → raster → validate → restore
                      |
              adapter của target hiện có
             /                        
  Electron CDP                  Headless job backend
  page đang dùng                page từ đầu job
```

Core không import Electron, không show/focus/activate và không biết BrowserWindow. Không loại bỏ danh tính target khỏi lớp bao ngoài: capture vẫn phải ràng buộc backend, page/pane và document generation. Adapter không được âm thầm chọn page đầu tiên hoặc target đang active.

Một backend được chọn trước navigation của job. Nếu backend chết giữa job, báo lỗi rõ; không tự mở lại URL rồi phát hành ảnh thay thế như thể cùng trạng thái. Ảnh headless là bằng chứng tương tác thật nếu chụp đúng page đã thao tác, không mặc nhiên là ảnh synthetic.

Capture không bắt buộc resize viewport: thử native beyond-viewport trước để tránh thay đổi vh, sticky và media query theo chiều cao. Nếu phải override, snapshot cấu hình trước đó và phục hồi đúng cấu hình; clearDeviceMetricsOverride không tương đương khôi phục một cấu hình custom đã tồn tại. finally chỉ bảo đảm nỗ lực cleanup, không bảo đảm thành công khi connection/renderer đã chết.

Viewport, clip và full-page phải cùng contract về provenance, cancellation, geometry, completeness. Không cho Playwright và core cùng quản lý viewport transaction độc lập trên một page. Không chấp nhận PNG header đúng là bằng chứng ảnh đủ hoặc frame mới.

Với URL nội bộ như antifan-preview://, backend Chrome độc lập không tự có protocol handler của Electron. Trước khi chọn headless toàn job phải liệt kê và giải quyết custom scheme, preload, local preview và cookie/session; không tự chuyển thành URL khác mà không bảo toàn contract.

## Phép thử quyết định

Không có backend mới hoặc browser benchmark nào được chạy trong lượt nghiên cứu. Ma trận sau là acceptance cần thực thi, không phải kết quả.

### 1. Tách lỗi transport khỏi lỗi raster

Đầu tiên xác nhận runtime/build và exact target. Kiểm tra lệnh đọc đơn giản có trả lời trước khi gọi screenshot. Nếu Runtime.evaluate cũng treo thì thay screenshot wrapper chưa giải quyết điều kiện tiên quyết.

### 2. Hai môi trường, cùng fixture và cùng trạng thái

- Electron offscreen hiện tại và một Chromium headless độc lập.
- Mỗi môi trường navigate fixture rồi tự thực hiện cùng tương tác trong chính page đó; không sao chép URL ở cuối workflow.
- Viewport CSS, DPR và font xác định; marker đầu/giữa/cuối; lazy image; form chưa lưu; CSS override; nội dung thay đổi sau click.
- Chụp single-raster full-page trước. Không nới guard production hoặc đưa page lên cửa sổ người dùng.

### 3. Falsification bắt buộc

| Trường hợp | Điều phải chứng minh |
|---|---|
| App bị che/minimize | Focus, nội dung user-tab không đổi; ảnh page job vẫn mới |
| Static page không paint mới | Không báo treo chỉ vì không có thay đổi |
| Lazy-load hữu hạn | Footer và tài nguyên đã materialize xuất hiện |
| Fixed/sticky, vh layout | Không nhân đôi header hoặc đổi layout âm thầm |
| CSS override và form chưa lưu | Ảnh chứa trạng thái vừa thao tác |
| Hai job đồng thời | Không chụp chéo hoặc chia sẻ viewport transaction |
| Navigation giữa đo/chụp | Phát hiện document đổi, không chứng nhận nhầm |
| Renderer chết/timeout/cancel | Không false-success; cleanup có trạng thái thực |
| Trang quá dài/DPR cao | Giới hạn rõ, không cắt đuôi; không OOM không kiểm soát |
| Infinite/virtualized content | Không hứa ảnh toàn bộ nếu chưa xác định phạm vi hữu hạn |

Single-raster không đạt chưa tự động cho phép stitching. Tile mode cần overlap/seam checks, chính sách sticky/fixed rõ, phát hiện thay đổi chiều cao và bounds bộ nhớ. Ảnh ghép lấy nhiều thời điểm phải được phân biệt với snapshot một lần; không sửa CSS để giấu lỗi mà không ghi nhận.

## Bảo mật và hiệu năng

Đề xuất bảo mật: giữ debug transport private (pipe hoặc loopback được quản lý), không mở cổng ra mạng, không dùng default profile cá nhân cho worker, không tự copy credential. Giữ sandbox và policy truy cập URL/file; chụp URL tùy ý trên worker có quyền mạng nội bộ cần kiểm soát truy cập tương ứng. Đây là ranh giới thiết kế, không phải một CVE audit; chưa thực hiện rà advisory/CVE riêng.

Không tắt GPU toàn app chỉ vì ví dụ OSR của Electron dùng software output. [S1] phân biệt software/GPU bitmap/shared texture, nhưng không cung cấp benchmark đại diện workload AntiFan. Shared texture yêu cầu native integration; không chọn cho PNG screenshot chỉ vì nhanh ở copy GPU.

Ví dụ chi phí raw pixel: 1440 CSS px × 30000 CSS px × DPR²(2²) × 4 byte = 691200000 byte, khoảng 659 MiB cho một buffer RGBA, chưa tính copy/encoder/browser. Đây là phép tính dung lượng, không phải số đo RAM thực tế. Vì vậy giới hạn height, DPR, pixel count, số job và cleanup là điều kiện nghiệm thu, không thể suy từ dung lượng PNG đã nén.

Đo trước khi chốt: latency p50/p95, tỷ lệ timeout, peak memory, image completeness và focus changes trên cùng fixture/version/hardware. Không tạo browser process mới cho từng tile hoặc mỗi screenshot; lifecycle phải thuộc job/pool có giới hạn và được cleanup.

## Nguồn

- [S1 — Electron Offscreen Rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering): bitmap/texture, painting, frame generation, rendering modes; đọc trực tiếp trong nghiên cứu.
- [S2 — CDP Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot): screenshot/layout metrics; đọc trực tiếp ở bước tư vấn trong cùng phiên; tip-of-tree, không phải hợp đồng pinned runtime.
- [S3 — Playwright Screenshots](https://playwright.dev/docs/screenshots): fullPage; đọc trực tiếp ở bước tư vấn trong cùng phiên.
- [S4 — Puppeteer ScreenshotOptions](https://pptr.dev/api/puppeteer.screenshotoptions): fullPage/fromSurface/clip; đọc trực tiếp ở bước tư vấn trong cùng phiên.
- [S5 — Playwright BrowserType](https://playwright.dev/docs/api/class-browsertype): connectOverCDP fidelity, noDefaults, browser version/launch constraints; đọc trực tiếp trong nghiên cứu.
- [S6 — Chrome Headless](https://developer.chrome.com/docs/automation-and-testing/headless): unified headless và phân biệt old headless; đọc trực tiếp trong nghiên cứu.

Không chọn tutorial/community repo làm nguồn quyết định khi đã có API chính thức. Không cung cấp code triển khai chưa chạy dưới dạng giải pháp đã kiểm chứng.

## Bước tiếp theo và câu hỏi mở

1. Chốt exact build/runtime/target đang có lỗi; không rerun chỉ để xác nhận triệu chứng người dùng đã báo.
2. Chạy phép thử same-page OSR versus headless độc lập có marker/state/focus evidence. Đây là bước quyết định, trước refactor diện rộng.
3. Nếu OSR đạt: tách core và tích hợp trên target hiện có; bỏ đường gây ảnh hưởng giao diện trong background mode.
4. Nếu OSR không đạt do giới hạn đã chứng minh: thiết kế chuyển toàn bộ job sang một backend headless, bao phủ mọi MCP liên quan và custom preview/auth. Không cắt riêng screenshot khỏi workflow.
5. Chỉ chứng nhận tập trang và môi trường đã thử; kết quả không đầy đủ phải là lỗi hoặc trạng thái không hoàn thành, không gắn nhãn Full Page thành công.

Câu hỏi mở: runtime thực tế có đúng bản source đã đọc không; nguyên nhân Runtime.evaluate timeout; khả năng beyond-viewport trên OSR/WebContentsView đúng phiên bản; ảnh full-page tối đa cho workload thực; chi phí hỗ trợ custom scheme/session ở headless; sai khác pixel giữa hai môi trường. Chưa có dữ liệu để chốt backend thắng tuyệt đối.

---

## Kết quả thực thi (2026-09-27 18:47)

Phép thử quyết định đã chạy: `node scripts/run-electron.cjs scripts/probe-background-full-page.cjs` (Electron 43.4.0, Chrome 150, Windows x64), 8 mode.

**Chẩn đoán xác nhận bằng probe:**

| Mode | eval | viewport capture | full-page 1 + 2 |
|---|---|---|---|
| `wcv-production-blank` | TIMEOUT(3000ms) | Internal error | skipped |
| `wcv-simple-blank` | TIMEOUT(3000ms) | Internal error | skipped |
| `wcv-production-loaded` | 1ms OK | TIMEOUT(15000ms) | ok 390ms/84ms, 800x2400, pixel markers đúng |
| `wcv-production-painton` | 0ms OK | TIMEOUT(15000ms) | ok 432ms/92ms, marker đúng |
| `wcv-production-attached` | 1ms OK | ok 315ms | ok 142ms/146ms, marker đúng |
| `wcv-simple-loaded` | 1ms OK | TIMEOUT(15000ms) | ok 464ms/105ms, marker đúng |
| `bw-simple-loaded` | 0ms OK | ok 291ms | ok 138ms/133ms, marker đúng |
| `bw-production-loaded` | 0ms OK | ok 228ms | ok 124ms/137ms, marker đúng |
| `wcv-production-blank-loadurl` (bổ sung) | 11ms OK | TIMEOUT(15000ms) — expected | skipped |

Kết luận từ bằng chứng:

1. `about:blank` không `loadURL` → WebContentsView không có renderer document → `Runtime.evaluate` timeout, viewport capture "Internal error". Đây là nguyên nhân session tab offscreen/ephemeral provision với `about:blank` (bridge-server.ts:2198, browser-control-port.ts:7702) bị wedge ngay từ lệnh đầu.
2. Detached WebContentsView (không add vào window): viewport capture (fromSurface:true) TIMEOUT vì compositor không có frame; full-page `captureBeyondViewport:true` vẫn raster đúng toàn tài liệu (marker top/mid/foot đổi giữa hai lần chụp = document còn sống).
3. OSR single-raster full-page khả dĩ trên Electron 43 → không cần headless Chromium backend cho capture; không cần window riêng cho MCP.
4. Probe mode `wcv-production-blank-loadurl` (mới trong phiên sửa) chứng minh fix đúng chỗ: `loadURL('about:blank')` trên offscreen WebContentsView materialize renderer — `Runtime.evaluate` trả lời sau 11ms thay vì TIMEOUT. Không cần seed `antifan:`/`data:` (data: bị BLOCKED_SCHEMES chặn).

**Sửa đã áp dụng:**

- `tab-devtools-host.ts`: khôi phục `isOffscreenTarget = target.state?.offscreen === true` trong `captureVerificationScreenshot` — offscreen target dùng cùng CDP surface transaction (full-page qua `captureBeyondViewport`, không đụng viewport raster cần compositor).
- `native-tab-host.ts` `createTab`: offscreen agent tab cũng `loadURL('about:blank')` để materialize renderer (nhánh `url !== 'about:blank' || isOffscreen`); guard `isAllowedNavigation` giữ nguyên.
- `project-window-shell.ts` `closeSelf`: giữ `beginCloseAttempt` trả `ShellCloseAttempt` (public surface `authorize`/`reset`/`settled`); internal `isSettled`/`completeCloseAttempt` truy cập qua `ActiveCloseAttempt` cast ngay tại chỗ mint — impl luôn trả `ActiveCloseAttempt`, signature public không nới.
- `test/main/ipc-audit.test.ts`: source-grep `url !== 'about:blank'` cập nhật pin sang điều kiện mới `url !== 'about:blank' || isOffscreen` (invariant `loadURL().then(clearInitialNavigationHistory)` giữ nguyên).

**Verification:**

- `npm run compile`: clean, 450 emit files.
- `tab-devtools-host.test.js`: 48/48 (test 17 khẳng định cùng CDP transaction với `captureBeyondViewport:true`, clip 800x2400).
- `render-surface-and-viewport-gates.test.js`: 26/26; `native-tab-host-viewport.test.js`: 19/19.
- `close-outcome-deadline.test.js`: 6/6; `project-window-manager.test.js`: 36/36.
- `smoke-background-multitasking.cjs` live Electron: ALL CHECKS PASSED — background DOM inspect/click/type/reload không switch tab, RT-01 scoped preemption đúng.
- `ipc-audit.test.js`: 14/14 (regex pinned sang điều kiện mới).

**Giới hạn còn lại:** viewport capture trên target offscreen-detached vẫn sẽ fail closed (compositor không có surface) — đúng thiết kế; caller cần raster viewport trên tab offscreen phải qua full-page hoặc window raster. Agent tab `about:blank` trước đây hiếm khi bị gặp vì navigation đến nhanh; lỗi chỉ lộ khi lệnh đầu tới trước khi navigate xong.
