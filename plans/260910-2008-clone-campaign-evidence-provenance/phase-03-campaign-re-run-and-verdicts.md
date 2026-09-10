---
phase: 3
title: "Campaign Re-Run & Verdicts"
status: pending
priority: P0
effort: "3h"
dependencies: ["phase-01-evidence-provenance-and-freshness-gate", "phase-02-capture-side-blockers"]
---

# Phase 3: Campaign Re-Run & Verdicts

## Overview

Re-produce every render case against the bundle that invocation produces, with provenance attached and the capture-side blockers resolved, so the campaign finally reports what it measured instead of what the harness failed to measure. The runner already rebuilds both sides unconditionally (`dump-ref.mjs` + `build-clone.mjs` at stages 6/9), so a full run refreshes the bundles and the evidence together — which is exactly the pairing Phase 1 now enforces.

## Requirements

- All 15 pages × 3 viewports carry a canonical verdict from Phase 1's index; any case that cannot be produced carries a typed, declared reason (never a placeholder number).
- Every case is bound to the bundle and instance that produced it.
- Tab economy is respected and observable: two tabs per page (reference + clone), created sequentially, closed in the page's `finally`; at most three live at once; no `--keep-tabs`; after the run only the session's primary tab remains.
- The run is resumable per page: `node .canary/tools/fifteen-pages-run.mjs --pages <n>` or `--pages <a>-<b>`; the canonical index is updated after each page.
- Bundle rebuilds write only under `.canary/15-pages/<page>/clone/` and `clone/mobile/`; `.canary/run1/`, `.canary/run2/` and `.canary/run3/` are never touched.
- Wall-time expectation is measured, not guessed: ~95 s mean per page (page-01 322 s outlier, pages 12–15 174–219 s), 30–45 min for the full set, plus live refetches.
- No capture-side INCONCLUSIVE survives: any case still blocked is blocked by the reference content, the clone content, or a declared impossibility — each with a cause code.

## Prerequisites

- Isolated instance running: `node scripts/run-electron.cjs . --allow-eval` with `ANTIFAN_BRIDGE_PORT=20131`, `ANTIFAN_USER_DATA=E:/Work/.antifan-canary`, project/workspace ids as recorded in `.canary/state/instance-env.json`; ready on port 20131.
- Fresh session: `node .canary/tools/canary-session.mjs 20131 .canary/state/canary-session.json` (TLL 7200 s; re-mint after any instance restart).
- `ANTIFAN_BRIDGE_PID` pinned to the isolated instance so a dropped socket cannot heal onto the user's instance on 20130.
- Ports 7861–7875 free; `node` on PATH; `.compiled` current with the working tree.
- The instance-plane tab census is recorded before the run (`anti.browser.tabs.list`; ten orphans from dead sessions were measured on 2026-09-10 and survive a restart). They do not block a run, so clearing them is an owner action for tab economy (Open Decision 6), not a gate: the run must add none of its own.

## Implementation Steps

1. Verify prerequisites and record them (instance pid, session lease, port census) into the run provenance.
2. Run the campaign page by page, starting with one page to confirm the pipeline end to end, then the full range.
3. After each page: read `evidence/summary.json`, update `_verdicts.json`, and check both tab censuses — `anti.browser.tabs.list` (the instance plane) and `browser.list-tabs` (the session scope). A leaked tab is a defect to fix before continuing; a session cannot close a tab it does not manage (`TARGET_MISMATCH`), so the run must never create one it cannot close: pre-existing orphans are counted and reported, never adopted or chased mid-run.
4. When a case fails for a harness reason, stop and fix the harness; never continue past a capture-side INCONCLUSIVE. The point of this plan is to stop reporting those as fidelity results.
5. For each page taller than the CDP ceiling, record the typed refusal and the declared alternative from Open Decision 3 — never a crop.
6. Finish with the tab census assertion and the per-page wall times.

## Todo

- [ ] Verify and record prerequisites (instance, session, pin, ports)
- [ ] Re-run one page end to end and audit its evidence and provenance
- [ ] Re-run the full 15-page × 3-viewport campaign
- [ ] Update `_verdicts.json` per page and assert the tab census
- [ ] Record every remaining INCONCLUSIVE with a typed, non-harness cause
- [ ] Record the wall-time and tab-budget observations

## Verification

- `node .canary/tools/fifteen-pages-run.mjs --pages 1-15` completes and prints per-page verdicts.
- `.canary/15-pages/_verdicts.json` holds one entry per page × viewport, each with `verdict`, `causeCode`, `bundle.entrySha256`, `instance.pid`, and measured geometry for both sides.
- Tab census after the run: exactly the session primary tab exists in the pinned instance.
- Every `bundle.entrySha256` in the index equals the hash of the bundle file on disk at index time.

## Success Criteria

- [ ] 45/45 cases adjudicable, or a typed declared reason for each exception — cases whose document exceeds the 16384 px CDP ceiling counted and reported as typed platform refusals, explicitly excluded from the comparison set rather than silently.
- [ ] Zero cases whose INCONCLUSIVE cause is a harness-side capture defect.
- [ ] The run adds no orphaned tabs: the census after equals the census before, except for the reference/clone tabs it opened and closed itself.
- [ ] Every verdict describes the bundle that invocation produced, hash-verified at verdict time.

## Rollback

The campaign writes only under `.canary/15-pages/**` plus the aggregate report at the repository root. A bounded probe run (`--pages 2`, 2026-09-10) produced zero cases and left three side effects, all recoverable and recorded: the root aggregate was overwritten and has been restored byte-identically from `.canary/state/report-backup-before-probe.md`, with the probe's own report preserved at `.canary/state/report-after-probe-20260910.md`; `page-02-brands/evidence/summary.json` now carries the blocked result while its prior per-viewport verdicts remain intact in the untouched `run-*.json` files (mtime 11:57); and no bundle or `viewport-run.mjs` evidence was written, because the page aborted before stage 9.
