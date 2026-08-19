---
phase: 1
title: "Lock Protocol And Regression Contracts"
status: completed
priority: P0
effort: "4-6h"
dependencies: []
---

# Phase 1: Lock Protocol And Regression Contracts

## Overview

Create the testable protocol contract before changing live behavior. Capture
the current false-success and cross-host race as failing regression tests.

## Requirements

- Functional: one versioned command/result vocabulary shared by both repos.
- Functional: delivery and observation are separate state dimensions.
- Non-functional: no shared package or code-generation pipeline across repos.
- Compatibility: accept legacy v1 commands during the same release, but emit v2.

## Architecture

Protocol v2 keeps the current atomic JSON file transport. Required command
fields: `protocolVersion`, `id`, `createdAt`, `expiresAt`, `senderId`, exact
workspace target, action, mode, prompt digest, and staged file descriptors.
Required result fields: protocol version, command ID, host identity/epoch,
workspace, `ok`, delivery state, error code/message, and completion timestamp.

## Related Code Files

- Modify: `E:/Work/apps/antifan-browser-desktop/src/shared/contracts.ts` - delivery and observation types carried to the sidebar.
- Create: `E:/Work/apps/antifan-browser-desktop/src/main/bridge/antigravity-command-client.ts` - desktop protocol owner and filesystem seam.
- Create: `E:/Work/apps/antifan-browser-desktop/test/main/antigravity-command-client.test.ts` - desktop contract/repro tests.
- Modify: `E:/Work/apps/antigravity-browser/src/desktopBridge.ts` - canonical v2 command/result validation helpers.
- Create: `E:/Work/apps/antigravity-browser/src/desktopCommandBridge.ts` - extension polling/claim seam extracted from runtime.
- Create: `E:/Work/apps/antigravity-browser/test/desktop-command-bridge.test.cjs` - multi-host and receipt tests.

## Implementation Steps

1. Write fixtures for v1 compatibility and v2 command/result/host documents.
2. Add tests reproducing false success, wrong-host deletion, duplicate execution,
   missing receipt, stalled Promise, and transcript/delivery conflation.
3. Add typed parsers with bounded string/path/array sizes and explicit error codes.
4. Keep `sendToAgentPanel` behind an injectable callback so tests need no IDE.

## Success Criteria

- [ ] Tests fail against current behavior for the intended reasons.
- [ ] Contract rejects unsafe IDs, expired commands, mismatched workspace, and incompatible versions.
- [ ] No schema field claims submit, composer delivery, first token, or streaming.
- [ ] Existing command and IPC names remain compatible.

## Risk Assessment

Risk: two competing contracts remain. Mitigation: make `desktopBridge.ts` own
validation semantics and route the live file consumer through those helpers;
do not maintain a second independent state vocabulary.
