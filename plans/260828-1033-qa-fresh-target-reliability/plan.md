---
title: "AntiFan QA Fresh-Target Reliability"
description: "Fix ThemeQaWorkflow.validate() P0-1: propagate reload.target (fresh documentGeneration), reorder evidence capture after reload, require load-stable generation settle, remove silent TARGET_STALE fallback; conditional P1-4 enabledChecks hardening; lifecycle regression tests. Extends 260827-2211 (done)."
status: pending
priority: P1
effort: "0.5-1d"
tags: [qa, theme, reliability, target-stale]
created: 2026-08-28
extends: "260827-2211-qa-gate-trust-and-self-qa"
---

# AntiFan QA Fresh-Target Reliability

## Overview

`ThemeQaWorkflow.validate()` currently evaluates browser state against a **stale target**: it reloads the tab but discards `reload.target` (whose `documentGeneration` advanced), so every post-reload `eval`/`dom`/`screenshot`/`listTabs` call uses the old `input.target`. At runtime `NativeTabHost.isCurrentTarget` rejects the stale target with `TARGET_STALE`, scanners swallow the error, and QA silently falls back to pre-reload `rawHtml`/clean defaults — invalidating the QA verdict after every edit.

This plan (ultra winner materialized, with the MUST load-stable contract made explicit — see Ultra Selection → Materialization Correction) propagates the fresh target, reorders evidence capture after reload, **requires a load-stable generation settle** (`did-finish-load`, bounded timeout, generation re-read) before any post-reload capture/eval, removes silent stale fallback, applies conditional internal hardening (P1-4), and adds lifecycle regression tests that model the real reload. Diagnostics policy is explicit: the pre-navigation snapshot is retained (the existing code intentionally snapshots before any `await` because `did-start-navigation` clears the buffer) AND a fresh post-load diagnostics read captures errors from the new generation.

**Scope boundary** (ultra evidence packet): P0-1 is the sole MUST. P1-4 is conditional hardening (public `theme.qa_validate` schema `browser-capabilities.ts:166-176` has no `checklist`; no caller passes it today). Full-chain Test A + CI are deferred release-confidence gates. P1-6 is policy (drop); P1-5 is prompt-layer (drop); P1-3 is deferred. Do NOT re-implement plan `260827-2211` deliverables (buffer clear, origin filter — done).

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Propagate `reload.target` (fresh `documentGeneration`) to all post-reload operations (`inspect`, `eval`, `listTabs`, `report`) | P0 MUST |
| 2 | Reorder evidence capture (`inspect`) to execute **after** reload + load-stable settle so DOM/screenshots reflect post-edit state | P0 MUST |
| 3 | Load-stable generation settle: wait for load completion (bounded timeout, then `TARGET_STALE`/explicit warning); never silent catch-mask `TARGET_STALE` | P0 MUST |
| 4 | Diagnostics policy: retain pre-navigation snapshot (documented behavior at `validate()` start) AND capture fresh post-load diagnostics after settle, with the ordering covered by tests/AC | P0 MUST (policy) |
| 5 | Replace permissive internal caller overrides (`checklist?: Partial<ThemeQaChecklist>`) with `enabledChecks?: Array<keyof ThemeQaChecklist>` | P1 CONDITIONAL |
| 6 | Lifecycle-aware regression tests verifying generation bump, load-settle, stale-target rejection, and diagnostics ordering | P0 MUST (Test) |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Workflow Execution Flow & Target Propagation](./phase-01-workflow-target-propagation.md) | Pending |
| 2 | [Diagnostics Refresh & Conditional Hardening](./phase-02-diagnostics-and-conditional-hardening.md) | Pending |
| 3 | [Lifecycle-Aware Test Harness & Verification](./phase-03-lifecycle-tests-and-verification.md) | Pending |

## Success Criteria (Acceptance)

