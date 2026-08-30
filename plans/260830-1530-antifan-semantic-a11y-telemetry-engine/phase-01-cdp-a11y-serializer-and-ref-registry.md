---
phase: 1
title: "CDP A11y Serializer & Ref Registry"
status: completed
priority: P1
effort: "4h"
dependencies: []
---

# Phase 1: CDP A11y Serializer & Ref Registry

## Overview
Implement the core Semantic Accessibility Tree extraction and token-pruning engine in AntiFan using Chromium DevTools Protocol (`Accessibility` domain), paired with an epoch-versioned `RefRegistry` that maps ephemeral ref IDs (`@e1`, `@e2`) to CDP `BackendNodeId` and `RemoteObjectId`.

## Requirements
- **Functional**:
  - Connect to active Electron webContents via CDP session and invoke `Accessibility.getFullAXTree`.
  - Filter out decorative, non-semantic DOM noise (`generic`, `none`, empty containers without accessible names or event listeners).
  - Spatial Viewport Pruning: prioritize in-viewport elements and auto-collapse deep unexpanded subtrees.
  - Sensitive Field Masking: automatically redact values of `input[type=password]`, `input[autocomplete*="cc-"]`, and token fields with `[REDACTED:length=N]`.
  - Generate YAML/AOM formatted output with interactive indicators: `[cursor=pointer]`, `[disabled]`, `[expanded]`, `[active]`, `[checked]`.
  - Compound Ref Fingerprinting: Maintain `RefRegistry` recording `BackendNodeId`, CSS selector path, and tag/role structural hash to detect DOM recycling.
  - Expose tool `anti.browser.snapshot` via MCP.
- **Non-Functional**:
  - Serialization overhead < 50ms for pages with <= 1,500 DOM elements.
  - Context token size capped at <= 1,500 tokens for full viewport.
## Architecture
```
CDP Target (webContents)
  └── Accessibility.getFullAXTree
        └── A11yTreePruner (Strip noise, extract roles/names/states)
              ├── RefRegistry.register(nodeId) -> "@e1", "@e2"
              └── Serializer -> YAML Output (Pruned, compact)
```

## Related Code Files
- Create/Update: `src/main/browser/a11y-snapshot.service.ts`
- Create/Update: `src/main/browser/ref-registry.ts`
- Create/Update: `src/mcp/handlers/browser-snapshot.handler.ts`

## Implementation Steps
1. Create `RefRegistry` class with tab-scoped LRU cache, epoch lifecycle, and compound fingerprinting (`BackendNodeId` + selector path + structural hash).
2. Implement `A11ySnapshotService` interfacing with CDP `Accessibility` and `DOM` domains.
3. Build recursive tree pruner, sensitive field masker, and YAML serializer formatting roles, labels, and ref tags.
4. Wire `anti.browser.snapshot` tool into AntiFan MCP router with viewport bounding box filters.
5. Add unit tests for A11y tree serialization, sensitive field redaction, and ref resolution.

## Success Criteria
- [X] `anti.browser.snapshot` returns clean YAML representation matching Playwright format.
- [X] Passwords, credit cards, and sensitive credentials masked 100% in snapshot tokens.
- [X] Compound refs resolve reliably or fail-closed on recycled nodes without blind misdirection.
- [X] Context size verified < 1,500 tokens on complex catalog/dashboard pages.

## Risk Assessment & Mitigations
- **Risk**: Deeply nested iframes in Haravan/Shopify Embedded apps have disconnected AX trees.
- **Mitigation**: Recursive iframe traversal via `Target.attachToTarget` with iframe-namespaced refs (`@i0:e4`) and accumulated frame matrix offsets.
