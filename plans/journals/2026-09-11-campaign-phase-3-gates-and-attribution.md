# Phase 3 — Campaign re-run, gate attribution and reconciliation

Date: 2026-09-11
Plan: `plans/260910-2008-clone-campaign-evidence-provenance/`
Scope: Phases 3 and 4 preparation for the 15-page × 3-viewport clone campaign against
`hoplongtech.com`, plus the offline Phase 5 instruments for the Haravan customize plan.

## What was measured

Every number below comes from persisted evidence under `.canary/15-pages/**` and from
`.canary/state/phase3-*.log`. Attempt-level files under
`<page>/attempts/<attemptId>/evidence/<viewport>.json` are authoritative; the per-page
mirror at `<page>/evidence/<viewport>.json` can lag an attempt behind.

### Batch 1b, 2 and 3 (pages 1-5)

| Run | p1 @1440 | p1 @1024 | p1 @390 | p3 @1440 | p5 @1440 |
|---|---|---|---|---|---|
| 1b (pre-pin) | FAIL 7.37% | INCONCLUSIVE 8.65% | INCONCLUSIVE | PASS 0.08% | PASS 0.07% |
| 2 (pin) | PASS 1.82% | PASS 0.04% | PASS 0.01% | FAIL 4.59% | FAIL 4.76% |
| 3 (pin reverted) | PASS 1.82% | PASS 0.04% | PASS 0.01% | FAIL 4.59% | FAIL 4.76% |

Two conclusions came out of this table.

1. **Pinning the carousel phase was a mask in disguise and is reverted.** Forcing
   `.slick-track` transforms and the active classes moved p3/p4/p5 from 0.07-0.08% to
   4.59-5.62%, because the two sides do not agree on whether a carousel is initialized:
   the same manipulation lands differently on a live page and on a static clone. What
   replaced it is detection, not normalization — `readWidgetPhase` reads each side's
   current slide vector and a disagreement withholds the verdict as
   `WIDGET_PHASE_MISMATCH` instead of publishing the rotation as fidelity.

2. **The p3/p4/p5 failure is not the clone rendering differently; it is the page area
   the two tabs present.** Measured across three attempts of page-03:

   - reference raster: `0 px` differ between batch 1b and batch 3 (pixel-identical),
   - clone raster: `422,421 px` differ between the same two batches (12.279%),
   - the pair in batch 1b: `4,408 px` (0.128%); in batch 3: `426,784 px` (12.406%),
   - `docHeight` equal on both sides (2389), `sectionCount` 3 = 3,
   - `header.dw = -15`, `footer.dw = -15`: the clone lays out inside 1425px while the
     reference lays out inside 1440px.

   A 15px content-box difference reflows every text line, which is why a few hundred
   pixels differ per row rather than a band: the diff is spread down the page. The clone
   bundles differ by 52 lines between those batches, and those 52 lines are the site's
   own runtime ids and Livewire snapshots (`#i53f61kv3t5c1789066462065` vs
   `#k29khgedp30s1789070496126`), not CSS — no `::-webkit-scrollbar` rule exists in either
   bundle, and the live reference carries none either. The difference is therefore the
   scrollbar regime each tab presented, a harness-side cause that batches 1b and 3
   happened to straddle.

## What changed

- **`readWidgetPhase(tabId)`** replaces the pin: a disagreement is refused as
  `WIDGET_PHASE_MISMATCH` (exit 3, `INCONCLUSIVE`), never normalized away.
- **`LAYOUT_WIDTH_ASYMMETRY`**: `TAB_IDENTITY_EXPR` now reports
  `documentElement.clientWidth` and `scrollWidth`, and two sides whose content boxes
  differ are refused by name rather than compared. Both boxes are recorded in the refusal
  so the next reader sees the numbers, not the symptom.
