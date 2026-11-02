# AntiFan: điểm cần cải tiến, rút từ chat OMP 31/10 → 02/11/2026

- **Phạm vi:** 39 session OMP có hoạt động từ 31/10 00:00 (+07), không tính session audit này. Danh sách 500 session mới nhất có bản cũ nhất là 28/09 nên không bị cắt. 856 transcript (39 file chính + 817 file subagent), 283 MB.
- **Độ phủ:** 35 digest mức A, 3 mức B, 1 mức C; 6 chat có digest 84–132 KB bị cắt phần đuôi cửa sổ, scout đã grep JSONL gốc để đọc tiếp; 1 scout phải chạy lại vì lần đầu lỗi. Hai session là bản clone: 31.182 và 5.633 entry thừa hưởng từ session cha (ngoài cửa sổ) được bỏ, phần trong cửa sổ vẫn đọc. Mỗi chat do một scout riêng đọc.
- **Kết quả:** 184 issue. `owner: app` 66 (4 high, 31 medium, 31 low) rải trên 24/39 session; còn lại omp-harness 63, model 28, external 12, skill-rules 9, user-env 6. Năm verifier scout chỉ đọc code, kết luận từng issue app: partial 31, open 20, by-design 11, not-app 2, fixed-in-head 1, cannot-verify 1.
- **Dữ liệu:** `%TEMP%/omp-digest-261102/out/` (`_all.json`, `_app_issues.txt`, `_mcp_volume.json`, 5 slice `Q/T/C/L/S`).
- **Quy ước:** `[V]` đã đọc code/working tree lúc audit; `[R]` đã chạy thử để tái hiện; `[INFERENCE]` là suy luận.
- **Working tree:** HEAD `4f87f0dd` cộng thay đổi chưa commit của hai task khác (hook run-state cho badge "chờ bạn", `scripts/leader/wait-workers.mjs`, `skills/antifan-leader/`). Audit này không sửa file nào.

## 1. Số liệu

- **114.265 lệnh gọi tool, 4.037 lỗi (3,5%)** (đếm theo cặp `toolCall`↔`toolResult`). Lỗi theo tool: `bash` 1.882, `edit` 615, `write` 552, `eval` 507, `read` 227, `grep` 119. Trong 552 lỗi `write`, phần lớn **không phải lỗi ghi file** mà là AntiFan/Playwright từ chối nhận lệnh qua `xd://` (451 + 21 — xem dòng dưới); lỗi harness thật nằm ở `bash` (1.882, chính sách chặn `cat/head/tail/find/sed`) và `edit` (615, anchor/hash).
- AntiFan: **9.361 lượt, 491 lỗi** — 7.698 `write` thẳng vào `xd://mcp__antifan_*`, 954 toolCall `mcp__antifan_*`, 699 lượt chỉ đọc doc schema `xd://`. Lệnh nằm trong `eval` (`tool.mcp__antifan_*`) không đếm được nên đây là cận dưới. Playwright: **318 lượt, 26 lỗi** (281 qua `xd://`). Số đếm lấy bằng cách ghép `toolCallId` của từng `toolResult`, không dựa vào `toolName` (mọi lệnh `xd://` đều mang tên `write`) [V].
- `anti.telemetry.record_fallback` được gọi **1 lần** trong cả cửa sổ (Hestia `FixPdp.jsonl`, 31/10 19:23:27Z, trả `{"recorded":true,…gaps.jsonl}`), trong khi có 318 lượt Playwright — §3.1 của `AGENTS.md` đòi ghi lý do cho mỗi lần chuyển sang Playwright, nên 317 lượt còn lại không có bản ghi [V].
- Mã lỗi nhiều nhất: `NO_RENDER_SURFACE` 33, `TARGET_STALE` 32, `CONNECTION_CLOSED` 18, `TARGET_BUSY_DRAINING` 6, `CAPTURE_FRAME_STARVATION` 4, `INVALID_ARGUMENT` 3, `TARGET_OBSCURED` 3, `REPLAY_DENIED` 3, `EXECUTION_UNCERTAIN` 2, `QA_BUSY` 1.
- Tool AntiFan gọi nhiều nhất (số lần/lỗi): `evaluate` 3.917/168, `navigate` 1.245/60, `screenshot.viewport` 1.155/64, `set_viewport` 529/7, `cursor.click` 345/30, `screenshot.full_page` 340/32, `tabs.create` 256/7, `wait` 238/1, `agent.sequence` 153/14, `tabs.close` 114/4. Lỗi theo tool: `file_write` 26, `evaluate_frame` 17, `theme_qa_validate` 14, `cursor.type` 9.

