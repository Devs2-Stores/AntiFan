# Autonomous optimization loop — bottleneck ledger (8 iterations)

- **Goal:** drive the repository's own bottleneck registry to zero open defects, with verified fixes only.
- **Scope:** `plans/bottlenecks.json` rows, the code and tests they name, and the gates in `package.json`. Nothing outside the repository root was written.
- **Verify (metric):** `node scripts/check-bottlenecks.mjs --json`, counted two ways:
  - `status === "open"` — the registry field: **13 → 6**.
  - rows whose verdict is `OPEN` (defect present *and* claimed open, machine-checked against HEAD): **6 → 0**.
- **Guard:** `npx tsc -p ./` (exit 0), `npm run audit` (exit 0), `npm run plans:check` (exit 0), plus the focused lane for every touched module.
- **Direction:** lower. **Min delta:** 1. **Iteration budget:** 20. **Iterations used:** 8 kept, 1 discarded.
- **Record:** `.canary/state/loop-results.tsv` (iter, timestamp, metric, delta, kept, description).

## Why the metric is reported twice

`status === "open"` is a field the loop itself edits, and 7 of the 13 baseline rows carry `manual`
predicates. `scripts/check-bottlenecks.mjs:213-222` never compares a manual row's status to presence —
it only warns — so flipping a manual row to `closed` would move the field-only count with no code
change and leave the audit green. The verdict-based count cannot be moved that way: `open` requires
`present === true`, i.e. the row's own predicate still firing at HEAD
(`scripts/check-bottlenecks.mjs:229-233`). Both numbers are reported, and the one that means something
is the second.

## Iterations

| # | Row | Change | Commit | status-open | machine-open |
|---|---|---|---|---|---|
| 1 | B18 | `verify` typechecked the program twice — dropped the direct `npm run typecheck`; `npm test` still compiles (`tsc -p ./`) first | `f33c932` | 13 → 12 | 6 → 5 |
| 2 | B6 | Retention was declared but never enabled in production. Made the sweep policy-aware, then enabled it in `resolveArtifactStoreOptionsFromEnv` | `2da0036` | 12 → 11 | 5 → 4 |
| 3 | B5 | The launcher guarded the compiled entry with `existsSync` only, so a stale bundle launched silently. Added `scripts/launch-guard.cjs` and wired `main.cjs` to build in dev / refuse in a packaged app | `43bbf62` | 11 → 10 | 4 → 3 |
| 4 | B14 | The sweeper matched `*.artifact` only. It now also prunes a run's `index.json` once that run holds no captures, and documents that workspace-owned annotations/snapshots are out of scope | `7354aae` | 10 → 9 | 3 → 2 |
| 5 | B22 | Plan `status:` frontmatter was consumed by nothing. Added `scripts/check-plans.mjs` (bucket + reject unknown spellings) and wired `plans:check` into `verify`; the row's `manual` predicate was replaced by a machine check on the consumer | `f0c3475` | 9 → 8 | 2 |
| 6 | B16 | Refuted with a machine predicate instead of deleted: `scripts/cdp` is an external override hook (`injected-script-store.ts:57-62`, `:399-403`; `dev.mjs:33-36`, `:226-228`), so an empty in-tree directory is its normal state | `d14cf7e` | 8 → 7 | 2 → 1 |
| 7 | B25 | The canary report tests drove untracked `.canary/run3`. Vendored the real evidence documents into `test/fixtures/canary-run/` (11 JSON files, 647 KiB, PNGs excluded) and repointed both tests | `026f6b7` | 7 → 6 | 1 → 0 |
| 8 | B6 | Made the exemption policy-derived rather than inferred from `kind` (see below) — correctness of iteration 2, no metric movement | `cbbdde7` | 6 | 0 |
| — | B16 (first pass) | Discarded: an early read of the row suggested deleting the `scripts/cdp` branch. Investigation showed the hook is live; no code was deleted | — | unchanged | — |

## Iteration 8 — the retention exemption is derived from the declared policy

Iteration 2 shipped a working but blunt rule: `kind === 'report'` artifacts are exempt. That over-protects
`theme.qa_validate` and `workflow.execute` reports, which their capabilities declare `run-durable`, and it
infers permanence from `kind` instead of reading it. The contract now carries it:

- `ArtifactRetentionPolicy` (`control-plane-contracts.ts`) is a named type, reused by `CapabilityEffectPolicy`;
- `ArtifactRef.retentionPolicy?` records what the staging caller declared, and `ArtifactStore.stage` accepts it;
- `sweepRetention` exempts `retentionPolicy === 'permanent'`, **and** — as a migration guard — a `kind: 'report'`
  artifact with no recorded policy, because index entries written before the field existed would otherwise be
  swept on the first production run;
