---
title: "AntiFan Terminal Transport Hardening & State Synchronization (Phase T0 & T1)"
description: "Instrument live stream truth, eliminate silent sequence drops, introduce dual-bound SessionDeliveryJournal with coalesced ACK, and achieve P0-Transport Certified status before renderer view refactoring."
status: completed
priority: P0
effort: "3-4d implementation + certification"
branch: main
tags: [terminal, transport, sync-protocol, p0, reliability, windows, electron]
blockedBy: []
blocks: [terminal-view-registry-t2]
created: 2026-09-06
---

# AntiFan Terminal Transport Hardening & State Synchronization (Phase T0 & T1)

## Outcome

Terminal data transport achieves **authoritative, contiguous delivery**: no terminal view can silently become stale or skip sequence numbers. The Electron Main process owns stream truth via `SessionDeliveryJournal` and tracks subscriber ACK states. The Renderer detects gaps immediately, halts out-of-order rendering, recovers deltas in-flight, and transitions to an explicit `DEGRADED` state if the recovery window expires.

**Ultimate Milestone:** `[P0-Transport Certified]` earned under real Windows 11 Electron runtime before any Split view lifecycle refactor begins.

---

## The 6 Inviolable Terminal Laws

1. **Law #1 (Lifecycle & Renderer Boundary):** Within one Renderer, layout mutations MUST NOT destroy a live View. Across WebContents (Dock $\leftrightarrow$ Popout), explicit handoff is required.
2. **Law #2 (Delivery Truth & ACK):** IPC delivery $\neq$ state synchronization. Main owns the current-generation `SessionDeliveryJournal`; Renderer sends coalesced ACKs.
3. **Law #3 (Identity 3-Tuple):** Persisted Transcript $\neq$ Resurrected Process. Identity is strictly `(sessionId, generation, seq)`.
4. **Law #4 (Zero Private Intrusion):** No private `_renderService` or `node-pty._agent` in new architecture.
5. **Law #5 (Single Authority):** Exactly one input owner and one geometry owner per session at any instant.
6. **Law #6 (Bounded Recovery & Honest Degradation):** Every buffer and queue MUST have explicit byte/chunk bounds. Resource exhaustion transitions to `DEGRADED`, never a fake `READY`.

---

## Constraints

- **Scope Fence:** Strictly confined to Phase T0 (Instrumentation & Test Harness) and Phase T1 (Terminal State Synchronization Protocol).
- **NO UI / Split Refactor in T0/T1:** `TerminalViewRegistry`, parking shelves, and Split singleton rewrites are deferred to Phase T2.
- **Compatibility:** `api.getFullBuffer()` is retained as a diagnostic/debug fallback; `api.getTerminalDelta()` is the authoritative live recovery path.
- **Workstation Reality:** Windows 11 Pro x64, Intel i5-9300H, single theme developer (Haravan/Sapo/Shopify CLI, PowerShell, AI CLIs).
- **Zero Behavior Change in T0:** Telemetry instrumentation must observe without mutating stream flow, scheduling, or rendering timing.

---

## Non-Goals (Strictly Forbidden in T0/T1)

- No refactoring of `splitTerm` into `TerminalViewRegistry` (Phase T2).
- No off-screen `#terminal-parking-shelf` (Phase T2).
- No `PopoutHandoffProtocol` implementation (Phase T2).
- No cell-aware layout clamp or divider drag changes (Phase T3).
- No disk-based log rotation or transcript persistence overhaul (Phase T4).
- No Windows Job Object or ConPTY migration (Phase T5).

---

## Phased Implementation Roadmap

| Phase | File / Target | Focus | Status | Exit Gate |
|---|---|---|---|---|
| **Phase 1 (T0)** | [phase-01-t0-instrumentation-and-oracle.md](./phase-01-t0-instrumentation-and-oracle.md) | Telemetry structures, diagnostic counters, and `@xterm/headless` Oracle Test Harness | Completed | All invariant tests pass (`terminal-stream-invariants.test.ts`) |
| **Phase 2 (T1.A)** | [phase-02-t1-journal-and-ack.md](./phase-02-t1-journal-and-ack.md) | Main Process `SessionDeliveryJournal`, remove sidebar IPC gate, `TerminalSubscriberState` & Coalesced ACK | Completed | Verified (`terminal-delivery-journal.test.ts`, `terminal-subscriber-and-sync.test.ts`) |
| **Phase 3 (T1.B)** | [phase-03-t1-synchronization-state-machine.md](./phase-03-t1-synchronization-state-machine.md) | Renderer state machine (`READY/GAPPED/RESYNCING/DEGRADED`), Bounded `liveQueue`, Bootstrap Sync Handshake | Completed | Verified (`terminal-gap-state-machine.test.ts`) |
| **Phase 4 (T1.C)** | [phase-04-t1-certification-gates.md](./phase-04-t1-certification-gates.md) | Real Windows Electron E2E smoke tests (Gates B, C1, C2, I, J) | Completed | Official Certification Earned: `[P0-Transport Certified]` |
---

## Global Definition of Done for T1 (`[P0-Transport Certified]`)

The subsystem is certified ONLY when all 11 conditions are simultaneously satisfied:

1. **Gap in journal retention:** Injected sequence gap within 2 MiB / 4096 chunks heals with 0 bytes lost and 0 duplicate chunks rendered.
2. **Gap beyond journal retention:** Exceeding retention transitions to `DEGRADED`, never a fake `READY`.
3. **Renderer reload on idle PTY:** Bootstrap handshake pulls delta up to current `lastSeq` without waiting for future chunks.
4. **Sidebar hidden streaming:** Continuous output with closed sidebar preserves 100% data while renderer is alive (Gate C1).
5. **Recovery queue bounded:** Renderer `liveQueue` never exceeds 1 MiB / 2048 chunks; overflow transitions to `DEGRADED`.
6. **Single-flight resync:** Exactly one `getTerminalDelta` request in-flight per view; concurrent triggers coalesce.
7. **Generation fencing:** Output from previous session generation is rejected and never enters current xterm instance.
8. **True applied ACK:** ACK reflects chunks settled via `xterm.write()` callback, not raw IPC reception.
9. **Dead subscriber cleanup:** Terminated/closed windows are purged from Main's subscriber registry.
10. **Sustained memory stability:** Journal and queues stay bounded under continuous 1,000 lines/sec flood.
11. **Live Windows proof:** Gates B, C1, C2, I, and J pass under real Electron runner (`npm run smoke:terminal`), not solely mocked unit tests.
