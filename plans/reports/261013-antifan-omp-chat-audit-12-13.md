# AntiFan: điểm cần cải thiện, rút từ chat OMP 12–13/10/2026, Issue Register / MCP Hub và codebase ở HEAD

- **Phạm vi:**
  - 30 session OMP (mọi project) có hoạt động trong khoảng 12/10 00:00 đến 13/10 23:59 (UTC+7), tổng 603 MB JSONL. Không tính session audit này và một probe rỗng. Các session tạo từ trước 12/10 chỉ lấy phần nằm trong khoảng này.
  - 15/30 session có gọi AntiFan MCP, khoảng 2.050 lượt ở session chính, chưa tính subagent.
  - `E:/Work/.antifan-data/issues/issue-register.jsonl`: 394 dòng trong khoảng này, trên tổng 1.226 dòng.
  - `E:/Work/apps/AntiFan/.antifan/telemetry/gaps.jsonl`: 22 dòng trong khoảng này.
  - Workflow & MCP Hub: `src/renderer/toolbar.html:673-738`, `src/renderer/toolbar.ts`.
  - Codebase ở HEAD `1e7ebab3`. `tsc --noEmit` sạch (0 lỗi).
- **Cách làm:**
  - Dựng một digest cho mỗi session (USER / ASSISTANT / AF-CALL / AF-ERR / TOOLERR / PLAYWRIGHT, cộng phần subagent).
  - Chạy 8 analyzer digest, 1 analyzer cho Register và Hub, 1 analyzer cho sức khỏe codebase.
  - Controller đối chiếu các mục quyết định thứ hạng với code (file:line), `git log` và dữ liệu sống.
  - Mục nào chỉ analyzer báo, chưa đối chiếu, ghi là *(analyzer)*. Mục nào là suy luận, ghi `[INFERENCE]`.
- **Working tree:** `src/shared/theme-checklist.ts` đang sửa dở (của task khác). Report này không đụng vào file đó.

## 1. Tóm tắt

1. **Theme QA vừa được sửa các lỗi verdict nghiêm trọng, nhưng vẫn còn lỗ.**
   - Trong khoảng audit, 5 commit đã sửa:
     - sweep đo sớm 60 ms nên trả PASS giả;
     - CLS giả 3.156, trong khi CLS thật là 0.0004;
     - script DOM semantics bị lỗi cú pháp;
     - integrity chỉ đo ở một độ rộng.
   - Hệ quả: các verdict responsive ký trước 12/10 19:03 không đáng tin.
   - Còn mở:
     - `theme.cockpit_scan` bị abort 5/5 lần;
     - false negative với lỗi tương tác (modal, quickview, icon, slider, sticky bar) mà người dùng phải tự chỉ ra.
2. **Dữ liệu telemetry đang bị test làm bẩn.**
   - Khoảng 62% số dòng Issue Register trong khoảng audit là rác do test để lại.
   - Nguyên nhân đã xác minh: terminal AntiFan export `ANTIFAN_DATA_ROOT`, nên guard cách ly test tưởng suite đã tự pin data root.
   - Register cũng không đếm số lần lặp, severity luôn là P3, và MCP Hub không có chỗ nào để xem hay triage nó.
3. **Pipeline capture / viewport vẫn là nguồn gây kẹt lớn nhất, và đây là lỗi lặp lại.**
   - Các lỗi gặp phải: CAPTURE_FRAME_STARVATION, NO_RENDER_SURFACE, và VIEWPORT_NOT_APPLIED trên trang bị tràn ngang.
   - Ảnh chụp luôn được trả inline mà không có đường dẫn. Riêng session Whenever ước tính khoảng 700k token chỉ cho ảnh.
4. **Authority fail-closed nhưng không có đường tự phục hồi. Lỗi lặp lại từ report 10/10.**
   - Khi bound tab chết, `rebind` báo TARGET_MISMATCH và `tabs.create` báo TARGET_REQUIRED, nên session bị khóa cứng.
