---
phase: 8
title: "Persistent Core and provenance"
status: done
priority: P1
effort: ""
dependencies: [7]
---

# Phase 8: Persistent Core and provenance

## Overview
Locked contract items: C2 C3. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Implement selected local durable storage, transactional ingestion, schema migrations and backup. Import scout ledgers without manufacturing missing evidence. Separate artifact identity/path/content revision and exact evidence anchors; handle rename/copies/container members. Store processing states/exclusions and permission metadata. Reuse existing provenance receipt integration only after tracing its API; do not create competing authority or assume ledger seals prove truth. Implement idempotent imports, change/deletion propagation and redacted export.

## Architecture
Source revisions -> durable store -> claims/evidence links -> queryable release

## Related Code Files
Proposed new Core package under packages/ (exact boundary chosen phase 7); existing ledger is reference until references traced. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Wire selected persistence and package build/typecheck/test paths; root build must actually include Core.
2. Implement schema migrations, permissions, transactional imports and revision/anchor integrity.
3. Tag evaluation partitions before ingest; exclude held-out answers/outcomes from recommendation knowledge.
4. Exercise restart, interruption, revocation and backup restore.

## Contract and Test Matrix
- [x] Actual restart preserves records; interrupted transaction replays without duplicate claims; stale/deleted sources invalidate downstream references; restricted sources do not leak; migrations and restore reproduce expected query results.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Actual restart preserves records; interrupted transaction replays without duplicate claims; stale/deleted sources invalidate downstream references; restricted sources do not leak; migrations and restore reproduce expected query results.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Storage schema/version drift -> stop migration and restore tested backup; never silently erase evidence.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
