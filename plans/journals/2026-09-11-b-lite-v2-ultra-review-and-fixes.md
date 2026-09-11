# B-Lite v2 — Ultra Code Review, and the Fixes It Landed

Date: 2026-09-11. Change set reviewed: `669af839..b8c132f4` on `E:/Work/apps/AntiFan`.
Report: `plans/reports/260911-1621-antifan-ultra-code-review-b-lite-v2.md`.
Fixes: `d9ccb06`, `066395e`, `9d2922c`, `4081105`, `9d05940`, `bb03f32`, `42755f3`.

## A. The review's verifier stage did not run

Five independent read-only candidates reviewed one immutable packet (`.canary/staging/review-packet/`,
10,485 B) and all five returned output. The finalizer then failed three times on two different agents
with `Cloud Code Assist API error (429) RESOURCE_EXHAUSTED` and produced no payload at all, so no
subagent union or ranking exists. The union in the report was produced by the controller, and every
finding carries the command and output that confirmed it, so each one can be re-run. This is stated in
the report rather than papered over: on this runtime, `--ultra` is same-tier best-of-5, not asymmetric
verification.

The candidate ranking appendix quotes the candidates' **own** scores. One candidate (`UltraCand5`)
returned zero findings and `overall_correctness: correct` over a change set in which four peers produced
eight validated defects; that is recorded as an under-verification data point, not as corroboration.

## B. What the review found, and what was fixed

Fourteen findings survived validation. Eleven are fixed, three are reported as owner decisions. The
three that matter most were each confirmed by running the previous code, not by reading it:

**The report crashed instead of publishing the batch.** A batch holding both a route-refused page and a
page that failed a phase threw `TypeError: Cannot read properties of undefined (reading 'ok')` at
`fifteen-pages-run.mjs:1681` — the section-14 asset line re-filtered the full page list with an
unguarded `p.phases.cloneGeneration`. The earlier `80037e6` guard had covered the decision branch and
missed the failure-pattern, summary-row, structural and section-14 branches. Reproduced, fixed, and the
regression test fails against the committed bytes.

**A refused run could publish `PASS`.** One leg carrying a PASS verdict incremented both `tally.PASS`
and `tally.ROUTE_REFUSED`, and the run verdict is `tally.PASS === cases.length ? 'PASS' : …`. Measured on
the previous module: `tally {PASS:1, ROUTE_REFUSED:1}`, `executiveVerdict PASS`. The invariant was
enforced only by the caller's discipline; the module that owns the tally now owns it, and runs with the
symptom: `exit 4 ROUTE_REFUSAL` where the previous code said `exit 1 INCOMPLETE_CASES`.

**The diff budget did not measure bytes changed.** The volume was the net size delta, so a 400 B file
rewritten to 401 B measured **1 byte** and cleared a `maxBytes: 20` ceiling. The audit boundary now
measures the real difference between the staged file and `stored-content/` (803 bytes for that shape),
with the manifest delta kept only for manifest-only callers.

The rest: the validator's `auditDiffBudget` call had its last two arguments swapped so the byte ceiling
was never checked (two negative controls now refuse under the fixed code and cleared before it); the
forbidden path/tool defaults were *replaced* by a declared list rather than added to, so an empty list
un-forbade `package.json` (measured `OK` before, `REFUSED_TOUCHED_PATH` after); `auditSelfVerification`
refused only `=== true` while no schema validator runs over the contract; `process.exit(code ?? 0)`
published success for a child killed by a signal (smoke test now exits 1); the quiescence failure reason
asserted a page-specific class no gate measures; and the lifecycle test documented a mechanism that is
the opposite of the real one (`sample.passed` *is* the evidence channel; the signature derives from
`proofProfile.violations`).

## C. The union was reconciled, not concatenated

Two candidates disagreed on the tool-surface finding. Measurement settled it: with a custom
`forbiddenToolPatterns` the previous code already refused through the policy-object gate and
`DEFAULT_PERMITTED_TOOLS`, so there was no live bypass. The union is kept because it is the right policy,
the claim was downgraded to hardening, and the half of the new test that passed on both sides was
deleted rather than padded. The route-refusal finding stays Critical for the same reason in reverse: no
live run mis-reported a PASS, but the load-bearing invariant was unenforced where it is owned.

One finding (the `themeid` comparison divergence between `theme-fidelity.mjs:1152` and
`visual-capture.ts:999`) is pre-existing by blame and is reported, not silently aligned: it changes
refusal semantics for the reference leg and that is an owner decision.

## D. Verification, and the state left behind

`fix-loop` 19/19, validator 10/10, `canary-campaign-verdicts` 17/17, `canary-fifteen-pages-report` 6/6,
`route-identity-gate` 14/14 (one existing assertion failed on the first cut and the union was changed to
preserve it), `test:fast` 466/466, `tsc --noEmit` and `compile` exit 0, `plans:check` exit 0.
`test:canary` is 157/162 and those five failures are the owner's machine-local artifact gap: the two
failing files import only Node built-ins, spawn `scripts/lib/build-report.mjs`, and die on
`referenced artifact missing: …artifact-3bcedf33…`.

The worktree is left holding 46 generated artifacts of a live `theme-fidelity-run4` measurement plus two
owner JSONs and one untracked owner report. They are not this change set's, they were never reverted, and
none of them were staged: every fix commit names its files explicitly.
