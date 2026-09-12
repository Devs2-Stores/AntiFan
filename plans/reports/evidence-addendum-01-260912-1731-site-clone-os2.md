# EVIDENCE ADDENDUM 01 — AntiFan `@antifan/site-clone` emits a Shopify OS 2.0 theme skeleton labeled "Haravan OS 2.0"

**Addendum to:** `evidence-packet-260912-1731-haravan-base-theme.md` (packet stays frozen; this file is extra evidence)
**Status:** OBSERVED (source-level, read this session) — no inference required for the emission itself
**Why it matters:** the report's Phase 1–4 assume "Existing AntiFan Core" is a usable foundation for building a
Haravan-native Base Theme. The clone→Haravan compiler in that Core emits a **Shopify Online Store 2.0** theme
skeleton and its own DoD validator certifies that shape.

---

## 1. Package identity

`E:\Work\apps\AntiFan\packages\site-clone\package.json`

- `name`: `@antifan/site-clone`, `version`: `1.0.0`
- `description`: **"Haravan OS 2.0 Storefront Cloning & QA Engine"**

"Haravan OS 2.0" is not a Haravan concept. Haravan has no Online Store 2.0.

## 2. Emitted theme skeleton (verified by reading `src/generators/theme-compiler.ts`)

| Line | What it does | Haravan truth |
|---|---|---|
| L129 | `path.join(stagingDir, 'layout', 'theme.liquid')` | ✅ correct — Haravan uses `layout/` singular |
| L133 | "Generate dynamic **`templates/index.json`** from non-header/footer sections" | ❌ JSON templates are Shopify OS 2.0; Haravan templates are flat `index.liquid` |
| L190, L317, L471 | generates **`sections/*.liquid`** | ❌ Haravan has no `sections/` directory (30/30 real corpus themes have none) |
| L455–457 | validates `layout/theme.liquid` | ✅ |
| L462, L479 | validates `templates/index.json` | ❌ validates its own Shopify-shaped contract |
| L471–473 | errors on "orphaned section reference … file not found" | ❌ enforces Shopify section-reference graph |

**Observed output shape = Shopify OS 2.0:** `layout/theme.liquid` + `templates/index.json` + `sections/*.liquid`.
**Observed real Haravan shape (30/30 corpus themes):** `layout/theme.liquid` + flat `templates/*.liquid`
(`index.liquid`, `product.liquid`, `collection.liquid`, `article.liquid`, `cart.liquid`, `search.liquid`, `404.liquid`) + `snippets/` + `assets/` + `config/`. No `sections/`, no JSON templates.

## 3. `{% schema %}` block emission

- `src/generators/haravan-section-generator.ts:3` — "Outputs valid **Haravan OS 2.0 sections** with Liquid rendering and **`{% schema %}` blocks**"
- same file L73 — emits `blocks: blueprint.blockDefinitions.map(...)`
- same file L81–85 — emits `schemaObj.presets = [{ name, category: 'Custom Sections' }]`
- same file L93–95 — literal template:
  ```
  return `
  ${liquid}
  {% schema %}
  ${schemaJson}
  {% endschema %}
      `.trim();
  ```
- `src/generators/haravan-schema-generator.ts:666` — `return \`${liquidTemplate.trim()}\n\n{% schema %}\n${schemaJson}\n{% endschema %}\n\`;`
- same file L428–452 — validates `presets` arrays as a rule
- same file L113 — `presets?: HaravanPreset[]` in the type surface
- same file L17 — "All valid Haravan OS 2.0 schema input types"

`{% schema %}`, blocks, and presets are documented in the loaded Haravan baseline as **explicitly not Haravan**:
"Never apply Shopify OS 2.0 patterns: no JSON templates, `{% schema %}`, blocks, presets, app blocks, Shopify-only filters/routes."

## 4. Binding engine confirms the same assumption