| Mục | Cụm | Issue app | Session | Trạng thái |
|---|---|---|---|---|
| 2.1 | Verdict tin cậy được (CERTIFIED/PASS) | 4 | 3 | 2 open, 2 partial |
| 2.2 | Chi phí và độ bền của lượt QA | 3 | 3 | 3 partial |
| 2.3 | Tác dụng phụ lên workspace, nhiễu hook | 3 | 2 | 2 open, 1 by-design |
| 2.4 | Transport: socket rơi rồi replay | 1 | 1 | 1 open |
| 2.5 | Authority của tab khi chạy song song | 5 | 5 | 3 partial, 2 by-design |
| 2.6 | Vòng đời và tầm nhìn của cookie jar | 5 | 5 | 2 partial, 1 open, 1 not-app, 1 cannot-verify |
| 2.7 | Render surface và cổng chụp ảnh | 11 | 7 | 4 open, 6 partial, 1 by-design |
| 2.8 | Click / locator / ma sát schema | 21 | 14 | 9 partial, 4 open, 6 by-design, 1 fixed-in-head, 1 not-app |
| 2.9 | Leader / terminal / hook | 11 | 8 | 6 open, 4 partial, 1 by-design |
| 2.10 | Google Sheet | 2 | 1 | 2 partial |

## 2. Các cụm, xếp theo tác động

### 2.1 Verdict tin cậy được (high, lặp lại từ báo cáo 28/10 §2.1)

1. **`I063` high, open — luật chồng lấn chỉ đo ở một width.** `visual-quality-scanner.ts:863` chạy `floating-widget-overlap`/`invisible-click-blocker` ở đúng width tab đang có, còn sweep trong `theme-qa-workflow.ts:2269-2281` dựng với `skipFloating:true`; `buildViewportsTested` (`:1473-1488`) chỉ liệt kê width của overflow/integrity. Nên agent nhận CERTIFIED trong khi 768/1440 có chồng lấn thật, phải tự so tay. [V]
   - Cần làm: ghi width mà visualQuality đã chạy vào `summary`/`viewportsTested`; nếu chỉ có một width thì thêm `evidenceGap` hoặc lý do certification.
2. **`I171` medium, partial — baseline không độc lập.** Receipt `anti.visual.compare` ghi origin/pathname/host-run nhưng không có `promotedAt`/sha của baseline, nên baseline vừa chụp xong đem so với chính nó vẫn PASS. [V]
   - Cần làm: ghi `baseline.promotedAt` + sha vào receipt, `checkReceipt` từ chối bằng `BASELINE_TOO_FRESH`/`SELF_COMPARE`.
3. **`I172` medium, open — `mismatchPercentage` thấp hơn diff thật.** Ngưỡng màu suy ra từ `tolerance` loại pixel viền và khử răng cưa mà không báo. Agent thấy 1–2% trong khi mắt thấy rõ lệch. [V]
   - Cần làm: trả thêm `{colorThreshold, antialiasExcluded, mismatchStrictPercent}`.
4. **`I080` medium, partial — contrast 1.12:1 trên ảnh nền và certification luôn `STRUCTURAL`.** Vòng lặp contrast gộp `opacity` của tổ tiên vào màu chữ nên phần tử trong slider inactive bị báo critical; phần còn lại (chữ trên ảnh) đã đúng là indeterminate. [V]
   - Cần làm: phần tử có `opacity < 0.9` (hoặc `aria-hidden`/`inert`) trả `contrastIndeterminate` thay vì grade.

### 2.2 Chi phí và độ bền của lượt QA (medium, lặp từ §2.2 cũ)

- **`I065` medium, partial — QA chết vì chính trang đang dùng.** `TARGET_STALE`, `QA_BUSY`, `URL_PATH_MISMATCH`, `CONNECTION_CLOSED` khi có điều hướng giữa lượt; không có retry cùng tab. [V]
  - Cần làm: gặp `TARGET_STALE` với cause `navigated-away` thì chờ load rồi chạy lại validate một lần trên cùng tab; `QA_BUSY` chờ tối đa `retryAfterMs`.
- **`I085` low, partial — 4–5 phút cho 4 route.** Stage 2 reload timeout làm hỏng cả lượt; lỗi ngắn không JSON.
  - Cần làm: retry `ports.reload` một lần khi timeout (không retry với anti-bot/tab gone); trả `durations` theo stage.
