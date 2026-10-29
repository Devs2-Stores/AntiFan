# Ultra scout: final verified report (AntiFan Leader orchestrator, e6c42d4a..48bc2c48)

Verifier: ScoutVerifier. Method: read the packet and the 5 candidates, then opened every cited P0-P2 source myself (HEAD 48bc2c48; working tree holds only the foreign changes listed in the packet). I ran no builds or tests, touched no live terminal, and printed no token. Live files I read: `E:/Work/.antifan-data/config/leader-terminals.json`, `runtime/runs/terminal-3.json`, `runtime/runs/terminal-4.json`, and a glob of `config/*.json`.

## 1. Scores (1-10)

| Cand | Evidence accuracy | Coverage T1-T7 | Severity calibration | Actionability | VERIFIED vs [INFERENCE] honesty | Total |
|---|---|---|---|---|---|---|
| A | 8 | 8 | 7 | 8 | 9 | 40 |
| B | 8 | 8 | 6 | 9 | 8 | 39 |
| C | 8 | 9 | 7 | 8 | 9 | 41 |
| **D** | **9** | **9** | **9** | **9** | **9** | **45** |
| E | 8 | 9 | 7 | 8 | 9 | 41 |

**Winner: D.** Why:
- Only D (with E) found the run-file collision (V-02) and cited the live `terminal-3.json` as evidence. I confirmed it.
- D calibrated the Leader-origin claim (V-05) as P2, a same-user local boundary. The other four called it P1.
- D noticed that `hrv --org 1 theme push` slips past the parser, that `git commit -m "shopify theme x"` is a false refusal, and that the live registry has `workers:{}` while terminal-4 runs OMP.
- D missed the `terminal.write` false success (V-03). B and E found it.

Unique contributions worth keeping:
- B: seeding the id counter from run files; the clamped timeout result dropping `run`.
- C: interpreter-array bypass (`python -c`/`node -e`); `.haravan-cli_local.json` rewrite inside one command line; `ended`+stale counting as settled.
- E: a split of a Leader inherits Leader authority; the leftover tmp run file.
- A: resumed-session `lastEventAt` race; `$(`/`(` bypasses.

## 2. Verified union (ordered by severity)

Status key: CONFIRMED = I read the cited code or live file and the mechanism holds. A trailing "(trigger [INFERENCE])" means the code path is confirmed but I could not observe the exploit or runtime effect. UNCONFIRMED = cannot be settled by reading.

No P0 found. Nothing in the read-only pass shows data loss. The nearest candidate is the live push route, and it is rated P1.

### P1

**V-01 [P1] T1. An old daemon is never replaced, so the id counter is inert and ids are reissued. CONFIRMED.**
- Targets:
  - `src/main/terminal-daemon/daemon-spawner.ts`
  - `src/main/browser/terminal-manager.ts`
- Evidence read:
  - `daemon-spawner.ts:309-313` re-attaches whenever the recorded pid is alive and answers the health probe. It returns `existing.version` without comparing it to staged.
  - `resolveStagedEntry()` is only called at `:319`, after the re-attach return.
  - `staged.version` goes only into the env at `:331`.
  - In daemon mode the daemon's own `TerminalManager` mints ids: `terminal-manager.ts:1103-1109` (`mintSessionId`), `:2231` (`nextTerminalId`), `:2695` (split ids). The sidecar is written at `:1092-1099`.
  - Live: a glob of `E:/Work/.antifan-data/config/*.json` lists no `terminal-id-counters.json`. The packet's `terminal-4` reuse matches this.
  - The registry class comment (`leader-registry.ts:25-26`, "ids are never reissued") is false on the live system until the daemon restarts.
- Scenario: every compile that touches `terminal-manager.ts` or `daemon-entry.ts` stays inert until someone restarts the daemon by hand.
- Fix direction:
  - In `ensureDaemon`, resolve the staged entry before the L0 return. When `existing.version !== staged.version`, log it to `daemon.log` and surface a "daemon outdated, restart pending" signal. Do not kill anything.
  - Add a test for the version-mismatch attach.
  - The actual replacement is the user-approved daemon restart (separate operational step).
