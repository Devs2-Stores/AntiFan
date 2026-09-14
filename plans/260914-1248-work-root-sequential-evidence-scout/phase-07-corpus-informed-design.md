---
phase: 7
title: "Design from corpus"
status: done
priority: P1
effort: ""
dependencies: [6]
---

# Phase 7: Design from corpus

## Overview
Locked contract items: C1 C2 C3 C4 C5 C6 C7 C8. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Read all scout outputs; map every blueprint P0/P1 capability to query and evidence; do not require 16 physical modules. Compare embedded relational/search storage versus graph storage using observed workload. Use the approved existing agent/runtime inference route; choose retention, identity/revision/claim schemas, source permission propagation and migration strategy. Define exact APIs, owning files and all callers through LSP before code mutation. Produce child implementation phases with concrete file inventories, deterministic test cases, fixtures, rollback and dependency edges. Fix acceptance thresholds BEFORE evaluation: benchmark queries grouped by lineage/time, baseline, correctness rubric, latency/memory target and sample size; executor freezes thresholds before evaluation; material outcome changes remain blocked. Missing corpus prevents final schema commitment, not removal of scope.

## Architecture
Scout dossiers -> workload queries -> explicit contracts -> implementation child plans

## Related Code Files
reports/core-design.md; reports/acceptance-matrix.md; implementation child plans. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Inspect every completed scout dossier and map workload/data gaps to C1-C8.
2. Select storage/module contracts, exact files/callers and migration/recovery strategy using source tracing.
3. Define sanitized task set and freeze thresholds before seeing evaluation outputs; quarantine holdout labels/outcomes from training/promotion.
4. Materialize concrete child phases for each implementation slice and verify full contract coverage.

## Contract and Test Matrix
- [x] Every C1-C8 item mapped; schema and API contracts executable/testable; no unowned files or guessed existing symbol; required decisions recorded.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Every C1-C8 item mapped; schema and API contracts executable/testable; no unowned files or guessed existing symbol; required decisions recorded.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Corpus unavailable -> design gate pending. A cheaper architecture is allowed only if same outcome holds.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
