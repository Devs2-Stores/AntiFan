# Evidence Addendum 02 — Tier-1 controller-verified defect chain (read before scoring)

Timestamp `260912-1731`. **Tier-1**: every line below was executed by the controller this session.
Candidates may not contradict these without citing a file:line they read themselves.
This addendum is a superset of addendum-01 and supersedes it where they overlap.

---

## 1. DEFECT-3 (NEW, Tier-1): the repo's own case-level visual evidence contradicts its headline PASS claim

### 1.1 Direct measurement of `AntiFan/reports/visual-compare-45-cases.json`
Executed: `node -e` over the JSON array. Recorded schema is exactly
`["page","name","viewport","vpLabel","mismatchPercentage","status","dimsMatch"]`. File mtime `2026-09-12T04:14:52Z`, 9,594 bytes, 45 cases = 15 pages × 3 viewports.

| viewport | cases | PASS | non-PASS | max mismatch |
|---|---|---|---|---|
| 1440 | 15 | 12 | **3** | 26.29 % |
| 1024 | 15 | 10 | **5** | 29.94 % |
| 390 | 15 | 7 | **8** | **57.61 %** |
| **total** | 45 | 29 | **16** | 57.61 % |

Non-PASS at 390 (8): `page-01-home` 42.92 % (dimsMatch false), `page-06-cart` 42.32 % (false),
`page-07-product-detail` 20.30 % (false), `page-11-tin-tuc-detail` 30.22 % (false),
`page-12-gioi-thieu` 44.95 % (true), `page-13-lich-su` **57.61 %** (true),
`page-14-tuyen-dung` 46.66 % (true), `page-15-tuyendung-detail` 25.59 % (true).
Non-PASS at 1024 (5): home 2.21 %, cart 2.21 %, product-detail 13.35 %, tin-tuc-detail 29.94 %, tuyen-dung 13.13 %.
Non-PASS at 1440 (3): product-detail 14.73 %, tin-tuc-detail 26.29 %, tuyen-dung 11.41 %.

### 1.2 The contradiction
`AntiFan/reports/HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md` asserts **45/45 PASS at 1440 / 1024 / 390**
(183 files synced to theme `1001512581`, 0 writes to `1001510509`).

### 1.3 Why this is stated as CONFLICT, not as "the report lied"
`visual-compare-45-cases.json` carries **no run identity** — programmatically confirmed: no `referenceHash`,
`captureHash`, `runId`, `themeId`, `timestamp`, or `store` field exists on any case (`has run/theme/store identity: false`).
Therefore it cannot be proven that the 16 failures and the campaign's 45/45 belong to the same run.

**Precise verdict:** the `45/45 PASS` claim is **UNSUPPORTED by the repository's own evidence**. Two disjoint
artifacts describe the same page set with opposite results and nothing binds them to a run. Either
(a) same run → the campaign's PASS is false, or (b) different runs → the PASS is unverifiable.
Both branches are failures of the same root cause: **no identity tuple on a visual comparison record.**
This is the single most load-bearing finding of the program.

### 1.4 Third-party corroboration already in the repo
`AntiFan/reports/HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md` itself notes missing footers while declaring global PASS —
consistent with branch (a). `scripts/verify-all-visual-compare.mjs:168` is documented as "First check recorded
evidence in summary/viewport json", i.e. the verifier **can consume stale recorded evidence instead of re-measuring**.

---

## 2. DEFECT-4 (NEW, Tier-1): the platform detector scores a Shopify-shaped workspace as Haravan

`E:\Work\apps\AntiFan\src\main\qa\scanners\platform-detector.ts`:
- **L84** — comment reads `// Both Shopify and Haravan use .liquid sections`. **FALSE for Haravan**: `sections/` is 0/30 in the corpus.
- **L78–88** — on finding `sections/*.liquid` the detector does `haravanScore += 10` (and `shopifyScore += 10`).
  A workspace containing `sections/` therefore *earns* Haravan platform score.
- **L31** — `sectionsDir` is a first-class probe directory, encoding the same false assumption at the detector's structure level.

**Causal chain (all four links Tier-1):**
1. `platform-detector.ts:84` treats `sections/*.liquid` as Haravan evidence (false).
2. `packages/site-clone/src/generators/theme-compiler.ts:133,190,317,471` emits `templates/index.json` + `sections/*.liquid`.
3. `scripts/lib/...`/`theme-qa-workflow.ts:749` then grants `haravanScore`/`haravanCompliance` 100 on that output.
4. Result: the Shopify skeleton is certified as a Haravan theme, and the emitted artifact on disk
   (`AntiFan/themes/roahtrip-haravan/` — `templates/index.json` + 11 `sections/*.liquid`, 10 with `{% schema %}`)
   is the proof.

Corpus counter-evidence for step 1: across all 30 themes, `{% schema %}` **0 hits**, `{% render %}` **0 hits**,
`| reject|where|concat|at_most|at_least|image_url` **0 hits** (verified by an independent agent, `agent://VerifyLiquid`).

---

## 3. DEFECT-5 (Tier-1, restated from addendum-01): unmeasured ⇒ PASS
`AntiFan/src/main/qa/theme-qa-workflow.ts:727,731,735` emit `{mismatchPercent: null, passed: true, measured: false}`;
`L737–745` convert unmeasured viewports into `visualScore = 100` / `responsiveScore = 100`;
`L780–792` average and gate only over *measured* dimensions, so unmeasured dimensions inflate the mean by exclusion;
`L763` hardcodes the string `'Haravan OS 2.0 sections, schema presets, and Liquid templates'`.
Artifact `E:\Work\test-theme\specs\qa-matrix.json`: `overallScore: 98`, `passed: true`, all three viewports
`measured: false`, `haravanCompliance.score: 100`.

---

## 4. Defect inventory for scoring (candidate reports must account for all five)

| ID | Defect | Tier | Evidence |
|---|---|---|---|
| D1 | Unmeasured viewport ⇒ `passed: true`; unmeasured ⇒ score 100; mean inflated by exclusion | T1 source | `theme-qa-workflow.ts:727–792`; `test-theme/specs/qa-matrix.json` |
| D2 | Hardcoded false platform string "Haravan OS 2.0 sections, schema presets" | T1 source | `theme-qa-workflow.ts:763` |
| D3 | `45/45 PASS` headline unsupported; own case data records 16/45 non-PASS incl. 8/15 @390 | T1 artifact | `visual-compare-45-cases.json` vs `HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md` |
| D4 | Detector scores `sections/*.liquid` as Haravan evidence | T1 source | `platform-detector.ts:78–88`, comment L84 |
| D5 | Site-clone emits Shopify OS 2.0 skeleton labelled "Haravan OS 2.0" | T1 source + artifact | `packages/site-clone/src/generators/*`; `themes/roahtrip-haravan/` |

**The unifying root cause:** AntiFan verifies *shape and self-declaration* instead of *measured outcome under an
identified run*. D3 is what that root cause produces in the wild; D1/D2/D4 are its mechanisms; D5 is its input.
