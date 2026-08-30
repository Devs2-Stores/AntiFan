---
phase: 2
title: "View Lifecycle & Lazy Terminal IPC Routing"
status: pending
priority: P1
effort: "1h"
dependencies: [1]
---

# Phase 02: View Lifecycle & Lazy Terminal IPC Routing

## Overview
Stops invisible rendering and IPC message pumping for hidden terminal workbench views. Currently, both the right Sidebar view and bottom Docked Terminal view listen to `TerminalManager.on('data')` and parse/render xterm VT sequences even when collapsed or hidden at 0px width/height.

## Requirements
- Functional:
  - Terminal output must ONLY be sent via IPC to views that are currently visible to the user.
  - When a collapsed sidebar or hidden terminal dock is opened by the user, it must immediately hydrate the terminal state with the latest snapshot.
  - Closed tabs and destroyed WebContentsViews must be completely unreferenced and removed from `mainWindow.contentView` to allow full V8 GC.
- Non-functional:
  - Zero IPC overhead and 0% renderer CPU consumption when terminal workbench is closed.

## Architecture & Code Changes

### Target: `src/main/browser/native-tab-host.ts`
1. Monotonically Increasing Chunk Sequences in `TerminalManager`:
   - Each session maintains `lastSeq: number` (initialized to 0).
   - On PTY data: `s.lastSeq += 1; s.buffer += data; this.emit('data', { sessionId: s.id, data, seq: s.lastSeq });`
   - `getFullBuffer(sessionId)` returns `{ sessionId, buffer: s.buffer, snapshotThroughSeq: s.lastSeq }`.

2. Gate `TerminalManager.on('data')` IPC dispatches based on view visibility:
   ```typescript
   TerminalManager.getInstance().on('data', (payload: { sessionId: string; data: string; seq: number } | string) => {
     const formatted = typeof payload === 'string'
       ? { sessionId: TerminalManager.getInstance().getActiveSessionId(), data: payload, seq: 0 }
       : payload;

     // 1. Dispatch to sidebarView ONLY if sidebar is currently visible
     if (this.isSidebarOpen && this.sidebarView && !this.sidebarView.webContents.isDestroyed()) {
       safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', formatted);
     }

     // 2. Dispatch to terminalView ONLY if docked terminal is currently visible
     if (this.isTerminalOpen && this.terminalView && !this.terminalView.webContents.isDestroyed()) {
       safeSendWebContents(this.terminalView.webContents, TERMINAL_CHANNELS.DATA, formatted);
     }

     // 3. Dispatch to open popout terminal windows
     for (const [id, win] of this.terminalWindows.entries()) {
       if (win && !win.isDestroyed()) {
         safeSendWebContents(win.webContents, 'antifan:terminal:data', formatted);
       } else {
         this.terminalWindows.delete(id);
       }
     }
   });
   ```
3. Watermarked Atomic Terminal Hydration Protocol:
   - **State Machine in Renderer (`standalone.js` / `terminal.ts`):**
     - State per session: `{ status: 'idle' | 'hydrating' | 'ready', liveQueue: Array<{ seq: number; data: string }>, lastRenderedSeq: number, epoch: number }`.
     - **Deduplication Invariant:** Chunks arriving between `status='hydrating'` and Main's `getFullBuffer()` snapshot are already inside `snapshot.buffer`. Watermark `snapshotThroughSeq` guarantees only `seq > snapshotThroughSeq` are flushed.
   - **Hydration Flow:**
     1. When a hidden/collapsed view is opened or session switches: set `state.status = 'hydrating'`, increment `epoch`.
     2. Any incoming live `antifan:terminal:data` frames `{ sessionId, data, seq }` during hydration are queued as `{ seq, data }` into `state.liveQueue`.
     3. Fetch snapshot from Main process: `const { buffer, snapshotThroughSeq } = await window.antifanTerminalAPI.getFullBuffer(sessionId);`
     4. Check stale: `if (state.epoch !== currentEpoch) return;`
     5. Reset terminal: `term.reset()`.
     6. Write `buffer` sequentially in strict chronological order (using `scheduleIdle` for chunks > 64 KiB).
     7. Set watermark: `state.lastRenderedSeq = snapshotThroughSeq;`
     8. Iterative Drain Loop:
        - Drain queued items in a loop: `while (state.liveQueue.length > 0) { const batch = state.liveQueue.splice(0, state.liveQueue.length); ... }`
        - Filter `batch.filter(item => item.seq > state.lastRenderedSeq)`, sort by `seq`, await ordered `writeAsync(term, item.data)`, and advance `state.lastRenderedSeq = item.seq`.
        - Any live chunks arriving during the awaits are pushed to `state.liveQueue` and processed by the next iteration of the `while` loop.
        - Only when `state.liveQueue.length === 0` after all awaits complete, transition `state.status = 'ready'`.
