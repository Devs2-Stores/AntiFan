# AntiFan: điểm cần cải thiện, rút từ chat OMP 25/10 → 27/10/2026

- **Phạm vi:** 27 session OMP có hoạt động từ 25/10 00:00 (+07), không tính session audit này. Có 27 scout chạy song song, mỗi scout đọc 1 chat. Tổng 187 issue, trong đó 140 issue thuộc `owner: app`.
- **Dữ liệu:** digest ở `E:/Work/scratch/omp-digest-261027/`. Output đầy đủ của các scout nằm trong `_scouts_raw.json`, bản rút gọn trong `_issues.txt`.
- **Quy ước:** `[V]` nghĩa là đã kiểm tra trên code HEAD `c1ee6b60` hoặc trên log runtime trong lần audit này. `[INFERENCE]` là suy luận.
- **Working tree:** đang có thay đổi chưa commit của task khác (`image-frame-scanner.ts`, `theme-qa-workflow.ts`, `index.ts`, `project-windows.test.ts`, …). Audit này không đụng tới các file đó.

## 1. Số liệu

- Lệnh gọi AntiFan MCP trực tiếp, gồm cả subagent: khoảng **6515 lần, 579 lỗi (8,9 %)**. Ngoài ra còn ≥790 lần gọi qua `eval` (`tool.write`, `tab.call`) mà bảng không đếm được. Riêng Lux Shoes có ≥226 lần `qa_validate` đều chạy trong eval.
- Các tool gọi nhiều nhất (số lần / số lỗi): `evaluate` 2571/135, `set_viewport` 491/22, `navigate` 397/41, `screenshot.viewport` 332/19, `cursor.click` 311/33, `tabs.create` 199/29.
- Playwright fallback: khoảng 540 lần gọi. Phần lớn là YouTube Studio, vì Google không cho đăng nhập trong AntiFan (Studio, Cart, Slot27, SlotSync).
- **Bridge mất kết nối [V]:** đếm theo `runtime/bridge-client-failures.jsonl`, có 6 cụm `MCP_BRIDGE_OFFLINE`/`CONNECT_FAILED`, mỗi cụm 49–154 dòng. Thời điểm các cụm khớp với các lần restart live app từ chính session dev AntiFan:

| Cụm (+07) | Lỗi | Restart / commit liền kề |
|---|---|---|
| 25/10 21:30 | 71 | MDVIEW `f8b5c61d` 21:30 |
| 25/10 22:10 | 84 | MDVIEW `d9e19225` 22:28 |
| 26/10 14:00 | 49 | WEB `de7e11b6` 14:13. Lampro rớt bridge lúc 14:04:57, Whenever lúc 14:07 |
| 26/10 14:50 | 154 | `881b90d8`/`212d04cd` 14:48–14:54 |
| 26/10 15:50 | 54 | Chưa xác định: commit `14d921b7` lúc 15:56 là sau khi cụm bắt đầu, và chưa tìm được bản ghi restart |
| 26/10 16:20 | 117 | `efd2cba1`/`f2bb5b0b` 16:12–16:18 |

## 2. Các cụm cần cải thiện (xếp theo tác động)

### 2.1 Restart live app khi đang dev AntiFan làm hỏng mọi session khác (high, mở; nhân quả [INFERENCE])

- 5/6 cụm outage trùng giờ với hoạt động restart của session AntiFan (MDVIEW, WEB). Bằng chứng: Lampro `HEALTH_PID_DEAD` lúc 14:04:57, `main.log` có pid 15836 boot khoảng 16:22, và giờ commit đứng ngay sau đó. [INFERENCE] Đây là quan hệ nhân quả, nhưng 4/6 cụm không có bản ghi boot vì `main.log.1` chỉ bắt đầu từ 26/10 17:35 (+07). Cụm 15:50 chưa giải thích được. Lúc đó TrueBeef, Phukien, Lampro, Levents, Whenever và Epres đang ghi sheet hoặc chạy QA.
  - Lampro: `HEALTH_PID_DEAD` giữa lúc ghi sheet.
  - Phukien: autoheal bỏ cuộc (`ECONNREFUSED :20130`) khoảng 20 s trước khi bridge mới listen.
  - Whenever: tab dev được restore với `attached:true` nhưng `reload` trả `TARGET_STALE`.
  - Lux Shoes: tab form Partners bị mồ côi.
