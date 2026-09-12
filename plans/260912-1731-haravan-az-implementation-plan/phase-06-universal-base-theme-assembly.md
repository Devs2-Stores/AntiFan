# Phase 06 — Universal Haravan Base Theme Assembly
Status: BLOCKED_ON_PREDECESSOR
Depends on: 05, 08A

## Context

Phase 06 establishes themes/universal-haravan-base/ as an unopinionated, brand-neutral commerce foundation, separate from specific project parity targets such as Hoplongtech or Phukienmaymoc. It depends on Phase 05 for the clean Haravan compiler cutover and Phase 08A for the locked platform capability contract and pattern-mined wiki.

Non-Duplication Invariant:
The base theme is synthesized from empirical consensus and not copied from themes/phukienmaymoc-copy. The template audit in reports/15-page-template-audit.json proves themes/phukienmaymoc-copy is contaminated by clone and framework artifacts: 18 pages audited (only 9 fully dynamic), 256 Hoplong URL leaks, 1040 Blade comment markers, 233 Livewire wire directives, 69 missing local assets, and 95 undeclared settings.

Corpus Recurrence as Convention:
The 30-theme census (plans/reports/scout-union-260912-1731-haravan-base-theme.md and evidence packet EP-260912-1731 §3.1) demonstrates dominant storefront conventions, not dogmatic platform law:
- layout/ singular in 30/30 themes (100%), layouts/ in 0/30.
- sections/ in 0/30 themes (0%).
- JSON templates in 0/30 themes (0%).
- {% schema %} blocks in 0/30 themes (0%).
- {% render %} tags in 0/30 themes (0%).
- Shopify-only filters (reject, where, concat, at_most, at_least, image_url) in 0/30 themes (0%).
- Dual settings configurations: settings.html in 30/30 (100%), settings_schema.json in 24/30 (80%), settings_data.json in 30/30 (100%); zero settings_schema-only themes in the 30-theme intake census.
- Slider engine fragmentation: Slick 19/30 (63.3%), Swiper 9/30 (30.0%), Owl 6/30 (20.0%), Flickity 5/30 (16.7%).

## Requirements

1. Directory Layout: Haravan flat hierarchy with layout/, templates/, snippets/, config/, and assets/. No Shopify section output. Additional directories such as locales follow the verified Phase 08A capability/localization contract, not an unsupported blanket ban. Shared tools retain other-platform behavior.
2. Root Layout: Single layout/theme.liquid providing standard HTML5 document shell, viewport metadata, mandatory platform hooks (content_for_header, content_for_layout), accessible skip-link, header/footer/drawer inclusions, and zero external CDN script dependencies.
3. Full Commerce Templates: Complete commerce lifecycle coverage without arbitrary template count limits. Core storefront includes templates for index, product, collection, cart, blog, article, page, search, and 404. Full customer subsystem includes customer account overview, login, registration, password recovery, multi-address management (customers[addresses].liquid), and detailed order inspection (customers[order].liquid). Zero JSON templates.
4. Consensus Snippets: Reusable Liquid components for header, footer, swatch, breadcrumb, social metadata, default pagination, product loop cards, and mini-cart drawer. All inclusions use include; {% render %} is prohibited.
5. Conditional Settings Architecture: Support verified Haravan Admin settings mode (settings.html + settings_data.json) and F1GENZ visual editor mode (settings_schema.json without settings.html). The brand-neutral Base Theme ships valid settings files for default merchant styling without enforcing an unverified 1:1 key parity constraint across both schemas. Every setting read in Liquid must resolve to a valid default in settings_data.json.
6. Zero-Dependency Assets: Pure CSS3/CSS4 theme.css (CSS Grid, Flexbox, custom properties, native scroll-snap) and vanilla ECMAScript theme.js for mobile navigation, drawer toggles, and carousel navigation. Zero runtime dependency on jQuery, Bootstrap, Slick, or Swiper.
7. Liquid Platform Contracts: Zero {% schema %} blocks. Zero Shopify-only filters (reject, where, concat, at_most, at_least, image_url). Cart iterations use line_item naming (for line_item in cart.items). Article totals use blog.articles_count. Product variant selection uses product.selected_or_first_available_variant with fallback to product.variants.first.
8. Proven Image Gallery Runtime: Product image galleries must use the verified runtime object product.images with standard geometry filters (such as img_url: '1024x1024' or img_url: 'medium'). The product.media object and media_tag filter are unverified in live Haravan theme runtime and are permitted only behind an explicit Phase 08A official runtime evidence gate.
9. Vendor-Neutral Carousel Baseline: Hardware-accelerated CSS scroll-snap baseline (scroll-snap-type: x mandatory, scroll-snap-align: start) with data-carousel-* hooks, operated by lightweight vanilla JS. No arbitrary vendor ban if a merchant theme customization or third-party app explicitly introduces Slick, Swiper, or Owl.
10. Accessibility, SEO, and Performance: Skip-to-content navigation, semantic landmarks (header, main, footer, nav), explicit form label associations, image alt fallback, and ARIA state handling (aria-expanded, aria-controls, aria-selected). Canonical URL tags, page title branding, and social meta. Lazy loading below-the-fold assets and zero render-blocking scripts.

