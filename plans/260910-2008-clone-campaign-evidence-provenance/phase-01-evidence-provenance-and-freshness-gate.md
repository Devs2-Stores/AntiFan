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
- **One campaign lock serializes invocations.** Even with immutable attempts, two runs must not interleave: `_verdicts.json`, the per-page evidence and the aggregate are all shared writers. The run acquires `.canary/15-pages/.campaign.lock` — a single lock beside the artifacts it protects, never per-page — via `openSync(path, 'wx')` holding `{runId, attemptId, pid, startedAt, pages}`, **before any mutation**: before recording provenance, before the first build, before any capture and before any publication. It is held through the final index and report write and released in the top-level `finally` (signal handlers release on controlled termination). A live holder refuses the second invocation with `RUN_IN_PROGRESS` and prints the holder's identity; a resumed run takes the same lock, so it cannot overlap the run it resumes. A hard kill leaves the file behind, and the next run reclaims it only after **proving the recorded holder dead** — never from file age. A bare pid cannot prove that. The holder is live **iff** the pid exists *and* that process's start time equals the one recorded in the lock; the same pid with a different start time is a different process (pid reuse) and the lock is reclaimed. That comparison goes through one new shared helper, `.canary/tools/process-identity.mjs`, with explicit platform adapters — **Windows**: `powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=<pid>').CreationDate"`; **POSIX**: `/proc/<pid>/stat` field 22 converted with `btime` and `CLK_TCK`, falling back to `ps -o lstart= -p <pid>` where `/proc` is absent — and it stores the raw OS value next to the derived ISO timestamp so the test is an equality, not a re-parse. Today only pid existence exists (`scripts/antifan-agent.cjs:138`, `process.kill(pid, 0)`), which cannot distinguish a reused pid; this helper becomes the single authority. The reclaim is reported, so a stale file is never a permanent dead end.
- **Per-page artifacts live in the attempt; the published view is a manifest pointer.** Each attempt directory holds that attempt's evidence (`attempts/<id>/evidence/**`) as well as its bundles — desktop at `attempts/<id>/clone/` and mobile at `attempts/<id>/clone/mobile/`, each built from its own reference. Publication is a tiny pointer file written temp-file → `fsync` → `rename`: `<page>/current-attempt.json` names the attempt id, entry path, entry hash and evidence root, and `.canary/15-pages/current-report.json` names the published run report. Readers — the report generator, the index, `_hub.html` — resolve immutable artifacts through those pointers instead of through a directory that gets replaced, because directory and symlink replacement is not reliably atomic on Windows whereas a pointer rewrite is. A crashed or superseded attempt therefore cannot half-overwrite the published view, and nothing reads a fixed evidence path.
- **Even an unlocked writer cannot produce a verdict about a bundle it did not measure.** The entry served to the clone tab is verified against the minted identity at capture start; a mismatch yields `BUNDLE_IDENTITY_MISMATCH` and no verdict, instead of a comparison against a bundle the run never built.
- Every downstream writer *carries* the minted identity instead of re-deriving it: the attempt's `<vp>.json`, `run-<vp>.json` and `summary.json` — named relative to that attempt's evidence root (`attempts/<id>/evidence/`), never to the legacy fixed `evidence/` directory — and the canonical index copy `{entryPath, entrySha256, entryBytes, generatedAt, sourceUrl, attemptId, evidenceRoot}` verbatim from that record. `_verdicts.json` stores the attempt id and that pointer; no writer copies an artifact back into a legacy fixed path.
- A verdict is refused with a typed `BUNDLE_IDENTITY_MISMATCH` when the entry actually served to the tab does not equal the minted identity — that means the wrong directory was served, not that evidence is stale. A later on-disk re-hash is a **drift check** (`BUNDLE_DRIFT_AFTER_BUILD`): it marks the run defective and never silently re-identifies a case.
- `.canary/tools/fifteen-pages-run.mjs` exports the same provenance environment `.canary/tools/canary-run.mjs` exports, so `runId`, `evidenceRunId` and `cloneDir` stop being `null`.
- **Instance identity has one owner and a real persistence protocol.** Today no component persists a pid: `scripts/run-electron.cjs` spawns the Electron child and tracks `child.pid` only for teardown (79 lines, no writes), `instance-env.json` has a reader (`.canary/tools/build-report.mjs`) but no producer, and `.canary/tools/canary-session.mjs:118-119` writes its session with a bare `writeFileSync`. The owner becomes the launcher `scripts/run-electron.cjs`, which is the only process that knows `child.pid` and whose lifetime equals the instance's: after a successful spawn it writes `.canary/state/canary-instance.json` = `{instancePid, supervisorPid, port, startedAt, envFingerprint}` using **temp-file + rename in the same directory** (write `.tmp-<supervisorPid>`, `fsync`, `fs.renameSync` onto the final path), and deletes the record on clean child exit. It refuses to start when the bridge port already has an owner, so the record is never written by a second launcher.
- **The session mint validates that record instead of trusting it.** `canary-session.mjs` refuses to mint (typed `INSTANCE_RECORD_STALE`, no session written) unless the record exists, its `instancePid` is alive, and the process owning the listening socket on `port` **is** that pid — port ownership by the same pid is what defeats pid reuse, and a dead pid, a foreign port owner or a missing record all fail closed. The session file itself is written atomically by the same temp+rename protocol and carries `instancePid`, `instanceStartedAt` and `bridgePort`, so every verdict can echo them.
- `.canary/15-pages/_verdicts.json` exists: one entry per page × viewport with `verdict`, `causeCode`, `bundle`, `instance`, measured reference/clone geometry, and artifact shas; plus a run-level `instance` block and `superseded` markers on legacy evidence.
- The runner's exit status separates process success from verdict: non-zero only for a runner error, an incomplete set of requested cases, or an evidence/provenance refusal. An adjudicable `FAIL` is valid campaign output — recorded in the index and the report while the process exits `0`.
- Session state is recorded per run and reset between runs: attachment id, bound tab id, and the tab census at start and end (`anti.browser.tabs.list` for the instance plane, `browser.list-tabs` for the session scope). A dead session's quota must not be able to refuse the next run.

