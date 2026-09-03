---
phase: 1
title: "Real Chromium E2E & Isolation Certification"
status: pending
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Real Chromium E2E & Isolation Certification

## Overview
Execute real Electron runtime smoke and soak workloads to certify that ephemeral partition isolation, memory disposal, and background multitasking function correctly under live Chromium execution, not just in mock host unit tests.

## Requirements
- Functional: Run live Electron process via `scripts/run-electron.cjs` executing `scripts/smoke-theme-qa-gate.cjs` or a dedicated real-site isolation probe.
- Functional: Verify that setting cookies or localStorage in an ephemeral tab (`ephemeral: true`) does not mutate or persist to the default partition (`persist:capsule-default`).
- Non-functional: Zero unhandled promise rejections, zero process crashes, memory usage stays bounded below 450MB during sequential tab churn.

## Architecture
- Launch real Electron app in test/smoke mode using existing runner harnesses.
- Exercise tab opening, DOM inspection, CDP input dispatch, and tab closure across 5+ sequential cycles.
- Measure memory deltas via `process.memoryUsage()` and Electron session partition tracking.

## Related Code Files
- Modify: `scripts/smoke-real-soak.cjs` (or dedicated `scripts/smoke-ephemeral-isolation.cjs`)
- Read: `src/main/browser/browser-session-partition.ts`, `src/main/browser/native-tab-host.ts`
- Target: `plans/reports/runtime-verification/real-chromium-isolation-certification.json`

## Implementation Steps
1. Create or extend a smoke script `scripts/smoke-ephemeral-isolation.cjs` that opens 2 ephemeral tabs and 1 persistent tab under live Electron.
2. In ephemeral tab A, navigate to a local or live storefront test page and set a unique session cookie `anti_isolation_token=token-A`.
3. In ephemeral tab B, verify `document.cookie` does NOT contain `anti_isolation_token`.
4. In persistent tab, verify `document.cookie` does NOT contain `anti_isolation_token`.
5. Close ephemeral tabs and verify `unconfigureBrowserSessionPartition` is invoked and memory releases cleanly.
6. Record stdout and JSON metrics in `plans/reports/runtime-verification/`.

## Success Criteria
- [ ] Ephemeral tabs A and B have completely isolated cookie stores on live Chromium.
- [ ] Persistent tab is completely unaffected by mutations in ephemeral tabs.
- [ ] Tab closure releases configured partition references without memory leak warnings.
- [ ] Full smoke script runs to completion and exits code 0.

## Risk Assessment
- *Risk:* Windows CI or local machine lacks display server for GUI Electron.
- *Mitigation:* Use Electron's headless flags (`--headless`, `--disable-gpu`) or existing `scripts/run-electron.cjs` wrapper which handles Windows headless display context.
