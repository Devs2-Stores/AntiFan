---
title: "Phase 5: Capture Truth & Freezes"
status: todo
---

# Phase 5: Capture Truth & Freezes

## Overview

Screenshot capture is the worst-performing surface in the whole system, and it is
not one defect but two independent ones that compound:

| Measurement (baseline, session logs 2026-09-17/18) | Value |
|---|---|
| `anti.screenshot.viewport` error rate | 62/80 = **77.5%** |
| `anti.screenshot.full_page` error rate | 11/14 = **78.6%** |
| `anti.theme.qa_validate` error rate (consumes captures) | 32/70 = 45.7% |
| overall tool error rate | 605/6536 = 9.3% |

**Mechanism 1 — the freeze does not cover the animation classes that keep the
compositor producing frames.** The freeze path pauses media elements and SVG SMIL
(`injected-script-store.ts:109-121`, `pauseAnimations()`), and per-element CSS
animation state, but nothing walks `document.getAnimations()` and pauses WAAPI
animations (`Element.animate(...)`). `browser-control-port.ts:2048-2052` states
the consequence in its own words: a capture that rasterizes while media plays
"never gets a stable frame, so `Page.captureScreenshot` waits out its whole bound
and the target is left draining" — which then quarantines the target and produces
`TARGET_BUSY_DRAINING` on every later call. A WAAPI animation is indistinguishable
from a playing video in this respect, and the census already knows how to see them
(`document.getAnimations()` — used for diagnosis at `browser-control-port.ts:1137`,
and per-element at `:339-343` and `:4072-4075` — but never for freezing).

**Mechanism 2 — the diagnosis names a class that is not present, so the agent
retries the wrong remedy.** The audit's measured example: a page whose animation is
WAAPI reports a media/CSS remedy. The message is not merely unhelpful, it is
falsifiable: the same census that produced it can see which class is actually
running.

Note on the third observation in the audit — `StabilityPolicyEvaluator`
(`stability-policy.ts`) defaults `requireMediaFreeze: true`, yet has **0 production
consumers**, so it is a policy that has never run. Turning it into a hard gate
*before* R2-R4 land would break captures that currently succeed, which is why this
phase ends with the gate, not with it.

## Requirements

- **R1** The capture census reports per-class counts, not a single boolean:
  playing/ready media by tag, CSS animations with no end, **WAAPI animations**
  (via `document.getAnimations()`, classified by its real class — `Animation` vs
  `CSSAnimation`), and SVG SMIL.
- **R2** The freeze covers every class the census can report: for every running
  animation from `document.getAnimations()`, pause it for the capture window.
  Record how many were paused and restore exactly those on **every** exit path,
  which is the existing `finally` — no new lifecycle.
- **R3** `anti.screenshot.full_page` runs the same freeze as
  `anti.screenshot.viewport`. Both capabilities share one capture primitive;
  the full-page path must not be a separate freeze policy.
- **R4** `isMediaFrozen` becomes a measurement, not a claim: the receipt carries
  the observed state at raster time (counts before/after, animations paused and
  restored). `stability-policy.ts:91` may only gate on a value that R4 makes
  truthful.
- **R5** `diagnosis.remedy` is branched from the census that was just taken: the
  remedy names the dominant class present, and for a static page asserts no
  animation class at all. A remedy naming an absent class is a defect of this
  phase, not a cosmetic issue.
- **R6** Policy identity: the capture receipt policy identity is bumped with this
  phase so pre-freeze baselines are **not** comparable. `anti.visual.compare`
  across the boundary must refuse or label, never silently diff.
- **R7** The gate comes last and only on evidence: `requireMediaFreeze` may be
  enforced once R1-R6 are live and the soak shows captures settling. The
  `StabilityPolicyEvaluator` still gets no production consumer in this phase
  unless that evidence exists.
- **R8** No error that is a genuine drain is masked by the freeze: phase 4's typed
  `TARGET_BUSY_DRAINING` stays reachable and truthfully reported when a target is
  actually poisoned.

## Design decisions

1. **One census feeding three consumers.** The census is already the input to
   diagnosis; R1 makes it also the input to the freeze (what to pause) and to the
   receipt (what was frozen). Three call sites, one derivation — the failure mode
   this phase fixes exists precisely because those three derived separately.
2. **Pause by handle, not by re-query.** Restore only the animation handles this
   capture paused; a blanket `play()` would restart animations the page itself had
   paused, which is a visible behaviour change on the user's live tab.
