---
phase: 5
title: "Liquid Lowering & Haravan Theme Export"
status: pending
priority: P1
effort: "3h"
dependencies: ["phase-04-visual-compare-fidelity-gate"]
---

# Phase 5: Liquid Lowering & Haravan Theme Export

## Overview
Transform the visually certified (<2% diff) Independent HTML Clone into standard Haravan/Shopify Liquid structures: generate modular sections, schema settings, snippets, and layout templates, followed by live theme QA validation.

## Requirements
- Functional:
  - Implement Liquid Lowering: parameterize the verified HTML DOM by injecting Liquid tags (`{{ ... }}`, `{% for item in ... %}`) into repeatable containers while keeping structural containers intact.
  - Generate standard Haravan theme directory:
    - `layout/theme.liquid`
    - `templates/index.liquid`
    - `sections/*.liquid` with compliant `{% schema %}` JSON blocks
    - `snippets/*.liquid`
    - `assets/*.css`, `assets/*.js`, `assets/*.[images/fonts]`
  - Run `theme.qa_validate` on the compiled theme in AntiFan to verify platform Liquid contracts.
- Non-functional: Zero syntax errors in generated Liquid; clean import into Haravan theme store.

## Related Code Files
- Modify: `packages/site-clone/src/generators/haravan-layout-generator.ts`
- Modify: `packages/site-clone/src/generators/haravan-section-generator.ts`
- Modify: `packages/site-clone/src/generators/haravan-schema-generator.ts`
- Modify: `packages/site-clone/src/generators/theme-compiler.ts`

## Implementation Steps
1. Enhance `HaravanSectionGenerator` to accept certified section DOM structures and replace static representative product/article cards with dynamic Liquid loops.
2. Emit settings schema for each section allowing merchants to customize titles, images, and collections.
3. Package the complete theme into a target directory or ZIP archive.
4. Execute `theme.qa_validate` to certify theme compliance.

## Success Criteria
- [ ] Complete Haravan theme generated from certified HTML clone.
- [ ] Liquid loops cleanly bind to Haravan objects (`collections`, `articles`, `settings`).
- [ ] `theme.qa_validate` passes 100% of platform validation checks.

## Risk Assessment
- Risk: Schema JSON syntax errors in complex sections.
- Mitigation: Validate each schema block with `JSON.parse()` before writing to disk.