5. **Ba điểm vệ sinh đã ghi trong report 10/10 mà vẫn mở:**
   - token daemon lộ vào env của mọi terminal;
   - hook `theme-qa-gate` nối text vào tool result dạng JSON;
   - app chưa bật switch chống throttle khi cửa sổ bị che.

## 2. Số liệu lỗi

### 2.1 Lỗi AntiFan trong chat (toolResult lỗi, mã lấy từ output)

| Tool | Mã | Lần | Session |
|---|---|---:|---:|
| anti.browser.evaluate | CAPABILITY_ERROR (lỗi JS trong script của agent, timeout 15 s) | 23 | 3 |
| anti.browser.evaluate | NO_RENDER_SURFACE | 6 | 3 |
| anti.browser.tabs.create | TARGET_REQUIRED | 6 | 4 |
| anti.screenshot.viewport | CAPTURE_FRAME_STARVATION | 6 | 3 |
| theme.cockpit_scan | `Theme QA was aborted by document navigation` | 5 | 1 |
| anti.browser.rebind_target | TARGET_MISMATCH | 4 | 2 |
| (nhiều tool) | EXECUTION_UNCERTAIN (sau khi app restart) | 6 | 2 |
| anti.browser.reload / navigate | EXECUTION_TIMEOUT / NAVIGATION_TIMEOUT | 6 | 3 |
| anti.screenshot.viewport | CAPTURE_NOT_READY / IMAGE_IDENTITY_UNSTABLE / CAPTURE_TIMEOUT / CAPTURE_SCALE_MISMATCH | 6 | 3 |
| anti.browser.set_viewport | VIEWPORT_NOT_APPLIED | 2 (register: 10) | 2 |
| anti.screenshot.full_page | ARTIFACT_TOO_LARGE (13,2 MB > 8 MB) | 1 | 1 |
| (validate ở proxy) | `Invalid args` cho record_fallback / full_page | 2 | 2 |

Playwright được dùng ở 5 session: UIUX/FigForYou, INPUT/S2 Rog Bike, SCOUT/SandOutfit, MULTI/F1GENZ Multipage và CARD/Lux Wine. Trong 5 session đó, chỉ CARD gọi `anti.telemetry.record_fallback`. WHEN và Fix-missing có gọi record_fallback, nhưng hai session này dùng script `playwright-core`.

### 2.2 Issue Register (394 dòng trong khoảng audit)

| Nhóm | Dòng |
|---|---:|
| Rác test do fixture để lại, có dấu hiệu rõ (`tab-1`, `tab-non-existent-999`, `tab-user-youtube`, `*-destination-777`…) | 189 |
| Rác test theo thời điểm: rơi đúng vào các đợt test chạy, chủ yếu PROJECT_MISMATCH với UUID không có trong capsule | ~56 |
| Lỗi vận hành thật | ~149 |

Mã lỗi vận hành thật: TARGET_MISMATCH 49, CAPABILITY_ERROR 22, TARGET_STALE 21, VIEWPORT_NOT_APPLIED 10, CAPTURE_FRAME_STARVATION 8, NO_RENDER_SURFACE 5, TARGET_OBSCURED 5, TARGET_REQUIRED 3, CAPTURE_TIMEOUT 3. Phần còn lại có ≤2 dòng mỗi mã.

Lưu ý: register gộp các dòng trùng `errorMessage` mà không đếm số lần. Vì vậy các con số trên **thấp hơn thực tế**. Ví dụ, `Evaluation timed out after 15000ms` chỉ còn 1 dòng, dù chat cho thấy lỗi này lặp hàng chục lần trong session Mnbakery.

## 3. Các cụm điểm cần cải thiện

### 3.1 Theme QA: độ tin cậy của verdict (sửa một phần trong khoảng audit, còn mở)

**Đã sửa ở HEAD, cần restart app để có hiệu lực:**

