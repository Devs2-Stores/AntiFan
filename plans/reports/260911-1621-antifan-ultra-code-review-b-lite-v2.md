# Ultra code review — B-Lite v2 fix loop, route-identity gate, canary tooling

Date: 2026-09-11
Reviewer: controller session (main agent), best-of-5 candidates + controller validation
Change set: `669af839..b8c132f4` (13 commits) plus the fix commits listed in "Resolution"

## 1. Scope

Reviewed: my own change set from this session — route-identity gating (`URL_PATH_MISMATCH` /
`URL_THEME_MISMATCH` typed refusal family), the isolated fix loop (`stage`/`audit`/`merge`/`restore`,
FixRequest v2 + FixResult v2, diff-budget and tool-surface audits), the canary report guards, the
failure-signature lifecycle work, and the contract validator package.

Not reviewed: the repository tree outside the change set, the uncommitted generated artifacts listed
in §6, and the owner-side items in §5.

## 2. Method, and the verification degrade

1. One immutable review packet written to
   `.canary/staging/review-packet/ultra-code-review-packet.md` (10,485 B): scope, constraints,
   claimed evidence, the five author-stated limitations, rubric R1–R5, required output shape.
2. Five independent read-only reviewer candidates dispatched in one wave against that packet
   (`UltraCand1`–`UltraCand5`), blank context, no identity or self-rating shared between them.
   All five returned usable output. Outputs are preserved as
   `.canary/staging/review-packet/candidate-{A..E}.md` under a private randomized mapping.
3. **Verifier stage: unavailable.** The finalizer was dispatched three times — twice on the
   `reviewer` agent and once on `task` to work around the first failure — and all three died with
   the same provider error before producing output:
   `Cloud Code Assist API error (429) RESOURCE_EXHAUSTED`. No independent union or ranking could be
   produced by a subagent.
4. Consequence, stated plainly: this is **not** the ultra's asymmetric verification. The union and
   every validation below were produced by the controller, and each finding carries the command and
   output that confirmed it, so a reader can re-run them. Where a candidate's finding could not be
   confirmed by first-hand evidence it was dropped, not softened (§4).

## 3. Validated union

Ordered by blast radius. "Authorship" is from `git blame` against `669af839..b8c132f4`.

