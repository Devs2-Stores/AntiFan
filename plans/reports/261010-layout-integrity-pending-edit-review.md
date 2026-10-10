# Review: pending LayoutIntegrityEngine edit, and verification of its replacement (2026-10-10)

> Contains scan output. Keep this file away from the agent that writes the Phase 4 blind held-out
> corpus of `plans/261009-1609-visual-qa-geometry-upgrade/` (criterion 2 requires that agent to see
> no scan output).

## Scope

- **Reviewed:** the uncommitted 55-line edit to `src/main/qa/scanners/layout-integrity-engine.ts`
  on top of `920dd0fc` (archived as
  `plans/261009-1609-visual-qa-geometry-upgrade/research/engine-working-copy-261010.diff`).
- **Fix:** the plan's Phase 3 port of `research/visual-qa-probe/scan-v2.js` into the engine,
  written by the plan-executor session (`01a12144`). This review session made no edits to the
  engine, the workflow or the plan files, so the two sessions never wrote the same file.
- **Tested engine:** working-copy blob `3f6e1d62607fbdbc02e8b3da670d93fe406768e6`. Its scan script
  equals `scan-v2.js` except for the three header comment lines and the `stats.failedDetectors`
  addition from Phase 3.

## Method

Standalone Electron 43 (`node_modules/electron/dist/electron.exe`, temp `userData`, off-screen
non-focusable windows; the running AntiFan instance was not touched). The harness loads each page
once and runs the HEAD engine and the candidate engine on the same document, at 375×667 (DPR 2,
mobile) and 1440×900.

- 20 plan fixtures (`visual-qa-probe/fixtures.cjs`): 15 defects, 5 healthy controls. Fixture 01
  (plain document overflow) belongs to the overflow engine and is not scored here.
- 15 targeted probes R01–R15 covering the pending edit's exemptions: 7 defects (R01, R02, R03,
  R06, R07, R09, R15) and 8 controls (R04, R05, R08, R10, R11, R12, R13, R14).
- 24 live pages: 4 public Haravan stores × home/product/collection × 2 widths, 5 s settle.

A defect counts as caught when its expected kind appears as a critical at 375 (a warning for 06
and 14). A control counts as a false positive when it yields any critical at either width.

## Verdict on the pending edit: reject (superseded by the Phase 3 port)

| Engine | Defects missed (fixtures + probes) | Controls with a critical | Live pages with a critical |
|---|---|---|---|
| HEAD `920dd0fc` | 11 | 23 (page × width) | 24 / 24 (1150 criticals) |
| HEAD + pending edit | 15 | 7 | 13 / 24 (305 criticals) |
| Phase 3 port | 2 (R07, R09) | 0 | 0 / 24 |

Defects in the pending edit, each reproduced by the harness:

1. **Fixed/sticky suppression is too wide.** `isInFixedLayer` skips every overlap pair with any
   fixed or sticky ancestor, so a fixed header covering hero text (fixture 11) drops from 12
   criticals at HEAD to 0, and two colliding items inside one sticky header (R01) go silent.
2. **Absolute-overlay exemption hides real collisions.** `isAbsoluteOverlayOver` exempts any
   absolutely positioned control, which is the stretched-link pattern (R04) but also an absolute
   buy button covering the product title (R03).
3. **Carousel exemption parks a real off-page CTA** (R09).
4. **Text geometry is still box geometry.** The edit misses fixtures 02–08, 10, 13b, 14 and 15,
   and keeps false positives on 12 (line-clamp), 17 (read-more), 19 (crossfade) and R12
   (`#haravan-notification`).

## Phase 3 port

- Findings are identical to the `scan-v2.js` reference run on all 70 page × width rows.
- Fixtures: every integrity defect fixture (02–15) caught at 375 with its expected kind; controls
  12, 16, 17, 18, 19 give 0 criticals at both widths.
- Probes: R01, R02, R03, R06, R15 caught; R04, R05, R08, R10, R11, R12, R13, R14 give 0 criticals
  (R12 keeps one warning: in-flow `nav` and `div` boxes overlap 1425×30 px at 1440).
- Live: 0 criticals on 24 pages; warnings only (gixjewel 1–11, hapas home 10).
- Timing: slowest scan 952 ms (fixture 13b, 1440); slowest live page 688 ms (hapas collection,
  1440). Plan criterion 4 is ≤ 1200 ms. The same script measured 735 ms on 13b in the reference
  run; the 952 ms run shared the CPU with the plan session's own Electron runs [INFERENCE].

## Known limit: absolutely positioned controls parked off the viewport

R07 (absolute button at `left:120vw` inside an `overflow:hidden` wrapper) and R09 (the same inside
`.swiper-wrapper`) are not reported. The offscreen detector treats a control as parked when it or
an absolutely positioned ancestor lies wholly outside the viewport
(`layout-integrity-engine.ts:349-356`). That geometry is the off-canvas panel pattern (search
drawers, mega-menus parked at `left:100%`), and nothing in layout separates a parked panel from a
misplaced one. Reporting it would bring back HEAD's offscreen false positives, which made up 156
of HEAD's 1150 live criticals. This is accepted as a recall limit, not a fix target; plan
criterion 2 allows two held-out misses out of eight.

## Not covered here

- R01–R15 were written after reading the pending edit's exemption code, so they are targeted
  regression probes, not a blind held-out corpus. They do not satisfy plan criterion 2.
- The running app still uses the compiled HEAD engine. Shipping needs `npm run compile` plus a GUI
  restart, which is the user's step after Phase 4.

## Evidence

Scratch artifacts (outside the repo) in `E:/Work/scratch/lie-review-ab/`:

- `ab.cjs`: the harness; `--ref` runs `scan-v2.js` in the candidate column; `--live` runs the 24
  live pages; `AB_TAG` names the output directory.
- `out/results.json`: HEAD vs pending edit, fixtures and probes. `out-live/results.json`: the same
  on live pages.
- `out-ref/results.json`: HEAD vs `scan-v2.js`.
- `out-port/results.json`, `out-live-port/results.json`: HEAD vs the Phase 3 port.
- `engines/wc-pending.js`, `engines/wc.js`: bundles of the pending edit and of the port.
