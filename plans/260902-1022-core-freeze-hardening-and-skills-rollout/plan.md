---
title: "AntiFan Core Freeze Hardening, Context Isolation Security Probe & Skills Rollout"
description: "Surgical hardening of P1/P2 transport & scheduler invariants, bounded contextIsolation security probe, testing integrity realignment, and OMP Agent Skills transition."
status: in-progress
priority: P1
effort: "4h"
tags: [core-freeze, security, mcp, skills, testing]
created: 2026-09-02
---

# AntiFan Core Freeze Hardening, Context Isolation Security Probe & Skills Rollout

## Overview
This plan establishes the final verified checkpoint for AntiFan Browser Desktop Core Freeze. It surgically resolves P1/P2 runtime defects identified in the 2026-09-02 Deep Audit, executes a bounded security probe on `contextIsolation`, reclassifies the test harness to distinguish in-memory simulations from live OS release gates, and formally certifies the Core Runtime before transitioning engineering focus to OMP Agent Skills.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Inject `control: execControl` into `AuthenticatedCapabilityContext` and align `browser.wait` scheduler metadata with `WaitRegistry` | P1 |
| 2 | Clean intermediate dead idempotency keys in `WorkflowEngine` to preserve deterministic transport lineage | P1 |
| 3 | Execute bounded security probe on `contextIsolation: true` in `getSecureWebPreferences()` across tab preloads and IPC | P1 |
| 4 | Reclassify `test/e2e/soak-test.test.ts` as mathematical simulation and formalize standalone live runners as release gates | P1 |
| 5 | Lock Core Runtime Freeze and initiate OMP Agent Skills rollout (Figma-to-Code, PageSpeed, Sapo/Theme Automation) | P1 |

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | [Phase 1: Preflight Audit & Baseline Inventory](./phase-01-start.md) | In-Progress |
| 2 | [Phase 2: P1 & P2 Core Hardening & Context Invariants](./phase-02-p1-p2-core-hardening-and-context-invariants.md) | Pending |
| 3 | [Phase 3: Context Isolation Security Audit & Probe](./phase-03-context-isolation-security-audit-and-migration.md) | Pending |
| 4 | [Phase 4: Testing Integrity Realignment & Soak Gate Separation](./phase-04-testing-integrity-realignment-and-soak-separation.md) | Pending |
| 5 | [Phase 5: Core Freeze Certification & OMP Skills Rollout](./phase-05-core-freeze-certification-and-skills-rollout.md) | Pending |

## Success Criteria

- [ ] `src/main/tools/capability-transport.ts` passes `control: execControl` into `AuthenticatedCapabilityContext`.
- [ ] `src/main/tools/browser-capabilities.ts` registers `lane: 'event-wait'` for `browser.wait` and `anti.browser.wait`.
- [ ] `src/main/workflow/workflow-engine.ts` delegates child invocation lineage completely to `CapabilityTransportAdapter`.
- [ ] `src/main/security/security-policy.ts` audited for `contextIsolation` feasibility across `tab-preload.ts` and IPC contracts.
- [ ] `test/e2e/soak-test.test.ts` explicitly documented and structured as Unit In-Memory Slope Math verification.
- [ ] Standalone recovery runner (`scripts/benchmark-standalone-recovery.cjs`) confirmed as the authoritative Zero-Orphan release gate.
- [ ] Full test matrix (`tsc -p .` and `npm test`) green with zero regressions.
- [ ] Official Core Runtime Freeze certified.

<!-- slug: core-freeze-hardening-and-skills-rollout -->
