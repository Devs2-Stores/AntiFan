# Ultra review evidence packet — Haravan base-theme correction batch

Controller: Main session. Scope frozen before dispatch; identical packet goes to all five candidates.

## 1. Requested change (source of truth)

User-visible requests, in order, all in this session:

1. Advisory-driven correction of `themes/universal-haravan-base/` after the shipped commit `4fb1330`:
   - swatch must not silently reset another option dimension when a value is clicked;
   - `/collections` must be served by its real Haravan template, not the single-collection template;
   - the newsletter must use the corpus-standard form mechanism;
   - orphan/weightless files and settings must go;
   - every doc/contract claim must describe only what the code does (no unmeasured claims).
2. Second advisory round: pass 1 of the swatch target selection must not require availability (a sold-out cross-option combination is linked and labelled, never replaced by another value); CHANGELOG wording must state only measured facts; contract scenario text must match the shipped behaviour.
3. Standing constraints: Haravan only (no Shopify assumptions); evidence vocabulary `OBSERVED | VERIFIED | DERIVED | INFERRED | UNKNOWN | CONFLICT`; never upgrade confidence; corpus findings labelled "observed practice (N/45)"; no writes to `E:/Work/customizes/**` or `E:/Work/themes/**`; never publish or push a theme to Haravan; no `as any`/`: any`; never weaken or delete tests to get green.

## 2. Scope under review

| Anchor | Value |
|---|---|
| Base commit | `4fb1330` (already reviewed in a previous round) |
| Committed range | `4fb1330..999b86a` — `54bfa9c`, `7509727`, `999b86a` |
| Pending (unstaged) diff | `docs/haravan/base-theme-contract.md`, `specs/base-theme-contract.json` |
| Primary artifacts | `themes/universal-haravan-base/snippets/swatch.liquid`, `themes/universal-haravan-base/templates/list-collections.liquid`, `themes/universal-haravan-base/snippets/footer.liquid`, `themes/universal-haravan-base/templates/404.liquid`, `plans/reports/_render-base-theme.mjs`, `specs/base-theme-contract.json`, `docs/haravan/base-theme-contract.md`, `docs/haravan/routes-and-handles.md`, `CHANGELOG.md` |

Commands to reproduce the diff:

```
git diff 4fb1330..999b86a
git diff                       # pending
```

## 3. Contract of the changed behaviour (as shipped)

- **swatch.liquid** — zero-JS navigation. For each distinct value of one option, the target variant is resolved in three passes against `product.selected_or_first_available_variant`:
  1. the variant whose other option indexes equal the rendered variant's (**no availability test**);
  2. any available variant carrying the value;
  3. any variant carrying the value.
  The anchor is `{{ product.url }}?variant={{ target_id }}`; the chip is `is-active` + `aria-current="true"` for the rendered value, `is-unavailable` + `title="… (Hết hàng)"` when the target is unavailable. Distinct values are deduplicated with a `'|value|'` accumulator. No `{% break %}` is used.
- **templates/list-collections.liquid** — serves `/collections`; `{% paginate collections by 12 %}` over `{% include 'collection-card' %}`, empty state when `collections.size == 0`.
- **snippets/footer.liquid** — newsletter is `{% form 'customer' %}` + hidden `contact[tags]=newsletter` + `contact[email]`, rendering `form.posted_successfully?` / `form.errors`.
- **templates/404.liquid** — GET search form (`action="/search"`, `type=product`, `name=q`, no prefilled value), plus a `/collections/all` CTA.
- **Removed** — `snippets/product-grid.liquid` and setting `product_grid_columns` (its only reader); `settings.html` / `settings_data.json` / `settings_schema.json` remain 38/38/38 identical in id set.
- **plans/reports/_render-base-theme.mjs** — committed evidence harness. Loads LiquidJS from the Haravan CLI checkout (same convention as `plans/reports/_render-home.mjs`), stubs `{% form %}` and `{% paginate %}`, renders the real `swatch.liquid` / `list-collections.liquid` sources, and asserts 19 checks.

## 4. Verification already run by the controller (reproduce, do not trust)

| Command | Observed |
|---|---|
| `node plans/reports/_render-base-theme.mjs` | `19/19 checks passed` |
| `node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base --settings-mode auto` | `clean: 0 violations` |
| `node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base --settings-mode legacy` | `clean: 0 violations` |
| `node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base --settings-mode f1genz` | 1 violation: `config/settings.html` present while the schema is live (pre-existing dual emission at `4fb1330`, recorded as `UNRESOLVED_01`) |
| `node --test test/unit/theme-checks.test.mjs test/unit/lint-haravan-theme.test.mjs` | `pass 47 / fail 0` |
| `npm run test:fast` | `tests 491 / pass 491 / fail 0` |
| `npm run compile` | extension bundled, 185 051 bytes, exit 0 |
| settings parity script over the three config surfaces | schema 38 = data 38 = html controls 38, no id in one surface only, `product_grid_columns` absent everywhere |
| contract consistency script | declared paths all exist, no undeclared file in `templates|snippets|assets`, 16 snippet detail entries = 16 declared snippets, 13 scenarios, 6 unresolved |
| live storefront probe (`GET https://phukienmaymoc.com/collections`) | HTTP 200, container class `template-list-collections` |
| corpus census (45 Haravan roots, 8 102 files) | `templates/list-collections.liquid` 41/45; `templates/collections.liquid` 0/45; `{% form 'customer' %}` 79 files / 40 roots; raw POST `/account/contact` 2 files, `/contact` 12 files |

## 5. Rubric (score each 1–20)

1. **Liquid correctness** — DotLiquid semantics available on Haravan (no `{% render %}`, no `{% schema %}`, no `where`/`concat`/`reject`/`image_url` tag, `include` only), scoping of loop variables, filter arity, and whether the three-pass selection actually produces the claimed result for every option count (1 and 2+ dimensions) and availability combination.
2. **Regression risk** — what existing behaviour could break: other templates/snippets that read the removed setting or snippet, the paginate/include interaction on `/collections`, the settings-parity invariant across the three config surfaces, and the harness's own assertions.
3. **Evidence integrity** — every claim in `specs/base-theme-contract.json`, `docs/haravan/base-theme-contract.md`, `docs/haravan/routes-and-handles.md`, `CHANGELOG.md` must match the code as shipped and the measurements above; flag any claim that is unmeasured, overstated, or that the diffs themselves falsify, including counts, `N/45` figures, and reproduced line references.
4. **Harness quality** — is `plans/reports/_render-base-theme.mjs` a genuine verification of the Liquid, or does it assert its own stubs harness shadow (e.g. stub `form`/`paginate` semantics diverging from Haravan, fixtures that cannot fail, missing boundary cases)? Would a plausible bug pass it?
5. **Accessibility and platform safety** — `role="group"` / `aria-label` / `aria-current` / `title` labelling, whether `is-unavailable` anchors are honest affordances, and whether anything in the diff could push to or mutate a live theme/store.

Hard constraints: platform is Haravan; no write to the two read-only reference roots; no theme push; no test weakening; evidence vocabulary respected.

## 6. Output contract for each candidate

Return a complete Stage 2 quality review: findings with `file:line`, severity (Critical / Important / Minor / Nit), the concrete failure or measurement, and a minimal fix. State explicitly which rubric criteria you could not verify and why. Do not write files. Do not read other candidates' output.
