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

A verdict is only evidence if it names what it judged. Today no campaign verdict names its clone bundle, three provenance fields are written as `null`, and the saved verdicts describe bundles that were rebuilt one to three hours later. This phase makes provenance mandatory and fail-closed: the identity is **minted at build time** and carried through every downstream document, so nothing downstream re-derives it and no check-then-rebuild window exists.

Baseline this phase also settles the tally disagreement: the same artifacts report 12 FAIL / 32 INCONCLUSIVE by `visual.verdict` and 20 FAIL / 23 INCONCLUSIVE by `run-<vp>.overall` (11 pages mark `capture.valid=false` on a case whose visual verdict is `INCONCLUSIVE`). The canonical index defines one verdict per case and one cause code, and marks all pre-existing evidence `superseded`.

## Requirements

- Bundle identity is **minted once per page build**, immediately after the build stage returns: hash the entry HTML that build just wrote, together with its byte count, generation timestamp and source URL, and persist it as the page's identity record. Minting happens while the build is the only writer of that directory.
- Every downstream writer *carries* the minted identity instead of re-deriving it: `evidence/<vp>.json`, `evidence/run-<vp>.json`, `evidence/summary.json` and the canonical index copy `{entryPath, entrySha256, entryBytes, generatedAt, sourceUrl}` verbatim from that record.
- A verdict is refused with a typed `BUNDLE_IDENTITY_MISMATCH` when the entry actually served to the tab does not equal the minted identity — that means the wrong directory was served, not that evidence is stale. A later on-disk re-hash is a **drift check** (`BUNDLE_DRIFT_AFTER_BUILD`): it marks the run defective and never silently re-identifies a case.
- `.canary/tools/fifteen-pages-run.mjs` exports the same provenance environment `.canary/tools/canary-run.mjs` exports, so `runId`, `evidenceRunId` and `cloneDir` stop being `null`.
- The serving instance is pinned and recorded, with the **launch supervisor as the authority**: the supervisor that starts the isolated instance persists its pid atomically beside the session state, and the session mint validates that the bridge port is owned by that pid before writing a session. A caller never supplies the pin by hand, and a pid is never inferred from whoever happens to be listening.
- `.canary/15-pages/_verdicts.json` exists: one entry per page × viewport with `verdict`, `causeCode`, `bundle`, `instance`, measured reference/clone geometry, and artifact shas; plus a run-level `instance` block and `superseded` markers on legacy evidence.
- The runner's exit status separates process success from verdict: non-zero only for a runner error, an incomplete set of requested cases, or an evidence/provenance refusal. An adjudicable `FAIL` is valid campaign output — recorded in the index and the report while the process exits `0`.
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
2. Mint the identity in the build stage: immediately after `build-clone.mjs` returns for a page, hash the entry it wrote and record `{entryPath, entrySha256, entryBytes, generatedAt, sourceUrl}` as that page's identity. The build is the only writer at that moment, so no rebuild can interleave.
3. Carry it, never re-derive it: pass the minted identity into `viewport-run.mjs` (env or argv), and have every writer copy it into its document. A mismatch between the served entry and the minted identity refuses the case before capture; a post-run disk re-hash only reports drift and never rewrites the recorded identity.
4. Export the provenance environment from the campaign runner to every child (`viewport-run.mjs`, `dump-ref.mjs`, `build-clone.mjs`), matching `canary-run.mjs`.
5. Pin the instance: the launch supervisor writes the pid atomically beside the session state; the session mint validates that the bridge port is owned by that pid before minting. The runner requires the pin, records instance pid, attachment id, run id and attempt id in the run-level provenance, and echoes the pinned pid into every per-case entry.
6. Write `.canary/15-pages/_verdicts.json` at the end of each page (not only at the end of the invocation) so a resumable run always leaves a consistent index. Legacy entries are marked `superseded: true` with the reason (`evidence predates bundle`).
7. Tests (no Electron, deterministic): `node --test test/unit/canary-evidence-provenance.test.mjs`
   - a case whose served entry differs from the minted identity is refused with `BUNDLE_IDENTITY_MISMATCH` and writes no verdict;
   - a case whose served entry matches is admitted and carries non-null `bundle` + `instance` fields;
   - a post-build on-disk change is reported as drift and does **not** change the recorded identity;
   - the canonical index carries exactly one entry per page × viewport and no `null` provenance field;
   - the runner passes the provenance environment to its children (asserted on the built argv/env, without spawning Chromium).
8. Make the runner's exit status reflect the contract above (non-zero only for runner error, incomplete requested cases, or evidence/provenance refusal) and add the start/end tab census to the run provenance.
9. Session renewal only: verify the run uses a session it owns, and re-mint when the lease is stale. Restarting the isolated instance does **not** clear orphaned tabs — measured: after a stop/start with a new pid and a fresh mint, all ten orphans were still listed. Orphan cleanup stays out of band and is an owner action for tab economy, not a run prerequisite: the measured orphans did not block a fresh session's tab create. This phase records both censuses and does not perform cleanup.

## Todo

- [ ] Pin the exact writer field names and the telemetry producer
- [ ] Mint the bundle identity in the build stage
- [ ] Carry the minted identity into every downstream document
- [ ] Add the `BUNDLE_IDENTITY_MISMATCH` refusal and the drift report
- [ ] Export the provenance env from the campaign runner
- [ ] Make the launch supervisor the pid authority and validate port ownership
- [ ] Emit `.canary/15-pages/_verdicts.json` per page, with legacy evidence marked superseded
- [ ] Add and pass `test/unit/canary-evidence-provenance.test.mjs`
- [ ] Prove the refusal end to end on the isolated instance

## Verification

- `node --test test/unit/canary-evidence-provenance.test.mjs` → all cases pass.
- On the pinned isolated instance (bridge 20131, `--allow-eval`), a bounded run produces `evidence/run-1440.json` and `_verdicts.json` entries whose `bundle.entrySha256` equals the identity minted at that page's build, `sha256sum .canary/15-pages/page-02-brands/clone/index.html` agreeing at that instant.
- The fail-closed refusal is proven on a copy: build a fixture directory that points at a copied bundle, change the copy's entry HTML so it no longer matches the minted identity, and observe `BUNDLE_IDENTITY_MISMATCH` with no verdict written. Never mutate a campaign bundle to test this.
- An adjudicable FAIL exits `0` and is published; an incomplete batch exits non-zero, and the run-level provenance records the tab census at start and end.

## Success Criteria

- [ ] No verdict can be written without a build-time-minted bundle identity and a recorded instance identity.
- [ ] `runId`, `evidenceRunId`, `cloneDir` are non-null in campaign evidence.
- [ ] One canonical verdict and cause code per page × viewport exists in one machine-readable index.
- [ ] The fail-closed refusal is demonstrated by an observed run, not by a unit test alone.
- [ ] Exit status encodes process success only: incomplete batches and provenance refusals non-zero, fidelity FAILs zero.

## Rollback

All added fields are additive to the evidence documents. Reverting the phase restores the previous runner behaviour and leaves every existing evidence file readable; `_verdicts.json` can be deleted without touching raw evidence.
