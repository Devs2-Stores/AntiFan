---
title: "Haravan Customize Theme Fidelity Gate"
description: "Verify the customize workflow on the real Haravan theme copy: serve the local source through `hrv theme dev`, render the real storefront pages, and adjudicate each surface against a reference that is pinned before the dev session mutates anything — with strict compare, mandatory reference identity, Liquid/structural checks and a safety audit that proves nothing touched the live theme."
status: blocked
priority: P0
effort: "10h"
tags: [haravan, liquid, theme, visual-fidelity, customize-workflow, evidence-integrity]
created: 2026-09-11
blockedBy: ["260910-2008-clone-campaign-evidence-provenance"]
blocks: []
---

# Haravan Customize Theme Fidelity Gate

## Outcome Contract

For each of seven storefront surfaces — home, product, collection, article, cart, search,
404 — the customize workflow produces an adjudicable verdict: `PASS`, or `FAIL` with a
deterministic cause, or `INCONCLUSIVE` with the cause named. Each verdict is bound to the
theme it was measured on (store, `theme_id`, theme revision digest), the local source it
was measured from (working-tree digest), the browser instance and attempt that produced
it, and — mandatorily — the **identity of the reference it was compared against**, pinned
before the dev session could change it. A reference that moves by itself can never yield
`PASS`; it yields `INCONCLUSIVE`.

This plan does not promise `PASS`. It promises that a reported number is a measurement of
the customize workflow on the real theme, and that a refusal says why.

## What is measured, and against what

The subject is the **local theme source** in `E:\Work\customizes\Phukienmaymoc`, served by
`hrv theme dev` onto the theme copy `theme_id 1001512581` (`org_id 200001207485`,
`theme_name "Bản sao chép của clothing"`, read from `.haravan-cli_local.json`).

Two references are pinned **before** the dev session uploads anything, because
`hrv theme dev` writes the local source onto that same copy:

| Reference | Source | Answers |
|---|---|---|
| R1 — deployed copy | `https://phukienmaymoc.com/?themeid=1001512581&view=…`, captured read-only | "does my working tree still render like what is deployed on the copy?" |
| R2 — live production | `https://phukienmaymoc.com/?themeid=-1&view=…`, captured read-only | "will this customize look like production?" |

R1 is destroyed by the dev upload the moment it starts; capturing it first is what makes
the copy usable as a reference at all. Capturing both is cheap and neither mutates
anything. Each verdict names which reference it used and carries that reference's pinned
identity.

No synthetic substitute, no screenshot editing, no image construction of any kind.

## Measured facts this plan starts from

| # | Fact | Evidence |
|---|---|---|
| 1 | `hrv` is installed and on PATH; `@haravan/cli@1.1.3` plus a local `@f1genz/haravan-cli@1.2.0` link and `devs2-haravan-studio` are present. Nothing needs installing. | `which hrv` → `C:\Users\Admin\AppData\Roaming\npm\hrv.cmd`; `npm ls -g --depth=0` |
| 2 | The theme workspace is CLI-linked to the copy, not to live: `{org_id: 200001207485, theme_id: 1001512581, theme_name: "Bản sao chép của clothing"}`. `.workspace-context.json` reads `{platform: haravan, role: customize-intake, verification: verified}`. | `E:\Work\customizes\Phukienmaymoc\.haravan-cli_local.json`, `.workspace-context.json` |
| 3 | The seven surfaces exist as templates, and the workspace carries custom ones that no route maps to: `404.liquid`, `article.liquid`, `blog.liquid`, `cart.liquid`, `collection.liquid`, plus `collection.brand.liquid`, `collection.index-tab*.liquid`, `collection.slide-data.liquid`, `blog.index-data.liquid`. Custom surfaces therefore need `?view=` rather than a route. | `E:\Work\customizes\Phukienmaymoc\templates\` |
| 4 | The storefront's own reference is not deterministic across loads, which is why reference identity is mandatory here and not a nicety: the same URL measured `5546px` at 1024 in one run and `5426px` in the next, and `3166px` against `4481px` at 390, while the artifact under test held its height. | campaign evidence: `page-01-home` attempts `f4389bc7…` (`docHeight {reference: 5426, clone: 5546, delta: 120}`) against `b0768cae…` (`5546/5546`) |
| 5 | The measurement harness already exists and already enforces what this plan requires: strict compare with `allowHeightDrift:false`, `useDefaultWidgetMasks:false` and no user masks; viewport-geometry symmetry; pre- and post-compare motion proofs; bundle/reference identity gates; provenance-bound verdicts. This plan reuses them rather than writing a second pipeline. | `.canary/tools/viewport-run.mjs`, `.canary/tools/canary-settle.mjs`, `scripts/lib/evidence-provenance.mjs`, `scripts/lib/bundle-integrity.mjs` |
| 6 | **The platform silently falls back to live production.** `https://phukienmaymoc.com/?themeid=999999` answers **HTTP 200** and serves assets under `cdn.hstatic.net/themes/200001207485/1001510509` — the live theme. An unknown `view` likewise answers 200 and renders the parent template (88 copy-theme asset references). A capture must therefore assert the theme it was actually served, not the theme it requested. | `curl` on the storefront, 2026-09-11 |
| 7 | The copy preview is anonymously reachable and scoped as intended: `?themeid=1001512581` answers 200 with every asset under `…/200001207485/1001512581`. | idem |

