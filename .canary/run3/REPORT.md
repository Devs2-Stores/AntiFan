# AntiFan Real Independent HTML Fidelity Canary — Recovery Report



## 1. Environment

```text
Run directory:  .canary/run3
Evidence dir:   .canary/run3/evidence (9 JSON documents)
Generator:      build-report.mjs (phase-06-report-and-fidelity-gate)
Report anchor:  2026-09-09T15:55:04.366Z
Reference URL:  https://hoplongtech.com/
Clone URL:      http://127.0.0.1:7852/
Runtime:        node v24.13.0 on win32 x64
Clone bundle:   .canary/run3/clone/index.html
Clone input:    .canary/run3/reference/reference.html
```

Persisted evidence inventory (sha256 computed at generation time):

| Document | Role | Bytes | sha256 |
| --- | --- | --- | --- |
| .canary/run3/evidence/asset-audit.json | audit | 2813 | 048cc07d1e4469c28e1a1a5f8ecc7d15ca288b5df72c2af585d985ca2d95e59e |
| .canary/run3/evidence/build-telemetry.json | telemetry | 59856 | 30d1036b008aac23f135b0c42da8d38c94ff844a387b5d682370508330193837 |
| .canary/run3/evidence/pipeline.json | other | 33965 | e08b4773619c7676f31cf5ce94f42793f7953ae60f809dafba355862c3ad99b6 |
| .canary/run3/evidence/reference-dump.json | other | 3006 | 8aa46a7b84b36242e69080d6fae365ef56607e298259e3b5c115e298c4ac7306 |
| .canary/run3/evidence/reference-prepare.json | other | 1377 | 501bc48a7c91744654ae405efed636b55b7e3f8496ab20e39f3cd683b2366350 |
| .canary/run3/evidence/run3-1024.json | viewport | 151976 | a760d1ed8fce03f50dc555de30049c2dfc52508e6c69e027d9e19fed12c36d4c |
| .canary/run3/evidence/run3-1440.json | viewport | 152025 | f63dc46dc1ae248b7cad83fbb8d77cdb8af297f6580a944f6fdde400099cf18f |
| .canary/run3/evidence/run3-390.json | viewport | 152057 | 3951531b7d26809c249f52253732001365354193b2ac67312ca8fca956e68dc3 |
| .canary/run3/evidence/summary.json | other | 24575 | 838ee2ae1f02cc8cfbb0894fdbc432b1d0b7be9ee7096fe688091a8bd6ba6d32 |

Standalone full-page captures recorded in this run are independent continuity evidence. Only the atomic compare pair is an authoritative pixel input; this generator never merges, substitutes, or chooses between the two lineages.

## 2. Pipeline Tested

| Stage | Real implementation | Executed |
| --- | --- | --- |
| A0 Discovery | AssetHarvester via CloneIRBuilder.harvestFromHtml | YES (108 resources) |
| A1 Localization | AssetLocalizer | YES (118 files) |
| A2 Optimization/Preservation | IndependentHtmlCloneGenerator (localize + rewrite + audit) | YES |
| Independent HTML Generation | IndependentHtmlCloneGenerator.generateCloneBundle | YES (675,441 B) |
| Chromium Render | live AntiFan Desktop tabs (real Chromium) | YES (3 viewports) |
| Settlement | runtime settle probe (network/fonts/images/DOM/visual) | YES (3/3 viewports) |
| Standalone Capture | anti.screenshot.full_page (independent continuity evidence) | YES (3/3) |
| Visual Compare | anti.visual.compare (atomic pair) | PAIR PRESENT (3/3) |
| Structural Verification | unmasked live geometry/cardinality probes on both tabs | YES |
| Fidelity Gate | this report (deterministic from persisted evidence) | EVALUATED |

Compare results evaluated: 0/3 viewports; authoritative pairs: 3/3.

## 3. Reference Capture

| Viewport | Reference URL | docHeight | Sections | Cards | Images | Settlement | Capture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | https://hoplongtech.com/ | 5422 | 12 | 25 | 105 | settled 3281 ms | atomic pair recorded |
| 1024×900 | https://hoplongtech.com/ | 5546 | 12 | 25 | 105 | settled 3271 ms | atomic pair recorded |
| 390×844 | https://hoplongtech.com/ | 14650 | 12 | 25 | 105 | settled 2880 ms | atomic pair recorded |

