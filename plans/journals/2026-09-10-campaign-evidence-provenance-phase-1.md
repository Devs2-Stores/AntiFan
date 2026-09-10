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
| Three record codes and five stale reasons refused, all exit 4, no session written | `node .canary/state/phase1-refusal-matrix.mjs` → 8/8: codes `INSTANCE_RECORD_MISSING`, `INSTANCE_RECORD_UNREADABLE`, `INSTANCE_RECORD_PORT_MISMATCH`; reasons nested under `INSTANCE_RECORD_STALE`: `INSTANCE_PID_ABSENT`, `START_TOKEN_UNVERIFIABLE`, `INSTANCE_PID_REUSED`, `PORT_OWNER_UNVERIFIABLE`, `PORT_OWNED_BY_OTHER_PID` (matrix in `.canary/state/phase1-refusal-matrix.json`) |
| Launcher port guard | second launcher exited 1, wrote no record |
| Lock reclaim and refusal | planted dead-pid lock reclaimed; concurrent run exit 2 `RUN_IN_PROGRESS` |
| Served-entry gate | fixture copy: admitted case exit 0 with equal entry digests; mutated-after-mint and wrong-declared-entry cases exit 4 with no verdict (`.canary/state/phase1-served-entry-probe.json`) |
| Publication | index rebuilt with `exit {code 1, reason RUNNER_ERROR}`, instance block, start/end tab census; root report byte-identical to the retained copy (`cmp`) |
| Suites | `test/unit/canary-campaign-verdicts.test.mjs` 12/12, `test/unit/canary-evidence-provenance.test.mjs` 13/13, the four relocated path tests exit 0, `npm run compile` exit 0 |

## Blocked

1. **Tab adoption is refused — the current first gate.** A page never reaches settle because its
   first tab is refused: the latest run's report carries one
   `POLICY_DENIED … session tab quota reached; the tab was closed instead of leaking outside the
   session` per attempted page (pages 1 and 9, lines 113 and 196 of the root report), and
   `failedPages: [1, 9]`. So a Phase 2 settle fix alone still cannot run a page; the refusal has to
   be cleared first. "Restarting the isolated instance and re-minting cleared the quota" is **false**:
   after a restart with a new pid (8560 → 19836), a fresh mint and two successful tab creates, the
   next create was refused while the session listed none of its own tabs. The instance's user-data
   directory is outside the repository, so clearing it is an owner action, not a run step.
   The two censuses taken 18 minutes apart are **identical sets** of ten tab ids (full-set diff,
   `n=10` each, 0 ids unique to either), and a run that created and closed its own tabs moved the
   count by zero (start 10, end 10, 0 added, 0 removed — `campaign-aba894a3…` vs `campaign-ee7d3b5f…`).
   Those ten ids are also, as a set, exactly the ten entries in
   `E:\Work\.antifan-canary\saved-tabs.json` (`activeTabId 52c5548b…`).
   **The message is not proof of a quota.** It is fixed text emitted by
   `browser-control-port.ts:2073-2079` whenever `host.adoptChildTab(...)` returns false — and the
   distinct check just above it (`getManagedTabIds(boundTabId).size >= 10`, "Terminal tab limit
   reached") did *not* fire, so the tab count read there was below ten while the adoption still
   failed. `adoptChildTab` (`native-tab-host.ts:4996`) returns false for at least five different
   reasons — no `terminalAgentAffinity`, an empty identifier or child id, a child id not in
   `this.tabs`, no resolvable pool target, or `adoptChildTabForSession` finding `pool.size >= 10`
   (`:4977-4991`) — and the caller cannot tell them apart. The "frozen pool" reading is withdrawn:
   what is proven is ten long-lived tabs in the canary profile, a refusal on the first adoption of
   every attempted page, and a message that names one of several possible causes.
   And `saved-tabs.json` is not the mechanism: `persistTabs()` (`:5693`) writes it *from* the live
   tabs, the only read of it (`:689-712`) takes sidebar geometry, `profile-ownership.ts:45` treats it
   as a profile-state marker, and nothing in `src/` reads `tabs[]` back. Deleting that file therefore
   cannot clear anything; the tabs it lists are the tabs that exist.
   Closing them from a session is not available as a remedy: the plan's fact 13
   (`phase-02-capture-side-blockers.md:54`) already measured that no live session may close them
   (`TARGET_MISMATCH`, scoping rule `browser-control-port.ts:2175-2181`) and that they survive an
   instance stop/start and a fresh mint. That same fact also recorded that they did **not** block a
   fresh session's create after a restart — which is the part the two later runs contradict, and the
   fixed message is exactly what hides whether they, or the pool, did the blocking.
   What the profile shows: the ten ids appear in the control plane's own invocation ledger
   (`control-plane-v2/invocations/attachment-1a5e58d0-4734-4cc9-9b3b-7c5fe7b19368.jsonl`) as the result
   of that attachment's tab listing, and the attachment's `browserTarget.tabId` is
   `1b41d4ff-d186-45cf-9a12-09050b86d858` — the very id the refusal names as the "session". So the
   thing that refuses is a long-lived attachment bound to a stable tab, and its state is persisted
   under the profile's `control-plane-v2/` (the id set is not in `Preferences`, `sessions/`,
   `config/`, `runtime/`, `antifan-recovery.json` or `browser-history.json`).
   So the actionable step is the profile state outside the repository — an owner action — not an
   in-session close; and what re-creates the ten tabs on launch is still unidentified: nothing in the
   repository reads `tabs[]` back from `saved-tabs.json`, so my earlier "the persisted tabs are
   reloaded" reading remains withdrawn rather than replaced by another guess.