## Constraints (hard)

- **Never publish, never push to the live theme, never touch the live theme's content.**
  The live theme is `1001510509`, discovered by probing an invalid `themeid` (see fact 6);
  it is a read-only reference: reads are expected (the reference capture resolves `themeid=-1`
  to it and its assets are probed for comparison), and no write may address it. The only
  permitted remote write is `hrv theme dev` onto `theme_id 1001512581`. Any command whose
  resolved theme id is not `1001512581` is refused before it runs, and the refusal is recorded. Because the
  platform answers HTTP 200 while silently serving a *different* theme, every capture also
  asserts the theme it was actually served (`cdn.hstatic.net/themes/<org>/<themeid>/`) and
  refuses when that id does not match the one it requested.
- **`hrv theme push` onto `1001512581` — explicitly granted, recorded out-of-band.** The batch
  pushes of 2026-09-11 (`push.log`, `push-force.log`) and the asset repair push (`push-assets.log`,
  `hrv theme push --only "assets/**" --force -n`, 336 files, 0 errors) ran against the copy only,
  under the owner's explicit grant in that session rather than the `hrv theme dev` write this plan
  first authorised. The upload is repair work for the copy's missing asset store, not a fidelity
  step: it never appears in the run's `commands.jsonl`, the driver's safety audit still reports
  `publishDeployPush.absent: true` and `foreignThemeIds.count 0`, and the guards refuse on any theme
  id other than `1001512581`.
- Writes outside this repository are confined to `E:\Work\customizes\Phukienmaymoc` and the
  CLI's own cache/backup (`.haravan-cli_backup/`). The owner granted exactly this scope for
  this work; nothing else outside the repo is written.
- Do not increase timeouts, weaken fidelity assertions, reduce tolerance, add masks, or add
  auto-drain-and-retry. `useDefaultWidgetMasks:false`, `allowHeightDrift:false` and the
  strict compare parameters are mandatory and unchanged.
- **Reference identity is mandatory.** A verdict may only be published against a reference
  whose identity was pinned before any mutation and re-measured consistently; a reference
  that changed on its own yields `INCONCLUSIVE`, never `PASS`.
- Liquid errors must never pass silently: a rendered page containing `Liquid error`,
  `Liquid Exception`, an unrendered `{{ … }}`/`{% … %}` in text position, or a
  schema/settings binding failure is a refusal, not a hidden PASS.
- Tab economy stays exact: the run closes every tab it opens, and the instance-plane
  tab census before and after is equal.
- Verdicts without provenance are unpublishable. Provenance means store, theme id, theme
  revision digest, local source digest, instance pid, run/attempt ids, both sides'
  measured geometry, and the pinned reference identity.
- Do not re-architect the clone generator, the harness or the comparator. This plan adds a
  target (a Haravan theme preview) and a set of checks, nothing structural.

## Non-Goals

- **Not** measuring clone quality and **not** regenerating a clone. The `site-clone`
  independent-HTML campaign is a different acceptance (`260910-2008`); this plan measures
  the customize workflow on a real theme.
- Not publishing the theme, not deploying, not creating themes, not changing store
  settings, not migrating content.
- Not claiming the acceptance of any other plan; this one delivers its own evidence and
  states its own limitations.
- Not covering authenticated surfaces (`customers[account]`, addresses, order history)
  unless a test account is explicitly provided. Those are typed refusals if unsupplied.

## Phases

| # | Phase | Status | Effort |
|---|-------|--------|--------|
| 1 | [Theme Serve, Page Inventory & Reference Pinning](./phase-01-theme-serve-and-reference-pinning.md) | Pending | 4h |
| 2 | [Liquid & Structural Checks](./phase-02-liquid-and-structural-checks.md) | Pending | 3h |
| 3 | [Verdicts, Provenance & Safety Audit](./phase-03-verdicts-provenance-and-safety-audit.md) | Pending | 3h |

Phase 1 must finish before Phase 2 can be trusted: without pinned references and a proven
serve path, any number Phase 2 produces is un-attributable.

## Ordering against the campaign plan

This plan sits **behind** `260910-2008-clone-campaign-evidence-provenance` (its
`blockedBy`), so the customize work cannot consume the instance, the lock or the evidence
root while that campaign is still producing its own verdicts. It also touches neither
`.canary/15-pages/**` nor `packages/site-clone/**`, so it cannot perturb the campaign's
measurement path: its own state lives under `.canary/theme-fidelity/`.