Readiness floors are derived from the captured reference artifact; a reference that no longer exposes that structure is rejected (`REFERENCE_NOT_READY`) rather than measured.

## 4. Asset Discovery (A0, real storefront)

```text
stylesheets            2
javascripts            4
images                 102
fonts (A0 counter)     0
total resources        108
image hosts            img.hoplongtech.com 100, hoplongtech.com 2
unresolvedRelative     1 (A0 telemetry label; localization outcome is audited in §5)
by archetype           header 1, custom_section 9, hero_slider 2, collection_list 1, product_grid 5, rich_text 1, footer 1
```

## 5. Asset Localization (A1/A2)

```text
localized                118 files / 36,671,943 bytes
zero-byte                0
missing sha256           0
missing magic bytes      0
formats                  css 2, jpg 44, js 4, png 57, ttf 10, webp 1
remote subresources in generated HTML  0
localized asset files    118 / 36,671,943 bytes
```

Every referenced asset above was resolved and hash-verified against its persisted receipt during report generation; a missing or mismatched asset fails generation instead of producing a verdict.

## 6. Independent HTML

```text
output      .canary/run3/clone/index.html
bytes       675,441
sha256      7d8a380609c40d0a8856454fea8b41326bcec7269036210d7f9b436ef38f5053
assets      118 files / 36,671,943 bytes
blueprints  20
products    6 (normalized) / articles 4
remote navigation links (allowed)  120
```

## 7. Live Chromium Results

| Viewport | Pixel Diff | Height Diff | Structural | Assets | Settlement | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | BLOCKED | -4 px (5422 → 5418, ratio 0.999) | 12/12 sections, 25/25 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 3281 ms / clone 4885 ms) | INCONCLUSIVE |
| 1024×900 | BLOCKED | -5 px (5546 → 5541, ratio 0.999) | 12/12 sections, 25/25 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 3271 ms / clone 4910 ms) | INCONCLUSIVE |
| 390×844 | BLOCKED | -8 px (14650 → 14642, ratio 0.999) | 12/12 sections, 25/25 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 2880 ms / clone 4485 ms) | INCONCLUSIVE |

`Verdict` is the per-viewport gate outcome defined in §14. A placeholder numeric produced by a dimensions short-circuit is never treated as a pixel measurement.

## 8. Structural Findings

### 1440×900

```text
docHeight        reference 5422 → candidate 5418 (-4 px, ratio 0.999)
overflowX        reference 0 → candidate 0
sectionCount     12 → 12
productCardCount 25 → 25
articleCardCount 4 → 4
navItemCount     8 → 8
linkCount        249 → 249 (diagnostic; time-dependent on hydrated targets)
imageCount       105 → 105
brokenImages     0 → 0
```

Non-zero matched section deltas:

| Section | Reference h | Candidate h | Δh |
| --- | --- | --- | --- |
| partner | 222 | 218 | -4 |

```text
grid             reference flex 5×1 (5 children)
                 candidate flex 5×1 (5 children)
fonts            body Roboto 14px/400 | h1 Roboto 28px/600 | h2 Roboto 18px/600
```

Capture-state note: this viewport has no verified atomic pair, so the geometry above is observed structural evidence only; it is not attributed to the clone as a pixel-verified defect.

### 1024×900

```text
docHeight        reference 5546 → candidate 5541 (-5 px, ratio 0.999)
overflowX        reference 0 → candidate 0
sectionCount     12 → 12
productCardCount 25 → 25
articleCardCount 4 → 4
navItemCount     8 → 8
linkCount        249 → 249 (diagnostic; time-dependent on hydrated targets)
imageCount       105 → 105
brokenImages     0 → 0
```

Non-zero matched section deltas:

| Section | Reference h | Candidate h | Δh |
| --- | --- | --- | --- |
| site-header | 174 | 173 | -1 |
| partner | 222 | 218 | -4 |

```text
grid             reference flex 5×1 (5 children)
                 candidate flex 5×1 (5 children)
fonts            body Roboto 14px/400 | h1 Roboto 28px/600 | h2 Roboto 18px/600
```

