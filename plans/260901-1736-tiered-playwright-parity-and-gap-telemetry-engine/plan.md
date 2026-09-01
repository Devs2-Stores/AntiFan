---
title: "Tiered Playwright Parity & Gap Telemetry Engine"
description: "Establish Tier 1 AntiFan automation parity (Compact ARIA Snapshot @e1..@eN, Actionability Wait, In-Page Eval, CDP File Upload/Drop, Occlusion-Proof Surface Capture) with Tier 2 Playwright Fallback & Correlation Gap Telemetry, eliminating timeouts and crashes while preserving isolated namespaces."
status: in-progress
priority: P1
effort: "4d"
tags: ["automation", "playwright-parity", "cdp", "a11y-snapshot", "telemetry", "anti-timeout", "gap-analysis"]
created: 2026-09-01
---

# Tiered Playwright Parity & Gap Telemetry Engine

## Overview
This implementation plan establishes a comprehensive two-tier architecture in AntiFan Desktop Browser:
- **Tier 1 (Primary - AntiFan Native `anti.*`):** Full Playwright-grade automation primitives built directly into Electron WebContents and CDP (Compact ARIA Accessibility Tree with `@e1..@eN` refs, Actionability Auto-Waiting, In-Page Safe JS Evaluation, CDP Native File Upload / Drag & Drop for 1M records, and Occlusion-Proof Background Viewport Capture).
- **Tier 2 (Fallback & Diagnostic Probe - Playwright Standalone `browser_*`):** Retained 100% in a strictly separate namespace as a resilient safety net and benchmark baseline.
- **Correlation Gap Telemetry (`anti.telemetry.record_fallback`):** When the orchestrator/agent falls back to Playwright, it logs structured, sanitized gap analysis telemetry (`.antifan/telemetry/gaps.jsonl`) comparing capabilities, error codes, and outcomes without masking namespaces.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | **CDP Low-Level Kernel & Occlusion-Proof Capture:** Implement resilient `TabDevToolsHost` with `Page.captureScreenshot({ fromSurface: false, captureBeyondViewport: true })` and dynamic frame unthrottling to eliminate background/occlusion screenshot timeouts without non-existent CDP methods. | P1 |
| 2 | **Semantic ARIA Snapshot & Actionability Engine:** Generate token-budgeted ARIA trees (<800 tokens) with monotonic `@e1..@eN` refs, scoped selectors, animation-tolerant velocity decay stability checks, and pre-action auto-scrolling. | P1 |
| 3 | **In-Page Safe JS Eval & CDP File Upload / Drop:** Provide `anti.browser.evaluate` and `anti.agent.file_upload` via CDP `DOM.setFileInputFiles` with workspace path containment security and non-invasive World 1004 node resolution. | P1 |
| 4 | **Tiered Architecture & Gap Telemetry Engine:** Expose canonical `anti.*` tools, keep `browser_*` strictly separated, and provide sanitized `anti.telemetry.record_fallback` for gap analysis. | P1 |
| 5 | **E2E Parity Testing & Dual-Engine Benchmark:** 100% test pass rate across unit, concurrency, and live Electron multi-tab E2E benchmark suites (Vyan Guarantee + Hapas Storefront). | P1 |

## Phases

| # | Phase | Status | Priority | Effort | Dependencies |
|---|-------|--------|----------|--------|--------------|
| 1 | [CDP Foundation & Occlusion-Proof Surface Capture](./phase-01-cdp-foundation-and-occlusion-proof-surface-capture.md) | In-Progress | P1 | 1d | [] |
| 2 | [Semantic ARIA Snapshot & Actionability Waiter](./phase-02-semantic-aria-snapshot-and-actionability-waiter.md) | In-Progress | P1 | 1d | [Phase 1] |
| 3 | [Deep Evaluation & CDP File Upload Synthesizer](./phase-03-deep-evaluation-and-cdp-file-upload-synthesizer.md) | In-Progress | P1 | 1d | [Phase 1, Phase 2] |
| 4 | [Tiered Architecture & Gap Telemetry Engine](./phase-04-tiered-architecture-and-gap-telemetry-engine.md) | In-Progress | P1 | 0.5d | [Phase 2, Phase 3] |
| 5 | [E2E Parity Testing & Dual-Engine Benchmark](./phase-05-e2e-parity-testing-and-dual-engine-benchmark.md) | In-Progress | P1 | 0.5d | [Phase 1, Phase 2, Phase 3, Phase 4] |

## Success Criteria

- [x] `anti.screenshot.viewport` captures valid PNG base64 via empirical 2-tier cascade (`wc.capturePage` + CDP fallback).
- [ ] `anti.inspect.snapshot` benchmark on 5,000+ DOM nodes with token accounting budget (<800 tokens).
- [x] `anti.agent.cursor.click({ ref: "@e1" })` auto-scrolls element into view and checks visibility/actionability with velocity decay wait before clicking.
- [x] `anti.browser.evaluate` executes arbitrary expressions and functions in page context with circular-safe WeakSet serialization.
- [x] `anti.agent.file_upload` injects files into `<input type="file">` via CDP `DOM.setFileInputFiles`, rejecting paths outside workspace.
- [x] Fallback events record sanitized structured entries in `.antifan/telemetry/gaps.jsonl` with capability, failure code, and comparison details.
- [x] 100% test pass rate across `npm run typecheck`, deterministic parity kernel test suite (`test/main/playwright-parity-kernel.test.ts`), and live Electron smoke test (`npm run smoke:parity`).

## Red Team Review

| Finding | Severity | Phase | Status | Resolution |
|---|---|---|---|---|
| **F-01: Workspace Path Traversal in File Upload** | Critical | Phase 3 | **Accepted** | Added `isPathInsideWorkspace` containment validation throwing `PERMISSION_DENIED` if path escapes workspace. |
| **F-02: Non-Existent CDP Method & Compositor Deadlock** | Critical | Phase 1 | **Accepted** | Replaced non-existent `Emulation.setPageUpstreamScheduling` with `wc.setBackgroundThrottling(false)` and `fromSurface: false`. |
| **F-03: Non-Invasive Element NodeId Resolution** | Critical | Phase 3 | **Accepted** | Eliminated synthetic `data-antifan-ref` DOM mutation. Resolved via World 1004 `objectId` -> `DOM.describeNode` -> `backendNodeId`. |
| **F-04: Telemetry Credential Leak & Log Injection** | High | Phase 4 | **Accepted** | Implemented `sanitizeTelemetryPayload` stripping URL auth tokens and escaping newlines with 10MB log rotation. |
| **F-05: CDP Debugger Command Queue Mutex** | High | Phase 1 | **Accepted** | Added serialized command FIFO queue to prevent concurrent attachment/detachment collision deadlocks. |
| **F-06: Animation-Tolerant Actionability Stability** | Medium | Phase 2 | **Accepted** | Relaxed bounding rect check to velocity decay ($\Delta \le 2\text{px}$) to avoid false timeouts on pulse/marquee buttons. |

### Unresolved Benchmarks & Pending Live Verification
- **UB-01: 5,000+ DOM Node ARIA Token Benchmark**: Full tokenizer budget verification (<800 tokens) on massive live DOM trees remains pending.
- **UB-02: Multi-Storefront Dual-Engine Live Soak**: Dual-engine parity soak across Vyan Guarantee and Hapas live storefronts remains pending.
- **UB-03: Real OS Window Occlusion**: Viewport capture under genuine overlapping native OS windows (beyond hidden `show: false` and minimized states) to be validated with multi-window desktop harness.
