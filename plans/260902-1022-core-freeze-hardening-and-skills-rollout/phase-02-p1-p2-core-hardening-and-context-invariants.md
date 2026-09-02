---
phase: 2
title: "P1 & P2 Core Hardening & Context Invariants"
status: pending
priority: P1
effort: "45m"
dependencies: [1]
---

# Phase 2: P1 & P2 Core Hardening & Context Invariants

## Overview
Surgically fix the two P1 defects and the P2 lineage cleanup: inject `control: execControl` into `AuthenticatedCapabilityContext`, correct `browser.wait` metadata lane to `event-wait`, and clean intermediate random idempotency keys in `WorkflowEngine`.

## Requirements
- `AuthenticatedCapabilityContext` must receive `control: execControl` so capability executors can report `effectStage` and acknowledge cancellations.
- `browser.wait` and `anti.browser.wait` catalogue registration must declare `lane: 'event-wait'` to match `WaitRegistry` runtime dispatch.
- `WorkflowEngine` must pass clean intent objects without dead random idempotency keys, leaving child lineage generation solely to `CapabilityTransportAdapter`.

## Architecture
```text
CapabilityTransportAdapter.dispatchIntent()
  ├─ const execControl = new ExecutionControlImpl(invocationId);
  ├─ authContext: AuthenticatedCapabilityContext = {
  │    ...,
  │    control: execControl   <-- [INJECTED]
  │  }
  └─ this.classifySettlement(err, policy, execControl)

Browser Capabilities Registration:
  └─ makeBrowserPolicy({ lane: 'event-wait', ... })  <-- [ALIGNED WITH WAITREGISTRY]

WorkflowEngine.invokeCap():
  └─ minimalIntent = { name, params: payload }       <-- [CLEANED INTERMEDIATE KEY]
```

## Related Code Files
- Modify: `src/main/tools/capability-transport.ts`
- Modify: `src/main/tools/browser-capabilities.ts`
- Modify: `src/main/workflow/workflow-engine.ts`

## Implementation Steps
1. Edit `src/main/tools/capability-transport.ts` line 407 to include `control: execControl`.
2. Edit `src/main/tools/browser-capabilities.ts` lines 172 and 440 to specify `lane: 'event-wait'`.
3. Edit `src/main/workflow/workflow-engine.ts` line 382 to remove `makeControlPlaneId` key assignment in `minimalIntent`.
4. Run focused compiler and unit test checks (`tsc -p .`, `test/main/capability-catalogue.test.ts`, `test/main/workflow-engine.test.ts`).

## Success Criteria
- [ ] `authContext.control` is defined and populated for all authenticated dispatches.
- [ ] `catalogue.getPolicy('browser.wait').schedulerLane === 'event-wait'`.
- [ ] `WorkflowEngine` dispatches preserve deterministic `child:...` idempotency keys in `InvocationLedger`.

## Risk Assessment
- Risk: Capability handlers throwing if `control` methods fail.
- Mitigation: `ExecutionControlImpl` methods are non-throwing and idempotent.