- [ ] **AC-1 (Target Propagation):** `ThemeQaWorkflow.validate()` uses `reload.target` (updated `documentGeneration`) for all subsequent port interactions (`dom`, `screenshot`, `eval`, `listTabs`).
- [ ] **AC-2 (Evidence Freshness):** `evidence.dom` and `evidence.screenshot` are captured **after** reload AND after the load-stable settle completes.
- [ ] **AC-3 (Load-Stable Settle):** post-reload capture/eval waits for the load-completion signal (bounded timeout; timeout or target-mismatch → `CapabilityError('TARGET_STALE')`) — no silent fallback to pre-reload HTML, no evaluation against a mid-navigation DOM.
- [ ] **AC-4 (Diagnostics Ordering):** pre-navigation snapshot still captures errors that occurred before QA started (preserving existing behavior — snapshot before any `await`); fresh post-load diagnostics read after settle capture the new generation's parse/runtime errors; the report attributes the post-load generation correctly; a test asserts both reads and that pre-navigation errors do not contaminate the fresh-generation findings.
- [ ] **AC-5 (P1-4 Hardening):** caller overrides cannot arbitrarily force checklist pass states; `enabledChecks` limits evaluation scope while the engine computes truth; public `theme.qa_validate` schema unchanged.
- [ ] **AC-6 (Report Fidelity):** final `ThemeQaReport.target.documentGeneration` equals the post-reload generation; report artifacts carry the fresh DOM/screenshot.
- [ ] **AC-7 (Regression Gate):** lifecycle regression suite validates generation bump, load-settle timeout, stale-target rejection, and diagnostics ordering; fails deterministically if `input.target` is reused.

## Deferred Items & Promotion Triggers

| Item ID | Description | Rationale | Promotion Trigger |
| :--- | :--- | :--- | :--- |
| **DEF-01** | Full-chain CLI→MCP→Browser→QA integration test (Test A) | Requires running Electron binary/live CDP in headless test env; tests B/C/D already pass (14/14) | CI runner with display server / XVFB configured, or user defines Final = requires E2E |
| **DEF-02** | Automated CI workflow (`.github`/`.gitlab-ci`) | Repo has no CI configuration | User designates CI hosting provider |
| **DEF-03** | `openTab` retarget alias migration (P1-3) | `bridge-attachment-dispatch.test.js` asserts `antifan_open_tab` retargets automation tab | Dedicated bridge alias contract migration |
| **DEF-04** | Surface audits (stdio proxy, `antifan_eval_js`, plugin-sdk, artifacts) | Read-only hygiene/audit scope, not functional correctness | General codebase audit cycle |

## Risks Carried Forward

- **Load-stability boundary (packet requirement, made explicit):** `reloadAndWait` resolves at `did-start-navigation` (`native-tab-host.ts:2502-2563`, 3s timeout) — NOT `did-finish-load`. `BrowserControlPort.reload()` currently returns only `{ reloaded: boolean }` from `NativeTabHost.reloadAndWait()`. Post-reload capture must not run against a mid-navigation DOM: Phase 2 establishes a load-stable settle (load-completion wait and/or generation-settle re-read with bounded timeout) via a minimal port/event addition; production wiring (`index.ts:182`, `split-review-tabhost`, `control-plane-runtime.ts:99`) must expose it.
- **Diagnostics double-read risk:** `did-start-navigation` clears the diagnostics buffer synchronously (`native-tab-host.ts:1737`); the existing `validate()` deliberately snapshots diagnostics before any `await` (RT-11). Moving capture after reload without a pre-navigation snapshot loses pre-QA errors; skipping the post-load read loses the new generation's parse errors. Mitigation is AC-4 (both reads, ordering asserted by test).
- **Reload timeout:** slow storefronts can exceed the waiter → `reload.reloaded === false` → must throw `TARGET_STALE` with actionable error, not degrade.
- **Mock divergence:** tests must mirror `native-tab-host.ts:4387-4402` (`isCurrentTarget`) and the load-settle contract exactly or the lifecycle bug can slip through.

