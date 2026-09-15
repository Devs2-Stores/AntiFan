---
title: Brainstorm — Terminal sidebar tabs, sleep/archive, cls persistence, ConPTY
date: 2026-09-15
mode: ultra (best-of-5 verifier)
winner: CandidateB
confidence: high
rejected_all: false
---

# BRAINSTORM DELIVERY CONTRACT — AntiFan Terminal (winning candidate, emitted unchanged)

## 0. Verified evidence base

All claims below were re-verified in source:

- `src/main/browser/terminal-manager.ts`
  - `Session` (L172-197): `{pty, buffer, splitOf, capsuleId, state:'running'|'exited'|'closed', sessionGeneration, pendingCols/pendingRows/pendingParentId/pendingParentGeneration, deliveryJournal}`.
  - `SavedSession` (L198): `{id,name,cwd,buffer?,splitOf?,capsuleId?,cols?,rows?}` — no state field today.
  - `MAX_TRANSCRIPT_BYTES` = 4MB in-memory, `MAX_PERSISTED_BYTES` = 1MB on disk (L202-203).
  - `persistAsync`/`persistSync` (L467-585): write `buffer: safeSliceTail(s.buffer, 1MB)` per session; debounced 2s; atomic tmp+rename with Windows fallback.
  - `startTerminal` (L964-1028) / `setCapsule` (L611-711): restore saved sessions; active base session spawns eagerly with `item.buffer` as `restoredBuffer`; others go through `reserveRestoredSession` + `scheduleDeferredPtyStarts` (250ms apart).
  - `spawn` (L835-948): `createSessionRecord` sets `s.buffer = restoredBuffer` → new PowerShell banner appends onto the dead shell's transcript → next persist re-saves both → **banners stack every restart** (Request 3 root cause #1).
  - `appendData` (L950-962): `s.buffer += data`, trim only past 4MB+256KB overshoot. **Nothing ever truncates on clear-screen** → `cls` output (`ESC[H ESC[2J`, or winpty's repaint) leaves the transcript intact → cleared content re-persists and reappears on restart (Request 3 root cause #2). xterm honors `2J` as viewport-only; scrollback (incl. replayed history) survives → "cls cannot erase".
  - `DEFAULT_USE_CONPTY = false` (L215) with the exact documented reason: ConPTY left Electron unable to exit after teardown in the live theme proof; `ANTIFAN_USE_CONPTY=1/0` override; `supportsConpty()` gates build ≥18309; spawn falls back to winpty on throw and latches `conptyFailed`.
  - `safelyKillSession` (L1078-1150): since the ConPTY revert it was hardened — setImmediate yield before kill (documented deadlock fix), removeAllListeners, `agent._conoutSocketWorker.dispose`, `_cleanUpProcess`, socket destroy/unref, `ptyInstance.kill()`, then `killProcessTree` (taskkill /T /F, 2s settle cap). This is the machinery sleep reuses and the reason ConPTY deserves re-verification.
  - `ensureSessionPty` (L777-805): materializes a reserved record on demand **reusing `reservedGeneration`** — this is what keeps `${id}@${gen}` affinity keys and `ANTIFAN_TERMINAL_AFFINITY_*` env stable across sleep→wake.
  - `dispose()` (L1568-1597): `persistSync()` runs BEFORE the kill loop and `removeAllListeners()` precedes kills → sleeping-state persistence and affinity-clearing-on-exit are already safe.
- `src/main/browser/native-tab-host.ts`
  - `session-closed` → `clearTerminalAgentAffinity` (L1459-1461): **sleep must never emit `session-closed`/`close`** or affinity dies — the central design constraint for Request 2.
  - `session-restarted` → `migrateTerminalAgentAffinityGeneration` exists (L1462) as fallback if generation ever changes.
  - IPC handlers (L1600-1753): `close-session`/`delete-session` pattern incl. `assertTerminalAccess` for agent senders — sleep/wake handlers clone this.
  - `buildPersistData` persists affinities keyed by bare terminalId (generation stripped) → affinity already survives restarts.
- `src/renderer/standalone.html` (L57-67): `.controls > #terminalTabs` pill strip + `#btnNewTerminal`; context menu `#tabContextMenu` with data-action items; `#terminal > #terminal-main`.
- `src/renderer/standalone.css`: `.standalone` is `flex-direction: column` (L35-45); `.terminal-tabs` flex-wrap with `max-height:90px; overflow-y:auto` (L193-218) — the crowding the user reports; `.terminal-session-pane` absolute panes (L648+).
- `src/renderer/standalone.js`: `renderTabs()` (~L2290) builds `.terminal-tab-wrap` pills (drag-reorder, dblclick rename, contextmenu, affinity badge, close); `syncTerminalPool` (L1290) lazily creates panes; `getOrCreateTerminalPane` (L1152) pre-hydrates `sliceHydrationTail(snapshot)` (1MB cap, L896-902) then `atomicHydratePane` + `syncPaneWithBackend`.
- `src/preload/standalone-preload.ts` (L16-44): thin invoke() wrappers — sleep/wake additions are one-liners.
- `package.json`: `node-pty ^1.1.0`, `electron ^43.4.0`, `@xterm/xterm ^6.0.0`; `smoke:terminal` script exists for the ConPTY verification gate.

---

## 1. OUTCOME (user-visible end state)

1. **Sidebar tabs**: A toggle (button in the tab strip + context-menu item "Xếp dọc tab (Sidebar)") switches the tab strip between the current horizontal pill row and a ~200px vertical left sidebar listing tabs with full titles. **Default is horizontal ('Ngang') on every fresh install/profile**; the choice persists across restarts and applies to popout terminal windows. Every existing tab interaction (activate, rename, drag-reorder, context menu, close, affinity badge, streaming/completed/sleeping indicators) works identically in both orientations.
2. **Sleep tabs**: Context-menu "Ngủ (Sleep)" on any tab cleanly kills that session's entire PTY process tree (powershell.exe + winpty/conpty agent + children) within ~2s, while the tab remains in the strip — dimmed with 💤 — retaining name, cwd, capsule, browser-tab affinity, and full scrollback transcript. Clicking the tab or typing into its pane respawns the shell in the same cwd with transcript intact and affinity unchanged ("instant resume"). Sleeping tabs survive app restarts as sleeping (no PTY spawned). "Close" still deletes permanently — sleep is the non-destructive alternative.
3. **Honest transcript lifecycle**: After `cls`/`clear`/`Clear-Host`/Ctrl+L, the viewport AND scrollback are empty immediately, and the cleared content never reappears after restart (`terminal-sessions.json` no longer contains it). On restart, each tab shows the previous session's tail exactly once, visually separated ("── phiên trước ──"), followed by exactly one new shell banner — banners never stack across restarts.
4. **Correct TUI rendering**: omp subagent views, progress bars, and timers update in place (single line rewriting `2m15s`→`2m18s`), because sessions run on ConPTY, which passes VT sequences through, instead of winpty, which screen-scrapes and linearizes them. App quit remains clean — the previously documented ConPTY teardown hang is verified fixed or the default stays off with the escape hatch documented.

---

## 2. CONSTRAINTS

- **Single-owner invariant**: only the canonical `TerminalManager` instance mutates sessions; no parallel state store for sleeping tabs.
- **Affinity continuity**: sleep/wake MUST reuse `sessionGeneration` (via `reservedGeneration`) and MUST NOT emit `close`/`session-closed` — both would trigger `clearTerminalAgentAffinity` and break the exact thing the user wants preserved.
- **Journal/seq consistency**: any synthetic output (clear sequence, sleep marker, separator) MUST go through `appendData` so `lastSeq`, `deliveryJournal`, and renderer delta-resync stay coherent. Never side-channel writes to the renderer.
- **Additive persistence only**: new fields (`state`, `sleptAt`, `restoredTail` semantics, optional `ui.tabLayout`) must default cleanly when absent in old `terminal-sessions.json` — no migration script, no schema break.
- **Process lifecycle**: sleep reuses the hardened teardown path (extracted shared helper); a sleeping session MUST leave zero child processes (verified by PID absence, not by flag). `dispose()` stays bounded — the existing 2s `killProcessTree` cap per session, parallel via `Promise.allSettled`.
- **Performance**: input-line tracking is O(1) per keystroke (≤128-char rolling buffer, reset on CR/LF); output scanning adds at most one bounded regex per appended chunk; sidebar is pure CSS (no JS layout loop); no new npm dependencies.
- **Platform**: Windows-first; POSIX paths must not regress (`useConpty` is win32-only anyway; `clear` detection also benefits bash).
- **UI convention**: labels follow the existing bilingual "Tiếng Việt (English)" pattern; horizontal remains the untouched default.
- **Agent safety**: `sleep-session`/`wake-session` IPC enforce `assertTerminalAccess` for ephemeral/offscreen/agent senders, same as `close-session`.

---

## 3. NON-GOALS

- Auto-sleep on idle/timers, tab groups, sidebar width dragging, tab search.
- Per-tab shell selection or custom shell args; session export/import; named archives; cloud sync.
- Changing transcript caps (4MB RAM / 1MB disk) or adopting a true screen+scrollback transcript model — we keep the flat-tail model.
- Mobile-remote terminal UI (`mobile-remote-html.ts`) parity for sleeping state — flagged as follow-up; it will render sleeping tabs as normal tabs meanwhile.
- Reading a sleeping tab's transcript without wake-on-input — clicking a sleeping tab DOES show the transcript (pane kept); only typing wakes the shell. (If pane-disposal is later wanted for RAM, it's an additive optimization.)
- Fixing winpty itself — impossible by design (screen-scraper). If ConPTY verification fails, Request 4 ships as "documented opt-in" not "solved"; stated honestly below.
- Rebinding affinity across generations — not needed since generation is preserved.

