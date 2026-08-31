---
phase: 4
title: "TabDevToolsHost Sub-Controller Extraction"
status: pending
priority: P1
effort: "1h"
dependencies: ["3"]
---

# Phase 4: TabDevToolsHost Sub-Controller Extraction

## Overview
Extracts in-page inspection overlays, measurement tools, and auxiliary developer utilities from `NativeTabHost.ts` (lines 3422–3528, lines 3718–3975, and lines 4331–4644, ~500 lines) into a modular `TabDevToolsHost` class. Covers `FontFinder`, `GPULens`, `Ruler`, `ElementInspector`, `AutoJsonViewer`, and `PageSourceViewer`.

## Requirements
- Functional:
  - Create `src/main/browser/tab-devtools-host.ts` encapsulating:
    - Font Finder tool (`toggleFontFinder`, `startFontFinder`, `stopFontFinder`).
    - GPU Lens overlay (`toggleLens`, `startLens`, `stopLens`).
    - Screen Ruler measurement (`toggleRuler`, `startRuler`, `stopRuler`).
    - Element Inspector (`toggleInspect`, `startInspect`, `stopInspect`, `isInspectActive`).
    - Find-in-page (`findInPage`, `stopFindInPage`).
    - DOM extraction (`getDom`, `evalJs`, `captureScreenshot`).
    - Auto JSON Viewer (`injectAutoJsonViewer`).
    - Page Source Viewer (`viewPageSource`, `fetchAndLoadPageSource`, `renderPageSourceSkeletonHtml`).
  - `NativeTabHost` delegates these methods to `TabDevToolsHost`.
- Non-functional:
  - Zero IPC contract drift (`TOOLBAR_CHANNELS.TOGGLE_INSPECT`, `TOGGLE_LENS`, `TOGGLE_RULER`, `TOGGLE_FONT_FINDER`).
  - Strict preservation of all test invariants.

## Architecture
```mermaid
classDiagram
    class NativeTabHost {
        -devToolsHost: TabDevToolsHost
        +toggleInspect()
        +toggleFontFinder()
        +toggleLens()
        +toggleRuler()
        +getDom(selector, tabId, paneId)
        +evalJs(expression, tabId, paneId)
        +captureScreenshot(rect, tabId, paneId)
        +viewPageSource(tabId)
    }

    class TabDevToolsHost {
        -context: TabDevToolsContext
        +startInspect()
        +stopInspect()
        +startLens()
        +stopLens()
        +startRuler()
        +stopRuler()
        +startFontFinder()
        +stopFontFinder()
        +getDom()
        +evalJs()
        +captureScreenshot()
    }

    interface TabDevToolsContext {
        +getTabWebContents(tabId, paneId)
        +getActiveTabId(): string
        +getTabList()
        +getTab(tabId)
        +sendToolbarIpc(channel, ...args)
    }

    NativeTabHost *-- TabDevToolsHost : delegates to
    TabDevToolsHost --> TabDevToolsContext : accesses tab webcontents
```

## Related Code Files
- Create: `src/main/browser/tab-devtools-host.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Verify Tests: `test/main/element-picker-resolution.test.ts`, `test/main/ipc-audit.test.ts`

## Implementation Steps
1. Define `TabDevToolsContext` interface in `src/main/browser/tab-devtools-host.ts`.
2. Implement `TabDevToolsHost` class with Font Finder, GPU Lens, Ruler, Element Inspector polling, Page Source fetching, and DOM/Eval utilities.
3. Instantiate `this.devToolsHost = new TabDevToolsHost(this.createDevToolsContext())` in `NativeTabHost`.
4. Delegate methods in `NativeTabHost` to `this.devToolsHost`.
5. Run `npm run typecheck` and verify inspector/overlay tests.

## Success Criteria
- [ ] `TabDevToolsHost` isolates all developer tool overlays and in-page scripts.
- [ ] `NativeTabHost.ts` is reduced by an additional ~500 lines (total reduction $\approx 1,000$ lines).
- [ ] Element picker, ruler, lens, and font finder functionality remain 100% operational.

## Risk Assessment
- Risk: In-page script polling timer (`inspectPollTimer`) lifecycle leak on window close.
- Mitigation: Provide an explicit `dispose()` method on `TabDevToolsHost` called during `NativeTabHost.dispose()`.
