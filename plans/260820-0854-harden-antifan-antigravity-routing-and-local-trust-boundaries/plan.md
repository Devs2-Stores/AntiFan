---
title: "Harden AntiFan Antigravity Routing and Local Trust Boundaries"
description: "Make exact-conversation routing runnable, fail-closed, receipt-authoritative, and safe enough for daily personal use."
status: completed
priority: P0
effort: "5-8 focused days"
tags: [antigravity, sidecar, routing, security, reliability]
created: 2026-08-20
review_report: "../reports/260820-0851-antifan-antigravity-deep-code-review.md"
---

# Harden AntiFan Antigravity Routing and Local Trust Boundaries

## Overview

Repair the cooked Antigravity integration without building a second full agent
harness. Keep the supported Antigravity Sidecar route for exact Auto delivery,
the Extension bridge for active-panel Draft delivery, and transcript files for
passive observation only.

The plan first disables unsafe behavior and makes the release reproducible,
then closes local renderer/bridge trust boundaries, proves the real Antigravity
contract, implements durable receipt semantics, restores Desktop state
ownership, and finishes with live release acceptance.

## Outcome

AntiFan can target one verified Antigravity conversation while another
conversation remains active, never silently sends to the active panel, never
auto-retries an ambiguous invocation, and can refine `unknown` from a late
authoritative receipt without treating transcript content as delivery proof.

## Constraints

- This is a personal tool: prefer one-user, local, inspectable components over
  enterprise orchestration or a new general-purpose harness.
- Use documented Antigravity Sidecar and `agentapi` behavior only for exact
  routing. Do not depend on private language-server RPC or UI automation.
- Exact Auto and exact abort fail closed. Active-panel Draft is a separate,
  explicit user action and never an automatic fallback after Auto selection.
- `unknown` is never auto-resent.
- Transcript observation never upgrades delivery state.
- Extension/Sidecar source and packaged runtime closure must be reproducible
  from an authoritative Git revision.
- Preserve the user's 10 MiB total attachment budget per command.

## Non-Goals

- Replacing Codex, Claude, DeepSeek, or Antigravity with a new coding harness.
- Detecting exact first-token time from Antigravity Chat.
- Supporting multi-user or remote-network deployment.
- Redesigning the browser UI beyond delivery, warning, and security states
  required by this repair.
- Supporting scoped exact abort until Antigravity proves an official contract.

## Architectural Contract

```text
Desktop command ledger
  -> authenticated workspace transport
  -> Antigravity Extension host
  -> managed Sidecar router
  -> agentapi send-message <verified conversation_id>

Signed/bound receipts return through the reverse path.
TranscriptSyncer observes prompt/response independently.
```

### Deadline Contract

Propagate absolute timestamps unchanged through every layer:

```text
providerExecutionDeadlineAt = issuedAt + 18s
extensionReceiptDeadlineAt  = issuedAt + 22s
desktopReceiptDeadlineAt    = issuedAt + 30s
lateReconciliationUntil     = issuedAt + 10m, plus startup scan
```

These are initial measured defaults, not unrelated hard-coded timeouts. A layer
must refuse work when its remaining budget is exhausted.

### State Contract

```text
deliveryState:    queued | ide-api-accepted | failed | unknown
observationState: none | prompt-observed | response-observed
```

Only a verified, fully bound receipt may refine `unknown` to
`ide-api-accepted`. Transcript can update only `observationState`.

## Goals

| # | Goal | Priority |
|---|---|---|
| 1 | Stop wrong-conversation sends, unsafe aborts, and unauthenticated local control | P0 |
| 2 | Ship a runnable, installable, version-controlled Sidecar runtime closure | P0 |
| 3 | Prove conversation ID and `agentapi` semantics on the installed Antigravity build | P0 |
| 4 | Make claims, receipts, deadlines, crashes, and late reconciliation durable | P0 |
| 5 | Preserve immutable workspace/conversation/attachment ownership in Desktop | P0 |
| 6 | Close MCP, cookie, process, packaging, and operational regressions | P1 |

## Phases

| # | Phase | Priority | Depends on | Status |
|---|---|---|---|---|
| 1 | [Establish fail-closed and reproducible release baseline](./phase-01-start.md) | P0 | - | Completed |
| 2 | [Harden local renderer and bridge trust boundaries](./phase-02-harden-local-renderer-and-bridge-trust-boundaries.md) | P0 | 1 | Completed |
| 3 | [Prove Antigravity conversation and AgentAPI semantics](./phase-03-prove-antigravity-conversation-and-agentapi-semantics.md) | P0 | 1 | Completed |
| 4 | [Build durable exact routing and receipt reconciliation](./phase-04-build-durable-exact-routing-and-receipt-reconciliation.md) | P0 | 1, 3 | Completed |
| 5 | [Preserve Desktop delivery state and immutable ownership](./phase-05-preserve-desktop-delivery-state-and-immutable-ownership.md) | P0 | 2, 4 | Completed |
| 6 | [Close runtime regressions and run release matrix](./phase-06-close-runtime-regressions-and-run-release-matrix.md) | P1 | 1-5 | Completed |

