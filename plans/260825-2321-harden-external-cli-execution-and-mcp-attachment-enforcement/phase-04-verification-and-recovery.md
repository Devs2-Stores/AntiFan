---
title: "Phase 4: Verification and Recovery"
status: completed
priority: P1
effort: "5-8d"
dependencies: [2, 3]
---

# Phase 4: Verification and Recovery

## Overview

Make completion and recovery truthful. A process exit, workflow step result,
capability result, screenshot/DOM artifact, and final verification are
separate observations with explicit lineage. Fix the current Workflow IPC
false-positive while adding restart reconciliation that invalidates old
attachments and never retries unknown mutations automatically.

## Requirements

- Normalize process lifecycle events from `ExecutionBackend` without treating
  exit code 0 as a verified user outcome.
- Record capability invocation/result, workflow execution, evidence/artifact,
  verification, and final result as separately typed events tied to exact
  Run/Attempt/attachment lineage.
- Workflow IPC must call the real `WorkflowEngine`/capability path or return a
  truthful unsupported/error state. It must not return `{ ok: true, status:
  'passed' }` from `NativeTabHost` without execution.
- Workflow IPC must enter the Main-owned authenticated-context boundary as
  MCP and Bridge capability calls. The renderer may select a stored workflow
  only; Main must prove sender/window ownership and resolve immutable
  Run/Attempt/tab/browser-epoch state plus the current document cursor before
  invoking the engine.
- `WorkflowEngine.execute()` must not receive raw renderer/IPC lineage, lease,
  grant, or target fields as authority. It accepts a Main-derived authenticated
  context or is called by a separately authenticated internal workflow service.
- If sender/window ownership cannot be proven, workflow IPC fails closed via
  attachment validation. Forged lineage or target claims reject before
  WorkflowEngine, CapabilityCatalogue, workflow, browser, file, terminal, or
  artifact executor invocation; tests assert zero host-side spy calls.
- Verification must check the requested target and expected evidence. A
  screenshot or DOM artifact alone is evidence, not verification; a CLI text
  claim is not browser proof.
- On restart, hydrate durable Run/Attempt facts before opening external MCP or
  child-adapter transports, invalidate all pre-crash attachment secrets, probe
  owned process/target where safe, and classify `completed`, `failed`,
  `interrupted`, or `unknown`. Unknown side effects need explicit
  reconciliation and a new attachment before resume/retry.
- Late receipt/status events must be rejected or recorded as late evidence and
  cannot reactivate a terminal/revoked Attempt.

## Current source anchors

- `src/main/run/run-service.ts:79-95` catches backend errors and currently
  applies generic terminal states; `:139-165` maps backend status and receipt
  state.
- `src/main/session/event-store.ts`, `receipt-store.ts`, and
  `src/main/tools/artifact-store.ts` are the existing persistence owners.
- `src/main/workflow/workflow-engine.ts:60-132` executes workflow steps through
  the catalogue and creates a workflow result.
- `src/main/browser/native-tab-host.ts:686-694` currently returns a passed
  status without running the workflow.
- `src/main/workflow/workflow-engine.ts:97-113` currently constructs a raw
  `CapabilityRequestContext` from caller-supplied `runId`, `attemptId`, lease,
  grant, and target; replacing only the IPC stub with `execute()` would retain
  an authorization bypass.
- `src/preload/toolbar-preload.ts:109-111` exposes run/abort IPC and
  `src/renderer/toolbar.ts:475-490` maps `status === 'passed'` to the UI pill.
- `src/main/agent/codex-execution-backend.ts:55-63` maps process exit to
  completed/failed/unknown backend status.

## Architecture

```text
process event -> Run/Attempt lifecycle
capability call/result -> ToolInvocation evidence
workflow engine result -> workflow outcome
DOM/screenshot/console/terminal -> ArtifactRef evidence
verification probe -> verified/unverified/needs-reconciliation
final result -> only after required verification policy passes
```

Recovery sequence:

1. Load event/receipt/artifact projections and hydrate Run/Attempt maps before
   opening any external transport.