## Ultra Selection

### Candidates

| Label | Original | Thesis | Score (Verifier, /80) |
| :--- | :--- | :--- | :--- |
| alpha-3 | **Candidate 1 — WINNER** | Surgical target propagation + post-reload capture + fail-fast + lifecycle tests | **75** |
| alpha-1 | Candidate 3 | Regression-test sharpness lens, real reload lifecycle model | 72 |
| alpha-5 | Candidate 2 | 5-phase lifecycle decomposition, defensive catch policy | 67 |
| alpha-2 | Candidate 4 | Risk/trade-off lens, authority-anchored generation gate | 63 |
| alpha-4 | Candidate 5 | Minimal scope/completion lens | 62 |

### Winner & Rationale

**Winner: Candidate 1 (alpha-3, 75/80).** Highest on all four rubric criteria (faithfulness 19, evidence 19, phase sharpness 19, honesty 18). Verifier verdict: satisfies all requirements — P0-1 as sole MUST, P1-4 conditional `enabledChecks` hardening, lifecycle-aware regression testing, exact deferral/drop boundaries, no `NativeTabHost` rewrite, no re-do of plan `260827-2211` deliverables.

### Materialization Correction (load-stable wait + diagnostics policy made explicit)

Candidate 1's text says the navigation-start waiter is "sufficient" and that DOM-eval readiness is handled inside frame queries. Per the evidence packet (and the whole-plan consistency gate), that conclusion **contradicts the MUST**: the waiter resolves at `did-start-navigation`; a post-reload `inspect()`/`eval` running before `did-finish-load` can read mid-navigation DOM, and the 3s waiter returning `false` is the only current failure signal. This plan **amends the winner**: the reload port path must surface a load-completion signal (or a generation-settle re-read) with a bounded timeout, harnessed behind `BrowserHostPort` (testable); the workflow waits for settle before post-reload capture; on timeout/stale → `TARGET_STALE`, never a silent fallback. Second amendment: diagnostics are read twice — the pre-navigation snapshot is retained (existing deliberate behavior, RT-11) and a fresh post-load read after settle supplies the new generation's errors — this ordering is asserted by AC-4, not left implicit. All other winner content is materialized unchanged.

### Rejected Alternatives

- **Candidate 3 (alpha-1, 72):** excellent test design but its test-first emphasis outweighs the minimal production fix; slightly more moving parts.
- **Candidate 2 (alpha-5, 67):** added a separate Phase 3 (defensive exception handling) and Phase 4 (hardening) — correct but more granular than needed.
- **Candidate 4 (alpha-2, 63):** strongest failure-mode analysis but heavier — proposes waiter boundary changes beyond the surgical contract; higher blast radius.
- **Candidate 5 (alpha-4, 62):** correctly minimal but thin on diagnostics-refresh detail; `enabledChecks` wording weaker.

### Risks Carried Forward (materialization note)

- Load-stability wait (did-start-navigation vs did-finish-load) is the central risk; pre-decided response: bounded settle with explicit `TARGET_STALE` — incorporated into AC-3 and Phase 2.
- Diagnostics carry no generation metadata; acceptance proves ordering (both reads, AC-4) rather than relying on timestamps alone.

### Unresolved Questions

1. **Wait-state granularity / port surface:** should the load-completion signal ride the existing `reload` port response, the workflow, or a dedicated waiter (split-view tab host included)? Phase 2 decides with a bounded, testable seam; open until implementation reads the exact waiter code.
2. **Artifact retention:** discard pre-reload artifacts (recommended) to keep reports single-generation?
3. **Pre-navigation diagnostics fate:** keep as a distinct report section, or drop once fresh post-load generation coverage is proven by tests? (Plan: keep; revisit after AC-4 green.)

---

## Red Team Review

_Pending — post-plan red team review will append findings here._

## Validation Log

_Pending — validation will append results here._