---
phase: 2
title: "Reconcile current architecture and freeze contracts"
status: completed
priority: P1
effort: "3d"
dependencies: [1]
---

# Phase 2: Reconcile Current Architecture and Freeze Contracts

## Overview

Resolve the mismatch between the documented Project/Harness architecture and
the live singleton `NativeTabHost` tree, then add characterization tests and
versioned shared contracts without changing the UI owner yet.

## Requirements

- Functional: one documented owner for runtime bootstrap, browser control,
  terminal, MCP, delivery, and transcript import.
- Non-functional: preserve dirty user changes and existing Antigravity behavior;
  new contracts must be runtime-validated and backward-compatible at adapters.

## Architecture

Introduce transport-neutral DTOs and validators under `src/shared/` or the
project's existing contract boundary. Existing host methods remain behind
adapters. `TranscriptSyncer` and `DeliveryLedger` are migration inputs until a
single durable store is selected.

## Related Code Files

- Create/modify: `src/shared/contracts.ts`, `src/shared/control-plane-contracts.ts`
- Modify: `src/main/index.ts`, `src/main/browser/native-tab-host.ts`, `src/main/mcp/mcp-server.ts`
- Create: `test/main/control-plane-contracts.test.ts`, `test/main/bootstrap-boundary.test.ts`
- Create: `plans/260820-1301-build-antifan-standalone-control-plane/reports/reality-ledger.md`

## Implementation Steps

1. Compare every older plan claim against source and tests; record dependency or
   supersession decisions in the reality ledger.
2. Define versioned IDs and envelopes for Project/Workspace/Chat/Run/Attempt,
   target binding, provenance, event, receipt, artifact, and capability errors.
3. Add canonical workspace containment helpers for Windows drive, UNC, case,
   junction, and symlink cases; reject implicit `process.cwd()` fallbacks.
4. Define a runtime feature/adapter switch with explicit drain states so a
   rollback can stop new writes, await/mark owned attempts, dispose transports,
   and restore the legacy path deterministically.
5. Add characterization tests for current startup, MCP attachment, active-tab
   fallback, transcript import, and delivery-unknown behavior.

## Success Criteria

- [x] Plan overlap is explicit and no duplicate owner is introduced.
- [x] Contract validators reject malformed IDs, stale epochs, and unbound targets.
- [x] Existing focused tests remain green.
- [x] Security docs no longer claim absent owners as shipped behavior.
- [x] Rollback/drain state and compatibility switch have an owner and test.

## Risk Assessment

Changing shared DTOs can break IPC consumers. Keep adapters accepting old
messages, add contract version fields, and remove compatibility only after the
new runtime has an integration test.
