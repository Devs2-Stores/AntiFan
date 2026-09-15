---
handoff-version: 1
generated: 2026-09-15T10:05:00Z
generator: ak:handoff@2.0.0
focus: "finish terminal sidebar + sleep/archive feature; close the 3 TerminalManager sleep methods"
workspace: E:/Work/apps/AntiFan
branch: main
head: 36fb497
---

# HANDOFF: terminal sidebar layout + sleep/archive + honest transcript

## Mission and current status

Focus: "finish terminal sidebar + sleep/archive feature; close the 3 TerminalManager sleep methods".

Implement plan `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/` in the AntiFan Electron app:

1. Add an **opt-in Sidebar layout** for the terminal tab strip (default stays Horizontal) — long tab rows are hard to read.
2. Add **Archive / Freeze / Sleep** for finished tabs: release the PTY, destroy the renderer pane, keep the transcript instantly viewable, wake on keystroke. Completed work is never deleted and never requires re-picking a folder.
3. Fix the **stale-history-after-restart** bug: terminal tabs showed history from the previous run and `cls` did not clear it.
4. ConPTY teardown-hang gate + performance work (IPC coalescing, renderer gating, transcript persistence).

Source session ran with `--advice` (kongming) supervision. Verdict from kongming on the wave decomposition was **GO** (upgraded from CONDITIONAL GO once the phase-4 renderer range handling was confirmed owned).

**Done:**

- Phase 1 — benchmark instrumentation + ConPTY repro harness. Scripts authored, **never executed** (need a GUI session).
- Phase 2 — transcript lifecycle + dirty-scoped persist in `src/main/browser/terminal-manager.ts`. Reported 67/67 terminal test files pass, typecheck clean for that file.
- Phase 3 — renderer pipeline gating in `src/renderer/standalone.js` + `src/shared/terminal-write-dispatcher.ts`. Reported 20/20 harness checks + 15/15 scoped tests, `node --check` clean.
- Phase 4 — IPC coalescing in `src/main/browser/native-tab-host.ts`, bridge merge in `src/main/bridge/bridge-server.ts`, preload `invoke`→`send` in `src/preload/standalone-preload.ts`. Verified by a throwaway handler harness: 20 × 300 B chunks → 1 payload (**95 % reduction**), closed sidebar receives 0 data messages, WeakMap tab lookup hit/stale/self-heal correct.
- Phase 5 (partial) — markup + CSS for the sidebar layout, resizer, category headers, sleeping tabs (`src/renderer/standalone.html`, `src/renderer/standalone.css`). All 20 sidebar CSS rules are scoped under `.standalone.tabs-sidebar`; `#terminal` has `min-width: 0`; resizer is `display:none` outside sidebar mode.
- Phase 5 (partial) — host IPC + persisted prefs in `native-tab-host.ts`: 5 new channels, `buildPersistData`/both load stages/`GET_INITIAL_STATE`, dispatch-layer `fanoutMessages` counter.
- Phase 5 (partial) — renderer layout toggle + pointer/keyboard resizer + `--term-sidebar-w` + boot-time pref application in `standalone.js`.
- Bugfix for symptom (3) landed inside Phase 2: `persistAsync`/`persistSync` used to early-return when `sessions.size === 0`, so closing the last tab never wrote `{sessions: []}` and the stale file resurrected tabs on restart. Guard is now `isDisposed || (sessions.size === 0 && !hadAnySessions)`.

**Remaining:**

- Phase 5 — `TerminalManager.sleepSession` / `wakeSession` / `setCategory` do not exist; 3 typecheck errors.
- Phase 5 — `Session.state` / `SavedSession` / `SessionSummary` do not carry `'sleeping'`; no `teardownSessionPty`; sleeping sessions are silently respawned by four `ensureSessionPty` call sites.
- Phase 5 — renderer tab categories, sleeping-tab presentation, context-menu `sleep`/`wake`/`category` wiring, category picker, bulk affinity call, sleeping-session pane guards.
- Phase 5 — wire an emitter for the `session-woken` event (listener is already registered, nothing emits it).
- Phase 1 — 3 of 4 success criteria are unmet: the harness was never executed, and `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/reports/baseline-perf.json` was never written (the `reports/` subdirectory does not exist). See the baseline analysis under Verification — the `ackLatency` and paint-pipeline baselines are **no longer recoverable**.
- Phase 6 — ConPTY flip + full verification. Not started; gated on the Phase 1 repro verdict.
- No full-suite / smoke / transport verification run has happened.

Urgency: normal. Nothing is committed; all work is in the working tree.

