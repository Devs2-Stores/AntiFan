---
phase: 2
title: "Generic Reconstruction & Responsive Constraints"
status: completed
priority: P1
effort: "8h"
dependencies: [1]
---

# Phase 2: Generic Reconstruction & Responsive Constraints

## Overview
Elevate `@antifan/site-clone` from benchmark-tuned heuristics to a generic, model-based reconstruction engine. Upgrade `ResponsiveScanner` to perform static AST media-rule & grid layout constraint inference, add optional relational layout constraints to `ComponentContractIR` with matching JSON schema updates, and connect `AssetHarvester` as a first-class canonical producer.

## Requirements
- Functional: `ResponsiveScanner` must parse CSS media queries and grid/flex column structures from parsed HTML/CSS AST (e.g. media query breakpoints, column transitions across `@media`, display toggles) without requiring live browser rendering inside `@antifan/site-clone`.
- Functional: Add optional `layoutConstraints?: LayoutConstraintDefinition` to `ComponentContractIR` and update `packages/site-clone/src/schemas/clone-ir.schema.json` to prevent breaking `schema.test.ts`.
- Functional: `AssetHarvester` must collect responsive images (`srcset`, `<picture>`, `data-src`, background images) and map them directly into `ComponentContractIR.assets`.
- Non-functional: All 50 existing tests in `@antifan/site-clone` must continue to pass with zero regressions.

## Architecture
```text
Raw HTML + Extracted CSS Rules
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
   (layoutConstraints? + assets + sections)
   [Validated against clone-ir.schema.json]
                ▼
          ThemeCompiler
```

## Related Code Files
- Modify: `packages/site-clone/src/models/responsive-scanner.ts`
- Modify: `packages/site-clone/src/models/asset-harvester.ts`
- Modify: `packages/site-clone/src/models/clone-ir.ts`
- Modify: `packages/site-clone/src/models/clone-ir-builder.ts`
- Modify: `packages/site-clone/src/schemas/clone-ir.schema.json`
- Modify: `packages/site-clone/src/generators/theme-compiler.ts`
- Test: `packages/site-clone/src/models/models.test.ts`
- Test: `packages/site-clone/src/schemas/schema.test.ts`
- Test: `packages/site-clone/src/generators/theme-compiler.test.ts`

## Implementation Steps
1. In `clone-ir.ts`, add optional `LayoutConstraintDefinition` interface with `containers`, `relations` (fixed-width, fill-remaining, gap, columnsPerViewport).
2. Update `packages/site-clone/src/schemas/clone-ir.schema.json` to define `layoutConstraints` under definitions and properties, preserving strict schema validation.
3. In `responsive-scanner.ts`, add static AST constraint inference `inferResponsiveConstraintsFromCss(cssRules, htmlAst)` returning inferred column counts and visibility changes per breakpoint.
4. In `asset-harvester.ts`, enhance extraction to capture `srcset` attributes and CSS `background-image: url(...)`.
5. In `clone-ir-builder.ts`, pipe `AssetHarvester` manifest directly into `ir.assets` and `ResponsiveScanner` constraints into `ir.layout.constraints`.
6. In `theme-compiler.ts`, generate CSS media queries derived from `layout.constraints` when present.
7. Run `npm test` in `packages/site-clone` to verify all 50+ suites (including `schema.test.ts`) pass cleanly.

## Success Criteria
- [x] Responsive constraints dynamically infer column count shifts from CSS media queries and grid structures.
- [x] IR contains structured asset and layout constraint declarations without schema validation errors.
- [x] ThemeCompiler outputs media queries informed by the inferred responsive model.
- [x] 100% test pass rate in `@antifan/site-clone` with zero regressions.

## Risk Assessment
- *Risk:* Schema drift between TypeScript interfaces and JSON schemas.
- *Mitigation:* Update `clone-ir.schema.json` in the exact same commit and verify against `schema.test.ts`.
