# Ultra problem-solving: verifier verdict (AntiFan Leader backlog V-01..V-28)

Verifier: PSVerifier. Read-only. I read the packet, the scout report and A..E in full, then opened the sources below myself (HEAD working tree). No build, test, live terminal or tab was touched; no token printed. Evidence for process-model claim: `E:/Work/.antifan-data/runtime/runs/terminal-3.json` (pid 21464) and my own eval kernel's parent pid (21464, `omp.exe`).

## 1. Scores (1-10)

| Cand | Technique fit | Depth (this code) | Actionability / ordering | Honesty | KISS | C6 UX+docs | Total /60 |
|---|---|---|---|---|---|---|---|
| **A** | 8 | 9 | 9 | 9 | 6 | 9 | **50** |
| B | 8 | 6 | 7 | 8 | 8 | 7 | 44 |
| C | 8 | 9 | 8 | 8 | 5 | 8 | 46 |
| D | 9 | 9 | 8 | 8 | 6 | 9 | 49 |
| E | 8 | 7 | 8 | 8 | 8 | 6 | 45 |

Winner: **A** (unchanged, text copied verbatim in section 4). D is a close second; the margin comes from fewer false premises and one decision-changing finding that only A made (V-07).

## 2. Why A

- **The V-07 finding changes a decision, and it is true.** The scout's fix ("register on create only") is what B, C and D implement. `assignWorker` on write (`src/main/tools/terminal-capabilities.ts:535`) is the only path that puts a terminal the Leader merely typed into onto the registry, which is the only thing `isLeaderWorker` reads (`src/omp-hooks/edit-guard.ts:386-401`). The plan documents that flow on purpose (`plans/261029-leader-terminal-orchestrator/plan.md:13`, "L -->|terminal.write khi run không 'running'| W2[Terminal có sẵn]"), and the code comment at `terminal-capabilities.ts:534` says the claim exists so the board shows it. B/C/D remove it, so a Leader-driven pre-existing OMP receives the worker header ("hook chặn bằng code") but no gate. A removes only the steal (`leader-registry.ts:141-155` rewrites a record owned by another Leader).
- **The `--nodelete`/`--prune` finding is true.** `docs/haravan/cli-operations-and-guards.md:46` ("`-n`/`--nodelete` (accepted and ignored)") and `:123` ("flag is a no-op"); `--prune` appears in no docs or src for the CLI (grep of docs;src;scripts: only `scripts/stage-daemon-host.mjs`, an unrelated flag). So "require `--nodelete`" (D/B/C/E variants) would add false protection; the defect is `SKILL.md:64`, which A fixes in docs.
- **V-03 needs both halves** (true): `daemon-client.ts:537-538` returns `true` for any resolved RPC and ignores the body; `daemon-entry.ts:279-281` always answers `{written:true}`; in-process `TerminalManager.writeTo` returns `void` (`terminal-manager.ts:2244-2249`). Only A pairs a client change that is compatible with the old daemon with a daemon half marked NOT-LIVE.
- **Generation cannot stand in for an incarnation stamp** (true): `sessionGenerations.delete(id)` on close (`terminal-manager.ts:2529`, `:3296`, splits `:2522`, `:2731`, `:3289`); a reissued id restarts at generation 1 (`:1735`).
- **Hook install blast radius** (true): `scripts/install-omp-hooks.mjs:95-101` bundles from repo source with esbuild into `~/.omp/agent/hooks/pre/`, so installing from the shared dirty tree ships foreign hunks to every new OMP session on the machine. Only A (and partly D) says install from a clean worktree and gives a rollback story.
- **Lease rule works for in-process subagents** (verified live): the run file's pid 21464 is the same `omp.exe` that parents my own subagent eval kernel, so a subagent and its root share a pid. A's rule (no pid-equality clause) therefore yields to a fresh other-`ompSessionId` owner either way. B's rule adds `existing.pid !== process.pid` and so does not protect against in-process subagents (see correction table for B below, informational).
- **Best fit to the constraints**: tier codes L-hook / L-main / L-ui / NOT-LIVE on every item; hooks installed after the app restart; live verification uses a stub `hrv.cmd` or text-only lines, never the real CLI; the daemon bundle work is explicitly NOT-LIVE.
- **C6 coverage**: board filter + stale label + focus loss on repaint (`standalone.js:7890-7892`, `body.innerHTML = ''`) + focus return on close (`close` at `:7932-7941` never refocuses `#btnLeaderBoard`) + notice and empty-state copy + dialog a11y + managed skill + `CHANGELOG.md` + `plan.md` + tool descriptions in both `terminal-capabilities.ts` and `scripts/antifan-omp-mcp.cjs`.

