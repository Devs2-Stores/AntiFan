---
phase: 1
title: "AttachmentRegistry Authoritative Store, Dual Dispatch Paths & Dynamic Workspace Router"
status: pending
priority: P1
effort: "3h"
dependencies: []
---

# Phase 01: AttachmentRegistry Authoritative Store, Dual Dispatch Paths & Dynamic Workspace Router

## Overview
Establishes `AttachmentRegistry` as the **sole authoritative store** for external capability attachments, runtime leases, and cryptographic secrets. 

Resolves the dispatch security and internal runtime workflow architecture by implementing explicit **Dual Dispatch Paths**:
1. **`dispatchAuthenticated(name, params, authContext)`**: Used for all external Bridge WebSocket and MCP clients. Accepts only an `AuthenticatedCapabilityContext` produced by `AttachmentRegistry.validateAttachment(claims)`, where secret hash, TTL, and nonce have been cryptographically verified.
2. **`dispatchTrusted(name, params, context)` (Internal Only)**: Retained strictly for in-process trusted ControlPlane coordinators (e.g. `ControlPlaneRuntime.executeWorkflow()`, internal nested workflow engines). Validates `authoritativeWs` and ensures the lease runtime ID matches the active process.
3. **Dynamic Tenant Workspace Resolution in `executeWorkflow()`**:
   - Updates `executeWorkflow()` to resolve the authoritative workspace from `options.target.workspaceId` / `options.target.projectId`, issuing a scoped lease for that project/workspace and resolving `workspaceRoot` from the target workspace rather than a singleton default.

## Requirements
- **Functional**:
  - **Dual Dispatch Interface in `CapabilityCatalogue`**:
    - `dispatchAuthenticated(name: string, params: Record<string, unknown>, context: AuthenticatedCapabilityContext): Promise<unknown>`
    - `dispatchTrusted(name: string, params: Record<string, unknown>, context: CapabilityRequestContext): Promise<unknown>`
  - **Dynamic Tenant Resolution on Session Start**:
    In `ControlPlaneRuntime.createCliSession()`, `issueAttemptAttachment()`, and `executeWorkflow()`, resolve the target `WorkspaceRecord` from `this.workspaces` / `WorkspaceCapsuleManager`.
  - **Direct Scoped Lease Generation (No Circular Dependency)**:
    Generate a fresh `RuntimeLease` stamped with the resolved `(targetWs.projectId, targetWs.id, ttlMs)` and pass it directly into `AttachmentRegistry.issueAttachment()`.
  - **Bridge Server Hardening**:
    In `src/main/bridge/bridge-server.ts`, remove unauthenticated parameter dispatch (lines 606–622). All capability dispatches across Bridge and MCP route through `dispatchAuthenticated`.
  - **Contextual Root Resolution in Workflows & Files**:
    In `file-capabilities.ts`, `theme-qa-workflow.ts`, and `executeWorkflow()`, resolve `workspaceRoot` from `authoritativeWorkspace.rootPath` dynamically.
- **Non-Functional**:
  - Zero dual-store lease duplication; per-session revocation is strictly isolated by `attachmentId`.
  - Fail-closed security: unauthenticated direct calls or cross-tenant forged claims are rejected with typed `CapabilityError('ATTACHMENT_REQUIRED' | 'ATTACHMENT_INVALID' | 'PROJECT_MISMATCH' | 'WORKSPACE_MISMATCH')`.

## Architecture
```
                                 EXTERNAL CALLERS (Bridge / MCP)
                                                │ (attachmentClaims)
                                                ▼
                                 AttachmentRegistry.validateAttachment(claims)
                                 - Cryptographic secret verification (crypto.timingSafeEqual)
                                 - Monotonic invocationId nonce verification
                                 - TTL & active state validation
                                                │
                                                ▼ Yields AuthenticatedCapabilityContext
                                 CapabilityCatalogue.dispatchAuthenticated()
                                                │
                                                ▼
                                 1. resolveAuthoritativeWorkspace(authContext.projectId, authContext.workspaceId)
                                 2. assertExactBrowserTarget(authContext.browserTarget, ...)
                                 3. Execute definition with contextual `authoritativeWs.rootPath`

========================================================================================================

                                 TRUSTED IN-PROCESS CALLERS (executeWorkflow)
                                                │ (target: BrowserTarget)
                                                ▼
                                 1. Resolve targetWs from (target.projectId, target.workspaceId)
                                 2. Issue scoped session lease for targetWs
                                 3. CapabilityCatalogue.dispatchTrusted(name, params, reqContext)
                                 4. Execute workflow within targetWs.rootPath
```

