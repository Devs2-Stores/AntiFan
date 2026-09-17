---
title: "AntiFan Comprehensive Defect Remediation (108 defects, 3 tiers)"
description: "Master fix plan resolving Tier 1 (18 Workflow & MCP Hub defects DEF-01..18), Tier 2 (native crash CRASH-01 + memory churn CHURN-01/02), and Tier 3 (87 open IssueRegister issues). Winning reframing: Collision-Zone Thinking (Ultra Verifier best-of-5, 80/80)."
status: pending
priority: P1
effort: "3-5d"
tags: [crash, workflow-hub, memory-churn, dom-automation, issue-register]
created: 2026-09-16
blockedBy: ["plans/260917-1821-antifan-consolidated-remediation-soak"]
---

# AntiFan Comprehensive Defect Remediation

## Overview

AntiFan's 108 defects collapse into three boundary failures, fixed via Collision-Zone Thinking:
1. **OS Kernel Ring-Buffer** — `BridgeServer`/`TerminalManager` become bounded zero-copy circular buffers (kills 25–35 MB/s V8 churn + native `__fastfail` crashes).
2. **Compiler AST Lowering + Transactional WAL** — workflow definitions compile through a discriminated-union schema into normalized capability intents (kills all 18 Hub defects' root enabler: untyped `params`).
3. **Game Engine Raycast & Collision Hit-Test** — DOM interaction becomes occlusion-aware raycasting with modal auto-dismiss and full multi-touch pointer lifecycle (kills 87 IssueRegister issues).

Evidence: `.tmp-af-hub-audit/fix-plan-evidence-packet.md`, `plans/reports/260916-1715-workflow-hub-defect-audit-and-crash-forensics.md`, minidump `de686712-4d6e-45ad-a1c3-76106343809c.dmp` (PID 30392, Thread 0 `CrBrowserMain`, `0xC000041D`/`0xC0000409`).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Eliminate native crash cycle + 30 MB/s heap churn (CRASH-01, CHURN-01/02, DEF-12) | P0 |
| 2 | Fix all 18 Workflow & MCP Hub defects (DEF-01..18) | P1 |
| 3 | Resolve all 87 open IssueRegister issues (63 obscured, 16 drawer, 4 parity, 4 network) | P1 |
| 4 | Zero new mocks/stubs; every fix verifiable via `node --test` or smoke script | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Crash & Memory Churn Remediation](./phase-01-crash-memory-churn.md) | Pending |
| 2 | [Phase 2: Workflow Contracts & Privilege Boundary](./phase-02-workflow-contracts-privilege.md) | Pending |
| 3 | [Phase 3: Engine Transactional Execution & Diagnostics](./phase-03-engine-execution-diagnostics.md) | Pending |
| 4 | [Phase 4: DOM Raycast & IssueRegister Remediation](./phase-04-dom-raycast-issue-remediation.md) | Pending |

## Success Criteria

- [ ] Main process RSS stable < 1.5 GB under 60s @ 20 MB/s terminal stream; no `__fastfail` for a full working session
- [ ] `node .tmp-af-hub-audit/run-builtins.js` → `wf-theme-security-scan` passes; all built-in workflows execute end-to-end
- [ ] `npm run test:fast` green; new regression tests for wait_for_selector, abort propagation, continueOnError, device preset
- [ ] Hub MCP catalogue reflects live `AntiFanMcpServer.listTools()` (99 tools), not the 12-stub array
- [ ] 87 IssueRegister issues reconciled to RESOLVED or reclassified with evidence
- [ ] `npm run typecheck` clean

## Risk Assessment

- **Ring-buffer regression**: dropping terminal frames could lose user-visible output → mitigated by tail-drop counter telemetry + PTY pause backpressure (producer slows instead of dropping).
- **Discriminated union schema breaks existing workflows**: all persisted/legacy workflow defs must still parse → keep `z.record` fallback branch with deprecation warning during one release.
- **Modal auto-dismiss misfires**: could close legitimate dialogs → cap at 2 dismiss attempts, then escalate to deep-piercing dispatch; circuit breaker on >5 DOM mutations/sec.

<!-- slug: antifan-defect-remediation-master -->
