# Evidence Addendum 05 — Phase 03 / 05 / 06 execution receipts

Date: 2026-09-12. Repo: `E:/Work/apps/AntiFan` (branch `main`, HEAD `43dcd81`).
Platform scope: Haravan only. Evidence vocabulary: `OBSERVED | VERIFIED | DERIVED | INFERRED | UNKNOWN | CONFLICT`.

Purpose: record exact commands and raw outputs for the Phase 05 clean cutover, the Phase 06 base
theme assembly, and the Phase 03 capture-identity migration, plus the pre-existing failures that
are explicitly out of scope.

---

## 1. Phase 05 — Haravan compiler clean cutover (VERIFIED)

Owner: delegated `ImplementCompilerCutover` (source only) + Main integration and adjudication.

### 1.1 Topology and construct removal (VERIFIED)

Command:

```
node scripts/compile-haravan-theme.mjs --input specs/roahtrip-html-spec/index.html \
  --settings-mode legacy-html --output build/haravan-theme
```

Output (tail): `EXIT=0`, emitted `config/settings.html`, `config/settings_data.json`,
`layout/theme.liquid`, `templates/index.liquid`, 21 `snippets/*.liquid`, 4 `assets/*`.

Independent inspection of the compiled theme:

```
fileCount 32
jsonTemplates 0 sections 0 schemaFile 0
schemaTags 0 renderTags 0 includeTags 21
configFiles config/settings.html,config/settings_data.json
layout layout/theme.liquid
templates 1
settingsHtmlHasLiquid false formFields 82
dataKeys 84
```

- Zero `templates/*.json`, zero `sections/`, zero `config/settings_schema.json` in legacy mode.
- Zero `{% schema %}`, zero `{% render %}`; 21 `{% include %}` edges.
- `config/settings.html` is pure HTML (no `{{` / `{%`), 82 form fields, and
  `settings_data.json` carries 84 keys — every declared/read setting resolves.

### 1.2 Filter legitimacy (DERIVED from corpus + linter)

Compiled output uses `img_url`, `asset_url`, `stylesheet_tag`. Corpus prevalence over the 30
theme roots in `E:/Work/customizes` (per-theme count, node walk):

```
themesScanned 31
img_url -> 31   asset_url -> 31   stylesheet_tag -> 17   script_tag -> 29
image_url -> 11  product.media -> 14  first_available_variant -> 25
settings. -> 31  linklists -> 30
```

None of the emitted filters are on the linter's Haravan-forbidden list
(`reject, where, concat, at_most, at_least, image_url`).

### 1.3 Linter (independent verification)

```
node scripts/lint-haravan-theme.mjs --theme build/haravan-theme --settings-mode legacy
=> [lint-haravan-theme] clean: 0 violations in build/haravan-theme   (exit 0)

node scripts/lint-haravan-theme.mjs --theme build/haravan-theme --settings-mode f1genz
=> config/settings_schema.json:1 SETTINGS_SCHEMA_MISSING
   config/settings.html:1 HARAVAN_SETTINGS_HTML_FORBIDDEN
   config/settings_schema.json:1 HARAVAN_SETTINGS_SCHEMA_MISSING
   [lint-haravan-theme] FAILED with 3 violation(s)   (exit 1)
```

The second run is the mode-mismatch probe: claiming `f1genz` against a legacy output fails closed.

### 1.4 Settings mode fail-closed (VERIFIED)

```
node scripts/compile-haravan-theme.mjs --input specs/roahtrip-html-spec/index.html \
  --settings-mode dual --output .tmp-should-not-exist
=> [Haravan Compiler Error] Unsupported settings mode: "dual".
   Haravan supports only "legacy-html" or "f1genz-schema". Dual mode is strictly unsupported.
   DUAL_EXIT=1        (no output directory created)

node scripts/compile-haravan-theme.mjs --input specs/roahtrip-html-spec/index.html \
  --settings-mode f1genz-schema --output build/haravan-theme-f1genz
=> success; config/ contains settings_data.json + settings_schema.json only (no settings.html)
```

### 1.5 Defects found during integration and fixed by Main (VERIFIED)

The delegated cutover shipped nine red tests. Adjudication separated three classes:

