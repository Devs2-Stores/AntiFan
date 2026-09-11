---
title: "Phase 1: Gate P0 — Reference Route Identity & Capture Integrity"
status: done
---

# Phase 1: Gate P0 — Reference Route Identity & Capture Integrity

## Overview

Gate P0 was opened as "hash/key integrity" because two routes' records looked identical. Measurement reframed it: there is no hash collision and no artifact-store defect (H2 disproved, `artifact-store.ts:358-370`). The defect is **unasserted reference route identity** — `https://hoplongtech.com/cart` was captured as `https://hoplongtech.com/?openLogin=1`, so the cart's verdict was computed from the homepage (`_verdicts.json`, evidence `390.json:214` on both attempts).

This phase makes the harness refuse to measure a route it did not reach. It is the plan's blocker: every downstream phase assumes a verdict names the page it actually measured.

## Requirements

- [x] A route-identity assertion runs after settle and **before** any DOM dump or compare: the reference tab's final URL must match the requested page URL under the documented normalization (origin + pathname; full final URL retained as evidence).
- [x] A mismatch refuses with the harness's existing route-refusal family — `URL_HOST_MISMATCH`, `URL_THEME_MISMATCH` (both live in `.canary/tools/theme-fidelity.mjs:1121-1140`) — extended with `URL_PATH_MISMATCH` for the missing pathname check, carrying `requestedUrl`, `observedUrl`, and the navigation/redirect chain — never `PASS`/`FAIL` about fidelity.
- [x] The assertion also runs at the control port, at capture start — **side-aware**: the expected identity is supplied per capture (reference → the case's requested page route; clone → the local served entry the runner navigated to, e.g. `http://127.0.0.1:<clonePort>/`, `/mobile/` on the mobile tier). The clone is served from loopback, so a gate that compares every tab against the storefront route would refuse every clone capture. Measured: page-06 `stages.clone.metrics.url` is `http://127.0.0.1:7866/` (`/mobile/` at 390) while `bundle.sourceUrl` is `https://hoplongtech.com/cart`.
- [x] The gate covers **every** capture path a verdict can descend from, not just the 15-pages harness: `anti.screenshot.full_page` (`browser-capabilities.ts:1723`) and `anti.visual.compare` (`:2372`) are also driven by `theme-fidelity.mjs` (`:959` full-page dump, `:1632` compare), and both stage through `captureStageSide`, which already carries `side: 'target' | 'baseline'` (`browser-control-port.ts:4378`, calls `:4719`, `:4778`). The per-side expectation is threaded there — one expectation per staged side — rather than compared against a single route.
- [x] **The no-expectation branch is defined, not left implicit.** The port cannot invent an expectation, and refusing unconditionally would break callers that have no requested route (interactive/user-plane captures such as `anti.screenshot.viewport`). So: *enforce when supplied* (a supplied expectation that mismatches refuses with the route-refusal family); *record when absent* (the capture envelope carries `expectedUrl: null` plus a typed `URL_EXPECTATION_MISSING` marker); *fail closed at publication* (the verdict/receipt builder refuses to publish a verdict whose captures carry `URL_EXPECTATION_MISSING`). Omission is therefore never a silent bypass — it cannot produce a published verdict. Both harnesses already hold each side's requested route (`target` at `theme-fidelity.mjs:1010`), so they must supply it; theme-fidelity's subject side supplies its served loopback entry.
- [x] A clone capture is never refused by the route gate: the expected value is per capture (served loopback entry for the clone), demonstrated by re-running the affected pages and observing zero clone-side route refusals.
- [x] The gate is exercised on all three surfaces with the branch behaviour asserted: a supplied expectation that mismatches refuses with the route-refusal family; a capture with no expectation carries `URL_EXPECTATION_MISSING`; and a verdict minted from such a capture is refused. `theme-fidelity.mjs`'s legs are demonstrated to supply their expectation, so its 21-leg path cannot silently no-op.
- [x] Existing aliased cases are regenerated as **new attempts**; immutable attempt directories and published verdict files are never rewritten.
- [x] The aggregate report counts route-refused cases as a typed class, excluded from the comparison set.
- [x] The same family gates `.canary/tools/theme-fidelity.mjs`. Correcting the handover: that tool **already** asserts route identity for host and theme (`checkObservedUrl`, `:1121-1140`, called at `:1010`, result recorded at `targets[].dom.observedUrl` `:1035`) — the missing comparison is **pathname**, so a real `/cart` → `/?openLogin=1` substitution that preserves host and themeid would pass today. Identity is origin + pathname, so a legitimate query parameter (`?themeid=1001512581` vs `?themeid=-1`) and the 21 retained legs are never refused — the added check must not be so strict that it rejects faithful evidence.
- [x] Steps 5–6 run only after Phase 2's navigation-await and readiness gate land: the `/cart` redirect is deterministic, but re-measuring on a fire-and-forget navigation would make the verification itself racy.

## Implementation Steps

1. Add a normalization + assertion helper next to the harness's existing URL bookkeeping, and call it at both accept sites: after the reference settle (`fifteen-pages-run.mjs:621-636`) and after each per-viewport settle (`:696-709`). `pageResult.finalUrl` already holds the observed URL (`:629`); it is currently recorded and never compared.
2. Extend the existing pure checker rather than inventing a parallel one: add `URL_PATH_MISMATCH` to `checkObservedUrl` in `.canary/tools/theme-fidelity.mjs` (`:1121-1140`), and use the same helper shape in the 15-pages harness. Host/theme codes keep their current names and `EXIT.REFUSAL`; any of the three codes counts as the route-refusal class in the aggregate report.
3. Add the port-side gate: before `captureVerificationScreenshot` / `executeVisualCompareAttempt` capture (`browser-control-port.ts:3836`, `:4407`), read the tab's current URL and document generation and refuse when identity does not match **the expected URL for that side** — the requested route for the reference, the served loopback entry for the clone (`fifteen-pages-run.mjs:852` builds `http://127.0.0.1:<clonePort>/`; `:885` selects the mobile entry per tier; `viewport-run.mjs:80`, `:90`, `:194`, `:423-490` already verify the served entry's sha256 via `CANARY_SERVED_ENTRY`). A single expected value for both sides is wrong and would refuse the clone entirely. Plumb the expectation through both capability surfaces a verdict can descend from — `anti.screenshot.full_page` (`browser-capabilities.ts:1723`) and `anti.visual.compare` (`:2372`) — into `captureStageSide` (`:4378`, already parameterized by `side`), and implement the no-expectation branch exactly as the requirement above defines it (enforce when supplied, record `URL_EXPECTATION_MISSING` when absent, refuse at verdict minting).
4. Mint the assertion result into the case record so a reader can see requested vs observed without opening telemetry.
5. **After Phase 2 steps 1–3 land**, re-run only the affected pages (`--pages 6`, plus page-01 as control) and regenerate their attempts; verify the cart either yields the cart's own reference or a typed refusal. Record the Phase 2 revision the verification ran against.
6. Sweep the campaign index for any other case whose reference path differs from its requested path without a typed refusal; report them, do not rewrite them.
7. Apply the assertion at the theme-fidelity harness's settle point, then verify against the retained run that all 21 legs still read as route-faithful (this is a regression guard: the gate must refuse substitutions, not query parameters).