Why not the others:
- **D**: closest, but four premises fail: `runStartedAt > afterEventAt` deadlocks the `waiting_user` answer path; the claim that Main "already reads" `runStartedAt` skips that `readTerminalRunSnapshot` drops it; it reverses assign-on-write (V-07); and its live probe writes a real `hrv theme push` string into a worker split. Its insights (where each fix goes live; `tsconfig` allows the import; sync-barrier hint) are useful but not in A.
- **C**: strongest single idea (Main-side `runStartedAt` existence check; `session-created` forget) but the widest surface (shared module, write ticket, tri-state, scan), reverses V-07, and defers the stale/idle board item on a false premise (renderer "has no runSeq").
- **B**: M1 pid-equality clause defeats the lease for in-process subagents; M5 denies all worker `terminal.write`/`terminal.create` (breaks the barrier's own hint); V-16 is a hand-written data file; reverses V-07.
- **E**: keeps assign-on-write (right) but V-04 via `planEvalThemeCode` refuses read actions too and ignores the barrier hint; flag allowlist omits real flags `-n`/`--ignore` (`docs/haravan/cli-operations-and-guards.md:46`); thinnest C6; wrongly says the board has no automated test.

## 3. Verifier corrections (claims inside A that are false or unsafe as written; each cites a line I read)

1. **A's V-04 lets a canonical push through `terminal.write` unverified.** A scans each completed line with `parseThemeCommands`/`planThemeCommand` and refuses only on `block`. But a canonical `hrv theme push --only f` returns `verify-draft`, not `block` (`src/omp-hooks/theme-push-policy.ts:203`); the live-theme check happens only in `gateThemeCommand` through `hrv theme info -j` (`edit-guard.ts:432-439`), which Main will not run. So the push-to-live case (the one that matters) passes. Implement the Main side as: for a registered worker (`scope.bound && !scope.leader && registry.workerOf(scope.homeId)`), refuse any input whose text mentions the theme CLI next to `theme` (same predicate as `EVAL_THEME_CLI_RE`, `theme-push-policy.ts:207`, which refuses read actions too, `:213`). Workers run the CLI only through bash. The per-target line buffer then matters only for chunked keystrokes; keep it optional.
2. **"A correct fix [for V-13] needs a 'gated until the worker's OMP ends' marker plus a sweep" is false.** `isLeaderWorker` reads only `workers[terminalId].leaderId` and never checks that the Leader is alive (`edit-guard.ts:396-397`). The release is two explicit loops: `leader-registry.ts:128-132` (`setLeader(false)`) and `:171-176` (`forget`). Removing them keeps the gate until the worker's own terminal closes (`forget(workerId)` deletes its own record, `:170`). If done, `assignWorker` must still let a *different live Leader* adopt a record whose Leader is no longer a Leader, otherwise the record is stranded (the guard in A's V-07 as written, `existing.leaderId !== leaderId → return`, would block that). A's confirm-dialog mitigation is still valid as a fallback but is not the only option. `prune()` (`:189-193`) already treats a record whose Leader is gone as droppable, so it must not be wired in.
3. **Lease start-order.** A's rule (no owner = no write; same `ompSessionId` / `ended` / dead pid / `updatedAt > 45 s` takes over) is right for in-process subagents, but its test list covers only owner-first orders. If `/new` in the root starts the new session before the old one writes `ended` (`run-state.ts:659-669`), the new root session is treated as a guest for up to 45 s. Add that order to the two-session test and decide the behaviour; `session_shutdown` of the old session writes `ended`, which normally lets the new one take over.
4. **V-08 rationale is too strong.** "A pending-write marker would block a legitimate second write to a plain non-OMP shell because no run event ever clears it" is only true if the marker is applied to terminals with no run file. `assertLeaderTargetNotBusy` already returns early with no run file (`terminal-capabilities.ts:359-361`), so a marker scoped the same way does not touch plain shells. Deferral is still defensible; the stated reason is not.
5. **V-01 is invisible to the Leader.** A surfaces `outdated` only on the attach handle and `daemon.log`. Nothing in `terminal.list` carries it, so the playbook cannot tell the user. B/C/E add an additive field on `terminal.list`; if the controller wants the Leader to relay it, add that field (`src/main/tools/terminal-capabilities.ts`), and mirror the description in `scripts/antifan-omp-mcp.cjs`.
6. **Resolved inferences** (A marks these `[INFERENCE]`; they are true): `tsconfig.json:22` includes `src/**/*.ts`, and `theme-push-policy.ts:14` imports only `node:path`, so `src/main` can import it directly; `RunCardState.runSeq` exists (`src/shared/contracts.ts:980`) and the renderer stores the whole card (`standalone.js:7296`), so `card.runSeq >= 1` is available; a board test harness exists: `test/renderer/leader-worker-board.test.ts` (the assertion at `:336-340`, "running, idle and shell go", encodes the V-26 behaviour and must be changed deliberately).

