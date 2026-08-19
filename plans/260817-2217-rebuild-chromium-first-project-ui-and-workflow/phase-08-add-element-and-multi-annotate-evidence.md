---
phase: 8
title: "Add Element And Multi Annotate Evidence"
status: done
priority: P1
effort: "8d"
dependencies: [4, 5, 6]
---

# Phase 8: Add Element And Multi Annotate Evidence

## Overview

Preserve the working Add Element To Chat and Multi Annotate selection behavior,
then rebind and extend it as a first-class browser-to-Harness workflow.
Selection happens in Chromium, evidence is Main-owned, and the composer receives
ordered immutable references.

## Existing Capability Migration Contract

- Existing: Quick Add, Multi Add, page overlay, element/font evidence capture,
  annotation comments, screenshot attachment, composer insertion, and cleanup.
- Reuse: inspector/capture services, proven page-selection behavior, semantic
  extraction, annotation prompt logic, and current workflow tests.
- Required delta: exact Project/tab/runtime/document binding, nonce handshake,
  immutable artifact refs, ordered Evidence Tray, stale/fidelity states, and
  atomic Turn submission.
- Legacy removal condition: existing selection UX remains behaviorally equivalent
  and navigation/spoofing/duplicate-listener tests pass.

## Requirements

- Add Element arms the exact active Project/tab/runtime/document, selects one
  node, captures evidence, and adds one attachment chip to the active chat.
- Multi Annotate queues multiple semantic anchors with comments; one session
  cannot silently continue across navigation or tab switch.
- Multi-tab collection is an explicit aggregate of separate per-tab sessions.
- Selection modes cover element, text, and region when supported; unsupported
  iframe/shadow/canvas/video boundaries show fidelity limitations.
- Capture DOM/computed CSS/a11y/runtime/geometry/viewport/URL and screenshot
  artifacts without raw bytes in renderer state.
- Arm-ready nonce and post-capture binding revalidation prevent page spoofing
  and navigation TOCTOU.
- Evidence tray preserves selection order, tab grouping, comment/image mapping,
  removal, preview, stale state, and atomic Turn submission.
- Component extractor uses selected evidence and real Workspace context; it does
  not claim a guaranteed DOM-to-source mapping.
- Cancel/Escape/navigation/crash always cleans overlays, debugger, and session state.

## Architecture

`AnnotationSessionService` owns session state. The renderer requests arm with an
exact `BrowserBinding`; Main injects/contacts the isolated inspector runtime with
a nonce, receives arm-ready for the same binding, captures via Main/CDP, persists
artifacts, then emits an evidence reference event.

The UI owns comments and ordering until atomic submit, but references only
Main-owned evidence handles. Multi-tab evidence is grouped by each captured binding.

## User Flows And States

- Quick Add one element and continue typing.
- Multi Annotate several elements on one document, reorder/remove, submit once.
- Add annotations from two tabs through explicit session switch/aggregate.
- Navigate or reload during selection; queue item becomes stale and cannot mutate.
- Unsupported cross-origin iframe/canvas/video evidence.
- Attach an image or capture alongside element evidence.
- Open component extractor and send findings to Harness.

## File Inventory

