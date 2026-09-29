---
phase: 8
title: "Phase 8: End-to-End Backpressure"
status: todo
priority: P1
effort: "2d"
dependencies: [4,5,7]
---

# Phase 8: End-to-End Backpressure

## Overview
Kích hoạt backpressure thật: hiện là code chết (`terminal-manager.ts:2668-2669` gated `BRIDGE_PTY_BACKPRESSURE=1`, không có caller).

## Requirements
- Functional: in-flight tính theo seq (`lastSentSeq - lastAckedSeq`) vì `TerminalAckPayload` không có field bytes; watermark tương đương high ~256KB / low ~64KB. Vượt high → daemon giữ output trong bounded ring buffer (vẫn đọc PTY), dưới low → xả. Session ẩn fast-ack.
- Backend mặc định là winpty (`DEFAULT_USE_CONPTY = false`, terminal-manager.ts:387, verified) → KHÔNG gọi `pty.pause()`. Ring buffer tràn → gộp vào journal/transcript hiện có, không drop âm thầm.

## Architecture
Kênh ack ĐÃ nối sẵn (verified): IPC → `TerminalManager.recordSubscriberAck` (native-tab-host.ts:2646) → `daemon-client.ts:575` → `daemon-entry.ts:418-422`. Chỉ thêm logic flow-control trong `recordSubscriberAck` + emit gate; không tạo kênh mới. Xoá `pauseSession`/`resumeSession` chết (terminal-manager.ts:2668-2696) nếu không dùng.

## Related Code Files
- Modify: `terminal-manager.ts`, `daemon-entry.ts`, `daemon-client.ts`, `native-tab-host.ts`, `standalone.js`

## Implementation Steps
1. Xác nhận lại backend PTY runtime (winpty).
2. Test: producer 50MB → renderer không vượt 256KB in-flight; không deadlock; build nền không bị treo khi tab ẩn.
3. Implement.

## Success Criteria
- [ ] Keystroke p95 ≤ 100ms khi có build nền 1MB/s
- [ ] 0 mất output; không deadlock trong 10 phút soak

## Risk Assessment
Deadlock winpty khi pause native [INFERENCE]. Phản ứng: chỉ pause emit ở daemon, không gọi pty.pause.
