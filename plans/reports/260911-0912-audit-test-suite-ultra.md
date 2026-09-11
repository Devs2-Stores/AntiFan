# Test Suite Audit — `ak:test audit --ultra --advice`

- Date: 2026-09-11 (local 09:12)
- Repository: `E:/Work/apps/AntiFan` (branch `main`)
- Scope: the repository's own test suites — `test/**` (184 files: 170 `.test.ts`, 14 `.test.mjs`),
  `packages/site-clone/**` (48 files, 12 `.test.ts`), and the test-facing `scripts/**` that decide
  whether those suites fail.
- Mode: best-of-N read-only detection (5 candidates) → verifier union → advice checkpoints →
  repair of the validated union → full re-run.
- Change surface: 14 test/script files modified, 1 test file deleted, `package.json` gained one lane.
  Zero production files (`src/**`, `packages/*/src/**` non-test, `.canary/tools/**`) touched. Two further
  artifacts in the working tree are not part of this change set: the suite itself rewrites them on every
  run (§6.1).

## 1. Method and its limits

| Stage | What ran | Result |
|---|---|---|
| Detection wave | 5 `scout` sweeps by class (disabled/unfinished, wiring + CI blind spots, history weakening, assertion quality, security fixtures) | 5/5 non-empty |
| Best-of-N | 5 read-only `reviewer` candidates, independent prompts, no shared state | 5/5 usable |
| Verifier | 1 read-only `reviewer` over anonymized candidates A–E (private mapping held by the controller), asked to confirm quotations and line anchors, drop unverifiable entries, dedup | 25-entry union, 6 rejections, ranking |
| Advice | 2 strongest-model advisory checkpoints (before and after detection) | GO conditional; repair list approved with guards |
| Repair | 1 controller + 4 disjoint repair agents | 16 items applied, 5 report-only, 2 deferred |
| Verification | `npx tsc -p ./` + `npm run build:site-clone` + all six suite lanes | 0 failures |

Disclosures required by this run:

- `kongming` is not dispatchable in this runtime (`Unknown agent "kongming". Available: scout,
  reviewer, security-reviewer, task, sonic`). Both advice checkpoints and the rubric scoring
  therefore ran on the strongest available model (`completion(model="slow")`), and per-subagent
  model-tier routing was unavailable. The external LLM-as-a-Verifier algorithm was not executed;
  `--ultra` here is prompt orchestration and multi-candidate union only, with no benchmark number.
- The verifier's first emission was truncated by the artifact capture at 30,266 of 45,380 bytes.
  The surviving prefix was recovered from the artifact, and the remainder was re-requested from
  the same verifier as a compact re-emission. Every union entry used below came from the verifier,
  not from the controller's own reading.
- The two strongest-model rubric scoring passes were inconclusive: the first lost class/severity
  fields during digest extraction, and the second mis-scored the CI-blind-spot class (it treated
  the absence of CI in this repository as a reason a masked exit code is unreportable). Rubric
  ranking is therefore recorded as advisory only and the verifier union governs the findings.
- Coverage is not instrumented in this repository: there is no `c8`/`nyc`, no `test:coverage`
  script, and no `.github/workflows`. No coverage percentage appears anywhere in this report, and
  redundancy could not be proven by coverage diff — every redundancy claim below rests on source
  reading plus an executed falsification where noted.

## 2. Before and after

| Lane | Before (E2E report, 2026-09-11) | After this audit |
|---|---|---|
| `test:canary` | 133 pass (a recheck of the same lane measured 138 pass; the E2E report recorded the lane as unstable and non-reproducing) | 137 pass, 0 fail |
| `test:fast` | 451 pass | 451 pass, 0 fail |
| `test:site-clone` | 108 pass | 108 pass, 0 fail |
| `test:integration` | 13 pass | 13 pass, 0 fail |
| `test:main` | 1078 tests, 1077 pass, 1 skip | 1082 tests, 1081 pass, 1 skip, 0 fail |
| `test:e2e` | 6 pass | 6 pass, 0 fail |
| `test:terminal-rename` (new lane) | not reachable by any runner | exit 0, all checks passed |
| Total | 1783 tests (the E2E total used the 133 figure for the canary lane) | 1797 tests, 1796 pass, 1 skip, 0 fail |