| Lỗi | Commit | Ảnh hưởng |
|---|---|---|
| Sweep chờ cố định 60 ms rồi đo, nên mốc 320/375 đọc ra 1425/1905 | `20dafbef`, `a71f166d` (12/10 18:56–19:03) | Lux Wine: 12/14 route từng được kết luận "không tràn ngang" sai |
| CLS đo sau sweep nên cộng cả các lần resize | `21b7a757` | CLS 3.156 giả (thật 0.0004) |
| Script DOM semantics lỗi cú pháp (regex trong template string không escape) | `5df22d09` | Audit SEO/a11y im lặng không chạy |
| Integrity chỉ đo ở viewport đang active; không có detector khoảng cách sát mép | `1e7ebab3` (13/10 16:39) | Lỗi mobile không lộ ra nếu tab đang ở desktop |

Hệ quả vận hành: các receipt `.antifan/qa-receipts/` ký trước các commit trên, nhất là phần responsive/overflow trước 12/10 19:03, cần chạy lại sau khi restart app.

**Còn mở:**

- **`theme.cockpit_scan` bị abort 5/5 lần (S2 Rog Bike).** Đã xác minh đường code:
  - Reload của QA đăng ký token một lần (`theme-qa-workflow.ts:630-633` → `native-tab-host.ts:1653-1672`, TTL 15 s).
  - Token bị tiêu ngay ở main-frame navigation đầu tiên (`native-tab-host.ts:8448`).
  - Mọi navigation main-frame tiếp theo trong lúc job chạy đều gọi `asyncQaQueue.abort(id)` (`native-tab-host.ts:8452`), và job trả `Theme QA was aborted by document navigation` (`native-tab-host.ts:15035`).
  - Nút QA trên toolbar dùng chung `runThemeQa` nên cũng dính lỗi này `[INFERENCE]`.
  - Navigation thứ hai cụ thể là gì (redirect bằng JS, preview `themeid`…) chưa có trace `[INFERENCE]`.
- **False negative với lỗi tương tác *(analyzer, S2 Rog Bike)*.** `qa_validate` báo PASS, rồi người dùng chỉ ra 6 lỗi liên tiếp bằng ảnh hoặc Direct-Edit:
  - icon giỏ hàng mất;
  - quickview vỡ;
  - mũi tên slider lỗi, nội dung slider trống;
  - sticky add-to-cart che nội dung;
  - "nát".
  - Scanner chỉ quét DOM tĩnh và không mở modal/drawer (SPACE, G8).
- **QA bị nhiễu môi trường *(analyzer)*:**
  - `[HotReload]` của Shopify CLI và CSP `frame-ancestors` của shop.app bị tính là critical, nên kết quả thành FAIL/INCONCLUSIVE (Whenever).
  - `qaMatrix` luôn INCONCLUSIVE (0/3 viewport) khi chưa có baseline (Mnbakery, 24 lượt).
  - `domUnstable` do timer autoplay của swiper, vì `media.freeze` không chặn được timer JS (Lux Wine).
- **Preset iPad Pro 13" = 1032 px** nằm trên ngưỡng desktop `≥1025` của theme, nên báo chồng chữ "ở iPad" mà thực ra đó là layout desktop *(analyzer, Mnbakery)*.
- **Churn:** 6 commit `fix(qa)` trong 1,5 giờ (12/10 17:30–19:03). Điều này cho thấy timing emulation→relayout chưa có contract test và chưa có fixture DOM thật cho scanner mới.

### 3.2 Issue Register, telemetry và MCP Hub (mở; một phần là lỗi lặp lại)

- **Test ghi vào register sống. Đã xác minh nguyên nhân gốc qua 3 mắt xích:**
  1. `terminal-manager.ts:1725-1731` spread `...process.env` và gán thêm `ANTIFAN_DATA_ROOT` cho mọi PTY. Shell của agent này có `ANTIFAN_DATA_ROOT='E:\Work\.antifan-data'`.
  2. Script trực tiếp `test:fast`, `test:unit` và `test:main` (`package.json:43,47,48`) không đi qua `scripts/lane-env.cjs`. Chỉ `npm test` (`run-test-pipeline.mjs`) mới pin thư mục riêng.
  3. `IssueRegister.defaultRegisterDir` (`issue-register.ts:402-406`) thấy `ANTIFAN_DATA_ROOT` đã set thì coi là suite tự pin root, nên ghi thẳng vào live dir.
  - Hậu quả:
    - ~245 dòng rác trong khoảng audit, theo từng đợt 11:31, 16:16, 16:44 … 13/10 16:37;
    - 19/22 dòng `gaps.jsonl` trong khoảng audit cũng là rác test (04:31Z);
    - Ghi chú auto-reconcile `"…before test-runner isolation existed"` (`issue-register.ts:936`) sai sự thật, vì guard đã có từ `f2e84390` (08/10).
  - Report 10/10 §3.8 ghi là "đã cô lập", nhưng thực tế chỉ cô lập cho lane của pipeline. **Lỗi lặp lại.**
