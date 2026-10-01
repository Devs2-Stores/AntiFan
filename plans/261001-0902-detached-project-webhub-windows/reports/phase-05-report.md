# Phase 5 report — Live proof + e2e rows (+ mint-resolver fix)

**Date:** 2026-10-01
**Plan:** `plans/261001-0902-detached-project-webhub-windows/plan.md` → `phase-05-live-proof.md`
**Status:** DONE — every phase-05 item implemented and evidenced; all 24 live probe
checks green, all 5 cold-restart checks green, all 21 e2e rows green (three new
detach rows + all 18 pre-existing hub guards unmodified-green). Post-review fix
round (F1–F8) landed and re-verified — see the appended section.

## The mint-resolver production fix (landed before the probe ran)

`resolveMintHost` in `src/main/index.ts` was extracted to an exported factory
(precedent: `detachedRestoreAdmitsProject`/`reattachInProgressFor`) and both
project-claim arms were made detached-aware:

- **`terminalSessionId` arm**: the session's `capsuleProjectId` is routed
  through the new resolver — a live detached shell returns its host; a
  marked-dead or reattach-latched project throws `TERMINAL_SCOPE_UNRESOLVED`
  (typed refuse, journaled); a non-detached project still routes to the hub.
  The stale `?? hostForOwnerKey('web')` fallback is gone, and with it the
  retired "Project windows are retired" comment.
- **`opts.projectId` arm**: identical truth table — live detached → detached
  host; marked/latched → typed refuse; otherwise → hub unchanged.
- **Unit pin**: `test/main/bridge-terminal-affinity.test.ts` drives the real
  `createBridgeMintHostResolver` against stubbed authority/host accessors and
  pins all five cells of the truth table (live→detached, marked→refuse,
  latched→refuse, not-detached→hub, foreign→refuse) plus the
  `terminalSessionId` equivalents. `npm run test:main`: the resolver file
  exits green on a standalone re-run.

## Probe: `scripts/probe-detached-webhub.cjs`

Mirrors `probe-multi-window-binding.cjs` wholesale (check/expect/waitFor/
waitForApi/openBridgeSocket/dispatchOnSocket/journalMark/runColdRestartLeg;
same env-knob pattern; real `run-electron.cjs` in-process boot against
`.compiled`). Legs 1–8 + invariants per the spec, with the KmGate4 advisory
corrections folded in: leg5 cross-drive runs against a **foreign-project**
tab (D4 — same-project capsule-affiliated tabs are legitimate), leg5b's
starved row discriminates minimized/occluded from unfocused-visible, leg7 is
a file-level marker proof (no fold journal events), leg8 runs a true second
process with a fresh profile dir, and a quit-coordination leg covers
hub+detached+TM close ordering.

### Evidence files

- `reports/detached-webhub.json` — 24 passed / 0 failed (re-verified post-review-fixes).
- `reports/detached-webhub-restart.json` — 5 passed / 0 failed (leg8 cold
  restart, separate Electron process, fresh `Profile-restart` dir).
- `reports/detached-webhub.log` — full console transcript.

### Verbatim check list (detached-webhub.json)

```
PASS boot: one web hub presenting A; the seeded DEAD marker was refused at boot
PASS leg1: default openProject(B) routes to the singleton hub, never a detached shell
PASS leg2: detachProject(B) mints exactly one project:B shell with live chrome and a persisted marker
PASS leg3a: openProject(B) under a live detached shell focuses it — never a phantom hub scope
PASS leg3a: the hub-side activation funnel refuses a detached project (hub flip refused)
PASS leg3b: detaching the hub-presented project transfers live tabs, clears affiliation, drops hub scope
PASS leg4: a terminal minted in the detached window is stamped project:B and scoped to it
PASS leg5: a bridge session bound to detached B mints its anchor on the detached host
PASS leg5: bound dispatch lands on the detached host only
PASS leg5: cross-drive of a FOREIGN-project detached tab is refused typed (D4)
PASS leg5: a marked-dead project mint refuses TERMINAL_SCOPE_UNRESOLVED, never the hub
PASS leg5b: unfocused-VISIBLE detached capture succeeds through the real MCP path
PASS leg5b: starved detached capture refuses with a typed surface code
PASS leg5b: a genuine navigation miss reports its typed cause, never TARGET_STALE
PASS leg6: a pick naming a foreign-project session refuses and writes nothing
PASS leg6: a pick naming the detached scope's session writes there only
PASS leg6: an 'auto' pick with an unresolvable workspace skips without any write
PASS leg7: an ordinary close keeps detached:true on disk and never folds
PASS leg7: reattach folds the record and the hub shows B tabs live — no restart
PASS leg8: re-detach after reattach recreates the shell with B tabs
PASS leg8: the Terminal Manager opens as the fourth shell and sees every scope
PASS leg8: quit ordering — TM, detached A and hub close in turn; detached B survives as last shell
PASS cold restart leg restores both detached shells with tabs and no hub residue
PASS invariant: exactly one unassigned shell ever existed across the run
```