Delta explanation: `test:main` gained 4 tests (three new negative cases plus one split assertion
block), and `test:canary` lost 1 test because a file asserting a non-existent production function
was deleted. Against the stable canary measurement of 138, the arithmetic closes exactly at +3.
The single skip is pre-existing and carries its reason inline
(`test/main/windows-acl.test.ts:253`, live Windows DACL enforcement deferred on non-Windows).

## 3. Repaired findings (evidence-validated union)

Each entry: what was deceptive → what changed → why the repair is load-bearing.

### 3.1 Scripts that decided a suite's verdict

| # | Site | Defect | Repair |
|---|---|---|---|
| 1 | `scripts/run-certify-soak.cjs:30-33` | `process.exit(code \|\| 0)` — a child killed by a signal reports `code === null`, so a torn-down soak published exit 0 and the wrapper reported success for a run that never finished. | `process.exit(code ?? (signal ? 1 : 0))` — a signal death is now a non-zero exit. |
| 2 | `scripts/copy-static.mjs:12-27` | Nested empty `catch` swallowed a failed copy; a static asset that never landed left `npm run compile` green while the app ran without it. | Both attempts rethrow with source, destination and both error messages. Plus `:60-65` (silent give-up after three attempts to prepend the exports fallback) and `:82-86` (swallowed write of the shared terminal-write-dispatcher into `src/renderer`) now fail the compile with the path that could not be written. The second attempt is deliberately retained and the rethrow carries the target path plus both error codes, because the destinations live under `.compiled/` and a live Electron plane holds those files: verified by running `node scripts/copy-static.mjs` once with the plane up — exit 0, assets copied (`.canary/state/audit-copy-static-probe.log`). |

### 3.2 Tests that could not fail

| # | Site | Defect | Repair |
|---|---|---|---|
| 3 | `test/main/ipc-audit.test.ts:585-592` and `:604-611` | The terminal-affinity invariant was wrapped in `if (block.includes('bindTerminalAgentAffinity'))`, so deleting the binding made the assertion vanish instead of fail. | The presence of the binding is now asserted unconditionally, and the safe-binding regex assertion runs unconditionally beside it. Verified against production, which binds at `src/main/browser/native-tab-host.ts:1390` and `:1488`. |
| 4 | `test/main/artifact-capabilities.test.ts:50-67` | The redaction test only read a boolean flag, so it passed in the exact case it exists to catch — a redacted-looking metadata flag over unredacted stored bytes. | The test now reads the stored artifact bytes, asserts the file exists and is non-empty, then asserts the plaintext token is absent and `"token":"[REDACTED]"` is present. Falsified against a mutated call site: the new assertion fails, the old ones do not. |
| 5 | `test/main/preview-protocol-and-watcher.test.ts:62-95` | Only `.env` was exercised, leaving the directory-listing and traversal refusals unpinned. | Two negative cases added (index-less directory → 403 `Directory listing is disabled.`; `../` escape → 404). Falsified by two independent mutants, each caught only by its own new test. |
| 6 | `test/benchmark/benchmark-anti-hallucination.test.ts:48-54` | The assertion admitted `INCONCLUSIVE \|\| UNVERIFIED \|\| REJECTED` while the suite title forbids a pass for zero evidence. | Traced `src/main/verification/verification-evaluator.ts` (`:177-183` completeness `EMPTY`, `:199-206` verdict synthesis) and established the reachable set is a singleton: `INCONCLUSIVE` + `inconclusiveReason: 'UNOBSERVABLE'`. Tightened to both, keeping `notStrictEqual(verdict, 'VERIFIED')`. |
| 7-9 | `packages/site-clone/src/qa/mutation-qa-harness.test.ts:35-40`, `packages/site-clone/src/qa/clean-tab-probe.test.ts:10-23` and `:57-62`, `test/unit/capture-settle.test.ts:125-147` | Generated JavaScript was verified only by substring inspection — a script with a required identifier but invalid syntax passed. | Additive only: every existing substring assertion is retained (it is what proves the identifiers, flags and payloads are present) and a `new vm.Script(...)` parse assertion was added beside it. All three call sites emit self-invoking IIFEs, confirmed by parsing the compiled production artifacts. In `clean-tab-probe` the parse check sits inside the mock evaluator, so an invalid probe now makes the mock throw and the existing `passed` assertions fail. |

### 3.3 Missing coverage on security-relevant paths

