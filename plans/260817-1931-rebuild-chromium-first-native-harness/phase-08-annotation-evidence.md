---
title: "Phase 8: Add Element And Multi Annotate Evidence Workflows"
status: done
---

# Phase 8: Add Element And Multi Annotate Evidence Workflows

## Overview

Replace the ephemeral Quick Add/Multi Add path with durable, ordered,
Project-scoped evidence. Connect the existing typed inspector/capture/node
reference primitives to Turn creation and Harness context assembly.

## Requirements

- Selection starts from an exact Project/browser/tab/document binding.
- One annotation session binds to one tab/document. Navigation, tab close, tab
  switch, browser epoch change, or Project window mismatch makes it stale.
- Multi Annotate retains every selection in order; no last-element overwrite.
- Multi-tab collection is explicit aggregation of separate tab-bound sessions.
- Escape/cancel is terminal and removes page listeners/overlays exactly once.
- Page selection uses an isolated-world/session-nonce channel with an arm-ready
  acknowledgement; page globals cannot forge authoritative evidence.
- Captures are Project artifacts with hash, dimensions, DPR, zoom, viewport,
  byte size, MIME, retention, and privacy classification.
- Internal evidence capture does not copy to clipboard or Downloads.
- Renderer receives attachment metadata/IDs, not `Uint8Array` or base64.
- Evidence URL and attachment references survive atomic Turn submission.

## File Inventory

| Action | Path | Purpose |
|--------|------|---------|
| Modify | `src/shared/evidence-contract.ts` | SelectionEvidence, AnnotationSession/Set, EvidenceBundle, CaptureRef |
| Modify | `src/main/inspector/inspector-service.ts` | Project/tab/document-bound lifecycle and cancellation |
| Modify | `src/main/inspector/capture-service.ts` | Project ArtifactStore output and capture budgets |
| Modify | `src/main/mcp/node-reference-store.ts` | Reusable generation-bound opaque node refs |
| Modify | `src/page/inspector-runtime.ts` | Typed page protocol and deterministic teardown |
| Modify | `src/main/browser/scripts/pick-element.ts` | Remove or reduce to inspector runtime bootstrap |
| Modify | `src/main/native-tab-host.ts` | Replace `window.__agbPick` and mixed capture side effects |
| Modify | `src/main/annotation-prompt.ts` | Evidence-to-context rendering from durable refs |
| Modify | `src/renderer/app.ts` | Ordered attachment state, stale UI, no raw image bytes |
| Modify | `src/renderer/components/comment-composer.ts` | Evidence attachment list and atomic submit |
| Add | `test/main/annotation-session.test.ts` | lifecycle, stale, cancellation, ordering, and teardown tests |
| Modify | `test/main/inspector-workflow.test.ts` | Project binding and artifact assertions |
| Modify | `test/main/annotation-artifact-cleanup.test.ts` | Project quotas and retention |
| Modify | `test/e2e/annotation-workflow.cjs` | Add Element and Multi Annotate end-to-end evidence flow |

## Implementation Steps

1. Define annotation session and ordered selection states, including explicit
   start, selection, pause/stale, cancel, complete, and artifact failure.
2. Arm inspector from sender-owned ProjectRuntime using an isolated-world nonce,
   then require an arm-ready acknowledgement carrying the current Project/browser/
   tab/runtime-instance/document binding.
3. Replace page-global polling with a versioned typed message lifecycle and one
   deterministic listener/overlay teardown path. Revalidate the binding before
   selection, before/after capture, and before artifact persistence.
4. For every selection, resolve semantic/selector/DOM/accessibility evidence,
   create opaque node reference, capture target/viewport artifacts, and persist
   one immutable `SelectionEvidence`.
5. Enforce count, total-byte, per-capture pixel, DOM text, and duration budgets;
   return explicit bounded failure or controlled downscale.
6. Aggregate selections into an ordered `AnnotationSet`. To move to another tab,
   close/pause the current session and start a new explicit session whose evidence
   can join the same higher-level EvidenceBundle.
7. Create Turn plus evidence references atomically. Only clear composer after
   durable acceptance; ContextAssembler loads references by ownership/hash.
8. Separate user export/copy capture commands from internal Harness evidence.

## Failure Matrix

| Event | Required result |
|-------|-----------------|
| Navigation during selection | Session stale; no evidence emitted from old document |
| Navigation between arm/injection/ready | Nonce/session discarded before selection |
| Switch/close tab during capture | No fallback to active tab; explicit stale/closed error |
| Project window switch/focus | No effect on bound session |
| Escape/cancel | Immediate terminal cancellation and one teardown |
| Re-arm after cancel | One listener set; no duplicate selection |
| Budget exceeded | Explicit bounded error/downscale, never unbounded IPC |
| Turn submit retry | Same accepted Turn/attachments, no duplicate evidence |

## Validation

- Multi Annotate with several elements preserves complete ordered evidence.
- Chat/model context includes URL, semantic evidence, and artifact handles for all
  selected elements, not only the last one.
- DOM listener static scan and runtime assertions prove no duplicate picker
  handlers or stale overlays.
- Hostile page writes to globals/messages cannot forge a valid nonce, node
  reference, target binding, or persisted evidence artifact.
- Project A evidence cannot be attached to or read by Project B.
- Diagnostics redact page bodies and sensitive values by default.

## Success Criteria

Add Element and Multi Annotate become deterministic first-class Harness inputs,
survive chat/restart boundaries, and remain safe under tab/navigation races.

## Risks And Rollback

Remote pages are hostile and can mutate during inspection. Treat page evidence as
untrusted bounded data, preserve origin/generation metadata, and fail stale rather
than attempting heuristic recovery.
