# Phase 1 (T0): Diagnostic Instrumentation & Test Harness

**Goal:** Make terminal stream behavior completely observable without altering runtime performance or rendering timing. Establish the `@xterm/headless` test oracle to prepare for Phase T1 verification.

---

## Commit 1: Telemetry Structures & Diagnostic Dump IPC

### 1. Files & Functions to Modify
- `src/preload/standalone-preload.ts`:
  - Expose `api.getTerminalHealth()` and `api.dumpTerminalDiagnostics()`.
- `src/main/browser/terminal-manager.ts`:
  - Expose stream metadata per session: `lastSeq`, `sessionGeneration`, `capsuleId`, in-memory buffer byte count.
- `src/renderer/standalone.js`:
  - Attach `window.__antifanTerminalHealth` tracking:
    - `rendererInstanceId`: UUID generated on window load.
    - Per view telemetry:
      - `sessionId`: string
      - `generation`: number
      - `lastRenderedSeq`: number
      - `lastAckedSeq`: number
      - `gapCount`: number
      - `resyncCount`: number
      - `degradedCount`: number
      - `recoveryQueueBytes`: number
      - `recoveryQueueChunks`: number
      - `health`: `'SYNCED' | 'GAPPED' | 'RESYNCING' | 'DEGRADED' | 'CLOSED'`
      - `authority`: `{ inputOwner: boolean, geometryOwner: boolean }`

### 2. Implementation Rules
- **Non-Interference Rule:** All telemetry counters are updated synchronously via existing write/dispatch paths; no async delays or additional event dispatchers are introduced.
- **Identity Enforcement:** All telemetry records are keyed by `(sessionId, generation)`.

### 3. Definition of Done (Commit 1)
- [ ] Calling `window.__antifanTerminalHealth` in DevTools returns a valid structured snapshot for all active panes.
- [ ] `npm run typecheck` passes with zero TypeScript errors.
- [ ] No observable change in terminal rendering or startup benchmarks.

---

## Commit 2: Headless Oracle Harness & Invariant Assertions

### 1. Files to Create & Modify
- `test/main/terminal-stream-invariants.test.ts`:
  - Unit test asserting core stream invariants directly against `TerminalManager`:
    1. **Monotonicity:** For any single generation, `seq(n + 1) > seq(n)`.
    2. **Generational Leap:** Calling `startTerminal()` or respawning a session increments `generation(n + 1) > generation(n)` and resets `seq` legitimately to 0.
    3. **Generation Fencing:** An event emitted with generation $G_1$ is marked stale and discarded if the active session is at $G_2$.
- `test/e2e/terminal-oracle-harness.ts`:
  - Test helper that instantiates `@xterm/headless`:
    - Synchronizes configuration: Cascadia Mono, exact cols/rows, scrollback.
    - Feeds identical raw byte streams to both real xterm and headless xterm.
    - Exposes comparison utility for `buffer.active.type`, cursor positions, `baseY`, and screen lines.

### 2. Definition of Done (Commit 2)
- [ ] `node --test .compiled/test/main/terminal-stream-invariants.test.js` passes 100% clean.
- [ ] Oracle harness successfully detects an intentionally injected character discrepancy or cursor offset.
