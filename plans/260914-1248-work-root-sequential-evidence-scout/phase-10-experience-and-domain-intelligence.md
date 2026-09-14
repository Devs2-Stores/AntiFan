---
phase: 10
title: "Experience and domain capabilities"
status: done
priority: P1
effort: ""
dependencies: [9]
---

# Phase 10: Experience and domain capabilities

## Overview
Locked contract items: C4. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Implement case/decision graphs with explicit/inferred/not-recorded rationale and outcome. Provide skill genealogy/non-AK workflow intelligence, declared-vs-observed, requirement explicit/candidate detection, quality/acceptance, commercial estimate-vs-actual, archetypes, root-cause candidates, anti-pattern/workaround and tool usage/maintenance views. Do not infer effort from timestamps or ROI without baseline. Preserve copy/AI-origin lineage and source independence. Current user policy overrides learned habit; derived principles remain candidates. Each domain must have implemented query behavior, provenance and honest insufficient-evidence result, not a stub.

## Architecture
Claims -> cases/decisions -> domain views -> explainable queries

## Related Code Files
Core domain modules and tests concretized in phase 7; source corpus remains read-only. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Implement case/decision records and evidence-backed links.
2. Implement all P1 domain query behaviors and insufficient-evidence paths.
3. Build lineage/skill genealogy and separate declared from observed practice.
4. Exercise domain queries against real eligible corpus and record gaps.

## Contract and Test Matrix
- [x] Real corpus cases resolve source/decision/outcome links where available; missing rationale stays absent; non-AK skill links traced; every P1 capability has real query behavior and boundary verification.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Real corpus cases resolve source/decision/outcome links where available; missing rationale stays absent; non-AK skill links traced; every P1 capability has real query behavior and boundary verification.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Sparse corpus does not authorize fake demonstrations or dropping domain; record data gap and distinguish implemented behavior from evidenced usefulness.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
