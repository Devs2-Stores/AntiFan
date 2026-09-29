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

## Success Criteria

- [ ] All plan.md Success Criteria checked with evidence (log or screenshot receipt)
- [ ] No existing test deleted or weakened
- [ ] Docs + changelog updated
