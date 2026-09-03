---
phase: 2
title: "Cognitive Models & IR Data Pipeline Wiring"
status: pending
priority: P1
effort: "0.75d"
dependencies: ["1"]
---

# Phase 2: Cognitive Models & IR Data Pipeline Wiring

## Overview
Connect the currently disconnected cognitive models (`AssetHarvester` and `ResponsiveScanner`) into the canonical `ComponentContractIR` pipeline through `CloneIRBuilder`. Strongly type `normalizedData` using `NormalizedProduct[]` and `NormalizedCategory[]`, update `clone-ir.schema.json` with comprehensive property definitions without breaking schema invariants, and remove dead code in `ThemeCompiler`.

## Requirements
- Functional:
  - Extend `ComponentContractIR` in `packages/site-clone/src/models/clone-ir.ts`:
    - Add first-class optional fields: `assets?: HarvestedAssetManifest` and `responsive?: ResponsiveBreakpointConfig`.
    - Create interface `NormalizedStorefrontData`:
      ```typescript
      export interface NormalizedStorefrontData {
        products?: NormalizedProduct[];
        categories?: NormalizedCategory[];
        siteSettings?: {
          title?: string;
          hotline?: string;
          email?: string;
          [key: string]: unknown;
        };
      ```
    - Extend `StorefrontControllerContract` in `packages/site-clone/src/models/clone-ir.ts` with stable ownership fields:
      ```typescript
      export interface StorefrontControllerContract {
        id?: string;
        sectionId?: string; // Stable owner linking directly to ComponentSectionContract.id
        roleId?: string;    // Explicit role identifier (e.g. 'slider_track', 'dropdown_panel')
        type: 'carousel' | 'dropdown' | 'modal' | 'drawer' | 'tabs' | 'form_validation';
        targetSelector: string;
        triggerSelector: string;
        behavior: 'css_scroll_snap' | 'class_toggle' | 'dialog_native' | 'hover_intent';
      }
      ```
    - Replace untyped `normalizedData?: { products?: unknown[]; categories?: unknown[]; ... }` with `normalizedData?: NormalizedStorefrontData`.
    - Update `createDefaultComponentContractIR()` to provide canonical defaults: `ResponsiveScanner.BREAKPOINTS` for `responsive` and an empty `HarvestedAssetManifest` for `assets`.
  - Update `CloneIRBuilder` in `packages/site-clone/src/models/clone-ir-builder.ts`:
    - Instantiate `private assetHarvester = new AssetHarvester();` and `private responsiveScanner = new ResponsiveScanner();`.
    - In `inferControllers(sections)`: explicitly assign `sectionId: sec.id` and `id: `${sec.id}_controller_${idx}`` to every inferred controller.
    - Update `buildFromHtml(html: string, sourceUrl?: string, assetsDir?: string)`:
      - Assign `ir.responsive = ResponsiveScanner.BREAKPOINTS;` (matching the `ResponsiveBreakpointConfig` keyed dictionary type, avoiding array mismatches from `getAllViewports()`).
      - Call `this.assetHarvester.harvestFromHtml(html, assetsDir ?? path.join(os.tmpdir(), 'antifan-assets'))` to populate `ir.assets`.
      - Wire the resulting assets and responsive configurations directly into the returned `ComponentContractIR`.
  - Update `clone-ir.schema.json`:
    - Maintain root `required` array strictly as `["version", "metadata", "layout", "themeSettings", "sections", "storefrontRuntime"]` (preserving existing test assertions in `schema.test.ts`).
    - In `version` property, allow enum `["1.0.0", "1.1.0"]` so both existing 1.0.0 fixtures and new 1.1.0 payloads validate successfully.
    - Add `sectionId` (string) and `roleId` (string) to `StorefrontControllerContract` schema definition.
    - Add definitions in `definitions` for `HarvestedAssetManifest`, `HarvestedAssetItem`, `ResponsiveBreakpointConfig`, `ViewportDefinition`, `NormalizedProduct`, and `NormalizedCategory`.
    - Add `assets`, `responsive`, and `normalizedData` to `properties` using `$ref` pointers to these definitions.
  - Clean `ThemeCompiler` in `packages/site-clone/src/generators/theme-compiler.ts`:
    - Remove dead unused field `private extractor = new BlueprintExtractor();` at line 24.
    - Safeguard asset copying: ensure `ir.assets` items check `fs.existsSync(item.localPath)` before attempting copy to `stagingDir/assets/`.