| # | Severity | Location | Defect | Confirmed by | Authorship | Resolution |
|---|---|---|---|---|---|---|
| U1 | Critical | `.canary/tools/fifteen-pages-run.mjs:1395`, `:1504-1505`, `:1519`, `:1596`, `:1681` | `generateReport` threw `TypeError: Cannot read properties of undefined (reading 'ok')` whenever a batch held both a page with no `phases` (a route-refused page) and a page that failed a phase. The report is the only publisher of a typed outcome, so that batch published nothing. The `80037e6` guard had covered the decision branch and missed the failure-pattern, summary-row, structural and section-14 branches. | repro: `generateReport({pageResults:{1:<failed>,6:<refused,phases:{}>}})` → THROWS pre-fix; stack pinned to `:1681`; OK 13,764 B post-fix | pre-existing line, guard incomplete in-range | **Fixed** + regression test |
| U2 | Critical | `scripts/lib/campaign-verdicts.mjs:245` | A route-refused leg that also carried a PASS verdict incremented both `tally.PASS` and `tally.ROUTE_REFUSED`, and `executiveVerdict` is `tally.PASS === cases.length ? 'PASS' : …` — so a run whose only case was route-refused published **`executiveVerdict: PASS`**. The invariant "a route-refused case can never enter the pass tally" was enforced only by the caller's discipline. `mintVerdict` is not on this path (no production caller), so the tally loop is the only place that can own it. | PRE-FIX measured: `tally {PASS:1, ROUTE_REFUSED:1}`, `executiveVerdict PASS`; POST-FIX: `PASS:0`, verdict `INCONCLUSIVE` | in-range | **Fixed** + test |
| U3 | Important | `scripts/lib/campaign-verdicts.mjs:338` | `computeRunExit` read route refusals only from `runSummary.refusals`, so a refusal witnessed only by the case record exited `1 INCOMPLETE_CASES` — a typed refusal reported as a pipeline failure, which the plan forbids. Two `.filter(...)` calls also ran unguarded on a possibly-absent `refusals` array. | PRE-FIX measured: `exit 1 INCOMPLETE_CASES`; POST-FIX: `exit 4 ROUTE_REFUSAL` | in-range | **Fixed** + test |
| U4 | Important | `.omp/extensions/antifan-fix-guard/tools/validate-contract.mjs:72-78` | Args inverted against the signature `auditDiffBudget(touchedPaths, totalBytesChanged, diffBudget)`: the byte ceiling was never enforced and a duplicate inline check (files only) masked it. `refused-diff-budget.json` passed only because it also exceeded `maxFiles`. | PRE-FIX: `auditDiffBudget(paths, {maxFiles,maxBytes}, 5120)` → `OK`; POST-FIX: `REFUSED_DIFF_BUDGET`. Validator 8/8 → 10/10 | in-range | **Fixed** + 1 new negative control |
| U5 | Important | `.canary/tools/fix-loop/audits.mjs:694`, `:733` | `request.forbiddenPaths \|\| DEFAULT_FORBIDDEN_PATHS` and the tool-surface equivalent: an empty or narrow declaration replaced the defaults instead of adding to them, so a request that allowed `package.json` (or a round that declared one custom tool pattern) silently un-forbade the manifest and the evaluate-class tools. `.omp/…/validate-contract.mjs:66` and `merge-gate.mjs:161` injected `[]`, which is truthy and defeats the default parameter. | PRE-FIX measured: empty `forbiddenPaths` touching `package.json` → `OK`; POST-FIX → `REFUSED_TOUCHED_PATH`. New control refuses pre-fix, passes post-fix | in-range | **Fixed** + 1 new negative control (paths) |
| U6 | Important | `.canary/tools/fix-loop/audits.mjs:237` | The budget's unit is "bytes changed" but `changeVolume = \|postSize - baseSize\|`, or the whole file when that was zero. A whole-file rewrite one byte longer measured **1 byte** and cleared any `maxBytes` ceiling. | measured with the same shapes: pre-fix `totalBytesChanged: 1` vs post-fix `803` for a 400 B file rewritten to 401 B | in-range | **Fixed**: exact line-multiset measure at the IO boundary, manifest delta kept for manifest-only callers + unit and staged-workspace tests |
| U6b | Important | `.canary/tools/fix-loop/merge-gate.mjs:224` | The same bypass survived **at the merge** — the point where the write actually happens — because `mergeStagedWorkspace`'s own audit called `runAllAudits` without `changedBytesFor`, so the merge priced a rewrite from the size delta while the standalone audit priced it from content. A file could be refused by `audit` and merged anyway. An unreadable or NUL-bearing rewrite additionally fell back to the net delta, i.e. it chose its own price. | pre-fix modules (`9d2922c`) run against a staged fixture: `decision=OK budgets.bytes=1` with `maxBytes: 20`, and **the target was mutated**; post-fix: `REFUSED_DIFF_BUDGET`, target untouched. NUL-bearing 25 B rewrite: post-fix charged 25 B, ceiling 20 → refused | in-range | **Fixed**: one module-level `changedBytesResolver` passed at both call sites; content that cannot be compared is charged its whole larger side, never nothing + 2 regression tests in the merge/audit pair |
| U7 | Important | `scripts/antifan-agent.cjs:646-652` | A child killed by a signal reports `code === null`, and `process.exit(code ?? 0)` published **success** for a killed delegated run. | live smoke test: `node scripts/antifan-agent.cjs node -e "process.kill(process.pid,'SIGTERM')"` → `LAUNCHER EXIT=1` post-fix (`0` pre-fix) | in-range | **Fixed** |
| U8 | Important | `src/main/verification/capture-settle.ts:640` | The `imageIdentityStable` failure reason hardcoded `observed class article__1024x900` — a page-specific class asserted for every page and viewport, from a gate that measures only the image-set hash, the moving witness, and geometry. An unmeasured observation in an evidence string. | read: `InPageSample` carries no class field; `article__1024x900` appears in no test | in-range | **Fixed** (reason now cites only measured facts) |
| U9 | Important | `test/unit/verification-lifecycle-budget.test.ts:305` | The test's comment claimed "even if caller passed a sample array with `passed: false`, evaluate produced VERIFIED" while passing `passed: true`. The mechanism is the opposite: `verification-evaluator.ts:149-150` *does* read `sample.passed` when present — that flag is the evidence channel. A test that documents a false mechanism weakens the R2/R5 claim it was cited for. | read: evaluator `:149-150`, `deriveFailureSignature` `:305-321` | in-range | **Fixed**: the test now names the real mechanism (`proofProfile.violations`), keeps the VERIFIED/undefined assertion, and adds REJECTED-with-violations, non-REJECTED-with-violations, and REJECTED-with-empty-violations cases |
| U10 | Important | `.canary/tools/fix-loop/audits.mjs:602` | `auditSelfVerification` refused only `=== true`, and no JSON-Schema/type validator runs over the contract (schemas are declarative; the tooling is pure Node built-ins), so `selfVerificationClaimed: "true"`, `1`, or `"yes"` cleared the NO-Self-Verification gate. | `auditSelfVerification('true').decision` → `OK` pre-fix, `REFUSED_SELF_VERIFICATION` post-fix | in-range | **Fixed** (refuse anything that is not explicitly `false`/absent), raw value now adjudicated and recorded so the gate and the receipt cannot disagree + test |
| U11 | Important | `scripts/lib/campaign-verdicts.mjs:484-500` + `:471` | Two conventions for one number: the tally counted a refused leg under `ROUTE_REFUSED` while `renderHubHtml` counted the same case as `INCONCLUSIVE` from the per-case verdict, so one hub printed `0 INCONCLUSIVE` in its header and `1 INCONCLUSIVE` in its ADJUDICATED line. | read of `buildVerdictIndex` `:220` vs the hub's `scopedCases` derivation | in-range | **Fixed**: a route refusal is minted as the case's own `verdict` (typed refusal, not a fidelity verdict), the tally counts one field once, and the hub excludes refused cases from the measured set + hub assertion |
| U12 | Minor | `.canary/tools/theme-fidelity.mjs:1152` | The harness refuses `requestedTheme !== observedTheme` while `src/main/verification/visual-capture.ts:999` guards with `expectedTheme !== null && …`: one contract, two implementations. | read both; `git blame` → `cada2d03`, **pre-existing** | pre-existing | **Reported** — deliberate-looking strictness, low reachability (a reference leg whose observed URL gains a themeid). Aligning or documenting it is an owner call, not a silent change: it alters refusal semantics for the reference leg. |
| U13 | Minor | `src/main/verification/capture-settle.ts:502`, `:551` | `evaluatePreCaptureQuiescence` accepts `signal` and the dwell `await new Promise(r => setTimeout(r, dwellMs))` ignores it. | read; caller `tab-devtools-host.ts:1493` passes no signal, so **no reachable unhonored abort today** | in-range (latent) | **Reported** — the option is dead API; wiring it is a change with no caller to verify against. |
| U14 | Minor | `scripts/antifan-agent.cjs:404-410` | A foreign-instance fallback socket is closed without `endSession`, leaving the foreign instance's session record and any ephemeral tab until TTL. | read; `git blame` → `c1f62bc6`, **pre-existing**; owner-side transport item | pre-existing | **Reported** — bounded by TTL, belongs with the owner's renewal/transport defect. |

