---
title: "antifan-clone-understanding-and-theme-synthesis-engine"
description: "Architectural Triad for website cloning and Haravan Theme OS synthesis: AntiFan Core Frozen Kernel (src/main/), Standalone Clone Package (packages/site-clone/), and 8-Dimension Multi-QA Verification Engine."
status: in-progress
priority: P1
effort: "4d"
tags: ["antifan", "clone-engine", "haravan-theme", "cdp", "multi-qa", "visual-diff"]
created: 2026-09-02
blockedBy: ["260902-1022-core-freeze-hardening-and-skills-rollout"]
---

# AntiFan Clone Understanding & Haravan Theme Synthesis Engine

## Executive Overview
This plan establishes an industrial-grade, zero-bloat website cloning and theme synthesis architecture. It unifies low-level browser runtime primitives (AntiFan Core Frozen Kernel in `src/main/`) with a decoupled cognitive understanding package (`packages/site-clone/` consuming AntiFan MCP over standard JSON-RPC tool contracts) producing `clone-spec.json` IR and a multi-dimensional QA verification engine.

The system converts live e-commerce storefronts (Livewire, React, Next.js, WordPress) into production-ready, modular Haravan OS 2.0 themes with verifiable visual fidelity (<10% required benchmark criterion; <2.5% target), responsive reflow, and full interactive operability.

## Evidence Reconciliation & Grounding
- **Reported-but-Unverified Claims**: Prose reports (`reports/clone-final-report.md`, `reports/clone-benchmark.md`) claim 0.81% Desktop diff (1440px), 1.25% Tablet (768px), and 2.10% Mobile (390px) (Overall 1.38%). However, the machine-readable ledger `reports/clone-benchmark.json` currently has empty `iterations: []`. These figures are classified as unverified report claims until machine-readable run logs are generated in Phase 1.
- **Historical Telemetry Breakdown**:
  - Unstabilized dynamic carousel drift generated an initial 77.36% visual mismatch.
  - A previous full-page unmasked inlier run was recorded at 24.11% in `ANTIFAN_IMPROVEMENTS.md`.
  - Scrollbar-gutter delta (15px) contributed to horizontal misalignment.
- **Caller Tracing & Fixture Status**: `benchmark-hoplongtech/assets/js/qa-freeze-hook.js` only defined `window.__antiFreezeState` with zero in-repo callers. The manual invocation path will be characterized and the fixture eliminated in Phase 1.
- **Superseded Decisions**: The destructive `clearInterval(1..9999)` and permanent `transition: none` hooks in `qa-freeze-hook.js` and earlier improvement notes are **explicitly superseded** by the non-destructive Two-Phase Settle Policy (in `packages/site-clone/`) and Clean-Tab Testing Protocol.
- **Cross-Plan Dependency**: This plan honors and depends on `260902-1022-core-freeze-hardening-and-skills-rollout`, keeping `src/main/` strictly frozen as an execution substrate and placing all mutable e-commerce reasoning into `packages/site-clone/`.

## Goals & Key Performance Indicators
| # | Goal | Target Metric | Priority |
|---|------|---------------|----------|
| 1 | Core Zero-Bloat Kernel | 0 clone/Liquid tools in Core `src/main/`; 100% minimal CDP primitives | P1 |
| 2 | Visual Parity Gate | Overall Visual Diff < 10% (Target < 2.5% across 1440/768/390px) with machine-readable JSON logs | P1 |
| 3 | Non-Destructive QA | 100% interactive operability (Hover, Slider, Modal) preserved on clean reload | P1 |
| 4 | Haravan OS 2.0 Readiness | 100% valid Liquid, `settings_schema.json`, inlined SVG, zero syntax errors | P1 |
| 5 | Multi-Dimensional QA | 8-Dimension scorecard passed with zero hard blockers | P2 |

## Architecture Triad & Strict Boundary
```
+---------------------------------------------------------------------------------------------------+
| 1. KERNEL LAYER (src/main/)       | 2. COGNITIVE PACKAGE (packages/site-clone/)| 3. VERIFICATION  |
| - Frozen Chromium CDP primitives  | - 5 Cognitive Understanding Models         | - 8-Dimension QA |
| - Standard VirtualTime / Pause    | - Universal IR: `clone-spec.json`          | - Canvas Masking |
| - General Static File Server      | - Haravan Theme OS 2.0 Compiler            | - Clean Tab Probe|
| - Atomic CDP Viewport Override    | - Storefront E-Commerce Contracts          | - Machine Logs   |
| - Zero clone / theme logic in Core| - Standalone Package & MCP Client          | - Diff Rollback  |
+---------------------------------------------------------------------------------------------------+
```

## Phases Roadmap

| # | Phase | Status | Priority | Dependencies |
|---|-------|--------|----------|--------------|
| 1 | [Phase 1: Kernel Primitive Hardening, Fixture Cleanup & Baseline Telemetry](./phase-01-start.md) | Pending | P1 | None |
| 2 | [Phase 2: The 5-Dimension Cognitive Models & `clone-spec.json` IR](./phase-02-cognitive-models-and-clone-spec-ir.md) | Pending | P1 | Phase 1 |
| 3 | [Phase 3: Haravan Theme OS 2.0 Code Generator](./phase-03-haravan-theme-os-generator.md) | Pending | P1 | Phase 2 |
| 4 | [Phase 4: Multi-Dimensional QA Engine & Clean Tab Protocol](./phase-04-multi-dimensional-qa-and-clean-tab-protocol.md) | Pending | P1 | Phase 3 |
| 5 | [Phase 5: End-to-End Benchmark Soak & Certification](./phase-05-e2e-benchmark-soak-and-certification.md) | Pending | P2 | Phase 4 |

## Success Criteria
- [ ] AntiFan Core (`src/main/`) maintains strictly minimal primitives (`anti.browser.*`, `anti.inspect.*`, `anti.visual.*`) with zero clone-specific code.
- [ ] Destructive timer-clearing fixture removed; manual invocation traced; transient two-phase settle established in `packages/site-clone/`.
- [ ] Machine-readable `reports/clone-benchmark.json` populated with verified multi-viewport iteration runs.
- [ ] `clone-spec.json` schema validated with Storefront State Contracts and Polymorphic DOM definitions.
- [ ] Generated Haravan Theme passes 100% W3C HTML5 and Liquid validation with full Vietnamese font subsetting.
- [ ] Live benchmark on `hoplongtech.vn` achieves Visual Diff < 10% across Desktop, Tablet, and Mobile with verified interactive operability.

<!-- slug: antifan-clone-understanding-and-theme-synthesis-engine -->