---

## 4. ACCEPTANCE CRITERIA (binary, observable)

### Request 1 — Sidebar
- **A1.1** Fresh profile launch → tabs render horizontally, pixel-identical to current build.
- **A1.2** Toggle → strip becomes a left vertical column (~200px, `clamp(160px,18vw,240px)`); 15 tabs all show full titles; `#terminal` resizes with zero horizontal overflow at 1280×720 and 2560×1440.
- **A1.3** Toggle back → horizontal restored. Restart app → last choice persists. Open popout terminal window → same layout applied.
- **A1.4** In sidebar mode: click activates, dblclick renames, drag reorders (drop order = visual order), context menu opens, ✕ closes, 🎯 badge updates — all verified once each.

### Request 2 — Sleep
- **A2.1** Sleep a tab → within 2s: tab dimmed+💤; `tasklist /FI "PID eq <ptyPid>"` finds nothing; no powershell/conhost/winpty child under the app for that session.
- **A2.2** Sleeping tab retains name, cwd, capsule, 🎯 affinity badge, and scrollback (scroll up shows pre-sleep output).
- **A2.3** Type a keystroke into the sleeping pane (or click tab) → new shell spawns in the same cwd; `echo $env:ANTIFAN_TERMINAL_AFFINITY_SESSION_ID` and `_GENERATION` match pre-sleep values; the bound browser tab still resolves via `getTerminalAgentAffinity`.
- **A2.4** Restart app → slept tab restores as 💤 with NO PTY spawned (process check) and transcript visible; wakes on input.
- **A2.5** Sleep the ACTIVE tab → activation moves to next running session (or empty state); no dead pane.
- **A2.6** Sleep a parent with split → both PTYs die; wake parent → parent resumes; split re-materializes on its own activation (existing `ensureSessionPty` semantics).
- **A2.7** Close a sleeping tab → record gone, no error, persist file updated.
- **A2.8** Agent tab calls `sleep-session` on a session it doesn't own → `TERMINAL_FORBIDDEN`.