U6b was added in a second pass: after the first union was fixed, the fixes themselves were put to an
advisory review, and the same byte-volume defect was found to survive at the merge call site (U6's fix
had landed on the audit path only). Its pre-fix measurement is against the modules as of `9d2922c`,
i.e. the state that already contained U6's fix.

Two hygiene items from that pass, both verified rather than asserted: the invariant "a route-refused
case never enters the pass tally" now lives in one test, in its canonical home
(`test/unit/route-identity-gate.test.mjs`, whose header names this defect), with a PASS-shaped fixture
in the field the tally reads — the previous fixture used `verdict: 'INCONCLUSIVE'`, a field the tally
does not read, which is why it could not catch the leak. Pre-fix that strengthened test fails three of
its assertions (`tally {"PASS":1,…}`, `executiveVerdict PASS`, hub `1 PASS / 0 FAIL / 0 INCONCLUSIVE`).
The duplicate test in the verdicts suite was deleted rather than kept beside it.

## 4. Dropped, with the reason and what was run
| Candidate claim | Outcome |
|---|---|
| "Custom `forbiddenToolPatterns` re-permits the default-forbidden tools" (my own U5 tool half) | **Downgraded to hardening.** Measured: pre-fix `runAllAudits` with `forbiddenToolPatterns: ['custom.*']` and `toolSurface: ['anti.browser.evaluate']` already returned `REFUSED_TOOL_SURFACE`, because the first call audits the policy object with the defaults and the second still refuses anything outside `DEFAULT_PERMITTED_TOOLS`. The union is kept (it is the right policy) but no live bypass is claimed, and the non-discriminating half of the test was removed rather than padded. |
| "Route-refused case increments PASS" as a *live* pipeline defect | Correct as a module-level invariant violation (U2) but the live path sets `overall: 'INCONCLUSIVE'` for a refusal (`fifteen-pages-run.mjs:1084`), so no live run published a false PASS. Severity kept Critical because the load-bearing invariant was unenforced at the module boundary that owns it, with PRE-FIX measurement shown in U2. |
| `merge-gate.mjs:164` `forbiddenPaths: []` "defeats the default" | Same defect as U5 and fixed there; the merge-gate line was removed as redundant. |
| "Tolerance reduction / mask-adding" style concerns | Not present: every fix tightens or preserves refusal behaviour; `useDefaultWidgetMasks:false` / `allowHeightDrift:false` and `INCONCLUSIVE` precedence are untouched. |

