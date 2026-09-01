---
title: AntiFan core runtime freeze plan
date: 2026-09-01
summary: Consolidated 37 plan directories into one reviewed five-phase authority-first runtime freeze plan.
---

# AntiFan core runtime freeze plan

## What happened
Reconciled 37 timestamped plan directories and rewrote `plans/260901-1011-antifan-core-runtime-freeze/` as the canonical five-phase implementation plan. Source inspection separated standard MCP tool arguments from the trusted adapter-to-Main authority envelope, identified bridge-token execution bypasses, confirmed mobile HTML embeds the reusable token, and confirmed `TerminalSessionPort` has no callsites.

## Decisions
- Trusted AntiFan adapters inject Main-issued authority revisions and stable retry identity; LLM-authored MCP schemas expose no kernel authority.
- Existing invocation records use recorded policy semantics plus current receipt-access restrictions; current execution policy applies only to missing records.
- Proven pre-effect staleness requires a new authority revision and new idempotency key; ambiguous effects require inspection.
- Only the Chrome Native Messaging plan is blocked by the freeze; the UI rebuild has stale metadata but shipped phase evidence.
- Production freeze requires failure-path evidence, measured thresholds, and zero owned orphan processes.

## Verification
- Ultra planning winner materialized into `plan.md` plus five phase files.
- Adversarial review: 24 raw findings, 16 accepted corrections, 8 rejected after source checks.
- Independent final verifier checked 18 decision deltas and found one corrected factual note.
- Whole-plan consistency sweep: 37 ledger entries, zero unresolved contradictions.
- `ak plan validate`: valid.
- `ak plan reindex --apply`: canonical plan recognized with five phases.
- `ak plan use`: worktree pinned; `ak plan resolve` selects the canonical plan first.

## Next steps
Run `/ak:cook E:/Work/apps/antifan-browser-desktop/plans/260901-1011-antifan-core-runtime-freeze/plan.md` only after the implementation handoff is chosen. Phase 01 owns the compile-safe authority contract and adapter cutover.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