### Request 3 — cls / restart
- **A3.1** `cls`, `Clear-Host`, `clear`, and Ctrl+L each → viewport+scrollback empty immediately (scroll-to-top shows nothing).
- **A3.2** After `cls` + 3s (persist debounce) → `terminal-sessions.json` session `buffer` contains no pre-cls bytes (grep the file for a unique pre-cls marker string → absent).
- **A3.3** Restart after cls → cleared content absent; exactly one banner.
- **A3.4** Two consecutive restarts without cls → exactly one separator-delimited "previous session" section and one banner per restart — never N stacked banners.
- **A3.5** vim/htop/less (alt-screen `?1049`) → their `2J` sequences do NOT wipe the transcript; post-exit scrollback intact.
- **A3.6** `waitTerminal` regex over post-cls output still matches; never false-matches cleared text.

### Request 4 — ConPTY / display
- **A4.1** Default build (env unset) → session runs on ConPTY (assert via diagnostic field or observed VT behavior).
- **A4.2** Repro: run omp subagent view or a script emitting `\x1b[2K\r` timer updates for 60s → exactly one updating line, zero duplicated timer lines.
- **A4.3** The documented hang scenario: open sessions, produce output, close all tabs, `app.quit()` → Electron process exits ≤5s; no orphaned powershell/conhost/OpenConsole/node-pty agent processes (this is the exact failure that forced d1b64f0 — it MUST be re-run, not assumed).
- **A4.4** `ANTIFAN_USE_CONPTY=0` → winpty fallback still works end-to-end.
- **A4.5** `smoke:terminal` suite (recovery + renderer + split-hydration) passes under ConPTY.
- **A4.6** Forced ConPTY spawn failure → winpty fallback engages via `conptyFailed` latch, one warn line logged.

