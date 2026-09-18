# Scout Report — hợp nhất đã kiểm chứng

> Nguồn: 5 ứng viên A–E (ẩn danh) + kiểm chứng độc lập của verifier. Mọi anchor ghi trong báo cáo này đã được verifier TỰ MỞ (read/grep) trên file gốc; nội dung khớp chính xác, chỉ số dòng có thể lệch ±1–2. Tiền tố đường dẫn: `A-` = `C:\Users\Admin\.omp\agent\sessions\--E--Work-customizes-Comnieusiba--\`, `B-` = `C:\Users\Admin\.omp\agent\sessions\--E--Work-customizes-Bagamuioto--\`. Snapshot ≈ 2026-09-18T10:50–10:57Z (packet `generatedAt` = 10:57:05.162Z). Mốc '03:50Z' mà 4/5 ứng viên (B, C, D, E) lặp lại là NHẦM quy đổi UTC+7; chỉ ứng viên A bác đúng.

## Corpus (19/19)

### Comnieusiba (14)

**A1** `A-2026-09-16T07-12-33-741Z_01a0a90f-65cd-743e-9282-f339ecfd02c0.jsonl` | 09-16 07:12Z | 7.6–7.9MB / 2481 record | title `Comnieusiba Fresh Theme Execution Setup`
**Role:** trích `Issue.xlsx` → manifest (sheet-to-spec), mở goal-mode `/ak:cook --auto --parallel --advice Triển khai full Phase`, clone HTML `comnieuthienly.com`, đo Visual Compare.
**Outcome:** **ABORTED do signal** — `session_exit {"reason":"sighup","kind":"signal","recordedAt":"2026-09-16T08:00:23.419Z"}` ngay sau capture timeout, rồi `stopReason:"aborted", errorMessage:"Operation aborted"`; ngân sách goal ghi `tokensUsed 3689133 / timeUsedSeconds 1670` (bản đầy đủ hơn: `goal-completed` @08:11:23.987Z ghi **4143384 token / 2183 s** → số 3.69M của các ứng viên là số trung gian, KHÔNG sai nhưng chưa phải tổng).
**Anchors (đã kiểm chứng):** `Error: EXECUTION_TIMEOUT: Page.captureScreenshot (viewport) on tab 'e16165cc-…': CDP command Page.captureScreenshot timed out after 25000ms` @08:00:19.750Z · `"Dự án này dùng settings.html, ko dùng settings_schema.json nhé"` @07:49:12.712Z (steering) · `"Kiểm tra kĩ lại storefront dùm cái, ko giống ref gì cả"` @08:12:36.998Z.

**A2** `A-2026-09-16T08-35-08-046Z_01a0a95a-fe8e-7293-b7cd-2aec2e9cf29a.jsonl` | 09-16 08:35Z | 686B / 4 record | title rỗng
**Role:** không có.
**Outcome:** **stub aborted-at-birth**.
**Anchor (đọc raw toàn file):** chỉ `title` (rỗng) + `session` (cwd Comnieusiba) + `thinking_level_change` + `service_tier_change`; KHÔNG có record `message` nào.

**A3** `A-2026-09-16T11-17-02-525Z_01a0a9ef-39bd-75d6-9297-9e811b2063de.jsonl` | 09-16 11:17Z → 09-17 | 33.7–35.3MB / 11294 record | title `Process All Required Routes`
**Role:** chạy `antifan-dogfood-clone` (clone 9 route + visual compare 3 viewport), giữa phiên chuyển sang **sửa source AntiFan Core** rồi QA sweep storefront.
**Outcome:** **không có session_exit ở đuôi** (đuôi là advisor + todo HUD); QC report dừng ở `INCONCLUSIVE`; nhánh 'fix MCP AntiFan' chưa xác minh xong. **Lưu ý tải file: file này chứa `session_exit` GIỮA FILE rồi resume — xem anchor.**
**Anchors (đã kiểm chứng):** `session_exit sighup @2026-09-16T16:22:37.935Z` (:577) và `session_exit sighup @2026-09-17T02:28:06.358Z` kèm `pendingToolCalls` (:607), resume `"Khởi chạy lại đo Visual Compare thử"` @02:26:14Z · `stopReason:error "Thinking loop detected: the model repeated near-identical content (repeated an exact 191-character cycle 6× back-to-back)"` @03:29:11.006Z + `thinking-loop-redirect` (:982) · `"Tạm ngưng, tìm hướng fix các MCP trên cho hoàn thiện vào AntiFan Core đi đã, lưu ý kĩ là fix tới khi hoạt động"` @2026-09-17T03:54:38.374Z (:1180) · `edit E:/Work/apps/AntiFan/src/main/tools/browser-capabilities.ts` (guard `confineWorkspaceRoot` cho `dump_dom`) @04:05:48.605Z.

**A4** `A-2026-09-18T04-30-22-963Z_01a0b2c7-a2f3-7404-9774-8443b0ad053c.jsonl` | 09-18 04:30Z | 20.6–21.6MB / 3211 record | title `Làm lại Comnieusiba theo mẫu`
**Role:** làm lại theme theo mẫu (hrv CLI product sync, nhiều subagent song song), cập nhật settings.
**Outcome:** chết vì lỗi hạ tầng (xem (a)); không có bàn giao sạch.
**Anchors (đã kiểm chứng):** `"Lưu ý Chỗ này là Product chứ ko phải render cứng, dùn hrv cli cập nhật lại sản phẩm đem ra cho phù hợp @.antifan/annotations/element_1789706009908.md"` @04:33:30.252Z · `CAPTURE_TIMEOUT … timed out after 8000ms` từ `theme_qa_validate` @05:13:50.636Z · **bug harness**: `No such tool: xd://mcp__mcp__antifan_browser_anti_browser_tabs_list` (tiền tố `mcp__` nhân đôi) @05:13:58.655Z.

**A5** `A-2026-09-18T06-12-29-818Z_01a0b325-1ffa-75ed-bb03-4ca293d2d9c9.jsonl` | 09-18 06:12Z | 7.4–7.8MB / 928 record | title `Check reference for missing backgrounds`
**Role:** sửa lỗi `&nbsp;`/`&amp;nbsp;` double-encode, khôi phục iframe video homepage, kiểm kê background thiếu.
**Outcome:** **bị giết giữa tool**: record cuối là `tool_execution_start` gọi `xd://mcp__antifan_browser_theme_qa_validate` @2026-09-18T07:18:04.329Z và **không bao giờ có toolResult**; cổng QA treo ở `QA GATE PENDING`. (Tiểu mục video có `VERIFIED_COMPLETE` — nhưng đó không phải kết cục phiên.)
**Anchors (đã kiểm chứng):** `Error: CAPTURE_TIMEOUT: Page.captureScreenshot (viewport) on tab '5f77e019-…': CDP command Page.captureScreenshot timed out after 8000ms` **kèm ngay trong cùng toolResult** `[theme-qa-gate] QA GATE PENDING — theme file(s) under E:\Work\customizes\Comnieusiba were edited without a fresh AntiFan QA receipt…` @06:19:54.276Z (:90) · eval `normalized= 18 / stale= 0 / literal_nbsp= 20 double_encoded= 18` @06:19:54.805Z (:92) · evaluate với `paneId:"desktop"` nhưng trả `{"url":"https://com-nieu-siba.myharavan.com/?device=mobile",…}` @07:17:59.604Z (lỗi định tuyến pane).