- **Register mất thông tin. Đã xác minh:**
  - Severity bị gán cứng `'P3'` cho mọi lỗi transport (`capability-transport.ts:1300`).
  - Dedupe so khớp `errorMessage` thô, vốn chứa UUID tab và generation (`issue-register.ts:628-632`):
    - bản ghi trùng chỉ cập nhật timestamp, không có bộ đếm, nên mất tần suất;
    - mỗi tab id lại tạo một dòng mới, nên file phình ra.
  - Toàn register có 678 dòng OPEN. Toàn bộ dòng RESOLVED trong khoảng audit đều do batch auto-reconcile rác test *(analyzer)*.
- **Telemetry fallback nằm sai chỗ.** `record_fallback` ghi vào `.antifan/telemetry/gaps.jsonl` theo đường dẫn tương đối, thực tế rơi vào repo AntiFan, không nằm trong data root. MCP Hub cố ý không join file này (`toolbar.html:744-749`).
- **MCP Hub:**
  - 8 tab: Workflows / MCP Tools / Core Health / Bridge / Task Runs / Root Causes / Regression / MCP Dispatch (`toolbar.html:697-737`).
  - Không có tab Issue Register để lọc, triage hay resolve.
  - Root Causes hiển thị tóm tắt `summarizeOpen()` dạng gần như JSON thô *(analyzer)*.
  - Mục ladder `#17 Report Issue` (`scripts/goal/ladder/p0-p1.mjs:556`) thực chất chỉ là một test taxonomy. **Không có tính năng "Report Issue" cho người dùng.**

### 3.3 Capture / viewport (mở; CAPTURE_FRAME_STARVATION là lỗi lặp lại)

- **CAPTURE_FRAME_STARVATION / NO_RENDER_SURFACE khi cửa sổ bị che hoặc thu nhỏ.** Gặp ở FigForYou, Phukienmaymoc, S2 Rog Bike, Lux Wine và Whenever. Đây là trigger chính khiến agent nhảy sang Playwright.
  - App vẫn chưa bật switch chống throttle khi bị che: danh sách switch ở `src/main/index.ts:305-322` không có `disable-backgrounding-occluded-windows` hay tắt `CalculateNativeWinOcclusion`.
  - Throttle được tắt theo từng tab chỉ khi agent đang làm việc (`native-tab-host.ts:9377-9380`).
  - Thông báo lỗi bảo người dùng "focus or move the window" thay vì app tự nudge.
- **VIEWPORT_NOT_APPLIED trên trang tràn ngang là một nghịch lý. Đã xác minh.**
  - `setViewport` xác nhận bằng `documentElement.clientWidth/Height` (`browser-control-port.ts:4792-4806`).
  - Trang mobile tràn ngang làm layout viewport nở ra (390×844 thành 546×1182, tỉ lệ 1,4), và tool throw `geometry-mismatch` (`:4830-4838`).
  - Đúng lúc agent cần đặt mobile để sửa lỗi tràn thì tool lại từ chối. Lỗi kéo theo CAPTURE_SCALE_MISMATCH và CAPTURE_VIEWPORT_NOT_RESTORED.
  - Với tab nền thì có thêm `window-unmeasurable` (`native-tab-host.ts:15396`).
