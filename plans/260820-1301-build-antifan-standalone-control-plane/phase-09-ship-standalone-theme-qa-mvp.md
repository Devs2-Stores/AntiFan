---
phase: 9
title: "Ship standalone theme QA MVP"
status: completed
priority: P1
effort: "5d"
dependencies: [5, 6, 8]
---

# Phase 9: Ship Standalone Theme QA MVP

## Overview

Deliver one bounded end-to-end personal workflow using the existing Chromium
surface: inspect a theme issue, edit the bound workspace, run checks, reload,
and produce evidence for responsive, overflow, and interaction failures.

## Requirements

- Functional: one Project/Workspace/Chat/Run can complete inspect -> change ->
  validate -> browser evidence -> report and reopen/resume.
- Non-functional: release gates cover ownership, security, artifact budgets,
  shutdown, and Windows behavior; no renderer rewrite in this plan.

## Architecture

Compose Phase 3-8 services and expose the smallest existing-sidebar surface.
The future Project UI plan owns renderer replacement. Theme QA output is a
durable Run/artifact projection, not a second QA store.

## Related Code Files

- Modify: existing sidebar/IPC adapter only where needed for the vertical slice
- Create: `test/integration/theme-qa-vertical-slice.test.ts`, `test/e2e/theme-qa-smoke.test.ts` when a supported harness exists
- Create: `plans/260820-1301-build-antifan-standalone-control-plane/reports/release-gate.md`

## Implementation Steps

1. Define the minimal QA checklist: layout match, responsive widths, overflow,
   interaction states, console/runtime diagnostics, and screenshot/DOM refs.
2. Run the flow against a fixture theme and a real user-selected Workspace;
   capture bounded evidence and stable artifact IDs.
3. Verify close/reopen/resume, unknown mutation handling, exact tab targeting,
   and MCP stdio/process shutdown.
4. Exercise runtime drain/rollback while a backend, PTY, watcher, and MCP
   transport are active; prove no new writes or orphan processes remain.
5. Run typecheck, focused tests, full tests, packaging/Windows smoke checks, and
   document known limitations and rollback flags.

## Success Criteria

- [x] The vertical slice passes without active-tab or cwd fallback.
- [x] Evidence is redacted, budgeted, replayable, and linked to a Run/Attempt.
- [x] Responsive/overflow/interactions failures are visible and actionable.
- [x] Release gate has zero unresolved P0 security/correctness findings.
- [x] Rollback drains or durably marks every active Attempt and owned process;
      no transport remains attached after the switch.
- [x] UI-plan ownership and any deferred work are explicitly documented.

## Risk Assessment

If the existing renderer cannot expose the slice without unsafe shortcuts, stop
at the backend/artifact contract and hand the remaining presentation work to the
UI plan; do not create a parallel renderer here.