## Related Code Files
- Modify: `src/main/control-plane/control-plane-runtime.ts` (Lines 45-255)
- Modify: `src/main/tools/capability-catalogue.ts` (Lines 9-70)
- Modify: `src/main/run/run-service.ts` (Lines 190-240)
- Modify: `src/main/bridge/bridge-server.ts` (Lines 600-640, 720-765)
- Modify: `src/main/mcp/mcp-server.ts` (Lines 460-520)
- Modify: `src/main/tools/file-capabilities.ts` (Lines 20-80)
- Create: `test/unit/control-plane/multi-tenant-lease-issuance.test.ts`
- Create: `test/unit/tools/capability-catalogue-multi-workspace.test.ts`

## Implementation Steps
1. **Implement Dual Dispatch in `src/main/tools/capability-catalogue.ts`**:
   ```typescript
   export class CapabilityCatalogue {
     private resolveAuthoritativeWorkspace(projectId: string, workspaceId: string): WorkspaceRecord {
       if (this.options.workspaceRegistry) {
         try {
           const ws = this.options.workspaceRegistry.get(workspaceId, projectId);
           if (ws && ws.state === 'attached') {
             return ws;
           }
         } catch (err: unknown) {
           const msg = err instanceof Error ? err.message : String(err);
           if (msg.includes('Project')) {
             throw new CapabilityError('PROJECT_MISMATCH', `Workspace '${workspaceId}' does not belong to Project '${projectId}'`);
           }
           throw new CapabilityError('WORKSPACE_MISMATCH', `Workspace '${workspaceId}' is not attached to Project '${projectId}'`);
         }
         throw new CapabilityError('WORKSPACE_MISMATCH', `Workspace '${workspaceId}' is not attached`);
       }

       if (projectId !== this.options.projectId) throw new CapabilityError('PROJECT_MISMATCH', 'Capability request Project does not match runtime');
       if (workspaceId !== this.options.workspaceId) throw new CapabilityError('WORKSPACE_MISMATCH', 'Capability request Workspace does not match runtime');
       return { id: workspaceId, projectId, rootPath: '', state: 'attached', createdAt: 0, updatedAt: 0 };
     }

     /**
      * External Authenticated Dispatch: Used by Bridge and MCP.
      * Strictly requires an AuthenticatedCapabilityContext produced by AttachmentRegistry.
      */
     async dispatchAuthenticated(name: string, params: Record<string, unknown>, context: AuthenticatedCapabilityContext): Promise<unknown> {
       if (this.runtime.lifecycle !== 'active') throw new CapabilityError('RUNTIME_DRAINING', 'Runtime is draining and accepts no new capability requests');

       const authoritativeWs = this.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);

       assertRuntimeLease(context.lease, {
         projectId: authoritativeWs.projectId,
         workspaceId: authoritativeWs.id,
         hostEpoch: this.options.hostEpoch,
         token: context.leaseToken
       });

       if (context.lease.runtimeId !== this.options.runtimeId) {
         throw new CapabilityError('RUNTIME_MISMATCH', 'Capability request Runtime does not match active control plane');
       }

       const definition = this.definitions.get(name);
       if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
       if (!this.isVisible(definition, context.grant)) throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by current policy`);

       if (definition.requiresBrowserTarget) {
         assertExactBrowserTarget(context.browserTarget, {
           projectId: authoritativeWs.projectId,
           workspaceId: authoritativeWs.id,
           runtimeId: this.options.runtimeId
         }, true);
       }

       return definition.execute(params, context);
     }

     /**
      * Trusted Internal Dispatch: Used exclusively by in-process ControlPlane coordinators.
      */
     async dispatchTrusted(name: string, params: Record<string, unknown>, context: CapabilityRequestContext): Promise<unknown> {
       if (this.runtime.lifecycle !== 'active') throw new CapabilityError('RUNTIME_DRAINING', 'Runtime is draining and accepts no new capability requests');

       const authoritativeWs = this.resolveAuthoritativeWorkspace(context.projectId, context.workspaceId);

       assertRuntimeLease(context.lease, {
         projectId: authoritativeWs.projectId,
         workspaceId: authoritativeWs.id,
         hostEpoch: this.options.hostEpoch,
         token: context.leaseToken
       });

       if (context.lease.runtimeId !== this.options.runtimeId) {
         throw new CapabilityError('RUNTIME_MISMATCH', 'Capability request Runtime does not match active control plane');
       }

       const definition = this.definitions.get(name);
       if (!definition) throw new CapabilityError('CAPABILITY_NOT_FOUND', `Unknown capability: ${name}`);
       if (!this.isVisible(definition, context.grant)) throw new CapabilityError('POLICY_DENIED', `Capability ${name} is not enabled by current policy`);

       if (definition.requiresBrowserTarget) {
         assertExactBrowserTarget(context.browserTarget, {
           projectId: authoritativeWs.projectId,
           workspaceId: authoritativeWs.id,
           runtimeId: this.options.runtimeId
         }, true);
       }

       return definition.execute(params, context);
     }

     /**
      * General dispatch gateway: Routes AuthenticatedCapabilityContext to dispatchAuthenticated
      * or CapabilityRequestContext to dispatchTrusted.
      */
     async dispatch(name: string, params: Record<string, unknown>, context: CapabilityRequestContext | AuthenticatedCapabilityContext): Promise<unknown> {
       if ('attachmentId' in context && context.attachmentId) {
         return this.dispatchAuthenticated(name, params, context as AuthenticatedCapabilityContext);
       }
       return this.dispatchTrusted(name, params, context);
     }
   }
   ```
2. **Update `executeWorkflow` in `src/main/control-plane/control-plane-runtime.ts`**:
   ```typescript
   async executeWorkflow(options: {
     workflow: WorkflowDefinition;
     target: BrowserTarget;
     grant?: 'read' | 'write' | 'execute' | 'eval';
     signal?: AbortSignal;
     onEvent?: WorkflowEventListener;
   }): Promise<WorkflowExecutionResult> {
     // 1. Resolve target workspace dynamically from target's project/workspace
     const targetWs = this.workspaces.get(options.target.workspaceId, options.target.projectId);
     const ttlMs = 600_000;
     const lease = issueRuntimeLease(targetWs.projectId, targetWs.id, ttlMs, this.leaseState.hostEpoch);
     if (this.leaseState.runtimeId) {
       lease.runtimeId = this.leaseState.runtimeId;
     }

     const boundTarget = assertExactBrowserTarget(options.target, {
       projectId: targetWs.projectId,
       workspaceId: targetWs.id,
       runtimeId: lease.runtimeId || '',
       browserEpoch: lease.hostEpoch,
     }, false);

     const session = this.runs.createWorkflowSession({
       projectId: targetWs.projectId,
       workspaceId: targetWs.id,
       workflowName: options.workflow.name,
       grant: options.grant || 'write',
       tabId: boundTarget.tabId,
       browserEpoch: boundTarget.browserEpoch,
       hostEpoch: lease.hostEpoch,
       ttlMs,
       lease,
       leaseToken: lease.token,
     });

     const reqContext: CapabilityRequestContext = {
       lease: session.lease,
       leaseToken: session.leaseToken,
       projectId: targetWs.projectId,
       workspaceId: targetWs.id,
       runId: session.run.id,
       attemptId: session.attempt.id,
       browserTarget: boundTarget,
       grant: options.grant || 'write',
       signal: options.signal,
     };

     return (await this.capabilities.dispatchTrusted(
       'workflow.execute',
       {
         workflow: options.workflow,
         workspaceRoot: targetWs.rootPath,
         signal: options.signal,
         onEvent: options.onEvent,
       },
       reqContext
     )) as WorkflowExecutionResult;
   }
   ```
3. **Bridge Server Hardening (`src/main/bridge/bridge-server.ts`)**:
   - In `bridge-server.ts:606-622`, remove the direct non-attachment dispatch block.
   - Route `antifan.capability.dispatch` directly to `this.capabilityTransport.dispatch` passing `authContext` (`AuthenticatedCapabilityContext`).
4. **Author Unit Tests**:
   - `test/unit/control-plane/multi-tenant-lease-issuance.test.ts`: Test creating Project B session and executing Project B workflow through `executeWorkflow()`, asserting execution resolves `targetWs.rootPath` correctly.
   - `test/unit/tools/capability-catalogue-multi-workspace.test.ts`: Test that external Bridge dispatches without `attachmentClaims` fail closed with `ATTACHMENT_REQUIRED`.

## Success Criteria
- [ ] In-process workflows (`executeWorkflow()`) execute cleanly for Project B targets with correct contextual `workspaceRoot`.
- [ ] Bridge capability dispatches without valid `attachmentClaims` are rejected with `ATTACHMENT_REQUIRED`.
- [ ] Capability requests for Project B with valid attachment claims validate and execute without `PROJECT_MISMATCH` or `WORKSPACE_MISMATCH`.
- [ ] Revoking a single session in `AttachmentRegistry` (`revokeAttachment(id)`) invalidates only that session without affecting sibling sessions in the same workspace.

## Risk Assessment
- **Risk**: External tools expecting unauthenticated direct Bridge execution.
- **Mitigation**: All official AntiFan CLI clients already use `antifan.capability.dispatch` with `attachmentClaims`.
