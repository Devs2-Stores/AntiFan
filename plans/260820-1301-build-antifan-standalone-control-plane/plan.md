---
title: "Build AntiFan Standalone Control Plane"
description: "Extract a project-scoped, durable control plane from the current NativeTabHost while keeping Codex/other harnesses as replaceable execution backends and Antigravity optional."
status: completed
priority: P1
effort: "XL (6-10 weeks for a thin hardened MVP)"
branch: main
tags: [architecture, electron, chromium, harness, control-plane, recovery, windows]
blockedBy: []
blocks: [260817-2217-rebuild-chromium-first-project-ui-and-workflow]
created: 2026-08-20
---

# Build AntiFan Standalone Control Plane

## Overview

Build a standalone AntiFan control plane for the personal theme/web workflow:
select a Project and Workspace, open a durable Chat, start a Run through a
replaceable execution backend, use bounded browser/files/terminal tools, and
resume after restart. The control plane owns identity, permissions, events,
receipts, artifacts, and browser evidence. External harnesses remain adapters;
model providers remain a separate concern.

The live source tree is the implementation authority. Existing architecture
documents and unfinished plans are accepted design constraints only where Phase
2 proves that their contracts exist or explicitly supersedes their absent
implementation. This avoids creating a second Project, Run, broker, or terminal
architecture beside the older plans.

## Research Verdict

- Orca.dev is the strongest reference for PTY-as-source-of-truth, cursor reads,
  authority/incarnation/revision, restart-safe hooks, provider resume locators,
  and bounded browser evidence. Adopt these invariants; defer worktrees,
  hibernation, orchestration, and remote runtimes.
- DeepSeek Harness is useful prior art for append-only session events, derived
  chat projections, guarded tool pipelines, provider seams, and JSONL recovery.
  It is a developer preview with breaking changes, partial Windows sandboxing,
  process-local PTY state, and incomplete SDK cancellation/result attribution.
  Do not vendor Cordis/DSH or make it a production dependency.
- Codex/Claude/DeepSeek/Orca/Antigravity are execution backends or adapters;
  OpenAI/Anthropic/DeepSeek APIs are model providers. Do not collapse these
  identities into one `Session` abstraction.

See [Orca research](./research/researcher-01-onorca-report.md), [DeepSeek
Harness research](./research/researcher-02-deepseek-harness-report.md), and
[live source scout](./reports/scout-report.md).

## Outcome

After this plan, a user can:

1. Create/open a Project and explicitly bind one or more Workspaces.
2. Open a Chat whose messages and Runs survive renderer/app restart.
3. Run Codex (first) through a normalized backend contract, with Antigravity
   retained as an optional compatibility adapter.
4. Inspect/edit files, run approved terminal checks, navigate/reload/inspect a
   precisely targeted Chromium tab, and attach bounded screenshot/DOM evidence.
5. Reopen the app and resume or reconcile a Run without duplicate mutations.
6. Complete a theme QA loop with responsive/overflow/interactions evidence.

## Scope

### In scope

- Project, Workspace, Chat, Run, ExecutionAttempt, ToolInvocation, ArtifactRef,
  BrowserBinding, ExecutionBackend, ModelProvider, and receipt contracts.
- Main-process ownership and runtime/project/browser/workspace binding.
- Append-only event/receipt persistence with replay, recovery, and versioning.
- One authoritative capability catalogue shared by MCP, WebSocket, and future
  native runtime transports.
- Codex backend spike and the minimal first production backend.
- Explicit browser targeting, workspace canonicalization, bounded artifacts,
  terminal ownership, approval policy, and Windows-specific validation.
- Antigravity adapter mapping exact/active/prompt-observed/response-observed/
  unknown delivery states without making its transcript canonical.

### Out of scope for the MVP

- Full Orca clone, Git worktrees, multi-agent dispatch, worker mailboxes, gates,
  SSH/cloud/mobile runtimes, skill marketplace, or remote MCP.
- DSH/Cordis vendoring, DSH on-disk format compatibility, or DSH as runtime.
- Automatic hibernation before cold restore is proven.
- A clean-room Project renderer. Visible UI work stays with the existing UI plan;
  this plan exposes stable contracts and a thin existing-sidebar vertical slice.
- Broad provider parity. Implement one backend first and add others behind the
  same interface only after the contract spike is measured.

## Architecture

