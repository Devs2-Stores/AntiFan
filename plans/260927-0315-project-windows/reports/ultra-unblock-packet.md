# IMMUTABLE EVIDENCE PACKET — "what is the best direction to unblock Project Windows Phase 4→5"

Frozen 2026-09-27. Same packet goes to all five candidates. Candidates are **read-only**:
do not edit/create/delete files, do not run builds/tests/formatters/long processes, do not push git.
Read the repo (`E:/Work/apps/AntiFan`) and this packet, then answer the QUESTION at the end.

## The stuck problem (one sentence)

Phase 1–4 of `plans/260927-0315-project-windows/` are implemented and wired, but the Phase-5
acceptance matrix on the current tree fails 10 of 22 rows, and the remaining work is a tangle of
interlocking lifecycle/authority defects where fixing one row risks another. What is the single best
direction (technique + concrete unblock path) to finish Phase 4 verification and Phase 5 certification?

## Task / request text (verbatim, user)

Goal: `/skill:ak:cook --auto --parallel --advice Spawn Max Subagents triển khai full toàn bộ các Phase đi`
Latest: `--advice --ultra Hướng nào tốt nhất cho tôi thì làm đi KongMing`
Earlier, on the same work: "Tôi đang rối vài trường hợp làm việc vởi 3-5 Project" — the user runs 3–5
project workspaces concurrently across up to 3 monitors as a single developer on Windows 11.

## Confirmed constraints (non-negotiable)

1. Single-developer Windows 11 workstation; no enterprise multi-tenant scheduling abstractions.
2. Plan globals (`plans/260927-0315-project-windows/plan.md`): min window 960x640 DIP; certification
   needs five projects / twenty tabs / two physical-monitor surfaces / background agents; keep
   `isolateSession` behavior (no cookie migration, no live partition reassignment); **no tray or
   windowless engine mode, no force-close override, no new registry, no per-window service runtime**.
3. Fail-closed. No timeout-driven destruction; "unknown" retains the shell. A busy/unknown page blocks
   destruction with an actionable reason. No force override. Missing terminal state = unknown, not idle.
4. Never touch the user's live sessions/processes; certification must use throwaway profile/data root.
5. Repo contract (`AGENTS.md`): never mock internal logic; never weaken tests; every completion claim
   needs live telemetry; a fact claim about code must cite file:line.
6. AntiFan MCP is the primary browser evidence surface; Playwright only under the recorded fallback policy.

## Acceptance criteria (Phase 5 matrix, the thing that must go green)

Rows R0, R1, R1-HW, R2, R2-HW, R3a–R3c, R4a–R4f, R5a–R5b, R6a–R6b, R6-HW, R7, R8a–R8c, R9a–R9c,
R9E, R10a–R10b, R11, R12a–R12b. Instrument: `scripts/probe-project-windows-matrix.cjs`
(`node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs`, then `--verify-orphans`).
Receipt: `plans/260927-0315-project-windows/reports/project-windows-matrix.json` (does not exist;
the run wrote a log but no receipt, and the post-exit orphan watcher produced no report).
Close/quit instrument: `scripts/probe-quit-coordination.cjs` → `reports/quit-coordination-probe.json`.

## Observed symptoms — current tree, run 2026-09-27T14:39Z (`reports/project-windows-matrix.log`)

PASS: R4e, R4a, R1, R4a2, R4b, R3b, R4f, R5b, R11.
BLOCKED (by design, hardware/human): R1-HW, R2-HW; plus R9E (no watcher report).

FAIL, with verbatim messages:

