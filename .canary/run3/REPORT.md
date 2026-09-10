# AntiFan Real Independent HTML Fidelity Canary — Recovery Report



## 1. Environment

```text
Run directory:  .canary/run3
Evidence dir:   .canary/run3/evidence (11 JSON documents)
Generator:      build-report.mjs (phase-06-report-and-fidelity-gate)
Report anchor:  2026-09-10T07:57:02.527Z
Reference URL:  https://hoplongtech.com/
Clone URL:      http://127.0.0.1:7852/
Runtime:        node v24.13.0 on win32 x64
Clone bundle:   .canary/run3/clone/index.html
Clone input:    .canary/run3/reference/reference.html
```

Persisted evidence inventory (sha256 computed at generation time):

| Document | Role | Bytes | sha256 |
| --- | --- | --- | --- |
| .canary/run3/evidence/asset-audit.json | audit | 2817 | a2e448750490ac64da2bfbd16ecb9f7cb60eebafd414ce50db5812cfa45f4544 |
| .canary/run3/evidence/build-telemetry-mobile.json | telemetry | 59357 | 8eea34903ceaef13e83f44a39b75f207de39782493f4b43ceca47810c417bf9f |
| .canary/run3/evidence/build-telemetry.json | telemetry | 59856 | 9c1830cb450fe29005d03e4c3f14e9176fdf1ee23304732f8492812c1cb24618 |
| .canary/run3/evidence/pipeline.json | other | 40756 | 948e7cc6c2dd611ce5e533a146e75aa696096d16dc9012be8eea740d0219d9fb |
| .canary/run3/evidence/reference-dump-mobile.json | other | 2838 | 6fb7f632e61058cff073c72583ddfeddf70d8e518fb85a0159792104235b7224 |
| .canary/run3/evidence/reference-dump-validated.json | other | 3049 | bbbd943e5c7e30575e19d0f949af6346f923f2c304aabf30a53c2aae626aaa43 |
| .canary/run3/evidence/reference-floors.json | other | 443 | 7256580bf7c95acd1e510b74ac91658f00ba141a2dbbf388ec8ac5a045aad39e |
| .canary/run3/evidence/run3-1024.json | viewport | 170113 | e51b24175cd95f3aee5f7acea62ea793b0e4c55289a5abdb7e4887fb0cc7d102 |
| .canary/run3/evidence/run3-1440.json | viewport | 142593 | 416d715dada24d85c9ad6efcb21fb182abfad8d5d204807f98ef2ab3cd02c783 |
| .canary/run3/evidence/run3-390.json | viewport | 156245 | b3ded85c8469e444142e02ed25be5ba933524dcb0aab7f40022a566a6c957331 |
| .canary/run3/evidence/summary.json | other | 24611 | c521a887e6f3a5037ecc466b777618fb7c83574e8fba1150c215a5af6d23bcee |

Standalone full-page captures recorded in this run are independent continuity evidence. Only the atomic compare pair is an authoritative pixel input; this generator never merges, substitutes, or chooses between the two lineages.

## 2. Pipeline Tested

| Stage | Real implementation | Executed |
| --- | --- | --- |
| A0 Discovery | AssetHarvester via CloneIRBuilder.harvestFromHtml | YES (108 resources) |
| A1 Localization | AssetLocalizer | YES (118 files) |
| A2 Optimization/Preservation | IndependentHtmlCloneGenerator (localize + rewrite + audit) | YES |
| Independent HTML Generation | IndependentHtmlCloneGenerator.generateCloneBundle | YES (673,025 B) |
| Chromium Render | live AntiFan Desktop tabs (real Chromium) | YES (3 viewports) |
| Settlement | runtime settle probe (network/fonts/images/DOM/visual) | YES (3/3 viewports) |
| Standalone Capture | anti.screenshot.full_page (independent continuity evidence) | YES (3/3) |
| Visual Compare | anti.visual.compare (atomic pair) | PAIR PRESENT (3/3) |
| Structural Verification | unmasked live geometry/cardinality probes on both tabs | YES |
| Fidelity Gate | this report (deterministic from persisted evidence) | EVALUATED |

Compare results evaluated: 1/3 viewports; authoritative pairs: 3/3.

## 3. Reference Capture