- Agent không biết là app vừa restart. Thông báo lỗi không nhắc tới restart, nên agent tự đổ lỗi cho mình (VidAff), còn scout của Levents và Whenever ghi là "nguyên nhân chưa rõ".
- **Cần làm:**
  1. Dev verify trên instance cô lập: thêm `scripts/lib/isolated-instance.cjs` (MDVIEW đề xuất). Chỉ restart bản live khi user yêu cầu.
  2. Autoheal poll `bridge.json` hoặc port mới trong 30–45 s trước khi trả `CONNECTION_FAILED`.
  3. Lỗi `CONNECTION_FAILED`, `EXECUTION_UNCERTAIN` và lệnh gọi đầu tiên sau restart phải mang `appRestartedAt`, `retryAfterMs`, và cho biết lệnh đã tới app hay chưa.
  4. `tabs.list` chỉ báo `attached:true` khi tab đã có CDP target.

### 2.2 Subagent song song dùng chung một attachment và bound tab (high, mở, lặp lại từ 13/10 và 20/10)

- Gặp ở 7 session: Slot, Epres, SlotSync, Cart, Slot27, Mnbakery, Lampro.
  - Epres có khoảng 75 lần `rebind_target` và ≥15 lần `TARGET_MISMATCH`.
  - Agent không đóng được tab do chính nó tạo, vì `browser-control-port.ts:5120` từ chối close mọi tab khác bound tab [V]. Thông báo lỗi lại bảo user click chuột phải.
  - Tab mồ côi lấp đầy giới hạn 10 tab mỗi session (Epres ≥15 lần `POLICY_DENIED`).
- Một lệnh có `tabId` tường minh âm thầm dời binding mặc định. Ở Mnbakery, `set_viewport reload:true` chạy nhầm vào tab Google Sheet mà vẫn báo thành công.
- **Cần làm:**
  - Ghi ownership theo từng tab: attachment tạo ra tab và chuỗi anchor của nó. Tab do session tạo thì session đóng được, navigate được.
  - Lệnh có `tabId` tường minh không được đổi default binding, hoặc phải phát `bindingChanged{reason:'explicit-tabId'}`.
  - Thêm `tabs.create({bind:true})` để gộp create và rebind làm một lệnh.
  - Khi session hoặc subagent kết thúc thì thu hồi tab của nó.

### 2.3 `anti.sheet.write_cell` báo lỗi trong khi giá trị đã ghi (high, mở; phần verify vào từ `087329bb` 24/10)

- Gặp ở 6 session: Phukien 13/13 lần gọi lỗi, TrueBeef 4, Whenever 5, Lampro, Mnbakery, Levents.
- Read-back GViz chỉ thử `GVIZ_ATTEMPTS = 3` lần, mỗi lần cách `700 ms`, tổng khoảng 1,4 s (`sheet-capabilities.ts:44-46`, `:402-420`) [V]. Agent quan sát thấy Sheets lưu trễ 20–60 s.
- Không xử lý giá trị nhiều dòng [V]: `write_cell` gõ nguyên `value` vào formula bar (`agentType({text: value, clear: true})`) rồi nhấn Enter một lần (`sheet-capabilities.ts:353-355`). Không có bước nào xử lý `\n`. Không có rollback: `recovery` (`:342`) bảo caller tự khôi phục giá trị cũ. Lampro mất `\n` mà cell vẫn bị sửa. Levents phải tự viết đường F2 + `insertText`.
- Khi timeout, viewport lock bị kẹt (`Viewport lock acquisition aborted`, Phukien ×6, Whenever ×3), và draft còn nằm trong editor (Mnbakery).
- **Cần làm:**
  - Poll GViz tới 60–90 s. Trả trạng thái `SAVED_UNCONFIRMED` hoặc `committed: true|unknown` thay vì `EXECUTION_TIMEOUT`.
  - Hỗ trợ nhiều dòng (Alt+Enter hoặc paste), thêm mode `append`/`replace`.
  - Khi timeout hay abort phải nhả ViewportGate và discard draft.

