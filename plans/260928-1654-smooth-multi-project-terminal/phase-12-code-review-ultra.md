---
phase: 12
title: "Phase 12: Code Review --ultra --pending --advice"
status: todo
priority: P1
effort: "0.5d"
dependencies: [11]
---

# Phase 12: Code Review --ultra --pending --advice

## Overview
Chạy `/ak:code-review --ultra --pending --advice` trên toàn bộ thay đổi chưa commit của plan.

## Requirements
- Functional: best-of-5 reviewer + verifier trên pending diff; kongming checkpoint sau review.
- Trọng tâm: race cache affiliation, leak listener router, thứ tự seq batching/backpressure, loại trừ hibernation, bảo mật IPC mới (sender validation).

## Architecture
Theo skill `ak-code-review` chế độ ultra.

## Related Code Files
- Create: `reports/code-review-ultra.md`

## Implementation Steps
1. Chạy skill.
2. Fix mọi finding blocker/high; ghi lý do từ chối finding kèm evidence.
3. Kongming go/no-go.

## Success Criteria
- [ ] 0 blocker/high mở
- [ ] Kongming GO

## Risk Assessment
Finding đảo quyết định user (ngưỡng 15 phút, không nhân bản) → hỏi user, không tự đổi.
