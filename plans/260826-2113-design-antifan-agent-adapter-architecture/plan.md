---
title: "Design AntiFan Agent Adapter Architecture"
description: "Define the compatibility boundary that lets AntiFan support multiple agent runtimes without coupling the control plane to one backend."
status: complete
priority: P1
effort: "3-5 implementation slices"
tags: [architecture, adapters, acp, execution]
created: 2026-08-26
---

# Design AntiFan Agent Adapter Architecture

## Overview

This plan produces a repository-grounded architecture for an `AgentAdapter` seam in the Chromium-first AntiFan harness. The seam preserves the existing control-plane ownership of run lifecycle, browser authority, capability policy, and evidence while allowing Codex and future ACP-capable runtimes to be integrated behind explicit adapters.

The output is an implementation-ready design, not an ACP protocol rewrite. ACP is used as a compatibility reference for initialization, session setup, prompt turns, updates, tool calls, permissions, cancellation, and capability negotiation. AntiFan remains authoritative for browser control, approvals, persistence, and verification.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Define the adapter contract and ownership boundaries | P1 |
| 2 | Map current Codex and DeepSeek execution into the seam | P1 |
| 3 | Specify ACP-inspired lifecycle and capability translation | P1 |
| 4 | Provide migration slices with tests, security gates, and rollback | P1 |

## Constraints and Non-goals

- Preserve the current Chromium-first browser authority model; adapters MUST NOT gain direct ownership of `NativeHost` or `BrowserControlPort`.
- Preserve existing Codex behavior and DeepSeek opt-in compatibility behavior while introducing the seam.
- Do not implement a full ACP server/client in this plan.
- Do not make arbitrary executable paths, raw tool input, or adapter-provided permissions authoritative.
- Do not add a second long-lived process manager; reuse the existing execution backend and owned-process cleanup.

- `src/main/agent/execution-backend.ts` currently defines the compatibility contract with `startRun`, `cancel`, and an optional `resume`; `StartRunInput` carries immutable project/workspace/chat/run/attempt context, a validated cwd, optional attachment launch, timeout/output budgets, backend session reference, and an abort signal.
- `src/main/agent/codex-execution-backend.ts` owns the approved-executable check, workspace-bound child-process launch, `codex exec --json` arguments, attachment environment variables, timeout/abort cleanup, and JSONL translation into the current `status`, `session/ref`, `text`, `tool/call`, `tool/result`, and `error` events.
- `src/main/agent/deepseek-harness-adapter.ts` is feature-gated and maps selected DeepSeek harness records into the current `RunEvent` vocabulary; it is not yet a peer runtime backend.
- `test/main/execution-backend-contract.test.ts` and `test/main/codex-execution-backend.test.ts` establish current public contracts and must remain passing during migration.
- The control plane and browser-control tests establish that runtime identity, capability negotiation, run cancellation, attachment ownership, and browser cleanup are first-class concerns.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Grounding and current-state inventory](./phase-01-start.md) | Complete |
| 2 | [Phase 2: Freeze adapter boundary and lifecycle](./phase-02-freeze-adapter-boundary-and-lifecycle.md) | Complete |
| 3 | [Phase 3: Map ACP-inspired session and capability seam](./phase-03-map-acp-inspired-session-and-capability-seam.md) | Complete |
| 4 | [Phase 4: Define concrete adapter migration slices](./phase-04-define-concrete-adapter-migration-slices.md) | Complete |
| 5 | [Phase 5: Specify verification, security, and rollback gates](./phase-05-specify-verification-security-and-rollback-gates.md) | Complete |

## Dependencies

