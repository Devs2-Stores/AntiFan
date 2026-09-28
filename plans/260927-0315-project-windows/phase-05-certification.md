---
phase: 5
title: "Project Windows certification and documentation cutover"
status: pending
priority: P1
effort: ""
dependencies: [1, 2, 3, 4]
---

# Phase 5: Project Windows certification and documentation cutover

## Overview

Prove all spec criteria on the real Electron surface; then update current architecture documentation and remove obsolete primary-window assumptions. Unit tests alone do not certify multi-monitor behavior.

## Requirements

- Five projects/twenty visible tabs, two simultaneous physical-monitor project surfaces, background agents and duplicate labels.
- No production profile destruction, user process termination or external publishing.
- Report actual commands/results; never label planned checks as passed.

## Architecture

Dependency map: all four implementation phases → focused tests → compiled app → live surface matrix → docs/cutover. Use a disposable profile/workspace and owned processes. AntiFan MCP is primary browser evidence; native desktop window/focus/display observations use host computer helpers. Playwright only under repository fallback policy, with explicit downgraded evidence.

## Related Code Files

Paths relative to `E:/Work/apps/AntiFan`.

| Action | File | Change |
|---|---|---|
| Modify | test/integration/concurrency-multi-project.test.ts; test/integration/mcp-multi-tab-e2e.test.ts | Real routing integration assertions |
| Create | test/e2e/project-windows.test.ts | Consumer-visible independent window lifecycle scenarios |
| Modify | docs/ui-architecture.md | Shared authority, project shells, local layout and explicit navigation exception |
| Modify | docs/superpowers/specs/2026-09-27-project-windows-design.md | Link observed acceptance receipts; no retroactive fabricated approval |
| Modify | plans/260927-0315-project-windows/plan.md | Gate status only after observed proof |
| Modify | scripts/smoke-split-review.cjs; scripts/smoke-background-multitasking.cjs | Migrate NativeTabHost construction to shared authority/shell contract; no compatibility constructor |

Two existing integration files plus existing split/background/persistence/terminal smoke commands from package.json:52,54,70,72. New E2E suite covers multi-window behavior absent from those individual smokes.

## Implementation Steps

1. Recheck worktree changes and existing processes before compile/start. Do not stop the user's browser or detached agents to free resources. Use deterministic owned test instance configuration.
2. Run `npm run typecheck` and `npm run compile`, then `npm run test:file -- .compiled/test/main/project-window-manager.test.js .compiled/test/main/project-close-coordinator.test.js .compiled/test/main/project-window-persistence.test.js .compiled/test/main/window-state.test.js .compiled/test/unit/browser/project-window-layout.test.js .compiled/test/renderer/project-tab-search.test.js`. Follow with `npm run test:fast`, `npm run test:main`, `npm run test:integration` and `npm run test:file -- .compiled/test/e2e/project-windows.test.js`. These commands run after the earlier phases create the named suites; test:fast does not include test/main.
3. Migrate existing smoke constructors with the phase-1 cutover, then run `node scripts/run-electron.cjs scripts/smoke-split-review.cjs`, `node scripts/run-electron.cjs scripts/smoke-background-multitasking.cjs`, `node scripts/smoke-profile-persistence-runner.cjs`, `npm run test:probes` and `npm run smoke:terminal`. Inspect harness ownership/isolation before launch; never touch live user sessions. Capture daemon and session IDs before GUI exit and after reconnect; survival requires equal identity plus a working existing PTY, not merely a newly spawned shell.
4. Launch actual app and execute matrix below. Record window IDs, explicit tab/project/workspace IDs, foreground window before/after, unchanged attachment revision, screenshots and actual close outcomes. No invented latency budget or memory-saving target.
5. Exercise intentional failures: stale search, duplicate-open concurrency, mapping ambiguity, renderer spoof, binding-close race, native unload veto, failed initialization and display removal. Missing hardware means physical-display acceptance is BLOCKED, not passed by simulated screen fixtures.
6. Update docs/ui-architecture.md only after live proof; delete obsolete singleton presentation aliases and incidental-source tests made obsolete by extraction. Retain existing user-visible contracts and historical spec pointer.
7. Stop only test-owned processes, preserve intentionally detached daemon ownership, and remove throwaway probes after evidence is saved. Implementation remains incomplete if any named acceptance scenario fails.

