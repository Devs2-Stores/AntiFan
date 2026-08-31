---
phase: 3
title: "Two-Tier Concurrency Engine, Global ViewportGate & Passive Backpressure Pool"
status: pending
priority: P1
effort: "3h"
dependencies: ["phase-02"]
---

# Phase 03: Two-Tier Concurrency Engine, Global ViewportGate & Passive Backpressure Pool

## Overview
Decouples passive inspection operations (DOM extraction, element/viewport screenshot, eval JS, console collection, and Theme QA validation) from interactive visual cursor actions (click, hover trajectory, typing, drag, scroll).

Addresses two critical real-world concurrency failure modes with exact, grounded provenance mechanics:
1. **Micro-Scoped Input Provenance & Human-Preemption**:
   - `agentInputInFlight: number` is scoped **strictly around individual synchronous synthetic dispatch calls** (`webContents.sendInputEvent()`, CDP `Input.dispatchKeyEvent`) that fire Electron input events—**never** around the lock wait, sleep delays, animation loops, or overall action lifetime.
   - Between Bézier animation steps and sleep ticks, `agentInputInFlight === 0`. If physical user keyboard input arrives on any tab's `WebContentsView.webContents` during an active agent drag/animation, `before-input-event` detects `agentInputInFlight === 0` and immediately aborts the active lock holder via its `AbortController` (`PREEMPTED_BY_USER`).
   - `activeAbortController` is assigned **strictly after lock acquisition**, preventing queued waiting callers from clobbering the active lock holder's controller.
2. **Tier-1 Passive Backpressure & Concurrency Pool (`PassiveExecutionPool`)**:
   - Protects Chromium renderer processes from zombie agent denial-of-service by enforcing bounded concurrent background operations per tab (max 4 concurrent per tab, max 16 global) with fast fail-closed rejection (`CAPABILITY_OVERLOADED`).
3. **Global Viewport Mutex (`ViewportGate`)**:
   - Enforces strict FIFO serialization for interactive agent actions across the single shared window, bounded $10,000\text{ms}$ execution deadlines, and automatic cleanup on tab disposal.

## Requirements
- **Functional**:
  - **Micro-Scoped Provenance (`withAgentInputInFlight`)**: Wrap ONLY the immediate synchronous `webContents.sendInputEvent()` or CDP call. In-between animation steps, the counter is $0$.
  - **Safe Controller Assignment**: In `ViewportGate.withLock()`, assign `this.activeAbortController = controller` **strictly after** `await this.acquire()` resolves so queued callers never overwrite the active lock holder.
  - **Per-Tab Keyboard Preemption**: In `NativeTabHost.setupTabWebContentsEvents()`, attach `before-input-event` on `wc`. If `agentInputInFlight === 0`, call `viewportGate.preemptActiveAgent()`. Remove listener upon tab closure.
  - **Passive Concurrency Throttle (`PassiveExecutionPool`)**: Bound concurrent background WebContents operations to max 4 per tab and max 16 global. Excess requests fail-closed with `CapabilityError('CAPABILITY_OVERLOADED')`.
  - **Global Window/Viewport Mutex (`ViewportGate`)**: Ensure only one interactive visual action controls the physical GUI viewport at any given moment across all tabs and sessions.
  - Apply an end-to-end execution deadline ($10,000\text{ms}$) spanning both lock acquisition and action execution using an `AbortController`.
  - Provide explicit tab disposal cleanup (`cleanupTab(tabId)`) to cancel queued actions when tabs are closed.
- **Non-Functional**:
  - Passive operations must not alter `mainWindow.contentView` or call `switchTab()`.
  - Mutex acquisition overhead $< 0.05\text{ms}$ when uncontented.
  - Zero lock leaks under uncaught exceptions, network hangs, or tab closure.

## Architecture
```
                                Incoming Capability Request
                                            │
                                ┌───────────┴───────────┐
                                ▼                       ▼
                 Tier 1: Passive Background     Tier 2: Interactive Visual
              (inspect, screenshot, eval, qa)      (cursor.click, type, hover)
                                │                       │
                                ▼                       ▼
                   PassiveExecutionPool Throttling   Acquire Global ViewportGate Mutex
                   (Max 4/tab, Max 16 global)       (Shared Single Window Viewport)
                                │                       │
                                │                       ▼ (Lock Acquired!)
                                │             Set this.activeAbortController = controller
                                │                       │
                                │                       ├── Physical Keypress (agentInputInFlight === 0)?
                                │                       │   └──> activeAbortController.abort('PREEMPTED_BY_USER')
                                │                       │
                                ▼                       ▼
                 Direct WebContents Action     Micro-Scoped Synthetic Input Steps:
              • webContents.capturePage()     • Loop Bézier steps (agentInputInFlight = 0 between steps)
              • executeInIsolatedWorld(1004)  • withAgentInputInFlight(() => sendInputEvent())
              • CDP snapshot capture          • Check signal.aborted -> Exit immediately
                                │                       │
                                │                       ▼
                                │             Release Global ViewportGate Mutex (in finally)
                                └───────────┬───────────┘
                                            ▼
                                     Return Result
```

