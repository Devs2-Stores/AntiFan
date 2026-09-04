---
phase: 2
title: "Context Lineage & Proving Harness"
status: completed
priority: P1
effort: "4h"
dependencies: ["phase-01-start.md"]
---

# Phase 2: Context Lineage & Proving Harness

## Overview
Establish end-to-end task lineage and a realistic, completely isolated proving ground:
1. Define the minimal canonical `ThemeTaskContext` skeleton to bind task execution, target element monotonic references (`@e1..@eN`), and local workspace paths.
2. Build an isolated **Product Card Proving Harness** (`test/fixtures/golden-workflow/product-card/`) containing realistic theme HTML, CSS cascade, and Liquid source templates. This fixture guarantees that all subsequent Theme Intelligence capabilities can be proven against real theme patterns without injecting a single product-specific selector or assumption into `src/main/`.

## Requirements
- **Functional Requirements:**
  - Define `ThemeTaskContext` in `src/shared/control-plane-contracts.ts` (or dedicated contract module) containing `taskId`, `url`, `targetRef` (monotonic `@ref`), `workspaceRoot`, and execution timestamp.
  - Implement validation helper to verify context integrity before dispatching theme-specific capabilities.
  - Scaffold static fixture bundle under `test/fixtures/golden-workflow/product-card/`:
    - `storefront/index.html`: Rendered storefront page with product grid and card component (image, sale badge, title, price, variants, add-to-cart button).
    - `theme/snippets/card-product.liquid`: Canonical Liquid source template rendering the card.
    - `theme/sections/main-collection.liquid`: Liquid parent template invoking `{% render 'card-product' %}`.
    - `theme/assets/component-card.css`: CSS cascade with active declarations, overridden parent rules, CSS custom properties, and responsive media queries ($<768\text{px}$, $<375\text{px}$).
- **Non-Functional Requirements:**
  - Invariant 3 enforcement: Zero product card selectors (`.product-card`, `.card__price`, etc.) are permitted inside `src/main/`.
  - The fixture must be testable via local HTTP or file URL protocol in Vitest / runner.

## Architecture
```text
OMP Annotation / Target Selection (@ref)
                    v
          ThemeTaskContext
      { taskId, url, targetRef, workspaceRoot }
                    v
          Theme Capabilities (Phase 3)
                    v
    Evaluation against Isolated Fixture
  (test/fixtures/golden-workflow/product-card/)
```

## Related Code Files
- Create: `src/shared/theme-task-context.ts` (ThemeTaskContext contract and type guards)
- Modify: `src/shared/control-plane-contracts.ts` (export ThemeTaskContext)
- Create: `test/fixtures/golden-workflow/product-card/storefront/index.html` (DOM fixture)
- Create: `test/fixtures/golden-workflow/product-card/theme/snippets/card-product.liquid` (Liquid fixture)
- Create: `test/fixtures/golden-workflow/product-card/theme/sections/main-collection.liquid` (Liquid fixture)
- Create: `test/fixtures/golden-workflow/product-card/theme/assets/component-card.css` (CSS fixture)
- Create: `test/theme-task-context.test.ts` (context contract unit tests)

## Implementation Steps
1. **Define `ThemeTaskContext`:**
   - Define interface with strict types:
     ```typescript
     export interface ThemeTaskContext {
       taskId: string;
       url: string;
       targetRef?: string;
       workspaceRoot: string;
       timestamp: number;
     }
     ```
   - Add schema validation function `assertValidThemeTaskContext(ctx: unknown): asserts ctx is ThemeTaskContext`.
2. **Build Product Card Fixture:**
   - Create HTML with realistic classes: `product-card`, `card__inner`, `card__media`, `card__content`, `card__badge`, `price`, `button--add-to-cart`.
   - Add CSS with intentional cascade:
     - Base `.card` style overridden by `.product-card`.
     - Variable `--card-badge-bg: #e53e3e`.
     - Media query `@media (max-width: 768px)` changing layout from flex row to column.
     - Media query `@media (max-width: 375px)` setting fixed width causing horizontal overflow if unconstrained.
   - Add Liquid files with matching class names and comment annotations (`<!-- snippets/card-product.liquid -->`).
3. **Write Unit Tests for Context and Fixture Integrity:**
   - Verify context validator passes valid objects and rejects missing `workspaceRoot` or invalid `targetRef`.

## Success Criteria
- [x] `ThemeTaskContext` contract is defined and exported with zero circular dependencies.
- [x] Product Card proving fixture is completely scaffolding in `test/fixtures/golden-workflow/product-card/`.
- [x] Automated check confirms zero references to `.product-card` or fixture classes exist in `src/main/`.

## Risk Assessment
- *Risk:* Workspace root resolution differs across Windows (`\` vs `/`).
  *Mitigation:* Use `path.resolve` and normalize paths to POSIX slashes (`/`) in `ThemeTaskContext` to ensure cross-platform consistency.
