# Ultra-verifier Audit — 2026-09-19 — AntiFan test suite (terminal-daemon-and-throughput)

Scope: the in-scope test surface of `E:/Work/apps/AntiFan` — `scripts/run-test-pipeline.mjs`,
`package.json` lane scripts, the terminal/MCP/e2e lanes under `test/e2e/` and `test/unit/`, the five
daemon P0 probes under `scripts/` plus `scripts/stage-daemon-host.mjs`, and
`scripts/smoke-mcp-industrial-e2e.cjs`. Read-only: no file was modified by any candidate or the
verifier. This report is the audit's deliverable — repairs are **not** applied here.

Method: five independent read-only candidates audited the same immutable evidence packet
(`local://ultra-audit-packet.md`); their outputs were anonymized as Candidate A–E
(mapping withheld from the verifier: A=AuditC5, B=AuditC2, C=AuditC4, D=AuditC1, E=AuditC3) and
scored by one stronger-model verifier (`agent://AuditVerifier`) against a five-criterion rubric
(evidence chain, validation strength, severity correctness, coverage breadth, repair specificity),
which then read every cited location, dropped what the citation did not support, and merged
duplicates into the union below.

Result: **35 validated findings** — 7 critical, 15 important, 13 minor — plus **2 candidate findings
dropped** as unvalidated (reasons recorded). Verifier verdict: **GO WITH THREE-PHASE GATING**.

## Executive summary

- **The systemic weakness is process/teardown discipline, not assertion quality in the ordinary sense.**
  Of the 7 critical items, 5 are leaked or unwatched process lifetimes (U2, U6, U7, U8 and the
  force-exit masking family) and 2 are pipeline gates that cannot fail.
- **Gate integrity:** three verdict-level deceptions survive today — the staged-host probe's
  unfalsifiable `inPlaceWrite !== 'ok' || renameWorks` check (U3), daemon RPC exceptions silently
  swallowed in the coverage probe (U17), and the goal-runner's lock-gated fast-fail plus discarded child
  stderr (U2). Each makes a probe/test report a PASS it cannot substantiate.
- **Pipeline blind spots:** `test:unit` (the suite holding 1000+ tests, including goal-runner) and
  `test:e2e:strict` are in `KNOWN_LANES` but not `TEST_LANES`; the five P0 daemon probes and
  `smoke:terminal` have no lane at all (U1, U4, U5, U20).
- **Top risk (verifier): promoting `test:e2e:strict` before the Phase 1 teardown plugs land** — the
  default lane's `--test-force-exit --test-concurrency=5` masks leaked sockets, timers and Electron
  trees; graduating the truth lane first would turn every one of them into a red suite.
  Mitigation: fix Phase 1+2, prove clean teardown, then graduate.

## Candidate ranking (verifier scores)

| Candidate | Source | Evidence | Validation | Severity | Coverage | Repair | Total | Claims dropped |
|---|---|---|---|---|---|---|---|---|
| C | AuditC4 | 20 | 20 | 19 | 19 | 19 | **97** | 0 |
| A | AuditC5 | 19 | 19 | 18 | 17 | 18 | **91** | 0 |
| D | AuditC1 | 18 | 19 | 19 | 14 | 18 | **88** | 0 |
| B | AuditC2 | 17 | 17 | 18 | 18 | 18 | **88** | 1 |
| E | AuditC3 | 17 | 16 | 16 | 18 | 17 | **84** | 1 |

C's margin is architectural depth with zero speculation; D scored highest signal-to-noise (12/12
validated) but narrowest class coverage; B and E each lost one claim to misattributed lines and a
false redundancy claim respectively.

## Controller re-verification (fresh evidence, beyond the verifier's pass)

Before this report was finalized the controller re-read the cited sources for the critical families:

- **U6 — confirmed.** `scripts/probe-daemon-reattach.cjs` (:240-270): the `catch` block kills only
  `spawnedPid`, and phase 2 never sets it — its host is `prior.pid`, killed solely on the happy path.
  Any phase-2 failure leaves the daemon host and its shell child running, contradicting the block's
  own comment. Session-corroborated: earlier E2E runs in this plan left orphan daemon hosts that had
  to be killed manually.
- **U3 — confirmed, with intent noted.** `scripts/probe-staged-host-rpc.cjs` (:283-305): the recorded
  check is `inPlaceWrite !== 'ok' || renameWorks`, true whether or not the lock is held, so it can only
  fail in one quadrant; the author's comment admits asserting it "would be theatre". It nonetheless
  participates in `checks.every(...)` for the probe verdict, and the same block renames the live
  `node_modules/node-pty/prebuilds/<platform>/pty.node` — a probe mutating the developer's install.
