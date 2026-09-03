---
phase: 1
title: "Real Chromium E2E & Isolation Certification"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: Real Chromium E2E & Isolation Certification

## Overview
Execute a real Electron runtime smoke and soak workload to certify that ephemeral partition isolation, memory disposal, and background multitasking function correctly under live Chromium execution, without relying on mock host unit tests.

## Requirements
- Functional: Run live Electron process executing `scripts/smoke-ephemeral-isolation.cjs` booted via `node scripts/run-electron.cjs scripts/smoke-ephemeral-isolation.cjs`.
- Functional: Verify that setting cookies or localStorage in an ephemeral tab (`ephemeral: true`) does not mutate or persist to other ephemeral tabs or the default partition (`persist:capsule-default`).
- Non-functional: Prevent Windows display/DirectX freeze by passing `--disable-gpu`, `--disable-software-rasterizer`, and configuring `show: false` on any test windows before `app.whenReady()`.
- Non-functional: Zero unhandled promise rejections, zero process crashes, memory usage stays bounded below 450MB during sequential tab churn.

## Architecture
- Launch real Electron app in headless-safe smoke mode using `scripts/run-electron.cjs`.
- Exercise tab opening, DOM evaluation, cookie manipulation, and tab closure across 5+ sequential cycles.
- Measure memory deltas via `process.memoryUsage()` and Electron session partition tracking.

## Related Code Files
- Create: `scripts/smoke-ephemeral-isolation.cjs`
- Read: `src/main/browser/browser-session-partition.ts`, `src/main/browser/native-tab-host.ts`, `scripts/run-electron.cjs`
- Target: `plans/reports/runtime-verification/real-chromium-isolation-certification.json`

## Implementation Steps
1. Create dedicated smoke script `scripts/smoke-ephemeral-isolation.cjs` configuring `app.commandLine.appendSwitch('disable-gpu')` and `app.commandLine.appendSwitch('no-sandbox')`.
2. Boot NativeTabHost and open 2 ephemeral tabs and 1 persistent tab under live Electron.
3. In ephemeral tab A, navigate to a local test page and set a unique session cookie `anti_isolation_token=token-A`.
4. In ephemeral tab B, verify `document.cookie` does NOT contain `anti_isolation_token`.
5. In persistent tab, verify `document.cookie` does NOT contain `anti_isolation_token`.
6. Close ephemeral tabs and verify `unconfigureBrowserSessionPartition` is invoked and memory releases cleanly.
7. Record stdout and JSON metrics in `plans/reports/runtime-verification/real-chromium-isolation-certification.json`.
- [x] Ephemeral tabs A and B have completely isolated cookie stores on live Chromium.
- [x] Persistent tab is completely unaffected by mutations in ephemeral tabs.
- [x] Tab closure releases configured partition references without memory leak warnings.
- [x] Full smoke script runs to completion on Windows without GUI freeze and exits code 0.
## Risk Assessment
- *Risk:* Windows CI or local machine lacks display server for GUI Electron.
- *Mitigation:* Explicitly append `disable-gpu` and `show: false` in `scripts/smoke-ephemeral-isolation.cjs` before `app.whenReady()`.
