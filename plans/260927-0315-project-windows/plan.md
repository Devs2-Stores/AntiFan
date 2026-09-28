---
title: "Project Windows shared-runtime implementation"
description: "Independent project browser windows with exact agent routing, protected closing and multi-monitor placement."
status: in-progress
priority: P1
effort: ""
tags: [architecture, electron, frontend, authority]
blockedBy: []
blocks: [260817-2217-rebuild-chromium-first-project-ui-and-workflow, 260817-1931-rebuild-chromium-first-native-harness]
created: 2026-09-27
---

# Project Windows implementation plan

> **For agentic workers:** Read the linked spec and all phase contracts first. After user review and execution-method selection, use `subagent-driven-development` or `executing-plans`. Phase checkbox lists track implementation, not planning completion.

**Goal:** Simultaneously usable project browser windows with exact agent routing and protected lifecycle.

**Architecture:** One Main-owned tab authority and shared services; independent native presentation shells. Sender-scoped user intentions and authenticated agent intentions converge on exact tab identities, never visual focus.

**Tech Stack:** Existing Electron, TypeScript, native WebContentsView, renderer HTML/CSS and Node test infrastructure; no new UI framework.

**Spec:** [Project Windows design](../../docs/superpowers/specs/2026-09-27-project-windows-design.md).

## Global constraints

- Minimum usable window: 960x640 DIP.
- Certification: five projects, twenty user-visible tabs, two simultaneously visible physical-monitor surfaces and background agents.
- Keep existing isolateSession behavior; no cookie migration or live partition reassignment.
- No tray/windowless engine mode, force-close override, new registry or per-window service runtime.
- Product edits require written-plan review and execution-method selection.

## Review focus

1. Late native shell veto after child pages close: shared services must survive; phase 4 tests shutdown ordering.
2. Agent-only missing-window creation with saved maximization: remain hidden and unfocused; phase 3 live probe.
3. Sender reload/reused identifiers: stale renderer cannot acquire another shell; phase 2 sender lifecycle tests.
4. Ambiguous historical roots: retain Unassigned instead of guessing; phase 2 migration tests.
5. Capture while another project has text focus: no presentation transfer or focus change; phase 5 live split/background matrix.

## Overview

Mode: --deep --advice. HOLD SCOPE. Planning only; implementation requires review and execution-method approval. [Canonical spec](../../docs/superpowers/specs/2026-09-27-project-windows-design.md).

One window per project enables simultaneous A/B viewing on separate monitors. Keep one NativeTabHost tab/automation authority, one set of services, and extract project presentation shells. No tray, per-project service runtime, cookie migration or focus-based authority.

## Phases

Complete dependency-ordered navigation. Phases 1 and 2 are in progress (phase 2 steps 1–4 verified); phases 3–5 remain pending.

1. [Shared tab authority and project shells](phase-01-start.md)
2. [Trusted affiliation and routing](phase-02-routing-authority.md) — depends on 1.
3. [Project UI, search and placement](phase-03-project-window-ui.md) — depends on 1–2.
4. [Protected close and shutdown](phase-04-close-and-shutdown.md) — depends on 1–3.
5. [Certification and docs cutover](phase-05-certification.md) — depends on 1–4.

## Architecture decisions

- Singleton NativeTabHost keeps global tab identity, queues, sessions and automation; ProjectWindowManager and ProjectWindowShell separate presentation. No duplicate current host construction.
- Project/capsule/workspace IDs remain distinct. Unique historical mapping only; ambiguity is Unassigned, conflicting authenticated creation is refusal.
- Search is available from every window. Explicit user selection focuses the exact owning project/Unassigned window; normal renderer tab operations remain local and agents never raise windows.
- Project close honors unload and blocks busy/unknown. Final browser close/explicit Quit gate all shared work; no new windowless browser runtime. Existing detached terminal daemon survives by its existing lifecycle policy.
- Five phases are retained because ownership extraction, authority cutover, user surface, destructive lifecycle and empirical certification have separate risk gates. Shared-file edits execute sequentially.

## Dependencies and overlap

Scanned status fields of 69 direct project plan indexes. Two historical Harness/UI plans now consume this window contract and have reciprocal blockedBy entries. Their unrelated renderer/backend work is not prerequisite. Older host-helper extraction and terminal-daemon plans share files; rebase on current verified source before implementation, but do not block on unrelated unfinished goals or rewrite their lifecycle. [Research boundaries](reports/research-boundaries.md).

## Advisory checkpoint

Kongming identified duplicate global IPC registration as first failure and recommended singleton tab authority plus per-project shells. Adopted. Its suggestion to wait for all historical helper extraction is not adopted: current source already contains modular helpers and unrelated unfinished capability work is not a functional prerequisite. Shared-file integration remains sequential. No claim that advice is runtime proof.

