# Visual Evidence Receipt: Hoplongtech Standalone Canary vs Live Storefront

**Date:** 2026-09-08  
**Run ID:** run-71e3fc3e-9951-442d-82e2-1a889ef602ec  
**Status:** PASS (Fidelity Verification < 2% across 3 canonical viewports)

## Viewport Comparative Evidence

| Viewport | Selector / ClipRect | Mismatch % | Threshold | Verdict | Artifact IDs |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Desktop (1440x900)** | `header.site-header` | **0.24%** | < 2.0% | **PASS** | `artifact-198fcc35-965b-4338-90a0-5e66ee9c8d17` / `artifact-6b5671ee-0cdc-4eb1-98a9-08db599115d0` |
| **Tablet (768x1024)** | ClipRect `0,0,768,140` | **0.88%** | < 2.0% | **PASS** | `artifact-e2c576db-e35f-45c2-a8cd-8db1555f23bf` / `artifact-3a60a37e-4954-49c9-9aa5-2943f67bd6f3` |
| **Mobile (375x667)** | ClipRect `0,0,375,140` | **1.69%** | < 2.0% | **PASS** | `artifact-599e122e-02d9-405f-b913-48b5515eca9a` / `artifact-6513f3f4-98dc-4d49-904e-942392ea34b7` |

## Core Triage & Bug Fixes Validated

1. **Semantic Section Classification Priority**:
   - Fixed `BlueprintExtractor.classifySectionType` to prioritize semantic classes (`news`, `accessory`, `partner`, `product`) before generic carousel structure inspection.
   - Verified via `BlueprintExtractor` unit test suite (7/7 pass).

2. **Global Multi-Section Card Cardinality Bounds & Splicing**:
   - Enforced global representative data bounds (12 products, 6 articles) passing down retained budget across multiple section grids.
   - Replaced fragile DOM reserialization with exact `outerHtml` slice bounds pruning in document order from end to start.
   - Verified via `IndependentHtmlCloneGenerator` unit test suite (4/4 pass).

3. **Slider Freezing & Non-Destructive Width Restoration**:
   - `media.freeze` script updated to record and restore `width` property alongside transforms.
   - Track width forced distortion removed to allow natural slider library layout calculations without collapsing.
   - Verified via `InjectedScriptStore` unit test suite (6/6 pass).
