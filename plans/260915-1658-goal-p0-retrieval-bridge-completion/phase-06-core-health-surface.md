---
phase: 6
title: "Core Health + 5 surface — snapshot có reasonCode"
status: done
priority: P1
effort: ""
dependencies: [5]
---

# Phase 6: Core Health + 5 surface — snapshot có reasonCode

## Overview
Locked contract items: C4 + P0-B + 2 hạng mục P1 của MASTER UPGRADE. Block 2.

Phase này sở hữu **9 hạng mục**: 11, 12, 13, 14, 15, 16, 17 (P0-B) + 28, 29 (P1) — xem `reports/ladder-31-items.md`.

Mục tiêu: mọi trạng thái sức khoẻ của Core **giải thích được**. Một con số phần trăm không nói được cái gì hỏng và hỏng ở đâu; `reasonCode` + `affected` thì nói được.

Hiện trạng (đã grep xác nhận trên repo thật `E:/Work/apps/AntiFan`):
- `src/renderer/toolbar.html:442-559` **đã có** modal **"Workflow & MCP Hub"**: `#workflowHubOverlay`, `.workflow-hub-modal`, `.hub-header`, `.hub-nav-strip`, `.hub-body`, `#hubListPane`, `#hubDetailPane`, `.hub-wf-detail`, `.hub-mcp-detail`.
- **Đính chính quan trọng**: bản plan đầu tiên nói toolbar không có hub markup → **SAI**. Nhưng vẫn đúng khi nói **chưa có panel Core Health / Bridge**. Hệ quả thiết kế: **tích hợp vào Hub sẵn có** (thêm nav-strip mục + list/detail pane) thay vì dựng panel mới — vừa ít việc hơn, vừa tránh hai hệ UI chồng nhau.
- `IssueRegister` **đang chạy** và đã được tiêu thụ. `regressions` table có nhưng **replay engine không**.

## Requirements

### R1 — Snapshot có lý do, không chỉ có điểm
- Mọi status trả kèm `reasonCode` và `affected`. Trạng thái suy giảm phải ra `DEGRADED`, **không** ra một phần trăm trông tự tin.
- Nguồn dữ liệu sẵn có: `stats()` (`:44`), `corpusAudit()` (`:572`), `decayCheck()` (`:557`), `checkPhaseGate()` (`:600`), `classifyUncertainty()` (`:537`) — không phát minh chỉ số mới khi chỉ số đã có.

### R2 — Mở rộng `IssueRegister`, không dựng register thứ hai
- `src/main/session/issue-register.ts` đã chạy, được `src/main/tools/browser-capabilities.ts:14` và `src/main/verification/circuit-breaker.ts:46` tiêu thụ, và đã phơi `anti.diagnostics.record_issue` / `list_issues`.
- Phân loại issue mới phải **mở rộng** taxonomy này. Dựng register song song là tạo authority cạnh tranh — bị cấm.

### R3 — Năm surface, tích hợp vào Hub sẵn có
- **13 Health UI** · **14 Bridge UI** · **15 Task Run trace** · **28 Root cause UI** · **29 Core regression UI**.
- `toolbar.html:442-559` **đã có** modal "Workflow & MCP Hub" (`.hub-nav-strip`, `#hubListPane`, `#hubDetailPane`). **Mở rộng Hub này** — thêm mục nav + pane — thay vì dựng overlay/panel mới. Dựng hệ UI thứ hai là tạo authority cạnh tranh và sẽ xung đột DOM/CSS.
- Tái dùng IPC đã có: `antifan:toolbar:*`, `antifan:tab:*`, `antifan:terminal:*`, `antifan:tabs:*`. Không phát minh kênh mới nếu kênh cũ đủ.
- Hiển thị bằng chứng và unknowns; **không** giấu phần chưa biết.

### R4 — Core regression phải có replay thật
- `regressions` table tồn tại nhưng `recordRegression()` (`:657`) chỉ **nhận** `replayResult`, **không** có engine replay.
- **29** chỉ được đánh `PASS` khi có đường replay thật. Nếu không xây được trong ngân sách → `NOT_IMPLEMENTED` + blocker nêu tên, **không** `PASS` vì "đã có bảng".

## Related Code Files
**Repo chuẩn: `E:/Work/apps/AntiFan`** (HEAD `43ffb89`). Anchor dưới đây đã grep xác nhận trên repo này.