## Success criteria

- [ ] All 12 spec criteria plus cross-project search behavior exercised on real Electron.
- [ ] Five projects/twenty tabs, two physical monitor surfaces, no focus stealing or permission widening.
- [ ] Protected close, unload veto, binding races, final Quit and detached daemon survival verified.
- [ ] Typecheck/compile/focused and relevant broad regressions pass; current architecture docs updated afterward.

## Review and validation status

Two independent adversarial reviews completed: routing/persistence (eight findings) and lifecycle/certification (four grouped findings). Incorporated explicit preallocation authorization, shell-local selection, single persistence owners, standalone preload coverage, terminal cwd provenance, stale search ordering, unload/late-veto sequencing and executable smoke commands. Existing reservation, daemon distinction and test:main requirements were retained rather than duplicated; rejected suggestions for deprecated constructor/active-tab shims in favor of caller migration. Electron API research informs constraints, not installed-runtime certification.

`ak plan validate plans/260927-0315-project-windows --json` returned valid=true. A local link probe checked six plan files and ten links with no missing target. Existing-path probe found only the manager/shell paths deliberately created by phase 1. Phase checklists constitute the pending implementation task breakdown; none is marked implemented. No product tests or live Electron acceptance ran during planning. User written-plan review and execution-method choice remain required.

### Implementation status (2026-09-27)

Post-planning execution began under the selected method. Phase checklists are now being marked as they are verified; the planning statements above describe the planning session and are kept as written.

