---
phase: 5
title: "Concurrency Stress Test, Security & End-to-End Validation Suite"
status: pending
priority: P1
effort: "2h"
dependencies: ["phase-01", "phase-02", "phase-03", "phase-04"]
---

# Phase 05: Concurrency Stress Test, Security & End-to-End Validation Suite

## Overview
Develops an automated concurrency integration test suite (`test/integration/concurrency-multi-project.test.ts`) that verifies multi-project workspace routing, AttachmentRegistry authoritative lease storage, Bridge unauthenticated direct dispatch rejection, fast-path tab lease rebinding, non-blocking background operations with rate limiting (`PassiveExecutionPool`), micro-scoped human preemption cancellation between animation steps, safe lock controller assignment, ViewportGate mutex serialization, and session partition isolation under high-concurrency conditions.

## Requirements
- **Functional**:
  - Test Suite 1 (AttachmentRegistry Authoritative Verification & Bridge Hardening): Verify that Bridge capability dispatches without valid `attachmentClaims` fail closed with `ATTACHMENT_REQUIRED`, while genuine attachment-authenticated dispatches for Project B execute cleanly.
  - Test Suite 2 (Dynamic Workspace Routing): Verify 2 distinct projects and workspaces dispatch capabilities without `WORKSPACE_MISMATCH`.
  - Test Suite 3 (Per-Session Independent Revocation): Verify that revoking Session 1 in `AttachmentRegistry` leaves Session 2 in the same workspace fully functional.
  - Test Suite 4 (Fast-Path Tab Rebind): Verify tab creation immediately allows screenshot and inspect operations ($0$ `TARGET_MISMATCH`).
  - Test Suite 5 (Passive Pool Saturation & Backpressure): Verify 20 simultaneous background DOM requests reject excess calls cleanly with `CAPABILITY_OVERLOADED` without crashing the Chromium renderer.
  - Test Suite 6 (Micro-Scoped Human Preemption): Verify hardware user input simulated between Bézier curve steps triggers `PREEMPTED_BY_USER` and immediately cancels running cursor animations.
  - Test Suite 7 (Safe Lock Controller Assignment): Verify preemption while Session 2 is queued aborts Session 1 (lock holder) and does not corrupt Session 2's controller.
  - Test Suite 8 (ViewportGate Sequential Execution): Verify 2 parallel interactive cursor clicks queue sequentially through `ViewportGate` without crashing or deadlocking.
  - Test Suite 9 (Session Partition Isolation): Verify cookie and storage segregation across capsules (`persist:capsule-${capsuleId}`).
- **Non-Functional**:
  - Entire test suite completes in $< 30\text{s}$ with zero flakiness.
  - 100% pass rate across existing unit and integration tests (`npm test`).

## Related Code Files
- Create: `test/integration/concurrency-multi-project.test.ts`
- Create: `test/unit/tools/capability-catalogue-multi-workspace.test.ts`
- Create: `test/unit/control-plane/multi-tenant-lease-issuance.test.ts`
- Create: `test/unit/tools/passive-execution-pool.test.ts`
- Create: `test/unit/tools/viewport-gate.test.ts`
- Verify: `test/integration/theme-qa-reload-lifecycle.test.ts`

## Implementation Steps
1. **Author Unit Security Tests**:
   - In `test/unit/tools/capability-catalogue-multi-workspace.test.ts`, test rejection of unauthenticated dispatches and verification of `AuthenticatedCapabilityContext`.
   - In `test/unit/control-plane/multi-tenant-lease-issuance.test.ts`, test Project B session creation, `McpAttachmentLaunch` verification, and independent revocation via `AttachmentRegistry.revokeAttachment()`.
2. **Author Concurrency & Preemption Unit Tests**:
   - In `test/unit/tools/passive-execution-pool.test.ts`, test 4/tab and 16/global concurrency limits.
   - In `test/unit/tools/viewport-gate.test.ts`, test FIFO queueing, execution deadlines, micro-scoped preemption, and tab cleanup.
3. **Author End-to-End Integration Suite**:
   - In `test/integration/concurrency-multi-project.test.ts`, run multi-tenant concurrent agent session benchmarks.
4. **Execute Full Test Suite**:
   - Run `npm test` to verify zero regressions across the codebase.

## Success Criteria
- [ ] `npm test` passes completely with zero failures.
- [ ] `test/integration/concurrency-multi-project.test.ts` passes with all 9 security and concurrency test suites green.
- [ ] No race conditions, memory leaks, or unhandled promise rejections during multi-session stress tests.

## Risk Assessment
- **Risk**: Test suite flakiness on slower CI/Windows environments.
- **Mitigation**: Use deterministic event listeners and explicit promise resolution instead of arbitrary `setTimeout` sleeps.