| Viewport | Reference URL | docHeight | Sections | Cards | Images | Settlement | Capture |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | https://hoplongtech.com/ | 5422 | 15 | 83 | 105 | settled 2887 ms | atomic pair recorded |
| 1024×900 | https://hoplongtech.com/ | 6756 | 15 | 83 | 105 | settled 2879 ms | atomic pair recorded |
| 390×844 | https://hoplongtech.com/ | 4481 | 14 | 83 | 98 | settled 2860 ms | atomic pair recorded |

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
bytes       673,025
sha256      54c4faba7a8334433c87fb030155f6be7050dc693f89ad7e7d17bb99440e517c
assets      118 files / 36,671,943 bytes
blueprints  20
products    6 (normalized) / articles 4
remote navigation links (allowed)  120
```

## 7. Live Chromium Results

| Viewport | Pixel Diff | Height Diff | Structural | Assets | Settlement | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1440×900 | BLOCKED | 0 px (5422 → 5422, ratio 1.000) | 15/15 sections, 83/83 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 2887 ms / clone 2900 ms) | INCONCLUSIVE |
| 1024×900 | BLOCKED | -1210 px (6756 → 5546, ratio 0.821) | 15/15 sections, 83/83 cards, 105/105 imgs | 0 broken / 105 rendered | all gates true (ref 2879 ms / clone 2889 ms) | INCONCLUSIVE |
| 390×844 | 0.99% | +40 px (4481 → 4521, ratio 1.009) | 14/14 sections, 83/83 cards, 98/98 imgs | 0 broken / 98 rendered | all gates true (ref 2860 ms / clone 2871 ms) | INCONCLUSIVE |

`Verdict` is the per-viewport gate outcome defined in §14. A placeholder numeric produced by a dimensions short-circuit is never treated as a pixel measurement.

## 8. Structural Findings

### 1440×900

```text
docHeight        reference 5422 → candidate 5422 (0 px, ratio 1.000)
overflowX        reference 0 → candidate 0
sectionCount     15 → 15
productCardCount 83 → 83
articleCardCount 4 → 4
navItemCount     8 → 8
linkCount        249 → 249 (diagnostic; time-dependent on hydrated targets)
imageCount       105 → 105
brokenImages     0 → 0
```

All 15 matched sections have identical heights.

```text
grid             reference flex 5×1 (5 children)
                 candidate flex 5×1 (5 children)
fonts            body Roboto 14px/400 | h1 Roboto 28px/600 | h2 Roboto 18px/600
```

### 1024×900

```text
docHeight        reference 6756 → candidate 5546 (-1210 px, ratio 0.821)
overflowX        reference 0 → candidate 0
sectionCount     15 → 15
productCardCount 83 → 83
articleCardCount 4 → 4
navItemCount     8 → 8
linkCount        249 → 249 (diagnostic; time-dependent on hydrated targets)
imageCount       105 → 105
brokenImages     0 → 0
```

Non-zero matched section deltas:

| Section | Reference h | Candidate h | Δh |
| --- | --- | --- | --- |
| site-header | 159 | 174 | +15 |
| main | 4620 | 4725 | +105 |
| category-list | 130 | 145 | +15 |
| block-category | 419 | 434 | +15 |
| block-category | 419 | 434 | +15 |
| block-category | 419 | 434 | +15 |
| block-category | 419 | 434 | +15 |
| block-category | 419 | 434 | +15 |
| news | 436 | 451 | +15 |

```text
grid             reference flex 5×1 (5 children)
                 candidate flex 5×1 (5 children)
fonts            body Roboto 14px/400 | h1 Roboto 28px/600 | h2 Roboto 18px/600
```

Capture-state note: this viewport has no verified atomic pair, so the geometry above is observed structural evidence only; it is not attributed to the clone as a pixel-verified defect.

### 390×844

```text
docHeight        reference 4481 → candidate 4521 (+40 px, ratio 1.009)
overflowX        reference 0 → candidate 0
sectionCount     14 → 14
productCardCount 83 → 83
articleCardCount 4 → 4
navItemCount     81 → 81
linkCount        230 → 230 (diagnostic; time-dependent on hydrated targets)
imageCount       98 → 98
brokenImages     0 → 0
```

Non-zero matched section deltas:

| Section | Reference h | Candidate h | Δh |
| --- | --- | --- | --- |
| site-header | 170 | 180 | +10 |

```text
grid             reference block 1×2 (2 children)
                 candidate block 1×2 (2 children)