Capture-state note: this viewport has no verified atomic pair, so the geometry above is observed structural evidence only; it is not attributed to the clone as a pixel-verified defect.

### 390×844

```text
docHeight        reference 14650 → candidate 14642 (-8 px, ratio 0.999)
overflowX        reference 285 → candidate 285
sectionCount     12 → 12
productCardCount 25 → 25
articleCardCount 4 → 4
navItemCount     8 → 8
linkCount        249 → 249 (diagnostic; time-dependent on hydrated targets)
imageCount       105 → 105
brokenImages     0 → 0
```

Non-zero matched section deltas:

| Section | Reference h | Candidate h | Δh |
| --- | --- | --- | --- |
| site-header | 362 | 358 | -4 |
| partner | 222 | 218 | -4 |

```text
grid             reference flex 1×5 (5 children)
                 candidate flex 1×5 (5 children)
fonts            body Roboto 14px/400 | h1 Roboto 28px/600 | h2 Roboto 18px/600
```

Capture-state note: this viewport has no verified atomic pair, so the geometry above is observed structural evidence only; it is not attributed to the clone as a pixel-verified defect.


## 9. Visual Findings

Authoritative pixel inputs (atomic compare pairs only):

| Viewport | Mismatch | Diff px | Total px | dimensionsMatch | Compare verdict |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | 100.00% | n/a | 0 | n/a | INCONCLUSIVE |
| 1024×900 | 100.00% | n/a | 0 | n/a | INCONCLUSIVE |
| 390×844 | 100.00% | n/a | 0 | n/a | INCONCLUSIVE |

```text
authoritative pixel inputs : 3/3 viewports (atomic compare pair)
independent continuity     : 3/3 viewports (standalone full-page captures, never authoritative)
placeholder numerics       : 0 viewport(s) — excluded from pixel verdicts
```

Reference self-drift diagnostic (never subtracted from candidate mismatch, never used to relax the 2% target):

| Viewport | Self-drift | dimensionsMatch | mask ratio | capture state | identity |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | 0.00% | true | 0.00% | n/a | n/a |
| 1024×900 | 0.00% | true | 0.00% | n/a | n/a |
| 390×844 | 0.00% | true | 0.00% | n/a | n/a |

Sectional clip diagnostics (non-authoritative, never substituted for the global result):

| Viewport | Region | Mismatch | Status |
| --- | --- | --- | --- |
| 1440×900 | header | 0.24% | measured |
| 1440×900 | hero | 21.12% | measured |
| 1440×900 | section:site-header | 0.24% | measured |
| 1440×900 | section:slide | 20.96% | measured |
| 1440×900 | section:category-list | 0.00% | measured |
| 1440×900 | section:banner-category | 1.20% | measured |
| 1440×900 | section:block-category | 0.04% | measured |
| 1440×900 | section:block-category | 0.01% | measured |
| 1440×900 | section:block-category | 0.02% | measured |
| 1440×900 | section:block-category | 0.04% | measured |
| 1440×900 | section:block-category | 0.03% | measured |
| 1440×900 | section:home-form | 0.00% | measured |
| 1440×900 | section:accessory | 0.00% | measured |
| 1440×900 | section:news | 0.41% | measured |
| 1440×900 | section:partner | 6.39% | measured |
| 1440×900 | section:site-footer.w-100 | 2.86% | measured |
| 1440×900 | footer | 2.86% | measured |
| 1024×900 | header | 0.66% | measured |
| 1024×900 | hero | 36.29% | measured |
| 1024×900 | section:site-header | 0.66% | measured |
| 1024×900 | section:slide | 45.02% | measured |
| 1024×900 | section:category-list | 0.87% | measured |
| 1024×900 | section:banner-category | 3.77% | measured |
| 1024×900 | section:block-category | 4.01% | measured |
| 1024×900 | section:block-category | 3.58% | measured |
| 1024×900 | section:block-category | 3.25% | measured |
| 1024×900 | section:block-category | 2.93% | measured |
| 1024×900 | section:block-category | 3.14% | measured |
| 1024×900 | section:home-form | 1.31% | measured |
| 1024×900 | section:accessory | 0.88% | measured |
| 1024×900 | section:news | 2.17% | measured |
| 1024×900 | section:partner | 5.50% | measured |
| 1024×900 | section:site-footer.w-100 | 3.62% | measured |
| 1024×900 | footer | 3.62% | measured |
| 390×844 | header | 4.04% | measured |
| 390×844 | hero | 5.69% | measured |
| 390×844 | section:site-header | 4.04% | measured |
| 390×844 | section:slide | 5.69% | measured |
| 390×844 | section:category-list | 12.27% | measured |
| 390×844 | section:banner-category | 6.04% | measured |
| 390×844 | section:block-category | 2.45% | measured |
| 390×844 | section:block-category | 2.28% | measured |
| 390×844 | section:block-category | 2.28% | measured |
| 390×844 | section:block-category | 1.86% | measured |
| 390×844 | section:block-category | 2.05% | measured |
| 390×844 | section:home-form | 3.89% | measured |
| 390×844 | section:accessory | 1.78% | measured |
| 390×844 | section:news | 5.73% | measured |
| 390×844 | section:partner | 10.36% | measured |
| 390×844 | section:site-footer.w-100 | 8.16% | measured |
| 390×844 | footer | 8.16% | measured |

