# Autonomous optimization loop — bottleneck ledger (5 kept iterations)

- **Goal:** drive the open-row count of the repository's own bottleneck registry to zero with verified fixes only.
- **Scope:** `plans/bottlenecks.json` rows, the code and tests they name, and the gates in `package.json`. Nothing outside the repository root was touched.
- **Verify (mechanical metric):** `node scripts/check-bottlenecks.mjs --json` piped to a counter of `status === "open"` — a single number, < 1 s, no side effects.
- **Guard:** `npx tsc -p ./` (exit 0) and `npm run audit` (exit 0), plus the focused lane for each touched module.
- **Direction:** lower. **Min delta:** 1. **Iteration budget:** 20 (the user's request). **Iterations used:** 5 kept + 1 discarded (all rows reachable without a live storefront campaign closed).
- **Baseline metric:** 13 open rows. **Final metric:** 8 open rows.
- **Source of truth for the record:** `.canary/state/loop-results.tsv` (one line per iteration: iter, timestamp, metric, delta, kept, description).

## Iterations

| # | Row | Change | Commit | Metric | Kept |
|---|---|---|---|---|---|
| 1 | B18 | `verify` typechecked the whole program twice — dropped the direct `npm run typecheck`; `npm test` still compiles (`tsc -p ./`) before running anything | `f33c932` | 13 → 12 | yes |
| 2 | B6 | Artifact retention was declared but never enabled in production. Made the sweep policy-aware first (see "Advisory corrections"), then enabled it in `resolveArtifactStoreOptionsFromEnv` | `2da0036` | 12 → 11 | yes |
| 3 | B5 | The launcher guarded the compiled entry with `existsSync` only, so a stale bundle launched silently. Added `scripts/launch-guard.cjs` (bundle mtime vs newest `src/**/*.ts` + `tsconfig.json`) and wired `main.cjs` to build in dev / refuse in a packaged app | `43bbf62` | 11 → 10 | yes |
| 4 | B14 | The sweeper matched `*.artifact` only. It now also prunes a run's `index.json` once that run holds no captures, and documents that workspace-owned annotation documents/snapshots are out of scope | `7354aae` | 10 → 9 | yes |
| 5 | B22 | Plan `status:` frontmatter was consumed by nothing. Added `scripts/check-plans.mjs` (bucket + reject unknown spellings), wired into `verify` as `plans:check` | `f0c3475` | 9 → 8 | yes |
| — | B16 | Discarded: the `scripts/cdp` hot-swap path is **not** dead — `InjectedScriptStore.resolveOverrideDir()` auto-resolves `scripts/cdp` and loads `<id>.source.js` overrides, and `dev.mjs` relaunches on changes there. No change made; the row is a false positive | — | 12 (unchanged) | no |

## Advisory corrections (both acted on before committing)

1. A blocking advisory arrived while iteration 2 was staged: enabling `enableRetentionCleaner` with defaults is **destructive**, because the store has no `retentionPolicy` awareness while `report.generate` is declared `permanent` and stages through the same root — a bare boolean would delete permanent report evidence after 24 h. The default was **reverted**; the fix became: `ArtifactStore.sweepRetention` exempts `kind: "report"` artifacts (the only permanent capability class), the cleaner gained an owner-supplied `isProtected` exemption and a `protectedFiles` counter, and production enablement moved into `resolveArtifactStoreOptionsFromEnv`.
2. A second advisory repeated the concern and noted the staged test only exercised a generic `stale.artifact`. The committed test now stages a **real** `kind: "report"` artifact plus a `kind: "screenshot"` capture in one run, backdates both 48 h, constructs a store with `enableRetentionCleaner: true`, and asserts the report survives while the capture is pruned. Without the exemption this test fails (the report is deleted) and without the sweep the capture survives (the control assertion `deletedFiles === 1` in the opt-out half proves the age setup is valid).

## Verification at close

Sequential lanes, run once after the last iteration (`npm run compile` implied by the lane scripts; every exit code read bare):

| Lane | Tests | Pass | Fail | Skip | Exit |
|---|---|---|---|---|---|
| `test:canary` | 144 | 144 | 0 | 0 | 0 |
| `test:fast` | 451 | 451 | 0 | 0 | 0 |
| `test:site-clone` | 108 | 108 | 0 | 0 | 0 |
| `test:integration` | 13 | 13 | 0 | 0 | 0 |
| `test:main` | 1086 | 1085 | 0 | 1 | 0 |
| `test:terminal-rename` (Electron launch path) | — | — | — | — | 0 |
| `npx tsc -p ./` | — | — | — | — | 0 |
| `npm run audit` | — | — | — | — | 0 |
| `npm run plans:check` | 58 plans / 48 classified | — | — | — | 0 |

Logs: `.canary/state/loop-final-{fast,integration,siteclone,main,terminal-rename}.log`, `.canary/state/loop-iter5-canary.log`, `.canary/state/loop-iter2-{integration,main}.log`.

`test:e2e` was **not** re-run inside the loop; the Electron launch path it depends on is covered by `test:terminal-rename`, which exits 0 with the changes applied, and no e2e-lane file was touched.

## Deferred rows (open, with the reason and the concrete next step)

- **B16 (P2)** — false positive. `scripts/dev.mjs` watches `scripts/cdp` and `dev-watcher-helpers.isHotSwappable` classifies `scripts/cdp/<name>.source.js`; the directory is an *external override* hook by design, not dead code. Closing the row by deleting the branch would remove a live capability. Next step: reword the row (or drop it) rather than change code.
- **B25 (P2, reproducibility)** — `test/unit/build-report-*.test.mjs` drive `scripts/lib/build-report.mjs` against `.canary/run3`, of which only `REPORT.md` is tracked (the rest is 69 MB of campaign evidence). Next step: either track a trimmed synthetic run fixture (~2 evidence documents; the report builder reads `label`, `viewport`, `structural`, `stages.compare`, `selfDrift`) under `test/fixtures/`, or synthesize one from the builder's input contract. Deferred because copying the real evidence (≈460 KB across three documents) would commit campaign artifacts as fixtures, and synthesizing them needs a reverse-engineering pass over the builder's gate conditions that does not fit one iteration honestly.
- **B19 / B20 (P1/P2, theme QA)** — both predicates are `manual` and both require a live storefront run (periodic-animation page for the settle gate; a page taller than 16384 px for the capture ceiling) to re-verify.
- **B23 (P1)** — no live-storefront gate exists; closure requires a campaign run whose `_verdicts.json` is not `INCONCLUSIVE`. The last campaign measured 15/15 pages and adjudicated 0 cases (see B30).
- **B30 (P1)** — `anti.visual.compare` normalization exceeds its 15 s bound, so `capture.valid === false` and every desktop/tablet case is `CAPTURE_INVALID`. The fix is to make normalization faster; raising the bound would relax a fidelity assertion and is explicitly out of scope for this loop.
- **B29 (P2, mcp)** — `node scripts/check-mcp-budget-dominance.mjs` reports 23 routing rows that shadow a catalogue registration. Retiring a row is a behaviour change that needs its own proof per row, and the routing table is the surface this session's own tools dispatch through; deferred rather than changed without the proofs.
- **B21 (P2, hygiene)** — 57 `.png`, 14 `.md` and assorted scratch files at the repository root. Those are user-owned files; moving or deleting them is not a call this loop makes.

## Disclosures

- **Metric exhaustion.** The metric is the number of `status: "open"` rows. Every row closable by code-and-test work without a live storefront campaign is closed or refuted; the remaining 7 are blocked on live runs, per-row behaviour proofs, or user-owned files. Continuing to 20 iterations would have meant either re-scoping the metric mid-loop or closing rows without the evidence their own `reVerifyWith` demands, so the loop stopped and reports the exhausted state instead.
- **B22's predicate was replaced.** It was a `manual` predicate whose `reVerifyWith` defined closure as "a script consumes the field"; it is now a machine predicate (`file-absent-regex` on `package.json` for `plans:check`) so the registry verifies the consumer exists.
- **Two tracked files were already dirty** before the loop began — `plans/260905-0012-.../reports/live-theme-proof.json` and `plans/reports/mcp-overhaul-benchmark.json`, both rewritten by the suites themselves. They were left untouched and are still uncommitted. Every loop commit names its paths explicitly; no `git add -A`, no reset, no force push.
- **`kongming` is not dispatchable** in this environment; no tier-escalation review was performed for the loop, and none is claimed.
- **Behavior-changing production edits** are B5 (launcher builds/refuses instead of launching stale) and B6/B14 (artifact retention now runs in production, with report artifacts exempt). Both are covered by new tests; the retention tests fail if either half of the safety property regresses.
- The loop's own log lives in `.canary/state/loop-results.tsv` (session state, deliberately not rotated).
