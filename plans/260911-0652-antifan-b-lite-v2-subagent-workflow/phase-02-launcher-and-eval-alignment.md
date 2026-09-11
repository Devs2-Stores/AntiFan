---
title: "Phase 2: Launcher/Eval Alignment & Capture Readiness"
status: todo
---

# Phase 2: Launcher/Eval Alignment & Capture Readiness

## Overview

Two environment defects let Phase 1's route defect survive, and both are prerequisites for any fixer round:

- **Navigation is fire-and-forget.** `navigate()` is synchronous and returns before the load starts (`native-tab-host.ts:3942-3972`), while the control port awaits that boolean and then reads the document generation (`browser-control-port.ts:1229-1232`). `navigateAndWait()` exists (`:3973`) and is already exposed to the automation host (`:522`) but is not used on this path.
- **The capture path has no readiness gate.** `captureVerificationScreenshot` probes only `vw/vh > 0` (`tab-devtools-host.ts:1470-1485`); the wait before it is two animation frames plus 120 ms (`:1431-1436`). `documentGenerations` increments only for non-in-place main-frame navigations (`:3090-3091`) — an SPA `pushState` swap does not bump it — while `semanticDocumentGenerations` does (`:3082-3085`).

On top of that, the launcher/grant surface is asymmetric: `run-antifan.vbs` hardcodes `--allow-eval`, but `scripts/dev.mjs` and `scripts/run-electron.cjs` only forward CLI args, so `npm run dev` runs with `ALLOW_EVAL=false`. Since the MCP proxy registers `grant: 'eval'` hardcoded (`antifan-omp-mcp.cjs:620`), every `write`/`eval` capability is invisible and throws `POLICY_DENIED` (`capability-catalogue.ts:261-267`, `:204`, `:236`) — the builder-fixer's write lever dies on the dev path.

This phase also hosts the **Visual Quiescence Check** accepted in the Round 3 record (recorded there as "Phase 1"); it is placed here because it is a capture-readiness predicate, and Phase 1 is route identity plus forensic closure. Reconciliation note: owner ladder P1 = launcher/eval alignment; this phase is that phase plus the quiescence check.

## Requirements