3. **Never hide a drain behind the freeze.** A target poisoned by an earlier
   timeout stays quarantined with its typed error; the freeze is not a retry tier
   (the existing comment at `tab-devtools-host.ts:2046` forbids a second
   `Page.captureScreenshot` on a poisoned queue, and that rule stands).
4. **Scope the freeze to the capture window.** The user's tab is live; the freeze
   must be invisible outside the raster, which the existing `finally` release
   already guarantees for media — R2 extends that guarantee to WAAPI.

## Related code files

- Modify: `src/main/tools/browser-control-port.ts` — census (`~1118-1200`),
  freeze invocation (`~2048-2100`), full-page path (`~2498-2560`), drain/quarantine
  handoff (`~2368-2410`, `~5540-5560`).
- Modify: `src/main/scripts/injected-script-store.ts` — the injected freeze script
  (SVG SMIL today; extend to `document.getAnimations()`).
- Modify: `src/main/verification/visual-capture.ts` — envelope fields for the
  freeze receipt (`VerificationCaptureEnvelope`, `~861-900`) and its policy
  identity.
- Read-only unless R7 lands: `src/main/verification/stability-policy.ts`
  (`requireMediaFreeze`, `MEDIA_ACTIVE`).
- Create: `test/main/capture-freeze-classes.test.ts` (fixture pages: infinite
  WAAPI, infinite CSS, SMIL, static).
- Region ownership: this plan owns these regions until phase 5 is verified; the
  `TARGET_BUSY_DRAINING` throw sites belong to phase 4.

## Implementation steps

1. Re-verify each anchor above by symbol (`getAnimations`, `pauseAnimations`,
   `captureVerificationScreenshot`, `MEDIA_ACTIVE`) — never by the line numbers in
   this document.
2. R1: extend the census with the WAAPI class and per-class counts; return the
   class names it actually observed plus the element handles it counted.
3. R5: branch `diagnosis.remedy` on that census; assert in a test that a static
   page yields no animation remedy.
4. R2: in the injected freeze, walk `document.getAnimations()`, pause each running
   animation, count them, and restore the same handles in the release path.
5. R3: route the full-page capability through the same freeze primitive; assert in
   the test that both capabilities pause the same classes.
6. R4: carry `isMediaFrozen` (observed) plus paused/restored counts into the
   envelope; R6: bump the policy identity and make `visual.compare` refuse
   cross-boundary baselines.
7. Probe all of it on the real app (see Success criteria), then — and only then —
   evaluate R7.

## Todo

- [ ] Census reports WAAPI/CSS/SMIL classes with counts
- [ ] `diagnosis.remedy` branches on observed classes
- [ ] Freeze pauses `document.getAnimations()` handles and restores them
- [ ] Full-page path shares the freeze primitive
- [ ] `isMediaFrozen` observed at raster time in the envelope
- [ ] Capture policy identity bumped; cross-boundary compare refuses
- [ ] Live probes on the real app (WAAPI page, CSS page, static page)

## Success criteria

- [ ] A page with an infinite WAAPI animation completes **both**
      `anti.screenshot.viewport` and `anti.screenshot.full_page` within bound, and
      the receipt names `Animation` as the frozen class (today: bound timeout,
      then target quarantine).
- [ ] A page with only an infinite CSS animation reports a CSS remedy and captures;
      a static page reports **no** animation class in the remedy.
- [ ] Animations paused by the freeze are running again after the call returns
      (verified in the same probe by sampling `document.getAnimations()` after).
- [ ] Zero `TARGET_BUSY_DRAINING` on targets that were never poisoned — and the
      typed code still fires for a genuinely poisoned target (phase 4 probe).
- [ ] `anti.visual.compare` refuses a baseline taken before the policy bump.
- [ ] Capture cluster error rate on a comparable session **< 20%** (from 77-79%)
      at the phase-10 soak; `npm run compile` and the unit suite pass with no test
      widened.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Freezing WAAPI changes pixels, invalidating every stored baseline. | R6: bump the receipt policy identity in the same change and refuse cross-boundary comparison; baselines taken before this phase are labelled non-comparable by design. |
| `getAnimations()` on a heavy page is expensive inside the capture window. | The census already runs there; the freeze reuses its result rather than walking the DOM twice. |
| Restoring animations restarts ones the page had paused. | Pause/restore by handle only for animations this capture paused (design decision 2). |
| The freeze hides a real drain and masks a broken target. | Design decision 3 + acceptance criterion 4 keep the typed drain error reachable. |
| Rollback | Revert the four files; the injected script is versioned with the app, so a rollback removes the behaviour with no residual state (no new persisted field). |
