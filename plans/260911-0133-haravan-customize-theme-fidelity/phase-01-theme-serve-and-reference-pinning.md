---
phase: 1
title: "Theme Serve, Page Inventory & Reference Pinning"
status: pending
priority: P0
effort: "4h"
dependencies: []
---

# Phase 1: Theme Serve, Page Inventory & Reference Pinning

## Overview

Nothing in this plan can be trusted until three things exist: a proven way to serve the
local theme source through `hrv theme dev` onto the authorised copy, a resolved list of
real storefront URLs per surface, and a reference pinned **before** the dev session is
allowed to write. This phase produces exactly those, and refuses to proceed without them.

The order inside the phase is the order of the risk: references are captured read-only
first (cheap, mutates nothing), then the dev session starts (the only remote write in the
whole plan), then the surfaces are inventoried against the served theme.

## Requirements

### R1 — Reference pinning happens before any dev write

Capture, for each surface and each tier:

- **R1, the deployed copy**: `https://phukienmaymoc.com/?themeid=1001512581&view=<route or view>`
- **R2, live production**: `https://phukienmaymoc.com/?themeid=-1&view=<route or view>`

For each: the document height, section/cardinality counts, a rendered-DOM digest, and the
capture artifact's digest. These are the identities every verdict must name. No dev command
may run before all of them are persisted.

A reference captured through a preview URL is only as stable as the theme behind it, so its
identity is re-measured at use time (Phase 2) and a change is fatal to the verdict, not
adjustable by tolerance.

### R2 — The dev session is supervised and id-targeted

`hrv theme dev` runs as a supervised long-lived process with an observed readiness signal
(log pattern or port), never as a foreground call and never as a background `&`. Its
resolved theme id must be `1001512581`; if the command cannot be made to resolve to that id,
the phase stops rather than proceeding against an unknown target. Stopping it goes through
the process manager.

### R3 — Surface inventory from real routes and templates

Resolve, per surface, a URL and record how it was resolved:

| Surface | Route | Fallback |
|---|---|---|
| home | `/` | — |
| product | `/products/<real handle>` | handle discovered from the store's own listing |
| collection | `/collections/<real handle>` | idem |
| article | `/blogs/<blog handle>/<article handle>` | idem |
| cart | `/cart` | empty-cart surface unless an owner-run variant is provided |
| search | `/search?q=<fixed documented query>` | — |
| 404 | a route known not to exist | — |
| custom (view-gated) | `?view=<view name>` | taken from the workspace's own `templates/*.liquid` names |

Every URL is recorded in the run's manifest with the source it was resolved from. A surface
that cannot be resolved is a typed refusal, never a skipped row.

### R4 — Tab economy and instance hygiene

The run uses the pinned canary instance, opens at most the tabs it needs, closes all of
them, and records both census scopes. The instance is restarted and re-minted on the proven
procedure when degraded, and the restart is recorded with the verdicts it produced.

## Implementation Steps

1. Read `.haravan-cli_local.json` and assert `theme_id === 1001512581` before anything else;
   refuse on any other value, with the value named.
2. Capture R1 and R2 for every surface × tier, read-only, and persist them under
   `.canary/theme-fidelity/<store>/references/<runId>/`.
3. Verify the command surface: `hrv theme dev --help` (read-only) to establish the flag that
   selects the theme id, and record which form the phase will use.
4. Start `hrv theme dev` against `1001512581` as a supervised process; wait for its observed
   readiness signal; record pid, start time and the resolved theme id.
5. Resolve the surface inventory (R3) and persist it as the run manifest, including the
   resolution source per URL.
6. Re-measure R1 for one surface immediately after the dev session reports ready, to
   establish — as a measurement, not an assumption — that the copy now serves the local
   source. Record the before/after difference; that difference is this phase's proof that
   the dev target is the copy.
7. Stop the dev session through the process manager and record the stop.

## Verification

- `theme_id === 1001512581` is asserted before any write, and the assertion is in the
  persisted run record.
- R1 and R2 exist for every surface, with digests, before the first dev write — proved by
  file timestamps and the persisted manifest ordering.
- `hrv theme dev` reaches its readiness signal with a resolved or declared theme id of
  `1001512581`, recorded with the process identity.
- The inventory resolves seven surfaces, or records a typed refusal per unresolved surface.
- The instance tab census before and after the phase is equal, and the dev process is
  stopped.

## Success Criteria

- [ ] Both references are pinned for every resolved surface, before any write.
- [ ] The dev session serves the local source from the authorised copy, proved by a measured
      before/after difference on the same URL.
- [ ] Every surface has a URL and a recorded resolution source, or a typed refusal.
- [ ] No command targeted any theme other than `1001512581`.
- [ ] No process is left running and no tab is left open.

## Rollback

Stop the dev process, and restore the copy with the CLI's own backup if the owner wants the
copy's pre-run state back (`.haravan-cli_backup/` is written by the CLI, not by this plan).
Nothing in this phase writes to the live theme, so there is nothing to roll back there, and
that property is what the Phase 3 audit re-checks rather than trusts.