**A6** `A-2026-09-18T06-23-57-161Z_01a0b32f-9ce9-7723-9c6e-ef3c56ed7c31.jsonl` | 09-18 06:23Z | 4.8–5.1MB / 964 record | title `Check booking page ref settings_schema`
**Role:** rà trang Đặt bàn theo ref + `settings_schema.json`, wire menu, probe asset live.
**Outcome:** dừng đột ngột sau probe asset 404; user trong phiên này ra **lệnh cấm MCP**. Ứng viên D còn nêu '32 mismatch / 12 thiếu id' làm đầu vào cho A7 — verifier KHÔNG kiểm chứng được → xem mục 'Chưa kiểm chứng'.
**Anchors (đã kiểm chứng):** `Backgrounded as job bg_21; result will be delivered automatically.` @07:03:11.217Z rồi `"Mày đang làm cc gì mà lâu vậy?"` @07:03:11.246Z — **cách nhau 29 ms** (đúng như ứng viên B đo).

**A7** `A-2026-09-18T06-36-28-815Z_01a0b33b-150f-7796-8431-4af864cf5c74.jsonl` | 09-18 06:36Z | 5.6–5.8MB / 890 record | title `Move all settings_schema.json to settings.html`
**Role:** migrate toàn bộ schema → `config/settings.html`, ghi rule cứng dự án.
**Outcome:** migration chạy nhưng mở màn cho chuỗi churn settings A8→A14; phiên kết thúc đột ngột.
**Anchors (đã kiểm chứng):** `"Move toàn bộ settings_schema.json sang settings.html nhé\nNote lại rule cứng toàn bộ dự án này là ko dùng settings_schema.json nữa"` @06:36:52.992Z (ứng viên ghi :5, thực tế **:6**) · `Backgrounded as job bg_26` @07:11:21.453Z rồi `"Vẫn 2 cái settings?? [Image #1, 1310x594] Tao kêu mày xóa bớt đi mà?"` @07:11:21.505Z.

**A8** `A-2026-09-18T07-30-07-284Z_01a0b36c-3134-76b7-9028-f80ce75b476d.jsonl` | 09-18 07:30Z | 4.9–5.2MB / 1209 record | title `Viết lại settings.html cho ba trang`
**Role:** viết lại `config/settings.html` theo 3 trang bằng đội subagent map→assemble→apply.
**Outcome:** **DELIVERED** — `todo 9/9 done`; QA live PASS 0 issue, `qaMatrix` điểm 99, verdict `INCONCLUSIVE` **chỉ vì thiếu baseline đa viewport trước push**. (Ứng viên A mô tả yếu hơn; D mô tả như 'đang chạy'. Phiên bản C/E được lấy.)
**Anchors (đã kiểm chứng):** `Todo 9/9 done… QA theme Haravan (live) → **PASS**, 0 issue, differential.introducedRegressions: [] … qaMatrix điểm 99` @08:14:56.522Z · `401 Incorrect API key provided: sk-hTjlJ***S8Dt` **×2** @07:32:35.573Z và @07:32:43.423Z.

**A9** `A-2026-09-18T08-04-24-764Z_01a0b38b-963c-76bd-98f2-06c8a9d55c3b.jsonl` | 09-18 08:04Z | 12.0–12.6MB / 2020 record | title `Redo 6 groups, check backup` → title_change `Add whitespace trigger save centering` @08:22:40Z
**Role:** sửa hình học band trang chủ (`assets/siba-homepage.scss.liquid`), bị user cấm dùng AntiFan MCP giữa phiên, cuối phiên đối chất 3 cây settings.
**Outcome:** **kết thúc bằng QUYẾT ĐỊNH ROLLBACK** — khôi phục cây 6 nhóm từ backup @09:43:40.590Z. (Chỉ B và C ghi đúng; A, D, E bỏ sót → bị hạ cấp.)
**Anchors (đã kiểm chứng):** `Error: POLICY_DENIED: Browser tab '4857354d-…' could not be adopted into session '3286c830-…' (browser tab quota reached); the tab was closed instead of leaking outside the session` @08:20:36.301Z → ngay sau đó `"Lưu ý không chạy AntiFan MCP nữa nhé"` @08:20:36.343Z (steering) → `"…làm đúng yêu cầu rồi ngưng"` @08:20:54.646Z · `"Vẫn chưa thấy canh giữa, thêm whitespace trigger save đi"` @08:22:37.619Z → `edit … +1844|` (thêm **dòng trắng** vào cuối file) @08:22:52.391Z · `"Menu sát lại, các nhóm đầu sao không thấy sản phẩm vậy? Thiếu backgroudn nền …"` @08:23:44.077Z · `CAPTURE_NOT_READY: Pre-capture quiescence predicate 'imagesSettled' failed … Detected 4/6 pending image(s) still loading` @08:10:23Z / 08:10:27Z / 08:13:10.094Z (:201/204/241) · `CAPABILITY_ERROR: Evaluation timed out after 15000ms (note: requestAnimationFrame pauses in background tabs)` (:244) · `NO_RENDER_SURFACE: Tab '11ef1577…' pane 'desktop' cannot rasterize a viewport capture: its view is not attached to a window…` (:237) · CDN polling `v1785=0 … | attempt 5` (:234/238) và kết luận của agent: *"the theme is being pushed repeatedly (the CLI watcher is active), and each push changes the `?v=` on every asset URL, which invalidates in-flight image requests and restarts the downloads. That's why `imagesSettled` never passes: a moving target."* (:262) · một lần QA **PASS thật** (`summary.passed: true, criticalCount: 0`, override đang áp trong RAM) @08:14:30.153Z (:270) — tức A9 có 1 receipt hợp lệ trước khi mất; sau đó override biến mất khi gate chạy (:283) · so sánh 3 cây: `BK reorg tags=2286 … fieldset=60` vs `CUR config tags=3650 … fieldset=109` @09:43:29.569Z và `Decision: restore the 6-group tree from the backup (newest 6-group content, with the 3 preview blocks)…` @09:43:40.590Z (:2020), kèm phát hiện **mất control**: *"the 5 social/chat link controls are in CUR group 10.3, not in the footer group … they are absent from the 6-group tree entirely"*.

**A10** `A-2026-09-18T08-05-39-516Z_01a0b38c-ba3c-7727-af64-c29311190d5f.jsonl` | 09-18 08:05Z | 0.9MB / 291 record | title rỗng, 1 user turn
**Role:** bỏ nút 'Chọn món ăn' ở `/pages/dat-ban`, tìm link Google Sheet, kiểm chứng `hrv theme dev` có push hay không.
**Outcome:** **local-only, chưa push** + phát hiện **phiên khác đang ghi cùng repo**.
**Anchors (đã kiểm chứng):** `"Bỏ nút này, đưa link Google Sheet đâu? @.antifan/annotations/element_1789718776867.md"` @08:06:17.223Z (:5) · `REMOTE snippet hash (manifest 15:16:21): f6c7137c (bản cũ) -> chưa push` @08:20:28.870Z · *"`_verify/tmp` now contains files I didn't create … another session is writing there too … Confirms another session is working in this repo right now."* @08:20:38.816Z (:291).

