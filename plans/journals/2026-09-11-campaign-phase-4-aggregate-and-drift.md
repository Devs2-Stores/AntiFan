# Campaign Phase 4 — Cumulative Aggregate & Height-Drift Experiment

Date: 2026-09-11. Plan: `plans/260910-2008-clone-campaign-evidence-provenance/`, phase 4.
Evidence root: `.canary/15-pages/`, aggregate `.canary/15-pages/reports/aggregate-2ff9410db21aa06d/`.

## What was wrong

The report generator rendered `PAGES EXECUTED` and the campaign index from `runSummary.pageResults`,
which only holds the pages *this process* measured. The tail run (`--pages 9-15`) therefore published
`PAGES EXECUTED : 7 / 15 (8 pages UNTESTED in this batch)` while all fifteen pages had evidence on
disk, and each batch overwrote the previous batch's `_verdicts.json` and root report.

Regenerating the aggregate also turned out not to be deterministic: `COMPLETION DATE` was
`new Date().toISOString()`, so two reads of unchanged evidence wrote different bytes.

## What changed

`fifteen-pages-run.mjs` gained an `--aggregate-only` mode. It reads every page's `current-attempt.json`,
takes the attempt that pointer names as that page's result (`<pointer.evidenceRoot>/summary.json`), and
assembles one report over all of them, so a page with evidence is never reported as untested. The run id
is a digest of the verdicts it contains, and `generateReport` renders `summary.completedAt` when the
caller supplies it — for the aggregate, the newest `publishedAt` among the pages it holds.

One bug worth its own line: `newestPublication` was initialised to `null`, and `'2026-…' > null`
coerces the date to `NaN`, so the comparison was false for every page and the newest publication was
silently discarded. It is initialised to `''` now.

`enrichWithChildEvidence` folds `visualMasksOn` and `heightDriftExperiment` from the attempt's own
evidence file into the page result the report renders. The per-page summary carries the binding
comparison only; the two diagnostic passes live beside it.

## Measured

Aggregate over 15 pages, 45 render cases, verdict `FAIL`, `PAGES EXECUTED 15 / 15`,
`RENDER CASES RUN 45 / 45 (PASS: 8 | FAIL: 17 | INCONCLUSIVE: 20)`. Two consecutive regenerations are
byte-identical: sha256 `d2a52e7d4aed1b93dc4f446ae5bf8a1054fbeac40b376fc92b3dc5d5c1320efc` before the
per-page enrichment and the same hash on the second read. Report bytes 45,944.

Mask sensitivity (G2), recorded in the report's section 12: 42 of 45 legs re-compared with
`useDefaultWidgetMasks: true` under the same lease; the verdict moved on **0** of them; mismatch change
ranged −0.28pp to +0.29pp; the masks covered at most 2.7615% of the canvas. Binding policy stays
masks-off, so no mask can pass a leg the masks-off comparison fails.

Height-drift experiment (G3), run with `CANARY_HEIGHT_DRIFT_EXPERIMENT=1` on page 1
(attempt `attempt-658308ae-c431-4537-a29c-0187dda8a456`):

| tier | natural difference | allowHeightDrift=false | allowHeightDrift=true |
|---|---|---|---|
| 1440 | 0 px | match, 1.81%, dimensionsMatch=true | match, 1.81%, dimensionsMatch=true |
| 1024 | 120 px (5.4% of 2213px, inside the 10% default tolerance) | STRUCTURAL_PARITY_MISMATCH, 2.21%, dimensionsMatch=false, deltaGeometry=120px | STRUCTURAL_PARITY_MISMATCH, 2.21%, dimensionsMatch=false |

A difference inside the tolerance yields a real pixel measurement plus a reported geometry delta, and
never `STRUCTURAL_TRUNCATION_DETECTED`. The 1440 leg has no difference to allow, so both settings agree
by construction.

## Notes for the next reader

Gate state is read from `attempts/<id>/evidence/<viewport>.json`, never from the parent batch log: the
parent does not forward child stdout, so `grep "height drift"` and `grep "reference identity"` on a batch
log return nothing even when the child recorded both. The page-level `evidence/` mirror can be a stale
copy of an older attempt; the attempt-level file is authoritative.
