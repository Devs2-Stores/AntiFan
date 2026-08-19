---
phase: 3
title: "Consume Delivery Results In Desktop"
status: pending
priority: P0
effort: "8-12h"
dependencies: [1, 2]
---

# Phase 3: Consume Delivery Results in Desktop

## Overview

Replace Desktop's write-and-assume-success path with an exact-workspace command
client that consumes receipts and updates the originating message.

## Requirements

- Functional: mutation requires a confirmed existing workspace path.
- Functional: prompt and abort return a command ID and initial `queued` state.
- Functional: receipt updates the same user bubble to accepted/failed/unknown.
- Functional: timeout never auto-retries and remains manually recoverable.
- Compatibility: transcript continues to render chat content independently.

## Architecture

Split workspace discovery from mutation authority. Heuristics may propose a
workspace, but `handleSendPrompt` and abort require a confirmed binding. The
command client owns atomic publish, receipt polling, timeout, cleanup, and a
delivery-update event keyed by `messageId` and `commandId`.

## Related Code Files

- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/browser/native-tab-host.ts` - exact binding, command client, honest return values.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/antigravity-command-client.ts` - publish, consume, timeout, cleanup.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/transcript-syncer.ts` - retain raw `created_at`; do not own delivery state.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/shared/contracts.ts` - message delivery metadata and IPC event.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/renderer/sidebar.ts` - bubble status and manual recovery action.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/antigravity-command-client.test.ts` - receipt lifecycle tests.
- Create: `E:/Work/apps/antifan-browser-desktop/test/main/antigravity-delivery-ui-contract.test.ts` - static IPC/UI contract coverage.

## Implementation Steps

1. Add `resolveWorkspaceCandidate` and fail-closed `resolveMutationWorkspace`.
2. Stage all attachments under the exact target workspace before command write.
3. Publish v2 command, append the user message with `queued`, and return its IDs.
4. Consume only the matching result, persist a compact delivery summary, then
   delete the consumed result.
5. Emit a typed delivery update to Main/renderer and render concise status/error.
6. Route abort through the same command client and receipt rules.
7. Stop sequential queue advancement from relying solely on transcript mtime.

## Success Criteria

- [ ] No mutation path falls back to `E:\Work` or `process.cwd()`.
- [ ] Failure receipt is visible on the originating message within two seconds.
- [ ] Missing receipt becomes `unknown` and exposes manual retry without firing it.
- [ ] Draft and Auto display distinct truthful text.
- [ ] Desktop focused tests and typecheck pass.

## Risk Assessment

Risk: the current sidebar inserts the same user message in renderer and Main.
Mitigation: use one stable message ID returned by Main and make updates idempotent
so transcript refresh cannot create a second optimistic bubble.
