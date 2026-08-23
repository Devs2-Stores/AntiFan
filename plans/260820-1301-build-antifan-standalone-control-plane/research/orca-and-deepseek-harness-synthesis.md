---
title: "Orca.dev and DeepSeek Harness synthesis for AntiFan"
status: complete
created: 2026-08-20
scope: planning-only
sources: official-docs-and-pinned-upstream-source
---

# Orca.dev and DeepSeek Harness Synthesis for AntiFan

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Method](#method)
3. [Comparison](#comparison)
4. [Recommended Architecture](#recommended-architecture)
5. [Adopt, Spike, Defer, Reject](#adopt-spike-defer-reject)
6. [Security and Windows](#security-and-windows)
7. [Actionable Next Steps](#actionable-next-steps)
8. [Unresolved Questions](#unresolved-questions)

## Executive Summary

Orca.dev and DeepSeek Harness solve different layers. Orca is an Agent
Development Environment that supervises real CLI agents, PTYs, worktrees,
browser tabs, resume locators, hooks, and orchestration. DeepSeek Harness is a
plugin-first agent runtime centered on an append-only session log, model/provider
adapters, guarded tool execution, and live extension points.

AntiFan should combine their invariants, not their product surfaces. Own the
durable Project/Workspace/Chat/Run/browser evidence control plane locally; use
Codex/Claude/Antigravity/DSH as replaceable execution backends. Copy Orca's
process/session identity and recovery discipline. Copy DSH's durable event and
tool/provider seams. Do not vendor Orca's worktree IDE or DSH's Cordis graph.

## Method

- Research date: 2026-08-20, Asia/Saigon.
- Orca evidence: current official docs and `stablyai/orca` source pinned at
  `4daace62511c15cb8ba87686e1b8faf7142c7344`.
- DSH evidence: official `deepseek-ai/deepseek-harness` source pinned at
  `141eb6fef83422698aef7a981029e843e8161534` (`dsh@0.1.0-rc.8`).
- AntiFan evidence: live source, tests, docs, unfinished plans, typecheck, and
  the scoped scout report.
- Full source notes: [Orca report](./researcher-01-onorca-report.md), [DSH
  report](./researcher-02-deepseek-harness-report.md), [AntiFan scout](../reports/scout-report.md).

## Comparison

| Concern | Orca.dev | DeepSeek Harness | AntiFan decision |
|---|---|---|---|
| Primary role | ADE/worktree IDE over existing CLI agents | Embedded/plugin agent runtime | AntiFan owns control plane, supports both styles as adapters |
| Live authority | PTY/agent process | Agent loop plus live event waterfalls | External backend process is live truth; AntiFan event store is durable truth |
| Durable history | Agent-specific session discovery/resume metadata | Append-only typed session events and derived messages | AntiFan-owned versioned event log and opaque backend resume refs |
| Tools | CLI/browser/skills/MCP and orchestration commands | Guarded pre/execute/post/result pipeline | One policy-aware capability catalogue shared by transports |
| Browser | Per-worktree tabs, snapshot-act-snapshot, Design Mode | Not AntiFan's browser owner | Keep Chromium in Electron Main; adopt exact target and bounded evidence |
| Recovery | PTY incarnation, hooks, hibernation, resume commands | JSONL recovery and interrupted turn closure | Stable IDs, host epoch, receipts, replay, no duplicate mutation |
| Windows | Explicit Windows/WSL support and quoting paths | Sandbox partial; PTY/process limitations | Prove all security/process claims with AntiFan Windows tests |
| Maturity risk | Broad product and architecture to port | Developer preview, breaking changes | Reference only; no core dependency |

## Recommended Architecture

```text
AntiFan Project/Workspace/Chat/Run
  -> durable AntiFan event + receipt store
  -> policy/capability catalogue
     -> browser adapter (Electron Main owns Chromium)
     -> workspace file adapter
     -> PTY/one-shot terminal adapter
  -> ExecutionBackend
     -> Codex adapter (first)
     -> Antigravity adapter (compatibility)
     -> DSH adapter (spike only)
  -> optional embedded loop
     -> ModelProvider (OpenAI/Anthropic/DeepSeek API)
```

Key rule: an execution backend is not a model provider. Codex, Claude, Orca,
DSH, and Antigravity may manage their own process/session/tool lifecycle. A
provider streams model output. An embedded backend may compose a provider with
AntiFan's tools, but the shared Run contract does not expose that distinction to
the renderer.

## Adopt, Spike, Defer, Reject

### Adopt now

- Immutable Project/Workspace/Chat/Run/Attempt and browser target identities.
- PTY/process identity with incarnation and bounded cursor replay.
- Append-only model-visible event facts and derived Chat projections.
- Tool call identity, abort propagation, pre-side-effect approval, bounded
  result, and durable result event.
- Exact provider resume locator: provider ID, session ID/path, argv, cwd, and
  allowlisted environment.
- Restart-safe authenticated endpoint/lease, host epoch, and atomic file writes.
- Snapshot -> act -> snapshot browser verification and evidence budgets.

### Spike before adoption

- Codex `exec --json`, resume, cancellation, and app/exec-server lifecycle.
- `node-pty` packaging and PowerShell/CMD/WSL behavior under Electron Windows.
- DSH adapter/process mapping to AntiFan events, cancellation, and result IDs.

### Defer

- Automatic hibernation, cross-agent history UI, Git worktrees, multi-agent
  orchestration, remote runtimes, and skill marketplace.
- Compressed/custom persistence formats; raw inspectable JSONL is sufficient for
  the first durable MVP.
- Multiple direct model providers before one backend/tool/recovery loop works.

### Reject for MVP

- Vendoring Orca's Electron/React/Zustand/worktree architecture.
- Vendoring DSH/Cordis or using DSH session format as an AntiFan contract.
- Global dangerous permission bypass defaults.
- Active-tab/cwd fallbacks for autonomous mutations.
- Treating Antigravity transcript observation as exact dispatch acknowledgement.

## Security and Windows

- Canonical workspace containment must handle Windows case folding, drive/UNC
  roots, symlinks, junctions/reparse points, hard-link limitations, relocation,
  and temp paths.
- Main remains the only browser side-effect authority. External transports must
  attach with token/lease and exact Project/runtime identity.
- MCP stdout must contain protocol frames only; logs use stderr.
- Browser HTML, screenshots, console text, terminal output, and transcripts are
  untrusted evidence. Redact secrets, cap per-field/total bytes, and persist
  artifact references by default.
- Unknown mutation/model delivery is durable and is never auto-retried.
- Process termination must use validated owner/PID/birth identity and graceful
  then force shutdown; never kill an unrelated user process.

## Actionable Next Steps

1. Reconcile stale architecture claims against source and freeze contracts.
2. Add Project/Workspace/Chat/Run ownership and exact target binding.
3. Spike Codex JSONL/resume/cancel, then implement the normalized backend.
4. Consolidate browser/file/terminal capabilities into one policy catalogue.
5. Add AntiFan-owned JSONL events/receipts, crash recovery, and late reconciliation.
6. Keep DSH optional and Antigravity behind compatibility adapters.
7. Ship one theme QA vertical slice before adding worktrees or multi-agent scope.

## Unresolved Questions

- Codex CLI `--json`/resume events and stability must be captured empirically.
- Persistent PTY versus one-shot terminal for the first Windows release remains
  a spike decision; interactive resume needs PTY, while checks can start one-shot.
- DSH compatibility is intentionally undecided until Windows, cancellation,
  result attribution, and sandbox gates are measured.

