---
title: "Detached project WebHub windows"
description: "User-controlled 'open this project in its own window': a detached `project:<id>` shell alongside the singleton 'web' hub, so a 3-monitor setup runs 1 Terminal Manager + hub + optional detached project shells. Includes diagnose-first classification of field-reported MCP blockers from the pixel-compare workflow."
status: done
priority: P1
effort: "M-L"
tags: [multi-window, project, detach, architecture, mcp-blockers]
blockedBy: [260930-0945-multi-window-binding-and-annotation-routing, 260927-0315-project-windows]
created: 2026-10-01
---

# Detached project WebHub windows

> **For agentic workers:** every line-number citation was verified during planning and re-verified at red-team; treat drift over ±50 lines as a signal to re-read, not to guess. Phases are ordered P1→P5; no phase may land without its predecessor's regression gates green.

## Overview

Mode: `--deep --advice`. HOLD SCOPE. Kongming counsel: **GO** — Option B (singleton hub + on-demand detached `project:<id>` shell). Full-revival (Option A) rejected: strictly more expensive, revives the topology class that produced the `2026-09-30` incident, delivers nothing detach doesn't.

The 3-monitor ask: screen 1 = WebHub (or detached A), screen 2 = detached B, screen 3 = the single shared Terminal Manager. Detach is **opt-in per project** — `openProject` still routes to the singleton hub; a new explicit **Detach** action (menu + IPC) detaches.

## Decisions locked (validation 2026-10-01)

1. **Entrypoint:** explicit `detachProject(projectId)` action — menu item + IPC route, surface-constrained to sidebar/toolbar family. `openProject` unchanged.
2. **Tabs on detach:** detaching a hub-presented project **transfers its live tabs** to the detached shell (live ingest); keeping them on the hub violates exclusivity and mis-attributes mints.
3. **Close semantics:** closing a detached window keeps the project detached (marker persists, NO fold — solves the quit-vs-user-close intent problem by construction). **Reattach** is a separate explicit action: close → post-dispose scoped fold → live hub ingest. Boot **always restores** marked shells — detach is a mode, closed-at-quit restores identically (user decision 2026-10-01); Reattach is the only exit.
4. **Sessions are project-owned, not window-owned:** `project:<id>` owner keys are shared between hub and detached shell by design; exclusivity (only one window presents X) is the real invariant, not per-window session isolation.

## Why this is cheap (evidence, not estimate)

- **Renderer chrome already tri-state** `{project|web|unassigned}`: `parseProjectWindowIdentity` (toolbar.ts:5414), `shellScopeActionPlan` (standalone.js:106+), `projectWindowIdentity` (native-tab-host.ts:7382-7404). Tests assert project-owner payloads (`test/main/project-window-persistence.test.ts:1618-1686`). Commit `8ccc3ec4` retired topology, not the renderer contract.
- **Owner-key algebra intact**: `project:<id>` parses (`parseOwnerKey` at `src/main/project/project-context.ts:74-86`; `ownerKey` at window-owner.ts:18-23), terminal sessions mint under it, `ProjectWindowManager` (305 lines, owner-generic) survived retirement whole.
- **0945 fixes are host-count-generic**: ambient authority refuses ambiguity typed (`tab-ambient-authority.ts:51-66`), bridge dispatch routes by `directory.hostForTab` (index.ts:3693), annotation gates are owner-keyed (:4494, :4547).
- **Retirement was routing-only** in index.ts: `ensureProjectWindow` normalizes `project→web` (:1596); per-owner affiliation/seeding moved into `activateWebHubProject` (:1653-1694). Baseline template: pre-retirement `ensureProjectWindow` ~1503-1566 (via AntiFan-baseline worktree @3577fadf).

## Global invariants