```text
Project -> Workspace -> Chat -> Run -> ExecutionAttempt -> ExecutionBackend
    |          |         |       |             |
    |          |         |       +--> Event/Receipt Store (append-only)
    |          |         +----------> Chat projection / transcript evidence
    |          +--------------------> File + terminal capability scope
    +-------------------------------> BrowserBinding -> Capability Catalogue
                                             |
                                  MCP / WebSocket / native loop adapters
```

The external PTY or harness remains the source of truth for its live process.
AntiFan owns durable identity, event ordering, policy, evidence, and recovery.
Every observation carries `projectId`, `workspaceId`, `chatId`, `runId`,
`attemptId`, `browserEpoch` where applicable, and provenance. A transcript,
screenshot, status callback, or active tab without that binding is evidence only,
never proof of delivery or mutation completion.

## Phase Graph

| # | Phase | Status | Depends on |
|---|---|---|---|
| 1 | [Reality ledger and contract freeze](./phase-01-start.md) | Completed | - |
| 2 | [Reconcile architecture and choose authority](./phase-02-reconcile-current-architecture-and-freeze-contracts.md) | Completed | 1 |
| 3 | [Project/Workspace/Chat/Run ownership](./phase-03-add-project-workspace-chat-and-run-ownership.md) | Completed | 2 |
| 4 | [Execution backend contract and Codex spike](./phase-04-add-execution-backend-contract-and-codex-spike.md) | Completed | 3 |
| 5 | [Capability broker for browser/files/terminal](./phase-05-broker-browser-files-and-terminal-tools.md) | Completed | 3 |
| 6 | [Persistence and recovery](./phase-06-persist-and-recover-standalone-runs.md) | Completed | 3, 5 |
| 7 | [DeepSeek Harness compatibility spike](./phase-07-add-deepseek-harness-compatibility-spike.md) | Completed | 4, 6 |
| 8 | [Antigravity compatibility adapter](./phase-08-move-antigravity-behind-compatibility-adapter.md) | Completed | 4, 6 |
| 9 | [Theme QA vertical slice and release gate](./phase-09-ship-standalone-theme-qa-mvp.md) | Completed | 5, 6, 8 |

## Dependencies and overlap decisions

- Plan `260817-1931-rebuild-chromium-first-native-harness` contains useful
  invariants but its named runtime files are absent. Phase 2 imports verified
  contracts and supersedes absent implementation; it must not be implemented
  in parallel as a second broker/runtime.
- Plan `260817-2217-rebuild-chromium-first-project-ui-and-workflow` remains the
  owner of a future Project renderer. This plan blocks that UI cutover only at
  the contract/runtime boundary; Phase 9 must not recreate its renderer.
- Plan `260818-1533-project-harness-coding-tool-loop` remains a source of
  accepted tool-loop intent. This plan reuses one normalized backend and one
  capability catalogue; it does not create duplicate tool names or ledgers.
- Existing unfinished plans are not silently closed. Their status/claims are
  reconciled in Phase 2 and any supersession is recorded there.

## Acceptance Criteria

- [ ] `npm run typecheck`, focused unit tests, and the full test suite pass.
- [ ] A standalone run cannot mutate a different Project, Workspace, tab,
      document generation, or terminal owner through an omitted/active target.
- [ ] Every user prompt has a durable Chat/Run/Attempt identity and normalized
      backend events; model-visible input and tool results are reconstructable.
- [ ] Restart/replay covers queued, running, completed, interrupted, unknown,
      and late-receipt states without automatic duplicate mutation.
- [ ] MCP/WebSocket/native transports enumerate and dispatch from one catalogue;
      stdout is frame-pure for MCP and policy denials are typed and stable.
- [ ] Browser/DOM/screenshot/terminal/transcript payloads enforce budgets and
      redaction and return artifact references rather than unbounded inline data.
- [ ] Windows PowerShell/CMD behavior, path canonicalization, reparse-point
      handling, process ownership, and shutdown are covered by tests.
- [ ] Standalone attachment requires an authenticated lease and explicit
      Project/runtime scope; MCP profile access and eval are not enabled by a
      global boolean.
- [ ] Rollback can stop/drain owned runs, PTYs, watchers, and transports and
      switch back to the legacy adapter without leaving new writes in flight.
- [ ] A user can complete one theme QA flow: inspect -> edit -> check -> reload
      -> responsive/overflow/interactions evidence -> durable report.