1. **Real source defects (fixed in source).**
   - *Silent omission / re-typing of declared settings.* `buildGroupsFromIR` never consumed
     non-color `ir.themeSettings`; a declared `text` setting whose id contained `banner` was
     additionally re-typed as a file upload, so `settings.html` carried
     `name="custom_banner_heading.png"` instead of `name="custom_banner_heading"`. Fix: honor the
     authored IR type/label/default in both modes (`haravan-legacy-settings-generator.ts` new
     "Declared Theme Settings" group + `LEGACY_CONTROL_TYPE_BY_DECLARED_TYPE`;
     `haravan-schema-generator.ts` new "Declared Theme Settings" group), and drop the bare
     `banner` substring from both remaining id heuristics.
   - *Unescaped / missing default in `settings.html`.* Covered by the same omission fix; the
     escaping path (`escapeHtmlAttribute`) now carries declared defaults, verified by test 6.
   - *Missing schema validation rules.* `validateSettingsSchema` accepted `presets` / `blocks`
     (Shopify section constructs) and did not reject inverted range bounds. Fix: reject both
     constructs and require numeric `min < max` for `range`/`number`.
   - *Silent type degradation for aliases.* `sanitizeSettingType` mapped `toggle` and
     `font`/`font_family` to `text`. Fix: `toggle|boolean|switch -> checkbox`,
     `font|font_family|typeface -> font_picker`.
   - *Unstable error class.* Dual/unknown mode threw without a matchable prefix. Fix: all three
     throws in `createHaravanTargetContract` now start with
     `Haravan target contract violation:`.

2. **Test assertions inconsistent with the implementation's own API/contract text (corrected in
   tests, behavior unchanged):** `sanitizeSettingType` returns `{ type, transformedProps? }` (the
   test asserted a bare string); duplicate-id and missing-field message substrings.

3. **No weakening:** no test was deleted, skipped, or loosened in intent; every corrected
   assertion still bounds the same observable contract, and the two removed validation gaps were
   closed in source rather than asserted away.

### 1.6 Verification runs (all green)

| Command | Result |
| --- | --- |
| `npx tsc -p packages/site-clone --noEmit` | exit 0, no diagnostics |
| `npm run build:site-clone` | exit 0 |
| `node --test packages/site-clone/dist/**/*.test.js` | **359 tests / 359 pass / 0 fail** (97 suites) |
| `node --test packages/site-clone/dist/generators/{haravan-schema-generator,theme-compiler}.test.js` | 21 / 21 pass |
| `node --test packages/site-clone/dist/generators/independent-html-clone-generator.test.js` | 10 / 10 pass |
| `npx tsc -p ./ --pretty false` | exit 0, no diagnostics |
| `node --test test/unit/theme-checks.test.mjs test/unit/lint-haravan-theme.test.mjs` | 33 / 33 pass |
| `node --test test/unit/lint-haravan-theme.test.mjs` | 5 / 5 pass (incl. legacy copy without `settings_schema.json` accepted; base theme clean; missing dir exit 2) |
| `npm run compile` (full pipeline) | exit 0 |

Requirement traceability (phase-05 file):

- Flat topology + snippet composition — §1.1.
- No Shopify section-schema/preset output; DoD criteria replaced by topology/include/settings
  checks — §1.1 + the two new validator rules in §1.5.
- Explicit single settings mode; **no unconditional schema requirement for legacy mode** — §1.3
  (legacy lint clean with no `config/settings_schema.json`), §1.4, and
  `scripts/lib/theme-checks.mjs` accepts `options.schemaRequired`, passed as `!legacyOnlyMode` by
  `scripts/lint-haravan-theme.mjs:82` and
  `!(platform === 'haravan' && settingsHtml && !settingsSchema)` by `scripts/theme-checks.mjs:57`.
- Full merchant settings contract from IR incl. escaping/stable ids/types/defaults — §1.1 counts,
  §1.5, tests 5 and 6.
- Historical artifacts untouched — `themes/roahtrip-haravan/` still present, unmodified;
  new output goes to `build/haravan-theme/` (`build/` is untracked).
- Standalone HTML unaffected — `independent-html-clone-generator.ts` carries no platform
  dependency (only strips `liquidTemplate` artifacts); 10/10 suite pass.

---

## 2. Phase 06 — Universal base theme (VERIFIED)

```
node scripts/lint-haravan-theme.mjs --theme themes/universal-haravan-base
=> [lint-haravan-theme] clean: 0 violations   (exit 0)
```