## Related Code Files
- Modify: `src/main/tools/browser-control-port.ts` (Lines 1-50, 100-240)
- Modify: `src/main/browser/native-tab-host.ts` (Lines 2095-2170, 2400-2600, 3830-3900)
- Modify: `src/main/browser/tab-automation-host.ts` (Lines 40-150, Bézier trajectory loops)
- Create: `test/unit/tools/viewport-gate.test.ts`
- Create: `test/unit/tools/passive-execution-pool.test.ts`

## Implementation Steps
1. **Implement `PassiveExecutionPool` in `src/main/tools/browser-control-port.ts`**:
   ```typescript
   export class PassiveExecutionPool {
     private tabActiveCounts = new Map<string, number>();
     private globalActiveCount = 0;
     private readonly MAX_PER_TAB = 4;
     private readonly MAX_GLOBAL = 16;

     async execute<T>(tabId: string, action: () => Promise<T>): Promise<T> {
       const tabCount = this.tabActiveCounts.get(tabId) || 0;
       if (tabCount >= this.MAX_PER_TAB || this.globalActiveCount >= this.MAX_GLOBAL) {
         throw new CapabilityError('CAPABILITY_OVERLOADED', `Concurrency limit exceeded for background operations on tab ${tabId}`);
       }

       this.tabActiveCounts.set(tabId, tabCount + 1);
       this.globalActiveCount++;
       try {
         return await action();
       } finally {
         const updated = (this.tabActiveCounts.get(tabId) || 1) - 1;
         if (updated <= 0) this.tabActiveCounts.delete(tabId);
         else this.tabActiveCounts.set(tabId, updated);
         this.globalActiveCount = Math.max(0, this.globalActiveCount - 1);
       }
     }
   }
   ```
2. **Implement Hardened `ViewportGate` with Post-Acquire Controller Assignment**:
   ```typescript
   export class ViewportGate {
     private isLocked = false;
     private activeAbortController: AbortController | null = null;
     private queue: Array<{
       tabId?: string;
       resolve: (release: () => void) => void;
       reject: (err: Error) => void;
       timer: NodeJS.Timeout;
     }> = [];

     /**
      * Triggered when physical human user input (keyboard or mouse) is detected.
      */
     public preemptActiveAgent(reason = 'Physical human user input preempted agent action'): void {
       if (this.activeAbortController) {
         this.activeAbortController.abort(new CapabilityError('PREEMPTED_BY_USER', reason));
       }
     }

     async withLock<T>(
       action: (signal: AbortSignal) => Promise<T>,
       options: ViewportLockOptions = {}
     ): Promise<T> {
       const timeoutMs = options.timeoutMs ?? 10_000;
       const controller = new AbortController();

       if (options.signal) {
         options.signal.addEventListener('abort', () => controller.abort(options.signal?.reason), { once: true });
       }

       // 1. Acquire Lock (Queued FIFO)
       const release = await this.acquire(options.tabId, timeoutMs, controller.signal);

       // 2. CRITICAL: Assign activeAbortController ONLY AFTER lock is acquired!
       this.activeAbortController = controller;

       let executionTimer: NodeJS.Timeout | null = null;
       const executionDeadline = new Promise<never>((_, reject) => {
         executionTimer = setTimeout(() => {
           controller.abort(new CapabilityError('LEASE_EXPIRED', `Viewport action execution exceeded ${timeoutMs}ms deadline`));
           reject(new CapabilityError('LEASE_EXPIRED', `Viewport action execution exceeded ${timeoutMs}ms deadline`));
         }, timeoutMs);
       });

       try {
         const result = await Promise.race([
           action(controller.signal),
           executionDeadline
         ]);
         return result;
       } finally {
         if (executionTimer) clearTimeout(executionTimer);
         this.activeAbortController = null;
         release();
       }
     }

     private acquire(tabId: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<() => void> {
       if (signal?.aborted) {
         return Promise.reject(new CapabilityError('TARGET_STALE', 'Viewport action aborted before lock acquisition'));
       }

       if (!this.isLocked) {
         this.isLocked = true;
         return Promise.resolve(() => this.releaseNext());
       }

       return new Promise<() => void>((resolve, reject) => {
         let timer: NodeJS.Timeout;

         const onAbort = () => {
           clearTimeout(timer);
           this.removeFromQueue(entry);
           reject(new CapabilityError('TARGET_STALE', 'Viewport lock acquisition aborted'));
         };

         const onTimeout = () => {
           if (signal) signal.removeEventListener('abort', onAbort);
           this.removeFromQueue(entry);
           reject(new CapabilityError('LEASE_EXPIRED', `Viewport lock acquisition timeout after ${timeoutMs}ms`));
         };

         timer = setTimeout(onTimeout, timeoutMs);

         const entry = {
           tabId,
           resolve: (releaseFn: () => void) => {
             clearTimeout(timer);
             if (signal) signal.removeEventListener('abort', onAbort);
             resolve(releaseFn);
           },
           reject: (err: Error) => {
             clearTimeout(timer);
             if (signal) signal.removeEventListener('abort', onAbort);
             reject(err);
           },
           timer
         };

         if (signal) signal.addEventListener('abort', onAbort, { once: true });
         this.queue.push(entry);
       });
     }

     private releaseNext(): void {
       if (this.queue.length > 0) {
         const next = this.queue.shift()!;
         next.resolve(() => this.releaseNext());
       } else {
         this.isLocked = false;
       }
     }

     private removeFromQueue(entry: typeof this.queue[number]): void {
       const index = this.queue.indexOf(entry);
       if (index !== -1) {
         this.queue.splice(index, 1);
       }
     }

     public cleanupTab(tabId: string): void {
       const toCancel = this.queue.filter(item => item.tabId === tabId);
       for (const entry of toCancel) {
         this.removeFromQueue(entry);
         entry.reject(new CapabilityError('TARGET_STALE', `Target tab '${tabId}' was closed while awaiting viewport lock`));
       }
     }
   }
   ```
