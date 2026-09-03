---
title: "generic-reconstruction-and-mutation-hardening"
description: "Transition AntiFan from benchmark-tuned cloning to autonomous generic reconstruction: data-pipeline wiring into ComponentContractIR, Mutation QA Suite, declarative micro-runtime, and hybrid pattern extraction."
status: pending
priority: P1
effort: "3d"
tags: ["antifan", "clone-engine", "ir-pipeline", "mutation-qa", "micro-runtime", "haravan-theme"]
created: 2026-09-03
---

# AntiFan Generic Reconstruction & Mutation Hardening Engine

## Executive Overview
Following the comprehensive architectural audit of commits `78754f7` through `1411cbd`, this plan transitions AntiFan from an over-fitted, benchmark-tuned cloner into an autonomous, resilient Generic Storefront Reconstruction Engine. 

It systematically dismantles the hardcoded shortcuts introduced to pass initial visual benchmarks (hardcoded widget JS in `StateSynthesizer`, static class vocabularies in `EcommerceDataModeler`, and disconnected cognitive models in `CloneIRBuilder`). In their place, it establishes an end-to-end connected data pipeline into `ComponentContractIR`, builds a safety-first Mutation QA Harness, deploys an event-delegated declarative micro-runtime (`antifan-runtime.js`), and implements hybrid extraction (Heuristic Priors + DOM Repetition + Currency Patterns).

## Cross-Plan Dependency & Lineage
- **Upstream Foundation**: Depends on and builds upon `260902-2202-antifan-clone-understanding-and-theme-synthesis-engine` (which scaffolded `packages/site-clone/`, initial models, and compiler).
- **Core Invariant**: AntiFan Core (`src/main/`) remains strictly frozen. All improvements are contained within `packages/site-clone/`.

## Key Objectives & Metrics
| # | Goal | Target Metric | Priority |
|---|------|---------------|----------|
| 1 | **Clean Tab & Mutation QA Harness** | 100% truthful `restored` state; zero horizontal scrollbar leaks ($\le 2\text{px}$) across 3 mutation scenarios (Text Stretch, Cardinality Shift, Image Ratio) verified in real Chromium. | P1 |
| 2 | **Full Cognitive Model Integration** | `HarvestedAssetManifest` and `ResponsiveBreakpointConfig` wired directly into `ComponentContractIR`; `normalizedData` strictly typed with `NormalizedProduct[]` and `NormalizedCategory[]`. | P1 |
| 3 | **Zero Hardcoded Runtime JS** | 0 hardcoded benchmark selectors in `StateSynthesizer`; 100% interactive widgets driven by universal declarative attributes (`data-antifan-toggle`, `data-antifan-slider`, `data-antifan-modal`) via an event-delegated runtime with focus trapping and multi-slider isolation. | P1 |
| 4 | **Hybrid Pattern Extraction** | Product/Collection detection driven by commercial anchor prerequisite and tunable confidence scoring validated on a labeled fixture corpus (10 positive product items vs 10 negative non-product items like mega-menu/blog) with 0 false positives on non-product elements. | P2 |
| 5 | **Haravan OS 2.0 Theme Integrity** | Generated themes pass 100% Liquid validation, settings schema validation, and run cleanly in the Haravan Visual Theme Editor. | P1 |
## Architecture: The 4-Pillar Pipeline

```
[LIVE WEBPAGE / RAW HTML]
           │
           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. COGNITIVE UNDERSTANDING & HYBRID EXTRACTION                          │
│  - BlueprintExtractor: Structural sections, AST hierarchy & sanitization│
│  - AssetHarvester: Stylesheets, scripts, remote images & font subsets   │
│  - ResponsiveScanner: Multi-viewport breakpoint formulas                │
│  - EcommerceDataModeler: Hybrid detection (Priors + Repetition + Price) │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. CANONICAL INTERMEDIATE REPRESENTATION (ComponentContractIR v1.1.0)   │
│  - metadata, layout (maxWidth, padding, breakpoints)                    │
│  - assets: HarvestedAssetManifest                                       │
│  - responsive: ResponsiveBreakpointConfig                               │
│  - sections: ComponentSectionContract[] (Liquid templates, blocks)      │
│  - storefrontRuntime: controllers[] (carousel, toggle, modal, dropdown) │
│  - normalizedData: NormalizedStorefrontData (typed products/categories) │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. HARAVAN THEME OS 2.0 COMPILER & DECLARATIVE RUNTIME                  │
│  - HaravanSectionGenerator: Injects `data-antifan-*` attributes         │
│  - HaravanLayoutGenerator: Links `theme.js` with `defer`                │
│  - StateSynthesizer: Generates universal `antifan-runtime.js` (<80 lines)│
│  - Atomic Staging & Validation before swap                              │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. TWO-TIER VALIDATION: 8-DIMENSION QA + MUTATION QA HARNESS            │
│  - CleanTabProtocol: Fixed reversible state (truthful `restored` flag)  │
│  - Mutation Tests: 200-char Text, 1/11 Items, 1:3 & 3:1 Image Ratios    │
│  - Hard Blockers: Horizontal overflow, NaN prices, broken forms, Liquid │
└─────────────────────────────────────────────────────────────────────────┘
```

## Phases Roadmap

| # | Phase | Status | Priority | Effort | Dependencies |
|---|-------|--------|----------|--------|--------------|
| 1 | [Phase 1: Integrity Fixes & Mutation QA Safety Harness](./phase-01-start.md) | Pending | P1 | 0.5d | None |
| 2 | [Phase 2: Cognitive Models & IR Data Pipeline Wiring](./phase-02-cognitive-models-and-ir-data-pipeline.md) | Pending | P1 | 0.75d | Phase 1 |
| 3 | [Phase 3: Declarative Micro-Runtime & Compiler Code Generation](./phase-03-declarative-micro-runtime-and-compiler-codegen.md) | Pending | P1 | 0.75d | Phase 2 |
| 4 | [Phase 4: Hybrid Extraction Intelligence & End-to-End Verification](./phase-04-hybrid-extraction-and-e2e-verification.md) | Pending | P2 | 1d | Phase 3 |

## Success Criteria
- [ ] `CleanTabProtocol.withReversibleState` accurately reports actual restoration outcome; unit tests verify both success and failure rollback paths.
- [ ] `MutationQAHarness` passes 3 mutation test scenarios (Text Stretch, Cardinality Shift, Image Ratio Distortion) with zero layout overflow ($\le 2\text{px}$).
- [ ] `ComponentContractIR` contains first-class `assets` and `responsive` fields and strictly typed `normalizedData`.
- [ ] Zero benchmark-specific selectors (`.slide-content__detail`, `.category-navigation__list`, YouTube URL `Nt2J6ZXPuw0`) in `StateSynthesizer` or `ThemeCompiler`.
- [ ] All 26 existing tests + new mutation tests pass with 0 errors (`npm test`).
- [ ] Generated Haravan Theme packages compile cleanly, load `antifan-runtime.js`, and maintain full interactive operability.

<!-- slug: generic-reconstruction-and-mutation-hardening -->
