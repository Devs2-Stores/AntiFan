# Phase 2 (T1.A): Delivery Journal & Coalesced Subscriber ACK

**Goal:** Establish the Electron Main Process as the authoritative owner of stream truth. Ensure data is never dropped due to sidebar visibility and track subscriber acknowledgment.

---

## Commit 3: Main Process `SessionDeliveryJournal` & Unblocking Sidebar IPC

### 1. Files & Functions to Modify
- `src/main/browser/terminal-manager.ts`:
  - Introduce `SessionDeliveryJournal`:
    ```ts
    interface JournalEntry {
      seq: number;
      generation: number;
      data: string;
      byteLength: number;
      timestamp: number;
    }

    class SessionDeliveryJournal {
      private entries: JournalEntry[] = [];
      private totalBytes = 0;
      private readonly MAX_BYTES = 2 * 1024 * 1024; // 2 MiB
      private readonly MAX_CHUNKS = 4096;

      append(generation: number, seq: number, data: string): void;
      getDelta(generation: number, fromSeq: number): TerminalDeltaResult;
      getRetainedRange(): { fromSeq: number; throughSeq: number; bytes: number; chunks: number };
      clear(): void;
    }
    ```
  - Bind an instance of `SessionDeliveryJournal` to each active `Session`.
  - Expose IPC handler `antifan:terminal:get-delta` returning `TerminalDeltaResult`:
    - `'OK'`: array of chunks from `fromSeq` through `latestSeq`.
    - `'DELTA_EXPIRED'`: if `fromSeq < journal.retainedFromSeq`.
    - `'GENERATION_MISMATCH'`: if `requestedGeneration !== session.generation`.
    - `'SESSION_CLOSED'`: if session has exited.
- `src/main/browser/native-tab-host.ts`:
  - **P0-4 Fix at line 1164:** Remove `if (this.isSidebarOpen && ...)`.
  - Ensure `safeSendWebContents(this.sidebarView.webContents, 'antifan:terminal:data', payload)` runs unconditionally whenever `this.sidebarView` exists and is not destroyed.

### 2. Definition of Done (Commit 3)
- [ ] Closing the sidebar while generating 5,000 lines of log does not stop chunks from reaching `sidebarView.webContents`.
- [ ] Calling `getTerminalDelta` with a valid `fromSeq` returns the contiguous missing slice.
- [ ] Journal automatically evicts oldest chunks when total bytes exceed 2 MiB or chunks exceed 4,096.

---

## Commit 4: Subscriber Registry & Coalesced Renderer ACK Protocol

### 1. Files & Functions to Modify
- `src/main/browser/terminal-manager.ts`:
  - Add `TerminalSubscriberState` registry:
    - Tracks `rendererInstanceId`, `sessionId`, `generation`, `lastAckedSeq`, `role` ('DOCK' | 'POPOUT'), and heartbeat timestamp.
  - Implement dead-subscriber cleanup: purge entries with no activity/heartbeat > 30s.
  - Expose IPC handler `antifan:terminal:ack` updating `lastAckedSeq`.
- `src/preload/standalone-preload.ts`:
  - Expose `api.ackTerminalChunk(sessionId, generation, seq)`.
- `src/renderer/standalone.js`:
  - Introduce coalesced ACK dispatcher:
    - Tracks pending ACK per view.
    - Flushes ACK when:
      - 50ms have elapsed since last ACK, OR
      - 64 unacked chunks have settled via `xterm.write()` callback.
    - **Invariant:** ACK is sent ONLY after `xterm.write()` has successfully executed and settled, never on initial IPC reception.

### 2. Definition of Done (Commit 4)
- [ ] DevTools telemetry confirms `lastAckedSeq` in Main matches `lastRenderedSeq` in Renderer within 50ms of stream settlement.
- [ ] Zero IPC flood: streaming 10,000 chunks emits $\le 160$ ACK messages total.
- [ ] Closing a popout or reloading the sidebar purges stale subscribers from Main registry.
