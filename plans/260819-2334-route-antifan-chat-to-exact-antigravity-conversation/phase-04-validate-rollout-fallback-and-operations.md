---
phase: 4
title: "Validate rollout fallback and operations"
status: completed
priority: P1
effort: "1 day"
dependencies: [3]
---

# Phase 04: Validate Rollout, Fallback, and Operations

## Context Links

- Plan: [plan.md](./plan.md)
- Desktop routing: [Phase 03](./phase-03-route-desktop-auto-send-by-exact-conversation.md)
- Desktop operations: `E:/Work/apps/antifan-browser-desktop/docs/operations.md`
- Extension setup: `E:/Work/apps/antigravity-browser/README.md`

## Overview

Run the full two-repository and live Antigravity acceptance matrix. Document
install, compatibility probe, diagnostics, manual fallback, update, and rollback
for daily personal use.

## Requirements

- Functional: verify exact routing with two visible conversations and the
  non-target conversation active.
- Functional: verify offline, stale heartbeat, malformed result, timeout, crash,
  restart, duplicate command, and missing conversation behavior.
- Functional: verify Draft and explicit active-panel fallback with text,
  Markdown, PNG, and multi-attachment evidence.
- Functional: verify install/update/remove against a config containing existing
  user settings and unrelated Sidecars, including concurrent config mutation
  and modified owned files.
- Functional: expose diagnostics sufficient to answer route, target, host age,
  command ID, result, and fallback reason without logging prompt contents.
- Functional: verify exact abort rejection, typed callback outcomes, forged or
  mismatched receipts, and metadata survival through transcript refresh.
- Non-functional: no orphan Sidecar child process, duplicate poller, broad file
  cleanup, or regression in extension delivery.

## Acceptance Matrix

| Scenario | Expected result |
|---|---|
| A active; Auto target B | Marker appears only in B; focus stays on A |
| B running | Behavior matches Phase 1 busy contract; no duplicate send |
| Invalid/stale B ID | Exact send fails; no active-panel command |
| Sidecar unavailable before request publication | Labeled Draft opens active panel; no auto-submit |
| Sidecar timeout/crash after request publication | Delivery `unknown`; no Draft, resend, or second request |
| Router crash while durable state is `claimed` | Deterministic failure; zero `agentapi` spawn |
| Router crash while durable state is `invoking` | Delivery `unknown`; processing record never replayed |
| Crash after positive acceptance but before result | Delivery `unknown`; no replay or Draft fallback |
| Extension callback resolves `false` | Workspace receipt is `failed`, never `ide-api-accepted` |
| Exact-routed abort | Explicit unsupported result; active conversation is not aborted |
| Forged/wrong-instance/mismatched result | Result rejected/quarantined; eventual `unknown`; no fallback |
| Draft with attachments | Active composer receives current files |
| Auto with supported exact artifacts | B receives prompt and usable staged refs |
| Missing/corrupt/unsupported attachment in a set | No exact or Draft dispatch; full evidence set retained |
| Safe downgrade | Active composer receives once; no auto-submit; badge says active tab draft |
| Duplicate command ID/restart | At most one `agentapi` invocation |
| Two queued Sidecar commands | Global deterministic serialization; no overlap |
| Config changes during installer merge | Installer aborts; external change remains untouched |
| Owned Sidecar file changed before removal | Removal refuses that file and reports it |
| Antigravity update | Compatibility probe must pass before exact route resumes |

## Related Code Files

- Modify: `E:/Work/apps/antifan-browser-desktop/docs/operations.md`
  - setup, health, diagnostics, update, disable, rollback, unknown reconciliation.
- Modify: `E:/Work/apps/antifan-browser-desktop/README.md`
  - concise exact-vs-Draft behavior and setup link.
- Modify: `E:/Work/apps/antigravity-browser/README.md`
  - Sidecar install/update/remove and compatibility probe commands.
- Modify: `E:/Work/apps/antigravity-browser/package.json`
  - final verification command includes Sidecar tests/probe prerequisites.
- Modify: `E:/Work/apps/antigravity-browser/test/desktop-command-bridge.test.cjs`
  - typed false outcome, exact routing metadata, and atomic-claim assertions.
- Modify: `E:/Work/apps/antigravity-browser/test/package-and-webview.test.cjs`
  - packaged Sidecar and installer artifact coverage.
- Modify existing tests only where the acceptance matrix exposes a missing
  contract; do not weaken prior reliability assertions.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/bridge-server.test.ts`
  - route metadata survives event projection.
- Modify:
  `E:/Work/apps/antifan-browser-desktop/test/main/transcript-correlation.test.ts`
  - route metadata survives transcript reconciliation without duplicate bubbles.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/contracts.test.ts`
  - result binding, typed outcome, route metadata, and abort compatibility.

