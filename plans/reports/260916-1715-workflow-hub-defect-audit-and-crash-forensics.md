# Workflow & MCP Hub — audit defect + điều tra crash

Ngày: 2026-09-16 (giờ local, UTC+7). Máy: Windows 11, 16 GB RAM.
Repo: `E:/Work/apps/AntiFan`. App data root: `E:/Work/.antifan-data`.

Xuất phát: user báo app liên tục bị văng khi đang làm việc, và yêu cầu kiểm tra report/issue trong Hub.

Cách làm: controller dựng evidence packet bất biến (`.tmp-af-hub-audit/evidence-packet.md`) → 5 chẩn đoán độc lập
read-only (best-of-5) → 1 verifier chấm điểm, phân xử mâu thuẫn, chọn winner.
Trọng số theo rubric trong packet: evidence chain, rival elimination, mechanism specificity, verification testability, completeness.

Winner: **candidate C1** (25/25; 18 defect: 4 × S1, 10 × S2, 4 × S3). Runner-up: C2 19.5, C3 19.5, C4 19, C5 17.5.
Artifact của verifier: `.tmp-af-hub-audit/candidate-C{1..5}.md`, `.tmp-af-hub-audit/verifier.md`.
Mỗi mục dưới đây được tag **[measured]** (controller tự đo lại trên máy này) hoặc **[candidate]** (candidate có anchor
file:line, nhưng controller chưa tự đo lại).

---

## Phần A — Vì sao app bị văng (forensics của symptom)

### A1. Chu kỳ crash-restart là thật và vẫn đang tiếp diễn [measured]

`E:/Work/.antifan-data/runtime/logs/main.log` (10.535 dòng JSON, heartbeat 5 s/lần) có **9 session theo pid** và
**8 lần boot**, nhưng chỉ **1 lần shutdown sạch**:

| pid | session (local) | thời lượng | max RSS | kết thúc |
|---|---|---|---|---|
| 20036 | 19:06 → 03:00 | 8 h | 572 MB | `shutdown.clean` + `app.quit` |
| 15824 | 03:00 → 03:10 | 10 m | 860 MB | văng, không có dòng shutdown |
| 24180 | 03:50 → 08:00 | 4 h 10 m | 1637 MB | văng |
| 28364 | 08:01 → 08:32 | 31 m | 1369 MB | văng |
| 29320 | 08:33 → 08:55 | 22 m | 2011 MB | văng |
| 2908 | 08:56 → 09:11 | 15 m | 1826 MB | văng |
| 16192 | 09:12 → 09:19 | 7 m | 1264 MB | văng |
| 30392 | 09:20 → 09:38 | 18 m | 1749 MB | văng |
| 9232 | 09:38 → (còn sống ở 10:04Z) | 26 m+ | đỉnh 2236 MB | đang chạy |

Sáu lần văng không sạch trong khoảng ~2 h (08:32, 08:55, 09:11, 09:19, 09:38, và chính session 9232 đạt đỉnh 2,05 GB
lúc 17:01 local). Session duy nhất chạy dài (8 h) chỉ đạt đỉnh **572 MB**; mọi session bị văng đều đạt đỉnh **1,2–2,2 GB**.

### A2. Có dump thật, và chuỗi death→relaunch khớp timestamp [measured]

- `crashDumps/reports/de686712-4d6e-45ad-a1c3-76106343809c.dmp` — **68.626.272 byte**, mtime 2026-09-16 **16:38**.
- Heartbeat cuối của pid 30392: `2026-09-16T09:38:45Z` (= 16:38:45 local). Marker boot mới
  (`crashReporter.enabled` + `boot.profile`, pid 9232) lúc **16:38:49 local** — sau đó 4 s.
- Nghĩa là: app văng → ghi dump 65 MB → tự mở lại. Đây đúng là hiện tượng "app tự văng rồi tự mở lại" mà user thấy.
- `main.log` **không** có `render-process-gone`, `child-process-gone`, `uncaughtException` hay `unhandledRejection`
  cho bất kỳ lần chết nào — chỉ có heartbeat dừng. Chết ở tầng native process thì handler JS không bắt được.

### A3. Bệnh lý memory đang diễn ra ngay trong process đang chạy [measured]

PID 9232, lấy mẫu bằng `Get-Process` + heartbeat của chính app:

- Cấp phát liên tục **~26–34 MB/s** ở main process: RSS leo **+130…+314 MB mỗi 5 s**, rồi một major GC giải phóng ~0,5–1,5 GB.
  Đỉnh quan sát được: 2052 MB (17:01:36) và 2236 MB trong cùng session.
- CPU của main process: **3,31 s / 20 s = 16,6 % một core**, liên tục, khi không có thao tác của user và không có log event nào.
- Toàn app: working set **4.332 MB** trên 10 process Electron; RAM trống của máy **3 GB / 16 GB**.
- Đã loại trừ một giả thuyết: ramp **không** do MCP traffic từ session này. Cửa sổ 30 s không gọi MCP nào vẫn cho
  delta +224, +148, −509, +200, +122, +145, +314 MB. Allocator nằm bên trong app.
- Suốt quá trình: 10 tab / 19 webContents không đổi, tab count ổn định trong khi memory churn.

### A4. Crash đã fix trước đó không phải là driver hiện tại [measured]

Nguyên nhân đã biết (`Page.captureScreenshot{fromSurface:false}` deref null native view trên tab offscreen) đã được fix
ở **cả** source (`src/main/browser/tab-devtools-host.ts:1639-1650`) **và** bundle đang chạy
(`.compiled/src/main/browser/tab-devtools-host.js`). Session vẫn chết, nên **còn driver thứ hai** — khớp nhất với
bệnh lý allocation ở A3 đẩy process lên trên 2 GB trong khi máy chỉ còn 3 GB trống.

### A5. Trạng thái điều tra nguyên nhân allocation

Đã dispatch 2 scout read-only: (i) mổ dump (exception code, crashing module, process type) và (ii) rà các subsystem
main process có thể allocate 25–35 MB/s mà không ghi log. Kết quả được gắn vào cuối tài liệu này khi có.
Trong lúc chờ, danh sách nghi vấn kèm anchor: bridge congestion pump (`BRIDGE_DRAIN_INTERVAL_MS = 50`,
`bridge-server.ts:129-131, 2931-2983`, mỗi tick có `dataParts.join('') + JSON.stringify`), terminal chunk fan-out
(`terminal-manager.ts`), ingest/serialize CDP event theo tab (`tab-devtools-host.ts`), và artifact staging.
Thí nghiệm phân biệt nhanh nhất: chạy lại app ở benchmark mode (event-loop-delay monitor,
`src/main/benchmark/telemetry.ts:105-130`) hoặc `--inspect` + `HeapProfiler.startSampling`.

---

## Phần B — Hub đang hiển thị report/issue gì [measured]

Nguồn sự thật: `E:/Work/.antifan-data/issues/issue-register.jsonl` (275 record, 275 id duy nhất, được `IssueRegister`
load và append lại — `src/main/session/issue-register.ts:110-145`). Issue đang OPEN theo `errorCode @ severity`:

| số lượng | nhóm |
|---|---|
| 63 | `anti.agent.cursor.type` @ P1 |
| 16 | `MENU_INOPERATIVE` @ P0 |
| 4 | `LAYOUT_MISMATCH` @ P1 |
| 4 | `test.tool` @ P3 |

87 issue OPEN, 16 trong đó P0 ⇒ Core Health của Hub ra **DEGRADED** với reason `OPEN_HIGH_SEVERITY_ISSUES`
(`core-health.ts:357-378`), tab Root Causes badge 87. Hai view khớp nhau, nên số badge và verdict health là nhất quán —
các defect bên dưới nói về *việc Hub làm gì với chúng và workflow nó chạy*, không phải con số này.

---

## Phần C — Inventory defect của Hub (xếp hạng)

### S1 — feature hỏng, false-pass, hoặc privilege boundary

1. **DEF-01 — `wf-theme-security-scan` không bao giờ pass được** [measured]
   `workflow-registry.ts:178` khai báo `forbiddenPatterns[]`; `workflow-engine.ts:552-555` dispatch
   `file.assert_not_contains` với `{ path, pattern }`, nên capability throw
   `file.assert_not_contains requires path and pattern` và step fail.
   Bằng chứng: `node .tmp-af-hub-audit/run-builtins.js` → `wf-theme-security-scan => status=failed`, 2 passed / 1 failed.
   Hub ship một workflow "Theme Code & Secrets Leak Safety Scan" không bao giờ chạy xong.