Main-run audit of the same tree: `{schema:0, render:0, filters:0, json:0, sections:0, media:0,
cdn(hoplong):0}`; 22 `{% include %}` edges, 0 unresolved. Settings parity: 39 declared ids, all 39
present as `settings.html` form fields and in `settings_data.json`, 0 default mismatches, 0
undeclared form fields, 0 read-but-undeclared ids (31 read ⊆ 39 declared).

Linter probe in an unrelated temp theme (proves the rules are not vacuous): exit 1 catching
`SETTINGS_SCHEMA_MISSING`, `HARAVAN_FORBIDDEN_SECTION`, `HARAVAN_FORBIDDEN_SCHEMA`,
`HARAVAN_FORBIDDEN_RENDER`, `HARAVAN_INCLUDE_TARGET_MISSING`, `HARAVAN_FORBIDDEN_FILTER`.

---

## 3. Phase 03 — capture identity (VERIFIED)

- Preview token migrated to `?themeid=<id>` across `scripts/verify-storefront-chromium.mjs`,
  `-direct.mjs`, `verify-storefront-routes.mjs`, `test-single-visual-compare.mjs`,
  `reports/15-page-data-mapping.json` (verified: `themeid: 15`, `preview_theme_id: 0`).
- Status ladder `ERROR → VIEWPORT_NOT_APPLIED → FAIL → DEGRADED → VERIFIED_PASS` plus
  `DEGENERATE_VIEWPORT`; `dod-validator.ts` `haravanPreview` criterion passes on `themeid`.
- Capture scripts isolated per run: output goes to `reports/runs/<run-${crypto.randomUUID()}>/`,
  the frozen `reports/chromium-verification/chromium-45-cases-results.json` is never overwritten,
  totals derive from `results.length`, and the unconditional "Zero Hoplong Leaks" claim is
  replaced by a derived 3-state tally (`hoplongLeakCases`).
- `node --check` PARSE_OK on all capture scripts; canary theme-fidelity 15/15; site-clone 365/365
  at that point; zero leftover `preview_theme_id` outside the intentional diagnostic in
  `scripts/probe-theme-identity.mjs`.

---

## 4. Pre-existing failures explicitly out of scope (VERIFIED, not regressions)

`node --test test/unit/*.test.mjs` in the working tree: **213 tests, 207 pass, 6 fail**.

Baseline proof: a detached worktree of pristine HEAD `43dcd81`
(`git worktree add E:/Work/.tmp-head-check HEAD --detach`, since removed) reproduces the failure
identically:

```
cd E:/Work/.tmp-head-check && node --test test/unit/build-report-next-action.test.mjs
=> 2 tests, 0 pass, 2 fail
   report generation failed: referenced artifact missing:
   test/fixtures/canary-run/evidence.viewportRuns[0].standalone.clone
   (id=artifact-3bcedf33-c45d-424d-9b78-f5b9e2c61a50) — tried:
   .antifan-data/control-plane-v2/artifacts/artifact-3bcedf33-…, …png, run-45fa6a36-…/…
```

Root cause: `scripts/lib/build-report.mjs` is unmodified versus HEAD
(`git diff --quiet HEAD -- scripts/lib/build-report.mjs` → clean) and resolves artifact ids against
a local canary artifact store that does not exist in this working tree
(`.antifan-data/control-plane-v2/artifacts/` absent; `.antifan-data` is not gitignored). The
six failures are therefore environment-dependent canary tests, not cutover regressions:

- `build-report-next-action.test.mjs` — 2 (reproduced at HEAD).
- `build-report-bundle-ordering.test.mjs` — 2 (identical missing-artifact error; local
  `.canary/state/report-ordering-*/` evidence absent).
- `build-report-embedded-drift.test.mjs` — 1 (same builder, same store).
- `antifan-mcp-client.test.mjs` — 1 (`MCP_BRIDGE_OFFLINE`: needs a live AntiFan Desktop bridge
  attachment; also environment-dependent).

No phase-05/06 deliverable depends on these six tests.

---

## 5. Standing blockers

- **Phase 00 live Admin attestation** — mounted browser tools denied; current Admin theme-role
  inventory unverifiable. No credential-extraction workaround. Unchanged by this addendum.
- **Phase 07 identity attestation** — expected `INCONCLUSIVE` seal unless `/web/themes/{id}.json`
  can be observed live for theme `1001512581` (role `unpublished`).
