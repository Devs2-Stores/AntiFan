# Test Quality Review — phases 3–10

Scope: 11 named test files for `smooth-multi-project-terminal` P3–P10. Two listed
paths differed on disk (resolved, noted per file).

## Run result

```
node --test .compiled/test/main/terminal-broadcast-pruning.test.js \
            .compiled/test/main/terminal-output-router.test.js \
            .compiled/test/unit/browser/terminal-backpressure.test.js \
            .compiled/test/unit/terminal-daemon/output-batcher.test.js
```

22 tests / 3 suites — 22 pass, 0 fail, 0 skipped (~415 ms).

## Per-file verdicts

| File | Verdict | Notes |
|---|---|---|
| `test/main/terminal-broadcast-pruning.test.ts` | STRONG | Real wire-budget behavior: payload <20 KiB across 3 sessions; preview is a tail (marker head excluded, tail included); `snapshotThroughSeq`/`bufferLength` cursors preserved; RPC recovery paths (`getFullBuffer`, `getTerminalDelta`, `syncTerminalView`→DELTA, `listSessions(false)`) all exercised. |
| `test/main/terminal-output-router.test.ts` | STRONG | Consumer-visible routing: 7 hosts/1 session chunk isolation, zero admission calls per steady-state chunk, lazy one-time route compute on boot race, popout binding, unassigned→manager, agent-owned→manager only, owner transfer re-route on next push, signature gate skips no-op pushes, 20 register/unregister cycles leave seam listeners flat, late host sees pre-existing sessions. No tautologies. |
| `test/unit/browser/terminal-backpressure.test.ts` (listed as `test/main/terminal-backpressure.test.ts`) | STRONG | Real `TerminalManager` + stub PTY boundary: emits unthrottled without subscribers, pauses at high watermark, drains in seq order below low watermark (`frames.at(-1).seq === 300`), pruned subscriber un-pauses, 1 MiB pending-queue cap evicts oldest. Real node-pty stub guarded by explicit assertion. |
| `test/unit/terminal-daemon/output-batcher.test.ts` | GOOD (one hole) | Asserts immediate emit after quiet window, coalesced `fromSeq`/`throughSeq` contiguity, maxChars flush, generation boundary never merged, pre-coalesced range merge, per-session independence, `flushSession`/`forget` drain ordering. Hole below. |
| `test/unit/browser/tab-hibernation.test.ts` (listed as `test/main/browser/tab-hibernation.test.ts`) | STRONG | Full refusal-reason matrix (active, audible, loading, agent-plane offscreen/ephemeral, automation target, MCP-bound, CDP-bound, unload-veto, already-hibernated, not-idle), exact 15-min boundary, exclusion precedence, `Date.now()` fallback. Host round-trip exercises real `hibernateTab`/`runHibernationSweep`/`beginTabHibernation`/`ensureTabAwake`: destroy, scroll snapshot+restore (`scrollTo(0, 300)`), veto keeps renderer + marks set + sweep skips, URL reloaded on wake. |
| `test/renderer/terminal-lazy-pane.test.ts` | STRONG | 20 background sessions × 64-chunk bursts materialize zero xterms; acks still flow (subscriber rows not pruned); activity channel drives `is-streaming` without pane; activation hydrates `getFullBuffer` exactly (authoritative bytes, not stale slice), post-hydration delta appends; preview-only broadcast row fetches full buffer, no preview doubling. |
| `test/main/bridge-server.test.ts` (delta: health-ledger describe + transcript RPC) | STRONG | Live HTTP/WS traffic: derived listening/degraded/down incl. recency-boundary backdating, per-refusal ledger phrases (401/403/400/410/429/409 all distinct), pairing-queue depletion, attachment-verify 401 vs request-shape 400 non-recording, WS close codes, EADDRINUSE→port-0 recovery, frozen `startedAt`, holder mirror, health channel emissions. `terminalGetFullBuffer` tested over a real socket: master OK, `terminal.sync` grant OK, `tabs.view`-only grant → FORBIDDEN, agent-owned → TERMINAL_FORBIDDEN. |
| `test/main/mobile-remote.test.ts` (delta: 3 tests + surface fetch support) | STRONG | Preview broadcast never truncates streamed transcript; preview-only sleeping session fetches `terminalGetFullBuffer` and renders retained content + sleeping banner; `\x1b[3J` in a data frame resets the phone's transcript cache (asserts old bytes gone). Behavioral harness renders real client JS, not mocks. |
| `test/main/terminal-daemon-client.test.ts` | STRONG | Handshake invariants with real TCP/WS servers: immediate-end, upgrade-destroy→clean retry, close-before-handshake, in-flight `close()`, silent-peer timeout (150 ms bound asserted in message). Write settlement pinned per-RPC, never-throws→false contract. Owner handover: deferred until RPC settles, refusal≠rejection (incl. missing `transferred` field), transport failure keeps old owner. Pruned-row cache passthrough keeps `snapshotThroughSeq` verbatim across pushes. |
| `test/main/project-rename-remove.test.ts` | STRONG | Rename → registry + survives fresh `WorkspaceCapsuleManager` sync (real on-disk `workspace-capsules.json`). Remove: CONFIRM_REQUIRED quotes live count 1 (exited+foreign excluded), confirmed remove closes exactly project-owned sessions, record closed, files untouched, second remove → UNKNOWN_PROJECT. `clearAffiliation` severs claim, keeps capsule+files, next sync does not resurrect. |
| `test/renderer/project-open-picker.test.ts` | STRONG | One-click single answer, Escape→cancelled, filter+Enter picks highlighted, arrow navigation, folder answer, current-row marking, path painted as text. CRUD: inline rename commits + repaints, FAILED rename keeps input with reason, CONFIRM_REQUIRED quotes live count in confirm strip, only confirm sends `REMOVE_ANSWER`, mid-edit row never answers pick, Escape backs out of edit not modal. |

