---
phase: 11
title: "Retrieval, recommendation and context delivery"
status: done
priority: P1
effort: ""
dependencies: [10]
---

# Phase 11: Retrieval, recommendation and context delivery

## Overview
Locked contract items: C5. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Implement lexical baseline plus selected retrieval ranking/filtering, grounded case similarity and applicability differences. Generate recommendation/alternatives/risk/verification/uncertainty with citations. Context Pack includes core release, permission scope, relevant rules/cases/conflicts and unknowns; Decision Receipt binds task context and evidence revisions. Implement abstention when evidence insufficient and invalidation on source/policy changes. No automatic execution authority from receipt.

## Architecture
Task/context -> retrieval -> difference analysis -> recommendation -> Context Pack/Receipt

## Related Code Files
Core retrieval/service contract and adapter DTOs fixed in phase 7. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Implement deterministic local lexical retrieval plus justified ranking strategy.
2. Have existing agent/runtime synthesize from permission-filtered Context Packs; Core has no assumed provider credentials.
3. Bind receipts to task/context/revisions; expose differences, risks, verification and abstention.
4. Run quarantined holdout comparison and provider-unavailable behavior; no fake recommendation fallback.

## Contract and Test Matrix
- [x] Task query returns traceable relevant cases, differences and actionable verification; wrong platform/private data rejected; no-match abstains; held-out evaluation beats or meets pre-agreed baseline criterion without leakage.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Task query returns traceable relevant cases, differences and actionable verification; wrong platform/private data rejected; no-match abstains; held-out evaluation beats or meets pre-agreed baseline criterion without leakage.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Provider failure returns explicit unavailable; no fabricated fallback recommendations; cost/network policy enforced.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