- **Kết quả screenshot chỉ có ảnh. Đã xác minh.**
  - Proxy tải artifact rồi trả `{type:'image'}` duy nhất (`scripts/antifan-omp-mcp.cjs:3079-3083, 3160-3167`). `artifactId`, sha và đường dẫn đều bị bỏ, và không có tùy chọn tắt inline.
  - Hậu quả:
    - session Whenever ước tính khoảng 700k token cho ảnh qua 5 vòng, có 41 lần compaction, và agent phải tự viết harness stdio để né;
    - session S2 Spa (EMOJI) không lấy được đường dẫn file, phải thêm nút Full Page vào toolbar (`1bbbfdfa`). Nút này chỉ giải quyết phía người dùng, còn đường MCP vẫn như cũ.
- **Full page:**
  - trần 8 MB làm PNG trang dài fail (ARTIFACT_TOO_LARGE);
  - nội dung trong container có thanh cuộn riêng (CKEditor) bị cắt *(analyzer)*.

### 3.4 Authority / tab lifecycle: fail-closed nhưng không có đường phục hồi (mở, lặp lại từ report 10/10 §5.1)

- **Bound tab chết thì session bị khóa cứng** (WHEN: "Verify issues using AntiFan MCP", FigForYou):
  - `rebind_target` sang tab người dùng đang mở báo TARGET_MISMATCH;
  - `tabs.create` báo TARGET_REQUIRED.
  - Đã xác minh: `ambientHostOrThrow` chỉ chọn host đang có automation tab, hoặc host duy nhất khi chỉ có một cửa sổ (`tab-ambient-authority.ts:51-63`). Nó không dùng project đã xác thực của session để chọn cửa sổ của project đó.
- **Không có đường "người dùng cấp quyền":** người dùng đưa đích danh tab id ở project khác (tab F1GENZ app trong session Mnbakery) và vẫn bị từ chối. Agent phải navigate chính tab storefront đi chỗ khác, nên mất trạng thái preview.
- **Rebind churn:** 29 lần trong session Mnbakery *(analyzer)*. Lỗi TARGET_MISMATCH không kèm danh sách tab hợp lệ (`capability-catalogue.ts:743`, `capability-transport.ts:705`).
- **Sau khi app restart *(analyzer)*:**
  - EXECUTION_UNCERTAIN, tab id đổi, phải list rồi rebind lại từ đầu (Phukienmaymoc);
  - process cũ giữ cổng 20130, nên bridge mới nhảy sang 63797 (Lux Wine).
  - Không có hot-reload, nên fix nào cũng cần restart. Lặp lại từ report 10/10 §5.3.

### 3.5 Hook làm nhiễm tool result và env PTY làm lộ secret (mở, lặp lại P1 của report 10/10)

- **Hook nối text vào tool result.** `src/omp-hooks/theme-qa-gate.ts` nối reminder và `[theme-qa-gate:bridge]` vào `tool_result` (`:1105-1110`, `:117`, handler `:1180`) mà không kiểm tra payload có phải JSON không.
  - Bằng chứng: output `tabs_list` bị dính thông báo nên `json.decoder.JSONDecodeError` (Lux Wine 12/10 19:04); `wait` bị nối `[theme-qa-gate:bridge] bridge recovered` (Tapdedo).
- **Env PTY làm lộ token.** Mọi terminal AntiFan đều thấy `ANTIFAN_TERMINAL_HOST_TOKEN`: env của shell agent này có biến đó, và OMP nhận ra nó là secret.
  - Nguyên nhân là `...process.env` ở `terminal-manager.ts:1726`, trong khi daemon L2 vẫn giữ token trong env (`daemon-spawner.ts:166,176-177`).
  - Bất kỳ process nào trong bất kỳ terminal nào cũng đọc được token điều khiển daemon PTY của mọi project.

### 3.6 Bề mặt tool, docs và hợp đồng MCP

- **Schema ở proxy viết tay, tách khỏi catalogue.**
  - Bảng khoảng 100 tool trong `scripts/antifan-omp-mcp.cjs:~60-140`, trong khi catalogue thật nằm ở `src/main/tools/*-capabilities.ts`.
  - Bằng chứng lệch: commit `b11a522f` phải bổ sung `multiBreakpoint` / `expectedUrl` / `annotationId` mà proxy quên; có lỗi `Invalid args` khi gọi record_fallback và full_page; `style_override` bắt buộc `id` *(analyzer)*.
