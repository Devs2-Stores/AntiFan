---
phase: 3
title: "Haravan Theme OS 2.0 Code Generator"
status: pending
priority: P1
effort: "1d"
dependencies: ["2"]
---

# Phase 3: Haravan Theme OS 2.0 Code Generator

## Overview
Develop the AST-driven Haravan Theme Compiler in `packages/site-clone/src/generators/` that transforms `specs/clone-spec.json` into a clean, modular, and production-ready Haravan Theme OS 2.0 directory structure (`theme/`) with zero hardcoded inline styles, valid Liquid tags, visual editor schema controls, and inlined SVG snippets.

## Requirements
- Functional:
  - Generate master layout: `theme/layout/theme.liquid` containing `{{ content_for_header }}` and `{{ content_for_layout }}`.
  - Generate modular sections: `theme/sections/*.liquid` (e.g. `header.liquid`, `hero-slider.liquid`, `product-category-blocks.liquid`, `footer.liquid`) with valid `{% schema %}` presets and block declarations.
  - Generate reusable snippets: `theme/snippets/product-card.liquid`, `theme/snippets/search-bar.liquid`, `theme/snippets/branch-modal.liquid`.
  - Inline all SVG icons into discrete snippets (e.g., `theme/snippets/icon-search.liquid`, `theme/snippets/icon-cart.liquid`) to prevent cross-origin SVG sprite blocking on Haravan CDN (`file.hstatic.net`).
  - Generate theme settings: `theme/config/settings_schema.json` and default configuration `theme/config/settings_data.json`.
  - Package clean assets: `theme/assets/app.css.liquid` with asset URL filters, `theme/assets/main.js` (pure Vanilla JS without QA test harness pollution), and localized font files.
- Non-functional:
  - Zero synthetic canvas hacks, zero screenshot background hacks, and zero monolithic code dumps.
  - 100% compliant with Haravan Theme OS 2.0 conventions.
  - All generator code compiled and tested inside `packages/site-clone/`.

## Architecture
```
[specs/clone-spec.json IR]
       │
       ▼
[Haravan AST Compiler (packages/site-clone/src/generators/)]
  ├── Layout Synthesizer (`theme/layout/theme.liquid`)
  ├── Section & Block Generator (`theme/sections/*.liquid` with {% schema %})
  ├── Snippet & Macro Generator (`theme/snippets/*.liquid`)
  ├── SVG Inliner Engine (`theme/snippets/icon-*.liquid`)
  ├── Settings Schema Synthesizer (`theme/config/settings_schema.json`)
  └── Asset Packager (`theme/assets/app.css`, `theme/assets/main.js`, `theme/assets/fonts/`)
       │
       ▼
[Verified Haravan Theme Package (`theme/`)]
```

## Related Code Files
- Create: `packages/site-clone/src/generators/haravan-layout-generator.ts`
- Create: `packages/site-clone/src/generators/haravan-section-generator.ts`
- Create: `packages/site-clone/src/generators/haravan-snippet-generator.ts`
- Create: `packages/site-clone/src/generators/haravan-schema-generator.ts`
- Create: `packages/site-clone/src/generators/haravan-asset-bundler.ts`
- Create: `packages/site-clone/src/generators/theme-compiler.ts` (Master Compiler Orchestrator)
- Create: `packages/site-clone/test/theme-compiler.test.ts` (Unit test for generated theme files)

## Implementation Steps
1. Implement `haravan-layout-generator.ts` constructing `theme/layout/theme.liquid` with standard meta tags, asset links, and required Liquid hooks.
2. Implement `haravan-section-generator.ts` parsing section descriptors from `clone-spec.json`, generating HTML markup, Liquid collection loops, and `{% schema %}` metadata with customizable settings (titles, colors, collection pickers).
3. Implement `haravan-snippet-generator.ts` generating reusable components (product card, search bar, modals) and inlining SVG icons into discrete snippet files.
4. Implement `haravan-schema-generator.ts` producing `theme/config/settings_schema.json` (typography, global colors, hotlines, social links) and initializing `theme/config/settings_data.json`.
5. Implement `haravan-asset-bundler.ts` bundling modular CSS, Vanilla JS interaction scripts, and localized font binaries into `theme/assets/`.
6. Implement `theme-compiler.ts` orchestrating the full generation pass and verifying file tree completeness.
7. Add unit tests in `packages/site-clone/test/theme-compiler.test.ts` checking syntax and required Liquid blocks.

## Success Criteria
- [ ] Complete Haravan Theme directory generated: `theme/layout/`, `theme/sections/`, `theme/snippets/`, `theme/config/`, `theme/assets/`, `theme/locales/`.
- [ ] 100% of SVG icons inlined as snippets (zero external sprite CORS dependencies).
- [ ] All dynamic product cards parameterized with Liquid tags (`{{ product.title }}`, `{{ product.price | money }}`).
- [ ] `theme/config/settings_schema.json` is valid JSON and accepted by Haravan Theme validator.
- [ ] Package test suite passes with zero errors.

## Risk Assessment
- **Risk**: Complex grid layouts broken by Liquid loop indentation or missing wrapper classes.
  - *Observable Signal*: CSS layout collapse in product grids or accessory tables.
  - *Mitigation*: Validate generated section HTML against the original bounding box metrics before finalizing the theme package.
