# Phase 08 — Knowledge, contract, Project Theme, quality and handoff

Status: PLANNED. This phase has two dependency stages: **08A after 00, before 05/06**; **08B after 06, before 07**. Final handoff follows successful 07 or documents its exact blocking verdict. No circular dependency: knowledge/contract does not wait for Base implementation.

## Context

Source report sections 3, 6–16, 21–22, 29–43 require more than compiler repairs. Knowledge acquisition → Wiki → cross-source mining → Base contract → Base implementation → real validation → Core integration is the required order. [plan.md](plan.md) and [adjudication](adjudication-record.md) define evidence/safety boundaries.

## 08A — Knowledge and canonical contract

### Files and ownership

Read the source report at `E:/Download/AntiFan — Final Haravan Platform Knowledge + Universal Base Theme Report.md`, existing evidence under `plans/reports/`, current documentation navigation, and actual theme examples cited by the census. Implementation owners must discover the existing wiki/docs integration before selecting output locations; do not invent a second wiki store.

Proposed machine-readable contract: `specs/base-theme-contract.json`. Existing documentation updates belong to the smallest owning surfaces. New domain pages are justified by this explicitly requested knowledge deliverable, not a fixed page-count quota.

### Steps

1. Build knowledge entries for platform topology/settings, Liquid object/filter/tag graph, routes/handles, Admin merchant workflows, API capability/scopes/errors, CLI operations/guards, data reuse/create lifecycle and storefront behavior. Every claim includes source URL/path, observed date, platform/context, evidence status, contradiction and next probe.
2. Reconcile official docs with Admin/API/CLI/source/storefront observations. Keep `UNKNOWN`/`CONFLICT`; do not promote an absent corpus feature into platform prohibition. Link evidence instead of mirroring catalog records or credentials into wiki.
3. Verify settings editor mode and round-trip create/edit/save/render. F1GENZ uses its schema/editor binding contract; do not generate `settings.html` there. Legacy HTML mode or dual mode requires its own verified contract. API resources/scopes remain distinct from theme runtime object names.
4. Mine patterns across independent source themes: recurrence, dependency footprint, accessibility, platform correctness, maintenance and data coupling. Store accepted/rejected rationale. One neutral primitive per needed behavior, not a library of brand-specific heroes.
5. Lock Base contract: routes/templates, snippet inputs/outputs, Liquid/HTML escaping, assets/dependency policy, settings IDs/types/defaults, empty/error states, data handles, semantic landmarks, extension boundaries, safe install/update path. Link each required pattern to evidence and a consumer-visible acceptance scenario.
6. Validate contract against at least representative simple and complex products, multi-option/unavailable variants, populated/empty collections, search zero results, empty/populated cart, customer/addresses, pages/blog/article and form errors. State test-data requirements before proposing writes.

### Gate

08A is complete when required domains have entries, unresolved capability decisions explicitly block dependent output, references resolve, and Base contract covers all required routes/behaviors. Compiler/Base work may not bypass unresolved settings/runtime decisions with guesses.

## 08B — Project Theme and quality

### Ownership

Base output: `themes/universal-haravan-base/` (proposed). Project output path is selected from current workspace configuration and approved staging binding, not guessed or silently replacing an existing theme. Standalone HTML capture/spec retains independent ownership and contains no Liquid/API dependency.

### Steps

1. Create the Project Theme from verified Base using the approved design/reference specification. Map each route and page section to its reference, settings, snippet, semantic data and asset owner. Preserve full-page section order and mobile behavior.
2. Inventory real store entities; reuse by verified handles/IDs. For missing semantic states propose minimal fixtures, visibility, ownership ledger and retention/cleanup decision. Obtain approval before catalog changes; unpublished theme does not isolate shared store data.
3. Implement and exercise product variants/availability/price/media, cart add/update/remove and quantity errors, collection sorting/filtering/pagination, search, navigation, blog/article/pages, customer/account/address forms and contact/newsletter validation according to verified platform capabilities. Do not create real payments/orders or expose customer data in artifacts.
4. Accessibility: keyboard navigation, focus visibility/return, dialog semantics, labels/errors, contrast, touch targets, reduced motion and carousel controls. Use existing installed test/browser capabilities; automated findings plus manual keyboard evidence. Record exact WCAG criteria checked, not blanket certification.
5. SEO: unique titles/descriptions, canonical and social metadata, heading hierarchy, indexability and structured data bound to real product/article fields. Test escaping and missing values; no fabricated aggregate ratings.
6. Performance: baseline and compare same routes/device/network settings; inspect LCP asset/font loading, CLS dimensions, interaction latency and script work. Set budgets from product constraints before gate execution; do not invent scores. Do not optimize lab scores by hiding content from measurement.
7. Core integration: expose verified Base as the default Haravan starting point through the existing project creation/compiler workflow; reuse existing input adapters. Trace callers before changes, keep standalone generation independent and existing other-platform behavior intact. No new general agent platform or abstraction layer.
8. Pass route/case/reference manifest and functional/quality receipts to phase 07. Reference changes invalidate affected captures; no scoring Project Theme against an unrelated reference version.

### Gate

Project Theme implements the approved design and complete required behavior. Functional/a11y/SEO/performance cases have actual evidence or explicit blocking verdicts. No temporary placeholder, mock commerce behavior or undeclared setting can stand for implementation.

## Verification and handoff

- Verify wiki/internal links and machine-readable schemas; cross-check commands against current package scripts/CLI help before documenting execution.
- Exercise a clean project creation from verified Base and at least one merchant settings edit through save → storefront render; prove no brand/data contamination in the Base.
- Run focused behavior tests after implementation and final full route/viewport matrix in phase 07; record what was and was not tested.
- Publish/update the requested wiki through the existing authorized integration. If access is unavailable, complete local content and link validation, record exact missing publication prerequisite; do not claim publication.
- Deliver merchant settings guide, developer extension guide, verified setup/commands, evidence locations, rollback and troubleshooting, known limitations and owners. Handoff must state actual verdict, never substitute planning completion for storefront PASS.

## Risks and rollback

Knowledge may drift, theme data is store-global, settings formats may conflict, and Base/project boundaries may leak brand assets. Mitigate with dated evidence, approved data ledger, editor-mode probes and separate outputs. Roll back only owned changes from verified backups; preserve historical evidence. No destructive remote rollback without explicit approval.
