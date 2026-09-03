---
phase: 3
title: "Declarative Micro-Runtime & Compiler Code Generation"
status: pending
priority: P1
effort: "0.75d"
dependencies: ["2"]
---

# Phase 3: Declarative Micro-Runtime & Compiler Code Generation

## Overview
Purge all 6 hardcoded widget implementations, benchmark selectors, and static URLs (such as YouTube `Nt2J6ZXPuw0`) from `StateSynthesizer.generateStorefrontJs()`. Implement a lightweight (<80 lines), event-delegated universal micro-runtime (`antifan-runtime.js`) driven entirely by declarative HTML attributes (`data-antifan-toggle`, `data-antifan-slider`, `data-antifan-modal`). Upgrade `HaravanSectionGenerator` and `ThemeCompiler` to inject these attributes based on `ir.storefrontRuntime.controllers`.

## Requirements
- Functional:
  - Deprecate hardcoded script generation in `packages/site-clone/src/models/state-synthesizer.ts`:
    - Remove hardcoded selectors: `.slide-content__detail .s-content`, `.category-navigation__list ul li`, `#category-navigation__sub`, `.tabs .tab-item`, `.systerm .item-cta`, `#popup-video`, and `#quote-form`.
    - Remove hardcoded YouTube embed URL `https://www.youtube.com/embed/Nt2J6ZXPuw0?autoplay=1`.
    - Remove blocking browser `alert()` on phone validation.
  - Implement `generateDeclarativeRuntime(): string` in `StateSynthesizer`:
    - **Universal Toggle & Tabs**: Event-delegated click listener for `[data-antifan-toggle]`: toggles target class, handles `data-antifan-group` mutual exclusion for tabs/accordions, and synchronizes `aria-expanded` / `aria-hidden`.
    - **Dropdown Hover**: Event-delegated hover listener for `[data-antifan-hover]`: opens dropdowns with pointer leave detection.
    - **Accessible Modal & Video Dialog**: Universal modal handler for `[data-antifan-modal]`: opens dialog, traps focus (`Tab` / `Shift+Tab` cycle inside modal per WCAG 2.4.3), restores focus to original trigger on close, handles backdrop click and `Escape` key close. Teardown pauses HTML5 `<video>` tags and resets `<iframe>` while preserving `data-antifan-src` for seamless replay without background audio leaks.
    - **Multi-Slider Isolation**: Universal slider controller for `[data-antifan-slider]`: isolates autoplay timers per slider instance via `WeakMap` or instance property (preventing timer collision across multiple carousels). Scopes `[data-antifan-slider-prev]`/`[next]` buttons to the enclosing slider or explicit target selector.
    - **Zero External Dependencies**: Compact, modular vanilla browser script without external framework dependencies.
  - Upgrade `HaravanSectionGenerator` in `packages/site-clone/src/generators/haravan-section-generator.ts`:
    - Update `generateSectionFile` signature:
      `generateSectionFile(blueprint: ExtractedSectionBlueprint, controllers?: StorefrontControllerContract[]): string`
    - Match controllers strictly by `controller.sectionId === blueprint.id`, eliminating selector guessing.
    - Inject declarative attributes based on controller type and `roleId`:
      - `carousel`: injects `data-antifan-slider data-antifan-autoplay="5000"` onto root `<section>` and `data-antifan-slider-track` onto card container.
      - `dropdown`: injects `data-antifan-hover` or `data-antifan-toggle` onto navigation links.
      - `modal`: injects `data-antifan-modal` onto trigger buttons and `data-antifan-modal-dialog` onto popup containers.
  - Upgrade `ThemeCompiler` in `packages/site-clone/src/generators/theme-compiler.ts`:
    - Filter `const sectionControllers = ir.storefrontRuntime?.controllers?.filter(c => c.sectionId === sec.id) || [];` and pass directly into `this.sectionGen.generateSectionFile()`.
    - In step 9 (writing `assets/theme.js`), call `this.stateSynth.generateDeclarativeRuntime()`.
  - Upgrade `HaravanLayoutGenerator` in `packages/site-clone/src/generators/haravan-layout-generator.ts`:
    - Add `defer` attribute to `theme.js` script tag (`<script src="{{ 'theme.js' | asset_url }}" defer></script>`).
  - Upgrade `CleanTabProbe` in `packages/site-clone/src/qa/clean-tab-probe.ts`:
    - Completely remove legacy benchmark selector queries (`.category-navigation__sub`, `.systerm .item-cta`, `#popup-video`).
    - Refactor `verifyInteractiveChecks()` to query authoritative `[data-antifan-toggle]`, `[data-antifan-slider]`, and `[data-antifan-modal]` locators directly from the IR contract, eliminating legacy coupling.
    - Update `clean-tab-probe.test.ts` fixtures to render declarative `data-antifan-*` attributes.