## 4. Non-binding observations for the controller (not part of the winner; no merge)

- Main-side alternative for V-09 that also works for already-running OMP sessions: `TerminalRunSnapshot` (`src/shared/contracts.ts:998-1006`) has no `runStartedAt` and `readTerminalRunSnapshot` drops it (`run-state-service.ts:138-145`), although the hook writes it (`run-state.ts:284`, `:559`, set only in `before_agent_start`) and `session_start` leaves it unset (`:514-526`). Requiring `typeof run.runStartedAt === 'number'` in `isRunSettled` (`leader-runtime.ts:79-85`) closes the resume window; a strict `runStartedAt > afterEventAt` would not settle an answered `waiting_user` turn, because `tool_result` flips to `running` without `before_agent_start` (`run-state.ts:604-611`). A's hook-side `lastEventAt` carry-over is fine and simpler; the Main-side check is the option if the existing Leader session must benefit.
- Sanctioned `terminal.write` for watcher sessions exists as a hint string only (`src/main/qa/haravan-sync-barrier.ts:228-229`). It targets generic agents, not registered Leader workers, so refusing CLI text for registered workers does not break a flow the skill uses.
- `ensureDaemon` spawn path (`daemon-spawner.ts:317-331`, after the L0 return at `:311`) is where a Main-side counter floor could be written before a replacement daemon starts; A puts the floor in the daemon bundle (`terminal-manager.ts:1069-1086`) as LAND-BUT-NOT-LIVE, which is also valid.
- Nobody restarts the daemon: `scripts/antifan-restart.ps1:59` excludes `daemon-entry`.

## 5. Winner text (candidate A, verbatim)

# Reframing: AntiFan Leader backlog (V-01..V-28), candidate

I read the packet, the scout report and the code it cites. I only ran reads. No builds, tests, live terminals or tabs were touched. Anything I could not observe is marked `[INFERENCE]`.

## 1. Technique and symptom match

**Primary technique: Inversion, then a Simplification Cascade.** The scout's fix list has 11 steps. Most of them add one more special case to a deny-list or one more reconcile path, and the fixes read like whack-a-mole. Four directions are flipped, and each flip collapses several findings into one rule.