2. **Settle predicate (phase 2).** Earlier runs aborted at the pre-dump settle, so nothing reached the
   build stage and no campaign case could carry a minted identity. `canary-settle.mjs:184` omits
   `fontsSettled` while `:241` requires it.

Two anti-patterns from earlier runs were confirmed the hard way: a probe's finally-block rewrote a
passing evidence record with an empty one (fixed: never rewrite on zero cases), and a first probe run
reported `runId`/`evidenceRunId` as `null` purely because the probe omitted the env the runner
exports.

## Not verified (needs a page that reaches the build)

`evidence/run-1440.json` with `bundle.entrySha256` equal to that page's minted identity; two
consecutive builds leaving two attempt directories (no unit test either — that mechanism lives in the
runner).

## Follow-up before freeze (same day)

Three review findings were checked against the tree; two described code that does not
exist here, so nothing changed for them: `procfsClockTicks()` already takes
`execFileSync`'s return value directly (no `{stdout}` destructuring), and
`proveHolderDead()` already performs a fresh OS read at comparison time and compares both
the token and its format, so a later read is exactly what authorises a reclaim. Three
were real:

- `--pages` had two parsers: one lenient list of ids the run iterated, and a separate validation of
  that list. `'1,nonsense'` and `'1,5-3'` both parse to `[1]`, and `'1,'` to `[1,0]`, so a typo ran a
  *subset* of what was asked for while looking deliberate. Parsing and validation are now the same
  function: every comma-separated part must resolve, ranges must be well-formed, and every id must be
  one of the fifteen pages the campaign knows. The run uses exactly those ids. Measured:
  `--pages '1,nonsense' | '1,5-3' | '1,,3' | '1-2-3'` each exit 2 with `INVALID_PAGE_FILTER` and no
  lock file; the previous behaviour for the same inputs took the lock and published a report.
