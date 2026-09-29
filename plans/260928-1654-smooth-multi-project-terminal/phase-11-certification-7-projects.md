---
phase: 11
title: "Phase 11: Certification 7 Projects"
status: in-progress
priority: P1
effort: "1d"
dependencies: [3,4,5,7,8,9,10]
---

# Phase 11: Certification 7 Projects

## Overview
Chạy lại harness phase 1 với N=3 và N=7 trên app đã sửa; so baseline.

## Requirements
- Functional: toàn bộ gate: main p99 < 50ms, statSync data path 0, WS frames ≥10× ít hơn, keystroke p95 ≤ 100ms, 0 mất output, RSS giảm đo được, capture nền pass.

## Architecture
Harness phase 1 + e2e `test/e2e/project-windows.test.ts`.

## Related Code Files
- Create: `reports/certification-perf.md`

## Implementation Steps
1. Chạy harness 3 lần/cấu hình.
2. Chạy e2e project-windows.
3. Nếu N=7 vẫn không đạt vì RAM → mở lại phương án 1 cửa sổ với số liệu.

## Success Criteria
- [ ] Bảng baseline vs sau cho mọi metric
- [ ] Mọi gate đạt hoặc ghi rõ gate fail + nguyên nhân

## Risk Assessment
Gate fail → không claim done; replan phase liên quan.

## Run Notes (2026-09-29, CertRunner)
Unit/e2e certification: **10/12 suites pass** — see `reports/cert-run.md`.
- FAIL (deterministic): `terminal-output-router.test.js` — test invariant predates detach-on-empty (`unregisterHost` → 0 listeners when last host leaves); test needs updating, behavior correct.
- FAIL (deterministic): `output-batcher.test.js` — quiet-window fast path uses adaptive `win` (1.5×gap) instead of `flushMs`; immediate emit never fires.
- Not run: perf harness N=3/N=7 gates, `test/e2e/project-windows` — metrics table still missing, criteria unmet.
