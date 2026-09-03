---
phase: 1
title: "Core Browser Tool Neutralization & Platform Detector Delegation"
status: completed
priority: P1
effort: "45m"
dependencies: []
---

# Phase 1: Core Browser Tool Neutralization & Platform Detector Delegation

## Overview
Eliminate hardcoded platform assumptions (`shopify-section-`, `haravan-section-`, `/products/*.js`) in `src/main/tools/browser-capabilities.ts`. Refactor `getThemeHierarchyScript` and `getProductResolverScript` to prioritize standard HTML5 landmarks and Schema.org semantic metadata, delegating platform-specific fallback resolution to `PlatformDetector`.

## Requirements
- **Functional:**
  - `getThemeHierarchyScript` must query standard semantic HTML landmarks (`header`, `nav`, `main`, `section`, `article`, `aside`, `footer`, `[data-component]`, `[data-section]`) in addition to platform-specific attributes.
  - `getProductResolverScript` must query standard Schema.org structured data (`script[type="application/ld+json"]`), microdata (`[itemscope][itemtype*="Product"]`), OpenGraph tags (`meta[property="og:price:amount"]`), and data attributes (`data-product-json`) before attempting platform-specific endpoint queries.
  - Platform-specific fetches (`/products/${handle}.js`) must only be triggered when `PlatformDetector.detectFromRuntime` confirms Shopify or Haravan runtime presence.
- **Non-functional:**
  - Zero regression on existing Haravan/Shopify storefront resolution.
  - Clean error handling with informative fallback messages when viewing generic, custom, or SPA storefronts.

## Architecture
```text
Browser Evaluation Context (Page Script)
              │
              ├── 1. Query Universal Semantic HTML Landmarks (header, main, section...)
              ├── 2. Query Schema.org & Microdata (JSON-LD Product, OpenGraph Meta)
              │
              ▼ (If missing & Platform Detector indicates Shopify/Haravan)
              └── 3. Safe Platform Fallback (/products/${handle}.js)
```

## Related Code Files
- Modify: `src/main/tools/browser-capabilities.ts`
- Reference: `src/main/qa/scanners/platform-detector.ts`
- Verify: `test/unit/browser-capabilities.test.ts` (if exists) or unit test suite

## Implementation Steps
1. Inspect `getThemeHierarchyScript` in `src/main/tools/browser-capabilities.ts` (lines 13–28).
2. Expand selector to include semantic landmarks:
   `header, nav, main, section, footer, article, aside, [data-section-id], [data-section-type], [data-component], section[id^="shopify-section-"], section[id^="haravan-section-"]`.
3. Enhance `getProductResolverScript` (lines 29–93):
   - First check for `script[type="application/ld+json"]` with `"@type": "Product"`.
   - Check `meta[property="product:price:amount"]` / `meta[property="og:price:amount"]`.
   - Check `[data-product-json]`.
   - Only execute `fetch('/products/' + handle + '.js')` if runtime URL or DOM confirms Haravan/Shopify platform markers.
4. Run `npm run typecheck` to confirm zero compilation errors.

## Success Criteria
- [x] `getThemeHierarchyScript` resolves structural sections on generic non-Shopify/non-Haravan websites.
- [x] `getProductResolverScript` extracts product metadata from standard JSON-LD and OpenGraph tags without requiring `/products/*.js`.
- [x] Zero TypeScript errors in `src/main/tools/browser-capabilities.ts`.

## Risk Assessment
- **Risk:** Existing Haravan/Shopify storefronts might fail if JSON-LD has different schema formatting than expected.
  - **Observable Signal:** `theme.resolve_product` returns `ok: false` on previously passing test fixtures.
  - **Mitigation:** Keep the `/products/${handle}.js` fallback path active when JSON-LD is absent or incomplete.
