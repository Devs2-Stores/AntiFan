# Haravan Platform Claim Verification — report `AntiFan — Final Haravan Platform Knowledge + Universal Base Theme`

**Method:** three independent read-only research agents, each owning one claim cluster, grading against primary
Haravan sources (`docs.haravan.com`, `themes.haravan.com/pages/cheat-sheet`, `haravan.github.io/help/cheat-sheet`,
`github.com/Haravan/haravan_theme_twenty`) and cross-checking the real 30-theme corpus at `E:\Work\customizes`.
Every verdict below carries a URL that was actually read plus a quoted string, or a file:line in the corpus.
**Source dates:** agents read live docs this session (2026-09-12). Local skill facts were captured 2026-07-05.

---

## A. Liquid runtime (agent `VerifyLiquid`)

### A1. Report §11 Product object graph — **TRUE**
Docs list all nine properties. `https://docs.haravan.com/docs/themes/objects/product/`:
> "`product.available`: Trả về `true` nếu một sản phẩm có sẵn để mua."
> "`product.media`: Trả về một danh sách các media của sản phẩm."
> "`product.first_available_variant`: Trả về đối tượng variant của sản phẩm đặc thù đầu tiên có thể mua."
Corpus: `customizes/Apshop/snippets/lp-special.liquid:69` uses `{{product.first_available_variant.id}}`.

**Correction the report needs:** real themes prefer
`product.selected_or_first_available_variant | default: product.variants.first` because it honours `?variant=`.
`first_available_variant` alone ignores the URL parameter.

### A2. Object names — **PARTLY TRUE** (naming correction)
Haravan's cart element object is officially **`line_item`**, not "cart item"/`cart_item`.
`https://docs.haravan.com/docs/themes/objects/line_item/`: "Một line item đại diện cho một khoản mục đơn lẻ trong một giỏ hàng."
`cart.items` iterates `line_item` instances. The report's own §11 text uses `line_item` — keep that name everywhere.

### A3. `product.media` support — **TRUE** (upgrades the loaded local skill)
Officially documented, including `media.media_type`, `media.host`, `media.preview_image.src`,
`external_video_url`, `external_video_tag`. The local `haravan-theme` cheatsheet marks this as
"confirmed usable on Haravan projects that enable product media" — that is **more conservative than the docs**.
Docs example (product object page) uses `{% for media in product.media %}` with `media.media_type == 'external_video'`.
Corpus: the 30 intake themes use `product.images` only; `AntiFan/themes/phukienmaymoc-copy/snippets/template-product-01.liquid:14-33`
implements the documented media loop.

**Correction:** Base Theme may use `product.media`, but MUST keep a `product.images` / `product.featured_image` fallback —
older catalogs populate only `images`.

### A4. `blog.articles_count` — **TRUE**
`https://docs.haravan.com/docs/themes/objects/blog/`: "`blog.articles_count`: Trả về tổng số bài viết trong một blog.
Trong đó không bao gồm các bài viết đã được ẩn đi."
`blog.articles.size` is only the current page slice / current context length.
Corpus confirms the risk is real and already known locally:
`customizes/Phukienmaymoc/templates/article.liquid:205` → `{% if settings.blogs_related_show and blog.articles_count > 1 %}`;
`customizes/GomDatViet/templates/article.liquid:113`; `customizes/Luxvie/snippets/m_blog_relate.liquid:1`.

### A5. Absent Shopify filters/tags — **TRUE**, with a corpus proof
Docs show only `join/first/last/map/size/sort` (array), `ceil/divided_by/floor/minus/plus/round/times/modulo` (math),
`img_url`/`product_img_url` (url), and tags `comment/raw/if/unless/case/cycle/for/tablerow/assign/capture/include/
increment/decrement/form/layout/paginate` — no `schema`.
**Corpus grep across all 30 themes (templates + snippets):**
`| reject`, `| where`, `| concat`, `| at_most`, `| at_least`, `| image_url` → **0 hits**;
`{% render %}` → **0 hits**; `{% schema %}` → **0 hits**.
**Correction:** `'compact'` is absent as an *array filter* but exists as a valid 160×160 **image size preset**
(`img_url: 'compact'`). Do not conflate the two.

---

