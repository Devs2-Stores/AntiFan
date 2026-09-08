---
phase: 2
title: "Attachment-Scoped Target Authority"
status: pending
priority: P0
effort: "2d"
dependencies: [1]
---

# Phase 2: Attachment-Scoped Target Authority

## Overview

Replace global automation target and active-tab fallbacks with immutable attachment-scoped browser bindings, strict generation fencing, and deterministic agent-tab provisioning/cleanup.

## Requirements

- Functional: Each attachment owns one browser binding and only terminals it created; no attachment may operate a user terminal or another attachment's terminal.
- Functional: `startSession` reuses only a valid authorized target; otherwise it provisions `{ offscreen: true, ephemeral: true }` immediately.
- Functional: Agent Plane read, write, lifecycle, input, navigation, viewport, cookie, terminal, activation, and direct RPC paths resolve through attachment authority and fail closed.
- Non-functional: Independent sessions can operate concurrently without target clobbering; no view attachment or user tab switch during offscreen capture.

## Architecture

```ts
interface SessionBrowserBinding {
  attachmentId: string;
  tabId: string;
  paneId: 'desktop' | 'mobile';
  documentGeneration: number;
}
```

`AttachmentRegistry.ExecutionAttachmentRecord.browserTarget` is the canonical binding owner; do not add a second target map. Generic resolution is pure: it validates but never mutates global target state. Binding changes occur only through session creation or an explicit authorized rebind operation.

## Related Code Files

- Modify: `src/main/bridge/bridge-server.ts`
- Modify: `src/main/tools/browser-control-port.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/browser/tab-automation-host.ts`
- Modify: `src/main/browser/tab-devtools-host.ts` only where capture contract/tests require it
- Modify: `src/main/run/attachment-registry.ts`
- Modify: `src/main/browser/browser-action-registry.ts`
- Modify: `src/main/index.ts`
- Modify: attachment, capability, tab-host, bridge, capture, and stale-target tests under `test/main/`
- Delete: global target mutation from generic resolution and every Agent Plane `activeTabId` fallback

## Implementation Steps

1. Map every browser and terminal authority path, including direct Bridge RPC, cookie import, keyboard press, viewport, capture, navigation, tab activation, and terminal input/write.
2. Make `antifan.cli.startSession` resolve an authorized explicit target or provision a dedicated offscreen/ephemeral tab; never inspect `activeTabId` or reuse another attachment's automation target.
3. Persist the target binding in the canonical attachment/session authority record and bind the upgraded WebSocket to the returned attachment ID.
4. Remove `setAutomationTabId(resolved)` from `BrowserControlPort.resolveTargetTab()` and all equivalent global mutations. Migrate all callers before deleting obsolete authority methods.
5. Update `sendKeyboardPress` and every other Agent Plane action to resolve explicit/session target or return `TARGET_REQUIRED`; physical input must never default to foreground.
6. Authorize read, write, and lifecycle target access against attachment scope; explicit `tabId` never bypasses authorization. Terminal capabilities accept only attachment-owned terminal IDs. Remove active-tab/active-terminal fallback from Bridge direct RPC, cookie import, and terminal input.
7. Keep `browser.switch-tab`/`anti.browser.tabs.activate` names for compatibility but reject them from background agent attachments with `USER_VISIBLE_OPERATION_FORBIDDEN`; no semantic rebind. Any future rebind requires a separately authorized API outside this scope.
8. Restore document-generation comparison: never replace expected generation with live generation before `assertCurrent()`. Define read freshness separately from effectful write/lifecycle fencing.
9. Pass `tabId` into every `ViewportGate.withLock`; scope lock/poison state by target and call `releaseForTab(tabId)` during tab destruction.
10. Register deterministic attachment disposal hooks: socket close, revocation, lease expiry, and process death close only the owned agent tab and terminal resources.
11. Preserve offscreen capture: forward create options through every adapter, keep `backgroundThrottling: false` through later throttling passes, call `WebContents.capturePage()` directly, and never `switchTab`/attach the view.
12. Add concurrency, authorization, terminal authority, stale-generation, activation, missing/closed target, cleanup, direct-RPC, cookie, keyboard, and user-plane sentinel tests.
13. Run real Windows smoke with two sessions while a user sentinel remains active; verify target-correct non-black captures and zero focus/URL/generation change.

## Success Criteria

- [ ] Session A and B retain distinct browser bindings through interleaved operations.
- [ ] Explicit operations do not change another session's default target.
- [ ] No Agent Plane route references `activeTabId` as a fallback.
- [ ] Missing target returns `TARGET_REQUIRED`; closed bound target returns a typed closed/stale error.
- [ ] Explicit stale writes and lifecycle calls return `TARGET_STALE` before side effects.
- [ ] Offscreen screenshot is non-empty, belongs to the intended target, and leaves the user's tab untouched.
- [ ] Agent attempts to write a user or foreign terminal return `TERMINAL_FORBIDDEN` before input is emitted.
- [ ] Agent `anti.browser.tabs.activate` returns `USER_VISIBLE_OPERATION_FORBIDDEN` and does not change the visible tab.

<!-- Updated: Validation Session 1 - owned terminals only; agent tab activation rejected -->
- [ ] Attachment cleanup does not close or alter resources owned by another attachment.

## Risk Assessment

- **P2/P3 protocol gap:** removing fallbacks could break current MCP before proxy migration. Signal: successful `startSession` lacks a browser target. Response: make Phase 2 provisioning self-contained and require its integration test before Phase 3.
- **Windows black capture:** detached view may not paint. Signal: empty/black buffer or content hash equals the foreground sentinel. Response: verify `offscreen: true`, continuous background painting, and direct `capturePage()`; never restore foreground switching.
- **Over-global concurrency lock:** unrelated sessions block or poison each other. Signal: one stalled tab causes failures on another. Response: scope lock state by target if safety analysis permits; otherwise isolate poison/reset lifecycle per attachment.
