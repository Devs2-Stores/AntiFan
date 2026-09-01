---
phase: 2
title: "Semantic ARIA Snapshot & Actionability Waiter"
status: in-progress
priority: P1
effort: "1d"
dependencies: ["phase-01-cdp-foundation-and-occlusion-proof-surface-capture"]
---

# Phase 2: Semantic ARIA Snapshot & Actionability Waiter

## Overview
Build a high-speed, token-optimized Semantic ARIA Accessibility Snapshot Engine and an Actionability Auto-Wait interaction pipeline. This provides AI agents with clear, concise UI structure indexed by `@e1..@eN` refs, reducing context consumption by 90-95% while eliminating click misses through pre-flight auto-scrolling, animation-tolerant stability verification, and resilient ref re-anchoring.

## Requirements
- **Functional:**
  - Generate compact ARIA accessibility trees from DOM / Open Shadow DOM in Isolated World 1004, returning clean hierarchical text (`- role "@e1" "name" [disabled]`).
  - Support scoped subtree snapshots via `selector` parameter (e.g. `selector: "#cart-drawer"` or `.product-form`), returning <300 tokens for targeted inspections.
  - Implement `ActionabilityWaiter` in `tab-automation-host.ts`: before any click or type action, verify element connectivity, scroll it smoothly into view (`scrollIntoViewIfNeeded`), verify visibility and hit-test stability.
  - **Animation-Tolerant Stability:** Relax bounding rect check using velocity decay / delta threshold ($\le 2\text{px}$ position shift across consecutive rAF frames) to prevent false timeouts on continuous CSS animations (marquee banners, pulse buttons).
  - **Resilient Ref Matching:** In `semantic-ref-registry.ts`, if dynamic React/Shopify DOM mutations shift child indexes, implement multi-attribute fallback matching (role + tag + accessible name + class vector) to guarantee reliable element re-targeting without false `REF_FINGERPRINT_MISMATCH` errors.
  - Update `anti.agent.cursor.click` and `anti.agent.cursor.type` to natively accept `ref: "@e1"`, `selector: "#id"`, or coordinate inputs.
- **Non-functional:**
  - Snapshot generation time < 50ms on 5,000+ DOM nodes.
  - Token consumption < 800 tokens for full storefront page, < 300 tokens for scoped subtrees.
  - 100% action accuracy on dynamic Shopify / Haravan storefronts.

## Architecture
```
+-----------------------------------------------------------------------------+
|                            Semantic ARIA Engine                             |
+-----------------------------------------------------------------------------+
                                       |
    +----------------------------------+----------------------------------+
    |                                                                     |
    v                                                                     v
[Isolated World 1004 Walker]                                  [SemanticRefRegistry]
* Spatial DOM / Shadow DOM Traversal                          * Monotonic Ref Allocation (@e1..@eN)
* ARIA Role / Name Resolution                                 * Descriptor Bounds & Vector Caching
* Prune Redundant Generic Nodes                               * Multi-Attribute Fallback Resolver
    |                                                                     |
    +----------------------------------+----------------------------------+
                                       v
                     [Formatted Compact ARIA Outline]
                     - button @e1 "Add to Cart" [price="250.000₫"]
                     - textbox @e2 "Quantity" val="1"
                                       |
                                       v
                          [Actionability Auto-Waiter]
                     1. Resolve @e1 -> Selector / Bounding Rect
                     2. element.scrollIntoView({ block: 'center' })
                     3. Verify Visibility, Enabled State & Velocity Decay (<=2px)
                     4. Dispatch Visual Cursor + CDP Trusted Click
```

## Related Code Files
- Modify: `src/main/browser/semantic-ref-types.ts` (Contracts for SemanticNode, A11y tree formats, action options)
- Modify: `src/main/browser/semantic-ref-executor.ts` (In-page World 1004 A11y extractor and animation-tolerant actionability script)
- Modify: `src/main/browser/semantic-ref-registry.ts` (Main-process ref allocator, cache, vector matching, and token formatter)
- Modify: `src/main/browser/tab-automation-host.ts` (Actionability waiter integration and ref-based action routing)

## Implementation Steps
1. Enhance `semantic-ref-types.ts` with `SemanticNode`, `A11ySnapshotOptions` (`selector`, `maxDepth`, `compact`), and ref parsing helpers.
2. Upgrade `semantic-ref-executor.ts`:
   - Implement fast ARIA tree extractor walking DOM and open Shadow DOM.
   - Implement `checkActionability(refOrSelector)` with animation-tolerant velocity decay check ($\Delta \le 2\text{px}$).
3. Upgrade `semantic-ref-registry.ts` with multi-attribute fallback re-anchoring (role, tag, name, class) and format tree into concise YAML/Markdown outline.
4. Update `tab-automation-host.ts` to execute `ActionabilityWaiter.ensureActionable()` before dispatching cursor animations and click/type events.

## Success Criteria
- [ ] `anti.inspect.snapshot` outputs indented ARIA tree with `@e1..@eN` refs in < 50ms.
- [ ] Scoped snapshot (`selector: "#main"`) returns only elements within the specified container.
- [ ] `anti.agent.cursor.click({ ref: "@e1" })` scrolls target into view and clicks successfully on un-scrolled elements.
- [ ] Continuous CSS animations (pulse, marquee) pass actionability check within < 150ms without timeout.
- [ ] Token usage on complex product pages is under 800 tokens.

## Risk Assessment
- **Risk:** High-frequency DOM mutations during page load cause transient ref invalidation.
- **Mitigation:** Combine multi-attribute fallback matching with retry loop (50ms interval, 5000ms max timeout).