- Sources: A, B, C, D, E.

**V-02 [P1] T3. Every OMP process in a terminal writes the same `runs/<terminalId>.json`. Subagents clobber the worker's run state. CONFIRMED (code and live).**
- Targets:
  - `src/omp-hooks/run-state.ts`
  - Consumers: `src/main/leader/leader-runtime.ts`, `src/main/tools/terminal-capabilities.ts`, the Worker board
- Evidence read:
  - `run-state.ts:509` (the file path is keyed by `terminalSessionId` only).
  - `:514-525`: when `ompSessionId` differs, `runSeq` resets to 0.
  - `:297-305`: each process's heartbeat rewrites the file.
  - `:631-640` (`agent_end` → idle) and `:659-669` (`session_shutdown` → ended).
  - Live `runtime/runs/terminal-3.json`: the Leader terminal's file has `promptHead` "Complete assignment thoroughly: # Target READ-ONLY…" (a subagent prompt), `runSeq:1`, `state:"running"`, an `ompSessionId` that is not the Leader's own. `runs/control/` holds 11 per-session directories, several created in the same minute.
- Scenario: a worker that fans out subagents (every `--ultra` flow does) has its file flipped to `idle`/`ended` by whichever session wrote last.
  - `run-idle` can return early.
  - `assertLeaderTargetNotBusy` passes, so the Leader types into a running prompt.
  - The board shows "kết thúc" while the turn is still running.
  - `runSeq` and `promptHead` oscillate.
- Open point: whether OMP subagents run in-process or in a child process is [INFERENCE]. The live `promptHead` proves the collision happens either way.
- Fix direction (hook-side, no restart; applies to newly started OMP sessions):
  - Only the root OMP session writes the terminal file, or write per-`ompSessionId` files and let `readTerminalRunSnapshot` aggregate.
  - At minimum, a session must not overwrite a file owned by a different `ompSessionId` that is `running` with a fresh heartbeat.
  - Add a unit test with two sessions sharing one terminal id.
- Sources: D, E.

**V-04 [P1] T4. The worker theme gate only sees `bash` and `eval`. `terminal.create` + `terminal.write` bypass it. CONFIRMED.**
- Targets:
  - `src/omp-hooks/edit-guard.ts`
  - `src/main/tools/terminal-capabilities.ts`
- Evidence read:
  - `edit-guard.ts:606-619` gates only `normalizedTool === "bash"` (`gateThemeCommand`) and `"eval"` (workers only).
  - A grep of `src/omp-hooks` for `terminal.write|terminal.create|terminal_write` finds nothing relevant.
  - Non-Leader attachments reach splits of their own home terminal: `terminal-capabilities.ts:345-352`. `terminal.create` makes the split (`:822-899`).
  - `terminal.write` forwards `params.input` to the PTY unscanned (`:517-533`).
  - Workers hold the AntiFan MCP: the skill's own worker step 3 (`SKILL.md:66`) uses it.
