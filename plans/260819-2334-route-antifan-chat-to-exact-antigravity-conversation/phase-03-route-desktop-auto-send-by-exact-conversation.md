---
phase: 3
title: "Route Desktop Auto Send by exact conversation"
status: completed
priority: P0
effort: "1.5-2 days"
dependencies: [1, 2]
---

# Phase 03: Route Desktop Auto Send by Exact Conversation

## Context Links

- Plan: [plan.md](./plan.md)
- Sidecar contract: [Phase 02](./phase-02-build-and-install-the-managed-sidecar-router.md)
- Existing reliability plan:
  [Harden AntiFan Antigravity Sync](../260819-2244-harden-antifan-antigravity-sync/plan.md)

## Overview

Route the already-claimed workspace command inside the Extension Host. Auto
Send uses exact conversation routing only when capability and ID mapping are
proven. Draft continues through the current active-panel path; safe downgrade
is restricted to the period before Sidecar request publication.

## Requirements

- Functional: the correct workspace Extension Host discovers Sidecar
  heartbeat/capabilities and rejects stale/incompatible hosts before creating a
  Sidecar request.
- Functional: selected conversation ID is required for exact Auto Send and must
  pass the Phase 1 mapping rule.
- Functional: exact Auto requires an exact existing workspace binding from the
  selected session. It must not use `process.cwd()`, a broad parent, or tab-URL
  heuristics as mutation authority.
- Functional: Desktop continues to publish one workspace command through the
  cooked bridge. Extension correlates one exact Sidecar request/result with it.
- Functional: Draft always uses the existing `AntigravityCommandClient` with
  `mode: draft` and keeps composer attachments.
- Functional: unavailable exact routing may populate an active-panel Draft only
  before a Sidecar request is published. After publication, timeout, crash,
  malformed/mismatched receipt, or restart returns `unknown`; no Draft or resend.
- Functional: each message records requested route, actual route, target
  conversation ID, delivery state, and bounded fallback/error reason.
- Functional: attachment handling is all-or-nothing. Verify expected count,
  MIME capability, byte length, and digest for every staged ref before exact or
  Draft dispatch; evidence is never silently dropped.
- Functional: the extension callback returns a typed terminal outcome. A legacy
  resolved `false` maps to `failed`, never `ide-api-accepted`.
- Functional: exact-routed abort is rejected as unsupported and never invokes
  the global `antigravity.abort`; active-panel abort remains unchanged.
- Functional: route metadata survives transcript refresh and BridgeServer event
  projection without duplicating or replacing the optimistic user message.
- Non-functional: existing command/result contracts remain additively compatible.

## Architecture

```text
Sidebar session B + Auto
  -> NativeTabHost writes cooked workspace command with exact target B
  -> correct workspace Extension Host atomically claims it
  -> SidecarRouterClient completes all preflight checks
  -> publication boundary: atomically writes one signed Sidecar request
  -> sidecar-agentapi result returns through existing extension receipt
  -> message badge: exact chat / accepted|failed|unknown

Sidebar Draft or safe downgrade
  -> existing AntigravityCommandClient
  -> workspace extension bridge
  -> sendToAgentPanel(autoSend=false)
  -> message badge: active tab draft / accepted|failed|unknown
```

Route selection is a pure function in the extension Sidecar client module so it
can be tested without Antigravity. `DesktopCommandBridge` preserves atomic claim
and receipt ownership; its callback returns the terminal delivery/route outcome
instead of treating any resolved Promise as accepted. `NativeTabHost` persists
returned route evidence in the local delivery overlay used during transcript
reconciliation.

## Contract Changes

- Add `AntigravityDeliveryRoute = 'sidecar-agentapi' | 'active-panel'`.
- Add optional `requestedRoute`, `targetConversationId`, and mapping fingerprint
  to the additive Protocol v2 command contract.
- Add `actualRoute`, Sidecar request ID, Sidecar instance ID, and
  `fallbackReason` to result/chat delivery metadata.