- Existing Chromium-first plan: `plans/260817-1931-rebuild-chromium-first-native-harness/`.
- Existing project UI/workflow plan: `plans/260817-2217-rebuild-chromium-first-project-ui-and-workflow/`.
- ACP primary references: `https://agentclientprotocol.com/protocol/v1/initialization`, `https://agentclientprotocol.com/protocol/v1/session-setup`, `https://agentclientprotocol.com/protocol/v1/prompt-turn`, `https://agentclientprotocol.com/protocol/v1/tool-calls`, `https://agentclientprotocol.com/protocol/v1/cancellation`, and `https://agentclientprotocol.com/protocol/v1/elicitation`.

## Success Criteria

- [x] Adapter contract names inputs, outputs, lifecycle, capability translation, permission translation, cancellation, and failure semantics.
- [x] Ownership table identifies what remains in the AntiFan control plane versus what an adapter may do.
- [x] Codex and DeepSeek migration slices identify exact files, caller changes, compatibility constraints, and cutover order.
- [x] Verification matrix covers unit, integration, browser smoke, cancellation, crash/restart, security, and evidence preservation.
- [x] Risks include ACP drift, subprocess injection, stale sessions, duplicate events, resource leaks, and rollback triggers.
- [x] Plan validates with `ak plan validate` and contains no unresolved scaffold placeholders.

## Red Team Review

### Adjudicated Findings

| Severity | Finding | Evidence | Disposition | Plan response |
|---|---|---|---|---|
| High | Cancellation can race with a post-kill backend terminal event and overwrite the intended cancellation outcome. | `src/main/run/run-service.ts:159-169`, `src/main/agent/codex-execution-backend.ts:91-115` | Accept | Phase 2 requires a control-plane cancellation fence and a rule that post-kill runtime status cannot win without an authoritative receipt; Phase 5 adds a race fixture. |
| High | A consumer exception during event application can bypass concrete adapter cleanup. | `src/main/run/run-service.ts:136-155`, `src/main/agent/codex-execution-backend.ts:101-118` | Accept | Phase 2 requires cleanup on consumer-thrown errors and all terminal/error paths; Phase 5 adds a streaming consumer-failure fixture. |
| High | Duplicate or late events have no explicit normalized-event ordering/terminal guard in the current run path. | `src/main/run/run-service.ts:249-311`, `src/main/session/run-recovery.ts:11-25` | Accept | Phase 2 requires identity/order/terminal guards; Phase 5 adds duplicate/late-event fixtures and non-authoritative handling. |
| Medium | Optional resume is currently only a type-level hook; there is no verified control-plane caller or identity gate for it. | `src/main/agent/execution-backend.ts:33-38`, `src/main/run/run-service.ts:101-139` | Accept | Phase 3 makes resume capability-, lineage-, adapter-identity-, opaque-session-, and lease-bound; unsupported resume fails explicitly. |

### Review Execution Note

The three delegated reviewer jobs could not execute because the configured Gemini
Cloud Code Assist endpoint rejected unsupported `x-google-*` schema fields before
reviewer code ran. The findings above are therefore a controller-led adversarial
review grounded in the cited repository lines, not delegated reviewer output.

### Whole-Plan Consistency Sweep

- Re-read `plan.md` and all five phase files after applying the findings.
- Confirmed the current backend terminology remains `startRun`, `cancel`, and optional `resume`; stale `cancelRun`/`resumeRun`/`isAlive`/`getStatus`/`dispose` claims are absent from the plan's current-evidence section.
- Confirmed the Codex evidence names only the events currently mapped by source, while approval/session-resume behavior remains future adapter design rather than current behavior.
- Confirmed all accepted deltas appear in phase 2 lifecycle requirements, phase 3 resume rules, phase 4 slice acceptance, and phase 5 verification steps.
- Confirmed the referenced Chromium-first architecture file exists at `plans/260817-1931-rebuild-chromium-first-native-harness/architecture.md` and remains an external dependency rather than duplicated adapter scope.
- Unresolved contradictions: none found.

<!-- red-team-reviewed: 2026-08-26 -->
<!-- slug: design-antifan-agent-adapter-architecture -->