**A11** `A-2026-09-18T08-12-32-970Z_01a0b393-094a-75b8-8c23-dd4b2dddbc68.jsonl` | 09-18 08:12Z | 18.4–19.3MB / 2116 record | title `Reorganize homepage settings.html for clarity`
**Role:** tải/đặt tên/up asset background thiếu theo ref, rồi `hrv cli` tạo blog article + cập nhật settings.html.
**Outcome:** **BLOCKED có tuyên bố chính thức** (thiếu QA AntiFan); đuôi file dừng giữa retry `theme_qa_validate`.
**Anchors (đã kiểm chứng):** `**BLOCKED — implementation complete; authoritative AntiFan QA unavailable.**` @08:37:03.279Z (:518) · `verify-settings.py` báo `bytes 167315 / controls 642 / groups_top_level [1..12]` @08:36:56.085Z.

**A12** `A-2026-09-18T08-28-50-554Z_01a0b3a1-f3fa-7511-b5d7-6a00372ce9fa.jsonl` | 09-18 08:28Z | 4.2–4.4MB / 1042–1168 record | title `Bỏ note sửa ảnh nền` (trước: `Hoàn thiện trang đặt bàn`)
**Role:** skill `google-form-sheet` tạo Google Form + Sheet đặt bàn, chèn link vào `settings.html` nhóm 4.3, fix `.siba-booking-error`, Playwright khi user yêu cầu.
**Outcome:** **BLOCKED — live chưa nhận source fix** (revision 1853).
**Anchors (đã kiểm chứng):** `**BLOCKED — bản live hiện tại vẫn chưa nhận source fix.**` + `{"asset": "siba-clone-interactivity.js?v=1853", "pickerCount": 0, …}` @09:18:48.168Z (:972) · **ngay sau đó** harness tiêm `skill-prompt` của skill `haravan-preview-screenshot` *(nội dung: "F1GENZ uses settings_schema.json and must not create/update settings.html")* — mâu thuẫn trực tiếp với rule cứng của chính dự án (xem (c)).

**A13** `A-2026-09-18T09-43-45-083Z_01a0b3e6-88bb-7541-b122-761194bc1b5d.jsonl` | 09-18 09:43Z | 0.23MB / 67 record | title rỗng, 2 user turn
**Role:** điều tra drift `settings.html` 'tự nhiên thành 12 nhóm' + kiểm backup folder.
**Outcome:** **bị ngắt giữa dòng**; sau đó trượt sang việc đối chiếu ảnh theo ref mới (annotation @09:47:54Z) rồi bị bỏ.
**Anchors (đã kiểm chứng):** `"Kiểm tra lại Backup Folder, settings.html tự nhiên thành 12 nhóm"` @09:44:18.638Z (:5) · `53c86f4c6f0482fd1b7b6586af7c33b7fd3091fe3a5a5c259f46052163deb206  config/settings.html` / `169670 config/settings.html` / `109` fieldset @09:44:21.506Z · census **cùng 5 file** @09:44:30.189Z: `config/settings.html controls=642 legends=109 bytes=169670 mtime=2026-09-18 16:41:31` | `backups/…before-homepage-reorg… controls=409 legends=60 bytes=111632 mtime=16:35:36` | `backups/…before-group-prune… controls=644 legends=107 bytes=169270 mtime=16:01:32` · danh sách backup: `settings-html-before-homepage-reorg-2026-09-18.html 109.0KB`, `…before-group-prune… 165.3KB`, `haravan-cli_remote.before-bg-asset-prune.json 63.8KB`, `before-3page-apply/` (settings.html 13.9KB, siba-clone-reservations.liquid 236.3KB, siba-clone-menu.liquid 204.5KB) @09:44:21.425Z.

**A14** `A-2026-09-18T09-48-02-795Z_01a0b3ea-776b-71cb-99a9-87d8291528c8.jsonl` | 09-18 09:48Z | 5.4–5.6MB / 1192–1212 record | title `Plan Slider Five Item Implementation` | **LIVE tại snapshot**
**Role:** sửa bố cục collage theo ref `vuabia.com`, dựng hero slider 5 item, dọn nhóm 3.2/3.3/3.5 và purge Loomline khỏi `settings.html`, cập nhật `AGENTS.md`.
**Outcome:** **đang mở** — fix collage đã lên live (CSS CDN `?v=1885` chứa rule mới), còn việc dọn Loomline + QA gate; phát hiện **writer khác** cùng ghi cây settings.
**Anchors (đã kiểm chứng):** `"3.2, 3.3, 3.5 bị thừa và vô nghĩa, sắp xếp không hợp lý [Image #1, 921x479]"` @10:22:23.840Z (:701) + bảng map group cho thấy `3.2 Loomline · Trang chủ controls=6`, `3.3 Loomline · Cửa hàng controls=2` · `"Còn xót rất nhiều Loomline trong settings.html\nBỏ hết và clean lại settings.html cho sạch sẽ dùm"` @10:24:03.489Z (:750) → async-result `BEFORE: controls 426 subgroups 55 / errors: ['E5'] / W2: W2: 1 control lệch kiểu với settings_data.json …` + `EXPECTED_GROUPS = [ "1. … "12. Tiện ích & Chia sẻ" ]` (:751) · `edit AGENTS.md` @10:20:09.999Z (:640): `Gate đã cập nhật theo cây mới: verify-settings.py (EXPECTED_GROUPS = 6 legend mới; script hiện vẫn khai 12 nhóm ⇒ E5 báo lệch — drift của writer khác, không sửa trong batch hero slider)`, cùng file ghi `644 → 409 control, 95 → 54 nhóm con, 12 → 6 nhóm cấp 1` và `sha256 0bf93b03…`.

### Bagamuioto (5)

**B1** `B-2026-09-15T17-35-45-873Z_01a0a623-98d1-760e-82e9-6f9447ac7abc.jsonl` | 09-15 17:35Z → 09-17 04:39Z | 37.0–38.7MB / 11151 record | title `Haravan Theme Editor Configuration Analysis`
**Role:** dựng/chỉnh theme Bagamuioto + clone 5 trang `roahtrip.com`/`demo-alibaba.vercel.app` dưới `/skill:ak:cook --auto --parallel --advice`, 'dùng Antifan MCP đối chiếu liên tục', max subagent.
**Outcome:** về đích muộn bằng nhánh 'bỏ screenshot, chuyển sang số đo DOM' vì video autoplay của ref phá capture; đuôi @09-17T04:39 có `theme_qa_validate` + tuyên bố `VERIFIED_COMPLETE` (cụm category slider) — **verifier chỉ kiểm chứng được mốc capture/goal, không mở phần đuôi**.
**Anchors (đã kiểm chứng):** goal objective nguyên văn `… đảm bảo toàn bộ yêu cầu được thực thi 100% và hoạt động hoàn hảo trên Storefront Haravan\nCho phép spawn max subagents nếu cần, cho phép can thiệp settings_data.json, **đã tự chạy lệnh Hrv theme dev**` @19:01:49.209Z · `Error: CAPTURE_TIMEOUT: Page.captureScreenshot (viewport) on tab 'bd27a867-…': CDP command Page.captureScreenshot timed out after 25000ms | CAPTURE_TIMEOUT: capture did not settle: tab has 1 playing media element(s) (video). Remedy: anti.media.freeze(tabId) then retry.` @19:01:49.211Z (:1453) → agent gọi `anti.media.freeze` → `{"frozen":true,"mediaCount":2,…}` @19:01:58.105Z.

