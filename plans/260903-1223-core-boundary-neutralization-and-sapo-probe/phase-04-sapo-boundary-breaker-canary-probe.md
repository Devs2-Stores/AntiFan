---
phase: 4
title: "5-Case Sapo Boundary-Breaker Canary Probe"
status: completed
priority: P1
effort: "1h"
dependencies: [2, 3]
---

# Phase 4: 5-Case Sapo Boundary-Breaker Canary Probe

## Overview
Implement an isolated, self-contained architectural stress test script (`scripts/probes/sapo-boundary-probe.ts`). Execute the 5 orthogonal "boundary-breaker" test cases identified in the sealed architecture doctrine to empirically prove that AntiFan's Core Understanding models are completely decoupled from Shopify/Haravan assumptions and ready for future platforms like Sapo Web.

## Requirements
- **Functional:**
  - Build `scripts/probes/sapo-boundary-probe.ts` covering 5 distinct architectural stress vectors:
    1. **Case 1 (Complex Layout):** Header with nested flex wrap, sticky position, and CSS grid container without fixed desktop assumptions.
    2. **Case 2 (Deep Component Hierarchy):** 3-level nested mega-menu with multi-column lists, verifying tree representation works without Shopify `block` constraints.
    3. **Case 3 (Commerce Data Diversity):** Multi-tier price ranges (`1.290.000đ - 1.590.000đ`), discount badges, out-of-stock badges extracted by `EcommerceDataModeler`.
    4. **Case 4 (State Transition Modeling):** Video modal with backdrop dismiss and Escape key binding verified via `inferStateTransitions` without generating `data-antifan-*` markup.
    5. **Case 5 (Template Divergence):** Sapo BWT template compatibility check: verify generated/modeled properties do not require Shopify-specific Liquid filters (e.g. `slice`, `json`, `image_url` quirks).
  - Probe must complete in `< 3 seconds`, run offline, and exit with status code `0` on success or `1` on failure.
- **Non-functional:**
  - **Zero Production Coupling:** This is strictly an architectural Canary Probe. Do not attempt to build a full Sapo Theme Compiler or publish Sapo themes.

## Architecture
```text
scripts/probes/sapo-boundary-probe.ts
              │
              ├── [Case 1] Layout Stress Fixture   ──> DomTreeParser + ResponsiveScanner
              ├── [Case 2] Mega-menu Fixture       ──> BlueprintExtractor (Deep Tree)
              ├── [Case 3] Complex Pricing Fixture ──> EcommerceDataModeler (Hybrid Score)
              ├── [Case 4] Dialog State Fixture    ──> StateSynthesizer.inferStateTransitions
              └── [Case 5] Sapo BWT Template Check ──> Liquid Safety & Filter Invariant Check
              │
              ▼
   5/5 PASS: Boundary Resilience Certified (Zero Platform Lock-in)
```

## Related Code Files
- Create: `scripts/probes/sapo-boundary-probe.ts`
- Reference: `packages/site-clone/src/models/dom-tree-parser.ts`
- Reference: `packages/site-clone/src/models/responsive-scanner.ts`
- Reference: `packages/site-clone/src/models/ecommerce-data-modeler.ts`
- Reference: `packages/site-clone/src/models/state-synthesizer.ts`
- Reference: `packages/site-clone/src/models/blueprint-extractor.ts`

## Implementation Steps
1. Create directory `scripts/probes/` if not present.
2. Scaffold `scripts/probes/sapo-boundary-probe.ts` using Node.js/TypeScript (`tsx`).
3. Implement Case 1: Construct HTML fixture with sticky header + flex-wrap + css grid; assert bounding boxes and flex children are identified without warnings.
4. Implement Case 2: Construct HTML fixture for nested category menu (L1 > L2 > L3); assert extraction yields valid tree without flattening into single-level blocks.
5. Implement Case 3: Construct product card fixture with price range `"1.290.000đ - 1.590.000đ"` and compare-at `"2.100.000đ"`; assert `extractProducts` parses min price and compare price accurately.
6. Implement Case 4: Construct modal fixture; assert `inferStateTransitions` identifies `click` trigger, `dialog_native` / `visibility_toggle` effect, and ARIA state delta.
7. Implement Case 5: Verify that the intermediate component representation can be rendered into a flat BWT module without invoking missing Liquid filters.
8. Execute probe via `npx tsx scripts/probes/sapo-boundary-probe.ts`.
9. Ensure output prints clear report summary and exits 0.

## Success Criteria
- [x] `scripts/probes/sapo-boundary-probe.ts` executes in `< 3s` and reports 5/5 PASSED.
- [x] No Shopify-specific block or schema requirements leak into the probe logic.
- [x] Price ranges, deep trees, and ARIA state transitions are certified platform-neutral.

## Risk Assessment
- **Risk:** `tsx` runner might not be installed or configured in root package.
  - **Observable Signal:** `command not found: tsx`.
  - **Mitigation:** Run with `node --loader ts-node/esm` or execute compiled JS via TypeScript compiler if needed.