## 10. Mask Audit

| Viewport | Mask ledger | Requested | Unresolved | Masked area | useDefaultWidgetMasks |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | ok | 0 | 0 | 0.00% | false |
| 1024×900 | ok | 0 | 0 | 0.00% | false |
| 390×844 | ok | 0 | 0 | 0.00% | false |

```text
masked-area budget            2%
final compare policy          useDefaultWidgetMasks=false, zero user masks
structural regions masked     NONE — header/nav/hero/grid/article/footer geometry stays unmasked and measurable
```

## 11. Remote Dependency Audit

```text
remote subresources in generated HTML  0
remote navigation links (allowed)      120
local assets                           118
```

| Viewport | Reference-origin visual requests | Remote resource requests | Resource entries | Images loaded |
| --- | --- | --- | --- | --- |
| 1440×900 | 0 | n/a | 110 | 105 |
| 1024×900 | 0 | n/a | 110 | 105 |
| 390×844 | 0 | n/a | 110 | 105 |

Navigation links to the reference origin are allowed; reference-origin visual requests from the clone runtime are not.

## 12. Run #1 vs Run #2

### Historical comparison — Run #1 vs Run #2 (immutable prior evidence)

| Metric | Run #1 | Run #2 | Change |
| --- | --- | --- | --- |
| Blueprints | 13 | 20 | +7 |
| Generated HTML bytes | 411473 | 668320 | +256847 |
| Localized assets | 118 | 118 | 0 |
| docHeight @1440 | not measured | 5418 | n/a |
| docHeight @1024 | not measured | 5541 | n/a |
| docHeight @390 | not measured | 14642 | n/a |
| Compare mismatch @1440 | 100.00% | not produced | n/a |
| Compare verdict @1440 | STRUCTURAL_TRUNCATION_DETECTED | not produced | n/a |
| Reference self-drift | 11.95% | not measured | n/a |
| Remote subresources | 0 | 0 | 0 |
| A0 images / fonts | 102 / 0 | 102 / 0 | n/a |

Run #1 evidence: 14 documents. Run #2 evidence: 4 documents. Prior raw evidence is never rewritten by this generator.

### Recovery comparison — Run #3 (recovery, this report) vs Run #2

| Metric | Run #2 (baseline) | Recovery run | Change |
| --- | --- | --- | --- |
| Blueprints | 20 | 20 | 0 |
| Generated HTML bytes | 668320 | 675441 | +7121 |
| Localized assets | 118 | 118 | 0 |
| docHeight @1440 | 5418 | 5418 | 0 |
| docHeight @1024 | 5541 | 5541 | 0 |
| docHeight @390 | 14642 | 14642 | 0 |
| Authoritative pair | not produced | 3/3 viewports | n/a |
| Compare mismatch | not produced | 100.00% | n/a |
| Remote subresources | 0 | 0 | 0 |

## 13. Remaining Failures