## Files

| path | action | why |
|---|---|---|
| reports/15-page-template-audit.json | read | Source of empirical defect metrics in phukienmaymoc-copy proving why cloning is rejected |
| plans/reports/scout-union-260912-1731-haravan-base-theme.md | read | Source of 30-theme recurrence counts and slider library distribution |
| plans/reports/evidence-packet-260912-1731-haravan-base-theme.md | read | Frozen Tier-1 evidence for Haravan platform constraints |
| scripts/theme-checks.mjs | read | Existing offline theme verification CLI runner |
| scripts/lib/theme-checks.mjs | read | Core static inspection rules for schema, binding, and asset resolution |
| packages/site-clone/src/generators/theme-compiler.ts | read | Verified source of D5 OS 2.0 generator output |
| themes/phukienmaymoc-copy/config/settings_schema.json | read | Reference for Haravan visual editor schema format |
| themes/phukienmaymoc-copy/config/settings.html | read | Reference for Haravan Admin HTML settings form syntax |
| scripts/theme-checks.mjs | edit | Integrate Haravan platform-scoped invariant checks into CLI runner (L57–64) |
| scripts/lib/theme-checks.mjs | edit | Add Haravan-scoped rules for zero sections, forbidden filters/tags, and conditional settings (L50–51, L141–215) |
| scripts/lint-haravan-theme.mjs | create | Dedicated offline, zero-network static linter for Haravan base theme verification |
| themes/universal-haravan-base/layout/theme.liquid | create | Canonical root layout shell with content hooks and skip-link |
| themes/universal-haravan-base/templates/index.liquid | create | Storefront home template |
| themes/universal-haravan-base/templates/product.liquid | create | Product detail template with proven product.images gallery and variant selector |
| themes/universal-haravan-base/templates/collection.liquid | create | Product collection listing with pagination and sorting |
| themes/universal-haravan-base/templates/cart.liquid | create | Cart table template using line_item iteration |
| themes/universal-haravan-base/templates/blog.liquid | create | Blog listing template using blog.articles_count |
| themes/universal-haravan-base/templates/article.liquid | create | Single article template with comments form |
| themes/universal-haravan-base/templates/page.liquid | create | Standard content page template |
| themes/universal-haravan-base/templates/search.liquid | create | Search input and multi-result template |
| themes/universal-haravan-base/templates/404.liquid | create | Error recovery template |
| themes/universal-haravan-base/templates/customers[account].liquid | create | Customer account overview and order history |
| themes/universal-haravan-base/templates/customers[login].liquid | create | Customer login form with password recovery toggle |
| themes/universal-haravan-base/templates/customers[register].liquid | create | Customer registration form |
| themes/universal-haravan-base/templates/customers[addresses].liquid | create | Customer address book add, edit, and delete management |
| themes/universal-haravan-base/templates/customers[order].liquid | create | Order item detail and fulfillment status breakdown |
| themes/universal-haravan-base/snippets/header.liquid | create | Header snippet with logo, navigation, search, and cart badge |
| themes/universal-haravan-base/snippets/footer.liquid | create | Footer snippet with store links and payment badges |
| themes/universal-haravan-base/snippets/swatch.liquid | create | Product option swatch snippet |
| themes/universal-haravan-base/snippets/breadcrumb.liquid | create | Semantic navigation breadcrumb snippet |
| themes/universal-haravan-base/snippets/social-meta-tags.liquid | create | Open Graph and Twitter Card metadata snippet |
| themes/universal-haravan-base/snippets/pagination-default.liquid | create | Reusable pagination link builder |
| themes/universal-haravan-base/snippets/product-loop.liquid | create | Reusable product card item snippet |
| themes/universal-haravan-base/snippets/mini-cart.liquid | create | Slide-over cart drawer snippet |
| themes/universal-haravan-base/config/settings.html | create | Admin visual configuration form |
| themes/universal-haravan-base/config/settings_schema.json | create | Theme visual editor schema specification |
| themes/universal-haravan-base/config/settings_data.json | create | Initial default settings storage |
| themes/universal-haravan-base/assets/theme.css | create | Zero-dependency responsive stylesheet with CSS scroll-snap |
| themes/universal-haravan-base/assets/theme.js | create | Vanilla JavaScript controller for navigation, drawer, and carousel |