- [ ] The navigation path used by the control port awaits load completion (use `navigateAndWait`), and a navigation that cannot settle is a typed failure, not an immediate `true`.
- [ ] Capture requires a settled, SPA-aware document generation before rasterizing: `readyState === 'complete'` **and** a stable semantic/mutation revision, with the observed values recorded as evidence.
- [ ] Visual quiescence is a predicate with a named failure: media frozen, fonts settled, images settled, geometry stable, and no structural mutation across the observation window. The failing flag is recorded on refusal — never discarded.
- [ ] The predicates are **evaluated at capture entry**, not merely persisted: font readiness via `document.fonts`, image readiness via `complete && naturalWidth > 0`, media frozen, geometry stable across the window, and structural mutations quiet. Harness and port use the *same* predicate expressions so they cannot disagree.
- [ ] The fixer's capability surface is file-only (Phase 3 contract, Phase 4 enforcement): nothing in this phase may grant the fixer an eval-wide surface merely to make writing work.
- [ ] Every launcher that can start a session with the MCP proxy either grants what the fixer needs or documents the withheld class; `run-antifan.vbs`, `npm run dev`, `npm start`, `npm run start:prod` are each characterized.
- [ ] The fixer session is minted with a capability **name filter** admitting only `file.read` + `file.write`, and the proxy stops hardcoding `grant: 'eval'` for fixer sessions. Measured why the name filter is required and not merely nice: `isVisible` (`capability-catalogue.ts:261-268`) filters by risk class plus `allowEval` only, so `grant:'write'` hides every `risk:'eval'` tool yet still exposes `anti.theme.style_override`, `anti.agent.cursor.*`, `browser.dump_dom`, `theme.qa_repair.*` and `browser.agent-sequence`; no name-level allowlist exists anywhere in `src`/`scripts` today, so this phase builds one rather than assuming it.
- [ ] **Two distinct failure classes are owned here, not conflated.** (a) *Harness renewal*: `.canary/tools/theme-fidelity.mjs:1263` raises `NotMeasurable('SESSION_RENEWAL_FAILED')` from `renewSession` when the mint child exits non-zero, and `plans/reports/260911-1310-theme-fidelity-run4-verdicts.md:226` records a full run losing **6 of its 21 legs** to it (11 of 42 earlier), each a `read ECONNRESET` on the renewal mint before any measurement. **Two levers are already on disk and must not be re-implemented: the ordering fix is committed (`874060e`, mint before the previous tab closes, `theme-fidelity.mjs:1265-1268`) and the bounded transport-only retry is uncommitted at HEAD `c714892` (`MINT_ATTEMPTS = 3`, `MINT_RETRY_GAP_MS = 3_000`, attempts recorded into `record.sessionRenewal`, `:1156-1157`, `:1242-1264`; `git diff` = 21 insertions / 5 deletions). Its validating fixture was launched (`pairfix-out2`) and the transcript ends before any outcome, so the retry's effect is unmeasured — the first action here is to measure it, not to write it.** **The retry is the canonical starting implementation, not a draft to be replaced: it is measured, not rewritten. Before any validation run it is pinned — committed path-scoped (`git add -f` for `.canary/**`) or superseded in writing — and the receipt records the instrument revision (`git rev-parse HEAD` plus the file's content hash), so no verdict ever cites an unpinned working state.** The remaining lever is the report's third item, per-pair lifecycle isolation. (b) *Product quota*: `browser-control-port.ts:2061` throws `POLICY_DENIED 'Terminal tab limit reached (maximum 10 tabs per session)'` when `getManagedTabIds(boundTabId).size >= 10`, and a tab it cannot adopt is closed rather than leaked. The report is explicit that (b) is **per bound session** and therefore does not cause (a); the earlier causal link between them was wrong and is not repeated here. **Acceptance: a 4-pair run measures all four pairs with no `SESSION_RENEWAL_FAILED`, quota exhaustion surfaces as the product's typed `POLICY_DENIED` (never as a page verdict), and the managed-tab census returns to baseline.**
- [ ] Image identity is part of settlement: when `imageSetHash` moves while document geometry holds (observed class `article__1024x900`: `docHeight 4821` and `scrollWidth 1024` constant), the capture is refused with the moving witness named rather than measured as fidelity.
- [ ] **The shared browser plane is single-runner.** `antifan-canary` is a hub-managed Electron plane shared with other sessions; `hub ps` lists hub-managed processes only, and a peer session's in-flight compare does **not** appear there — the report's own resume notes say to check `hub list` for peers too, because two concurrent browser-plane runs corrupt both verdict sets (`260911-1310-…:289-298`; observed `antifan-canary: ready pid=22136`). A run therefore refuses to launch when a peer or another run may be in flight, and the receipt records the idle check. Operational constraints from the same section are binding on the loop: never edit `.canary/tools/**` while a run is in flight (one variable per run), `git add -f` for `.canary/**`, and never signal-kill the plane — `hub restart antifan-canary` is the lifecycle lever.
- [ ] Session minting cost is explicit: measured, `--no-tools` does not disable MCP tools, so any session that can reach the proxy can mint a tab; the fixer session is minted without `anti_browser_tabs_list`/tab-opening tools in its allowlist, and its census delta is recorded in the receipt.

## Implementation Steps

1. Switch the control port's navigation to `navigateAndWait` and return the settled generation; keep `TARGET_STALE` semantics for a failed load and add the timeout as a typed cause rather than a silent boolean.
2. Add a readiness assertion to the capture entry: read `readyState`, the semantic document generation, and a mutation revision; require completion plus an unchanged revision across a bounded window before `Page.captureScreenshot`.
3. Extend the existing settle/flag reporting so a refusal persists the per-flag result (the current shape can persist an empty `stages` object).
4. Port the quiescence predicate expressions from `.canary/tools/canary-settle.mjs` into the capture path (or call the same module) and evaluate them at capture entry; a false predicate refuses with its name and measurement. Do not write a second predicate definition — harness and port must share one.
5. Characterize each launcher: run each entry point and record whether `file.write` is visible/executable and what error a denied call returns; write the result into the phase report.
6. Add the test that fails if the documented policy drifts from the observed one.
7. Verify against a live tab: navigate to a route that redirects and to a route that swaps in-page, and confirm capture cannot fire before the settled generation in either case.
8. Implement the name filter in the session mint / capability list, mint the fixer session with it (admitting only `file.read` + `file.write`), and prove a forbidden write-class call in that session is refused — this is the layer that raises `REFUSED_TOOL_SURFACE`, since no file audit can see a runtime override.
9. Close the renewal gap: settle the superseded session's teardown before the next mint, add a bounded transport-only mint retry, and isolate per-pair lifecycle so one reset cannot cost the pairs that follow; verify with the 4-pair case that currently refuses pairs 3–4, checking the managed-tab census before and after and that no leg is lost to `SESSION_RENEWAL_FAILED`.

