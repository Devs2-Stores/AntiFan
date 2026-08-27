---
phase: "03"
title: "HS1-HS26 Rules & ThemeQaWorkflow Integration"
status: pending
priority: P1
effort: "4h"
dependencies: ["01", "02"]
---

# Phase 03: HS1-HS26 Rules & ThemeQaWorkflow Integration

## Overview
Implement the HS1–HS26 theme review gate matrix and integrate all static and runtime scanners into `ThemeQaWorkflow`. The workflow will execute a complete verification pass on any theme workspace and active browser target, producing a unified `ThemeQaReport` with checklist booleans, detailed findings, and staged visual artifacts.

## Requirements
- **HS1–HS26 Gate Rules Engine (`src/main/qa/rules/hs-gate-rules.ts`)**:
  - **HS-01 (AJAX Cart Variant)**: Verify cart add form sends valid `variantId` (Sapo) or `id` (Haravan/Shopify).
  - **HS-02 (Contact Form Endpoint)**: Check contact forms submit to `/postcontact` (Sapo) or `/contact` (Haravan/Shopify) with `[name="contact[email]"]`.
  - **HS-03 (Blog Comments Casing)**: Check comment form inputs use uppercase `Author`, `Email`, `Body` on Sapo platforms.
  - **HS-04 (Customer Address Deletion)**: Check customer address deletion buttons hook valid handlers without throwing `deleteAddress is not defined`.
  - **HS-05 (Image CDN Protocol)**: Check featured images use absolute CDN URLs (`hstatic.net` or `bizweb.dktcdn.net`) instead of relative assets.
  - **HS-06 (noPS & Performance Guard)**: Verify analytics/heavy scripts are properly guarded with `noPS` or `StartOptimize` triggers.
- **Enriched `ThemeQaWorkflow.validate()`**:
  - Run `PlatformDetector` to scope applicable rules.
  - Execute Layer 1 Static Preflight (file structure, naming, schema syntax).
  - Execute Layer 2 Runtime Storefront Passes (Liquid errors, broken assets, layout overflow, HS live checks).
  - Aggregate findings and stage an immutable JSON report + annotated screenshot evidence in `ArtifactStore`.

## Architecture & Data Schema
```text
ThemeQaWorkflow.validate(input)
              │
              ▼
    1. Platform Detection (Haravan / Sapo / Shopify)
              │
              ▼
    2. Static Workspace Preflight
       - Schema JSON validation
       - Naming and template conventions
              │
              ▼
    3. Runtime Storefront Inspection (Active BrowserTarget)
       - Zero-Liquid error sweep
       - Multi-breakpoint overflow analysis (393px, 820px, 1440px)
       - Broken asset telemetry
       - HS1-HS26 live form & AJAX cart contract verification
              │
              ▼
    4. Compile ThemeQaReport
       {
         runId, attemptId, workspaceId, target,
         platform: 'haravan' | 'sapo' | 'shopify',
         summary: { passed: boolean, totalIssues: number, criticalCount: number },
         checklist: { layout: boolean, responsive: boolean, overflow: boolean, liquidClean: boolean, assetsValid: boolean, hsCompliant: boolean },
         findings: Array<{ code: string, severity: 'critical' | 'high' | 'medium' | 'low', message: string, selector?: string, line?: number }>,
         artifacts: ArtifactRef[],
         createdAt: number
       }
              │
              ▼
    5. Stage in ArtifactStore (`reports/theme-qa-report-{runId}.json`)
```

## Related Code Files
- Create:
  - `src/main/qa/rules/hs-gate-rules.ts`
- Modify:
  - `src/main/qa/theme-qa-workflow.ts`
- Tests:
  - `test/main/hs-gate-rules.test.ts`
  - `test/integration/theme-qa-vertical-slice.test.ts`

## Implementation Steps
1. Create `src/main/qa/rules/hs-gate-rules.ts` implementing the rule evaluators with platform-scoping filters.
2. Refactor `ThemeQaWorkflow` in `src/main/qa/theme-qa-workflow.ts` to orchestrate `PlatformDetector`, `LiquidErrorScanner`, `LayoutOverflowEngine`, `BrokenAssetScanner`, and `HsGateRules`.
3. Update `ThemeQaReport` interface with full e-commerce theme verification fields.
4. Update integration tests in `test/integration/theme-qa-vertical-slice.test.ts` to verify end-to-end report generation.

## Success Criteria
- [ ] `ThemeQaWorkflow.validate()` completes full scan in $< 2.0\text{s}$.
- [ ] Correctly identifies all simulated Liquid errors and layout overflows.
- [ ] Sapo HS rules do not execute when platform is detected as Haravan or Shopify.
- [ ] Generates an authoritative JSON artifact in `ArtifactStore`.

## Risk Assessment
- **Risk:** Slow network responses on external CDN assets causing scan timeouts.
- **Mitigation:** Impose a strict $5000\text{ms}$ overall timeout per inspection pass, logging unresolvable assets as warnings without crashing the workflow.
