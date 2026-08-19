---
phase: 6
title: "Harness Run And Tool Timeline"
status: done
priority: P1
effort: "7d"
dependencies: [5]
---

# Phase 6: Harness Run And Tool Timeline

## Overview

Port the working chat/composer/provider interactions into a Codex-like Harness
dock, then extend them with durable run/tool timelines, questions, approvals,
mutation receipts, artifacts, retry/cancel, and replay. Chromium remains visible
beside or behind the dock.

## Existing Capability Migration Contract

- Existing: chat thread, streaming UI, composer, session/model/effort/skill
  controls, tool cards, stop actions, and current Harness utility tests.
- Reuse: Main-owned Harness controller/services, catalog sources, pure rendering
  helpers, and verified composer keyboard behavior.
- Required delta: committed event projection, atomic Turn submission, immutable
  artifact refs, replay/reconnect, exact binding, and explicit recovery states.
- Legacy removal condition: conversation/composer behavior parity and durable
  reload/replay tests pass without renderer-local authority.

## Requirements

- Render Main-owned ChatTurns and HarnessRun events; never rebuild history from
  renderer-local messages or stream flags.
- Composer sends one atomic Turn with text, provider profile, effort, and ordered
  immutable attachment refs.
- Timeline supports queued, running, awaiting model/tool/user, completed, failed,
  cancelled, interrupted, unknown mutation, stale browser, and reconcile-required.
- Tool events show scope, target, command summary, status, duration, output
  artifact, mutation receipt, and recoverable error without exposing secrets.
- Questions/approval cards require explicit user response and remain replayable.
- Retry creates a new attempt linked to the original; cancel/interrupt never
  pretends an accepted mutation was rolled back.
- Stream deltas are bounded and reconciled with snapshot/events-since after reload.
- Command/skill/agent/MCP chooser uses catalog data; it does not hardcode fake entries.
- Dock modes: right at wide sizes, overlay at narrow sizes; close returns focus to browser.

## Architecture

`ConversationPanel` composes durable turns and one or more `RunTimeline`s. The
store consumes `snapshot + eventsSince(cursor)` and treats Main's committed
sequence as truth. Transient model deltas render optimistically only until the
next committed event/snapshot.

An `ArtifactRef` opens through a bounded artifact metadata/preview operation.
Raw screenshots, DOM, command output, cookies, or base64 never live in renderer state.

## User Flows And States

