# Ultra Code Review — `--pending` (with session change set) — 2026-09-11

**Scope reviewed:** HEAD `9a1c0aa` (base `b4918cd`, 9 commits, 18 files, +460/−95) plus the pending set.
**Method:** `ak:code-review` with `code-review/references/ultra-verifier-mode.md`: controller-owned Stage 1 spec
check, five independent read-only candidate reviewers, one verifier producing the validated union.
**Result:** 8 validated findings (2 Important) — all repaired; 4 candidate findings rejected; verification green.

## 1. Scope resolution (why the pending set contained no code)

`git status --porcelain` listed exactly two modified tracked files:
`plans/reports/mcp-overhaul-benchmark.json` and
`plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/live-theme-proof.json` (29 insertions /
29 deletions). Both are rewritten by the suite itself (`scripts/smoke-mcp-industrial-e2e.cjs:410`,
`test/e2e/theme-golden-live.test.ts:31`) and contain timestamps and benchmark metrics only.

A review of those two data files would have reviewed nothing, so the substantive target became the code and test
change set of the session's nine commits (`b4918cd..HEAD`), with the two pending artifacts reported as the
non-hermeticity item they represent. That resolution is disclosed here rather than presented as the literal
`--pending` set.

## 2. Stage 1 — specification compliance (controller, once)

The change set implements the repair contract approved for the test-suite audit: 15 applied items plus one
deferred. Stage 1 verified each item against its stated intent and returned PASS, with two disclosures recorded:
three `copy-static.mjs` failure sites were hardened rather than the single one the finding named, and
`err.code` reaches the operator through the message text (Node prefixes messages with the code) rather than a
separate field. Guards held: no production file changed, no test weakened, deletion only for the test whose
subject exists nowhere in production, and the three `vm.Script` edits stayed additive.

## 3. Stage 2 — five candidates

Five `reviewer` agents received one immutable packet (`local://review-evidence-packet.md`, 7565 B) listing the
change set, the repair contract, the available evidence, the rubric (R1-R7), the hard exclusions, and the output
contract. All five produced usable reviews (4m35s-5m00s). Payload schemas were not uniform: two candidates
returned the findings array directly, three wrapped it in an `explanation` string field.

Candidates were anonymised programmatically to labels A-E before verification; the label-to-agent mapping is not
published. The verifier scored all five against the rubric; the highest-scoring candidate led on assertion
load-bearingness and evidence discipline.

## 4. Stage 3 — validated union

| Id | Labels | Location | Finding | Verdict | Action |
|---|---|---|---|---|---|
| U1 | C,D | `scripts/run-certify-soak.cjs:30-33` | `code ?? (signal ? 1 : 0)` resolves to 0 when code and signal are both null, publishing a torn-down soak as a pass | validated, Important | fixed |
| U2 | A,B,C,D,E | `scripts/copy-static.mjs:80-86` | Failing the compile when the source-tree dispatcher copy fails breaks builds on read-only `src/`, while the runtime loads the `.compiled` asset | validated, Important | fixed |
| U3 | A,C,D,E | `package.json:62` + harness | The new lane runs a harness with no userData isolation, against the developer's real profile | heredity (base `b4918cd`) | fixed anyway |
| U4 | A,B,C,D | `test/main/mcp-industrial-e2e.test.ts:204-217` | Inline cast on `env`; scrub list omits the terminal generation keys the child reads at `scripts/antifan-omp-mcp.cjs:614`; case-sensitive deletion is wrong on Windows | validated, Minor | fixed |
| U5 | B | `test/main/oauth-popup-manager.test.ts:94-98` | Asserting `isOAuthUrl(url) === true` for dangerous schemes pins a latent gap and would fail the moment it is closed | downgraded, Minor | fixed |
| U6 | B,C,D,E | `test/main/oauth-popup-manager.test.ts:109-115` | Three inline `as never` casts | heredity (base `b4918cd:64-67,79-82`) | report-only |
| U7 | B,C | `test/main/preview-protocol-and-watcher.test.ts:104-117` | The 404 comes from the segment walk rejecting `..`, not from the canonical containment check the title implies | downgraded, Minor | fixed |
| U8 | A,B,C,D,E | `scripts/copy-static.mjs:13-24,77-79`; soak | Retry omits the parent-directory creation; `dispatcherDst` write has no retry; soak child has no `error` handler | heredity (base `b4918cd`) | fixed |