1. **Terminal Manager singleton** — 'unassigned' arms untouched; never a second one.
2. **Fold safety** — no `detached:true`-marked `project:*` record may reach `saved-tabs.json` while the legacy fold exists unscoped. Marker schema → write → fold-skip is one atomic unit with the detach entrypoint.
3. **Per-project exclusivity** — a project is presented in the hub XOR detached shell. Enforced main-side, hoisted above `ensureProjectWindow` in open paths AND as a funnel guard inside `activateWebHubProject`.
4. **Fold is intent-gated** — runs ONLY via explicit `reattachProject`, only on confirmed user-close disposition, only AFTER the dying host's final `persistSync`. Never hooked to `notifyShellGone`/`closed`/`onCloseRequest`.
5. **Fail-closed preserved** — every new seam refuses typed; no ambient fallback reintroduced.
6. **Default path regression-free** — existing e2e hub-model guards (`project-windows.test.ts:564-567, 586-587`) pass unmodified; `hubRowVisible` keeps its shipped exception for project/web/unassigned rows with a live-detached exemption.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Detach capability: entrypoint, exclusivity, fold marker](./phase-01-detach-capability.md) | Done |
| 2 | [Detach lifecycle: reattach, removeProject, purge](./phase-02-detach-lifecycle.md) | Done |
| 3 | [Boot restore + placement](./phase-03-boot-restore.md) | Done |
| 4 | [MCP field blockers (diagnose-first) from Levents pixel-gate report](./phase-04-mcp-field-blockers.md) | Done |
| 5 | [Live proof + e2e rows](./phase-05-live-proof.md) | Done |

## Success Criteria

- [x] `openProject` default → singleton hub, zero detached shells (existing e2e guards pass unmodified). — probe leg1 (`reports/detached-webhub.json`); e2e 21/0
- [x] `detachProject(X)` via real entrypoint → exactly one `project:<id>` shell; `authority.snapshot()` shows ownerKey `project:<id>`; chrome renders (project chip, tabs, sidebar). — probe leg2; e2e `detached-project-shell-lifecycle`
- [x] Exclusivity (live + marker): `openProjectWindow(X)` detached-live → FOCUSED, no phantom hub; marked-dead → recreate detached shell, hub never presents X; `activateWebHubProject(X)` refuses/focuses; detach of hub-presented X transfers live tabs + clears affiliation; boot never double-presents (hub-X AND detached-X simultaneously impossible). — probe legs 3a/3b; e2e `detached-project-exclusivity`; phase-03 suppression tests (restore suite 17/17)
- [x] Sessions minted in detached window stamped `project:<id>`; detached host `tabsForProject(X)` > 0; `hubRowVisible` exempts detached-owned project rows only. — probe leg4; stamp/doc-prefs unit rows (phase-01 report); hubRowVisible predicate code-verified, live exercise deferred → R3
- [x] Fold never consumes a `detached:true` record; legacy unmarked `project:*` records still fold into `owners.web`. — marker/fold suites 11/11 (phase-01 report)
- [x] Ordinary close/quit leaves marker intact, fold never fires; `reattachProject(X)` (ARM A live / ARM B marked-dead) → post-dispose fold + live hub ingest, tabs visible without restart; post-fold hub persistSync re-read confirms `owners['project:X']` stays absent. — probe leg7; e2e `detached-project-reattach`; fold-spy test (phase-02 report)
- [x] removeProject on detached project: ordered close→settle→purge leaves zero residue; veto propagates. — lifecycle tests `['close','purge']` ordering + veto→CLOSE_REFUSED (phase-02 report); coordinator 42/0 post-F1
- [x] Cold restart: marked records restore shells (open-or-closed-at-quit identical); dead-project records never resurrect (registry check, not just `isKnownProjectId` — it returns true for bootProjectId :680-681). — restart probe 5/0 (`reports/detached-webhub-restart.json`); `detachedRestoreAdmitsProject` predicate tests 17/17
- [x] Terminal Manager count stays 1; detached persist doesn't clobber hub document prefs. — probe invariant row; doc-prefs gate test (phase-01 report)
- [x] Field blockers (phase-04) classified + resolved: each symptom gets a confirmed-bug fix, a documented design constraint, or a written gap report; unfocused-visible capture + committed-navigation staleness verified under the detached topology where capability is confirmed. — `reports/phase-04-report.md` + `phase-04-diagnosis.md`; probe leg5b
- [x] Bridge mint resolver (index.ts:3680-3684) is detached-aware — project mints reach the detached host. — `createBridgeMintHostResolver`, affinity suite 17/0; probe `TERMINAL_SCOPE_UNRESOLVED` verbatim

## Execution Report

Executed 2026-10-01: all 5 phases landed + post-land code-review fix pass (F1–F8 fixed; F9 dead param / F10 menu no-op left as-is, documented). Reports: [phase-01](reports/phase-01-report.md) · [phase-02](reports/phase-02-report.md) · [phase-03](reports/phase-03-report.md) · [phase-04](reports/phase-04-report.md) + [diagnosis](reports/phase-04-diagnosis.md) · [phase-05](reports/phase-05-report.md) · [code-review](reports/code-review.md).