- **U17 — confirmed.** `scripts/probe-rpc-surface-coverage.cjs` (:295-309): only
  `UNKNOWN_METHOD|Unknown method|not implemented` rejections are classified; every other exception is
  invisible, so "dispatch proof for every name in the protocol" passes vacuously for a crashing handler.
- **U2 — confirmed.** `test/unit/goal-runner.test.mjs` (:80-87, :158-160, :185-186): fast-fail requires
  a lock file whose pid is dead (`alive === false`); with no lock (`runnerAlive=no-lock`) the helper
  burns the full 120 s hard budget, and both spawned runners discard stderr via
  `child.stderr.on('data', () => {})`, so the failure names neither cause nor exit code.
- **U1/U4/U5/U20 — confirmed from live lane data.** `run-test-pipeline.mjs:19-34` lists the default
  lanes; `node -e` over `package.json` scripts shows `test:unit`, `test:e2e:strict`, `smoke:terminal`
  and the `probe-*.cjs` chain exist but are outside the default lane set. The unit lane ran green
  (1000+ tests) when invoked by hand in this plan — i.e. coverage exists but never gates by default.
- **Disabled-class nuance (not in the union, recorded for completeness).** The `skip` inventory is
  ~20 jsdom-availability guards plus documented platform/phase deferrals; `jsdom` resolves in this
  checkout (declared devDependency, installed), so those guards do not fire here — latent, not live.
- **Transport-sync realism (U10/U23 context).** `test/e2e/terminal-transport-sync.cjs` drives a real
  Electron window, preload, IPC and `TerminalManager`/`SessionDeliveryJournal`, but injects data via
  `feedAndStoreChunk` against a stub session (:54-72, :103-107) while a comment at :202 says chunks are
  "produced by PTY" — the delivery gates are genuinely exercised; PTY backpressure is not.
- **Security surface (U12/U13 context).** Two sibling files already escape PowerShell interpolation by
  doubling quotes (`probe-staged-host-rpc.cjs:222`, `probe-terminal-host-survival.cjs:121`);
  `probe-daemon-reattach.cjs:159,174,229` interpolate raw — the repair is the existing in-repo idiom,
  not a new one.

## Validated union — 35 findings, grouped by execution phase

Grouping follows the verifier's go/no-go phasing; each item is evidence-validated (citation read at source) and deduplicated across candidates.

### Phase 1 — Teardown leak plugs & diagnostic fast-fails (zero CI risk)

#### U2 — critical / deceptive — `test/unit/goal-runner.test.mjs:80-87, 158-160`

- Sources: A, B, C, D, E | confidence: high | repair risk: low: alters only test polling failure detection and improves error diagnostics.
- Evidence: In `waitForProgress`, `const alive = lock?.pid ? isAlive(lock.pid) : null; if (alive === false) ...`. When a runner crashes before acquiring the mutex or after releasing it, `lock` is null so `alive` is `null`; `alive === false` evaluates to false, causing the helper to spin for the full 120s `hardMs` budget. Lines 158-160 also discard child stderr via `child.stderr.on('data', () => {})`.
- Why it matters: A crashed runner child is masked as a 2-minute stall timeout rather than an immediate process failure, obscuring the root cause and inflating suite runtime.
- Repair: guard-change: Check `child.exitCode !== null` or child process liveness directly in `waitForProgress`, fail fast on dead process, and buffer stderr into assertion diagnostics.


#### U7 — critical / ineffective — `test/e2e/terminal-live-pty.test.ts:115-135`

- Sources: B, E | confidence: high | repair risk: low: prevents background process leaks on test failure.
- Evidence: If any assertion inside `it(...)` throws prior to line 172 (`const kill = tm.kill()`), the `after()` hook simply iterates `privates.sessions.values()` setting `session.pty = null` and calls `privates.sessions.clear()`. It never invokes `session.pty.kill()` or `tm.kill()`.
- Why it matters: Any assertion failure or timeout in `terminal-live-pty.test.ts` leaves active PowerShell and conhost.exe processes orphaned in the background.
- Repair: guard-change: Call `tm.kill()` or execute `taskkill` on tracked session PIDs within the `after()` hook before clearing the session map.


#### U6 — critical / security — `scripts/probe-daemon-reattach.cjs:249-258`

