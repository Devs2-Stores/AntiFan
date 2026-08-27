---
title: "Phase 2: Single Workflow Authority And Safe Pruning Audit"
status: completed
---

# Phase 2: Single Workflow Authority And Safe Pruning Audit

## Objective

Remove execution ambiguity while preserving workflow behavior and avoiding unproved bulk deletion.

## Files to inspect or modify

- `src/main/control-plane/control-plane-runtime.ts`
- `src/main/browser/native-tab-host.ts`
- `src/main/workflow/workflow-registry.ts`
- `src/main/workflow/workflow-engine.ts`
- `src/main/workflow/workflow-capabilities.ts`
- `src/main/tools/capability-catalogue.ts`
- `src/main/tools/browser-control-port.ts`
- `test/workflow-and-artifact-security.test.ts`
- `test/main/workflow-engine.test.ts`
- `src/main/bridge/bridge-server.ts`
- `src/main/bridge/mobile-remote-html.ts`
- `src/main/bridge/qr-generator.ts`
- `src/main/chat/chat-store.ts`
- `src/main/agent/deepseek-harness-adapter.ts`

## Steps

1. Map all workflow registry construction and callsites with symbol-aware references and static scans.
2. Make `ControlPlaneRuntime` the only production workflow authority for policy, scope, execution, events, receipts, and artifacts.
3. Preserve or explicitly rebind legacy UI workflow IPC to that authority; do not leave a fake success handler that claims execution without running the engine.
4. Add or update tests for duplicate registration, unauthorized execution, stale scope, failure receipts, and successful workflow execution.
5. Produce a pruning report for mobile remote, QR, chat, DeepSeek, and any workflow modules. Delete only a target with zero production callers, no parity-ledger owner, and no migration/recovery contract.
6. Keep deletions separate from behavior changes for easy rollback.

## Acceptance

- Exactly one production workflow registry/dispatch path exists.
- Workflow mutations use capability policy and authoritative receipts.
- No handler reports `passed` without executing the bound workflow or returning a truthful unsupported/error result.
- All retained callers and tests pass.
- Any deferred deletion has a written caller/ownership reason; no speculative deletion is applied.

## Risks and rollback

The main risk is breaking legacy toolbar workflow controls. Roll back only the workflow routing change if parity tests fail; do not reintroduce a second authority as a permanent fallback.