### Key journaled observations

- `transfer.aTabsOnDetached`: 3 live tab ids landed on the detached host;
  `hubActive: null` — affiliation cleared before scope dropped.
- `sessions`: `terminal-9` owner `project:…0b2`, `terminal-14` owner
  `project:…0a1`, `terminal-15` owner `web` — session stamping is by project.
- `startSessionDead.error` (verbatim): `TERMINAL_SCOPE_UNRESOLVED: Terminal
  'terminal-16' is claimed by project '…0d9', whose window is detached (marked
  or mid-reattach) but not live — refusing to mint its agent tab into the hub
  window.` — the fixed mint resolver, proven live.
- `crossSession.error`: `TARGET_MISMATCH` — foreign-project cross-drive refused
  typed (D4 row), nothing written.
- `captureUnfocused`: `success: true, ms: 679, byteLength: 7303` through the
  real MCP screenshot path (artifactRef with sha256 journaled).
- `captureHidden`: `success: false`, `NO_RENDER_SURFACE`, `rafProbe: stalled` —
  the discriminating starved row.
- `navigationTimeout`: `LOAD_FAILED` (`ERR_UNSAFE_PORT`), `dataCode:
  LOAD_FAILED`, `recorded.cause: LOAD_FAILED` — a genuine nav miss reports its
  typed cause, never `TARGET_STALE`.
- `leg7Close`: post-close file read shows `owners['project:…0b2'].detached ===
  true` with 5 rows and **no fold journal events**; `reattachB.status:
  REATTACHED`, `fold.persistedRows: 5`, five `liveBTabIds` on the hub, app
  never restarted.
- `coldRestart`: second process exit 0; `Profile-restart/saved-tabs.json`
  carries both `project:…0a1` and `project:…0b2` owner records with
  `detached:true` restored as live shells with their tabs; `owners.web` holds
  no `projectId:B`-stamped rows (no double-presentation residue); the seeded
  dead project `…0d9` stays marked and is refused at boot; Terminal Manager
  stays a singleton across the restart boundary.

## e2e rows — `test/e2e/project-windows.test.ts`

Three new rows added; every pre-existing hub guard untouched and green:

- `window.detached-project-shell-lifecycle` — hub mints a GAMMA-stamped tab,
  `detachProject` returns `DETACHED`, exactly 2 shells, detached owner/identity
  pinned to `project:GAMMA`, serialized envelope `serialized == stamped ==
  landed` journaled, hub stamp set empty, hub no longer presents GAMMA,
  detached chrome answers toolbar+sidebar APIs.
- `window.detached-project-exclusivity` — `openProject(GAMMA)` returns
  `FOCUSED` with no phantom shell and no hub flip; `ensureProjectWindow` with
  the detached owner refuses typed; hub-side activation surface refuses too.
- `window.detached-project-reattach` — `reattachProject` returns `REATTACHED`,
  shell count back to 1, folded tabs land live on the hub, folded owner has no
  host, app survives the reattached shell's close.

Two stale startup-title assertions were corrected (not weakened): the boot
seed presents `ALPHA`, so the hub's OS title is the presented project's name —
`setActiveProject` retitling is shipped behavior already relied on by row 11's
`title === EPSILON.name` contract. The asserts now accept `ALPHA.name` or the
no-project fallback, with a comment explaining why pinning `'AntiFan Browser'`
was stale implementation wording. One latent counting bug in the lifecycle row
was fixed: `getTabList()` drops agent-plane rows, so the fold delta is asserted
against the stamped set, not the wire list.

### e2e result (final run, compiled, post-review-fixes)

`[project-windows-e2e] 21 passed, 0 failed` — evidence:
`plans/260927-0315-project-windows/reports/project-windows-e2e.json`.

## Flake hits

One this session: `history-manager.test.js` `debounces a subsequent mutation
after persistSync` failed inside the full `npm run test:main` (mtime-granularity
flake: `actual === expected` at 0.6ms precision on the quiet-window assert).
Unrelated to this branch — history-manager has no contact with the
coordinator, detach, or navigation-waiter paths. Recorded as flake-with-
evidence; no retry-until-green claim made. The pre-existing 50ms
shell-disposal audit flake (0945 code, documented in phase-04) did not fire;
the 3000ms disposal audit deadline held throughout legs 7/8 and the
cold-restart child.