- the policy is declared where it is known: `artifact-capabilities.ts:162` (one constant read by both the
  capability policy and its stage call), `workflow-engine.ts:282` (`run-durable`, the workflow's own report),
  `workflow-engine.ts:605` (`permanent`, the `report.generate` step, which mirrors the capability),
  `theme-qa-workflow.ts:683` (`run-durable`).

**Behaviour change, disclosed:** with the sweep now enabled, run-durable reports (workflow final reports,
theme-QA reports) are pruned after the 24 h / 200 MB ceilings are exceeded. That is what their declared
capability policy says; previously nothing was ever swept. Permanent `report.generate` evidence is exempt,
and pre-policy index entries are protected by the migration guard. The test asserts all three outcomes.

## Advisory round (post-iteration-5)

| Advisory | Disposition |
|---|---|
| Guard inverts: fixing a defect makes `npm run audit` fail `FIXED_UNRECORDED` until the row flips | Already honoured by construction — every iteration committed its registry closure in the same commit as its fix, so `audit` exited 0 each time. The invariant is now stated here and grounded at `check-bottlenecks.mjs:229-233`. |
| The metric must not come from the status field | Adopted; both counts are published and the verdict-based count is the one treated as real. |
| Skip B29 in one iteration | Agreed and deferred — 23 routing rows need per-row behaviour proofs, and the routing table is the surface this session's own tools dispatch through. |
| B16 is a false positive; flipping status alone yields `REFUTED_BUT_PRESENT` | Agreed — no hook deleted, and the row was refuted by rewriting its predicate to the live invariant (negated, so the audit fails if the resolution path disappears). |
| Derive the exemption from `retentionPolicy` instead of `kind` | Implemented as iteration 8, with the pre-policy legacy guard kept deliberately (deleting a report that predates the field would be data loss). |
| `launch-guard` ignores explicitly named config files | Already fixed inside iteration 3: the first test run returned `fresh` instead of `stale` for a newer `tsconfig.json`; the file branch now always counts, and the test pins it. |
| Vendor the real evidence for B25 rather than synthesizing | Adopted — the fixture keeps real-data fidelity, the dead `leaseToken` in `pipeline.json` was replaced with a fixed placeholder before commit, and no PNG is committed. |

## Verification at close

Every lane run once after the last code change; exit codes read bare.

| Lane | Tests | Pass | Fail | Skip | Exit |
|---|---|---|---|---|---|
| `test:canary` | 144 | 144 | 0 | 0 | 0 |
| `test:fast` | 451 | 451 | 0 | 0 | 0 |
| `test:site-clone` | 108 | 108 | 0 | 0 | 0 |
| `test:integration` | 13 | 13 | 0 | 0 | 0 |
| `test:main` | 1086 | 1085 | 0 | 1 | 0 |
| `test:terminal-rename` (Electron launch path) | — | — | — | — | 0 |
| `npx tsc -p ./` · `npm run audit` · `npm run plans:check` | — | — | — | — | 0 · 0 · 0 |
| Registry verdict tally at HEAD | `{CLOSED: 23, REFUTED_OK: 4, MANUAL: 8}` | — | — | — | audit 0 |

Logs: `.canary/state/loop-final-*.log`, `loop-iter5-canary.log`, `loop-b25-*.log`, `loop-policy-*.log`,
`loop-b16-audit.log`. `test:e2e` was not re-run inside the loop; the Electron launch path it depends on is
covered by `test:terminal-rename`, which exits 0 with the changes applied, and no e2e-lane file was touched.

## Deferred rows (open, with reason and next step)

- **B19 / B20 (P1/P2, theme QA)** — `manual` predicates; re-verification needs a live storefront run (a
  page with periodic animation for the settle gate; a page taller than 16384 px for the capture ceiling).
- **B21 (P2, hygiene)** — 57 PNG and 14 MD files at the repository root. User-owned files; moving them is
  not this loop's call.
- **B23 (P1)** — closure needs a campaign run whose verdict set is not refused. The last one refused both
  sets (see B30 and the Haravan fidelity run).
- **B25's siblings** — none; B25 is closed by the tracked fixture.
- **B29 (P2, mcp)** — `node scripts/check-mcp-budget-dominance.mjs` reports 23 routing rows that shadow a
  catalogue registration. Retiring one requires an `omp-mcp-adapter` case proving the dispatched name change
  is behaviour-preserving; several `anti.*` aliases are independent reimplementations with different defaults.
- **B30 (P1)** — `anti.visual.compare` normalisation exceeds its 15 s bound, so `capture.valid === false` and
  the desktop/tablet cases are `CAPTURE_INVALID`. The fix is a faster normalisation; raising the bound would
  relax a fidelity assertion and is out of scope for this loop.

## Disclosures

- **Metric exhaustion.** Machine-checked open rows are 0. The 6 remaining `status: "open"` rows are all
  `manual` — they can only move through live campaign runs, per-row behaviour proofs, or user-owned files.
  The loop stopped there and reports the exhausted state instead of padding iterations.
- **Two tracked files were already dirty** before the loop began (`plans/260905-0012-.../live-theme-proof.json`,
  `plans/reports/mcp-overhaul-benchmark.json`, both rewritten by suites). They remain untouched and uncommitted.
  Every commit names its paths explicitly; no `git add -A`, no reset, no force push.
- **`kongming` is not dispatchable** in this environment; no tier-escalated review was performed for the loop
  and none is claimed.
- **Behaviour-changing production edits:** B5 (launcher builds or refuses instead of launching stale), B6/B14
  (retention now runs in production), iteration 8 (the exemption is policy-derived, with the legacy guard).
  Each is covered by tests that fail if it regresses; the retention test fails without the exemption (report
  deleted) and fails without the sweep (capture survives).
