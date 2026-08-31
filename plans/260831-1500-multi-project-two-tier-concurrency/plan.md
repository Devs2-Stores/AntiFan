---
title: "CapsuleScope Dynamic Workspace & Two-Tier Concurrency Engine (CDW-2T)"
slug: "260831-1500-multi-project-two-tier-concurrency"
status: "in-progress"
created: "2026-08-31T15:00:00.000Z"
priority: "P1"
totalPhases: 5
blockedBy: []
blocks: []
---

# Plan: CapsuleScope Dynamic Workspace & Two-Tier Concurrency Engine (CDW-2T)

## Executive Summary
This implementation plan establishes full multi-project, multi-session, and multi-tab concurrency within AntiFan Browser Desktop. It permanently eliminates `TARGET_MISMATCH` and `TARGET_STALE` errors during agent tab lifecycle operations. It establishes `AttachmentRegistry` as the **sole authoritative lease and credential store**, eliminates circular lease issuance dependencies by generating scoped leases directly during session creation, hardens `BridgeServer` by removing unauthenticated direct parameter dispatch, and implements a two-tier execution engine combining throttled background `WebContents` operations (`PassiveExecutionPool`), physical user input preemption with micro-scoped provenance (`syncWithAgentInput`), and a cooperative FIFO `ViewportGate` mutex for visual cursor interactions.

## Architectural Blueprint
```
+-----------------------------------------------------------------------------------------------+
|                                      CLIENT / AGENT LAYER                                     |
|  [Agent A: Haravan Repo]           [Agent B: Sapo Repo]            [Background QA Worker]     |
+-----------------------------------------------------------------------------------------------+
                                                |
                                                v
+-----------------------------------------------------------------------------------------------+
|         CONTROL PLANE: ATTACHMENT REGISTRY AUTHORITATIVE STORE & WORKSPACE ROUTER             |
|  1. createCliSession(cwd / wsId) -> issueRuntimeLease(targetWs.pId, targetWs.id)              |
|  2. AttachmentRegistry.issueAttachment(runId, attemptId, targetWs.pId, targetWs.id, { lease })|
|  3. AttachmentRegistry.validateAttachment(claims) -> AuthenticatedCapabilityContext           |
|  4. CapabilityCatalogue.dispatch() -> resolveAuthoritativeWorkspace(authContext.pId, wsId)   |
|  5. assertRuntimeLease(authContext.lease, { token: authContext.leaseToken })                  |
|  6. assertExactBrowserTarget(authContext.browserTarget, { projectId: targetWs.pId, ... })     |
+-----------------------------------------------------------------------------------------------+
                                                |
                        +-----------------------+-----------------------+
                        |                                               |
                        v                                               v
+-----------------------------------------------+ +---------------------------------------------+
|    TIER 1: CONCURRENT BACKGROUND ENGINE       | |     TIER 2: SERIALIZED INTERACTIVE ENGINE   |
| (inspect.dom, screenshot, eval, qa_validate)  | |         (agent.cursor.*, click, type)       |
| • PassiveExecutionPool (Max 4/tab, 16 global) | | • Global ViewportGate FIFO Mutex            |
| • Direct WebContents (No GUI tab switch)      | | • Micro-Scoped Provenance (agentInputInFlight)|
| • Prevents renderer freezing & DoS            | | • Physical Key Preemption (Abort on key)    |
|                                               | | • 10s Execution Deadline with AbortSignal   |
+-----------------------------------------------+ +---------------------------------------------+
                        |                                               |
                        +-----------------------+-----------------------+
                                                |
                                                v
+-----------------------------------------------------------------------------------------------+
|                     NATIVE TAB HOST & ELECTRON SESSION PARTITIONS                             |
|  • Dynamic Fast-Path Tab Lease Rebinding on createTab() & switchTab()                         |
|  • Dynamic isCurrentTarget() matching resolved tenant workspace identity                      |
|  • Strict Session Partition Isolation: persist:capsule-${capsuleId}                           |
+-----------------------------------------------------------------------------------------------+
```

## Phases Overview

| Phase | Title | Priority | Status | Files Modified |
| :--- | :--- | :---: | :---: | :--- |
| **01** | AttachmentRegistry Authoritative Store, Workspace Router & Bridge Hardening | P1 | Pending | `control-plane-runtime.ts`, `capability-catalogue.ts`, `run-service.ts`, `bridge-server.ts`, `file-capabilities.ts` |
| **02** | Fast-Path Tab Lease Rebinding & Explicit TabId Routing | P1 | Pending | `mcp-server.ts`, `bridge-server.ts`, `browser-control-port.ts` |
| **03** | Two-Tier Concurrency Engine, Global ViewportGate & Passive Pool | P1 | Pending | `native-tab-host.ts`, `tab-automation-host.ts`, `browser-control-port.ts` |
| **04** | Dynamic Document Generation & Multi-Workspace Target Settle | P1 | Pending | `native-tab-host.ts`, `theme-qa-workflow.ts`, `browser-session-partition.ts` |
| **05** | Concurrency Stress Test, Security & End-to-End Validation Suite | P1 | Pending | `test/integration/concurrency-multi-project.test.ts`, `test/unit/tools/capability-catalogue-multi-workspace.test.ts`, `test/unit/control-plane/multi-tenant-lease-issuance.test.ts` |

## Acceptance Criteria
- [ ] **AC-1**: `AttachmentRegistry` serves as the single authoritative lease and credential store; `ControlPlaneRuntime` generates scoped leases per session without circular dependencies, and Bridge unauthenticated direct parameter dispatch is eliminated.
- [ ] **AC-2**: `anti.browser.tabs.create` automatically updates `authContext.attachmentId` and `browserTarget.tabId`, allowing immediate `screenshot` and `inspect.dom` with $0$ `TARGET_MISMATCH` errors.
- [ ] **AC-3**: Passive background operations (`inspect.dom`, `screenshot.viewport`, `eval_js`, `theme.qa_validate`) are bounded by `PassiveExecutionPool` (max 4 per tab, max 16 global), executing directly on target `WebContents` without switching foreground tabs or freezing the Chromium renderer.
- [ ] **AC-4**: Micro-scoped input provenance (`syncWithAgentInput`) allows physical user input between Bézier curve steps to immediately preempt active synthetic agent actions (`PREEMPTED_BY_USER`), restoring immediate control to the user.
- [ ] **AC-5**: Interactive cursor actions (`anti.agent.cursor.*`, `click`, `type`) acquire the global `ViewportGate` mutex safely with a $10,000\text{ms}$ execution deadline and clean disposal on tab closure.
- [ ] **AC-6**: Each project capsule maintains isolated cookies and local storage (`persist:capsule-${capsuleId}`).
- [ ] **AC-7**: Focused cross-project unit and integration tests (including unauthenticated Bridge dispatch rejection, Project-B attachment issuance, and independent session revocation) pass completely with zero regressions across the codebase.
