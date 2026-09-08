---
phase: 3
title: "Raw DOM Preservation & Independent HTML Clone Generator"
status: pending
priority: P1
effort: "4h"
dependencies: ["phase-02-asset-pipeline-integration"]
---

# Phase 3: Raw DOM Preservation & Independent HTML Clone Generator

## Overview
Overcome the archetype data-loss flaw in `BlueprintExtractor` by capturing and preserving authentic live DOM structure (`rawHtml`), emitting an offline-renderable, 100% independent HTML clone directory (`index.html`, `css/`, `js/`, `assets/`, `manifest.json`) before touching Liquid.

## Requirements
- Functional:
  - Preserve `rawHtml` in `ExtractedSectionBlueprint` and `ComponentContractIR` rather than discarding it in favor of generic skeleton generation.
  - Implement `IndependentHtmlCloneGenerator` in `packages/site-clone`:
    - Reads component IR and localized assets.
    - Reconstructs a complete standalone HTML document with local stylesheets, localized images, and sanitized runtime scripts.
    - Encapsulates dynamic interactive components (sliders, tabs, megamenus) via declarative data attributes or lightweight vanilla shims without executing untrusted origin SPA bundles.
  - Implement Representative Data Strategy:
    - Bounded sample: max 12 products for grids, max 6 articles for blogs.
    - Full fidelity: 100% of hero banners, category navigation, and visual promotional blocks.
- Non-functional: Generated HTML must open and render offline with zero external network calls.

## Related Code Files
- Create: `packages/site-clone/src/generators/independent-html-clone-generator.ts`
- Modify: `packages/site-clone/src/models/blueprint-extractor.ts`
- Modify: `packages/site-clone/src/models/clone-ir.ts`
- Modify: `packages/site-clone/src/index.ts`
- Create: `packages/site-clone/test/independent-html-clone.test.ts`

## Implementation Steps
1. Update `ExtractedSectionBlueprint` to retain original DOM attributes, inline styles, and child structure.
2. Build `IndependentHtmlCloneGenerator` to stitch together header, sections, and footer with localized asset paths.
3. Add representative content bounds in `EcommerceDataModeler`: default 12 items for product grids, 6 for blog posts.
4. Export `IndependentHtmlCloneGenerator` from `packages/site-clone/src/index.ts`.
5. Add unit test verifying that generated `index.html` loads locally with zero origin domain references.

## Success Criteria
- [ ] `ExtractedSectionBlueprint` retains exact DOM nesting and inline styles.
- [ ] `IndependentHtmlCloneGenerator` produces an independent, self-contained HTML bundle.
- [ ] Zero origin references in the generated HTML and CSS.
- [ ] Product lists exceeding 12 items are cleanly capped to representative sample.

## Risk Assessment
- Risk: Complex inline SVGs or modern CSS container queries fail offline parsing.
- Mitigation: Retain raw inline SVG markup verbatim without alteration; bundle all discovered @font-face rules.