- **README lệch:** chỉ liệt kê 19 tool snake_case từ thời prototype *(analyzer)*.
- **Thiếu tool đọc console log.** Không có capability `*console*` nào trong `src/main/tools` hay trong proxy (đã grep, 0 kết quả). Agent phải mở Playwright để lấy console, rồi bị chặn ở password gate (Lux Wine J1).
- **Thiếu probe responsive cho độ rộng tùy ý.** `responsive_matrix` cố định 5 mốc. Agent phải tự inject iframe, rồi dính timeout và làm bẩn DOM (Mnbakery, 51 lượt evaluate).
  - Lưu ý: `evaluate` **đã có** `timeoutMs`, ngân sách 30 s, trần 120 s (`browser-capabilities.ts:596,1018`, `browser-control-port.ts:1228-1230`). Agent không biết điều này, nên đây là lỗ ở docs/skill, không phải thiếu tính năng.
- **`navigate`/`reload` chỉ có một mức "load-complete".** Storefront nặng (SandOutfit) timeout ở 20 s / 60 s *(analyzer)*.
- **Cockpit:**
  - checklist mặc định chỉ seed cho theme mới, không migrate theme đã có;
  - cập nhật checklist phải restart app *(analyzer)*.

### 3.7 Codebase (nợ cấu trúc)

| File | Dòng | Seam nên tách (analyzer, có line) |
|---|---:|---|
| `src/main/browser/native-tab-host.ts` | 15.836 | `CHROME_ROUTES` 2.569–5.324 (2,7k dòng route IPC); Tab persistence 13.607–14.670; Terminal affinity 11.973–13.270 |
| `src/main/tools/browser-control-port.ts` | 8.768 | `visualCompare` 6.129–7.905; `traceInteraction` 5.172–6.082 |
| `src/renderer/standalone.js` | 8.841 | JS không kiểu, nên mất type của preload (`standalone-preload.ts` import từ `shared/contracts`) |
| `src/main/index.ts` | 5.297 | `createWindow` 4.010–4.844 (835 dòng); detach 2.176–2.550 |

Ngoài ra *(analyzer)*:
- `isTestFixtureResidue` bị nhân bản giữa `issue-register.ts` và `scripts/purge-register-fixture-residue.mjs`;
- `copy-static.mjs` nhúng chuỗi checklist vào `toolbar.js`;
- `scripts/` có 184 file, khoảng 64 file mồ côi.

## 4. Gốc xuyên cụm

1. **Fail-closed mà không tự phục hồi.** Authority, capture và cockpit đều refuse đúng thiết kế, nhưng không lớp nào tự rebind, tự nudge cửa sổ hay giữ token xuyên suốt cả job. Chi phí dồn sang agent dưới dạng Playwright fallback và rebind churn, rồi sang người dùng dưới dạng "Thử lại AntiFan MCP".
2. **Môi trường bị coi là lỗi.** Cửa sổ bị che, trang tràn ngang, HotReload, CSP bên thứ ba và carousel đều biến thành lỗi tool hoặc verdict INCONCLUSIVE/FAIL, thay vì được tách thành finding loại "environment".
3. **Kênh dữ liệu bị nhiễm.** Test ghi vào register sống, hook nối text vào tool result, env của app rò vào PTY. Cả ba cùng một gốc: thiếu ranh giới giữa process app và process con.
4. **Hai nguồn sự thật cho bề mặt tool.** Catalogue trong main và schema viết tay trong proxy, nên phải sửa lệch từng lần một.
5. **Không có vòng phản hồi cho chính AntiFan.** Register không đếm, không phân mức severity, không có UI. Hub không thấy fallback. Không có "Report Issue". Muốn biết điểm yếu phải audit chat thủ công như report này.

## 5. Ưu tiên đề xuất

**P0** (sai verdict hoặc hỏng dữ liệu)

1. **Restart app và chạy lại QA.**
   - Restart để nạp `20dafbef`…`1e7ebab3`.
   - Chạy lại `theme.qa_validate` cho các theme đã ký receipt responsive trước 12/10 19:03: Lux Wine, S2 Spa, S2 Rog Bike, Mnbakery, Whenever.
