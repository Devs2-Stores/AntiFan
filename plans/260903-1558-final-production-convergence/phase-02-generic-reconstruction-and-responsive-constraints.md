---
phase: 2
title: "Generic Reconstruction & Responsive Constraints"
status: pending
priority: P1
effort: "8h"
dependencies: [1]
---

# Phase 2: Generic Reconstruction & Responsive Constraints

## Overview
Elevate `@antifan/site-clone` from benchmark-tuned heuristics to a generic, model-based reconstruction engine. Upgrade `ResponsiveScanner` to perform dynamic multi-viewport diffing, add explicit relational layout constraints to `ComponentContractIR`, and connect `AssetHarvester` as a first-class canonical producer.

## Requirements
- Functional: `ResponsiveScanner` must compute layout constraint diffs across Desktop (1440px), Tablet (768px), and Mobile (390px) viewports (e.g. columns transition 4 -> 2 -> 1, visibility toggles, padding scaling).
- Functional: `ComponentContractIR` must include a `layoutConstraints` block modeling container bounds, flex/grid relationships, and aspect ratios.
- Functional: `AssetHarvester` must collect responsive images (`srcset`, `<picture>`, `data-src`, background images) and map them directly into `ComponentContractIR.assets`.
- Non-functional: All 50 existing tests in `@antifan/site-clone` must continue to pass with zero regressions.

## Architecture
```text
Raw HTML / Viewport Snapshots (1440 / 768 / 390)
                │
    ┌───────────┼───────────┐
    ▼           ▼           ▼
AssetHarvester ResponsiveScanner BlueprintExtractor
    │           │           │
    └───────────┬───────────┘
                ▼
        CloneIRBuilder
                ▼
      ComponentContractIR
   (layoutConstraints + assets + sections)
                ▼
          ThemeCompiler
```

## Related Code Files
- Modify: `packages/site-clone/src/models/responsive-scanner.ts`
- Modify: `packages/site-clone/src/models/asset-harvester.ts`
- Modify: `packages/site-clone/src/models/clone-ir.ts`
- Modify: `packages/site-clone/src/models/clone-ir-builder.ts`
- Modify: `packages/site-clone/src/generators/theme-compiler.ts`
- Test: `packages/site-clone/src/models/models.test.ts`
- Test: `packages/site-clone/src/generators/theme-compiler.test.ts`

## Implementation Steps
1. In `clone-ir.ts`, add `LayoutConstraintDefinition` interface with `containers`, `relations` (fixed-width, fill-remaining, gap, columnsPerViewport).
2. In `responsive-scanner.ts`, add dynamic constraint inference method `inferResponsiveConstraints(desktopSnapshot, tabletSnapshot, mobileSnapshot)` returning inferred column counts and visibility changes.
3. In `asset-harvester.ts`, enhance extraction to capture `srcset` attributes and CSS `background-image: url(...)`.
4. In `clone-ir-builder.ts`, pipe `AssetHarvester` manifest directly into `ir.assets` and `ResponsiveScanner` constraints into `ir.layout.constraints`.
5. In `theme-compiler.ts`, generate CSS media queries derived from `layout.constraints` rather than static boilerplate.
6. Run `npm test` in `packages/site-clone` to verify all 50+ suites pass cleanly.

## Success Criteria
- [ ] Responsive constraints dynamically infer column count shifts without hardcoded class name matching.
- [ ] IR contains structured asset and layout constraint declarations.
- [ ] ThemeCompiler outputs media queries informed by the inferred responsive model.
- [ ] 100% test pass rate in `@antifan/site-clone`.

## Risk Assessment
- *Risk:* Dynamic diffing on large DOMs increases build latency.
- *Mitigation:* Cap scanning to high-level section containers and grids, eliding deep leaf text nodes.