- Add a typed `BridgeExecutionOutcome` carrying `deliveryState`, route evidence,
  and bounded error fields. `DesktopCommandBridge` emits this outcome rather
  than inferring acceptance from Promise resolution.
- Add Sidecar command/result/host types in both repository contract owners.
- Preserve `BridgeDeliveryState`; do not create stronger submitted/streaming
  labels.

## Related Code Files

- Create: `E:/Work/apps/antigravity-browser/src/sidecarRouterClient.ts`
  - host probe, route decision, atomic Sidecar request/result, cleanup.
- Modify: `E:/Work/apps/antigravity-browser/src/desktopBridge.ts`
  - additive workspace and Sidecar routing contracts/validators.
- Modify: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts`
  - consume typed callback outcome and preserve route/result metadata.
- Modify: `E:/Work/apps/antigravity-browser/src/runtime.ts`
  - exact Auto, Draft, typed outcomes, attachment policy, downgrade boundary,
    and exact-abort rejection.
- Modify: `E:/Work/apps/antigravity-browser/src/extension.ts`
  - Sidecar client lifecycle/disposal when required by the implementation.
- Create: `E:/Work/apps/antigravity-browser/test/sidecar-router-client.test.cjs`
  - host health/instance binding, request/result, route selection, timeout,
    downgrade, and post-publication unknown behavior.
- Modify: `E:/Work/apps/antigravity-browser/test/desktop-bridge.test.cjs`
  - additive contract compatibility.
- Modify: `E:/Work/apps/antigravity-browser/test/desktop-command-bridge.test.cjs`
  - exact result metadata and unchanged atomic claim/idempotency.
- Modify:
  `E:/Work/apps/antifan-browser-desktop/src/main/browser/native-tab-host.ts`
  - exact workspace binding, all-or-nothing staging, route orchestration,
    metadata overlay, manual fallback, and route-safe abort.
- Modify:
  `E:/Work/apps/antifan-browser-desktop/src/main/bridge/transcript-syncer.ts`
  - preserve delivery overlay fields while refreshing transcript observations.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/bridge-server.ts`
  - project command/route/result metadata without stripping it.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/shared/contracts.ts`
  - Sidecar protocol and route evidence fields.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/renderer/sidebar.ts`
  - exact/active route badges, explicit Draft downgrade state, and consume
    `errorMessage` consistently with the Main payload.
