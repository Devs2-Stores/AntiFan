# Ready — Full Super Core Goal Handoff

User explicitly confirmed final contract, plan and preflight. Ready means authorized preparation for this existing agent/runtime environment, not proof that future Core works. No goal started by warmup.

## Canonical Plan
E:/Work/apps/AntiFan/plans/260914-1248-work-root-sequential-evidence-scout/plan.md

## Locked Outcome
Deliver C1-C8: full scoped corpus scout including non-AK user skills; local-first artifact/revision/evidence Core; platform/temporal/conflict isolation; all P1 experience/domain query capabilities; retrieval/context/recommendation/receipts; actual AntiFan/OMP integration; verified outcome ingestion and recovery; full import/regression and real end-to-end acceptance. Source corpus stays read-only during scout. Implementation/integration is in scope, not merely reports.

## Approved Autonomy
Execute technical work without routine questions, derive exact child phases/files from corpus, no phase/todo ceiling. Use existing agent/runtime for inference. Freeze objective acceptance thresholds before evaluation, never lower them to pass. Acceptance mutations only on isolated local copies, not originals or production. Real candidates remain pending for later user adjudication; prove adjudication/promotion/rejection/rollback mechanisms in a separate acceptance store using explicit test authority, not forged real approvals.

## Stop Condition
All C1-C8 receipts pass, eligible scope reconciled with transparent exclusions, actual task uses Core through AntiFan/OMP, fresh verification feeds a real pending case/candidate, regression and restart/restore pass, usage/setup docs complete. Scout completion, compilation, mocks or one successful demo are not final completion. No universal 100% semantic accuracy claim.

## Scope Guard
At every phase boundary compare proposed work to locked outcome. Expand phases/todos when required; do not silently shrink scope, weaken tests, hide unknown regions or relabel blockers as exclusions. No automatic active-rule promotion, secret access, deployment or paid provider substitution. Missing permission, unavailable capability, unpassed acceptance or material scope mismatch => checkpoint and report BLOCKED with exact evidence. Continue all independent reachable work without fake fallback.

## Preflight Evidence
ak CLI available; Node v24.13.0; existing package declares CLI/MCP entrypoints; current agent-to-AntiFan read-only tabs.list succeeded. All 16 plan/phase files reread, 15 phases pending, zero broken local links/stub markers; ak plan validate valid=true. Full inventory, provider-independent app API, Core code and acceptance results are not claimed. See full-goal-preflight.md for per-phase checks; full-goal-review.md for classified findings.

## Launch Vehicle — AgentKit (`ak`) runtimes

Equivalent vehicle for any runtime with the `ak` skill catalog. The plan pointer is already set (`ak plan use` -> plans/260914-1248-work-root-sequential-evidence-scout), so either form resolves the same plan:

```
/ak:cook plans/260914-1248-work-root-sequential-evidence-scout/plan.md --auto
/ak:cook --auto
```

Flag choice is load-bearing, not cosmetic:
- `--auto` is REQUIRED. Cook's default is `--interactive`, which stops for human approval at four gates — that contradicts this contract's no-routine-questions autonomy. `--auto` skips only those prompts; the hard gates still hold (100% test pass, MANDATORY `code-reviewer`, no-side-effects gate).
- `--parallel` is FORBIDDEN: the contract requires one active scout/corpus work unit.
- `--no-test` and `--yagni` are FORBIDDEN: they violate the verification and full-scope gates.
- `--advice` is FORBIDDEN here: the plan records kongming as unavailable and replaced by two independent reviewers.
- `--tdd`: allowed; phase-level tests-first does not conflict with the contract.

## Codex Opener
/goal Execute the full Super Core master plan at E:/Work/apps/AntiFan/plans/260914-1248-work-root-sequential-evidence-scout/plan.md. Read reports/goal-handoff.md first and honor C1-C8 and approved autonomy. Complete Scout -> Build -> Integrate -> Verify, not scout-only. Sequential corpus work, unlimited necessary child phases/todos. Stop only at the documented end-to-end acceptance or an explicit evidence-backed blocker; never silently reduce scope.

## Claude / Other Runtime Opener
Run a durable multi-step execution of the same master plan and goal-handoff.md, preserving checkpoints and C1-C8. Follow the approved autonomy and scope guard; finish end-to-end or report a concrete blocker. This instruction does not claim the runtime implements Codex /goal semantics.

## Recommended Runtime
Preferred: the current AntiFan/OMP session. Phase 12 requires real AntiFan/OMP integration, and the AntiFan MCP attachment is already live and proven in-session (read-only `tabs.list(all=false)` succeeded), so integration and live verification run on the direct path. Phase 1/4 also need the non-AK skill catalog under C:/Users/Admin/.claude/skills, which this runtime exposes.

Equivalent: any agent harness that can read this plan, hold durable checkpoints across a multi-day sequential run, and reach AntiFan through `scripts/antifan-agent.cjs` for the integration phases.

NOT a supported route: the removed DeepSeek Harness (DSH) runtime. `plans/260817-1931-rebuild-chromium-first-native-harness` phase 10 is Done, and its goal 6 removed DSH/Cordis runtime coupling; that plan's non-goals explicitly reject "keeping a permanent dual-runtime fallback to the old DSH flow". The surviving `src/main/agent/deepseek-harness-adapter.ts` is an env-gated spike (`ANTIFAN_DSH_SPIKE`) that returns null when unset. DeepSeek today is a model provider behind ProviderGateway, not a harness. Reviving DSH is new scope outside C1-C8.