**B2** `B-2026-09-17T06-20-24-218Z_01a0ae06-011a-7174-8e3e-586905f2a149.jsonl` | 09-17 06:20Z | 34.5–36.2MB / 7534 record | title `QA action, motion, state, UX/UI`
**Role:** dựng lại search overlay + account popup theo ref, xử lý annotation UX/UI, rồi bị đẩy sang điền cột Dev-note của Google Sheet feedback.
**Outcome:** phần popup có số đo live + ảnh headless xác nhận, nhưng **không có exit sạch**, đuôi là advisor; kèm phát hiện push hỏng (xem (b)).
**Anchors (đã kiểm chứng):** `[Error] Our servers are currently overloaded. Please try again later.` (provider `9router`, model `cx/gpt-5.6-luna`) @07:04:01.869Z (:914) → `"Tiếp đi"` @07:05:49.433Z (:915) · `.hrv-sync-state.json` `{"updatedAt":"2026-09-16T10:45:45.012Z", "failed":[{"key":"assets/__hrv_dev_probe__.txt","operation":"delete","reason":"checkFilePush returned false"…}]}` @06:37:02.817Z (:403) + thinking @06:37:14.228Z: *"The last recorded push failed for `config/settings.html` (processingPushFile returned false) — … push FAILED on 2026-09-16T10:45"* · **phát hiện verifier bổ sung (chỉ có trong lượt này):** tồn tại `schema-fragments/generate-settings-html.py` — *"Sinh khoi live cua `config/settings.html` TU `config/settings_schema.json`"*, đã xác minh `21 <legend> ngoài comment == 21 tên nhóm panel` @07:00:32.162Z (:805) → Bagamuioto dùng **settings_schema.json làm nguồn duy nhất**, ngược hoàn toàn với rule cứng của Comnieusiba (xem Cross-Project).

**B3** `B-2026-09-18T06-19-29-784Z_01a0b32b-8878-7497-8a01-b01a8b52347b.jsonl` | 09-18 06:19Z | 3.4–3.6MB / 875 record | title `Debug Haravan storefront issue 197`
**Role:** `ak:debug` issue 197 (khoảng cách/nút hero), fix + `node --check`, rồi định tự điền Dev-note vào Google Sheet feedback.
**Outcome:** fix đã áp nhưng **QA không thể đạt** (CAPTURE_TIMEOUT 8 s lặp 06:24→09:17Z); user huỷ yêu cầu sheet; phiên **đóng bằng `session_exit dispose`**.
**Anchors (đã kiểm chứng):** `Error: CAPTURE_TIMEOUT: Page.captureScreenshot (viewport) on tab '18e622a5-…': CDP command Page.captureScreenshot timed out after 8000ms` @06:24:38.876Z (:123) · `session_exit {"reason":"dispose","kind":"normal","recordedAt":"2026-09-18T09:27:53.867Z"}` + `stopReason:"aborted", errorMessage:"Request was aborted"` (:875).

**B4** `B-2026-09-18T09-27-57-707Z_01a0b3d8-140b-7048-b79c-f89e0a4c245e.jsonl` | 09-18 09:27Z | 2.1–2.2MB / 395 record | title `Update Caption Styles and Assets`
**Role:** caption UGC bỏ nền + thay asset theo ref, chỉnh newsletter/footer theo ref.
**Outcome:** **dừng ở lỗi đọc annotation** — record cuối (file 395 dòng) là `read` `isError:true`: `Path 'E:/Work/customizes/Bagamuioto/.antifan/annotations/element_1789724334940.md' not found` @10:06:32.983Z. **Ứng viên C khẳng định 'B4 vẫn active lúc 10:48:11' là SAI và đã bị loại.**
**Anchor (đã kiểm chứng):** record cuối nêu trên; các mốc `TARGET_MISMATCH` / `CAPTURE_NOT_READY` trong thân phiên **chưa kiểm chứng** (xem danh sách loại).

**B5** `B-2026-09-18T10-15-49-653Z_01a0b403-e695-7426-9456-9b4152b8c583.jsonl` | 09-18 10:15Z | 1.9–2.0MB / **539 record tại thời điểm verifier đọc** (ứng viên đọc sớm hơn: 471/479) | title `Why HRV Theme Dev Undetected` | **LIVE**
**Role:** fix bug quickview 'click nào cũng add cart' (`target.closest('[data-bg-qv-add]')` bắt từ mọi descendant của modal root), bổ sung icon MXH footer, đối chiếu collection hero, chẩn đoán vì sao `hrv theme dev` không bị phát hiện.
**Outcome:** root-cause tìm ra và áp ở source; **toàn bộ verify live bất khả thi vì MCP chết** ⇒ `QA_UNAVAILABLE`.
**Anchors (đã kiểm chứng):** `MCP failure / server: antifan-browser / tool: anti.browser.tabs.list / transport: unknown / stage: connect / failure: connect / retryable: yes / message: MCP server not connected: antifan-browser` @10:18:08.351Z (:50), retry vẫn fail @10:18:41.814Z · `"ưu ý sửa trực tiếp các folder Storefront Haravan nhé"` @10:18:08.402Z · `"Tao tự chạy hrv theme dev rồi mà, sao mày ko bắt được à?"` @10:28:15.498Z (:258) → `title_change → "Why HRV Theme Dev Undetected"` @10:28:17.845Z, kèm bằng chứng agent chỉ thấy PID `42172`/`12004` và `.hrv-sync-state.json` mtime `2026-09-17 17:06:15 +0700` @10:28:26.480Z.

## Findings

### (a) MCP / tool hang, timeout, retry, mã lỗi