| # | Site | Gap | Repair |
|---|---|---|---|
| 10 | `test/main/spa-resilience-and-debug-fixes.test.ts:74-141` | Only the `allowEval: true` branch existed; the deny branch was untested. | New test: with `allowEval: false`, `anti.browser.evaluate` is absent from `list({ grant: 'eval' })`, `dispatch` rejects with `POLICY_DENIED`, and the host evaluator is never reached. Falsified against `src/main/tools/capability-catalogue.ts:266` with the guard removed. |
| 11 | `test/main/oauth-popup-manager.test.ts:88-120` | Dangerous URL schemes were untested, including schemes crafted to look like OAuth authorize URLs. | Six cases: `javascript:`/`file:`/`data:` payloads plus three OAuth-masquerading variants; all must deny and must not call `onNewTabRequested`. The masquerade precondition (`isOAuthUrl === true`) is pinned so the test cannot pass by the URL simply not looking like OAuth. Falsified against `src/main/browser/oauth-popup-manager.ts:164-167`. |
| 12 | `test/main/mcp-industrial-e2e.test.ts:199-217` | The suite spawned its MCP child with ambient `ANTIFAN_*` in `process.env`, so a harness inside a live AntiFan session could answer a dropped call from the developer's real bridge. | The ten-key scrub already proven in `test/main/mcp-persistent-transport.test.ts:79-101` was applied at this spawn site. |

### 3.4 Wiring and hygiene

| # | Site | Defect | Repair |
|---|---|---|---|
| 13 | `test/e2e/terminal-rename-space.test.cjs:1-171` | A real 171-line Electron harness reached by no runner: `test:e2e` globs `.compiled/test/e2e/**/*.test.js`, which cannot match a `.cjs`. | Ran standalone first (exit 0, all checks passed: the intermediate value with spaces survived, the rename input was removed, and main received `{ id: 'session-1', name: 'Dev Server 1' }`), then wired into a dedicated lane `test:terminal-rename` following the existing `test:terminal-transport` pattern (`package.json:62`). Deliberately not added to the default chain. |
| 14 | `test/main/windows-acl.test.ts:164-166` and `:33` | The committed test carried this machine's real account SID (`S-1-5-21-1032163931-1416832417-2285110504-1001`) and real developer paths (`C:\Users\Admin\...`, `D:\Work\...`). | Replaced with a synthetic SID and generic paths; the assertions assert the strings are embedded in the generated ACL spec, so they remain green. |
| 15 | `test/unit/dump-ref-slider-sanitization.test.mjs:1-70` | The file asserted the opposite of shipped behaviour: it tested a test-local `sanitizeSlidersInDom` — a function defined inside the test's own body, with hand-built mock DOM nodes — that exists nowhere in production, while `.canary/tools/dump-ref.mjs:100-108` documents that slider geometry is deliberately preserved so the evidence can carry real layout. Satisfying it would have meant shipping the evidence-degrading behaviour. | Deleted, with the repo-wide absence of the subject re-verified before deletion (only the verifier's own union file, git's index and one historical journal mention the name). Its class is **outdated**, not **redundant**: the skill's coverage-diff precondition governs redundancy deletions, and this file's subject has no production counterpart, so by inspection it exercised no production path and no coverage could be lost. The audit's one redundancy-class candidate (`test/main/multitasking-decoupled-tab.test.ts:244-271`) was deferred, not applied, because the phase-02 suite's equivalence could not be proven. |

## 4. Report-only findings — real defects whose test repair would diverge from production

These were validated, are not test bugs in isolation, and repairing the test would either pin
behaviour production does not have or leave a failing suite. Per the audit's rollback guard they
are reported, not edited.

1. `test/unit/qa-matrix-viewports.test.ts:21-33` pins `passed: true` and `matrix.passed === true`
   for viewports the workflow never measured. Production awards the pass in
   `src/main/qa/theme-qa-workflow.ts:715-745` (`{ mismatchPercent: null, passed: true, measured: false }`,
   `visualScore = 100`). The gate is fail-open for unmeasured viewports by construction.
