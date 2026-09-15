---
phase: 1
title: "Benchmark instrumentation + ConPTY teardown gate"
status: pending
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Benchmark instrumentation + ConPTY teardown gate

## Overview
Xây dựng measurement harness e2e (PTY chunk → dispatcher → xterm parse → paint) trước mọi fix, đo baseline đồng thời cho cả winpty và ConPTY, đồng thời tái hiện và chẩn đoán chính xác ConPTY teardown hang để làm gate cho Phase 6.

## Requirements
- Functional:
  - Thêm renderer telemetry hook `window.__antifanTerminalBench` ghi nhận timestamp monotonic (`performance.now()`): (1) IPC data receipt, (2) `queueWrite` entry, (3) `onPostWrite` parse complete, (4) next rAF paint.
  - Thêm same-clock e2e ack latency: Main stamp timestamp khi emit chunk, renderer ack trả về `lastRenderedSeq`, main tính `ackLatencyMs = now - emitTime[seq]`, emit benchmark metric `terminal.ackLatency`.
  - Clone `test/e2e/terminal-transport-sync.cjs` thành `test/e2e/terminal-paint-bench.cjs` đo throughput và latency theo kịch bản 60s stream.
  - Sửa per-chunk overhead trong telemetry: cache `isBenchmarkEnabled` ở module load, dedupe `Buffer.byteLength(data)` trong `appendData`/`ptyData`.
  - Tạo repro script `scripts/repro-conpty-hang.cjs` phỏng theo `scripts/smoke-theme-golden-live.cjs`: spawn ConPTY powershell, chạy lệnh sinh output, gọi `TerminalManager.dispose()`, rồi `app.quit()`, bắt hang mà không có hard `process.exit(0)`.
- Non-functional:
  - Telemetry hook không ảnh hưởng hiệu năng khi không bật benchmark (`ANTIFAN_BENCHMARK=1`).
  - Phải ghi nhận baseline cho cả winpty và ConPTY (`ANTIFAN_USE_CONPTY=1`).

## Architecture
```
Main: child.onData ──> emitTime[seq] = performance.now() ──> safeSendWebContents('antifan:terminal:data')
                                                                     │
Renderer: onTerminalData (stamp T1) ──> queueWrite (stamp T2) ───────┤
                                              │
xterm: onPostWrite (stamp T3) ──> next rAF paint (stamp T4) ─────────┘
          │
      ack send ──> Main receives ack ──> ackLatencyMs = now - emitTime[seq]
```

## Related Code Files
- Create:
  - `test/e2e/terminal-paint-bench.cjs`
  - `scripts/repro-conpty-hang.cjs`
- Modify:
  - `src/main/benchmark/telemetry.ts` (cache enable check, telemetry schema)
  - `src/main/browser/terminal-manager.ts` (ackLatency timestamping, byteLength local dedupe)
  - `src/renderer/standalone.js` (`window.__antifanTerminalBench` hook)
  - `scripts/benchmark-electron-performance.mjs` (thêm scenario `terminal-stream`)

## Implementation Steps
1. Cache `isBenchmarkEnabled` trong `src/main/benchmark/telemetry.ts` tránh đọc `process.env` và `process.argv` mỗi chunk.
2. Hoist `Buffer.byteLength(data)` thành biến local trong `terminal-manager.ts:appendData` và `ptyData`.
3. Cài đặt `window.__antifanTerminalBench` trong `src/renderer/standalone.js`, gắn vào `onTerminalData`, `getWriteTargetFor`, và dispatcher `onPostWrite`.
4. Bổ sung `ackLatencyMs` tracking trong `terminal-manager.ts:recordSubscriberAck`.
5. Tạo `test/e2e/terminal-paint-bench.cjs` và scenario `terminal-stream` trong `benchmark-electron-performance.mjs`.
6. Xây dựng `scripts/repro-conpty-hang.cjs` để kiểm tra teardown hang của node-pty 1.1.0 (`_drainTimeout`, `worker.terminate()`).
7. Chạy baseline benchmark cho cả winpty và ConPTY, lưu kết quả làm mốc so sánh.

## Success Criteria
- [ ] `window.__antifanTerminalBench` báo cáo đủ 4 mốc thời gian khi chạy kịch bản stream.
- [ ] `terminal.ackLatency` được ghi nhận trên stdout khi bật benchmark mode.
- [ ] `scripts/repro-conpty-hang.cjs` tái hiện được chính xác hành vi (hang hoặc clean exit) trong ≤15s.
- [ ] File baseline JSON được xuất lưu tại `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/reports/baseline-perf.json`.

## Risk Assessment
- Rủi ro: Hook benchmark đo đạc làm sai lệch chính latency của pipeline.
- Giảm thiểu: Phân tách đo đạc — same-clock ack latency không đụng renderer clock; renderer bench hook chỉ kích hoạt khi có cờ `__bench=1` hoặc test env.
