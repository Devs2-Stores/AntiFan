---
phase: 5
title: "E2E Parity Testing & Dual-Engine Benchmark"
status: in-progress
priority: P1
effort: "0.5d"
dependencies: ["phase-01-cdp-foundation-and-occlusion-proof-surface-capture", "phase-02-semantic-aria-snapshot-and-actionability-waiter", "phase-03-deep-evaluation-and-cdp-file-upload-synthesizer", "phase-04-tiered-architecture-and-gap-telemetry-engine"]
---

# Phase 5: E2E Parity Testing & Dual-Engine Benchmark

## Overview
Deliver an exhaustive test suite and live Electron multi-tab benchmark verifying 100% capability parity, zero screenshot timeouts on occluded windows, flawless ref-targeted interactions, and accurate gap telemetry recording across both Tier 1 AntiFan and Tier 2 Playwright fallback scenarios.

## Requirements
- **Functional:**
  - Create `test/main/playwright-parity-kernel.test.ts` covering:
    1. CDP connection lifecycle, domain enablement, and auto-reattach.
    2. Occlusion-proof screenshot capture (CDP `Page.captureScreenshot` with `fromSurface: false, captureBeyondViewport: true` + `RT-02` dynamic unthrottling).
    3. Semantic ARIA tree snapshot extraction with `@e1..@eN` refs and scoped subtree filters.
    4. Actionability auto-wait and ref-based click/type interaction.
    5. In-page JavaScript evaluation with structured circular-safe serialization.
    6. Native CDP file upload and drag-and-drop event dispatching.
    7. Correlation gap telemetry recording to `.antifan/telemetry/gaps.jsonl`.
  - Create live Electron smoke test `scripts/smoke-playwright-parity.cjs` and register `npm run smoke:parity` in `package.json`.
- **Non-functional:**
  - 100% green test pass rate across all unit, integration, and smoke tests.
  - Zero TypeScript compiler errors (`npm run typecheck`).
  - Zero flakiness across 10 consecutive test runs.

## Architecture
```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    E2E Parity Verification Test Matrix                      │
├───────────────────┬─────────────────────────────────────────────────────────┤
│ TEST SUITE        │ VERIFICATION TARGET                                     │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ Unit Suite        │ • SemanticRefRegistry allocation and YAML format        │
│                   │ • ActionabilityWaiter timing and visibility assertions  │
│                   │ • Runtime.evaluate serializer & circular reference trap │
│                   │ • DOM.setFileInputFiles parameter construction          │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ Integration Suite │ • Multi-Tab CDP session attachment and isolation        │
│                   │ • Background viewport capture with simulated occlusion  │
│                   │ • Scoped preemption (RT-01) + Dynamic throttling (RT-02)│
│                   │ • Telemetry gap recorder file append format             │
├───────────────────┼─────────────────────────────────────────────────────────┤
│ Live Smoke Suite  │ • Real Electron app launch with live WebContents        │
│ (smoke:parity)    │ • Storefront A11y snapshot, eval, file upload & click   │
│                   │ • Fallback telemetry capture validation                 │
└───────────────────┴─────────────────────────────────────────────────────────┘
```

## Related Code Files
- Create: `test/main/playwright-parity-kernel.test.ts` (Comprehensive unit and integration test suite)
- Create: `scripts/smoke-playwright-parity.cjs` (Live Electron E2E parity verification script)
- Modify: `package.json` (Add `smoke:parity` script command)

## Implementation Steps
1. Author `test/main/playwright-parity-kernel.test.ts` with test cases for all 5 core capabilities.
2. Author `scripts/smoke-playwright-parity.cjs` exercising live Electron browser automation:
   - Launch AntiFan Desktop with test HTTP server.
   - Execute `anti.inspect.snapshot` and verify `@e1..@eN` output structure.
   - Execute `anti.browser.evaluate` reading computed CSS properties.
   - Execute `anti.agent.file_upload` injecting test CSV file into form input.
   - Execute `anti.screenshot.viewport` on minimized/backgrounded window.
   - Execute `anti.telemetry.record_fallback` and assert `.antifan/telemetry/gaps.jsonl` entry.
3. Update `package.json` with `"smoke:parity": "npm run compile && node scripts/run-electron.cjs scripts/smoke-playwright-parity.cjs"`.
4. Run `npm run typecheck` and `npm run smoke:parity` to verify green status.

## Success Criteria
- [ ] `npm run typecheck` exits 0 with 0 errors.
- [ ] `npx tsx --test test/main/playwright-parity-kernel.test.ts` passes 100%.
- [ ] `npm run smoke:parity` completes all milestones successfully.
- [ ] Fallback telemetry file is verified on disk.

## Risk Assessment
- **Risk:** Timing flakiness in live Electron smoke test during CDP debugger attachment.
- **Mitigation:** Use explicit readiness promises and event listeners instead of arbitrary `setTimeout` delays.
