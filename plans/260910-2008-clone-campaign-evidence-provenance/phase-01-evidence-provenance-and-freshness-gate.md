---
phase: 1
title: "Evidence Provenance & Freshness Gate"
status: pending
priority: P0
effort: "3h"
dependencies: []
---

# Phase 1: Evidence Provenance & Freshness Gate

## Overview

A verdict is only evidence if it names what it judged. Today no campaign verdict names its clone bundle, three provenance fields are written as `null`, and the saved verdicts describe bundles that were rebuilt one to three hours later. This phase makes provenance mandatory and fail-closed: every verdict carries the bundle identity it measured and the instance that served it, and a verdict whose bundle no longer matches fails the run instead of being written.

Baseline this phase also settles the tally disagreement: the same artifacts report 12 FAIL / 32 INCONCLUSIVE by `visual.verdict` and 20 FAIL / 23 INCONCLUSIVE by `run-<vp>.overall` (11 pages mark `capture.valid=false` on a case whose visual verdict is `INCONCLUSIVE`). The canonical index defines one verdict per case and one cause code, and marks all pre-existing evidence `superseded`.

## Requirements

- Bundle identity is recorded in `evidence/<vp>.json`, `evidence/run-<vp>.json` and `evidence/summary.json`: `bundle.entryPath`, `entrySha256`, `entryBytes`, `generatedAt`, `sourceUrl`.
- A verdict is refused with a typed `BUNDLE_IDENTITY_MISMATCH` when the served bundle's `index.html` does not hash to its generation telemetry, or when the viewport document names a bundle that is not the one served.
- `.canary/tools/fifteen-pages-run.mjs` exports the same provenance environment `.canary/tools/canary-run.mjs` exports, so `runId`, `evidenceRunId` and `cloneDir` stop being `null`.
- The serving instance is pinned and recorded: `ANTIFAN_BRIDGE_PID` is required by the runner, and the run-level provenance records instance pid, attachment id, run id and attempt id. The pid is resolved, not guessed: the session mint (`.canary/tools/canary-session.mjs`) or the launch step resolves the process listening on the bridge port and writes it into `.canary/state/`, so the runner can require the pin without a caller supplying it by hand.
- `.canary/15-pages/_verdicts.json` exists: one entry per page × viewport with `verdict`, `causeCode`, `bundle`, `instance`, measured reference/clone geometry, and artifact shas; plus a run-level `instance` block and `superseded` markers on legacy evidence.
- The runner's exit status reflects its outcome: non-zero when it produces fewer cases than requested or when any case FAILs, so an aborted batch cannot look like a clean run.
- Session state is recorded per run and reset between runs: attachment id, bound tab id, and the tab census at start and end (`anti.browser.tabs.list` for the instance plane, `browser.list-tabs` for the session scope). A dead session's quota must not be able to refuse the next run.

## Related Code Files

- `.canary/tools/fifteen-pages-run.mjs` — per-page pipeline, `run-<vp>.json` (stage 14), `summary.json` (stage 15 `finally`), aggregate writer
- `.canary/tools/viewport-run.mjs` — writes `evidence/<vp>.json` including `runId` / `evidenceRunId` / `cloneDir`
- `.canary/tools/build-clone.mjs` — already emits `entryBytes` / `entrySha256` into `evidence/build-telemetry.json`
- `.canary/tools/canary-run.mjs` — the arm that already exports `CANARY_AUTHORITY_RUN_ID` / `CANARY_EVIDENCE_RUN_ID` / `CANARY_CLONE_DIR`
- `.canary/tools/canary-client.mjs` — resolves `.canary/state/canary-session.json` and the pinned instance
- `test/unit/canary-evidence-provenance.test.mjs` — new

## Implementation Steps

