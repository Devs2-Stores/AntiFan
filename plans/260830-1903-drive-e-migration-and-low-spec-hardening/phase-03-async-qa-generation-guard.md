---
phase: 3
title: "Async QA Generation Guard & Race-Condition Defense"
status: complete
effort: "2h"
dependencies: ["2"]
---

# Phase 3: Async QA Generation Guard & Race-Condition Defense

## Overview
Eliminate race conditions during fast tab navigation and page reloads by establishing strict generation epoch guards, handling synthetic workflow reloads without self-aborting, isolating per-tab Theme QA state, and asserting post-await abort signals across all scanning stages. Ensure stale background validation tasks are terminated immediately and never publish results that overwrite fresh page status.

## Requirements
- **Functional:**
  * Enforce `checkAborted()` after every asynchronous `await` boundary in `ThemeQaWorkflow.validate()`.
  * Resolve Self-Aborting Workflow: When `ThemeQaWorkflow.validate()` calls `await this.ports.reload(input.target)` to achieve a clean DOM state, ensure the synthetic navigation either advances the active job's generation token or provides a fresh signal, preventing `checkAborted()` from tripping on its own reload.
  * Refactor `NativeTabHost.themeQaState` from a singleton property to a `Map<string, ThemeQaState>` keyed by `tabId`. Ensure async QA completion only broadcasts to the toolbar if the completed `tabId` matches the currently active `tabId`.
  * Verify document generation lock (`activeTarget.documentGeneration === this.ports.browser.getDocumentGeneration(activeTarget.tabId)`) before staging report artifacts.
  * In `AsyncThemeQaQueue`, silently discard `TARGET_STALE` errors and abort signals, ensuring zero error noise in console or renderer toolbar.
- **Non-functional:**
  * Zero stale report artifacts written to disk.
  * Zero UI flickering or outdated issue badge counts after rapid URL changes or tab switching.

## Architecture
```text
Navigation Event (Tab 1 -> URL A, Gen 1)
      │
      ├──> AsyncThemeQaQueue.enqueue(tabId="tab-1", gen=1)
      │      └──> ThemeQaWorkflow.validate(target={tabId: "tab-1", docGen: 1}, signal_1)
      │             ├──> reload() updates target.documentGeneration to Gen 1.1 (or post-reload Gen)
      │             │    and syncs with active AsyncQaJob.
      │             ├──> inspect() ──> [User navigates to URL B, Gen 2]
      │             │                     │
      │             │                     └──> AsyncThemeQaQueue.abort("tab-1")
      │             │                            └──> signal_1.abort()
      │             │
      │             └──> [inspect() resolves]
      │                    └──> if (signal_1.aborted) throw TARGET_STALE! (Terminated)
      │                         └──> NO regex scans, NO artifact writes, NO toolbar updates.
      │
      └──> AsyncThemeQaQueue.enqueue(tabId="tab-1", gen=2)
             └──> ThemeQaWorkflow.validate(target={tabId: "tab-1", docGen: 2}, signal_2)
                    └──> Completes cleanly and updates tabThemeQaState.set("tab-1", report).
                         If (activeTabId === "tab-1") -> broadcastState().
```

## Related Code Files
- **Modify:**
  * `src/main/qa/theme-qa-workflow.ts`
  * `src/main/qa/async-qa-job-queue.ts`
  * `src/main/browser/native-tab-host.ts`
  * `src/main/tools/browser-control-port.ts`
- **Create:**
  * `test/main/async-qa-generation-guard.test.ts`

## Implementation Steps
1. In `NativeTabHost` (`src/main/browser/native-tab-host.ts`):
   - Replace `private themeQaState: ThemeQaState` with `private tabThemeQaStates = new Map<string, ThemeQaState>()`.
   - Update `getThemeQaState(tabId)` to return the per-tab state from the map.
   - When a QA scan completes, update `this.tabThemeQaStates.set(tabId, state)` and only call `this.broadcastState()` if `tabId === this.activeTabId`.
   - In `switchTab(tabId)`, retrieve the tab's specific `ThemeQaState` and broadcast it.
2. In `ThemeQaWorkflow.validate` (`src/main/qa/theme-qa-workflow.ts`):
   - Define `checkAborted()`:
     ```ts
     const checkAborted = () => {
       if (input.signal?.aborted) {
         throw new CapabilityError('TARGET_STALE', 'Theme QA validation was aborted by document navigation');
       }
       const currentGen = this.ports.browser.getDocumentGeneration?.(activeTarget.tabId);
       if (typeof currentGen === 'number' && activeTarget.documentGeneration && currentGen !== activeTarget.documentGeneration) {
         throw new CapabilityError('TARGET_STALE', `Document generation advanced from ${activeTarget.documentGeneration} to ${currentGen}`);
       }
     };
     ```
   - When `this.ports.reload(input.target)` runs, capture the returned reloaded target (with updated `documentGeneration`) and update `activeTarget.documentGeneration` before continuing to `checkAborted()`.
   - Call `checkAborted()` after `reload()`, `inspect()`, each scanner `eval()`, `responsiveCheck()`, and before `stage()`.
3. In `AsyncThemeQaQueue` (`src/main/qa/async-qa-job-queue.ts`):
   - Cleanly catch `TARGET_STALE` and aborted signal exceptions, silencing noise.
4. Create `test/main/async-qa-generation-guard.test.ts` asserting:
   - Self-reload does not abort validation.
   - External user navigation immediately aborts in-flight scans.
   - Tab switching isolates QA issue counts on the toolbar.

## Success Criteria
- [x] Self-reload during Theme QA completes successfully without triggering false self-abort.
- [x] 10 consecutive rapid navigations on a single tab result in 9 clean aborts and 1 final report.
- [x] Switching between Tab A (5 errors) and Tab B (0 errors) displays correct isolated issue counts on the toolbar without cross-talk.
- [x] 100% of test cases pass in `test/main/async-qa-generation-guard.test.ts`.
## Risk Assessment
- **Risk:** Uncaught abort errors triggering unhandled promise rejections.  
  *Mitigation:* Explicit catch blocks in `AsyncThemeQaQueue` and `ThemeQaWorkflow` filter `TARGET_STALE` errors and aborted signals cleanly.