2. **Plan-vs-code drift, not a deceptive test.** `test/main/phase-02-agent-plane-authority.test.ts:616`
   is titled "(owner decision: no activation gate)" and asserts `switched === true`, matching an explicit
   owner decision recorded in the production source at `src/main/tools/browser-control-port.ts:2269-2273`
   and `src/main/tools/capability-catalogue.ts:303-306` ("local single-user app … no approval gate").
   What is stale is the plan:
   `plans/260909-0032-explicit-authority-dual-plane-cutover/phase-02-session-target-authority.md:57`
   still requires `USER_VISIBLE_OPERATION_FORBIDDEN` for `anti.browser.tabs.activate`, and its acceptance
   box at `:74` is unchecked. The test must not be reverted and the gate must not be restored; the open
   question is whether the owner decision supersedes that plan requirement (§8.2). The describe block's
   heading at `:585` still names the retired term.
3. `test/renderer/terminal-gap-state-machine.test.ts:38-60` validates a local re-implementation
   (`processChunkSim`) rather than the shipped gap machine in `src/renderer/standalone.js:676-793`,
   so it can stay green while the shipped logic drifts. Repairing it requires the production
   module to be loadable in isolation.
4. `test/main/local-session-vault.test.ts:181-205` — `isTrustedSessionVaultSender` trusts foreign
   `file://` URLs whose path merely matches `/renderer/` or `toolbar.html`. The missing negative
   case cannot be added while production trusts that shape.
5. `src/main/browser/chrome-profile-sync.ts:266-267,530` joins an unsanitized `profileId` into a
   filesystem path. The traversal test that should exist cannot pass against current production.
6. `test/main/agent-browser-script.test.ts:187-244` — the trajectory normalizer under test is a
   test-local copy of the production logic.

Two further hygiene items are report-only: `test/main/chrome-profile-sync-import.test.ts:112-120`
asserts a value in both branches of an if/else (deferred rather than repaired, because
establishing which branch production takes requires runtime state this audit did not control),
and `test/main/soak-test.test.ts:168-174` asserts literals it defines itself.

## 5. Refuted candidate findings

Six candidate findings did not survive verification and are recorded so they are not re-raised:

- Removing `--test-force-exit` to unmask failures — **refuted by experiment**: a deliberately
  failing assertion exits 1 with and without the flag. It is a hang suppressor, not a failure mask.
- `test/unit/local-credential-vault.test.ts` — the quoted line did not match the file.
- `src/extension/background.ts` — outside the test scope.
- `scripts/smoke-ephemeral-isolation.cjs` — the claim did not match the file.
- Two `.canary/state/**` artifacts — gitignored runtime state, not suite fixtures. They are **not** to be
  deleted or rotated as a "remove the real secrets" fix: the running harness mints live sessions from them
  (`.canary/tools/fifteen-pages-run.mjs` renews through `canary-session.mjs … .canary/state/canary-session.json`),
  so removing them would break the live session. Recorded as local-state hygiene only.

## 6. Defects and record corrections found by this audit's own verification

### 6.1 The suite rewrites tracked artifacts

Running the full sweep dirtied two tracked artifacts:
`plans/reports/mcp-overhaul-benchmark.json` (26 lines: timestamp and benchmark metrics) and
`plans/260905-0012-core-pre-freeze-hardening-and-live-proof/reports/live-theme-proof.json`
(3 lines). The writers are the suite itself — `scripts/smoke-mcp-industrial-e2e.cjs:410` and
`test/e2e/theme-golden-live.test.ts:31`. Consequence: a green suite does not leave the tree
unchanged, so any future gate that requires a clean tree after tests will fail for a reason that
has nothing to do with the change under test. Reported only; redirecting a proof artifact's
destination is a behaviour decision, not a test repair. Both files were left uncommitted.

### 6.2 The checks gate's two exit codes had been collapsed into one

The Phase 5 record stated the theme checks stage ran "exit 0 with findings" (journal
`plans/journals/2026-09-11-haravan-theme-fidelity-phase-5.md:85`). Two exit codes describe that stage and
the prose named only one:

- the **child** `scripts/theme-checks.mjs` refused — **exit 3**. Its own artifact already said so:
  `.canary/theme-fidelity-run4/checks.json` records `status: REFUSED`, `childExitCode: 3`, and the child
  text `[theme-checks] REFUSED (exit 3): settings-binding, assets`, with `report.json.provenance.checks`
  carrying `REFUSED`, `structural.ok false`, 2 refusals. `scripts/theme-checks.mjs:85-88` exits 3 whenever
  its refusal list is non-empty, and a bare re-run reproduced exactly that.