`src/generators/liquid-binding-engine.ts:5` — "Binds static HTML representations to **Haravan OS 2.0** Liquid contracts
and sanitizes against DotLiquid .NET quirks."
Same file, first binding example uses `{{ product.featured_image | img_url: 'master' }}` —
`master` is discouraged by the loaded Haravan house rules (use a bounded preset such as `2048x2048`).

## 5. The DoD validator certifies the Shopify shape

`src/qa/dod-validator.ts`:
- L5 — "Haravan **OS 2.0** storefront meets the complete engineering bar for production readiness"
- L47 / L56 — check keys `schemaGeneration`, `schemaVerification`
- L235 — "Verifies authentic **Haravan OS 2.0** section and layout Liquid code generation."
- L241 — "Verifies dynamic extraction and synthesis of **OS 2.0 section schemas**."

So the pipeline is self-consistent: it generates OS 2.0 structure and then validates OS 2.0 structure. Neither step
can detect that the target platform is Haravan.

## 6. Second, independent verification defect (already in packet §3.3, restated as interaction)

`src/main/qa/theme-qa-workflow.ts`:
- L727/L731/L735 — unmeasured viewport ⇒ `passed: true`
- L737–745 — unmeasured viewports ⇒ `visualScore = 100`, `responsiveScore = 100`
- L749 — `haravanScore = checklist.liquidClean !== false ? 100 : 40`
- L763 — hardcoded detail string "Haravan OS 2.0 sections, schema presets, and Liquid templates"
- L780–792 — `overallScore` excludes unmeasured dimensions; `passed` gates only on measured ones

Two independent layers therefore assert Haravan compliance from Shopify semantics, and both are capable of emitting
PASS/100 with zero measurement.

## 7. Provenance of the `measured: false, passed: true` artifact

`E:\Work\test-theme\specs\qa-matrix.json` is written by the workflow itself (`theme-qa-workflow.ts` L700–706 writes
`specs/qa-matrix.json` into the workspace root). Its content:
`overallScore: 98`, `passed: true`, `haravanCompliance.score: 100`, all three viewports
`{mismatchPercent: null, passed: true, measured: false}`. This is not a legacy artifact — it is current output.

## 8. The defect is MATERIALIZED on disk, not theoretical

`E:\Work\apps\AntiFan\themes\roahtrip-haravan\` — a theme staged inside AntiFan — is a Shopify OS 2.0 skeleton:

- `layout/theme.liquid` present (correct name) — but see below
- `templates/index.json` present, containing the OS 2.0 section-reference graph, e.g.
  `{"sections":{"hero":{"type":"hero","settings":{...}},"value_props":{"type":"value-props",...}, ...}}`
- `sections/` contains 11 files: `announcement-bar.liquid`, `collection-grid.liquid`, `footer.liquid`,
  `header.liquid`, `hero.liquid`, `media-showcase.liquid`, `newsletter.liquid`,
  `slideshow-adventures.liquid`, `slideshow-scenarios.liquid`, `trending-products.liquid`, `value-props.liquid`
- **10 of those section files declare `{% schema %}`** (all except `collection-grid.liquid` by the grep above:
  announcement-bar, collection-grid, footer, header, hero, media-showcase, newsletter, slideshow-adventures,
  slideshow-scenarios, trending-products returned; `value-props` needs confirmation)

This is the exact output shape of `@antifan/site-clone`'s `theme-compiler` (`templates/index.json` + `sections/*.liquid`).
Haravan's own corpus (30/30 `customizes` themes) has neither. `templates/index.json` and `sections/` do not exist
in the Haravan theme model, so this artifact cannot be a functioning Haravan theme — yet it is stored under
AntiFan's `themes/` tree alongside the real Haravan copy `phukienmaymoc-copy`.

## 9. Scope note

Not established by this addendum (do not claim):
- whether `sections/` files are silently ignored, or cause an error, when a Haravan theme package is imported —
  `DERIVED` at best; pending official-doc confirmation (`VerifyThemeShape`).
- how many shipped customer themes came from this compiler — not measured.
- whether `packages/site-clone` is wired into the current default path or is dormant — pending scout T2.