## Related Code Files

- `.canary/tools/fifteen-pages-run.mjs` — per-page pipeline, `run-<vp>.json` (stage 14), `summary.json` (stage 15 `finally`), aggregate writer
- `.canary/tools/viewport-run.mjs` — writes the per-viewport `evidence/<vp>.json` (today relative to the page directory; the target is that attempt's evidence root) including `runId` / `evidenceRunId` / `cloneDir`
- `.canary/tools/build-clone.mjs` — already emits `entryBytes` / `entrySha256` into `evidence/build-telemetry.json`
- `.canary/tools/canary-run.mjs` — the arm that already exports `CANARY_AUTHORITY_RUN_ID` / `CANARY_EVIDENCE_RUN_ID` / `CANARY_CLONE_DIR`
- `scripts/run-electron.cjs` — the launcher, and the instance-record owner (new write path)
- `.canary/tools/canary-session.mjs` — the atomic session writer and record validator
- `.canary/state/canary-instance.json`, `.canary/state/canary-session.json` — the instance and session records
- `.canary/15-pages/.campaign.lock` — the run lock, beside the artifacts it protects
- `.canary/15-pages/<page>/attempts/<attemptId>/clone/`, `…/clone/mobile/`, `…/evidence/` — the immutable bundle, mobile sibling and evidence of one attempt; `<page>/current-attempt.json` and `.canary/15-pages/current-report.json` — the published views (pointer files). The legacy `<pageDir>/clone/` and `<pageDir>/evidence/` are read-only history: nothing writes or maintains them
- `.canary/tools/process-identity.mjs` — new: the pid + process-start-time predicate (Windows `Get-CimInstance Win32_Process`, POSIX `/proc/<pid>/stat` / `ps`), the single authority for both the lock reclaim and the session record check (`scripts/antifan-agent.cjs:138` has pid existence only)
- `test/unit/canary-evidence-provenance.test.mjs` — new

## Implementation Steps

1. Read the three writers and the telemetry producer, and pin down the exact field names: `viewport-run.mjs` (the `<vp>.json` object literal), `fifteen-pages-run.mjs` (the `run-<vp>.json` and `summary.json` literals), `build-clone.mjs` (`entryBytes` / `entrySha256`).
2. Acquire the run lock as the run's first action, before any write: take `.canary/15-pages/.campaign.lock` (exclusive create via `openSync(path,'wx')`; released in the top-level `finally`; reclaimed only after `.canary/tools/process-identity.mjs` proves the holder dead — pid gone, or that pid now owned by a different start time) and move the build target to `<pageDir>/attempts/<attemptId>/clone/` — updating `fifteen-pages-run.mjs:392/536/560`, the mobile gate in `viewport-run.mjs:274-277`, the `build-report.mjs` bundle resolver, and `_hub.html` (regenerated, or marked stale) — then mint the identity over the entry that build wrote: `{entryPath, entrySha256, entryBytes, generatedAt, sourceUrl, attemptId}`. Nothing rewrites an attempt directory, so no later build can invalidate the mint.
3. Carry it, never re-derive it: pass the minted identity and the attempt path into `viewport-run.mjs` (env or argv), and have every writer copy the identity into its document. That attempt's evidence is written inside its own directory, and when the page completes the published view is re-pointed by rewriting `<page>/current-attempt.json` (temp-file → `fsync` → `rename`); the served entry is verified against the minted identity at capture start, so a mismatch refuses the case before capture, and a post-run disk re-hash only reports drift without rewriting the recorded identity.
4. Export the provenance environment from the campaign runner to every child (`viewport-run.mjs`, `dump-ref.mjs`, `build-clone.mjs`), matching `canary-run.mjs`.
5. Own the instance record: extend `scripts/run-electron.cjs` with an **opt-in** state-record path (`--state-record <path>` or `ANTIFAN_INSTANCE_RECORD`), which it writes atomically after a successful spawn (temp file in the same directory, `fsync`, `renameSync`), removes it on controlled exit and **only if the record still names that child**, and refuses to start when the bridge port already has an owner. Extract the temp+rename writer into one shared helper used by both the launcher and the mint, so no writer hand-rolls it.
6. Validate, then mint: `canary-session.mjs` requires a fresh record whose `instancePid` is alive **with a matching process start time** (`process-identity.mjs`, so a reused pid cannot validate) and owns the listening socket on `port` (fail closed with `INSTANCE_RECORD_STALE`), then writes the session atomically with `instancePid`, `instanceStartedAt` and `bridgePort` included. Tests cover a dead pid, a reused pid with a mismatched start time, a foreign port owner, a missing record, and a torn-write window.
7. Write `.canary/15-pages/_verdicts.json` at the end of each page (not only at the end of the invocation) so a resumable run always leaves a consistent index. Legacy entries are marked `superseded: true` with the reason (`evidence predates bundle`).
8. Tests (no Electron, deterministic): `node --test test/unit/canary-evidence-provenance.test.mjs`
   - a case whose served entry differs from the minted identity is refused with `BUNDLE_IDENTITY_MISMATCH` and writes no verdict;
   - a case whose served entry matches is admitted and carries non-null `bundle` + `instance` fields;
   - a post-build on-disk change is reported as drift and does **not** change the recorded identity;
   - a second invocation while the run lock is held is refused with `RUN_IN_PROGRESS` and writes nothing; a lock whose holder pid is gone is **reclaimed** and the reclaim is reported; a lock whose pid is alive but whose recorded start time differs (pid reuse) is likewise reclaimed; a lock naming a live pid with a matching start time is never reclaimed;
   - two builds of the same page produce two distinct attempt directories, the older attempt is byte-identical afterwards, and each verdict names the attempt it measured;
   - one attempt carries both viewport bundles — desktop at `clone/` and mobile at `clone/mobile/`, each built from its own reference — and the pointer file names that attempt;
   - an interrupted page leaves the previous `current-attempt.json` intact, so the previous attempt's evidence stays resolvable through it;
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
- On the pinned isolated instance (bridge 20131, `--allow-eval`), a bounded run produces `evidence/run-1440.json` and `_verdicts.json` entries whose `bundle.entrySha256` equals the identity minted at that page's build, and the shared hashing helper (`crypto.createHash('sha256')` over the entry bytes — cross-platform, no `sha256sum`) reports the same digest for that attempt's served entry at that instant.
- `.canary/state/canary-instance.json` exists with an `instancePid` that owns port 20131 (`netstat -ano` agrees), and the session file names the same pid.
- A second invocation launched while the first holds `.canary/15-pages/.campaign.lock` exits non-zero with `RUN_IN_PROGRESS` and writes no evidence; a hard-killed holder leaves the file behind, and the next run reclaims and reports it only after `process-identity.mjs` shows that pid gone or now carrying a different start time.
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
