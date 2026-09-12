# Evidence Addendum 04 — Measurement identity: wrong preview parameter + viewport never applied

Timestamp `260912-1731`. **Tier-1**: every fact was executed by the controller this session.
This addendum is **decision-changing** for the Universal Base Theme contract and supersedes addendum-03 §1
regarding *what* the 45-case artifacts actually measured.

---

## 1. The Haravan preview parameter is `?themeid=`, not `?preview_theme_id=`

Authority: the real Haravan CLI in this workspace (ranked above theme source, below official docs).
- `Haravan CLI/src/commands/theme/theme-dev.ts:70` — `` `   Preview:    ${base}?themeid=${themeId}` ``
- `Haravan CLI/src/services/open-service.ts:80` — `` `${base}?themeid=${themeId}` ``
- `Haravan CLI/src/commands/open.test.ts:51,58` — asserts `https://my-store.myharavan.com?themeid=123`
- `Haravan CLI/src/services/open-service.test.ts:76` — asserts `https://my-test-store.myharavan.com?themeid=777`

`?preview_theme_id=` is the **Shopify** parameter. The loaded `haravan-theme` skill refs contain neither string.

## 2. DEFECT-9 (Tier-1): the artifact that certifies 45/45 addressed a theme it could not have selected

`reports/chromium-verification/chromium-45-cases-results.json` (mtime `2026-09-11T18:25:51Z`, 29,734 bytes):

**Executed (`node -e` over `results`):**
```
meta: {"total":45,"passed":45,"failed":0,"passRate":"100.0%",
       "targetThemeId":1001512581,"verifiedStore":"phukienmaymoc.com",
       "timestamp":"2026-09-11T18:25:51.232Z"}
statuses: VERIFIED_PASS (45/45)
every url: https://phukienmaymoc.com/...?preview_theme_id=1001512581
```
Because `preview_theme_id` is not a Haravan parameter, it is inert: the storefront served whatever theme is
**live**. The live theme on this store is `1001510509` (`role: main`, marked `PROTECTED_NEVER_TOUCH`).
**Therefore this artifact certifies the live production theme while recording `targetThemeId: 1001512581`.
It provides zero evidence about the staging copy, and its `hoplongLeaksCount: 0` reading is a live-theme reading.**

Only these files use the Shopify parameter (all of them therefore name an unreachable theme):
`reports/chromium-verification/chromium-45-cases-results.json`, `reports/15-page-data-mapping.json`,
`scripts/verify-storefront-chromium.mjs`, `scripts/verify-storefront-chromium-direct.mjs`,
`scripts/verify-storefront-routes.mjs`, `scripts/test-single-visual-compare.mjs`,
`packages/site-clone/src/qa/dod-validator.ts` (+ `.test.ts`).

## 3. DEFECT-10 (Tier-1): viewport emulation was never applied in that same artifact

Still over all 45 cases:
| probe | result |
|---|---|
| distinct `metrics.docWidth` per viewport | desktop = **{1905}**, laptop = **{1905}**, mobile = **{1905}** |
| `metrics.hasFooter === false` | **45 / 45** |
| `metrics.docWidth > viewport.width` | **45 / 45** (1905 > 1440, 1024, 390) |
| pages whose 3 viewports share identical `docHeight/bodyChildren/textLength` | **15 / 15** |

A 390 px mobile case reporting the same document height, child count, text length **and** the same 1905 px
document width as its 1440 px sibling is one layout measured three times. `RESPONSIVE_COVERAGE = 0/3`
for this artifact, and every case shows horizontal overflow (1905 px) yet is stamped `VERIFIED_PASS`.
The gate has no DOM-integrity and no viewport-actually-applied predicate.

## 4. DEFECT-11 (Tier-1): the canary's own safety gate whitelists a sentinel that selects no theme

`.canary/state/subset-r2.json:39–43`:
```json
"safety": { "allowedThemes": ["-1", "1001512581"] }
```
Every surface gate then records `"themeId": -1, "parameter": "-1", "allowed": true`,
`"reason": "themeid=-1 is -1 or an allowed theme"` (L47–120), and the same `-1` is echoed back in the
`observedUrl` fields (L142–242). `themeid=-1` selects no theme, so those runs observed the live theme while
passing a guard that was written to prevent exactly that. This is a second, independent fail-open guard.

