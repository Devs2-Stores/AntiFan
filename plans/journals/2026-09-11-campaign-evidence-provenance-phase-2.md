# 2026-09-11 — Campaign evidence provenance: phase 2, capture-side blockers

Plan: `plans/260910-2008-clone-campaign-evidence-provenance`, phase 2
(`phase-02-capture-side-blockers.md`, `status: in_progress`).

Run 13 is the first run whose desktop verdicts are both `PASS` (1440 1.82%, 1024 0.04%) and
whose two sides are provably motionless (`postCompareMotion` `stable: true` on both,
`pinsLeft: 0` on both). The remaining refusal at 390 is now attributed to the reference's
own layout switch, and the campaign's central premise — that the live page is a stable
reference — is measured to be false on this storefront.

## Delivered

- **Settle contract as a pure module** (`scripts/lib/settle-contract.mjs`) with
  `canary-settle.mjs` as its only consumer; `requireDoubleSettledMetrics` carries the
  per-pass `passes[]`, and slider normalization is explicit (`normalizeSliders: true`).
  9/9 unit tests.
- **Viewport geometry as an assertion, not a write** (`scripts/lib/viewport-geometry.mjs`):
  `sameViewport`, `isSymmetricViewport`, `describeViewport`, `isMeasurableViewport`,
  `VIEWPORT_TOLERANCE_PX = 1`; the child measures both tabs and refuses `VIEWPORT_ASYMMETRY`
  (exit 3) rather than trusting the app's acknowledgement. 7/7 unit tests.
- **Bundle integrity as a typed refusal** (`scripts/lib/bundle-integrity.mjs`):
  `HARNESS_RESIDUE_MARKERS`, `detectHarnessResidue`, `detectLostLayoutSwitch`; the campaign
  applies both to the desktop and the mobile bundle and fails closed with
  `CONTAMINATED_BUNDLE` / `LAYOUT_SWITCH_LOST` / `MOBILE_BUILD_FAILED`. 6/6 unit tests.
- **`releaseCompareBlockers(tabId, label)`** replaces "leave the freeze on": the site's own
  pause API first, then a full `releaseSettleOverrides`, then — because this site exposes no
  `jQuery` global, so `slickPause` reaches nothing — a symmetric sweep that clears the real
  timer ids 1..200000 on both sides, followed by `sampleWidgetMotion(tabId, 2500)`. The
  docstring records the two rejected variants (pins kept → 7.35%; freeze kept → RPC timeout).
- **The guard registry is per page, not per pass.** `settleAndMeasure` used to build a fresh
  `snapshots` map each pass while overwriting `__antifanGuardRestore`, so the last pass could
  restore only its own pins: measured `{restored: 2, pinsLeft: 177}` on the reference against
  `{restored: 7, pinsLeft: 0}` on the clone. The registry is now `window.__antifanGuardSnapshots`
  and run 13 released everything: `unfrozen=true markedLeft=0` (run 9: 80 left).
- **Post-compare motion gate.** The pre-compare window is shorter than the compare
  transaction, so a page could pass the pre-compare sample and still move during the raster.
  `sampleWidgetMotion` now also runs after the compare; any side unstable replaces the verdict
  with `INCONCLUSIVE` under `PAGE_MOTION_DURING_COMPARE`, keeps the superseded numbers in
  evidence, and exits 2. Applied to `PASS` as well as `FAIL` — a moving page is not a
  deterministic comparison.
- **Reference-identity gate.** After the structural stage the child reads the dump it built
  from and records `referenceIdentity {dumpPath, dumpedHeight, liveHeight, heightDrift,
  dumpedSections, liveSections, dumpedSha256, stable}`; when `stable === false` the pixel
  verdict is withheld under `REFERENCE_CHANGED_SINCE_BUILD` with the superseded verdict and
  percentage retained.
- **Tab identity and the layout switch.** The storefront picks its layout from a `data-device`
  attribute written at load time, not from a media query. The child now reads both tabs'
  `{href, device, ua, innerWidth, innerHeight, dpr, docHeight, sections, widgetNodes, images}`
  and refuses `REFERENCE_DEVICE_MISMATCH` (reference declares a device class the tier does not
  expect) or `DEVICE_CLASS_ASYMMETRY` (the two sides declare different layouts) instead of
  reporting the resulting height difference as a clone defect.
- **Clone correctness (real defects, not harness noise).**
  - `BlueprintExtractor` no longer descends into a `<div>` whose structural children are
    `<section>`s while that element carries a framework binding (`wire:` / `x-` / `v-` / `hx-`
    / `@`): the `boxProducts` Livewire wrapper was being unwrapped and
    `wire:effects.xjs` — literally the `$('.block-category__list').slick({…})` call — was lost,
    which stacked `section.block-category` at 341px each against the reference's 76px.
    Verified offline on the real dumps: mobile `wire:effects` 44 → 44 (was 42),
    `block-category__list` 6 → 6, desktop 47 → 47; 108/108 site-clone tests.
  - The clone preserves the reference's layout-selecting body attributes (`data-device="web"` /
    `"mobile"`) while scrubbing `data-antifan*`, `data-navigate*`, `data-update-uri`,
    `data-turbo*`, `data-livewire*` and `on*`.
  - Harness residue is stripped at the dump (`data-antifan-pw-hooked`), so a marker never
    reaches a bundle: run-9 bundles show zero `data-antifan-*` in both `clone/index.html` and
    `clone/mobile/index.html` and in both reference dumps.