### 2.4 `terminal.wait` vẫn abort ở khoảng 25 s: clamp sai ngân sách (high, mở) [V]

- `TERMINAL_WAIT_MAX_TIMEOUT_MS = 30_000 − 2_000 = 28_000` (`terminal-capabilities.ts:99-103`). Nhưng policy khai `timeoutMs: 30_000` và `cancellationAckTimeoutMs: 5_000` (`:453-457`). Transport tính `executionDeadlineMs = 30_000 − 5_000 = 25_000` (`capability-transport.ts:696-698`).
- Vì vậy wait mặc định bị platform abort ở giây 25 (`WAIT_ABORTED: Terminal wait aborted`, `daemon-client.ts:790/802`), trước khi tự trả `timedOut/lastSeq` ở giây 28.
- Hậu quả: Epres có khoảng 22 lỗi trên khoảng 30 lần wait, TrueBeef 5, TrueBeefQa 3. Scout của TrueBeefQa đoán nhầm là app chạy build cũ.
- Test `terminal-wait-budget-and-stale.test.ts:50` chỉ assert `MAX < BUDGET`, không so với execution deadline.
- **Cần làm:** đặt `MAX = BUDGET − cancellationAck − margin` (23 s), hoặc nâng budget. Sửa test để assert `MAX < executionDeadline`.

### 2.5 Theme QA: không đạt được CERTIFIED vì probe flaky và attribution sai (high, mở, lặp lại từ 16/10 và 20/10)

- **`CLOSE_ESCAPE_FAILED` flaky.** Lux Shoes ghi nhận 117 lần, có lúc đạt lúc trượt trên cùng trang và cùng width. Kết quả: Sapo 0/65 CERTIFIED, Haravan 51/65.
  - Khi bấm Escape thật qua `agent.sequence`, drawer đóng 12/12 lần.
  - Nguyên nhân dự đoán [INFERENCE], cần chứng minh bằng fixture (xem §8). Ứng viên 1 [V là đoạn code đúng như mô tả]: `measureClose` (`state-matrix.ts:1078-1081`) chỉ đo một lần sau `settle()`, nên drawer có animation chậm sẽ bị đọc là chưa đóng. Ứng viên 2 [V]: khi arm script hoặc read script ném lỗi, `escapeProbe = null` (`:972-974`). Lúc đó `escapeNotClosing` bỏ qua cả 3 nhánh UNMEASURED và ghi critical `CLOSE_ESCAPE_FAILED` (`:984-985`) dù không đo được gì.
  - Cần poll trạng thái đóng có deadline. Khi trượt lần đầu thì retry trigger rồi ghi là `flaky`, không ghi critical.
- **Attribution [V].** Không có baseline thì mọi finding không thuộc diagnostics đều bị dán nhãn `legacy`, kể cả `differential.introducedRegressions` (`theme-qa-workflow.ts:1397-1402`).
  - Levents: attribution báo 0 lỗi mới, trong khi differential liệt kê 120 critical. Mnbakery, Whenever và Lampro cũng gặp mâu thuẫn tương tự.
  - Cần làm: không có baseline thì trả `attribution: unavailable`.
- **Kết quả khó đọc:** finding không có khóa chung (`type`/`kind`/`ruleId`), critical nằm lồng sâu (`findings.strictFailures`), và `viewports` mang hai nghĩa khác nhau.
  - Cần làm: thêm `summary.criticalCodes[]`, `summary.byRule`, gán `ruleId` cho mọi finding, và đổi tên `viewports` của `qa_validate`.
- **Remedy:**
  - CERTIFIED không đạt được bằng các remedy được liệt kê.
  - Domain QA chạy ở tab nền báo `domUnstable` mà không nói lý do là tab không ở foreground (Epres).
  - `qa_validate` reload trang nên xóa style override, và không có cách chạy riêng một scanner (TrueBeef).

### 2.6 `anti.visual.compare` gần như không dùng được trên trang động (high, mở)

