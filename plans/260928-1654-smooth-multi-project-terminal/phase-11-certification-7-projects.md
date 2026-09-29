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
Unit/e2e certification: **111/111 pass** after two deterministic fixes — see `reports/cert-run.md` + `reports/test-quality-review.md` (verdict STRONG).
- FIXED: `output-batcher.ts:100` fast path used adaptive `win` instead of `flushMs` → every chunk batched → daemon echo p50 33491ms → post-fix p50 49.4ms, lost=0 (`reports/perf-verify-final-daemon-n3.json`). Regression pin test added.
- FIXED: router test stale assertion (`detach` on last host is intended pruning).
- Perf gates: N=3 daemon VERIFIED. N=7 daemon FAILS: renderer `Perf 0` single longtask 18,343ms starves acks → backpressure pauses sessions → echo lost. Attribution in flight (`reports/longtask-attribution.md`); GUI main + daemon loops healthy (p50 5ms).
- In-proc (daemon off) still regressed: synchronous `pty.spawn`/`pty.resize` block main thread (spawn 5618ms, resize ≤2676ms) — follow-up issue; daemon mode is the fix path.
- `test/e2e/project-windows` still unrun.
