# Reframing round — verifier verdict (round 2, anonymized)

Round 2 of the `--ultra` reframing pass on the "audit without closure" symptom.
Five independent read-only reframing candidates ran in one parallel wave against
`evidence-packet.md`. Identities were stripped before verification.

## Anonymization mapping (kept private during verification)

| Label | Candidate |
|---|---|
| A | Reframer3 |
| B | Reframer5 |
| C | Reframer1 |
| D | Reframer4 |
| E | Reframer2 |

Verifier: `reviewer` agent (`ReframeVerifier`), read-only, 2m17s, confidence 0.95.
Packet: `anonymized-verify-packet.md`.

## Verdict

**Winner: Candidate A (Reframer3) — 74/80.** Technique: Inversion Exercise.

> "Candidate A is selected as the winning reframing. It correctly identifies the lack
> of a closure substrate via the Inversion Exercise, resolves the compile/rebuild
> dilemma without a fragile orphan prune script (which would risk deleting static
> renderer assets emitted by copy-static.mjs), and introduces zero factual
> contradictions against controller ground truth."

All five candidates rejected F1 ("the list is wrong") and F2 ("the list is right, nobody
closes it") as stated, and converged on a third framing: **the repo has no
machine-checkable closure predicate**, so a finding's truth value can never be
re-derived at HEAD and every session re-audits from prose.

## Controller corrections to the verdict

The verifier's output was schema-compressed (its `reviewer` schema replaced the requested
scoring table) and one of its claims does not survive measurement:

1. **"Zero factual contradictions" for the winner is wrong.** Candidate A reported the
   repo root as having 12 `.md` files; the measured count is **14**. Candidate D reported
   47 `plan.md` under `plans/`; the measured count is **57**. Both carry one error each —
   not zero vs one.
2. **The prune contradiction resolves in D's favour, not A's.** A's concern is real —
   `scripts/copy-static.mjs` writes `exports-shim.js`, `standalone.js` and a generated
   `terminal-write-dispatcher.js` into `.compiled/src/renderer/`, so a naive
   source-sibling orphan rule is dangerous there. But the conclusion "therefore write no
   prune at all" over-corrects: without pruning, `tsc` leaves orphans that `main.cjs:12`
   cannot distinguish, because it guards on `existsSync` only. The correct synthesis is
   D's design **plus** A's constraint: write the pruner and exclude
   `.compiled/src/renderer/**`. Implemented and proven by probe (orphans removed from
   `src/` and `test/`, every renderer and copied asset preserved).

Every candidate also independently reported three mutually inconsistent counts of the
same trivial facts (root `.md`: 2 / 12 / 14; `plan.md`: 40 / 47 / 57). That divergence on
cheap, countable facts is itself the strongest evidence for the shared diagnosis.

## Validated union — implemented

| Item | Ledger row | Evidence |
|---|---|---|
| `compile` no longer deletes `.compiled` | B1 | compile warm 6.2s → 5.5s; no destructive `rmSync` in the build path |
| `test` no longer deletes `.compiled` | B2 | `test` begins with `compile` |
| `incremental` + `tsBuildInfoFile` | B3, B4, B17 | typecheck cold 20.1s → warm 5.1s, with its own buildinfo so noEmit cannot poison emit |
| emit-integrity guard | B26 | **hazard measured**: 2 emit files deleted, compile emitted nothing. Guard now discards buildinfo and rebuilds; verified self-heal (2 of 316 missing → restored) |
| orphan-emit pruner | B11 | probe: pruned `src/`+`test/` orphans, kept `renderer/**`, `scripts/*.cjs`, live emit (628 files kept, 0 false positives) |
| file-scoped + canary + widened globs | B7, B8, B9, B10 | `test:file`; `test:canary` 40 tests never gated, now 41; `.compiled/src/**` and `.compiled/test/renderer/**` newly covered |
| scoped process reaping | B12, B13 | no machine-wide `taskkill`; stale dev lock reconciled |
| tracked→gitignored cut | B15 | 7 modules → tracked `scripts/lib/`, 11 importers repointed, closure was exactly those 7; all 7 load; `test:canary` 41/41 |
| **closure ledger + checker** | all | `plans/bottlenecks.json` + `scripts/check-bottlenecks.mjs`, wired into `verify` |

## Defect the new gates found immediately

`src/main/tools/browser-control-port-zero-network.test.ts` (B24) was failing invisibly —
it is colocated under `src/`, which no npm glob reached. Its test 3 asserted the
pre-fencing *rebase* contract: it passed a target fenced at `documentGeneration: 1` while
its mock host reported 5, and asserted the result was rebased to 5. `reloadZeroNetwork`
correctly passes `operationType: 'lifecycle'`, which `resolveTargetTab` fences — effectful
operations throw `TARGET_STALE` on generation drift; only passive reads auto-sync.
**The production code was right and the test was stale.** It now supplies a fresh target
for the lifecycle path, and a new test asserts the fence holds *before* any CDP command or
host reload fires.

## Deliberately not done

- **B6 — enabling the retention cleaner in production.** The fix is ~1 line
  (`resolveArtifactStoreOptionsFromEnv` returning `{ enableRetentionCleaner: true }`) plus a
  lazy `rehydrateIndex()`. Withheld because it deletes real artifacts under the live data
  root; that is the user's call, not an unattended side effect of a build refactor.
  Recorded as OPEN with a machine-checkable predicate.
- **B16, B18, B19–B23, B25** — mechanical or manual items, each recorded as an OPEN row
  with a re-verify instruction. Nothing was dropped silently.
- The `params: any` at the CDP boundary — `CdpDebuggerInterface` itself declares
  `params: any`, so the test's use mirrors the declared contract; narrowing only the test
  would be an inconsistent half-measure. Left, and recorded here.

## Residual unknowns

- The measured cost of the settle predicate (B19) has not been re-derived against a page
  with a periodic animation; it remains a `manual` row by design.
- `.canary/run3` is still an untracked fixture that `test:canary` drives (B25), so the
  canary suites' *modules* are now reproducible but their *fixtures* are not.