- Epres có ≥25 lần lỗi, agent bỏ hẳn tool và tự tính pixel diff bằng PIL. Lux Shoes gặp `INCONCLUSIVE: Capture transaction was never coherent` ở home, article và product, kể cả với positive control. Toast pop-sale khiến cả route bị tính là STRUCTURAL.
- **Cần làm:**
  - Settle từng tab riêng khi dùng `comparisonTabId`.
  - Trả diff một phần kèm cờ low-confidence thay vì `null`.
  - Tự freeze hoặc mask các toast/pop-sale thường gặp, và báo bên nào đang làm tăng `mutationRevision`.

### 2.7 Fence document-generation chặn cả lệnh theo selector (medium, mở, lặp lại 2.4 của 20/10)

- `TARGET_STALE` trên SPA hoặc trang tự re-render: SlotSync 16 lần, VidAff 14, Cart 7, Slot 4, Slot27.
- Ở TikTok, agent gọi khoảng 34 lần `inspect.snapshot` chỉ để làm mới generation.
- `cursor.click` tự rebase còn `cursor.type`, `file_upload` và `cursor.scroll` (chỉ dùng tọa độ) thì không.
- **Cần làm:** bước theo selector thì resolve lại trên document đang sống. Chỉ chặn `@eN` ref và tọa độ đã cũ. Lỗi phải mang generation hiện tại.

### 2.8 Timeout, schema và tài liệu lệch với hành vi thật (medium, mở)

- `evaluate` mặc định 15 s (`EVAL_JS_DEFAULT_TIMEOUT_MS`, `tab-devtools-host.ts:320`) [V], trong khi tài liệu và agent tưởng là 25 s. Đã có `timeoutMs` nhưng schema quảng bá ra ngoài là `Args = unknown` cho cả `wait`, `agent.sequence` và `evaluate` (SlotSync, VidAff, TikTok, Slot27).
- `navigate` không có `waitUntil` (`navigateInputSchema`) [V]. Facebook và Shopee không bao giờ phát "load", nên lệnh timeout ở 20 s dù trang đã dùng được (Fanpage, Cart, TrueBeef). `NAVIGATION_START_TIMEOUT` 3 s báo lỗi trong khi trang vẫn đang tải.
- `beforeunload`: `navigate` treo 30 s, còn `dialog.get` báo không có dialog trong lúc guard chặn với `DIALOG_OPEN` (Fanpage ×4).
- `agent.sequence` với step thiếu `type`:
  - Executor trả `success:false, reason:"Unsupported action type: undefined"` (`tab-automation-host.ts:1696-1698`) [V], nhưng `success:false` không được map sang `isError` [V, không có chỗ nào kiểm `success === false` trong `src/main/tools`]. Agent đọc thành thành công và suýt kết luận "AntiFan không bấm được Escape" (Lux Shoes).
  - Cần làm: validate schema ngay từ đầu, và đánh dấu kết quả là lỗi khi `success:false`.
- Mã lỗi thật nằm trong phần text, không nằm ở trường `code`. Lỗi `evaluate` là text thuần còn thành công là JSON. Lỗi `TARGET_BUSY_DRAINING` không tự chờ.
- **Cần làm:** publish JSON schema thật, thêm `waitUntil: commit|domcontentloaded|load`, và trả envelope lỗi có cấu trúc `{code, retryable, retryAfterMs}`.

### 2.9 Tab nền và render surface (medium, mở)

- Các lỗi gặp phải:
  - `NO_RENDER_SURFACE`: probe 3000 ms quá ngắn khi máy chịu tải.
  - `VIEWPORT_NOT_APPLIED`: tab đo được 980 px khi yêu cầu 768.
  - Scrollbar 15 px lệch giữa các origin trong cùng một tab.
  - `CAPTURE_FRAME_STARVATION`.
  - `cursor.click` trên tab không active trả `clicked:true` nhưng trang không có focus.
- Gặp ở Lux Shoes, Epres, SlotSync, Slot, Phukien và Whenever.
- **Cần làm:**
  - Probe thích ứng theo tải và retry một lần.
  - Thêm `set_viewport({hideScrollbar|contentWidth})` và trả về `clientWidth`.
  - Tự present cửa sổ ở chế độ unfocused cho capture, đúng như đường `agent-visible` đã có.

