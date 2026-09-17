---
title: "antifan-consolidated-remediation-soak"
description: "Consolidated execution of the AntiFan weakness audit: register durability, runtime/lease authority, target identity, failure taxonomy, capture truth, MCP transport, terminal, quota, Hub surface, Core Health — closed by a 120-minute soak."
status: pending
priority: P1
effort: "6-9d"
tags: [register-durability, runtime-authority, target-identity, capture, mcp-surface, terminal, quota, hub-surface, core-health, soak]
created: 2026-09-17
blockedBy: []
blocks: ["plans/260916-1037-antifan-defect-remediation-master"]
---

# antifan-consolidated-remediation-soak

## Overview

One plan for the whole weakness cluster surfaced by
`plans/reports/260918-0040-antifan-weakness-audit-and-remediation.md` (adjudicated
best-of-5, verifier-scored) plus the two live reports merged with it
(`260918-0036-antifan-two-report-joint-analysis.md`,
`plans/handoffs/antifan-weakness-remediation-20260918-0026.md`).

The order below is **not** a priority guess. It is the adjudicated order from the
report's verifier pass, and it is ordered by two hard criteria: **irreversibility
× being a precondition**. Step 1 is not the cheapest fix, it is the only one that
can still fire a loaded gun.

Every phase is closed by a **binary probe** (not by intent), and the whole program
is closed by a **120-minute soak** that reproduces the 14 defect scenarios against a
live app and compares the resulting counters with the baseline in
`§ Evidence baseline`.

## Evidence baseline (measured before any change)

Source: audit report §3.6, §3.7, §4.4 — live tool telemetry and disk state.

| Metric | Baseline | Source |
|---|---|---|
| `anti.screenshot.viewport` error rate | 62/80 = **77.5%** | session logs, 2 sessions / 71.5 MB |
| `anti.screenshot.full_page` error rate | 11/14 = **78.6%** | same |
| `anti.theme.qa_validate` error rate | 32/70 = 45.7% | same |
| overall tool error rate | 605/6536 = **9.3%** | same |
| AntiFan calls disguised as `write xd://…` | **2037** | same |
| args-parse failures (`expects a JSON args object as content`) | **41** (19 `Expected '}'`, 18 `Unterminated string`, 4 `Invalid escape character`) | same |
| `mcp__mcp__` doubled-prefix `No such tool` | 25 | same |
| compactions per session pair | 63 | same |
| `RUNTIME_MISMATCH` in invocation ledger | **2444** frames | `control-plane-v2/invocations` |
| `RUNTIME_MISMATCH` in app logs | **0** in all four logs (`main.log`, `main.log.1`, `native-host.log`, `native-host.log.1`) | clean grep 2026-09-18 |
| `TARGET_MISMATCH` (live, one session) | 91 | live tool results |
| `TARGET_STALE` | 21 | live tool results |
| `anti.verification.list().totalCount` | **0** while disk holds **1000** records / 1,831,100 B | T1 reproduced ×2 |
| Core Health | `DEGRADED` / `GATE_PROMOTION_FAILED`; 108 candidates PENDING | live `core.health` |

Safety net already taken before any change:
`E:\Work\.antifan-data\issues\verification-register.jsonl.bak-260918-guard-pending`
= 1,831,100 B / 1000 lines, byte-identical to the original.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Stop the live data-loss vector in the verification register (wholesale rewrite from an empty in-memory array) | P0 |
| 2 | Make target identity honest: one bound tab, one meaning, adoption symmetric across capabilities | P0 |
| 3 | Make failure codes tell the truth (drain ≠ missing surface; typed error relay, no `[object Object]`) | P1 |
| 4 | Make capture work on animated pages, and make the freeze claim provable | P1 |
| 5 | Get AntiFan MCP calls off the `write xd://…` JSON-string channel | P1 |
| 6 | Terminal truth: split pane projection, alt-screen diagnostics, lossy transcript affordance | P2 |
| 7 | Quota that releases: adoption slot freed on close/rebind, error payload self-diagnosing | P2 |
| 8 | Advertised MCP surface, privilege boundary, and Hub catalogue reflect reality | P2 |
| 9 | Core Health defects D1–D11 and the approved store writes | P2 |
| 10 | Prove the whole program by a 120-minute soak with counters, not by intent | P0 |
| 11 | Per-MCP usage statistics surface from real dispatch records — Hub aggregate + one Core Health usage line, never a client-side tally | P2 |

