---
phase: 6
title: "Production Certification"
status: pending
priority: P0
effort: "1d + soak window"
dependencies: [1, 2, 3, 4, 5]
---

# Phase 6: Production Certification

## Overview

Prove the complete ownership, isolation, MCP, security, restart, and Windows capture contracts in fresh processes before declaring Core production-ready.

## Requirements

- Functional: All phase acceptance criteria are exercised through focused tests and real runtime scenarios.
- Functional: Failure-path evidence proves fail-closed behavior without user-plane mutation.
- Non-functional: Runs are reproducible, leave no orphan processes/resources, and record exact commands/results without fabricated success.

## Architecture

Certification combines static contract checks, focused unit/integration suites, and fresh-process Windows scenarios. A user-plane sentinel remains active while two agent attachments perform interleaved browser/terminal/capture operations. Restart and crash probes validate persistence and cleanup.

## Related Code Files

- Modify: focused tests under `test/unit/`, `test/integration/`, and `test/main/`
- Create: permanent `scripts/smoke-dual-plane-cutover-runner.cjs` following existing certification-runner conventions
- Modify: `package.json` with a stable `certify:dual-plane` aggregate command

## Implementation Steps

1. Run `npm run compile` before compiled tests, then focused suites for TerminalManager, NativeTabHost persistence, Bridge sessions, BrowserControlPort targeting, MCP adapter, profile ownership, ACL, preload, navigation, vault, and capture.
2. Run static absence checks for prohibited authority patterns in Agent Plane: active-tab fallback, global target mutation, persisted secrets, Electron MCP Core bootstrap, shared-world privileged preload.
3. Start one fresh GUI process and establish a user sentinel tab; record tab ID, URL, focus/active state, document generation, and screenshot hash.
4. Start two independent MCP proxies/attachments; verify distinct targets and interleave navigation, DOM read, input, viewport, terminal, and capture operations.
5. Confirm both offscreen captures are non-empty and target-specific while the sentinel remains unchanged and visible.
6. Exercise stale and missing authority: stale generation, closed target, expired attachment, mismatched credential, bridge offline, reused pairing code, untrusted IPC origin.
7. Kill one proxy and verify only its resources are reaped; continue operations through the other attachment.
8. Restart GUI and verify no agent tabs restore, no stale profile lock remains, no transient terminal ownership survives, and user tabs restore correctly.
9. Exercise context-isolated UI/browser features and navigation/popup protections on real Chromium content.
10. Run the existing broader Main suite and release smoke/soak appropriate to the changed public contracts; investigate every failure rather than weakening tests.
11. Record final pass/fail evidence and compare against every global success criterion. Production verdict is binary: verified complete or blocked.

## Success Criteria

- [ ] Typecheck and all affected focused/broader suites pass.
- [ ] Two live attachments operate independently with zero cross-session target or terminal contamination.
- [ ] User sentinel tab never changes focus, URL, generation, or rendered content during agent work.
- [ ] Offscreen captures are non-empty and target-correct on Windows.
- [ ] All missing/stale/expired/mismatched authority cases fail before side effects.
- [ ] Proxy crash and GUI restart leave zero leaked attachment, tab, terminal process, profile lock, or restored agent tab.
- [ ] Pairing, ACL, context-isolation, vault IPC, navigation, and popup negative proofs pass.
- [ ] Final evidence covers every plan-level acceptance criterion with no unresolved contradiction.

## Risk Assessment

- **False-green mocks:** unit tests may not expose Electron compositor/profile behavior. Signal: tests pass without launching real GUI/Bridge/proxy. Response: runtime scenarios are mandatory release gates.
- **User interference with sentinel:** manual interaction can invalidate evidence. Signal: focus or generation changes without agent trace. Response: use a dedicated deterministic sentinel and timestamped operation trace; rerun only the affected scenario.
- **Orphan process contamination:** stale GUI/proxy owners can invalidate profile tests. Signal: port/profile already owned before run. Response: identify and stop only processes launched by the certification harness, then restart from clean state.
