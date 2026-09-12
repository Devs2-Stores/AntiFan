# Phase 04 — Platform-Shape Remediation (Detector, Source Mapper)
Status: BLOCKED_ON_PREDECESSOR
Depends on: 00

## Context

Defects D4 and D8 address platform shape assumptions in AntiFan's static analysis and source mapping modules:

1. **Defect D4 (`src/main/qa/scanners/platform-detector.ts:78–88`)**: The workspace detector awards `haravanScore += 10` when `sections/*.liquid` files exist, justified by an incorrect comment at L84 (`// Both Shopify and Haravan use .liquid sections`). In production Haravan themes (observed 30/30 in the `E:\Work\customizes` corpus), standard storefront architecture uses flat `templates/*.liquid` and `snippets/*.liquid` without `sections/`. Liquid sections are a Shopify convention.
2. **Defect D8 (`src/main/browser/theme-source-mapper.ts:222–267,346,386`)**: The source mapper supports sections, snippets, layouts, templates, and both `render` and `include` directives. Per `plan.md` authority, this is **not an inherent bug** in a multi-platform runtime that supports Shopify and Sapo alongside Haravan. Remediation requires scoping Haravan policy checks so Haravan themes do not falsely require or prioritize Shopify-style section lineage, while strictly preserving shared Shopify and Sapo mapper capabilities.

**Architectural Separation of Concerns**:
- **Platform Detection**: Identifies whether a workspace belongs to Haravan, Sapo, or Shopify. An existing Haravan workspace that contains stray sections remains a Haravan workspace if primary Haravan markers (such as `config/settings.html`, Haravan scripts, or CDN URLs) are present. Stray files do not erase platform identity.
- **Theme Output Compliance**: Enforced by Phase 05/06 and theme QA gates, verifying that Haravan-generated base themes adhere strictly to the approved Haravan layout contract (flat `templates/*.liquid`, `layout/theme.liquid`, `snippets/`, and `config/settings.html`).

---

## Requirements

1. **Platform Detector (`src/main/qa/scanners/platform-detector.ts`)**:
   - **R4.1 (Remove False Haravan Scoring & Comment)**: Remove the comment at L84 (`Both Shopify and Haravan use .liquid sections`) and stop awarding `haravanScore += 10` for `sections/*.liquid`. Retain `shopifyScore += 10`.
   - **R4.2 (Keep Generic Liquid Neutral)**: Flat `.liquid` templates are shared by platforms; do not add Haravan-specific points for them. Preserve existing evidence precedence and test ambiguous/mixed workspaces without forcing an identity.
   - **R4.3 (Preserve Multi-Platform Detection)**: Maintain existing detection logic for Sapo (`.bwt` in snippets/templates/sections) and Shopify (`sections/*.liquid`, CLI commands, and CDN markers). Do not force platform identity solely from schema absence or presence.
   - **R4.4 (Preserve `settings.html` Evidence)**: Maintain `haravanScore += 60` for `config/settings.html` at L51–55.

2. **Theme Source Mapper (`src/main/browser/theme-source-mapper.ts`)**:
   - **R4.5 (Preserve Shared Types)**: Retain `'section'` in `CandidateTemplate['type']` (L43) and `'section_lineage'` in `SourceEvidenceKind` (L28) to preserve shared Shopify and Sapo mapping.
   - **R4.6 (Include-Edge Verification)**: Ensure include-edge extraction (L341–355) continues to index both `{% render %}` and `{% include %}` directives (L346) and resolves targets to `snippets/`.
   - **R4.7 (Scope Haravan Policy Checks)**: Ensure that for Haravan themes, snippet candidate correlation does not require section parentage. Template-to-snippet and layout-to-snippet `render_edge` relationships provide valid lineage evidence without requiring `sections/`.

3. **Regression Proof**:
   - **R4.8 (Corpus Theme Detection)**: An authentic Haravan theme with `config/settings.html`, flat `templates/*.liquid`, and `layout/theme.liquid` classifies as `result.platform === 'haravan'`.
   - **R4.9 (Shared Platform Integrity)**: Sapo and Shopify test fixtures continue to detect correctly without regression.

---

## Files

| Path | Action | Why |
|---|---|---|
| `src/main/qa/scanners/platform-detector.ts` | edit | Remove unsupported Haravan credit for sections; preserve shared detection and keep generic Liquid neutral. |
| `src/main/browser/theme-source-mapper.ts` | edit | Scope Haravan policy checks to ensure template/layout snippet inclusion provides full lineage correlation without requiring section parentage, while preserving shared Shopify/Sapo section mapping. |
| `test/main/platform-detector.test.ts` | edit | Consumer-visible classification regressions for Haravan, Shopify legacy/OS2, Sapo and ambiguous workspaces. |
| `test/unit/theme-evidence-capabilities.test.ts` | edit | Verify that theme source mapping continues to support multi-platform workflows without regression. |