- New prompt, queued run, streaming response, tool calls, completion.
- Model asks a question or tool requests approval.
- User cancels before dispatch, interrupts after accepted mutation, retries failure.
- Renderer reload during run; snapshot and events replay without duplicates.
- Provider unavailable, quota/auth failure, utility crash/recovery.
- Open tool output/artifact/context manifest.
- Insert `/`, `@`, MCP, agent, file, and browser evidence into composer.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/harness-contract.ts` | UI-safe run summaries, question/answer, attempt linkage | Schema/unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/harness-protocol.ts` | Bounded timeline/artifact preview envelopes | Protocol tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Run answer/interrupt/context/artifact/catalog operations | Static parity |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/harness/harness-controller.ts` | Snapshot/events/answer/retry/cancel UI handlers | Integration |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/projects/project-chat-service.ts` | Atomic Turn + attachment acceptance and summaries | Atomicity tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/index.ts` | Register typed run/artifact/catalog handlers | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/conversation-panel.tsx` | Harness dock container | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/conversation-thread.tsx` | Durable Turn rendering | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/run-timeline.tsx` | Run/event projection | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/tool-event-card.tsx` | Tool/receipt/output state | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/question-card.tsx` | Awaiting-user interaction | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/composer.tsx` | Atomic prompt/attachments/chooser | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/harness/artifact-preview.tsx` | Bounded artifact metadata/preview | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/test/renderer/run-timeline.test.ts` | Event reduction/replay/status faces | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/chat-turn-atomicity.test.ts` | New renderer submission and retry semantics | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/project-chat-reconnect.cjs` | Reload/replay/dedupe UI | Electron E2E |

## Implementation Steps

1. Define UI-safe snapshots/events and missing run operations: answer, interrupt,
   context manifest, artifact metadata/preview, and catalog lookup.
2. Implement conversation/thread/timeline reducers from committed sequences.
3. Build the composer with attachment tray, provider/effort selectors, chooser,
   exactly-once submit, stop, and keyboard behavior.
4. Render tool, receipt, lease, question, usage, error, and terminal run states.
5. Implement snapshot/replay on initial mount, reconnect, renderer reload, and gap detection.
6. Implement retry/answer/cancel/interrupt with explicit attempt/state semantics.
7. Add secret redaction, payload-budget, large-list virtualization, focus, and
   right-dock/overlay tests.

## Function And Interface Checklist

- [ ] `RunTimelineProjection.apply(event)` enforces run ID and monotonic sequence.
- [ ] `submitTurn()` carries one `clientRequestId` and ordered artifact refs.
- [ ] `answerQuestion()` targets exact Project/chat/run/question revision.
- [ ] `retryRun()` creates linked attempt and new idempotency keys.
- [ ] `ArtifactPreview` never receives raw credential/cookie/unbounded page bytes.
- [ ] Chooser entries come from real command/skill/MCP/agent catalogs.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Double Enter/click | One durable Turn and one accepted run |
| Critical | Reload after sequence gap | Snapshot + replay; no duplicate tool/assistant entries |
| Critical | Accepted mutation loses terminal result | `unknown/reconcile` state; retry disabled until resolved |
| High | Question answer with stale revision | Conflict and refresh; no misrouted answer |
| High | Large tool output | Artifact link/summary only; renderer payload stays bounded |
| Medium | Narrow window | Harness overlays; browser remains visible and focus returns correctly |

## Dependency Map

`Workspace-pinned chats -> run snapshots/events -> timeline/store -> composer/actions -> reconnect E2E`

## Success Criteria

- [ ] Conversations and runs survive reload/reconnect without duplicate UI state.
- [ ] Every run/tool/action visibly names its Project/Workspace/browser scope.
- [ ] Questions, retries, cancellation, interruption, unknown mutations, and recovery are explicit.
- [ ] Composer submits atomic Turns with ordered artifact refs.
- [ ] Harness remains a dock/overlay around Chromium, never the primary browser replacement.

## Risk Assessment

Run events may not yet expose enough committed data for rich rendering. If the UI
would infer durable state from delta text or local timing, extend Main snapshots
first. Do not add renderer-only authority. Rollback leaves all new components on
the isolated entry and preserves Main run data.


## Evidence (2026-08-18)

- e2e `test/e2e/project-harness-timeline.cjs` → `PROJECT_HARNESS_TIMELINE_OK` (53 checks) incl.: Main-side running face, live status envelopes to renderer, bounded model_delta commits (>=3), run_completed/run_accepted durability, reload replay single merged delta, question → answer → resume, cancel durable, fail → retry linked attempt (`retriesOriginalRunId`), artifact.metadata ± , 3 viewports (1920x1080 / 1280x800 / 960x700) with Chromium largest region (>=60% width, >=55% area).
- Regression: `project-home-flow.cjs`, `project-shell-layout.cjs`, `workspace-chat-navigation.cjs` all `_OK`.
- Gates: `npx tsc -p ./ --noEmit` + `tsconfig.renderer.json` clean; `npm test` 441/441 (was 423; +18: chat-turn-atomicity, run-timeline reducer).
- IPC parity audit: all 41 registered ops present in `PROJECT_CLIENT_OPS`; catalogue-only entries are P7-P10 forward contracts (terminal/annotation/auth/qa).
- Screenshots: `test/artifacts/phase-06/harness-{1920x1080,1280x800,960x700}.png`.
