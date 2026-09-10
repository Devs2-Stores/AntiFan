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

- **Each page build writes to an attempt-scoped, immutable directory**, and that exact path is what gets served. Today the runner serves a fixed unlocked path (`fifteen-pages-run.mjs:392`, `cloneDir = <pageDir>/clone`; built at `:536`, served at `:560`) and there is no lock primitive anywhere in the runner, the builder, the viewport runner or the RPC lib, so a concurrent or resumed invocation can rebuild a page between its mint and its capture. The build target becomes `<pageDir>/attempts/<attemptId>/clone/` (and `…/clone/mobile/` for the 390 tier), written once and never rewritten; the static server serves that directory, and every consumer that today derives `<pageDir>/clone` resolves the path from the page's identity record instead. The migration list is small and explicit: `fifteen-pages-run.mjs:392` / `:536` / `:560`, the `clone/mobile/index.html` gate in `viewport-run.mjs:274-277`, the bundle resolver in `build-report.mjs`, and the hand-made `_hub.html` (regenerated, or marked stale).
- Bundle identity is **minted immediately after that build returns**, over the attempt path it just wrote: hash the entry HTML together with its byte count, generation timestamp, source URL and attempt id, and persist it as the page's identity record. Nothing rewrites an attempt directory, so the mint cannot be invalidated by a later build of the same page.
- **The run lock serializes invocations.** Even with immutable attempts, two runs must not interleave: `_verdicts.json`, the per-page evidence and the aggregate are single-writer documents. The run acquires `.canary/15-pages/.campaign.lock` — beside the artifacts it protects — with `openSync(path, 'wx')`, holding `{runId, attemptId, pid, startedAt, pages}`, before its first build, and holds it through every build, capture and publication. A live holder refuses the second invocation with `RUN_IN_PROGRESS` and prints the holder's identity; a resumed run takes the same lock, so it cannot overlap the run it resumes. Release happens on controlled exits (`finally`, signal handlers, normal termination); a hard kill leaves the lock behind, and the next run **reclaims** it when the recorded holder is no longer alive (pid liveness plus a `startedAt` sanity bound) — reporting the reclaimed holder rather than failing closed on a stale file forever.
- **Per-page artifacts live in the attempt and are published atomically.** Each attempt directory holds that attempt's evidence (`attempts/<id>/evidence/**`) as well as its bundle; the page's stable `evidence` view is published by atomic replace once its cases are complete, and the canonical index records the attempt it points at. A crashed or superseded attempt therefore cannot half-overwrite published evidence, and the report resolves artifacts through the identity record rather than a fixed path. The run-scoped aggregate is written under `.canary/15-pages/reports/<runId>/` and published to the repository root by atomic replace.
- **Even an unlocked writer cannot produce a verdict about a bundle it did not measure.** The entry served to the clone tab is verified against the minted identity at capture start; a mismatch yields `BUNDLE_IDENTITY_MISMATCH` and no verdict, instead of a comparison against a bundle the run never built.
- Every downstream writer *carries* the minted identity instead of re-deriving it: `evidence/<vp>.json`, `evidence/run-<vp>.json`, `evidence/summary.json` and the canonical index copy `{entryPath, entrySha256, entryBytes, generatedAt, sourceUrl, attemptId}` verbatim from that record.
- A verdict is refused with a typed `BUNDLE_IDENTITY_MISMATCH` when the entry actually served to the tab does not equal the minted identity — that means the wrong directory was served, not that evidence is stale. A later on-disk re-hash is a **drift check** (`BUNDLE_DRIFT_AFTER_BUILD`): it marks the run defective and never silently re-identifies a case.
- `.canary/tools/fifteen-pages-run.mjs` exports the same provenance environment `.canary/tools/canary-run.mjs` exports, so `runId`, `evidenceRunId` and `cloneDir` stop being `null`.
- **Instance identity has one owner and a real persistence protocol.** Today no component persists a pid: `scripts/run-electron.cjs` spawns the Electron child and tracks `child.pid` only for teardown (79 lines, no writes), `instance-env.json` has a reader (`.canary/tools/build-report.mjs`) but no producer, and `.canary/tools/canary-session.mjs:118-119` writes its session with a bare `writeFileSync`. The owner becomes the launcher `scripts/run-electron.cjs`, which is the only process that knows `child.pid` and whose lifetime equals the instance's: after a successful spawn it writes `.canary/state/canary-instance.json` = `{instancePid, supervisorPid, port, startedAt, envFingerprint}` using **temp-file + rename in the same directory** (write `.tmp-<supervisorPid>`, `fsync`, `fs.renameSync` onto the final path), and deletes the record on clean child exit. It refuses to start when the bridge port already has an owner, so the record is never written by a second launcher.
- **The session mint validates that record instead of trusting it.** `canary-session.mjs` refuses to mint (typed `INSTANCE_RECORD_STALE`, no session written) unless the record exists, its `instancePid` is alive, and the process owning the listening socket on `port` **is** that pid — port ownership by the same pid is what defeats pid reuse, and a dead pid, a foreign port owner or a missing record all fail closed. The session file itself is written atomically by the same temp+rename protocol and carries `instancePid`, `instanceStartedAt` and `bridgePort`, so every verdict can echo them.
- `.canary/15-pages/_verdicts.json` exists: one entry per page × viewport with `verdict`, `causeCode`, `bundle`, `instance`, measured reference/clone geometry, and artifact shas; plus a run-level `instance` block and `superseded` markers on legacy evidence.
- The runner's exit status separates process success from verdict: non-zero only for a runner error, an incomplete set of requested cases, or an evidence/provenance refusal. An adjudicable `FAIL` is valid campaign output — recorded in the index and the report while the process exits `0`.
- Session state is recorded per run and reset between runs: attachment id, bound tab id, and the tab census at start and end (`anti.browser.tabs.list` for the instance plane, `browser.list-tabs` for the session scope). A dead session's quota must not be able to refuse the next run.

