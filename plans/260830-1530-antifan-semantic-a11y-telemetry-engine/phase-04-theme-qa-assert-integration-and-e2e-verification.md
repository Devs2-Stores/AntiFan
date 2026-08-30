---
phase: 4
title: "Theme QA Parity & End-to-End Suite"
status: superseded
priority: P1
effort: "6h"
dependencies: ["phase-02-ref-targeted-cursor-and-hydration-gate", "phase-03-telemetry-ring-buffer-and-inline-diagnostics"]
---

# Phase 4: Theme QA Parity & End-to-End Suite

## Overview
Unify the new Semantic A11y, Ref Targeting, and Telemetry systems with AntiFan's E-Commerce Theme QA Engine (`theme.assert_cart`, `theme.qa_validate`, HS1–HS26 checks), and validate end-to-end multi-viewport split inspection across Haravan, Sapo, and Shopify storefronts.

## Requirements
- **Functional**:
  - Integrate A11y snapshot and RefRegistry with `theme.qa_validate` to map DOM issues directly to Liquid AST sources.
  - Dual-WebContentsView Split View Controller: Instantiate two isolated Electron `WebContentsView` instances (Desktop 1440x900 and Mobile 375x812) to ensure 100% native responsive `@media` query triggers with pane-scoped refs (`@d:e1` for Desktop, `@m:e1` for Mobile).
  - OOPIF Frame Origin Translation: accumulate parent frame offsets and scroll positions before dispatching CDP actions into embedded apps.
  - Assertions on Cart contracts (`/cart.js`, `/cart.json`) without mutating live merchant inventory.
  - Structured QA Triad reporting: Yêu cầu / Bằng chứng / Cách Fix.
  - Full end-to-end regression test suite verifying Playwright-parity features, redaction, and hydration recovery.
- **Non-Functional**:
  - Passive-only testing on production stores (zero fake checkout submissions).
  - Test suite execution in CI < 60 seconds.
## Architecture
```
Theme QA Engine
  ├── A11y Tree Analyzer (Find missing labels, broken links, touch targets < 44px)
  ├── Liquid Leak Detector (Find unrendered {{ ... }}, {% ... %} in DOM)
  ├── Telemetry Correlator (Attach console/network failures to failing sections)
  └── Split-View Controller (Desktop 1440px <-> Mobile 375px dual verification)
```

## Related Code Files
- Create/Update: `src/main/theme/theme-qa-engine.ts`
- Create/Update: `src/main/browser/split-view-controller.ts`
- Create/Update: `test/antifan-a11y-ref-telemetry.e2e.test.ts`
## Implementation Steps
1. Upgrade `theme.qa_validate` to consume `A11ySnapshotService` and `TelemetryBufferService`.
2. Implement Dual-WebContentsView controller managing isolated Desktop and Mobile viewports with pane-scoped refs (`@d:e1`, `@m:e1`).
3. Implement OOPIF frame offset accumulator for nested Haravan/Shopify Admin app iframes.
4. Add HS1–HS26 invariant scanners (Cart variant ID, noPS detection, Liquid LINQ slice prevention).
5. Create comprehensive E2E test suite covering:
   - Full-page A11y snapshot generation with password/financial field masking.
   - Ref-targeted click, type, and form submission flows with occlusion checks.
   - React SPA concurrent hydration recovery and animation-masked quiescence.
   - Live console error and 500 status code interception with secret redaction.
   - Dual-pane Desktop/Mobile split inspection and synchronized cursor tests.
6. Benchmark performance against standalone Playwright MCP.

## Success Criteria
- [ ] 100% of HS1–HS26 theme invariants validated via unified QA engine.
- [ ] Responsive CSS media queries trigger accurately on both Desktop and Mobile split panes without coordinate bleed.
- [ ] End-to-end E2E test suite passes 100% with zero regressions.

## Risk Assessment & Mitigations
- **Risk**: Dual WebContentsView memory consumption on low-RAM systems.
- **Mitigation**: Lazy initialization of the Mobile WebContentsView only when split-mode is explicitly enabled.