1. **MCP transport chết hẳn (khác timeout)** — `stage: connect … MCP server not connected: antifan-browser`, `retryable: yes`: xác thực ở **B5** 10:18:08.351Z và 10:18:41.814Z (B5:50, :55). Retry không tự hồi phục; agent phải hạ cấp sang phân tích tĩnh và người dùng chất vấn (`"AntiFan MCP đâu ko dùng?"` — ứng viên A/C/D/E dẫn B5:78, verifier chưa mở riêng dòng này nhưng cùng cụm record đã kiểm chứng).
2. **Timeout capture CDP hai mức:** `EXECUTION_TIMEOUT … timed out after 25000ms` — A1 @08:00:19.750Z và B1 @19:01:49.211Z (kèm chẩn đoán `1 playing media element (video)` + `Remedy: anti.media.freeze`); `CAPTURE_TIMEOUT … after 8000ms` — A5 @06:19:54.276Z, A4 @05:13:50.636Z, B3 @06:24:38.876Z.
3. **Cổng QA bị cưỡng chế ở tầng harness:** cùng một toolResult chứa lỗi capture **và** `[theme-qa-gate] QA GATE PENDING — theme file(s) under … were edited without a fresh AntiFan QA receipt. Before reporting done: run theme.qa_validate …` — A5 @06:19:54.276Z (và A9 @08:06:34.189Z). Hệ quả: khi MCP hỏng, pipeline theme bị chặn cứng.
4. **Chạm trần tài nguyên/tab:** `POLICY_DENIED … (browser tab quota reached); the tab was closed instead of leaking outside the session` — A9 @08:20:36.301Z.
5. **Capture không bao giờ 'settle' vì watcher đẩy liên tục:** A9 `CAPTURE_NOT_READY … 'imagesSettled' failed … 4/6 pending image(s)` (:201/204/241) + nguyên nhân do agent tự tìm ra: mỗi lần push, `?v=` của mọi asset đổi → request ảnh đang bay bị vô hiệu → *"a moving target"* (:262). Đây là **cơ chế**, không chỉ là triệu chứng — chỉ ứng viên D nêu gần đúng (dẫn A9:241), phần '(moving target)' là verifier bổ sung.
6. **Lỗi định tuyến pane/tab:** A5 evaluate với `paneId:"desktop"` trả URL `?device=mobile` @07:17:59.604Z (lỗi thật, không phải suy luận của agent); A9 `TARGET_MISMATCH: Tab ID mismatch: expected 11ef1577…, got 967fbab8-…` @08:05:27.108Z; A9 `NO_RENDER_SURFACE … view is not attached to a window, so the compositor produces no surface` (:237/48).
7. **Bug harness (đường dẫn tool):** `No such tool: xd://mcp__mcp__antifan_browser_anti_browser_tabs_list` — A4 @05:13:58.655Z (tiền tố `mcp__` nhân đôi).
8. **Hạ tầng model/provider (cùng họ 'treo'):** `401 Incorrect API key provided: sk-hTjlJ***S8Dt` ×2 — A8 @07:32:35.573Z & @07:32:43.423Z; `[Error] Our servers are currently overloaded…` — B2 @07:04:01.869Z; `Thinking loop detected … exact 191-character cycle 6× back-to-back` + `thinking-loop-redirect` — A3 @03:29:11.006Z.
9. **Chờ CDP thủ công:** `sleep 10` @A3 02:28:06Z (bị abort giữa chừng); các ứng viên còn dẫn `sleep 12/15/30` — verifier chưa mở riêng các dòng đó.

### (b) Regression / vòng fix–break / rollback / backup

1. **`config/settings.html` bị đập đi xây lại nhiều lần trong một ngày (12 ↔ 6 nhóm).** Census cùng 5 file ở A13 @09:44:30.189Z: `config/settings.html` **642 control / 109 legend / 169670 B / mtime 16:41:31 / sha 53c86f4c…**; backup `before-homepage-reorg` **409 control / 60 legend / 111632 B / 16:35:36 / sha ba3fc581…**; backup `before-group-prune` **644 control / 107 legend / 169270 B / 16:01:32**. → bản 'sạch hơn' (409) tồn tại 6 phút rồi **bị ghi ngược về 12 nhóm**, đúng như người dùng báo ở A13:5.
2. **Prune 6 nhóm làm MẤT control thật (regression chức năng):** A9 (:2020 vùng) — *"the 5 social/chat link controls are in CUR group 10.3, not in the footer group … they are absent from the 6-group tree entirely"*; đồng thời A14 ghi nhận `errors: ['E5']` + `W2: 1 control lệch kiểu với settings_data.json: ['shop_buying …`.
3. **Rollback thật đã xảy ra:** A9 kết phiên bằng `Decision: restore the 6-group tree from the backup (newest 6-group content, with the 3 preview blocks)…` @09:43:40.590Z.
4. **Gate tự mâu thuẫn với cây mới:** A14 `edit AGENTS.md` @10:20:09.999Z — `EXPECTED_GROUPS` trong `verify-settings.py` vẫn khai 12 nhóm trong khi cây đã prune còn 6 ⇒ `E5`; agent gán cho *'drift của writer khác'*. Bằng chứng file (`EXPECTED_GROUPS = ["1. …"12. Tiện ích & Chia sẻ"]`) tái xác nhận qua async-result ở A14:751.
5. **Fix 'đã xong' nhưng live không đổi — và cách chữa là chọc watcher bằng whitespace:** A9 `"Vẫn chưa thấy canh giữa, thêm whitespace trigger save đi"` @08:22:37.619Z → `edit … +1844|` (chèn dòng trắng cuối file) @08:22:52.391Z. Cùng mẹo xuất hiện ở Bagamuioto (B5 `"Tôi chạy haravan theme dev rồi, thêm whitespace trigger save đi"` — ứng viên B/D/E dẫn B5:274; verifier đã xác thực mốc 10:28:15Z của cùng cụm nhưng không mở riêng dòng 274).
6. **Local sửa mà remote không nhận:** A10 `REMOTE snippet hash (manifest 15:16:21): f6c7137c (bản cũ) -> chưa push` @08:20:28.870Z; A12 `BLOCKED … live revision 1853` + `pickerCount: 0` @09:18:48.168Z.
7. **Push hỏng ghi nhận trong state file (Bagamuioto):** B2 `.hrv-sync-state.json → failed[] … checkFilePush returned false` @06:37:02.817Z + kết luận *"`config/settings.html` push FAILED on 2026-09-16T10:45"* @06:37:14.228Z.
8. **Ghi song song trên cùng repo (nguyên nhân gốc của 'drift'):** A10 *"another session is working in this repo right now"* @08:20:38.816Z; A14 `EXPECTED_GROUPS` bị writer khác đổi ngược; A13 audit cho thấy thủ phạm là một writer khác chứ không phải generator (`generator writes only to opts.out` — theo ứng viên C, verifier không mở riêng dòng này).
9. **A8 là điểm sáng duy nhất có QA PASS thật:** `todo 9/9 done` + `theme.qa_validate` PASS 0 issue @08:14:56.522Z — rồi vẫn bị cuốn vào churn A9→A14. **Bài học: 'delivered + PASS' không bảo toàn được vì writer song song.**
10. **B4 tự tuyên bố hoàn tất 2 lần nhưng receipt QA không đạt** (ứng viên C/D/E) — verifier chỉ xác thực được record cuối là lỗi đọc annotation @10:06:32.983Z; phần '2 lần VERIFIED_COMPLETE + CAPTURE_NOT_READY' **chưa kiểm chứng** → xem danh sách loại.
11. **Sự cố mất dữ liệu '1280 dòng legacy' của Bagamuioto** (ứng viên D và E độc lập báo) — **verifier không tìm thấy trong 4MB đầu của B2** → loại khỏi union.

### (c) Knowledge drift / giả định sai bị user (hoặc harness) sửa

