---
phase: 5
title: "Live proof + e2e rows"
status: done
priority: P1
effort: "1d"
dependencies: [1, 2, 3, 4]
---

# Phase 5: Live proof + e2e rows

## Overview

Extend the 0945 live-probe harness (it already boots the real app in-process and
asserts against authority/bridge/journal) with detached-shell legs, plus the new
e2e rows. The 0945 probe contract is already owner-generic
(index.ts:4078-4081 accepts `kind:'project'`); phase-01 adds the remap bypass.

## Requirements

- Functional: probe legs prove detach create/join, exclusivity both directions,
  session stamping (sessions are owned by `project:<id>` — by PROJECT, not by
  window: exclusivity guarantees only one window presents X, so shared owner
  keys are correct; leg4 asserts stamping + visibility rules, NOT leak-absence),
  MCP dispatch routing to the detached host (incl. mint resolver — the bridge
  mint resolver pins project mints to the hub at index.ts:3680-3684 and MUST be
  detached-aware or leg5 fails by construction), annotation routing under
  detached+hub topology, reattach (explicit action → post-dispose fold →
  live ingest), cold restart restore. Regression rows prove default openProject
  → hub and TM count stays 1.
- Non-functional: all evidence lands in `plans/261001-0902-*/reports/`; every
  check journaled; no fabricated passes.

## Architecture

```
probe-detached-webhub.cjs (mirrors probe-multi-window-binding.cjs pattern)
   ├─ boot hub (env seeds A, workspace capsules seeded)
   ├─ leg1: default openProject(B) → assert hub only (guard regression)
   ├─ leg2: detachProject(B) via REAL entrypoint (probe seam must call
   │        detachProject, not bypass to the factory) → project:B shell live;
   │        chrome APIs ready → UNKNOWN-resolved-in-code evidence
   ├─ leg3: exclusivity — openProjectWindow(B) while detached → FOCUSED, no
   │        phantom hub created; detach of hub-presented A → live tabs
   │        transferred to detached shell, affiliation cleared first
   ├─ leg4: terminal mint in detached window → stamped project:B; assert
   │        detached shell sees exactly X-scoped sessions per
   │        isSessionVisibleToWindow; assert hub CANNOT mint B while detached
   ├─ leg5: bridge session bound to detached B → navigate/screenshot on
   │        detached host; mint resolver returns detached host; cross-drive
   │        hub tab refused TARGET_MISMATCH; bound-tab authority holds (D4 pin)
   ├─ leg5b: conditional on phase-04 verdicts — IF D1 classified bug+fixed:
   │        capture on UNFOCUSED detached window must succeed; IF D1 classified
   │        OS/design → assert typed-refuse documented behavior; IF capture
   │        capability stays unavailable, leg5b BLOCKS live proof (the QA loop
   │        detach exists for cannot run). Same for D3: bug+fixed → assert no
   │        TARGET_STALE on committed navigations; design → documented.
   ├─ leg6: annotation pick on detached B tab → writes B session only; 'auto'
   │        under detached+hub topology stays scoped (annotation gates :4494/
   │        :4547 — owner-key scoped)
   ├─ leg7: ordinary close of detached shell → record stays detached:true,
   │        NO fold (spy-asserted); then reattachProject(B) → post-dispose
   │        fold + live ingest → hub shows B tabs without restart
   ├─ leg8: re-detach + cold restart leg → marked record restores shell
   └─ invariant rows: browserShellCount, TM singleton, owners map shape
```

## Related Code Files

- Create: `scripts/probe-detached-webhub.cjs`
- Modify: `test/e2e/project-windows.test.ts` — ADD detach rows; hub guards stay.
- Modify: `test/main/` — unit rows per phase (marker/fold/exclusivity/purge).
- Reports: `plans/261001-0902-detached-project-webhub-windows/reports/`

## Test scenario matrix (live rows)

| Check | Assert |
|-------|--------|
| detach create | snapshot contains `project:B`; shellCount 2 (hub+detached); TM=0 until opened |
| chrome ready | toolbar+sidebar APIs on detached shell respond; project chip = B |
| exclusivity | openProjectWindow(B) while detached → FOCUSED detached, no phantom hub; hub flip refuses |
| session stamp | detached mint → `project:B`; detached sees exactly B-scoped rows; hub cannot mint B while detached |
| MCP route | bound dispatch lands on detached host only; cross-drive refused |
| annotation | pick writes only in-scope session; foreign refused + journaled |
| close vs reattach | ordinary close → marker intact, no fold; `reattachProject(B)` → post-dispose fold + live ingest, hub shows B tabs |
| restart | leg2 process sees `project:B` shell restored with tabs |
| TM singleton | exactly one 'unassigned' shell across all legs |

## Implementation Steps

1. Write `probe-detached-webhub.cjs` (reuse multi-window-binding helpers: pairing,
   dispatchOnSocket, journalMark, waitForApi, runColdRestartLeg pattern).
2. New e2e rows in `project-windows.test.ts` for detach happy path + exclusivity.
3. Quit-coordination rows for the 3-shell topology (extend probe-quit-coordination
   or new leg — hub + detached + TM close ordering).
4. Kongming review of evidence before marking phase done.

## Success Criteria

- [x] Probe: all legs green; `probe 24 passed, 0 failed`. — `reports/detached-webhub.json`
- [x] Cold restart leg: detached shell + strip restored; hub intact. — `reports/detached-webhub-restart.json` 5/0
- [x] e2e suite: new rows green AND existing hub guards unmodified-green. — 21/0, `plans/260927-0315-project-windows/reports/project-windows-e2e.json`
- [x] Kongming verdict PASS on evidence. — KmGate5: **PASS_WITH_CONCERNS**, residuals R1–R4 recorded in plan.md Execution Report

## Risk Assessment

- Probe complexity mirrors the 0945 probe — reuse its harness wholesale; new legs
  only. Timeout flakiness handled by the same bounded waits + journaled evidence.
- If detach lands without phase-03 boot enumeration, leg8 fails by design — that
  is the intended dependency ordering, not a defect.
