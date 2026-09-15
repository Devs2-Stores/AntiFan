---
title: "Terminal overhaul: sidebar tabs, sleep/archive, honest transcript, ConPTY, speed"
description: "Sidebar+resize+category tabs, zero-cost sleep/wake, cls/restart transcript lifecycle, ConPTY re-enable gated on teardown-hang repro, and a benchmark-first speed pass across the PTY→paint pipeline."
status: pending
priority: P1
effort: "2-3d"
tags: ["terminal", "performance", "ux", "conpty", "persistence"]
created: 2026-09-15
blockedBy: [260903-1500-terminal-tab-affinity-and-concurrency-isolation]
supersedes: [260830-1530-electron-cpu-memory-performance-optimization]
evidence:
  - plans/reports/brainstorm-260915-terminal-sidebar-sleep-cls-conpty.md
  - plans/reports/_ultra-terminal-perf-evidence.md
---

# Terminal overhaul — sidebar, sleep, cls, ConPTY, speed

## Overview

Four contracted user-facing outcomes plus a benchmark-first speed pass, sequenced so
correctness/perf foundations land before the features that depend on them. All design
decisions trace to the brainstorm contract (best-of-5 verified) and the perf plan
(best-of-5 verified, kongming-weighted). Key non-obvious constraints:

- Sleep MUST NOT emit `session-closed`/`close` (native-tab-host.ts:1459-1461 →
  `clearTerminalAgentAffinity` kills the affinity sleep exists to preserve).
- Hidden-pane gating MUST re-hydrate via snapshot on activation, NEVER delta —
  `lastRenderedSeq` advances pre-write, so delta-from-it silently skips gated chunks.
- IPC coalescing MUST carry `fromSeq`/`throughSeq` — a single merged seq reads as a
  gap → resync storm.
- `lastRenderedSeq` is a receipt marker, not paint — benchmarks must stamp
  `onPostWrite` + rAF.
- ConPTY teardown hang is REAL in node-pty 1.1.0 (verified: ref'd drain timer,
  unbounded `worker.terminate()` pend, exit-flush timer, console-list agent fork,
  kill-before-ready no-op orphaning OpenConsole). `safelyKillSession` does NOT cover
  it. The flip requires a node-pty-level fix or watchdog — Phase 1 proves which.
- UI prefs persist via saved-tabs.json convention (field→clamp→schedulePersist→
  buildPersistData), NOT localStorage (zero localStorage in repo) and NOT capsule
  `updateActiveState` (dead code, 0 callers).
- Sleeping sessions MUST keep `buffer` in `listSessions` — mobile-remote reads
  `s.buffer`; excluding it blanks mobile screens.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Sidebar tab layout (default horizontal) + drag-resize + categories | P1 |
| 2 | Sleep/archive tabs: zero-cost, affinity-preserving, restart-safe | P1 |
| 3 | cls/clear/Ctrl+L actually clears; banners never stack across restarts | P1 |
| 4 | ConPTY by default (correct TUI rendering) gated on verified clean teardown | P1 |
| 5 | Measurable speed: hidden-pane gating, dirty-scoped persist, IPC coalescing, micro-fixes — each proven by before/after benchmark | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Benchmark instrumentation + ConPTY teardown gate](./phase-01-benchmark-conpty-gate.md) | Pending |
| 2 | [Transcript lifecycle + persist](./phase-02-transcript-persist.md) | Pending |
| 3 | [Renderer pipeline gating](./phase-03-renderer-gating.md) | Pending |
| 4 | [IPC coalescing + fan-out](./phase-04-ipc-coalescing.md) | Pending |
| 5 | [Features: sidebar, categories, sleep](./phase-05-features.md) | Pending |
| 6 | [ConPTY flip + full verification](./phase-06-conpty-verify.md) | Pending |

## Dependency graph

```
P1 (bench + ConPTY gate) ──┬──> P2 (transcript+persist) ──> P5 (features) ──> P6 (flip+verify)
                           ├──> P3 (renderer gating)   ──> P5
                           └──> P4 (IPC coalescing)    ──> P5
P2/P3/P4 may run in parallel (disjoint functions, same files — serialize edits within
terminal-manager.ts / standalone.js via one owner per file or sequential landing).
P6 blocked by P1 gate verdict AND P2-P5 green.
```

## Success Criteria

- [ ] A1.1-A1.4 sidebar acceptance (default horizontal, toggle, persist, all interactions)
- [ ] A2.1-A2.10 sleep acceptance (incl. zero-cost: 20 sleeping + 5 active ≡ 5 active)
- [ ] A3.1-A3.6 cls/restart acceptance (no stacked banners, persist clean, alt-screen safe)
- [ ] A4.1-A4.6 ConPTY acceptance (clean quit ≤5s, no orphans, winpty escape hatch)
- [ ] Benchmark: hidden panes ~0 writes during stream; persist stringify ~1MB/tick not ~50MB; ackLatencyMs p95 improved or held; echo latency not regressed by coalescing
- [ ] `smoke:terminal` + `test:terminal-transport` green under final backend

## Cross-plan notes

- `260903-1500-terminal-tab-affinity-and-concurrency-isolation` (in-progress, itself
  blocked): this plan's sleep/wake depends on its affinity machinery staying stable;
  do not land changes that break `${terminalId}@${generation}` keys.
- `260830-1530-electron-cpu-memory-performance-optimization` (pending): ~70% landed
  already; remaining unique items folded in here — sidebar-visibility send-gate
  (Phase 4) and absolute acceptance assertions (Phase 6). Mark superseded on landing.

<!-- slug: terminal-sidebar-sleep-cls-conpty-perf -->
