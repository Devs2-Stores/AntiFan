# Test Report — 2026-09-11 — Full end-to-end (AntiFan, branch `main`)

Scope: the whole native surface (unit, integration, main, site-clone, benchmark, renderer, live Electron E2E)
plus the project-native end-to-end harness this repository exists for — the clone campaign pipeline and the
Haravan theme-fidelity pipeline, driven against live sites.

## Test Results Overview

| Layer | Suite | Tests | Pass | Fail | Skip | Duration |
|---|---|---|---|---|---|---|
| 1 | `npm run test:canary` | 133 | 133 | 0 | 0 | 29s |
| 1 | `npm run test:fast` | 451 | 451 | 0 | 0 | 12s |
| 1 | `npm run test:site-clone` | 108 | 108 | 0 | 0 | 6s |
| 1 | `npm run test:integration` | 13 | 13 | 0 | 0 | 10s |
| 1 | `npm run test:main` | 1078 | 1077 | 0 | 1 | 315s |
| 2 | `npm run test:e2e` | 6 | 6 | 0 | 0 | 24s |
| | **Total** | **1789** | **1788** | **0** | **1** | **396s** |

Layer 2 is the live surface: `mcp-industrial-overhaul` (22.2s, real Electron + Chromium + MCP stdio proxy +
CDP input), `semantic-ref-trusted-cdp` (8.5s, proves Tier 1 `isTrusted === false` against Tier 2 CDP
`isTrusted === true`, and asserts the wrapper's whole child tree dies without orphans), `soak-test` (0.3s,
4-stage endurance simulation), `theme-golden-live` (24.1s, both real Chromium slices + bounded teardown report).

Pre-flight gates: `npm run typecheck` (`tsc --noEmit`) clean, no diagnostics. `npm run audit` →
`OK — every declared status matches HEAD`, with 7 `STALE` warnings (B19–B23, B29, B30) because those
bottleneck entries were last verified before `plans/260911-0133-haravan-customize-theme-fidelity/plan.md`
landed; the audit's own verdict on HEAD is OK.

## Coverage Metrics

Not instrumented — reported as unavailable rather than estimated. `package.json` carries no coverage runner
(no `c8`/`nyc`/`istanbul` in `devDependencies`) and no `test:coverage` script, so there is no measured line or
branch percentage to compare against a threshold.

## Failed Tests

None.

The single skip is deliberate and named: `test/main/phase-02-agent-plane-authority.test.ts:578` calls
`t.skip()` unconditionally for "live Electron window HW composited validation … covered by Phase 6 Windows
runtime certification". It is a documented deferral, not a hidden failure — the test body asserts nothing.
The other two conditional skips in the tree (`windows-acl.test.ts:253` non-Windows, and
`canary-evidence-provenance.test.mjs:303` when the OS reuses a dead pid) did not fire on this host.

## Layer 3 — project-native end-to-end, read-only (theme-fidelity pipeline)

Run into a fresh `--out`, against the live store `https://phukienmaymoc.com/` and the theme copy
`1001512581` (`org 200001207485`). No write stage was executed (`serve` and the push were not run), so
nothing was written to the copy or the storefront.

| Stage | Exit | What happened |
|---|---|---|
| `preflight` | 0 | `store=https://phukienmaymoc.com/ theme=1001512581 org=200001207485 targets=7` |
| `references` | 3 | r1-copy capture ran the full 21-target inventory: 14 captured, 7 not measurable |
| `subject` | 3 | refused `PREREQUISITE_MISSING`: needs `serve.json` from the writeful `serve` stage |
| `checks` | 3 | refused `SUBJECT_HTML_ABSENT`: needs the subject DOM dumps |
| `compare` | 3 | refused `PREREQUISITE_MISSING`: no `r2/index.json` |
| `report` | 3 | refused `RUN_INCOMPLETE`: names every gap, `current.json` not published |

Reference pinning (R1): 21 documents requested, 21 written, **14 measurable, 7 over the raster ceiling**.
The seven are all the desktop tiers of the tall surfaces, with the exact CSS-pixel region:

| Surface | Viewport | Region | Status |
|---|---|---|---|
| home | 1440x900 | 1440x27360 | NOT_MEASURABLE |
| home | 1024x900 | 1024x25100 | NOT_MEASURABLE |
| product | 1440x900 | 1440x17229 | NOT_MEASURABLE |
| article | 1440x900 | 1440x18853 | NOT_MEASURABLE |
| article | 1024x900 | 1024x16759 | NOT_MEASURABLE |
| cart | 1440x900 | 1440x16477 | NOT_MEASURABLE |
| search | 1440x900 | 1440x16465 | NOT_MEASURABLE |

All seven exceed `CAPTURE_MAX_DIMENSION = 16384`, so they are refused as
`FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY` rather than captured truncated — full-page evidence never falls back
to a viewport-only or clipped raster. The remaining 14 legs (home/product/cart/search at phone and middle
tiers, collection at all three, 404 at all three) captured.

Reproduction: these heights match the numbers the Phase 5 run recorded earlier the same day — home 390
10746, product 1024 15207, product 390 3514, collection 1440 15961, collection 1024 13701, collection 390
1943 — so the finding reproduces across **three independent runs** of an unchanged pipeline. The measured
cause of the desktop refusal class is unchanged: the copy now serves the local markup with the copy's
server-compiled stylesheets, and the two `assets/*.scss.liquid` files it needs are outside the CLI's tracked
push set (no `assets/` path appears in any push log), which is recorded in
`plans/260911-0133-haravan-customize-theme-fidelity/phase-03-verdicts-provenance-and-safety-audit.md`.
The verdict is a typed refusal with the mechanism named, not a partial verdict set.