1. **Đường cấu hình theme lệch giữa các phiên — cùng một ngày, hai quy ước trái ngược:** 09-16 A1 được nhắc *"Dự án này dùng settings.html, ko dùng settings_schema.json nhé"* @07:49:12.712Z → 09-18 06:23 A6 **lại được mở bằng chính câu hỏi kéo về `settings_schema.json`** (ứng viên A/C/D/E dẫn A6:5) → 06:36 A7 mới có rule cứng @06:36:52.992Z → và cùng lúc **Bagamuioto vẫn dùng generator `settings_schema.json → settings.html`** (B2 @07:00:32.162Z, verifier phát hiện). Đây là mâu thuẫn xuyên dự án rõ nhất.
2. **Harness tiêm skill mâu thuẫn với rule dự án:** ngay sau A12 `BLOCKED` @09:18:48.168Z, `skill-prompt` của `haravan-preview-screenshot` được chèn với nội dung *"F1GENZ uses settings_schema.json and must not create/update settings.html"*. B2 cũng trích lại chính câu này @06:37:14.228Z. → Rule cứng của job bị phủ định bởi skill ở tầng harness.
3. **Tàn dư tên theme gốc 'Loomline' rò vào nhãn cấu hình merchant:** A14 @10:22:23.840Z (`3.2, 3.3, 3.5 bị thừa và vô nghĩa`) với bảng map chỉ ra `3.2 Loomline · Trang chủ` (6 control), `3.3 Loomline · Cửa hàng` (2 control); và @10:24:03.489Z *"Còn xót rất nhiều Loomline trong settings.html"*. Cùng họ ở A13: legend liệt kê `2.4 Loomline · Header` … `2.8 Loomline · Ngôn ngữ`.
4. **Giả định 'render cứng' bị sửa:** A4 @04:33:30.252Z *"Chỗ này là Product chứ ko phải render cứng, dùn hrv cli cập nhật lại sản phẩm"*.
5. **Giả định 'MCP không cần thiết / tự viết harness' bị user bác:** B5 — user hỏi *"AntiFan MCP đâu ko dùng?"* (ứng viên dẫn B5:78) và sau đó *"Tao tự chạy hrv theme dev rồi mà, sao mày ko bắt được à?"* @10:28:15.498Z (verifier xác thực) — agent không phát hiện watcher của user.
6. **Chỉ số dòng 'drift' do công cụ:** A9 `CAPTURE_NOT_READY`/`CAPABILITY_ERROR: requestAnimationFrame pauses in background tabs` (:244) và `?device=mobile` khi yêu cầu desktop (A5 @07:17:59.604Z) — agent kết luận sai về môi trường nhiều lần trước khi tìm ra cơ chế.
7. **Chỉ số lớn bị đọc sai (tự sửa):** ứng viên B dẫn A6 thinking *"Two corrections: 1. `config/settings_data.json` EXISTS (338.7KB, 2m ago). My earlier hash script said 'local (absent)'"* — **chưa kiểm chứng** → xem danh sách loại.

### (d) Slowness

1. **Ngân sách phiên phình:** A1 goal `tokensUsed 3689133 / 1670 s` @08:00:19.732Z, và `goal-completed` ghi **4143384 token / 2183 s** @08:11:23.987Z — ~4.14M token cho một lượt goal tự động.
2. **Nén context lặp lại:** A1 `compaction` @08:02:46Z và @08:16:08Z (ứng viên A/C dẫn hai mốc); A3 compaction @2026-09-17T03:27:05.313Z (verifier xác thực ngay trước thinking-loop @03:29:11Z); A9 compaction @08:14:50.257Z.
3. **Lệnh dài bị đẩy nền liên tục — và người dùng phản ứng trong 29 ms:** A6 `bg_21` @07:03:11.217Z → `"Mày đang làm cc gì mà lâu vậy?"` @07:03:11.246Z; A7 `bg_26` @07:11:21.453Z; A9 `bg_9`/`bg_23`; A10… (verifier xác thực A6, A7).
4. **Đọc lại cùng một file lớn:** ứng viên B đếm 6 `read.log` cùng kích thước 113.5–148.3KB (A5) và 5 log trùng 20.7KB (B1) — **chưa kiểm chứng**.
5. **Vòng lặp không tiến:** A3 thinking-loop @03:29:11.006Z; B1 sibling `LiquidReviewer` (380 ký tự ×3) — phần B1 chưa kiểm chứng.
6. **Chờ vô ích:** A9 dò CDN 5 lần `v1785=0 … | attempt 5` @08:12:46Z (:234) trước khi kết luận đúng; và QA gate bị gọi lại nhiều lần vì ảnh chưa settle (:201→:270).

### (e) Trích dẫn bực bội của người dùng (verbatim, có mốc)

Bảng dưới chỉ gồm câu **verifier đã tự đọc nguyên văn**.