### 2.10 Profile, danh tính và anti-bot (medium, mở)

- Chỉ có `persist:profile-profile-2`.
  - Không chạy song song được hai tài khoản của cùng một dịch vụ (SlotSync, Fanpage, Slot).
  - Đổi kênh YouTube hoặc actor Facebook ảnh hưởng mọi agent đang dùng profile.
  - 14 agent dùng chung profile và IP dẫn tới Shopee verify/captcha (Slot27, Cart).
- Google không cho đăng nhập trong AntiFan, nên YouTube Studio phải chạy qua Playwright (khoảng 290 lần gọi ở Studio, cùng Cart, Slot27 và SlotSync).
- **Cần làm:**
  - Có profile được đặt tên theo kênh hoặc dự án.
  - Lease theo origin và profile, lỗi `ANTI_BOT_CHALLENGE` fail-fast cho tới khi challenge được giải.
  - Kiểm tra vì sao Google từ chối (UA hay fingerprint) bằng skill `antifan-session-loss-triage` và `antifan-browser-fingerprint-probe`.

### 2.11 API thiếu hoặc khó dùng (low–medium)

- `tabs.list` chỉ có `all`, `affiliatedOnly` và `projectId` (`browser-capabilities.ts:3038-3044`) [V]. Mỗi lần gọi trả 9–55 KB (Cart, Mnbakery, F1Sheet, Fanpage, Slot27 ×12). Cần thêm `urlContains`, `fields`/compact và `limit`.
- Thiếu tính năng:
  - `inspect.network`: TikTok phải tự hook fetch/XHR.
  - Lưu kết quả `evaluate` hoặc file download ra artifact (VidAff).
  - `saveTo` cho screenshot (Whenever).
  - `capture_secret`.
  - `fromEnv` nhận alias: hiện chỉ nhận `ANTIFAN_SECRET_*`, nên agent phải đẩy `PASSALL` qua `evaluate` (Slot).
  - `cursor.click` theo text hoặc role: Slot dùng tọa độ cứng 39 lần.
- Thông báo lỗi:
  - `file_upload OUTSIDE_WORKSPACE` không nói path nào bị từ chối và cách cho phép (VidAff ×4).
  - `TARGET_OBSCURED` khi phần tử che là con của chính control, ví dụ thumb của switch (TikTok).
  - `style_override` không có `tabId` thì báo `applied:true` nhưng tab được bound không đổi (TrueBeef) [INFERENCE: nghi tab mặc định đã bị dời, xem 2.2].
- Stdio proxy `antifan-agent.cjs` chỉ nhận `--tab=<id>`. Agent phải đọc `saved-tabs.json` để tìm tab (Fanpage). Cần thêm `--project`.

### 2.12 Tooling dev AntiFan (medium)

- `scripts/antifan-restart.ps1` nhánh `-Force`: sleep cố định 2 s rồi `exit 1 MAIN_STILL_ALIVE` và không relaunch (MDVIEW). Cần poll tới 15–30 s giống vòng lặp ở dòng 70-77.
- Khi bị từ chối với `haltedBy: busy`, script không nói thứ gì đang busy, nên mỗi lần restart user phải duyệt `-Force` (WEB ×3).
- Worktree verify dùng junction trỏ vào `node_modules` thật. `git worktree remove --force` đã xóa luôn nội dung `node_modules` (WEB, high). Cần script `verify-in-worktree.ps1` gỡ junction trước khi xóa worktree.
- Driver e2e viết bằng template literal nên dính bẫy backtick và escape. Nên tách ra file `.js` riêng.
- Autostart từng mở `hrv theme dev` thứ hai. Đã sửa bằng `afad5d59` và `f2bb5b0b`.

## 3. Gốc xuyên cụm