- Non-functional:
  - Zero legacy class name coupling or hardcoded domain selectors anywhere in the codebase.
  - The declarative runtime operates universally across all storefront archetypes.

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                    ComponentContractIR                      │
│  └── storefrontRuntime.controllers: [                       │
│        { type: 'carousel', targetSelector: '...' },         │
│        { type: 'dropdown', triggerSelector: '...' },        │
│        { type: 'modal',    targetSelector: '...' }          │
│      ]                                                      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│           HaravanSectionGenerator (Attribute Injector)      │
│  ├── injects [data-antifan-slider], [data-antifan-prev/next]│
│  ├── injects [data-antifan-toggle], [data-antifan-group]    │
│  └── injects [data-antifan-modal],  [data-antifan-dialog]   │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│         Universal Declarative Runtime (assets/theme.js)     │
│  - <80 lines pure Vanilla JS (zero dependencies)            │
│  - Event Delegation: click, mouseover, mouseout, keydown    │
│  - Zero hardcoded class names or site-specific selectors    │
└─────────────────────────────────────────────────────────────┘
```
## Related Code Files
- Modify: `packages/site-clone/src/models/state-synthesizer.ts` (Implement `generateDeclarativeRuntime()` with focus trapping & multi-slider isolation)
- Modify: `packages/site-clone/src/generators/haravan-section-generator.ts` (Inject declarative attributes into section Liquid)
- Modify: `packages/site-clone/src/generators/theme-compiler.ts` (Pass controllers into section generator & write declarative runtime)
- Modify: `packages/site-clone/src/generators/haravan-layout-generator.ts` (Add `defer` to theme.js script link)
- Modify: `packages/site-clone/src/qa/clean-tab-probe.ts` (Target declarative attributes with fallback in behavioral probes)
- Modify: `packages/site-clone/src/generators/theme-compiler.test.ts` (Verify generated `theme.js` is declarative and sections contain data attributes)

## Implementation Steps
1. In `packages/site-clone/src/models/state-synthesizer.ts`, implement `generateDeclarativeRuntime()` containing the 78-line event-delegated runtime script.
2. Deprecate `generateStorefrontJs()` by forwarding to `generateDeclarativeRuntime()`.
3. In `packages/site-clone/src/generators/haravan-section-generator.ts`, update `generateSectionFile` parameters to accept `controllers?: StorefrontControllerContract[]`.
4. Add attribute injection helper methods in `HaravanSectionGenerator` that decorate HTML templates with `data-antifan-slider`, `data-antifan-toggle`, and `data-antifan-modal`.
5. In `packages/site-clone/src/generators/theme-compiler.ts`, map `ir.storefrontRuntime.controllers` to each section during section compilation and call `stateSynth.generateDeclarativeRuntime()` for `theme.js`.
6. In `packages/site-clone/src/generators/haravan-layout-generator.ts`, add `defer` to the `theme.js` asset script tag.
7. Update `theme-compiler.test.ts` to assert that `assets/theme.js` no longer contains `.slide-content__detail` or `Nt2J6ZXPuw0`, and assert that compiled sections contain `data-antifan-*` attributes.
8. Run build and tests to verify complete pass.

## Success Criteria
- [ ] `assets/theme.js` generated by `ThemeCompiler` contains 0 hardcoded benchmark selectors and 0 hardcoded external URLs.
- [ ] Universal declarative runtime size is under 100 lines of code.
- [ ] Section files compile with declarative `data-antifan-*` attributes corresponding to IR controllers.
- [ ] Existing behavioral probe tests in `clean-tab-probe.test.ts` pass when targeting declarative attributes.

## Risk Assessment
- **Risk**: Existing tests in `clean-tab-probe.test.ts` expect legacy benchmark class names.
  - *Observable Signal*: Probe assertions fail when searching for `.category-navigation__sub.active`.
  - *Mitigation*: The declarative runtime supports `data-antifan-class="active"`, ensuring that toggled classes continue to work with CSS selectors while freeing the JavaScript engine from class dependencies.