## B. API / auth / scopes (agent `VerifyApi`)

### B1. Haraweb scopes — **PARTLY TRUE** (scope granularity is wrong in the report)
`https://docs.haravan.com/docs/omni-apis/access-scopes/` — prefix `https://apis.haravan.com/web`, `web.{scope_name}`.
Table: `web.read_contents` / `web.write_contents` → **Blog, Comment, Page, Redirect, Article** (bundled);
`web.read_themes` / `web.write_themes` → Theme; `web.read_script_tags` / `web.write_script_tags` → ScriptTag.

**Correction:** there are **no** `web.read_blogs`, `web.read_pages`, `web.read_articles` scopes. Requesting them fails OAuth.

### B2. Commerce scopes — **PARTLY TRUE** (same defect)
Prefix `https://apis.haravan.com/com`, `com.{scope_name}`.
Table: `com.read_products` / `com.write_products` → **Product, Smart_collection, Collect, Custom_collections,
Product variant, Product Image** (all bundled under Products).

**Correction:** there are **no** `com.read_collections`, `com.read_variants`, `com.read_images` scopes.
The report's §9 sentence "Commerce bao gồm Products, Collections, Variants, Images" is right about *coverage*
and wrong about *scope naming* — a reader would request scopes that do not exist.
Corpus cross-check: the live store has 35 `custom_collections`, 0 `smart_collections`, fetched under `com.read_products`.

### B3. Omni vs Ajax — **TRUE**
`https://docs.haravan.com/docs/tutorials/authentication/authentication-and-authorization/`:
Omni API → Authenticated: "Yes", format "REST"; Ajax API → "Provides lightweight endpoints for development of Haravan themes."
Authenticated: "No". Plus: "session tokens can't be used to make authenticated requests to Omni APIs."
Corpus: `AntiFan/themes/phukienmaymoc-copy/assets/scripts.js.liquid:360-470` and
`header-minicart.js.liquid:143-221` call `/cart/add.js`, `/cart/change.js`, `/cart/update.js` unauthenticated.

### B4. Collection creation + linking — **TRUE**
`https://docs.haravan.com/docs/omni-apis/custom-collections/` — `POST /com/custom_collections.json` accepting
`{"custom_collection":{"title":"IPods","collects":[{"product_id":921728736}]}}`.
`https://docs.haravan.com/docs/omni-apis/collects/` — `POST /com/collects.json` with
`{"collect":{"product_id":...,"collection_id":...}}`. Smart collections reject manual collects:
"Creating a collect that links a product to a smart collection results in a 403 Forbidden error."

**Consequence for the report's Phase 5 / data rule:** the minimum-data creation path is API-viable for
custom collections, but NOT for smart collections.

### B5. Rate limits + inventory batch — **CONFLICT (in Haravan's own docs)**
- `https://docs.haravan.com/docs/omni-apis/api-call-limit/`: leaky bucket, "Bucket size: 80", "Leak rate: 4/second",
  headers `X-Haravan-Api-Call-Limit`, `Retry-After`, HTTP 429.
- Same page: inventory adjustment "best supports for <=200 items per request".
- `https://docs.haravan.com/docs/omni-apis/inventory-adjustment/` properties section: "Best supports 200 items for a request."
- Same page, create endpoint `POST /com/inventories/adjustorset.json`: "The API best supports arrays of 100 items per request."
**Verdict: CONFLICT** — this is a Haravan documentation conflict, not a report error. The report must record it as
`CONFLICT` and chunk at 100. It already does this correctly via the loaded skill; keep the vocabulary.

### B6. Webhooks — **TRUE**
Scope `wh_api`; HTTPS only; `POST/DELETE/GET https://webhook.haravan.com/api/subscribe`;
challenge `hub.mode=subscribe&hub.verify_token=…&hub.challenge=…` → 200 + challenge, else 401;
`X-Haravan-Hmacsha256` = base64 HMAC-SHA256 of raw body with Client Secret;
200 within 5 s; "Any response outside of the 200 range, including 3XX HTTP redirection codes, indicates that you
didn't receive the webhook."; 19 retries / 48 h then auto-delete.