| Action | Absolute path | Purpose | Test impact |
|---|---|---|---|
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/shared/evidence-contract.ts` | Semantic anchors, UI summaries, stale/fidelity state | Schema/unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/page-preload.ts` | Narrow isolated annotation messaging | Security/integration |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/page/inspector-runtime.ts` | Nonce-bound element/text/region overlay and cleanup | Page tests/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/annotation/annotation-session-service.ts` | Exact-binding session lifecycle and aggregation | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/inspector/inspector-service.ts` | Arm-ready/revalidation and evidence extraction | Unit/integration |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/inspector/capture-service.ts` | Artifact-backed screenshots/crops | Capture tests |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/main/native-tab-host.ts` | Remove legacy page-global picker/comment ownership | Browser E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/preload/project-preload.ts` | Annotation/evidence operations and events | Static parity |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/evidence/evidence-toolbar.tsx` | Add/Multi mode and live scope | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/evidence/evidence-tray.tsx` | Ordered/grouped attachments and comments | Renderer/E2E |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/evidence/evidence-preview.tsx` | Bounded evidence metadata/fidelity preview | Renderer |
| Create | `E:/Work/apps/antigravity-browser-desktop/src/renderer/project-app/evidence/component-extractor.tsx` | Evidence-to-source investigation UI | Renderer/E2E |
| Modify | `E:/Work/apps/antigravity-browser-desktop/src/renderer/components/comment-composer.ts` | Reuse/move pure keyboard intent logic only | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/annotation-session.test.ts` | Nonce, stale binding, multi-tab aggregation | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/main/annotation-artifact-cleanup.test.ts` | Cancel/navigation/crash cleanup | Unit |
| Modify | `E:/Work/apps/antigravity-browser-desktop/test/e2e/annotation-workflow.cjs` | Full new Add/Multi UI | Electron E2E |

## Implementation Steps

1. Finalize semantic anchor and UI-safe evidence summary contracts.
2. Implement isolated-world nonce handshake and exact arm-ready binding checks.
3. Revalidate before capture, after capture, and before persistence/attachment.
4. Port Quick Add and Multi Annotate toolbar states while preserving browser
   overlay feedback and characterized selection behavior.
5. Extend the workflow with an evidence tray containing ordered refs, comments,
   grouping, preview, stale, and unsupported states.
6. Integrate image/file attachments and atomic composer submission.
7. Port component extraction to evidence + Workspace search without false certainty.
8. Remove legacy page-global picker/comment code only after new E2E passes.
9. Test navigation, crash, tab switch, multi-tab, unsupported boundary, cancel,
   duplicate submit, artifact cleanup, and privacy budgets.

## Function And Interface Checklist

- [x] `AnnotationSession` stores exact browser binding, nonce, mode, and lifecycle.
- [x] `armReady` matches Project/tab/runtime/document and nonce.
- [x] `EvidenceAttachmentSummary` contains refs/metadata only, never bytes.
- [x] `EvidenceTray` preserves insertion order and explicit per-tab grouping.
- [x] `submitTurn()` commits attachments before clearing tray.
- [x] Component extractor labels source mapping as inferred until verified.

## Test Scenario Matrix

| Priority | Scenario | Expected result |
|---|---|---|
| Critical | Navigation between arm and click | Session stale; capture discarded |
| Critical | Page forges annotation message | Invalid nonce/world/binding rejected |
| Critical | Switch tab in single-tab session | Session paused/failed; no implicit continuation |
| High | Multi-tab aggregate | Separate bound groups preserve order and tab identity |
| High | Duplicate submit/reload | One Turn with immutable refs; no orphaned accepted evidence |
| Medium | Canvas/cross-origin iframe | Unsupported/partial fidelity shown; no false DOM claim |

## Dependency Map

`Browser exact binding + Harness composer -> annotation session -> capture/artifacts -> evidence tray -> atomic Turn`

## Success Criteria

- [x] Add Element and Multi Annotate work end-to-end against real Chromium tabs.
- [x] Every attachment retains exact Project/tab/document lineage and fidelity.
- [x] Navigation/tab/crash spoofing and stale evidence fail closed.
- [x] Composer preserves ordered refs and clears only after durable acceptance.
- [x] Legacy picker/comment ownership is removed without duplicate overlays/listeners.

## Risk Assessment

Page overlays and CDP attachment are powerful trust boundaries. If isolated-world
origin/nonce validation cannot be proven, selection must remain disabled rather
than accept page-global events. Cross-origin/shadow/canvas fidelity must be
reported honestly. Rollback keeps the legacy picker active only while the new
renderer remains non-production; never enable both in one window.