## Gaps that matter

1. **Router re-attach on seam swap (daemon reconnect) — UNTESTED.** `attach()`
   documents "re-attach replaces a previous binding rather than stacking" and the
   daemon proxy can rebind on reconnect. No test calls `attach(newEmitter)` while
   hosts are registered: cached routes and `sessionSignature` carry over, and the
   first `session` push on the new seam decides rebuild purely by signature.
   Worth a case: attach A → route → attach B → assert no double delivery, routes
   refresh on B's first push, old seam listeners released.
2. **Batcher adaptive window unobservable — the shipped bug class.** Harness
   `setTimer` drops the `ms` arg; nothing asserts the timer arms with `win`
   (adaptive gap×1.5 ≤48 ms) rather than fixed `flushMs` — precisely the
   `win`-vs-`flushMs` bug already fixed once. One-line fix: capture `ms` and
   assert a 16 ms-cadence producer arms ≥ flushMs. Related untested edge: with
   cadence ≥ flushMs the fast path emits each chunk immediately, so the adaptive
   window may be near-dead code — worth either a test proving reachability or a
   comment/assert pinning intended reachability.
3. **Backpressure through the daemon path — untested end-to-end.** P8 tests run
   the in-process `TerminalManager`. In daemon mode (the default), acks travel
   `DaemonTerminalProxy.recordSubscriberAck` → `terminalRecordSubscriberAck` RPC
   → daemon-side `tm.recordSubscriberAck`; no unit/e2e test asserts the proxy
   forwards the ack payload or that a daemon-mode session actually pauses. PTY
   throttling is certified by perf probe only. Suggested: proxy-level test that
   `recordSubscriberAck` issues `HOST_METHOD.recordSubscriberAck` verbatim
   (same deferred-call seam already used for writes).
4. **P3 zero-IO affiliation lives outside the audited set.** Coverage exists in
   `test/unit/native-tab-capsule-affiliation.test.ts` (setter verifies once,
   then answers without disk I/O — "survives the folder vanishing"). Not a gap
   in the suite, but absent from this plan's test inventory.
5. **Minor:** backpressure drain test relies on frames.length + last seq; a
   per-chunk monotonic-seq assert would catch middle-reordering, though
   `pendingEmitQueue` FIFO makes it unlikely. Pending-cap `1024*1024` literal
   instead of `BACKPRESSURE_MAX_PENDING_BYTES` — cosmetic.

## Overall verdict

**STRONG.** Tests assert consumer-visible behavior — routing isolation, seq
contiguity, watermark transitions, gating denial (FORBIDDEN/TERMINAL_FORBIDDEN/
CONFIRM_REQUIRED), hydration fidelity, refusal-not-rejection — against real
implementations with seams only at genuine boundaries (PTY, Electron view,
transport). No tautologies, no wiring-echo tests found. Gaps: router seam-swap
re-attach, batcher adaptive `win` observability (same bug class already shipped
once), daemon-path backpressure acks.

## Unresolved questions

- Is daemon-mode PTY backpressure intended to engage via the same watermark
  path (daemon-entry `recordSubscriberAck` → tm)? Perf probes show throughput
  but not pause/drain; if the daemon is meant to throttle, the missing test is
  a real defect risk, not just coverage debt.
