# AntiFan Real Independent HTML Fidelity Canary — Recovery Report



## 1. Environment

```text
Run directory:  .canary/run3
Evidence dir:   .canary/run3/evidence (9 JSON documents)
Generator:      build-report.mjs (phase-06-report-and-fidelity-gate)
Report anchor:  2026-09-10T03:45:18.243Z
Reference URL:  https://hoplongtech.com/
Clone URL:      http://127.0.0.1:7852/
Runtime:        node v24.13.0 on win32 x64
Clone bundle:   .canary/run3/clone/index.html
Clone input:    .canary/run3/reference/reference.html
```

Persisted evidence inventory (sha256 computed at generation time):

| Document | Role | Bytes | sha256 |
| --- | --- | --- | --- |
| .canary/run3/evidence/asset-audit.json | audit | 2813 | 9ab04c743d8701a7416f91c69cd528a0462fc09ef60090036ee734ffca8d7b66 |
| .canary/run3/evidence/build-telemetry.json | telemetry | 59856 | 4686c0b9b1d2a63d215df8372de696b3c68199b60aad28c892a5bb4ff6a40f24 |
| .canary/run3/evidence/pipeline.json | other | 37401 | 86b297eef1f3b1cf0add23d6eb439a79464672e816423058e3ca3607c8f2a312 |
| .canary/run3/evidence/reference-dump.json | other | 6034 | ff6dbe33553c3bd29bab1bb1ffa676185844ea56e716c2fd9ecb665e145f1a23 |
| .canary/run3/evidence/reference-prepare.json | other | 1377 | fa4e7b264f3e66b2b6792d015a6f7c596698f898054e0193470e370a75b7f713 |
| .canary/run3/evidence/run3-1024.json | viewport | 152124 | f2c804fe5120c83a14d52a79827f0d6c536e1cfb3460678067aab0ee5a38b43c |
| .canary/run3/evidence/run3-1440.json | viewport | 152182 | d4bf07d48d310cded4f52e19d4b5c215f2613021e999566644847d4fe86a00b2 |
| .canary/run3/evidence/run3-390.json | viewport | 145133 | 65350fd7461d129cb5f434e56178b147076c3f50bc41728260235b0818938091 |
| .canary/run3/evidence/summary.json | other | 24404 | d6ee56e514073b5650b664941671c4d794339d6c8cd82d53518f0ee4135b90a1 |

Standalone full-page captures recorded in this run are independent continuity evidence. Only the atomic compare pair is an authoritative pixel input; this generator never merges, substitutes, or chooses between the two lineages.

## 2. Pipeline Tested

| Stage | Real implementation | Executed |
| --- | --- | --- |
| A0 Discovery | AssetHarvester via CloneIRBuilder.harvestFromHtml | YES (108 resources) |
| A1 Localization | AssetLocalizer | YES (118 files) |
| A2 Optimization/Preservation | IndependentHtmlCloneGenerator (localize + rewrite + audit) | YES |
| Independent HTML Generation | IndependentHtmlCloneGenerator.generateCloneBundle | YES (673,593 B) |
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
| 1440×900 | https://hoplongtech.com/ | 5422 | 12 | 25 | 105 | settled 4172 ms | atomic pair recorded |
| 1024×900 | https://hoplongtech.com/ | 5546 | 12 | 25 | 105 | settled 3734 ms | atomic pair recorded |
| 390×844 | https://hoplongtech.com/ | 4481 | 11 | 25 | 98 | settled 5248 ms | atomic pair recorded |

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
bytes       673,593
sha256      789eec310d8c42e450717567671cdd472821dd0570a28c9b031eb1a6e550d43a
assets      118 files / 36,671,943 bytes
blueprints  20
products    6 (normalized) / articles 4
remote navigation links (allowed)  120
```

## 7. Live Chromium Results

| Viewport | Pixel Diff | Height Diff | Structural | Assets | Settlement | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | BLOCKED | -4 px (5422 → 5418, ratio 0.999) | 12/12 sections, 25/25 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 4172 ms / clone 4084 ms) | INCONCLUSIVE |
| 1024×900 | BLOCKED | -5 px (5546 → 5541, ratio 0.999) | 12/12 sections, 25/25 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 3734 ms / clone 4059 ms) | INCONCLUSIVE |
| 390×844 | BLOCKED | +10008 px (4481 → 14489, ratio 3.233) | 11/12 sections, 25/25 cards, 98/105 imgs | 0 broken / 105 rendered | all gates true (ref 5248 ms / clone 3677 ms) | INCONCLUSIVE |

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
docHeight        reference 4481 → candidate 14489 (+10008 px, ratio 3.233)
overflowX        reference 0 → candidate 270
sectionCount     11 → 12
productCardCount 25 → 25
articleCardCount 4 → 4
navItemCount     81 → 8
linkCount        230 → 249 (diagnostic; time-dependent on hydrated targets)
imageCount       98 → 105
brokenImages     0 → 0
```

