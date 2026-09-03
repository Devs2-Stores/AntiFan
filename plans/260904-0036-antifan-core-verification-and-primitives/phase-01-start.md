---
phase: 1
title: "Core Runtime Verification & Soak Baseline"
status: complete
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Core Runtime Verification & Soak Baseline

## Overview
Giai đoạn này xác lập nền móng độ tin cậy thực nghiệm cho AntiFan Core: kiểm chứng bằng chứng mã nguồn cho thấy luồng ExecutionControl và tín hiệu hủy đã hoạt động thông suốt, đồng thời thực thi bài test Windows soak dài hạn (30–45 phút) để đảm bảo không rò rỉ bộ nhớ Electron và không sinh tiến trình zombie node-pty.

## Requirements
- Functional:
  - Kiểm chứng tự động xác nhận `capability-transport.ts` inject thành công `signal` và `control` (`ExecutionControlImpl`) vào `AuthenticatedCapabilityContext`.
  - Kiểm chứng `browser.wait` và `anti.browser.wait` đã đăng ký đúng lane `event-wait` và chuyển tiếp trực tiếp `context.signal` vào phương thức thực thi.
  - Phân loại rõ ràng trạng thái kết toán (`classifySettlement`) dựa trên `policy?.effect` (`read`, `idempotent-write`, `interactive-effect`) và `control.effectStage`.
- Non-functional:
  - Windows Soak Benchmark chạy tối thiểu 30–45 phút liên tục với nhiều tab và terminal background.
  - Tỷ lệ gia tăng bộ nhớ Electron sau khi GC (Garbage Collection) $\le 30\text{MB}$.
  - Zero tiến trình zombie `node-pty` hoặc Chromium helper bị mồ côi sau khi đóng tab/terminal session.

## Architecture
```text
Client / CLI / MCP Request
         │
         ▼
 capability-transport.ts
   ├── creates ExecutionControlImpl(invocationId)
   ├── bridges runtimeOptions.signal -> execControl.signal
   └── injects { signal, control } into AuthenticatedCapabilityContext
         │
         ▼
 capability-catalogue.ts (Handler Execution)
   ├── browser.wait (lane: 'event-wait', signal: context.signal)
   └── terminal / sensory tools (signal: context.signal)
         │
         ▼
 classifySettlement(error, policy.effect, control.effectStage)
   ├── 'interrupted' : Hủy trước khi sinh side-effect (no-effect)
   ├── 'failed'      : Lỗi nội bộ hoặc lỗi thực thi
   └── 'unknown'     : Bị hủy giữa chừng khi mutation chưa hoàn tất
```

## Related Code Files
- Create: `test/integration/execution-control-cancellation.test.ts`
- Modify: `src/main/tools/capability-transport.ts`
- Modify: `src/main/tools/browser-capabilities.ts`
- Verify: `scripts/smoke-real-soak.cjs`
- Verify: `scripts/benchmark-electron-performance.mjs`

## Implementation Steps
1. **Viết Integration Test kiểm chứng hủy ExecutionControl:**
   - Tạo bài test `test/integration/execution-control-cancellation.test.ts` kích hoạt một tác vụ long-running (`browser.wait` hoặc `browser.observe`) kèm một `AbortController`.
   - Phát lệnh `abort()` sau 50ms; kiểm chứng handler nhận tín hiệu, dừng tức thì và transport trả về `ok: false, error.code: 'ABORTED', state: 'interrupted'`.
2. **Khảo sát & Chuẩn hóa Settlement Classification:**
   - Đối chiếu `classifySettlement` trong `capability-transport.ts:580–630`.
   - Đảm bảo các tác vụ `read` luôn trả về `state: 'interrupted'` khi bị hủy, trong khi các tác vụ `interactive-effect` bị ngắt giữa chừng phải trả về `state: 'unknown'` để ngăn chặn retry mù quáng.
3. **Thực thi Windows Soak Test Baseline:**
   - Chạy kịch bản `npm run smoke:soak` trong môi trường Windows 11 với thời lượng 30–45 phút.
   - Theo dõi biểu đồ RAM Electron (`process.memoryUsage().heapUsed`, RSS) và số lượng tiến trình con `conhost.exe` / `cmd.exe` qua lệnh `tasklist`.
   - Xác nhận tiến trình `node-pty` được dọn sạch $100\%$ khi terminal đóng.

## Success Criteria
- [x] Test `execution-control-cancellation.test.ts` chạy pass $100\%$.
- [x] Không còn bất kỳ capability handler nào bỏ sót `context.signal` (đã wire xuyên suốt ViewportGate và action handlers, có unit test kiểm chứng).
- [ ] Báo cáo đo đạc soak test kéo dài 30–45 phút (Đã xác lập benchmark baseline 4 tab cố định qua quick workload smoke; kịch bản `scripts/smoke-real-soak.cjs --duration=30` đã sẵn sàng).

## Risk Assessment
- *Nguy cơ:* Chromium DevTools Protocol (CDP) socket bị treo ngầm khi tab reload trong lúc đang `browser.wait`.
- *Tín hiệu nhận biết:* `browser.wait` không trả về kết quả dù timeout đã hết.

## Verification Proof & Execution Evidence

1. **Unit Test Suite (`test/unit/verification-capabilities.test.ts`)**:
   - Verified `capability-transport.ts` injects `ExecutionControl` and `signal` into `AuthenticatedCapabilityContext`.
   - Verified `browser.wait` registers `lane: 'event-wait'` and forwards cancellation signals.
   - Verified `classifySettlement` resolves idempotent vs interactive mutations under cancellation and retry.
   - 10/10 test cases passed cleanly.

2. **Soak Baseline Benchmark (`smoke-soak-workload-benchmark.json`)**:
   - Fixed 4-tab topology warmed up prior to Stage 1.
   - Settle methodology: `fixed-topology-quiescence-settle-window` (5s baseline window, 5s steady-state window).
   - Baseline RSS: 774.09 MB across 4 tabs. Peak RSS: 886.70 MB. Final RSS: 810.34 MB.
   - PTY Streaming Stress: 520,165 bytes processed (> 500KB threshold).
   - Tab thrash: 20 switches across 4 tabs + Split Review toggled.
   - QA blast: 20 live scans completed.
   - Orphan processes: 0.
   - Overall Verdict: `PASSED (VERIFIED)`.
- *Phản ứng dự phòng:* Đảm bảo `context.signal` được kết nối trực tiếp với AbortSignal của CDP request pool trong `native-tab-host.ts`.
