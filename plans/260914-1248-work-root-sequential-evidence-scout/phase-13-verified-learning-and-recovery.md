---
phase: 13
title: "Learning, adjudication and recovery"
status: done
priority: P1
effort: ""
dependencies: [12]
---

# Phase 13: Learning, adjudication and recovery

## Overview
Locked contract items: C2 C7. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Implement observation ingestion, case append, candidate knowledge review/adjudication, promotion/rejection/supersession audit and rollback. Agent may propose but never promote itself. Bind outcomes to actual execution/verification revision; inherited Core recommendation is not independent evidence. Implement incremental updates/checkpoints, source removal/permission revocation propagation through summaries/search/caches/packs, backups and recovery. Regression replay distinguishes intended correction from unexpected degradation.

## Architecture
Verified outcome -> new case -> candidate -> validation -> user-authorized promotion -> release

## Related Code Files
Core ingestion/adjudication/release modules and AntiFan receipt bridge chosen through phase 7/12. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Implement verified-outcome ingestion and candidate lifecycle.
2. Implement explicit authorized promotion/rejection and audit; production candidates remain pending in unattended run.
3. Prove adjudication/rollback in isolated acceptance store only with test-scoped authority, not fabricated approval of real knowledge.
4. Exercise incremental recovery, removal/revocation propagation, release regression and restore.

## Contract and Test Matrix
- [x] A real verified outcome creates a case and candidate; production promotion requires user authority after run; acceptance-store promotion uses explicit test authority; rejection remains auditable; crash/restart recovers; permission revocation removes derived access; rollback passes prior valid contracts.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] A real verified outcome creates a case and candidate; promotion requires user authority; rejection remains auditable; crash/restart recovers; permission revocation removes derived access; rollback passes prior valid contracts.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Real candidates remain pending by approved amendment; this is not a bypass. Acceptance proves mechanism, not real knowledge promotion. Recovery failure blocks release.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