## 5. Candidate ranking appendix

The candidate self-reports were collected before anonymization; `C1 = UltraCand1` etc. "Self" means
the score the candidate gave itself — no independent scorer was available (§2.3).

| Candidate | Self-scored R1–R5 | Findings submitted | Union contribution |
|---|---|---|---|
| C1 (`UltraCand1`) | 17 / 18 / 19 / 19 / 18 | 4 | U1, U8(U12/U13 family), U5 tool half, U13 |
| C2 (`UltraCand2`) | `overall_correctness: incorrect` | 4 | U2, U4, U1 duplicate, U3 |
| C3 (`UltraCand3`) | not self-scored (structured findings only, conf. 0.85–0.95) | 5 | U5 paths half, U6, U7, U14, U10 |
| C4 (`UltraCand4`) | confidence 0.95, `overall_correctness: incorrect` | 2 | U9, U8 |
| C5 (`UltraCand5`) | confidence 1.0, `overall_correctness: correct` | **0** | none — a clean report over a 9.6k-line change in which four peers found validated defects |

C5's zero-finding report is recorded as an under-verification data point, not as corroboration of
quality: the packet's own constraint says a reviewer must not rubber-stamp.

## 6. Pending worktree state (not mine to revert)

`git status` at review time: 59 modified + 3 untracked. Of these, **46 are generated artifacts of a
live `theme-fidelity-run4` measurement** (`.canary/theme-fidelity-run4/compare/r1-vs-subject/*.json`,
`commands.jsonl`, `compare-index.json` — the latter showing `REFERENCE_IDENTITY_DRIFT` and
`generated_at` moving 05:25:54 → 06:46:56), 2 are owner JSONs
(`plans/…/live-theme-proof.json`, `plans/reports/mcp-overhaul-benchmark.json`), and 1 is an untracked
owner report. They are left exactly as found: machine evidence of an in-flight run, never reverted,
never staged into my fix commits.

