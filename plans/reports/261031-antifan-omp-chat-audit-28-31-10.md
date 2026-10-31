# AntiFan: điểm cần cải tiến, rút từ chat OMP 28/10 → 31/10/2026

- **Phạm vi:** 55 session OMP có hoạt động từ 28/10 00:00 (+07), không tính session audit này. Danh sách 500 session mới nhất có bản cũ nhất là 28/09, nên không bị cắt. Mỗi chat do một scout riêng đọc (5 scout đầu chạy trong pool, 50 scout sau chạy độc lập). Trường `session` của cả 55 output đều khớp với chat được giao.
- **Độ phủ:** 10 digest bị cắt ở 117 KB, phần bị mất là cuối cửa sổ. Scout đã grep JSONL gốc để đọc tiếp: với 8/10 session, bằng chứng trích dẫn tới trong vòng khoảng 2 giờ trước khi session kết thúc. Hai session còn lại đã quét lại: Fern `01a15848` sau 30/10 22:24 chỉ còn 1 lệnh gọi AntiFan, 1 lỗi; Gác `01a18aa2` sau 30/10 18:41 không còn lệnh gọi AntiFan nào.
- **Kết quả:** 273 issue, trong đó 207 có `owner: app` (2 critical, 9 high, 111 medium, 151 low tính trên toàn bộ). Các owner còn lại: omp-harness 30, skill-rules 16, user-env 8, model 7, external 5.
- **Dữ liệu:** digest và JSON của từng scout ở `%TEMP%/omp-digest-261031/` (`out/_all.json`, `out/_app_issues.txt`).
- **Quy ước:** `[V]` nghĩa là đã kiểm tra trên working tree lúc audit (HEAD `3386e0cf`, cộng các thay đổi chưa commit). `[INFERENCE]` là suy luận.
- **Working tree:** đang có thay đổi chưa commit của task khác (`layout-integrity-engine.ts`, `browser-control-port.ts`, `scripts/leader/`, `src/omp-hooks/leader-guard.ts`, …). Audit này không sửa file nào trong số đó.

## 1. Số liệu

- Gọi AntiFan MCP trực tiếp qua `write xd://` (cận dưới): **1324 lần, 97 lỗi**. Phần lớn lệnh gọi chạy trong `eval` (`tool.mcp__antifan_*`, `call('mcp__antifan_*')`) nên không đếm được. Ví dụ: sweep QA 110 ô của S2 Corporate và việc đăng TikTok của Gác.
- Tool gọi nhiều nhất (số lần / số lỗi): `evaluate` 488/18, `navigate` 139/1, `agent.sequence` 77/18, `tabs.create` 60/4, `cursor.click` 59/8, `tabs.list` 53/7, `terminal.wait` 41/14.

| Cụm | Số issue app | Số session |
|---|---|---|
| Verdict / attribution của theme.qa_validate | 41 | 17 |
| Binding / authority / render surface của tab | 32 | 20 |
| Leader / terminal | 17 | 13 |
| Google Sheet | 13 | 8 |
| Thiếu tool (network, locator theo text/role, form control) | 10 | 9 |
| `tabs.list fields` không nhận `tabId` | 9 | 9 |
| Core context bridge | 7 | 4 |
| Click/sequence gây điều hướng bị báo là thất bại | 5 | 5 |

## 2. Các cụm, xếp theo tác động

### 2.1 QA trả verdict sai (critical, mở)

1. **CERTIFIED dựa trên `baselineViewports` do agent tự điền** (Purity `01a179ad`). Lúc 28/10 08:48Z, agent Purity tự quét `.antifan/qa-receipts` và ra `Counter({('no-baseline','CERTIFIED'): 805, ('no-baseline','STRUCTURAL'): 311})`. Dòng output này có trong JSONL của phiên, nhưng audit chưa tự đọc lại store receipt. Agent cũng tự nhận đã truyền `{mismatchPercent:0, passed:true}` để qua cổng. Schema chỉ yêu cầu `{mismatchPercent:number, passed:boolean}` và không đòi bằng chứng nguồn gốc [V `browser-capabilities.ts:2323-2326`, `cockpit-capabilities.ts:363-379`]. Ngoài ra `pre_showcase_gate.js` và `workflow_final_guard.js` của Purity chỉ tin vào nhãn CERTIFIED.
   - Cần làm: bắt buộc `baselineRef` (id receipt của `anti.visual.compare` hoặc baseline đã promote) và kiểm chéo trong store. Truyền số thô thì chỉ được STRUCTURAL, kèm lý do `BASELINE_NO_PROVENANCE`. Sau khi sửa, cần rà lại các receipt CERTIFIED cũ.