- **Capture path.** Dark header fixed at the canvas (`DEFAULT_CANVAS_CSS` with `:where(html)`,
  applied through `wc.insertCSS`); the raster view box now equals the drawn box
  (`boundsW = renderedW; boundsH = renderedH`); `CAPTURE_INVALID` cleared by releasing the
  compare blockers before the compare; a live bridge port is proven live by an HTTP response on
  `/api/pairing/challenge` before minting, never by port ownership alone (two measured
  `ECONNRESET` mint failures with a valid instance record).
- **Diagnostics.** `childErrorDetail(stdout, stderr)` and `vpResult.childOutput` replace
  printing only the first stderr line, which had hidden the mint's real failure.

## Measured evidence

| Claim | Deciding check |
|---|---|
| Desktop tiers reproduce the reference | Run 13: `[1440] Capture: Ref=2339438B Clone=2368775B (isPng=true) Net: PASS Visual: PASS (1.82%) Overall: PASS (MATCH)`; `[1024] … Visual: PASS (0.04%) Overall: PASS (MATCH)` |
| Both sides were motionless through the raster | Run 13 evidence: `postCompareMotion.reference {widgetsSampled: 7, windowMs: 2500, sampleBefore: 12b75192, sampleAfter: 12b75192, stable: true}`, `clone` identical; at 390 `reference {widgetsSampled: 21, stable: true}` / `clone {widgetsSampled: 71, stable: true}` |
| The pin leak is closed | Run 13 log: `Settle overrides released: unfrozen=true markedLeft=0` (run 9: 80; run 10 evidence `pinsLeft: 0`) |
| The extractor guard restores the carousel | Offline on the real dumps: mobile `wire:effects` 42 → 44, `block-category__list` 5 → 6; `section.block-category` renders 76px as in the reference instead of 341px |
| The bundle carries no harness residue | Run-9 bundles: `pw-hooked=0`, zero `data-antifan-*`; `detectHarnessResidue` returns `[]` |
| The clone preserves the layout switch | `<body data-device="web">` and `<body data-device="mobile">` in the generated bundles match their dumps |
| The reference is not deterministic | Same URL, same viewport, different runs: 1024 → 5546 (run 12 floor) vs 5426 (run 9/10); 390 → 3166 (run 9), 4481 (run 12), 9833 (run 10), 9843 (run 13) |
| 390's refusal is the reference's layout, not the clone's | Run 13: `STRUCTURAL_TRUNCATION_DETECTED (current: 9781px, baseline: 4533px, delta 115.8%)` with `Ref=1121108B Clone=470559B`; the clone's 4533px equals the dumped 4481px |
| Suites | `test:canary` 70 pass; `test:unit/canary-settle-contract` 9/9, `viewport-geometry` 7/7, `bundle-integrity` 6/6; `test:site-clone` 108 pass / 16 suites; `test:main` 1076 pass / 0 fail / 1 skip |

## Blocked

1. **The live reference is non-deterministic — the campaign's premise is false on this
   storefront.** Heights for one URL at one viewport differ across runs (1024: 5546 vs 5426;
   390: 3166 / 4481 / 9833 / 9843) while the bundle held its dumped height. Consequence: a
   pixel verdict is only admissible against a reference whose identity was pinned at build
   time and re-measured at compare time; run 12's `STRUCTURAL_PARITY_MISMATCH
   deltaGeometry=120px` was the reference moving, not the clone failing. Remedy is in the tree
   and was exercised as measurement in run 13 (`referenceIdentity`); run 12 predates the
   declaration of `CANARY_REFERENCE_DUMP` in one leg's environment, which run 13 recorded as
   `{status: NOT_DECLARED}` — the parent now passes the tier's dump path on every leg.
2. **390 still refuses, with the mechanism named.** The reference declares its layout via
   `data-device`; at 390 the reference measured 9781px (web layout) against the clone's 4533px
   (mobile layout, equal to its dump). The new identity probe and the two refusals exist to
   make this a named refusal; the underlying question — why a 390px reload of that tab ends in
   the web layout while the dump stage's 390 capture ends in the mobile one — is unresolved and
   must not be papered over with a tolerance.
3. **1024/1440 pixel-only class.** Even with equal geometry, runs 9 and 10 showed a band at
   y199–580 holding 81–88% of differing pixels (the hero). Run 13's PASS supersedes those
   numbers, but the band analysis is not explained yet and stays open.
4. **Mint tabs are not reaped.** The mint session is isolated, so the parent's close is refused
   (`TARGET_MISMATCH`); closing the mint's own tab is a change to `canary-session.mjs` and was
   deliberately not made in this phase. Tab census growth is an owner-visible cost.
5. Run 3's evidence and `REPORT.md` remain stale relative to runs 9–13.

## Decisions

- A framework binding cannot be moved off its element — the extractor guard is inlined into
  `isLayoutContainer` (rule `ts-no-tiny-functions`).
- API pause alone is insufficient on a site with no `jQuery` global; the release is followed by
  a symmetric real-timer sweep plus a widget-state sample.
- The compared state must be inert *through* the raster, not only at its start.
- A live port is not a live bridge; readiness is an HTTP response before minting, and the mint
  itself is never retried.
- Withheld verdicts name the mechanism and keep the superseded numbers rather than masking them.
- The clone must preserve the reference's layout-selecting attributes, and harness markers are
  stripped at the dump rather than refused later.
- Commit only after a verification run lands, so the commit records a verified state; do not
  rebuild `dist` mid-run.

## Docs impact

`15-PAGE-HOPLONGTECH-CLONE-CANARY.md` updated for the capture-side gates and the
reference-identity requirement. No user-facing command or configuration changed.
