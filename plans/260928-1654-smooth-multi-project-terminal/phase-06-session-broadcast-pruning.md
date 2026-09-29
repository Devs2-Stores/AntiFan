---
phase: 6
title: "Phase 6: Session Broadcast Pruning"
status: done
priority: P3
effort: "1.5d"
dependencies: [4]
---

# Phase 6: Session Broadcast Pruning

## Overview
Không nằm trên critical path (broadcast chỉ khi đổi state, không phải hot data path); không block phase 11. Chỉ làm nếu phase 1/11 đo thấy broadcast đáng kể. Nếu làm: pane mới mở không được chớp trắng chờ RPC.

Bỏ đuôi buffer ≤160KiB khỏi broadcast `session`; consumer cần nội dung dùng `getDelta`/`getFullBuffer` RPC có sẵn.

## Requirements
- Functional: audit MỌI consumer của payload session (renderer, MCP bridge, OMP hooks, tests) trước khi bỏ.
- Non-functional: không consumer nào mất nội dung.

## Architecture
Nguồn: `terminal-manager.ts:419-423, 2327-2430, 2711-2742`; `daemon-entry.ts:136-138`; cache `daemon-client.ts:260-290`.

## Related Code Files
- Modify: `terminal-manager.ts`, `daemon-entry.ts`, `daemon-client.ts`, consumer tìm được trong audit
- Create: `reports/broadcast-consumer-audit.md`

## Implementation Steps
1. Grep toàn repo field tail; lập bảng consumer → cách thay.
2. Chuyển từng consumer sang RPC.
3. Bỏ tail khỏi projection broadcast.

## Success Criteria
- [x] Audit hoàn tất, mỗi consumer có test
- [x] Bytes/broadcast giảm ≥90% (160 KiB → 16 KiB preview budget)

## Risk Assessment
Consumer ẩn mất nội dung. Tín hiệu: test/hydration trống. Phản ứng: rollback phase riêng này; phase 3-5 độc lập.
