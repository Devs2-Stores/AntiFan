---
phase: "02"
title: "Layout Overflow Engine & Culprit Attribution"
status: pending
priority: P1
effort: "3h"
dependencies: ["01"]
---

# Phase 02: Layout Overflow Engine & Culprit Attribution

## Overview
Implement an automated multi-breakpoint layout overflow verification engine that detects horizontal scrollbars (`scrollWidth > clientWidth + 1.0px`), isolates the exact culprit DOM element causing the layout break, extracts its computed CSS box properties, and computes its pixel bounding box for visual annotation.

## Requirements
- Multi-breakpoint testing:
  - **Mobile**: 393×852 (iPhone 16 / 15 Pro)
  - **Tablet**: 820×1180 (iPad Air / Pro 11")
  - **Desktop**: 1440×900 (Standard Laptop)
- Layout Overflow Detection:
  - Calculate $\Delta x = \text{document.documentElement.scrollWidth} - \text{document.documentElement.clientWidth}$.
  - Apply $1.0\text{px}$ deadband threshold to eliminate high-DPI sub-pixel rounding noise.
- Culprit Element Attribution:
  - Traverse the DOM tree to locate all elements where $\text{rect.right} > \text{viewportWidth} + 1.0\text{px}$ or $\text{rect.left} < -1.0\text{px}$.
  - Identify top-level offending containers and innermost culprit leaf nodes.
  - Extract computed CSS styles: `width`, `minWidth`, `maxWidth`, `overflow`, `margin`, `position`, `flex`, `display`.
  - Return exact CSS selector path (e.g. `.header-nav > .mega-menu-container > .grid-item`).

## Architecture & Algorithm
```text
NativeTabHost Viewport Resize (393px / 820px / 1440px)
                     │
                     ▼
        Check docEl.scrollWidth > clientWidth + 1.0px?
        ├── NO  ──► Status: PASS (No horizontal overflow)
        └── YES ──► Status: FAIL (Horizontal overflow detected)
                     │
                     ▼
        DOM TreeWalker & BoundingClientRect Scanner
                     │
                     ▼
        Filter elements with rect.right > viewport.width
                     │
                     ▼
        Compute Offending Elements Hierarchy:
        - Parent Container (e.g., .product-card-grid)
        - Culprit Leaf (e.g., .product-title exceeding width)
        - Bounding Box: { x, y, width, height }
        - Computed CSS: { minWidth: "1200px", overflow: "visible" }
                     │
                     ▼
        Staged Evidence Payload in ArtifactStore
```

## Related Code Files
- Create:
  - `src/main/qa/scanners/layout-overflow-engine.ts`
- Modify:
  - `src/main/browser/native-tab-host.ts` (integrate multi-breakpoint overflow probe)
- Tests:
  - `test/main/layout-overflow-engine.test.ts`

## Implementation Steps
1. Create `src/main/qa/scanners/layout-overflow-engine.ts` with pure DOM tree traversal, geometry calculation, and culprit ranking.
2. Add deadband filtering logic ($1.0\text{px}$) and CSS selector generator.
3. Integrate with `NativeTabHost.runResponsiveCheck()` to perform sequential non-destructive breakpoint checks and restore the user's active viewport state.
4. Add unit and component tests with mock overflow fixtures (unconstrained images, fixed-width tables, negative margins).

## Success Criteria
- [ ] Correctly flags layout overflow when $\Delta x \ge 1.0\text{px}$.
- [ ] Ignores fractional sub-pixel differences ($< 1.0\text{px}$) on high-DPI displays.
- [ ] Returns exact culprit element CSS selector, outerHTML snippet, and bounding box coordinates.
- [ ] Restores active tab viewport preset cleanly after measurement.

## Risk Assessment
- **Risk:** Resizing viewports rapidly during scan could trigger unwanted responsive JavaScript layout shifts or reset user carousel states.
- **Mitigation:** Execute measurement in isolated frame or restore scroll position and device preset in a guaranteed `finally` block.
