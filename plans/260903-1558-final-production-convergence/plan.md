---
title: "Final Production Convergence & Certification"
description: "Execution roadmap for the final three milestones to achieve 100% production readiness: Real Chromium E2E isolation certification, Generic Reconstruction with dynamic responsive constraints, and Release Packaging."
status: pending
priority: P1
effort: "2d"
tags: ["core", "e2e", "chromium", "reconstruction", "responsive", "release"]
created: 2026-09-03
---

# Final Production Convergence & Certification

## Overview
AntiFan has achieved high maturity in Core Browser Isolation (`23f1056`) and Dual-Scope Behavior Verification (`632a534`). This plan delivers the three final convergence steps to bring the entire system to 100% production readiness:
1. **Real Chromium E2E Isolation Certification:** Execute live headless/windowed Electron soak workloads on actual web targets to certify zero memory leak, cookie isolation, and tab lifecycle stability outside mocks.
2. **Generic Reconstruction & Responsive Constraint Engine:** Upgrade `ResponsiveScanner` in `@antifan/site-clone` from static presets to dynamic multi-viewport diffing (1440/768/390), elevate `ComponentContractIR` with relational layout constraints, and connect `AssetHarvester` as a first-class canonical producer.
3. **Production Packaging, Certification Snapshot & Release:** Full test suite convergence, update audit registers with certified HEAD signatures, and package the Windows production standalone installer.

## Goals

| # | Goal | Priority | Deliverable |
|---|------|----------|-------------|
| 1 | Real Chromium E2E Isolation Certification | P1 | Live Electron soak and cookie isolation verification |
| 2 | Generic Reconstruction & Responsive Constraints | P1 | Dynamic viewport constraint scanner & IR layout relations |
| 3 | Production Packaging & Release Certification | P2 | Full test suite convergence and Windows production build |

## Phases

| # | Phase | Status | Focus |
|---|-------|--------|-------|
| 1 | [Phase 1: Real Chromium E2E & Isolation Certification](./phase-01-start.md) | Pending | Live Electron smoke & soak test |
| 2 | [Phase 2: Generic Reconstruction & Responsive Constraints](./phase-02-generic-reconstruction-and-responsive-constraints.md) | Pending | Multi-viewport diffing & layout constraint IR |
| 3 | [Phase 3: Production Packaging & Release Certification](./phase-03-production-packaging-and-release-certification.md) | Pending | Windows installer, audit update, release cut |

## Success Criteria

- [ ] Real Electron smoke workload passes against a live storefront target without crash or unhandled promise rejection.
- [ ] Ephemeral tabs on live Chromium prove complete cookie isolation (cookies set in ephemeral tab never leak to default session).
- [ ] ResponsiveScanner dynamically infers column transitions (4 -> 2 -> 1) from viewport diffs without hardcoded class vocabulary.
- [ ] ComponentContractIR contains explicit relational layout constraints (container bounds, sidebar/content ratios, grid gaps).
- [ ] 100% test pass rate maintained across root fast tests, capability catalogue, and `@antifan/site-clone`.
- [ ] Production build (`npm run package`) generates clean standalone executable.

<!-- slug: final-production-convergence -->