3. **Micro-Scoped Input Provenance in `NativeTabHost` & `TabAutomationHost`**:
   - In `NativeTabHost`:
     ```typescript
     public agentInputInFlight = 0;

     public syncWithAgentInput<T>(action: () => T): T {
       this.agentInputInFlight++;
       try {
         return action();
       } finally {
         this.agentInputInFlight = Math.max(0, this.agentInputInFlight - 1);
       }
     }
     ```
   - In `TabAutomationHost` input dispatchers (e.g. `dispatchSyntheticClick`, `dispatchSyntheticKey`, Bézier curve step dispatch):
     ```typescript
     // Micro-scoped: ONLY around the exact synchronous sendInputEvent call!
     this.ctx.syncWithAgentInput(() => {
       wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
     });
     ```
   - In `NativeTabHost.setupTabWebContentsEvents(id, view, state, paneId)`:
     ```typescript
     const onBeforeInput = (event: Electron.Event, input: Electron.Input) => {
       // If agent is NOT in the middle of sending a synthetic event right this instant:
       if (this.agentInputInFlight === 0) {
         this.controlPort?.viewportGate.preemptActiveAgent('Manual keyboard input detected on tab');
       }
     };
     wc.on('before-input-event', onBeforeInput);
     wc.once('destroyed', () => {
       wc.removeListener('before-input-event', onBeforeInput);
     });
     ```
   - In `NativeTabHost.closeTab(tabId)`: call `this.controlPort?.viewportGate.cleanupTab(tabId)`.
4. **Wrap Passive Calls in `PassiveExecutionPool`**:
   - Wrap `dom()`, `screenshot()`, `eval()`, and `theme.qa_validate()` with `this.passivePool.execute(tabId, () => ...)`.

## Success Criteria
- [ ] Micro-Scoped Provenance: During a 5-second Bézier drag with 10ms sleep between steps, a physical keypress fired between steps sees `agentInputInFlight === 0` and aborts the drag immediately with `PREEMPTED_BY_USER`.
- [ ] Safe Controller Assignment: While Session 1 holds the lock, Session 2 queues for the lock. Calling `preemptActiveAgent()` aborts Session 1 (the lock holder), not Session 2 (the waiting queued caller).
- [ ] 20 simultaneous background DOM requests on one tab: First 4 execute immediately, requests exceeding limits reject cleanly with `CAPABILITY_OVERLOADED` without crashing the renderer process.
- [ ] Tab closure cleanly removes `before-input-event` listeners and cancels any queued actions for that tab with `TARGET_STALE`.

## Risk Assessment
- **Risk**: Interleaved physical keypress detected during synthetic key-down vs key-up.
- **Mitigation**: Synthetic key events pair down/up synchronously within `syncWithAgentInput`, minimizing the synthetic window to $< 0.1\text{ms}$.