## Scope and guardrails

Workspace: `E:/Work/apps/AntiFan`

In scope:

- `src/main/browser/terminal-manager.ts`
- `src/main/browser/native-tab-host.ts`
- `src/renderer/standalone.js`, `standalone.html`, `standalone.css`
- `src/preload/standalone-preload.ts`
- `src/shared/contracts.ts`, `src/shared/terminal-write-dispatcher.ts`
- `src/main/bridge/bridge-server.ts`
- `scripts/repro-conpty-hang.cjs`, `test/e2e/terminal-paint-bench.cjs`, `scripts/benchmark-electron-performance.mjs`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/*`

Out of scope:

- `src/main/tools/browser-capabilities.ts`, `src/main/tools/browser-control-port.ts`, `src/main/bridge/annotation-manager.ts`, `src/shared/deadline-chain.ts` — **a different concurrent session is editing these**. They appear in `git status` but are not this task's work.
- The unrelated older plan `plans/260830-1530-electron-cpu-memory-performance-optimization/`.

Constraints (user-imposed):

- Sidebar must be **opt-in**. Default install and new windows stay **Horizontal**.
- Sleep must be **zero-cost**: release the PTY process tree, destroy the renderer xterm pane, keep the transcript instantly viewable, wake on keystroke.
- Sidebar width/state persists through `saved-tabs.json` via IPC — **never `localStorage`**.
- Do not trim explicitly requested scope. KISS + DRY.
- `--advice` (kongming) supervision must persist across any handoff.

Safety boundaries:

- Never `git commit`/`push`/`reset --hard`/`clean -fd`/`checkout -- .` in this session.
- Never `haravan theme push`, `shopify theme push`, or `sapo theme *`.
- Do not touch `~/.omp/agent/config.yml` (global harness config) — it was modified twice during this session and both times restored to the original; leave it alone.
- Do not delete pre-existing untracked files under `reports/` (`reports/scout-f1genz-*.md`, `reports/MASTER-FIX-PLAN.md`, `reports/SYNTHESIS-REPORT-*.md`) — they belong to other sessions.

## Current state

Branch: `main`
HEAD: `36fb49793eec821b093cc6bb459bcc6109eb4009` (`fix(core): preserve resolved conflicts on re-import, add busy_timeout`)
Working tree: **dirty** — 16 modified, 12 untracked entries
Intentional local modifications: **yes** for this task's files; **no** for the concurrent-session files listed below.

Changed files (this task):

- `src/main/browser/terminal-manager.ts` (+423/−…)
- `src/main/browser/native-tab-host.ts` (+337)
- `src/renderer/standalone.js` (+458)
- `src/renderer/standalone.css` (+172)
- `src/renderer/standalone.html` (+28)
- `src/renderer/terminal-write-dispatcher.js` (+66) — generated, do not hand-edit
- `src/shared/terminal-write-dispatcher.ts` (+67)
- `src/preload/standalone-preload.ts` (+7)
- `src/main/bridge/bridge-server.ts` (+65)
- `scripts/benchmark-electron-performance.mjs` (+136)
- `test/main/terminal-write-pipeline.test.ts` (+13) — retargeted to code-unit bounds because the dispatcher now budgets by `chunk.length`
- `test/renderer/standalone-harness.ts` (+87) — additive listener capture + sidebar element stubs

Changed files (NOT this task — concurrent session, mid-write):

- `src/main/tools/browser-control-port.ts` (+344) — a `.browser-control-port.ts.<pid>.<uuid>.tmpdir/` appeared and vanished during capture, proving a live writer
- `src/main/tools/browser-capabilities.ts` (+214)
- `src/main/bridge/annotation-manager.ts` (+9)
- `test/main/theme-mcp-capabilities.test.ts` (+158)

Untracked files (this task):

- `scripts/repro-conpty-hang.cjs`
- `test/e2e/terminal-paint-bench.cjs`
- `test/unit/browser/terminal-transcript-lifecycle.test.ts`
- `test/renderer/terminal-tab-layout.test.ts` (written by a cancelled agent; **review before keeping**)

Untracked files (NOT this task): `src/shared/deadline-chain.ts`, `test/unit/theme-qa-gate-hook.test.mjs`, `reports/MASTER-FIX-PLAN.md`, `reports/SYNTHESIS-REPORT-SUPER-CORE-AND-THEME-CORE.md`, `reports/scout-f1genz-multilanguage.md`, `reports/scout-f1genz-multipage.md`, `reports/scout-f1genz-wheel.md`, `reports/scout-multi-redirect.md`

Plan directory: `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/` — untracked; `plan.md` still says `status: pending` (never synced back).

## Decisions and rationale

| Decision | Rationale | Alternative rejected | Reference |
| --- | --- | --- | --- |
| Sleep is **not** close; it must never emit `session-closed`/`close` | `native-tab-host.ts` subscribes to `session-closed` → `clearTerminalAgentAffinity`, which permanently destroys the browser-tab ↔ terminal affinity map | Reuse `safelyKillSession` verbatim | `native-tab-host.ts` `session-closed` listener |
| Sleep must never set `disposed = true` | `ensureSessionPty` returns `undefined` for a disposed session → permanently unwakeable | Reuse `safelyKillSession` verbatim | `terminal-manager.ts` `ensureSessionPty` |
| Wake reuses `reservedGeneration`; the `${terminalId}@${generation}` affinity key stays stable | Wake must not migrate the generation key | Emit `session-restarted` on wake | plan Phase 5 |
| A coalesced terminal-data payload keeps `seq === throughSeq` | The preload and `processIncomingChunk` treat `seq === 0` as invalid; the renderer needs `fromSeq`/`throughSeq` to advance `lastRenderedSeq` without a gap-resync storm | Send only `throughSeq` | `src/shared/contracts.ts` `TerminalDataPayload` |
| Hidden panes skip `term.write` but must still ACK | Skipping the ACK prunes the main-process subscriber | Skip both | plan Phase 3 |
| `#terminal-split` writes are never gated | It mounts outside the tab pool and carries no `.active` class, so a naive visibility check silently loses on-screen data | Treat split as hidden | plan Phase 3 risk note |
| Default tab layout is `'horizontal'` | Fresh install and new windows must look unchanged | Persist last-used layout as the default | plan Phase 5 |
| Prefs persist through `saved-tabs.json`, never `localStorage` | Single-owner persistence; capsules already load/save this file | `localStorage` | user constraint |
| Tab prefs use `clampTerminalTabSidebarWidth` (140–400), **not** the outer sidebar clamp (260–850) | They are different concerns; the outer clamp is for the AI-chat panel | Reuse the 260–850 clamp | `src/shared/contracts.ts` |
| `GET_ALL_AFFINITIES` iterates sessions with `sessionGeneration` passed | Without a generation argument `getTerminalAgentAffinity` does an O(E) prefix scan, making a bulk call O(N×E) | Loop the per-id IPC | `native-tab-host.ts` `resolveTerminalAffinityEntry` |
| Category headers are `draggable = false` and the drop target is recomputed by session ID | The existing reorder splices by raw DOM position, so a header would corrupt the order | Splice by DOM index | plan Phase 5 |
| Measure the "> 80 % fewer IPC messages" criterion at the **dispatch layer** | `test/e2e/terminal-transport-sync.cjs` injects via `webContents.send`, bypassing the coalescer — it would stay green while production regresses | Trust the e2e test | kongming advisory |
| Reverted two global harness-config edits | `~/.omp/agent/config.yml` affects every project; the user asked to leave it alone | Leave `deploymentThinkingLevel` lowered | user instruction |

## Work performed

Commands executed with observed outcome:

- `npm run typecheck` (baseline, before any change) → **clean, 0 errors**.
- `node --test --test-force-exit ".compiled/test/main/**/*.test.js"` (baseline) → **1136 tests, 1135 pass, 0 fail, 1 skipped, 85 s**.
- `npm run typecheck` (after contract freeze) → clean.
- `npm run typecheck` (final capture, 2026-09-15T10:04Z) → **5 errors**:
  - `native-tab-host.ts(1858,44)` `Property 'sleepSession' does not exist on type 'TerminalManager'` — **this task**
  - `native-tab-host.ts(1867,44)` `Property 'wakeSession' does not exist` — **this task**
  - `native-tab-host.ts(1876,52)` `Property 'setCategory' does not exist` — **this task**
  - `browser-control-port.ts(1910,9)` `Cannot find name 'MEDIA_FREEZE_BOUND_MS'` — **concurrent session, not this task**
  - `browser-control-port.ts(1925,90)` `Cannot find name 'MEDIA_FREEZE_BOUND_MS'` — **concurrent session, not this task**