- `src/renderer/toolbar.html:442-559` — modal "Workflow & MCP Hub" **đã tồn tại**; đây là chỗ mở rộng, không phải chỗ dựng mới. Chưa có panel Core Health / Bridge.
- `src/main/session/issue-register.ts` — register đang chạy; mở rộng tại đây.
- `src/main/tools/browser-capabilities.ts:14` — consumer thứ nhất. **Lưu ý đường dẫn**: là `main/tools/`, không phải `main/browser/` như bản plan đầu ghi sai.
- `src/main/verification/circuit-breaker.ts:46` — consumer thứ hai. **Lưu ý đường dẫn**: là `main/verification/`, không phải `main/session/`.
- `packages/super-core/src/index.ts` — `stats` `:44`, `decayCheck` `:557`, `corpusAudit` `:572`, `checkPhaseGate` `:600`, `recordRegression` `:657`.
- `packages/super-core/src/schema.ts` — `regressions` `:310`, `observations` `:209`.

## Implementation Steps
1. Trace `IssueRegister` API và hai consumer trước khi mở rộng.
2. Định nghĩa health snapshot schema: status + `reasonCode` + `affected` + evidence refs.
3. Cài service tổng hợp từ nguồn Core sẵn có; không tự bịa chỉ số.
4. Mở rộng taxonomy issue; giữ tương thích consumer hiện có.
5. Thêm IPC theo pattern đã có.
6. **Mở rộng Hub sẵn có** (`toolbar.html:442-559`): thêm mục nav-strip + pane cho Health → Bridge → Task Run trace → Root cause → Core regression. Không dựng overlay/panel thứ hai.
7. Với **29**: xây đường replay thật, hoặc ghi `NOT_IMPLEMENTED` + lý do. Không được đánh `PASS` trên bảng rỗng.
8. Test: gieo tình huống suy giảm → phải ra `DEGRADED` kèm `reasonCode`, không ra %.

## Contract and Test Matrix
- [ ] Mọi status có `reasonCode` + `affected`.
- [ ] Tình huống degraded gieo vào → `DEGRADED` + lý do, **không** ra phần trăm.
- [ ] Không tồn tại register thứ hai — issue đi qua `IssueRegister`.
- [ ] Consumer hiện có (`browser-capabilities`, `circuit-breaker`) vẫn xanh sau khi mở rộng taxonomy.
- [ ] **Hạng mục 13 (Health UI)**: renderer thật hiển thị snapshot có `reasonCode` từ nguồn thật, không phải số tĩnh.
- [ ] **Hạng mục 14 (Bridge UI)**: hiển thị trạng thái bridge thật, gồm cả trường hợp Core unavailable.
- [ ] **Hạng mục 15 (Task Run trace)**: trace hiển thị được một task có thật với danh tính TaskRun.
- [ ] **Hạng mục 28 (Root cause UI)**: hiển thị được nguyên nhân gốc từ dữ liệu issue thật.
- [ ] **Hạng mục 29 (Core regression UI)**: hoặc có replay thật + UI đọc kết quả, hoặc là `NOT_IMPLEMENTED`/`BLOCKED` — không `PASS` trên bảng rỗng.
- [ ] Tất cả surface **tích hợp trong Hub sẵn có**, không dựng overlay/panel thứ hai — khẳng định bằng DOM thật, không phải bằng đọc source.
- [ ] Không test nào assert wiring/source text.

## Success Criteria
- [ ] R1-R4 delivered và evidence linked cho **9 hạng mục** (11-17, 28, 29).
- [ ] Không mục nào chuyển thành documentation-only.

## Risk Assessment
- **5 surface là phần nặng nhất của cả plan**, nhưng nhẹ hơn ước lượng ban đầu vì Hub đã có sẵn khung (nav-strip + list/detail pane). Rủi ro thật là **xung đột UI**: nếu dựng overlay thứ hai cạnh `#workflowHubOverlay` sẽ hỏng DOM/CSS. Bắt buộc mở rộng, không dựng song song.
- Nếu vẫn không đủ ngân sách, phải trả `NOT_IMPLEMENTED` + blocker cho surface chưa làm — không hạ thành "panel đọc số tĩnh" rồi gọi là xong.
- Mở rộng taxonomy có thể chạm `circuit-breaker` → đổi hành vi ngắt mạch (`grantHumanExemption`). Phải trace trước.
- **29 phụ thuộc replay engine chưa tồn tại** — đây là hạng mục dễ bị đánh `PASS` sai nhất trong cả ladder.
