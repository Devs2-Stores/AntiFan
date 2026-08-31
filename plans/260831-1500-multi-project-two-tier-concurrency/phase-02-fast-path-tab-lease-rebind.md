---
phase: 2
title: "Hybrid Fast-Path Tab Lease Rebinding & Explicit TabId Routing"
status: pending
priority: P1
effort: "2h"
dependencies: ["phase-01"]
---

# Phase 02: Hybrid Fast-Path Tab Lease Rebinding & Explicit TabId Routing

## Overview
Permanently resolves `TARGET_MISMATCH` and `TARGET_STALE` errors during AI agent tab creation and multi-tab workflows. Removes the anti-rebinding trap (`if (!currentAuthTab || !isTabAlive(currentAuthTab))`) in `mcp-server.ts` and `bridge-server.ts`, and enables dynamic tab lease adoption when callers pass explicit, valid `tabId` parameters belonging to their active project/workspace.

## Requirements
- **Functional**:
  - Automatically update the session's attachment target tab in `AttachmentRegistry` and `authContext.browserTarget.tabId` when `anti.browser.tabs.create` or `browser.open-tab` succeeds.
  - Automatically update the session's attachment target tab when `anti.browser.tabs.activate` or `browser.switch-tab` succeeds.
  - When an explicit `callerTabId` is supplied on capability dispatch (e.g. `anti.screenshot.viewport`, `anti.inspect.dom`), verify tab existence in `tabHost`. If valid and within project scope, dynamically adopt the lease instead of throwing `TARGET_MISMATCH`.
  - Update `BrowserControlPort.resolveTargetTab()` to sample fresh `documentGeneration` and `browserEpoch` from `NativeTabHost`.
- **Non-Functional**:
  - Zero false-positive `TARGET_MISMATCH` rejections during standard agent tool call chains.
  - In-memory target re-stamping execution time $\le 0.2\text{ms}$.

## Architecture
```
Agent Tool Dispatch (Tool: anti.screenshot.viewport, explicit tabId: "tab-2")
                                   │
                                   ▼
                       mcp-server.ts / bridge-server.ts
                                   │
         Is explicit cleanCallerTab provided AND cleanCallerTab !== authContext.tabId?
                                   │
              ┌────────────────────┴────────────────────┐
              ▼ YES                                     ▼ NO
  Check: Does cleanCallerTab exist in tabHost?       Dispatch tool directly
              │
      ┌───────┴───────┐
      ▼ YES           ▼ NO
  1. Update Attachment:                              Reject with TARGET_MISMATCH
     attachmentRegistry.updateAttachmentTab(cleanCallerTab)
  2. Update Auth Context:
     authContext.browserTarget.tabId = cleanCallerTab
  3. Update NativeTabHost:
     tabHost.setAutomationTabId(cleanCallerTab)
  4. Dispatch tool with updated lease context!
```

## Related Code Files
- Modify: `src/main/mcp/mcp-server.ts` (Lines 480-548)
- Modify: `src/main/bridge/bridge-server.ts` (Lines 645-710)
- Modify: `src/main/tools/browser-control-port.ts` (Lines 250-315)
- Modify: `src/main/run/attachment-registry.ts` (Lines 150-180, 240-270)

## Implementation Steps
1. **Fix `src/main/mcp/mcp-server.ts`**:
   - In `callTool()`, replace the rigid check at lines 486–502 with dynamic tab adoption if `isTabAlive(cleanCallerTab)` is true.
   - In lines 521–528 (`anti.browser.tabs.create`), remove `if (!currentAuthTab || !isTabAlive(currentAuthTab))` so that `attachmentRegistry.updateAttachmentTab` and `authContext.browserTarget.tabId = result.data.tabId` occur unconditionally on tab creation success.
2. **Fix `src/main/bridge/bridge-server.ts`**:
   - Mirror the same dynamic tab adoption logic at lines 651–665.
   - Mirror the unconditional tab creation lease update at lines 682–690.
3. **Enhance `src/main/tools/browser-control-port.ts`**:
   - In `resolveTargetTab()`, when routing an `explicitTabId`, construct a fresh `currentTarget` stamped with the live `documentGeneration` from `this.host.getDocumentGeneration(resolved)` before calling `assertCurrent()`.
4. **Enhance `src/main/run/attachment-registry.ts`**:
   - Ensure `updateAttachmentTab(attachmentId, tabId, docGen)` atomically refreshes `record.tabId`, `record.browserTarget.tabId`, and `record.documentGeneration`.

## Success Criteria
- [ ] Scenario: Initial Tab 1 active $\rightarrow$ Agent calls `anti.browser.tabs.create` returning Tab 2 $\rightarrow$ Immediate call to `anti.screenshot.viewport({ tabId: "tab-2" })` succeeds without `TARGET_MISMATCH`.
- [ ] Scenario: Agent passes `callerTabId` of an existing background tab $\rightarrow$ Capability executes on the targeted tab with accurate document generation.
- [ ] Non-existent or alien tab IDs are rejected fail-closed with `TARGET_MISMATCH`.

## Risk Assessment
- **Risk**: Concurrent agents overwriting each other's attachment tab targets.
- **Mitigation**: `AttachmentRegistry` tracks targets keyed by unique `attachmentId` per session, preventing cross-session target mutation.
