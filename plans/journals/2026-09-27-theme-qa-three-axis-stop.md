# 2026-09-27 — Theme QA repair loop: deterministic 3-axis stop

## What was changed

- `src/main/qa/three-axis-stop.ts` (new) — the Jev-Mem stopping axes as pure
  arithmetic: `evaluateThreeAxisStop(state, attemptCount, maxAttempts)` with
  `s_d` (sufficiency), `m_d` (missingness), `c_d` (contradiction). Priority:
  contradiction → `ABORT_ROLLBACK`; `s_d>=1 && m_d===0` → `PROCEED_VERIFIED`;
  attempt cap or `m_d > MAX_MISSINGNESS_GAP` → `ABORT_BLOCKED`; otherwise
  `CONTINUE_REPAIR`. `MAX_REPAIR_ITERATIONS = 3`, `MAX_MISSINGNESS_GAP = 3`.
  No I/O, no clock, no model.
- `src/main/qa/theme-qa-repair-coordinator.ts` — `verify()` now evaluates the
  axes: the settle-incomplete branch (`SETTLE_INCOMPLETE`) bounds its retry loop
  by setting `blocked` at the attempt cap before throwing; the status decision
  turns a failed session terminal `blocked` when the deterministic stop fires,
  adds the additive result field
  `stopReason?: 'STOP_CRITERIA_EXCEEDED' | 'CIRCUIT_BREAKER_TRIPPED'`, and
  reports `remainingRepairs: 0` on a deterministic stop. Contradiction stays
  terminal via the existing R0 rollback path; happy path unchanged.
- `test/main/theme-qa-three-axis-stop.test.ts` (new) — 8 pure-evaluator cases
  (priority, false-verify block, cap, custom cap, timing budget) + 2 dispatch
  tests exercising the real workflow through `CapabilityCatalogue.dispatch`
  (persistent-failure loop → round 3 `blocked` + `stopReason` +
  `remainingRepairs 0`, round 4 `REPLAY_DENIED`; evidence-gap loop →
  round 4 `REPLAY_DENIED`).
- `docs/operations.md:17` — the `theme.qa_repair.verify` contract paragraph now
  states the deterministic three-attempt bound, the terminal `blocked` status,
  the replay refusal, and where `stopReason` comes from.

## Evidence

- `npm run compile` exit 0 (emit integrity, MCP budget dominance, dispatch
  payload, extension build all green).
- `npm run typecheck` clean.
- New suite **10/10** (pure budget test 0.64 ms for 1000 calls; loop tests
  ~0.9 s each). Standalone micro-bench: **14.7 ns/call** over 200k iterations.
- Pre-existing coordinator suite
  `theme-qa-workflow-differential-and-rollback` **7/7**, unmodified — including
  "blocks exhausted repair sessions" and "treats an inconclusive verification as
  a consumed revision".
- `npm run test:main` **1744 pass / 0 fail / 1 skip** (298 suites, ~141 s).
- `npm run test:super-core` **38/38**.
- Code review (code-reviewer subagent): **APPROVE**, existing tests intact. Both
  MINOR findings applied: `MAX_MISSINGNESS_GAP` extracted from the magic literal;
  `report.findings?.evidenceGaps?.length ?? 0` made consistently optional-chained.

## Open / not yet proven

- `npm run certify:core-freeze` is **red for a pre-existing, unrelated cause**:
  run 1 exits via `anti.screenshot.viewport` — `CAPABILITY_NOT_FOUND Host does
  not implement required 'captureVerificationScreenshot' canonical CDP
  interface` (`scripts/freeze-theme-workload.cjs:193`). The guard is committed
  (`48483faf`, `8d820844`); the certification workload's fake host never
  implemented that method (`git log -S` over its history is empty), and none of
  the files in this change are on that path. The frozen-surface files also carry
  unrelated working-tree edits. Restoring the cert needs the workload adapter to
  grow `captureVerificationScreenshot` (canonical envelope, mirroring the test
  fixture) — deliberately left to the freeze-surface owner.
- `node scripts/run-theme-harness.mjs --layers l0` (the flag is `--layers l0`,
  not `--level=L0`) runs and reports L0 **FAIL** from pre-existing Storefront
  tree defects: 15 settings-binding failures, 6 missing assets, 9 Haravan
  contract failures, 5 lint violations (`buyxgety-module-cart` snippet missing,
  unresolved `settings.*` reads). None involve this change; L1/L2 were BLOCKED
  for want of a live capsule/dev theme id.
- Residual unknowns carried over from the decision record: coordinator sessions
  Map TTL cleanup only runs on `verify()` (E-3, untouched by design here);
  theme-checks coverage baseline (E-2); VN tokenizer ratio (E-1).
