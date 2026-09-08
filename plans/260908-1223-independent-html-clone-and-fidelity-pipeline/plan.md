---
title: "Independent HTML Clone & Visual Fidelity Pipeline"
description: "End-to-end transformation from Reference Storefront to 100% Independent Localized HTML Clone, <2% Visual Compare Proof on Chromium, and High-Fidelity Liquid Lowering."
status: pending
priority: P1
effort: "16h"
tags: ["core", "visual-compare", "site-clone", "asset-pipeline", "haravan-theme"]
created: 2026-09-08
---

# Independent HTML Clone & Visual Fidelity Pipeline

## Overview
This plan executes the definitive architectural pivot for AntiFan: transitioning from a lossy `Reference -> Archetype -> Liquid` pipeline to an evidence-backed `Reference -> Asset Localization -> Independent HTML Clone -> Visual Compare (<2%) -> Liquid Lowering` pipeline.

Core runtime acts as the immutable, authoritative "Judge" (with re-locked mask ledgers and verified height drift parameters), while the new pipeline ensures 100% zero-hotlink asset independence and authentic live DOM fidelity before any Liquid code is emitted.

## Goals

| # | Goal | Priority |
|---|------|----------|
| 1 | Re-lock Core Test Contract: exact mask counts, no iframe[id] leak, dedicated tests for heightTolerance & allowHeightDrift | P1 |
| 2 | Wire AssetLocalizer directly into ThemeCompiler: 100% local assets, zero external origin hotlinks | P1 |
| 3 | Build Independent HTML Clone Generator: preserve raw live DOM nesting/styles, representative data sampling (12 products / 6 articles) | P1 |
| 4 | Prove Visual Fidelity: run `anti.visual.compare` between Reference and HTML Clone to reach < 2.0% diff on Chromium | P1 |
| 5 | Liquid Lowering & Haravan Theme Export: mechanically lower certified HTML to Haravan Liquid sections/schemas | P1 |

## Phases

| # | Phase | Status | Effort | Dependencies |
|---|-------|--------|--------|--------------|
| 1 | [Phase 1: Core Test Contract Hardening & Height Drift Assertion](./phase-01-core-test-hardening.md) | Pending | 2h | None |
| 2 | [Phase 2: Asset Pipeline Integration: Harvester to Localizer to Compiler](./phase-02-asset-pipeline-integration.md) | Pending | 4h | Phase 1 |
| 3 | [Phase 3: Raw DOM Preservation & Independent HTML Clone Generator](./phase-03-raw-dom-preservation-and-html-clone.md) | Pending | 4h | Phase 2 |
| 4 | [Phase 4: Visual Compare Proof & Fidelity Verification Gate](./phase-04-visual-compare-fidelity-gate.md) | Pending | 3h | Phase 3 |
| 5 | [Phase 5: Liquid Lowering & Haravan Theme Export](./phase-05-liquid-lowering-and-haravan-export.md) | Pending | 3h | Phase 4 |

## Architecture & Data Flow

```mermaid
flowchart TD
    subgraph Phase1[Phase 1: Core Test Hardening]
        M1[Export defaultStorefrontWidgets] --> M2[Tighten V-11 Exact Counts & Ledger]
        M2 --> M3[Parameterize Mock PNG Heights]
        M3 --> M4[Add 3 Tests for heightTolerance & allowHeightDrift]
    end

    subgraph Phase2[Phase 2: Asset Pipeline Integration]
        A1[AssetHarvester: Discover URLs] --> A2[AssetLocalizer: SSRF/IP-Pinned Download]
        A2 --> A3[Content-Addressed Storage & CSS Rewrite]
        A3 --> A4[ThemeCompiler Asset Integration: 0 Hotlinks]
    end

    subgraph Phase3[Phase 3: Independent HTML Clone]
        D1[Capture Live DOM: Retain rawHtml] --> D2[Apply Representative Data: 12 prod / 6 art]
        D2 --> D3[Assemble Standalone index.html Bundle]
    end

    subgraph Phase4[Phase 4: Visual Compare Gate]
        V1[Render Reference & Clone in Chromium] --> V2[Run anti.visual.compare 1440px & 375px]
        V2 --> V3{Mismatch < 2.0%?}
        V3 -->|No| V4[Refine CSS/Layout Shims]
        V4 --> V1
        V3 -->|Yes| V5[Emit VisualEvidenceReceipt]
    end

    subgraph Phase5[Phase 5: Liquid Lowering]
        L1[Certified HTML DOM] --> L2[Inject Haravan Liquid Loops & Tags]
        L2 --> L3[Generate Sections, Schemas & Theme Files]
        L3 --> L4[Run theme.qa_validate]
    end

    Phase1 --> Phase2
    Phase2 --> Phase3
    Phase3 --> Phase4
    Phase4 --> Phase5
```

## Success Criteria

- [ ] All 53+ tests pass in `test/main/visual-compare-mask-ledger.test.ts` with exact assertions and dedicated tests for height controls.
- [ ] Compiled theme output contains 0 external origin asset hotlinks.
- [ ] Independent HTML Clone renders completely offline and achieves < 2.0% visual mismatch on desktop and mobile.
- [ ] Haravan theme compiles cleanly and passes all `theme.qa_validate` platform checks.

<!-- slug: independent-html-clone-and-fidelity-pipeline -->
