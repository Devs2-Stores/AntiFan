---
title: "AntiFan Runtime Performance & Modular TabHost Hardening"
description: "Eliminate O(N log N) GC thrashing in terminal history tail slicing, guard against 50k-token raw DOM fallbacks in agent snapshots, decompose the 5,424-line NativeTabHost into domain sub-controllers, and preserve verified sub-12ms tab switch latency."
status: in-progress
priority: P1
effort: "4h"
tags: ["performance", "terminal", "semantic-ref", "refactoring", "low-spec"]
created: 2026-08-31
---

# AntiFan Runtime Performance & Modular TabHost Hardening

## Overview
Comprehensive runtime optimization and architectural decoupling for AntiFan Browser Desktop. Replaces inefficient $O(N \log N)$ `Array.from` string allocations in `TerminalManager.safeSliceTailJsonBounded` with an $O(\text{budget})$ reverse tail scanner ($36.5\times$ faster, $0\text{ MB}$ array heap churn), hardens the `NativeTabHost.agentSnapshot` fallback to prevent 50,000–200,000 token LLM context blowouts, decomposes the monolithic 5,424-line `NativeTabHost.ts` into isolated domain sub-controllers (`TabAutomationHost`, `TabDevToolsHost`) behind a backwards-compatible facade, and verifies all 521+ tests and 8h soak telemetry invariants.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Eliminate $O(N \log N)$ terminal tail slicing GC heap churn and reduce execution time to $<0.05\text{ms}$ | P0 |
| 2 | Guard `agentSnapshot` failure fallback to return structured error instead of dumping full raw DOM (50k+ tokens) | P0 |
| 3 | Decompose `NativeTabHost.ts` by extracting `TabAutomationHost` (Agent Cursor & Action Dispatch) | P1 |
| 4 | Decompose `NativeTabHost.ts` by extracting `TabDevToolsHost` (Ruler, Lens, FontFinder, Page Source) | P1 |
| 5 | Verify 100% test pass rate ($\ge 521$ tests), sub-12ms tab switch latency, and flat memory slope ($\le 0.25\text{ MB/min}$) | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: safeSliceTailJsonBounded Algorithm Optimization](./phase-01-start.md) | Pending |
| 2 | [Phase 2: Semantic Ref Fallback & Token Guard](./phase-02-semantic-ref-fallback-and-token-guard.md) | Pending |
| 3 | [Phase 3: TabAutomationHost Sub-Controller Extraction](./phase-03-tab-automation-host-extraction.md) | Pending |
| 4 | [Phase 4: TabDevToolsHost Sub-Controller Extraction](./phase-04-tab-devtools-host-extraction.md) | Pending |
| 5 | [Phase 5: Full Test Suite Verification & Benchmark Validation](./phase-05-verification-and-benchmark-soak.md) | Pending |

## Acceptance Criteria

- [ ] `safeSliceTailJsonBounded` executes in $<0.05\text{ms}$ for 512KB buffers with zero large array allocations.
- [ ] `NativeTabHost.agentSnapshot` returns a concise structured error string when isolated collection fails, never dumping raw `outerHTML`.
- [ ] `TabAutomationHost` encapsulates all visual cursor kinematics, trajectory dispatching, and isolated world execution.
- [ ] `TabDevToolsHost` encapsulates in-page overlays, inspection tools, auto JSON viewer, and page source rendering.
- [ ] `NativeTabHost.ts` line count is reduced substantially while preserving 100% public API compatibility and zero IPC channel drift.
- [ ] All 521+ unit, integration, and e2e tests pass cleanly with `npm test` and `npm run typecheck`.

<!-- slug: runtime-performance-and-modular-tabhost-hardening -->