- Phase 1 deliverables (`ipc-router.ts`, `tab-authority-directory.ts`, `project-window-shell.ts`, `project-window-manager.ts`, `BrowserControlPort` host resolution) exist and are exercised by the live two-window Electron probe: two shells, two hosts, 115 routes registered once, per-window sender resolution, cross-window toolbar refusal.
- Phase 2 steps 1–4 are implemented and verified; step 7 partially. Steps 5 (terminal workspace cwd provenance) and 8 (zero-argument active-tab queries for bridge/menu) remain, along with phase-4 window teardown. Evidence: [reports/phase-02-verification.md](reports/phase-02-verification.md).
- Regression state at this point: typecheck clean, main lane 1459/1460 pass (1 pre-existing skip), unit 668/668, integration 13/13, fast 1430/1435 (5 pre-existing skips), 0 failures.
- Success criteria remain unchecked: no five-project/twenty-tab multi-monitor acceptance, no protected-close matrix, and the architecture docs are not yet updated for the new authority model.
- Documentation cutover (later the same day): `docs/ui-architecture.md` now describes the shipped per-owner window model, the corrected chrome-IPC registration, and a close/quit/admission section; the design spec carries an acceptance-receipt table naming the instrument for each criterion and marking the hardware-dependent ones `NONE`. Protected-close/quit evidence for the shipping entrypoints is `reports/quit-coordination-probe.{json,log}` (22 checks, 0 failed, run 2026-09-27T11:37Z) and the multi-window/sender/search evidence is `reports/project-windows-probe.json` (22/0, run 09:47Z); both runs predate the latest edits to the coordinator, shell and tab host, so they are not a certificate for the current tree. The phase-5 matrix harness `scripts/probe-project-windows-matrix.cjs` is written but had not produced its receipt at this point — the five-project/twenty-tab multi-monitor acceptance remains unobserved.
- Cutover change set (still 2026-09-27, landing after the matrix's first run): the single `projectRegistry` in `index.ts` is now the one runtime authority for project identity — `synchronizeCapsulesWithRegistry` projects every explicitly-affiliated capsule into it at boot, per `ensureWindow` and in `whenReady`, and the same instance is `WorkspaceCapsuleManager`'s `affiliationAuthority` and `ControlPlaneRuntime.projects`. Terminal `capsuleId` provenance now crosses the daemon wire (`DaemonTerminalProxy` + `protocol.ts`), and every caller of the daemon-shaped singleton awaits creation; split review never reloads a sibling already on the mirror URL and seeds the mobile mount as a desktop-authority transaction; chrome bounds have a single writer (`setToolbarOverlay` re-runs the canonical layout, `disposeChrome` nulls the toolbar view with post-disposal readers failing closed); the matrix harness's `R5a`/`R7`/`R10a`/`R10b`/`R8a` defects are corrected. Phase-2 step 5 is therefore implemented in source (step 8 untouched). New coverage: `test/main/capsule-registry-synchronization.test.ts`, `test/main/terminal-daemon-provenance.test.ts`, plus additions to `split-review-tabhost`, `project-window-persistence` and `bridge-server` suites. **Verification pending** — `npm run typecheck`/`compile`, `test:fast`/`test:main`/`test:integration`, the named focused suites, and the matrix harness re-run (`scripts/probe-project-windows-matrix.cjs`) have not executed against this tree; the only matrix run on record is the pre-fix log above. **Superseded by the Phase-5 certification entry below**: the checks this change set needs have since run against this tree — `npm run typecheck` clean and `npm run test:main` 1820 passed / 0 failed / 1 pre-existing skip (the lane that carries the new `capsule-registry-synchronization` and `terminal-daemon-provenance` suites plus the extended `split-review-tabhost`, `project-window-persistence` and `bridge-server` ones), and the matrix at 34 `PASS` / 0 `FAIL` / 3 hardware `BLOCKED`. The phase-wide `test:fast`/`test:integration` lanes were not re-run for phase 5.

### Phase-5 certification (2026-09-27, latest)

- The acceptance matrix ran green on the real Electron surface:
  `plans/260927-0315-project-windows/reports/project-windows-matrix.json` (written 2026-09-27T20:20:08Z, host pid 28860, data root token
  `antifan-pw-matrix-I57BZk`) records **34 `PASS`, 0 `FAIL`, 3 `BLOCKED`** with all 37 declared rows
  judged; exit code 2. The three blocked rows are the physical-hardware ones (`R1-HW` two monitors
  with a person confirming both are usable, `R2-HW` real foreground focus and keyboard stability,
  `R6-HW` a monitor unplugged and the OS scale changed) and no fixture stands in for them.
- `R9E` (no owned process survived the exit) is `PASS`, merged by the second process at 20:20:34Z from
  the watcher report of **this** run (written 20:20:33.680Z), after the merge refused the previous
  run's report (hostPid 17732) that was still on disk. The merge binds the report to the receipt's
  own host pid and data root token and waits for it: the first attempt at 19:57 folded a previous
  run's report (hostPid 21420) because it read whatever file existed before this run's watcher had
  written.
- A criterion-4 defect was found while strengthening the rows and fixed in the shipping host: a new
  tab's capsule defaulted to the process-wide active capsule instead of its own window's verified
  workspace, and a `window.open` child never inherited its opener at all — so a tab created in
  window B while window A was active was filed under A's capsule. `resolveNewTabCapsuleId`
  (`src/main/browser/native-tab-host.ts`) now resolves measured → own window → active, and the
  window-open handler passes the opener's capsule. Proved by a pre-fix/post-fix receipt pair on the
  same instrument: `plans/260927-0315-project-windows/reports/project-windows-matrix-before-capsule-fix.json` fails `R4a2` and `R4b`
  with the other window's capsule, `plans/260927-0315-project-windows/reports/project-windows-matrix.json` passes both.
- `R9c` kept the detached host's identity (pid 17532, port 65272, token/version unchanged, mode
  `attached`) and drove the pre-existing session `terminal-2` to the marker `matrix-pty-muk9imck`
  after the teardown, then confirmed by pid that the host it started was gone; `R9d` found no
  surviving page processes; `R9b` observed the committed quit (6 shells before → 0 after,
  `will-quit` delivered and held, 1 auxiliary → 0, `shutdown.begin`/`shutdown.clean` once each, no
  `shutdown.forceExit`, 0 live windows, both `quit.outcome` entries committed without survivors).
- Three shipping fixes were needed to get there and are source-verified in
  `phase-05-certification.md`: an unverifiable/orphaned run no longer blocks a quit it cannot
  interpret (`close-live-use.ts` + the run store), the committed-quit force-exit watchdog yields to a
  delivered `will-quit` instead of killing a vetoed quit two seconds later, and a new tab's capsule
  resolves to its own window's verified workspace rather than the process-wide active capsule
  (`resolveNewTabCapsuleId`, plus opener inheritance for `window.open` children).
- Regression state: `npm run typecheck` clean; the matrix 34 `PASS` / 0 `FAIL`; the new capsule unit
  file 5/5; `test/e2e/project-windows.test.ts` 1/1; `npm run test:main` 1787 passed / 33 failed / 1
  pre-existing skip, where the 33 failures are the same lane's bridge-pairing, local-IPC and
  Windows-ACL suites failing identically with and without the capsule change (they pass in isolation
  and in a six-file parallel group) — environment-scale contention in that lane, recorded as such in
  the phase-5 checklist, not a criterion-4 regression.
- Plan success criteria stay unchecked: the three hardware rows still need a person at the machine,
  and the user's review of this evidence precedes any commit or publish beyond granted scope.

## Tooling