## Test Scenario Matrix

| Spec criterion | Required proof |
|---|---|
| 1 | A/B simultaneous on separate monitors; duplicate A open yields same window |
| 2–3 | Typing in A while authorized B child opens/navigates; no focus/authority rotation |
| 4 | User/popup/agent/restore affiliation; missing versus conflict; Unassigned reachable |
| 5 | Independent split layouts and background screenshot readiness |
| 6 | Normal bounds/maximize reopen; physical display disconnect and DPI changes |
| 7–9 | Idle A close preserves B; veto/partial outcome; binding/new-tab races; final Quit guard |
| 10–11 | Disconnect preserves form state; stale target refusal; unchanged partition isolation |
| 12 | 960x640 and wide/maximized keyboard and visual checks |
| Search supplement | Every window finds foreign/Unassigned tabs; explicit focus; stale result no fallback |

### Instrument status

This matrix already exists as `scripts/probe-project-windows-matrix.cjs`: it boots the shipping main
process in one real Electron instance and walks the rows above, keyed by the spec criterion. Rows
are declared up front, so a row whose judge never ran is emitted `BLOCKED` rather than omitted, and
rows needing physical hardware or a human observer (`R1-HW`, `R2-HW`, `R6-HW`) are `BLOCKED` with
their reason instead of being simulated. It runs in two phases because the post-exit orphan verdict
(`R9E`) is only knowable after the process is gone: phase 1 writes
`plans/260927-0315-project-windows/reports/project-windows-matrix.json`, and phase 2
(`node scripts/probe-project-windows-matrix.cjs --verify-orphans`) folds the detached watcher's
report into that receipt. Do not build a second matrix harness, and do not report a criterion as
passed from a row that carries no observed values.

**Certified run.** `plans/260927-0315-project-windows/reports/project-windows-matrix.json`, written 2026-09-27T20:20:08Z for host pid
28860 (data root token `antifan-pw-matrix-I57BZk`), records 34 `PASS`, 0 `FAIL`, 3 `BLOCKED`
across all 37 declared rows (`coverage.judgedByThisProcess` = 37, `emittedWithoutBeingJudged` = []),
and exits 2 — the honest code for "no failure, certification incomplete". The three blocked rows are
the hardware/human ones — `R1-HW` (two real monitors with a person confirming both are legible and
interactive), `R2-HW` (real OS foreground focus and keyboard stability) and `R6-HW` (unplugging a
monitor and changing the OS display scale) — each emitted with its reason and no fixture standing in
for it.

`node scripts/probe-project-windows-matrix.cjs --verify-orphans` merged `R9E` as `PASS` at
20:20:34Z from the report of **this** run's host (host gone, survivor scan ran after the exit, no
recorded descendant alive, no process matching the run's data root): the merge waited ~26 s for this
run's watcher report (written 20:20:33.680Z, `pollCount` 6) while the file on disk still held the
previous run's (`hostPid 17732`, token `antifan-pw-matrix-tdgptl`) and refused it — the fail-closed
binding doing its job on real data again. `R9c` preserved the detached host's identity (pid 17532,
port 65272, token and version unchanged, mode `attached`) and drove the pre-existing session
`terminal-2` to the marker `matrix-pty-muk9imck` after the teardown, then verified **by pid** that the
host it started was gone (`stoppedAfterwards`: "pid 17532 is gone after shutdownHost()") — the row
asks the process table directly, because `ensureDaemon()` would have spawned a replacement host to
answer the same question; `R9d` found no surviving page processes (0 webContents, 0 native windows
after the committed teardown); `R9b` observed the committed quit — 6 shells before, 0 after,
`will-quit` delivered and held, 0 auxiliaries from 1, `shutdown.begin`/`shutdown.clean` once each, no
`shutdown.forceExit`, 0 live windows, and both `quit.outcome` entries committed with no surviving
shells.

