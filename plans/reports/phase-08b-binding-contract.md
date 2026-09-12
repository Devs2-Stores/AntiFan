# Phase 08B — Project Theme home binding contract (Main-authored, 2026-09-12)

Scope: `themes/phukienmaymoc-copy` (staging Haravan theme `1001512581`, role `unpublished`, org `200001207485`).
Reference design: `exports/hoplongtech-html/page-01-home/` (approved clone; 118 assets).
Evidence labels: `OBSERVED | VERIFIED | DERIVED | INFERRED | UNKNOWN | CONFLICT`. Never upgrade confidence.

## 1. Why the home must be re-bound (live evidence, read-only)

| Fact | Evidence |
|---|---|
| 24 of the 25 hardcoded home product links return HTTP 404 on this store; only `/products/lc1d09m7` exists | `reports/haravan-home-product-binding-probe.json` (`/products/<handle>.json?themeid=1001512581`) |
| Home category tiles/banners link to `/collections/bien-tan-ha-the`, `nut-nhan`, `mcb-cau-dao-tu-dong-dang-cai`, `cong-tac-o-cam-dan-dung`, `bien-ap`, `bien-ap-cach-ly` — none exist among the 37 live collections | `plans/reports/evidence-addon-10-260912-1731-live-collections.json` |
| The store's real catalog is laser/machine oriented: 235 products, 49 vendors (Sky Fire Laser 51, Raytools 33, BOCHU 15, Raycus 7, WSX 7 …) | `reports/haravan-live-vendors.json` |
| Reference content belongs to a different catalog (Schneider/NiSTRO/VEICHI/GIGA/Autonics/Omron electrical) that this store does not carry | same probes |

Derived: the home currently reproduces the reference **geometry** but links to non-existent entities. Pixel-parity with the reference is therefore **not** the correct success criterion for catalog surfaces; correctness on this store is. Brand/chrome art stays reference-derived, catalog surfaces bind to real store data.

## 2. Asset policy

- **Static reference art** (already copied into `themes/phukienmaymoc-copy/assets/`; provenance in `reports/haravan-home-media-provenance.json`): hero slides, partner logos, footer sibling-site logos, header/footer logos, quote illustration. These are the approved design's brand identity.
- **Data-bound imagery**: product cards, block promo rails, category tiles, banners, accessory items → use real store images (`product.featured_image.src | img_url: 'medium'`, `collection.products.first.featured_image | product_img_url: 'medium'`, `article.image.src`). Never re-point these at a reference art asset.
- Every `<img>` keeps its `onerror` fallback (`{{ 'no_image.jpg' | asset_url }}` or the existing `default_image.png.webp`) and its `width`/`height` attributes (CLS geometry must not change).

## 3. Canonical Liquid idioms (copy these; do not invent)

Source of truth: `templates/collection.liquid:218-255` (product card), `snippets/hl-home-news.liquid:38-62` (data loop).

```liquid
{%- assign blk = collections['contactor'] -%}
{%- if blk and blk.products.size > 0 -%}
  {%- for product in blk.products limit: 5 -%}
    <div class="product-list__item">
      <div class="thumbnail">
        <a href="{{ product.url }}" title="{{ product.title }}" aria-label="{{ product.title }}">
          <div class="thumbnail-item">
            <img loading="lazy" src="{{ product.featured_image.src | img_url: 'medium' }}" alt="{{ product.title | escape }}" title="{{ product.title }}" width="172" height="155" onerror="this.onerror=null; this.src='{{ 'no_image.jpg' | asset_url }}';">
          </div>
        </a>
      </div>
      <div class="content">
        <h3 class="text-bold">
          <a href="{{ product.url }}" title="{{ product.title }}" aria-label="{{ product.title }}">{{ product.title }}</a>
        </h3>
        <div class="price flex-left-between">
          <div class="left">
            {% if product.variants.first.price == 0 %}
              <a href="{{ settings.prod_pricezero_link }}" class="f-initial hrv-cf-prod_pricezero_title" setting-id="prod_pricezero_title" setting-type="text"><span>{{ settings.prod_pricezero_title }}</span></a>
            {% else %}
              <p>{{ product.variants.first.price | money }}</p>
            {% endif %}
          </div>
          <div class="right">
            {% if product.variants.first.compare_at_price > product.variants.first.price and product.variants.first.price > 0 %}
              <span class="percent">-{{ product.variants.first.compare_at_price | minus: product.variants.first.price | times: 100 | divided_by: product.variants.first.compare_at_price | round: 0 }}%</span>
            {% endif %}
          </div>
        </div>
      </div>
    </div>
  {%- endfor -%}
{%- else -%}
  <div class="collection-alert-no"><p>Chưa có sản phẩm nào trong danh mục này</p></div>
{%- endif -%}
```

