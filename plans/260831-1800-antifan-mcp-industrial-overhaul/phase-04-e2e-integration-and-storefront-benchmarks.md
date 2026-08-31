---
phase: 4
title: "E2E Integration Suite & Real-Storefront Benchmarks"
status: pending
priority: P1
effort: "3h"
dependencies: [1, 2, 3]
---

# Phase 04: E2E Integration Suite & Real-Storefront Benchmarks

## Overview
Deploys an end-to-end integration and benchmarking suite to verify the entire overhauled MCP pipeline against real e-commerce storefront scenarios. Validates that AI Vision models receive authentic Base64 PNG images, verifies throughput and latency reduction under persistent multiplexed transport, confirms trusted hardware clicks on complex storefront components (variant selectors, cart drawers), and enforces all security containment invariants.

## Requirements
- **Functional:**
  - Full E2E test verifying MCP client integration: Stdio -> Persistent Transport -> Control Plane -> Chromium -> Image Delivery -> LLM Vision.
  - Storefront verification test on Haravan and Shopify checkout/drawer flows:
    * Variant swatch selection triggers authentic variant change.
    * Add to Cart click opens ajax cart drawer and updates cart line items.
    * Viewport screenshot of cart drawer is captured and returned as valid MCP Image.
  - Security containment verification test:
    * Symlink traversal attempts through artifact resolution are blocked (`OUTSIDE_WORKSPACE`).
    * Truncated payload simulation fails closed with `INVALID_ARGUMENT`.
    * Unauthenticated requests are rejected.
- **Non-functional:**
  - Automated benchmark: Measures and records p50/p95 latency of tool invocations before and after persistent transport overhaul.
  - Zero memory leaks during repeated 50-cycle screenshot and inspection loops.

## Architecture
```
┌────────────────────────────────────────────────────────────────────────┐
│ test/e2e/mcp-storefront-overhaul.test.ts                                │
│                                                                        │
│  ├── Test 1: MCP Image Envelope Schema & Valid PNG Header              │
│  ├── Test 2: Persistent Transport Concurrency & Zero Reconnect Churn   │
│  ├── Test 3: CDP Trusted Event on Dynamic Cart Drawer                  │
│  ├── Test 4: Actionability Wait on Delayed-Hydration Swatches          │
│  └── Test 5: Security Containment (Symlink / Truncation Defense)       │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ Real E-Commerce Storefront Harness (Local Mock / Live Sandbox)         │
│  - React / Liquid Cart Drawer with `e.isTrusted` validation            │
│  - Asynchronous AJAX Swatch Picker                                     │
│  - High-DPI Viewport Split Pane (Desktop & Mobile)                     │
└────────────────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `test/e2e/mcp-storefront-overhaul.test.ts` (Comprehensive E2E integration test suite).
- Create: `test/benchmark/mcp-transport-benchmark.ts` (Latency and throughput benchmark runner).
- Modify: `docs/operations.md` (Update MCP architecture notes, security model integration, and troubleshooting guidelines).

## Implementation Steps
1. **Storefront Interactive Test Fixture:**
   - Create local HTML/JS test fixture emulating modern storefront behavior:
     * Button requiring `event.isTrusted === true` to open drawer.
     * Dynamic element appearing after 400ms setTimeout.
     * Large DOM tree for screenshot capture.
2. **E2E Test Execution:**
   - Launch live Electron + Bridge + Stdio MCP Server in test harness.
   - Dispatch `anti.browser.tabs.create`, `anti.inspect.dom`, `anti.agent.cursor.click`, and `anti.screenshot.viewport`.
   - Assert `anti.screenshot.viewport` response has `content[0].type === 'image'` and valid PNG magic bytes (`0x89504E47`).
   - Assert `anti.agent.cursor.click` opens the drawer (proving `isTrusted: true`).
3. **Transport Latency Benchmark:**
   - Measure round-trip time across 20 sequential calls over the multiplexed persistent socket.
   - Record telemetry metrics in `plans/reports/mcp-overhaul-benchmark.json`.
4. **Documentation & Operational Runbook:**
   - Update `docs/operations.md` detailing the dual-channel socket architecture, server-side artifact resolution, and CDP input guidelines.

## Success Criteria
- [ ] All tests in `test/e2e/mcp-storefront-overhaul.test.ts` pass 100% green.
- [ ] Screenshot bytes successfully decode to valid PNG images.
- [ ] Storefront drawer component opens upon CDP click.
- [ ] Telemetry benchmark confirms zero socket reconnection churn across repeated calls.
- [ ] `docs/operations.md` is updated with complete architectural documentation.

## Risk Assessment
- **Risk:** Headless CI environment lacks GPU hardware acceleration for `captureScreenshot`.
- **Mitigation:** Ensure test runner enables `--enable-logging` and software rasterizer fallback flags in headless mode.