1. **Một attachment cho cả cây agent.** Gốc của 2.2. Nó cũng góp phần vào 2.3 (lock) và 2.9 (tab nền), và lặp lại trong mọi session có fan-out.
2. **Ngân sách thời gian không nhất quán giữa các lớp:** policy, execution deadline, in-page budget và tài liệu. Đã chứng minh ở 2.4, gặp lại ở 2.3 và 2.8.
3. **Verify chặt nhưng thiếu đường hồi phục và thiếu trạng thái "chưa chắc".** Gặp ở `write_cell`, `qa_validate` attribution, `visual.compare` và fence. Kết quả là đúng thì vẫn báo lỗi, còn sai thì lại gắn nhãn `legacy`.
4. **Live app bị dùng chung cho cả việc dev lẫn công việc thật.** Mỗi lần restart để kiểm tra code làm rớt mọi session khác (2.1).

## 4. Ưu tiên đề xuất

**P0**
- 2.4: sửa clamp `terminal.wait` (một dòng hằng số và một test). Nhỏ nhất, đã chứng minh.
- 2.3: `write_cell` poll lâu hơn, trả trạng thái `SAVED_UNCONFIRMED`, nhả lock khi timeout, hỗ trợ nhiều dòng.
- 2.5: poll trong `measureClose` và ghi `flaky` thay vì critical; attribution thành `unavailable` khi không có baseline.

**P1**
- 2.2: ownership theo tab, `tabId` tường minh không dời binding, `tabs.create bind:true`.
- 2.1: harness instance cô lập cho dev, autoheal chờ bridge mới, thông báo `appRestartedAt`.
- 2.8: schema thật cho `wait`/`sequence`/`evaluate`, `navigate.waitUntil`, map `success:false` thành lỗi.
- 2.7: fence chỉ chặn ref và tọa độ.

**P2**
- 2.6 compare coherence, 2.9 tab nền, 2.10 profile được đặt tên và lease, 2.11 filter cho `tabs.list` và các tool còn thiếu, 2.12 restart script và worktree script.

## 5. Contract bàn giao cho P0-2.4 (fix nhỏ nhất)

- **Outcome:** gọi `terminal.wait` không truyền `timeoutMs` (hoặc truyền ≥ 25 s) sẽ trả `satisfied:false, timedOut:true, lastSeq` trước khi platform abort. Không còn `WAIT_ABORTED`.
- **File:** `src/main/tools/terminal-capabilities.ts:99-103` và `test/main/terminal-wait-budget-and-stale.test.ts:50`.
- **Verify:** test assert `TERMINAL_WAIT_MAX_TIMEOUT_MS < TERMINAL_WAIT_BUDGET_MS − cancellationAckTimeoutMs`. Probe thật: một wait output-match không khớp trên một pane không có output phải trả `timedOut` ở khoảng 23 s.

## 6. Đã sửa trong cửa sổ (theo git `origin/main`)

- `14d921b7`: đóng cửa sổ web của project khi terminal dừng (yêu cầu từ Epres).
- `efd2cba1`: tìm kiếm fuzzy chỉ khớp trong phạm vi một từ.
- `afad5d59` và `f2bb5b0b`: autostart không mở watcher trùng.
- `de7e11b6`, `55b2edaa`, `75520734`, `f7b66342`: cửa sổ do agent mở, sửa lỗi tab trắng.
- `f8b5c61d` và `d9e19225`: Markdown và video viewer. Phím tắt video và header hẹp đã sửa.

## 7. Không phải lỗi AntiFan

- Kernel `eval` của OMP reset làm mất helper (Lux Shoes ×4).
- Model dùng sai tham số (`files` thay cho `filePaths`, `action` thay cho `type`). Phần schema thiếu thì đã tính vào 2.8.
- Theme watcher `hrv theme dev` push trễ thuộc CLI và môi trường user. Riêng phần AntiFan không báo pane đã mất watcher sau restore (TrueBeefQa) thì thuộc 2.1.

## 8. Câu hỏi còn mở

- Tại sao Google từ chối đăng nhập trong profile AntiFan: UA, fingerprint, hay cookie bị mất sau restart?
- Lux Shoes: vì sao cùng một tab lại có scrollbar 15 px ở origin Sapo và 0 px ở origin Haravan?
- TrueBeefQa: giá trị test trong form Thiết lập quay lại server sau khi đã restore và verify. Nguyên nhân chưa xác định.
- 2.5: `measureClose` có đo quá sớm so với animation của theme không? Cần một fixture có drawer animation dài hơn 450 ms để chứng minh.
