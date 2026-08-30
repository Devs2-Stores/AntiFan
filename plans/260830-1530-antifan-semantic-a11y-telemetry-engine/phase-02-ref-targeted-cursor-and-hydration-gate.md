---
phase: 2
title: "Ref-Targeted Cursor & Hydration Gate"
status: superseded
priority: P1
effort: "6h"
dependencies: ["phase-01-cdp-a11y-serializer-and-ref-registry"]
---

# Phase 2: Ref-Targeted Cursor & Hydration Gate

## Overview
Upgrade AntiFan's action execution pipeline (`anti.agent.cursor.click`, `type`, `hover`, `scroll`) to accept `{ ref: string }` natively with dual-mode dispatch (Visual Bézier animation vs Instant CDP events), backed by a `HydrationGuard` that prevents interactions during asynchronous DOM rendering or React hydration.

## Requirements
- **Functional**:
  - Accept `{ ref: "e1" }` (and pane-scoped `@d:e1`, `@m:e1`, iframe-scoped `@i0:e4`) across all `anti.agent.cursor.*` tools.
  - Attachment & Occlusion Gate: Atomic `DOM.describeNode` verification + `elementFromPoint` topmost hit-testing before dispatching clicks (detect floating banners/overlays).
  - Spatial Motion Settling: Ensure target node position is stable (delta pos <= 1px across consecutive frames) before dispatch.
  - Dual-mode execution:
    - `visual` mode: Smooth Bézier mouse glide (150ms) + highlight ping + native CDP `Input.dispatchMouseEvent`.
    - `instant` mode: Direct sub-45ms CDP dispatch for high-speed headless batch runs.
  - `HydrationGuard`: Runs in CDP Isolated World (`Page.createIsolatedWorld`); checks modern React 18/19 Fiber (`__reactContainer$*`, `__reactFiber$`), Vue 3, Alpine, and skeleton loaders with an adaptive 250ms activity ceiling (bypassing infinite animation/ticker deadlocks).
- **Non-Functional**:
  - All emitted events must be trusted native browser events (`isTrusted: true`).
  - Strict viewport clipping ([0,0] to [viewportWidth, viewportHeight]) preventing host Electron window accelerator escapes.
## Architecture
```
Tool Call: anti.agent.cursor.click({ ref: "e1" })
  ├── RefRegistry.resolve("e1") -> BackendNodeId
  ├── HydrationGuard.waitReady(nodeId)
  │     ├── Tier 1 (Isolated World): MutationObserver layout stillness (delta <= 1px) & elementFromPoint occlusion
  │     └── Tier 2 (Scoped Main-World Probe): Runtime.evaluate checking __reactContainer$* concurrent bits
  ├── CoordinatePipeline.getCenterQuad(nodeId) (Accumulates DPR, split offsets & iframe rects)
  └── Dispatcher
        ├── Mode == 'visual' -> Animate Cursor Canvas (150ms) -> CDP MouseEvent
        └── Mode == 'instant' -> Direct CDP Input.dispatchMouseEvent (<45ms)
```

## Related Code Files
- Create/Update: `src/main/browser/hydration-guard.service.ts`
- Create/Update: `src/main/browser/action-dispatcher.service.ts`
- Create/Update: `src/mcp/handlers/cursor-action.handler.ts`

## Implementation Steps
1. Implement `HydrationGuard` with two-tier boundary: Tier 1 (Isolated World for DOM mutations, layout stillness, and occlusion hit-test) and Tier 2 (Scoped Main-World CDP Probe via `Runtime.evaluate` for React 18/19 Fiber expando keys), enforcing 250ms activity ceiling with ticker-attribute exclusion.
2. Build `ActionDispatcher` with coordinate transform matrix handling Device Pixel Ratio, split-pane offsets, and accumulated iframe rect origins.
3. Add pre-dispatch `elementFromPoint` occlusion checks and target stillness validation (delta <= 1px).
4. Upgrade `anti.agent.cursor.*` handlers to support compound `ref` resolution and fail-closed error reporting on detached/stale nodes.

## Success Criteria
- [ ] Direct ref click completes in <45ms in instant mode and <250ms in visual mode.
- [ ] 100% of clicks trigger React 18/19 `SyntheticEvent` and native HTML form submit handlers.
- [ ] Zero 3,000ms deadlocks on pages with live marquee tickers, countdowns, or streaming updates.
- [ ] Stale or recycled refs fail-closed with actionable diagnostics instead of clicking incorrect product elements.

## Risk Assessment & Mitigations
- **Risk**: Ghost clicks or stale ref fallback hitting wrong products.
- **Mitigation**: Strict compound fingerprinting validation; if mismatch detected, reject with clear error prompting agent to take fresh snapshot.
