# chromium-45-cases-results.json — INVALID, DO NOT CITE

Status: `INVALID — NOT REVISION-BOUND`. The stored artifact claims `totalCases=45`,
`passedCases=45`, `passRate=100.0%` for store `phukienmaymoc.com`, theme
`1001512581`, timestamp `2026-09-11T18:25:51.232Z`. The tallies are internally
consistent; the claim that they certify storefront behavior for that theme does not
hold, for the four measured reasons below.

## Measured disqualifiers (2026-09-12, on the stored file)

1. **Wrong theme-selection parameter.** All 45 case URLs use
   `?preview_theme_id=1001512581` (45 occurrences); zero use `?themeid=`.
   `specs/base-theme-contract.json` records `?preview_theme_id=` as completely
   inert on unauthenticated storefront GETs — the response is the live theme
   (role `main`), not the requested copy. A run over that parameter measured a
   theme the artifact does not name.
2. **Viewport never applied.** `metrics.docWidth` is `1905` for all 45 cases,
   although the cases declare `desktop 1440x900`, `laptop 1024x900` and
   `mobile 390x844`. Device metrics were not set, so the three breakpoints are
   three labels on one 1905px-wide render.
3. **Document never complete.** Every case reports `hasFooter: false`, so no
   case captured a full page header-to-footer.
4. **No case is bound to a revision.** Case records carry `docWidth`, `docHeight`,
   `textLength` and a page title, but nothing that identifies which theme revision
   produced the document. `reports/chromium-verification/` holds exactly one
   results file, so there is no second stored tally to cross-check; this file's own
   summary is internally consistent (`45/45`) and the disqualifiers are 1–3.

## Why this matters

The harness certified its own output as a platform-verified pass while
addressing no Haravan theme and never applying a viewport. Any downstream
conclusion that storefront behavior was verified for theme `1001512581` is
unsupported.

## Enforcement now in place

`packages/site-clone/src/qa/dod-validator.ts:auditHaravanPreview` accepts only a
numeric `?themeid=<id>` query parameter. The Shopify spellings `theme_id=` and
`preview_theme_id=` are refused
(`packages/site-clone/src/qa/dod-validator.test.ts`, cases under
`12) haravanPreview`). Current capture scripts
(`scripts/verify-storefront-chromium.mjs`, `scripts/verify-storefront-chromium-direct.mjs`)
use `?themeid=`.

## What a replacement artifact must carry

- numeric `?themeid=<themeId>` on every case URL, with `themeId` equal to
  `targetThemeId`;
- the declared viewport actually applied, verified by measuring
  `window.innerWidth` per case, not by a label;
- full-page scroll evidence with the footer present;
- a theme identity attestation — org id, theme id and the rendered asset
  revision segment from the `cdn.hstatic.net/themes/<orgId>/<themeId>/<revision>/`
  asset path, or a watermark injected into the layout and asserted before capture;
- exactly one tally, derived from `results[]`, with the failure list retained.
