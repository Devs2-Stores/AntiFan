---
phase: 2
title: "The 5-Dimension Cognitive Models & clone-spec.json IR"
status: pending
priority: P1
effort: "1d"
dependencies: ["1", "260902-1022-core-freeze-hardening-and-skills-rollout"]
---

# Phase 2: The 5-Dimension Cognitive Models & `clone-spec.json` IR

## Overview
Implement the 5-Dimension Cognitive Understanding pipeline in the standalone `packages/site-clone/` package, consuming AntiFan MCP tool contracts over JSON-RPC to transform live DOM and visual telemetry into an authoritative, machine-verifiable `clone-spec.json` intermediate representation.

## Requirements
- Functional:
  - **Model 1: Page Blueprint**: Structural decomposition into sections, components, and blocks with semantic HTML5 tags and polymorphic DOM detection (Desktop Mega-Menu vs Mobile Drawer).
  - **Model 2: Asset Intelligence**: Cataloging images, background assets, and fonts with full Vietnamese Unicode range (`U+0000-00FF, U+0102-0103, U+1EA0-1EF9`) to eliminate tofu glyph rendering.
  - **Model 3: Responsive Constraints**: Extraction of container max-widths (1470px), grid column transformations (5 -> 2 -> 1), and breakpoint media query rules.
  - **Model 4: Interaction State Model**: Mapping UI states (Swiper, Accordions, Modals, Tab switchers) into decoupled Vanilla JS state machines.
  - **Model 5: Content & Liquid Data Model**: Parameterizing dynamic text nodes and collection loops into a formal `StorefrontStateContract` (variant matrices, swatch bindings, `/cart/add.js` API contracts).
  - Compile and validate against `packages/site-clone/schemas/clone-spec.schema.json`.
- Non-functional:
  - `packages/site-clone/` runs as a standalone client consuming AntiFan MCP via JSON-RPC.
  - Telemetry payloads > 64KB must be handled via `ArtifactRef` paging (`anti.artifact.read`).
  - Strict boundary: Zero mutable e-commerce code placed into `src/main/`.

## Architecture
```
[AntiFan Core MCP Server (src/main/)]
       │ (JSON-RPC 2.0 Stdio / MCP Tools)
       ▼
[packages/site-clone/src/extractors/]
  ├── 1. Blueprint Extractor (DOM tree clustering & polymorphic drawer detection)
  ├── 2. Asset & Font Harvester (Unicode range validation & inlined SVG manifests)
  ├── 3. Responsive Scanner (Multi-viewport layout formula extraction)
  ├── 4. State Machine Synthesizer (Interactive event listeners & trigger mappings)
  └── 5. E-Commerce Data Modeler (Variant matrix & cart transaction contract)
       │
       ▼
[JSON-Schema Validation Engine (packages/site-clone/schemas/)]
       │
       ▼
[Authoritative Artifact: `specs/clone-spec.json`]
```

## Related Code Files
- Create: `packages/site-clone/schemas/clone-spec.schema.json` (Formal JSON Schema for IR)
- Create: `packages/site-clone/src/extractors/blueprint-extractor.ts` (Model 1 & Polymorphic DOM)
- Create: `packages/site-clone/src/extractors/asset-harvester.ts` (Model 2 & Font Unicode validation)
- Create: `packages/site-clone/src/extractors/responsive-scanner.ts` (Model 3 & Grid formula extraction)
- Create: `packages/site-clone/src/extractors/state-synthesizer.ts` (Model 4 & Interaction state machines)
- Create: `packages/site-clone/src/extractors/ecommerce-modeler.ts` (Model 5 & Storefront State Contract)
- Create: `packages/site-clone/src/spec-compiler.ts` (Orchestrates 5 models into `clone-spec.json`)
- Create: `packages/site-clone/test/spec-compiler.test.ts` (Unit test for spec generation and validation)

## Implementation Steps
1. Define the formal JSON Schema `packages/site-clone/schemas/clone-spec.schema.json` incorporating `StorefrontStateContract` and `polymorphicDom` properties.
2. Implement `blueprint-extractor.ts` consuming `anti.inspect.dom` and executing multi-viewport probes (1440px, 768px, 375px) to capture both Desktop Mega-menu and Mobile Drawer trees.
3. Implement `asset-harvester.ts` downloading remote media and harvesting full-subset webfonts with Vietnamese diacritics.
4. Implement `responsive-scanner.ts` computing container max-widths, paddings, and flex/grid column reflow rules.
5. Implement `state-synthesizer.ts` mapping event listeners into Vanilla JS finite state machines.
6. Implement `ecommerce-modeler.ts` identifying product card clusters, option matrices, price bindings, and cart endpoints.
7. Implement `spec-compiler.ts` validating and writing the authoritative `specs/clone-spec.json`.
8. Add unit tests in `packages/site-clone/test/spec-compiler.test.ts` verifying schema compliance.

## Success Criteria
- [ ] `specs/clone-spec.json` generated for `hoplongtech.vn` and passes schema validation with 0 errors.
- [ ] Both Desktop navigation and Mobile drawer structures successfully captured.
- [ ] Font map includes complete Vietnamese Unicode coverage without missing character glyphs.
- [ ] `StorefrontStateContract` contains valid option swatches and `/cart/add.js` mappings.
- [ ] Package build (`npm run build` in `packages/site-clone/`) passes with zero compiler errors.

## Risk Assessment
- **Risk**: Dynamic frameworks (Livewire, React) delay rendering until interaction.
  - *Observable Signal*: Empty section arrays or missing repeater cards in `clone-spec.json`.
  - *Mitigation*: Trigger simulated scroll sweeps and hamburger clicks during extraction to force full hydration before capturing the blueprint.