- **`I170` medium, partial — 45 giây/ô và `EVIDENCE_INCOMPLETE` khó hiểu.** Ở width ≥768 thiếu sweep thì trả INCONCLUSIVE, nhưng thông báo chỉ khuyên dùng viewport mobile thay vì nói sweep chưa chạy/tắt/bị lỗi (`theme-qa-workflow.ts:2717`). [V]
  - Cần làm: thông báo nêu rõ trạng thái sweep và cách bật.

### 2.3 Tác dụng phụ lên workspace và nhiễu hook

- **`I084` medium, open — `theme.qa_validate` ghi `specs/qa-matrix.json` (file tracked) vào repo theme.** Agent dọn bằng `git restore` và mất luôn thay đổi chưa commit của file đó. Điều kiện ghi và test hiện hành đã đọc. [V]
  - Cần làm: ghi vào `.antifan/qa-receipts/` (hoặc chỉ khi file chưa tồn tại/chưa tracked); trả danh sách path đã ghi để test đổi theo.
- **`I175` low, open — `theme-qa-gate:churn` bắn khi ghi file `.md` ngoài theme.**
  - Cần làm: chỉ gọi `maybeQueueChurnHint` khi path nằm trong theme; bỏ qua `.md`.
- **`I174` low, by-design — `URL_EXPECTATION_MISSING` fail-closed.** Không cần sửa.

### 2.4 Transport: socket rơi rồi replay (high, mới)

**`I062` high, open.** 21 lần đứt giữa lượt, gom trong 2 chat (Hestia 19, shopify 2), 15 tag subagent khác nhau, từ 31/10 18:52Z tới 01/11 16:48Z: 16 `CONNECTION_CLOSED` + 5 `REPLAY_DENIED`; 19 lần ở `write`, 2 ở `eval`. Mỗi lần agent mất 5–60 s và **không biết lệnh đã chạy hay chưa** (`navigate`, `set_viewport`).

- Code 1005 là close không kèm mã. `[R]` Probe `ws` trên máy này: bên tự gọi `close()` thấy 1005, `terminate()` cho 1006, close có mã (4001) truyền nguyên. Vậy 1005 đến từ một lời gọi `close()` trần — hai chỗ trong app: proxy tự thay socket (`scripts/antifan-omp-mcp.cjs:2281-2283`, `2724-2726`, `2821-2823`, `3938-3940`) và `bridge-server.ts:4650-4652` khi dispose. Log không giữ chiều gọi nên chưa quy được chỗ nào. [V][INFERENCE]
- Không có lần khởi động lại app nào trước lần đứt cuối: log `runtime/logs/main.log{,.1}` phủ 01/11 14:43:25Z → 02/11 04:54:11Z; 4/21 lần đứt nằm trong phủ. Ba lần 15:07:01, 15:13:59, 16:35:36 chỉ có khoảng hụt heartbeat 8,2 / 7,9 / 11,6 s — main process vẫn sống. Lần **16:48:07 nằm ngay trước một tầng sự cố**: 16:49:43 → 16:50:20.870 main đứng 37,7 s, kết thúc bằng `uncaughtException: write EPIPE` lúc 16:50:20.844 và `child-process-gone type=GPU exitCode=34` lúc 16:50:20.912 (§2.11). Vậy lần đứt đó đi cùng một đợt đứng/ngã của main process, không phải do app restart. App chỉ đổi tiến trình (pid 35200 → 15408, `boot.start`) lúc 02/11 03:50:45Z, sau lần đứt cuối cùng. [V]
- Cơ chế replay: `invoke()` gửi lại khung khi socket rơi với **cùng attachment và cùng idempotency key**, host đã tiêu nonce nên trả `REPLAY_DENIED`, và với tool không idempotent thì thành `EXECUTION_UNCERTAIN`.
- Cần làm: trong nhánh `transmitted:true` + cùng attachment — tool READ_SAFE thì cấp identity mới rồi gửi lại; tool còn lại trả `EXECUTION_UNCERTAIN {transmitted:true}` có `tool`, `details`, gợi ý kiểm bằng `tabs.get`/`inspect.network`. Kèm log `closedBy`/`closeCode` ở cả hai phía để lần sau quy được chiều.

### 2.5 Authority của tab khi chạy song song (medium, lặp từ §2.3 cũ)

