---
phase: 1
title: "Safety substrate for unbounded unattended run"
status: done
priority: P0
effort: ""
dependencies: []
---

# Phase 1: Safety substrate for unbounded unattended run

## Overview
Locked contract item: C8. Block 1. Đây là **điều kiện tiên quyết**: mốc 8h đã bị bỏ khỏi mô hình, nên lưới an toàn thô đó phải được thay bằng bound chính xác. Không có phase này thì mọi phase sau chạy không giám sát là liều lĩnh.

Bất biến trung tâm: **nếu checkpoint/resume thật sự chạy thì crash chỉ mất tối đa một đơn vị việc.** Đó là thứ thay thế đồng hồ — không phải niềm tin.

## Requirements
- Checkpoint **atomic** tại mỗi phase gate: ghi temp rồi rename; chứa phase id, gate verdict, ladder state, git SHA, artifact refs.
- Resume đọc checkpoint và tiếp tục đúng phase/mục đang dở; không chạy lại việc đã `PASS`.
- Watchdog heartbeat: ghi heartbeat 60s; heartbeat stale > 180s → process tự thoát, không treo vô hạn.
- **Giám sát từ BÊN NGOÀI runner (bắt buộc)**. Runner không thể tự bảo vệ giai đoạn bootstrap của chính nó: nếu nó deadlock trước khi watchdog hoạt động thì không có gì bên trong cứu được. Yêu cầu:
  - Một tiến trình **độc lập** (khác process với runner) đọc heartbeat file và kill cả process tree khi heartbeat stale. Cơ chế OS-level — ví dụ scheduled task / watcher tiến trình riêng — không phải một hàm trong runner.
  - Một **trần wall-clock cho riêng cửa sổ bootstrap**: nếu runner chưa đạt mốc "watchdog armed" trong N phút thì lớp ngoài kill. Trần này chỉ áp cho bootstrap, không phải cho toàn bộ run.
  - Lớp ngoài phải **kiểm chứng được**: test bằng cách cho runner deadlock cố ý và chứng minh lớp ngoài kill thật.
- Vì sao bắt buộc: plan.md ghi rõ runtime **không có `/goal` executor gốc**, nên runner phải tự làm mọi thứ. Tự làm mà không có lớp ngoài = bootstrap deadlock, và trên Windows/Electron một vòng lặp treo có thể khoá máy.
- Health abort theo ngưỡng **đo được** (không theo đồng hồ): RSS drift/giờ, heap trần, N verify fail liên tiếp, và **nới tiêu chí** (đây là trigger abort, không phải trigger retry).
- Single-runner mutex: khoá theo PID để không chạy hai runner chồng nhau.
- Giữ máy thức bằng `SetThreadExecutionState` — **kế thừa pattern đã có** ở `scripts/benchmark-real-soak-8h.cjs:49-61`, không viết lại.
- **Set** `--disable-background-timer-throttling`, `--disable-renderer-backgrounding`, `--disable-backgrounding-occluded-windows` cho mọi tiến trình Electron/CDP do run sinh ra. Main app hiện **thiếu** (chỉ có ở `scripts/test-clone-features.cjs:63-65`).
- Artifact pruning: chỉ giữ đường `FAIL`/`BLOCKED`; đường `PASS` chỉ giữ summary.
- **Ngưỡng đĩa có kiểm tra số học**: preflight đo `C:` còn **23G trống / 260G (92% đã dùng)**. Run nhiều ngày sinh PNG full-page + DOM dump, và B20 ghi nhận trang cao hơn 16384px bị ghép tile (ảnh lớn hơn nữa). Phải có kiểm tra headroom **trước mỗi phase gate**; dưới ngưỡng chốt → abort, không chạy tiếp. Pruning phải chứng minh hiệu quả bằng số đo trước/sau, không chỉ "đã cài".
- **Ghi đồng thời vào Core DB**: runner ghi `.super-core/core.db` trong khi MCP server có thể đang đọc. Chốt chế độ truy cập (WAL + `busy_timeout`) và ghi lại; không để hai writer tranh nhau im lặng.

