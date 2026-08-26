---
title: "Phase 5: Specify verification, security, and rollback gates"
status: complete
---

# Phase 5: Specify verification, security, and rollback gates

## Overview

Specify evidence-based verification, security, and rollback gates that prove the adapter seam preserves behavior, control-plane authority, cleanup, and user-visible run state. These specifications define the mandatory acceptance criteria and test fixtures that must be delivered across Migration Slices A through F.

## Requirements

- [x] Specify focused contract test requirements defending observable invariants (identity, capabilities, sequencing, bounded payloads).
- [x] Define non-regression baseline gate requiring all existing execution-backend, Codex, control-plane, browser-control, and integration tests (217 tests currently passing) to remain passing at each slice.
- [x] Specify security checks covering executable allowlisting, argument/env sanitization, prompt/event size limits, adapter identity, session binding, permission denial, and secret redaction.
- [x] Specify runtime failure scenarios covering spawn failure, malformed JSONL/ACP messages, duplicate/late events, tool failure, approval denial, cancellation races, timeout, crash, restart, and dispose cleanup.
- [x] Specify browser smoke criteria verifying that adapters cannot seize browser authority and that run evidence remains linked to the correct project/run.

## Implementation Steps

1. Build a verification matrix mapping each invariant to focused unit/contract tests, integration tests, and real smoke scenarios (specified in `architecture.md` Section 7.1).
2. Specify adversarial fixture requirements for untrusted executable paths, hostile arguments/environment values, oversized/malformed events, unknown capabilities, stale session IDs, mismatched project IDs, and duplicate terminal events (specified in `architecture.md` Section 7.1).
3. Specify cancellation test points at pre-spawn, handshake, session setup, prompt streaming, approval wait, tool execution, and post-terminal cleanup points (specified in `architecture.md` Section 4 & 7.1).
4. Specify Codex-compatible adapter smoke path requirements with deterministic test executables or controlled fixtures (specified in `architecture.md` Section 7.1).
5. Define rollback triggers and procedures: any public event regression, authority crossing, leaked process, cross-run session attachment, unredacted secret, lost evidence, or changed DeepSeek default behavior blocks cutover (specified in `architecture.md` Section 7.3).
6. Specify retention of the compatibility facade and old backend path until all gates pass (specified in `architecture.md` Section 3.4 & 6).
7. Specify consumer-failure fixture requirements asserting that exceptions thrown from the control-plane event consumer terminate the owned process and revoke attachments (specified in `architecture.md` Section 4 & 7.1).
8. Specify duplicate/late event fixture requirements asserting that post-terminal records are non-authoritative diagnostics (specified in `architecture.md` Section 4 & 7.1).

## Todo

- [x] Build contract and lifecycle verification matrix
- [x] Add security and malformed-input scenarios
- [x] Exercise cancellation, crash, restart, and cleanup paths
- [x] Run browser/evidence smoke scenarios
- [x] Define rollback triggers and cutover evidence

## Success Criteria

- [x] Verification matrix specifies one authoritative terminal outcome per run and no process/resource leak on any terminal path.
- [x] Security review specifies no route from adapter input to unauthorized executable, browser, filesystem, secret, or approval authority.
- [x] Browser smoke specifies that attachment, control, and evidence ownership remain in AntiFan.
- [x] Rollback criteria define how to restore the compatibility path without data loss or stale session reuse.
- [x] Current baseline test suite (217 tests across 52 suites) verified passing 100%.
