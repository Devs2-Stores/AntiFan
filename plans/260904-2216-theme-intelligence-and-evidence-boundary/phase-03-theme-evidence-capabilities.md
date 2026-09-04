---
phase: 3
title: "Theme Evidence Capabilities"
status: completed
priority: P1
effort: "8h"
dependencies: ["phase-01-start.md", "phase-02-context-and-proving-harness.md"]
---

# Phase 3: Theme Evidence Capabilities

## Overview
Implement and register the three core Theme Intelligence capabilities in `src/main/tools/browser-capabilities.ts` and `capability-catalogue.ts`. These capabilities transform raw browser telemetry into structured, evidence-backed payloads for OMP without taking over OMP's reasoning or code editing role.

## Requirements
- **Functional Requirements:**
  1. **`anti.theme.resolve_element` (Source Mapping v1):**
     - Map rendered DOM element (via `@ref` or selector) to candidate Liquid template/snippet files.
     - Extract source hints from DOM (section IDs, template comments, BEM classes).
     - Search workspace files via ripgrep for matching identifiers, class names, and `{% render ... %}` calls.
     - Structure output with Tri-State evidence:
       - `markupClassMatch`: boolean
       - `renderCallMatch`: `true` | `false` | `'unknown'`
       - `referencedBySection`: `true` | `false` | `'unknown'`
     - Enforce confidence rules: `HIGH` strictly requires $\ge 2$ independent evidence signals (e.g., class match + render call match).
  2. **`anti.inspect.matched_styles` (Theme-aware CSS Evidence):**
     - Query CDP matched rules via Phase 1 primitive `getMatchedStylesForNode`.
     - Parse cascade hierarchy to separate `ACTIVE` rules from `OVERRIDDEN` rules.
     - Calculate CSS specificity $(a, b, c)$ for matching selectors.
     - Resolve CSS custom properties (`--var-name`).
     - Tiered DoD:
       - `PASS`: Returns selector, declaration, and `styleSheetId`.
       - `STRONG PASS`: Resolves `styleSheetId` to stylesheet URL/path + line and column numbers.
       - `PARTIAL`: Returns rule without resolved stylesheet URL.
  3. **`anti.inspect.responsive_matrix` (5-Breakpoint Layout Matrix):**
     - Emulate 5 standard breakpoints in a single probe: $320, 375, 768, 1024, 1440\text{px}$.
     - For each breakpoint, measure element geometry ($x, y, w, h$), visibility (`display`, `visibility`), and overflow.
     - Disambiguate overflow metrics:
       - `documentOverflowX`: `document.documentElement.scrollWidth > window.innerWidth`
       - `targetOverflowX`: `targetRect.right > containerRect.right + 1 || targetRect.scrollWidth > targetRect.clientWidth`
- **Non-Functional Requirements:**
  - Wrap all results in standard `ThemeEvidenceEnvelope<T>` containing `evidenceQuality`, `provenance`, and `timestamp`.
  - Fail-closed: Return `{ status: 'INCONCLUSIVE', reason: '...' }` when telemetry cannot be gathered.

## Architecture
```text
OMP Skill Request
        v
Capability Catalogue -> browser-capabilities
  + anti.theme.resolve_element
  + anti.inspect.matched_styles
  + anti.inspect.responsive_matrix
        v
NativeTabHost / TabDevToolsHost / Workspace Ripgrep
        v
ThemeEvidenceEnvelope
  - data: Source Candidates / Matched CSS / Breakpoint Matrix
  - evidenceQuality: HIGH | MEDIUM | LOW
  - triStateSignals: { markupClassMatch, renderCallMatch, ... }
```

## Related Code Files
- Create: `src/main/tools/theme-evidence-envelope.ts` (Envelope contract and helpers)
- Create: `src/main/browser/theme-source-mapper.ts` (Ripgrep + source hint correlation)
- Create: `src/main/browser/css-cascade-analyzer.ts` (CDP matched styles to active/overridden rules)
- Modify: `src/main/browser/native-tab-host.ts` (upgrade `runResponsiveCheck` to 5 breakpoints + disambiguation)
- Modify: `src/main/tools/browser-capabilities.ts` (register the 3 new capabilities)
- Create: `test/theme-evidence-capabilities.test.ts` (unit tests against fixture)

## Implementation Steps
1. **Define `ThemeEvidenceEnvelope`:**
   - Create generic envelope schema:
     ```typescript
     export interface ThemeEvidenceEnvelope<T> {
       success: boolean;
       data?: T;
       evidenceQuality: 'HIGH' | 'MEDIUM' | 'LOW';
       signals: Record<string, boolean | 'unknown'>;
       timestamp: number;
       error?: string;
     }
     ```
2. **Implement `ThemeSourceMapper` (`anti.theme.resolve_element`):**
   - Extract class names and attributes from element via DOM snapshot or evaluate.
   - Run scoped ripgrep across workspace root (`*.liquid`, `*.json`).
   - Correlate results: match classes, render calls, and section includes.
   - Compute confidence: assign `HIGH` only when $\ge 2$ independent signals match.
3. **Implement `CssCascadeAnalyzer` (`anti.inspect.matched_styles`):**
   - Call `getMatchedStylesForNode` for the target node.
   - Iterate through `matchedCSSRules`.
   - Track declared properties: later rules in cascade win unless overridden by `!important`.
   - Map `styleSheetId` to stylesheet URL using `CSS.getStyleSheetHeader`.
   - Format output into `ACTIVE`, `OVERRIDDEN`, and `VARIABLES` groups.
4. **Upgrade `runResponsiveCheck` (`anti.inspect.responsive_matrix`):**
   - Expand `runResponsiveCheck` in `native-tab-host.ts` to loop over the 5 breakpoints ($320, 375, 768, 1024, 1440$).
   - Execute client script measuring:
     ```javascript
     const docOverflow = document.documentElement.scrollWidth > window.innerWidth;
     const targetOverflow = target ? (target.getBoundingClientRect().right > container.getBoundingClientRect().right + 1) : false;
     ```
   - Collect and return breakpoint records.
5. **Register Capabilities in `browser-capabilities.ts`:**
   - Define zod/JSON schemas and handlers for `anti.theme.resolve_element`, `anti.inspect.matched_styles`, and `anti.inspect.responsive_matrix`.

## Success Criteria
- [x] `anti.theme.resolve_element` correctly identifies `snippets/card-product.liquid` in the fixture with `HIGH` confidence.
- [x] `anti.inspect.matched_styles` separates `.product-card` properties from overridden `.card` properties with `styleSheetId`.
- [x] `anti.inspect.responsive_matrix` detects `documentOverflowX` and `targetOverflowX` across all 5 breakpoints on the fixture.

## Risk Assessment
- *Risk:* Ripgrep binary is missing or incompatible in user environment.
  *Mitigation:* Use node-based file scanning or VS Code/Ripgrep bundled binaries with graceful fallback to standard text search.
