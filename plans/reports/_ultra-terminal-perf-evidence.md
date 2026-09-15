# EVIDENCE PACKET — AntiFan Terminal Speed/Benchmark Optimization (immutable)

Context: Electron app. Main-process `TerminalManager` (node-pty 1.1.0, winpty default / ConPTY opt-in pending verification) owns Session records {pty, buffer≤4MB rope, lastSeq, deliveryJournal(2MiB/4096 entries), sessionGeneration}. Renderer `standalone.js` holds lazy xterm 6.0.0 pane pool (canvas renderer; WebGL addon loaded but deliberately disabled — "avoid WebGL context loss across tabs"), hydrates ≤1MB tails, applies seq/generation-journaled deltas via `TerminalWriteDispatcher` (RAF-batched, 64KB/frame, ≤256B fast-path). Persistence: debounced 2s atomic JSON `terminal-sessions.json` (1MB tail/session). Benchmark spine exists: `src/main/benchmark/telemetry.ts` (ANTIFAN_BENCHMARK=1, `[antifan-benchmark]` JSONL stdout, event-loop p50/p95/max monitor), harness `scripts/benchmark-electron-performance.mjs` (measures to bridge-WS boundary only). Already contracted (not this task's scope to redesign): vertical sidebar tabs, sleep/wake sessions, restoredTail/buffer split, ConPTY default flip gated on teardown-hang repro.

## Verified hot-path findings (4 scouts, all file:line-verified)

### Main process (terminal-manager.ts, native-tab-host.ts, bridge-server.ts)
- `appendData` (L950-962): per chunk → lastSeq++, journal.append (Buffer.byteLength scan + alloc + `entries.shift()` O(n) eviction, worst O(n²) at bounds), `s.buffer += data` (V8 rope, O(1) amortized; flatten deferred to persist/listSessions/getFullBuffer/waitTerminal), schedulePersist, emit('data').
- Fan-out per chunk, UNBATCHED: `wc.send('antifan:terminal:data')` to sidebarView + EVERY popout window (native-tab-host.ts:1434-1445) + bridge broadcastEvent (one JSON.stringify + per-client auth + ws.send; congestion coalescing only >8MB bufferedAmount, and its merge re-stringifies accumulated frame per merge — O(n²), bridge-server.ts:2813-2871).
- `persistAsync` (L467-530): every 2s while dirty → maps ALL sessions, safeSliceTail 1MB each, JSON.stringify up to S×1MB SYNCHRONOUSLY on main thread. Not dirty-scoped. 50 sessions ≈ 50MB stringify/2s.
- `waitTerminal` (L1757-1766): `regex.test(s.buffer)` scans up to 4MB per chunk for wait's lifetime; `accumulatedAfterSeq` grows unbounded.
- `listSessions` (L1278-1330): O(S²) splitOf lookup + `Buffer.byteLength(s.buffer)` flatten per session per emitSession.
- `resize()` (L1049-1063): O(S) native pty.resize per window-resize event.
- `findTabByWebContents` O(T) scan per keystroke (native-tab-host.ts:5775-5785).
- `isBenchmarkEnabled()` re-reads env+argv per chunk (telemetry.ts:26-29); ptyData does 2× Buffer.byteLength per chunk.
- Deferred PTY starts: 250ms stagger because Windows PTY spawn blocks main thread 150-800ms each (documented L713-718).

### Renderer (standalone.js, terminal-write-dispatcher, standalone.css/html)
- Per chunk per materialized pane: `notifySessionActivity` = ANSI-strip full-string copy + 7-8 regexes + timer churn (L2171-2224); `processIncomingChunk` journal/dedup; `queueWrite` O(n) charCodeAt UTF-8 scan (dispatcher L33-62,140); flush: `payload += head` concat + `writeQueue.shift()` O(n) memmove per item (L188-217); `term.write` → xterm parse → canvas repaint — for EVERY materialized pane INCLUDING hidden ones (`visibility:hidden` doesn't throttle RAF/paint; css L648-665).
- `terminalPool.get` auto-materializes lazy session on first data chunk (L441-448, L2507-2515) — "lazy" ends at first output.
- Hydration: pre-hydrate `sTerm.write(boundedTail)` at L1204-1208 is DISCARDED by `term.reset()` at L946 — up to ~1MB wasted parse per pane; data-first race path hydrates twice (L1328-1331); liveQueue replay = one awaited write per entry (L952-963).
- `updateAffinityBadges`: N+1 sequential `getTerminalAffinity` IPC awaits per renderTabs AND per onTabsUpdated (L1727-1741) — 51 round-trips/event at 50 tabs.
- `renderTabs`: unconditional insertBefore per session (L2435-2440), `updateTabActivityUi` re-queries tabsEl per session → O(N²) (L2227), scroll-into-view uses scrollLeft (wrong axis for vertical, dead under flex-wrap) L2444-2457.
- `fitCurrentTerminal`/`term.refresh(0,rows-1)` full repaint from ≥6 trigger sites with stacked RAF+setTimeout chains (L28-37, L1383-1390, L2568-2570, L2607-2615).
- Keystroke: `sendTerminalInputTo` = ipcRenderer.invoke round-trip per keystroke; echo returns ≤256B fast-path.
- No renderer-side performance.now/mark/measure anywhere (grep-verified). `window.__antifanTerminalHealth()` exposes lastRenderedSeq/ack/gap/resync per view — existing probe, no timing.
- Split scrollback 50000 vs main 10000 (L1633 vs L1178). Main-pane onScroll missing isProgrammaticScroll guard (flag written never read).

### Bench infra
- Existing: telemetry spine, event-loop monitor, ptyData per-chunk bytes, bridge.broadcast ms, tabs.* metrics, harness scenarios (cold-start/tabs/terminal/artifact/soak). `smoke:terminal` = 3 mock-backend e2e (no real PTY, no timing asserts). `terminal-transport-sync.cjs` = real TerminalManager + real standalone.html + real IPC; GATE-B measures chunk→lastRenderedSeq <1000ms.
- Gap: NO PTY→renderer→paint measurement. Cheapest e2e: clone transport-sync, feed chunks, poll lastRenderedSeq; true paint via dispatcher's injectable onPostWrite/requestFrame + rAF stamp exposed as `window.__antifanTerminalBench`.

## Scale extremes to reason about (Scale Game)
- 50 tabs (all materialized after first output each), 4MB buffers, 60s TUI stream (thousands of chunks), 3+ popout windows, Windows i5-9300H/UHD630 target machine.
- Sleep contract adds: sleeping tabs must have ~zero cost (pane disposed, buffer offloaded to disk, no PTY).

## Ranked candidate fixes already identified (verify, don't rubber-stamp)
Main: dirty-scoped/off-thread persist; per-tick IPC coalescing keyed by sessionId; waitTerminal bounded-window regex; bridge merge O(n²)→queue raw + stringify once; listSessions O(S²)→precomputed map + incremental bufferBytes; journal shift()→ring buffer; cache isBenchmarkEnabled; resize()→defer background PTYs; findTabByWebContents→WeakMap.
Renderer: gate writes/render for hidden panes (lastRenderedSeq already set pre-write — journal-safe); remove double hydration write; throttle notifySessionActivity (~100ms/session); dispatcher byte-tracking via chunk.length; coalesce fit/refresh triggers; flushWrite batch-dequeue+join; batch affinity IPC; liveQueue replay join; WebGL for active pane only (medium-high risk, deliberately disabled); onScroll guard; split scrollback align; gap-queue incremental byte tracking.
Infra: terminal-e2e paint benchmark script; renderer bench hook parity; ptyData double byteLength; ack-payload clock echo.

## Rubric (verifier scores each candidate 1-20 per axis)
- **Faithfulness**: addresses the actual ask — overall speed/benchmark research + concrete fix plan, integrated with the contracted sidebar/sleep/cls/ConPTY work.
- **Evidence grounding**: claims cite the packet's file:line findings; no invented bottlenecks; marks inference.
- **Actionability**: ordered fix plan with per-fix risk, expected win, verification method; benchmark-first methodology (measure → fix → re-measure).
- **Honesty**: names what can't be known without running benchmarks; doesn't overclaim wins.