- Modify:
  `E:/Work/apps/antifan-browser-desktop/test/main/antigravity-command-client.test.ts`
  - prove active-panel behavior remains unchanged.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/bridge-server.test.ts`
  - route metadata event projection and compatibility.
- Modify:
  `E:/Work/apps/antifan-browser-desktop/test/main/transcript-correlation.test.ts`
  - delivery overlay reconciliation and no-duplicate refresh behavior.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/contracts.test.ts`
  - protocol and route field compatibility.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/ipc-audit.test.ts`
  - result/renderer route metadata parity.

## Implementation Steps

1. Add additive requested/actual route, target conversation, mapping fingerprint,
   Sidecar correlation/binding fields, and typed execution outcomes to both
   repositories' contract owners.
2. Implement `SidecarRouterClient` in the extension with injectable filesystem,
   clock, data-directory, and HMAC seams. Validate the complete echoed request
   binding and Sidecar instance before accepting a result.
3. Preserve the workspace command flow. After the correct Extension Host claims
   an Auto exact command, check Sidecar health and complete every route,
   workspace, busy, and attachment preflight. Only then publish one correlated
   request, consume its result, and return a typed outcome.
4. Fail exact routing before command creation when session-to-workspace binding
   is absent or stale; do not reuse the current `process.cwd()` fallback.
5. Update Desktop prompt staging so all expected exact-route artifacts live
   under `<targetWorkspace>/.antigravity/snapshots`. Validate count, MIME,
   byte length, and digest before any dispatch; delete/ignore partial staging.
6. Apply Phase 1 capability per MIME class. Unsupported/unknown classes block
   exact dispatch and may open an explicit active-panel Draft only before the
   Sidecar request publication boundary.
7. After Sidecar publication, map timeout, crash, invalid HMAC/binding, or
   restart to `unknown`. Never call `sendToAgentPanel` or publish another request.
8. Change `handleBridgeCommand`/`DesktopCommandBridge` to a typed terminal
   outcome. Treat resolved `false` as `failed` during compatibility migration.
9. Reject abort for a message whose `actualRoute` is `sidecar-agentapi`; return
   an explicit unsupported result without calling `antigravity.abort`.
10. Persist route evidence on the optimistic message and every delivery update.
    Update `transcript-syncer.ts` and `bridge-server.ts` projections and tests so
    refresh/rebroadcast preserves the overlay and stable command association.
11. Render concise states: `Exact chat`, `Active tab draft`, and
   `Exact unavailable - draft opened`; never label a Draft as sent.
   Consume `errorMessage` rather than the stale `error` property.
12. Add regression tests for pre/post-publication branches, typed false outcome,
    forged/mismatched result, exact abort, refresh, and double-click/idempotency.

## Todo

- [ ] Add route and Sidecar contracts.
- [ ] Implement extension Sidecar host discovery and client.
- [ ] Make Auto exact and Draft active-panel.
- [ ] Stage exact artifacts inside the target workspace.
- [ ] Enforce pre-publication-only Draft downgrade.
- [ ] Reject exact-route abort safely.
- [ ] Persist route evidence through transcript/bridge refresh.
- [ ] Cover routing and IPC regressions.

## Success Criteria

- [ ] Auto to selected B is claimed once by the correct workspace extension and
  produces one Sidecar request when the exact route is healthy.
- [ ] Sidecar offline, stale, incompatible, or unmapped produces a failed/blocked
  exact auto-send before publication; any fallback only populates a Draft and
  is labeled active tab.
- [ ] Any ambiguity after Sidecar publication stays `unknown` and creates no
  active-panel Draft, second Sidecar request, or automatic resend.
- [ ] Missing exact workspace binding creates no Sidecar or extension mutation
  command and never falls back to `process.cwd()`.
- [ ] No fallback path calls `sendToAgentPanel` with `autoSend=true`.
- [ ] Resolved callback `false` produces `failed`, not `ide-api-accepted`.
- [ ] Exact abort returns unsupported without aborting the active conversation;
  active-panel abort behavior remains unchanged.
- [ ] Messages survive transcript refresh without losing route or duplicating the
  optimistic user bubble.
- [ ] Any missing, corrupt, unsupported, or count-mismatched attachment prevents
  both exact and Draft dispatch until the full evidence set is valid.
- [ ] Desktop `npm run verify` passes.

## Risk Assessment

| Risk / assumption | Observable break signal | Pre-decided response |
|---|---|---|
| Selected session mapping becomes stale | Sidecar returns missing/wrong conversation | Fail exact send; refresh sessions; no fallback |
| Sidecar heartbeat exists but process is wedged | No result before deadline | `unknown`; manual reconciliation only |
| Transcript refresh replaces optimistic metadata | Route badge disappears or duplicate bubble appears | Match by stable message/command ID before render |
| Attachment capability differs by file type | Markdown works but PNG is ignored | Capability per MIME class; block unsupported class |
| Existing Auto users expect active-panel behavior | Sidecar unavailable after update | Open labeled Draft only; never silently auto-send |
| Result belongs to another request/instance | Echoed binding or HMAC mismatches | Quarantine it; wait to `unknown`; no fallback |

## Security Considerations

- Resolve Sidecar data under the current OS user profile; never accept an inbox
  path from renderer input.
- Require exact workspace containment for staged refs and reject reparse escapes.
- Renderer cannot choose an executable or Sidecar path; extension and Main remain
  the routing authorities.
- Validate HMAC plus request ID, conversation, workspace, prompt/attachment
  digests, and Sidecar instance before consuming a result.

## Rollback

Disable Sidecar routing in the extension while retaining the existing workspace
bridge. Only commands that have not crossed the Sidecar publication boundary may
open a labeled Draft. Published unresolved commands stay `unknown`; rollback
must not auto-submit them to the active panel.