### F1 — COMPARE_STATUS_NOT_RESULT [INCONCLUSIVE BLOCKER] @ 1440×900 — SETTLEMENT_FAILURE

```text
WHAT         Compare at 1440×900 did not produce a comparison result.
WHERE        stages.compare
EXPECTED     a deterministic compare result over an authoritative atomic pair
ACTUAL       status=INCONCLUSIVE
DELTA        no pixel evidence
LIKELY SCOPE compare transport / capture path
EVIDENCE     .canary/run3/evidence/run3-1440.json stages.compare
```

### F2 — CAPTURE_STATE_INCOMPATIBLE [INCONCLUSIVE BLOCKER] @ 1440×900 — TARGET_STALE

```text
WHAT         Reference and candidate capture state were incompatible at 1440×900.
WHERE        captureStateCompatible / captureReceipts
EXPECTED     identical backend, capture mode, CSS viewport, CSS capture size, raster geometry, DPR and zoom
ACTUAL       captureStateCompatible=false
DELTA        pixel comparison not like-for-like
LIKELY SCOPE capture state normalization
EVIDENCE     .canary/run3/evidence/run3-1440.json stages.compare.captureStateCompatible
```

### F3 — COMPARE_STATUS_NOT_RESULT [INCONCLUSIVE BLOCKER] @ 1024×900 — SETTLEMENT_FAILURE

```text
WHAT         Compare at 1024×900 did not produce a comparison result.
WHERE        stages.compare
EXPECTED     a deterministic compare result over an authoritative atomic pair
ACTUAL       status=INCONCLUSIVE
DELTA        no pixel evidence
LIKELY SCOPE compare transport / capture path
EVIDENCE     .canary/run3/evidence/run3-1024.json stages.compare
```

### F4 — CAPTURE_STATE_INCOMPATIBLE [INCONCLUSIVE BLOCKER] @ 1024×900 — TARGET_STALE

```text
WHAT         Reference and candidate capture state were incompatible at 1024×900.
WHERE        captureStateCompatible / captureReceipts
EXPECTED     identical backend, capture mode, CSS viewport, CSS capture size, raster geometry, DPR and zoom
ACTUAL       captureStateCompatible=false
DELTA        pixel comparison not like-for-like
LIKELY SCOPE capture state normalization
EVIDENCE     .canary/run3/evidence/run3-1024.json stages.compare.captureStateCompatible
```

### F5 — COMPARE_STATUS_NOT_RESULT [INCONCLUSIVE BLOCKER] @ 390×844 — SETTLEMENT_FAILURE

```text
WHAT         Compare at 390×844 did not produce a comparison result.
WHERE        stages.compare
EXPECTED     a deterministic compare result over an authoritative atomic pair
ACTUAL       status=INCONCLUSIVE
DELTA        no pixel evidence
LIKELY SCOPE compare transport / capture path
EVIDENCE     .canary/run3/evidence/run3-390.json stages.compare
```

### F6 — CAPTURE_STATE_INCOMPATIBLE [INCONCLUSIVE BLOCKER] @ 390×844 — TARGET_STALE

```text
WHAT         Reference and candidate capture state were incompatible at 390×844.
WHERE        captureStateCompatible / captureReceipts
EXPECTED     identical backend, capture mode, CSS viewport, CSS capture size, raster geometry, DPR and zoom
ACTUAL       captureStateCompatible=false
DELTA        pixel comparison not like-for-like
LIKELY SCOPE capture state normalization
EVIDENCE     .canary/run3/evidence/run3-390.json stages.compare.captureStateCompatible
```

Speculative failures are excluded by construction: every entry above is derived from a typed check in §14 and is backed by the cited persisted evidence.

## 14. Final Fidelity Gate

```text
FINAL VERDICT: INCONCLUSIVE
```

| Viewport | Gate | Deterministic failures | Inconclusive blockers |
| --- | --- | --- | --- |
| 1440×900 | INCONCLUSIVE | none | COMPARE_STATUS_NOT_RESULT, CAPTURE_STATE_INCOMPATIBLE |
| 1024×900 | INCONCLUSIVE | none | COMPARE_STATUS_NOT_RESULT, CAPTURE_STATE_INCOMPATIBLE |
| 390×844 | INCONCLUSIVE | none | COMPARE_STATUS_NOT_RESULT, CAPTURE_STATE_INCOMPATIBLE |