- **Scrollbar regime, applied to both sides**: `scrollbar-width:none` plus
  `::-webkit-scrollbar{display:none}` before any measurement, so both tabs present the
  same page area. This is symmetric by construction and removes no content: a page that
  overflows still overflows, and the clone's own 299px horizontal overflow at 390 stays
  visible (its 390 raster is 689px wide against the reference's 390px).
- **`CAPTURE_TOO_TALL`**: a document beyond `CAPTURE_MAX_DIMENSION = 16384` is refused
  with its measured height, before hydration and again after, instead of failing deeper as
  a capture or compare error. Pages 13-15 at 1024 are in this class.
- **Mask sensitivity in the same run**: each leg now performs a second comparison with
  `useDefaultWidgetMasks:true` on the same pair under the same lease. It is recorded as
  `evidence.visualMasksOn` with `bindingVerdict` and can never change the verdict; the
  binding policy stays masks-off, so a difference that masks would hide is still reported.

## Refusals observed live

- `LAYOUT_WIDTH_ASYMMETRY` on pages 10 and 11 at 1440 and 1024 in the pre-change run:
  the gate fires before the capture (`Capture: Ref=0B Clone=0B (isPng=false)`), and the
  verdict is `INCONCLUSIVE` with the two content boxes named. That is the intended
  behaviour: refusing a harness-side cause instead of publishing a phantom failure.
- `STRUCTURAL_PARITY_MISMATCH` at 390 with 0.01% of pixels differing on several pages:
  the mobile bundle carries a real 299px horizontal overflow that the full-page raster
  clips on one side only. The pixel number cannot see it; the structural leg can, which
  is why both are published.

## Phase 5 instruments (offline, verified against the real theme)

- `scripts/lib/theme-checks.mjs` + `scripts/theme-checks.mjs`: on
  `E:/Work/customizes/Phukienmaymoc` the structural gate reports `schemaFiles 1`,
  `sections 0`, 95 undeclared setting reads and 1267 dead reads, and 6 missing local
  assets out of 78 present. A false-positive probe confirmed the sampled ids
  (`add_to_cart_show`, `cart_deliverytime_start`, `addthis_iconList_show`) occur zero
  times in the theme's own 1463-id `config/settings_schema.json`.
- `.canary/tools/theme-fidelity.mjs` + `.canary/tools/theme-fidelity-run.mjs`: capture and
  compare harness with pinned references, plus a seven-stage orchestrator. 14 + 23 pure
  tests pass.
- `checkServedTheme`: `?themeid=` is not proof of what was served. Measured on this store,
  an unknown id answers 200 while serving the live theme, so the assertion is made against
  the `cdn.hstatic.net/themes/<org>/<id>/` origin inside the captured document and a
  dominant foreign id is refused as `SERVED_THEME_MISMATCH` (exit 4).

## Open

- A document beyond the capture ceiling is now refused by name; pages 13-15 at 1024 are
  expected to carry that refusal in the published record rather than a truncated raster.
- The mint tab cannot be closed by a session that does not own it
  (`TARGET_MISMATCH`, session scoping deliberately not weakened), so the instance-plane
  tab census grows by one per mint and clearance is an owner action.
- The scrollbar regime is a symmetric harness normalization, not a page property. If a
  future leg still measures asymmetric content boxes after the normalization, the refusal
  fires and its two numbers are the finding.

## Clone-bundle determinism, measured (2026-09-11, closes the attribution item)

Page 3 has three retained clone bundles on disk. All three are 330,236 bytes / 1,772 lines, and every
pairwise diff is the same 26 lines, categorised: 25 `wire:id`, 25 `wire:snapshot`, 2 epoch-like numbers
(they sit inside those ids), 1 `<style>` rule carrying the same runtime id. No nonce, no asset version
token, no markup difference. So the bundle is nondeterministic only in the site's own Livewire instance
identities — it is not reproducible byte-for-byte, and it cannot be, but nothing material varies.

The material invariants are stable, which is what the harness records per attempt:

| attempt | bundle sha256 | clone@1440 | clone@1024 | clone@390 |
|---|---|---|---|---|
| a013dc6b (batch 1b, pre-pin) | 3aeb43dc744861e4 | docH 2389, 3 sections, 20 cards | docH 2766 | docH 3487 |
| 3337af09 (batch 2) | d27aa9eba406415a | docH 2389, 3 sections, 20 cards | docH 2781 | docH 3497 |
| e77dfc2d (batch 3) | a46bf21779c0fcf0 | docH 2389, 3 sections, 20 cards | docH 2781 | docH 3497 |

Two conclusions, both from that table rather than from the byte hashes:

1. **The geometry flip is not the bundle, and neither height delta is attributed.** b1b → b2 moves
   1024 by +15px and 390 by +10px while the bundle difference is only runtime ids, and b2 → b3 changes the
   bundle (different ids) with *identical* geometry. The +15px at 1024 was attributed to a scrollbar gutter
   on the strength of `attempt-d206677e` (pre-regime, widths recorded): reference `clientWidth` 1024 against
   the clone's 1009 — the clone 15px narrower. **That attribution is withdrawn.** In the published attempt
   `a8d3f18c` the regime is on and both sides record the *same* `clientWidth` at every tier — 1440/1440,
   1024/1024, 390/390 — yet the clone still reads 2781 against the reference's 2766 at 1024 (+15) and 3497
   against 3487 at 390 (+10), and exactly equal at 1440 (2389/2389). A delta that survives equal widths is
   not a scrollbar-width effect. The 15px *content-box* deficit seen pre-regime and the 15px *docHeight*
   delta are different quantities and were conflated. Both deltas are therefore recorded as unattributed
   clone-side content differences at those tiers, with the mechanism **not** attributed; the pre-regime
   15-asymmetric-pair finding stays a measurement, but it does not explain the heights.
2. **The page-3 verdict sequence is fully explained** without invoking run noise: b1b PASS 0.08% is the
   symmetric pre-pin state (1024 docHeight 2766 on both sides); b2/b3 FAIL 2.3–4.59% is the pin era, where
   the reference was deliberately pinned to a state the clone did not match; the authoritative run, after
   the pin was reverted, returns PASS 0.08% — reproducing b1b exactly. The scrollbar regime is not part of
   this explanation: it was made symmetric before the authoritative run, and the heights it would have had
   to move are unchanged by it.

What the harness does and does not assert: the reference's own stability is gated (`referenceIdentity`
against the same-run same-viewport readiness floor), and the clone's *material* invariants are recorded
per attempt (`bundle.entrySha256`, docHeight, section and card counts, plus the compare's own
percentage). A byte-equality assertion on the clone entry would fail every run by construction, because
the site mints new Livewire ids on every render; the invariants that can move a verdict are the recorded
ones. Gate state and per-side identity live in `attempts/<id>/evidence/<viewport>.json`, never in the
page-level `evidence/` mirror, which can be a stale rollup of an older attempt.

