<!-- .cursor/rules/theme-rules.md -->
<!-- INTERFACE: child-rule-contract-v1 -->
# Extends: AGENTS.md (Root Contract v1.2.0 Hardened)
# Domain: E-commerce Theme Engineering (Shopify, Haravan, Sapo, Liquid & Storefronts)
# Precedence: ROOT_AGENTS_MD (L0) > THIS_RULE (L1) > AD-HOC_PROMPT (L2)

## 1. Domain Invariants (Theme & Storefront Standards)
- **Live Theme Push & API Safety:** `NEVER` auto-run live theme deployment, sync, or fetch commands (`haravan theme push*`, `haravan theme dev`, `hrv *`, `shopify theme push*`, `shopify theme dev`, `sapo theme *`, `bizweb theme *`, `theme watch/deploy`, or direct REST/GraphQL Theme Asset API PUT/POST requests) without explicit, per-command user authorization.
- **Platform Liquid Dialect Isolation:**
  - **Shopify (OS 2.0):** Use `{% render %}`, section `{% schema %}`, JSON templates (`templates/*.json`), `image_url` filter, `line_item.url`.
  - **Haravan:** Use `{% include %}` only (NO `render`, NO `{% schema %}` inside sections), `img_url: '...'` / `hstatic` asset filters, `line_item.url`. Support both `config/settings_schema.json` (F1GENZ) and `config/settings.html` (Legacy).
  - **Sapo / Bizweb (.bwt):** Use `{% include %}` only. STRICT BAN on `| slice` (causes fatal .NET LINQ dump). Use `line_item.product.url` for cart links, `bizweb_asset_url`, and `/postcontact` for contact forms.
- **Visual Editor & F1GENZ Bindings:** `NEVER` remove or alter `setting-id`, `setting-type`, `data-setting-*` attributes from storefront HTML/Liquid when refactoring, as they power the live click-to-edit customizer.
- **PageSpeed & Core Web Vitals (CWV):**
  - NEVER apply `loading="lazy"` to LCP Hero banner images; apply `fetchpriority="high"` instead.
  - Preserve `window.noPS = f1genzPS` and `<img nosrc="..." class="lazyload">` bootstrap architecture when present.
  - Always retain intrinsic `width` and `height` attributes on `<img>` tags and enforce CSS `aspect-ratio` containers to prevent CLS.

## 2. Specialized Tool Gating (Pre-conditions & Post-conditions)
- **Liquid & Template Inspection:** Agent MUST `read` target `.liquid`, `.bwt`, or `settings_schema.json` lines before modifying theme sections or snippets.
- **Visual & DOM Verification:** For storefront UI changes, verify computed styles and layout integrity using DOM inspection (`anti.inspect.dom`) or viewport screenshots (`anti.screenshot.viewport`) when available.

## 3. Verification & Proof Protocols
- **Schema Validation:** Ensure `settings_schema.json` or section `{% schema %}` blocks remain valid JSON (no trailing commas) after edits.
- **Liquid Syntax Check:** Verify absence of unclosed tags (`{% if %}` without `{% endif %}`, unclosed `{% schema %}`).
- **Delivery Proof:** Report exact modified templates/snippets and provide rendered DOM/visual or local syntax validation logs.