---

## 5. COMPARED APPROACHES & RECOMMENDATION

### Item 1 — Sidebar
| Approach | Trade-off |
|---|---|
| **A. CSS-grid class toggle + `localStorage` pref (RECOMMENDED)** | `.standalone.tabs-sidebar` → `display:grid; grid-template:"header header" auto "controls terminal" 1fr / 220px 1fr`. Zero DOM restructure; all tab JS untouched; pref is renderer-local, trivially applied pre-first-render. Popout windows share the partition → shared pref. |
| B. Persist `ui.tabLayout` inside `terminal-sessions.json` + IPC broadcast | Single source of truth, live-syncs all windows; but couples a pure-UI pref into session persistence and needs a new channel + payload versioning. Heavier for identical UX. |
| C. New sidebar component / DOM restructure | Most code, most regression surface, no benefit over grid re-areas. Rejected. |

**Worst case (A)**: localStorage unavailable/cleared → falls back to horizontal default — the mandated default anyway. Benign.

### Item 2 — Sleep
| Approach | Trade-off |
|---|---|
| **A. `'sleeping'` state on the existing Session + extracted `teardownSessionPty` + `ensureSessionPty` reuse (RECOMMENDED)** | Minimal new machinery: `reserveRestoredSession`/`ensureSessionPty` already implement "record without PTY, materialize on demand, same generation". Sleep = teardown minus `disposed`/`session-closed`; wake = existing materialize. Persisted `state:'sleeping'` excludes the session from `deferredPtyIds` auto-start — the one real divergence. |
| B. Separate `archivedSessions` store outside `sessions` map | Cleaner conceptual split but duplicates tab listing, ordering, persistence shape, and wake path; two sources of truth for the tab strip. Rejected. |
| C. Suspend process (NtSuspendProcess) instead of kill | Windows has no SIGSTOP; suspending leaves RAM held and handles stale; doesn't satisfy "cleanly terminate". Rejected. |

Key sub-decisions: sleep cascades to the session's split; wake restores parent only (split wakes on demand); `switchSession` to a sleeping session does NOT auto-spawn (transcript viewable), first input via `writeTo`→`ensureSessionPty` wakes — matching deferred-restore semantics; renderer keeps the pane (dimmed) so history stays readable — PTY death is the real CPU/RAM win (~30-80MB/tab vs a few MB of xterm).

**Worst case (A)**: a session slept mid-output gets a late chunk appended post-teardown — harmless (real output, transcript grows by bytes). Or: crash between sleep and the 2s-debounced persist → session restores as running — benign, self-heals.

### Item 3 — cls / restart
| Approach | Trade-off |
|---|---|
| **B. Split `restoredTail` from live `s.buffer` (RECOMMENDED)** | `createSessionRecord`/`spawn` store the restored transcript in `s.restoredTail` (with separator baked in), `s.buffer` starts empty for the new shell; persist writes only `s.buffer`. Old tail is shown once, never re-persisted → banner stacking becomes structurally impossible; `waitTerminal`/`getFullBuffer` operate on live-shell output only (fixes a latent dead-output match bug). Renderer hydrates `restoredTail + buffer` — seq contract unchanged. Old save files load as restoredTail once, then age out — no migration. |
| A. Keep merged buffer + separator + truncation only | Smaller diff, but banners still accumulate inside the 1MB tail (one per restart) — only partially answers the complaint. |
| C. Drop transcript restore entirely | Simplest, but removes a deliberate feature (restart recovery) the user didn't ask to remove. Rejected. |