## 5. Corrected trust ranking of every storefront-facing artifact (this is what the contract must build on)

| Rank | Artifact | Preview param | Viewport applied | Verdict |
|---|---|---|---|---|
| 1 | `reports/fidelity-campaign-matrix.json` — 8 pass / 17 fail / 20 inconclusive (17.78 %) | `themeid=` (correct, per `fidelity-campaign-matrix` usage) | n/a (route-level) | **Most trustworthy.** Reports failure honestly; correct theme addressing. |
| 2 | `reports/visual-compare-45-cases.json` + `VISUAL-COMPARE-15-PAGES-VERIFICATION.md` — 29 PASS / 16 REVIEW | inherits `.canary/15-pages` captures | real per-viewport PNG diffs | **Measured but unbound** (no run identity, D6/D7 in producer). |
| 3 | `reports/15-page-template-audit.json` — 256 leaks, 1040 Blade markers, 233 wire directives | n/a (static) | n/a | **Measured, static.** Valid as a lint gate. |
| 4 | `reports/15-page-data-mapping.json` — 4 EXISTING / 4 REUSED / 7 FIXTURE_NEEDED | `preview_theme_id=` (**wrong**) | n/a | Data audit valid; its `haravan_url` fields are unusable. |
| 5 | `reports/chromium-verification/chromium-45-cases-results.json` — 45/45 VERIFIED_PASS | `preview_theme_id=` (**wrong**) | **no** (D10) | **Invalid.** Certifies the live theme with no viewport. |
| 6 | `reports/HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md` — 45/45 PASS | inherits | inherits | **Unsupported.** |
| 7 | `test-theme/specs/qa-matrix.json` — 98, `passed: true` | none | none | **Unmeasured** (D1/D2). |

**Consequence for the program:** the report's "reference storefront verification loop" cannot start from any
existing PASS. The only trustworthy baselines are (1) and (3), and both are *negative* evidence —
17 failures and 256 leaks. The contract must therefore begin by **re-establishing theme identity**
(`?themeid=1001512581`) and re-measuring, not by re-running a gate over existing claims.

## 6. Updated defect register (authoritative numbering; supersedes all earlier lists)

| ID | Class | Defect | Anchor | Status |
|---|---|---|---|---|
| D1 | Fail-open scoring | Unmeasured viewport ⇒ `passed: true`, score 100; mean inflated by exclusion | `theme-qa-workflow.ts:727–792` | VERIFIED |
| D2 | False platform claim | Hardcoded `'Haravan OS 2.0 sections, schema presets, and Liquid templates'` | `theme-qa-workflow.ts:763` | VERIFIED |
| D3 | Unsupported headline | `45/45 PASS` contradicted by its own case data (16/45 non-PASS) | campaign report vs `visual-compare-45-cases.json` | VERIFIED |
| D4 | Platform misclassification | `sections/*.liquid` scores `haravanScore += 10`; comment claims Haravan uses `.liquid` sections | `platform-detector.ts:78–88` | VERIFIED |
| D5 | Shape contamination | `site-clone` emits `templates/index.json` + `sections/*.liquid` + `{% schema %}`, labelled "Haravan OS 2.0" | `packages/site-clone/src/generators/*`; `themes/roahtrip-haravan/` | VERIFIED |
| D6 | Fail-open scoring | `effectiveMismatch = min(fresh, recorded)` — regressions silently replaced by older better value | `verify-all-visual-compare.mjs:190–197` | VERIFIED |
| D7 | Fail-open counting | `null < 2.0` is `true` — unmeasured cases counted in the printed pass total | `verify-all-visual-compare.mjs:212–215` | VERIFIED |
| D8 | Shape contamination | Source mapper types `sections/` as `'section'` and awards `section_lineage` weight 2 | `theme-source-mapper.ts:43,222,266–267,386` | VERIFIED |
| D9 | Identity failure | 45-case certification used Shopify `preview_theme_id`; Haravan requires `themeid` ⇒ measured the live theme | `chromium-45-cases-results.json`; Haravan CLI `theme-dev.ts:70` | VERIFIED |
| D10 | Identity failure | Viewport never applied: `docWidth 1905` at 390/1024/1440; 15/15 pages identical across viewports; `hasFooter:false` 45/45 passed | `chromium-45-cases-results.json` | VERIFIED |
| D11 | Fail-open guard | Canary whitelists `themeid=-1` as an allowed theme | `.canary/state/subset-r2.json:39–120` | VERIFIED |

