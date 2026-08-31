---
phase: 3
title: "TabAutomationHost Sub-Controller Extraction"
status: pending
priority: P1
effort: "1h30m"
dependencies: ["1", "2"]
---

# Phase 3: TabAutomationHost Sub-Controller Extraction

## Overview
Extracts the Agent Visual Cursor and Action Dispatch domain from `NativeTabHost.ts` (lines 3529–3717 and lines 4829–4975, ~450 lines of complex agent kinematics and isolated world execution) into a standalone, dedicated `TabAutomationHost` class. `NativeTabHost` acts as a thin facade delegating to `TabAutomationHost`, preserving 100% public API compatibility and zero IPC signature drift.

## Requirements
- Functional:
  - Create `src/main/browser/tab-automation-host.ts` encapsulating:
    - `ensureAgentBrowserInjected(tabId?, paneId?)`
    - `executeInIsolatedWorld(wc, script)`
    - `dispatchAgentAction(action, params)`
    - `agentClick(params)`
    - `agentType(params)`
    - `agentScroll(params)`
    - `agentHover(params)`
    - `agentHighlight(params)`
    - `agentClear(tabId?, paneId?)`
    - `agentTrajectory(params)`
    - `agentSnapshot(tabId?, paneId?)`
    - `activateAgentVisualGlow(tabId)` / `deactivateAgentVisualGlow(tabId)`
    - `markTabAgentWorking(tabId?, durationMs?)` / `clearAllAgentWorking()`
  - `NativeTabHost` delegates all these methods directly to `TabAutomationHost`.
- Non-functional:
  - Zero breaking changes to `NativeTabHost` public API (external consumers like `BrowserControlPort`, `BrowserActionRegistry`, and tests continue calling `host.agentClick(...)` unchanged).
  - Clean separation of concerns with strong TypeScript typing.

## Architecture
```mermaid
classDiagram
    class NativeTabHost {
        -automationHost: TabAutomationHost
        +agentClick(params)
        +agentType(params)
        +agentScroll(params)
        +agentHover(params)
        +agentSnapshot(tabId, paneId)
        +agentTrajectory(params)
        +agentClear(tabId, paneId)
    }

    class TabAutomationHost {
        -context: TabAutomationContext
        +dispatchAgentAction(action, params)
        +agentSnapshot(tabId, paneId)
        +agentTrajectory(params)
        +executeInIsolatedWorld(wc, script)
    }

    interface TabAutomationContext {
        +getTabWebContents(tabId, paneId)
        +runTargetOperation(tabId, paneId, op)
        +getBrowserEpoch()
        +getSemanticDocumentGeneration(tabId, paneId)
        +semanticRefRegistry: SemanticRefRegistry
        +automationTabId: string
        +activeTabId: string
        +getTab(tabId)
    }

    NativeTabHost *-- TabAutomationHost : delegates to
    TabAutomationHost --> TabAutomationContext : queries host state
```

## Related Code Files
- Create: `src/main/browser/tab-automation-host.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Verify Tests: `test/main/guarded-action-dispatch.test.ts`, `test/integration/semantic-ref-integration.test.ts`, `test/main/action-registry.test.ts`

## Implementation Steps
1. Define `TabAutomationContext` interface in `src/main/browser/tab-automation-host.ts`.
2. Implement `TabAutomationHost` with all agent action routing, isolated world execution, trajectory execution, visual glow, and snapshot generation.
3. Instantiate `this.automationHost = new TabAutomationHost(this.createAutomationContext())` in `NativeTabHost` constructor.
4. Replace internal implementations of agent methods in `NativeTabHost` with direct delegation: `return this.automationHost.agentClick(params)`.
5. Run `npm run typecheck` and verify agent action test suites.

## Success Criteria
- [ ] `TabAutomationHost` cleanly isolates all 12+ agent automation methods.
- [ ] `NativeTabHost.ts` is reduced by ~450 lines.
- [ ] All 13 isolated executor tests in `guarded-action-dispatch.test.ts` and all semantic ref tests pass without modification.

## Risk Assessment
- Risk: Context binding issues (e.g. `this` reference inside asynchronous closures).
- Mitigation: Pass explicit context callback object (`TabAutomationContext`) to `TabAutomationHost` rather than passing raw `this`.