- the **driver stage** returned `EXIT.OK` (**0**) by design, because a readable structural artifact makes
  a refusal a carried finding rather than pipeline death (`.canary/tools/theme-fidelity-run.mjs:1494,1529`;
  `EXIT` at `:90`).

Both facts hold, so the earlier line was ambiguous rather than false; the journal and the phase-02 outcome
now name both codes. The substantive consequence stands: the pushed copy references 6 assets absent from
the source and 95 settings reads undeclared by `settings_schema.json`, and the gate refused it.

This is the same measurement class the audit found in the suite's own scripts (§3.1): a verdict read
through a pipe belongs to the last command in the pipe, not to the gate, and a stage-level 0 is not the
same signal as its child's 3. Every exit code recorded in this report was taken from a bare invocation.

## 7. Prioritised recommendations

1. Treat the QA matrix fail-open pass (§4.1) as a product defect: an unmeasured viewport must not
   report a pass. Fix production, then flip the pin in `qa-matrix-viewports.test.ts`.
2. Settle the plan drift (§4.2): the source carries an explicit owner decision retiring the activation
   gate while the plan still requires it. Update whichever side is stale; the test is correct as written.
3. Make the gap-machine test load the shipped module (§4.3). Until then the finding stays as it was
   filed — not repairable within a test audit, because `src/renderer/standalone.js` is a plain browser
   script that needs a DOM/global to run, so binding the test to it is a production change plus a DOM
   harness. Repair it only if that file exposes a seam drivable as-is.
4. Close the vault-sender and profile-path gaps (§4.4, §4.5) in production, then add the negatives.
5. Add the artifact-writing paths to a temp-directory contract (§6.1) so the suite stops mutating
   tracked files.
6. Add CI. Nothing in this repository gates a merge: there is no workflow file, so the script-level
   masks repaired here (§3.1) had no downstream signal to falsify them either.
7. Give the newly wired Electron harness its own temporary `userData` (the other smoke harnesses do),
   so a test run leaves no profile state behind and cannot contend with another Electron plane.

## 8. Unresolved questions

1. Is the QA matrix's fail-open pass a deliberate "not measurable ⇒ not blocking" policy? If yes,
   the test pin is right and the report should say so; if no, §4.1 is a shipping defect.
2. Does the owner decision recorded at `src/main/tools/browser-control-port.ts:2269-2273` supersede the
   plan requirement at `plans/260909-0032-explicit-authority-dual-plane-cutover/phase-02-session-target-authority.md:57`?
   The plan's acceptance box is still unchecked, so as it stands the plan and the code disagree.
3. Should the benchmark and golden-live proof artifacts be committed at all, or be run outputs?
4. The canary lane measured 133 and 138 tests for identical code across runs. This audit measured
   137 after deleting a 1-test file (verified: the deleted file held exactly one `it()`), which is
   consistent with the 138 figure and implies the earlier 133 was a partial result. The lane's own
   instability was never isolated; it is recorded here rather than closed.
5. The audit's candidate ranking is not published: the rubric passes were inconclusive (§1) and the
   controller's digest had already desynced path/line pairs for two candidates, so publishing a
   ranking would have recorded citations that were not verified. The verifier's union governs.

## 9. Evidence index

- Narrow re-run of every changed file: `.canary/state/audit-narrow.log` — 103 tests, 103 pass, 0 fail.
- Lane logs: `.canary/state/audit-sweep-test_{canary,fast,site-clone,integration,main,e2e}.log`.
- Canary lane: `.canary/state/audit-canary.log` — 137 pass, 0 fail.
- site-clone package: `.canary/state/audit-siteclone.log` — 9 tests, 9 pass; build log alongside.
- Orphan harness, standalone and post-wiring: `.canary/state/audit-orphan-rename.log`,
  `audit-orphan-rename-2.log` — exit 0, all checks passed.
- Verifier union as captured: `.canary/state/verifier-union.json`.
- Detection packet: `local://audit-evidence-packet.md`.
- `copy-static` hardening probe under a live Electron plane: `.canary/state/audit-copy-static-probe.log` — exit 0.
- Checks gate re-run, bare: `.canary/state/audit-theme-checks.log` and `.canary/state/audit-theme-checks.json`
  — exit 3, `ok false`, refusals `settings-binding, assets`; the stage's own record is
  `.canary/theme-fidelity-run4/checks.json` (`REFUSED`, `childExitCode 3`).
