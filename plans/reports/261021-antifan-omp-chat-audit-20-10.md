# AntiFan: điểm cần cải thiện, rút từ chat OMP ngày 20/10/2026

- **Phạm vi:** 19 session OMP (mọi project) có hoạt động từ 20/10 00:00 đến 23:59 (UTC+7), kèm 263 transcript subagent. Session mở từ trước chỉ lấy các entry trong khoảng này. `archive.sessions` trả đủ giới hạn 500 bản ghi, nhưng bản cũ nhất có `modified` 2026-09-21, trước đầu cửa sổ, nên danh sách không bị cắt trong khoảng audit [V].
- **Phương pháp:** stream JSONL thành digest cho từng session, 6 analyzer chạy song song, rồi đối chiếu throw site ở HEAD `dbfa259b` và với working tree.
- **Quy ước:** `[V]` là đã kiểm tra trên code hoặc git trong lần audit này. Không đánh dấu nghĩa là analyzer báo, dựa trên digest. `[INFERENCE]` là suy luận.
- **Working tree:** đang có thay đổi chưa commit của một task khác (cookie Companion, 7 file: `CHANGELOG.md`, `docs/research-cache-cookie-mechanism.md`, `extension/background.js`, `src/extension/domain-scoper.ts`, `src/main/bridge/bridge-server.ts`, `src/shared/identity-cookie-patterns.ts`, `test/main/extension-companion-pipeline.test.ts`). Audit này không động vào các file đó.

## 1. Số liệu

### 1.1 Gọi AntiFan MCP qua `write xd://mcp__antifan_browser_*` (main và subagent, chỉ đếm toolResult `isError`) [V]

Tổng cộng khoảng 1043 lần gọi, 85 lỗi (8,1%). Số này chưa tính các lần gọi qua helper trong `eval`, nơi có thêm `CAPABILITY_ERROR` ×9, `TARGET_MISMATCH` ×6, `REVISION_STALE` ×4 và `CONNECTION_CLOSED` ×5.

| Tool | Gọi | Lỗi | p50 | max | Mã lỗi |
|---|---:|---:|---:|---:|---|
| `anti.browser.evaluate` | 372 | 25 | 1,2 s | 19,8 s | CAPABILITY_ERROR 14, TARGET_MISMATCH 5, CONNECTION_CLOSED 4, NO_RENDER_SURFACE 2 |
| `anti.browser.navigate` | 143 | 6 | 2,2 s | 20,6 s | CONNECTION_CLOSED 2, NAVIGATION_TIMEOUT, TARGET_STALE, TARGET_MISMATCH, INVALID_ARGUMENT |
| `anti.screenshot.viewport` | 108 | 4 | 1,2 s | 20,2 s | CAPTURE_NOT_READY 3, NO_RENDER_SURFACE 1 |
| `anti.agent.sequence` | 62 | 12 | 4,7 s | 29,1 s | TARGET_STALE 9, TARGET_MISMATCH, EXECUTION_TIMEOUT |
| `anti.browser.rebind_target` | 26 | 7 | 0,2 s | 2,7 s | TARGET_MISMATCH 6, TARGET_STALE 1 |
| `anti.browser.tabs.get` | 10 | 5 | 0,1 s | 6,4 s | POLICY_DENIED 2, TARGET_STALE 2, CONNECTION_CLOSED 1 |
| `anti.agent.file_upload` | 8 | 4 | 0,2 s | 0,5 s | OUTSIDE_WORKSPACE 3, REF_NOT_FOUND 1 |
| `anti.browser.tabs.create` | 29 | 3 | 0,1 s | 1,4 s | TARGET_MISMATCH 2, TARGET_REQUIRED 1 |
| `terminal.wait` | 33 | 3 | 8,0 s | 25,1 s | SESSION_SLEEPING, EXECUTION_TIMEOUT, TERMINAL_FORBIDDEN |
| `anti.browser.tabs.list` | 39 | 3 | 0,16 s | 18,7 s | CONNECTION_CLOSED 2 |
| `anti.browser.set_viewport` | 47 | 2 | 0,7 s | 10,6 s | CAPABILITY_NOT_FOUND 2 |
| `anti.screenshot.full_page` | 44 | 2 | 4,7 s | 25,9 s | CAPTURE_NOT_READY, TARGET_MISMATCH |
| `theme.qa_validate` | 17 | 0 | 41,8 s | 79,3 s | (0 CERTIFIED trong mọi session theme) |

