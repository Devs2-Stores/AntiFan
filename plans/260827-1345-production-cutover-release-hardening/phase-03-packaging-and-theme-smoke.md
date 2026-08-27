---
title: "Phase 3: Windows Packaging And Theme Developer Smoke"
status: completed
---

# Phase 3: Windows Packaging And Theme Developer Smoke

## Objective

Prove the actual distributed Electron runtime, not only compiled TypeScript and source-level tests.

## Files to inspect or modify

- `package.json`
- `package-lock.json`
- `scripts/run-electron.cjs`
- `scripts/copy-static.mjs`
- `src/main/index.ts`
- `src/main/browser/terminal-manager.ts`
- `src/main/browser/native-tab-host.ts`
- `src/main/bridge/bridge-server.ts`
- `test/e2e/smoke-split-review.cjs`
- `test/e2e/terminal-renderer-smoke.cjs`
- New packaging configuration only if required by the repository's chosen packaging tool

## Steps

1. Select the smallest Windows x64 packaging route compatible with Electron 43 and the existing scripts.
2. Configure installer or portable output, static asset inclusion, preload paths, production entry, and native `node-pty` handling (`asarUnpack` only where verified necessary).
3. Build the package on Windows and record artifact path, size, hash, and build revision.
4. Launch the packaged app in production mode using an isolated temporary user-data directory.
5. Exercise local preview/watcher, terminal start/stop and process-tree cleanup, Chromium profile persistence, DOM picker, lens, screenshot, and Desktop/Mobile split.
6. Exercise authenticated MCP/Bridge handshake, attachment scope rejection, stale tab/document rejection, and no-side-effect-on-auth-failure.
7. Exercise renderer reload/app restart and verify accepted mutations are not duplicated.
## Evidence outputs

Write all outputs to `plans/260827-1345-production-cutover-release-hardening/reports/smoke/` and package files to `plans/260827-1345-production-cutover-release-hardening/reports/artifacts/`. Update `plans/260827-1345-production-cutover-release-hardening/reports/release-gate-report.md` with the fixed revision, environment versions, exact command, exit code, package path, SHA-256, and observed result.

## Validation commands

Run and record:

```text
npm run compile
<package-build-command>
<packaged-executable> --production
npm run smoke:split
node scripts/run-electron.cjs test/e2e/terminal-renderer-smoke.cjs
<packaged-theme-developer-smoke-command>
<packaged-recovery-smoke-command>
```

Replace angle-bracket placeholders with concrete commands after selecting the packager. Do not mark this phase complete until the commands are concrete and their outputs are stored.

## Acceptance

- Packaged app launches without source-tree assumptions.
- `node-pty` loads and terminal processes terminate cleanly on Windows.
- Theme workflow smoke passes with observable browser/terminal/evidence results.
- Profile/session persistence and rollback artifact are verified.
- Security failures fail closed before host side effects.
- Every command has durable output under the canonical reports directory.

## Risks and rollback

Packaging may expose native-module or path assumptions hidden by development mode. Keep the previous known-good artifact and use an isolated user-data directory for every smoke run. Do not install over a user's live profile during testing.