- Scenario: the worker calls `terminal.create` then `terminal.write {input:"hrv theme publish <id>\r"}`. The plain shell in the split has no OMP hook, so nothing checks it.
- Calibration: this is an accident and prompt-injection guard, not a sandbox. A worker can also run a script or a binary path. The CLI itself may refuse a `main` push (the packet's docs claim, DERIVED, not verified by me). Severity stays P1 because the bypass is one sanctioned MCP call.
- Fix direction:
  - In the main process, for a non-Leader `terminal.write`, run `parseThemeCommands`/`planThemeCommand` on `input` and refuse on a block. This does not need the OMP hook.
  - Treat splits of a worker as workers (`isLeaderWorker` reads `ANTIFAN_TERMINAL_SESSION_ID` only, `edit-guard.ts:386-401`).
  - Say plainly in the skill that this is a guardrail.
- Sources: A, B, C, E (D: P2 "script indirection").

### P2

**V-03 [P2] T2. `terminal.write` can report `written:true` for input that was not delivered. Mechanism CONFIRMED; the exited-shell case is UNCONFIRMED.**
- Targets:
  - `src/main/tools/terminal-capabilities.ts`
  - `src/main/terminal-daemon/daemon-entry.ts`
  - `src/main/terminal-daemon/daemon-client.ts`
- Evidence read:
  - `terminal-capabilities.ts:533` awaits `terminal.writeTo(...)` and discards the result.
  - `:535` `assignWorker` runs regardless.
  - `:543` `written: wasSleeping ? woke : true`.
  - `daemon-client.ts:537-538` maps any RPC failure or timeout to `false`.
  - `daemon-entry.ts:279-281` always answers `{written:true}`.
  - `terminal-manager.ts:2244-2246` returns silently when no session or pty is resolved.
- Rejected sub-claim (candidates B and E): "writing to an exited shell is silently dropped". `writeTo` goes through `resolveWritableSession` → `ensureSessionPty` (`terminal-manager.ts:1832-1877`), which respawns a shell for a pty-less restored session. An exited session that still holds a dead pty is not shown to drop silently by my reading.
- Scenario: the RPC to the daemon times out and returns `false`, but the Leader sees `written:true`, the registry claims the terminal, and `run-idle` waits until its deadline.
- Fix direction:
  - Main side: `if (await terminal.writeTo(...) === false)` return `written:false` with an explicit message, and skip `assignWorker`.
  - Daemon side (`daemon-entry.ts`): respond `false` when nothing was written. That part only takes effect after the daemon restart.
- Sources: B, E (A and D did not report it).

**V-05 [P2] T2/T5. The Leader origin is a caller-supplied claim. Code path CONFIRMED (exploit [INFERENCE]).**
- Targets:
  - `src/main/bridge/bridge-server.ts`
  - `src/main/tools/terminal-capabilities.ts`
- Evidence read:
  - `bridge-server.ts:1244` reads `data.terminalSessionId` from the request body.
  - `:1254-1256` derives the project from that same terminal, and `:1281` uses it.
  - `:1341-1347` stamps the claim as `originTerminalSessionId` only when the claimed terminal measures in that same project. That check cannot fail for a claim that chose the project.
  - `:1438-1447` `/api/pairing/challenge` gives a code to any loopback caller.
  - The proxy sends the id from env: `scripts/antifan-omp-mcp.cjs:1896`.
  - `terminal-capabilities.ts:298-301` grants Leader scope from `isLeader(origin)`.
  - `test/main/bridge-server.test.ts:1028-1054` asserts that a claimed terminal gets stamped, with no proof of the caller.
  - `terminal-capabilities.ts:241` says "Decided by the host, never by the caller", which is wrong as written.
- Calibration (D's view): the boundary is one local user. Any process that user runs, including a worker's bash, can already do a lot. Raising it from there to Leader scope adds terminal reach across all projects, but not new filesystem or credential access. [INFERENCE] on the end-to-end exploit.
- Fix direction:
  - Inject a per-PTY secret at PTY spawn, held in Main keyed by terminal id and required in `startSession`/pairing. Or check that the caller pid descends from that PTY's shell pid.
  - Correct the comment at `:241` now.
  - Not tonight: spawning the secret into existing PTYs goes through the daemon.
- Sources: A, B, C, D, E (A, B, C, E rated P1).

**V-06 [P2] T2. `LeaderRegistry.prune` has no production caller, so a Leader flag or worker record survives a missed close event. CONFIRMED (trigger [INFERENCE]).**
- Targets:
  - `src/main/leader/leader-registry.ts`
  - `src/main/browser/native-tab-host.ts`
- Evidence read:
  - A grep of `src/main` for `.prune(` hits only `capability-transport.ts:991` (the tab ledger) plus the definition at `leader-registry.ts:181`.
  - Only `forget(closedId)` on `session-closed` runs: `native-tab-host.ts:2268-2269`, `:7425-7427`.
  - The comment at `:7420-7424` records why `prune` was avoided: the daemon's list is a cache that may not yet hold a fresh mint. A naive boot `prune` would drop a live Leader.
  - Live registry is `{"schema":1,"leaders":["terminal-3"],"workers":{}}`.
- Scenario: a terminal closes while no window is subscribed. Combined with V-01 id reuse, a later terminal with that id inherits the Leader flag or a worker record.
- Fix direction:
  - Reconcile once, after the first authoritative session list arrives (non-empty, post daemon re-attach), and only for entries older than a grace window.
  - Better: store a per-incarnation stamp (`createdAt` or a session nonce) in each record and compare it on use.
- Sources: A, B, C, D, E.

**V-07 [P2] T2. A Leader's first successful write claims any live terminal as its worker, and `assignWorker` steals another Leader's worker. CONFIRMED.**
- Targets:
  - `src/main/tools/terminal-capabilities.ts`
  - `src/main/leader/leader-registry.ts`
- Evidence read:
  - `terminal-capabilities.ts:535` calls `assignWorker(params.sessionId, scope.homeId)` for any target.
  - `leader-registry.ts:141-155`: it only skips a Leader or self. When `existing.leaderId !== leaderId`, `sameLeader` is undefined and the record is rewritten with a new `assignedAt`.
  - `edit-guard.ts:386-401` then gates whatever OMP runs in that terminal.
- Scenario: the Leader types into the user's own OMP shell, and the theme push gate now applies to the user's session. A second Leader steals the worker and its gate.
- Fix direction: register on `terminal.create` only (already done, `terminal-capabilities.ts:435`). Never reassign an existing record to another Leader. Reject splits.
- Sources: A, B, C, D, E.

**V-08 [P2] T2/T3. TERMINAL_BUSY is a read-then-act check on a file that flips late. CONFIRMED (timing [INFERENCE]).**
- Targets:
  - `src/main/tools/terminal-capabilities.ts`
  - `src/omp-hooks/run-state.ts`
- Evidence read:
  - `terminal-capabilities.ts:359-368` blocks only when `run?.state === 'running'`. It is called at `:519`, before the write at `:533`.
  - The hook sets `running` only in `before_agent_start` (`run-state.ts:556`).
  - A stale heartbeat (more than 45 s) reads `ended` (`run-state-service.ts:101-105`), so the busy check passes.
- Scenario: two Leader writes inside the hook latency both pass, and the prompts interleave in the OMP input box. V-02 widens the window.
- Fix direction: keep an in-Main `pendingWrite{target, writtenAt}` and treat the target as busy until `lastEventAt > writtenAt` or a grace period expires.
- Sources: A, B, C, E.

**V-09 [P2] T3. A resumed OMP session can satisfy `run-idle`+`afterEventAt` before it takes the prompt. CONFIRMED (timing [INFERENCE]).**
- Targets:
  - `src/omp-hooks/run-state.ts`
  - `src/main/leader/leader-runtime.ts`
- Evidence read:
  - `run-state.ts:514-520` keeps the stored `runSeq` when `ompSessionId` matches (resume).
  - `:523-525` sets `state="idle"` and `lastEventAt=Date.now()`.
  - `leader-runtime.ts:79-85`: `runSeq >= 1`, `lastEventAt > afterEventAt` and `idle` all hold.
- Scenario: the Leader types `omp -c "@prompt"` and polls every 500 ms (`:88`). The wait reports done between `session_start` and `before_agent_start`. A fresh session is safe because `runSeq` resets to 0.
- Fix direction: do not touch `lastEventAt` in `session_start`, or require a new field (`runStartedAt > afterEventAt`) in `isRunSettled`.
- Sources: A, C (D mentions it as P3).

**V-10 [P2] T4. `parseThemeCommands` bypasses. CONFIRMED by reading the parser (none executed).**
- Target: `src/omp-hooks/theme-push-policy.ts` (`:81-87`, `:90-95`, `:104-141`, `:156-204`).
- Mechanism: quotes become spaces, the line splits on `&&`, `||`, `;`, `|`, `\r`, `\n`, `&` (`:107`), then `cliOf(token)` needs a whole token to name the CLI (`:90-95`). `dirChanged` looks only at a segment's first token (`:112`).
- Each line below was checked against that code:
  1. `(hrv theme push --only a)` and `$(hrv …)`: the token is `(hrv` or `$(hrv`, so `cliOf` returns null.
  2. A `cd` hidden in a wrapper (`bash -c "cd x && hrv …"`, `cmd /c`, `powershell -c`, `(cd x && hrv …)`): the first token is the wrapper, so `dirChanged` stays false and the draft probe verifies the wrong folder. `Push-Location` and `popd` are not in `DIR_CHANGE_WORDS` (`:81-87`).
  3. Interpreter arrays (`python -c "subprocess.run(['hrv','theme','push'])"`, `node -e`): the tokens become `hrv , theme`, and the `startsWith("-")` rule at `:120` skips them.
  4. `hrv --org 123 theme push --only a`: `123` does not start with `-`, so `:120` drops the command. Whether `hrv` has a value-taking global option is [INFERENCE].
  5. `hrv \` newline `theme push --only a`: the split on `\r\n` puts `theme` in a segment with no CLI token. A line-continuation after `push` instead gives a false refusal (D's case).
  6. `npx @shopify/cli theme push`, `npx @f1genz/haravan-cli theme push`: the basenames are `cli` and `haravan-cli`, not `hrv`/`haravan`/`shopify`. `h""rv` and `` h`rv `` become `h rv`.
  7. One command line that rewrites `.haravan-cli_local.json` and then pushes: `gateThemeCommand` reads the binding and runs `hrv theme info -j` before the line executes (`edit-guard.ts:427-436`), so the old draft is verified and the new binding is pushed to.
  8. Variable or script indirection (`$H theme push`, `bash push.sh`, `npm run deploy`) is invisible to a text parser.
- Also verified, the other direction (false refusals): `git commit -m "fix shopify theme header"` and `rg -n "hrv theme" src` parse as theme commands with an unknown action, so `planThemeCommand` returns REMOTE_OP (`:158-167`). A refused worker reports NEEDS_INPUT and stalls.
- Fix direction:
  - Strip leading `(`, `$(` and `{` from tokens; join `\`-newline before splitting; treat any `cd`/`pushd`/`Push-Location`/`Set-Location` word before the CLI word anywhere in the string as `dirChanged`.
  - Treat `--org <v>`-style global options by skipping a value, or refuse when `theme` appears after unknown tokens.
  - Refuse when a wrapper or interpreter (`bash -c`, `cmd /c`, `powershell -c`, `python -c`, `node -e`, `npx`) mentions the CLI.
  - Block writes to `.haravan-cli_local.json` in the same command line.
  - Add table tests for every shape above.
- Calibration: C rated this P1. I keep P2 because the draft/role probe (`theme-push-policy.ts:253-259`) and the CLI's own main-theme guard are separate layers, and the gate is best effort.
- Sources: A, B, C, D, E.

**V-11 [P2] T4. Playbook forbids `--prune` (and requires `--nodelete`); the code enforces neither. CONFIRMED drift (CLI effect UNCONFIRMED).**
- Evidence read: `SKILL.md:64` says "CẤM … --prune" and requires `--nodelete` in the push form. `theme-push-policy.ts:168-181` blocks only `-f`/`--force` and a missing `--only`. `-o` is accepted as `--only` (`:175`).
- Scenario: `hrv theme push --only x --prune` on a verified draft passes.
- Fix direction: block `--prune`, require `--nodelete` if that is the contract, and refuse `--force=...` forms.
- Sources: B, C, D, E.

**V-12 [P2] T4. The gate fails open in three places. CONFIRMED (trigger [INFERENCE]).**
- Targets:
  - `src/omp-hooks/edit-guard.ts`
  - `src/main/leader/leader-registry.ts`
- Evidence read:
  - `edit-guard.ts:398-400`: `isLeaderWorker` returns false on any read or parse error, a missing file or a missing data root.
  - `:701-708`: the `tool_call` catch returns `undefined` unless the mode is `fast` (`isScopedMode`, `:195-198`). A throw inside `gateThemeCommand` therefore passes the call in other modes. Live run files show `mode:"unset"` for terminal-3 and terminal-4.
  - `leader-registry.ts:95-103`: a failed persist only logs, then still emits `change`, so the board shows a worker the hook cannot read.
- Fix direction:
  - In the catch, block when the terminal is a known worker (or the env names a terminal) and the command text names a theme CLI.
  - Surface a persist failure and retry.
  - Fail closed when a terminal id is set but the registry file cannot be read.
- Sources: A, B, C, D, E.

**V-13 [P2] T2/T4. Clearing a Leader, or closing it, releases its workers and the gate while their OMP sessions still run. CONFIRMED.**
- Evidence read: `leader-registry.ts:128-132` (`setLeader(false)` deletes the Leader's worker records), `:167-177` (`forget`). `isLeaderWorker` then returns false (`edit-guard.ts:396-397`).
- Scenario: the user closes the Leader terminal after dispatch; unattended workers continue with no gate.
- Fix direction: keep a separate "gated" marker per terminal until its OMP session ends.
- Sources: A, C.

**V-14 [P2] T7. `smoke-edit-mode-guard.cjs` cannot work on Windows. CONFIRMED.**
- Evidence read: `scripts/smoke-edit-mode-guard.cjs:44-49` builds a multi-line prompt with embedded quotes; `:73` and `:75` put it in `args`; `:80-86` run `spawnSync("omp", args, {shell:true, …})`. With `shell:true` Node joins the arguments into one cmd.exe line with no quoting, so the prompt is cut at the first newline. This matches the controller's measurement (0 tool calls, 0 guard rows) and the same FAIL with the pre-8edb95d1 hook. Cmd's newline truncation itself is [INFERENCE]; the unquoted join is Node behaviour.
- Fix direction: write the prompt to a temp file and pass one quoted `@<abs path>` token (the skill uses this form), or resolve the real `omp` entry and run it with `shell:false`. Add a worker-gate lane.
- Sources: A, B, C, D, E.

**V-15 [P2] T7. No Leader e2e, and the missing unit tests that would pin V-01 to V-13. CONFIRMED.**
- Evidence read: a grep of `[Ll]eader` in `test/e2e` and `test/integration` returns no matches. Leader coverage is unit and host-route only.
- Missing tests: daemon-minted ids and a version-mismatch attach; two sessions sharing one run file; forged `terminalSessionId` at pairing; registry reconcile wired in production; `writeTo` false; parser bypass shapes; resumed-session wait.
- Fix direction: add the tests as each fix lands; add one Leader e2e using the isolated `test/e2e` harness.
- Sources: A, B, C, D, E.

**V-16 [P2] T1. The id counter has no floor from other id-keyed state, so the first mint after the daemon restart can reissue ids. CONFIRMED logic.**
- Evidence read: `terminal-manager.ts:1069-1086` seeds from the sidecar and from rows still in `terminal-sessions.json` only (the file is debounced 5 s per the comment at `:1088-1090`, and holds live rows). With no sidecar, an id closed above the highest surviving row is minted again. Stale `runs/<id>.json` (pruned only 24 h after `ended`, `run-state-service.ts:15`, per C) then shows a ghost run for the new terminal.
- Fix direction: seed from the maximum numeric id found in `runtime/runs/*.json` and `leader-terminals.json`. This is daemon-bundle code, so land it BEFORE the user-approved daemon restart.
- Sources: B, C, D, E.

### P3 (kept short)

| id | Finding | Citation read | Status |
|---|---|---|---|
| V-17 | Skill drift: `SKILL.md:26` says "a bare `\r` is refused"; no such check exists in `terminal-capabilities.ts` (grep). `SKILL.md:27` says wait is capped about 25 s; the code cap is 28 s (`:124`). | read | CONFIRMED (A,B,C,D,E) |
| V-18 | `terminal.close` for a Leader has no busy or worker restriction. The tool description (`terminal-capabilities.ts:905`) states this as intended. | `:930-947` | CONFIRMED, by design (A,B,C,D,E) |
| V-19 | `placeLeaderTerminal` creates a persistent workspace capsule for any readable folder (`native-tab-host.ts:1646`). The manager's own "new in folder" does the same. | read | CONFIRMED (A,C,D) |
| V-20 | `persistIdCounters` swallows every error and uses a fixed `.tmp` name (`terminal-manager.ts:1092-1099`), unlike `leader-registry.ts:94` (`.tmp-${pid}`). | read | CONFIRMED (A,B,C,D,E) |
| V-21 | The clamped timeout result drops `run` (`terminal-capabilities.ts:137-154`). Only affects requests over 28 s; the unclamped path throws with `details` including `run`. | read | CONFIRMED (B) |
| V-22 | `ended`+stale counts as settled: `run-state-service.ts:101-105`, `leader-runtime.ts:85`. The comment at `:75-78` says this is deliberate and the result carries `run.stale`. Downgraded from P2. | read | CONFIRMED, by design (C,E) |
| V-23 | A split of a Leader inherits Leader authority via `resolveHomeBaseTerminal` (`control-plane-runtime.ts:331-333`), though splits cannot be marked Leader. | read | CONFIRMED (C,E) |
| V-24 | Proxy failover dedup keys on `host:port` only and the bootstrap candidate is never `pidAlive:false` (`antifan-omp-mcp.cjs:398`, `:417-436`). Same port reaches the same server, so the effect is small. | read | CONFIRMED, low impact (A,B,C,D,E) |
| V-25 | `scripts/theme-harness/mcp-client.mjs:42` takes `candidates[0]` with no `pidAlive` check. | read | CONFIRMED (D,E) |
| V-26 | Worker board: the "attention only" filter marks `idle` as not attention (`standalone.js:7747-7761`), so a worker that just finished its turn is hidden. Escaping uses `textContent` (`:7800`); no XSS. Board DOM rebuild and missing focus trap not re-read. | `:7747-7803` | CONFIRMED / rest UNCONFIRMED (B,C,D,E) |
| V-27 | A leaked `terminal-2.json.tmp-…` file sits in `runs/` (listed). `isRunFileName` (`run-state-service.ts:166`) matches `.json` only, so the sweep ignores it. | glob + `:166` | CONFIRMED (C,E) |
| V-28 | Block rows write the full command text to the `path` column (`edit-guard.ts:446`); the allow row swaps tool and path (`:438`). | read | CONFIRMED, cosmetic (A,B,D,E) |

### T5 stale-pin fix (48bc2c48)

`antifan-agent.cjs:55-66` adds the pin to `seenTargets` only when `pidAlive !== false`. I read it and it is correct for the stated bug. Its double-pairing side effect (C, T5-c: each stale-shell start does two pairing exchanges) was not verified: I did not read `acquireBridgeSession` (`:478-620`). **UNCONFIRMED, P3.** PID recycling making a dead pin look alive is also [INFERENCE].

### T6 summary

No XSS or escaping defect (`standalone.js:7800` `textContent`). Click-to-focus bails out when the session is gone (`:7785`). Only V-26 stands.

## 3. Rejected or downgraded

- **Rejected: "`terminal.write` to an exited shell is silently dropped" (B 2.3, E T2-2 scenario).** `writeTo` resolves through `ensureSessionPty` (`terminal-manager.ts:1832-1877`), which respawns a shell for a pty-less session. The surviving part is the discarded return value, V-03.
- **Downgraded P1 → P2: Leader origin claim (A, B, C, E).** Same-user boundary (see V-05).
- **Downgraded P1 → P2: registry never reconciled (B, C, E).** A close normally reaches `forget`; the failure needs a missed event (V-06).
- **Downgraded P2 → P3: proxy dedup (B 5.1).** Same `host:port` reaches the same server (V-24).
- **Downgraded P1 → P2: parser bypasses (C T4-2).** Probe and CLI layers exist (V-10).
- **Downgraded P2 → P3: `ended`+stale as settled (C, E).** Deliberate design with a flag (V-22).
- **Downgraded P2/P3 → P3: `terminal.close` unrestricted (A, B, C, D, E).** Stated intended behaviour (V-18).
- **Not reproducible by reading:** C T4-3, a planted `hrv.cmd` in the theme root answering the probe, and B 4.6, redaction of tokens in audit rows. Both are [INFERENCE] with no code evidence.
- **Corrected claim (A T4-2, D T4-2):** a `\`-newline after `push` is a false refusal, not a bypass. A bypass needs `theme` to start the next line (V-10 item 5).

## 4. Prioritized fix list for tonight

Only items that are code-fixable without restarting the terminal daemon and without closing user terminals. Do not touch the foreign uncommitted files from the packet.

1. **V-04** — Scan `terminal.write` input from non-Leader callers with `parseThemeCommands`/`planThemeCommand` in `terminal-capabilities.ts`. Treat splits of a worker as workers.
2. **V-02** — Make only the root OMP session own `runs/<terminalId>.json`, or aggregate per session, in `src/omp-hooks/run-state.ts`. Takes effect for new OMP sessions; existing ones keep the loaded hook.
3. **V-03 (main side)** — Treat `writeTo === false` as not written; skip `assignWorker`. Leave the daemon `input` reply change for the restart.
4. **V-07** — Assign workers on create only; never reassign.
5. **V-09 and V-08** — Stop `session_start` from rewriting `lastEventAt`. Add an in-Main pending-write marker to the busy check.
6. **V-10, V-11, V-12** — Parser hardening, `--prune` block, and a fail-closed catch/registry read for worker terminals in `theme-push-policy.ts` and `edit-guard.ts`. Add the table tests. Hook changes reach new sessions only.
7. **V-14** — Fix the smoke harness prompt transport.
8. **V-01 (main side)** — In `ensureDaemon`, compare the running and staged versions, log it, and surface a "daemon outdated" notice. No kill.
9. **V-06** — A guarded one-shot reconcile after the first authoritative session list, or a per-incarnation stamp. Mind the daemon-cache comment at `native-tab-host.ts:7420-7424`.
10. **V-16** — Seed the id counters from `runtime/runs/*.json` and `leader-terminals.json`. Land before the daemon restart so the first mint is safe.
11. **V-15 and V-17** — Tests for the above, and align the skill text.

Operational, user-approved only, separate step: restart the terminal daemon (closes V-01 and activates V-16 and the daemon side of V-03); verify `terminal-id-counters.json` appears on the first mint. V-05 (per-PTY secret) needs the daemon spawn path and belongs with that step or after it.

Status: DONE_WITH_CONCERNS. Every P0-P2 item above carries a citation I read myself. Concerns: no exploit was executed (marked [INFERENCE] where it matters); the CLI-side behaviours of `hrv` (`--prune`, global options, main-theme guard) were not verified; `acquireBridgeSession` and the board's re-render and focus claims were not re-read.
