---
phase: 4
title: "Hybrid Extraction Intelligence & End-to-End Verification"
status: pending
priority: P2
effort: "1d"
dependencies: ["3"]
---

# Phase 4: Hybrid Extraction Intelligence & End-to-End Verification

## Overview
Upgrade `EcommerceDataModeler` to employ Hybrid Pattern Detection, freeing product and collection extraction from narrow hardcoded class vocabularies (`product-item`, `product-card`). Implement a tripartite Confidence Scoring formula combining semantic class priors, DOM geometric repetition, and currency regex patterns. Harden price parsing against ranges and diverse currency formats. Execute end-to-end certification across all existing test suites, schema checks, and the newly built `MutationQAHarness`.

## Requirements
- Functional:
  - Upgrade `EcommerceDataModeler` in `packages/site-clone/src/models/ecommerce-data-modeler.ts`:
    - **Mandatory Prerequisite Gate**:
      Before computing confidence scores, every candidate node must satisfy at least ONE commercial anchor:
      $$(\text{Subtree contains currency match: } S_{\text{price}} > 0) \lor (\text{Link href matches } /\/(products|san-pham)\//) \lor (\text{Schema.org Product microdata})$$
      Candidates failing this prerequisite are immediately rejected, preventing mega-menus, blog lists, and brand carousels from being misclassified.
    - **Negative Context Exclusions**:
      Nodes descending from `<nav>`, `<header>`, `<footer>`, `.menu`, `.category-navigation`, `.blog`, `.article`, or `.news` are strictly excluded from product card clustering.
    - **Harden Hybrid Detection Formula**:
      $$\text{Confidence} = 0.35 \times S_{\text{class}} + 0.35 \times S_{\text{repetition}} + 0.30 \times S_{\text{price}}$$
      - $S_{\text{class}} \in [0, 1]$: Element matches specific product tokens (`product`, `card-product`, `prod-`, `product-item`, `product-card`, microdata `itemtype*="Product"`). The ubiquitous generic token `'item'` is strictly omitted.
      - $S_{\text{repetition}} \in [0, 1]$: Parent container has $\ge 3$ sibling elements sharing the identical tag name, structural depth, and containing both an `<img>` and an `<a>` tag.
      - $S_{\text{price}} \in [0, 1]$: Subtree contains a text node matching currency regex patterns (`\d+[\.,]?\d*\s*(?:₫|đ|VND|VNĐ|USD|\$|€)`).
      - Candidate clusters with $\text{Confidence} \ge 0.60$ that satisfy the mandatory anchor gate are accepted.
      - Replace naive `clean.replace(/[^0-9]/g, '')` with a structured parser:
        - Detects price ranges (e.g. `1.299.000 - 1.599.000đ` -> extracts minimum price as `price` and maximum as `compareAtPrice`).
        - Handles Vietnamese dot separators (`1.299.000đ` -> `1299000`) and standard comma separators (`1,299,000`).
        - Rejects NaN, returning valid numerical values or sensible fallbacks without crashing.
    - **Hierarchical Category Tree Extraction**:
      - Expand category extraction beyond flat `.category-list .item`:
      - Detect nested `<ul>`/`<li>` trees within `<nav>` or `.header` elements to model multi-level categories with parent-child relationships.
  - End-to-End Verification & Certification:
    - Run the complete test suite: `node --test packages/site-clone/dist/**/*.test.js`.
    - Run `MutationQAHarness` against synthetic and live storefront DOMs across the 3 scenarios (Text Stretch, Cardinality Shift, Image Ratio).
    - Verify 100% pass on all 8 QA dimensions with zero Hard Blockers.
    - Verify generated Haravan Theme OS 2.0 package compiles into valid `theme/` directory with zero Liquid syntax errors and compliant `config/settings_schema.json`.
- Non-functional:
  - Total extraction latency must not exceed 500ms on a 3,000-node DOM.
  - Zero memory leaks during repetitive extraction passes.

## Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                 Candidate DOM Subtree Cluster               │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Hybrid Confidence Scoring Evaluator           │
│  ├── S_class (Weight 0.35): Semantic Class / Microdata Match│
│  ├── S_repetition (Weight 0.35): DOM Structural Symmetry    │
│  └── S_price (Weight 0.30): Currency / Money Text Regex     │
│                                                             │
│  Score >= 0.60 & Anchor Gate ──► NormalizedProduct Candidate│
│  Score <  0.60 ──► Discarded as Non-Product Element         │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    Structured Price Parser                  │
│  - Detects ranges: "1.200.000đ - 1.500.000đ"               │
│  - Handles dot/comma thousands separators                   │
│  - Output: { price: 1200000, compareAtPrice: 1500000 }      │
└─────────────────────────────────────────────────────────────┘
```

## Related Code Files
- Modify: `packages/site-clone/src/models/ecommerce-data-modeler.ts` (Implement Hybrid Confidence Scoring and resilient price parsing)
- Modify: `packages/site-clone/src/models/models.test.ts` (Add test cases for obfuscated classes and price ranges)
- Modify: `packages/site-clone/src/qa/clean-tab-probe.ts` (Integrate with upgraded modeler and MutationQAHarness)
- Inspect: `packages/site-clone/src/generators/theme-compiler.ts` (Verify end-to-end theme generation from hybrid IR)

## Implementation Steps
1. In `packages/site-clone/src/models/ecommerce-data-modeler.ts`, implement `calculateProductConfidence(node, parentCluster): number` evaluating class priors ($0.35$), structural symmetry ($0.35$), and currency regex ($0.30$), gated by the mandatory commercial anchor check.
2. Refactor `extractProducts()` to scan all child clusters, evaluate confidence scores, and extract product cards meeting the $\ge 0.60$ threshold.
3. Replace `parsePrice()` with `parseStructuredPrice(text)` supporting range splitting (`-`, `~`, `đến`), currency symbol stripping, and thousands-separator normalization.
4. Enhance `extractCategories()` to detect recursive `nav ul li` structures and build hierarchical category trees.
5. In `packages/site-clone/src/models/models.test.ts`, build a labeled fixture corpus (10 positive product cards across standard/obfuscated markup and 10 negative non-product elements including mega-menus, blog grids, and footer link lists).
6. Add unit tests for price range parsing (`1.000.000đ - 2.000.000đ` -> `price: 1000000`, `compareAtPrice: 2000000`).
7. Run the full test suite including `MutationQAHarness`:
   `npm run test:site-clone`
8. Compile a sample theme from the hybrid IR and verify all output files in `stagingDir` are syntactically valid Liquid and JSON.

## Success Criteria
- [ ] Labeled multi-site fixture corpus (10 positive product clusters across standard and obfuscated markup vs 10 negative non-product clusters including mega-menu, blog grid, and brand footer) achieves 100% precision (zero non-product false positives) and $\ge 90\%$ recall.
- [ ] Price ranges and formatted currency strings parse accurately into numerical values without `NaN` errors.
- [ ] All test suites (schema, models, generators, QA probes, mutation harness) pass with 100% green status via `npm run test:site-clone`.
- [ ] End-to-end compilation produces a clean, production-ready Haravan OS 2.0 theme.

## Risk Assessment
- **Risk**: Over-eager repetition detection classifying navigation menus or footer link columns as product cards.
  - *Observable Signal*: Footer links extracted as products with `price: 0`.
  - *Mitigation*: Strictly require presence of image (`<img>` or `background-image`) AND a currency pattern or product URL pattern before accepting candidate nodes.