2. **DEF-02 — `browser.wait_for_selector` không bao giờ fail** [measured, trace 4 hop]
   `workflow-engine.ts:497-505` thoát vòng poll khi `if (domRes.data)`. `browser-control-port.ts:1622-1626 dom()`
   trả `stageArtifact({kind:'dom', …})` → một **object `ArtifactRef`, luôn truthy**; `tab-devtools-host.ts:2217-2232
   getDom()` trả `''` (không throw) khi selector không match gì. Kết quả: `found = true` ngay poll #1 với selector
   không tồn tại, kèm 1 artifact rỗng được stage mỗi run. Mọi gate dựa trên nó bị vô hiệu hoá âm thầm.
   Cùng class: các step dựa trên capability trả artifact được báo `success: Boolean(res.data)` nên không thể fail.

3. **DEF-03 — `antifan:workflow:get-artifact` không có handler ở main** [measured]
   Preload expose (`toolbar-preload.ts:129`) và renderer gọi (`toolbar.ts:1028-1034`); không tồn tại
   `ipcMain.handle('antifan:workflow:get-artifact', …)` ở `src/main`. Bấm vào card artifact ⇒ promise reject + preview trắng.

4. **DEF-04 — workflow run không check sender trust và mặc định grant write** [measured]
   `native-tab-host.ts:2069-2086` xử lý `antifan:workflow:run` mà không gọi `isTrustedSessionVaultSender(event)`, trong khi
   ~10 handler anh em cùng file đều check (`native-tab-host.ts:1213, 1225, 1238, 1275, 1358, 2031, …`), và nó ưu tiên
   `workflowDef` do caller cung cấp hơn là id trong registry. `control-plane-runtime.ts:~613` đặt mặc định `grant: 'write'`.
   Nên một step `file.write` chạy được trong workspace root mà không có xác nhận.

### S2 — gây hiểu sai, sai kết quả, hoặc lãng phí

5. **DEF-05 — preset không hợp lệ âm thầm đưa test mobile PDP về desktop** [measured]
   `workflow-registry.ts:120` truyền `presetId: 'mobile-iphone-14-pro'`; id thật là `phone-iphone14pro`
   (`device-presets.ts:47`). `native-tab-host.ts:5207-5232` rơi vào nhánh không có preset: tắt emulation, trả user agent
   desktop, reset bounds — và `setDevicePreset` trả `true` (`:5384-5386` chỉ trả `false` khi *tab* không tồn tại).
   Step pass, nhưng mọi số đo "mobile" sau đó thực chất là desktop.
6. **DEF-06 — tab MCP Tools hiển thị catalogue bịa** [measured, mở rộng]
   `native-tab-host.ts:2038-2053` trả mảng 12 tên hardcode. So với MCP surface thật của app
   (`src/main/mcp/mcp-server.ts`, **99 tên tool khác nhau**), chỉ **2/12 tồn tại** (`antifan_open_tab`,
   `antifan_set_device_preset`); 10 cái là hư cấu, và ~97 tool thật thì vô hình. Badge permission và input schema cũng
   hardcode/rỗng. `AntiFanMcpServer.listTools()` (`mcp-server.ts:561`) đã sẵn trả catalogue thật — fix là gọi nó.
7. **DEF-07 — mở Hub block bởi CLI spawn đồng bộ** >1 s (`toolbar.ts:490-505` → `core-health.ts:646-654`) [candidate].
8. **DEF-08 — step fail với `continueOnError: true` vẫn đẩy status run thành failed** (`workflow-engine.ts:259-288`) [candidate].
9. **DEF-09 — tab Task Runs báo healthy và tính cả pack/case như task run** (`core-health.ts:503-511`) [candidate].
10. **DEF-10 — `getRootCauses()` và `getSnapshot().openIssues` lệch nhau ở P2/P3** (`core-health.ts:357-378, 575-580`) [candidate].
11. **DEF-12 — crash dump tích tụ không có retention policy** (`index.ts:104-114`; `crashReporter.start` không set cap) [measured lại: 66 MB / 1 report. Con số "~340 MB" của candidate đã cũ — thư mục lúc đo sạch hơn; phần *thiếu retention policy* thì xác nhận].
12. **DEF-13 — retry loop không delay, không backoff, không telemetry** (`workflow-engine.ts:110-179`) [candidate].
13. **DEF-14 — step bị abort để lại card step treo ở pending trên UI** (`workflow-engine.ts:193-220`) [candidate].
14. **DEF-15 — precondition refusal lại render câu dạng thành công** (`toolbar.ts:999-1008`) [candidate].
15. **DEF-17 — `WorkflowStepSchema.params` không có type**, nên contract của step vỡ âm thầm (`workflow-schema.ts:31-38`) [candidate]. Đây là root enabler của DEF-01, DEF-05 và bảng mất tham số bên dưới.