4. Clean up `WebContentsView` destruction in `closeTab()` and `destroy()`:
   - Ensure `this.window.contentView.removeChildView(view)` is explicitly called before `view.webContents.close()` or nulling references.
### Target: `src/renderer/standalone.js` & `src/renderer/terminal.ts`
1. Implement `scheduleIdle` helper with universal fallback:
   ```javascript
   const scheduleIdle = typeof window.requestIdleCallback === 'function'
     ? window.requestIdleCallback
     : (cb) => setTimeout(() => cb({ timeRemaining: () => 15, didTimeout: true }), 1);
   ```
2. Implement Watermarked Atomic Replay with live queue:
   ```javascript
   const sessionHydrationStates = new Map();

   function writeAsync(term, data) {
     return new Promise((resolve) => term.write(data, resolve));
   }

   async function atomicHydrateSession(term, sessionId) {
     const state = sessionHydrationStates.get(sessionId) || {
       status: 'idle',
       liveQueue: [],
       lastRenderedSeq: 0,
       epoch: 0,
     };
     state.status = 'hydrating';
     state.epoch += 1;
     const currentEpoch = state.epoch;
     sessionHydrationStates.set(sessionId, state);

     const res = await window.antifanTerminalAPI.getFullBuffer(sessionId);
     if (state.epoch !== currentEpoch) return; // Stale request superseded by newer switch

     term.reset();
     await writeSequentially(term, res.buffer);
     state.lastRenderedSeq = res.snapshotThroughSeq || 0;

     // Iterative drain loop: guarantees chunks arriving DURING write awaits are NOT dropped
     while (state.liveQueue.length > 0) {
       if (state.epoch !== currentEpoch) return; // Stale session check
       const batch = state.liveQueue.splice(0, state.liveQueue.length);
       const pending = batch
         .filter((item) => item.seq > state.lastRenderedSeq)
         .sort((a, b) => a.seq - b.seq);

       for (const item of pending) {
         await writeAsync(term, item.data);
         state.lastRenderedSeq = item.seq;
       }
     }
     state.status = 'ready';

   // On incoming live IPC data:
   function handleIncomingData(sessionId, { data, seq }) {
     const state = sessionHydrationStates.get(sessionId);
     if (!state || state.status === 'idle') return;
     if (state.status === 'hydrating') {
       state.liveQueue.push({ seq, data });
     } else if (state.status === 'ready' && seq > state.lastRenderedSeq) {
       state.lastRenderedSeq = seq;
       term.write(data);
     }
   }
   ```
3. Throttle `ResizeObserver` callbacks when container width is 0 or `display: none`.
## Related Code Files
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/renderer/standalone.js`
- Modify: `src/renderer/terminal.ts`

## Implementation Steps
1. In `native-tab-host.ts`, add visibility gates around `sidebarView` and `terminalView` IPC dispatchers.
2. Ensure open/toggle methods trigger a session buffer sync.
3. In `standalone.js`, add zero-dimension check to `ResizeObserver` to prevent infinite refit loops when width=0.
4. Verify compiling with `npm run compile`.

## Success Criteria
- [ ] Terminal data does not broadcast to hidden webContents.
- [ ] Opening sidebar executes atomic hydration without UI freeze, dropped lines, inverted order, or duplicate chunks.
- [ ] Watermark `snapshotThroughSeq` strictly deduplicates live chunks from snapshot buffer.
- [ ] Iterative drain loop (`while liveQueue.length > 0` with `splice(0)`) guarantees zero dropped chunks even when incoming data arrives during `term.write` async callbacks.
- *Risk:* User opens sidebar and sees blank terminal if sync fails.
- *Mitigation:* `toggleSidebar()` always emits a fresh `antifan:terminal:session` event containing the latest session buffer.