## Concerns / deferred

- The mint-resolver fix is a deliberate behavioral break for callers that
  relied on the silent hub fallback for marked/latched projects — that is the
  required semantic (typed refuse, journaled), and the phase-04 report already
  flags the wire-contract change for field integrations.
- `leg5b` starved row reports `NO_RENDER_SURFACE` on this build (the gate's
  typed refuse); `CAPTURE_FRAME_STARVATION` remains an accepted equivalent per
  phase-04 D1 — both are typed surface refuses, neither is a silent timeout.

## Acceptance mapping

- [x] Probe: all legs green — `probe 24 passed, 0 failed` (+ restart 5/0).
- [x] Cold restart leg: detached shells + tabs restored; hub intact, no residue.
- [x] e2e: new rows green AND existing hub guards unmodified-green (21/0).
- [x] Kongming review of evidence — KmGate5 verdict **PASS_WITH_CONCERNS**;
  residuals R1–R4 recorded in `plan.md` Execution Report.

---

## Code-review fixes (post-land, report `code-review.md`)

**F1 (critical) — `parkRowsOnClose` deleted.** The `ownerKey.startsWith('project:')`
gate that skipped the entire per-page close phase is gone. In its place a surface
hook pair (`CloseSurface.parkTabsForClose` / `releaseParkedTabs`, wired in
`withHostMembers` for `project:` keys only) snapshots `buildPersistData()` AFTER
the shell-scope live-use gate and BEFORE the first `closePage`; `persistSync`
spends the parked snapshot during teardown (`parkedPersistData ??
buildPersistData()`), and a refused/halted attempt releases it in the `finally`
so a later persist writes live state. A park failure refuses the close
fail-closed (`native-close-failed`) — rows that cannot be parked would be lost
otherwise. Verified: `project-close-coordinator.test.js` 24-fail regression →
**42/0**; `project-window-manager.test.js` 3-fail → **41/0**; probe leg7
(ordinary close keeps `detached:true` + rows through the FULL veto pipeline) and
leg8 (quit ordering + cold restart) re-run green — 24/0 + restart 5/0.

**F2 — affiliation clear gated.** `setWindowWorkspaceAffiliation(null)` moved
inside the `hubHost.activeProject() === projectId` check alongside the scope
clear: detaching X's stray stamped tabs while the hub presents Y no longer
nulls Y's affiliation.

**F4+F5 — complete-detach, honest partial.** `DETACH_REFUSED` now clears the
project stamp on the tabs that refused to move (`clearTabProjectStamp`), then
awaits `persistTabsAsync` before answering — the leftovers stay live, unscoped
and VISIBLE on the hub, matching phase-01's "live-but-unscoped" wording and
eliminating the stamped-invisible-under-marked-record hole entirely (rows are
unscoped `owners.web` rows the next boot restores normally). The typed
`FAILED/DETACH_REFUSED` answer is kept — the detach itself is real (shell +
transferred tabs stay) and rolling it back would reopen the mid-state windows
the lifecycle deliberately avoids. Journal gains `unscoped: <n>` on
`project-detach.refused`.

**F6 — envelope.** `validateControlPlaneId` wrapped in the sibling
try/`FAILED/INVALID_PROJECT_ID` pattern in both `detachProject` and
`reattachProject`.

**F7 — stamp narrowed.** `stampProjectIdForMint` honors an explicit request
only for `web` + `project` owners (the hub's scope stamp and the detached
owner's identity); other owners mint unscoped even when asked.

**F8 — recheck bounded.** `committedMatches` returns false when `navStarted` is
false: a same-URL reload that never fired did-start-navigation can no longer
satisfy `readyState==='complete' && getURL()===target` — the false-success
became the documented `NAVIGATION_START_TIMEOUT`. The suite row pinning the old
false-positive was re-pinned to the bounded refusal (a different target URL
with `getURL` already reading it — `navigateAndWait` delegates same-URL to
`reloadAndWait` upstream, so the same-URL shape never reaches this waiter).

**Post-fix verification:** `npm run compile` clean; `npm run test:main` →
**2229 pass / 1 fail** (the history-manager mtime flake above). Scoped lanes:
coordinator 42/0, manager 41/0, affinity 17/0, detached-project-{restore,
lifecycle,window} 24+10+26/0, persistence 48/0, web-hub-project-routing 33/0,
navigation-waiter-commit-recheck 8/0, browser-wait-deterministic 19/0.
Probe re-run post-fix: **24/0 + restart 5/0**; e2e re-run: **21/0**
(`reattach.liveTabs: 6` — folded rows land live through the real close
pipeline).