- Sources: D | confidence: high | repair risk: low: safe teardown guard on probe exception.
- Evidence: In phase 2 (`--phase=2`), the error handling block cleans up with `if (spawnedPid) { killTree(spawnedPid); }`. But `spawnedPid` is initialized to 0 and only set in phase 1; phase 2 reads the active processes into `prior.pid` and `prior.childPid`. On any phase 2 failure, `killTree` is never called.
- Why it matters: Failed probe runs leave the detached daemon host (`prior.pid`) and its background shell child (`prior.childPid`) running permanently on developer and CI machines, holding data root directory locks.
- Repair: rewrite: Update catch cleanup in `run()` to invoke `killTree(prior.pid)` and `killTree(prior.childPid)` whenever `prior` is loaded in phase 2.


#### U8 — critical / ci-blind-spot — `test/e2e/mcp-industrial-overhaul.test.ts:34-44`

- Sources: E | confidence: high | repair risk: low: ensures complete process tree termination on timeout.
- Evidence: On watchdog timeout (90s), the test executes `proc.kill('SIGTERM')` and `proc.kill('SIGKILL')` on the Node wrapper process. On Windows, Node does not propagate signals to child processes, leaving the spawned Electron process tree orphaned.
- Why it matters: Orphaned `electron.exe` instances and Chromium worker processes continue running in the background, holding locks on workspace files and TCP ports.
- Repair: rewrite: Execute `taskkill /PID String(proc.pid) /T /F` on Windows on watchdog timeout rejection.


#### U11 — important / missing-edge — `scripts/smoke-mcp-industrial-e2e.cjs:513-530`

- Sources: A, B, C, D, E | confidence: high | repair risk: low: prevents spurious CI failures under system load while preserving stall detection.
- Evidence: Line 513 sets `STALL_ENVELOPE_MAX_MS = HEARTBEAT_MS` (1000ms, injected via `ANTIFAN_HEARTBEAT_MS: 1000`), and line 522 asserts `max < STALL_ENVELOPE_MAX_MS`. Setting the maximum allowable single-call latency exactly equal to the heartbeat period leaves zero margin for OS scheduling jitter or GC pauses.
- Why it matters: Under parallel test execution on loaded multi-core machines, an isolated 1001ms tail dispatch causes deterministic test failure despite an average latency of ~15ms.
- Repair: guard-change: Decouple the tail latency envelope from the heartbeat period with an explicit variance margin (e.g. 1.5x or 2x `HEARTBEAT_MS`).


### Phase 2 — Correctness & security invariant hardening (low CI risk)

#### U3 — critical / deceptive — `scripts/probe-staged-host-rpc.cjs:283-305`

- Sources: B, C, D, E | confidence: high | repair risk: low: separates diagnostic metrics from pass/fail gates and avoids workspace file mutation.
- Evidence: `record('(measured) workspace addon lock while a workspace host runs', inPlaceWrite !== 'ok' || renameWorks, ...)` is a boolean tautology on Windows (if locked, `inPlaceWrite !== 'ok'` holds; if unlocked, `renameWorks` holds). Furthermore, performing `fs.renameSync` directly on `node_modules/node-pty/prebuilds/.../pty.node` in the live workspace risks corrupting the developer environment if aborted mid-swap.
- Why it matters: Staging isolation failures cannot fail the probe because the assertion is unfalsifiable, while live workspace binaries are exposed to mutation risk.
- Repair: rewrite: Assert separate deterministic expectations for in-place write refusal and rename capability on a staged fixture copy instead of mutating live `node_modules`.


#### U14 — important / ineffective — `scripts/lib/antifan-mcp-client.mjs:53-67, 126-136`

- Sources: B | confidence: high | repair risk: low: defensive timeout handling.
- Evidence: `sendRaw` returns a raw Promise stored in `this.pending` without a timeout watchdog, and lines 53-67 catch JSON parsing errors in an empty `catch (e) {}` block.
- Why it matters: If the spawned MCP child wedges without exiting or emits malformed non-JSON lines, the pending Promise hangs indefinitely, blocking any test harness using `AntiFanMcpClient`.
- Repair: add-cases: Add a configurable timeout to `sendRaw` that rejects pending requests and log/surface malformed JSON lines.


#### U17 — important / deceptive — `scripts/probe-rpc-surface-coverage.cjs:304-314`