## Related Code Files

- `.canary/tools/fifteen-pages-run.mjs` — per-page pipeline, `run-<vp>.json` (stage 14), `summary.json` (stage 15 `finally`), aggregate writer
- `.canary/tools/viewport-run.mjs` — writes `evidence/<vp>.json` including `runId` / `evidenceRunId` / `cloneDir`
- `.canary/tools/build-clone.mjs` — already emits `entryBytes` / `entrySha256` into `evidence/build-telemetry.json`
- `.canary/tools/canary-run.mjs` — the arm that already exports `CANARY_AUTHORITY_RUN_ID` / `CANARY_EVIDENCE_RUN_ID` / `CANARY_CLONE_DIR`
- `scripts/run-electron.cjs` — the launcher, and the instance-record owner (new write path)
- `.canary/tools/canary-session.mjs` — the atomic session writer and record validator
- `.canary/state/canary-instance.json`, `.canary/state/canary-session.json` — the instance and session records
- `.canary/15-pages/.campaign.lock` — the run lock, beside the artifacts it protects
- `.canary/15-pages/<page>/attempts/<attemptId>/clone/`, `…/evidence/` — the immutable served bundle and that attempt's evidence; the legacy `<pageDir>/clone/` and `<pageDir>/evidence/` paths become published views, not write targets
- `test/unit/canary-evidence-provenance.test.mjs` — new

## Implementation Steps

1. Read the three writers and the telemetry producer, and pin down the exact field names: `viewport-run.mjs` (the `<vp>.json` object literal), `fifteen-pages-run.mjs` (the `run-<vp>.json` and `summary.json` literals), `build-clone.mjs` (`entryBytes` / `entrySha256`).
2. Acquire the run lock, then build to the attempt path: take `.canary/15-pages/.campaign.lock` (exclusive create before the first build; released on controlled exits, reclaimed by the next run when the recorded holder is dead) and move the build target to `<pageDir>/attempts/<attemptId>/clone/` — updating `fifteen-pages-run.mjs:392/536/560`, the mobile gate in `viewport-run.mjs:274-277`, the `build-report.mjs` bundle resolver, and `_hub.html` (regenerated, or marked stale) — then mint the identity over the entry that build wrote: `{entryPath, entrySha256, entryBytes, generatedAt, sourceUrl, attemptId}`. Nothing rewrites an attempt directory, so no later build can invalidate the mint.
3. Carry it, never re-derive it: pass the minted identity and the attempt path into `viewport-run.mjs` (env or argv), and have every writer copy the identity into its document. That attempt's evidence is written inside its own directory and the page's stable `evidence` view is published by atomic replace when the page completes; the served entry is verified against the minted identity at capture start, so a mismatch refuses the case before capture, and a post-run disk re-hash only reports drift without rewriting the recorded identity.
4. Export the provenance environment from the campaign runner to every child (`viewport-run.mjs`, `dump-ref.mjs`, `build-clone.mjs`), matching `canary-run.mjs`.
5. Own the instance record: extend `scripts/run-electron.cjs` with an **opt-in** state-record path (`--state-record <path>` or `ANTIFAN_INSTANCE_RECORD`), which it writes atomically after a successful spawn (temp file in the same directory, `fsync`, `renameSync`), removes on exit **only if the record still names that child**, and refuses to start when the bridge port already has an owner. Extract the temp+rename writer into one shared helper used by both the launcher and the mint, so no writer hand-rolls it.
6. Validate, then mint: `canary-session.mjs` requires a fresh record whose `instancePid` is alive and owns the listening socket on `port` (fail closed with `INSTANCE_RECORD_STALE`), then writes the session atomically with `instancePid`, `instanceStartedAt` and `bridgePort` included. Tests cover a dead pid, a foreign port owner, a missing record, and a torn-write window.
7. Write `.canary/15-pages/_verdicts.json` at the end of each page (not only at the end of the invocation) so a resumable run always leaves a consistent index. Legacy entries are marked `superseded: true` with the reason (`evidence predates bundle`).
8. Tests (no Electron, deterministic): `node --test test/unit/canary-evidence-provenance.test.mjs`
   - a case whose served entry differs from the minted identity is refused with `BUNDLE_IDENTITY_MISMATCH` and writes no verdict;
   - a case whose served entry matches is admitted and carries non-null `bundle` + `instance` fields;
   - a post-build on-disk change is reported as drift and does **not** change the recorded identity;
   - a second invocation while the run lock is held is refused with `RUN_IN_PROGRESS` and writes nothing, while a lock whose recorded holder is dead is **reclaimed** and the reclaim is reported;
   - two builds of the same page produce two distinct attempt directories, the older attempt is byte-identical afterwards, and each verdict names the attempt it measured;
   - a stale record (dead pid, foreign port owner, absent file) refuses the mint with `INSTANCE_RECORD_STALE` and leaves no session file;
   - a failed write leaves the previous record intact — the writer is asserted through its seam, not by spawning Electron;
   - the canonical index carries exactly one entry per page × viewport and no `null` provenance field;
   - the runner passes the provenance environment to its children (asserted on the built argv/env, without spawning Chromium).
