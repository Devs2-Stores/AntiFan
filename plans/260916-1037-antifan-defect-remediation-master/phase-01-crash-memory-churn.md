---
phase: 1
title: "Crash & Memory Churn Remediation"
status: pending
effort: "1d"
dependencies: []
---

# Phase 1: Crash & Memory Churn Remediation

## Overview

Stabilize the Electron Main process: eliminate the 25–35 MB/s transient V8 string churn that precedes every native `__fastfail` crash, and cap crash-dump disk growth.

## Requirements

- Functional: congested WebSocket clients drain via pre-serialized whole frames (no per-tick `join`/`stringify`); terminal transcript bounded without ConsString churn; crash dumps capped at 3 files / ≤200 MB.
- Non-functional: RSS growth < 10 MB over 60s @ 20 MB/s synthetic stream; JSON frame integrity preserved end-to-end.

## Architecture

**Metaphor: OS kernel ring-buffer — applied at FRAME granularity, not byte granularity.** The bridge transmits discrete JSON text frames; a byte-level ring buffer would slice across frame boundaries and UTF-8 code points, corrupting downstream parsers. Correct design: **pre-serialize each frame to a `Buffer` at enqueue time** (one `JSON.stringify` per frame, not per drain tick), queue whole frames in a bounded FIFO, and drop *whole oldest frames* on overflow. The existing 50ms `armDrainPump` is retained — `ws` sockets do NOT emit `drain` events — but the pump now sends pre-built `Buffer`s with zero serialization work per tick.

`TerminalManager`: `s.buffer` has ~19 read sites across `terminal-manager.ts`, `native-tab-host.ts`, and stream tests — it cannot be replaced outright. Keep `s.buffer` as the public accessor but back it with a chunked `Buffer[]` store + lazy materialization, and track `bufferBytes` incrementally instead of `Buffer.byteLength(s.buffer)` rescans.

## Related Code Files

- Modify: `src/main/bridge/bridge-server.ts` (~2844-2983: `clientCongestion` queue entries, `dataParts` coalescing at ~2886-2915, `flushCongestedClient` ~2935, `armDrainPump` ~2968)
- Modify: `src/main/browser/terminal-manager.ts` (~582-646 `safeSliceTail`, ~1231-1235 `schedulePersist`/`persistAsync`, all `s.buffer` read sites)
- Modify: `src/main/index.ts` (~104-114: `crashReporter.start` → add `pruneOldCrashDumps`)
- Modify: `src/main/browser/tab-devtools-host.ts` (guard CDP callbacks: `if (!wc || wc.isDestroyed() || !wc.mainFrame) return;`)
- Create: `test/unit/frame-queue.test.mjs` (repo convention: `.mjs` under `test/unit/`)

## Implementation Steps

1. **Pre-serialized frame FIFO** (`bridge-server.ts`): change congestion queue entries to `{ frame: Buffer, bytes: number, coalesceKey?: string, terminalSessionId?: string }`. At enqueue, run `JSON.stringify` ONCE into `Buffer.from(...)`. For terminal-data coalescing, keep `dataParts: string[]` but join into the final frame Buffer only when the frame reaches the head of the queue for send — or simpler: cap coalescing at N parts (e.g. 64) then seal the frame.
2. **Whole-frame tail-drop**: when queue bytes exceed `BRIDGE_QUEUE_HARD_CAP` (32 MB), drop oldest *complete* frames and increment `droppedFrames`/`droppedBytes` counters surfaced in diagnostics. Never slice a frame.
3. **Retain `armDrainPump`** (50ms) — `ws` has no `drain` event — but `flushCongestedClient` now calls `ws.send(frame.frame)` on pre-built Buffers: zero `join`/`stringify` per tick. Keep the existing `bufferedAmount < BRIDGE_SOFT_HIGH_WATER` gate.
4. **PTY backpressure — DISABLED by default (kongming advisory)**: `TerminalManager` sessions serve both local Desktop tabs and remote WS clients; pausing the PTY for a congested background client would freeze the local interactive terminal (head-of-line blocking), and on winpty fallback detaching the `data` listener permanently drops shell output. The bounded frame FIFO + whole-frame tail-drop + `dropSlowClient` at 32 MB already eliminates the churn without throttling the shell. Keep `pauseSession`/`resumeSession` wrappers (node-pty `IPty.pause()`/`resume()`) behind `BRIDGE_PTY_BACKPRESSURE=1` env flag, OFF by default; on `dropSlowClient`, resume unconditionally.
5. **TerminalManager chunked store**: `s.chunks: Buffer[]` + `s.bufferBytes` incremental counter; `s.buffer` becomes a lazy getter materializing `Buffer.concat(s.chunks).toString('utf8')` — all 19 existing read sites keep working unchanged. `safeSliceTail` drops whole oldest chunks (no string slice). Throttle `persistAsync` to ≥5s debounce or session sleep/close.
6. **Crash dump retention** (`index.ts`): after `crashReporter.start()`, `pruneOldCrashDumps(dir, maxRetained=3)` — sort `.dmp` by mtime desc, unlink beyond cap.
7. **CDP callback guards** (`tab-devtools-host.ts`): `wc.isDestroyed()`/`mainFrame` checks on every event callback.

## Success Criteria

- [ ] `npm run test:file -- .compiled/test/unit/frame-queue.test.js` (or `node --test --test-force-exit`) green: frame integrity, tail-drop accounting, no mid-frame slices
- [ ] Smoke: 60s @ 20 MB/s terminal stream → RSS delta < 10 MB; zero `dataParts.join` calls in drain path
- [ ] `crashDumps/reports/` never exceeds 3 `.dmp` files
- [ ] `npm run typecheck` clean; existing terminal stream tests still pass (s.buffer compat)

## Risk Assessment

- **Coalesced frame grows past cap**: seal coalescing at 64 parts or 1 MB, whichever first; sealed frame becomes immutable.
- **PTY pause deadlocks a session whose only client died**: `dropSlowClient` already terminates at hard cap — on drop, resume the PTY unconditionally.
- **Lazy `s.buffer` getter materializes on every read**: cache the materialized string, invalidate on chunk append; hot readers (waitTerminal regex) poll at intervals so cost is bounded.
- **Rollback**: keep `dataParts` path behind `BRIDGE_FRAME_FIFO=0` env flag for one release; signal to revert = client-side JSON parse errors in bridge logs.
