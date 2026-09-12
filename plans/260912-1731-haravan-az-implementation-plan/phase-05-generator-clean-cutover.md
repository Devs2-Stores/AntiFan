# Phase 05 — Haravan compiler clean cutover

Status: PLANNED. Depends on: 04, 08A.

## Context

The inspected compiler emits `templates/index.json`, `sections/*.liquid` and section schema blocks; its DoD validator enforces that output. The Haravan output must instead implement the verified Phase 08A capability contract. Existing `themes/roahtrip-haravan/` is historical evidence, not an approved overwrite target.

## Requirements

- Emit singular `layout/`, flat Liquid templates and reusable snippets. Preserve semantic section order, layout hooks, data binding, asset localization and required interactions; changing paths alone is insufficient.
- Remove Shopify section-schema/preset output from the Haravan pipeline and replace its DoD criteria with actual topology, include connectivity, runtime capability and settings checks. Do not claim complete platform compliance from substring absence.
- Settings mode is explicit and verified, never guessed: legacy HTML mode validates settings.html and its data contract; F1GENZ schema mode emits settings_schema.json and no settings.html; dual mode only when 08A proves round-trip precedence. No unconditional schema requirement for legacy mode and no default-to-dual escape hatch.
- Generate the full merchant settings contract from actual IR inputs, including escaping, stable IDs, types and defaults. Do not substitute a handful of hotline/color fields for all section settings.
- Additional directories such as locales are governed by 08A capability and localization requirements; do not introduce them by habit or ban them solely from corpus frequency.
- Standalone HTML remains HTML/CSS/JS without platform dependencies. Existing Shopify/Sapo shared modules are preserved. Output is deployable without mandatory AntiFan runtime services.
- Keep historical artifacts untouched; compile to a separately approved output directory. No automatic move, quarantine or delete.

## Files and steps

1. Read `packages/site-clone/src/generators/theme-compiler.ts`, `haravan-section-generator.ts`, `haravan-schema-generator.ts`, `haravan-layout-generator.ts`, `liquid-binding-engine.ts`, `packages/site-clone/src/qa/dod-validator.ts`, package exports and `scripts/compile-haravan-theme.mjs`. Follow LSP references for changed exported types/methods and criteria keys before editing.
2. Trace every compile entry path, including localization and IR generation, so none retains OS2 output. Preserve existing assets/controllers/data bindings where valid; remove obsolete Haravan section-schema generation and its callers together.
3. Emit templates composed from snippets with safe identifiers and resolved includes. Bind each former setting to the selected merchant settings model without collisions or silent omissions. Validate missing/null data, escaping, unavailable products and optional modules.
4. Propagate a typed validated target contract through compiler, generators and validator. Do not use `as any`, hidden mutable current-mode fields or unverified overloads to carry settings mode.
5. Update all consumers of removed DoD criteria, package descriptions, runner output and existing test contracts. Keep declarations and API migrations consistent; use LSP rename when appropriate.
6. Run actual compiler on an available approved HTML/IR input into a new output location. Verify the input exists first; absent source blocks that particular reproduction, not permission to invent it. Keep historical output unchanged.

## Verification

Run focused compiler/generator/DoD suites after the complete cutover. Exercise each supported settings mode, absent/unknown mode, duplicate IDs, unresolved includes, markup escaping and dynamic bindings. Compile via actual public entry points, including localization if retained, then inspect generated graph and render through the approved Haravan preview in phase 07. Static success alone does not prove Admin settings or storefront functionality.

Prove standalone HTML is unaffected and existing shared-platform classification/mapping remains functional. All required generated files and setting references must resolve under the same 08A contract used by Base Theme validation.

## Risks and rollback

Settings conversion can silently lose merchant control; preserve semantic mapping and test round trips rather than filename presence. Historical evidence and user work are not disposable. Rollback only owned source/output changes from verified backups; destructive removal or remote operations require approval. Do not reintroduce false certification as a workaround.