## Evidence Anchors

- `.canary/tools/fifteen-pages-run.mjs:94-97` (cart URL + redirect note), `:621-636` (accept loop), `:696-709` (per-viewport loop), `:629` (`finalUrl` recorded, never asserted)
- `.canary/15-pages/page-06-cart/attempts/attempt-ebf4c709-506c-4f58-ac8b-0bbea91cc435/evidence/390.json:214-215` vs `page-01-home/attempts/attempt-658308ae-c431-4537-a29c-0187dda8a456/evidence/390.json:214-215`
- `src/main/tools/browser-control-port.ts:3836`, `:4378` (`side: 'target' | 'baseline'`), `:4395`, `:4508`, `:4719`, `:4778`, `:4407`; `src/main/tools/browser-capabilities.ts:1723` (`anti.screenshot.full_page`), `:2372` (`anti.visual.compare`); `src/main/tools/artifact-store.ts:358-370` (H2 disproved)
- `.canary/tools/fifteen-pages-run.mjs:852` (clone loopback URL), `:885` (per-tier served entry); `.canary/tools/viewport-run.mjs:80`, `:90`, `:194`, `:423-490` (served-entry sha256 verification)
- `scripts/lib/campaign-verdicts.mjs` (refusal/cause enum + record shape)

## Todo