- `git status --short`, `git diff --stat`, `git rev-parse` — see Current state.

Code changes at file granularity:

- `src/shared/contracts.ts` — `TERMINAL_CHANNELS` gained `SLEEP_SESSION`, `WAKE_SESSION`, `SET_CATEGORY`, `GET_ALL_AFFINITIES`, `SET_TAB_PREFS`. New `TerminalDataPayload { sessionId; data; seq; generation?; fromSeq?; throughSeq? }`, `TerminalTabLayout`, `TerminalTabPrefs`, `clampTerminalTabSidebarWidth`, `TERMINAL_TAB_LAYOUT_{MIN,MAX,DEFAULT}_WIDTH`.
- `src/main/benchmark/telemetry.ts` — `isBenchmarkEnabled()` result cached at module load (it is read on every PTY chunk and every bridge frame).
- `src/main/browser/terminal-manager.ts` — Phase 2 complete: `Session` gained `restoredTail`, `bufferBytes`, `pendingClearScreen`, `altScreen`, `inputLineBuffer`, `category`, `sleptAt`; restore path now splits the persisted transcript into `restoredTail` and starts `buffer = ''`; `composeTranscript(s)` returns `restoredTail + '\r\n── phiên trước ──\r\n' + buffer` and is used by `getFullBuffer`, both `listSessions` branches and the `getSessionState` snapshot fallback; `persistAsync`/`persistSync` serialize only `s.buffer` with dirty-session scoping and cached per-session JSON fragments; the empty-state resurrection bug fixed; rolling ≤128-char input line detects `cls` / `clear` / `Clear-Host` on `\r` and Ctrl+L, with `?1049h/l` alt-screen tracking so vim/htop/less never trigger it; `waitTerminal` scans only the last 64 KiB; `listSessions` split lookup is O(S) via a Map and `bufferLength` is incremental; `SessionDeliveryJournal` uses head-index eviction; one `Buffer.byteLength` per chunk; `recordSubscriberAck` emits a bounded `ackLatency` benchmark.
- `src/main/browser/native-tab-host.ts` — Phase 4 + Phase 5 host: per-session data coalescing (`terminalDataBatches`, 4 ms timer, ≤256 B bypass, generation-boundary flush, ordering flushes before `session`/`session-closed`/`session-restarted`/dispose); sidebar-visibility send gate; `antifan:terminal:input-session` moved from `ipcMain.handle` to `ipcMain.on`; `findTabByWebContents` backed by a `tabByWebContents` WeakMap with self-healing fallback; 3 persisted tab prefs with both load stages; `GET_INITIAL_STATE` returns `terminalTabPrefs`; 5 new IPC handlers; `fanoutMessages` dispatch-layer counter; a `session-woken` listener and `clearTerminalAffinityTombstone()` helper added by the orchestrator.
- `src/renderer/standalone.js` — Phase 3 complete (hidden-pane gating with `needsRehydrate`, snapshot-only rehydrate via `atomicHydratePane`, coalesced `{fromSeq,throughSeq}` batch handling in `processIncomingChunk` with range-aware `liveQueue` drains, removed the wasted pre-hydrate write, 100 ms activity throttle, main-pane `isProgrammaticScroll` guard, split scrollback 50000→10000, one fit per frame, `window.__antifanTerminalBench` under `__bench=1`); plus Phase 5 layout toggle, pointer/keyboard resizer, `--term-sidebar-w`, and boot-time pref application.
- `src/shared/terminal-write-dispatcher.ts` — budgets by `chunk.length` (O(1)) instead of a UTF-8 scan; drains with a head-index pointer + one `join('')`. Regenerated into `src/renderer/terminal-write-dispatcher.js` via `npm run compile && node scripts/copy-static.mjs`.
- `src/main/bridge/bridge-server.ts` — congestion merge holds `dataParts: string[]` with a head-index dequeue; one `JSON.stringify` per flush.
- `src/preload/standalone-preload.ts` — `sendTerminalInputTo` is now `ipcRenderer.send` (all call sites discard the result); `onTerminalData` typed as `TerminalDataPayload`; `setTerminalTabPrefs` wrapper added.
- `scripts/repro-conpty-hang.cjs` (new) — real-app ConPTY teardown gate; exits 0 only if the process terminates within 5 s of quit, otherwise dumps active handles and exits 1. `ANTIFAN_USE_CONPTY=0` runs the winpty control.
- `test/e2e/terminal-paint-bench.cjs` (new) — 60 s paced-stream paint bench reading `window.__antifanTerminalBench.snapshot()`; reports `NOT_INSTALLED` and exits 1 if the hook is absent.
- `scripts/benchmark-electron-performance.mjs` — new `terminal-stream` scenario parsing `terminal.ackLatency` into p50/p95.