2. **Báo PASS+CERTIFIED dù header ở 768px bị chữ đè nhau** (S2 Corporate `01a188b3`). User tự phát hiện qua ảnh chụp.
   - Đã có rule 5b (nhãn chữ tràn khỏi hộp nút) trong working tree, chưa commit [V `layout-integrity-engine.ts:1506`]. Rule này mới được kiểm bằng cách inject engine vào tab, chưa kiểm trên app đã restart.
   - Còn mở: so cặp control cùng layer trong sticky header, và quét liên tục dải 700–1300px cho header/nav.
3. **Cart báo PASS nhưng không dùng được** (S2 Sky Fashion `01a180e8`): nút +/− không gửi request, nút Thanh toán gọi `/[object Object]`. QA hiện không có probe chức năng nào cho cart (`theme.assert_cart` chỉ đọc thụ động).
   - Cần làm: thêm probe tăng/giảm/xóa cart và kiểm tra href của checkout. Giỏ trống thì trả `QA_EMPTY_CART_NOT_EXERCISED`.
4. **Tab bị đói frame vẫn cho verdict FAIL bình thường** (Tapdedo `01a162be`). `CAPTURE_FRAME_STARVATION` chỉ nằm trong receipt.
   - Cần làm: đưa lý do lên `summary` và đổi verdict thành INCONCLUSIVE (lỗi môi trường).

### 2.2 Kết quả QA khó dùng để gate (high, lặp lại từ báo cáo 27/10 §2.5)

- **Attribution:** `summary.attribution` đã có `status:'unavailable'` khi không có baseline [V `theme-qa-workflow.ts:1409-1435`]. Nhưng `differential.introducedRegressions` vẫn chứa mọi finding và `hasRegressions: true` [V `:2914-2928`]. Có 6 session đọc hai trường này mâu thuẫn nhau: Levents, Toda, ChalamesVN, Seahorse2, Lampro, Whenever. Riêng repair coordinator vẫn đúng vì luôn truyền `baselineFindings` [V `theme-qa-repair-coordinator.ts:178`].
  - Cần làm: khi `baselineSupplied=false` thì đổi tên thành `unclassifiedFindings` và đặt `hasRegressions: null`.
- **Không giới hạn được phạm vi:** theme legacy luôn FAIL vì lỗi có sẵn, kể cả khi thay đổi không gây lỗi nào (7 session).
  - Cần làm: tham số `scope` (selector hoặc file đã đổi) → `scopedCriticalCount`, và mức `CERTIFIED_SCOPED`. Hoặc `baselineUrl` để chạy cùng các probe trên bản live.
- **False positive:** drawer off-canvas bị tính là sticky-obstruction, marquee ngoài màn hình, thanh admin Haravan 40px (OVERLAY_OFFSCREEN), contrast trên ảnh nền, và `domUnstable` do chính scanner gây ra.
- **Chạy song song gây hỏng kết quả:** chạy nhiều qa_validate cùng lúc sinh TARGET_STALE hàng loạt và FAIL giả. Chạy tuần tự thì mất 60–100 s mỗi ô, vượt budget eval.
  - Cần làm: serialize hoặc trả `QA_BUSY`. Thêm chế độ matrix/async (`runId` + poll, receipt cho từng ô).
- **Summary chưa rõ:** `criticalCount` không khớp với findings, `issueCount`/`reasonCode` bị null, payload 95–273 KB.

### 2.3 Tab: binding, authority, render surface (high, lặp lại từ 27/10 §2.2)