- **`I083` low, partial / `I068` low, partial** — nhiều subagent song song dùng chung một bound tab và một pool 10 tab; `TARGET_MISMATCH 'bound <id>'` đổi giữa các lệnh. Phần lớn là lỗi phía skill: subagent phải `tabs.create {bind:false}` và truyền `tabId` ở mọi lệnh.
  - Cần làm (app, tùy chọn): thêm cột `closable` vào `listTabRows`/`LIST_TAB_FIELDS`.
- **`I121` medium, partial — `evaluate_frame` không chờ iframe.** `waitMs` chưa có; tab/iframe Haravan admin mất rồi hiện lại sau rebind.
  - Cần làm: poll `resolveChildFrame` tới ~10 s, mã riêng `FRAME_NOT_ATTACHED` kèm danh sách frame.
- **`I024`, `I002` by-design** — giới hạn 10 tab và thiếu cờ `affiliated` sau `fields` là hành vi đúng; sửa ở skill (`ux-ui-all` dùng `bind:false` rồi đóng tab).

### 2.6 Vòng đời và tầm nhìn của cookie jar (medium)

- **`I001` medium, partial — logout/đổi org trên jar dùng chung có thể đăng xuất tab của user.** `cookieJar` đã có nhưng `tabs.create` không trả jar/partition đã dùng nên agent không biết mình đang ở đâu. [V]
  - Cần làm: trả `jar`/`partition` trong kết quả `tabs.create`; mô tả tool ghi rõ "mọi login/logout/đổi tài khoản phải dùng `cookieJar`".
- **`I054` medium, open — không có tool xóa/xóa sạch một jar đặt tên.** Purge hiện phải chờ đóng AntiFan.
  - Cần làm: `anti.browser.cookie_jar.clear {cookieJar}`: đóng tab trong jar, `clearStorageData()` trên partition, trả phần còn lại.
- **`I152` low, partial — không tra được profile nào đã đăng nhập dịch vụ nào.**
- **`I012` low, not-app** — điều phối nhiều tài khoản là quyết định của user; cần một trang docs/skill (`tabs.create {cookieJar:'muse-<name>'}`).
- **`I180` medium, cannot-verify — profile dùng chung bị đăng xuất Shopee Affiliate (~00:33 ngày 31/10), producer Gác dừng 10 kênh.** Log đã có event `cookies.evicted` và `cookies.googleAuth`, nên lần sau chạy được skill `antifan-session-loss-triage` để đọc partition `shopee.vn`. [V]

### 2.7 Render surface và cổng chụp ảnh (medium–high, 11 issue)

- **`I038` medium, open — `screenshot_viewport` trả `CAPTURE_FRAME_STARVATION` khi cửa sổ project bị ẩn/minimize.** Đường chụp không gọi `restoreHostWindowUnfocused`, thông báo cũng không nêu `tabs.activate {restoreWindow:true}`. [V]
  - Cần làm: phát hiện `isHostWindowHidden` → `surfaceTabWindow`/`restoreHostWindowUnfocused` một lần rồi chụp lại; nhét bước đó vào text lỗi.
- **`I023` medium, partial — tab mất render surface sau navigate hụt** (`Runtime.evaluate` quá 3000 ms). Probe chỉ thử một lần.
  - Cần làm: sửa timeout start (§`I022`) rồi thêm `tabState` (`isLoading`, `windowHidden`) và một lần retry có delay.
- **`I015` medium, partial — iframe Sapo admin chụp ra trống:** rAF trong iframe 0 frame/s trong khi document cha 3 frame/s. [V]
  - Cần làm: cờ cảnh báo `frame starved: iframe may be blank` trong receipt.
- **`I014` medium, partial — tab chết sau click timeout 30 s:** `PENDING_CLEANUP` → `NO_RENDER_SURFACE` → `TARGET_STALE`, dù `tabs.get` vẫn thấy tab.
  - Cần làm: ghi `crashed:true`/`closeReason:'render-process-gone'` vào closed-tab record; `switchTab` chạy probe `Runtime.evaluate` có giới hạn trước khi báo `rendered:true`.
- **`I082` medium, partial — 6 agent Lens song song: `NO_RENDER_SURFACE`, `TARGET_BUSY_DRAINING`, `NAVIGATION_TIMEOUT` (~40 lỗi).** Cả vòng audit phải quay về curl/Node.
  - Cần làm: khi pane ở nền và cause `ABSENT_SURFACE`, `assertRenderSurface` thử `withPaintingSurface` (attach rồi probe lại) trước khi từ chối — cùng cơ chế `NativeTabHost.withPaintingSurface`.