- Sources: C | confidence: high | repair risk: low: surfaces runtime exceptions in daemon RPC handlers.
- Evidence: In the live dispatch loop over `HOST_METHOD`, line 307 catches invocation rejections: `catch (err) { const message = ...; if (/UNKNOWN_METHOD|Unknown method|not implemented/i.test(message)) undispatched.push(...) }`. Any other error thrown by the host is silently swallowed.
- Why it matters: A method handler that throws internal runtime exceptions (crash, TypeError, unhandled rejection) inside the daemon is recorded as successfully dispatched because only explicit `UNKNOWN_METHOD` errors are flagged.
- Repair: guard-change: Fail the probe on any unexpected 500 error or crash response from the daemon instead of silently ignoring non-UNKNOWN_METHOD exceptions.


#### U12 — important / security — `scripts/probe-daemon-reattach.cjs:28, 188-199`

- Sources: A, B, C, E | confidence: high | repair risk: low: restricts file visibility on shared machines.
- Evidence: Lines 188-199 write `handle.token` unencrypted in plaintext JSON to `stateFile` (`phase1.json`) inside `os.tmpdir()/antifan-daemon-reattach` with default file permissions.
- Why it matters: Shared temporary directories on multi-user systems or CI agents allow any unprivileged local process to read the authentication token and gain unauthorized control over the detached daemon terminal.
- Repair: guard-change: Enforce restrictive file permissions (0o600) on `stateFile` or pass the reattach credential via an isolated session vault.


#### U15 — important / ci-blind-spot — `scripts/run-test-pipeline.mjs:41-47, 59-67`

- Sources: A | confidence: high | repair risk: low: guarantees build freshness on targeted test execution.
- Evidence: When a single lane is passed (e.g. `node scripts/run-test-pipeline.mjs test:unit`), `options.lanes` contains only that lane without prepending `compile`. Because individual test scripts do not compile TypeScript, targeted runs execute against stale `.compiled/` artifacts without warning.
- Why it matters: Engineers and automated subagents running targeted lanes observe false passes or outdated failures due to unbuilt TypeScript sources.
- Repair: guard-change: Automatically prepend `compile` whenever any compile-dependent lane is selected unless an explicit `--no-compile` flag is provided.


#### U19 — minor / redundant — `scripts/run-test-pipeline.mjs:20-32`

- Sources: C | confidence: high | repair risk: low: eliminates duplicate compilation overhead in test pipeline.
- Evidence: `package.json:60-63` defines `test:terminal-transport`, `test:terminal-rename`, `test:mcp-dispatch-hub`, and `test:toolbar-qa-hub` as each starting with `npm run compile && ...`. Because `run-test-pipeline.mjs` already executes `compile` as the first lane, running the pipeline triggers 5 redundant full compilation cycles.
- Why it matters: TypeScript compilation, type validation, static asset copy, extension build, and payload gating run 5 times during a single pipeline run, adding substantial redundant build overhead.
- Repair: rewrite: Remove `npm run compile &&` prefixes from individual test lane scripts in `package.json` and let `run-test-pipeline.mjs` orchestrate the single compile step.


### Phase 3 — Pipeline gate graduation (managed CI convergence)

#### U4 — critical / ci-blind-spot — `package.json:20-80`

- Sources: A, B, C, D | confidence: high | repair risk: medium: requires isolated environment configuration for spawning detached daemon hosts in CI.
- Evidence: The five core P0 daemon probe scripts (`scripts/probe-daemon-reattach.cjs`, `scripts/probe-staged-host-rpc.cjs`, `scripts/probe-terminal-host-survival.cjs`, `scripts/probe-rpc-surface-coverage.cjs`, `scripts/probe-persist-cost.cjs`) are completely absent from `package.json` scripts and `scripts/run-test-pipeline.mjs`.
- Why it matters: Detached daemon host survival, PTY re-attachment, RPC coverage, and native addon isolation contracts never execute in automated test runs.
- Repair: add-cases: Define `probe:daemon` in `package.json` and aggregate daemon probe execution into a dedicated validation lane in `run-test-pipeline.mjs`.


#### U5 — important / ci-blind-spot — `package.json:46, 59`

- Sources: A, B, C, D, E | confidence: high | repair risk: low: incorporates existing passing smoke suites into automated pipeline runs.
- Evidence: `package.json:59` defines `smoke:terminal` running three `.cjs` suites (`terminal-recovery-smoke.cjs`, `terminal-renderer-smoke.cjs`, `terminal-split-hydration-probe.cjs`). Because `test:e2e` only globs `.compiled/test/e2e/**/*.test.js`, and `smoke:terminal` is absent from `TEST_LANES` in `scripts/run-test-pipeline.mjs:20-33`, these suites never execute in CI.
- Why it matters: Renderer geometry collapse, empty state recovery, and terminal split hydration races can regress undetected.
- Repair: add-cases: Include `smoke:terminal` in `TEST_LANES` or wrap individual smoke scripts into pipeline-compatible lanes.