## Dependencies

- Installed Antigravity build with managed Sidecar support and `agentapi`.
- Desktop and Extension development environments already present on this
  Windows machine.
- A disposable pair of Antigravity conversations for live routing tests.
- An authoritative Git owner for `E:/Work/apps/antigravity-browser` before the
  first implementation commit. Default to a dedicated repository because the
  package and VSIX are an independent release boundary; if the parent monorepo
  is intentional, explicitly unignore and track only this application tree.

## Success Criteria

- [x] Exact Auto never invokes the active-panel callback when exact capability,
  mapping, authentication, attachments, or remaining budget is invalid.
- [x] Exact abort is rejected unless a scoped official Antigravity contract is
  proven; no global abort is reported as exact success.
- [x] A clean VSIX/install cycle starts the router, emits a heartbeat, survives
  restart, and removes only owned configuration/files.
- [x] With conversation A active, three repeated sends reach only verified
  target B and do not change focus.
- [x] A forged, stale, malformed, mismatched, or wrong-instance receipt cannot
  change Desktop delivery state.
- [x] Crash-boundary tests produce zero duplicate external invocations and no
  false safe-to-retry result after invocation may have started.
- [x] Desktop may refine `unknown` from a retained authoritative late receipt
  across restart; transcript response alone leaves delivery `unknown`.
- [x] Tokenless WebSocket, untrusted Origin, terminal HTML, Markdown `${...}`,
  and session traversal probes are rejected without side effects.
- [x] Queue items retain immutable workspace and conversation targets across
  restart and IDE focus changes.
- [x] Attachment sets are all-or-nothing, copied-byte verified, contained, and
  capped at 8 files / 10 MiB total.
- [x] MCP stdio emits protocol frames only; site clearing is origin-scoped;
  terminal descendants stop with the app.
- [x] Desktop verify, Extension verify/typecheck/audit, package inventory,
  clean install, crash matrix, and live two-conversation matrix all pass.
- [x] Plan and phase status are updated only from checked tasks and fresh
  verification evidence.

## Validation Commands

```powershell
cd E:\Work\apps\antifan-browser-desktop
npm run verify
npm audit --audit-level=high

cd E:\Work\apps\antigravity-browser
npm run verify
npx tsc -p . --noEmit
npx @vscode/vsce ls
```

Phase 6 adds package/install, subprocess MCP, renderer security, crash-boundary,
attachment benchmark, and live Antigravity commands after their scripts exist.

## Risks and Responses

| Risk | Signal | Response |
|---|---|---|
| Conversation ID is not authoritatively discoverable | Only transcript directory guesses exist | Keep exact Auto disabled; use explicit Draft only |
| `agentapi` exit semantics remain ambiguous | Exit 0 lacks official event/receipt evidence | Keep delivery `unknown`; do not promote from transcript |
| Antigravity update changes Sidecar contract | Fingerprint or live probe mismatch | Disable exact capability until re-probed |
| Child termination cannot be guaranteed | Process remains after deadline/grace | Keep `unknown`, block auto retry, expose cleanup diagnostic |
| Security hardening breaks a local renderer | CSP/sandbox/preload tests fail | Fix the narrow bridge; do not restore unsafe inline execution |
| Plan becomes too broad | Phase 1-5 routing/security gates pass but P1 peripherals remain | Do not ship exact Auto; phase 6 may be a separate release only after P0 gates |

## Rollback

1. Disable exact Auto capability and leave active-panel Draft explicit.
2. Stop and remove only the owned `antifan-chat-router` Sidecar entry and files.
3. Preserve command, receipt, acknowledgement, and transcript observation data
   for diagnosis; never replay `unknown` records.
4. Keep the existing browser and manual copy/Draft workflows available.

## References

- [Deep review report](../reports/260820-0851-antifan-antigravity-deep-code-review.md)
- [Previous sync-hardening plan](../260819-2244-harden-antifan-antigravity-sync/plan.md)
- [Previous exact-routing plan](../260819-2334-route-antifan-chat-to-exact-antigravity-conversation/plan.md)

## Open Questions

- Authoritative `conversation_id` source and exact `agentapi` acceptance
  semantics are deliberately resolved by the Phase 3 live gate.
- Scoped exact abort remains unsupported unless Phase 3 finds a documented
  contract.

<!-- slug: harden-antifan-antigravity-routing-and-local-trust-boundaries -->