- **`I081` medium, open — `CAPTURE_NOT_READY imagesSettled` tính ảnh `loading=lazy` ẩn trong megamenu là "đang tải"** (50+ lần, 8+ subagent). [V]
  - Cần làm: loại `isNotPainted(img)` và (với full-page) ảnh lazy ngoài màn hình theo chiều ngang khỏi `pendingImages`; trả 5 src đầu đang chờ.
- **`I064` medium, partial — full_page lặp `CAPTURE_VIEWPORT_NOT_RESTORED`/`IMAGE_IDENTITY_UNSTABLE`/`CAPTURE_NOT_READY` trên trang dài.** Có quarantine + receipt nhưng không retry.
  - Cần làm: `settled.ok === true` thì chụp lại một lần; khi fail trả `expectedWidth/Height` và lệnh reset viewport.
- **`I016` low, partial / `I134` by-design** — lý do `fontsSettled`/`imageIdentityStable`/`layoutStable` thiếu bước kế tiếp; thêm `remedy: anti.browser.wait {condition:"images-settled"|"dom-stable"} then retry`.
- **`I022` medium, open — watchdog khởi động điều hướng cố định 3000 ms** trên site VN nặng dù đã đặt `waitUntil`/`timeoutMs`.
  - Cần làm: `startTimeoutMs = min(timeoutMs, max(3000, floor(timeoutMs/2)))` và gợi ý tăng `timeoutMs`.
- **`I104` low, open — proxy làm rơi `savedTo`.** Nhánh screenshot dựng metadata từ `artifactRef` (`scripts/antifan-omp-mcp.cjs:3725-3763`) nên mất `data.savedTo`; report của Leader ghi sai chỗ lưu ảnh. `saveTo` tính theo workspace root của AntiFan, không phải cwd của agent. [V]
  - Cần làm: thêm `...(data.savedTo ? {savedTo: data.savedTo} : {})` và một dòng trong `antifan-leader/SKILL.md`.

### 2.8 Click / locator / ma sát schema (medium, 21 issue)

- **`I103` medium, open — click theo x/y chỉ trả `{"clicked":true}`**, không cho biết đã trúng phần tử nào; click trượt vẫn báo thành công (đã xảy ra ở tab Quảng bá). [V]
  - Cần làm: trong nhánh x/y của `dispatchAgentAction`, chạy `elementFromPoint` trước khi dispatch và trả `hit {tag, role, name, text, selector}`.
- **`I033` low, partial / `I133` low, partial — thông báo sai hình dạng tham số.** `cursor.click` không nhận `text`, `cursor.type` với x/y trả `REF_NOT_FOUND`, `wait` nhận `ms` mà thiếu `condition`; message "Unsupported action: click" đẩy agent đi sai đường. [V]
  - Cần làm: khi không có ref/selector/locator/x+y thì `INVALID_ARGUMENT` nêu đủ dạng hợp lệ; số `ms` coi là `condition:'timeout'`.
- **`I066` medium, partial — ma sát schema:** `tabs.list` từ chối trường lạ, `responsive_matrix.customBreakpoints` không nhận số, `expressionFile` ngoài workspace. Phần `content is required` (14 lần) không tìm được throw site trong `src` lẫn proxy. [V]
  - Cần làm: nhận số trong `customBreakpoints`, thêm Shift/Control/Alt/Meta vào `NAMED_KEY_MAP`.
- **`I100` low, partial / `I018` low, partial — locator quá chặt.** `{role,name}` không khớp nút "Tiếp tục" của Facebook và dialog base-ui; `{text}` khớp phần tử lạ. [V]
  - Cần làm: khi có role mà role pool rỗng thì thử lại trên phần tử "bấm được" không role; thêm tầng cuối bỏ dấu tiếng Việt + khớp tập từ (chỉ nhận khi duy nhất) và trả `matchedBy`.
- **`I040` low, partial — `frameSelector '#app-detail2-iframe'` trả về frame announcekit.** Fallback theo vị trí dùng descendants. [V]
  - Cần làm: giới hạn fallback ở frame có `parent === root`, trả `{frameTreeNodeId, url}` trong kết quả.
- **`I094` low, open / `I017` low, open — tên tham số lệch:** `terminal.write` đòi `input` (agent gửi `text`), `file_upload` đòi `refOrSelector`/`filePaths`, `cursor_type` không xoá được bằng `text:''` + `clear:true`.
  - Cần làm: nhận alias ở proxy (`text→input`, `selector/ref→refOrSelector`, `files→filePaths`) và cho phép chuỗi rỗng khi `clear:true`.
