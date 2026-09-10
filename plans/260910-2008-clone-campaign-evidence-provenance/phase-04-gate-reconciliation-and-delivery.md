---
phase: 4
title: "Gate Reconciliation & Delivery"
status: pending
priority: P1
effort: "4h"
dependencies: ["phase-03-campaign-re-run-and-verdicts"]
---

# Phase 4: Gate Reconciliation & Delivery

## Overview

Turn the re-run into one defensible artifact: a cumulative report in the sixteen-section contract, carrying exactly one final verdict, generated deterministically from persisted evidence — and reconcile, in writing, the three places where the campaign's policy and the downstream plan's acceptance currently contradict each other. Nothing in this phase may claim an acceptance the evidence does not meet.

## Requirements

### G1 — One deterministic, cumulative report

- The sixteen sections required by `plans/260909-1721-restore-visual-fidelity-canary/phase-06-report-and-fidelity-gate.md` (Environment … Next Action) live in the **campaign aggregate**, one report for the run, with a row and an evidence link per page × viewport. Per-page sixteen-section reports are not required and are added only if `build-report.mjs` is proven to support a multi-document run — that compatibility is unverified, and fifteen full report bodies would be cost without a reader.
- `Run #1 vs Run #2` keeps the historical comparison and adds the current run as a separately labelled block.
- Generation is deterministic and fail-closed: a missing or contradictory artifact fails generation instead of producing a verdict (the `build-report.mjs` contract already proven on the homepage run — two consecutive regenerations produced byte-identical output).
- The campaign aggregate is cumulative across batches, correcting the last-batch-only overwrite at `fifteen-pages-run.mjs:765-767` and the `PAGES EXECUTED` computation at `:850`, which today marks pages with on-disk evidence as `UNTESTED`.
- Exactly one final verdict: `PASS`, `FAIL`, or `INCONCLUSIVE`, using gate precedence already defined — a hard blocker fixes `INCONCLUSIVE` and a placeholder numeric such as `mismatchPercentage: 100` must never be promoted to `FAIL` evidence.

### G2 — Mask policy reconciliation (Open Decision 2)

- Keep `useDefaultWidgetMasks:false` as the binding policy, and add a masks-ON sensitivity pass over the same page set (`useDefaultWidgetMasks:true`, no user masks) reported side by side.
- Report the mask ledger for both passes (`maskResolution`, `maskedAreaRatio`, `useDefaultWidgetMasks`), and state that the masks-off result is the binding one. A mask may never hide a difference: if a page passes with masks on and fails with masks off, the report says so explicitly.

### G3 — Height-drift reconciliation (parent Phase 4 `:22`, parent `plan.md` Goal 1)

- Exercise `allowHeightDrift` both ways on a pair with a known natural length difference, and record the measured outcome: with drift disallowed, a difference inside `heightTolerance` must yield a real pixel measurement plus a reported geometry delta, and never `STRUCTURAL_TRUNCATION_DETECTED`. `heightTolerance` default is 0.10, clamped to `[0.01, 1.0]` (`src/main/tools/browser-control-port.ts:5075-5130`).
- Record the numbers, not an assertion about the code.

### G4 — Viewport mapping, stated rather than implied

- The parent's mobile acceptance is `375px / 390px`; the campaign's third viewport is `390x844`. State that 390 satisfies that alternative and that 1024 is an internal extra. No 375 viewport is added.
- State the over-ceiling policy where a reader will find it: pages whose document exceeds `CAPTURE_MAX_DIMENSION = 16384` (`src/main/verification/visual-capture.ts:700`) are refused with their measured size, and any banded evidence is labelled as not-full-page proof.

### G5 — What is actually proven

- Separate `UNIT-TEST PROOF`, `LIVE RUNTIME PROOF`, `VISUAL PROOF`, `STRUCTURAL PROOF`, `ASSET PROOF`.
- Label standalone captures as independent continuity evidence and the atomic compare pair as the only authoritative pixel input; never merge the two lineages.
- Carry the provenance block from Phase 1 (bundle sha256/bytes, instance pid, run/attempt ids) so a reader can re-derive every number.