#### U20 — important / ci-blind-spot — `scripts/run-test-pipeline.mjs:19, 46`

- Sources: A, B | confidence: high | repair risk: low: adds fast static checks to default test runs.
- Evidence: `STATIC_LANES = ['audit', 'plans:check']` are only appended if `options.verify` is true (`npm run verify`). The default `npm test` runs only `TEST_LANES`, leaving `audit` (`check-bottlenecks.mjs`) and `plans:check` (`check-plans.mjs`) completely unverified.
- Why it matters: Reopened bottlenecks in `plans/bottlenecks.json` and corrupted plan frontmatter do not fail standard local or PR test runs.
- Repair: guard-change: Include `STATIC_LANES` in the default pipeline execution set.


#### U1 — critical / ci-blind-spot — `scripts/run-test-pipeline.mjs:33-35`

- Sources: A, B, C, D, E | confidence: high | repair risk: medium: will immediately expose existing handle and process leaks across e2e test suites.
- Evidence: `test:e2e:strict` is documented as the 'truth lane for leaked handles' without `--test-force-exit`, but is kept in `KNOWN_LANES` and excluded from `TEST_LANES`. Default pipeline runs only `test:e2e` which runs with `--test-force-exit --test-concurrency=5` in `package.json:46`.
- Why it matters: Forcible process termination masks leaked child processes, unclosed WebSocket/HTTP sockets, and lingering event loop timers across the entire e2e test suite in standard CI.
- Repair: guard-change: Promote `test:e2e:strict` into the default test pipeline or remove `--test-force-exit` once suite watchdogs and handle teardowns are verified.


### Backlog — remaining validated findings (ordered by severity, then file)

#### U33 — important / missing-edge — `scripts/probe-daemon-reattach.cjs:140-155, 200-245`

- Sources: A, E | confidence: high | repair risk: low: expands probe edge case coverage.
- Evidence: Phase 2 only verifies clean re-attachment where the daemon remained healthy and unperturbed. It never tests rejected invalid tokens, corrupted state files, or stale socket recovery.
- Why it matters: Daemon recovery routines for stale sockets or authentication token mismatches remain completely unexercised by the P0 re-attach verification.
- Repair: add-cases: Add test cases for stale socket recovery, token mismatch rejection, and crashed host re-spawning.


#### U13 — important / security — `scripts/smoke-mcp-industrial-e2e.cjs:300-316`

- Sources: A, B, C, E | confidence: high | repair risk: medium: requires updating proxy child bootstrap and WebSocket handshake protocols.
- Evidence: Bootstrap secrets and daemon host tokens are passed via process environment variables (`ANTIFAN_MCP_BOOTSTRAP` in `smoke-mcp-industrial-e2e.cjs:304` and `ANTIFAN_TERMINAL_HOST_TOKEN` in `probe-staged-host-rpc.cjs:117`), and WebSocket connections include tokens in query strings (`probe-staged-host-rpc.cjs:139`).
- Why it matters: Environment variables are visible across local process tables (e.g. via `Get-CimInstance Win32_Process`), and URL query strings are exposed in network diagnostics.
- Repair: guard-change: Pass secrets via secure standard input pipes or HTTP upgrade headers, and add negative assertions verifying invalid credentials are rejected.


#### U18 — important / unfinished — `scripts/smoke-mcp-industrial-e2e.cjs:538-575`

- Sources: A, B | confidence: high | repair risk: low: adds coarse leak threshold without fragile tight tolerances.
- Evidence: Milestone 4 claims to verify 50-Cycle Rapid Dispatch Stability and computes `proxyRssSlopeBytesPerCycle`. However, the comment admits: 'the samples are INFORMATIONAL ONLY — reported, never asserted as a leak verdict', asserting only `burstFailures.length === 0` and wall-clock `burstMs < 60_000`.
- Why it matters: Memory accumulation regressions and unbounded RSS growth across rapid MCP dispatch bursts pass without tripping any gate.
- Repair: guard-change: Add a coarse upper bound assertion on RSS growth slope to catch runaway memory expansion.


#### U35 — important / missing-edge — `scripts/smoke-mcp-industrial-e2e.cjs:795-803`