Policy applied, in order:

```text
1. Evidence availability and typed status are evaluated first.
2. Missing authoritative atomic pair, failed settlement, stale identity, quarantine
   without recovery, or an inconclusive/failed compare fixes that viewport to INCONCLUSIVE.
   Placeholder numerics (e.g. mismatchPercentage 100 from a dimensions short-circuit)
   never override that precedence into FAIL.
3. PASS requires every exact viewport to have: complete settlement + coherent target
   identity; valid full-page lineage for the atomic pair (complete PNG, compatible
   geometry); authoritative pixel mismatch <= 2%; no cardinality/grid/navigation/hero/
   section-order/responsive structural failure; acceptable page/section heights and
   major geometry; zero reference-origin visual requests; zero broken rendered assets;
   no unresolved localization failure; no broad or implicit masking with a recorded
   mask ratio; no candidate-worse horizontal overflow.
4. FAIL only on complete deterministic evidence proving mismatch beyond policy.
5. Aggregation: a deterministic FAIL at any required viewport dominates when no hard
   blocker exists for that viewport; otherwise any INCONCLUSIVE viewport makes the gate
   INCONCLUSIVE; otherwise PASS.
6. Soft evidence gaps (reference drift, runtime audit, standalone continuity) block PASS
   but never mask a proven deterministic FAIL; observed deltas under a hard blocker are
   reported as not adjudicated rather than as proven failures.
```

Rationale: 3/3 viewport(s) are undecidable from persisted evidence (1440×900: COMPARE_STATUS_NOT_RESULT+CAPTURE_STATE_INCOMPATIBLE; 1024×900: COMPARE_STATUS_NOT_RESULT+CAPTURE_STATE_INCOMPATIBLE; 390×844: COMPARE_STATUS_NOT_RESULT+CAPTURE_STATE_INCOMPATIBLE).

## 15. What Is Actually Proven

```text
UNIT-TEST PROOF
  NOT EVIDENCED IN THIS RUN — no persisted unit-test receipt under evidence/.

LIVE RUNTIME PROOF
  1440×900: reference settled / clone settled; rendered 105 images, 0 broken, 0 pending
  1024×900: reference settled / clone settled; rendered 105 images, 0 broken, 0 pending
  390×844: reference settled / clone settled; rendered 105 images, 0 broken, 0 pending

VISUAL PROOF
  1440×900: INCONCLUSIVE (unmeasured: Capture state mismatch: CSS capture size mismatch: target 1440x5422 vs baseline 1440x5418 — no pixel measurement produced; placeholder numeric excluded)
  1024×900: INCONCLUSIVE (unmeasured: Capture state mismatch: CSS capture size mismatch: target 1024x5546 vs baseline 1024x5541 — no pixel measurement produced; placeholder numeric excluded)
  390×844: INCONCLUSIVE (unmeasured: Capture state mismatch: CSS capture size mismatch: target 390x14650 vs baseline 390x14642 — no pixel measurement produced; placeholder numeric excluded)

STRUCTURAL PROOF
  1440×900: 14 matched sections, docHeight 5422→5418, cards 25→25, grids 5×1→5×1
  1024×900: 14 matched sections, docHeight 5546→5541, cards 25→25, grids 5×1→5×1
  390×844: 14 matched sections, docHeight 14650→14642, cards 25→25, grids 1×5→1×5

ASSET PROOF
  118 localized assets, every one resolved and sha256-verified during generation; remote subresources in HTML 0
```

`IMPLEMENTATION EXISTS`, `UNIT TESTS PASS`, and `LIVE CHROMIUM TEST PASS` are different claims. Only exercised live evidence can support the last claim; a missing unit-test receipt is reported as not evidenced rather than assumed.

## 16. Next Action

1. Authoritative atomic pairs are persisted, but comparison produced an INCONCLUSIVE verdict due to a 4–8 px full-page CSS capture-height mismatch (target vs baseline). Identify and eliminate the 4–8 px full-page CSS capture-height mismatch, recapture both sides under identical geometry, and rerun pixel comparison.