### S3 — polish / lãng phí

16. **DEF-11 — `task-runs` CLI bị spawn 2 lần mỗi `getState()`** (`core-health.ts:420, 493`) [candidate].
17. **DEF-16 — step bị skip lại render bằng CSS của failure** (`toolbar.ts:2867-2873`) [candidate].
18. **DEF-18 — tham số chết `attachmentContext`** (`workflow-engine.ts:307`) [candidate].

### Bảng mất tham số (đo sau khi packet đóng băng, tất cả [measured])

Từ `node .tmp-af-hub-audit/run-builtins.js` (chạy `WorkflowEngine` thật + stub catalogue ghi lại lời gọi):

| built-in | khai báo | thực tế forward |
|---|---|---|
| `wf-storefront-qa` | `{thresholdPx}` | `browser.set-viewport{width,height}`; `responsive-check{tabId}`; `diagnostics{tabId}`; `diagnostics{tabId, level:3}` (khai báo `level:'error'` bị bỏ); `screenshot{}` (`format:'png'` bị bỏ) |
| `wf-mobile-pdp-stress-test` | `{x, y, durationMs}` | `browser.agent-scroll{}` — `deltaY` undefined nên `tab-automation-host.ts:925` coalesce thành mặc định 400 px thay vì 600 px yêu cầu; **parameter corruption, không phải no-op** (verifier sửa lại) |
| `wf-mobile-pdp-stress-test` | `{color}` | chỉ `browser.highlight{selector}` |
| mọi built-in | report `format:'markdown'` | artifact được stage với `mime=application/json` |

---

## Phần D — Mâu thuẫn đã được verifier phân xử (đã adopt)

| claim | phán quyết |
|---|---|
| "Hub bypass capability `workflow.execute` / đường authority" | **Bác bỏ.** `control-plane-runtime.ts:559-640` tạo workflow session và dispatch `workflow.execute` qua `this.transport.dispatchIntent({…, workspaceRoot})`. |
| "`browser.scroll` trong test mobile là no-op" | **Bác bỏ** → parameter corruption: `tab-automation-host.ts:925` `params.deltaY ?? 400` scroll 400 px bất kể yêu cầu; `durationMs`/600 px bị mất. |
| "preset không hợp lệ sẽ throw hoặc dừng run" | **Bác bỏ** → fallback desktop âm thầm, step báo success (DEF-05). |
| "`browser.wait_for_selector` có chờ và timeout" | **Bác bỏ** → luôn true ngay poll #1 (DEF-02). |
| Giả thuyết của controller "scroll/device-preset/dist là các defect riêng" | Bị thay một phần: cả hai là biểu hiện của một root cause — `params` không type + engine check truthiness. |

Còn chưa verify (nêu thẳng): XSS ở renderer do interpolation không escape so với CSP của Electron; scope bridge telemetry
đa project; `IssueRegister` giữ dữ liệu khi bị kill cứng; thực thi capability trên thiết bị iOS thật.

---

## Phần E — Thứ tự fix đề xuất

1. **DEF-02** (false-pass) — assert trên *nội dung* capability, không phải truthiness của object; cho `wait_for_selector`
   so sánh với output DOM thật. Đòn bẩy cao nhất: nó đang âm thầm validate mọi thứ khác.
2. **DEF-01** (built-in hỏng) — align `forbiddenPatterns` với `pattern` của capability, hoặc sửa forwarder của engine.
3. **DEF-04** (privilege boundary) — thêm sender-trust check như các handler anh em; buộc `grant` tường minh cho
   `workflowDef` do renderer cung cấp.
4. **DEF-06** (catalogue bịa) — trả `AntiFanMcpServer.listTools()` thay cho mảng 12 tên.
5. **DEF-03** (thiếu handler) — implement `antifan:workflow:get-artifact` (hoặc bỏ call ở renderer và bỏ luôn surface ở preload).
6. **DEF-05 / DEF-17** — type `WorkflowStepSchema.params` theo từng step, rồi fix preset id (`phone-iphone14pro`).
7. **Phần A** — tìm ra nguyên nhân allocation 30 MB/s ở main process trước session làm việc dài tiếp theo; nếu không,
   session sẽ tiếp tục văng mỗi 7–30 phút và mọi lần chạy Hub đều có nguy cơ chết giữa đường.