## Security and rollback

- Main process remains the only side-effect authority. New transports attach to
  an existing runtime with a random token/lease, protocol version, host epoch,
  and explicit Project scope; every request revalidates the lease.
- Workspace roots are canonicalized and checked for traversal, symlink/junction,
  UNC, case, and relocation hazards. High-risk tools are deny-by-default.
- Unknown mutation results are never auto-retried. Recovery replays facts and
  requests explicit reconciliation or user action.
- Each phase is independently revertible behind adapters. Until Phase 6 passes,
  keep legacy Antigravity delivery and current browser UI as compatibility paths;
  do not delete `NativeTabHost` or `TranscriptSyncer`. The adapter switch must
  drain active attempts and owned processes before disabling new writes.

## Validation and handoff

Run the narrowest tests after each phase, then the full suite and Windows smoke
matrix before release. The plan is not ready to cook until `ak plan validate`
passes and the whole-plan consistency sweep has no unresolved contradictions.

Implementation handoff:

```powershell
/ak:cook E:\Work\apps\antifan-browser-desktop\plans\260820-1301-build-antifan-standalone-control-plane\plan.md
```

## Validation Log

### Verification Results

- Tier: Full (9 phases; self-verification before implementation)
- Claims checked: 48
- Verified against live source/reports: 41
- Intentionally absent target files: 7 (all are explicit `Create:` outputs owned
  by future phases, not claimed as shipped current behavior)
- Unresolved contradictions: 0

The absent architecture claims are isolated in Phase 2 and the reality ledger;
no later phase treats them as existing. Security and recovery claims that failed
against the current legacy path are represented as mandatory implementation
gates and hostile-review findings, not as completed behavior.

<!-- slug: build-antifan-standalone-control-plane -->

## Red Team Review

### Session - 2026-08-20

**Findings:** 17 (17 accepted, 0 rejected)
**Severity breakdown:** 3 Critical, 13 High, 1 Medium

| # | Finding | Severity | Disposition | Applied To |
|---|---|---|---|---|
| 1 | Late receipts are not restart-safe or strongly correlated | Critical | Accept | Phases 6, 8 |
| 2 | Crash boundaries lack a durable recovery owner | Critical | Accept | Phase 6 |
| 3 | Delivery ledger is not a versioned event authority | Critical | Accept | Phase 6 |
| 4 | PTY ownership/shutdown can orphan or kill unrelated processes | High | Accept | Phases 5, 9 |
| 5 | Provider disconnect/cancel/resume semantics are absent | High | Accept | Phase 4 |
| 6 | Rollback has no real runtime drain boundary | High | Accept | Phases 2, 9 |
| 7 | MCP has no authenticated Project attachment | High | Accept | Phase 5 |
| 8 | Attachment paths are arbitrary and unbounded | High | Accept | Phase 5 |
| 9 | Receipt validation allows optional/mismatched bindings | High | Accept | Phases 6, 8 |
| 10 | Terminal is global, arbitrary-cwd, and inherits credentials | High | Accept | Phase 5 |
| 11 | Browser active-tab fallback permits target races | High | Accept | Phase 5 |
| 12 | MCP stdout and high-risk eval are unsafe transport boundaries | High | Accept | Phase 5 |
| 13 | DOM/screenshot results are unbounded and unredacted | Medium | Accept | Phase 5 |
| 14 | WebSocket bridge bypasses catalogue/policy | High | Accept | Phase 5 |
| 15 | Bridge discovery lease lacks atomic ownership/Project binding | High | Accept | Phase 5 |
| 16 | Sidecar receipt/claim path needs exact binding and crash-safe idempotency | High | Accept | Phase 8 |
| 17 | Existing MCP exposes mutators outside the future default-read policy | High | Accept | Phase 5 |

Evidence for these findings is recorded in the scoped hostile-review messages
and the live-source scout report. They are implementation gates, not claims that
the current legacy path is already fixed.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md`, all nine phase files, scoped research and scout reports.
- Decision deltas checked: authenticated attachment, exact receipt binding,
  durable startup recovery, process drain/rollback, bounded artifacts, and
  explicit target requirements for reads as well as mutations.
- Reconciled stale references: 13 findings propagated into phase requirements,
  steps, success criteria, and release/security gates.
- Unresolved contradictions: 0.
