---
phase: 4
title: "Add Protocol Liveness Idempotency And Cleanup"
status: pending
priority: P1
effort: "6-8h"
dependencies: [2, 3]
---

# Phase 4: Add Protocol Liveness Idempotency and Cleanup

## Overview

Add the small operational layer needed for reliable daily use: host liveness,
capabilities, duplicate suppression, expiry, and bounded file cleanup.

## Requirements

- Functional: each workspace host writes one atomic `host.json` heartbeat.
- Functional: Desktop checks protocol, workspace, capability, and freshness.
- Functional: an existing result prevents command re-execution.
- Functional: stale temp/command/result files are cleaned without deleting live work.
- Non-functional: no database, daemon, distributed lease, or automatic retry.

## Architecture

The extension refreshes `host.json` every 2-5 seconds with host ID, epoch,
workspace, extension version, protocol version, capabilities, and last-seen
time. Desktop treats stale/missing heartbeat as offline but keeps queued/unknown
records recoverable. Cleanup uses conservative age and filename/schema guards.

## Related Code Files

- Modify: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts` - heartbeat, seen-result barrier, cleanup.
- Modify: `E:/Work/apps/antigravity-browser/src/extension.ts` - lifecycle wiring.
- Modify: `E:/Work/apps/antigravity-browser/test/desktop-command-bridge.test.cjs` - restart/idempotency/cleanup tests.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/antigravity-command-client.ts` - host probe and compatibility status.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/shared/contracts.ts` - host status contract.
- Modify: `E:/Work/apps/antifan-browser-desktop/src/renderer/sidebar.ts` - offline/wrong-workspace/incompatible status.
- Modify: `E:/Work/apps/antifan-browser-desktop/test/main/antigravity-command-client.test.ts` - heartbeat and cleanup tests.

## Implementation Steps

1. Implement atomic heartbeat write and shutdown cleanup.
2. Gate Desktop dispatch on matching fresh host capability.
3. Before execute, return/reuse an existing valid result for the same ID.
4. Expire commands by `expiresAt`; never execute expired mutation.
5. Clean `.tmp`, consumed results, and orphan files older than 24 hours while
   excluding a current command, result, or heartbeat.
6. Surface compact diagnostics for offline, incompatible, expired, and duplicate.

## Success Criteria

- [ ] Duplicate command ID invokes the IDE API at most once across restart tests.
- [ ] A stale heartbeat blocks new mutation with an actionable status.
- [ ] Cleanup preserves fresh files and removes only validated stale artefacts.
- [ ] No timer or watcher remains after disposal.
- [ ] Both repositories pass focused restart/cleanup tests.

## Risk Assessment

Risk: clock skew or a paused IDE marks a live host stale. Mitigation: heartbeat
is only a dispatch guard; it never converts an accepted command to failed or
deletes a recoverable unknown command.