- `R2`: "the authorized open-tab for B was refused: {\"ok\":false,\"code\":\"WORKSPACE_MISMATCH\",\"message\":\"Workspace 'workspace-00000000-0000-4000-8000-0000000000d2' is not attached to Project 'project-00000000-0000-4000-8000-0000000000d2'\"}"
- `R4c`: "the agent-created child from R2 is missing" (downstream of R2)
- `R3a`: "the authorized dispatch while B was minimized failed: {WORKSPACE_MISMATCH … 0d2}" (same cause)
- `R3c`: "Cannot read properties of null (reading 'executeJavaScript')" (downstream: no agent child tab exists)
- `R5a`: "B's native tab-view rect could not be measured: before=null after=null"
- `R6a`: "window A did not close (shell count 2)"
- `R7`: "no terminal session could be created for B" (`terminal.createSession(BETA.path, BETA.capsuleId)`)
- `R10a`: "the page input read back as '' before the session ended"
- `R10b`: "the page input read back as '' before the drop"
- `R12a`: "the toolbar viewport is 1184px wide but the native geometry says 944px"
- `R12b`: "the toolbar viewport is 1184px wide but the native geometry says 1920px"

Post-exit: `reports/project-windows-matrix-orphans.log` → `verdict: BLOCKED - the post-exit watcher
produced no report, so no post-exit orphan observation exists.`

## What was already tried (do not re-propose these)

- Phases 1–4 implemented: single Main-owned tab authority (`tab-authority-directory.ts`), per-project
  native shells (`project-window-shell.ts`, `project-window-manager.ts`), native unload-aware close,
  `project-close-coordinator.ts` state machine, `PageCloseReservations` injected into every admitting
  seam, bounded close answers, `revokeGoneOwnerAttachments`, member pages read from the host authority.
- Earlier runs: `reports/quit-coordination-probe.json` (22 checks, 0 failed, 2026-09-27T11:37Z) and
  `reports/project-windows-probe.json` (22/0, 09:47Z) — both **predate** later coordinator/shell/host
  edits, so neither certifies the current tree.
- An earlier matrix run at 21:06Z produced `reports/project-windows-e2e.json`; the 14:39Z run above is
  the newest.
- Advisory STOP findings recorded in the todo list, not yet resolved: (a) shell-scoped busy evidence
  ignores in-flight admitted operations; (b) a refusal may name a non-existent recovery control;
  (c) application admission is never enforced during quit; (d) no shutdown-watchdog coverage on a
  normal quit.
- Known-open todo items: "a closed shell must leave no chrome content alive and must stop wedging the
  next window's toolbar (root cause: leftover toolbar#2 / stale live bookkeeping)"; "a live terminal
  popout that is invisible to the committed quit (host-independent census)"; "settle empirically
  whether every close path can reach an honest outcome (closed/vetoed/unknown) without a timeout".

## Evidence gathered by the controller (cite these; verify them yourself, read-only)

- `scripts/probe-project-windows-matrix.cjs:259-296` seeds **five** projects d1..d5, each capsule
  written into `config/workspace-capsules.json` with explicit `projectId`/`workspaceId`
  (`migrationMarker: 'explicit'`, lines 314-329). Boot env sets only ALPHA as
  `ANTIFAN_PROJECT_ID`/`ANTIFAN_WORKSPACE_ID`/`ANTIFAN_WORKSPACE_ROOT` (lines 301-307).
- `src/main/control-plane/control-plane-runtime.ts:162-169` seeds the registry with **only** the boot
  project/workspace (`workspaces.ensureInitialWorkspace(options.projectId, options.workspaceId, …)`).
  `ControlPlaneRuntime.projects`/`.workspaces` are the live `ProjectRegistry`/`WorkspaceRegistry`
  (`control-plane-runtime.ts:102-105,135-137`).
- `WORKSPACE_MISMATCH` is thrown by `resolveWorkspaceForSession` → `workspaces.get(workspaceId, projectId)`
  (`control-plane-runtime.ts:602-607`), backed by `ProjectRegistry.getWorkspace`
  (`src/main/project/project-registry.ts:99-105`) which throws when the workspace is absent or not
  owned by that project.
