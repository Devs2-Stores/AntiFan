---
title: "Route AntiFan Chat to Exact Antigravity Conversation"
description: "Add an official Antigravity Sidecar route that sends Auto prompts to one verified conversation without depending on the active chat tab."
status: pending
priority: P0
effort: "4-6 days"
branch: main
tags: [feature, bridge, sidecar, antigravity, reliability]
blockedBy: []
blocks: []
created: 2026-08-19
---

# Route AntiFan Chat to Exact Antigravity Conversation

## Outcome

AntiFan Auto Send targets the selected Antigravity conversation through the
official Sidecar `agentapi send-message <conversation_id> <prompt>` contract.
The active chat tab may be different and must not receive the prompt. Draft
continues to populate the active composer. Any fallback is explicit and records
the route actually used.

## Constraints

- Repositories: `E:/Work/apps/antifan-browser-desktop` and
  `E:/Work/apps/antigravity-browser`.
- Reuse the completed workspace-safe filesystem bridge as the only
  Desktop-to-Antigravity command transport and preserve its delivery states.
- Optimize for one user's Windows theme/web QA workflow.
- Use only documented Sidecar and `agentapi` behavior for production routing.
- Keep staged evidence files out of command JSON; no inline Base64 transport.
- Unknown delivery is never retried automatically.
- A Draft downgrade is allowed only before the exact Sidecar request is
  published. After publication, timeout, crash, or untrusted evidence remains
  `unknown`; no fallback or resend is allowed.
- The official CLI carries prompt text in child-process argv. Treat visibility
  to the current OS user and privileged process inspection as an accepted
  personal-tool boundary; promise only that AntiFan does not log prompt bodies.

## Non-goals

- Building a custom Harness, agent engine, broker, or general task scheduler.
- Calling private language-server RPCs or automating Antigravity chat tabs.
- Exact-conversation abort; `agentapi` does not document an abort command.
- Replacing the existing extension route used by Draft and manual fallback.
- Creating or managing Antigravity conversations from AntiFan in this plan.

## Decisions

- Production exact routing uses an Antigravity-managed global Sidecar.
- The correct workspace Extension Host claims the existing command first, then
  uses a dedicated Sidecar runtime-data inbox. Sidecar and Extension never
  compete for the Desktop command file.
- Phase 1 must discover an Antigravity-owned source of authoritative
  `conversation_id` values before testing any candidate. Transcript session ID
  equality is never accepted as its own proof.
- Auto exact fails closed for auto-submit when mapping or Sidecar capability is
  missing. The safe fallback only opens an active-panel Draft and records that
  downgrade; it never auto-sends to the active conversation.
- Delivery states stay `queued`, `ide-api-accepted`, `failed`, `unknown`.
  A separate route field records `sidecar-agentapi` or `active-panel`.
- Sidecar work is globally serialized for KISS. Its durable lifecycle is
  `queued -> claimed -> invoking -> accepted|failed|unknown`; an ambiguous
  `invoking` record is never replayed after restart.
- Sidecar requests and results are canonically bound to command ID,
  conversation ID, workspace, prompt/attachment digests, and Sidecar instance.
  A per-install HMAC catches corruption and accidental injection but does not
  claim protection from a compromised process running as the same OS user.
- Attachment routing follows the Phase 1 probe result. Unsupported exact
  attachment delivery remains available through explicit active-panel fallback
  only before Sidecar publication. Capability is versioned per MIME class.
- Exact-conversation abort is rejected locally. Existing active-panel abort is
  retained only for messages that actually used the active-panel route.

## Cross-Plan Scan

- Consumes the completed outputs of
  `../260819-2244-harden-antifan-antigravity-sync/`; no blocking dependency
  remains even though that plan's frontmatter has not been closed.
- Native Harness and Project UI plans overlap conceptually but are not
  prerequisites. They must later reuse this routing contract rather than add a
  second Antigravity sender.
- No existing unfinished plan owns an Antigravity Sidecar implementation.

## Phases

| # | Phase | Priority | Depends on | Status |
|---|---|---|---|---|
| 1 | [Prove Sidecar routing and ID semantics](./phase-01-start.md) | P0 | - | Completed |
| 2 | [Build and install the managed Sidecar router](./phase-02-build-and-install-the-managed-sidecar-router.md) | P0 | 1 | Completed |
| 3 | [Route Desktop Auto Send by exact conversation](./phase-03-route-desktop-auto-send-by-exact-conversation.md) | P0 | 1, 2 | Completed |
| 4 | [Validate rollout, fallback, and operations](./phase-04-validate-rollout-fallback-and-operations.md) | P1 | 3 | Completed |

## Success Criteria

- [x] With conversation A active, Auto Send to selected conversation B adds the marker only to B and does not move Antigravity focus.
- [x] The conversation ID mapping is empirically proven and version-recorded; no code assumes transcript session ID equality without evidence.
- [x] Sidecar install, enable, heartbeat, restart, and removal work on Windows.
- [x] Sidecar commands are validated, atomically claimed, idempotent, bounded, durably stateful, serialized, and produce bound truthful receipts without automatic resend.
- [x] Draft remains active-panel composer population with current attachments.
- [x] Missing/stale Sidecar or mapping never auto-sends; the active-panel Draft downgrade is explicit on the originating message.
- [x] No timeout, crash, invalid receipt, or restart after Sidecar publication triggers an active-panel Draft or a second send.
- [x] Attachment behavior matches the Phase 1 capability result and never silently drops evidence.
- [x] Exact-route abort is visibly unsupported and never calls the global `antigravity.abort` command for a different active conversation.
- [x] Both repositories pass focused tests, full tests, typecheck/compile, and a live two-conversation Antigravity acceptance matrix.

## Source Authority

- Research: `../reports/260819-2313-antigravity-independent-chat-routing-research.md`.
- Existing reliability contract:
  `../260819-2244-harden-antifan-antigravity-sync/plan.md`.
- Official docs: <https://antigravity.google/docs/sidecars/>.

## Rollback

Disable/remove only the `antifan-chat-router` Sidecar and stop selecting the
exact route. Keep the existing extension bridge, receipts, Draft path, command
files, transcripts, and staged evidence untouched. Never replay an `unknown`
Sidecar command during rollback.

## Red Team Review

All 14 evidence-backed findings were accepted and propagated.

- Critical (4): authoritative conversation-ID discovery; explicit same-user
  trust model; no post-publication Draft fallback; durable crash recovery.
- High (8): verified absolute Node launcher; busy/acceptance hard gate; exact
  workspace authority; per-MIME attachment capability; fully bound receipts;
  argv secrecy boundary; typed callback outcomes; route-safe abort behavior.
- Medium (2): concurrent-safe owned installer updates/removal; route metadata
  preservation through transcript and bridge projections.

### Whole-Plan Consistency Sweep

- Files reread: `plan.md` and all four phase files.
- Decision deltas checked: 14.
- Reconciled stale references: 14.
- Unresolved contradictions: 0.

## Validation Log

### Verification Results

- Tier: Standard (4 phases; Fact Checker + Contract Verifier).
- Path claims checked: 43; 33 existing targets verified and 10 planned Create
  targets confirmed absent as expected.
- Contract flows traced: current extension callback/receipt inference, global
  abort path, and Desktop delivery metadata through transcript/renderer
  projections; every planned owner is listed.
- Failed or unverified claims: 0.
- Local phase/report links: all resolved.
- Format gate: `ak plan validate` passed.
- Whitespace gate: `git diff --check` passed.

<!-- slug: route-antifan-chat-to-exact-antigravity-conversation -->