Rejected by the verifier, with reasons: the claim that the probe parse check buries its diagnostic (contract item
13 required exactly that additive check, and it fails closed); the `if (!res.ok)` narrowing pattern
(pre-exists at base `b4918cd:68,81,89`); that the probe does not execute against a DOM double (beyond this
change set); and that the ipc-audit source assertions lack a runtime dispatch counterpart (a static audit suite).

## 5. Repairs applied

1. `scripts/copy-static.mjs:80-99` — the `.compiled` dispatcher write now retries three times for a transient
   lock held by a running Electron plane; the source-tree copy stays best-effort and warns instead of failing
   the build (U2, U8).
2. `scripts/copy-static.mjs:17-22` — the copy retry recreates the destination directory, so a first failure in
   `mkdirSync` no longer guarantees an unrecoverable ENOENT (U8).
3. `scripts/run-certify-soak.cjs:41-44` — only a numeric exit code is published; anything else exits 1 (U1).
4. `scripts/run-certify-soak.cjs:24-32` — a spawn `error` event is logged and exits 1 instead of crashing with
   the log handle open (U8).
5. `test/e2e/terminal-rename-space.test.cjs:19-45,109,150,185,188` — the harness runs against a throwaway
   userData directory, sweeps profiles left by earlier runs at startup, closes the windows and sweeps again
   before exiting through a single `finish()` path, and its mock workspace comes from `os.tmpdir()` instead of a
   hardcoded developer path (U3).
6. `test/main/mcp-industrial-e2e.test.ts:184,199-219` — `env` is typed `Record<string, string | undefined>`, and
   a normalised `Record` of the twelve pinned-context names is matched case-insensitively, adding
   `ANTIFAN_TERMINAL_AFFINITY_GENERATION` and `ANTIFAN_TERMINAL_GENERATION` (U4).
7. `test/main/oauth-popup-manager.test.ts:92-101` — the six deny cases remain; the loop asserting the
   classification of the masquerading URLs is gone, so hardening `isOAuthUrl` cannot break the test (U5).
8. `test/main/preview-protocol-and-watcher.test.ts:104-117` — the test is retitled to the segment refusal it
   actually exercises, with a comment naming the containment check it does not reach (U7).
9. `packages/site-clone/src/qa/clean-tab-probe.test.ts:9-35,62-83` — the assembled probe expressions are
   collected and parsed after the probe call, so a `SyntaxError` surfaces as itself. This came from a candidate
   finding the verifier rejected: the rejection was about severity (the nested check still failed the test), but
   the underlying fact — the probe converts an evaluator rejection into a generic failed check — reproduces, and
   the move keeps the check load-bearing with a legible message.

## 6. Verification

| Evidence | Command (bare, no pipe) | Result |
|---|---|---|
| Compile | `npx tsc -p ./` | exit 0 |
| Static staging | `node scripts/copy-static.mjs` (live Electron plane resident) | exit 0, assets copied |
| Soak, clean child | probe tree `.canary/state/soak-probe/`, `STUB_MODE=exit0` | exit 0 |
| Soak, child exit 7 | `STUB_MODE=exit7` | exit 7 (code preserved) |
| Soak, child signal | `STUB_MODE=sigterm` | exit 1 |
| Soak, unlaunchable child | probe tree `.canary/state/soak-probe-missing/` | exit 1, launcher log records the child failure |
| Exit-code semantics | old expression vs new, both `code=null, signal=null` | 0 vs 1 — the fail-open path reproduces at the expression level |
| External kill observation | `.canary/state/soak-probe/parent-observed.mjs` | `{"code":1,"signal":null}` — on this host the externally-killed path already reported 1, so U1 closes a latent path rather than a reproduced live failure |
| Main lane | `npm run test:main` | 1082 tests, 1081 pass, 0 fail, 1 skip — unchanged from the pre-repair baseline |
| Site-clone lane | `npm run test:site-clone` | 108 tests, 108 pass, 0 fail |
| Rename lane | `npm run test:terminal-rename` | exit 0, all checks passed |
| Harness re-runs | `node scripts/run-electron.cjs test/e2e/terminal-rename-space.test.cjs` ×3 | exit 0 each; leftover profile directories stayed at 1 across runs (bounded) |

