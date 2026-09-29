# Phase 7 verification — partial evidence report (2026-09-29)

## Verdict

**PARTIAL — live-app checks pending.** Phases 1–6 implemented; `tsc` clean.
The phase-07 step-3 live smoke on the installed app is NOT done:
the running AntiFan instance is the user's production session (7 live tabs) on the previous
build; the hub code is not in it. A real live walkthrough needs an app restart from this
working tree — do not treat this report as certification.

| Check | Method | Result |
|---|---|---|
| Typecheck | `tsc` lane | clean |
| Plan + touched unit/main/renderer suites | `node --test` scoped runs (`test:unit`, `test:main`, renderer glob) | pending — focused lane run in flight; earlier spot-runs green (space-manifest 21/21, space-open 9/9) |
| **Full suite** `npm run test` | `run-test-pipeline.mjs` | **TIMEOUT after 900s** — hung in an Electron e2e (`GATE-B Sequence Gap Healing`), plus `antifan:bridge:get-status` "No handler registered" noise from the stubbed harness. Never reached the green/fail summary; the timeout itself is not attributed to this diff (Electron lane) but is also NOT proof of green. |
| Folder grouping, labels, mint/Space buttons, NEEDS_CONFIRM flow, hub hidden in project shell | `test/e2e/terminal-hub-folders-smoke.cjs` (new, real Electron, stubbed Main) — `npm run smoke:terminal-hub` | 5/5 PASS, exit 0 |
| Untouched terminal surface regression | `test/e2e/terminal-recovery-smoke.cjs` | exit 0 |
| Space manifest parser, containment, templates, sync identity, open orchestration, in-folder mint | new unit/main suites (`test/unit/space-*`, `test/unit/sync-identity`, `test/main/space-open`, `test/main/terminal-new-in-folder`, `test/renderer/terminal-hub-folder-groups`) | pass |

## Known pre-existing failures (NOT caused by this diff)

- `terminal-renderer-smoke.cjs` — "Session 4 pane was not created on early data". Reproduces
  with committed `HEAD` `src/renderer/standalone.js` swapped in (binary-identical run), so it is
  independent of this plan's renderer changes. Root suspicion: harness `loadFile` fires before the
  renderer wires `ipcRenderer.on(session)` — same class of race documented in
  `terminal-recovery-smoke.cjs` header.
- `terminal-split-hydration-probe.cjs` — exit 1, `PARTIAL_VERIFICATION`: verdict requires
  `creationMisrouting.phantomObservedDuringRace === true`; the phantom is never observed (the
  healthy post-fix outcome), so the assertion is stale. All other 11 verdict fields pass.
  Probe artifact `plans/reports/terminal-split-probe-telemetry.json` restored to committed state.

## Outstanding before Phase 7 closes

1. Live smoke on an app instance running this build (AntiFan MCP or manual): folder dialog at
   `E:\Work`; `+` in two folders → two groups; `Mở Space` idempotent; sync terminal refuses
   sleep (`SLEEP_REFUSED_WATCHER`); picker optgroups. Requires restarting the app — the live
   instance is the user's session.
2. `code-reviewer` pass: DONE, `reports/code-review.md` (DONE_WITH_CONCERNS). F1 (restart dropped role/idlePolicy/spaceTerminalId) and F2 (Space-opened sync terminals skipped the duplicate check) fixed with regression tests (`(k3)` in terminal-sleep-lifecycle, `does not mint a sync watcher...` in space-open). F3-F13 open.
3. Focused lanes: `tsc` clean. `test:main` last run: 2 failures, both outside this diff and timing-shaped (`history-manager` mtime debounce, `playwright-parity-kernel` 9c drift budget). The previous run's bridge/native-messaging/resource-stability/goal-runner failures did not recur, so they are flaky, not proven baseline. No all-green run exists to cite; unit and renderer lanes were green earlier (1395/1395, 216/216) before the F1/F2 changes and were not re-run since.