- Collection: `collections['handle'].title`, `.url`, `.products.size`, `.products`.
- Blog/article: `blogs['news']`, `home_blog.articles`, `article.title`, `article.url`, `article.image.src`, `article.content | strip_html | truncatewords: 35`.
- Price: `| money`. Images: `| img_url: '<size>'` / `| product_img_url: '<size>'`. `settings.prod_pricezero_title` / `settings.prod_pricezero_link` exist in `config/settings.html:497,502`.

## 4. Forbidden (linter-enforced, exit 1)

`{% schema %}`, `| render`, `{% section %}`, `reject`, `where`, `concat`, `at_most`, `at_least`, `image_url` filter, JSON templates.
Also forbidden: new settings ids, mock/placeholder commerce values, hardcoded prices, dead links, duplicate `id=` attributes, Liquid syntax errors.

## 5. Binding map (5 blocks / 5 tiles / 3 banners / 8 accessory) — real entities only

Blocks (reference semantics → real collection; two keep their reference counterpart, three substitute the store's flagship categories and MUST take their title from the collection):

| # | Reference block | Real collection | Products |
|---|---|---|---|
| 1 | Contactor | `contactor` | 5 |
| 2 | Cảm biến | `cam-bien` | 5 |
| 3 | Phụ Kiện Máy Laser | `phu-kien-may-laser` | 50 |
| 4 | Đầu Cắt Laser | `dau-cat-laser` | 29 |
| 5 | Phụ Trợ | `phu-tro` | 31 |

Tiles (5): `phu-kien-may-laser`, `dau-cat-laser`, `nguon-laser-soi-quang`, `vat-tu-tieu-hao-cho-laser`, `contactor`.
Banners (3): `phu-tro`, `phu-kien-laser-co2`, `may-lam-lanh-nuoc`.
Accessory (8): `phu-tro`, `phu-kien-may-laser`, `vat-tu-tieu-hao-cho-laser`, `phu-kien-dien-tu`, `he-thong-dieu-khien-khi-phu-tro`, `huong-dan-va-thanh-truot`, `bo-giam-toc`, `dong-co-servo-bo-dieu-khien-servo`.
Hero slides (10): keep reference slide art; each slide's `href`/`data-href`/`title`/`aria-label` must point at a real route — map to `/collections/{handle}` for the mapped collections above; no `?filterBrandIds=` and no `/series/...` (both unverified/dead).

Counts are live (`reports/haravan-live-collection-counts.json`); blocks/tiles take titles from the entity, never from the reference label.

## 6. Ownership (no two writers on one file)

| Owner | Files |
|---|---|
| Main | this contract, integration verification, evidence receipts. Main's static-image wiring pass is COMPLETE and FROZEN (`reports/haravan-home-media-map.json`, 99 substitutions across 8 snippets); Main no longer writes these files. |
| HomeProductBlocks | `snippets/hl-home-block-category.liquid` (complete) |
| HomeTilesHero | `snippets/hl-home-categories.liquid`, `snippets/hl-home-banners.liquid`, `snippets/hl-home-hero.liquid`, `snippets/hl-home-accessory.liquid` (sole writer) |
| HomeFormsEngine | `snippets/hl-home-quote.liquid`, `assets/hl-home.js.liquid`, `snippets/hl-home-news.liquid`, `layout/theme.liquid` |

Do not run project tests/builds; Main runs the linter, live render probes and receipts.