- **Mất quyền sau khi proxy hoặc attachment đổi:** tab do chính session mở trả TARGET_MISMATCH và session được cấp một tab trắng mới. Gặp ở Gác (`01a18aa2`) và Lux Shoes. Form TikTok đang điền dở bị bỏ.
  - Cần làm: gắn ownership theo `terminalSessionId`/`projectId` và tự nhận lại tab khi re-attach.
- **Cửa sổ project bị minimize:** mọi tab thành hidden và tab mới có kích thước 0px. `tabs.activate` vẫn trả `switched:true` (`01a18075`, `01a162be`, agent mất khoảng 1h30 dò lỗi).
  - Cần làm: trả `HOST_WINDOW_HIDDEN`, thêm `windowMinimized` vào `get_viewport`, và cách khôi phục cửa sổ không cướp focus.
- **NO_RENDER_SURFACE trên tab nền** (`activate:false`), gặp ở 6 session. Thông báo lỗi không nêu `tabs.activate` hay `allowDegradedSurface`.
- **Tab biến mất hoặc binding đổi mà không báo:** TARGET_STALE không kèm `closedBy`/`closeReason` hay tab thay thế. Đóng tab ephemeral `bind:false` vẫn kích hoạt failover rebind.
- **Nhiều agent dùng chung một tab:** không có lease. ttb-dash phải tự làm `identity.lock`/`shopee_lock.py`, và có lúc chờ khóa hơn 10 phút.

### 2.4 Click hoặc sequence gây điều hướng bị báo là thất bại (medium, 5 session) [V]

- `tab-automation-host.ts:1149,1175,1196,1223,1316,1343,1368` trả `{success:false, reason:'Document navigated during action execution'}`, kể cả khi điều hướng là kết quả mong muốn của chính cú click đó.
- Cần làm: nếu event đã dispatch thì trả `{clicked:true, navigated:true, committedUrl, documentGeneration}`. Thêm tùy chọn `expectNavigation`.

### 2.5 Google Sheet (medium, lặp lại từ 27/10 §2.3, đã sửa một phần)

- Đã có: ghi nhiều dòng bằng Alt+Enter, `mode: append`, trạng thái `SAVED_UNCONFIRMED` [V `sheet-capabilities.ts:23,541,563`].
- Còn mở:
  - `SAVED_UNCONFIRMED` vẫn trả kèm `success: true` [V `:486-487`], nên agent hiểu là đã ghi (Seahorse2, TrueBeef).
  - Tab nền liên tục trả `gviz-still-previous` cho tới khi reload, khoảng 1 giờ ở MultiSync `01a18147`.
  - Không phát hiện dialog cảnh báo vùng protected (TrueBeef).
  - Không có `write_range`/batch: MultiSync phải ghi khoảng 250 lệnh từng ô.
  - Không có `find_rows`/`diff`.

### 2.6 Thiếu tool khiến agent tự viết evaluate (medium)

- **Locator theo text/role** và **set_control** cho switch/checkbox/radio/timepicker. TikTok Studio cần khoảng 190 dòng helper gắn `data-ttb*`.
- **TARGET_OBSCURED báo sai cho phần tử 0×0:** điểm lấy mẫu rơi vào (0,0) trên sidebar, gặp 9 lần. Cần trả `TARGET_ZERO_SIZE`.
- **anti.inspect.network:** dùng để lấy header/request của iframe và XHR khi Save. MultiSync và TikTok phải tự hook `window.fetch`.
- **Tool PageSpeed** do app sở hữu: hiện runner trong eval timeout 12/12.
- **Customizer theo setting-id:** Purity phải replay `PUT settings_data_tmp`, có nguy cơ ghi đè draft của merchant.
- **Cursor.type trên ProseMirror (Trello)** trả `typed:true` trong khi text bị mất hoặc vào sai đoạn (high, `01a18c1b-1ad0`). Cần đọc lại text sau khi gõ.

### 2.7 Leader / terminal (medium)

