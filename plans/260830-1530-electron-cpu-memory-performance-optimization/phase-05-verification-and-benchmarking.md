---
phase: 5
title: "Validation, Benchmarking & Regression Verification"
status: pending
priority: P1
effort: "45m"
dependencies: [1, 2, 3, 4]
---

# Phase 05: Validation, Benchmarking & Regression Verification

## Overview
Executes comprehensive automated testing, live telemetry benchmarking, and functional smoke verification across all updated subsystems to prove that CPU, Memory, and Process Count are permanently normalized without behavioral regressions.

## Requirements
- Functional:
  - All existing unit and integration tests must pass (`npm test`).
  - Terminal interactive typing, copy/paste, split terminal, and popout window must function seamlessly.
  - Split review (Desktop + Mobile simultaneous views) must render and synchronize smoothly.
  - Bridge Server WebSocket RPC and MCP Server tools must respond correctly.
- Performance / Telemetry Benchmarks:
  - Electron main process idle CPU: < 1.0%.
  - Electron GPU process idle CPU: < 2.0% (down from 130%).
  - Total Electron memory footprint at startup with 2 tabs & 5 terminal sessions: < 450 MB (down from 4,450 MB).
  - WebSocket initial handshake payload: < 100 KB verified via `Buffer.byteLength(JSON.stringify(msg), 'utf8')` (down from 4.5 MB).
  - Process count: 0 orphan background node processes.

## Verification Matrix

| Test Case | Method | Expected Result | Pass Criteria |
|---|---|---|---|
| **TypeScript Build** | `npm run compile` | 0 errors | Exit code 0 |
| **Test Suite** | `npm test` | All unit/integration tests green | 100% pass rate |
| **Watermarked Hydration & Dedup** | Unit test: inject chunk from `term.write` callback during queue drain + concurrent snapshot | 0 duplicate chunks, 0 dropped chunks, `seq > snapshotThroughSeq` filter strictly applied | Exact log parity |
| **GPU Process CPU** | PowerShell CPU Sampling | `gpu-process` CPU < 2.0% at idle | Real-time probe |
| **Hidden View IPC** | Stream large log with closed sidebar | Sidebar renderer CPU stays 0% | No IPC dispatch |
| **Buffer Paging** | WebSocket connect to bridge (10 split sessions + ANSI) | Message size < 100 KB (`Buffer.byteLength(JSON.stringify(msg), 'utf8')`) | Payload size check |
| **Process Reaper** | Launch terminal with sleep/node & close session | Process tree vanishes | Process check |
## Implementation Steps
1. Run `npm run clean && npm run compile`.
2. Run `npm test`.
3. Launch AntiFan Desktop, open 2 tabs, create 3 terminal sessions.
4. Measure real-time CPU and Memory of all Electron processes using PowerShell probe.
5. Verify terminal input/output and split-review interaction.

## Success Criteria
- [ ] `npm test` passes cleanly.
 - [ ] Total system CPU for Electron stays under 3% at idle.
 - [ ] Total Electron memory footprint strictly verified < 450 MB (single unified criteria).
- [ ] Initial handshake JSON byte length verified < 100 KB via `Buffer.byteLength()` in 10-pane ANSI-heavy test.
- [ ] Sequence watermark deduplication & iterative drain verified: 0 duplicated chunks and 0 dropped chunks when live data is injected during `term.write` callbacks.
- [ ] No regression in agent browser control or theme QA tools.
