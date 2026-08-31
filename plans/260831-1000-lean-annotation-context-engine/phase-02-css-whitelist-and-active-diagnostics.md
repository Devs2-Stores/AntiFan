---
phase: 2
title: "CSS Whitelist & Correlated Diagnostics Engine"
status: pending
priority: P1
effort: "1.5h"
dependencies: ["phase-1"]
---

# Phase 2: CSS Whitelist & Correlated Diagnostics Engine

## Overview
Refactor `src/main/bridge/annotation-manager.ts` and `src/main/browser/native-tab-host.ts` to implement a 25-property Active CSS Whitelist and automatically ingest relevant runtime console/network errors into the generated Markdown.

## Requirements
- Filter incoming `computedStyles` to only keep layout, typography, color, spacing, and transform properties.
- Ingest `runtimeErrors` (JavaScript unhandled exceptions) and `resourceFailures` (404/500 asset loads) from the active tab's `TabDiagnostics` buffer.
- Suppress completely empty JSON blocks (`interactionState: {}`, `accessibilitySnapshot: {}`, `resourceFailures: []`) to keep the markdown dense and high-signal.

## Architecture
```
[DOM Element / TabDiagnostics]
          │
          ▼
[AnnotationManager.processAnnotationPayload]
  ├── Filter computedStyles with ACTIVE_CSS_PROPERTIES whitelist
  ├── Check tab's TabDiagnostics for active errors/failures
  ├── Format Markdown: Only emit sections with actual data
  └── Write .antifan/annotations/element_<timestamp>.md
```

## Related Code Files
- Modify: `src/main/bridge/annotation-manager.ts`
- Modify: `src/main/browser/native-tab-host.ts`

## Implementation Steps
1. Define `ACTIVE_CSS_PROPERTIES` in `annotation-manager.ts`:
   - Layout: `display`, `flex-direction`, `justify-content`, `align-items`, `gap`, `grid-template-columns`, `position`, `z-index`, `overflow`, `box-sizing`
   - Spacing & Sizing: `width`, `max-width`, `min-width`, `height`, `max-height`, `min-height`, `padding`, `margin`
   - Visual & Typography: `color`, `background-color`, `font-size`, `font-weight`, `font-family`, `line-height`, `text-align`, `border`, `border-radius`, `opacity`, `transform`
2. Update `AnnotationPayload` to accept `runtimeErrors` and `resourceFailures` passed from `NativeTabHost`.
3. In `NativeTabHost.startInspect()`, wire `TabDiagnostics` to attach recent errors (within last 30s) to the annotation payload.
4. Render `## ⚠️ Correlated Diagnostics` only when errors exist.

## Success Criteria
- [ ] Computed styles block contains <= 25 high-value lines instead of 60 noisy properties.
- [ ] Failed network requests and JS errors appear in the markdown when present.
- [ ] Empty JSON blocks are omitted entirely from the markdown output.

## Risk Assessment
- **Risk:** Dropping a CSS property that a user specifically wanted to tweak (e.g. `cursor`, `pointer-events`).
- **Mitigation:** Ensure whitelist covers all core visual properties, and keep `outerHTML` intact so inline styles are preserved.
