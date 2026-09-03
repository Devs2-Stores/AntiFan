---
title: "AntiFan Core Boundary Neutralization, Semantic Aliasing & Sapo Canary Probe"
description: "Implementation plan to neutralize core browser tools, establish clean internal model boundaries, introduce neutral semantic aliases in ComponentContractIR, decouple state models from runtime codegen, and execute the 5-case Sapo Canary boundary-breaker probe."
status: completed
priority: P1
effort: "4h"
tags: ["core", "neutralization", "semantic-ir", "sapo-canary", "freeze-doctrine"]
created: 2026-09-03
---

# AntiFan Core Boundary Neutralization, Semantic Aliasing & Sapo Canary Probe

## Executive Summary
Following the sealed architecture doctrine (`plans/reports/260903-core-architecture-critique-and-kongming-doctrine.md`), this plan executes the immediate, high-ROI architectural actions required to solidify AntiFan as a universal Web/UI Understanding Runtime while strictly avoiding premature generalization:
1. Neutralize platform-specific selectors (`shopify-section-`, `haravan-section-`) and commerce endpoints (`/products/*.js`) in `src/main/tools/browser-capabilities.ts`.
2. Enforce clean internal boundaries in `packages/site-clone`: guarantee models contain 0% Liquid/Platform schema and add backward-compatible neutral semantic aliases (`components`, `slots`, `ComponentNodeContract`) to `ComponentContractIR`.
3. Decouple abstract interaction and state transition models from storefront runtime JS code generation in `state-synthesizer.ts`.
4. Implement the **5-Case Sapo Canary Probe** (`scripts/probes/sapo-boundary-probe.ts`) to prove boundary resilience against platform lock-in without building out an entire Sapo compiler.
5. Verify 100% test coverage (all 72 unit tests, smoke mutation QA, and live Electron runtime) with zero regressions.

## Architecture & Data Flow

```text
[ Live Storefront / Web Page ]
              │
              ▼
[ Core Browser Tools (Neutralized) ]
  ├── PlatformDetector.detectFromRuntime (URL / DOM Indicators)
  ├── Generic DOM Landmarks (header, nav, main, section, footer)
  └── Schema.org / Microdata / Meta Product Resolver
              │
              ▼
[ Core-Capable Models (0% Liquid / 0% Platform Schema) ]
  ├── DomTreeParser (AST Token Parser)
  ├── AssetHarvester (Fonts, Media, CSS, Scripts)
  ├── ResponsiveScanner (Viewports & Layout Queries)
  ├── EcommerceDataModeler (Hybrid Confidence Entity Resolution)
  └── StateModeler (Abstract Trigger -> State Delta -> Effect Model)
              │
              ▼
[ Semantic Information Contract (ComponentContractIR v1.2.0) ]
  ├── Canonical: sections / blocks / schemaSettings (Backward compatible)
  └── Neutral Aliases: components / slots / componentId / stateTransitions
              │
              ├───────────────────────────────────┐
              ▼                                   ▼
[ Haravan OS 2.0 Adapter ]            [ Sapo Canary Probe (5 Cases) ]
  ├── ThemeCompiler                     └── scripts/probes/sapo-boundary-probe.ts
  ├── HaravanSectionGenerator                 ├── Case 1: Complex Layout
  ├── HaravanLayoutGenerator                  ├── Case 2: Deep Hierarchy
  └── Declarative Micro-Runtime               ├── Case 3: Data Diversity
                                              ├── Case 4: Stateful Modal
                                              └── Case 5: Flat BWT Output
```

## Phases

| # | Phase | Priority | Effort | Status | Description |
|---|---|---|---|---|---|
| 1 | [Phase 1: Core Browser Tool Neutralization](./phase-01-start.md) | P1 | 45m | Completed | Remove hardcoded platform strings from browser capabilities; delegate to PlatformDetector |
| 2 | [Phase 2: Internal Boundary & Semantic Aliasing](./phase-02-internal-boundary-and-semantic-aliasing.md) | P1 | 45m | Completed | Enforce 0% Liquid rule in models; add neutral aliases (`components`, `slots`) to ComponentContractIR |
| 3 | [Phase 3: State Model & Codegen Decoupling](./phase-03-state-model-and-codegen-decoupling.md) | P2 | 45m | Completed | Separate pure StateTransitionModel from declarative micro-runtime JS generation |
| 4 | [Phase 4: Sapo Boundary-Breaker Canary Probe](./phase-04-sapo-boundary-breaker-canary-probe.md) | P1 | 1h | Completed | Build and execute the isolated 5-case Sapo canary probe script to verify zero lock-in |
| 5 | [Phase 5: Regression & Benchmark Verification](./phase-05-regression-and-benchmark-verification.md) | P1 | 45m | Completed | Run unit tests, typechecks, mutation QA harness, and live Electron validation |

## Success Criteria
- [X] `src/main/tools/browser-capabilities.ts` contains 0 hardcoded platform-specific selectors or endpoints in default resolution paths.
- [X] `packages/site-clone/src/models/` contains 0 Liquid keywords or platform-specific schemas.
- [X] `ComponentContractIR` exposes `components` and `slots` aliases matching `sections` and `blocks` with 100% backward compatibility.
- [X] `StateSynthesizer` cleanly exposes `StateTransitionModel` separately from `generateDeclarativeRuntime()`.
- [X] `scripts/probes/sapo-boundary-probe.ts` passes all 5 orthogonal test cases without failing or requiring Shopify-specific structures.
- [X] All 72 existing unit tests pass with zero regressions (`npm run test:site-clone` & `npm run test:unit`).
- [X] `npx electron scripts/smoke-mutation-qa.cjs` passes live browser validation across Desktop, Tablet, and Mobile.