0 redactions applied.

## Verification

| Check | Command | Outcome | When |
| --- | --- | --- | --- |
| Baseline typecheck | `npm run typecheck` | clean, 0 errors | before first edit |
| Baseline main tests | `node --test --test-force-exit ".compiled/test/main/**/*.test.js"` | 1136 tests, 1135 pass, 0 fail, 1 skipped | before first edit |
| Contract typecheck | `npm run typecheck` | clean | after `contracts.ts` + `telemetry.ts` |
| Phase 2 terminal tests | (agent-run) `terminal-delivery-journal`, `terminal-stream-invariants`, `terminal-subscriber-and-sync`, `terminal-switching-regression`, `terminal-split-hardened`, `terminal-geometry-persistence`, `terminal-capabilities`, `terminal-canonical-ownership`, `per-tab-terminal-session`, `terminal-process-tree-and-links` | 67/67 pass | during Phase 2 |
| Phase 3 scoped tests | (agent-run) `.compiled/test/main/terminal-write-pipeline.test.js` + `test/renderer/terminal-gap-state-machine.test.js` | 15/15 pass | during Phase 3 |
| Phase 3 behaviour harness | throwaway vm harness driving `standalone.js` | 20/20 checks: hidden pane 0 writes + ACK + `needsRehydrate`; activation rehydrated FULL transcript; batch envelope dedup/contiguous/gap paths | during Phase 3 |
| Phase 3 syntax | `node --check src/renderer/standalone.js` and `terminal-write-dispatcher.js` | clean | during Phase 3 |
| Phase 4 coalescing harness | throwaway CJS harness stubbing `ipcMain` + real `TerminalManager` emitter | 20 × 300 B → exactly 1 payload `{fromSeq:2,throughSeq:21,seq:21}`; small chunk immediate; lifecycle flush ordering preserved; generation boundary flushes; closed sidebar 0 sends; WeakMap hit/stale/self-heal/unindex all correct | during Phase 4 |
| Phase 5 CSS scoping | node script filtering selectors containing `tabs-sidebar` | 20 rules, all scoped under `.standalone.tabs-sidebar` (plus the base `display:none` rule); 0 unscoped | during Phase 5 markup |
| Phase 5 markup parse | `parse5.parse()` on `standalone.html` | 0 errors; the 3 new ids appear exactly once; resizer is a direct child of `main.standalone` between `section.controls` and `#terminal` | during Phase 5 markup |
| Typecheck at stop | `npm run typecheck` | **5 errors** — 3 this task (`sleepSession`/`wakeSession`/`setCategory`), 2 concurrent-session (`browser-control-port.ts`) | at handoff |

