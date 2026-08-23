---
phase: 8
title: "Move Antigravity behind a compatibility adapter"
status: completed
priority: P1
effort: "4d"
dependencies: [4, 6]
---

# Phase 8: Move Antigravity Behind a Compatibility Adapter

## Overview

Preserve the current Antigravity delivery path while mapping it into the
backend-neutral Run/receipt model and keeping transcript sync observational.

## Requirements

- Functional: dispatch, timeout, transcript observation, late reconciliation,
  resume metadata, and explicit delivery states.
- Non-functional: exact Workspace/digest/host binding, no active-tab inference,
  no auto-retry of unknown mutations, and compatibility rollback.

## Architecture

`AntigravityExecutionBackend` wraps `AntigravityCommandClient`; `TranscriptSyncer`
imports/projections provider evidence only. Delivery states are `prepared`,
`dispatching`, `accepted-exact`, `accepted-active-panel`, `prompt-observed`,
`response-observed`, `failed`, `unknown`, and `unavailable`.

## Related Code Files

- Create: `src/main/integrations/antigravity/antigravity-execution-backend.ts`
- Modify: `src/main/bridge/antigravity-command-client.ts`, `src/main/bridge/transcript-syncer.ts`, `src/main/browser/native-tab-host.ts`
- Inspect/coordinate: `E:/Work/apps/antigravity-browser/src/sidecarRouterClient.ts`, `E:/Work/apps/antigravity-browser/sidecars/antifan-chat-router/router.mjs` when the companion checkout is present
- Create: `test/main/antigravity-execution-backend.test.ts`, `test/integration/antigravity-late-reconciliation.test.ts`

## Implementation Steps

1. Persist the expected command binding before writing a request, then preserve
   v2 command/result/host validation, prompt digesting, atomic writes,
   timeout-to-unknown, and late receipt checks.
2. Add desktop timeout `>= bridge deadline + buffer`; late TranscriptSyncer
   evidence may upgrade uncertainty only after exact correlation.
3. Validate command ID, digest, exact canonical Workspace, host epoch/instance,
   and provider session before accepting immediate or late files; missing fields
   are rejected and never treated as compatible.
4. Map transcript/session switches and rename/delete to import operations, never
   to standalone Chat/Run ownership.
5. If the Sidecar route is enabled, verify authTag plus exact workspace path,
   prompt/attachment digest, conversation, route, host/client/sidecar instance,
   deadline, and source command binding; claim commands atomically so a crash
   cannot execute the same request twice.

## Success Criteria

- [x] RunService can switch Codex and Antigravity adapters without contract
  changes.
- [x] A timeout followed by an exact transcript event reconciles deterministically.
- [x] Wrong Workspace/digest/epoch evidence is quarantined and tested.
- [x] Restart can recover the expected binding before accepting a late receipt.
- [x] Sidecar and desktop both reject missing/mismatched binding fields and
      stale/concurrent instances; no same-command duplicate invocation occurs.
- [x] Existing Antigravity tests remain green and rollback is one adapter flag.

## Risk Assessment

Antigravity panel routing and transcript timing do not prove agent token start.
Keep `unknown` honest; transcript correlation is late reconciliation, not a
stronger dispatch receipt.
