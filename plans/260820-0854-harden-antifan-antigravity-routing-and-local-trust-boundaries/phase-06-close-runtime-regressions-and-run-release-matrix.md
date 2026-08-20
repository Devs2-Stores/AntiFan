---
phase: 6
title: "Close Runtime Regressions and Run Release Matrix"
status: completed
priority: P1
effort: "1 day"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Close Runtime Regressions and Run Release Matrix

## Context Links

- [Plan](./plan.md)
- Review findings H12-H15 and final shipping gates in
  [deep review](../reports/260820-0851-antifan-antigravity-deep-code-review.md)

## Overview

Close the remaining runtime and operations regressions, align docs with source,
then run package, clean-install, crash, security, attachment, and live
two-conversation acceptance before enabling exact Auto.

## Requirements

- MCP stdio stdout contains protocol frames only from process start to exit.
- Site-scoped clear targets the active origin only and cannot restore removed or
  expired/session cookies from a stale plaintext cache.
- Terminal shell and descendants terminate when the owning app/view exits.
- Multi-host heartbeat and stop behavior cannot delete another live host's
  status or claim ownership accidentally.
- Installer update/remove preserves unrelated config, detects malformed or
  concurrently modified config, and removes only hash-owned files/entry data.
- Docs describe only verified current behavior and commands.
- Exact capability is enabled only after every P0 and live gate passes.

## Related Code Files

- Modify: `src/main/index.ts`
- Modify: `src/main/mcp/mcp-server.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/main/browser/cookie-persister.ts`
- Modify: `src/main/browser/terminal-manager.ts`
- Modify: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts`
- Modify: `E:/Work/apps/antigravity-browser/scripts/install-sidecar.mjs`
- Modify: Desktop/Extension package scripts and release tests
- Modify: `docs/security-model.md`, `docs/operations.md`, and owning READMEs
- Create/Modify: subprocess MCP, cookie clear/restore, process cleanup,
  multi-host heartbeat, installer ownership, package, and live acceptance tests

## Implementation Steps

1. Route all MCP-mode diagnostics to stderr before constructing stdio transport.
   Add a subprocess test that parses the first stdout frame.
2. Preserve the documented plain-Node/broker boundary or update implementation
   and docs to one verified architecture without stdout pollution.
3. Pass active origin to `clearStorageData`, remove only matching cookie/cache
   entries, and update persistence on removals.
4. Stop converting session/expired cookies into one-year persistent cookies.
   Protect or eliminate the raw cookie cache according to actual product need.
5. Track terminal process owner, PID/tree, cwd, and shutdown lifecycle. Stop
   cleanly first, then bounded hard kill only for the owned tree.
6. Replace shared `host.json` ownership races with per-instance heartbeats or an
   owner-checked manifest. Stop deletes only the current instance record.
7. Harden installer shared-config update with parse failure stop, backup,
   compare-before-replace, atomic write, ownership hashes, and safe removal.
8. Update security/operations docs from verified code and scripts. Remove stale
   completion claims and unsupported behavior.
9. Run all unit/type/audit gates, fresh VSIX inventory, isolated packaged import,
   clean install/update/remove, and Sidecar heartbeat/restart.
10. Run renderer/bridge negative security probes and crash-boundary protocol
    matrix.
11. Run attachment benchmark for 1, 5, and 8 images up to the 10 MiB boundary;
    record memory, latency, and failure behavior.
12. Run live A-active/B-target matrix with idle/running/restart/invalid/late
    receipt cases. Verify zero wrong-conversation sends and zero duplicates.
13. Enable exact Auto only when the compatibility fingerprint matches and all
    gates pass. Otherwise ship explicit Draft with exact capability disabled.
14. Update plan phase/task status from evidence and run whole-plan consistency.

## Todo

- [ ] Make MCP stdio frame-clean and add subprocess test.
- [ ] Make clear-site origin-scoped and cookie persistence deletion-aware.
- [ ] Stop extending session/expired cookies.
- [ ] Own and stop terminal process trees.
- [ ] Fix multi-host heartbeat ownership.
- [ ] Harden installer config/file ownership.
- [ ] Align docs and README with verified behavior.
- [ ] Pass full automated gates and VSIX runtime closure check.
- [ ] Pass security and crash-boundary matrix.
- [ ] Pass 1/5/8-image 10 MiB benchmark.
- [ ] Pass live A/B exact routing and late receipt matrix.
- [ ] Complete whole-plan consistency and evidence-based status update.

## Release Matrix

| Area | Required cases |
|---|---|
| Routing | A active/B target x3, B running, invalid B, restart, Sidecar offline |
| Delivery | timely receipt, late receipt, missing receipt, forged receipt, response-only observation |
| Durability | crash at claim/invoking/receipt/completed/ack, Extension/Desktop restart |
| Security | tokenless WS, wrong Origin, terminal HTML, Markdown interpolation, traversal delete |
| Attachments | missing, changed, MIME mismatch, symlink, 1/5/8 images, exactly/over 10 MiB |
| Packaging | isolated VSIX import, clean install, update, restart, remove, config preservation |
| Runtime | MCP first frame, clear one site, cookie removal restart, terminal descendant cleanup |

## Validation Commands

```powershell
cd E:\Work\apps\antifan-browser-desktop
npm run verify
npm audit --audit-level=high

cd E:\Work\apps\antigravity-browser
npm run verify
npx tsc -p . --noEmit
npx @vscode/vsce ls
npm run package:verify
```

Run the newly added Sidecar install/probe, crash-matrix, attachment benchmark,
MCP subprocess, and live acceptance scripts using their package commands.

## Success Criteria

- [ ] All automated and live release matrix rows pass with saved redacted
  evidence.
- [ ] Exact capability is enabled only for the verified Antigravity fingerprint.
- [ ] No security model or operations claim exceeds current source behavior.
- [ ] No background process started by validation remains after completion.
- [ ] `git status` contains only intentional plan/source changes.

## Rollback

If any P0 or live gate fails, disable exact Auto, remove the owned Sidecar from
the live profile, preserve receipts/evidence, and keep explicit active-panel
Draft. Peripheral fixes that independently pass may remain; never weaken tests
or re-enable unsafe fallback to make the release matrix green.