Safety audit of the run's own command log (`commands.jsonl`, 6 records):
`auditCommands` verdict pass, `themeIds` only `["-1","1001512581"]`, `foreignThemeIds.count 0`,
`publishDeployPush.absent true`. No `hrv theme push`, `publish` or `deploy` was executed in this test run.

Pin discipline, exercised rather than assumed: re-running `references` into the directory that already held
the partial R1 pin refused `REFERENCE_PIN_CONFLICT` ("the existing pin status is INCOMPLETE; a partial pin
cannot serve as a reference … use a fresh --out") in 0s instead of silently replacing the reference.

## Defect found by this run and repaired

The first `references` run exited 3 while printing `no typed refusal text` — the operator (or an agent) got
no reason for a refusal that the child had in fact recorded per target. Root cause: a capture that measures
every leg it can and cannot measure the rest exits 3 with `status: INCOMPLETE` and **no thrown refusal**, so
`index.refusal` is null and the reason exists only at `targets[].failure`. The driver consulted
`index.refusal` and the child's stderr and nothing else.

Repair, in `.canary/tools/theme-fidelity-run.mjs`: an exported pure `refusalFromCaptureIndex(index)` derives
the typed reason from the index (counts, the distinct failure codes, and the first failing surface, viewport
and reason), wired into both capture call sites (`references`, `subject`) and into the exit-0-but-incomplete
branches. It returns null for a `COMPLETE` index, for a `REFUSED` index, and for an incomplete index that
recorded no failure — a completed or self-describing side is never re-typed, and no reason is ever invented.

Before / after on the same live path:

```
before: REFUSED CAPTURE_REFUSED (exit 3): r1-copy capture exited 3: no typed refusal text; stderr tail: …
after:  REFUSED CAPTURE_REFUSED (exit 3): r1-copy capture exited 3: FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY
        (exit 3): r1-copy is INCOMPLETE: 14/21 captured, 7 not measurable
        (FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY); first: home 1440x900 —
        FULLPAGE_CAPTURE_UNSUPPORTED_GEOMETRY: Requested full-page capture region 1440x27360 CSS px is
        outside the supported 1..16384 range on tab '96a4afc8-…'
```

Tests: `test/unit/theme-fidelity-run.test.mjs` 27/27 (was 23; four added covering the derived reason, the
mixed-code summary, the complete/refused/no-index cases, and the no-recorded-failure case), and
`test/unit/theme-fidelity.test.mjs` 14/14 unaffected.

## Build Status

- `tsc --noEmit` (typecheck): clean.
- No rebuild was required or performed: `.compiled/src` (newest 2026-09-11 00:52:12) and `.compiled/test`
  are newer than their newest sources (`src/main/browser/native-tab-host.ts` 00:50:54,
  `test/main/omp-mcp-adapter.test.ts` 2026-09-10 23:25:07), so the suites ran against current output.
- `npm run audit`: OK for HEAD, 7 STALE warnings naming B19–B23, B29, B30.
- Process hygiene after all three layers: no clone-server listener on 7863/7854, no
  `haravan theme dev` watcher, and no Electron children left by the E2E suites; the only listeners are the
  canary bridge on 20131 and the operator's own app instance.

## Critical Issues

1. **Repaired in this run** — the driver dropped a capture's typed refusal and reported "no typed refusal
   text", costing a diagnostic cycle on a refusal the run had already explained per target.
2. **Open, by design** — the theme copy serves 3–10× taller desktop documents than the pinned source
   (home 7532 → 27360), so 7 of 21 reference legs cannot be captured at all and the fidelity verdict set is
   refused rather than partial. The mechanism (local markup and config pushed without the compiled
   stylesheets) is named in the phase file; the restore point is `backups/phase5-pre-dev.zip`.

## Recommendations

1. *(high)* Surface the seven unmeasurable legs as an explicit coverage ceiling in the report head, so a
   reader cannot mistake a refused set for a clean one — the reason now exists, but those seven appear as
   only 7 of the 112 gaps this run's report names (7 r1, 21 r2, 21 subject, 21 r1-vs-subject,
   21 r2-vs-subject, 21 checks) against `status: INCOMPLETE` with no publication.
2. *(high)* Resolve the compiled-stylesheet confound (`assets/ll-style-all.scss.liquid`,
   `assets/style-product.scss.liquid` exist locally, match no `--only` pattern, and appear in no push log),
   because it gates every desktop verdict on this theme.
3. *(medium)* Add the clone's own reproducibility invariants to the report head next to the reference's:
   three retained bundles differ in 26 of 1,772 lines, all Livewire identity, with identical payload paths.
4. *(medium)* Provide a coverage runner (`c8`) and a `test:coverage` script, or state permanently in the
   report template that coverage is unavailable, so the metric is never silently absent.
5. *(low)* Re-verify the STALE bottleneck entries B19–B23, B29, B30 that the audit flagged after the Phase 5
   plan landed.

## Unresolved Questions

- Should the campaign child's scrollbar regime be changed to the real-user regime
  (`overflow-y:scroll` + `scrollbar-gutter:stable` on both sides, as-found widths captured pre-regime)?
  That is a methodology change and would require re-running all 15 pages on one code version.
- Is the desktop height blow-up on the theme copy a defect of the copy pipeline or the expected result of
  local markup against server-compiled CSS? The capture evidence cannot separate the two.