- Sources: B | confidence: high | repair risk: low: protects against indefinite process hangs.
- Evidence: `app.whenReady()` initializes the test suite and calls `runMcpLiveE2ETest()`, but there is no watchdog or timeout timer wrapping `app.whenReady()`.
- Why it matters: If Chromium fails to reach ready state due to GPU/display driver or Electron initialization hangs, the process hangs forever.
- Repair: guard-change: Add a top-level `setTimeout` watchdog before `app.whenReady()` that logs an error and calls `app.exit(1)`.


#### U9 — important / deceptive — `test/e2e/terminal-live-pty.test.ts:75-88, 169-170`

- Sources: A, B, D | confidence: high | repair risk: low: eliminates silent WMI fallback and ensures descendant tracking fidelity.
- Evidence: In `processParents()`, PowerShell `Get-CimInstance Win32_Process` timeout or execution error is caught and returns an empty Map. Consequently, `tracked = [shellPid, ...descendantsOf(shellPid, processParents())]` collapses to `[shellPid]`, making `assert.ok(tracked.length >= 1)` a tautology and omitting child console hosts from teardown verification.
- Why it matters: Leaked console host child processes (`conhost.exe`, `OpenConsole.exe`) on Windows pass the teardown leak assertion unnoticed whenever WMI queries stall or fail.
- Repair: guard-change: Require `processParents()` to return a non-empty process table on Windows before asserting teardown completeness.


#### U16 — important / ineffective — `test/e2e/terminal-rename-space.test.cjs:68-90`

- Sources: C | confidence: high | repair risk: low: swaps mock array handlers with actual TerminalManager instance methods.
- Evidence: The test launches real Electron but replaces all backend IPC channels (`antifan:terminal:rename-session`, `antifan:terminal:list-sessions`, `start`, `write`, `resize`) with in-memory closures manipulating a dummy `mockSessions` array.
- Why it matters: Real backend validation, shell argument escaping, and daemon session rename persistence are never tested; special character or whitespace encoding regressions in backend services will pass undetected.
- Repair: rewrite: Connect the rename test to the compiled `TerminalManager` instance or daemon proxy rather than mocking IPC handlers in Electron Main.


#### U10 — important / deceptive — `test/e2e/terminal-transport-sync.cjs:54-72`

- Sources: A, B, C, E | confidence: high | repair risk: low: clarifies test boundary and removes misleading claims of full PTY transport certification.
- Evidence: Despite advertising 'AntiFan Terminal Transport Sync & Invariant Certification (Real Electron Runtime)', lines 54-72 inject a dummy `realSession` into `privates.sessions` with stubbed callbacks (`pty: { pid: 99999, kill: () => {}, write: () => {}, onData: () => ({ dispose: () => {} }) }`) and delivers data via synthetic `feedAndStoreChunk`.
- Why it matters: PTY stream buffering, ConPTY encoding, and backpressure between node-pty and TerminalManager are completely bypassed by the test.
- Repair: rewrite: Either exercise real PTY streams via `tm.createSession` or retitle the test to reflect renderer journal delivery certification.


#### U34 — important / missing-edge — `test/unit/antifan-mcp-client.test.mjs:18-44`

- Sources: B | confidence: high | repair risk: low: expands unit test coverage.
- Evidence: The unit test for `AntiFanMcpClient` covers only 2 cases: listing >= 50 tools on connect, and rejecting when a tool returns an error payload. There are zero test cases for child process crash during in-flight requests, malformed stdout JSON, or connection failure handling.
- Why it matters: Crash recovery and abnormal exit handling in the MCP client are completely unvalidated.
- Repair: add-cases: Add unit tests verifying that `client.callTool` rejects promptly when the child process exits or emits invalid JSON.


#### U32 — minor / redundant — `package.json:40, 44`

- Sources: A | confidence: high | repair risk: low: clarifies package.json script boundaries.
- Evidence: `test:fast` and `test:unit` share ~90% of the same file globs, yet `test:unit` is omitted from `scripts/run-test-pipeline.mjs` default lanes while `test:fast` is included.
- Why it matters: Redundant and confusing overlapping script definitions increase maintenance overhead.
- Repair: rewrite: Consolidate `test:unit` and `test:fast` into clearly delineated unit vs fast lane definitions.


#### U26 — minor / missing-edge — `scripts/check-plans.mjs:84-128`