**Run identity is part of the verdict.** The first merge attempt at 19:57:06Z folded a *previous*
run's watcher report (`hostPid 21420`) into that run's receipt, because the detach-and-poll watcher
had not written its report yet and the merge simply read the file that existed; the receipt's later
audit caught the mismatch against the run's own journal pid. `--verify-orphans` now binds the fold to
the run: it takes the host pid and data-root token from the receipt's own `R9E` row, refuses any
report that does not match them or that was checked before the receipt was written, waits (bounded,
120 s) for the matching report to appear, and re-blocks the row with the concrete mismatch when it
never does. The watcher writes its token into its report so the binding is two-sided. The merged row
records `hostIdentityVerified` and `watcherReportToken` beside the verdict. The binding fails
closed at every gap — a receipt whose `R9E` row carries no host pid or no token cannot bind to any
report at all, and a report that omits either identity is not accepted because it is the newest
file present. Those refusal paths were exercised directly against throwaway receipts and reports (a
mismatched host pid, a matching pid whose report carried no token, and a receipt with no identity),
and each re-blocked the row with its cause instead of folding the file on disk.

The harness corrections listed above are confirmed by that run: `R5a`, `R7`, `R10a`, `R10b`,
`R12a`, `R12b` and `R6a` all pass, and the earlier `R2`/`R3a`/`R4c` `WORKSPACE_MISMATCH` failures
no longer reproduce.

**What that run needed, in the shipping code.** Two fixes were required to reach it, both
source-verified here rather than assumed:

1. An unverifiable or orphaned run no longer blocks a quit it cannot interpret.
   `enumerateCloseLiveUseRuns` (`src/main/index.ts`) reports each registered project's runs with
   the state the run service holds, and reports a run it can only see through an attachment or
   through the run store for a project this process cannot resolve as `ORPHANED_RUN_STATE`
   (`'unverifiable'`, `src/main/browser/close-live-use.ts`) — deliberately outside the run
   vocabulary: the service's own terminal set already contains `unknown` (how it reports a
   backend outcome it could not verify), so folding an unresolvable run into `unknown` would
   answer "finished" for work nobody can see. `runCategory` consequently treats the service's
   `unknown` as terminal, and any state it cannot interpret — `unverifiable` included — as
   `cannotTell`, which leaves the live-use report `unknown` and refuses the close. Revoked
   attachment bindings no longer stand in for their runs.
2. The force-exit watchdog yields to a delivered `will-quit` (`src/main/index.ts`). The committed
   quit arms `armForceExitWatchdog` before `app.quit()`, and its timer kills the process
   (`process.exit(1)`) unless `willQuitDelivered` is set. With a harness that vetoes the quit to
   keep its rows running, that timer ended the process mid-row two seconds later and journaled
   `shutdown.forceExit` for a teardown that had in fact reached `shutdown.clean` — observed in the
   intermediate run of 19:57Z, whose disposable data root the next run replaced along with that
   journal. The mechanism is source-verified at `armForceExitWatchdog` (it refuses to fire once
   `will-quit` is delivered, because a delivered-and-vetoed quit is the platform working as
   intended), and the journal now preserved as `plans/260927-0315-project-windows/reports/project-windows-matrix-journal.log` is the
   certified run's, in which no `shutdown.forceExit` appears.

**Harness corrections this run forced.** `R9b` now holds *every* `will-quit` delivery, not only
the first: the platform re-delivers it once the last window is really destroyed, and that second
delivery was ending the process while the rows after `R9b` were still pending. Two `R9b`
assertions encoded expectations that a vetoing harness falsifies and were replaced by stronger
ones: the `will-quit` count (a veto causes re-delivery, so it was never a teardown count) is now
"delivered at least once, `shutdown.begin`/`shutdown.clean` exactly once each, every
`quit.outcome` committed with no surviving shells", and `closedShells ≥ 1` (the last shell's close
is what drives the quit, so the quit itself legitimately closes zero) is now the registry proof
that the last shell's key is gone. The lifecycle journal is copied to
`plans/260927-0315-project-windows/reports/project-windows-matrix-journal.log` before the disposable data root is deleted, and an
exit record (`observations.ended`) names how the process ended, so "a row threw" is distinguishable
from "the process was killed from outside".

`R9c`'s stop check asks the process table instead of `ensureDaemon()`. The old wait treated
`mode !== 'attached'` as proof that the host it started had stopped, but with a staged bundle
present `ensureDaemon()` *spawns a replacement host* when it finds none attached — so the row could
report a spawn as the host's death (and created one more process the harness then had to clean up).
It now polls `alivePid(host.pid)` for the pid it observed before the teardown and records that
finding, which is the row's actual question; the post-exit row `R9E` stays the independent
cross-check, since it scans the owned pids recorded during the run.

### A new tab carried the active capsule, not its window's (criterion 4)