Not run:

- `npm run test:main` full sweep after the changes — **not run**. Reason: agents were editing `src/` concurrently, so a mid-flight full run would report other agents' in-flight errors. This is the single most important missing check.
- `npm run smoke:terminal` (compile + recovery/renderer/split-hydration probes) — **not run**. Reason: needs a GUI Electron session.
- `npm run test:terminal-transport` — **not run**. Reason: same, and the script injects via `webContents.send`, bypassing the coalescer, so it does not validate Phase 4 anyway.
- `node scripts/repro-conpty-hang.cjs` — **not run**. Reason: launches the real Electron app. Phase 6's ConPTY flip is gated on this verdict.
- No renderer scroll-position verification after wake — the Phase 3 harness uses a `FakeTerminal` with no scroll model. Reason: no GUI session.
- Phase 1 baseline benchmark — **not run**. See the baseline analysis below; it is not a simple "run it later" item.

### Phase 1 baseline is half-done and only partly recoverable

Phase 1's contract has 4 success criteria. Status against each, verified at `HEAD 36fb497` vs the working tree:

| Criterion | Status |
| --- | --- |
| `window.__antifanTerminalBench` reports all 4 timestamps | Instrumented (`grep -c __antifanTerminalBench src/renderer/standalone.js` → 1 in the tree, **0 at HEAD**); **never executed** |
| `terminal.ackLatency` logged to stdout in benchmark mode | Instrumented (`grep -c ackLatency src/main/browser/terminal-manager.ts` → 1 in the tree, **0 at HEAD**); **never executed** |
| `scripts/repro-conpty-hang.cjs` reproduces the behaviour in ≤15 s | Script authored; **never executed** |
| `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/reports/baseline-perf.json` | **Does not exist** — the `reports/` subdirectory was never created |

So P1 is **instruments built, never fired** — not complete.

**Recoverability split (verified by grepping HEAD):**