## Success Criteria

- [ ] Seven surfaces have an adjudicable verdict, or a typed refusal naming the reason
      (route absent, auth required, `?view=` not resolvable).
- [ ] Every verdict carries provenance: store, `theme_id`, theme revision digest, local
      source digest, instance/run/attempt ids, both sides' geometry, and the pinned
      reference identity it was compared against.
- [ ] A reference that changes between its pinning and its use yields `INCONCLUSIVE`,
      never `PASS` — demonstrated, not asserted.
- [ ] `Liquid error`/`Liquid Exception`/unrendered tags, section schema validity, settings
      binding and referenced-asset existence are checked on every captured surface, and a
      failure is a refusal rather than a PASS.
- [ ] A safety audit proves no write reached anything but `theme_id 1001512581`: the
      command log carries a resolved theme id per command, and the audit reports zero
      commands targeting any other theme.
- [ ] Strict compare parameters and reference-identity enforcement are intact after the
      change (asserted by test, not by inspection).
- [ ] The instance-plane and session-plane tab censuses are equal before and after, and the
      run closes every tab it opened.

## Open Decisions

1. **Does the copy survive as a reference?** `hrv theme dev` overwrites the copy with the
   local source, so R1 is only usable if captured first (this plan's approach) or if the dev
   session targets a *separate* theme copy. Recommended: capture R1 first and keep the
   current copy as the dev target, as the owner authorised. A second copy would make R1
   durable across runs and is the better long-term shape; it needs a separate write
   approval because it creates a theme.
2. **Cart and search need state to be meaningful.** An empty cart renders an empty-cart
   page, which is still a real surface, but its fidelity signal is weak; adding an item is a
   store mutation. Recommended: measure the empty-cart surface, and treat a populated cart
   as an owner-run variant that is never automated.
3. **Search needs a query.** Recommended: a fixed, documented query per run, recorded in
   the verdict, so two runs are comparable.
4. **Mobile tier.** The campaign measured 1440 and 1024 as the useful desktop widths and
   390 as the phone tier. Recommended: the same three, per surface, unless effort forces
   the phone tier to be a separate pass.

## Risks

| Risk | Mitigation |
|---|---|
| The dev upload overwrites the reference mid-run | Both references are captured before the first dev write, and their identities are re-measured at use time; a change yields `INCONCLUSIVE` |
| A mistaken command reaches the live theme | Every command's resolved theme id is checked against `1001512581` before it runs, and the safety audit reports the resolved ids |
| `hrv theme dev` holds a long-lived process | It runs as a supervised process with a readiness signal, not as a foreground call, and is stopped through the process manager |
| Authenticated pages cannot be measured | Typed refusal; no credential guessing, no store account mutation |
| Reference instability produces misleading verdicts | Reference identity is mandatory and `INCONCLUSIVE` wins over `PASS` by construction |
| The instance degrades across many surfaces | Restart and re-mint on the proven procedure between batches; the harness already records instance identity per verdict |

## Status — 2026-09-11 (run `.canary/theme-fidelity-run4`)

The blocker this plan names is closed, and the run is still not publishable — both for reasons the
outcome contract allows. Full evidence: `plans/reports/260911-1310-theme-fidelity-run4-verdicts.md`.

| Item | State |
|---|---|
| Copy serves the local `assets/**` | fixed — the CLI's `collectThemePushAssetKeys` excluded `assets/` by construction; repaired to opt in through `--only`, rebuilt (51/51 tests), and 336 assets uploaded out-of-band (`push-assets.log`: `336 đã push, 0 lỗi, 0 bỏ qua`); `hl-global.css` went 404 → 200 carrying the layout utilities |
| Subject capture | `COMPLETE` 21/21 (was 14/21); heights, header and nav identical to the live reference on all 21 legs |
| Compare | 42 verdict documents: 1 PASS, 40 INCONCLUSIVE, 1 `EXECUTION_TIMEOUT`; both sets `INCOMPLETE` because 28 pairs are `content-changed-between-passes` — an in-place visible-text swap (only `textHash`/`textLength` move; geometry, image set and counts identical) that the campaign's doctrine refuses to mask |
| Report | `INCOMPLETE`, `current.json` withheld; the predicate (`theme-fidelity-run.mjs:1933-1944`) fails only on the two compare sets, so compare measurability is the single publication gate. The 7 inventory `UNRESOLVED_SURFACE` entries appear in `notMeasured` but do not gate publication |
| Safety audit | 12 commands, `foreignThemeIds 0`, `publishDeployPush absent`; the out-of-band push is outside the pipeline's command record by design |

`status` stays `blocked`: nothing publishes until the widget-carriage class and the inventory scope
are decided by the owner.