Plus, orthogonal to A/B — **clear-intent channel** (required under either):
- Input-side detection in `write`/`writeTo`: rolling ≤128-char line buffer per session; on `\r`, match `^\s*(cls|clear|Clear-Host)\s*$`, or `\x0c` (Ctrl+L) anywhere → set `s.pendingClearScreen`. Suppressed while `s.altScreen` (tracked from `?1049/?47/?1047` h/l in output) to protect TUIs.
- Next `appendData` after the flag: `s.buffer=''` then emit `\x1b[3J` prepended to the chunk — renderer erases scrollback then draws the shell's post-clear repaint; journal records the combined chunk (seq stays coherent). Flag also flushed at persist time so a quit-between-cls-and-output still truncates.
- Output-side: truncate `s.buffer` on `ESC[3J` seen outside alt-screen (unambiguous erase-scrollback intent; safe). `2J` alone is NOT truncated — too ambiguous (ConPTY repaints), and input-side already covers the real `cls` path.

**Worst case**: false positive — `cls` typed inside a main-screen REPL (node/python) clears scrollback wrongly. Mitigated by alt-screen suppression; residual accepted and documented (transcript is volatile by design; no data is destroyed beyond scrollback).

### Item 4 — Display bug
| Approach | Trade-off |
|---|---|
| **A. Re-enable ConPTY by default, gated on teardown re-verification (RECOMMENDED)** | ConPTY is a real VT translator — in-place redraws (`\x1b[A`, `\x1b[2K`, `\r`) just work; winpty cannot be fixed for arbitrary TUIs. The hang that forced d1b64f0 predates the current `safelyKillSession` hardening (setImmediate yield, agent socket/worker teardown, taskkill tree, bounded waits) — plausibly already fixed; MUST be proven by A4.3/A4.5, not assumed. `ANTIFAN_USE_CONPTY=0` remains the escape hatch; `conptyFailed` latch remains. |
| B. Stay on winpty + renderer-side de-dup of redraw lines | Would require re-implementing a screen model over a scraped stream — fragile, app-specific, never fully correct. Rejected as primary; it IS the residual state if verification fails. |
| C. Upgrade node-pty first, then re-enable | Contingency inside A: if A4.3 reproduces the hang on 1.1.0, evaluate newer node-pty or explicit `ClosePseudoConsole` ordering before giving up. |

**Worst case (A)**: hang reproduces on some machines → app can't quit → mitigation: keep `dispose()` bounded (it already is: parallel `Promise.allSettled` over 2s-capped kills) plus a quit watchdog that force-exits after a hard deadline; if still unreliable, revert the default and ship items 1-3 with ConPTY documented as opt-in. That is the honest floor for Request 4.

---

## 6. HONEST UNKNOWNS & RISKS

1. **ConPTY teardown hang — unverified.** The d1b64f0 comment is the only evidence; the subsequent `safelyKillSession` hardening may already resolve it, or the leak may be inside node-pty's `WindowsPtyAgent`/OpenConsole handle lifetime. Cannot be settled without running A4.3 on the target machine. This is the single biggest risk in the contract.
2. **ConPTY `3J` emission for Clear-Host** on this exact Windows 11 build is unconfirmed — mitigated by input-side detection which is backend-agnostic.
3. **REPL false-positive** on input-side `cls` detection (accepted; alt-screen suppression covers TUIs, not REPLs).
4. **localStorage partition behavior** for standalone/popout windows unverified — fallback is the sessions-JSON `ui` field (Approach B) at modest extra cost.
5. **`setCapsule`/`startTerminal` active-session edge**: saved `activeSessionId` pointing at a sleeping session — spec'd as "allowed, renders sleeping pane, wakes on input" but needs a deliberate check during implementation (alternative: auto-advance to next running session).
6. **`mobile-remote-html.ts`** consumes the same session state; sleeping tabs will appear normal there until a follow-up — cosmetic, not blocking.
7. **Sleep marker line** (optional `── terminal ngủ ──` appended via `appendData`) pollutes the transcript slightly; included for UX clarity, droppable.
8. **Split sleep semantics** (cascade down, wake independently) is a chosen semantic, not user-specified — flagged for product confirmation.