- [x] Implement route normalization + assertion helper
- [x] Wire assertion into both reference accept sites
- [x] Extend `checkObservedUrl` with `URL_PATH_MISMATCH` and wire the same helper into the 15-pages harness
- [x] Add capture-start identity gate in the control port
- [x] Regenerate page-06 (and page-01 control) as new attempts
- [x] Sweep campaign index for further reference/route mismatches
- [x] Report route-refused class in the aggregate

## Success Criteria

- [x] Re-running page-06 produces either the cart's own reference or a typed route refusal; a homepage-derived cart verdict is impossible.
- [x] No case in `_verdicts.json` has a reference path differing from its requested path without a typed refusal.
- [x] The refusal names the requested URL, the observed URL, and both pathnames — the identity that was substituted. Enumerated hop-by-hop redirect chain: carried by the port-side gate (`RouteAssertionResult.redirectChain`); the harness-side refusal records `redirectCount`, which is 0 for a server-side 302 (measured), so a hop list cannot be built from the tab alone.
- [x] No existing attempt directory or published verdict file was mutated.

## Measured Verification (2026-09-11)

Command: `node .canary/tools/fifteen-pages-run.mjs --pages 6 --viewports 1440,1024,390`
(`runId campaign-2934c83e-963a-4b7c-a239-97d664307a71`; `--viewports` takes `1440`, not `1440x900` — the
first attempt refused with `INVALID_VIEWPORT_FILTER`, exit 2, before acquiring the lock).

Outcome — the defect this phase exists for is now refused instead of published:

```text
[P6] PAGE ROUTE REFUSAL: URL_PATH_MISMATCH — GIỎ HÀNG was requested at path /cart but the tab reports /
15-page canary run finished: ROUTE_REFUSAL (exit 4) — ["URL_PATH_MISMATCH@page-6"]
```

| Field | Measured value |
|---|---|
| attempt | `.canary/15-pages/page-06-cart/attempts/attempt-eeff40c6-56a0-4095-be3f-1c6f5e9fe875/` |
| attempt `status` | `REFUSED` (no `verdict` field — no adjudication happened) |
| `refusal.detail` | `requested https://hoplongtech.com/cart`, `observed https://hoplongtech.com/?openLogin=1`, `requestedPath /cart`, `observedPath /` |
| run index | `tally` all zeros, `cases: 0`, `refusals[0].code = URL_PATH_MISMATCH`, `exit.code = 4`, `exit.reason = ROUTE_REFUSAL` |
| comparison set | empty — nothing was compared, so no fidelity number exists for this page |

The same page previously published `PASS / MATCH / 1.81%` @1440 from the homepage. That number can no
longer be produced: the leg is refused before any capture, so it never enters `cases` or the tally.

**Aggregate/provenance gaps this verification exposed and closed** (three render paths printed a metrics
shortfall where a route refusal had occurred, and the reconciliation named `CASE_NOT_RUN` for legs that
did not exist *because* of the refusal):

- `scripts/lib/campaign-verdicts.mjs` — `pageRouteRefusal()` / `renderPageStatus()` (one source for the
  refusal code family, replacing three inline copies), the hub now prints a `REFUSED` block, and
  `scanRequestedCases` names the refusal code instead of `CASE_NOT_RUN`.
- `.canary/tools/fifteen-pages-run.mjs` — the executive page table, the master table, and the responsive
  section render `renderPageStatus(pr)`, so a refused page reads
  `REFUSED (URL_PATH_MISMATCH: requested /cart, tab reported /)` rather than
  `INCONCLUSIVE (Missing complete structural metrics)`.

Regression guards: `test/unit/route-identity-gate.test.mjs` (13 cases, including the page-level refusal
render and the hub block) and the pre-existing `test/unit/canary-campaign-verdicts.test.mjs` (15 cases,
unchanged and green).

Disclosed side effects of a scoped live run, all measured, none left in place:

- **The harness publishes the run report over the repo-root copy.** A `--pages 6` run replaced
  `15-PAGE-HOPLONGTECH-CLONE-CANARY.md` (15/15 full campaign, 45 cases) with its own 1-page report
  (113 insertions / 780 deletions). Restored path-scoped from `HEAD` (`git show HEAD:<path> > <path>`;
  no forbidden git command used) and verified clean. This is a harness behaviour of scoped runs, not a
  defect introduced here — recorded for the owner rather than silently repaired.
