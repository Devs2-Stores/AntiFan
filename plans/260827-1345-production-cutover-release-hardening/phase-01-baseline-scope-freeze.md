---
title: "Phase 1: Baseline, Scope Freeze, And Change Audit"
status: completed
---

# Phase 1: Baseline, Scope Freeze, And Change Audit

## Objective

Turn the current uncommitted repository into an auditable release-candidate input without discarding user work or expanding scope.

## Files to inspect

- `package.json`
- `README.md`
- `docs/operations.md`
- `docs/security-model.md`
- `docs/ui-architecture.md`
- `plans/260817-1931-rebuild-chromium-first-native-harness/plan.md`
- `plans/260817-2217-rebuild-chromium-first-project-ui-and-workflow/plan.md`
- Current modified files reported by `git status --short`
- `test/fixtures/ui-parity-ledger.json`

## Steps

1. Inventory every modified and untracked file; classify each as release fix, test, documentation, or unrelated.
2. Reconcile plan labels against executable acceptance criteria; do not treat stale `Done` labels as proof.
3. Record ship/freeze/defer decisions from the canonical plan.
4. Run the narrow baseline checks against the current changes: typecheck, unit/contract tests, static IPC/security audit, and relevant Electron smoke scripts.
5. Capture failures without weakening tests or overwriting current work.
6. Create a reproducible release commit or equivalent snapshot only after review of the diff.

## Acceptance

- No unrelated change is silently removed.
- Baseline commands and exact results are recorded.
- The release candidate has a known source revision and clean or explicitly documented working-tree state.
- Scope freeze is visible to implementers: only P0 release blockers may change after this phase.

## Risks and rollback

If the diff contains an unsafe or unrelated change, isolate it for review instead of deleting it. Roll back only the specific change with evidence of incompatibility.