- Sources: C | confidence: high | repair risk: low: ensures the gate only passes when plans actually exist to validate.
- Evidence: In `main()`, `return unknown.length === 0 && missingFrontmatter.length === 0 ? 0 : 1`. If `options.root` contains no plan files (`files.length === 0`), both arrays are empty and it exits 0.
- Why it matters: If the plans directory is misplaced, deleted, or pointed to an empty directory, the check silently passes with exit code 0.
- Repair: guard-change: Require `files.length > 0` before returning success in `check-plans.mjs`.


#### U28 — minor / unfinished — `scripts/probe-persist-cost.cjs:180-215`

- Sources: C | confidence: high | repair risk: low: defines explicit upper-bound latency budgets.
- Evidence: The probe measures persistence flush timings across four scenarios, but line 208 unconditionally outputs `PROBE_RESULT { ok: true, rows }` without asserting against any latency budget or threshold.
- Why it matters: Persistence flush latency regressions from 20ms to 20,000ms still emit `ok: true`, providing zero regression gating.
- Repair: add-cases: Add assertions against acceptable maximum flush latency budgets.


#### U27 — minor / outdated — `scripts/run-test-pipeline.mjs:35, 60-64`

- Sources: C | confidence: high | repair risk: low: ensures canary diagnostic tests run even if compilation fails.
- Evidence: `COMPILE_DEPENDENT = new Set(TEST_LANES.filter((lane) => lane !== 'compile'))` marks all lanes, including `test:canary`, as compile-dependent. However, `test:canary` runs `test/unit/canary-*.test.mjs` which are pure uncompiled ESM files.
- Why it matters: When TypeScript compilation fails, `test:canary` is skipped even though it could run uncompiled unit tests to diagnose runtime issues independent of build artifacts.
- Repair: guard-change: Exclude `test:canary` from `COMPILE_DEPENDENT` in `scripts/run-test-pipeline.mjs`.


#### U29 — minor / outdated — `scripts/stage-daemon-host.mjs:41-47`

- Sources: D, E | confidence: high | repair risk: low: improves test portability across environments.
- Evidence: `resolveDataRoot` checks hardcoded candidate paths `['E:\\Work\\.antifan-data', 'E:\\.antifan-data', 'D:\\Work\\.antifan-data']` and fails if none exist, while `scripts/probe-staged-host-rpc.cjs:28` hardcodes `DATA_ROOT` to `'E:\\Work\\.antifan-data'`.
- Why it matters: Probes fail immediately with path resolution errors on developer machines or CI containers where drive E: or D: does not exist unless `ANTIFAN_DATA_ROOT` is set.
- Repair: guard-change: Fall back to `os.homedir()` or `os.tmpdir()` when candidate drive paths do not exist.


#### U24 — minor / outdated — `test/e2e/terminal-paint-bench.cjs:1-40, 320-358`

- Sources: A, B, D, E | confidence: high | repair risk: low: clarifies execution role of orphan benchmark file.
- Evidence: `test/e2e/terminal-paint-bench.cjs` (358 lines) exists in `test/e2e/` as a clone of `terminal-transport-sync.cjs` requiring `window.__antifanTerminalBench`, but is omitted from `package.json` and pipeline lanes, and exits 0 without asserting any thresholds.
- Why it matters: Unreferenced benchmark code bit-rots in `test/e2e/`, providing no ongoing regression protection.
- Repair: delete: Move to dedicated benchmark directory or wire into `package.json` under `benchmark:terminal-paint`.


#### U31 — minor / missing-edge — `test/e2e/terminal-rename-space.test.cjs:66-105`

- Sources: D | confidence: high | repair risk: low: ensures deterministic exit on startup failure.
- Evidence: `app.whenReady().then(async () => { ... })` has no `.catch()` handler, no top-level `try/catch` block, and no watchdog timer.
- Why it matters: Any early error during window initialization or script execution results in an unhandled promise rejection and causes Electron to hang indefinitely.
- Repair: add-cases: Add a timeout watchdog and chain `.catch((err) => finish(1))` to the `whenReady` handler.


#### U30 — minor / outdated — `test/e2e/terminal-renderer-smoke.cjs:23-27`

- Sources: D | confidence: high | repair risk: low: updates output path.
- Evidence: `reportsDir` hardcodes an obsolete plan path: `path.join(__dirname, '..', '..', 'plans', '260827-1345-production-cutover-release-hardening', 'reports', 'smoke')`.
- Why it matters: Smoke test logs are dumped into a historical August 2026 plan directory instead of `plans/reports`.
- Repair: rewrite: Point `reportsDir` to `plans/reports` or a standard dynamic reports directory.


#### U23 — minor / redundant — `test/e2e/terminal-transport-sync.cjs:73-77, 103-107`