---

## Steps

### 1. Remediate Platform Detector (`src/main/qa/scanners/platform-detector.ts`)

1. **Inspect Lines 40–90**: Read L40–90 of `src/main/qa/scanners/platform-detector.ts` to ground existing conditions.
2. **Preserve Ambiguous Liquid Evidence**: Do not add weights for generic `.liquid` templates. Check existing explicit platform binding and evidence precedence; contradictory output shape is a compliance finding, not proof of a different platform.
3. **Remove False Comment and Haravan Scoring in `sections/` (L77–89)**:
   - Edit lines 83–88 to remove the false comment at L84 and delete `haravanScore += 10;`:
   ```typescript
   } else if (sectionFiles.some((f) => f.endsWith('.liquid'))) {
     shopifyScore += 10;
     indicators.push('sections/*.liquid templates found');
   }
   ```
   - Do not zero `haravanScore` or force Shopify; if the workspace has `config/settings.html` (+60), Haravan identity is preserved.

### 2. Scope Haravan Policy in Theme Source Mapper (`src/main/browser/theme-source-mapper.ts`)

4. **Inspect Lines 41–56, 211–252, and 341–355**: Read target lines in `src/main/browser/theme-source-mapper.ts`.
5. **Preserve Shared Types**: Retain `'section'` in `CandidateTemplate['type']` (L43) and `'section_lineage'` in `SourceEvidenceKind` (L28).
6. **Support Template and Layout Lineage**:
   - Verify line 211–221: `render_edge` evidence is awarded when an edge targets a snippet from any parent file (`layout/*.liquid`, `templates/*.liquid`, or `sections/*.liquid`).
   - In line 248–252, confirm that `hasLineage` is satisfied by `render_edge` directly, ensuring snippet candidates included from Haravan templates or layouts achieve correlation without requiring section parentage.

### 3. Update Tests

7. **Update Platform Detector Tests (`test/main/platform-detector.test.ts`)**:
   - Add test verifying flat `templates/*.liquid` contributes to Haravan detection.
   - Add test verifying `sections/*.liquid` alone awards Shopify score and does not award Haravan score.
8. **Run Unit Tests**: Ensure existing tests in `test/unit/theme-evidence-capabilities.test.ts` pass without regression.

---

## Validation

Execute the following focused test commands:

```bash
# 1. Run platform detector test suite
node --test test/main/platform-detector.test.ts

# 2. Run theme evidence capabilities test suite
node --test test/unit/theme-evidence-capabilities.test.ts
```

### Acceptance Gates

| Gate ID | Check | Expected Result |
|---|---|---|
| GATE-4.1 | Flat Liquid templates detection | Haravan identity is proven by `config/settings.html` (+ `config/settings_data.json`), NOT by flat templates; see R4.2 — `templates/*.liquid` are shared by Shopify/Sapo and carry no Haravan score. Corpus fixture: a Haravan theme scores as Haravan through its `config/settings.html` evidence. |
| GATE-4.2 | `sections/*.liquid` detection | Awards Shopify score; does NOT award Haravan score |
| GATE-4.3 | Multi-platform preservation | Sapo (`.bwt`) and Shopify (`.liquid` sections) continue to detect accurately |
| GATE-4.4 | Shared mapper integrity | `CandidateTemplate` and `ThemeSourceMapper` retain section and lineage support for Shopify/Sapo |
| GATE-4.5 | Haravan snippet correlation | Snippets rendered by templates or layouts achieve valid correlation |

---

## Risk

1. **Workspace Ambiguity with Mixed Conventions**:
   - *Risk*: A hybrid workspace containing both `config/settings.html` and stray `sections/*.liquid`.
   - *Mitigation*: Platform detection evaluates cumulative evidence: `settings.html` (+60) outweighs stray `sections/*.liquid` (+10 Shopify), preserving Haravan identity while downstream theme QA flags the stray section as a compliance defect.
2. **Multi-Platform Regressions**:
   - *Risk*: Modifying source mapper types breaking Shopify or Sapo workflows.
   - *Mitigation*: Shared types (`'section'`, `'section_lineage'`) and inclusion logic remain intact across all platforms.

---

## Rollback

If regressions occur in existing workflows:
1. Revert edits to `src/main/qa/scanners/platform-detector.ts` via `git checkout -- src/main/qa/scanners/platform-detector.ts`.
2. Revert edits to `src/main/browser/theme-source-mapper.ts` via `git checkout -- src/main/browser/theme-source-mapper.ts`.
3. Revert test file updates: `git checkout -- test/main/platform-detector.test.ts test/unit/theme-evidence-capabilities.test.ts`.
