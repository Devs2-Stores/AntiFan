---
phase: 4
title: "Dynamic Document Generation & Multi-Workspace Target Settle"
status: pending
priority: P1
effort: "2h"
dependencies: ["phase-01", "phase-02", "phase-03"]
---

# Phase 04: Dynamic Document Generation & Multi-Workspace Target Settle

## Overview
Hardens `NativeTabHost.isCurrentTarget()` and `ThemeQaWorkflow` to support multi-workspace target validation and prevent false `TARGET_STALE` errors during concurrent navigations. Ensures that document generation bumps, navigation reload lifecycle, and Theme QA diagnostic captures always bind to the specific workspace capsule associated with each tab.

## Requirements
- **Functional**:
  - Update `NativeTabHost.isCurrentTarget(target: BrowserTarget)` to accept targets belonging to any active workspace registered in `this.controlPlane.workspaces`.
  - Maintain per-tab `documentGenerations: Map<string, number>` tracking in `NativeTabHost` that increments strictly on navigation commit / `did-finish-load`.
  - Ensure `ThemeQaWorkflow.validateThemeQa()` captures artifacts and receipts scoped to the target tab's active workspace rather than defaulting to a single global root.
  - Enforce strict Electron session partitioning (`persist:capsule-${capsuleId}`) when tabs are spawned under different workspace capsules.
- **Non-Functional**:
  - Deterministic document generation tracking preventing stale diagnostics reads.
  - Complete cookie, localStorage, and token isolation between project capsules.

## Architecture
```
Tab Navigation Completed (tabId: "tab-2", URL: "https://hapas.vn/?themeid=...")
                              │
                              ▼
                NativeTabHost Event Listener
                              │
          1. documentGenerations.set("tab-2", currentGen + 1)
          2. Broadcast tab state update
                              │
                              ▼
                Capability Target Settle Check
  NativeTabHost.isCurrentTarget(target)
     ├── 1. Verify tab exists in this.tabs: YES
     ├── 2. Verify target.documentGeneration === this.getDocumentGeneration("tab-2"): YES
     ├── 3. Verify target.browserEpoch === lease.hostEpoch: YES
     └── 4. Verify target.workspaceId exists in controlPlane.workspaces: YES
          └── Result: VALID TARGET (No TARGET_STALE!)
```

## Related Code Files
- Modify: `src/main/browser/native-tab-host.ts` (Lines 4030-4055)
- Modify: `src/main/qa/theme-qa-workflow.ts` (Lines 40-120)
- Modify: `src/main/browser/browser-session-partition.ts` (Lines 10-60)

## Implementation Steps
1. **Update `NativeTabHost.isCurrentTarget()` in `src/main/browser/native-tab-host.ts`**:
   ```typescript
   public isCurrentTarget(target: BrowserTarget): boolean {
     if (!target || typeof target.tabId !== 'string' || !this.tabs.has(target.tabId)) return false;
     const currentGen = this.getDocumentGeneration(target.tabId);
     if (typeof target.documentGeneration !== 'number' || target.documentGeneration !== currentGen) return false;
     if (!this.controlPlane) return false;

     const lease = this.controlPlane.getLease();
     if (typeof target.browserEpoch !== 'number' || target.browserEpoch !== lease.hostEpoch) return false;
     if (typeof target.runtimeId !== 'string' || target.runtimeId !== lease.runtimeId) return false;

     // Fast-path equality OR dynamic registry membership check
     const projectMatches = target.projectId === lease.projectId || Boolean(this.controlPlane.workspaces.get(target.workspaceId, target.projectId));
     if (!projectMatches) return false;

     if (lease.workspaceId && target.workspaceId !== lease.workspaceId) {
       try {
         const ws = this.controlPlane.workspaces.get(target.workspaceId, target.projectId);
         if (!ws) return false;
       } catch {
         return false;
       }
     }
     return true;
   }
   ```
2. **Contextual Workspace Resolution in `src/main/qa/theme-qa-workflow.ts`**:
   Ensure `ThemeQaWorkflow` resolves the scanning root path dynamically from `input.target.workspaceId` via `this.controlPlane.workspaces.get()`.
3. **Audit Session Partitions in `src/main/browser/browser-session-partition.ts`**:
   Verify that `deriveCapsulePartition` correctly assigns `persist:capsule-${capsuleId}` and `persist:capsule-${capsuleId}-native` for all newly created tabs.

## Success Criteria
- [ ] Tab reload updates `documentGeneration` monotonically; subsequent tool calls with updated target succeed.
- [ ] `theme.qa_validate` executes on background tabs across different workspaces without throwing `WORKSPACE_MISMATCH` or `TARGET_STALE`.
- [ ] Authentication cookies in Capsule 1 (e.g. Haravan Admin) are inaccessible from Capsule 2 (e.g. Sapo Admin).

## Risk Assessment
- **Risk**: Race condition between rapid successive reloads and diagnostic extraction.
- **Mitigation**: `AsyncThemeQaQueue` enforces per-tab queue serialization keyed by `(tabId, generation)`.