- **`I143` low, partial — `tabs.list all:true` trả ~22 KB rồi bị cắt**, không nêu `fields`/`limit`/`urlContains`. **`I153` low, open** — `tabs.create` trả `tabId` còn `tabs.list`/`tabs.get` trả `id`. **`I163` by-design** — từ chối trường `active` là đúng.
- **`I093` medium, partial — `terminal.create` báo `TARGET_STALE` khi tab bind đã chết** dù tạo terminal không cần tab. [V]
  - Cần làm: kèm candidate failover trong refusal, hoặc loại cause `unowned`/`tab-gone` khỏi gate.
- **`I032` medium, partial — điều hướng do chính thao tác gây ra bị báo lỗi.** Nhánh click đã sửa (trả `navigated:true`); nhánh `evaluate` vẫn ném `TARGET_STALE` khi trang điều hướng giữa script.
  - Cần làm: mã riêng hoặc `details.navigatedAway:true` + `newUrl` + gợi ý "script có thể đã chạy, kiểm bằng `tabs.get`".
- **`I157` medium, fixed-in-head** — click/hover/drag trên tab nền từ ~5 s xuống 0,1–0,2 s nhờ `withPointerSurface` (`4f87f0dd`). App hiện tại boot lúc 02/11 03:50:45Z, sau commit đó, nên bản đang chạy đã có. [V]
- **`I135`/`I115`/`I116`/`I055` by-design** — `timeoutMs` ≤29 s đã có, exception của trang đã được phân loại; lấy video/nhạc từ trang là tính năng chưa xây (nếu cần thì `anti.media.capture`).
- **`I059` not-app / `I176` by-design** — kết quả `tool.mcp__*` trong `eval` là `{text, details}` (cần `json.loads(r['text'])`); upload ZIP lên Partners phải `bind:true` hoặc truyền `workspaceRoot`.

### 2.9 Leader / terminal / hook (high, lặp từ §2.7 cũ)

- **`I046` medium, open — hook chặn nhầm lệnh `rg` chỉ đọc.** `CLI_ALIAS_RE` trong `theme-push-policy.ts` bắt từ khoá CLI khi nó chỉ là một phần của chuỗi/từ. `[R]` Tái hiện được: lệnh có chữ `function` **và** đường dẫn chứa `/haravan/` bị `REFUSED_THEME_COMPLEX`. [R]
  - Cần làm: thêm `/` và `\` vào lookahead âm sau CLI word (một đoạn đường dẫn không phải CLI) và bắt CLI word phải là token cuối; thêm case vào `edit-guard.test.mjs`.
- **`I039` medium, open / `I129` low, open** — cùng gốc: `rg` chỉ đọc có `haravan` trong đường dẫn bị chặn như "gọi theme CLI"; lệnh backup không liên quan bị chặn. Thông báo từ chối không nêu luật nào khớp (và chỉ sang một đường cũng bị chặn). [V]
  - Cần làm: cùng fix lookahead; refusal nêu tên luật; cân nhắc bỏ gate khi cwd và mọi path đều ngoài thư mục theme.
- **`I056` low, open — subagent `task` sinh từ terminal Leader thừa hưởng cờ Leader** nên cũng bị `REFUSED_LEADER_PAGE_ACTION`.
  - Cần làm: `HAND_OFF` nói rõ subagent thừa hưởng cờ và cũng bị chặn, phải dùng `terminal.create`.
- **`I030` high, partial — run card gắn vào OMP mồ côi sau khi daemon host bị thay.** Leader ghi vào nhầm cửa sổ, mất quyền điều khiển worker; hai orchestrator cùng đẩy một repo trong nhiều giờ (63 commit chưa push). Nguyên nhân: run file khoá theo terminal id và Manager chỉ tin `pid` còn sống. Hook đã có bản sửa (so `startedAt` của host) nhưng chưa commit, chưa cài, và không chạm tới process mồ côi đang chạy. [V]
  - Cần làm: phía Manager, đánh dấu `orphaned` khi `run.pid` không phải con của shell pid của pane; `terminal.list` trả trạng thái đó.
- **`I031` medium, partial — `runSeq 0`.** OMP mới khởi động báo idle `runSeq 0` nên bộ chờ worker báo "xong" ngay; Leader phải tự viết `wait-workers.mjs`.
  - Cần làm: `terminal.wait run-idle` không có tiêu chí mà gặp run `runSeq 0` thì trả `freshSession:true`.
- **`I128` low, by-design** — worker kết thúc bằng `session_exit sighup` ngay sau báo cáo; chưa rõ ai gửi. Tùy chọn: log `{sessionId, caller, leader|user}` ở handler `terminal.close`.
- **`I159` medium, open — hook Super-Fast chặn cả việc ĐỌC doc `xd://mcp__antifan_browser_*`**: `edit-guard-policy` coi mọi URL khác `http(s)` là đường dẫn tương đối (audit subagent mất ~6 phút). [V]
  - Cần làm: thêm `local://`, `artifact://`, `agent://`, `memory://`, `history://` vào danh sách URL không phải file; cho `read` trên `xd://`.