Non-zero matched section deltas:

| Section | Reference h | Candidate h | Δh |
| --- | --- | --- | --- |
| site-header | 170 | 348 | +178 |
| slide | 323 | 445 | +122 |
| category-list | 65 | 45 | -21 |
| banner-category | 156 | 196 | +40 |
| block-category | 341 | 1927 | +1586 |
| block-category | 341 | 1927 | +1586 |
| block-category | 341 | 1927 | +1586 |
| block-category | 341 | 1927 | +1586 |
| block-category | 341 | 1927 | +1586 |
| accessory | 315 | 986 | +671 |
| news | 618 | 441 | -177 |
| partner | 128 | 218 | +90 |
| site-footer | 741 | 1054 | +313 |

```text
grid             reference block 1×2 (2 children)
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
| 390×844 | 100.00% | n/a | 0.00% | n/a | n/a |

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
| 1440×900 | section:partner | 6.76% | measured |
| 1440×900 | section:site-footer.w-100 | 2.86% | measured |
| 1440×900 | footer | 2.86% | measured |
| 1024×900 | header | 0.66% | measured |
| 1024×900 | hero | 0.27% | measured |
| 1024×900 | section:site-header | 0.66% | measured |
| 1024×900 | section:slide | 0.27% | measured |
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
| 390×844 | header | 100.00% | measured |
| 390×844 | hero | 100.00% | measured |
| 390×844 | section:site-header | 100.00% | measured |
| 390×844 | section:slide | 100.00% | measured |
| 390×844 | section:category-list | 100.00% | measured |
| 390×844 | section:banner-category | 100.00% | measured |
| 390×844 | section:block-category | 100.00% | measured |
| 390×844 | section:block-category | 100.00% | measured |
| 390×844 | section:block-category | 100.00% | measured |
| 390×844 | section:block-category | 100.00% | measured |
| 390×844 | section:block-category | 100.00% | measured |
| 390×844 | section:accessory | 100.00% | measured |
| 390×844 | section:news | 100.00% | measured |
| 390×844 | section:partner | 100.00% | measured |
| 390×844 | section:site-footer | 100.00% | measured |
| 390×844 | footer | 100.00% | measured |

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
| Generated HTML bytes | 668320 | 673593 | +5273 |
| Localized assets | 118 | 118 | 0 |
| docHeight @1440 | 5418 | 5418 | 0 |
| docHeight @1024 | 5541 | 5541 | 0 |
| docHeight @390 | 14642 | 14489 | -153 |
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

### F7 — EXCESSIVE_REFERENCE_DRIFT [INCONCLUSIVE BLOCKER] @ 390×844 — TARGET_STALE

```text
WHAT         Reference self-drift at 390×844 exceeds the determinism limit.
WHERE        drift mismatchPercentage
EXPECTED     <= 2% self-drift (never subtracted from candidate mismatch)
ACTUAL       100.00%
DELTA        98.00% over limit
LIKELY SCOPE reference target instability (diagnostic, not a clone defect)
EVIDENCE     .canary/run3/evidence/run3-390.json
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
| 390×844 | INCONCLUSIVE | none (not adjudicated: PAGE_HEIGHT_DRIFT, SECTION_HEIGHT_DRIFT, CARDINALITY_sectionCount, CARDINALITY_imageCount, NAV_ITEM_MISMATCH, SECTION_ORDER_MISMATCH, MAJOR_GEOMETRY_DRIFT, HERO_MISMATCH, GRID_MISMATCH, TYPOGRAPHY_MISMATCH, OVERFLOW_REGRESSION) | COMPARE_STATUS_NOT_RESULT, CAPTURE_STATE_INCOMPATIBLE, EXCESSIVE_REFERENCE_DRIFT |

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