2. Mark all old attachment registry entries revoked/stale; if hydration fails,
   keep external MCP disabled rather than accepting claims.
3. Find Attempts with non-terminal state and classify owned process/transport
   liveness using the authenticated connection and Main-owned process record;
   do not assume a PID or provider session is still the same.
4. Mark process/attempt/run interrupted, completed, failed, or unknown based on
   observed facts. Do not infer tool success from a missing final event.
5. Reconcile pending tool invocations and artifacts by exact lineage.
6. Require an explicit new attachment and user/host decision for resume or
   retry; do not duplicate an unknown mutation.

## Related Code Files

- Modify: `src/main/run/run-service.ts`
- Modify: `src/main/session/event-store.ts`
- Modify: `src/main/session/receipt-store.ts`
- Modify: `src/main/tools/artifact-store.ts`
- Modify: `src/main/workflow/workflow-engine.ts`
- Modify: `src/main/browser/native-tab-host.ts`
- Modify: `src/preload/toolbar-preload.ts`
- Modify: `src/renderer/toolbar.ts`
- Modify: `src/main/control-plane/control-plane-runtime.ts`
- Create or modify: `src/main/run/run-recovery.ts`
- Modify: `test/main/run-lifecycle.test.ts`
- Create or modify: `test/main/run-recovery.test.ts`
- Create or modify: `test/main/workflow-ipc.test.ts`
- Modify: `test/main/codex-execution-backend.test.ts`

## Implementation Steps

1. Add explicit event/result types and ensure RunService persists process,
   tool, workflow, evidence, verification, and final-result transitions
   separately.
2. Replace the NativeTabHost workflow stub with an injected Main-owned workflow
   application boundary. The boundary proves sender/window ownership or
   validates the attachment, resolves immutable Run/Attempt/tab/browser-epoch
   state and the current document cursor, then invokes WorkflowEngine with a
   Main-derived context. Do not pass raw IPC `runId`, `attemptId`, lease, grant,
   or target fields into `WorkflowEngine.execute()` as authority. Wire abort to
   a live Run/Attempt cancellation path and return `needs-verification`,
   `failed`, or `interrupted` truthfully.
3. Add forged workflow IPC tests for each lineage and target field, including
   self-consistent IDs without a Main-issued attachment. Assert rejection occurs
   before WorkflowEngine, CapabilityCatalogue, browser, file, terminal,
   workflow, and artifact executors; host-side spy counts remain zero.
4. Add recovery hydration and attachment invalidation. Test late receipts,
   restart during process, restart after process exit but before final event,
   old token reuse, and direct restart attempts from `interrupted`/`unknown`
   without reconciliation. Test that hydration completes before transport
   startup and that abort propagates to in-flight capability/workflow calls.
5. Add verification scenarios for desktop/mobile target, navigation cursor
   advancement, stale same-document generation, responsive overflow,
   console/network errors, and artifact lineage. Keep artifact budgets/redaction
   enforced by existing stores.
6. Run focused tests, then typecheck/full suite and the Windows process/IPC
   smoke scenario. Inspect only the changed contracts for secret leakage.

## Success Criteria

- [ ] Process completion, workflow completion, evidence capture, and verified
      final result are distinct and reconstructable from durable events.
- [ ] The workflow IPC no longer reports passed without running or explicitly
      reporting an unsupported/error outcome.
- [ ] Startup hydration precedes external transport opening; restart invalidates
      old attachments and classifies in-flight Attempts without automatic
      duplicate mutation.
- [ ] Late/replayed receipts cannot change terminal Run/Attempt state, and
      cancellation aborts in-flight capability/workflow execution.
- [ ] Tests cover recovery, false-positive workflow prevention, verification
      boundaries, navigation cursor updates, and exact Run/Attempt/tab/epoch
      lineage.

## Risks and rollback

Verification may expose existing callers that treated `status: 'passed'` as a
workflow guarantee. Update the renderer to display the richer state rather than
coercing all non-passed states into failure. If durable recovery cannot prove a
process or side effect, preserve `unknown` and require reconciliation; never
weaken the state to make the UI green.
