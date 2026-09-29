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
- `test:main` 2029 pass, 1 fail: `terminal-daemon-provenance` #5 ("Daemon host exited early with code 1") under full-lane load; 6/6 pass in isolation. Treated as spawn contention, not proven baseline.
- `history-manager` and `playwright-parity-kernel` (earlier flaky): 3/3 green runs on HEAD.
- `npm run smoke:terminal-hub` 5/5 PASS (real Electron, stubbed Main).
- `code-review.md`: F1-F13 resolved.

## Success Criteria

- [x] Typecheck + unit/renderer/main lanes (one load-flaky daemon spawn test noted)
- [x] No existing test deleted or weakened
- [x] Docs + changelog updated
- [ ] Live smoke on an app running this build (folder dialog at `E:\Work`, `+` in two folders, Space idempotent, sync sleep refused, picker optgroups) - NOT DONE: needs an app restart, which ends the user's production session
