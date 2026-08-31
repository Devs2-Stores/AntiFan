---
phase: 4
title: "Live Electron Soak Runner & Final Hygiene"
status: pending
priority: P1
effort: "6h"
dependencies: ["phase-01-core-safety-and-tenancy-isolation", "phase-02-controlled-inputs-and-synthetic-events", "phase-03-theme-qa-settle-gates-and-rollback"]
---

# Phase 04: Live Electron Soak Runner & Final Hygiene

## Overview
Replaces synthetic in-memory soak simulations with a production-grade multi-process live Electron E2E soak test runner (`test/e2e/electron-runtime-soak.test.ts`), validates zero OS-level process leaks using single-pass process tree inspection, proves memory slope stability ($\beta \le 0.5\text{ MB/min}$), removes legacy renderer shims (`var exports = exports || {};`), and enacts permanent feature freeze.

---

## Requirements

### Functional
1. `electron-runtime-soak.test.ts` must spawn a real Electron binary with test flags (`--enable-logging`, `--remote-debugging-port=9222`).
2. Must drive real WebContentsViews, live storefront pages, and high-throughput `node-pty` ANSI streams (100MB+).
3. Must query OS process trees on Windows (`tasklist /FO CSV` single-pass parent-child tree mapping), macOS (`pgrep`), and Linux at stage boundaries to detect orphan `conhost.exe`, `node.exe`, or Chromium processes without incurring high CPU query spikes.
4. Must allow a 2000ms graceful teardown window after `app.quit()` before evaluating the zero-orphan-process assertion to avoid false positives during asynchronous Chromium thread shutdown.
5. Must compute linear regression memory slope ($\beta$) using Ordinary Least Squares (OLS) over a 45–60 minute continuous soak session.
6. Renderer bundler configuration must be cleaned up to export native ESM/browser modules without `var exports = exports || {};` shims.

### Non-Functional
- Memory slope requirement: $\beta \le 0.5\text{ MB/min}$.
- Event loop lag requirement: $p99 < 30\text{ms}$ under load.
- Process leak requirement: Exactly 0 orphan processes after teardown grace window.

---

## Architecture & Telemetry Engine

```typescript
export interface LiveProcessMetric {
  pid: number;
  name: string;
  type: 'main' | 'renderer' | 'gpu' | 'pty-host' | 'subshell';
  memoryBytes: number;
  cpuPercent: number;
}

export interface SoakBenchmarkReport {
  durationMs: number;
  samplesCount: number;
  baselineRssMB: number;
  peakRssMB: number;
  finalRssMB: number;
  memorySlopeMBPerMin: number;
  orphanProcessesCount: number;
  passed: boolean;
}
```

## Related Code Files
- Create: `test/e2e/electron-runtime-soak.test.ts`
- Modify: `test/e2e/soak-test.test.ts`
- Modify: `src/renderer/toolbar.ts`
- Modify: `src/renderer/frame-backdrop.ts`
- Modify: `tsconfig.json` / build scripts
- Canonical Docs: `docs/canonical/architecture.md`

---

## Implementation Steps

### 1. Build Multi-Process Live Soak Runner (`test/e2e/electron-runtime-soak.test.ts`)
- Implement process spawn helper: `spawnElectronTestHost()`.
- Implement OS process tree inspector using single-pass CSV mapping at stage boundaries:
  - Windows: Parse `tasklist /FO CSV` into PID $\to$ PPID map and resolve descendant trees in-memory.
  - Unix: `pgrep -P $PID`.
- Implement 4-Stage Live Stress Engine:
  - **Stage 1 (Baseline Idle):** 5 minutes baseline telemetry collection.
  - **Stage 2 (ANSI Stream Blast):** 100MB chunked streaming into `node-pty` with backpressure.
  - **Stage 3 (Tab Thrash & Split View):** 50 rapid create/navigate/split/close tab cycles.
  - **Stage 4 (Endurance Theme QA):** Continuous element picking, screenshots, and theme QA scans.
- Compute OLS regression slope:
  $$\beta = \frac{\sum (t_i - \bar{t})(M_i - \bar{M})}{\sum (t_i - \bar{t})^2}$$
- Enforce 2000ms teardown grace window and verify all child processes terminate cleanly with 0 orphans.

### 2. Renderer Build Target Cleanup
- Clean up renderer build targets so scripts execute as standard browser modules.
- Remove legacy compatibility shim `var exports = exports || {};`.

### 3. Repository Hygiene & Feature Freeze
- Archive outdated planning notes and duplicate benchmark reports to `docs/archive/`.
- Ensure all canonical architecture documents in `docs/` reflect the final hardened state.
- Formally declare **Feature Freeze**.

---

## Success Criteria
- [ ] Live Electron soak test passes 45–60 minute continuous stress with $\beta \le 0.5\text{ MB/min}$.
- [ ] 0 orphan `conhost.exe`, `node.exe`, or Chromium helper processes remain after teardown grace window.
- [ ] Event loop lag $p99$ remains under 30ms throughout 100MB ANSI log streaming.
- [ ] Renderer UI loads cleanly without `exports is not defined` or runtime shims.
- [ ] Repository hygiene clean; all unit, integration, and e2e test suites green.