| Normal assumption (what the scout's fixes keep doing) | Inverted rule | Findings it closes |
|---|---|---|
| Detect the bad command shape (enumerate parser bypasses) | A worker command that mentions a theme CLI must be one plain command, or it is refused. This is an allowlist behind a coarse tripwire, and the repo already has the tripwire (`EVAL_THEME_CLI_RE`, `theme-push-policy.ts:207`, used by `planEvalThemeCode` at `:215`). | V-10 shapes 1-3, 5, 6, 8; V-04; the cheap half of V-12 |
| Whichever process wrote last owns `runs/<terminalId>.json` | One owner per file: a lease keyed by `ompSessionId`, using the same liveness rule Main already uses (`classifyRunLiveness`, `run-state-service.ts:93-105`: pid alive and heartbeat under 45 s). | V-02; V-08's widened window; V-09 with a 2-line carry-over; the ghost `promptHead`/`runSeq` |
| Clear authority at death (`forget` on `session-closed`, `native-tab-host.ts:2268`, `:7427`) | Also clear at birth, in the one place Main mints a terminal and grants authority (`placeLeaderTerminal`). A missed close event can then no longer hand a recycled id old rights. | the practical effect of V-01/V-06 for Leader-minted workers, with no daemon change |
| Fix the "bug" the scout names | Check that the fix does not weaken the gate. | V-07's proposed fix is unsafe (section 3) |

**Scale game.** The worker-count and fan-out numbers below are my own arithmetic, not measurements. A worker that runs `--ultra` fans out 5 or more subagents, and each subagent writes the same `runs/terminal-N.json`. With 5 workers, that is about 30 writers on 5 files. Every other finding gets worse in proportion to usage, so V-02 comes first.

**Meta-pattern.** V-04, V-10 and V-12 all do the same thing: they text-match a stream the other side controls. For example, `terminal.write` input is a byte stream, so `hrv th` followed by `eme push` defeats any per-call scan. That is why the answer is an allowlist plus a per-target line buffer, not a better regex.

## 2. Findings I checked that change the scout's fix directions

1. **V-07, the proposed fix removes safety.** The scout says to "register on create only". Today `assignWorker` on write (`terminal-capabilities.ts:535`) is what puts the theme gate (`isLeaderWorker`, `edit-guard.ts:386-401`) on an OMP the Leader types into, including a pre-existing terminal. Removing it leaves a Leader-launched `omp` ungated. The real defect is only the steal: `assignWorker` rewrites a record owned by another Leader (`leader-registry.ts:141-155`). The gate reads any `leaderId`, so refusing the steal costs nothing in safety.
2. **V-11, the CLI contract is different from the skill's.** `docs/haravan/cli-operations-and-guards.md:46,123` says `--nodelete` is accepted and ignored by `hrv theme push`. Nothing in `docs/haravan` or `src` documents a `--prune` flag. Enforcing "require `--nodelete`" would add a false sense of protection. `SKILL.md:64` ("CẤM … --prune", `--nodelete` in the push form) is therefore a docs bug, not a parser bug. This rests on the docs snapshot of 2026-09-12 and I did not run `hrv`. The real residual is that deleting 1-2 files locally while `hrv theme dev` runs deletes remotely with no prompt (same doc, §4 item 2.2). That only reaches a draft theme.
3. **V-03, a daemon-only fix does nothing.** `daemon-client.ts:537-538` maps any successful RPC to `true` and ignores the reply body. `daemon-entry.ts:279-281` always replies `{written:true}`, and `TerminalManager.writeTo` returns `void` (`terminal-manager.ts:2244-2248`). Both halves are needed. The client half (`res?.written !== false`) stays compatible with the old daemon, so it can go live tonight.
4. **V-06 and V-16, generation cannot serve as an incarnation stamp.** `sessionGenerations.delete(id)` runs on every close (`terminal-manager.ts:2529`, `:3296`), so a recycled id restarts at generation 1. The scout's "per-incarnation stamp" idea would need a newly minted stamp, which means daemon code.
5. **V-04, two more holes beyond the scout's.**
   - A per-call scan of `terminal.write` input misses chunked keystrokes. It needs a per-target buffer flushed on CR/LF.
   - A worker can run `omp` inside a split it created. That nested OMP sees `ANTIFAN_TERMINAL_SESSION_ID=split-N`, which has no registry record, so `isLeaderWorker` returns false (`edit-guard.ts:386-401`). Registering the new split as the same Leader's worker closes this in Main with no hook change. Board rows hide splits (`standalone.js:7897`, `!s.splitOf`), so the board is unaffected.
6. **V-12, a realistic fail-open trigger on Windows.** `isLeaderWorker` swallows every read error (`edit-guard.ts:398-400`). `LeaderRegistry.commit()` does temp-write then `rename` (`leader-registry.ts:94-100`). A reader hitting a transient EBUSY/EPERM during that rename [INFERENCE: Windows behaviour not observed here] would be treated as "not a worker". Live runs report `mode:"unset"`, and the `tool_call` catch only blocks in scoped modes (`edit-guard.ts:701-708`).
7. **Hook install bakes in the working tree.** `scripts/install-omp-hooks.mjs` bundles from repo source with esbuild (`:95-101`). Running it in the shared dirty tree installs foreign uncommitted hunks into `~/.omp/agent/hooks/`, which every OMP session on the machine loads. Run it from a clean worktree at the committed SHA.

## 3. Decisions per cluster

Live-verifiability codes: **L-hook** (live only for OMP sessions started after the install), **L-main** (live after `npm run compile` plus `antifan-restart.ps1 -Force`, daemon kept), **L-ui** (renderer; needs `copy-static` and a window reload), **NOT-LIVE** (daemon bundle; needs the daemon restart).

### C1: push-gate completeness

**V-10 + V-11 + V-28: FIX TONIGHT (L-hook).**
- In `theme-push-policy.ts`, add `mentionsThemeCli(text)`. It is the `EVAL_THEME_CLI_RE` family, also matching `@shopify/cli` and `haravan-cli` (`npx @f1genz/haravan-cli theme push` currently slips past because `haravan` is followed by `-`).
- In `gateThemeCommand` (`edit-guard.ts:427-436`), after `parseThemeCommands`, refuse with a new code `REFUSED_THEME_COMPLEX` when the tripwire fires and any of these holds:
  - the first token is not the CLI itself (wrapper, `cd x &&`, `bash -c`, `powershell -c`, `cmd /c`, `python -c`, `node -e`, `npx`);
  - the line contains `(`, `$(`, `{`, a backslash-newline or a backtick;
  - mentions outnumber parsed commands.
- This matches the worker header the skill already demands ("chạy push/dev một mình trong một lệnh bash, không ghép sau cd", `SKILL.md`, worker header step 2), so it enforces the existing contract.
- Also in that function: refuse a line that mentions `.haravan-cli_local.json` next to a theme CLI (V-10 shape 7). Fix the swapped allow/block row fields (V-28, `edit-guard.ts:438` vs `:446`).
- Add `--org <n>`-style value handling only as "refuse when `theme` follows unknown tokens". This avoids guessing `hrv`'s option table.
- Do not add `--prune` or `--nodelete` enforcement; fix `SKILL.md` instead (C6).
- Keep the known false refusals (`git commit -m "…shopify theme…"`, `rg "hrv theme"`). They already occur today via REMOTE_OP (`theme-push-policy.ts:158-167`). Document `git commit -F <file>` in the worker header instead of adding a verb allowlist. A "safe verb" list can be defeated by `git -c alias.x='!hrv theme push' x`.
- Residual, stated plainly: this is a guardrail, not a sandbox. `bash push.sh`, `npm run deploy` and `$H theme push` remain invisible to any text gate.

**V-04: FIX TONIGHT (L-main).**
- In `terminal.write`, `terminal-capabilities.ts:517-533`, when `scope.bound && !scope.leader` and `registry.workerOf(scope.homeId)` exists (the same condition as `isLeaderWorker`), append the input to a per-target line buffer (cap about 4 KB, reset on CR/LF/Ctrl-C). Run the shared `mentionsThemeCli`/`parseThemeCommands`/`planThemeCommand` on each completed logical line. On a block, throw a `CapabilityError` with the existing `REFUSED_THEME_*` codes and do not write.
- Main has no import from `src/omp-hooks` today (my grep found none). The pure policy module can be imported directly, or moved to `src/shared`. esbuild already bundles hook imports (`install-omp-hooks.mjs:44`). Whether tsc includes it from `src/main` is `[INFERENCE]`; the compile step proves it.
- In `terminal.create`'s non-Leader path, when the home is a registered worker, call `assignWorker(newSplitId, thatLeaderId)`. This closes the nested-OMP-in-split bypass.
- Residual: Backspace or paste-mode tricks still defeat a line buffer.

**V-12: FIX TONIGHT (L-hook for the hook side, L-main for the persist side).**
- `isLeaderWorker`: treat ENOENT as "no registry, not a worker". Retry once after about 50 ms on any other error. If it still fails, return true (fail closed). The gate only refuses theme remote operations, so the blast radius of a wrong "worker" verdict is small.
- `tool_call` catch (`edit-guard.ts:701-708`): in a non-scoped mode, block when a terminal id is set and `mentionsThemeCli(command)` is true; otherwise keep the pass-through.
- `LeaderRegistry.commit()`: return a boolean. `terminal.create` should return an explicit "gate not recorded" error instead of a ghost worker when the persist fails. Use a `.tmp-${pid}` name (it already does).

**V-13: DEFER the code, mitigate in UI (L-ui).** A correct fix needs a "gated until the worker's OMP ends" marker plus a sweep. That is new state with no safe place to expire it, and it can leave a terminal gated forever. Tonight, the "Bỏ Leader" context-menu action asks `window.confirm` (the repo's own pattern, `standalone.js:5385`, `:6977`) when the Leader has workers whose run is `running` or `waiting_user`. The text states that those workers lose the theme-push gate. Clearing a Leader is only possible from this UI (`native-tab-host.ts:4644-4665`), so the prompt covers the user path. The close-the-Leader path (`forget`, `leader-registry.ts:167-177`) stays open and is declared as a residual.

### C2: run-state correctness

**V-02: FIX TONIGHT (L-hook), top priority.**
- In `run-state.ts` `writeState()` (`:279-299`), skip the write unless this session owns the file. Rule: the file is absent, or `existing.ompSessionId === mine`, or `existing.state === "ended"`, or `existing.pid` is not alive, or `now - existing.updatedAt > 45 000` (reuse the `RUN_STALE_MS` value). Otherwise the session is a non-owner and writes nothing, including at `session_shutdown` (`:659-669`) and the heartbeat (`:297-305`).
- If the read fails, fall through to today's behaviour (run state is observability, so it fails open).
- Control-dir draining is keyed by `ompSessionId` and is unaffected.
- Edge cases to test: a resume (same `ompSessionId`, new pid) must write; a root killed within 45 s must be taken over via the pid check; a subagent that shuts down must not write `ended`.
- Cost: one extra small file read per write (every tool event and the 15 s heartbeat). Accept it.
- Whether subagents run in-process or in a child process is `[INFERENCE]`. The lease works for both, because a child has another `ompSessionId`, and an in-process one shares the pid but still differs by `ompSessionId`.

**V-09: FIX TONIGHT (L-hook).** In `session_start` (`run-state.ts:514-525`), when `existing.ompSessionId === newOmpSessionId`, keep `existing.lastEventAt` instead of `Date.now()`. A fresh session still starts at `runSeq 0`. This is about 2 lines plus a test. It keeps `isRunSettled` (`leader-runtime.ts:79-85`) from passing between `session_start` and `before_agent_start`.

**V-03: FIX TONIGHT (L-main), daemon half NOT-LIVE.**
- Main: `terminal-capabilities.ts:533` checks `(await terminal.writeTo(...)) === false` (the in-process manager returns `undefined`, only the proxy returns a boolean). On false, return `written:false` with a message and skip `assignWorker` at `:535`.
- `daemon-client.ts:538` reads `res?.written !== false`. This is compatible with the old daemon.
- Daemon: make `TerminalManager.writeTo` return a boolean and `daemon-entry.ts:279-281` reply with it. Land with a unit test, but do not claim it live.

**V-08: DEFER.** It is the same class as V-02, narrowed by V-02 and V-09, and the skill already requires `run-idle` with `afterEventAt` before the next write (`SKILL.md` §1). A pending-write marker would block a legitimate second write to a plain non-OMP shell, because no run event ever clears it. The hazard is two parallel `terminal.write` calls to one target inside the hook latency.

### C3: registry and authority

**V-07: FIX TONIGHT, narrowed (L-main).**
- `assignWorker`: `if (existing && existing.leaderId !== leaderId) return;`. Keep assign-on-write. The gate still follows any record.
- Add one test: Leader B writing to Leader A's worker does not change its `leaderId`.

**V-05: DEFER the mechanism, FIX the false text tonight.**
- A per-PTY secret has to be injected at PTY spawn, which goes through the daemon.
- The comment at `terminal-capabilities.ts:241` ("Decided by the host, never by the caller") is wrong as written for the origin claim (`bridge-server.ts:1244`, `:1341-1347`). Correct it, and the `terminal.write`/`terminal.create` tool descriptions if they imply otherwise.
- The scout and D rate this P2 because the boundary is one local user. I agree.

**V-06: DEFER, plus one cheap Main-side clear-at-birth (L-main).**
- In `placeLeaderTerminal` (`native-tab-host.ts` near `:1646`; `terminal.create` calls `assignWorker` at `terminal-capabilities.ts:435`), before `assignWorker`, call `LeaderRegistry.forget(newId)` and delete `runs/<newId>.json` and `<newId>.brief.json`. This removes the one inherited-state path Main itself creates, regardless of the daemon.
- Skip the boot-time prune. The comment at `native-tab-host.ts:7420-7424` records why a naive prune is unsafe, and I found no observed instance of a missed close.

**V-23: DEFER.** An OMP running in a split of a Leader's own tab inheriting Leader scope is arguably intended. The reverse case, a worker's split escaping the gate, is fixed under V-04.

### C4: id uniqueness and the daemon

**V-01: FIX TONIGHT, signal only (log live after the app restart).**
- In `ensureDaemon` (`daemon-spawner.ts:309-313`), resolve the staged entry before the L0 attach and compare it with `existing.version`. On mismatch, append a line to `daemon.log` and return an `outdated: true` field on the attach handle. Never kill or replace.
- Test: attach with a version mismatch.
- Surfacing it in the UI is deferred (C6).

**V-16 + V-20: LAND-BUT-NOT-LIVE.**
- In `ensureIdCounters` (`terminal-manager.ts:1069-1086`), when the sidecar is missing, also floor the counters from the highest `terminal-N`/`split-N` found in `runtime/runs/*.json` file names. Keep it a small pure helper (`highestIdIn(names)`) so it is unit-testable. The scout's second source, `leader-terminals.json`, can be added to the same helper. The daemon already has `ANTIFAN_DATA_ROOT`.
- Why it matters: the live system has no `terminal-id-counters.json`, so the first mint after the restart can reissue a recently closed top id.
- V-20: use a `.tmp-${pid}` name and log the failure in `persistIdCounters` (`:1092-1099`) instead of swallowing it.
- Not claimable as live until the daemon restart.

### C5: tooling, tests, docs

- **V-14: FIX TONIGHT, first step.** In `scripts/smoke-edit-mode-guard.cjs:44-86`, write the prompt to a temp file and pass one quoted `@<abs path>` argument, or resolve the real `omp` entry and run it with `shell:false`. It is the harness that proves hook changes against real OMP.
- **V-15: FIX TONIGHT as unit tests per fix** (listed in the plan). A Leader e2e is DEFERRED: it needs the daemon plus a real OMP, which the isolated harness cannot host tonight.
- **V-17: FIX TONIGHT (docs).** `SKILL.md:26` claims a bare `\r` is refused, and no such check exists. Delete the claim rather than add behaviour. State the wait cap as 28 s (`terminal-capabilities.ts:124`).
- **V-26: FIX TONIGHT** (see C6).
- **V-27, V-18, V-19, V-21, V-22, V-24, V-25: DEFER (P3, by design or low impact).** V-27 is a leaked `.tmp` run file that the sweep ignores (`run-state-service.ts:166`).

### C6: UX/UI and docs

| Item | Evidence | Decision |
|---|---|---|
| Board hides a worker that just finished its turn (V-26) | `leaderBoardStatusOf` marks `idle` as not attention (`standalone.js:7755-7757`) | FIX (L-ui). Split idle into "xong lượt" (idle with `runSeq >= 1`, attention true) and "nghỉ" (a fresh OMP that has not taken a prompt). Add it to the tally at `:7851-7855`. Whether the run card carries `runSeq` is `[INFERENCE]` from `run-state-service.ts:541`. |
| "kết thúc" is shown for a stale or silent run | `card.stale || card.state === 'ended'` both map to the `ended` label (`:7751-7752`). V-02 and V-22 make this mislead. | FIX (L-ui). Label stale as "không phản hồi" with a tooltip, keep "kết thúc" for a real `ended`. |
| Keyboard focus is lost on every repaint | `renderLeaderBoardBody` does `body.innerHTML = ''` (`:7893`), and `render` runs on every session push, every run-card push and the 20 s tick (`:7981`). | FIX (L-ui). Record the focused `data-session-id` before the rebuild and refocus the matching row afterwards. |
| Table row semantics broken | `<tr role="link">` (`:7811`) removes the row/cell structure for screen readers | FIX if cheap: put a real `<button>` in the name cell and keep `tr` semantic, with row click as a convenience. Otherwise DEFER. |
| Dialog accessibility | `aria-modal="true"` (`standalone.html:236`) but no focus trap, and focus does not return to `#btnLeaderBoard` on close (`close` at `:7930-7938`) | FIX: return focus to the opener on close. Focus trap DEFERRED. |
| "Bỏ Leader" with running workers | `toggleTerminalLeader` has no confirm (`:6757-6775`) | FIX (L-ui), see V-13. |
| "Đặt làm Leader" success text | `showTerminalNotice('Đã đặt "…" làm Leader')` (`:6772`) | Optional copy: say that OMP must be started or reopened in this terminal. |
| Empty-worker copy is jargon | "Leader tạo worker bằng terminal.create" (`:7860-7862`) | FIX (copy only): "Nhờ OMP trong terminal Leader giao việc để worker xuất hiện ở đây." |
| "Daemon outdated" notice | Only a log line exists from V-01. A Main-to-renderer push for it is not found. | DEFER the UI. Log tonight. |
| Refused pushes (`REFUSED_THEME_*`) are invisible to the user | Audit rows only, via `appendRows` in `edit-guard.ts`. Whether Main already reads those rows into the run card is `[INFERENCE]` from the comment in `run-state.ts` about the guard log. | DEFER (needs design). |
| `SKILL.md` (managed skill) | `:26` bare `\r`, `:27` 25 s cap, `:64` `--nodelete`/`--prune`, worker header step 2 | Fix: delete the false lines; replace with "`hrv theme push` has no deletion protection; `hrv theme dev` deletes 1-2 files remotely without a prompt"; note that a command mentioning a theme CLI must be one plain command; note `git commit -F <file>`; note that the registry assigns on write but never steals. |
| `CHANGELOG.md:25` | Claims ids "không bao giờ được cấp lại". Wrong until the daemon restart (scout V-01; no sidecar live). | Rewrite as "sau khi daemon được khởi động lại". Add the new behaviours, with the daemon-only ones marked "hiệu lực sau khi khởi động lại daemon". |
| `plans/261029-leader-terminal-orchestrator/plan.md` | "Không cần đổi hook OMP" (design section) and the id-never-reissued acceptance criterion are stale or unproven | Update both. Record which acceptance items are verified live and which await the daemon restart. |
| Tool descriptions | The Leader text is duplicated in `terminal-capabilities.ts:480,603,670,792,904` and the proxy rows at `scripts/antifan-omp-mcp.cjs:231-237`. `proxy-catalogue-hint.test.mjs:53` compares names only. | Any wording change (for example `written:false`, the write-scan refusal) must be made in both places. A description parity test is DEFERRED. |

## 4. Ordered execution plan

0. **Preflight (read-only).** List dirty files in `src/omp-hooks`, `src/main/tools`, `src/main/leader`, `native-tab-host.ts`, `standalone.*` and `scripts/`. Edit only own hunks. Do all compile and install from a clean worktree at the committed SHA.
1. **V-14 harness fix.** It is the proof tool for steps 2-3.
2. **Hook bundle, L-hook.** Do `run-state.ts` first (V-02 lease, V-09 carry-over), then `theme-push-policy.ts`/`edit-guard.ts` (V-10 tripwire plus allowlist, V-12 fail-closed, V-28). Unit tests:
   - two sessions on one terminal id (non-owner never writes, takeover on ended, dead pid, stale heartbeat; resume writes);
   - a table of every V-10 shape from the scout (1-8) plus the false-refusal controls;
   - registry EBUSY retry and ENOENT.
3. **Main, L-main.** `terminal-capabilities.ts` (V-03 main half, V-04 buffer and split registration, comment fix), `leader-registry.ts` (V-07 no steal, `commit()` boolean), `daemon-client.ts` (read `written`), `native-tab-host.ts` placement clear-at-birth, `daemon-spawner.ts` (V-01 signal). Unit tests for each.
4. **Renderer, L-ui.** C6 board and menu fixes. Run `copy-static` after.
5. **Daemon bundle, NOT-LIVE.** `daemon-entry.ts` plus `TerminalManager.writeTo` boolean (V-03 daemon half), V-16 floor, V-20. Unit tests only.
6. **Docs.** Skill, changelog, plan, comments, and the proxy rows if a description changed.
7. **Gate in a clean worktree:** `tsc`, the narrow unit tests, then the broader suites for `src/omp-hooks`, `src/main/tools` and `src/main/leader`. The pipeline's environment-induced red lanes in the memory notes (prerequisites, `autocrlf`, path-dependent tests) must be checked before reading a failure as a regression.
8. **Commit** only own hunks, plain push to `main`.
9. **App restart `scripts/antifan-restart.ps1 -Force`** (daemon kept), then `node scripts/install-omp-hooks.mjs --install` from the clean worktree. Relaunch the MCP proxy with stale `ANTIFAN_BRIDGE_*` stripped if it drops.
10. **Live verification from the Leader, throwaway worker only.**
    - Create a scratch worker terminal and have it run a subagent. Check that `runs/<id>.json` keeps the worker's `promptHead`/`runSeq`/`state` (V-02, V-09).
    - For the gate, never execute the real `hrv`. Use a stub `hrv.cmd` on a temp PATH, or text that only mentions the CLI (for example an `echo` line). That proves the refusal path without a push if the gate fails open.
    - `terminal.write` from the worker's split with a tripwire line and with a chunked line.
    - A written-to-dead-terminal call returns `written:false`.
11. **Report** which items are L-hook / L-main / L-ui verified, and which are NOT-LIVE.

## 5. Risks and residuals

- **Machine-wide blast radius of the hooks.** `~/.omp/agent/hooks/` is shared by the user's Gác sessions. A bug in the lease could blank run cards for every new OMP session. Mitigation: the lease fails open on read errors, and `hooks:rollback` exists.
- **Existing sessions keep the old hooks.** The running Leader (terminal-3) and terminal-4 are not gated or leased by the new code until their OMP is reopened. The scout's live registry showed `workers:{}` while terminal-4 runs OMP.
- **False refusals stall workers.** The gate answers NEEDS_INPUT, which costs a turn. Watch the audit rows after the first overnight run.
- **The gate is a guardrail, not a sandbox.** Script indirection, binary paths and chunked-keystroke tricks remain. The CLI itself may have a main-theme guard; I did not verify it.
- **Not fixed tonight:** V-05 (forgeable origin), V-06 beyond the placement clear, V-08, V-13 on the Leader-close path, V-23, the daemon half of V-03, V-01's UI surfacing, no Leader e2e.
- **V-16 couples the daemon's id minting to the runs directory.** The alternative is a one-time seeding of the sidecar at restart. I chose in-code so that a lost sidecar cannot reintroduce the hazard.
- **Renderer changes are checked by unit or DOM tests only.** I did not confirm an e2e harness for the board `[INFERENCE]`, so on-screen behaviour needs a look after the user wakes.

## 6. What to tell the user (Vietnamese in the final message)

1. A **daemon restart** is needed when convenient. It kills every PTY, including Gác and the Leader, so save work first. It activates the V-16 id floor, the V-20 persist fix, the daemon half of V-03, and the reissue protection (V-01). After it, check that `terminal-id-counters.json` appears on the first mint and that `daemon.json` shows the staged version.
2. **Reopen OMP** in the Leader and existing worker terminals to load the new hooks (a hook loads at session start).
3. The theme gate is a best-effort guardrail. Workers that bypass it through scripts, and the 1-2 file remote delete under `hrv theme dev`, remain.
4. `--nodelete` and `--prune` do not protect anything in the CLI (per `docs/haravan/cli-operations-and-guards.md:123`). The skill text is corrected.
5. Closing the Leader still frees its workers' gate. The "Bỏ Leader" action now warns when workers are running.

Status: DONE_WITH_CONCERNS. Concerns: nothing was run, so every behaviour above is read from code. The `hrv` flag facts rest on the 2026-09-12 docs snapshot. The tsconfig inclusion of `src/omp-hooks` from `src/main`, the run card's `runSeq` field, and the existence of a board e2e harness are `[INFERENCE]`.

Status: DONE_WITH_CONCERNS. Winner A with 6 verifier corrections; concerns: read-only, nothing executed; hrv CLI behaviour rests on docs/haravan/cli-operations-and-guards.md (2026-09-12 snapshot); subagent in-process model measured once (pid equality), not across hosts.