## Evidence Anchors

- `src/main/browser/native-tab-host.ts:3942-3972`, `:3973`, `:522`, `:3082-3085`, `:3090-3091`
- `.canary/tools/theme-fidelity.mjs:1156-1157` (`MINT_ATTEMPTS`, `MINT_RETRY_GAP_MS`), `:1242-1268` (`renewSession`: bounded retry + ordered mint), `:959`, `:1632`; committed baseline HEAD `c714892` with 21 uncommitted insertions in this file
- `.canary/tools/theme-fidelity.mjs:1263` (`SESSION_RENEWAL_FAILED`), `renewSession`/`readSupersededSession`; `plans/reports/260911-1310-theme-fidelity-run4-verdicts.md:226`, `:233-235`, `:289-298`
- `src/main/tools/browser-control-port.ts:1229-1232`, `:2055-2080` (per-bound-session tab quota + refuse-to-leak), `:3836`, `:4407`
- `src/main/browser/tab-devtools-host.ts:1431-1436`, `:1470-1485`
- `run-antifan.vbs:3`; `scripts/dev.mjs:27-31`, `:108`; `scripts/run-electron.cjs:20-30`; `package.json` scripts; `src/main/index.ts:67-71`
- `scripts/antifan-omp-mcp.cjs:620`; `src/main/tools/capability-catalogue.ts:261-267`, `:204`, `:236`
- `.canary/tools/canary-settle.mjs` (existing flag predicates + throw site)

## Todo

- [x] Route control-port navigation through `navigateAndWait`
- [ ] Add document-generation + mutation-revision readiness assertion to capture
- [x] Persist the failing settle/quiescence flag on refusal
- [ ] Characterize `--allow-eval` / grant behaviour for all four launchers
- [ ] Add the launcher/grant policy test
- [ ] Live-verify redirect and in-page-swap capture ordering
- [x] Build the capability name filter in the mint/list path
- [x] Mint the fixer session with the name filter (`file.read`/`file.write` only)
- [ ] Close the renewal gap (measure landed reorder+retry, add per-pair isolation)
- [ ] Add the shared-plane single-runner launch gate (`hub ps` + `hub list`)
- [x] Assert image identity in the settlement predicate

## Success Criteria

- [ ] A capture cannot rasterize before the settled generation, demonstrated on a redirect route and an in-page swap route.
- [ ] A readiness refusal records which predicate failed and its measurement.
- [ ] The launcher/grant matrix is measured and covered by a test; the fixer's write path is known-good on the launcher the loop uses.
- [ ] The fixer session's name filter is enforced live: a forbidden write-class call in that session is refused with `REFUSED_TOOL_SURFACE` at the mint/guard layer, and no file-effect audit is claimed to catch it.
- [ ] A 4-pair run measures all four pairs: a failed renewal is typed `SESSION_RENEWAL_FAILED` (harness, `NotMeasurable`) and quota exhaustion is the product's `POLICY_DENIED` — neither is ever reported as a page failure, and the managed-tab census returns to baseline.
- [ ] The renewal retry's effect is measured on a **clean** fixture (one not inherited from an aborted compare) with `sessionRenewal.attempts` recorded in the verdict document, the ordered mint reported as implemented-and-measured rather than as open work, and the instrument revision pinned (committed or explicitly superseded) before the run.
- [ ] The run gate is demonstrated: a launch attempted while a peer run may be in flight is refused with the idle check recorded, and `hub ps` alone is explicitly not accepted as proof of idleness.
- [ ] A capture whose `imageSetHash` moves while document geometry holds is refused with the moving witness named.
- [ ] A capture with any quiescence predicate false is refused with that predicate named, and harness and port evaluate the same predicate set.
- [ ] No timeout was inflated and no tolerance changed to reach these results.