Strengthening criterion 4's rows found a real defect, and the fix is in the shipping host:
`NativeTabHost.createTab` defaulted a page's capsule to `capsuleManager.getActive()`, the one
process-wide active capsule, so every tab created in a window that was not the active one was filed
under the *other* window's capsule. The design already required the opposite
(`docs/superpowers/specs/2026-09-27-project-windows-design.md`: "User new-tab requests use the
sender's validated project; native window-open children inherit the source page's verified
affiliation"); the code did not implement it. Two paths were affected — a user tab created in a
window whose workspace is not the active capsule, and a `window.open` child, which never inherited
its opener at all.

The fix has two halves in `src/main/browser/native-tab-host.ts`:

1. `resolveNewTabCapsuleId` resolves a new page's capsule in the spec's order: an explicitly
   measured capsule (routed/agent tab, restored tab, or a `window.open` child) → the window's own
   verified `windowWorkspaceAffiliation.capsuleId` → the process-wide active capsule. The last step
   now applies only to a window with no verified workspace (Unassigned, legacy), which is the one
   case where the process-wide selection is the only thing known.
2. The `window.open` handler reads the opener's capsule synchronously (`getTabCapsuleId`) before the
   deferred creation and passes it as the child's explicit capsule, so the child inherits the tab
   that asked even if that tab is gone by the time the creation runs.

Proved by making the two rows discriminating rather than accidentally green:

| Run | Instrument state | `R4a2` (toolbar tab in window B) | `R4b` (native popup) |
|---|---|---|---|
| pre-fix (`plans/260927-0315-project-windows/reports/project-windows-matrix-before-capsule-fix.json`, 20:18:33Z) | rows assert the window's capsule | `FAIL` — "the toolbar tab's capsule is 'capsule-matrix-alpha', expected this window's 'capsule-matrix-beta'" | `FAIL` — "the popup's capsule is 'capsule-matrix-alpha' while its opener carried 'capsule-matrix-beta'" |
| post-fix (`plans/260927-0315-project-windows/reports/project-windows-matrix.json`, 20:20:08Z) | same assertions | `PASS` — `capsule-matrix-beta` | `PASS` — `capsule-matrix-beta`, opener `capsule-matrix-beta`, child owner window B |

31 `PASS` / 2 `FAIL` pre-fix against 34 `PASS` / 0 `FAIL` post-fix on the same instrument, and the
pre-fix receipt's `R4b` observation records the mismatch directly (`record.capsuleId`
`capsule-matrix-alpha` beside `openerCapsuleId` `capsule-matrix-beta`, both in window
`project:…d2`). `R4a` keeps `capsule-matrix-alpha` in both runs: window A is the active capsule
there, which is why the defect stayed invisible until the two rows above had a capsule to disagree
about.