- Sources: B, C, E | confidence: high | repair risk: low: dead code elimination.
- Evidence: `function deliverChunk(chunk)` is declared twice identically within the same file scope.
- Why it matters: Duplicate function declarations create dead code and maintenance confusion.
- Repair: delete: Remove the redundant second declaration of `deliverChunk`.


#### U22 — minor / deceptive — `test/e2e/toolbar-qa-hub-empirical-probe.cjs:67-85, 156-166, 363-366`

- Sources: A, C | confidence: high | repair risk: low: clarifies test boundary between UI rendering and engine execution.
- Evidence: Advertised as an 'Empirical Probe', the test mocks `antifan:toolbar:theme-qa-run` and `antifan:workflow:run` to return hardcoded synthetic reports (`summary: { passed: true, totalIssues: 0 }`, `status: 'passed', passedSteps: 6`) and asserts UI text against these self-injected mocks.
- Why it matters: Breakages in Theme QA diagnostic dispatch or workflow runtime evaluation logic pass undetected.
- Repair: rewrite: Wire the probe to the actual workflow execution engine or clearly categorize the probe as a renderer UI layout test.


#### U21 — minor / deceptive — `test/fixtures/mcp/fake-omp-mcp.cjs:43-44`

- Sources: A, E | confidence: high | repair risk: low: aligns client test assertions with real capability definitions.
- Evidence: In `test/fixtures/mcp/fake-omp-mcp.cjs:44`, the fixture pads its 30 tools with `while (TOOL_NAMES.length < 52) TOOL_NAMES.push('fixture.tool.' + (TOOL_NAMES.length + 1))`. `test/unit/antifan-mcp-client.test.mjs:19-20` asserts `tools.length >= 50` against this padded double.
- Why it matters: The test claims to verify that the client connects and lists 52 tools, but asserts against synthetic filler strings rather than genuine MCP capability names.
- Repair: rewrite: Update fixture tool list to match current production capabilities without dummy padding.


#### U25 — minor / ineffective — `test/unit/mcp-dispatch-payload-gate.test.mjs:296-306`

- Sources: C | confidence: high | repair risk: low: removes fragile string parsing of `package.json`.
- Evidence: Test `'the compile chain runs the payload gate last, after copy-static and build:extension'` reads `package.json`, splits `scripts.compile` on `' && '`, and asserts string positions of step commands.
- Why it matters: Asserts npm script string formatting rather than observable build behavior or payload integrity; harmless flag or script adjustments break the test.
- Repair: rewrite: Replace string parsing with an integration test verifying that compile emits properly gated payload artifacts.

## Dropped by the verifier (2)

| From | Location | Reason |
|---|---|---|
| B | `test/unit/mcp-core-parity.test.mjs:84-123, 154-200` | Misattributed lines (the `browser_find` test is at :103) and a false redundancy claim: the dedicated test asserts schema targeting properties (`tabId`, `paneId`, `maxMatches`) the generic `CAPABILITY_MAP` loop never checks. |
| E | `scripts/run-test-pipeline.mjs:23, 25` | Falsely claims `test:fast` executes `.compiled/test/integration/**/*.test.js` and duplicates `test:integration`; `package.json:40` contains no integration globs. |

Both dropped claims failed on the same test the ultra-verifier pass exists for: the citation does not
support the claim. Neither drop changes the union's coverage — the surviving items cover the same
files.

## Provenance and gates

- Usable-candidate gate: **5/5**. One bounded recovery was needed — AuditC4's first yield carried prose
  in place of the findings array; it was asked once to re-emit its findings from its own context and
  did (no re-audit, no re-dispatch) before anonymization.
- Evidence artifacts: `local://ultra-audit-packet.md` (immutable packet),
  `local://ultra-candidates-anon.md` (anonymized 84-claim corpus), `agent://AuditVerifier` (scores,
  union, drops, go/no-go), `agent://AuditC1..AuditC5` (raw candidate outputs).
- Overlap: 84 claims were reduced to 35 validated, deduplicated findings; every union item lists its
  contributing candidate letters, and U1/U2/U5 carry sources from all five candidates — the strongest
  available signal of independence.

## Next step

Phase 1 is the recommended first repair PR (teardown plugs, no CI-behavior change), then Phase 2
(invariant hardening), then Phase 3 (lane graduation, `test:e2e:strict` last). Repairs were
deliberately **not** started in this pass — this report is the review gate, and the phase ordering is
the artifact the repair pass should execute against.
