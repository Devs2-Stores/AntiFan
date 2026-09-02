---
phase: 1
title: "Kernel Primitive Hardening, Fixture Cleanup & Baseline Telemetry"
status: pending
priority: P1
effort: "1d"
dependencies: []
---

# Phase 1: Kernel Primitive Hardening, Fixture Cleanup & Baseline Telemetry

## Overview
Trace and document manual/external invocation paths of `__antiFreezeState`, remove the legacy benchmark fixture (`qa-freeze-hook.js`), harden AntiFan Core with generic reversible capture and viewport primitives (atomic CDP device metrics override in `TabDevToolsHost`), scaffold the standalone `packages/site-clone/` workspace, and establish clean-tab baseline telemetry in `reports/clone-benchmark.json`.

## Requirements
- Functional:
  - Trace how `window.__antiFreezeState` was invoked (manual/external call via `anti.browser.evaluate` during ad-hoc benchmark turns) and remove `qa-freeze-hook.js` and its script tag from `benchmark-hoplongtech/index.html`.
  - Harden AntiFan Core (`src/main/browser/tab-devtools-host.ts`) with generic, reversible browser primitives: atomic CDP `Emulation.setDeviceMetricsOverride` for headless viewports, ensuring metric cleanup in a `finally` block.
  - Implement a reversible-state contract for test probes (tracking injected stylesheet lifecycle, scroll offsets, and CSS animation states).
  - Mandate clean tab reloads (`anti.browser.reload` / new tab session) prior to interactive behavioral tests whenever JS component instances (e.g. Swiper, Livewire) have been touched.
  - Scaffold standalone workspace `packages/site-clone/` with its own `package.json`, `tsconfig.json`, and test runner.
  - Enhance the existing local asset serving utility (`scripts/serve-clone.mjs`) with font MIME types and open CORS headers.
  - Execute a clean baseline run on `hoplongtech.vn` and populate `reports/clone-benchmark.json` with machine-readable telemetry.
- Non-functional:
  - AntiFan Core must maintain zero clone-specific heuristics (no Swiper, AOS, or Liquid logic in Core).
  - All domain-specific settle policies and asset orchestration reside exclusively in `packages/site-clone/`.

## Architecture
```
[AntiFan Core (src/main/)]
  ├── Atomic CDP Device Metrics Override (Emulation.setDeviceMetricsOverride)
  ├── Generic Page Screenshot (Page.captureScreenshot)
  └── Zero Clone / Haravan Domain Logic

[Standalone Package: packages/site-clone/]
  ├── package.json, tsconfig.json, test/
  ├── Settle Orchestrator (Two-Phase reveal-then-pause policy)
  ├── Reversible Style Injector (Transient __antifan_temp_freeze__ stylesheet)
  └── Clean Tab Protocol (Calls anti.browser.reload before interactive probes)
```

## Related Code Files
- Modify: `src/main/browser/tab-devtools-host.ts` (Atomic CDP device metrics override in Core)
- Modify: `src/main/tools/browser-capabilities.ts` (Consolidate canonical `anti.browser.viewport.*` aliases)
- Modify: `benchmark-hoplongtech/index.html` (Remove legacy `qa-freeze-hook.js` script tag)
- Delete: `benchmark-hoplongtech/assets/js/qa-freeze-hook.js` (Destructive legacy fixture)
- Create: `packages/site-clone/package.json` (Standalone package descriptor)
- Create: `packages/site-clone/tsconfig.json` (Standalone package compiler config)
- Create: `packages/site-clone/src/runtime/frame-settle.ts` (Two-phase settle policy in package)
- Modify: `scripts/serve-clone.mjs` (Enhance static server with CORS and font MIME headers)
- Modify: `reports/clone-benchmark.json` (Populate machine-readable iteration entries)
- Create: `packages/site-clone/test/frame-settle.test.ts` (Unit test for frame settle logic)

## Implementation Steps
1. Trace the interactive `anti.browser.evaluate` call history for `__antiFreezeState`, document findings in `plans/reports/`, delete `benchmark-hoplongtech/assets/js/qa-freeze-hook.js`, and remove its reference from `benchmark-hoplongtech/index.html`.
2. Update `src/main/browser/tab-devtools-host.ts` in Core to implement atomic CDP device metric overrides for headless viewport captures, guaranteeing `Emulation.clearDeviceMetricsOverride` in `finally`.
3. Scaffold `packages/site-clone/` with `package.json` and `tsconfig.json`, updating root `package.json` with workspace / delegated test script integration.
4. Create `packages/site-clone/src/runtime/frame-settle.ts` implementing transient style injection and WAAPI pause without modifying DOM element structures.
5. Enhance `scripts/serve-clone.mjs` to serve font assets with correct MIME types (`font/ttf`, `font/woff2`) and CORS headers.
6. Add unit test `packages/site-clone/test/frame-settle.test.ts` verifying frame settle script output and reversible style cleanup.
7. Run clean baseline comparisons across Desktop (1440px), Tablet (768px), and Mobile (390px) on `hoplongtech.vn`, enforcing a clean reload between visual and interactive runs, and record the results in `reports/clone-benchmark.json`.

## Success Criteria
- [ ] Manual invocation path traced and `qa-freeze-hook.js` completely removed from benchmark assets.
- [ ] Core `TabDevToolsHost` captures mobile/tablet viewports headlessly without `TARGET_STALE` errors.
- [ ] `packages/site-clone/` workspace initialized with working TypeScript build and tests.
- [ ] Reversible-state contract verified: transient test styles removed, and interactive testing performed exclusively on clean-reloaded tabs.
- [ ] `reports/clone-benchmark.json` populated with verified, machine-readable iteration data.

## Risk Assessment
- **Risk**: Calling `Animation.finish()` on infinite animations in the settle script throws `InvalidStateError`.
  - *Observable Signal*: JS runtime error during frame capture.
  - *Mitigation*: Filter animations by `anim.effect.getTiming().iterations !== Infinity` before finishing; pause infinite loops instead.