- *Recoverable:* nothing was committed, so `HEAD 36fb497` is an exact pre-change snapshot; `git worktree add <dir> HEAD` reconstructs the baseline environment. `interactiveEchoLatencyMs` exists at HEAD (`grep -c` → 1), so echo-latency before/after is still measurable.
- *Not recoverable retroactively:* `terminal.ackLatency` and `window.__antifanTerminalBench` both have **0 hits at HEAD** — the instrumentation is itself part of the change. Running the new harness against HEAD code measures nothing for those two metrics. Their before/after delta can never be measured now.

**Consequence:** the Phase 3 paint-pipeline numbers and the Phase 4 "> 80 % fewer IPC messages" number can only ever be an *after* measurement supported by a code-level argument, not a measured delta. Both wave-end claims in this session ("20 × 300 B → 1 payload", "95 % reduction") are handler-level harness results, not end-to-end measurements — treat them as directional, not as the plan's accepted evidence.

**If a real delta is still required**, the only valid path is: `git worktree add` at HEAD → apply *only* the instrumentation patch (the bench hook + the `ackLatency` stamping), leaving all behaviour changes out → measure → revert the instrumentation → then apply the behaviour changes. This separates "instrument" from "change" so both sides of the comparison use the same measurement code.

## Open risks and blockers

- **Type: blocker. Owner: this task's successor.** `TerminalManager.sleepSession` / `wakeSession` / `setCategory` do not exist. `native-tab-host.ts` calls all three at lines 1858/1867/1876, so **the repo does not typecheck**. Impact: blocks everything downstream, including Phase 6.
- **Type: blocker. Owner: this task's successor.** `Session.state`, `SessionSummary.state` and `TerminalSessionDiagnostics.state` do not include `'sleeping'`, and `SavedSession` has no `state`/`category`/`restoredTail`. Without these, a sleeping tab persists as running, respawns a PTY on boot and loses its transcript. Impact: the headline "zero-cost restore" property is not achievable yet.
- **Type: blocker. Owner: this task's successor.** `safelyKillSession` sets `disposed = true` and emits `'close'`. It must be split into a `teardownSessionPty(s)` that does neither, or `sleepSession` will make the session permanently unwakeable and destroy the affinity mapping. Impact: correctness of the whole Sleep feature.
- **Type: blocker. Owner: this task's successor.** Four silent-resurrection sites call `ensureSessionPty`, which treats a null PTY as "deferred restore, spawn now": `switchSession`, `waitTerminal`, `createSplitSession`, and `pumpDeferredPtyQueue`. Clicking a sleeping tab, or an MCP `terminal.wait` / `HaravanSyncBarrier.awaitSync`, therefore wakes it by accident. Impact: violates the read-only preview contract and re-introduces PTY cost.
- **Type: blocker. Owner: this task's successor.** `captureBaselineSeq` throws `SESSION_CLOSED` when `state !== 'running'`. A sleeping watcher terminal hard-fails the Haravan theme-sync barrier. Impact: breaks an unrelated production flow.
- **Type: blocker. Owner: this task's successor.** Renderer: `syncTerminalPool`'s dispose loop never releases a pane whose session stays in `sessions`, its create loop treats an empty-buffer session as eager (so every `session` broadcast rebuilds a full xterm), and `onTerminalData` / `fitCurrentTerminal` / the split buttons all lazily create panes. `terminalPool.get` will resurrect a full xterm for a sleeping session on any touch. Impact: the zero-cost guarantee fails outright.
- **Type: blocker. Owner: this task's successor.** The `session-woken` listener and `clearTerminalAffinityTombstone()` helper are registered in `native-tab-host.ts`, but **nothing emits `session-woken`**. `wakeSession` must emit it (payload `{ id, generation }`), otherwise a terminal whose bound browser tab closed while it slept stays tombstoned and the owning agent gets `TERMINAL_FORBIDDEN` forever. Impact: agent wedge. Note `writeTo` is also an implicit wake path and must emit it too.
- **Type: blocker. Owner: this task's successor.** `mobile-remote-html.ts` reads `s.buffer` / `data.snapshot` only — never `bufferLength`, never `state`. `listSessions().buffer` and `getSessionState().snapshot` must carry the composed transcript for a sleeping session or mobile shows a blank screen.
- **Type: risk. Owner: whoever runs verification.** A different session is concurrently editing `src/main/tools/browser-control-port.ts`, `browser-capabilities.ts`, `src/main/bridge/annotation-manager.ts` and `src/shared/deadline-chain.ts`, and contributed 2 of the 5 current typecheck errors. Scope any full-suite run tightly or the results will be unattributable.
- **Type: risk. Owner: whoever runs verification.** `test/renderer/terminal-tab-layout.test.ts` was written by an agent that was cancelled mid-task. Its assertions were never validated against the final code. Review or delete it.
- **Type: risk. Owner: whoever runs Phase 6.** The "> 80 % fewer IPC messages" criterion has never been measured end-to-end. `test/e2e/terminal-transport-sync.cjs` cannot measure it because it injects via `webContents.send`. The `fanoutMessages` counter added to `native-tab-host.ts` (readable via `getResourceStats().terminalFanoutMessages` and the `DUMP_DIAGNOSTICS` payload) is the intended instrument.
- **Type: risk. Owner: whoever runs Phase 3 verification.** The sidebar-closed reopen path: while closed, the renderer's `lastRenderedSeq` goes stale; on reopen the first chunk hits the gap path and, if more than ~4096 chunks streamed while closed, the journal has evicted them → `DELTA_EXPIRED` → DEGRADED banner. `toggleSidebar()` pushes `antifan:terminal:session` on open, so the fix is to ensure that path routes through the snapshot rehydrate rather than the delta path. Unverified.
- **Type: question. Owner: unknown.** Whether `isBenchmarkEnabled()` caching at module load is safe for the benchmark harness, which sets `ANTIFAN_BENCHMARK=1` before requiring `TerminalManager` in `scripts/repro-conpty-hang.cjs` and `test/e2e/terminal-paint-bench.cjs`. Env/argv cannot change after process start, so this should hold — but it was not exercised.
- **Type: question. Owner: unknown.** `scripts/tmp-phase4-smoke.cjs` and `scripts/tmp-phase4-handler-smoke.cjs` were reported as deleted by their author; both are absent from `git status`, so cleanup appears complete. Re-confirm before committing.