The `--pending` scope therefore contained **no code of mine**: the review target is the committed
change set plus the fixes below. Every fix commit staged explicit pathspecs (15 files across 8
commits), never `-a`/`-A`: the union of those commits contains none of the 46 in-flight artifacts, no
owner JSON, and no untracked report.

Secrets: the session printed an `ANTIFAN_MCP_BOOTSTRAP` blob (a bridge secret with port, attachment
and run ids) to the terminal during a readiness probe. It is not reproduced anywhere in this report,
the journal, or any committed artifact, and no line added by this change set mentions a secret, token,
bearer value, or bootstrap payload (`git diff d9ccb06^..2fcd478 -- <my 15 files> | grep '^+' | grep -i
"antifan_mcp_bootstrap\|secret\|token\|bearer"` → empty).

## 7. Verification receipt

| Gate | Result |
|---|---|
| `.canary/tools/fix-loop/test-fix-loop.mjs` | **21/21** (16 before; +defaults control, +`measureChangedBytes` unit, +staged byte-volume control, +merge-path pricing control, +unreadable-content control; self-verification test extended) |
| `.omp/extensions/antifan-fix-guard/tools/validate-contract.mjs` | **10/10** (8 before; +byte-budget-only and +forbidden-default negative controls, both of which fail against the pre-fix code) |
| `test/unit/canary-campaign-verdicts.test.mjs` | **16/16** (+1: case-only refusal exit code; the duplicate tally test was deleted and the invariant kept in its canonical home) |
| `test/unit/canary-fifteen-pages-report.test.mjs` | **6/6** (+1: refused page beside failed page) |
| `test/unit/route-identity-gate.test.mjs` | **14/14** — one existing assertion (`exit.detail` = one entry for a page-level refusal) failed after my first cut and the union was fixed to preserve it, not the test; the tally test was later strengthened in place (PASS-shaped fixture + hub counts) and is discriminating |
| `npm run test:canary` | 161 tests / 156 pass / 5 fail — the 5 are `build-report-bundle-ordering` (2) and `build-report-embedded-drift` (3). Their assertion text, not just their names: `Error: Command failed: node scripts/lib/build-report.mjs test/fixtures/canary-run --out …` → `report generation failed: referenced artifact missing: test/fixtures/canary-run/evidence.viewportRuns[0].standalone.clone (id=artifact-3bcedf33-…) — tried: .antifan-data/control-plane-v2/artifacts/…`. A missing machine-local input, not a changed expected value; `build-report.mjs` imports only `evidence-provenance.mjs`, which this change set does not touch |
| `npm run test:fast` | **466/466** |
| `npx tsc -p ./ --noEmit` | exit 0 |
| `npm run compile` | exit 0 |
| `npm run plans:check` | exit 0 (`plans=59 … active=10`) |
| Launcher signal smoke test | exit 1 for a signalled child (pre-fix 0) |

Controls that discriminate (fail pre-fix, pass post-fix) exist for U1, U2, U3, U4, U5, U6, U6b, U10,
U11. U7 is proven by a live smoke test; U8 is a string-only correction verified by typecheck/compile,
with no test added for it because no test covers the quiescence reason strings. The pre-fix runs used
the committed modules (`git show <commit>:<path>` into a scratch directory beside their own imports),
so each control is measured against real previous code rather than a recollection of it.

## 8. Residual risk

- The byte-volume measure is exact when both file versions are on disk, which is the case for the
  `audit` and `merge` paths (`stored-content/` is written at stage time, before the fix is applied).
  A file whose bytes cannot be compared as text is charged its whole larger side rather than its size
  delta, so an unreadable rewrite is priced conservatively; a caller that supplies no resolver at all
  (manifest-only) keeps the net-delta approximation, documented at the function.
- U12/U13/U14 are left as reported owner decisions, not silent changes.
- The `test:canary` failures and the 46 in-flight run4 artifacts are outside this change set and
  remain the owner's to resolve.
