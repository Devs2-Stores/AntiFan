# VERIFIER BRIEF — Ultra Verifier Run `ultra-cookie-2026-09-19`

You are the single verifier for a best-of-5 run. Five independent read-only candidates each produced a complete implementation plan for the same immutable evidence packet. Score them, apply the hard constraints, and select **one winner unchanged** (or reject all).

## Inputs (read all six, in this order)

1. `plans/reports/260919-cookie-cache-ultra-packet.md` — the immutable evidence packet (task, confirmed evidence, hard constraints, non-goals, AC1–AC8, protected surfaces, verification commands, required output shape).
2. `plans/reports/ultra-cookie-2026-09-19/CAND-X1.md` … `CAND-X5.md` — the five candidate plans, anonymized and unordered. Do not try to infer authorship; judge content only.

## Rubric (score every candidate 1–20 on each criterion; justify with quoted plan text or cited `path:line`)

| # | Criterion | What earns the top of the scale |
|---|---|---|
| R1 | **Symptom-to-technique fit** | The chosen ak:problem-solving technique genuinely matches this stuck-type and the stated organizing insight actually collapses the defect space (few mechanisms, not 10 unrelated patches). |
| R2 | **Depth and specificity of application** | Concrete `path:line` anchors that a reader can open and find the named code; real code-level mechanics (API names, event names, awaits, guards); no generic advice; no invented APIs or fabricated line references. |
| R3 | **Actionability of the unblock path** | A controller can execute phase-by-phase without re-deciding anything: single target-session resolver contract fully specified (name, signature, location, and *every* caller forced through it), durability mechanism with its flush policy and cost, Chrome-sync reality under App-Bound Encryption v20, guarded cleanup with pattern + guard + idempotence proof + audit artifact, and a test plan mapped one-to-one to AC1–AC8. |
| R4 | **Honesty about residual unknowns** | Residual uncertainty marked `[INFERENCE]`/`UNKNOWN` rather than papered over; risk register has real detection signals; "what we deliberately did not do" is substantive. |

## Hard constraints — screen FIRST; a violation disqualifies the candidate (state which)

- **HC1** No new runtime dependencies.
- **HC2** No weakening, deleting, or silently re-pinning of existing tests. Note: `test/main/capsule-partition-migration-pure.test.ts` currently asserts `deps.__writeTargets.every((t) => t === 'persist:profile-a')`, i.e. it pins the *defective* namespace transform. Changing that assertion is allowed **only** if the plan (a) says why the old assertion is wrong, and (b) replaces it with an assertion over observable behavior (the injected/real target namespace), not another string transform.
- **HC3** Data deletion must be guarded, scoped to an exact verified pattern, impossible while a live tab owns a matching partition, idempotent, and auditable. A plan that shells out to `rm -rf`/`Remove-Item` without in-app guards fails.
- **HC4** Every acceptance criterion AC1–AC8 must have at least one named, runnable verification (test file + what it asserts, or an explicit impractical-with-substitute-evidence statement).
- **HC5** No contradiction of the packet's confirmed evidence, and no claim that App-Bound Encryption v20 can be defeated offline.
- **HC6** AC4 clarification — "reachable" means the migration target partition must be one the app's own partition resolver can produce (`getSharedProfilePartition` / `getSharedProfileSession`), so a real tab can actually open it; a name that merely passes `isValidCapsulePartition` but that no code path ever resolves does **not** satisfy AC4.

## Decision rule

- Rank by rubric total, after hard-constraint screening.
- Select the candidate that can be implemented **as written** without the controller re-deciding anything. If two are close, prefer the one with the smaller defect surface and the more verifiable AC mapping.
- If every candidate violates a hard constraint or fails the acceptance criteria, **reject all** and say exactly which constraints failed for each.
- Do not blend candidates. Do not rewrite the winner.

## Output format (plain markdown, no code fences around the whole reply)

1. **Hard-constraint screening** — per candidate, PASS or the exact violation(s).
2. **Score table** — rows = candidates, columns = R1–R4 + total; one short evidence line per candidate quoting the plan.
3. **Ranking** — ordered, with a 2–3 line evidence-backed rationale each.
4. **Winner** — the label only, plus a 5–10 line rationale naming the mechanisms that decided it.
5. **Confidence** — high/medium/low with the reason; note whether the top two were close.
6. **Watch-list** — up to three items in the winner that the controller must keep honest during implementation (verification steps, not plan edits), and any claim in the winner that you could not validate against the packet.
