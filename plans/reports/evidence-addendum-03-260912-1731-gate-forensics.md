# Evidence Addendum 03 — Measurement-gate forensics: `verify-all-visual-compare.mjs`

Timestamp `260912-1731`. **Tier-1**: every fact below was executed/read by the controller this session.
This addendum explains *mechanically* how the reference storefront program produced a `45/45 PASS` headline
alongside 16 failing cases. It supersedes the "stale evidence only" reading in addendum-02 §1.4.

---

## 1. The producer of the 45-case artifact

`E:\Work\apps\AntiFan\scripts\verify-all-visual-compare.mjs` (247 lines) is the sole writer of
`reports/visual-compare-45-cases.json` (L217–218) **and** `reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md` (L237).
Both files carry mtime `2026-09-12T11:14` and the markdown's header timestamp
`2026-09-12T04:14:52.611Z` matches the JSON's mtime → **same run, one artifact pair**.

Inputs: `.canary/15-pages/page-*/attempts/*/evidence/{1440,1024,390}-{reference,clone}.png` and `<vp>.json`.
Viewports (L109): `['1440','1024','390']`. Threshold (L199): `< 2.0`.

## 2. DEFECT-6 (NEW, Tier-1): the gate min-selects fresh against recorded evidence

`verify-all-visual-compare.mjs:190–197`:
```js
let effectiveMismatch = null;
if (diffResult !== null && (recordedMismatch === null || recordedMismatch === undefined
    || diffResult.mismatchPercentage < recordedMismatch)) {
  effectiveMismatch = diffResult.mismatchPercentage;      // fresh, only when fresh is BETTER
} else if (recordedMismatch !== null && recordedMismatch !== undefined) {
  effectiveMismatch = recordedMismatch;                    // otherwise keep the recorded value
} else if (diffResult !== null) {
  effectiveMismatch = diffResult.mismatchPercentage;
}
const passed = effectiveMismatch !== null && effectiveMismatch < 2.0;
```

When both a fresh pixel diff and a recorded value exist, the result is
**`effectiveMismatch = min(fresh, recorded)`**. A regression that makes the page *worse* than its recorded value
is silently replaced by the older, better number. This is not a fallback path for missing data — it is the
normal path whenever both exist, and it biases every verdict toward PASS.
`recordedMismatch` is read at L168 from `stages.compare.mismatchPercentage`, `.visual.mismatchPercentage`, or
`.compare.mismatchPercentage` of an earlier attempt's `<vp>.json`.

## 3. DEFECT-7 (NEW, Tier-1): the printed pass count treats unmeasured (`null`) as PASS

`verify-all-visual-compare.mjs:212–215`:
```js
let passCount = 0;
for (const r of results) {
  if (r.mismatchPercentage < 2.0) passCount++;
  ...
console.log(`\nTotal: ${passCount} / ${results.length} cases meet Visual Compare < 2.0% threshold`);
```
`null < 2.0` evaluates to **`true`** in JavaScript (`Number(null) === 0`). Proven by execution:
`node -e "console.log(null < 2.0)"` → `true`; a 3-row probe with one `{v:null, status:'REVIEW'}` row yields
console `passCount = 2/3` while the JSON records `PASS = 1`.

Consequence: the **console total** and the **JSON `status` field disagree** for any unmeasured case.
`status` uses `passed` (which correctly requires `!== null`), but the number printed for humans does not.
The printed string is literally `Total: N / 45 cases meet Visual Compare < 2.0% threshold` — the shape of the
`45 / 45 ca (100.0% PASS)` claim in `HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md:150`.

## 4. The same-run human-readable artifact contradicts the campaign headline

`reports/VISUAL-COMPARE-15-PAGES-VERIFICATION.md` — same run as the JSON, header
`Thời điểm kiểm định: 2026-09-12T04:14:52.611Z` — records **29 `✅ PASS` / 16 `⚠️ REVIEW`** across 45 cases,
the worst being `page-13-lich-su` @390 = **57.61 %** and `page-14-tuyen-dung` @390 = 46.66 %.

`reports/HARAVAN-STOREFRONT-FINAL-CAMPAIGN-REPORT.md` (mtime `2026-09-12T01:29`, ~10 h **earlier**) states:
- L124 `## 11. Visual Checks: 100% Viewport Coverage (Nghiệm thu Hiển thị 45/45 Ca)`
- L150 `- **Tỷ lệ đạt chuẩn hiển thị:** **45 / 45 ca (100.0% PASS)**`

**Verdict: the newest and only case-level measurement in the repository records 16/45 failures; the 45/45 headline
belongs to an earlier, unidentified run with no captured identity, and is not reproducible from repository state.**
`UNSUPPORTED` — not merely stale.

## 5. OPEN QUESTION (UNKNOWN, requires measurement — do not assert)

