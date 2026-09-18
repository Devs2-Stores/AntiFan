> Carried from `plan.md § Cross-plan dependencies` + goal 11 (2026-09-18): alongside
> the D1–D11 defects and the approved store writes, this phase surfaces **one
> per-MCP usage line from `core.health` stats**; the count is sourced from the
> dispatcher / invocation ledger (`accounting:mcp-dispatch`), never a client-side
> tally.

---
title: "Phase 9: Core Health defects D1-D11"
status: todo
---

# Phase 9: Core Health defects D1–D11

## Overview

Live: status `DEGRADED`, reasonCode `GATE_PROMOTION_FAILED`, 108 candidates
PENDING; five gates PASS, promotion and regression are the broken pair
(regression's `replayResult` was nulled by migration 7→8). `coveragePct 20.4` is
**by design** and is not touched.

Two faces of the same fact (`core.health` in `packages/super-core/src/index.ts`,
the panel in `src/main/diagnostics/core-health.ts`) disagree, hide gates, and
never reach `HEALTHY`.

## Requirements

- **D1/D2 — read-only means read-only.** `core.corpus_audit`
  (`index.ts:950-953`) and `core.check_phase_gate` (`:1047-1051`) INSERT on every
  call (`recorded = opts.record !== false`); the CLI passes `{record:false}`
  (`antifan-core.cjs:76-82`) but the MCP path does not. The MCP path must compute
  without appending, or the tools must stop advertising themselves as read-only.
- **D3 — reasons surface.** `reasonsJson` (`:947`) stores disposition counts, not
  the reason histogram; the reasons for 38 blocked artifacts are written but no
  surface can print them. Add the histogram and expose it.
- **D4 — `core.candidates`.** The 108 PENDING rows have no read path (their ids
  are only obtainable out of band). Add the read tool.
- **D5 — dead branch.** `REPLAY_ENGINE_NOT_IMPLEMENTED` (`core-health.ts:731-734,749-754`)
  is unreachable — the engine exists (`index.ts:1210`). Remove the branch or make
  it truthful.
- **D6/D7 — one failure, one reason, all gates named.** `:1079-1081` reports only
  the **first** failed gate in literal order, so `GATE_PROMOTION_FAILED` always
  masks a simultaneously broken regression. Report every failed gate.
- **D8 — `connected` (8 876)** is computed, gated by nothing, surfaced nowhere;
  adjudication evidence with `entryId=null` means promoted claims never count.
  Either gate on it or surface it — decide from evidence, then implement.
- **D9 — the UNKNOWN ceiling.** `worstOf` (`core-health.ts:181-186`) ranks
  `UNKNOWN` (1) above `HEALTHY` (0) and renders it as a gate, so the panel can
  never say `HEALTHY`. The corpus-wide uncertainty reasoning at `index.ts:1089-1092`
  is **correct** — stop rendering uncertainty as a **blocking check** (narrow its
  scope; do not invent a corpus-wide value). Also fix the typo drift
  `ALL_GATES_PASS` (`index.ts:1081`) vs `ALL_GATES_PASSED` (`core-health.ts:194`).
- **D10 — `knowledgeGaps`** is exposed but consumed by nothing in `src/`
  ("AntiFan Desktop" = 0 claims, "omp agent harness" = 0 claims vs generic-liquid
  2 191). Surface the top gaps in `core.health` so the largest store signal reaches
  a check.
- **D11 — principles have no dedupe/anchor invariant** (10 275 principles vs 774
  units). Add the invariant (claims already have an evidence gate).
- **Usage line (goal 11).** `core.health` stats carry **one per-MCP usage line**
  sourced from the dispatcher / invocation ledger (`accounting:mcp-dispatch`
  aggregate). Never a client-side tally, never a second counter: read the existing
  aggregate and render it.
- **H1/H2/H3 (approved writes, user decision D — only after phase 1 lands):**
  H1 adjudicate the 108 PENDING candidates through `core.adjudicate` (needs D4
  first); H2 replay the newest regression (`core.replay_regression`); H3 give real
  evidence to the two zero-claim platforms. Each write is verified by a before/after
  `core.health` reading.

## Related code files

- Modify: `packages/super-core/src/index.ts` — `:926-953` (corpus audit),
  `:1047-1051` (phase gate), `:1079-1081` (reason code), `:1089-1092` (uncertainty),
  `:1210` (replay engine), plus the candidates/knowledgeGap/principle paths.
- Modify: `src/main/diagnostics/core-health.ts` — `worstOf` `:181-186`,
  `:188-194` (typo), `:455-461` (uncertainty check), `:529-537`, `:731-754`.
- Modify: `scripts/antifan-core.cjs` only if the CLI surface must mirror a new tool.
- Read: `plans/reports/brainstorm-260917-2302-mcp-usage-counter-core-health.md`
  (the accepted usage-line design: dispatch/ledger fact, Hub aggregate, one line
  in Core Health).
- Gate: `npm run accounting:mcp-dispatch` must pass for any surface change.

## Implementation steps

1. Read the brainstorm's usage-line section and implement it against the existing
   aggregate (no new counter).
2. Fix D9 (the ceiling) and D6/D7 (all failed gates named, reason joined) —
   these change what the panel reports, so record before/after `core.health` JSON.
3. D1/D2 (booking), D3 (histogram), D4 (candidates read), D5 (dead branch),
   D8 (decide + implement), D10 (gaps), D11 (principle invariant).
4. H1–H3 after phase 1 is verified: adjudicate via the writer, replay regression,
   seed the two platforms; each with a before/after reading.
5. Unit/lane: extend the core-health tests; `npm run compile`; `npm run audit`.

## Todo

- [ ] D1/D2 read-only audit + phase gate on the MCP path
- [ ] D3 blocked-reason histogram surfaced
- [ ] D4 `core.candidates` read path
- [ ] D5 dead replay branch resolved
- [ ] D6/D7 every failed gate named; typo drift fixed
- [ ] D8 `connected` decision implemented
- [ ] D9 uncertainty no longer a blocking ceiling
- [ ] D10 knowledge gaps surfaced
- [ ] D11 principle dedupe/anchor invariant
- [ ] Usage line from the dispatch aggregate
- [ ] H1/H2/H3 approved writes with before/after readings

## Success criteria

- [ ] `core.corpus_audit` / `core.check_phase_gate` called twice leave the store
      byte-identical (no new rows).
- [ ] `core.health` names **every** failed gate; with all gates passing and no
      unresolved conflict, the panel can report `HEALTHY`.
- [ ] The 108 candidates are readable and adjudicable through the writer.
- [ ] The usage line matches the `accounting:mcp-dispatch` aggregate for the same
      window (sampled twice).
- [ ] `npm run compile`, `npm run audit`, `npm run accounting:mcp-dispatch` pass
      with **no test widened**.

## Risks / rollback

| Risk | Mitigation |
|---|---|
| Changing `worstOf` could hide a real degradation. | Only the uncertainty *check* stops acting as a ceiling; `CONFLICTED` still degrades. Record before/after JSON for both states. |
| Adjudicating 108 candidates is a durable write. | Approved (decision D) and gated behind phase 1's durability fix + D4's read path; each verdict is reversible through the same writer. |
| Rollback | Revert the touched files; H1–H3 verdicts are store rows, reversible per candidate. |