## Exact next actions

1. **First safe step** — read `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-05-features.md` and `src/main/browser/terminal-manager.ts` (particularly `safelyKillSession`, `ensureSessionPty`, `switchSession`, `waitTerminal`, `createSplitSession`, `pumpDeferredPtyQueue`, `captureBaselineSeq`, `persistAsync`, `persistSync`, and the `startTerminal` restore loop), then confirm the four blocker groups above against the current code — line numbers shifted during Phase 2.
2. Split `safelyKillSession` into `teardownSessionPty(s)` (PTY disposal only: dispose subscriptions, kill the process tree, `s.pty = null`, clear the per-session `emitTimeMs` map — no `disposed`, no `state`, no emit) and keep `safelyKillSession` behaving exactly as today on top of it.
3. Add `'sleeping'` to `Session.state`, `SessionSummary.state` and `TerminalSessionDiagnostics.state`; add `category` / `sleptAt` to `SessionSummary`; add `state` / `category` / `restoredTail` to `SavedSession` and write them in both persist paths.
4. Implement `sleepSession(id)`: splice the id out of the deferred-start queue, `teardownSessionPty`, fold the live transcript with `s.restoredTail = composeTranscript(s)` then `s.buffer = ''` / `s.bufferBytes = 0`, `s.deliveryJournal.clear()`, `s.state = 'sleeping'`, `s.sleptAt = Date.now()`, schedule a persist, and emit **only** `'session'`.
5. Implement `wakeSession(id)`: only from `'sleeping'`; call `ensureSessionPty(id)` (it already carries `restoredTail` and any accumulated `buffer`/`bufferBytes` onto the materialized record); leave the session sleeping and return `false` if it returns nothing; on success set `s.state = 'running'`, clear `sleptAt`, schedule a persist, and emit `'session'` **and** `'session-woken'` with `{ id, generation }`. Do **not** emit `'session-restarted'`.
6. Implement `setCategory(id, category?)`: trim, set `undefined` for empty, schedule a persist, emit `'session'`.
7. Gate the resurrection sites as specified: keep `write`/`writeTo` as the wake path but route through the sleeping branch so `state` flips; skip `ensureSessionPty` in `switchSession` for a sleeping target; make `waitTerminal` refuse to spawn and return an explicit result; route `createSplitSession` through `wakeSession`; skip sleeping ids in `pumpDeferredPtyQueue`.
8. Allow `'sleeping'` in `captureBaselineSeq` (sequence numbers stay monotonic because `lastSeq` is never reset); keep throwing for `disposed` and `'closed'`.
9. Make the restore path skip PTY spawn for a saved `state: 'sleeping'` session — both the eager active-session spawn and `scheduleDeferredPtyStarts` — so a sleeping tab survives a restart without costing a process.
10. Finish the renderer: `renderTabs` category grouping with `draggable=false` headers and session-ID-based drop resolution, `.is-sleeping` presentation with 💤, `scrollIntoView({ block: 'nearest' })`, context-menu `sleep`/`wake`/`category` wiring, `#categoryPickerPopover` reusing `showAffinityPicker` conventions, `updateAffinityBadges` collapsed to ONE `getTerminalAffinities()` call, and the sleeping-session pane guards (dispose on sleep, exclude from `isEager`, no pane creation in `onTerminalData` / `fitCurrentTerminal` / split buttons).
11. Run `npm run compile && npm run typecheck` and confirm **0 errors** in `terminal-manager.ts`, `native-tab-host.ts`, `standalone-preload.ts`, `terminal-write-dispatcher.ts`. Ignore `browser-control-port.ts` errors while the other session is active.
12. Run `npm run test:main`. The pre-change baseline was **1136 tests / 1135 pass / 0 fail / 1 skipped** — treat any regression against that as introduced by this work.
13. Review or delete `test/renderer/terminal-tab-layout.test.ts` (written by a cancelled agent, never validated).
14. Only then attempt Phase 6: run `node scripts/repro-conpty-hang.cjs` with `ANTIFAN_USE_CONPTY=1` and the `=0` control, and flip `DEFAULT_USE_CONPTY` **only** if the ConPTY run exits 0 within its 5 s deadline on both.
15. Run `npm run smoke:terminal` and `npm run test:terminal-transport` in a GUI session, plus the `terminal-stream` benchmark for the Phase 1 baseline.
16. Sync `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/plan.md` and the phase files back to their real statuses (currently all say `pending`), and add the `fanoutMessages` dispatch-layer measurement note to the Phase 4 acceptance criteria.