Rationale: 3/3 viewport(s) are undecidable from persisted evidence (1440×900: COMPARE_STATUS_NOT_RESULT+CAPTURE_STATE_INCOMPATIBLE; 1024×900: COMPARE_STATUS_NOT_RESULT+CAPTURE_STATE_INCOMPATIBLE; 390×844: COMPARE_STATUS_NOT_RESULT+CAPTURE_STATE_INCOMPATIBLE+EXCESSIVE_REFERENCE_DRIFT).

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
  390×844: INCONCLUSIVE (unmeasured: Capture state mismatch: CSS viewport dimension mismatch: target 390x844 vs baseline 660x1429 — no pixel measurement produced; placeholder numeric excluded)

STRUCTURAL PROOF
  1440×900: 14 matched sections, docHeight 5422→5418, cards 25→25, grids 5×1→5×1
  1024×900: 14 matched sections, docHeight 5546→5541, cards 25→25, grids 5×1→5×1
  390×844: 13 matched sections, docHeight 4481→14489, cards 25→25, grids 1×2→1×5

ASSET PROOF
  118 localized assets, every one resolved and sha256-verified during generation; remote subresources in HTML 0
```

`IMPLEMENTATION EXISTS`, `UNIT TESTS PASS`, and `LIVE CHROMIUM TEST PASS` are different claims. Only exercised live evidence can support the last claim; a missing unit-test receipt is reported as not evidenced rather than assumed.

## 16. Next Action

1. For 1440×900 (run3-1440): authoritative atomic pair was captured with capture-height delta (reference capture: 1440×5422 vs clone: 1440×5418 (4 px height delta)). Identify and eliminate full-page capture-height / layout delta, recapture both sides under identical geometry, and rerun pixel comparison.
2. For 1024×900 (run3-1024): authoritative atomic pair was captured with capture-height delta (reference capture: 1024×5546 vs clone: 1024×5541 (5 px height delta)). Identify and eliminate full-page capture-height / layout delta, recapture both sides under identical geometry, and rerun pixel comparison.
3. For 390×844 (run3-390): authoritative atomic pair was captured with incompatible viewport geometry (reference CSS viewport: 390×844 vs clone: 660×1429, capture size: 390×4481 vs 660×14489 (10008 px height delta)). Resolve viewport / device emulation geometry, eliminate the 270 px horizontal root overflow on the clone, recapture both sides under identical CSS viewport and capture mode, and rerun pixel comparison.
4. Recover and re-verify the bound target (typed drain/reset receipt) and re-capture under identical CSS viewport, DPR, zoom and capture mode before re-running the compare.
5. Observed deltas (PAGE_HEIGHT_DRIFT, SECTION_HEIGHT_DRIFT, CARDINALITY_sectionCount, CARDINALITY_imageCount, NAV_ITEM_MISMATCH, SECTION_ORDER_MISMATCH, MAJOR_GEOMETRY_DRIFT, HERO_MISMATCH, GRID_MISMATCH, TYPOGRAPHY_MISMATCH, OVERFLOW_REGRESSION) are not adjudicated because the viewport evidence is incomplete; re-measure them under complete evidence before treating any as a clone defect.
