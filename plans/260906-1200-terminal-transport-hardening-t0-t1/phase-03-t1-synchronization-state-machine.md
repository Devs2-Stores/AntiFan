# Phase 3 (T1.B): Synchronization State Machine & Bootstrap Handshake

**Goal:** Ensure no TerminalView can silently become stale. The renderer strictly detects gaps, enforces bounded recovery queues, and handles delta expiration with full architectural honesty.

---

## Commit 5: Renderer Gap State Machine & Bounded `liveQueue`

### 1. Files & Functions to Modify
- `src/renderer/standalone.js`:
  - **P0-5 Fix at lines 1896–1901 (Split) & 1924–1929 (Main):**
    Eliminate blind `lastRenderedSeq = chunkSeq`. Implement strict sequence verification:
    ```ts
    function processIncomingChunk(viewState, chunk) {
      if (chunk.generation !== viewState.generation) {
        handleGenerationMismatch(viewState, chunk);
        return;
      }

      if (chunk.seq <= viewState.lastRenderedSeq) {
        return; // Dedup
      }

      if (chunk.seq === viewState.lastRenderedSeq + 1) {
        writeChunk(viewState, chunk.data);
        viewState.lastRenderedSeq = chunk.seq;
        return;
      }

      // Sequence gap detected: chunk.seq > lastRenderedSeq + 1
      handleSequenceGap(viewState, chunk);
    }
    ```
  - Implement `handleSequenceGap`:
    - Transition view state: `READY -> GAPPED`.
    - Enforce hard bounds on `liveQueue`:
      - `MAX_RECOVERY_QUEUE_BYTES = 1024 * 1024` (1 MiB).
      - `MAX_RECOVERY_QUEUE_CHUNKS = 2048`.
      - If queue exceeds either limit: halt buffering and transition to `DEGRADED`.
    - **Single-Flight Resync:** Ensure only one `api.getTerminalDelta()` request is in-flight. If already in-flight, push to bounded `liveQueue` and await resolution.
    - When delta returns:
      - Write missing delta chunks sequentially.
      - Flush buffered `liveQueue` chunks sequentially.
      - Update `lastRenderedSeq` monotonically.
      - Transition state: `GAPPED -> RESYNCING -> READY`.

### 2. Definition of Done (Commit 5)
- [ ] Injected sequence jump from 100 to 150 halts immediate rendering, fetches 101..149 from journal, renders all 50 chunks in order, settles at 150 with 0 duplicate characters, and meets latency standard ($p95 < 250\text{ms}, p99 < 500\text{ms}$).
- [ ] Overflowing `liveQueue` with 3 MiB of rapid logging during an artificial delta pause transitions cleanly to `DEGRADED` without freezing Chromium or exceeding memory limits.
---

## Commit 6: Bootstrap Sync Handshake & Honest `DEGRADED` Fallback

### 1. Files & Functions to Modify
- `src/main/browser/terminal-manager.ts`:
  - Expose IPC handler `antifan:terminal:sync-view`:
    - Accepts `{ sessionId, knownGeneration, lastAppliedSeq }`.
    - Returns:
      - `'UP_TO_DATE'`: if `lastAppliedSeq === session.lastSeq`.
      - `'DELTA'`: array of missing chunks if `lastAppliedSeq >= journal.retainedFromSeq`.
      - `'DELTA_EXPIRED'`: if `lastAppliedSeq < journal.retainedFromSeq`.
      - `'GENERATION_CHANGED'`: if `knownGeneration !== session.generation`.
      - `'SESSION_CLOSED'`: if session terminated.
- `src/preload/standalone-preload.ts`:
  - Expose `api.syncTerminalView(query)`.
- `src/renderer/standalone.js`:
  - Call `api.syncTerminalView()` whenever:
    - A terminal pane is mounted/attached.
    - The window or sidebar recovers from an idle/reload state.
  - **Handling `DELTA_EXPIRED`:**
    - Transition state to `DEGRADED`.
    - Render non-intrusive in-pane banner:
      `[Terminal Display Out of Sync — Process is Active — Click to Resync View]`
    - Clicking banner calls `api.getFullBuffer(sessionId)` (kept as debug/best-effort fallback), resets xterm (`term.reset()`), writes buffer, and updates watermark.
    - **Invariant:** `DEGRADED` view NEVER falsely marks itself `READY` without explicit user/snapshot recovery.

### 2. Definition of Done (Commit 6)
- [ ] Reloading sidebar view while PTY has emitted 400 chunks and is currently idle immediately pulls chunks 1..400 and renders complete output.
- [ ] Exceeding journal retention forces `DEGRADED` state with observable UI badge.
- [ ] `api.getFullBuffer()` remains fully operational for manual/diagnostic recovery.