2. **Sửa abort của `cockpit_scan` / nút QA.** Token owned-reload phải sống suốt QA job (gắn với job id, không phải single-shot 15 s). Navigation trong cửa sổ job thì gọi `rebindGeneration`, không `abort`. Cần test cho trường hợp redirect 2 bước.
3. **Chặn test ghi vào dữ liệu sống.**
   - `defaultRegisterDir` dùng tmp khi `NODE_TEST_CONTEXT` có mặt, trừ khi `ANTIFAN_ISSUE_REGISTER_DIR` / `ANTIFAN_VERIFICATION_REGISTER_DIR` được set tường minh.
   - Bỏ `ANTIFAN_DATA_ROOT` khỏi env PTY, hoặc đổi tên thành biến không bị guard hiểu là "pinned".
   - `record_fallback` ghi vào data root.
   - Sửa ghi chú auto-reconcile.
   - Purge một lần các dòng rác trong khoảng audit.

**P1** (chặn công việc)

4. **Capture khi cửa sổ bị che.**
   - Bật switch chống throttle khi cửa sổ bị che (`disable-backgrounding-occluded-windows`, tắt `CalculateNativeWinOcclusion`).
   - Khi phát hiện starvation, app tự `resurfacePresentedView` rồi thử lại một lần trước khi refuse.
5. **`set_viewport` tách hai việc: emulation đã áp dụng hay chưa, và trang có tràn hay không.**
   - Trả success kèm `layoutOverflow: {scrollWidth, pageScale}` khi device metrics đã áp dụng.
   - Chỉ refuse khi emulation thực sự không áp dụng.
6. **Kết quả screenshot.**
   - Luôn trả `artifactId`, `sha256`, kích thước và `filePath`. Lưu bản sao vào `<workspace>/.antifan/snapshots/`.
   - Thêm `inline: false` để chỉ trả metadata.
   - Full page: fallback sang JPEG hoặc cắt tile khi vượt 8 MB.
7. **Authority tự phục hồi.**
   - `ambientHostOrThrow` resolve theo `projectId` đã xác thực của session.
   - Khi bound tab chết thì `tabs.create` / adopt trong cửa sổ project đó.
   - TARGET_MISMATCH trả kèm danh sách tab id hợp lệ.
   - Thêm đường người dùng cấp quyền tường minh cho tab ngoài project, qua UI.
8. **Hook không được làm bẩn tool result.**
   - `theme-qa-gate` không nối vào payload JSON hoặc structured; dùng system notice hoặc custom message.
   - Scrub `ANTIFAN_TERMINAL_HOST_TOKEN` (và `CI`, `CLAUDECODE`) khỏi env PTY.
9. **Fallback có đo đạc.**
   - Thêm tool đọc console log (`anti.inspect.console`), vì đây là lý do chính phải sang Playwright.
   - Hook OMP tự ghi `record_fallback` khi thấy `mcp__playwright_*`, thay vì trông vào agent.

**P2** (ma sát, bảo trì)

10. Sinh schema của proxy từ catalogue, bỏ bảng viết tay. Cập nhật README theo đó.
11. **Issue Register:**
    - fingerprint chuẩn hóa (bỏ UUID/generation) cộng `occurrences`;
    - map severity theo mã lỗi;
    - TTL / auto-resolve khi không tái diễn N ngày.
12. **MCP Hub:**
    - thêm tab Issue Register (lọc, triage, resolve, đếm);
    - render Root Causes cho người đọc;
    - nút "Report Issue" (toolbar và MCP) đính kèm snapshot, URL và log;
    - join `gaps.jsonl`.
13. **QA bớt nhiễu:**
    - HotReload/CSP bên thứ ba chuyển thành finding `environment`;
    - `qaMatrix` nói rõ cần baseline, hoặc tự promote baseline lần đầu;
    - freeze cả timer autoplay;
    - thêm scanner trạng thái tương tác (mở modal/drawer/quickview, đo icon 0×0, slider nav, sticky che nội dung), lấy fixture từ các lỗi S2 Rog Bike.
