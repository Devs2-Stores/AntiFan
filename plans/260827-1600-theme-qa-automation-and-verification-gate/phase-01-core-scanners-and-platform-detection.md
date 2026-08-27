---
phase: "01"
title: "Core Scanners & Platform Context Detection"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 01: Core Scanners & Platform Context Detection

## Overview
Implement the foundational scanning modules to accurately detect the e-commerce platform (Haravan, Sapo, or Shopify) from both workspace files and live browser targets, detect 100% of runtime Liquid error strings, and inspect broken CDN/image assets without cross-platform false alarms.

## Requirements
- **PlatformDetector**:
  - Detect from Workspace root: Haravan (`config/settings_schema.json`, `config/settings.html`, `locales/`), Sapo (`config/settings_data.json` with `.bwt` templates), Shopify (`sections/*.liquid`, `config/settings_schema.json` with Shopify syntax).
  - Detect from live URL/DOM: CDN hostnames (`hstatic.net`, `bizweb.dktcdn.net`, `cdn.shopify.com`), meta generators, window objects (`Haravan`, `Bizweb`, `Shopify`).
- **LiquidErrorScanner**:
  - Scan active DOM for string patterns: `Liquid error:`, `Liquid syntax error`, `Translation missing:`, `Could not find snippet`, `Snippet not found`, `Template missing`, `Included file not found`.
  - Extract the parent element CSS selector and snippet HTML context.
- **BrokenAssetScanner**:
  - Check DOM images: `img.complete && img.naturalWidth === 0`, broken `srcset`, missing `src`.
  - Capture CDP network failed responses (HTTP 4xx/5xx) for CSS, JS, font, and image files.

## Architecture & Data Flow
```text
Browser Target / Workspace Root
      │
      ▼
PlatformDetector ──► { platform: 'haravan' | 'sapo' | 'shopify' | 'generic', confidence: 'high' | 'medium' }
      │
      ├───────────────────────────────┬───────────────────────────────┐
      ▼                               ▼                               ▼
LiquidErrorScanner               BrokenAssetScanner             Platform Rules
(Injected Script/CDP)            (DOM Images + CDP Network)     (Scoping Filter)
      │                               │                               │
      └───────────────────────────────┴───────────────────────────────┘
                                      │
                                      ▼
                        Enriched Scanner Findings Payload
```

## Related Code Files
- Create:
  - `src/main/qa/scanners/platform-detector.ts`
  - `src/main/qa/scanners/liquid-error-scanner.ts`
  - `src/main/qa/scanners/broken-asset-scanner.ts`
- Tests:
  - `test/main/platform-detector.test.ts`
  - `test/main/liquid-error-scanner.test.ts`
  - `test/main/broken-asset-scanner.test.ts`

## Implementation Steps
1. Create `src/main/qa/scanners/platform-detector.ts` with static file detection and live URL/DOM heuristic rules.
2. Create `src/main/qa/scanners/liquid-error-scanner.ts` containing safe browser-injected evaluation script and TreeWalker scanner.
3. Create `src/main/qa/scanners/broken-asset-scanner.ts` inspecting `HTMLImageElement` states and CDP network response records.
4. Write unit tests for all 3 scanners with mock DOM and network fixtures.

## Success Criteria
- [ ] `PlatformDetector` correctly classifies Haravan, Sapo, and Shopify fixtures with 100% accuracy.
- [ ] `LiquidErrorScanner` captures all variations of template/snippet/translation missing strings with element CSS selectors.
- [ ] `BrokenAssetScanner` flags broken images and 404 assets without failing on valid data URIs or lazy-loaded placeholder images.
- [ ] All unit tests pass in `< 1000ms`.

## Risk Assessment
- **Risk:** False positive on words like "Liquid error" if written inside blog post body content by a merchant.
- **Mitigation:** Only flag when found inside theme section/snippet elements or comment nodes, and ignore user-generated content wrappers (`.article-content`, `.wysiwyg-content`).