## Implementation Steps

1. Run focused Sidecar router/installer tests, then both repository test suites,
   typecheck/compile, and static IPC/contract checks.
2. Install the Sidecar with the owned script; verify Antigravity launches it,
   updates heartbeat, rotates instance ID after restart, and writes bounded logs.
3. Execute every acceptance-matrix scenario with unique markers and capture
   command/result/state/event/transcript evidence, including the exact Sidecar
   publication timestamp.
4. Confirm the target proof does not depend on Antigravity tab focus and that a
   pre-publication downgrade populates Draft only, while every post-publication
   ambiguity stays `unknown` with no active-panel action.
5. Inject crashes before spawn, during spawn, and after positive acceptance.
   Verify durable state classification, no replay, and no orphan descendant.
6. Inject resolved `false`, forged HMAC, wrong conversation/workspace/digest,
   wrong Sidecar instance, and exact-abort requests. Verify fail-closed outcomes.
7. Verify text/Markdown/PNG and multi-file sets all-or-nothing, including
   missing files and digest/count mismatch before exact and Draft dispatch.
8. Test install/update/remove against fixtures and live config. Introduce a
   concurrent writer between read and replace and a modified owned file before
   removal; verify refusal without data loss.
9. Refresh transcripts and BridgeServer clients after each route result; verify
   route metadata survives and optimistic messages are not duplicated.
10. Update operations and README surfaces with exact commands, state machine,
   trust/argv boundary, compatibility fingerprint, diagnostics, and rollback.
11. Run a final whole-plan consistency sweep and record the validation log in
   `plan.md` during cook finalization.

## Validation Commands

```powershell
cd E:\Work\apps\antigravity-browser
npm test

cd E:\Work\apps\antifan-browser-desktop
npm run verify
```

The live Sidecar matrix is mandatory because unit tests cannot prove Antigravity
conversation routing or `agentapi` acceptance semantics.

## Todo

- [ ] Pass focused and full tests in both repositories.
- [ ] Pass live two-conversation routing matrix.
- [ ] Pass crash/restart/idempotency matrix.
- [ ] Pass pre-publication fallback and post-publication no-fallback matrix.
- [ ] Pass typed callback, bound receipt, and exact-abort matrix.
- [ ] Pass text/Markdown/PNG capability and Draft downgrade matrix.
- [ ] Verify install/update/remove preserves concurrent user config and modified owned files.
- [ ] Update setup, diagnostics, and rollback docs.
- [ ] Complete final contract and process-owner review.

## Success Criteria

- [ ] Zero wrong-conversation deliveries across the live matrix.
- [ ] Zero silent active-panel downgrades and zero fallback auto-submits.
- [ ] Zero post-publication Draft fallbacks or automatic resends.
- [ ] Zero duplicate `agentapi` calls for duplicate/restarted commands.
- [ ] Zero wrong-conversation abort calls from exact-routed messages.
- [ ] Zero accepted forged or binding-mismatched receipts.
- [ ] Zero prompts, attachment contents, tokens, or credentials in logs.
- [ ] Documentation explicitly states prompt argv and same-user trust limits.
- [ ] Sidecar disable/remove restores the pre-plan extension path without data
  migration or command replay.
- [ ] Both repositories pass all tests and compile/typecheck gates.
- [ ] Documentation matches verified commands and live file locations.

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Live acceptance is flaky because transcript persistence lags | False routing conclusion | Use unique markers and bounded observation window; routing receipt remains separate |
| Antigravity update changes `agentapi` behavior | Exact routing breaks after upgrade | Store version fingerprint; require probe before capability becomes live |
| Sidecar auto-restart replays processing command | Duplicate prompt | Persist processing/completed decision; ambiguous crash stays `unknown` |
| Removal damages unrelated Gemini config | User setup loss | Compare-and-replace config, backup, ownership manifest/hash checks |
| Acceptance matrix accidentally triggers active chat abort | Wrong user work stopped | Use disposable conversations and verify exact abort is rejected before live test |

## Rollback

1. Disable `sidecars.antifan-chat-router.enabled` through the owned removal flow.
2. Stop only the Antigravity-managed Sidecar instance and verify heartbeat stale.
3. Keep exact commands/results for diagnosis; do not replay `unknown` records.
4. For new prompts that have not published a Sidecar request, continue using
   Draft or explicit active-panel fallback through the unchanged extension bridge.