14. **Responsive:** probe nhiều độ rộng tùy ý mà không reload. Preset iPad 1024 cạnh 1032. Ghi `timeoutMs` của evaluate vào skill. Thêm `waitUntil` cho navigate/reload.
15. **Cockpit:** migrate checklist cho theme đã có; hot-reload bundle checklist.
16. **Nợ cấu trúc:**
    - tách các seam ở §3.7;
    - contract test cho timing emulation→relayout (để chặn churn kiểu 6 fix/1,5 giờ);
    - chuyển `standalone.js` sang TS theo từng phần;
    - dọn `scripts/`.

## 6. Analyzer báo nhưng đã bác hoặc điều chỉnh

| Claim | Kết luận | Bằng chứng |
|---|---|---|
| "Tab MCP Dispatch trống vì không có `control-plane/invocations`" | **Bác** | `StorageLocations.getControlPlaneDir()` = `control-plane-v2` (`storage-locations.ts:111-113`); `control-plane-v2/invocations` có 20 file, file mới nhất 13/10 16:42 |
| "evaluate timeout cố định 15 s, không chỉnh được" | **Điều chỉnh** thành lỗ ở docs/skill | `timeoutMs` có trong schema (`browser-capabilities.ts:596,1018`); budget 30 s, trần 120 s (`browser-control-port.ts:1228-1230`) |
| "Thiếu detector spacing; integrity chỉ đo 1 độ rộng" | **Đã sửa** ở `1e7ebab3`, chờ restart | `git show --stat 1e7ebab3` (layout-integrity-engine +144, theme-qa-workflow +48) |
| "PROJECT_MISMATCH 42 dòng" | **Điều chỉnh:** 1–2 dòng thật, phần còn lại là rác test | Các đợt 04:31Z, UUID không có trong capsule |

## 7. Contract bàn giao cho fix P0 (`/ak:fix`)

- **Outcome:**
  - `theme.cockpit_scan` và nút QA hoàn tất trên storefront có redirect sau reload;
  - không test nào chạy từ terminal AntiFan ghi được vào `E:/Work/.antifan-data/issues/*`;
  - các verdict cũ được chạy lại.
- **Ràng buộc:**
  - không nới guard authority;
  - không dùng Playwright;
  - không đụng `src/shared/theme-checklist.ts`, file đang dirty của task khác;
  - restart theo skill `antifan-app-restart`, giữ daemon.
- **Acceptance:**
  1. Test unit: QA job có 2 main-frame navigation trong lúc job chạy thì không bị abort. Navigation do người dùng hoặc agent gây ra ngoài job thì vẫn abort.
  2. Trong một shell có `ANTIFAN_DATA_ROOT=<live>` và `NODE_TEST_CONTEXT`, `IssueRegister` ghi vào tmp. Kích thước file register sống không đổi trước và sau `npm run test:fast`.
  3. `record_fallback` ghi vào `<dataRoot>/telemetry/gaps.jsonl`.
  4. `cockpit_scan` chạy live trên `rog-bike.myharavan.com` trả `ok: true`.
- **Non-goals:** P1/P2 ở §5; tách monolith.

## 8. Câu hỏi còn mở

- Navigation thứ hai làm abort `cockpit_scan` trên rog-bike là gì: redirect bằng JS, preview `themeid`, hay tracker isolation? Cần bật trace `did-start-navigation` trong lúc chạy một lần scan.
- App sống đã nạp `1e7ebab3` chưa? `main.log` có 11 `boot.start` trong 13 giây lúc 16:36, khả năng cao là test chứ không phải restart thật `[INFERENCE]`.
- Chính sách §3.1 (AntiFan trước, Playwright sau, bắt buộc `record_fallback`) có áp cho repo theme / project khác không? Hiện nó chỉ nằm trong `AGENTS.md` của repo AntiFan. MULTI (F1GENZ Multipage) dùng Playwright 22 lần là hợp lệ nếu chính sách không áp ở đó.
- Có cần cho người dùng cấp quyền tab chéo project, hay giữ cách ly tuyệt đối? Đây là quyết định sản phẩm.