## Adjudicated order (report §6, verifier-scored)

| # | Step | Phase |
|---|---|---|
| 1 | **D — register reads from disk + fail-closed guard** (precondition of everything; the next `record_claim`/`verify_claim`/`update_verdict` call atomically replaces 1000 verdicts with an empty file) | 1 |
| 2 | `tabs.list` annotates `isBoundTab` on the **default** branch (91 `TARGET_MISMATCH` + up to 21 `TARGET_STALE` = 112, larger than any other single class) | 3 |
| 3 | typed `CaptureError('TARGET_BUSY_DRAINING')` at the throw site + match on **code** | 4 |
| 4 | `tools.xdev:false` **behind a routing precheck with immediate revert** | 6 |
| 5 | census names the animation class + branches `diagnosis.remedy` | 5 |
| 6 | pause WAAPI inside the freeze, scoped to the capture window, released by the existing `finally` | 5 |
| 7 | freeze the full-page path; only **after** 5+6 may `requireMediaFreeze` become a gate | 5 |
| 8 | session-lifecycle hooks bound in `.omp/hooks/pre/antifan-core-bridge.ts` | 2 |

Program acceptance criteria (report §6) are reproduced verbatim in
`## Global success criteria` below and are not weakened anywhere in this plan.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Register & durability truth](./phase-01-register-and-durability-truth.md) | Pending |
| 2 | [Runtime authority & session lifecycle](./phase-02-runtime-authority-live.md) | Pending |
| 3 | [Tab identity & adoption symmetry](./phase-03-tab-identity-and-lock-budget.md) | Pending |
| 4 | [Failure taxonomy & error relay](./phase-04-failure-taxonomy-and-error-relay.md) | Pending |
| 5 | [Capture truth & freezes](./phase-05-capture-truth-and-freezes.md) | Pending |
| 6 | [MCP surface & args transport](./phase-06-mcp-surface-and-args-transport.md) | Pending |
| 7 | [Terminal split, scrollback & hrv coupling](./phase-07-terminal-split-and-scrollback.md) | Pending |
| 8 | [Quota adoption](./phase-08-quota-adoption.md) | Pending |
| 9 | [Core Health defects D1–D11](./phase-09-core-health-defects.md) | Pending |
| 10 | [120-minute soak & evidence](./phase-10-soak-120m-and-evidence.md) | Pending |
| 11 | [Verification lane truth](./phase-11-verification-lane-truth.md) | **In progress** |

**Phase 11 is the instrument, and it runs first.** It is the adjudicated union of
the best-of-5 audit of the red e2e lane: 19 confirmed findings, 2 refuted packet
claims, 1 uncertain. Its two root causes are one **test** defect (a max-of-20
sample gated as `p95` at 120 ms, below the product's own documented 200–2500 ms
stall envelope) and one **product** defect (the renewal-persist throttle was dead
code, so a 1 Hz heartbeat appended a full-revisions frame every second). Every
phase below is graded by the lanes this phase repairs, and the autonomous loop's
"trust but verify the assertions" pass reads this register.

## 120-minute soak contract (Phase 10)

The user's explicit ask: the plan ships with a 120-minute soak, executed, not
described.

- **Duration:** 120 minutes continuous wall clock, one live app instance, one OMP
  session driving it. No phase may be marked done while the soak is pending —
  the soak is the program's own acceptance gate.
- **Load:** N cycles of the 14 defect scenarios (see `phase-10`), each cycle
  recording pass/fail plus the returned error code.
