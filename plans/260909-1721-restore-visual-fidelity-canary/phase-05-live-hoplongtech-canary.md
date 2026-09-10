---
title: "Phase 5: Live Hoplongtech Canary"
status: done
---

# Phase 5: Live Hoplongtech Canary

## Outcome

Run the complete production clone path against `https://hoplongtech.com/` and collect immutable real-Chromium evidence at exactly `1440×900`, `1024×900`, and `390×844`.

## Preconditions

- [x] Phase 4 is fully green; no live run starts on an unproven recovery path.
- [x] `.canary/run1/` and `.canary/run2/` remain byte-for-byte untouched.
- [x] Start or reuse one project-owned AntiFan process with the explicit canary artifact configuration; never stop user-owned processes and never raise ordinary runtime limits.
- [x] Before creating `.canary/run3/` or writing evidence, call `artifact.preflight` against that runtime to acquire an exclusive lease for a fresh dedicated Run 3 evidence `runId`; abort on capacity or ownership rejection.
- [x] After lease acceptance, create `.canary/run3/` with distinct `reference/`, `clone/`, `evidence/`, `diff/`, and `sections/` outputs. Use no concurrent staging for the leased `runId`; every large stage rechecks committed bytes immediately before write, and finally release the lease after report persistence or failure cleanup.

## Production Pipeline

- [x] Capture a fresh accepted reference DOM and resource state from the live storefront.
- [x] Execute actual `CloneIRBuilder`, `AssetHarvester`, blueprint/component extraction, `AssetLocalizer`, A2 preservation/rewrites, and `IndependentHtmlCloneGenerator` paths.
- [x] Record A0 source/resolved URL, type, role, provenance, origin, and local/external status for `img src`, `data-src`, `srcset`, `picture/source`, CSS URLs, `@font-face`, video/source/poster, external SVG, and backgrounds.
- [x] Record A1 status, final URL, content type, magic bytes, decode validity, SHA256, output path, containment, redirects, failures, and unresolved resources.
- [x] Serve the generated independent bundle locally through the hardened server; never proxy or embed Hoplongtech HTML or visual assets.

## Per-Viewport Procedure

For each exact viewport, starting from fresh equivalent hydration state:

1. Apply identical CSS viewport, DPR `1`, zoom `1`, and emulation mode to reference and clone.
2. Reload both sides on viewport change; do not reuse DOM state mutated by the preceding viewport.
3. Run canonical network, fonts, images, DOM, and visual-stability settlement; record duration, pending requests, and broken images.
4. Mark that viewport `INCONCLUSIVE` if settlement or target identity cannot be established.
5. Capture and persist independent raw full-page reference and candidate PNGs through the standalone verification capability; verify receipt, complete decode, dimensions, byte length, SHA256, and label them non-authoritative for pixel verdicts.
6. Run the global compare with `tolerance: 2`, `allowHeightDrift: false`, `useDefaultWidgetMasks: false`, no user masks, and explicit tracked structural selectors. Inside one pair lock, normalize and settle both tabs before either capture, open both coherence windows, capture/stage its exact raw pair, post-check both identities, and use only that pair for the authoritative pixel result.
7. Record pixel mismatch, changed pixels, dimensions, diff bounding boxes/regions, height, overflow, structural metrics, and mask ledger.
8. Run independent unmasked structural probes for page/header/nav/hero/major sections/cards/grids/articles/footer, container width, image ratios, text line counts, responsive stacking, and clipping.
9. Run sectional clip diagnostics for header, hero, primary navigation, product/category sections, content/articles, and footer; never substitute these for the global result.
10. Run a reference self-drift pair under identical state. Never subtract drift or hide it with broad masks; classify incompatible target instability as `TARGET_STALE`/`INCONCLUSIVE`.
11. Persist evidence JSON and hashes immediately before moving to the next viewport; serialize all staging under the exclusive evidence-run lease and recheck committed capacity before every large artifact write.

## Asset and Dependency Audit

- [x] Report discovered counts by source mechanism and resource role.
- [x] Verify every localized image/font/SVG/background/poster/video is fetched, decoded, rendered, and geometrically plausible.
- [x] Audit runtime performance entries and network telemetry; clone reference-origin visual requests must equal zero.
- [x] Separate allowed navigation links and non-visual third-party/runtime traffic from forbidden reference-origin visual dependencies.
- [x] Report localized, failed, broken, hash-mismatched, unresolved, and remaining remote visual resources.

## Required Evidence Per Viewport

- [x] Independent reference/candidate PNGs, SHA256, and standalone capture receipts.
- [x] Authoritative atomic-compare reference/candidate PNGs, SHA256, and before/after target identity receipts when pair capture completed.
- [x] Settlement receipt for both sides.
- [ ] Full-page diff receipt tied to the authoritative pair, plus diagnostic diff image when comparison ran. (Comparison halted with INCONCLUSIVE due to capture size mismatch; no pixel diff receipt or diff image was produced per typed fail-closed contract).
- [x] Structural receipt with cardinality, grid, section, geometry, text, image, and overflow measurements.
- [x] Mask ledger with requested/resolved/unresolved selectors and masked-area ratio.
- [x] Runtime asset/dependency audit.

## Done When

All three exact viewports have real Chromium raw pairs plus settlement, capture, structural, mask, and dependency evidence. Missing pixel evidence remains explicitly `INCONCLUSIVE`; no DOM-only substitute is accepted.