fonts            body Roboto 14px/400 | h1 Roboto 28px/600 | h2 Roboto 18px/600
```


## 9. Visual Findings

Authoritative pixel inputs (atomic compare pairs only):

| Viewport | Mismatch | Diff px | Total px | dimensionsMatch | Compare verdict |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | n/a | n/a | n/a | n/a | COMPARE_ERROR |
| 1024×900 | 27.54% | 1564307 | 5679104 | false | STRUCTURAL_PARITY_MISMATCH |
| 390×844 | 0.99% | 17343 | 1747590 | true | FAIL |

```text
authoritative pixel inputs : 3/3 viewports (atomic compare pair)
independent continuity     : 3/3 viewports (standalone full-page captures, never authoritative)
placeholder numerics       : 0 viewport(s) — excluded from pixel verdicts
```

Reference self-drift diagnostic (never subtracted from candidate mismatch, never used to relax the 2% target):

| Viewport | Self-drift | dimensionsMatch | mask ratio | capture state | identity |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | n/a | n/a | 0.00% | n/a | n/a |
| 1024×900 | 100.00% | n/a | 0.00% | n/a | n/a |
| 390×844 | 100.00% | n/a | 0.00% | n/a | n/a |

Sectional clip diagnostics (non-authoritative, never substituted for the global result):

| Viewport | Region | Mismatch | Status |
| --- | --- | --- | --- |
| 1024×900 | header | 100.00% | measured |
| 1024×900 | hero | n/a | COMPARE_ERROR |
| 1024×900 | section:site-header | n/a | COMPARE_ERROR |
| 1024×900 | section:main | n/a | COMPARE_ERROR |
| 1024×900 | section:category-list | n/a | COMPARE_ERROR |
| 1024×900 | section:block-category | n/a | COMPARE_ERROR |
| 1024×900 | section:block-category | n/a | COMPARE_ERROR |
| 1024×900 | section:block-category | n/a | COMPARE_ERROR |
| 1024×900 | section:block-category | n/a | COMPARE_ERROR |
| 1024×900 | section:block-category | n/a | COMPARE_ERROR |
| 1024×900 | section:news | n/a | COMPARE_ERROR |
| 1024×900 | footer | n/a | COMPARE_ERROR |
| 390×844 | header | n/a | COMPARE_ERROR |
| 390×844 | hero | n/a | COMPARE_ERROR |
| 390×844 | section:site-header | n/a | COMPARE_ERROR |
| 390×844 | footer | n/a | COMPARE_ERROR |

## 10. Mask Audit

| Viewport | Mask ledger | Requested | Unresolved | Masked area | useDefaultWidgetMasks |
| --- | --- | --- | --- | --- | --- |
| 1440×900 | NOT RECORDED | 0 | 0 | n/a | false |
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
| 1440×900 | 0 | n/a | 107 | 98 |
| 1024×900 | 0 | n/a | 107 | 98 |
| 390×844 | 0 | n/a | 107 | 98 |

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
| Generated HTML bytes | 668320 | 673025 | +4705 |
| Localized assets | 118 | 118 | 0 |
| docHeight @1440 | 5418 | 5422 | +4 |
| docHeight @1024 | 5541 | 5546 | +5 |
| docHeight @390 | 14642 | 4521 | -10121 |
| Authoritative pair | not produced | 3/3 viewports | n/a |
| Compare mismatch | not produced | not produced | n/a |
| Remote subresources | 0 | 0 | 0 |

## 13. Remaining Failures

### F1 — COMPARE_STATUS_NOT_RESULT [INCONCLUSIVE BLOCKER] @ 1440×900 — SETTLEMENT_FAILURE

```text
WHAT         Compare at 1440×900 did not produce a comparison result.
WHERE        stages.compare
EXPECTED     a deterministic compare result over an authoritative atomic pair
ACTUAL       status=COMPARE_ERROR; error=TARGET_BUSY_DRAINING: Target '96f38b84-fea9-4a27-9e49-7b4697399e3c' is quarantined: Page.captureScreenshot did not settle within its bound on full-page tab '96f38b84-fea9-4a27-9e49-7b4697399e3c'; recovery in progress. Retry after the recovery receipt.
DELTA        no pixel evidence
LIKELY SCOPE compare transport / capture path
EVIDENCE     .canary/run3/evidence/run3-1440.json stages.compare
```

### F2 — PAIR_ARTIFACTS_UNVERIFIED [INCONCLUSIVE BLOCKER] @ 1440×900 — SETTLEMENT_FAILURE

```text
WHAT         Authoritative pair artifacts are not hash-verified at 1440×900.
WHERE        atomic pair reference/candidate artifacts
EXPECTED     both pair PNGs resolved with matching sha256 and byte length
ACTUAL       reference=missing/unverified; candidate=missing/unverified
DELTA        authoritative pixel lineage incomplete
LIKELY SCOPE artifact staging/fetch
EVIDENCE     .canary/run3/evidence/run3-1440.json atomic pair
```

### F3 — PAIR_REFERENCE_RECEIPT_MISSING [INCONCLUSIVE BLOCKER] @ 1440×900 — SETTLEMENT_FAILURE

```text
WHAT         No capture receipt is attached to the reference pair artifact at 1440×900.
WHERE        atomic pair reference receipt
EXPECTED     backend, captureMode, cssViewport, cssCaptureSize, rasterSize, dpr, zoom, timestamp
ACTUAL       receipt absent
DELTA        capture lineage unproven
LIKELY SCOPE capture envelope/receipt plumbing
EVIDENCE     .canary/run3/evidence/run3-1440.json atomic pair
```

### F4 — PAIR_CANDIDATE_RECEIPT_MISSING [INCONCLUSIVE BLOCKER] @ 1440×900 — SETTLEMENT_FAILURE

```text
WHAT         No capture receipt is attached to the candidate pair artifact at 1440×900.
WHERE        atomic pair candidate receipt
EXPECTED     backend, captureMode, cssViewport, cssCaptureSize, rasterSize, dpr, zoom, timestamp
ACTUAL       receipt absent
DELTA        capture lineage unproven
LIKELY SCOPE capture envelope/receipt plumbing
EVIDENCE     .canary/run3/evidence/run3-1440.json atomic pair
```

### F5 — TARGET_IDENTITY_UNRECORDED [INCONCLUSIVE BLOCKER] @ 1440×900 — TARGET_STALE

```text
WHAT         Target identity receipts are missing for the 1440×900 compare.
WHERE        compare coherence receipts
EXPECTED     pre-inject / post-inject / after-capture identity receipts for both sides
ACTUAL       no coherence block persisted with the pair
DELTA        target stability unproven
LIKELY SCOPE compare transaction receipts
EVIDENCE     .canary/run3/evidence/run3-1440.json stages.compare
```

### F6 — MASK_LEDGER_MISSING [INCONCLUSIVE BLOCKER] @ 1440×900 — OTHER

```text
WHAT         No mask ledger was persisted for 1440×900.
WHERE        maskResolution / maskLedger
EXPECTED     requested/resolved/unresolved selectors with a masked-area ratio
ACTUAL       no mask ledger in evidence
DELTA        mask state unresolved
LIKELY SCOPE compare mask reporting
EVIDENCE     .canary/run3/evidence/run3-1440.json stages.compare
```

### F7 — COMPARE_STATUS_NOT_RESULT [INCONCLUSIVE BLOCKER] @ 1024×900 — SETTLEMENT_FAILURE

```text
WHAT         Compare at 1024×900 did not produce a comparison result.
WHERE        stages.compare
EXPECTED     a deterministic compare result over an authoritative atomic pair
ACTUAL       status=STRUCTURAL_PARITY_MISMATCH
DELTA        no pixel evidence
LIKELY SCOPE compare transport / capture path
EVIDENCE     .canary/run3/evidence/run3-1024.json stages.compare
```

### F8 — EXCESSIVE_REFERENCE_DRIFT [INCONCLUSIVE BLOCKER] @ 1024×900 — TARGET_STALE

```text
WHAT         Reference self-drift at 1024×900 exceeds the determinism limit.
WHERE        drift mismatchPercentage
EXPECTED     <= 2% self-drift (never subtracted from candidate mismatch)
ACTUAL       100.00%
DELTA        98.00% over limit
LIKELY SCOPE reference target instability (diagnostic, not a clone defect)
EVIDENCE     .canary/run3/evidence/run3-1024.json
```

### F9 — EXCESSIVE_REFERENCE_DRIFT [INCONCLUSIVE BLOCKER] @ 390×844 — TARGET_STALE

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
| 1440×900 | INCONCLUSIVE | none (not adjudicated: RESPONSIVE_CLIENT_WIDTH) | COMPARE_STATUS_NOT_RESULT, PAIR_ARTIFACTS_UNVERIFIED, PAIR_REFERENCE_RECEIPT_MISSING, PAIR_CANDIDATE_RECEIPT_MISSING, TARGET_IDENTITY_UNRECORDED, MASK_LEDGER_MISSING |
| 1024×900 | INCONCLUSIVE | none (not adjudicated: PAGE_HEIGHT_DRIFT, SECTION_HEIGHT_DRIFT, MAJOR_GEOMETRY_DRIFT, RESPONSIVE_CLIENT_WIDTH) | COMPARE_STATUS_NOT_RESULT, EXCESSIVE_REFERENCE_DRIFT |
| 390×844 | INCONCLUSIVE | none (not adjudicated: SECTION_HEIGHT_DRIFT, MAJOR_GEOMETRY_DRIFT) | EXCESSIVE_REFERENCE_DRIFT |

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

Rationale: 3/3 viewport(s) are undecidable from persisted evidence (1440×900: COMPARE_STATUS_NOT_RESULT+PAIR_ARTIFACTS_UNVERIFIED+PAIR_REFERENCE_RECEIPT_MISSING+PAIR_CANDIDATE_RECEIPT_MISSING+TARGET_IDENTITY_UNRECORDED+MASK_LEDGER_MISSING; 1024×900: COMPARE_STATUS_NOT_RESULT+EXCESSIVE_REFERENCE_DRIFT; 390×844: EXCESSIVE_REFERENCE_DRIFT).

## 15. What Is Actually Proven

```text
UNIT-TEST PROOF
  NOT EVIDENCED IN THIS RUN — no persisted unit-test receipt under evidence/.

