---
phase: 13
title: "Phase 13: Test --ultra --advice"
status: todo
priority: P1
effort: "0.5d"
dependencies: [12]
---

# Phase 13: Test --ultra --advice

## Overview
Chạy `/ak:test --ultra --advice`: unit, integration, e2e, perf harness sau review fix.

## Requirements
- Functional: full suite (`package.json` scripts), `test/e2e/project-windows.test.ts`, harness perf N=7 lần cuối.
- Không xoá/nới test để xanh.

## Architecture
Theo skill `ak-test` chế độ ultra.

## Related Code Files
- Create: `reports/test-ultra.md`

## Implementation Steps
1. Chạy skill.
2. Fix regression.
3. Kongming đánh giá toàn bộ implementation.

## Success Criteria
- [ ] Suite xanh
- [ ] Perf gate phase 11 giữ nguyên sau review fix
- [ ] Kongming GO

## Risk Assessment
Flaky e2e do tiling màn hình: ghi rõ mode tiled/stacked như test hiện tại, không claim pixel khi stacked.
