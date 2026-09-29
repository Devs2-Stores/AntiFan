---
phase: 7
title: "Verification"
status: in-progress
priority: P1
effort: "0.5-1d"
dependencies: [1, 2, 3, 4, 5, 6]
---

# Phase 7: Verification

## Overview

Prove the contract end-to-end on the real app, not only unit tests.

## Steps

1. `tsc` (typecheck lane from `31e4fb60`), then new suites, then touched existing suites:
   `test/renderer/terminal-capsule-picker.test.ts`, `terminal-tab-categories-sleep.test.ts`,
   `standalone-project-chip.test.ts`, `test/unit/browser/terminal-sleep-lifecycle.test.ts`,
   `test/e2e/terminal-capsule-assign.test.ts`, `test/e2e/project-windows.test.ts`.
2. Report state of plan 260928's two failing suites (`output-batcher.test.ts`,
   `terminal-output-router.test.ts`) without claiming them fixed.
3. Live smoke via AntiFan MCP (Playwright only under AGENTS.md §3.1):
   - dialog opens at `E:\Work`;
   - hub `+` in two folders → two groups, labels `<folder> · 1`; active capsule of an open project
     window unchanged (`anti.browser.evaluate` / manager state);
   - `Mo Space` on a sample folder twice → second open adds nothing;
   - sleep on a sync terminal refused with reason;
   - picker shows optgroups.
4. `code-reviewer` pass on the diff; update `docs/ui-architecture.md` + `CHANGELOG.md`.

## Evidence (2026-09-29)

- `tsc` clean. `test:fast` 1703/1703 (unit + renderer). `test:unit` 1396/1396.
- `test:main` full lane rerun after adding stderr capture to `terminal-daemon-provenance` #5: exit 0 (green). The earlier single failure did not recur and its cause was never observed, so it stays "unexplained, not reproduced"; the test now prints child stderr if it recurs.
- `history-manager` and `playwright-parity-kernel` (earlier flaky): 3/3 green runs on HEAD.
- `npm run smoke:terminal-hub` 5/5 PASS (real Electron, stubbed Main).
- `code-review.md`: F1-F13 resolved.
- Live smoke, step 3 of this phase: NOT YET RUN as of this entry. Observed: `anti.browser.tabs.list` and `terminal.list` (AntiFan MCP) answer from a live instance and return its tabs/sessions. Not established: which build that instance runs. Observed: an isolated launch of this build (own `ANTIFAN_DATA_ROOT`/`ANTIFAN_CONFIG_DIR`/`ANTIFAN_USER_DATA`) started; this MCP session's `terminal.list` did not show it, and `scripts/antifan-agent.cjs` resolves its target from `ANTIFAN_BRIDGE_PORT` in the MCP process env, else discovery files. One raw-CDP attempt against that instance was discarded as evidence (AGENTS.md section 3.1). Blocked acceptance: dialog at `E:\Work`; hub `+` in two folders; `Mo Space` twice; sync sleep refused; picker optgroups. Lanes already passed: see the bullets above.
- Live smoke, partial, isolated instance driven with Computer Use (GUI input, not MCP). Environment finding, separate from the project flow: the isolated instance shows the banner `HEALTH_RECORD_ABSENT` (no bridge record; cause not established). Observed: hub `+` folder dialog opens at `E:\Work`; a terminal created in a chosen folder (`alpha`, then `beta`) is filed under a "Chưa gắn dự án" header with a `+ Terminal trong thư mục...` control; `omp` v18.4.3 ran inside a hub terminal. The sidebar list looked collapsed to ~90px: that is `.terminal-tabs { max-height: 90px }` in the default horizontal layout (`standalone.css:194-204`, lifted only under `.tabs-sidebar`), i.e. existing behavior, not established as a hub regression. Fixture `alpha/.antifan/space.json` (sync terminal `Dev`) is written in the temp root but `Mo Space` was not exercised. Not observed: `Mo Space` twice, sync sleep refused, picker optgroups. Note `hibernateTab` in `native-tab-host.ts` parks browser tab views; it is not terminal sleep (`sleepSession`).
- Live smoke, continued (isolated instance, Computer Use, 2026-09-29). Observed on the main window sidebar: `Space` on `alpha` (manifest: sync terminal `Dev`, `echo dev-ready`) first shows a confirm listing the command; OK -> notice `Space: +1 terminal, +0 tab`, `Dev` created with role `sync`, output `dev-ready`. Second `Space` press -> `+0 terminal, +0 tab (đã có: 1)` (idempotent). Right-click `Dev` -> Sleep -> refused, notice "Tab này được đánh dấu sync: ngủ sẽ giết watcher. Bỏ đánh dấu sync trước khi cho ngủ." and `Dev` stays running. Observed defect: in the pop-out terminal window (surface `terminalPopout`) the same `Space` button is rendered but `antifan:space:open` is refused with `ChromeSurfaceMismatchError` (handler allows only `sidebar`, `native-tab-host.ts:4104`); the guard is deliberate, the visible button is not. Not observed: picker optgroups (one attempt to arm the element picker hit a page link instead).

- 2026-09-29 (this build, rerun): user removed the strip's new-group control and asked for the popout Space fix. Renderer suites `terminal-hub-folder-groups` + `terminal-tab-categories-sleep`: 52/52 pass after `tsc` + `copy-static`. Isolated instance relaunched on this build (Computer Use, pid 5812; stopped afterwards): the sidebar strip shows search + `+` only, no new-group button. NOT live-verified: picker optgroups (the toolbar click armed a text-size toggle, not the picker) and the popout Space omission (covered by the renderer test only; the popout window was not reopened on this build). `anti.browser.tabs.list` still returns only the production instance's tabs, so MCP cannot reach the isolated one; no Playwright fallback used. Status for this criterion: BLOCKED on an app restart onto this build; checklist stays unchecked.
## Success Criteria

- [x] Typecheck + unit/renderer/main lanes green on last run (daemon-provenance #5 failed once, unexplained, did not recur)
- [x] No existing test weakened. Exception, by user decision: the two tests for the removed "new group" strip control were deleted with the control; a toolbar assertion now pins its absence, and a new folder-group test pins Space present when docked and absent in a popout.
- [x] CHANGELOG updated; `docs/ui-architecture.md` describes the hub/Space model from the earlier commit and was not edited for the hardening pass (F5-F13 change no documented contract)
- [ ] Live smoke on an app running this build (folder dialog at `E:\Work`, `+` in two folders, Space idempotent, sync sleep refused, picker optgroups) - NOT DONE: needs an app restart, which ends the user's production session