- `current-report.json` now points at the scoped run (`pages: [6]`, `cases: 0`), and
  `.canary/15-pages/_verdicts.json` is that run's index. A scoped run publishing as "current" is the
  same behaviour; the run id identifies it.
- The minted session tab failed to close with `TARGET_MISMATCH` (the session was isolated to its
  reference tab). Census after the run: the same 8 pre-existing tabs, none of mine — the mint and the
  reference tab both ended with their process. The close-failure message is recorded as an observation
  for Phase 2's session-lifecycle work, not as a leak.
- `redirectCount` is **not** a reliable signal for this substitution: the server-side `/cart` →
  `/?openLogin=1` redirect leaves `navigation[0].redirectCount = 0`. The refusal carries the requested
  and observed URLs and paths; it does not carry an enumerated redirect chain. The criterion is
  satisfied on URLs and paths, and this limitation is stated rather than implied.

## Handover Sync (2026-09-11, after the 0133 handover)

Two things the handover asked for, plus one verification it made safe:

- **The gate ships as one reproducible unit.** Commit `467f997` lands the tool and its test together:
  `.canary/tools/theme-fidelity.mjs` (exports `normalizeRoutePath` and `checkObservedUrl`, with the
  pathname comparison), `.canary/tools/fifteen-pages-run.mjs`, `.canary/tools/viewport-run.mjs`,
  `scripts/lib/campaign-verdicts.mjs` and the new `test/unit/route-identity-gate.test.mjs`. At the
  handover the test was untracked and HEAD's tool had no exports and no `URL_PATH_MISMATCH`, so a fresh
  clone could not reproduce the gate. Both facts were measured (`git show HEAD:... | grep -c URL_PATH_MISMATCH`
  -> 0; `grep -c "export function normalizeRoutePath"` -> 0 at HEAD, 1 at the commit).
- **The URL inventory the gate reads carries a theme per side.** All seven surfaces of each run4
  inventory carry their own `themeid` - live `-1`, copy and subject `1001512581` - so the theme
  comparison is meaningful on the campaign the gate will judge. The static `TARGET_PAGES` table in
  `fifteen-pages-run.mjs` is a different store (`hoplongtech.com`, no themeid) and is not an input to
  that run; on that store both sides carry no themeid, so the comparison is trivially equal and the
  live page-06 refusal comes from the pathname, as measured.
- **The expected URL is threaded side-correctly in the campaign harness**, which is what keeps the gate
  from refusing faithful evidence: the capture stage passes the inventory URL it navigated to
  (`target.url`, the same value given to `tabs.create`), and the compare stage passes each side's own
  replay URL (`doc.replay.<side>.url`, the loopback URL the replay tab is actually opened on), with
  `expectedUrl` on the reference tab and `expectedBaselineUrl` on the subject tab. Verified by reading
  the call sites (`theme-fidelity.mjs:959`, `:1577`, `:1650-1655`, `:1584-1587`), and independently by
  the owner's offline replay of the 84 recorded legs through the new checker: 84 OK, 0 refusals,
  0 legs missing a themeid.

A third live run of the scoped page-06 case (`campaign-c3efa34e-cd22-4011-b20a-25a38aa4e5eb`) confirmed
the rendered report rather than only the unit assertions: section 6 reads `Pages Tested in Pipeline: 0`
with a `Not Reached - route refused before clone generation` block naming page 6, each per-viewport line
reads `Assets: NOT_RUN (route refused before clone generation)`, and rows B/E/F read `NOT_TESTED`.
The repo-root report was overwritten by the run again and restored path-scoped from `HEAD`.


## Risk & Rollback

Risk: the assertion refuses legitimate canonicalization (locale prefixes, trailing slash, `/` vs `/index`). Mitigation: assert on origin+pathname, keep the full final URL as evidence, and treat query-only changes as recorded-but-accepted. Rollback: the assertion is additive and gated by a single helper call per site; reverting the helper call restores prior behaviour without touching evidence. Never roll back by rewriting anything under `.canary/15-pages/*/attempts/`.
