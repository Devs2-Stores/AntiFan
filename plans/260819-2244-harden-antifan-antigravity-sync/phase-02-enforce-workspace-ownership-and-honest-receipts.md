---
phase: 2
title: "Enforce Workspace Ownership And Honest Receipts"
status: pending
priority: P0
effort: "6-8h"
dependencies: [1]
---

# Phase 2: Enforce Workspace Ownership and Honest Receipts

## Overview

Make each Extension Host consume commands only from workspace folders it owns,
and make receipts describe only evidence the extension actually has.

## Requirements

- Functional: remove global and sibling-project enumeration from live polling.
- Functional: validate workspace before claim; mismatch is a no-op.
- Functional: bound a stalled IDE call and release the bridge queue without resend.
- Non-functional: preserve Draft/Auto attachment behavior and atomic result writes.

## Architecture

`desktopCommandBridge` receives the current workspace folder list from VS Code,
polls only those bridge directories, validates the target, atomically claims an
eligible command, executes once, and writes one terminal receipt. Promise
resolve maps to `ide-api-accepted`; rejection maps to `failed`; the deadline
maps to `unknown`. A late settle is logged and may update the receipt safely,
but never triggers a second call.

## Related Code Files

- Modify: `E:/Work/apps/antigravity-browser/src/runtime.ts` - delegate bridge polling and return honest handoff semantics.
- Modify: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts` - workspace-owned poll, claim, execute, receipt.
- Modify: `E:/Work/apps/antigravity-browser/src/desktopBridge.ts` - v2 validation/state helpers.
- Modify: `E:/Work/apps/antigravity-browser/src/extension.ts` - initialize/dispose the bridge with current workspace ownership.
- Modify: `E:/Work/apps/antigravity-browser/test/package-and-webview.test.cjs` - remove assertions that require false submitted wording.
- Modify: `E:/Work/apps/antigravity-browser/test/desktop-command-bridge.test.cjs` - race, mismatch, timeout, late-settle coverage.

## Implementation Steps

1. Delete broad `E:\Work` and sibling project bridge discovery.
2. Treat zero workspace folders as no mutation authority, not match-all.
3. Validate target workspace and protocol before renaming/claiming a command.
4. Write `ide-api-accepted`, `failed`, or `unknown` receipts atomically.
5. Detach/log a late Promise settlement after deadline; keep idempotency intact.
6. Dispose timers/watchers on extension shutdown.

## Success Criteria

- [ ] Two simulated hosts cannot steal each other's commands.
- [ ] A mismatched host leaves the command and result untouched.
- [ ] Promise resolve never produces `submitted: true`.
- [ ] A stalled Promise releases later commands after the configured deadline.
- [ ] Extension typecheck and focused bridge tests pass.

## Risk Assessment

Risk: multi-root workspaces. Mitigation: accept an exact target matching any
currently open workspace folder; never infer ownership from a parent path.
