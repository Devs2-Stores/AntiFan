---
title: "Phase 4: Release Gates, Rollback, And Cutover Decision"
status: completed
---

# Phase 4: Release Gates, Rollback, And Cutover Decision

## Objective

Make the ship/no-ship decision from evidence and stop continuous feature development.

## Files to inspect or modify

- `docs/operations.md`
- `docs/security-model.md`
- `docs/ui-architecture.md`
- `README.md`
- `plans/260827-1345-production-cutover-release-hardening/plan.md`
- Release artifacts and test reports

## Steps

1. Run the complete release gate suite on one fixed release-candidate revision.
2. Verify artifact redaction, TTL/max-count cleanup, profile preservation, uninstall behavior, and previous-artifact rollback.
3. Confirm no legacy renderer/bridge runs concurrently in production and no unowned parity-ledger row blocks cutover.
4. Reconcile plan statuses and record exact evidence links/commands; do not mark criteria by label alone.
5. Decide one state: `Ship`, `Ship opt-in`, or `Internal Preview`.
6. If shipping, freeze the feature roadmap and move all deferred ideas to post-release backlog. If not shipping, open only blocker fixes.
## Evidence outputs

Write the canonical decision to `plans/260827-1345-production-cutover-release-hardening/reports/release-gate-report.md`. Link every gate to durable output under `reports/baseline/`, `reports/smoke/`, `reports/security/`, or `reports/artifacts/`. Each record includes source revision, environment, exact command/procedure, exit code or observed result, and pass/fail status.

## Validation command list

```text
npm run typecheck
npm test
node --test .compiled/test/main/ipc-audit.test.js
node --test .compiled/test/main/capability-catalogue.test.js
npm run compile
<package-build-command>
<packaged-executable> --production
npm run smoke:split
node scripts/run-electron.cjs test/e2e/terminal-renderer-smoke.cjs
<packaged-theme-developer-smoke-command>
<packaged-recovery-smoke-command>
<rollback-command-or-procedure>
```

Angle-bracket entries must be replaced with concrete commands before completion. Missing packaged launch, packaged smoke, or rollback evidence forces `Internal Preview`.

## Acceptance

- Every gate has pass/fail evidence in the canonical report.
- A failed gate names the smallest cause-aligned follow-up; no scope creep is introduced.
- The final release status is explicit and reproducible by another developer.
- Feature development stops at the decision boundary.

## Required gate groups

- Source/type/test/static contracts
- Packaged Windows startup and native addon
- Theme Developer browser/terminal/evidence loop
- MCP/Bridge authentication and attachment enforcement
- Recovery, process cleanup, and rollback
- Redaction, retention, profile preservation, and legacy cutover


## Risks and rollback

If evidence is incomplete, choose `Internal Preview`, not a speculative production claim. Roll back by package artifact and preserve user data; never replay an unknown mutation.