The e2e popup row is discriminating for the same reason now. Window A is the scenario's active
capsule, so a child that consulted global state would satisfy the row's equalities by accident; the
row rotates the process-wide active capsule to window B's for the duration of the popup
(`WorkspaceCapsuleManager.switchTo`, restored in the row's cleanup) and asserts the child still
carries its window's. Its receipt (`reports/project-windows-e2e.json`, 20:30:40Z) records
`capsuleId`/`parentCapsuleId`/`windowCapsule` all `capsule-pw-a1` while
`activeCapsuleDuringPopup` is `capsule-pw-b2`. `test/unit/native-tab-capsule-affiliation.test.ts`
pins the resolution order itself (5 cases), including that a blank string never shadows a real
capsule later in the chain.

This defect is the reason criterion 4 could not be certified from the earlier run: the rows passed
there because window A happened to be both the owning window and the active capsule.

The daemon row (`R9c`) and the abrupt-transport-drop row (`R10b`) are harness-implemented rather
than mocked: `R9c` captures the detached host's identity and session before the teardown and
re-runs an existing PTY afterwards, and `R10b` drives a real bridge WebSocket client that drops
mid-session. `test/e2e/project-windows.test.ts` instead declares detached-daemon survival and the
native unload/close races as deferred rows with the reason it will not simulate them; the close
races there are owned by `scripts/probe-quit-coordination.cjs`.

The two named smoke files are already migrated to the shared contract — each builds one
`ProjectWindowShell` and its own `NativeTabHost(shell)`, so a re-run exercises the shared authority
rather than a compatibility constructor. The acceptance receipts in the design spec list the
instrument for each criterion and mark `NONE` where no artifact exists yet — the hardware-dependent
rows and the instruments that have not run. That spec file is updated to link receipts and
instruments, never to record an unobserved pass.

The close/quit/admission cutover into `docs/ui-architecture.md` has already landed, because it is
source-verified for the shipping entrypoints and its evidence is labelled with the run timestamps
it came from. What step 6 still owns is the phase-5 proof itself: the matrix receipt, the declared
hardware rows, and the live surface observations — none of which this cutover asserts.

## Function and Interface Checklist

- [x] Changed public callers and test fixtures migrated, no compatibility stubs. (`npm run
  typecheck` clean; `npm run test:main` 1787 passed / 33 failed / 1 pre-existing skip. The 33
  failures are the lane's bridge-pairing, local-IPC and Windows-ACL suites, which fail identically
  with and without this change on the same tree — the two runs differ by 0 tests in their failure
  set — and pass in isolation (28 s) and in a six-file parallel group (83/83, 71 s). They are
  lane-scale contention in this environment, not a criterion-4 regression; the tab, capsule,
  persistence and popup suites in the same lane pass. The unit file this fix adds is 5/5, and
  `test/e2e/project-windows.test.ts` is 1/1 in 24 s.)
- [x] Live proof ties foreground focus and attachments to concrete IDs. (Every row's receipt entry
  carries `ids`: window ids per owner key, project ids, terminal session ids, orphan pids; the
  attachment ids the row released are recorded in its `observed`. The *foreground focus* half stays
  on the hardware rows below: `sendInputEvent` cannot exercise the platform's foreground lockout.)
- [x] Current docs distinguish visibility, user navigation and execution authority.
  (`docs/ui-architecture.md` cutover, plus the exit-bound paragraph added for the watchdog's
  `will-quit` rule.)
- [x] Daemon survival is distinguished from accidental browser orphan processes. (`R9c` preserves
  the host's pid/token/version and drives a pre-existing PTY; `R9E` decides the process side from
  the watcher's post-exit scan, merged only against this run's report.)

## Success Criteria

- [ ] All named acceptance scenarios observed and receipts linked. 34 of 37 rows carry an observed
  verdict in `plans/260927-0315-project-windows/reports/project-windows-matrix.json`; `R1-HW`, `R2-HW` and `R6-HW` need a person at
  the hardware (two monitors, real foreground typing, a monitor unplugged / OS scale changed) and
  stay `BLOCKED` with their reasons rather than being simulated.
- [x] Relevant focused/broader checks pass, failures resolved without weakening behavior tests.
  (`npm run typecheck` clean; the matrix run 34 `PASS` / 0 `FAIL`; `npm run test:main` 1787 passed
  / 33 failed, an identical failure set with and without this change and all of it in the
  bridge-pairing/ACL suites recorded in the checklist above; the criterion-4 defect this phase
  found was fixed in the shipping host and is proved by the pre-fix/post-fix receipt pair. Two
  `R9b` assertions were replaced, not relaxed: the `will-quit` count was never a
  teardown count once the harness vetoes each delivery, so it became "delivered, with
  `shutdown.begin`/`shutdown.clean` exactly once and every `quit.outcome` committed without
  survivors", and `closedShells ≥ 1` became the registry proof that the shell which drove the quit
  is gone.)
- [x] No unrelated code deletion or user process cleanup. (The harness kills only pids it recorded
  as its own; the user's profile, processes and sessions were never targeted.)
- [ ] User reviews implementation evidence before any commit/publish action beyond granted scope.

## Remaining work

- The three hardware rows need a human at a physical machine: run
  `node scripts/run-electron.cjs scripts/probe-project-windows-matrix.cjs` with two monitors
  attached, then with a monitor unplugged and the OS scale changed, and record what the person saw
  against the rows' `displays`/`windowPlacements` evidence.
- Phase 5's step 4 asks for the same run to be reviewed by the user; the receipt, the journal copy
  and the watcher report are the artifacts to read.

## Risk Assessment

Electron DirectComposition, focus and DPI behavior are not proven by unit tests. If live capture fails only with multiple windows, retain the failure evidence and fix the real rendering boundary; do not certify from a narrower single-window smoke. Rollback is a code rollback before production migration; preserve old data and never promise restoring unsaved page state.
