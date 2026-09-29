---
phase: 1
title: "Phase 1: Baseline Instrumentation"
status: todo
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Baseline Instrumentation

## Overview
Đo hiện trạng trước mọi sửa đổi. Mọi gate sau so với baseline này; không claim cải thiện khi chưa có số.

## Requirements
- Functional: counter main process: event-loop delay (`perf_hooks.monitorEventLoopDelay`) p50/p95/p99; số `fs.statSync`/s trên đường `isSessionVisibleToWindow`; WS frames+bytes/s daemon→GUI; IPC sends/s theo webContents; RSS theo pid (`app.getAppMetrics()`); keystroke→echo latency (renderer đo `input` → chunk chứa echo).
- Non-functional: instrumentation bật bằng env `ANTIFAN_PERF_PROBE=1`, tắt mặc định, overhead ≈0 khi tắt; ghi JSON vào `.antifan/telemetry/perf-*.json`.

## Architecture
Harness `scripts/probe-multi-project-perf.cjs` khởi chạy Electron thật, mở N ∈ {3,7} project window (fixture workspace tạm), 1 session burst ~1MB/s (`node -e` in dòng liên tục) 90s, 1 session khác gõ phím mỗi 200ms, 5 tab Chrome/dự án. Tái dùng phương pháp soak `plans/260920-0100-soak-4h-workflow-performance`.

## Related Code Files
- Create: `scripts/probe-multi-project-perf.cjs`, `src/main/perf/perf-probe.ts`
- Modify: `src/main/browser/native-tab-host.ts` (counter quanh `onTerminalData` :1699-1734), `src/main/terminal-daemon/daemon-entry.ts` (frame counter :129-134), `src/renderer/standalone.js` (echo latency)

## Implementation Steps
1. Thêm `perf-probe.ts` (histogram + counters, flush 5s khi env bật).
2. Móc counter vào 4 điểm trên.
3. Viết harness N=3 và N=7; chạy 3 lần mỗi cấu hình, lưu median.
4. Ghi baseline vào `reports/baseline-perf.md` của plan.

## Success Criteria
- [ ] `reports/baseline-perf.md` có số N=3 và N=7 cho mọi metric
- [ ] Probe tắt: typecheck + unit suite xanh, không thay đổi hành vi

## Risk Assessment
Instrument làm sai số: chạy thêm 1 lần probe tắt để so RSS/CPU. Nếu statSync/s ≈ 0 trong baseline → giả thuyết chính sai → dừng, replan (đẩy phase 5/7 lên trước phase 3).
