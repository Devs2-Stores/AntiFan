---
name: antifan-theme
description: Domain procedure for AntiFan theme surfaces (Liquid/Shopify/Haravan 7-directory structure), read-only evidence inspection, and contract refusal reporting.
---

# AntiFan Theme Surface Procedure

This skill defines the directory architecture, evidence inspection protocols, and refusal reporting procedures for theme surfaces evaluated and repaired under the AntiFan B-Lite v2 fix loop.

## 1. Theme Architecture (7 Compiler Output Directories)
Theme source repositories (Haravan, Shopify, Sapo) compiled by `ThemeCompiler` follow a strict 7-directory layout:

1. `layout/`:
   - Global root layouts wrapping page content.
   - Key files: `layout/theme.liquid`, `layout/password.liquid`, `layout/checkout.liquid`.
   - Contains structural hooks: `{{ content_for_header }}` and `{{ content_for_layout }}`.
2. `templates/`:
   - Page-level route templates mapping to storefront URLs.
   - Key files: `templates/index.liquid`, `templates/product.liquid`, `templates/collection.liquid`, `templates/cart.liquid`, `templates/blog.liquid`, `templates/article.liquid`, `templates/page.liquid`, `templates/404.liquid`.
   - Also includes JSON template variants: `templates/*.json`.
3. `sections/`:
   - Modular, reusable UI components with merchant-configurable schema settings.
   - Key files: `sections/header.liquid`, `sections/footer.liquid`, `sections/main-product.liquid`, `sections/main-collection.liquid`, `sections/hero-banner.liquid`.
   - Contains `{% schema %}` JSON blocks defining presets and settings.
4. `snippets/`:
   - Reusable Liquid partials and micro-templates.
   - Key files: `snippets/product-card.liquid`, `snippets/price.liquid`, `snippets/pagination.liquid`, `snippets/icon.liquid`.
   - Rendered using `{% render 'snippet-name', param: value %}`.
5. `assets/`:
   - Static client assets: stylesheets, JavaScript modules, fonts, SVGs, and brand images.
   - Key files: `assets/theme.css`, `assets/theme.js`, `assets/base.css`.
   - Linked via Liquid asset filters: `{{ 'theme.css' | asset_url | stylesheet_tag }}`.
6. `config/`:
   - Theme configuration schemas and saved merchant settings.
   - Key files: `config/settings_schema.json` (admin editor definition) and `config/settings_data.json` (active values).
7. `locales/`:
   - Internationalization and translation dictionaries.
   - Key files: `locales/vi.json`, `locales/en.default.json`.

## 2. Evidence Inspection Capabilities (Read-Only Surface)
When diagnosing a theme defect identified by AntiFan, workers consult diagnostic evidence produced by AntiFan's engine:

- **`anti.inspect.dom`:**
  - Inspects DOM hierarchy, attributes, class lists, and text content for given CSS selectors.
  - Used to verify missing HTML tags, broken wrapper nesting, or missing data attributes.
- **`anti.inspect.styles`:**
  - Reads live computed styles, box-model metrics (margin, padding, border, content box), and CSS variable values.
  - Used to identify incorrect colors, font sizes, margins, or flex/grid alignment bugs.
- **`anti.inspect.region`:**
  - Analyzes spatial bounding boxes within viewport coordinates.
  - Used to diagnose horizontal overflow (`scrollWidth > clientWidth`), clipping, and z-index overlap.
- **`anti.inspect.snapshot`:**
  - Captures an accessible semantic snapshot of the page with monotonic `@e1..@eN` references.
- **Visual Capture Artifacts:**
  - Inspection of baseline vs current PNG captures and diff heatmaps located in `.canary/evidence/<runId>/`.

## 3. Surgical Repair Workflow
1. **Target Identification:**
   - Map `targetCauseCode` (e.g. `GEOMETRY_OVERFLOW_X`, `LAYOUT_SHIFT`, `CONTRAST_RATIO`) to the responsible file in the 7-directory structure.
   - CSS-only defects: locate relevant rules in `assets/*.css`.
   - Markup/structural defects: locate relevant Liquid elements in `sections/*.liquid` or `snippets/*.liquid`.
2. **Scope Verification:**
   - Check whether the file requiring changes is listed in `FixRequest.allowedFiles[]`.
   - If not in `allowedFiles[]`, halt immediately and follow the Refusal Procedure below.
3. **Execution:**
   - Modify the staged copy using `file.write`.
   - Never touch files outside the staged workspace root.
   - Never add inline CSS hacks when stylesheet rules in `assets/` or section styles exist.

## 4. Refusal & Scope Reporting Procedure

### Case A: Required File Not in `allowedFiles` (`SCOPE_DISCOVERY`)
If a defect cannot be solved without editing a file outside `allowedFiles[]`:
- Do **not** modify out-of-scope files.
- Return a `FixResult v2` with:
  - `decision`: "REFUSED_SCOPE"
  - `touchedPaths`: `[]`
  - `missingPaths`: `["path/to/required-file.liquid"]`
  - `notes`: "SCOPE_DISCOVERY: Defect requires editing path/to/required-file.liquid to fix targetCauseCode."

### Case B: Route & Parameter Mismatch
If the target surface route expectation does not match the live environment:
- Report the specific typed route refusal code:
  - `URL_HOST_MISMATCH`: The store host does not match expected target domain.
  - `URL_THEME_MISMATCH`: The target theme ID does not match active runtime theme.
  - `URL_PATH_MISMATCH`: The surface URL path does not match route definition.
  - `URL_EXPECTATION_MISSING`: Route metadata is absent.

### Case C: Tool Surface Boundary
- Fixer workers must NEVER attempt to invoke browser execution tools (`anti.browser.evaluate`, `anti.theme.style_override`, `anti.agent.cursor.*`).
- If browser execution is attempted, the merge gate or hook will refuse the attempt with `REFUSED_TOOL_SURFACE`.