### G6 — Downstream reconciliation without overclaiming

- Update `plans/260908-1223-independent-html-clone-and-fidelity-pipeline/phase-04-visual-compare-fidelity-gate.md` with the new evidence path and the measured mask/drift findings.
- Do not mark that phase complete on its behalf: its acceptance (homepage `<2.0%` with default masks active, its own receipt in `plans/reports/`) stays its own until its criteria are met.
- The cross-plan frontmatter relation is decided at acceptance time (see the plan's "Relationship to existing plans" section); this phase must not silently convert an unapproved plan into a dependency.

## Related Code Files

- `scripts/lib/build-report.mjs` — the sixteen-section generator and its fail-closed/deterministic behaviour; its multi-document behaviour is unverified, so per-page report bodies are only added if that support is demonstrated first
- `.canary/tools/fifteen-pages-run.mjs` — aggregate writer `:765-767`, decision enum `:818-825`, `PAGES EXECUTED` `:850`
- `.canary/15-pages/**/evidence/*.json` — per-page evidence, including the Phase 1 provenance block
- `plans/260909-1721-restore-visual-fidelity-canary/phase-06-report-and-fidelity-gate.md` — the sixteen-section contract and gate policy
- `plans/260908-1223-independent-html-clone-and-fidelity-pipeline/phase-04-visual-compare-fidelity-gate.md` — the downstream acceptance to update
- `15-PAGE-HOPLONGTECH-CLONE-CANARY.md` — the aggregate deliverable

## Implementation Steps

1. Assemble the campaign aggregate from the Phase 3 evidence, carrying the sixteen sections; require generation to abort on any missing or contradictory artifact rather than emit a verdict.
2. Make the campaign aggregate cumulative: it lists every page with evidence, its verdict, and the bundle hash it judged, and it no longer reports tested pages as untested.
3. Run the masks-ON sensitivity pass over the page set and add the side-by-side mask table; confirm the binding policy is masks-off.
4. Run the height-drift pair and record the measured outcomes for both `allowHeightDrift` settings with an explicit `heightTolerance`.
5. Assemble the final report: provenance block, proof separation, viewport mapping, over-ceiling policy, per-page verdicts, exactly one final verdict.
6. Regenerate twice and compare hashes to prove determinism.
7. Update the downstream phase with the evidence path and the measured findings, then sync this plan's status and checkboxes from actual evidence only.

## Todo

- [ ] Assemble the aggregate report from Phase 3 evidence, fail-closed
- [ ] Make the campaign aggregate cumulative and provenance-aware
- [ ] Run the masks-ON sensitivity pass and report both policies
- [ ] Measure `allowHeightDrift` / `heightTolerance` both ways
- [ ] Assemble the final report with exactly one verdict
- [ ] Prove determinism by regenerating and comparing hashes
- [ ] Update the downstream phase with the new evidence path
- [ ] Sync plan status and checkboxes from evidence only

## Verification

- Two consecutive generations of the same run produce byte-identical reports (hash comparison), as the homepage run already demonstrated.
- The report contains all sixteen sections, one row per page × viewport, and exactly one `FINAL VERDICT`.
- The mask table shows both policies with the binding one stated.
- The height-drift measurements are present as numbers, including the case that previously produced a placeholder.
- `plans/260908-1223-.../phase-04-...md` cites the new evidence path and remains open.

## Success Criteria

- [ ] One cumulative report, sixteen sections, deterministic, exactly one verdict.
- [ ] No acceptance is claimed that the evidence does not meet, and the parent phase's own criteria are left to the parent.
- [ ] The mask, height-drift and viewport policy contradictions are resolved in writing with measurements.
- [ ] Every number in the report can be re-derived from the persisted provenance block.

## Rollback

The report is generated from persisted evidence, so it can be regenerated or removed without touching raw evidence. The downstream phase update is additive text plus an evidence path; reverting it restores the previous wording. No bundle, capture artifact or raw evidence file is modified by this phase.