## Steps

1. Verify Phase 08A capability contract gate and Phase 05 compiler cutover readiness.
2. In scripts/lib/theme-checks.mjs (L50–51), add platform-scoped rule HARAVAN_FORBIDDEN_SECTION that flags sections/ only when --platform haravan is active, preserving shared Shopify/Sapo parsing.
3. In scripts/lib/theme-checks.mjs (L141–215), implement checkHaravanLiquidContracts(themeDir, options) to verify zero {% schema %}, zero {% render %}, absence of Shopify filters, line_item cart naming, blog.articles_count, proven product.images usage, and conditional settings validation matching the active settings mode.
4. In scripts/theme-checks.mjs (L57–64), wire Haravan contract violations into the CLI refusals list under platform-scoped execution.
5. Create scripts/lint-haravan-theme.mjs as a zero-network static validation runner enforcing Haravan platform rules.
6. Scaffold directory hierarchy themes/universal-haravan-base/ with layout/, templates/, snippets/, config/, and assets/.
7. Author layout/theme.liquid with required hooks, accessible skip-link, and core snippet inclusions.
8. Author core storefront templates (index, product, collection, cart, blog, article, page, search, 404). In templates/product.liquid, render the gallery with proven product.images.
9. Author customer subsystem templates (account, login, register, addresses, order).
10. Author consensus snippets (header, footer, swatch, breadcrumb, social-meta-tags, pagination-default, product-loop, mini-cart).
11. Author config files (settings.html, settings_schema.json, settings_data.json) ensuring every setting read in Liquid resolves to a valid default in settings_data.json under the active settings mode.
12. Author assets/theme.css and assets/theme.js providing accessible styling and the data-carousel-* scroll-snap controller.
13. Run static validation with node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base and confirm zero refusals with exit code 0.

## Validation

Validation is performed exclusively by the static, zero-network linter without spawning a browser or accessing remote endpoints:

Command: node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base

Certification Criteria:
1. Directory Structure: Validate generated topology against the same Phase 08A contract consumed by Phase 05, including any verified localization requirements.
2. Template Integrity: All required storefront and customer templates exist as flat .liquid files. Exactly zero JSON templates exist under templates/.
3. Tag and Filter Invariants: Zero {% schema %} blocks and zero {% render %} tags. Zero occurrences of reject, where, concat, at_most, at_least, or image_url filters.
4. Liquid Contracts: 100% of cart loops use line_item. Article count uses blog.articles_count. Variant selector implements selected_or_first_available_variant with default fallback. Product media gallery strictly uses proven product.images; product.media is rejected unless certified by Phase 08A runtime evidence.
5. Conditional Settings Resolution: Every setting read resolves to a default in config/settings_data.json. In Admin mode, settings.html is validated; in F1GENZ mode, settings.html is verified absent and settings_schema.json is validated. No cross-schema key duplication requirement is enforced.
6. Asset and Reference Hygiene: All local asset references resolve under assets/. Zero remote Hoplong URLs, zero Blade comments, and zero Livewire directives.
7. Accessibility and Interaction Baseline: Verified skip-link, landmark roles, input labels, alt text fallbacks, and ARIA attributes for drawers, controls, and scroll-snap carousels.

## Risk

| Risk | Impact | Mitigation |
|---|---|---|
| Merchant customization relies on third-party carousel library (Slick/Swiper) | Low | The CSS scroll-snap baseline requires zero JS libraries. Third-party vendor libraries remain permitted if required by merchant apps without breaking template contracts. |
| Incompatible settings mode between Admin and F1GENZ visual editor | Low | Settings validation is mode-conditional. Standard themes use settings.html + settings_data.json; F1GENZ themes use settings_schema.json without settings.html. |
| Product media feature gap compared to modern Shopify | Low | Standard Haravan storefront runtime proves product.images. Rich media (3D/video) requires Phase 08A live runtime certification before template adoption. |

## Rollback

1. Restore only owned changes from a verified backup; preserve user edits and historical evidence.
2. Destructive filesystem/VCS removal and any remote rollback require explicit approval. Do not prescribe broad rm or checkout commands.