## Architecture
phase gate → verdict → atomic checkpoint → (resume | next phase)  
heartbeat ─┐  
health probe ─┼→ abort gate → clean exit + checkpoint  
criteria-drift detector ─┘

## Related Code Files
- `scripts/benchmark-real-soak-8h.cjs` — nguồn kế thừa: `TOTAL_MINUTES=480`, checkpoint mỗi 10 phút, keep-awake P/Invoke ở dòng 49-61.
- `scripts/test-clone-features.cjs:63-65` — nơi duy nhất đã set cờ chống throttle.
- `scripts/qa-20-round-loop.mjs` — pattern loop đã có.
- Đề xuất tạo: `scripts/goal/` (runner + checkpoint + watchdog + health). Đây là **đề xuất ownership**, chưa khẳng định module tồn tại.
- `plans/bottlenecks.json` — 36 row, 7 open (B19,B20,B21,B23,B29,B30,B32).

## Implementation Steps
1. Trace `scripts/benchmark-real-soak-8h.cjs` checkpoint/keep-awake để kế thừa, không fork bản thứ hai.
2. Viết checkpoint writer (atomic rename) + resume reader + ladder state schema.
3. Viết watchdog (heartbeat file + staleness check) và mutex PID.
4. Viết health probe + abort gate với ngưỡng chốt trước khi chạy.
5. Viết criteria-drift detector: phát hiện diff làm yếu assertion/acceptance → abort.
6. Chạy **kill test**: giết giữa run, chứng minh resume sạch.
7. Ghi lại toàn bộ ngưỡng vào artifact của phase.

## Contract and Test Matrix
- [ ] Kill test: kill -9 giữa phase → resume từ checkpoint, không mất > 1 đơn vị việc; chứng minh bằng log trước/sau.
- [ ] **Lớp ngoài**: cho runner deadlock cố ý **trước** khi watchdog armed → lớp ngoài kill cả process tree trong ngưỡng. Test này phải fail nếu chỉ có watchdog nội bộ.
- [ ] **Trần bootstrap**: runner không đạt "watchdog armed" trong N phút → lớp ngoài kill.
- [ ] Watchdog: làm heartbeat stale giả → runner thoát trong ngưỡng.
- [ ] Health abort: bơm RSS/heap vượt ngưỡng → abort đúng, có lý do.
- [ ] Mutex: chạy runner thứ hai → từ chối, không chạy chồng.
- [ ] Drift detector: sửa một assertion thành yếu hơn → abort (test này phải fail trước khi detector tồn tại).
- [ ] Không test nào assert wiring/source text; assert hành vi quan sát được.

## Success Criteria
- [ ] Tất cả Requirements delivered và evidence linked.
- [ ] **Kill test pass là GATE CỨNG**: phase 2 và 3 **không được** bắt đầu ở chế độ unattended nếu kill/resume chưa được chứng minh bằng log trước/sau. Đây là bằng chứng duy nhất hợp lệ cho việc bỏ trần thời gian — không có nó thì "không có mốc dừng" là liều lĩnh, không phải tự do.
- [ ] Ngưỡng health (RSS drift/giờ, heap trần, N verify fail, headroom đĩa) được chốt và ghi lại **trước** khi phase 2 bắt đầu.
- [ ] Không mục nào của phase này bị chuyển thành documentation-only.

## Risk Assessment
- Trên i5-9300H + Win11, chạy dài có thermal throttle và timer throttling của OS → health abort phải là bound thật, không phải hình thức.
- `isForbiddenTool()` trong `.omp/extensions/antifan-fix-guard/index.ts` là **stub luôn trả `false`** → guard hiện không chặn gì. Không được dựa vào nó làm cơ chế an toàn.
- Nếu resume không chứng minh được, phase 2-3 **không được** bắt đầu unattended.