- Non-functional:
  - Backward compatibility: All existing unit tests (including `theme-compiler.test.ts:160` creating inline IRs without `assets`) must pass without type errors.
  - Strict TypeScript compilation with zero `any` casts in `normalizedData` handling.

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                       CloneIRBuilder                        │
│                                                             │
│  ├── BlueprintExtractor.extractSections(html)               │
│  ├── EcommerceDataModeler.extractStorefrontData(html)       │
│  ├── AssetHarvester.harvestFromHtml(html, assetsDir)        │  <-- Newly Wired
│  └── ResponsiveScanner.BREAKPOINTS                          │  <-- Newly Wired
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             ComponentContractIR (Version 1.1.0)             │
│  ├── metadata: { sourceUrl, extractedAt, engineVersion }    │
│  ├── layout: LayoutConstraints                              │
│  ├── responsive: ResponsiveBreakpointConfig                 │  <-- First-Class
│  ├── assets: HarvestedAssetManifest                         │  <-- First-Class
│  ├── themeSettings: ThemeSettingContract[]                  │
│  ├── sections: ComponentSectionContract[]                   │
│  ├── storefrontRuntime: { controllers[] }                   │
│  └── normalizedData: NormalizedStorefrontData (Typed)       │  <-- Strongly Typed
└─────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Modify: `packages/site-clone/src/models/clone-ir.ts` (Extend `ComponentContractIR` and export `NormalizedStorefrontData`)
- Modify: `packages/site-clone/src/models/clone-ir-builder.ts` (Wire `AssetHarvester` and `ResponsiveScanner` into `buildFromHtml`)
- Modify: `packages/site-clone/src/schemas/clone-ir.schema.json` (Add definitions for assets, responsive, and typed normalizedData)
- Modify: `packages/site-clone/src/schemas/schema.test.ts` (Add test assertions validating `assets` and `responsive` schemas)
- Modify: `packages/site-clone/src/generators/theme-compiler.ts` (Remove dead `extractor` field and guard asset copying)
- Modify: `packages/site-clone/src/models/models.test.ts` (Add unit test verifying `CloneIRBuilder` populates `assets` and `responsive`)

## Implementation Steps
1. In `packages/site-clone/src/models/clone-ir.ts`, import `HarvestedAssetManifest` from `./asset-harvester.js`, `ResponsiveBreakpointConfig` from `./responsive-scanner.js`, and `NormalizedProduct, NormalizedCategory` from `./ecommerce-data-modeler.js`.
2. Define `NormalizedStorefrontData` and update `ComponentContractIR` with optional `assets`, `responsive`, and typed `normalizedData`.
3. Update `createDefaultComponentContractIR` to populate default `responsive` and empty `assets`.
4. In `packages/site-clone/src/models/clone-ir-builder.ts`, import `AssetHarvester` and `ResponsiveScanner`, instantiate them, and populate `assets` and `responsive` inside `buildFromHtml`.
5. In `packages/site-clone/src/schemas/clone-ir.schema.json`, add property definitions for `assets`, `responsive`, and `normalizedData` with their sub-schemas.
6. In `packages/site-clone/src/generators/theme-compiler.ts`, remove unused `extractor` field on line 24.
7. Update `packages/site-clone/src/models/models.test.ts` to assert that `builder.buildFromHtml()` returns an IR with non-empty `assets` and populated `responsive` breakpoints.
8. Rebuild TypeScript (`npm --prefix packages/site-clone run build`) and run test suite to verify 100% green status.

## Success Criteria
- [ ] `CloneIRBuilder.buildFromHtml()` outputs an IR containing non-null `assets`, `responsive`, and typed `normalizedData`.
- [ ] `clone-ir.schema.json` successfully validates both basic IRs and fully populated IRs without schema errors.
- [ ] Dead `BlueprintExtractor` instance completely removed from `ThemeCompiler`.
- [ ] 100% backward compatibility maintained: `theme-compiler.test.ts` passes without regressions.

## Risk Assessment
- **Risk**: `AssetHarvester` attempts to write remote assets to disk during fast unit tests, causing slow I/O or filesystem permission issues.
  - *Observable Signal*: Unit test timeouts or `EACCES` file errors in temp directory.
  - *Mitigation*: Support an in-memory extraction mode or default to OS temporary directory with automatic cleanup.