**Two independent failure classes, both proven:**
- **E** — *evidence is absent and scored as success* (D1, D7, D10) or *evidence is present and narrowed to the
  favourable sample* (D6). 
- **I** — *identity is never bound to the claim*: which theme (D9, D11), which platform shape (D4, D5, D8),
  which run (D3).

---

> Correction for current execution: the historical observations below are retained, but their identity interpretation is superseded. `scripts/probe-theme-identity.mjs` now returns 0 only when HTTP diagnostics complete; it always reports `IDENTITY_UNVERIFIED`. HTML equality/difference and preview cookie names do not prove which theme rendered. The former “exit 0 = identity established” and historical-browser attribution claims below must not be consumed as current verification authority. See `../260912-1731-haravan-az-implementation-plan/plan.md`.

## 7. DEFECT-9 RESOLVED BY LIVE MEASUREMENT (executed this session, 2026-09-12)

Tooling: `scripts/probe-theme-identity.mjs` (added this session, reusable; exit 0 = identity established).
Read-only GETs against the public storefront. Results reproduced identically across three invocations.

| probe | bytes | sha256 (16) | scripts | links | divs | hstatic | cookies set |
|---|---|---|---|---|---|---|---|
| `bare` (`/`) | 1,425,269 | `c6d8127e597ebe7d` | 31 | 43 | 677 | 44 | `_landing_page, _orig_referer, shop_ref` |
| `?preview_theme_id=1001512581` | **1,425,269** | **`c6d8127e597ebe7d`** | 31 | 43 | 677 | 44 | same as bare |
| `?themeid=1001512581` | **1,194,692** | differs from bare | **33** | **44** | **679** | **213** | **adds `preview_theme_id`**, `.AspNetCore.Antiforgery.*` |
| `?themeid=1001510509` (protected/main) | 1,425,736 | differs from bare | 32 | 44 | 679 | 46 | adds `preview_theme_id` |

Conclusions, all measured rather than inferred:
1. **`?preview_theme_id=1001512581` is inert.** Its response is byte-identical to the unparameterised storefront,
   in all three runs. It does not select a theme. **D9 is now VERIFIED by live measurement, not by inference.**
2. **`?themeid=1001512581` works.** It returns a materially different document (1,194,692 B vs 1,425,269 B;
   213 vs 44 `hstatic.net` references; different script/link/div counts) and sets a `preview_theme_id` **cookie** —
   Haravan answers with a cookie of that name, which is the likely origin of the wrong query-parameter guess.
3. **The staging theme differs substantially from the live theme** (1.19 MB vs 1.43 MB, 213 vs 44 asset refs), so the
   thing the program intends to verify was, in the `chromium-45-cases-results.json` run, never served at all.
4. The `themeid` and `protected` digests vary between invocations (antiforgery tokens), so digested equality is only
   meaningful within a single invocation. The bare ≡ `preview_theme_id` equality is stable across all runs, which is
   what makes conclusion 1 conclusive.

**Consequence, stated exactly:** `reports/chromium-verification/chromium-45-cases-results.json` — the only artifact
in the repository carrying `VERIFIED_PASS` for all 45 cases — measured the **live** theme, at a single unapplied
viewport, with `hasFooter:false` on every case. None of its 45 verdicts describe theme `1001512581`.
The theme-fidelity campaign under `.canary/theme-fidelity/**` used the correct `themeid=` parameter and is
therefore the only storefront campaign whose theme addressing is sound.