- **`I168` low, partial — notice gate chung chung, model học cách gạt đi.** `isThemeCwd` chỉ cần thấy `.antifan` là nhận. [V]
  - Cần làm: đòi có `templates/` (hoặc thư mục annotation) như check ở `:599-610`.
- **`I047` medium, open — subagent chỉ-đọc vẫn có shell:** mượn `terminal.create` + `terminal.write` để chạy git.
  - Cần làm: OMP truyền cờ agent-scope lúc attach; `terminal.create/write` từ chối `REFUSED_READ_ONLY_AGENT`.
- **`I161` medium, partial — test phụ thuộc máy:** `goal-runner`/`goal-safety` fail khi ổ E: <20 GB; `context-bridge` nhạy tải.
  - Cần làm: bơm `statfs` giả trong test.

### 2.10 Google Sheet

- **`I120` high, partial — `write_cell` báo `success:true` khi ô chưa lưu** (`SAVED_UNCONFIRMED`/`gviz-still-previous`), làm một session mất 3+ giờ. Phần báo sai đã sửa; phần còn lại là mỗi ô chưa xác nhận vẫn tốn tới 45 s vì chỉ chờ GViz. [V]
  - Cần làm: sau Enter, đọc trạng thái editor (`readState`); còn mở thì Enter/Tab thêm một lần, hoặc trả `SHEET_EDITOR_STILL_OPEN`.
- **`I122` medium, partial — `anti.agent.sequence` dùng `action` bị `ValidationError`; không có tool liệt kê/chọn tab trang tính** nên agent đọc nhầm tab. [V]
  - Cần làm: `anti.sheet.list_tabs` (tên + gid) và trả `sheetName` cạnh `gid` ở `extract`/`find_rows`; nhận alias `action→type`.

### 2.11 Sự cố tiến trình chính (audit tự tìm, không nằm trong 184 issue)

Đọc `runtime/logs/main.log` + `main.log.1` (phủ 01/11 14:43:25Z → 02/11 04:54:11Z): [V]

- **3 lần `uncaughtException: write EPIPE`** lúc 01/11 16:30:17, 16:50:20, 17:01:36 (cùng pid 35200, uptime ~28–29 h), stack trong `node:internal/stream_base_commons` sau `socket.write` của kênh IPC cục bộ. `local-ipc-server.ts` gắn `data` handler và ghi phản hồi nhưng không có `socket.on('error')`, nên peer đóng giữa lúc ghi là lỗi không bắt được. Ngay sau lần thứ hai: `child-process-gone type=GPU exitCode=34`. [V]
  - Cần làm: bọc mọi `socket.write` bằng kiểm tra `writable`/`try/catch`, thêm `socket.on('error', …)` và một handler `uncaughtException` ghi log rồi sống tiếp.
- **1 lần `render-process-gone` lúc 02/11 02:14:55Z** trên `https://reviews-sapo.f1genz.dev/reviews?storeDomain=f1genz-purity.mysapo.net`, `reason=crashed`, `exitCode=-2147483645` (0x80000003). Trùng cụm với `I014` (`tabs.get` vẫn thấy tab sau khi renderer chết). [V]
- Liên quan tới §2.4: khung đứng 37,7 s trước EPIPE lúc 16:50:20 nằm cùng phút với một lần `CONNECTION_CLOSED`. Chưa đủ để kết luận nhân quả. [INFERENCE]

## 3. Ưu tiên

