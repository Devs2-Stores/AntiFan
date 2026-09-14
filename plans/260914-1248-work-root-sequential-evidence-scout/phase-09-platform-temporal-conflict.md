---
phase: 9
title: "Platform, temporal and conflict contracts"
status: done
priority: P1
effort: ""
dependencies: [8]
---

# Phase 9: Platform, temporal and conflict contracts

## Overview
Locked contract items: C3. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Implement explicit Haravan/Sapo/Shopify/generic/unknown contracts for theme and app/API facts. Validate versions and temporal applicability; unknown cannot fallback to Shopify. Distinguish document assertion, runtime evidence and authority. Implement conflicts with supporting/counter evidence, unresolved state and adjudication record. Active/aging/superseded states invalidate cached recommendations. Logical graphs can be views over one store.

## Architecture
Context -> applicability filter -> supported/contradicted claims -> scoped result

## Related Code Files
Core applicability/conflict modules selected in phase 7; platform contracts grounded in corpus and current docs. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Implement platform applicability and version-scoped contracts.
2. Implement temporal transitions and stale dependency invalidation.
3. Implement explicit conflict resolution records without voting truth.
4. Probe wrong-platform, expired and contradictory inputs.

## Contract and Test Matrix
- [x] Same-name cross-platform properties cannot cross-bind; historical claim outside validity is not current fact; conflicting evidence remains visible; no majority vote promotion.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Same-name cross-platform properties cannot cross-bind; historical claim outside validity is not current fact; conflicting evidence remains visible; no majority vote promotion.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Unavailable platform evidence -> explicit unknown, not invented mapper.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