The canary and fast lanes were not re-run: no file in their globs (`test/unit/*.test.mjs` and the
`.compiled/test/{unit,benchmark,renderer}` plus `.compiled/src` test globs) was touched by this change set.

## 7. Recorded, not repaired

- **Heredity, left with the repo's existing pattern:** the inline `as never` doubles in
  `test/main/oauth-popup-manager.test.ts` (base `b4918cd:64-67,79-82`) and the inline `Record<string, unknown>`
  cast in the sibling `test/main/mcp-persistent-transport.test.ts:99`; the `if (!res.ok)` narrowing pattern and
  the `Date.now()` temp-directory name in `test/main/preview-protocol-and-watcher.test.ts` (both pre-exist at
  base). Rewriting one call site would introduce a second convention inside a passing suite; a typed-double
  sweep is a separate change.
- **`copy-static.mjs` exports-fallback loop** skips a compiled renderer file that is absent
  (`if (fs.existsSync(dst))`). The compile chain runs `check-emit-integrity` and `prune-orphan-emit` around
  `tsc`, so a missing emitted twin is caught upstream; making it fail closed here would add a second abort
  source to a path reviewers asked to make less brittle.
- **Production defects surfaced by candidates, outside a test-focused review:** the QA matrix awards
  `passed: true` and a 100 score to unmeasured viewports (`src/main/qa/theme-qa-workflow.ts:715-745`),
  `isOAuthUrl` classifies non-HTTP schemes as OAuth (`src/main/browser/oauth-popup-manager.ts:24-58`),
  `local-session-vault` trusts foreign `file://` senders (`:78-80`), and `chrome-profile-sync` joins an
  unsanitised `profileId` into a path (`:266-267,530`). These carry over from the audit's report-only list and
  remain open.
- **Harness profile best-effort limit:** Electron recreates profile files while tearing down, so the exit sweep
  cannot always remove the directory; the startup sweep bounds the footprint at one directory per host, verified
  across three consecutive runs.

## 8. Disclosures

- The skill names Kongming as the verifier; that agent is not in this runtime's dispatchable set (`scout`,
  `reviewer`, `security-reviewer`, `task`, `sonic`), so all five candidates and the verifier ran on the same
  model tier. No per-subagent tier routing was applied.
- `--ultra` here is prompt orchestration: five independent candidates plus one verifier. No external
  LLM-as-a-Verifier framework and no numeric benchmark was run or claimed.
- The two pending JSON artifacts were left uncommitted, as in the preceding audit; their non-hermeticity is a
  real finding about the suite, and redirecting proof output to a temp path is a separate change.
- Coverage is not instrumented in this repo (no c8/nyc, no coverage script), so no candidate could support or
  refute a claim with a coverage delta.
- No candidate declared a write; every edit in this report was made by the controller. Candidate reviews were
  read-only per the packet's rules.
- Review artefacts: `local://review-evidence-packet.md`, `local://review-cand-{A..E}.json`,
  `agent://RevCand1`-`agent://RevCand5`, `agent://RevVerifier`. Lane logs: `.canary/state/review-main.log`,
  `review-siteclone.log`, `review-terminal-rename{,-2,-3}.log`.
- Open items inherited from the audit are unchanged and unresolved: the QA fail-open policy question, the
  plan-vs-code authority drift, the mint-tab reap refusal, and the two dirty artifacts' contract.