1. Read the three writers and the telemetry producer, and pin down the exact field names: `viewport-run.mjs` (the `<vp>.json` object literal), `fifteen-pages-run.mjs` (the `run-<vp>.json` and `summary.json` literals), `build-clone.mjs` (`entryBytes` / `entrySha256`).
2. Add a single bundle-identity resolver used by all three writers: resolve the bundle directory actually served (`clone/` for 1440 and 1024, `clone/mobile/` for 390), read the generation telemetry that produced it, hash the entry HTML, and compare with the telemetry hash and byte count.
3. Fail closed on mismatch: status `BUNDLE_IDENTITY_MISMATCH` with the expected and observed hashes, no verdict field populated.
4. Export the provenance environment from the campaign runner to every child (`viewport-run.mjs`, `dump-ref.mjs`, `build-clone.mjs`), matching `canary-run.mjs`.
5. Require `ANTIFAN_BRIDGE_PID`, and add the resolver that supplies it: the session mint (`.canary/tools/canary-session.mjs`) resolves the process listening on the bridge port and writes the pid into `.canary/state/`, so the runner never depends on a caller passing it by hand. Record instance pid, attachment id, run id and attempt id in the run-level provenance, and echo the pinned pid into every per-case entry.
6. Write `.canary/15-pages/_verdicts.json` at the end of each page (not only at the end of the invocation) so a resumable run always leaves a consistent index. Legacy entries are marked `superseded: true` with the reason (`evidence predates bundle`).
7. Tests (no Electron, deterministic): `node --test test/unit/canary-evidence-provenance.test.mjs`
   - a case whose entry hash disagrees with telemetry is refused with `BUNDLE_IDENTITY_MISMATCH` and writes no verdict;
   - a case whose entry hash matches is admitted and carries non-null `bundle` + `instance` fields;
   - the canonical index carries exactly one entry per page × viewport and no `null` provenance field;
   - the runner passes the provenance environment to its children (asserted on the built argv/env, without spawning Chromium).
8. Make the runner's exit status reflect its outcome (non-zero when fewer cases were produced than requested, or any case FAILed) and add the start/end tab census to the run provenance.
9. Session renewal only: verify the run uses a session it owns, and re-mint when the lease is stale. Restarting the isolated instance does **not** clear orphaned tabs — measured: after a stop/start with a new pid and a fresh mint, all ten orphans were still listed. Orphan cleanup stays out of band and is an owner action for tab economy, not a run prerequisite: the measured orphans did not block a fresh session's tab create. This phase records both censuses and does not perform cleanup.

## Todo

- [ ] Pin the exact writer field names and the telemetry producer
- [ ] Add the bundle-identity resolver and the `BUNDLE_IDENTITY_MISMATCH` refusal
- [ ] Export the provenance env from the campaign runner
- [ ] Require and record the pinned instance identity
- [ ] Emit `.canary/15-pages/_verdicts.json` per page, with legacy evidence marked superseded
- [ ] Add and pass `test/unit/canary-evidence-provenance.test.mjs`
- [ ] Prove the refusal end to end on the isolated instance

## Verification

- `node --test test/unit/canary-evidence-provenance.test.mjs` → all cases pass.
- On the pinned isolated instance (bridge 20131, `--allow-eval`), a bounded run produces `evidence/run-1440.json` and `_verdicts.json` entries whose `bundle.entrySha256` equals `sha256sum .canary/15-pages/page-02-brands/clone/index.html`.
- The fail-closed refusal is proven on a copy: build a fixture directory that points at a copied bundle, change the copy's entry HTML so its hash no longer matches the recorded telemetry, and observe `BUNDLE_IDENTITY_MISMATCH` with no verdict written. Never mutate a campaign bundle to test this.
- A batch that produces fewer cases than requested exits non-zero, and the run-level provenance records the tab census at start and end.

## Success Criteria

- [ ] No verdict can be written without a verified bundle hash and a recorded instance identity.
- [ ] `runId`, `evidenceRunId`, `cloneDir` are non-null in campaign evidence.
- [ ] One canonical verdict and cause code per page × viewport exists in one machine-readable index.
- [ ] The fail-closed refusal is demonstrated by an observed run, not by a unit test alone.
- [ ] A batch that produced fewer cases than requested exits non-zero, and each run records its start/end tab census.

## Rollback

All added fields are additive to the evidence documents. Reverting the phase restores the previous runner behaviour and leaves every existing evidence file readable; `_verdicts.json` can be deleted without touching raw evidence.