**Evidence:** probe `reports/detached-webhub.json` 24/0 + `detached-webhub-restart.json` 5/0 (+ `detached-webhub.log`); e2e 21/0 (`plans/260927-0315-project-windows/reports/project-windows-e2e.json`); `npm run test:main` 2229 pass / 1 unrelated flake (`history-manager` mtime debounce).

**Kongming final verdict (KmGate5): PASS_WITH_CONCERNS.** Residuals:

- **R1** — occluded-starvation not exercised end-to-end (unfocused-visible proven live; the starved row refused typed via `NO_RENDER_SURFACE`, real occluded-window BeginFrame suppression unproven under detach).
- **R2** — re-detach can leave a stray hub home tab.
- **R3** — test-seam-for-settle coverage gap (close driver stands in for `handle.settled`); `hubRowVisible` live-detached exemption not exercised end-to-end.
- **R4** — wire-contract break needs field propagation: navigation misses now report typed causes (`NAVIGATION_TIMEOUT`/`NAVIGATION_START_TIMEOUT`/`LOAD_FAILED`/`NAVIGATION_BLOCKED`) instead of blanket `TARGET_STALE`, and `TERMINAL_SCOPE_UNRESOLVED` replaces the silent hub fallback for marked/latched projects — consumers keyed on the old codes must re-key (see `reports/phase-04-report.md` §Wire-contract change).

## Risks

| Risk | Signal it broke | Response |
|------|-----------------|----------|
| Fold/persist ordering (red-team Critical ×2) | zombie `project:*` record; duplicated folded rows | intent-gated post-dispose fold only; spy-tested |
| Phantom hub on exclusivity refuse | shellCount grows on refused flip | hoist detached-liveness check above `ensureProjectWindow` |
| Detached host mints `undefined` stamps | `tabsForProject(X)`=0 forever | derive stamp from owner key (Finding FA7) |
| Plan 260927-0315 merges first with unmarked records | old builds fold detached records | `blockedBy` enforced as merge order; marker schema ships in phase-01 regardless |
| Field symptom D2 has no certification producer | compare oracle dead by design | phase-04 documents the gap honestly; doesn't weaken the gate |
| Frame starvation is OS-level (occluded windows) | unfocused captures still fail | fix targets visible-unfocused only; occluded may stay typed-refuse |

## Field evidence incorporated

`E:/Work/customizes/Levents/plans/260920-1833-levents-storefront-rebuild/reports/antifan-pixel-gate-blocked.md` (2026-10-01) + session jsonl: three field-observed symptoms (frame starvation on background tabs, baseline certification gate with no discoverable producer, `TARGET_STALE` false positives) plus a bound-tab authority observation — see phase-04. These blocked the pixel-compare QA loop that detached windows exist to serve. Note: root causes were `[INFERENCE]`/`[CHƯA XÁC MINH]` in the field report; phase-04 is diagnose-first, not presupposed fixes.

## Relationship to prior plans

- `260930-0945` (done): provides the fail-closed seams this plan depends on.
- `260927-0315` (in-progress, independent project windows): same outcome, wider scope (window per project by default). **Kept in-progress** (user, 2026-10-01): this plan stays narrower; `blockedBy` merge-order guard stands; this plan archives if 0315 resumes first.

## Open questions

1. `OpenIntent` for boot restore: add `'restore'` intent (presents unfocused) vs first-shell-'user'-then-'agent' sequencing — resolved at phase-03 impl after reading `presentShellOnFirstPaint` (:1619).
2. ~~260927-0315 disposition~~ — RESOLVED (user, 2026-10-01): keep in-progress; this plan stays narrower; `blockedBy` merge-order guard stands; archives if 0315 resumes first.
3. ~~Closed-detached restore UX~~ — RESOLVED (user, 2026-10-01): always-restore; detach is a mode, Reattach is the exit (folded into Decision 3).

## Red Team Review

