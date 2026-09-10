# 2026-09-10 — Campaign evidence provenance: phase 1 executed, blocked before the build stage

Plan: `plans/260910-2008-clone-campaign-evidence-provenance`, phase 1
(`phase-01-evidence-provenance-and-freshness-gate.md`, now `status: blocked`).
Commit: `95e932f` (push `002fe0d..95e932f`).

## Delivered

- **Instance identity has one owner.** `scripts/run-electron.cjs` writes an opt-in record
  (`--state-record` / `ANTIFAN_INSTANCE_RECORD`) atomically and refuses to start when the bridge
  port already has an owner; `canary-session.mjs` validates that record before minting.
- **Shared helpers moved out of the gitignored tree.** `process-identity`, `atomic-record`,
  `campaign-lock`, `evidence-provenance`, `campaign-verdicts`, `build-report` and `canary-floors`
  now live in `scripts/lib/`, so the tracked launcher, generator and tests no longer import files a
  fresh clone does not have. A concurrent writer started this relocation mid-turn; it was committed
  whole (importers, deletions and the four test path updates) rather than left half-applied.
- **Run serialization.** `.canary/15-pages/.campaign.lock` with quarantine-based reclaim; pages build
  into immutable attempt directories; published views are manifest pointers (`current-attempt.json`,
  `current-report.json`).
- **Bundle identity is minted at build time** and verified against the served entry before any
  capture (exit 4, `BUNDLE_IDENTITY_MISMATCH`); a post-run disk change is reported as drift without
  rewriting the recorded identity.
- **Exit status and publication.** Non-zero only for a runner error, an incomplete set of requested
  cases, a provenance refusal or a completed case that carries no provenance; the index is rebuilt
  after the end-of-run census, and the run pointer names the retained report.

## Measured evidence

| Claim | Deciding check |
|---|---|
| Record owns the port | `netstat -ano` → pid 19836 listening on 127.0.0.1:20131; record carries `win32:CreationDate` token |
| Six stale/forged records refused | mint exit 4 with `INSTANCE_RECORD_MISSING`, `INSTANCE_PID_ABSENT`, `INSTANCE_PID_REUSED`, `PORT_OWNED_BY_OTHER_PID`, `PORT_OWNER_UNVERIFIABLE`, `START_TOKEN_UNVERIFIABLE` |
| Launcher port guard | second launcher exited 1, wrote no record |
| Lock reclaim and refusal | planted dead-pid lock reclaimed; concurrent run exit 2 `RUN_IN_PROGRESS` |
| Served-entry gate | fixture copy: admitted case exit 0 with equal entry digests; mutated-after-mint and wrong-declared-entry cases exit 4 with no verdict (`.canary/state/phase1-served-entry-probe.json`) |
| Publication | index rebuilt with `exit {code 1, reason RUNNER_ERROR}`, instance block, start/end tab census; root report byte-identical to the retained copy (`cmp`) |
| Suites | `test/unit/canary-campaign-verdicts.test.mjs` 11/11, `test/unit/canary-evidence-provenance.test.mjs` 13/13, the four relocated path tests exit 0, `npm run compile` exit 0 |

## Blocked

1. **Settle predicate (phase 2).** Every page aborts at the pre-dump settle, so nothing reaches the
   build stage and no campaign case can carry a minted identity. `canary-settle.mjs:184` omits
   `fontsSettled` while `:241` requires it.
2. **Tab quota.** "Restarting the isolated instance and re-minting cleared the quota" is **false**:
   after a restart with a new pid (8560 → 19836), a fresh mint and two successful tab creates, the
   next create was refused `POLICY_DENIED … session tab quota reached` while the session listed none
   of its own tabs. A 45-case campaign therefore cannot run on this instance until the pool is
   cleared out of band — the instance's user-data directory is outside the repository, so that is an
   owner action, not a run step.

Two anti-patterns from earlier runs were confirmed the hard way: a probe's finally-block rewrote a
passing evidence record with an empty one (fixed: never rewrite on zero cases), and a first probe run
reported `runId`/`evidenceRunId` as `null` purely because the probe omitted the env the runner
exports.

## Not verified (needs a page that reaches the build)

`evidence/run-1440.json` with `bundle.entrySha256` equal to that page's minted identity; two
consecutive builds leaving two attempt directories (no unit test either — that mechanism lives in the
runner).

## Docs impact

None: no user-facing behaviour, command or configuration changed.
