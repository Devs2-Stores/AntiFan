---
title: "Production Cutover And Release Hardening"
description: "Freeze AntiFan feature scope, close the single workflow authority, produce a Windows package, and prove the Theme Developer workflow before shipping."
status: completed
priority: P1
effort: "3-5 days"
branch: main
tags: [infra, critical, tech-debt]
blockedBy: []
blocks: []
created: 2026-08-27
---

# Production Cutover And Release Hardening

## Overview

AntiFan has enough surface area for a Haravan/Sapo/Shopify Theme Developer workbench. The remaining risk is release closure: uncommitted load-bearing changes, competing workflow registration, no verified Windows packaging path, and no packaged end-to-end smoke evidence. This plan deliberately adds no product feature. It converts the current repository into a bounded release candidate or records the exact blocker that prevents shipping.

## Outcome

A reproducible Windows x64 release candidate supports the daily loop:

```text
project -> local preview -> inspect/pick/lens -> edit in terminal -> desktop/mobile review -> evidence -> verification
```

The release candidate preserves Chromium-first authority, Project/Workspace/Run/Attempt binding, authenticated MCP/Bridge boundaries, profile persistence, and safe process cleanup. If any release gate fails, the result remains `Internal Preview` and only the failing blocker may be fixed.

## Constraints

- Main remains the sole authority for Chromium, terminal, filesystem, credentials, capability policy, receipts, and artifacts.
- Do not run Haravan/HRV CLI commands automatically.
- Preserve the current public IPC envelopes unless a tested release blocker requires a contract change.
- Do not retry an unknown mutation automatically.
- Raw credentials, cookies, page bodies, and large base64 payloads stay out of renderer state, shared contracts, and diagnostics.
- Existing user changes in the working tree are part of the input and must be reviewed, not overwritten.
- Deletion requires dependency, caller, parity, and migration evidence.

## Non-goals

- No agent swarm, model router, prompt framework, embedded reasoning runtime, cloud sync, remote execution, plugin marketplace, video recording, or broad browser-action expansion.
- No full ACP/Agent Adapter implementation.
- No broad UI redesign or `src/main/index.ts` decomposition.
- No immediate bulk deletion of workflow, mobile-remote, QR, chat, or DeepSeek modules.
- No auto-update or code-signing infrastructure; document these as external release dependencies if absent.

## Production surface

| Surface | Ship decision |
|---|---|
| Chromium tabs, profile/session, navigation, zoom | Ship if packaged smoke passes |
| Local preview and file watcher | Ship if bounded smoke passes |
| DOM inspection, picker, lens, screenshot | Ship if evidence/redaction checks pass |
| Desktop/Mobile split review | Ship if native Electron smoke passes |
| Integrated terminal and process tracking | Ship if packaged `node-pty` and cleanup pass |
| Authenticated MCP and Extension Bridge | Ship only with handshake, attachment, and fail-closed tests |
| Embedded chat, plugins, speculative agent features | Freeze; no new scope |

## Goals

| # | Goal | Priority |
|---|---|---|
| 1 | Lock the current changes and release scope | P0 |
| 2 | Make ControlPlaneRuntime the sole workflow execution authority | P0 |
| 3 | Produce and exercise a Windows Electron package | P0 |
| 4 | Prove the real Theme Developer workflow and recovery boundaries | P0 |
| 5 | Record a binary ship/no-ship decision and stop feature expansion | P0 |

## Phases

| # | Phase | Depends on | Status |
|---|---|---|---|
| 1 | [Baseline, scope freeze, and change audit](./phase-01-baseline-scope-freeze.md) | - | Completed |
| 2 | [Single workflow authority and safe pruning audit](./phase-02-workflow-authority-and-pruning.md) | 1 | Completed |
| 3 | [Windows packaging and Theme Developer smoke](./phase-03-packaging-and-theme-smoke.md) | 1, 2 | Completed |
| 4 | [Release gates, rollback, and cutover decision](./phase-04-release-gates-and-cutover.md) | 3 | Completed |

All release evidence is stored under:

```text
plans/260827-1345-production-cutover-release-hardening/reports/
├── release-gate-report.md       # canonical pass/fail record
├── baseline/                     # command output and static audit results
├── smoke/                       # packaged Electron and Theme Developer smoke logs
├── security/                    # MCP/Bridge, attachment, redaction, and recovery evidence
└── artifacts/                   # installer/portable package, SHA-256, and rollback artifact metadata
```

`release-gate-report.md` MUST record the fixed source revision, Windows/Node/Electron versions, exact command, working directory, exit code, artifact path/hash, observed result, and pass/fail decision for every gate. Secrets, cookies, page bodies, tokens, and customer data MUST NOT be copied into reports or logs.

Required validation command list:

```text
npm run typecheck
npm test
node --test .compiled/test/main/ipc-audit.test.js
node --test .compiled/test/main/capability-catalogue.test.js
npm run compile
node scripts/package-windows.mjs
plans/260827-1345-production-cutover-release-hardening/reports/artifacts/AntiFan-Browser-Desktop-win32-x64/antifan-browser-desktop.exe --production
npm run smoke:split
node scripts/run-electron.cjs test/e2e/terminal-renderer-smoke.cjs
node scripts/smoke-packaged-theme-developer.cjs
node scripts/smoke-packaged-recovery.cjs
node scripts/smoke-rollback-procedure.cjs
```
Angle-bracket commands are resolved during Phase 3 after the packaging route is selected; they MUST be replaced with concrete commands before the release gate is marked complete. Source-level tests do not substitute for packaged launch, packaged smoke, or rollback evidence.

## Release evidence index

The Phase 4 decision MUST link each acceptance criterion to one report section or artifact in `reports/`. Missing, redacted, or non-reproducible evidence forces `Internal Preview`.

## Rollback evidence

The rollback record MUST include the previous artifact hash, the candidate artifact hash, the isolated user-data path used for the test, profile/data preservation observations, and confirmation that no unknown mutation was replayed.

## Acceptance criteria

- [x] Current load-bearing changes are reviewed, tested, and captured in a reproducible release commit or snapshot (`reports/baseline/baseline-audit-report.md`).
- [x] One workflow registry/dispatch authority remains; no browser-host workflow path bypasses ControlPlaneRuntime policy and receipts (`src/main/control-plane/control-plane-runtime.ts`, `test/main/ipc-audit.test.ts`).
- [x] `npm run typecheck`, `npm test`, static IPC/security checks, and focused Electron smoke pass on the release candidate (`228 passed`, 0 errors).
- [x] A Windows x64 packaged artifact launches in production mode with correct preload, static assets, profile persistence, and `node-pty` operation (`reports/artifacts/windows-x64-manifest.json`).
- [x] Local preview, watcher, DOM picker, lens, screenshot, split review, terminal cleanup, authenticated MCP/Bridge, and stale-target rejection are exercised (`reports/smoke/packaged-theme-developer-smoke.log`, `reports/smoke/split-review-smoke.log`, `reports/smoke/terminal-renderer-smoke.log`).
- [x] Restart/recovery and rollback do not duplicate accepted mutations or silently retry unknown mutations (`reports/smoke/packaged-recovery-smoke.log`, `reports/smoke/rollback-smoke.log`).
- [x] Artifact retention/redaction and uninstall/profile preservation match the documented security and operations contracts (`reports/smoke/rollback-smoke.log`).
- [x] The final state is explicitly `Internal Preview` (initial RC1 baseline cutover); no feature roadmap is opened before this decision (`reports/release-gate-report.md`).
## Release decision rule

```text
all required gates pass -> Ship or Ship opt-in
any required gate fails -> Internal Preview; fix only that blocker
```

Missing packaging or packaged smoke evidence is a release blocker even when TypeScript and unit tests pass.

## Evidence note

The prior ultra verifier was incomplete: three candidates completed and two were cancelled. This plan uses only the converged findings from the completed reports and does not claim a complete best-of-five selection.

## Rollback

Rollback uses the previous package artifact and preserved user data. Never run legacy and new renderer paths concurrently as a fallback. Never replay an unknown mutation during rollback. Profile deletion remains an explicit separate user action.

<!-- slug: production-cutover-release-hardening -->
