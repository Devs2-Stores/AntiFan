---
phase: 2
title: "Liquid & Structural Checks"
status: complete
priority: P0
effort: "3h"
dependencies: ["phase-01-theme-serve-and-reference-pinning"]
---

# Phase 2: Liquid & Structural Checks

## Overview

Two independent classes of defect must be caught before any pixel number is allowed to mean
anything: the theme's Liquid must have rendered (not errored, not half-rendered), and its
declared structure must match what the templates and settings actually provide. A pixel
comparison over a page that silently contains `Liquid error` is worse than no comparison,
because it publishes a number that looks like fidelity.

This phase adds those checks to the existing strict comparison path. It does not change the
comparator, the masks policy, the tolerance, or any settle behaviour.

## Requirements

### R1 — Render-failure checks on every captured surface

For each captured document, both sides:

- no `Liquid error`, `Liquid Exception`, `Liquid syntax error` in text position;
- no unrendered `{{ … }}` or `{% … %}` in text position (a literal in an attribute or a
  `{{ }}`-shaped string inside `<script>`/`<style>` is not a render failure and must not be
  reported as one — the check distinguishes text position from data position);
- no framework error banner in the DOM (a rendered error page is a refusal, whatever its
  status code);
- the capture is not an error document: the page's structural counts must be non-trivial per
  the surface's floor, measured the way the campaign already measures floors.

### R2 — Schema validity

- `config/settings_schema.json` parses and is a valid schema document for the platform.
- Every section file that the templates include declares a schema block that parses.
- A section referenced by a template exists; a missing section is a refusal naming both.

### R3 — Settings binding

- Every `settings.<id>` read in the templates resolves to an id declared in
  `settings_schema.json`.
- Every declared setting that the templates never read is reported (dead setting), and every
  setting read but not declared is a failure. The distinction is recorded per verdict, not
  collapsed into a boolean.

### R4 — Referenced assets exist

- Every local asset referenced by Liquid (`asset_url`, `'file' | asset_url`, direct
  `/assets/…` paths) exists in the theme or resolves to a remote origin.
- A missing local asset is a failure; a remote asset is recorded with its origin so an
  external dependency is visible rather than assumed.

### R5 — Unchanged measurement contract

The pixel comparison continues to run with `useDefaultWidgetMasks:false`,
`allowHeightDrift:false`, no user masks, unchanged tolerance, no retries, and with the
settle, geometry, motion and reference-identity gates the campaign already enforces.

## Implementation Steps

1. Implement the render-failure scan as one pass over the captured DOM, shared by both
   sides, returning a structured record (rule, count, first example with its selector).
2. Implement the schema and settings-binding checks as an offline static pass over the
   theme source, so they run without a browser and can be run alone.
3. Implement the asset-existence check over the same source, classifying each reference as
   local-present, local-missing or remote, with the owning file.
4. Wire the three checks into the run so that a failure refuses the verdict for that surface
   and names the rule.
5. Assert the unchanged measurement contract by test: the strict compare parameters and the
   reference-identity gate must both be provably intact after this phase.
6. Add the unit tests: a fixture that renders clean, a fixture carrying `Liquid error`, a
   fixture with an unrendered tag in text position, and a fixture with the same tag inside
   `<script>` (which must not fail).

## Verification

- `npm run test:canary` (and the package suite that owns the theme source checks) pass with
  the new cases included.
- A deliberately broken fixture — one unrendered tag in text position, one undeclared
  setting read, one missing local asset — produces three named refusals, not one.
- The same fixture with the tag placed inside `<script>` produces no refusal.
- The static checks run without the browser and produce identical output for the same source.

## Success Criteria

- [ ] A rendered page carrying a Liquid failure can never produce a `PASS` verdict.
- [ ] Schema, settings binding and asset existence are each checked, with failures named
      individually.
- [ ] The strict compare parameters and reference-identity enforcement are asserted intact
      by test.
- [ ] Static checks do not require the browser, the instance or the network.

## Rollback

All changes are additive checks behind a refusal path; removing the wiring restores the
previous behaviour without invalidating persisted evidence, because the added records are
diagnostic.

## Outcome (2026-09-11)

`checks` ran over the real theme directory and every captured document: `config/settings_schema.json`
parses, the theme declares 0 sections, 95 settings reads are undeclared by that schema
(`add_to_cart_show`, `cart_deliverytime_start/end`, `code_messenger_mb`, …), 78 local assets present with
6 referenced but absent from the source. Reports: `.canary/theme-fidelity-run4/structural.json`
(sha256 `2cd1143f16e7f97decd1729b7b7f432c5b694dcacf1aec1d828e38b1f1d655e0`). The false-positive probe
holds: sampled ids occur zero times in the theme's 1463-id `settings_schema.json`.

The write was explicit and bounded: `hrv backup --name phase5-pre-dev` (13.42 MB, 518 files), then
`hrv theme push --nodelete` (136 pushed, 46 remote-changed conflicts), then
`hrv theme push --force --nodelete` to complete it (182 pushed, 0 errors, 0 skipped). No `assets/` file
is in that set; `--only` on the two files the CLI itself reported as remote-divergent answered
"No files matched --only pattern(s)". The copy is unpublished and production was read-only.
