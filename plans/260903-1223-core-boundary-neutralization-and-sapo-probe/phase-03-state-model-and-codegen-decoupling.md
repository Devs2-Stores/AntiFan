---
phase: 3
title: "State Model & Codegen Decoupling"
status: completed
priority: P2
effort: "45m"
dependencies: [2]
---

# Phase 3: State Model & Codegen Decoupling

## Overview
Decouple the abstract State & Interaction Model from concrete storefront JavaScript code generation in `packages/site-clone/src/models/state-synthesizer.ts`. Establish a clean separation: Core Understanding discovers triggers, state deltas, and ARIA attributes (`StateTransitionModel`), while runtime code generation (`generateDeclarativeRuntime()`) is isolated as a Platform/Runtime implementation strategy.

## Requirements
- **Functional:**
  - Export `StateTransitionModel` interface representing platform-neutral interaction semantics:
    ```typescript
    export interface StateTransitionModel {
      widgetType: 'slider' | 'tabs' | 'modal' | 'dropdown' | 'accordion' | 'search';
      triggerEvent: 'click' | 'mouseover' | 'mouseout' | 'keydown' | 'focus';
      targetSelector: string;
      triggerSelector: string;
      stateDelta: {
        className?: string;
        active: boolean;
      };
      ariaDelta?: {
        attribute: 'aria-expanded' | 'aria-hidden' | 'aria-selected';
        to: string;
      };
      effectType: 'class_toggle' | 'visibility_toggle' | 'media_pause' | 'focus_trap';
    }
    ```
  - Provide `inferStateTransitions(controllers: StorefrontControllerContract[]): StateTransitionModel[]` to extract pure semantic transitions without generating JavaScript strings.
  - Maintain `generateDeclarativeRuntime(): string` for the Haravan OS 2.0 Theme Compiler with zero regressions.
- **Non-functional:**
  - Preserve the 75-line ultra-compact, safe selector resolving (`q(s)`) micro-runtime for storefront deployments.

## Architecture
```text
Raw DOM / Storefront Controllers
              │
              ▼
[ StateSynthesizer.inferStateTransitions ]  <-- CORE UNDERSTANDING
              │
              ├── Returns: StateTransitionModel[] (Pure Semantic Facts)
              │
              ▼
[ StateSynthesizer.generateDeclarativeRuntime ]  <-- RUNTIME STRATEGY (ADAPTER)
              │
              └── Returns: Vanilla JS IIFE string for Storefront Browser Deployment
```

## Related Code Files
- Modify: `packages/site-clone/src/models/state-synthesizer.ts`
- Modify: `packages/site-clone/test/models.test.ts`
- Verify: `packages/site-clone/src/generators/theme-compiler.ts`

## Implementation Steps
1. Open `packages/site-clone/src/models/state-synthesizer.ts`.
2. Define and export `StateTransitionModel` interface.
3. Implement `inferStateTransitions(controllers: StorefrontControllerContract[]): StateTransitionModel[]`:
   - For `dropdown` controllers: map to click/hover trigger, `class_toggle` effect, `aria-expanded` toggle.
   - For `modal` controllers: map to click trigger, `visibility_toggle` + `media_pause` + `focus_trap` effects, `aria-hidden` toggle.
   - For `carousel` controllers: map to click/drag trigger, `css_scroll_snap` effect.
4. Keep `generateDeclarativeRuntime()` completely unchanged to ensure `ThemeCompiler` operates seamlessly.
5. Add unit tests in `packages/site-clone/test/models.test.ts` asserting that `inferStateTransitions` correctly produces semantic models.
6. Run `npm run test:site-clone` to verify.

## Success Criteria
- [x] `StateTransitionModel` is exported and fully typed.
- [x] `inferStateTransitions` maps controllers to semantic transitions with zero inline JavaScript code.
- [x] `ThemeCompiler` continues to generate `assets/theme.js` using `generateDeclarativeRuntime()`.
- [x] All unit tests pass with zero errors.

## Risk Assessment
- **Risk:** Type signatures in `StorefrontControllerContract` might differ between files.
  - **Observable Signal:** Compilation error TS2304 / TS2345 in `state-synthesizer.ts`.
  - **Mitigation:** Import `StorefrontControllerContract` directly from `clone-ir.ts` to maintain a single source of truth.