- **Hypothesis H1 (controller, must be verified by candidates):** capsule affiliation and the registry
  are decoupled. A capsule may *claim* project d2/workspace d2 without any registry record, so the
  presentation layer (capsules) works while the control plane (registry) refuses — one upstream cause
  for the R2/R3a/R4c/R3c cluster. `attachWorkspace`/`registerProject` have **no runtime callers** in
  `src/main/index.ts`; `WorkspaceCapsuleManager` is constructed without `affiliationAuthority`
  (`src/main/index.ts:2120`, option declared at `src/main/project/workspace-capsule.ts:57`).
- **Hypothesis H2:** R12a/R12b (toolbar viewport vs native geometry desync) and R6a (A did not close,
  shell count 2) share one cause in chrome-view sizing/bookkeeping ("leftover toolbar#2").
- **Hypothesis H3:** R7 (no terminal session for B) is the process-global active-capsule state:
  `TerminalManager.setCapsule` writes `currentCapsuleId` (`src/main/browser/terminal-manager.ts:981-1000`)
  while `switchCapsule` flips `capsuleManager.getActive()` globally; a session for B may be minted
  against A's active capsule.
- Related already-landed seams: `PageCloseReservations`, `ProjectCloseCoordinator`,
  `test/main/close-outcome-deadline.test.ts`, `scripts/probe-quit-coordination.cjs`.
- Phase docs: `phase-04-close-and-shutdown.md` (incl. its "Wave 3 wiring status"), `phase-05-certification.md`.

## Open work items (the todo list, verbatim intent)

1. Close coordinator integration + race suites green.
2. Unblock the coordinated close: a closed shell must leave no chrome content alive and must stop
   wedging the next window's toolbar (leftover toolbar#2 / stale live bookkeeping); then run the
   quit-coordination probe to completion.
3. Verify and fix the four advisory STOP findings (busy evidence, recovery-control naming, quit
   admission, watchdog coverage).
4. Settle empirically whether every close path reaches closed/vetoed/unknown without a timeout.
5. Fix or honestly report the live terminal popout invisible to the committed quit.
6. Phase 5: compile + focused/broad lanes green; live Electron acceptance matrix with receipts; docs
   cutover (ui-architecture, spec receipts, plan gates).
7. Deferred live smoke lanes: smoke-split-review, smoke-background-multitasking,
   smoke-profile-persistence-runner, test:probes, smoke:terminal.
8. Advisory go/no-go per phase; full lane verification on the final tree; plan sync-back and user report.

## QUESTION

Produce a complete reframing of this stuck problem:

1. **Technique** — pick exactly one from: Simplification Cascades, Collision-Zone Thinking,
   Meta-Pattern Recognition, Inversion Exercise, Scale Game, or When-Stuck; name the symptom that
   matched it.
2. **Application** — apply that technique to *this* repo concretely (file:line evidence, not generic
   advice). Verify or falsify H1/H2/H3 where you can read the code that decides it.
3. **Unblock path** — an ordered, concrete next-action list the controller can execute (which defects
   to fix first and why that order, what instrument proves each fix, which rows of the matrix flip).
4. **Residual unknowns** — what you could not determine read-only, and the exact check that would settle it.

## Rubric (the verifier scores each candidate 1–20 per criterion)

A. Symptom-to-technique fit — the technique is justified by the observed symptom, not decoration.
B. Depth of application — specific to this repo, cites file:line, falsifies or confirms the hypotheses.
C. Actionability of the unblock path — ordered, executable, names the proving instrument per step.
D. Honesty about residual unknowns — states what it could not verify and what check would settle it.

Hard constraints (any violation ⇒ candidate rejected): no writes/builds/tests; no generic advice
("add more tests", "refactor for SOLID", "add CI"); no proposal that breaks constraints 1–6 above
(in particular: no second registry, no force-close override, no per-window service runtime, no
timeout-driven destruction, no touching live user processes).