- **Counters compared against the baseline table above:** per-tool error rate
  (`anti.screenshot.viewport`, `anti.screenshot.full_page`, `anti.theme.qa_validate`,
  `anti.visual.compare`, `anti.media.freeze`), total tool error rate, `TARGET_MISMATCH`,
  `TARGET_STALE`, `TARGET_BUSY_DRAINING`, `NO_RENDER_SURFACE` (split by form),
  `RUNTIME_MISMATCH`, args-parse failures, `xd://mcp__antifan` occurrences,
  compaction count, register byte length, `anti.verification.list().totalCount`.
- **Invariants that must hold for both hours:**
  1. `verification-register.jsonl` byte length never shrinks.
  2. `listVerifications().totalCount` equals the on-disk record count at every sample.
  3. Zero `expects a JSON args object as content`, zero `[object Object]`, zero
     `mcp__mcp__` doubled-prefix errors.
  4. No error carries `TARGET_BUSY_DRAINING` as message while carrying
     `NO_RENDER_SURFACE` as code.
  5. RSS/heap slope over the last 30 minutes bounded (recorded, not assumed).
- **Evidence:** one soak report under
  `plans/260917-1821-antifan-consolidated-remediation-soak/reports/` with the raw
  counter deltas, the scenario matrix, and every invariant's observed value.
- **Bounded runtime:** `scripts/run-omp-soak.cjs` already exists and is the
  runner of record; scenario counts are **computed at run time**, never hard-coded
  in the fixture.

## Cross-plan dependencies

- **This plan blocks `plans/260916-1037-antifan-defect-remediation-master`**
  (status: pending, 0/4 phases). Its phase 4 reconciles 87 register records to
  `RESOLVED` **through the same writer** this plan's phase 1 makes fail-closed and
  disk-authoritative; running it first means reconciling against a stale
  in-memory array and writing through an unguarded wholesale rewrite. The master
  plan's `blockedBy` records this; unblock it when phase 1 is verified.
- **`plans/260917-0341-mcp-dispatch-accounting`** (0/6 phases, but its artifacts
  are materialized in the tree: `accounting:mcp-dispatch`, the per-name aggregate,
  the Hub tab and its acceptance report) is **consumed, not blocked**: phases 6 and
  7 read its gate and its per-name numbers. The per-MCP usage statistics agreed on
  2026-09-18 are carried here explicitly: the count is a dispatch/ledger fact
  (`accounting:mcp-dispatch`, read by the phase 6/7 gate), the Hub MCP Dispatch tab
  renders the aggregate (that plan owns those `toolbar.ts` regions; this plan does
  not touch them except in phase 9), **phase 9 surfaces one usage line from Core
  Health** (`core.health` stats), and **phase 10 re-measures the per-MCP counters**
  across the soak window. A client-side tally is never the source. File-region split is recorded per
  phase: that plan owns `native-tab-host.ts` after `:2247` and the
  `mcp-dispatch` regions of `toolbar.ts`; this plan does not touch them except in
  phase 9, which states its own anchors.
- Both plans stay **independent** per the user's earlier decision (recorded at
  `plans/260917-0341-mcp-dispatch-accounting/plan.md:159`): each phase states the
  exact line regions it owns, and every anchor is a declaration string or
  structural position, never a bare line number.

## User decisions already recorded (2026-09-18)

| # | Decision | Consequence for this plan |
|---|---|---|
| A | Split pane **is** an independent terminal (confirmed with a screenshot: own pane, label "Terminal (Split)", own PowerShell) | M1/M2/M3 all in scope → phase 7 |
| B | Expose `terminal.*` / `browser.wait` on the MCP surface — **approved**, gated by `accounting:mcp-dispatch` | phase 6 |
| C | Restart the app — **approved**, but only **after** phase 1 | phase 1 closes with the restart |
| D | Writes to the evidence store — **approved** (H1/H2/H3), also only after phase 1 | phase 9 |
| E | OMP config `tools.xdev:false` — **approved**, with precheck + immediate revert | phase 6 |
| — | Credential rotation — **not required** (accepted; plaintext token on disk noted, not fixed here) | non-goal |

## Risks

