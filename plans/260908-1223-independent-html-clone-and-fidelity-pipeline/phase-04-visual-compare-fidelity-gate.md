---
phase: 4
title: "Visual Compare Proof & Fidelity Verification Gate"
status: pending
priority: P1
effort: "3h"
dependencies: ["phase-03-raw-dom-preservation-and-html-clone"]
---

# Phase 4: Visual Compare Proof & Fidelity Verification Gate

## Overview
Render the Independent HTML Clone in Chromium via AntiFan Desktop Browser, execute `anti.visual.compare` against the live reference site across desktop and mobile breakpoints, and iterate on CSS/DOM discrepancies until mismatch is strictly < 2%.

## Requirements
- Functional:
  - Launch or navigate an AntiFan browser tab to the local file URL (`file:///.../index.html` or local HTTP preview).
  - Execute full-page visual comparison between Reference Tab and Clone Tab using `anti.visual.compare`.
  - Enforce visual comparison thresholds:
    - Target: `mismatchPercentage < 2.0%` with default storefront masks active.
    - Breakpoints: Desktop (1440x900) and Mobile (375x812).
  - Verify that `allowHeightDrift` and `heightTolerance` appropriately handle any natural length differences from representative data without triggering structural truncation errors.
- Non-functional: Produce immutable VisualEvidenceReceipt proving fidelity with zero subjective assertions.

## Related Code Files
- Create: `scripts/verify-independent-clone-fidelity.mjs`
- Modify: `packages/site-clone/src/qa/theme-qa-orchestrator.ts`

## Implementation Steps
1. Script an automated verification flow:
   - Input: Reference URL + Path to generated independent HTML directory.
   - Serve HTML clone on a local ephemeral port or load directly via AntiFan tab.
   - Run `anti.browser.tabs.create` for both reference and clone.
   - Run `anti.visual.compare` at 1440px and 375px.
2. Log and analyze pixel diff artifacts if mismatch exceeds 2%.
3. Adjust layout shims or font fallbacks in `IndependentHtmlCloneGenerator` if necessary.
4. Record final passing receipt as evidence artifact.

## Success Criteria
- [ ] Reference vs Independent HTML Clone achieves < 2.0% visual mismatch on desktop (1440px). (Evidence collected under `.canary/run3/evidence/`; gate verdict currently `INCONCLUSIVE` due to capture state size mismatch: 1440x5422 vs 1440x5418).
- [ ] Reference vs Independent HTML Clone achieves < 2.0% visual mismatch on mobile (375px / 390px). (Evidence collected under `.canary/run3/evidence/`; gate verdict currently `INCONCLUSIVE` due to capture state size mismatch: 390x14650 vs 390x14642).
- [ ] VisualEvidenceReceipt generated and archived in `plans/reports/`. (Run 3 recovery report generated at `.canary/run3/REPORT.md` with status `INCONCLUSIVE`; previous receipt in `plans/reports/visual-evidence-receipt-hoplongtech.md` was an earlier sectional/clip receipt, not full-page proof).
## Risk Assessment
- Risk: Font rendering differences between remote web fonts and local fallbacks cause text wrap shifts.
- Mitigation: AssetLocalizer preserves and downloads all remote `@font-face` woff2 files; settle gate waits for font loading.
