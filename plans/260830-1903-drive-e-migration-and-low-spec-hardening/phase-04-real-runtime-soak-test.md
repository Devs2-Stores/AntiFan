---
phase: 4
title: "Real Runtime Endurance Soak Test Suite & Final Verification"
status: complete
effort: "2h"
dependencies: ["1", "2", "3"]
---

# Phase 4: Real Runtime Endurance Soak Test Suite & Final Verification

## Overview
Replace the synthetic `Buffer.alloc()` simulation in `test/e2e/soak-test.test.ts` with an industrial-grade automated soak test suite (`scripts/smoke-real-soak.cjs` and `test/e2e/soak-test.test.ts`). Launch physical Electron processes, drive live Chromium tabs, PTY streams, and concurrent Theme QA scans across 4 workload stages, and verify that linear memory slope $\beta \le 1.0\text{ MB/min}$ with zero orphan processes.

## Requirements
- **Functional:**
  * Implement `scripts/smoke-real-soak.cjs` executing a 4-stage endurance sequence:
    1. Stage 1 (Idle Baseline): 10s steady-state sampling.
    2. Stage 2 (PTY Streaming Stress): Stream $\ge 500\text{KB}$ of high-frequency chunks through node-pty.
    3. Stage 3 (Split Review & Tab Thrash): Open 4 concurrent tabs, toggle split mode, cycle active tabs 20 times, assert renderer process count $\le 4$.
    4. Stage 4 (Concurrent QA Blast): Fire 15 rapid reloads and concurrent QA validation scans under load.
  * Compute linear regression slope $\beta = \frac{\sum (t - \bar{t})(M - \bar{M})}{\sum (t - \bar{t})^2}$.
  * Upgrade `test/e2e/soak-test.test.ts` to test slope mathematics and invoke the real soak runner in CI mode.
  * Add `smoke:soak` and `test:soak` scripts to `package.json`.
- **Non-functional:**
  * Linear memory slope $\beta \le 1.0\text{ MB/min}$.
  * Zero orphaned Electron, Chromium, or ConPTY processes after test completion.

## Architecture
```text
+------------------------------------------------------------------------+
|               scripts/smoke-real-soak.cjs Test Harness                 |
+------------------------------------------------------------------------+
       │
       ├──> Boot local HTTP Fixture Server (Storefront mock)
       ├──> Spawn real Electron Binary (ANTIFAN_DATA_ROOT=E:\Work\.antifan-data-soak)
       │      │
       │      ├──> Stage 1: Baseline RSS Sampling (10s)
       │      ├──> Stage 2: PTY Stress (500KB chunk stream through node-pty)
       │      ├──> Stage 3: Tab Thrash (4 tabs, split view, 20 switches)
       │      └──> Stage 4: Concurrent QA Blast (15 rapid navigations)
       │
       ├──> Sample RSS & Process Metrics every 1s
       ├──> Calculate Linear Regression Slope Beta (MB/min)
       ├──> Assert Process Tree Zero Orphan Count
       └──> Write Benchmark Artifact JSON
```

## Related Code Files
- **Create:**
  * `scripts/smoke-real-soak.cjs`
- **Modify:**
  * `test/e2e/soak-test.test.ts`
  * `package.json`

## Implementation Steps
1. Build `scripts/smoke-real-soak.cjs` with fixture server, Electron child process controller, 4-stage test sequence, telemetry poller, and linear regression calculation.
2. Upgrade `test/e2e/soak-test.test.ts` to integrate the real runner.
3. Add `"smoke:soak": "node scripts/smoke-real-soak.cjs"` and `"test:soak": "node --test test/e2e/soak-test.test.ts"` to `package.json`.
4. Run full typecheck and test suites (`npm run typecheck`, `npm test`, `npm run smoke:soak`) to verify all 8 Master Verification Gates.

## Success Criteria
- [x] `npm run smoke:soak` completes all 4 stages successfully.
- [x] Linear memory slope $\beta \le 1.0\text{ MB/min}$ across the entire run.
- [x] Zero orphaned processes in Windows process table.
- [x] Benchmark report saved to `plans/260830-1903-drive-e-migration-and-low-spec-hardening/reports/smoke/real-soak-benchmark.json`.
- [x] 100% test pass rate across unit, integration, and E2E suites.
## Risk Assessment
- **Risk:** High-frequency PTY streaming causing transient memory spikes.  
  *Mitigation:* Linear regression slope calculation smooths temporary spikes and evaluates true steady-state trend.