### Session — 2026-10-01
**Findings:** 15 unique (deduped from 26 across Security Adversary, Failure Mode Analyst, Assumption Destroyer). All evidence-backed, all accepted.
**Severity breakdown:** 5 Critical (fold/persistSync ordering; quit-fires-fold intent leak; hubRowVisible exact-match regression; join-path unconditional activate; session owner-key collision making leg4 unverifiable), 6 High (phantom hub creation; live-hub never ingests fold; fold-vs-purge ordering; undefined stamps; bridge mint resolver hub-pin; boot restore intent), 4 Medium (doc-prefs leak; affiliation ordering; probe-entrypoint gap; citation corrections + bootProjectId loophole + LIVE-leg redundancy).

| # | Finding | Severity | Disposition | Applied To |
|---|---------|----------|-------------|------------|
| 1 | persistSync bypasses write queue; fold must be post-dispose | Critical | Accept | Phase 2 |
| 2 | quit fires fold via notifyShellGone — intent-gate fold or change semantics | Critical | Accept (modified: semantics changed — close keeps detached) | Phase 2 + plan |
| 3 | hubRowVisible exact-match breaks shipped move flow | Critical | Accept (real predicate: live-detached exemption) | Phase 1 |
| 4 | join arm calls activateWebHubProject unconditionally | Critical | Accept (split join/create arms) | Phase 1 |
| 5 | owner-key collision — leg4 no-leak unverifiable | Critical | Accept (modified: sessions are project-owned; leg4 asserts stamping) | Phase 5 + decisions |
| 6 | boot-restore shells never presented — intent missing | High | Accept | Phase 3 |
| 7 | reattach fold is file-only; live hub can't see it | High | Accept (live-ingest seam required) | Phase 2 |
| 8 | exclusivity guard inside activateWebHubProject too late — phantom hub | High | Accept (hoist to openProjectWindow) | Phase 1 |
| 9 | removeProject fold-vs-purge ordering unspecified | High | Accept (explicit ordered close→purge, no fold on remove) | Phase 2 |
| 10 | detached host lacks activeProjectId — stamps undefined | High | Accept (derive from owner key) | Phase 1 |
| 11 | bridge mint resolver pins project mints to hub | High | Accept | Phase 5 + criteria |
| 12 | OQ2 'hub keeps tabs' violates exclusivity | High | Accept (decision: transfer live tabs) | Phase 1 + decisions |
| 13 | detached hosts overwrite doc-level prefs | Medium | Accept (owner-gate doc prefs) | Phase 1 |
| 14 | affiliation-clear ordering unspecified | Medium | Accept (affiliation null before scope null) | Phase 1 |
| 15 | probe seam bypasses real entrypoint; citations wrong; bootProjectId loophole; LIVE leg redundant; IPC surface constraint | Medium | Accept (all folded in) | Phases 1/3/4 + plan |

### Whole-Plan Consistency Sweep
- Files reread: plan.md, phase-01…phase-05 (post-edit, this session)
- Decision deltas applied: close≠fold semantics; transfer-on-detach; explicit entrypoint; project-owned sessions; intent-gated post-dispose fold; live-ingest reattach; hoisted exclusivity (live shells AND persisted marker — marked-dead open recreates detached, never hub-presents); owner-derived stamps; real-predicate hubRowVisible; registry-validated boot restore; field-blockers phase (phase-04, diagnose-first); reattach two arms (live + marked-dead); post-fold coherence assert.
- Stale references reconciled: OQ2/OQ3 resolved into Decisions; phase-05 legs 4/5/7 rewritten; criteria aligned to classification-based outcomes; citations corrected (parseOwnerKey → project-context.ts:74-86; annotation gates :4494/:4547; removeProjectEntry :2194); renamed phase-04 filename grep-verified absent.
- Kongming FinalGate (2026-10-01): **GO-WITH-CONDITIONS** — C1 marker-consult exclusivity applied (phase-01); C2 marked-dead reattach arm applied (phase-02); C3 post-fold coherence applied with corrected ordering — ingest into hub memory BEFORE forced persist, assert owners['project:X'] absent AND transferred tabIds survive; C4 resolved by user: always-restore (Decision 3).
- Post-FinalGate sweep (this session, after C3-ordering fix): all 5 phase files + plan.md re-read in full; stale-term grep clean (old filename, 'close = reattach', 'hub keeps tabs' as live spec, '4 phases', pending-decision wording for 0315/C4); phase-05 leg5b conditional on phase-04 verdicts; phase-03 always-restore wording consistent with Decision 3; reattach order = fold → ingest memory → persist → re-read asserting absent key AND surviving tabIds.
- Unresolved contradictions: 0

<!-- slug: detached-project-webhub-windows -->
