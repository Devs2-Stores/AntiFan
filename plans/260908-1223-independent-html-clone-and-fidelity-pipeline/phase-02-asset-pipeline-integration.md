---
phase: 2
title: "Asset Pipeline Integration: Harvester to Localizer to Compiler"
status: complete
priority: P1
effort: "4h"
dependencies: ["phase-01-core-test-hardening"]
---

# Phase 2: Asset Pipeline Integration: Harvester to Localizer to Compiler

## Overview
Close the critical integration gap where `ThemeCompiler` only copied pre-existing local assets. Wire `AssetLocalizer.localizePipeline()` directly into the compilation workflow with SSRF protection, IP pinning, content-addressed storage, and full URL rewriting.

## Requirements
- Functional:
  - Connect `AssetLocalizer.localizePipeline()` (A1 download -> A2 rewrite -> A3 verify) into `ThemeCompiler` and `CloneIRBuilder`.
  - Ensure all discovered images, CSS, JS, and fonts are downloaded into local staging before compiler execution.
  - Implement full rewrite of HTML attributes (`src`, `data-src`, `srcset`, `poster`) and CSS `url(...)` declarations to local paths.
  - Universal Remote URL Audit: Scan emitted HTML/CSS/JS for ANY remote URL protocol (`http://`, `https://`, `//`), not merely matching the source domain, ensuring no third-party CDNs, analytics, or trackers remain unlocalized.
  - Chromium Network Denial Gate: Execute independent clone verification under strict Chromium network interception (blocking any request not directed to `localhost` or `file://`). Any intercepted external network request triggers an immediate fail-closed gate.
  - Fail-closed gate: if `verifyAndAudit()` reports unlocalized remote URLs or corrupted downloads, compilation aborts or flags actionable diagnostics.
  - Eliminate all external hotlinks (both origin and third-party trackers).
- Non-functional: Preserve IP-pinning and private subnet blocking invariants (`isPrivateOrReservedIp`).

## Related Code Files
- Modify: `packages/site-clone/src/generators/theme-compiler.ts`
- Modify: `packages/site-clone/src/models/clone-ir-builder.ts`
- Modify: `packages/site-clone/src/models/asset-localizer.ts`
- Create: `packages/site-clone/test/asset-pipeline-integration.test.ts`

## Implementation Steps
1. Extend `ThemeCompiler` configuration to accept an `AssetLocalizer` instance or download options.
2. In `ThemeCompiler.compile()`, execute `localizePipeline()` over the component IR assets before generating files.
3. Validate that generated assets in `dist/assets/` have `byteCount > 0` and correspond to the localized manifest.
4. Add comprehensive verification step in `ThemeCompiler`: scan output Liquid/CSS/HTML for any external URL (`http://`, `https://`, `//`).
5. Implement runtime network denial test in Chromium to prove zero outbound requests during clone rendering.
6. Add integration tests in `packages/site-clone/test/asset-pipeline-integration.test.ts`.

## Success Criteria
- [ ] `ThemeCompiler` automatically downloads and localizes harvested assets.
- [ ] 0 unlocalized remote URLs in compiled output across all domains (universal audit).
- [ ] Chromium network denial gate confirms 0 external requests when clone is rendered.
- [ ] Localized CSS files have all nested `@import` and `url(...)` assets rewritten to relative paths.
- [ ] Integration test passes with 100% assertions green.

## Risk Assessment
- Risk: Network timeouts on slow remote assets during theme compilation.
- Mitigation: Configurable per-asset download timeout and concurrency limit in `AssetLocalizer`.
