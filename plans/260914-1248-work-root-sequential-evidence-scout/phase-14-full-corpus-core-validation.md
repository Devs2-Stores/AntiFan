---
phase: 14
title: "Complete corpus import and regression"
status: done
priority: P1
effort: ""
dependencies: [13]
---

# Phase 14: Complete corpus import and regression

## Overview
Locked contract items: C1 C4 C5 C8. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Import all eligible scout units and supplemental skill roots with resume, not representative subset. Reconcile source ledger to imported/excluded/restricted/pending/blocked states by revision and domain. Run all affected tests and real workflow smoke checks; use lineage/time-separated benchmark with pre-frozen thresholds. Exercise privacy, platform leakage, missing evidence, stale receipts, archive/member integrity, changes/deletions and recovery. Evaluate domain usefulness separately from query implementation. P2 conditions assessed from corpus: predictive estimation/advanced style/automatic promotion remain unimplemented unless condition AND authorized scope permit; automatic promotion cannot override C7.

## Architecture
All scout units -> Core import -> reconciliation -> holdouts -> regression results

## Related Code Files
Actual corpus import outputs; reports/core-regression.md; reports/core-coverage.json; benchmark assets sanitized. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Import all eligible units with per-revision accounting and holdout partition isolation.
2. Run domain checks and frozen baseline criteria without leaking held-out outcomes.
3. Execute affected regression, privacy, stale/conflict and recovery cases.
4. Reconcile all ledgers and leave any data/threshold failures explicit; no narrowed denominator.

## Contract and Test Matrix
- [x] Every eligible unit imported and accounted; zero silent gaps; acceptance thresholds met on holdouts; no factual claims without source; P1 implemented and evidence gaps explicit; no excluded AK content learned.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Every eligible unit imported and accounted; zero silent gaps; acceptance thresholds met on holdouts; no factual claims without source; P1 implemented and evidence gaps explicit; no excluded AK content learned.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Unresolved in-scope data or failed thresholds -> BLOCKED/INCOMPLETE, not shrink sample or weaken tests.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
