---
title: "theme-intelligence-and-evidence-boundary"
description: "Implementation plan for AntiFan Theme Intelligence, Viewport Emulation Fix, CDP Matched Styles, and Evidence Boundary"
status: completed
priority: P1
effort: "3d"
tags: ["theme-intelligence", "control-plane", "cdp", "responsive-matrix", "source-mapping", "fable-blueprint"]
created: 2026-09-04
---

# Theme Intelligence & Evidence Boundary Implementation Plan

## Overview
Transform AntiFan into a specialized **Theme Engineering Control Plane** for OMP by establishing a deterministic **Theme Evidence Boundary** (Source Mapping v1, Theme-aware CSS Causality, Multi-viewport Responsive Matrix) while strictly isolating core observation and execution from agent reasoning. Validated through a lightweight **Product Card Proving Harness** before any generalization to complex components (Header/Mega Menu).

## Architectural Invariants (Non-Negotiable)
1. **AntiFan never decides what code should be edited.** (AntiFan observes, executes, and proves; OMP reasons, selects solutions, and edits code).
2. **AntiFan never claims VERIFIED without sufficient evidence.** (Missing evidence yields `INCONCLUSIVE`, failing evidence yields `REJECTED`, only complete conforming proof yields `VERIFIED`).
3. **Product-specific logic never enters Core runtime.** (Core `src/main/` remains strictly generic; all Product Card selectors, fixtures, and workflows live in `test/fixtures/golden-workflow/`).

## Goals

| # | Goal | Priority | Success Measure |
|---|------|----------|-----------------|
| 1 | Fix Viewport Emulation Correctness | P1 | Custom dimensions in `setViewportSize` properly activate Chromium device emulation instead of falling into fluid desktop bounds. |
| 2 | Expose CDP Matched Styles Gateway | P1 | `TabDevToolsHost` and `BrowserHostPort` expose `getMatchedStylesForNode` returning raw matched rules with stylesheet IDs. |
| 3 | Deliver Theme Evidence Capabilities | P1 | Implement `anti.theme.resolve_element`, `anti.inspect.matched_styles`, and `anti.inspect.responsive_matrix` returning standardized `ThemeEvidenceEnvelope`. |
| 4 | Integrate Verification Evaluator | P1 | Map theme obligations into existing 5-verdict fail-closed `VerificationEvaluator` without creating new verdict engines. |
| 5 | Pass Architecture Gate on Product Card | P1 | Prove E2E flow on proving harness: candidate source identified before edit, CSS causality verified, 5 breakpoints checked without blind full-repo grep. |

## Phases

| # | Phase | Priority | Status | Description |
|---|-------|----------|--------|-------------|
| 1 | [Phase 1: Core Corrections & CDP Primitives](./phase-01-start.md) | P1 | Completed | Fix `setViewportSize` dynamic emulation bug and expose `getMatchedStylesForNode` through `TabDevToolsHost` and `BrowserHostPort`. |
| 2 | [Phase 2: Context Lineage & Proving Harness](./phase-02-context-and-proving-harness.md) | P1 | Completed | Define minimal `ThemeTaskContext` skeleton and scaffold isolated Product Card testbed fixture outside Core. |
| 3 | [Phase 3: Theme Evidence Capabilities](./phase-03-theme-evidence-capabilities.md) | P1 | Completed | Implement and register `anti.theme.resolve_element`, `anti.inspect.matched_styles`, and `anti.inspect.responsive_matrix`. |
| 4 | [Phase 4: Verification Integration & Policy Ordering](./phase-04-verification-and-policy-integration.md) | P1 | Completed | Wire Theme Evidence into existing `VerificationEvaluator` and configure OMP Preferred Capability Ordering in Theme Skill. |
| 5 | [Phase 5: E2E Slice & Architecture Gate](./phase-05-e2e-slice-and-architecture-gate.md) | P1 | Completed | Execute the complete proving workflow on Product Card harness and evaluate the 5 Architecture Gate criteria. |

## Success Criteria

- [X] `browser.set-viewport({ width: 375, height: 667, mobile: true })` activates mobile touch and viewport emulation.
- [X] `TabDevToolsHost.getMatchedStylesForNode` returns CDP matched rules for any valid node ref or selector.
- [X] `anti.theme.resolve_element` returns candidate Liquid files with tri-state evidence and requires $\ge 2$ independent signals for `HIGH` confidence.
- [X] `anti.inspect.matched_styles` categorizes active vs overridden declarations with Tiered DoD (PASS vs STRONG PASS).
- [X] `anti.inspect.responsive_matrix` evaluates 5 standard breakpoints ($320, 375, 768, 1024, 1440$) and disambiguates `documentOverflowX` from `targetOverflowX`.
- [X] Verification engine strictly enforces fail-closed evaluations without adding synthetic verdict states.
- [X] Product Card proving harness passes all 5 Architecture Gate criteria with zero product-specific code in Core runtime.

<!-- slug: theme-intelligence-and-evidence-boundary -->
