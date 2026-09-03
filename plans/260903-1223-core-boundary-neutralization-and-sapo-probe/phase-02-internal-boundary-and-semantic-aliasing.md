---
phase: 2
title: "Internal Boundary Enforcement & Semantic Contract Aliasing"
status: completed
priority: P1
effort: "45m"
dependencies: [1]
---

# Phase 2: Internal Boundary Enforcement & Semantic Contract Aliasing

## Overview
Establish an inviolable internal boundary in `packages/site-clone`: models under `src/models/` must contain 0% Liquid code or platform-specific template syntax. Extend `ComponentContractIR` with first-class platform-neutral aliases (`components`, `slots`, `ComponentNodeContract`, `ComponentSlotContract`) alongside legacy `sections` and `blocks` to enable future consumers (Figma Parity, Visual Guide) without breaking existing compilers.

## Requirements
- **Functional:**
  - `ComponentContractIR` must export `ComponentNodeContract` (aliasing `ComponentSectionContract`) and `ComponentSlotContract` (aliasing `ComponentBlockContract`).
  - `ComponentContractIR` must include optional `components?: ComponentNodeContract[]` populated in sync with `sections: ComponentSectionContract[]`.
  - `CloneIRBuilder` must populate both `sections` and `components` during IR construction.
  - `packages/site-clone/src/models/` must be audited: zero imports of liquid generators, zero inline Liquid template tags (`{% ... %}`, `{{ ... }}`) inside model logic.
- **Non-functional:**
  - 100% backward compatibility with `ThemeCompiler` and existing tests.
  - JSON schema (`clone-ir.schema.json`) updated to accept `components` and `version: '1.2.0'`.

## Architecture
```text
ComponentContractIR v1.2.0
  ├── Canonical Platform Properties (For ThemeCompiler):
  │     ├── sections: ComponentSectionContract[]
  │     └── blocks: ComponentBlockContract[]
  │
  └── Neutral Semantic Aliases (For Future Consumers / Figma / Probes):
        ├── components: ComponentNodeContract[] (references same objects)
        └── slots: ComponentSlotContract[]
```

## Related Code Files
- Modify: `packages/site-clone/src/models/clone-ir.ts`
- Modify: `packages/site-clone/src/models/clone-ir-builder.ts`
- Modify: `packages/site-clone/src/schemas/clone-ir.schema.json`
- Verify: `packages/site-clone/test/models.test.ts`

## Implementation Steps
1. In `packages/site-clone/src/models/clone-ir.ts`:
   - Export type aliases:
     ```typescript
     export type ComponentNodeContract = ComponentSectionContract;
     export type ComponentSlotContract = ComponentBlockContract;
     ```
   - Update `ComponentContractIR` interface:
     ```typescript
     export interface ComponentContractIR {
       version: '1.0.0' | '1.1.0' | '1.2.0';
       ...
       sections: ComponentSectionContract[];
       components?: ComponentNodeContract[];
     }
     ```
2. In `packages/site-clone/src/models/clone-ir-builder.ts`:
   - Assign `components: sections` when assembling the final `ComponentContractIR` object.
3. In `packages/site-clone/src/schemas/clone-ir.schema.json`:
   - Add `components` to property definitions with identical array item schema as `sections`.
   - Update `version` enum to allow `"1.2.0"`.
4. Audit `packages/site-clone/src/models/`:
   - Confirm `dom-tree-parser.ts`, `responsive-scanner.ts`, `asset-harvester.ts`, and `ecommerce-data-modeler.ts` do not contain Liquid syntax.
5. Run `npm run test:site-clone` to verify all 39 tests pass.

## Success Criteria
- [x] `ComponentContractIR` contains `components` array identical in length and content to `sections`.
- [x] Schema validator passes with `version: '1.2.0'` and `components`.
- [x] Zero Liquid syntax found in `packages/site-clone/src/models/`.
- [x] All 39 site-clone unit tests pass without errors.

## Risk Assessment
- **Risk:** Existing schema validation tests might fail if `components` is required or schema syntax is invalid.
  - **Observable Signal:** `test/models.test.ts` fails with AJV validation error on `clone-ir.schema.json`.
  - **Mitigation:** Define `components` as optional in both TypeScript interface and JSON schema, maintaining backwards compatibility.