## The gutters, attributed (from the clone's own stylesheets)

The clone ships scrollbar rules for inner elements only — `.category-navigation__list ul`,
`.search-popular`, `.filter-list__button ...`, `.view-list .list .column-scroll{display:none}` — and
nothing for `html`/`body` (20 rules in `app-DCc2d3nB.css`, 9 in `product-BeRhNqqG.css`, all scoped).
So the clone's 15px root gutter was the browser default and the reference's `clientWidth == innerWidth`
at 1440 was the anomaly. This concerns the *width* asymmetry only: it does not explain the 1024/390
height deltas above, which persist while both widths are equal. The symmetric regime as shipped is `none`
on both, which removes the reference-side artifact without fabricating a FAIL, but it also removes the
regime a real user gets and blinds `LAYOUT_WIDTH_ASYMMETRY`. `overflow-y:scroll;scrollbar-gutter:stable`
on both, applied before either side materializes and with the floor re-measured, is the faithful version —
a child change, so a full 15-page re-run, not a patch to the published set.

Correction to the sentence that stood here ("per-side width readings stay in every case file"): the
regime is injected before the identity is captured (`viewport-run.mjs:734-735` vs `:764`), so every
published case records equal widths by construction and `LAYOUT_WIDTH_ASYMMETRY` at `:800` compares two
post-regime values — it cannot fire while the regime is on, which means the 4-to-0 refusal drop is the
detector being blinded rather than the asymmetry being resolved. The as-found asymmetry survives only in
pre-regime attempts: 15 asymmetric pairs over 8 pages (2, 3, 4, 9, 10, 11, 13, 14), reference 1440/1024
without a gutter against clone 1425/1009 with one — the clone in the browser's default regime and the
reference anomalous — and none on page 1, matching the pages that passed against the pages that refused.

### The snapshots carry no state churn (exhaustive, not sampled)

Byte-differing lines are only half the question: a `wire:snapshot` carries the component's serialized
`data`, so the payload had to be compared past identity. All 25 snapshots parse in each bundle, and the
top-level component `id` sets are equal. Enumerating every leaf path and diffing all three pairs gives a
closed inventory of what differs:

| differing path | count per pair | what it is |
|---|---|---|
| `.memo.id` | 25 | Livewire component instance id |
| `.checksum` | 25 | derived from the id above |
| `.memo.children.<child>[1]` | 19 | nested child component identity tokens |

Nothing else. In particular **no `.data.*` path differs** — component 0 alone exposes 185 `data.*` leaves
and they are identical across b1b, b2 and b3, as are the section and card counts (3 sections, 20 cards at
every tier). So the clone's variation across three independent builds is runtime identity and its derived
checksum only: there is no session, cart, filter, slide or branch state churn, which is why the geometry
was able to match b2 against b3 exactly. This is the step that separates runtime identity churn from site
state churn; it closes the question rather than inferring it from geometry.
