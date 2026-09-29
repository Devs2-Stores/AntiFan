---
phase: 5
title: "Phase 5: Daemon Output Batching"
status: in-progress
priority: P1
effort: "1d"
dependencies: [3]
---

# Phase 5: Daemon Output Batching

## Overview
Daemon gộp chunk theo session trong 8–16ms hoặc ≤64KiB trước `ws.send`.

## Requirements
- Functional: flush ngay khi đạt 64KiB, hoặc sau 8ms; flush ngay chunk đầu sau idle ≥ 50ms (giữ echo phím nhanh); giữ thứ tự seq trong journal.
- Non-functional: không đổi wire format ngoài việc payload lớn hơn.
- Tránh double-batching: main đã có `terminalDataBatches` 4ms trong `native-tab-host.ts`; khi daemon đã batch, main passthrough (không thêm cửa sổ 4ms).

## Architecture
`daemon-entry.ts:129-134` hiện `JSON.stringify + ws.send` từng chunk. Thêm per-session buffer + timer.

## Related Code Files
- Modify: `src/main/terminal-daemon/daemon-entry.ts`, `native-tab-host.ts` (bỏ coalesce 4ms cho nguồn đã batch)
- Test: unit mới cho batcher (fake timers)

## Implementation Steps
1. Tách `OutputBatcher` thuần (testable).
2. Test: thứ tự, flush size, flush idle-first, flush khi session exit.
3. Nối vào daemon.

## Success Criteria
- [ ] WS frames/s ≥10× ít hơn baseline cùng throughput
- [ ] Keystroke→echo p95 không tăng so phase 3
- [ ] Journal seq liên tục, 0 mất byte (so hash output)

## Risk Assessment
Batch làm chậm echo. Tín hiệu: echo p95 tăng. Phản ứng: giảm cửa sổ xuống 4ms hoặc idle-first bypass.