| Mức | Việc |
|---|---|
| P0 | `I062` transport replay (EXECUTION_UNCERTAIN + log chiều close) · `I063` ghi width đã chấm verdict · `I120` xác nhận ô Sheet bằng editor state · `I046`/`I039` lookahead `CLI_ALIAS_RE` · `I030` orphaned run card + commit/cài hook run-state · EPIPE guard ở `local-ipc-server` |
| P1 | `I054` jar clear · `I001` trả jar trong `tabs.create` · `I081`/`I064`/`I016` cổng chụp ảnh · `I022` watchdog theo `timeoutMs` · `I084` ngừng ghi `specs/qa-matrix.json` · `I082` retry `withPaintingSurface` · `I171`/`I172` provenance của compare · `I122` sheet tabs · `I159`/`I168` phạm vi hook · `I047` chặn shell cho agent chỉ-đọc |
| P2 | `I083`/`I068` `closable` + hướng dẫn `bind:false` · `I143`/`I153`/`I163`/`I066`/`I033`/`I133`/`I094`/`I017` ma sát schema · `I100`/`I018` locator · `I040` frame · `I104` `savedTo` · `I085`/`I170` thông báo QA · `I175`/`I174` hook noise |

## 4. So với báo cáo 28/10 → 31/10

- **51/66 issue app là cụm đã gặp** (trỏ về §2.1–2.8 của báo cáo trước), **15 issue mới**. Cụm mới đáng chú ý: transport replay (§2.4), ảnh lazy trong megamenu chặn capture (`I081`), `CAPTURE_FRAME_STARVATION` khi cửa sổ ẩn (`I038`), Sheet `write_cell` (§2.10), và sự cố EPIPE/renderer (§2.11).
- **Đã đóng hoặc giảm trong kỳ:** click/hover/drag trên tab nền 5 s → 0,1–0,2 s (`4f87f0dd`, `I157`); `terminal.close {removeMintedProject:true}` + playbook Leader (`CHANGELOG`); `SAVED_UNCONFIRMED` không còn trả `success:true`; hook run-state có bản sửa (chưa commit/cài).
- **Vẫn lặp y nguyên:** verdict tin cậy được (§2.1 ≈ §2.1 cũ), chi phí QA (§2.2 ≈ §2.2 cũ), authority/render surface (§2.5, §2.7 ≈ §2.3 cũ), Leader/terminal (§2.9 ≈ §2.7 cũ), Sheet (§2.10 ≈ §2.5 cũ).

## 5. Ngoài AntiFan (ghi ngắn)

- **omp-harness (63 issue):** chính sách `bash` chặn `cat`/`head`/`tail`/`find`/`sed -i` kể cả trong pipeline hoặc heredoc ghi file → 1.882 lỗi, lặp ở ~10 subagent mỗi đợt. `edit` từ chối vì anchor/hash (615 lỗi), `write` sai schema `xd://` (552), `eval` lỗi cú pháp/module (507). Đề nghị: một dòng cấm dùng `cat/head/grep/sed` trong task template của subagent thay vì để mỗi agent tự phát hiện.
- **model (28 issue):** sai cú pháp dải dòng `path:start:end`, đường dẫn tương đối sai thư mục, tự báo `VERIFIED_COMPLETE` với số liệu sai phải sửa sau phản biện, tự viết XHR spy bằng `evaluate` thay vì dùng `anti.inspect.network`.
- **external (12 issue):** 429 của Anthropic và 402 hết credit Google làm chết hàng loạt subagent (28 + 12 lần); Muse đăng xuất phiên và trả clip 10 s thay vì 30 s; Facebook đòi mật khẩu khi xoá Page; Cloudflare 2FA interstitial ở trang billing; model `ag/` trả 503/không hỗ trợ TTS.
- **skill-rules (9 issue):** prompt Leader ra chỉ thị giữa chừng làm prompt gốc lỗi thời; phiên clone không biết mình là owner hay clone; `/skill:ak-research --ultra` nạp `ak-advise`; luật TTSR `destructive-commands` và CAP12 dương tính giả.
- **user-env (6 issue):** áp lực RAM trên máy 16 GB khi chạy nhiều Whisper/subagent; tab AntiFan đăng nhập sai tài khoản Cloudflare; token Cloudflare lấy từ registry là account token nên `user verify` 401.

## 6. Câu hỏi mở

- Code 1005 của `CONNECTION_CLOSED` đến từ proxy tự thay socket hay từ `bridge.dispose()`? Cần log `closedBy`/`closeCode` ở cả hai phía (§2.4).
- Ai gửi SIGHUP cho worker (`I128`)? Cần log caller ở handler `terminal.close`.
- Shopee Affiliate tự đăng xuất (`I180`) là app hay site? Log đã có `cookies.evicted`/`cookies.googleAuth`; chạy `antifan-session-loss-triage` ngay lần tới, đừng chờ tổng hợp.
- EPIPE và các lần `CONNECTION_CLOSED` trong 16:48–17:01 ngày 01/11 có cùng một nguyên nhân (main process đứng) không? (§2.11)