Seven of the 15 mobile cases report near-zero mismatch: pages `02,03,04,05,08,09,10` @390 = **0.01 %**
(with `dimsMatch: true`), and `page-15` @1024 = **0.00 %**. A rendered mobile clone agreeing with its reference to
0.01 % pixel-level, while the same page's 1440 case reports 0.07–0.77 %, is a **degenerate-comparison
signature** (e.g. both captures blank, identical file, or a failed capture silently compared to itself).
This is recorded as `UNKNOWN`, not a defect: resolving it requires reading the actual
`.canary/15-pages/page-02-brands/attempts/*/evidence/390-{reference,clone}.png` pairs and confirming non-trivial
image entropy. Any Base Theme verification contract MUST include this check, because a gate that cannot detect a
blank-vs-blank comparison cannot certify a visual match. Note also `page-12/13/14` @390 report `dimsMatch: true`
at 44.95 %/57.61 %/46.66 % — high mismatch with matching DOM dimensions, i.e. the failure is paint-level, and the
`dimsMatch` column carries no verdict weight.

## 6. Corrected defect inventory (supersedes addendum-02 §4)

| ID | Defect | Tier | Evidence | Effect on a verdict |
|---|---|---|---|---|
| D1 | Unmeasured viewport ⇒ `passed: true`, score 100; mean inflated by exclusion | T1 source | `theme-qa-workflow.ts:727–792` | Absence of evidence ⇒ PASS |
| D2 | Hardcoded platform string "Haravan OS 2.0 sections, schema presets" | T1 source | `theme-qa-workflow.ts:763` | False platform claim in output |
| D3 | `45/45 PASS` headline unsupported; newest measurement records 16/45 non-PASS | T1 artifact | `VISUAL-COMPARE-...md` (11:14) vs campaign report (01:29) | Overclaims 100 % |
| D4 | Detector scores `sections/*.liquid` as Haravan evidence | T1 source | `platform-detector.ts:78–88`, L84 comment | Shopify shape certified as Haravan |
| D5 | `site-clone` emits Shopify OS 2.0 skeleton labelled "Haravan OS 2.0" | T1 source+artifact | `packages/site-clone/src/generators/*`; `themes/roahtrip-haravan/` | Invalid theme is the program's input |
| **D6** | **Gate min-selects `effectiveMismatch = min(fresh, recorded)`** | **T1 source** | **`verify-all-visual-compare.mjs:190–197`** | **Regressions silently pass** |
| **D7** | **Console pass count counts `null` as `< 2.0`** | **T1 source** | **`verify-all-visual-compare.mjs:212–215`**; `null < 2.0 === true` | **Printed "N/45" overstates PASS** |

## 7. What already exists and is NOT defective — the counterweight

AntiFan's browser/capture layer is rigorous and already implements fail-closed lineage. These are assets, not defects:
- `src/main/qa/haravan-sync-barrier.ts:79–118` — `awaitSync` throws `DURABILITY_FAILED` if the Haravan Theme CLI
  watcher does not acknowledge upload after `baselineSeq` within the exact `sessionGeneration`; default timeout 15 s.
- `haravan-sync-barrier.ts:124–154` — `awaitReloadAndSettle` throws `STALE_LINEAGE` unless the reload advances
  `documentGeneration` past the prior value.
- `src/main/qa/theme-mutation-session.ts:166–247` — `awaitSyncAndReload` composes both and refuses to mark
  `VERIFIED` if `documentGeneration` did not advance past the pre-mutation baseline.
- `src/main/qa/theme-transaction-registry.ts:95–150` — constructs the barrier and exposes `awaitSyncAndReload`.
- `src/main/verification/capture-settle.ts:421–626` — pre-rasterization quiescence predicates
  (`documentGenerationSettled`, `viewportStable`, `fontsSettled`, `imagesSettled`, `imageIdentityStable`, `layoutStable`);
  `tab-devtools-host.ts:1541–1549` maps failures to distinct capture codes
  (`IMAGE_IDENTITY_UNSTABLE`, `DOCUMENT_GENERATION_UNSETTLED`, `CAPTURE_NOT_READY`).
- `src/main/browser/semantic-ref-registry.ts:337–392` — throws `REF_STALE` on generation mismatch;
  `theme-qa-workflow.ts:210–213` throws `TARGET_STALE` when the live generation moved.
- `scripts/lib/atomic-record.mjs` — `sha256File`, `HASH_CONTRACT.LF_NORMALIZED`, `textDigest`, `writeRecordAtomic`.

**Root cause, stated precisely:** AntiFan's *capture* and *mutation-durability* layers already fail closed;
the *adjudication* layer (QA matrix + visual gate) fails open. D1/D6/D7 are three independent fail-open
mechanisms in the two scripts/modules that publish PASS. The program's 100 % claims are produced by the
adjudication layer, not by any measurement.
