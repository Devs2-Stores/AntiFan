---
phase: 1
title: "Establish Fail-Closed and Reproducible Release Baseline"
status: completed
priority: P0
effort: "1-1.5 days"
dependencies: []
---

# Phase 1: Establish Fail-Closed and Reproducible Release Baseline

## Context Links

- [Plan](./plan.md)
- [Deep review](../reports/260820-0851-antifan-antigravity-deep-code-review.md)
- Existing Extension: `E:/Work/apps/antigravity-browser`
- Existing Desktop: `E:/Work/apps/antifan-browser-desktop`

## Overview

Stop unsafe automatic behavior before repairing the protocol, establish an
authoritative Git/release boundary for the Extension, and make the Sidecar
router, installer, and compatibility probe executable from a complete VSIX.
Exact Auto remains capability-disabled until Phase 3 passes.

## Requirements

- Functional: Sidecar unavailable, stale, incompatible, unmapped, or invalid
  must return a typed exact-route failure before active-panel dispatch.
- Functional: Draft remains an explicit user-selected active-panel action.
- Functional: exact abort is rejected; global active-panel abort is never
  represented as exact.
- Security: remove automatic legacy v1 command execution from workspace files.
- Release: Extension/Sidecar source is tracked by one authoritative Git owner.
- Packaging: a fresh VSIX contains every transitive runtime dependency needed
  by router, installer, and probe.
- Operations: documented install/probe/remove commands perform real work and
  return non-zero on failure.

## Architecture Decisions

- Default source-control ownership: dedicated Git repository at
  `E:/Work/apps/antigravity-browser`. If the parent monorepo is intentionally
  authoritative, replace the broad ignore with an explicit tracked subtree and
  record that decision in the repo README.
- Move runtime-shared AgentAPI utilities out of excluded `scripts/**` into the
  packaged Sidecar runtime closure. Scripts may import the runtime library, not
  the reverse.
- Installer copies an immutable, hashed router closure to an owned stable
  location, then writes an absolute Node executable and absolute router path.
  It must not point Antigravity at a developer checkout or `process.cwd()`.

## Related Code Files

- Modify: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts`
- Modify: `E:/Work/apps/antigravity-browser/src/runtime.ts`
- Modify: `E:/Work/apps/antigravity-browser/src/desktopBridge.ts`
- Modify: `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/router.mjs`
- Create: `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/lib/agentapi.mjs`
- Modify: `E:/Work/apps/antigravity-browser/scripts/install-sidecar.mjs`
- Modify: `E:/Work/apps/antigravity-browser/scripts/probe-agentapi-sidecar.mjs`
- Modify: `E:/Work/apps/antigravity-browser/package.json`
- Modify: `E:/Work/apps/antigravity-browser/.vscodeignore`
- Modify: `E:/Work/apps/antigravity-browser/test/package-and-webview.test.cjs`
- Modify/Create: focused Sidecar entrypoint, package, legacy-command, and
  fail-closed routing tests under `E:/Work/apps/antigravity-browser/test/`
- Modify: `E:/Work/apps/antifan-browser-desktop/docs/operations.md`

## Implementation Steps

1. Establish the authoritative Git owner and capture a clean baseline that
   includes Extension, Sidecar, scripts, package rules, and tests.
2. Add a temporary exact-capability gate defaulting to disabled until a valid
   live Sidecar fingerprint and conversation mapping are present.
3. Change exact Auto routing to return `EXACT_ROUTE_UNAVAILABLE` instead of
   invoking the active-panel callback. Expose a separate explicit Draft action.
4. Reject exact abort with `EXACT_ABORT_UNSUPPORTED`; await and render receipts
   for any supported non-exact abort path.
5. Remove legacy workspace command auto-upgrade/execution. Quarantine or report
   unsupported files without side effects.
6. Add router main entrypoint: construct, start, handle SIGINT/SIGTERM, emit
   heartbeat, and exit non-zero on startup failure.
7. Add CLI argument parsing and structured output for Sidecar probe/install/
   remove. Keep exported functions for tests.
8. Relocate packaged runtime dependencies under `sidecars/` and update imports.
9. Make installer copy and hash the full owned runtime closure before updating
   Antigravity config. Validate source and target paths before mutation.
10. Add package scripts such as `sidecar:probe`, `sidecar:install`,
    `sidecar:remove`, and `package:verify`.
11. Add an inventory test that packages or lists the VSIX and imports the
    packaged router from an isolated directory.
12. Update operations docs only after the real commands pass.

## Todo

- [ ] Choose and establish authoritative Extension Git ownership.
- [ ] Disable exact Auto fail-open fallback.
- [ ] Reject unscoped exact abort.
- [ ] Remove legacy command execution.
- [ ] Add router startup and shutdown entrypoint.
- [ ] Add installer/probe CLI entrypoints.
- [ ] Package the complete Sidecar runtime closure.
- [ ] Install to an owned stable absolute path with hashes.
- [ ] Add package scripts and artifact inventory tests.
- [ ] Verify clean install, heartbeat, restart, and removal in a disposable
  config/data root before touching the live profile.

## Validation

```powershell
cd E:\Work\apps\antigravity-browser
npm test
npx tsc -p . --noEmit
npx @vscode/vsce ls
npm run package:verify
npm run sidecar:probe -- --json
```

Use disposable config/data directories for installer cycle tests. The live
profile is modified only after the isolated cycle passes.

## Success Criteria

- [ ] An exact Auto command with Sidecar offline never calls active panel.
- [ ] Exact abort cannot invoke global `antigravity.abort`.
- [ ] Legacy committed command files produce no send or abort side effect.
- [ ] Running the packaged router creates a valid heartbeat and stays alive.
- [ ] Fresh VSIX runtime import succeeds with no missing module.
- [ ] Install/update/remove commands are idempotent and operate on owned files.
- [ ] The exact capability remains disabled pending Phase 3.

## Risks and Rollback

| Risk | Mitigation |
|---|---|
| Users lose implicit Auto fallback | Present a clear one-click Draft action; never hide the route change |
| Source-control migration captures unrelated parent changes | Track only the Extension tree or use a dedicated repo |
| Installer mutates live config during development | Require disposable-root tests before live install |

Rollback by disabling exact capability, removing only the owned Sidecar entry
and hashed files, and retaining explicit Draft behavior.
