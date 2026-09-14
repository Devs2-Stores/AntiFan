---
phase: 12
title: "AntiFan and OMP integration"
status: done
priority: P1
effort: ""
dependencies: [11]
---

# Phase 12: AntiFan and OMP integration

## Overview
Locked contract items: C6. [Master plan](./plan.md). This is required full-goal delivery, not an optional follow-up.

## Requirements
Trace current MCP/agent entrypoints and Main authority lifecycle. Integrate Core using existing extension boundaries, not browser/kernel rewrite. Add query/context/receipt access, visibility of evidence and unknowns, user adjudication interaction through existing appropriate surface. Define unavailable-Core behavior per action: advisory tasks may proceed labelled without Core; receipt-required action must refuse. Ensure task/project identity and source permissions propagate. Exercise actual installed CLI/MCP and actual AntiFan surface, not mocked echo.

## Architecture
OMP task -> AntiFan authority -> Core advisory query -> execution policy -> verification receipts

## Related Code Files
Observed package.json:9-16 scripts/antifan-agent.cjs and scripts/antifan-omp-mcp.cjs; ownership and tool registration MUST be traced before edits. These are proposed ownership targets, not claims that modules exist. Phase 7 must materialize exact file/symbol/caller inventory and child tasks before modifying code.

## Implementation Steps
1. Trace MCP registration, authority boundaries and scripts/check-mcp-budget-dominance.mjs before adding tools.
2. Implement Core query/receipt bridge with project identity and permissions.
3. Expose inspectable asynchronous adjudication through existing appropriate CLI/MCP/UI surface.
4. Exercise actual AntiFan/OMP task in isolated local workspace and fresh verification path.

## Contract and Test Matrix
- [x] Real OMP/AntiFan task obtains a Core pack, executes authorized local work and returns fresh verification evidence; unrelated projects isolated; no permissions escalated by Core; no auto-publish.
- [x] Exact tests/commands/fixtures and affected callers recorded before implementation; do not fabricate current counts.
- [x] Observable errors, transitions and permissions verified; tests cannot merely assert wiring or source text.

## Success Criteria
- [x] All Requirements delivered and evidence linked.
- [x] Real OMP/AntiFan task obtains a Core pack, executes authorized local work and returns fresh verification evidence; unrelated projects isolated; no permissions escalated by Core; no auto-publish.
- [x] No locked contract item deferred or converted to documentation-only behavior.

## Risk Assessment
Adapter contract mismatch -> blocker and resolve all callers; do not introduce a parallel control plane.

## Approved Autonomous Run Amendment
Use existing agent/runtime for inference; no separate model API entitlement assumed. Executor may choose technical details and freeze objective thresholds before evaluation without routine questions. Acceptance mutations only in isolated local copies. Real candidate knowledge remains pending for user after run; verify promotion/rejection/rollback using a separate acceptance store with explicit test authority, never forged production approval. Stop on unavailable permissions, failed acceptance or material scope mismatch; no automatic goal launch during warmup. This amendment supersedes earlier requirements for live user promotion during this run.
