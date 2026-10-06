# Plan — Resilient QA (OMP × AntiFan report)

Status: in_progress
Created: 2026-10-06

## Outcome
AntiFan QA separates Verification (PASS/FAIL/INCONCLUSIVE), Execution (RUNNING/COMPLETED/DEGRADED/BLOCKED), and Recovery states. Read/QA paths auto-recover or degrade; writes stay fail-closed. New LayoutIntegrityEngine adds overlap/clipping/occlusion/offscreen/sticky detection. Single responsive contract 320/375/768/1024/1440.

## Constraints
- No new MCP server; reuse BrowserControlPort + qa/scanners.
- Write/mutation/security paths stay HARD_BLOCK fail-closed.
- Direct/Super-Fast mode semantics unchanged (edit-guard.ts already bypasses QA).
- One orchestrator (theme-qa-workflow.ts) — no per-detector gates.

## Non-goals
- No router changes, no new primitives for DOM/screenshot (exist).
- No universal visual-baseline tax on non-visual mutations.

## Acceptance
- qa_validate report carries `verification/execution/evidenceCoverage/dimensions`.
- Scanner failures on read paths produce INCONCLUSIVE dimension + DEGRADED execution, not thrown abort.
- TARGET_STALE on read path → one rebind+retry; write path → still throws.
- LayoutIntegrityEngine emits findings for overlap/clipping/occlusion/offscreen/sticky.
- LayoutOverflowEngine.BREAKPOINTS converged to 320/375/768/1024/1440.
- Repair coordinator: pure evidence gaps degrade instead of block unless contradiction/attempts exhausted.
- Focused tests green; existing gate tests unaffected.

## Phases
- P0: state model + refusal classifier + auto-recovery + capture degradation + integrity engine + responsive contract
- P1: mutation visual baseline + layout-shift witness + evidence coverage + repair-loop disposition
- P2: visual-ambiguity escalation list in report (surface for AI/human review; no fake vision call)