- **Không có MCP tool xóa project scratch khỏi Sidebar**, và `terminal.close` không gỡ project [V: không có `PROJECT_REMOVE` nào trong `src/main/tools`]. User phải tự xóa 4 project.
- **`leader-job init`:** dùng `gid=0` thì bị HTTP 400. Feedback không có sheet thì phải dùng stub CSV (code chưa commit trong `scripts/leader/`).
- **Leader không chờ worker lâu được:** `terminal.wait` tối đa 28 s mỗi lần gọi theo thiết kế [V `terminal-capabilities.ts:122-126,741`; lỗi abort ở giây 25 trong báo cáo 27/10 đã sửa]. Cần một nguồn đánh thức (event run-idle đẩy về phiên cha, hoặc chờ nhiều terminal / any-idle).
- **Hook policy chỉ áp dụng cho phiên OMP mới.** Cần hiển thị hash hook trong `terminal.list` để phát hiện lệch.
- **Lag:** cửa sổ catch-all nhận `terminal:activity` khoảng 125 msg/s, và `toolbar:state-updated` khoảng 30 KB, 2 lần/s (`01a18895`). Cần coalesce và chỉ gửi khi có diff.

### 2.8 Ma sát schema (low, nhiều session, sửa rẻ)

- `tabs.list fields:['tabId']` bị từ chối trong khi `tabs.create` trả về `tabId` (9 session). `validFields` có trong details nhưng không có trong message [V `browser-control-port.ts:2565`]. Cần nhận alias `tabId`→`id` và đưa danh sách field vào message.
- `terminal.wait` nhận `pattern` mà thiếu `condition`, `browser.wait` có `selector` mà thiếu `condition`: nên tự suy ra condition. `sequence` nên nhận `action`→`type`. `browser.dialog` nên mặc định `action: read`. `await_cdn_sync` nên nhận `asset`. `evaluate` nên ghi rõ trần `timeoutMs` 29000 ms trong schema.
- Kết quả `evaluate` lớn bị cắt mà không có cờ `truncated`.
- `settings_check` trả `ok:true` khi quét 0 file. Workspace mặc định là repo AntiFan chứ không phải cwd của client.

### 2.9 Core context bridge (low)

- `BRIDGE_CONTEXT_FAILED` timeout 8 s lặp lại, 13 lần trong một phiên.
- Pack được tiêm vào chat không liên quan tới theme. Claim lấy từ scratch/plan cũ, và phân loại intent theo từ khóa.

## 3. Ưu tiên

| Mức | Việc |
|---|---|
| P0 | 2.1.1 provenance cho baselineViewports. Commit, restart và kiểm rule 5b (2.1.2). Cart probe (2.1.3) |
| P1 | 2.2 attribution/scope/serialize QA. 2.3 ownership tab theo terminal + HOST_WINDOW_HIDDEN. 2.4 click navigate = success. 2.5 bỏ `success:true` khi chưa verify, write_range |
| P2 | 2.6 locator text/role, set_control, inspect.network. 2.7 project remove + wake-up cho Leader. 2.8 alias/schema. 2.9 Core bridge |

## 4. Ngoài AntiFan (ghi ngắn)

- **omp-harness:** bash chặn cat/head/Select-String; TTSR ngắt nhầm khi thinking nhắc tới `rm`; eval kernel bị kill vì cell timeout 30 s; pool subagent giữ context giữa các batch.
- **skill-rules:** prompt cho worker Trello không nói rõ "ghi vào comment", nên Description bị sửa rồi phải revert. Có lúc agent bấm Create/Update theme Partners khi chưa được duyệt (S2 Corporate).
- **external:** Shopee Affiliate tự đăng xuất lúc khoảng 00:33 ngày 31/10. Comment trên dashboard F1GENZ nằm trong `devNote`.

## 5. Câu hỏi mở

- Nguyên nhân TARGET_STALE tập trung ở viewport 768 (Purity, 8 lần): emulation có reload document không?
- Tab vừa tạo chỉ sống khoảng 15 s (Levents `01a1870f`): ai đóng nó?
- Đăng xuất Shopee hoặc Google giữa chừng (TrueBeef profile-2): app hay site gây ra? Cần chạy theo skill `antifan-session-loss-triage`.