LIVE RUNTIME PROOF
  1440×900: reference settled / clone settled; rendered 105 images, 0 broken, 0 pending
  1024×900: reference settled / clone settled; rendered 105 images, 0 broken, 0 pending
  390×844: reference settled / clone settled; rendered 98 images, 0 broken, 0 pending

VISUAL PROOF
  1440×900: n/a mismatch over the authoritative atomic pair
  1024×900: INCONCLUSIVE (unmeasured: Structural parity mismatch (cardinalityMatch=true, deltaCardinality=0, geometryWithinTolerance=false, deltaGeometry=176px) — structural mismatch cannot pass through masks or a low pixel diff — no pixel measurement produced; placeholder numeric excluded)
  390×844: 0.99% mismatch over the authoritative atomic pair

STRUCTURAL PROOF
  1440×900: 15 matched sections, docHeight 5422→5422, cards 83→83, grids 5×1→5×1
  1024×900: 15 matched sections, docHeight 6756→5546, cards 83→83, grids 5×1→5×1
  390×844: 14 matched sections, docHeight 4481→4521, cards 83→83, grids 1×2→1×2

ASSET PROOF
  118 localized assets, every one resolved and sha256-verified during generation; remote subresources in HTML 0
```

`IMPLEMENTATION EXISTS`, `UNIT TESTS PASS`, and `LIVE CHROMIUM TEST PASS` are different claims. Only exercised live evidence can support the last claim; a missing unit-test receipt is reported as not evidenced rather than assumed.

## 16. Next Action

1. For 1440×900 (run3-1440): authoritative atomic pair was captured but comparison produced an INCONCLUSIVE verdict (0 px height delta). Identify and eliminate full-page capture-height / layout delta, recapture both sides under identical geometry, and rerun pixel comparison.
2. For 1024×900 (run3-1024): authoritative atomic pair was captured with capture-height delta (reference capture: 1024×5426 vs clone: 1024×5546 (1210 px height delta)). Identify and eliminate full-page capture-height / layout delta, recapture both sides under identical geometry, and rerun pixel comparison.
3. Recover and re-verify the bound target (typed drain/reset receipt) and re-capture under identical CSS viewport, DPR, zoom and capture mode before re-running the compare.
4. Observed deltas (RESPONSIVE_CLIENT_WIDTH, PAGE_HEIGHT_DRIFT, SECTION_HEIGHT_DRIFT, MAJOR_GEOMETRY_DRIFT) are not adjudicated because the viewport evidence is incomplete; re-measure them under complete evidence before treating any as a clone defect.
5. Re-run the final compare with `useDefaultWidgetMasks: false` and zero user masks, and persist the full mask ledger with its ratio.