| # | Thời điểm (UTC) | Anchor | Trích dẫn verbatim | Ngòi nổ |
|---|---|---|---|---|
| 1 | 2026-09-18T10:43:15.045Z | file thứ 20 (xem Cross-Project #1) | `--ultra Đọc tất cả các chat session OMP liên quan tới Comnieusiba và Bagamuioto / Hôm này đúng thất vọng, làm việc siêu chậm, kiến thức lệch tùm lum, gọi MCP treo, chỉnh chỗ này sai chỗ kia, nói chung từa lưa hết về AntiFan` | tổng hợp cuối ngày; **có anchor thật** — xem Cross-Project #1 |
| 2 | 2026-09-16T08:12:36.998Z | A1 | `Kiểm tra kĩ lại storefront dùm cái, ko giống ref gì cả` | ngay sau capture timeout 25 s và goal chạy 3.69M token |
| 3 | 2026-09-18T07:03:11.246Z | A6:710 | `Mày đang làm cc gì mà lâu vậy?` | 29 ms sau khi `bash` bị đẩy nền (`bg_21`) |
| 4 | 2026-09-18T07:11:21.505Z | A7:605 | `Vẫn 2 cái settings?? [Image #1, 1310x594] Tao kêu mày xóa bớt đi mà?` | agent vừa chạy `bg_26`, nhóm cấu hình trùng còn nguyên |
| 5 | 2026-09-18T08:20:36.343Z | A9 | `Lưu ý không chạy AntiFan MCP nữa nhé` | ngay sau `POLICY_DENIED` hết quota tab (08:20:36.301Z) |
| 6 | 2026-09-18T08:20:54.646Z | A9 | `Lưu ý không chạy AntiFan MCP nữa nhé, làm đúng yêu cầu rồi ngưng` | agent tiếp tục thử capture sau lần cấm thứ nhất |
| 7 | 2026-09-18T08:22:37.619Z | A9 | `Vẫn chưa thấy canh giữa, thêm whitespace trigger save đi` | fix đúng source nhưng không lên live (watcher không tự đẩy) |
| 8 | 2026-09-18T08:23:44.077Z | A9 | `Menu sát lại, các nhóm đầu sao không thấy sản phẩm vậy? Thiếu backgroudn nền` | hồi quy hiển thị sau loạt sửa liền trước |
| 9 | 2026-09-18T09:44:18.638Z | A13:5 | `Kiểm tra lại Backup Folder, settings.html tự nhiên thành 12 nhóm` | cây cấu hình bị ghi ngược (drift đa writer) |
| 10 | 2026-09-18T10:22:23.840Z | A14:701 | `3.2, 3.3, 3.5 bị thừa và vô nghĩa, sắp xếp không hợp lý [Image #1, 921x479]` | nhóm Loomline rò rỉ trong settings.html |
| 11 | 2026-09-18T10:24:03.489Z | A14:750 | `Còn xót rất nhiều Loomline trong settings.html / Bỏ hết và clean lại settings.html cho sạch sẽ dùm` | dọn dẹp chưa triệt để |
| 12 | 2026-09-18T10:28:15.498Z | B5:258 | `Tao tự chạy hrv theme dev rồi mà, sao mày ko bắt được à?` | agent không nhận ra watcher của user; PID chỉ thấy 2 process không xác minh được có watch folder này |
| 13 | 2026-09-17T07:04:01→07:05:49Z | B2:914→:915 | `[Error] Our servers are currently overloaded…` → `Tiếp đi` | provider 9router quá tải, agent đứng |
| 14 | 2026-09-17T03:54:38.374Z | A3:1180 | `Tạm ngưng, tìm hướng fix các MCP trên cho hoàn thiện vào AntiFan Core đi đã, lưu ý kĩ là fix tới khi hoạt động` | chuỗi MCP timeout + 429 + thinking-loop |
| 15 | 2026-09-18T04:33:30.252Z | A4 | `Lưu ý Chỗ này là Product chứ ko phải render cứng, dùn hrv cli cập nhật lại sản phẩm đem ra cho phù hợp` | agent render cứng sản phẩm |

**Bổ sung quan trọng của verifier:** câu Tier-0 `"Hôm này đúng thất vọng…"` **không nằm trong 19 file** (cả 5 ứng viên đều nói đúng điều này), nhưng **có anchor thật** ở file thứ 20 (xem Cross-Project #1) — ứng viên A đã suy đoán đúng hướng `[INFERENCE]` này.

## Cross-Project Relations

1. **Câu Tier-0 có anchor thật (bổ sung của verifier; ngoài 19 file):** `C:\Users\Admin\.omp\agent\sessions\--E--Work-apps-AntiFan--\2026-09-18T10-25-28-261Z_01a0b40c-bac5-7570-a558-fbb1e8038677.jsonl` — record `custom_message/skill-prompt` (skill `ak:scout`, `attribution":"user"`, `id":"9a640136"`) @**2026-09-18T10:43:15.045Z** chứa nguyên văn: `--ultra Đọc tất cả các chat session OMP liên quan tới Comnieusiba và Bagamuioto\nHôm này đúng thất vọng, làm việc siêu chậm, kiến thức lệch tùm lum, gọi MCP treo, chỉnh chỗ này sai chỗ kia, nói chung từa lưa hết về AntiFan`. Đây chính là phiên điều phối lượt scout này (cwd `E:\Work\apps\AntiFan`) → xác nhận 'Comnieusiba/Bagamuioto là 2 job khách hàng chạy trên nền AntiFan'.
2. **AntiFan là dependency cưỡng chế của cả hai job (không thể tắt):** cổng `[theme-qa-gate] QA GATE PENDING — theme file(s) under E:\Work\customizes\Comnieusiba were edited without a fresh AntiFan QA receipt` chèn vào **chính toolResult** ở A5 @06:19:54.276Z và A9 @08:06:34.189Z; lệnh kiểm chứng là `xd://mcp__antifan_browser_theme_qa_validate`. Khi MCP `stage: connect` chết (B5 10:18:08Z), **cả hai dự án mất oracle QA cùng lúc**.
3. **Comnieusiba sửa trực tiếp AntiFan Core:** A3 `edit E:/Work/apps/AntiFan/src/main/tools/browser-capabilities.ts` @2026-09-17T04:05:48.605Z (guard `confineWorkspaceRoot` cho `dump_dom`, thay vì để EISDIR) sau lệnh `"Tạm ngưng, tìm hướng fix các MCP trên cho hoàn thiện vào AntiFan Core đi đã"` @03:54:38.374Z, rồi đi tìm kênh reload Core (`CmdOrCtrl+Shift+U` @04:05:55.334Z).
4. **Bug harness về đường dẫn tool xuất hiện ở CẢ hai phía:** `No such tool: xd://mcp__mcp__antifan_browser_anti_browser_tabs_list` — A4 @05:13:58.655Z (một lần nữa tái xuất trong công cụ của B5 dưới dạng `xd://mcp__antifan_browser_anti_trace_interaction` @10:17:47.546Z, tức danh sách tool bị chèn 2 tiền tố khác nhau).
5. **Hai dự án dùng chung một browser/tab set:** A9 `TARGET_MISMATCH: Tab ID mismatch: expected 11ef1577…, got 967fbab8-…` @08:05:27.108Z; B5 tab list/QA binding trỏ `3c205187-…`/`3c205187` và `bagamuioto.myharavan.com`; A9 `POLICY_DENIED … browser tab quota reached` @08:20:36.301Z → **capture treo ở job này làm nghẽn CDP của job kia**.
6. **Cùng bộ `hrv` CLI + cùng theme id của AntiFan:** A4 key `{"org_id":"200001208796","theme_id":"1001511385","theme_name":"clothing"}` (A1 @08:14:21Z vùng) và CDN `cdn.hstatic.net/themes/200001208796/1001511385/14/siba-homepage.scss.css` (A9/A14); B2/B4 dùng `bagamuioto.myharavan.com` + `config/settings_schema.json` + `generate-settings-html.py`.
7. **Hai quy ước cấu hình trái ngược trong cùng một đợt migrate:** Comnieusiba — rule cứng `ko dùng settings_schema.json nữa` (A7 @06:36:52.992Z) và AGENTS.md ghi `config/settings.html` là nguồn duy nhất (A14 @10:20:09.999Z); Bagamuioto — `schema-fragments/generate-settings-html.py` *"Sinh khoi live cua config/settings.html TU config/settings_schema.json"* (B2 @07:00:32.162Z), tức **nguồn là schema**. Cùng ngày, ngược chiều → giải thích trực tiếp 'kiến thức lệch tùm lum'.
8. **Cùng work-queue annotation + cùng hội chứng sync:** `.antifan/annotations/element_*.md` là đầu vào task ở A5/A9/A10/A12/A14/B4/B5 (verifier mở trực tiếp A9, A10, A14); và **cùng một mẹo chữa sync** 'thêm whitespace trigger save' ở A9 @08:22:37Z và B5 (10:29Z, ứng viên dẫn :274).
9. **Phiên chuyên trách thứ ba — Haravan CLI — là mắt xối giữa hai job:** `--E--Work-apps-Haravan CLI--\2026-09-16T09-47-41-006Z_…` (theo ứng viên A/B/D) debug push timeout cho `config/settings_schema.json` của Bagamuioto. **Verifier chưa mở file này** → xem danh sách loại.
10. **Hai job cùng chạy chung một khuôn goal-mode + cùng bị ảnh hưởng hạ tầng model:** B1 goal `"đã tự chạy lệnh Hrv theme dev"` @19:01:49.209Z và A1 goal `/ak:cook --auto --parallel --advice` — cùng cấp quyền `settings_data.json`, cùng chịu `401 Incorrect API key` (A8) / `servers overloaded` (B2).

## Gaps (hợp nhất)

1. **Cửa sổ grep 4MB** (công cụ tự in: *"Searched only the first 4MB of large files … use `read` for the rest"*) — verifier TÁI XÁC NHẬN độc lập. Vùng giữa chưa đọc hết: A1 ~1250–2478, A3 ~1280–11292, A4 ~600–3200, A9 ~650–2019, A11 ~440–2115, B1 ~1160–11150, B2 ~840–7533.
2. **A13 dòng 66 nặng 122KB** khiến công cụ từ chối nạp → record cuối phiên A13 chỉ suy ra được.
3. **A14, B5 (và có thể B4) là append-only khi đọc** → mọi kết luận là ảnh chụp; B5 đã tăng từ 471 → **539 record** trong cùng buổi.
4. **Không có bằng chứng phía server/supervisor của `antifan-browser`** (nguyên nhân `stage: connect` chết 10:15–10:42Z) — corpus chỉ có phía client.
5. **Không đọc** transcript subagent/`*.md` finals/`<n>.<tool>.log` của cả hai dự án (trừ một số dòng verifier tự mở); các file `VerifierB.md`/`VerifierUltra.md` bị ứng viên A ghi là 0B chưa kiểm chứng.
6. **Mâu thuẫn chưa giải quyết — ai ghi `settings.html` về 12 nhóm?** A13 chứng minh có writer khác (mtime 16:41:31) nhưng **không chỉ đích danh session**; A9 quyết định restore trong khi A12/A14 làm việc trên cây 12 nhóm ⇒ thứ tự thắng–thua không xác định được.
7. **Câu Tier-0 không nằm trong 19 file** — đã giải quyết bằng anchor ngoài corpus (Cross-Project #1), nhưng 19 file vẫn không chứa nó.
8. **Các thư mục phiên phụ** (Haravan CLI, F1GENZ_Review, FarmerMarket, Hapas, Mnbakery, OwlBrand, Seahorse2, f1genz-Sapo-GENZ) chưa được đọc trong pass này.
9. **`hrv theme dev` của user có thật sự watch folder Bagamuioto không** — B5 chỉ thấy PID `42172`/`12004` và `.hrv-sync-state.json` mtime `2026-09-17 17:06:15`; **chưa xác minh**.

## Loại bỏ / chưa kiểm chứng được (không đưa vào union)

| Claim | Ứng viên | Lý do loại |
|---|---|---|
| 'B4 vẫn active lúc 10:48:11' | C | **SAI** — record cuối của B4 là lỗi đọc annotation @10:06:32.983Z (file 395 dòng, dòng cuối rỗng). Bị loại và ghi nhận là lỗi trạng thái. |
| 'A5 bị compaction giữa dòng' như kết cục | A | Hạ cấp: compaction A5 @06:43:41Z là sự kiện khác; **kết cục thật là bị giết giữa `theme_qa_validate` @07:18:04.329Z** |
| 'A9 kết thúc bằng loạt fix CSS / đang so sánh' | A, D, E | Hạ cấp: kết cục là **quyết định restore cây 6 nhóm** @09:43:40.590Z |
| 'A8 đang triển khai / churn nhiều writer' (thiếu mốc delivered) | A, D | Hạ cấp: A8 **đã delivered + QA PASS 0 issue @08:14:56.522Z** |
| 'settings.html Bagamuioto mất 1280 dòng legacy rồi restore' | D, E | Không tìm thấy trong 4MB đầu của B2 (advisor đuôi nằm ngoài cửa sổ) |
| `A4:467`/`A4:544` '17 sections/1708 → 6/1699' | D | Chưa mở; chỉ suy ra từ mô tả role |
| A6 '32 mismatch / 12 thiếu id' | D | Chưa mở |
| B4 `TARGET_MISMATCH` ×2 và `CAPTURE_NOT_READY 'imagesSettled'` 4 lần | C, D, E | Chưa mở (B4 chỉ mở phần đuôi) |
| B4 '2 lần VERIFIED_COMPLETE' | C, D, E | Chưa mở |
| A6 thinking 'Two corrections: config/settings_data.json EXISTS (338.7KB)' | B | Chưa mở |
| A4:365 'menu phải tạo trong admin F12' | B, C, D, E | Chưa mở (nhất quán với (c) nhưng không có anchor tự kiểm chứng) |
| A12 'bản cây 12 nhóm / ledger hash stale 0bf93b03 vs f18498e6' | C | Chỉ gián tiếp: `sha256 0bf93b03…` xuất hiện trong `AGENTS.md` tại A14 @10:20:09.999Z — chưa mở record A12 tương ứng |
| Log đọc lặp (6 × read.log A5, 5 × 20.7KB B1) | B | Chưa mở file log |
| B1 `LiquidReviewer` thinking-loop 380 ký tự ×3 | B | Chưa mở |
| B1 đuôi `VERIFIED_COMPLETE — category slider` @09-17T04:39 | A, C | Chưa mở (chỉ xác thực được mốc capture/media-freeze ở giữa file) |
| A3 đuôi '4 SVG 404 / partial upload' | A, B | Chưa mở |
| 'Phiên Haravan CLI 09-16 debug push 386191 bytes cho Bagamuioto' | A, B, D | Chưa mở file |
| A11 dòng 76 'MCP server not connected' | D, E | Chỉ xác thực gián tiếp qua `BLOCKED` @08:37:03.279Z |
| Số record A12 (1168 vs 1042) và A14 (1192 vs 1212) lệch nhau | C vs E/B | Không phân giải — B5 đang live đã cho thấy số record trôi theo thời điểm đọc |

---

## Phụ lục kiểm chứng (controller)

- **Nguồn**: 5 pass scout độc lập (ẩn danh A–E) chạy read-only trên cùng một evidence packet; finalizer = **union đã kiểm chứng** (không chọn 1 winner) theo hợp đồng ak:scout --ultra.
- **Điểm rubric** (1–20 × 4 tiêu chí — coverage / evidence / signal / honesty): B **74** · C **73** · E **72** · A **72** · D **67**; cả 5 pass hard constraints (đủ 19/19 session, không path bịa, mỗi session có role+outcome).
- **Kiểm chứng anchor**: 36 anchor được verifier tự mở lại trên file gốc; 0 trích dẫn bịa; một số chỉ số dòng lệch ±1–2 (chi tiết trong payload verifier).
- **Model tier**: runtime này map mọi model slot về cùng một model (`aibox/ds/deepseek-flash:high`) → đây là **best-of-5 same-tier** (mẫu độc lập + chấm rubric), không phải asymmetric verification; rủi ro self-preference/correlated-error được xử lý bằng reject-all + chấm có bằng chứng (đã áp dụng).
- **Loại bỏ/hạ cấp**: các claim không tự kiểm chứng được đều bị hạ cấp hoặc loại — danh sách đầy đủ ở mục cuối của báo cáo.
