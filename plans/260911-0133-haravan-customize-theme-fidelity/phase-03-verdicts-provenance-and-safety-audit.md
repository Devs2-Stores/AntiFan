---
phase: 3
title: "Verdicts, Provenance & Safety Audit"
status: blocked
priority: P0
effort: "3h"
dependencies: ["phase-02-liquid-and-structural-checks"]
---

# Phase 3: Verdicts, Provenance & Safety Audit

## Overview

The phase that makes the result admissible: one verdict per surface, each carrying the
identities that make it adjudicable, and an audit that proves the run never wrote anywhere
except the authorised copy. The audit is not a restatement of intent — it reads the run's own
command record and reports what was actually targeted.

## Requirements

### R1 — Verdict shape

Per surface × tier, one document carrying:

- the verdict, with precedence: `COMPARE_ERROR` → `INCONCLUSIVE` → `FAIL` → `PASS`, and
  `INCONCLUSIVE` winning over `PASS` whenever a gate withheld it (reference identity, motion,
  rasterization, geometry, provenance);
- the cause, as a code plus the measurement behind it;
- **provenance**: store domain, `theme_id`, theme revision digest, local source digest,
  instance pid and start token, run/attempt ids, both sides' measured geometry and capture
  receipt digests;
- **reference identity**: which reference (R1 or R2), its pinned digest and height, its
  compare-time re-measurement, and the drift between them;
- the Liquid/structural check outcomes from Phase 2, each named.

A verdict missing any of these is unpublishable, and the writer refuses rather than writing
a partial document.

### R2 — Reference-identity enforcement is demonstrated

The phase must show, with a captured case, that a reference which changes between pinning
and use yields `INCONCLUSIVE` and never `PASS`. The demonstration uses a copy or a fixture;
a campaign or reference artifact is never mutated to test a refusal path.

### R3 — Safety audit

From the run's own command record:

- every command that could write reports its resolved theme id;
- the audit asserts every such id equals `1001512581` and reports the count of commands that
  targeted anything else — which must be zero;
- no `publish`, `deploy` or push command appears in the record, and that absence is reported
  as an audited fact rather than an assumption;
- the store's live theme is never addressed by any URL used for writing (preview reads of
  `?themeid=-1` are reads and are listed separately).

### R4 — Publication

One cumulative report per run: the surface matrix, the verdicts with their causes, the
reference identities, the check outcomes, the safety audit, and the explicit statement of
what was *not* measured (auth-gated surfaces, populated cart) with the reason. Published
views change only through pointer files rewritten temp-file → fsync → rename.

## Implementation Steps

1. Extend the evidence writer so a verdict cannot be written without the full provenance and
   reference-identity block, and make the refusal typed.
2. Assemble the verdicts from persisted evidence only — no re-derivation from live state, and
   no value invented at report time.
3. Implement the safety audit over the command record and emit it as its own document with a
   pass/fail per rule.
4. Build the report from the persisted verdicts and the audit, with the not-measured section
   generated from the typed refusals rather than written by hand.
5. Run the reference-identity demonstration and the strict-parameters assertion.
6. Run the suite; then run the surfaces end to end and publish.

## Verification

- A verdict document produced by the run contains every provenance field, checked by a test
  that fails when one is removed.
- The reference-identity demonstration shows `INCONCLUSIVE` for a reference that moved, and
  a `PASS` is impossible in that case by construction.
- The safety audit reports zero commands targeting a theme other than `1001512581`, and lists
  the read-only preview reads separately.
- The strict-parameters assertion fails if either the compare parameters or the
  reference-identity gate is altered.
- Tab censuses before and after the run are equal in both scopes.

## Success Criteria

- [ ] Every measured surface has a published verdict with full provenance and reference
      identity, or a typed refusal.
- [ ] `INCONCLUSIVE` wins over `PASS` wherever a gate withheld, demonstrated on a captured
      case.
- [ ] The safety audit proves zero live-theme writes and zero publish/push commands.
- [ ] The report names what was not measured and why.
- [ ] Nothing outside `.canary/theme-fidelity/**` and the authorised theme workspace changed.

## Rollback

Stop the dev process; nothing in this phase writes to the theme. Report and verdict documents
are additive and pointer-published, so a bad publication is corrected by re-running the
report stage from the same persisted evidence.

## Outcome (2026-09-11) — blocked on a measured rendering divergence

Subject capture: 14 of 21 documents captured, 7 refused `FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY` for
desktop documents 16,229–27,360 CSS px tall against a 1..16384 raster range. Full-page evidence never
falls back to a viewport-only capture, so those legs are unmeasurable, and the comparison stage refused
the verdict set (`PROVENANCE_UNRESOLVED`) because a set is complete or refused — a missing artifact is
never a PASS. No pair verdict exists to publish. The report assembled and named all 49 gaps and did not
publish `current.json`.

The blocking measurement: the pushed copy renders 3–10× taller than the pinned copy on desktop
(home 7532 → refused at 27360; product 4749 → refused at 17229; collection 4117 → 15961; 404 1570 →
15811) while the phone tier stays within 0.75–1.19×. The 182-file push contains no `assets/` file, so
the subject is the local markup and config against the copy's server-compiled stylesheets; that confound
is recorded, not worked around. Safety audit (`report.json.safetyAudit`): theme ids exactly
`["-1","1001512581"]`, `foreignThemeIds.count 0`, no publish/deploy/push issued by the driver — with the
explicit `hrv theme backup` + `hrv theme push` pair recorded separately in `push.log` and
`push-force.log`. Restore point: `backups/phase5-pre-dev.zip`.

**Writer-stop re-check (performed after the fact, 2026-09-11).** `serve.json` records
`stopMethod: "taskkill-unconfirmed: … The process \"14020\" not found"`, so the run documents the stop
*attempt*, not an observed exit — the one-writer rule needs the exit confirmed separately. Re-checked live:
pid 14020 is not running, and no process command line matches `haravan|hrv|theme-fidelity|theme dev`
except an unrelated long-lived user service (`E:\Work\tools\haravan-upload-toolkit\packages\gateway\dist\index.js serve`,
pid 12008), which is not a theme writer and was not started by this run. At rest, therefore, no
`hrv theme dev` watcher from run4 survives to push the local source onto `theme_id 1001512581`.