| Risk | Mitigation |
|---|---|
| A wrong signature on any `MCP`/catalogue call breaks the whole control plane. | The user's document lists **7 concrete wrong signatures** already found (`addEventListener` on a text input, `detachTab`, `runFrameAdmissionGate`, `extractDocumentContext`, `issueCommand`, `getDevicesMocks`, `cssPathFor`). Phase 3 starts by verifying the **live** signature of every call it touches. |
| `tools.xdev:false` removes the only working AntiFan path if the native `mcp__antifan` path does not actually exist. | Phase 6: precheck on a throwaway profile, revert immediately on failure, and accept the change only from session-log evidence (it cannot be accepted from inside the product). |
| Adding capture freeze changes pixels, invalidating every stored baseline. | Phase 5 bumps the capture receipt policy identity and forbids cross-boundary baseline comparison; `visual.compare` baselines taken before the freeze change are not comparable by design and are labelled so. |
| Masked failures: an unguarded `catch {}` at `browser-control-port.ts:3646` swallows why a bound tab reports `cause:"probe-unavailable"`. | Phase 4 requirement: the swallow itself is a diagnostic defect — the cause must reach the receipt. |
| TUI scrollback cannot be "fixed" — the alternate screen buffer by design keeps no scrollback. | Phase 7 does not promise scrollback in the alt buffer; it ships a **labelled lossy** transcript view from `getFullBuffer` plus `altScreen` in diagnostics, which is the honest fix. |

## Non-goals

- Cookie SSO (`accounts.haravan.com`) and the 84 dead namespaces: the only probe
  needs a live remote write and the cleanup is a destructive store write — stays
  blocked on explicit approval (report §6 "HOÃN / CHẶN").
- **Deliberately not "fixed" in AntiFan:** `CAPABILITY_ERROR` bodies that are
  correct relays of the agent's own JS errors (`getEventListeners is not defined`,
  `missing ) after argument list`, `Failed to fetch`). Only the **relay form**
  (`[object Object]`) is a defect. Phase 4 fixes the form, never the relay.
- Anything already verified as fixed must not be re-reported: Workflow Hub
  false-positive `passed`, theme-QA fresh state, stale async publish, `openTab`
  retarget, workflow retry taxonomy.
- Nothing in the "not a defect" list of report §5 (e.g. `coveragePct` 20.4,
  cookie flush policy, `SURFACE_DEAD`, `ANTIFAN_SINGLE_INSTANCE_LOCK`).
- No new advertised MCP tool name without `npm run accounting:mcp-dispatch`.
- No test or obligation may be widened, deleted, or weakened to reach green.

## Global success criteria

- [ ] `anti.verification.list()` returns `totalCount ≥ 1000`, equal to the on-disk
      record count, and the register's byte length never shrinks across the phase.
- [ ] A console restart produces registry entries that **pass** `initialize` /
      `renew`; `RUNTIME_MISMATCH` goes from 2444 frames to **0** on the next
      session while it is still logged truthfully for any remaining bad id.
- [ ] One no-argument `tabs.list` returns N tabs with **exactly one**
      `isBoundTab:true`, and that id equals the `all:false` id.
- [ ] `[wait 10000, click]` completes; `assertDeadlineChain` reports no violation.
- [ ] An induced drain returns **code** `TARGET_BUSY_DRAINING`, never message
      `TARGET_BUSY_DRAINING` with code `NO_RENDER_SURFACE`.
- [ ] Full-page capture on a page with an infinite animation settles, or fails with
      a reason that names the real class (`Animation` vs `CSSAnimation`); the
      receipt carries `isMediaFrozen` at raster time.
- [ ] A new session shows **0** `expects a JSON args object as content`, **0**
      `No such tool`, **0** `[object Object]`, and **0** `xd://mcp__antifan`.
- [ ] Tool error rate on a comparable session **< 9.3%**, capture cluster **< 20%**
      (from 77–79%).
- [ ] `npm run audit`, `npm run accounting:mcp-dispatch`, `npm run compile`, and the
      existing unit suite pass **without any test being widened**.
- [ ] The 120-minute soak (§ Phase 10) completes with every invariant holding and a
      written evidence report.