Có 13/19 session dùng AntiFan. Lỗi tập trung ở 4 nhóm: (a) authority và binding tab, gồm TARGET_MISMATCH, TARGET_STALE và POLICY_DENIED, tổng khoảng 35 lỗi; (b) mất kết nối bridge (CONNECTION_CLOSED/REVISION_STALE); (c) fence document-generation; (d) chặn capture.

### 1.2 Không phải lỗi AntiFan (để không đổ nhầm)

- **OMP harness:** guard bash chặn `cat/head/tail/sed -i`, khoảng 150–200 lần gọi phí trên mọi session. Ngoài ra: anchor của `edit` bị từ chối khoảng 90 lần; kernel `eval` chết (exit 130) khoảng 30 lần; subagent báo `No model selected` (session devs2 #01a14b07, shopify; người dùng đã sửa `modelRoles`); TTSR `destructive-commands` ngắt nhầm lệnh `proc://…/kill`.
- **Model:** báo vượt bằng chứng, các advisor đã bắt được. Ví dụ: khai `QA_INCONCLUSIVE` khi chưa chạy QA (giovanni); báo viewport 1440 trong khi receipt ghi 1920×900 (Mnbakery); "không có query ẩn" (Haravan search).

## 2. Các cụm cần cải thiện (xếp theo tác động)

### 2.1 Extension Companion ghi đè cookie Shopify, người dùng phải đăng nhập lại nhiều lần (high, ĐANG SỬA, chưa commit)

- **Session:** shopify #01a15848. Người dùng hỏi: "sao bắt tôi login hoài". Agent truy ra rằng mỗi handshake của Companion chép cookie `shopify.com` từ Chrome đè lên phiên Devs2.
- **Đã commit `b472fed6` và `63d56c0e`** [V]: commit cookie trong 5 s, journal cookie Google, chỉ trình Safari cho tài liệu đăng nhập Google.
- **Phần còn lại chưa commit** [V]: `isIdentityCookie` mở rộng cho cả host `shopify.com`, kèm test `extension-companion-pipeline.test.ts` (+60 dòng).
- **Còn mở (advisor nêu):** bulk hydration vẫn chạy ở mọi handshake, tức "eviction storm" vẫn còn. Guard cần chặn ở phía nhận (bridge-server), không chỉ ở `domain-scoper` của extension. Chưa verify live vì extension chưa kết nối lại.

### 2.2 Mất kết nối AntiFan giữa chừng: 3 sự cố, 3 nguyên nhân khác nhau (high, mở)

Đối chiếu timestamp trong JSONL với `runtime/bridge-client-failures.jsonl*` và `main.log.1` [V]:

- **Mnbakery 06:14–06:20Z: không phải bridge chết, mà bị từ chối scope rồi bị che nhãn sai.**
  - Agent nhận `CONNECTION_CLOSED code=4001 Unauthorized: missing or invalid token`.
  - Cùng thời điểm, `bridge-client-failures.jsonl` ghi `TERMINAL_SCOPE_UNRESOLVED: Terminal 'terminal-16' is claimed by project '…', whose window is detached (marked or mid-reattach) but not live — refusing to mint its agent tab into the hub window.` cùng với `MCP_BRIDGE_OFFLINE … (this is NOT a down bridge)`.
  - Như vậy bridge vẫn sống. Proxy biết lý do thật, nhưng agent chỉ thấy 4001, và fallback stdio thì báo `timeout initialize`.
  - Thời điểm trùng với cửa sổ session RESTOR #01a157d9 (05:46–06:19Z). Session này sửa boot-restore và restart live, kết quả "restored 1, skipped 11". `[INFERENCE]` Cửa sổ project Mnbakery bị skip, hoặc đang reattach, trong khi PTY `terminal-16` vẫn sống trong daemon. Đó là đúng trạng thái "terminal sống, cửa sổ project không sống" mà fix `bcc5fada` có thể tạo ra.
- **Lux Shoes 16:33–16:50Z: nguyên nhân chưa rõ, không phải restart app.**
  - 5 advisor subagent nhận `CONNECTION_CLOSED (1005)` cộng `REVISION_STALE`, hook báo `HEALTH_PID_DEAD` (`theme-qa-gate.ts:447`).
  - Trong khoảng này `main.log.1` chỉ có heartbeat của một PID duy nhất là 9932, khởi động khoảng 13:44Z, và `bridge-client-failures` không có dòng nào.
  - `[INFERENCE]` Phía chết là proxy hoặc kênh WS, không phải main process.
- **AntiFan #01a158cc 10:30Z:** báo `MCP server not connected: antifan-browser`, phía OMP, rồi chuyển sang `[PLAYWRIGHT-FALLBACK]`. Không trùng restart nào đã biết; nguyên nhân chưa xác định.
- **Restart thật trong ngày:**
  - 04:50–04:53Z (devs2, xem 2.11);
  - khoảng 06:1xZ (RESTOR);
  - khoảng 13:44Z (`ECONNREFUSED` ở `terminal-14`, PID 9932 boot).
- **Cần làm:**
  - Proxy không được đổi một lần refuse có mã (`TERMINAL_SCOPE_UNRESOLVED`) thành 4001 chung chung. Error tới agent phải mang mã gốc và bước phục hồi, ví dụ "mở lại cửa sổ project X".
  - Boot-restore cần xử lý project có terminal đang sống nhưng không nằm trong ledger: mở lại cửa sổ, hoặc gán lại terminal.
  - Proxy tự re-handshake khi nhận 1005, retry 1 lần.
  - Skill restart phải nhắc rằng các session OMP khác đang sống sẽ bị ảnh hưởng.
- **Throw site:** `bridge-server.ts:2045-2046` (4001) [V]; `attachment-registry.ts:796` (REVISION_STALE).

### 2.3 Session không có project anchor: không lấy được tab nào, kể cả tab người dùng đưa id (high, mở, lặp lại từ report 13/10 §3.4)

- **Unitedvision:** người dùng dán tab id 2 lần mà vẫn bị từ chối. Agent mất khoảng 8 lời gọi rồi thử PSI API (HTTP 429), sau đó chuyển sang Playwright.
- **Chuỗi lỗi:**
  - `TARGET_REQUIRED: 5 project windows are live and this request names no window, tab or sender` (`tab-ambient-authority.ts:66-69`) [V]. Thông báo không nói nguyên nhân là terminal chưa gán project, cũng không nói cách sửa.
  - `POLICY_DENIED` (`browser-control-port.ts:2387`).
  - `TARGET_MISMATCH` cho `anchorTabId` (`capability-transport.ts:754`). Nhánh này không có `recovery`, khác với nhánh `tabId` ở `:729-732`.
- **Cần làm:**
  - Thông báo nêu nguyên nhân, liệt kê project đang sống và bước phục hồi.
  - Thêm hành động phía người dùng "chia sẻ tab này cho agent session". Guard vẫn fail-closed, nhưng phải có đường hợp lệ.
  - Phát `bindingChanged {old,new}` khi attachment re-mint đổi bound tab. Unitedvision bị đổi bound tab 3 lần mà agent không được báo.

### 2.4 Fence document-generation chặn cả `navigate`, `wait` và `screenshot` (medium, mở) [V]

- `browser-control-port.ts:9011-9015`: `isEffectful = operationType === 'write' || 'lifecycle'` → mọi `agent.sequence` mở đầu bằng `navigate` vẫn bị TARGET_STALE khi SPA re-render nền.
- Trong 62 lần gọi `agent.sequence` có 9 lần TARGET_STALE. Các lần này rơi vào Shopify Dev Dashboard, accounts.shopify.com, cùng `wait 6000 + screenshot`.
- **Cần làm:** miễn fence cho bước không phụ thuộc DOM cũ: `navigate`, `wait`, `screenshot`, `snapshot`, cùng `pressKey` khi không có selector. Error trả về generation mới để lần retry đầu thành công.

### 2.5 ViewportGate "poisoned" khóa tab vĩnh viễn sau EXECUTION_TIMEOUT (medium, mở) [V]

- `browser-control-port.ts:1048` và `:1074` throw `TARGET_STALE: ViewportGate is poisoned due to unacknowledged action cancellation`. Thông báo không có recovery.
- Lux Shoes (AdvUiUxPro-2): sau một lần timeout, cả `pressKey Escape` cũng bị chặn, subagent phải bỏ tab.
- **Cần làm:** drain/ack tự động sau timeout, hoặc cho poison theo tab hết hạn theo thời gian. Thông báo nêu rõ `reload` hoặc `rebind_target` để xóa poison.

### 2.6 Theme QA: không có đường CERTIFIED hợp lệ, receipt trộn finding mới với finding có sẵn (medium, mở, lặp lại từ report 16/10 §1.1)

- `theme.qa_validate` chạy 17 lần, 0 lần CERTIFIED. Mọi session theme (Lampro, giovanni, Mnbakery, OwlBrand, aoiconcept, Phukienmaymoc, Lux Shoes, shopify) đều kết thúc DONE_WITH_CONCERNS.
- **Lux Shoes:** rebuild từ đầu nên không có baseline. Agent tự promote ảnh vừa chụp rồi so với chính nó, advisor phải chặn vòng này.
- **shopify:** `[HotReload] Connection closed…` và `[shopify-account] Menu … not found` bị chấm là console critical.
- **Lampro:** agent phải tự trích `differential.introducedRegressions` bằng jq.
- **Cần làm:**
  - `summary` có số đếm `introduced / preexisting / legacy` theo severity, kèm selector của các finding introduced.
  - `certificationReasons` nêu đúng 1 lời gọi để khắc phục.
  - Thêm chế độ greenfield có khai báo lý do.
  - Phân loại nhiễu dev-server là info.
  - Ghi `viewportsTested` và `theme.id/role` vào receipt. Unitedvision từng đổi main theme giữa chừng mà không tool nào báo.
- **Thời gian:** p50 41,8 s, max 79 s mỗi lần gọi.

### 2.7 Thiếu công cụ ghi Google Sheet: agent tự lái UI Sheets bằng helper `evaluate`/phím (medium, mở)

- **Mnbakery:** agent tự viết helper `safeType`/`selCell` gõ phím vào giao diện Sheets qua `anti.browser.evaluate` và `anti.agent.sequence`. AntiFan không có tool ghi sheet.
  - Helper báo `cannot select G386` và `cannot select A394`. Có lúc name box kẹt ở `A393` khi đang chọn `A394`.
  - Ô A1 (header) trống trong CSV lúc 05:55Z, đến 09:57Z thì thành `Fixed`. Khoảng này trùng các lần agent ghi dòng 387/388/373. Agent hỏi lại, và người dùng chọn "Xoá chữ ở A1" [V].
  - Chưa xác nhận ai gõ vào A1: agent hay một người sửa khác `[INFERENCE]`.
- **Cần làm:** thêm `anti.sheet.write_cell`/`update_row` làm đối của `anti.sheet.extract`: định địa chỉ A1, đọc lại để xác nhận, trả về giá trị cũ, và từ chối ghi khi chưa xác nhận đúng ô đang chọn.

### 2.8 Thông báo lỗi chỉ sai đường hoặc mơ hồ (low–medium, mở)

| Lỗi | Vấn đề | Vị trí |
|---|---|---|
| CAPTURE_NOT_READY | Gợi ý `materializeDataSrc:true` cho mọi tool, nhưng `anti.screenshot.viewport` không có tham số này (chỉ `full_page` `:2947`, `reference.capture` `:2898`, promote `:3790/3819`). Lampro theo gợi ý và gặp lại cùng lỗi. | `capture-settle.ts:1095` [V] |
| URL_HOST_MISMATCH | Tab trống báo `Malformed observed URL ''` thay vì "tab chưa navigate". Agent đọc nhầm thành QA_UNAVAILABLE. | `visual-capture.ts:1362` [V] |
| OUTSIDE_WORKSPACE | Không liệt kê root hợp lệ, không nói check nào (workspaceRoot hay file path) fail. Gác phải chuyển project sang `apps/`. | `workspace-resolver.ts:135` [V] |
| TARGET_MISMATCH "unknown tab" | Tab đã chết nhưng báo mismatch, không có gợi ý (nên là TARGET_STALE). | `browser-control-port.ts:4649` |
| PROBE_FAILED | Tab `about:blank` chưa attach bị gộp thành mã chung. | `browser-control-port.ts:5201` |
| CAPABILITY_ERROR | Exception trong biểu thức của trang (TypeError null) dùng chung mã với lỗi tool. Nên tách `EVAL_EXCEPTION` kèm dòng stack. | `tab-devtools-host.ts:3464/3606` |
| NO_RENDER_SURFACE | Timeout probe 3000 ms trên tab thật bị báo là "không có surface". Nên tách khỏi CAPTURE_TIMEOUT và tự retry 1 lần. | `browser-control-port.ts:2827-2842` |
| `terminal.wait` timeout | Chỉ trả "Terminal wait aborted", không có tail output. | `terminal_wait` |
| Edit-guard | "send [🧠Core-Context]" không phải hành động agent làm được; finding settings trỏ `:1` của schema minified. | theme-qa-gate hook |

### 2.9 Hành vi nhỏ

- `anti.browser.evaluate` trả shape không ổn định: có lúc là chuỗi JSON, có lúc object, có lúc chuỗi dính note `\n\n[…]`. Mnbakery gặp 3 lần JSON.parse fail liên tiếp. Nên dùng envelope `{value, truncated, bytes}`.
- Nên hỗ trợ `timeoutMs` cho `evaluate` (hiện cố định 15 s) và cho `navigate` (20 s).
- `tabs.close` trên tab đã mất nên là no-op. `navigate about:blank` bị từ chối (`:2410`).
- Nên cho `agent.sequence` nhận `steps` làm alias của `actions`.
- `terminal.list` nên đánh dấu `owned:false`.
- `theme.settings_check` nên nhận scope `files`/`changedSince`.

### 2.10 Hiệu năng và benchmark (medium, mở; analyzer báo từ session devs2 #01a14b07)

- p50 tổng của 96 tool tăng từ 15,1 s (09/10) lên 28,5 s. `screenshot.full_page`, `inspect.responsive_matrix` và visual compare chậm hơn 3–9 lần. Agent nghi commit `311e39a7` cho full-page, chưa bisect.
- Benchmark harness: `theme.qa_validate` lỗi `WORKSPACE_NOT_THEME` do fixture thiếu `layout/theme.liquid`; còn `uncovered 23`.

### 2.11 Hai main process AntiFan chạy cùng lúc trong lúc restart (rủi ro cao, nguyên nhân chưa rõ)

- **devs2 #01a14b07, 04:50:34Z:** lệnh `taskkill //PID 13804` hỏng cú pháp, nhưng `Start-Process node scripts/run-electron.cjs . --allow-eval` vẫn chạy, làm phát sinh PID 19164 (cha là node 20408) [V].
  - Lúc 04:51:04Z agent ghi nhận "2 bản: cũ 13804, mới 19164", rồi dùng `Stop-Process` tắt cả 3 process lúc 04:51:18Z và khởi động lại một bản.
  - Hai bản cùng chạy khoảng 45 s.
- **Rủi ro:** hai main process trên cùng profile có thể hỏng Cookies/SQLite. Lẽ ra `requestSingleInstanceLock` (`index.ts:843`, lock theo userData đặt từ `ANTIFAN_DATA_ROOT` ở `:269-293`) phải chặn bản thứ hai.
- `main.log` của 04:50Z đã rotate, nên không xác định được bản thứ hai chạy trên data root khác (do env của terminal lọt vào) hay lock thật sự không chặn. Hai khả năng này dẫn tới hai chủ sửa khác nhau: skill restart, hoặc `index.ts`.

## 3. Gốc xuyên cụm

1. **Fail-closed mà không có đường phục hồi.** Lỗi đã lặp lại từ 10/10 và 13/10. Authority, generation fence, ViewportGate và attachment re-mint đều refuse đúng thiết kế, nhưng thông báo thiếu `recovery`, `candidateTabIds` và lý do. Agent phải đoán và rebind nhiều lượt.
2. **Thay đổi trạng thái app (restart, boot-restore) làm vỡ các phiên đang sống, và lý do thật bị che.** Bridge vẫn sống nhưng refuse theo scope, còn agent chỉ thấy 4001.
3. **QA đo tốt nhưng không tách được "lỗi của tôi" với "lỗi có sẵn".** Vì vậy không session nào kết thúc VERIFIED_COMPLETE.

## 4. Ưu tiên đề xuất

**P0**
- 2.1 Hoàn tất fix cookie Companion: commit phần đang dở, chặn bulk hydration ghi đè identity cookie ở phía nhận, restart app, verify live sau một lần handshake.
- 2.2 (phần Mnbakery) Proxy chuyển nguyên mã `TERMINAL_SCOPE_UNRESOLVED` cùng recovery tới agent thay vì 4001; boot-restore xử lý project có terminal sống.

**P1**
- 2.7 Thêm `anti.sheet.write_cell` có read-back, để agent không phải tự gõ phím vào UI Sheets.
- 2.11 Điều tra vì sao 2 instance AntiFan cùng chạy. Có rủi ro hỏng profile nên giữ ở P1 cho tới khi rõ nguyên nhân.
- 2.2 (phần còn lại) Proxy tự re-handshake khi nhận 1005, giữ affinity tab qua restart.
- 2.3 Thông báo TARGET_REQUIRED/anchor có recovery, cùng đường "chia sẻ tab cho agent".
- 2.4 Miễn fence generation cho navigate/wait/screenshot. Sửa nhỏ, test được ngay.
- 2.5 Có cách gỡ poison cho ViewportGate.
- 2.6 Thêm `summary.introduced/preexisting` vào receipt QA, ghi `viewportsTested` và `theme.id`.

**P2**
- 2.8 và 2.9: thông báo lỗi, envelope evaluate, timeoutMs.
- 2.10: bisect regression latency, sửa fixture benchmark.

## 5. Contract bàn giao cho P1-2.4 (cụm sửa nhỏ nhất)

- **Outcome:** `anti.agent.sequence` mở đầu bằng `navigate`, hoặc chỉ gồm `wait`/`screenshot`, không bị TARGET_STALE khi document generation đổi trong nền. Click/type theo selector cũ vẫn bị fence.
- **File:** `src/main/tools/browser-control-port.ts` (khoảng `:9011` và nhánh `:4965`), cùng test trong `test/main/`.
- **Acceptance:** test đỏ trước khi sửa, xanh sau khi sửa với hai sequence `[navigate]` và `[click selector]` khi generation lệch. `npm run test:fast` xanh, ngoài lỗi đã biết `core-health-cli-deadline`.

## 6. Đã sửa trong ngày (theo git)

- `bcc5fada`: boot chỉ mở lại các cửa sổ đang mở lúc thoát, và mở lại Terminal Manager. Đã verify live: restored 1, skipped 11.
  - Còn thiếu test trực tiếp cho nhánh `terminal-manager-open intent:"restore"`.
- `dbfa259b`: tìm section Terminal Manager theo tên.
  - Modal tìm tab trên toolbar chưa có test tương tự.
- `b607bc1c`, `21fbd703`: QA ổn định trên run dài và PDP Haravan; bỏ ngưỡng 44px.
- `05d724d3`: thêm `E:\Work\shopee-reels` vào workspace root được phép.
  - Root vẫn hard-code, cụm 2.8 OUTSIDE_WORKSPACE vẫn mở.

## 7. Câu hỏi còn mở

- Lux Shoes 16:33Z: kênh nào chết (proxy stdio hay WS), khi main PID 9932 vẫn sống và không có bridge failure nào được ghi?
- Cửa sổ project Mnbakery lúc 06:14Z: bị skip theo ledger hay đang reattach? `main.log` của khoảng đó đã rotate.
- 2.11: instance thứ hai được chạy với `ANTIFAN_DATA_ROOT`/userData khác (lock theo userData, `index.ts:269-293`) hay lock thật sự không chặn?
- Regression latency là do `311e39a7` hay do tải máy lúc đo? Cần bisect với benchmark đã sửa fixture.