## 7. IMPLEMENTATION SHAPE (for the winning contract)

1. `terminal-manager.ts`: extend `Session.state`/`SavedSession`/`SessionSummary` with `'sleeping'` + `sleptAt` + `restoredTail`; extract `teardownSessionPty` from `safelyKillSession`; add `sleepSession`/`wakeSession`; input-line clear detection + `pendingClearScreen` + `altScreen` tracking in `appendData`; exclude sleeping from deferred starts; flip `DEFAULT_USE_CONPTY` after A4.3 passes.
2. `contracts.ts` + `native-tab-host.ts` + `standalone-preload.ts`: two channels + two preload wrappers + agent access checks.
3. `standalone.html/css/js`: toggle button + context items; `.tabs-sidebar` grid; `is-sleeping` styling; `restoredTail+buffer` hydration; wake-on-click/input wiring; localStorage pref.
4. Verification: A4.3 hang repro FIRST (it gates the default flip), then `smoke:terminal`, then the per-item acceptance list.

---

## Appendix — Verifier ranking (best-of-5)

| Rank | Candidate | Total | Rationale (condensed) |
|---|---|---|---|
| 1 | **CandidateB** | 75 | restoredTail/live-buffer split kills banner stacking structurally; input-side cls detection is backend-agnostic (works under winpty AND ConPTY); correct affinity constraint (`session-closed` → `clearTerminalAgentAffinity`); sharpest acceptance set; honest ConPTY floor. |
| 2 | CandidateD | 69 | Deepest find: root-caused ConPTY teardown hang in node-pty `ConoutConnection.dispose()` (ref'd 1s drain timer + `worker.terminate()` can pend forever). But banners only delimited, still accumulate. |
| 3 | CandidateA | 69 | `persistFloor` kills stacking; unique catch: `persistAsync` early-return on `sessions.size===0` resurrects closed tabs. Wrong claim that affinity is in-memory only; cls durability depends on unverified ConPTY 3J emission. |
| 4 | CandidateE | 66 | Correct hard rule "2J must never truncate"; caught Ctrl+K clears xterm only. But restart complaint not fixed by default — fix is opt-in. |
| 5 | CandidateC | 55 | Truncates `s.buffer` on ANY `\x1b[2J` with no alt-screen guard → vim/less/htop and winpty repaints wipe persisted history. Correctness regression. |

Verifier confidence: high (0.9). `rejected_all: false`.

---

## Amendment A — Round-2 scope (2026-09-15, evidence-verified by 4 scouts)

Supersedes/extends the winning contract where noted. All line refs verified by scout pass.

### A-1. Sidebar drag-resize (new request)
- `.standalone.tabs-sidebar` grid column becomes `var(--term-sidebar-w, 220px)`; a col-resize divider on the column boundary reuses the existing pointer-capture + rAF pattern (`#resizeHandle` standalone.js:2691-2734, `#terminal-divider` L2740-2801). Clamp ~140-400px.
- **Correction to contract §5 Item 1**: repo has ZERO localStorage (grep-verified). Pref convention = IPC → main → capsule state (`setPanelWidth` → `sidebarWidth` clamp → `schedulePersist`, native-tab-host.ts:2049-2053; shape `workspace-capsule.ts:27-56`). Sidebar width + layout mode + collapsed-category set persist there, NOT localStorage.
- `#terminal` MUST gain `min-width:0` (absent today, css L611-621) or xterm content forces grid overflow.
- Scroll-into-view must switch off `scrollLeft` (L2444-2457 — dead under flex-wrap, wrong axis vertical) → `scrollIntoView({block:'nearest'})`.

### A-2. Tab categories (new request)
- New optional `category?: string` on `Session`/`SavedSession`/`SessionSummary` (additive, defaults uncategorized). Context menu "Đặt nhóm (Set category)…" + drag-onto-header optional.
- Sidebar mode: group headers (non-draggable dividers inside `#terminalTabs`); reconcile tolerates them (only tracks `.terminal-tab-wrap`) BUT the insertBefore ordering loop (L2435-2440) and drop splice index math (L2325-2328) must become group-aware.
- Horizontal mode: order-by-category + colored chip on pill (no headers — strip stays one row).
- `SessionSummary` also lacks `capsuleId` (L1254-1271) — add it while touching the contract (enables future capsule-grouping).

### A-3. Sleeping tabs = zero-cost (hardened requirement)
Sleeping session MUST cost: no PTY (already), no renderer pane, no per-chunk work, no persist stringify, no emitSession buffer budget.
- Renderer: dispose pane via existing teardown (standalone.js:1296-1305 — addons, term.dispose, ResizeObserver unobserve, paneEl.remove, pool delete). Click sleeping tab → recreate pane + hydrate transcript read-only (no PTY spawn); first keystroke → `ensureSessionPty` wake.
- Main: keep only ≤1MB persisted tail string in memory (drop the 4MB live buffer at sleep — persist already stores the tail; sleeping sessions excluded from `listSessions` buffer snapshots entirely).
- Sleeping sessions excluded from: deferred PTY starts, `resize()` broadcast loop (L1049-1063), `waitTerminal` scans, activity classification.
- Acceptance adds: **A2.9** 20 sleeping tabs + 5 active → renderer RSS and per-chunk main-thread time statistically identical to 5 active alone (measured via benchmark harness); **A2.10** sleeping tab contributes 0 to `terminal-sessions.json` re-serialization cost (dirty-scoped persist, see perf plan).

### A-4. Perf/benchmark pass (request 4)
Handled by a dedicated --ultra best-of-5 pass; evidence packet `plans/reports/_ultra-terminal-perf-evidence.md`; winning plan appended as Amendment B when the verifier returns.

---

## Amendment B — Terminal speed/benchmark plan (winning --ultra candidate, emitted unchanged)

Technique: **Scale Game** (push each pipeline stage to extremes: 50 tabs, 4MB buffers, 60s TUI stream, 3+ popouts, i5-9300H/UHD630) + measure→fix→re-measure. Verifier: Candidate2, 73/80, high confidence.

### What breaks first (evidence-ranked)
1. **Hidden-pane full pipeline** — every materialized pane (incl. `visibility:hidden`, which does NOT throttle xterm parse/paint) runs ANSI-strip + 7-8 regexes + UTF-8 scan + parse + canvas paint per chunk. ~50× waste at 50 tabs. Popouts multiply again.
2. **Persist main-thread stall** — `persistAsync` JSON.stringifies ALL sessions' 1MB tails every 2s while dirty (~50MB at 50 sessions), blocking input echo + fan-out.
3. **Per-chunk IPC fan-out** — unbatched `wc.send` per chunk to sidebar + every popout.
4. **waitTerminal 4MB regex per chunk** during active waits (agent workflows hold waits open during heavy streams).
5. **O(S²)/O(S³) session-state paths** — `listSessions` per emitSession during mass restore.

Survives (do not touch): seq/generation journal protocol, dispatcher 64KB frame budget + ≤256B fast path, atomic persist, deferred PTY starts, bounded hydration tail.

### Fix plan (ordered; P0 = benchmark first, no fix ships without baseline)
1. **Gate per-chunk pipeline for non-visible panes — SHIP.** Advance `lastRenderedSeq`/ack normally, skip notifySessionActivity heavy path + queueWrite/term.write for panes without `.active` (per-window check — popouts have own activeId). On activation: re-hydrate via `atomicHydratePane`+`getFullBuffer` (snapshot, NOT delta — delta from advanced lastRenderedSeq silently skips gated chunks). Prerequisite for zero-cost sleep.
2. **Dirty-scope persist — SHIP.** `dirtySessionIds` set; serialize only dirty sessions, cache clean fragments. Preserve single-file atomic tmp+rename + writeSequence guard. Contractual per A2.10.
3. **Per-tick IPC coalescing — SHIP.** Merge per sessionId per tick (≤8ms) BUT frame MUST carry `fromSeq`/`throughSeq` (or seqs array) — merging to one seq reads as gap → resync storm. Bypass for ≤256B chunks to preserve echo latency.
4. **Bound waitTerminal regex window — SHIP.** Test evt.data + ≤64KB rolling tail; cap accumulatedAfterSeq.
5. **Bridge congestion merge O(n²)→O(n) — SHIP.** Queue raw strings, stringify once at flush; index-pointer dequeue.
6. **listSessions O(S²)→O(S) — SHIP.** Precomputed splitOf map + incremental bufferBytes on Session.
7. **Kill double hydration write — SHIP.** Pre-hydrate `sTerm.write(boundedTail)` is discarded by `term.reset()` (~1MB wasted parse/pane); join liveQueue replay into one write.
8. **Throttle notifySessionActivity — SHIP.** ≤1 classify/100ms/session while streaming.
9. **Dispatcher micro-fixes — SHIP.** `chunk.length` instead of O(n) UTF-8 scan; batch-dequeue + join.
10. **Coalesce fit/refresh triggers — SHIP.** ≤1 fit+refresh/frame; skip refresh when dimensions unchanged.
11. **Batch affinity badges — SHIP.** Bulk `getTerminalAffinities` IPC: 51 round-trips → 1.
12. **findTabByWebContents WeakMap — SHIP.** O(T)→O(1) per keystroke.
13. **Cache isBenchmarkEnabled + dedupe byteLength — SHIP (trivial).** Also removes telemetry contaminating the baseline.
14. **Journal shift()→ring/index — SHIP (trivial).**
15. **Keystroke invoke→send — SHIP.** No caller awaits the result.
16. **resize() defer background PTYs — SHIP.** pendingCols/pendingRows already exist; safe once item 1 lands.
17. **onScroll guard + scrollback align — SHIP (trivial).** Read isProgrammaticScroll (written, never read); split 50000→10000.
18. **WebGL re-enable — DEFER.** Only if paint benchmark shows active-pane canvas can't sustain the stream post-items-1-17; flag-gated, active pane only, onContextLoss→canvas fallback.

### Benchmark design (lands before fixes)
- `window.__antifanTerminalBench` renderer hook (~60 lines): performance.now() at IPC receipt, queueWrite, onPostWrite (parse-complete), next-RAF (paint proxy); per-session latency ring + counters.
- Same-clock e2e `ackLatencyMs`: main stamps ptyData emit per seq; renderer ack returns last rendered seq → true PTY→parsed latency, no cross-process clock skew.
- `test/e2e/terminal-paint-bench.cjs` (clone transport-sync): scripted 60s TUI stream × N sessions; asserts hidden panes ~0 writes, ackLatencyMs p95, existing gates green.
- `terminal-stream` scenario in benchmark-electron-performance.mjs: sustained stream + concurrent waitTerminal + 50 restored sessions; event-loop p50/p95/max, persist stringify ms/bytes, IPC counts.
- Methodology: baseline under winpty AND ConPTY (chunk profile differs) → one run per fix → A/B table; p50/p95/max never means.

### Residual unknowns
Chunk→paint latency split (unknowable until hook lands — may reorder items 2-5); V8 rope flatten real cost; ConPTY chunk profile magnitude; xterm parse-vs-paint split on UHD630 (decides WebGL); popout materialization multiplier; sleep disk-offload format; emitSession frequency user-visibility; 64KB frame budget adequacy.

### Verifier ranking (perf pass)
| Rank | Candidate | Total | Key differentiator |
|---|---|---|---|
| 1 | **Candidate2** | 73 | Only plan correct on both protocol traps: snapshot re-hydrate on unhide + explicit ack policy + per-window visibility; fromSeq/throughSeq coalescing; same-clock ackLatencyMs |
| 2 | Candidate3 | 70 | Advisory-correct coalescing; unique popout-processes-all-sessions catch; but listed delta resync as co-equal path (silent-loss trap) + no ack policy |
| 3 | Candidate1 | 66 | Correct gating; defective coalescing (single-seq merge → resync storm); best benchmark breadth |
| 4 | Candidate4 | 63 | Fatal: delta resync from advanced lastRenderedSeq = silent loss on every unhide; otherwise excellent contract integration |
| 5 | Candidate5 | 59 | Same data-loss trap, stated falsely; weakest evidence |

Kongming counsel applied as verifier weighting (9 risk axes: journal/ack protocol, persist atomicity, seq envelopes, paint-vs-receipt measurement, telemetry contamination, ConPTY profile shift, WebGL lever, backpressure, micro-opt ordering).
