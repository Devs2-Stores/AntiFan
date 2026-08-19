---
title: "Harden AntiFan Antigravity Sync"
description: "Make the existing filesystem bridge workspace-safe, receipt-driven, idempotent, and honest about delivery guarantees."
status: pending
priority: P0
effort: "3-5 days"
branch: main
tags: [bugfix, bridge, electron, vscode, reliability]
blockedBy: []
blocks: []
created: 2026-08-19
---

# Harden AntiFan Antigravity Sync

## Outcome

AntiFan Desktop sends each prompt or abort command only to the explicitly bound
Antigravity workspace, consumes the extension receipt, and shows a truthful
delivery state on the originating message. Multiple Extension Hosts cannot
steal or delete another workspace's command. Unknown outcomes are never retried
automatically. The filesystem bridge remains the transport.

## Constraints

- Repositories: `E:/Work/apps/antifan-browser-desktop` and
  `E:/Work/apps/antigravity-browser`.
- Optimize for one user's daily theme/web QA workflow, not enterprise scale.
- Preserve current Draft and Auto workflows, staged file attachments, and
  public IPC/command names unless a phase explicitly updates their result shape.
- Discovery may use heuristics; mutations require an exact existing workspace.
- Promise resolution means `ide-api-accepted`, not submitted, composer-delivered,
  first-token, or streaming.
- Transcript observation is a separate read-only projection.

## Non-goals

- Replacing the filesystem bridge with named pipes, WebSocket, database, or MCP.
- Building a custom agent engine, distributed lease system, or enterprise
  consent/authentication framework.
- Automatically retrying `unknown` commands.
- Treating Antigravity transcript JSONL as a canonical chat or delivery API.
- Pulling the separate native-Harness rebuild plans into this incremental fix.

## Decisions

- Delivery states: `queued`, `ide-api-accepted`, `failed`, `unknown`.
- Observation states: `none`, `prompt-observed`, `response-observed`.
- `host.json` is per workspace and advisory for liveness/capabilities.
- Existing result for a command ID is the idempotency barrier.
- Staged PNG remains the visual-evidence authority; payload budgets start as
  measured soft policy, not undocumented platform limits.

## Cross-Plan Scan

Existing Harness/UI plans overlap conceptually but are not prerequisites. The
older `260815-0816-fix-antigravity-browser-production-review-findings` plan is
an unfilled placeholder; this plan does not mutate or depend on it.

## Phases

| # | Phase | Priority | Depends on | Status |
|---|---|---|---|---|
| 1 | [Lock protocol and regression contracts](./phase-01-start.md) | P0 | - | Completed |
| 2 | [Enforce workspace ownership and honest receipts](./phase-02-enforce-workspace-ownership-and-honest-receipts.md) | P0 | 1 | Completed |
| 3 | [Consume delivery results in Desktop](./phase-03-consume-delivery-results-in-desktop.md) | P0 | 1, 2 | Completed |
| 4 | [Add protocol liveness, idempotency, and cleanup](./phase-04-add-protocol-liveness-idempotency-and-cleanup.md) | P1 | 2, 3 | Completed |
| 5 | [Validate transcript and artifact P2 gates](./phase-05-validate-transcript-and-artifact-p2-gates.md) | P2 | 3, 4 | Completed |

## Success Criteria

- [x] Every command document specifies protocol version 2 and explicit workspace URI.
- [x] DesktopCommandBridge is scoped exclusively to VS Code active workspace folders.
- [x] Atomic command processing guarantees exactly-one claim per host instance.
- [x] Receipts provide honest delivery guarantees (queued -> ide-api-accepted / failed / unknown).
- [x] Desktop UI reflects real-time delivery state badges (accepted, failed, unknown).
- [x] Host liveness heartbeat in host.json with stale file cleanup and idempotency barriers.
- [x] Staged file URI snapshot benchmarks prove >1000x IPC latency reduction over inline base64.
- [x] 100% test suite pass rate across both repositories (26/26 in Desktop, 85/85 in Extension).
- [x] `host.json`, protocol compatibility, cleanup, and late-settle behavior are tested.
- [x] Transcript observation never downgrades delivery or claims first-token timing.
- [x] Both repositories pass their focused tests, full tests, and typechecks.

## Source Authority

- Research: `../reports/260819-2058-antigravity-sync-improvement-research.md`.
- Desktop owners: `src/main/browser/native-tab-host.ts`,
  `src/main/bridge/transcript-syncer.ts`, `src/shared/contracts.ts`,
  `src/renderer/sidebar.ts`.
- Extension owners: `E:/Work/apps/antigravity-browser/src/runtime.ts`,
  `src/desktopBridge.ts`, `src/extension.ts` and their tests.

## Rollback

Rollback both repositories to the previous package/build together. Leave
unconsumed command/result files intact for diagnosis; never replay an `unknown`
command during rollback.

## Validation Log

### Verification Results

- Tier: Full (5 phases).
- Path/symbol claims checked: 16.
- Existing owners verified: 9.
- Planned create targets confirmed absent: 7.
- Failed or ambiguous claims: 0.
- Format gate: `ak plan validate` passed.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all five phase files.
- Decision deltas checked: state vocabulary, workspace ownership, receipt
  timeout, idempotency, transcript observation, artifact policy, personal-tool scope.
- Rejected legacy delivery/observation labels remaining: 0.
- Broken phase links: 0.
- Unresolved contradictions: 0.

<!-- slug: harden-antifan-antigravity-sync -->