- That measurement also ran `--pages '1,9'` — a *valid* filter, so the campaign really ran pages 1
  and 9, took the lock and republished: run `campaign-ee7d3b5f-7f1a-4929-913f-efb38f036214`, 0/45
  cases, `RUNNER_ERROR` (both pages refused at tab adoption), root report copy updated to it.
  Left as published rather than reverted, since it is a truthful latest run; the run C report stays
  intact in its own retained directory. Lesson recorded: a negative test must use an input that
  cannot be valid, and the unit fixture's three-page world hid that `9` is a real page here.
  What it actually wrote, checked rather than assumed: no `current-attempt.json` for any page (a
  pointer is only written when a page's index publishes), one fresh attempt directory per attempted
  page holding only `evidence/summary.json`, the aggregate `_verdicts.json`/`_hub.html`/`current-report.json`,
  and all fifteen pages marked superseded with "evidence predates any attempt pointer" while
  `pages: []` and `cases: []`. No verdict was published for a case that carried no provenance — the
  invariant held; there was nothing to reconcile.
- Those attempt directories are deliberately kept, not litter: each is the only durable record of a
  failed adoption. Page 9's reads `status: FAILED`, `phases: {}`, `viewports: {}`,
  `errors[0].phase: topLevel` with the `POLICY_DENIED … quota` message, `elapsedSec: 0`, and an empty
  `clone/` — nothing was built and no settle was attempted, which is what establishes that the quota
  refuses *before* the settle gate rather than the other way round. They are not read as evidence,
  because the report resolver follows the pointer and otherwise falls back to the legacy bundle, so
  one directory per attempt is the designed growth rather than a leak.
- A numeric cast in the filter would read `'-1'` as the range 0–1 and `'1e2'` as page 100, and a
  fat-fingered `'1-999999999'` would allocate a billion ids before rejecting them. Parts must now
  match digits only, and a range is range-checked before it is expanded. Measured: all three exit 2
  with `INVALID_PAGE_FILTER` and leave no lock file.
- The refusal matrix could in principle mint into the operator's own instance: a record naming the
  port's real owner with that owner's token satisfies every check and would proceed. Its
  owner-mismatch case is built from *this* instance's identity, and the script now proves before
  running that the operator's port has a different owner than the record it is about to write, and
  that the recorded instance still is the process the record describes.
- The launcher could write an instance record for a child that had already exited while its identity
  was being read. It now skips the write and says so. The race was not reproduced live (there is no
  seam to make Electron exit on demand); the guard is read-verified.
- The active plan still pointed at `.canary/tools/<module>.mjs` for seven helpers that
  moved to `scripts/lib/`; corrected. The closed 260909 plan keeps its historical paths.
- The earlier ownership probe never reached `PORT_OWNED_BY_OTHER_PID`: it failed earlier as
  `INSTANCE_PID_REUSED` because the forged record paired a live pid with another process's token.
  The matrix builds every record from the live record's real token, so that branch is exercised now,
  and the matrix is durable instead of living only in terminal output.

Recorded, not fixed: `resolvePageArtifacts()` trusts the paths inside the attempt pointer,
so a forged `current-attempt.json` could name a location outside that page's attempt
directory. The threat model is a local process that can already write the evidence, and
containment belongs with the Phase 3 reader work.

Recorded, not fixed: the refusal at `browser-control-port.ts:2076` reports a fixed cause whichever
`adoptChildTab` branch failed, so the operator is told "session tab quota reached" even when the tab
was unadoptable for another reason. Returning the actual reason is the prerequisite for naming the
cause of blocker 1; it changes the app's main process and its tests, which is outside this phase.

## Verification runs

- `npm run test:main` → `tests 1077, pass 1076, fail 0, skipped 1`, exit 0 (log `.canary/state/p1-test-main.log`).
- `node --test test/unit/canary-campaign-verdicts.test.mjs test/unit/canary-evidence-provenance.test.mjs` →
  `pass 25, fail 0`, exit 0.
- `.canary/state/phase1-refusal-matrix.mjs` → 8/8 refusals as expected, no session written.

## Instance lifecycle (after the measurements)

The canary instance was shut down through its supervisor, and the launcher's own log records the
record being dropped by that controlled teardown:

```
[run-electron] instance record removed (E:\Work\apps\AntiFan\.canary\state\canary-instance.json)
[antifan-canary: exited; cursor=26955]
```

with `exited exit=0 uptime=28m4s` from the process manager. The file being absent is not the
evidence — this line is; the tail is captured in `.canary/state/phase1-instance-teardown.log`
because the process manager's log store is not part of the repository. Independently: nothing
listens on 20131 and the operator's instance on 20130 (pid 3140) is untouched. So the record
owner's whole cycle — written on launch, validated at mint, dropped on exit — is observed live in
both directions, not just read-verified.

Consequence for the next executor: no canary instance is running, so the refusal matrix exits 1 at
its "no live instance record" gate (measured) and no live run can start. Relaunch with
`node scripts/run-electron.cjs . --allow-eval` and the record env from `.canary/state/instance-env.json`,
then mint a fresh session before any command that touches the bridge.

## Docs impact

None: no user-facing behaviour, command or configuration changed.