9. Make the runner's exit status reflect the contract above (non-zero only for runner error, incomplete requested cases, or evidence/provenance refusal) and add the start/end tab census to the run provenance.
10. Session renewal only: verify the run uses a session it owns, and re-mint when the lease is stale. Restarting the isolated instance does **not** clear orphaned tabs — measured: after a stop/start with a new pid and a fresh mint, all ten orphans were still listed. Orphan cleanup stays out of band and is an owner action for tab economy, not a run prerequisite: the measured orphans did not block a fresh session's tab create. This phase records both censuses and does not perform cleanup.

## Todo

- [ ] Pin the exact writer field names and the telemetry producer
- [ ] Take the run lock and build into attempt-scoped directories
- [ ] Migrate the served-path consumers to the attempt path
- [ ] Mint the bundle identity in the build stage
- [ ] Carry the minted identity into every downstream document
- [ ] Add the `BUNDLE_IDENTITY_MISMATCH` refusal and the drift report
- [ ] Export the provenance env from the campaign runner
- [ ] Make the launcher own the instance record, written atomically
- [ ] Validate the record in the mint and write the session atomically
- [ ] Emit `.canary/15-pages/_verdicts.json` per page, with legacy evidence marked superseded
- [ ] Add and pass `test/unit/canary-evidence-provenance.test.mjs`
- [ ] Prove the refusal end to end on the isolated instance

## Verification

- `node --test test/unit/canary-evidence-provenance.test.mjs` → all cases pass.
- On the pinned isolated instance (bridge 20131, `--allow-eval`), a bounded run produces `evidence/run-1440.json` and `_verdicts.json` entries whose `bundle.entrySha256` equals the identity minted at that page's build, and `sha256sum` of that attempt's served entry (`.canary/15-pages/page-02-brands/attempts/<attemptId>/clone/index.html`) agrees at that instant.
- `.canary/state/canary-instance.json` exists with an `instancePid` that owns port 20131 (`netstat -ano` agrees), and the session file names the same pid.
- A second invocation launched while the first holds `.canary/15-pages/.campaign.lock` exits non-zero with `RUN_IN_PROGRESS` and writes no evidence; a hard-killed holder leaves the file behind and the next run reports reclaiming it.
- Two consecutive builds of one page leave two attempt directories, the first byte-identical, and the verdict records the second's path and hash.
- The fail-closed refusal is proven on a copy: build a fixture directory that points at a copied bundle, change the copy's entry HTML so it no longer matches the minted identity, and observe `BUNDLE_IDENTITY_MISMATCH` with no verdict written. Never mutate a campaign bundle to test this.
- A forged record with a dead pid or a port owned by another process refuses the mint with `INSTANCE_RECORD_STALE` and writes no session.
- An adjudicable FAIL exits `0` and is published; an incomplete batch exits non-zero, and the run-level provenance records the tab census at start and end.

## Success Criteria

- [ ] No verdict can be written without a build-time-minted bundle identity and a recorded instance identity.
- [ ] `runId`, `evidenceRunId`, `cloneDir` are non-null in campaign evidence.
- [ ] One canonical verdict and cause code per page × viewport exists in one machine-readable index.
- [ ] A stale or unverifiable instance record cannot produce a session, and no writer writes a record or a session non-atomically.
- [ ] Concurrency is safe by construction: a live run lock refuses a second invocation, and no rewrite can happen under a minted identity because each build owns a fresh attempt directory.
- [ ] The fail-closed refusal is demonstrated by an observed run, not by a unit test alone.
- [ ] Exit status encodes process success only: incomplete batches and provenance refusals non-zero, fidelity FAILs zero.

## Rollback

All added fields are additive to the evidence documents. Reverting the phase restores the previous runner behaviour and leaves every existing evidence file readable; `_verdicts.json` and the instance record can be deleted without touching raw evidence.
