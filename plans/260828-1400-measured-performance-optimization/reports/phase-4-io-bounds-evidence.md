# Phase 4 Evidence — Terminal, Bridge, and Artifact I/O Bounds

Date: 2026-08-28. Plan: `local://electron-performance-optimization-plan.md` (Phases: 3/4 done, 2 blocked).

## Scope

Phase 4 bounds I/O on the terminal write path (renderer), the bridge broadcast path (main), and the artifact staging path (main). Benchmark-first: every change is cause-aligned with the Phase 1 baseline (terminal burst 1544 chunks / 8346 bytes in 4519 ms; artifact png-max 144 ms; no bridge slow-client measurements existed).

## Changes

### 1. ArtifactStore binary safety (`src/main/tools/artifact-store.ts`)

- `stage()` bypasses UTF-8 `redactSecrets` for binary MIME (`isTextLike`: text/*, application/json, application/xml, image/svg+xml text; everything else binary). Binary payloads stage byte-for-byte; `ref.redacted` now reflects whether a replacement actually occurred.

### 2. Standalone renderer → TerminalWriteDispatcher (`src/renderer/standalone.js`, `standalone.html`, `scripts/copy-static.mjs`)

- The dispatcher (`src/shared/terminal-write-dispatcher.ts`) is the single, existing queue abstraction — no second queue was introduced.
- `standalone.html` loads classic scripts, so `copy-static.mjs` ships the compiled CJS as `terminal-write-dispatcher.js` with an `exports`/`module` wrapper and a footer exposing `window.globalTerminalWriteDispatcher` (guard: skip if already emitted, idempotent across compiles).
- `writeToTerminalPane` / `writeToSplitPane` route through lazily created per-terminal targets (`item.writeTarget` field already existed, previously unused). `splitWriteTarget` was already declared/reset by the split lifecycle.
- Pre-hydration `pendingChunks` flush loops (both hydration sites) route through the same targets so snapshot → pending → live ordering is preserved FIFO.
- Fallback to direct `term.write` when the dispatcher global is absent (stale packaged renderer) or `queueWrite` throws — no behavior regression on old builds.
- xterm behavior preserved: `onPostWrite` scrolls to bottom only when active and not user-scrolled; input path (`onData` → `api.sendTerminalInputTo`) untouched.

### 3. BridgeServer client backpressure + heartbeat (`src/main/bridge/bridge-server.ts`)

- Constants: `BRIDGE_SOFT_HIGH_WATER = 8 MiB` per client backlog, `BRIDGE_QUEUE_HARD_CAP = 32 MiB` per-client FIFO cap (overflow terminates the client), `BRIDGE_DRAIN_INTERVAL_MS = 50`, `BRIDGE_HEARTBEAT_INTERVAL_MS = 30 s`.
- Healthy fast path unchanged: frame sent directly while `bufferedAmount + frame ≤ HIGH_WATER` and FIFO empty.
- Slow client: frames enter a per-client FIFO; consecutive `antifan:terminal:data` frames for the same session coalesce (lossless: same bytes, same order); a shared unref'd pump drains while the socket has room below the high-water mark and stops itself when no client is congested. A client that cannot drain past the 32 MiB FIFO cap is terminated (observable: socket close + stderr warn; the renderer reconnects and re-syncs terminal state via snapshot) — bounded memory, no silent loss.
- Heartbeat: `isAlive` flag on connect, `pong` handler, interval terminates peers silent for two ticks — dead clients cannot accumulate in `clients` (prevents unbounded broadcast fan-out).
- Both timers cleared in `dispose()` and unref'd (no process-keepalive in tests).
- Telemetry preserved: `broadcast` metric now also reports `congested` client count; no payload decoding added.

## Verification

- `node --check src/renderer/standalone.js` — OK.
- `node --check .compiled/src/renderer/terminal-write-dispatcher.js` (wrapped classic script) — OK.
- `NODE_OPTIONS="--max-old-space-size=4096" npm run compile` — green (tsc + copy-static).
- `node --test` on 5 suites: terminal-write-pipeline, bridge-server, bridge-attachment-dispatch, workflow-and-artifact-security, performance-benchmark-contract — **35 tests, 0 failures** (includes 4 new artifact binary-safety tests).
- Harness `--scenario artifact --runs 1` (report `phase-1-baseline-2026-08-28T14-04-26-159Z.json`):
  - text-small 2.39 ms (redacted=false — benign), dom-medium 10.39 ms (redacted=false), png-small 2.02 ms `binaryByteEqual=true` redacted=false, png-max 14.41 ms `binaryByteEqual=true` redacted=false. All four stages `baselineStatus: measured`.
  - Byte-for-byte equality confirmed end-to-end; `redacted` flags accurate (binary bypasses redaction; text-with-secret case covered by unit tests).

## Rollout decisions

- Dispatcher stays the single renderer write path; the standalone local `sliceUtf8Bytes` copy remains (independent of dispatcher slicing, no behavior coupling).
- Bridge coalescing is a capacity bound, not a loss guarantee: it preserves FIFO and byte content; the stalled-client termination path is covered by the hard-cap regression test in `test/main/bridge-server.test.ts` (raw TCP client stops reading, queue exceeds the cap, server terminates).
- No baseline regression expected on terminal echo (fast-path ≤256 B stays immediate; burst coalesces to one 64 KiB frame per RAF).