## Measured Progress (2026-09-11)

This phase is **partially landed**; the checkboxes above mark only what is measured.

Delivered and measured:

- **Control-port navigation awaits load.** `browser-control-port.ts:1237-1241` routes through
  `this.host.navigateAndWait` when the host exposes it. Measured at HEAD as well as in the tree, so the
  plan's premise ("not used on this path") was already stale when this phase was written - the anchor
  is recorded here rather than re-implemented.
- **A readiness refusal names the predicate that failed.** `capture-settle.ts` keeps `failingPredicate`
  and the port maps it to a typed capture code (`tab-devtools-host.ts:1504-1513`):
  `imageIdentityStable` -> `IMAGE_IDENTITY_UNSTABLE`, `documentGenerationSettled` ->
  `DOCUMENT_GENERATION_UNSETTLED`, otherwise `CAPTURE_NOT_READY`, with the predicate, pane and reason in
  the message. Document-generation readiness is asserted (`documentGenerationSettled`,
  `capture-settle.ts:426, :563, :595`). Before this, the consumer compared against
  `imageIdentity`/`documentGeneration`, which the producer never emits, so both branches were dead.
- **Image identity is part of settlement** (`imageIdentityStable`, `capture-settle.ts:426`), and its
  failure is no longer folded into a generic refusal.
- **The session name filter exists and is enforced** - `capability-catalogue.ts` gained
  `SessionCapabilityFilter`, `matchCapabilityPattern` and `isCapabilityNamePermitted`;
  `bridge-server.ts` registers the filter per attachment and refuses a call outside it with
  `REFUSED_TOOL_SURFACE` before dispatch. Measured end to end: a launched fixer session reports
  `grant=write`, `allowed=file.read,file.write` (the launcher passes the filter into `startSession`).
- **The fixer's permitted surface has one source.** The launcher and the MCP proxy no longer carry
  their own `['file.read','file.write']` copy; both read `DEFAULT_PERMITTED_TOOLS` from
  `.canary/tools/fix-loop/audits.mjs`, and a fixer session refuses to launch when that policy cannot be
  loaded rather than granting an unstated surface. The launcher previously crashed on every start
  (`targetGrant`/`allowedCaps` were only in scope inside the session-acquisition loop); a static scan
  (`tsc --allowJs --checkJs`, TS2304) found eight such references, all now resolved.

Still open, deliberately not ticked:

- **Mutation-revision readiness.** `mutationRevision` is not read in `capture-settle.ts`; only
  `documentGenerationSettled` is asserted. The SPA-swap leg of this requirement is unmet.
- **Launcher characterization matrix and its policy test.** The launchers were aligned
  (`run-antifan.vbs`, `scripts/dev.mjs`, `scripts/run-electron.cjs` carry the dev-mode flag coherently),
  but no measured matrix of "is `file.write` visible/executable and what does a denied call return"
  exists, and `test/unit/launch-guard.test.mjs` covers compiled-bundle freshness, not grants. A test
  that fails on grant-policy drift is still missing.
- **Live in-page-swap capture ordering.** The redirect leg is verified (page-06 refuses at reference
  init); an SPA swap that does not bump the generation was not exercised.
- **Renewal gap.** The ordered mint and the bounded transport-only retry (`MINT_ATTEMPTS = 3`) are the
  owner's landed work and are measured at fixture scale only; the residual `read ECONNRESET` is an
  unproven transport defect and is not closed at campaign scale.
- **Shared-plane single-runner launch gate.** Not implemented. Idleness is still an operator check
  (`hub ps` for the plane **and** `hub list` for peers); no run refuses to launch on a peer run, and
  the launch receipt carries no idle check.


## Risk & Rollback

Risk: `navigateAndWait` changes timing for every existing caller of the port's navigate path, which may surface latent waits elsewhere. Mitigation: keep the sync `navigate` available for callers that need fire-and-forget, and change only this path; make the timeout explicit and typed. Rollback: the two changes are separable (navigation await, capture readiness) and each is a single call-site change; reverting either restores the prior behaviour without touching evidence.