### B7. Navigation/menu API — **DOES NOT EXIST** (report gap)
`/web/link_lists.json` returns **404** (observed in `AntiFan/reports/haravan-store-inventory.json`).
There is no Omni API navigation/menu resource. Menus must be managed in Admin or read via Liquid `linklists`.
**The report's §8 Admin inventory lists "Navigation" as merchant-manageable data but never states this API gap.**
This is a genuine capability-matrix `Limitations` entry the report is missing.

---

## C. Theme architecture / routes / settings (agent `VerifyThemeShape`)

### C1. Report §28 architecture sketch (`layouts/ templates/ sections/ snippets/ assets/ config/`) — **FALSE**
- `https://themes.haravan.com/pages/cheat-sheet`: "Loads an alternate template file from the **layout** folder of a theme."
- `https://github.com/Haravan/haravan_theme_twenty` — `layout/` singular, no `sections/`.
- Corpus `E:\Work\customizes` (30 themes): `layout/` **30/30**, `layouts/` **0/30**, `sections/` **0/30**.
**Consequence:** Haravan resolves only `layout/`. Syncing `layouts/` or `sections/` fails theme sync/packaging and the
storefront cannot render those files. The report's §28 note ("cấu trúc thực tế phải được quyết định bởi Haravan evidence")
is correct in principle but its own sketch violates it.

### C2. Canonical templates + extension — **TRUE**
Corpus 30/30 each: `index.liquid`, `product.liquid`, `collection.liquid`, `blog.liquid`, `article.liquid`,
`cart.liquid`, `search.liquid`, `404.liquid`; **JSON templates 0/30**.
`https://themes.haravan.com/pages/cheat-sheet` refers to `template == "index"` and "Within the template index.liquid".

### C3. Packaging/import workflow — **TRUE**
`https://docs.haravan.com/docs/get-started/build-theme/`: "source theme upload must be compressed with file(.ZIP)";
export via Admin → Website → Actions → Download theme file (sent to shop owner's email).

### C4. Settings source — **PARTLY TRUE**, and the corpus resolves it
Corpus (30 themes): `config/settings.html` **30/30 (100%)**;
`config/settings_schema.json` **24/30 (80%)**; both present **24/30**; `settings.html` only **6/30 (20%)**;
`settings_schema.json` only **0/30**.
So `settings.html` is the universal Haravan merchant-settings mechanism, and `settings_schema.json` is an
**additional** F1GENZ-era visual-editor layer, never a replacement.
**Correction for the Base Theme contract:** ship **both**. The loaded skill pairing ("F1GENZ → settings_schema.json,
legacy → settings.html") is a project-scoping rule, not a platform either/or.

### C5. OS 2.0 concepts (JSON templates, `{% schema %}`, blocks, presets) — **FALSE**
Corpus: JSON templates 0/30, `{% schema %}` 0/30, blocks/presets 0/30.
Cheat-sheet tag list contains no `schema` tag.
**Consequence named by the agent:** "AntiFan Core emits false 100% compliance scores on phantom OS 2.0 features,
and emitting `{% schema %}` or `.json` templates crashes storefront rendering with syntax errors."

---

## D. Consolidated verdict on the report's platform understanding

| Report section | Verdict | Required correction |
|---|---|---|
| §8 Admin inventory | INCOMPLETE | Navigation/menu has no Omni API resource (404); say so |
| §9 API/scopes | PARTLY TRUE | `web.read_contents` bundles Blog/Comment/Page/Redirect/Article; `com.read_products` bundles collections/variants/images; no per-resource scopes |
| §10 API ≠ theme runtime | TRUE | — |
| §11 Liquid object graph | TRUE | use `line_item` naming; `first_available_variant` vs `selected_or_first_available_variant` |
| §12 route map | TRUE | 8 canonical `.liquid` templates, 30/30 |
| §13 handle as primitive | TRUE | — |
| §23/§24 verification | platform-neutral | no platform claim to grade |
| §28 architecture sketch | **FALSE** | `layout/` singular; no `sections/`; no JSON templates |
| §31 conflict handling | TRUE and already needed | inventory 100-vs-200 is a live `CONFLICT` |

**Net:** the report's *direction* survives contact with primary sources; its *architecture sketch* and *scope names*
do not. Both defects are exactly the class of error the report forbids ("Không được dùng Shopify assumptions",
"Không đoán route").