## Source pointers

Plan and evidence:

- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/plan.md`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-01-benchmark-conpty-gate.md`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-02-transcript-persist.md`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-03-renderer-gating.md`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-04-ipc-coalescing.md`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-05-features.md`
- `plans/260915-0638-terminal-sidebar-sleep-cls-conpty-perf/phase-06-conpty-verify.md`
- `plans/reports/brainstorm-260915-terminal-sidebar-sleep-cls-conpty.md`
- `plans/reports/_ultra-terminal-perf-evidence.md`

Source:

- `src/shared/contracts.ts` — `TERMINAL_CHANNELS`, `TerminalDataPayload`, `TerminalTabPrefs`, `clampTerminalTabSidebarWidth`
- `src/main/browser/terminal-manager.ts` — `Session`, `SavedSession`, `SessionSummary`, `composeTranscript`, `ensureSessionPty`, `safelyKillSession`, `captureBaselineSeq`, `persistAsync`, `SessionDeliveryJournal`
- `src/main/browser/native-tab-host.ts` — terminal IPC cluster, the `session*` listeners, `clearTerminalAffinityTombstone`, `tombstoneTerminalAgentAffinity`, `isTerminalAllowedForTab`, `buildPersistData`, `restoreTabs`, `setupSidebarIpc`
- `src/renderer/standalone.js`, `src/renderer/standalone.html`, `src/renderer/standalone.css`
- `src/renderer/terminal-write-dispatcher.js` — **generated** from `src/shared/terminal-write-dispatcher.ts` via `npm run compile && node scripts/copy-static.mjs`; never hand-edit
- `src/preload/standalone-preload.ts`
- `src/main/bridge/bridge-server.ts`, `src/main/bridge/mobile-remote-html.ts` (reads `s.buffer` only)
- `src/main/tools/terminal-capabilities.ts` — `terminal.write` / `terminal.wait` routing
- `src/main/qa/haravan-sync-barrier.ts` — `captureBaselineCursor` → `captureBaselineSeq`

Scripts and tests:

- `scripts/repro-conpty-hang.cjs` (new)
- `test/e2e/terminal-paint-bench.cjs` (new)
- `test/unit/browser/terminal-transcript-lifecycle.test.ts` (new)
- `test/renderer/terminal-tab-layout.test.ts` (new, unvalidated)
- `scripts/benchmark-electron-performance.mjs` — `terminal-stream` scenario
- `test/e2e/terminal-transport-sync.cjs` — **cannot** validate Phase 4 (injects via `webContents.send`)
- `test/renderer/standalone-harness.ts` — vm harness for `standalone.js`

Diagnostics:

- `TerminalManager.getDiagnostics()` via `antifan:terminal:dump-diagnostics` → includes `fanoutMessages`
- `getResourceStats().terminalFanoutMessages`
- `window.__antifanTerminalBench` in the renderer, only when the URL contains `__bench=1`
